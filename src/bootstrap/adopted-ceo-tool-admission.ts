import type { ControlPlane } from "../app/control-plane.ts";
import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { Role, SessionLifecycle, roleKeyFor, type RoleBinding } from "../domain/types.ts";
import type { HermesProvenanceAnchor } from "../mcp/hermes-provenance.ts";
import type { AuthenticatedMcpPeer } from "../mcp/shared.ts";
import {
  admitRuntimeLineage,
  defaultProcessLineageReader,
  type AdmittedRuntime,
  type ProcessLineageReader,
} from "../session/runtime-lineage.ts";
import {
  headAdvanceTransaction,
  judgeLiveHead,
  readHermesTargetHead,
  recordHeadAdvance,
  type HermesTargetHead,
} from "../session/hermes-target-head.ts";
import type { SessionRecord } from "../session/session-registry.ts";
import type { GatewayIncumbentProof } from "./hermes-incumbent-adoption.ts";

/**
 * Who may use the Hermes MCP tools as the CEO the operator adopted (#1037), decided once per
 * connection, here, and consumed everywhere downstream.
 *
 * Incumbent adoption binds the live Gateway as the CEO and drops the session secret it used to
 * prove READY, so `hermes.mcp.sock` — which authenticates by that secret — has nothing to admit,
 * and no tool is reachable. This does not mint a replacement secret, a new session row, a new
 * generation or a new attestation: the connection itself is the proof. A peer is admitted when
 *
 *   - the kernel says it is a direct connection at this daemon's uid (the tool socket's listener,
 *     before this module sees the peer);
 *   - it descends from the process the active CEO binding's runtime row recorded, with that
 *     process's recorded start (`admitRuntimeLineage`) — an ancestor pid alone admits nothing;
 *   - the Gateway's own identity readback (`gatewayOrigin`, the one adoption already uses) names
 *     that same pid and native start token and the configured lineage digest, and the binding's
 *     target is that lineage.
 *
 * The head inside the lineage is the one the Gateway reports (`judgeLiveHead`, the rule adoption
 * and Gateway delivery share). When a compression has rotated it since the target last recorded
 * one, that move — and only it — is recorded, atomically, fenced on this binding; no generation,
 * session or secret is minted for it. The head becomes the provenance anchor, which still names
 * exactly one session: tracking the head never widens which turns may mutate.
 *
 * The binding and the recorded head are read before the Gateway is asked and compared again after
 * it answers, and a move is recorded only over the head that was read (compare-and-set): a readback
 * that was answered before another admission recorded a newer head is refused, so the head never
 * moves back (PR #1053 review, ACP1053-02). A connection that stays open while a later admission or
 * delivery records a move follows it on its next call: `authenticate` re-anchors the connection's
 * provenance to the recorded head when the anchor is a head the same binding has already left, so
 * the new head's turns are admitted and the old head's refused, without a reconnect.
 *
 * Otherwise nothing is written, so admitting the same Gateway's child twice gives the same answer
 * twice: a reconnect or a respawn is just another connection. A Gateway that is not running, a
 * different Gateway, or a binding that has not been (re-)adopted is refused.
 *
 * Rotating generation N to N+1 on every attach, with a fresh session and secret for the relay to
 * present, was built first and withdrawn rather than shipped, at the owner's direction: issuing a
 * generation per reconnect adds no security — the relay can only prove what this check already
 * proves — and it makes every respawn spend a generation the next respawn must name. Generations
 * stay what they fence: a real change of incarnation or authority.
 *
 * This admission binds no Buzz channel identity. The CEO runtime's `buzz_actor_id` stays as
 * adoption left it, so #1038's CEO peer ingress stays closed until the one writer of that column
 * can consume this admission in place of the session secret it asks for today.
 *
 * Every refusal is its own statement; no condition here is an operand of an `&&`/`||` chain.
 */

export interface AdoptedCeoToolAdmissionOptions {
  /** The daemon-wired, authenticated Gateway readback adoption already uses. */
  gatewayOrigin(): Promise<GatewayIncumbentProof | null>;
  /** The configured lineage digest; the readback and the binding must both carry it. */
  lineageRootDigest: string;
  processes?: ProcessLineageReader;
}

