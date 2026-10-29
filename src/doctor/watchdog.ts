import type { Clock } from "../core/clock.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { ClaimRegistry } from "../claims/claim-registry.ts";
import type { AuditLog } from "../db/audit.ts";
import type { Db } from "../db/database.ts";
import type { Outbox } from "../outbox/outbox.ts";
import type { Doctor, DoctorReport, DoctorScope, Finding } from "./doctor.ts";

export interface WatchdogDeadlines {
  /** A task execution with no receipt or activity for this long is overdue. */
  taskActivityMs: number;
  /** A run that has been ACTIVE this long without any task or artifact is overdue. */
  runProgressMs: number;
  /** A session left STARTING this long never came up. */
  sessionStartMs: number;
  /** A pending outbox message older than this has not been delivered. */
  outboxPendingMs: number;
}

export const DEFAULT_DEADLINES: WatchdogDeadlines = {
  taskActivityMs: 30 * 60 * 1000,
  runProgressMs: 2 * 60 * 60 * 1000,
  sessionStartMs: 5 * 60 * 1000,
  outboxPendingMs: 10 * 60 * 1000,
};

export interface WatchdogTick {
  overdue: Array<{ kind: string; id: string; ageMs: number }>;
  triggered: Array<{ scope: DoctorScope; target: string | null }>;
  reports: DoctorReport[];
  ranAt: string;
}

/**
 * PRD §25.3 — a cheap timer, not a monitor.
 *
 * It inspects only resources that are already past a deadline; it never walks the whole
 * system. When something is overdue it triggers a *scoped* doctor for that thing, which
 * is what keeps continuous full diagnostics off the hot path (§40 Performance).
 */
