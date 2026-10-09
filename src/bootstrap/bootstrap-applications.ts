import type { Clock } from "../core/clock.ts";
import { type Decision, type Evidence, allow, deny, isAcpError } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { AuditLog } from "../db/audit.ts";
import type { Db } from "../db/database.ts";

/**
 * Issue #246 PR-C slice C3 — the durable record of a project-less PROJECT_BOOTSTRAP run's
 * application: the GitHub writes its CEO CONFIRM performs, and what became of them.
 *
 * `createRepository` can succeed and then crash or time out before the result is stored, so the
 * application is recorded before anything external happens and every phase is kept:
 *
 * - RESERVED, inserted with its first attempt in the transaction that consumes the owner's approval.
 *   The reservation holds the manifest's project id and the repository identity (UNIQUE on both, so
 *   the race two runs would run to one of them is closed by the database), and the digests of what
 *   was confirmed: PLAN, manifest, planned outputs, candidate, review and approval. A recovery can
 *   only re-apply that candidate; nothing about it can be changed afterwards.
 * - Every later attempt is recorded (`attempts` + 1) before that attempt's first external write. From
 *   the first one an external write may have happened, so the run's plan is frozen
 *   (BOOTSTRAP_APPLICATION_FROZEN): neither `plan_submit` nor FINAL_REVISE can replace it.
 * - WRITTEN, in the transaction that stores the produced result.
 * - COMPLETED, in the CEO's completion transaction.
 * - STRANDED, when what GitHub holds at the target cannot be attributed to this run by the evidence
 *   it recorded. The reservation and the evidence are kept; nothing is created, adopted, retried or
 *   deleted automatically, and the doctor names the cause and the recovery a person performs.
 *
 * The phase only moves forward and the row is never replaced or deleted, which schema v43's
 * triggers enforce for every writer; this class is the one that writes it.
 */

export type BootstrapApplicationPhase = "RESERVED" | "WRITTEN" | "COMPLETED" | "STRANDED";

/** What a reservation names, fixed for the life of the row. */
export interface BootstrapApplicationReservation {
  runId: string;
  projectId: string;
  repositoryIdentity: string;
  bootstrapOperationId: string;
  planDigest: string;
  manifestDigest: string;
  plannedOutputsDigest: string;
  candidateSnapshotDigest: string;
  reviewDigest: string;
  approvalDigest: string;
}

export interface BootstrapApplication extends BootstrapApplicationReservation {
  phase: BootstrapApplicationPhase;
  attempts: number;
  lastRefusal: Record<string, unknown> | null;
  reservedAt: string;
}

/**
 * Why a STRANDED application was stranded, and what a person does about it. Kept in the row's
 * `last_refusal_json` with the evidence, and repeated by the doctor's finding.
 */
export interface StrandedCause {
  /** A short code naming the cause, e.g. ATTRIBUTION_UNCERTAIN. */
  cause: string;
  requiredRecovery: string;
  evidence: Evidence;
}

interface ApplicationRow {
  run_id: string;
  project_id: string;
  repository_identity: string;
  bootstrap_operation_id: string;
  plan_digest: string;
  manifest_digest: string;
  planned_outputs_digest: string;
  candidate_snapshot_digest: string;
  review_digest: string;
  approval_digest: string;
  phase: BootstrapApplicationPhase;
  attempts: number;
  last_refusal_json: string | null;
  reserved_at: string;
}

const COLUMNS = `run_id, project_id, repository_identity, bootstrap_operation_id, plan_digest, manifest_digest,
  planned_outputs_digest, candidate_snapshot_digest, review_digest, approval_digest, phase, attempts,
  last_refusal_json, reserved_at`;

const parseRefusal = (json: string | null): Record<string, unknown> | null => {
  if (json === null) return null;
  try {
    const parsed = JSON.parse(json) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { unreadable: json };
  } catch {
    return { unreadable: json };
  }
};

const toApplication = (row: ApplicationRow): BootstrapApplication => ({
  runId: row.run_id,
  projectId: row.project_id,
  repositoryIdentity: row.repository_identity,
  bootstrapOperationId: row.bootstrap_operation_id,
  planDigest: row.plan_digest,
  manifestDigest: row.manifest_digest,
  plannedOutputsDigest: row.planned_outputs_digest,
  candidateSnapshotDigest: row.candidate_snapshot_digest,
  reviewDigest: row.review_digest,
  approvalDigest: row.approval_digest,
  phase: row.phase,
  attempts: row.attempts,
  lastRefusal: parseRefusal(row.last_refusal_json),
  reservedAt: row.reserved_at,
});

