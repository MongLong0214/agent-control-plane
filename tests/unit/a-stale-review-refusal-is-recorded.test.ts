import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Role, RunKind, RunState, roleKeyFor } from "../../src/domain/types.ts";
import { createCtoMcpPort } from "../../src/mcp/cto-server.ts";
import type { ReviewPacket } from "../../src/review/blind-review.ts";
import {
  WORKFLOW,
  WORKFLOW_PATH,
  dispatchRun,
  normalized,
  planCarrying,
  stricter,
  type DispatchedRun,
} from "../helpers/contract-change.ts";
import { cleanupTempDirs, commitAll, writeFiles } from "../helpers/fixtures.ts";
import {
  applyPassingChange,
  bindWorker,
  carryContractChange,
  makeHarness,
  registerFixtureProject,
  reviewerPass,
  type Harness,
} from "../helpers/harness.ts";

afterAll(cleanupTempDirs);
afterEach(() => vi.restoreAllMocks());

/**
 * A review outcome refused as stale stays refused, and the refusal is on record: a BLIND_REVIEW_REJECTED
 * row names which check found it stale, the candidate, the submission attempt and, where a reviewer
 * answered, that reviewer's binding generation. Before, a reviewer could finish and the submission end
 * CANDIDATE_STALE with no BLIND_REVIEW artifact and no review outcome row at all, so nothing said why no
 * verdict existed.
 *
 * Every submission goes through the production pipeline, review gate and production gate; the reviewer
 * is the harness's scripted one, and the test decides only when it answers and what changes meanwhile.
 */

const submit = (harness: Harness, run: DispatchedRun) =>
  harness.cp.pipeline.submitResult({
    runId: run.runId,
    ownerSessionId: run.ownerSessionId,
    ownerBindingGeneration: run.ownerBindingGeneration,
    resultSummary: "the proposed change",
    recommendation: "review the change",
    residualRisk: [],
  });

const rejected = (harness: Harness, runId: string) =>
  harness.cp.audit.forRun(runId).filter((row) => row.kind === "BLIND_REVIEW_REJECTED");

/** The candidate and attempt of the run's latest freeze, as its CANDIDATE_FROZEN row records them. */
const latestFreeze = (harness: Harness, runId: string) => {
  const row = harness.cp.audit.forRun(runId).filter((event) => event.kind === "CANDIDATE_FROZEN").at(-1)!;
  return { candidateSnapshotDigest: row.evidence["candidateSnapshotDigest"] as string, attemptId: row.evidence["attemptId"] as string };
};

const reviewerRoleKey = (runId: string) => roleKeyFor(Role.BLIND_REVIEWER, { runId });

/** Holds the next reviewer invocation whose prompt matches; `during` runs while it is held. */
const holdNextReview = (harness: Harness, match: RegExp, during: () => void) => {
  const scripted = harness.scripted;
  const original = scripted.invoke.bind(scripted);
  let held = false;
  vi.spyOn(scripted, "invoke").mockImplementation(async (request) => {
    if (!held && match.test(request.prompt)) {
      held = true;
      during();
    }
    return original(request);
  });
};

const noRepositoryChange = async (harness: Harness, projectId: string) => {
  const registered = await registerFixtureProject(harness, projectId);
  const run = await dispatchRun(harness, registered.projectId, RunKind.CONTRACT_CHANGE);
  carryContractChange(harness, run.runId, stricter(run.base));
  await harness.cp.continuity.evaluate("contract change candidate");
  return run;
};

/** A dispatched run of `kind` on the fixture repository whose one task's worker committed `files`. */
const repositoryRun = async (harness: Harness, projectId: string, kind: RunKind, files: Record<string, string> = {}) => {
  const registered = await registerFixtureProject(harness, projectId);
  const run = await dispatchRun(harness, registered.projectId, kind, [
    { repositoryId: registered.repositoryId, repositoryRole: "primary", baseBranch: "dev" },
  ]);
  if (kind === RunKind.CONTRACT_CHANGE) carryContractChange(harness, run.runId, stricter(run.base));
  const tasks = harness.cp.tasks.submit(run.runId, [{ key: "change", title: "make the change", category: "implementation" }]);
  if (!tasks.allowed) throw new Error(tasks.message);
  const task = harness.cp.tasks.ready(run.runId)[0]!;
  const execution = harness.cp.tasks.startExecution({
    runId: run.runId,
    taskId: task.taskId,
    ownerBindingGeneration: run.ownerBindingGeneration,
    workerSessionId: bindWorker(harness, task.taskId),
    provider: "scripted",
    model: "scripted-worker",
    repositoryId: registered.repositoryId,
  });
  if (!execution.allowed) throw new Error(execution.message);
  let head = applyPassingChange(harness.repoPath, `feature/F1-${projectId}`);
  if (Object.keys(files).length > 0) {
    writeFiles(harness.repoPath, files);
    head = commitAll(harness.repoPath, "the task's other files");
  }
  harness.cp.tasks.finishExecution(execution.value.executionId, { status: "SUCCEEDED", resultDigest: `sha256:${head}` });
  await harness.cp.continuity.evaluate("repository candidate");
  return { run, registered };
};

