import { afterAll, describe, expect, it } from "vitest";

import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ExecutionMode, Role, RunState, SessionLifecycle } from "../../src/domain/types.ts";
import { MessageKind } from "../../src/outbox/envelope.ts";
import type { TaskContract } from "../../src/run/run-engine.ts";
import { cleanupTempDirs, commitAll, writeFiles } from "../helpers/fixtures.ts";
import {
  type Harness,
  applyPassingChange,
  bindCeo,
  bindWorker,
  driveToReviewedCandidate,
  makeHarness,
  registerFixtureProject,
  reviewerPass,
  reviewerRevise,
} from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * #1189 §3 (product) — the runtime gate properties the review-round summary must not disturb, held
 * against the production pipeline, review gate and production gate. The reviewer is the harness's
 * scripted one, so every review JSON here is a test fixture: these are scripted pipeline results,
 * not live reviewer evidence, and they say nothing about what a real model would find.
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

const startRun = async (harness: Harness) => {
  const { projectId, repositoryId, identity } = await registerFixtureProject(harness);
  const ceoSessionId = bindCeo(harness);
  const created = harness.cp.runs.create({
    projectId,
    executionMode: ExecutionMode.STANDARD,
    contract: CONTRACT,
    repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
  });
  if (!created.allowed) throw new Error(created.message);
  const runId = created.value.runId;
  const dispatched = await harness.cp.runs.dispatch(runId);
  if (!dispatched.allowed) throw new Error(`${dispatched.reasonCode}: ${dispatched.message}`);
  const run = dispatched.value;
  const tasks = harness.cp.tasks.submit(runId, [{ key: "impl", title: "change app()", category: "implementation" }]);
  if (!tasks.allowed) throw new Error(tasks.message);
  const task = harness.cp.tasks.ready(runId)[0]!;
  const execution = harness.cp.tasks.startExecution({
    runId,
    taskId: task.taskId,
    ownerBindingGeneration: run.ownerBindingGeneration!,
    workerSessionId: bindWorker(harness, task.taskId),
    provider: "scripted",
    model: "scripted-worker",
    repositoryId,
  });
  if (!execution.allowed) throw new Error(execution.message);
  const head = applyPassingChange(harness.repoPath);
  harness.cp.tasks.finishExecution(execution.value.executionId, { status: "SUCCEEDED", resultDigest: `sha256:${head}` });
  const submit = (resultSummary = "app() now returns 2", recommendation = "merge") =>
    harness.cp.pipeline.submitResult({
      runId,
      ownerSessionId: run.ownerSessionId!,
      ownerBindingGeneration: run.ownerBindingGeneration!,
      resultSummary,
      recommendation,
    });
  return { projectId, identity, runId, run, ceoSessionId, submit, covered: [`${identity}:src/app.js`] };
};

const verdict = (
  value: "PASS" | "REVISE" | "BLOCK",
  coveredFiles: string[],
  findings: Array<{ severity: "INFO" | "MINOR" | "MAJOR" | "BLOCKER"; summary: string }>,
): string =>
  JSON.stringify({
    verdict: value,
    coveredFiles,
    omittedItems: [],
    findings: findings.map((finding) => ({
      category: "correctness",
      repository: "github:acme/fixture",
      path: "src/app.js",
      detail: finding.summary,
      ...finding,
    })),
  });

/** Nothing about the run reads as ready for the CEO, and the CEO cannot confirm it. */
const expectNotCeoReady = (harness: Harness, runId: string, candidateSnapshotDigest: string, ceoSessionId: string): void => {
  expect(harness.cp.runs.require(runId).state).toBe(RunState.ACTIVE);
  expect(harness.cp.artifacts.list(runId, "PRODUCTION_READY_PACKET")).toEqual([]);
  expect(
    harness.cp.audit.forRun(runId).filter((row) => row.kind === "CEO_NOTIFICATION" && row.evidence["notification"] === "READY_FOR_CEO_REVIEW"),
  ).toEqual([]);
  const confirmed = harness.cp.ceo.submitCeoDecision({
    runId,
    decision: "CONFIRM",
    candidateSnapshotDigest,
    ceoSessionId,
    rationale: "every finding is fixed",
  });
  expect(confirmed.allowed).toBe(false);
  expect(harness.cp.runs.require(runId).state).toBe(RunState.ACTIVE);
};

