#!/usr/bin/env node
/**
 * Joins the sharded suite's Vitest JSON reports into the single report one whole-suite run writes,
 * and refuses unless the shards between them ran every test file in the tree exactly once.
 *
 * The suite runs as `--shard=i/N` across N CI jobs, so each job's
 * `evidence/local/ci-vitest-results.json` covers a third of it. What reads that file downstream —
 * the `vitest-results-<node>` artifact, `ACP_VITEST_RESULTS` for `pnpm trace` — expects the whole
 * suite in one report, so the `verify` job rebuilds it here rather than every reader learning to
 * add shards up.
 *
 * The coverage check is the point, not the arithmetic. Vitest's sharding is a partition by
 * construction, but only of the N it is told: a matrix that lists two shards of `--shard=i/3`
 * leaves a third of the suite unrun behind green jobs. So the union of the reports is compared
 * against the test files in this checkout — `tests/**\/*.test.ts`, the `include` in
 * `vitest.config.ts`, skipping dot-entries and `node_modules` as Vitest's glob does — and a file
 * missing, run twice, or unknown fails the merge. If that `include` changes, this check fails
 * until it is changed with it, which is the direction a coverage check should fail in.
 *
 * The merged report must then classify as a pass under the same `classifyVitestRun` the test gate
 * uses on each shard.
 *
 * Usage: node scripts/merge-vitest-results.mjs --out <merged.json> <shard.json> [<shard.json> ...]
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { classifyVitestRun } from "./run-vitest-gate.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const COUNTS = [
  "numTotalTestSuites",
  "numPassedTestSuites",
  "numFailedTestSuites",
  "numPendingTestSuites",
  "numTotalTests",
  "numPassedTests",
  "numFailedTests",
  "numPendingTests",
  "numTodoTests",
];

/** The files `include: ["tests/**\/*.test.ts"]` collects, repository-relative, sorted. */
export const testFilesIn = (root) => {
  const found = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith(".test.ts")) found.push(relative(root, path).split(sep).join("/"));
    }
  };
  if (existsSync(join(root, "tests"))) walk(join(root, "tests"));
  return found.sort();
};

/** `/Users/runner/work/x/x/tests/a.test.ts` → `tests/a.test.ts`, keeping the checkout root it cut off. */
const splitRoot = (name) => {
  const at = typeof name === "string" ? name.indexOf("/tests/") : -1;
  return at === -1 ? null : { root: name.slice(0, at), file: name.slice(at + 1) };
};

/** Missing, duplicated and unknown files, comparing the shards' union against the tree's test files. */
export const coverageOf = (reports, expected) => {
  const roots = new Set();
  const seen = new Map();
  const unreadable = [];
  for (const report of reports) {
    for (const result of report.testResults ?? []) {
      const split = splitRoot(result?.name);
      if (!split) {
        unreadable.push(String(result?.name));
        continue;
      }
      roots.add(split.root);
      seen.set(split.file, (seen.get(split.file) ?? 0) + 1);
    }
  }
  const expectedSet = new Set(expected);
  return {
    roots: [...roots],
    unreadable,
    missing: expected.filter((file) => !seen.has(file)),
    duplicated: [...seen].filter(([, count]) => count > 1).map(([file]) => file),
    unknown: [...seen.keys()].filter((file) => !expectedSet.has(file)),
    files: seen.size,
  };
};

const mergeSnapshot = (snapshots) => {
  const merged = {};
  for (const snapshot of snapshots) {
    for (const [key, value] of Object.entries(snapshot ?? {})) {
      if (typeof value === "number") merged[key] = (merged[key] ?? 0) + value;
      else if (typeof value === "boolean") merged[key] = Boolean(merged[key]) || value;
      else if (Array.isArray(value)) merged[key] = [...(merged[key] ?? []), ...value];
      else if (!(key in merged)) merged[key] = value;
    }
  }
  return merged;
};

/** One report in Vitest's own JSON shape, as a single run of every shard's files would have written. */
export const mergeVitestReports = (reports) => {
  const merged = {};
  for (const name of COUNTS) merged[name] = reports.reduce((sum, report) => sum + report[name], 0);
  merged.snapshot = mergeSnapshot(reports.map((report) => report.snapshot));
  merged.startTime = Math.min(...reports.map((report) => report.startTime));
  merged.success = reports.every((report) => report.success === true);
  merged.testResults = reports.flatMap((report) => report.testResults);
  return merged;
};

export const main = (argv = process.argv.slice(2), out = console.log, root = ROOT) => {
  const outAt = argv.indexOf("--out");
  const outPath = outAt === -1 ? "" : (argv[outAt + 1] ?? "");
  const inputs = argv.filter((_, index) => index !== outAt && index !== outAt + 1);
  if (!outPath || inputs.length === 0 || inputs.some((input) => input.startsWith("--"))) {
    out("usage: merge-vitest-results.mjs --out <merged.json> <shard.json> [<shard.json> ...]");
    return 2;
  }

  const reports = [];
  for (const input of inputs) {
    let report;
    try {
      report = JSON.parse(readFileSync(input, "utf8"));
    } catch (error) {
      out(`MERGE: FAIL — ${input} is not a readable JSON report: ${error.message}`);
      return 1;
    }
    const shape = classifyVitestRun(0, report);
    if (shape.kind === "invalid") {
      out(`MERGE: FAIL — ${input}: ${shape.reason}`);
      return 1;
    }
    out(`shard report ${input}: ${shape.files} files, ${shape.tests} tests, ${shape.kind}`);
    reports.push(report);
  }

  const expected = testFilesIn(root);
  const coverage = coverageOf(reports, expected);
  const problems = [
    ...(coverage.unreadable.length ? [`${coverage.unreadable.length} result name(s) are not under tests/: ${coverage.unreadable.slice(0, 5).join(", ")}`] : []),
    ...(coverage.roots.length > 1 ? [`the shards ran in ${coverage.roots.length} different checkout roots`] : []),
    ...(coverage.missing.length ? [`${coverage.missing.length} test file(s) ran in no shard: ${coverage.missing.slice(0, 10).join(", ")}`] : []),
    ...(coverage.duplicated.length ? [`${coverage.duplicated.length} test file(s) ran in more than one shard: ${coverage.duplicated.slice(0, 10).join(", ")}`] : []),
    ...(coverage.unknown.length ? [`${coverage.unknown.length} result file(s) are not test files of this tree: ${coverage.unknown.slice(0, 10).join(", ")}`] : []),
  ];
  out(`coverage: ${coverage.files} distinct file(s) across ${reports.length} shard report(s); the tree has ${expected.length}`);
  if (problems.length > 0) {
    for (const problem of problems) out(`MERGE: FAIL — ${problem}`);
    return 1;
  }

  const merged = mergeVitestReports(reports);
  const verdict = classifyVitestRun(0, merged);
  mkdirSync(dirname(resolve(outPath)), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(merged)}\n`);
  if (verdict.kind !== "pass") {
    out(`MERGE: FAIL — the merged report is ${verdict.kind}: ${verdict.reason} (written to ${outPath} for reading)`);
    return 1;
  }
  out(`MERGE: PASS — every one of the tree's ${expected.length} test files ran exactly once; ${verdict.reason}`);
  return 0;
};

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) process.exit(main());
