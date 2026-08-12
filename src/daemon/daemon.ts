import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type { ControlPlane } from "../app/control-plane.ts";
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
      await this.refreshCapacitySensors();
      const report = await this.reconcile();
      this.writeHealth(report);

      if (report.doctorStatus === "BLOCKED" || report.doctorStatus === "ERROR") {
        const reasonCode =
          report.doctorStatus === "BLOCKED" ? ReasonCode.DOCTOR_BLOCKED : ReasonCode.DOCTOR_ERROR;
        this.recordStartupFailure(reasonCode, { reconcile: report });
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
      void this.runPeriodic("capacity_sensor", () => this.refreshCapacitySensors());
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
