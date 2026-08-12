import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ControlPlane } from "../app/control-plane.ts";
import { type Decision, allow } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { RunState, SessionLifecycle } from "../domain/types.ts";
import type { BuzzAdapter } from "../buzz/buzz-adapter.ts";
import { SingleInstanceLock } from "./single-instance.ts";

export interface DaemonOptions {
  stateDir: string;
  watchdogIntervalMs?: number;
  deliveryIntervalMs?: number;
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

  constructor(
    private readonly cp: ControlPlane,
    private readonly options: DaemonOptions,
  ) {
    mkdirSync(options.stateDir, { recursive: true });
    this.lock = new SingleInstanceLock(join(options.stateDir, "agentcpd.lock"));
  }

  async start(): Promise<Decision<ReconcileReport>> {
    const startedAt = this.cp.clock.nowIso();
    const acquired = this.lock.acquire(startedAt);
    if (!acquired.allowed) {
      this.recordCrashLoop();
      return acquired as Decision<ReconcileReport>;
    }
    this.#startedAt = startedAt;

    const report = await this.reconcile();
    this.writeHealth(report);
    this.startTimers();
    this.clearCrashLoop();

    this.cp.audit.record({
      kind: "DAEMON_STARTED",
      evidence: { pid: process.pid, startedAt, reconcile: report },
    });
    return allow(ReasonCode.OK, report);
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

    // Resume dispatch for anything still queued. Idempotency lives in the outbox key,
    // so a run already dispatched under this generation is not dispatched twice.
    const resumedRuns: string[] = [];
    for (const run of this.cp.runs.list({ state: RunState.QUEUED })) {
      const dispatched = await this.cp.runs.dispatch(run.runId);
      if (dispatched.allowed) resumedRuns.push(run.runId);
    }

    const report = await this.cp.doctor.run("system");

    return {
      activeBindings: activeBindings?.n ?? 0,
      resumedRuns,
      expiredClaims,
      expiredMessages,
      orphanedExecutions,
      sessionsMarkedError,
      doctorStatus: report.status,
    };
  }

  private startTimers(): void {
    const watchdogMs = this.options.watchdogIntervalMs ?? 60_000;
    const deliveryMs = this.options.deliveryIntervalMs ?? 5_000;

    const watchdog = setInterval(() => {
      void this.cp.watchdog
        .tick()
        .then((tick) => {
          if (tick.overdue.length > 0) this.writeHealth(null);
        })
        .catch(() => undefined);
    }, watchdogMs);
    watchdog.unref();
    this.#timers.push(watchdog);

    if (this.options.buzz) {
      const delivery = setInterval(() => {
        void this.options.buzz!.deliverPending().catch(() => undefined);
      }, deliveryMs);
      delivery.unref();
      this.#timers.push(delivery);
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
  private recordCrashLoop(): void {
    const path = join(this.options.stateDir, "crash-loop.json");
    const previous = readJson<{ failures: number; firstAt: string }>(path) ?? {
      failures: 0,
      firstAt: this.cp.clock.nowIso(),
    };
    const next = { failures: previous.failures + 1, firstAt: previous.firstAt };
    writeFileSync(path, JSON.stringify(next), { mode: 0o600 });

    const threshold = this.options.crashLoopThreshold ?? 3;
    this.cp.audit.record({
      kind: next.failures >= threshold ? "DAEMON_CRASH_LOOP" : "DAEMON_START_REFUSED",
      reasonCode: ReasonCode.DAEMON_ALREADY_RUNNING,
      evidence: { ...next, threshold, backoffSeconds: Math.min(300, 2 ** next.failures) },
    });
  }

  private clearCrashLoop(): void {
    writeFileSync(join(this.options.stateDir, "crash-loop.json"), JSON.stringify({ failures: 0 }), {
      mode: 0o600,
    });
  }

  crashLoopState(): { failures: number; backoffSeconds: number } {
    const state = readJson<{ failures: number }>(join(this.options.stateDir, "crash-loop.json"));
    const failures = state?.failures ?? 0;
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
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const readJson = <T>(path: string): T | null => {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
};
