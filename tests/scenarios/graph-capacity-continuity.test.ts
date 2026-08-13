import { afterAll, describe, expect, it } from "vitest";
import { join } from "node:path";

import { ManualClock } from "../../src/core/clock.ts";
import { BuzzAdapter, InMemoryBuzzTransport } from "../../src/buzz/buzz-adapter.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ControlPlane } from "../../src/app/control-plane.ts";
import { RefreshTrigger } from "../../src/capacity/capacity-monitor.ts";
import { ContinuityMode, ExecutionMode, Role, RunState, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import type { CapacityReading } from "../../src/runtime/provider.ts";
import { cleanupTempDirs, makeRepo, tempDir } from "../helpers/fixtures.ts";
import { fixtureManifest } from "../helpers/harness.ts";
import { TestProductionAdapter } from "../helpers/production-adapter.ts";
import type { TaskContract } from "../../src/run/run-engine.ts";

afterAll(cleanupTempDirs);

const CONTRACT: TaskContract = {
  goal: "scenario",
  why: "scenario",
  scope: [],
  nonGoals: [],
  acceptance: ["verify.js exits 0"],
  priority: "NORMAL",
  humanGate: [],
  references: [],
};

/**
 * A control plane with three named providers so the coverage planner's real preference
 * table (gpt/claude preferred, grok optional) is what gets exercised. The adapters are
 * production-eligible test fixtures because these scenarios exercise routing paths.
 */
const makeMultiProviderHarness = ({ forwardDispatchTarget = true }: { forwardDispatchTarget?: boolean } = {}) => {
  const root = tempDir("acp-cont-");
  const clock = new ManualClock("2026-08-12T00:00:00.000Z");
  const gpt = new TestProductionAdapter(clock, "gpt");
  const claude = new TestProductionAdapter(clock, "claude");
  const grok = new TestProductionAdapter(clock, "grok");
  const repoPath = makeRepo({ "src/app.js": "module.exports = () => 1;\n" });

  const cp = new ControlPlane({
    databasePath: join(root, "state.sqlite"),
    worktreeRoot: join(root, "worktrees"),
    capacityDir: join(root, "capacity"),
    secretsDir: join(root, "secrets"),
    clock,
    adapters: [gpt, claude, grok],
    ctoPreference: { provider: "claude", model: "opus", effort: null },
    reviewer: {
      preferred: { provider: "gpt", model: "gpt-5.6-sol", effort: "xhigh" },
      fallbacks: [{ provider: "claude", model: "opus", effort: null }],
    },
  });
  const buzz = new InMemoryBuzzTransport();
  const buzzAdapter = new BuzzAdapter(cp.db, cp.clock, cp.audit, cp.sessions, cp.bindings, cp.outbox, buzz);
  cp.continuity.attach({
    buzz: { connect: (sessionId, purpose) => buzzAdapter.connect(sessionId, purpose) },
  });
  // Only CP-S17 below is evidence for the composition root itself. The remaining
  // scenarios cover independent graph and continuity behavior, so their fixture supplies
  // the target-preserving port expected after that caller-side repair lands.
  if (forwardDispatchTarget) {
    cp.runs.attach({
      capacity: { refreshForDispatch: (target) => cp.capacity.refreshForDispatch(target) },
    });
  }
  return { cp, clock, gpt, claude, grok, repoPath };
};

const reading = (
  provider: string,
  clock: ManualClock,
  overrides: Partial<CapacityReading> = {},
): CapacityReading => ({
  provider,
  sensorHealth: "HEALTHY",
  runtimeHealth: "HEALTHY",
  observedAt: clock.nowIso(),
  source: "scenario",
  buckets: [
    {
      id: "rolling-5h",
      remainingPercent: 80,
      resetAt: null,
      capabilities: ["ceo", "cto", "blind-review", "worker", "luna-worker"],
    },
  ],
  ...overrides,
});

const registerProject = async (harness: ReturnType<typeof makeMultiProviderHarness>) => {
  const manifest = fixtureManifest("cont-project");
  const project = harness.cp.projects.register({
    projectId: "cont-project",
    name: "cont",
    manifest,
  });
  if (!project.allowed) throw new Error(project.message);
  const repository = await harness.cp.repositories.register({
    checkoutPath: harness.repoPath,
    projectId: "cont-project",
    repositoryRole: "primary",
    identity: "github:acme/fixture",
  });
  if (!repository.allowed) throw new Error(repository.message);
  return {
    projectId: "cont-project",
    repositoryId: repository.value.repositoryId,
    checkoutPath: repository.value.checkoutPath,
  };
};

describe("resource claims (CP-S13, CP-S14, CP-S15)", () => {
  const setup = async () => {
    const harness = makeMultiProviderHarness();
    const { projectId, repositoryId, checkoutPath } = await registerProject(harness);

    const makeRun = async () => {
      const created = harness.cp.runs.create({
        projectId,
        executionMode: ExecutionMode.SIMPLE,
        contract: CONTRACT,
        repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
      });
      if (!created.allowed) throw new Error(created.message);
      return created.value.runId;
    };

    // Both active runs are pinned to the same project-scoped primary CTO.
    const runA = await makeRun();
    const dispatched = await harness.cp.runs.dispatch(runA);
    if (!dispatched.allowed) throw new Error(dispatched.message);
    const runB = await makeRun();
    const secondDispatched = await harness.cp.runs.dispatch(runB);
    if (!secondDispatched.allowed) throw new Error(secondDispatched.message);

    return { harness, projectId, repositoryId, checkoutPath, runA, runB, owner: dispatched.value };
  };

  it("CP-S13: two runs cannot hold the same worktree", async () => {
    const { harness, runA, runB, owner, checkoutPath } = await setup();
    const roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId: "cont-project" });

    const first = harness.cp.claims.acquire({
      runId: runA,
      ownerSessionId: owner.ownerSessionId!,
      ownerBindingGeneration: owner.ownerBindingGeneration!,
      ownerRoleKey: roleKey,
      repositoryIdentity: "github:acme/fixture",
      worktreeId: checkoutPath,
    });
    expect(first.allowed).toBe(true);

    const second = harness.cp.claims.acquire({
      runId: runB,
      ownerSessionId: owner.ownerSessionId!,
      ownerBindingGeneration: owner.ownerBindingGeneration!,
      ownerRoleKey: roleKey,
      repositoryIdentity: "github:acme/fixture",
      worktreeId: checkoutPath,
    });
    expect(second.allowed).toBe(false);
    expect(second.reasonCode).toBe(ReasonCode.CLAIM_WORKTREE_CONFLICT);
  });

  it("CP-S14: exact declared path overlap between runs is a hard reject", async () => {
    const { harness, runA, runB, owner } = await setup();
    const roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId: "cont-project" });
    const base = {
      ownerSessionId: owner.ownerSessionId!,
      ownerBindingGeneration: owner.ownerBindingGeneration!,
      ownerRoleKey: roleKey,
      repositoryIdentity: "github:acme/fixture",
    };

    expect(
      harness.cp.claims.acquire({ ...base, runId: runA, declaredPaths: ["src/app.js"] }).allowed,
    ).toBe(true);
    const conflict = harness.cp.claims.acquire({
      ...base,
      runId: runB,
      declaredPaths: ["src/app.js"],
    });
    expect(conflict.allowed).toBe(false);
    expect(conflict.reasonCode).toBe(ReasonCode.CLAIM_PATH_CONFLICT);
  });

  it("CP-S15: a semantic (same-directory) overlap is advisory, not a reject", async () => {
    const { harness, runA, runB, owner } = await setup();
    const roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId: "cont-project" });
    const base = {
      ownerSessionId: owner.ownerSessionId!,
      ownerBindingGeneration: owner.ownerBindingGeneration!,
      ownerRoleKey: roleKey,
      repositoryIdentity: "github:acme/fixture",
    };

    harness.cp.claims.acquire({ ...base, runId: runA, declaredPaths: ["src/app.js"] });
    const neighbour = harness.cp.claims.acquire({
      ...base,
      runId: runB,
      declaredPaths: ["src/other.js"],
    });
    expect(neighbour.allowed).toBe(true);

    const advisory = harness.cp.claims.advisoryOverlaps("github:acme/fixture", runB, ["src/other.js"]);
    expect(advisory).toHaveLength(1);
    expect(advisory[0]?.otherRun).toBe(runA);
  });

  it("a claim under a revoked generation is refused", async () => {
    const { harness, runA, owner } = await setup();
    const roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId: "cont-project" });
    const refused = harness.cp.claims.acquire({
      runId: runA,
      ownerSessionId: owner.ownerSessionId!,
      ownerBindingGeneration: 99,
      ownerRoleKey: roleKey,
      repositoryIdentity: "github:acme/fixture",
      branch: "task/T1",
    });
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.CLAIM_OWNER_GENERATION_REVOKED);
  });

  it("an expired lease is reclaimable so a dead holder cannot block forever", async () => {
    const { harness, runA, runB, owner } = await setup();
    const roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId: "cont-project" });
    const base = {
      ownerSessionId: owner.ownerSessionId!,
      ownerBindingGeneration: owner.ownerBindingGeneration!,
      ownerRoleKey: roleKey,
      repositoryIdentity: "github:acme/fixture",
    };
    harness.cp.claims.acquire({ ...base, runId: runA, branch: "task/T1", ttlMs: 1000 });
    harness.clock.advance(2000);

    const reclaimed = harness.cp.claims.acquire({ ...base, runId: runB, branch: "task/T1" });
    expect(reclaimed.allowed).toBe(true);
  });
});

