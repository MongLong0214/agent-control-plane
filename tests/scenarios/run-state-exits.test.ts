import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import type { ProjectManifest } from "../../src/contracts/manifest.ts";
import { manifestDigest } from "../../src/contracts/manifest.ts";
import { sha256 } from "../../src/core/digest.ts";
import { deny, isAcpError } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ApprovedRunFinalizer } from "../../src/daemon/finalizer.ts";
import { Role, RunKind, RunState, roleKeyFor } from "../../src/domain/types.ts";
import { retireProject } from "../../src/registry/project-retirement.ts";
import { WORKFLOW, WORKFLOW_PATH, dispatchRun, normalized, stricter, type DispatchedRun } from "../helpers/contract-change.ts";
import { FakeGitHub } from "../helpers/fake-github.ts";
import { cleanupTempDirs, commitAll, writeFiles } from "../helpers/fixtures.ts";
import {
  applyPassingChange,
  bindWorker,
  carryContractChange,
  decideThroughHermes,
  driveToReviewedCandidate,
  makeHarness,
  registerFixtureProject,
  reviewerPass,
  type Harness,
} from "../helpers/harness.ts";
import type { CandidateSnapshot } from "../../src/snapshot/candidate-snapshot.ts";

afterAll(cleanupTempDirs);
afterEach(() => vi.restoreAllMocks());

/**
 * #1189, the state-transition slice (CEO rulings 1-4): the cancel exits B14 and B15, the follow-up retry
 * B13 and the retirement settlement A10, through the production paths — the CEO decision, RunEngine.cancel,
 * the daemon finalizer and project retirement. Raw SQL appears only to write the history no current
 * production path can write (a merge receipt of a CONTRACT_CHANGE confirmed before grants existed, a grant
 * consumed by something other than this run's activation), and is named where it does.
 *
 * Reason codes this slice adds are written as literals, so the file runs against a tree that predates them
 * and fails on its assertions.
 */

const CI_PATH = ".github/workflows/project-ci.yml";
const CI = "name: project-ci\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: node verify.js\n";
const INCOMPLETE = "POST_MERGE_CHECKS_INCOMPLETE";
const UNCONFIRMED = "CANCEL_NON_APPLICATION_UNCONFIRMED";

/** A refusal's reason code, whether the call denied or a guard threw. */
const refusalOf = (call: () => { allowed: boolean; reasonCode: string }): string => {
  try {
    const result = call();
    return result.allowed ? "ALLOWED" : result.reasonCode;
  } catch (error) {
    if (isAcpError(error)) return error.reasonCode;
    throw error;
  }
};

