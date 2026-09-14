import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { ExecutionMode, Role, RunKind, SessionLifecycle } from "../../src/domain/types.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import type { TaskContract } from "../../src/run/run-engine.ts";
import { candidateSnapshotDigest } from "../../src/snapshot/candidate-snapshot.ts";
import { BlindReviewGate } from "../../src/review/blind-review.ts";
import type { VerificationReport } from "../../src/verify/verification-engine.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { makeHarness, registerFixtureProject } from "../helpers/harness.ts";
import { applyPassingChange, bindWorker, reviewerPass } from "../helpers/harness.ts";
import { TestProductionAdapter } from "../helpers/production-adapter.ts";

afterAll(cleanupTempDirs);
afterEach(() => vi.restoreAllMocks());

describe("real dispatch role admission", () => {
  it.each([false, true])("admits PRIMARY_CTO independently of unknown reviewer (scoped=%s)", async (scoped) => {
    const harness = makeHarness();
    const { cp, clock, scripted } = harness;
    const { projectId, repositoryId } = await registerFixtureProject(harness);
    if (scoped) {
      cp.providers.registerForRole(scripted, Role.PRIMARY_CTO);
    }
    scripted.setCapacity({
      provider: "scripted", sensorHealth: "HEALTHY", runtimeHealth: "HEALTHY",
      observedAt: clock.nowIso(), source: "synthetic-caller-fixture",
      buckets: [{ id: "cto-only", remainingPercent: 80, resetAt: null, capabilities: ["cto"] }],
    });
    const run = cp.runs.create({
      projectId, executionMode: ExecutionMode.STANDARD,
      contract: { goal: "scoped admission", why: "actual caller consumes exact role capacity",
        scope: ["src/app.js"], nonGoals: [], acceptance: ["dispatch admits only its CTO"],
        priority: "NORMAL", humanGate: [], references: [] },
      repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "main" }],
    });
    if (!run.allowed) throw new Error(run.message);
    const result = await cp.runs.dispatch(run.value.runId);
    expect(result).toMatchObject({ allowed: true });
    if (scoped) {
      expect(cp.capacity.currentForRole("scripted", Role.PRIMARY_CTO)?.allocationAdmission).toBe("OPEN");
      expect(cp.capacity.currentForRole("scripted", Role.BLIND_REVIEWER)).toBeNull();
    }
  });
});

const contract: TaskContract = {
  goal: "caller role admission", why: "use the real allocation role",
  scope: ["src/app.js"], nonGoals: [], acceptance: ["role-local capacity"],
  priority: "NORMAL", humanGate: [], references: [],
};

const capacity = (h: ReturnType<typeof makeHarness>, capability: string, remainingPercent = 80) => ({
  provider: "scripted", sensorHealth: "HEALTHY" as const, runtimeHealth: "HEALTHY" as const,
  observedAt: h.clock.nowIso(), source: "synthetic-caller-fixture",
  buckets: [{ id: capability, remainingPercent, resetAt: null, capabilities: [capability] }],
});

const queuedProject = async () => {
  const h = makeHarness();
  const { projectId, repositoryId } = await registerFixtureProject(h);
  const run = h.cp.runs.create({ projectId, executionMode: ExecutionMode.STANDARD, contract,
    repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }] });
  if (!run.allowed) throw new Error(run.message);
  return { h, run: run.value, projectId, repositoryId };
};