/** The application of `runId`, read through the one row mapper. */
export const bootstrapApplicationOf = (db: Pick<Db, "get">, runId: string): BootstrapApplication | null => {
  const row = db.get<ApplicationRow>(`SELECT ${COLUMNS} FROM bootstrap_applications WHERE run_id = ?`, [runId]);
  return row ? toApplication(row) : null;
};

/**
 * Every reservation that holds this project id or this repository identity, whatever its phase: a
 * COMPLETED or STRANDED reservation is never released. The registries ask this before they register.
 */
export const bootstrapReservationsHolding = (
  db: Pick<Db, "all">,
  held: { projectId?: string | null; repositoryIdentity?: string | null },
): BootstrapApplication[] =>
  db
    .all<ApplicationRow>(
      `SELECT ${COLUMNS} FROM bootstrap_applications
        WHERE project_id = ? OR repository_identity = ?
        ORDER BY run_id`,
      [held.projectId ?? null, held.repositoryIdentity ?? null],
    )
    .map(toApplication);

/** STRANDED applications, for the doctor: one run's, or all of them. */
export const strandedBootstrapApplications = (db: Pick<Db, "all">, runId: string | null): BootstrapApplication[] =>
  db
    .all<ApplicationRow>(
      `SELECT ${COLUMNS} FROM bootstrap_applications
        WHERE phase = 'STRANDED' AND (? IS NULL OR run_id = ?)
        ORDER BY run_id`,
      [runId, runId],
    )
    .map(toApplication);

/** Whether an external write of this application may have happened: an attempt is recorded. */
export const applicationIsFrozen = (application: BootstrapApplication | null): boolean =>
  application !== null && (application.attempts > 0 || application.phase !== "RESERVED");

