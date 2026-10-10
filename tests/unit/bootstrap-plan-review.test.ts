import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { bootstrapActivationHandoff, currentBootstrapPlan } from "../../src/bootstrap/bootstrap-plan.ts";
import { plannedBootstrapFiles, produceRepoFactoryResult, type RepoFactoryPlanFixture } from "../../src/bootstrap/repo-factory-producer.ts";
import { digestOf } from "../../src/core/digest.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { manifestDigest, type ProjectManifest } from "../../src/contracts/manifest.ts";
import { startLocalMcpListeners, startSessionLaunchChannel } from "../../src/daemon/agentcpd.ts";
import { ExecutionMode, Role, RunKind, RunState, SessionLifecycle } from "../../src/domain/types.ts";
import type { TaskContract } from "../../src/run/run-engine.ts";
import type { CapacityReading } from "../../src/runtime/provider.ts";
import {
  CANDIDATE_SNAPSHOT_SCHEMA_ID,
  buildNoRepositoryCandidateSnapshot,
  candidateSnapshotDigest,
  type CandidateSnapshot,
} from "../../src/snapshot/candidate-snapshot.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { makeHarness, registerFixtureProject, reviewerPass, reviewerRevise, type Harness } from "../helpers/harness.ts";
import { bootstrapCoverageKeys, bootstrapPlan, cleanTreeManifest } from "../helpers/bootstrap-plan.ts";
import { callMcpToolOverSocket, claimLaunchedCredential } from "../helpers/mcp-socket.ts";
import { HeadlessRuntimeDouble } from "../helpers/headless-runtime.ts";

afterAll(cleanupTempDirs);
afterEach(() => vi.restoreAllMocks());

/**
 * Issue #246 PR-C slice C2 — the bootstrap blind review, witnessed.
 *
 * Every state change goes through a real door: run_create, run_dispatch and ceo_decision_submit over
 * `hermes.mcp.sock` as the CEO; plan_submit, task_worker_provision, task_receipt_submit and
 * result_submit over `cto.mcp.sock` as the run's bootstrap CTO, with the credential its launch
 * channel issued. The blind reviewer is the harness's scripted reviewer, constituted by the review
 * gate itself; the Claude runtime is a scripted double. Readiness and confirmation are read through
 * `BootstrapActivation`'s own checks, which change nothing. No review is written and no run state is
 * moved by the test.
 */
const TOKEN = "bootstrap-plan-review-token";

const CONTRACT: TaskContract = {
  goal: "bootstrap a new project",
  why: "the owner asked for a repository that does not exist yet",
  scope: [],
  nonGoals: [],
  acceptance: ["the planned repository is what the manifest describes"],
  priority: "NORMAL",
  humanGate: [],
  references: [],
};

/** One Claude window as the usage collector reports it, `minutesAgo` old. */
const claudeReading = (harness: Harness, remainingPercent: number, minutesAgo = 0): CapacityReading => {
  const now = harness.clock.now().getTime();
  return {
    provider: "claude",
    sensorHealth: "HEALTHY",
    runtimeHealth: "HEALTHY",
    observedAt: new Date(now - minutesAgo * 60_000).toISOString(),
    source: "bootstrap-plan-review-fixture",
    buckets: [{
      id: "five_hour",
      remainingPercent,
      resetAt: new Date(now + 2 * 60 * 60_000).toISOString(),
      capabilities: ["ceo", "cto", "blind-review", "worker"],
    }],
  };
};

