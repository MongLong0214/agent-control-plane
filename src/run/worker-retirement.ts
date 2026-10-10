import { ReasonCode } from "../core/reason-codes.ts";
import type { AuditLog } from "../db/audit.ts";
import type { Db } from "../db/database.ts";
import { type SessionLiveness, probeSessionLiveness } from "../daemon/dead-binding-recovery.ts";
import { TERMINAL_RUN_STATES } from "../domain/run-state.ts";
import { Role, type RunState, SessionLifecycle } from "../domain/types.ts";
import type { ProviderRegistry, SessionHandle } from "../runtime/provider.ts";
import type { BindingRegistry } from "../session/binding-registry.ts";
import type { SessionRecord, SessionRegistry } from "../session/session-registry.ts";
import { type WorkerProcessPort, osWorkerProcesses } from "./worker-turn.ts";

/** One WORKER binding revoked because its run ended. */
export const WORKER_RETIRED = "WORKER_RETIRED";
/** A revoke the registry refused; the reconcile pass asks again. */
export const WORKER_RETIREMENT_DEFERRED = "WORKER_RETIREMENT_DEFERRED";
/** A retired worker's session left live because a recorded process or an open receipt remains. */
export const WORKER_PROCESS_REMAINING = "WORKER_PROCESS_REMAINING";
/** A retired worker's session the provider did not stop; it is left ERROR. */
export const WORKER_SESSION_STOP_FAILED = "WORKER_SESSION_STOP_FAILED";
/** A reconcile pass that changed or found something. */
export const WORKER_RETIREMENT_RECONCILED = "WORKER_RETIREMENT_RECONCILED";

/** What `assignments.revoked_reason` records for a WORKER retired because its run ended. */
export const workerRetirementReason = (state: RunState): string => `worker retired: its run ended ${state}`;

/** Why a retired worker's session was left live. */
export type RemainingStatus = "PROCESS_RUNNING" | "PROCESS_UNVERIFIED" | "RECEIPT_OPEN";

export interface RemainingWorkerProcess {
  sessionId: string;
  executionId: string | null;
  pid: number | null;
  status: RemainingStatus;
}

export interface WorkerRetirementReport {
  /** Role keys whose WORKER binding was revoked because their run had ended. */
  revoked: string[];
  /** Worker sessions the provider stopped, now STOPPED. */
  stopped: string[];
  /** What kept a retired worker's session live; the next pass asks again. */
  remaining: RemainingWorkerProcess[];
  /** Worker sessions the provider did not stop, now ERROR. */
  stopFailed: string[];
}

export interface WorkerRetirementPorts {
  readonly bindings: Pick<BindingRegistry, "revoke">;
  readonly sessions: Pick<SessionRegistry, "get" | "transition">;
  readonly providers: Pick<ProviderRegistry, "requireForRole">;
  /** Reads a worker turn's recorded process; never signals it. The OS by default. */
  readonly processes?: Pick<WorkerProcessPort, "alive" | "groupAlive" | "startToken">;
  /** Reads a session's own recorded process. `probeSessionLiveness` by default. */
  readonly sessionLiveness?: (osPid: number | null, startedAt: string | null) => SessionLiveness;
}

type Trigger = "terminal-transition" | "reconcile";

const TERMINAL_SQL = TERMINAL_RUN_STATES.map(() => "?").join(",");
const LIVE_LIFECYCLES: readonly string[] = [SessionLifecycle.STARTING, SessionLifecycle.READY, SessionLifecycle.DRAINING];

/**
 * #512 follow-through — a WORKER binding ends with its run.
 *
 * `WorkerStaffing` binds a task's WORKER and nothing revoked one: a run that went CANCELLED,
 * COMPLETED, FAILED or BLOCKED_POST_MERGE left its workers ACTIVE, holding the role and reporting a
 * live session for work that was over. Retirement has two halves, kept apart because they answer
 * different questions.
 *
 * Authority. `retireRun` runs inside the run engine's terminal transaction, beside the bootstrap
 * CTO's release, and revokes every ACTIVE WORKER of the run through `BindingRegistry.revoke`, with
 * the run's terminal state as the reason. A refusal does not block the transition; it is recorded
 * and the reconcile pass asks again.
 *
 * Runtime. After that transaction commits, each retired worker's session is stopped through its
 * provider and marked STOPPED — after commit rather than inside the transition, because a provider
 * stop is awaited and a transaction cannot span an await. It is stopped only when nothing it ran is
 * still running: a recorded worker process that is alive, or that cannot be confirmed gone, and a
 * receipt still open, leave the session as it is and are recorded as remaining. Nothing here
 * signals a process: a worker turn's
 * process belongs to the runner that launched it, which alone may kill it or record it released.
 *
 * `reconcile` is the daemon's pass: it retires any ACTIVE WORKER whose run has ended, however it got
 * there, and settles every retired worker's session that is still live. It is idempotent: a second
 * pass over the same state writes nothing.
 *
 * Only WORKER assignments are read or written, and only those of a run in a terminal state. A live
 * run's WORKER is left alone whatever its task's state, because the binding may yet serve a retry or
 * a revision.
 */