/** What one admitted connection holds. Downstream consumes this; nothing re-derives it. */
export interface AdoptedCeoAdmission {
  assignmentId: string;
  bindingGeneration: number;
  sessionId: string;
  sessionIncarnation: string;
  actorId: string;
  /**
   * The bound Hermes session and lineage a mutation's caller provenance must name. The connection's
   * server compares calls against this object itself, and `authenticate` moves it forward with the
   * recorded head, so it is passed by reference and never copied.
   */
  provenance: HermesProvenanceAnchor;
  /** The admitted runtime row, for a writer that takes the admission in place of a secret. */
  runtime: AdmittedRuntime;
}

/** The kernel-authenticated peer the listener hands over; never a caller's word. */
export interface AdoptedCeoPeer {
  peerPid: number;
  uid: number;
}

const refuse = <T = AdoptedCeoAdmission>(message: string): Decision<T> => deny(ReasonCode.CONFLICT, message, {});

/** The CEO's authority as admission reads it: the binding, its actor, runtime and target head. */
interface CeoAuthority {
  binding: RoleBinding;
  actorId: string;
  session: SessionRecord;
  target: HermesTargetHead;
}

export const createAdoptedCeoToolAdmission = (cp: ControlPlane, options: AdoptedCeoToolAdmissionOptions) => {
  const processes = options.processes ?? defaultProcessLineageReader;
  const roleKey = roleKeyFor(Role.CEO);

  const readProof = async (): Promise<GatewayIncumbentProof | null> => {
    try {
      return await options.gatewayOrigin();
    } catch {
      return null;
    }
  };

  /** Read synchronously, before the Gateway is asked and again after it answers. */
  const readAuthority = (): Decision<CeoAuthority> => {
    const binding = cp.bindings.active(roleKey);
    if (binding === null) return refuse("no CEO binding is active; a restarted Gateway is adopted first");
    const owner = cp.db.get<{ actor_id: string; kind: string; retired_at: string | null }>(
      `SELECT c.actor_id, c.kind, c.retired_at
         FROM assignments a JOIN conversational_actors c ON c.actor_id = a.actor_id
        WHERE a.assignment_id = ?`,
      [binding.assignmentId],
    );
    if (!owner) return refuse("the active CEO binding has no actor");
    if (owner.kind !== Role.CEO) return refuse("the active CEO actor is not a CEO");
    if (owner.retired_at !== null) return refuse("the active CEO actor is retired");
    const session = cp.sessions.get(binding.sessionId);
    if (session === null) return refuse("the active CEO runtime is unknown");
    if (session.lifecycle !== SessionLifecycle.READY) return refuse("the active CEO runtime is not READY");
    if (session.incarnation !== binding.sessionIncarnation) return refuse("the active CEO runtime was respawned");
    if (session.provider !== "hermes") return refuse("the active CEO runtime is not a Hermes runtime");
    const target = readHermesTargetHead(cp.db, owner.actor_id);
    if (target === null) return refuse("the CEO actor does not name exactly one target");
    return allow(ReasonCode.OK, { binding, actorId: owner.actor_id, session, target });
  };

  /** The authority read now, if it is still the one captured before the Gateway was asked. */
  const unchanged = (captured: CeoAuthority): Decision<CeoAuthority> => {
    const moved = (): Decision<CeoAuthority> => refuse("the CEO binding or its head moved during admission");
    const now = readAuthority();
    if (!now.allowed) return now;
    if (now.value.binding.assignmentId !== captured.binding.assignmentId) return moved();
    if (now.value.binding.bindingGeneration !== captured.binding.bindingGeneration) return moved();
    if (now.value.binding.sessionId !== captured.binding.sessionId) return moved();
    if (now.value.binding.sessionIncarnation !== captured.binding.sessionIncarnation) return moved();
    if (now.value.target.targetBindingId !== captured.target.targetBindingId) return moved();
    if (now.value.target.headDigest !== captured.target.headDigest) return moved();
    return now;
  };

  const admit = async (peer: AdoptedCeoPeer): Promise<Decision<AdoptedCeoAdmission>> => {
    // The binding and the recorded head are captured before the one await, so an answer that was
    // given before another admission recorded a newer head is judged against the head it saw.
    const captured = readAuthority();
    if (!captured.allowed) return captured as Decision<AdoptedCeoAdmission>;
    const proof = await readProof();
    if (proof === null) return refuse("the Gateway's identity cannot be read");
    if (proof.lineage_root_digest !== options.lineageRootDigest) return refuse("the Gateway's lineage is not the configured one");
    const authority = unchanged(captured.value);
    if (!authority.allowed) return authority as Decision<AdoptedCeoAdmission>;
    const { binding, actorId, session, target } = authority.value;
    if (session.osPid !== proof.process_pid) return refuse("the reporting Gateway is not the bound CEO runtime");

    const head = judgeLiveHead(target, proof);
    if (head.verdict === "REFUSE") return refuse(head.message);

    const lineage = admitRuntimeLineage(peer.peerPid, session, processes, cp.sessions);
    if (!lineage.allowed) return lineage as Decision<AdoptedCeoAdmission>;
    if (lineage.value.startToken !== proof.process_started_at) {
      return refuse("the Gateway reported a process other than the one running at its pid");
    }
    if (head.verdict === "ADVANCE") {
      // Recorded against exactly the binding and head captured before the await; the writer
      // compares the stored head again (compare-and-set) and reads its row back.
      const advanced = headAdvanceTransaction(cp.db, (): Decision<void> => {
        const still = unchanged(captured.value);
        if (!still.allowed) return still as Decision<void>;
        return recordHeadAdvance(cp.db, cp.audit, target, head, { path: "tool_admission", sessionId: binding.sessionId,
          roleKey, bindingGeneration: binding.bindingGeneration, gatewayPid: proof.process_pid });
      });
      if (!advanced.allowed) return refuse(advanced.message);
    }

    return allow(ReasonCode.OK, {
      assignmentId: binding.assignmentId,
      bindingGeneration: binding.bindingGeneration,
      sessionId: binding.sessionId,
      sessionIncarnation: binding.sessionIncarnation,
      actorId,
      provenance: {
        liveHermesSessionId: head.head,
        lineageRootDigest: target.lineageRootDigest,
      },
      runtime: lineage.value.runtime,
    });
  };

  /**
   * The per-call half: is the admission still the CEO's authority? Not a second identity proof —
   * the peer's identity was settled at admission — but the binding fence, because the connection
   * outlives the moment it was admitted and the binding can move under it (the operator adopts a
   * restarted Gateway, or revokes). Process death needs no per-call check: the relay's stdio is the
   * Gateway's, so when the Gateway goes the relay's stdin ends and the connection closes with it.
   *
   * And the head fence: the anchor must be the head recorded now. When the binding has recorded a
   * move past it — only the authenticated paths write one, forward only, in this lineage — the
   * anchor follows it here, before the server compares the call with it; anything else is refused
   * as a moved head and the stale anchor is never used.
   */
  const authenticate = (admission: AdoptedCeoAdmission): Decision<AuthenticatedMcpPeer> => {
    const stale = (): Decision<AuthenticatedMcpPeer> =>
      deny(ReasonCode.BINDING_GENERATION_STALE, "the adopted CEO binding changed since this connection was admitted", {});
    const binding = cp.bindings.active(roleKey);
    if (binding === null) return stale();
    if (binding.assignmentId !== admission.assignmentId) return stale();
    if (binding.sessionId !== admission.sessionId) return stale();
    if (binding.sessionIncarnation !== admission.sessionIncarnation) return stale();
    if (cp.sessions.get(admission.sessionId)?.lifecycle !== SessionLifecycle.READY) return stale();
    const headMoved = (): Decision<AuthenticatedMcpPeer> => deny(ReasonCode.MCP_TOOL_PROVENANCE_REFUSED,
      "the bound Hermes head moved since this connection was admitted and cannot be followed", {});
    const target = readHermesTargetHead(cp.db, admission.actorId);
    if (target === null) return headMoved();
    if (target.lineageRootDigest !== admission.provenance.lineageRootDigest) return headMoved();
    if (target.head !== admission.provenance.liveHermesSessionId) {
      if (!target.history.includes(admission.provenance.liveHermesSessionId)) return headMoved();
      admission.provenance.liveHermesSessionId = target.head;
    }
    return allow(ReasonCode.OK, {
      actor: admission.sessionId,
      sessionId: admission.sessionId,
      sessionIncarnation: admission.sessionIncarnation,
    });
  };

  return { admit, authenticate };
};

export type AdoptedCeoToolAdmission = ReturnType<typeof createAdoptedCeoToolAdmission>;
