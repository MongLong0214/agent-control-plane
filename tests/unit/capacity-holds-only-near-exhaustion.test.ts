import { afterAll, describe, expect, it } from "vitest";
import { join } from "node:path";

import { CAPACITY_DEFAULTS, RefreshTrigger } from "../../src/capacity/capacity-monitor.ts";
import { ControlPlane } from "../../src/app/control-plane.ts";
import { ManualClock } from "../../src/core/clock.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import type { CapacityReading } from "../../src/runtime/provider.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { TestProductionAdapter } from "../helpers/production-adapter.ts";

afterAll(cleanupTempDirs);

/**
 * The live weekly window and the critical demand that was standing behind it when the
 * allocation was refused: one bound CTO, one unreviewed run, one running execution.
 */
const WEEKLY_BUCKET = "current-week-all-models";
const LIVE_DEMAND = {
  criticalRoleInvocations: 1,
  expectedReviews: 1,
  inFlightRuns: 1,
  burnRatePercentPerHour: 0,
  roleDemand: { ceo: 0, cto: 1, reviewer: 0 },
  burnRatePercentPerHourByBucket: { [WEEKLY_BUCKET]: 0 },
};

/**
 * A worker allocation through `refreshForWorkerFanout`, the gate `TaskGraph.startWorkerExecution`
 * calls. The reading is persisted by a real refresh first, so the reserve is computed from stored
 * capacity rather than from the object this test hands over.
 */
const admitWorkerAt = async (remainingPercent: number) => {
  const root = tempDir("acp-ladder-");
  const clock = new ManualClock("2026-09-20T00:00:00.000Z");
  const gpt = new TestProductionAdapter(clock, "gpt");
  const cp = new ControlPlane({
    databasePath: join(root, "state.sqlite"),
    worktreeRoot: join(root, "worktrees"),
    capacityDir: join(root, "capacity"),
    secretsDir: join(root, "secrets"),
    clock,
    adapters: [gpt],
  });
  try {
    const observed: CapacityReading = {
      provider: "gpt",
      sensorHealth: "HEALTHY",
      runtimeHealth: "HEALTHY",
      observedAt: clock.nowIso(),
      source: "capacity-ladder-test",
      buckets: [{
        id: WEEKLY_BUCKET,
        remainingPercent,
        resetAt: new Date(clock.now().getTime() + 24 * 60 * 60 * 1000).toISOString(),
        capabilities: ["worker"],
      }],
    };
    gpt.setCapacity(observed);
    await cp.capacity.refresh(RefreshTrigger.DOCTOR_CAPACITY_REPORT, ["gpt"]);
    return await cp.capacity.refreshForWorkerFanout({
      provider: "gpt",
      capabilities: ["worker"],
      priority: "worker",
      reserveDemand: LIVE_DEMAND,
    });
  } finally {
    cp.close();
  }
};

/**
 * Where the capacity ladder stands, and why the three numbers move together.
 *
 * Measured on the live deployment 2026-09-20: the weekly bucket read **20% remaining**
 * and `allocationAdmission` was `CONSERVE`, so every worker allocation was refused
 * `CAPACITY_ADMISSION_CONSERVE` while four fifths of the week's capacity sat unused. The owner's
 * decision is that holding work is for a bucket that is nearly gone, not one with a quarter left.
 *
 * The ordering is the invariant this pins, not the individual figures. `admission` is evaluated
 * top-down — `exhausted` first, then `conserve` — so lowering only `conserve` would leave
 * `exhausted` firing ahead of it and suspend *earlier* than before, which is the opposite of the
 * instruction. A future change that moves one number has to move the others or fail here.
 */
describe("capacity holds only near exhaustion", () => {
  it("conserves at five percent, not at a quarter", () => {
    expect(CAPACITY_DEFAULTS.conservePercent).toBe(5);
  });

  it("keeps the ladder strictly ordered so the top rung cannot pre-empt the one below it", () => {
    // exhausted < critical < conserve. Equality is a failure too: two rungs at the same percent
    // make one of them unreachable, which is the same defect as an inverted pair wearing a
    // different shape.
    expect(CAPACITY_DEFAULTS.exhaustedPercent).toBeLessThan(CAPACITY_DEFAULTS.criticalPercent);
    expect(CAPACITY_DEFAULTS.criticalPercent).toBeLessThan(CAPACITY_DEFAULTS.conservePercent);
  });

  it("admits the live reading that used to conserve, and still holds one inside the band", async () => {
    // Comparing 20 against the threshold would pass even against a gate that never reads
    // `conservePercent` and refuses solely on the dynamic reserve. So the allocation itself,
    // not the threshold value, is what this asserts.
    const live = await admitWorkerAt(20);
    expect(live.allowed).toBe(true);
    expect(live.reasonCode).toBe(ReasonCode.OK);

    // The same demand against a window inside the band: the reserve still governs there, so this
    // case fails if the ladder is mistaken for permission to admit everything.
    const nearlyGone = await admitWorkerAt(CAPACITY_DEFAULTS.conservePercent);
    expect(nearlyGone.allowed).toBe(false);
    expect(nearlyGone.reasonCode).toBe(ReasonCode.CAPACITY_ADMISSION_CONSERVE);
  });
});
