import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";

/**
 * Filesystem/git facts the Managed Write Guard needs. Injected so the guard can be
 * exercised against a synthetic workspace without shelling out.
 */
export interface WorkspaceProbe {
  /** Absolute path of the git work tree containing `path`, or null if there is none. */
  gitToplevel(path: string): string | null;
  /** Resolve symlinks as far as the path exists; the guard compares canonical paths. */
  canonical(path: string): string;
}

export const realWorkspaceProbe: WorkspaceProbe = {
  gitToplevel(path: string): string | null {
    // A write target usually does not exist yet, and neither may its parent
    // directories, so walk up to the nearest ancestor that does before asking git.
    let start = path;
    while (!existsSync(start)) {
      const parent = dirname(start);
      if (parent === start) return null;
      start = parent;
    }
    try {
      const out = execFileSync("git", ["-C", start, "rev-parse", "--show-toplevel"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      return realpathSync(out.trim());
    } catch {
      return null;
    }
  },
  canonical,
};

/**
 * Canonicalises as much of the path as exists, then re-appends the missing tail.
 * A write target frequently does not exist yet, and a naive realpath would throw.
 */
export function canonical(path: string): string {
  const abs = isAbsolute(path) ? path : resolve(path);
  const parts: string[] = [];
  let cursor = abs;
  for (;;) {
    if (existsSync(cursor)) {
      const head = realpathSync(cursor);
      return parts.length ? resolve(head, ...parts.reverse()) : head;
    }
    const parent = dirname(cursor);
    if (parent === cursor) return abs;
    parts.push(cursor.slice(parent.length + 1));
    cursor = parent;
  }
}

/** True when `child` is `parent` itself or lives beneath it. */
export const isWithin = (parent: string, child: string): boolean => {
  const p = parent.endsWith(sep) ? parent.slice(0, -1) : parent;
  return child === p || child.startsWith(p + sep);
};

/** In-memory probe for tests: a map of work-tree root -> nothing, plus identity canonicalisation. */
export const fakeWorkspaceProbe = (worktrees: readonly string[]): WorkspaceProbe => {
  const roots = [...worktrees].map((w) => resolve(w)).sort((a, b) => b.length - a.length);
  return {
    gitToplevel(path: string): string | null {
      const abs = resolve(path);
      return roots.find((root) => isWithin(root, abs)) ?? null;
    },
    canonical: (path: string) => resolve(path),
  };
};
