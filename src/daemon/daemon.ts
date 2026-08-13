import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type { ControlPlane } from "../app/control-plane.ts";
import type { RequiredRole, RoleCoveragePlan } from "../continuity/continuity-kernel.ts";
import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode, type ReasonCode as ReasonCodeValue } from "../core/reason-codes.ts";
import { RunState, SessionLifecycle } from "../domain/types.ts";
import type { BuzzAdapter } from "../buzz/buzz-adapter.ts";
import { SingleInstanceLock } from "./single-instance.ts";

export interface DaemonOptions {
  stateDir: string;
  watchdogIntervalMs?: number;
  deliveryIntervalMs?: number;
  /** Keeps the daemon-owned structured capacity sensors inside their freshness window. */
  capacityRefreshIntervalMs?: number;
  buzz?: BuzzAdapter;
  /** Consecutive start failures before the supervisor should back off harder. */
  crashLoopThreshold?: number;
}

export interface ReconcileReport {
  activeBindings: number;
  resumedRuns: string[];
  expiredClaims: number;
  expiredMessages: number;
  orphanedExecutions: string[];
  sessionsMarkedError: string[];
  doctorStatus: string;
}

/**
 * The result of reconciling a fresh coverage plan with the bindings that actually own
 * roles. A plan alone is diagnostic; these are the durable effects that make it real.
 */
export interface ContinuityReconcileReport {
  plan: RoleCoveragePlan;
  reassigned: Array<{
    roleKey: string;
    fromGeneration: number;
    toGeneration: number;
    provider: string;
  }>;
  pausedRuns: Array<{ runId: string; roleKey: string; reasonCode: string }>;
  unresolved: Array<{ roleKey: string; reasonCode: string }>;
  restored: string[];
  restorationDeferred: Array<{ roleKey: string; reasonCode: string }>;
}

interface CrashLoopFile {
  failures: number;
  firstAt: string;
  retryNotBefore?: string;
}

interface TimerFailure {
  consecutiveFailures: number;
  lastError: string;
  retryNotBefore: string;
}

/**
 * PRD §33.1 and §34.5.
 *
 * The single-instance lock is taken before any state is touched, and restart
 * reconciliation is deterministic: reload bindings, runs, outbox and claims; reconcile
 * sessions against real processes; expire stale leases; run a scoped doctor; resume
 * dispatch idempotently. Because dispatch is keyed by
 * `run-dispatch:<runId>:<generation>`, resuming cannot produce a duplicate (CP-S58).
 */
export class Daemon {
  readonly lock: SingleInstanceLock;
  #timers: NodeJS.Timeout[] = [];
  #startedAt: string | null = null;
  #timerFailures = new Map<string, TimerFailure>();
  #continuityCoordinatorInstalled = false;
  #continuityReconciling = false;

  constructor(
    private readonly cp: ControlPlane,
    private readonly options: DaemonOptions,
  ) {
    mkdirSync(options.stateDir, { recursive: true });
    chmodSync(options.stateDir, 0o700);
    this.lock = new SingleInstanceLock(join(options.stateDir, "agentcpd.lock"));
  }

