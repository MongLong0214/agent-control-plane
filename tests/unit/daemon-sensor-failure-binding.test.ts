import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { ControlPlane } from "../../src/app/control-plane.ts";
import { ManualClock } from "../../src/core/clock.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Daemon } from "../../src/daemon/daemon.ts";
import { Role, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import type { CapacityReading } from "../../src/runtime/provider.ts";
import { ScriptedAdapter } from "../../src/runtime/scripted-adapter.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { fixtureManifest } from "../helpers/harness.ts";

class ProductionTestAdapter extends ScriptedAdapter {
  override readonly isProduction = true;
}

const planes: ControlPlane[] = [];
afterEach(() => {
  for (const cp of planes.splice(0)) cp.close();
  cleanupTempDirs();
});

const makeIncumbent = () => {
  const root = tempDir("acp-sensor-binding-");
  const clock = new ManualClock("2026-09-08T00:00:00.000Z");
  const claude = new ProductionTestAdapter(clock, "claude");
  const cp = new ControlPlane({
    databasePath: join(root, "state.sqlite"),
    worktreeRoot: join(root, "worktrees"),
    capacityDir: join(root, "capacity"),
    secretsDir: join(root, "secrets"),
    clock,
    adapters: [claude],
    capacity: { exhaustedPercent: 2 },
    allowTestEvidenceWriters: true,
  });
  planes.push(cp);
  const projectId = "sensor-binding";
  const manifest = fixtureManifest(projectId);
  const project = cp.projects.register({
    projectId,
    name: "Sensor binding regression",
    manifest,
    authorization: cp.manifestAuthorizationForTests(manifest),
  });
  if (!project.allowed) throw new Error(project.message);
  const session = cp.sessions.create({ provider: "claude", model: "opus" });
  const ready = cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "incumbent ready");
  if (!ready.allowed) throw new Error(ready.message);
  const bound = cp.bindings.bind({ role: Role.PRIMARY_CTO, projectId, sessionId: session.sessionId });
  if (!bound.allowed) throw new Error(bound.message);
  const roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId });
  const daemon = new Daemon(cp, { stateDir: join(root, "daemon") });
  const unread: CapacityReading = {
    provider: "claude",
    sensorHealth: "ERROR",
    runtimeHealth: "HEALTHY",
    observedAt: clock.nowIso(),
    source: "claude-usage",
    buckets: [],
    error: "non-interactive /usage did not finish in time",
    rawOutputDigest: `sha256:${createHash("sha256").update("").digest("hex")}`,
  };
  claude.setCapacity(unread);
  return { cp, claude, daemon, unread, roleKey, incumbent: bound.value };
};

