import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { ControlPlane } from "../../src/app/control-plane.ts";
import { ManualClock } from "../../src/core/clock.ts";
import { allow } from "../../src/core/errors.ts";
import { readProcessStartToken } from "../../src/core/process-argv.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { CONTINUITY_COVERAGE_REVOCATION_REASON } from "../../src/continuity/continuity-kernel.ts";
import {
  COVERAGE_REVOCATION_GRACE_MS,
  Daemon,
  recordedProcessIsRunning,
  OPERATOR_METHOD,
  type AuthenticatedOperatorPeer,
  type ContinuityReconcileReport,
} from "../../src/daemon/daemon.ts";
import type { Finding } from "../../src/doctor/doctor.ts";
import { ContinuityMode, ExecutionMode, Role, RunState, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import type { CapacityReading } from "../../src/runtime/provider.ts";
import { RefreshTrigger } from "../../src/capacity/capacity-monitor.ts";
import { ScriptedAdapter } from "../../src/runtime/scripted-adapter.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { fixtureManifest } from "../helpers/harness.ts";

class ProductionTestAdapter extends ScriptedAdapter {
  override readonly isProduction = true;
}

const OPERATOR_PEER: AuthenticatedOperatorPeer = {
  channel: "cli",
  peerId: "cli:fixture-operator",
  actor: "fixture-operator",
  incarnation: "incarnation-1",
};

const planes: ControlPlane[] = [];
afterEach(() => {
  for (const cp of planes.splice(0)) cp.close();
  cleanupTempDirs();
});

const makeIncumbent = (
  providers: "claude" | "claude-and-gpt" | "gpt" | "none" = "claude",
  identity?: { pid: number; token?: string },
  startAt = "2026-09-08T00:00:00.000Z",
) => {
  const root = tempDir("acp-sensor-binding-");
  const clock = new ManualClock(startAt);
  const claude = new ProductionTestAdapter(clock, "claude");
  const gpt = new ProductionTestAdapter(clock, "gpt");
  const cp = new ControlPlane({
    databasePath: join(root, "state.sqlite"),
    worktreeRoot: join(root, "worktrees"),
    capacityDir: join(root, "capacity"),
    secretsDir: join(root, "secrets"),
    clock,
    adapters: providers === "none"
      ? []
      : providers === "claude-and-gpt" ? [claude, gpt] : providers === "gpt" ? [gpt] : [claude],
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
  const session = cp.sessions.create({
    provider: "claude", model: "opus",
    // Without a token the registry derives the start the way the CTO launch and continuity
    // provisioning paths record it: `ps -o lstart=` text.
    ...(identity ? { osPid: identity.pid, ...(identity.token !== undefined ? { osStartedAt: identity.token } : {}) } : {}),
  });
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
  return { cp, claude, gpt, daemon, unread, roleKey, clock, incumbent: bound.value };
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
    const token = readProcessStartToken(process.pid);
    expect(token).toMatch(/^darwin-tv:\d+\.\d{6}$/);
    const { cp, daemon, roleKey, incumbent } = makeIncumbent("claude", { pid: process.pid, token: token! });
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

  /**
   * #954: that record carried the shape of the reading and not the reason for it.
   *
   * On this deployment `claude` is role-scoped, and `CapacityMonitor.refresh` excludes a
   * role-scoped provider even when a caller names it explicitly — an explicit id goes to
   * `ambiguous` and returns `unknownCapacity`. So the `CAPACITY_PROBE` row, the one place the
   * allowlisted `error` key carries a collector's sentence, is never written for `claude`. This
   * event is its only durable record, and the role snapshot it mirrors dies with the process.
   *
   * The sentence is used at the length a real versioned pin gives it, because `error` being
   * allowlisted is what lets it through `redact` instead of the 200-character refusal an unknown
   * key would face.
   */
  it("#954: a failed role probe records the collector's sentence, not only the shape of the reading", async () => {
    const { cp, claude, daemon, unread, clock } = makeIncumbent("claude-and-gpt");
    const pin = "/Users/acp/.local/share/claude/versions/2.1.233-20260921T044118/cli.js";
    const sentence =
      "non-interactive /usage never started: the operating system could not spawn the configured CLI at "
      + `${pin} (ENOENT: spawn ${pin} ENOENT)`;
    expect(sentence.length).toBeGreaterThan(200);
    claude.setCapacity({ ...unread, error: sentence, observedAt: clock.nowIso() });
    cp.providers.registerForRole(claude, Role.PRIMARY_CTO);

    await daemon.reconcileContinuity("a role probe whose CLI never started");

    // Read back from the stored row, never from the object handed to `AuditLog.record`: a refusal
    // happens inside `record`, so an input-side assertion cannot see one.
    const recorded = cp.db.all<{ evidence_json: string }>(
      `SELECT evidence_json FROM audit_events WHERE kind = 'CAPACITY_ROLE_PROBE' ORDER BY event_id`,
    ).map((row) => JSON.parse(row.evidence_json) as Record<string, unknown>);

    const measured = recorded.find((entry) => entry["provider"] === "claude" && entry["role"] === Role.PRIMARY_CTO);
    expect(measured, "a role probe that failed must leave a record naming why").toBeDefined();
    expect(measured?.["sensorHealth"]).toBe("ERROR");
    expect(measured?.["error"]).toBe(sentence);
    expect(measured?.["auditEvidenceRejected"]).toBeUndefined();
  });

  it("#954: a live native-identified READY CTO keeps its generation and outbox on a failed role sensor", async () => {
    const token = readProcessStartToken(process.pid);
    expect(token).toMatch(/^darwin-tv:\d+\.\d{6}$/);
    const { cp, claude, daemon, unread, roleKey, incumbent } = makeIncumbent("claude", { pid: process.pid, token: token! });
    cp.providers.registerForRole(claude, Role.PRIMARY_CTO);
    claude.setCapacity({ ...unread, runtimeHealth: "UNAVAILABLE" });
    const queued = cp.outbox.enqueue({
      idempotencyKey: "sensor-954-incumbent", roleKey,
      bindingGeneration: incumbent.bindingGeneration, targetSessionId: incumbent.sessionId,
      kind: "RUN_DISPATCH", payload: { projectId: "sensor-binding" },
    });
    if (!queued.allowed) throw new Error(queued.message);

    const report = await daemon.reconcileContinuity("failed role-scoped /usage and runtime probe");

    expect(cp.capacity.currentForRole("claude", Role.PRIMARY_CTO)).toMatchObject({
      sensorHealth: "ERROR", runtimeHealth: "UNAVAILABLE", allocationAdmission: "SUSPENDED", buckets: [],
    });
    expect(report?.plan.assignments.find((assignment) => assignment.roleKey === roleKey)?.provider).toBeNull();
    expect(cp.bindings.active(roleKey)).toEqual(incumbent);
    expect(cp.outbox.get(queued.value.messageId)).toMatchObject({
      bindingGeneration: incumbent.bindingGeneration, status: "PENDING",
    });
    expect(report?.unresolved).toContainEqual({ roleKey, reasonCode: ReasonCode.CAPACITY_UNKNOWN_NOT_ROUTABLE });
    expect(report?.reassigned).toEqual([]);
    expect(report?.pausedRuns).toEqual([]);
    expect(await cp.capacity.refreshForDispatch({ provider: "claude", capabilities: ["cto"], priority: "critical" }))
      .toMatchObject({ allowed: false, reasonCode: ReasonCode.CAPACITY_UNKNOWN_NOT_ROUTABLE });
  });

  it("#954: a healthy sensor with unknown CTO quota and unavailable runtime revokes a live native incumbent", async () => {
    const token = readProcessStartToken(process.pid);
    expect(token).toMatch(/^darwin-tv:\d+\.\d{6}$/);
    const { cp, claude, daemon, unread, roleKey, incumbent } = makeIncumbent("claude", {
      pid: process.pid, token: token!,
    });
    cp.providers.registerForRole(claude, Role.PRIMARY_CTO);
    claude.setCapacity({
      ...unread, sensorHealth: "HEALTHY", runtimeHealth: "UNAVAILABLE", error: undefined,
      buckets: [{ id: "weekly", remainingPercent: null, resetAt: null, capabilities: ["cto"] }],
    });

    const report = await daemon.reconcileContinuity("healthy quota sensor, unavailable runtime");

    expect(cp.sessions.require(incumbent.sessionId).lifecycle).toBe(SessionLifecycle.READY);
    expect(cp.capacity.currentForRole("claude", Role.PRIMARY_CTO)).toMatchObject({
      sensorHealth: "HEALTHY", runtimeHealth: "UNAVAILABLE", unknownBuckets: ["weekly"],
    });
    expect(cp.bindings.active(roleKey)).toBeNull();
    expect(report?.unresolved).toContainEqual({ roleKey, reasonCode: ReasonCode.COVERAGE_NONE });
  });

  it("#954: a reused PID with a different native start token cannot retain a failed-sensor binding", async () => {
    const liveToken = readProcessStartToken(process.pid);
    expect(liveToken).toMatch(/^darwin-tv:\d+\.\d{6}$/);
    const recordedToken = liveToken!.replace(/^darwin-tv:(\d+)/, (_, seconds: string) =>
      `darwin-tv:${Number(seconds) - 1}`);
    const { cp, claude, daemon, unread, roleKey } = makeIncumbent("claude", {
      pid: process.pid, token: recordedToken,
    });
    cp.providers.registerForRole(claude, Role.PRIMARY_CTO);
    claude.setCapacity({ ...unread, runtimeHealth: "UNAVAILABLE" });

    const report = await daemon.reconcileContinuity("old session PID was reused");

    expect(cp.bindings.active(roleKey)).toBeNull();
    expect(report?.unresolved).toContainEqual({ roleKey, reasonCode: ReasonCode.COVERAGE_NONE });
  });

  it("#954: fresh applicable numeric exhaustion revokes even with an unavailable runtime reading", async () => {
    const token = readProcessStartToken(process.pid);
    expect(token).toMatch(/^darwin-tv:\d+\.\d{6}$/);
    const { cp, claude, daemon, unread, roleKey } = makeIncumbent("claude", { pid: process.pid, token: token! });
    cp.providers.registerForRole(claude, Role.PRIMARY_CTO);
    claude.setCapacity({
      ...unread, runtimeHealth: "UNAVAILABLE",
      buckets: [{ id: "rolling", remainingPercent: 0, resetAt: null, capabilities: ["cto"] }],
    });

    const report = await daemon.reconcileContinuity("role quota measured exhausted");

    expect(cp.capacity.currentForRole("claude", Role.PRIMARY_CTO)?.buckets).toMatchObject([
      { remainingPercent: 0 },
    ]);
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

/**
 * #954 — a revoked binding has a way back, and coverage says so while it has not taken it.
 *
 * Measured on the live deployment: `BINDING_REVOKED "coverage plan cannot staff the bound role"` at
 * 01:33:32Z, coverage whole again 2m29s later with `restoration {restored: [], deferred: []}`, and
 * the role still unbound five days later. Two faults, one state. `restorationNeeded` asked
 * `bindings.active(roleKey)?.mode === "FALLBACK"`, which a role with no active binding can never
 * satisfy — so restoration ran for every role except the one that had lost its binding. And the
 * role left the plan on the tick that revoked it: `ProjectRegistry` derives `activity` from the
 * bound-CTO count, so revoking the only binding erased the evidence that the project wanted one,
 * and coverage then reported `FULL_COVERAGE` over a role it had stopped counting.
 *
 * These enter where production enters — `Daemon.reconcileContinuity`, the method the capacity tick
 * and the provider-failure callback both route through — and use the same fixture as the
 * revocations above, because the revocation is the state under test.
 */
describe("#954: a role continuity revoked is a role continuity owes", () => {
  const coverageReturns = (claude: ProductionTestAdapter, unread: CapacityReading) => {
    claude.setCapacity({
      ...unread,
      sensorHealth: "HEALTHY",
      runtimeHealth: "HEALTHY",
      buckets: [{ id: "rolling", remainingPercent: 90, resetAt: null, capabilities: ["cto", "ceo"] }],
      error: undefined,
    });
  };

  /**
   * The route continuity owns for a role it may staff itself. Attached in the tests that assert an
   * assignment row was *not* written: without these ports `provisionRoutableSession` fails closed
   * before any write, so the absence of the row would be the harness's doing rather than the
   * guard's, and the assertion could not fail.
   */
  const attachRoutablePorts = (cp: ControlPlane) => {
    cp.continuity.attach({
      readiness: { checkSession: async () => allow(ReasonCode.OK, undefined) },
      buzz: { connect: async (sessionId) => allow(ReasonCode.OK, `buzz:${sessionId}`) },
    });
  };

  const revokeForWantOfCoverage = async (
    fixture: ReturnType<typeof makeIncumbent>,
    reason = "runtime observed unavailable",
  ) => {
    fixture.claude.setCapacity({ ...fixture.unread, runtimeHealth: "UNAVAILABLE" });
    const report = await fixture.daemon.reconcileContinuity(reason);
    expect(fixture.cp.bindings.active(fixture.roleKey)).toBeNull();
    // The newest generation is what `continuityOwesBinding` reads, and a second episode leaves an
    // older row beside it, so this asks the same question that predicate asks.
    expect(
      fixture.cp.db.all<{ revoked_reason: string | null }>(
        `SELECT revoked_reason FROM assignments WHERE role_key = ? ORDER BY binding_generation DESC`,
        [fixture.roleKey],
      )[0],
    ).toEqual({ revoked_reason: CONTINUITY_COVERAGE_REVOCATION_REASON });
    return report;
  };

  it("does not report coverage whole while the role it revoked is unbound", async () => {
    const fixture = makeIncumbent();
    const { cp, claude, daemon, unread, roleKey } = fixture;
    await revokeForWantOfCoverage(fixture);

    coverageReturns(claude, unread);
    const returned = await daemon.reconcileContinuity("coverage returned two minutes later");

    // Coverage is genuinely back: nothing is uncovered and the plan staffs the role it revoked.
    expect(returned?.plan.uncovered).toEqual([]);
    expect(returned?.plan.assignments).toContainEqual({ roleKey, provider: "claude", reason: "preferred" });
    // And the status still does not read whole, because nobody holds the role.
    expect(returned?.plan.restorationPending).toEqual([roleKey]);
    expect(returned?.plan.outcome).toBe("PARTIAL_COVERAGE");
    expect(returned?.plan.mode).toBe(ContinuityMode.DEGRADED);
    expect(cp.continuity.mode()).toBe(ContinuityMode.DEGRADED);
    // The durable row, which is what a restarted reader sees.
    expect(cp.db.get(`SELECT mode, reason_code FROM continuity_state WHERE id = 1`))
      .toEqual({ mode: ContinuityMode.DEGRADED, reason_code: "PARTIAL_COVERAGE" });
    const reconciled = cp.audit.byKind("CONTINUITY_RECONCILED").at(-1);
    expect(reconciled?.reasonCode).toBe(ReasonCode.COVERAGE_PARTIAL);
    expect(reconciled?.evidence.restorationPending).toEqual([roleKey]);

    // The operator-facing half. This is the one state that reaches PARTIAL_COVERAGE with nothing
    // uncovered, so a finding that carries only `uncovered` names nothing at all.
    const coverage = (await cp.doctor.run("system")).findings
      .find((finding) => finding.code === "ROLE_COVERAGE_PARTIAL_COVERAGE");
    expect(coverage).toMatchObject({ severity: "WARN", blocking: false });
    expect(coverage?.observedEvidence).toMatchObject({ uncovered: [], restorationPending: [roleKey] });
  });

  it("records the pending need once, and then costs no more than a tick with nothing pending", async () => {
    const fixture = makeIncumbent();
    const { cp, claude, daemon, unread, roleKey } = fixture;
    await revokeForWantOfCoverage(fixture);
    coverageReturns(claude, unread);
    const refresh = vi.spyOn(cp.capacity, "refresh");

    const recording = await daemon.reconcileContinuity("coverage returned");
    expect(recording?.restorationDeferred).toEqual([{ roleKey, reasonCode: ReasonCode.BINDING_REVOKED }]);
    const afterRecording = refresh.mock.calls.length;

    for (const tick of ["one minute later", "two minutes later"]) {
      const report = await daemon.reconcileContinuity(tick);
      // The state stays visible on every tick. It is the record, and the pass that would re-derive
      // it, that must not repeat.
      expect(report?.plan.restorationPending, tick).toEqual([roleKey]);
      expect(report?.plan.outcome, tick).toBe("PARTIAL_COVERAGE");
      expect(report?.restorationDeferred, tick).toEqual([]);
    }
    const pendingTicks = refresh.mock.calls.length - afterRecording;

    const awaiting = cp.audit.byKind("CONTINUITY_RESTORE_AWAITS_CLAIM");
    expect(awaiting).toHaveLength(1);
    expect(awaiting[0]).toMatchObject({ roleKey, reasonCode: ReasonCode.BINDING_REVOKED });
    expect(awaiting[0]?.evidence.provider).toBe("claude");
    // The per-call restore row does not repeat either: a minute-by-minute row saying the same
    // thing buries the ledger the one row above belongs to.
    expect(cp.audit.byKind("CONTINUITY_RESTORE")).toHaveLength(1);

    // Each coverage evaluation is a full provider probe round, and a role can await a claim for
    // days. Two ticks of waiting must therefore cost exactly what two ticks of a deployment with
    // nothing pending cost — measured against a control rather than asserted as a number, because
    // the per-tick baseline belongs to the reconcile loop and not to this change.
    const control = makeIncumbent();
    coverageReturns(control.claude, control.unread);
    const controlRefresh = vi.spyOn(control.cp.capacity, "refresh");
    for (const tick of ["one minute later", "two minutes later"]) {
      const report = await control.daemon.reconcileContinuity(tick);
      expect(report?.plan.restorationPending, tick).toEqual([]);
      expect(control.cp.bindings.active(control.roleKey), tick).not.toBeNull();
    }
    expect(pendingTicks).toBe(controlRefresh.mock.calls.length);
  });

  it("answers a second revocation instead of counting it as the one already recorded", async () => {
    const fixture = makeIncumbent();
    const { cp, claude, daemon, unread, roleKey } = fixture;
    await revokeForWantOfCoverage(fixture);
    coverageReturns(claude, unread);
    await daemon.reconcileContinuity("coverage returned");
    expect(cp.audit.byKind("CONTINUITY_RESTORE_AWAITS_CLAIM")).toHaveLength(1);

    // A claim ends the first episode, and the role is revoked a second time for the same cause.
    const claimed = cp.sessions.create({ provider: "claude", model: "opus" });
    expect(cp.sessions.transition(claimed.sessionId, SessionLifecycle.READY, "claimed").allowed).toBe(true);
    expect(cp.bindings.bind({ role: Role.PRIMARY_CTO, projectId: "sensor-binding", sessionId: claimed.sessionId }).allowed)
      .toBe(true);
    await revokeForWantOfCoverage(fixture, "the runtime went away again");
    coverageReturns(claude, unread);

    const report = await daemon.reconcileContinuity("coverage returned a second time");

    expect(report?.restorationDeferred).toEqual([{ roleKey, reasonCode: ReasonCode.BINDING_REVOKED }]);
    expect(cp.audit.byKind("CONTINUITY_RESTORE_AWAITS_CLAIM")).toHaveLength(2);
  });

  it("restores nothing by writing an assignment row the claim path is the only creator of", async () => {
    const fixture = makeIncumbent();
    const { cp, claude, daemon, unread, roleKey } = fixture;
    await revokeForWantOfCoverage(fixture);
    coverageReturns(claude, unread);
    attachRoutablePorts(cp);
    const sessionsBefore = cp.sessions.live().length;

    await daemon.reconcileContinuity("coverage returned");

    // The absence of the row is the assertion: restoration may not mint what a claim creates.
    expect(cp.db.all(`SELECT status, binding_generation FROM assignments WHERE role_key = ?`, [roleKey]))
      .toEqual([{ status: "REVOKED", binding_generation: 1 }]);
    expect(cp.bindings.active(roleKey)).toBeNull();
    // Nor does it constitute a session for a binding it is not going to write.
    expect(cp.sessions.live()).toHaveLength(sessionsBefore);
    // And the audit says why, rather than leaving the absence unexplained.
    expect(cp.audit.byKind("CONTINUITY_RESTORE_AWAITS_CLAIM").at(-1)?.evidence.reason)
      .toContain("created by a claim, not by restoration");
  });

  it("refuses a failover that would create the binding a claim is owed", async () => {
    const fixture = makeIncumbent();
    const { cp, claude, unread, roleKey } = fixture;
    await revokeForWantOfCoverage(fixture);
    coverageReturns(claude, unread);
    // Without the ports provisioning fails closed before any write, and the refusal asserted below
    // would be the harness's rather than the guard's.
    attachRoutablePorts(cp);
    const sessionsBefore = cp.sessions.live().length;

    // `failover` is public, and the plan now staffs the role, so nothing but a guard on the method
    // itself stands between this call and a fresh assignment row (review R1015-1).
    const decision = await cp.continuity.failover(roleKey, Role.PRIMARY_CTO, { projectId: "sensor-binding" }, "direct failover");

    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.BINDING_REVOKED);
    expect(cp.db.all(`SELECT status, binding_generation FROM assignments WHERE role_key = ?`, [roleKey]))
      .toEqual([{ status: "REVOKED", binding_generation: 1 }]);
    expect(cp.bindings.active(roleKey)).toBeNull();
    expect(cp.sessions.live()).toHaveLength(sessionsBefore);
  });

  it("records the claim need while another role's reading is unresolved", async () => {
    const fixture = makeIncumbent("claude-and-gpt");
    const { cp, claude, daemon, unread, roleKey, gpt } = fixture;
    // A second bound role on a provider whose sensor failed: the daemon keeps it and reports it
    // unresolved on every pass for as long as the sensor stays down.
    gpt.setCapacity({ ...unread, provider: "gpt", source: "gpt-usage" });
    const ceoSession = cp.sessions.create({ provider: "gpt", model: "ceo" });
    expect(cp.sessions.transition(ceoSession.sessionId, SessionLifecycle.READY, "ceo ready").allowed).toBe(true);
    expect(cp.bindings.bind({ roleKey: roleKeyFor(Role.CEO), role: Role.CEO, sessionId: ceoSession.sessionId }).allowed)
      .toBe(true);
    await revokeForWantOfCoverage(fixture);
    coverageReturns(claude, unread);

    const report = await daemon.reconcileContinuity("coverage returned for the revoked role only");

    // The pass is not clean, and that is the precondition: the other role is unresolved.
    expect(report?.unresolved).toContainEqual({
      roleKey: roleKeyFor(Role.CEO),
      reasonCode: ReasonCode.CAPACITY_UNKNOWN_NOT_ROUTABLE,
    });
    expect(report?.plan.restorationPending).toEqual([roleKey]);
    // And the revoked role's need is on the ledger anyway: a sensor on another provider says
    // nothing about whether this role waits on a claim (review R1015-2).
    const awaiting = cp.audit.byKind("CONTINUITY_RESTORE_AWAITS_CLAIM");
    expect(awaiting).toHaveLength(1);
    expect(awaiting[0]).toMatchObject({ roleKey, reasonCode: ReasonCode.BINDING_REVOKED });
    expect(report?.restorationDeferred).toEqual([{ roleKey, reasonCode: ReasonCode.BINDING_REVOKED }]);
    // Still no assignment row: recording the need is all this path does.
    expect(cp.bindings.active(roleKey)).toBeNull();

    // Once per revocation here too.
    const next = await daemon.reconcileContinuity("a minute later");
    expect(next?.restorationDeferred).toEqual([]);
    expect(cp.audit.byKind("CONTINUITY_RESTORE_AWAITS_CLAIM")).toHaveLength(1);
  });

  it("does not record a claim need from a plan a later probe in the same pass contradicted", async () => {
    const fixture = makeIncumbent("claude-and-gpt");
    const { cp, claude, daemon, unread, roleKey, gpt } = fixture;
    // The same two-role start as the case above: the CEO on gpt, whose sensor failed, so the CTO
    // has nowhere to fail over to and is revoked.
    gpt.setCapacity({ ...unread, provider: "gpt", source: "gpt-usage" });
    const ceoSession = cp.sessions.create({ provider: "gpt", model: "ceo" });
    expect(cp.sessions.transition(ceoSession.sessionId, SessionLifecycle.READY, "ceo ready").allowed).toBe(true);
    expect(cp.bindings.bind({ roleKey: roleKeyFor(Role.CEO), role: Role.CEO, sessionId: ceoSession.sessionId }).allowed)
      .toBe(true);
    await revokeForWantOfCoverage(fixture);
    attachRoutablePorts(cp);

    // Claude is back when the pass evaluates, and gpt's runtime is down, so the CEO must fail over
    // to claude. Claude goes down again between that evaluation and failover's own probe of it.
    coverageReturns(claude, unread);
    gpt.setCapacity({ ...unread, provider: "gpt", source: "gpt-usage", sensorHealth: "HEALTHY", runtimeHealth: "UNAVAILABLE" });
    const failover = cp.continuity.failover.bind(cp.continuity);
    const failoverSpy = vi.spyOn(cp.continuity, "failover").mockImplementation(async (...args) => {
      claude.setCapacity({ ...unread, runtimeHealth: "UNAVAILABLE" });
      return failover(...args);
    });

    const report = await daemon.reconcileContinuity("claude flaps inside one pass");

    // Preconditions: failover ran and left the CEO unresolved, and the pass's first plan still said
    // claude could staff the revoked role — the plan the claim-need record must not be taken from.
    expect(failoverSpy).toHaveBeenCalled();
    expect(report?.unresolved.map((entry) => entry.roleKey)).toContain(roleKeyFor(Role.CEO));
    expect(report?.plan.restorationPending).toEqual([roleKey]);
    expect(cp.capacity.isRoutableFor(cp.capacity.current("claude")!, "cto")).toBe(false);
    // Claude is down now, so no claim can staff this role: nothing may say the plan can (R1015-5).
    expect(report?.restorationDeferred).toEqual([]);
    expect(cp.audit.byKind("CONTINUITY_RESTORE_AWAITS_CLAIM")).toHaveLength(0);

    // The record is once per revocation, so a misdated one would have been the only one. A genuine
    // recovery must still be able to write it.
    failoverSpy.mockRestore();
    coverageReturns(claude, unread);
    const recovered = await daemon.reconcileContinuity("claude is back for good");
    // The CEO is owed one too: its failover in the flap pass found no provider, so it was revoked
    // for want of coverage like the CTO before it.
    expect(recovered?.restorationDeferred).toEqual([
      { roleKey: roleKeyFor(Role.CEO), reasonCode: ReasonCode.BINDING_REVOKED },
      { roleKey, reasonCode: ReasonCode.BINDING_REVOKED },
    ]);
    expect(cp.audit.byKind("CONTINUITY_RESTORE_AWAITS_CLAIM").filter((event) => event.roleKey === roleKey))
      .toHaveLength(1);
    expect(cp.bindings.active(roleKey)).toBeNull();
  });

  it("restore records a claim need only after its own provisioning reads capacity", async () => {
    const { cp, claude, gpt, unread, roleKey } = makeIncumbent("claude-and-gpt");
    const owedProjectId = "second-project";
    const owedRoleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId: owedProjectId });
    // One CTO is a fallback holder. Continuity revoked a second project's CTO and owes it a claim.
    expect(cp.bindings.revoke(roleKey, "test: move CTO to fallback").allowed).toBe(true);
    const ctoSession = cp.sessions.create({ provider: "gpt", model: "cto" });
    expect(cp.sessions.transition(ctoSession.sessionId, SessionLifecycle.READY, "fallback ready").allowed).toBe(true);
    expect(cp.bindings.bind({ role: Role.PRIMARY_CTO, projectId: "sensor-binding", sessionId: ctoSession.sessionId, mode: "FALLBACK" }).allowed)
      .toBe(true);
    // Keep this project's role in the active-work sweep, ahead of the second project's owed role.
    expect(cp.runs.create({ projectId: "sensor-binding", executionMode: ExecutionMode.SIMPLE,
      contract: { goal: "restore CTO", why: "exercise restoration", scope: [], nonGoals: [],
        acceptance: ["done"], priority: "NORMAL", humanGate: [], references: [] } }).allowed).toBe(true);
    const owedManifest = fixtureManifest(owedProjectId);
    expect(cp.projects.register({ projectId: owedProjectId, name: owedProjectId, manifest: owedManifest,
      authorization: cp.manifestAuthorizationForTests(owedManifest) }).allowed).toBe(true);
    const owedSession = cp.sessions.create({ provider: "gpt", model: "cto" });
    expect(cp.sessions.transition(owedSession.sessionId, SessionLifecycle.READY, "second CTO ready").allowed).toBe(true);
    expect(cp.bindings.bind({ role: Role.PRIMARY_CTO, projectId: owedProjectId, sessionId: owedSession.sessionId }).allowed)
      .toBe(true);
    expect(cp.bindings.revoke(owedRoleKey, CONTINUITY_COVERAGE_REVOCATION_REASON).allowed).toBe(true);
    coverageReturns(claude, unread);
    gpt.setCapacity({ ...unread, provider: "gpt", source: "gpt-usage", sensorHealth: "HEALTHY", runtimeHealth: "UNAVAILABLE", error: undefined,
      buckets: [{ id: "rolling", remainingPercent: 90, resetAt: null, capabilities: ["cto", "ceo"] }] });
    attachRoutablePorts(cp);

    // Both assignments initially choose Claude. CTO provisioning fails, and its refresh records
    // Claude unavailable before restore reaches the unbound second CTO assignment.
    const start = vi.spyOn(claude, "startSession").mockImplementationOnce(async () => {
      claude.setCapacity({ ...unread, runtimeHealth: "UNAVAILABLE" });
      throw new Error("Claude stopped during restoration");
    });
    const first = await cp.continuity.restore();
    expect(start).toHaveBeenCalledOnce();
    expect(cp.capacity.isRoutableFor(cp.capacity.current("claude")!, "cto")).toBe(false);
    expect(first.deferred).not.toContainEqual({ roleKey: owedRoleKey, reasonCode: ReasonCode.BINDING_REVOKED });
    expect(cp.audit.byKind("CONTINUITY_RESTORE_AWAITS_CLAIM").filter((event) => event.roleKey === owedRoleKey))
      .toHaveLength(0);

    // Once Claude really recovers, a later pass records the second CTO's need once for this revocation.
    coverageReturns(claude, unread);
    const recovered = await cp.continuity.restore();
    expect(recovered.deferred).toContainEqual({ roleKey: owedRoleKey, reasonCode: ReasonCode.BINDING_REVOKED });
    const waitingAgain = await cp.continuity.restore();
    expect(waitingAgain.deferred).toContainEqual({ roleKey: owedRoleKey, reasonCode: ReasonCode.BINDING_REVOKED });
    expect(cp.audit.byKind("CONTINUITY_RESTORE_AWAITS_CLAIM").filter((event) => event.roleKey === owedRoleKey))
      .toHaveLength(1);
  });

  it("rewrites the durable reason when the outcome changes and the mode does not", async () => {
    // A fallback holder keeps the mode DEGRADED while coverage is whole: claude's sensor is unread,
    // so the plan staffs the role from gpt.
    const { cp, roleKey } = makeIncumbent("claude-and-gpt");
    const whole = await cp.continuity.evaluate("fallback staffs the role");
    expect({ outcome: whole.outcome, mode: whole.mode })
      .toEqual({ outcome: "FULL_COVERAGE", mode: ContinuityMode.DEGRADED });
    expect(cp.db.get(`SELECT mode, reason_code FROM continuity_state WHERE id = 1`))
      .toEqual({ mode: ContinuityMode.DEGRADED, reason_code: "FULL_COVERAGE" });

    // The row the daemon's revocation for want of coverage writes; the role is now owed a claim.
    expect(cp.bindings.revoke(roleKey, CONTINUITY_COVERAGE_REVOCATION_REASON).allowed).toBe(true);
    const pending = await cp.continuity.evaluate("the role lost its binding");

    expect({ outcome: pending.outcome, mode: pending.mode, restorationPending: pending.restorationPending })
      .toEqual({ outcome: "PARTIAL_COVERAGE", mode: ContinuityMode.DEGRADED, restorationPending: [roleKey] });
    // Same mode, different outcome: the one durable row must not go on saying FULL (review R1015-3).
    expect(cp.db.get(`SELECT mode, reason_code FROM continuity_state WHERE id = 1`))
      .toEqual({ mode: ContinuityMode.DEGRADED, reason_code: "PARTIAL_COVERAGE" });
  });

  it("does not send an operator to a claim for a role no provider can staff yet", async () => {
    const fixture = makeIncumbent();
    const { cp, daemon, roleKey } = fixture;
    await revokeForWantOfCoverage(fixture);

    // Coverage has not returned. The role is owed a binding, but what it waits on is a provider.
    const still = await daemon.reconcileContinuity("the provider is still down");
    // The unbound CEO is a required role too, so `uncovered` holds more than this role.
    expect(still?.plan.uncovered).toContain(roleKey);
    expect(still?.plan.restorationPending).toEqual([]);

    const coverage = (await cp.doctor.run("system")).findings
      .find((finding) => finding.code.startsWith("ROLE_COVERAGE_"));
    // The role stays named in the evidence, by the field that says no provider can staff it.
    expect((coverage?.observedEvidence as { uncovered?: string[] } | undefined)?.uncovered).toContain(roleKey);
    expect(coverage?.observedEvidence).toMatchObject({ restorationPending: [] });
    expect(coverage?.recommendedAction).not.toMatch(/waits on a claim/);
  });

  it("reads whole again once the role is bound, and stops reporting a need", async () => {
    const fixture = makeIncumbent();
    const { cp, claude, daemon, unread, roleKey } = fixture;
    await revokeForWantOfCoverage(fixture);
    coverageReturns(claude, unread);
    await daemon.reconcileContinuity("coverage returned");

    // What the claim socket does, at the only boundary this test can stand in for it: a binding
    // exists for the role again.
    const claimed = cp.sessions.create({ provider: "claude", model: "opus" });
    expect(cp.sessions.transition(claimed.sessionId, SessionLifecycle.READY, "claimed").allowed).toBe(true);
    expect(cp.bindings.bind({ role: Role.PRIMARY_CTO, projectId: "sensor-binding", sessionId: claimed.sessionId }).allowed)
      .toBe(true);

    const report = await daemon.reconcileContinuity("the role was claimed");

    expect(report?.plan.restorationPending).toEqual([]);
    expect(report?.plan.outcome).toBe("FULL_COVERAGE");
    expect(cp.bindings.active(roleKey)?.sessionId).toBe(claimed.sessionId);
    expect(cp.audit.byKind("CONTINUITY_RECONCILED").at(-1)?.reasonCode).toBe(ReasonCode.OK);
  });

  it("still restores a role a fallback provider holds, through the path continuity already owns", async () => {
    const { cp, claude, daemon, unread, roleKey, incumbent } = makeIncumbent("claude-and-gpt");
    // The state the old predicate was written for, kept green: an acting fallback holder while the
    // preferred provider is healthy again.
    coverageReturns(claude, unread);
    expect(cp.bindings.revoke(roleKey, "the incumbent is replaced by a fallback holder").allowed).toBe(true);
    const fallback = cp.sessions.create({ provider: "gpt", model: "cto" });
    expect(cp.sessions.transition(fallback.sessionId, SessionLifecycle.READY, "fallback ready").allowed).toBe(true);
    expect(cp.bindings.bind({
      role: Role.PRIMARY_CTO, projectId: "sensor-binding", sessionId: fallback.sessionId, mode: "FALLBACK",
    }).allowed).toBe(true);
    attachRoutablePorts(cp);

    const report = await daemon.reconcileContinuity("the preferred provider recovered");

    // A revocation this test performed for its own reason is not a continuity debt.
    expect(report?.plan.restorationPending).toEqual([]);
    expect(report?.restored).toEqual([roleKey]);
    const active = cp.bindings.active(roleKey);
    expect(active?.mode).toBe("PREFERRED");
    expect(active?.sessionId).not.toBe(fallback.sessionId);
    expect(active?.sessionId).not.toBe(incumbent.sessionId);
    expect(cp.sessions.require(active!.sessionId).provider).toBe("claude");
  });

  it("names the role that waits on a claim in the doctor finding an operator's DOCTOR_RUN returns", async () => {
    const fixture = makeIncumbent();
    const { cp, claude, daemon, unread, roleKey } = fixture;
    // The operator door refuses while the single-instance lock is not held, and only `start` takes
    // it. A start is admitted only by a doctor that is not ERROR, so the daemon starts over a
    // healthy reading and a gate credential, and the revocation happens after it is running.
    cp.credentials.install({ token: "test-token", creatorIdentity: "acme-bot" });
    coverageReturns(claude, unread);
    const started = await daemon.start();
    expect(started.allowed, JSON.stringify(started)).toBe(true);
    try {
      await revokeForWantOfCoverage(fixture);
      coverageReturns(claude, unread);
      await daemon.reconcileContinuity("coverage returned two minutes later");

      const response = await daemon.handleOperatorRequest(
        { requestId: "req-954-doctor-run", method: OPERATOR_METHOD.DOCTOR_RUN, params: { scope: "system" } },
        OPERATOR_PEER,
      );
      expect(response.allowed).toBe(true);
      const findings = (response as { value: { findings: Finding[] } }).value.findings;
      const coverage = findings.find((finding) => finding.code.startsWith("ROLE_COVERAGE_"));

      // The existing finding, not a new code: nothing is uncovered, so `uncovered` names nothing and
      // the role has to be named by the field that carries it.
      expect(coverage).toMatchObject({ code: "ROLE_COVERAGE_PARTIAL_COVERAGE", severity: "WARN", blocking: false });
      expect(coverage?.observedEvidence).toMatchObject({ uncovered: [], restorationPending: [roleKey] });
      // And the sentence an operator reads names the role and sends them to a claim. `action` alone
      // is PAUSE_NEW_WORK, a word about providers, which no provider change would ever satisfy.
      expect(coverage?.recommendedAction).toContain(roleKey);
      expect(coverage?.recommendedAction).toMatch(/waits on a claim, not on a provider/);
    } finally {
      await daemon.stop();
    }
  });
});

/**
 * #954 (A) — a momentary coverage gap does not revoke a live incumbent.
 *
 * The revocation is durable and only a claim undoes it, so every momentary gap used to become a
 * human action: measured live, coverage was whole again 2m29s after the revocation it caused. An
 * incumbent whose exact process is still running now keeps its binding, and its work keeps running,
 * for `COVERAGE_REVOCATION_GRACE_MS`; the work is paused and the binding lost only if the role is
 * still unstaffable when the window ends. The quota reading here is healthy and exhausted, the gen11 shape
 * (weekly 1%, runtime HEALTHY), so the only thing wrong is coverage.
 */
describe("#954: a live incumbent keeps its binding through a momentary coverage gap", () => {
  const liveIncumbent = () => {
    const token = readProcessStartToken(process.pid);
    expect(token).toMatch(/^darwin-tv:\d+\.\d{6}$/);
    const fixture = makeIncumbent("claude", { pid: process.pid, token: token! });
    fixture.cp.providers.registerForRole(fixture.claude, Role.PRIMARY_CTO);
    return fixture;
  };
  const quota = (fixture: ReturnType<typeof makeIncumbent>, remainingPercent: number) => {
    fixture.claude.setCapacity({
      ...fixture.unread,
      sensorHealth: "HEALTHY",
      runtimeHealth: "HEALTHY",
      error: undefined,
      observedAt: fixture.clock.nowIso(),
      buckets: [{ id: "weekly", remainingPercent, resetAt: null, capabilities: ["cto", "ceo"] }],
    });
  };
  const kinds = (fixture: ReturnType<typeof makeIncumbent>, kind: string) =>
    fixture.cp.db.all<{ n: number }>(
      `SELECT COUNT(*) AS n FROM audit_events WHERE kind = ? AND role_key = ?`,
      [kind, fixture.roleKey],
    )[0]?.n;

  it("keeps the same generation when coverage returns inside the window, with no claim", async () => {
    const fixture = liveIncumbent();
    quota(fixture, 1);

    const gap = await fixture.daemon.reconcileContinuity("weekly quota measured exhausted");

    expect(gap?.plan.assignments.find((assignment) => assignment.roleKey === fixture.roleKey)?.provider).toBeNull();
    expect(gap?.unresolved).toContainEqual({ roleKey: fixture.roleKey, reasonCode: ReasonCode.COVERAGE_NONE });
    expect(fixture.cp.bindings.active(fixture.roleKey)).toEqual(fixture.incumbent);
    expect(kinds(fixture, "CONTINUITY_REVOCATION_HELD")).toBe(1);

    fixture.clock.advance(149_000);
    quota(fixture, 90);
    await fixture.daemon.reconcileContinuity("weekly quota measured again");

    expect(fixture.cp.bindings.active(fixture.roleKey)).toEqual(fixture.incumbent);
    expect(kinds(fixture, "BINDING_REVOKED")).toBe(0);
    expect(kinds(fixture, "CONTINUITY_RESTORE_AWAITS_CLAIM")).toBe(0);
    expect(kinds(fixture, "CONTINUITY_REVOCATION_WITHDRAWN")).toBe(1);
  });

  it("records the hold once and keeps holding while the window lasts", async () => {
    const fixture = liveIncumbent();
    quota(fixture, 1);

    await fixture.daemon.reconcileContinuity("first tick of the gap");
    fixture.clock.advance(COVERAGE_REVOCATION_GRACE_MS - 1_000);
    quota(fixture, 1);
    await fixture.daemon.reconcileContinuity("last tick inside the window");

    expect(fixture.cp.bindings.active(fixture.roleKey)).toEqual(fixture.incumbent);
    expect(kinds(fixture, "CONTINUITY_REVOCATION_HELD")).toBe(1);
  });

  it("revokes for want of coverage once the gap outlasts the window", async () => {
    const fixture = liveIncumbent();
    quota(fixture, 1);

    await fixture.daemon.reconcileContinuity("first tick of the gap");
    fixture.clock.advance(COVERAGE_REVOCATION_GRACE_MS);
    quota(fixture, 1);
    await fixture.daemon.reconcileContinuity("the gap is still there");

    expect(fixture.cp.bindings.active(fixture.roleKey)).toBeNull();
    expect(
      fixture.cp.db.all<{ revoked_reason: string | null }>(
        `SELECT revoked_reason FROM assignments WHERE role_key = ? ORDER BY binding_generation DESC`,
        [fixture.roleKey],
      )[0],
    ).toEqual({ revoked_reason: CONTINUITY_COVERAGE_REVOCATION_REASON });
  });

  it("holds a session recorded the ordinary way, by ps lstart text", async () => {
    // The row is written now, after this process started, as a launch path writes it.
    const fixture = makeIncumbent("claude", { pid: process.pid }, new Date().toISOString());
    fixture.cp.providers.registerForRole(fixture.claude, Role.PRIMARY_CTO);
    expect(fixture.cp.sessions.require(fixture.incumbent.sessionId).osProcessStartedAt).not.toMatch(/^darwin-tv:/);
    quota(fixture, 1);

    await fixture.daemon.reconcileContinuity("weekly quota measured exhausted");

    expect(fixture.cp.bindings.active(fixture.roleKey)).toEqual(fixture.incumbent);
    expect(kinds(fixture, "CONTINUITY_REVOCATION_HELD")).toBe(1);
  });

  it("revokes at once an lstart record that is not this process's start", async () => {
    const fixture = makeIncumbent("claude", { pid: process.pid, token: "Thu Jan  1 00:00:00 1970" }, new Date().toISOString());
    fixture.cp.providers.registerForRole(fixture.claude, Role.PRIMARY_CTO);
    quota(fixture, 1);

    await fixture.daemon.reconcileContinuity("weekly quota measured exhausted");

    expect(fixture.cp.bindings.active(fixture.roleKey)).toBeNull();
    expect(kinds(fixture, "CONTINUITY_REVOCATION_HELD")).toBe(0);
  });

  it("revokes at once an lstart record whose running process started after its row", async () => {
    // Same pid and same whole-second lstart text, but a process that began after the session row
    // was written cannot be the one that row recorded: it is the same-second reuse lstart cannot see.
    const fixture = makeIncumbent("claude", { pid: process.pid });
    fixture.cp.providers.registerForRole(fixture.claude, Role.PRIMARY_CTO);
    expect(fixture.cp.sessions.require(fixture.incumbent.sessionId).osProcessStartedAt).not.toMatch(/^darwin-tv:/);
    quota(fixture, 1);

    await fixture.daemon.reconcileContinuity("weekly quota measured exhausted");

    expect(fixture.cp.bindings.active(fixture.roleKey)).toBeNull();
    expect(kinds(fixture, "CONTINUITY_REVOCATION_HELD")).toBe(0);
  });

  it("does not renew the window when the daemon restarts inside it", async () => {
    const fixture = liveIncumbent();
    quota(fixture, 1);
    await fixture.daemon.reconcileContinuity("first tick of the gap");

    fixture.clock.advance(COVERAGE_REVOCATION_GRACE_MS - 60_000);
    const restarted = new Daemon(fixture.cp, { stateDir: join(tempDir("acp-sensor-binding-restart-"), "daemon") });
    quota(fixture, 1);
    await restarted.reconcileContinuity("the restarted daemon's first tick");
    expect(fixture.cp.bindings.active(fixture.roleKey)).toEqual(fixture.incumbent);

    fixture.clock.advance(60_000);
    quota(fixture, 1);
    await restarted.reconcileContinuity("the window has passed");

    expect(fixture.cp.bindings.active(fixture.roleKey)).toBeNull();
    expect(kinds(fixture, "CONTINUITY_REVOCATION_HELD")).toBe(1);
  });

  it("leaves active work running through the hold and pauses it with the revocation", async () => {
    const fixture = liveIncumbent();
    const created = fixture.cp.runs.create({ projectId: "sensor-binding", executionMode: ExecutionMode.SIMPLE,
      contract: { goal: "keep working", why: "a momentary gap", scope: [], nonGoals: [],
        acceptance: ["done"], priority: "NORMAL", humanGate: [], references: [] } });
    if (!created.allowed) throw new Error(created.message);
    const runId = created.value.runId;
    expect(fixture.cp.runs.transition(runId, RunState.ACTIVE, "test: work in progress").allowed).toBe(true);
    quota(fixture, 1);

    const held = await fixture.daemon.reconcileContinuity("first tick of the gap");
    expect(held?.pausedRuns).toEqual([]);
    expect(fixture.cp.runs.get(runId)?.state).toBe(RunState.ACTIVE);

    fixture.clock.advance(COVERAGE_REVOCATION_GRACE_MS);
    quota(fixture, 1);
    const expired = await fixture.daemon.reconcileContinuity("the gap is still there");

    expect(expired?.pausedRuns.map((paused) => paused.runId)).toEqual([runId]);
    expect(fixture.cp.runs.get(runId)?.state).toBe(RunState.BLOCKED);
    expect(fixture.cp.bindings.active(fixture.roleKey)).toBeNull();
  });

  it("leaves active work running when coverage returns inside the window", async () => {
    const fixture = liveIncumbent();
    const created = fixture.cp.runs.create({ projectId: "sensor-binding", executionMode: ExecutionMode.SIMPLE,
      contract: { goal: "keep working", why: "a gap that closes", scope: [], nonGoals: [],
        acceptance: ["done"], priority: "NORMAL", humanGate: [], references: [] } });
    if (!created.allowed) throw new Error(created.message);
    const runId = created.value.runId;
    expect(fixture.cp.runs.transition(runId, RunState.ACTIVE, "test: work in progress").allowed).toBe(true);
    quota(fixture, 1);
    await fixture.daemon.reconcileContinuity("first tick of the gap");

    fixture.clock.advance(149_000);
    quota(fixture, 90);
    const recovered = await fixture.daemon.reconcileContinuity("weekly quota measured again");

    expect(recovered?.pausedRuns).toEqual([]);
    expect(fixture.cp.runs.get(runId)?.state).toBe(RunState.ACTIVE);
    expect(fixture.cp.bindings.active(fixture.roleKey)).toEqual(fixture.incumbent);
  });

  it("revokes at once a reused pid whose start token is not the one it recorded", async () => {
    const liveToken = readProcessStartToken(process.pid);
    expect(liveToken).toMatch(/^darwin-tv:\d+\.\d{6}$/);
    const recordedToken = liveToken!.replace(/^darwin-tv:(\d+)/, (_, seconds: string) =>
      `darwin-tv:${Number(seconds) - 1}`);
    const fixture = makeIncumbent("claude", { pid: process.pid, token: recordedToken });
    fixture.cp.providers.registerForRole(fixture.claude, Role.PRIMARY_CTO);
    quota(fixture, 1);

    await fixture.daemon.reconcileContinuity("weekly quota measured exhausted");

    expect(fixture.cp.bindings.active(fixture.roleKey)).toBeNull();
    expect(kinds(fixture, "CONTINUITY_REVOCATION_HELD")).toBe(0);
  });

  it("revokes at once an incumbent whose process it cannot identify", async () => {
    const fixture = makeIncumbent("claude");
    fixture.cp.providers.registerForRole(fixture.claude, Role.PRIMARY_CTO);
    quota(fixture, 1);

    await fixture.daemon.reconcileContinuity("weekly quota measured exhausted");

    expect(fixture.cp.bindings.active(fixture.roleKey)).toBeNull();
    expect(kinds(fixture, "CONTINUITY_REVOCATION_HELD")).toBe(0);
  });
});

/**
 * #954 — the exact-process test a coverage hold rests on, with every process read injected.
 *
 * An lstart record is whole-second text, so it is trusted only together with a native start that
 * precedes the session row, and only if both native reads around the lstart read agree: a pid
 * reused between the reads would otherwise pair the old process's native start with the
 * replacement's lstart.
 */
describe("#954: which running process a coverage hold may treat as the incumbent", () => {
  const LSTART = "Wed Sep 30 23:50:25 2026";
  const record = { osPid: 4242, osProcessStartedAt: LSTART, createdAt: "2026-09-30T14:50:30.123Z" };
  const reads = (natives: Array<string | null>, lstart: string | null = LSTART) => {
    const queue = [...natives];
    return { native: () => queue.shift() ?? null, lstart: () => lstart };
  };

  it("accepts an lstart record whose process began before its row and stayed the same across the reads", () => {
    const token = "darwin-tv:1790779825.000001";
    expect(recordedProcessIsRunning(record, reads([token, token]))).toBe(true);
  });

  it("refuses when the pid is reused between the native and lstart reads", () => {
    expect(recordedProcessIsRunning(record, reads(["darwin-tv:1790779825.000001", "darwin-tv:1790779831.500000"])))
      .toBe(false);
  });

  it("accepts a process that began earlier in the same millisecond its row was written", () => {
    const token = "darwin-tv:1790779830.123900";
    expect(recordedProcessIsRunning(record, reads([token, token]))).toBe(true);
  });

  it("refuses a process that began after its row", () => {
    const token = "darwin-tv:1790779830.124000";
    expect(recordedProcessIsRunning(record, reads([token, token]))).toBe(false);
  });
});

/**
 * Capacity unknown is not evidence against the incumbent, with no reading at all either.
 *
 * The #811 guard reads a snapshot, so a provider capacity manages and nothing has read yet
 * (`current()` null) fell through it: into the coverage hold and, past its grace, revocation, or
 * straight into failover when another provider could staff the role. Whether the bound process is
 * still here was already answerable from its recorded pid and start token, and was not asked.
 * These pin that it is asked, that unknown stays unknown (unresolved, not routable), and that an
 * incumbent whose process is gone or whose session is no longer READY is handled as before.
 */
describe("a live incumbent is not revoked because its capacity is unknown", () => {
  const liveToken = (): string => {
    const token = readProcessStartToken(process.pid);
    expect(token).toMatch(/^darwin-tv:\d+\.\d{6}$/);
    return token!;
  };
  const kinds = (fixture: ReturnType<typeof makeIncumbent>, kind: string) =>
    fixture.cp.db.all<{ n: number }>(
      `SELECT COUNT(*) AS n FROM audit_events WHERE kind = ? AND role_key = ?`,
      [kind, fixture.roleKey],
    )[0]?.n;

  it("keeps a live incumbent whose provider has no reading, past the hold window", async () => {
    const fixture = makeIncumbent("none", { pid: process.pid, token: liveToken() });
    expect(fixture.cp.capacity.manages("claude")).toBe(true);
    expect(fixture.cp.capacity.current("claude")).toBeNull();

    const first = await fixture.daemon.reconcileContinuity("no reading for the incumbent's provider");
    fixture.clock.advance(COVERAGE_REVOCATION_GRACE_MS + 1_000);
    const later = await fixture.daemon.reconcileContinuity("still no reading, past the hold window");

    for (const report of [first, later]) {
      expect(report?.unresolved).toEqual([
        { roleKey: fixture.roleKey, reasonCode: ReasonCode.CAPACITY_UNKNOWN_NOT_ROUTABLE },
      ]);
      expect(report?.reassigned).toEqual([]);
      expect(report?.pausedRuns).toEqual([]);
    }
    expect(fixture.cp.bindings.active(fixture.roleKey)).toEqual(fixture.incumbent);
    expect(kinds(fixture, "BINDING_REVOKED")).toBe(0);
    expect(kinds(fixture, "CONTINUITY_REVOCATION_HELD")).toBe(0);
    // Unknown stays unknown: keeping the binding did not invent a reading for the provider.
    expect(fixture.cp.capacity.current("claude")).toBeNull();
  });

  it("does not fail a live incumbent over to a routable provider because its own reading is missing", async () => {
    const fixture = makeIncumbent("gpt", { pid: process.pid, token: liveToken() });
    // The route continuity staffs a role through, attached so that a failover could succeed and
    // its absence below is the daemon's decision rather than the harness failing closed.
    fixture.cp.continuity.attach({
      readiness: { checkSession: async () => allow(ReasonCode.OK, undefined) },
      buzz: { connect: async (sessionId) => allow(ReasonCode.OK, `buzz:${sessionId}`) },
    });
    expect(fixture.cp.capacity.current("claude")).toBeNull();

    const report = await fixture.daemon.reconcileContinuity("no reading for the incumbent's provider");

    // A target existed, so this is not a refusal for want of one.
    expect(report?.plan.assignments.find((assignment) => assignment.roleKey === fixture.roleKey)?.provider)
      .toBe("gpt");
    expect(report?.reassigned).toEqual([]);
    expect(report?.unresolved).toEqual([
      { roleKey: fixture.roleKey, reasonCode: ReasonCode.CAPACITY_UNKNOWN_NOT_ROUTABLE },
    ]);
    expect(fixture.cp.bindings.active(fixture.roleKey)).toEqual(fixture.incumbent);
    expect(fixture.cp.sessions.live()).toHaveLength(1);
  });

  /**
   * ACP1045-R2-01. The CTO launch and continuity provisioning paths record `ps` lstart, so a live
   * incumbent registered the ordinary way has to be kept too. Its row is decisive when it was
   * written after the process's start second ended: the recorded process was alive then, so any
   * process that later took its pid started in a later second. The live token is pinned then.
   * The row is written two seconds ahead of the real clock so that holds however soon this test
   * runs after the worker started; a row inside the start second is the ambiguous case, which
   * `an-unread-capacity-keeps-only-the-exact-process.test.ts` covers with injected reads.
   */
  const lstartIncumbent = (providers: "none" | "gpt") => {
    const fixture = makeIncumbent(providers, { pid: process.pid }, new Date(Date.now() + 2_000).toISOString());
    const session = fixture.cp.sessions.require(fixture.incumbent.sessionId);
    expect(session.osProcessStartedAt).not.toMatch(/^darwin-tv:/);
    // Read from the ledger rather than through `pinnedNativeStart`, so the premise holds on a head
    // that has no pin at all.
    expect(fixture.cp.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'SESSION_NATIVE_START_PINNED' AND session_id = ?`,
      [session.sessionId],
    )?.n).toBe(0);
    return fixture;
  };

  it("keeps a live incumbent recorded by ps lstart text past the hold window, and pins its token", async () => {
    const fixture = lstartIncumbent("none");

    const first = await fixture.daemon.reconcileContinuity("no reading, lstart-recorded incumbent");
    fixture.clock.advance(COVERAGE_REVOCATION_GRACE_MS + 1_000);
    const later = await fixture.daemon.reconcileContinuity("still no reading, past the hold window");

    for (const report of [first, later]) {
      expect(report?.unresolved).toEqual([
        { roleKey: fixture.roleKey, reasonCode: ReasonCode.CAPACITY_UNKNOWN_NOT_ROUTABLE },
      ]);
      expect(report?.reassigned).toEqual([]);
    }
    expect(fixture.cp.bindings.active(fixture.roleKey)).toEqual(fixture.incumbent);
    expect(kinds(fixture, "BINDING_REVOKED")).toBe(0);
    expect(kinds(fixture, "CONTINUITY_REVOCATION_HELD")).toBe(0);
    expect(fixture.cp.sessions.pinnedNativeStart(fixture.incumbent.sessionId)).toBe(liveToken());
  });

  it("does not fail a live lstart-recorded incumbent over to a routable provider", async () => {
    const fixture = lstartIncumbent("gpt");
    fixture.cp.continuity.attach({
      readiness: { checkSession: async () => allow(ReasonCode.OK, undefined) },
      buzz: { connect: async (sessionId) => allow(ReasonCode.OK, `buzz:${sessionId}`) },
    });

    const report = await fixture.daemon.reconcileContinuity("no reading, lstart-recorded incumbent, gpt routable");

    expect(report?.plan.assignments.find((assignment) => assignment.roleKey === fixture.roleKey)?.provider)
      .toBe("gpt");
    expect(report?.reassigned).toEqual([]);
    expect(report?.unresolved).toEqual([
      { roleKey: fixture.roleKey, reasonCode: ReasonCode.CAPACITY_UNKNOWN_NOT_ROUTABLE },
    ]);
    expect(fixture.cp.bindings.active(fixture.roleKey)).toEqual(fixture.incumbent);
    expect(fixture.cp.sessions.live()).toHaveLength(1);
  });

  it("pins the native token of a session continuity provisions, beside the lstart it records", async () => {
    // An incumbent with no recorded process cannot be kept, so the pass fails it over to gpt and
    // provisions a session whose runtime reports this process's pid.
    const fixture = makeIncumbent("gpt");
    fixture.cp.continuity.attach({
      readiness: { checkSession: async () => allow(ReasonCode.OK, undefined) },
      buzz: { connect: async (sessionId) => allow(ReasonCode.OK, `buzz:${sessionId}`) },
    });
    const start = fixture.gpt.startSession.bind(fixture.gpt);
    fixture.gpt.startSession = async (spec) => ({ ...(await start(spec)), pid: process.pid });

    const report = await fixture.daemon.reconcileContinuity("incumbent unprovable, gpt can staff the role");

    expect(report?.reassigned).toHaveLength(1);
    const replacement = fixture.cp.sessions.require(fixture.cp.bindings.active(fixture.roleKey)!.sessionId);
    expect(replacement).toMatchObject({ provider: "gpt", osPid: process.pid });
    expect(replacement.osProcessStartedAt).not.toMatch(/^darwin-tv:/);
    expect(fixture.cp.sessions.pinnedNativeStart(replacement.sessionId)).toBe(liveToken());
  });

  it("still revokes at once an incumbent whose recorded process is gone", async () => {
    const recorded = liveToken().replace(/^darwin-tv:(\d+)/, (_, seconds: string) =>
      `darwin-tv:${Number(seconds) - 1}`);
    const fixture = makeIncumbent("none", { pid: process.pid, token: recorded });

    const report = await fixture.daemon.reconcileContinuity("no reading, and not the recorded process");

    expect(report?.unresolved).toEqual([{ roleKey: fixture.roleKey, reasonCode: ReasonCode.COVERAGE_NONE }]);
    expect(fixture.cp.bindings.active(fixture.roleKey)).toBeNull();
    expect(kinds(fixture, "CONTINUITY_REVOCATION_HELD")).toBe(0);
  });

  it("still revokes an incumbent whose session is no longer READY, though its process runs", async () => {
    const fixture = makeIncumbent("none", { pid: process.pid, token: liveToken() });
    const stopped = fixture.cp.sessions.transition(fixture.incumbent.sessionId, SessionLifecycle.STOPPED, "runtime exited");
    if (!stopped.allowed) throw new Error(stopped.message);
    expect(fixture.cp.bindings.active(fixture.roleKey)).toEqual(fixture.incumbent);

    await fixture.daemon.reconcileContinuity("no reading, session stopped");

    expect(fixture.cp.bindings.active(fixture.roleKey)).toBeNull();
  });
});
