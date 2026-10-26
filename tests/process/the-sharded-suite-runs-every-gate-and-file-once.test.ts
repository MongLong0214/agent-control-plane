/**
 * CI runs `pnpm gates` as two complementary halves — `--no-tests` in one job, `--tests-only` split
 * into Vitest shards across several — and then joins the shards' reports into one.
 *
 * Splitting is where a gate or a test file goes missing behind green jobs: a half that drops a gate
 * nobody listed, a shard nobody started, a file two shards both ran while a third ran nowhere. So:
 *
 *   - the two halves are read back from the runner and must partition the manifest;
 *   - the shard flag must reach `pnpm test` as Vitest's own `--shard=i/N`;
 *   - the merge must refuse a report set that does not cover the tree's test files exactly once.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { boundedSpawnSync } from "../helpers/bounded-sync-child.ts";

// @ts-expect-error The production entry point is plain JavaScript and intentionally has no build step.
import * as mergeModule from "../../scripts/merge-vitest-results.mjs";

const { main: merge, testFilesIn } = mergeModule as {
  main: (argv: string[], out: (line: string) => void, root: string) => number;
  testFilesIn: (root: string) => string[];
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

/** A scratch tree with test files where Vitest's include finds them, and two it does not. */
const scratchTree = (): string => {
  const root = tempDir("acp-merge-tree-");
  for (const file of ["tests/a.test.ts", "tests/unit/b.test.ts", "tests/unit/c.test.ts", "tests/.hidden/x.test.ts", "tests/node_modules/y.test.ts", "tests/helper.ts"]) {
    mkdirSync(join(root, file, ".."), { recursive: true });
    writeFileSync(join(root, file), "");
  }
  return root;
};

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
    name: `/Users/runner/work/acp/acp/${file}`,
    status,
    startTime: 1000,
    endTime: 1010,
    message: "",
    assertionResults: [{ fullName: `${file} works`, status, title: "works" }],
  })),
});

const mergeOf = (root: string, shards: unknown[]) => {
  const directory = tempDir("acp-merge-io-");
  const inputs = shards.map((shard, index) => {
    const path = join(directory, `shard-${index + 1}.json`);
    writeFileSync(path, JSON.stringify(shard));
    return path;
  });
  const out = join(directory, "merged.json");
  const lines: string[] = [];
  const status = merge(["--out", out, ...inputs], (line) => lines.push(line), root);
  return { status, lines: lines.join("\n"), out };
};

describe("joining the shards' reports", () => {
  it("collects the files Vitest's include collects, skipping dot-entries and node_modules", () => {
    expect(testFilesIn(scratchTree())).toEqual(["tests/a.test.ts", "tests/unit/b.test.ts", "tests/unit/c.test.ts"]);
  });

  it("writes one whole-suite report when every file ran exactly once", () => {
    const root = scratchTree();
    const { status, lines, out } = mergeOf(root, [report(["tests/a.test.ts"]), report(["tests/unit/b.test.ts", "tests/unit/c.test.ts"])]);
    expect(status, lines).toBe(0);
    const merged = JSON.parse(readFileSync(out, "utf8"));
    expect(merged.numTotalTests).toBe(3);
    expect(merged.testResults).toHaveLength(3);
    expect(merged.success).toBe(true);
  });

  it("refuses a file no shard ran", () => {
    const { status, lines } = mergeOf(scratchTree(), [report(["tests/a.test.ts"]), report(["tests/unit/b.test.ts"])]);
    expect(status).toBe(1);
    expect(lines).toContain("1 test file(s) ran in no shard: tests/unit/c.test.ts");
  });

  it("refuses a file two shards both ran", () => {
    const { status, lines } = mergeOf(scratchTree(), [
      report(["tests/a.test.ts", "tests/unit/b.test.ts"]),
      report(["tests/unit/b.test.ts", "tests/unit/c.test.ts"]),
    ]);
    expect(status).toBe(1);
    expect(lines).toContain("ran in more than one shard: tests/unit/b.test.ts");
  });

  it("refuses a result for a file this tree does not have", () => {
    const { status, lines } = mergeOf(scratchTree(), [report(["tests/a.test.ts", "tests/unit/b.test.ts", "tests/unit/c.test.ts", "tests/gone.test.ts"])]);
    expect(status).toBe(1);
    expect(lines).toContain("are not test files of this tree: tests/gone.test.ts");
  });

  it("refuses a malformed shard report and a merged run that did not pass", () => {
    const root = scratchTree();
    expect(mergeOf(root, [{ testResults: [] }]).status).toBe(1);
    const failed = mergeOf(root, [report(["tests/a.test.ts"]), report(["tests/unit/b.test.ts", "tests/unit/c.test.ts"], "failed")]);
    expect(failed.status).toBe(1);
    expect(failed.lines).toContain("the merged report is product-failure");
  });
});
