import { afterAll, describe, expect, it } from "vitest";

import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ExecutionMode, RunState, TaskState } from "../../src/domain/types.ts";
import { candidateSnapshotDigest } from "../../src/snapshot/candidate-snapshot.ts";
import type { TaskContract } from "../../src/run/run-engine.ts";
import { cleanupTempDirs, commitAll, writeFiles } from "../helpers/fixtures.ts";
import {
  type Harness,
  applyFailingChange,
  applyPassingChange,
  bindCeo,
  makeHarness,
  registerFixtureProject,
  reviewerPass,
  reviewerRevise,
} from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

const CONTRACT: TaskContract = {
  goal: "make app() return 2",
  why: "downstream callers expect 2",
  scope: ["src/app.js"],
  nonGoals: ["public api changes"],
  acceptance: ["verify.js exits 0"],
  priority: "NORMAL",
  humanGate: [],
  references: [],
};

const drive = async (
  harness: Harness,
  options: { failing?: boolean; reviewerVerdict?: "PASS" | "REVISE" } = {},
) => {
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

  const tasks = harness.cp.tasks.submit(runId, [
    { key: "impl", title: "change app()", category: "implementation" },
    { key: "test", title: "confirm verification", category: "test", dependsOn: ["impl"] },
  ]);
  if (!tasks.allowed) throw new Error(tasks.message);

  // The worker performs the actual repository change, under the run's owner generation.
  const impl = harness.cp.tasks.ready(runId)[0]!;
  const execution = harness.cp.tasks.startExecution({
    runId,
    taskId: impl.taskId,
    ownerBindingGeneration: run.ownerBindingGeneration!,
    workerSessionId: run.ownerSessionId,
    provider: "scripted",
    model: "scripted-worker",
    repositoryId,
  });
  if (!execution.allowed) throw new Error(execution.message);

  const head = options.failing
    ? applyFailingChange(harness.repoPath)
    : applyPassingChange(harness.repoPath);

  harness.cp.tasks.finishExecution(execution.value.executionId, {
    status: "SUCCEEDED",
    resultDigest: `sha256:${head}`,
  });

  const second = harness.cp.tasks.ready(runId)[0]!;
  const secondExecution = harness.cp.tasks.startExecution({
    runId,
    taskId: second.taskId,
    ownerBindingGeneration: run.ownerBindingGeneration!,
    workerSessionId: run.ownerSessionId,
    provider: "scripted",
    model: "scripted-worker",
    repositoryId,
  });
  if (!secondExecution.allowed) throw new Error(secondExecution.message);
  harness.cp.tasks.finishExecution(secondExecution.value.executionId, { status: "SUCCEEDED", resultDigest: "sha256:task-report" });

  harness.scripted.script({
    match: /Candidate review/,
    text:
      options.reviewerVerdict === "REVISE"
        ? reviewerRevise([`${identity}:src/app.js`], "return value is not what the contract asks for")
        : reviewerPass([`${identity}:src/app.js`]),
  });

  const outcome = await harness.cp.pipeline.submitResult({
    runId,
    ownerSessionId: run.ownerSessionId!,
    ownerBindingGeneration: run.ownerBindingGeneration!,
    resultSummary: "app() now returns 2",
    recommendation: "merge",
  });

  return { runId, projectId, repositoryId, identity, run, outcome };
};

