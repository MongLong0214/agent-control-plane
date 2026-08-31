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

const outputPathFor = (vitestArgs, reporter, fallback) => {
  const prefix = `--outputFile.${reporter}=`;
  const override = vitestArgs.find((argument) => argument.startsWith(prefix));
  return override ? resolve(repoRoot, override.slice(prefix.length)) : fallback;
};

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
  for (const name of countNames) {
    if (!nonnegativeInteger(report[name])) return invalid(`${name} is missing or is not a nonnegative integer`);
  }
  const accountedSuites =
    report.numPassedTestSuites + report.numFailedTestSuites + report.numPendingTestSuites;
  if (accountedSuites !== report.numTotalTestSuites) {
    return invalid(
      `suite counters account for ${accountedSuites} of ${report.numTotalTestSuites} collected suites`,
    );
  }
  if (typeof report.success !== "boolean") {
    return invalid("success is missing or is not a boolean");
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
  if (assertions.length !== tests) {
    return invalid(
      `assertion results enumerate ${assertions.length} of ${tests} collected tests`,
    );
  }

  const statusCounts = {
    passed: 0,
    failed: 0,
    pending: 0,
    skipped: 0,
    todo: 0,
  };
  for (const assertion of assertions) {
    if (
      !assertion ||
      typeof assertion !== "object" ||
      !Object.hasOwn(statusCounts, assertion.status)
    ) {
      return invalid("an assertion result has an unrecognized status");
    }
    statusCounts[assertion.status] += 1;
  }

  const expectedCounts = [
    ["numPassedTests", statusCounts.passed, "passed"],
    ["numFailedTests", statusCounts.failed, "failed"],
    ["numPendingTests", statusCounts.pending + statusCounts.skipped, "pending or skipped"],
    ["numTodoTests", statusCounts.todo, "todo"],
  ];
  for (const [name, assertionCount, status] of expectedCounts) {
    if (report[name] !== assertionCount) {
      return invalid(
        `${name} reports ${report[name]}, but assertion results enumerate ${assertionCount} ${status} tests`,
      );
    }
  }

  const accountedTests =
    report.numPassedTests + report.numFailedTests + report.numPendingTests + report.numTodoTests;
  if (accountedTests !== tests) {
    return invalid(`test counters account for ${accountedTests} of ${tests} collected tests`);
  }

  if (statusCounts.failed > 0) {
    return {
      kind: "product-failure",
      reason: `${statusCounts.failed} test${statusCounts.failed === 1 ? "" : "s"} failed`,
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
  const skippedAssertions = statusCounts.skipped;
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
      kind: "run-failure",
      reason: `Vitest exited ${exitCode} after reporting a complete passing result; the JSON and JUnit reports do not identify the cause`,
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

const readReport = (path) => {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};

export const runVitestAttempt = (vitestArgs = []) => {
  const attemptResultPath = outputPathFor(vitestArgs, "json", resultPath);
  const attemptJunitPath = outputPathFor(vitestArgs, "junit", junitPath);
  mkdirSync(dirname(attemptResultPath), { recursive: true });
  rmSync(attemptResultPath, { force: true });
  rmSync(attemptJunitPath, { force: true });
  const child = spawnSync(vitestPath, ["run", ...vitestArgs], {
    cwd: repoRoot,
    env: { ...process.env, ACP_VITEST_GATE: "1" },
    stdio: "inherit",
  });
  const exitCode = child.status ?? 1;
  return {
    exitCode,
    classification: classifyVitestRun(exitCode, readReport(attemptResultPath)),
  };
};

const printClassification = (classification, out) => {
  if (classification.kind === "pass") {
    out(`VITEST GATE: PASS — ${classification.reason}`);
    return;
  }
  const label = classification.kind === "product-failure" ? "PRODUCT TEST FAILURE" : "FAIL";
  out(`VITEST GATE: ${label} — ${classification.reason}`);
};

/** Runs once and fails closed on every classification other than a complete pass. */
export const runGate = (runAttempt, out = console.log) => {
  const result = runAttempt(1);
  printClassification(result.classification, out);
  return result.classification.kind === "pass" ? 0 : 1;
};

export const main = (args = process.argv.slice(2), out = console.log) =>
  runGate(() => runVitestAttempt(args), out);

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) process.exit(main());
