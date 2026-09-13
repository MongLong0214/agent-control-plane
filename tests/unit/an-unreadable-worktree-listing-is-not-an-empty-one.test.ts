/**
 * #869, GIT-1's third site, reproduced by a merge-gate review.
 *
 * `listWorktrees` answered `[]` when `git worktree list` exited nonzero. An empty list is not
 * "git knows of no worktrees" -- it is "nothing was read" -- and every caller decides something
 * about the filesystem from it. Four of the five read absence as a fact, and the worst certifies
 * its own subject: `destroy()` removes a managed worktree, lists again, and raises
 * `ISOLATION_LOST` if the path is still there. On a git that refused, the listing came back empty
 * and the check *passed having observed nothing*, certifying a removal it never saw.
 *
 * The shape here is the reviewer's, with real git rather than a fake shell on PATH: two worktrees
 * exist on disk, and git refuses to list them. Measured against
 * `core.repositoryformatversion = 99`, which makes every git command in that repository fatal
 * while leaving both trees in place -- the same kind of refusal as the
 * `fatal: detected dubious ownership` the review reproduced, which needs a second uid to stage.
 *
 * The control matters as much as the refusals. #869's first repair of a sibling defect
 * over-corrected into refusing a case that should succeed, and the control caught it on the first
 * run; a listing guard with no readable-repository case would certify a `listWorktrees` that
 * refuses everything.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { listWorktrees } from "../../src/git/git.ts";
import { canonical } from "../../src/guard/workspace-probe.ts";
import { WorktreeManager } from "../../src/verify/worktree.ts";

const made: string[] = [];
const temp = (prefix: string): string => {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  // Explicit, not inherited: this shell runs `umask 077` and GitHub's macOS runners run `umask
  // 022`, and `ensurePrivateDirectory` refuses a group- or world-readable root. A fixture that
  // relies on the umask passes here and fails there.
  chmodSync(directory, 0o700);
  made.push(directory);
  return directory;
};

const git = (cwd: string, args: readonly string[]): string =>
  execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  });

/** A repository with its main work tree plus one linked worktree, both present on disk. */
const twoWorktrees = (): { repo: string; linked: string } => {
  const repo = temp("acp-lw-repo-");
  git(repo, ["init", "--quiet", "--initial-branch", "main"]);
  git(repo, ["-c", "user.email=a@b", "-c", "user.name=a", "commit", "--allow-empty", "-qm", "seed"]);
  const linked = join(temp("acp-lw-linked-"), "tree");
  git(repo, ["worktree", "add", "--quiet", "--detach", linked]);
  return { repo, linked };
};

/** Every git command in this repository becomes fatal; the worktrees stay exactly where they are. */
const makeGitRefuse = (repo: string): void => {
  git(repo, ["config", "core.repositoryformatversion", "99"]);
};

afterAll(() => {
  for (const directory of made.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("an unreadable worktree listing", () => {
  it("refuses instead of reporting that the repository has no worktrees", async () => {
    const { repo } = twoWorktrees();

    // What is true, stated before the refusal so the test says what the old answer denied.
    const truthful = (await listWorktrees(repo)).length;
    expect(truthful).toBe(2);

    makeGitRefuse(repo);

    await expect(listWorktrees(repo)).rejects.toMatchObject({
      message: expect.stringContaining("which worktrees exist is unknown"),
    });
  });

  it("does not tell the doctor that a root full of orphans is clean", async () => {
    // `orphans()` is the reader the doctor prints. It needs no write authorization, which is why
    // it is the reader this file exercises end to end: the other four reach the same refusal
    // through the same call, but only after a guard fixture.
    const { repo } = twoWorktrees();
    const root = temp("acp-lw-root-");
    const manager = new WorktreeManager(root);
    const managed = join(root, "abandoned");
    mkdirSync(managed);
    git(repo, ["worktree", "add", "--quiet", "--detach", join(root, "listed")]);

    // `abandoned` is a bare directory git was never told about. `orphans()` reports what git
    // knows under the root, not what the filesystem holds, so it must not appear -- which is also
    // why an unreadable listing cannot be substituted with a directory walk.
    const before = await manager.orphans(repo, new Set());
    expect(before).toContain("listed");
    expect(before).not.toContain("abandoned");

    makeGitRefuse(repo);

    await expect(manager.orphans(repo, new Set())).rejects.toMatchObject({
      message: expect.stringContaining("which worktrees exist is unknown"),
    });
  });

  it("still reads a repository git answers for — the control", async () => {
    const { repo, linked } = twoWorktrees();

    const listed = await listWorktrees(repo);

    expect(listed).toHaveLength(2);
    // Through `canonical`, because that is what every reader in `verify/worktree.ts` compares
    // with: on macOS `mkdtemp` hands back `/var/folders/...` and git reports the resolved
    // `/private/var/folders/...`, so a raw string compare fails on a correct listing.
    expect(listed.map((entry) => canonical(entry.path))).toContain(canonical(linked));
    for (const entry of listed) expect(entry.head).toMatch(/^[0-9a-f]{40}$/u);
  });
});
