import type { AuditLog } from "../db/audit.ts";
import type { BootstrapCheckoutRecoveryPort } from "../doctor/repair.ts";
import type { BootstrapApplication } from "./bootstrap-applications.ts";

/** What became of a cancelled bootstrap's reservation right after its cancel committed. */
export type CancelledReservationOutcome =
  | "NO_APPLICATION"
  | "RELEASED"
  /** Not RESERVED: a WRITTEN application has GitHub effects, a STRANDED one could not be attributed. */
  | "KEPT"
  /** The release proof found an effect it cannot rule out; the row is marked RELEASE_IN_DOUBT. */
  | "KEPT_IN_DOUBT"
  /** A precondition not about effects is unmet now (an attempt in flight, the writer lock not held). */
  | "NOT_YET";

/**
 * #1189 B14 (CEO ruling 2) — after the cancel of a PROJECT_BOOTSTRAP run at CEO review commits, its
 * reservation is released through the existing release path and nothing else: the runner's
 * `inspectReservationRelease`/`releaseReservation`, which `release_bootstrap_reservation` also uses and
 * which re-proves that no request was ever sent before `markReleased` moves RESERVED to RELEASED.
 *
 * - RESERVED with that proof: RELEASED; a new run may reserve the name under its own approval.
 * - RESERVED without it: kept. An unclear effect is marked RELEASE_IN_DOUBT on the row, as the repair
 *   does; a precondition unmet for another reason (this process not holding the single-writer lock) is
 *   left for `release_bootstrap_reservation` (HERMES), which asks the same proof again.
 * - WRITTEN: kept; its GitHub writes happened (the cancel at CEO review refuses one; a run cancelled
 *   by another route may still hold one).
 * - STRANDED: kept for good. What GitHub holds at its target could not be attributed to the run, so no
 *   proof of "no effect" can exist; its project id and repository identity stay held until the owner
 *   retires the project, and a new bootstrap uses new ones (STRANDED_RECOVERY).
 *
 * Nothing on GitHub is read, created or deleted. Never throws: the cancel has already committed.
 */
export const releaseCancelledBootstrapReservation = (
  deps: {
    runner: BootstrapCheckoutRecoveryPort;
    applications: { get(runId: string): BootstrapApplication | null };
    audit: Pick<AuditLog, "record">;
  },
  runId: string,
): CancelledReservationOutcome => {
  let outcome: CancelledReservationOutcome = "NO_APPLICATION";
  let phase: string | null = null;
  let unmet: string[] = [];
  try {
    const application = deps.applications.get(runId);
    phase = application?.phase ?? null;
    if (application !== null && application.phase !== "RESERVED") outcome = "KEPT";
    else if (application !== null) {
      const inspected = deps.runner.inspectReservationRelease(runId);
      unmet = inspected.preconditions.filter((entry) => !entry.satisfied).map((entry) => entry.precondition);
      if (inspected.release === null) {
        if (inspected.inDoubt !== null) deps.runner.recordReleaseInDoubt(runId, inspected.inDoubt);
        outcome = inspected.inDoubt !== null ? "KEPT_IN_DOUBT" : "NOT_YET";
      } else {
        const released = deps.runner.releaseReservation(runId, inspected.release);
        outcome = released.allowed ? "RELEASED" : "NOT_YET";
      }
    }
  } catch (error) {
    outcome = "NOT_YET";
    unmet = [`the release raised: ${error instanceof Error ? error.message : String(error)}`];
  }
  if (outcome === "NO_APPLICATION") return outcome;
  try {
    deps.audit.record({
      kind: "BOOTSTRAP_RESERVATION_AFTER_CANCEL",
      runId,
      evidence: { outcome, phase, preconditions: unmet },
    });
  } catch {
    // The row's own phase still says what happened; a failed audit write does not undo the cancel.
  }
  return outcome;
};
