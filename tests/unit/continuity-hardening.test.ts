import { afterAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

import { ManualClock } from "../../src/core/clock.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { allow, deny } from "../../src/core/errors.ts";
import { ControlPlane } from "../../src/app/control-plane.ts";
import { RefreshTrigger } from "../../src/capacity/capacity-monitor.ts";
import { ContinuityMode, Role, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { ContinuityKernel } from "../../src/continuity/continuity-kernel.ts";
import type { CapacityReading } from "../../src/runtime/provider.ts";
import { readCapacityFile } from "../../src/runtime/cli-adapters.ts";
import { ScriptedAdapter } from "../../src/runtime/scripted-adapter.ts";
import { cleanupTempDirs, makeRepo, tempDir } from "../helpers/fixtures.ts";
import { fixtureManifest } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

const makePlane = () => {
  const root = tempDir("acp-cont-hard-");
  const clock = new ManualClock("2026-08-12T00:00:00.000Z");
  const gpt = new ScriptedAdapter(clock, "gpt");
  const claude = new ScriptedAdapter(clock, "claude");
  const repoPath = makeRepo({ "src/app.js": "module.exports = () => 1;\n" });

  const cp = new ControlPlane({
    databasePath: join(root, "state.sqlite"),
    worktreeRoot: join(root, "worktrees"),
    capacityDir: join(root, "capacity"),
    secretsDir: join(root, "secrets"),
    clock,
    adapters: [gpt, claude],
    allowNonProductionAdapters: true,
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
});

describe("completion requires a current continuity mode (§15.6)", () => {
  const seed = async (plane: ReturnType<typeof makePlane>) => {
    const manifest = fixtureManifest("cont-hard");
    const project = plane.cp.projects.register({
      projectId: "cont-hard",
      name: "cont-hard",
      manifest,
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
