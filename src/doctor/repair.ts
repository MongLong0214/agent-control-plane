import type { Clock } from "../core/clock.ts";
import { digestOf } from "../core/digest.ts";
import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { ClaimRegistry } from "../claims/claim-registry.ts";
import type { OwnerApprovalReceipt, OwnerAuthorityPort } from "../ceo/owner-authority.ts";
import type { AuditLog } from "../db/audit.ts";
import type { ArtifactStore } from "../db/artifacts.ts";
import type { Db } from "../db/database.ts";
import { ArtifactKind } from "../domain/types.ts";
import { TERMINAL_RUN_STATES } from "../domain/run-state.ts";
import { isClean, tryRevParse } from "../git/git.ts";
import type { RepositoryRegistry } from "../registry/repository-registry.ts";
import {
  type RepairWorktreeAuthority,
  type ManagedWriteGuard,
  WorktreeAction,
  WriteOperation,
} from "../guard/managed-write-guard.ts";
import type { WorktreeAuthorization, WorktreeManager } from "../verify/worktree.ts";
import { canonical } from "../guard/workspace-probe.ts";

export type RepairAuthorization = "HERMES" | "OWNER";

// Orphan pruning is destructive, so an unfamiliar future run state is retained by
// default. The run-state machine is the single authority for deciding which states
// are terminal and can release a verification tree.
const VERIFICATION_WORKTREE_OWNER_RELEASE_STATES = TERMINAL_RUN_STATES;

/** The exact admitted ingress operation used for owner-authorised repair. */
export const REPAIR_OWNER_APPROVAL_OPERATION = "repair_execute";

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

  attach(ports: { ownerAuthority?: OwnerAuthorityPort }): void {
    if (ports.ownerAuthority) this.#ownerAuthority = ports.ownerAuthority;
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

    const outcome = await plan.perform(request.dryRun);

    const receipt: RepairReceipt = {
      operationId: operation.id,
      parameters: request.parameters,
      dryRun: request.dryRun,
      authorizedBy: request.authorizedBy,
      preconditionsChecked: plan.preconditions,
      effect: operation.expectedEffect,
      changes: outcome.changes,
      performedAt: this.clock.nowIso(),
      digest: digestOf({
        operation: operation.id,
        parameters: request.parameters,
        preconditions: plan.preconditions,
        evidence: outcome.evidence,
      }),
    };

    if (request.runId) {
      this.artifacts.put(request.runId, ArtifactKind.REPAIR_RECEIPT, receipt);
    }
    this.audit.record({
      kind: request.dryRun ? "REPAIR_DRY_RUN" : "REPAIR_EXECUTED",
      runId: request.runId ?? null,
      actor: request.authorizedBy,
      evidence: {
        operationId: operation.id,
        risk: operation.risk,
        changes: outcome.changes,
        preconditions: plan.preconditions,
        target: outcome.evidence,
      },
    });

    return allow(ReasonCode.OK, receipt);
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
      default:
        throw new Error(`missing repair plan for ${operation.id}`);
    }
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
  perform(dryRun: boolean): Promise<{ changes: number; evidence: unknown }>;
}

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

const safeErrorMessage = (err: unknown): string => {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/[\r\n\t]/g, " ").slice(0, 500);
};
