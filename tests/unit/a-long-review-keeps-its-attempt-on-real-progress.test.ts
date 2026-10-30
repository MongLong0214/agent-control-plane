import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, describe, expect, it, vi } from "vitest";

import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ArtifactKind, ExecutionMode, RunState, type RunRow } from "../../src/domain/types.ts";
import { createCtoMcpPort, createCtoServer } from "../../src/mcp/cto-server.ts";
import type { InvocationRequest, InvocationResult } from "../../src/runtime/provider.ts";
import type { TaskContract } from "../../src/run/run-engine.ts";
import { cleanupTempDirs, commitAll, writeFiles } from "../helpers/fixtures.ts";
import {
  type Harness,
  applyPassingChange,
  bindCeo,
  bindWorker,
  makeHarness,
  registerFixtureProject,
  reviewerPass,
  reviewerRevise,
} from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * A candidate submission's attempt lease is renewed on real progress only (a verification command, a
 * review chunk, the final review starting and ending), never past 120 minutes from acquisition, and a
 * stale attempt applies no outcome. Fake clock and a scripted reviewer: a reviewer's answer takes the
 * fake minutes the test gives it, and the watchdog's sweep runs as each answer comes back.
 */

const MINUTE = 60_000;

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

/** A change over the single-context budget, so its review is chunked. */
const large = (chars: number): string => `module.exports = () => 2;\n// ${"x".repeat(chars)}\n`;

const prepare = async (content?: string) => {
  const h = makeHarness();
  const { projectId, repositoryId, identity } = await registerFixtureProject(h);
  bindCeo(h);
  const created = h.cp.runs.create({
    projectId,
    executionMode: ExecutionMode.STANDARD,
    contract: CONTRACT,
    repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
  });
  if (!created.allowed) throw new Error(created.message);
  const runId = created.value.runId;
  const dispatched = await h.cp.runs.dispatch(runId);
  if (!dispatched.allowed) throw new Error(dispatched.message);
  const run = dispatched.value;
  h.cp.tasks.submit(runId, [{ key: "impl", title: "change app()", category: "implementation" }]);
  const task = h.cp.tasks.ready(runId)[0]!;
  const execution = h.cp.tasks.startExecution({
    runId,
    taskId: task.taskId,
    ownerBindingGeneration: run.ownerBindingGeneration!,
    workerSessionId: bindWorker(h, task.taskId),
    provider: "scripted",
    model: "scripted-worker",
    repositoryId,
  });
  if (!execution.allowed) throw new Error(execution.message);
  let head = applyPassingChange(h.repoPath);
  if (content !== undefined) {
    writeFiles(h.repoPath, { "src/app.js": content });
    head = commitAll(h.repoPath, "large reviewed change");
  }
  h.cp.tasks.finishExecution(execution.value.executionId, { status: "SUCCEEDED", resultDigest: `sha256:${head}` });
  return { h, run, runId, covered: `${identity}:src/app.js` };
};

const submission = (run: RunRow) => ({
  runId: run.runId,
  ownerSessionId: run.ownerSessionId!,
  ownerBindingGeneration: run.ownerBindingGeneration!,
  resultSummary: "app() now returns 2",
  recommendation: "merge",
});

/** Each reviewer answer takes `minutes(prompt)` of fake time; the watchdog sweeps as it comes back. */
const pace = (h: Harness, minutes: (prompt: string) => number): void => {
  const invoke = h.scripted.invoke.bind(h.scripted);
  h.scripted.invoke = async (request: InvocationRequest): Promise<InvocationResult> => {
    const answer = await invoke(request);
    h.clock.advance(minutes(request.prompt) * MINUTE);
    h.cp.pipeline.reclaimExpiredAttempts();
    return answer;
  };
};

const attemptRow = (h: Harness, runId: string) =>
  h.cp.db.get<{ attempt_id: string; state: string; started_at: string; deadline_at: string }>(
    "SELECT attempt_id, state, started_at, deadline_at FROM candidate_pipeline_attempts WHERE run_id = ?",
    [runId],
  )!;
const reclaimed = (h: Harness, runId: string) =>
  h.cp.audit.forRun(runId).filter((row) => row.kind === "CANDIDATE_PIPELINE_ATTEMPT_RECLAIMED");
const prompts = (h: Harness, pattern: RegExp) => h.scripted.invocations.filter((call) => pattern.test(call.prompt)).length;