/** GitHub's merged pull keeps its base snapshot; the target ref is reread separately. */
const reflectMergedBase = (github: FakeGitHub): void => {
  const request = github.request.bind(github);
  github.request = async <T>(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> => {
    const answer = await request<T>(method, path, body);
    if (method !== "PUT" || !/\/pulls\/\d+\/merge$/.test(path) || !answer || typeof answer !== "object") return answer;
    const merged = answer as { merged?: unknown; sha?: unknown };
    const number = Number(/\/pulls\/(\d+)\/merge$/.exec(path)?.[1]);
    const pull = github.pulls.find((entry) => entry.number === number);
    if (merged.merged !== true || typeof merged.sha !== "string" || !pull) return answer;
    pull.merge_commit_sha = merged.sha;
    github.setBranch(pull.base.ref, merged.sha);
    return answer;
  };
};

type CheckOutcome = "success" | "failure" | "missing";

/**
 * A STANDARD_WORK run with one repository, reviewed and packeted: at CEO review, nobody having decided.
 * Its declared post-merge check `project-ci` answers `outcome` once the merge lands.
 */
const reviewedRun = async (outcome: CheckOutcome = "success") => {
  const github = new FakeGitHub();
  reflectMergedBase(github);
  const harness = makeHarness({ githubClient: github });
  harness.cp.credentials.install({ token: "test-token", creatorIdentity: "acp-trusted-app" });
  writeFiles(harness.repoPath, { [CI_PATH]: CI });
  commitAll(harness.repoPath, "add trusted project CI workflow");
  const driven = await driveToReviewedCandidate(harness, {
    workBranch: "feature/run-state-exits",
    manifestOverrides: {
      ciWorkflows: [{ path: CI_PATH, checkName: "project-ci", approvedDigest: sha256(CI), unapprovedFirstActivation: false, repositoryRole: "primary" }],
    },
  });
  github.setBranch("dev", driven.baseHead);
  github.setBranch("main", "m".repeat(40));
  github.setBranch(driven.workBranch, driven.candidateHead);
  github.nextMergeSha = driven.candidateHead;
  github.onMerge = ({ mergeSha }) => {
    if (outcome === "success") github.setTrustedPostMergeCheck(mergeSha, "project-ci", CI_PATH);
    if (outcome === "failure") github.setPostMergeCheck(mergeSha, "project-ci", "failure");
  };
  const claimed = harness.cp.claims.acquire({
    runId: driven.runId,
    ownerSessionId: driven.ownerSessionId,
    ownerBindingGeneration: driven.ownerBindingGeneration,
    ownerRoleKey: harness.cp.runs.require(driven.runId).ownerRoleKey!,
    repositoryIdentity: driven.identity,
    branch: driven.workBranch,
  });
  if (!claimed.allowed) throw new Error(claimed.message);
  await harness.cp.continuity.evaluate("run-state exits packet");
  const packet = harness.cp.ceo.buildPacket({
    runId: driven.runId,
    candidateSnapshotDigest: driven.candidateSnapshotDigest,
    approval: {
      runId: driven.runId,
      candidateSnapshotDigest: driven.candidateSnapshotDigest,
      resultSummary: "candidate verified",
      recommendation: "merge",
      residualRisk: [],
      approvedBySessionId: driven.ownerSessionId,
      approvedByGeneration: driven.ownerBindingGeneration,
      approvedAt: harness.clock.nowIso(),
    },
  });
  if (!packet.allowed) throw new Error(`${packet.reasonCode}: ${packet.message}`);
  expect(harness.cp.runs.require(driven.runId).state).toBe(RunState.READY_FOR_CEO_REVIEW);
  return { github, harness, driven };
};

const confirmIn = (h: Harness, runId: string, candidateSnapshotDigest: string) =>
  h.cp.ceo.submitCeoDecision({
    runId,
    decision: "CONFIRM",
    candidateSnapshotDigest,
    ceoSessionId: h.cp.bindings.active(roleKeyFor(Role.CEO))!.sessionId,
    rationale: "exact packet accepted",
  });

/** A STANDARD_WORK run confirmed and finalized once: its one merge landed, and its check answered `outcome`. */
const mergedRun = async (outcome: CheckOutcome) => {
  const fixture = await reviewedRun(outcome);
  expect(confirmIn(fixture.harness, fixture.driven.runId, fixture.driven.candidateSnapshotDigest)).toMatchObject({ allowed: true });
  const first = await new ApprovedRunFinalizer(fixture.harness.cp).finalizeApprovedRun(fixture.driven.runId);
  if (outcome === "success") expect(first).toMatchObject({ allowed: true });
  else expect(first).toMatchObject({ allowed: false, reasonCode: ReasonCode.FINALIZATION_COMPENSATION_REQUIRED });
  expect(fixture.github.mergeCount).toBe(1);
  return fixture;
};

/** What a merge left behind, which a follow-up decision must never change. */
const mergedFacts = (h: Harness, runId: string) => ({
  receipts: h.cp.db.all(
    `SELECT receipt_id, operation, repository_identity, status, verified, after_state_digest
       FROM github_receipts WHERE run_id = ? AND operation <> 'post_merge_verify' ORDER BY receipt_id`,
    [runId],
  ),
  merged: h.cp.db.all(`SELECT repository_id, merge_state FROM run_repositories WHERE run_id = ? ORDER BY 1`, [runId]),
});

const attemptOf = (h: Harness, runId: string) =>
  h.cp.db.get<{ attempt_id: string; state: string; failure_reason: string | null }>(
    `SELECT attempt_id, state, failure_reason FROM finalization_attempts WHERE run_id = ?`,
    [runId],
  );

const resumes = (h: Harness, runId: string) => h.cp.audit.forRun(runId).filter((entry) => entry.kind === "FINALIZATION_POST_MERGE_RESUMED");

// ---------------------------------------------------------------------------------------------------
// CONTRACT_CHANGE fixtures

/** A dispatched CONTRACT_CHANGE with no repositories, its PLAN carrying `proposed`, reviewed: at CEO review. */
const readyContractChange = async (
  h: Harness,
  projectId: string,
  propose: (base: ProjectManifest) => ProjectManifest = (base) => normalized({ ...base, commitlore: { mode: "required" } }),
): Promise<{ run: DispatchedRun; proposed: ProjectManifest; candidate: string }> => {
  const run = await dispatchRun(h, projectId, RunKind.CONTRACT_CHANGE);
  const proposed = carryContractChange(h, run.runId, propose(run.base));
  await h.cp.continuity.evaluate("contract change candidate");
  const submitted = await h.cp.pipeline.submitResult({
    runId: run.runId,
    ownerSessionId: run.ownerSessionId,
    ownerBindingGeneration: run.ownerBindingGeneration,
    resultSummary: "the proposed manifest",
    recommendation: "activate the contract change",
    residualRisk: [],
  });
  if (!submitted.allowed) throw new Error(`${submitted.reasonCode}: ${submitted.message}`);
  expect(h.cp.runs.require(run.runId).state).toBe(RunState.READY_FOR_CEO_REVIEW);
  return { run, proposed, candidate: h.cp.runs.currentCandidate(run.runId)! };
};

/** What a CONTRACT_CHANGE confirmed before grants existed is: CEO_APPROVED (or later) with no grant. */
const legacyApproved = async (h: Harness, projectId: string, to: RunState = RunState.CEO_APPROVED) => {
  const ready = await readyContractChange(h, projectId);
  const edges: RunState[] = [RunState.CEO_APPROVED, RunState.MERGING, RunState.POST_MERGE_VERIFYING];
  for (const edge of edges.slice(0, edges.indexOf(to) + 1)) {
    expect(h.cp.runs.transition(ready.run.runId, edge, "confirmed before grants", { candidateSnapshotDigest: ready.candidate }).allowed).toBe(true);
  }
  return ready;
};

const grantsOf = (h: Harness, runId: string) =>
  h.cp.db.all(`SELECT grant_id, consumed_at FROM manifest_activation_grants WHERE run_id = ?
               UNION ALL SELECT grant_id, consumed_at FROM manifest_first_activation_grants WHERE run_id = ?`, [runId, runId]);

/** Raw history only: a merge_execute receipt of a run confirmed before grants, reserved and, if `applied`, completed. */
const legacyMergeReceipt = (h: Harness, runId: string, applied: boolean): void => {
  const key = `merge_execute:github:acme/legacy:${runId}`;
  h.cp.db.run(`INSERT INTO github_receipts (receipt_id, idempotency_key, operation, run_id, repository_identity, resource_type,
      resource_identity, preexisting, before_state_digest, after_state_digest, request_digest, response_json, created_at, reread_at,
      verified, status)
    VALUES (?, ?, 'merge_execute', ?, 'github:acme/legacy', 'merge', 'acme/legacy#1', 0, 'sha256:before', NULL, 'sha256:req',
      '{"pending":true}', ?, NULL, 0, 'PENDING')`, [`rcpt_${runId}`, key, runId, h.clock.nowIso()]);
  if (applied) {
    h.cp.db.run(`UPDATE github_receipts SET status = 'APPLIED', after_state_digest = 'sha256:after', reread_at = ?, verified = 1,
        response_json = '{"sha":"${"a".repeat(40)}"}' WHERE idempotency_key = ?`, [h.clock.nowIso(), key]);
  }
};

/**
 * A CONTRACT_CHANGE with one repository, confirmed through the door: its CI workflow and the manifest that
 * requires it are merged first, then the manifest is activated. The fixture contract-change-activate.test.ts
 * builds for W18, with the CEO's CONFIRM taken here.
 */
const confirmedRepositoryContractChange = async (projectId: string) => {
  const github = new FakeGitHub();
  reflectMergedBase(github);
  const h = makeHarness({ githubClient: github });
  writeFiles(h.repoPath, { [CI_PATH]: CI });
  commitAll(h.repoPath, "add the trusted project CI workflow");
  const registered = await registerFixtureProject(h, projectId, {
    ciWorkflows: [{ path: CI_PATH, checkName: "project-ci", approvedDigest: sha256(CI), unapprovedFirstActivation: false, repositoryRole: "primary" }],
  });
  const run = await dispatchRun(h, registered.projectId, RunKind.CONTRACT_CHANGE, [
    { repositoryId: registered.repositoryId, repositoryRole: "primary", baseBranch: "dev" },
  ]);
  const m1 = stricter(run.base);
  carryContractChange(h, run.runId, m1);
  const tasks = h.cp.tasks.submit(run.runId, [{ key: "workflow", title: "add the CI workflow", category: "implementation" }]);
  if (!tasks.allowed) throw new Error(tasks.message);
  const task = h.cp.tasks.ready(run.runId)[0]!;
  const execution = h.cp.tasks.startExecution({
    runId: run.runId,
    taskId: task.taskId,
    ownerBindingGeneration: run.ownerBindingGeneration,
    workerSessionId: bindWorker(h, task.taskId),
    provider: "scripted",
    model: "scripted-worker",
    repositoryId: registered.repositoryId,
  });
  if (!execution.allowed) throw new Error(execution.message);
  const workBranch = `feature/F1-${projectId}`;
  applyPassingChange(h.repoPath, workBranch);
  writeFiles(h.repoPath, { [WORKFLOW_PATH]: WORKFLOW });
  const head = commitAll(h.repoPath, "add the CI workflow the contract change approves");
  h.cp.tasks.finishExecution(execution.value.executionId, { status: "SUCCEEDED", resultDigest: `sha256:${head}` });
  await h.cp.continuity.evaluate("repository contract change");
  const claimed = h.cp.claims.acquire({
    runId: run.runId,
    ownerSessionId: run.ownerSessionId,
    ownerBindingGeneration: run.ownerBindingGeneration,
    ownerRoleKey: h.cp.runs.require(run.runId).ownerRoleKey!,
    repositoryIdentity: registered.identity,
    branch: workBranch,
  });
  if (!claimed.allowed) throw new Error(claimed.message);
  h.scripted.script({
    match: /# Candidate review/,
    text: reviewerPass([`${registered.identity}:src/app.js`, `${registered.identity}:${WORKFLOW_PATH}`, `${run.projectId}:#manifest/${manifestDigest(m1)}`]),
  });
  const submitted = await h.cp.pipeline.submitResult({
    runId: run.runId,
    ownerSessionId: run.ownerSessionId,
    ownerBindingGeneration: run.ownerBindingGeneration,
    resultSummary: "the CI workflow and the manifest that requires it",
    recommendation: "activate the contract change",
    residualRisk: [],
  });
  if (!submitted.allowed) throw new Error(`${submitted.reasonCode}: ${submitted.message}`);
  const candidate = h.cp.runs.currentCandidate(run.runId)!;
  const snapshot = h.cp.artifacts.latestForSnapshot<CandidateSnapshot>(run.runId, "CANDIDATE_SNAPSHOT", candidate)!.content;
  const repository = snapshot.repositories[0]!;
  github.setBranch("dev", repository.baseHead);
  github.setBranch("main", "m".repeat(40));
  github.setBranch(workBranch, repository.candidateHead);
  github.nextMergeSha = repository.candidateHead;
  github.onMerge = ({ mergeSha }) => github.setTrustedPostMergeCheck(mergeSha, "project-ci", CI_PATH);
  await h.cp.continuity.evaluate("confirm the contract change");
  expect((await decideThroughHermes(h, { runId: run.runId, decision: "CONFIRM", candidateSnapshotDigest: candidate })).allowed).toBe(true);
  return { github, h, registered, run, m1 };
};

/**
 * The finalizer's workflow reads: two before the merge (the base's and the change's workflow, at the
 * candidate head), then two at activation. The first read at activation fails as a transport failure, once.
 */
const failFirstActivationRead = (h: Harness): void => {
  const read = h.cp.github.workflowDigestAt.bind(h.cp.github);
  let reads = 0;
  vi.spyOn(h.cp.github, "workflowDigestAt").mockImplementation(async (...args) => {
    reads += 1;
    return reads === 3 ? deny(ReasonCode.PROBE_FAILED, "could not read the workflow at the exact commit", { status: 502 }) : read(...args);
  });
};

// ---------------------------------------------------------------------------------------------------

describe("B14 — a run at CEO review is cancelled directly; the cancel and its CONFIRM never both take effect", () => {
  it("cancel first: the run is CANCELLED with its graph, the CONFIRM after it is refused, and nothing is merged", async () => {
    const { github, harness, driven } = await reviewedRun();
    const cancelled = harness.cp.runs.cancel(driven.runId, "the CEO withdraws the work");
    expect(cancelled).toMatchObject({ allowed: true, value: { state: RunState.CANCELLED } });
    expect(harness.cp.tasks.list(driven.runId).every((task) => task.state === "CANCELLED" || task.state === "SUCCEEDED")).toBe(true);
    expect(confirmIn(harness, driven.runId, driven.candidateSnapshotDigest)).toMatchObject({ allowed: false, reasonCode: ReasonCode.RUN_TRANSITION_ILLEGAL });
    expect(harness.cp.audit.forRun(driven.runId).filter((entry) => entry.kind === "CEO_DECISION")).toEqual([]);
    expect(await new ApprovedRunFinalizer(harness.cp).finalizeApprovedRun(driven.runId)).toMatchObject({ allowed: false });
    expect(github.mergeCount).toBe(0);
    expect(harness.cp.runs.require(driven.runId).state).toBe(RunState.CANCELLED);
  });

  it("CONFIRM first (guard): the cancel after it is refused, and the run finalizes as confirmed", async () => {
    const { github, harness, driven } = await reviewedRun();
    expect(confirmIn(harness, driven.runId, driven.candidateSnapshotDigest)).toMatchObject({ allowed: true, value: { state: RunState.CEO_APPROVED } });
    expect(harness.cp.runs.cancel(driven.runId, "too late")).toMatchObject({ allowed: false, reasonCode: ReasonCode.RUN_TRANSITION_ILLEGAL });
    expect(await new ApprovedRunFinalizer(harness.cp).finalizeApprovedRun(driven.runId)).toMatchObject({ allowed: true });
    expect(harness.cp.runs.require(driven.runId).state).toBe(RunState.COMPLETED);
    expect(github.mergeCount).toBe(1);
  });
});

describe("B15 — a CONTRACT_CHANGE confirmed without an activation grant is cancelled only on confirmed non-application", () => {
  it("a finalization in flight is a delay, not non-application: refused while it holds the run, cancelled once it ended; a late finalizer acquires nothing", async () => {
    const h = makeHarness();
    const { projectId } = await registerFixtureProject(h, "cc-b15-delay");
    const { run } = await legacyApproved(h, projectId);
    expect(grantsOf(h, run.runId)).toEqual([]);

    const finalizer = new ApprovedRunFinalizer(h.cp);
    let release!: () => void;
    const hung = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(finalizer as unknown as { reconfirmAndPlan: () => Promise<unknown> }, "reconfirmAndPlan").mockImplementation(async () => {
      await hung;
      return deny(ReasonCode.MANIFEST_ACTIVATION_GRANT_MISSING, "this run holds no activation grant", { runId: run.runId });
    });
    const finalizing = finalizer.finalizeApprovedRun(run.runId);
    await vi.waitFor(() => expect(attemptOf(h, run.runId)?.state).toBe("RUNNING"), { timeout: 10_000, interval: 10 });

    const delayed = h.cp.runs.cancel(run.runId, "abandon the legacy change");
    expect(delayed).toMatchObject({ allowed: false, reasonCode: UNCONFIRMED, evidence: { classification: "DELAY" } });
    expect(h.cp.runs.require(run.runId).state).toBe(RunState.CEO_APPROVED);

    release();
    expect((await finalizing).allowed).toBe(false);
    expect(attemptOf(h, run.runId)?.state).not.toBe("RUNNING");
    const cancelled = h.cp.runs.cancel(run.runId, "abandon the legacy change");
    expect(cancelled).toMatchObject({ allowed: true, value: { state: RunState.CANCELLED } });
    const edge = h.cp.audit.forRun(run.runId).filter((entry) => entry.kind === "RUN_TRANSITION").at(-1)!;
    expect(edge.evidence).toMatchObject({ from: RunState.CEO_APPROVED, to: RunState.CANCELLED, cancelAfterApproval: { classification: "NON_APPLICATION_CONFIRMED", grantId: null, mergeReceipts: [] } });

    // A finalizer that read the run before the cancel committed asks again in the transaction that takes the lease.
    const late = new ApprovedRunFinalizer(h.cp);
    const stale = { ...h.cp.runs.require(run.runId), state: RunState.CEO_APPROVED };
    const get = h.cp.runs.get.bind(h.cp.runs);
    let first = true;
    vi.spyOn(h.cp.runs, "get").mockImplementation((runId: string) => {
      if (runId === run.runId && first) { first = false; return stale; }
      return get(runId);
    });
    const acquiredBefore = h.cp.audit.forRun(run.runId).filter((entry) => entry.kind === "FINALIZATION_ATTEMPT_ACQUIRED").length;
    expect(await late.finalizeApprovedRun(run.runId)).toMatchObject({ allowed: false, reasonCode: ReasonCode.GATE_AUTHORITY_DENIED });
    expect(h.cp.audit.forRun(run.runId).filter((entry) => entry.kind === "FINALIZATION_ATTEMPT_ACQUIRED")).toHaveLength(acquiredBefore);
    expect(attemptOf(h, run.runId)?.state).not.toBe("RUNNING");
    expect(h.cp.runs.require(run.runId).state).toBe(RunState.CANCELLED);
    expect(grantsOf(h, run.runId)).toEqual([]);
  });

  it("an unknown merge outcome, a merge that landed, and a record naming a grant that does not exist are not cancelled; the run stays as recorded", async () => {
    const h = makeHarness();
    const { projectId } = await registerFixtureProject(h, "cc-b15-classes");
    const unknown = (await legacyApproved(h, projectId, RunState.MERGING)).run.runId;
    legacyMergeReceipt(h, unknown, false);
    expect(h.cp.runs.cancel(unknown, "abandon")).toMatchObject({ allowed: false, reasonCode: UNCONFIRMED, evidence: { classification: "UNKNOWN" } });
    expect(h.cp.runs.require(unknown).state).toBe(RunState.MERGING);

    const applied = (await legacyApproved(h, projectId, RunState.POST_MERGE_VERIFYING)).run.runId;
    legacyMergeReceipt(h, applied, true);
    expect(h.cp.runs.cancel(applied, "abandon")).toMatchObject({
      allowed: false, reasonCode: ReasonCode.FINALIZATION_COMPENSATION_REQUIRED, evidence: { classification: "APPLIED" },
    });
    expect(h.cp.runs.require(applied).state).toBe(RunState.POST_MERGE_VERIFYING);

    const error = (await legacyApproved(h, projectId)).run.runId;
    h.cp.audit.record({ kind: "CEO_DECISION", runId: error, evidence: { decision: "CONFIRM", manifestActivationGrantDigest: "sha256:missing-grant" } });
    expect(h.cp.runs.cancel(error, "abandon")).toMatchObject({ allowed: false, reasonCode: UNCONFIRMED, evidence: { classification: "ERROR" } });
    expect(h.cp.runs.require(error).state).toBe(RunState.CEO_APPROVED);
  });

  it("no duplicate grant: a CONFIRM after the cancel issues none, and a granted run is refused the cancel by code and by the database", async () => {
    const h = makeHarness();
    const { projectId } = await registerFixtureProject(h, "cc-b15-grant");
    const legacy = await legacyApproved(h, projectId);
    // Before the cancel, a CONFIRM of the grant-less run (a consumer re-entry) issues nothing.
    expect((await decideThroughHermes(h, { runId: legacy.run.runId, decision: "CONFIRM", candidateSnapshotDigest: legacy.candidate })).allowed).toBe(false);
    expect(grantsOf(h, legacy.run.runId)).toEqual([]);
    expect(h.cp.runs.cancel(legacy.run.runId, "abandon the legacy change")).toMatchObject({ allowed: true });
    const after = await decideThroughHermes(h, { runId: legacy.run.runId, decision: "CONFIRM", candidateSnapshotDigest: legacy.candidate });
    expect(after).toMatchObject({ allowed: false, reasonCode: ReasonCode.RUN_TRANSITION_ILLEGAL });
    expect(grantsOf(h, legacy.run.runId)).toEqual([]);

    // A run confirmed through the door holds its one grant: the cancel is refused, and so is the raw edge.
    const granted = await readyContractChange(h, projectId);
    await h.cp.continuity.evaluate("confirm the contract change");
    expect((await decideThroughHermes(h, { runId: granted.run.runId, decision: "CONFIRM", candidateSnapshotDigest: granted.candidate })).allowed).toBe(true);
    expect(grantsOf(h, granted.run.runId)).toHaveLength(1);
    expect(h.cp.runs.cancel(granted.run.runId, "abandon")).toMatchObject({ allowed: false, reasonCode: ReasonCode.RUN_TRANSITION_ILLEGAL, evidence: { classification: "GRANTED" } });
    expect(refusalOf(() => h.cp.runs.transition(granted.run.runId, RunState.CANCELLED, "raw edge"))).toBe(ReasonCode.RUN_TRANSITION_ILLEGAL);
    expect(h.cp.runs.require(granted.run.runId).state).toBe(RunState.CEO_APPROVED);
    expect(grantsOf(h, granted.run.runId)).toHaveLength(1);
  });
});

describe("B13 — only the follow-up of a verified merge is retried, on the same merge, within its budget", () => {
  it("(a) a declared check still missing when the bounded wait ended is looked up again on the same merge, and the run completes", async () => {
    const { github, harness, driven } = await mergedRun("missing");
    expect(harness.cp.runs.require(driven.runId).state).toBe(RunState.BLOCKED_POST_MERGE);
    expect(attemptOf(harness, driven.runId)).toMatchObject({ state: "BLOCKED", failure_reason: INCOMPLETE });
    // No answer is not a FAIL: nothing is recorded as verified, and the merge is not marked failed.
    expect(harness.cp.db.get(`SELECT 1 FROM github_receipts WHERE run_id = ? AND operation = 'post_merge_verify'`, [driven.runId])).toBeUndefined();
    const facts = mergedFacts(harness, driven.runId);

    github.setTrustedPostMergeCheck(driven.candidateHead, "project-ci", CI_PATH);
    expect(await new ApprovedRunFinalizer(harness.cp).finalizeApprovedRun(driven.runId)).toMatchObject({ allowed: true });
    expect(harness.cp.runs.require(driven.runId).state).toBe(RunState.COMPLETED);
    expect(github.mergeCount).toBe(1);
    expect(mergedFacts(harness, driven.runId).receipts).toEqual(facts.receipts);
    expect(resumes(harness, driven.runId).map((entry) => entry.evidence)).toEqual([
      expect.objectContaining({ followUp: INCOMPLETE, followUpRetry: 1, followUpBudget: 3 }),
    ]);
  });

  it("(b) a CONTRACT_CHANGE whose activation read failed transiently after its verified merge is activated again, on the same merge; its grant is consumed once", async () => {
    const { github, h, registered, run, m1 } = await confirmedRepositoryContractChange("cc-b13-activation");
    failFirstActivationRead(h);
    expect(await new ApprovedRunFinalizer(h.cp).finalizeApprovedRun(run.runId)).toMatchObject({ allowed: false });
    expect(github.mergeCount).toBe(1);
    expect(h.cp.runs.require(run.runId).state).toBe(RunState.BLOCKED_POST_MERGE);
    expect(attemptOf(h, run.runId)).toMatchObject({ state: "BLOCKED", failure_reason: ReasonCode.MANIFEST_ACTIVATION_REFUSED });
    expect(grantsOf(h, run.runId)).toEqual([expect.objectContaining({ consumed_at: null })]);
    expect(h.cp.projects.require(registered.projectId).activeManifestDigest).toBe(run.baseDigest);
    const facts = mergedFacts(h, run.runId);

    expect(await new ApprovedRunFinalizer(h.cp).finalizeApprovedRun(run.runId)).toMatchObject({ allowed: true });
    expect(h.cp.runs.require(run.runId).state).toBe(RunState.COMPLETED);
    expect(github.mergeCount).toBe(1);
    expect(mergedFacts(h, run.runId).receipts).toEqual(facts.receipts);
    expect(h.cp.projects.require(registered.projectId).activeManifestDigest).toBe(manifestDigest(m1));
    expect(grantsOf(h, run.runId)).toEqual([expect.objectContaining({ consumed_at: expect.any(String) })]);
    expect(h.cp.audit.byKind("PROJECT_MANIFEST_ACTIVATED").filter((entry) => entry.runId === run.runId)).toHaveLength(1);
    expect(resumes(h, run.runId).map((entry) => entry.evidence["followUp"])).toEqual(["ACTIVATION_READ_TRANSIENT"]);
  });

  it("a real check FAIL is not retried: the block, its merge and its receipts stay as they are across passes", async () => {
    const { github, harness, driven } = await mergedRun("failure");
    const facts = mergedFacts(harness, driven.runId);
    for (let pass = 0; pass < 2; pass += 1) {
      expect(await new ApprovedRunFinalizer(harness.cp).finalizeApprovedRun(driven.runId)).toMatchObject({
        allowed: false, reasonCode: ReasonCode.FINALIZATION_COMPENSATION_REQUIRED, evidence: { followUp: { refusal: "NOT_RETRYABLE" } },
      });
    }
    expect(harness.cp.runs.require(driven.runId).state).toBe(RunState.BLOCKED_POST_MERGE);
    expect(resumes(harness, driven.runId)).toEqual([]);
    expect(mergedFacts(harness, driven.runId)).toEqual(facts);
    expect(github.mergeCount).toBe(1);
  });

  it("a changed candidate is not retried", async () => {
    const { harness, driven } = await mergedRun("missing");
    vi.spyOn(harness.cp.runs, "currentCandidate").mockReturnValue("sha256:another-candidate");
    expect(await new ApprovedRunFinalizer(harness.cp).finalizeApprovedRun(driven.runId)).toMatchObject({
      allowed: false, reasonCode: ReasonCode.FINALIZATION_COMPENSATION_REQUIRED, evidence: { followUp: { cause: INCOMPLETE, refusal: "CANDIDATE_CHANGED" } },
    });
    expect(resumes(harness, driven.runId)).toEqual([]);
    expect(harness.cp.runs.require(driven.runId).state).toBe(RunState.BLOCKED_POST_MERGE);
  });

  it("a consumed grant is not used again", async () => {
    const { github, h, registered, run } = await confirmedRepositoryContractChange("cc-b13-consumed");
    failFirstActivationRead(h);
    await new ApprovedRunFinalizer(h.cp).finalizeApprovedRun(run.runId);
    expect(h.cp.runs.require(run.runId).state).toBe(RunState.BLOCKED_POST_MERGE);
    // Raw history only: the grant consumed by something other than this run's activation.
    h.cp.db.run(`UPDATE manifest_activation_grants SET consumed_at = ?, consumed_attempt_id = 'finalize_elsewhere' WHERE run_id = ?`, [h.clock.nowIso(), run.runId]);
    expect(await new ApprovedRunFinalizer(h.cp).finalizeApprovedRun(run.runId)).toMatchObject({
      allowed: false, evidence: { followUp: { cause: "ACTIVATION_READ_TRANSIENT", refusal: "GRANT_CONSUMED" } },
    });
    expect(resumes(h, run.runId)).toEqual([]);
    expect(h.cp.projects.require(registered.projectId).activeManifestDigest).toBe(run.baseDigest);
    expect(github.mergeCount).toBe(1);
  });

  it("a spent budget leaves the run blocked with its blocker and its owner recorded once", async () => {
    const { github, harness, driven } = await mergedRun("missing");
    for (let retry = 1; retry <= 3; retry += 1) {
      expect(await new ApprovedRunFinalizer(harness.cp).finalizeApprovedRun(driven.runId)).toMatchObject({ allowed: false });
      expect(harness.cp.runs.require(driven.runId).state).toBe(RunState.BLOCKED_POST_MERGE);
      expect(resumes(harness, driven.runId)).toHaveLength(retry);
    }
    for (let pass = 0; pass < 2; pass += 1) {
      expect(await new ApprovedRunFinalizer(harness.cp).finalizeApprovedRun(driven.runId)).toMatchObject({
        allowed: false, reasonCode: ReasonCode.FINALIZATION_COMPENSATION_REQUIRED, evidence: { followUp: { refusal: "BUDGET_EXHAUSTED", retriesUsed: 3, budget: 3 } },
      });
    }
    expect(resumes(harness, driven.runId)).toHaveLength(3);
    const exhausted = harness.cp.audit.forRun(driven.runId).filter((entry) => entry.kind === "FINALIZATION_FOLLOW_UP_EXHAUSTED");
    expect(exhausted).toHaveLength(1);
    expect(exhausted[0]).toMatchObject({ roleKey: "CEO", evidence: { owner: "CEO", blocker: INCOMPLETE, cause: INCOMPLETE, retriesUsed: 3, budget: 3 } });
    expect(github.mergeCount).toBe(1);
  });
});

describe("A10 — retirement proceeds only when nothing a terminal block holds is still open", () => {
  it("settled: a block with a real check FAIL and nothing open lets the owner's retirement proceed; the run and its merged facts are kept", async () => {
    const { github, harness, driven } = await mergedRun("failure");
    const facts = mergedFacts(harness, driven.runId);
    const attempt = attemptOf(harness, driven.runId);
    vi.spyOn(harness.cp.residentProjects, "retire").mockResolvedValue(undefined as never);
    const retired = await retireProject(harness.cp, driven.projectId, "the owner retires the project");
    expect(retired, JSON.stringify(retired)).toMatchObject({ allowed: true, value: { projectId: driven.projectId } });
    expect(harness.cp.projects.get(driven.projectId)?.retiredAt).toEqual(expect.any(String));
    expect(harness.cp.runs.require(driven.runId).state).toBe(RunState.BLOCKED_POST_MERGE);
    expect(attemptOf(harness, driven.runId)).toEqual(attempt);
    expect(mergedFacts(harness, driven.runId)).toEqual(facts);
    expect(github.mergeCount).toBe(1);
  });

  it("open: a block whose follow-up retry is still owed holds retirement, and the refusal names what is open", async () => {
    const { harness, driven } = await mergedRun("missing");
    vi.spyOn(harness.cp.residentProjects, "retire").mockResolvedValue(undefined as never);
    expect(await retireProject(harness.cp, driven.projectId, "the owner retires the project")).toMatchObject({
      allowed: false,
      reasonCode: ReasonCode.CONFLICT,
      evidence: { waitingOn: [{ runId: driven.runId, state: RunState.BLOCKED_POST_MERGE, open: ["FOLLOW_UP_RETRY_PENDING"] }] },
    });
    expect(harness.cp.projects.get(driven.projectId)?.retiredAt ?? null).toBeNull();
    expect(harness.cp.runs.require(driven.runId).state).toBe(RunState.BLOCKED_POST_MERGE);
  });
});
