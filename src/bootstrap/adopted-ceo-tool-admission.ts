import type { ControlPlane } from "../app/control-plane.ts";
import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { Role, SessionLifecycle, roleKeyFor } from "../domain/types.ts";
import type { HermesProvenanceAnchor } from "../mcp/hermes-provenance.ts";
import type { AuthenticatedMcpPeer } from "../mcp/shared.ts";
import {
  admitRuntimeLineage,
  defaultProcessLineageReader,
  type AdmittedRuntime,
  type ProcessLineageReader,
} from "../session/runtime-lineage.ts";
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
 *     that same pid and native start token, the configured live Hermes session and the configured
 *     lineage digest, and the binding's target is that session and lineage.
 *
 * Nothing is written, so admitting the same Gateway's child twice gives the same answer twice: a
 * reconnect or a respawn is just another connection. A Gateway that is not running, a different
 * Gateway, or a binding the operator has not (re-)adopted is refused.
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
  /** The configured live Hermes session; the readback must name exactly this one. */
  expectedLiveSessionId: string;
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
  /** The bound Hermes session and lineage a mutation's caller provenance must name. */
  provenance: HermesProvenanceAnchor;
  /** The admitted runtime row, for a writer that takes the admission in place of a secret. */
  runtime: AdmittedRuntime;
}

/** The kernel-authenticated peer the listener hands over; never a caller's word. */
export interface AdoptedCeoPeer {
  peerPid: number;
  uid: number;
}

const refuse = (message: string): Decision<AdoptedCeoAdmission> => deny(ReasonCode.CONFLICT, message, {});

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

  const admit = async (peer: AdoptedCeoPeer): Promise<Decision<AdoptedCeoAdmission>> => {
    const proof = await readProof();
    if (proof === null) return refuse("the Gateway's identity cannot be read");
    if (proof.session_id !== options.expectedLiveSessionId) return refuse("the Gateway's live session is not the configured one");
    if (proof.lineage_root_digest !== options.lineageRootDigest) return refuse("the Gateway's lineage is not the configured one");

    const binding = cp.bindings.active(roleKey);
    if (binding === null) return refuse("no CEO binding is active; a restarted Gateway is adopted by the operator");
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
    if (session.osPid !== proof.process_pid) return refuse("the reporting Gateway is not the bound CEO runtime");

    const targets = cp.db.all<{ executor_kind: string; target_locator: string; target_locator_digest: string }>(
      "SELECT executor_kind, target_locator, target_locator_digest FROM actor_target_bindings WHERE target_actor_id = ?",
      [owner.actor_id],
    );
    if (targets.length !== 1) return refuse("the CEO actor does not name exactly one target");
    const target = targets[0]!;
    if (target.executor_kind !== "hermes") return refuse("the CEO actor's target is not a Hermes conversation");
    if (target.target_locator !== proof.session_id) return refuse("the CEO is bound to another Hermes session");
    if (target.target_locator_digest !== proof.lineage_root_digest) return refuse("the CEO is bound to another lineage");

    const lineage = admitRuntimeLineage(peer.peerPid, session, processes, cp.sessions);
    if (!lineage.allowed) return lineage as Decision<AdoptedCeoAdmission>;
    if (lineage.value.startToken !== proof.process_started_at) {
      return refuse("the Gateway reported a process other than the one running at its pid");
    }

    return allow(ReasonCode.OK, {
      assignmentId: binding.assignmentId,
      bindingGeneration: binding.bindingGeneration,
      sessionId: binding.sessionId,
      sessionIncarnation: binding.sessionIncarnation,
      actorId: owner.actor_id,
      provenance: {
        liveHermesSessionId: target.target_locator,
        lineageRootDigest: target.target_locator_digest,
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
    return allow(ReasonCode.OK, {
      actor: admission.sessionId,
      sessionId: admission.sessionId,
      sessionIncarnation: admission.sessionIncarnation,
    });
  };

  return { admit, authenticate };
};

export type AdoptedCeoToolAdmission = ReturnType<typeof createAdoptedCeoToolAdmission>;