const reviewFixture = async () => {
  const harness = makeHarness();
  const launch = await startSessionLaunchChannel(tempDir("acp-c2-launch-"), { mcpToken: TOKEN });
  harness.cp.cto.attach({ sessionLaunch: launch });
  // Claude Opus staffs the bootstrap CTO and the workers; the reviewer is the harness's own.
  const claude = new HeadlessRuntimeDouble(harness.clock, "claude");
  harness.cp.providers.registerForRole(claude, Role.BOOTSTRAP_CTO);
  harness.cp.providers.registerForRole(claude, Role.WORKER);
  // A Claude WORKER allocation needs one earlier reading through the role's own probe (#512).
  claude.setCapacity(claudeReading(harness, 81, 3));
  await harness.cp.capacity.refreshForRole("claude", Role.WORKER);
  claude.setCapacity(claudeReading(harness, 80));

  const ceo = harness.cp.sessions.create({ provider: "scripted", model: "c2-ceo" });
  const ceoSecret = ceo.sessionSecret;
  if (!ceoSecret) throw new Error("the CEO session has no secret");
  harness.cp.sessions.transition(ceo.sessionId, SessionLifecycle.READY, "fixture CEO");
  const boundCeo = harness.cp.bindings.bind({ role: Role.CEO, sessionId: ceo.sessionId });
  if (!boundCeo.allowed) throw new Error(boundCeo.message);

  const listeners = await startLocalMcpListeners(harness.cp, tempDir("acp-c2-mcp-"), TOKEN);
  const [hermesSocket, ctoSocket] = listeners.socketPaths;
  if (!hermesSocket || !ctoSocket) throw new Error("the MCP listeners were not started");
  // C1b: the bootstrap CTO's runtime reaches the daemon over these two sockets.
  harness.cp.sessionRuntime.attach({
    delivery: launch,
    route: { launchSocketPath: launch.socketPath, mcpSocketPath: ctoSocket },
  });
  let keys = 0;
  const hermes = (name: string, args: Record<string, unknown>) =>
    callMcpToolOverSocket(hermesSocket, { token: TOKEN, sessionId: ceo.sessionId, sessionSecret: ceoSecret }, name, {
      idempotencyKey: `c2-${++keys}`,
      ...args,
    });
  // C1b: a bootstrap CTO's credential is the one its runtime took from the launch channel during its
  // attestation turn; a row acts as that runtime by presenting it, as the runtime's relay would. A
  // session no runtime drives (a project run's CTO) still has its credential claimed from the channel.
  const claimed = new Map<string, { sessionId: string; sessionSecret: string }>();
  const cto = async (sessionId: string, name: string, args: Record<string, unknown>) => {
    let credential: { sessionId: string; sessionSecret: string } | undefined =
      claude.credentials.get(sessionId) ?? claimed.get(sessionId);
    if (!credential) {
      const session = harness.cp.sessions.require(sessionId);
      credential = await claimLaunchedCredential(launch.socketPath, session.incarnation.split("#", 1)[0]!);
      claimed.set(sessionId, credential);
    }
    return callMcpToolOverSocket(
      ctoSocket,
      { token: TOKEN, sessionId: credential.sessionId, sessionSecret: credential.sessionSecret },
      name,
      { idempotencyKey: `c2-${++keys}`, ...args },
    );
  };
  return {
    harness,
    ceoSessionId: ceo.sessionId,
    hermes,
    cto,
    close: async () => {
      await listeners.close();
      await launch.close();
    },
  };
};

type Fixture = Awaited<ReturnType<typeof reviewFixture>>;

const withFixture = async (body: (f: Fixture) => Promise<void>): Promise<void> => {
  const f = await reviewFixture();
  try {
    await body(f);
  } finally {
    await f.close();
  }
};

interface BootstrapRun {
  runId: string;
  owner: string;
}

/** run_create (no project) and run_dispatch over the Hermes socket: the run's BOOTSTRAP_CTO is staffed. */
const dispatchedBootstrap = async (f: Fixture): Promise<BootstrapRun> => {
  const created = await f.hermes("run_create", {
    kind: RunKind.PROJECT_BOOTSTRAP,
    executionMode: ExecutionMode.STANDARD,
    contract: CONTRACT,
  });
  if (created["ok"] !== true) throw new Error(`run_create refused: ${JSON.stringify(created)}`);
  const runId = (created["value"] as { runId: string }).runId;
  const dispatched = await f.hermes("run_dispatch", { runId });
  if (dispatched["ok"] !== true) throw new Error(`run_dispatch refused: ${JSON.stringify(dispatched)}`);
  return { runId, owner: f.harness.cp.runs.require(runId).ownerSessionId! };
};

const submitPlan = (f: Fixture, run: BootstrapRun, plan: Record<string, unknown>, taskKey: string) =>
  f.cto(run.owner, "plan_submit", {
    runId: run.runId,
    plan,
    tasks: [{ key: taskKey, title: taskKey, category: "implementation" }],
  });

