import { afterAll, describe, expect, it } from "vitest";

import {
  AGENTCTL_CAPACITY_OBSERVATION_SOURCE,
  RefreshTrigger,
} from "../../src/capacity/capacity-monitor.ts";
import { createOperatorClient, dispatch as dispatchCli } from "../../src/cli/agentctl.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ContinuityMode, ExecutionMode } from "../../src/domain/types.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import {
  bindWorker,
  makeHarness,
  makeStartedOperator,
  registerFixtureProject,
  TEST_OPERATOR_TOKEN,
  TEST_OWNER,
} from "../helpers/harness.ts";

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

/** Synthetic test fixture only — this is not a claimed provider quota. */
const FIXTURE_OBSERVED_REMAINING_PERCENT = 73;

const fixtureOperatorObservation = (observedAt: string) => ({
  observedAt,
  buckets: [{
    id: "fixture-operator-window",
    remainingPercent: FIXTURE_OBSERVED_REMAINING_PERCENT,
    resetAt: null,
    // The scripted adapter's own window serves ceo as well, and an operator reading a real
    // provider's usage page reports the window, not a subset of it. Omitting "ceo" left the
    // global CEO role uncoverable, which is NO_VALID_COVERAGE and therefore SURVIVAL whenever
    // no project has work — a state the fixture invented rather than one #424 describes.
    capabilities: ["ceo", "cto", "worker", "blind-review"],
  }],
});

const createQueuedCtoRun = (
  harness: ReturnType<typeof makeHarness>,
  projectId: string,
  repositoryId: string,
) => {
  const created = harness.cp.runs.create({
    projectId,
    executionMode: ExecutionMode.STANDARD,
    contract: {
      goal: "admit an operator-observed capacity fixture",
      why: "dispatch must use a current provenance-bearing observation",
      scope: ["src/app.js"],
      nonGoals: [],
      acceptance: ["dispatch uses the current observed CTO quota"],
      priority: "NORMAL",
      humanGate: [],
      references: [],
    },
    repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "main" }],
  });
  if (!created.allowed) throw new Error(created.message);
  return created.value.runId;
};

/**
 * Builds a real dispatched run, then records two capacity observations so the production
 * worker allocator has a measured burn rate rather than an invented zero. The assertion
 * below is on `startWorkerExecution`'s result — the monitor calls here only establish its
 * durable input history.
 */
const startWorkerFanoutWith = async (remainingPercent: number) => {
  const harness = makeHarness();
  const { projectId, repositoryId } = await registerFixtureProject(harness, "worker-reserve-project");
  // After the history sample there is one reset-hour left. One percent of measured burn
  // alone would admit 25%; it is the durable CTO/review role demand that withholds it.
  const resetAt = new Date(harness.clock.now().getTime() + 2 * 60 * 60 * 1000).toISOString();
  const capacity = (remaining: number) => ({
    provider: "scripted",
    sensorHealth: "HEALTHY" as const,
    runtimeHealth: "HEALTHY" as const,
    observedAt: harness.clock.nowIso(),
    source: "worker-fanout-admission-test",
    buckets: [{
      id: "rolling-worker",
      remainingPercent: remaining,
      resetAt,
      capabilities: ["cto", "worker"],
    }],
  });
  harness.scripted.setCapacity(capacity(Math.min(100, remainingPercent + 1)));
  const created = harness.cp.runs.create({
    projectId,
    executionMode: ExecutionMode.STANDARD,
    contract: {
      goal: "exercise the worker reserve through its allocation path",
      why: "critical-role capacity must survive fan-out",
      scope: ["src/app.js"],
      nonGoals: [],
      acceptance: ["worker allocation is admitted only above the dynamic reserve"],
      priority: "NORMAL",
      humanGate: [],
      references: [],
    },
    repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
  });
  if (!created.allowed) throw new Error(created.message);
  const dispatched = await harness.cp.runs.dispatch(created.value.runId);
  if (!dispatched.allowed) throw new Error(dispatched.message);
  const submitted = harness.cp.tasks.submit(created.value.runId, [
    { key: "worker", title: "lower-priority worker", category: "mechanical" },
  ]);
  if (!submitted.allowed) throw new Error(submitted.message);

  harness.clock.advance(60 * 60 * 1000);
  harness.scripted.setCapacity(capacity(remainingPercent));
  await harness.cp.capacity.refresh(RefreshTrigger.DOCTOR_CAPACITY_REPORT, ["scripted"]);
  const task = harness.cp.tasks.ready(created.value.runId)[0]!;
  const workerSessionId = bindWorker(harness, task.taskId);
  return {
    harness,
    started: await harness.cp.tasks.startWorkerExecution({
      runId: created.value.runId,
      taskId: task.taskId,
      ownerBindingGeneration: dispatched.value.ownerBindingGeneration!,
      workerSessionId,
      provider: "scripted",
      model: "worker",
      repositoryId,
      concurrencyWidth: 2,
    }),
  };
};

