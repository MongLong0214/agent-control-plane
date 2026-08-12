import { afterAll, describe, expect, it } from "vitest";

import { RefreshTrigger } from "../../src/capacity/capacity-monitor.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ExecutionMode } from "../../src/domain/types.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { makeHarness, registerFixtureProject } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * §14.3 admission asked about the allocation a dispatch will actually make (#53, #179, #311).
 *
 * The existing capacity tests call `refreshForDispatch` directly, which is what #311 objects to:
 * a monitor that answers correctly proves nothing about whether the production path asks it the
 * right question. These drive `RunEngine.dispatch` instead, and the proof is the *difference* in
 * outcome — a run is refused when the provider it would route to has no quota for the capability
 * it needs, while a provider with quota for an unrelated capability does not rescue it. If the
 * composition root dropped the target again (it did, and 168 tests failed on it), the refusal
 * would disappear because some provider is always healthy.
 */
const dispatchWith = async (
  buckets: Array<{ id: string; remainingPercent: number | null; capabilities: string[] }>,
) => {
  const harness = makeHarness();
  const { projectId, repositoryId } = await registerFixtureProject(harness);
  harness.scripted.setCapacity({
    provider: "scripted",
    sensorHealth: "HEALTHY",
    runtimeHealth: "HEALTHY",
    observedAt: harness.clock.nowIso(),
    source: "dispatch-admission-test",
    buckets: buckets.map((bucket) => ({ ...bucket, resetAt: null })),
  });
  await harness.cp.capacity.refresh(RefreshTrigger.DOCTOR_CAPACITY_REPORT, ["scripted"]);

  const created = harness.cp.runs.create({
    projectId,
    executionMode: ExecutionMode.STANDARD,
    contract: {
      goal: "prove dispatch consults the allocation it will make",
      why: "admission that ignores the target is not admission",
      scope: ["src/app.js"],
      nonGoals: [],
      acceptance: ["the run dispatches only when its own provider has quota for its role"],
      priority: "NORMAL",
      humanGate: [],
      references: [],
    },
    repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "main" }],
  });
  if (!created.allowed) throw new Error(created.message);
  return { harness, dispatched: await harness.cp.runs.dispatch(created.value.runId) };
};

describe("dispatch admission is asked about the allocation it will make", () => {
  it("refuses a run whose own provider has no quota for the role it needs", async () => {
    // Quota exists — for a capability this run does not need. A targetless admission would
    // read this as "a healthy provider is available" and dispatch.
    const { harness, dispatched } = await dispatchWith([
      { id: "worker-only", remainingPercent: 90, capabilities: ["worker"] },
    ]);
    expect(dispatched.allowed).toBe(false);
    expect(dispatched.reasonCode).toBe(ReasonCode.CAPACITY_UNKNOWN_NOT_ROUTABLE);
    // The refusal names the provider the dispatch would have used, which is only knowable if
    // the target reached the monitor.
    expect(JSON.stringify(dispatched.evidence)).toContain("scripted");
    harness.cp.close();
  });

  it("dispatches when that provider does have quota for the role", async () => {
    const { harness, dispatched } = await dispatchWith([
      { id: "rolling", remainingPercent: 80, capabilities: ["cto", "worker", "blind-review"] },
    ]);
    expect(dispatched.allowed).toBe(true);
    harness.cp.close();
  });
});