/** Every READY task staffed with its own Claude Opus worker and carried to SUCCEEDED, over the CTO socket. */
const workReadyTasks = async (f: Fixture, run: BootstrapRun): Promise<void> => {
  for (const task of f.harness.cp.tasks.ready(run.runId)) {
    const provisioned = await f.cto(run.owner, "task_worker_provision", { runId: run.runId, taskId: task.taskId, provider: "claude" });
    expect(provisioned, JSON.stringify(provisioned)).toMatchObject({ ok: true });
    const workerSessionId = (provisioned["value"] as { workerSessionId: string }).workerSessionId;
    const started = await f.cto(run.owner, "task_receipt_submit", {
      runId: run.runId,
      taskId: task.taskId,
      phase: "started",
      workerSessionId,
    });
    expect(started, JSON.stringify(started)).toMatchObject({ ok: true });
    const finished = await f.cto(run.owner, "task_receipt_submit", {
      runId: run.runId,
      taskId: task.taskId,
      phase: "finished",
      executionId: (started["value"] as { executionId: string }).executionId,
      workerSessionId,
      status: "SUCCEEDED",
      resultDigest: digestOf({ task: task.taskId }),
    });
    expect(finished, JSON.stringify(finished)).toMatchObject({ ok: true });
  }
};

/**
 * The coverage a passing reviewer of the run's current PLAN names. A PLAN that carries no manifest
 * has no planned outputs (on c315463e, plan_submit dropped the manifest); no review can be asked
 * for it, and the witness fails on what the run does next rather than here.
 */
const coverageKeys = (f: Fixture, run: BootstrapRun): string[] => {
  try {
    return bootstrapCoverageKeys(f.harness, run.runId);
  } catch {
    return [];
  }
};

/**
 * result_submit over the CTO socket; the scripted reviewer passes whatever the gate asks it to cover.
 * Continuity is reconciled first, as the daemon does on its own schedule, so a stale coverage
 * reading is not what decides the row.
 */
const submitResult = async (f: Fixture, run: BootstrapRun) => {
  await f.harness.cp.continuity.evaluate("before result_submit");
  f.harness.scripted.script({ match: /Bootstrap plan review/, text: reviewerPass(coverageKeys(f, run)) });
  return f.cto(run.owner, "result_submit", {
    runId: run.runId,
    resultSummary: "the planned bootstrap outputs",
    recommendation: "create the repository",
  });
};

/** plan_submit, its task done, result_submit: the candidate's digest once the review has passed. */
const reviewedPlan = async (f: Fixture, run: BootstrapRun, manifest: ProjectManifest, taskKey: string): Promise<string> => {
  expect(await submitPlan(f, run, bootstrapPlan(manifest), taskKey)).toMatchObject({ ok: true });
  await workReadyTasks(f, run);
  const submitted = await submitResult(f, run);
  expect(submitted, JSON.stringify(submitted)).toMatchObject({ ok: true, value: { stage: "COMPLETED_REVIEW" } });
  return (submitted["value"] as { snapshotDigest: string }).snapshotDigest;
};

/** The CEO's FINAL_REVISE over the Hermes socket, then run_dispatch again to the live bootstrap CTO. */
const reviseAndRedispatch = async (f: Fixture, run: BootstrapRun, candidate: string): Promise<void> => {
  const revised = await f.hermes("ceo_decision_submit", {
    runId: run.runId,
    decision: "FINAL_REVISE",
    candidateSnapshotDigest: candidate,
    ceoSessionId: f.ceoSessionId,
    rationale: "plan another manifest",
  });
  expect(revised, JSON.stringify(revised)).toMatchObject({ ok: true, value: { state: RunState.REVISION_REQUIRED } });
  const redispatched = await f.hermes("run_dispatch", { runId: run.runId });
  expect(redispatched, JSON.stringify(redispatched)).toMatchObject({ ok: true, value: { state: RunState.ACTIVE } });
};

