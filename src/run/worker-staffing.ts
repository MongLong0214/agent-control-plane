import type { Clock } from "../core/clock.ts";
import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { containedWorkdir, probeSessionHealth } from "../cto/cto-lifecycle.ts";
import type { AuditLog } from "../db/audit.ts";
import type { Db } from "../db/database.ts";
import { FIXED_ROLE_RUNTIME } from "../domain/fixed-role-runtime.ts";
import { Role, type RoleBinding, RunState, SessionLifecycle, TaskState, roleKeyFor } from "../domain/types.ts";
import type { ProviderAdapter, ProviderRegistry, SessionHandle } from "../runtime/provider.ts";
import type { BindingRegistry } from "../session/binding-registry.ts";
import type { SessionRegistry } from "../session/session-registry.ts";
import type { RunEngine } from "./run-engine.ts";
import type { TaskGraph } from "./task-graph.ts";

/**
 * The one provider a worker may be staffed on, and the model it runs.
 *
 * Fixed rather than chosen per call: implementation work runs on Claude Opus, and GPT does no
 * code work. The caller still names the provider — nothing is substituted for a provider it did
 * not ask for — and a provider or model outside this table is refused rather than mapped to one
 * inside it. The model is not the adapter's `defaultModels.worker`, which for Claude is Sonnet.
 */
export const WORKER_MODEL_BY_PROVIDER: Readonly<Record<string, string>> = Object.freeze({
  // The one table continuity reads too (#246), so a failover cannot pick a runtime staffing refuses.
  [FIXED_ROLE_RUNTIME[Role.WORKER]!.provider]: FIXED_ROLE_RUNTIME[Role.WORKER]!.model,
});

/** The run owner the caller authenticated as, re-derived from durable state on every call. */
export type WorkerOwnerFence = () => Decision<{ sessionId: string; bindingGeneration: number }>;

export interface WorkerProvisionRequest {
  runId: string;
  taskId: string;
  provider: string;
  model?: string | undefined;
  /** The owner generation the caller's fence admitted, before this request was made. */
  ownerBindingGeneration: number;
  /**
   * The caller's run-owner check. Asked again after the capacity await and inside the
   * transaction that binds, where it must still admit `ownerBindingGeneration`: the awaits in
   * between can let a takeover or a switch land.
   */
  fence: WorkerOwnerFence;
}

export interface WorkerProvisioned {
  workerSessionId: string;
  generation: number;
}

export interface WorkerStaffingPorts {
  readonly runs: Pick<RunEngine, "get">;
  readonly tasks: Pick<TaskGraph, "get" | "admitWorkerFanout">;
  readonly bindings: Pick<BindingRegistry, "active" | "history" | "bind">;
  readonly sessions: Pick<SessionRegistry, "createWithPinnedStart" | "transition" | "get">;
  readonly providers: Pick<ProviderRegistry, "requireForRole">;
  /** §9.5 step 3 — the doctor's readiness gate, the same one a fresh CTO passes. */
  readonly readiness: { checkSession(sessionId: string): Promise<Decision<void>> };
}

/**
 * PRD §8.3/§14.4 — the CTO routes workers; §8.6 — the control plane owns admission, lifecycle and
 * credentials. This is the production path that mints a task's first `WORKER` binding (#512).
 *
 * It mints generation 1 only. A task whose WORKER role has any assignment history is refused:
 * an active one as `BINDING_ALREADY_ACTIVE`, a revoked or continuity-owed one as
 * `BINDING_REVOKED`, because replacing a worker belongs to continuity or a claim, not to a second
 * provisioning.
 *
 * The worker is its own session, never the CTO's: `BindingRegistry.bind` refuses a WORKER on a
 * session holding another role (`WORKER_SESSION_NOT_INDEPENDENT`), and this path only ever binds
 * a session it has just constituted. A worker never connects to an MCP socket, so no launch
 * credential is provisioned and no Buzz route is opened for it.
 *
 * Every refusal after the provider session exists stops that session, so a refused provisioning
 * leaves no READY session behind.
 */
