import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";

/**
 * Result of asking whether a path lives inside a git work tree.
 *
 * `ERROR` is a distinct outcome from `OUTSIDE` on purpose. Collapsing them would let a
 * missing git binary, a permission error or a dubious-ownership rejection read as "not a
 * repository", and the guard would then allow an unmanaged write — exactly the silent
 * degradation CP-HI-08 forbids.
 */
export type WorktreeProbe =
  | { status: "INSIDE"; toplevel: string }
  | { status: "OUTSIDE" }
  | { status: "ERROR"; reason: string };

export interface WorkspaceProbe {
  probeWorktree(path: string): WorktreeProbe;
  /** Resolve symlinks as far as the path exists; the guard compares canonical paths. */
  canonical(path: string): string;
  /**
   * Branch currently checked out in the work tree, or null if it cannot be determined
   * (detached HEAD, unreadable repository). The guard needs this to compare a write
   * against another run's branch claim when the writing run declared no branch of its own.
   */
  currentBranch(toplevel: string): string | null;
}

export const realWorkspaceProbe: WorkspaceProbe = {
  probeWorktree(path: string): WorktreeProbe {
    let start: string;
    try {
      // A write target usually does not exist yet, and neither may its parents, so walk
      // up to the nearest ancestor that does before asking git.
      start = path;
      while (!existsSync(start)) {
        const parent = dirname(start);
        if (parent === start) return { status: "OUTSIDE" };
        start = parent;
      }
      // `git -C` needs a directory; asking about a file fails.
      if (!statSync(start).isDirectory()) start = dirname(start);
    } catch (err) {
      return { status: "ERROR", reason: `path inspection failed: ${(err as Error).message}` };
    }

    try {
      const out = execFileSync("git", ["-C", start, "rev-parse", "--show-toplevel"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: gitProbeEnv(),
      });
      return { status: "INSIDE", toplevel: realpathSync(out.trim()) };
    } catch (err) {
      const e = err as { status?: number; stderr?: string | Buffer; message?: string };
      const stderr = typeof e.stderr === "string" ? e.stderr : (e.stderr?.toString("utf8") ?? "");
      // Only git's own "not a repository" answer establishes non-membership. Anything
      // else — git absent, dubious ownership, EACCES — is an error and must fail closed.
      if (/not a git repository/i.test(stderr)) return { status: "OUTSIDE" };
      return {
        status: "ERROR",
        reason: `git rev-parse failed (exit ${e.status ?? "unknown"}): ${(stderr || e.message || "")
          .trim()
          .slice(0, 300)}`,
      };
    }
  },
  canonical,
  currentBranch(toplevel: string): string | null {
    try {
      const out = execFileSync("git", ["-C", toplevel, "rev-parse", "--abbrev-ref", "HEAD"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: gitProbeEnv(),
      }).trim();
      return out === "HEAD" || out.length === 0 ? null : out;
    } catch {
      return null;
    }
  },
};

const gitProbeEnv = (): NodeJS.ProcessEnv => ({
  PATH: process.env["PATH"] ?? "/usr/bin:/bin",
  HOME: process.env["HOME"] ?? "",
  LC_ALL: "C",
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_NOSYSTEM: "1",
});

/**
 * Canonicalises as much of the path as exists, then re-appends the missing tail.
 * A write target frequently does not exist yet, and a naive realpath would throw.
 */
export function canonical(path: string): string {
  const abs = isAbsolute(path) ? path : resolve(path);
  const missing: string[] = [];
  let cursor = abs;
  for (;;) {
    if (existsSync(cursor)) {
      const head = realpathSync(cursor);
      return missing.length > 0 ? resolve(head, ...missing.reverse()) : head;
    }
    const parent = dirname(cursor);
    if (parent === cursor) return abs;
    // basename, not an offset slice: at the filesystem root the parent already ends in
    // the separator, and slicing would drop the component's first character.
    missing.push(basename(cursor));
    cursor = parent;
  }
}

/** True when `child` is `parent` itself or lives beneath it. */
export const isWithin = (parent: string, child: string): boolean => {
  const p = parent.endsWith(sep) ? parent.slice(0, -1) : parent;
  return child === p || child.startsWith(p + sep);
};

/** In-memory probe for tests: the given roots are work trees, everything else is outside. */
export const fakeWorkspaceProbe = (
  worktrees: readonly string[],
  options: { errorFor?: readonly string[]; branches?: Readonly<Record<string, string>> } = {},
): WorkspaceProbe => {
  const roots = [...worktrees].map((w) => resolve(w)).sort((a, b) => b.length - a.length);
  const errors = (options.errorFor ?? []).map((p) => resolve(p));
  return {
    probeWorktree(path: string): WorktreeProbe {
      const abs = resolve(path);
      if (errors.some((e) => isWithin(e, abs))) {
        return { status: "ERROR", reason: "probe configured to fail for this path" };
      }
      const toplevel = roots.find((root) => isWithin(root, abs));
      return toplevel ? { status: "INSIDE", toplevel } : { status: "OUTSIDE" };
    },
    canonical: (path: string) => resolve(path),
    currentBranch: (toplevel: string) => options.branches?.[resolve(toplevel)] ?? null,
  };
};
