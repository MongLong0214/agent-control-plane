import type { ControlPlane } from "../app/control-plane.ts";
import { readProcessStartToken } from "../core/process-argv.ts";
import { processStartedAt } from "../core/process-identity.ts";
import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { Role, SessionLifecycle, roleKeyFor, type RoleBinding } from "../domain/types.ts";
import { isContinuityRevocationReason } from "../continuity/continuity-kernel.ts";
import { probeSessionLiveness } from "../daemon/dead-binding-recovery.ts";
import { runHermesTargetBind, type HermesTargetBindResponse } from "../runtime/hermes-target-bind.ts";
import {
  headAdvanceTransaction,
  isHermesHead,
  judgeLiveHead,
  readHermesTargetHead,
  recordHeadAdvance,
} from "../session/hermes-target-head.ts";

/** Supplied only by the daemon's authenticated, read-only canonical Gateway endpoint adapter. */
export interface GatewayIncumbentProof {
  /** The live head; inside the lineage it may differ from the head the target was born with. */
  session_id: string;
  lineage_root_digest: string;
  process_pid: number;
  /** Native process start token (darwin-tv:sec.microsec), NOT ps lstart. */
  process_started_at: string;
}

export type HermesIncumbentAdoptionResult = Decision<{
  sessionId: string; actorId: string; bindingGeneration: number; sessionIncarnation: string;
}>;

/**
 * The revoked generation the daemon's own pass found eligible (`hermes-auto-adoption.ts`): revoked
 * by continuity, its runtime DEAD. An automatic adoption restores that generation or nothing, so a
 * generation bound and revoked by someone's decision while the Gateway was being read is never
 * restored by it (PR #1053 review, ACP1053-01). The operator's `agentctl adopt hermes` passes none.
 */
export interface AutomaticAdoptionIncumbent {
  assignmentId: string;
  generation: number;
  revokedReason: string;
}

