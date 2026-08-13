import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type { ControlPlane } from "../app/control-plane.ts";
import type { RequiredRole, RoleCoveragePlan } from "../continuity/continuity-kernel.ts";
import { digestOf } from "../core/digest.ts";
import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode, type ReasonCode as ReasonCodeValue } from "../core/reason-codes.ts";
import type { DoctorScope } from "../doctor/doctor.ts";
import { REPAIR_OWNER_APPROVAL_OPERATION } from "../doctor/repair.ts";
import { RunState, SessionLifecycle } from "../domain/types.ts";
import { RunEvidenceExporter } from "../export/run-evidence.ts";
import { IngressGuard, ownerApprovalPayload } from "../ingress/ingress-guard.ts";
import type { OwnerApprovalReceipt } from "../ceo/owner-authority.ts";
import type { BuzzAdapter } from "../buzz/buzz-adapter.ts";
import {
  ApprovedRunFinalizer,
  type DaemonFinalizationAuthorities,
  type ReclaimedFinalizationAttempt,
  type FinalizationResult,
} from "./finalizer.ts";
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
  reclaimedFinalizationAttempts: ReclaimedFinalizationAttempt[];
  resumedFinalizations: string[];
  doctorStatus: string;
}

/** Methods exposed by the authenticated local operator socket. */
export const OPERATOR_METHOD = {
  DOCTOR_RUN: "doctor.run",
  RUN_SHOW: "run.show",
  RUN_LIST: "run.list",
  RUN_EXPORT: "run.export",
  BASELINE_EXPORT: "baseline.export",
  RUN_CANCEL: "run.cancel",
  CONTINUITY_STATUS: "continuity.status",
  OUTBOX_RETRY: "outbox.retry",
  OWNER_APPROVE: "owner.approve",
  REPAIR_LIST: "repair.list",
  REPAIR_DRY_RUN: "repair.dry-run",
  REPAIR_EXECUTE: "repair.execute",
  CAPACITY_SHOW: "capacity.show",
  CAPACITY_SET: "capacity.set",
  PROJECT_LIST: "project.list",
  PROJECT_REGISTER: "project.register",
  DAEMON_STATUS: "daemon.status",
} as const;

export type OperatorMethod = (typeof OPERATOR_METHOD)[keyof typeof OPERATOR_METHOD];

/** Read requests are never cached: an operator must see fresh daemon state. */
export const OPERATOR_MUTATION_METHODS: ReadonlySet<OperatorMethod> = new Set([
  OPERATOR_METHOD.RUN_CANCEL,
  OPERATOR_METHOD.OUTBOX_RETRY,
  OPERATOR_METHOD.OWNER_APPROVE,
  OPERATOR_METHOD.REPAIR_DRY_RUN,
  OPERATOR_METHOD.REPAIR_EXECUTE,
  OPERATOR_METHOD.CAPACITY_SET,
  OPERATOR_METHOD.PROJECT_REGISTER,
]);

export interface OperatorRequest {
  requestId: string;
  method: OperatorMethod;
  params: Record<string, unknown>;
  idempotencyKey?: string;
}

/**
 * The operator socket derives this identity from its server-side credential binding. It is
 * intentionally not part of OperatorRequest: an actor in a request body is only a claim.
 */
export interface AuthenticatedOperatorPeer {
  readonly channel: "cli";
  readonly peerId: string;
  readonly actor: string;
  readonly incarnation: string;
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
  readonly #operatorInFlight = new Map<string, Promise<Decision<unknown>>>();
  readonly #operatorResults = new Map<string, { fingerprint: string; result: Decision<unknown> }>();
  readonly #finalizer: ApprovedRunFinalizer;
  readonly #evidenceExporter: RunEvidenceExporter;

  constructor(
    private readonly cp: ControlPlane,
    private readonly options: DaemonOptions,
    authorities?: DaemonFinalizationAuthorities,
  ) {
    mkdirSync(options.stateDir, { recursive: true });
    chmodSync(options.stateDir, 0o700);
    this.lock = new SingleInstanceLock(join(options.stateDir, "agentcpd.lock"));
    this.#finalizer = new ApprovedRunFinalizer(cp, undefined, authorities);
    this.#evidenceExporter = new RunEvidenceExporter(cp.db, cp.artifacts, cp.clock, cp.audit);
  }

