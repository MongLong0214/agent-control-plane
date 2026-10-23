import { afterAll, describe, expect, it } from "vitest";

import { ExecutionMode, RunKind } from "../../src/domain/types.ts";
import { readReviewRoundSources, summarizeReviewRounds } from "../../src/review/review-round-summary.ts";
import type { TaskContract } from "../../src/run/run-engine.ts";
import { bootstrapCoverageKeys, bootstrapPlan, cleanTreeManifest, reviewBootstrapPlan, submitBootstrapPlan } from "../helpers/bootstrap-plan.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import {
  applyFailingChange,
  bindCeo,
  bindWorker,
  dispatchBootstrapRun,
  makeHarness,
  registerFixtureProject,
  reviewerPass,
  reviewerRevise,
} from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * #1189 round-2 review witnesses (R1-01 replay paths), ported from the reviewer's probes with only
 * the test names prefixed, plus the two siblings the reviewer named (a verification return, the move
 * to CEO review). The reviewer is the harness's scripted one: scripted pipeline results, not live
 * evidence.
 */

async function setup() {
  const h = makeHarness();
  bindCeo(h);
  const created = h.cp.runs.create({ kind: RunKind.PROJECT_BOOTSTRAP, executionMode: ExecutionMode.STANDARD,
    contract: { goal: "bootstrap", why: "fixture", scope: [], nonGoals: [], acceptance: ["repository created"], priority: "NORMAL", humanGate: [], references: [] } });
  if (!created.allowed) throw new Error(created.message);
  const runId = created.value.runId;
  await dispatchBootstrapRun(h.cp, h.clock, runId);
  await submitBootstrapPlan(h, runId, bootstrapPlan(cleanTreeManifest("review-1192-r2")));
  const run = h.cp.runs.require(runId);
  const submit = () => h.cp.pipeline.submitResult({ runId, ownerSessionId: run.ownerSessionId!, ownerBindingGeneration: run.ownerBindingGeneration!, resultSummary: "outputs", recommendation: "create" });
  return { h, runId, submit };
}

