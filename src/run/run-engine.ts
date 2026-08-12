import type { Clock } from "../core/clock.ts";
import { digestOf } from "../core/digest.ts";
import { type Decision, allow, deny, fail } from "../core/errors.ts";
import { newRunId } from "../core/ids.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { AuditLog } from "../db/audit.ts";
import type { ArtifactStore } from "../db/artifacts.ts";
import type { Db } from "../db/database.ts";
import { canTransition } from "../domain/run-state.ts";
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

export interface CreateRunInput {
  projectId?: string | null;
  kind?: RunKind;
  executionMode: ExecutionMode;
  priority?: RunPriority;
  contract: TaskContract;
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
}

/** §14.2 — capacity must be refreshed before dispatch admission. */
export interface CapacityGate {
  refreshForDispatch(): Promise<Decision<void>>;
}

export interface ContinuityGate {
  mode(): ContinuityMode;
}

export class RunEngine {
  #cto: CtoProvisioner | null = null;
  #capacity: CapacityGate | null = null;
  #continuity: ContinuityGate | null = null;

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
  ) {}

  /** Wired after construction because the CTO lifecycle also needs the run engine. */
  attach(ports: {
    cto?: CtoProvisioner;
    capacity?: CapacityGate;
    continuity?: ContinuityGate;
  }): void {
    if (ports.cto) this.#cto = ports.cto;
    if (ports.capacity) this.#capacity = ports.capacity;
    if (ports.continuity) this.#continuity = ports.continuity;
  }

  create(input: CreateRunInput): Decision<RunRow> {
    const kind = input.kind ?? RunKind.STANDARD_WORK;
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
          input.contract.humanGate.length > 0 ? 1 : 0, now,
        ],
      );

      for (const repo of input.repositories ?? []) {
        const record = this.repositories.byId(repo.repositoryId);
        if (!record) fail(ReasonCode.NOT_FOUND, "unknown repository", repo);
        this.db.run(
          `INSERT INTO run_repositories (run_id, repository_id, repository_role, base_branch, merge_order)
           VALUES (?, ?, ?, ?, ?)`,
          [runId, repo.repositoryId, repo.repositoryRole, repo.baseBranch, repo.mergeOrder ?? 0],
        );
      }

      this.artifacts.put(runId, ArtifactKind.TASK_CONTRACT, input.contract);
      this.audit.record({
        kind: "RUN_CREATED",
        runId,
        projectId: input.projectId ?? null,
        evidence: {
          kind,
          executionMode: input.executionMode,
          priority: input.priority ?? input.contract.priority,
          contractDigest,
          humanGate: input.contract.humanGate,
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
      return deny(
        ReasonCode.CONTINUITY_SURVIVAL_NO_COMPLETION,
        "continuity is in SURVIVAL; new work is not dispatched",
        { runId },
      );
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

    // §14.2 — mandatory refresh before admission. A failed probe suspends allocation
    // rather than dispatching against an unknown quota.
    if (this.#capacity) {
      const capacity = await this.#capacity.refreshForDispatch();
      if (!capacity.allowed) return capacity as Decision<RunRow>;
    }

    let binding: RoleBinding | null = null;
    if (run.projectId) {
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
      // §9.5 — a run against a project with no primary CTO creates one.
      const provisioned = await this.#cto.ensurePrimaryCto(run.projectId, runId);
      if (!provisioned.allowed) return provisioned as Decision<RunRow>;
      binding = provisioned.value;
    }

    return this.db.tx(() => {
      const fresh = this.require(runId);
      const transition = canTransition(fresh.state, RunState.ACTIVE);
      if (!transition.allowed) return transition as Decision<RunRow>;

      const pinnedManifest = fresh.projectId
        ? (this.projects.get(fresh.projectId)?.activeManifestDigest ?? null)
        : null;

      this.db.run(
        `UPDATE runs SET state = 'ACTIVE', dispatched_at = ?, state_reason = ?,
                         owner_session_id = ?, owner_binding_generation = ?,
                         owner_session_incarnation = ?, owner_role_key = ?,
                         pinned_manifest_digest = COALESCE(pinned_manifest_digest, ?)
          WHERE run_id = ?`,
        [
          this.clock.nowIso(), "dispatched", binding?.sessionId ?? null,
          binding?.bindingGeneration ?? null, binding?.sessionIncarnation ?? null,
          binding?.roleKey ?? null, pinnedManifest, runId,
        ],
      );

      if (binding) {
        // §30.3 — the state transition and its outbox enqueue are one transaction.
        this.outbox.enqueue({
          idempotencyKey: `run-dispatch:${runId}:${binding.bindingGeneration}`,
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
            pinnedManifestDigest: pinnedManifest,
          },
        });
      }

      this.audit.record({
        kind: "DISPATCHED",
        runId,
        projectId: fresh.projectId,
        sessionId: binding?.sessionId ?? null,
        roleKey: binding?.roleKey ?? null,
        evidence: {
          ownerBindingGeneration: binding?.bindingGeneration ?? null,
          pinnedManifestDigest: pinnedManifest,
        },
      });

      return allow(ReasonCode.OK, this.require(runId));
    });
  }

  transition(
    runId: string,
    to: RunState,
    reason: string,
    evidence: Record<string, unknown> = {},
  ): Decision<RunRow> {
    return this.db.tx(() => {
      const run = this.require(runId);
      const check = canTransition(run.state, to);
      if (!check.allowed) return check as Decision<RunRow>;

      const terminal = to === RunState.COMPLETED || to === RunState.FAILED || to === RunState.CANCELLED;
      this.db.run(
        `UPDATE runs SET state = ?, state_reason = ?, ended_at = ?,
                         revision_count = revision_count + ?
          WHERE run_id = ?`,
        [to, reason, terminal ? this.clock.nowIso() : null, to === RunState.REVISION_REQUIRED ? 1 : 0, runId],
      );

      if (terminal) {
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

      this.audit.record({
        kind: "RUN_TRANSITION",
        runId,
        projectId: run.projectId,
        evidence: { from: run.state, to, reason, ...evidence },
      });
      return allow(ReasonCode.OK, this.require(runId));
    });
  }

  cancel(runId: string, reason: string): Decision<RunRow> {
    const run = this.get(runId);
    if (!run) return deny(ReasonCode.NOT_FOUND, "unknown run", { runId });
    this.tasks.cancelAll(runId, reason);
    return this.transition(runId, RunState.CANCELLED, reason);
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
    input: { repositoryId: string; repositoryRole: string; baseBranch: string; mergeOrder?: number },
  ): Decision<void> {
    if (!this.repositories.byId(input.repositoryId)) {
      return deny(ReasonCode.NOT_FOUND, "unknown repository", input);
    }
    this.db.run(
      `INSERT OR REPLACE INTO run_repositories (run_id, repository_id, repository_role, base_branch, merge_order)
       VALUES (?, ?, ?, ?, ?)`,
      [runId, input.repositoryId, input.repositoryRole, input.baseBranch, input.mergeOrder ?? 0],
    );
    return allow(ReasonCode.OK, undefined);
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
        [binding.sessionId, binding.bindingGeneration, binding.sessionIncarnation, binding.roleKey, runId],
      );
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

  pinManifest(runId: string, digest: string): void {
    this.db.run(`UPDATE runs SET pinned_manifest_digest = ? WHERE run_id = ?`, [digest, runId]);
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
          AND state IN ('QUEUED','ACTIVE','BLOCKED','READY_FOR_CEO_REVIEW','REVISION_REQUIRED','AWAITING_HUMAN')`,
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
  }> {
    return this.db.all(
      `SELECT rr.repository_id AS repositoryId, r.identity, r.checkout_path AS checkoutPath,
              rr.repository_role AS repositoryRole, rr.base_branch AS baseBranch,
              rr.work_branch AS workBranch, rr.worktree_id AS worktreeId,
              rr.merge_order AS mergeOrder, rr.merge_state AS mergeState
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
}

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
});