describe("#246 C2 W5: a PASS for one plan never stands for another", () => {
  it("a PASS for plan P1 does not satisfy readiness for P2 once the run is re-planned with a different manifest", async () => {
    await withFixture(async (f) => {
      const run = await dispatchedBootstrap(f);
      const m1 = cleanTreeManifest("c2-w5-first");
      const m2 = cleanTreeManifest("c2-w5-second");
      const s1 = await reviewedPlan(f, run, m1, "plan-1");
      expect(f.harness.cp.runs.require(run.runId).state).toBe(RunState.READY_FOR_CEO_REVIEW);
      expect(f.harness.cp.bootstrap.readinessForFactoryResult(run.runId, bootstrapActivationHandoff(m1), s1))
        .toMatchObject({ allowed: true });
      expect(f.harness.cp.bootstrap.reviewForConfirmation(run.runId, s1)).toMatchObject({ allowed: true });

      // The CEO sends it back and the bootstrap CTO plans another manifest.
      await reviseAndRedispatch(f, run, s1);
      expect(await submitPlan(f, run, bootstrapPlan(m2), "plan-2")).toMatchObject({ ok: true });

      // P1's PASS is still on record for its candidate, and answers nothing for P2.
      const stale = f.harness.cp.bootstrap.reviewForConfirmation(run.runId, s1);
      expect(stale).toMatchObject({
        allowed: false,
        reasonCode: ReasonCode.BOOTSTRAP_ACTIVATION_INCOMPLETE,
        evidence: { refusal: "BOOTSTRAP_REVIEW_NOT_BOUND" },
      });
      const notReady = f.harness.cp.bootstrap.readinessForFactoryResult(run.runId, bootstrapActivationHandoff(m2), s1);
      expect(notReady).toMatchObject({
        allowed: false,
        reasonCode: ReasonCode.BOOTSTRAP_ACTIVATION_INCOMPLETE,
        evidence: { incomplete: ["blindReview"], refusal: "BOOTSTRAP_REVIEW_NOT_BOUND" },
      });

      // P2's own review is another candidate, and only that candidate is ready.
      await workReadyTasks(f, run);
      const submitted = await submitResult(f, run);
      expect(submitted, JSON.stringify(submitted)).toMatchObject({ ok: true, value: { stage: "COMPLETED_REVIEW" } });
      const s2 = (submitted["value"] as { snapshotDigest: string }).snapshotDigest;
      expect(s2).not.toBe(s1);
      expect(f.harness.cp.bootstrap.readinessForFactoryResult(run.runId, bootstrapActivationHandoff(m2), s2))
        .toMatchObject({ allowed: true });
      expect(f.harness.cp.bootstrap.readinessForFactoryResult(run.runId, bootstrapActivationHandoff(m2), s1))
        .toMatchObject({ allowed: false, reasonCode: ReasonCode.BOOTSTRAP_ACTIVATION_INCOMPLETE });
      expect(f.harness.cp.bootstrap.reviewForConfirmation(run.runId, s1)).toMatchObject({ allowed: false });
      // #246 C3 reopens the CONFIRM through the runner's full path; with no owner approval of the
      // GitHub writes recorded, it is refused there, writing nothing and reserving nothing.
      const confirm = await f.hermes("ceo_decision_submit", {
        runId: run.runId,
        decision: "CONFIRM",
        candidateSnapshotDigest: s2,
        ceoSessionId: f.ceoSessionId,
        rationale: "C3 door",
      });
      expect(confirm).toMatchObject({
        ok: false,
        reasonCode: ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE,
        evidence: { stage: "approval", refusal: "APPROVAL_MISSING" },
      });
      expect(f.harness.cp.bootstrapApplications.get(run.runId)).toBeNull();
    });
  });
});

