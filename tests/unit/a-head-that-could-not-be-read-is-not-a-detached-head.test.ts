/**
 * #869. `assertWorktreeBinding` reads `symbolic-ref -q HEAD` to confirm a recorded candidate
 * worktree is detached. `-q` makes exit **1** git's answer "HEAD is not a symbolic ref", which is
 * what detached means here; every other nonzero is a fatal, and git uses 128 for all of them.
 * Reading those as "detached" let the assertion *pass having observed nothing* — it certified the
 * property it was asked to check.
 *
 * The repair was made and reviewed as correct, and a merge-gate review then measured that **no
 * test in the repository reached the function at all**: inverting the guard to refuse on every
 * exit code left 500 tests green, and a reachability marker on the region produced no output
 * across 190 files and 3366 tests. The cause is one line at the top — `if (input.worktreeId ==
 * null) return;` — and every existing snapshot case omits `worktreeId`, so all of them return
 * before the first probe.
 *
 * So this file's first job is reachability, proven in the two directions real git can produce,
 * and only then the fatal.
 */
import { chmodSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { ManualClock } from "../../src/core/clock.ts";
import { buildCandidateSnapshot } from "../../src/snapshot/candidate-snapshot.ts";
import { boundedExecFileSync } from "../helpers/bounded-sync-child.ts";
import { cleanupTempDirs, gitSync, makeRepo, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

const REAL_GIT = boundedExecFileSync("/usr/bin/env", ["sh", "-c", "command -v git"], {
  encoding: "utf8",
}).trim();

/** A repository plus one linked worktree whose git metadata id is the path's basename. */
const withLinkedWorktree = (): { repo: string; linked: string; worktreeId: string } => {
  const repo = makeRepo({ "a.txt": "1\n" });
  gitSync(repo, ["checkout", "-q", "-b", "task/T1"]);
  gitSync(repo, ["commit", "-q", "--allow-empty", "-m", "candidate"]);
  const linked = join(tempDir("acp-wt-"), "wt-alpha");
  gitSync(repo, ["worktree", "add", "--detach", "-q", linked, "HEAD"]);
  return { repo, linked, worktreeId: basename(linked) };
};

const snapshotOf = async (checkoutPath: string, worktreeId: string | null) =>
  buildCandidateSnapshot(
    {
      runId: "run_wt",
      contractDigest: "sha256:contract",
      repositories: [
        {
          identity: "github:acme/a",
          repositoryRole: "primary",
          checkoutPath,
          baseBranch: "dev",
          baseRef: "dev",
          worktreeId,
        },
      ],
    },
    new ManualClock("2026-09-13T00:00:00.000Z"),
  );

/**
 * A `git` on PATH that is the real git for every subcommand except `symbolic-ref`, which exits 128
 * with a fatal.
 *
 * A fake shell is weaker evidence than real git and is used for this one case only, because the
 * assertion's subject is a fatal *on that single call*: the ways to make real git fatal — a bad
 * `core.repositoryformatversion`, a foreign uid's `dubious ownership` — make every earlier probe
 * in the same function fatal too, and `rev-parse --git-common-dir` above it has no `allowFailure`,
 * so the run would never reach the line under test. The two cases above establish reachability
 * with real git; this one isolates which exit code the reached line accepts.
 */
const gitThatCannotReadHead = (): string => {
  const bin = tempDir("acp-fatal-git-");
  const script = [
    "#!/bin/sh",
    'for arg in "$@"; do',
    '  if [ "$arg" = "symbolic-ref" ]; then',
    "    echo \"fatal: not a git repository: '.'\" >&2",
    "    exit 128",
    "  fi",
    "done",
    `exec ${REAL_GIT} "$@"`,
  ].join("\n");
  writeFileSync(join(bin, "git"), `${script}\n`);
  chmodSync(join(bin, "git"), 0o755);
  return bin;
};

describe("a recorded candidate worktree's HEAD", () => {
  it("freezes a detached linked worktree — the control that proves the assertion is reached", async () => {
    const { linked, worktreeId } = withLinkedWorktree();

    const snapshot = await snapshotOf(linked, worktreeId);

    expect(snapshot.repositories).toHaveLength(1);
    expect(snapshot.repositories[0]?.identity).toBe("github:acme/a");
  });

  it("refuses a recorded worktree that is on a branch, which is the exit-0 answer", async () => {
    // The other direction real git can give, and the second half of reachability: if the function
    // were returning early this would freeze happily.
    const { linked, worktreeId } = withLinkedWorktree();
    gitSync(linked, ["checkout", "-q", "-b", "moved-off-detached"]);

    await expect(snapshotOf(linked, worktreeId)).rejects.toMatchObject({
      message: expect.stringContaining("recorded candidate worktree is not detached"),
    });
  });

  it("refuses a HEAD it could not read, rather than calling the fatal a detached head", async () => {
    const { linked, worktreeId } = withLinkedWorktree();
    const previousPath = process.env.PATH;
    // Assigning `undefined` to a `process.env` member stores the literal string "undefined", so
    // the restore is explicit in both directions.
    process.env.PATH = `${gitThatCannotReadHead()}:${previousPath ?? ""}`;
    try {
      await expect(snapshotOf(linked, worktreeId)).rejects.toMatchObject({
        message: expect.stringContaining("the candidate worktree's HEAD could not be read"),
      });
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });
});