const preparedReview = async () => {
  const setup = await queuedProject();
  const { h, run, projectId, repositoryId } = setup;
  const dispatched = await h.cp.runs.dispatch(run.runId);
  if (!dispatched.allowed) throw new Error(dispatched.message);
  const tasks = h.cp.tasks.submit(run.runId, [{ key: "impl", title: "impl", category: "implementation" }]);
  if (!tasks.allowed) throw new Error(tasks.message);
  const task = h.cp.tasks.ready(run.runId)[0]!;
  const workerSessionId = bindWorker(h, task.taskId);
  const execution = h.cp.tasks.startExecution({ runId: run.runId, taskId: task.taskId,
    ownerBindingGeneration: dispatched.value.ownerBindingGeneration!, workerSessionId,
    provider: "scripted", model: "worker", repositoryId });
  if (!execution.allowed) throw new Error(execution.message);
  const head = applyPassingChange(h.repoPath);
  h.cp.tasks.finishExecution(execution.value.executionId, { status: "SUCCEEDED", resultDigest: `sha256:${head}` });
  const frozen = await h.cp.pipeline.freeze(run.runId);
  if (!frozen.allowed) throw new Error(frozen.message);
  const snapshot = frozen.value;
  const digest = candidateSnapshotDigest(snapshot);
  const repo = snapshot.repositories[0]!;
  const now = h.clock.nowIso();
  // Persist deterministic verification evidence just as review-r2 does; no external verifier.
  const verification: VerificationReport = { runId: run.runId, candidateSnapshotDigest: digest,
    contractDigest: run.contractDigest, expectedInputs: 1, observedInputs: 1,
    results: [{ commandId: "verify", repositoryIdentity: repo.identity, source: "local",
      exactHead: repo.candidateHead, startedAt: now, endedAt: now, exitCode: 0,
      outputDigest: "sha256:fixture", outputTruncated: false, status: "PASS", reasonCode: null }],
    status: "PASS", reasonCode: ReasonCode.OK, gaps: [] };
  h.cp.artifacts.putEvidence(h.cp.evidenceWritersForTests().VERIFICATION, run.runId, "VERIFICATION", verification, digest);
  h.cp.db.run(`INSERT INTO verification_results
    (result_id, run_id, candidate_snapshot_digest, command_id, repository_identity, source,
     exact_head, started_at, ended_at, exit_code, output_digest, output_truncated, status, reason_code)
    VALUES (?, ?, ?, 'verify', ?, 'local', ?, ?, ?, 0, 'sha256:fixture', 0, 'PASS', NULL)`,
  [`${run.runId}:verify`, run.runId, digest, repo.identity, repo.candidateHead, now, now]);
  h.scripted.script({ match: /Candidate review/, text: reviewerPass([`${repo.identity}:src/app.js`]) });
  const request = {
    runId: run.runId, projectId, executionMode: run.executionMode, snapshot,
    contract, contractDigest: run.contractDigest, verification,
  };
  return { ...setup, request, invoke: () => h.cp.review.controlPlaneInvoker()(request) };
};

const reviewWithFallback = async () => {
  const setup = await preparedReview();
  const { h, request } = setup;
  const { cp, clock } = h;
  const fallback = new TestProductionAdapter(clock, "claude");
  cp.providers.register(fallback);
  fallback.setCapacity({ ...capacity(h, "blind-review"), provider: "claude" });
  fallback.script({ match: /Candidate review/,
    text: reviewerPass([`${request.snapshot.repositories[0]!.identity}:src/app.js`]) });
  const gate = new BlindReviewGate(clock, cp.db, cp.audit, cp.artifacts,
    cp.evidenceWritersForTests().BLIND_REVIEW, cp.sessions, cp.bindings, cp.providers,
    cp.repositories, cp.telemetry, {
      preferred: { provider: "scripted", model: "preferred-reviewer", effort: null },
      fallbacks: [{ provider: "claude", model: "fallback-reviewer", effort: null }],
    });
  gate.attach({ capacity: cp.capacity });
  return { ...setup, fallback, invoke: () => gate.controlPlaneInvoker()(request) };
};

