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
 * against the suite's file set as Vitest itself discovers it — `vitest list --filesOnly --json`,
 * run by each shard with the same config, checkout and runner as its tests, and written beside
 * its report as `ci-vitest-files.json`. A file missing, run twice, or not in that set fails the
 * merge, and so do shards whose lists disagree.
 *
 * This file used to restate Vitest's discovery with a walk of `tests/` that skipped dot-entries.
 * Vitest 4.1.11 does collect `tests/.hidden/x.test.ts`, so a passing hidden test failed `verify`
 * as "not a test file of this tree" — two descriptions of one set, disagreeing. Paths are compared
 * as the runner wrote them, absolute, so nothing here decides what a test file is.
 *
 * The merged report must then classify as a pass under the same `classifyVitestRun` the test gate
 * uses on each shard.
 *
 * Usage: node scripts/merge-vitest-results.mjs --out <merged.json> <shard.json> [<shard.json> ...]
 *        (each <shard.json> with the shard's `ci-vitest-files.json` in the same directory)
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { classifyVitestRun } from "./run-vitest-gate.mjs";

/** What each shard writes beside its report: `vitest list --filesOnly --json`, unsharded. */
export const FILES_LIST = "ci-vitest-files.json";
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

/** The file paths in one `vitest list --filesOnly --json` output, or null when it is not one. */
export const listedFiles = (list) => {
  if (!Array.isArray(list) || list.length === 0) return null;
  const files = list.map((entry) => entry?.file);
  return files.every((file) => typeof file === "string" && file !== "") ? files : null;
};

/** Missing, duplicated and unknown files, comparing the shards' union against Vitest's own list. */
export const coverageOf = (reports, expected) => {
  const seen = new Map();
  for (const report of reports) {
    for (const result of report.testResults ?? []) seen.set(String(result?.name), (seen.get(String(result?.name)) ?? 0) + 1);
  }
  const expectedSet = new Set(expected);
  return {
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

export const main = (argv = process.argv.slice(2), out = console.log) => {
  const outAt = argv.indexOf("--out");
  const outPath = outAt === -1 ? "" : (argv[outAt + 1] ?? "");
  const inputs = argv.filter((_, index) => index !== outAt && index !== outAt + 1);
  if (!outPath || inputs.length === 0 || inputs.some((input) => input.startsWith("--"))) {
    out("usage: merge-vitest-results.mjs --out <merged.json> <shard.json> [<shard.json> ...]");
    return 2;
  }

  const reports = [];
  const lists = [];
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

    const listPath = join(dirname(input), FILES_LIST);
    let files;
    try {
      files = listedFiles(JSON.parse(readFileSync(listPath, "utf8")));
    } catch (error) {
      out(`MERGE: FAIL — ${listPath} is not a readable Vitest file list: ${error.message}`);
      return 1;
    }
    if (!files) {
      out(`MERGE: FAIL — ${listPath} is not a non-empty \`vitest list --filesOnly --json\` output`);
      return 1;
    }
    lists.push({ listPath, files: [...files].sort() });
  }

  // Every shard listed the suite with the same config on the same checkout; a disagreement means
  // they did not, and there is no one set to judge coverage against.
  const expected = lists[0].files;
  for (const { listPath, files } of lists.slice(1)) {
    if (JSON.stringify(files) !== JSON.stringify(expected)) {
      out(`MERGE: FAIL — ${listPath} lists ${files.length} file(s), ${lists[0].listPath} lists ${expected.length}; the shards did not see one suite`);
      return 1;
    }
  }
  if (new Set(expected).size !== expected.length) {
    out(`MERGE: FAIL — ${lists[0].listPath} names a file twice`);
    return 1;
  }

  const coverage = coverageOf(reports, expected);
  const problems = [
    ...(coverage.missing.length ? [`${coverage.missing.length} test file(s) ran in no shard: ${coverage.missing.slice(0, 10).join(", ")}`] : []),
    ...(coverage.duplicated.length ? [`${coverage.duplicated.length} test file(s) ran in more than one shard: ${coverage.duplicated.slice(0, 10).join(", ")}`] : []),
    ...(coverage.unknown.length ? [`${coverage.unknown.length} result file(s) are not in Vitest's list: ${coverage.unknown.slice(0, 10).join(", ")}`] : []),
  ];
  out(`coverage: ${coverage.files} distinct file(s) across ${reports.length} shard report(s); Vitest lists ${expected.length}`);
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
  out(`MERGE: PASS — every one of the ${expected.length} test files Vitest lists ran exactly once; ${verdict.reason}`);
  return 0;
};

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) process.exit(main());
