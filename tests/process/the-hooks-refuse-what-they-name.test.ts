import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * The hooks are a local install, and CI is a clone that never ran it. This covers their logic
 * anyway, because the alternative is a guard whose only proof lives on one machine.
 *
 * Each case below is a mistake that was made more than once inside 48 hours, and each was already
 * *detected* by something at the time — a CommitLore warning that exited 0, a harness sentinel
 * nothing consulted, a mutation row that CI reported forty minutes in. Detection was never the
 * missing part. Refusal was.
 */
const ROOT = process.cwd();
const hook = (name: string): string => join(ROOT, ".githooks", name);

const runCommitMsg = (message: string): number => {
  const dir = tempDir("acp-hook-msg-");
  const file = join(dir, "COMMIT_EDITMSG");
  writeFileSync(file, message);
  return spawnSync(hook("commit-msg"), [file], { cwd: ROOT, encoding: "utf8" }).status ?? -1;
};

describe("commit-msg refuses a trailer git will not parse", () => {
  it("refuses a Limit that wraps onto a second line", () => {
    // The exact shape that reached six commits on 2026-08-22. `git interpret-trailers` reads the
    // last paragraph one trailer per line, so the continuation ends the block and every record in
    // it — including this one — is stored by nobody.
    expect(runCommitMsg("subject\n\nbody\n\nLimit: this wraps across\ntwo lines.\n")).toBe(1);
  });

  it("refuses an ordinary sentence that follows a trailer", () => {
    expect(runCommitMsg("subject\n\nLimit: fine\nRuled-out: a | b\nnot a trailer at all\n")).toBe(1);
  });

  it("accepts a long trailer on one line, because length was never the problem", () => {
    const long = `Limit: ${"a sentence that keeps going ".repeat(12)}and ends.`;
    expect(runCommitMsg(`subject\n\nbody\n\n${long}\n`)).toBe(0);
  });

  it("accepts a message with no trailers at all", () => {
    expect(runCommitMsg("subject\n\njust a body, nothing to record\n")).toBe(0);
  });

  it("accepts trailers separated from the body by a blank line, which is the normal case", () => {
    expect(
      runCommitMsg("subject\n\nbody\n\nLimit: one line\nRuled-out: alternative | why not\n"),
    ).toBe(0);
  });
});

describe("pre-commit refuses while the falsifiability harness holds a mutation", () => {
  it("refuses when the sentinel exists", () => {
    // The sentinel is present for exactly the window where committing takes a mutation with it:
    // during a live sweep and after a killed one. Asking "is the tree dirty" answers no in both —
    // the harness restores what it is not currently holding, and a killed run leaves a clean
    // index. That is how a removed guard reached a commit twice.
    const fake = join(tempDir("acp-hook-sentinel-"), "repo");
    mkdirSync(fake, { recursive: true });
    chmodSync(fake, 0o700);
    expect(spawnSync("git", ["init", "-q"], { cwd: fake }).status).toBe(0);

    const gitDir = spawnSync("git", ["rev-parse", "--git-dir"], { cwd: fake, encoding: "utf8" })
      .stdout.trim();
    const sentinel = join(fake, gitDir, "verify-guards-in-flight.json");
    writeFileSync(sentinel, "{}");
    try {
      const refused = spawnSync(hook("pre-commit"), [], { cwd: fake, encoding: "utf8" });
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain("mutation applied");
    } finally {
      rmSync(sentinel, { force: true });
    }
  });

  it("says nothing when there is no sentinel and nothing staged that rows anchor into", () => {
    const fake = join(tempDir("acp-hook-clean-"), "repo");
    mkdirSync(fake, { recursive: true });
    chmodSync(fake, 0o700);
    expect(spawnSync("git", ["init", "-q"], { cwd: fake }).status).toBe(0);

    // No `src/` in the staged set, so the anchors pass is skipped: a commit that touches nothing
    // the rows name should not pay for the check, and a hook that always runs gets bypassed.
    expect(spawnSync(hook("pre-commit"), [], { cwd: fake, encoding: "utf8" }).status).toBe(0);
  });
});
