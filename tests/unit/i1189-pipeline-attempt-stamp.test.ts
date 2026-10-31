import { afterAll, describe, expect, it } from "vitest";

import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ExecutionMode, RunState } from "../../src/domain/types.ts";
import { MessageKind } from "../../src/outbox/envelope.ts";
import { UNJUDGED_REVIEW_NOTICES } from "../../src/run/candidate-pipeline.ts";
import type { TaskContract } from "../../src/run/run-engine.ts";
import { cleanupTempDirs, commitAll, writeFiles } from "../helpers/fixtures.ts";
import { applyFailingChange, bindCeo, bindWorker, makeHarness, registerFixtureProject, reviewerPass, reviewerRevise } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * #1189 — the candidate pipeline names the submission attempt on the audit rows it writes for that
 * attempt (the freeze, and an unavailable review), and nothing else about a submission changes:
 * the same stages, reason codes, run state and deliveries. Scripted pipeline results.
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

describe("#1189 the pipeline's attempt stamp", () => {
  it("each submission's freeze and unavailable rows name its attempt; stages, reasons, state and deliveries are as before", async () => {
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
    const head = applyFailingChange(h.repoPath);
    h.cp.tasks.finishExecution(execution.value.executionId, { status: "SUCCEEDED", resultDigest: `sha256:${head}` });
    const covered = [`${identity}:src/app.js`];
    const submit = () =>
      h.cp.pipeline.submitResult({
        runId,
        ownerSessionId: run.ownerSessionId!,
        ownerBindingGeneration: run.ownerBindingGeneration!,
        resultSummary: "app() now returns 2",
        recommendation: "merge",
      });
    const leaseAttempt = () => h.cp.db.get<{ attempt_id: string }>("SELECT attempt_id FROM candidate_pipeline_attempts WHERE run_id = ?", [runId])!.attempt_id;

    // 1: verification fails.
    const first = await submit();
    const attempt1 = leaseAttempt();
    // 2: a fix, and the reviewer asks for revision.
    writeFiles(h.repoPath, { "src/app.js": "module.exports = () => 2;\n" });
    commitAll(h.repoPath, "fix");
    h.scripted.script({ match: /Candidate review/, text: reviewerRevise(covered, "a finding") });
    const second = await submit();
    const attempt2 = leaseAttempt();
    // 3: the reviewer's runtime is down.
    h.scripted.setRuntimeHealth("UNAVAILABLE");
    const third = await submit();
    const attempt3 = leaseAttempt();
    h.scripted.setRuntimeHealth("HEALTHY");
    // 4: the review passes.
    h.scripted.script({ match: /Candidate review/, text: reviewerPass(covered) });
    const fourth = await submit();
    const attempt4 = leaseAttempt();

    // The outcomes are the pipeline's usual ones.
    expect(first).toMatchObject({ allowed: true, value: { stage: "VERIFICATION_FAILED" } });
    expect(second).toMatchObject({ allowed: true, value: { stage: "REVISION_REQUIRED", reasonCode: ReasonCode.REVIEW_REVISE } });
    expect(third).toMatchObject({ allowed: true, value: { stage: "REVIEW_UNAVAILABLE", reasonCode: ReasonCode.ISOLATION_LOST } });
    expect(fourth).toMatchObject({ allowed: true, value: { stage: "COMPLETED_REVIEW" } });
    expect(h.cp.runs.require(runId).state).toBe(RunState.READY_FOR_CEO_REVIEW);
    expect(new Set([attempt1, attempt2, attempt3, attempt4]).size).toBe(4);

    const audit = h.cp.audit.forRun(runId);
    // Every freeze names the attempt that froze it, and carries nothing else new.
    const freezes = audit.filter((row) => row.kind === "CANDIDATE_FROZEN");
    expect(freezes.map((row) => row.evidence["attemptId"])).toEqual([attempt1, attempt2, attempt3, attempt4]);
    for (const row of freezes) expect(Object.keys(row.evidence).sort()).toEqual(["attemptId", "candidateSnapshotDigest", "repositories"]);
    // The unavailable review names attempt 3, beside the fields it always had.
    const unavailable = audit.filter((row) => row.kind === "BLIND_REVIEW_UNAVAILABLE");
    expect(unavailable).toHaveLength(1);
    expect(unavailable[0]!.evidence).toMatchObject({ attemptId: attempt3, candidateSnapshotDigest: freezes[2]!.evidence["candidateSnapshotDigest"] });
    expect(unavailable[0]!.reasonCode).toBe(ReasonCode.ISOLATION_LOST);
    // The revisions are delivered as before, keyed by the same attempts the rows name.
    const revisions = h.cp.outbox.listByRun(runId).filter((message) => message.kind === MessageKind.REVISION_REQUEST);
    const notices = revisions.filter((message) => (message.payload as { stage?: unknown }).stage === "review-unavailable");
    expect(revisions.filter((message) => !notices.includes(message)).map((message) => message.idempotencyKey.slice(message.idempotencyKey.lastIndexOf(":") + 1)).sort())
      .toEqual([attempt1, attempt2].sort());
    // F1 — attempt 3's unavailable review sent the owner exactly one fixed notice, keyed by that attempt, and no revision.
    expect(notices.map((message) => ({ key: message.idempotencyKey, payload: message.payload }))).toEqual([{
      key: `revision:${runId}:${freezes[2]!.evidence["candidateSnapshotDigest"]}:${ReasonCode.ISOLATION_LOST}:${attempt3}`,
      payload: { runId, reasonCode: ReasonCode.ISOLATION_LOST, stage: "review-unavailable", candidateSnapshotDigest: freezes[2]!.evidence["candidateSnapshotDigest"],
        notice: "REVIEW_UNAVAILABLE", recovery: UNJUDGED_REVIEW_NOTICES.REVIEW_UNAVAILABLE } }]);
    expect(audit.filter((row) => row.kind === "REVISION_RETURNED_TO_CTO")).toHaveLength(2);
  });

  it("a freeze outside a submission names no attempt", async () => {
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
    expect((await h.cp.runs.dispatch(created.value.runId)).allowed).toBe(true);
    applyFailingChange(h.repoPath);
    expect((await h.cp.pipeline.freeze(created.value.runId)).allowed).toBe(true);
    const frozen = h.cp.audit.forRun(created.value.runId).filter((row) => row.kind === "CANDIDATE_FROZEN");
    expect(frozen).toHaveLength(1);
    expect(Object.keys(frozen[0]!.evidence).sort()).toEqual(["candidateSnapshotDigest", "repositories"]);
  });
});
