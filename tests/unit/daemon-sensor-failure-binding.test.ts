import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { ControlPlane } from "../../src/app/control-plane.ts";
import { ManualClock } from "../../src/core/clock.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Daemon, type ContinuityReconcileReport } from "../../src/daemon/daemon.ts";
import { Role, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import type { CapacityReading } from "../../src/runtime/provider.ts";
import { RefreshTrigger } from "../../src/capacity/capacity-monitor.ts";
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

const makeIncumbent = (providers: "claude" | "claude-and-gpt" | "none" = "claude") => {
  const root = tempDir("acp-sensor-binding-");
  const clock = new ManualClock("2026-09-08T00:00:00.000Z");
  const claude = new ProductionTestAdapter(clock, "claude");
  const gpt = new ProductionTestAdapter(clock, "gpt");
  const cp = new ControlPlane({
    databasePath: join(root, "state.sqlite"),
    worktreeRoot: join(root, "worktrees"),
    capacityDir: join(root, "capacity"),
    secretsDir: join(root, "secrets"),
    clock,
    adapters: providers === "none" ? [] : providers === "claude-and-gpt" ? [claude, gpt] : [claude],
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
  return { cp, claude, daemon, unread, roleKey, clock, incumbent: bound.value };
};

describe("daemon incumbent capacity reconciliation", () => {
  it("#811: a READY CTO binding survives a failed capacity sensor", async () => {
    expectTypeOf<ContinuityReconcileReport["unresolved"][number]["reasonCode"]>().toEqualTypeOf<ReasonCode>();
    const { cp, daemon, roleKey, incumbent } = makeIncumbent("claude-and-gpt");

    const report = await daemon.reconcileContinuity("usage collector timed out");

    expect(cp.capacity.current("claude")).toMatchObject({
      sensorHealth: "ERROR",
      runtimeHealth: "HEALTHY",
      allocationAdmission: "SUSPENDED",
    });
    expect(cp.capacity.current("claude")?.buckets.every((bucket) => bucket.remainingPercent === null)).toBe(true);
    expect(cp.sessions.require(incumbent.sessionId).lifecycle).toBe(SessionLifecycle.READY);
    expect(cp.capacity.isRoutableFor(cp.capacity.current("gpt")!, "cto")).toBe(true);
    expect(report?.plan.assignments.find((assignment) => assignment.roleKey === roleKey)?.provider).toBe("gpt");
    expect(cp.bindings.active(roleKey), "READY incumbent must survive an unread capacity sensor").toEqual(incumbent);
    expect(report?.unresolved).toContainEqual({ roleKey, reasonCode: ReasonCode.CAPACITY_UNKNOWN_NOT_ROUTABLE });
    expect(report?.pausedRuns).toEqual([]);
    expect(report?.reassigned).toEqual([]);
    expect(cp.audit.byKind("CONTINUITY_RECONCILED").at(-1)?.evidence.unresolved).toMatchObject([
      { reasonCode: ReasonCode.CAPACITY_UNKNOWN_NOT_ROUTABLE },
    ]);
  });

  it("#811: an ERROR sensor with numeric buckets still preserves the READY incumbent", async () => {
    const { cp, claude, daemon, unread, roleKey, incumbent } = makeIncumbent("claude-and-gpt");
    claude.setCapacity({
      ...unread,
      buckets: [{ id: "rolling", remainingPercent: 95, resetAt: null, capabilities: ["cto"] }],
    });

    const report = await daemon.reconcileContinuity("sensor failed despite a numeric bucket");

    expect(report?.plan.assignments.find((assignment) => assignment.roleKey === roleKey)?.provider).toBe("gpt");
    expect(cp.bindings.active(roleKey)).toEqual(incumbent);
    expect(report?.unresolved).toContainEqual({ roleKey, reasonCode: ReasonCode.CAPACITY_UNKNOWN_NOT_ROUTABLE });
  });

  it.each([
    { name: "empty", buckets: [] },
    { name: "all unknown", buckets: [{ id: "rolling", remainingPercent: null, resetAt: null, capabilities: ["cto"] }] },
  ])("#811: a $name reading without ERROR preserves the READY incumbent", async ({ buckets }) => {
    const { cp, claude, daemon, unread, roleKey, incumbent } = makeIncumbent("claude-and-gpt");
    claude.setCapacity({ ...unread, sensorHealth: "HEALTHY", buckets, error: undefined });

    const report = await daemon.reconcileContinuity("no quota bucket was read");

    expect(cp.capacity.current("claude")).toMatchObject({ sensorHealth: "HEALTHY", allocationAdmission: "SUSPENDED" });
    expect(report?.plan.assignments.find((assignment) => assignment.roleKey === roleKey)?.provider).toBe("gpt");
    expect(cp.bindings.active(roleKey)).toEqual(incumbent);
    expect(report?.unresolved).toContainEqual({ roleKey, reasonCode: ReasonCode.CAPACITY_UNKNOWN_NOT_ROUTABLE });
  });

  it.each(["worker", "cto"])("#812 R2: an unknown applicable bucket preserves the READY incumbent (numeric %s bucket)", async (numericCapability) => {
    const { cp, claude, daemon, unread, roleKey, incumbent } = makeIncumbent("claude-and-gpt");
    claude.setCapacity({
      ...unread,
      sensorHealth: "HEALTHY",
      buckets: [
        { id: "rolling", remainingPercent: 95, resetAt: null, capabilities: [numericCapability] },
        { id: "weekly", remainingPercent: null, resetAt: null, capabilities: ["cto"] },
      ],
      error: undefined,
    });

    const report = await daemon.reconcileContinuity("one applicable quota window is unread");

    const capacity = cp.capacity.current("claude")!;
    expect(capacity).toMatchObject({ sensorHealth: "HEALTHY", allocationAdmission: "OPEN", unknownBuckets: ["weekly"] });
    expect(cp.capacity.isRoutableFor(capacity, "cto")).toBe(false);
    expect(cp.capacity.isRoutableFor(cp.capacity.current("gpt")!, "cto")).toBe(true);
    expect(report?.plan.assignments.find((assignment) => assignment.roleKey === roleKey)?.provider).toBe("gpt");
    expect(cp.sessions.require(incumbent.sessionId).lifecycle).toBe(SessionLifecycle.READY);
    expect(cp.bindings.active(roleKey), "READY incumbent must survive an unknown applicable capacity bucket").toEqual(incumbent);
    expect(report?.unresolved).toContainEqual({ roleKey, reasonCode: ReasonCode.CAPACITY_UNKNOWN_NOT_ROUTABLE });
    expect(report?.pausedRuns).toEqual([]);
    expect(report?.reassigned).toEqual([]);
  });

  it("#812 R2: an unrelated unknown bucket does not hide exhausted CTO quota", async () => {
    const { cp, claude, daemon, unread, roleKey } = makeIncumbent();
    claude.setCapacity({
      ...unread,
      sensorHealth: "HEALTHY",
      buckets: [
        { id: "rolling", remainingPercent: 0, resetAt: null, capabilities: ["cto"] },
        { id: "weekly", remainingPercent: null, resetAt: null, capabilities: ["worker"] },
      ],
      error: undefined,
    });

    const report = await daemon.reconcileContinuity("known exhausted CTO quota with unknown worker quota");

    expect(cp.capacity.current("claude")).toMatchObject({ sensorHealth: "HEALTHY", unknownBuckets: ["weekly"] });
    expect(cp.bindings.active(roleKey)).toBeNull();
    expect(report?.unresolved).toContainEqual({ roleKey, reasonCode: ReasonCode.COVERAGE_NONE });
  });

  it("#812 B1: exhausted worker quota does not evict an incumbent with unknown CTO quota", async () => {
    const { cp, claude, daemon, unread, roleKey, incumbent } = makeIncumbent("claude-and-gpt");
    claude.setCapacity({
      ...unread,
      sensorHealth: "HEALTHY",
      buckets: [
        { id: "rolling", remainingPercent: 0, resetAt: null, capabilities: ["worker"] },
        { id: "weekly", remainingPercent: null, resetAt: null, capabilities: ["cto"] },
      ],
      error: undefined,
    });

    const report = await daemon.reconcileContinuity("exhaustion applies only to worker quota");

    expect(report?.plan.assignments.find((assignment) => assignment.roleKey === roleKey)?.provider).toBe("gpt");
    expect(cp.bindings.active(roleKey), "worker exhaustion is not evidence against the CTO incumbent").toEqual(incumbent);
    expect(report?.unresolved).toContainEqual({ roleKey, reasonCode: ReasonCode.CAPACITY_UNKNOWN_NOT_ROUTABLE });
    expect(report?.reassigned).toEqual([]);
  });

  it("#812 B2: a READY managed provider without a snapshot reaches uncovered reconciliation", async () => {
    const { cp, daemon, roleKey, incumbent } = makeIncumbent("none");
    expect(cp.sessions.require(incumbent.sessionId).lifecycle).toBe(SessionLifecycle.READY);
    expect(cp.capacity.manages("claude")).toBe(true);
    expect(cp.capacity.current("claude")).toBeNull();

    await expect(daemon.reconcileContinuity("no registered adapter has produced a snapshot"))
      .resolves.toMatchObject({
        unresolved: [{ roleKey, reasonCode: ReasonCode.COVERAGE_NONE }],
        reassigned: [],
      });

    expect(cp.capacity.current("claude")).toBeNull();
    expect(cp.bindings.active(roleKey)).toBeNull();
  });

  it.each([0, 2])("#812 B1: observed exhaustion at %s percent dominates an unknown applicable window", async (remainingPercent) => {
    const { cp, claude, daemon, unread, roleKey } = makeIncumbent();
    claude.setCapacity({
      ...unread,
      sensorHealth: "HEALTHY",
      buckets: [
        { id: "rolling", remainingPercent, resetAt: null, capabilities: ["cto"] },
        { id: "weekly", remainingPercent: null, resetAt: null, capabilities: ["cto"] },
      ],
      error: undefined,
    });

    const report = await daemon.reconcileContinuity("observed exhaustion beside an unread window");

    const capacity = cp.capacity.current("claude")!;
    expect(capacity).toMatchObject({ sensorHealth: "HEALTHY", runtimeHealth: "HEALTHY", unknownBuckets: ["weekly"] });
    expect(cp.capacity.isRoutableFor(capacity, "cto")).toBe(false);
    expect(cp.bindings.active(roleKey), "observed CTO exhaustion must revoke the incumbent despite an unknown CTO window").toBeNull();
    expect(report?.unresolved).toContainEqual({ roleKey, reasonCode: ReasonCode.COVERAGE_NONE });
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

  /**
   * The production shape of the revocation this guard exists to prevent, now that the adapter can
   * express it. `/usage` timing out sets `sensorHealth: "ERROR"`, and the `--version` fallback
   * timing out used to set `runtimeHealth: "UNAVAILABLE"` — the one value this guard excludes — so
   * the incumbent was revoked by two timeouts rather than by any evidence. The adapter now reports
   * `"UNKNOWN"` for a probe that did not answer, and this pins what that buys: the binding
   * survives, and the reading is still refused for new work.
   *
   * This closes a gap #811 recorded against itself: *"Preserving on runtimeHealth: 'UNKNOWN' is
   * the intended reading for an established READY incumbent, and no test exercises it."*
   *
   * Measured on the live deployment 2026-09-16 — revoked 01:33:32.566Z, `FULL_COVERAGE` again at
   * 01:36:01.278Z, nothing restored, because `restorationNeeded` requires an active FALLBACK
   * binding and a revoked role has none.
   */
  it("#811: a runtime that did not answer preserves the READY incumbent", async () => {
    const { cp, claude, daemon, unread, roleKey, incumbent } = makeIncumbent();
    claude.setCapacity({ ...unread, runtimeHealth: "UNKNOWN" });

    const report = await daemon.reconcileContinuity("runtime probe did not answer");

    expect(cp.capacity.current("claude")?.runtimeHealth).toBe("UNKNOWN");
    expect(cp.capacity.isRoutableFor(cp.capacity.current("claude")!, "cto")).toBe(false);
    expect(cp.bindings.active(roleKey), "an unanswered probe is not evidence against the incumbent").toEqual(incumbent);
    expect(report?.unresolved).toContainEqual({ roleKey, reasonCode: ReasonCode.CAPACITY_UNKNOWN_NOT_ROUTABLE });
  });

  /**
   * #956: the incumbent check holds a role and was asking a provider-global question.
   *
   * Since #917 that row is not written again for a provider with role-scoped adapters, so the two
   * readings of one provider can disagree at the same instant — `computeCoveragePlan` reads
   * `currentForRole` and says covered while this check reads a row nothing has touched. The
   * disagreement is what this pins: with a routable role reading and an unroutable provider-global
   * one, the incumbent is covered and the pass records nothing against it.
   */
  it("#956: the incumbent is judged by its role's capacity, not the provider-global row", async () => {
    const { cp, claude, daemon, unread, roleKey, clock, incumbent } = makeIncumbent("claude-and-gpt");
    const routable = {
      ...unread,
      sensorHealth: "HEALTHY" as const,
      buckets: [{ id: "rolling", remainingPercent: 95, resetAt: null, capabilities: ["cto"] }],
      error: undefined,
    };
    // A provider-global row written while the provider was unscoped, then left to age out — which
    // is how the live row got into that state.
    claude.setCapacity(routable);
    await cp.capacity.refresh(RefreshTrigger.CONTINUITY_EVALUATION);
    cp.providers.registerForRole(claude, Role.PRIMARY_CTO);
    clock.advance(60 * 60 * 1000);
    claude.setCapacity({ ...routable, observedAt: clock.nowIso() });
    await cp.capacity.refreshForRole("claude", Role.PRIMARY_CTO);

    expect(cp.capacity.isRoutableFor(cp.capacity.currentForRole("claude", Role.PRIMARY_CTO)!, "cto")).toBe(true);

    const report = await daemon.reconcileContinuity("the role reading is the one that counts");

    expect(cp.bindings.active(roleKey)).toEqual(incumbent);
    expect(report?.unresolved).toEqual([]);
    expect(report?.reassigned).toEqual([]);
  });

  /**
   * #956: the measurement that decides coverage left no trace of any kind — not a snapshot row, not
   * a mirror file, not an audit event. Measured on the live deployment 2026-09-16: zero audit events
   * mentioning `claude` in the three hours after the generation carrying #917 started, against 140
   * `CAPACITY_PROBE` rows for `gpt`, while the coverage plan consulted `claude`'s role reading every
   * four minutes and moved the deployment into SURVIVAL.
   */
  it("#956: a role measurement leaves a record", async () => {
    const { cp, claude, daemon, unread, clock } = makeIncumbent("claude-and-gpt");
    claude.setCapacity({
      ...unread,
      sensorHealth: "HEALTHY" as const,
      buckets: [{ id: "rolling", remainingPercent: 95, resetAt: null, capabilities: ["cto"] }],
      error: undefined,
      observedAt: clock.nowIso(),
    });
    cp.providers.registerForRole(claude, Role.PRIMARY_CTO);

    await daemon.reconcileContinuity("a pass that measures a role");

    const recorded = cp.db.all<{ evidence_json: string }>(
      `SELECT evidence_json FROM audit_events WHERE kind = 'CAPACITY_ROLE_PROBE' ORDER BY event_id`,
    ).map((row) => JSON.parse(row.evidence_json) as Record<string, unknown>);

    const measured = recorded.find((entry) => entry["provider"] === "claude" && entry["role"] === Role.PRIMARY_CTO);
    expect(measured, "a role probe that answered must leave a record naming what it saw").toBeDefined();
    expect(measured).toMatchObject({
      provider: "claude",
      role: Role.PRIMARY_CTO,
      sensorHealth: "HEALTHY",
      allocationAdmission: "OPEN",
    });
    // The buckets travel with it: a reader asking "why did coverage change" needs the number, not
    // just the verdict derived from it.
    expect(measured?.["buckets"]).toEqual([
      { id: "rolling", remainingPercent: 95, resetAt: null },
    ]);
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
