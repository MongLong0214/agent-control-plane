import type { Clock } from "../core/clock.ts";
import type {
  DynamicReserveDemand,
  WorkerFanoutCapacityTarget,
} from "../capacity/capacity-monitor.ts";
import { type Decision, allow, deny } from "../core/errors.ts";
import { newTaskId } from "../core/ids.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { AuditLog } from "../db/audit.ts";
import type { Db } from "../db/database.ts";
import { type FailureClass, RunState, type TaskCategory, TaskState } from "../domain/types.ts";
import type { Telemetry } from "../telemetry/telemetry.ts";

export interface TaskSpec {
  /** Caller-chosen local key used to express dependencies within one submission. */
  key: string;
  title: string;
  category: TaskCategory;
  dependsOn?: readonly string[];
  spec?: Record<string, unknown>;
}

export interface TaskRecord {
  taskId: string;
  runId: string;
  title: string;
  category: TaskCategory;
  state: TaskState;
  spec: Record<string, unknown>;
  attemptCount: number;
  dependsOn: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ExecutionStart {
  runId: string;
  taskId: string;
  ownerBindingGeneration: number;
  workerSessionId: string | null;
  workerProcessId?: number | null;
  provider: string;
  model: string;
  repositoryId?: string | null;
  worktreeId?: string | null;
  concurrencyWidth?: number | null;
}

export interface ExecutionRecord {
  executionId: string;
  runId: string;
  taskId: string;
  attempt: number;
  status: "RUNNING" | "SUCCEEDED" | "FAILED" | "ABANDONED" | "TIMEOUT";
  startedAt: string;
  lastActivityAt: string | null;
  endedAt: string | null;
  failureClass: FailureClass | null;
  resultDigest: string | null;
  provider: string;
  model: string;
  workerSessionId: string | null;
  ownerBindingGeneration: number;
}

/** The worker allocator must admit its exact lower-priority allocation before recording it. */
export interface WorkerCapacityGate {
  refreshForWorkerFanout(target?: WorkerFanoutCapacityTarget): Promise<Decision<void>>;
  workerReserveDemand(provider: string): DynamicReserveDemand;
}

/**
 * The CTO creates, extends and serialises the graph; the control plane checks only what
 * is machine-checkable — dependency integrity, readiness, and completion evidence
 * (PRD §11.3).
 *
 * Receipts are produced by the runtime adapter automatically (§25.2). There is no
 * requirement for a node to report progress, and no per-second heartbeat (§31.4); a
 * long job may record a low-frequency activity lease instead.
 */
/**
 * States in which the graph is sealed. A packet has been produced or the run is over, so
 * a new pending task could only invalidate a completeness claim already made (§34.3).
 */
const CLOSED_TO_NEW_TASKS: ReadonlySet<RunState> = new Set([
  RunState.READY_FOR_CEO_REVIEW,
  RunState.COMPLETED,
  RunState.FAILED,
  RunState.CANCELLED,
]);

export class TaskGraph {
  #capacity: WorkerCapacityGate | null = null;

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly audit: AuditLog,
    private readonly telemetry: Telemetry,
  ) {}

  /** Closed by the composition root after the capacity monitor exists. */
  attach(ports: { capacity?: WorkerCapacityGate }): void {
    if (ports.capacity) this.#capacity = ports.capacity;
  }

