import { lstatSync, type Stats } from "node:fs";
import { dirname, join } from "node:path";

import type { Clock } from "../core/clock.ts";
import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { residentWorkerCheckoutPath } from "../core/resident-allocation-paths.ts";
import type { AuditLog } from "../db/audit.ts";
import type { Db } from "../db/database.ts";
import { ensurePrivateDirectory } from "../db/state-preflight.ts";
import { git, listWorktrees, withoutRepositoryPrograms } from "../git/git.ts";
import {
  type ManagedWriteGuard,
  type RepairWorktreeAuthority,
  WorktreeAction,
  WriteOperation,
} from "../guard/managed-write-guard.ts";
import { canonical } from "../guard/workspace-probe.ts";
import { branchCreations } from "../run/task-write-target.ts";

/**
 * #1227 — a resident CTO runs in its project's clone, and every worker turn ran in that same checkout:
 * whatever the resident's tooling wrote there (Claude Code's `.claude/scheduled_tasks.lock`, notes, an
 * edit in progress) was in front of the worker scan, and could reach a candidate. A resident project's
 * worker turns therefore get their own checkout: a linked worktree of the clone, at
 * `residentWorkerCheckoutPath`, made by the control plane and registered in the clone's place, so every
 * machine that reads the registered checkout — claims, the write target, the worker turn, freeze,
 * candidate verification — uses it unchanged. The clone stays the resident's.
 */
export const REPOSITORY_CHECKOUT_MOVED = "REPOSITORY_CHECKOUT_MOVED";
/** A move that could not happen on this pass; recorded once per distinct refusal, tried again on the next. */
export const REPOSITORY_CHECKOUT_MOVE_REFUSED = "REPOSITORY_CHECKOUT_MOVE_REFUSED";

/** A registered repository whose project has a live resident, and where that resident works. */
export interface ResidentRepository {
  repositoryId: string;
  identity: string;
  projectId: string;
  /** The registered checkout, as the registry holds it. */
  checkoutPath: string;
  /** The resident's clone, its working directory: the provisioning allocation's `clonePath`. */
  clonePath: string;
  /** `residentWorkerCheckoutPath` of that clone and this repository. */
  workerCheckoutPath: string;
}

interface ResidentRow {
  repository_id: string;
  identity: string;
  project_id: string;
  checkout_path: string;
  clone_path: string;
}

/**
 * Every active repository of a project whose resident provisioning is live (PENDING or COMPLETE), for
 * the repository the allocation was made for. Optionally just one repository.
 */
export const residentRepositories = (db: Db, repositoryId?: string): ResidentRepository[] =>
  db
    .all<ResidentRow>(
      `SELECT r.repository_id, r.identity, r.project_id, r.checkout_path,
              json_extract(p.allocation_json, '$.clonePath') AS clone_path
         FROM resident_project_provisioning p
         JOIN repositories r ON r.project_id = p.project_id AND r.retired_at IS NULL
                            AND r.identity = json_extract(p.allocation_json, '$.repositoryIdentity')
        WHERE p.status IN ('PENDING', 'COMPLETE')
          AND json_type(p.allocation_json, '$.clonePath') = 'text'
          AND (? IS NULL OR r.repository_id = ?)
        ORDER BY r.repository_id`,
      [repositoryId ?? null, repositoryId ?? null],
    )
    .map((row) => {
      const clonePath = canonical(row.clone_path);
      return {
        repositoryId: row.repository_id,
        identity: row.identity,
        projectId: row.project_id,
        checkoutPath: row.checkout_path,
        clonePath,
        workerCheckoutPath: residentWorkerCheckoutPath(clonePath, row.repository_id),
      };
    });

/** The resident a repository belongs to, or null when its project has no live resident. */
export const residentRepository = (db: Db, repositoryId: string): ResidentRepository | null =>
  residentRepositories(db, repositoryId)[0] ?? null;

/**
 * Every clone a resident allocation names, whatever its state: the resident's own tree, which no
 * candidate command may read. Once its repository is registered at the worker checkout, no registry
 * row names the clone any more, so a deny list built from the registry alone would leave it open.
 */
export const residentClonePaths = (db: Db): string[] =>
  [...new Set(
    db
      .all<{ clone_path: string }>(
        `SELECT json_extract(allocation_json, '$.clonePath') AS clone_path FROM resident_project_provisioning
          WHERE json_type(allocation_json, '$.clonePath') = 'text' ORDER BY run_id`,
      )
      .map((row) => canonical(row.clone_path)),
  )];