/** Nothing of a stale attempt's outcome reached the run: no packet, no revision request. */
const expectNothingApplied = (h: Harness, runId: string): void => {
  expect(h.cp.runs.require(runId).state).toBe(RunState.ACTIVE);
  expect(h.cp.artifacts.latest(runId, ArtifactKind.PRODUCTION_READY_PACKET)).toBeNull();
  expect(h.cp.audit.forRun(runId).filter((row) => row.kind === "REVISION_RETURNED_TO_CTO")).toEqual([]);
};

describe("a candidate submission's attempt lease follows its real progress", () => {
  it("a review whose chunks complete over 45 minutes keeps its attempt, stores its verdict and reports each real step", async () => {
    const { h, run, runId, covered } = await prepare(large(130_000));
    h.scripted.script(
      { match: /Review chunk/, text: reviewerPass([covered]), once: false },
      { match: /Final review/, text: reviewerPass([]) },
    );
    pace(h, (prompt) => (/Final review/.test(prompt) ? 5 : 20));
    const steps: string[] = [];

    const outcome = await h.cp.pipeline.submitResult({ ...submission(run), onProgress: (step) => steps.push(step) });

    const chunks = prompts(h, /Review chunk/);
    expect(chunks).toBeGreaterThanOrEqual(2); // 20 minutes each, then 5: at least 45 minutes in all.
    expect(outcome).toMatchObject({ allowed: true, value: { stage: "COMPLETED_REVIEW" } });
    expect(reclaimed(h, runId)).toEqual([]);
    expect(h.cp.artifacts.latest(runId, ArtifactKind.BLIND_REVIEW)).not.toBeNull();
    expect(h.cp.runs.require(runId).state).toBe(RunState.READY_FOR_CEO_REVIEW);
    const verificationSteps = steps.filter((step) => step === "VERIFICATION_COMMAND_COMPLETED").length;
    expect(verificationSteps).toBeGreaterThan(0);
    expect(steps).toEqual([
      ...Array<string>(verificationSteps).fill("VERIFICATION_COMMAND_COMPLETED"),
      ...Array<string>(chunks).fill("REVIEW_CHUNK_COMPLETED"),
      "FINAL_REVIEW_STARTED",
      "FINAL_REVIEW_ENDED",
    ]);
  });

  it("without real progress the attempt is released at 30 minutes, a later step never revives it, and the review stops", async () => {
    const { h, run, runId, covered } = await prepare(large(130_000));
    h.scripted.script(
      { match: /Review chunk/, text: reviewerPass([covered]), once: false },
      { match: /Final review/, text: reviewerPass([]) },
    );
    pace(h, () => 31);
    const steps: string[] = [];

    const outcome = await h.cp.pipeline.submitResult({ ...submission(run), onProgress: (step) => steps.push(step) });

    expect(outcome).toMatchObject({ allowed: false, reasonCode: ReasonCode.CANDIDATE_PIPELINE_ATTEMPT_STALE });
    // Released by the sweep during the first chunk; the chunk's completion after it renewed nothing.
    const row = attemptRow(h, runId);
    expect(row.state).toBe("RELEASED");
    expect(Date.parse(row.deadline_at) - Date.parse(row.started_at)).toBe(30 * MINUTE);
    expect(reclaimed(h, runId)).toHaveLength(1);
    expect(steps.filter((step) => step !== "VERIFICATION_COMMAND_COMPLETED")).toEqual([]);
    // No reviewer worked on for an attempt that no longer held the run.
    expect(prompts(h, /Review chunk/)).toBe(1);
    expect(prompts(h, /Final review/)).toBe(0);
    expect(h.cp.artifacts.latest(runId, ArtifactKind.BLIND_REVIEW)).toBeNull();
    expectNothingApplied(h, runId);
  });

  it("at 120 minutes from acquisition the cap applies although every step progressed", async () => {
    const { h, run, runId, covered } = await prepare(large(600_000));
    h.scripted.script(
      { match: /Review chunk/, text: reviewerPass([covered]), once: false },
      { match: /Final review/, text: reviewerPass([]) },
    );
    pace(h, () => 29);
    const steps: string[] = [];

    const outcome = await h.cp.pipeline.submitResult({ ...submission(run), onProgress: (step) => steps.push(step) });

    expect(steps.filter((step) => step === "REVIEW_CHUNK_COMPLETED").length).toBeGreaterThanOrEqual(4);
    expect(outcome).toMatchObject({ allowed: false, reasonCode: ReasonCode.CANDIDATE_PIPELINE_ATTEMPT_STALE });
    const rows = reclaimed(h, runId);
    expect(rows).toHaveLength(1);
    const evidence = rows[0]!.evidence as { startedAt: string; deadlineAt: string };
    expect(Date.parse(evidence.deadlineAt) - Date.parse(evidence.startedAt)).toBe(120 * MINUTE);
    expect(attemptRow(h, runId).state).toBe("RELEASED");
    expect(h.cp.artifacts.latest(runId, ArtifactKind.BLIND_REVIEW)).toBeNull();
    expectNothingApplied(h, runId);
  });

  it("an attempt released while its final review runs stores no verdict: the store's compare-and-set refuses it, and that is recorded", async () => {
    const { h, run, runId, covered } = await prepare();
    h.scripted.script({ match: /Candidate review/, text: reviewerPass([covered]) });
    pace(h, () => 31);

    const outcome = await h.cp.pipeline.submitResult(submission(run));

    expect(outcome).toMatchObject({ allowed: false, reasonCode: ReasonCode.CANDIDATE_PIPELINE_ATTEMPT_STALE });
    expect(h.cp.artifacts.latest(runId, ArtifactKind.BLIND_REVIEW)).toBeNull();
    expect(h.cp.audit.forRun(runId).filter((row) => row.kind === "BLIND_REVIEW_COMPLETED")).toEqual([]);
    const refused = h.cp.audit.forRun(runId).filter((row) => row.kind === "BLIND_REVIEW_REJECTED");
    expect(refused).toHaveLength(1);
    expect(refused[0]!.evidence).toMatchObject({ stale: "ATTEMPT_LEASE", attemptId: attemptRow(h, runId).attempt_id });
    expect(refused[0]!.reasonCode).toBe(ReasonCode.CANDIDATE_PIPELINE_ATTEMPT_STALE);
    expectNothingApplied(h, runId);
  });

  it("an attempt released after its review was stored builds no packet, and that is recorded", async () => {
    const { h, run, runId, covered } = await prepare();
    h.scripted.script({ match: /Candidate review/, text: reviewerPass([covered]) });
    // The await between the stored review and the packet outlasts the lease.
    h.cp.pipeline.attach({
      continuity: {
        evaluate: async () => {
          h.clock.advance(31 * MINUTE);
          h.cp.pipeline.reclaimExpiredAttempts();
        },
      },
    });

    const outcome = await h.cp.pipeline.submitResult(submission(run));

    expect(outcome).toMatchObject({ allowed: false, reasonCode: ReasonCode.CANDIDATE_PIPELINE_ATTEMPT_STALE });
    expect(h.cp.artifacts.latest(runId, ArtifactKind.BLIND_REVIEW)).not.toBeNull();
    const refused = h.cp.audit.forRun(runId).filter((row) => row.kind === "BLIND_REVIEW_REJECTED");
    expect(refused).toHaveLength(1);
    expect(refused[0]!.evidence).toMatchObject({ stale: "ATTEMPT_LEASE", reviewReasonCode: ReasonCode.REVIEW_PASS });
    expectNothingApplied(h, runId);
  });
});