  /**
   * A graph may only be created or extended while the run is still doing work. Adding a
   * pending task to a run that has already produced a packet would make the packet's
   * completeness claim false after the fact (§34.3, CP-HI-08).
   */
  submit(runId: string, specs: readonly TaskSpec[]): Decision<TaskRecord[]> {
    if (specs.length === 0) {
      return deny(ReasonCode.INVALID_ARGUMENT, "task submission is empty", { runId });
    }

    const run = this.db.get<{ state: string }>(`SELECT state FROM runs WHERE run_id = ?`, [runId]);
    if (!run) return deny(ReasonCode.NOT_FOUND, "unknown run", { runId });
    if (CLOSED_TO_NEW_TASKS.has(run.state as RunState)) {
      return deny(
        ReasonCode.RUN_TRANSITION_ILLEGAL,
        `run is ${run.state}; its work is already sealed against new tasks`,
        { runId, state: run.state },
      );
    }

    const keys = new Set(specs.map((s) => s.key));
    if (keys.size !== specs.length) {
      return deny(ReasonCode.INVALID_ARGUMENT, "duplicate task keys in submission", { runId });
    }

    const existingByTitle = new Map(this.list(runId).map((t) => [t.title, t.taskId]));
    const resolve = (key: string): string | null =>
      keys.has(key) ? null : (existingByTitle.get(key) ?? null);

    for (const spec of specs) {
      for (const dep of spec.dependsOn ?? []) {
        if (!keys.has(dep) && !resolve(dep)) {
          return deny(ReasonCode.TASK_DEPENDENCY_UNSATISFIED, `unknown dependency '${dep}'`, {
            runId,
            task: spec.key,
            dependency: dep,
          });
        }
      }
    }

    const cycle = findCycle(specs);
    if (cycle) {
      return deny(ReasonCode.TASK_DEPENDENCY_CYCLE, "task dependencies form a cycle", {
        runId,
        cycle,
      });
    }

    return this.db.tx(() => {
      const now = this.clock.nowIso();
      const idByKey = new Map<string, string>();
      for (const spec of specs) idByKey.set(spec.key, newTaskId());

      for (const spec of specs) {
        const taskId = idByKey.get(spec.key)!;
        this.db.run(
          `INSERT INTO tasks (task_id, run_id, title, category, state, spec_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'PENDING', ?, ?, ?)`,
          [taskId, runId, spec.title, spec.category, JSON.stringify(spec.spec ?? {}), now, now],
        );
        for (const dep of spec.dependsOn ?? []) {
          const dependsOn = idByKey.get(dep) ?? resolve(dep);
          if (dependsOn) {
            this.db.run(`INSERT INTO task_dependencies (task_id, depends_on) VALUES (?, ?)`, [
              taskId,
              dependsOn,
            ]);
          }
        }
      }

      this.refreshReadiness(runId);
      const created = specs.map((s) => this.require(idByKey.get(s.key)!));

      this.audit.record({
        kind: "TASK_GRAPH_SUBMITTED",
        runId,
        evidence: {
          taskCount: created.length,
          dependencyCount: created.reduce((n, t) => n + t.dependsOn.length, 0),
        },
      });
      this.telemetry.record({ scope: "graph", name: "task_count", runId, value: created.length });
      this.telemetry.record({
        scope: "graph",
        name: "dependency_count",
        runId,
        value: created.reduce((n, t) => n + t.dependsOn.length, 0),
      });

      return allow(ReasonCode.OK, created);
    });
  }

  /** PENDING tasks whose dependencies have all succeeded become READY. */
  refreshReadiness(runId: string): void {
    this.db.run(
      `UPDATE tasks SET state = 'READY', updated_at = ?
        WHERE run_id = ? AND state = 'PENDING'
          AND NOT EXISTS (
            SELECT 1 FROM task_dependencies d JOIN tasks p ON p.task_id = d.depends_on
             WHERE d.task_id = tasks.task_id AND p.state <> 'SUCCEEDED')`,
      [this.clock.nowIso(), runId],
    );
  }

  ready(runId: string): TaskRecord[] {
    this.refreshReadiness(runId);
    return this.list(runId).filter((t) => t.state === TaskState.READY);
  }

