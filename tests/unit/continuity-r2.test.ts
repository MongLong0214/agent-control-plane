import { afterAll, describe, expect, it, vi } from "vitest";
import { accessSync, chmodSync, constants, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { RefreshTrigger } from "../../src/capacity/capacity-monitor.ts";
import { ControlPlane } from "../../src/app/control-plane.ts";
import { ManualClock } from "../../src/core/clock.ts";
import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ArtifactKind, ContinuityMode, ExecutionMode, Role, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import {
  ClaudeCliAdapter,
  CodexCliAdapter,
  readCapacityFile,
  runtimeEnvironment,
} from "../../src/runtime/cli-adapters.ts";
import {
  type CapacityReading,
  type InvocationRequest,
  type InvocationResult,
  type ProviderAdapter,
  ProviderRegistry,
  type SessionHandle,
  type SessionSpec,
} from "../../src/runtime/provider.ts";
import { ScriptedAdapter, type ScriptedResponse } from "../../src/runtime/scripted-adapter.ts";
import type { TaskContract } from "../../src/run/run-engine.ts";
import { candidateSnapshotDigest } from "../../src/snapshot/candidate-snapshot.ts";
import type { VerificationReport } from "../../src/verify/verification-engine.ts";
import { cleanupTempDirs, commitAll, makeRepo, tempDir } from "../helpers/fixtures.ts";
import { fixtureManifest, reviewerPass } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

class ProductionTestAdapter implements ProviderAdapter {
  readonly #scripted: ScriptedAdapter;
  readonly isProduction = true;

  constructor(clock: ManualClock, provider: string) {
    this.#scripted = new ScriptedAdapter(clock, provider);
  }

  get provider(): string { return this.#scripted.provider; }
  get defaultModels(): Readonly<Record<string, string>> { return this.#scripted.defaultModels; }
  get invocations(): readonly InvocationRequest[] { return this.#scripted.invocations; }
  setCapacity(reading: CapacityReading | null): void { this.#scripted.setCapacity(reading); }
  setRuntimeHealth(health: "HEALTHY" | "DEGRADED" | "UNAVAILABLE"): void { this.#scripted.setRuntimeHealth(health); }
  setNextSessionHealth(health: "HEALTHY" | "DEGRADED" | "UNAVAILABLE"): void {
    this.#scripted.setNextSessionHealth(health);
  }
  startSession(spec: SessionSpec): Promise<SessionHandle> { return this.#scripted.startSession(spec); }
  stopSession(handle: SessionHandle): Promise<void> {
    return this.#scripted.stopSession(handle);
  }
  async invoke(request: InvocationRequest): Promise<InvocationResult> {
    const result = await this.#scripted.invoke(request);
    // This test-owned adapter does not perform I/O, so an isolated reviewer request is
    // packet-only by construction. Production adapters still have to attest their boundary.
    return request.isolation ? { ...result, isolationAttested: true } : result;
  }
  script(...responses: ScriptedResponse[]): this {
    this.#scripted.script(...responses);
    return this;
  }
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
    allowTestEvidenceWriters: true,
  });
  return { cp, clock, gpt, claude, root };
};

const attachRoutablePorts = (cp: ControlPlane) => {
  cp.continuity.attach({
    readiness: { checkSession: async () => allow(ReasonCode.OK, undefined) },
    buzz: { connect: async (sessionId) => allow(ReasonCode.OK, `buzz:${sessionId}`) },
  });
};

type CliProbe = {
  environment: Record<string, string>;
  readable: Record<string, boolean>;
};

const writeCliProbe = (directory: string, paths: readonly string[]): string => {
  const binary = join(directory, "runtime-probe.mjs");
  writeFileSync(binary, `#!${process.execPath}
import { readFileSync } from "node:fs";

const paths = ${JSON.stringify(paths)};
const readable = Object.fromEntries(paths.map((path) => {
  try {
    readFileSync(path, "utf8");
    return [path, true];
  } catch {
    return [path, false];
  }
}));
process.stdout.write(JSON.stringify({ environment: process.env, readable }));
`);
  chmodSync(binary, 0o700);
  return binary;
};

const noGhPath = (): string =>
  [dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
    .filter((directory) => {
      try {
        accessSync(join(directory, "gh"), constants.X_OK);
        return false;
      } catch {
        return true;
      }
    })
    .join(":");

const withEnvironment = async <T>(
  replacements: Record<string, string | undefined>,
  callback: () => Promise<T>,
): Promise<T> => {
  const previous = Object.fromEntries(Object.keys(replacements).map((name) => [name, process.env[name]]));
  try {
    for (const [name, value] of Object.entries(replacements)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    return await callback();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
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

const REVIEW_CONTRACT: TaskContract = {
  goal: "review-capacity fixture",
  why: "prove mandatory reviewer admission",
  scope: ["src/app.js"],
  nonGoals: [],
  acceptance: ["review runs only with current blind-review capacity"],
  priority: "NORMAL",
  humanGate: [],
  references: [],
};

/** Builds immutable review inputs so the assertion reaches the real review allocator. */
const prepareCapacityReviewedRun = async (plane: ReturnType<typeof makePlane>) => {
  const { cp, clock, gpt, claude } = plane;
  const projectId = "review-capacity-project";
  const repoPath = makeRepo({ "src/app.js": "module.exports = () => 1;\n" });
  gpt.setCapacity(healthy("gpt", clock));
  claude.setCapacity(healthy("claude", clock));
  const project = cp.projects.register({ projectId, name: projectId, manifest: fixtureManifest(projectId) });
  if (!project.allowed) throw new Error(project.message);
  const repository = await cp.repositories.register({
    checkoutPath: repoPath,
    projectId,
    repositoryRole: "primary",
    identity: "github:acme/review-capacity",
  });
  if (!repository.allowed) throw new Error(repository.message);
  const created = cp.runs.create({
    projectId,
    executionMode: ExecutionMode.STANDARD,
    contract: REVIEW_CONTRACT,
    repositories: [{ repositoryId: repository.value.repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
  });
  if (!created.allowed) throw new Error(created.message);
  const dispatched = await cp.runs.dispatch(created.value.runId);
  if (!dispatched.allowed) throw new Error(dispatched.message);
  const tasks = cp.tasks.submit(created.value.runId, [{ key: "impl", title: "impl", category: "implementation" }]);
  if (!tasks.allowed) throw new Error(tasks.message);
  const task = cp.tasks.ready(created.value.runId)[0]!;
  const execution = cp.tasks.startExecution({
    runId: created.value.runId,
    taskId: task.taskId,
    ownerBindingGeneration: dispatched.value.ownerBindingGeneration!,
    workerSessionId: dispatched.value.ownerSessionId,
    provider: "gpt",
    model: "worker",
    repositoryId: repository.value.repositoryId,
  });
  if (!execution.allowed) throw new Error(execution.message);
  writeFileSync(join(repoPath, "src/app.js"), "module.exports = () => 2;\n");
  const head = commitAll(repoPath, "review capacity change");
  cp.tasks.finishExecution(execution.value.executionId, { status: "SUCCEEDED", resultDigest: `sha256:${head}` });
  const frozen = await cp.pipeline.freeze(created.value.runId);
  if (!frozen.allowed) throw new Error(frozen.message);

  const snapshotDigest = candidateSnapshotDigest(frozen.value);
  const snapshotRepository = frozen.value.repositories[0]!;
  const now = clock.nowIso();
  const verification: VerificationReport = {
    runId: created.value.runId,
    candidateSnapshotDigest: snapshotDigest,
    contractDigest: dispatched.value.contractDigest,
    expectedInputs: 1,
    observedInputs: 1,
    results: [{
      commandId: "verify",
      repositoryIdentity: snapshotRepository.identity,
      source: "local",
      exactHead: snapshotRepository.candidateHead,
      startedAt: now,
      endedAt: now,
      exitCode: 0,
      outputDigest: "sha256:review-capacity-verification",
      outputTruncated: false,
      status: "PASS",
      reasonCode: null,
    }],
    status: "PASS",
    reasonCode: ReasonCode.OK,
    gaps: [],
  };
  cp.artifacts.putEvidence(
    cp.evidenceWritersForTests().VERIFICATION,
    created.value.runId,
    ArtifactKind.VERIFICATION,
    verification,
    snapshotDigest,
  );
  cp.db.run(
    `INSERT INTO verification_results
       (result_id, run_id, candidate_snapshot_digest, command_id, repository_identity, source,
        exact_head, started_at, ended_at, exit_code, output_digest, output_truncated, status, reason_code)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      `${snapshotDigest}:verify:${snapshotRepository.identity}:local`,
      created.value.runId,
      snapshotDigest,
      "verify",
      snapshotRepository.identity,
      "local",
      snapshotRepository.candidateHead,
      now,
      now,
      0,
      "sha256:review-capacity-verification",
      0,
      "PASS",
      null,
    ],
  );
  return {
    run: dispatched.value,
    request: {
      runId: created.value.runId,
      projectId,
      executionMode: dispatched.value.executionMode,
      snapshot: frozen.value,
      contract: REVIEW_CONTRACT,
      contractDigest: dispatched.value.contractDigest,
      verification,
    },
    identity: snapshotRepository.identity,
  };
};

/**
 * Creates a real worker allocation after recording a same-window capacity history. The
 * returned decision is from `TaskGraph.startWorkerExecution`, not from the monitor, so a
 * reserve input only proves itself when it changes this production allocation outcome.
 */
const startWorkerWithMeasuredReserve = async (input: {
  remainingPercent: number;
  previousRemainingPercent: number;
  /** Hours remaining from the latest observation until the bucket resets. */
  resetAfterObservationHours: number;
  /** Adds a second ACTIVE, unreviewed run without changing role coverage. */
  extraExpectedReview?: boolean;
  /** Starts a real durable execution in that extra run. */
  extraInFlightRun?: boolean;
  /** Adds a live CEO binding without adding a run that needs review. */
  extraCeoDemand?: boolean;
}) => {
  const plane = makePlane();
  const { cp, clock, gpt, claude } = plane;
  const oneHour = 60 * 60 * 1000;
  // The first reading is one hour before the allocation. Keep one explicit reset bucket
  // across both readings so the monitor can measure burn instead of inventing zero.
  const resetAt = new Date(clock.now().getTime() + oneHour * (1 + input.resetAfterObservationHours)).toISOString();
  const workerCapacity = (remainingPercent: number): CapacityReading =>
    reading("gpt", clock, [{
      id: "worker-window",
      remainingPercent,
      resetAt,
      capabilities: ["worker"],
    }]);
  gpt.setCapacity(workerCapacity(input.previousRemainingPercent));
  await cp.capacity.refresh(RefreshTrigger.DOCTOR_CAPACITY_REPORT, ["gpt"]);
  clock.advance(oneHour);
  gpt.setCapacity(workerCapacity(input.remainingPercent));
  await cp.capacity.refresh(RefreshTrigger.DOCTOR_CAPACITY_REPORT, ["gpt"]);

  // Dispatch is deliberately a normal critical CTO allocation on Claude. The subsequent
  // target is GPT worker capacity, so this test proves the worker gate asks about its own
  // bucket rather than reusing dispatch capacity as a lease.
  claude.setCapacity(healthy("claude", clock));
  const projectId = "worker-reserve-input-project";
  const project = cp.projects.register({ projectId, name: projectId, manifest: fixtureManifest(projectId) });
  if (!project.allowed) throw new Error(project.message);
  const created = cp.runs.create({
    projectId,
    executionMode: ExecutionMode.STANDARD,
    contract: REVIEW_CONTRACT,
  });
  if (!created.allowed) throw new Error(created.message);
  const dispatched = await cp.runs.dispatch(created.value.runId);
  if (!dispatched.allowed) throw new Error(dispatched.message);
  const submitted = cp.tasks.submit(created.value.runId, [
    { key: "worker", title: "reserve input worker", category: "mechanical" },
  ]);
  if (!submitted.allowed) throw new Error(submitted.message);

  const extraRunId = "run_reserve_extra";
  if (input.extraExpectedReview || input.extraInFlightRun) {
    // Both sides of the in-flight comparison retain this unreviewed ACTIVE run. Adding its
    // execution therefore changes only `inFlightRuns`, rather than smuggling in another
    // expected review as well.
    cp.db.run(
      `INSERT INTO runs (run_id, project_id, kind, execution_mode, priority, state, goal, contract_digest, created_at)
       VALUES (?, NULL, 'STANDARD_WORK', 'STANDARD', 'NORMAL', 'ACTIVE', ?, 'sha256:reserve-extra', ?)`,
      [extraRunId, "extra durable reserve demand", clock.nowIso()],
    );
  }
  if (input.extraInFlightRun) {
    cp.db.run(
      `INSERT INTO tasks (task_id, run_id, title, category, state, spec_json, attempt_count, created_at, updated_at)
       VALUES ('tsk_reserve_extra', ?, 'durable in-flight work', 'mechanical', 'RUNNING', '{}', 1, ?, ?)`,
      [extraRunId, clock.nowIso(), clock.nowIso()],
    );
    cp.db.run(
      `INSERT INTO task_executions (execution_id, run_id, task_id, attempt, owner_binding_generation,
                                    worker_session_id, worker_process_id, provider, model, repository_id,
                                    worktree_id, concurrency_width, started_at, last_activity_at, ended_at,
                                    status, failure_class, result_digest)
       VALUES ('exe_reserve_extra', ?, 'tsk_reserve_extra', 1, 1, NULL, NULL, 'gpt', 'worker', NULL,
               NULL, NULL, ?, NULL, NULL, 'RUNNING', NULL, NULL)`,
      [extraRunId, clock.nowIso()],
    );
  }
  if (input.extraCeoDemand) {
    const session = cp.sessions.create({ provider: "gpt", model: "reserve-ceo" });
    const ready = cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "reserve demand fixture");
    if (!ready.allowed) throw new Error(ready.message);
    const bound = cp.bindings.bind({ role: Role.CEO, sessionId: session.sessionId });
    if (!bound.allowed) throw new Error(bound.message);
  }

  const task = cp.tasks.ready(created.value.runId)[0]!;
  const demand = cp.capacity.workerReserveDemand("gpt");
  const started = await cp.tasks.startWorkerExecution({
    runId: created.value.runId,
    taskId: task.taskId,
    ownerBindingGeneration: dispatched.value.ownerBindingGeneration!,
    workerSessionId: dispatched.value.ownerSessionId,
    provider: "gpt",
    model: "worker",
  });
  return { plane, demand, started };
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
      reserveDemand: {
        criticalRoleInvocations: 0, expectedReviews: 0, inFlightRuns: 0, burnRatePercentPerHour: 0,
        roleDemand: { ceo: 0, cto: 0, reviewer: 0 },
      },
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

  it("#54/#176 refuses mandatory blind review without its own capacity and admits it when restored", async () => {
    const plane = makePlane();
    const prepared = await prepareCapacityReviewedRun(plane);
    const exhaustedReviewer = (provider: string) =>
      reading(provider, plane.clock, [{
        id: "review", remainingPercent: 1, resetAt: null, capabilities: ["blind-review"],
      }]);
    plane.gpt.setCapacity(exhaustedReviewer("gpt"));
    plane.claude.setCapacity(exhaustedReviewer("claude"));

    // This enters through the control-plane invoker, not the monitor. Without the reviewer
    // constitution admission, either adapter would start a reviewer before the later
    // invocation gate could refuse it. That would already violate the mandatory pre-review
    // refresh, even though no verdict could be written.
    const gptReviewerStarts = vi.spyOn(plane.gpt, "startSession");
    const claudeReviewerStarts = vi.spyOn(plane.claude, "startSession");
    const refused = await plane.cp.review.controlPlaneInvoker()(prepared.request);
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.CAPACITY_UNKNOWN_NOT_ROUTABLE);
    expect(plane.cp.audit.byKind("BLIND_REVIEW_COMPLETED")).toHaveLength(0);
    expect(gptReviewerStarts).not.toHaveBeenCalled();
    expect(claudeReviewerStarts).not.toHaveBeenCalled();
    gptReviewerStarts.mockRestore();
    claudeReviewerStarts.mockRestore();

    // Capacity can change after a reviewer session is constituted. The invocation has to
    // re-admit rather than treating the successful constitution probe as a quota lease.
    plane.gpt.setCapacity(healthy("gpt", plane.clock));
    const startSession = plane.gpt.startSession.bind(plane.gpt);
    const exhaustAfterConstitution = vi.spyOn(plane.gpt, "startSession").mockImplementation(async (spec) => {
      const handle = await startSession(spec);
      plane.gpt.setCapacity(exhaustedReviewer("gpt"));
      return handle;
    });
    plane.gpt.script({
      match: /Candidate review/,
      text: reviewerPass([`${prepared.identity}:src/app.js`]),
    });
    const refusedAtInvocation = await plane.cp.review.controlPlaneInvoker()(prepared.request);
    expect(refusedAtInvocation.allowed).toBe(false);
    expect(refusedAtInvocation.reasonCode).toBe(ReasonCode.CAPACITY_UNKNOWN_NOT_ROUTABLE);
    expect(plane.gpt.invocations).toHaveLength(0);
    exhaustAfterConstitution.mockRestore();

    plane.gpt.setCapacity(healthy("gpt", plane.clock));
    const admitted = await plane.cp.review.controlPlaneInvoker()(prepared.request);
    expect(admitted.allowed).toBe(true);
    expect(admitted.reasonCode).toBe(ReasonCode.REVIEW_PASS);
  });

  it("#54/#176 turns a provider failure into current continuity state before the next dispatch", async () => {
    const plane = makePlane();
    bindCeo(plane, "gpt");
    plane.gpt.setCapacity(healthy("gpt", plane.clock));
    plane.claude.setCapacity(healthy("claude", plane.clock));
    plane.gpt.script({ match: /allocation failure/, text: "", ok: false });
    const failedCapacity = (provider: string): CapacityReading => ({
      provider,
      sensorHealth: "ERROR",
      runtimeHealth: "HEALTHY",
      observedAt: plane.clock.nowIso(),
      source: "r2-provider-failure",
      buckets: [],
      error: "usage source unreadable after allocation failure",
    });
    // The invocation is a registry-routed provider operation. Its failed result must refresh
    // and evaluate continuity; merely recording the failure leaves the stale NORMAL mode.
    plane.gpt.setCapacity(failedCapacity("gpt"));
    plane.claude.setCapacity(failedCapacity("claude"));
    const failed = await plane.cp.providers.require("gpt").invoke({
      prompt: "allocation failure",
      workdir: plane.root,
      timeoutMs: 1_000,
      readOnly: true,
      correlationId: "provider-failure-continuity",
    });
    expect(failed.ok).toBe(false);
    expect(plane.cp.continuity.mode()).toBe(ContinuityMode.SURVIVAL);

    // Recovery facts alone do not erase a SURVIVAL transition. If the failure refresh did
    // not evaluate continuity, this next dispatch would get past this exact reason code.
    plane.gpt.setCapacity(healthy("gpt", plane.clock));
    plane.claude.setCapacity(healthy("claude", plane.clock));
    const project = plane.cp.projects.register({
      projectId: "failure-continuity-project",
      name: "failure continuity",
      manifest: fixtureManifest("failure-continuity-project"),
    });
    if (!project.allowed) throw new Error(project.message);
    const created = plane.cp.runs.create({
      projectId: project.value.projectId,
      executionMode: ExecutionMode.SIMPLE,
      contract: REVIEW_CONTRACT,
    });
    if (!created.allowed) throw new Error(created.message);
    const refused = await plane.cp.runs.dispatch(created.value.runId);
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.CONTINUITY_SURVIVAL_NO_COMPLETION);
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
      roleDemand: { ceo: 0, cto: 1, reviewer: 1 },
    });
    expect(reserves).toEqual(expect.arrayContaining([expect.objectContaining({ bucketId: "unknown", reserve: 1 })]));
    expect(cp.capacity.dynamicReserve("gpt", {
      criticalRoleInvocations: 2,
      expectedReviews: 1,
      inFlightRuns: 3,
      burnRatePercentPerHour: 4,
      roleDemand: { ceo: 0, cto: 1, reviewer: 1 },
    })).toBe(1);
    const denied = await cp.capacity.refreshForDispatch({
      provider: "gpt",
      capabilities: ["worker"],
      priority: "worker",
      reserveDemand: {
        criticalRoleInvocations: 2, expectedReviews: 1, inFlightRuns: 3, burnRatePercentPerHour: 4,
        roleDemand: { ceo: 0, cto: 1, reviewer: 1 },
      },
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
      reserveDemand: {
        criticalRoleInvocations: 0, expectedReviews: 0, inFlightRuns: 0, burnRatePercentPerHour: 0,
        roleDemand: { ceo: 0, cto: 0, reviewer: 0 },
      },
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
      reserveDemand: {
        criticalRoleInvocations: 2, expectedReviews: 1, inFlightRuns: 3, burnRatePercentPerHour: 4,
        roleDemand: { ceo: 0, cto: 1, reviewer: 1 },
      },
    });
    expect(reserved.reasonCode).toBe(ReasonCode.CAPACITY_ADMISSION_CONSERVE);

    gpt.setCapacity(reading("gpt", clock, [
      { id: "missing-reset", remainingPercent: 80, resetAt: null, capabilities: ["worker"] },
    ]));
    const unknownHorizon = await cp.capacity.refreshForDispatch({
      provider: "gpt",
      capabilities: ["worker"],
      priority: "worker",
      reserveDemand: {
        criticalRoleInvocations: 0, expectedReviews: 0, inFlightRuns: 0, burnRatePercentPerHour: 0,
        roleDemand: { ceo: 0, cto: 0, reviewer: 0 },
      },
    });
    expect(unknownHorizon.allowed).toBe(false);
    expect(unknownHorizon.reasonCode).toBe(ReasonCode.CAPACITY_ADMISSION_CONSERVE);
  });

  it("#55/#182 makes every §14.5 reserve input change real worker admission", async () => {
    // Each pair reaches TaskGraph.startWorkerExecution. The only changed fact in a pair is
    // the named §14.5 input, and the differing result is therefore evidence that production
    // allocation consumes that input rather than a monitor-only calculation.
    const quotaOpen = await startWorkerWithMeasuredReserve({
      remainingPercent: 50,
      previousRemainingPercent: 50,
      resetAfterObservationHours: 1,
    });
    const quotaHeld = await startWorkerWithMeasuredReserve({
      remainingPercent: 20,
      previousRemainingPercent: 20,
      resetAfterObservationHours: 1,
    });
    expect(quotaOpen.started.allowed).toBe(true);
    expect(quotaOpen.started.reasonCode).toBe(ReasonCode.OK);
    expect(quotaHeld.started.allowed).toBe(false);
    expect(quotaHeld.started.reasonCode).toBe(ReasonCode.CAPACITY_ADMISSION_CONSERVE);
    quotaOpen.plane.cp.close();
    quotaHeld.plane.cp.close();

    const shortHorizon = await startWorkerWithMeasuredReserve({
      remainingPercent: 50,
      previousRemainingPercent: 80,
      resetAfterObservationHours: 0.5,
    });
    const longHorizon = await startWorkerWithMeasuredReserve({
      remainingPercent: 50,
      previousRemainingPercent: 80,
      resetAfterObservationHours: 1,
    });
    expect(shortHorizon.started.allowed).toBe(true);
    expect(shortHorizon.started.reasonCode).toBe(ReasonCode.OK);
    expect(longHorizon.started.allowed).toBe(false);
    expect(longHorizon.started.reasonCode).toBe(ReasonCode.CAPACITY_ADMISSION_CONSERVE);
    shortHorizon.plane.cp.close();
    longHorizon.plane.cp.close();

    const noBurn = await startWorkerWithMeasuredReserve({
      remainingPercent: 50,
      previousRemainingPercent: 50,
      resetAfterObservationHours: 1,
    });
    const measuredBurn = await startWorkerWithMeasuredReserve({
      remainingPercent: 50,
      previousRemainingPercent: 80,
      resetAfterObservationHours: 1,
    });
    expect(noBurn.demand.burnRatePercentPerHourByBucket?.["worker-window"]).toBe(0);
    expect(measuredBurn.demand.burnRatePercentPerHourByBucket?.["worker-window"]).toBe(30);
    expect(noBurn.started.allowed).toBe(true);
    expect(noBurn.started.reasonCode).toBe(ReasonCode.OK);
    expect(measuredBurn.started.allowed).toBe(false);
    expect(measuredBurn.started.reasonCode).toBe(ReasonCode.CAPACITY_ADMISSION_CONSERVE);
    noBurn.plane.cp.close();
    measuredBurn.plane.cp.close();

    const oneReview = await startWorkerWithMeasuredReserve({
      remainingPercent: 27,
      previousRemainingPercent: 27,
      resetAfterObservationHours: 1,
    });
    const twoReviews = await startWorkerWithMeasuredReserve({
      remainingPercent: 27,
      previousRemainingPercent: 27,
      resetAfterObservationHours: 1,
      extraExpectedReview: true,
    });
    expect(oneReview.demand.expectedReviews).toBe(1);
    expect(twoReviews.demand.expectedReviews).toBe(2);
    expect(oneReview.started.allowed).toBe(true);
    expect(oneReview.started.reasonCode).toBe(ReasonCode.OK);
    expect(twoReviews.started.allowed).toBe(false);
    expect(twoReviews.started.reasonCode).toBe(ReasonCode.CAPACITY_ADMISSION_CONSERVE);
    oneReview.plane.cp.close();
    twoReviews.plane.cp.close();

    const noFlight = await startWorkerWithMeasuredReserve({
      remainingPercent: 30,
      previousRemainingPercent: 30,
      resetAfterObservationHours: 1,
      extraExpectedReview: true,
    });
    const inFlight = await startWorkerWithMeasuredReserve({
      remainingPercent: 30,
      previousRemainingPercent: 30,
      resetAfterObservationHours: 1,
      extraExpectedReview: true,
      extraInFlightRun: true,
    });
    expect(noFlight.demand.inFlightRuns).toBe(0);
    expect(inFlight.demand.inFlightRuns).toBe(1);
    expect(noFlight.started.allowed).toBe(true);
    expect(noFlight.started.reasonCode).toBe(ReasonCode.OK);
    expect(inFlight.started.allowed).toBe(false);
    expect(inFlight.started.reasonCode).toBe(ReasonCode.CAPACITY_ADMISSION_CONSERVE);
    noFlight.plane.cp.close();
    inFlight.plane.cp.close();

    // At 30%, the CEO's aggregate invocation count alone would still admit; the separate
    // CEO coverage weight is what crosses the reserve boundary in the second allocation.
    const baselineRoles = await startWorkerWithMeasuredReserve({
      remainingPercent: 30,
      previousRemainingPercent: 30,
      resetAfterObservationHours: 1,
    });
    const ceoCoverage = await startWorkerWithMeasuredReserve({
      remainingPercent: 30,
      previousRemainingPercent: 30,
      resetAfterObservationHours: 1,
      extraCeoDemand: true,
    });
    expect(baselineRoles.demand.roleDemand).toEqual({ ceo: 0, cto: 1, reviewer: 0 });
    expect(ceoCoverage.demand.roleDemand).toEqual({ ceo: 1, cto: 1, reviewer: 0 });
    expect(baselineRoles.started.allowed).toBe(true);
    expect(baselineRoles.started.reasonCode).toBe(ReasonCode.OK);
    expect(ceoCoverage.started.allowed).toBe(false);
    expect(ceoCoverage.started.reasonCode).toBe(ReasonCode.CAPACITY_ADMISSION_CONSERVE);
    baselineRoles.plane.cp.close();
    ceoCoverage.plane.cp.close();
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
      [
        "GIT_CONFIG_NOSYSTEM",
        "GIT_TERMINAL_PROMPT",
        "HOME",
        "LANG",
        "LC_ALL",
        "PATH",
        "TMPDIR",
        "USER",
        "CLAUDE_SECURESTORAGE_CONFIG_DIR",
      ].filter(
        (name) =>
          (name !== "USER" || process.env["USER"]) &&
          (name !== "CLAUDE_SECURESTORAGE_CONFIG_DIR" || process.env["CLAUDE_SECURESTORAGE_CONFIG_DIR"]),
      ).sort(),
    );
  });

  it("#353 denies host keychains and Git credentials without removing the provider HOME or USER", async () => {
    const clock = new ManualClock("2026-08-12T00:00:00.000Z");
    const workdir = tempDir("acp-runtime-work-");
    const hostHome = tempDir("acp-runtime-home-");
    const hostTmp = tempDir("acp-runtime-host-tmp-");
    const providerScope = tempDir("acp-runtime-provider-");
    const ghDirectory = tempDir("acp-runtime-gh-");
    const workFile = join(workdir, "packet.txt");
    const gitconfig = join(hostHome, ".gitconfig");
    const netrc = join(hostHome, ".netrc");
    const keychain = join(hostHome, "Library", "Keychains", "login.keychain-db");
    mkdirSync(join(hostHome, "Library", "Keychains"), { recursive: true });
    writeFileSync(workFile, "packet input");
    writeFileSync(gitconfig, "[user]\nname = daemon\n");
    writeFileSync(netrc, "machine github.example login daemon password token\n");
    writeFileSync(keychain, "daemon provider and GitHub credentials");
    writeFileSync(join(ghDirectory, "gh"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(ghDirectory, "gh"), 0o700);
    const binary = writeCliProbe(workdir, [workFile, gitconfig, netrc, keychain]);

    await withEnvironment({
      HOME: hostHome,
      USER: "acp-provider",
      PATH: ghDirectory,
      TMPDIR: hostTmp,
      GH_TOKEN: "ghp_this_must_not_reach_the_agent",
      CLAUDE_SECURESTORAGE_CONFIG_DIR: providerScope,
    }, async () => {
      const adapter = new ClaudeCliAdapter({
        clock,
        capacityFile: join(workdir, "capacity.json"),
        binary,
        // The deployment provisioned a provider credential store, which is what makes closing
        // the host keychain possible rather than self-defeating — without one, denying it stops
        // every session authenticating and dispatch fails SESSION_NOT_READY.
        providerCredentialDir: providerScope,
        // PATH is deliberately listed: an allowlist must not be able to reintroduce gh.
        environmentAllowlist: ["PATH", "GH_TOKEN"],
      });
      const result = await adapter.invoke({
        prompt: "Report the runtime boundary.",
        workdir,
        timeoutMs: 5_000,
        readOnly: false,
        correlationId: "runtime-credential-containment",
      });

      expect(result.ok).toBe(true);
      const probe = JSON.parse(result.text) as CliProbe;
      // `__CF_*` is injected by macOS into any sandbox-exec child; it is not ours to remove
      // and carries no authority, so the assertion is about the variables we construct.
      const { TMPDIR, ...rest } = probe.environment;
      const fixedEnvironment = Object.fromEntries(
        Object.entries(rest).filter(([name]) => !name.startsWith("__CF_")),
      );
      expect(fixedEnvironment).toEqual({
        PATH: noGhPath(),
        HOME: hostHome,
        USER: "acp-provider",
        LANG: "C.UTF-8",
        LC_ALL: "C",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        CLAUDE_SECURESTORAGE_CONFIG_DIR: providerScope,
      });
      expect(TMPDIR).not.toBe(hostTmp);
      expect(TMPDIR).not.toBe(hostHome);
      const runtimePath = probe.environment.PATH;
      if (!runtimePath) throw new Error("runtime probe did not receive PATH");
      expect(runtimePath.split(":")).not.toContain(ghDirectory);
      expect(probe.environment.GH_TOKEN).toBeUndefined();
      expect(probe.readable).toEqual({
        [workFile]: true,
        [gitconfig]: false,
        [netrc]: false,
        // Closed, because this fixture provisioned a provider credential store. Without one,
        // denying the host keychain would stop the provider authenticating at all — #354
        // asserts that open case, and dispatch fails SESSION_NOT_READY when it is wrong.
        [keychain]: false,
      });
    });
  });

  it("#354 drives the real reviewer adapter through an applied packet-only profile", async () => {
    const clock = new ManualClock("2026-08-12T00:00:00.000Z");
    const packetRoot = tempDir("acp-reviewer-packet-");
    const hostHome = tempDir("acp-reviewer-home-");
    const providerScope = tempDir("acp-reviewer-provider-");
    const ghDirectory = tempDir("acp-reviewer-gh-");
    const packetFile = join(packetRoot, "packet.json");
    const daemonFile = join(tempDir("acp-reviewer-daemon-"), "state.sqlite");
    const providerConfig = join(providerScope, ".claude.json");
    const gitconfig = join(hostHome, ".gitconfig");
    const netrc = join(hostHome, ".netrc");
    const keychain = join(hostHome, "Library", "Keychains", "login.keychain-db");
    mkdirSync(join(hostHome, "Library", "Keychains"), { recursive: true });
    writeFileSync(packetFile, "immutable review input");
    writeFileSync(daemonFile, "daemon state");
    writeFileSync(providerConfig, "scoped provider configuration");
    writeFileSync(gitconfig, "[user]\nname = daemon\n");
    writeFileSync(netrc, "machine github.example login daemon password token\n");
    writeFileSync(keychain, "host keychain must not be granted to reviewers");
    writeFileSync(join(ghDirectory, "gh"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(ghDirectory, "gh"), 0o700);
    const binary = writeCliProbe(packetRoot, [packetFile, providerConfig, daemonFile, gitconfig, netrc, keychain]);

    await withEnvironment({
      HOME: hostHome,
      USER: "acp-reviewer-provider",
      PATH: ghDirectory,
      GH_TOKEN: "ghp_this_must_not_reach_the_reviewer",
      CLAUDE_CONFIG_DIR: providerScope,
    }, async () => {
      const adapter = new ClaudeCliAdapter({
        clock,
        capacityFile: join(packetRoot, "capacity.json"),
        binary,
      });
      const result = await adapter.invoke({
        prompt: "Review this packet only.",
        workdir: packetRoot,
        timeoutMs: 5_000,
        readOnly: true,
        correlationId: "reviewer-isolation-spawn-path",
        isolation: {
          packetRoot,
          denyReadPaths: [daemonFile],
          emptyEnvironment: true,
          network: "provider-only",
          tools: "none",
        },
      });

      // A non-zero provider answer would still attest an applied profile. This stub exits
      // cleanly so its observations can prove the profile and exact environment instead.
      expect(result.ok).toBe(true);
      expect(result.isolationAttested).toBe(true);
      expect(result.isolationReasonCode).toBeUndefined();
      const probe = JSON.parse(result.text) as CliProbe;
      // `__CF_*` is injected by macOS into any sandbox-exec child, and the adapter
      // canonicalises the packet root (`/var` is a symlink to `/private/var` here), so the
      // assertion is about the variables we construct and the directory we actually confined to.
      const reviewerEnv = Object.fromEntries(
        Object.entries(probe.environment).filter(([name]) => !name.startsWith("__CF_")),
      );
      const canonicalPacketRoot = realpathSync(packetRoot);
      expect(reviewerEnv).toEqual({
        PATH: noGhPath(),
        HOME: canonicalPacketRoot,
        USER: "acp-reviewer-provider",
        TMPDIR: canonicalPacketRoot,
        LANG: "C.UTF-8",
        LC_ALL: "C",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        CLAUDE_CONFIG_DIR: providerScope,
        CLAUDE_SECURESTORAGE_CONFIG_DIR: providerScope,
      });
      expect(probe.readable).toEqual({
        [packetFile]: true,
        [providerConfig]: true,
        [daemonFile]: false,
        [gitconfig]: false,
        [netrc]: false,
        // Closed: this fixture gives the reviewer a scoped provider config, which is what makes
        // shutting the host keychain safe. Where a deployment provisions nothing, the keychain
        // stays open because the provider could not otherwise authenticate at all.
        [keychain]: false,
      });
    });
  });

  it("#354 returns ISOLATION_LOST when the reviewer profile cannot be applied", async () => {
    const clock = new ManualClock("2026-08-12T00:00:00.000Z");
    const packetRoot = tempDir("acp-reviewer-profile-failure-");
    const adapter = new ClaudeCliAdapter({
      clock,
      capacityFile: join(packetRoot, "capacity.json"),
      binary: writeCliProbe(packetRoot, []),
    });

    const result = await adapter.invoke({
      prompt: "This provider binary must not run.",
      workdir: packetRoot,
      timeoutMs: 5_000,
      readOnly: true,
      correlationId: "reviewer-profile-not-applied",
      isolation: {
        packetRoot,
        // `spawn` rejects a seatbelt argv that contains NUL. The adapter must turn that
        // unusable profile into an unattested isolation result, not an uncaught exception.
        denyReadPaths: ["/tmp/acp-profile\u0000cannot-apply"],
        emptyEnvironment: true,
        network: "provider-only",
        tools: "none",
      },
    });

    expect(result.ok).toBe(false);
    expect(result.isolationAttested).toBe(false);
    expect(result.isolationReasonCode).toBe(ReasonCode.ISOLATION_LOST);
    expect(result.error).toContain("null bytes");
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
        network: "provider-only",
        tools: "none",
      },
    });

    expect(result.ok).toBe(false);
    expect(result.isolationAttested).toBe(false);
    expect(result.isolationReasonCode).toBe(ReasonCode.ISOLATION_LOST);
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

  it("#54/#176 refuses a continuity switch when its selected provider expires after planning", async () => {
    const plane = makePlane();
    const before = bindCeo(plane, "claude");
    const unavailable = (provider: string): CapacityReading => ({
      provider,
      sensorHealth: "ERROR",
      runtimeHealth: "UNAVAILABLE",
      observedAt: plane.clock.nowIso(),
      source: "provider-switch-race",
      buckets: [],
      error: "capacity expired after continuity planned its fallback",
    });
    // The initial continuity evaluation chooses GPT. Its capacity then expires before the
    // replacement allocation. Deleting the provider-switch admission below makes this
    // failover succeed, because startSession itself is not a quota admission mechanism.
    plane.gpt.setCapacity(healthy("gpt", plane.clock));
    plane.claude.setCapacity(unavailable("claude"));
    const originalProbe = plane.gpt.probeCapacity.bind(plane.gpt);
    let probes = 0;
    vi.spyOn(plane.gpt, "probeCapacity").mockImplementation(async () => {
      const observed = await originalProbe();
      if (probes++ === 0) plane.gpt.setCapacity(unavailable("gpt"));
      return observed;
    });
    const started = vi.spyOn(plane.gpt, "startSession");
    attachRoutablePorts(plane.cp);

    const denied = await plane.cp.continuity.failover(
      roleKeyFor(Role.CEO),
      Role.CEO,
      {},
      "selected fallback capacity changed",
    );
    expect(denied.allowed).toBe(false);
    expect(denied.reasonCode).toBe(ReasonCode.CAPACITY_UNKNOWN_NOT_ROUTABLE);
    expect(started).not.toHaveBeenCalled();
    expect(plane.cp.bindings.active(roleKeyFor(Role.CEO))?.sessionId).toBe(before.sessionId);
    expect(probes).toBeGreaterThan(1);
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