/** One MCP connection as the run's owning CTO session, and every message its server sends. */
const connect = async (h: Harness, run: RunRow) => {
  const sessionId = run.ownerSessionId!;
  const incarnation = h.cp.sessions.require(sessionId).incarnation;
  const held = h.cp.bindings.bySession(sessionId).filter((binding) => binding.status === "ACTIVE");
  const server = createCtoServer(createCtoMcpPort(h.cp), () => allow(ReasonCode.OK, {
    actor: `cto:${sessionId}`, sessionId, sessionIncarnation: incarnation,
    binding: { roleKey: held[0]!.roleKey, bindingGeneration: held[0]!.bindingGeneration },
  }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const sent: JSONRPCMessage[] = [];
  const send = serverTransport.send.bind(serverTransport);
  serverTransport.send = async (message, options) => {
    sent.push(message);
    return send(message, options);
  };
  await server.connect(serverTransport);
  const client = new Client({ name: "long-review-submitter", version: "1" });
  await client.connect(clientTransport);
  const close = async (): Promise<void> => {
    await client.close();
    await server.close();
  };
  return { client, sent, close };
};

const progressSent = (sent: JSONRPCMessage[]) =>
  sent.filter((message) => "method" in message && message.method === "notifications/progress");

const resultSubmit = (run: RunRow, idempotencyKey: string) => ({
  name: "result_submit",
  arguments: { idempotencyKey, runId: run.runId, resultSummary: "app() now returns 2", recommendation: "merge" },
});

describe("result_submit over MCP", () => {
  it("sends a progress notice per real step when the caller sent a progressToken, and none without one", async () => {
    const { h, run, covered } = await prepare();
    // First submission, no progressToken: a revision, so the run takes a second one.
    h.scripted.script({ match: /Candidate review/, text: reviewerRevise([covered], "a finding") });
    const plain = await connect(h, run);
    try {
      const first = await plain.client.callTool(resultSubmit(run, "submit-without-token"));
      expect(first.structuredContent).toMatchObject({ ok: true, value: { stage: "REVISION_REQUIRED" } });
      expect(progressSent(plain.sent)).toEqual([]);
    } finally {
      await plain.close();
    }

    h.scripted.script({ match: /Candidate review/, text: reviewerPass([covered]) });
    const notices: Array<{ progress: number; message?: string }> = [];
    const tokened = await connect(h, run);
    try {
      const second = await tokened.client.callTool(resultSubmit(run, "submit-with-token"), undefined, {
        onprogress: (notice) => notices.push(notice),
      });
      expect(second.structuredContent).toMatchObject({ ok: true, value: { stage: "COMPLETED_REVIEW" } });
      expect(progressSent(tokened.sent)).toHaveLength(notices.length);
    } finally {
      await tokened.close();
    }
    // One notice per real step, in order: each verification command, then the review's start and end.
    const messages = notices.map((notice) => notice.message);
    const verification = messages.filter((message) => message === "VERIFICATION_COMMAND_COMPLETED").length;
    expect(verification).toBeGreaterThan(0);
    expect(messages).toEqual([
      ...Array<string>(verification).fill("VERIFICATION_COMMAND_COMPLETED"),
      "FINAL_REVIEW_STARTED",
      "FINAL_REVIEW_ENDED",
    ]);
    expect(notices.map((notice) => notice.progress)).toEqual(messages.map((_, index) => index + 1));
  });

  it("the same key while the submission runs answers in flight without a second pipeline, and its stored result once done, across a disconnect", async () => {
    const { h, run, covered } = await prepare();
    h.scripted.script({ match: /Candidate review/, text: reviewerPass([covered]) });
    let entered!: () => void;
    const reviewing = new Promise<void>((resolve) => { entered = resolve; });
    let finish!: () => void;
    const held = new Promise<void>((resolve) => { finish = resolve; });
    const invoke = h.scripted.invoke.bind(h.scripted);
    h.scripted.invoke = async (request: InvocationRequest): Promise<InvocationResult> => {
      entered();
      await held;
      return invoke(request);
    };
    const submit = vi.spyOn(h.cp.pipeline, "submitResult");

    // The first call, then its connection drops while the review runs.
    const first = await connect(h, run);
    const lost = first.client.callTool(resultSubmit(run, "the-one-submission"), undefined, { onprogress: () => undefined })
      .catch((error: unknown) => error);
    await reviewing;
    await first.close();
    expect(await lost).toBeInstanceOf(Error);

    const again = await connect(h, run);
    try {
      const inFlight = await again.client.callTool(resultSubmit(run, "the-one-submission"));
      expect(inFlight.isError).toBeFalsy();
      expect(inFlight.structuredContent).toMatchObject({ ok: true, reasonCode: ReasonCode.MCP_MUTATION_IN_FLIGHT, value: { inFlight: true } });
      expect(submit).toHaveBeenCalledTimes(1);

      finish();
      const outcome = await submit.mock.results[0]!.value;
      expect(outcome).toMatchObject({ allowed: true, value: { stage: "COMPLETED_REVIEW" } });
      // The response is stored just after the pipeline returns.
      let stored = await again.client.callTool(resultSubmit(run, "the-one-submission"));
      for (let tick = 0; tick < 20 && (stored.structuredContent as { reasonCode?: string }).reasonCode === ReasonCode.MCP_MUTATION_IN_FLIGHT; tick += 1) {
        await new Promise((resolve) => setImmediate(resolve));
        stored = await again.client.callTool(resultSubmit(run, "the-one-submission"));
      }
      expect(stored.structuredContent).toMatchObject({ ok: true, value: { stage: "COMPLETED_REVIEW" } });
      expect(submit).toHaveBeenCalledTimes(1);
    } finally {
      await again.close();
    }
  });
});
