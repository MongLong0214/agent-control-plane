import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { bootstrapActivationHandoff, currentBootstrapPlan } from "../../src/bootstrap/bootstrap-plan.ts";
import { digestOf } from "../../src/core/digest.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import type { ProjectManifest } from "../../src/contracts/manifest.ts";
import { startLocalMcpListeners, startSessionLaunchChannel } from "../../src/daemon/agentcpd.ts";
import { ExecutionMode, Role, RunKind, RunState, SessionLifecycle } from "../../src/domain/types.ts";
import type { TaskContract } from "../../src/run/run-engine.ts";
import type { CapacityReading, InvocationRequest, InvocationResult } from "../../src/runtime/provider.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { makeHarness, reviewerPass, type Harness } from "../helpers/harness.ts";
import { bootstrapCoverageKeys, bootstrapPlan, cleanTreeManifest } from "../helpers/bootstrap-plan.ts";
import { callMcpToolOverSocket } from "../helpers/mcp-socket.ts";
import { HeadlessRuntimeDouble } from "../helpers/headless-runtime.ts";

afterAll(cleanupTempDirs);
afterEach(() => vi.restoreAllMocks());

/**
 * Issue #246 PR-C, review round 1 (RF-REVIEW-02) — a PLAN replaced while its review is in flight
 * gets no ready packet.
 *
 * The review gate loaded the PLAN binding, awaited the reviewer, and stored its verdict without
 * loading it again; the project-less pipeline published the packet without asking whether the PLAN
 * was still the one the candidate names; and the production gate compared the review's binding with
 * the frozen candidate's only — both still P1. So a PASS for P1 that arrived after P2 was submitted
 * produced a packet and READY_FOR_CEO_REVIEW for a PLAN the run no longer has.
 *
 * Every state change goes through a real door: run_create, run_dispatch over `hermes.mcp.sock` as the
 * CEO; plan_submit, task_worker_provision, task_receipt_submit and result_submit over `cto.mcp.sock`
 * as the run's bootstrap CTO, with the credential its launch channel issued. The reviewer is the
 * harness's scripted one, constituted by the review gate itself; the test only decides *when* it
 * answers. No review is written and no run state is moved by the test.
 */
const TOKEN = "bootstrap-plan-replaced-token";

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

const claudeReading = (harness: Harness, remainingPercent: number, minutesAgo = 0): CapacityReading => {
  const now = harness.clock.now().getTime();
  return {
    provider: "claude",
    sensorHealth: "HEALTHY",
    runtimeHealth: "HEALTHY",
    observedAt: new Date(now - minutesAgo * 60_000).toISOString(),
    source: "bootstrap-plan-replaced-fixture",
    buckets: [{
      id: "five_hour",
      remainingPercent,
      resetAt: new Date(now + 2 * 60 * 60_000).toISOString(),
      capabilities: ["ceo", "cto", "blind-review", "worker"],
    }],
  };
};