describe("daemon incumbent capacity reconciliation", () => {
  it("#811: a READY CTO binding survives a failed capacity sensor", async () => {
    const { cp, daemon, roleKey, incumbent } = makeIncumbent();

    const report = await daemon.reconcileContinuity("usage collector timed out");

    expect(cp.capacity.current("claude")).toMatchObject({
      sensorHealth: "ERROR",
      runtimeHealth: "HEALTHY",
      allocationAdmission: "SUSPENDED",
    });
    expect(cp.capacity.current("claude")?.buckets.every((bucket) => bucket.remainingPercent === null)).toBe(true);
    expect(cp.sessions.require(incumbent.sessionId).lifecycle).toBe(SessionLifecycle.READY);
    expect(report?.plan.assignments.find((assignment) => assignment.roleKey === roleKey)?.provider).toBeNull();
    expect(cp.bindings.active(roleKey), "READY incumbent must survive an unread capacity sensor").toEqual(incumbent);
    expect(report?.unresolved).toContainEqual({ roleKey, reasonCode: "CAPACITY_SENSOR_FAILED" });
    expect(report?.pausedRuns).toEqual([]);
    expect(report?.reassigned).toEqual([]);
    expect(cp.audit.byKind("CONTINUITY_RECONCILED").at(-1)?.evidence.unresolved).toMatchObject([
      { reasonCode: "CAPACITY_SENSOR_FAILED" },
    ]);
  });

  it("#811: an ERROR sensor with numeric buckets still preserves the READY incumbent", async () => {
    const { cp, claude, daemon, unread, roleKey, incumbent } = makeIncumbent();
    claude.setCapacity({
      ...unread,
      buckets: [{ id: "rolling", remainingPercent: 95, resetAt: null, capabilities: ["cto"] }],
    });

    const report = await daemon.reconcileContinuity("sensor failed despite a numeric bucket");

    expect(cp.bindings.active(roleKey)).toEqual(incumbent);
    expect(report?.unresolved).toContainEqual({ roleKey, reasonCode: "CAPACITY_SENSOR_FAILED" });
  });

  it.each([
    { name: "empty", buckets: [] },
    { name: "all unknown", buckets: [{ id: "rolling", remainingPercent: null, resetAt: null, capabilities: ["cto"] }] },
  ])("#811: a $name reading without ERROR preserves the READY incumbent", async ({ buckets }) => {
    const { cp, claude, daemon, unread, roleKey, incumbent } = makeIncumbent();
    claude.setCapacity({ ...unread, sensorHealth: "HEALTHY", buckets, error: undefined });

    const report = await daemon.reconcileContinuity("no quota bucket was read");

    expect(cp.capacity.current("claude")).toMatchObject({ sensorHealth: "HEALTHY", allocationAdmission: "SUSPENDED" });
    expect(cp.bindings.active(roleKey)).toEqual(incumbent);
    expect(report?.unresolved).toContainEqual({ roleKey, reasonCode: "CAPACITY_SENSOR_FAILED" });
  });

  it.each([0, 2])("#811: genuine exhaustion at %s percent still revokes the binding", async (remainingPercent) => {
    const { cp, claude, daemon, unread, roleKey } = makeIncumbent();
    claude.setCapacity({
      ...unread,
      sensorHealth: "HEALTHY",
      buckets: [{ id: "rolling", remainingPercent, resetAt: null, capabilities: ["cto"] }],
      error: undefined,
    });

    const report = await daemon.reconcileContinuity("quota was measured exhausted");

    expect(cp.capacity.current("claude")).toMatchObject({ sensorHealth: "HEALTHY", advisoryState: "EXHAUSTED" });
    expect(cp.bindings.active(roleKey)).toBeNull();
    expect(report?.unresolved).toContainEqual({ roleKey, reasonCode: ReasonCode.COVERAGE_NONE });
  });

  it("#811: a non-READY session still loses its binding during a sensor failure", async () => {
    const { cp, daemon, roleKey, incumbent } = makeIncumbent();
    const stopped = cp.sessions.transition(incumbent.sessionId, SessionLifecycle.STOPPED, "runtime exited");
    if (!stopped.allowed) throw new Error(stopped.message);
    expect(cp.bindings.active(roleKey)).toEqual(incumbent);

    const report = await daemon.reconcileContinuity("session stopped during sensor failure");

    expect(cp.bindings.active(roleKey)).toBeNull();
    expect(report?.unresolved).toContainEqual({ roleKey, reasonCode: ReasonCode.COVERAGE_NONE });
  });

  it("#811: an UNAVAILABLE runtime still revokes a READY binding during a sensor failure", async () => {
    const { cp, claude, daemon, unread, roleKey, incumbent } = makeIncumbent();
    claude.setCapacity({ ...unread, runtimeHealth: "UNAVAILABLE" });

    const report = await daemon.reconcileContinuity("runtime observed unavailable");

    expect(cp.sessions.require(incumbent.sessionId).lifecycle).toBe(SessionLifecycle.READY);
    expect(cp.capacity.current("claude")?.runtimeHealth).toBe("UNAVAILABLE");
    expect(cp.bindings.active(roleKey)).toBeNull();
    expect(report?.unresolved).toContainEqual({ roleKey, reasonCode: ReasonCode.COVERAGE_NONE });
  });

  it("#811: an unread provider is still refused for a new allocation", async () => {
    const { cp, daemon, roleKey, incumbent } = makeIncumbent();
    await daemon.reconcileContinuity("keep the incumbent while quota is unreadable");
    expect(cp.bindings.active(roleKey)).toEqual(incumbent);

    const admitted = await cp.capacity.refreshForDispatch({
      provider: "claude", capabilities: ["cto"], priority: "critical",
    });

    expect(admitted).toMatchObject({ allowed: false, reasonCode: ReasonCode.CAPACITY_UNKNOWN_NOT_ROUTABLE });
    expect(cp.capacity.current("claude")?.allocationAdmission).toBe("SUSPENDED");
    expect(cp.capacity.isRoutableFor(cp.capacity.current("claude")!, "cto")).toBe(false);
  });

  it("#811: an unread provider is still refused as a failover target", async () => {
    const { cp, roleKey } = makeIncumbent();

    const failedOver = await cp.continuity.failover(roleKey, Role.PRIMARY_CTO, { projectId: "sensor-binding" }, "new target");

    expect(failedOver).toMatchObject({ allowed: false, reasonCode: ReasonCode.COVERAGE_NONE });
    expect(cp.sessions.live()).toHaveLength(1);
  });
});
