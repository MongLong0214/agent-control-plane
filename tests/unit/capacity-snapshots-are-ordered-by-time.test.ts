import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  AGENTCTL_CAPACITY_OBSERVATION_SOURCE,
  CapacityMonitor,
  RefreshTrigger,
} from "../../src/capacity/capacity-monitor.ts";
import { ControlPlane } from "../../src/app/control-plane.ts";
import { ManualClock } from "../../src/core/clock.ts";
import type { CapacityReading } from "../../src/runtime/provider.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { TestProductionAdapter } from "../helpers/production-adapter.ts";

afterAll(cleanupTempDirs);

/**
 * #1101 — `capacity_snapshots.observed_at` is TEXT with no format constraint, and a writer stores
 * its own spelling of the instant. Two valid spellings (a `Z` and an offset, or two precisions)
 * order differently as text than as time, so a reading selected by text order can be the older one.
 *
 * Every pair below is written through the monitor's own write paths, and in each the text order is
 * the reverse of the time order: the row that sorts last as text was observed first.
 */
const NOW = "2026-08-12T00:10:00.000Z";
const BUCKET = "weekly";
const RESET_AT = "2026-08-13T00:00:00.000Z";

const plane = () => {
  const root = tempDir("acp-capacity-order-");
  const clock = new ManualClock(NOW);
  const gpt = new TestProductionAdapter(clock, "gpt");
  const cp = new ControlPlane({
    databasePath: join(root, "state.sqlite"),
    worktreeRoot: join(root, "worktrees"),
    capacityDir: join(root, "capacity"),
    secretsDir: join(root, "secrets"),
    clock,
    adapters: [gpt],
  });
  // No continuity port: an observation here is only the write it makes, not a re-probe it triggers.
  const monitor = new CapacityMonitor(cp.db, clock, cp.audit, cp.providers, cp.telemetry);
  return { cp, clock, gpt, monitor };
};

const reading = (observedAt: string, remainingPercent: number): CapacityReading => ({
  provider: "gpt",
  sensorHealth: "HEALTHY",
  runtimeHealth: "HEALTHY",
  observedAt,
  source: `collector@${observedAt}`,
  buckets: [{ id: BUCKET, remainingPercent, resetAt: RESET_AT, capabilities: ["blind-review", "worker"] }],
});

/** Persists one collector reading through the refresh path, exactly as the daemon's sweep does. */
const collect = async (p: ReturnType<typeof plane>, observed: CapacityReading) => {
  p.gpt.setCapacity(observed);
  await p.monitor.refresh(RefreshTrigger.DOCTOR_CAPACITY_REPORT, ["gpt"]);
};

const instant = (text: string) => new Date(text).getTime();

describe("#1101: capacity_snapshots are ordered by time, not by observed_at text", () => {
  it.each([
    // 00:01Z spelled with a +00:08 offset sorts after 00:08Z as text.
    ["an offset against Z", "2026-08-12T00:09:00.000+00:08", "2026-08-12T00:08:00.000Z"],
    // `.` sorts before `Z`, so the whole second sorts after the half second that follows it.
    ["two precisions", "2026-08-12T00:08:00Z", "2026-08-12T00:08:00.500Z"],
  ])("the current reading is the newest observation (%s)", async (_label, older, newer) => {
    expect(older > newer && instant(older) < instant(newer)).toBe(true);
    const p = plane();
    try {
      await collect(p, reading(older, 70));
      await collect(p, reading(newer, 60));
      const current = p.monitor.current("gpt")!;
      expect(current.observedAt).toBe(newer);
      expect(current.buckets.map((bucket) => bucket.remainingPercent)).toEqual([60]);
    } finally {
      p.cp.close();
    }
  });

  it("an operator observation kept over a collector error is the newest one, not the last as text", async () => {
    const older = "2026-08-12T00:09:00.000+00:08"; // 00:01Z, inside the stale grace
    const newer = "2026-08-12T00:08:00.000Z";
    const p = plane();
    try {
      for (const [observedAt, remainingPercent] of [[older, 70], [newer, 60]] as const) {
        const observed = await p.monitor.observe({
          provider: "gpt",
          observedAt,
          actor: "owner",
          source: AGENTCTL_CAPACITY_OBSERVATION_SOURCE,
          runtimeHealth: "HEALTHY",
          buckets: [{ id: BUCKET, remainingPercent, resetAt: RESET_AT, capabilities: ["blind-review"] }],
        });
        expect(observed.allowed).toBe(true);
      }
      // The collector cannot read quota but measures the runtime: its row is the newest, and the
      // observation it may not replace is looked up behind it.
      await collect(p, { ...reading(NOW, 0), sensorHealth: "ERROR", buckets: [], error: "quota unreadable" });
      const current = p.monitor.current("gpt")!;
      expect(current.operatorObservation).toBeDefined();
      expect(current.observedAt).toBe(newer);
      expect(current.buckets.map((bucket) => bucket.remainingPercent)).toEqual([60]);
    } finally {
      p.cp.close();
    }
  });

  it("burn is measured from the newest observation back, not from the last as text", async () => {
    const p = plane();
    try {
      p.clock.set("2026-08-12T01:00:00.000Z");
      // 00:00Z at 90%, spelled so that it sorts after the 01:00Z reading at 80%.
      const older = "2026-08-12T01:30:00.000+01:30";
      const newer = "2026-08-12T01:00:00.000Z";
      expect(older > newer && instant(older) < instant(newer)).toBe(true);
      await collect(p, reading(older, 90));
      await collect(p, reading(newer, 80));
      // Ten points over the hour between them.
      const demand = p.monitor.workerReserveDemand("gpt");
      expect(demand.burnRatePercentPerHourByBucket?.[BUCKET]).toBeCloseTo(10, 6);
    } finally {
      p.cp.close();
    }
  });

  it("a collector reading with no usable observedAt is stored at the instant it was read, so it stays the newest", async () => {
    // Ordering by parsed time cannot place an unparseable instant. Stored as given, such a row would
    // sort behind every real one and the previous healthy reading would stay current: the sensor's
    // failure would read as the capacity it had before. The monitor stamps its own clock instead,
    // as it already does for a reading dated past the clock-skew allowance.
    const p = plane();
    try {
      await collect(p, reading("2026-08-12T00:09:00.000Z", 80));
      expect(p.monitor.current("gpt")?.allocationAdmission).toBe("OPEN");
      await collect(p, reading("not-a-date", 80));
      const current = p.monitor.current("gpt")!;
      expect(current.sensorHealth).toBe("ERROR");
      expect(current.allocationAdmission).toBe("SUSPENDED");
      expect(current.observedAt).toBe(NOW);
    } finally {
      p.cp.close();
    }
  });
});
