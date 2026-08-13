import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { totalmem } from "node:os";

import type { Clock } from "../core/clock.ts";
import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { CapacityMonitor } from "../capacity/capacity-monitor.ts";
import { RefreshTrigger } from "../capacity/capacity-monitor.ts";
import type { ClaimRegistry } from "../claims/claim-registry.ts";
import type { ContinuityKernel } from "../continuity/continuity-kernel.ts";
import type { AuditLog } from "../db/audit.ts";
import type { Db } from "../db/database.ts";
import { inspectDatabaseStatePaths, inspectPrivatePath } from "../db/state-preflight.ts";
import { ContinuityMode, Role, RunState, SessionLifecycle, roleKeyFor } from "../domain/types.ts";
import type { GitHubKernel } from "../github/github-kernel.ts";
import { isClean, tryRevParse } from "../git/git.ts";
import type { Outbox } from "../outbox/outbox.ts";
import type { ProjectRegistry } from "../registry/project-registry.ts";
import type { RepositoryRegistry } from "../registry/repository-registry.ts";
import type { RunEngine } from "../run/run-engine.ts";
import type { TaskGraph } from "../run/task-graph.ts";
import type { ProviderRegistry } from "../runtime/provider.ts";
import type { BindingRegistry } from "../session/binding-registry.ts";
import type { SessionRegistry } from "../session/session-registry.ts";

const exec = promisify(execFile);

export type Severity = "INFO" | "WARN" | "ERROR" | "CRITICAL";

/** PRD §25.4 — the finding contract. */
export interface Finding {
  code: string;
  severity: Severity;
  scope: string;
  blocking: boolean;
  confidence: "LOW" | "MEDIUM" | "HIGH";
  observedEvidence: Record<string, unknown>;
  recommendedAction: string;
}

export type DoctorStatus = "HEALTHY" | "DEGRADED" | "BLOCKED" | "ERROR";

export interface DoctorReport {
  scope: DoctorScope;
  target: string | null;
  status: DoctorStatus;
  findings: Finding[];
  ranAt: string;
}

export type DoctorScope =
  | "system"
  | "project"
  | "cto"
  | "run"
  | "session"
  | "capacity"
  | "github"
  | "worktree";

/**
 * PRD §25.
 *
 * Read-only by construction — the doctor has no mutating dependency and returns
 * findings, never side effects. Repair is a separate, explicitly authorised operation
 * (§25.7). Aggregation is deterministic (§25.5) so the same findings always produce the
 * same overall status.
 */
