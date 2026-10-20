import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { Daemon } from "../../src/daemon/daemon.ts";
import { ArtifactKind, RunState } from "../../src/domain/types.ts";
import { MessageKind } from "../../src/outbox/envelope.ts";
import { type BootstrapRuntimeFixture, withBootstrapRuntime } from "../helpers/bootstrap-cto-fixture.ts";
import { passBootstrapPlanReviews, resultState } from "../helpers/bootstrap-result.ts";
import { FakeGitHub as FakeGitHubClient } from "../helpers/fake-github.ts";
import { FakeGitHub as FakeGitHubWritePort } from "../helpers/fake-github-write-port.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { RESULT_DIRECTIVE, scriptBootstrapOwner } from "../helpers/scripted-bootstrap-owner.ts";

afterAll(cleanupTempDirs);
afterEach(() => vi.restoreAllMocks());

/**
 * The live stall after #1113 (CEO 1792118069): a project-less PROJECT_BOOTSTRAP run's driven
 * BOOTSTRAP_CTO got its PLAN accepted, acknowledged its RUN_DISPATCH and ended its turn. The run is
 * ACTIVE with a PLAN and a READY task, no result was submitted, no review exists, and nothing wakes
 * the owner again.
 *
 * Every row goes through the real sockets, the launch channel, the in-band wake, a started daemon with
 * its watchdog and the candidate pipeline with its blind review; only providers are
 * scripted (the owner's model and the reviewer). No worker is staffed and no receipt is written: the
 * PLAN's task stays READY at CEO review (CEO 1792120507). The rows import nothing the
 * fix added, so they run unchanged against the base and fail there on behaviour.
 */

const RESULT_WAKE = "BOOTSTRAP_RESULT_RECOVERY_WAKE";

const resultWakes = (f: BootstrapRuntimeFixture, runId: string): number =>
  f.harness.cp.db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM audit_events WHERE kind = ? AND run_id = ?`,
    [RESULT_WAKE, runId],
  )?.n ?? 0;

const runDispatches = (f: BootstrapRuntimeFixture, runId: string) =>
  f.harness.cp.outbox.listByRun(runId)
    .filter((message) => message.kind === MessageKind.RUN_DISPATCH)
    .map((message) => ({ generation: message.bindingGeneration, status: message.status }))
    .sort((left, right) => left.generation - right.generation);

const startDaemon = async (f: BootstrapRuntimeFixture, name: string): Promise<Daemon> => {
  // The startup doctor blocks on a missing trusted GitHub credential, which these rows are not about.
  f.harness.cp.credentials.install({ token: "test-token", creatorIdentity: "acme-bot" });
  const daemon = new Daemon(f.harness.cp, { stateDir: tempDir(`acp-brstall-${name}-`), watchdogIntervalMs: 50 });
  const started = await daemon.start();
  if (!started.allowed) throw new Error(`${started.reasonCode}: ${started.message} ${JSON.stringify(started.evidence)}`);
  return daemon;
};

const ticks = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const executions = (f: BootstrapRuntimeFixture, runId: string): number =>
  f.harness.cp.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM task_executions WHERE run_id = ?`, [runId])?.n ?? 0;

/** What a reached CEO review must not carry: any approval, decision, application or GitHub effect. */
const APPROVAL_KINDS = [
  "CEO_DECISION", "OWNER_DECISION", "OWNER_APPROVAL_INGRESS", "OWNER_APPROVAL_CONSUMED",
  "BOOTSTRAP_APPLICATION_APPROVAL", "BOOTSTRAP_ACTIVATION_READY_FOR_CONFIRM", "BUZZ_OWNER_APPROVAL_PROMPTED",
];