/** Runs `change` once, at the continuity evaluation between a PASS and its packet. */
const beforePublication = (harness: Harness, change: () => void) => {
  const continuity = harness.cp.continuity;
  const evaluate = continuity.evaluate.bind(continuity);
  let changed = false;
  vi.spyOn(continuity, "evaluate").mockImplementation(async (reason: string) => {
    if (reason === "pre-completion" && !changed) {
      changed = true;
      change();
    }
    return evaluate(reason);
  });
};

describe("a review outcome refused as stale is recorded with why", () => {
  it("CONTRACT_CHANGE, PLAN replaced while its reviewer works: still stale and unpublished, and both refusals are on record", async () => {
    const harness = makeHarness();
    const run = await noRepositoryChange(harness, "stale-plan-in-review");
    let generation = -1;
    holdNextReview(harness, /Contract change review/, () => {
      generation = harness.cp.bindings.active(reviewerRoleKey(run.runId))!.bindingGeneration;
      const m2 = normalized({ ...stricter(run.base), commitlore: { mode: "required" } });
      expect(createCtoMcpPort(harness.cp).submitPlan(run.runId, planCarrying(m2)).allowed).toBe(true);
    });

    const outcome = await submit(harness, run);
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ allowed: true, value: { stage: "CANDIDATE_STALE", reasonCode: ReasonCode.EVIDENCE_STALE } });
    expect(harness.cp.artifacts.list(run.runId, "BLIND_REVIEW")).toEqual([]);
    expect(harness.cp.artifacts.list(run.runId, "PRODUCTION_READY_PACKET")).toEqual([]);
    expect(harness.cp.runs.require(run.runId).state).toBe(RunState.ACTIVE);

    const frozen = latestFreeze(harness, run.runId);
    expect(generation).toBeGreaterThan(0);
    expect(rejected(harness, run.runId)).toMatchObject([
      {
        roleKey: reviewerRoleKey(run.runId),
        reasonCode: ReasonCode.EVIDENCE_STALE,
        evidence: { ...frozen, stale: "REVIEW_INPUTS", reviewerRoleBindingGeneration: generation },
      },
      {
        reasonCode: ReasonCode.EVIDENCE_STALE,
        evidence: { ...frozen, stale: "AFTER_REVIEW", reviewReasonCode: ReasonCode.EVIDENCE_STALE },
      },
    ]);
  });

  it("reviewer binding replaced while it works: its answer is not kept, and the refusal names that reviewer's generation", async () => {
    const harness = makeHarness();
    const run = await noRepositoryChange(harness, "stale-reviewer-binding");
    let generation = -1;
    holdNextReview(harness, /Contract change review/, () => {
      generation = harness.cp.bindings.active(reviewerRoleKey(run.runId))!.bindingGeneration;
      expect(harness.cp.bindings.revoke(reviewerRoleKey(run.runId), "replaced while reviewing").allowed).toBe(true);
    });

    const outcome = await submit(harness, run);
    // Unchanged: no verdict, nothing published, the run where it was.
    expect(outcome, JSON.stringify(outcome)).toMatchObject({
      allowed: true,
      value: { stage: "REVIEW_UNAVAILABLE", reasonCode: ReasonCode.BINDING_GENERATION_STALE },
    });
    expect(harness.cp.artifacts.list(run.runId, "BLIND_REVIEW")).toEqual([]);
    expect(harness.cp.artifacts.list(run.runId, "PRODUCTION_READY_PACKET")).toEqual([]);
    expect(harness.cp.runs.require(run.runId).state).toBe(RunState.ACTIVE);

    const frozen = latestFreeze(harness, run.runId);
    expect(rejected(harness, run.runId)).toMatchObject([
      {
        roleKey: reviewerRoleKey(run.runId),
        reasonCode: ReasonCode.BINDING_GENERATION_STALE,
        evidence: { ...frozen, stale: "REVIEWER_BINDING", reviewerRoleBindingGeneration: generation },
      },
    ]);
  });

  it("CONTRACT_CHANGE, PLAN replaced after a PASS: the PASS publishes nothing, and the refusal names the PASS's reviewer", async () => {
    const harness = makeHarness();
    const run = await noRepositoryChange(harness, "stale-plan-at-publication");
    beforePublication(harness, () => {
      const m2 = normalized({ ...stricter(run.base), commitlore: { mode: "required" } });
      expect(createCtoMcpPort(harness.cp).submitPlan(run.runId, planCarrying(m2)).allowed).toBe(true);
    });

    const outcome = await submit(harness, run);
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ allowed: true, value: { stage: "CANDIDATE_STALE" } });
    expect(harness.cp.artifacts.list(run.runId, "PRODUCTION_READY_PACKET")).toEqual([]);
    const frozen = latestFreeze(harness, run.runId);
    const review = harness.cp.artifacts.latestForSnapshot<ReviewPacket>(run.runId, "BLIND_REVIEW", frozen.candidateSnapshotDigest)!;
    expect(review.content.verdict).toBe("PASS");
    expect(rejected(harness, run.runId)).toMatchObject([
      {
        reasonCode: ReasonCode.EVIDENCE_STALE,
        evidence: {
          ...frozen,
          stale: "PLAN_AT_PUBLICATION",
          reviewReasonCode: ReasonCode.REVIEW_PASS,
          reviewerRoleBindingGeneration: review.content.reviewerRoleBindingGeneration,
        },
      },
    ]);
  });

  it("repository CONTRACT_CHANGE, PLAN replaced while its reviewer works: the candidate review's refusal is on record too", async () => {
    const harness = makeHarness();
    const { run, registered } = await repositoryRun(harness, "stale-repository-plan", RunKind.CONTRACT_CHANGE, { [WORKFLOW_PATH]: WORKFLOW });
    let generation = -1;
    holdNextReview(harness, /# Candidate review/, () => {
      generation = harness.cp.bindings.active(reviewerRoleKey(run.runId))!.bindingGeneration;
      const m2 = normalized({ ...stricter(run.base), commitlore: { mode: "required" } });
      expect(createCtoMcpPort(harness.cp).submitPlan(run.runId, planCarrying(m2)).allowed).toBe(true);
    });
    harness.scripted.script({ match: /# Candidate review/, text: reviewerPass([`${registered.identity}:src/app.js`, `${registered.identity}:${WORKFLOW_PATH}`]) });

    const outcome = await submit(harness, run);
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ allowed: true, value: { stage: "CANDIDATE_STALE" } });
    expect(harness.cp.artifacts.list(run.runId, "BLIND_REVIEW")).toEqual([]);
    expect(harness.cp.artifacts.list(run.runId, "PRODUCTION_READY_PACKET")).toEqual([]);
    const frozen = latestFreeze(harness, run.runId);
    expect(rejected(harness, run.runId)).toMatchObject([
      { evidence: { ...frozen, stale: "REVIEW_INPUTS", reviewerRoleBindingGeneration: generation } },
      { evidence: { ...frozen, stale: "AFTER_REVIEW" } },
    ]);
  });

  it("STANDARD_WORK, source moved after a PASS: nothing is published, and the refusal is on record", async () => {
    const harness = makeHarness();
    const { run, registered } = await repositoryRun(harness, "stale-standard-source", RunKind.STANDARD_WORK);
    harness.scripted.script({ match: /# Candidate review/, text: reviewerPass([`${registered.identity}:src/app.js`]) });
    beforePublication(harness, () => {
      writeFiles(harness.repoPath, { "src/later.js": "module.exports = 3;\n" });
      commitAll(harness.repoPath, "a commit after the candidate was frozen");
    });

    const outcome = await submit(harness, run);
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ allowed: true, value: { stage: "CANDIDATE_STALE" } });
    expect(harness.cp.artifacts.list(run.runId, "PRODUCTION_READY_PACKET")).toEqual([]);
    const frozen = latestFreeze(harness, run.runId);
    const review = harness.cp.artifacts.latestForSnapshot<ReviewPacket>(run.runId, "BLIND_REVIEW", frozen.candidateSnapshotDigest)!;
    expect(review.content.verdict).toBe("PASS");
    expect(rejected(harness, run.runId)).toMatchObject([
      {
        reasonCode: outcome.allowed ? (outcome.value as { reasonCode: string }).reasonCode : null,
        evidence: {
          ...frozen,
          stale: "SOURCE_AT_PUBLICATION",
          reviewReasonCode: ReasonCode.REVIEW_PASS,
          reviewerRoleBindingGeneration: review.content.reviewerRoleBindingGeneration,
        },
      },
    ]);
  });
});

describe("a review that is not stale is unchanged", () => {
  it("a CONTRACT_CHANGE PASS is published with no refusal recorded", async () => {
    const harness = makeHarness();
    const run = await noRepositoryChange(harness, "fresh-contract-change");
    const outcome = await submit(harness, run);
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ allowed: true, value: { stage: "COMPLETED_REVIEW" } });
    expect(harness.cp.artifacts.list(run.runId, "PRODUCTION_READY_PACKET")).toHaveLength(1);
    expect(rejected(harness, run.runId)).toEqual([]);
  });

  it("a STANDARD_WORK PASS is published with no refusal recorded", async () => {
    const harness = makeHarness();
    const { run, registered } = await repositoryRun(harness, "fresh-standard", RunKind.STANDARD_WORK);
    harness.scripted.script({ match: /# Candidate review/, text: reviewerPass([`${registered.identity}:src/app.js`]) });
    const outcome = await submit(harness, run);
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ allowed: true, value: { stage: "COMPLETED_REVIEW" } });
    expect(harness.cp.artifacts.list(run.runId, "PRODUCTION_READY_PACKET")).toHaveLength(1);
    expect(rejected(harness, run.runId)).toEqual([]);
  });
});
