import { afterAll, describe, expect, it } from "vitest";

import { Daemon } from "../../src/daemon/daemon.ts";
import { ExecutionMode, SessionLifecycle } from "../../src/domain/types.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { makeHarness, registerFixtureProject } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

const activeRun = async () => {
  const h = makeHarness();
  const { projectId } = await registerFixtureProject(h);
  const created = h.cp.runs.create({
    projectId, executionMode: ExecutionMode.SIMPLE,
    contract: { goal: "local work", why: "test", scope: [], nonGoals: [], acceptance: ["done"], priority: "NORMAL", humanGate: [], references: [] },
  });
  if (!created.allowed) throw new Error(created.message);
  const dispatched = await h.cp.runs.dispatch(created.value.runId);
  if (!dispatched.allowed) throw new Error(dispatched.message);
  const binding = h.cp.bindings.activePrimaryCto(projectId)!;
  return { h, run: dispatched.value, binding, daemon: new Daemon(h.cp, { stateDir: h.root }) };
};

describe("capacity observations do not evict a live local holder", () => {
  it.each([0, null, 2])("keeps active work and its holder with remaining quota %s", async (remainingPercent) => {
    const { h, run, binding, daemon } = await activeRun();
    h.scripted.setCapacity({
      provider: "scripted", observedAt: h.clock.nowIso(), sensorHealth: "ERROR", runtimeHealth: "UNKNOWN", source: "test",
      buckets: [{ id: "quota", remainingPercent, resetAt: null, capabilities: ["cto", "ceo"] }],
    });
    const report = await daemon.reconcileContinuity("advisory quota");
    expect(h.cp.bindings.active(binding.roleKey)).toEqual(binding);
    expect(h.cp.runs.require(run.runId).state).toBe("ACTIVE");
    expect(report?.pausedRuns).toEqual([]);
    expect(report?.reassigned).toEqual([]);
    expect(report?.unresolved).toEqual([]);
    expect(report?.plan.action).toBe("FALLBACK_ROLE");
  });

  it("still withdraws an endpoint whose session is lost", async () => {
    const { h, run, binding, daemon } = await activeRun();
    h.cp.sessions.transition(binding.sessionId, SessionLifecycle.ERROR, "runtime lost");
    await daemon.reconcileContinuity("runtime lost");
    expect(h.cp.bindings.active(binding.roleKey)?.assignmentId).not.toBe(binding.assignmentId);
    expect(h.cp.runs.require(run.runId).ownerSessionId).not.toBe(binding.sessionId);
  });
});