export const createHermesIncumbentAdoption = (cp: ControlPlane, options: {
  /** This port must be wired by the daemon, not from an operator-supplied request. */
  gatewayOrigin(): Promise<GatewayIncumbentProof | null>;
  /**
   * The configured lineage. No head is configured: inside this lineage the head is the one the
   * Gateway reports (`judgeLiveHead`), and the stored target follows it in the bind transaction.
   */
  lineageRootDigest: string;
  hermesExecutable: string;
  hermesProfile: string;
  hermesHome: string;
  executorRuntimeIdentity: string;
}) => {
  return {
  async adopt(request: {
    gatewayPid: number; gatewayStartToken: string; automatic?: AutomaticAdoptionIncumbent;
  }): Promise<HermesIncumbentAdoptionResult> {
    const refuse = (): HermesIncumbentAdoptionResult =>
      deny(ReasonCode.CONFLICT, "authenticated live Gateway incumbent cannot be established", {});
    const automatic = request.automatic;
    /** For an automatic adoption, the newest CEO generation must still be the eligible one, as it was. */
    const stillEligible = (row: { assignment_id: string; binding_generation: number; status: string;
      revoked_reason: string | null }): boolean => {
      if (automatic === undefined) return true;
      if (row.assignment_id !== automatic.assignmentId) return false;
      if (row.binding_generation !== automatic.generation) return false;
      if (row.status !== "REVOKED") return false;
      if (row.revoked_reason !== automatic.revokedReason) return false;
      return isContinuityRevocationReason(row.revoked_reason);
    };
    let proof: GatewayIncumbentProof | null;
    try { proof = await options.gatewayOrigin(); } catch { return refuse(); }
    // Neither caller-supplied PID nor configured route proves the current process or head.
    if (!proof || !Number.isSafeInteger(proof.process_pid) || proof.process_pid <= 0 ||
        !isHermesHead(proof.session_id) || proof.lineage_root_digest !== options.lineageRootDigest ||
        proof.process_pid !== request.gatewayPid || proof.process_started_at !== request.gatewayStartToken ||
        !proof.process_started_at || readProcessStartToken(proof.process_pid) !== proof.process_started_at) return refuse();
    const startedAt = processStartedAt(proof.process_pid);
    if (!startedAt || readProcessStartToken(proof.process_pid) !== proof.process_started_at) return refuse();
    if (cp.bindings.active("CEO")) return refuse();
    const newestCeo = () => cp.db.get<{ assignment_id: string; actor_id: string; binding_generation: number;
      session_id: string; session_incarnation: string; status: string; revoked_reason: string | null }>(
      `SELECT assignment_id, actor_id, binding_generation, session_id, session_incarnation, status, revoked_reason
         FROM assignments WHERE role_key = 'CEO' ORDER BY binding_generation DESC LIMIT 1`,
    );
    const previous = newestCeo();
    if (!previous || previous.status !== "REVOKED" || !stillEligible(previous)) return refuse();
    const actor = cp.db.get<{ kind: string; current_session_id: string; current_session_incarnation: string; retired_at: string | null }>(
      "SELECT kind, current_session_id, current_session_incarnation, retired_at FROM conversational_actors WHERE actor_id = ?",
      [previous.actor_id],
    );
    const target = readHermesTargetHead(cp.db, previous.actor_id);
    const incumbent = cp.sessions.get(previous.session_id);
    // The actor's lineage is fixed; its head is not. A head the Gateway reports inside the same
    // lineage is the conversation's head now (a compression rotates it), so only another lineage
    // or another executor is refused here. The head the target was born with is not compared.
    if (!actor || actor.kind !== Role.CEO || actor.retired_at !== null || actor.current_session_id !== previous.session_id ||
        actor.current_session_incarnation !== previous.session_incarnation ||
        (target && judgeLiveHead(target, proof).verdict === "REFUSE") ||
        !incumbent || incumbent.incarnation !== previous.session_incarnation ||
        probeSessionLiveness(incumbent.osPid, incumbent.osProcessStartedAt) !== "DEAD") return refuse();

    // Finish the awaited Gateway readback before publishing any CEO binding. A bind followed
    // by an awaited proof admits runs that cannot safely be revoked on a changed head.
    let current: GatewayIncumbentProof | null;
    try { current = await options.gatewayOrigin(); } catch { current = null; }
    // The head must hold still across the readback: it is the head the bind attests and records.
    if (!current || current.session_id !== proof.session_id ||
        current.lineage_root_digest !== proof.lineage_root_digest ||
        current.process_pid !== proof.process_pid || current.process_started_at !== proof.process_started_at ||
        readProcessStartToken(proof.process_pid) !== proof.process_started_at) return refuse();
    // The awaited readback may have let another caller replace the binding or move the actor.
    const latest = newestCeo();
    const servingActor = cp.db.get<typeof actor>(
      "SELECT kind, current_session_id, current_session_incarnation, retired_at FROM conversational_actors WHERE actor_id = ?",
      [previous.actor_id],
    );
    if (cp.bindings.active("CEO") || !latest || latest.actor_id !== previous.actor_id ||
        latest.binding_generation !== previous.binding_generation || latest.session_id !== previous.session_id ||
        latest.session_incarnation !== previous.session_incarnation || latest.status !== "REVOKED" ||
        latest.assignment_id !== previous.assignment_id || !stillEligible(latest) ||
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
    // The row keeps `ps` lstart for the readers that compare it, and that grain is one second. The
    // exact token — read back from the Gateway and re-read from the kernel above — is pinned
    // beside it, so nothing that later admits this runtime has to trust the second (#1037).
    cp.sessions.pinNativeStart(created.sessionId, proof.process_started_at);
    const claimed = { executorKind: "hermes", targetLocator: proof.session_id,
      targetLocatorDigest: proof.lineage_root_digest };
    let receipt: HermesTargetBindResponse | null = null;
    // Bind, inspect the exact assignment, and publish as one synchronous transaction.
    // A mismatched readback rolls the entire bind back before listeners or runs can see it.
    const bound: Decision<RoleBinding> = headAdvanceTransaction(cp.db, (): Decision<RoleBinding> => {
      if (automatic !== undefined) {
        // Inside the transaction that binds: the eligible generation is still the newest, still
        // revoked by continuity, and its runtime still DEAD. Otherwise nothing here is written.
        const newest = newestCeo();
        const incumbentNow = cp.sessions.get(previous.session_id);
        if (!newest || !stillEligible(newest) || newest.session_id !== previous.session_id ||
            !incumbentNow || incumbentNow.incarnation !== previous.session_incarnation ||
            probeSessionLiveness(incumbentNow.osPid, incumbentNow.osProcessStartedAt) !== "DEAD") {
          return deny(ReasonCode.CONFLICT, "the revoked CEO generation is no longer the one found eligible", {});
        }
      }
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
      // The target follows the attested head, in this transaction: a head that cannot be
      // recorded rolls the binding back with it.
      const served = readHermesTargetHead(cp.db, previous.actor_id);
      if (!served) return deny(ReasonCode.CONFLICT, "Gateway adoption left the CEO without a target", {});
      const head = judgeLiveHead(served, proof);
      if (head.verdict === "REFUSE") return deny(ReasonCode.CONFLICT, "Gateway adoption target readback failed", {});
      if (head.verdict === "ADVANCE") {
        const advanced = recordHeadAdvance(cp.db, cp.audit, served, head, { path: "adoption", sessionId: created.sessionId,
          roleKey: roleKeyFor(Role.CEO), bindingGeneration: binding.value.bindingGeneration,
          gatewayPid: proof.process_pid });
        if (!advanced.allowed) return advanced as Decision<RoleBinding>;
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
