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
  assertCanonicalSessionsValid,
  defaultProcessAncestryInspector,
  deriveClaimantIdentity,
  makeDefaultHostSessionRegistryReader,
  SELF_CLAIM_EXECUTOR_KIND,
  type CanonicalAdoptableSession,
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
 * and the generation is what fences it. Admission writes nothing on any path.
 *
 * The one write in this module is `correctBuzzAddress`, and it is not part of admission. A live
 * holder bound before its entry named its own Buzz room keeps the room the claim wrote then, and the
 * peer rule reads that column (`src/ingress/buzz-message.ts`, rule 4). Replacing the row would mean
 * revoking a live binding and re-claiming, which the claim refuses for a live process whose recorded
 * address differs from the configured one — the same-live recovery requires the exact runtime — so
 * the holder would have to restart. Instead the holder this door admits, and only that holder, has
 * its own row's `buzz_address` set to the room its entry names, once, in one transaction with one
 * audit row. Nothing else about the session, the binding or the generation moves.
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
  /** The claude conversation the admission derived from the process tree, never from the peer. */
  conversation: string;
}

/**
 * What `correctBuzzAddress` needs that admission does not: which room each adoptable session
 * belongs in, and the claim's own way of opening one, so a corrected room is proven to exist
 * exactly the way a claimed one is.
 */
export interface CanonicalCtoBuzzAddressOptions {
  canonicalSessions: readonly CanonicalAdoptableSession[];
  resolveBuzzAddress: (purpose: string, channelId: string) => Promise<Decision<string>>;
  buzzPurpose: string;
}

export interface CanonicalCtoReattachOptions {
  processes?: ProcessLineageReader;
  inspector?: ProcessAncestryInspector;
  registryReader?: HostSessionRegistryReader;
  maxAncestryHops?: number;
  /** Absent, `correctBuzzAddress` corrects nothing and reads nothing. */
  buzzAddress?: CanonicalCtoBuzzAddressOptions;
}

/**
 * `NOT_CONFIGURED`: the admitted holder's entry names no room of its own, so there is nothing to
 * correct to. `ALREADY_CORRECT`: its row already routes to that room. `CORRECTED`: this call moved
 * it there and wrote the one audit row.
 */
export interface CanonicalCtoBuzzAddressCorrection {
  outcome: "CORRECTED" | "ALREADY_CORRECT" | "NOT_CONFIGURED";
  sessionId: string | null;
}

/** The audit kind of the one row a correction writes. */
export const CANONICAL_CTO_BUZZ_ADDRESS_CORRECTED = "CANONICAL_CTO_BUZZ_ADDRESS_CORRECTED";

const MAX_ANCESTRY_HOPS = 64;

const unbound = (message: string): Decision<CanonicalCtoAdmission> =>
  deny(ReasonCode.CTO_REATTACH_UNBOUND, message, {});

/** A draining primary keeps its already-fenced authority, as on `cto.mcp.sock`. */
const lifecycleHoldsSocket = (lifecycle: SessionLifecycle): boolean => {
  if (lifecycle === SessionLifecycle.READY) return true;
  return lifecycle === SessionLifecycle.DRAINING;
};

