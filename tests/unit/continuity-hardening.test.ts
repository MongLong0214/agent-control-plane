import { afterAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

import { ManualClock } from "../../src/core/clock.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { allow, deny } from "../../src/core/errors.ts";
import { ControlPlane } from "../../src/app/control-plane.ts";
import { AGENTCTL_CAPACITY_OBSERVATION_SOURCE, RefreshTrigger } from "../../src/capacity/capacity-monitor.ts";
import { ContinuityMode, Role, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { ContinuityKernel } from "../../src/continuity/continuity-kernel.ts";
import type {
  CapacityReading,
  InvocationRequest,
  InvocationResult,
  ProviderAdapter,
  SessionHandle,
  SessionSpec,
} from "../../src/runtime/provider.ts";
import { readCapacityFile } from "../../src/runtime/cli-adapters.ts";
import { ScriptedAdapter } from "../../src/runtime/scripted-adapter.ts";
import { cleanupTempDirs, makeRepo, tempDir } from "../helpers/fixtures.ts";
import { fixtureManifest } from "../helpers/harness.ts";

/** Test double with the production adapter contract; ScriptedAdapter itself remains false. */
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

afterAll(cleanupTempDirs);

const makePlane = () => {
  const root = tempDir("acp-cont-hard-");
  const clock = new ManualClock("2026-08-12T00:00:00.000Z");
  const gpt = new ProductionTestAdapter(clock, "gpt");
  const claude = new ProductionTestAdapter(clock, "claude");
  const repoPath = makeRepo({ "src/app.js": "module.exports = () => 1;\n" });

  const cp = new ControlPlane({
    databasePath: join(root, "state.sqlite"),
    worktreeRoot: join(root, "worktrees"),
    capacityDir: join(root, "capacity"),
    secretsDir: join(root, "secrets"),
    clock,
    adapters: [gpt, claude],
    allowTestEvidenceWriters: true,
    ctoPreference: { provider: "claude", model: "opus", effort: null },
    reviewer: {
      preferred: { provider: "gpt", model: "gpt-5.6-sol", effort: "xhigh" },
      fallbacks: [],
    },
  });
  return { cp, clock, gpt, claude, repoPath, root };
};

const reading = (
  provider: string,
  clock: ManualClock,
  buckets: CapacityReading["buckets"],
): CapacityReading => ({
  provider,
  sensorHealth: "HEALTHY",
  runtimeHealth: "HEALTHY",
  observedAt: clock.nowIso(),
  source: "test",
  buckets,
});

const FULL = ["ceo", "cto", "blind-review", "worker"];

describe("capacity routability (§14.3 — no UNKNOWN routing)", () => {
  it("a bucket with no remaining percentage is not routable and does not staff a role", async () => {
    const { cp, clock, gpt, claude } = makePlane();
    // Quota is genuinely unknown for gpt: the bucket exists, its remaining is not known.
    gpt.setCapacity(
      reading("gpt", clock, [{ id: "rolling-5h", remainingPercent: null, resetAt: null, capabilities: FULL }]),
    );
    claude.setCapacity(
      reading("claude", clock, [{ id: "rolling-5h", remainingPercent: 90, resetAt: null, capabilities: FULL }]),
    );

    await cp.capacity.refresh(RefreshTrigger.DOCTOR_CAPACITY_REPORT);
    const gptCapacity = cp.capacity.current("gpt")!;
    expect(gptCapacity.unknownBuckets).toEqual(["rolling-5h"]);
    expect(gptCapacity.allocationAdmission).toBe("SUSPENDED");
    expect(cp.capacity.isRoutableFor(gptCapacity, "cto")).toBe(false);
    expect(cp.capacity.providersFor("cto").map((c) => c.provider)).toEqual(["claude"]);

    const plan = await cp.continuity.evaluate("unknown gpt quota");
    expect(plan.assignments.every((a) => a.provider === "claude")).toBe(true);
  });

  it("an unprobed runtime suspends the provider even with quota remaining", async () => {
    const { cp, clock, gpt } = makePlane();
    gpt.setCapacity({
      ...reading("gpt", clock, [
        { id: "rolling-5h", remainingPercent: 100, resetAt: null, capabilities: FULL },
      ]),
      runtimeHealth: "UNKNOWN",
    });

    await cp.capacity.refresh(RefreshTrigger.DOCTOR_CAPACITY_REPORT, ["gpt"]);
    const capacity = cp.capacity.current("gpt")!;
    expect(capacity.allocationAdmission).toBe("SUSPENDED");
    expect(cp.capacity.isRoutableFor(capacity, "cto")).toBe(false);
  });
});

describe("capacity sensor honesty (§14.2)", () => {
  /** Synthetic fixture value only — it is not a real provider quota claim. */
  const FIXTURE_OBSERVED_REMAINING_PERCENT = 74;

  const capacityFile = (body: unknown): string => {
    const dir = tempDir("acp-capfile-");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "claude.json");
    writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body));
    return file;
  };

  it("a file with no timestamp is an ERROR sensor with an unknown runtime, not a fresh one", () => {
    const clock = new ManualClock("2026-08-12T00:00:00.000Z");
    const file = capacityFile({
      buckets: [{ id: "b", remainingPercent: 100, capabilities: FULL }],
    });
    const out = readCapacityFile("claude", file, clock, 60_000);
    expect(out.sensorHealth).toBe("ERROR");
    expect(out.runtimeHealth).toBe("UNKNOWN");
    expect(out.error).toBe("no observedAt");
  });

  it("an unparsable timestamp is an ERROR sensor rather than a guess", () => {
    const clock = new ManualClock("2026-08-12T00:00:00.000Z");
    const file = capacityFile({
      observedAt: "yesterday-ish",
      buckets: [{ id: "b", remainingPercent: 100, capabilities: FULL }],
    });
    const out = readCapacityFile("claude", file, clock, 60_000);
    expect(out.sensorHealth).toBe("ERROR");
    expect(out.runtimeHealth).toBe("UNKNOWN");
  });

  it("a quota file that states no runtime health leaves it UNKNOWN for the probe to settle", () => {
    const clock = new ManualClock("2026-08-12T00:00:00.000Z");
    const file = capacityFile({
      observedAt: "2026-08-12T00:00:00.000Z",
      buckets: [{ id: "b", remainingPercent: 100, capabilities: FULL }],
    });
    const out = readCapacityFile("claude", file, clock, 60_000);
    expect(out.sensorHealth).toBe("HEALTHY");
    expect(out.runtimeHealth).toBe("UNKNOWN");
  });

  it("an unparsable observedAt cannot be enriched into a healthy sensor", async () => {
    const { cp, clock, gpt } = makePlane();
    gpt.setCapacity({
      ...reading("gpt", clock, [
        { id: "rolling-5h", remainingPercent: 100, resetAt: null, capabilities: FULL },
      ]),
      observedAt: "not-a-date",
      sensorHealth: "HEALTHY",
    });
    await cp.capacity.refresh(RefreshTrigger.DOCTOR_CAPACITY_REPORT, ["gpt"]);
    const capacity = cp.capacity.current("gpt")!;
    expect(capacity.sensorHealth).toBe("ERROR");
    expect(capacity.allocationAdmission).toBe("SUSPENDED");
  });

  it("replaces a prior healthy reading with SUSPENDED when the live collector throws", async () => {
    const { cp, clock, gpt } = makePlane();
    gpt.setCapacity(reading("gpt", clock, [
      { id: "rolling-5h", remainingPercent: 90, resetAt: null, capabilities: FULL },
    ]));
    await cp.capacity.refresh(RefreshTrigger.DOCTOR_CAPACITY_REPORT, ["gpt"]);
    expect(cp.capacity.current("gpt")?.allocationAdmission).toBe("OPEN");

    gpt.probeCapacity = async () => { throw new Error("interactive /usage PTY crashed"); };
    await cp.capacity.refresh(RefreshTrigger.DOCTOR_CAPACITY_REPORT, ["gpt"]);

    const failed = cp.capacity.current("gpt")!;
    expect(failed).toMatchObject({
      sensorHealth: "ERROR",
      allocationAdmission: "SUSPENDED",
      runtimeHealth: "UNKNOWN",
    });
    const admission = await cp.capacity.refreshForBlindReview({
      provider: "gpt",
      capabilities: ["blind-review"],
      priority: "critical",
    });
    expect(admission).toMatchObject({ allowed: false, reasonCode: ReasonCode.CAPACITY_UNKNOWN_NOT_ROUTABLE });
    // If the exception catch/persist step is removed, refresh throws or retains OPEN;
    // either outcome breaks this test instead of routing on the old quota.
  });

  it("a collector ERROR replaces a stale operator observation instead of falling back to it", async () => {
    const { cp, clock, gpt } = makePlane();
    const observed = await cp.capacity.observe({
      provider: "gpt",
      observedAt: clock.nowIso(),
      runtimeHealth: "HEALTHY",
      actor: "fixture-operator",
      // Only the daemon-stamped surface is accepted; a caller-chosen source is refused.
      source: AGENTCTL_CAPACITY_OBSERVATION_SOURCE,
      buckets: [{
        id: "fixture-window",
        remainingPercent: FIXTURE_OBSERVED_REMAINING_PERCENT,
        resetAt: null,
        capabilities: FULL,
      }],
    });
    expect(observed).toMatchObject({ allowed: true, value: { allocationAdmission: "OPEN" } });

    // Make the prior human observation stale before the collector reports its own error.
    // The synthetic fixture error is the newer durable fact and must be the only current one.
    clock.advance(15 * 60 * 1000 + 1);
    gpt.setCapacity({
      provider: "gpt",
      sensorHealth: "ERROR",
      runtimeHealth: "HEALTHY",
      observedAt: clock.nowIso(),
      source: "fixture-collector-error",
      error: "synthetic fixture collector error",
      buckets: [],
    });
    await cp.capacity.refresh(RefreshTrigger.DOCTOR_CAPACITY_REPORT, ["gpt"]);

    const current = cp.capacity.current("gpt")!;
    // Removing the collector-error persist path leaves the old observation in place and
    // fails these source/provenance assertions as well as the immediate suspension check.
    expect(current).toMatchObject({
      sensorHealth: "ERROR",
      allocationAdmission: "SUSPENDED",
      source: "fixture-collector-error",
    });
    expect(current.operatorObservation).toBeUndefined();
    expect(cp.capacity.isRoutableFor(current, "cto")).toBe(false);
  });
});

