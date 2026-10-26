import { execFileSync } from "node:child_process";

import type { Clock } from "../core/clock.ts";
import { digestOf, sha256Hex } from "../core/digest.ts";
import { type Decision, allow, deny, fail } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { ClaimRegistry } from "../claims/claim-registry.ts";
import type { OwnerApprovalReceipt, OwnerAuthorityPort } from "../ceo/owner-authority.ts";
import { type AuditLog, type AuditRow, redact } from "../db/audit.ts";
import type { ArtifactStore } from "../db/artifacts.ts";
import type { Db } from "../db/database.ts";
import { ArtifactKind, type RunState } from "../domain/types.ts";
import type { CandidateSnapshot } from "../snapshot/candidate-snapshot.ts";
import { isTerminal, TERMINAL_RUN_STATES } from "../domain/run-state.ts";
import { isClean, tryRevParse } from "../git/git.ts";
import type { RepositoryRegistry } from "../registry/repository-registry.ts";
import {
  ORPHAN_RELEASE_APPROVAL_OPERATION,
  ORPHAN_RELEASE_AUTHORIZATION_KEY,
  ORPHAN_RELEASE_CONFIRMATION,
  ORPHAN_RELEASE_REPAIR_ID,
  type OrphanReleaseApproval,
  orphanExecutionOf,
  orphanReleaseAuthorization,
  orphanReleaseParameterDigest,
  orphanReleaseParameters,
  unresolvedUnidentifiedOrphans,
} from "../run/worker-orphan-release.ts";
import { WorkerTurnEvent } from "../run/worker-turn.ts";
import { CONTINUITY_HOLD_NON_MOVEMENT_KINDS, isRecordedMovement } from "../run/run-engine.ts";
import {
  type RepairWorktreeAuthority,
  type ManagedWriteGuard,
  ReadOperation,
  WorktreeAction,
  WriteOperation,
} from "../guard/managed-write-guard.ts";
import type { WorktreeAuthorization, WorktreeManager } from "../verify/worktree.ts";
import { canonical } from "../guard/workspace-probe.ts";
import {
  RESERVATION_RELEASE_PRECONDITIONS,
  type RepoFactoryBootstrapRunner,
} from "../bootstrap/repo-factory-bootstrap-run.ts";

export type RepairAuthorization = "HERMES" | "OWNER";

// Orphan pruning is destructive, so an unfamiliar future run state is retained by
// default. The run-state machine is the single authority for deciding which states
// are terminal and can release a verification tree.
const VERIFICATION_WORKTREE_OWNER_RELEASE_STATES = TERMINAL_RUN_STATES;

/** The guard's read operations, which it decides DIRECT without a grant to hold or consume. */
const READ_OPERATIONS: ReadonlySet<unknown> = new Set(Object.values(ReadOperation));

/** The exact admitted ingress operation used for owner-authorised repair. */
export const REPAIR_OWNER_APPROVAL_OPERATION = "repair_execute";

/** #1096 — the orphan release's receipt names this operation; this fails to compile if the two differ. */
const _orphanReleaseApprovalOperation: typeof REPAIR_OWNER_APPROVAL_OPERATION = ORPHAN_RELEASE_APPROVAL_OPERATION;

/** PRD §25.7 — the operation contract every repair must satisfy. */
export interface RepairOperation {
  id: string;
  risk: "LOW" | "MEDIUM" | "HIGH";
  authorization: RepairAuthorization;
  description: string;
  expectedEffect: string;
  undo: string;
  preconditions: string[];
}

export interface RepairRequest {
  operationId: string;
  parameters: Record<string, string>;
  authorizedBy: RepairAuthorization;
  /** Required whenever an OWNER operation is requested: an admitted ingress receipt. */
  ownerApproval?: OwnerApprovalReceipt | null;
  /** @deprecated Identity tuples are never authority; use `ownerApproval`. */
  owner?: { channel: string; actor: string } | null;
  runId?: string | null;
  dryRun: boolean;
}

const assertRepairApproval = (
  request: RepairRequest,
  receipt: OwnerApprovalReceipt,
): Decision<void> => {
  const expectedParameters = {
    operationId: request.operationId,
    parameters: request.parameters,
    dryRun: request.dryRun,
  };
  if (
    receipt.runId !== (request.runId ?? null) ||
    receipt.operation !== REPAIR_OWNER_APPROVAL_OPERATION ||
    receipt.parameterDigest !== digestOf(expectedParameters) ||
    receipt.approved !== true
  ) {
    return deny(
      ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE,
      "owner repair receipt does not bind this exact repair operation",
      {
        operationId: request.operationId,
        receiptOperation: receipt.operation,
        receiptRunId: receipt.runId,
      },
    );
  }
  return allow(ReasonCode.OK, undefined);
};

export interface RepairReceipt {
  operationId: string;
  parameters: Record<string, string>;
  dryRun: boolean;
  authorizedBy: RepairAuthorization;
  preconditionsChecked: Array<{ precondition: string; satisfied: boolean; evidence: unknown }>;
  effect: string;
  changes: number;
  performedAt: string;
  digest: string;
}

/**
 * PRD §25.7 — the doctor diagnoses, repair acts, and the two never merge.
 *
 * Every operation is on an explicit allowlist with a declared risk and authorization
 * level. Anything that could destroy work requires the owner; Hermes may authorise only
 * low-risk cleanup. Dry run is always available and is the default for high risk.
 */
