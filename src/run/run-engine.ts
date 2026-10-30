import type { DispatchCapacityTarget } from "../capacity/capacity-monitor.ts";
import { isContinuityRevocationReason } from "../continuity/continuity-kernel.ts";
import type { Clock } from "../core/clock.ts";
import { digestOf } from "../core/digest.ts";
import { type Decision, allow, deny, fail } from "../core/errors.ts";
import { newRunId } from "../core/ids.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { deriveHumanGate } from "../ceo/human-gate.ts";
import type { AuditLog } from "../db/audit.ts";
import type { ArtifactStore } from "../db/artifacts.ts";
import type { Db, RunStateTransitionAuthority } from "../db/database.ts";
import {
  normalizeHarnessIdentity,
  type BaselineHarnessInput,
  BaselineRecordKind,
  type QualityObservationInput,
} from "../export/baseline-contract.ts";
import { BaselineRecorder } from "../export/baseline-recorder.ts";
import { canTransition, isTerminal } from "../domain/run-state.ts";
import {
  ArtifactKind,
  type ContinuityMode,
  type ExecutionMode,
  type RoleBinding,
  RunKind,
  type RunPriority,
  RunState,
  type RunRow,
  roleKeyFor,
  Role,
} from "../domain/types.ts";
import { MessageKind } from "../outbox/envelope.ts";
import type { Outbox } from "../outbox/outbox.ts";
import { ContractChangeRefusal } from "../registry/contract-change-plan.ts";
import type { ProjectRegistry } from "../registry/project-registry.ts";
import type { RepositoryRegistry } from "../registry/repository-registry.ts";
import type { Telemetry } from "../telemetry/telemetry.ts";
import type { ClaimRegistry } from "../claims/claim-registry.ts";
import type { TaskGraph } from "./task-graph.ts";
import {
  TASK_BRANCH_CREATED,
  TASK_BRANCH_CREATING,
  TASK_BRANCH_CREATION_UNDONE,
  unresolvedCreationAttempt,
} from "./task-write-target.ts";
import { type HermesAdmittedTurn, hermesTurnEvidence } from "../mcp/hermes-provenance.ts";

/** PRD §13.1 — the authoritative specification Hermes writes. */
export interface TaskContract {
  goal: string;
  why: string;
  scope: string[];
  nonGoals: string[];
  acceptance: string[];
  priority: RunPriority;
  humanGate: string[];
  references: string[];
}

/**
 * Who is allowed to write a COMPLETED run state.
 *
 * A token, not a string. It was a string literal, which meant any in-process caller could
 * complete a run by passing `"production-gate"` — the authority was documentation, not a
 * fence. The token is minted behind a private symbol and handed out once per kind by
 * `RunEngine.issueCompletionAuthorities`, which the composition root calls; nothing else can
 * construct one, and the type is exported without the constructor.
 */
const COMPLETION_MINT = Symbol("acp.completion-authority");

class CompletionAuthorityToken {
  readonly #mint: symbol;
  constructor(mint: symbol, readonly source: "daemon-finalizer" | "bootstrap-activation") {
    if (mint !== COMPLETION_MINT) {
      throw new Error("completion authority cannot be constructed outside the run engine");
    }
    this.#mint = mint;
  }

  static isValid(value: unknown): value is CompletionAuthority {
    return value instanceof CompletionAuthorityToken && value.#mint === COMPLETION_MINT;
  }

  static hasSource(
    value: unknown,
    source: "daemon-finalizer" | "bootstrap-activation",
  ): value is CompletionAuthority {
    return CompletionAuthorityToken.isValid(value) && value.source === source;
  }
}

export type CompletionAuthority = CompletionAuthorityToken;

/**
 * #246 B2-b — whether `value` is the daemon finalizer's completion capability. A CONTRACT_CHANGE's
 * manifest is activated only in the transaction that completes the run, by the holder of this token.
 */
export const isDaemonFinalizerCompletion = (value: unknown): value is CompletionAuthority =>
  CompletionAuthorityToken.hasSource(value, "daemon-finalizer");

export interface CompletionAuthoritySet {
  /** Held only by the daemon finalizer for ordinary production runs. */
  readonly daemonFinalizer: CompletionAuthority;
  /** Compatibility alias for fixture code; it is the same daemon-only capability. */
  readonly productionGate: CompletionAuthority;
  readonly bootstrapActivation: CompletionAuthority;
}

const ISSUED_COMPLETION_AUTHORITIES = new Set<string>();

/** #1189 B5 — the refusal `RunEngine.returnApprovedCandidate` sends an approved candidate back for. */
export interface ApprovedCandidateReturn {
  candidateSnapshotDigest: string;
  attemptId: string;
  reasonCode: ReasonCode;
  reason: string;
  unrecoverable: boolean;
}

export interface CreateRunInput {
  projectId?: string | null;
  kind?: RunKind;
  executionMode: ExecutionMode;
  priority?: RunPriority;
  contract: TaskContract;
  /** Optional exact harness identity for an ACP 2.0 baseline; missing values remain null. */
  baselineHarness?: BaselineHarnessInput;
  repositories?: ReadonlyArray<{
    repositoryId: string;
    repositoryRole: string;
    baseBranch: string;
    mergeOrder?: number;
  }>;
  /** The Hermes turn the CEO door admitted this call for, recorded in RUN_CREATED; absent in process. */
  hermesTurn?: HermesAdmittedTurn;
}

/** Provisioning a primary CTO belongs to the CTO lifecycle; the run engine only asks. */
export interface CtoProvisioner {
  ensurePrimaryCto(projectId: string, runId: string): Promise<Decision<RoleBinding>>;
  isDraining(projectId: string): boolean;
  /**
   * The provider this project's primary CTO will actually be constituted on — the session
   * already bound to the role, or the preference dispatch is about to spawn. Required, not
   * optional: an admission target that can silently go missing is the targetless
   * admission this closes (§14.2, findings #53/#179).
   */
  plannedProvider(projectId: string): string | null;
}

/**
 * Issue #246 — staffing a project-less PROJECT_BOOTSTRAP run's `BOOTSTRAP_CTO(run)`, which the run
 * engine only asks for (`BootstrapCtoStaffing` answers). Dispatch calls `admit` before capacity,
 * `ensure` after it, and `bindForDispatch` inside the transaction that pins the owner; a terminal
 * transition calls `release` in its own transaction.
 */
export interface BootstrapCtoProvisioner {
  /** The fixed provider a fresh bootstrap CTO is constituted on, for dispatch admission. */
  readonly provider: string;
  admit(run: RunRow): Decision<RoleBinding | null>;
  ensure(runId: string): Promise<Decision<BootstrapCtoStaffedSession>>;
  bindForDispatch(runId: string, staffed: BootstrapCtoStaffedSession): Decision<RoleBinding>;
  discard(staffed: BootstrapCtoStaffedSession, reason: string): Promise<void>;
  release(runId: string, reason: string): void;
}

/**
 * #512 — retiring a run's WORKER bindings when the run ends, which the run engine only asks for
 * (`WorkerRetirement` answers). A terminal transition calls `retireRun` in its own transaction.
 */
export interface WorkerRetirementPort {
  retireRun(runId: string, state: RunState): unknown;
}

/** A session `ensure` staffed: freshly spawned and unbound, or the live binding it reuses. */
export interface BootstrapCtoStaffedSession {
  sessionId: string;
  reused: RoleBinding | null;
}

/** §14.2 — capacity must be refreshed before dispatch admission. */
export interface CapacityGate {
  refreshForDispatch(target?: DispatchCapacityTarget): Promise<Decision<void>>;
}

/** Read-only view of the same registry used by the capacity monitor and runtime. */
export interface AdmissionProviderScope {
  hasRoleScoped(provider: string): boolean;
}

/**
 * The capability a primary CTO consumes. Named the same way the continuity kernel names
 * it, because the two must agree about what a CTO needs to be routable for (§15.1).
 */
const CTO_CAPABILITY = "cto";

export interface ContinuityGate {
  mode(): ContinuityMode;
  /** How long ago coverage was actually computed. A verdict older than this is not evidence. */
  modeAgeMs?(): number;
  /** Compatibility port; coverage observations are advisory. */
  assertCompletionAllowed?(runId: string): Decision<void>;
  /** Refreshes advisory coverage observations. */
  evaluate?(reason: string): Promise<unknown>;
}

/** §15.6's freshness window, the same one `assertCompletionAllowed` applies by default. */
export const CONTINUITY_MODE_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * What CEO review asks of a run continuity would hand back to it: whether its human gate is satisfied.
 * The production gate answers; with no port attached nothing is handed back.
 */
export interface CeoReviewGate {
  humanGateStatus(runId: string): { satisfied: boolean };
}

/** The state reason a run carries after continuity hands its own CEO-review wait back. */
export const CONTINUITY_REVIEW_RELEASE_REASON = "continuity restored the role its pause named; back to CEO review";

/** Continuity's own wait at CEO review, as `RunEngine.#continuityReviewHold` found it. */
interface ContinuityReviewHold {
  pauseEventId: number;
  candidateSnapshotDigest: string;
}

/**
 * An owner by identity: the role, the session it is bound to and that session's incarnation, and the
 * binding generation. The binding a release would hand the run back to, or the one a pause took it from.
 */
interface ContinuityOwner {
  roleKey: string;
  sessionId: string;
  incarnation: string;
  generation: number;
}

/**
 * The revocation (or deferred revocation) continuity wrote for the loss its pause answered, in the
 * pause's own reconcile pass: the session and generation it took the role from.
 */
interface ContinuityLossEpisode {
  sessionId: string;
  generation: number;
}

/**
 * The fields a pause at CEO review records, since this change, of the owner it paused the run under —
 * the run's pin at that moment. `RunEngine.#continuityReviewHold` hands the wait back only to the same
 * role, session and incarnation.
 */
export const CONTINUITY_PAUSE_OWNER_FIELDS = {
  sessionId: "ownerSessionId",
  incarnation: "ownerSessionIncarnation",
  generation: "ownerBindingGeneration",
} as const;

/** The owner a pause recorded under `CONTINUITY_PAUSE_OWNER_FIELDS`; null when any part is missing. */
const recordedPauseOwner = (evidence: Record<string, unknown>): Omit<ContinuityOwner, "roleKey"> | null => {
  const sessionId = evidence[CONTINUITY_PAUSE_OWNER_FIELDS.sessionId];
  const incarnation = evidence[CONTINUITY_PAUSE_OWNER_FIELDS.incarnation];
  const generation = evidence[CONTINUITY_PAUSE_OWNER_FIELDS.generation];
  if (typeof sessionId !== "string" || typeof incarnation !== "string") return null;
  if (typeof generation !== "number" || !Number.isInteger(generation)) return null;
  return { sessionId, incarnation, generation };
};

/**
 * S-HOLD — the reasons `Daemon.pauseAffectedRuns` pauses an ACTIVE run with that are not themselves a
 * continuity revocation reason: a refused failover (`failover refused: <reasonCode>`) and a failover
 * that left no ready planned binding. Every other pause reason is one of continuity's revocation reasons.
 */
export const CONTINUITY_PAUSE_FAILOVER_REFUSED_PREFIX = "failover refused: ";
export const CONTINUITY_PAUSE_INCOMPLETE_FAILOVER_REASON = "failover did not leave a ready planned binding";

const isContinuityPauseReason = (reason: unknown): reason is string =>
  typeof reason === "string" &&
  (isContinuityRevocationReason(reason) ||
    reason.startsWith(CONTINUITY_PAUSE_FAILOVER_REFUSED_PREFIX) ||
    reason === CONTINUITY_PAUSE_INCOMPLETE_FAILOVER_REASON);

/** S-HOLD — a RUN_TRANSITION's evidence is continuity's own pause of an ACTIVE run, for `stateReason`. */
const isContinuityPause = (evidence: Record<string, unknown> | null, stateReason: string | null): boolean =>
  evidence !== null &&
  evidence["from"] === RunState.ACTIVE && evidence["to"] === RunState.BLOCKED &&
  evidence["continuityAction"] === "PAUSE_NEW_WORK" &&
  evidence["reason"] === stateReason && isContinuityPauseReason(evidence["reason"]);

/**
 * S-HOLD (#1162 R2-01) — the audit kinds recorded for a run that say the run itself moved: its state,
 * owner, tasks, write targets, executions and worker turns, candidates and reviews, decisions, escalations
 * and their replies, claims, leases, guards, bindings it scopes, wakes and finalization. One of these
 * after continuity's pause keeps the hold. Classified by what each emission site records, not by name
 * (#1162 r3): a kind every site of which records only a refusal, a deferral or an ignored input is not
 * listed (OUTBOX_ACK_REJECTED, GATE_REJECTED, MERGE_REFUSED, REPAIR_REFUSED, REPAIR_DRY_RUN,
 * CTO_DISPATCH_REFUSED_CANONICAL, CTO_SESSION_PROBE_FAILED, WORKER_PROBE_GROUP_UNCONFIRMED,
 * CEO_NOTIFICATION_BLOCKED, BLIND_REVIEW_MANUAL_DENIED, BLIND_REVIEW_REJECTED, RUN_DISPATCH_DEFERRED,
 * TASK_EXECUTION_LATE_RESULT_IGNORED, TASK_WORKER_TURN_LATE_RESULT_REFUSED, WORKER_RETIREMENT_DEFERRED,
 * BOOTSTRAP_CTO_RECLAIM_DEFERRED, WORKER_SESSION_STOP_FAILED, STANDARD_WORK_CONTINUATION_STALLED) and never
 * keeps it; a kind whose sites record both outcomes is movement only for the applied one
 * (`isRecordedMovement`). The S-TB branch records are movement too. A writer that leaves
 * no record, or a record of a kind added later, is still caught by the row snapshot (`#holdSnapshot`) or,
 * for a pause that predates it, by the row times. A kind whose effect was unclear is listed: listing keeps
 * the hold, the safe side.
 */