describe("parallel execution (CP-S12)", () => {
  it("CP-S12: independent tasks fan out across providers under one run", async () => {
    const harness = makeMultiProviderHarness();
    const { projectId, repositoryId } = await registerProject(harness);
    const created = harness.cp.runs.create({
      projectId,
      executionMode: ExecutionMode.STANDARD,
      contract: CONTRACT,
      repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
    });
    if (!created.allowed) throw new Error(created.message);
    const dispatched = await harness.cp.runs.dispatch(created.value.runId);
    if (!dispatched.allowed) throw new Error(dispatched.message);

    const submitted = harness.cp.tasks.submit(created.value.runId, [
      { key: "a", title: "mechanical a", category: "mechanical" },
      { key: "b", title: "mechanical b", category: "mechanical" },
      { key: "c", title: "integrate", category: "integration", dependsOn: ["a", "b"] },
    ]);
    expect(submitted.allowed).toBe(true);

    const ready = harness.cp.tasks.ready(created.value.runId);
    expect(ready).toHaveLength(2); // both independent tasks are ready at once

    const first = harness.cp.tasks.startExecution({
      runId: created.value.runId,
      taskId: ready[0]!.taskId,
      ownerBindingGeneration: dispatched.value.ownerBindingGeneration!,
      workerSessionId: null,
      provider: "gpt",
      model: "gpt-5.6-luna-max",
      concurrencyWidth: 1,
    });
    const second = harness.cp.tasks.startExecution({
      runId: created.value.runId,
      taskId: ready[1]!.taskId,
      ownerBindingGeneration: dispatched.value.ownerBindingGeneration!,
      workerSessionId: null,
      provider: "claude",
      model: "sonnet",
      concurrencyWidth: 2,
    });
    expect(first.allowed && second.allowed).toBe(true);
    expect(harness.cp.tasks.runningWidth(created.value.runId)).toBe(2);

    // The dependent task stays blocked until both parents succeed.
    expect(harness.cp.tasks.ready(created.value.runId)).toHaveLength(0);
    if (!first.allowed || !second.allowed) return;
    harness.cp.tasks.finishExecution(first.value.executionId, { status: "SUCCEEDED", resultDigest: "sha256:task-report" });
    expect(harness.cp.tasks.ready(created.value.runId)).toHaveLength(0);
    harness.cp.tasks.finishExecution(second.value.executionId, { status: "SUCCEEDED", resultDigest: "sha256:task-report" });
    expect(harness.cp.tasks.ready(created.value.runId).map((t) => t.title)).toEqual(["integrate"]);

    const providers = harness.cp.tasks
      .executions(created.value.runId)
      .map((e) => e.provider)
      .sort();
    expect(providers).toEqual(["claude", "gpt"]);
  });
});