  /**
   * The authenticated operator socket's only application entry point. Reads and writes use
   * the daemon's already-open composition root; a write is refused after the single-instance
   * lock is lost, so the socket can never become a second runtime authority.
   */
  async handleOperatorRequest(
    input: unknown,
    peerInput?: AuthenticatedOperatorPeer,
  ): Promise<Decision<unknown>> {
    const peer = parseAuthenticatedOperatorPeer(peerInput);
    if (!peer.allowed) return peer;
    const parsed = parseOperatorRequest(input);
    if (!parsed.allowed) return parsed;
    const request = parsed.value;
    const fingerprint = digestOf({
      peerId: peer.value.peerId,
      incarnation: peer.value.incarnation,
      method: request.method,
      params: request.params,
    });
    const key = OPERATOR_MUTATION_METHODS.has(request.method) && request.idempotencyKey
      ? `${peer.value.peerId}:${peer.value.incarnation}:${request.idempotencyKey}`
      : undefined;

    if (key) {
      const cached = this.#operatorResults.get(key);
      if (cached) {
        return cached.fingerprint === fingerprint
          ? cached.result
          : deny(ReasonCode.CONFLICT, "operator idempotency key was reused for different parameters", {
              idempotencyKey: key,
              method: request.method,
            });
      }
      const inFlight = this.#operatorInFlight.get(key);
      if (inFlight) return inFlight;

      const operation = this.executeOperatorRequest(request, peer.value);
      this.#operatorInFlight.set(key, operation);
      void operation.then((result) => {
        this.#operatorInFlight.delete(key);
        this.rememberOperatorResult(key, fingerprint, result);
      });
      return operation;
    }

    return this.executeOperatorRequest(request, peer.value);
  }

  private rememberOperatorResult(
    key: string,
    fingerprint: string,
    result: Decision<unknown>,
  ): void {
    // Keep retries idempotent for the daemon lifetime without allowing an unbounded operator
    // client to turn the authority into a memory store.
    while (this.#operatorResults.size >= 1024) {
      const oldest = this.#operatorResults.keys().next().value as string | undefined;
      if (!oldest) break;
      this.#operatorResults.delete(oldest);
    }
    this.#operatorResults.set(key, { fingerprint, result });
  }

  private async executeOperatorRequest(
    request: OperatorRequest,
    peer: AuthenticatedOperatorPeer,
  ): Promise<Decision<unknown>> {
    if (!this.lock.held()) {
      return deny(
        ReasonCode.DAEMON_LOCK_LOST,
        "agentcpd no longer holds the single-instance lock; operator request refused",
        { method: request.method },
      );
    }

    try {
      switch (request.method) {
        case OPERATOR_METHOD.DOCTOR_RUN: {
          const scope = request.params["scope"] ?? "system";
          const target = request.params["target"];
          if (!isDoctorScope(scope)) return invalidOperatorParam("scope", scope);
          if (target !== undefined && target !== null && typeof target !== "string") {
            return invalidOperatorParam("target", target);
          }
          return allow(ReasonCode.OK, await this.cp.doctor.run(scope, target as string | undefined));
        }

        case OPERATOR_METHOD.RUN_SHOW: {
          const runId = requiredOperatorString(request.params, "runId");
          if (!runId.allowed) return runId;
          const run = this.cp.runs.get(runId.value);
          if (!run) return deny(ReasonCode.NOT_FOUND, `unknown run ${runId.value}`, { runId: runId.value });
          return allow(ReasonCode.OK, {
            run,
            tasks: this.cp.tasks.list(runId.value),
            executions: this.cp.tasks.executions(runId.value),
            evidence: this.cp.ceo.evidence(runId.value),
            claims: this.cp.claims.heldByRun(runId.value),
            humanGate: this.cp.ceo.humanGateStatus(runId.value),
            outbox: this.cp.outbox.listByRun(runId.value).map((message) => ({
              kind: message.kind,
              status: message.status,
              bindingGeneration: message.bindingGeneration,
            })),
          });
        }

        case OPERATOR_METHOD.RUN_LIST: {
          const state = request.params["state"];
          if (state !== undefined && state !== null && !isRunState(state)) {
            return invalidOperatorParam("state", state);
          }
          return allow(
            ReasonCode.OK,
            this.cp.runs.list(state ? { state } : {}),
          );
        }

        case OPERATOR_METHOD.RUN_EXPORT: {
          const runId = requiredOperatorString(request.params, "runId");
          if (!runId.allowed) return runId;
          return this.#evidenceExporter.exportRun(runId.value);
        }

        case OPERATOR_METHOD.BASELINE_EXPORT: {
          const from = requiredOperatorString(request.params, "from");
          if (!from.allowed) return from;
          const to = requiredOperatorString(request.params, "to");
          if (!to.allowed) return to;
          return this.#evidenceExporter.exportBaseline({ from: from.value, to: to.value });
        }

        case OPERATOR_METHOD.RUN_CANCEL: {
          const runId = requiredOperatorString(request.params, "runId");
          if (!runId.allowed) return runId;
          const reason = request.params["reason"] ?? "operator cancel";
          if (typeof reason !== "string") return invalidOperatorParam("reason", reason);
          return this.cp.runs.cancel(runId.value, reason);
        }

        case OPERATOR_METHOD.CONTINUITY_STATUS:
          return allow(ReasonCode.OK, {
            mode: this.cp.continuity.mode(),
            plan: this.cp.continuity.computeCoveragePlan(),
            capacity: this.cp.capacity.all(),
          });

        case OPERATOR_METHOD.OUTBOX_RETRY:
          return this.cp.repair.execute({
            operationId: "retry_outbox",
            parameters: {},
            authorizedBy: "HERMES",
            dryRun: false,
          });

        case OPERATOR_METHOD.OWNER_APPROVE:
          return this.executeOwnerApproval(request, peer);

        case OPERATOR_METHOD.REPAIR_LIST:
          return allow(ReasonCode.OK, this.cp.repair.catalog());

        case OPERATOR_METHOD.REPAIR_DRY_RUN:
          return this.executeRepair(request, peer, true);

        case OPERATOR_METHOD.REPAIR_EXECUTE:
          return this.executeRepair(request, peer, false);

        case OPERATOR_METHOD.CAPACITY_SHOW:
          return allow(ReasonCode.OK, { providers: this.cp.capacity.all() });

        case OPERATOR_METHOD.CAPACITY_SET:
          return this.setCapacity(request.params);

        case OPERATOR_METHOD.PROJECT_LIST:
          return allow(
            ReasonCode.OK,
            this.cp.projects.list().map((project) => ({
              ...project,
              repositories: this.cp.repositories.byProject(project.projectId).map((repository) => repository.identity),
            })),
          );

        case OPERATOR_METHOD.PROJECT_REGISTER:
          return this.registerProject(request.params);

        case OPERATOR_METHOD.DAEMON_STATUS:
          return allow(ReasonCode.OK, {
            lock: this.lock.read(),
            databasePath: this.cp.config.databasePath,
            health: readJson(join(this.options.stateDir, "health.json")),
          });
      }
    } catch (error) {
      return deny(ReasonCode.INTERNAL_ERROR, "operator request failed", {
        method: request.method,
        error: safeErrorMessage(error),
      });
    }
  }

