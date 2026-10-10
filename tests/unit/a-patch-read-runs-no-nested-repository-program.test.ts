/**
 * #1082 R1-01 (round 3) — a read of a candidate runs no program a nested repository's own
 * configuration names.
 *
 * The options ACP passes to git (`--no-textconv`, `--no-ext-diff`, emptied filter drivers, no
 * fsmonitor, no hooks) reach the repository git runs in. A populated nested repository is read by
 * a child git with that repository's own configuration, which none of them reach. A merge-gate
 * review showed the freeze patch read doing exactly that under `diff.submodule=diff`: the nested
 * repository's textconv and `diff.external` programs ran as the control-plane user, outside any
 * sandbox. The first two cases are that review's counterexamples, with their assertions; the
 * third sweeps the other reads on the snapshot, verification, freshness and doctor paths.
 *
 * Every program here is run through `sh` from a per-test script, and the two hooks come from the
 * stable fixture cache, so no case mints a new executable inode (see stable-fixture-executable.ts).
 * Each program appends one line per execution, so a case counts executions rather than reading a
 * marker that one execution and ten look the same through.
 */
import { existsSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { changedPaths, diffDigest, diffText, git, isClean } from "../../src/git/git.ts";
import { WorktreeAction, WriteOperation, type ManagedWriteGuard } from "../../src/guard/managed-write-guard.ts";
import { WorktreeManager, type WorktreeAuthorization } from "../../src/verify/worktree.ts";
import { cleanupTempDirs, commitAll, gitSync, makeRepo, tempDir, writeFiles } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";
import { stableFixtureBinDir } from "../helpers/stable-fixture-executable.ts";

afterEach(cleanupTempDirs);

/** Lines a counter file holds: one per program execution, 0 when nothing ran. */
const executions = (counter: string): number =>
  existsSync(counter) ? readFileSync(counter, "utf8").split("\n").filter(Boolean).length : 0;

/** A guard that grants every lifecycle effect, as a-verification-checkout-owns-its-git-metadata does. */
const grantAll = (manager: WorktreeManager, repositoryPath: string, worktreeId: string): WorktreeAuthorization => {
  const path = manager.pathFor(worktreeId);
  const guard = {
    authorize: async (_request: unknown, effect: (context: { grant: object }) => Promise<void> | void) =>
      allow(ReasonCode.WRITE_ALLOWED, await effect({ grant: {} })),
  } as unknown as ManagedWriteGuard;
  const request = {
    operation: WriteOperation.GIT_WORKTREE,
    repositoryIdentity: "test-repository",
    targetWorktreeId: path,
    runId: "test-run",
    sessionId: "test-session",
    bindingGeneration: 1,
  };
  return {
    add: { guard, request: { ...request, targetPath: path, worktreeAction: WorktreeAction.ADD } },
    remove: { guard, request: { ...request, targetPath: path, worktreeAction: WorktreeAction.REMOVE } },
    cleanup: { guard, request: { ...request, targetPath: path, worktreeAction: WorktreeAction.CLEANUP } },
    prune: { guard, request: { ...request, targetPath: repositoryPath, worktreeAction: WorktreeAction.PRUNE } },
  };
};

describe("#1082 R1-01: a candidate read runs no nested repository's program", () => {
  it("RF-S22 arm:validator #1082 R1-01: freeze diff must not run a nested repo textconv or clean filter", async () => {
    const repo = makeRepo(), nested = join(repo, "vendor/nested");
    gitSync(repo, ["init", "-q", nested]);
    writeFiles(nested, { "data.txt": "old\n", ".gitattributes": "data.txt diff=outside filter=outside\n" });
    commitAll(nested, "old");
    writeFiles(repo, { ".gitmodules": '[submodule "nested"]\n path = vendor/nested\n url = unused\n' });
    commitAll(repo, "old gitlink");
    const base = gitSync(repo, ["rev-parse", "HEAD"]);
    writeFiles(nested, { "data.txt": "new\n" });
    commitAll(nested, "new");
    commitAll(repo, "new gitlink");
    const head = gitSync(repo, ["rev-parse", "HEAD"]);
    const marker = tempDir("nested-diff-"), conv = join(marker, "textconv-ran"), filter = join(marker, "filter-ran");
    const counter = join(marker, "executions");
    const script = join(marker, "conv.sh");
    writeFileSync(script, `touch '${conv}'\necho textconv >> '${counter}'\ncat "$1"\n`);
    gitSync(nested, ["config", "diff.outside.textconv", `sh '${script}'`]);
    gitSync(nested, ["config", "filter.outside.clean", `touch '${filter}'; echo filter >> '${counter}'; cat`]);
    gitSync(repo, ["config", "diff.submodule", "diff"]);

    const digest = await diffDigest(repo, base, head), textconvRan = existsSync(conv);
    rmSync(conv, { force: true });
    const text = await diffText(repo, base, head), diffTextRan = existsSync(conv);

    expect(textconvRan, "nested textconv must not run during freeze").toBe(false);
    expect(diffTextRan).toBe(false);
    expect(existsSync(filter)).toBe(false);
    expect(executions(counter), "nested-configuration program executions").toBe(0);
    // What the patch says instead: the gitlink moved, as one line per side.
    expect(text).toContain(`-Subproject commit `);
    expect(text).not.toContain("data.txt");
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("RF-S22 arm:validator #1082 R1-01: nested diff external override and policy control", async () => {
    const repo = makeRepo(), nested = join(repo, "vendor/nested");
    gitSync(repo, ["init", "-q", nested]);
    writeFiles(nested, { "data.txt": "old\n" });
    commitAll(nested, "old");
    writeFiles(repo, { ".gitmodules": '[submodule "nested"]\n path = vendor/nested\n url = unused\n' });
    commitAll(repo, "old");
    const base = gitSync(repo, ["rev-parse", "HEAD"]);
    writeFiles(nested, { "data.txt": "new\n" });
    commitAll(nested, "new");
    commitAll(repo, "new");
    const head = gitSync(repo, ["rev-parse", "HEAD"]);
    const marker = tempDir("nested-external-"), ran = join(marker, "ran"), script = join(marker, "external.sh");
    const counter = join(marker, "executions");
    writeFileSync(script, `touch '${ran}'\necho external >> '${counter}'\ncat "$2"\n`);
    gitSync(nested, ["config", "diff.external", `sh '${script}'`]);
    gitSync(repo, ["config", "diff.submodule", "diff"]);

    await diffDigest(repo, base, head);
    const nestedRan = existsSync(ran);
    rmSync(ran, { force: true });
    // The policy control: the same read with the option spelled out by hand.
    const short = await git(repo, ["diff", "--no-ext-diff", "--no-textconv", "--submodule=short", base + ".." + head]);

    expect(nestedRan, "nested diff.external must not run").toBe(false);
    expect(existsSync(ran)).toBe(false);
    expect(short.stdout).toContain("Subproject commit");
    expect(executions(counter), "nested-configuration program executions").toBe(0);
  });

  it("RF-S22 arm:validator #1082 R1-01: every snapshot, verification, freshness and doctor read runs zero nested-configuration programs", async () => {
    const harness = makeHarness();
    const repo = harness.repoPath, nested = join(repo, "vendor/nested");
    const marker = tempDir("nested-sweep-"), counter = join(marker, "executions"), program = join(marker, "program.sh");
    // Records which program ran, then behaves as each kind expects enough for git to carry on.
    writeFileSync(program, `echo "$*" >> '${counter}'\n[ -f "$2" ] && cat "$2" || cat\n`);
    // Hooks must be executable files; these come from the stable cache, and write beside the
    // nested repository's own git directory, which is where git runs them.
    const hooks = stableFixtureBinDir({
      "post-index-change": "#!/bin/sh\necho post-index-change >> \"$(git rev-parse --absolute-git-dir)/acp-nested-hook-ran\"\n",
      "post-checkout": "#!/bin/sh\necho post-checkout >> \"$(git rev-parse --absolute-git-dir)/acp-nested-hook-ran\"\n",
    });

    gitSync(repo, ["init", "-q", nested]);
    writeFiles(nested, { "data.txt": "old\n", ".gitattributes": "data.txt diff=outside filter=outside\n" });
    commitAll(nested, "old");
    writeFiles(repo, { ".gitmodules": '[submodule "nested"]\n path = vendor/nested\n url = unused\n' });
    commitAll(repo, "old gitlink");
    const base = gitSync(repo, ["rev-parse", "HEAD"]);
    writeFiles(nested, { "data.txt": "new\n" });
    commitAll(nested, "new");
    commitAll(repo, "new gitlink");
    const head = gitSync(repo, ["rev-parse", "HEAD"]);
    const registered = await harness.cp.repositories.register({ checkoutPath: repo, identity: "local:nested-sweep" });
    if (!registered.allowed) throw new Error(registered.message);

    // The nested repository names a program for every route a child git could take into it ...
    for (const [key, value] of [
      ["diff.external", `sh '${program}' external`],
      ["diff.outside.textconv", `sh '${program}' textconv`],
      ["filter.outside.clean", `sh '${program}' clean`],
      ["filter.outside.smudge", `sh '${program}' smudge`],
      ["core.fsmonitor", `sh '${program}' fsmonitor`],
      ["core.hooksPath", hooks],
    ] as const) gitSync(nested, ["config", key, value]);
    // ... the outer repository asks git to take each of those routes ...
    gitSync(repo, ["config", "diff.submodule", "diff"]);
    gitSync(repo, ["config", "submodule.recurse", "true"]);
    gitSync(repo, ["config", "status.submoduleSummary", "true"]);
    // ... and the nested working tree is dirty with stale stat information, so a status inside it
    // would have to read content through its filter.
    writeFiles(nested, { "data.txt": "dirty\n" });
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(nested, "data.txt"), later, later);
    const hookCounter = join(nested, ".git", "acp-nested-hook-ran");
    rmSync(counter, { force: true });
    rmSync(hookCounter, { force: true });

    const reads: Record<string, unknown> = {};
    // Snapshot: the freeze's patch digest and path list.
    reads.diffDigest = await diffDigest(repo, base, head);
    reads.diffText = (await diffText(repo, base, head)).length;
    reads.changedPaths = await changedPaths(repo, base, head);
    // Freshness, registry inspection, repair and doctor all ask `isClean`.
    reads.isClean = await isClean(repo);
    reads.inspect = (await harness.cp.repositories.inspect(registered.value.repositoryId))?.driftState;
    reads.doctor = (await harness.cp.doctor.run("system")).findings
      .filter((finding) => finding.scope === "repository:local:nested-sweep")
      .map((finding) => finding.code);
    // Verification: both checkout kinds, prepared from the source and torn down again.
    const manager = new WorktreeManager(tempDir("nested-sweep-worktrees-"));
    for (const [id, selfContained] of [["linked", false], ["own", true]] as const) {
      const authorization = grantAll(manager, repo, id);
      const created = await manager.create(repo, head, id, authorization, { selfContained });
      reads[id] = existsSync(join(created.path, "vendor", "nested", "data.txt"));
      await manager.destroy(repo, created.path, authorization);
    }

    expect(executions(counter), `nested-configuration program executions: ${JSON.stringify(reads)}`).toBe(0);
    expect(executions(hookCounter), "nested hook executions").toBe(0);
    // The reads answered, rather than counting zero by failing first.
    expect(reads.changedPaths).toEqual(["vendor/nested"]);
    expect(reads.isClean).toBe(true);
    expect(reads.linked).toBe(false);
    expect(reads.own).toBe(false);
    // The control: the same nested configuration does run a program when git is let into it.
    gitSync(nested, ["status", "--porcelain"]);
    expect(executions(counter) + executions(hookCounter), "the fixture's programs are reachable").toBeGreaterThan(0);
  });
});
