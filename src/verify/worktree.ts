import { existsSync, lstatSync, rmSync } from "node:fs";
import { join } from "node:path";

import { type Decision, deny, fail } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { ensurePrivateDirectory } from "../db/state-preflight.ts";
import {
  addWorktree,
  type GuardedGitEffect,
  git,
  listWorktrees,
  pruneWorktrees,
  removeWorktree,
  revParse,
  treeOf,
} from "../git/git.ts";
import { WorktreeAction, WriteOperation } from "../guard/managed-write-guard.ts";
import { canonical, isWithin } from "../guard/workspace-probe.ts";

export interface Worktree {
  worktreeId: string;
  path: string;
  repositoryPath: string;
  head: string;
}

/** One complete guard request per Git or local cleanup effect. */
export interface WorktreeAuthorization {
  readonly add?: GuardedGitEffect;
  readonly remove?: GuardedGitEffect;
  readonly prune?: GuardedGitEffect;
  readonly cleanup?: GuardedGitEffect;
}

const requireAllowed = <T>(decision: Decision<T>): T => {
  if (!decision.allowed) return fail(decision.reasonCode, decision.message, decision.evidence);
  return decision.value;
};

/**
 * Disposable worktrees for verification (PRD §17.4).
 *
 * A verification worktree is created at the exact candidate head and destroyed
 * afterwards, so a command can never observe or mutate the developer's checkout, and a
 * second run cannot share its working directory.
 */
export class WorktreeManager {
  private readonly rootPath: string;

  constructor(root: string) {
    // Verification executes candidate-controlled code below this root. A permissive or
    // symlinked root would let another local user plant/observe worktree contents before
    // Git's own isolation checks ever run.
    ensurePrivateDirectory(root);
    this.rootPath = canonical(root);
  }

  async create(
    repositoryPath: string,
    head: string,
    worktreeId: string,
    authorization: WorktreeAuthorization,
  ): Promise<Worktree> {
    const path = this.managedPath(worktreeId);
    const known = await listWorktrees(repositoryPath);
    if (existsSync(path) || known.some((entry) => canonical(entry.path) === path)) {
      fail(ReasonCode.CONFLICT, "verification worktree id is already in use", {
        worktreeId,
        path,
        repositoryPath: canonical(repositoryPath),
      });
    }

    // Resolve the ref before materialising it. A worktree created for `HEAD` must still
    // be tied to this exact commit even if the source checkout moves while Git is making
    // the disposable tree.
    const expectedHead = await revParse(repositoryPath, head);
    const expectedTree = await treeOf(repositoryPath, expectedHead);
    try {
      // `worktree add` performs a checkout, which normally invokes a repository-local
      // post-checkout hook as the control-plane user. Candidate-controlled hooks therefore
      // must be disabled before Git has a chance to materialise any verification input.
      requireAllowed(await addWorktree(repositoryPath, path, expectedHead, authorization.add));

      const [materializedHead, materializedTree, status] = await Promise.all([
        revParse(path, "HEAD"),
        treeOf(path, "HEAD"),
        // Include untracked files explicitly: a hook that adds a replacement executable
        // must not hide behind a repository's status.showUntrackedFiles preference.
        git(path, ["status", "--porcelain", "--untracked-files=all"]),
      ]);
      if (
        materializedHead !== expectedHead ||
        materializedTree !== expectedTree ||
        status.stdout.trim().length > 0
      ) {
        fail(ReasonCode.SNAPSHOT_STALE, "verification worktree differs from the frozen candidate", {
          repositoryPath: canonical(repositoryPath),
          worktreePath: path,
          expectedHead,
          materializedHead,
          expectedTree: `git-tree:${expectedTree}`,
          materializedTree: `git-tree:${materializedTree}`,
          status: status.stdout.trim(),
        });
      }
      return { worktreeId, path, repositoryPath, head: expectedHead };
    } catch (error) {
      // A failed post-add integrity check must not leave the potentially tampered tree
      // available for a later command. The path was just proven to be under our root.
      const after = await listWorktrees(repositoryPath);
      if (after.some((entry) => canonical(entry.path) === path)) {
        requireAllowed(await removeWorktree(repositoryPath, path, authorization.remove));
      }
      if (existsSync(path)) {
        requireAllowed(await this.cleanup(path, authorization.cleanup));
      }
      requireAllowed(await pruneWorktrees(repositoryPath, authorization.prune));
      throw error;
    }
  }

