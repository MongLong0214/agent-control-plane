import type { Clock } from "../core/clock.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { ClaimRegistry } from "../claims/claim-registry.ts";
import type { AuditLog } from "../db/audit.ts";
import type { Db } from "../db/database.ts";
import type { Outbox } from "../outbox/outbox.ts";
import type { Doctor, DoctorReport, DoctorScope } from "./doctor.ts";

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
    const now = new Date(this.clock.nowIso()).getTime();
    const overdue: WatchdogTick["overdue"] = [];
    const scopes = new Map<string, { scope: DoctorScope; target: string | null }>();

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
        overdue.push({ kind: "task_execution", id: execution.execution_id, ageMs });
        scopes.set(`run:${execution.run_id}`, { scope: "run", target: execution.run_id });
      }
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
        overdue.push({ kind: "run", id: run.run_id, ageMs });
        scopes.set(`run:${run.run_id}`, { scope: "run", target: run.run_id });
      }
    }

    for (const session of this.db.all<{ session_id: string; created_at: string }>(
      `SELECT session_id, created_at FROM sessions WHERE lifecycle = 'STARTING'`,
    )) {
      const ageMs = now - new Date(session.created_at).getTime();
      if (ageMs > this.deadlines.sessionStartMs) {
        overdue.push({ kind: "session", id: session.session_id, ageMs });
        scopes.set(`session:${session.session_id}`, { scope: "session", target: session.session_id });
      }
    }

    const expiredClaims = this.claims.overdue();
    for (const claim of expiredClaims) {
      overdue.push({
        kind: "claim",
        id: claim.claimId,
        ageMs: now - new Date(claim.expiresAt).getTime(),
      });
      scopes.set(`run:${claim.runId}`, { scope: "run", target: claim.runId });
    }

    for (const message of this.db.all<{ message_id: string; created_at: string }>(
      `SELECT message_id, created_at FROM outbox WHERE status = 'PENDING'`,
    )) {
      const ageMs = now - new Date(message.created_at).getTime();
      if (ageMs > this.deadlines.outboxPendingMs) {
        overdue.push({ kind: "outbox", id: message.message_id, ageMs });
        scopes.set("outbox", { scope: "system", target: null });
      }
    }

    this.outbox.expireOverdue();

    const reports: DoctorReport[] = [];
    for (const scope of scopes.values()) {
      reports.push(await this.doctor.run(scope.scope, scope.target ?? undefined));
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
