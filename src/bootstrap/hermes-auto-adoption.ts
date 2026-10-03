import type { ControlPlane } from "../app/control-plane.ts";
import { type Decision, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { Role, roleKeyFor } from "../domain/types.ts";
import { isContinuityRevocationReason } from "../continuity/continuity-kernel.ts";
import { probeSessionLiveness, type SessionLiveness } from "../daemon/dead-binding-recovery.ts";

/**
 * The daemon re-adopts a restarted Hermes Gateway as the CEO by itself (2026-10-03).
 *
 * A Gateway redeploy changes its pid, continuity revokes the CEO generation whose process died, and
 * until now the CEO stayed unbound until the owner ran `agentctl adopt hermes` with the operator
 * token. That command proved nothing the adoption core does not prove on its own — the Gateway's
 * authenticated identity endpoint, the configured lineage, the pid and native start ACP reads from
 * the kernel, the previous incumbent's death — so the daemon now asks the same core itself. The
 * operator command stays, as a way to ask sooner; it is no longer needed.
 *
 * An attempt is made only when all four hold, each read before the Gateway is asked anything:
 * no CEO binding is active, the newest CEO generation is REVOKED, continuity revoked it (its
 * `assignments.revoked_reason` is one continuity writes — `isContinuityRevocationReason`, the
 * predicate continuity's own restoration reads), and that generation's runtime process is DEAD.
 * Anything else is not attempted and writes nothing — a live incumbent, an active binding
 * (including the one a previous attempt created, which is why repeated passes mint one generation
 * and not one per pass), a role that was never bound, or a revocation continuity did not write.
 *
 * The reason is read rather than ignored because a revocation an operator or the owner chose is a
 * decision to stop the CEO, and re-binding it by itself would overrule that decision. Any other
 * reason, or none, is read as such a decision (fail-closed): only the operator's `adopt hermes`
 * binds it again.
 *
 * A refused attempt is retried on a later pass, no sooner than an exponential backoff allows. Its
 * audit row is written once per distinct refusal of a revoked generation, not once per pass: the
 * newest refusal row is compared first, so a Gateway that stays down for a day leaves one row.
 */

export const HERMES_AUTO_ADOPTED = "HERMES_CEO_AUTO_ADOPTED";
export const HERMES_AUTO_ADOPTION_REFUSED = "HERMES_CEO_AUTO_ADOPTION_REFUSED";

export type HermesAutoAdoptionSkip =
  | "IN_FLIGHT"
  | "DAEMON_LOCK_NOT_HELD"
  | "CEO_ACTIVE"
  | "NO_REVOKED_CEO"
  | "REVOKED_BY_DECISION"
  | "INCUMBENT_NOT_DEAD"
  | "BACKING_OFF";

export type HermesAutoAdoptionOutcome =
  | { attempted: false; skipped: HermesAutoAdoptionSkip }
  | { attempted: true; decision: Decision<unknown> };

export interface HermesAutoAdoptionOptions {
  /** The configured adoption core: reads the Gateway itself and takes no caller input. */
  adopt(): Promise<Decision<unknown>>;
  authorityHeld?: () => boolean;
  /** Test seam for the incumbent's liveness; production probes the recorded pid and start. */
  liveness?: (osPid: number | null, recordedStartedAt: string | null) => SessionLiveness;
  backoff?: { baseMs: number; maxMs: number };
}

const DEFAULT_BACKOFF = { baseMs: 15_000, maxMs: 300_000 } as const;

const parseEvidence = (json: string): { revokedGeneration?: unknown; refusal?: unknown } | null => {
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed !== null && typeof parsed === "object" ? parsed as { revokedGeneration?: unknown; refusal?: unknown } : null;
  } catch {
    return null;
  }
};

