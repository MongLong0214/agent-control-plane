import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, describe, expect, it, vi } from "vitest";

import { allow, type Decision } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Daemon } from "../../src/daemon/daemon.ts";
import { ExecutionMode, type RunRow } from "../../src/domain/types.ts";
import { createCtoMcpPort, createCtoServer } from "../../src/mcp/cto-server.ts";
import { REPLAYED_ATTEMPT_ERRORED, REPLAYED_ATTEMPT_RELEASED, type PipelineOutcome } from "../../src/run/candidate-pipeline.ts";
import type { TaskContract } from "../../src/run/run-engine.ts";
import type { InvocationRequest, InvocationResult } from "../../src/runtime/provider.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import {
  type Harness,
  applyFailingChange,
  applyPassingChange,
  bindCeo,
  bindWorker,
  makeHarness,
  registerFixtureProject,
  reviewerRevise,
} from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * #1344 B — a result_submit replay of the same key and request gets a definite answer from durable state when the
 * key's response was never stored (its daemon ended first, or the call threw): the attempt's applied outcome, which is
 * recorded in the transaction that applies it; that it was released with nothing applied; or that it ended on an error
 * with nothing applied. A replay never freezes, verifies or reviews again, and the same key naming a different request
 * is a conflict.
 */

const CONTRACT: TaskContract = {
  goal: "make app() return 2",
  why: "downstream callers expect 2",
  scope: ["src/app.js"],
  nonGoals: [],
  acceptance: ["verify.js exits 0"],
  priority: "NORMAL",
  humanGate: [],
  references: [],
};

const prepare = async (change: (repoPath: string) => string = applyPassingChange) => {
  const h = makeHarness();
  const { projectId, repositoryId, identity } = await registerFixtureProject(h, "fixture-project");
  bindCeo(h);
  const created = h.cp.runs.create({
    projectId,
    executionMode: ExecutionMode.STANDARD,
    contract: CONTRACT,
    repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
  });
  if (!created.allowed) throw new Error(created.message);
  const dispatched = await h.cp.runs.dispatch(created.value.runId);
  if (!dispatched.allowed) throw new Error(dispatched.message);
  const run = dispatched.value;
  h.cp.tasks.submit(run.runId, [{ key: "impl", title: "change app()", category: "implementation" }]);
  const task = h.cp.tasks.ready(run.runId)[0]!;
  const execution = h.cp.tasks.startExecution({
    runId: run.runId,
    taskId: task.taskId,
    ownerBindingGeneration: run.ownerBindingGeneration!,
    workerSessionId: bindWorker(h, task.taskId),
    provider: "scripted",
    model: "scripted-worker",
    repositoryId,
  });
  if (!execution.allowed) throw new Error(execution.message);
  const head = change(h.repoPath);
  h.cp.tasks.finishExecution(execution.value.executionId, { status: "SUCCEEDED", resultDigest: `sha256:${head}` });
  return { h, run, covered: `${identity}:src/app.js` };
};

/** One MCP connection as the run's owning CTO session. */
const connect = async (h: Harness, run: RunRow) => {
  const sessionId = run.ownerSessionId!;
  const incarnation = h.cp.sessions.require(sessionId).incarnation;
  const held = h.cp.bindings.bySession(sessionId).filter((binding) => binding.status === "ACTIVE");
  const server = createCtoServer(createCtoMcpPort(h.cp), () => allow(ReasonCode.OK, {
    actor: `cto:${sessionId}`, sessionId, sessionIncarnation: incarnation,
    binding: { roleKey: held[0]!.roleKey, bindingGeneration: held[0]!.bindingGeneration },
  }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "result-submit-replay", version: "1" });
  await client.connect(clientTransport);
  const submit = async (idempotencyKey: string, resultSummary = "app() now returns 2") =>
    (await client.callTool({
      name: "result_submit",
      arguments: { idempotencyKey, runId: run.runId, resultSummary, recommendation: "merge" },
    })).structuredContent as Record<string, unknown>;
  const close = async (): Promise<void> => {
    await client.close();
    await server.close();
  };
  return { submit, close };
};

/** The daemon ends between the attempt's applied outcome and its own end: its release, the receipt after it, the response. */
const endsBeforeItsAttempt = (h: Harness): void => {
  vi.spyOn(h.cp.pipeline as unknown as { endAttempt: () => void }, "endAttempt").mockImplementationOnce(() => {
    throw new Error("the daemon stopped after the outcome was applied");
  });
};

const restartReconcile = (h: Harness) => new Daemon(h.cp, { stateDir: tempDir("acp-1344b-restart-") }).reconcile();

const count = (h: Harness, runId: string, kind: string): number =>
  h.cp.audit.forRun(runId).filter((row) => row.kind === kind).length;
const attemptRow = (h: Harness, runId: string) =>
  h.cp.db.get<{ attempt_id: string; state: string }>(
    "SELECT attempt_id, state FROM candidate_pipeline_attempts WHERE run_id = ?", [runId])!;