export class WorkerRetirement {
  /** One settle at a time, in order; `settled()` waits for the tail. */
  #tail: Promise<void> = Promise.resolve();
  readonly #processes: Pick<WorkerProcessPort, "alive" | "groupAlive" | "startToken">;
  readonly #sessionLiveness: (osPid: number | null, startedAt: string | null) => SessionLiveness;

  constructor(
    private readonly db: Db,
    private readonly audit: AuditLog,
    private readonly ports: WorkerRetirementPorts,
  ) {
    this.#processes = ports.processes ?? osWorkerProcesses;
    this.#sessionLiveness = ports.sessionLiveness ?? ((osPid, startedAt) => probeSessionLiveness(osPid, startedAt));
  }

  /**
   * Inside the transaction that moves `runId` to `state`: revoke the run's ACTIVE WORKERs, and once
   * it commits, settle their sessions. A rolled-back transition discards both.
   */
  retireRun(runId: string, state: RunState): string[] {
    const revoked = this.#revokeEnded("terminal-transition", runId);
    this.db.afterCommit(() => {
      void this.#enqueue(async () => {
        await this.#settle(runId);
      }).catch((error: unknown) => this.#recordFailure(runId, state, error));
    });
    return revoked;
  }

  /** The daemon's reconcile pass. Retires what an ended run left behind; a repeat writes nothing. */
  async reconcile(): Promise<WorkerRetirementReport> {
    return this.#enqueue(async () => {
      const revoked = this.#revokeEnded("reconcile", null);
      const settled = await this.#settle(null);
      const report: WorkerRetirementReport = { revoked, ...settled };
      if (revoked.length + settled.stopped.length + settled.remaining.length + settled.stopFailed.length > 0) {
        this.audit.record({
          kind: WORKER_RETIREMENT_RECONCILED,
          reasonCode: settled.stopFailed.length > 0 ? ReasonCode.SESSION_STOP_FAILED : ReasonCode.OK,
          evidence: {
            revoked: revoked.length,
            stopped: settled.stopped.length,
            remaining: settled.remaining.length,
            stopFailed: settled.stopFailed.length,
          },
        });
      }
      return report;
    });
  }

  /** Resolves once every settle queued so far has finished. */
  settled(): Promise<void> {
    return this.#tail;
  }

  #enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(work);
    this.#tail = next.then(() => undefined, () => undefined);
    return next;
  }

  /** ACTIVE WORKER assignments whose run is terminal (`runId`'s alone, when named), revoked. */
  #revokeEnded(trigger: Trigger, runId: string | null): string[] {
    const rows = this.db.all<{
      role_key: string;
      session_id: string;
      task_id: string | null;
      binding_generation: number;
      run_id: string;
      state: RunState;
    }>(
      `SELECT a.role_key, a.session_id, a.task_id, a.binding_generation, r.run_id, r.state
         FROM assignments a
         LEFT JOIN tasks t ON t.task_id = a.task_id
         JOIN runs r ON r.run_id = COALESCE(a.run_id, t.run_id)
        WHERE a.role = 'WORKER' AND a.status = 'ACTIVE'
          AND r.state IN (${TERMINAL_SQL})
          AND (? IS NULL OR r.run_id = ?)
        ORDER BY a.role_key`,
      [...TERMINAL_RUN_STATES, runId, runId],
    );
    const revoked: string[] = [];
    for (const row of rows) {
      const reason = workerRetirementReason(row.state);
      const decision = this.ports.bindings.revoke(row.role_key, reason);
      if (!decision.allowed) {
        this.audit.record({
          kind: WORKER_RETIREMENT_DEFERRED,
          reasonCode: decision.reasonCode,
          runId: row.run_id,
          roleKey: row.role_key,
          sessionId: row.session_id,
          evidence: { trigger, to: row.state, reason },
        });
        continue;
      }
      this.audit.record({
        kind: WORKER_RETIRED,
        reasonCode: ReasonCode.OK,
        runId: row.run_id,
        roleKey: row.role_key,
        sessionId: row.session_id,
        evidence: { trigger, to: row.state, taskId: row.task_id, generation: row.binding_generation, reason },
      });
      revoked.push(row.role_key);
    }
    return revoked;
  }

  /**
   * Stops the live sessions of revoked WORKERs whose run has ended (`runId`'s alone, when named): by
   * the session each binding recorded and by its actor's live runtime.
   */
  async #settle(runId: string | null): Promise<Omit<WorkerRetirementReport, "revoked">> {
    const report: Omit<WorkerRetirementReport, "revoked"> = { stopped: [], remaining: [], stopFailed: [] };
    const candidates = this.db.all<{ session_id: string }>(
      `SELECT DISTINCT w.session_id
         FROM (SELECT a.session_id AS session_id, COALESCE(a.run_id, t.run_id) AS run_id
                 FROM assignments a LEFT JOIN tasks t ON t.task_id = a.task_id
                WHERE a.role = 'WORKER' AND a.status = 'REVOKED'
               UNION
               SELECT c.current_session_id AS session_id, COALESCE(a.run_id, t.run_id) AS run_id
                 FROM assignments a
                 JOIN conversational_actors c ON c.actor_id = a.actor_id
                 LEFT JOIN tasks t ON t.task_id = a.task_id
                WHERE a.role = 'WORKER' AND a.status = 'REVOKED' AND c.current_session_id IS NOT NULL) w
         JOIN sessions s ON s.session_id = w.session_id
         JOIN runs r ON r.run_id = w.run_id
        WHERE s.lifecycle IN ('STARTING','READY','DRAINING')
          AND r.state IN (${TERMINAL_SQL})
          AND (? IS NULL OR r.run_id = ?)
        ORDER BY w.session_id`,
      [...TERMINAL_RUN_STATES, runId, runId],
    );
    for (const { session_id: sessionId } of candidates) {
      await this.#settleSession(sessionId, report);
    }
    return report;
  }

  async #settleSession(sessionId: string, report: Omit<WorkerRetirementReport, "revoked">): Promise<void> {
    const session = this.ports.sessions.get(sessionId);
    if (!session || !LIVE_LIFECYCLES.includes(session.lifecycle)) return;
    if (!this.#retiredOnly(sessionId)) return;

    // What the session ran comes first: a turn still running keeps the session, and is not touched.
    const remaining = this.#remainingTurns(sessionId);
    if (remaining.length > 0) {
      this.#recordRemaining(session, remaining, report);
      return;
    }

    const reason = "worker retired: its run ended";
    try {
      await this.ports.providers.requireForRole(session.provider, Role.WORKER).stopSession(handleFor(session));
    } catch (error) {
      if (LIVE_LIFECYCLES.includes(this.ports.sessions.get(sessionId)?.lifecycle ?? SessionLifecycle.STOPPED)) {
        this.ports.sessions.transition(sessionId, SessionLifecycle.ERROR, `${reason}: provider stop failed`);
      }
      this.audit.record({
        kind: WORKER_SESSION_STOP_FAILED,
        reasonCode: ReasonCode.SESSION_STOP_FAILED,
        sessionId,
        evidence: { reason, error: error instanceof Error ? error.message : String(error) },
      });
      report.stopFailed.push(sessionId);
      return;
    }

    // The session's own process, where it recorded one, must be gone before the row says so.
    const own = this.#sessionProcess(session);
    if (own !== null) {
      this.#recordRemaining(session, [own], report);
      return;
    }
    // Nothing it serves may have changed while the provider answered.
    if (!this.#retiredOnly(sessionId)) return;
    const stopped = this.ports.sessions.transition(sessionId, SessionLifecycle.STOPPED, reason);
    if (stopped.allowed) report.stopped.push(sessionId);
  }

  /**
   * The session holds no ACTIVE role, by its recorded session or its actor's live runtime, and every
   * WORKER it served belongs to a run that has ended.
   */
  #retiredOnly(sessionId: string): boolean {
    const held = this.db.get<{ n: number }>(
      `SELECT 1 AS n FROM assignments a
         LEFT JOIN conversational_actors c ON c.actor_id = a.actor_id
        WHERE a.status = 'ACTIVE' AND (a.session_id = ? OR c.current_session_id = ?)
        LIMIT 1`,
      [sessionId, sessionId],
    );
    if (held) return false;
    const live = this.db.get<{ n: number }>(
      `SELECT 1 AS n FROM assignments a
         LEFT JOIN conversational_actors c ON c.actor_id = a.actor_id
         LEFT JOIN tasks t ON t.task_id = a.task_id
         LEFT JOIN runs r ON r.run_id = COALESCE(a.run_id, t.run_id)
        WHERE a.role = 'WORKER' AND (a.session_id = ? OR c.current_session_id = ?)
          AND (r.run_id IS NULL OR r.state NOT IN (${TERMINAL_SQL}))
        LIMIT 1`,
      [sessionId, sessionId, ...TERMINAL_RUN_STATES],
    );
    return !live;
  }

  /**
   * A receipt still open on the session, and every recorded worker process not confirmed gone — the
   * same rule the worker runner applies before it records one released: no member of the group it led
   * remains, and the pid is gone or now names a process with another start time.
   */
  #remainingTurns(sessionId: string): RemainingWorkerProcess[] {
    const rows = this.db.all<{
      execution_id: string;
      status: string;
      worker_process_id: number | null;
      worker_process_started_at: string | null;
      worker_process_released_at: string | null;
    }>(
      `SELECT execution_id, status, worker_process_id, worker_process_started_at, worker_process_released_at
         FROM task_executions
        WHERE worker_session_id = ?
          AND (status = 'RUNNING' OR (worker_process_id IS NOT NULL AND worker_process_released_at IS NULL))
        ORDER BY execution_id`,
      [sessionId],
    );
    const remaining: RemainingWorkerProcess[] = [];
    for (const row of rows) {
      const pid = row.worker_process_id;
      const process = pid !== null && row.worker_process_released_at === null
        ? this.#turnProcess(pid, row.worker_process_started_at)
        : "GONE";
      if (process !== "GONE") {
        remaining.push({ sessionId, executionId: row.execution_id, pid, status: process });
      } else if (row.status === "RUNNING") {
        remaining.push({ sessionId, executionId: row.execution_id, pid, status: "RECEIPT_OPEN" });
      }
    }
    return remaining;
  }

  #turnProcess(pid: number, startedAt: string | null): "GONE" | "PROCESS_RUNNING" | "PROCESS_UNVERIFIED" {
    if (this.#processes.groupAlive(pid)) return "PROCESS_RUNNING";
    if (!this.#processes.alive(pid)) return "GONE";
    const now = this.#processes.startToken(pid);
    if (startedAt === null || now === null) return "PROCESS_UNVERIFIED";
    return now === startedAt ? "PROCESS_RUNNING" : "GONE";
  }

  /** The session's own recorded process, unless it is gone or none was recorded. */
  #sessionProcess(session: SessionRecord): RemainingWorkerProcess | null {
    if (session.osPid === null) return null;
    const liveness = this.#sessionLiveness(session.osPid, session.osProcessStartedAt);
    if (liveness === "DEAD") return null;
    return {
      sessionId: session.sessionId,
      executionId: null,
      pid: session.osPid,
      status: liveness === "ALIVE" ? "PROCESS_RUNNING" : "PROCESS_UNVERIFIED",
    };
  }

  #recordRemaining(
    session: SessionRecord,
    remaining: RemainingWorkerProcess[],
    report: Omit<WorkerRetirementReport, "revoked">,
  ): void {
    this.audit.record({
      kind: WORKER_PROCESS_REMAINING,
      sessionId: session.sessionId,
      evidence: {
        reason: "a retired worker's session is left live while what it ran remains",
        lifecycle: session.lifecycle,
        executions: remaining.map(({ executionId, pid, status }) => ({ executionId, pid, status })),
      },
    });
    report.remaining.push(...remaining);
  }

  /** A settle that threw after commit: recorded where possible, never thrown into the caller. */
  #recordFailure(runId: string, state: RunState, error: unknown): void {
    try {
      this.audit.record({
        kind: WORKER_SESSION_STOP_FAILED,
        reasonCode: ReasonCode.SESSION_STOP_FAILED,
        runId,
        evidence: { to: state, error: error instanceof Error ? error.message : String(error) },
      });
    } catch {
      /* the database may already be closed; the reconcile pass asks again */
    }
  }
}

/**
 * The provider handle for a worker session. `WorkerStaffing` records the provider's own session id as
 * the incarnation prefix, the only durable copy of it; the control plane's alias means nothing to the
 * runtime.
 */
const handleFor = (session: SessionRecord): SessionHandle => ({
  externalSessionId: session.incarnation.split("#")[0] ?? session.sessionId,
  provider: session.provider,
  model: session.model,
  effort: session.effort,
  pid: session.osPid,
  ...(session.workdir ? { workdir: session.workdir } : {}),
});
