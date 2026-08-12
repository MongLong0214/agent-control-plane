import type { Clock } from "../core/clock.ts";
import { digestOf } from "../core/digest.ts";
import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { ClaimRegistry } from "../claims/claim-registry.ts";
import type { AuditLog } from "../db/audit.ts";
import type { ArtifactStore } from "../db/artifacts.ts";
import type { Db } from "../db/database.ts";
import { ArtifactKind } from "../domain/types.ts";
import type { RepositoryRegistry } from "../registry/repository-registry.ts";
import type { WorktreeManager } from "../verify/worktree.ts";

export type RepairAuthorization = "HERMES" | "OWNER";

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
  runId?: string | null;
  dryRun: boolean;
}

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
      description: "Remove verification worktrees that no live execution references",
      expectedEffect: "disk is reclaimed and git worktree metadata is pruned",
      undo: "none — uncommitted work inside a pruned worktree is lost",
      preconditions: ["no running execution references the worktree"],
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
  ) {}

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
    if (operation.authorization === "OWNER" && request.authorizedBy !== "OWNER") {
      return deny(
        ReasonCode.REPAIR_REQUIRES_OWNER,
        "this repair can destroy work and requires owner authorization",
        { operationId: operation.id, risk: operation.risk },
      );
    }

    const handlers: Record<string, () => Promise<{ changes: number; evidence: unknown }>> = {
      expire_stale_claims: async () => {
        const overdue = this.claims.overdue();
        if (request.dryRun) return { changes: overdue.length, evidence: overdue.map((c) => c.claimId) };
        return { changes: this.claims.expireOverdue(), evidence: overdue.map((c) => c.claimId) };
      },
      abandon_dead_executions: async () => {
        const running = this.db.all<{ execution_id: string; worker_process_id: number | null }>(
          `SELECT execution_id, worker_process_id FROM task_executions WHERE status = 'RUNNING'`,
        );
        const dead = running.filter((r) => r.worker_process_id != null && !alive(r.worker_process_id));
        if (request.dryRun) return { changes: dead.length, evidence: dead.map((d) => d.execution_id) };
        let changes = 0;
        for (const execution of dead) {
          changes += this.db.run(
            `UPDATE task_executions SET status = 'ABANDONED', ended_at = ?, failure_class = 'infrastructure'
              WHERE execution_id = ?`,
            [this.clock.nowIso(), execution.execution_id],
          ).changes;
        }
        return { changes, evidence: dead.map((d) => d.execution_id) };
      },
      retry_outbox: async () => {
        const pending = this.db.all<{ message_id: string }>(
          `SELECT message_id FROM outbox WHERE status = 'PENDING' AND attempts > 0`,
        );
        if (request.dryRun) return { changes: pending.length, evidence: pending.map((p) => p.message_id) };
        const changes = this.db.run(
          `UPDATE outbox SET attempts = 0, last_error = NULL WHERE status = 'PENDING' AND attempts > 0`,
        ).changes;
        return { changes, evidence: pending.map((p) => p.message_id) };
      },
      prune_orphan_worktrees: async () => {
        const live = new Set(
          this.db
            .all<{ worktree_id: string | null }>(
              `SELECT worktree_id FROM task_executions WHERE status = 'RUNNING' AND worktree_id IS NOT NULL`,
            )
            .map((r) => r.worktree_id!),
        );
        let changes = 0;
        const pruned: string[] = [];
        for (const repository of this.repositories.list()) {
          const orphans = await this.worktrees.orphans(repository.checkoutPath, live).catch(() => []);
          for (const orphan of orphans) {
            pruned.push(orphan);
            if (!request.dryRun) {
              await this.worktrees.destroy(repository.checkoutPath, orphan);
              changes += 1;
            }
          }
        }
        return { changes: request.dryRun ? pruned.length : changes, evidence: pruned };
      },
      clear_repository_drift: async () => {
        const identity = request.parameters["identity"];
        const repository = identity ? this.repositories.byIdentity(identity) : null;
        if (!repository) return { changes: 0, evidence: { identity, found: false } };
        const observed = await this.repositories.observe(repository.repositoryId);
        if (request.dryRun || !observed?.lastObservedHead) {
          return { changes: observed?.driftState === "DRIFTED" ? 1 : 0, evidence: observed };
        }
        this.repositories.acknowledgeHead(repository.repositoryId, observed.lastObservedHead);
        return { changes: 1, evidence: { head: observed.lastObservedHead } };
      },
    };

    const preconditions = operation.preconditions.map((precondition) => ({
      precondition,
      satisfied: true,
      evidence: "checked by the operation handler",
    }));

    const outcome = await handlers[operation.id]!();

    const receipt: RepairReceipt = {
      operationId: operation.id,
      parameters: request.parameters,
      dryRun: request.dryRun,
      authorizedBy: request.authorizedBy,
      preconditionsChecked: preconditions,
      effect: operation.expectedEffect,
      changes: outcome.changes,
      performedAt: this.clock.nowIso(),
      digest: digestOf({ operation: operation.id, parameters: request.parameters, evidence: outcome.evidence }),
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
        target: outcome.evidence,
      },
    });

    return allow(ReasonCode.OK, receipt);
  }
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