export class RepairService {
  private readonly operations: Readonly<Record<string, RepairOperation>> = {
    expire_stale_claims: {
      id: "expire_stale_claims",
      risk: "LOW",
      authorization: "HERMES",
      description: "Mark resource claims past their lease as EXPIRED",
      expectedEffect: "expired claims stop blocking new acquisitions",
      undo: "none needed; a live holder simply re-acquires",
      preconditions: ["every affected claim is past its expiry"],
    },
    abandon_dead_executions: {
      id: "abandon_dead_executions",
      risk: "MEDIUM",
      authorization: "HERMES",
      description: "Close task execution receipts whose worker process is gone",
      expectedEffect: "the task becomes retryable instead of appearing to run forever",
      undo: "none; a new attempt supersedes the abandoned one",
      preconditions: ["the execution is RUNNING", "its worker process is not alive"],
    },
    retry_outbox: {
      id: "retry_outbox",
      risk: "LOW",
      authorization: "HERMES",
      description: "Reset delivery attempts on pending outbox messages",
      expectedEffect: "pending messages are retried on the next delivery pass",
      undo: "none; delivery remains idempotent",
      preconditions: ["messages are PENDING and unexpired"],
    },
    prune_orphan_worktrees: {
      id: "prune_orphan_worktrees",
      risk: "HIGH",
      authorization: "OWNER",
      description: "Remove verification worktrees with no live task or durable owner reference",
      expectedEffect: "disk is reclaimed and git worktree metadata is pruned",
      undo: "none — uncommitted work inside a pruned worktree is lost",
      preconditions: ["no running task execution or live durable verification owner references the worktree"],
    },
    clear_repository_drift: {
      id: "clear_repository_drift",
      risk: "MEDIUM",
      authorization: "HERMES",
      description: "Accept the observed head as the new registry baseline",
      expectedEffect: "the drift warning clears; pending candidates stay stale regardless",
      undo: "re-observe the repository",
      preconditions: ["the repository is readable"],
    },
    restore_refused_cancel_bootstrap_task: {
      id: "restore_refused_cancel_bootstrap_task",
      risk: "MEDIUM",
      authorization: "HERMES",
      description: "Restore the single frozen bootstrap PLAN task lost to a refused run cancel",
      expectedEffect: "exactly the existing task returns from CANCELLED to READY; CONFIRM can check it again",
      undo: "none needed; no plan, candidate, application or run authority changes",
      preconditions: [
        "EXACT_PARAMETERS", "NON_TERMINAL_BOOTSTRAP_RUN", "RESERVED_APPLICATION",
        "CURRENT_PLAN_BINDING", "LATEST_PLAN_TASK", "CANCELLED_UNEXECUTED_TASK",
        "SINGLE_CANCEL_CAUSE", "NO_CANCELLED_RUN_TRANSITION", "NO_NEWER_TASK_GRAPH", "NO_OTHER_LIVE_TASK",
        "CANCEL_REASON_DIGEST", "NO_LATER_TASK_CHANGE",
      ],
    },
    // #246 C3, CEO decision (b) as corrected — a cancelled run's reservation released once its
    // application is shown to have had no external effect, so a new run may reserve the same name
    // under its own approval. It changes nothing outside the database and authorises nothing.
    release_bootstrap_reservation: {
      id: "release_bootstrap_reservation",
      risk: "MEDIUM",
      authorization: "HERMES",
      description:
        "Release a cancelled PROJECT_BOOTSTRAP run's reservation of its project id and repository identity",
      expectedEffect:
        "the application becomes RELEASED and keeps its record; a new run may reserve the same project id and repository identity under its own owner approval; when no external effect can be proven nothing is released and the reservation is kept, RELEASE_IN_DOUBT",
      undo: "none needed: nothing outside the database changed, and the released run cannot be confirmed again",
      preconditions: [...RESERVATION_RELEASE_PRECONDITIONS],
    },
    // #1096 — a worker launch the guard admitted whose pid was never recorded leaves its task blocked
    // for good: no pid can ever be confirmed gone. After the operator has checked that nothing of it
    // runs, this records that one orphan event resolved. It reads the process table and signals nothing.
    // Owner-authorised: at the moment it writes, it proves the owner live through the configured owner
    // authority, and its release record carries an authorization digest bound to this orphan and that
    // receipt, which the audit API cannot write (`orphanResolutionVerified`). The record is durable; a
    // raw SQL writer is the Limit `worker-orphan-release.ts` names.
    [ORPHAN_RELEASE_REPAIR_ID]: {
      id: ORPHAN_RELEASE_REPAIR_ID,
      risk: "MEDIUM",
      authorization: "OWNER",
      description:
        "Record one worker orphan event that was never identified (a launch with no recorded pid) as resolved, so its task may run again",
      expectedEffect:
        "the task's next worker turn is admitted again; the orphan record stays, and a resolution naming this repair and the operator's admitted receipt is recorded beside it",
      undo: "none needed: nothing is signalled, deleted or rewritten, and a later unidentified orphan of the task blocks it again",
      preconditions: [
        "orphanEventId names an unidentified-orphan record of this execution, with no recorded pid, that no verified resolution follows",
        "the execution is not RUNNING and records no worker process",
        `the parameters are exactly executionId, orphanEventId and the operator's confirmation that nothing of the orphan is running (confirm=${ORPHAN_RELEASE_CONFIRMATION})`,
        "no live process carries the worker session's id on its command line",
      ],
    },
  };

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly audit: AuditLog,
    private readonly artifacts: ArtifactStore,
    private readonly claims: ClaimRegistry,
    private readonly worktrees: WorktreeManager,
    private readonly repositories: RepositoryRegistry,
    private readonly guard: ManagedWriteGuard,
    private readonly repairAuthority: RepairWorktreeAuthority,
  ) {}

  #ownerAuthority: OwnerAuthorityPort | null = null;
  #bootstrapRecovery: BootstrapCheckoutRecoveryPort | null = null;

  attach(ports: { ownerAuthority?: OwnerAuthorityPort; bootstrapRecovery?: BootstrapCheckoutRecoveryPort }): void {
    if (ports.ownerAuthority) this.#ownerAuthority = ports.ownerAuthority;
    if (ports.bootstrapRecovery) this.#bootstrapRecovery = ports.bootstrapRecovery;
  }

  catalog(): RepairOperation[] {
    return Object.values(this.operations);
  }

  async execute(request: RepairRequest): Promise<Decision<RepairReceipt>> {
    const operation = this.operations[request.operationId];
    if (!operation) {
      return deny(ReasonCode.REPAIR_NOT_ALLOWLISTED, "unknown repair operation", {
        operationId: request.operationId,
        allowlist: Object.keys(this.operations),
      });
    }
    let ownerReceipt: OwnerApprovalReceipt | null = null;
    if (operation.authorization === "OWNER") {
      if (request.authorizedBy !== "OWNER" || !request.ownerApproval) {
        return deny(
          ReasonCode.REPAIR_REQUIRES_OWNER,
          this.#ownerAuthority
            ? "this repair can destroy work and requires an admitted owner ingress receipt"
            : "no owner authority is configured, so an owner-authorised repair is impossible",
          {
            operationId: operation.id,
            risk: operation.risk,
            authorizedBy: request.authorizedBy,
            actor: request.ownerApproval?.actor ?? request.owner?.actor ?? null,
          },
        );
      }

      const exactApproval = assertRepairApproval(request, request.ownerApproval);
      if (!exactApproval.allowed) return exactApproval;
      const admitted = this.#ownerAuthority?.assertApproval(request.ownerApproval);
      if (!admitted) {
        return deny(
          ReasonCode.REPAIR_REQUIRES_OWNER,
          "no owner authority is configured, so an owner-authorised repair is impossible",
          { operationId: operation.id },
        );
      }
      if (!admitted.allowed) return admitted as Decision<RepairReceipt>;
      ownerReceipt = request.ownerApproval;
    }

    if (operation.id === "restore_refused_cancel_bootstrap_task") {
      const result = this.db.txDecision(() => this.restoreRefusedCancelBootstrapTask(operation, request));
      if (!result.allowed) {
        this.audit.record({ kind: "REPAIR_REFUSED", reasonCode: result.reasonCode,
          runId: request.parameters["runId"] ?? null, actor: request.authorizedBy, evidence: result.evidence });
      }
      return result;
    }

    const plan = await this.plan(operation, request);
    if (plan.preconditions.some((precondition) => !precondition.satisfied)) {
      this.audit.record({
        kind: "REPAIR_REFUSED",
        reasonCode: ReasonCode.REPAIR_PRECONDITION_UNMET,
        runId: request.runId ?? null,
        actor: request.authorizedBy,
        evidence: { operationId: operation.id, preconditions: plan.preconditions },
      });
      return deny(ReasonCode.REPAIR_PRECONDITION_UNMET, "repair preconditions are not satisfied", {
        operationId: operation.id,
        preconditions: plan.preconditions,
      });
    }

    if (ownerReceipt) {
      const consumed = this.#ownerAuthority!.consumeApproval(ownerReceipt, null);
      if (!consumed.allowed) return consumed as Decision<RepairReceipt>;
    }

    const outcome = await plan.perform(request.dryRun);
    // A repair whose effect was refused at the moment of acting changed nothing, and says so.
    if (outcome.refusal !== undefined) {
      this.audit.record({
        kind: "REPAIR_REFUSED",
        reasonCode: outcome.refusal.reasonCode,
        runId: request.runId ?? null,
        actor: request.authorizedBy,
        evidence: { operationId: operation.id, refusal: outcome.refusal.evidence },
      });
      return outcome.refusal;
    }

    return this.recordReceipt(operation, request, plan.preconditions, outcome);
  }

  private recordReceipt(
    operation: RepairOperation,
    request: RepairRequest,
    preconditions: RepairReceipt["preconditionsChecked"],
    outcome: { changes: number; evidence: unknown },
    requireAudit = false,
  ): Decision<RepairReceipt> {
    const receipt: RepairReceipt = {
      operationId: operation.id,
      parameters: request.parameters,
      dryRun: request.dryRun,
      authorizedBy: request.authorizedBy,
      preconditionsChecked: preconditions,
      effect: operation.expectedEffect,
      changes: outcome.changes,
      performedAt: this.clock.nowIso(),
      digest: digestOf({
        operation: operation.id,
        parameters: request.parameters,
        preconditions,
        evidence: outcome.evidence,
      }),
    };

    if (request.runId) {
      this.artifacts.put(request.runId, ArtifactKind.REPAIR_RECEIPT, receipt);
    }
    const recorded = this.audit.record({
      kind: request.dryRun ? "REPAIR_DRY_RUN" : "REPAIR_EXECUTED",
      runId: request.runId ?? null,
      actor: request.authorizedBy,
      evidence: {
        operationId: operation.id,
        risk: operation.risk,
        changes: outcome.changes,
        preconditions,
        target: outcome.evidence,
      },
    });

    if (requireAudit && !recorded.allowed) fail(recorded.reasonCode, recorded.message, recorded.evidence);
    return allow(ReasonCode.OK, receipt);
  }

  /**
   * Limited recovery: direct database writes are outside its threat model. It relies on
   * the only product path writing this shape being the pre-fix non-atomic refused cancel,
   * plus separately held evidence of the refused request whose reason digest the caller supplies.
   * All evidence is reloaded under the same BEGIN IMMEDIATE as the one-task write and receipt.
   */
  private restoreRefusedCancelBootstrapTask(operation: RepairOperation, request: RepairRequest): Decision<RepairReceipt> {
    const runId = request.parameters["runId"] ?? "";
    const taskId = request.parameters["taskId"] ?? "";
    const suppliedDigest = request.parameters["cancelReasonSha256"] ?? "";
    const validDigest = /^[0-9a-f]{64}$/.test(suppliedDigest);
    const run = this.db.get<{ kind: string; state: RunState; current_candidate_digest: string | null }>(
      `SELECT kind, state, current_candidate_digest FROM runs WHERE run_id = ?`, [runId],
    );
    const application = this.db.get<{ phase: string; plan_digest: string; candidate_snapshot_digest: string }>(
      `SELECT phase, plan_digest, candidate_snapshot_digest FROM bootstrap_applications WHERE run_id = ?`, [runId],
    );
    const plan = this.artifacts.latest(runId, "PLAN");
    const candidate = run?.current_candidate_digest
      ? this.artifacts.latestForSnapshot<CandidateSnapshot>(runId, "CANDIDATE_SNAPSHOT", run.current_candidate_digest)
      : null;
    const tasks = this.db.all<{ task_id: string; state: string; updated_at: string }>(
      `SELECT task_id, state, updated_at FROM tasks WHERE run_id = ?`, [runId],
    );
    const task = tasks.find(row => row.task_id === taskId);
    const executions = this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM task_executions WHERE task_id = ?`, [taskId])!.n;
    const events = this.audit.forRun(runId);
    const binding = events.filter(event => event.kind === "BOOTSTRAP_PLAN_TASKS").at(-1);
    // READY is a no-op only with this repair's own successful receipt, still the task's last write.
    const restored = events.filter(event => event.kind === "REPAIR_EXECUTED" &&
      event.evidence["operationId"] === operation.id && event.evidence["changes"] === 1 &&
      (event.evidence["target"] as { taskId?: unknown } | undefined)?.taskId === taskId).at(-1);
    const previous = restored?.evidence["target"] as { cancelledAt?: unknown; cancelEventId?: unknown; restoredAt?: unknown } | undefined;
    const alreadyRestored = task?.state === "READY" && task.updated_at === previous?.restoredAt;
    const cancelledAt = alreadyRestored ? previous?.cancelledAt : task?.updated_at;
    const cancellations = events.filter(event => event.kind === "TASK_GRAPH_CANCELLED" && event.at === cancelledAt);
    const cancellation = cancellations.length === 1 ? cancellations[0] : undefined;
    const reason = cancellation?.evidence["reason"];
    const reasonDigest = typeof reason === "string" ? sha256Hex(reason) : null;
    const sameInstantTasks = tasks.filter(row => row.state === "CANCELLED" && row.updated_at === cancelledAt);
    const causal = cancellation !== undefined && cancellation.evidence["changes"] === 1 &&
      (alreadyRestored
        ? previous?.cancelEventId === cancellation.eventId && sameInstantTasks.length === 0
        : sameInstantTasks.length === 1 && sameInstantTasks[0]!.task_id === taskId) &&
      binding !== undefined && binding.eventId < cancellation.eventId;
    const cancelledTransitions = events.filter(event => event.kind === "RUN_TRANSITION" &&
      event.evidence["to"] === "CANCELLED" && cancellation !== undefined &&
      (event.eventId >= cancellation.eventId || event.at >= cancellation.at));
    const newerGraphs = events.filter(event =>
      ["BOOTSTRAP_TASKS_SUPERSEDED", "TASK_GRAPH_SUBMITTED", "BOOTSTRAP_PLAN_TASKS"].includes(event.kind) &&
      cancellation !== undefined && event.eventId > cancellation.eventId);
    const otherLiveTasks = tasks.filter(row => row.task_id !== taskId && row.state !== "CANCELLED");
    const namesTask = (value: unknown): boolean => value === taskId ||
      (value !== null && typeof value === "object" && Object.values(value).some(namesTask));
    // #1213 — a later record naming the task disqualifies the restore only if it may have changed something.
    // It did not when the continuity-hold classification records its kind only as a refusal, deferral or
    // ignored input, or reads its outcome as not applied (a refused guard evaluation), or when it is a guard
    // evaluation of a read. Every other kind, one added later included, counts as a change.
    const mayHaveChanged = (event: AuditRow): boolean =>
      !CONTINUITY_HOLD_NON_MOVEMENT_KINDS.includes(event.kind) &&
      !(event.kind === "MANAGED_WRITE_GUARD" && READ_OPERATIONS.has(event.evidence["operation"])) &&
      isRecordedMovement({ kind: event.kind, reason_code: event.reasonCode, evidence_json: JSON.stringify(event.evidence) });
    // This repair's own reports name the task but are not subsequent task activity.
    // The one READY write is accepted only through alreadyRestored's receipt/timestamp check.
    const laterTaskEvents = events.filter(event => cancellation !== undefined && event.eventId > cancellation.eventId &&
      !(event.evidence["operationId"] === operation.id &&
        ["REPAIR_DRY_RUN", "REPAIR_EXECUTED", "REPAIR_REFUSED"].includes(event.kind)) &&
      namesTask(event.evidence) && mayHaveChanged(event));
    // Never copy event payloads (especially reason text) into repair reports or refusals.
    const eventEvidence = (event: AuditRow) => ({
      eventId: event.eventId, at: event.at, kind: event.kind, digest: digestOf(event.evidence),
    });
    const checks = [
      checked("EXACT_PARAMETERS", runId !== "" && taskId !== "" &&
        validDigest && Object.keys(request.parameters).sort().join(",") === "cancelReasonSha256,runId,taskId" &&
        (request.runId == null || request.runId === runId), { runId, taskId }),
      checked("NON_TERMINAL_BOOTSTRAP_RUN", run !== undefined && run.kind === "PROJECT_BOOTSTRAP" &&
        !isTerminal(run.state), run ?? null),
      checked("RESERVED_APPLICATION", application?.phase === "RESERVED", application ?? null),
      checked("CURRENT_PLAN_BINDING", plan != null && candidate != null &&
        candidate.content?.bootstrapPlan?.planDigest === plan.digest && application?.plan_digest === plan.digest &&
        application.candidate_snapshot_digest === run?.current_candidate_digest,
      { planDigest: plan?.digest ?? null, candidatePlanDigest: candidate?.content?.bootstrapPlan?.planDigest ?? null }),
      checked("LATEST_PLAN_TASK", binding !== undefined && binding.evidence["planDigest"] === plan?.digest &&
        Array.isArray(binding.evidence["taskIds"]) && binding.evidence["taskIds"].length === 1 &&
        binding.evidence["taskIds"][0] === taskId, { binding: binding ? eventEvidence(binding) : null }),
      checked("CANCELLED_UNEXECUTED_TASK", task !== undefined && executions === 0 &&
        (task.state === "CANCELLED" || alreadyRestored), { task: task ?? null, executions, alreadyRestored }),
      checked("SINGLE_CANCEL_CAUSE", causal,
        { cancellations: cancellations.map(eventEvidence), sameInstantTaskIds: sameInstantTasks.map(row => row.task_id) }),
      checked("NO_CANCELLED_RUN_TRANSITION", cancelledTransitions.length === 0,
        { cancelledTransitions: cancelledTransitions.map(eventEvidence) }),
      checked("NO_NEWER_TASK_GRAPH", newerGraphs.length === 0, { newerGraphs: newerGraphs.map(eventEvidence) }),
      checked("NO_OTHER_LIVE_TASK", otherLiveTasks.length === 0, { otherLiveTasks }),
      checked("CANCEL_REASON_DIGEST", validDigest && reasonDigest !== null && reasonDigest === suppliedDigest,
        { expected: validDigest ? suppliedDigest : null, observedDigest: reasonDigest }),
      checked("NO_LATER_TASK_CHANGE", cancellation !== undefined &&
        (alreadyRestored || task?.updated_at === cancellation.at) && laterTaskEvents.length === 0,
      { updatedAt: task?.updated_at ?? null, cancelledAt: cancellation?.at ?? null, laterTaskEvents: laterTaskEvents.map(eventEvidence) }),
    ];
    const failed = checks.find(check => !check.satisfied);
    if (failed) return deny(ReasonCode.REPAIR_PRECONDITION_UNMET, `bootstrap task restore refused: ${failed.precondition}`, {
      operationId: operation.id, refusal: failed.precondition, preconditions: checks,
    });
    const changes = alreadyRestored ? 0 : 1;
    const restoredAt = this.clock.nowIso();
    if (!request.dryRun && changes === 1) {
      this.db.run(`UPDATE tasks SET state = 'READY', updated_at = ? WHERE task_id = ?`, [restoredAt, taskId]);
    }
    return this.recordReceipt(operation, { ...request, runId }, checks, {
      changes,
      evidence: { runId, taskId, from: "CANCELLED", to: "READY", planDigest: plan!.digest,
        cancelEventId: cancellation!.eventId, cancelReasonSha256: reasonDigest, cancelledAt, restoredAt, alreadyRestored },
    }, true);
  }

  private async plan(operation: RepairOperation, request: RepairRequest): Promise<RepairPlan> {
    switch (operation.id) {
      case "expire_stale_claims": {
        const overdue = this.claims.overdue();
        const preconditions = [checked(
          operation.preconditions[0]!,
          overdue.length > 0,
          { overdueClaimIds: overdue.map((claim) => claim.claimId) },
        )];
        return {
          preconditions,
          perform: async (dryRun) => ({
            changes: dryRun ? overdue.length : this.claims.expireOverdue(),
            evidence: { overdueClaimIds: overdue.map((claim) => claim.claimId) },
          }),
        };
      }
      case "abandon_dead_executions": {
        const running = this.db.all<{ execution_id: string; worker_process_id: number | null }>(
          `SELECT execution_id, worker_process_id FROM task_executions WHERE status = 'RUNNING'`,
        );
        const dead = running.filter(
          (execution) =>
            execution.worker_process_id !== null &&
            Number.isInteger(execution.worker_process_id) &&
            execution.worker_process_id > 0 &&
            !alive(execution.worker_process_id),
        );
        const evidence = {
          running: running.map((execution) => ({
            executionId: execution.execution_id,
            workerProcessId: execution.worker_process_id,
          })),
          deadExecutionIds: dead.map((execution) => execution.execution_id),
        };
        return {
          preconditions: [
            checked(operation.preconditions[0]!, dead.length > 0, evidence),
            checked(operation.preconditions[1]!, dead.length > 0, evidence),
          ],
          perform: async (dryRun) => {
            if (dryRun) return { changes: dead.length, evidence };
            let changes = 0;
            for (const execution of dead) {
              changes += this.db.run(
                `UPDATE task_executions SET status = 'ABANDONED', ended_at = ?, failure_class = 'infrastructure'
                  WHERE execution_id = ? AND status = 'RUNNING'`,
                [this.clock.nowIso(), execution.execution_id],
              ).changes;
            }
            return { changes, evidence };
          },
        };
      }
      case "retry_outbox": {
        const pending = this.db.all<{ message_id: string; expires_at: string }>(
          `SELECT message_id, expires_at FROM outbox WHERE status = 'PENDING' AND attempts > 0`,
        );
        const now = this.clock.nowIso();
        const eligible = pending.filter((message) => message.expires_at > now);
        const evidence = {
          pending: pending.map((message) => ({ messageId: message.message_id, expiresAt: message.expires_at })),
          eligibleMessageIds: eligible.map((message) => message.message_id),
        };
        return {
          preconditions: [checked(operation.preconditions[0]!, eligible.length > 0, evidence)],
          perform: async (dryRun) => {
            if (dryRun) return { changes: eligible.length, evidence };
            let changes = 0;
            for (const message of eligible) {
              changes += this.db.run(
                `UPDATE outbox SET attempts = 0, last_error = NULL
                  WHERE message_id = ? AND status = 'PENDING' AND expires_at > ?`,
                [message.message_id, now],
              ).changes;
            }
            return { changes, evidence };
          },
        };
      }
      case "prune_orphan_worktrees": {
        const taskLive = new Set(
          this.db
            .all<{ worktree_id: string | null }>(
              `SELECT worktree_id FROM task_executions WHERE status = 'RUNNING' AND worktree_id IS NOT NULL`,
            )
            .map((row) => row.worktree_id!)
            .filter(Boolean),
        );
        const candidates: Array<{ identity: string; checkoutPath: string; worktreeId: string }> = [];
        const probeFailures: Array<{ identity: string; error: string }> = [];
        const liveByRepository = new Map<string, Set<string>>();
        for (const repository of this.repositories.list()) {
          try {
            const live = new Set([
              ...taskLive,
              ...this.liveVerificationWorktreeIds(repository.identity),
            ]);
            liveByRepository.set(repository.identity, live);
            const orphans = await this.worktrees.orphans(
              repository.checkoutPath,
              live,
              (worktreeId) =>
                live.has(worktreeId) || this.liveVerificationWorktreeIds(repository.identity).has(worktreeId),
            );
            candidates.push(...orphans.map((worktreeId) => ({
              identity: repository.identity,
              checkoutPath: repository.checkoutPath,
              worktreeId,
            })));
          } catch (err) {
            probeFailures.push({ identity: repository.identity, error: safeErrorMessage(err) });
          }
        }
        const evidence = {
          liveWorktreeIds: [...new Set([...liveByRepository.values()].flatMap((ids) => [...ids]))],
          liveWorktreeIdsByRepository: Object.fromEntries(
            [...liveByRepository.entries()].map(([identity, ids]) => [identity, [...ids]]),
          ),
          candidates,
          probeFailures,
        };
        return {
          preconditions: [checked(
            operation.preconditions[0]!,
            probeFailures.length === 0 && candidates.length > 0,
            evidence,
          )],
          perform: async (dryRun) => {
            if (dryRun) return { changes: candidates.length, evidence };
            let changes = 0;
            for (const candidate of candidates) {
              const path = this.worktrees.pathFor(candidate.worktreeId);
              await this.worktrees.destroy(
                candidate.checkoutPath,
                path,
                this.repairWorktreeAuthorization(candidate.identity, candidate.checkoutPath, path),
              );
              changes += 1;
            }
            return { changes, evidence };
          },
        };
      }
      case "clear_repository_drift": {
        const identity = request.parameters["identity"];
        const repository = identity ? this.repositories.byIdentity(identity) : null;
        let head: string | null = null;
        let clean = false;
        let probeError: string | null = null;
        if (repository) {
          try {
            head = await tryRevParse(repository.checkoutPath, "HEAD");
            clean = head !== null && await isClean(repository.checkoutPath);
          } catch (err) {
            probeError = safeErrorMessage(err);
          }
        }
        const evidence = {
          identity: identity ?? null,
          found: repository !== null,
          checkoutPath: repository?.checkoutPath ?? null,
          observedHead: head,
          clean,
          probeError,
        };
        return {
          preconditions: [checked(
            operation.preconditions[0]!,
            repository !== null && head !== null && clean && probeError === null,
            evidence,
          )],
          perform: async (dryRun) => {
            const changes = repository && head && repository.driftState !== "IN_SYNC" ? 1 : 0;
            if (!dryRun && repository && head) this.repositories.acknowledgeHead(repository.repositoryId, head);
            return { changes, evidence };
          },
        };
      }
      case "release_bootstrap_reservation": {
        const recovery = this.#bootstrapRecovery;
        const runId = request.runId ?? null;
        if (recovery === null) {
          return {
            preconditions: operation.preconditions.map((precondition) =>
              checked(precondition, false, { notChecked: "no bootstrap runner is attached to verify it" })),
            perform: async () => ({ changes: 0, evidence: null }),
          };
        }
        const inspected = recovery.inspectReservationRelease(runId);
        // An unclear external effect keeps the reservation, and says so on it; a dry run records nothing.
        if (inspected.inDoubt !== null && runId !== null && !request.dryRun) recovery.recordReleaseInDoubt(runId, inspected.inDoubt);
        return {
          preconditions: inspected.preconditions,
          perform: async (dryRun) => {
            if (dryRun) return { changes: 1, evidence: inspected.release };
            const released = recovery.releaseReservation(runId, inspected.release);
            if (!released.allowed) return { changes: 0, evidence: released.evidence, refusal: released as Decision<never> };
            return { changes: 1, evidence: released.value };
          },
        };
      }
      case ORPHAN_RELEASE_REPAIR_ID: {
        const executionId = request.parameters["executionId"] ?? "";
        // Only an orphan event no verified release follows; a resolution row this repair did not write is ignored.
        const unresolved = executionId === "" ? [] : unresolvedUnidentifiedOrphans(this.db, { executionId });
        const orphan = unresolved.find((candidate) => String(candidate.eventId) === request.parameters["orphanEventId"]);
        // The receipt binds the parameters; only these exact ones are what the reader will verify.
        const exactParameters =
          orphan !== undefined && digestOf(request.parameters) === digestOf(orphanReleaseParameters(executionId, orphan.eventId));
        const execution = this.db.get<{ task_id: string; status: string; worker_process_id: number | null; worker_session_id: string }>(
          `SELECT task_id, status, worker_process_id, worker_session_id FROM task_executions WHERE execution_id = ?`,
          [executionId],
        );
        const incarnation = execution
          ? this.db.get<{ incarnation: string }>(`SELECT incarnation FROM sessions WHERE session_id = ?`, [execution.worker_session_id])?.incarnation
          : undefined;
        // Claude carries the session as `--session-id <id>`. A Codex worker carries the same id as
        // the argv element after `--thread-source`. Either way it is one whole argument.
        const workerSessionId = incarnation?.split("#", 1)[0] ?? "";
        const scan = workerSessionId === "" ? { carriers: [], error: "the worker session's id is unknown" } : processesCarrying(workerSessionId);
        const confirmation = request.parameters["confirm"] ?? null;
        const evidence = {
          executionId,
          taskId: execution?.task_id ?? null,
          orphanEventId: orphan?.eventId ?? null,
          // Every orphan event of this execution still blocking its task: what `orphanEventId` may name.
          unresolvedOrphanEventIds: unresolved.map((candidate) => candidate.eventId),
          executionStatus: execution?.status ?? null,
          workerProcessId: execution?.worker_process_id ?? null,
          workerSessionId: execution?.worker_session_id ?? null,
          confirmation,
          liveProcessScan: scan,
        };
        return {
          preconditions: [
            checked(operation.preconditions[0]!, orphan !== undefined, evidence),
            checked(operation.preconditions[1]!, execution !== undefined && execution.status !== "RUNNING" && execution.worker_process_id === null, evidence),
            checked(operation.preconditions[2]!, exactParameters && confirmation === ORPHAN_RELEASE_CONFIRMATION, evidence),
            checked(operation.preconditions[3]!, scan.error === null && scan.carriers.length === 0, evidence),
          ],
          perform: async (dryRun) => {
            if (dryRun) return { changes: 1, evidence };
            const recorded = this.db.txDecision(() => this.recordOrphanRelease(request, evidence));
            if (!recorded.allowed) return { changes: 0, evidence, refusal: recorded as Decision<never> };
            return { changes: 1, evidence };
          },
        };
      }
      default:
        throw new Error(`missing repair plan for ${operation.id}`);
    }
  }

  /**
   * #1096 — the release record of `release_unidentified_worker_orphan`, the only thing that releases an
   * unidentified orphan (`orphanResolutionVerified`). Owner identity is proven live, at the moment of use,
   * through the configured owner authority: the receipt names an allowlisted owner and its admission still
   * stands (`assertApproval`), and `execute` has just consumed it for no candidate (`assertConsumedApproval`).
   * The orphan is read again here, so it is still unresolved, its execution still records no process, and
   * the receipt approves exactly its release. The record is written by this insert, not `AuditLog.record`:
   * its authorization digest sits under a key the audit API redacts; the rest is redacted as the audit API
   * would. Its reader never asks the ingress replay cache again, so the release stays durable.
   */
  private recordOrphanRelease(request: RepairRequest, evidence: Record<string, unknown>): Decision<void> {
    const receipt = request.ownerApproval;
    const owner = this.#ownerAuthority;
    if (!receipt || !owner) {
      return deny(
        ReasonCode.REPAIR_REQUIRES_OWNER,
        "an orphan release is recorded only under an owner receipt the configured owner authority admits",
        { operationId: ORPHAN_RELEASE_REPAIR_ID },
      );
    }
    const live = owner.assertApproval(receipt);
    if (!live.allowed) return live;
    const consumed = owner.assertConsumedApproval(receipt, null);
    if (!consumed.allowed) return consumed;
    const executionId = request.parameters["executionId"] ?? "";
    const orphanEventId = request.parameters["orphanEventId"] ?? null;
    const orphan = unresolvedUnidentifiedOrphans(this.db, { executionId }).find(
      (candidate) => String(candidate.eventId) === orphanEventId,
    );
    const execution = orphanExecutionOf(this.db, executionId);
    if (
      orphan === undefined ||
      execution === null ||
      execution.taskId !== orphan.taskId ||
      execution.workerProcessId !== null ||
      receipt.parameterDigest !== orphanReleaseParameterDigest(executionId, orphan.eventId)
    ) {
      return deny(
        ReasonCode.REPAIR_PRECONDITION_UNMET,
        "the receipt no longer names an unresolved unidentified orphan of this execution",
        { executionId, orphanEventId },
      );
    }
    const approval: OrphanReleaseApproval = {
      channel: receipt.channel,
      actor: receipt.actor,
      nonce: receipt.inboundNonce,
      receiptDigest: digestOf(receipt),
      parameterDigest: receipt.parameterDigest,
    };
    const recorded = redact({ ...evidence, operationId: ORPHAN_RELEASE_REPAIR_ID, ownerApproval: approval }) as Record<string, unknown>;
    this.db.run(
      `INSERT INTO audit_events (at, kind, reason_code, run_id, actor, evidence_json)
       VALUES (?, ?, NULL, ?, ?, ?)`,
      [
        this.clock.nowIso(),
        WorkerTurnEvent.ORPHAN_RESOLVED,
        orphan.runId,
        `${receipt.channel}:${receipt.actor}`,
        JSON.stringify({
          ...recorded,
          [ORPHAN_RELEASE_AUTHORIZATION_KEY]: orphanReleaseAuthorization(orphan, execution, approval),
        }),
      ],
    );
    return allow(ReasonCode.OK, undefined);
  }

  private repairWorktreeAuthorization(
    repositoryIdentity: string,
    checkoutPath: string,
    path: string,
  ): WorktreeAuthorization {
    const common = {
      guard: this.guard,
      request: {
        operation: WriteOperation.GIT_WORKTREE,
        repositoryIdentity,
        targetWorktreeId: canonical(checkoutPath),
        targetBranch: null,
        runId: null,
        sessionId: null,
        bindingGeneration: null,
        claimedClassification: "MANAGED" as const,
        actor: "doctor-repair",
        repairWorktreeAuthority: this.repairAuthority,
      },
    };
    return {
      remove: { ...common, request: { ...common.request, targetPath: path, worktreeAction: WorktreeAction.REMOVE } },
      cleanup: { ...common, request: { ...common.request, targetPath: path, worktreeAction: WorktreeAction.CLEANUP } },
      prune: { ...common, request: { ...common.request, targetPath: checkoutPath, worktreeAction: WorktreeAction.PRUNE } },
    };
  }

  /**
   * A verification checkout is live while its durable record names the current run owner
   * tuple and that owner has not reached a terminal run state. This deliberately retains
   * BLOCKED, AWAITING_HUMAN, review, approval, merge, and revision states: source-write
   * admission may pause there, but the owner has not released the verification tree.
   *
   * The predicate is queried again immediately before orphan pruning so a concurrent
   * owner repair cannot turn a just-created or still-tearing-down tree into a candidate
   * between the initial list and the destructive effect.
   */
  private liveVerificationWorktreeIds(repositoryIdentity: string): Set<string> {
    return new Set(
      this.db
        .all<{ worktree_id: string }>(
          `SELECT v.worktree_id
             FROM verification_worktrees v
             JOIN runs r ON r.run_id = v.run_id
             JOIN assignments a
               ON a.role_key = v.owner_role_key
              AND a.session_id = v.owner_session_id
              AND a.binding_generation = v.owner_binding_generation
              AND a.status = 'ACTIVE'
              AND (a.run_id = r.run_id OR (a.role = 'PRIMARY_CTO' AND a.project_id = r.project_id))
             JOIN sessions s ON s.session_id = v.owner_session_id
            WHERE v.repository_identity = ?
              AND v.state IN ('CREATING','ACTIVE','DESTROYING')
              AND r.state NOT IN (${VERIFICATION_WORKTREE_OWNER_RELEASE_STATES.map(() => "?").join(", ")})
              AND r.owner_session_id = v.owner_session_id
              AND r.owner_binding_generation = v.owner_binding_generation
              AND r.owner_role_key = v.owner_role_key
              AND s.lifecycle IN ('STARTING','READY','DRAINING')`,
          [repositoryIdentity, ...VERIFICATION_WORKTREE_OWNER_RELEASE_STATES],
        )
        .map((row) => row.worktree_id),
    );
  }
}

interface RepairPlan {
  preconditions: RepairReceipt["preconditionsChecked"];
  /** `refusal` when the effect itself was refused at the moment of acting: nothing changed. */
  perform(dryRun: boolean): Promise<{ changes: number; evidence: unknown; refusal?: Decision<never> }>;
}

/** #246 C3 — the bootstrap runner's reservation release, as the repair catalog uses it. */
export type BootstrapCheckoutRecoveryPort = Pick<
  RepoFactoryBootstrapRunner,
  "inspectReservationRelease" | "releaseReservation" | "recordReleaseInDoubt"
>;

const checked = (precondition: string, satisfied: boolean, evidence: unknown): RepairReceipt["preconditionsChecked"][number] => ({
  precondition,
  satisfied,
  evidence,
});

const alive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * #1096 — live processes whose command line carries `token` as one whole argument, read from `ps`. It
 * observes and signals nothing; any failure to read the table is an error, never an empty answer.
 */
const processesCarrying = (token: string): { carriers: number[]; error: string | null } => {
  let listing: string;
  try {
    listing = execFileSync("/bin/ps", ["-axww", "-o", "pid=,command="], {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    return { carriers: [], error: safeErrorMessage(err) };
  }
  const carriers: number[] = [];
  for (const line of listing.split("\n")) {
    const [pid, ...command] = line.trim().split(/\s+/);
    if (command.includes(token) && Number(pid) !== process.pid) carriers.push(Number(pid));
  }
  return { carriers, error: null };
};

const safeErrorMessage = (err: unknown): string => {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/[\r\n\t]/g, " ").slice(0, 500);
};