describe("#246 C2: a bootstrap plan reaches the CEO only on a PASS", () => {
  it("a REVISE returns the run to its bootstrap CTO, and the production gate refuses a packet for that candidate", async () => {
    await withFixture(async (f) => {
      const run = await dispatchedBootstrap(f);
      expect(await submitPlan(f, run, bootstrapPlan(cleanTreeManifest("c2-revise")), "plan-1")).toMatchObject({ ok: true });
      await workReadyTasks(f, run);
      await f.harness.cp.continuity.evaluate("before result_submit");
      f.harness.scripted.script({
        match: /Bootstrap plan review/,
        text: reviewerRevise(coverageKeys(f, run), "the default branch protection is weaker than the manifest asks"),
      });
      const submitted = await f.cto(run.owner, "result_submit", {
        runId: run.runId,
        resultSummary: "the planned bootstrap outputs",
        recommendation: "create the repository",
      });
      expect(submitted, JSON.stringify(submitted)).toMatchObject({
        ok: true,
        value: { stage: "REVISION_REQUIRED", reasonCode: ReasonCode.REVIEW_REVISE },
      });
      const candidate = (submitted["value"] as { snapshotDigest: string }).snapshotDigest;
      const runRow = f.harness.cp.runs.require(run.runId);
      expect(runRow.state).toBe(RunState.ACTIVE);
      expect(f.harness.cp.outbox.listByRun(run.runId).map((message) => message.kind)).toContain("REVISION_REQUEST");
      expect(
        f.harness.cp.artifacts.latestForSnapshot<{ verdict: string }>(run.runId, "BLIND_REVIEW", candidate)?.content.verdict,
      ).toBe("REVISE");

      // The production gate's own check: no packet for a bootstrap candidate without a PASS.
      await f.harness.cp.continuity.evaluate("packet");
      const packet = f.harness.cp.ceo.buildPacket({
        runId: run.runId,
        candidateSnapshotDigest: candidate,
        approval: {
          runId: run.runId,
          candidateSnapshotDigest: candidate,
          resultSummary: "the planned bootstrap outputs",
          recommendation: "create the repository",
          residualRisk: [],
          approvedBySessionId: runRow.ownerSessionId!,
          approvedByGeneration: runRow.ownerBindingGeneration!,
          approvedAt: f.harness.clock.nowIso(),
        },
      });
      expect(packet).toMatchObject({ allowed: false, reasonCode: ReasonCode.REVIEW_REQUIRED });
      expect(f.harness.cp.runs.require(run.runId).state).toBe(RunState.ACTIVE);
    });
  });
});

describe("#246 C2: plan_submit carries the bootstrap manifest", () => {
  it("refuses a bootstrap plan whose manifest digest mismatches, that is not portable, or that names a digest with no manifest — storing nothing", async () => {
    await withFixture(async (f) => {
      const run = await dispatchedBootstrap(f);
      const manifest = cleanTreeManifest("c2-plan-submit");

      const mismatched = await submitPlan(
        f,
        run,
        { ...bootstrapPlan(manifest), projectManifestDigest: manifestDigest(cleanTreeManifest("someone-else")) },
        "mismatched",
      );
      expect(mismatched).toMatchObject({
        ok: false,
        reasonCode: ReasonCode.BOOTSTRAP_CONTRACT_DRIFT,
        evidence: { refusal: "MANIFEST_MISMATCH", supplied: manifestDigest(manifest) },
      });

      const notPortable = cleanTreeManifest("c2-plan-submit", {
        repositories: [{ role: "primary", remote: "/Users/someone/fixture", manifestRoot: "." }],
      });
      expect(await submitPlan(f, run, bootstrapPlan(notPortable), "not-portable")).toMatchObject({
        ok: false,
        reasonCode: ReasonCode.MANIFEST_NOT_PORTABLE,
        evidence: { refusal: "MANIFEST_NOT_PORTABLE" },
      });

      const { projectManifest: _carried, ...digestOnly } = bootstrapPlan(manifest);
      void _carried;
      expect(await submitPlan(f, run, digestOnly, "digest-only")).toMatchObject({
        ok: false,
        reasonCode: ReasonCode.INVALID_ARGUMENT,
        evidence: { refusal: "MANIFEST_MISSING" },
      });

      expect(f.harness.cp.artifacts.list(run.runId, "PLAN")).toEqual([]);
      expect(f.harness.cp.tasks.list(run.runId)).toEqual([]);

      // The manifest it does carry is kept in the PLAN, and the PLAN digest covers it.
      expect(await submitPlan(f, run, bootstrapPlan(manifest), "accepted")).toMatchObject({ ok: true });
      const stored = f.harness.cp.artifacts.latest<{ projectManifest?: unknown }>(run.runId, "PLAN");
      expect(stored?.content.projectManifest).toEqual(manifest);
      expect(stored?.digest).toBe(digestOf(stored?.content));
    });
  });

  it("a non-bootstrap run's plan_submit is unchanged: the PLAN it stores never carries a manifest (invariance)", async () => {
    await withFixture(async (f) => {
      const { projectId, repositoryId } = await registerFixtureProject(f.harness, "c2-standard-project");
      const created = await f.hermes("run_create", {
        projectId,
        executionMode: ExecutionMode.STANDARD,
        contract: CONTRACT,
        repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
      });
      expect(created, JSON.stringify(created)).toMatchObject({ ok: true });
      const runId = (created["value"] as { runId: string }).runId;
      expect(await f.hermes("run_dispatch", { runId })).toMatchObject({ ok: true });
      const owner = f.harness.cp.runs.require(runId).ownerSessionId!;
      const submitted = await f.cto(owner, "plan_submit", {
        runId,
        plan: { summary: "ordinary work", projectManifestDigest: "sha256:named-only", projectManifest: { anything: true } },
        tasks: [{ key: "impl", title: "impl", category: "implementation" }],
      });
      expect(submitted).toMatchObject({ ok: true });
      expect(f.harness.cp.artifacts.latest(runId, "PLAN")?.content).toEqual({
        summary: "ordinary work",
        dependencies: [],
        repositoryIntent: [],
        verificationIntent: [],
        knownConflicts: [],
        risks: [],
        removedOverengineering: [],
        projectManifestDigest: "sha256:named-only",
      });
    });
  });
});

