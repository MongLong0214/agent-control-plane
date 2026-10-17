import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { CAPACITY_DEFAULTS, CapacityMonitor, type DispatchCapacityTarget } from "../../src/capacity/capacity-monitor.ts";
import { ControlPlane } from "../../src/app/control-plane.ts";
import { ManualClock } from "../../src/core/clock.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Role } from "../../src/domain/types.ts";
import type { CapacityReading } from "../../src/runtime/provider.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { TestProductionAdapter } from "../helpers/production-adapter.ts";

afterAll(cleanupTempDirs);

/**
 * #1100 — the critical roles keep §14.3's stale grace, bounded: it is measured from the reading's
 * original observation time and ends at observedAt + staleGraceMs, and nothing extends it. Each
 * row reads the same observation the whole way through, the way a collector whose source has not
 * been re-read keeps answering it, so only the clock decides.
 */
const OBSERVED_AT = "2026-08-12T00:00:00.000Z";
const FIXED_END = new Date(new Date(OBSERVED_AT).getTime() + CAPACITY_DEFAULTS.staleGraceMs);
const INSIDE = new Date(new Date(OBSERVED_AT).getTime() + 10 * 60 * 1000);

const observation = (provider: string): CapacityReading => ({
  provider,
  sensorHealth: "HEALTHY",
  runtimeHealth: "HEALTHY",
  observedAt: OBSERVED_AT,
  source: "grace-fixture",
  buckets: [{
    id: "weekly",
    remainingPercent: 80,
    resetAt: "2026-08-13T00:00:00.000Z",
    capabilities: ["cto", "blind-review"],
  }],
});

const plane = () => {
  const root = tempDir("acp-capacity-grace-");
  const clock = new ManualClock(OBSERVED_AT);
  const gpt = new TestProductionAdapter(clock, "gpt");
  const cp = new ControlPlane({
    databasePath: join(root, "state.sqlite"),
    worktreeRoot: join(root, "worktrees"),
    capacityDir: join(root, "capacity"),
    secretsDir: join(root, "secrets"),
    clock,
    adapters: [gpt],
  });
  const claude = new TestProductionAdapter(clock, "claude");
  cp.providers.registerForRole(claude, Role.PRIMARY_CTO);
  cp.providers.registerForRole(claude, Role.BLIND_REVIEWER);
  gpt.setCapacity(observation("gpt"));
  claude.setCapacity(observation("claude"));
  // A monitor is a process's capacity state; a new one over the same database and registry is
  // what a restart leaves.
  const monitor = () => new CapacityMonitor(cp.db, clock, cp.audit, cp.providers, cp.telemetry);
  return { cp, clock, monitor };
};

type Trigger = "dispatch" | "blind review" | "provider switch";
type Path = "role-scoped claude" | "provider-global gpt";

const target = (trigger: Trigger, path: Path): DispatchCapacityTarget => {
  const role = trigger === "blind review" ? Role.BLIND_REVIEWER : Role.PRIMARY_CTO;
  return {
    provider: path === "role-scoped claude" ? "claude" : "gpt",
    ...(path === "role-scoped claude" ? { role } : {}),
    capabilities: [trigger === "blind review" ? "blind-review" : "cto"],
    priority: "critical",
  };
};

const admit = (monitor: CapacityMonitor, trigger: Trigger, path: Path) => {
  const exact = target(trigger, path);
  if (trigger === "dispatch") return monitor.refreshForDispatch(exact);
  if (trigger === "blind review") return monitor.refreshForBlindReview(exact);
  return monitor.refreshForProviderSwitch(exact);
};

const rows = (["dispatch", "blind review", "provider switch"] as const).flatMap((trigger) =>
  (["role-scoped claude", "provider-global gpt"] as const).map((path) => [trigger, path] as const));

describe("#1100: the critical-role stale grace ends at a fixed time that nothing extends", () => {
  it.each(rows)("%s on %s: a STALE reading inside the grace is admitted, up to the fixed end inclusive", async (trigger, path) => {
    const p = plane();
    try {
      const monitor = p.monitor();
      p.clock.set(INSIDE);
      const inside = await admit(monitor, trigger, path);
      expect(inside.reasonCode, inside.allowed ? "" : inside.message).toBe(ReasonCode.OK);
      const measured = path === "role-scoped claude"
        ? monitor.currentForRole("claude", target(trigger, path).role!)
        : monitor.current("gpt");
      expect(measured?.sensorHealth).toBe("STALE");
      // The window is the existing one, not a larger one: open at the end instant, shut 1 ms later.
      p.clock.set(FIXED_END);
      expect((await admit(monitor, trigger, path)).reasonCode).toBe(ReasonCode.OK);
    } finally {
      p.cp.close();
    }
  });

  it.each(rows)("%s on %s: after the fixed end the same reading is refused after a restart, a retry and a provider switch", async (trigger, path) => {
    const p = plane();
    try {
      const before = p.monitor();
      p.clock.set(INSIDE);
      expect((await admit(before, trigger, path)).reasonCode).toBe(ReasonCode.OK);
      p.clock.set(FIXED_END.getTime() + 1);

      const refused = async (monitor: CapacityMonitor) => {
        const decision = await admit(monitor, trigger, path);
        expect(decision.reasonCode, decision.allowed ? "admitted" : decision.message).toBe(ReasonCode.CAPACITY_UNKNOWN_NOT_ROUTABLE);
      };
      // Restart: a new process re-reads the same observation and measures it from its own time.
      const restarted = p.monitor();
      await refused(restarted);
      // Retry: asking again re-probes and re-judges; it does not reset anything.
      await refused(restarted);
      await refused(before);
      // Provider switch: a switch onto this target is itself refused, and does not reopen the grace
      // for the admission that follows it.
      const switched = await restarted.refreshForProviderSwitch(target("provider switch", path));
      expect(switched.reasonCode).toBe(ReasonCode.CAPACITY_UNKNOWN_NOT_ROUTABLE);
      await refused(restarted);
    } finally {
      p.cp.close();
    }
  });

  it.each(["role-scoped claude", "provider-global gpt"] as const)(
    "a provider switch on %s is judged after its continuity await, so the await cannot carry a reading past the fixed end",
    async (path) => {
      const p = plane();
      try {
        const monitor = p.monitor();
        p.clock.set(FIXED_END.getTime() - 1_000);
        // The switch re-evaluates continuity before it decides; that takes time, and here it takes
        // the reading across the fixed end.
        monitor.attach({ providerFailureContinuity: { evaluate: async () => { p.clock.advance(2_000); } } });
        const decision = await monitor.refreshForProviderSwitch(target("provider switch", path));
        expect(decision.reasonCode, decision.allowed ? "admitted" : decision.message).toBe(ReasonCode.CAPACITY_UNKNOWN_NOT_ROUTABLE);
      } finally {
        p.cp.close();
      }
    },
  );
});
