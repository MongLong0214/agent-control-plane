/**
 * The pre-push gate runner's own contract (`pnpm gates`, the one step CI's `verify` job runs).
 *
 * The check that compared this manifest against `.github/workflows/ci.yml` was removed with the
 * other repository-rule gates on 2026-10-02; what stays is that the runner runs the whole
 * manifest, in order, and never reports a failed gate as a pass.
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { boundedSpawnSync } from "../helpers/bounded-sync-child.ts";

/**
 * Temporary directories, kept local on purpose.
 *
 * The shared fixture helper reaches the whole core harness — SQLite, the migration ledger, the
 * session registry — none of which this file touches: it spawns two scripts and reads their
 * output. Importing it made a process test fail to collect because an unrelated edit in `src/db`
 * was mid-flight, and a suite that cannot collect proves nothing about the guard it names.
 */
const temporaryDirectories: string[] = [];
const tempDir = (prefix: string): string => {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
};

afterAll(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

const REPO_ROOT = process.cwd();
const RUNNER = join(REPO_ROOT, "scripts", "run-prepush-gates.mjs");

/**
 * The runner's own contract: every gate's exit code is printed, a failure stops the sequence, and
 * nothing folds an intermediate failure into success.
 *
 * `pnpm` is stubbed on PATH so the whole manifest runs in milliseconds and a chosen gate can fail
 * on demand. The stub records what it was asked to run, which is what makes "nothing after it ran"
 * an observation instead of an inference.
 */
const stubbedPnpm = (options: { fail?: string; kill?: string }): { path: string; log: string } => {
  const directory = tempDir("acp-gates-stub-");
  const log = join(directory, "invocations.log");
  const script = [
    "#!/bin/sh",
    `printf '%s\\n' "$*" >> "${log}"`,
    options.kill ? `if [ "$1" = "${options.kill}" ]; then kill -TERM $$; fi` : "",
    options.fail ? `if [ "$1" = "${options.fail}" ]; then echo "stub: $1 is unhappy" >&2; exit 7; fi` : "",
    "exit 0",
    "",
  ].join("\n");
  writeFileSync(join(directory, "pnpm"), script);
  chmodSync(join(directory, "pnpm"), 0o755);
  return { path: directory, log };
};

// One environment, shared by every spawn in this file. `--list` renders a gate's command
// including any argument it takes from the environment (`trailers` takes `ACP_TRAILERS_RANGE`),
// so a `--list` that reads a different environment than the run describes a different gate set
// and the comparison below fails for a reason that has nothing to do with drift. That is not
// hypothetical: this file passed locally, where the variable is unset and both spawns agreed by
// accident, and failed on both CI legs, where the workflow sets it for the `pnpm gates` step.
const runnerEnv = (stub?: { path: string }): NodeJS.ProcessEnv => ({
  ...process.env,
  ...(stub ? { PATH: `${stub.path}:${process.env.PATH ?? ""}` } : {}),
  ACP_TRAILERS_RANGE: "",
});

const runRunner = (stub: { path: string }, args: string[] = []) =>
  boundedSpawnSync(process.execPath, [RUNNER, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: runnerEnv(stub),
  });

const invocations = (log: string): string[] =>
  readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => line.trim());

describe("the pre-push gate runner", () => {
  it("runs the whole manifest in order and reports each gate's exit code", () => {
    const stub = stubbedPnpm({});

    const result = runRunner(stub);

    expect(result.status, result.stdout).toBe(0);
    const ran = invocations(stub.log);
    const listed = boundedSpawnSync(process.execPath, [RUNNER, "--list"], { cwd: REPO_ROOT, encoding: "utf8", env: runnerEnv() })
      .stdout.split("\n")
      .filter(Boolean)
      .map((line) => line.replace(/^\S+\s+pnpm\s+/, ""));
    expect(ran).toEqual(listed);
    expect(result.stdout).toContain("PASS  pnpm lint  exit 0");
    expect(result.stdout).toContain(`gates: PASSED — ${listed.length} of ${listed.length} gate(s)`);
  });

  it("stops at the first failing gate and exits with that gate's status", () => {
    const stub = stubbedPnpm({ fail: "typecheck" });

    const result = runRunner(stub);

    // 7, not 1: a runner that normalises the exit code has thrown away which gate said what.
    expect(result.status).toBe(7);
    expect(result.stdout).toContain("FAIL  pnpm typecheck  exit 7");
    expect(result.stdout).toContain("gates: FAILED at pnpm typecheck (exit 7)");
    expect(result.stdout).toContain("SKIP  not run");

    const ran = invocations(stub.log);
    expect(ran.at(-1)).toBe("typecheck");
    expect(ran).not.toContain("test");
  });

  it("does not swallow a failing gate's own output", () => {
    const stub = stubbedPnpm({ fail: "lint" });

    const result = runRunner(stub);

    expect(result.stderr).toContain("stub: lint is unhappy");
  });

  it("counts a gate killed by a signal as a failure, not as an exit code of zero", () => {
    const stub = stubbedPnpm({ kill: "reason-codes" });

    const result = runRunner(stub);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("killed by SIGTERM");
    expect(invocations(stub.log)).not.toContain("test");
  });

  it("refuses an argument, because a subset of the gates is the thing that failed #736", () => {
    const stub = stubbedPnpm({});

    const result = runRunner(stub, ["--only", "lint"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("there is deliberately no way to run part of it");
    expect(() => invocations(stub.log)).toThrow();
  });
});