export const createHermesAutoAdoption = (cp: ControlPlane, options: HermesAutoAdoptionOptions) => {
  const roleKey = roleKeyFor(Role.CEO);
  const backoff = options.backoff ?? DEFAULT_BACKOFF;
  const liveness = options.liveness ?? ((pid, startedAt) => probeSessionLiveness(pid, startedAt));
  const lockHeld = (): boolean => options.authorityHeld?.() ?? true;
  let inFlight = false;
  let failure: { generation: number; count: number; retryNotBefore: number } | null = null;

  /** The four preconditions, read synchronously; nothing here writes or asks the Gateway. */
  const revokedDeadGeneration = (): { generation: number } | HermesAutoAdoptionSkip => {
    if (cp.bindings.active(roleKey) !== null) return "CEO_ACTIVE";
    const latest = cp.db.get<{ binding_generation: number; session_id: string; session_incarnation: string;
      status: string; revoked_reason: string | null }>(
      `SELECT binding_generation, session_id, session_incarnation, status, revoked_reason
         FROM assignments WHERE role_key = ? ORDER BY binding_generation DESC LIMIT 1`,
      [roleKey],
    );
    if (latest === undefined) return "NO_REVOKED_CEO";
    if (latest.status !== "REVOKED") return "NO_REVOKED_CEO";
    if (!isContinuityRevocationReason(latest.revoked_reason)) return "REVOKED_BY_DECISION";
    const incumbent = cp.sessions.get(latest.session_id);
    if (incumbent === null) return "INCUMBENT_NOT_DEAD";
    if (incumbent.incarnation !== latest.session_incarnation) return "INCUMBENT_NOT_DEAD";
    if (liveness(incumbent.osPid, incumbent.osProcessStartedAt) !== "DEAD") return "INCUMBENT_NOT_DEAD";
    return { generation: latest.binding_generation };
  };

  /** One row per distinct refusal of one revoked generation; a repeat of the newest writes nothing. */
  const recordRefusal = (generation: number, decision: Decision<unknown>, trigger: string): void => {
    if (decision.allowed) return;
    if (!lockHeld()) return;
    const refusal = decision.message.slice(0, 160);
    const newest = cp.db.get<{ evidence_json: string; reason_code: string | null }>(
      "SELECT evidence_json, reason_code FROM audit_events WHERE kind = ? ORDER BY event_id DESC LIMIT 1",
      [HERMES_AUTO_ADOPTION_REFUSED],
    );
    if (newest !== undefined && newest.reason_code === decision.reasonCode) {
      const previous = parseEvidence(newest.evidence_json);
      if (previous?.revokedGeneration === generation && previous.refusal === refusal) return;
    }
    cp.audit.record({
      kind: HERMES_AUTO_ADOPTION_REFUSED,
      reasonCode: decision.reasonCode,
      roleKey,
      evidence: { revokedGeneration: generation, refusal, trigger },
    });
  };

  const tick = async (trigger: string): Promise<HermesAutoAdoptionOutcome> => {
    if (inFlight) return { attempted: false, skipped: "IN_FLIGHT" };
    if (!lockHeld()) return { attempted: false, skipped: "DAEMON_LOCK_NOT_HELD" };
    const eligible = revokedDeadGeneration();
    if (typeof eligible === "string") return { attempted: false, skipped: eligible };
    const now = cp.clock.now().getTime();
    if (failure !== null && failure.generation === eligible.generation && now < failure.retryNotBefore) {
      return { attempted: false, skipped: "BACKING_OFF" };
    }
    inFlight = true;
    let decision: Decision<unknown>;
    try {
      decision = await options.adopt();
    } catch {
      decision = deny(ReasonCode.CONFLICT, "authenticated live Gateway incumbent cannot be established", {});
    } finally {
      inFlight = false;
    }
    if (decision.allowed) {
      failure = null;
      if (lockHeld()) {
        cp.audit.record({
          kind: HERMES_AUTO_ADOPTED,
          reasonCode: ReasonCode.OK,
          roleKey,
          evidence: { revokedGeneration: eligible.generation, trigger },
        });
      }
      return { attempted: true, decision };
    }
    const count = failure !== null && failure.generation === eligible.generation ? failure.count + 1 : 1;
    const delay = Math.min(backoff.maxMs, backoff.baseMs * 2 ** Math.min(count - 1, 20));
    failure = { generation: eligible.generation, count, retryNotBefore: cp.clock.now().getTime() + delay };
    recordRefusal(eligible.generation, decision, trigger);
    return { attempted: true, decision };
  };

  return { tick };
};

export type HermesAutoAdoption = ReturnType<typeof createHermesAutoAdoption>;