describe("#246 C2: the candidate snapshot names its bootstrap plan", () => {
  // Computed with `candidateSnapshotDigest` at c315463e, before `bootstrapPlan` existed.
  const GOLDEN = {
    withRepository: "sha256:3c56cbbd905484b442ecc8f96cbf8411ed0fbdf691b958b94825e8101fd0ee47",
    preLineage: "sha256:01ea6781ef2c53eacd3972088d53c80729e70d694b44ddc1d71755d7939833dd",
    noRepositories: "sha256:31cb201a618b58959b41b529634f4e2ad9636234beb360390934127f2722741f",
  };
  const repository = {
    identity: "github:acme/golden",
    repositoryRole: "primary",
    baseBranch: "dev",
    baseHead: "1".repeat(40),
    sourceBranch: "dev",
    sourceHead: "2".repeat(40),
    candidateHead: "3".repeat(40),
    treeDigest: `git-tree:${"4".repeat(40)}`,
    diffDigest: `sha256:${"5".repeat(64)}`,
    worktreeId: null,
    manifestDigest: `sha256:${"6".repeat(64)}`,
    touchedPaths: ["src/app.js", "README.md"],
  };
  const golden: CandidateSnapshot = {
    schema: CANDIDATE_SNAPSHOT_SCHEMA_ID,
    runId: "run_golden",
    contractDigest: `sha256:${"7".repeat(64)}`,
    repositories: [repository],
    createdAt: "2026-10-09T00:00:00.000Z",
  };

  it("non-bootstrap snapshot digests are byte-identical to c315463e's (golden)", () => {
    const { sourceBranch: _branch, sourceHead: _head, ...preLineage } = repository;
    void _branch;
    void _head;
    expect(candidateSnapshotDigest(golden)).toBe(GOLDEN.withRepository);
    expect(candidateSnapshotDigest({ ...golden, repositories: [preLineage] })).toBe(GOLDEN.preLineage);
    expect(candidateSnapshotDigest({ ...golden, repositories: [] })).toBe(GOLDEN.noRepositories);
    const administrative = buildNoRepositoryCandidateSnapshot(
      { runId: golden.runId, contractDigest: golden.contractDigest },
      { nowIso: () => "2026-10-09T01:00:00.000Z" } as Parameters<typeof buildNoRepositoryCandidateSnapshot>[1],
    );
    expect(Object.keys(administrative)).not.toContain("bootstrapPlan");
    expect(candidateSnapshotDigest(administrative)).toBe(GOLDEN.noRepositories);
  });

  it("a re-plan with a different manifest freezes a different candidate digest", async () => {
    await withFixture(async (f) => {
      const run = await dispatchedBootstrap(f);
      const s1 = await reviewedPlan(f, run, cleanTreeManifest("c2-snapshot-first"), "plan-1");
      await reviseAndRedispatch(f, run, s1);
      const s2 = await reviewedPlan(f, run, cleanTreeManifest("c2-snapshot-second"), "plan-2");
      expect(s2).not.toBe(s1);
      // The first candidate's artifact is superseded by the second's promotion, and still on record.
      const frozen = (digest: string) =>
        f.harness.cp.artifacts
          .list<CandidateSnapshot>(run.runId, "CANDIDATE_SNAPSHOT")
          .find((artifact) => artifact.candidateSnapshotDigest === digest)?.content;
      const first = frozen(s1);
      const second = frozen(s2);
      expect(first?.repositories).toEqual([]);
      expect(second?.repositories).toEqual([]);
      expect(first?.bootstrapPlan?.projectManifestDigest).toBe(manifestDigest(cleanTreeManifest("c2-snapshot-first")));
      expect(second?.bootstrapPlan?.projectManifestDigest).toBe(manifestDigest(cleanTreeManifest("c2-snapshot-second")));
      expect(second?.bootstrapPlan?.planDigest).toBe(f.harness.cp.artifacts.latest(run.runId, "PLAN")?.digest);
    });
  });
});

