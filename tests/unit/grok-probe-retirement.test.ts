import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ControlPlane } from "../../src/app/control-plane.ts";
import { CapacityMonitor, RefreshTrigger } from "../../src/capacity/capacity-monitor.ts";
import { ManualClock } from "../../src/core/clock.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import type { CapacityReading } from "../../src/runtime/provider.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { TestProductionAdapter } from "../helpers/production-adapter.ts";

afterAll(cleanupTempDirs);

/**
 * #735 — grok's stored CLI credential expires and only the CLI can renew it. Unattended,
 * every periodic probe against it can only ever fail, which is what the live deployment
 * measured: 461 PROBE_FAILED / 39 CAPACITY_ADMISSION_SUSPENDED audit events out of the last
 * 500 CAPACITY_PROBE events, all `trigger: DOCTOR_CAPACITY_REPORT` (the unattended sweep).
 *
 * The fix is not renewal — the CEO's ruling is that grok comes out of automatic probing and
 * is probed only on explicit opt-in. This file pins: the default excludes grok from the
 * unattended sweep, an explicit opt-in restores it, an opted-in failure still surfaces
 * loudly (this removes a default, not a diagnostic), the other providers are unaffected,
 * an explicit dispatch target still reaches grok regardless of the unattended opt-in, and a
 * reading recorded before retirement does not keep influencing doctor findings afterward.
 */
const makePlane = (capacity?: { unattendedProbeOptIns?: readonly string[] }) => {
  const root = tempDir("acp-grok-retire-");
  const clock = new ManualClock("2026-08-23T00:00:00.000Z");
  const gpt = new TestProductionAdapter(clock, "gpt");
  const claude = new TestProductionAdapter(clock, "claude");
  const grok = new TestProductionAdapter(clock, "grok");
  const cp = new ControlPlane({
    databasePath: join(root, "state.sqlite"),
    worktreeRoot: join(root, "worktrees"),
    capacityDir: join(root, "capacity"),
    secretsDir: join(root, "secrets"),
    clock,
    adapters: [gpt, claude, grok],
    allowTestEvidenceWriters: true,
    ctoPreference: { provider: "claude", model: "opus", effort: null },
    reviewer: {
      preferred: { provider: "gpt", model: "gpt-5.6-sol", effort: "xhigh" },
      fallbacks: [],
    },
    capacity,
  });
  return { cp, clock, gpt, claude, grok, root };
};

const expiredGrokReading = (clock: ManualClock): CapacityReading => ({
  provider: "grok",
  sensorHealth: "ERROR",
  runtimeHealth: "HEALTHY",
  observedAt: clock.nowIso(),
  source: "account-billing:grok",
  buckets: [],
  error: "grok billing refused the stored credential; it has expired and only the CLI can renew it",
});

describe("grok retired from the unattended capacity probe (#735)", () => {
  it("a default configuration does not probe grok during an unattended refresh", async () => {
    const { cp, grok } = makePlane();
    const probe = vi.spyOn(grok, "probeCapacity");

    const readings = await cp.capacity.refresh(RefreshTrigger.DOCTOR_CAPACITY_REPORT);

    expect(probe).not.toHaveBeenCalled();
    expect(readings.map((r) => r.provider)).not.toContain("grok");
  });

  it("an explicit opt in probes grok during an unattended refresh", async () => {
    const { cp, grok } = makePlane({ unattendedProbeOptIns: ["grok"] });
    const probe = vi.spyOn(grok, "probeCapacity");

    const readings = await cp.capacity.refresh(RefreshTrigger.DOCTOR_CAPACITY_REPORT);

    expect(probe).toHaveBeenCalledTimes(1);
    expect(readings.map((r) => r.provider)).toContain("grok");
  });

  it("a failing grok probe under opt in still surfaces the failure", async () => {
    const { cp, grok, clock } = makePlane({ unattendedProbeOptIns: ["grok"] });
    grok.setCapacity(expiredGrokReading(clock));

    const readings = await cp.capacity.refresh(RefreshTrigger.DOCTOR_CAPACITY_REPORT);

    const grokReading = readings.find((r) => r.provider === "grok");
    expect(grokReading?.sensorHealth).toBe("ERROR");
    expect(grokReading?.allocationAdmission).toBe("SUSPENDED");

    const probeFailed = cp.audit
      .byKind("CAPACITY_PROBE")
      .filter((row) => row.reasonCode === ReasonCode.PROBE_FAILED)
      .filter((row) => (row.evidence as Record<string, unknown>)["provider"] === "grok");
    expect(probeFailed.length).toBeGreaterThan(0);

    const report = await cp.doctor.run("capacity");
    expect(report.findings.some((f) => f.code === "CAPACITY_SENSOR_FAILED" && f.scope === "provider:grok")).toBe(true);
  });

  it("gpt and claude are still probed by default during an unattended refresh", async () => {
    const { cp, gpt, claude } = makePlane();
    const gptProbe = vi.spyOn(gpt, "probeCapacity");
    const claudeProbe = vi.spyOn(claude, "probeCapacity");

    const readings = await cp.capacity.refresh(RefreshTrigger.DOCTOR_CAPACITY_REPORT);

    expect(gptProbe).toHaveBeenCalledTimes(1);
    expect(claudeProbe).toHaveBeenCalledTimes(1);
    expect(readings.map((r) => r.provider).sort()).toEqual(["claude", "gpt"]);
  });

  it("an explicit dispatch target still probes grok without the unattended opt in", async () => {
    const { cp, grok } = makePlane();
    const probe = vi.spyOn(grok, "probeCapacity");

    // Naming grok explicitly is the "asked for" path (§14.2 dispatch admission), never the
    // unattended sweep, so retirement from the sweep must not touch it.
    await cp.capacity.refreshForDispatch({ provider: "grok", capabilities: ["worker"] });

    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("a stale grok database row does not reappear once retirement removes it from the unattended refresh", async () => {
    const { cp, grok, clock } = makePlane({ unattendedProbeOptIns: ["grok"] });
    grok.setCapacity(expiredGrokReading(clock));
    await cp.capacity.refresh(RefreshTrigger.DOCTOR_CAPACITY_REPORT);
    expect(cp.capacity.current("grok")?.allocationAdmission).toBe("SUSPENDED");

    // A later deployment that retires grok (no opt-in) shares the same durable state — the
    // row above is still there, recorded honestly, but must not be read back as a live
    // finding once nothing probes it anymore.
    const retired = new CapacityMonitor(cp.db, clock, cp.audit, cp.providers, cp.telemetry);
    const readings = await retired.refresh(RefreshTrigger.DOCTOR_CAPACITY_REPORT);

    expect(readings.map((r) => r.provider)).not.toContain("grok");
    // The historical row itself is preserved, not deleted or falsified.
    expect(retired.current("grok")?.allocationAdmission).toBe("SUSPENDED");
  });

  it("a stale grok sensor file does not resurface as a doctor finding after retirement", async () => {
    const { cp, clock } = makePlane();

    // Simulate a sensor file the daemon wrote while grok was still probed, left behind by a
    // deployment that has since retired it, and now old enough to be stale by any freshness
    // window.
    mkdirSync(cp.config.capacityDir, { recursive: true });
    writeFileSync(
      join(cp.config.capacityDir, "grok.json"),
      JSON.stringify({ provider: "grok", observedAt: clock.nowIso() }),
    );
    clock.advance(6 * 60 * 60 * 1000);

    const report = await cp.doctor.run("capacity");

    expect(report.findings.some((f) => f.scope === "provider:grok")).toBe(false);
  });
});
