import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, describe, expect, it, vi } from "vitest";

import { manifestDigest, type ProjectManifest } from "../../src/contracts/manifest.ts";
import { parseVerificationCommand } from "../../src/contracts/verification-command.ts";
import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ArtifactKind, ExecutionMode, RunKind, RunState, type RunRow } from "../../src/domain/types.ts";
import { Daemon } from "../../src/daemon/daemon.ts";
import { createCtoMcpPort, createCtoServer } from "../../src/mcp/cto-server.ts";
import { progressNotifier } from "../../src/mcp/shared.ts";
import type { InvocationRequest, InvocationResult } from "../../src/runtime/provider.ts";
import { BOOTSTRAP_REVIEW_RETRY_WAKE } from "../../src/runtime/provisioned-session-runtime.ts";
import type { TaskContract } from "../../src/run/run-engine.ts";
import { runSandboxed } from "../../src/verify/sandbox.ts";
import { bootstrapCoverageKeys, submitBootstrapPlan } from "../helpers/bootstrap-plan.ts";
import { WORKFLOW, WORKFLOW_PATH } from "../helpers/contract-change.ts";
import { cleanupTempDirs, commitAll, gitSync, makeRepo, tempDir, writeFiles } from "../helpers/fixtures.ts";
import { createRun, firstManifest, firstPlan, operatorRegisteredProject, revisionsFor } from "../helpers/first-activation.ts";
import { genesisPlanFixture } from "../helpers/genesis-github.ts";
import {
  type Harness,
  applyPassingChange,
  bindCeo,
  bindWorker,
  dispatchBootstrapRun,
  fixtureManifest,
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

const prepare = async (content?: string, manifest: Partial<ProjectManifest> = {}) => {
  const h = makeHarness();
  const { projectId, repositoryId, identity } = await registerFixtureProject(h, "fixture-project", manifest);
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

/**
 * Each reviewer answer takes `minutes(prompt)` of fake time and the watchdog sweeps before it comes back.
 * Answers, per invocation, whether its signal had stopped it by then.
 */
const pace = (
  h: Harness,
  minutes: (prompt: string) => number,
  sweep: () => unknown = () => h.cp.pipeline.reclaimExpiredAttempts(),
): boolean[] => {
  const stopped: boolean[] = [];
  const invoke = h.scripted.invoke.bind(h.scripted);
  h.scripted.invoke = async (request: InvocationRequest): Promise<InvocationResult> => {
    const answer = await invoke(request);
    h.clock.advance(minutes(request.prompt) * MINUTE);
    await sweep();
    stopped.push(request.signal?.aborted === true);
    return answer;
  };
  return stopped;
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
    const stopped = pace(h, () => 31);
    const steps: string[] = [];

    const outcome = await h.cp.pipeline.submitResult({ ...submission(run), onProgress: (step) => steps.push(step) });

    expect(outcome).toMatchObject({ allowed: false, reasonCode: ReasonCode.CANDIDATE_PIPELINE_ATTEMPT_STALE });
    // The release stopped the chunk reviewer still running, and its late answer fed nothing.
    expect(stopped).toEqual([true]);
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

describe("work an attempt started stops when ACP releases it, and what comes back late is not applied", () => {
  it("at the cap the watchdog's release stops the final reviewer still running, and no verdict is applied", async () => {
    const { h, run, runId, covered } = await prepare(large(600_000));
    h.scripted.script(
      { match: /Review chunk/, text: reviewerPass([covered]), once: false },
      { match: /Final review/, text: reviewerPass([]) },
    );
    // The chunks take 119.2 minutes in all, so the final review starts then; the watchdog runs past 120.
    const stopped = pace(h, (prompt) => {
      const of = /# Review chunk \d+ of (\d+)/.exec(prompt);
      return of ? 119.2 / Number(of[1]) : 1;
    }, () => h.cp.watchdog.tick());
    // Each reviewer session is constituted under the attempt's signal too (a handshake that spawns).
    const sessions: Array<AbortSignal | undefined> = [];
    const startSession = h.scripted.startSession.bind(h.scripted);
    h.scripted.startSession = async (spec) => {
      sessions.push(spec.signal);
      return startSession(spec);
    };

    const outcome = await h.cp.pipeline.submitResult(submission(run));

    const chunks = prompts(h, /Review chunk/);
    expect(chunks).toBeGreaterThanOrEqual(4);
    expect(prompts(h, /Final review/)).toBe(1);
    expect(stopped).toEqual([...Array<boolean>(chunks).fill(false), true]);
    expect(sessions).toHaveLength(chunks + 1);
    expect(sessions.every((signal) => signal?.aborted === true)).toBe(true);
    expect(outcome).toMatchObject({ allowed: false, reasonCode: ReasonCode.CANDIDATE_PIPELINE_ATTEMPT_STALE });
    expect(attemptRow(h, runId).state).toBe("RELEASED");
    expect(h.cp.artifacts.latest(runId, ArtifactKind.BLIND_REVIEW)).toBeNull();
    expectNothingApplied(h, runId);
  });

  it("an attempt released during its first verification command records none of its result, stops it, and starts no second command", async () => {
    const verify = fixtureManifest("fixture-project").verificationCommands[0]!;
    const { h, run, runId } = await prepare(undefined, {
      verificationProfiles: { simple: ["verify", "verify-again"], standard: ["verify", "verify-again"], guarded: ["verify", "verify-again"] },
      verificationCommands: [verify, { ...verify, id: "verify-again" }],
    });
    const engine = h.cp.verification as unknown as { runLocal: (...args: unknown[]) => Promise<unknown> };
    const runLocal = engine.runLocal.bind(h.cp.verification);
    const stopped: boolean[] = [];
    engine.runLocal = async (...args: unknown[]) => {
      const result = await runLocal(...args);
      h.clock.advance(31 * MINUTE);
      h.cp.pipeline.reclaimExpiredAttempts();
      const signal = args.at(-1);
      stopped.push(signal instanceof AbortSignal && signal.aborted);
      return result;
    };

    const outcome = await h.cp.pipeline.submitResult(submission(run));

    expect(stopped).toEqual([true]);
    expect(outcome).toMatchObject({ allowed: false, reasonCode: ReasonCode.CANDIDATE_PIPELINE_ATTEMPT_STALE });
    expect(h.cp.db.all("SELECT result_id FROM verification_results WHERE run_id = ?", [runId])).toEqual([]);
    expect(h.cp.artifacts.latest(runId, ArtifactKind.VERIFICATION)).toBeNull();
    expect(h.scripted.invocations).toEqual([]);
    expectNothingApplied(h, runId);
  });

  it("a verification command whose submission no longer holds the run is stopped", async () => {
    const repository = makeRepo({ "slow.js": "setTimeout(() => {}, 60000);\n" });
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 1_000).unref();
    const outcome = await runSandboxed({
      command: parseVerificationCommand({ id: "slow", argv: ["node", "slow.js"], timeoutSeconds: 120 }),
      worktreePath: repository,
      denyReadPaths: [],
      signal: controller.signal,
    });
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(outcome.status).not.toBe("PASS");
  }, 30_000);

  it.each(["CONTRACT_CHANGE", "BOOTSTRAP_PLAN"] as const)(
    "a %s review renews its attempt when it starts: 25 minutes of preparation and a 10-minute review keep it, with a progress notice",
    async (kind) => {
      const { h, run, runId } = kind === "CONTRACT_CHANGE" ? await contractChangeRun() : await bootstrapPlanRun();
      const freeze = h.cp.pipeline.freeze.bind(h.cp.pipeline);
      h.cp.pipeline.freeze = async (...args: Parameters<typeof freeze>) => {
        const frozen = await freeze(...args);
        h.clock.advance(25 * MINUTE);
        return frozen;
      };
      pace(h, () => 10);
      const steps: string[] = [];

      const outcome = await h.cp.pipeline.submitResult({ ...submission(run), onProgress: (step) => steps.push(step) });

      expect(outcome).toMatchObject({ allowed: true, value: { stage: "COMPLETED_REVIEW" } });
      expect(steps).toEqual(["FINAL_REVIEW_STARTED", "FINAL_REVIEW_ENDED"]);
      expect(reclaimed(h, runId)).toEqual([]);
    },
  );
});

describe("a late failure of an attempt that no longer holds the run is that attempt's history only", () => {
  it("it names its attempt and says so, and it wakes no review retry after the current attempt's revision", async () => {
    const { h, run, runId } = await bootstrapPlanRun();
    h.scripted.reset();
    h.scripted.script({ match: /Bootstrap plan review/, text: reviewerRevise(bootstrapCoverageKeys(h, runId), "a finding"), once: false });
    let entered!: () => void;
    const reviewing = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const invoke = h.scripted.invoke.bind(h.scripted);
    let calls = 0;
    h.scripted.invoke = async (request: InvocationRequest): Promise<InvocationResult> => {
      if (/Bootstrap plan review/.test(request.prompt) && ++calls === 1) {
        entered();
        await held;
      }
      return invoke(request);
    };
    // The first attempt's review outlasts its lease; a second attempt is returned for revision; then the first ends.
    const first = h.cp.pipeline.submitResult(submission(run));
    await reviewing;
    h.clock.advance(31 * MINUTE);
    const second = await h.cp.pipeline.submitResult(submission(run));
    release();
    const late = await first;

    expect(second).toMatchObject({ allowed: true, value: { stage: "REVISION_REQUIRED" } });
    expect(late).toMatchObject({ allowed: false, reasonCode: ReasonCode.BINDING_GENERATION_STALE, message: expect.stringMatching(/^not applied:/), evidence: { attemptHeld: false } });
    const reclaimedAttempt = reclaimed(h, runId)[0]!.evidence["attemptId"];
    const history = h.cp.audit.forRun(runId).filter((row) => row.kind === "BLIND_REVIEW_UNAVAILABLE");
    expect(history).toHaveLength(1);
    expect(history[0]!.evidence).toMatchObject({ attemptId: reclaimedAttempt, attemptHeld: false });
    expect(h.cp.runs.require(runId).state).toBe(RunState.ACTIVE);
    const report = new Daemon(h.cp, { stateDir: tempDir("acp-late-history-") }).wakeBootstrapResultRecovery();
    expect(report.woken.filter((woken) => "retry" in woken)).toEqual([]);
    expect(h.cp.audit.byKind(BOOTSTRAP_REVIEW_RETRY_WAKE).filter((row) => row.runId === runId)).toEqual([]);
  });
});

/** A dispatched no-repository CONTRACT_CHANGE (a first activation) with its PLAN, and a passing reviewer for it. */
const contractChangeRun = async () => {
  const repoPath = makeRepo({ "README.md": "# fixture\n", "verify.js": "console.log('ok')\n", [WORKFLOW_PATH]: WORKFLOW }, "dev");
  const h = makeHarness({ repoPath });
  const projectId = "long-review-activation";
  await operatorRegisteredProject(h, projectId);
  const bound = gitSync(repoPath, ["rev-parse", "HEAD"]);
  const run = await createRun(h, projectId, RunKind.CONTRACT_CHANGE);
  const manifest = firstManifest(projectId);
  const submitted = createCtoMcpPort(h.cp).submitPlan(run.runId, {
    ...firstPlan(manifest, revisionsFor(manifest, bound)),
    summary: "Activate the project's first manifest.",
    repositoryContentChange: false,
    risks: [],
    verificationIntent: ["The project's CI check stays the quality bar."],
  });
  if (!submitted.allowed) throw new Error(`${submitted.reasonCode}: ${submitted.message}`);
  await h.cp.continuity.evaluate("long contract change review");
  h.scripted.script({ match: /Contract change review/, text: reviewerPass([`${projectId}:#manifest/${manifestDigest(manifest)}`]) });
  return { h, run, runId: run.runId };
};

/** A dispatched project-less bootstrap run with its PLAN, and a passing reviewer for it. */
const bootstrapPlanRun = async () => {
  const h = makeHarness();
  bindCeo(h);
  const created = h.cp.runs.create({
    kind: RunKind.PROJECT_BOOTSTRAP,
    executionMode: ExecutionMode.STANDARD,
    contract: { goal: "bootstrap", why: "review", scope: [], nonGoals: [], acceptance: ["done"], priority: "NORMAL", humanGate: [], references: [] },
  });
  if (!created.allowed) throw new Error(created.message);
  const run = await dispatchBootstrapRun(h.cp, h.clock, created.value.runId);
  await submitBootstrapPlan(h, run.runId, genesisPlanFixture().artifact.content);
  h.scripted.script({ match: /Bootstrap plan review/, text: reviewerPass(bootstrapCoverageKeys(h, run.runId)) });
  return { h, run, runId: run.runId };
};

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

  it("after a daemon restart mid-review the same key runs no second pipeline, a new key is refused while the attempt holds, and a stored result stays retrievable", async () => {
    const { h, run, covered } = await prepare();
    // A first submission completes before the restart: a revision, so the run stays ACTIVE.
    h.scripted.script({ match: /Candidate review/, text: reviewerRevise([covered], "a finding") });
    const before = await connect(h, run);
    const done = await before.client.callTool(resultSubmit(run, "finished-before-the-restart"));
    await before.close();
    expect(done.structuredContent).toMatchObject({ ok: true, value: { stage: "REVISION_REQUIRED" } });

    // A second one is mid-review when the daemon goes: its process, and that review, end with it.
    h.scripted.script({ match: /Candidate review/, text: reviewerPass([covered]) });
    let entered!: () => void;
    const reviewing = new Promise<void>((resolve) => { entered = resolve; });
    const invoke = h.scripted.invoke.bind(h.scripted);
    h.scripted.invoke = async (request: InvocationRequest): Promise<InvocationResult> => {
      entered();
      await new Promise<never>(() => undefined);
      return invoke(request);
    };
    const during = await connect(h, run);
    void during.client.callTool(resultSubmit(run, "running-at-the-restart")).catch(() => undefined);
    await reviewing;
    await during.close();
    h.cp.close();

    // A new control plane on the same database: nothing of the first one's memory.
    const restarted = makeHarness({ root: h.root, repoPath: h.repoPath, clock: h.clock });
    const submit = vi.spyOn(restarted.cp.pipeline, "submitResult");
    const after = await connect(restarted, run);
    const frozen = () => restarted.cp.audit.forRun(run.runId).filter((row) => row.kind === "CANDIDATE_FROZEN").length;
    try {
      // The stored result is still the key's answer.
      expect((await after.client.callTool(resultSubmit(run, "finished-before-the-restart"))).structuredContent)
        .toEqual(done.structuredContent);
      // The interrupted key never runs again: its outcome is unknown, not re-executed.
      const interrupted = await after.client.callTool(resultSubmit(run, "running-at-the-restart"));
      expect(interrupted.structuredContent).toMatchObject({ ok: false, reasonCode: ReasonCode.MCP_MUTATION_OUTCOME_UNKNOWN });
      expect(submit).not.toHaveBeenCalled();
      // A new key is refused while the interrupted attempt still holds the run.
      const newKey = await after.client.callTool(resultSubmit(run, "a-new-key-at-once"));
      expect(newKey.structuredContent).toMatchObject({ ok: false, reasonCode: ReasonCode.CONFLICT });
      expect(frozen()).toBe(2);
      expect(restarted.scripted.invocations).toEqual([]);
      // Its lease lapses unrenewed and the watchdog reclaims it; the interrupted key still runs nothing.
      restarted.clock.advance(31 * MINUTE);
      await restarted.cp.watchdog.tick();
      expect(restarted.cp.db.get<{ state: string }>("SELECT state FROM candidate_pipeline_attempts WHERE run_id = ?", [run.runId])?.state)
        .toBe("RELEASED");
      expect((await after.client.callTool(resultSubmit(run, "running-at-the-restart"))).structuredContent)
        .toMatchObject({ ok: false, reasonCode: ReasonCode.MCP_MUTATION_OUTCOME_UNKNOWN });
      expect(submit).toHaveBeenCalledTimes(1);
      expect(frozen()).toBe(2);
    } finally {
      await after.close();
      restarted.cp.close();
    }
  });
});