export class Doctor {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly audit: AuditLog,
    private readonly projects: ProjectRegistry,
    private readonly repositories: RepositoryRegistry,
    private readonly sessions: SessionRegistry,
    private readonly bindings: BindingRegistry,
    private readonly runs: RunEngine,
    private readonly tasks: TaskGraph,
    private readonly claims: ClaimRegistry,
    private readonly capacity: CapacityMonitor,
    private readonly providers: ProviderRegistry,
    private readonly continuity: ContinuityKernel,
    private readonly outbox: Outbox,
    private readonly github: GitHubKernel,
    private readonly worktrees: { orphans(repo: string, live: ReadonlySet<string>): Promise<string[]> },
    private readonly capacitySensorFiles: {
      directory: string;
      freshnessMs: number;
      maxClockSkewMs: number;
    },
    private readonly statePaths: {
      databasePath: string;
      worktreeRoot: string;
      secretsDir: string;
      capacityDir: string;
    },
  ) {}

  async run(
    scope: DoctorScope = "system",
    target?: string,
    supplementalFindings: readonly Finding[] = [],
  ): Promise<DoctorReport> {
    const findings: Finding[] = [...supplementalFindings];

    if (scope === "system" || scope === "cto" || scope === "project") {
      findings.push(...this.checkBindings(target ?? null));
    }
    if (scope === "system" || scope === "run") {
      findings.push(...this.checkRuns(target ?? null));
      findings.push(...this.checkWorkers());
    }
    if (scope === "system" || scope === "session") {
      findings.push(...this.checkSessions(target ?? null));
    }
    if (scope === "system" || scope === "capacity") {
      findings.push(...this.checkCapacitySensorFiles());
      findings.push(...(await this.checkCapacity()));
    }
    if (scope === "system") {
      findings.push(...this.checkStatePaths());
      findings.push(...(await this.checkHostResources()));
      findings.push(...this.checkClaims());
      findings.push(...this.checkOutbox());
      findings.push(...(await this.checkRepositories()));
      findings.push(...(await this.checkWorktrees()));
    }
    if (scope === "system" || scope === "github") {
      findings.push(...this.checkGitHubGate());
    }
    if (scope === "system" || scope === "worktree") {
      if (scope === "worktree") findings.push(...(await this.checkWorktrees()));
    }

    const report: DoctorReport = {
      scope,
      target: target ?? null,
      status: aggregate(findings),
      findings,
      ranAt: this.clock.nowIso(),
    };

    this.audit.record({
      kind: "DOCTOR_REPORT",
      reasonCode: statusReason(report.status),
      evidence: {
        scope,
        target: target ?? null,
        status: report.status,
        findings: findings.map((f) => ({ code: f.code, severity: f.severity, blocking: f.blocking })),
      },
    });
    return report;
  }

  /** §9.5 step 3 — readiness gate before a fresh CTO is bound. */
  async sessionReadiness(sessionId: string): Promise<Decision<void>> {
    const session = this.sessions.get(sessionId);
    if (!session) return deny(ReasonCode.NOT_FOUND, "unknown session", { sessionId });
    if (session.lifecycle !== SessionLifecycle.READY) {
      return deny(ReasonCode.SESSION_NOT_READY, `session is ${session.lifecycle}`, { sessionId });
    }
    if (this.continuity.mode() === ContinuityMode.SURVIVAL) {
      return deny(ReasonCode.CONTINUITY_SURVIVAL_NO_COMPLETION, "continuity is in SURVIVAL", {
        sessionId,
      });
    }
    return allow(ReasonCode.OK, undefined);
  }

  // --- checks --------------------------------------------------------------

  /** A startup preflight prevents trust; Doctor makes later chmod/symlink drift observable. */
  private checkStatePaths(): Finding[] {
    const inspections = [
      ...inspectDatabaseStatePaths(this.statePaths.databasePath),
      inspectPrivatePath(this.statePaths.worktreeRoot, "directory"),
      inspectPrivatePath(this.statePaths.secretsDir, "directory"),
      inspectPrivatePath(this.statePaths.capacityDir, "directory"),
    ];
    return inspections
      .filter((inspection) => !inspection.secure)
      .map((inspection) => ({
        code: "STATE_PATH_INSECURE",
        severity: "CRITICAL" as const,
        scope: "host",
        blocking: true,
        confidence: "HIGH" as const,
        observedEvidence: {
          path: inspection.path,
          kind: inspection.kind,
          reason: inspection.reason,
          expectedMode: inspection.expectedMode.toString(8),
          actualMode: inspection.actualMode === null ? null : inspection.actualMode.toString(8),
          ownerUid: inspection.ownerUid,
          currentUid: inspection.currentUid,
        },
        recommendedAction: "stop the daemon and restore owner-only, non-symlinked state paths from a trusted backup",
      }));
  }

  private checkBindings(projectId: string | null): Finding[] {
    const findings: Finding[] = [];
    const projects = projectId ? [this.projects.get(projectId)].filter(Boolean) : this.projects.list();

    for (const project of projects) {
      if (!project) continue;
      const binding = this.bindings.activePrimaryCto(project.projectId);
      const openRuns = this.runs
        .list({ projectId: project.projectId })
        .filter((r) => r.state !== RunState.COMPLETED && r.state !== RunState.FAILED && r.state !== RunState.CANCELLED);

      if (!binding && openRuns.length > 0 && !project.suspended) {
        findings.push({
          code: "CTO_MISSING_WITH_OPEN_RUNS",
          severity: "ERROR",
          scope: `project:${project.projectId}`,
          blocking: true,
          confidence: "HIGH",
          observedEvidence: { openRuns: openRuns.map((r) => r.runId) },
          recommendedAction: "provision a primary CTO or suspend the project",
        });
        continue;
      }
      if (!binding) continue;

      const session = this.sessions.get(binding.sessionId);
      if (!session || session.lifecycle === SessionLifecycle.STOPPED || session.lifecycle === SessionLifecycle.ERROR) {
        findings.push({
          code: "CTO_BINDING_POINTS_AT_DEAD_SESSION",
          severity: "CRITICAL",
          scope: `project:${project.projectId}`,
          blocking: true,
          confidence: "HIGH",
          observedEvidence: { sessionId: binding.sessionId, lifecycle: session?.lifecycle ?? "missing" },
          recommendedAction: "run a recovery takeover for this project",
        });
      }
      if (session && !session.buzzAddress) {
        findings.push({
          code: "CTO_BUZZ_NOT_CONNECTED",
          severity: "WARN",
          scope: `project:${project.projectId}`,
          blocking: false,
          confidence: "MEDIUM",
          observedEvidence: { sessionId: binding.sessionId },
          recommendedAction: "reconnect the CTO session to Buzz",
        });
      }
    }

    // The CEO role has no project scope but must exist for notifications to land.
    if (!this.bindings.active(roleKeyFor(Role.CEO))) {
      findings.push({
        code: "CEO_ROLE_UNBOUND",
        severity: "WARN",
        scope: "global",
        blocking: false,
        confidence: "HIGH",
        observedEvidence: {},
        recommendedAction: "bind the CEO role so production-ready notifications are deliverable",
      });
    }
    return findings;
  }

  private checkRuns(runId: string | null): Finding[] {
    const findings: Finding[] = [];
    const runs = runId ? [this.runs.get(runId)].filter(Boolean) : this.runs.list();

    for (const run of runs) {
      if (!run) continue;
      if (run.state === RunState.BLOCKED) {
        findings.push({
          code: "RUN_BLOCKED",
          severity: "WARN",
          scope: `run:${run.runId}`,
          blocking: false,
          confidence: "HIGH",
          observedEvidence: { reason: run.stateReason, goal: run.goal },
          recommendedAction: "resolve the escalation or cancel the run",
        });
      }
      if (run.state === RunState.ACTIVE && !run.ownerSessionId) {
        findings.push({
          code: "ACTIVE_RUN_WITHOUT_OWNER",
          severity: "CRITICAL",
          scope: `run:${run.runId}`,
          blocking: true,
          confidence: "HIGH",
          observedEvidence: {},
          recommendedAction: "re-pin the run owner or fail the run",
        });
      }
      if (run.state === RunState.QUEUED && run.projectId) {
        const project = this.projects.get(run.projectId);
        if (project && !project.suspended && project.activity === "INACTIVE") {
          findings.push({
            code: "RUN_QUEUED_WITHOUT_ACTIVE_PROJECT",
            severity: "WARN",
            scope: `run:${run.runId}`,
            blocking: false,
            confidence: "HIGH",
            observedEvidence: { projectId: run.projectId },
            recommendedAction: "dispatch the run so a primary CTO is provisioned",
          });
        }
      }
    }
    return findings;
  }

  /** CP-S43 — a receipt says RUNNING but no process backs it. */
  private checkWorkers(): Finding[] {
    const findings: Finding[] = [];
    const running = this.db.all<{
      execution_id: string;
      run_id: string;
      worker_process_id: number | null;
      worker_session_id: string | null;
      started_at: string;
    }>(`SELECT execution_id, run_id, worker_process_id, worker_session_id, started_at
          FROM task_executions WHERE status = 'RUNNING'`);

    for (const execution of running) {
      const session = execution.worker_session_id ? this.sessions.get(execution.worker_session_id) : null;
      const sessionAlive = session?.lifecycle ?? null;
      const pid = execution.worker_process_id;
      const hasSessionIdentity = execution.worker_session_id !== null;
      const hasValidSessionIdentity = hasSessionIdentity && session !== null;
      const hasProcessIdentity = pid !== null;
      const hasValidProcessIdentity =
        hasProcessIdentity &&
        Number.isInteger(pid) &&
        pid > 0;
      const processAlive = hasValidProcessIdentity
        ? isProcessAlive(pid!)
        : null;

      if (!hasSessionIdentity && !hasProcessIdentity) {
        findings.push({
          code: "WORKER_IDENTITY_MISSING",
          severity: "ERROR",
          scope: `run:${execution.run_id}`,
          blocking: true,
          confidence: "HIGH",
          observedEvidence: { executionId: execution.execution_id, startedAt: execution.started_at },
          recommendedAction: "supply a live worker session or a positive worker process id before opening a receipt",
        });
        continue;
      }

      if (!hasValidSessionIdentity && !hasValidProcessIdentity) {
        findings.push({
          code: "WORKER_IDENTITY_UNVERIFIABLE",
          severity: "ERROR",
          scope: `run:${execution.run_id}`,
          blocking: true,
          confidence: "HIGH",
          observedEvidence: {
            executionId: execution.execution_id,
            workerSessionId: execution.worker_session_id,
            workerProcessId: execution.worker_process_id,
            startedAt: execution.started_at,
          },
          recommendedAction: "replace the receipt with one backed by a known session or a positive process id",
        });
        continue;
      }

      if (processAlive === false || sessionAlive === SessionLifecycle.STOPPED || sessionAlive === SessionLifecycle.ERROR) {
        findings.push({
          code: "DEAD_WORKER_WITH_OPEN_RECEIPT",
          severity: "ERROR",
          scope: `run:${execution.run_id}`,
          blocking: true,
          confidence: "HIGH",
          observedEvidence: {
            executionId: execution.execution_id,
            pid: execution.worker_process_id,
            sessionLifecycle: sessionAlive,
            startedAt: execution.started_at,
          },
          recommendedAction: "abandon the execution receipt and retry the task",
        });
      }
    }
    return findings;
  }

  private checkSessions(sessionId: string | null): Finding[] {
    const findings: Finding[] = [];
    const sessions = sessionId ? [this.sessions.get(sessionId)].filter(Boolean) : this.sessions.live();
    for (const session of sessions) {
      if (!session) continue;
      if (session.lifecycle === SessionLifecycle.DRAINING) {
        const owned = this.runs.activeRunsOwnedBy(session.sessionId);
        findings.push({
          code: "SESSION_DRAINING",
          severity: owned.length > 0 ? "WARN" : "INFO",
          scope: `session:${session.sessionId}`,
          blocking: false,
          confidence: "HIGH",
          observedEvidence: { activeRuns: owned.map((r) => r.runId) },
          recommendedAction:
            owned.length > 0
              ? "continue, cancel or capacity-suspend the remaining runs to unblock switchover"
              : "complete the switchover",
        });
      }
      if (session.osPid && !isProcessAlive(session.osPid)) {
        findings.push({
          code: "SESSION_PROCESS_MISSING",
          severity: "ERROR",
          scope: `session:${session.sessionId}`,
          blocking: true,
          confidence: "HIGH",
          observedEvidence: { pid: session.osPid, lifecycle: session.lifecycle },
          recommendedAction: "mark the session ERROR and recover its bindings",
        });
      }
    }
    return findings;
  }

  private async checkCapacity(): Promise<Finding[]> {
    const findings: Finding[] = [];
    const readings = await this.capacity.refresh(RefreshTrigger.DOCTOR_CAPACITY_REPORT);
    for (const reading of readings) {
      if (reading.sensorHealth === "ERROR") {
        findings.push({
          code: "CAPACITY_SENSOR_FAILED",
          severity: "ERROR",
          scope: `provider:${reading.provider}`,
          blocking: false,
          confidence: "HIGH",
          observedEvidence: {
            error: reading.error ?? null,
            source: reading.source,
            runtimeHealth: reading.runtimeHealth,
          },
          recommendedAction: "restore the structured local capacity file or a supported usage source",
        });
      }
      if (reading.advisoryState === "EXHAUSTED" || reading.advisoryState === "CRITICAL") {
        findings.push({
          code: "CAPACITY_LOW",
          severity: reading.advisoryState === "EXHAUSTED" ? "ERROR" : "WARN",
          scope: `provider:${reading.provider}`,
          blocking: false,
          confidence: "HIGH",
          observedEvidence: {
            advisoryState: reading.advisoryState,
            buckets: reading.buckets.map((b) => ({ id: b.id, remainingPercent: b.remainingPercent, resetAt: b.resetAt })),
          },
          recommendedAction: "wait for reset or route critical roles to another provider",
        });
      }
    }

    const plan = this.continuity.computeCoveragePlan();
    if (plan.outcome !== "FULL_COVERAGE") {
      findings.push({
        code: `ROLE_COVERAGE_${plan.outcome}`,
        severity: plan.outcome === "NO_VALID_COVERAGE" ? "CRITICAL" : "WARN",
        scope: "continuity",
        blocking: plan.outcome === "NO_VALID_COVERAGE",
        confidence: "HIGH",
        observedEvidence: { uncovered: plan.uncovered, action: plan.action, mode: plan.mode },
        recommendedAction: plan.action,
      });
    }
    return findings;
  }

  /** The daemon owns these files, so their timestamp is independently checkable evidence. */
  private checkCapacitySensorFiles(): Finding[] {
    const findings: Finding[] = [];
    const now = Date.parse(this.clock.nowIso());

    for (const adapter of this.providers.production()) {
      const provider = adapter.provider;
      const file = capacitySensorFile(this.capacitySensorFiles.directory, provider);
      if (!existsSync(file)) {
        findings.push({
          code: ReasonCode.CAPACITY_SENSOR_FILE_MISSING,
          severity: "ERROR",
          scope: `provider:${provider}`,
          blocking: false,
          confidence: "HIGH",
          observedEvidence: { provider, file },
          recommendedAction: "start the daemon capacity sensor or restore its structured local file",
        });
        continue;
      }

      let observedAt: string | null = null;
      try {
        const parsed = JSON.parse(readFileSync(file, "utf8")) as { observedAt?: unknown };
        observedAt = typeof parsed.observedAt === "string" ? parsed.observedAt : null;
      } catch (err) {
        findings.push({
          code: ReasonCode.CAPACITY_SENSOR_FILE_INVALID,
          severity: "ERROR",
          scope: `provider:${provider}`,
          blocking: false,
          confidence: "HIGH",
          observedEvidence: { provider, file, error: safeErrorMessage(err) },
          recommendedAction: "replace the capacity sensor file with a valid daemon observation",
        });
        continue;
      }

      const observedMs = observedAt ? Date.parse(observedAt) : Number.NaN;
      const ageMs = now - observedMs;
      if (!Number.isFinite(observedMs) || ageMs < -this.capacitySensorFiles.maxClockSkewMs) {
        findings.push({
          code: ReasonCode.CAPACITY_SENSOR_FILE_INVALID,
          severity: "ERROR",
          scope: `provider:${provider}`,
          blocking: false,
          confidence: "HIGH",
          observedEvidence: { provider, file, observedAt, now: this.clock.nowIso() },
          recommendedAction: "write a capacity observation with a valid current timestamp",
        });
        continue;
      }
      if (ageMs > this.capacitySensorFiles.freshnessMs) {
        findings.push({
          code: ReasonCode.CAPACITY_SENSOR_FILE_STALE,
          severity: "WARN",
          scope: `provider:${provider}`,
          blocking: false,
          confidence: "HIGH",
          observedEvidence: {
            provider,
            file,
            observedAt,
            ageMs,
            freshnessMs: this.capacitySensorFiles.freshnessMs,
          },
          recommendedAction: "refresh the daemon-owned capacity sensor before allocating new work",
        });
      }
    }
    return findings;
  }

  /** CP-S45 — host pressure maps deterministically to DEGRADED. */
  private async checkHostResources(): Promise<Finding[]> {
    const findings: Finding[] = [];
    const total = totalmem();
    const load = (await loadAverage())[0] ?? 0;
    const cpuCount = (await cpuCountSafe()) || 1;
    const swap = await swapUsage();
    const memoryPressure = await memoryPressurePercent();

    if (load / cpuCount > 2) {
      findings.push({
        code: "HOST_CPU_PRESSURE",
        severity: "WARN",
        scope: "host",
        blocking: false,
        confidence: "MEDIUM",
        observedEvidence: { loadAverage1m: load, cpuCount },
        recommendedAction: "reduce worker fan-out until load subsides",
      });
    }
    if (memoryPressure !== null && memoryPressure > 85) {
      findings.push({
        code: "HOST_MEMORY_PRESSURE",
        severity: "WARN",
        scope: "host",
        blocking: false,
        confidence: "MEDIUM",
        observedEvidence: { usedPercent: memoryPressure, totalBytes: total },
        recommendedAction: "reduce concurrency or stop idle sessions",
      });
    }
    if (swap !== null && swap > 4096) {
      findings.push({
        code: "HOST_SWAP_PRESSURE",
        severity: "ERROR",
        scope: "host",
        blocking: false,
        confidence: "MEDIUM",
        observedEvidence: { swapUsedMb: swap },
        recommendedAction: "stop non-critical sessions; the host is swapping heavily",
      });
    }
    return findings;
  }

  private checkClaims(): Finding[] {
    return this.claims.overdue().map((claim) => ({
      code: "CLAIM_OVERDUE",
      severity: "WARN" as const,
      scope: `run:${claim.runId}`,
      blocking: false,
      confidence: "HIGH" as const,
      observedEvidence: {
        claimId: claim.claimId,
        repositoryIdentity: claim.repositoryIdentity,
        expiresAt: claim.expiresAt,
      },
      recommendedAction: "expire the claim if the holder is gone",
    }));
  }

  private checkOutbox(): Finding[] {
    const stuck = this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM outbox WHERE status = 'PENDING' AND attempts >= 3`,
    );
    if ((stuck?.n ?? 0) === 0) return [];
    return [
      {
        code: "OUTBOX_DELIVERY_STUCK",
        severity: "ERROR",
        scope: "outbox",
        blocking: false,
        confidence: "HIGH",
        observedEvidence: { pendingWithRetries: stuck?.n ?? 0 },
        recommendedAction: "inspect the Buzz transport and retry the outbox",
      },
    ];
  }

  private async checkRepositories(): Promise<Finding[]> {
    const findings: Finding[] = [];
    for (const repository of this.repositories.list()) {
      // `lastObservedHead` is the acknowledged baseline. A diagnostic must not call the
      // registry's mutating observation API because that would acknowledge an owner
      // change merely by looking at it (§25, §33.5).
      const head = await tryRevParse(repository.checkoutPath, "HEAD");
      const clean = head ? await isClean(repository.checkoutPath) : false;
      const driftState =
        head === null ? "UNKNOWN" : head === repository.lastObservedHead && clean ? "IN_SYNC" : "DRIFTED";

      if (driftState === "DRIFTED") {
        findings.push({
          code: "REPOSITORY_DRIFT",
          severity: "WARN",
          scope: `repository:${repository.identity}`,
          blocking: false,
          confidence: "MEDIUM",
          observedEvidence: {
            acknowledgedHead: repository.lastObservedHead,
            observedHead: head,
            clean,
            checkoutPath: repository.checkoutPath,
          },
          recommendedAction: "reconcile the checkout, or treat pending candidates as stale",
        });
      }
      if (driftState === "UNKNOWN") {
        findings.push({
          code: "REPOSITORY_UNREADABLE",
          severity: "ERROR",
          scope: `repository:${repository.identity}`,
          blocking: true,
          confidence: "HIGH",
          observedEvidence: { checkoutPath: repository.checkoutPath },
          recommendedAction: "restore the checkout path or re-register the repository",
        });
      }
    }
    return findings;
  }

  /** CP-S44 — orphan worktrees are reported, never auto-deleted. */
  private async checkWorktrees(): Promise<Finding[]> {
    const findings: Finding[] = [];
    const live = new Set(
      this.db
        .all<{ worktree_id: string | null }>(
          `SELECT worktree_id FROM task_executions WHERE status = 'RUNNING' AND worktree_id IS NOT NULL`,
        )
        .map((r) => r.worktree_id!)
        .filter(Boolean),
    );
    for (const repository of this.repositories.list()) {
      let orphans: string[];
      try {
        orphans = await this.worktrees.orphans(repository.checkoutPath, live);
      } catch (err) {
        findings.push({
          code: "WORKTREE_PROBE_FAILED",
          severity: "ERROR",
          scope: `repository:${repository.identity}`,
          blocking: true,
          confidence: "HIGH",
          observedEvidence: {
            checkoutPath: repository.checkoutPath,
            error: safeErrorMessage(err),
          },
          recommendedAction: "restore worktree inspection before trusting repository isolation",
        });
        continue;
      }
      if (orphans.length > 0) {
        findings.push({
          code: "ORPHAN_WORKTREE",
          severity: "WARN",
          scope: `repository:${repository.identity}`,
          blocking: false,
          confidence: "HIGH",
          observedEvidence: { orphans },
          recommendedAction: "run the prune-worktrees repair operation after confirming nothing is in flight",
        });
      }
    }
    return findings;
  }

  private checkGitHubGate(): Finding[] {
    const health = this.github.gateHealth();
    const findings: Finding[] = [];
    if (!health.credentialInstalled) {
      findings.push({
        code: "TRUSTED_GATE_CREDENTIAL_MISSING",
        severity: "ERROR",
        scope: "github",
        blocking: true,
        confidence: "HIGH",
        observedEvidence: {},
        recommendedAction: "install the trusted GitHub credential; programmatic merges are impossible without it",
      });
    } else if (!health.permissionsOk) {
      findings.push({
        code: "TRUSTED_GATE_CREDENTIAL_PERMISSIONS",
        severity: "CRITICAL",
        scope: "github",
        blocking: true,
        confidence: "HIGH",
        observedEvidence: {},
        recommendedAction: "restrict the secret directory to owner-only access",
      });
    }
    return findings;
  }
}

/** PRD §25.5 — deterministic aggregation. */
export const aggregate = (findings: readonly Finding[]): DoctorStatus => {
  if (findings.some((f) => f.severity === "CRITICAL" && f.blocking)) return "ERROR";
  if (findings.some((f) => f.severity === "ERROR" && f.blocking)) return "BLOCKED";
  if (findings.some((f) => !f.blocking && (f.severity === "WARN" || f.severity === "ERROR"))) {
    return "DEGRADED";
  }
  return "HEALTHY";
};

const statusReason = (status: DoctorStatus): ReasonCode =>
  status === "HEALTHY"
    ? ReasonCode.DOCTOR_HEALTHY
    : status === "DEGRADED"
      ? ReasonCode.DOCTOR_DEGRADED
      : status === "BLOCKED"
        ? ReasonCode.DOCTOR_BLOCKED
        : ReasonCode.DOCTOR_ERROR;

const isProcessAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const safeErrorMessage = (err: unknown): string => {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/[\r\n\t]/g, " ").slice(0, 500);
};

const capacitySensorFile = (directory: string, provider: string): string => {
  if (!/^[A-Za-z0-9_-]+$/.test(provider)) {
    throw new Error(`unsafe provider id for capacity sensor: ${provider}`);
  }
  return join(directory, `${provider}.json`);
};

const loadAverage = async (): Promise<number[]> => {
  const { loadavg } = await import("node:os");
  return loadavg();
};

const cpuCountSafe = async (): Promise<number> => {
  const { cpus } = await import("node:os");
  return cpus().length;
};

const memoryPressurePercent = async (): Promise<number | null> => {
  const { freemem, totalmem: total } = await import("node:os");
  const totalBytes = total();
  if (totalBytes === 0) return null;
  return ((totalBytes - freemem()) / totalBytes) * 100;
};

const swapUsage = async (): Promise<number | null> => {
  try {
    const { stdout } = await exec("sysctl", ["-n", "vm.swapusage"], { encoding: "utf8" });
    const used = /used\s*=\s*([\d.]+)M/.exec(stdout)?.[1];
    return used ? Number.parseFloat(used) : null;
  } catch {
    return null;
  }
};