describe("#1189 round-2 review witnesses", () => {
  it("R2-W1: a replayed unavailable row must not overwrite a later successful attempt", async () => {
    const { h, runId, submit } = await setup();
    h.scripted.setRuntimeHealth("UNAVAILABLE");
    expect(await submit()).toMatchObject({ allowed: true, value: { stage: "REVIEW_UNAVAILABLE" } });
    const unavailable = h.cp.audit.forRun(runId).find(row => row.kind === "BLIND_REVIEW_UNAVAILABLE")!;
    h.scripted.setRuntimeHealth("HEALTHY");
    h.scripted.script({ match: /Bootstrap plan review/, text: reviewerPass(bootstrapCoverageKeys(h, runId)) });
    expect(await submit()).toMatchObject({ allowed: true, value: { stage: "COMPLETED_REVIEW" } });
    expect(h.cp.audit.record({ ...unavailable, reasonCode: unavailable.reasonCode as never }).allowed).toBe(true);
    const result = summarizeReviewRounds(readReviewRoundSources(h.cp, runId));
    expect(result.rounds.map(round => round.outcome), JSON.stringify(result)).toEqual(["REVIEW_UNAVAILABLE", "REVIEW_PASSED"]);
  });

  it("R2-W2: a replayed unavailable row must not replace a retry's distinct failure reason", async () => {
    const { h, runId, submit } = await setup();
    h.scripted.setRuntimeHealth("UNAVAILABLE");
    expect(await submit()).toMatchObject({ allowed: true, value: { stage: "REVIEW_UNAVAILABLE" } });
    const unavailable = h.cp.audit.forRun(runId).find(row => row.kind === "BLIND_REVIEW_UNAVAILABLE")!;
    h.scripted.setRuntimeHealth("HEALTHY");
    let entered!: () => void;
    const hasEntered = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const invoke = h.scripted.invoke.bind(h.scripted);
    h.scripted.invoke = async request => {
      if (request.prompt.startsWith("# Bootstrap plan review")) { entered(); await held; }
      return invoke(request);
    };
    h.scripted.script({ match: /Bootstrap plan review/, text: "not a JSON verdict" });
    const second = submit();
    await hasEntered;
    expect(h.cp.audit.record({ ...unavailable, reasonCode: unavailable.reasonCode as never }).allowed).toBe(true);
    const during = summarizeReviewRounds(readReviewRoundSources(h.cp, runId));
    release();
    const actual = await second;
    expect(actual).toMatchObject({ allowed: true, value: { stage: "REVIEW_UNAVAILABLE" } });
    if (!actual.allowed || actual.value.stage !== "REVIEW_UNAVAILABLE") throw new Error("unexpected pipeline result");
    expect(actual.value.reasonCode).not.toBe(unavailable.reasonCode);
    const after = summarizeReviewRounds(readReviewRoundSources(h.cp, runId));
    expect(after.rounds[1]!.reasonCode, JSON.stringify({ actual: actual.value.reasonCode, rounds: after.rounds, unattributed: after.unattributedEvents })).toBe(actual.value.reasonCode);
    expect(during.rounds[1]!.outcome, JSON.stringify(during)).toBe("NO_OUTCOME_RECORDED");
  });

  it("R2-W2 detail: the replay is listed while the retry runs, and a repeat of round 1 once it fails on its own", async () => {
    const { h, runId, submit } = await setup();
    h.scripted.setRuntimeHealth("UNAVAILABLE");
    expect(await submit()).toMatchObject({ allowed: true, value: { stage: "REVIEW_UNAVAILABLE" } });
    const unavailable = h.cp.audit.forRun(runId).find(row => row.kind === "BLIND_REVIEW_UNAVAILABLE")!;
    h.scripted.setRuntimeHealth("HEALTHY");
    let entered!: () => void;
    const hasEntered = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const invoke = h.scripted.invoke.bind(h.scripted);
    h.scripted.invoke = async request => {
      if (request.prompt.startsWith("# Bootstrap plan review")) { entered(); await held; }
      return invoke(request);
    };
    h.scripted.script({ match: /Bootstrap plan review/, text: "not a JSON verdict" });
    const second = submit();
    await hasEntered;
    const replayed = h.cp.audit.record({ ...unavailable, reasonCode: unavailable.reasonCode as never });
    const during = summarizeReviewRounds(readReviewRoundSources(h.cp, runId));
    release();
    await second;
    const after = summarizeReviewRounds(readReviewRoundSources(h.cp, runId));
    expect(during.unattributedEvents).toEqual([{ eventId: replayed.allowed ? replayed.value : -1, kind: "BLIND_REVIEW_UNAVAILABLE", candidateRounds: [1, 2] }]);
    expect(after.unattributedEvents).toEqual([]);
    expect(after.rounds.map((round) => [round.outcome, round.reasonCode, round.duplicateEventsIgnored])).toEqual([
      ["REVIEW_UNAVAILABLE", unavailable.reasonCode, 1],
      ["REVIEW_UNAVAILABLE", "EVIDENCE_MISSING", 0],
    ]);
  });

  it("R2-W3: replaying a binding must not erase the first findings", async () => {
    const { h, runId, submit } = await setup();
    const covered = bootstrapCoverageKeys(h, runId);
    h.scripted.script({ match: /Bootstrap plan review/, text: reviewerRevise(covered, "first defect") });
    expect(await submit()).toMatchObject({ allowed: true, value: { stage: "REVISION_REQUIRED" } });
    const binding = h.cp.audit.forRun(runId).find(row => row.kind === "BINDING_CREATED" && row.roleKey?.startsWith("BLIND_REVIEWER:"))!;
    h.scripted.script({ match: /Bootstrap plan review/, text: reviewerRevise(covered, "second defect") });
    expect(await submit()).toMatchObject({ allowed: true, value: { stage: "REVISION_REQUIRED" } });
    const before = summarizeReviewRounds(readReviewRoundSources(h.cp, runId));
    expect(before.firstFindings?.findings.map(f => f.summary)).toEqual(["first defect"]);
    expect(h.cp.audit.record({ ...binding, reasonCode: binding.reasonCode as never }).allowed).toBe(true);
    const after = summarizeReviewRounds(readReviewRoundSources(h.cp, runId));
    expect(after.firstFindings?.findings.map(f => f.summary), JSON.stringify(after)).toEqual(["first defect"]);
    expect(after.rounds.map(round => round.review?.findings.map(f => f.summary))).toEqual([["first defect"], ["second defect"]]);
  });
});

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

/** A held promise and the hooks to observe and release it. */
const hold = () => {
  let entered!: () => void;
  const hasEntered = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  return { entered, hasEntered, release, held };
};