describe("completion requires a current continuity mode (§15.6)", () => {
  const seed = async (plane: ReturnType<typeof makePlane>) => {
    const manifest = fixtureManifest("cont-hard");
    const project = plane.cp.projects.register({
      projectId: "cont-hard",
      name: "cont-hard",
      manifest,
      authorization: plane.cp.manifestAuthorizationForTests(manifest),
    });
    if (!project.allowed) throw new Error(project.message);
    for (const adapter of [plane.gpt, plane.claude]) {
      adapter.setCapacity(
        reading(adapter.provider, plane.clock, [
          { id: "rolling-5h", remainingPercent: 90, resetAt: null, capabilities: FULL },
        ]),
      );
    }
    await plane.cp.continuity.evaluate("seed");
  };

  it("refuses completion when coverage has never been evaluated", () => {
    const plane = makePlane();
    const decision = plane.cp.continuity.assertCompletionAllowed("run_x");
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.CONTINUITY_SURVIVAL_NO_COMPLETION);
  });

  it("allows completion right after an evaluation and refuses once that evaluation is stale", async () => {
    const plane = makePlane();
    await seed(plane);
    expect(plane.cp.continuity.mode()).toBe(ContinuityMode.NORMAL);
    expect(plane.cp.continuity.assertCompletionAllowed("run_x").allowed).toBe(true);

    // Both providers die, but nothing re-evaluates: the stored NORMAL is now a claim about
    // the past, so it must not license a production-ready completion.
    plane.clock.advance(10 * 60 * 1000);
    expect(plane.cp.continuity.mode()).toBe(ContinuityMode.NORMAL);
    const stale = plane.cp.continuity.assertCompletionAllowed("run_x");
    expect(stale.allowed).toBe(false);
    expect(stale.reasonCode).toBe(ReasonCode.CONTINUITY_SURVIVAL_NO_COMPLETION);
    expect(stale.allowed === false && stale.message.includes("stale")).toBe(true);
  });

  it("a re-evaluation after both providers fail turns the stale NORMAL into SURVIVAL", async () => {
    const plane = makePlane();
    await seed(plane);
    plane.gpt.setRuntimeHealth("UNAVAILABLE");
    plane.claude.setRuntimeHealth("UNAVAILABLE");
    plane.gpt.setCapacity(null);
    plane.claude.setCapacity(null);

    const plan = await plane.cp.continuity.evaluate("both providers down");
    expect(plan.outcome).toBe("NO_VALID_COVERAGE");
    expect(plane.cp.continuity.mode()).toBe(ContinuityMode.SURVIVAL);
    expect(plane.cp.continuity.assertCompletionAllowed("run_x").allowed).toBe(false);
  });
});