describe("dispatch admission is asked about the allocation it will make", () => {
  it("routes a current daemon-authenticated observation through RunEngine.dispatch, then suspends it at staleness", async () => {
    const running = await makeStartedOperator();
    try {
      const { harness } = running;
      // Synthetic collector failure: establish the same SUSPENDED state the live host has
      // before the authenticated fixture observation is submitted through the real socket.
      harness.scripted.setCapacity({
        provider: "scripted",
        sensorHealth: "ERROR",
        runtimeHealth: "HEALTHY",
        observedAt: harness.clock.nowIso(),
        source: "fixture-collector-error",
        error: "synthetic fixture collector could not expose quota",
        buckets: [],
      });
      await harness.cp.capacity.refresh(RefreshTrigger.DOCTOR_CAPACITY_REPORT, ["scripted"]);
      expect(harness.cp.capacity.current("scripted")?.allocationAdmission).toBe("SUSPENDED");

      const cli = createOperatorClient({ socketPath: running.socketPath, token: TEST_OPERATOR_TOKEN });
      const observeCode = await dispatchCli(
        cli,
        "capacity",
        ["observe", "scripted", JSON.stringify(fixtureOperatorObservation(harness.clock.nowIso()))],
        false,
      );
      expect(observeCode).toBe(0);
      expect(harness.cp.capacity.current("scripted")).toMatchObject({
        allocationAdmission: "OPEN",
        source: AGENTCTL_CAPACITY_OBSERVATION_SOURCE,
        operatorObservation: { actor: TEST_OWNER.actor, source: AGENTCTL_CAPACITY_OBSERVATION_SOURCE },
      });
      expect(harness.cp.audit.byKind("CAPACITY_OPERATOR_OBSERVATION")).toMatchObject([
        expect.objectContaining({
          actor: TEST_OWNER.actor,
          evidence: expect.objectContaining({ source: AGENTCTL_CAPACITY_OBSERVATION_SOURCE }),
        }),
      ]);

      const { projectId, repositoryId } = await registerFixtureProject(harness, "operator-observation-dispatch");
      const dispatched = await harness.cp.runs.dispatch(createQueuedCtoRun(harness, projectId, repositoryId));
      // This is the production admission path. Removing the operator-observation branch in
      // `refreshForAllocation` re-probes the synthetic ERROR collector and makes this false.
      expect(dispatched.allowed).toBe(true);

      // The existing stale-grace limit is an absolute age from observedAt. Past it, the same
      // saved observation must produce the same non-routable result as a collector ERROR.
      harness.clock.advance(15 * 60 * 1000 + 1);
      const stale = harness.cp.runs.dispatch(createQueuedCtoRun(harness, projectId, repositoryId));
      await expect(stale).resolves.toMatchObject({
        allowed: false,
        reasonCode: ReasonCode.CAPACITY_UNKNOWN_NOT_ROUTABLE,
      });
      // Past the grace the gate probes as §14.2 says it does, the expired observation no
      // longer protects the ERROR from replacing it, and the honest collector failure is
      // what the operator is left looking at.
      expect(harness.cp.capacity.current("scripted")).toMatchObject({
        sensorHealth: "ERROR",
        allocationAdmission: "SUSPENDED",
        source: "fixture-collector-error",
      });
      expect(harness.cp.capacity.current("scripted")?.operatorObservation).toBeUndefined();

      const refusedWithoutProvenance = await harness.cp.capacity.observe({
        provider: "scripted",
        observedAt: harness.clock.nowIso(),
        buckets: fixtureOperatorObservation(harness.clock.nowIso()).buckets,
        runtimeHealth: "HEALTHY",
        actor: "",
        source: "",
      });
      // Deleting provenance validation turns this specific refusal into an admitted reading.
      expect(refusedWithoutProvenance).toMatchObject({
        allowed: false,
        reasonCode: ReasonCode.CAPACITY_OBSERVATION_PROVENANCE_REQUIRED,
      });
    } finally {
      await running.close();
    }
  });

  it("#424 keeps a current observation routable across the daemon's own collector refresh", async () => {
    const running = await makeStartedOperator();
    try {
      const { harness } = running;
      // The host this exists for: the collector cannot read quota and returns ERROR every
      // time it is asked.
      harness.scripted.setCapacity({
        provider: "scripted",
        sensorHealth: "ERROR",
        runtimeHealth: "HEALTHY",
        observedAt: harness.clock.nowIso(),
        source: "fixture-collector-error",
        error: "synthetic fixture collector could not expose quota",
        buckets: [],
      });

      const cli = createOperatorClient({ socketPath: running.socketPath, token: TEST_OPERATOR_TOKEN });
      expect(
        await dispatchCli(
          cli,
          "capacity",
          ["observe", "scripted", JSON.stringify(fixtureOperatorObservation(harness.clock.nowIso()))],
          false,
        ),
      ).toBe(0);

      const { projectId, repositoryId } = await registerFixtureProject(harness, "observation-survives-refresh");
      expect((await harness.cp.runs.dispatch(createQueuedCtoRun(harness, projectId, repositoryId))).allowed)
        .toBe(true);

      // `Daemon.refreshCapacitySensors` runs this every four minutes, and
      // `ContinuityKernel.evaluate` runs it again — both unconditionally. An observation
      // that a failing collector can erase is one that never survives to be used.
      harness.clock.advance(4 * 60 * 1000);
      await harness.cp.capacity.refresh(RefreshTrigger.DOCTOR_CAPACITY_REPORT, ["scripted"]);

      expect(harness.cp.capacity.current("scripted")).toMatchObject({
        allocationAdmission: "OPEN",
        operatorObservation: { actor: TEST_OWNER.actor },
      });
      expect((await harness.cp.runs.dispatch(createQueuedCtoRun(harness, projectId, repositoryId))).allowed)
        .toBe(true);

      // Expiry is still the only thing that ends it. Past the stale grace the observation
      // suspends, whether or not any collector ever answered.
      harness.clock.advance(15 * 60 * 1000 + 1);
      await expect(harness.cp.runs.dispatch(createQueuedCtoRun(harness, projectId, repositoryId)))
        .resolves.toMatchObject({
          allowed: false,
          reasonCode: ReasonCode.CAPACITY_UNKNOWN_NOT_ROUTABLE,
        });
    } finally {
      await running.close();
    }
  });

  it("#424 lets a live exhaustion reading refuse a run that a current observation would admit", async () => {
    const running = await makeStartedOperator();
    try {
      const { harness } = running;
      harness.scripted.setCapacity({
        provider: "scripted",
        sensorHealth: "ERROR",
        runtimeHealth: "HEALTHY",
        observedAt: harness.clock.nowIso(),
        source: "fixture-collector-error",
        error: "synthetic fixture collector could not expose quota",
        buckets: [],
      });
      const cli = createOperatorClient({ socketPath: running.socketPath, token: TEST_OPERATOR_TOKEN });
      expect(
        await dispatchCli(
          cli,
          "capacity",
          ["observe", "scripted", JSON.stringify(fixtureOperatorObservation(harness.clock.nowIso()))],
          false,
        ),
      ).toBe(0);

      const { projectId, repositoryId } = await registerFixtureProject(harness, "live-exhaustion-wins");
      expect((await harness.cp.runs.dispatch(createQueuedCtoRun(harness, projectId, repositoryId))).allowed)
        .toBe(true);

      // The collector comes back and reports the provider is nearly out. The observation
      // still says 73%, and is still inside its window — but a measurement outranks a
      // recollection, and §14.2's gate is supposed to be asking the collector, not reading
      // a cache. If dispatch skipped the probe while an observation was current, this run
      // would be admitted against quota that no longer exists.
      harness.clock.advance(60 * 1000);
      harness.scripted.setCapacity({
        provider: "scripted",
        sensorHealth: "HEALTHY",
        runtimeHealth: "HEALTHY",
        observedAt: harness.clock.nowIso(),
        source: "recovered-collector",
        buckets: [{ id: "recovered", remainingPercent: 1, resetAt: null, capabilities: ["cto"] }],
      });

      await expect(harness.cp.runs.dispatch(createQueuedCtoRun(harness, projectId, repositoryId)))
        .resolves.toMatchObject({ allowed: false });
      expect(harness.cp.capacity.current("scripted")?.operatorObservation).toBeUndefined();
    } finally {
      await running.close();
    }
  });

  it("#424 restores dispatch on a control plane that has actually entered SURVIVAL", async () => {
    // The live #424 host, reproduced: every collector returns ERROR, so every provider is
    // SUSPENDED, so no required role is coverable, so coverage is NO_VALID_COVERAGE and
    // continuity is SURVIVAL. RunEngine.dispatch reads that stored mode at run-engine.ts:261
    // — before it looks at capacity at :311 — so an observation that fixes capacity and
    // nothing else leaves the run refused for a reason capacity cannot answer.
    const running = await makeStartedOperator();
    try {
      const { harness } = running;
      harness.scripted.setCapacity({
        provider: "scripted",
        sensorHealth: "ERROR",
        runtimeHealth: "HEALTHY",
        observedAt: harness.clock.nowIso(),
        source: "fixture-collector-error",
        error: "synthetic fixture collector could not expose quota",
        buckets: [],
      });
      await harness.cp.capacity.refresh(RefreshTrigger.DOCTOR_CAPACITY_REPORT, ["scripted"]);
      await harness.cp.continuity.evaluate("collectors are failing on this host");
      expect(harness.cp.continuity.mode()).toBe(ContinuityMode.SURVIVAL);

      const { projectId, repositoryId } = await registerFixtureProject(harness, "survival-recovery");
      await expect(harness.cp.runs.dispatch(createQueuedCtoRun(harness, projectId, repositoryId)))
        .resolves.toMatchObject({
          allowed: false,
          reasonCode: ReasonCode.CONTINUITY_SURVIVAL_NO_COMPLETION,
        });

      // One authenticated observation through the real socket, and nothing else.
      const cli = createOperatorClient({ socketPath: running.socketPath, token: TEST_OPERATOR_TOKEN });
      expect(
        await dispatchCli(
          cli,
          "capacity",
          ["observe", "scripted", JSON.stringify(fixtureOperatorObservation(harness.clock.nowIso()))],
          false,
        ),
      ).toBe(0);

      // The observation changed an input to the coverage judgement, so the judgement is
      // recomputed — no separate operator step, no waiting for the four-minute tick.
      expect(harness.cp.continuity.mode()).not.toBe(ContinuityMode.SURVIVAL);
      expect((await harness.cp.runs.dispatch(createQueuedCtoRun(harness, projectId, repositoryId))).allowed)
        .toBe(true);
    } finally {
      await running.close();
    }
  });

  it("#424 does not refuse dispatch on a SURVIVAL verdict nothing has revisited", async () => {
    // §15.6's rule already existed on the completion path: a mode computed before the
    // providers changed is not evidence. Dispatch lacked it, and the omission mattered more
    // here — refusing at run-engine.ts:261 returns before `refreshForDispatch`, which is the
    // only call that would have produced a newer verdict. So one tick's SURVIVAL refused
    // every dispatch until the next tick, with nothing able to revise it in between.
    const running = await makeStartedOperator();
    try {
      const { harness } = running;
      harness.scripted.setCapacity({
        provider: "scripted",
        sensorHealth: "ERROR",
        runtimeHealth: "HEALTHY",
        observedAt: harness.clock.nowIso(),
        source: "fixture-collector-error",
        error: "synthetic fixture collector could not expose quota",
        buckets: [],
      });
      await harness.cp.capacity.refresh(RefreshTrigger.DOCTOR_CAPACITY_REPORT, ["scripted"]);
      await harness.cp.continuity.evaluate("collectors failing");
      expect(harness.cp.continuity.mode()).toBe(ContinuityMode.SURVIVAL);

      // Capacity recovers, but nothing re-evaluates coverage — exactly the gap between two
      // four-minute daemon ticks.
      harness.scripted.setCapacity({
        provider: "scripted",
        sensorHealth: "HEALTHY",
        runtimeHealth: "HEALTHY",
        observedAt: harness.clock.nowIso(),
        source: "recovered-collector",
        buckets: [{
          id: "recovered",
          remainingPercent: 80,
          resetAt: null,
          capabilities: ["ceo", "cto", "worker", "blind-review"],
        }],
      });
      // Persist the recovered reading the way the daemon's sensor timer does — but do not
      // re-evaluate coverage. That is precisely the state between two ticks: capacity is
      // current, the continuity verdict is not.
      await harness.cp.capacity.refresh(RefreshTrigger.DOCTOR_CAPACITY_REPORT, ["scripted"]);
      expect(harness.cp.continuity.mode()).toBe(ContinuityMode.SURVIVAL);

      // Past §15.6's freshness window, so the stored SURVIVAL is no longer evidence.
      harness.clock.advance(6 * 60 * 1000);

      const { projectId, repositoryId } = await registerFixtureProject(harness, "stale-survival");
      const dispatched = await harness.cp.runs.dispatch(createQueuedCtoRun(harness, projectId, repositoryId));
      expect(
        dispatched.allowed,
        `mode=${harness.cp.continuity.mode()} ageMs=${harness.cp.continuity.modeAgeMs()} reason=${dispatched.reasonCode}`,
      ).toBe(true);
    } finally {
      await running.close();
    }
  });

  it("#424 still refuses dispatch when a fresh evaluation says SURVIVAL", async () => {
    // The other half: re-evaluating is not the same as ignoring. When coverage is genuinely
    // gone, a fresh verdict says SURVIVAL and dispatch is still refused.
    const running = await makeStartedOperator();
    try {
      const { harness } = running;
      harness.scripted.setCapacity({
        provider: "scripted",
        sensorHealth: "ERROR",
        runtimeHealth: "HEALTHY",
        observedAt: harness.clock.nowIso(),
        source: "fixture-collector-error",
        error: "synthetic fixture collector could not expose quota",
        buckets: [],
      });
      await harness.cp.capacity.refresh(RefreshTrigger.DOCTOR_CAPACITY_REPORT, ["scripted"]);
      await harness.cp.continuity.evaluate("collectors failing");
      expect(harness.cp.continuity.mode()).toBe(ContinuityMode.SURVIVAL);
      harness.clock.advance(6 * 60 * 1000);

      const { projectId, repositoryId } = await registerFixtureProject(harness, "real-survival");
      await expect(harness.cp.runs.dispatch(createQueuedCtoRun(harness, projectId, repositoryId)))
        .resolves.toMatchObject({
          allowed: false,
          reasonCode: ReasonCode.CONTINUITY_SURVIVAL_NO_COMPLETION,
        });
    } finally {
      await running.close();
    }
  });

  it("#424 refuses an observation whose source the daemon did not stamp", async () => {
    const harness = makeHarness();
    const wellFormed = fixtureOperatorObservation(harness.clock.nowIso());

    // Everything else about this call is valid — a registered provider, a fresh timestamp,
    // well-formed buckets, a non-empty actor. The only defect is that its provenance was
    // chosen by the caller, which is the shape a local JSON file would take. That is what
    // P0-11 removed and what this must not let back in through a different door.
    const forged = await harness.cp.capacity.observe({
      provider: "scripted",
      observedAt: wellFormed.observedAt,
      buckets: wellFormed.buckets,
      runtimeHealth: "HEALTHY",
      actor: "someone-who-said-so",
      source: "~/.agent-control-plane/capacity/scripted.json",
    });
    expect(forged).toMatchObject({
      allowed: false,
      reasonCode: ReasonCode.CAPACITY_OBSERVATION_PROVENANCE_REQUIRED,
    });
    expect(harness.cp.capacity.current("scripted")?.operatorObservation).toBeUndefined();

    // The same reading through the daemon's own surface is accepted.
    expect(
      (await harness.cp.capacity.observe({
        provider: "scripted",
        observedAt: wellFormed.observedAt,
        buckets: wellFormed.buckets,
        runtimeHealth: "HEALTHY",
        actor: "someone-who-said-so",
        source: AGENTCTL_CAPACITY_OBSERVATION_SOURCE,
      })).allowed,
    ).toBe(true);
  });

  it("#424 lets a collector that recovers replace the observation with its own reading", async () => {
    const running = await makeStartedOperator();
    try {
      const { harness } = running;
      harness.scripted.setCapacity({
        provider: "scripted",
        sensorHealth: "ERROR",
        runtimeHealth: "HEALTHY",
        observedAt: harness.clock.nowIso(),
        source: "fixture-collector-error",
        error: "synthetic fixture collector could not expose quota",
        buckets: [],
      });
      const cli = createOperatorClient({ socketPath: running.socketPath, token: TEST_OPERATOR_TOKEN });
      expect(
        await dispatchCli(
          cli,
          "capacity",
          ["observe", "scripted", JSON.stringify(fixtureOperatorObservation(harness.clock.nowIso()))],
          false,
        ),
      ).toBe(0);
      expect(harness.cp.capacity.current("scripted")?.operatorObservation).toBeDefined();

      // A real reading is better evidence than a human's recollection, so it must win —
      // otherwise the observation would pin the provider until it expired and the system
      // would ignore a collector that started working.
      harness.clock.advance(60 * 1000);
      harness.scripted.setCapacity({
        provider: "scripted",
        sensorHealth: "HEALTHY",
        runtimeHealth: "HEALTHY",
        observedAt: harness.clock.nowIso(),
        source: "recovered-collector",
        buckets: [
          { id: "recovered", remainingPercent: 1, resetAt: null, capabilities: ["cto"] },
        ],
      });
      await harness.cp.capacity.refresh(RefreshTrigger.DOCTOR_CAPACITY_REPORT, ["scripted"]);

      const current = harness.cp.capacity.current("scripted");
      expect(current?.operatorObservation).toBeUndefined();
      expect(current?.source).toBe("recovered-collector");
      // And its content is honoured, not just its existence: 1% is below the exhaustion
      // threshold, so the recovered collector suspends what the observation had opened.
      expect(current?.allocationAdmission).toBe("SUSPENDED");
    } finally {
      await running.close();
    }
  });

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

  it("#55/#182 refuses a worker fan-out that would consume the dynamic critical-role reserve", async () => {
    // The dispatch itself succeeds. Only its later worker allocation is denied, proving the
    // reserve is consumed at the production worker path rather than in a monitor-only test.
    const { harness, started } = await startWorkerFanoutWith(25);
    expect(started.allowed).toBe(false);
    expect(started.reasonCode).toBe(ReasonCode.CAPACITY_ADMISSION_CONSERVE);
    expect(harness.cp.tasks.executions(harness.cp.runs.list()[0]!.runId)).toHaveLength(0);
    harness.cp.close();
  });

  it("#55/#182 admits the same worker fan-out when capacity remains above that reserve", async () => {
    const { harness, started } = await startWorkerFanoutWith(99);
    expect(started.allowed).toBe(true);
    expect(started.reasonCode).toBe(ReasonCode.OK);
    harness.cp.close();
  });
});