  private executeOwnerApproval(
    request: OperatorRequest,
    peer: AuthenticatedOperatorPeer,
  ): Decision<unknown> {
    const runId = requiredOperatorString(request.params, "runId");
    if (!runId.allowed) return runId;
    const item = requiredOperatorString(request.params, "item");
    if (!item.allowed) return item;
    const note = request.params["note"] ?? "";
    if (typeof note !== "string") return invalidOperatorParam("note", note);
    const approved = request.params["approved"] ?? true;
    if (typeof approved !== "boolean") return invalidOperatorParam("approved", approved);
    const approval = {
      runId: runId.value,
      operation: "owner_decision_submit",
      parameters: { item: item.value, approved, note },
      idempotencyKey:
        request.idempotencyKey ??
        `owner-decision:${digestOf({
          runId: runId.value,
          item: item.value,
          approved,
          note,
          peerId: peer.peerId,
          incarnation: peer.incarnation,
        })}`,
      approved,
    };
    const admitted = this.admitCliOwnerApproval(peer.actor, approval, `owner-decision:${digestOf(approval)}`);
    if (!admitted.allowed) return admitted;
    return this.cp.ceo.recordOwnerDecision({
      runId: runId.value,
      item: item.value,
      approved,
      note,
      receipt: admitted.value,
    });
  }