  startExecution(input: ExecutionStart): Decision<ExecutionRecord> {
    return this.db.tx(() => {
      const task = this.get(input.taskId);
      if (!task) return deny(ReasonCode.NOT_FOUND, "unknown task", { taskId: input.taskId });
      // An authorised owner of one run must not be able to drive another run's task.
      if (task.runId !== input.runId) {
        return deny(ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE, "task belongs to another run", {
          taskId: input.taskId,
          taskRunId: task.runId,
          requestedRunId: input.runId,
        });
      }
      if (task.state !== TaskState.READY && task.state !== TaskState.FAILED) {
        return deny(
          ReasonCode.TASK_DEPENDENCY_UNSATISFIED,
          `task is ${task.state}; only READY or FAILED tasks may be executed`,
          { taskId: input.taskId, state: task.state },
        );
      }

      const attempt = task.attemptCount + 1;
      const executionId = `${input.taskId}#${attempt}`;
      const now = this.clock.nowIso();

      this.db.run(
        `INSERT INTO task_executions (execution_id, run_id, task_id, attempt, owner_binding_generation,
                                      worker_session_id, worker_process_id, provider, model,
                                      repository_id, worktree_id, concurrency_width, started_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'RUNNING')`,
        [
          executionId, input.runId, input.taskId, attempt, input.ownerBindingGeneration,
          input.workerSessionId, input.workerProcessId ?? null, input.provider, input.model,
          input.repositoryId ?? null, input.worktreeId ?? null, input.concurrencyWidth ?? null, now,
        ],
      );
      this.db.run(
        `UPDATE tasks SET state = 'RUNNING', attempt_count = ?, updated_at = ? WHERE task_id = ?`,
        [attempt, now, input.taskId],
      );

      this.audit.record({
        kind: "TASK_EXECUTION_STARTED",
        runId: input.runId,
        sessionId: input.workerSessionId,
        evidence: {
          taskId: input.taskId,
          attempt,
          provider: input.provider,
          model: input.model,
          worktreeId: input.worktreeId ?? null,
          ownerBindingGeneration: input.ownerBindingGeneration,
        },
      });

      return allow(ReasonCode.OK, this.execution(executionId)!);
    });
  }

  /**
   * §14.2/§14.5 production worker path. A receipt is not enough to make a worker
   * allocation safe: fan-out first re-probes the selected provider and withholds the
   * dynamic reserve needed by active CEO/CTO/reviewer coverage. `startExecution` remains
   * the synchronous receipt primitive used by tests and recovery import; the MCP worker
   * allocator is deliberately routed only through this admission method.
   */
  async startWorkerExecution(input: ExecutionStart): Promise<Decision<ExecutionRecord>> {
    if (!this.#capacity) {
      return deny(
        ReasonCode.CAPACITY_UNKNOWN_NOT_ROUTABLE,
        "worker execution has no attached capacity admission gate",
        { runId: input.runId, taskId: input.taskId, provider: input.provider },
      );
    }
    const target: WorkerFanoutCapacityTarget = {
      provider: input.provider,
      capabilities: [this.workerCapability(input.model)],
      priority: "worker",
      // The monitor reads durable role/running-work facts. Passing the complete demand on
      // this production path makes worker priority explicit instead of caller-optional.
      reserveDemand: this.#capacity.workerReserveDemand(input.provider),
    };
    const capacity = await this.#capacity.refreshForWorkerFanout(target);
    if (!capacity.allowed) return capacity as Decision<ExecutionRecord>;
    return this.startExecution(input);
  }