const expectNoGatePassed = (
  f: BootstrapRuntimeFixture,
  runId: string,
  ownerSessionId: string,
  client: FakeGitHubClient,
  writePort: FakeGitHubWritePort,
) => {
  expect(client.calls).toEqual([]);
  expect(writePort.writes).toEqual([]);
  expect(writePort.reads).toEqual([]);
  expect(f.harness.cp.audit.all().filter((row) => APPROVAL_KINDS.includes(row.kind))).toEqual([]);
  // The one APPROVAL is the packet's own: the bootstrap CTO's result, signed by its owner session and generation.
  expect(f.harness.cp.artifacts.list<Record<string, unknown>>(runId, ArtifactKind.APPROVAL).map((row) => ({
    by: row.content["approvedBySessionId"],
    generation: row.content["approvedByGeneration"],
  }))).toEqual([{ by: ownerSessionId, generation: 1 }]);
  expect(f.harness.cp.artifacts.latest(runId, ArtifactKind.REPO_FACTORY_RESULT)).toBeNull();
  expect(f.harness.cp.artifacts.latest(runId, ArtifactKind.BOOTSTRAP_ACTIVATION_RESULT)).toBeNull();
  expect(f.harness.cp.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM bootstrap_applications`)?.n).toBe(0);
  expect(f.harness.cp.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM github_receipts`)?.n).toBe(0);
  // The T3 prompt is only eligible: the run is at CEO review and needs an owner decision it does not have.
  const scope = f.harness.cp.bootstrapProducer.approvalScopeOf(runId);
  expect(scope.allowed, JSON.stringify(scope)).toBe(true);
};

