import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type { ControlPlane } from "../app/control-plane.ts";
import { AGENTCTL_CAPACITY_OBSERVATION_SOURCE, RefreshTrigger } from "../capacity/capacity-monitor.ts";
import { COLLECTOR_TIMEOUT_MS } from "../capacity/usage-collectors.ts";
import { RECONCILE_SWEEP_BUDGET_MS } from "../conversation/turn-coordinator.ts";
import type { RequiredRole, RoleCoveragePlan } from "../continuity/continuity-kernel.ts";
import { digestOf } from "../core/digest.ts";
import { acpError, type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode, type ReasonCode as ReasonCodeValue } from "../core/reason-codes.ts";
import { CONTINUITY_MODE_MAX_AGE_MS } from "../run/run-engine.ts";
import {
  resolveDoctorHealth,
  type DoctorHealthAttempt,
  type DoctorHealthSnapshot,
  type DoctorReport,
  type DoctorScope,
  type Finding,
} from "../doctor/doctor.ts";
import { REPAIR_OWNER_APPROVAL_OPERATION } from "../doctor/repair.ts";
import { RunState, SessionLifecycle } from "../domain/types.ts";
import { RunEvidenceExporter } from "../export/run-evidence.ts";
import {
  acknowledgeTerminalTelegramReply,
  IngressGuard,
  ownerApprovalPayload,
} from "../ingress/ingress-guard.ts";
import type { OwnerApprovalReceipt } from "../ceo/owner-authority.ts";
import type { BuzzAdapter } from "../buzz/buzz-adapter.ts";
import {
  ApprovedRunFinalizer,
  type DaemonFinalizationAuthorities,
  type ReclaimedFinalizationAttempt,
  type FinalizationResult,
} from "./finalizer.ts";
import { SingleInstanceLock } from "./single-instance.ts";

/**
 * How often the sensor tick refreshes capacity and re-evaluates continuity.
 *
 * This must stay below CONTINUITY_MODE_MAX_AGE_MS. Dispatch re-evaluates a SURVIVAL verdict
 * older than that window, so a tick slower than the window would let dispatch act on a verdict
 * the tick was supposed to have refreshed — and the two were independent literals in different
 * files, meaning a change to either silently changed what the other meant (#454).
 *
 * `assertContinuityFreshnessOrdering` below fails at startup if the relationship is broken,
 * because a comment saying "keep these in step" is not a thing that keeps them in step.
 */
/**
 * What a capacity read may take **while the daemon is coming up, or parked**.
 *
 * Sized against the measured cost of one healthy pass — Claude answers in ~2s and the Codex
 * app-server in ~3s — because failing to read a quota must never be the same event as failing
 * to start. Here, abandoning is the right outcome: the daemon comes up and the periodic refresh
 * supplies what the startup sweep did not.
 *
 * It is the wrong budget for that periodic refresh, and it was being used there too. See
 * `sweepBudgetMs`.
 */
const STARTUP_CAPACITY_REFRESH_BUDGET_MS = 15_000;

/**
 * What a full sweep may take, derived from the work rather than from a healthy day.
 *
 * `CapacityMonitor.refresh` loops the registered providers **one at a time** and each collector
 * may run to `COLLECTOR_TIMEOUT_MS`. A budget smaller than that product does not bound the
 * sweep — it guarantees the sweep is cut short whenever a single provider is slow, and the
 * providers that never got their turn are left with no fresh observation at all.
 *
 * Measured 2026-08-19 with the startup budget in both places: **24 of the ~30 periodic sweeps in
 * two hours were abandoned**, and each abandonment was followed ~27 seconds later by the CEO
 * role going uncovered for about three and a half minutes. The comment on the old constant said
 * it "bounds the sum, so one unresponsive provider cannot spend the others' time" — with a
 * sequential loop that is not what it did. It spent their time and then cut them off.
 *
 * This is #613 and #614 in a third place: a budget that was right for one phase, applied to
 * another, and measured against the case where nothing is slow.
 */
export const sweepBudgetMs = (providerCount: number): number =>
  providerCount * COLLECTOR_TIMEOUT_MS + STARTUP_CAPACITY_REFRESH_BUDGET_MS;

const DEFAULT_CAPACITY_REFRESH_MS = 4 * 60_000;

/**
 * #734 — how old a system doctor evaluation may be before a reader is told `STALE` instead of
 * its last value. Bound against the capacity-sensor cadence rather than picked independently:
 * that tick is what re-evaluates the doctor outside startup (both periodically and reactively
 * on a provider failure, via `reconcileContinuity`), so a window shorter than its interval
 * would report every report as expired the instant it landed. `assertDoctorFreshnessOrdering`
 * refuses that configuration at start, the same way `assertContinuityFreshnessOrdering` already
 * refuses one for the continuity verdict it bounds.
 */
const DEFAULT_DOCTOR_FRESHNESS_MS = 3 * DEFAULT_CAPACITY_REFRESH_MS;

const assertDoctorFreshnessOrdering = (capacityRefreshMs: number, doctorFreshnessMs: number): void => {
  if (capacityRefreshMs >= doctorFreshnessMs) {
    throw acpError(
      ReasonCode.INVALID_ARGUMENT,
      "the doctor freshness window must be longer than the capacity refresh interval that renews it",
      { capacityRefreshMs, doctorFreshnessMs },
    );
  }
};

/**
 * Refuses a configuration where the tick cannot keep the verdict fresh.
 *
 * Called at start rather than trusted: the two values live in different files, and the failure
 * it prevents is silent — dispatch acting on a SURVIVAL verdict the tick was supposed to have
 * refreshed, with nothing anywhere reporting a contradiction.
 */
const assertContinuityFreshnessOrdering = (refreshMs: number): void => {
  if (refreshMs >= CONTINUITY_MODE_MAX_AGE_MS) {
    throw acpError(
      ReasonCode.INVALID_ARGUMENT,
      "capacity refresh interval must be shorter than the continuity freshness window",
      { refreshMs, continuityWindowMs: CONTINUITY_MODE_MAX_AGE_MS },
    );
  }
};

/**
 * Refuses a configuration where a sweep cannot finish before the next one starts.
 *
 * `runPeriodic` has a failure backoff and no overlap guard, so a sweep that outlives its
 * interval runs alongside its successor and both compete for the same sequential collectors.
 * Checked at start for the same reason as the ordering above: the two values are derived in
 * different places, and the failure is silent.
 */
const assertSweepFitsItsInterval = (refreshMs: number, budgetMs: number, providerCount: number): void => {
  if (budgetMs >= refreshMs) {
    throw acpError(
      ReasonCode.INVALID_ARGUMENT,
      "a capacity sweep may take longer than the interval between sweeps",
      { budgetMs, refreshMs, providerCount, collectorTimeoutMs: COLLECTOR_TIMEOUT_MS },
    );
  }
};

