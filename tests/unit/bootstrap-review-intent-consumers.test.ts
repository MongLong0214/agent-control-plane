import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { bootstrapPlanIntent } from "../../src/bootstrap/bootstrap-plan.ts";
import type { ProjectManifest } from "../../src/contracts/manifest.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ExecutionMode, RunKind, RunState } from "../../src/domain/types.ts";
import { bootstrapCoverageKeys, bootstrapPlan, callCtoToolAsOwner, cleanTreeManifest } from "../helpers/bootstrap-plan.ts";
import { noGitHubCall, ownerApprovalFor, type PreparedBootstrapRun, prepareBootstrapRun } from "../helpers/bootstrap-runner.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { bindCeo, dispatchBootstrapRun, makeHarness, reviewerPass, reviewerRevise } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);
afterEach(() => vi.restoreAllMocks());

/**
 * BPI-R1-01 / BPI-R1-02 (review of #1119, round 1) — every consumer that trusts a BOOTSTRAP_PLAN review
 * requires the review's `bootstrapPlanIntentDigest` to be the run's CURRENT PLAN/task intent projection
 * (`bootstrapReviewIntentCurrent`): the pipeline after its last await, readiness, the runner before
 * any GitHub write, and CONFIRM. A review with no such digest predates it and needs a fresh review. And
 * the lifecycle the reviewer is shown does not claim a legacy singleton was created with its PLAN.
 */

type Operation = PreparedBootstrapRun["ops"][number];

const createOnlyOperations = (): Operation[] => [
  {
    operationId: "create-repository:fixture",
    resourceType: "repository",
    resourceIdentity: "github:acme/fixture",
    desiredState: { visibility: "public", autoInit: true },
  },
] as Operation[];

const manifestFor = (projectId: string): ProjectManifest => {
  const base = cleanTreeManifest(projectId);
  return { ...base, branchProfile: { ...base.branchProfile, defaultBranch: "main" } };
};

const prepare = (projectId: string) => prepareBootstrapRun(projectId, { ops: createOnlyOperations(), manifest: manifestFor(projectId) });

/** produce under the owner's approval, acknowledge the handoff, activate again: WRITTEN and ready to CONFIRM. */
const produceAndActivate = async (prepared: PreparedBootstrapRun): Promise<void> => {
  const { harness } = prepared;
  const input = { ...prepared.input, ownerApproval: ownerApprovalFor(prepared) };
  const first = await prepared.runner.produceAndActivate(input);
  expect(first).toMatchObject({ allowed: false, reasonCode: ReasonCode.BOOTSTRAP_ACTIVATION_INCOMPLETE });
  const primary = harness.cp.bindings.activePrimaryCto(prepared.manifest.projectId)!;
  expect(harness.cp.bootstrap.acknowledgeActivationHandoff(first.evidence["pendingHandoffId"] as string, primary.sessionId).allowed).toBe(true);
  const second = await prepared.runner.produceAndActivate(input);
  expect(second, JSON.stringify(second)).toMatchObject({ allowed: true });
  await harness.cp.continuity.evaluate("bootstrap confirmation");
};

const confirm = (prepared: PreparedBootstrapRun) =>
  prepared.harness.cp.ceo.submitCeoDecision({
    runId: prepared.runId,
    decision: "CONFIRM",
    candidateSnapshotDigest: prepared.snapshotDigest,
    ceoSessionId: prepared.ceoSessionId,
    rationale: "apply the bootstrap",
  });

/**
 * A review as a pre-#1119 gate stored it: the same review with no `bootstrapPlanIntentDigest`. A stored
 * artifact is immutable (ARTIFACT_IMMUTABLE), so the legacy review is presented at the read every
 * consumer makes of it, by candidate; its digest is left as it was, so the absent intent digest is the
 * only thing that differs.
 */
const stripIntentDigest = (prepared: PreparedBootstrapRun): void => {
  const { harness, runId, snapshotDigest } = prepared;
  const artifacts = harness.cp.artifacts;
  expect(typeof artifacts.latestForSnapshot<Record<string, unknown>>(runId, "BLIND_REVIEW", snapshotDigest)!.content["bootstrapPlanIntentDigest"]).toBe(
    "string",
  );
  const read = artifacts.latestForSnapshot.bind(artifacts);
  vi.spyOn(artifacts, "latestForSnapshot").mockImplementation(((reviewRunId: string, kind: string, candidate: string) => {
    const stored = read<Record<string, unknown>>(reviewRunId, kind as never, candidate);
    if (kind !== "BLIND_REVIEW" || stored === null) return stored;
    const { bootstrapPlanIntentDigest: _dropped, ...legacy } = stored.content;
    return { ...stored, content: legacy };
  }) as never);
  expect(artifacts.latestForSnapshot<Record<string, unknown>>(runId, "BLIND_REVIEW", snapshotDigest)!.content).not.toHaveProperty(
    "bootstrapPlanIntentDigest",
  );
};

