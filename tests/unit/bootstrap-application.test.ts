import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { createOperatorClient, dispatch } from "../../src/cli/agentctl.ts";
import { bootstrapActivationHandoff, plannedBootstrapOutputs } from "../../src/bootstrap/bootstrap-plan.ts";
import {
  REPO_FACTORY_GITHUB_WRITE_APPROVAL_KIND,
  type RepoFactoryOwnerApproval,
  repoFactoryGitHubWriteParameters,
} from "../../src/bootstrap/repo-factory-bootstrap-run.ts";
import { repositoryCheckoutPath } from "../../src/bootstrap/repo-factory-producer.ts";
import { digestOf } from "../../src/core/digest.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { type ProjectManifest, manifestDigest } from "../../src/contracts/manifest.ts";
import { startLocalMcpListeners, startOperatorSocket, startSessionLaunchChannel } from "../../src/daemon/agentcpd.ts";
import { Daemon } from "../../src/daemon/daemon.ts";
import { ArtifactKind, ExecutionMode, Role, RunKind, RunState, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import type { TaskContract } from "../../src/run/run-engine.ts";
import type { CapacityReading } from "../../src/runtime/provider.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { FakeGitHub } from "../helpers/fake-github-write-port.ts";
import { HeadlessRuntimeDouble } from "../helpers/headless-runtime.ts";
import {
  TEST_MCP_TOKEN,
  TEST_OPERATOR_TOKEN,
  TEST_OWNER,
  makeHarness,
  registerFixtureProject,
  reviewerPass,
  type Harness,
} from "../helpers/harness.ts";
import { BOOTSTRAP_IDENTITY, bootstrapCoverageKeys, bootstrapPlan, cleanTreeManifest } from "../helpers/bootstrap-plan.ts";
import { callMcpToolOverSocket, claimLaunchedCredential } from "../helpers/mcp-socket.ts";

afterAll(cleanupTempDirs);
afterEach(() => vi.restoreAllMocks());

/**
 * Issue #246 PR-C slice C3 — the durable application of a project-less PROJECT_BOOTSTRAP run's
 * CONFIRM, witnessed through the real doors.
 *
 * run_create, run_dispatch and ceo_decision_submit go over `hermes.mcp.sock` as the CEO; plan_submit,
 * task_worker_provision, task_receipt_submit, result_submit and the primary CTO's handoff_ack over
 * `cto.mcp.sock`, each with the credential its runtime took from the launch channel; the owner's
 * approval of the GitHub writes over the operator socket with agentctl and the owner token. GitHub is
 * the bare-repository double, which counts every write; the Claude runtime is a scripted double.
 * Continuity is evaluated before each CEO decision, as the daemon does on its own schedule. No run
 * state, binding or evidence is written by the test.
 */
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

const WRITE_METHODS = ["createRepository", "pushBranch", "setDefaultBranch", "protectBranch"];

const claudeReading = (harness: Harness, remainingPercent: number, minutesAgo = 0): CapacityReading => {
  const now = harness.clock.now().getTime();
  return {
    provider: "claude",
    sensorHealth: "HEALTHY",
    runtimeHealth: "HEALTHY",
    observedAt: new Date(now - minutesAgo * 60_000).toISOString(),
    source: "bootstrap-application-fixture",
    buckets: [{
      id: "five_hour",
      remainingPercent,
      resetAt: new Date(now + 2 * 60 * 60_000).toISOString(),
      capabilities: ["ceo", "cto", "blind-review", "worker"],
    }],
  };
};

const applicationFixture = async () => {
  const github = new FakeGitHub(tempDir("acp-c3-github-"));
  const workRoot = join(tempDir("acp-c3-work-"), "repo-factory");
  const harness = makeHarness({ repoFactory: { workRoot, githubPort: github } });
  harness.cp.credentials.install({ token: "test-token", creatorIdentity: "acme-bot" });

  const launch = await startSessionLaunchChannel(tempDir("acp-c3-launch-"), { mcpToken: TEST_MCP_TOKEN });
  harness.cp.cto.attach({ sessionLaunch: launch });
  const claude = new HeadlessRuntimeDouble(harness.clock, "claude");
  harness.cp.providers.registerForRole(claude, Role.BOOTSTRAP_CTO);
  harness.cp.providers.registerForRole(claude, Role.WORKER);
  claude.setCapacity(claudeReading(harness, 81, 3));
  await harness.cp.capacity.refreshForRole("claude", Role.WORKER);
  claude.setCapacity(claudeReading(harness, 80));

  const ceo = harness.cp.sessions.create({ provider: "scripted", model: "c3-ceo" });
  const ceoSecret = ceo.sessionSecret;
  if (!ceoSecret) throw new Error("the CEO session has no secret");
  harness.cp.sessions.transition(ceo.sessionId, SessionLifecycle.READY, "fixture CEO");
  const boundCeo = harness.cp.bindings.bind({ role: Role.CEO, sessionId: ceo.sessionId });
  if (!boundCeo.allowed) throw new Error(boundCeo.message);

  const listeners = await startLocalMcpListeners(harness.cp, tempDir("acp-c3-mcp-"), TEST_MCP_TOKEN);
  const [hermesSocket, ctoSocket] = listeners.socketPaths;
  if (!hermesSocket || !ctoSocket) throw new Error("the MCP listeners were not started");
  harness.cp.sessionRuntime.attach({
    delivery: launch,
    route: { launchSocketPath: launch.socketPath, mcpSocketPath: ctoSocket },
  });

  const daemon = new Daemon(harness.cp, { stateDir: tempDir("acp-c3-daemon-") });
  const started = await daemon.start();
  if (!started.allowed) throw new Error(`${started.reasonCode}: ${started.message}`);
  const operator = await startOperatorSocket(
    daemon,
    tempDir("acp-c3-operator-"),
    { token: TEST_OPERATOR_TOKEN, peerId: `cli:${TEST_OWNER.actor}`, actor: TEST_OWNER.actor },
    { mcpToken: TEST_MCP_TOKEN },
  );

  let keys = 0;
  const hermes = (name: string, args: Record<string, unknown>) =>
    callMcpToolOverSocket(hermesSocket, { token: TEST_MCP_TOKEN, sessionId: ceo.sessionId, sessionSecret: ceoSecret }, name, {
      idempotencyKey: `c3-${++keys}`,
      ...args,
    });
  const claimed = new Map<string, { sessionId: string; sessionSecret: string }>();
  /** A CTO session acts with the credential its runtime took, or claims it from the launch channel. */
  const cto = async (sessionId: string, name: string, args: Record<string, unknown>) => {
    let credential: { sessionId: string; sessionSecret: string } | undefined = claude.credentials.get(sessionId) ?? claimed.get(sessionId);
    if (!credential) {
      const session = harness.cp.sessions.require(sessionId);
      credential = await claimLaunchedCredential(launch.socketPath, session.incarnation.split("#", 1)[0]!);
      claimed.set(sessionId, credential);
    }
    return callMcpToolOverSocket(ctoSocket, { token: TEST_MCP_TOKEN, ...credential }, name, {
      idempotencyKey: `c3-${++keys}`,
      ...args,
    });
  };
  return {
    harness,
    github,
    workRoot,
    ceoSessionId: ceo.sessionId,
    hermes,
    cto,
    operatorSocket: operator.socketPath,
    close: async () => {
      await operator.close();
      await daemon.stop();
      await listeners.close();
      await launch.close();
    },
  };
};

type Fixture = Awaited<ReturnType<typeof applicationFixture>>;

const withFixture = async (body: (f: Fixture) => Promise<void>): Promise<void> => {
  const f = await applicationFixture();
  try {
    await body(f);
  } finally {
    await f.close();
  }
};

interface ReviewedRun {
  runId: string;
  owner: string;
  candidate: string;
  planDigest: string;
  manifest: ProjectManifest;
}

/**
 * run_create (no project) and run_dispatch over the Hermes socket; plan_submit with the manifest,
 * the PLAN's task worked by its own Claude worker, and result_submit over the CTO socket, where the
 * BOOTSTRAP_PLAN review passes. The run is at CEO review on the candidate that review passed.
 */
const reviewedBootstrap = async (f: Fixture, manifest: ProjectManifest, taskKey = "bootstrap"): Promise<ReviewedRun> => {
  const created = await f.hermes("run_create", {
    kind: RunKind.PROJECT_BOOTSTRAP,
    executionMode: ExecutionMode.STANDARD,
    contract: CONTRACT,
  });
  if (created["ok"] !== true) throw new Error(`run_create refused: ${JSON.stringify(created)}`);
  const runId = (created["value"] as { runId: string }).runId;
  const dispatched = await f.hermes("run_dispatch", { runId });
  if (dispatched["ok"] !== true) throw new Error(`run_dispatch refused: ${JSON.stringify(dispatched)}`);
  const owner = f.harness.cp.runs.require(runId).ownerSessionId!;
  const planned = await f.cto(owner, "plan_submit", {
    runId,
    plan: bootstrapPlan(manifest),
    tasks: [{ key: taskKey, title: taskKey, category: "implementation" }],
  });
  expect(planned, JSON.stringify(planned)).toMatchObject({ ok: true });
  for (const task of f.harness.cp.tasks.ready(runId)) {
    const provisioned = await f.cto(owner, "task_worker_provision", { runId, taskId: task.taskId, provider: "claude" });
    expect(provisioned, JSON.stringify(provisioned)).toMatchObject({ ok: true });
    const workerSessionId = (provisioned["value"] as { workerSessionId: string }).workerSessionId;
    const startedTask = await f.cto(owner, "task_receipt_submit", { runId, taskId: task.taskId, phase: "started", workerSessionId });
    expect(startedTask, JSON.stringify(startedTask)).toMatchObject({ ok: true });
    const finished = await f.cto(owner, "task_receipt_submit", {
      runId,
      taskId: task.taskId,
      phase: "finished",
      executionId: (startedTask["value"] as { executionId: string }).executionId,
      workerSessionId,
      status: "SUCCEEDED",
      resultDigest: digestOf({ task: task.taskId }),
    });
    expect(finished, JSON.stringify(finished)).toMatchObject({ ok: true });
  }
  await f.harness.cp.continuity.evaluate("before result_submit");
  f.harness.scripted.script({ match: /Bootstrap plan review/, text: reviewerPass(bootstrapCoverageKeys(f.harness, runId)) });
  const submitted = await f.cto(owner, "result_submit", {
    runId,
    resultSummary: "the planned bootstrap outputs",
    recommendation: "create the repository",
  });
  expect(submitted, JSON.stringify(submitted)).toMatchObject({ ok: true, value: { stage: "COMPLETED_REVIEW" } });
  expect(f.harness.cp.runs.require(runId).state).toBe(RunState.READY_FOR_CEO_REVIEW);
  const plan = f.harness.cp.artifacts.latest(runId, "PLAN");
  if (plan === null) throw new Error("plan_submit stored no PLAN");
  return {
    runId,
    owner,
    candidate: (submitted["value"] as { snapshotDigest: string }).snapshotDigest,
    planDigest: plan.digest,
    manifest,
  };
};

/**
 * The owner's approval of the GitHub writes: agentctl over the operator socket, with the owner token.
 * By default the approval the plan needs; `githubOwner`, `visibility` and `decline` make it another
 * owner decision, still minted the official way.
 */
const approveWrites = async (
  f: Fixture,
  run: ReviewedRun,
  options: { githubOwner?: string; visibility?: string; decline?: boolean } = {},
): Promise<void> => {
  const manifestPath = join(tempDir("acp-c3-manifest-"), "project.json");
  writeFileSync(manifestPath, JSON.stringify(run.manifest));
  const client = createOperatorClient({ socketPath: f.operatorSocket, token: TEST_OPERATOR_TOKEN });
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    const exit = await dispatch(client, "approve", [
      "repo-factory-github-write",
      run.runId,
      "--github-owner",
      options.githubOwner ?? "acme",
      "--visibility",
      options.visibility ?? "public",
      "--plan-digest",
      run.planDigest,
      "--manifest",
      manifestPath,
      "--project-name",
      "fixture project",
      ...(options.decline ? ["--decline"] : []),
    ], false);
    expect(exit).toBe(0);
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
};

/** The CEO's CONFIRM over the Hermes socket, continuity reconciled first. */
const confirm = async (f: Fixture, run: ReviewedRun): Promise<Record<string, unknown>> => {
  await f.harness.cp.continuity.evaluate("bootstrap confirmation");
  return f.hermes("ceo_decision_submit", {
    runId: run.runId,
    decision: "CONFIRM",
    candidateSnapshotDigest: run.candidate,
    ceoSessionId: f.ceoSessionId,
    rationale: "apply the bootstrap",
  });
};

const writesOf = (f: Fixture, method?: string): string[] =>
  f.github.writes.map((write) => write.method).filter((name) => method === undefined || name === method);

const consumedApprovals = (f: Fixture, runId: string): number =>
  f.harness.cp.db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'OWNER_APPROVAL_CONSUMED' AND run_id = ?`,
    [runId],
  )?.n ?? 0;

const applicationOf = (f: Fixture, runId: string) => f.harness.cp.bootstrapApplications.get(runId);

/** The primary CTO acknowledges its activation handoff over the CTO socket, as itself. */
const acknowledgeHandoff = async (f: Fixture, run: ReviewedRun, refused: Record<string, unknown>): Promise<void> => {
  const handoffId = (refused["evidence"] as Record<string, unknown>)["pendingHandoffId"] as string;
  const primary = f.harness.cp.bindings.activePrimaryCto(run.manifest.projectId);
  if (!primary) throw new Error("activation bound no primary CTO");
  const delivered = f.harness.cp.outbox.listByRun(run.runId).find((message) => message.kind === "HANDOFF_PACKAGE");
  if (!delivered) throw new Error("the activation handoff was not delivered");
  const acked = await f.cto(primary.sessionId, "handoff_ack", {
    handoffId,
    messageId: delivered.messageId,
    payloadDigest: delivered.payloadDigest,
    bindingGeneration: primary.bindingGeneration,
  });
  expect(acked, JSON.stringify(acked)).toMatchObject({ ok: true });
};

/** Nothing written to GitHub, the approval not consumed, no application recorded. */
const nothingApplied = (f: Fixture, run: ReviewedRun): void => {
  expect(writesOf(f)).toEqual([]);
  expect(consumedApprovals(f, run.runId)).toBe(0);
  expect(applicationOf(f, run.runId)).toBeNull();
  expect(f.harness.cp.runs.require(run.runId).state).toBe(RunState.READY_FOR_CEO_REVIEW);
};

describe("#246 C3 W2: a failure after the repository was created", () => {
  it("the primary CTO's provider is down at the first CONFIRM: WRITTEN; once it is back, a re-CONFIRM completes with one createRepository", async () => {
    await withFixture(async (f) => {
      const run = await reviewedBootstrap(f, cleanTreeManifest("c3-w2-provider"));
      await approveWrites(f, run);
      // The primary CTO activation provisions answers its readiness probe UNAVAILABLE.
      f.harness.scripted.setNextSessionHealth("UNAVAILABLE");
      const first = await confirm(f, run);
      expect(first, JSON.stringify(first)).toMatchObject({ ok: false, evidence: { stage: "activation" } });
      expect(writesOf(f)).toEqual(WRITE_METHODS);
      expect(applicationOf(f, run.runId)).toMatchObject({ phase: "WRITTEN", attempts: 1 });
      expect(f.harness.cp.bindings.activePrimaryCto(run.manifest.projectId)).toBeNull();

      // The provider is back. The re-CONFIRM activates the stored result: no GitHub write at all.
      const second = await confirm(f, run);
      expect(second, JSON.stringify(second)).toMatchObject({ ok: false, reasonCode: ReasonCode.BOOTSTRAP_ACTIVATION_INCOMPLETE });
      expect(writesOf(f)).toEqual(WRITE_METHODS);
      await acknowledgeHandoff(f, run, second);

      const third = await confirm(f, run);
      expect(third, JSON.stringify(third)).toMatchObject({ ok: true, value: { state: RunState.COMPLETED } });
      expect(writesOf(f, "createRepository")).toHaveLength(1);
      expect(writesOf(f)).toEqual(WRITE_METHODS);
      expect(applicationOf(f, run.runId)).toMatchObject({ phase: "COMPLETED", attempts: 1 });
      expect(consumedApprovals(f, run.runId)).toBe(1);
      expect(f.harness.cp.runs.require(run.runId).state).toBe(RunState.COMPLETED);
      // C1's reclaim: the run's BOOTSTRAP_CTO is revoked with COMPLETED, and the daemon's sweep stops it.
      expect(f.harness.cp.bindings.active(roleKeyFor(Role.BOOTSTRAP_CTO, { runId: run.runId }))).toBeNull();
      await f.harness.cp.bootstrapCtos.reclaim();
      expect(f.harness.cp.sessions.require(run.owner).lifecycle).toBe(SessionLifecycle.STOPPED);
    });
  });

  it("a timeout between createRepository and WRITTEN: the recovery attributes the repository by the node id in the attempt ledger, still one create", async () => {
    await withFixture(async (f) => {
      const run = await reviewedBootstrap(f, cleanTreeManifest("c3-w2-timeout"));
      await approveWrites(f, run);
      // GitHub creates the repository and answers; the read after it times out.
      f.github.failAfter = { method: "createRepository", mode: "readback" };
      const first = await confirm(f, run);
      expect(first, JSON.stringify(first)).toMatchObject({ ok: false, evidence: { stage: "production", refusal: "REMOTE_REFUSED" } });
      expect(writesOf(f)).toEqual(["createRepository"]);
      expect(applicationOf(f, run.runId)).toMatchObject({ phase: "RESERVED", attempts: 1 });

      const recovered = await confirm(f, run);
      expect(recovered, JSON.stringify(recovered)).toMatchObject({ ok: false, reasonCode: ReasonCode.BOOTSTRAP_ACTIVATION_INCOMPLETE });
      expect(writesOf(f, "createRepository")).toHaveLength(1);
      expect(writesOf(f)).toEqual(WRITE_METHODS);
      expect(applicationOf(f, run.runId)).toMatchObject({ phase: "WRITTEN", attempts: 2 });
      expect(consumedApprovals(f, run.runId)).toBe(1);
    });
  });

  it("a crash after the writes and before WRITTEN: the recovery attributes the repository by its creation receipt, still one create", async () => {
    await withFixture(async (f) => {
      const run = await reviewedBootstrap(f, cleanTreeManifest("c3-w2-crash"));
      await approveWrites(f, run);
      // Every GitHub write lands; the transaction that would store the result and WRITTEN dies.
      const written = vi.spyOn(f.harness.cp.bootstrapApplications, "markWritten").mockImplementationOnce(() => {
        throw new Error("the daemon died before WRITTEN was stored");
      });
      const crashed = await confirm(f, run);
      expect(crashed["ok"]).toBe(false);
      written.mockRestore();
      expect(writesOf(f)).toEqual(WRITE_METHODS);
      expect(applicationOf(f, run.runId)).toMatchObject({ phase: "RESERVED", attempts: 1 });
      expect(f.harness.cp.artifacts.latest(run.runId, "REPO_FACTORY_RESULT")).toBeNull();

      const recovered = await confirm(f, run);
      expect(recovered, JSON.stringify(recovered)).toMatchObject({ ok: false, reasonCode: ReasonCode.BOOTSTRAP_ACTIVATION_INCOMPLETE });
      // Nothing was written again: every operation resumed from its receipt in the ledger.
      expect(writesOf(f)).toEqual(WRITE_METHODS);
      expect(applicationOf(f, run.runId)).toMatchObject({ phase: "WRITTEN", attempts: 2 });
    });
  });

  it("attribution uncertain — a create whose answer was lost — is STRANDED with no create, keeps its reservation, and the doctor names it", async () => {
    await withFixture(async (f) => {
      const run = await reviewedBootstrap(f, cleanTreeManifest("c3-w2-stranded"));
      await approveWrites(f, run);
      // GitHub creates the repository and the answer is lost: the ledger holds no node id for it.
      f.github.failAfter = { method: "createRepository", mode: "response" };
      const first = await confirm(f, run);
      expect(first, JSON.stringify(first)).toMatchObject({ ok: false, evidence: { stage: "production", refusal: "REMOTE_REFUSED" } });
      expect(writesOf(f)).toEqual(["createRepository"]);

      const stranded = await confirm(f, run);
      expect(stranded, JSON.stringify(stranded)).toMatchObject({
        ok: false,
        reasonCode: ReasonCode.BOOTSTRAP_APPLICATION_STRANDED,
        evidence: { cause: "ATTRIBUTION_UNCERTAIN" },
      });
      // No create, no adoption: the one repository at the name is the lost create's or another's.
      expect(writesOf(f)).toEqual(["createRepository"]);
      const application = applicationOf(f, run.runId);
      // Stranded by the pre-write check, before a second attempt was recorded: nothing was attempted.
      expect(application).toMatchObject({ phase: "STRANDED", attempts: 1, projectId: "c3-w2-stranded", repositoryIdentity: BOOTSTRAP_IDENTITY });
      expect(application?.lastRefusal).toMatchObject({
        cause: "ATTRIBUTION_UNCERTAIN",
        evidence: { recordedNodeId: null, createSent: true },
      });

      // Nothing retries it: another CONFIRM writes nothing, does not even look at GitHub, and changes nothing.
      const readsBefore = f.github.reads.length;
      const again = await confirm(f, run);
      expect(again).toMatchObject({ ok: false, reasonCode: ReasonCode.BOOTSTRAP_APPLICATION_STRANDED });
      expect(writesOf(f)).toEqual(["createRepository"]);
      expect(f.github.reads).toHaveLength(readsBefore);
      expect(applicationOf(f, run.runId)).toEqual(application);

      // The doctor states the cause and the recovery a person performs.
      const report = await f.harness.cp.doctor.run("run", run.runId);
      const finding = report.findings.find((candidate) => candidate.code === "BOOTSTRAP_APPLICATION_STRANDED");
      expect(finding).toMatchObject({
        scope: `run:${run.runId}`,
        observedEvidence: { cause: "ATTRIBUTION_UNCERTAIN", projectId: "c3-w2-stranded", repositoryIdentity: BOOTSTRAP_IDENTITY },
      });
      expect(finding?.recommendedAction).toMatch(/node id.*attempt ledger.*never reused/);

      // The reservation is never reused: the registries refuse its project id and identity.
      const project = await registerFixtureProject(f.harness, "c3-w2-stranded").catch((error: Error) => error);
      expect(String(project)).toMatch(/reserved by another bootstrap run/);
      const repository = await registerFixtureProject(f.harness, "c3-w2-elsewhere", {}, { identity: BOOTSTRAP_IDENTITY })
        .catch((error: Error) => error);
      expect(String(repository)).toMatch(/reserved by a bootstrap run/);
    });
  });

  it("two concurrent re-CONFIRMs have one effect", async () => {
    await withFixture(async (f) => {
      const run = await reviewedBootstrap(f, cleanTreeManifest("c3-w2-concurrent"));
      await approveWrites(f, run);
      f.github.failAfter = { method: "createRepository", mode: "readback" };
      await confirm(f, run);
      expect(writesOf(f)).toEqual(["createRepository"]);

      await f.harness.cp.continuity.evaluate("bootstrap confirmation");
      const decide = () => f.hermes("ceo_decision_submit", {
        runId: run.runId,
        decision: "CONFIRM",
        candidateSnapshotDigest: run.candidate,
        ceoSessionId: f.ceoSessionId,
        rationale: "apply the bootstrap",
      });
      const answers = await Promise.all([decide(), decide()]);
      const reasons = answers.map((answer) => answer["reasonCode"]).sort();
      expect(reasons, JSON.stringify(answers)).toEqual(
        [ReasonCode.BOOTSTRAP_ACTIVATION_INCOMPLETE, ReasonCode.BOOTSTRAP_APPLICATION_IN_PROGRESS].sort(),
      );
      expect(writesOf(f)).toEqual(WRITE_METHODS);
      expect(applicationOf(f, run.runId)).toMatchObject({ phase: "WRITTEN", attempts: 2 });
      expect(consumedApprovals(f, run.runId)).toBe(1);
    });
  });
});

describe("#246 C3 W3: a collision is refused before any write", () => {
  it("the project exists: PROJECT_EXISTS, zero writes, the approval unconsumed, no application", async () => {
    await withFixture(async (f) => {
      const run = await reviewedBootstrap(f, cleanTreeManifest("c3-w3-project"));
      await approveWrites(f, run);
      await registerFixtureProject(f.harness, "c3-w3-project", {}, { identity: "github:acme/someone-else" });
      const refused = await confirm(f, run);
      expect(refused, JSON.stringify(refused)).toMatchObject({ ok: false, reasonCode: ReasonCode.PROJECT_EXISTS });
      nothingApplied(f, run);
    });
  });

  it("the repository identity is already bound: IDENTITY_COLLISION, zero writes, the approval unconsumed, no application", async () => {
    await withFixture(async (f) => {
      const run = await reviewedBootstrap(f, cleanTreeManifest("c3-w3-identity"));
      await approveWrites(f, run);
      await registerFixtureProject(f.harness, "c3-w3-other-project", {}, { identity: BOOTSTRAP_IDENTITY });
      const refused = await confirm(f, run);
      expect(refused, JSON.stringify(refused)).toMatchObject({ ok: false, reasonCode: ReasonCode.IDENTITY_COLLISION });
      nothingApplied(f, run);
    });
  });

  it("GitHub has the name and this run has no receipt for it: RESOURCE_COLLISION, zero writes, the approval unconsumed, no application", async () => {
    await withFixture(async (f) => {
      const run = await reviewedBootstrap(f, cleanTreeManifest("c3-w3-github"));
      await approveWrites(f, run);
      await f.github.seedForeign("acme", "fixture");
      const refused = await confirm(f, run);
      expect(refused, JSON.stringify(refused)).toMatchObject({
        ok: false,
        reasonCode: ReasonCode.RESOURCE_COLLISION,
        evidence: { stage: "precondition", refusal: "RESOURCE_COLLISION", recordedNodeId: null },
      });
      nothingApplied(f, run);
    });
  });

  it("another run reserved it: BOOTSTRAP_APPLICATION_RESERVED, zero writes, the approval unconsumed, no application", async () => {
    await withFixture(async (f) => {
      const first = await reviewedBootstrap(f, cleanTreeManifest("c3-w3-reserved"), "first");
      await approveWrites(f, first);
      // The first run's CONFIRM reserves, then GitHub refuses its create before anything changes.
      f.github.failNext = "createRepository";
      const attempted = await confirm(f, first);
      expect(attempted).toMatchObject({ ok: false, evidence: { stage: "production" } });
      expect(applicationOf(f, first.runId)).toMatchObject({ phase: "RESERVED", attempts: 1 });
      f.github.writes.length = 0;

      const second = await reviewedBootstrap(f, cleanTreeManifest("c3-w3-reserved"), "second");
      await approveWrites(f, second);
      const refused = await confirm(f, second);
      expect(refused, JSON.stringify(refused)).toMatchObject({
        ok: false,
        reasonCode: ReasonCode.BOOTSTRAP_APPLICATION_RESERVED,
        evidence: { heldBy: [{ runId: first.runId, phase: "RESERVED" }] },
      });
      nothingApplied(f, second);
    });
  });

  it("the checkout leaf is occupied: refused, zero writes, the approval unconsumed, no application", async () => {
    await withFixture(async (f) => {
      const run = await reviewedBootstrap(f, cleanTreeManifest("c3-w3-leaf"));
      await approveWrites(f, run);
      // Something already sits where the checkout would be created, under a private work root.
      mkdirSync(f.workRoot, { mode: 0o700 });
      chmodSync(f.workRoot, 0o700);
      mkdirSync(join(f.workRoot, run.runId, "repositories", "primary"), { recursive: true });
      const refused = await confirm(f, run);
      expect(refused, JSON.stringify(refused)).toMatchObject({
        ok: false,
        reasonCode: ReasonCode.BOOTSTRAP_FACTORY_RESULT_INSUFFICIENT,
        evidence: { stage: "precondition" },
      });
      expect(f.github.reads).toEqual([]);
      nothingApplied(f, run);
    });
  });

  it("the owner pin is not the ACTIVE BOOTSTRAP_CTO, or the CONFIRM is not the CEO's: refused at the runner's own door, nothing applied", async () => {
    await withFixture(async (f) => {
      const run = await reviewedBootstrap(f, cleanTreeManifest("c3-w3-pin"));
      await approveWrites(f, run);
      await f.harness.cp.continuity.evaluate("bootstrap confirmation");
      const door = (ceoSessionId: string) =>
        f.harness.cp.bootstrapProducer.produceAndActivateApproved({ runId: run.runId, candidateSnapshotDigest: run.candidate, ceoSessionId });

      const notCeo = await door(run.owner);
      expect(notCeo).toMatchObject({ allowed: false, reasonCode: ReasonCode.GATE_AUTHORITY_DENIED });
      nothingApplied(f, run);

      // The registry answers that the run's BOOTSTRAP_CTO is held at another generation than pinned.
      const roleKey = roleKeyFor(Role.BOOTSTRAP_CTO, { runId: run.runId });
      const active = f.harness.cp.bindings.active(roleKey)!;
      const read = f.harness.cp.bindings.active.bind(f.harness.cp.bindings);
      vi.spyOn(f.harness.cp.bindings, "active").mockImplementation((key: string) =>
        key === roleKey ? { ...active, bindingGeneration: active.bindingGeneration + 1 } : read(key));
      const stale = await door(f.ceoSessionId);
      expect(stale).toMatchObject({ allowed: false, reasonCode: ReasonCode.BINDING_GENERATION_STALE });
      nothingApplied(f, run);
    });
  });
});

describe("#246 C3 W5: an attempt freezes the plan", () => {
  it("after an attempt is recorded, plan_submit and FINAL_REVISE are refused BOOTSTRAP_APPLICATION_FROZEN and the PLAN is unchanged", async () => {
    await withFixture(async (f) => {
      const run = await reviewedBootstrap(f, cleanTreeManifest("c3-w5-frozen"));
      await approveWrites(f, run);
      f.github.failNext = "pushBranch";
      const attempted = await confirm(f, run);
      expect(attempted).toMatchObject({ ok: false, evidence: { stage: "production" } });
      expect(applicationOf(f, run.runId)).toMatchObject({ phase: "RESERVED", attempts: 1 });

      const replanned = await f.cto(run.owner, "plan_submit", {
        runId: run.runId,
        plan: bootstrapPlan(cleanTreeManifest("c3-w5-another")),
        tasks: [{ key: "replan", title: "replan", category: "implementation" }],
      });
      expect(replanned, JSON.stringify(replanned)).toMatchObject({ ok: false, reasonCode: ReasonCode.BOOTSTRAP_APPLICATION_FROZEN });

      await f.harness.cp.continuity.evaluate("bootstrap revision");
      const revised = await f.hermes("ceo_decision_submit", {
        runId: run.runId,
        decision: "FINAL_REVISE",
        candidateSnapshotDigest: run.candidate,
        ceoSessionId: f.ceoSessionId,
        rationale: "plan another manifest",
      });
      expect(revised, JSON.stringify(revised)).toMatchObject({ ok: false, reasonCode: ReasonCode.BOOTSTRAP_APPLICATION_FROZEN });

      expect(f.harness.cp.artifacts.latest(run.runId, "PLAN")?.digest).toBe(run.planDigest);
      expect(f.harness.cp.runs.require(run.runId).state).toBe(RunState.READY_FOR_CEO_REVIEW);
      // The frozen candidate can still be applied: the re-CONFIRM resumes and writes what was left.
      const resumed = await confirm(f, run);
      expect(resumed, JSON.stringify(resumed)).toMatchObject({ ok: false, reasonCode: ReasonCode.BOOTSTRAP_ACTIVATION_INCOMPLETE });
      expect(writesOf(f, "createRepository")).toHaveLength(1);
      expect(existsSync(join(f.workRoot, run.runId, "repositories", "primary"))).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------------------------
// #246 C3 — the CEO's decisions on the slice's four open choices (2026-10-10): (a) the approval
// digest an application keeps is the approved write scope, never an approval; (b) the freeze starts
// at the reservation, and a scope change never reuses the approval it consumed; (c) the checkout an
// interrupted attempt left behind is recovered officially — verified, preserved, never deleted, and
// authorising nothing; (d) a row a raw SQL writer forges never authorises an external execution.

interface RecordedApproval {
  owner: string;
  visibility: "public" | "private";
  receipt: Record<string, unknown>;
}

/** The owner's newest recorded approval of the GitHub writes, as the CONFIRM door reads it. */
const recordedApproval = (f: Fixture, runId: string): RecordedApproval => {
  const recorded = f.harness.cp.artifacts
    .list<Record<string, unknown>>(runId, ArtifactKind.APPROVAL)
    .filter((artifact) => artifact.content["kind"] === REPO_FACTORY_GITHUB_WRITE_APPROVAL_KIND)
    .at(-1);
  if (!recorded) throw new Error("no owner approval is recorded");
  return recorded.content as unknown as RecordedApproval;
};

/** The CEO's CONFIRM straight at the runner's door, carrying whatever approval the caller presents. */
const applyWith = async (f: Fixture, run: ReviewedRun, ownerApproval: RepoFactoryOwnerApproval | null) => {
  await f.harness.cp.continuity.evaluate("bootstrap confirmation");
  return f.harness.cp.bootstrapProducer.produceAndActivate({
    runId: run.runId,
    candidateSnapshotDigest: run.candidate,
    ceoSessionId: f.ceoSessionId,
    ownerApproval,
    approvedManifest: run.manifest,
    projectName: "fixture project",
    handoff: bootstrapActivationHandoff(run.manifest),
  });
};

/** Reviewed and approved; its first CONFIRM reserved the application and GitHub refused the create. */
const reservedRun = async (f: Fixture, projectId: string): Promise<ReviewedRun> => {
  const run = await reviewedBootstrap(f, cleanTreeManifest(projectId));
  await approveWrites(f, run);
  f.github.failNext = "createRepository";
  const attempted = await confirm(f, run);
  expect(attempted, JSON.stringify(attempted)).toMatchObject({ ok: false, evidence: { stage: "production" } });
  expect(applicationOf(f, run.runId)).toMatchObject({ phase: "RESERVED", attempts: 1 });
  expect(consumedApprovals(f, run.runId)).toBe(1);
  f.github.writes.length = 0;
  return run;
};

/** Nothing written to GitHub since, no other approval consumed, the application where it was. */
const nothingMore = (f: Fixture, run: ReviewedRun): void => {
  expect(writesOf(f)).toEqual([]);
  expect(consumedApprovals(f, run.runId)).toBe(1);
  expect(applicationOf(f, run.runId)).toMatchObject({ phase: "RESERVED", attempts: 1 });
  expect(f.harness.cp.runs.require(run.runId).state).toBe(RunState.READY_FOR_CEO_REVIEW);
};

describe("#246 C3 decision (a): the approval digest an application keeps is not an approval", () => {
  it("a receipt no ingress admitted, carrying the reserved approval digest, is refused before any write", async () => {
    await withFixture(async (f) => {
      const run = await reservedRun(f, "c3-a-forged");
      const recorded = recordedApproval(f, run.runId);
      const forged: Record<string, unknown> = { ...recorded.receipt, inboundNonce: "never-admitted", idempotencyKey: "forged" };
      expect(forged["parameterDigest"]).toBe(applicationOf(f, run.runId)?.approvalDigest);
      const refused = await applyWith(f, run, { owner: recorded.owner, visibility: recorded.visibility, receipt: forged });
      expect(refused, JSON.stringify(refused)).toMatchObject({
        allowed: false,
        reasonCode: ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE,
        evidence: { stage: "approval" },
      });
      nothingMore(f, run);
    });
  });

  it("no receipt at all is refused before any write, though the application is reserved", async () => {
    await withFixture(async (f) => {
      const run = await reservedRun(f, "c3-a-missing");
      const refused = await applyWith(f, run, null);
      expect(refused, JSON.stringify(refused)).toMatchObject({
        allowed: false,
        reasonCode: ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE,
        evidence: { stage: "approval", refusal: "APPROVAL_MISSING" },
      });
      nothingMore(f, run);
    });
  });

  it("the admitted receipt whose digest matches the reservation, presented for another target, is refused before any write", async () => {
    await withFixture(async (f) => {
      const run = await reservedRun(f, "c3-a-target");
      const recorded = recordedApproval(f, run.runId);
      expect(recorded.receipt["parameterDigest"]).toBe(applicationOf(f, run.runId)?.approvalDigest);
      const refused = await applyWith(f, run, { owner: "someone-else", visibility: recorded.visibility, receipt: recorded.receipt });
      expect(refused, JSON.stringify(refused)).toMatchObject({ allowed: false, evidence: { refusal: "OWNER_MISMATCH" } });
      nothingMore(f, run);
    });
  });

  it("the admitted receipt whose digest matches the reservation, presented with another visibility, is refused before any write", async () => {
    await withFixture(async (f) => {
      const run = await reservedRun(f, "c3-a-visibility");
      const recorded = recordedApproval(f, run.runId);
      const refused = await applyWith(f, run, { owner: recorded.owner, visibility: "private", receipt: recorded.receipt });
      expect(refused, JSON.stringify(refused)).toMatchObject({ allowed: false, evidence: { refusal: "VISIBILITY_MISMATCH" } });
      nothingMore(f, run);
    });
  });
});

describe("#246 C3 decision (b): the freeze starts at the reservation", () => {
  it("an owner approval of another write scope is refused, not substituted, and the reserved approval is not reused for it", async () => {
    await withFixture(async (f) => {
      const run = await reservedRun(f, "c3-b-scope");
      // The same GitHub owner by name, and so past the plan's own check, but another write scope.
      await approveWrites(f, run, { githubOwner: "ACME" });
      const refused = await confirm(f, run);
      expect(refused, JSON.stringify(refused)).toMatchObject({
        ok: false,
        reasonCode: ReasonCode.BOOTSTRAP_APPLICATION_FROZEN,
        evidence: { drift: ["approvalDigest"] },
      });
      nothingMore(f, run);
    });
  });
});

/**
 * What the runner would reserve for this run, computed as a raw database writer with read access
 * could compute it: the PLAN, manifest, planned outputs, candidate, review and write scope.
 */
const reservationOf = (f: Fixture, run: ReviewedRun) => {
  const plan = f.harness.cp.artifacts.latest<unknown>(run.runId, ArtifactKind.PLAN);
  const planned = plannedBootstrapOutputs({ runId: run.runId, planArtifact: plan }, run.manifest);
  if (!planned.allowed || plan === null) throw new Error("the fixture's PLAN has no planned outputs");
  const reviewed = f.harness.cp.bootstrap.reviewForConfirmation(run.runId, run.candidate);
  if (!reviewed.allowed) throw new Error(reviewed.message);
  const parameters = repoFactoryGitHubWriteParameters({
    owner: "acme",
    visibility: "public",
    planDigest: plan.digest,
    githubOperations: planned.value.githubOperations,
  });
  return [
    run.runId,
    run.manifest.projectId,
    planned.value.target.repositoryIdentity,
    planned.value.bootstrapOperationId,
    plan.digest,
    manifestDigest(run.manifest),
    digestOf(planned.value),
    run.candidate,
    reviewed.value.digest,
    digestOf(parameters),
  ] as const;
};

/** bootstrap_applications rows as a raw SQL writer writes them: no runner, no approval, no attempt of its own. */
const forgeApplication = (f: Fixture, run: ReviewedRun, phase: "RESERVED" | "WRITTEN" | "COMPLETED", attempts: number): string => {
  const reservation = reservationOf(f, run);
  const db = f.harness.cp.db;
  db.run(
    `INSERT INTO bootstrap_applications (run_id, project_id, repository_identity, bootstrap_operation_id, plan_digest,
                                         manifest_digest, planned_outputs_digest, candidate_snapshot_digest, review_digest,
                                         approval_digest, phase, attempts, last_refusal_json, reserved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'RESERVED', 0, NULL, ?)`,
    [...reservation, f.harness.clock.nowIso()],
  );
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    db.run(`UPDATE bootstrap_applications SET attempts = attempts + 1 WHERE run_id = ?`, [run.runId]);
  }
  if (phase !== "RESERVED") db.run(`UPDATE bootstrap_applications SET phase = 'WRITTEN' WHERE run_id = ?`, [run.runId]);
  if (phase === "COMPLETED") db.run(`UPDATE bootstrap_applications SET phase = 'COMPLETED' WHERE run_id = ?`, [run.runId]);
  return reservation[9];
};

/** An approval record whose receipt has the admitted shape and the reserved digest, and that no ingress admitted. */
const forgeApprovalRecord = (f: Fixture, run: ReviewedRun, approvalDigest: string): void => {
  f.harness.cp.artifacts.put(run.runId, ArtifactKind.APPROVAL, {
    kind: REPO_FACTORY_GITHUB_WRITE_APPROVAL_KIND,
    owner: "acme",
    visibility: "public",
    planDigest: run.planDigest,
    approvedManifest: run.manifest,
    projectName: "fixture project",
    receipt: {
      channel: "cli",
      actor: TEST_OWNER.actor,
      inboundNonce: "never-admitted",
      runId: run.runId,
      candidateSnapshotDigest: run.candidate,
      operation: "repo_factory_github_write",
      parameterDigest: approvalDigest,
      idempotencyKey: "forged",
      approved: true,
    },
  }, run.candidate);
};

/** Nothing outside the database happened: no GitHub read or write, no checkout, no project, no primary CTO. */
const nothingExternal = (f: Fixture, run: ReviewedRun): void => {
  expect(f.github.writes).toEqual([]);
  expect(f.github.reads).toEqual([]);
  expect(existsSync(join(f.workRoot, run.runId))).toBe(false);
  expect(consumedApprovals(f, run.runId)).toBe(0);
  expect(f.harness.cp.projects.get(run.manifest.projectId)).toBeNull();
  expect(f.harness.cp.bindings.activePrimaryCto(run.manifest.projectId)).toBeNull();
  expect(f.harness.cp.runs.require(run.runId).state).toBe(RunState.READY_FOR_CEO_REVIEW);
};

/**
 * Unlike the blocks above, this one writes to the database directly, on purpose: it is the raw SQL
 * writer the v43 triggers do not stop from inserting RESERVED or moving a phase forward.
 */
describe("#246 C3 decision (d): a row a raw SQL writer forges authorises no external execution", () => {
  it("a forged RESERVED row, with no official approval, writes nothing, consumes nothing and freezes the plan", async () => {
    await withFixture(async (f) => {
      const run = await reviewedBootstrap(f, cleanTreeManifest("c3-d-reserved"));
      const approvalDigest = forgeApplication(f, run, "RESERVED", 0);

      // The freeze starts at the reservation, whoever wrote it, attempt or no attempt.
      const replanned = await f.cto(run.owner, "plan_submit", {
        runId: run.runId,
        plan: bootstrapPlan(cleanTreeManifest("c3-d-another")),
        tasks: [{ key: "replan", title: "replan", category: "implementation" }],
      });
      expect(replanned, JSON.stringify(replanned)).toMatchObject({ ok: false, reasonCode: ReasonCode.BOOTSTRAP_APPLICATION_FROZEN });
      await f.harness.cp.continuity.evaluate("bootstrap revision");
      const revised = await f.hermes("ceo_decision_submit", {
        runId: run.runId,
        decision: "FINAL_REVISE",
        candidateSnapshotDigest: run.candidate,
        ceoSessionId: f.ceoSessionId,
        rationale: "plan another manifest",
      });
      expect(revised, JSON.stringify(revised)).toMatchObject({ ok: false, reasonCode: ReasonCode.BOOTSTRAP_APPLICATION_FROZEN });

      const unapproved = await confirm(f, run);
      expect(unapproved, JSON.stringify(unapproved)).toMatchObject({ ok: false, evidence: { stage: "approval", refusal: "APPROVAL_MISSING" } });

      forgeApprovalRecord(f, run, approvalDigest);
      const forged = await confirm(f, run);
      expect(forged, JSON.stringify(forged)).toMatchObject({
        ok: false,
        reasonCode: ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE,
        evidence: { stage: "approval" },
      });
      // An attempt the same writer records changes nothing either.
      f.harness.cp.db.run(`UPDATE bootstrap_applications SET attempts = attempts + 1 WHERE run_id = ?`, [run.runId]);
      const again = await confirm(f, run);
      expect(again).toMatchObject({ ok: false, reasonCode: ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE, evidence: { stage: "approval" } });

      nothingExternal(f, run);
      expect(applicationOf(f, run.runId)).toMatchObject({ phase: "RESERVED", attempts: 1 });
    });
  });

  it("a forged WRITTEN row, with no official approval, activates nothing and writes nothing", async () => {
    await withFixture(async (f) => {
      const run = await reviewedBootstrap(f, cleanTreeManifest("c3-d-written"));
      const approvalDigest = forgeApplication(f, run, "WRITTEN", 1);
      const unapproved = await confirm(f, run);
      expect(unapproved, JSON.stringify(unapproved)).toMatchObject({ ok: false, evidence: { stage: "approval", refusal: "APPROVAL_MISSING" } });
      forgeApprovalRecord(f, run, approvalDigest);
      const forged = await confirm(f, run);
      expect(forged, JSON.stringify(forged)).toMatchObject({
        ok: false,
        reasonCode: ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE,
        evidence: { stage: "approval" },
      });
      nothingExternal(f, run);
      expect(applicationOf(f, run.runId)).toMatchObject({ phase: "WRITTEN", attempts: 1 });
    });
  });

  it("a forged COMPLETED row beside a run at CEO review is refused before any write, even under the owner's own approval", async () => {
    await withFixture(async (f) => {
      const run = await reviewedBootstrap(f, cleanTreeManifest("c3-d-completed"));
      await approveWrites(f, run);
      forgeApplication(f, run, "COMPLETED", 1);
      const refused = await confirm(f, run);
      expect(refused, JSON.stringify(refused)).toMatchObject({
        ok: false,
        reasonCode: ReasonCode.BOOTSTRAP_APPLICATION_NOT_AVAILABLE,
        evidence: { refusal: "APPLICATION_PHASE_INCONSISTENT", phase: "COMPLETED" },
      });
      nothingExternal(f, run);
    });
  });
});

const deferred = () => {
  let reject!: (error: Error) => void;
  const promise = new Promise<never>((_resolve, rejectWith) => {
    reject = rejectWith;
  });
  return { promise, reject };
};

/**
 * An application attempt that dies mid-production, left as a killed daemon leaves it: the first
 * CONFIRM reserves, creates the repository and commits, and its push never answers. `whileInFlight`
 * runs then. The checkout is copied as it stands; the attempt is let fail, its producer cleaning up as
 * a live process does; and the copy is put back where the dead process would have left it.
 */
const interruptedAttempt = async (
  f: Fixture,
  run: ReviewedRun,
  whileInFlight: (checkoutPath: string) => Promise<void> = async () => {},
): Promise<{ workDir: string; checkoutPath: string; preservedPath: string }> => {
  const workDir = join(f.workRoot, run.runId);
  const checkoutPath = repositoryCheckoutPath(workDir, "primary");
  const hung = deferred();
  const push = vi.spyOn(f.github, "pushBranch").mockImplementationOnce(() => hung.promise);
  const confirming = confirm(f, run);
  await vi.waitFor(() => expect(push).toHaveBeenCalled(), { timeout: 30_000, interval: 20 });
  await whileInFlight(checkoutPath);
  const copy = join(tempDir("acp-c3-interrupted-"), "checkout");
  cpSync(checkoutPath, copy, { recursive: true });
  hung.reject(new Error("the daemon died while the push was in flight"));
  const failed = await confirming;
  expect(failed["ok"], JSON.stringify(failed)).toBe(false);
  push.mockRestore();
  expect(existsSync(checkoutPath)).toBe(false);
  cpSync(copy, checkoutPath, { recursive: true });
  expect(applicationOf(f, run.runId)).toMatchObject({ phase: "RESERVED", attempts: 1 });
  return { workDir, checkoutPath, preservedPath: join(workDir, "preserved", "primary-attempt-1") };
};

/** The official recovery, as the CEO runs it: the allowlisted repair over the Hermes socket. */
const preserveCheckout = (f: Fixture, run: ReviewedRun, dryRun = false) =>
  f.hermes("repair_execute", {
    operationId: "preserve_interrupted_bootstrap_checkout",
    parameters: {},
    authorizedBy: "HERMES",
    dryRun,
    runId: run.runId,
  });

const MARKER = ".repo-factory-operation.json";

const preservedRecords = (f: Fixture) => f.harness.cp.audit.byKind("BOOTSTRAP_CHECKOUT_PRESERVED").map((row) => row.evidence);

/** The precondition at `index` of a refused repair, as its evidence reports it. */
const preconditionOf = (refused: Record<string, unknown>, index: number) =>
  ((refused["evidence"] as { preconditions: Array<{ satisfied: boolean; evidence: Record<string, unknown> }> }).preconditions)[index];

/** The checkout is where the dead attempt left it, unmoved, and nothing was preserved. */
const leftInPlace = (f: Fixture, checkout: { checkoutPath: string; preservedPath: string }): void => {
  expect(existsSync(join(checkout.checkoutPath, MARKER))).toBe(true);
  expect(existsSync(join(checkout.checkoutPath, ".git"))).toBe(true);
  expect(existsSync(checkout.preservedPath)).toBe(false);
  expect(preservedRecords(f)).toEqual([]);
};

describe("#246 C3 decision (c): the official recovery of an interrupted attempt's checkout", () => {
  it("verifies the owner and an ended attempt, preserves the checkout, authorises nothing, and a new CONFIRM then completes", async () => {
    await withFixture(async (f) => {
      const run = await reviewedBootstrap(f, cleanTreeManifest("c3-c-happy"));
      await approveWrites(f, run);
      const checkout = await interruptedAttempt(f, run);
      // The push never reached GitHub: only the create did.
      const writesBefore = writesOf(f);
      expect(writesBefore).toEqual(["createRepository"]);

      // Fail-closed stays: the leftover checkout refuses a CONFIRM by name.
      const refused = await confirm(f, run);
      expect(refused, JSON.stringify(refused)).toMatchObject({ ok: false, evidence: { refusal: "INTERRUPTED_RUN_CHECKOUT" } });

      // A dry run verifies and moves nothing.
      const dry = await preserveCheckout(f, run, true);
      expect(dry, JSON.stringify(dry)).toMatchObject({ ok: true, value: { dryRun: true, changes: 1 } });
      leftInPlace(f, checkout);

      const preserved = await preserveCheckout(f, run);
      expect(preserved, JSON.stringify(preserved)).toMatchObject({ ok: true, value: { dryRun: false, changes: 1 } });
      const checked = (preserved["value"] as { preconditionsChecked: Array<{ satisfied: boolean }> }).preconditionsChecked;
      expect(checked.map((precondition) => precondition.satisfied)).toEqual([true, true, true, true]);
      // Moved, not deleted: the same checkout, marker and history, at the recorded place.
      const application = applicationOf(f, run.runId)!;
      expect(existsSync(checkout.checkoutPath)).toBe(false);
      expect(JSON.parse(readFileSync(join(checkout.preservedPath, MARKER), "utf8"))).toEqual({
        bootstrapOperationId: application.bootstrapOperationId,
      });
      expect(existsSync(join(checkout.preservedPath, ".git", "HEAD"))).toBe(true);
      expect(preservedRecords(f)).toEqual([{
        runId: run.runId,
        bootstrapOperationId: application.bootstrapOperationId,
        attempts: 1,
        candidateSnapshotDigest: run.candidate,
        originalPath: checkout.checkoutPath,
        preservedPath: checkout.preservedPath,
      }]);
      expect(f.harness.cp.artifacts.latest(run.runId, ArtifactKind.REPAIR_RECEIPT)?.content).toMatchObject({
        operationId: "preserve_interrupted_bootstrap_checkout",
        changes: 1,
      });
      // It authorised nothing: no write, no approval consumed, no attempt recorded, no phase moved.
      expect(writesOf(f)).toEqual(writesBefore);
      expect(consumedApprovals(f, run.runId)).toBe(1);
      expect(application).toMatchObject({ phase: "RESERVED", attempts: 1 });

      // Only a new CEO CONFIRM resumes it, from the attempt ledger: still one create.
      const resumed = await confirm(f, run);
      expect(resumed, JSON.stringify(resumed)).toMatchObject({ ok: false, reasonCode: ReasonCode.BOOTSTRAP_ACTIVATION_INCOMPLETE });
      expect(writesOf(f, "createRepository")).toHaveLength(1);
      expect(applicationOf(f, run.runId)).toMatchObject({ phase: "WRITTEN", attempts: 2 });
      await acknowledgeHandoff(f, run, resumed);
      const completed = await confirm(f, run);
      expect(completed, JSON.stringify(completed)).toMatchObject({ ok: true, value: { state: RunState.COMPLETED } });
      expect(existsSync(join(checkout.preservedPath, MARKER))).toBe(true);
    });
  });

  it("refuses a checkout whose marker names another operation, and leaves it in place", async () => {
    await withFixture(async (f) => {
      const run = await reviewedBootstrap(f, cleanTreeManifest("c3-c-owner"));
      await approveWrites(f, run);
      const checkout = await interruptedAttempt(f, run);
      writeFileSync(join(checkout.checkoutPath, MARKER), `${JSON.stringify({ bootstrapOperationId: "another-operation" })}\n`);
      const refused = await preserveCheckout(f, run);
      expect(refused, JSON.stringify(refused)).toMatchObject({ ok: false, reasonCode: ReasonCode.REPAIR_PRECONDITION_UNMET });
      expect(preconditionOf(refused, 1)).toMatchObject({ satisfied: false, evidence: { refusal: "CHECKOUT_NOT_THIS_APPLICATION" } });
      leftInPlace(f, checkout);
    });
  });

  it("refuses while an attempt is in flight, while a git lock is held, or while this process is not the only writer", async () => {
    await withFixture(async (f) => {
      const run = await reviewedBootstrap(f, cleanTreeManifest("c3-c-live"));
      await approveWrites(f, run);
      const checkout = await interruptedAttempt(f, run, async (checkoutPath) => {
        const inFlight = await preserveCheckout(f, run);
        expect(inFlight, JSON.stringify(inFlight)).toMatchObject({ ok: false, reasonCode: ReasonCode.REPAIR_PRECONDITION_UNMET });
        expect(preconditionOf(inFlight, 2)).toMatchObject({ satisfied: false, evidence: { attemptInFlight: true } });
        expect(existsSync(join(checkoutPath, MARKER))).toBe(true);
      });

      const lock = join(checkout.checkoutPath, ".git", "index.lock");
      writeFileSync(lock, "");
      const locked = await preserveCheckout(f, run);
      expect(locked, JSON.stringify(locked)).toMatchObject({ ok: false, reasonCode: ReasonCode.REPAIR_PRECONDITION_UNMET });
      expect(preconditionOf(locked, 2)).toMatchObject({ satisfied: false, evidence: { gitLockFiles: [".git/index.lock"] } });
      leftInPlace(f, checkout);
      // The fixture's own lock file, not the checkout's content: taken away again before the last case.
      unlinkSync(lock);

      // No lock the runner can see is held for it: nothing shows the dead attempt has ended.
      f.harness.cp.bootstrapProducer.attachWriterLock(() => false);
      const unlocked = await preserveCheckout(f, run);
      expect(unlocked, JSON.stringify(unlocked)).toMatchObject({ ok: false, reasonCode: ReasonCode.REPAIR_PRECONDITION_UNMET });
      expect(preconditionOf(unlocked, 2)).toMatchObject({ satisfied: false, evidence: { writerLockHeld: false } });
      leftInPlace(f, checkout);
    });
  });

  it("refuses when the move fails, with the checkout intact where it was", async () => {
    await withFixture(async (f) => {
      const run = await reviewedBootstrap(f, cleanTreeManifest("c3-c-move"));
      await approveWrites(f, run);
      const checkout = await interruptedAttempt(f, run);
      // The checkout cannot leave its parent: rename needs to write the directory it leaves.
      const repositories = join(checkout.workDir, "repositories");
      chmodSync(repositories, 0o500);
      let refused: Record<string, unknown>;
      try {
        refused = await preserveCheckout(f, run);
      } finally {
        chmodSync(repositories, 0o700);
      }
      expect(refused, JSON.stringify(refused)).toMatchObject({
        ok: false,
        reasonCode: ReasonCode.BOOTSTRAP_CHECKOUT_NOT_PRESERVED,
        evidence: { refusal: "MOVE_FAILED", originalPath: checkout.checkoutPath },
      });
      leftInPlace(f, checkout);
      expect(applicationOf(f, run.runId)).toMatchObject({ phase: "RESERVED", attempts: 1 });
    });
  });

  it("refuses when the preservation location is taken, and moves nothing into it", async () => {
    await withFixture(async (f) => {
      const run = await reviewedBootstrap(f, cleanTreeManifest("c3-c-collision"));
      await approveWrites(f, run);
      const checkout = await interruptedAttempt(f, run);
      mkdirSync(join(checkout.workDir, "preserved"), { mode: 0o700 });
      mkdirSync(checkout.preservedPath, { mode: 0o700 });
      const refused = await preserveCheckout(f, run);
      expect(refused, JSON.stringify(refused)).toMatchObject({ ok: false, reasonCode: ReasonCode.REPAIR_PRECONDITION_UNMET });
      expect(preconditionOf(refused, 3)).toMatchObject({ satisfied: false, evidence: { occupied: true } });
      expect(existsSync(join(checkout.checkoutPath, MARKER))).toBe(true);
      expect(existsSync(join(checkout.preservedPath, MARKER))).toBe(false);
      expect(preservedRecords(f)).toEqual([]);
    });
  });

  it("after the recovery, a CONFIRM under another write scope is refused", async () => {
    await withFixture(async (f) => {
      const run = await reviewedBootstrap(f, cleanTreeManifest("c3-c-scope"));
      await approveWrites(f, run);
      const checkout = await interruptedAttempt(f, run);
      expect(await preserveCheckout(f, run)).toMatchObject({ ok: true });
      const writesBefore = writesOf(f);
      await approveWrites(f, run, { githubOwner: "ACME" });
      const refused = await confirm(f, run);
      expect(refused, JSON.stringify(refused)).toMatchObject({
        ok: false,
        reasonCode: ReasonCode.BOOTSTRAP_APPLICATION_FROZEN,
        evidence: { drift: ["approvalDigest"] },
      });
      expect(writesOf(f)).toEqual(writesBefore);
      expect(consumedApprovals(f, run.runId)).toBe(1);
      expect(applicationOf(f, run.runId)).toMatchObject({ phase: "RESERVED", attempts: 1 });
      expect(existsSync(checkout.checkoutPath)).toBe(false);
    });
  });

  it("the recovery never revives the approval it found: after an owner's decline, the CONFIRM is refused", async () => {
    await withFixture(async (f) => {
      const run = await reviewedBootstrap(f, cleanTreeManifest("c3-c-revive"));
      await approveWrites(f, run);
      const checkout = await interruptedAttempt(f, run);
      expect(await preserveCheckout(f, run)).toMatchObject({ ok: true });
      const writesBefore = writesOf(f);
      await approveWrites(f, run, { decline: true });
      const refused = await confirm(f, run);
      expect(refused, JSON.stringify(refused)).toMatchObject({ ok: false, evidence: { stage: "approval", refusal: "APPROVAL_DECLINED" } });
      expect(writesOf(f)).toEqual(writesBefore);
      expect(consumedApprovals(f, run.runId)).toBe(1);
      expect(applicationOf(f, run.runId)).toMatchObject({ phase: "RESERVED", attempts: 1 });
      expect(existsSync(checkout.checkoutPath)).toBe(false);
    });
  });
});
