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
  const admissions = ["refreshForDispatch", "refreshForBlindReview", "refreshForProviderSwitch", "refreshForWorkerFanout"] as const;
  it.each(admissions)("%s applies unknown, TTL, capability, runtime and binding checks", async (method) => {
    const { registry, adapter, monitor, clock, calls } = fixture();
    const chosen = adapter("chosen", 90);
    registry.registerForRole(chosen, Role.WORKER);
    registry.registerForRole(adapter("other-role", 99), Role.PRIMARY_CTO);
    registry.register(adapter("shared", 99));
    const binding = registry.capacityBindingForRole("claude", Role.WORKER)!;
    const reserveDemand = { criticalRoleInvocations: 0, expectedReviews: 0, inFlightRuns: 0,
      burnRatePercentPerHour: 0, roleDemand: { ceo: 0, cto: 0, reviewer: 0 },
      binding: { provider: binding.provider, role: binding.role, generation: binding.generation } };
    const capabilities = method === "refreshForWorkerFanout" ? ["worker"] : ["blind-review"];
    // The union's worker requirement is structural; critical gates use their own priority.
    const run = () => method === "refreshForWorkerFanout"
      ? monitor.refreshForWorkerFanout({ provider: "claude", role: Role.WORKER, capabilities, priority: "worker", reserveDemand })
      : monitor[method]({ provider: "claude", role: Role.WORKER, capabilities, priority: "critical" });
    const good = { provider: "claude", sensorHealth: "HEALTHY" as const, runtimeHealth: "HEALTHY" as const,
      observedAt: clock.nowIso(), source: "chosen", buckets: [{ id: "quota", remainingPercent: 90,
        resetAt: new Date(clock.now().getTime() + 3_600_000).toISOString(), capabilities }] };
    chosen.probeCapacity = async () => structuredClone(good);
    expect((await run()).allowed).toBe(true);
    for (const bad of [
      { ...good, buckets: [{ ...good.buckets[0]!, remainingPercent: null }] },
      { ...good, observedAt: new Date(clock.now().getTime() - 900_001).toISOString() },
      { ...good, buckets: [{ ...good.buckets[0]!, capabilities: ["unrelated"] }] },
      { ...good, runtimeHealth: "UNKNOWN" as const },
      { ...good, provider: "other" },
      { ...good, buckets: [] },
    ]) {
      chosen.probeCapacity = async () => structuredClone(bad);
      expect((await run()).allowed).toBe(false);
    }
    chosen.probeCapacity = async () => { throw new Error("collector failed"); };
    expect((await run()).allowed).toBe(false);
    expect(calls).toEqual([]); // Neither shared nor the other role is ever probed.
  });

  it.each(admissions)("%s refuses invalidation while the role probe is pending", async (method) => {
    const { registry, adapter, monitor, clock } = fixture();
    const chosen = adapter("chosen", 80);
    const baseProbe = chosen.probeCapacity.bind(chosen);
    chosen.probeCapacity = async () => ({ ...await baseProbe(), buckets: [{ id: "quota", remainingPercent: 80,
      resetAt: new Date(clock.now().getTime() + 3_600_000).toISOString(), capabilities: ["blind-review", "worker"] }] });
    registry.registerForRole(chosen, Role.PRIMARY_CTO);
    registry.registerForRole(adapter("other", 90), Role.BLIND_REVIEWER);
    const binding = registry.capacityBindingForRole("claude", Role.PRIMARY_CTO)!;
    const demand = { criticalRoleInvocations: 0, expectedReviews: 0, inFlightRuns: 0,
      burnRatePercentPerHour: 0, roleDemand: { ceo: 0, cto: 0, reviewer: 0 },
      binding: { provider: binding.provider, role: binding.role, generation: binding.generation } };
    const run = () => method === "refreshForWorkerFanout"
      ? monitor.refreshForWorkerFanout({ provider: "claude", role: Role.PRIMARY_CTO, capabilities: ["worker"], priority: "worker", reserveDemand: demand })
      : monitor[method]({ provider: "claude", role: Role.PRIMARY_CTO, capabilities: ["blind-review"], priority: "critical" });
    expect((await run()).allowed).toBe(true);
    await monitor.refreshForRole("claude", Role.BLIND_REVIEWER);
    const probe = chosen.probeCapacity.bind(chosen);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    chosen.probeCapacity = async () => { await gate; return probe(); };
    const pending = run();
    registry.invalidateCapacityForRole("claude", Role.PRIMARY_CTO);
    release();
    expect((await pending).allowed).toBe(false);
    expect(monitor.currentForRole("claude", Role.PRIMARY_CTO)).toBeNull();
    expect(monitor.currentForRole("claude", Role.BLIND_REVIEWER)?.source).toBe("other");
  });

  it("never uses a shared adapter for an explicitly missing role", async () => {
    const { registry, adapter, monitor, calls } = fixture();
    registry.register(adapter("shared", 99));
    expect((await monitor.refreshForDispatch({ provider: "claude", role: Role.PRIMARY_CTO, capabilities: ["cto"] })).allowed).toBe(false);
    expect(calls).toEqual([]);
  });

  it("rechecks TTL after the switch continuity await", async () => {
    const { registry, adapter, monitor, clock } = fixture();
    registry.registerForRole(adapter("cto", 80), Role.PRIMARY_CTO);
    monitor.attach({ providerFailureContinuity: { async evaluate() { clock.advance(900_001); } } });
    expect((await monitor.refreshForProviderSwitch({ provider: "claude", role: Role.PRIMARY_CTO, capabilities: ["cto"] })).allowed).toBe(false);
  });
  it("switch awaits continuity and refuses invalidation during that await", async () => {
    const { registry, adapter, monitor } = fixture();
    registry.registerForRole(adapter("cto", 80), Role.PRIMARY_CTO);
    let entered!: () => void;
    const entering = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    monitor.attach({ providerFailureContinuity: { async evaluate() {
      entered();
      await gate;
    } } });
    const pending = monitor.refreshForProviderSwitch({ provider: "claude", role: Role.PRIMARY_CTO, capabilities: ["cto"] });
    const reached = await Promise.race([entering.then(() => true), pending.then(() => false)]);
    registry.invalidateCapacityForRole("claude", Role.PRIMARY_CTO);
    release();
    expect((await pending).allowed).toBe(false);
    expect(reached).toBe(true);
  });
  it.each(["missing", "provider", "role", "generation"] as const)(
    "worker reserve refuses %s provenance even with favorable numbers", async (mismatch) => {
      const { registry, adapter, monitor, clock } = fixture();
      const worker = adapter("worker", 90);
      const probe = worker.probeCapacity.bind(worker);
      worker.probeCapacity = async () => ({ ...await probe(), buckets: [{ id: "quota",
        remainingPercent: 90, resetAt: new Date(clock.now().getTime() + 3_600_000).toISOString(), capabilities: ["worker"] }] });
      registry.registerForRole(worker, Role.WORKER);
      const binding = registry.capacityBindingForRole("claude", Role.WORKER)!;
      const demand = { criticalRoleInvocations: 0, expectedReviews: 0, inFlightRuns: 0,
        burnRatePercentPerHour: 0, roleDemand: { ceo: 0, cto: 0, reviewer: 0 },
        binding: { provider: binding.provider, role: binding.role, generation: binding.generation } };
      const target = { provider: "claude", role: Role.WORKER, capabilities: ["worker"],
        priority: "worker" as const, reserveDemand: demand };
      expect((await monitor.refreshForWorkerFanout(target)).allowed).toBe(true);
      const invalid = { ...demand, binding: mismatch === "missing" ? undefined : {
        provider: mismatch === "provider" ? "other" : binding.provider,
        role: mismatch === "role" ? Role.PRIMARY_CTO : binding.role,
        generation: mismatch === "generation" ? binding.generation + 1 : binding.generation,
      } };
      expect((await monitor.refreshForWorkerFanout({ ...target, reserveDemand: invalid })).allowed).toBe(false);
      registry.invalidateCapacityForRole("claude", Role.WORKER);
      expect((await monitor.refreshForWorkerFanout(target)).allowed).toBe(false);
      const fresh = registry.capacityBindingForRole("claude", Role.WORKER)!;
      expect((await monitor.refreshForWorkerFanout({ ...target, reserveDemand: { ...demand,
        binding: { provider: fresh.provider, role: fresh.role, generation: fresh.generation } } })).allowed).toBe(true);
    },
  );
  it.each(["refreshForDispatch", "refreshForBlindReview", "refreshForProviderSwitch"] as const)(
    "%s admits only the selected role's fresh capacity", async (method) => {
      const { registry, adapter, monitor, calls } = fixture();
      registry.registerForRole(adapter("cto", 80), Role.PRIMARY_CTO);
      registry.registerForRole(adapter("reviewer", 0), Role.BLIND_REVIEWER);
      const target = { provider: "claude", role: Role.PRIMARY_CTO,
        capabilities: ["blind-review"], priority: "critical" as const };
      expect((await monitor[method](target)).allowed).toBe(true);
      expect((await monitor[method]({ ...target, role: Role.BLIND_REVIEWER })).allowed).toBe(false);
      expect(calls).toEqual(["cto", "reviewer"]);
    },
  );
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