describe("#246 C2: the BOOTSTRAP_PLAN review reads only what the PLAN artifact says", () => {
  it("reviews the planned outputs reloaded from the PLAN artifact; a request supplying other outputs, or a candidate the PLAN no longer names, changes nothing", async () => {
    await withFixture(async (f) => {
      const run = await dispatchedBootstrap(f);
      const manifest = cleanTreeManifest("c2-trusted-inputs");
      const s1 = await reviewedPlan(f, run, manifest, "plan-1");
      const current = currentBootstrapPlan(run.runId, f.harness.cp.artifacts.latest(run.runId, "PLAN"));
      if (!current.allowed) throw new Error(current.message);
      const trusted = current.value;

      // The pipeline's own review saw the outputs the PLAN plans, byte for byte.
      const reviewPrompts = () =>
        f.harness.scripted.invocations.filter((invocation) => invocation.prompt.startsWith("# Bootstrap plan review"));
      const seen = reviewPrompts().at(-1)?.prompt ?? "";
      expect(seen).toContain(JSON.stringify(trusted.outputs, null, 2));
      expect(seen).toContain(trusted.binding.plannedOutputsDigest);
      const packet = f.harness.cp.artifacts.latestForSnapshot<{ bootstrapPlan?: unknown; verdict: string }>(run.runId, "BLIND_REVIEW", s1);
      expect(packet?.content).toMatchObject({ verdict: "PASS", bootstrapPlan: trusted.binding });
      expect(packet?.producedBy).toBe("blind-review-gate");

      // The same control-plane door, handed other outputs and another manifest: neither is read.
      const snapshot = f.harness.cp.artifacts.latestForSnapshot<CandidateSnapshot>(run.runId, "CANDIDATE_SNAPSHOT", s1)!.content;
      const runRow = f.harness.cp.runs.require(run.runId);
      const invoke = f.harness.cp.review.controlPlaneInvoker();
      const tampered = {
        ...trusted.outputs,
        files: [{ path: "TAMPERED.md", mode: "100644", content: "TAMPERED-OUTPUT\n" }],
        githubOperations: [],
      };
      f.harness.scripted.script({ match: /Bootstrap plan review/, text: reviewerPass(bootstrapCoverageKeys(f.harness, run.runId)) });
      const reviewed = await invoke({
        kind: "BOOTSTRAP_PLAN",
        runId: run.runId,
        snapshot,
        contract: CONTRACT,
        contractDigest: runRow.contractDigest,
        plannedOutputs: tampered,
        manifest: cleanTreeManifest("TAMPERED-MANIFEST"),
      });
      expect(reviewed).toMatchObject({ allowed: true, value: { verdict: "PASS", bootstrapPlan: trusted.binding } });
      const tamperedPrompt = reviewPrompts().at(-1)?.prompt ?? "";
      expect(tamperedPrompt).toContain(JSON.stringify(trusted.outputs, null, 2));
      expect(tamperedPrompt).not.toContain("TAMPERED");

      // A candidate that names other outputs is not the run's candidate, and is refused unread.
      const forged: CandidateSnapshot = {
        ...snapshot,
        bootstrapPlan: { ...trusted.binding, plannedOutputsDigest: digestOf(tampered) },
      };
      const before = reviewPrompts().length;
      expect(await invoke({ kind: "BOOTSTRAP_PLAN", runId: run.runId, snapshot: forged, contract: CONTRACT, contractDigest: runRow.contractDigest }))
        .toMatchObject({ allowed: false, reasonCode: ReasonCode.EVIDENCE_STALE });

      // After a re-plan the run's candidate still names P1, and its PLAN is P2: the candidate is refused.
      await reviseAndRedispatch(f, run, s1);
      expect(await submitPlan(f, run, bootstrapPlan(cleanTreeManifest("c2-trusted-inputs-second")), "plan-2")).toMatchObject({ ok: true });
      expect(f.harness.cp.runs.currentCandidate(run.runId)).toBe(s1);
      expect(await invoke({ kind: "BOOTSTRAP_PLAN", runId: run.runId, snapshot, contract: CONTRACT, contractDigest: runRow.contractDigest }))
        .toMatchObject({ allowed: false, reasonCode: ReasonCode.EVIDENCE_STALE });
      expect(reviewPrompts()).toHaveLength(before);
    });
  });
});