export interface DaemonOptions {
  stateDir: string;
  watchdogIntervalMs?: number;
  deliveryIntervalMs?: number;
  /** Keeps the daemon-owned structured capacity sensors inside their freshness window. */
  capacityRefreshIntervalMs?: number;
  buzz?: BuzzAdapter;
  /** Consecutive start failures before the supervisor should back off harder. */
  crashLoopThreshold?: number;
  /** How long the whole capacity refresh may hold startup before it is abandoned. */
  capacityRefreshBudgetMs?: number;
  /**
   * How often a parked daemon re-reads its own sensors without being asked. The operator door
   * must not be the only way out of a park: the block it exists for is the one an automatic
   * collector can also clear, and release-and-exit used to get that re-read for free from the
   * supervisor's restart.
   */
  bootstrapRecheckIntervalMs?: number;
  /** How often the daemon asks its receipt port about every unresolved turn (#639 contract 6). */
  turnReconcileIntervalMs?: number;
  /**
   * How long one turn-reconciliation pass may run before it stops issuing new lookups. Defaults
   * to `RECONCILE_SWEEP_BUDGET_MS`; overridable so a caller sizing `turnReconcileIntervalMs` down
   * (tests, a tighter deployment) can keep the budget-fits-its-interval invariant satisfied
   * without waiting the production default out — the same pairing `capacityRefreshBudgetMs`
   * already gives the capacity sweep.
   */
  turnReconcileBudgetMs?: number;
  /**
   * #734 — how old a persisted system doctor evaluation may be before it is reported `STALE`
   * rather than reused as current. Must be strictly greater than the effective capacity
   * refresh interval; see `assertDoctorFreshnessOrdering`.
   */
  doctorFreshnessMs?: number;
}

/**
 * The doctor finding, reduced to what a caller outside the daemon can act on. The daemon
 * decides whether to park on the *codes* of the blocking findings, so they have to survive
 * `reconcile()` rather than being collapsed into `doctorStatus` alone.
 */
export interface BlockingFinding {
  code: string;
  severity: string;
  scope: string;
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
  blockingFindings: BlockingFinding[];
  /** Present when this start went through a bootstrap park, so the printed report says so. */
  bootstrapParked?: boolean;
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
  CAPACITY_OBSERVE: "capacity.observe",
  PROJECT_LIST: "project.list",
  PROJECT_REGISTER: "project.register",
  ACTOR_LIST: "actor.list",
  ACTOR_REGISTER: "actor.register",
  ACTOR_UNREGISTER: "actor.unregister",
  CONVERSATION_CONTRADICTIONS: "conversation.contradictions",
  CONVERSATION_ADJUDICATE: "conversation.adjudicate",
  CONVERSATION_UNRESOLVED: "conversation.unresolved",
  CONVERSATION_RESOLVE: "conversation.resolve",
  TELEGRAM_REPLY_ACKNOWLEDGE: "telegram.reply.acknowledge",
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
  OPERATOR_METHOD.CAPACITY_OBSERVE,
  OPERATOR_METHOD.PROJECT_REGISTER,
  OPERATOR_METHOD.ACTOR_REGISTER,
  OPERATOR_METHOD.ACTOR_UNREGISTER,
  OPERATOR_METHOD.CONVERSATION_ADJUDICATE,
  OPERATOR_METHOD.CONVERSATION_RESOLVE,
  OPERATOR_METHOD.TELEGRAM_REPLY_ACKNOWLEDGE,
]);

/**
 * The method set a *parked* daemon admits, and nothing else. A parked daemon has not passed
 * its startup doctor, so the full operator surface is not merely unnecessary here — it is
 * unsafe: `OWNER_APPROVE` is the human gate, `REPAIR_EXECUTE` is destructive, and the socket's
 * `bootstrap.hermes` extension constitutes CEO. The two admitted methods are the remedy
 * (`capacity.observe`, which writes a reading and touches no dispatch, run or lock state) and
 * the means to see that the remedy has not yet worked (`daemon.status`).
 */
export const BOOTSTRAP_OPERATOR_METHODS: ReadonlySet<OperatorMethod> = new Set([
  OPERATOR_METHOD.CAPACITY_OBSERVE,
  // The two halves of the one operator action a contradicted conversation needs: see what
  // disagreed, and answer it. Without them the doctor told an operator to record an
  // adjudication and the daemon that would have accepted one refused to start.
  OPERATOR_METHOD.CONVERSATION_CONTRADICTIONS,
  OPERATOR_METHOD.CONVERSATION_ADJUDICATE,
  // And the two halves of the action an *unresolved* conversation needs. A turn whose permit died
  // with the process that issued it is not contradicted — its records agree, there is just nothing
  // to agree with — so the pair above cannot reach it and the doctor named a state no command
  // could clear. #668.
  OPERATOR_METHOD.CONVERSATION_UNRESOLVED,
  OPERATOR_METHOD.CONVERSATION_RESOLVE,
  OPERATOR_METHOD.DAEMON_STATUS,
]);

/**
 * Park only for what an operator's capacity observation could actually clear. A parked daemon
 * is a weaker state than a stopped one, so it must not be reachable for a blocking finding
 * that no reading can answer — those keep the release-and-exit path unchanged.
 *
 * An empty list never parks: `start()` only consults this when the doctor blocked, so no
 * blocking findings means the status came from somewhere this door cannot reach.
 */
export const blockingFindingsOf = (report: { findings: readonly Finding[] }): BlockingFinding[] =>
  report.findings
    .filter((finding) => finding.blocking)
    .map((finding) => ({ code: finding.code, severity: finding.severity, scope: finding.scope }));

/** Folds one reconcile pass into another so a multi-pass start reports all of its own work. */
const mergeReconciled = (earlier: ReconcileReport, later: ReconcileReport): ReconcileReport => ({
  ...later,
  expiredClaims: earlier.expiredClaims + later.expiredClaims,
  expiredMessages: earlier.expiredMessages + later.expiredMessages,
  orphanedExecutions: [...earlier.orphanedExecutions, ...later.orphanedExecutions],
  sessionsMarkedError: [...earlier.sessionsMarkedError, ...later.sessionsMarkedError],
  reclaimedFinalizationAttempts: [
    ...earlier.reclaimedFinalizationAttempts,
    ...later.reclaimedFinalizationAttempts,
  ],
});