/** The PLAN's one task changed after its review: the binding digests are untouched, the intent is not. */
const changeTask = (prepared: PreparedBootstrapRun): void => {
  const { harness, runId } = prepared;
  const [task] = harness.cp.tasks.list(runId).filter((candidate) => candidate.state !== "CANCELLED");
  harness.cp.db.run(`UPDATE tasks SET spec_json = ? WHERE task_id = ?`, [
    JSON.stringify({ ...task!.spec, completionCriteria: ["a criterion the reviewer never saw"] }),
    task!.taskId,
  ]);
};

describe.each([
  ["a review with no intent digest (pre-#1119)", stripIntentDigest, "BOOTSTRAP_PLAN_INTENT_MISSING"],
  ["a review whose intent digest is not the current projection", changeTask, "BOOTSTRAP_PLAN_INTENT_STALE"],
] as const)("BPI-R1-01: %s", (_name, mutate, refusal) => {
  it("readiness and the runner's pre-write check refuse it, with no GitHub call, and CONFIRM does not complete the run", async () => {
    const prepared = await prepare(`bpi-pre-${refusal.toLowerCase()}`);
    const { harness, runId } = prepared;
    mutate(prepared);

    const readiness = harness.cp.bootstrap.readinessForFactoryResult(runId, prepared.input.handoff, prepared.snapshotDigest);
    expect(readiness).toMatchObject({ allowed: false, evidence: { refusal } });
    expect(harness.cp.bootstrap.reviewForConfirmation(runId, prepared.snapshotDigest)).toMatchObject({ allowed: false, evidence: { refusal } });

    const produced = await prepared.runner.produceAndActivate({ ...prepared.input, ownerApproval: ownerApprovalFor(prepared) });
    expect(produced).toMatchObject({ allowed: false, evidence: { refusal } });
    expect(prepared.github.createRequests).toEqual([]);
    noGitHubCall(prepared);

    expect(confirm(prepared).allowed).toBe(false);
    expect(harness.cp.runs.require(runId).state).not.toBe(RunState.COMPLETED);
    expect(prepared.github.createRequests).toEqual([]);
  });

  it("CONFIRM after a WRITTEN activation refuses it and leaves the run uncompleted", async () => {
    const prepared = await prepare(`bpi-post-${refusal.toLowerCase()}`);
    const { harness, runId } = prepared;
    await produceAndActivate(prepared);
    expect(prepared.github.createRequests).toHaveLength(1);
    mutate(prepared);

    const confirmed = confirm(prepared);
    expect(confirmed.allowed, JSON.stringify(confirmed)).toBe(false);
    expect(harness.cp.runs.require(runId).state).not.toBe(RunState.COMPLETED);
    expect(prepared.github.createRequests).toHaveLength(1);
  });
});

describe("BPI-R1-01: the normal path is unchanged", () => {
  it("a review whose intent digest is the current projection reaches the create and CONFIRM", async () => {
    const prepared = await prepare("bpi-normal");
    expect(prepared.harness.cp.bootstrap.reviewForConfirmation(prepared.runId, prepared.snapshotDigest)).toMatchObject({ allowed: true });
    await produceAndActivate(prepared);
    const confirmed = confirm(prepared);
    expect(confirmed.allowed, JSON.stringify(confirmed)).toBe(true);
    expect(prepared.harness.cp.runs.require(prepared.runId).state).toBe(RunState.COMPLETED);
    expect(prepared.github.createRequests).toHaveLength(1);
  });
});

