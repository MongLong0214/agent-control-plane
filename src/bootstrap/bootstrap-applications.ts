import type { Clock } from "../core/clock.ts";
import { type Decision, type Evidence, acpError, allow, deny, isAcpError } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { AuditLog } from "../db/audit.ts";
import type { Db } from "../db/database.ts";

/**
 * Recovery ledger for a bootstrap run's GitHub writes. A reservation holds the project and target
 * before any external effect. Every attempt is recorded before writing; WRITTEN preserves its result;
 * COMPLETED and STRANDED retain the reservation and its evidence.
 *
 * Target uniqueness, the frozen PLAN and candidate, writer attribution, and the per-operation GitHub
 * ledger prevent clobbering or replaying uncertain writes. A cancelled reservation can be released
 * only when no external effect is possible; missing or unreadable evidence keeps it in doubt.
 *
 * The legacy approval_digest column stores the write scope for conflict checks. It does not require
 * an owner receipt. Historical approval records are left in place and are no longer consulted.
 */

export type BootstrapApplicationPhase = "RESERVED" | "WRITTEN" | "COMPLETED" | "STRANDED" | "RELEASED";

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
 * #246 C3 — the daemon process an application attempt ran in, as its single-instance lock holder
 * record names it: the pid and the OS start token that tells a reused pid from it. Recorded with
 * every attempt, so a later attempt can prove the earlier one's process has ended.
 */
export interface AttemptWriter {
  pid: number;
  startToken: string | null;
  startedAt: string;
  /**
   * The process group the writer ran its git and gh subprocesses in (review 1076-R2), or null when it
   * could not be read. Its subprocesses are proven gone only through it.
   */
  processGroup: number | null;
}