export const canParkForBootstrap = (blockingFindings: readonly BlockingFinding[]): boolean =>
  blockingFindings.length > 0 &&
  blockingFindings.every(
    (finding) =>
      finding.code.startsWith("ROLE_COVERAGE_") ||
      finding.code.startsWith("CAPACITY_") ||
      // A contradicted conversation meets this rule the moment a door exists that clears it,
      // and until one did, the rule read as "park for capacity" rather than as what it says.
      // Parking does not weaken the quarantine: a claim is refused by the ledger, not by the
      // daemon's mode, so a parked daemon admits no new turn for that actor either.
      finding.code.startsWith("CANONICAL_TURN_"),
  );

/**
 * `BOOTSTRAP` is a daemon that holds its lock and serves the capacity door while its startup
 * doctor still blocks dispatch. It is on the wire because `capacity.observe` returning OK is
 * not on its own evidence that dispatch will resume — the reading may land and leave coverage
 * unroutable, and an operator who cannot tell those apart has had the failure moved, not closed.
 */
export type DaemonMode = "NORMAL" | "BOOTSTRAP";

/** A door the daemon can open while parked and must be able to close before promoting. */
export interface BootstrapDoor {
  close: () => Promise<void>;
}

export interface DaemonStartOptions {
  bootstrapDoor?: () => Promise<BootstrapDoor>;
}

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
 * Whether an optional ingress channel is actually running, for `health.json` — the surface
 * `OPERATOR_METHOD.DAEMON_STATUS` (`agentctl daemon status`) reads verbatim.
 *
 * Found missing by review (#682, round 8's second follow-up): a daemon that comes up healthy
 * while Telegram silently never started (an unmeasured transport's redelivery retention refused
 * `IngressGuard`'s construction) had no health surface saying so — `mode: "NORMAL"` and a
 * healthy `lockHeld` look identical whether Telegram is running or was refused. `configured`
 * is false for a deployment that never set any `ACP_TELEGRAM_*` variable; `running` is the
 * outcome; `disabledReason` names *why* when `configured && !running`, distinct from "never
 * configured" for the same reason the stderr line at startup does not say "not configured" for
 * this case (the operator set this up on purpose).
 */
export interface IngressChannelStatus {
  configured: boolean;
  running: boolean;
  disabledReason: string | null;
  /** Exact terminal reply whose acknowledgement can resume this live listener, when there is one. */
  recoveryNonce?: string | null;
}

/** The one live ingress action an authenticated terminal-reply acknowledgement may trigger. */
export interface TelegramIngressController {
  resumeAfterAcknowledgement(nonce: string): Promise<boolean>;
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
  #mode: DaemonMode = "NORMAL";
  #bootstrapBlocking: BlockingFinding[] = [];
  // A counter, not a one-shot waiter: an observation can land while the park is inside its
  // re-check, and a signal delivered to nobody must not be discarded. The park compares the
  // counter against what it last consumed, so it only sleeps when nothing is outstanding.
  #bootstrapSignal = 0;
  #bootstrapAbandoned = false;
  #bootstrapWaiter: (() => void) | null = null;
  #timerFailures = new Map<string, TimerFailure>();
  // Unset until `main`'s composition root reports Telegram's outcome — `null` renders in
  // `health.json` as "this daemon has no opinion yet", distinct from `configured: false`.
  #telegramIngress: IngressChannelStatus | null = null;
  #telegramIngressController: TelegramIngressController | null = null;
  #continuityCoordinatorInstalled = false;
  #continuityReconciling = false;
  // #734 — the last system evaluation that actually finished, and the outcome of the most
  // recent *attempt*, kept apart on purpose: a failed attempt must be visible even while the
  // last success is still inside its freshness window (criterion 3). `resolveDoctorHealth`
  // is the only place these two are compared.
  #lastDoctorSuccess: { report: DoctorReport } | null = null;
  #lastDoctorAttempt: DoctorHealthAttempt | null = null;
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
    // A parked daemon never uses the idempotency cache. The cache exists to make a retry
    // idempotent, and while parked that is the wrong property twice over: `capacity.observe`
    // re-probes runtime health on every call, so the same payload can legitimately produce a
    // different admission; and a replayed result never reaches `executeOperatorRequest`, so it
    // would silently skip the re-check the whole park is waiting for. It also stops a
    // DAEMON_BOOTSTRAP_MODE denial from being pinned to a key the operator retries after
    // promotion.
    const key = this.#mode !== "BOOTSTRAP" && OPERATOR_MUTATION_METHODS.has(request.method) && request.idempotencyKey
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

    if (this.#mode === "BOOTSTRAP" && !BOOTSTRAP_OPERATOR_METHODS.has(request.method)) {
      return deny(
        ReasonCode.DAEMON_BOOTSTRAP_MODE,
        "agentcpd is parked in bootstrap mode and admits only the capacity observation door",
        {
          method: request.method,
          mode: this.#mode,
          admittedMethods: [...BOOTSTRAP_OPERATOR_METHODS].sort(),
          blockingFindings: this.#bootstrapBlocking,
        },
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
          // #734 criterion 4 — an untargeted system check is the same evaluation the periodic
          // and reactive triggers produce, so it also updates the persisted freshness snapshot.
          // A caller need not wait for the next tick, or restart the daemon, to force one: this
          // is the on-demand escape hatch. A targeted or non-system call is diagnostic only,
          // exactly as before, and does not touch the persisted snapshot.
          if (scope === "system" && target === undefined) {
            return allow(ReasonCode.OK, await this.runSystemDoctorCheck(this.telegramIngressFindings()));
          }
          return allow(ReasonCode.OK, await this.cp.doctor.run(
            scope,
            target as string | undefined,
            scope === "system" ? this.telegramIngressFindings() : [],
          ));
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

        case OPERATOR_METHOD.CAPACITY_OBSERVE: {
          const observed = await this.observeCapacity(request.params, peer);
          // Only a reading that was actually persisted can change the doctor's mind, so a
          // denied observation must not consume the park's wake-up.
          if (observed.allowed && this.#mode === "BOOTSTRAP") this.wakeBootstrap("OBSERVED");
          return observed;
        }

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

        case OPERATOR_METHOD.ACTOR_LIST:
          return allow(ReasonCode.OK, this.cp.actors.activeSet());

        case OPERATOR_METHOD.ACTOR_REGISTER: {
          const actorId = requiredOperatorString(request.params, "actorId");
          if (!actorId.allowed) return actorId;
          const actorGeneration = requiredOperatorInteger(request.params, "actorGeneration", 1);
          if (!actorGeneration.allowed) return actorGeneration;
          const expected = requiredOperatorInteger(request.params, "expectedRegistrySetGeneration", 0);
          if (!expected.allowed) return expected;
          return this.cp.actors.register({
            actorId: actorId.value,
            actorGeneration: actorGeneration.value,
            expectedRegistrySetGeneration: expected.value,
          });
        }

        case OPERATOR_METHOD.ACTOR_UNREGISTER: {
          const actorId = requiredOperatorString(request.params, "actorId");
          if (!actorId.allowed) return actorId;
          const actorGeneration = requiredOperatorInteger(request.params, "actorGeneration", 1);
          if (!actorGeneration.allowed) return actorGeneration;
          const expected = requiredOperatorInteger(request.params, "expectedRegistrySetGeneration", 0);
          if (!expected.allowed) return expected;
          const reason = requiredOperatorString(request.params, "reason");
          if (!reason.allowed) return reason;
          return this.cp.actors.unregister({
            actorId: actorId.value,
            actorGeneration: actorGeneration.value,
            expectedRegistrySetGeneration: expected.value,
            reason: reason.value,
          });
        }

        case OPERATOR_METHOD.CONVERSATION_CONTRADICTIONS:
          return allow(ReasonCode.OK, this.cp.conversation.contradictions());

        case OPERATOR_METHOD.CONVERSATION_UNRESOLVED:
          return allow(ReasonCode.OK, this.cp.conversation.unresolvedAcrossActors());

        case OPERATOR_METHOD.CONVERSATION_RESOLVE: {
          const targetActorId = requiredOperatorString(request.params, "targetActorId");
          if (!targetActorId.allowed) return targetActorId;
          const turnRequestId = requiredOperatorString(request.params, "turnRequestId");
          if (!turnRequestId.allowed) return turnRequestId;
          const reasonCode = requiredOperatorString(request.params, "reasonCode");
          if (!reasonCode.allowed) return reasonCode;
          const evidenceDigest = requiredOperatorString(request.params, "evidenceDigest");
          if (!evidenceDigest.allowed) return evidenceDigest;
          const resolved = this.cp.conversation.resolveInDoubt({
            targetActorId: targetActorId.value,
            turnRequestId: turnRequestId.value,
            reasonCode: reasonCode.value,
            evidenceDigest: evidenceDigest.value,
            // Only `true` counts. Anything else — absent, "yes", 1 — is not an operator saying they
            // established the fence, and the refusal it produces is the safe direction.
            fenceAsserted: request.params?.fenceAsserted === true,
          });
          // Same reason as the adjudication below: an operator who follows the doctor's remedy
          // exactly should not then watch `daemon.status` report the stale finding for a recheck
          // interval. A denied resolution must not consume the wake-up — nothing changed to see.
          if (resolved.allowed && this.#mode === "BOOTSTRAP") this.wakeBootstrap("OBSERVED");
          return resolved;
        }

        case OPERATOR_METHOD.TELEGRAM_REPLY_ACKNOWLEDGE: {
          const nonce = requiredOperatorString(request.params, "nonce");
          if (!nonce.allowed) return nonce;
          const reasonCode = requiredOperatorString(request.params, "reasonCode");
          if (!reasonCode.allowed) return reasonCode;
          const evidenceDigest = requiredOperatorString(request.params, "evidenceDigest");
          if (!evidenceDigest.allowed) return evidenceDigest;
          const acknowledged = acknowledgeTerminalTelegramReply(this.cp.db, this.cp.clock, this.cp.audit, {
            nonce: nonce.value,
            resolvedBy: peer.actor,
            reasonCode: reasonCode.value,
            evidenceDigest: evidenceDigest.value,
          });
          if (!acknowledged.allowed) return acknowledged;

          // Choose recovery over process exit here because this authenticated, exact-nonce
          // acknowledgement is already the operator decision UNKNOWN delivery requires. The
          // listener keeps the live daemon composition and can safely redeliver the inbound
          // update: its terminal reply remains UNRESOLVED and is never sent again. If the process
          // dies after the durable acknowledgement but before this call, its supervisor starts a
          // fresh listener, which reaches the same durable no-resend state and advances normally.
          // A different nonce must not revive this stop: it says nothing about the ambiguous send
          // that caused it.
          if (acknowledged.value.deliveryStatus === "UNRESOLVED") {
            await this.#telegramIngressController?.resumeAfterAcknowledgement(nonce.value);
          }
          return acknowledged;
        }

        case OPERATOR_METHOD.CONVERSATION_ADJUDICATE: {
          const targetActorId = requiredOperatorString(request.params, "targetActorId");
          if (!targetActorId.allowed) return targetActorId;
          const turnRequestId = requiredOperatorString(request.params, "turnRequestId");
          if (!turnRequestId.allowed) return turnRequestId;
          const reasonCode = requiredOperatorString(request.params, "reasonCode");
          if (!reasonCode.allowed) return reasonCode;
          const evidenceDigest = requiredOperatorString(request.params, "evidenceDigest");
          if (!evidenceDigest.allowed) return evidenceDigest;
          const cited = requiredOperatorIntegerList(request.params, "citedObservationIds");
          if (!cited.allowed) return cited;
          const adjudicated = this.cp.conversation.adjudicate({
            targetActorId: targetActorId.value,
            turnRequestId: turnRequestId.value,
            citedObservationIds: cited.value,
            reasonCode: reasonCode.value,
            evidenceDigest: evidenceDigest.value,
          });
          // Symmetrical with the capacity door above, and for the same reason. Without it an
          // operator follows the doctor's remedy exactly, both calls succeed, and `daemon.status`
          // goes on reporting BOOTSTRAP with the stale finding for up to the recheck interval —
          // four minutes by default, longer if configured. The remedy landed and the report said
          // it had not, which is the shape this whole door was built to remove. A denied
          // adjudication must not consume the wake-up: nothing changed for the doctor to see.
          if (adjudicated.allowed && this.#mode === "BOOTSTRAP") this.wakeBootstrap("OBSERVED");
          return adjudicated;
        }

        case OPERATOR_METHOD.DAEMON_STATUS:
          return allow(ReasonCode.OK, {
            lock: this.lock.read(),
            databasePath: this.cp.config.databasePath,
            health: readJson(join(this.options.stateDir, "health.json")),
            mode: this.#mode,
            admittedMethods:
              this.#mode === "BOOTSTRAP" ? [...BOOTSTRAP_OPERATOR_METHODS].sort() : null,
            blockingFindings: this.#mode === "BOOTSTRAP" ? this.#bootstrapBlocking : [],
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
    // Mint the receipt against the candidate the operator is actually answering for. The
    // receipt is then stale if the run moves before the CEO presents it.
    const candidateSnapshotDigest = this.cp.runs.currentCandidate(runId.value);
    const approval = {
      runId: runId.value,
      candidateSnapshotDigest,
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

    const repairRunId = (runId as string | null | undefined) ?? null;
    const candidateSnapshotDigest = repairRunId ? this.cp.runs.currentCandidate(repairRunId) : null;
    const approval = {
      runId: repairRunId,
      candidateSnapshotDigest,
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
          runId: repairRunId,
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
      runId: repairRunId,
    });
  }

  private admitCliOwnerApproval(
    actor: string,
    approval: {
      runId: string | null;
      candidateSnapshotDigest: string | null;
      operation: string;
      parameters: unknown;
      idempotencyKey: string;
      approved: boolean;
    },
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

  private async observeCapacity(
    params: Record<string, unknown>,
    peer: AuthenticatedOperatorPeer,
  ): Promise<Decision<unknown>> {
    const provider = requiredOperatorString(params, "provider");
    if (!provider.allowed) return provider;
    const payload = params["payload"];
    if (!isPlainRecord(payload)) return invalidOperatorParam("payload", payload);
    if (!this.cp.providers.has(provider.value)) {
      return deny(ReasonCode.CAPACITY_UNKNOWN_NOT_ROUTABLE, "capacity observation provider is not registered", {
        provider: provider.value,
      });
    }
    // The operator reports quota, not executable liveness. Preserve that distinction by
    // obtaining runtime health from the registered adapter before the observation enters
    // capacity admission; a failed liveness probe makes the persisted reading non-routable.
    let runtimeHealth: "HEALTHY" | "DEGRADED" | "UNAVAILABLE";
    try {
      runtimeHealth = await this.cp.providers.require(provider.value).probeRuntime();
    } catch {
      runtimeHealth = "UNAVAILABLE";
    }
    return this.cp.capacity.observe({
      provider: provider.value,
      observedAt: payload["observedAt"],
      buckets: payload["buckets"],
      runtimeHealth,
      actor: peer.actor,
      // This is derived from the authenticated daemon entry point, never accepted from
      // the request payload where a caller could claim a different provenance surface.
      source: AGENTCTL_CAPACITY_OBSERVATION_SOURCE,
    });
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

  /**
   * `options.bootstrapDoor` is supplied by the process that owns socket plumbing, not built
   * here: the daemon decides *whether* a parked door is admissible, the caller decides what a
   * door is. Omitting it keeps the historical behaviour exactly — deny, release, exit.
   */
  async start(options: DaemonStartOptions = {}): Promise<Decision<ReconcileReport>> {
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
      let report = await this.reconcile();
      this.writeHealth(report);

      if (report.doctorStatus === "BLOCKED" || report.doctorStatus === "ERROR") {
        const reasonCode =
          report.doctorStatus === "BLOCKED" ? ReasonCode.DOCTOR_BLOCKED : ReasonCode.DOCTOR_ERROR;

        if (options.bootstrapDoor && canParkForBootstrap(report.blockingFindings)) {
          const promoted = await this.parkForBootstrap(report, options.bootstrapDoor);
          if (promoted) {
            report = promoted;
          } else {
            this.recordStartupFailure(reasonCode, { reconcile: report });
            this.uninstallContinuityCoordinator();
            this.lock.release();
            this.#startedAt = null;
            return deny(reasonCode, "startup doctor did not permit dispatch resume", { reconcile: report });
          }
        } else {
          this.recordStartupFailure(reasonCode, { reconcile: report });
          this.uninstallContinuityCoordinator();
          this.lock.release();
          this.#startedAt = null;
          return deny(reasonCode, "startup doctor did not permit dispatch resume", { reconcile: report });
        }
      }

      report.resumedRuns = await this.resumeQueuedRuns();
      report.resumedFinalizations = await this.resumeApprovedRuns();
      // #639 contract 6, at the moment it matters most: right after a restart, before the first
      // periodic sweep would otherwise get to it. This genuinely runs and asks — it is not a
      // no-op by omission — but two independent facts limit it today, both stated in full in
      // `reconcileUnresolved`'s docstring: (1) it sweeps `canonical_turns`, which nothing in
      // production writes to yet, so it always finds nothing to sweep; and (2) even once
      // something is found, a `COMPLETED` receipt is refused unconditionally, because no
      // reply-outbox mechanism is wired to this ledger. Resolving (1) does not resolve (2).
      //
      // Not awaited. A review found this call had no bound on how long one lookup could run —
      // `reconcileUnresolved()` now times out each one internally, but a *sequence* of several
      // slow (not hung) lookups could still add up to real seconds, and startup has no reason to
      // spend them: the periodic timer below finds exactly the same unresolved rows within
      // `turnReconcileIntervalMs` regardless of whether this call ever ran. Fire-and-forget
      // through `runPeriodic` for the same backoff/audit treatment the timer gets, rather than a
      // bare `void` that would let a repeatedly-failing sweep fail silently forever.
      void this.runPeriodic("turn_reconcile", () => this.runTurnReconcile());
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

  /**
   * #734 — the one place a system-scope `DoctorReport` is produced and recorded as either a
   * success or a failure, so `resolveDoctorHealth` always has both facts current.
   *
   * A thrown probe is recorded as a failed attempt *and persisted to disk right here* — not
   * left for whichever caller happens to call `writeHealth` next. That distinction is the whole
   * fix for the counterexample the CEO found: `reconcileContinuity()`'s failure path used to
   * read as covered only because `runPeriodic`'s own catch calls `writeHealth`, which the
   * on-demand operator path (`OPERATOR_METHOD.DOCTOR_RUN`) never goes through — its outer catch
   * in `executeOperatorRequest` turns the rejection into `INTERNAL_ERROR` and returns, and
   * `DAEMON_STATUS` serves `health.json` from disk regardless. A caller-dependent persist is not
   * a persist; this method must not depend on what calls it. Every caller (`reconcile()`, the
   * periodic/reactive triggers, the on-demand operator door) now gets the same guarantee for
   * free, and none of them needs to remember to call `writeHealth` themselves on failure.
   *
   * A write failure on top of the doctor's own failure must not replace the error the caller
   * is asking about with an unrelated one — the doctor's rejection is the fact this method
   * exists to surface, so it always wins and is always what propagates. A failed persist is
   * audited (the same `DAEMON_TIMER_FAILED`/`"health"` shape `runPeriodic` already uses for an
   * unrelated write failure) rather than silently dropped, but it is secondary: it never
   * replaces or suppresses the doctor error being thrown.
   */
  private async runSystemDoctorCheck(supplementalFindings: readonly Finding[] = []): Promise<DoctorReport> {
    const at = this.cp.clock.nowIso();
    try {
      const report = await this.cp.doctor.run("system", undefined, supplementalFindings);
      this.#lastDoctorSuccess = { report };
      this.#lastDoctorAttempt = { at, ok: true };
      this.writeHealth(null);
      return report;
    } catch (err) {
      this.#lastDoctorAttempt = { at, ok: false, error: safeErrorMessage(err) };
      try {
        this.writeHealth(null);
      } catch (writeErr) {
        this.cp.audit.record({
          kind: "DAEMON_TIMER_FAILED",
          reasonCode: ReasonCode.DAEMON_TIMER_FAILED,
          evidence: { timer: "health", error: safeErrorMessage(writeErr) },
        });
      }
      throw err;
    }
  }

  /**
   * #734 — what a reader gets *right now*: the last system evaluation that finished, bounded by
   * `doctorFreshnessMs` and by whether the most recent attempt to refresh it actually landed.
   * `writeHealth` calls this on every write, so `health.json`'s `doctor` field is never older
   * than the gap between two writes — bounded, by construction, by the capacity-sensor tick that
   * drives `reconcileContinuity` on its own asserted-shorter interval.
   */
  currentDoctorHealth(): DoctorHealthSnapshot {
    return resolveDoctorHealth(
      this.#lastDoctorSuccess,
      this.#lastDoctorAttempt,
      this.cp.clock.nowIso(),
      this.options.doctorFreshnessMs ?? DEFAULT_DOCTOR_FRESHNESS_MS,
    );
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

    const report = await this.runSystemDoctorCheck();

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
      blockingFindings: blockingFindingsOf(report),
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
        // Capacity constrains the providers it manages. It has nothing to say about one it does
        // not, and "nothing to say" is not "not covered" — reading it that way evicted the only
        // authority the once-ever bootstrap can create. The generation-1 CEO runs as
        // `provider: "hermes"`, no collector writes a snapshot for that name, so `current()`
        // returned null on every pass and this predicate handed the role to continuity, which
        // replaced it with gpt/claude or revoked the binding. The bootstrap door is closed by
        // history, so there was no second one to make.
        //
        // Liveness still decides. A hermes CEO whose session is not READY falls through to
        // failover exactly as before, which is the path §15 relies on once the door is shut.
        const capacityManaged = session !== null && this.cp.capacity.manages(session.provider);
        const currentStillCovered =
          session?.lifecycle === SessionLifecycle.READY &&
          (!capacityManaged ||
            (currentCapacity !== null &&
              this.cp.capacity.isRoutableFor(currentCapacity, required.capability)));
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

      // #734 criterion 2 — capacity and continuity state changing is exactly what this method
      // is called to react to (both the periodic capacity-sensor tick and the reactive
      // provider-failure callback route through here), so it is the natural place to keep the
      // persisted doctor snapshot current between restarts. `runPeriodic` already catches and
      // backs off, so this can be awaited without changing what this method returns or throws.
      await this.runPeriodic("doctor_refresh", () => this.runSystemDoctorCheck().then(() => undefined));

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
    const capacityRefreshMs = this.options.capacityRefreshIntervalMs ?? DEFAULT_CAPACITY_REFRESH_MS;
    assertContinuityFreshnessOrdering(capacityRefreshMs);
    // The effective budget, not "was an option set" — an explicit budget larger than the
    // interval is the same broken configuration arrived at by a different route.
    const providerCount = this.cp.providers.list().length;
    assertSweepFitsItsInterval(
      capacityRefreshMs,
      this.options.capacityRefreshBudgetMs ?? sweepBudgetMs(providerCount),
      providerCount,
    );
    assertDoctorFreshnessOrdering(capacityRefreshMs, this.options.doctorFreshnessMs ?? DEFAULT_DOCTOR_FRESHNESS_MS);

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
        // The sweep's own budget, not the startup one. This is the caller that must be allowed
        // to finish: what it abandons is what goes stale, and stale capacity reads as uncovered.
        await this.refreshCapacitySensors(
          this.options.capacityRefreshBudgetMs ?? sweepBudgetMs(this.cp.providers.list().length),
        );
        await this.reconcileContinuity("periodic capacity sensor refresh");
      });
    }, capacityRefreshMs);
    capacitySensor.unref();
    this.#timers.push(capacitySensor);

    // #639 contract 6's active half: ask, on a schedule, rather than wait to be told. Before #638
    // this always asks a port that answers `found: false` — a real sweep that genuinely runs, not
    // the absence of one. Two independent facts still limit it, both stated in full in
    // `reconcileUnresolved`'s docstring: (1) `canonical_turns` has no production writer yet
    // (`ConversationTurnCoordinator.claim()` has none — #683/#639's other half), so
    // `unresolvedIdentities()` returns empty here regardless of what the port would say; and (2)
    // even once it does not, a `COMPLETED` receipt is refused unconditionally today, because no
    // reply-outbox mechanism is wired to this ledger. (1) resolving does not resolve (2).
    //
    // The interval also has to fit the sweep's own budget, for the same reason the capacity
    // sweep's budget is asserted against its interval rather than left to chance — a pass that
    // can legitimately run right up to its budget must still finish before the next one is due,
    // or the two overlap regardless of the budget existing at all.
    const turnReconcileMs = this.options.turnReconcileIntervalMs ?? 60_000;
    const turnReconcileBudgetMs = this.options.turnReconcileBudgetMs ?? RECONCILE_SWEEP_BUDGET_MS;
    if (turnReconcileBudgetMs >= turnReconcileMs) {
      throw acpError(
        ReasonCode.INVALID_ARGUMENT,
        "the turn-reconciliation sweep's own budget must fit inside its interval",
        { turnReconcileIntervalMs: turnReconcileMs, turnReconcileBudgetMs },
      );
    }
    const turnReconcile = setInterval(() => {
      void this.runPeriodic("turn_reconcile", () => this.runTurnReconcile());
    }, turnReconcileMs);
    turnReconcile.unref();
    this.#timers.push(turnReconcile);

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
  /**
   * The whole refresh is bounded, not just each probe inside it.
   *
   * `start()` awaits this, and the collectors spawn real provider CLIs — a `claude -p` that
   * answers in two seconds here, an app-server handshake that answers in three. Multiply that
   * by the providers and add a host where one of them is missing from PATH or is waiting on
   * something, and the daemon produces no output at all while a supervisor decides it never
   * started. That is a startup held hostage by a third-party binary.
   *
   * A budget makes the worst case a known one. Whatever did not answer is simply absent, and
   * absent capacity is already handled: the doctor blocks on coverage, and the bootstrap park
   * keeps the daemon alive and reachable while an operator or the periodic refresh supplies it.
   * Failing to read a quota must never be the same event as failing to start.
   */
  private async refreshCapacitySensors(budgetMs?: number): Promise<void> {
    const spendMs = budgetMs ?? this.options.capacityRefreshBudgetMs
      ?? STARTUP_CAPACITY_REFRESH_BUDGET_MS;
    let timer: NodeJS.Timeout | null = null;
    const budget = new Promise<"BUDGET_SPENT">((resolve) => {
      timer = setTimeout(() => resolve("BUDGET_SPENT"), spendMs);
      timer.unref();
    });
    try {
      const outcome = await Promise.race([this.refreshCapacitySensorsUnbounded(), budget]);
      if (outcome === "BUDGET_SPENT") {
        this.cp.audit.record({
          kind: "CAPACITY_REFRESH_ABANDONED",
          reasonCode: ReasonCode.CAPACITY_SENSOR_FILE_STALE,
          evidence: { budgetMs: spendMs, pid: process.pid },
        });
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async refreshCapacitySensorsUnbounded(): Promise<void> {
    const directory = this.cp.config.capacityDir;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);

    // The mirror must be a by-product of the monitor's persisted reading, not a parallel
    // probe. Otherwise a periodic collector ERROR could be written to disk while an older
    // operator observation remained routable in the database.
    const readings = await this.cp.capacity.refresh(RefreshTrigger.DOCTOR_CAPACITY_REPORT);
    for (const reading of readings) {
      const file = capacitySensorFile(directory, reading.provider);
      const temporary = join(directory, `.${reading.provider}.${process.pid}.${randomUUID()}.json`);
      writeFileSync(temporary, JSON.stringify(reading, null, 2), { mode: 0o600 });
      renameSync(temporary, file);
    }
  }

  /**
   * Recorded whenever the composition root or live listener changes Telegram's state, and
   * written into `health.json` immediately rather than waiting for the next periodic tick. A
   * listener that stops after startup must replace its earlier running state just as promptly.
   */
  setTelegramIngressStatus(status: IngressChannelStatus): void {
    this.#telegramIngress = status;
    this.writeHealth(null);
  }

  /** Installs the controller before operator acknowledgement can be used to recover this listener. */
  attachTelegramIngressController(controller: TelegramIngressController): void {
    this.#telegramIngressController = controller;
  }

  /** A closing old listener cannot detach a replacement installed after it. */
  detachTelegramIngressController(controller: TelegramIngressController): void {
    if (this.#telegramIngressController === controller) this.#telegramIngressController = null;
  }

  private telegramIngressFindings(): Finding[] {
    const status = this.#telegramIngress;
    if (!status?.configured || status.running) return [];
    return [{
      code: "TELEGRAM_INGRESS_STOPPED",
      severity: "ERROR",
      scope: "telegram",
      blocking: false,
      confidence: "HIGH",
      observedEvidence: {
        running: false,
        disabledReason: status.disabledReason,
        ...(status.recoveryNonce ? { recoveryNonce: status.recoveryNonce } : {}),
      },
      recommendedAction: status.recoveryNonce
        ? `inspect the UNKNOWN Telegram send, then run agentctl telegram reply acknowledge ${status.recoveryNonce} <reason-code> <evidence-digest> to resume this listener`
        : "correct the reported Telegram ingress condition and restart the daemon",
    }];
  }

  /**
   * §33.1 — health endpoint. A file the supervisor can read, and the one place a parked
   * daemon's `mode` is legible without the operator token that the socket method requires.
   * `agentctl daemon status` does not read it: it asks the socket and falls back to the lock.
   */
  writeHealth(reconcile: ReconcileReport | null): void {
    const health = {
      pid: process.pid,
      startedAt: this.#startedAt,
      at: this.cp.clock.nowIso(),
      continuityMode: this.cp.continuity.mode(),
      mode: this.#mode,
      blockingFindings: this.#bootstrapBlocking,
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
      // #734 — freshness-bounded, recomputed against the live clock on every write rather than
      // read back from whatever was last persisted. A caller that never advances the doctor
      // still gets a correct answer here: age is derived from `checkedAt`, not cached.
      doctor: this.currentDoctorHealth(),
      timerHealth: {
        status: this.#timerFailures.size === 0 ? "HEALTHY" : "DEGRADED",
        failures: Object.fromEntries(this.#timerFailures),
      },
      // `null` until `main` reports an outcome — a daemon whose composition root has not
      // gotten there yet, as opposed to one that checked and found nothing configured.
      telegram: this.#telegramIngress,
    };
    writeFileSync(join(this.options.stateDir, "health.json"), JSON.stringify(health, null, 2), {
      mode: 0o600,
    });
  }

  /**
   * `reconcileUnresolved()`, made to throw when the daemon needs to know something went wrong.
   *
   * A review found the sweep swallowed every per-turn lookup failure — correctly, so one bad turn
   * does not stop the rest from being asked about — and then always returned as though it had
   * succeeded. `runPeriodic` only backs off and audits on a thrown `action()`, so a port that
   * fails on *every* call looked, to the daemon, identical to one with nothing to find: the exact
   * ambiguity contract 6 exists to remove, just moved one layer up. This is the one place that
   * distinction is turned back into the signal `runPeriodic` already knows how to act on, so the
   * daemon needs no new mechanism for it — the same backoff and `DAEMON_TIMER_FAILED` audit the
   * watchdog and capacity timers already produce.
   */
  private async runTurnReconcile(): Promise<void> {
    const result = await this.cp.conversation.reconcileUnresolved(
      this.options.turnReconcileBudgetMs ?? RECONCILE_SWEEP_BUDGET_MS,
    );
    if (result.failed > 0) {
      throw new Error(
        `${result.failed} of ${result.swept} receipt lookup(s) failed or timed out this sweep`,
      );
    }
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

  /**
   * Hold the lock, serve only the capacity door, and re-run the doctor after each observation
   * that lands. Returns the promoting report, or null if the park was abandoned.
   *
   * Parking rather than exiting is the whole point. The exit path increments the shared
   * crash-loop record and a later attempt meets DAEMON_ALREADY_RUNNING, so an operator
   * applying the documented remedy between two exits would be answering a daemon that then
   * refuses to start for an unrelated reason. No release and no exit also means the invariant
   * a live socket implies a held lock is preserved rather than restated: `executeOperatorRequest`
   * still refuses everything when `lock.held()` is false, parked or not.
   *
   * The continuity coordinator stays uninstalled for the whole park. A parked daemon has not
   * passed its doctor, so it must not be reacting to capacity events by moving bindings.
   */
  private async parkForBootstrap(
    blocked: ReconcileReport,
    open: () => Promise<BootstrapDoor>,
  ): Promise<ReconcileReport | null> {
    this.uninstallContinuityCoordinator();
    this.#mode = "BOOTSTRAP";
    this.#bootstrapBlocking = blocked.blockingFindings;
    this.writeHealth(blocked);
    this.cp.audit.record({
      kind: "DAEMON_BOOTSTRAP_PARKED",
      reasonCode: ReasonCode.DAEMON_BOOTSTRAP_MODE,
      evidence: {
        pid: process.pid,
        blockingFindings: blocked.blockingFindings,
        admittedMethods: [...BOOTSTRAP_OPERATOR_METHODS].sort(),
      },
    });

    let door: BootstrapDoor | null = null;
    // Every pass that mutates contributes to what this start did. A report carrying only the
    // last sweep says the start did less than it did.
    let applied = blocked;
    try {
      // Arm before the door opens. A door that admits an observation the instant it binds must
      // not be able to signal a park that has not started counting yet.
      let consumed = this.#bootstrapSignal;
      door = await open();
      for (;;) {
        if (this.#bootstrapAbandoned) return null;
        if (this.#bootstrapSignal === consumed) {
          await this.awaitBootstrapSignal();
          continue;
        }
        // Consume every signal outstanding at this moment, not one: the re-check below reads
        // current state, so two observations that arrived together are answered by one pass.
        consumed = this.#bootstrapSignal;

        // The doctor alone, not `reconcile()`. That sweep expires claims and outbox messages,
        // reclaims finalization leases, marks dead sessions ERROR and abandons orphaned
        // executions — startup actions a healthy daemon performs exactly once. Repeating them
        // on every operator observation destroys state a started daemon would have kept, and
        // the park has neither the delivery timer nor the continuity coordinator that make
        // those sweeps safe to act on.
        const doctorReport = await this.cp.doctor.run("system");
        if (this.#bootstrapAbandoned) return null;
        let blockingFindings = blockingFindingsOf(doctorReport);

        if (doctorReport.status !== "BLOCKED" && doctorReport.status !== "ERROR") {
          const swept = await this.reconcile();
          if (this.#bootstrapAbandoned) return null;
          if (swept.doctorStatus !== "BLOCKED" && swept.doctorStatus !== "ERROR") {
            this.cp.audit.record({
              kind: "DAEMON_BOOTSTRAP_PROMOTED",
              evidence: { pid: process.pid, doctorStatus: swept.doctorStatus },
            });
            // Only here: an abandoned park is followed by stop(), which has already uninstalled.
            this.installContinuityCoordinator();
            return { ...mergeReconciled(applied, swept), bootstrapParked: true };
          }
          // The sweep ran and the doctor still blocks. Its mutations happened, so they belong
          // to whatever report this start eventually produces.
          applied = mergeReconciled(applied, swept);
          blockingFindings = swept.blockingFindings;
        }

        // One site, both branches. Re-read the park's own precondition: a block can drift into
        // one no observation can clear, and the finding this exists for —
        // CTO_BINDING_POINTS_AT_DEAD_SESSION — is raised only after a session's lifecycle is
        // ERROR, which is something the sweep above does and the doctor-only pass never can.
        // Checking only where the finding cannot appear is not checking.
        if (!canParkForBootstrap(blockingFindings)) {
          this.cp.audit.record({
            kind: "DAEMON_BOOTSTRAP_ABANDONED",
            reasonCode: ReasonCode.DAEMON_BOOTSTRAP_MODE,
            evidence: { pid: process.pid, blockingFindings },
          });
          return null;
        }

        this.#bootstrapBlocking = blockingFindings;
        this.writeHealth(null);
      }
    } finally {
      this.#mode = "NORMAL";
      this.#bootstrapBlocking = [];
      this.#bootstrapWaiter = null;
      this.#bootstrapAbandoned = false;
      this.#bootstrapSignal = 0;
      // The door closes before this returns, on both exits. The promoting caller opens the
      // real operator socket on the same path, and an abandoned park must not leave a
      // restricted listener behind a released lock.
      await door?.close();
    }
  }

  /**
   * Sleep until an observation arrives, or until the re-check interval expires — whichever is
   * first. The timeout exists because the operator door must not be the only way out: a
   * capacity/coverage block is exactly what an automatic collector can also clear, and the
   * release-and-exit path this replaces got that re-read for free from the supervisor restarting
   * the process.
   *
   * A contradicted conversation parks here too now, and that one the timer cannot clear — only an
   * adjudication can, which is why that door signals this waiter the way the capacity door does.
   * The timer is then a re-read that finds the same finding, not a way out.
   */
  private async awaitBootstrapSignal(): Promise<void> {
    const intervalMs = this.options.bootstrapRecheckIntervalMs ?? DEFAULT_CAPACITY_REFRESH_MS;
    let timer: NodeJS.Timeout | null = null;
    try {
      await new Promise<void>((resolve) => {
        this.#bootstrapWaiter = resolve;
        timer = setTimeout(() => {
          void this.refreshCapacitySensors()
            .catch(() => undefined)
            .finally(() => this.wakeBootstrap("OBSERVED"));
        }, intervalMs);
        // A parked daemon is waiting on a human or a collector, never on this timer.
        timer.unref?.();
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Record the signal first, deliver second. `stop()` can land while the park is inside its
   * re-check with no waiter armed, so the abandon is latched rather than delivered — the loop
   * reads it on both sides of the re-check, whether that re-check would have slept or promoted.
   */
  private wakeBootstrap(reason: "OBSERVED" | "ABANDONED"): void {
    if (reason === "ABANDONED") this.#bootstrapAbandoned = true;
    this.#bootstrapSignal += 1;
    const waiter = this.#bootstrapWaiter;
    this.#bootstrapWaiter = null;
    waiter?.();
  }

  async stop(): Promise<void> {
    this.wakeBootstrap("ABANDONED");
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

const requiredOperatorInteger = (
  params: Record<string, unknown>,
  name: string,
  minimum: number,
): Decision<number> => {
  const value = params[name];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum
    ? allow(ReasonCode.OK, value)
    : invalidOperatorParam(name, value);
};

/**
 * A non-empty list of observation ids, over the wire.
 *
 * Non-empty because an adjudication that cites nothing is the assertion this vocabulary exists to
 * refuse; the coordinator rejects it too, and refusing here tells the operator which parameter was
 * wrong rather than which invariant they tripped.
 */
const requiredOperatorIntegerList = (
  params: Record<string, unknown>,
  name: string,
): Decision<number[]> => {
  const value = params[name];
  if (!Array.isArray(value) || value.length === 0) return invalidOperatorParam(name, value);
  const out: number[] = [];
  for (const entry of value) {
    if (typeof entry !== "number" || !Number.isSafeInteger(entry) || entry < 1) {
      return invalidOperatorParam(name, entry);
    }
    out.push(entry);
  }
  return allow(ReasonCode.OK, out);
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
