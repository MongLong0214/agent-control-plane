/**
 * CI runs `pnpm gates` as two complementary halves — `--no-tests` in one job, `--tests-only` split
 * into Vitest shards across several — and then joins the shards' reports into one.
 *
 * Splitting is where a gate or a test file goes missing behind green jobs: a half that drops a gate
 * nobody listed, a shard nobody started, a file two shards both ran while a third ran nowhere. So:
 *
 *   - the two halves are read back from the runner and must partition the manifest;
 *   - the shard flag must reach `pnpm test` as Vitest's own `--shard=i/N`;
 *   - the merge must refuse a report set that does not cover, exactly once, the files Vitest itself
 *     lists for the suite — and must not invent its own idea of what a test file is.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { boundedSpawnSync } from "../helpers/bounded-sync-child.ts";

// @ts-expect-error The production entry point is plain JavaScript and intentionally has no build step.
import * as mergeModule from "../../scripts/merge-vitest-results.mjs";

// The third argument is the checkout an earlier version of the merger walked for its own idea of
// the test files; the merger now ignores it, and passing it keeps these cases runnable against that
// version, where the dot-directory case below is the one that fails.
const { main: merge } = mergeModule as {
  main: (argv: string[], out: (line: string) => void, root?: string) => number;
};

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
const env = (path?: string): NodeJS.ProcessEnv => ({
  ...process.env,
  ...(path ? { PATH: `${path}:${process.env.PATH ?? ""}` } : {}),
  ACP_TRAILERS_RANGE: "",
});
const runner = (args: string[], path?: string) =>
  boundedSpawnSync(process.execPath, [RUNNER, ...args], { cwd: REPO_ROOT, encoding: "utf8", env: env(path) });
const listed = (args: string[]): string[] =>
  runner([...args, "--list"]).stdout.split("\n").filter(Boolean).map((line) => line.replace(/^\S+\s+pnpm\s+/, ""));

const stubbedPnpm = (): { path: string; log: string } => {
  const directory = tempDir("acp-gates-halves-");
  const log = join(directory, "invocations.log");
  writeFileSync(join(directory, "pnpm"), ["#!/bin/sh", `printf '%s\\n' "$*" >> "${log}"`, "exit 0", ""].join("\n"));
  chmodSync(join(directory, "pnpm"), 0o755);
  return { path: directory, log };
};
const invocations = (log: string): string[] => readFileSync(log, "utf8").split("\n").filter(Boolean);

describe("the two halves of pnpm gates", () => {
  it("partition the manifest: every gate in exactly one half, the suite alone in its own", () => {
    const whole = listed([]);
    const gates = listed(["--no-tests"]);
    const suite = listed(["--tests-only"]);
    expect(suite).toEqual(["test"]);
    expect([...gates, ...suite]).toEqual(whole);
    expect(gates).not.toContain("test");
  });

  it("runs every gate but the suite under --no-tests", () => {
    const stub = stubbedPnpm();
    const result = runner(["--no-tests"], stub.path);
    expect(result.status, result.stdout).toBe(0);
    expect(invocations(stub.log)).toEqual(listed(["--no-tests"]));
    expect(result.stdout).toMatch(/gates --no-tests: PASSED — (\d+) of \1 gate\(s\)/);
  });

  it("hands one shard to Vitest as --shard=i/N under --tests-only", () => {
    const stub = stubbedPnpm();
    const result = runner(["--tests-only", "--shard", "2/3"], stub.path);
    expect(result.status, result.stdout).toBe(0);
    expect(invocations(stub.log)).toEqual(["test --shard=2/3"]);
  });

  it("refuses a shard outside 1..N, a shard of the whole set, and both halves at once", () => {
    for (const args of [["--tests-only", "--shard", "4/3"], ["--tests-only", "--shard", "0/3"], ["--shard", "1/3"], ["--no-tests", "--tests-only"]]) {
      const stub = stubbedPnpm();
      const result = runner(args, stub.path);
      expect(result.status, args.join(" ")).toBe(2);
      expect(() => invocations(stub.log), args.join(" ")).toThrow();
    }
  });
});

const RUNNER_ROOT = "/Users/runner/work/acp/acp";
const absolute = (file: string) => `${RUNNER_ROOT}/${file}`;

const report = (files: string[], status = "passed") => ({
  numTotalTestSuites: files.length,
  numPassedTestSuites: status === "passed" ? files.length : 0,
  numFailedTestSuites: status === "failed" ? files.length : 0,
  numPendingTestSuites: 0,
  numTotalTests: files.length,
  numPassedTests: status === "passed" ? files.length : 0,
  numFailedTests: status === "failed" ? files.length : 0,
  numPendingTests: 0,
  numTodoTests: 0,
  snapshot: { added: 0, failure: false, filesRemovedList: [] },
  startTime: 1000,
  success: status === "passed",
  testResults: files.map((file) => ({
    name: absolute(file),
    status,
    startTime: 1000,
    endTime: 1010,
    message: "",
    assertionResults: [{ fullName: `${file} works`, status, title: "works" }],
  })),
});

/** `vitest list --filesOnly --json` output naming `files`, as a shard writes it beside its report. */
const listing = (files: string[]) => files.map((file) => ({ file: absolute(file) }));