describe("one safe project run, end to end", () => {
  it("registers a project manually and drives contract → verification → blind review → packet", async () => {
    const harness = makeHarness();
    const { runId, outcome } = await drive(harness);

    expect(outcome.allowed).toBe(true);
    if (!outcome.allowed) return;
    expect(outcome.value.stage).toBe("COMPLETED_REVIEW");
    if (outcome.value.stage !== "COMPLETED_REVIEW") return;

    const packet = outcome.value.packet;
    expect(packet.verification.status).toBe("PASS");
    expect(packet.verification.observedInputs).toBe(packet.verification.expectedInputs);
    expect(packet.blindReview.verdict).toBe("PASS");
    expect(packet.blindReview.omittedItems).toBe(0);
    expect(packet.changedRepositories[0]?.files).toBe(1);
    expect(harness.cp.runs.require(runId).state).toBe(RunState.READY_FOR_CEO_REVIEW);

    // CP-S30: the review ran automatically, with no agent asking for it.
    const reviewEvents = harness.cp.audit.byKind("BLIND_REVIEW_COMPLETED");
    expect(reviewEvents).toHaveLength(1);

    const ceoSession = bindCeoIfMissing(harness);
    const decision = harness.cp.ceo.submitCeoDecision({
      runId,
      decision: "CONFIRM",
      candidateSnapshotDigest: outcome.value.snapshotDigest,
      ceoSessionId: ceoSession,
      rationale: "evidence is complete",
    });
    expect(decision.allowed).toBe(true);
    expect(harness.cp.runs.require(runId).state).toBe(RunState.COMPLETED);
  });

  it("CP-S33: a REVISE verdict returns to the CTO and does not notify the CEO", async () => {
    const harness = makeHarness();
    const { runId, outcome } = await drive(harness, { reviewerVerdict: "REVISE" });

    expect(outcome.allowed).toBe(true);
    if (!outcome.allowed || outcome.value.stage !== "REVISION_REQUIRED") {
      throw new Error(`unexpected stage: ${outcome.allowed ? outcome.value.stage : outcome.message}`);
    }
    expect(outcome.value.reasonCode).toBe(ReasonCode.REVIEW_REVISE);

    const returned = harness.cp.audit.byKind("REVISION_RETURNED_TO_CTO");
    expect(returned).toHaveLength(1);

    const notifications = harness.cp.audit
      .byKind("CEO_NOTIFICATION")
      .filter((e) => e.evidence["notification"] === "READY_FOR_CEO_REVIEW");
    expect(notifications).toHaveLength(0);

    expect(harness.cp.runs.require(runId).state).toBe(RunState.ACTIVE);
  });

  it("REVISE → CTO revision → a fresh review on the new candidate passes", async () => {
    const harness = makeHarness();
    const { runId, run, identity, outcome } = await drive(harness, { reviewerVerdict: "REVISE" });

    if (!outcome.allowed || outcome.value.stage !== "REVISION_REQUIRED") {
      throw new Error(`unexpected stage: ${outcome.allowed ? outcome.value.stage : outcome.message}`);
    }
    const revisedFrom = outcome.value.snapshotDigest;
    const firstReviewer = harness.cp.review.latestPacket(runId, revisedFrom)?.reviewerSessionId;
    expect(firstReviewer).toBeTruthy();

    // The CTO revises. A new commit means a new candidate, so the previous review is no
    // longer current evidence.
    writeFiles(harness.repoPath, { "src/app.js": "module.exports = () => 2; // addressed review\n" });
    commitAll(harness.repoPath, "address the review finding");

    harness.scripted.script({
      match: /Candidate review/,
      text: reviewerPass([`${identity}:src/app.js`]),
    });

    const second = await harness.cp.pipeline.submitResult({
      runId,
      ownerSessionId: run.ownerSessionId!,
      ownerBindingGeneration: run.ownerBindingGeneration!,
      resultSummary: "review finding addressed",
      recommendation: "merge",
    });
    if (!second.allowed || second.value.stage !== "COMPLETED_REVIEW") {
      throw new Error(`unexpected stage: ${second.allowed ? second.value.stage : second.message}`);
    }

    // A different candidate, judged by a different reviewer session, with the old review
    // marked superseded.
    expect(second.value.snapshotDigest).not.toBe(revisedFrom);
    const secondReviewer = harness.cp.review.latestPacket(runId, second.value.snapshotDigest)!;
    expect(secondReviewer.reviewerSessionId).not.toBe(firstReviewer);
    expect(secondReviewer.candidateSnapshotDigest).toBe(second.value.snapshotDigest);

    const stale = harness.cp.artifacts
      .list(runId, "BLIND_REVIEW")
      .filter((a) => a.candidateSnapshotDigest === revisedFrom);
    expect(stale.every((a) => a.superseded)).toBe(true);

    // Two reviews happened, and only the second one produced a packet.
    expect(harness.cp.audit.byKind("BLIND_REVIEW_COMPLETED")).toHaveLength(2);
    expect(second.value.packet.blindReview.verdict).toBe("PASS");
  });

  it("failed verification → repair → re-verification produces fresh evidence", async () => {
    const harness = makeHarness();
    const { runId, run, identity, outcome } = await drive(harness, { failing: true });

    expect(outcome.allowed).toBe(true);
    if (!outcome.allowed || outcome.value.stage !== "VERIFICATION_FAILED") {
      throw new Error(`unexpected stage: ${outcome.allowed ? outcome.value.stage : outcome.message}`);
    }
    const failedDigest = outcome.value.snapshotDigest;
    expect(outcome.value.report.status).toBe("FAIL");

    // A review is never attempted on a candidate that failed verification.
    expect(harness.cp.audit.byKind("BLIND_REVIEW_COMPLETED")).toHaveLength(0);

    // Repair, then resubmit: the new candidate has its own digest and its own evidence.
    applyPassingChange(harness.repoPath);
    harness.scripted.script({
      match: /Candidate review/,
      text: reviewerPass([`${identity}:src/app.js`]),
    });

    const retry = await harness.cp.pipeline.submitResult({
      runId,
      ownerSessionId: run.ownerSessionId!,
      ownerBindingGeneration: run.ownerBindingGeneration!,
      resultSummary: "repaired",
      recommendation: "merge",
    });
    expect(retry.allowed).toBe(true);
    if (!retry.allowed || retry.value.stage !== "COMPLETED_REVIEW") {
      throw new Error(`unexpected retry stage: ${retry.allowed ? retry.value.stage : retry.message}`);
    }
    expect(retry.value.snapshotDigest).not.toBe(failedDigest);

    // CP-HI-06: evidence for the superseded candidate is no longer current.
    const superseded = harness.cp.artifacts
      .list(runId, "VERIFICATION")
      .filter((a) => a.candidateSnapshotDigest === failedDigest);
    expect(superseded.every((a) => a.superseded)).toBe(true);
  });

  it("CP-S25: a repository change after freezing invalidates the whole candidate", async () => {
    const harness = makeHarness();
    const { projectId, repositoryId } = await registerFixtureProject(harness);
    bindCeo(harness);

    const created = harness.cp.runs.create({
      projectId,
      executionMode: ExecutionMode.SIMPLE,
      contract: CONTRACT,
      repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
    });
    if (!created.allowed) throw new Error(created.message);
    const dispatched = await harness.cp.runs.dispatch(created.value.runId);
    if (!dispatched.allowed) throw new Error(dispatched.message);

    applyPassingChange(harness.repoPath);
    const frozen = await harness.cp.pipeline.freeze(created.value.runId);
    expect(frozen.allowed).toBe(true);
    if (!frozen.allowed) return;

    applyFailingChange(harness.repoPath); // source moves after the freeze

    const verified = await harness.cp.verification.verify({
      runId: created.value.runId,
      snapshot: frozen.value,
      commands: [],
      contractDigest: frozen.value.contractDigest,
    });
    expect(verified.allowed).toBe(false);
    expect(verified.reasonCode).toBe(ReasonCode.SNAPSHOT_STALE);
    expect(candidateSnapshotDigest(frozen.value)).toMatch(/^sha256:/);
  });

  it("CP-S31: a producer session cannot be bound as the run's blind reviewer", async () => {
    const harness = makeHarness();
    const { projectId, repositoryId } = await registerFixtureProject(harness);
    const created = harness.cp.runs.create({
      projectId,
      executionMode: ExecutionMode.SIMPLE,
      contract: CONTRACT,
      repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
    });
    if (!created.allowed) throw new Error(created.message);
    const dispatched = await harness.cp.runs.dispatch(created.value.runId);
    if (!dispatched.allowed) throw new Error(dispatched.message);

    const producerSession = dispatched.value.ownerSessionId!;
    const independence = harness.cp.bindings.assertReviewerIndependence(
      created.value.runId,
      producerSession,
    );
    expect(independence.allowed).toBe(false);
    expect(independence.reasonCode).toBe(ReasonCode.REVIEWER_SESSION_IS_PRODUCER);

    const bound = harness.cp.bindings.bind({
      roleKey: `BLIND_REVIEWER:${created.value.runId}`,
      role: "BLIND_REVIEWER",
      sessionId: producerSession,
      runId: created.value.runId,
    });
    expect(bound.allowed).toBe(false);
    expect(bound.reasonCode).toBe(ReasonCode.REVIEWER_SESSION_IS_PRODUCER);
  });

  it("CP-S32: a review that misses a touched file cannot pass", async () => {
    const harness = makeHarness();
    const { projectId, repositoryId, identity } = await registerFixtureProject(harness);
    bindCeo(harness);

    const created = harness.cp.runs.create({
      projectId,
      executionMode: ExecutionMode.SIMPLE,
      contract: CONTRACT,
      repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
    });
    if (!created.allowed) throw new Error(created.message);
    const dispatched = await harness.cp.runs.dispatch(created.value.runId);
    if (!dispatched.allowed) throw new Error(dispatched.message);

    applyPassingChange(harness.repoPath);
    // The reviewer claims PASS but names a file that is not the one that changed.
    harness.scripted.script({
      match: /Candidate review/,
      text: reviewerPass([`${identity}:README.md`]),
    });

    const outcome = await harness.cp.pipeline.submitResult({
      runId: created.value.runId,
      ownerSessionId: dispatched.value.ownerSessionId!,
      ownerBindingGeneration: dispatched.value.ownerBindingGeneration!,
      resultSummary: "done",
      recommendation: "merge",
    });

    expect(outcome.allowed).toBe(true);
    if (!outcome.allowed || outcome.value.stage !== "REVISION_REQUIRED") {
      throw new Error(`unexpected stage: ${outcome.allowed ? outcome.value.stage : outcome.message}`);
    }
    expect(outcome.value.review?.verdict).toBe("REVISE");
    expect(outcome.value.review?.omittedItems).toContain(`${identity}:src/app.js`);
  });

  it("the gate refuses a candidate that is no longer the run's current one", async () => {
    const harness = makeHarness();
    const { runId, run, outcome } = await drive(harness);
    if (!outcome.allowed || outcome.value.stage !== "COMPLETED_REVIEW") {
      throw new Error("setup did not reach a packet");
    }
    const oldDigest = outcome.value.snapshotDigest;

    // A new commit promotes a new candidate; the old evidence is no longer current.
    writeFiles(harness.repoPath, { "src/app.js": "module.exports = () => 2; // later\n" });
    commitAll(harness.repoPath, "move the candidate on");
    const frozen = await harness.cp.pipeline.freeze(runId);
    expect(frozen.allowed).toBe(true);

    await harness.cp.continuity.evaluate("test");
    const stale = harness.cp.ceo.buildPacket({
      runId,
      candidateSnapshotDigest: oldDigest,
      approval: {
        runId,
        candidateSnapshotDigest: oldDigest,
        resultSummary: "stale",
        recommendation: "merge",
        residualRisk: [],
        approvedBySessionId: run.ownerSessionId!,
        approvedByGeneration: run.ownerBindingGeneration!,
        approvedAt: harness.clock.nowIso(),
      },
    });
    expect(stale.allowed).toBe(false);
    expect(stale.reasonCode).toBe(ReasonCode.EVIDENCE_STALE);
  });

  it("the gate refuses a verification report that no result rows corroborate", async () => {
    const harness = makeHarness();
    const { runId, run, outcome } = await drive(harness);
    if (!outcome.allowed || outcome.value.stage !== "COMPLETED_REVIEW") {
      throw new Error("setup did not reach a packet");
    }
    const digest = outcome.value.snapshotDigest;

    // The report artifact is immutable, so remove the rows behind it instead: a PASS with
    // nothing to corroborate it must not be accepted.
    harness.cp.db.run(`DELETE FROM verification_results WHERE run_id = ?`, [runId]);

    // The pipeline evaluates coverage immediately before completing; a direct gate call
    // must do the same or the gate refuses on a stale continuity mode.
    await harness.cp.continuity.evaluate("test");
    const decision = harness.cp.ceo.buildPacket({
      runId,
      candidateSnapshotDigest: digest,
      approval: {
        runId,
        candidateSnapshotDigest: digest,
        resultSummary: "uncorroborated",
        recommendation: "merge",
        residualRisk: [],
        approvedBySessionId: run.ownerSessionId!,
        approvedByGeneration: run.ownerBindingGeneration!,
        approvedAt: harness.clock.nowIso(),
      },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.EVIDENCE_MISSING);
  });

  it("the gate refuses a review packet naming a reviewer that never held the binding", async () => {
    const harness = makeHarness();
    const { projectId, repositoryId, identity } = await registerFixtureProject(harness);
    bindCeo(harness);
    const created = harness.cp.runs.create({
      projectId,
      executionMode: ExecutionMode.SIMPLE,
      contract: CONTRACT,
      repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
    });
    if (!created.allowed) throw new Error(created.message);
    const dispatched = await harness.cp.runs.dispatch(created.value.runId);
    if (!dispatched.allowed) throw new Error(dispatched.message);
    const runId = created.value.runId;

    applyPassingChange(harness.repoPath);
    const frozen = await harness.cp.pipeline.freeze(runId);
    if (!frozen.allowed) throw new Error(frozen.message);
    const digest = candidateSnapshotDigest(frozen.value);

    const verified = await harness.cp.verification.verify({
      runId,
      snapshot: frozen.value,
      commands: harness.cp.projects.activeManifest(projectId)!.manifest.verificationCommands,
      contractDigest: frozen.value.contractDigest,
    });
    expect(verified.allowed).toBe(true);

    // A well-formed review packet from the right producer, but naming a session that was
    // never bound as this run's blind reviewer.
    harness.cp.artifacts.putEvidence(
      "blind-review-gate",
      runId,
      "BLIND_REVIEW",
      {
        runId,
        candidateSnapshotDigest: digest,
        contractDigest: frozen.value.contractDigest,
        reviewerRoleBindingGeneration: 1,
        reviewerSessionId: "ses_never_bound",
        reviewerSessionIncarnation: "inc-x",
        provider: "scripted",
        model: "scripted-reviewer",
        effort: null,
        inputManifest: {
          contract: true,
          snapshotManifest: true,
          diff: true,
          verificationEvidence: true,
          projectContext: false,
          withheld: [],
        },
        coveredRepositories: [identity],
        coveredFiles: [`${identity}:src/app.js`],
        omittedItems: [],
        verdict: "PASS",
        findings: [],
        chunked: false,
        createdAt: harness.clock.nowIso(),
      },
      digest,
    );

    // The pipeline evaluates coverage immediately before completing; a direct gate call
    // must do the same or the gate refuses on a stale continuity mode.
    await harness.cp.continuity.evaluate("test");
    const decision = harness.cp.ceo.buildPacket({
      runId,
      candidateSnapshotDigest: digest,
      approval: {
        runId,
        candidateSnapshotDigest: digest,
        resultSummary: "forged reviewer",
        recommendation: "merge",
        residualRisk: [],
        approvedBySessionId: dispatched.value.ownerSessionId!,
        approvedByGeneration: dispatched.value.ownerBindingGeneration!,
        approvedAt: harness.clock.nowIso(),
      },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.REVIEWER_NOT_INDEPENDENT);
  });

  it("task graph rejects cycles and honours dependency order", async () => {
    const harness = makeHarness();
    const { projectId, repositoryId } = await registerFixtureProject(harness);
    const created = harness.cp.runs.create({
      projectId,
      executionMode: ExecutionMode.STANDARD,
      contract: CONTRACT,
      repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
    });
    if (!created.allowed) throw new Error(created.message);

    const cyclic = harness.cp.tasks.submit(created.value.runId, [
      { key: "a", title: "a", category: "implementation", dependsOn: ["b"] },
      { key: "b", title: "b", category: "implementation", dependsOn: ["a"] },
    ]);
    expect(cyclic.allowed).toBe(false);
    expect(cyclic.reasonCode).toBe(ReasonCode.TASK_DEPENDENCY_CYCLE);

    const linear = harness.cp.tasks.submit(created.value.runId, [
      { key: "a", title: "a", category: "implementation" },
      { key: "b", title: "b", category: "test", dependsOn: ["a"] },
    ]);
    expect(linear.allowed).toBe(true);
    const ready = harness.cp.tasks.ready(created.value.runId);
    expect(ready).toHaveLength(1);
    expect(ready[0]?.title).toBe("a");

    const blocked = harness.cp.tasks
      .list(created.value.runId)
      .find((t) => t.title === "b");
    expect(blocked?.state).toBe(TaskState.PENDING);
  });
});

const bindCeoIfMissing = (harness: Harness): string => {
  const existing = harness.cp.bindings.active("CEO");
  if (existing) return existing.sessionId;
  return bindCeo(harness);
};