describe("#1189 §3: a verdict other than PASS never reaches CEO-ready", () => {
  const cases: Array<{ name: string; answer: (covered: string[], identity: string) => string; reason: string }> = [
    { name: "REVISE", answer: (covered) => reviewerRevise(covered, "app() is wrong"), reason: ReasonCode.REVIEW_REVISE },
    {
      name: "BLOCK",
      answer: (covered) => verdict("BLOCK", covered, [{ severity: "BLOCKER", summary: "unsafe" }]),
      reason: ReasonCode.REVIEW_BLOCK,
    },
    // The reviewer claims PASS but never covered the touched file: the omission is evidence missing.
    { name: "omitted evidence", answer: (_covered, identity) => reviewerPass([`${identity}:README.md`]), reason: ReasonCode.REVIEW_REVISE },
    // No host rule turns a REVISE into a PASS because every finding is INFO or MINOR, or because there is none.
    {
      name: "REVISE with only INFO and MINOR findings",
      answer: (covered) => verdict("REVISE", covered, [{ severity: "INFO", summary: "note" }, { severity: "MINOR", summary: "nit" }]),
      reason: ReasonCode.REVIEW_REVISE,
    },
    { name: "REVISE with no findings", answer: (covered) => verdict("REVISE", covered, []), reason: ReasonCode.REVIEW_REVISE },
    {
      name: "BLOCK with only INFO findings",
      answer: (covered) => verdict("BLOCK", covered, [{ severity: "INFO", summary: "note" }]),
      reason: ReasonCode.REVIEW_BLOCK,
    },
  ];

  for (const testCase of cases) {
    it(`${testCase.name} returns to the CTO and stays off the CEO's desk`, async () => {
      const harness = makeHarness();
      const { runId, identity, ceoSessionId, submit, covered } = await startRun(harness);
      harness.scripted.script({ match: /Candidate review/, text: testCase.answer(covered, identity) });
      const outcome = await submit();
      if (!outcome.allowed || outcome.value.stage !== "REVISION_REQUIRED") {
        throw new Error(`unexpected outcome: ${JSON.stringify(outcome).slice(0, 400)}`);
      }
      expect(outcome.value.reasonCode).toBe(testCase.reason);
      expect(outcome.value.review?.verdict).not.toBe("PASS");
      expect(harness.cp.audit.forRun(runId).filter((row) => row.kind === "REVISION_RETURNED_TO_CTO")).toHaveLength(1);
      expectNotCeoReady(harness, runId, outcome.value.snapshotDigest, ceoSessionId);
    });
  }
});

describe("existing verdict and severity semantics", () => {
  it("accepts PASS with only MINOR findings without reclassifying the verdict", async () => {
    const harness = makeHarness();
    try {
      const { runId, submit, covered } = await startRun(harness);
      harness.scripted.script({ match: /Candidate review/,
        text: verdict("PASS", covered, [{ severity: "MINOR", summary: "NIT-1: nonblocking clarification" }]) });
      const outcome = await submit();
      expect(outcome).toMatchObject({ allowed: true, value: { stage: "COMPLETED_REVIEW" } });
      expect(harness.cp.review.latestPacket(runId, harness.cp.runs.currentCandidate(runId)!)).toMatchObject({
        verdict: "PASS", findings: [{ severity: "MINOR", detail: "NIT-1: nonblocking clarification" }],
      });
      expect(harness.cp.runs.require(runId).state).toBe(RunState.READY_FOR_CEO_REVIEW);
      expect(harness.cp.outbox.listByRun(runId).filter(message => message.kind === MessageKind.REVISION_REQUEST)).toEqual([]);
      expect(harness.cp.audit.forRun(runId).filter(event => event.kind === "REVISION_RETURNED_TO_CTO")).toEqual([]);
      const prompt = harness.scripted.invocations.find(call => call.prompt.startsWith("# Candidate review"))!.prompt;
      expect(prompt).not.toMatch(/Automatic attempt|Round 2|PASS WITH NITS|INCOMPLETE/);
    } finally {
      harness.cp.close();
    }
  });
});

describe("#1189 §3: an unavailable review is not a code-fix verdict", () => {
  it("REVIEW_UNAVAILABLE returns nothing to the CTO and is not CEO-ready", async () => {
    const harness = makeHarness();
    const { runId, ceoSessionId, submit } = await startRun(harness);
    harness.scripted.setRuntimeHealth("UNAVAILABLE");
    const outcome = await submit();
    if (!outcome.allowed || outcome.value.stage !== "REVIEW_UNAVAILABLE") {
      throw new Error(`unexpected outcome: ${JSON.stringify(outcome).slice(0, 400)}`);
    }
    expect([ReasonCode.REVIEW_REVISE, ReasonCode.REVIEW_BLOCK, ReasonCode.REVIEW_OMITTED_ITEMS_PRESENT]).not.toContain(outcome.value.reasonCode);
    expect(harness.cp.audit.forRun(runId).filter((row) => row.kind === "REVISION_RETURNED_TO_CTO")).toEqual([]);
    expect(harness.cp.outbox.listByRun(runId).filter((message) => message.kind === MessageKind.REVISION_REQUEST)).toEqual([]);
    expect(harness.cp.artifacts.list(runId, "BLIND_REVIEW")).toEqual([]);
    expectNotCeoReady(harness, runId, outcome.value.snapshotDigest, ceoSessionId);
  });
});