const CONTINUITY_HOLD_MUTATING_KINDS: readonly string[] = [
  "RUN_CREATED", "DISPATCHED", "RUN_TRANSITION", "RUN_PRIORITY_SET", "RUN_OWNER_RENEWED",
  "RECOVERY_TAKEOVER", "PRIMARY_CTO_ACTIVATED", "PRIMARY_CTO_UNDELIVERABLE_REPLACED",
  "PRIMARY_CTO_DRIVEN_SESSION_SPAWNED", "PRIMARY_CTO_DRIVEN_SPAWN_CLEANUP",
  "BINDING_CREATED", "BINDING_RENEWED", "BINDING_RUNTIME_MOVED", "BINDING_SWITCHED",
  "TASK_GRAPH_SUBMITTED", "TASK_GRAPH_CANCELLED", "TASK_WRITE_TARGET_RECORDED", "TASK_BRANCH_PREPARED",
  TASK_BRANCH_CREATING, TASK_BRANCH_CREATED, TASK_BRANCH_CREATION_UNDONE,
  "TASK_EXECUTION_STARTED", "TASK_EXECUTION_FINISHED",
  "TASK_EXECUTIONS_ABANDONED_FOR_TAKEOVER", "TASK_WORKER_TURN_STARTED", "TASK_WORKER_TURN_SUCCEEDED",
  "TASK_WORKER_TURN_FAILED", "TASK_WORKER_TURN_GIT_STOPPED", "TASK_WORKER_TURNS_DRAINED",
  "TASK_WORKER_ORPHAN_KILLED", "TASK_WORKER_ORPHAN_GONE", "TASK_WORKER_ORPHAN_UNIDENTIFIED",
  "TASK_WORKER_ORPHAN_RESOLVED", "WORKER_RETIRED",
  "CANDIDATE_FROZEN", "CANDIDATE_PROMOTED", "CANDIDATE_INVALIDATED", "CANDIDATE_PIPELINE_ATTEMPT_RECLAIMED",
  "BLIND_REVIEW_COMPLETED", "BLIND_REVIEW_FALLBACK", "BLIND_REVIEW_UNAVAILABLE",
  "REVISION_RETURNED_TO_CTO", "VERIFICATION_COMPLETED",
  "CEO_DECISION", "OWNER_DECISION", "OWNER_APPROVAL_INGRESS", "OWNER_APPROVAL_CONSUMED", "CTO_ESCALATION", "CEO_NOTIFICATION",
  "BUZZ_OWNER_APPROVAL_PROMPTED", "ESCALATION_REPLY_HELD", "ESCALATION_REPLY_CARRIED",
  "ESCALATION_REPLY_HOLD_REJECTED", "OUTBOX_ACKED_IN_BAND",
  "CLAIM_ACQUIRED", "CLAIM_RELEASED", "SOURCE_READ_LEASE_ACQUIRED", "SOURCE_READ_LEASE_RELEASED",
  "MANAGED_WRITE_GUARD", "MANAGED_WRITE_GUARD_CONSUMED", "MANAGED_WRITE_GUARD_REVOKED",
  "REPOSITORY_TEMPORARY_BINDING", "MANIFEST_ACTIVATION_CONSUMER_BOUND", "PROJECT_MANIFEST_ACTIVATED",
  "STANDARD_WORK_CONTINUATION_WAKE", "BOOTSTRAP_PLAN_RECOVERY_WAKE", "BOOTSTRAP_RESULT_RECOVERY_WAKE",
  "BOOTSTRAP_REVIEW_RETRY_WAKE", "BOOTSTRAP_PLAN_TASKS", "BOOTSTRAP_TASKS_SUPERSEDED", "BOOTSTRAP_TASK_SETTLED",
  "BOOTSTRAP_CTO_SESSION_SPAWNED", "BOOTSTRAP_CTO_PROVISIONED", "BOOTSTRAP_CTO_RECOVERED", "BOOTSTRAP_ACTIVATED", "BOOTSTRAP_ACTIVATION_INCOMPLETE",
  "BOOTSTRAP_ACTIVATION_READY_FOR_CONFIRM", "BOOTSTRAP_APPLICATION_APPROVAL", "BOOTSTRAP_APPLICATION_ATTEMPT",
  "BOOTSTRAP_APPLICATION_LEDGER_STAGE", "BOOTSTRAP_APPLICATION_RESERVED", "BOOTSTRAP_APPLICATION_WRITE_RECEIPTED",
  "HANDOFF_SUBMITTED", "HANDOFF_ACK",
  "FINALIZATION_ATTEMPT_ACQUIRED", "FINALIZATION_ATTEMPT_FAILED", "FINALIZATION_ATTEMPT_RECLAIMED",
  "FINALIZATION_BLOCKED_POST_MERGE", "FINALIZATION_POST_MERGE_RESUMED", "FINALIZATION_COMPLETED", "FINALIZATION_COMPLETION_RECONCILED",
  "PRODUCTION_GATE_PUBLISHED", "MERGE_EXECUTED", "MERGE_REPLAY", "MERGE_BASE_DRIFT", "POST_MERGE_FAILED", "POST_MERGE_NO_CHECKS_DECLARED",
  "HOTFIX_PROPAGATION", "REPAIR_EXECUTED",
  "BASELINE_HARNESS_PINNED", "BASELINE_HARNESS_DISPATCH_CONTEXT", "BASELINE_ROLE_SESSION",
  "BASELINE_INVOCATION_STARTED", "BASELINE_INVOCATION_FINISHED", "BASELINE_USAGE_RECORDED",
  "BASELINE_GRAPH_SNAPSHOT", "BASELINE_TASK_CLASSIFICATION", "BASELINE_QUALITY_OBSERVATION", "BASELINE_RUN_OUTCOME",
];

/**
 * #1162 r3 — whether a listed record is movement by its recorded outcome. The two listed kinds whose sites
 * record both outcomes count only the applied one: a MANAGED_WRITE_GUARD evaluation whose evidence says
 * `allowed: false` granted nothing, and a PRIMARY_CTO_DRIVEN_SPAWN_CLEANUP that could not stop its session
 * (SESSION_STOP_FAILED) changed nothing. An outcome that cannot be read counts as movement.
 */
const isRecordedMovement = (row: { kind: string; reason_code: string | null; evidence_json: string }): boolean => {
  if (row.kind === "MANAGED_WRITE_GUARD") return auditEvidence(row.evidence_json)?.["allowed"] !== false;
  if (row.kind === "PRIMARY_CTO_DRIVEN_SPAWN_CLEANUP") return row.reason_code !== ReasonCode.SESSION_STOP_FAILED;
  return true;
};

/** The pause evidence field that carries `#holdSnapshot` at the pause (S-HOLD, CEO 3b9d8289). */
const HOLD_SNAPSHOT_FIELD = "holdSnapshotDigest";

/** S-HOLD — a binding change of a role whose loss pauses the run, other than the held role's own. */
const CONTINUITY_HOLD_BINDING_KINDS = [
  "BINDING_CREATED", "BINDING_RENEWED", "BINDING_REVOKED", "BINDING_SWITCHED", "BINDING_RUNTIME_MOVED",
  "CONTINUITY_REVOKE_DEFERRED", "RECOVERY_TAKEOVER",
] as const;