const fixture = async () => {
  const harness = makeHarness();
  const launch = await startSessionLaunchChannel(tempDir("acp-rf02-launch-"), { mcpToken: TOKEN });
  harness.cp.cto.attach({ sessionLaunch: launch });
  const claude = new HeadlessRuntimeDouble(harness.clock, "claude");
  harness.cp.providers.registerForRole(claude, Role.BOOTSTRAP_CTO);
  harness.cp.providers.registerForRole(claude, Role.WORKER);
  claude.setCapacity(claudeReading(harness, 81, 3));
  await harness.cp.capacity.refreshForRole("claude", Role.WORKER);
  claude.setCapacity(claudeReading(harness, 80));

  const ceo = harness.cp.sessions.create({ provider: "scripted", model: "rf02-ceo" });
  const ceoSecret = ceo.sessionSecret;
  if (!ceoSecret) throw new Error("the CEO session has no secret");
  harness.cp.sessions.transition(ceo.sessionId, SessionLifecycle.READY, "fixture CEO");
  const boundCeo = harness.cp.bindings.bind({ role: Role.CEO, sessionId: ceo.sessionId });
  if (!boundCeo.allowed) throw new Error(boundCeo.message);

  const listeners = await startLocalMcpListeners(harness.cp, tempDir("acp-rf02-mcp-"), TOKEN);
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
      idempotencyKey: `rf02-${++keys}`,
      ...args,
    });
  // C1b: the credential is the one the session's runtime took from the launch channel during its
  // attestation turn; a row acts as that runtime by presenting it, as the runtime's relay would.
  const cto = async (sessionId: string, name: string, args: Record<string, unknown>) => {
    const credential = claude.credentials.get(sessionId);
    if (!credential) throw new Error("the session's runtime never took its credential");
    return callMcpToolOverSocket(
      ctoSocket,
      { token: TOKEN, sessionId: credential.sessionId, sessionSecret: credential.sessionSecret },
      name,
      { idempotencyKey: `rf02-${++keys}`, ...args },
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

type Fixture = Awaited<ReturnType<typeof fixture>>;

const withFixture = async (body: (f: Fixture) => Promise<void>): Promise<void> => {
  const f = await fixture();
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

const dispatchedBootstrap = async (f: Fixture): Promise<BootstrapRun> => {
  const created = await f.hermes("run_create", { kind: RunKind.PROJECT_BOOTSTRAP, executionMode: ExecutionMode.STANDARD, contract: CONTRACT });
  if (created["ok"] !== true) throw new Error(`run_create refused: ${JSON.stringify(created)}`);
  const runId = (created["value"] as { runId: string }).runId;
  const dispatched = await f.hermes("run_dispatch", { runId });
  if (dispatched["ok"] !== true) throw new Error(`run_dispatch refused: ${JSON.stringify(dispatched)}`);
  return { runId, owner: f.harness.cp.runs.require(runId).ownerSessionId! };
};

const submitPlan = async (f: Fixture, run: BootstrapRun, manifest: ProjectManifest, taskKey: string): Promise<void> => {
  const submitted = await f.cto(run.owner, "plan_submit", {
    runId: run.runId,
    plan: bootstrapPlan(manifest),
    tasks: [{ key: taskKey, title: taskKey, category: "implementation" }],
  });
  expect(submitted, JSON.stringify(submitted)).toMatchObject({ ok: true });
};

/** Every READY task staffed with its own Claude Opus worker and carried to SUCCEEDED, over the CTO socket. */
const workReadyTasks = async (f: Fixture, run: BootstrapRun): Promise<void> => {
  for (const task of f.harness.cp.tasks.ready(run.runId)) {
    const provisioned = await f.cto(run.owner, "task_worker_provision", { runId: run.runId, taskId: task.taskId, provider: "claude" });
    expect(provisioned, JSON.stringify(provisioned)).toMatchObject({ ok: true });
    const workerSessionId = (provisioned["value"] as { workerSessionId: string }).workerSessionId;
    const started = await f.cto(run.owner, "task_receipt_submit", { runId: run.runId, taskId: task.taskId, phase: "started", workerSessionId });
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

/** Scripts a PASS naming exactly the coverage of the run's PLAN as it is now. */
const scriptPassForCurrentPlan = (f: Fixture, run: BootstrapRun): void => {
  f.harness.scripted.script({ match: /Bootstrap plan review/, text: reviewerPass(bootstrapCoverageKeys(f.harness, run.runId)) });
};

const resultSubmit = (f: Fixture, run: BootstrapRun) =>
  f.cto(run.owner, "result_submit", {
    runId: run.runId,
    resultSummary: "the planned bootstrap outputs",
    recommendation: "create the repository",
  });

const reviewPrompts = (f: Fixture): string[] =>
  f.harness.scripted.invocations.filter((invocation) => invocation.prompt.startsWith("# Bootstrap plan review")).map((i) => i.prompt);

/**
 * Holds the next bootstrap-plan reviewer invocation until `release` is called. The reviewer's answer
 * is the one scripted before; only its timing is the test's.
 */
const holdNextBootstrapReview = (harness: Harness): {
  entered: Promise<void>;
  release: () => void;
  /** 1073-N1-01 — the held invocation and what the reviewer answered it, once it has. */
  answered: Promise<{ request: InvocationRequest; result: InvocationResult }>;
} => {
  const scripted = harness.scripted;
  const original = scripted.invoke.bind(scripted);
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let answer!: (answered: { request: InvocationRequest; result: InvocationResult }) => void;
  const answered = new Promise<{ request: InvocationRequest; result: InvocationResult }>((resolve) => {
    answer = resolve;
  });
  let held = false;
  vi.spyOn(scripted, "invoke").mockImplementation(async (request: InvocationRequest) => {
    if (!held && /Bootstrap plan review/.test(request.prompt)) {
      held = true;
      enter();
      await released;
      const result = await original(request);
      answer({ request, result });
      return result;
    }
    return original(request);
  });
  return { entered, release, answered };
};

const packets = (f: Fixture, run: BootstrapRun) => f.harness.cp.artifacts.list(run.runId, "PRODUCTION_READY_PACKET");

describe("RF-REVIEW-02: a PLAN replaced while it is judged gets no ready packet", () => {
  it("P2 submitted while P1's reviewer is pending: P1's PASS is stale, nothing is published, and only a review of P2 makes the run ready", async () => {
    await withFixture(async (f) => {
      const run = await dispatchedBootstrap(f);
      const m1 = cleanTreeManifest("rf02-inflight-first");
      const m2 = cleanTreeManifest("rf02-inflight-second");
      await submitPlan(f, run, m1, "plan-1");
      await workReadyTasks(f, run);
      // 1073-N1-01 — P1's PLAN binding, read before anything can replace it.
      const p1 = currentBootstrapPlan(run.runId, f.harness.cp.artifacts.latest(run.runId, "PLAN"));
      if (!p1.allowed) throw new Error(p1.message);
      await f.harness.cp.continuity.evaluate("before result_submit");
      scriptPassForCurrentPlan(f, run);

      const held = holdNextBootstrapReview(f.harness);
      // 1073-N1-01 — what the review gate answers the pipeline, in order: P1's review first.
      const gate = f.harness.cp.review;
      const reviewThroughGate = gate.review.bind(gate);
      const gateAnswers: Array<Awaited<ReturnType<typeof gate.review>>> = [];
      vi.spyOn(gate, "review").mockImplementation(async (request, capability) => {
        const answer = await reviewThroughGate(request, capability);
        gateAnswers.push(answer);
        return answer;
      });
      const pending = resultSubmit(f, run);
      await held.entered;
      const s1 = f.harness.cp.runs.currentCandidate(run.runId);
      expect(s1).not.toBeNull();

      // While P1's reviewer works, the bootstrap CTO submits P2 through plan_submit and its task is done.
      await submitPlan(f, run, m2, "plan-2");
      await workReadyTasks(f, run);
      const p2 = currentBootstrapPlan(run.runId, f.harness.cp.artifacts.latest(run.runId, "PLAN"));
      if (!p2.allowed) throw new Error(p2.message);

      // P1's reviewer answers PASS.
      held.release();
      const submitted = await pending;
      expect(submitted, JSON.stringify(submitted)).toMatchObject({
        ok: true,
        value: { stage: "CANDIDATE_STALE", reasonCode: ReasonCode.EVIDENCE_STALE, snapshotDigest: s1 },
      });
      expect(f.harness.cp.runs.require(run.runId).state).toBe(RunState.ACTIVE);
      expect(packets(f, run)).toEqual([]);
      // The review gate kept no verdict for a PLAN the run no longer has.
      expect(f.harness.cp.artifacts.list(run.runId, "BLIND_REVIEW")).toEqual([]);
      // 1073-N1-01 — the assertions above also hold if P1's reviewer gave no verdict at all. It did:
      // asked about P1's plan, it answered PASS, and the gate refused that PASS because P2 had
      // replaced P1, not for an assurance failure (that returns before the PLAN is read again).
      const p1Review = await held.answered;
      expect(p1Review.request.prompt).toContain(`Plan digest: ${p1.value.binding.planDigest}`);
      expect(p1Review.result.ok).toBe(true);
      expect(JSON.parse(p1Review.result.text)).toMatchObject({ verdict: "PASS" });
      expect(gateAnswers[0]).toMatchObject({
        allowed: false,
        reasonCode: ReasonCode.EVIDENCE_STALE,
        evidence: { candidate: p1.value.binding, current: p2.value.binding },
      });

      // A fresh review of P2 is what makes the run ready: a new candidate, a new reviewer prompt
      // naming P2's planned outputs, and a packet for that candidate alone.
      const promptsBefore = reviewPrompts(f).length;
      await f.harness.cp.continuity.evaluate("before result_submit");
      scriptPassForCurrentPlan(f, run);
      const second = await resultSubmit(f, run);
      expect(second, JSON.stringify(second)).toMatchObject({ ok: true, value: { stage: "COMPLETED_REVIEW" } });
      const s2 = (second["value"] as { snapshotDigest: string }).snapshotDigest;
      expect(s2).not.toBe(s1);
      expect(reviewPrompts(f)).toHaveLength(promptsBefore + 1);
      expect(reviewPrompts(f).at(-1)).toContain(p2.value.binding.plannedOutputsDigest);
      expect(f.harness.cp.runs.require(run.runId).state).toBe(RunState.READY_FOR_CEO_REVIEW);
      expect(packets(f, run).map((packet) => packet.candidateSnapshotDigest)).toEqual([s2]);
      expect(f.harness.cp.bootstrap.readinessForFactoryResult(run.runId, bootstrapActivationHandoff(m2), s2)).toMatchObject({ allowed: true });
    });
  });

  it("P2 submitted after P1's PASS is stored but before its packet is published: nothing is published, and the production gate refuses P1's candidate", async () => {
    await withFixture(async (f) => {
      const run = await dispatchedBootstrap(f);
      const m1 = cleanTreeManifest("rf02-publication-first");
      const m2 = cleanTreeManifest("rf02-publication-second");
      await submitPlan(f, run, m1, "plan-1");
      await workReadyTasks(f, run);
      await f.harness.cp.continuity.evaluate("before result_submit");
      scriptPassForCurrentPlan(f, run);

      // The pipeline awaits continuity once more between the PASS and the packet. P2 arrives there.
      const continuity = f.harness.cp.continuity;
      const evaluate = continuity.evaluate.bind(continuity);
      let replaced = false;
      vi.spyOn(continuity, "evaluate").mockImplementation(async (reason: string) => {
        if (reason === "pre-completion" && !replaced) {
          replaced = true;
          await submitPlan(f, run, m2, "plan-2");
          await workReadyTasks(f, run);
        }
        return evaluate(reason);
      });

      const submitted = await resultSubmit(f, run);
      expect(replaced).toBe(true);
      const s1 = f.harness.cp.runs.currentCandidate(run.runId)!;
      expect(submitted, JSON.stringify(submitted)).toMatchObject({
        ok: true,
        value: { stage: "CANDIDATE_STALE", reasonCode: ReasonCode.EVIDENCE_STALE, snapshotDigest: s1 },
      });
      expect(f.harness.cp.runs.require(run.runId).state).toBe(RunState.ACTIVE);
      expect(packets(f, run)).toEqual([]);
      // P1's PASS was stored while P1 was still the PLAN; it is P1's, and it is on record.
      expect(f.harness.cp.artifacts.latestForSnapshot<{ verdict: string }>(run.runId, "BLIND_REVIEW", s1)?.content.verdict).toBe("PASS");

      // The production gate's own door, for that candidate: refused, with nothing written.
      vi.restoreAllMocks();
      await f.harness.cp.continuity.evaluate("packet");
      const runRow = f.harness.cp.runs.require(run.runId);
      const packet = f.harness.cp.ceo.buildPacket({
        runId: run.runId,
        candidateSnapshotDigest: s1,
        approval: {
          runId: run.runId,
          candidateSnapshotDigest: s1,
          resultSummary: "the planned bootstrap outputs",
          recommendation: "create the repository",
          residualRisk: [],
          approvedBySessionId: runRow.ownerSessionId!,
          approvedByGeneration: runRow.ownerBindingGeneration!,
          approvedAt: f.harness.clock.nowIso(),
        },
      });
      expect(packet).toMatchObject({ allowed: false, reasonCode: ReasonCode.EVIDENCE_STALE });
      expect(f.harness.cp.runs.require(run.runId).state).toBe(RunState.ACTIVE);
      expect(packets(f, run)).toEqual([]);
    });
  });

  it("P2 submitted during the continuity evaluation after P1's reviewer could not be constituted: no unavailable-review record for P1, the candidate is stale", async () => {
    await withFixture(async (f) => {
      const run = await dispatchedBootstrap(f);
      await submitPlan(f, run, cleanTreeManifest("rf02-unavailable-first"), "plan-1");
      await workReadyTasks(f, run);
      await f.harness.cp.continuity.evaluate("before result_submit");
      // The reviewer's runtime is down: the review gate returns no verdict, an assurance failure.
      f.harness.scripted.setRuntimeHealth("UNAVAILABLE");
      const continuity = f.harness.cp.continuity;
      const evaluate = continuity.evaluate.bind(continuity);
      let replaced = false;
      vi.spyOn(continuity, "evaluate").mockImplementation(async (reason: string) => {
        if (reason === "blind-review-unavailable" && !replaced) {
          replaced = true;
          f.harness.scripted.setRuntimeHealth("HEALTHY");
          await submitPlan(f, run, cleanTreeManifest("rf02-unavailable-second"), "plan-2");
          await workReadyTasks(f, run);
        }
        return evaluate(reason);
      });

      const submitted = await resultSubmit(f, run);
      expect(replaced).toBe(true);
      expect(submitted, JSON.stringify(submitted)).toMatchObject({
        ok: true,
        value: { stage: "CANDIDATE_STALE", reasonCode: ReasonCode.EVIDENCE_STALE },
      });
      expect(f.harness.cp.audit.forRun(run.runId).filter((row) => row.kind === "BLIND_REVIEW_UNAVAILABLE")).toEqual([]);
      expect(f.harness.cp.outbox.listByRun(run.runId).filter((message) => message.kind === "REVISION_REQUEST")).toEqual([]);
      expect(f.harness.cp.runs.require(run.runId).state).toBe(RunState.ACTIVE);
      expect(packets(f, run)).toEqual([]);
      // 1073-N1-01 — the assertions above also hold if P1's reviewer had answered REVISE or BLOCK,
      // which reaches the same continuity evaluation. It did not answer: no reviewer was asked, and
      // the review gate stored nothing.
      expect(reviewPrompts(f)).toEqual([]);
      expect(f.harness.cp.artifacts.list(run.runId, "BLIND_REVIEW")).toEqual([]);
    });
  });
});