describe("#1189 §3: a new candidate never reuses an earlier PASS", () => {
  for (const next of ["REVISE", "UNAVAILABLE"] as const) {
    it(`a PASS on one candidate does not carry to the next, whose review is ${next}`, async () => {
      const harness = makeHarness();
      const driven = await driveToReviewedCandidate(harness);
      const ceoSessionId = harness.cp.bindings.active("CEO")!.sessionId;
      const passed = harness.cp.review.latestPacket(driven.runId, driven.candidateSnapshotDigest);
      expect(passed?.verdict).toBe("PASS");

      // The CTO changes the source after that PASS: a new candidate.
      writeFiles(harness.repoPath, { "src/app.js": "module.exports = () => 2; // changed after the pass\n" });
      commitAll(harness.repoPath, "change after the pass");
      if (next === "REVISE") {
        harness.scripted.script({ match: /Candidate review/, text: reviewerRevise([`${driven.identity}:src/app.js`], "regressed") });
      } else {
        harness.scripted.setRuntimeHealth("UNAVAILABLE");
      }
      const outcome = await harness.cp.pipeline.submitResult({
        runId: driven.runId,
        ownerSessionId: driven.ownerSessionId,
        ownerBindingGeneration: driven.ownerBindingGeneration,
        resultSummary: "the earlier review passed",
        recommendation: "merge",
      });
      if (!outcome.allowed) throw new Error(`${outcome.reasonCode}: ${outcome.message}`);
      expect(outcome.value.stage).toBe(next === "REVISE" ? "REVISION_REQUIRED" : "REVIEW_UNAVAILABLE");
      expect(outcome.value.snapshotDigest).not.toBe(driven.candidateSnapshotDigest);

      // The earlier PASS is superseded, and nothing current passes for the new candidate.
      const earlier = harness.cp.artifacts.byDigest(driven.blindReviewDigest)!;
      expect(earlier.superseded).toBe(true);
      expect(harness.cp.review.latestPacket(driven.runId, driven.candidateSnapshotDigest)).toBeNull();
      expect(harness.cp.review.latestPacket(driven.runId, outcome.value.snapshotDigest)?.verdict ?? null).not.toBe("PASS");
      expectNotCeoReady(harness, driven.runId, outcome.value.snapshotDigest, ceoSessionId);
      // Nor can the CEO confirm the candidate that did pass: it is no longer the run's.
      const stale = harness.cp.ceo.submitCeoDecision({
        runId: driven.runId,
        decision: "CONFIRM",
        candidateSnapshotDigest: driven.candidateSnapshotDigest,
        ceoSessionId,
        rationale: "it passed earlier",
      });
      expect(stale.allowed).toBe(false);
    });
  }
});