const lstatOrNull = (path: string): Stats | null => {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
};

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Moves each live resident's repository from the resident's clone to its dedicated worker checkout.
 *
 * Run by the daemon at start and on every watchdog pass (`Daemon.resumeResidentProjects`), so a new
 * project is moved on the pass after its activation and an existing one on the first start of a build
 * that has this. Idempotent: a repository already at its worker checkout, or registered anywhere but
 * its resident's clone, is left alone. Until it is moved, worker turns refuse to run in the clone
 * (`WorkerTurnRunner`), so no turn is ever in flight there while it moves.
 *
 * One move, under one Managed Write Guard grant (GIT_WORKTREE ADD, outside any run, by the composition
 * root's repair authority, for the registered checkout it reads):
 * 1. the worker checkout is added detached at the clone's HEAD commit, with no hook, fsmonitor or
 *    filter program run, and must stand clean; a path there that is not this clone's worktree is
 *    refused and left as it is;
 * 2. a clone standing on a branch the control plane made for one of the repository's tasks (S-TB)
 *    hands that branch over: the clone's HEAD is detached at the same commit — no file, index or ref
 *    of the clone moves — and the worker checkout takes the branch, so a branch is never checked out
 *    twice and the task re-enters it as before;
 * 3. in one transaction the registry names the worker checkout, the repository's HELD worktree claims
 *    follow it, and `REPOSITORY_CHECKOUT_MOVED` records from where to where.
 * Task branches, the base branch and every other ref are shared by the two trees and never written.
 */
export class WorkerCheckouts {
  readonly #lastRefusal = new Map<string, string>();

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly audit: AuditLog,
    private readonly guard: ManagedWriteGuard,
    private readonly authority: RepairWorktreeAuthority,
  ) {}

  /** Every resident repository still registered at its clone, moved. Never throws. */
  async ensureAll(): Promise<Array<{ repositoryId: string; outcome: Decision<string> }>> {
    const outcomes: Array<{ repositoryId: string; outcome: Decision<string> }> = [];
    for (const resident of residentRepositories(this.db)) {
      if (canonical(resident.checkoutPath) !== resident.clonePath) continue;
      let outcome: Decision<string>;
      try {
        outcome = await this.move(resident);
      } catch (error) {
        outcome = deny(ReasonCode.INTERNAL_ERROR, "the worker checkout could not be made", {
          identity: resident.identity,
          error: errorText(error).slice(0, 300),
        });
      }
      if (outcome.allowed) this.#lastRefusal.delete(resident.repositoryId);
      else this.recordRefusal(resident, outcome);
      outcomes.push({ repositoryId: resident.repositoryId, outcome });
    }
    return outcomes;
  }

  private async move(resident: ResidentRepository): Promise<Decision<string>> {
    const { clonePath: clone, workerCheckoutPath: worker } = resident;
    const running = this.db.get<{ execution_id: string }>(
      `SELECT e.execution_id FROM task_executions e
         JOIN tasks t ON t.task_id = e.task_id
         JOIN run_repositories rr ON rr.run_id = t.run_id
        WHERE rr.repository_id = ?
          AND (e.status = 'RUNNING' OR (e.worker_process_id IS NOT NULL AND e.worker_process_released_at IS NULL))
        ORDER BY e.execution_id LIMIT 1`,
      [resident.repositoryId],
    );
    if (running) {
      return deny(ReasonCode.CONFLICT, "a worker turn has not ended in the resident's checkout; the move waits for it", {
        identity: resident.identity,
        executionId: running.execution_id,
      });
    }
    if (lstatOrNull(worker) !== null) {
      const known = (await listWorktrees(clone)).some((entry) => canonical(entry.path) === worker);
      if (!known || lstatOrNull(join(worker, ".git"))?.isFile() !== true) {
        return deny(ReasonCode.CONFLICT, "the worker checkout's path holds something the control plane did not make there; it is left as it is", {
          identity: resident.identity,
          worktreePath: worker,
        });
      }
    } else {
      ensurePrivateDirectory(dirname(worker));
    }

    const made: { outcome: Decision<{ head: string; branch: string | null }> } = {
      outcome: deny(ReasonCode.INTERNAL_ERROR, "the worker checkout effect did not run", { identity: resident.identity }),
    };
    const authorised = await this.guard.authorize(
      {
        operation: WriteOperation.GIT_WORKTREE,
        worktreeAction: WorktreeAction.ADD,
        targetPath: worker,
        targetWorktreeId: clone,
        repositoryIdentity: resident.identity,
        repairWorktreeAuthority: this.authority,
        actor: "worker-checkout",
      },
      async () => {
        made.outcome = await this.materialize(resident);
      },
    );
    if (!authorised.allowed) return authorised as Decision<never>;
    if (!made.outcome.allowed) return made.outcome as Decision<never>;
    const { head, branch } = made.outcome.value;

    return this.db.txDecision((): Decision<string> => {
      const moved = this.db.run(
        `UPDATE repositories SET checkout_path = ? WHERE repository_id = ? AND checkout_path = ? AND retired_at IS NULL`,
        [worker, resident.repositoryId, resident.checkoutPath],
      );
      if (moved.changes !== 1) {
        return deny(ReasonCode.CONFLICT, "the repository's registration changed while its worker checkout was made; nothing was moved", {
          identity: resident.identity,
        });
      }
      const claims = this.db.run(
        `UPDATE resource_claims SET worktree_id = ? WHERE repository_identity = ? AND worktree_id = ? AND status = 'HELD'`,
        [worker, resident.identity, resident.checkoutPath],
      );
      const recorded = this.audit.record({
        kind: REPOSITORY_CHECKOUT_MOVED,
        projectId: resident.projectId,
        evidence: {
          identity: resident.identity,
          repositoryId: resident.repositoryId,
          from: clone,
          to: worker,
          head,
          branch,
          claimsMoved: claims.changes,
          at: this.clock.nowIso(),
        },
      });
      if (!recorded.allowed) return recorded as Decision<never>;
      return allow(ReasonCode.OK, worker);
    });
  }

  /** The guarded effect: the worker checkout made or found, clean, and a task branch the clone stood on handed to it. */
  private async materialize(resident: ResidentRepository): Promise<Decision<{ head: string; branch: string | null }>> {
    const { clonePath: clone, workerCheckoutPath: worker } = resident;
    const programs = await withoutRepositoryPrograms(clone);
    const head = (await git(clone, [...programs, "rev-parse", "--verify", "HEAD^{commit}"])).stdout.trim();
    if (lstatOrNull(worker) === null) {
      // Detached: the clone keeps whatever branch it is on, and no branch is ever checked out twice.
      await git(clone, [...programs, "worktree", "add", "--detach", worker, head]);
    }
    const own = await withoutRepositoryPrograms(worker);
    const status = await git(worker, [...own, "status", "--porcelain", "--untracked-files=all", "--ignore-submodules=dirty"]);
    const dirty = status.stdout.split("\n").filter((line) => line.length > 0);
    if (dirty.length > 0) {
      return deny(ReasonCode.CONFLICT, "the worker checkout is not clean; it is not registered", {
        identity: resident.identity,
        worktreePath: worker,
        paths: dirty.slice(0, 20),
      });
    }
    const symbolic = await git(clone, [...programs, "symbolic-ref", "-q", "HEAD"], { allowFailure: true });
    if (symbolic.exitCode !== 0 && symbolic.exitCode !== 1) {
      return deny(ReasonCode.PROBE_FAILED, "the resident checkout's HEAD could not be read", { identity: resident.identity });
    }
    const ref = symbolic.exitCode === 0 ? symbolic.stdout.trim() : null;
    const branch = ref?.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : null;
    if (ref === null || branch === null || branchCreations(this.db, resident.identity, branch).length === 0) {
      return allow(ReasonCode.OK, { head, branch: null });
    }
    // The clone stands on a task branch the control plane made: the branch is the worker's.
    const tip = (await git(clone, [...programs, "rev-parse", "--verify", `${ref}^{commit}`])).stdout.trim();
    await git(clone, [...programs, "update-ref", "--no-deref", "-m", "agent-control-plane: the worker checkout takes the task branch", "HEAD", tip, tip]);
    const workerHead = (await git(worker, [...own, "rev-parse", "--verify", "HEAD^{commit}"])).stdout.trim();
    const workerRef = await git(worker, [...own, "symbolic-ref", "-q", "HEAD"], { allowFailure: true });
    if (workerRef.exitCode === 1 && workerHead === tip) {
      await git(worker, [...own, "symbolic-ref", "-m", "agent-control-plane: the worker checkout takes the task branch", "HEAD", ref]);
    }
    return allow(ReasonCode.OK, { head: tip, branch });
  }

  private recordRefusal(resident: ResidentRepository, refusal: Decision<string>): void {
    if (refusal.allowed) return;
    const key = `${refusal.reasonCode}:${refusal.message}`;
    if (this.#lastRefusal.get(resident.repositoryId) === key) return;
    this.#lastRefusal.set(resident.repositoryId, key);
    try {
      this.audit.record({
        kind: REPOSITORY_CHECKOUT_MOVE_REFUSED,
        projectId: resident.projectId,
        reasonCode: refusal.reasonCode,
        evidence: { identity: resident.identity, repositoryId: resident.repositoryId, reason: refusal.message, deferred: true },
      });
    } catch {
      /* a report: the next pass tries the move again either way */
    }
  }
}
