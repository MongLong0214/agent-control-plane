import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ReasonCode } from "../../src/core/reason-codes.ts";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const script = fileURLToPath(new URL("../../scripts/probe-daemon-startup.ts", import.meta.url));

describe("the daemon startup probe", () => {
  it("records every startup decision without a fixture authority", () => {
    const result = spawnSync(process.execPath, ["--import", "tsx", script, "--json"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 190_000,
    });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.error, output).toBeUndefined();
    expect(result.status, output).toBe(0);
    const report = JSON.parse(result.stdout) as {
      stages: Array<Record<string, unknown>>;
      problems: string[];
    };

    expect(report.problems).toEqual([]);
    expect(report.stages).toHaveLength(4);
    for (const stage of report.stages) expect(stage).not.toHaveProperty("error");

    expect(report.stages[0]?.["daemonStart"]).toMatchObject({
      allowed: false,
      reasonCode: ReasonCode.DOCTOR_ERROR,
      blockingFindings: expect.arrayContaining([
        expect.objectContaining({ code: "ROLE_COVERAGE_NO_VALID_COVERAGE" }),
        expect.objectContaining({ code: "TRUSTED_GATE_CREDENTIAL_MISSING" }),
      ]),
    });
    expect(report.stages[1]?.["daemonStart"]).toMatchObject({
      allowed: false,
      reasonCode: ReasonCode.DOCTOR_ERROR,
      blockingFindings: [expect.objectContaining({ code: "ROLE_COVERAGE_NO_VALID_COVERAGE" })],
    });
    expect(report.stages[2]).toMatchObject({
      daemonStart: {
        allowed: false,
        reasonCode: ReasonCode.DOCTOR_ERROR,
        blockingFindings: [expect.objectContaining({ code: "ROLE_COVERAGE_NO_VALID_COVERAGE" })],
      },
    });
    expect(report.stages[3]).toMatchObject({
      firstStart: { allowed: false, reasonCode: ReasonCode.DOCTOR_ERROR },
      immediateRestart: { allowed: false, reasonCode: ReasonCode.DAEMON_BACKOFF_ACTIVE },
      backoffWait: { retryNotBefore: expect.any(String), waitedMs: expect.any(Number) },
      retryAfterBackoff: {
        allowed: false,
        reasonCode: ReasonCode.DOCTOR_ERROR,
        blockingFindings: [expect.objectContaining({ code: "ROLE_COVERAGE_NO_VALID_COVERAGE" })],
      },
    });
  });
});
