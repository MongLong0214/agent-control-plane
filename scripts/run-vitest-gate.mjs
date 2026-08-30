#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const resultPath = join(repoRoot, "evidence", "local", "ci-vitest-results.json");
const junitPath = join(repoRoot, "evidence", "junit.xml");
const vitestPath = join(repoRoot, "node_modules", ".bin", "vitest");

const nonnegativeInteger = (value) => Number.isInteger(value) && value >= 0;

const invalid = (reason) => ({
  kind: "invalid",
  reason,
  files: 0,
  tests: 0,
});

/**
 * Classifies one Vitest process from the report it wrote, never from its exit status alone.
 * A missing or malformed report fails closed: an old report is deleted before each attempt, so
 * absence means this attempt never supplied enough evidence to judge the suite.
 */
export const classifyVitestRun = (exitCode, report) => {
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    return invalid("the Vitest JSON result file is missing or is not an object");
  }

  const countNames = [
    "numTotalTests",
    "numPassedTests",
    "numFailedTests",
    "numPendingTests",
    "numTodoTests",
  ];
  for (const name of countNames) {
    if (!nonnegativeInteger(report[name])) return invalid(`${name} is missing or is not a nonnegative integer`);
  }
  if (!Array.isArray(report.testResults) || report.testResults.length === 0) {
    return invalid("the result file names no collected test files");
  }

  const assertions = [];
  for (const file of report.testResults) {
    if (!file || typeof file !== "object" || !Array.isArray(file.assertionResults)) {
      return invalid("a collected test file has no assertion results");
    }
    assertions.push(...file.assertionResults);
  }

  const files = report.testResults.length;
  const tests = report.numTotalTests;
  const failedAssertions = assertions.filter((assertion) => assertion?.status === "failed").length;
  const failedTests = Math.max(report.numFailedTests, failedAssertions);
  if (failedTests > 0) {
    return {
      kind: "product-failure",
      reason: `${failedTests} test${failedTests === 1 ? "" : "s"} failed`,
      files,
      tests,
    };
  }

  const incompleteFiles = report.testResults.filter(
    (file) =>
      !Number.isFinite(file?.startTime) ||
      !Number.isFinite(file?.endTime) ||
      file.endTime < file.startTime,
  );
  const pendingAssertions = assertions.filter(
    (assertion) => assertion?.status === "pending",
  ).length;
  const skippedAssertions = assertions.filter(
    (assertion) => assertion?.status === "skipped",
  ).length;
  if (incompleteFiles.length > 0 || pendingAssertions > 0) {
    const reasons = [];
    if (incompleteFiles.length > 0) {
      reasons.push(
        `${incompleteFiles.length} collected test file${incompleteFiles.length === 1 ? " has" : "s have"} no completed interval`,
      );
    }
    if (pendingAssertions > 0) {
      reasons.push(
        `${pendingAssertions} assertion${pendingAssertions === 1 ? " is" : "s are"} still pending`,
      );
    }
    return {
      kind: "incomplete",
      reason: reasons.join("; "),
      files,
      tests,
    };
  }

  if (report.numPendingTests !== skippedAssertions) {
    return invalid(
      `Vitest's pending counter reports ${report.numPendingTests}, but ${skippedAssertions} completed assertions were skipped`,
    );
  }

  const accountedTests =
    report.numPassedTests + report.numFailedTests + skippedAssertions + report.numTodoTests;
  if (accountedTests !== report.numTotalTests) {
    return invalid(
      `test counters account for ${accountedTests} of ${report.numTotalTests} collected tests`,
    );
  }
  if (report.success !== true) {
    return {
      kind: "run-failure",
      reason: "Vitest marked the completed result set unsuccessful without a failed test",
      files,
      tests,
    };
  }

  if (exitCode !== 0) {
    return {
      kind: "infrastructure",
      reason: `all ${files} collected files completed; ${report.numPassedTests} passed, ${skippedAssertions} skipped, ${report.numTodoTests} todo, but Vitest exited ${exitCode}`,
      files,
      tests,
    };
  }
  return {
    kind: "pass",
    reason: `all ${files} collected files completed; ${report.numPassedTests} passed, ${skippedAssertions} skipped, ${report.numTodoTests} todo`,
    files,
    tests,
  };
};

const readReport = () => {
  if (!existsSync(resultPath)) return null;
  try {
    return JSON.parse(readFileSync(resultPath, "utf8"));
  } catch {
    return null;
  }
};

export const runVitestAttempt = (vitestArgs = []) => {
  mkdirSync(dirname(resultPath), { recursive: true });
  rmSync(resultPath, { force: true });
  rmSync(junitPath, { force: true });
  const child = spawnSync(vitestPath, ["run", ...vitestArgs], {
    cwd: repoRoot,
    env: { ...process.env, ACP_VITEST_GATE: "1" },
    stdio: "inherit",
  });
  const exitCode = child.status ?? 1;
  return {
    exitCode,
    classification: classifyVitestRun(exitCode, readReport()),
  };
};

const printClassification = (classification, attempt, out) => {
  if (classification.kind === "pass") {
    out(`VITEST GATE: PASS — ${classification.reason}`);
    return;
  }
  if (classification.kind === "infrastructure") {
    out(`VITEST GATE: INFRASTRUCTURE, NOT PRODUCT TEST FAILURE — ${classification.reason}`);
    if (attempt === 1) out("VITEST GATE: retrying once in this job");
    return;
  }
  const label = classification.kind === "product-failure" ? "PRODUCT TEST FAILURE" : "FAIL";
  out(`VITEST GATE: ${label} — ${classification.reason}`);
};

/** Runs once normally, and exactly once more only for an infrastructure-classified result. */
export const runGate = (runAttempt, out = console.log) => {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const result = runAttempt(attempt);
    printClassification(result.classification, attempt, out);
    if (result.classification.kind === "pass") return 0;
    if (result.classification.kind !== "infrastructure") return 1;
    if (attempt === 2) {
      out(
        "VITEST GATE: FAIL — two consecutive infrastructure-classified runs; neither run had a product test failure, but infrastructure stayed nonzero",
      );
      return 1;
    }
  }
  return 1;
};

export const main = (args = process.argv.slice(2)) => runGate(() => runVitestAttempt(args));

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) process.exit(main());