/** An audit row's evidence as a plain object, or null when it is not one. */
const auditEvidence = (json: string): Record<string, unknown> | null => {
  try {
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

export class RunEngine {
  /**
   * §29 authority. The database refuses `UPDATE runs SET state` unless this operation raised
   * its marker, so the engine is the only component that can move a run — a raw caller can
   * take a *legal* edge only by going through here, which also writes the transition evidence
   * and the outbox envelope in the same transaction (#66).
   */
  readonly #stateTransitions: RunStateTransitionAuthority;

  #cto: CtoProvisioner | null = null;
  #bootstrapCto: BootstrapCtoProvisioner | null = null;
  #workerRetirement: WorkerRetirementPort | null = null;
  #capacity: CapacityGate | null = null;
  #continuity: ContinuityGate | null = null;
  #ceoReview: CeoReviewGate | null = null;
  readonly #baseline: BaselineRecorder;

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly audit: AuditLog,
    private readonly artifacts: ArtifactStore,
    private readonly outbox: Outbox,
    private readonly projects: ProjectRegistry,
    private readonly repositories: RepositoryRegistry,
    private readonly tasks: TaskGraph,
    private readonly claims: ClaimRegistry,
    private readonly telemetry: Telemetry,
    // Omission supports legacy standalone engines only. A scoped monitor still rejects
    // their provider-only targets; the production composition root always supplies this.
    private readonly providerScope?: AdmissionProviderScope,
  ) {
    this.#stateTransitions = db.claimRunStateTransitionAuthority();
    this.#baseline = new BaselineRecorder(db, clock, audit);
  }

  /** Wired after construction because the CTO lifecycle also needs the run engine. */
  attach(ports: {
    cto?: CtoProvisioner;
    bootstrapCto?: BootstrapCtoProvisioner;
    workerRetirement?: WorkerRetirementPort;
    capacity?: CapacityGate;
    continuity?: ContinuityGate;
    ceoReview?: CeoReviewGate;
  }): void {
    if (ports.cto) this.#cto = ports.cto;
    if (ports.bootstrapCto) this.#bootstrapCto = ports.bootstrapCto;
    if (ports.workerRetirement) this.#workerRetirement = ports.workerRetirement;
    if (ports.capacity) this.#capacity = ports.capacity;
    if (ports.continuity) this.#continuity = ports.continuity;
    if (ports.ceoReview) this.#ceoReview = ports.ceoReview;
  }

  create(input: CreateRunInput): Decision<RunRow> {
    const kind = input.kind ?? RunKind.STANDARD_WORK;
    // RF PRD:360 — a PROJECT_BOOTSTRAP run creates its project, so it names none and joins no
    // repository; its owner is the BOOTSTRAP_CTO dispatch staffs. Refused before anything is stored:
    // a project here would aim the run's activation at an existing project, whose refusal comes
    // only after the GitHub writes (#246).
    if (kind === RunKind.PROJECT_BOOTSTRAP && (input.projectId || (input.repositories?.length ?? 0) > 0)) {
      return deny(ReasonCode.INVALID_ARGUMENT, "a PROJECT_BOOTSTRAP run names no project and joins no repository", {
        refusal: input.projectId ? "BOOTSTRAP_PROJECT_SUPPLIED" : "BOOTSTRAP_REPOSITORIES_SUPPLIED",
        projectId: input.projectId ?? null,
        repositories: input.repositories?.length ?? 0,
      });
    }
    // #246 B2-a — a CONTRACT_CHANGE changes a project's contract, so it names the project. Refused
    // here, before anything is stored, rather than first at plan_submit.
    if (kind === RunKind.CONTRACT_CHANGE && !input.projectId) {
      return deny(ReasonCode.INVALID_ARGUMENT, "a CONTRACT_CHANGE run names the project whose contract it changes", {
        refusal: ContractChangeRefusal.PROJECT_MISSING,
        projectId: null,
      });
    }
    const humanGate = deriveHumanGate({
      executionMode: input.executionMode,
      goal: input.contract.goal,
      scope: input.contract.scope,
      declaredItems: input.contract.humanGate,
    });
    if (input.projectId && !this.projects.get(input.projectId)) {
      return deny(ReasonCode.NOT_FOUND, "unknown project", { projectId: input.projectId });
    }

    return this.db.tx(() => {
      const runId = newRunId();
      const contractDigest = digestOf(input.contract);
      const now = this.clock.nowIso();

      this.db.run(
        `INSERT INTO runs (run_id, project_id, kind, execution_mode, priority, state, goal,
                           contract_digest, human_gate_required, created_at)
         VALUES (?, ?, ?, ?, ?, 'QUEUED', ?, ?, ?, ?)`,
        [
          runId, input.projectId ?? null, kind, input.executionMode,
          input.priority ?? input.contract.priority, input.contract.goal, contractDigest,
          humanGate.required ? 1 : 0, now,
        ],
      );

      // §10.2 — a repository joins this run under a role the project contract declares (#530).
      //
      // `RepositoryRegistry.register` stores whatever role it is handed; it holds checkout paths
      // and deliberately does not read the contract. That left no door where an undeclared role
      // met the manifest, and the failure surfaced far downstream: with per-repository CI
      // declarations (#526) such a repository merges, and only then does its post-merge
      // verification find no declared check for its role and deny. A refusal that arrives after
      // an irreversible external write is not a refusal.
      //
      // This is the last point where refusing is still free. Registration is only the fact that a
      // repository exists; `runs.create` is the decision that it participates, and it is where
      // the run's repository set becomes fixed — nothing can join afterwards. So it is both the
      // earliest place the role means anything and the last place it costs nothing to reject.
      const declaredRoles = input.projectId
        ? this.projects.activeManifest(input.projectId)?.manifest.repositories.map((entry) => entry.role)
        : undefined;
      for (const repo of input.repositories ?? []) {
        const record = this.repositories.byId(repo.repositoryId);
        if (!record) fail(ReasonCode.NOT_FOUND, "unknown repository", repo);
        // Only when there is an active manifest to check against. A project without one has
        // declared no roles at all, and refusing there would block the bootstrap runs whose whole
        // purpose is to produce the manifest that would answer this question.
        if (declaredRoles && !declaredRoles.includes(repo.repositoryRole)) {
          fail(ReasonCode.COVERAGE_INCOMPLETE, "repository role is not declared by the project manifest", {
            repositoryId: repo.repositoryId,
            repositoryRole: repo.repositoryRole,
            declaredRoles,
          });
        }
        this.db.run(
          `INSERT INTO run_repositories (run_id, repository_id, repository_role, base_branch, merge_order)
           VALUES (?, ?, ?, ?, ?)`,
          [runId, repo.repositoryId, repo.repositoryRole, repo.baseBranch, repo.mergeOrder ?? 0],
        );
      }

      this.artifacts.put(runId, ArtifactKind.TASK_CONTRACT, input.contract);
      const schemaVersion = Number(this.db.raw.pragma("user_version", { simple: true }));
      const harness = this.#baseline.pinHarness(
        runId,
        normalizeHarnessIdentity(input.baselineHarness, Number.isInteger(schemaVersion) ? schemaVersion : null),
      );
      if (!harness.allowed) fail(harness.reasonCode, harness.message, harness.evidence);
      this.audit.record({
        kind: "RUN_CREATED",
        runId,
        projectId: input.projectId ?? null,
        evidence: {
          kind,
          executionMode: input.executionMode,
          priority: input.priority ?? input.contract.priority,
          contractDigest,
          humanGate: humanGate.items,
          humanGateRequired: humanGate.required,
          ...hermesTurnEvidence(input.hermesTurn),
        },
      });

      return allow(ReasonCode.OK, this.require(runId));
    });
  }

  /**
   * Dispatch admission (PRD §11.1, §14.2).
   *
   * This is the only place a run's owner is pinned. Everything downstream — writes,
   * claims, merges, receipts — is authorised against that pin, so the checks here are
   * the ones that keep a run from ever being owned by a stale or absent binding.
   */
  /** `hermesTurn` is the Hermes turn the CEO door admitted, recorded in this call's audit evidence. */
  async dispatch(runId: string, options: { hermesTurn?: HermesAdmittedTurn } = {}): Promise<Decision<RunRow>> {
    const run = this.get(runId);
    if (!run) return deny(ReasonCode.NOT_FOUND, "unknown run", { runId });
    if (run.state !== RunState.QUEUED && run.state !== RunState.REVISION_REQUIRED) {
      return deny(ReasonCode.RUN_TRANSITION_ILLEGAL, `run is ${run.state}`, { runId, state: run.state });
    }


    if (run.projectId) {
      const project = this.projects.require(run.projectId);
      if (project.suspended) {
        return deny(ReasonCode.RUN_QUEUED_AWAITING_CTO, "project is suspended", {
          runId,
          projectId: run.projectId,
        });
      }
      // #512 — asked before anything is provisioned, and again in the dispatch transaction.
      const repin = this.nullPinRefusal(run);
      if (!repin.allowed) return repin as Decision<RunRow>;
    }

    let binding: RoleBinding | null = null;
    // Issue #246 — a project-less PROJECT_BOOTSTRAP run's owner is the BOOTSTRAP_CTO this dispatch
    // staffs: a live binding a re-dispatch reuses, or a fresh one. Refusals that need no provider
    // (an earlier holder, a foreign pin) come before capacity, as a pinned owner's do.
    const staffsBootstrapCto = !run.projectId && run.kind === RunKind.PROJECT_BOOTSTRAP;
    if (staffsBootstrapCto) {
      if (!this.#bootstrapCto) return deny(ReasonCode.INTERNAL_ERROR, "no bootstrap CTO staffing attached", { runId });
      const admitted = this.#bootstrapCto.admit(run);
      if (!admitted.allowed) return admitted as Decision<RunRow>;
      binding = admitted.value;
    } else if (run.projectId) {
      if (this.#cto?.isDraining(run.projectId)) {
        // §10.1 — a replacement is under way; the run stays QUEUED rather than being
        // handed to a CTO that is on its way out.
        this.audit.record({
          kind: "RUN_DISPATCH_DEFERRED",
          runId,
          projectId: run.projectId,
          reasonCode: ReasonCode.RUN_DISPATCH_BLOCKED_CTO_DRAINING,
          evidence: { ...hermesTurnEvidence(options.hermesTurn) },
        });
        return deny(
          ReasonCode.RUN_DISPATCH_BLOCKED_CTO_DRAINING,
          "primary CTO is draining; run remains queued",
          { runId, projectId: run.projectId },
        );
      }
      if (!this.#cto) return deny(ReasonCode.INTERNAL_ERROR, "no CTO provisioner attached", { runId });
    } else {
      // A projectless run has no project-scoped CTO to provision. Resolve its existing
      // owner before capacity: otherwise admission has no target and hides an authority
      // failure behind CAPACITY_UNKNOWN_NOT_ROUTABLE.
      const pinned = this.projectlessOwnerBinding(run);
      if (!pinned.allowed) return pinned as Decision<RunRow>;
      binding = pinned.value;
    }

    // §14.2 — capacity is still refreshed before the first allocation or state transition.
    // Local identity validation comes first because it neither allocates nor routes, and a
    // capacity check cannot be meaningful until there is a concrete owner/provider target.
    if (this.#capacity) {
      const target = this.dispatchCapacityTarget(run, binding);
      if (!target.allowed) return target as Decision<RunRow>;
      const capacity = await this.#capacity.refreshForDispatch(
        target.value ?? undefined,
      );
      if (!capacity.allowed) return capacity as Decision<RunRow>;
    }

    if (run.projectId) {
      // §9.5 — a run against a project with no primary CTO creates one only after the
      // selected provider has passed dispatch admission.
      const provisioned = await this.#cto!.ensurePrimaryCto(run.projectId, runId);
      if (!provisioned.allowed) return provisioned as Decision<RunRow>;
      binding = provisioned.value;
    }

    // §9.5 / RF PRD:156 — the bootstrap CTO is constituted only after its provider passed
    // admission: spawned fresh (launch credential → Buzz → probe → READY → readiness), or the
    // reused binding probed live. Binding, pinning and RUN_DISPATCH are then one transaction.
    let staffed: BootstrapCtoStaffedSession | null = null;
    if (staffsBootstrapCto) {
      const ensured = await this.#bootstrapCto!.ensure(runId);
      if (!ensured.allowed) return ensured as Decision<RunRow>;
      staffed = ensured.value;
    }

    let activated: Decision<RunRow>;
    try {
      activated = this.activateDispatched(runId, binding, staffed, options.hermesTurn);
    } catch (error) {
      if (staffed) await this.#bootstrapCto!.discard(staffed, "bootstrap dispatch failed");
      throw error;
    }
    if (!activated.allowed && staffed) {
      await this.#bootstrapCto!.discard(staffed, `bootstrap dispatch refused: ${activated.reasonCode}`);
    }
    return activated;
  }

  /**
   * The dispatch transaction: re-check, bind a staffed bootstrap CTO, pin the owner, then
   * RUN_DISPATCH. A denial after the bind rolls the bind back with everything else.
   */
  private activateDispatched(
    runId: string,
    provisioned: RoleBinding | null,
    staffed: BootstrapCtoStaffedSession | null,
    hermesTurn: HermesAdmittedTurn | undefined,
  ): Decision<RunRow> {
    return this.db.txDecision(() => {
      const fresh = this.require(runId);
      const transition = canTransition(fresh.state, RunState.ACTIVE);
      if (!transition.allowed) return transition as Decision<RunRow>;

      let binding = provisioned;
      if (staffed) {
        const bound = this.#bootstrapCto!.bindForDispatch(runId, staffed);
        if (!bound.allowed) return bound as Decision<RunRow>;
        binding = bound.value;
      }

      // A caller may pin a manifest while QUEUED. That immutable pin is the dispatch
      // contract; the current project manifest is used only when no pin exists yet.
      // #512 (CEO 1edb842a) — and only for a run with no history under its NULL pin: one with history
      // is refused here, in the transaction that would otherwise pin it, never pinned silently.
      const repin = this.nullPinRefusal(fresh);
      if (!repin.allowed) return repin as Decision<RunRow>;
      const effectiveManifest =
        fresh.pinnedManifestDigest ??
        (fresh.projectId ? (this.projects.get(fresh.projectId)?.activeManifestDigest ?? null) : null);
      // The run's first pin, set by this dispatch in the same UPDATE that moves it to ACTIVE.
      const firstPin = fresh.pinnedManifestDigest === null && effectiveManifest !== null;

      // §29/§30.3 — activation, its envelope and its audit record are one operation; the
      // database refuses the state write unless this raises the marker (#66).
      this.db.applyRunStateTransition(this.#stateTransitions, {
        runId,
        toState: RunState.ACTIVE,
        recordTransitionEvidence: () => {
          const baseline = this.recordDispatchBaseline(runId, fresh, binding, effectiveManifest);
          if (!baseline.allowed) return baseline;
          this.audit.record({
            kind: "DISPATCHED",
            runId,
            projectId: fresh.projectId,
            sessionId: binding?.sessionId ?? null,
            roleKey: binding?.roleKey ?? null,
            evidence: {
              ownerBindingGeneration: binding?.bindingGeneration ?? null,
              pinnedManifestDigest: effectiveManifest,
              ...(firstPin ? { manifestPin: { firstPin: true, from: null, to: effectiveManifest } } : {}),
              ...hermesTurnEvidence(hermesTurn),
            },
          });
          return allow(ReasonCode.OK, undefined);
        },
        enqueueTransitionEnvelope: () => {
          if (!binding) return allow(ReasonCode.OK, undefined);
          const enqueued = this.outbox.enqueue({
            idempotencyKey: dispatchIdempotencyKey(runId, binding.bindingGeneration, fresh.revisionCount),
            roleKey: binding.roleKey,
            bindingGeneration: binding.bindingGeneration,
            targetSessionId: binding.sessionId,
            runId,
            kind: MessageKind.RUN_DISPATCH,
            payload: {
              runId,
              goal: fresh.goal,
              executionMode: fresh.executionMode,
              priority: fresh.priority,
              contractDigest: fresh.contractDigest,
              pinnedManifestDigest: effectiveManifest,
            },
          });
          return enqueued.allowed ? allow(ReasonCode.OK, undefined) : (enqueued as Decision<unknown>);
        },
        updateState: () =>
          this.db.run(
            `UPDATE runs SET state = 'ACTIVE', dispatched_at = ?, state_reason = ?,
                             owner_session_id = ?, owner_binding_generation = ?,
                             owner_session_incarnation = ?, owner_role_key = ?,
                             pinned_manifest_digest = COALESCE(pinned_manifest_digest, ?)
              WHERE run_id = ?`,
            [
              this.clock.nowIso(), "dispatched", binding?.sessionId ?? null,
              binding?.bindingGeneration ?? null, binding?.sessionIncarnation ?? null,
              binding?.roleKey ?? null, effectiveManifest, runId,
            ],
          ),
      });

      return allow(ReasonCode.OK, this.require(runId));
    });
  }

  /**
   * #512 (CEO 1edb842a, design E7) — a run whose pin is still NULL while its project's active manifest
   * is not is pinned to that manifest at dispatch only if this is its first pin: it has no history that
   * presumed a manifest. One that was dispatched before, or holds a PLAN, candidate, verification,
   * review, packet or approval, ran a task, or met a CEO decision is refused with a named reason
   * (`evidence.refusal`), its pin stays NULL and nothing earlier is reused: it continues only by an
   * explicit re-plan, which is a cancel and a new run with a new PLAN and a new review. That covers the
   * REVISION_REQUIRED re-dispatch, which the COALESCE below would otherwise pin to the new manifest.
   */
  private nullPinRefusal(run: RunRow): Decision<void> {
    if (run.pinnedManifestDigest !== null || !run.projectId) return allow(ReasonCode.OK, undefined);
    const active = this.projects.get(run.projectId)?.activeManifestDigest ?? null;
    if (active === null) return allow(ReasonCode.OK, undefined);
    const history = this.nullPinHistory(run);
    if (history.length === 0) return allow(ReasonCode.OK, undefined);
    return deny(
      ReasonCode.MANIFEST_PIN_SUPERSEDED,
      "this run has history under a NULL pin and its project now has an active manifest; it is not pinned to it silently and continues only by an explicit re-plan (cancel, then a new run)",
      {
        runId: run.runId,
        kind: run.kind,
        projectId: run.projectId,
        refusal: run.kind === RunKind.CONTRACT_CHANGE ? "NULL_PIN_CONTRACT_CHANGE_SUPERSEDED" : "NULL_PIN_HAS_HISTORY",
        pinnedManifestDigest: null,
        active,
        history,
        recovery: "CANCEL_AND_REPLAN",
      },
    );
  }

  /** What a run did that presumed a manifest, by kind; empty for a run with none. */
  private nullPinHistory(run: RunRow): string[] {
    const history: string[] = [];
    if (run.dispatchedAt !== null) history.push("DISPATCHED");
    for (const row of this.db.all<{ kind: string }>(
      `SELECT DISTINCT kind FROM run_artifacts
        WHERE run_id = ? AND kind IN ('PLAN','CANDIDATE_SNAPSHOT','VERIFICATION','BLIND_REVIEW','PRODUCTION_READY_PACKET','APPROVAL')
        ORDER BY kind`,
      [run.runId],
    )) {
      history.push(row.kind);
    }
    if ((this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM task_executions WHERE run_id = ?`, [run.runId])?.n ?? 0) > 0) {
      history.push("TASK_EXECUTION");
    }
    if ((this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_events WHERE run_id = ? AND kind = 'CEO_DECISION'`, [run.runId])?.n ?? 0) > 0) {
      history.push("CEO_DECISION");
    }
    return history;
  }

  /**
   * Issues the completion capabilities, once per database. The composition root claims them
   * and hands one to the production gate and one to bootstrap activation; a later caller that
   * gets hold of this engine finds them spent.
   */
  issueCompletionAuthorities(): CompletionAuthoritySet {
    if (ISSUED_COMPLETION_AUTHORITIES.has(this.db.identity)) {
      fail(
        ReasonCode.COMPLETION_AUTHORITY_DENIED,
        "completion authorities were already issued for this database",
        {},
      );
    }
    ISSUED_COMPLETION_AUTHORITIES.add(this.db.identity);
    // Handed back when the connection closes. Keyed by identity for the same reason the
    // database's own slots are: two names for one inode are one database.
    this.db.releaseOnClose(() => ISSUED_COMPLETION_AUTHORITIES.delete(this.db.identity));
    const daemonFinalizer = new CompletionAuthorityToken(COMPLETION_MINT, "daemon-finalizer");
    return {
      daemonFinalizer,
      productionGate: daemonFinalizer,
      bootstrapActivation: new CompletionAuthorityToken(COMPLETION_MINT, "bootstrap-activation"),
    };
  }

  /**
   * V1-BR-01/07 recording only: this captures the role session and the immutable harness
   * context at dispatch. It never chooses a provider or substitutes a model.
   */
  private recordDispatchBaseline(
    runId: string,
    run: RunRow,
    binding: RoleBinding | null,
    effectiveManifest: string | null,
  ): Decision<void> {
    const harness = this.#baseline.harness(runId);
    const context = this.#baseline.record(runId, BaselineRecordKind.HARNESS_DISPATCH_CONTEXT, {
      harnessDigest: harness?.digest ?? null,
      projectManifestDigest: effectiveManifest,
      contractDigest: run.contractDigest,
      ownerSessionId: binding?.sessionId ?? null,
      ownerBindingGeneration: binding?.bindingGeneration ?? null,
    });
    if (!context.allowed) return context as Decision<void>;

    if (!binding) return allow(ReasonCode.OK, undefined);
    const session = this.db.get<{
      provider: string;
      model: string;
      effort: string | null;
      incarnation: string;
    }>(
      `SELECT provider, model, effort, incarnation FROM sessions WHERE session_id = ?`,
      [binding.sessionId],
    );
    const role = this.#baseline.record(runId, BaselineRecordKind.ROLE_SESSION, {
      logicalRole: binding.role,
      provider: session?.provider ?? null,
      requestedModel: session?.model ?? null,
      observedModel: null,
      observedModelVersion: null,
      reasoningEffort: session?.effort ?? null,
      sessionId: binding.sessionId,
      sessionIncarnation: session?.incarnation ?? binding.sessionIncarnation,
      providerSessionId: null,
      bindingGeneration: binding.bindingGeneration,
      harnessDigest: harness?.digest ?? null,
      adapterVersion: harness?.identity.adapterVersion ?? null,
      toolPolicyDigest: harness?.identity.toolPolicyDigest ?? null,
      qualificationEligible: false,
    });
    return role.allowed ? allow(ReasonCode.OK, undefined) : (role as Decision<void>);
  }

  /**
   * The allocation dispatch is about to activate: the provider this run's primary CTO will
   * actually be constituted on, and the capability it has to serve. A targetless admission
   * answers "some production provider is open", which is not the question dispatch asks —
   * the CTO provider can be the one that is exhausted (§14.3).
   *
   * `null` means the project has no planned provider. A projectless run's pin is validated
   * before this method is reached, so a missing owner is reported as an authority failure
   * rather than as a targetless capacity probe.
   */
  private dispatchCapacityTarget(run: RunRow, binding: RoleBinding | null): Decision<DispatchCapacityTarget | null> {
    // A bootstrap run staffing a fresh CTO is admitted against the fixed bootstrap provider; one
    // that reuses its live binding, against that binding's session.
    const freshBootstrapCto = !run.projectId && run.kind === RunKind.PROJECT_BOOTSTRAP && !binding;
    const provider = run.projectId
      ? (this.#cto?.plannedProvider(run.projectId) ?? null)
      : freshBootstrapCto
        ? (this.#bootstrapCto?.provider ?? null)
        : this.providerOfPinnedOwner(binding?.boundSessionId ?? run.ownerSessionId);
    if (!provider) return allow(ReasonCode.OK, null);
    let scoped = false;
    if (this.providerScope) {
      try {
        const observed = this.providerScope.hasRoleScoped(provider);
        if (typeof observed !== "boolean") throw new Error("unknown provider scope");
        scoped = observed;
      } catch {
        return deny(ReasonCode.CAPACITY_UNKNOWN_NOT_ROUTABLE, "provider role scope is unavailable", { provider });
      }
    }
    // A primary CTO is a critical role, so it is never charged against the dynamic reserve
    // that exists to protect it (§14.5).
    return allow(ReasonCode.OK, {
      provider, capabilities: [CTO_CAPABILITY], priority: "critical",
      ...(scoped
        ? { role: run.projectId ? Role.PRIMARY_CTO : freshBootstrapCto ? Role.BOOTSTRAP_CTO : binding!.role }
        : {}),
    });
  }

  /** A projectless run's owner is already pinned, so its provider is a stored fact. */
  private providerOfPinnedOwner(sessionId: string | null): string | null {
    if (!sessionId) return null;
    return (
      this.db.get<{ provider: string }>(`SELECT provider FROM sessions WHERE session_id = ?`, [
        sessionId,
      ])?.provider ?? null
    );
  }

  /** Resolves the durable owner a projectless run must already have before dispatch. */
  private projectlessOwnerBinding(run: RunRow): Decision<RoleBinding> {
    if (
      !run.ownerSessionId ||
      run.ownerBindingGeneration == null ||
      !run.ownerSessionIncarnation ||
      !run.ownerRoleKey
    ) {
      return deny(ReasonCode.RUN_OWNER_NOT_PINNED, "projectless run has no pinned run-scoped owner", {
        runId: run.runId,
        kind: run.kind,
      });
    }
    const active = this.db.get<{
      session_id: string;
      session_incarnation: string;
      binding_generation: number;
      role_key: string;
      role: Role;
      project_id: string | null;
      run_id: string | null;
    }>(
      `SELECT session_id, session_incarnation, binding_generation, role_key, role, project_id, run_id
         FROM assignments WHERE role_key = ? AND status = 'ACTIVE'`,
      [run.ownerRoleKey],
    );
    if (
      !active ||
      active.role !== (run.kind === RunKind.PROJECT_BOOTSTRAP ? Role.BOOTSTRAP_CTO : Role.PRIMARY_CTO) ||
      (active.role === Role.BOOTSTRAP_CTO
        ? active.run_id !== run.runId || active.role_key !== roleKeyFor(Role.BOOTSTRAP_CTO, { runId: run.runId })
        : !active.project_id || active.role_key !== roleKeyFor(Role.PRIMARY_CTO, { projectId: active.project_id })) ||
      active.session_id !== run.ownerSessionId ||
      active.session_incarnation !== run.ownerSessionIncarnation ||
      active.binding_generation !== run.ownerBindingGeneration
    ) {
      return deny(ReasonCode.RUN_OWNER_REVOKED, "projectless run owner is not the active binding", {
        runId: run.runId,
        roleKey: run.ownerRoleKey,
      });
    }
    return allow(ReasonCode.OK, {
      assignmentId: "pinned-run-owner",
      roleKey: active.role_key,
      // A pinned owner is an identity record, so both views resolve to the pinned tuple: this
      // synthesises the binding the run named, not whatever is live now.
      boundSessionId: run.ownerSessionId ?? active.session_id,
      boundSessionIncarnation: run.ownerSessionIncarnation ?? active.session_incarnation,
      role: active.role,
      projectId: active.project_id,
      runId: active.run_id,
      taskId: null,
      sessionId: active.session_id,
      sessionIncarnation: active.session_incarnation,
      bindingGeneration: active.binding_generation,
      mode: "PREFERRED",
      status: "ACTIVE",
      createdAt: run.createdAt,
    });
  }

  /**
   * §19–21 — a state edge is not an authority. COMPLETED in particular is the claim the
   * whole runtime exists to protect, so ordinary production runs complete only after the
   * daemon finalizer has checked exact post-merge evidence. Bootstrap activation keeps its
   * own separate capability (§26.3).
   */
  transition(
    runId: string,
    to: RunState,
    reason: string,
    evidence: Record<string, unknown> = {},
    authority?: CompletionAuthority,
  ): Decision<RunRow> {
    return this.#transition(runId, to, reason, evidence, authority, null);
  }

  /**
   * #246 C1b (review ACP-C1B-02) — continuity's pause of an ACTIVE run because it can no longer
   * staff `roleKey`: ACTIVE → BLOCKED, recording in the same statement, under the same transition
   * authority, that this hold is continuity's and which role it lost. A bootstrap CTO's recovery
   * reads it to know the run may be resumed; a run BLOCKED any other way records no hold and is
   * never resumed by a recovery.
   */
  pauseForContinuity(
    runId: string,
    roleKey: string,
    reason: string,
    evidence: Record<string, unknown> = {},
  ): Decision<RunRow> {
    // S-HOLD (CEO 3b9d8289) — the pause records the digest of everything a release requires unmoved, so
    // the release compares rows, not clocks. Read synchronously right before the transition: no await, and
    // so no other writer of this process, lies between them.
    const snapshot = { ...evidence, [HOLD_SNAPSHOT_FIELD]: this.#holdSnapshot(runId) };
    return this.#transition(runId, RunState.BLOCKED, reason, snapshot, undefined, roleKey);
  }

  /**
   * S-HOLD — the digest of what continuity's hold requires unmoved: the run's current candidate, its tasks
   * (id, state, attempts, spec digest, updated_at), executions, artifacts (by digest) and candidate pipeline
   * attempts, every row in full and in a fixed order. Equal digests at the pause and at the release mean
   * none of them was written in between, whatever the clock read.
   */
  #holdSnapshot(runId: string): string {
    const run = this.db.get<{ current_candidate_digest: string | null }>(
      `SELECT current_candidate_digest FROM runs WHERE run_id = ?`,
      [runId],
    );
    const tasks = this.db.all<{ spec_json: string }>(
      `SELECT task_id, state, attempt_count, spec_json, updated_at FROM tasks WHERE run_id = ? ORDER BY task_id`,
      [runId],
    ).map(({ spec_json: spec, ...task }) => ({ ...task, spec: digestOf(spec) }));
    return digestOf({
      candidate: run?.current_candidate_digest ?? null,
      tasks,
      executions: this.db.all(`SELECT * FROM task_executions WHERE run_id = ? ORDER BY execution_id`, [runId]),
      artifacts: this.db.all(
        `SELECT artifact_id, kind, digest, candidate_snapshot_digest, produced_by, created_at, superseded
           FROM run_artifacts WHERE run_id = ? ORDER BY artifact_id`,
        [runId],
      ),
      attempts: this.db.all(`SELECT * FROM candidate_pipeline_attempts WHERE run_id = ? ORDER BY attempt_id`, [runId]),
    });
  }

  #transition(
    runId: string,
    to: RunState,
    reason: string,
    evidence: Record<string, unknown>,
    authority: CompletionAuthority | undefined,
    continuityHold: string | null,
  ): Decision<RunRow> {
    if (to === RunState.COMPLETED && !CompletionAuthorityToken.isValid(authority)) {
      return deny(
        ReasonCode.COMPLETION_AUTHORITY_DENIED,
        "only the daemon finalizer or a bootstrap activation may complete a run",
        { runId, to, supplied: typeof authority },
      );
    }
    return this.db.tx(() => {
      const run = this.require(runId);
      if (to === RunState.COMPLETED) {
        const expectedSource = run.kind === RunKind.PROJECT_BOOTSTRAP
          ? "bootstrap-activation"
          : "daemon-finalizer";
        if (!CompletionAuthorityToken.hasSource(authority, expectedSource)) {
          return deny(
            ReasonCode.COMPLETION_AUTHORITY_DENIED,
            "completion authority does not own this run kind",
            { runId, kind: run.kind, expectedSource },
          );
        }
        if (run.kind !== RunKind.PROJECT_BOOTSTRAP && run.state !== RunState.POST_MERGE_VERIFYING) {
          return deny(
            ReasonCode.RUN_TRANSITION_ILLEGAL,
            "ordinary runs may complete only after daemon exact post-merge verification",
            { runId, kind: run.kind, state: run.state },
          );
        }
        if (run.kind === RunKind.PROJECT_BOOTSTRAP && run.state !== RunState.READY_FOR_CEO_REVIEW) {
          return deny(
            ReasonCode.RUN_TRANSITION_ILLEGAL,
            "bootstrap activation may complete only from CEO review",
            { runId, kind: run.kind, state: run.state },
          );
        }
        // #246 B2-b — a CONTRACT_CHANGE completes only in the transaction that consumed its grant for
        // its current candidate and moved the project's active manifest to the one the grant names. The
        // v44 trigger `runs_contract_change_completes_activated` refuses the same write.
        // #512 — a first-activation run's own grant is in manifest_first_activation_grants, under the
        // same predicates, which the v45 body of the same trigger also reads.
        if (run.kind === RunKind.CONTRACT_CHANGE) {
          const activated = this.db.get<{ n: number }>(
            `SELECT (SELECT COUNT(*) FROM manifest_activation_grants g
                       JOIN projects p ON p.project_id = g.project_id
                      WHERE g.run_id = ? AND g.candidate_snapshot_digest IS ? AND g.consumed_at IS NOT NULL
                        AND p.active_manifest_digest IS g.manifest_digest)
                  + (SELECT COUNT(*) FROM manifest_first_activation_grants f
                       JOIN projects p ON p.project_id = f.project_id
                      WHERE f.run_id = ? AND f.candidate_snapshot_digest IS ? AND f.consumed_at IS NOT NULL
                        AND p.active_manifest_digest IS f.manifest_digest) AS n`,
            [runId, this.currentCandidate(runId), runId, this.currentCandidate(runId)],
          );
          if ((activated?.n ?? 0) !== 1) {
            return deny(
              ReasonCode.CONTRACT_CHANGE_NOT_ACTIVATED,
              "a CONTRACT_CHANGE run completes only once its grant is consumed and its manifest is active",
              { runId, candidateSnapshotDigest: this.currentCandidate(runId) },
            );
          }
        }
      }
      const check = canTransition(run.state, to, run.kind);
      if (!check.allowed) return check as Decision<RunRow>;

      const terminal = isTerminal(to);
      // §29 — the state edge, its evidence and its envelope are one operation. The database
      // refuses the update unless this raises the marker, so a legal edge cannot be taken
      // outside the runtime authority (#66).
      const applied = this.db.applyRunStateTransition(this.#stateTransitions, {
        runId,
        toState: to,
        recordTransitionEvidence: () => {
          if (terminal) {
            const baseline = this.#baseline.record(runId, BaselineRecordKind.RUN_OUTCOME, {
              state: to,
              terminal: true,
              revisionCount: run.revisionCount,
            });
            if (!baseline.allowed) return baseline;
          }
          this.audit.record({
            kind: "RUN_TRANSITION",
            runId,
            projectId: run.projectId,
            evidence: { from: run.state, to, reason, ...evidence },
          });
          return allow(ReasonCode.OK, undefined);
        },
        enqueueTransitionEnvelope: () => allow(ReasonCode.OK, undefined),
        // Every edge rewrites the continuity hold: it is set only by continuity's own pause, and any
        // other edge — out of BLOCKED above all — ends it in this same statement.
        updateState: () =>
          this.db.run(
            `UPDATE runs SET state = ?, state_reason = ?, ended_at = ?,
                             revision_count = revision_count + ?, continuity_hold_role_key = ?
              WHERE run_id = ?`,
            [
              to, reason, terminal ? this.clock.nowIso() : null, to === RunState.REVISION_REQUIRED ? 1 : 0,
              to === RunState.BLOCKED ? continuityHold : null, runId,
            ],
          ),
      });
      void applied;

      if (terminal) {
        // Issue #246 — a bootstrap run that ends (CONFIRM → COMPLETED, cancel, fail) gives back its
        // BOOTSTRAP_CTO in this same transaction; the daemon's reclaim sweep stops the session.
        if (run.kind === RunKind.PROJECT_BOOTSTRAP) this.#bootstrapCto?.release(runId, `run ${to}`);
        // An escalation reply a revocation held for this run's owner's renewal is never carried now:
        // an ended run's owner is not renewed. It is rejected here, in the transaction that ends it.
        this.outbox.rejectHeldEscalationReplies(runId, `run ${to}`);
        // #512 — and every run's WORKER bindings end with it, in this same transaction; their
        // sessions are stopped after it commits, unless something they ran is still running.
        this.#workerRetirement?.retireRun(runId, to);
        this.claims.releaseRun(runId);
        const durationMs =
          new Date(this.clock.nowIso()).getTime() - new Date(run.createdAt).getTime();
        this.telemetry.record({
          scope: "run",
          name: "outcome",
          runId,
          value: durationMs,
          text: to,
          dims: {
            mode: run.executionMode,
            priority: run.priority,
            revisionCount: run.revisionCount,
            kind: run.kind,
          },
        });
      }

      return allow(ReasonCode.OK, this.require(runId));
    });
  }

  cancel(runId: string, reason: string): Decision<RunRow> {
    return this.db.txDecision(() => {
      const run = this.get(runId);
      if (!run) return deny(ReasonCode.NOT_FOUND, "unknown run", { runId });
      const check = canTransition(run.state, RunState.CANCELLED, run.kind);
      if (!check.allowed) return check as Decision<RunRow>;
      this.tasks.cancelAll(runId, reason);
      return this.transition(runId, RunState.CANCELLED, reason);
    });
  }

  /**
   * V1-BR-04 recording boundary for facts that may arrive after review or merge. This
   * records an immutable observation only; finalization remains owned by the production
   * gate and is intentionally not changed here.
   */
  recordQualityObservation(runId: string, input: QualityObservationInput): Decision<void> {
    if (!this.get(runId)) return deny(ReasonCode.NOT_FOUND, "unknown run", { runId });
    const recorded = this.#baseline.recordQualityObservation(runId, input);
    if (!recorded.allowed) return recorded as Decision<void>;
    return allow(ReasonCode.OK, undefined);
  }

  setPriority(runId: string, priority: RunPriority): Decision<RunRow> {
    const run = this.get(runId);
    if (!run) return deny(ReasonCode.NOT_FOUND, "unknown run", { runId });
    this.db.run(`UPDATE runs SET priority = ? WHERE run_id = ?`, [priority, runId]);
    this.audit.record({
      kind: "RUN_PRIORITY_SET",
      runId,
      evidence: { from: run.priority, to: priority },
    });
    return allow(ReasonCode.OK, this.require(runId));
  }

  attachRepository(
    runId: string,
    input: {
      repositoryId: string;
      repositoryRole: string;
      baseBranch: string;
      mergeOrder?: number;
      ownerSessionId?: string;
      ownerBindingGeneration?: number;
    },
  ): Decision<void> {
    if (!this.repositories.byId(input.repositoryId)) {
      return deny(ReasonCode.NOT_FOUND, "unknown repository", input);
    }
    if (!input.ownerSessionId || input.ownerBindingGeneration == null) {
      return deny(ReasonCode.RUN_OWNER_REVOKED, "repository participation requires the current run owner", {
        runId,
      });
    }
    const ownerSessionId = input.ownerSessionId;
    const ownerBindingGeneration = input.ownerBindingGeneration;
    const owner = this.assertOwner(runId, ownerSessionId, ownerBindingGeneration);
    if (!owner.allowed) return owner as Decision<void>;
    if (owner.value.state !== RunState.ACTIVE) {
      return deny(ReasonCode.RUN_TRANSITION_ILLEGAL, "repository participation is sealed outside ACTIVE", {
        runId,
        state: owner.value.state,
      });
    }

    return this.db.tx(() => {
      const freshOwner = this.assertOwner(runId, ownerSessionId, ownerBindingGeneration);
      if (!freshOwner.allowed) return freshOwner as Decision<void>;
      if (freshOwner.value.state !== RunState.ACTIVE) {
        return deny(ReasonCode.RUN_TRANSITION_ILLEGAL, "repository participation is sealed outside ACTIVE", {
          runId,
          state: freshOwner.value.state,
        });
      }

      const mergeOrder = input.mergeOrder ?? 0;
      const existing = this.db.get<{
        repository_role: string;
        base_branch: string;
        merge_order: number;
      }>(
        `SELECT repository_role, base_branch, merge_order
           FROM run_repositories WHERE run_id = ? AND repository_id = ?`,
        [runId, input.repositoryId],
      );
      if (
        existing &&
        existing.repository_role === input.repositoryRole &&
        existing.base_branch === input.baseBranch &&
        existing.merge_order === mergeOrder
      ) {
        return allow(ReasonCode.OK, undefined);
      }

      this.db.run(
        `INSERT OR REPLACE INTO run_repositories (run_id, repository_id, repository_role, base_branch, merge_order)
         VALUES (?, ?, ?, ?, ?)`,
        [runId, input.repositoryId, input.repositoryRole, input.baseBranch, mergeOrder],
      );
      this.invalidateCandidateInTx(runId, "repository participation changed", {
        repositoryId: input.repositoryId,
        repositoryRole: input.repositoryRole,
        baseBranch: input.baseBranch,
        mergeOrder,
      });
      return allow(ReasonCode.OK, undefined);
    });
  }

  /**
   * §11.1 — verifies that the caller is the run's *current* owner. Every authority
   * operation on a run funnels through this check.
   */
  assertOwner(runId: string, sessionId: string, bindingGeneration: number): Decision<RunRow> {
    const run = this.get(runId);
    if (!run) return deny(ReasonCode.NOT_FOUND, "unknown run", { runId });
    if (!run.ownerSessionId || run.ownerBindingGeneration == null) {
      return deny(ReasonCode.RUN_OWNER_NOT_PINNED, "run has no pinned owner", { runId });
    }
    if (run.ownerSessionId !== sessionId || run.ownerBindingGeneration !== bindingGeneration) {
      return deny(ReasonCode.RUN_OWNER_REVOKED, "caller is not the current run owner", {
        runId,
        ownerSessionId: run.ownerSessionId,
        ownerBindingGeneration: run.ownerBindingGeneration,
        callerSessionId: sessionId,
        callerGeneration: bindingGeneration,
      });
    }
    if (run.ownerRoleKey) {
      const current = this.db.get<{ binding_generation: number }>(
        `SELECT binding_generation FROM assignments WHERE role_key = ? AND status = 'ACTIVE'`,
        [run.ownerRoleKey],
      );
      if (!current || current.binding_generation !== bindingGeneration) {
        return deny(ReasonCode.BINDING_GENERATION_STALE, "owner binding has been superseded", {
          runId,
          roleKey: run.ownerRoleKey,
          pinned: run.ownerBindingGeneration,
          current: current?.binding_generation ?? null,
        });
      }
    }
    return allow(ReasonCode.OK, run);
  }

  /** §10.3 — emergency takeover is the only path that repoints a live run's owner. */
  reassignOwner(runId: string, binding: RoleBinding, reason: string): Decision<RunRow> {
    return this.db.tx(() => {
      const run = this.require(runId);
      this.db.run(
        `UPDATE runs SET owner_session_id = ?, owner_binding_generation = ?,
                         owner_session_incarnation = ?, owner_role_key = ?
          WHERE run_id = ?`,
        // #493 — the owner pin is an identity, so it uses the binding-time runtime the composite
        // foreign key resolves against. `binding.sessionId` is the live routing answer and would
        // name a tuple `assignments` does not hold.
        [binding.boundSessionId, binding.bindingGeneration, binding.boundSessionIncarnation, binding.roleKey, runId],
      );
      this.tasks.abandonStaleExecutions(runId, binding.bindingGeneration, "owner generation superseded");
      this.audit.record({
        kind: "RECOVERY_TAKEOVER",
        runId,
        projectId: run.projectId,
        sessionId: binding.sessionId,
        roleKey: binding.roleKey,
        evidence: {
          reason,
          fromSession: run.ownerSessionId,
          fromGeneration: run.ownerBindingGeneration,
          toGeneration: binding.bindingGeneration,
        },
      });
      return allow(ReasonCode.OK, this.require(runId));
    });
  }

  /**
   * Promotes a freshly frozen candidate in one transaction: records it as the run's
   * current candidate and supersedes every artifact bound to an earlier one.
   *
   * A caller-managed, per-kind staleness update could be forgotten or interrupted, and
   * evidence for a superseded candidate would keep reading as current — the CP-HI-06
   * failure this closes.
   */
  promoteCandidate(runId: string, candidateSnapshotDigest: string): void {
    this.db.tx(() => {
      this.db.run(`UPDATE runs SET current_candidate_digest = ? WHERE run_id = ?`, [
        candidateSnapshotDigest,
        runId,
      ]);
      // SEC-OD1 (v48) — an owner decision bound to the earlier candidate is among these, and its
      // superseded mark needs the authority this engine holds, for this one statement.
      this.db.supersedeRunArtifacts(this.#stateTransitions, runId, candidateSnapshotDigest);
      this.audit.record({
        kind: "CANDIDATE_PROMOTED",
        runId,
        evidence: { candidateSnapshotDigest },
      });
    });
  }

  /**
   * A source or participant change makes every candidate-bound claim unusable. The
   * immutable records remain for audit, but none may be selected as current evidence.
   *
   * #664 — `invalidateCandidateInTx` below writes unconditionally, and the REVISION_REQUIRED
   * / ACTIVE transitions that follow it can each deny (a state-machine or owner-pin race).
   * A denial there must not leave the candidate invalidated without ever requesting the
   * revision it was invalidated for, so this body's own decision has to roll everything
   * back, the same as a throw would.
   */
  invalidateCandidate(
    runId: string,
    reason: string,
    evidence: Record<string, unknown> = {},
  ): Decision<RunRow> {
    return this.db.txDecision(() => {
      const run = this.require(runId);
      if (run.state === RunState.READY_FOR_CEO_REVIEW) {
        if (!run.ownerSessionId || run.ownerBindingGeneration == null) {
          return deny(ReasonCode.RUN_OWNER_NOT_PINNED, "cannot return stale candidate to an unpinned owner", {
            runId,
          });
        }
        const owner = this.assertOwner(runId, run.ownerSessionId, run.ownerBindingGeneration);
        if (!owner.allowed) return owner;
      }
      this.invalidateCandidateInTx(runId, reason, evidence);
      if (run.state === RunState.READY_FOR_CEO_REVIEW) {
        const revision = this.transition(runId, RunState.REVISION_REQUIRED, reason, evidence);
        if (!revision.allowed) return revision;
        const resumed = this.transition(runId, RunState.ACTIVE, "candidate invalidated for revision", evidence);
        if (!resumed.allowed) return resumed;
        const active = resumed.value;
        if (
          active.ownerSessionId &&
          active.ownerBindingGeneration != null &&
          active.ownerRoleKey
        ) {
          this.outbox.enqueue({
            idempotencyKey: `candidate-invalidated:${runId}:${digestOf(evidence)}`,
            roleKey: active.ownerRoleKey,
            bindingGeneration: active.ownerBindingGeneration,
            targetSessionId: active.ownerSessionId,
            runId,
            kind: MessageKind.REVISION_REQUEST,
            payload: { runId, reasonCode: ReasonCode.SNAPSHOT_STALE, ...evidence },
          });
        }
      }
      return allow(ReasonCode.OK, this.require(runId));
    });
  }

  /**
   * #1189 B5 — an approved candidate the daemon finalizer was refused before anything merged, and that will
   * not merge as it is, leaves CEO approval in one transaction: the approval is recorded as invalidated
   * (CEO_APPROVAL_INVALIDATED, naming the CONFIRM it voids), the candidate and every artifact bound to it are
   * invalidated as `invalidateCandidate` does, so that CONFIRM names nothing current, and the run moves
   * CEO_APPROVED or MERGING → REVISION_REQUIRED. A revision then goes → ACTIVE with a REVISION_REQUEST to the
   * pinned owner while that owner is current, and otherwise waits in REVISION_REQUIRED for a dispatch; an
   * unrecoverable refusal ends → FAILED with its reason. Only the refused candidate is ever invalidated, and
   * never while the run holds a merge_execute receipt: a merge that may have landed stays on the post-merge
   * path. That receipt check is this method's alone; the schema v53 guard opens the edge and reads no receipt.
   * A refusal anywhere in the body (an audit, the state edges, the request) rolls back every write before it.
   */
  returnApprovedCandidate(runId: string, input: ApprovedCandidateReturn): Decision<RunRow> {
    return this.db.txDecision(() => {
      const run = this.require(runId);
      if (run.state !== RunState.CEO_APPROVED && run.state !== RunState.MERGING) {
        return deny(ReasonCode.RUN_TRANSITION_ILLEGAL, `an approved candidate is returned only from CEO_APPROVED or MERGING, not ${run.state}`, {
          runId,
          state: run.state,
        });
      }
      if (this.currentCandidate(runId) !== input.candidateSnapshotDigest) {
        return deny(ReasonCode.EVIDENCE_STALE, "the refused candidate is no longer the run's current candidate", {
          runId,
          candidateSnapshotDigest: input.candidateSnapshotDigest,
          currentCandidateSnapshotDigest: this.currentCandidate(runId),
        });
      }
      if (this.db.get(`SELECT 1 AS held FROM github_receipts WHERE run_id = ? AND operation = 'merge_execute' LIMIT 1`, [runId])) {
        return deny(ReasonCode.FINALIZATION_COMPENSATION_REQUIRED, "a merge may have landed, so the approval stays on the post-merge path", {
          runId,
        });
      }
      const disposition = input.unrecoverable ? "UNRECOVERABLE" : "REVISION";
      const confirmed = this.audit.forRun(runId).reverse().find((entry) =>
        entry.kind === "CEO_DECISION" &&
        entry.evidence.decision === "CONFIRM" &&
        entry.evidence.candidateSnapshotDigest === input.candidateSnapshotDigest);
      const invalidated = this.audit.record({
        kind: "CEO_APPROVAL_INVALIDATED",
        runId,
        projectId: run.projectId,
        reasonCode: input.reasonCode,
        evidence: {
          from: run.state,
          candidateSnapshotDigest: input.candidateSnapshotDigest,
          attemptId: input.attemptId,
          disposition,
          approvedBy: confirmed?.sessionId ?? null,
          approvedAt: confirmed?.at ?? null,
          reason: input.reason,
        },
      });
      if (!invalidated.allowed) return invalidated as Decision<RunRow>;
      const evidence = {
        candidateSnapshotDigest: input.candidateSnapshotDigest,
        attemptId: input.attemptId,
        failureReasonCode: input.reasonCode,
        disposition,
      };
      this.invalidateCandidateInTx(runId, input.reason, evidence);
      const revision = this.transition(runId, RunState.REVISION_REQUIRED, input.reason, evidence);
      if (!revision.allowed) return revision;
      if (input.unrecoverable) return this.transition(runId, RunState.FAILED, input.reason, evidence);
      if (!run.ownerSessionId || run.ownerBindingGeneration == null || !run.ownerRoleKey ||
          !this.assertOwner(runId, run.ownerSessionId, run.ownerBindingGeneration).allowed) {
        return allow(ReasonCode.OK, this.require(runId));
      }
      const resumed = this.transition(runId, RunState.ACTIVE, "approved candidate returned for revision", evidence);
      if (!resumed.allowed) return resumed;
      // One request per revision cycle (the REVISION_REQUIRED edge above counted it), as a CEO FINAL_REVISE's is;
      // a request the outbox refuses undoes the whole return, so the run is never ACTIVE with nobody told.
      const requested = this.outbox.enqueue({
        idempotencyKey: `approved-candidate-returned:${runId}:r${revision.value.revisionCount}:${input.candidateSnapshotDigest}`,
        roleKey: run.ownerRoleKey,
        bindingGeneration: run.ownerBindingGeneration,
        targetSessionId: run.ownerSessionId,
        runId,
        kind: MessageKind.REVISION_REQUEST,
        payload: {
          runId,
          reasonCode: input.reasonCode,
          candidateSnapshotDigest: input.candidateSnapshotDigest,
          reason: input.reason,
          action: "fix the refusal and freeze a new candidate; it is verified, reviewed and confirmed again. " +
            "A branch already published at the refused candidate is never moved, so publish the new one on a new branch.",
        },
      });
      if (!requested.allowed) return requested as Decision<RunRow>;
      return allow(ReasonCode.OK, this.require(runId));
    });
  }

  private invalidateCandidateInTx(
    runId: string,
    reason: string,
    evidence: Record<string, unknown>,
  ): void {
    const current = this.currentCandidate(runId);
    this.db.run(`UPDATE runs SET current_candidate_digest = NULL WHERE run_id = ?`, [runId]);
    // SEC-OD1 (v48) — under this engine's authority, as `promoteCandidate`: owner decisions are candidate-bound.
    this.db.supersedeRunArtifacts(this.#stateTransitions, runId, null);
    this.audit.record({
      kind: "CANDIDATE_INVALIDATED",
      runId,
      reasonCode: ReasonCode.SNAPSHOT_STALE,
      evidence: { reason, previousCandidateSnapshotDigest: current, ...evidence },
    });
  }

  /** The candidate every evidence read for this run must agree with. */
  currentCandidate(runId: string): string | null {
    return (
      this.db.get<{ current_candidate_digest: string | null }>(
        `SELECT current_candidate_digest FROM runs WHERE run_id = ?`,
        [runId],
      )?.current_candidate_digest ?? null
    );
  }

  /**
   * CP-HI-03 — the dispatch-time pin is what judges the candidate, so it is written once.
   * A later "correction" would silently change the contract a run is measured against.
   */
  pinManifest(runId: string, digest: string): Decision<void> {
    const row = this.db.get<{ pinned_manifest_digest: string | null; state: string }>(
      `SELECT pinned_manifest_digest, state FROM runs WHERE run_id = ?`,
      [runId],
    );
    if (!row) return deny(ReasonCode.NOT_FOUND, "unknown run", { runId });
    if (row.pinned_manifest_digest === digest) return allow(ReasonCode.OK, undefined);
    if (row.pinned_manifest_digest) {
      return deny(
        ReasonCode.CANDIDATE_CANNOT_WEAKEN_CONTRACT,
        "a run's pinned manifest is immutable once set",
        { runId, pinned: row.pinned_manifest_digest, requested: digest },
      );
    }
    if (row.state !== RunState.QUEUED && row.state !== RunState.ACTIVE) {
      return deny(ReasonCode.RUN_TRANSITION_ILLEGAL, `run is ${row.state}; too late to pin`, {
        runId,
        state: row.state,
      });
    }
    this.db.run(`UPDATE runs SET pinned_manifest_digest = ? WHERE run_id = ?`, [digest, runId]);
    return allow(ReasonCode.OK, undefined);
  }

  get(runId: string): RunRow | null {
    const row = this.db.get<RawRun>(`SELECT * FROM runs WHERE run_id = ?`, [runId]);
    return row ? hydrate(row) : null;
  }

  require(runId: string): RunRow {
    return this.get(runId) ?? fail(ReasonCode.NOT_FOUND, "unknown run", { runId });
  }

  list(filter: { state?: RunState; projectId?: string } = {}): RunRow[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.state) {
      clauses.push("state = ?");
      params.push(filter.state);
    }
    if (filter.projectId) {
      clauses.push("project_id = ?");
      params.push(filter.projectId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    // `rowid` makes the order total: runs created in one millisecond come back in insertion order.
    return this.db.all<RawRun>(`SELECT * FROM runs ${where} ORDER BY created_at, rowid`, params).map(hydrate);
  }

  activeRunsOwnedBy(sessionId: string): RunRow[] {
    return this.db
      .all<RawRun>(
        `SELECT * FROM runs WHERE owner_session_id = ?
          AND state IN ('QUEUED','ACTIVE','BLOCKED','READY_FOR_CEO_REVIEW','CEO_APPROVED',
                        'MERGING','POST_MERGE_VERIFYING','REVISION_REQUIRED','AWAITING_HUMAN')`,
        [sessionId],
      )
      .map(hydrate);
  }

  repositoriesOf(runId: string): Array<{
    repositoryId: string;
    identity: string;
    checkoutPath: string;
    repositoryRole: string;
    baseBranch: string;
    workBranch: string | null;
    worktreeId: string | null;
    mergeOrder: number;
    mergeState: string;
    activeManifestDigest: string | null;
  }> {
    return this.db.all(
      `SELECT rr.repository_id AS repositoryId, r.identity, r.checkout_path AS checkoutPath,
              rr.repository_role AS repositoryRole, rr.base_branch AS baseBranch,
              rr.work_branch AS workBranch, rr.worktree_id AS worktreeId,
              rr.merge_order AS mergeOrder, rr.merge_state AS mergeState,
              r.active_manifest_digest AS activeManifestDigest
         FROM run_repositories rr JOIN repositories r ON r.repository_id = rr.repository_id
        WHERE rr.run_id = ? ORDER BY rr.merge_order, r.identity`,
      [runId],
    );
  }

  setRepositoryWork(
    runId: string,
    repositoryId: string,
    work: { workBranch?: string | null; worktreeId?: string | null },
  ): void {
    this.db.run(
      `UPDATE run_repositories SET work_branch = COALESCE(?, work_branch),
                                   worktree_id = COALESCE(?, worktree_id)
        WHERE run_id = ? AND repository_id = ?`,
      [work.workBranch ?? null, work.worktreeId ?? null, runId, repositoryId],
    );
  }

  setRepositoryMergeState(runId: string, repositoryId: string, state: string): void {
    this.db.run(
      `UPDATE run_repositories SET merge_state = ? WHERE run_id = ? AND repository_id = ?`,
      [state, runId, repositoryId],
    );
  }

  ownerRoleKeyFor(run: RunRow): string | null {
    if (run.ownerRoleKey) return run.ownerRoleKey;
    if (run.kind === RunKind.PROJECT_BOOTSTRAP) return roleKeyFor(Role.BOOTSTRAP_CTO, { runId: run.runId });
    return run.projectId ? roleKeyFor(Role.PRIMARY_CTO, { projectId: run.projectId }) : null;
  }

  /**
   * #246 C1b — the last step of a bootstrap CTO's same-session recovery, taken only after the
   * renewed binding's runtime received its rotated credential and attested over an authenticated
   * connection. In one transaction the owner pin moves from the revoked generation to `renewed`;
   * what else happens is decided by the hold the run is in, never by the recovery (review
   * ACP-C1B-02, -03):
   *
   * - BLOCKED under continuity's own hold (`pauseForContinuity`), whichever of the run's roles it
   *   lost: the pause is released — BLOCKED → ACTIVE, the hold cleared, and RUN_DISPATCH enqueued
   *   for the new generation in this dispatch cycle. The pause was continuity's answer to lost
   *   coverage, and a recovery runs only from its restore pass once the fixed runtime covers the
   *   role again; the renewed CTO decides what any other role it lost needs (a fresh worker, say).
   * - AWAITING_HUMAN under continuity's own wait at CEO review for this role, with nothing moved
   *   since (`#continuityReviewHold`): the wait is handed back — AWAITING_HUMAN → ACTIVE →
   *   READY_FOR_CEO_REVIEW on the renewed pin, the same candidate and packet, nothing dispatched.
   * - BLOCKED for anything else (a CEO decision), REVISION_REQUIRED or any other AWAITING_HUMAN: only
   *   the owner's authority comes back. The run keeps its state and its reason, nothing is
   *   dispatched, and whoever releases that hold — the CEO's resolution, a redispatch — reaches the
   *   renewed generation.
   *
   * Refused, with nothing written, unless the run is the project-less bootstrap pinned to exactly
   * `fromGeneration` of the same session and `renewed` is still its role's active binding. A
   * terminal run is never touched here, and no other live state is either.
   */
  restoreRecoveredBootstrapOwner(
    runId: string,
    renewed: RoleBinding,
    fromGeneration: number,
  ): Decision<{ run: RunRow; resumed: boolean }> {
    return this.db.txDecision(() => {
      const run = this.get(runId);
      if (!run) return deny(ReasonCode.NOT_FOUND, "unknown run", { runId });
      if (run.kind !== RunKind.PROJECT_BOOTSTRAP || run.projectId !== null) {
        return deny(ReasonCode.INVALID_ARGUMENT, "only a project-less bootstrap run recovers its bootstrap CTO", { runId });
      }
      if (!RECOVERABLE_BOOTSTRAP_STATES.includes(run.state)) {
        return deny(
          isTerminal(run.state) ? ReasonCode.RUN_ALREADY_TERMINAL : ReasonCode.RUN_TRANSITION_ILLEGAL,
          `a ${run.state} run's bootstrap CTO is not recovered`,
          { runId, state: run.state },
        );
      }
      if (
        run.ownerRoleKey !== renewed.roleKey ||
        run.ownerBindingGeneration !== fromGeneration ||
        run.ownerSessionId !== renewed.boundSessionId ||
        run.ownerSessionIncarnation !== renewed.boundSessionIncarnation
      ) {
        return deny(ReasonCode.RUN_OWNER_REVOKED, "the run is not pinned to the generation this recovery renewed", {
          runId,
          pinnedGeneration: run.ownerBindingGeneration,
          fromGeneration,
        });
      }
      const current = this.db.get<{ assignment_id: string; binding_generation: number }>(
        `SELECT assignment_id, binding_generation FROM assignments WHERE role_key = ? AND status = 'ACTIVE'`,
        [renewed.roleKey],
      );
      if (current?.assignment_id !== renewed.assignmentId || current.binding_generation !== renewed.bindingGeneration) {
        return deny(ReasonCode.BINDING_GENERATION_STALE, "the renewed binding is no longer the role's active one", {
          runId,
          renewedGeneration: renewed.bindingGeneration,
          currentGeneration: current?.binding_generation ?? null,
        });
      }
      const pin = [
        renewed.boundSessionId, renewed.bindingGeneration, renewed.boundSessionIncarnation, renewed.roleKey,
      ];
      const resumes = run.state === RunState.BLOCKED && (run.continuityHoldRoleKey ?? null) !== null;
      // Continuity's own wait at CEO review, for the role this recovery renews on the session and
      // incarnation the pause took it from, with nothing moved since: the run goes back to CEO review
      // on the renewed pin, and nothing is dispatched.
      const reviewHold = resumes ? null : this.#continuityReviewHold(run, {
        roleKey: renewed.roleKey,
        sessionId: renewed.boundSessionId,
        incarnation: renewed.boundSessionIncarnation,
        generation: renewed.bindingGeneration,
      });
      if (resumes) {
        const transition = canTransition(run.state, RunState.ACTIVE, run.kind);
        if (!transition.allowed) return transition as Decision<{ run: RunRow; resumed: boolean }>;
        this.db.applyRunStateTransition(this.#stateTransitions, {
          runId,
          toState: RunState.ACTIVE,
          recordTransitionEvidence: () => {
            this.audit.record({
              kind: "RUN_TRANSITION",
              runId,
              sessionId: renewed.boundSessionId,
              roleKey: renewed.roleKey,
              evidence: {
                from: run.state,
                to: RunState.ACTIVE,
                reason: "bootstrap CTO recovered on its own session",
                fromGeneration,
                toGeneration: renewed.bindingGeneration,
              },
            });
            return allow(ReasonCode.OK, undefined);
          },
          enqueueTransitionEnvelope: () => {
            const enqueued = this.outbox.enqueue({
              idempotencyKey: dispatchIdempotencyKey(runId, renewed.bindingGeneration, run.revisionCount),
              roleKey: renewed.roleKey,
              bindingGeneration: renewed.bindingGeneration,
              targetSessionId: renewed.sessionId,
              runId,
              kind: MessageKind.RUN_DISPATCH,
              payload: {
                runId,
                goal: run.goal,
                executionMode: run.executionMode,
                priority: run.priority,
                contractDigest: run.contractDigest,
                pinnedManifestDigest: run.pinnedManifestDigest,
                resumedAfterRecovery: true,
              },
            });
            return enqueued.allowed ? allow(ReasonCode.OK, undefined) : (enqueued as Decision<unknown>);
          },
          updateState: () =>
            this.db.run(
              `UPDATE runs SET state = 'ACTIVE', state_reason = ?, continuity_hold_role_key = NULL,
                               owner_session_id = ?, owner_binding_generation = ?,
                               owner_session_incarnation = ?, owner_role_key = ?
                WHERE run_id = ?`,
              ["bootstrap CTO recovered", ...pin, runId],
            ),
        });
      } else if (reviewHold) {
        this.#releaseContinuityReviewHold(run, reviewHold, {
          roleKey: renewed.roleKey,
          sessionId: renewed.boundSessionId,
          incarnation: renewed.boundSessionIncarnation,
          generation: renewed.bindingGeneration,
        }, { fromGeneration, toGeneration: renewed.bindingGeneration });
      } else {
        // The run's own hold stands; only who holds the run's authority changes.
        this.db.run(
          `UPDATE runs SET owner_session_id = ?, owner_binding_generation = ?,
                           owner_session_incarnation = ?, owner_role_key = ?
            WHERE run_id = ?`,
          [...pin, runId],
        );
        this.audit.record({
          kind: "RUN_OWNER_RENEWED",
          runId,
          sessionId: renewed.boundSessionId,
          roleKey: renewed.roleKey,
          evidence: {
            state: run.state,
            reason: run.stateReason,
            fromGeneration,
            toGeneration: renewed.bindingGeneration,
          },
        });
      }
      // Work a previous generation started is fenced to it, as a takeover fences it.
      this.tasks.abandonStaleExecutions(runId, renewed.bindingGeneration, "bootstrap CTO recovered at a new generation");
      // The CEO's resolution the outage's revocation held for this owner follows it here, once, now
      // that the run is pinned to the renewed generation; one that can no longer be carried is
      // rejected in this same transaction.
      this.outbox.carryHeldEscalationReplies(runId, renewed.roleKey, fromGeneration, {
        generation: renewed.bindingGeneration,
        sessionId: renewed.sessionId,
      });
      return allow(ReasonCode.OK, { run: this.require(runId), resumed: resumes });
    });
  }

  /**
   * The other place continuity gives back the role its pause named: the daemon's reconcile, when the
   * incumbent whose revocation the pause could not complete (a run at CEO review is a held run, so a
   * coverage revocation of its owner is deferred) covers the role again. `binding` must be the role's
   * active binding and exactly the run's pinned owner — role, session, incarnation and generation —
   * and the run is released by the same rule and in the same shape as `restoreRecoveredBootstrapOwner`
   * releases it. Being the pinned owner is not enough: a holder on another session or incarnation
   * (a replacement, a switch, a failover) that is pinned to the run now is not the owner the pause took
   * it from, and is answered `released: false` like any other wait that is not continuity's own.
   */
  releaseContinuityReviewHold(runId: string, binding: RoleBinding): Decision<{ run: RunRow; released: boolean }> {
    return this.db.txDecision(() => {
      const run = this.get(runId);
      if (!run) return deny(ReasonCode.NOT_FOUND, "unknown run", { runId });
      if (
        run.ownerRoleKey !== binding.roleKey ||
        run.ownerSessionId !== binding.boundSessionId ||
        run.ownerSessionIncarnation !== binding.boundSessionIncarnation ||
        run.ownerBindingGeneration !== binding.bindingGeneration
      ) {
        return deny(ReasonCode.RUN_OWNER_REVOKED, "the run is not pinned to this binding", {
          runId,
          pinnedGeneration: run.ownerBindingGeneration,
          generation: binding.bindingGeneration,
        });
      }
      const current = this.db.get<{ assignment_id: string; binding_generation: number }>(
        `SELECT assignment_id, binding_generation FROM assignments WHERE role_key = ? AND status = 'ACTIVE'`,
        [binding.roleKey],
      );
      if (current?.assignment_id !== binding.assignmentId || current.binding_generation !== binding.bindingGeneration) {
        return deny(ReasonCode.BINDING_GENERATION_STALE, "the binding is no longer the role's active one", {
          runId,
          generation: binding.bindingGeneration,
          currentGeneration: current?.binding_generation ?? null,
        });
      }
      const hold = this.#continuityReviewHold(run, {
        roleKey: binding.roleKey,
        sessionId: binding.boundSessionId,
        incarnation: binding.boundSessionIncarnation,
        generation: binding.bindingGeneration,
      });
      if (!hold) return allow(ReasonCode.OK, { run, released: false });
      this.#releaseContinuityReviewHold(run, hold, {
        roleKey: binding.roleKey,
        sessionId: binding.boundSessionId,
        incarnation: binding.boundSessionIncarnation,
        generation: binding.bindingGeneration,
      }, { generation: binding.bindingGeneration });
      return allow(ReasonCode.OK, { run: this.require(runId), released: true });
    });
  }

  /**
   * S-HOLD — continuity's own BLOCKED hold on a STANDARD_WORK run, handed back once the role it held the
   * run for is covered again by `held`. Before this, the only doors out of that hold were a bootstrap
   * CTO's recovery and the review-wait release, so one CEO session restart left every ACTIVE STANDARD_WORK
   * run BLOCKED for good (#512, run_ab77268b).
   *
   * Read and decided inside this one transaction, and released only when every one of these holds;
   * otherwise nothing is written and `kept` says why:
   *
   * - the run is a STANDARD_WORK run, BLOCKED, with `continuity_hold_role_key` = `held.roleKey`, which
   *   only `pauseForContinuity` writes and every other edge clears;
   * - the hold's episode is the EARLIEST continuity pause (ACTIVE → BLOCKED, continuityAction
   *   PAUSE_NEW_WORK, its reason the run's state reason and one continuity pauses with) recorded after the
   *   run last entered ACTIVE (its DISPATCHED, or a RUN_TRANSITION into ACTIVE). Event ids only grow, so
   *   a row appended later, a copy of that pause included, can never take its place: it is a record after
   *   the pause, and keeps the hold. A run BLOCKED for anything else (a CEO decision, a human gate) has no
   *   such pause, and is never released here;
   * - `held` is still its role's ACTIVE binding (assignment and generation) and its runtime is READY on
   *   its current incarnation; the old session the pause lost is never asked for;
   * - the run's owner pin is its project's PRIMARY_CTO's ACTIVE binding, exactly (session, incarnation,
   *   generation), on a READY session. The pin is only read: ownership never moves, least of all to the
   *   role that was held;
   * - nothing moved under the hold since the pause: no run-mutating audit record of the run after it by
   *   event id (`CONTINUITY_HOLD_MUTATING_KINDS`; a refusal or a diagnostic such as OUTBOX_ACK_REJECTED is
   *   not movement), no binding change after it of any other role whose loss pauses the run, and the
   *   run's rows unmoved: equal to the digest the pause recorded (`#holdSnapshot`) or, for a legacy pause
   *   written before the digest existed, none written at or after the pause's time (`#writtenSince`).
   *
   * The release is BLOCKED → ACTIVE under the transition authority, one RUN_TRANSITION, the hold cleared,
   * and the update conditional on the state, hold, reason and pin it read. Nothing is dispatched: the run is
   * left runnable and the daemon's existing STANDARD_WORK continuation wake (#1158) decides whether its
   * owner is woken, once per (run, task, task state) by its own marker.
   */
  releaseContinuityHold(
    runId: string,
    held: RoleBinding,
  ): Decision<{ run: RunRow; released: boolean; kept: string | null }> {
    return this.db.txDecision(() => {
      const run = this.get(runId);
      if (!run) return deny(ReasonCode.NOT_FOUND, "unknown run", { runId });
      const kept = (why: string) => allow(ReasonCode.OK, { run, released: false, kept: why });
      if (run.kind !== RunKind.STANDARD_WORK) return kept("only a STANDARD_WORK run's continuity hold is released here");
      if (run.state !== RunState.BLOCKED) return kept(`the run is ${run.state}, not BLOCKED`);
      if (run.continuityHoldRoleKey === null || run.continuityHoldRoleKey !== held.roleKey) {
        return kept("the run is not under continuity's hold for this role");
      }
      const history = this.db.all<{ event_id: number; kind: string; at: string; evidence_json: string }>(
        `SELECT event_id, kind, at, evidence_json FROM audit_events
          WHERE run_id = ? AND kind IN ('DISPATCHED', 'RUN_TRANSITION')
          ORDER BY event_id`,
        [runId],
      );
      let entered = -1;
      history.forEach((row, index) => {
        if (row.kind === "DISPATCHED" || auditEvidence(row.evidence_json)?.["to"] === RunState.ACTIVE) entered = index;
      });
      const pause = history.slice(entered + 1).find((row) =>
        row.kind === "RUN_TRANSITION" && isContinuityPause(auditEvidence(row.evidence_json), run.stateReason));
      if (!pause) return kept("no continuity pause is recorded since the run last entered ACTIVE");
      const covering = this.#activeBindingNow(held.roleKey);
      if (covering?.assignmentId !== held.assignmentId || covering.generation !== held.bindingGeneration) {
        return kept("the held role's binding is no longer its active one");
      }
      if (!covering.ready) return kept("the held role's session is not READY");
      const ownerRoleKey = run.projectId === null ? null : roleKeyFor(Role.PRIMARY_CTO, { projectId: run.projectId });
      const owner = ownerRoleKey === null ? null : this.#activeBindingNow(ownerRoleKey);
      if (
        ownerRoleKey === null || run.ownerRoleKey !== ownerRoleKey || !owner ||
        owner.boundSessionId !== run.ownerSessionId ||
        owner.boundIncarnation !== run.ownerSessionIncarnation ||
        owner.generation !== run.ownerBindingGeneration
      ) {
        return kept("the run's owner pin is not its PRIMARY_CTO's active binding");
      }
      if (!owner.ready) return kept("the run's owner session is not READY");
      const recorded = this.db.all<{ event_id: number; kind: string; reason_code: string | null; evidence_json: string }>(
        `SELECT event_id, kind, reason_code, evidence_json FROM audit_events
          WHERE run_id = ? AND event_id > ?
            AND kind IN (${CONTINUITY_HOLD_MUTATING_KINDS.map(() => "?").join(", ")})
          ORDER BY event_id`,
        [runId, pause.event_id, ...CONTINUITY_HOLD_MUTATING_KINDS],
      ).find(isRecordedMovement);
      if (recorded) {
        return kept(`${recorded.kind} (event ${recorded.event_id}) was recorded for the run after continuity's pause (event ${pause.event_id})`);
      }
      // #1162 r3 — a task branch whose creation was started and has neither its completion nor a verified
      // undo is an effect in flight on the checkout, which no row of this database shows: never released
      // across it, whenever its intent was written.
      const unresolved = this.#unresolvedBranchCreation(runId);
      if (unresolved) return kept(`a task branch creation of the run is in flight or unresolved: ${unresolved}`);
      // A pause written since S-HOLD carries the rows' digest: unmoved means equal, whatever the clock read.
      const atPause = auditEvidence(pause.evidence_json)?.[HOLD_SNAPSHOT_FIELD];
      if (typeof atPause === "string") {
        if (atPause !== this.#holdSnapshot(runId)) {
          return kept("the run's tasks, executions, artifacts or candidate attempts changed under the hold");
        }
      } else {
        // A legacy pause, written before the digest existed (the live run_ab77268b's, 04:09:28Z): no row of
        // the run may be written at or after the pause's time, or be RUNNING. A row of the pause's own
        // millisecond keeps the hold, the safe side.
        const touched = this.#writtenSince(runId, pause.at);
        if (touched) return kept(`${touched} of the run was written at or after continuity's pause`);
      }
      const rebound = this.db.all<{ event_id: number; kind: string; role_key: string | null }>(
        `SELECT event_id, kind, role_key FROM audit_events
          WHERE event_id > ? AND role_key IS NOT NULL AND role_key <> ?
            AND kind IN (${CONTINUITY_HOLD_BINDING_KINDS.map(() => "?").join(", ")})`,
        [pause.event_id, held.roleKey, ...CONTINUITY_HOLD_BINDING_KINDS],
      );
      const moved = rebound.find((row) => row.role_key !== null && this.#lossPauses(run, row.role_key));
      if (moved) {
        return kept(`another role this run depends on changed its binding under the hold: ${moved.kind} (event ${moved.event_id}) of ${moved.role_key}`);
      }
      const legal = canTransition(RunState.BLOCKED, RunState.ACTIVE, run.kind);
      if (!legal.allowed) return legal as Decision<{ run: RunRow; released: boolean; kept: string | null }>;
      const reason = `continuity hold released: ${held.roleKey} covered again`;
      const written = this.db.applyRunStateTransition(this.#stateTransitions, {
        runId,
        toState: RunState.ACTIVE,
        recordTransitionEvidence: () => {
          this.audit.record({
            kind: "RUN_TRANSITION",
            runId,
            projectId: run.projectId,
            evidence: {
              from: RunState.BLOCKED,
              to: RunState.ACTIVE,
              reason,
              continuityRelease: held.roleKey,
              pauseEventId: pause.event_id,
              toGeneration: held.bindingGeneration,
              ownerBindingGeneration: run.ownerBindingGeneration,
            },
          });
          return allow(ReasonCode.OK, undefined);
        },
        enqueueTransitionEnvelope: () => allow(ReasonCode.OK, undefined),
        updateState: () =>
          this.db.run(
            `UPDATE runs SET state = 'ACTIVE', state_reason = ?, continuity_hold_role_key = NULL
              WHERE run_id = ? AND state = 'BLOCKED' AND continuity_hold_role_key = ? AND state_reason IS ?
                AND owner_role_key IS ? AND owner_session_id IS ? AND owner_session_incarnation IS ?
                AND owner_binding_generation IS ?`,
            [
              reason, runId, held.roleKey, run.stateReason,
              run.ownerRoleKey, run.ownerSessionId, run.ownerSessionIncarnation, run.ownerBindingGeneration,
            ],
          ),
      });
      if (written.changes !== 1) {
        return deny(ReasonCode.RUN_TRANSITION_ILLEGAL, "the run moved between the hold's check and its release", { runId });
      }
      return allow(ReasonCode.OK, { run: this.require(runId), released: true, kept: null });
    });
  }

  /**
   * #1162 r3 — the run's task branch creation that is in flight or unresolved, named (its attempt id and its
   * intent's event id), or null: a TASK_BRANCH_CREATING whose scope `unresolvedCreationAttempt` finds
   * unresolved and whose own attempt has neither a TASK_BRANCH_CREATED nor a TASK_BRANCH_CREATION_UNDONE.
   *
   * An unresolved attempt is a blocking state: while it stands the hold is never released, however long
   * that is. There is no operator tool to clear it yet (S-TB's own Limit), and it is never to be cleared by
   * editing the database by hand: only the writer's own completion or verified undo resolves it.
   */
  #unresolvedBranchCreation(runId: string): string | null {
    const intents = this.db.all<{ event_id: number; evidence_json: string }>(
      `SELECT event_id, evidence_json FROM audit_events WHERE kind = ? AND run_id = ? ORDER BY event_id`,
      [TASK_BRANCH_CREATING, runId],
    );
    for (const row of intents) {
      const intent = auditEvidence(row.evidence_json);
      const [taskId, repositoryIdentity, branch, baseSha] = ["taskId", "repositoryIdentity", "branch", "baseSha"]
        .map((field) => intent?.[field]);
      // An intent whose scope cannot be read cannot be shown resolved: in flight.
      if (typeof taskId !== "string" || typeof repositoryIdentity !== "string" || typeof branch !== "string" ||
        typeof baseSha !== "string") {
        return `intent event ${row.event_id} (its scope cannot be read)`;
      }
      if (!unresolvedCreationAttempt(this.db, { runId, taskId, repositoryIdentity, branch, baseSha })) continue;
      const attemptId = intent?.["attemptId"];
      if (typeof attemptId !== "string") return `intent event ${row.event_id} (an attempt with no id)`;
      const resolved = this.db.get<{ n: number }>(
        `SELECT 1 AS n FROM audit_events
          WHERE kind IN (?, ?) AND run_id = ? AND json_extract(evidence_json, '$.attemptId') = ? LIMIT 1`,
        [TASK_BRANCH_CREATED, TASK_BRANCH_CREATION_UNDONE, runId, attemptId],
      );
      if (!resolved) return `attempt ${attemptId} (intent event ${row.event_id})`;
    }
    return null;
  }

  /**
   * S-HOLD — for a legacy pause with no snapshot: which row of the run, if any, was written at or after
   * `at` (`>=`, so one of the pause's own millisecond counts) or is RUNNING.
   */
  #writtenSince(runId: string, at: string): string | null {
    const touched = this.db.get<{ what: string }>(
      `SELECT 'a task' AS what FROM tasks WHERE run_id = ? AND updated_at >= ?
       UNION ALL
       SELECT 'a task execution' FROM task_executions
        WHERE run_id = ? AND (status = 'RUNNING' OR started_at >= ? OR ended_at >= ? OR last_activity_at >= ?
                              OR worker_process_released_at >= ?)
       UNION ALL
       SELECT 'an artifact' FROM run_artifacts WHERE run_id = ? AND created_at >= ?
       UNION ALL
       SELECT 'a candidate pipeline attempt' FROM candidate_pipeline_attempts
        WHERE run_id = ? AND (state = 'RUNNING' OR started_at >= ? OR released_at >= ?)
       LIMIT 1`,
      [runId, at, runId, at, at, at, at, runId, at, runId, at, at],
    );
    return touched?.what ?? null;
  }

  /**
   * A role's ACTIVE binding as the database has it now: its assignment, generation and the session it
   * was bound on, and whether the runtime serving it is READY on its current incarnation.
   */
  #activeBindingNow(roleKey: string): {
    assignmentId: string;
    generation: number;
    boundSessionId: string;
    boundIncarnation: string;
    ready: boolean;
  } | null {
    const row = this.db.get<{
      assignment_id: string;
      binding_generation: number;
      session_id: string;
      session_incarnation: string;
      lifecycle: string | null;
      live_incarnation: string | null;
      expected_incarnation: string;
    }>(
      `SELECT a.assignment_id, a.binding_generation, a.session_id, a.session_incarnation,
              s.lifecycle, s.incarnation AS live_incarnation,
              COALESCE(c.current_session_incarnation, a.session_incarnation) AS expected_incarnation
         FROM assignments a
         LEFT JOIN conversational_actors c ON c.actor_id = a.actor_id
         LEFT JOIN sessions s ON s.session_id = COALESCE(c.current_session_id, a.session_id)
        WHERE a.role_key = ? AND a.status = 'ACTIVE'`,
      [roleKey],
    );
    if (!row) return null;
    return {
      assignmentId: row.assignment_id,
      generation: row.binding_generation,
      boundSessionId: row.session_id,
      boundIncarnation: row.session_incarnation,
      ready: row.lifecycle === "READY" && row.live_incarnation === row.expected_incarnation,
    };
  }

  /**
   * Continuity's own wait at CEO review: the pause `run` is in, when continuity alone placed it there
   * for `owner`'s role, on `owner`'s session and incarnation, and nothing has moved since; null for
   * every other wait. Reads only, and is asked inside the transaction that would release it.
   *
   * v44 has no column for this wait (`continuity_hold_role_key` exists only while BLOCKED), so the
   * durable fact is the audit ledger, each row written in the transaction of the change it records:
   *
   *   - the run's latest RUN_TRANSITION is READY_FOR_CEO_REVIEW → AWAITING_HUMAN with continuityAction
   *     PAUSE_NEW_WORK, and the one before it entered READY_FOR_CEO_REVIEW with the current candidate;
   *   - the pause belongs to one loss episode (`#lossEpisode`): its own reconcile pass finished and
   *     named the run, and in that pass exactly one revocation or deferral, of the owner's role, was
   *     written for the loss the pause names. A pause whose pass never finished — the old daemon
   *     committed the pause before it revoked anything — has no episode, so a later pass's revocation
   *     cannot be borrowed for it;
   *   - the owner the pause took the run from is `owner`'s role, session and incarnation. Since this
   *     change the pause records it (`continuityHold`, its candidate and `CONTINUITY_PAUSE_OWNER_FIELDS`).
   *     A row written before carries only a `roleKey`, which the audit log stores redacted, so it is
   *     the episode's revocation that names the session and generation, checked against the run's pin
   *     at the pause and the assignment of that generation (`#legacyPausedOwner`). The generation
   *     moves on for the same session's renewal and is never compared for equality; an unrelated
   *     holder on another session or incarnation never releases the wait, even when it is now pinned;
   *   - no candidate was promoted or invalidated since the run entered review, no CEO or owner decision
   *     was recorded since the pause, the candidate's PRODUCTION_READY_PACKET is current, and the human
   *     gate is satisfied (`CeoReviewGate`).
   *
   * Anything missing, unparsable or ambiguous keeps the wait.
   *
   * Trust limit: every fact above is read from `audit_events`, which the daemon writes but v44 does not
   * guard against a raw SQLite writer. A same-uid process that writes the database directly could forge
   * a pause chain and have a wait handed back; the transition itself still needs daemon authority, and
   * no schema-v44 column can carry this hold in its place.
   */
  #continuityReviewHold(run: RunRow, owner: ContinuityOwner): ContinuityReviewHold | null {
    if (run.state !== RunState.AWAITING_HUMAN) return null;
    const [pause, entered] = this.db.all<{ event_id: number; evidence_json: string }>(
      `SELECT event_id, evidence_json FROM audit_events
        WHERE kind = 'RUN_TRANSITION' AND run_id = ?
        ORDER BY event_id DESC LIMIT 2`,
      [run.runId],
    );
    if (!pause || !entered) return null;
    const paused = auditEvidence(pause.evidence_json);
    const review = auditEvidence(entered.evidence_json);
    if (!paused || !review) return null;
    if (paused["from"] !== RunState.READY_FOR_CEO_REVIEW || paused["to"] !== RunState.AWAITING_HUMAN) return null;
    if (paused["continuityAction"] !== "PAUSE_NEW_WORK") return null;
    if (review["to"] !== RunState.READY_FOR_CEO_REVIEW) return null;
    const candidate = this.currentCandidate(run.runId);
    if (candidate === null || review["candidateSnapshotDigest"] !== candidate) return null;
    const recorded = "continuityHold" in paused;
    if (recorded && (paused["continuityHold"] !== owner.roleKey || paused["candidateSnapshotDigest"] !== candidate)) {
      return null;
    }
    const episode = this.#lossEpisode(run, pause.event_id, paused["reason"], owner.roleKey);
    if (!episode) return null;
    const pausedOwner = recorded ? recordedPauseOwner(paused) : this.#legacyPausedOwner(run, pause.event_id, episode);
    if (!pausedOwner) return null;
    // The episode's revocation took the role from the owner the pause names, and no other.
    if (episode.sessionId !== pausedOwner.sessionId || episode.generation !== pausedOwner.generation) return null;
    if (!this.#sameOwner(pausedOwner, owner)) return null;
    const moved = this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM audit_events
        WHERE run_id = ?
          AND ((kind IN ('CANDIDATE_PROMOTED', 'CANDIDATE_INVALIDATED') AND event_id > ?)
            OR (kind IN ('CEO_DECISION', 'OWNER_DECISION') AND event_id > ?))`,
      [run.runId, entered.event_id, pause.event_id],
    );
    if ((moved?.n ?? 1) !== 0) return null;
    const packet = this.artifacts.latestForSnapshot<{ runId?: unknown; candidateSnapshotDigest?: unknown }>(
      run.runId,
      ArtifactKind.PRODUCTION_READY_PACKET,
      candidate,
    );
    if (packet?.content.runId !== run.runId || packet.content.candidateSnapshotDigest !== candidate) return null;
    if (this.#ceoReview?.humanGateStatus(run.runId).satisfied !== true) return null;
    return { pauseEventId: pause.event_id, candidateSnapshotDigest: candidate };
  }

  /**
   * The loss a pause answered, read from its own reconcile pass: the rows after the pause up to the
   * first CONTINUITY_RECONCILED after it, the record the pass writes when it finishes.
   *
   *   (a) that CONTINUITY_RECONCILED exists, and (b) its `pausedRuns` names the run exactly once — a
   *       pass that never finished, or a later one that paused nothing of this run, is no episode;
   *   (c) the revocation's (BINDING_REVOKED) or deferral's (CONTINUITY_REVOKE_DEFERRED) reason is the
   *       pause's own loss reason, and one of continuity's;
   *   (d) it is the only such row in the window for any role whose loss pauses this run (the CEO, a
   *       role of the run, of its project or of one of its tasks), and the only row of any reason for
   *       `roleKey`: two candidates leave the pause's role ambiguous;
   *   (e) it names the session and the generation it took the role from (`session_id`,
   *       `evidence.generation`) — the caller checks those against the pause's owner.
   */
  #lossEpisode(run: RunRow, pauseEventId: number, lossReason: unknown, roleKey: string): ContinuityLossEpisode | null {
    if (typeof lossReason !== "string" || !isContinuityRevocationReason(lossReason)) return null;
    const closed = this.db.get<{ event_id: number; evidence_json: string }>(
      `SELECT event_id, evidence_json FROM audit_events
        WHERE kind = 'CONTINUITY_RECONCILED' AND event_id > ?
        ORDER BY event_id LIMIT 1`,
      [pauseEventId],
    );
    if (!closed) return null;
    const pausedRuns = auditEvidence(closed.evidence_json)?.["pausedRuns"];
    if (!Array.isArray(pausedRuns)) return null;
    const named = pausedRuns.filter((entry: unknown) =>
      typeof entry === "object" && entry !== null && (entry as Record<string, unknown>)["runId"] === run.runId,
    );
    if (named.length !== 1) return null;
    const window = this.db.all<{ role_key: string | null; session_id: string | null; evidence_json: string }>(
      `SELECT role_key, session_id, evidence_json FROM audit_events
        WHERE event_id > ? AND event_id < ?
          AND kind IN ('BINDING_REVOKED', 'CONTINUITY_REVOKE_DEFERRED')
        ORDER BY event_id`,
      [pauseEventId, closed.event_id],
    );
    const sameLoss = window.filter((row) =>
      row.role_key !== null &&
      this.#lossPauses(run, row.role_key) &&
      auditEvidence(row.evidence_json)?.["reason"] === lossReason,
    );
    if (sameLoss.length !== 1) return null;
    const [revocation] = sameLoss;
    if (revocation?.role_key !== roleKey) return null;
    if (window.filter((row) => row.role_key === roleKey).length !== 1) return null;
    const generation = auditEvidence(revocation.evidence_json)?.["generation"];
    if (revocation.session_id === null || typeof generation !== "number" || !Number.isInteger(generation)) return null;
    return { sessionId: revocation.session_id, generation };
  }

  /** Whether the loss of `roleKey` pauses `run`, as the daemon's `pauseAffectedRuns` scopes it. */
  #lossPauses(run: RunRow, roleKey: string): boolean {
    if (roleKey === roleKeyFor(Role.CEO) || roleKey === run.ownerRoleKey) return true;
    if (roleKey.endsWith(`:${run.runId}`)) return true;
    if (run.projectId !== null && roleKey.endsWith(`:${run.projectId}`)) return true;
    if (!roleKey.startsWith(`${Role.WORKER}:`)) return false;
    const task = this.db.get<{ run_id: string }>(`SELECT run_id FROM tasks WHERE task_id = ?`, [
      roleKey.slice(Role.WORKER.length + 1),
    ]);
    return task?.run_id === run.runId;
  }

  /**
   * A legacy pause's owner, which its row does not record: the session and generation its episode's
   * revocation took the role from, when that was the run's pin at the pause — the run's own session,
   * and the generation the first owner renewal after the pause renewed from (or the current pin, with
   * none) — and the incarnation the assignment of that generation was bound to. A takeover after the
   * pause, or a renewal chain that does not end at the current pin, leaves the owner unknown.
   */
  #legacyPausedOwner(run: RunRow, pauseEventId: number, episode: ContinuityLossEpisode): Omit<ContinuityOwner, "roleKey"> | null {
    if (run.ownerSessionId !== episode.sessionId || run.ownerRoleKey === null || run.ownerBindingGeneration === null) {
      return null;
    }
    const repins = this.db.all<{ kind: string; evidence_json: string }>(
      `SELECT kind, evidence_json FROM audit_events
        WHERE run_id = ? AND event_id > ? AND kind IN ('RUN_OWNER_RENEWED', 'RECOVERY_TAKEOVER')
        ORDER BY event_id`,
      [run.runId, pauseEventId],
    );
    let pinned: number | null = null;
    let next: number | null = null;
    for (const repin of repins) {
      if (repin.kind !== "RUN_OWNER_RENEWED") return null;
      const renewal = auditEvidence(repin.evidence_json);
      const from = renewal?.["fromGeneration"];
      const to = renewal?.["toGeneration"];
      if (typeof from !== "number" || typeof to !== "number") return null;
      if (next !== null && from !== next) return null;
      pinned ??= from;
      next = to;
    }
    if (next !== null && next !== run.ownerBindingGeneration) return null;
    const generation = pinned ?? run.ownerBindingGeneration;
    const assignment = this.db.get<{ session_id: string; session_incarnation: string }>(
      `SELECT session_id, session_incarnation FROM assignments WHERE role_key = ? AND binding_generation = ?`,
      [run.ownerRoleKey, generation],
    );
    if (assignment?.session_id !== episode.sessionId) return null;
    return { sessionId: assignment.session_id, incarnation: assignment.session_incarnation, generation };
  }

  /**
   * The same owner across generations: the role is fixed by the caller, so the same session and the
   * same incarnation — still that session's incarnation now — at the paused generation or a later one.
   */
  #sameOwner(paused: Omit<ContinuityOwner, "roleKey">, owner: ContinuityOwner): boolean {
    if (owner.sessionId !== paused.sessionId || owner.incarnation !== paused.incarnation) return false;
    if (owner.generation < paused.generation) return false;
    const session = this.db.get<{ incarnation: string }>(`SELECT incarnation FROM sessions WHERE session_id = ?`, [
      paused.sessionId,
    ]);
    return session?.incarnation === paused.incarnation;
  }

  /**
   * Hands continuity's own wait back: AWAITING_HUMAN → ACTIVE → READY_FOR_CEO_REVIEW inside the caller's
   * transaction, each edge under the run engine's transition authority with its own RUN_TRANSITION row,
   * the owner pinned to `owner`. No envelope: nothing is dispatched, no candidate or packet is made, and
   * the CEO is not notified again — the READY_FOR_CEO_REVIEW notification already sent names this same
   * candidate and human gate, which is all its idempotency key is made of. Both edges are in §29's
   * table, so a refusal is a broken invariant: it throws, and the caller's transaction rolls back.
   */
  #releaseContinuityReviewHold(
    run: RunRow,
    hold: ContinuityReviewHold,
    owner: { roleKey: string; sessionId: string; incarnation: string; generation: number },
    evidence: Record<string, unknown>,
  ): void {
    const release = {
      reason: CONTINUITY_REVIEW_RELEASE_REASON,
      continuityRelease: owner.roleKey,
      pauseEventId: hold.pauseEventId,
      candidateSnapshotDigest: hold.candidateSnapshotDigest,
      ...evidence,
    };
    const edges: ReadonlyArray<{ from: RunState; to: RunState; sql: string; params: unknown[] }> = [
      {
        from: RunState.AWAITING_HUMAN,
        to: RunState.ACTIVE,
        sql: `UPDATE runs SET state = ?, state_reason = ?, continuity_hold_role_key = NULL,
                              owner_session_id = ?, owner_binding_generation = ?,
                              owner_session_incarnation = ?, owner_role_key = ?
               WHERE run_id = ?`,
        params: [
          RunState.ACTIVE, CONTINUITY_REVIEW_RELEASE_REASON,
          owner.sessionId, owner.generation, owner.incarnation, owner.roleKey, run.runId,
        ],
      },
      {
        from: RunState.ACTIVE,
        to: RunState.READY_FOR_CEO_REVIEW,
        sql: `UPDATE runs SET state = ?, state_reason = ? WHERE run_id = ?`,
        params: [RunState.READY_FOR_CEO_REVIEW, CONTINUITY_REVIEW_RELEASE_REASON, run.runId],
      },
    ];
    for (const edge of edges) {
      const legal = canTransition(edge.from, edge.to, run.kind);
      if (!legal.allowed) fail(legal.reasonCode, legal.message, legal.evidence);
      this.db.applyRunStateTransition(this.#stateTransitions, {
        runId: run.runId,
        toState: edge.to,
        recordTransitionEvidence: () => {
          this.audit.record({
            kind: "RUN_TRANSITION",
            runId: run.runId,
            projectId: run.projectId,
            sessionId: owner.sessionId,
            roleKey: owner.roleKey,
            evidence: { from: edge.from, to: edge.to, ...release },
          });
          return allow(ReasonCode.OK, undefined);
        },
        enqueueTransitionEnvelope: () => allow(ReasonCode.OK, undefined),
        updateState: () => this.db.run(edge.sql, edge.params),
      });
    }
  }
}

/**
 * #246 C1b — the live states a bootstrap run can be in while its CTO is recovered: continuity's own
 * pause (BLOCKED), a hold someone else placed (BLOCKED for a CEO decision, AWAITING_HUMAN), and a
 * run waiting to be dispatched again (REVISION_REQUIRED). No other state has a revoked owner that
 * continuity is waiting to give back.
 */
const RECOVERABLE_BOOTSTRAP_STATES: readonly RunState[] = Object.freeze([
  RunState.BLOCKED,
  RunState.REVISION_REQUIRED,
  RunState.AWAITING_HUMAN,
]);

interface RawRun {
  run_id: string;
  project_id: string | null;
  kind: RunKind;
  execution_mode: ExecutionMode;
  priority: RunPriority;
  state: RunState;
  goal: string;
  contract_digest: string;
  pinned_manifest_digest: string | null;
  current_candidate_digest: string | null;
  owner_session_id: string | null;
  owner_binding_generation: number | null;
  owner_session_incarnation: string | null;
  owner_role_key: string | null;
  human_gate_required: number;
  revision_count: number;
  created_at: string;
  dispatched_at: string | null;
  ended_at: string | null;
  state_reason: string | null;
  /** Absent only on a database older than v42. */
  continuity_hold_role_key?: string | null;
}

const hydrate = (row: RawRun): RunRow => ({
  runId: row.run_id,
  projectId: row.project_id,
  kind: row.kind,
  executionMode: row.execution_mode,
  priority: row.priority,
  state: row.state,
  goal: row.goal,
  contractDigest: row.contract_digest,
  pinnedManifestDigest: row.pinned_manifest_digest,
  ownerSessionId: row.owner_session_id,
  ownerBindingGeneration: row.owner_binding_generation,
  ownerSessionIncarnation: row.owner_session_incarnation,
  ownerRoleKey: row.owner_role_key,
  humanGateRequired: row.human_gate_required === 1,
  revisionCount: row.revision_count,
  createdAt: row.created_at,
  dispatchedAt: row.dispatched_at,
  endedAt: row.ended_at,
  stateReason: row.state_reason,
  continuityHoldRoleKey: row.continuity_hold_role_key ?? null,
});

/**
 * #246 C1b (review ACP-C1B-04) — the idempotency key of a dispatch: one per binding generation and
 * per dispatch cycle. A run sent back for revision is dispatched again, possibly to the same
 * generation, and that is a new dispatch, not a replay of the first: each revision is its own cycle,
 * numbered by `revision_count`. The first cycle keeps the key every dispatch had before, so a retry
 * inside any cycle is still one envelope (CP-S58), and nothing already queued changes meaning.
 */
export const dispatchIdempotencyKey = (runId: string, bindingGeneration: number, revisionCount: number): string =>
  revisionCount === 0
    ? `run-dispatch:${runId}:${bindingGeneration}`
    : `run-dispatch:${runId}:${bindingGeneration}:r${revisionCount}`;