describe("provider capacity (CP-S16, CP-S17, CP-S18)", () => {
  it("CP-S16: several usage windows are normalized into separate buckets", async () => {
    const harness = makeMultiProviderHarness();
    harness.gpt.setCapacity(
      reading("gpt", harness.clock, {
        buckets: [
          { id: "rolling-5h", remainingPercent: 62, resetAt: "2026-08-12T05:00:00.000Z", capabilities: ["ceo", "blind-review"] },
          { id: "weekly", remainingPercent: 18, resetAt: "2026-08-18T00:00:00.000Z", capabilities: ["luna-worker"] },
        ],
      }),
    );
    await harness.cp.capacity.refresh(RefreshTrigger.DOCTOR_CAPACITY_REPORT, ["gpt"]);

    const current = harness.cp.capacity.current("gpt")!;
    expect(current.buckets.map((b) => b.id).sort()).toEqual(["rolling-5h", "weekly"]);
    // The lowest bucket drives admission: 18% is inside the conserve band.
    expect(current.allocationAdmission).toBe("CONSERVE");
    expect(current.advisoryState).toBe("CONSERVE");
  });

  it("CP-S17: a failed probe suspends new allocation and still probes runtime health", async () => {
    const harness = makeMultiProviderHarness();
    harness.gpt.setCapacity(
      reading("gpt", harness.clock, { sensorHealth: "ERROR", buckets: [], error: "usage source unreadable" }),
    );
    harness.gpt.setRuntimeHealth("HEALTHY");
    harness.claude.setCapacity(reading("claude", harness.clock, { sensorHealth: "ERROR", buckets: [] }));

    await harness.cp.capacity.refresh(RefreshTrigger.PROVIDER_SWITCH_OR_FAILURE);
    const gptState = harness.cp.capacity.current("gpt")!;
    expect(gptState.allocationAdmission).toBe("SUSPENDED");
    expect(gptState.sensorHealth).toBe("ERROR");
    // The runtime is probed separately, so an existing critical session is not condemned
    // just because the usage sensor broke.
    expect(gptState.runtimeHealth).toBe("HEALTHY");

    const probeAudit = harness.cp.audit
      .byKind("CAPACITY_PROBE")
      .filter((e) => e.reasonCode === ReasonCode.PROBE_FAILED);
    expect(probeAudit.length).toBeGreaterThan(0);
  });

  it("CP-S17: dispatch refuses its selected CTO provider when its capacity probe fails", async () => {
    const harness = makeMultiProviderHarness({ forwardDispatchTarget: false });
    // These providers remain open for worker work. A targetless admission would therefore
    // pass, even though dispatch is about to constitute a Claude CTO.
    for (const adapter of [harness.gpt, harness.grok]) {
      adapter.setCapacity(
        reading(adapter.provider, harness.clock, {
          buckets: [{ id: "worker", remainingPercent: 90, resetAt: null, capabilities: ["worker"] }],
        }),
      );
    }
    harness.claude.setCapacity(
      reading("claude", harness.clock, { sensorHealth: "ERROR", buckets: [], error: "usage source unreadable" }),
    );
    const { projectId, repositoryId } = await registerProject(harness);
    const created = harness.cp.runs.create({
      projectId,
      executionMode: ExecutionMode.SIMPLE,
      contract: CONTRACT,
      repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
    });
    if (!created.allowed) throw new Error(created.message);

    const refused = await harness.cp.runs.dispatch(created.value.runId);
    expect(refused.allowed).toBe(false);
    if (refused.allowed) throw new Error("dispatch unexpectedly admitted failed Claude capacity");
    expect(refused.reasonCode).toBe(ReasonCode.CAPACITY_UNKNOWN_NOT_ROUTABLE);
    expect(refused.evidence).toMatchObject({ provider: "claude", capabilities: ["cto"] });
    expect(harness.cp.runs.require(created.value.runId).state).toBe(RunState.QUEUED);
  });

  it("CP-S18: a healthy disposable bucket is what makes Luna Max routable", async () => {
    const harness = makeMultiProviderHarness();
    harness.gpt.setCapacity(
      reading("gpt", harness.clock, {
        buckets: [{ id: "rolling-5h", remainingPercent: 90, resetAt: null, capabilities: ["luna-worker"] }],
      }),
    );
    await harness.cp.capacity.refresh(RefreshTrigger.WORKER_FANOUT, ["gpt"]);
    expect(harness.cp.capacity.providersFor("luna-worker").map((c) => c.provider)).toEqual(["gpt"]);

    harness.gpt.setCapacity(
      reading("gpt", harness.clock, {
        buckets: [{ id: "rolling-5h", remainingPercent: 1, resetAt: null, capabilities: ["luna-worker"] }],
      }),
    );
    await harness.cp.capacity.refresh(RefreshTrigger.WORKER_FANOUT, ["gpt"]);
    expect(harness.cp.capacity.providersFor("luna-worker")).toHaveLength(0);
  });

  it("a stale reading is usable inside the grace window and suspends past it", async () => {
    const harness = makeMultiProviderHarness();
    harness.gpt.setCapacity(reading("gpt", harness.clock, { sensorHealth: "STALE" }));
    await harness.cp.capacity.refresh(RefreshTrigger.CONTINUITY_EVALUATION, ["gpt"]);
    expect(harness.cp.capacity.current("gpt")!.allocationAdmission).toBe("OPEN");

    harness.clock.advance(20 * 60 * 1000);
    expect(harness.cp.capacity.current("gpt")!.allocationAdmission).toBe("SUSPENDED");
  });

  it("the reserve is computed from demand, not fixed", async () => {
    const harness = makeMultiProviderHarness();
    harness.gpt.setCapacity(
      reading("gpt", harness.clock, {
        buckets: [{
          id: "rolling-5h",
          remainingPercent: 80,
          resetAt: "2026-08-12T05:00:00.000Z",
          capabilities: ["worker"],
        }],
      }),
    );
    await harness.cp.capacity.refresh(RefreshTrigger.WORKER_FANOUT, ["gpt"]);

    const light = harness.cp.capacity.dynamicReserve("gpt", {
      criticalRoleInvocations: 0,
      expectedReviews: 0,
      inFlightRuns: 0,
      burnRatePercentPerHour: 0,
      roleDemand: { ceo: 0, cto: 0, reviewer: 0 },
    });
    const heavy = harness.cp.capacity.dynamicReserve("gpt", {
      criticalRoleInvocations: 5,
      expectedReviews: 10,
      inFlightRuns: 8,
      burnRatePercentPerHour: 4,
      roleDemand: { ceo: 1, cto: 2, reviewer: 3 },
    });
    expect(heavy).toBeGreaterThan(light);
    expect(heavy).toBeLessThanOrEqual(0.9);
  });
});