type Shard = { report: unknown; list?: unknown };

/**
 * Each shard in its own directory, report and Vitest list side by side as the `verify` job
 * downloads them. `suite` is the set Vitest lists; it is also written out as a checkout, so the
 * earlier merger, which walked one, sees the same files.
 */
const mergeOf = (suite: string[], shards: Shard[]) => {
  const checkout = tempDir("acp-merge-tree-");
  for (const file of suite) {
    mkdirSync(join(checkout, file, ".."), { recursive: true });
    writeFileSync(join(checkout, file), "");
  }
  const directory = tempDir("acp-merge-io-");
  const inputs = shards.map((shard, index) => {
    const shardDirectory = join(directory, `vitest-results-shard-${index + 1}`);
    mkdirSync(shardDirectory);
    const path = join(shardDirectory, "ci-vitest-results.json");
    writeFileSync(path, JSON.stringify(shard.report));
    if (shard.list !== undefined) writeFileSync(join(shardDirectory, "ci-vitest-files.json"), JSON.stringify(shard.list));
    return path;
  });
  const out = join(directory, "merged.json");
  const lines: string[] = [];
  const status = merge(["--out", out, ...inputs], (line) => lines.push(line), checkout);
  return { status, lines: lines.join("\n"), out };
};

const SUITE = ["tests/a.test.ts", "tests/unit/b.test.ts", "tests/unit/c.test.ts"];
const shard = (files: string[], status = "passed", suite = SUITE): Shard => ({ report: report(files, status), list: listing(suite) });