describe("reviewer scope fallback boundary", () => {
  it.each([
    ["unknown", false], ["throws", false], ["unknown", true], ["throws", true],
  ] as const)("denies %s preferred scope (after runtime=%s) before a healthy fallback", async (failure, afterRuntime) => {
    const { h, fallback, invoke } = await reviewWithFallback();
    const lookup = h.cp.providers.hasRoleScoped.bind(h.cp.providers);
    const breakScope = () => vi.spyOn(h.cp.providers, "hasRoleScoped").mockImplementation((provider) => {
      if (provider !== "scripted") return lookup(provider);
      if (failure === "throws") throw new Error("lookup unavailable");
      return undefined as unknown as boolean;
    });
    if (afterRuntime) {
      const probe = h.scripted.probeRuntime.bind(h.scripted);
      vi.spyOn(h.scripted, "probeRuntime").mockImplementation(async () => {
        const health = await probe();
        breakScope();
        return health;
      });
    } else breakScope();
    const preferredStart = vi.spyOn(h.scripted, "startSession");
    const fallbackStart = vi.spyOn(fallback, "startSession");
    const create = vi.spyOn(h.cp.sessions, "create");
    expect(await invoke()).toMatchObject({ allowed: false, reasonCode: ReasonCode.CAPACITY_UNKNOWN_NOT_ROUTABLE });
    expect(preferredStart).not.toHaveBeenCalled();
    expect(fallbackStart).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(h.scripted.invocations).toHaveLength(0);
    expect(fallback.invocations).toHaveLength(0);
    expect(h.cp.audit.byKind("BLIND_REVIEW_FALLBACK")).toHaveLength(0);
  });

  it.each(["capacity", "outage"] as const)("preserves healthy fallback after preferred %s", async (failure) => {
    const { h, fallback, invoke } = await reviewWithFallback();
    if (failure === "capacity") h.scripted.setCapacity(capacity(h, "blind-review", 0));
    else h.scripted.setRuntimeHealth("UNAVAILABLE");
    const preferredStart = vi.spyOn(h.scripted, "startSession");
    const fallbackStart = vi.spyOn(fallback, "startSession");
    expect(await invoke()).toMatchObject({ allowed: true, reasonCode: ReasonCode.REVIEW_PASS,
      value: { provider: "claude" } });
    expect(preferredStart).not.toHaveBeenCalled();
    expect(h.scripted.invocations).toHaveLength(0);
    expect(fallbackStart).toHaveBeenCalledOnce();
    expect(fallback.invocations).toHaveLength(1);
  });
});

describe("real reviewer role admission", () => {
  it.each([false, true])("admits reviewer with only reviewer quota (scoped=%s)", async (scoped) => {
    const { h, invoke } = await preparedReview();
    if (scoped) h.cp.providers.registerForRole(h.scripted, Role.BLIND_REVIEWER);
    h.scripted.setCapacity(capacity(h, "blind-review"));
    expect(await invoke()).toMatchObject({ allowed: true, reasonCode: ReasonCode.REVIEW_PASS });
    expect(h.scripted.invocations).toHaveLength(1);
  });
});

const projectless = (role: Role = Role.BOOTSTRAP_CTO) => {
  const h = makeHarness();
  const created = h.cp.runs.create({ kind: RunKind.PROJECT_BOOTSTRAP,
    executionMode: ExecutionMode.STANDARD, contract });
  if (!created.allowed) throw new Error(created.message);
  const runId = created.value.runId;
  const session = h.cp.sessions.create({ provider: "scripted", model: "owner" });
  h.cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "fixture ready");
  const bound = h.cp.bindings.bind({ role, sessionId: session.sessionId,
    ...(role === Role.BOOTSTRAP_CTO ? { runId } : {}) });
  if (!bound.allowed) throw new Error(bound.message);
  const binding = bound.value;
  h.cp.db.run(`UPDATE runs SET owner_session_id = ?, owner_binding_generation = ?,
    owner_session_incarnation = ?, owner_role_key = ? WHERE run_id = ?`,
  [binding.sessionId, binding.bindingGeneration, binding.sessionIncarnation, binding.roleKey, runId]);
  h.cp.providers.registerForRole(h.scripted, Role.BOOTSTRAP_CTO);
  h.scripted.setCapacity(capacity(h, "cto"));
  return { h, runId, binding };
};