  async start(): Promise<Decision<ReconcileReport>> {
    const startedAt = this.cp.clock.nowIso();
    const acquired = this.lock.acquire(startedAt);
    if (!acquired.allowed) {
      this.recordLockContention(acquired.evidence);
      return acquired as Decision<ReconcileReport>;
    }
    this.#startedAt = startedAt;

    const priorFailures = this.readCrashLoop();
    if (priorFailures.retryNotBefore && Date.parse(priorFailures.retryNotBefore) > Date.parse(startedAt)) {
      this.lock.release();
      this.#startedAt = null;
      const backoffSeconds = Math.ceil(
        (Date.parse(priorFailures.retryNotBefore) - Date.parse(startedAt)) / 1000,
      );
      this.cp.audit.record({
        kind: "DAEMON_START_REFUSED",
        reasonCode: ReasonCode.DAEMON_BACKOFF_ACTIVE,
        evidence: { failures: priorFailures.failures, retryNotBefore: priorFailures.retryNotBefore, backoffSeconds },
      });
      return deny(ReasonCode.DAEMON_BACKOFF_ACTIVE, "startup backoff is still active", {
        failures: priorFailures.failures,
        retryNotBefore: priorFailures.retryNotBefore,
        backoffSeconds,
      });
    }

    try {
      this.installContinuityCoordinator();
      await this.refreshCapacitySensors();
      const report = await this.reconcile();
      this.writeHealth(report);

      if (report.doctorStatus === "BLOCKED" || report.doctorStatus === "ERROR") {
        const reasonCode =
          report.doctorStatus === "BLOCKED" ? ReasonCode.DOCTOR_BLOCKED : ReasonCode.DOCTOR_ERROR;
        this.recordStartupFailure(reasonCode, { reconcile: report });
        this.uninstallContinuityCoordinator();
        this.lock.release();
        this.#startedAt = null;
        return deny(reasonCode, "startup doctor did not permit dispatch resume", { reconcile: report });
      }

      report.resumedRuns = await this.resumeQueuedRuns();
      this.writeHealth(report);
      this.startTimers();
      this.clearCrashLoop();

      this.cp.audit.record({
        kind: "DAEMON_STARTED",
        evidence: { pid: process.pid, startedAt, reconcile: report },
      });
      return allow(ReasonCode.OK, report);
    } catch (err) {
      const evidence = { error: safeErrorMessage(err) };
      this.recordStartupFailure(ReasonCode.DAEMON_STARTUP_FAILED, evidence);
      this.uninstallContinuityCoordinator();
      this.lock.release();
      this.#startedAt = null;
      return deny(ReasonCode.DAEMON_STARTUP_FAILED, "daemon startup failed", evidence);
    }
  }

