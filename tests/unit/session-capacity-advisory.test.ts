import { afterAll, describe, expect, it, vi } from "vitest";

import { ContinuityMode, ExecutionMode, Role, SessionLifecycle } from "../../src/domain/types.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { bootstrapCtoProvider, makeHarness, registerFixtureProject } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

describe("local session and capacity reuse", () => {
  it.each([0, null, 2])("attempts the selected provider with quota %s and no reserve proof", async (remainingPercent) => {
    const h = makeHarness();
    vi.spyOn(h.scripted, "probeCapacity").mockResolvedValue({
      provider: "scripted", observedAt: h.clock.nowIso(), sensorHealth: "ERROR", runtimeHealth: "UNKNOWN",
      source: "test", buckets: [{ id: "quota", remainingPercent, resetAt: null, capabilities: ["worker", "cto"] }],
    });
    expect((await h.cp.capacity.refreshForWorkerFanout({ provider: "scripted", capabilities: ["worker"] })).allowed).toBe(true);
    const { projectId } = await registerFixtureProject(h);
    const created = h.cp.runs.create({
      projectId, executionMode: ExecutionMode.STANDARD,
      contract: { goal: "work", why: "local", scope: [], nonGoals: [], acceptance: ["done"], priority: "NORMAL", humanGate: [], references: [] },
    });
    if (!created.allowed) throw new Error(created.message);
    // A persisted old coverage mode must not veto today's selected provider.
    h.cp.db.run("UPDATE continuity_state SET mode = 'SURVIVAL' WHERE id = 1");
    const dispatched = await h.cp.runs.dispatch(created.value.runId);
    expect(dispatched.allowed, JSON.stringify(dispatched)).toBe(true);
  });

  it("permits completion with stale coverage, while reporting the observation", () => {
    const h = makeHarness();
    h.cp.db.run("UPDATE continuity_state SET mode = 'SURVIVAL', evaluated_at = NULL WHERE id = 1");
    expect(h.cp.continuity.mode()).toBe(ContinuityMode.SURVIVAL);
    expect(h.cp.continuity.assertCompletionAllowed("run-local").allowed).toBe(true);
    expect(h.cp.continuity.computeCoveragePlan().action).toBe("FALLBACK_ROLE");
  });

  it("reuses a bootstrap session for another role and keeps one live holder per role key", () => {
    const h = makeHarness();
    const session = h.cp.sessions.create({ provider: "scripted", model: "test" });
    h.cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "connected");
    expect(h.cp.bindings.bind({ role: Role.BOOTSTRAP_CTO, runId: "old", sessionId: session.sessionId }).allowed).toBe(true);
    expect(h.cp.bindings.bind({ role: Role.CEO, sessionId: session.sessionId }).allowed).toBe(true);
    const other = h.cp.sessions.create({ provider: "scripted", model: "test" });
    h.cp.sessions.transition(other.sessionId, SessionLifecycle.READY, "connected");
    expect(h.cp.bindings.bind({ role: Role.CEO, sessionId: other.sessionId }).allowed).toBe(false);
  });

  it("readiness authenticates the current credential and uses liveness without invoking a turn", async () => {
    const h = makeHarness();
    const runtime = bootstrapCtoProvider(h.cp, h.clock);
    const handle = await runtime.startSession({ model: "opus", workdir: "/fixture", purpose: "test" });
    const session = h.cp.sessions.create({ provider: "claude", model: "opus", incarnation: `${handle.externalSessionId}#fixture` });
    h.cp.sessionRuntime.adopt(session.sessionId, Role.BOOTSTRAP_CTO, session.sessionSecret!, session.credentialEpoch);
    expect((await h.cp.sessionRuntime.attest(session.sessionId, "new")).allowed).toBe(true);
    expect((await h.cp.sessionRuntime.probe(session.sessionId)).allowed).toBe(true);
    vi.spyOn(runtime, "probeRuntime").mockRejectedValueOnce(new Error("runtime unavailable"));
    expect((await h.cp.sessionRuntime.attest(session.sessionId, "resume")).allowed).toBe(false);
    expect(runtime.turns).toHaveLength(0);
    expect(h.cp.sessionAttestations.attest({ sessionId: session.sessionId, sessionIncarnation: "wrong", sessionSecret: session.sessionSecret! }).allowed).toBe(false);
    expect(h.cp.sessionAttestations.attest({ sessionId: session.sessionId, sessionIncarnation: session.incarnation, sessionSecret: "wrong" }).allowed).toBe(false);
  });
});
