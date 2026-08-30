import { describe, expect, it } from "vitest";

type Classification = {
  kind: "invalid" | "product-failure" | "incomplete" | "run-failure" | "infrastructure" | "pass";
  reason: string;
  files: number;
  tests: number;
};

// @ts-expect-error The production entry point is plain JavaScript and intentionally has no build step.
import * as gateModule from "../../scripts/run-vitest-gate.mjs";

const { classifyVitestRun, runGate } = gateModule as {
  classifyVitestRun: (exitCode: number, report: unknown) => Classification;
  runGate: (
    runAttempt: (attempt: number) => { exitCode: number; classification: Classification },
    out?: (line: string) => void,
  ) => number;
};

const file = (status: string, complete = true) => ({
  assertionResults: [
    {
      fullName: `synthetic ${status} result`,
      status,
    },
  ],
  startTime: 100,
  ...(complete ? { endTime: 110 } : {}),
  status,
  name: "/synthetic/example.test.ts",
});

const report = ({ status = "passed", complete = true } = {}) => ({
  numTotalTestSuites: 1,
  numPassedTestSuites: status === "passed" && complete ? 1 : 0,
  numFailedTestSuites: status === "failed" ? 1 : 0,
  numPendingTestSuites: complete ? 0 : 1,
  numTotalTests: 1,
  numPassedTests: status === "passed" ? 1 : 0,
  numFailedTests: status === "failed" ? 1 : 0,
  numPendingTests: status === "pending" ? 1 : 0,
  numTodoTests: 0,
  success: status === "passed" && complete,
  testResults: [file(status, complete)],
});

describe("the Vitest result gate", () => {
  it("fails when the result contains a failed test", () => {
    expect(classifyVitestRun(1, report({ status: "failed" })).kind).toBe("product-failure");
  });

  it("fails when a collected file is incomplete", () => {
    expect(classifyVitestRun(1, report({ status: "pending", complete: false })).kind).toBe(
      "incomplete",
    );
  });

  it("classifies a nonzero exit after complete passing results as infrastructure", () => {
    expect(classifyVitestRun(1, report()).kind).toBe("infrastructure");
  });

  it("fails after two consecutive infrastructure classifications", () => {
    let attempts = 0;
    const output: string[] = [];
    const exitCode = runGate(
      () => {
        attempts += 1;
        return { exitCode: 1, classification: classifyVitestRun(1, report()) };
      },
      (line) => output.push(line),
    );

    expect(attempts).toBe(2);
    expect(exitCode).toBe(1);
    expect(output).toContain(
      "VITEST GATE: FAIL — two consecutive infrastructure-classified runs; product tests passed in both runs, but infrastructure stayed nonzero",
    );
  });

  it("fails closed when the result file is absent", () => {
    expect(classifyVitestRun(1, null).kind).toBe("invalid");
  });

  it("passes a complete passing result with exit zero", () => {
    expect(classifyVitestRun(0, report()).kind).toBe("pass");
  });
});
