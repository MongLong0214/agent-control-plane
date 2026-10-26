import { isDaemonFinalizerCompletion, type CompletionAuthority } from './run-engine.ts';
import { parseRepoFactoryResult } from "../bootstrap/repo-factory-result.ts";
import type { Clock } from "../core/clock.ts";
import type {
  DynamicReserveDemand,
  WorkerFanoutCapacityTarget,
} from "../capacity/capacity-monitor.ts";
import { canonicalJson, digestOf } from "../core/digest.ts";
import { type Decision, allow, deny, fail, isAcpError } from "../core/errors.ts";
import { newTaskId } from "../core/ids.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { AuditLog } from "../db/audit.ts";
import type { Db } from "../db/database.ts";
import type { WorkScopeTracking } from "./work-scope-tracking.ts";
import {
  type FailureClass,
  Role,
  RunKind,
  RunState,
  type TaskCategory,
  type TaskClass,
  TaskState,
} from "../domain/types.ts";
import {
  BaselineRecordKind,
  isTaskClass,
  taskClassForCategory,
  type UsageEvidenceInput,
} from "../export/baseline-contract.ts";
import { BaselineRecorder } from "../export/baseline-recorder.ts";
import type { Telemetry } from "../telemetry/telemetry.ts";
import type { WorkerProcessAuthority } from "./worker-turn.ts";

export interface TaskSpec {
  /** Caller-chosen local key used to express dependencies within one submission. */
  key: string;
  title: string;
  category: TaskCategory;
  /** Stable baseline label; omitted values use the documented transparent category mapping. */
  taskClass?: TaskClass;
  taskClassConfidence?: number | null;
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
  /** The session that holds the active, task-scoped WORKER binding. */
  workerSessionId: string;
  workerProcessId?: number | null;
  provider: string;
  model: string;
  repositoryId?: string | null;
  worktreeId?: string | null;
  concurrencyWidth?: number | null;
  /** Provider-returned identity fields. Omit rather than copying requested values when unavailable. */
  observedProvider?: string | null;
  observedModel?: string | null;
  observedModelVersion?: string | null;
  providerSessionId?: string | null;
  reasoningEffort?: string | null;
  adapterVersion?: string | null;
  toolPolicyDigest?: string | null;
  contextPacketDigest?: string | null;
  /** Must match the immutable run harness when the caller knows it. */
  harnessDigest?: string | null;
  /**
   * #512 — the control plane launches and owns this execution (`task_worker_run`). Its receipts
   * are the runtime's; the CTO's task_receipt_submit may neither open nor close it.
   */
  runtimeManaged?: boolean;
}

/**
 * A worker receipt names its session. Provider and model are that session's: the receipt may omit
 * them, and a receipt that states either must state the session's own (#512).
 */
export type WorkerExecutionStart = Omit<ExecutionStart, "provider" | "model"> & {
  provider?: string | undefined;
  model?: string | undefined;
};

export interface ExecutionOutcome {
  status: "SUCCEEDED" | "FAILED" | "ABANDONED" | "TIMEOUT";
  resultDigest?: string | null;
  failureClass?: FailureClass | null;
  /** A final baseline label may refine the transparent proposal without erasing history. */
  finalTaskClass?: TaskClass;
  finalTaskClassConfidence?: number | null;
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
  workerSessionId: string;
  ownerBindingGeneration: number;
  /** #512 — launched and owned by the control plane rather than reported by the CTO. */
  runtimeManaged: boolean;
  workerProcessId: number | null;
  /** The OS start time the spawned process reported, never the database clock. */
  workerProcessStartedAt: string | null;
  /** When the recorded process was confirmed gone; null while it is outstanding (or none was recorded). */
  workerProcessReleasedAt: string | null;
  repositoryId: string | null;
  worktreeId: string | null;
}

/** The worker allocator must admit its exact lower-priority allocation before recording it. */
export interface WorkerCapacityGate {
  refreshForWorkerFanout(target?: WorkerFanoutCapacityTarget): Promise<Decision<void>>;
  workerReserveDemand(provider: string, role?: Role): DynamicReserveDemand;
  /**
   * Whether the provider's adapters, and so its capacity, are registered per role. Such a
   * provider is admitted only against a named role: provider-only admission refuses it.
   */
  hasRoleScoped(provider: string): boolean;
}

/**
 * CEO 1792120507 / 1792120860 — what settles a project-less PROJECT_BOOTSTRAP run's execution task:
 * the producer's stored REPO_FACTORY_RESULT and its create receipt, the activation result the CEO
 * CONFIRM's transaction wrote, bound to the run, its current PLAN, the create operation, the run's
 * current candidate and that one task (`TaskGraph.settleBootstrapExecutionTask`).
 */
export interface BootstrapTaskSettlement {
  runId: string;
  taskId: string;
  planDigest: string;
  /** The PLAN's repository-create operation, whose receipt settles the task. */
  operationId: string;
  candidateSnapshotDigest: string;
  repoFactoryResultDigest: string;
  activationResultDigest: string;
}

/** The audit kind binding a project-less bootstrap PLAN to the tasks its `plan_submit` created. */
export const BOOTSTRAP_PLAN_TASKS = "BOOTSTRAP_PLAN_TASKS";
/** The audit kind a re-plan writes when it cancels (or leaves) an earlier PLAN's tasks. */
export const BOOTSTRAP_TASKS_SUPERSEDED = "BOOTSTRAP_TASKS_SUPERSEDED";
/** The audit kind of the one settlement of a project-less bootstrap's execution task. */
export const BOOTSTRAP_TASK_SETTLED = "BOOTSTRAP_TASK_SETTLED";
/** The audit kind a STANDARD_WORK re-plan writes when it cancels the earlier tasks its PLAN names. */
export const STANDARD_WORK_TASKS_SUPERSEDED = "STANDARD_WORK_TASKS_SUPERSEDED";

/**
 * CEO msg_2b439e5a — the earlier tasks of the same STANDARD_WORK run a new PLAN names in
 * `supersedesTaskIds`, which `submit` cancels in the transaction that adds that PLAN's tasks.
 */
export interface TaskSupersession {
  /** The superseding PLAN's digest: each cancel is recorded as "superseded by PLAN <digest>". */
  planDigest: string;
  taskIds: readonly string[];
}

/** The `BOOTSTRAP_PLAN_TASKS` records of a run, as its `plan_submit`s wrote them. */
const bootstrapPlanTaskRecords = (db: Pick<Db, "all">, runId: string): Array<{ planDigest?: unknown; taskIds?: unknown }> =>
  db
    .all<{ evidence_json: string }>(`SELECT evidence_json FROM audit_events WHERE kind = ? AND run_id = ?`, [BOOTSTRAP_PLAN_TASKS, runId])
    .map((row) => JSON.parse(row.evidence_json) as { planDigest?: unknown; taskIds?: unknown });

/**
 * Review of run_7717 (F6) — whether a `BOOTSTRAP_PLAN_TASKS` record binds `taskId` to `planDigest`: the
 * task was created by that PLAN's `plan_submit`. Read from the store, with no legacy fallback; the review
 * prompt states the answer for its run, and CONFIRM's settlement requires it.
 */