describe("role continuity (CP-S19 – CP-S24)", () => {
  const withProject = async () => {
    const harness = makeMultiProviderHarness();
    const { projectId, repositoryId } = await registerProject(harness);
    const created = harness.cp.runs.create({
      projectId,
      executionMode: ExecutionMode.SIMPLE,
      contract: CONTRACT,
      repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
    });
    if (!created.allowed) throw new Error(created.message);
    const dispatched = await harness.cp.runs.dispatch(created.value.runId);
    if (!dispatched.allowed) throw new Error(dispatched.message);
    return { harness, projectId, runId: created.value.runId, owner: dispatched.value };
  };

  it("CP-S19: GPT exhausted with Claude able to cover everything is DEGRADED / FULL_COVERAGE", async () => {
    const { harness } = await withProject();
    harness.gpt.setCapacity(
      reading("gpt", harness.clock, {
        buckets: [{ id: "rolling-5h", remainingPercent: 0, resetAt: null, capabilities: ["ceo", "blind-review"] }],
      }),
    );
    harness.claude.setCapacity(reading("claude", harness.clock));

    const plan = await harness.cp.continuity.evaluate("gpt exhausted");
    expect(plan.outcome).toBe("FULL_COVERAGE");
    expect(plan.mode).toBe(ContinuityMode.DEGRADED);
    expect(plan.assignments.every((a) => a.provider === "claude")).toBe(true);
  });

  it("CP-S20: partial coverage yields a wait-or-pause action rather than a silent pass", async () => {
    const { harness } = await withProject();
    harness.gpt.setCapacity(
      reading("gpt", harness.clock, { sensorHealth: "ERROR", buckets: [] }),
    );
    // Claude can serve the CTO role but advertises no reviewer capability.
    harness.claude.setCapacity(
      reading("claude", harness.clock, {
        buckets: [{ id: "rolling-5h", remainingPercent: 70, resetAt: null, capabilities: ["cto"] }],
      }),
    );

    const plan = await harness.cp.continuity.evaluate("gpt down, claude partial");
    expect(plan.outcome).toBe("PARTIAL_COVERAGE");
    expect(plan.uncovered.some((k) => k.startsWith("BLIND_REVIEWER"))).toBe(true);
    expect(["PAUSE_NEW_WORK", "WAIT_FOR_RESET", "OWNER_APPROVED_PROJECT_SUSPEND"]).toContain(plan.action);
    expect(plan.mode).toBe(ContinuityMode.DEGRADED);
  });

  it("CP-S21: with Claude down, distinct GPT sessions cover CEO, CTO and reviewer", async () => {
    const { harness, projectId, runId } = await withProject();
    harness.claude.setCapacity(reading("claude", harness.clock, { runtimeHealth: "UNAVAILABLE" }));
    harness.gpt.setCapacity(reading("gpt", harness.clock));

    const plan = await harness.cp.continuity.evaluate("claude down");
    expect(plan.outcome).toBe("FULL_COVERAGE");
    expect(plan.assignments.every((a) => a.provider === "gpt")).toBe(true);

    const ceo = await harness.cp.continuity.failover(roleKeyFor(Role.CEO), Role.CEO, {}, "claude down");
    const cto = await harness.cp.continuity.failover(
      roleKeyFor(Role.PRIMARY_CTO, { projectId }),
      Role.PRIMARY_CTO,
      { projectId },
      "claude down",
    );
    expect(ceo.allowed && cto.allowed).toBe(true);

    // Distinct sessions, which is what CP-HI-04 actually requires.
    const ceoBinding = harness.cp.bindings.require(roleKeyFor(Role.CEO));
    const ctoBinding = harness.cp.bindings.require(roleKeyFor(Role.PRIMARY_CTO, { projectId }));
    expect(ceoBinding.sessionId).not.toBe(ctoBinding.sessionId);
    expect(harness.cp.bindings.assertReviewerIndependence(runId, ceoBinding.sessionId).allowed).toBe(true);
  });

  it("CP-S22: with both providers unavailable the mode is SURVIVAL and completion is refused", async () => {
    const { harness, runId } = await withProject();
    for (const adapter of [harness.gpt, harness.claude, harness.grok]) {
      adapter.setCapacity(reading(adapter.provider, harness.clock, { sensorHealth: "ERROR", buckets: [] }));
    }

    const plan = await harness.cp.continuity.evaluate("all providers down");
    expect(plan.outcome).toBe("NO_VALID_COVERAGE");
    expect(plan.action).toBe("SURVIVAL");
    expect(harness.cp.continuity.mode()).toBe(ContinuityMode.SURVIVAL);

    const completion = harness.cp.continuity.assertCompletionAllowed(runId);
    expect(completion.allowed).toBe(false);
    expect(completion.reasonCode).toBe(ReasonCode.CONTINUITY_SURVIVAL_NO_COMPLETION);

    // §15.6 — new work is not dispatched in SURVIVAL either.
    const created = harness.cp.runs.create({ executionMode: ExecutionMode.SIMPLE, contract: CONTRACT });
    if (!created.allowed) throw new Error(created.message);
    const refused = await harness.cp.runs.dispatch(created.value.runId);
    expect(refused.reasonCode).toBe(ReasonCode.CONTINUITY_SURVIVAL_NO_COMPLETION);
  });

  it("Grok being absent on its own never degrades continuity", async () => {
    const { harness } = await withProject();
    harness.gpt.setCapacity(reading("gpt", harness.clock));
    harness.claude.setCapacity(reading("claude", harness.clock));
    harness.grok.setCapacity(reading("grok", harness.clock, { runtimeHealth: "UNAVAILABLE", buckets: [] }));

    const plan = await harness.cp.continuity.evaluate("grok gone");
    expect(plan.outcome).toBe("FULL_COVERAGE");
    expect(plan.mode).toBe(ContinuityMode.NORMAL);
    expect(plan.providers.find((p) => p.provider === "grok")?.optional).toBe(true);
  });

  it("CP-S24: a recovered provider does not seize an in-flight run owner", async () => {
    const { harness, projectId } = await withProject();
    harness.claude.setCapacity(reading("claude", harness.clock, { runtimeHealth: "UNAVAILABLE" }));
    harness.gpt.setCapacity(reading("gpt", harness.clock));

    // Fail the CTO over to the fallback provider while it owns a live run.
    const failed = await harness.cp.continuity.failover(
      roleKeyFor(Role.PRIMARY_CTO, { projectId }),
      Role.PRIMARY_CTO,
      { projectId },
      "claude down",
    );
    expect(failed.allowed).toBe(true);
    const fallbackBinding = harness.cp.bindings.require(roleKeyFor(Role.PRIMARY_CTO, { projectId }));
    harness.cp.runs.reassignOwner(
      harness.cp.runs.list({ projectId })[0]!.runId,
      fallbackBinding,
      "test: attach the live run to the fallback owner",
    );

    harness.claude.setCapacity(reading("claude", harness.clock));
    const restored = await harness.cp.continuity.restore();
    expect(restored.restored).not.toContain(roleKeyFor(Role.PRIMARY_CTO, { projectId }));
    expect(
      restored.deferred.some(
        (d) =>
          d.roleKey === roleKeyFor(Role.PRIMARY_CTO, { projectId }) &&
          d.reasonCode === ReasonCode.RESTORE_WOULD_PREEMPT_INFLIGHT_OWNER,
      ),
    ).toBe(true);
  });

  it("CP-S34: a failover the coverage plan cannot staff is refused, not downgraded", async () => {
    const { harness, projectId } = await withProject();
    for (const adapter of [harness.gpt, harness.claude, harness.grok]) {
      adapter.setCapacity(reading(adapter.provider, harness.clock, { sensorHealth: "ERROR", buckets: [] }));
    }
    const refused = await harness.cp.continuity.failover(
      roleKeyFor(Role.PRIMARY_CTO, { projectId }),
      Role.PRIMARY_CTO,
      { projectId },
      "everything down",
    );
    expect(refused.allowed).toBe(false);
    expect([ReasonCode.COVERAGE_NONE, ReasonCode.COVERAGE_PARTIAL]).toContain(refused.reasonCode);
  });

  it("CP-S23: a message addressed to a revoked generation is never delivered", async () => {
    const { harness, projectId, owner, runId } = await withProject();
    const roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId });

    harness.cp.outbox.enqueue({
      idempotencyKey: `test:${runId}`,
      roleKey,
      bindingGeneration: owner.ownerBindingGeneration!,
      targetSessionId: owner.ownerSessionId!,
      runId,
      kind: "RUN_DISPATCH",
      payload: { runId },
    });
    expect(harness.cp.outbox.claimDeliverable().length).toBeGreaterThan(0);

    const session = harness.cp.sessions.create({ provider: "gpt", model: "sol" });
    harness.cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "test");
    harness.cp.bindings.switchTo({
      roleKey,
      role: Role.PRIMARY_CTO,
      sessionId: session.sessionId,
      projectId,
      reason: "test switch",
    });

    // The message was retargeted onto the new generation, so nothing remains addressed
    // to the revoked one.
    const stillOld = harness.cp.outbox
      .listByRun(runId)
      .filter((m) => m.bindingGeneration === owner.ownerBindingGeneration && m.status === "PENDING");
    expect(stillOld).toHaveLength(0);
  });
});