  finishExecution(
    executionId: string,
    outcome: {
      status: "SUCCEEDED" | "FAILED" | "ABANDONED" | "TIMEOUT";
      resultDigest?: string | null;
      failureClass?: FailureClass | null;
    },
    /** When given, the execution must belong to this run (§25.2). */
    expectedRunId?: string,
  ): Decision<ExecutionRecord> {
    return this.db.tx(() => {
      const execution = this.execution(executionId);
      if (!execution) return deny(ReasonCode.NOT_FOUND, "unknown execution", { executionId });
      if (expectedRunId !== undefined && execution.runId !== expectedRunId) {
        return deny(ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE, "execution belongs to another run", {
          executionId,
          executionRunId: execution.runId,
          requestedRunId: expectedRunId,
        });
      }
      const owner = this.db.get<{ owner_binding_generation: number | null }>(
        `SELECT owner_binding_generation FROM runs WHERE run_id = ?`,
        [execution.runId],
      );
      if (!owner || owner.owner_binding_generation !== execution.ownerBindingGeneration) {
        // A takeover invalidates an in-flight execution, even if the old process gets to
        // report after the replacement has started. Preserve the receipt attempt for
        // forensic audit but never let it advance the task state (§10.3, §15.7).
        this.audit.record({
          kind: "TASK_EXECUTION_LATE_RESULT_IGNORED",
          runId: execution.runId,
          sessionId: execution.workerSessionId,
          reasonCode: ReasonCode.BINDING_GENERATION_STALE,
          evidence: {
            executionId,
            taskId: execution.taskId,
            executionGeneration: execution.ownerBindingGeneration,
            currentGeneration: owner?.owner_binding_generation ?? null,
            attemptedStatus: outcome.status,
          },
        });
        return deny(
          ReasonCode.BINDING_GENERATION_STALE,
          "execution belongs to a superseded owner generation",
          {
            executionId,
            executionGeneration: execution.ownerBindingGeneration,
            currentGeneration: owner?.owner_binding_generation ?? null,
          },
        );
      }
      if (execution.status !== "RUNNING") {
        return deny(ReasonCode.CONFLICT, `execution is already ${execution.status}`, {
          executionId,
          status: execution.status,
        });
      }
      // §25.2 — a success receipt names what it produced. Without a digest there is
      // nothing to bind the claim to, so it is not a success.
      if (outcome.status === "SUCCEEDED" && !outcome.resultDigest) {
        return deny(
          ReasonCode.EVIDENCE_MISSING,
          "a SUCCEEDED execution must carry a result digest",
          { executionId },
        );
      }

      const now = this.clock.nowIso();
      this.db.run(
        `UPDATE task_executions SET status = ?, ended_at = ?, result_digest = ?, failure_class = ?
          WHERE execution_id = ?`,
        [outcome.status, now, outcome.resultDigest ?? null, outcome.failureClass ?? null, executionId],
      );
      this.db.run(`UPDATE tasks SET state = ?, updated_at = ? WHERE task_id = ?`, [
        outcome.status === "SUCCEEDED" ? TaskState.SUCCEEDED : TaskState.FAILED,
        now,
        execution.taskId,
      ]);
      this.refreshReadiness(execution.runId);

      this.audit.record({
        kind: "TASK_EXECUTION_FINISHED",
        runId: execution.runId,
        sessionId: execution.workerSessionId,
        evidence: {
          taskId: execution.taskId,
          attempt: execution.attempt,
          status: outcome.status,
          failureClass: outcome.failureClass ?? null,
          resultDigest: outcome.resultDigest ?? null,
        },
      });

      const durationMs =
        new Date(now).getTime() - new Date(execution.startedAt).getTime();
      const task = this.get(execution.taskId);
      this.telemetry.record({
        scope: "task",
        name: "execution",
        runId: execution.runId,
        taskId: execution.taskId,
        value: durationMs,
        text: outcome.status,
        dims: {
          category: task?.category ?? null,
          provider: execution.provider,
          model: execution.model,
          attempt: execution.attempt,
          failureClass: outcome.failureClass ?? null,
        },
      });

      return allow(ReasonCode.OK, this.execution(executionId)!);
    });
  }

