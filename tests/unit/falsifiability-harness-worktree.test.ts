import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * The falsifiability harness has to survive being run from a linked worktree, because that is
 * where a branch gets reviewed.
 *
 * It did not. The sentinel path was built as `join(ROOT, gitPath)`, and in a linked worktree
 * `git rev-parse --git-path` answers with an **absolute** path — so the join concatenated it
 * underneath the worktree and every write died with ENOENT.
 *
 * The reason it shipped is the part worth writing down. The check that was performed ran
 * `git rev-parse --git-path` by hand, read a sensible-looking absolute path, and stopped. It
 * confirmed what the *command* returned and never looked at what the *code* did with it. So the
 * regression here is a real process, in a real worktree, going through the real script — not a
 * reimplementation of the path arithmetic, which would repeat the same mistake in a test.
 *
 * The worktree is checked out at `HEAD`, so this exercises the *committed* script rather than the
 * working copy. That is deliberate and matches the harness's own rule — it refuses to run at all
 * against uncommitted guarded files — but it does mean an in-progress edit to the script shows up
 * here as a failure until it is committed.
 *
 * `--only` is given a filter that matches no row on purpose. The sentinel is written before any
 * row runs, so an empty selection still exercises the path resolution and the write, and the run
 * finishes in a moment without spawning vitest. The bug is fatal at that write; a passing exit is
 * the whole assertion.
 */
const REPO_ROOT = join(import.meta.dirname, "..", "..");

const git = (args: readonly string[], cwd: string): string =>
  execFileSync("git", [...args], { cwd, encoding: "utf8" }).trim();

describe("the falsifiability harness runs from a linked worktree", () => {
  it("resolves its sentinel into the worktree's own git directory and completes", () => {
    const parent = tempDir("acp-wt-regression-");
    const worktree = join(parent, "checkout");
    const head = git(["rev-parse", "HEAD"], REPO_ROOT);
    git(["worktree", "add", "--detach", "--quiet", worktree, head], REPO_ROOT);

    try {
      // `.git` is a file here, not a directory. That is the whole hazard: any path built by
      // joining `.git` onto the worktree root lands under a regular file.
      expect(git(["rev-parse", "--is-inside-work-tree"], worktree)).toBe("true");
      const gitPath = git(["rev-parse", "--git-path", "verify-guards-in-flight.json"], worktree);
      expect(gitPath.startsWith(worktree)).toBe(false);

      const run = spawnSync(
        process.execPath,
        [join(worktree, "scripts", "verify-guards-are-falsifiable.mjs"), "--only=__matches_no_row__"],
        { cwd: worktree, encoding: "utf8" },
      );

      expect(`${run.stdout ?? ""}${run.stderr ?? ""}`).not.toContain("ENOENT");
      expect(run.status).toBe(0);
      // The harness clears the sentinel on its way out, so its absence afterwards is the
      // successful case. Its presence would mean the run died holding one.
      expect(existsSync(gitPath)).toBe(false);
    } finally {
      git(["worktree", "remove", "--force", worktree], REPO_ROOT);
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