export class WorkerStaffing {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly audit: AuditLog,
    private readonly ports: WorkerStaffingPorts,
    private readonly managedRuntimeRoot: string,
  ) {}

  async provision(request: WorkerProvisionRequest): Promise<Decision<WorkerProvisioned>> {
    const model = resolveWorkerModel(request.provider, request.model);
    if (!model.allowed) return model as Decision<WorkerProvisioned>;
    const roleKey = roleKeyFor(Role.WORKER, { taskId: request.taskId });

    const unstaffed = this.#unstaffed(request, roleKey);
    if (!unstaffed.allowed) return unstaffed as Decision<WorkerProvisioned>;

    let adapter: ProviderAdapter;
    try {
      adapter = this.ports.providers.requireForRole(request.provider, Role.WORKER);
    } catch (error) {
      return deny(ReasonCode.CAPACITY_UNKNOWN_NOT_ROUTABLE, "no adapter is registered for the worker provider", {
        provider: request.provider,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (!adapter.isProduction) {
      return deny(ReasonCode.CAPACITY_UNKNOWN_NOT_ROUTABLE, "a non-production adapter cannot staff a worker", {
        provider: request.provider,
      });
    }

    // §14.2 — the fan-out refresh, through the same admission execution start uses.
    const admitted = await this.ports.tasks.admitWorkerFanout(request.provider, model.value, {
      runId: request.runId,
      taskId: request.taskId,
    });
    if (!admitted.allowed) return admitted as Decision<WorkerProvisioned>;

    // The admission awaited a probe. Nothing has been spawned yet, so a run, task, owner or role
    // that moved meanwhile is refused here at no cost; the bind transaction asks again.
    const stillOwner = this.#sameOwner(request);
    if (!stillOwner.allowed) return stillOwner as Decision<WorkerProvisioned>;
    const stillUnstaffed = this.#unstaffed(request, roleKey);
    if (!stillUnstaffed.allowed) return stillUnstaffed as Decision<WorkerProvisioned>;

    let handle: SessionHandle;
    try {
      handle = await adapter.startSession({
        model: model.value,
        effort: null,
        workdir: this.managedRuntimeRoot,
        purpose: `worker:${request.taskId}`,
      });
    } catch (error) {
      return deny(ReasonCode.SESSION_NOT_READY, "provider refused to create a worker session", {
        provider: request.provider,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    let sessionId: string;
    try {
      // Native start pinned beside the lstart, as CTO launch and continuity record theirs.
      sessionId = this.ports.sessions.createWithPinnedStart({
        provider: adapter.provider,
        model: model.value,
        effort: null,
        sessionId: `ses_wkr_${handle.externalSessionId.replace(/-/g, "").slice(0, 20)}`,
        incarnation: `${handle.externalSessionId}#${this.clock.nowIso()}`,
        osPid: handle.pid,
        workdir: containedWorkdir(handle.workdir, this.managedRuntimeRoot),
      }).sessionId;
    } catch (error) {
      await adapter.stopSession(handle).catch(() => undefined);
      throw error;
    }

    let bound: Decision<RoleBinding>;
    try {
      // A started session is not a reachable one: only an authenticated answer about this
      // handle may turn it READY.
      const live = await probeSessionHealth(adapter, handle);
      if (!live.allowed) {
        await this.#discard(adapter, handle, sessionId, "provider worker session probe failed");
        return live as Decision<WorkerProvisioned>;
      }
      const ready = this.ports.sessions.transition(sessionId, SessionLifecycle.READY, "provider worker session verified");
      if (!ready.allowed) {
        await this.#discard(adapter, handle, sessionId, "worker session could not become READY");
        return ready as Decision<WorkerProvisioned>;
      }
      const checked = await this.ports.readiness.checkSession(sessionId);
      if (!checked.allowed) {
        await this.#discard(adapter, handle, sessionId, "worker session readiness failed");
        return checked as Decision<WorkerProvisioned>;
      }

      bound = this.db.txDecision(() => {
        const fenced = this.#sameOwner(request);
        if (!fenced.allowed) return fenced as Decision<RoleBinding>;
        const scope = this.#unstaffed(request, roleKey);
        if (!scope.allowed) return scope as Decision<RoleBinding>;
        // `run_id` is recorded on the WORKER row: the managed write guard reads it.
        return this.ports.bindings.bind({
          role: Role.WORKER,
          sessionId,
          taskId: request.taskId,
          runId: request.runId,
          projectId: scope.value.projectId,
        });
      });
    } catch (error) {
      await this.#discard(adapter, handle, sessionId, "worker provisioning failed");
      throw error;
    }
    if (!bound.allowed) {
      await this.#discard(adapter, handle, sessionId, `worker binding refused: ${bound.reasonCode}`);
      return bound as Decision<WorkerProvisioned>;
    }
    return allow(ReasonCode.OK, { workerSessionId: sessionId, generation: bound.value.bindingGeneration });
  }

  /** The caller's fence still admits it, at the owner generation the request was made under. */
  #sameOwner(request: WorkerProvisionRequest): Decision<void> {
    const fenced = request.fence();
    if (!fenced.allowed) return fenced as Decision<void>;
    if (fenced.value.bindingGeneration !== request.ownerBindingGeneration) {
      return deny(ReasonCode.BINDING_GENERATION_STALE, "the run owner's binding changed while the worker was provisioned", {
        runId: request.runId,
        expected: request.ownerBindingGeneration,
        current: fenced.value.bindingGeneration,
      });
    }
    return allow(ReasonCode.OK, undefined);
  }

  /**
   * The run is ACTIVE, the task is one of its tasks and READY, and the task's WORKER role has
   * never been held. Asked before the capacity probe, after it, and inside the bind.
   */
  #unstaffed(request: WorkerProvisionRequest, roleKey: string): Decision<{ projectId: string | null }> {
    const run = this.ports.runs.get(request.runId);
    if (!run) return deny(ReasonCode.NOT_FOUND, "unknown run", { runId: request.runId });
    if (run.state !== RunState.ACTIVE) {
      return deny(ReasonCode.RUN_TRANSITION_ILLEGAL, `run is ${run.state}; a worker is staffed only for an ACTIVE run`, {
        runId: request.runId,
        state: run.state,
      });
    }
    const task = this.ports.tasks.get(request.taskId);
    if (!task) return deny(ReasonCode.NOT_FOUND, "unknown task", { taskId: request.taskId });
    if (task.runId !== request.runId) {
      return deny(ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE, "task belongs to another run", {
        taskId: request.taskId,
        taskRunId: task.runId,
        requestedRunId: request.runId,
      });
    }
    if (task.state !== TaskState.READY) {
      return deny(ReasonCode.TASK_DEPENDENCY_UNSATISFIED, `task is ${task.state}; a worker is staffed only for a READY task`, {
        taskId: request.taskId,
        state: task.state,
      });
    }
    if (this.ports.bindings.active(roleKey)) {
      return deny(ReasonCode.BINDING_ALREADY_ACTIVE, "the task already has an active worker binding", { roleKey });
    }
    const history = this.ports.bindings.history(roleKey);
    if (history.length > 0) {
      return deny(
        ReasonCode.BINDING_REVOKED,
        "the task's worker role was held before; its replacement belongs to continuity or a claim",
        { roleKey, generation: history[history.length - 1]!.bindingGeneration },
      );
    }
    return allow(ReasonCode.OK, { projectId: run.projectId });
  }

  /** Stops a session this path constituted and did not bind, through the provider's own handle. */
  async #discard(adapter: ProviderAdapter, handle: SessionHandle, sessionId: string, reason: string): Promise<void> {
    try {
      await adapter.stopSession(handle);
    } catch (error) {
      if (this.ports.sessions.get(sessionId)?.lifecycle !== SessionLifecycle.ERROR) {
        this.ports.sessions.transition(sessionId, SessionLifecycle.ERROR, `${reason}: provider stop failed`);
      }
      this.audit.record({
        kind: "WORKER_UNUSED_SESSION_STOP_FAILED",
        reasonCode: ReasonCode.SESSION_STOP_FAILED,
        sessionId,
        evidence: { reason, error: error instanceof Error ? error.message : String(error) },
      });
      return;
    }
    this.ports.sessions.transition(sessionId, SessionLifecycle.STOPPED, reason);
  }
}

/** The worker model for a provider: the fixed one, or a refusal. Never a substitute. */
const resolveWorkerModel = (provider: string, requested: string | undefined): Decision<string> => {
  const fixed = WORKER_MODEL_BY_PROVIDER[provider];
  if (fixed === undefined) {
    return deny(ReasonCode.INVALID_ARGUMENT, "this provider is not staffed for worker implementation", {
      provider,
      allowed: Object.keys(WORKER_MODEL_BY_PROVIDER),
    });
  }
  if (requested !== undefined && requested !== fixed) {
    return deny(ReasonCode.INVALID_ARGUMENT, "the worker model is fixed for this provider", {
      provider,
      model: requested,
      required: fixed,
    });
  }
  return allow(ReasonCode.OK, fixed);
};