export const createCanonicalCtoReattach = (
  cp: Pick<ControlPlane, "db" | "bindings" | "sessions" | "audit">,
  options: CanonicalCtoReattachOptions = {},
) => {
  const processes = options.processes ?? defaultProcessLineageReader;
  const inspector = options.inspector ?? defaultProcessAncestryInspector;
  const registryReader = options.registryReader ?? makeDefaultHostSessionRegistryReader();
  const maxAncestryHops = options.maxAncestryHops ?? MAX_ANCESTRY_HOPS;
  const correction = options.buzzAddress;
  // Through the one authority over what an adoptable set may be, at construction, so a malformed
  // room refuses here rather than being written. Copied and frozen like the claim's own set.
  const correctable = correction === undefined
    ? []
    : assertCanonicalSessionsValid(correction.canonicalSessions).map((entry) => Object.freeze({ ...entry }));
  // A set in which no entry names a room has nothing a correction could move a row to, so it does
  // not walk the process tree a second time on every reattach just to find that out.
  const namesARoom = correctable.some((entry) => entry.buzzAddress !== undefined);

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
    const lineage = admitRuntimeLineage(peer.peerPid, session, processes, cp.sessions);
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
      conversation,
    });
  };

  /**
   * Moves the admitted holder's own `buzz_address` to the room its entry names, or does nothing.
   *
   * It takes the peer, never an admission, and admits it itself: what may be corrected is decided
   * by the same process-tree proof that admits a reattach, so a caller cannot hand it a holder it
   * did not prove. Only the admitted session's row is touched, and only when that holder's entry —
   * found by the conversation admission derived — names a room and the same project the binding
   * holds. An entry that names no room is left alone: it asked for the deployment channel, and
   * nothing rewrites a live row for an entry that did not ask for a room.
   *
   * The room is opened through the claim's resolver before the transaction, because opening it
   * shells the Buzz CLI and a transaction body cannot await. That await hands control away, so the
   * holder is admitted again inside the transaction, at the write, and must be the very same
   * holder — conversation, assignment, generation, session and incarnation — or nothing is written.
   * The row is read again there too: a concurrent correction that got there first leaves this one
   * `ALREADY_CORRECT`, so the row moves and its audit row is written exactly once.
   */
  const correctBuzzAddress = async (
    peer: { peerPid: number; uid: number },
  ): Promise<Decision<CanonicalCtoBuzzAddressCorrection>> => {
    if (correction === undefined) return allow(ReasonCode.OK, { outcome: "NOT_CONFIGURED", sessionId: null });
    if (!namesARoom) return allow(ReasonCode.OK, { outcome: "NOT_CONFIGURED", sessionId: null });
    const first = admit(peer);
    if (!first.allowed) return first as Decision<CanonicalCtoBuzzAddressCorrection>;
    const held = first.value;
    const entry = correctable.find((candidate) => candidate.sessionUuid === held.conversation);
    if (entry === undefined) return allow(ReasonCode.OK, { outcome: "NOT_CONFIGURED", sessionId: held.sessionId });
    const room = entry.buzzAddress;
    if (room === undefined) return allow(ReasonCode.OK, { outcome: "NOT_CONFIGURED", sessionId: held.sessionId });
    if (entry.projectId !== held.projectId) {
      return deny(ReasonCode.CONFLICT, "this conversation's configured entry names another project than its binding", {});
    }
    if (cp.sessions.get(held.sessionId)?.buzzAddress === room) {
      return allow(ReasonCode.OK, { outcome: "ALREADY_CORRECT", sessionId: held.sessionId });
    }
    const opened = await correction.resolveBuzzAddress(correction.buzzPurpose, room);
    if (!opened.allowed) return opened as Decision<CanonicalCtoBuzzAddressCorrection>;
    if (opened.value !== room) {
      return deny(ReasonCode.CONFLICT, "the Buzz transport opened another room than the configured one", {});
    }
    return cp.db.txDecision((): Decision<CanonicalCtoBuzzAddressCorrection> => {
      const again = admit(peer);
      if (!again.allowed) return again as Decision<CanonicalCtoBuzzAddressCorrection>;
      const changed = (): Decision<CanonicalCtoBuzzAddressCorrection> =>
        deny(ReasonCode.CONFLICT, "the admitted holder changed while its room was opened", {});
      if (again.value.conversation !== held.conversation) return changed();
      if (again.value.assignmentId !== held.assignmentId) return changed();
      if (again.value.bindingGeneration !== held.bindingGeneration) return changed();
      if (again.value.sessionId !== held.sessionId) return changed();
      if (again.value.sessionIncarnation !== held.sessionIncarnation) return changed();
      const row = cp.sessions.get(held.sessionId);
      if (row === null) return changed();
      if (row.buzzAddress === room) return allow(ReasonCode.OK, { outcome: "ALREADY_CORRECT", sessionId: held.sessionId });
      cp.sessions.setBuzzAddress(held.sessionId, room);
      const recorded = cp.audit.record({
        kind: CANONICAL_CTO_BUZZ_ADDRESS_CORRECTED,
        reasonCode: ReasonCode.OK,
        projectId: held.projectId,
        sessionId: held.sessionId,
        roleKey: held.roleKey,
        actor: held.actorId,
        evidence: {
          identity: held.conversation,
          generation: held.bindingGeneration,
          previousBuzzAddress: row.buzzAddress,
          buzzAddress: room,
        },
      });
      if (!recorded.allowed) return recorded as Decision<CanonicalCtoBuzzAddressCorrection>;
      return allow(ReasonCode.OK, { outcome: "CORRECTED", sessionId: held.sessionId });
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

  return { admit, connection, authenticate, correctBuzzAddress };
};

export type CanonicalCtoReattach = ReturnType<typeof createCanonicalCtoReattach>;