export const bootstrapPlanTaskRecorded = (db: Pick<Db, "all">, runId: string, taskId: string, planDigest: string): boolean =>
  bootstrapPlanTaskRecords(db, runId).some((binding) =>
    binding.planDigest === planDigest && Array.isArray(binding.taskIds) && binding.taskIds.includes(taskId));

/**
 * Deliberately narrow binding port. TaskGraph can verify the worker that a receipt names,
 * but it receives neither the binding registry nor authority to mutate bindings.
 */
export interface WorkerExecutionBindingGate {
  hasLiveWorkerBinding(taskId: string, sessionId: string): boolean;
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
export const CLOSED_TO_NEW_TASKS: ReadonlySet<string> = new Set<string>([
  RunState.READY_FOR_CEO_REVIEW,
  RunState.CEO_APPROVED,
  RunState.MERGING,
  RunState.POST_MERGE_VERIFYING,
  RunState.BLOCKED_POST_MERGE,
  RunState.AWAITING_HUMAN,
  RunState.COMPLETED,
  RunState.FAILED,
  RunState.CANCELLED,
]);

export class TaskGraph {
  #capacity: WorkerCapacityGate | null = null;
  #workerBindings: WorkerExecutionBindingGate | null = null;
  #workScope: WorkScopeTracking | null = null;
  readonly #baseline: BaselineRecorder;

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly audit: AuditLog,
    private readonly telemetry: Telemetry,
  ) {
    this.#baseline = new BaselineRecorder(db, clock, audit);
  }

  /** Closed by the composition root after the capacity monitor exists. */
  attach(ports: { capacity?: WorkerCapacityGate; workerBindings?: WorkerExecutionBindingGate; workScope?: WorkScopeTracking }): void {
    if (ports.capacity) this.#capacity = ports.capacity;
    if (ports.workerBindings) this.#workerBindings = ports.workerBindings;
    if (ports.workScope) this.#workScope = ports.workScope;
  }

  /**
   * #1240 — a Repo Factory project's STANDARD_WORK task is admitted once its PLAN unit's GitHub link is
   * verified; the run's units not yet verified are synchronized and read back first.
   */
  ensureWorkScopeTracked(runId: string, taskId: string): Promise<Decision<unknown>> {
    return this.#workScope ? this.#workScope.ensure(runId, taskId) : Promise.resolve(allow(ReasonCode.OK, null));
  }

  /** #1240 — the work-unit tracking plan acceptance and CEO confirmation ask, when composed. */
  get workScope(): WorkScopeTracking | null {
    return this.#workScope;
  }

  /**
   * A graph may only be created or extended while the run is still doing work. Adding a
   * pending task to a run that has already produced a packet would make the packet's
   * completeness claim false after the fact (§34.3, CP-HI-08).
   */
  submit(runId: string, specs: readonly TaskSpec[], supersede?: TaskSupersession): Decision<TaskRecord[]> {
    if (specs.length === 0) {
      return deny(ReasonCode.INVALID_ARGUMENT, "task submission is empty", { runId });
    }

    const run = this.db.get<{ state: string; kind: string }>(`SELECT state, kind FROM runs WHERE run_id = ?`, [runId]);
    if (!run) return deny(ReasonCode.NOT_FOUND, "unknown run", { runId });
    if (CLOSED_TO_NEW_TASKS.has(run.state as RunState)) {
      return deny(
        ReasonCode.RUN_TRANSITION_ILLEGAL,
        `run is ${run.state}; its work is already sealed against new tasks`,
        { runId, state: run.state },
      );
    }
    if (supersede && run.kind !== RunKind.STANDARD_WORK) {
      return deny(ReasonCode.INVALID_ARGUMENT, "only a STANDARD_WORK PLAN names the earlier tasks it supersedes", {
        runId, refusal: "SUPERSEDES_TASKS_NOT_STANDARD_WORK", kind: run.kind,
      });
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
      // CEO msg_2b439e5a — a STANDARD_WORK PLAN's supersedesTaskIds is judged and applied here, under the
      // write lock `recordExecution` opens an execution under: a retry of an applied one changes nothing,
      // and any named task that may not be cancelled refuses the whole submission before anything is written.
      if (supersede) {
        const replayed = this.#supersessionReplay(runId, supersede, specs);
        if (replayed) return allow(ReasonCode.OK, replayed);
        const refused = this.#supersessionRefusal(runId, supersede);
        if (refused) return refused;
      }
      const named = new Set(supersede?.taskIds ?? []);
      for (const spec of specs) {
        for (const dep of spec.dependsOn ?? []) {
          const dependsOn = resolve(dep);
          if (dependsOn !== null && (named.has(dependsOn) || this.get(dependsOn)?.state === TaskState.CANCELLED)) {
            return deny(ReasonCode.TASK_DEPENDENCY_UNSATISFIED, `task '${spec.key}' depends on a cancelled task`, {
              runId, refusal: "LIVE_TASK_DEPENDS_ON_CANCELLED", task: spec.key, dependency: dep, dependsOn,
            });
          }
        }
      }
      for (const taskId of named) {
        const cancelled = this.db.run(
          `UPDATE tasks SET state = 'CANCELLED', updated_at = ? WHERE task_id = ? AND run_id = ? AND state IN ('PENDING', 'READY')`,
          [now, taskId, runId],
        );
        if (cancelled.changes !== 1) fail(ReasonCode.CONFLICT, "a superseded task changed while it was cancelled", { runId, taskId });
      }
      // CEO 1792120860 (3) — a project-less bootstrap's re-plan supersedes the earlier PLAN's tasks in
      // this same transaction: an unexecuted READY one is CANCELLED, anything else is left as it is.
      const bootstrapPlan = this.#projectlessBootstrapPlanDigest(runId);
      if (bootstrapPlan !== null) this.#supersedeEarlierBootstrapTasks(runId, bootstrapPlan, now);
      const idByKey = new Map<string, string>();
      for (const spec of specs) idByKey.set(spec.key, newTaskId());

      for (const spec of specs) {
        const taskId = idByKey.get(spec.key)!;
        const classification = this.#baseline.recordTaskClassification(runId, {
          taskId,
          classification: spec.taskClass ?? taskClassForCategory(spec.category),
          confidence: spec.taskClassConfidence ?? null,
          stage: "PROPOSED",
          source: "TASK_GRAPH",
          replacesPayloadDigest: null,
        });
        if (!classification.allowed) {
          fail(classification.reasonCode, classification.message, classification.evidence);
        }
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
      const graphBaseline = this.#baseline.record(
        runId,
        BaselineRecordKind.GRAPH_SNAPSHOT,
        this.graphSnapshot(runId),
      );
      if (!graphBaseline.allowed) {
        fail(graphBaseline.reasonCode, graphBaseline.message, graphBaseline.evidence);
      }