describe("the result stall: a driven bootstrap owner whose PLAN was accepted, who acknowledged and submitted no result", () => {
  it("is left ACTIVE with no review and no further turn; the daemon wakes it once, the owner follows the prompt, and the run reaches READY_FOR_CEO_REVIEW with no gate passed", async () => {
    const client = new FakeGitHubClient();
    const writePort = new FakeGitHubWritePort(tempDir("acp-brstall-github-"));
    await withBootstrapRuntime(async (f) => {
      const reviews = passBootstrapPlanReviews(f);
      const owner = scriptBootstrapOwner(f, { onDispatch: "follow-prompt", onResult: "recovery-only" });
      const { runId, ownerSessionId } = await f.dispatchBootstrap();
      // The attestation, then the RUN_DISPATCH's work turn: a PLAN accepted, the dispatch acknowledged, no result.
      await f.awaitFinishedTurns(ownerSessionId, 2);
      await vi.waitFor(() => expect(f.harness.cp.sessionRuntime.turnInProgress(ownerSessionId)).toBe(false));
      expect(owner.submissions.at(-1)).toMatchObject({ ok: true });
      expect(runDispatches(f, runId)).toEqual([{ generation: 1, status: "ACKED" }]);
      expect(f.harness.cp.tasks.ready(runId)).toHaveLength(1);
      expect(owner.results).toEqual([]);
      expect(resultState(f, runId)).toEqual({ state: RunState.ACTIVE, candidate: null, attempts: [] });
      await f.harness.cp.outbox.wakeInBandPending();
      await ticks(50);
      expect(f.finishedTurns(ownerSessionId)).toBe(2);

      const daemon = await startDaemon(f, "stall");
      try {
        await vi.waitFor(() => expect(f.harness.cp.runs.require(runId).state).toBe(RunState.READY_FOR_CEO_REVIEW), {
          timeout: 10_000,
          interval: 25,
        });
        // Several more watchdog ticks: nothing wakes the owner again.
        await ticks(400);
      } finally {
        await daemon.stop();
      }
      expect(f.finishedTurns(ownerSessionId)).toBe(3);
      expect(resultWakes(f, runId)).toBe(1);
      const woken = owner.prompts.at(-1)!;
      expect(woken).toContain(`result recovery: run ${runId} has a PLAN and no result`);
      expect(woken).toContain("mcp__acp-cto__result_submit");
      // The owner's result_submit alone reached the pipeline's review; its task is still READY and unexecuted.
      expect(owner.results).toEqual([{ runId, ok: true, stage: "COMPLETED_REVIEW" }]);
      expect(reviews.asked()).toBe(1);
      expect(f.harness.cp.artifacts.latest(runId, ArtifactKind.BLIND_REVIEW)).not.toBeNull();
      expect(f.harness.cp.tasks.ready(runId)).toHaveLength(1);
      expect(executions(f, runId)).toBe(0);
      expectNoGatePassed(f, runId, ownerSessionId, client, writePort);
    }, { githubClient: client, repoFactory: { workRoot: tempDir("acp-brstall-factory-"), githubPort: writePort } });
  });

  it("the live shape: after a restart the gen2 RUN_DISPATCH turn gets its PLAN accepted and acknowledges with no result; the daemon wakes that owner once and the run reaches READY_FOR_CEO_REVIEW", async () => {
    await withBootstrapRuntime(async (f) => {
      passBootstrapPlanReviews(f);
      // Generation 1 acknowledged its RUN_DISPATCH and planned nothing, as before #1113.
      const owner = scriptBootstrapOwner(f, { onDispatch: "ack-only", onResult: "recovery-only" });
      const { runId, ownerSessionId, roleKey } = await f.dispatchBootstrap();
      await f.awaitFinishedTurns(ownerSessionId, 2);
      await vi.waitFor(() => expect(f.harness.cp.sessionRuntime.turnInProgress(ownerSessionId)).toBe(false));
      // The restart loses the credential; continuity recovers the same session at generation 2 and
      // dispatches again. That turn plans (#1113's directive), acknowledges, and submits no result.
      owner.onDispatch = "follow-prompt";
      f.harness.cp.sessionRuntime.release(ownerSessionId);
      await f.daemon.reconcileContinuity("first tick after a restart");
      await f.daemon.reconcileContinuity("recovery tick");
      expect(f.harness.cp.bindings.active(roleKey)).toMatchObject({ bindingGeneration: 2, sessionId: ownerSessionId });
      await vi.waitFor(() => expect(runDispatches(f, runId)).toEqual([
        { generation: 1, status: "ACKED" },
        { generation: 2, status: "ACKED" },
      ]));
      await vi.waitFor(() => expect(f.harness.cp.sessionRuntime.turnInProgress(ownerSessionId)).toBe(false));
      expect(owner.submissions.at(-1)).toMatchObject({ ok: true });
      expect(f.harness.cp.tasks.ready(runId)).toHaveLength(1);
      expect(resultState(f, runId)).toEqual({ state: RunState.ACTIVE, candidate: null, attempts: [] });
      const turnsBefore = f.finishedTurns(ownerSessionId);

      const daemon = await startDaemon(f, "live");
      try {
        await vi.waitFor(() => expect(f.harness.cp.runs.require(runId).state).toBe(RunState.READY_FOR_CEO_REVIEW), {
          timeout: 10_000,
          interval: 25,
        });
        await ticks(400);
      } finally {
        await daemon.stop();
      }
      expect(f.finishedTurns(ownerSessionId)).toBe(turnsBefore + 1);
      expect(resultWakes(f, runId)).toBe(1);
      expect(f.harness.cp.audit.byKind(RESULT_WAKE).filter((row) => row.runId === runId).map((row) => row.evidence["bindingGeneration"]))
        .toEqual([2]);
      expect(owner.results).toEqual([{ runId, ok: true, stage: "COMPLETED_REVIEW" }]);
      expect(f.harness.cp.runs.require(runId).ownerBindingGeneration).toBe(2);
    });
  });

  it("an owner following the prompt on a fresh RUN_DISPATCH plans and submits the result in that one turn; the run reaches READY_FOR_CEO_REVIEW and nothing wakes it again", async () => {
    const client = new FakeGitHubClient();
    const writePort = new FakeGitHubWritePort(tempDir("acp-brfresh-github-"));
    await withBootstrapRuntime(async (f) => {
      const reviews = passBootstrapPlanReviews(f);
      const owner = scriptBootstrapOwner(f, { onDispatch: "follow-prompt", onResult: "follow-prompt" });
      const { runId, ownerSessionId } = await f.dispatchBootstrap();
      await f.awaitFinishedTurns(ownerSessionId, 2);
      expect(f.harness.cp.runs.require(runId).state).toBe(RunState.READY_FOR_CEO_REVIEW);
      expect(owner.submissions.at(-1)).toMatchObject({ ok: true });
      expect(owner.results).toEqual([{ runId, ok: true, stage: "COMPLETED_REVIEW" }]);
      expect(runDispatches(f, runId)).toEqual([{ generation: 1, status: "ACKED" }]);
      expect(owner.prompts[0]).toContain(RESULT_DIRECTIVE);
      expect(reviews.asked()).toBe(1);
      expect(f.harness.cp.tasks.ready(runId)).toHaveLength(1);
      expect(executions(f, runId)).toBe(0);

      const daemon = await startDaemon(f, "fresh");
      try {
        await ticks(400);
      } finally {
        await daemon.stop();
      }
      expect(f.finishedTurns(ownerSessionId)).toBe(2);
      expect(resultWakes(f, runId)).toBe(0);
      expect(owner.results).toHaveLength(1);
      expectNoGatePassed(f, runId, ownerSessionId, client, writePort);
    }, { githubClient: client, repoFactory: { workRoot: tempDir("acp-brfresh-factory-"), githubPort: writePort } });
  });
});

