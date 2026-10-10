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
/** A WORKER of an ended run left ACTIVE: its revoke was refused, or its scope is not its task's. */
export const WORKER_RETIREMENT_DEFERRED = "WORKER_RETIREMENT_DEFERRED";
/** A WORKER row whose recorded run is not its task's run: never revoked by either run's end. */
export const WORKER_SCOPE_CONFLICT = "WORKER_SCOPE_CONFLICT";
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
  /** Role keys left ACTIVE: the revoke was refused, or the row's run label is not its task's run. */
  deferred: string[];
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
    const { revoked } = this.#revokeEnded("terminal-transition", runId);
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
      const { revoked, deferred } = this.#revokeEnded("reconcile", null);
      const settled = await this.#settle(null);
      const report: WorkerRetirementReport = { revoked, deferred, ...settled };
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

  /**
   * ACTIVE WORKER assignments whose task's run is terminal (`runId`'s alone, when named), revoked.
   *
   * The task's run is the authority, never the row's own `run_id`: that column is a label the
   * registry did not check before #512's scope fence, and a row whose label is not its task's run is
   * deferred and recorded once, never revoked, because the label may name a run whose work is live.
   */
  #revokeEnded(trigger: Trigger, runId: string | null): { revoked: string[]; deferred: string[] } {
    const rows = this.db.all<{
      role_key: string;
      session_id: string;
      task_id: string;
      binding_generation: number;
      label_run_id: string | null;
      run_id: string;
      state: RunState;
    }>(
      `SELECT a.role_key, a.session_id, a.task_id, a.binding_generation, a.run_id AS label_run_id,
              t.run_id, r.state
         FROM assignments a
         JOIN tasks t ON t.task_id = a.task_id
         JOIN runs r ON r.run_id = t.run_id
        WHERE a.role = 'WORKER' AND a.status = 'ACTIVE'
          AND r.state IN (${TERMINAL_SQL})
          AND (? IS NULL OR r.run_id = ?)
        ORDER BY a.role_key`,
      [...TERMINAL_RUN_STATES, runId, runId],
    );
    const revoked: string[] = [];
    const deferred: string[] = [];
    for (const row of rows) {
      const reason = workerRetirementReason(row.state);
      if (row.label_run_id !== null && row.label_run_id !== row.run_id) {
        this.#defer(row, trigger, WORKER_SCOPE_CONFLICT, ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE, reason);
        deferred.push(row.role_key);
        continue;
      }
      const decision = this.ports.bindings.revoke(row.role_key, reason);
      if (!decision.allowed) {
        this.#defer(row, trigger, decision.reasonCode, decision.reasonCode, reason);
        deferred.push(row.role_key);
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
    return { revoked, deferred };
  }

  /** Records a deferral once per assignment generation and refusal, so repeated passes write nothing. */
  #defer(
    row: { role_key: string; session_id: string; binding_generation: number; label_run_id: string | null; run_id: string; state: RunState },
    trigger: Trigger,
    refusal: string,
    reasonCode: ReasonCode,
    reason: string,
  ): void {
    const recorded = this.db.get<{ n: number }>(
      `SELECT 1 AS n FROM audit_events
        WHERE kind = ? AND role_key = ?
          AND json_extract(evidence_json, '$.generation') = ? AND json_extract(evidence_json, '$.refusal') = ?
        LIMIT 1`,
      [WORKER_RETIREMENT_DEFERRED, row.role_key, row.binding_generation, refusal],
    );
    if (recorded) return;
    this.audit.record({
      kind: WORKER_RETIREMENT_DEFERRED,
      reasonCode,
      runId: row.run_id,
      roleKey: row.role_key,
      sessionId: row.session_id,
      evidence: {
        trigger,
        to: row.state,
        refusal,
        generation: row.binding_generation,
        labelRunId: row.label_run_id,
        reason,
      },
    });
  }

  /**
   * Stops the live sessions of revoked WORKERs whose run has ended (`runId`'s alone, when named): by
   * the session each binding recorded and by its actor's live runtime.
   */
  async #settle(runId: string | null): Promise<Omit<WorkerRetirementReport, "revoked" | "deferred">> {
    const report: Omit<WorkerRetirementReport, "revoked" | "deferred"> = { stopped: [], remaining: [], stopFailed: [] };
    const candidates = this.db.all<{ session_id: string }>(
      `SELECT DISTINCT w.session_id
         FROM (SELECT a.session_id AS session_id, t.run_id AS run_id
                 FROM assignments a JOIN tasks t ON t.task_id = a.task_id
                WHERE a.role = 'WORKER' AND a.status = 'REVOKED'
                  AND (a.run_id IS NULL OR a.run_id = t.run_id)
               UNION
               SELECT c.current_session_id AS session_id, t.run_id AS run_id
                 FROM assignments a
                 JOIN conversational_actors c ON c.actor_id = a.actor_id
                 JOIN tasks t ON t.task_id = a.task_id
                WHERE a.role = 'WORKER' AND a.status = 'REVOKED' AND c.current_session_id IS NOT NULL
                  AND (a.run_id IS NULL OR a.run_id = t.run_id)) w
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

  async #settleSession(sessionId: string, report: Omit<WorkerRetirementReport, "revoked" | "deferred">): Promise<void> {
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
   * WORKER it served belongs, by its task, to a run that has ended, with no run label that disagrees.
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
         LEFT JOIN runs r ON r.run_id = t.run_id
        WHERE a.role = 'WORKER' AND (a.session_id = ? OR c.current_session_id = ?)
          AND (r.run_id IS NULL OR r.state NOT IN (${TERMINAL_SQL})
               OR (a.run_id IS NOT NULL AND a.run_id <> t.run_id))
        LIMIT 1`,
      [sessionId, sessionId, ...TERMINAL_RUN_STATES],
    );
    return !live;
  }

  /**
   * What the session's receipts leave running, or cannot show has ended. A receipt's status is the
   * receipt's, not the process's: ABANDONED is written by a cancel or a restart without anything
   * having seen the worker exit, and TIMEOUT says it did not finish. So:
   *
   * - a RUNNING receipt is open;
   * - a recorded pid ends only when the runner recorded it released, or by the rule the runner
   *   applies before it does — no member of the group it led remains, and the pid is gone or now
   *   names a process with another start time; otherwise it is running or unverified;
   * - with no recorded pid, only a SUCCEEDED or FAILED receipt, which reports the worker's end, or a
   *   runtime-managed receipt whose launch the guard never admitted, which ran nothing, has ended.
   *   Any other receipt without a pid is PROCESS_UNVERIFIED: nothing establishes that its worker,
   *   whoever launched it, has stopped.
   */
  #remainingTurns(sessionId: string): RemainingWorkerProcess[] {
    const rows = this.db.all<{
      execution_id: string;
      status: string;
      runtime_managed: number;
      worker_process_id: number | null;
      worker_process_started_at: string | null;
      worker_process_released_at: string | null;
    }>(
      `SELECT execution_id, status, runtime_managed, worker_process_id, worker_process_started_at,
              worker_process_released_at
         FROM task_executions
        WHERE worker_session_id = ?
        ORDER BY execution_id`,
      [sessionId],
    );
    const remaining: RemainingWorkerProcess[] = [];
    for (const row of rows) {
      const pid = row.worker_process_id;
      let process: "GONE" | RemainingStatus;
      if (pid !== null) {
        process = row.worker_process_released_at !== null ? "GONE" : this.#turnProcess(pid, row.worker_process_started_at);
      } else if (row.status === "SUCCEEDED" || row.status === "FAILED") {
        process = "GONE";
      } else if (row.runtime_managed === 1 && !this.#launchWasAdmitted(row.execution_id)) {
        process = "GONE";
      } else {
        process = "PROCESS_UNVERIFIED";
      }
      if (process !== "GONE") {
        remaining.push({ sessionId, executionId: row.execution_id, pid, status: process });
      } else if (row.status === "RUNNING") {
        remaining.push({ sessionId, executionId: row.execution_id, pid, status: "RECEIPT_OPEN" });
      }
    }
    return remaining;
  }

  /**
   * Whether the managed write guard admitted a provider launch for this runtime-managed receipt —
   * the worker runner's own test for a launch that may have run with no pid recorded
   * (`WorkerTurnRunner.launchWasAuthorised`), read here the same way.
   */
  #launchWasAdmitted(executionId: string): boolean {
    return this.db.get<{ n: number }>(
      `SELECT 1 AS n FROM audit_events
        WHERE kind = 'MANAGED_WRITE_GUARD'
          AND json_extract(evidence_json, '$.taskReceiptId') = ?
          AND json_extract(evidence_json, '$.operation') = 'FILE_MUTATION'
          AND json_extract(evidence_json, '$.allowed') = 1
        LIMIT 1`,
      [executionId],
    ) !== undefined;
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

  /**
   * Reports what remains on every pass, and records it only when it differs from what this session's
   * last record said, so repeated passes over an unchanged session write nothing.
   */
  #recordRemaining(
    session: SessionRecord,
    remaining: RemainingWorkerProcess[],
    report: Omit<WorkerRetirementReport, "revoked" | "deferred">,
  ): void {
    report.remaining.push(...remaining);
    const executions = remaining.map(({ executionId, pid, status }) => ({ executionId, pid, status }));
    const last = this.db.get<{ evidence_json: string }>(
      `SELECT evidence_json FROM audit_events WHERE kind = ? AND session_id = ? ORDER BY event_id DESC LIMIT 1`,
      [WORKER_PROCESS_REMAINING, session.sessionId],
    );
    if (last && JSON.stringify((JSON.parse(last.evidence_json) as { executions?: unknown }).executions) === JSON.stringify(executions)) {
      return;
    }
    this.audit.record({
      kind: WORKER_PROCESS_REMAINING,
      sessionId: session.sessionId,
      evidence: {
        reason: "a retired worker's session is left live while what it ran remains",
        lifecycle: session.lifecycle,
        executions,
      },
    });
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
