import { describe, expect, it } from "vitest";
import { CapacityMonitor, RefreshTrigger } from "../../src/capacity/capacity-monitor.ts";
import { ManualClock } from "../../src/core/clock.ts";
import type { AuditLog } from "../../src/db/audit.ts";
import type { Db } from "../../src/db/database.ts";
import { Role } from "../../src/domain/types.ts";
import { ProviderRegistry, type ProviderAdapter } from "../../src/runtime/provider.ts";
import type { Telemetry } from "../../src/telemetry/telemetry.ts";

// No persistence or composition: this slice must not publish role facts into provider-global rows.
const forbidden = new Proxy({}, { get: () => { throw new Error("unexpected persistence"); } });
const fixture = () => {
  const registry = new ProviderRegistry();
  const clock = new ManualClock();
  const calls: string[] = [];
  const adapter = (marker: string, remainingPercent: number): ProviderAdapter => ({
    provider: "claude", isProduction: true,
    async probeCapacity() {
      calls.push(marker);
      return { provider: "claude", sensorHealth: "HEALTHY", runtimeHealth: "HEALTHY",
        observedAt: clock.nowIso(), source: marker,
        buckets: [{ id: "quota", remainingPercent, resetAt: null, capabilities: ["cto", "blind-review"] }] };
    },
  } as ProviderAdapter);
  const monitor = new CapacityMonitor(forbidden as Db, clock, forbidden as AuditLog,
    registry, forbidden as Telemetry);
  return { registry, clock, calls, adapter, monitor };
};

describe("role-bound capacity stays out of provider-global storage", () => {
  it.each(["throw", "wrong-provider"])("discards prior capacity when the exact probe fails: %s", async (failure) => {
    const { registry, adapter, monitor } = fixture();
    const a = adapter("cto", 80);
    registry.registerForRole(a, Role.PRIMARY_CTO);
    const old = await monitor.refreshForRole("claude", Role.PRIMARY_CTO);
    a.probeCapacity = async () => {
      if (failure === "throw") throw new Error("private collector detail");
      return { ...old, provider: "other" };
    };
    const failed = await monitor.refreshForRole("claude", Role.PRIMARY_CTO);
    expect(failed.advisoryState).toBe("UNKNOWN");
    expect(failed.provider).toBe("claude");
    expect(monitor.currentForRole("claude", Role.PRIMARY_CTO)).toBeNull();
  });

  it("never falls back for a missing role and retains the existing TTL", async () => {
    const { registry, calls, adapter, monitor, clock } = fixture();
    registry.register(adapter("shared", 90));
    registry.registerForRole(adapter("cto", 80), Role.PRIMARY_CTO);
    expect((await monitor.refreshForRole("claude", Role.BLIND_REVIEWER)).advisoryState).toBe("UNKNOWN");
    expect(calls).toEqual([]);
    const snapshot = await monitor.refreshForRole("claude", Role.PRIMARY_CTO);
    snapshot.buckets[0]!.remainingPercent = 0;
    expect(monitor.currentForRole("claude", Role.PRIMARY_CTO)?.allocationAdmission).toBe("OPEN");
    clock.advance(15 * 60 * 1000 + 1);
    expect(monitor.currentForRole("claude", Role.PRIMARY_CTO)?.allocationAdmission).toBe("SUSPENDED");
  });

  it.each([false, true])("refuses unscoped measurements and admission when roles exist (shared=%s)", async (shared) => {
    const { registry, calls, adapter, monitor } = fixture();
    registry.registerForRole(adapter("cto", 80), Role.PRIMARY_CTO);
    if (shared) registry.register(adapter("shared", 90));
    const readings = await monitor.refresh(RefreshTrigger.DISPATCH_ADMISSION, ["claude"]);
    expect(readings[0]?.advisoryState).toBe("UNKNOWN");
    expect((await monitor.refreshForDispatch({ provider: "claude", capabilities: ["cto"] })).allowed).toBe(false);
    expect(monitor.current("claude")?.advisoryState).toBe("UNKNOWN");
    expect(monitor.providersFor("cto")).toEqual([]);
    await monitor.refresh(RefreshTrigger.DOCTOR_CAPACITY_REPORT);
    expect(calls).toEqual([]);
  });

  it("invalidates only the named binding, including a probe already in flight", async () => {
    const { registry, adapter, monitor } = fixture();
    const ctoAdapter = adapter("cto", 80);
    registry.registerForRole(ctoAdapter, Role.PRIMARY_CTO);
    registry.registerForRole(adapter("reviewer", 60), Role.BLIND_REVIEWER);
    const old = await monitor.refreshForRole("claude", Role.PRIMARY_CTO);
    await monitor.refreshForRole("claude", Role.BLIND_REVIEWER);
    const probe = ctoAdapter.probeCapacity.bind(ctoAdapter);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    ctoAdapter.probeCapacity = async () => { await gate; return probe(); };
    const pending = monitor.refreshForRole("claude", Role.PRIMARY_CTO);
    registry.invalidateCapacityForRole("claude", Role.PRIMARY_CTO);
    expect(monitor.currentForRole("claude", Role.PRIMARY_CTO)).toBeNull();
    expect(monitor.currentForRole("claude", Role.BLIND_REVIEWER)?.source).toBe("reviewer");
    release();
    expect((await pending).advisoryState).toBe("UNKNOWN");
    expect(monitor.currentForRole("claude", Role.PRIMARY_CTO)).toBeNull();
    const fresh = await monitor.refreshForRole("claude", Role.PRIMARY_CTO);
    expect(fresh.binding.generation).not.toBe(old.binding.generation);
    expect(fresh.allocationAdmission).toBe("OPEN");
  });

  it("measures only the explicitly registered role and keeps the snapshots separate", async () => {
    const { registry, calls, adapter, monitor } = fixture();
    registry.registerForRole(adapter("cto", 80), Role.PRIMARY_CTO);
    registry.registerForRole(adapter("reviewer", 0), Role.BLIND_REVIEWER);
    const cto = await monitor.refreshForRole("claude", Role.PRIMARY_CTO);
    const reviewer = await monitor.refreshForRole("claude", Role.BLIND_REVIEWER);
    expect(calls).toEqual(["cto", "reviewer"]);
    expect(cto.allocationAdmission).toBe("OPEN");
    expect(reviewer.allocationAdmission).toBe("SUSPENDED");
    expect(monitor.currentForRole("claude", Role.PRIMARY_CTO)?.source).toBe("cto");
    expect(monitor.currentForRole("claude", Role.BLIND_REVIEWER)?.source).toBe("reviewer");
    expect(cto.binding).toEqual({ provider: "claude", role: Role.PRIMARY_CTO, generation: expect.any(Number) });
  });
});