describe("#1189 round-2 siblings: identity-free records replayed while a retry runs", () => {
  it("R2-S1: a replayed verification return is not the retry's, during it or after it", async () => {
    const h = makeHarness();
    const { projectId, repositoryId } = await registerFixtureProject(h);
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
    const head = applyFailingChange(h.repoPath);
    h.cp.tasks.finishExecution(execution.value.executionId, { status: "SUCCEEDED", resultDigest: `sha256:${head}` });
    const submit = () =>
      h.cp.pipeline.submitResult({
        runId,
        ownerSessionId: run.ownerSessionId!,
        ownerBindingGeneration: run.ownerBindingGeneration!,
        resultSummary: "app() now returns 2",
        recommendation: "merge",
      });

    expect(await submit()).toMatchObject({ allowed: true, value: { stage: "VERIFICATION_FAILED" } });
    const returned = h.cp.audit.forRun(runId).find((row) => row.kind === "REVISION_RETURNED_TO_CTO")!;
    // The same candidate again, its verification held; time passes, so its report is its own.
    h.clock.advance(60_000);
    const gate = hold();
    const verify = h.cp.verification.verify.bind(h.cp.verification);
    h.cp.verification.verify = async (input) => {
      gate.entered();
      await gate.held;
      return verify(input);
    };
    const second = submit();
    await gate.hasEntered;
    expect(h.cp.audit.record({ ...returned, reasonCode: returned.reasonCode as never }).allowed).toBe(true);
    const during = summarizeReviewRounds(readReviewRoundSources(h.cp, runId));
    gate.release();
    expect(await second).toMatchObject({ allowed: true, value: { stage: "VERIFICATION_FAILED" } });
    const after = summarizeReviewRounds(readReviewRoundSources(h.cp, runId));

    expect(during.rounds.map((round) => round.outcome), JSON.stringify(during.rounds)).toEqual(["VERIFICATION_RETURNED", "NO_OUTCOME_RECORDED"]);
    expect(during.rounds[1]!.deliveries).toEqual([]);
    expect(after.rounds.map((round) => [round.entry, round.outcome]), JSON.stringify(after.rounds)).toEqual([
      ["FIRST_SUBMISSION", "VERIFICATION_RETURNED"],
      ["SAME_CANDIDATE_RESUBMISSION", "VERIFICATION_RETURNED"],
    ]);
    const [first, retry] = after.rounds;
    expect(first!.deliveries).toHaveLength(1);
    expect(retry!.deliveries).toHaveLength(1);
    expect(retry!.deliveries[0]!.messageId).not.toBe(first!.deliveries[0]!.messageId);
    expect(retry!.attemptId).not.toBe(first!.attemptId);
    expect(after.totals).toMatchObject({ verificationReturns: 2 });
    // While the retry ran, the replay could have been either attempt's: listed, placed on neither.
    const replayed = during.unattributedEvents.find((event) => event.kind === "REVISION_RETURNED_TO_CTO");
    expect(replayed?.candidateRounds).toEqual([1, 2]);
    // Once the retry holds its own return, the replay can only repeat round 1's.
    expect(after.unattributedEvents).toEqual([]);
    expect(after.rounds.map((round) => round.duplicateEventsIgnored)).toEqual([1, 0]);
  });

  it("R2-S2: a replayed move to CEO review does not make a retry under review CEO-ready", async () => {
    const { h, runId } = await setup();
    const plan = bootstrapPlan(cleanTreeManifest("review-1192-r2"));
    const reviewed = await reviewBootstrapPlan(h, runId, plan);
    const ready = h.cp.audit.forRun(runId).find((row) => row.kind === "RUN_TRANSITION" && row.evidence["to"] === "READY_FOR_CEO_REVIEW")!;
    await h.cp.continuity.evaluate("bootstrap revision");
    expect(h.cp.ceo.submitCeoDecision({
      runId,
      decision: "FINAL_REVISE",
      candidateSnapshotDigest: reviewed.snapshotDigest,
      ceoSessionId: reviewed.ceoSessionId,
      rationale: "revise",
    }).allowed).toBe(true);
    expect((await h.cp.runs.dispatch(runId)).allowed).toBe(true);
    // The same PLAN again: the same candidate, reviewed afresh, the review held.
    await submitBootstrapPlan(h, runId, plan);
    const gate = hold();
    const invoke = h.scripted.invoke.bind(h.scripted);
    h.scripted.invoke = async (request) => {
      if (request.prompt.startsWith("# Bootstrap plan review")) {
        gate.entered();
        await gate.held;
      }
      return invoke(request);
    };
    h.scripted.script({ match: /Bootstrap plan review/, text: reviewerPass(bootstrapCoverageKeys(h, runId)) });
    const run = h.cp.runs.require(runId);
    const second = h.cp.pipeline.submitResult({
      runId,
      ownerSessionId: run.ownerSessionId!,
      ownerBindingGeneration: run.ownerBindingGeneration!,
      resultSummary: "outputs",
      recommendation: "create",
    });
    await gate.hasEntered;
    expect(h.cp.audit.record({ ...ready, reasonCode: ready.reasonCode as never }).allowed).toBe(true);
    const during = summarizeReviewRounds(readReviewRoundSources(h.cp, runId));
    gate.release();
    expect(await second).toMatchObject({ allowed: true, value: { stage: "COMPLETED_REVIEW" } });
    const after = summarizeReviewRounds(readReviewRoundSources(h.cp, runId));

    expect(during.rounds.map((round) => round.candidateSnapshotDigest)).toEqual([reviewed.snapshotDigest, reviewed.snapshotDigest]);
    expect(during.rounds.map((round) => [round.outcome, round.readyForCeo]), JSON.stringify(during.rounds)).toEqual([
      ["REVIEW_PASSED", true],
      ["NO_OUTCOME_RECORDED", false],
    ]);
    expect(after.rounds.map((round) => [round.outcome, round.readyForCeo]), JSON.stringify(after.rounds)).toEqual([
      ["REVIEW_PASSED", true],
      ["REVIEW_PASSED", true],
    ]);
    expect(after.rounds[0]!.review!.reviewerSessionId).not.toBe(after.rounds[1]!.review!.reviewerSessionId);
  });
});