export class BootstrapApplications {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly audit: AuditLog,
  ) {}

  get(runId: string): BootstrapApplication | null {
    return bootstrapApplicationOf(this.db, runId);
  }

  /** Reservations other than `runId`'s that hold this project id or repository identity. */
  heldByOthers(runId: string, held: { projectId: string; repositoryIdentity: string }): BootstrapApplication[] {
    return bootstrapReservationsHolding(this.db, held).filter((application) => application.runId !== runId);
  }

  /**
   * The contract freeze: from the moment an external write of this run's application may have
   * happened — an attempt is recorded — its plan cannot be replaced, by `plan_submit` or by a
   * FINAL_REVISE that would send it back for one.
   */
  assertNotFrozen(runId: string, via: "plan_submit" | "FINAL_REVISE"): Decision<void> {
    const application = this.get(runId);
    if (!applicationIsFrozen(application)) return allow(ReasonCode.OK, undefined);
    return deny(
      ReasonCode.BOOTSTRAP_APPLICATION_FROZEN,
      "an external write of this bootstrap run's application may have happened, so its plan is frozen; only the same candidate can be confirmed again",
      {
        refusal: "BOOTSTRAP_APPLICATION_FROZEN",
        runId,
        via,
        phase: application?.phase ?? null,
        attempts: application?.attempts ?? 0,
        candidateSnapshotDigest: application?.candidateSnapshotDigest ?? null,
      },
    );
  }

  /**
   * INSERT RESERVED and record the first attempt. Called inside the transaction that consumes the
   * owner's approval, so the consumption, the reservation and the attempt commit together or not at
   * all. A reservation another run holds is refused here by the UNIQUE constraints' guard, whatever a
   * caller checked before.
   */
  reserve(reservation: BootstrapApplicationReservation): Decision<BootstrapApplication> {
    return this.guarded(() => {
      this.db.run(
        `INSERT INTO bootstrap_applications (run_id, project_id, repository_identity, bootstrap_operation_id,
                                             plan_digest, manifest_digest, planned_outputs_digest,
                                             candidate_snapshot_digest, review_digest, approval_digest,
                                             phase, attempts, last_refusal_json, reserved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'RESERVED', 0, NULL, ?)`,
        [
          reservation.runId, reservation.projectId, reservation.repositoryIdentity, reservation.bootstrapOperationId,
          reservation.planDigest, reservation.manifestDigest, reservation.plannedOutputsDigest,
          reservation.candidateSnapshotDigest, reservation.reviewDigest, reservation.approvalDigest,
          this.clock.nowIso(),
        ],
      );
      this.audit.record({
        kind: "BOOTSTRAP_APPLICATION_RESERVED",
        runId: reservation.runId,
        projectId: null,
        evidence: { ...reservation },
      });
      return this.recordAttempt(reservation.runId, 0);
    });
  }

  /**
   * The durable attempt record an attempt writes before its first external write: `attempts` + 1, as
   * a compare-and-set on the count the caller read. A concurrent attempt that read the same count
   * loses here and writes nothing.
   */
  recordAttempt(runId: string, expectedAttempts: number): Decision<BootstrapApplication> {
    return this.guarded(() => {
      const updated = this.db.run(
        `UPDATE bootstrap_applications SET attempts = attempts + 1
          WHERE run_id = ? AND phase = 'RESERVED' AND attempts = ?`,
        [runId, expectedAttempts],
      );
      if (updated.changes !== 1) {
        return deny(
          ReasonCode.BOOTSTRAP_APPLICATION_IN_PROGRESS,
          "another application attempt of this bootstrap run was recorded first; this one writes nothing",
          { refusal: "ATTEMPT_NOT_RECORDED", runId, expectedAttempts, application: this.get(runId) },
        );
      }
      const application = this.get(runId)!;
      this.audit.record({
        kind: "BOOTSTRAP_APPLICATION_ATTEMPT",
        runId,
        evidence: { attempt: application.attempts, candidateSnapshotDigest: application.candidateSnapshotDigest },
      });
      return allow(ReasonCode.OK, application);
    });
  }

  /** The produced result is stored by the caller in the same transaction as this. */
  markWritten(runId: string): Decision<BootstrapApplication> {
    return this.move(runId, "RESERVED", "WRITTEN", null, "BOOTSTRAP_APPLICATION_WRITTEN");
  }

  /** Called inside the CEO's completion transaction, after the run's COMPLETED transition. */
  markCompleted(runId: string, candidateSnapshotDigest: string): Decision<BootstrapApplication> {
    const application = this.get(runId);
    if (application?.candidateSnapshotDigest !== candidateSnapshotDigest) {
      return deny(
        ReasonCode.BOOTSTRAP_APPLICATION_NOT_AVAILABLE,
        "the bootstrap application was reserved for another candidate than the one completing",
        { runId, candidateSnapshotDigest, reserved: application?.candidateSnapshotDigest ?? null },
      );
    }
    return this.move(runId, "WRITTEN", "COMPLETED", null, "BOOTSTRAP_APPLICATION_COMPLETED");
  }

  /** Keeps the reservation and the evidence; nothing is created, adopted or deleted afterwards. */
  markStranded(runId: string, stranded: StrandedCause): Decision<BootstrapApplication> {
    return this.move(runId, "RESERVED", "STRANDED", { ...stranded }, "BOOTSTRAP_APPLICATION_STRANDED");
  }

  /**
   * The last refusal an attempt met, on a row still RESERVED or WRITTEN; its phase and attempts are
   * unchanged. A write that fails is reported rather than thrown: the refusal it records is already
   * the caller's answer.
   */
  recordRefusal(runId: string, refusal: Record<string, unknown>): void {
    try {
      this.db.run(
        `UPDATE bootstrap_applications SET last_refusal_json = ?
          WHERE run_id = ? AND phase IN ('RESERVED','WRITTEN')`,
        [JSON.stringify(refusal), runId],
      );
    } catch (error) {
      if (!isAcpError(error)) throw error;
    }
  }

  private move(
    runId: string,
    from: BootstrapApplicationPhase,
    to: BootstrapApplicationPhase,
    refusal: Record<string, unknown> | null,
    auditKind: string,
  ): Decision<BootstrapApplication> {
    return this.guarded(() => {
      const updated = refusal === null
        ? this.db.run(`UPDATE bootstrap_applications SET phase = ? WHERE run_id = ? AND phase = ?`, [to, runId, from])
        : this.db.run(
            `UPDATE bootstrap_applications SET phase = ?, last_refusal_json = ? WHERE run_id = ? AND phase = ?`,
            [to, JSON.stringify(refusal), runId, from],
          );
      if (updated.changes !== 1) {
        const application = this.get(runId);
        return deny(
          ReasonCode.BOOTSTRAP_APPLICATION_NOT_AVAILABLE,
          `the bootstrap application is not ${from}, so it cannot become ${to}`,
          { runId, from, to, phase: application?.phase ?? null },
        );
      }
      const application = this.get(runId)!;
      this.audit.record({
        kind: auditKind,
        runId,
        // The cause code only: the row keeps the evidence and the recovery text in full.
        evidence: { from, to, attempts: application.attempts, ...(refusal === null ? {} : { cause: refusal["cause"] ?? null }) },
      });
      return allow(ReasonCode.OK, application);
    });
  }

  /** A guard the database raises is this class's refusal, typed, never a raw throw. */
  private guarded<T>(body: () => Decision<T>): Decision<T> {
    try {
      return body();
    } catch (error) {
      if (!isAcpError(error)) throw error;
      return deny(error.reasonCode, error.message, error.evidence);
    }
  }
}
