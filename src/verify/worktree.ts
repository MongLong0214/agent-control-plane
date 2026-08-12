import { existsSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { fail } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { addWorktree, listWorktrees, pruneWorktrees, removeWorktree } from "../git/git.ts";
import { canonical, isWithin } from "../guard/workspace-probe.ts";

export interface Worktree {
  worktreeId: string;
  path: string;
  repositoryPath: string;
  head: string;
}

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
    mkdirSync(root, { recursive: true });
    this.rootPath = canonical(root);
  }

  async create(repositoryPath: string, head: string, worktreeId: string): Promise<Worktree> {
    const path = this.managedPath(worktreeId);
    const known = await listWorktrees(repositoryPath);
    if (existsSync(path) || known.some((entry) => canonical(entry.path) === path)) {
      fail(ReasonCode.CONFLICT, "verification worktree id is already in use", {
        worktreeId,
        path,
        repositoryPath: canonical(repositoryPath),
      });
    }
    await addWorktree(repositoryPath, path, head);
    return { worktreeId, path, repositoryPath, head };
  }

  async destroy(repositoryPath: string, path: string): Promise<void> {
    const managedPath = this.managedPathFromPath(path);
    const before = await listWorktrees(repositoryPath);
    if (!before.some((entry) => canonical(entry.path) === managedPath)) {
      fail(ReasonCode.NOT_FOUND, "refusing to delete an unregistered worktree path", {
        path: managedPath,
        repositoryPath: canonical(repositoryPath),
      });
    }
    await removeWorktree(repositoryPath, path);
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
      rmSync(managedPath, { recursive: true, force: false });
    }
    await pruneWorktrees(repositoryPath);
  }

  async withWorktree<T>(
    repositoryPath: string,
    head: string,
    worktreeId: string,
    fn: (worktree: Worktree) => Promise<T>,
  ): Promise<T> {
    const worktree = await this.create(repositoryPath, head, worktreeId);
    try {
      return await fn(worktree);
    } finally {
      await this.destroy(repositoryPath, worktree.path);
    }
  }

  /**
   * Worktrees under the managed root that git still knows about. The doctor reports
   * these; it deliberately does not delete them (CP-S44 — detect, do not auto-remove).
   */
  async orphans(repositoryPath: string, liveIds: ReadonlySet<string>): Promise<string[]> {
    const known = await listWorktrees(repositoryPath);
    return known
      .map((w) => canonical(w.path))
      .filter((path) => isWithin(this.rootPath, path) && path !== this.rootPath)
      .filter((path) => !liveIds.has(path.slice(this.rootPath.length + 1)));
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
}