  async destroy(repositoryPath: string, path: string, authorization: WorktreeAuthorization): Promise<void> {
    const managedPath = this.managedPathFromPath(path);
    const before = await listWorktrees(repositoryPath);
    if (!before.some((entry) => canonical(entry.path) === managedPath)) {
      fail(ReasonCode.NOT_FOUND, "refusing to delete an unregistered worktree path", {
        path: managedPath,
        repositoryPath: canonical(repositoryPath),
      });
    }
    requireAllowed(await removeWorktree(repositoryPath, managedPath, authorization.remove));
    const remaining = await listWorktrees(repositoryPath);
    if (remaining.some((entry) => canonical(entry.path) === managedPath)) {
      fail(ReasonCode.ISOLATION_LOST, "git did not remove the managed worktree", {
        path: managedPath,
        repositoryPath: canonical(repositoryPath),
      });
    }
    if (existsSync(managedPath)) {
      const stat = lstatSync(managedPath);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        fail(ReasonCode.ISOLATION_LOST, "managed worktree path changed before cleanup", {
          path: managedPath,
        });
      }
      requireAllowed(await this.cleanup(managedPath, authorization.cleanup));
    }
    requireAllowed(await pruneWorktrees(repositoryPath, authorization.prune));
  }

  async withWorktree<T>(
    repositoryPath: string,
    head: string,
    worktreeId: string,
    authorization: WorktreeAuthorization,
    fn: (worktree: Worktree) => Promise<T>,
  ): Promise<T> {
    const worktree = await this.create(repositoryPath, head, worktreeId, authorization);
    try {
      return await fn(worktree);
    } finally {
      await this.destroy(repositoryPath, worktree.path, authorization);
    }
  }

  /** The exact path a caller must bind into its GIT_WORKTREE request. */
  pathFor(worktreeId: string): string {
    return this.managedPath(worktreeId);
  }

  /**
   * Worktrees under the managed root that git still knows about. The doctor reports
   * these; it deliberately does not delete them (CP-S44 — detect, do not auto-remove).
   */
  async orphans(
    repositoryPath: string,
    liveIds: ReadonlySet<string>,
    isLive?: (worktreeId: string) => boolean | Promise<boolean>,
  ): Promise<string[]> {
    const known = await listWorktrees(repositoryPath);
    const candidates = known
      .map((w) => canonical(w.path))
      .filter((path) => isWithin(this.rootPath, path) && path !== this.rootPath)
      .map((path) => path.slice(this.rootPath.length + 1))
      .filter((worktreeId) => !liveIds.has(worktreeId));
    if (!isLive) return candidates;
    const stillOrphaned: string[] = [];
    for (const worktreeId of candidates) {
      if (!(await isLive(worktreeId))) stillOrphaned.push(worktreeId);
    }
    return stillOrphaned;
  }

  private managedPath(worktreeId: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(worktreeId)) {
      fail(ReasonCode.INVALID_ARGUMENT, "worktree id must be a single safe path component", {
        worktreeId,
      });
    }
    return this.managedPathFromPath(join(this.rootPath, worktreeId));
  }

  private managedPathFromPath(path: string): string {
    const resolved = canonical(path);
    if (!isWithin(this.rootPath, resolved) || resolved === this.rootPath) {
      fail(ReasonCode.INVALID_ARGUMENT, "worktree path escapes the managed root", {
        root: this.rootPath,
        path: resolved,
      });
    }
    return resolved;
  }

  /** Guarded local cleanup is a first-class effect, including when Git removed its record. */
  async cleanup(path: string, authorization: GuardedGitEffect | undefined): Promise<Decision<void>> {
    if (!authorization) {
      return deny(ReasonCode.WRITE_REQUIRES_MANAGED_RUN, "local worktree cleanup requires guard authorization", { path });
    }
    if (authorization.request.operation !== WriteOperation.GIT_WORKTREE) {
      return deny(ReasonCode.INVALID_ARGUMENT, "local worktree cleanup requires a GIT_WORKTREE authorization", {
        operation: authorization.request.operation,
      });
    }
    if (authorization.request.worktreeAction !== WorktreeAction.CLEANUP) {
      return deny(ReasonCode.WRITE_TARGET_RESOURCE_MISMATCH, "local cleanup requires a CLEANUP lifecycle authorization", {
        action: authorization.request.worktreeAction ?? null,
      });
    }
    const managedPath = this.managedPathFromPath(path);
    if (!authorization.request.targetPath || canonical(authorization.request.targetPath) !== managedPath) {
      return deny(ReasonCode.WRITE_TARGET_RESOURCE_MISMATCH, "local cleanup target does not match the guard request", {
        path: managedPath,
        authorizedTarget: authorization.request.targetPath ?? null,
      });
    }
    return authorization.guard.authorize(authorization.request, () => {
      const stat = lstatSync(managedPath);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        fail(ReasonCode.ISOLATION_LOST, "managed worktree path changed before cleanup", { path: managedPath });
      }
      rmSync(managedPath, { recursive: true, force: false });
    });
  }
}