describe("#1189 round-2 siblings: what a round holds first stays", () => {
  it("R2-S3: a later record naming round 1's reviewer cannot replace round 1's review or the first findings", async () => {
    const { h, runId, submit } = await setup();
    const covered = bootstrapCoverageKeys(h, runId);
    h.scripted.script({ match: /Bootstrap plan review/, text: reviewerRevise(covered, "first defect") });
    expect(await submit()).toMatchObject({ allowed: true, value: { stage: "REVISION_REQUIRED" } });
    const completed = h.cp.audit.forRun(runId).find((row) => row.kind === "BLIND_REVIEW_COMPLETED")!;
    h.scripted.script({ match: /Bootstrap plan review/, text: reviewerRevise(covered, "second defect") });
    expect(await submit()).toMatchObject({ allowed: true, value: { stage: "REVISION_REQUIRED" } });
    const before = summarizeReviewRounds(readReviewRoundSources(h.cp, runId));
    // A completion naming round 1's reviewer, but with another verdict.
    const conflicting = h.cp.audit.record({
      ...completed,
      reasonCode: "REVIEW_PASS" as never,
      evidence: { ...completed.evidence, verdict: "PASS" },
    });
    expect(conflicting.allowed).toBe(true);
    const after = summarizeReviewRounds(readReviewRoundSources(h.cp, runId));
    expect(after.rounds).toEqual(before.rounds);
    expect(after.firstFindings).toEqual(before.firstFindings);
    expect(after.unattributedEvents).toEqual([{ eventId: conflicting.allowed ? conflicting.value : -1, kind: "BLIND_REVIEW_COMPLETED", candidateRounds: [1] }]);
  });

  it("R2-S4: a retry that fails with a record identical to the earlier attempt's is listed, not guessed", async () => {
    const { h, runId, submit } = await setup();
    h.scripted.setRuntimeHealth("UNAVAILABLE");
    expect(await submit()).toMatchObject({ allowed: true, value: { stage: "REVIEW_UNAVAILABLE" } });
    expect(await submit()).toMatchObject({ allowed: true, value: { stage: "REVIEW_UNAVAILABLE" } });
    const rows = h.cp.audit.forRun(runId).filter((row) => row.kind === "BLIND_REVIEW_UNAVAILABLE");
    expect(rows).toHaveLength(2);
    const result = summarizeReviewRounds(readReviewRoundSources(h.cp, runId));
    expect(result.rounds.map((round) => [round.entry, round.outcome])).toEqual([
      ["FIRST_SUBMISSION", "REVIEW_UNAVAILABLE"],
      ["INFRASTRUCTURE_RETRY", "NO_OUTCOME_RECORDED"],
    ]);
    expect(result.unattributedEvents).toEqual([{ eventId: rows[1]!.eventId, kind: "BLIND_REVIEW_UNAVAILABLE", candidateRounds: [1, 2] }]);
  });
});
