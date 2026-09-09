import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

/**
 * The hook under an environment git actually hands it, rather than the one this suite happens to
 * run in. Git does not give a hook a login shell's PATH, so a commit made from a GUI client, a
 * launchd job, or an editor reaches this hook with a PATH that has no `node` on it — which is what
 * CommitLore's own `doctor` reports on this machine today.
 *
 * `env` is replaced rather than extended: `NODE` and `npm_node_execpath` are the fallbacks the hook
 * consults after PATH, so leaving this process's copies in place would let a run that resolved
 * nothing look identical to one that resolved everything.
 */
const runCommitMsgWithEnv = (
  message: string,
  env: NodeJS.ProcessEnv,
): { status: number; stderr: string } => {
  const dir = tempDir("acp-hook-env-");
  const file = join(dir, "COMMIT_EDITMSG");
  writeFileSync(file, message);
  const done = spawnSync(hook("commit-msg"), [file], { cwd: ROOT, encoding: "utf8", env });
  return { status: done.status ?? -1, stderr: done.stderr ?? "" };
};

/** A PATH carrying only what the hook shells out to. `git` is the one external command it runs. */
const pathWithoutNode = (): string => {
  const bin = join(tempDir("acp-hook-bin-"), "bin");
  mkdirSync(bin, { recursive: true });
  const git = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  expect(git, "no git to build a PATH from").not.toBe("");
  symlinkSync(git, join(bin, "git"));
  expect(
    spawnSync("sh", ["-c", "command -v node"], { encoding: "utf8", env: { PATH: bin } }).status,
    "this PATH still resolves node, so nothing below measures what it claims",
  ).not.toBe(0);
  return bin;
};

/** The real interpreter, named the way `pnpm run` names it in a hook's environment. */
const realNode = process.execPath;

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

describe("commit-msg tells a refusal apart from a check it could not run", () => {
  const WELL_FORMED = "subject\n\nbody\n\nLimit: one line\n";
  const WRAPPED = "subject\n\nbody\n\nLimit: this wraps across\ntwo lines.\n";
  /** The hook's own sentence about the message. It must not be said about the interpreter. */
  const TRAILER_REFUSAL = "writes a record git will not store";

  it("does not report a trailer problem when it could not find an interpreter", () => {
    // The defect: `node` was invoked by bare name, so a PATH without it made the check exit 127,
    // which `if !` reads as "the check refused". The hook then blamed a well-formed message for a
    // fault in the environment — the opposite failure, wearing the same words and the same exit.
    const done = runCommitMsgWithEnv(WELL_FORMED, { PATH: pathWithoutNode(), HOME: process.env.HOME });
    expect(done.stderr).not.toContain(TRAILER_REFUSAL);
  });

  it("says the check could not run, and names what it looked for", () => {
    const done = runCommitMsgWithEnv(WELL_FORMED, { PATH: pathWithoutNode(), HOME: process.env.HOME });
    expect(done.stderr).toContain("could not run");
    expect(done.stderr).toContain("PATH");
    expect(done.stderr).toContain("NODE");
    expect(done.stderr).toContain("npm_node_execpath");
  });

  it("refuses the commit when it cannot run the check, which is the choice the hook argues", () => {
    // Asserted directly rather than left implied by the message above. The alternative — exit 0 —
    // would let every commit on a machine with no `node` on git's PATH be stored unchecked, with
    // nothing saying so. See the comment in `.githooks/commit-msg` for the argument.
    const done = runCommitMsgWithEnv(WELL_FORMED, { PATH: pathWithoutNode(), HOME: process.env.HOME });
    expect(done.status).toBe(1);
  });

  it("runs the check on the interpreter NODE names when PATH has none", () => {
    // `pnpm run` sets `NODE` and `npm_node_execpath` to the absolute path of the interpreter it is
    // already on, and `scripts/merge-pr.mjs` spawns git from inside such a run. This proves the
    // fallback resolves and *runs the check*, rather than merely not crashing: a malformed message
    // still earns the trailer refusal, on the interpreter the caller was already using.
    const env = { PATH: pathWithoutNode(), HOME: process.env.HOME, NODE: realNode };
    const refused = runCommitMsgWithEnv(WRAPPED, env);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain(TRAILER_REFUSAL);
    expect(refused.stderr).not.toContain("could not run");

    const accepted = runCommitMsgWithEnv(WELL_FORMED, env);
    expect(accepted.status).toBe(0);
  });

  it("accepts npm_node_execpath as the same answer under its other name", () => {
    const env = { PATH: pathWithoutNode(), HOME: process.env.HOME, npm_node_execpath: realNode };
    expect(runCommitMsgWithEnv(WELL_FORMED, env).status).toBe(0);
    expect(runCommitMsgWithEnv(WRAPPED, env).stderr).toContain(TRAILER_REFUSAL);
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

  it("runs the anchors pass whatever is staged, because the filter had a hole shaped like the defect", () => {
    // The first version ran it only when `src/` or the harness was staged. That excluded deleting
    // a test file a row names in `killedBy` — the case the newest half of that check exists for.
    // A filter written to save a second had a hole shaped exactly like the defect.
    //
    // Proven in a repository of its own, with a stub standing in for the harness: running against
    // this one would answer differently depending on whether a real sweep happens to be in
    // progress, and a test whose result depends on that is not measuring the hook.
    const fake = join(tempDir("acp-hook-unfiltered-"), "repo");
    mkdirSync(join(fake, "scripts"), { recursive: true });
    chmodSync(fake, 0o700);
    expect(spawnSync("git", ["init", "-q"], { cwd: fake }).status).toBe(0);

    const marker = join(fake, "ran");
    writeFileSync(
      join(fake, "scripts", "verify-guards-are-falsifiable.mjs"),
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "yes");\n`,
    );
    // This case isolates the later anchors call. The real preflight and both of its counterexamples
    // run through scripts/verify-ci-preflight.mjs in ci-preflight.test.ts.
    writeFileSync(
      join(fake, "package.json"),
      JSON.stringify({ scripts: { "ci:preflight": "true" } }),
    );

    // Nothing staged at all — the case the old filter skipped.
    const done = spawnSync(hook("pre-commit"), [], { cwd: fake, encoding: "utf8" });
    expect(done.status).toBe(0);
    expect(existsSync(marker), "the hook did not run the anchors pass").toBe(true);
  });
});