describe("failover produces a routable session (§15.7)", () => {
  const bindCeoSession = (plane: ReturnType<typeof makePlane>) => {
    const session = plane.cp.sessions.create({ provider: "gpt", model: "gpt-5.6-sol" });
    plane.cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "test");
    const bound = plane.cp.bindings.bind({
      roleKey: roleKeyFor(Role.CEO),
      role: Role.CEO,
      sessionId: session.sessionId,
    });
    if (!bound.allowed) throw new Error(bound.message);
    return session.sessionId;
  };

  it("refuses to switch the binding when no readiness probe is attached", async () => {
    const plane = makePlane();
    bindCeoSession(plane);
    for (const adapter of [plane.gpt, plane.claude]) {
      adapter.setCapacity(
        reading(adapter.provider, plane.clock, [
          { id: "rolling-5h", remainingPercent: 90, resetAt: null, capabilities: FULL },
        ]),
      );
    }
    await plane.cp.continuity.evaluate("seed");

    // A kernel built from the same components but with no readiness port attached — the
    // shape a caller gets when it forgets to wire the probe.
    const bare = new ContinuityKernel(
      plane.cp.db,
      plane.cp.clock,
      plane.cp.audit,
      plane.cp.capacity,
      plane.cp.providers,
      plane.cp.projects,
      plane.cp.runs,
      plane.cp.sessions,
      plane.cp.bindings,
      plane.cp.telemetry,
    );

    const before = plane.cp.bindings.active(roleKeyFor(Role.CEO))!;
    const decision = await bare.failover(roleKeyFor(Role.CEO), Role.CEO, {}, "test");
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.SESSION_NOT_READY);
    const after = plane.cp.bindings.active(roleKeyFor(Role.CEO))!;
    expect(after.sessionId).toBe(before.sessionId);
    expect(after.bindingGeneration).toBe(before.bindingGeneration);
  });

  it("refuses the switch when the readiness probe fails, leaving the old binding in force", async () => {
    const plane = makePlane();
    bindCeoSession(plane);
    for (const adapter of [plane.gpt, plane.claude]) {
      adapter.setCapacity(
        reading(adapter.provider, plane.clock, [
          { id: "rolling-5h", remainingPercent: 90, resetAt: null, capabilities: FULL },
        ]),
      );
    }
    await plane.cp.continuity.evaluate("seed");
    plane.cp.continuity.attach({
      readiness: {
        checkSession: async () =>
          deny(ReasonCode.SESSION_NOT_READY, "process is not running", {}),
      },
    });

    const before = plane.cp.bindings.active(roleKeyFor(Role.CEO))!;
    const decision = await plane.cp.continuity.failover(roleKeyFor(Role.CEO), Role.CEO, {}, "test");
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.SESSION_NOT_READY);
    const after = plane.cp.bindings.active(roleKeyFor(Role.CEO))!;
    expect(after.sessionId).toBe(before.sessionId);
    expect(after.bindingGeneration).toBe(before.bindingGeneration);
  });

  it("switches the binding once the new session is shown to be ready", async () => {
    const plane = makePlane();
    bindCeoSession(plane);
    for (const adapter of [plane.gpt, plane.claude]) {
      adapter.setCapacity(
        reading(adapter.provider, plane.clock, [
          { id: "rolling-5h", remainingPercent: 90, resetAt: null, capabilities: FULL },
        ]),
      );
    }
    await plane.cp.continuity.evaluate("seed");
    const probed: string[] = [];
    plane.cp.continuity.attach({
      readiness: {
        checkSession: async (sessionId: string) => {
          probed.push(sessionId);
          return allow(ReasonCode.OK, undefined);
        },
      },
      buzz: {
        connect: async (sessionId: string) => allow(ReasonCode.OK, `buzz:${sessionId}`),
      },
    });

    const before = plane.cp.bindings.active(roleKeyFor(Role.CEO))!;
    const decision = await plane.cp.continuity.failover(roleKeyFor(Role.CEO), Role.CEO, {}, "test");
    expect(decision.allowed).toBe(true);
    const after = plane.cp.bindings.active(roleKeyFor(Role.CEO))!;
    expect(after.sessionId).not.toBe(before.sessionId);
    expect(after.bindingGeneration).toBe(before.bindingGeneration + 1);
    expect(probed).toEqual([after.sessionId]);
  });
});