  /** §34.5 — the documented restart sequence, in order. */
  async reconcile(): Promise<ReconcileReport> {
    const expiredClaims = this.cp.claims.expireOverdue();
    const expiredMessages = this.cp.outbox.expireOverdue();

    // Reconcile sessions against real processes before anything trusts a binding.
    const sessionsMarkedError: string[] = [];
    for (const session of this.cp.sessions.live()) {
      if (session.osPid && !isAlive(session.osPid)) {
        this.cp.sessions.transition(session.sessionId, SessionLifecycle.ERROR, "process gone after restart");
        sessionsMarkedError.push(session.sessionId);
      }
    }

    // A receipt that says RUNNING across a restart has no live worker behind it.
    const orphanedExecutions: string[] = [];
    for (const row of this.cp.db.all<{ execution_id: string; worker_process_id: number | null }>(
      `SELECT execution_id, worker_process_id FROM task_executions WHERE status = 'RUNNING'`,
    )) {
      if (row.worker_process_id == null || !isAlive(row.worker_process_id)) {
        this.cp.tasks.finishExecution(row.execution_id, {
          status: "ABANDONED",
          failureClass: "infrastructure",
        });
        orphanedExecutions.push(row.execution_id);
      }
    }

    const activeBindings = this.cp.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM assignments WHERE status = 'ACTIVE'`,
    );

    const report = await this.cp.doctor.run("system");

    return {
      activeBindings: activeBindings?.n ?? 0,
      resumedRuns: [],
      expiredClaims,
      expiredMessages,
      orphanedExecutions,
      sessionsMarkedError,
      doctorStatus: report.status,
    };
  }

  /**
   * P0-06 / PRD §15.7. The daemon owns the only automatic reconciliation entry point:
   * after a provider failure has persisted a fresh capacity observation, compare each
   * required role's active binding with the planned provider and drive the kernel's
   * existing atomic failover only where the old binding is no longer covered.
   *
   * `failover()` itself refreshes the selected provider immediately before it allocates.
   * That refresh is also provider-failure evidence, so the capacity callback can re-enter
   * here while the original reconciliation awaits it. Re-entry intentionally returns
   * without waiting: awaiting the outer reconciliation would deadlock the admission it is
   * currently performing. The outer pass observes the fresh facts before it completes.
   */
  async reconcileContinuity(reason: string): Promise<ContinuityReconcileReport | null> {
    if (this.#continuityReconciling) return null;
    this.#continuityReconciling = true;
    try {
      const plan = await this.cp.continuity.evaluate(`daemon continuity reconciliation: ${reason}`);
      const reassigned: ContinuityReconcileReport["reassigned"] = [];
      const pausedRuns: ContinuityReconcileReport["pausedRuns"] = [];
      const unresolved: ContinuityReconcileReport["unresolved"] = [];

      for (const required of plan.requiredRoles) {
        const current = this.cp.bindings.active(required.roleKey);
        // An unbound role is deliberately not auto-created here. In particular, a fresh
        // CEO needs the one-time possession-proven bootstrap path; continuity is allowed
        // to replace an existing authority, not forge generation 1 for an absent one.
        if (!current) continue;

        const assignment = plan.assignments.find((candidate) => candidate.roleKey === required.roleKey);
        const session = this.cp.sessions.get(current.sessionId);
        const currentCapacity = session ? this.cp.capacity.current(session.provider) : null;
        const currentStillCovered =
          session?.lifecycle === SessionLifecycle.READY &&
          currentCapacity !== null &&
          this.cp.capacity.isRoutableFor(currentCapacity, required.capability);
        // A new plan may prefer a recovered provider over an already healthy fallback.
        // That is restoration, not failure, and §15.8 keeps the acting owner in place
        // until the explicit non-preemptive restore path can safely move it.
        if (currentStillCovered) continue;

        if (!assignment?.provider) {
          unresolved.push({
            roleKey: required.roleKey,
            reasonCode: plan.outcome === "NO_VALID_COVERAGE" ? ReasonCode.COVERAGE_NONE : ReasonCode.COVERAGE_PARTIAL,
          });
          pausedRuns.push(...this.pauseAffectedRuns(required, "coverage plan cannot staff the bound role"));
          this.revokePausedBinding(required, "coverage plan cannot staff the bound role");
          continue;
        }

        const failedOver = await this.cp.continuity.failover(
          required.roleKey,
          required.role,
          {
            projectId: required.projectId,
            runId: required.runId,
            taskId: required.taskId,
          },
          reason,
        );
        if (!failedOver.allowed) {
          unresolved.push({ roleKey: required.roleKey, reasonCode: failedOver.reasonCode });
          pausedRuns.push(...this.pauseAffectedRuns(required, `failover refused: ${failedOver.reasonCode}`));
          this.revokePausedBinding(required, `continuity failover refused: ${failedOver.reasonCode}`);
          continue;
        }

        const active = this.cp.bindings.active(required.roleKey);
        const replacement = active ? this.cp.sessions.get(active.sessionId) : null;
        // `failover` promises an atomic switch, but verify the exact durable endpoint
        // before reporting success. A route that was only planned is never coverage.
        if (
          !active ||
          !replacement ||
          replacement.lifecycle !== SessionLifecycle.READY ||
          replacement.provider !== failedOver.value.provider ||
          active.bindingGeneration !== failedOver.value.generation
        ) {
          unresolved.push({ roleKey: required.roleKey, reasonCode: ReasonCode.SESSION_NOT_READY });
          pausedRuns.push(...this.pauseAffectedRuns(required, "failover did not leave a ready planned binding"));
          this.revokePausedBinding(required, "continuity failover did not leave a ready planned binding");
          continue;
        }
        reassigned.push({
          roleKey: required.roleKey,
          fromGeneration: current.bindingGeneration,
          toGeneration: active.bindingGeneration,
          provider: replacement.provider,
        });
      }

      // A recovered preferred provider may receive new work again, but must not seize an
      // acting owner. The kernel's restore path has the role-specific no-preemption
      // barriers; invoke it only after the failure pass achieved full durable coverage.
      const restorationNeeded = plan.assignments.some((assignment) =>
        assignment.reason === "preferred" && this.cp.bindings.active(assignment.roleKey)?.mode === "FALLBACK",
      );
      const restoration = restorationNeeded && unresolved.length === 0
        ? await this.cp.continuity.restore()
        : { restored: [], deferred: [] };

      this.cp.audit.record({
        kind: "CONTINUITY_RECONCILED",
        reasonCode:
          unresolved.length > 0
            ? plan.outcome === "NO_VALID_COVERAGE"
              ? ReasonCode.COVERAGE_NONE
              : ReasonCode.COVERAGE_PARTIAL
            : ReasonCode.OK,
        evidence: {
          reason,
          outcome: plan.outcome,
          action: plan.action,
          mode: plan.mode,
          reassigned,
          pausedRuns,
          unresolved,
          restoration,
        },
      });
      return {
        plan,
        reassigned,
        pausedRuns,
        unresolved,
        restored: restoration.restored,
        restorationDeferred: restoration.deferred,
      };
    } finally {
      this.#continuityReconciling = false;
    }
  }

  private async resumeQueuedRuns(): Promise<string[]> {
    const resumedRuns: string[] = [];
    // The doctor has already passed. Idempotency lives in the outbox key, so a run
    // already dispatched under this generation is not dispatched twice.
    for (const run of this.cp.runs.list({ state: RunState.QUEUED })) {
      const dispatched = await this.cp.runs.dispatch(run.runId);
      if (dispatched.allowed) resumedRuns.push(run.runId);
    }
    return resumedRuns;
  }

  /**
   * A partial plan may not leave work running under an uncovered generation. The state
   * machine has an explicit pause for active work and an explicit human wait for a
   * candidate already awaiting CEO review; queued work has not acquired the dead role.
   */
  private pauseAffectedRuns(required: RequiredRole, reason: string): ContinuityReconcileReport["pausedRuns"] {
    const affected = required.role === "CEO"
      ? this.cp.runs.list()
      : required.runId
        ? [this.cp.runs.get(required.runId)].filter((run): run is NonNullable<typeof run> => Boolean(run))
        : required.projectId
          ? this.cp.runs.list({ projectId: required.projectId })
          : [];
    const paused: ContinuityReconcileReport["pausedRuns"] = [];
    for (const run of affected) {
      if (run.state === RunState.ACTIVE) {
        const blocked = this.cp.runs.transition(run.runId, RunState.BLOCKED, reason, {
          roleKey: required.roleKey,
          continuityAction: "PAUSE_NEW_WORK",
        });
        if (blocked.allowed) {
          paused.push({ runId: run.runId, roleKey: required.roleKey, reasonCode: ReasonCode.COVERAGE_INCOMPLETE });
        }
      } else if (run.state === RunState.READY_FOR_CEO_REVIEW) {
        const waiting = this.cp.runs.transition(run.runId, RunState.AWAITING_HUMAN, reason, {
          roleKey: required.roleKey,
          continuityAction: "PAUSE_NEW_WORK",
        });
        if (waiting.allowed) {
          paused.push({ runId: run.runId, roleKey: required.roleKey, reasonCode: ReasonCode.COVERAGE_INCOMPLETE });
        }
      }
    }
    return paused;
  }

  /**
   * Once affected work is paused, revoke the dead endpoint so an old generation cannot
   * resume it through a late message. BindingRegistry fences queued/in-flight outbox rows
   * in the same transaction; blocked runs are the documented revocation exception.
   */
  private revokePausedBinding(required: RequiredRole, reason: string): void {
    const current = this.cp.bindings.active(required.roleKey);
    if (!current) return;
    const revoked = this.cp.bindings.revoke(required.roleKey, reason, { allowBlockedRuns: true });
    if (!revoked.allowed) {
      this.cp.audit.record({
        kind: "CONTINUITY_REVOKE_DEFERRED",
        roleKey: required.roleKey,
        sessionId: current.sessionId,
        reasonCode: revoked.reasonCode,
        evidence: { reason },
      });
    }
  }

  private startTimers(): void {
    const watchdogMs = this.options.watchdogIntervalMs ?? 60_000;
    const deliveryMs = this.options.deliveryIntervalMs ?? 5_000;
    // The monitor's default freshness window is five minutes. Polling just inside that
    // boundary keeps the local sensor current without turning it into a per-minute dashboard.
    const capacityRefreshMs = this.options.capacityRefreshIntervalMs ?? 4 * 60_000;

    const watchdog = setInterval(() => {
      void this.runPeriodic("watchdog", async () => {
        const tick = await this.cp.watchdog.tick();
        if (tick.overdue.length > 0) this.writeHealth(null);
      });
    }, watchdogMs);
    watchdog.unref();
    this.#timers.push(watchdog);

    const capacitySensor = setInterval(() => {
      void this.runPeriodic("capacity_sensor", async () => {
        await this.refreshCapacitySensors();
        await this.reconcileContinuity("periodic capacity sensor refresh");
      });
    }, capacityRefreshMs);
    capacitySensor.unref();
    this.#timers.push(capacitySensor);

    if (this.options.buzz) {
      const delivery = setInterval(() => {
        void this.runPeriodic("buzz_delivery", async () => {
          const result = await this.options.buzz!.deliverPending();
          if (result.failed.length > 0) {
            throw new Error(`delivery failed for ${result.failed.length} outbox message(s)`);
          }
        });
      }, deliveryMs);
      delivery.unref();
      this.#timers.push(delivery);
    }
  }

  private installContinuityCoordinator(): void {
    if (this.#continuityCoordinatorInstalled) return;
    this.cp.continuity.attach({
      readiness: { checkSession: (sessionId) => this.cp.doctor.sessionReadiness(sessionId) },
      ...(this.options.buzz
        ? { buzz: { connect: (sessionId: string, purpose: string) => this.options.buzz!.connect(sessionId, purpose) } }
        : {}),
    });
    this.cp.capacity.attach({
      providerFailureContinuity: {
        evaluate: (reason) => this.reconcileContinuity(reason),
      },
    });
    this.#continuityCoordinatorInstalled = true;
  }

  private uninstallContinuityCoordinator(): void {
    if (!this.#continuityCoordinatorInstalled) return;
    // Before a daemon has the lock (or after it relinquishes it), capacity failure still
    // refreshes the durable mode but cannot cause a second authority to switch bindings.
    this.cp.capacity.attach({
      providerFailureContinuity: { evaluate: (reason) => this.cp.continuity.evaluate(reason) },
    });
    this.#continuityCoordinatorInstalled = false;
  }

  /**
   * PRD §14.2's structured local interface is daemon-owned evidence, not a static
   * deployment artifact. Preserve the adapter's timestamp: manufacturing "now" here
   * would let an old quota reading remain fresh forever.
   */
  private async refreshCapacitySensors(): Promise<void> {
    const directory = this.cp.config.capacityDir;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);

    for (const adapter of this.cp.providers.production()) {
      const reading = await adapter.probeCapacity();
      const file = capacitySensorFile(directory, adapter.provider);
      const temporary = join(directory, `.${adapter.provider}.${process.pid}.${randomUUID()}.json`);
      writeFileSync(temporary, JSON.stringify(reading, null, 2), { mode: 0o600 });
      renameSync(temporary, file);
    }
  }

  /** §33.1 — health endpoint. A file the supervisor and `agentctl` can both read. */
  writeHealth(reconcile: ReconcileReport | null): void {
    const health = {
      pid: process.pid,
      startedAt: this.#startedAt,
      at: this.cp.clock.nowIso(),
      continuityMode: this.cp.continuity.mode(),
      lockHeld: this.lock.held(),
      runs: {
        queued: this.cp.runs.list({ state: RunState.QUEUED }).length,
        active: this.cp.runs.list({ state: RunState.ACTIVE }).length,
        blocked: this.cp.runs.list({ state: RunState.BLOCKED }).length,
        readyForCeo: this.cp.runs.list({ state: RunState.READY_FOR_CEO_REVIEW }).length,
      },
      lastReconcile: reconcile,
      timerHealth: {
        status: this.#timerFailures.size === 0 ? "HEALTHY" : "DEGRADED",
        failures: Object.fromEntries(this.#timerFailures),
      },
    };
    writeFileSync(join(this.options.stateDir, "health.json"), JSON.stringify(health, null, 2), {
      mode: 0o600,
    });
  }

  /**
   * §33.1 crash-loop backoff. The supervisor restarts the process; the daemon records
   * consecutive failures so the supervisor's throttle has evidence, and so a loop is
   * visible in the audit trail rather than silent.
   */
  private async runPeriodic(name: string, action: () => Promise<void>): Promise<void> {
    const now = this.cp.clock.nowIso();
    const previous = this.#timerFailures.get(name);
    if (previous && Date.parse(previous.retryNotBefore) > Date.parse(now)) return;

    try {
      await action();
      if (previous) {
        this.#timerFailures.delete(name);
        this.cp.audit.record({
          kind: "DAEMON_TIMER_RECOVERED",
          reasonCode: ReasonCode.OK,
          evidence: { timer: name, recoveredAfterFailures: previous.consecutiveFailures },
        });
        this.writeHealth(null);
      }
    } catch (err) {
      const failures = (previous?.consecutiveFailures ?? 0) + 1;
      const backoffSeconds = Math.min(300, 2 ** failures);
      const retryNotBefore = new Date(Date.parse(now) + backoffSeconds * 1000).toISOString();
      const failure = { consecutiveFailures: failures, lastError: safeErrorMessage(err), retryNotBefore };
      this.#timerFailures.set(name, failure);
      this.cp.audit.record({
        kind: "DAEMON_TIMER_FAILED",
        reasonCode: ReasonCode.DAEMON_TIMER_FAILED,
        evidence: { timer: name, ...failure, backoffSeconds },
      });
      try {
        this.writeHealth(null);
      } catch (healthError) {
        this.cp.audit.record({
          kind: "DAEMON_TIMER_FAILED",
          reasonCode: ReasonCode.DAEMON_TIMER_FAILED,
          evidence: { timer: "health", error: safeErrorMessage(healthError) },
        });
      }
    }
  }

  private recordStartupFailure(reasonCode: ReasonCodeValue, evidence: Record<string, unknown>): void {
    const path = join(this.options.stateDir, "crash-loop.json");
    const previous = this.readCrashLoop();
    const now = this.cp.clock.nowIso();
    const failures = previous.failures + 1;
    const backoffSeconds = Math.min(300, 2 ** failures);
    const next: CrashLoopFile = {
      failures,
      firstAt: previous.failures === 0 ? now : previous.firstAt,
      retryNotBefore: new Date(Date.parse(now) + backoffSeconds * 1000).toISOString(),
    };
    writeFileSync(path, JSON.stringify(next), { mode: 0o600 });

    const threshold = this.options.crashLoopThreshold ?? 3;
    this.cp.audit.record({
      kind: failures >= threshold ? "DAEMON_CRASH_LOOP" : "DAEMON_START_FAILED",
      reasonCode,
      evidence: { ...next, threshold, backoffSeconds, ...evidence },
    });
  }

  private recordLockContention(evidence: Record<string, unknown>): void {
    this.recordStartupFailure(ReasonCode.DAEMON_ALREADY_RUNNING, evidence);
    this.cp.audit.record({
      kind: "DAEMON_START_REFUSED",
      reasonCode: ReasonCode.DAEMON_ALREADY_RUNNING,
      evidence,
    });
  }

  private readCrashLoop(): CrashLoopFile {
    return readJson<CrashLoopFile>(join(this.options.stateDir, "crash-loop.json")) ?? {
      failures: 0,
      firstAt: this.cp.clock.nowIso(),
    };
  }

  private clearCrashLoop(): void {
    writeFileSync(join(this.options.stateDir, "crash-loop.json"), JSON.stringify({ failures: 0 }), {
      mode: 0o600,
    });
  }

  crashLoopState(): { failures: number; backoffSeconds: number } {
    const failures = this.readCrashLoop().failures;
    return { failures, backoffSeconds: failures === 0 ? 0 : Math.min(300, 2 ** failures) };
  }

  async stop(): Promise<void> {
    for (const timer of this.#timers) clearInterval(timer);
    this.#timers = [];
    this.uninstallContinuityCoordinator();
    this.cp.audit.record({ kind: "DAEMON_STOPPED", evidence: { pid: process.pid } });
    this.lock.release();
  }
}

const isAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const capacitySensorFile = (directory: string, provider: string): string => {
  if (!/^[A-Za-z0-9_-]+$/.test(provider)) {
    throw new Error(`unsafe provider id for capacity sensor: ${provider}`);
  }
  return join(directory, `${provider}.json`);
};

const readJson = <T>(path: string): T | null => {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
};

const safeErrorMessage = (err: unknown): string => {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/[\r\n\t]/g, " ").slice(0, 500);
};
