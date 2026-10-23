import { afterAll, describe, expect, it } from "vitest";

import { digestOf } from "../../src/core/digest.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ExecutionMode, Role, RunKind, RunState, SessionLifecycle } from "../../src/domain/types.ts";
import type { ReviewPacket } from "../../src/review/blind-review.ts";
import {
  type FindingDisposition,
  readReviewRoundSources,
  summarizeReviewRounds,
} from "../../src/review/review-round-summary.ts";
import type { TaskContract } from "../../src/run/run-engine.ts";
import { bootstrapPlan, cleanTreeManifest, replanBootstrap, reviewBootstrapPlan } from "../helpers/bootstrap-plan.ts";
import { cleanupTempDirs, commitAll, writeFiles } from "../helpers/fixtures.ts";
import {
  type Harness,
  applyFailingChange,
  applyPassingChange,
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
 * #1189 §2.C — the review-round summary, read from the records a real run leaves: the audit trail,
 * the run's artifacts, its outbox and its submission lease. Every run here is driven through the
 * production pipeline and review gate with the harness's scripted reviewer, so every review JSON is
 * a test fixture: these are scripted pipeline results, never live reviewer evidence.
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

/** A dispatched STANDARD run whose one task's worker committed `change`, ready for result_submit. */
const startRun = async (harness: Harness, change: "passing" | "failing" = "passing") => {
  const { projectId, repositoryId, identity } = await registerFixtureProject(harness);
  bindCeo(harness);
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
  const head = change === "passing" ? applyPassingChange(harness.repoPath) : applyFailingChange(harness.repoPath);
  harness.cp.tasks.finishExecution(execution.value.executionId, { status: "SUCCEEDED", resultDigest: `sha256:${head}` });
  const submit = (resultSummary = "app() now returns 2") =>
    harness.cp.pipeline.submitResult({
      runId,
      ownerSessionId: run.ownerSessionId!,
      ownerBindingGeneration: run.ownerBindingGeneration!,
      resultSummary,
      recommendation: "merge",
    });
  return { projectId, identity, runId, run, submit, covered: [`${identity}:src/app.js`] };
};

const stageOf = (outcome: Awaited<ReturnType<Awaited<ReturnType<typeof startRun>>["submit"]>>): string =>
  outcome.allowed ? outcome.value.stage : `DENIED ${outcome.reasonCode}`;

const summaryOf = (harness: Harness, runId: string, dispositions?: FindingDisposition[]) =>
  summarizeReviewRounds(readReviewRoundSources(harness.cp, runId), dispositions ? { dispositions } : {});

/** A real fix: a new commit on the candidate's branch, so the next freeze is a new candidate. */
const commitFix = (harness: Harness, note: string): void => {
  writeFiles(harness.repoPath, { "src/app.js": `module.exports = () => 2; // ${note}\n` });
  commitAll(harness.repoPath, note);
};

describe("#1189 §2.C: a run's review rounds, from existing records", () => {
  it("tells an unchanged-candidate resubmission, a provider failure, its retry and a real fix apart, and keeps the first findings", async () => {
    const harness = makeHarness();
    const { runId, submit, covered } = await startRun(harness);

    harness.scripted.script({ match: /Candidate review/, text: reviewerRevise(covered, "first finding: app() ignores its input") });
    expect(stageOf(await submit())).toBe("REVISION_REQUIRED");
    // The CTO resubmits the same candidate; a fresh reviewer judges it again.
    harness.scripted.script({ match: /Candidate review/, text: reviewerRevise(covered, "second finding on the same candidate") });
    expect(stageOf(await submit())).toBe("REVISION_REQUIRED");
    // The reviewer's runtime is down: assurance cannot be constituted.
    harness.scripted.setRuntimeHealth("UNAVAILABLE");
    expect(stageOf(await submit())).toBe("REVIEW_UNAVAILABLE");
    harness.scripted.setRuntimeHealth("HEALTHY");
    // The same candidate again once the provider is back.
    harness.scripted.script({ match: /Candidate review/, text: reviewerRevise(covered, "third finding after the outage") });
    expect(stageOf(await submit())).toBe("REVISION_REQUIRED");
    // A real source change, judged by a fresh reviewer, passes.
    commitFix(harness, "address the review");
    harness.scripted.script({ match: /Candidate review/, text: reviewerPass(covered) });
    expect(stageOf(await submit())).toBe("COMPLETED_REVIEW");

    const summary = summaryOf(harness, runId);
    const [r1, r2, r3, r4, r5] = summary.rounds;
    expect(summary.rounds.map((round) => [round.entry, round.outcome])).toEqual([
      ["FIRST_SUBMISSION", "REVISION_RETURNED"],
      ["SAME_CANDIDATE_RESUBMISSION", "REVISION_RETURNED"],
      ["SAME_CANDIDATE_RESUBMISSION", "REVIEW_UNAVAILABLE"],
      ["INFRASTRUCTURE_RETRY", "REVISION_RETURNED"],
      ["SOURCE_CHANGE", "REVIEW_PASSED"],
    ]);
    expect(summary.totals).toMatchObject({
      rounds: 5,
      reviews: 4,
      reviewerInvocations: 4,
      revisionReturns: 3,
      reviewUnavailable: 1,
      sameCandidateResubmissions: 2,
      infrastructureRetries: 1,
      sourceChanges: 1,
      duplicateEventsIgnored: 0,
    });

    // One candidate for rounds 1–4; its next real new candidate is round 5's, which is current.
    expect(new Set([r1, r2, r3, r4].map((round) => round!.candidateSnapshotDigest)).size).toBe(1);
    expect(r5!.candidateSnapshotDigest).not.toBe(r1!.candidateSnapshotDigest);
    expect(summary.currentCandidateDigest).toBe(r5!.candidateSnapshotDigest);
    for (const round of [r1, r2, r3, r4]) {
      expect(round!.nextNewCandidate).toEqual({ round: 5, candidateSnapshotDigest: r5!.candidateSnapshotDigest });
    }
    expect(r5!.nextNewCandidate).toBeNull();
    expect(r5!.readyForCeo).toBe(true);
    expect([r1, r2, r3, r4].some((round) => round!.readyForCeo)).toBe(false);

    // The provider failure is not a code-fix verdict: no review, no return, no delivery.
    expect(r3!.review).toBeNull();
    expect(r3!.reasonCode).toBe(ReasonCode.ISOLATION_LOST);
    expect(r3!.deliveries).toEqual([]);

    // Each return names its own stored review and its own delivery to the CTO bound now.
    for (const round of [r1, r2, r4]) {
      expect(round!.reasonCode).toBe(ReasonCode.REVIEW_REVISE);
      expect(round!.review).toMatchObject({ verdict: "REVISE", chunked: false, reviewerInvocations: 1 });
      const artifact = harness.cp.artifacts.byDigest<ReviewPacket>(round!.review!.artifactDigest!)!;
      expect(artifact.producedBy).toBe("blind-review-gate");
      expect(artifact.candidateSnapshotDigest).toBe(round!.candidateSnapshotDigest);
      expect(round!.deliveries).toHaveLength(1);
      expect(round!.deliveries[0]).toMatchObject({ status: "PENDING", toCurrentBinding: true, acknowledged: false });
      expect(round!.attemptId).toBe(round!.deliveries[0]!.attemptId);
    }
    expect(new Set([r1, r2, r4].map((round) => round!.review!.reviewerSessionId)).size).toBe(3);
    expect(new Set([r1, r2, r4].map((round) => round!.attemptId)).size).toBe(3);
    // The last round's attempt is the lease row's, the only attempt that row keeps.
    expect(r5!.attemptId).toBe(summary.latestAttempt!.attemptId);
    expect(summary.latestAttempt).toMatchObject({ state: "RELEASED", candidateDigest: r5!.candidateSnapshotDigest });

    // The first findings are kept as the first reviewer returned them, though a later round passed.
    expect(summary.firstFindings?.round).toBe(1);
    expect(summary.firstFindings?.findings.map((finding) => finding.summary)).toEqual(["first finding: app() ignores its input"]);
    const returnedRow = harness.cp.audit.byKind("REVISION_RETURNED_TO_CTO").find((row) => row.runId === runId)!;
    expect(summary.firstFindings?.findings.map((finding) => finding.digest)).toEqual(returnedRow.evidence["findingDigests"]);
  });

  it("counts a chunked review — its chunk reviewers and the final reviewer — as one round", async () => {
    const harness = makeHarness();
    const { runId, submit, covered } = await startRun(harness);
    writeFiles(harness.repoPath, { "src/app.js": `module.exports = () => 2;\n// ${"x".repeat(130_000)}\n` });
    commitAll(harness.repoPath, "large reviewed change");
    harness.scripted.script(
      { match: /Review chunk/, text: reviewerPass(covered), once: false },
      { match: /Final review/, text: reviewerPass([]) },
    );
    expect(stageOf(await submit())).toBe("COMPLETED_REVIEW");
    const chunkCalls = harness.scripted.invocations.filter((call) => call.prompt.startsWith("# Review chunk")).length;
    const finalCalls = harness.scripted.invocations.filter((call) => call.prompt.startsWith("# Final review")).length;
    expect(chunkCalls).toBeGreaterThan(1);
    expect(finalCalls).toBe(1);
    const summary = summaryOf(harness, runId);
    // Every reviewer invocation took its own reviewer binding generation: a count of those is not a
    // count of rounds.
    const stored = harness.cp.artifacts.byDigest<ReviewPacket>(summary.rounds[0]!.review!.artifactDigest!)!;
    expect(stored.content.reviewerRoleBindingGeneration).toBe(chunkCalls + finalCalls);
    expect(summary.totals).toMatchObject({ rounds: 1, reviews: 1, reviewerInvocations: chunkCalls + finalCalls });
    expect(summary.rounds[0]).toMatchObject({
      entry: "FIRST_SUBMISSION",
      outcome: "REVIEW_PASSED",
      readyForCeo: true,
      review: { verdict: "PASS", chunked: true, reviewerInvocations: chunkCalls + finalCalls },
    });
  });

  it("counts an outcome repeated within one attempt once", async () => {
    const harness = makeHarness();
    const { runId, submit, covered } = await startRun(harness);
    harness.scripted.script({ match: /Candidate review/, text: reviewerRevise(covered, "a finding") });
    expect(stageOf(await submit())).toBe("REVISION_REQUIRED");
    const before = summaryOf(harness, runId);

    // The same attempt's review and return rows written again, as a replay would.
    for (const kind of ["BLIND_REVIEW_COMPLETED", "REVISION_RETURNED_TO_CTO"]) {
      const row = harness.cp.audit.forRun(runId).find((entry) => entry.kind === kind)!;
      const replayed = harness.cp.audit.record({
        kind,
        runId,
        sessionId: row.sessionId,
        roleKey: row.roleKey,
        reasonCode: row.reasonCode as never,
        evidence: row.evidence,
      });
      expect(replayed.allowed).toBe(true);
    }
    expect(harness.cp.audit.forRun(runId).filter((row) => row.kind === "REVISION_RETURNED_TO_CTO")).toHaveLength(2);

    const after = summaryOf(harness, runId);
    expect(after.totals).toMatchObject({ rounds: 1, reviews: 1, revisionReturns: 1, duplicateEventsIgnored: 2 });
    expect(after.rounds[0]!.deliveries).toHaveLength(1);
    expect({ ...after.rounds[0], duplicateEventsIgnored: 0 }).toEqual(before.rounds[0]);
  });

  it("links a verification return to its delivery, and the fix after it to a new candidate", async () => {
    const harness = makeHarness();
    const { runId, submit, covered } = await startRun(harness, "failing");
    expect(stageOf(await submit())).toBe("VERIFICATION_FAILED");
    commitFix(harness, "make verification pass");
    harness.scripted.script({ match: /Candidate review/, text: reviewerPass(covered) });
    expect(stageOf(await submit())).toBe("COMPLETED_REVIEW");

    const [failed, fixed] = summaryOf(harness, runId).rounds;
    expect(failed).toMatchObject({ entry: "FIRST_SUBMISSION", outcome: "VERIFICATION_RETURNED", review: null, readyForCeo: false });
    expect(failed!.deliveries).toHaveLength(1);
    expect(failed!.deliveries[0]!.toCurrentBinding).toBe(true);
    expect(fixed).toMatchObject({ entry: "SOURCE_CHANGE", outcome: "REVIEW_PASSED", readyForCeo: true });
    expect(failed!.nextNewCandidate?.candidateSnapshotDigest).toBe(fixed!.candidateSnapshotDigest);
  });

  it("shows a return whose CTO binding was replaced as not delivered to the binding now", async () => {
    const harness = makeHarness();
    const { projectId, runId, submit, covered } = await startRun(harness);
    harness.scripted.script({ match: /Candidate review/, text: reviewerRevise(covered, "a finding") });
    expect(stageOf(await submit())).toBe("REVISION_REQUIRED");
    expect(summaryOf(harness, runId).rounds[0]!.deliveries[0]).toMatchObject({ bindingGeneration: 1, toCurrentBinding: true });

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

    const summary = summaryOf(harness, runId);
    expect(summary.ownerBinding).toMatchObject({ bindingGeneration: 2, sessionId: replacement.sessionId });
    expect(summary.rounds[0]!.deliveries).toHaveLength(1);
    expect(summary.rounds[0]!.deliveries[0]).toMatchObject({
      bindingGeneration: 1,
      status: "REJECTED",
      toCurrentBinding: false,
      acknowledged: false,
    });
  });

  it("lists an escalation before the round it preceded", async () => {
    const harness = makeHarness();
    const { runId, run, submit, covered } = await startRun(harness);
    harness.scripted.script({ match: /Candidate review/, text: reviewerRevise(covered, "a finding") });
    expect(stageOf(await submit())).toBe("REVISION_REQUIRED");
    const escalated = harness.cp.ceo.openEscalation({
      runId,
      question: "Is the finding in scope?",
      options: ["fix it", "defer it"],
      ctoRecommendation: "fix it",
      whyItMatters: "it changes the public behaviour",
      blocksCriticalPath: false,
      openedBySessionId: run.ownerSessionId!,
      openedAt: harness.clock.nowIso(),
    });
    expect(escalated.allowed, JSON.stringify(escalated)).toBe(true);
    commitFix(harness, "fix after the escalation");
    harness.scripted.script({ match: /Candidate review/, text: reviewerPass(covered) });
    expect(stageOf(await submit())).toBe("COMPLETED_REVIEW");

    const summary = summaryOf(harness, runId);
    expect(summary.rounds.map((round) => round.interventions.map((entry) => entry.kind))).toEqual([[], ["CTO_ESCALATION"]]);
    expect(summary.rounds[1]!.entry).toBe("SOURCE_CHANGE");
    expect(summary.totals.roundsWithIntervention).toBe(1);
  });

  it("a CEO's FINAL_REVISE is an intervention, and the new PLAN candidate is reviewed afresh", async () => {
    const harness = makeHarness();
    bindCeo(harness);
    const created = harness.cp.runs.create({
      kind: RunKind.PROJECT_BOOTSTRAP,
      executionMode: ExecutionMode.STANDARD,
      contract: { ...CONTRACT, goal: "bootstrap", scope: [], acceptance: ["repository created"] },
    });
    if (!created.allowed) throw new Error(created.message);
    const runId = created.value.runId;
    await dispatchBootstrapRun(harness.cp, harness.clock, runId);
    const first = await reviewBootstrapPlan(harness, runId, bootstrapPlan(cleanTreeManifest("i1189-round")));
    await replanBootstrap(harness, runId, first, bootstrapPlan(cleanTreeManifest("i1189-round"), { summary: "a revised plan" }));

    const summary = summaryOf(harness, runId);
    expect(summary.rounds.map((round) => [round.entry, round.outcome, round.readyForCeo])).toEqual([
      ["FIRST_SUBMISSION", "REVIEW_PASSED", true],
      ["SOURCE_CHANGE", "REVIEW_PASSED", true],
    ]);
    expect(summary.rounds[1]!.interventions.map((entry) => entry.kind)).toContain("CEO_DECISION");
    expect(summary.rounds.map((round) => round.review?.reviewKind)).toEqual(["BOOTSTRAP_PLAN", "BOOTSTRAP_PLAN"]);
    expect(summary.rounds[0]!.review!.reviewerSessionId).not.toBe(summary.rounds[1]!.review!.reviewerSessionId);
    expect(harness.cp.runs.require(runId).state).toBe(RunState.READY_FOR_CEO_REVIEW);
  });
});

describe("#1189 §2.C: dispositions are linked notes, never verdicts", () => {
  it("a FIXED disposition and a CTO's 'fixed' claim leave every verdict, outcome and readiness as recorded", async () => {
    const harness = makeHarness();
    const { runId, submit, covered } = await startRun(harness);
    harness.scripted.script({ match: /Candidate review/, text: reviewerRevise(covered, "the finding") });
    expect(stageOf(await submit())).toBe("REVISION_REQUIRED");
    // The CTO says everything is fixed and resubmits the unchanged candidate; a fresh reviewer disagrees.
    harness.scripted.script({ match: /Candidate review/, text: reviewerRevise(covered, "still wrong") });
    expect(stageOf(await submit("All review findings are fixed."))).toBe("REVISION_REQUIRED");

    const plain = summaryOf(harness, runId);
    const findingDigests = plain.rounds.flatMap((round) => round.review?.findings.map((finding) => finding.digest) ?? []);
    expect(findingDigests).toHaveLength(2);
    const dispositions: FindingDisposition[] = [
      ...findingDigests.map((findingDigest) => ({ findingDigest, disposition: "FIXED" as const, note: "fixed", recordedBy: "cto" })),
      // A string hash that names no finding: the candidate digest itself.
      { findingDigest: plain.rounds[1]!.candidateSnapshotDigest!, disposition: "FIXED", note: "close the gate", recordedBy: "someone" },
    ];
    const annotated = summaryOf(harness, runId, dispositions);

    // The dispositions are attached and shown, and nothing else moves.
    for (const round of annotated.rounds) {
      for (const finding of round.review!.findings) expect(finding.dispositions.map((entry) => entry.disposition)).toEqual(["FIXED"]);
    }
    expect(annotated.unlinkedDispositions.map((entry) => entry.note)).toEqual(["close the gate"]);
    const strip = (summary: typeof plain) => ({
      ...summary,
      unlinkedDispositions: [],
      firstFindings: null,
      rounds: summary.rounds.map((round) => ({
        ...round,
        review: round.review && { ...round.review, findings: round.review.findings.map((finding) => ({ ...finding, dispositions: [] })) },
      })),
    });
    expect(strip(annotated)).toEqual(strip(plain));
    expect(annotated.rounds.map((round) => [round.entry, round.outcome, round.review?.verdict, round.readyForCeo])).toEqual([
      ["FIRST_SUBMISSION", "REVISION_RETURNED", "REVISE", false],
      ["SAME_CANDIDATE_RESUBMISSION", "REVISION_RETURNED", "REVISE", false],
    ]);

    // Nothing the projection was given reaches the run: it is still ACTIVE and has no CEO packet.
    expect(harness.cp.runs.require(runId).state).toBe(RunState.ACTIVE);
    expect(harness.cp.artifacts.list(runId, "PRODUCTION_READY_PACKET")).toEqual([]);
    expect(digestOf(readReviewRoundSources(harness.cp, runId).artifacts)).toBe(digestOf(harness.cp.artifacts.list(runId)));
  });

  it("reads and never writes", async () => {
    const harness = makeHarness();
    const { runId, submit, covered } = await startRun(harness);
    harness.scripted.script({ match: /Candidate review/, text: reviewerRevise(covered, "a finding") });
    expect(stageOf(await submit())).toBe("REVISION_REQUIRED");
    const counts = () =>
      ["audit_events", "run_artifacts", "outbox", "candidate_pipeline_attempts", "assignments", "runs"].map(
        (table) => harness.cp.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)!.n,
      );
    const changesBefore = harness.cp.db.get<{ n: number }>("SELECT total_changes() AS n")!.n;
    const before = counts();
    summaryOf(harness, runId, [{ findingDigest: "sha256:none", disposition: "DEFERRED", note: "later", recordedBy: "cto" }]);
    expect(counts()).toEqual(before);
    expect(harness.cp.db.get<{ n: number }>("SELECT total_changes() AS n")!.n).toBe(changesBefore);
  });
});
