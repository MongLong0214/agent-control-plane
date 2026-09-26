import type { ControlPlane } from "../app/control-plane.ts";
import { readProcessStartToken } from "../core/process-argv.ts";
import { processStartedAt } from "../core/process-identity.ts";
import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { Role, SessionLifecycle, type RoleBinding } from "../domain/types.ts";
import { probeSessionLiveness } from "../daemon/dead-binding-recovery.ts";
import { runHermesTargetBind, type HermesTargetBindResponse } from "../runtime/hermes-target-bind.ts";

/** Supplied only by the daemon's authenticated, read-only canonical Gateway endpoint adapter. */
export interface GatewayIncumbentProof {
  /** The live head; it may differ from the pinned session that originally established the actor. */
  session_id: string;
  lineage_root_digest: string;
  process_pid: number;
  /** Native process start token (darwin-tv:sec.microsec), NOT ps lstart. */
  process_started_at: string;
}

export const createHermesIncumbentAdoption = (cp: ControlPlane, options: {
  /** This port must be wired by the daemon, not from an operator-supplied request. */
  gatewayOrigin(): Promise<GatewayIncumbentProof | null>;
  /** Existing configured binding: pins the actor's lineage, not the current head. */
  target: { sessionId: string; lineageRootDigest: string };
  /** Daemon-owned exact live head, frozen when this adoption port is constructed. */
  expectedLiveSessionId: string;
  hermesExecutable: string;
  hermesProfile: string;
  hermesHome: string;
  executorRuntimeIdentity: string;
}) => {
  const expectedLiveSessionId = options.expectedLiveSessionId;
  return {
  async adopt(request: { gatewayPid: number; gatewayStartToken: string }): Promise<Decision<{
    sessionId: string; actorId: string; bindingGeneration: number; sessionIncarnation: string;
  }>> {
    const refuse = (): Decision<{ sessionId: string; actorId: string; bindingGeneration: number;
      sessionIncarnation: string }> =>
      deny(ReasonCode.CONFLICT, "authenticated live Gateway incumbent cannot be established", {});
    let proof: GatewayIncumbentProof | null;
    try { proof = await options.gatewayOrigin(); } catch { return refuse(); }
    // Neither caller-supplied PID nor configured route proves the current process or head.
    if (!proof || !Number.isSafeInteger(proof.process_pid) || proof.process_pid <= 0 ||
        !expectedLiveSessionId || proof.session_id !== expectedLiveSessionId ||
        proof.lineage_root_digest !== options.target.lineageRootDigest ||
        proof.process_pid !== request.gatewayPid || proof.process_started_at !== request.gatewayStartToken ||
        !proof.process_started_at || readProcessStartToken(proof.process_pid) !== proof.process_started_at) return refuse();
    const startedAt = processStartedAt(proof.process_pid);
    if (!startedAt || readProcessStartToken(proof.process_pid) !== proof.process_started_at) return refuse();
    if (cp.bindings.active("CEO")) return refuse();
    const previous = cp.db.get<{ actor_id: string; binding_generation: number; session_id: string;
      session_incarnation: string; status: string }>(
      "SELECT actor_id, binding_generation, session_id, session_incarnation, status FROM assignments WHERE role_key = 'CEO' ORDER BY binding_generation DESC LIMIT 1",
    );
    if (!previous || previous.status !== "REVOKED") return refuse();
    const actor = cp.db.get<{ kind: string; current_session_id: string; current_session_incarnation: string; retired_at: string | null }>(
      "SELECT kind, current_session_id, current_session_incarnation, retired_at FROM conversational_actors WHERE actor_id = ?",
      [previous.actor_id],
    );
    const lineage = cp.db.get<{ target_locator: string; target_locator_digest: string; executor_kind: string }>(
      "SELECT target_locator, target_locator_digest, executor_kind FROM actor_target_bindings WHERE target_actor_id = ?",
      [previous.actor_id],
    );
    const incumbent = cp.sessions.get(previous.session_id);
    if (!actor || actor.kind !== Role.CEO || actor.retired_at !== null || actor.current_session_id !== previous.session_id ||
        actor.current_session_incarnation !== previous.session_incarnation ||
        (lineage && (lineage.executor_kind !== "hermes" ||
          lineage.target_locator_digest !== proof.lineage_root_digest ||
          lineage.target_locator !== options.target.sessionId)) ||
        !incumbent || incumbent.incarnation !== previous.session_incarnation ||
        probeSessionLiveness(incumbent.osPid, incumbent.osProcessStartedAt) !== "DEAD") return refuse();

    // Finish the awaited Gateway readback before publishing any CEO binding. A bind followed
    // by an awaited proof admits runs that cannot safely be revoked on a changed head.
    let current: GatewayIncumbentProof | null;
    try { current = await options.gatewayOrigin(); } catch { current = null; }
    if (!current || current.session_id !== expectedLiveSessionId ||
        current.lineage_root_digest !== proof.lineage_root_digest ||
        current.process_pid !== proof.process_pid || current.process_started_at !== proof.process_started_at ||
        readProcessStartToken(proof.process_pid) !== proof.process_started_at) return refuse();
    // The awaited readback may have let another caller replace the binding or move the actor.
    const latest = cp.db.get<typeof previous>(
      "SELECT actor_id, binding_generation, session_id, session_incarnation, status FROM assignments WHERE role_key = 'CEO' ORDER BY binding_generation DESC LIMIT 1",
    );
    const servingActor = cp.db.get<typeof actor>(
      "SELECT kind, current_session_id, current_session_incarnation, retired_at FROM conversational_actors WHERE actor_id = ?",
      [previous.actor_id],
    );
    if (cp.bindings.active("CEO") || !latest || latest.actor_id !== previous.actor_id ||
        latest.binding_generation !== previous.binding_generation || latest.session_id !== previous.session_id ||
        latest.session_incarnation !== previous.session_incarnation || latest.status !== "REVOKED" ||
        !servingActor || servingActor.kind !== Role.CEO || servingActor.retired_at !== null ||
        servingActor.current_session_id !== previous.session_id ||
        servingActor.current_session_incarnation !== previous.session_incarnation) return refuse();

    // SessionRegistry's liveness probe compares ps lstart, not the native Gateway token.
    const created = cp.sessions.create({ provider: "hermes", model: "hermes-runtime",
      osPid: proof.process_pid, osStartedAt: startedAt });
    const ready = cp.sessions.transition(created.sessionId, SessionLifecycle.READY, "authenticated live Gateway adoption");
    if (!ready.allowed || !created.sessionSecret ||
        !cp.sessions.verifySecret(created.sessionId, created.sessionSecret).allowed) {
      void cp.sessions.transition(created.sessionId, SessionLifecycle.ERROR, "adoption readiness failed");
      return deny(ReasonCode.CONFLICT, "Gateway adoption could not verify its READY session", {});
    }
    const claimed = { executorKind: "hermes", targetLocator: proof.session_id,
      targetLocatorDigest: proof.lineage_root_digest };
    let receipt: HermesTargetBindResponse | null = null;
    // Bind, inspect the exact assignment, and publish as one synchronous transaction.
    // A mismatched readback rolls the entire bind back before listeners or runs can see it.
    const bound: Decision<RoleBinding> = cp.db.txDecision((): Decision<RoleBinding> => {
      const binding = cp.bindings.bind({ role: Role.CEO, sessionId: created.sessionId,
      restoreCeo: { actorId: previous.actor_id, generation: previous.binding_generation,
        sessionId: previous.session_id, incarnation: previous.session_incarnation },
      authenticatedTarget: {
        claimed, protocolVersion: "hermes.target-bind/v1",
        expectedExecutorRuntimeIdentity: options.executorRuntimeIdentity,
        get targetBindReceipt() { return receipt; },
        get attestationDigest() { return receipt?.receipt_digest ?? ""; },
        verify: (tuple) => {
          // Target bind independently verifies the live head, lineage, actor and generation.
          // A caller-chosen route or a fabricated receipt never reaches the registry.
          const attested = runHermesTargetBind({ hermesExecutable: options.hermesExecutable,
            hermesProfile: options.hermesProfile, hermesHome: options.hermesHome,
            sessionId: proof.session_id, expectedLineageRootDigest: proof.lineage_root_digest,
            actorId: tuple.actorId, bindingGeneration: tuple.generation,
            executorRuntimeIdentity: options.executorRuntimeIdentity });
          if (!attested.allowed) return null;
          receipt = attested.value;
          return claimed;
        },
      },
      });
      if (!binding.allowed) return binding;
      const restored = cp.db.get<{ actor_id: string }>(
        "SELECT actor_id FROM assignments WHERE assignment_id = ? AND binding_generation = ?",
        [binding.value.assignmentId, binding.value.bindingGeneration],
      );
      const serving = cp.db.get<{ current_session_id: string; current_session_incarnation: string }>(
        "SELECT current_session_id, current_session_incarnation FROM conversational_actors WHERE actor_id = ?",
        [previous.actor_id],
      );
      const active = cp.bindings.active("CEO");
      if (restored?.actor_id !== previous.actor_id ||
          serving?.current_session_id !== created.sessionId ||
          serving.current_session_incarnation !== created.incarnation ||
          active?.assignmentId !== binding.value.assignmentId) {
        return deny(ReasonCode.CONFLICT, "Gateway adoption binding readback failed", {});
      }
      return binding;
    });
    if (!bound.allowed) {
      void cp.sessions.transition(created.sessionId, SessionLifecycle.ERROR, "adoption target bind failed");
      return bound;
    }
    return allow(ReasonCode.OK, { sessionId: created.sessionId, sessionIncarnation: created.incarnation,
      actorId: previous.actor_id, bindingGeneration: bound.value.bindingGeneration });
  },
  };
};