describe("verified projectless owner role", () => {
  it("admits the real BOOTSTRAP_CTO binding", async () => {
    const { h, runId } = projectless();
    expect(await h.cp.runs.dispatch(runId)).toMatchObject({ allowed: true });
    expect(h.cp.capacity.currentForRole("scripted", Role.BOOTSTRAP_CTO)?.allocationAdmission).toBe("OPEN");
  });
  it("does not synthesize BOOTSTRAP_CTO from a forged CEO owner pin", async () => {
    const { h, runId } = projectless(Role.CEO);
    const refresh = vi.spyOn(h.cp.capacity, "refreshForDispatch");
    expect(await h.cp.runs.dispatch(runId)).toMatchObject({
      allowed: false, reasonCode: ReasonCode.RUN_OWNER_REVOKED,
    });
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("caller fail-closed controls", () => {
  it.each(["dispatch", "review"] as const)("%s ignores opposite-role quota and refuses its own exhausted quota", async (caller) => {
    const setup = caller === "dispatch"
      ? await queuedProject().then((s) => ({ ...s, invoke: () => s.h.cp.runs.dispatch(s.run.runId) }))
      : await preparedReview();
    const { h } = setup;
    const role = caller === "dispatch" ? Role.PRIMARY_CTO : Role.BLIND_REVIEWER;
    const otherRole = caller === "dispatch" ? Role.BLIND_REVIEWER : Role.PRIMARY_CTO;
    const capability = caller === "dispatch" ? "cto" : "blind-review";
    const other = new TestProductionAdapter(h.clock);
    other.setCapacity(capacity(h, caller === "dispatch" ? "blind-review" : "cto"));
    h.cp.providers.registerForRole(other, otherRole);
    h.cp.providers.registerForRole(h.scripted, role);
    h.scripted.setCapacity(capacity(h, capability, 0));
    const starts = vi.spyOn(h.scripted, "startSession");
    const result = await setup.invoke();
    expect(result).toMatchObject({ allowed: false, reasonCode: ReasonCode.CAPACITY_UNKNOWN_NOT_ROUTABLE });
    expect(starts).not.toHaveBeenCalled();
    expect(h.scripted.invocations).toHaveLength(0);
  });

  it("refuses an unregistered CTO role without provider-only rescue", async () => {
    const { h, run } = await queuedProject();
    h.cp.providers.registerForRole(h.scripted, Role.BLIND_REVIEWER);
    const start = vi.spyOn(h.scripted, "startSession");
    expect(await h.cp.runs.dispatch(run.runId)).toMatchObject({ allowed: false });
    expect(start).not.toHaveBeenCalled();
  });

  it("refuses an unregistered reviewer role without provider-only rescue", async () => {
    const { h, invoke } = await preparedReview();
    h.cp.providers.registerForRole(h.scripted, Role.PRIMARY_CTO);
    const start = vi.spyOn(h.scripted, "startSession");
    expect(await invoke()).toMatchObject({ allowed: false, reasonCode: ReasonCode.CAPACITY_UNKNOWN_NOT_ROUTABLE });
    expect(start).not.toHaveBeenCalled();
    expect(h.scripted.invocations).toHaveLength(0);
  });

  it.each(["throws", "unknown"] as const)("dispatch refuses scope lookup that %s", async (failure) => {
    const { h, run } = await queuedProject();
    vi.spyOn(h.cp.providers, "hasRoleScoped").mockImplementation(() => {
      if (failure === "throws") throw new Error("lookup unavailable");
      return undefined as unknown as boolean;
    });
    const refresh = vi.spyOn(h.cp.capacity, "refreshForDispatch");
    expect(await h.cp.runs.dispatch(run.runId)).toMatchObject({
      allowed: false, reasonCode: ReasonCode.CAPACITY_UNKNOWN_NOT_ROUTABLE,
    });
    expect(refresh).not.toHaveBeenCalled();
  });

  it.each([false, true])("missing lookup port is legacy-only (scoped=%s)", async (scoped) => {
    const { h, run } = await queuedProject();
    if (scoped) h.cp.providers.registerForRole(h.scripted, Role.PRIMARY_CTO);
    // Simulate the legacy constructor without changing the production composition root.
    expect(Reflect.deleteProperty(h.cp.runs, "providerScope")).toBe(true);
    expect(await h.cp.runs.dispatch(run.runId)).toMatchObject({ allowed: !scoped });
  });

  it.each(["throws", "unknown"] as const)("review refuses scope lookup that %s", async (failure) => {
    const { h, invoke } = await preparedReview();
    const start = vi.spyOn(h.scripted, "startSession");
    vi.spyOn(h.cp.providers, "hasRoleScoped").mockImplementation(() => {
      if (failure === "throws") throw new Error("lookup unavailable");
      return undefined as unknown as boolean;
    });
    expect(await invoke()).toMatchObject({ allowed: false, reasonCode: ReasonCode.CAPACITY_UNKNOWN_NOT_ROUTABLE });
    expect(start).not.toHaveBeenCalled();
    expect(h.scripted.invocations).toHaveLength(0);
  });

  it.each(["dispatch", "review"] as const)("%s admits its own quota despite exhausted opposite-role registration", async (caller) => {
    const setup = caller === "dispatch"
      ? await queuedProject().then((s) => ({ ...s, invoke: () => s.h.cp.runs.dispatch(s.run.runId) }))
      : await preparedReview();
    const { h } = setup;
    const other = new TestProductionAdapter(h.clock);
    other.setCapacity(capacity(h, caller === "dispatch" ? "blind-review" : "cto", 0));
    h.cp.providers.registerForRole(other, caller === "dispatch" ? Role.BLIND_REVIEWER : Role.PRIMARY_CTO);
    h.cp.providers.registerForRole(h.scripted, caller === "dispatch" ? Role.PRIMARY_CTO : Role.BLIND_REVIEWER);
    h.scripted.setCapacity(capacity(h, caller === "dispatch" ? "cto" : "blind-review"));
    expect(await setup.invoke()).toMatchObject({ allowed: true });
    expect(other.invocations).toHaveLength(0);
  });

  it.each(["dispatch", "review"] as const)("%s refuses a role registration invalidated during its probe", async (caller) => {
    const setup = caller === "dispatch"
      ? await queuedProject().then((s) => ({ ...s, invoke: () => s.h.cp.runs.dispatch(s.run.runId) }))
      : await preparedReview();
    const { h } = setup;
    const role = caller === "dispatch" ? Role.PRIMARY_CTO : Role.BLIND_REVIEWER;
    h.cp.providers.registerForRole(h.scripted, role);
    const replacement = new TestProductionAdapter(h.clock);
    const probe = h.scripted.probeCapacity.bind(h.scripted);
    vi.spyOn(h.scripted, "probeCapacity").mockImplementation(async () => {
      const reading = await probe();
      h.cp.providers.registerForRole(replacement, role);
      return reading;
    });
    const start = vi.spyOn(h.scripted, "startSession");
    expect(await setup.invoke())
      .toMatchObject({ allowed: false, reasonCode: ReasonCode.CAPACITY_UNKNOWN_NOT_ROUTABLE });
    expect(start).not.toHaveBeenCalled();
    expect(h.scripted.invocations).toHaveLength(0);
  });

  it("rejects a revoked projectless owner generation before capacity", async () => {
    const { h, runId, binding } = projectless();
    h.cp.db.run("UPDATE assignments SET status = 'REVOKED' WHERE role_key = ?", [binding.roleKey]);
    const refresh = vi.spyOn(h.cp.capacity, "refreshForDispatch");
    expect(await h.cp.runs.dispatch(runId)).toMatchObject({
      allowed: false, reasonCode: ReasonCode.RUN_OWNER_REVOKED,
    });
    expect(refresh).not.toHaveBeenCalled();
  });
});