      this.audit.record({
        kind: "TASK_GRAPH_SUBMITTED",
        runId,
        evidence: {
          taskCount: created.length,
          dependencyCount: created.reduce((n, t) => n + t.dependsOn.length, 0),
        },
      });
      if (bootstrapPlan !== null) {
        this.audit.record({
          kind: BOOTSTRAP_PLAN_TASKS,
          runId,
          evidence: { planDigest: bootstrapPlan, taskIds: created.map((task) => task.taskId) },
        });
      }
      if (supersede) {
        this.audit.record({
          kind: STANDARD_WORK_TASKS_SUPERSEDED,
          runId,
          evidence: {
            planDigest: supersede.planDigest,
            reason: `superseded by PLAN ${supersede.planDigest}`,
            cancelled: [...named],
            taskIds: created.map((task) => task.taskId),
            tasksDigest: digestOf(specs),
          },
        });
      }
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
    return this.recordExecution(input, null);
  }

  /**
   * `admitted` is the worker identity capacity admitted, when this records a worker execution: it
   * is read again here, inside the transaction that records it, and the labels written are that
   * identity's, so what was admitted and what is recorded cannot differ.
   */
  private recordExecution(
    input: ExecutionStart,
    admitted: { provider: string; model: string } | null,
  ): Decision<ExecutionRecord> {
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
      // #1240 — every execution start ends here: none opens for a unit whose GitHub link is not recorded.
      const tracked = this.#workScope?.assertTracked(input.runId, input.taskId);
      if (tracked && !tracked.allowed) return tracked as Decision<ExecutionRecord>;
      const workerBinding = this.assertLiveWorkerBinding(input);
      if (!workerBinding.allowed) return workerBinding as Decision<ExecutionRecord>;
      if (admitted) {
        const identity = this.workerIdentity({ ...input, ...admitted });
        if (!identity.allowed) return identity as Decision<ExecutionRecord>;
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
      const pinnedHarness = this.#baseline.harness(input.runId);
      if (
        input.harnessDigest != null &&
        pinnedHarness != null &&
        input.harnessDigest !== pinnedHarness.digest
      ) {
        return deny(ReasonCode.CONFLICT, "execution harness differs from the run's immutable harness", {
          runId: input.runId,
          executionId,
          pinnedHarnessDigest: pinnedHarness.digest,
          suppliedHarnessDigest: input.harnessDigest,
        });
      }
      const session = this.db.get<{
        incarnation: string;
        effort: string | null;
      }>(`SELECT incarnation, effort FROM sessions WHERE session_id = ?`, [input.workerSessionId]);
      const workerBindingIdentity = this.db.get<{ binding_generation: number }>(
        `SELECT binding_generation FROM assignments
          WHERE role = 'WORKER' AND task_id = ? AND session_id = ? AND status = 'ACTIVE'`,
        [input.taskId, input.workerSessionId],
      );
      const contract = this.db.get<{ contract_digest: string }>(
        `SELECT contract_digest FROM runs WHERE run_id = ?`,
        [input.runId],
      );
      const contextPacketDigest = input.contextPacketDigest ?? digestOf({
        schema: "agent-control-plane.task-invocation-packet.v1",
        runId: input.runId,
        taskId: input.taskId,
        taskSpecDigest: digestOf(task.spec),
        dependencyTaskIds: [...task.dependsOn].sort(),
        contractDigest: contract?.contract_digest ?? null,
      });
      const observedProvider = input.observedProvider ?? null;
      const observedModel = input.observedModel ?? null;
      const suppliedHarnessDigest = input.harnessDigest ?? null;
      const harnessMatches = pinnedHarness !== null && suppliedHarnessDigest === pinnedHarness.digest;
      const invocationBaseline = this.#baseline.recordInvocationStarted(input.runId, {
        executionId,
        taskId: input.taskId,
        logicalRole: "WORKER",
        provider: input.provider,
        requestedModel: input.model,
        observedProvider,
        observedModel,
        observedModelVersion: input.observedModelVersion ?? null,
        reasoningEffort: input.reasoningEffort ?? session?.effort ?? null,
        sessionId: input.workerSessionId,
        sessionIncarnation: session?.incarnation ?? null,
        providerSessionId: input.providerSessionId ?? null,
        workerBindingGeneration: workerBindingIdentity?.binding_generation ?? null,
        ownerBindingGeneration: input.ownerBindingGeneration,
        // Do not inherit the run pin when the invocation did not supply an attestation.
        // An omitted digest is an unknown/mixed-harness fact, not proof of compatibility.
        harnessDigest: suppliedHarnessDigest,
        adapterVersion: input.adapterVersion ?? null,
        toolPolicyDigest: input.toolPolicyDigest ?? null,
        contextPacketDigest,
        startedAt: now,
        providerDriftObserved: observedProvider === null ? null : observedProvider !== input.provider,
        modelDriftObserved: observedModel === null ? null : observedModel !== input.model,
        qualificationEligible:
          harnessMatches &&
          observedModel !== null &&
          observedModel === input.model &&
          (observedProvider === null || observedProvider === input.provider),
      });
      if (!invocationBaseline.allowed) return invocationBaseline as Decision<ExecutionRecord>;

      this.db.run(
        `INSERT INTO task_executions (execution_id, run_id, task_id, attempt, owner_binding_generation,
                                      worker_session_id, worker_process_id, provider, model,
                                      repository_id, worktree_id, concurrency_width, started_at, status,
                                      runtime_managed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'RUNNING', ?)`,
        [
          executionId, input.runId, input.taskId, attempt, input.ownerBindingGeneration,
          input.workerSessionId, input.workerProcessId ?? null, input.provider, input.model,
          input.repositoryId ?? null, input.worktreeId ?? null, input.concurrencyWidth ?? null, now,
          input.runtimeManaged === true ? 1 : 0,
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
          runtimeManaged: input.runtimeManaged === true,
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
  async startWorkerExecution(
    input: WorkerExecutionStart,
    /**
     * #1070 ACP-WORKER-03 — asked once more after the capacity probe, before the execution is opened:
     * a caller whose admission was withdrawn while the probe ran (a daemon that began to stop) opens none.
     */
    stillAdmitting: () => boolean = () => true,
  ): Promise<Decision<ExecutionRecord>> {
    // Do not ask capacity to allocate a worker whose durable identity is already invalid.
    // `startExecution` repeats this check inside its transaction after the async probe.
    const workerBinding = this.assertLiveWorkerBinding(input);
    if (!workerBinding.allowed) return workerBinding as Decision<ExecutionRecord>;
    // #512 — capacity is admitted for the provider and model the bound session runs, never for
    // ones the receipt names: a receipt could otherwise spend another provider's quota, or none
    // that was probed, on this worker.
    const identity = this.workerIdentity(input);
    if (!identity.allowed) return identity as Decision<ExecutionRecord>;
    // #1240 — before capacity is asked for it: the unit's GitHub link is recorded, or synchronized now.
    const tracked = await this.ensureWorkScopeTracked(input.runId, input.taskId);
    if (!tracked.allowed) return tracked as Decision<ExecutionRecord>;
    const capacity = await this.admitWorkerFanout(identity.value.provider, identity.value.model, {
      runId: input.runId,
      taskId: input.taskId,
    });
    if (!capacity.allowed) return capacity as Decision<ExecutionRecord>;
    if (!stillAdmitting()) {
      return deny(ReasonCode.CONFLICT, "the admission was withdrawn before the execution was opened", { runId: input.runId, taskId: input.taskId });
    }
    return this.recordExecution({ ...input, ...identity.value }, identity.value);
  }

  /**
   * The provider and model a worker execution is admitted and recorded under: the bound worker
   * session's own. A receipt that states either must state the session's.
   */
  private workerIdentity(
    input: Pick<WorkerExecutionStart, "runId" | "taskId" | "workerSessionId" | "provider" | "model">,
  ): Decision<{ provider: string; model: string }> {
    const session = this.db.get<{ provider: string; model: string }>(
      `SELECT provider, model FROM sessions WHERE session_id = ?`,
      [input.workerSessionId],
    );
    if (!session) {
      return deny(ReasonCode.WORKER_BINDING_REQUIRED, "worker execution names an unknown session", {
        runId: input.runId,
        taskId: input.taskId,
        workerSessionId: input.workerSessionId,
      });
    }
    if (
      (input.provider !== undefined && input.provider !== session.provider) ||
      (input.model !== undefined && input.model !== session.model)
    ) {
      return deny(ReasonCode.CONFLICT, "the receipt names a provider or model its worker session does not run", {
        runId: input.runId,
        taskId: input.taskId,
        workerSessionId: input.workerSessionId,
        provider: input.provider ?? null,
        model: input.model ?? null,
        sessionProvider: session.provider,
        sessionModel: session.model,
      });
    }
    return allow(ReasonCode.OK, { provider: session.provider, model: session.model });
  }

  /**
   * §14.2/§14.5 — the one worker fan-out admission, shared by execution start and by worker
   * provisioning (`worker-staffing.ts`), so both ask capacity the same question.
   *
   * A provider whose adapters are registered per role (Claude, under the deployment's ambient
   * OAuth identity) is admitted as `Role.WORKER`: the fresh reading is that role binding's own
   * probe, and the reserve demand carries the binding it was measured for. Provider-only
   * admission refuses such a provider outright, which is what left every Claude worker
   * unroutable. Naming the role does not relax anything: an unknown, stale or unreadable reading
   * still refuses as `CAPACITY_UNKNOWN_NOT_ROUTABLE`, and the dynamic reserve still applies.
   */
  async admitWorkerFanout(
    provider: string,
    model: string,
    evidence: Record<string, unknown> = {},
  ): Promise<Decision<void>> {
    if (!this.#capacity) {
      return deny(
        ReasonCode.CAPACITY_UNKNOWN_NOT_ROUTABLE,
        "worker execution has no attached capacity admission gate",
        { ...evidence, provider },
      );
    }
    const role = this.#capacity.hasRoleScoped(provider) ? Role.WORKER : undefined;
    const target: WorkerFanoutCapacityTarget = {
      provider,
      ...(role === undefined ? {} : { role }),
      capabilities: [this.workerCapability(model)],
      priority: "worker",
      // The monitor reads durable role/running-work facts. Passing the complete demand on
      // this production path makes worker priority explicit instead of caller-optional.
      reserveDemand: this.#capacity.workerReserveDemand(provider, role),
    };
    return this.#capacity.refreshForWorkerFanout(target);
  }

  finishExecution(
    executionId: string,
    outcome: ExecutionOutcome,
    /** When given, the execution must belong to this run (§25.2). */
    expectedRunId?: string,
  ): Decision<ExecutionRecord> {
    const preflight = this.db.tx(() => {
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
        //
        // #664 — this audit write is the only forensic record of a late/superseded result
        // and must survive the denial right below it (the same shape as github-kernel.ts's
        // claim-expiry sweep), which is why this preflight stays on plain `tx()` instead of
        // being folded into the `txDecision()` below.
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
      return allow(ReasonCode.OK, undefined);
    });
    if (!preflight.allowed) return preflight as Decision<ExecutionRecord>;

    // #664 — recordInvocationFinished below writes and commits, and recordTaskClassification
    // right after it is an independent call that can still deny; a denial there must not
    // leave the invocation-finished baseline record behind, so this body's own decision has
    // to roll both back. `finishExecution` is fully synchronous — there is no `await`
    // between the preflight above and this transaction — so nothing else in this process can
    // run in the gap, and the ownership the preflight just confirmed cannot have changed
    // underneath this second transaction.
    return this.db.txDecision(() => {
      const execution = this.execution(executionId)!;
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
      const durationMs = new Date(now).getTime() - new Date(execution.startedAt).getTime();
      const invocationBaseline = this.#baseline.recordInvocationFinished(execution.runId, {
        executionId,
        endedAt: now,
        durationMs: Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : null,
        outcome: outcome.status,
        failureClass: outcome.failureClass ?? null,
        resultDigest: outcome.resultDigest ?? null,
      });
      if (!invocationBaseline.allowed) return invocationBaseline as Decision<ExecutionRecord>;
      const task = this.get(execution.taskId);
      if (!task) return deny(ReasonCode.NOT_FOUND, "execution's task is missing", { executionId });
      const priorClassification = this.#baseline
        .records(execution.runId)
        .filter(
          (record) =>
            record.kind === BaselineRecordKind.TASK_CLASSIFICATION &&
            record.payload["taskId"] === execution.taskId,
        )
        .at(-1);
      const classificationBaseline = this.#baseline.recordTaskClassification(execution.runId, {
        taskId: execution.taskId,
        classification:
          outcome.finalTaskClass ??
          (isTaskClass(priorClassification?.payload["classification"])
            ? priorClassification.payload["classification"]
            : taskClassForCategory(task.category)),
        confidence:
          outcome.finalTaskClassConfidence ??
          (typeof priorClassification?.payload["confidence"] === "number"
            ? priorClassification.payload["confidence"]
            : null),
        stage: "FINAL",
        source: "TASK_GRAPH",
        replacesPayloadDigest: priorClassification?.payloadDigest ?? null,
      });
      if (!classificationBaseline.allowed) return classificationBaseline as Decision<ExecutionRecord>;
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

  /**
   * #512 — the process a runtime-managed execution spawned, as the process itself reported it.
   *
   * Written once, while the execution is still RUNNING, so a restart can find the worker and tell
   * it apart from a later process that reuses its pid. `startedAt` is the OS start time read from
   * the process; a null one is recorded as unknown, which a restart treats as unidentifiable.
   *
   * #1070 — only under the record authority the worker runner mints in its own invocation's spawn
   * report. The database refuses the write otherwise, and for any execution, pid or start time other
   * than the ones the authority names, so no other writer can point a restart's kill at a process.
   */
  recordWorkerProcess(
    executionId: string,
    pid: number,
    startedAt: string | null,
    authority: WorkerProcessAuthority,
  ): Decision<void> {
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      return deny(ReasonCode.INVALID_ARGUMENT, "a worker process id must be a positive integer", { executionId, pid });
    }
    let written: number;
    try {
      written = this.db.withWorkerProcessRecord(authority, () => this.db.run(
        `UPDATE task_executions SET worker_process_id = ?, worker_process_started_at = ?
          WHERE execution_id = ? AND status = 'RUNNING' AND runtime_managed = 1 AND worker_process_id IS NULL`,
        [pid, startedAt, executionId],
      ).changes);
    } catch (error) {
      if (isAcpError(error)) return deny(error.reasonCode, error.message, { executionId, pid });
      throw error;
    }
    if (written !== 1) {
      return deny(ReasonCode.CONFLICT, "only a running runtime-managed execution records its process, once", {
        executionId,
        pid,
      });
    }
    return allow(ReasonCode.OK, undefined);
  }

  /**
   * #512 — the recorded worker process was confirmed gone. Written once, whatever the execution's
   * status is by then: the process and the receipt end at different moments.
   *
   * #1070 — only under the release authority the worker runner mints when it has confirmed that exact
   * process gone. The database refuses the write otherwise, and refuses it for any execution, pid or
   * start time other than the ones the authority names.
   */
  releaseWorkerProcess(executionId: string, authority: WorkerProcessAuthority): Decision<void> {
    let released: number;
    try {
      released = this.db.withWorkerProcessRelease(authority, () => this.db.run(
        `UPDATE task_executions SET worker_process_released_at = ?
          WHERE execution_id = ? AND worker_process_id IS NOT NULL AND worker_process_released_at IS NULL`,
        [this.clock.nowIso(), executionId],
      ).changes);
    } catch (error) {
      if (isAcpError(error)) return deny(error.reasonCode, error.message, { executionId });
      throw error;
    }
    if (released !== 1) {
      return deny(ReasonCode.CONFLICT, "only an outstanding worker process is released, once", { executionId });
    }
    return allow(ReasonCode.OK, undefined);
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

  /**
   * V1-BR-02 recording boundary. Runtime adapters may report provider, CLI, quota, or
   * estimated usage here; missing information is explicitly `UNAVAILABLE`, never zeroed.
   */
  recordUsage(input: UsageEvidenceInput): Decision<void> {
    if (input.executionId) {
      const execution = this.execution(input.executionId);
      if (!execution) return deny(ReasonCode.NOT_FOUND, "unknown execution", { executionId: input.executionId });
      if (execution.runId !== input.runId) {
        return deny(ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE, "usage receipt belongs to another run", {
          executionId: input.executionId,
          executionRunId: execution.runId,
          requestedRunId: input.runId,
        });
      }
    }
    const recorded = this.#baseline.recordUsage(input);
    if (!recorded.allowed) return recorded as Decision<void>;
    this.telemetry.record({
      scope: "run",
      name: "usage_evidence",
      runId: input.runId,
      text: input.source,
      dims: { executionId: input.executionId ?? null, confidence: input.confidence ?? null },
    });
    return allow(ReasonCode.OK, undefined);
  }

  /** Structural graph facts only — no scheduling or topology-selection policy is applied. */
  private graphSnapshot(runId: string): Record<string, unknown> {
    const tasks = this.db.all<{ task_id: string }>(
      `SELECT task_id FROM tasks WHERE run_id = ? ORDER BY task_id`,
      [runId],
    );
    const dependencies = this.db.all<{ task_id: string; depends_on: string }>(
      `SELECT d.task_id, d.depends_on
         FROM task_dependencies d JOIN tasks t ON t.task_id = d.task_id
        WHERE t.run_id = ? ORDER BY d.task_id, d.depends_on`,
      [runId],
    );
    const parents = new Map(tasks.map((task) => [task.task_id, [] as string[]]));
    const children = new Map(tasks.map((task) => [task.task_id, [] as string[]]));
    for (const dependency of dependencies) {
      parents.get(dependency.task_id)?.push(dependency.depends_on);
      children.get(dependency.depends_on)?.push(dependency.task_id);
    }
    const depthMemo = new Map<string, number>();
    const depth = (taskId: string): number => {
      const known = depthMemo.get(taskId);
      if (known !== undefined) return known;
      const value = 1 + Math.max(0, ...(parents.get(taskId) ?? []).map(depth));
      depthMemo.set(taskId, value);
      return value;
    };
    const indegree = new Map(tasks.map((task) => [task.task_id, (parents.get(task.task_id) ?? []).length]));
    let frontier = tasks
      .map((task) => task.task_id)
      .filter((taskId) => indegree.get(taskId) === 0)
      .sort();
    let maxStructuralReadyWidth = frontier.length;
    while (frontier.length > 0) {
      const next = new Set<string>();
      for (const taskId of frontier) {
        for (const child of children.get(taskId) ?? []) {
          const remaining = (indegree.get(child) ?? 0) - 1;
          indegree.set(child, remaining);
          if (remaining === 0) next.add(child);
        }
      }
      frontier = [...next].sort();
      maxStructuralReadyWidth = Math.max(maxStructuralReadyWidth, frontier.length);
    }
    const planRevisionCount = this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM run_artifacts WHERE run_id = ? AND kind = 'PLAN'`,
      [runId],
    )?.n ?? 0;
    const priorGraphRevisions = this.#baseline
      .records(runId)
      .filter((record) => record.kind === BaselineRecordKind.GRAPH_SNAPSHOT).length;
    return {
      nodeCount: tasks.length,
      edgeCount: dependencies.length,
      graphDepth: tasks.length === 0 ? 0 : Math.max(...tasks.map((task) => depth(task.task_id))),
      maxStructuralReadyWidth,
      planRevisionCount,
      graphRevisionCount: priorGraphRevisions + 1,
      serializedVsParallelDecision:
        maxStructuralReadyWidth > 1 ? "PARALLEL_ELIGIBLE" : "SERIALIZED_BY_DEPENDENCIES",
      claimConflictCount: null,
    };
  }

  /** Luna has its own disposable-capacity bucket; all other worker models use worker. */
  private workerCapability(model: string): "worker" | "luna-worker" {
    return /luna/i.test(model) ? "luna-worker" : "worker";
  }

  /** CP-HI-04 — every receipt names the session currently bound as this task's worker. */
  private assertLiveWorkerBinding(
    input: Pick<ExecutionStart, "runId" | "taskId" | "workerSessionId">,
  ): Decision<void> {
    if (this.#workerBindings?.hasLiveWorkerBinding(input.taskId, input.workerSessionId)) {
      return allow(ReasonCode.OK, undefined);
    }
    return deny(
      ReasonCode.WORKER_BINDING_REQUIRED,
      "worker execution requires the live WORKER binding for its task",
      {
        runId: input.runId,
        taskId: input.taskId,
        workerSessionId: input.workerSessionId,
      },
    );
  }

  /**
   * §34.3 — synthesis and completion are blocked unless every task reached a terminal
   * state and every started execution produced a receipt.
   */
  /** Administrative activation has no worker execution: the finalizer owns its settlement. */
  administrativeContractChange(runId: string): boolean {
    const run = this.db.get<{ kind: string }>(`SELECT kind FROM runs WHERE run_id = ?`, [runId]);
    if (run?.kind !== "CONTRACT_CHANGE") return false;
    const row = this.db.get<{ content_json: string }>(`SELECT content_json FROM run_artifacts WHERE run_id = ? AND kind = 'PLAN' AND superseded = 0 ORDER BY created_at DESC, rowid DESC LIMIT 1`, [runId]);
    const plan = row ? JSON.parse(row.content_json) as Record<string, unknown> : null;
    const tasks = this.list(runId).filter(t => t.state !== TaskState.CANCELLED);
    return tasks.length === 1 && (plan?.["repositoryContentChange"] === false || tasks.every(t => t.spec["repositoryContentChange"] === false)) &&
      !this.db.get(`SELECT 1 FROM run_repositories WHERE run_id = ? LIMIT 1`, [runId]);
  }

  administrativeReviewEntry(runId: string): Decision<unknown> {
    if (!this.administrativeContractChange(runId)) return this.completeness(runId);
    const tasks = this.list(runId).filter(t => t.state !== TaskState.CANCELLED);
    if (tasks.some(t => t.state !== TaskState.READY) || this.db.get(`SELECT 1 FROM task_executions WHERE run_id = ? LIMIT 1`, [runId])) {
      return deny(ReasonCode.TASK_RESULT_COUNT_MISMATCH, "administrative activation requires one unexecuted READY task", { runId });
    }
    return allow(ReasonCode.OK, { administrativeActivation: true });
  }

  settleAdministrativeActivation(runId: string, completion?: CompletionAuthority): Decision<unknown> {
    const entry = this.administrativeReviewEntry(runId);
    if (!entry.allowed) return entry;
    if (!this.administrativeContractChange(runId)) return entry;
    if (!this.db.inTransaction || !isDaemonFinalizerCompletion(completion)) return deny(ReasonCode.COMPLETION_AUTHORITY_DENIED,"only the daemon finalizer settles administrative activation inside its activation transaction",{runId});
    this.db.run(`UPDATE tasks SET state = 'SUCCEEDED', updated_at = ? WHERE run_id = ? AND state = 'READY'`, [this.clock.nowIso(), runId]);
    this.audit.record({ kind: "CONTRACT_CHANGE_ACTIVATION_TASK_SETTLED", runId, evidence: { authority: "daemon-finalizer" } });
    return allow(ReasonCode.OK, { settled: true });
  }

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

  /**
   * CEO 1792120507 / 1792120860 — a project-less PROJECT_BOOTSTRAP run's review entry, which takes
   * the place of `completeness` for that run kind only (the result pipeline and the packet ask it).
   * Its task is the external create: nothing may execute or claim it before the owner's approval and
   * the CEO's CONFIRM, which settles it from the producer's create receipt. So review entry needs no
   * task success, and refuses, with the refusal named, what a fake completion leaves behind: any task
   * execution, or a task already SUCCEEDED. Neither is deleted or corrected. The run must then hold
   * exactly one live task, READY and bound to `planDigest`, the run's current PLAN: that is the task
   * one create receipt settles. A CANCELLED task is ignored and is never completion evidence.
   */
  bootstrapReviewEntry(runId: string, planDigest: string): Decision<{ taskId: string }> {
    const refuse = (reasonCode: ReasonCode, refusal: string, message: string, evidence: Record<string, unknown> = {}) =>
      deny(reasonCode, message, { runId, refusal, planDigest, ...evidence }) as Decision<{ taskId: string }>;
    const executed = this.db
      .all<{ task_id: string }>(`SELECT DISTINCT task_id FROM task_executions WHERE run_id = ? ORDER BY task_id`, [runId])
      .map((row) => row.task_id);
    if (executed.length > 0) {
      return refuse(
        ReasonCode.COMPLETION_AUTHORITY_DENIED,
        "BOOTSTRAP_TASK_HAS_EXECUTION",
        "a project-less bootstrap's task is settled only from its create receipt at CEO CONFIRM; this run carries a task execution, which is left as found",
        { taskIds: executed },
      );
    }
    const tasks = this.list(runId);
    const succeeded = tasks.filter((task) => task.state === TaskState.SUCCEEDED).map((task) => task.taskId);
    if (succeeded.length > 0) {
      return refuse(
        ReasonCode.COMPLETION_AUTHORITY_DENIED,
        "BOOTSTRAP_TASK_SUCCEEDED_BEFORE_CONFIRM",
        "a project-less bootstrap's task is settled only from its create receipt at CEO CONFIRM; this run carries a task already SUCCEEDED, which is left as found",
        { taskIds: succeeded },
      );
    }
    const live = tasks.filter((task) => task.state !== TaskState.CANCELLED);
    if (live.length !== 1 || live[0]!.state !== TaskState.READY) {
      return refuse(
        ReasonCode.TASK_RESULT_COUNT_MISMATCH,
        "BOOTSTRAP_PLAN_TASK_COUNT",
        "a project-less bootstrap reaches CEO review with exactly one READY task, the one its repository-create receipt settles at CONFIRM",
        { tasks: live.map((task) => ({ taskId: task.taskId, state: task.state })) },
      );
    }
    const task = live[0]!;
    if (!this.#boundToBootstrapPlan(runId, task.taskId, planDigest, live.length)) {
      return refuse(
        ReasonCode.TASK_RESULT_COUNT_MISMATCH,
        "BOOTSTRAP_TASK_NOT_OF_CURRENT_PLAN",
        "the run's READY task was not created with its current PLAN; submit the PLAN again so its task is",
        { taskId: task.taskId },
      );
    }
    return allow(ReasonCode.OK, { taskId: task.taskId });
  }

  /**
   * CEO 1792120507 / 1792120860 — the one write that settles a project-less PROJECT_BOOTSTRAP run's
   * execution task. It needs no worker: it moves the task READY → SUCCEEDED on the evidence the
   * CONFIRM transaction holds, and records both digests and every binding it checked. Refused unless
   * all of these hold, each with its refusal named:
   *
   * - it runs inside a transaction, the run is a project-less PROJECT_BOOTSTRAP still at CEO review,
   *   and both digests are named;
   * - the run's stored BOOTSTRAP_ACTIVATION_RESULT is the one named, for this run and a CEO CONFIRM.
   *   Only the finalizer inside the CONFIRM transaction writes it, and it commits only with the run's
   *   COMPLETED, so this is the CONFIRM transaction's path;
   * - `planDigest` is the run's current PLAN, `operationId` its first operation and a repository
   *   create, and `candidateSnapshotDigest` the run's current candidate;
   * - the run's stored REPO_FACTORY_RESULT is the one named, for this run and this PLAN, and carries a
   *   verified create receipt for that operation and resource;
   * - the task is this run's, READY, and the one `bootstrapReviewEntry` answers for this PLAN (no
   *   execution anywhere in the run, nothing SUCCEEDED, exactly one live task, bound to this PLAN);
   * - a `BOOTSTRAP_PLAN_TASKS` record binds the task to this PLAN: unlike review entry, no legacy
   *   singleton is settled;
   * - no task of the run was settled before: one create receipt settles one task.
   */
  settleBootstrapExecutionTask(input: BootstrapTaskSettlement): Decision<TaskRecord> {
    const refuse = (reasonCode: ReasonCode, refusal: string, message: string, evidence: Record<string, unknown> = {}) =>
      deny(reasonCode, message, { runId: input.runId, taskId: input.taskId, refusal, ...evidence }) as Decision<TaskRecord>;
    if (!this.db.inTransaction) {
      return refuse(ReasonCode.COMPLETION_AUTHORITY_DENIED, "OUTSIDE_CONFIRM_TRANSACTION", "a bootstrap task is settled only inside the CEO CONFIRM transaction");
    }
    const run = this.db.get<{ kind: string; project_id: string | null; state: string; current_candidate_digest: string | null }>(
      `SELECT kind, project_id, state, current_candidate_digest FROM runs WHERE run_id = ?`,
      [input.runId],
    );
    if (!run || run.kind !== RunKind.PROJECT_BOOTSTRAP || run.project_id !== null) {
      return refuse(ReasonCode.COMPLETION_AUTHORITY_DENIED, "RUN_NOT_PROJECTLESS_BOOTSTRAP", "only a project-less PROJECT_BOOTSTRAP run's task is settled this way");
    }
    if (run.state !== RunState.READY_FOR_CEO_REVIEW) {
      return refuse(ReasonCode.RUN_TRANSITION_ILLEGAL, "RUN_NOT_AT_CONFIRM", `run is ${run.state}; a bootstrap task is settled only by the CONFIRM of a run at CEO review`);
    }
    if (!input.repoFactoryResultDigest || !input.activationResultDigest) {
      return refuse(ReasonCode.EVIDENCE_MISSING, "SETTLEMENT_EVIDENCE_MISSING", "settlement names both the producer's result and the activation result");
    }
    const activation = this.#latestArtifact(input.runId, "BOOTSTRAP_ACTIVATION_RESULT");
    const activated = activation?.content as { runId?: unknown; ceoConfirm?: { decision?: unknown } } | undefined;
    if (
      activation === null ||
      activation.digest !== input.activationResultDigest ||
      activated?.runId !== input.runId ||
      activated.ceoConfirm?.decision !== "CONFIRM"
    ) {
      return refuse(ReasonCode.EVIDENCE_STALE, "ACTIVATION_RESULT_NOT_BOUND", "the named activation result is not this run's CONFIRM activation", {
        named: input.activationResultDigest,
        stored: activation?.digest ?? null,
      });
    }
    const plan = this.#latestArtifact(input.runId, "PLAN");
    if (plan === null || plan.digest !== input.planDigest) {
      return refuse(ReasonCode.EVIDENCE_STALE, "PLAN_NOT_CURRENT", "the named PLAN is not the run's current PLAN", {
        named: input.planDigest,
        current: plan?.digest ?? null,
      });
    }
    if (run.current_candidate_digest !== input.candidateSnapshotDigest) {
      return refuse(ReasonCode.EVIDENCE_STALE, "CANDIDATE_NOT_CURRENT", "the named candidate is not the run's current candidate", {
        named: input.candidateSnapshotDigest,
        current: run.current_candidate_digest,
      });
    }
    const operations = (plan.content as { githubOperations?: unknown } | null)?.githubOperations;
    const create = Array.isArray(operations) ? (operations[0] as { operationId?: unknown; resourceType?: unknown; resourceIdentity?: unknown } | undefined) : undefined;
    const factory = this.#latestArtifact(input.runId, "REPO_FACTORY_RESULT");
    const parsed = factory === null ? null : parseRepoFactoryResult(factory.content);
    const receipt = parsed?.allowed
      ? parsed.value.externalWriteReceipts.find((row) =>
          row.operationId === input.operationId &&
          row.resourceType === "repository" &&
          row.resourceIdentity === create?.resourceIdentity &&
          row.verified)
      : undefined;
    if (
      create?.operationId !== input.operationId ||
      create.resourceType !== "repository" ||
      factory === null ||
      factory.digest !== input.repoFactoryResultDigest ||
      !parsed?.allowed ||
      parsed.value.runId !== input.runId ||
      parsed.value.planDigest !== input.planDigest ||
      receipt === undefined
    ) {
      return refuse(ReasonCode.EVIDENCE_STALE, "CREATE_RECEIPT_NOT_BOUND", "the named producer result carries no verified create receipt of this run's PLAN for this operation", {
        operationId: input.operationId,
        named: input.repoFactoryResultDigest,
        stored: factory?.digest ?? null,
      });
    }
    const task = this.get(input.taskId);
    if (task === null || task.runId !== input.runId || task.state !== TaskState.READY) {
      return refuse(ReasonCode.CONFLICT, "TASK_NOT_READY", "only a READY task of this run is settled", { state: task?.state ?? null });
    }
    const entry = this.bootstrapReviewEntry(input.runId, input.planDigest);
    if (!entry.allowed) return entry as Decision<TaskRecord>;
    if (entry.value.taskId !== input.taskId) {
      return refuse(ReasonCode.TASK_RESULT_COUNT_MISMATCH, "BOOTSTRAP_TASK_NOT_OF_CURRENT_PLAN", "the named task is not the current PLAN's task", {
        currentTaskId: entry.value.taskId,
      });
    }
    // Review of run_7717 (F6) — review entry admits a legacy singleton with no record; settlement does
    // not: a create receipt settles only a task the current PLAN's `plan_submit` is recorded to have created.
    if (!bootstrapPlanTaskRecorded(this.db, input.runId, input.taskId, input.planDigest)) {
      return refuse(
        ReasonCode.TASK_RESULT_COUNT_MISMATCH,
        "BOOTSTRAP_TASK_PLAN_UNRECORDED",
        "no BOOTSTRAP_PLAN_TASKS record binds this task to the current PLAN; settlement admits no legacy task, so submit the PLAN again to create its task",
        { planDigest: input.planDigest },
      );
    }
    const earlier = this.db.get<{ n: number }>(`SELECT 1 AS n FROM audit_events WHERE kind = ? AND run_id = ? LIMIT 1`, [
      BOOTSTRAP_TASK_SETTLED,
      input.runId,
    ]);
    if (earlier) return refuse(ReasonCode.CONFLICT, "RECEIPT_ALREADY_SETTLED", "this run's create receipt already settled a task");
    const updated = this.db.run(`UPDATE tasks SET state = 'SUCCEEDED', updated_at = ? WHERE task_id = ? AND state = 'READY'`, [
      this.clock.nowIso(),
      input.taskId,
    ]);
    if (updated.changes !== 1) return refuse(ReasonCode.CONFLICT, "TASK_NOT_READY", "the task moved while it was being settled");
    this.audit.record({
      kind: BOOTSTRAP_TASK_SETTLED,
      runId: input.runId,
      evidence: {
        taskId: input.taskId,
        planDigest: input.planDigest,
        operationId: input.operationId,
        repoFactoryResultDigest: input.repoFactoryResultDigest,
        createReceiptDigest: digestOf(receipt),
        activationResultDigest: input.activationResultDigest,
        candidateSnapshotDigest: input.candidateSnapshotDigest,
      },
    });
    return allow(ReasonCode.OK, this.require(input.taskId));
  }

  /** The run's current PLAN digest when it is a project-less PROJECT_BOOTSTRAP with a PLAN; else null. */
  #projectlessBootstrapPlanDigest(runId: string): string | null {
    const run = this.db.get<{ kind: string; project_id: string | null }>(`SELECT kind, project_id FROM runs WHERE run_id = ?`, [runId]);
    if (!run || run.kind !== RunKind.PROJECT_BOOTSTRAP || run.project_id !== null) return null;
    return this.#latestArtifact(runId, "PLAN")?.digest ?? null;
  }

  /** The run's latest current artifact of `kind`, read as `ArtifactStore.latest` reads it. */
  #latestArtifact(runId: string, kind: string): { digest: string; content: unknown } | null {
    const row = this.db.get<{ digest: string; content_json: string }>(
      `SELECT digest, content_json FROM run_artifacts WHERE run_id = ? AND kind = ? AND superseded = 0
        ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      [runId, kind],
    );
    return row ? { digest: row.digest, content: JSON.parse(row.content_json) as unknown } : null;
  }

  /**
   * Whether `taskId` was created with `planDigest`, by the `BOOTSTRAP_PLAN_TASKS` record its
   * `plan_submit` wrote. A run with no such record at all was planned before they were written; its
   * task counts as its current PLAN's only while it is the run's one live task.
   */
  #boundToBootstrapPlan(runId: string, taskId: string, planDigest: string, liveTasks: number): boolean {
    const bindings = bootstrapPlanTaskRecords(this.db, runId);
    if (bindings.length === 0) return liveTasks === 1;
    return bootstrapPlanTaskRecorded(this.db, runId, taskId, planDigest);
  }

  /**
   * CEO 1792120860 (3) — what a project-less bootstrap's new PLAN supersedes, in `submit`'s transaction
   * before its tasks are inserted: each earlier task that is PENDING or READY with no execution is
   * CANCELLED, "superseded by PLAN <digest>" (PR #1114 BOOT-01: a PENDING one too, or it blocks the new
   * PLAN for good). A task with an execution, or in any other state, is never simply cancelled: it is
   * left as it is and named with why, and review entry then refuses the run for it.
   */
  #supersedeEarlierBootstrapTasks(runId: string, planDigest: string, now: string): void {
    const earlier = this.list(runId).filter((task) => task.state !== TaskState.CANCELLED);
    if (earlier.length === 0) return;
    const executed = new Set(
      this.db.all<{ task_id: string }>(`SELECT DISTINCT task_id FROM task_executions WHERE run_id = ?`, [runId]).map((row) => row.task_id),
    );
    const cancelled: string[] = [];
    const left: Array<{ taskId: string; reason: string }> = [];
    for (const task of earlier) {
      if (executed.has(task.taskId)) {
        left.push({ taskId: task.taskId, reason: "has an execution; never cancelled by a re-plan" });
      } else if (task.state !== TaskState.READY && task.state !== TaskState.PENDING) {
        left.push({ taskId: task.taskId, reason: `${task.state}; a re-plan cancels only an unexecuted PENDING or READY task` });
      } else {
        cancelled.push(task.taskId);
      }
    }
    for (const taskId of cancelled) {
      this.db.run(`UPDATE tasks SET state = 'CANCELLED', updated_at = ? WHERE task_id = ? AND state IN ('PENDING', 'READY')`, [now, taskId]);
    }
    this.audit.record({
      kind: BOOTSTRAP_TASKS_SUPERSEDED,
      runId,
      evidence: { planDigest, reason: `superseded by PLAN ${planDigest}`, cancelled, left },
    });
  }

  /**
   * CEO msg_2b439e5a (2, 4) — why `supersede` may not cancel what it names, or null. Each named task
   * must be this run's, PENDING or READY, and never have had an execution; no task of the run that
   * stays live may depend on one. Read inside `submit`'s transaction: `recordExecution` opens an
   * execution only for a READY or FAILED task under the same write lock, so an execution start and
   * this cancel cannot both win.
   */
  #supersessionRefusal(runId: string, supersede: TaskSupersession): Decision<TaskRecord[]> | null {
    const refuse = (reasonCode: ReasonCode, refusal: string, message: string, evidence: Record<string, unknown>) =>
      deny(reasonCode, message, { runId, refusal, planDigest: supersede.planDigest, ...evidence }) as Decision<TaskRecord[]>;
    const named = new Set(supersede.taskIds);
    if (named.size !== supersede.taskIds.length) {
      return refuse(ReasonCode.INVALID_ARGUMENT, "SUPERSEDED_TASK_DUPLICATE", "supersedesTaskIds names a task more than once", {
        supersedesTaskIds: supersede.taskIds,
      });
    }
    for (const taskId of named) {
      const task = this.get(taskId);
      if (!task) return refuse(ReasonCode.NOT_FOUND, "SUPERSEDED_TASK_UNKNOWN", "a superseded task is unknown", { taskId });
      if (task.runId !== runId) {
        return refuse(ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE, "SUPERSEDED_TASK_OUTSIDE_RUN", "a superseded task belongs to another run", {
          taskId, taskRunId: task.runId,
        });
      }
      const executed = this.db.get<{ n: number }>(`SELECT 1 AS n FROM task_executions WHERE task_id = ? LIMIT 1`, [taskId]);
      if (executed || task.attemptCount > 0) {
        return refuse(ReasonCode.CONFLICT, "SUPERSEDED_TASK_HAS_EXECUTION", "a superseded task has an execution; it is never cancelled by a re-plan", {
          taskId, state: task.state, attemptCount: task.attemptCount,
        });
      }
      if (task.state !== TaskState.PENDING && task.state !== TaskState.READY) {
        return refuse(ReasonCode.CONFLICT, "SUPERSEDED_TASK_NOT_CANCELLABLE", `a superseded task is ${task.state}; only a PENDING or READY task is cancelled`, {
          taskId, state: task.state,
        });
      }
    }
    for (const task of this.list(runId)) {
      if (task.state === TaskState.CANCELLED || named.has(task.taskId)) continue;
      const dependsOn = task.dependsOn.find((dep) => named.has(dep));
      if (dependsOn !== undefined) {
        return refuse(ReasonCode.TASK_DEPENDENCY_UNSATISFIED, "LIVE_TASK_DEPENDS_ON_CANCELLED", "a task that stays live depends on a superseded task", {
          taskId: task.taskId, dependsOn,
        });
      }
    }
    return null;
  }

  /**
   * CEO msg_2b439e5a (3) — a retried superseding submission: the same PLAN naming the same tasks with
   * the same graph, whose `STANDARD_WORK_TASKS_SUPERSEDED` record is written and whose named tasks are
   * all CANCELLED. Its tasks are answered again and nothing is written; null when it is not one.
   */
  #supersessionReplay(runId: string, supersede: TaskSupersession, specs: readonly TaskSpec[]): TaskRecord[] | null {
    const names = canonicalJson([...supersede.taskIds].sort());
    const tasksDigest = digestOf(specs);
    for (const row of this.db.all<{ evidence_json: string }>(
      `SELECT evidence_json FROM audit_events WHERE kind = ? AND run_id = ? ORDER BY event_id`,
      [STANDARD_WORK_TASKS_SUPERSEDED, runId],
    )) {
      const record = JSON.parse(row.evidence_json) as { planDigest?: unknown; cancelled?: unknown; taskIds?: unknown; tasksDigest?: unknown };
      if (record.planDigest !== supersede.planDigest || record.tasksDigest !== tasksDigest) continue;
      if (!Array.isArray(record.cancelled) || canonicalJson([...(record.cancelled as string[])].sort()) !== names) continue;
      if (!supersede.taskIds.every((taskId) => this.get(taskId)?.state === TaskState.CANCELLED)) continue;
      return (record.taskIds as string[]).map((taskId) => this.require(taskId));
    }
    return null;
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
  worker_session_id: string;
  owner_binding_generation: number;
  runtime_managed: number;
  worker_process_id: number | null;
  worker_process_started_at: string | null;
  worker_process_released_at: string | null;
  repository_id: string | null;
  worktree_id: string | null;
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
  runtimeManaged: row.runtime_managed === 1,
  workerProcessId: row.worker_process_id,
  workerProcessStartedAt: row.worker_process_started_at,
  workerProcessReleasedAt: row.worker_process_released_at,
  repositoryId: row.repository_id,
  worktreeId: row.worktree_id,
});