  /** §25.2 — a long job records a low-frequency activity lease, not a heartbeat. */
  /** §31.4 — a low-frequency activity lease, scoped to the run that owns the execution. */
  recordActivity(executionId: string, expectedRunId?: string): Decision<void> {
    const execution = this.execution(executionId);
    if (!execution) return deny(ReasonCode.NOT_FOUND, "unknown execution", { executionId });
    if (expectedRunId !== undefined && execution.runId !== expectedRunId) {
      return deny(ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE, "execution belongs to another run", {
        executionId,
        executionRunId: execution.runId,
        requestedRunId: expectedRunId,
      });
    }
    this.db.run(`UPDATE task_executions SET last_activity_at = ? WHERE execution_id = ?`, [
      this.clock.nowIso(),
      executionId,
    ]);
    return allow(ReasonCode.OK, undefined);
  }

  /** Luna has its own disposable-capacity bucket; all other worker models use worker. */
  private workerCapability(model: string): "worker" | "luna-worker" {
    return /luna/i.test(model) ? "luna-worker" : "worker";
  }

  /**
   * §34.3 — synthesis and completion are blocked unless every task reached a terminal
   * state and every started execution produced a receipt.
   */
  completeness(runId: string): Decision<{ tasks: number; succeeded: number }> {
    const tasks = this.list(runId);
    if (tasks.length === 0) {
      return allow(ReasonCode.OK, { tasks: 0, succeeded: 0 });
    }
    const unfinished = tasks.filter(
      (t) => t.state !== TaskState.SUCCEEDED && t.state !== TaskState.CANCELLED,
    );
    if (unfinished.length > 0) {
      return deny(
        ReasonCode.TASK_RESULT_COUNT_MISMATCH,
        "not every task reached a successful terminal state",
        { runId, unfinished: unfinished.map((t) => ({ taskId: t.taskId, state: t.state })) },
      );
    }
    const dangling = this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM task_executions WHERE run_id = ? AND status = 'RUNNING'`,
      [runId],
    );
    if ((dangling?.n ?? 0) > 0) {
      return deny(ReasonCode.TASK_RECEIPT_MISSING, "task executions are still running", {
        runId,
        running: dangling?.n,
      });
    }
    return allow(ReasonCode.OK, {
      tasks: tasks.length,
      succeeded: tasks.filter((t) => t.state === TaskState.SUCCEEDED).length,
    });
  }

  cancelAll(runId: string, reason: string): number {
    const changes = this.db.run(
      `UPDATE tasks SET state = 'CANCELLED', updated_at = ?
        WHERE run_id = ? AND state IN ('PENDING','READY','RUNNING')`,
      [this.clock.nowIso(), runId],
    ).changes;
    this.db.run(
      `UPDATE task_executions SET status = 'ABANDONED', ended_at = ?
        WHERE run_id = ? AND status = 'RUNNING'`,
      [this.clock.nowIso(), runId],
    );
    if (changes > 0) this.audit.record({ kind: "TASK_GRAPH_CANCELLED", runId, evidence: { reason, changes } });
    return changes;
  }

  /** A replacement owner must start a fresh attempt; old work is never adoptable. */
  abandonStaleExecutions(runId: string, currentGeneration: number, reason: string): number {
    const now = this.clock.nowIso();
    const stale = this.db.all<{ task_id: string; execution_id: string }>(
      `SELECT task_id, execution_id FROM task_executions
        WHERE run_id = ? AND status = 'RUNNING' AND owner_binding_generation <> ?`,
      [runId, currentGeneration],
    );
    if (stale.length === 0) return 0;

    this.db.run(
      `UPDATE task_executions SET status = 'ABANDONED', ended_at = ?
        WHERE run_id = ? AND status = 'RUNNING' AND owner_binding_generation <> ?`,
      [now, runId, currentGeneration],
    );
    for (const task of stale) {
      this.db.run(
        `UPDATE tasks SET state = 'READY', updated_at = ? WHERE task_id = ? AND state = 'RUNNING'`,
        [now, task.task_id],
      );
    }
    this.audit.record({
      kind: "TASK_EXECUTIONS_ABANDONED_FOR_TAKEOVER",
      runId,
      reasonCode: ReasonCode.BINDING_GENERATION_STALE,
      evidence: { reason, currentGeneration, executions: stale.map((row) => row.execution_id) },
    });
    return stale.length;
  }

  get(taskId: string): TaskRecord | null {
    const row = this.db.get<RawTask>(`SELECT * FROM tasks WHERE task_id = ?`, [taskId]);
    return row ? this.hydrate(row) : null;
  }

  require(taskId: string): TaskRecord {
    const task = this.get(taskId);
    if (!task) throw new Error(`unknown task ${taskId}`);
    return task;
  }

  list(runId: string): TaskRecord[] {
    return this.db
      .all<RawTask>(`SELECT * FROM tasks WHERE run_id = ? ORDER BY created_at, rowid`, [runId])
      .map((row) => this.hydrate(row));
  }

  execution(executionId: string): ExecutionRecord | null {
    const row = this.db.get<RawExecution>(
      `SELECT * FROM task_executions WHERE execution_id = ?`,
      [executionId],
    );
    return row ? hydrateExecution(row) : null;
  }

  executions(runId: string): ExecutionRecord[] {
    return this.db
      .all<RawExecution>(`SELECT * FROM task_executions WHERE run_id = ? ORDER BY started_at`, [runId])
      .map(hydrateExecution);
  }

  /** Concurrency actually observed at this moment — telemetry input, not a cap. */
  runningWidth(runId: string): number {
    return (
      this.db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM task_executions WHERE run_id = ? AND status = 'RUNNING'`,
        [runId],
      )?.n ?? 0
    );
  }

  private hydrate(row: RawTask): TaskRecord {
    const deps = this.db
      .all<{ depends_on: string }>(`SELECT depends_on FROM task_dependencies WHERE task_id = ?`, [
        row.task_id,
      ])
      .map((d) => d.depends_on);
    return {
      taskId: row.task_id,
      runId: row.run_id,
      title: row.title,
      category: row.category,
      state: row.state,
      spec: JSON.parse(row.spec_json) as Record<string, unknown>,
      attemptCount: row.attempt_count,
      dependsOn: deps,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

const findCycle = (specs: readonly TaskSpec[]): string[] | null => {
  const edges = new Map(specs.map((s) => [s.key, (s.dependsOn ?? []).filter((d) => specs.some((x) => x.key === d))]));
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];

  const visit = (key: string): string[] | null => {
    const seen = state.get(key) ?? 0;
    if (seen === 1) return [...stack.slice(stack.indexOf(key)), key];
    if (seen === 2) return null;
    state.set(key, 1);
    stack.push(key);
    for (const next of edges.get(key) ?? []) {
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(key, 2);
    return null;
  };

  for (const spec of specs) {
    const cycle = visit(spec.key);
    if (cycle) return cycle;
  }
  return null;
};

interface RawTask {
  task_id: string;
  run_id: string;
  title: string;
  category: TaskCategory;
  state: TaskState;
  spec_json: string;
  attempt_count: number;
  created_at: string;
  updated_at: string;
}

interface RawExecution {
  execution_id: string;
  run_id: string;
  task_id: string;
  attempt: number;
  status: ExecutionRecord["status"];
  started_at: string;
  last_activity_at: string | null;
  ended_at: string | null;
  failure_class: FailureClass | null;
  result_digest: string | null;
  provider: string;
  model: string;
  worker_session_id: string | null;
  owner_binding_generation: number;
}

const hydrateExecution = (row: RawExecution): ExecutionRecord => ({
  executionId: row.execution_id,
  runId: row.run_id,
  taskId: row.task_id,
  attempt: row.attempt,
  status: row.status,
  startedAt: row.started_at,
  lastActivityAt: row.last_activity_at,
  endedAt: row.ended_at,
  failureClass: row.failure_class,
  resultDigest: row.result_digest,
  provider: row.provider,
  model: row.model,
  workerSessionId: row.worker_session_id,
  ownerBindingGeneration: row.owner_binding_generation,
});