describe("joining the shards' reports", () => {
  it("writes one whole-suite report when every file Vitest lists ran exactly once", () => {
    const { status, lines, out } = mergeOf(SUITE, [shard(["tests/a.test.ts"]), shard(["tests/unit/b.test.ts", "tests/unit/c.test.ts"])]);
    expect(status, lines).toBe(0);
    const merged = JSON.parse(readFileSync(out, "utf8"));
    expect(merged.numTotalTests).toBe(3);
    expect(merged.testResults).toHaveLength(3);
    expect(merged.success).toBe(true);
  });

  /**
   * Vitest 4.1.11 collects `tests/.hidden/b.test.ts`. A merger that skipped dot-entries on its own
   * reported it as unknown and failed `verify` for a suite in which every test ran once and passed.
   */
  it("does not fail a passing test Vitest collected under a dot-directory", () => {
    const suite = ["tests/a.test.ts", "tests/.hidden/b.test.ts"];
    const { status, lines } = mergeOf(suite, [shard(["tests/a.test.ts"], "passed", suite), shard(["tests/.hidden/b.test.ts"], "passed", suite)]);
    expect(status, lines).toBe(0);
  });

  it("refuses a file no shard ran", () => {
    const { status, lines } = mergeOf(SUITE, [shard(["tests/a.test.ts"]), shard(["tests/unit/b.test.ts"])]);
    expect(status).toBe(1);
    expect(lines).toContain("1 test file(s) ran in no shard");
    expect(lines).toContain("tests/unit/c.test.ts");
  });

  it("refuses a file two shards both ran", () => {
    const { status, lines } = mergeOf(SUITE, [shard(["tests/a.test.ts", "tests/unit/b.test.ts"]), shard(["tests/unit/b.test.ts", "tests/unit/c.test.ts"])]);
    expect(status).toBe(1);
    expect(lines).toContain("ran in more than one shard");
    expect(lines).toContain("tests/unit/b.test.ts");
  });

  it("refuses a result for a file Vitest did not list", () => {
    const { status, lines } = mergeOf(SUITE, [shard([...SUITE, "tests/gone.test.ts"])]);
    expect(status).toBe(1);
    expect(lines).toContain("tests/gone.test.ts");
  });

  it("refuses shards whose Vitest lists disagree, or a shard with no readable list", () => {
    const disagree = mergeOf(SUITE, [shard(["tests/a.test.ts"]), shard(["tests/unit/b.test.ts", "tests/unit/c.test.ts"], "passed", [...SUITE, "tests/d.test.ts"])]);
    expect(disagree.status).toBe(1);
    expect(disagree.lines).toContain("the shards did not see one suite");
    for (const list of [undefined, [], [{ name: "x" }], { file: "x" }]) {
      const { status } = mergeOf(SUITE, [{ report: report(SUITE), list }]);
      expect(status, JSON.stringify(list)).toBe(1);
    }
  });

  it("refuses a malformed shard report and a merged run that did not pass", () => {
    expect(mergeOf(SUITE, [{ report: { testResults: [] }, list: listing(SUITE) }]).status).toBe(1);
    const failed = mergeOf(SUITE, [shard(["tests/a.test.ts"]), shard(["tests/unit/b.test.ts", "tests/unit/c.test.ts"], "failed")]);
    expect(failed.status).toBe(1);
    expect(failed.lines).toContain("the merged report is product-failure");
  });

  /**
   * The same case end to end, against the installed Vitest rather than a description of it: a
   * scratch project with a test under a dot-directory and one under `node_modules`, listed and run by
   * the real binary, then merged. What Vitest lists is what Vitest ran, and the merge passes it.
   */
  it("merges what the installed Vitest lists and runs, dot-directories included", () => {
    const project = tempDir("acp-merge-vitest-");
    const write = (file: string, text: string) => {
      mkdirSync(join(project, file, ".."), { recursive: true });
      writeFileSync(join(project, file), text);
    };
    write("vitest.config.mjs", 'export default { test: { include: ["tests/**/*.test.ts"], globals: true } };\n');
    for (const file of ["tests/a.test.ts", "tests/.hidden/b.test.ts", "tests/node_modules/x/c.test.ts"]) {
      write(file, 'it("passes", () => { expect(1).toBe(1); });\n');
    }
    const shardDirectory = join(project, "out", "vitest-results-shard-1");
    mkdirSync(shardDirectory, { recursive: true });
    const vitest = (args: string[]) =>
      boundedSpawnSync(process.execPath, [join(REPO_ROOT, "node_modules", "vitest", "vitest.mjs"), ...args, "--root", project, "--config", join(project, "vitest.config.mjs")], {
        cwd: project,
        encoding: "utf8",
      });
    const listed = vitest(["list", "--filesOnly", `--json=${join(shardDirectory, "ci-vitest-files.json")}`]);
    expect(listed.status, listed.stderr).toBe(0);
    const ran = vitest(["run", "--reporter=json", `--outputFile=${join(shardDirectory, "ci-vitest-results.json")}`]);
    expect(ran.status, ran.stderr).toBe(0);

    const files = (JSON.parse(readFileSync(join(shardDirectory, "ci-vitest-files.json"), "utf8")) as Array<{ file: string }>).map((entry) => entry.file);
    expect(files.some((file) => file.endsWith("/tests/.hidden/b.test.ts"))).toBe(true);
    expect(files.some((file) => file.includes("/node_modules/"))).toBe(false);

    const lines: string[] = [];
    const status = merge(["--out", join(project, "out", "merged.json"), join(shardDirectory, "ci-vitest-results.json")], (line) => lines.push(line), project);
    expect(status, lines.join("\n")).toBe(0);
  });
});
