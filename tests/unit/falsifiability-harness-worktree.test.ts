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
 * The run below selects one real row and expects exit 1. That is not a weaker assertion than the
 * exit 0 it used to make, it is a sharper one. This test previously reached the sentinel by way of
 * an `--only=` filter that matched nothing, because a zero-row run wrote the sentinel and then
 * printed PASS. That PASS-over-nothing is now refused outright, and the refusal exits *above* the
 * sentinel — so keeping the old command and merely flipping the expected status would leave this
 * test asserting nothing at all about the path it is named for.
 *
 * So the row is real and the worktree has no `node_modules`: the harness snapshots, writes the
 * sentinel, mutates, and then refuses at the compiler it cannot reach. Reaching that refusal is
 * the proof the write returned, because it lives far below the write. Measured against the
 * original defect reintroduced by hand: the process dies at the write with `ENOENT` and never
 * prints `could not run`, so both assertions below fail on it.
 */
const REPO_ROOT = join(import.meta.dirname, "..", "..");

const git = (args: readonly string[], cwd: string): string =>
  execFileSync("git", [...args], { cwd, encoding: "utf8" }).trim();

describe("the falsifiability harness runs from a linked worktree", () => {
  it("keeps anchors-only read-only even when the temp root cannot contain a directory", () => {
    const run = spawnSync(
      process.execPath,
      [join(REPO_ROOT, "scripts", "verify-guards-are-falsifiable.mjs"), "--anchors-only"],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: { ...process.env, TMPDIR: "/dev/null" },
      },
    );

    const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
    expect(output).not.toContain("ENOTDIR");
    expect(run.status).toBe(0);
    expect(output).toContain("RESULT: PASS");
  });

  it("resolves its sentinel into the worktree's own git directory, writes it, and clears it", () => {
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
        [
          join(worktree, "scripts", "verify-guards-are-falsifiable.mjs"),
          "--only=an attempt numbered below one",
        ],
        { cwd: worktree, encoding: "utf8" },
      );

      const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
      expect(output).not.toContain("ENOENT");
      expect(output).not.toContain("ENOTDIR");
      // The write is the subject, and this is how its success is observed: the compiler refusal
      // sits hundreds of lines below the sentinel write, so the run cannot print this without
      // having got past it. With the path bug it prints a stack trace instead.
      expect(output).toContain("could not run");
      expect(run.status).toBe(1);
      // The harness clears the sentinel on its way out, so its absence afterwards is the
      // successful case. Its presence would mean the run died holding one.
      expect(existsSync(gitPath)).toBe(false);
    } finally {
      git(["worktree", "remove", "--force", worktree], REPO_ROOT);
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("refuses to call a row killed when the test run never happened", () => {
    // A linked worktree has no `node_modules`, so neither tsc nor vitest is reachable. The
    // compiler check now refuses first; the verdict process tests also exercise missing Vitest.
    // Before the compiler check existed, the vitest spawn failed with ENOENT. `spawnSync`
    // reports that as `status: null` with the failure in `error` — and reading only
    // `status !== 0` counted it as a kill. Measured on the commit before the fix: with vitest
    // unable to start, the harness printed `killed`, printed its success banner, and exited 0.
    //
    // This file's whole subject is that a run which did not happen cannot kill a guard, which is
    // the same rule the acceptance realm states about `stat` and `realpath`. The harness was
    // breaking it in its own verdict.
    const parent = tempDir("acp-wt-nokill-");
    const worktree = join(parent, "checkout");
    const head = git(["rev-parse", "HEAD"], REPO_ROOT);
    git(["worktree", "add", "--detach", "--quiet", worktree, head], REPO_ROOT);

    try {
      expect(existsSync(join(worktree, "node_modules"))).toBe(false);

      const run = spawnSync(
        process.execPath,
        [
          join(worktree, "scripts", "verify-guards-are-falsifiable.mjs"),
          "--only=an attempt numbered below one",
        ],
        { cwd: worktree, encoding: "utf8" },
      );

      const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
      expect(run.status).toBe(1);
      expect(output).toContain("could not run");
      expect(output).not.toContain("killed");
      expect(output).not.toContain("guard(s) removed on purpose");
    } finally {
      git(["worktree", "remove", "--force", worktree], REPO_ROOT);
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