/** What a replay must not add: an attempt, a freeze, a verification or a review. */
const footprint = (h: Harness, runId: string) => ({
  attempt: attemptRow(h, runId).attempt_id,
  frozen: count(h, runId, "CANDIDATE_FROZEN"),
  verified: count(h, runId, "VERIFICATION_COMPLETED"),
  reviewed: count(h, runId, "BLIND_REVIEW_COMPLETED"),
  reviewerCalls: h.scripted.invocations.length,
});

describe("#1344 B: a same-key result_submit replay is answered from durable state", () => {
  it("a completed submission whose response was never stored answers its recorded outcome after a restart, and runs nothing again", async () => {
    const { h, run, covered } = await prepare();
    h.scripted.script({ match: /Candidate review/, text: reviewerRevise([covered], "a finding") });
    // The pipeline completes; its daemon ends before the response is stored.
    const real = h.cp.pipeline.submitResult.bind(h.cp.pipeline);
    let completed!: Decision<PipelineOutcome>;
    vi.spyOn(h.cp.pipeline, "submitResult").mockImplementationOnce(async (input) => {
      completed = await real(input);
      throw new Error("the daemon stopped before the response was stored");
    });
    const before = await connect(h, run);
    expect(await before.submit("completed-before-the-restart")).toMatchObject({ ok: false, reasonCode: ReasonCode.INTERNAL_ERROR });
    await before.close();
    if (!completed.allowed || completed.value.stage !== "REVISION_REQUIRED") throw new Error(JSON.stringify(completed).slice(0, 400));
    const attemptId = attemptRow(h, run.runId).attempt_id;
    h.cp.close();

    // A new control plane on the same database: nothing of the first one's memory.
    const restarted = makeHarness({ root: h.root, repoPath: h.repoPath, clock: h.clock });
    const submit = vi.spyOn(restarted.cp.pipeline, "submitResult");
    const after = await connect(restarted, run);
    try {
      const was = footprint(restarted, run.runId);
      expect(await after.submit("completed-before-the-restart")).toMatchObject({
        ok: true,
        value: {
          stage: "REVISION_REQUIRED",
          reasonCode: completed.value.reasonCode,
          snapshotDigest: completed.value.snapshotDigest,
          attemptId,
        },
      });
      expect(submit).not.toHaveBeenCalled();
      expect(footprint(restarted, run.runId)).toEqual(was);

      // The same key naming a different request is a conflict, and runs nothing either.
      expect(await after.submit("completed-before-the-restart", "a different summary")).toMatchObject({ ok: false, reasonCode: ReasonCode.CONFLICT });
      expect(submit).not.toHaveBeenCalled();
      expect(footprint(restarted, run.runId)).toEqual(was);
    } finally {
      await after.close();
      restarted.cp.close();
    }
  });

  it("a submission whose attempt the restart released answers released with its attempt id, and a fresh key is admitted", async () => {
    const { h, run, covered } = await prepare();
    // A submission is mid-review when its daemon goes: its process, and that review, end with it.
    let entered!: () => void;
    const reviewing = new Promise<void>((resolve) => { entered = resolve; });
    h.scripted.invoke = async (_request: InvocationRequest): Promise<InvocationResult> => {
      entered();
      return new Promise<never>(() => undefined);
    };
    const during = await connect(h, run);
    void during.submit("running-at-the-restart").catch(() => undefined);
    await reviewing;
    await during.close();
    const interrupted = attemptRow(h, run.runId).attempt_id;
    h.cp.close();

    const restarted = makeHarness({ root: h.root, repoPath: h.repoPath, clock: h.clock });
    // The restart's reconcile releases the attempt its predecessor left RUNNING (#1356).
    await restartReconcile(restarted);
    expect(attemptRow(restarted, run.runId)).toEqual({ attempt_id: interrupted, state: "RELEASED" });
    const submit = vi.spyOn(restarted.cp.pipeline, "submitResult");
    const after = await connect(restarted, run);
    try {
      const was = footprint(restarted, run.runId);
      const released = { ok: false, reasonCode: ReasonCode.CANDIDATE_PIPELINE_ATTEMPT_STALE, message: REPLAYED_ATTEMPT_RELEASED,
        evidence: { runId: run.runId, attemptId: interrupted } };
      expect(await after.submit("running-at-the-restart")).toMatchObject(released);
      expect(submit).not.toHaveBeenCalled();
      expect(footprint(restarted, run.runId)).toEqual(was);

      // A fresh key is admitted at once, and the released key's answer does not move with the run's next attempt.
      restarted.scripted.script({ match: /Candidate review/, text: reviewerRevise([covered], "a finding") });
      expect(await after.submit("a-fresh-key")).toMatchObject({ ok: true, value: { stage: "REVISION_REQUIRED" } });
      expect(submit).toHaveBeenCalledTimes(1);
      expect(attemptRow(restarted, run.runId).attempt_id).not.toBe(interrupted);
      expect(await after.submit("running-at-the-restart")).toMatchObject(released);
      expect(submit).toHaveBeenCalledTimes(1);
    } finally {
      await after.close();
      restarted.cp.close();
    }
  });

  it("an outcome applied just before the daemon ended replays as that outcome after the restart's release, never as not applied", async () => {
    const { h, run } = await prepare(applyFailingChange);
    endsBeforeItsAttempt(h);
    const before = await connect(h, run);
    expect(await before.submit("failed-verification-at-the-boundary")).toMatchObject({ ok: false, reasonCode: ReasonCode.INTERNAL_ERROR });
    await before.close();
    // Its outcome is applied: the run went back to its CTO. The attempt is still RUNNING: its daemon ended first.
    const returned = h.cp.audit.forRun(run.runId).filter((row) => row.kind === "REVISION_RETURNED_TO_CTO");
    expect(returned).toHaveLength(1);
    const applied = returned[0]!;
    const attemptId = attemptRow(h, run.runId).attempt_id;
    expect(attemptRow(h, run.runId).state).toBe("RUNNING");
    h.cp.close();

    const restarted = makeHarness({ root: h.root, repoPath: h.repoPath, clock: h.clock });
    await restartReconcile(restarted);
    expect(attemptRow(restarted, run.runId)).toEqual({ attempt_id: attemptId, state: "RELEASED" });
    const submit = vi.spyOn(restarted.cp.pipeline, "submitResult");
    const after = await connect(restarted, run);
    try {
      const was = footprint(restarted, run.runId);
      expect(await after.submit("failed-verification-at-the-boundary")).toMatchObject({
        ok: true,
        value: { stage: "VERIFICATION_FAILED", reasonCode: applied.reasonCode, snapshotDigest: applied.evidence["candidateSnapshotDigest"], attemptId },
      });
      expect(submit).not.toHaveBeenCalled();
      expect(footprint(restarted, run.runId)).toEqual(was);
      expect(count(restarted, run.runId, "REVISION_RETURNED_TO_CTO")).toBe(1);
    } finally {
      await after.close();
      restarted.cp.close();
    }
  });

  it("an attempt that throws before any outcome is applied replays as ended with an error, before and after a restart; a fresh key is admitted", async () => {
    const { h, run, covered } = await prepare();
    vi.spyOn(h.cp.pipeline, "freeze").mockRejectedValueOnce(new Error("injected after acquisition"));
    const first = await connect(h, run);
    const errored = { ok: false, reasonCode: ReasonCode.INTERNAL_ERROR, message: REPLAYED_ATTEMPT_ERRORED };
    let attemptId: string;
    try {
      expect(await first.submit("throws-after-acquisition")).toMatchObject({ ok: false, reasonCode: ReasonCode.INTERNAL_ERROR });
      attemptId = attemptRow(h, run.runId).attempt_id;
      expect(attemptRow(h, run.runId).state).toBe("RELEASED");
      expect(await first.submit("throws-after-acquisition")).toMatchObject({ ...errored, evidence: { runId: run.runId, attemptId } });
    } finally {
      await first.close();
    }
    h.cp.close();

    const restarted = makeHarness({ root: h.root, repoPath: h.repoPath, clock: h.clock });
    await restartReconcile(restarted);
    const submit = vi.spyOn(restarted.cp.pipeline, "submitResult");
    const after = await connect(restarted, run);
    try {
      const was = footprint(restarted, run.runId);
      expect(await after.submit("throws-after-acquisition")).toMatchObject({ ...errored, evidence: { runId: run.runId, attemptId } });
      expect(submit).not.toHaveBeenCalled();
      expect(footprint(restarted, run.runId)).toEqual(was);
      restarted.scripted.script({ match: /Candidate review/, text: reviewerRevise([covered], "a finding") });
      expect(await after.submit("a-fresh-key")).toMatchObject({ ok: true, value: { stage: "REVISION_REQUIRED" } });
    } finally {
      await after.close();
      restarted.cp.close();
    }
  });

  it("an attempt that throws after its outcome was applied replays as that outcome, not as ended with an error", async () => {
    const { h, run, covered } = await prepare();
    h.scripted.script({ match: /Candidate review/, text: reviewerRevise([covered], "a finding") });
    // The revision is applied; the read after it throws.
    vi.spyOn(h.cp.review, "latestPacket").mockImplementationOnce(() => { throw new Error("injected after the outcome"); });
    const cto = await connect(h, run);
    try {
      expect(await cto.submit("throws-after-the-outcome")).toMatchObject({ ok: false, reasonCode: ReasonCode.INTERNAL_ERROR });
      const applied = h.cp.audit.forRun(run.runId).filter((row) => row.kind === "REVISION_RETURNED_TO_CTO");
      expect(applied).toHaveLength(1);
      expect(await cto.submit("throws-after-the-outcome")).toMatchObject({
        ok: true,
        value: { stage: "REVISION_REQUIRED", reasonCode: ReasonCode.REVIEW_REVISE, snapshotDigest: applied[0]!.evidence["candidateSnapshotDigest"] },
      });
    } finally {
      await cto.close();
      h.cp.close();
    }
  });
});
