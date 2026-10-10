import type { DispatchCapacityTarget } from "../capacity/capacity-monitor.ts";
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
  ContinuityMode,
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
  /** Refuses completion in SURVIVAL *and* when the stored mode is stale (§15.6). */
  assertCompletionAllowed?(runId: string): Decision<void>;
  /** Re-computes coverage. Callers in an async context must do this before completing. */
  evaluate?(reason: string): Promise<unknown>;
}

/** §15.6's freshness window, the same one `assertCompletionAllowed` applies by default. */
export const CONTINUITY_MODE_MAX_AGE_MS = 5 * 60 * 1000;

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
  #capacity: CapacityGate | null = null;
  #continuity: ContinuityGate | null = null;
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
    capacity?: CapacityGate;
    continuity?: ContinuityGate;
  }): void {
    if (ports.cto) this.#cto = ports.cto;
    if (ports.bootstrapCto) this.#bootstrapCto = ports.bootstrapCto;
    if (ports.capacity) this.#capacity = ports.capacity;
    if (ports.continuity) this.#continuity = ports.continuity;
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
  async dispatch(runId: string): Promise<Decision<RunRow>> {
    const run = this.get(runId);
    if (!run) return deny(ReasonCode.NOT_FOUND, "unknown run", { runId });
    if (run.state !== RunState.QUEUED && run.state !== RunState.REVISION_REQUIRED) {
      return deny(ReasonCode.RUN_TRANSITION_ILLEGAL, `run is ${run.state}`, { runId, state: run.state });
    }

    if (this.#continuity?.mode() === ContinuityMode.SURVIVAL) {
      // A stored SURVIVAL is a verdict someone computed earlier, not a fact about now.
      // `assertCompletionAllowed` already refuses to act on a stale one (§15.6); this path
      // did not, and the asymmetry mattered here more than there: refusing at this point
      // returns before `refreshForDispatch` below, which is the only thing that would have
      // produced fresh evidence. So a SURVIVAL computed on one four-minute tick refused
      // every dispatch until the next one, with nothing in between able to revise it.
      //
      // Re-evaluate rather than ignore. A SURVIVAL that is still true after a fresh
      // computation still refuses — this removes a stale verdict, not the gate.
      const ageMs = this.#continuity.modeAgeMs?.() ?? 0;
      if (ageMs > CONTINUITY_MODE_MAX_AGE_MS && this.#continuity.evaluate) {
        await this.#continuity.evaluate(`dispatch found a ${Math.round(ageMs / 1000)}s-old SURVIVAL verdict`);
      }
      if (this.#continuity.mode() === ContinuityMode.SURVIVAL) {
        return deny(
          ReasonCode.CONTINUITY_SURVIVAL_NO_COMPLETION,
          "continuity is in SURVIVAL; new work is not dispatched",
          { runId, modeAgeMs: this.#continuity.modeAgeMs?.() ?? null },
        );
      }
    }

    if (run.projectId) {
      const project = this.projects.require(run.projectId);
      if (project.suspended) {
        return deny(ReasonCode.RUN_QUEUED_AWAITING_CTO, "project is suspended", {
          runId,
          projectId: run.projectId,
        });
      }
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
          evidence: {},
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
      activated = this.activateDispatched(runId, binding, staffed);
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
      const effectiveManifest =
        fresh.pinnedManifestDigest ??
        (fresh.projectId ? (this.projects.get(fresh.projectId)?.activeManifestDigest ?? null) : null);

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
    return this.#transition(runId, RunState.BLOCKED, reason, evidence, undefined, roleKey);
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
        if (run.kind === RunKind.CONTRACT_CHANGE) {
          const activated = this.db.get<{ n: number }>(
            `SELECT COUNT(*) AS n FROM manifest_activation_grants g
               JOIN projects p ON p.project_id = g.project_id
              WHERE g.run_id = ? AND g.candidate_snapshot_digest IS ? AND g.consumed_at IS NOT NULL
                AND p.active_manifest_digest IS g.manifest_digest`,
            [runId, this.currentCandidate(runId)],
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
    const run = this.get(runId);
    if (!run) return deny(ReasonCode.NOT_FOUND, "unknown run", { runId });
    this.tasks.cancelAll(runId, reason);
    return this.transition(runId, RunState.CANCELLED, reason);
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
      this.db.run(
        `UPDATE run_artifacts SET superseded = 1
          WHERE run_id = ?
            AND (
              (candidate_snapshot_digest IS NOT NULL AND candidate_snapshot_digest <> ?)
              OR (kind = 'APPROVAL' AND candidate_snapshot_digest IS NULL)
            )
            AND superseded = 0`,
        [runId, candidateSnapshotDigest],
      );
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

  private invalidateCandidateInTx(
    runId: string,
    reason: string,
    evidence: Record<string, unknown>,
  ): void {
    const current = this.currentCandidate(runId);
    this.db.run(`UPDATE runs SET current_candidate_digest = NULL WHERE run_id = ?`, [runId]);
    this.db.run(
      `UPDATE run_artifacts SET superseded = 1
        WHERE run_id = ? AND candidate_snapshot_digest IS NOT NULL AND superseded = 0`,
      [runId],
    );
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
    return this.db.all<RawRun>(`SELECT * FROM runs ${where} ORDER BY created_at`, params).map(hydrate);
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
   * - BLOCKED for anything else (a CEO decision), REVISION_REQUIRED or AWAITING_HUMAN: only the
   *   owner's authority comes back. The run keeps its state and its reason, nothing is dispatched,
   *   and whoever releases that hold — the CEO's resolution, a redispatch — reaches the renewed
   *   generation.
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
      return allow(ReasonCode.OK, { run: this.require(runId), resumed: resumes });
    });
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
