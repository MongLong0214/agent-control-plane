import type { ControlPlane } from "../app/control-plane.ts";
import { sha256 } from "../core/digest.ts";
import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { Role, SessionLifecycle } from "../domain/types.ts";
import type { AuthenticatedMcpPeer } from "../mcp/shared.ts";
import {
  admitRuntimeLineage,
  defaultProcessLineageReader,
  type ProcessLineageReader,
} from "../session/runtime-lineage.ts";
import {
  defaultProcessAncestryInspector,
  deriveClaimantIdentity,
  makeDefaultHostSessionRegistryReader,
  SELF_CLAIM_EXECUTOR_KIND,
  type HostSessionRegistryReader,
  type ProcessAncestryInspector,
} from "./canonical-self-claim.ts";

/**
 * The canonical CTO's reattach (#1037): a live claimant whose binding is still ACTIVE connects
 * again without a claim, a new generation, a new session row or a new secret.
 *
 * Until this, every relay spawn performed `actor.claimCanonicalCto`, and the claim answers an
 * ACTIVE binding with BINDING_ALREADY_ACTIVE — it mints only after a revocation — so a restarted
 * MCP child of a still-running `claude` had no way back to the tools its own conversation holds.
 * The relay's "no reconnect" rule existed because its only credential was a plaintext secret the
 * daemon cannot tell apart before and after a restart. This door holds no credential: the
 * connection is admitted on what the kernel and the process tree say now, so reconnecting proves
 * the same thing a first connection does, and the rule's reason no longer applies to it. Claiming
 * on every spawn of a live claimant was dropped rather than kept for this case: the claim refuses
 * an ACTIVE binding, and the secret it would mint proves nothing the process tree does not.
 *
 * Admitted, all of:
 *
 *   - the kernel peer is direct and same-uid (the listener, before this module sees the peer);
 *   - the claude ancestor the canonical claim itself derives (`deriveClaimantIdentity`: argv and
 *     the host session registry, the same derivation, not a second one) names a conversation
 *     exactly one ACTIVE PRIMARY_CTO is bound to;
 *   - the peer descends from the process that binding's runtime row recorded, with that row's
 *     recorded native start (`admitRuntimeLineage`, the predicate the adopted CEO's tool socket
 *     uses), and that process is the derived claude ancestor.
 *
 * Anything else — another process, a pid reused by a later start, a binding whose runtime is
 * another session, a REVOKED binding, another conversation — is `CTO_REATTACH_UNBOUND`, and the
 * relay then claims exactly as it always has: a restarted process is a real change of incarnation,
 * and the generation is what fences it. Nothing is written on any path through this module.
 *
 * Every refusal is its own statement; no condition here is an operand of an `&&`/`||` chain.
 */

/** What one admitted connection holds; the authenticators below consume it and derive nothing. */
export interface CanonicalCtoAdmission {
  roleKey: string;
  projectId: string | null;
  assignmentId: string;
  bindingGeneration: number;
  sessionId: string;
  sessionIncarnation: string;
  actorId: string;
}

export interface CanonicalCtoReattachOptions {
  processes?: ProcessLineageReader;
  inspector?: ProcessAncestryInspector;
  registryReader?: HostSessionRegistryReader;
  maxAncestryHops?: number;
}

const MAX_ANCESTRY_HOPS = 64;

const unbound = (message: string): Decision<CanonicalCtoAdmission> =>
  deny(ReasonCode.CTO_REATTACH_UNBOUND, message, {});

/** A draining primary keeps its already-fenced authority, as on `cto.mcp.sock`. */
const lifecycleHoldsSocket = (lifecycle: SessionLifecycle): boolean => {
  if (lifecycle === SessionLifecycle.READY) return true;
  return lifecycle === SessionLifecycle.DRAINING;
};