describe("BPI-R1-01: a task replaced during the pipeline's final continuity await", () => {
  it.each(["REVISE", "BLOCK", "PASS_WITH_OMISSION"])("refuses the stale %s outcome: no revision delivered, none recorded as returned", async (verdict) => {
    const h = makeHarness();
    bindCeo(h);
    const made = h.cp.runs.create({
      kind: RunKind.PROJECT_BOOTSTRAP,
      executionMode: ExecutionMode.STANDARD,
      contract: { goal: "bootstrap", why: "new repository", scope: [], nonGoals: [], acceptance: ["repository created"], priority: "NORMAL", humanGate: [], references: [] },
    });
    if (!made.allowed) throw new Error(made.message);
    const runId = made.value.runId;
    await dispatchBootstrapRun(h.cp, h.clock, runId);
    let seq = 0;
    const call = (name: string, args: Record<string, unknown>) => callCtoToolAsOwner(h, runId, name, { runId, idempotencyKey: `bpi-${++seq}`, ...args });
    const plan = bootstrapPlan(cleanTreeManifest("bpi-stale-revision"));
    const task = (criterion: string) => ({ key: criterion, title: "create repository", category: "implementation", spec: { completionCriteria: [criterion] } });
    expect((await call("plan_submit", { plan, tasks: [task("old criterion")] })).body).toMatchObject({ ok: true });
    const originalPlanDigest = h.cp.artifacts.latest(runId, "PLAN")!.digest;
    const answer = JSON.parse(reviewerRevise(bootstrapCoverageKeys(h, runId), "old task needs revision")) as Record<string, unknown>;
    answer["verdict"] = verdict === "PASS_WITH_OMISSION" ? "PASS" : verdict;
    if (verdict === "PASS_WITH_OMISSION") answer["omittedItems"] = ["not examined"];
    h.scripted.script({ match: /Bootstrap plan review/, text: JSON.stringify(answer) });
    let replanned = false;
    const evaluate = h.cp.continuity.evaluate.bind(h.cp.continuity);
    vi.spyOn(h.cp.continuity, "evaluate").mockImplementation(async (reason: string) => {
      if (reason === "blind-review-unavailable" && !replanned) {
        replanned = true;
        expect((await call("plan_submit", { plan, tasks: [task("new criterion")] })).body).toMatchObject({ ok: true });
      }
      return evaluate(reason);
    });

    const result = await call("result_submit", { resultSummary: "prepared", recommendation: "create" });

    expect(replanned).toBe(true);
    const review = h.cp.artifacts.latest<{ bootstrapPlanIntentDigest?: string }>(runId, "BLIND_REVIEW")!;
    const current = bootstrapPlanIntent({ runId, planArtifact: h.cp.artifacts.latest(runId, "PLAN")!, tasks: h.cp.tasks.list(runId) });
    expect(h.cp.artifacts.latest(runId, "PLAN")!.digest).toBe(originalPlanDigest);
    expect(current.allowed && current.value.digest).not.toBe(review.content.bootstrapPlanIntentDigest);
    expect(JSON.stringify(result.body)).toContain("CANDIDATE_STALE");
    expect(h.cp.outbox.listByRun(runId).filter((message) => message.kind === "REVISION_REQUEST")).toHaveLength(0);
    expect(h.cp.audit.byKind("REVISION_RETURNED_TO_CTO").filter((row) => row.runId === runId)).toHaveLength(0);
  });
});

describe("BPI-R1-02: the lifecycle does not assert a legacy singleton's provenance", () => {
  it("a READY task stored before any PLAN, with no binding record, is not claimed to be the PLAN's, and the exception is disclosed", async () => {
    const h = makeHarness();
    bindCeo(h);
    const created = h.cp.runs.create({
      kind: RunKind.PROJECT_BOOTSTRAP,
      executionMode: ExecutionMode.STANDARD,
      contract: { goal: "bootstrap", why: "new repo", scope: [], nonGoals: [], acceptance: ["created"], priority: "NORMAL", humanGate: [], references: [] },
    });
    if (!created.allowed) throw new Error(created.message);
    const runId = created.value.runId;
    await dispatchBootstrapRun(h.cp, h.clock, runId);
    // The supported pre-#1114 shape: one READY task, no BOOTSTRAP_PLAN_TASKS row, stored before any PLAN.
    expect(h.cp.tasks.submit(runId, [{ key: "old", title: "task predating this PLAN", category: "implementation" }])).toMatchObject({ allowed: true });
    const plan = h.cp.artifacts.put(runId, "PLAN", bootstrapPlan(cleanTreeManifest("bpi-legacy-task")));
    expect(h.cp.audit.byKind("BOOTSTRAP_PLAN_TASKS").filter((row) => row.runId === runId)).toEqual([]);
    expect(h.cp.tasks.bootstrapReviewEntry(runId, plan.digest)).toMatchObject({ allowed: true });
    h.scripted.script({ match: /Bootstrap plan review/, text: reviewerPass(bootstrapCoverageKeys(h, runId)) });
    const owner = h.cp.runs.require(runId);
    const result = await h.cp.pipeline.submitResult({
      runId,
      ownerSessionId: owner.ownerSessionId!,
      ownerBindingGeneration: owner.ownerBindingGeneration!,
      resultSummary: "ready",
      recommendation: "create",
    });
    expect(result).toMatchObject({ allowed: true, value: { stage: "COMPLETED_REVIEW" } });
    const prompt = h.scripted.invocations.find((invocation) => invocation.prompt.startsWith("# Bootstrap plan review"))!.prompt;
    const lines = prompt.split("\n");
    expect(lines.find((line) => line.startsWith("- [plan-one-task]"))).not.toContain("created with the current PLAN");
    const notVerified = lines.indexOf("Conditions the control plane does not verify:");
    const disclosed = lines.findIndex((line) => line.startsWith("- [plan-task-legacy-provenance]"));
    expect(notVerified).toBeGreaterThan(0);
    expect(disclosed).toBeGreaterThan(notVerified);
    expect(lines[disclosed]).toContain("BOOTSTRAP_PLAN_TASKS");
  });
});