export class Watchdog {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly audit: AuditLog,
    private readonly doctor: Doctor,
    private readonly claims: ClaimRegistry,
    private readonly outbox: Outbox,
    private readonly deadlines: WatchdogDeadlines = DEFAULT_DEADLINES,
  ) {}

  async tick(): Promise<WatchdogTick> {
    const nowIso = this.clock.nowIso();
    const now = new Date(nowIso).getTime();
    const overdue: WatchdogTick["overdue"] = [];
    const scopes = new Map<string, { scope: DoctorScope; target: string | null }>();
    const stallFindings = new Map<string, Finding[]>();
    const addOverdue = (
      key: string,
      scope: DoctorScope,
      target: string | null,
      kind: string,
      id: string,
      ageMs: number,
      deadlineMs: number,
    ): void => {
      overdue.push({ kind, id, ageMs });
      scopes.set(key, { scope, target });
      const findings = stallFindings.get(key) ?? [];
      findings.push({
        code: "WATCHDOG_STALL",
        severity: "ERROR",
        scope: `${kind}:${id}`,
        blocking: true,
        confidence: "HIGH",
        observedEvidence: { kind, id, ageMs, deadlineMs },
        recommendedAction: "inspect the stalled resource and repair or cancel it before resuming work",
      });
      stallFindings.set(key, findings);
    };

    for (const execution of this.db.all<{
      execution_id: string;
      run_id: string;
      started_at: string;
      last_activity_at: string | null;
    }>(`SELECT execution_id, run_id, started_at, last_activity_at
          FROM task_executions WHERE status = 'RUNNING'`)) {
      const since = new Date(execution.last_activity_at ?? execution.started_at).getTime();
      const ageMs = now - since;
      if (ageMs > this.deadlines.taskActivityMs) {
        addOverdue(
          `run:${execution.run_id}`,
          "run",
          execution.run_id,
          "task_execution",
          execution.execution_id,
          ageMs,
          this.deadlines.taskActivityMs,
        );
      }
    }

    // `candidate_pipeline_attempts` survives process death. Its persisted deadline is the
    // authoritative recovery fact: reconstructing it from started_at can silently change an
    // existing lease when policy changes. Keep the exact tuple conditional so a concurrent
    // fresh submit cannot be released accidentally (#335).
    for (const attempt of this.db.all<{
      run_id: string;
      attempt_id: string;
      started_at: string;
      deadline_at: string;
    }>(`SELECT run_id, attempt_id, started_at, deadline_at
          FROM candidate_pipeline_attempts
         WHERE state = 'RUNNING' AND deadline_at <= ?`, [nowIso])) {
      const ageMs = now - new Date(attempt.started_at).getTime();
      const reclaimed = this.db.run(
        `UPDATE candidate_pipeline_attempts
            SET state = 'RELEASED', released_at = ?
          WHERE run_id = ? AND attempt_id = ? AND state = 'RUNNING' AND deadline_at = ? AND deadline_at <= ?`,
        [nowIso, attempt.run_id, attempt.attempt_id, attempt.deadline_at, nowIso],
      );
      if (reclaimed.changes !== 1) continue;

      const key = `run:${attempt.run_id}`;
      overdue.push({ kind: "candidate_pipeline_attempt", id: attempt.attempt_id, ageMs });
      scopes.set(key, { scope: "run", target: attempt.run_id });
      const findings = stallFindings.get(key) ?? [];
      findings.push({
        code: ReasonCode.CANDIDATE_PIPELINE_ATTEMPT_STALE,
        severity: "ERROR",
        scope: `candidate_pipeline_attempt:${attempt.attempt_id}`,
        blocking: true,
        confidence: "HIGH",
        observedEvidence: {
          attemptId: attempt.attempt_id,
          startedAt: attempt.started_at,
          deadlineAt: attempt.deadline_at,
          ageMs,
          reclaimed: true,
        },
        recommendedAction: "inspect the interrupted candidate pipeline and submit a fresh result",
      });
      stallFindings.set(key, findings);
    }

    for (const run of this.db.all<{ run_id: string; dispatched_at: string | null }>(
      `SELECT run_id, dispatched_at FROM runs WHERE state = 'ACTIVE'`,
    )) {
      if (!run.dispatched_at) continue;
      const lastEvent = this.db.get<{ at: string | null }>(
        `SELECT MAX(at) AS at FROM audit_events WHERE run_id = ?`,
        [run.run_id],
      );
      const since = new Date(lastEvent?.at ?? run.dispatched_at).getTime();
      const ageMs = now - since;
      if (ageMs > this.deadlines.runProgressMs) {
        addOverdue(
          `run:${run.run_id}`,
          "run",
          run.run_id,
          "run",
          run.run_id,
          ageMs,
          this.deadlines.runProgressMs,
        );
      }
    }

    for (const session of this.db.all<{ session_id: string; created_at: string }>(
      `SELECT session_id, created_at FROM sessions WHERE lifecycle = 'STARTING'`,
    )) {
      const ageMs = now - new Date(session.created_at).getTime();
      if (ageMs > this.deadlines.sessionStartMs) {
        addOverdue(
          `session:${session.session_id}`,
          "session",
          session.session_id,
          "session",
          session.session_id,
          ageMs,
          this.deadlines.sessionStartMs,
        );
      }
    }

    const expiredClaims = this.claims.overdue();
    for (const claim of expiredClaims) {
      addOverdue(
        `run:${claim.runId}`,
        "run",
        claim.runId,
        "claim",
        claim.claimId,
        now - new Date(claim.expiresAt).getTime(),
        0,
      );
    }

    for (const message of this.db.all<{ message_id: string; created_at: string }>(
      `SELECT message_id, created_at FROM outbox WHERE status = 'PENDING'`,
    )) {
      const ageMs = now - new Date(message.created_at).getTime();
      if (ageMs > this.deadlines.outboxPendingMs) {
        addOverdue(
          "outbox",
          "system",
          null,
          "outbox",
          message.message_id,
          ageMs,
          this.deadlines.outboxPendingMs,
        );
      }
    }

    this.outbox.expireOverdue();

    const reports: DoctorReport[] = [];
    for (const [key, scope] of scopes) {
      reports.push(await this.doctor.run(scope.scope, scope.target ?? undefined, stallFindings.get(key)));
    }

    if (overdue.length > 0) {
      this.audit.record({
        kind: "WATCHDOG_STALL",
        reasonCode: ReasonCode.DOCTOR_DEGRADED,
        evidence: {
          overdue,
          triggeredScopes: [...scopes.values()],
          statuses: reports.map((r) => r.status),
        },
      });
    }

    return {
      overdue,
      triggered: [...scopes.values()],
      reports,
      ranAt: this.clock.nowIso(),
    };
  }
}