describe("#1189 §3: a return is never delivered to a stale CTO binding", () => {
  it("a valid revision left undelivered for want of a route, whose CTO is then replaced, goes to the new holder under the same id, claimed and completed once in ACP, and never to the replaced binding", async () => {
    const harness = makeHarness();
    const { projectId, runId, run, submit, covered } = await startRun(harness);
    harness.scripted.script({ match: /Candidate review/, text: reviewerRevise(covered, "a finding") });
    const outcome = await submit();
    expect(outcome.allowed && outcome.value.stage).toBe("REVISION_REQUIRED");
    const [queued] = harness.cp.outbox.listByRun(runId).filter((message) => message.kind === MessageKind.REVISION_REQUEST);
    expect(queued).toMatchObject({ status: "PENDING", bindingGeneration: 1 });
    const replaced = { sessionId: run.ownerSessionId!, incarnation: harness.cp.sessions.require(run.ownerSessionId!).incarnation };
    const failureOf = (messageId: string) =>
      harness.cp.db.get<{ failure_class: string | null }>("SELECT failure_class FROM outbox WHERE message_id = ?", [messageId])?.failure_class ?? null;

    // The replaced binding's runtime loses its Buzz route: the attempt sends nothing and is recorded as route-absent.
    harness.cp.sessions.setBuzzAddress(replaced.sessionId, null);
    expect((await harness.buzzAdapter.deliverPending()).failed).toContain(queued!.messageId);
    expect(harness.cp.outbox.get(queued!.messageId)).toMatchObject({ status: "PENDING", bindingGeneration: 1 });
    expect(failureOf(queued!.messageId)).toBe("repairable");

    const replacement = harness.cp.sessions.create({ provider: "scripted", model: "scripted-cto" });
    harness.cp.sessions.transition(replacement.sessionId, SessionLifecycle.READY, "replacement CTO");
    const switched = harness.cp.bindings.switchTo({
      role: Role.PRIMARY_CTO,
      projectId,
      sessionId: replacement.sessionId,
      reason: "the CTO is replaced",
      conversation: "REPLACED",
      takeover: true,
    });
    if (!switched.allowed) throw new Error(switched.message);
    expect(switched.value.bindingGeneration).toBe(2);
    const holder = { sessionId: replacement.sessionId, incarnation: harness.cp.sessions.require(replacement.sessionId).incarnation };

    // v51: the valid revision is handed to the authenticated current holder with its message id, re-armed.
    harness.cp.outbox.fenceUndeliverable();
    expect(harness.cp.outbox.get(queued!.messageId)).toMatchObject({
      status: "PENDING", bindingGeneration: 2, targetSessionId: replacement.sessionId,
    });
    expect(failureOf(queued!.messageId)).toBeNull();
    // The replaced binding is never handed it and cannot settle it.
    expect(harness.cp.outbox.acknowledge(queued!.messageId, replaced.sessionId, 1, replaced.incarnation).allowed).toBe(false);
    const claimed = harness.cp.outbox.claimDeliverable();
    expect(claimed.filter((message) => message.bindingGeneration === 1 || message.targetSessionId === replaced.sessionId)).toEqual([]);
    const revisions = claimed.filter((message) => message.kind === MessageKind.REVISION_REQUEST);
    expect(revisions).toEqual([expect.objectContaining({
      messageId: queued!.messageId, bindingGeneration: 2, targetSessionId: replacement.sessionId,
    })]);

    // Inside ACP, one claim and one completion for that id: once marked sent it is not handed out
    // again, and no second row carries the revision. (Delivery itself stays at-least-once.)
    expect(harness.cp.outbox.markSent(revisions[0]!.messageId, revisions[0]!.claimToken).allowed).toBe(true);
    expect(harness.cp.outbox.markSent(revisions[0]!.messageId, revisions[0]!.claimToken).allowed).toBe(false);
    harness.cp.outbox.fenceUndeliverable();
    expect(harness.cp.outbox.claimDeliverable().filter((message) => message.kind === MessageKind.REVISION_REQUEST)).toEqual([]);
    expect(harness.cp.outbox.listByRun(runId).filter((message) => message.kind === MessageKind.REVISION_REQUEST))
      .toEqual([expect.objectContaining({ messageId: queued!.messageId, status: "SENT", bindingGeneration: 2 })]);
    expect(harness.cp.outbox.acknowledge(queued!.messageId, replaced.sessionId, 1, replaced.incarnation).allowed).toBe(false);
    expect(harness.cp.outbox.acknowledge(queued!.messageId, holder.sessionId, 2, holder.incarnation).allowed).toBe(true);
    expect(harness.cp.outbox.get(queued!.messageId)).toMatchObject({ status: "ACKED", bindingGeneration: 2, targetSessionId: replacement.sessionId });
  });
});

describe("#1189 §3: a new reviewer judges only the candidate", () => {
  it("the next reviewer sees no earlier verdict, no producer claim and no CTO reasoning, and a 'fixed' claim passes nothing", async () => {
    const harness = makeHarness();
    const { runId, ceoSessionId, submit, covered } = await startRun(harness);
    const firstFinding = "first-round finding text zqvwk";
    harness.scripted.script({ match: /Candidate review/, text: reviewerRevise(covered, firstFinding) });
    expect((await submit("first producer summary xqzvj", "first recommendation wqzky"))).toMatchObject({
      allowed: true,
      value: { stage: "REVISION_REQUIRED" },
    });
    harness.scripted.script({ match: /Candidate review/, text: reviewerRevise(covered, "still wrong") });
    const second = await submit("All review findings are fixed zkqxw.", "merge now yqzjv");
    if (!second.allowed || second.value.stage !== "REVISION_REQUIRED") {
      throw new Error(`unexpected outcome: ${JSON.stringify(second).slice(0, 400)}`);
    }

    const prompts = harness.scripted.invocations.filter((call) => call.prompt.startsWith("# Candidate review"));
    expect(prompts).toHaveLength(2);
    const later = `${prompts[1]!.systemPrompt ?? ""}\n${prompts[1]!.prompt}`;
    const firstReview = harness.cp.artifacts.list<{ reviewerSessionId: string }>(runId, "BLIND_REVIEW")[0]!;
    for (const withheld of [
      firstFinding,
      firstReview.digest,
      firstReview.content.reviewerSessionId,
      // Markers spelt with letters no digest or id can contain, so a hash in the prompt cannot match them.
      "first producer summary xqzvj",
      "first recommendation wqzky",
      "zkqxw",
      "yqzjv",
    ]) {
      expect(later).not.toContain(withheld);
    }
    expect(prompts[1]!.externalSessionId).not.toBe(prompts[0]!.externalSessionId);
    expectNotCeoReady(harness, runId, second.value.snapshotDigest, ceoSessionId);
  });
});