/** What else a reservation records beside its row: the approval it consumed and who made its first attempt. */
export interface ReservationProvenance {
  writer: AttemptWriter | null;
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
 * Every reservation that holds this project id or this repository identity: every phase but
 * RELEASED, so a COMPLETED or STRANDED reservation holds its name for good. The registries ask this
 * before they register.
 */
export const bootstrapReservationsHolding = (
  db: Pick<Db, "all">,
  held: { projectId?: string | null; repositoryIdentity?: string | null },
): BootstrapApplication[] =>
  db
    .all<ApplicationRow>(
      `SELECT ${COLUMNS} FROM bootstrap_applications
        WHERE (project_id = ? OR repository_identity = ?) AND phase <> 'RELEASED' AND retired_at IS NULL
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

/**
 * Whether the run's plan is frozen: from the reservation on (CEO decision (b)). The reservation and
 * its first attempt share a transaction, so every row this class writes has one; a row with none
 * was written by something else, and freezes the plan all the same.
 */
export const applicationIsFrozen = (application: BootstrapApplication | null): boolean => application !== null;

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
   * The contract freeze: from the reservation of this run's application on, its plan cannot be
   * replaced, by `plan_submit` or by a FINAL_REVISE that would send it back for one.
   */
  assertNotFrozen(runId: string, via: "plan_submit" | "FINAL_REVISE"): Decision<void> {
    const application = this.get(runId);
    if (!applicationIsFrozen(application)) {
      const intent = this.db.get<{status:string}>(`SELECT status FROM resident_project_provisioning WHERE run_id = ? AND status IN ('PENDING','COMPLETE')`,[runId]);
      if (intent) return deny(ReasonCode.BOOTSTRAP_APPLICATION_FROZEN,"a reviewed CEO-confirmed resident provisioning intent freezes its PLAN",{runId,via,status:intent.status});
      return allow(ReasonCode.OK, undefined);
    }
    return deny(
      ReasonCode.BOOTSTRAP_APPLICATION_FROZEN,
      "this bootstrap run's application is reserved, so its plan is frozen; only the same candidate can be confirmed again, under the same approved write scope",
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
  reserve(reservation: BootstrapApplicationReservation, provenance: ReservationProvenance): Decision<BootstrapApplication> {
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
      return this.recordAttempt(reservation.runId, 0, provenance.writer);
    });
  }

  /**
   * The durable attempt record an attempt writes before its first external write: `attempts` + 1, as
   * a compare-and-set on the count the caller read. A concurrent attempt that read the same count
   * loses here and writes nothing.
   */
  recordAttempt(runId: string, expectedAttempts: number, writer: AttemptWriter | null = null): Decision<BootstrapApplication> {
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
        // The start token is kept as `processStart`: the audit log redacts any key that names a token.
        evidence: {
          attempt: application.attempts,
          candidateSnapshotDigest: application.candidateSnapshotDigest,
          writer:
            writer === null
              ? null
              : { pid: writer.pid, processStart: writer.startToken, startedAt: writer.startedAt, processGroup: writer.processGroup },
        },
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

  /**
   * CEO decision (b) — a cancelled run's reservation released: the row and its record are kept, and
   * only its hold on the project id and repository identity ends. The caller has shown that no
   * external effect happened.
   */
  markReleased(runId: string, release: Record<string, unknown>): Decision<BootstrapApplication> {
    return this.move(runId, "RESERVED", "RELEASED", { ...release }, "BOOTSTRAP_APPLICATION_RELEASED");
  }

  /** Keeps the reservation and the evidence; nothing is created, adopted or deleted afterwards. */
  markStranded(runId: string, stranded: StrandedCause): Decision<BootstrapApplication> {
    return this.move(runId, "RESERVED", "STRANDED", { ...stranded }, "BOOTSTRAP_APPLICATION_STRANDED");
  }

  /**
   * The last refusal an attempt met, on a row still RESERVED or WRITTEN; its phase and attempts are
   * unchanged. It is stamped with the attempt count at the moment it is recorded (`attempt`), so a
   * refusal an attempt recorded when it ended can be told from one an earlier attempt left. A write
   * that fails is reported rather than thrown: the refusal it records is already the caller's answer.
   */
  recordRefusal(runId: string, refusal: Record<string, unknown>): void {
    try {
      this.db.run(
        `UPDATE bootstrap_applications SET last_refusal_json = json_set(?, '$.attempt', attempts)
          WHERE run_id = ? AND phase IN ('RESERVED','WRITTEN')`,
        [JSON.stringify(refusal), runId],
      );
    } catch (error) {
      if (!isAcpError(error)) throw error;
    }
  }

  /**
   * #246 C3, CEO decision (b) — attempt `attempt` of this run is about to write its GitHub ledger for
   * the first time, and so may send a GitHub request after it. Recorded, durably, before that write:
   * an attempt with no such record never wrote the ledger and so never sent a request. A write that
   * fails throws, which stops the producer before the ledger is written or anything is sent.
   */
  recordLedgerStage(runId: string, attempt: number): void {
    const recorded = this.audit.record({
      kind: "BOOTSTRAP_APPLICATION_LEDGER_STAGE",
      runId,
      projectId: null,
      evidence: { attempt },
    });
    if (!recorded.allowed) throw acpError(recorded.reasonCode, recorded.message, recorded.evidence);
  }

  /** The writer each attempt of this run was recorded with; an attempt recorded without one maps to null. */
  attemptWriters(runId: string): Map<number, AttemptWriter | null> {
    const writers = new Map<number, AttemptWriter | null>();
    for (const event of this.events("BOOTSTRAP_APPLICATION_ATTEMPT", runId)) {
      const attempt = event["attempt"];
      if (typeof attempt !== "number") continue;
      const writer = event["writer"] as Record<string, unknown> | null | undefined;
      const processStart = writer?.["processStart"];
      // A start token the audit log could not keep is no record of it; nor is anything not shaped like one.
      const validStart = processStart === null || (typeof processStart === "string" && processStart.length > 0 && !processStart.startsWith("[redacted"));
      const valid =
        writer !== null &&
        writer !== undefined &&
        typeof writer["pid"] === "number" &&
        typeof writer["startedAt"] === "string" &&
        validStart;
      // A record with no process group, or none shaped like one, names no group: its subprocesses are unprovable.
      const group = writer?.["processGroup"];
      const processGroup = typeof group === "number" && Number.isSafeInteger(group) && group > 0 ? group : null;
      writers.set(
        attempt,
        valid
          ? { pid: writer["pid"] as number, startToken: processStart as string | null, startedAt: writer["startedAt"] as string, processGroup }
          : null,
      );
    }
    return writers;
  }

  /**
   * #246 C3 — which attempt first recorded each completed write of this run in its ledger. A receipt
   * keeps the attempt that first recorded it; a later attempt that finds it only refers to it.
   */
  receiptAttribution(runId: string): Map<string, number> {
    const attribution = new Map<string, number>();
    for (const event of this.events("BOOTSTRAP_APPLICATION_WRITE_RECEIPTED", runId)) {
      const operationId = event["operationId"];
      const attempt = event["attempt"];
      if (typeof operationId === "string" && typeof attempt === "number" && !attribution.has(operationId)) {
        attribution.set(operationId, attempt);
      }
    }
    return attribution;
  }

  /** Attempt `attempt` recorded the receipt of `operationId` first. */
  recordReceiptAttribution(runId: string, attempt: number, operationId: string, receiptDigest: string): void {
    const recorded = this.audit.record({
      kind: "BOOTSTRAP_APPLICATION_WRITE_RECEIPTED",
      runId,
      projectId: null,
      evidence: { attempt, operationId, receiptDigest },
    });
    if (!recorded.allowed) throw acpError(recorded.reasonCode, recorded.message, recorded.evidence);
  }

  /** The evidence of every `kind` audit event of this run, in the order they were recorded. */
  private events(kind: string, runId: string): Array<Record<string, unknown>> {
    return this.db
      .all<{ evidence_json: string }>(
        `SELECT evidence_json FROM audit_events WHERE kind = ? AND run_id = ? ORDER BY event_id`,
        [kind, runId],
      )
      .flatMap((row) => {
        try {
          const parsed = JSON.parse(row.evidence_json) as unknown;
          return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? [parsed as Record<string, unknown>] : [];
        } catch {
          return [];
        }
      });
  }

  /** The attempts of this run recorded as having reached their first GitHub ledger write. */
  ledgerStageAttempts(runId: string): number[] {
    return this.db
      .all<{ evidence_json: string }>(
        `SELECT evidence_json FROM audit_events
          WHERE kind = 'BOOTSTRAP_APPLICATION_LEDGER_STAGE' AND run_id = ?
          ORDER BY event_id`,
        [runId],
      )
      .map((row) => {
        try {
          const attempt = (JSON.parse(row.evidence_json) as { attempt?: unknown }).attempt;
          return typeof attempt === "number" && Number.isInteger(attempt) ? attempt : -1;
        } catch {
          return -1;
        }
      });
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