export const createCanonicalCtoReattach = (
  cp: Pick<ControlPlane, "db" | "bindings" | "sessions">,
  options: CanonicalCtoReattachOptions = {},
) => {
  const processes = options.processes ?? defaultProcessLineageReader;
  const inspector = options.inspector ?? defaultProcessAncestryInspector;
  const registryReader = options.registryReader ?? makeDefaultHostSessionRegistryReader();
  const maxAncestryHops = options.maxAncestryHops ?? MAX_ANCESTRY_HOPS;

  const admit = (peer: { peerPid: number; uid: number }): Decision<CanonicalCtoAdmission> => {
    const identity = deriveClaimantIdentity(peer.peerPid, inspector, maxAncestryHops, registryReader);
    if (!identity.allowed) return identity as Decision<CanonicalCtoAdmission>;
    const conversation = identity.value.sessionUuid;
    const rows = cp.db.all<{
      assignment_id: string;
      role_key: string;
      project_id: string | null;
      binding_generation: number;
      actor_id: string;
      current_session_id: string;
      current_session_incarnation: string;
    }>(
      `SELECT a.assignment_id, a.role_key, a.project_id, a.binding_generation, c.actor_id,
              c.current_session_id, c.current_session_incarnation
         FROM assignments a
         JOIN conversational_actors c ON c.actor_id = a.actor_id AND c.retired_at IS NULL
         JOIN actor_target_bindings tb ON tb.target_actor_id = a.actor_id
        WHERE a.role = ? AND a.status = 'ACTIVE'
          AND tb.executor_kind = ? AND tb.target_locator = ? AND tb.target_locator_digest = ?`,
      [Role.PRIMARY_CTO, SELF_CLAIM_EXECUTOR_KIND, conversation, sha256(conversation)],
    );
    if (rows.length === 0) return unbound("no active canonical CTO binding names this conversation");
    if (rows.length !== 1) {
      return deny(ReasonCode.CONFLICT, "more than one active canonical CTO binding names this conversation", {});
    }
    const row = rows[0]!;
    const session = cp.sessions.get(row.current_session_id);
    if (session === null) return unbound("the binding's runtime row is gone");
    if (session.incarnation !== row.current_session_incarnation) return unbound("the binding's runtime was respawned");
    if (!lifecycleHoldsSocket(session.lifecycle)) return unbound("the binding's runtime no longer holds a socket");
    // The lineage check decides the recorded start. Its ancestry walk repeats what the derivation
    // above already walked, and is kept so the CTO and the adopted CEO are admitted by one
    // predicate. The token comparison ties the process it found to the claude ancestor the
    // conversation was derived from, not another one above or below it.
    const lineage = admitRuntimeLineage(peer.peerPid, session, processes);
    if (!lineage.allowed) return unbound(lineage.message);
    if (lineage.value.startToken !== identity.value.startedAt) {
      return unbound("the binding's runtime is not the claude process this conversation was derived from");
    }
    return allow(ReasonCode.OK, {
      roleKey: row.role_key,
      projectId: row.project_id,
      assignmentId: row.assignment_id,
      bindingGeneration: row.binding_generation,
      sessionId: session.sessionId,
      sessionIncarnation: session.incarnation,
      actorId: row.actor_id,
    });
  };

  const peerOf = (admission: CanonicalCtoAdmission): AuthenticatedMcpPeer => ({
    actor: admission.sessionId,
    sessionId: admission.sessionId,
    sessionIncarnation: admission.sessionIncarnation,
  });

  /**
   * The connection's own standing, with no binding in it — what `RoleConversationPort` re-asks on
   * delivery, the same three facts `conversationPeerAuthenticator` checks on `cto.mcp.sock` minus
   * the secret: the row still exists, has not been respawned, and its lifecycle still holds a
   * socket.
   */
  const connection = (admission: CanonicalCtoAdmission): Decision<AuthenticatedMcpPeer> => {
    const session = cp.sessions.get(admission.sessionId);
    if (session === null) {
      return deny(ReasonCode.MCP_PEER_UNAUTHENTICATED, "the admitted runtime row is gone", {});
    }
    if (session.incarnation !== admission.sessionIncarnation) {
      return deny(ReasonCode.MCP_PEER_UNAUTHENTICATED, "the admitted runtime was respawned", {});
    }
    if (!lifecycleHoldsSocket(session.lifecycle)) {
      return deny(ReasonCode.MCP_PEER_UNAUTHENTICATED, "the admitted runtime no longer holds a socket", {});
    }
    return allow(ReasonCode.OK, peerOf(admission));
  };

  /**
   * The per-call fence for tool authority: the connection's standing, then the binding it was
   * admitted under, still ACTIVE on this runtime. Not a second identity proof. Identity was settled
   * at admission, and the connection does not outlive it: the relay's stdio is claude's, so when
   * claude exits the relay's stdin ends and the connection closes with it. Nothing on a call is
   * looked up by pid, so a pid reused in that closing moment reaches nothing. The binding can move
   * while the connection stays open, which is why only it is re-read.
   */
  const authenticate = (admission: CanonicalCtoAdmission): Decision<AuthenticatedMcpPeer> => {
    const standing = connection(admission);
    if (!standing.allowed) return standing;
    const stale = (): Decision<AuthenticatedMcpPeer> =>
      deny(ReasonCode.BINDING_GENERATION_STALE, "the canonical CTO binding changed since this connection was admitted", {});
    const binding = cp.bindings.active(admission.roleKey);
    if (binding === null) return stale();
    if (binding.assignmentId !== admission.assignmentId) return stale();
    if (binding.sessionId !== admission.sessionId) return stale();
    if (binding.sessionIncarnation !== admission.sessionIncarnation) return stale();
    return standing;
  };

  return { admit, connection, authenticate };
};

export type CanonicalCtoReattach = ReturnType<typeof createCanonicalCtoReattach>;