describe("an MCP SDK client receiving progress notices", () => {
  /** A tool that runs five seconds, sending a progress notice each second when its caller asked for them. */
  const slowServer = (): McpServer => {
    const server = new McpServer({ name: "slow", version: "1" });
    server.registerTool("slow", { description: "runs five seconds" }, async (extra) => {
      const notify = progressNotifier(extra);
      for (let second = 1; second <= 5; second += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        notify?.(`second ${second}`);
      }
      return { content: [{ type: "text" as const, text: "done" }] };
    });
    return server;
  };
  const call = async (options: Parameters<Client["callTool"]>[2]) => {
    const server = slowServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "progress-receiver", version: "1" });
    await client.connect(clientTransport);
    try {
      return await client.callTool({ name: "slow", arguments: {} }, undefined, options).catch((error: unknown) => error);
    } finally {
      await client.close();
      await server.close();
    }
  };

  it("does not time out at 2 seconds while a notice arrives every second, and does without them", async () => {
    const notices: number[] = [];
    const kept = await call({ timeout: 2_000, resetTimeoutOnProgress: true, onprogress: (notice) => notices.push(notice.progress) });
    expect(kept).toMatchObject({ content: [{ type: "text", text: "done" }] });
    expect(notices).toEqual([1, 2, 3, 4, 5]);
    const silent = await call({ timeout: 2_000, resetTimeoutOnProgress: true });
    expect(silent).toBeInstanceOf(Error);
    expect(String(silent)).toMatch(/timed out/i);
  }, 20_000);
});
