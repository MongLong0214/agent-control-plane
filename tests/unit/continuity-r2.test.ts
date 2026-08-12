import { afterAll, describe, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { RefreshTrigger } from "../../src/capacity/capacity-monitor.ts";
import { ControlPlane } from "../../src/app/control-plane.ts";
import { ManualClock } from "../../src/core/clock.ts";
import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ContinuityMode, ExecutionMode, Role, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { CodexCliAdapter, runtimeEnvironment, readCapacityFile } from "../../src/runtime/cli-adapters.ts";
import {
  type CapacityReading,
  type InvocationRequest,
  type InvocationResult,
  type ProviderAdapter,
  ProviderRegistry,
  type SessionHandle,
  type SessionSpec,
} from "../../src/runtime/provider.ts";
import { ScriptedAdapter } from "../../src/runtime/scripted-adapter.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { fixtureManifest } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

class ProductionTestAdapter implements ProviderAdapter {
  readonly #scripted: ScriptedAdapter;
  readonly isProduction = true;

  constructor(clock: ManualClock, provider: string) {
    this.#scripted = new ScriptedAdapter(clock, provider);
  }

  get provider(): string { return this.#scripted.provider; }
  get defaultModels(): Readonly<Record<string, string>> { return this.#scripted.defaultModels; }
  setCapacity(reading: CapacityReading | null): void { this.#scripted.setCapacity(reading); }
  setRuntimeHealth(health: "HEALTHY" | "DEGRADED" | "UNAVAILABLE"): void { this.#scripted.setRuntimeHealth(health); }
  setNextSessionHealth(health: "HEALTHY" | "DEGRADED" | "UNAVAILABLE"): void {
    this.#scripted.setNextSessionHealth(health);
  }
  startSession(spec: SessionSpec): Promise<SessionHandle> { return this.#scripted.startSession(spec); }
  stopSession(handle: SessionHandle): Promise<void> {
    return this.#scripted.stopSession(handle);
  }
  invoke(request: InvocationRequest): Promise<InvocationResult> { return this.#scripted.invoke(request); }
  probeRuntime(): Promise<"HEALTHY" | "DEGRADED" | "UNAVAILABLE"> { return this.#scripted.probeRuntime(); }
  probeSession(handle: SessionHandle): Promise<"HEALTHY" | "DEGRADED" | "UNAVAILABLE"> {
    return this.#scripted.probeSession(handle);
  }
  probeCapacity(): Promise<CapacityReading> { return this.#scripted.probeCapacity(); }
}

const CAPABILITIES = ["ceo", "cto", "blind-review", "worker"];

const reading = (
  provider: string,
  clock: ManualClock,
  buckets: CapacityReading["buckets"],
): CapacityReading => ({
  provider,
  sensorHealth: "HEALTHY",
  runtimeHealth: "HEALTHY",
  observedAt: clock.nowIso(),
  source: "r2-test",
  buckets,
});

const healthy = (provider: string, clock: ManualClock): CapacityReading =>
  reading(provider, clock, [{ id: "rolling", remainingPercent: 90, resetAt: null, capabilities: CAPABILITIES }]);

const makePlane = () => {
  const root = tempDir("acp-cont-r2-");
  const clock = new ManualClock("2026-08-12T00:00:00.000Z");
  const gpt = new ProductionTestAdapter(clock, "gpt");
  const claude = new ProductionTestAdapter(clock, "claude");
  const cp = new ControlPlane({
    databasePath: join(root, "state.sqlite"),
    worktreeRoot: join(root, "worktrees"),
    capacityDir: join(root, "capacity"),
    secretsDir: join(root, "secrets"),
    clock,
    adapters: [gpt, claude],
  });
  return { cp, clock, gpt, claude, root };
};

const attachRoutablePorts = (cp: ControlPlane) => {
  cp.continuity.attach({
    readiness: { checkSession: async () => allow(ReasonCode.OK, undefined) },
    buzz: { connect: async (sessionId) => allow(ReasonCode.OK, `buzz:${sessionId}`) },
  });
};

const bindCeo = (plane: ReturnType<typeof makePlane>, provider = "gpt", mode: "PREFERRED" | "FALLBACK" = "PREFERRED") => {
  const session = plane.cp.sessions.create({ provider, model: "test" });
  plane.cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "test");
  const bound = plane.cp.bindings.bind({
    role: Role.CEO,
    sessionId: session.sessionId,
    mode,
  });
  if (!bound.allowed) throw new Error(bound.message);
  return bound.value;
};

describe("round-2 capacity and runtime regressions", () => {
  it("#52 refuses a capability when one of its applicable quota windows is unknown", async () => {
    const { cp, clock, gpt } = makePlane();
    gpt.setCapacity(reading("gpt", clock, [
      { id: "rolling", remainingPercent: 60, resetAt: null, capabilities: ["cto"] },
      { id: "weekly", remainingPercent: null, resetAt: null, capabilities: ["cto"] },
    ]));
    await cp.capacity.refresh(RefreshTrigger.DOCTOR_CAPACITY_REPORT, ["gpt"]);

    const capacity = cp.capacity.current("gpt")!;
    expect(capacity.allocationAdmission).toBe("OPEN");
    expect(cp.capacity.isRoutableFor(capacity, "cto")).toBe(false);
    expect(cp.capacity.providersFor("cto")).toEqual([]);
  });

  it("#53/#179/#328 admits a working capability and denies the selected missing capability", async () => {
    const { cp, clock, gpt } = makePlane();
    gpt.setCapacity(reading("gpt", clock, [
      { id: "worker", remainingPercent: 90, resetAt: "2026-08-13T00:00:00.000Z", capabilities: ["worker"] },
    ]));

    const worker = await cp.capacity.refreshForDispatch({
      provider: "gpt",
      capabilities: ["worker"],
      priority: "worker",
      reserveDemand: { criticalRoleInvocations: 0, expectedReviews: 0, inFlightRuns: 0, burnRatePercentPerHour: 0 },
    });
    expect(worker.allowed).toBe(true);
    expect(worker.reasonCode).toBe(ReasonCode.OK);

    const cto = await cp.capacity.refreshForDispatch({ provider: "gpt", capabilities: ["cto"] });
    expect(cto.allowed).toBe(false);
    expect(cto.reasonCode).toBe(ReasonCode.CAPACITY_UNKNOWN_NOT_ROUTABLE);
    expect(cto.evidence).toMatchObject({ provider: "gpt", capabilities: ["cto"] });

    const unprioritizedWorker = await cp.capacity.refreshForDispatch({ provider: "gpt", capabilities: ["worker"] });
    expect(unprioritizedWorker.allowed).toBe(false);
    expect(unprioritizedWorker.reasonCode).toBe(ReasonCode.CAPACITY_ADMISSION_CONSERVE);
  });

  it("#178 denies dispatch admission when no production provider exists", async () => {
    const root = tempDir("acp-no-prod-");
    const clock = new ManualClock("2026-08-12T00:00:00.000Z");
    const scripted = new ScriptedAdapter(clock);
    const cp = new ControlPlane({
      databasePath: join(root, "state.sqlite"),
      worktreeRoot: join(root, "worktrees"),
      capacityDir: join(root, "capacity"),
      secretsDir: join(root, "secrets"),
      clock,
      adapters: [scripted],
      allowNonProductionAdapters: true,
    });
    const decision = await cp.capacity.refreshForDispatch({ provider: "scripted", capabilities: ["cto"] });
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.CAPACITY_UNKNOWN_NOT_ROUTABLE);
  });

  it("#53 fails closed when a dispatcher cannot name a concrete target", async () => {
    const { cp } = makePlane();
    const targetless = await cp.capacity.refreshForDispatch();
    expect(targetless.allowed).toBe(false);
    expect(targetless.reasonCode).toBe(ReasonCode.CAPACITY_UNKNOWN_NOT_ROUTABLE);
    expect(targetless.evidence).toEqual({ target: null });

    const unregistered = await cp.capacity.refreshForDispatch({ provider: "missing", capabilities: ["cto"] });
    expect(unregistered.allowed).toBe(false);
    expect(unregistered.reasonCode).toBe(ReasonCode.CAPACITY_UNKNOWN_NOT_ROUTABLE);
    expect(unregistered.evidence).toMatchObject({ provider: "missing", capabilities: ["cto"] });
  });

  it("#55/#182 computes reserve per window, includes reset/burn, and reserves unknown capacity", async () => {
    const { cp, clock, gpt } = makePlane();
    gpt.setCapacity(reading("gpt", clock, [
      { id: "short", remainingPercent: 80, resetAt: "2026-08-12T01:00:00.000Z", capabilities: ["worker"] },
      { id: "unknown", remainingPercent: null, resetAt: "2026-08-18T00:00:00.000Z", capabilities: ["worker"] },
    ]));
    await cp.capacity.refresh(RefreshTrigger.WORKER_FANOUT, ["gpt"]);
    const capacity = cp.capacity.current("gpt")!;
    const reserves = cp.capacity.dynamicReserveByBucket(capacity, {
      criticalRoleInvocations: 2,
      expectedReviews: 1,
      inFlightRuns: 3,
      burnRatePercentPerHour: 4,
    });
    expect(reserves).toEqual(expect.arrayContaining([expect.objectContaining({ bucketId: "unknown", reserve: 1 })]));
    expect(cp.capacity.dynamicReserve("gpt", {
      criticalRoleInvocations: 2,
      expectedReviews: 1,
      inFlightRuns: 3,
      burnRatePercentPerHour: 4,
    })).toBe(1);
    const denied = await cp.capacity.refreshForDispatch({
      provider: "gpt",
      capabilities: ["worker"],
      priority: "worker",
      reserveDemand: { criticalRoleInvocations: 2, expectedReviews: 1, inFlightRuns: 3, burnRatePercentPerHour: 4 },
    });
    expect(denied.reasonCode).toBe(ReasonCode.CAPACITY_UNKNOWN_NOT_ROUTABLE);

    // An unknown CTO window reserves CTO capacity, not an unrelated worker window.
    // Collapsing all provider buckets to one maximum reserve would reject this worker.
    gpt.setCapacity(reading("gpt", clock, [
      { id: "worker", remainingPercent: 80, resetAt: "2026-08-13T00:00:00.000Z", capabilities: ["worker"] },
      { id: "cto", remainingPercent: null, resetAt: null, capabilities: ["cto"] },
    ]));
    const unrelatedUnknown = await cp.capacity.refreshForDispatch({
      provider: "gpt",
      capabilities: ["worker"],
      priority: "worker",
      reserveDemand: { criticalRoleInvocations: 0, expectedReviews: 0, inFlightRuns: 0, burnRatePercentPerHour: 0 },
    });
    expect(unrelatedUnknown.allowed).toBe(true);
    expect(unrelatedUnknown.reasonCode).toBe(ReasonCode.OK);

    const missingDemand = await cp.capacity.refreshForDispatch({
      provider: "gpt",
      capabilities: ["worker"],
      priority: "worker",
    });
    expect(missingDemand.allowed).toBe(false);
    expect(missingDemand.reasonCode).toBe(ReasonCode.CAPACITY_ADMISSION_CONSERVE);

    gpt.setCapacity(reading("gpt", clock, [
      { id: "constrained", remainingPercent: 10, resetAt: "2026-08-13T00:00:00.000Z", capabilities: ["worker"] },
    ]));
    const reserved = await cp.capacity.refreshForDispatch({
      provider: "gpt",
      capabilities: ["worker"],
      priority: "worker",
      reserveDemand: { criticalRoleInvocations: 2, expectedReviews: 1, inFlightRuns: 3, burnRatePercentPerHour: 4 },
    });
    expect(reserved.reasonCode).toBe(ReasonCode.CAPACITY_ADMISSION_CONSERVE);

    gpt.setCapacity(reading("gpt", clock, [
      { id: "missing-reset", remainingPercent: 80, resetAt: null, capabilities: ["worker"] },
    ]));
    const unknownHorizon = await cp.capacity.refreshForDispatch({
      provider: "gpt",
      capabilities: ["worker"],
      priority: "worker",
      reserveDemand: { criticalRoleInvocations: 0, expectedReviews: 0, inFlightRuns: 0, burnRatePercentPerHour: 0 },
    });
    expect(unknownHorizon.allowed).toBe(false);
    expect(unknownHorizon.reasonCode).toBe(ReasonCode.CAPACITY_ADMISSION_CONSERVE);
  });

  it("#56 rejects a future-dated capacity file instead of keeping it fresh indefinitely", () => {
    const root = tempDir("acp-future-capacity-");
    const file = join(root, "capacity.json");
    const clock = new ManualClock("2026-08-12T00:00:00.000Z");
    writeFileSync(file, JSON.stringify({
      observedAt: "2036-08-12T00:00:00.000Z",
      buckets: [{ id: "bucket", remainingPercent: 90, capabilities: ["cto"] }],
    }));
    const result = readCapacityFile("gpt", file, clock, 60_000);
    expect(result.sensorHealth).toBe("ERROR");
    expect(result.runtimeHealth).toBe("UNKNOWN");
  });

  it("#58 builds a runtime environment without daemon authority variables", () => {
    const previous = process.env.GH_TOKEN;
    const previousOpaque = process.env.RUNTIME_VALUE;
    process.env.GH_TOKEN = "ghp_not_for_agent";
    process.env.RUNTIME_VALUE = "sk-12345678901234567890";
    const environment = runtimeEnvironment(["GH_TOKEN", "RUNTIME_VALUE", "PATH"], tempDir("acp-runtime-env-"));
    if (previous === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previous;
    if (previousOpaque === undefined) delete process.env.RUNTIME_VALUE;
    else process.env.RUNTIME_VALUE = previousOpaque;

    // An authority-shaped name and a credential-shaped value are both withheld even
    // though the caller allowlisted them, which is what #58 is about.
    expect(environment.GH_TOKEN).toBeUndefined();
    expect(environment.RUNTIME_VALUE).toBeUndefined();
    expect(environment.PATH).toBeDefined();
    // HOME is deliberately the real one: an agent session exists to authenticate to its
    // provider, and both CLIs resolve that login through the invoking user's keychain, so
    // a scratch HOME does not contain the agent — it stops it being one. Containment is
    // the withheld variables above plus the write confinement and the denied reads of the
    // database, secrets and capacity directories.
    expect(environment.HOME).toBe(process.env.HOME);
    expect(environment.TMPDIR).not.toBe(process.env.TMPDIR);
    expect(Object.keys(environment).sort()).toEqual(
      ["GIT_CONFIG_NOSYSTEM", "GIT_TERMINAL_PROMPT", "HOME", "LANG", "LC_ALL", "PATH", "TMPDIR", "USER"].filter(
        (name) => name !== "USER" || process.env["USER"],
      ),
    );
  });

  it("#59 rejects replacement and keeps scripted adapters out of the production registry", () => {
    const clock = new ManualClock("2026-08-12T00:00:00.000Z");
    const providers = new ProviderRegistry();
    const scripted = new ScriptedAdapter(clock, "gpt");
    expect(() => providers.register(scripted)).toThrow("non-production");
    providers.registerTestAdapter(scripted);
    expect(providers.production()).toEqual([]);
    expect(() => providers.registerTestAdapter(new ScriptedAdapter(clock, "gpt"))).toThrow("already registered");
  });

  it("#57 rejects a same-provider handle the runtime never constituted", async () => {
    const clock = new ManualClock("2026-08-12T00:00:00.000Z");
    const gpt = new ProductionTestAdapter(clock, "gpt");
    const result = await gpt.probeSession({
      externalSessionId: "not-a-constituted-session",
      provider: "gpt",
      model: "test",
      effort: null,
      pid: null,
      workdir: process.cwd(),
    });
    expect(result).toBe("UNAVAILABLE");
  });

  it("#132 refuses to falsely attest reviewer isolation when Codex cannot remove tools", async () => {
    const clock = new ManualClock("2026-08-12T00:00:00.000Z");
    const packetRoot = tempDir("acp-reviewer-packet-");
    const adapter = new CodexCliAdapter({
      clock,
      capacityFile: join(packetRoot, "capacity.json"),
      binary: "codex-not-invoked-by-this-test",
    });

    const result = await adapter.invoke({
      prompt: "Review the packet only.",
      workdir: packetRoot,
      timeoutMs: 1_000,
      readOnly: true,
      correlationId: "reviewer-isolation-test",
      isolation: {
        packetRoot,
        denyReadPaths: [join(packetRoot, "../daemon.sqlite")],
        emptyEnvironment: true,
        network: "deny",
        tools: "none",
      },
    });

    expect(result.ok).toBe(false);
    expect(result.isolationAttested).toBe(false);
    expect(result.error).toContain("tools:none");
  });
});

describe("round-2 continuity and persistence regressions", () => {
  it("#60 rolls back a freshness write when the paired mode transition cannot commit", async () => {
    const plane = makePlane();
    plane.gpt.setCapacity(healthy("gpt", plane.clock));
    plane.claude.setCapacity(healthy("claude", plane.clock));
    await plane.cp.continuity.evaluate("baseline");
    const before = plane.cp.db.get<{ evaluated_at: string }>(`SELECT evaluated_at FROM continuity_state WHERE id = 1`)!.evaluated_at;

    plane.clock.advance(60_000);
    plane.gpt.setCapacity({ ...healthy("gpt", plane.clock), sensorHealth: "ERROR", buckets: [] });
    plane.claude.setCapacity({ ...healthy("claude", plane.clock), sensorHealth: "ERROR", buckets: [] });
    const original = plane.cp.db.run.bind(plane.cp.db);
    const failModeWrite = vi.spyOn(plane.cp.db, "run").mockImplementation((sql, params) => {
      if (sql.includes("UPDATE continuity_state") && sql.includes("SET mode")) throw new Error("injected crash");
      return original(sql, params);
    });
    await expect(plane.cp.continuity.evaluate("both unavailable")).rejects.toThrow("injected crash");
    failModeWrite.mockRestore();

    const after = plane.cp.db.get<{ mode: ContinuityMode; evaluated_at: string }>(
      `SELECT mode, evaluated_at FROM continuity_state WHERE id = 1`,
    )!;
    expect(after.mode).toBe(ContinuityMode.NORMAL);
    expect(after.evaluated_at).toBe(before);
  });

  it("#61 refuses failover when an independently checked route is missing", async () => {
    const plane = makePlane();
    bindCeo(plane);
    plane.gpt.setCapacity(healthy("gpt", plane.clock));
    plane.claude.setCapacity(healthy("claude", plane.clock));
    plane.cp.continuity.attach({ readiness: { checkSession: async () => allow(ReasonCode.OK, undefined) } });

    const decision = await plane.cp.continuity.failover(roleKeyFor(Role.CEO), Role.CEO, {}, "route absent");
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.SESSION_NOT_READY);
  });

  it("#57 refuses failover when a healthy runtime cannot prove its exact constituted session", async () => {
    const plane = makePlane();
    bindCeo(plane);
    plane.gpt.setCapacity(healthy("gpt", plane.clock));
    plane.claude.setCapacity(healthy("claude", plane.clock));
    plane.gpt.setRuntimeHealth("HEALTHY");
    plane.gpt.setNextSessionHealth("UNAVAILABLE");
    attachRoutablePorts(plane.cp);

    const decision = await plane.cp.continuity.failover(roleKeyFor(Role.CEO), Role.CEO, {}, "session probe failed");
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.SESSION_NOT_READY);
    expect(await plane.gpt.probeRuntime()).toBe("HEALTHY");
  });

  it("#54/#176 refreshes selected capacity when continuity session allocation fails", async () => {
    const plane = makePlane();
    bindCeo(plane);
    plane.gpt.setCapacity(healthy("gpt", plane.clock));
    plane.claude.setCapacity(healthy("claude", plane.clock));
    attachRoutablePorts(plane.cp);
    vi.spyOn(plane.gpt, "startSession").mockRejectedValueOnce(new Error("provider allocation failed"));
    const refresh = vi.spyOn(plane.cp.capacity, "refresh");

    const decision = await plane.cp.continuity.failover(roleKeyFor(Role.CEO), Role.CEO, {}, "provider allocation failed");
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.SESSION_NOT_READY);
    expect(refresh).toHaveBeenCalledWith(RefreshTrigger.PROVIDER_SWITCH_OR_FAILURE, ["gpt"]);
  });

  it("#63 changes and verifies the binding before reporting restoration", async () => {
    const plane = makePlane();
    const projectId = "restore-project";
    const registered = plane.cp.projects.register({
      projectId,
      name: projectId,
      manifest: fixtureManifest(projectId),
    });
    if (!registered.allowed) throw new Error(registered.message);
    const session = plane.cp.sessions.create({ provider: "gpt", model: "test" });
    plane.cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "test");
    const bound = plane.cp.bindings.bind({
      role: Role.PRIMARY_CTO,
      projectId,
      sessionId: session.sessionId,
      mode: "FALLBACK",
    });
    if (!bound.allowed) throw new Error(bound.message);
    plane.gpt.setCapacity(healthy("gpt", plane.clock));
    plane.claude.setCapacity(healthy("claude", plane.clock));
    attachRoutablePorts(plane.cp);

    const restored = await plane.cp.continuity.restore();
    const roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId });
    expect(restored.restored).toContain(roleKey);
    const active = plane.cp.bindings.active(roleKey)!;
    expect(active.sessionId).not.toBe(session.sessionId);
    expect(active.mode).toBe("PREFERRED");
    expect(plane.cp.sessions.require(active.sessionId).provider).toBe("claude");
    expect(plane.cp.continuity.mode()).toBe(ContinuityMode.NORMAL);
  });

  it("#177 retains DEGRADED and defers an acting CEO with no finished-decision receipt", async () => {
    const plane = makePlane();
    bindCeo(plane, "claude", "FALLBACK");
    plane.gpt.setCapacity(healthy("gpt", plane.clock));
    plane.claude.setCapacity(healthy("claude", plane.clock));
    attachRoutablePorts(plane.cp);

    const restored = await plane.cp.continuity.restore();
    expect(restored.restored).not.toContain(roleKeyFor(Role.CEO));
    expect(restored.deferred).toEqual(expect.arrayContaining([
      expect.objectContaining({ roleKey: roleKeyFor(Role.CEO), reasonCode: ReasonCode.RESTORE_WOULD_PREEMPT_INFLIGHT_OWNER }),
    ]));
    expect(plane.cp.continuity.mode()).toBe(ContinuityMode.DEGRADED);
  });

  it("#180 includes each active worker task as an in-flight coverage requirement", async () => {
    const plane = makePlane();
    plane.gpt.setCapacity(healthy("gpt", plane.clock));
    plane.claude.setCapacity(healthy("claude", plane.clock));
    const run = plane.cp.runs.create({
      executionMode: ExecutionMode.SIMPLE,
      contract: { goal: "worker", why: "worker", scope: [], nonGoals: [], acceptance: ["done"], priority: "NORMAL", humanGate: [], references: [] },
    });
    if (!run.allowed) throw new Error(run.message);
    const tasks = plane.cp.tasks.submit(run.value.runId, [{ key: "task", title: "task", category: "mechanical" }]);
    if (!tasks.allowed) throw new Error(tasks.message);
    const task = plane.cp.tasks.ready(run.value.runId)[0]!;
    const execution = plane.cp.tasks.startExecution({
      runId: run.value.runId,
      taskId: task.taskId,
      ownerBindingGeneration: 1,
      workerSessionId: null,
      provider: "gpt",
      model: "worker",
    });
    if (!execution.allowed) throw new Error(execution.message);

    const plan = await plane.cp.continuity.evaluate("worker execution");
    expect(plan.requiredRoles).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: Role.WORKER, taskId: task.taskId, inFlight: true }),
    ]));
  });

  it("#183 detects a binding generation superseded while failover awaits session creation", async () => {
    const plane = makePlane();
    bindCeo(plane);
    plane.gpt.setCapacity(healthy("gpt", plane.clock));
    plane.claude.setCapacity(healthy("claude", plane.clock));
    attachRoutablePorts(plane.cp);
    const originalStart = plane.gpt.startSession.bind(plane.gpt);
    let started!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(plane.gpt, "startSession").mockImplementationOnce(async (spec) => {
      started();
      await gate;
      return originalStart(spec);
    });

    const pending = plane.cp.continuity.failover(roleKeyFor(Role.CEO), Role.CEO, {}, "racing failover");
    await entered;
    const concurrent = plane.cp.sessions.create({ provider: "gpt", model: "concurrent" });
    plane.cp.sessions.transition(concurrent.sessionId, SessionLifecycle.READY, "concurrent");
    const switched = plane.cp.bindings.switchTo({
      role: Role.CEO,
      sessionId: concurrent.sessionId,
      reason: "newer failover",
      takeover: true,
    });
    expect(switched.allowed).toBe(true);
    release();

    const refused = await pending;
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.BINDING_GENERATION_STALE);
    expect(plane.cp.bindings.active(roleKeyFor(Role.CEO))!.sessionId).toBe(concurrent.sessionId);
  });

  it("#183 fences a superseding binding that arrives between the freshness check and switch", async () => {
    const plane = makePlane();
    const incumbent = bindCeo(plane);
    plane.gpt.setCapacity(healthy("gpt", plane.clock));
    plane.claude.setCapacity(healthy("claude", plane.clock));
    attachRoutablePorts(plane.cp);
    const originalSwitch = plane.cp.bindings.switchTo.bind(plane.cp.bindings);

    vi.spyOn(plane.cp.bindings, "switchTo").mockImplementationOnce((input) => {
      expect(input.expectedCurrentGeneration).toBe(incumbent.bindingGeneration);
      const concurrent = plane.cp.sessions.create({ provider: "gpt", model: "concurrent" });
      plane.cp.sessions.transition(concurrent.sessionId, SessionLifecycle.READY, "concurrent");
      const newer = originalSwitch({
        role: Role.CEO,
        sessionId: concurrent.sessionId,
        reason: "newer failover",
        takeover: true,
      });
      expect(newer.allowed).toBe(true);
      return originalSwitch(input);
    });

    const refused = await plane.cp.continuity.failover(roleKeyFor(Role.CEO), Role.CEO, {}, "last-moment race");
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.BINDING_GENERATION_STALE);
    expect(plane.cp.bindings.active(roleKeyFor(Role.CEO))!.bindingGeneration).toBe(2);
  });

  it("#64 rolls back a replacement observation when a later bucket insert fails", async () => {
    const plane = makePlane();
    plane.gpt.setCapacity(reading("gpt", plane.clock, [
      { id: "first", remainingPercent: 90, resetAt: null, capabilities: ["cto"] },
      { id: "second", remainingPercent: 90, resetAt: null, capabilities: ["cto"] },
    ]));
    const original = plane.cp.db.run.bind(plane.cp.db);
    const failSecond = vi.spyOn(plane.cp.db, "run").mockImplementation((sql, params) => {
      if (sql.includes("INSERT OR REPLACE INTO capacity_snapshots") && (params ?? []).includes("second")) {
        throw new Error("injected bucket write failure");
      }
      return original(sql, params);
    });
    await expect(plane.cp.capacity.refresh(RefreshTrigger.DOCTOR_CAPACITY_REPORT, ["gpt"])).rejects.toThrow(
      "injected bucket write failure",
    );
    failSecond.mockRestore();
    expect(plane.cp.capacity.current("gpt")).toBeNull();
  });
});