/**
 * The drift check, on the producer's own path: a real git, with a pre-commit hook found through the
 * user's git configuration — the place an unreviewed change can enter a produced commit without the
 * producer writing it. Each hook leaves a commit whose tree is not the approved files.
 */
describe("#246 C2: the produced tree must be the approved outputs exactly", () => {
  const roots: string[] = [];
  const realHome = process.env["HOME"];
  afterEach(async () => {
    process.env["HOME"] = realHome;
    while (roots.length > 0) {
      const dir = roots.pop();
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  });

  const localPlan = (runId: string): RepoFactoryPlanFixture => ({
    runId,
    bootstrapOperationId: `op-${runId}`,
    requestDigest: digestOf({ request: runId }),
    planDigest: digestOf({ plan: runId }),
    projectManifestDigest: digestOf({ manifest: runId }),
    repositoryRole: "primary",
    defaultBranch: "main",
    verificationCommandId: "clean-tree",
    verificationKind: "CLEAN_TREE",
    githubOperations: [],
  });

  /** A HOME whose git configuration runs `hook` before every commit. Null installs no hook. */
  const homeWithHook = (hook: string | null): void => {
    const home = mkdtempSync(join(tmpdir(), "acp-c2-home-"));
    roots.push(home);
    if (hook !== null) {
      const hooks = join(home, "hooks");
      mkdirSync(hooks);
      writeFileSync(join(hooks, "pre-commit"), `#!/bin/sh\nset -e\n${hook}\n`);
      chmodSync(join(hooks, "pre-commit"), 0o755);
      writeFileSync(join(home, ".gitconfig"), `[core]\n\thooksPath = ${hooks}\n`);
    }
    process.env["HOME"] = home;
  };

  const produce = (runId: string, approvedFiles = plannedBootstrapFiles(localPlan(runId))) => {
    const workDir = join(mkdtempSync(join(tmpdir(), "acp-c2-produce-")), "work");
    roots.push(join(workDir, ".."));
    return produceRepoFactoryResult({ plan: localPlan(runId), workDir, approvedFiles });
  };

  it("a tree that is exactly the approved files is produced", async () => {
    homeWithHook(null);
    expect(await produce("run_c2_exact")).toMatchObject({ allowed: true });
  });

  it("one byte more in an approved file is refused BOOTSTRAP_CONTRACT_DRIFT", async () => {
    homeWithHook("printf 'x' >> .repo-factory-bootstrap.json\ngit add .repo-factory-bootstrap.json");
    const produced = await produce("run_c2_byte");
    expect(produced).toMatchObject({
      allowed: false,
      reasonCode: ReasonCode.BOOTSTRAP_CONTRACT_DRIFT,
      evidence: { missing: [], extra: [], changed: [expect.objectContaining({ path: ".repo-factory-bootstrap.json" })] },
    });
  });

  it("one file more than the approved files is refused BOOTSTRAP_CONTRACT_DRIFT", async () => {
    homeWithHook("printf 'extra\\n' > EXTRA.md\ngit add EXTRA.md");
    expect(await produce("run_c2_extra")).toMatchObject({
      allowed: false,
      reasonCode: ReasonCode.BOOTSTRAP_CONTRACT_DRIFT,
      evidence: { missing: [], extra: ["EXTRA.md"], changed: [] },
    });
  });

  it("one approved file missing from the tree is refused BOOTSTRAP_CONTRACT_DRIFT", async () => {
    homeWithHook("git rm -q --cached --ignore-unmatch SECOND.md");
    const approved = [
      ...plannedBootstrapFiles(localPlan("run_c2_missing")),
      { path: "SECOND.md", mode: "100644" as const, content: "second\n" },
    ];
    expect(await produce("run_c2_missing", approved)).toMatchObject({
      allowed: false,
      reasonCode: ReasonCode.BOOTSTRAP_CONTRACT_DRIFT,
      evidence: { missing: ["SECOND.md"], extra: [], changed: [] },
    });
  });
});
