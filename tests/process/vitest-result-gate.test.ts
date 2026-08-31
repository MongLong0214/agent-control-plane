import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import killedWorkerReport from "./fixtures/vitest-4.1.11-killed-worker.json";

type Classification = {
  kind: "invalid" | "product-failure" | "incomplete" | "run-failure" | "pass";
  reason: string;
  files: number;
  tests: number;
};

// @ts-expect-error The production entry point is plain JavaScript and intentionally has no build step.
import * as gateModule from "../../scripts/run-vitest-gate.mjs";

const { classifyVitestRun, main, runGate } = gateModule as {
  classifyVitestRun: (exitCode: number, report: unknown) => Classification;
  main: (args?: string[], out?: (line: string) => void) => number;
  runGate: (
    runAttempt: (attempt: number) => { exitCode: number; classification: Classification },
    out?: (line: string) => void,
  ) => number;
};

const file = (status: string) => ({
  assertionResults: [
    {
      fullName: `synthetic ${status} result`,
      status,
    },
  ],
  startTime: 100,
  endTime: 110,
  status,
  name: "/synthetic/example.test.ts",
});

const report = ({ status = "passed" } = {}) => ({
  numTotalTestSuites: 1,
  numPassedTestSuites: status === "failed" ? 0 : 1,
  numFailedTestSuites: status === "failed" ? 1 : 0,
  numPendingTestSuites: 0,
  numTotalTests: 1,
  numPassedTests: status === "passed" ? 1 : 0,
  numFailedTests: status === "failed" ? 1 : 0,
  // Vitest 4.1.11's counter combines skipped and still-running tests. The assertion status below
  // is the reporter field that distinguishes an intentional skip from an unfinished test.
  numPendingTests: status === "skipped" ? 1 : 0,
  numTodoTests: status === "todo" ? 1 : 0,
  success: status !== "failed",
  testResults: [file(status)],
});

describe("the Vitest result gate", () => {
  it("fails when the result contains a failed test", () => {
    expect(classifyVitestRun(1, report({ status: "failed" })).kind).toBe("product-failure");
  });

  it("classifies a reporter pending assertion as incomplete", () => {
    // Captured from the pinned Vitest 4.1.11 JSON reporter after a forked test waited 100 ms and
    // sent SIGTERM to its own worker. The runner exited 1, while the reporter synthesized equal,
    // finite times and success true for the still-pending assertion.
    expect(killedWorkerReport).toMatchObject({
      numPendingTests: 1,
      success: true,
      testResults: [
        {
          assertionResults: [{ status: "pending" }],
          startTime: expect.any(Number),
          endTime: expect.any(Number),
        },
      ],
    });
    expect(Number.isFinite(killedWorkerReport.testResults[0]?.startTime)).toBe(true);
    expect(Number.isFinite(killedWorkerReport.testResults[0]?.endTime)).toBe(true);
    expect(classifyVitestRun(1, killedWorkerReport).kind).toBe("incomplete");
  });

  it("does not retry an incomplete report even if a later attempt would pass", () => {
    let attempts = 0;
    const exitCode = runGate(() => {
      attempts += 1;
      const processExit = attempts === 1 ? 1 : 0;
      const result = attempts === 1 ? killedWorkerReport : report();
      return {
        exitCode: processExit,
        classification: classifyVitestRun(processExit, result),
      };
    });

    expect(attempts).toBe(1);
    expect(exitCode).toBe(1);
  });

  it("treats a skipped assertion as complete without calling it passed", () => {
    const classification = classifyVitestRun(0, report({ status: "skipped" }));

    expect(classification.kind).toBe("pass");
    expect(classification.reason).toContain("0 passed, 1 skipped, 0 todo");
  });

  it("fails closed when assertion results omit a counted test", () => {
    const incompleteEnumeration = report();
    incompleteEnumeration.testResults[0]!.assertionResults = [];

    expect(classifyVitestRun(0, incompleteEnumeration)).toMatchObject({
      kind: "invalid",
      reason: "assertion results enumerate 0 of 1 collected tests",
    });
  });

  it("fails closed when assertion results enumerate more than the total", () => {
    const oversizedEnumeration = report();
    oversizedEnumeration.testResults[0]!.assertionResults.push({
      fullName: "synthetic extra result",
      status: "passed",
    });

    expect(classifyVitestRun(0, oversizedEnumeration)).toMatchObject({
      kind: "invalid",
      reason: "assertion results enumerate 2 of 1 collected tests",
    });
  });

  it("fails closed when assertion status counts disagree with report counters", () => {
    for (const [name, value] of [
      ["numPassedTests", 0],
      ["numFailedTests", 1],
      ["numPendingTests", 1],
      ["numTodoTests", 1],
    ] as const) {
      const inconsistentReport = report();
      inconsistentReport[name] = value;
      expect(classifyVitestRun(0, inconsistentReport).kind, name).toBe("invalid");
    }
  });

  it("fails closed when a nonzero exit follows complete passing results", () => {
    expect(classifyVitestRun(1, report()).kind).toBe("run-failure");
  });

  it("does not retry an unexplained run failure", () => {
    let attempts = 0;
    const output: string[] = [];
    const exitCode = runGate(
      (attempt) => {
        attempts += 1;
        const processExit = attempt === 1 ? 1 : 0;
        return {
          exitCode: processExit,
          classification: classifyVitestRun(processExit, report()),
        };
      },
      (line) => output.push(line),
    );

    expect(attempts).toBe(1);
    expect(exitCode).toBe(1);
    expect(output).toEqual([
      "VITEST GATE: FAIL — Vitest exited 1 after reporting a complete passing result; the JSON and JUnit reports do not identify the cause",
    ]);
  });

  it("fails a real Vitest run whose passing JSON omits an unhandled rejection", () => {
    const artifactDirectory = mkdtempSync(join(tmpdir(), "acp-vitest-result-gate-"));
    const jsonPath = join(artifactDirectory, "results.json");
    const junitPath = join(artifactDirectory, "junit.xml");
    const previousFixtureMode = process.env.ACP_VITEST_UNHANDLED_FIXTURE;
    const output: string[] = [];

    process.env.ACP_VITEST_UNHANDLED_FIXTURE = "1";
    try {
      const exitCode = main(
        [
          "tests/process/vitest-gate-unhandled-fixture.test.ts",
          "-t",
          "emits the opt in unhandled rejection fixture",
          `--outputFile.json=${jsonPath}`,
          `--outputFile.junit=${junitPath}`,
        ],
        (line) => output.push(line),
      );
      const realReport = JSON.parse(readFileSync(jsonPath, "utf8")) as Record<string, unknown>;

      expect(realReport).toMatchObject({
        success: true,
        numTotalTests: 1,
        numPassedTests: 1,
        numFailedTests: 0,
      });
      expect(exitCode).toBe(1);
      expect(output).toEqual([
        "VITEST GATE: FAIL — Vitest exited 1 after reporting a complete passing result; the JSON and JUnit reports do not identify the cause",
      ]);
    } finally {
      if (previousFixtureMode === undefined) delete process.env.ACP_VITEST_UNHANDLED_FIXTURE;
      else process.env.ACP_VITEST_UNHANDLED_FIXTURE = previousFixtureMode;
      rmSync(artifactDirectory, { recursive: true, force: true });
    }
  });

  it("fails closed when the result file is absent", () => {
    expect(classifyVitestRun(1, null).kind).toBe("invalid");
  });

  it("passes a complete passing result with exit zero", () => {
    expect(classifyVitestRun(0, report()).kind).toBe("pass");
  });
});