  private executeRepair(
    request: OperatorRequest,
    peer: AuthenticatedOperatorPeer,
    dryRun: boolean,
  ): Decision<unknown> | Promise<Decision<unknown>> {
    const operationId = requiredOperatorString(request.params, "operationId");
    if (!operationId.allowed) return operationId;
    const parameters = operatorStringRecord(request.params["parameters"] ?? {});
    if (!parameters.allowed) return parameters;
    const runId = request.params["runId"];
    if (runId !== undefined && runId !== null && typeof runId !== "string") {
      return invalidOperatorParam("runId", runId);
    }
    const owner = request.params["owner"] ?? false;
    if (typeof owner !== "boolean") return invalidOperatorParam("owner", owner);
    const authorizedBy = owner ? "OWNER" : "HERMES";

    if (!owner) {
      return this.cp.repair.execute({
        operationId: operationId.value,
        parameters: parameters.value,
        authorizedBy,
        dryRun,
        runId: (runId as string | null | undefined) ?? null,
      });
    }

    const approval = {
      runId: (runId as string | null | undefined) ?? null,
      operation: REPAIR_OWNER_APPROVAL_OPERATION,
      parameters: {
        operationId: operationId.value,
        parameters: parameters.value,
        dryRun,
      },
      idempotencyKey:
        request.idempotencyKey ??
        `repair:${digestOf({
          operationId: operationId.value,
          parameters: parameters.value,
          dryRun,
          runId: runId ?? null,
          peerId: peer.peerId,
          incarnation: peer.incarnation,
        })}`,
      approved: true,
    };
    const admitted = this.admitCliOwnerApproval(peer.actor, approval, `repair:${digestOf(approval)}`);
    if (!admitted.allowed) return admitted;
    return this.cp.repair.execute({
      operationId: operationId.value,
      parameters: parameters.value,
      authorizedBy,
      ownerApproval: admitted.value,
      dryRun,
      runId: (runId as string | null | undefined) ?? null,
    });
  }

  private admitCliOwnerApproval(
    actor: string,
    approval: { runId: string | null; operation: string; parameters: unknown; idempotencyKey: string; approved: boolean },
    nonce: string,
  ): Decision<OwnerApprovalReceipt> {
    const allowedActors = (this.cp.config.ownerIdentities ?? [])
      .filter((identity) => identity.channel === "cli")
      .map((identity) => identity.actor);
    if (allowedActors.length === 0) {
      return deny(ReasonCode.INGRESS_ACTOR_NOT_ALLOWLISTED, "no CLI owner identity is configured", {
        channel: "cli",
        actor,
      });
    }
    const guard = new IngressGuard(this.cp.db, this.cp.clock, this.cp.audit, {
      cli: { allowedActors },
    });
    return guard.admitOwnerApproval(
      {
        channel: "cli",
        actor,
        nonce,
        payload: ownerApprovalPayload(approval),
      },
      approval,
    );
  }

  private setCapacity(params: Record<string, unknown>): Decision<unknown> {
    const provider = requiredOperatorString(params, "provider");
    if (!provider.allowed) return provider;
    let payload: unknown = params["payload"];
    if (typeof payload === "string") {
      try {
        payload = JSON.parse(payload) as unknown;
      } catch {
        return deny(ReasonCode.INVALID_ARGUMENT, "capacity payload is not valid JSON", { provider: provider.value });
      }
    }
    if (!isPlainRecord(payload)) return invalidOperatorParam("payload", payload);

    const body = {
      ...payload,
      provider: provider.value,
      observedAt: this.cp.clock.nowIso(),
      // The operator publishes quota facts; runtime health remains daemon-observed.
      runtimeHealth: "UNKNOWN",
    };
    const directory = this.cp.config.capacityDir;
    const file = capacitySensorFile(directory, provider.value);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const temporary = join(directory, `.${provider.value}.${process.pid}.${randomUUID()}.json`);
    writeFileSync(temporary, JSON.stringify(body, null, 2), { mode: 0o600 });
    renameSync(temporary, file);
    return allow(ReasonCode.OK, { wrote: file, body });
  }

