import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { addWorktree, listWorktrees, pruneWorktrees, removeWorktree } from "../git/git.ts";
import { canonical } from "../guard/workspace-probe.ts";

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
  constructor(private readonly root: string) {
    mkdirSync(root, { recursive: true });
  }

  async create(repositoryPath: string, head: string, worktreeId: string): Promise<Worktree> {
    const path = canonical(join(this.root, worktreeId));
    if (existsSync(path)) await this.destroy(repositoryPath, path);
    await addWorktree(repositoryPath, path, head);
    return { worktreeId, path, repositoryPath, head };
  }

  async destroy(repositoryPath: string, path: string): Promise<void> {
    await removeWorktree(repositoryPath, path);
    rmSync(path, { recursive: true, force: true });
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
      .filter((path) => path.startsWith(canonical(this.root)))
      .filter((path) => !liveIds.has(path.slice(canonical(this.root).length + 1)));
  }
}
