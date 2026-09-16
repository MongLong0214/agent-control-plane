import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";

import { ManualClock } from "../../src/core/clock.ts";
import { ClaudeCliAdapter, __testing } from "../../src/runtime/cli-adapters.ts";
import type { CapacityReading } from "../../src/runtime/provider.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterEach(() => {
  __testing.setRunCli(null);
  cleanupTempDirs();
});

/**
 * `probeRuntime` answered `"HEALTHY"` or `"UNAVAILABLE"` and had no third word, so a `--version`
 * that never came back was reported as a CLI that is not there. `CapacityReading` has carried
 * `"UNKNOWN"` for exactly this all along; only the probe could not say it.
 *
 * It decides whether a binding survives. `daemon.ts`'s #811 guard keeps a READY incumbent bound
 * when the sensor failed but the runtime did not, and it tests for `"UNAVAILABLE"` — so a slow
 * `--version` walked past the guard written for this case. Measured on the live deployment
 * 2026-09-16: `/usage` timed out at 01:32:55.504Z with the runtime probe reporting `UNAVAILABLE`,
 * the canonical `PRIMARY_CTO` binding was revoked at 01:33:32.566Z, and coverage was
 * `FULL_COVERAGE` again at 01:36:01.278Z with nothing restored. Four such revocations are in the
 * audit (generations 2, 3, 4 and 6).
 */
const sensorFailed = (clock: ManualClock): CapacityReading => ({
  provider: "claude",
  sensorHealth: "ERROR",
  runtimeHealth: "UNKNOWN",
  observedAt: clock.nowIso(),
  source: "claude-usage",
  buckets: [],
  error: "non-interactive /usage did not finish in time",
});

const adapterWith = (clock: ManualClock) =>
  new ClaudeCliAdapter({
    clock,
    binary: "/nonexistent/claude",
    capacityFile: join(tempDir("acp-timed-out-probe-"), "claude.json"),
    usageCollector: { collect: async () => sensorFailed(clock) },
  });

/** Only the two fields the runtime probe reads; the rest of the shape is irrelevant to it. */
const cliResult = (outcome: { exitCode: number | null; timedOut: boolean }) => async () => ({
  stdout: "",
  stderr: "",
  isolationEnforced: false,
  ...outcome,
});

describe("a timed-out probe is not a dead runtime", () => {
  it("reports UNKNOWN when the runtime probe did not answer", async () => {
    const clock = new ManualClock("2026-09-16T01:32:55.504Z");
    __testing.setRunCli(cliResult({ exitCode: null, timedOut: true }));

    const reading = await adapterWith(clock).probeCapacity();

    expect(reading.runtimeHealth).toBe("UNKNOWN");
  });

  /**
   * The direction that keeps the repair honest. A CLI that answered and failed is evidence, and
   * the #811 guard must still let that revoke a binding — a fix that reported `"UNKNOWN"` for
   * every failure would satisfy the case above while making a genuinely dead runtime look
   * merely unmeasured.
   */
  it("still reports UNAVAILABLE when the runtime probe answered and failed", async () => {
    const clock = new ManualClock("2026-09-16T01:32:55.504Z");
    __testing.setRunCli(cliResult({ exitCode: 1, timedOut: false }));

    const reading = await adapterWith(clock).probeCapacity();

    expect(reading.runtimeHealth).toBe("UNAVAILABLE");
  });

  it("reports HEALTHY when the runtime probe answered and succeeded", async () => {
    const clock = new ManualClock("2026-09-16T01:32:55.504Z");
    __testing.setRunCli(cliResult({ exitCode: 0, timedOut: false }));

    const reading = await adapterWith(clock).probeCapacity();

    expect(reading.runtimeHealth).toBe("HEALTHY");
  });

  /**
   * `probeRuntime` is a different question with a different audience — `cto-lifecycle`,
   * `blind-review` and the daemon's session probe — and for them *could not tell* and *not there*
   * have always produced the same refusal. This change is not about them, and this pins that.
   */
  it("keeps the three-value contract its other callers have", async () => {
    const clock = new ManualClock("2026-09-16T01:32:55.504Z");
    __testing.setRunCli(cliResult({ exitCode: null, timedOut: true }));

    await expect(adapterWith(clock).probeRuntime()).resolves.toBe("UNAVAILABLE");
  });
});
