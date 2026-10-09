import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { createOperatorClient, dispatch } from "../../src/cli/agentctl.ts";
import { digestOf } from "../../src/core/digest.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import type { ProjectManifest } from "../../src/contracts/manifest.ts";
import { startLocalMcpListeners, startOperatorSocket, startSessionLaunchChannel } from "../../src/daemon/agentcpd.ts";
import { Daemon } from "../../src/daemon/daemon.ts";
import { ExecutionMode, Role, RunKind, RunState, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
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

/** The owner's approval of the GitHub writes: agentctl over the operator socket, with the owner token. */
const approveWrites = async (f: Fixture, run: ReviewedRun): Promise<void> => {
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
      "acme",
      "--visibility",
      "public",
      "--plan-digest",
      run.planDigest,
      "--manifest",
      manifestPath,
      "--project-name",
      "fixture project",
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

      // Nothing retries it: another CONFIRM writes nothing and changes nothing.
      const again = await confirm(f, run);
      expect(again).toMatchObject({ ok: false, reasonCode: ReasonCode.BOOTSTRAP_APPLICATION_STRANDED });
      expect(writesOf(f)).toEqual(["createRepository"]);
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