  private async registerProject(params: Record<string, unknown>): Promise<Decision<unknown>> {
    const name = requiredOperatorString(params, "name");
    if (!name.allowed) return name;
    const checkoutPath = requiredOperatorString(params, "checkoutPath");
    if (!checkoutPath.allowed) return checkoutPath;
    const projectId = params["projectId"];
    if (projectId !== undefined && projectId !== null && typeof projectId !== "string") {
      return invalidOperatorParam("projectId", projectId);
    }
    const project = this.cp.projects.register({
      name: name.value,
      projectId: (projectId as string | undefined) ?? undefined,
    });
    if (!project.allowed) return project;
    const repository = await this.cp.repositories.register({
      checkoutPath: checkoutPath.value,
      projectId: project.value.projectId,
      repositoryRole: "primary",
    });
    if (!repository.allowed) return repository;
    return allow(ReasonCode.OK, { project: project.value, repository: repository.value });
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
      report.resumedFinalizations = await this.resumeApprovedRuns();
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
    const reclaimedFinalizationAttempts = this.#finalizer.reclaimExpiredAttempts();

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
      reclaimedFinalizationAttempts,
      resumedFinalizations: [],
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

  /**
   * The production entry point for the post-CEO sequence. A caller that did not win the
   * daemon lock cannot use this object as a second finalizer, even in the same process.
   */
  async finalizeApprovedRun(runId: string): Promise<Decision<FinalizationResult>> {
    if (!this.lock.held()) {
      return deny(ReasonCode.DAEMON_LOCK_LOST, "daemon finalization requires the held single-instance lock", {
        runId,
      });
    }
    const finalized = await this.#finalizer.finalizeApprovedRun(runId);
    this.writeHealth(null);
    return finalized;
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

  /** Recover CEO-approved work after the durable lease and GitHub receipt reconciliations. */
  private async resumeApprovedRuns(): Promise<string[]> {
    const resumed: string[] = [];
    const states = [RunState.CEO_APPROVED, RunState.MERGING, RunState.POST_MERGE_VERIFYING];
    for (const state of states) {
      for (const run of this.cp.runs.list({ state })) {
        const finalized = await this.finalizeApprovedRun(run.runId);
        if (finalized.allowed) resumed.push(run.runId);
      }
    }
    return resumed;
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
        // This is a targeted recovery sweep, not a second workflow engine: the durable
        // finalization lease and GitHub receipts remain the sole source of work. It retries
        // an interrupted callback without requiring a daemon restart.
        const finalized = await this.resumeApprovedRuns();
        if (tick.overdue.length > 0 || finalized.length > 0) this.writeHealth(null);
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
        ceoApproved: this.cp.runs.list({ state: RunState.CEO_APPROVED }).length,
        merging: this.cp.runs.list({ state: RunState.MERGING }).length,
        postMergeVerifying: this.cp.runs.list({ state: RunState.POST_MERGE_VERIFYING }).length,
        blockedPostMerge: this.cp.runs.list({ state: RunState.BLOCKED_POST_MERGE }).length,
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

const parseAuthenticatedOperatorPeer = (
  peer: AuthenticatedOperatorPeer | undefined,
): Decision<AuthenticatedOperatorPeer> => {
  if (
    !peer ||
    peer.channel !== "cli" ||
    peer.peerId.trim().length === 0 ||
    peer.actor.trim().length === 0 ||
    peer.incarnation.trim().length === 0
  ) {
    return deny(
      ReasonCode.OPERATOR_UNAUTHENTICATED,
      "operator request requires an authenticated live peer binding",
      {},
    );
  }
  return allow(ReasonCode.OK, peer);
};

const parseOperatorRequest = (value: unknown): Decision<OperatorRequest> => {
  if (!isPlainRecord(value)) {
    return deny(ReasonCode.INVALID_ARGUMENT, "operator request must be a JSON object", {});
  }
  const requestId = value["requestId"];
  const method = value["method"];
  const params = value["params"] ?? {};
  const idempotencyKey = value["idempotencyKey"];
  if (typeof requestId !== "string" || requestId.length === 0) {
    return invalidOperatorParam("requestId", requestId);
  }
  if (typeof method !== "string" || !isOperatorMethod(method)) {
    return deny(ReasonCode.OPERATOR_METHOD_NOT_ALLOWED, "operator method is not allowlisted", { method });
  }
  if (!isPlainRecord(params)) return invalidOperatorParam("params", params);
  if (idempotencyKey !== undefined && typeof idempotencyKey !== "string") {
    return invalidOperatorParam("idempotencyKey", idempotencyKey);
  }
  return allow(ReasonCode.OK, {
    requestId,
    method,
    params,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  });
};

const isOperatorMethod = (value: string): value is OperatorMethod =>
  (Object.values(OPERATOR_METHOD) as readonly string[]).includes(value);

const isDoctorScope = (value: unknown): value is DoctorScope =>
  ["system", "project", "cto", "run", "session", "capacity", "github", "worktree"].includes(value as string);

const isRunState = (value: unknown): value is (typeof RunState)[keyof typeof RunState] =>
  Object.values(RunState).includes(value as (typeof RunState)[keyof typeof RunState]);

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const requiredOperatorString = (
  params: Record<string, unknown>,
  name: string,
): Decision<string> => {
  const value = params[name];
  return typeof value === "string" && value.length > 0
    ? allow(ReasonCode.OK, value)
    : invalidOperatorParam(name, value);
};

const operatorStringRecord = (value: unknown): Decision<Record<string, string>> => {
  if (!isPlainRecord(value)) return invalidOperatorParam("parameters", value);
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") return invalidOperatorParam(`parameters.${key}`, entry);
    result[key] = entry;
  }
  return allow(ReasonCode.OK, result);
};

const invalidOperatorParam = (name: string, value: unknown): Decision<never> =>
  deny(ReasonCode.INVALID_ARGUMENT, `operator parameter '${name}' is invalid`, {
    parameter: name,
    receivedType: value === null ? "null" : typeof value,
  });

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