describe("FINAL_REVISE reaches a driven bootstrap owner (CEO 1792120860, condition 5)", () => {
  it("the owner reads the CEO's reason, replans from it, and after the CEO dispatches again submits the new PLAN's result; the run is at CEO review again and the superseded task is CANCELLED", async () => {
    await withBootstrapRuntime(async (f) => {
      passBootstrapPlanReviews(f);
      const owner = scriptBootstrapOwner(f, { onDispatch: "follow-prompt" });
      const { runId, ownerSessionId } = await f.dispatchBootstrap();
      await vi.waitFor(() => expect(f.harness.cp.runs.require(runId).state).toBe(RunState.READY_FOR_CEO_REVIEW), {
        timeout: 10_000,
        interval: 25,
      });
      await vi.waitFor(() => expect(f.harness.cp.sessionRuntime.turnInProgress(ownerSessionId)).toBe(false));
      const firstPlan = f.harness.cp.artifacts.latest(runId, ArtifactKind.PLAN)!.digest;
      const [firstTask] = f.harness.cp.tasks.list(runId);

      const rationale = "raise the clean-tree limits: set timeoutSeconds to 1200 and maxMemoryMb to 4096";
      const revised = await f.hermes("ceo_decision_submit", {
        runId,
        decision: "FINAL_REVISE",
        candidateSnapshotDigest: f.harness.cp.runs.currentCandidate(runId),
        ceoSessionId: f.ceoSessionId,
        rationale,
      });
      expect(revised, JSON.stringify(revised)).toMatchObject({ ok: true, value: { state: RunState.REVISION_REQUIRED } });
      // The owner is told why, in band, and plans again from that reason.
      await vi.waitFor(() => expect(owner.revisions).toEqual([{ runId, reason: rationale }]), { timeout: 10_000, interval: 25 });
      await vi.waitFor(() => expect(f.harness.cp.artifacts.latest(runId, ArtifactKind.PLAN)!.digest).not.toBe(firstPlan));
      await vi.waitFor(() => expect(f.harness.cp.sessionRuntime.turnInProgress(ownerSessionId)).toBe(false));
      const revisedPlan = f.harness.cp.artifacts.latest<Record<string, unknown>>(runId, ArtifactKind.PLAN)!;
      const commands = (revisedPlan.content["projectManifest"] as { verificationCommands: Array<Record<string, unknown>> }).verificationCommands;
      expect(commands.length).toBeGreaterThan(0);
      for (const command of commands) expect(command).toMatchObject({ timeoutSeconds: 1200, maxMemoryMb: 4096 });

      // The CEO dispatches the revised run again; the owner submits the new PLAN's result in that turn.
      const redispatched = await f.hermes("run_dispatch", { runId });
      expect(redispatched, JSON.stringify(redispatched)).toMatchObject({ ok: true });
      await vi.waitFor(() => expect(f.harness.cp.runs.require(runId).state).toBe(RunState.READY_FOR_CEO_REVIEW), {
        timeout: 10_000,
        interval: 25,
      });
      await vi.waitFor(() => expect(f.harness.cp.sessionRuntime.turnInProgress(ownerSessionId)).toBe(false));
      expect(owner.results).toEqual([
        { runId, ok: true, stage: "COMPLETED_REVIEW" },
        { runId, ok: true, stage: "COMPLETED_REVIEW" },
      ]);
      const tasks = f.harness.cp.tasks.list(runId);
      expect(tasks.map((task) => [task.taskId === firstTask!.taskId, task.state])).toEqual([[true, "CANCELLED"], [false, "READY"]]);
      expect(f.harness.cp.audit.all().filter((row) => row.kind === "BOOTSTRAP_TASKS_SUPERSEDED" && row.runId === runId)
        .map((row) => row.evidence["reason"])).toEqual([`superseded by PLAN ${revisedPlan.digest}`]);
      expect(executions(f, runId)).toBe(0);
    });
  });
});
