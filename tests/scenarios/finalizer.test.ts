import { afterAll, describe, expect, it } from "vitest";

import { digestOf, sha256 } from "../../src/core/digest.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ExecutionMode, RunState, Role, roleKeyFor } from "../../src/domain/types.ts";
import { Daemon } from "../../src/daemon/daemon.ts";
import type { GitHubClient } from "../../src/github/github-kernel.ts";
import type { TaskContract } from "../../src/run/run-engine.ts";
import { cleanupTempDirs, commitAll, gitSync, makeRepo, tempDir, writeFiles } from "../helpers/fixtures.ts";
import {
  bindCeo,
  bindWorker,
  driveToReviewedCandidate,
  finalizeNoRepositoryRun,
  fixtureManifest,
  makeHarness,
  registerFixtureProject,
  reviewerPass,
} from "../helpers/harness.ts";
import { FakeGitHub } from "../helpers/fake-github.ts";

afterAll(cleanupTempDirs);

const WORKFLOW_PATH = ".github/workflows/ci.yml";
const WORKFLOW = "name: project-ci\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: node verify.js\n";
type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

/** GitHub's pull reread must show the target ref at the merge SHA for the kernel proof. */
const reflectMergedBase = (github: FakeGitHub): void => {
  const request = github.request.bind(github);
  github.request = async <T>(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<T> => {
    const response = await request<T>(method, path, body);
    if (method !== "PUT" || !/\/pulls\/\d+\/merge$/.test(path) || !response || typeof response !== "object") {
      return response;
    }
    const merged = response as { merged?: unknown; sha?: unknown };
    const number = Number(/\/pulls\/(\d+)\/merge$/.exec(path)?.[1]);
    const pull = github.pulls.find((entry) => entry.number === number);
    if (merged.merged !== true || typeof merged.sha !== "string" || !pull) return response;
    pull.base.sha = merged.sha;
    pull.merge_commit_sha = merged.sha;
    github.setBranch(pull.base.ref, merged.sha);
    return response;
  };
};

const approvedFixture = async (options: { confirm?: boolean } = {}) => {
  const github = new FakeGitHub();
  reflectMergedBase(github);
  const harness = makeHarness({ githubClient: github });
  harness.cp.credentials.install({ token: "test-token", creatorIdentity: "acp-trusted-app" });

  // The exact workflow digest is part of the pinned contract and must exist at the candidate
  // SHA. Commit it before project registration so the frozen base/candidate can prove it.
  writeFiles(harness.repoPath, { [WORKFLOW_PATH]: WORKFLOW });
  commitAll(harness.repoPath, "add trusted project CI workflow");
  const driven = await driveToReviewedCandidate(harness, {
    workBranch: "feature/F1-finalizer",
    manifestOverrides: {
      ciWorkflows: [{ path: WORKFLOW_PATH, checkName: "project-ci", approvedDigest: sha256(WORKFLOW) }],
    },
  });
  github.setBranch("dev", driven.baseHead);
  github.setBranch("main", "m".repeat(40));
  github.setBranch(driven.workBranch, driven.candidateHead);
  github.nextMergeSha = driven.candidateHead;
  github.onMerge = ({ mergeSha }) => github.setTrustedPostMergeCheck(mergeSha, "project-ci", WORKFLOW_PATH);

  const claimed = harness.cp.claims.acquire({
    runId: driven.runId,
    ownerSessionId: driven.ownerSessionId,
    ownerBindingGeneration: driven.ownerBindingGeneration,
    ownerRoleKey: harness.cp.runs.require(driven.runId).ownerRoleKey!,
    repositoryIdentity: driven.identity,
    branch: driven.workBranch,
  });
  if (!claimed.allowed) throw new Error(claimed.message);

  await harness.cp.continuity.evaluate("finalizer test packet");
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
  if (options.confirm === false) return { github, harness, driven };
  const ceo = harness.cp.bindings.active(roleKeyFor(Role.CEO));
  if (!ceo) throw new Error("fixture CEO binding missing");
  const confirmed = harness.cp.ceo.submitCeoDecision({
    runId: driven.runId,
    decision: "CONFIRM",
    candidateSnapshotDigest: driven.candidateSnapshotDigest,
    ceoSessionId: ceo.sessionId,
    rationale: "exact packet accepted",
  });
  if (!confirmed.allowed) throw new Error(`${confirmed.reasonCode}: ${confirmed.message}`);
  expect(harness.cp.runs.require(driven.runId).state).toBe(RunState.CEO_APPROVED);
  return { github, harness, driven };
};

const gatePayloadFor = (fixture: Awaited<ReturnType<typeof approvedFixture>>) => ({
  runId: fixture.driven.runId,
  candidateSnapshotDigest: fixture.driven.candidateSnapshotDigest,
  contractDigest: fixture.driven.contractDigest,
  verificationDigest: fixture.driven.verificationDigest,
  blindReviewDigest: fixture.driven.blindReviewDigest,
  humanGateDigest: digestOf({ humanGate: "NOT_REQUIRED" }),
  bindingGeneration: fixture.driven.ownerBindingGeneration,
  exactHead: fixture.driven.candidateHead,
  timestamp: fixture.harness.clock.nowIso(),
});

/** Model a release tag that already landed before a completed-run replay is requested. */
const recordExistingReleaseTag = (
  fixture: Awaited<ReturnType<typeof approvedFixture>>,
  commit: string,
): void => {
  const { harness, github, driven } = fixture;
  const now = harness.clock.nowIso();
  const key = `merge_execute:${driven.identity}:release-replay`;
  harness.cp.db.run(
    `INSERT INTO github_receipts
       (receipt_id, idempotency_key, operation, run_id, repository_identity, resource_type,
        resource_identity, preexisting, before_state_digest, after_state_digest, request_digest,
        response_json, created_at, reread_at, verified, status)
     VALUES ('receipt_release_replay', ?, 'merge_execute', ?, ?, 'merge', ?, 0, NULL, NULL, ?,
             '{"pending":true}', ?, NULL, 0, 'PENDING')`,
    [
      key,
      driven.runId,
      driven.identity,
      "acme/fixture#release-replay",
      digestOf({ commit, source: "release/1.2.3" }),
      now,
    ],
  );
  harness.cp.db.run(
    `UPDATE github_receipts
        SET status = 'APPLIED', after_state_digest = ?, response_json = ?, reread_at = ?, verified = 1
      WHERE receipt_id = 'receipt_release_replay' AND status = 'PENDING'`,
    [
      sha256(commit),
      JSON.stringify({ mergeCommitSha: commit, sourceBranch: "release/1.2.3", targetBranch: "main" }),
      now,
    ],
  );
  harness.cp.db.run(
    `INSERT INTO github_receipts
       (receipt_id, idempotency_key, operation, run_id, repository_identity, resource_type,
        resource_identity, preexisting, before_state_digest, after_state_digest, request_digest,
        response_json, created_at, reread_at, verified, status)
     VALUES ('receipt_release_post_replay', ?, 'post_merge_verify', ?, ?, 'commit', ?, 0, NULL, ?, ?, ?, ?, ?, 1, 'APPLIED')`,
    [
      `post_merge_verify:${driven.identity}:${commit}`,
      driven.runId,
      driven.identity,
      `acme/fixture@${commit}`,
      digestOf([{ name: "project-ci", conclusion: "success" }]),
      digestOf({ commit, check: "project-ci" }),
      JSON.stringify({ checks: [{ name: "project-ci", conclusion: "success" }] }),
      now,
      now,
    ],
  );
  github.markContains("dev", commit);
  github.tags.set("1.2.3", commit);
};

/** A two-repository version of the real candidate/packet path, used to prove merge ordering. */
const twoRepositoryApprovedFixture = async () => {
  const firstGitHub = new FakeGitHub();
  const secondGitHub = new FakeGitHub();
  reflectMergedBase(firstGitHub);
  reflectMergedBase(secondGitHub);
  const router: GitHubClient = {
    request: async <T>(method: HttpMethod, path: string, body?: unknown) => (
      path.includes("/repos/acme/second/") ? secondGitHub : firstGitHub
    ).request<T>(method, path, body),
  };
  const harness = makeHarness({ githubClient: router });
  harness.cp.credentials.install({ token: "test-token", creatorIdentity: "acp-trusted-app" });
  const secondPath = makeRepo({
    "README.md": "# second repository\n",
    "src/app.js": "module.exports = () => 1;\n",
    "verify.js": "process.exit(0);\n",
  });
  for (const path of [harness.repoPath, secondPath]) {
    writeFiles(path, { [WORKFLOW_PATH]: WORKFLOW });
    commitAll(path, "add trusted project CI workflow");
  }

  const projectId = "two-repository-project";
  const manifest = fixtureManifest(projectId, {
    repositories: [
      { role: "first", remote: "github:acme/first", manifestRoot: "." },
      { role: "second", remote: "github:acme/second", manifestRoot: "." },
    ],
    verificationCommands: [{
      id: "verify",
      argv: ["node", "verify.js"],
      repositoryRole: "first",
      cwd: ".",
      timeoutSeconds: 120,
      envAllowlist: ["CI"],
      network: "deny",
      networkAllowlist: [],
      required: true,
      evidenceMode: "LOCAL_COMMAND",
      maxOutputBytes: 1_048_576,
      maxMemoryMb: 2048,
    }],
    ciWorkflows: [{ path: WORKFLOW_PATH, checkName: "project-ci", approvedDigest: sha256(WORKFLOW) }],
  });
  const project = harness.cp.projects.register({ projectId, name: "two", manifest });
  if (!project.allowed) throw new Error(project.message);
  const first = await harness.cp.repositories.register({
    checkoutPath: harness.repoPath,
    projectId,
    repositoryRole: "first",
    activeManifestDigest: project.value.activeManifestDigest,
    identity: "github:acme/first",
  });
  const second = await harness.cp.repositories.register({
    checkoutPath: secondPath,
    projectId,
    repositoryRole: "second",
    activeManifestDigest: project.value.activeManifestDigest,
    identity: "github:acme/second",
  });
  if (!first.allowed || !second.allowed) throw new Error("could not register both repositories");
  bindCeo(harness);

  const contract: TaskContract = {
    goal: "make both repositories return 2",
    why: "ordered release",
    scope: ["src/app.js"],
    nonGoals: [],
    acceptance: ["verify succeeds"],
    priority: "NORMAL",
    humanGate: [],
    references: [],
  };
  const created = harness.cp.runs.create({
    projectId,
    executionMode: ExecutionMode.STANDARD,
    contract,
    repositories: [
      { repositoryId: first.value.repositoryId, repositoryRole: "first", baseBranch: "dev", mergeOrder: 0 },
      { repositoryId: second.value.repositoryId, repositoryRole: "second", baseBranch: "dev", mergeOrder: 1 },
    ],
  });
  if (!created.allowed) throw new Error(created.message);
  const dispatched = await harness.cp.runs.dispatch(created.value.runId);
  if (!dispatched.allowed) throw new Error(dispatched.message);
  const task = harness.cp.tasks.submit(created.value.runId, [{ key: "implement", title: "implement", category: "implementation" }]);
  if (!task.allowed) throw new Error(task.message);
  const worker = bindWorker(harness, task.value[0]!.taskId);
  const execution = harness.cp.tasks.startExecution({
    runId: created.value.runId,
    taskId: task.value[0]!.taskId,
    ownerBindingGeneration: dispatched.value.ownerBindingGeneration!,
    workerSessionId: worker,
    provider: "scripted",
    model: "scripted-worker",
    repositoryId: first.value.repositoryId,
  });
  if (!execution.allowed) throw new Error(execution.message);
  const firstBranch = "feature/F1-first";
  const secondBranch = "feature/F1-second";
  for (const [path, branch] of [[harness.repoPath, firstBranch], [secondPath, secondBranch]] as const) {
    gitSync(path, ["checkout", "-q", "-b", branch]);
    writeFiles(path, { "src/app.js": "module.exports = () => 2;\n" });
    commitAll(path, `change ${branch}`);
  }
  harness.cp.tasks.finishExecution(execution.value.executionId, { status: "SUCCEEDED", resultDigest: "sha256:done" });

  const frozen = await harness.cp.pipeline.freeze(created.value.runId);
  if (!frozen.allowed) throw new Error(frozen.message);
  const verified = await harness.cp.verification.verify({
    runId: created.value.runId,
    snapshot: frozen.value,
    commands: manifest.verificationCommands,
    contractDigest: dispatched.value.contractDigest,
  });
  if (!verified.allowed) throw new Error(verified.message);
  harness.scripted.script({
    match: /Candidate review/,
    text: reviewerPass(["github:acme/first:src/app.js", "github:acme/second:src/app.js"]),
  });
  const reviewed = await harness.cp.review.controlPlaneInvoker()({
    runId: created.value.runId,
    projectId,
    executionMode: dispatched.value.executionMode,
    snapshot: frozen.value,
    contract,
    contractDigest: dispatched.value.contractDigest,
    verification: verified.value,
  });
  if (!reviewed.allowed) throw new Error(reviewed.message);

  const snapshotDigest = harness.cp.runs.currentCandidate(created.value.runId)!;
  const records = harness.cp.runs.repositoriesOf(created.value.runId);
  const byIdentity = new Map(frozen.value.repositories.map((repository) => [repository.identity, repository]));
  firstGitHub.setBranch("dev", byIdentity.get("github:acme/first")!.baseHead);
  firstGitHub.setBranch("main", "m".repeat(40));
  firstGitHub.setBranch(firstBranch, byIdentity.get("github:acme/first")!.candidateHead);
  secondGitHub.setBranch("dev", byIdentity.get("github:acme/second")!.baseHead);
  secondGitHub.setBranch("main", "m".repeat(40));
  secondGitHub.setBranch(secondBranch, byIdentity.get("github:acme/second")!.candidateHead);
  firstGitHub.nextMergeSha = byIdentity.get("github:acme/first")!.candidateHead;
  secondGitHub.nextMergeSha = byIdentity.get("github:acme/second")!.candidateHead;
  const order: string[] = [];
  firstGitHub.onMerge = ({ mergeSha }) => {
    order.push("first-merge");
    firstGitHub.setTrustedPostMergeCheck(mergeSha, "project-ci", WORKFLOW_PATH);
  };
  secondGitHub.onMerge = ({ mergeSha }) => {
    order.push("second-merge");
    secondGitHub.setTrustedPostMergeCheck(mergeSha, "project-ci", WORKFLOW_PATH);
  };
  const firstRequest = firstGitHub.request.bind(firstGitHub);
  firstGitHub.request = async <T>(method: HttpMethod, path: string, body?: unknown) => {
    const response = await firstRequest<T>(method, path, body);
    if (
      firstGitHub.mergeCount > 0 &&
      method === "GET" &&
      path.includes(`/commits/${byIdentity.get("github:acme/first")!.candidateHead}/check-runs`) &&
      path.includes("check_name=project-ci") &&
      !order.includes("first-post-merge-pass")
    ) {
      order.push("first-post-merge-pass");
    }
    return response;
  };
  for (const repository of records) {
    const branch = repository.identity === "github:acme/first" ? firstBranch : secondBranch;
    const claimed = harness.cp.claims.acquire({
      runId: created.value.runId,
      ownerSessionId: dispatched.value.ownerSessionId!,
      ownerBindingGeneration: dispatched.value.ownerBindingGeneration!,
      ownerRoleKey: harness.cp.runs.require(created.value.runId).ownerRoleKey!,
      repositoryIdentity: repository.identity,
      branch,
    });
    if (!claimed.allowed) throw new Error(claimed.message);
  }
  await harness.cp.continuity.evaluate("two repository finalizer");
  const packet = harness.cp.ceo.buildPacket({
    runId: created.value.runId,
    candidateSnapshotDigest: snapshotDigest,
    approval: {
      runId: created.value.runId,
      candidateSnapshotDigest: snapshotDigest,
      resultSummary: "both candidates verified",
      recommendation: "merge in order",
      residualRisk: [],
      approvedBySessionId: dispatched.value.ownerSessionId!,
      approvedByGeneration: dispatched.value.ownerBindingGeneration!,
      approvedAt: harness.clock.nowIso(),
    },
  });
  if (!packet.allowed) throw new Error(packet.message);
  const ceo = harness.cp.bindings.active(roleKeyFor(Role.CEO))!;
  const confirmed = harness.cp.ceo.submitCeoDecision({
    runId: created.value.runId,
    decision: "CONFIRM",
    candidateSnapshotDigest: snapshotDigest,
    ceoSessionId: ceo.sessionId,
    rationale: "both candidate snapshots are exact",
  });
  if (!confirmed.allowed) throw new Error(confirmed.message);
  return { harness, firstGitHub, secondGitHub, runId: created.value.runId, order };
};

describe("daemon-owned approved-run finalization", () => {
  it("completes a no-participation run through the daemon with explicit nothing-to-merge evidence", async () => {
    const harness = makeHarness();
    const { projectId } = await registerFixtureProject(harness, "empty-finalizer-project");
    const finalized = await finalizeNoRepositoryRun(harness, projectId, {
      goal: "record an administrative contract change",
      why: "there are no participating repositories",
      scope: [],
      nonGoals: [],
      acceptance: ["the administrative decision is durable"],
      priority: "NORMAL",
      humanGate: [],
      references: [],
    });

    expect(harness.cp.runs.require(finalized.runId).state).toBe(RunState.COMPLETED);
    const completed = harness.cp.audit.byKind("FINALIZATION_COMPLETED")
      .find((entry) => entry.runId === finalized.runId);
    expect(completed?.evidence).toMatchObject({
      candidateSnapshotDigest: finalized.candidateSnapshotDigest,
      finalization: "NO_PARTICIPATING_REPOSITORIES",
      nothingToMerge: true,
      predicate: "no participating repositories",
      repositoryCount: 0,
    });
    const packet = harness.cp.artifacts.latestForSnapshot<Record<string, unknown>>(
      finalized.runId,
      "PRODUCTION_READY_PACKET",
      finalized.candidateSnapshotDigest,
    );
    expect(packet?.content).toMatchObject({
      verification: { status: "PASS", expectedInputs: 0, observedInputs: 0 },
      blindReview: { verdict: "PASS", provider: "not-applicable", model: "not-applicable" },
      changedRepositories: [],
    });
  });

  it("refuses merge execution before CEO CONFIRM and direct execution after it", async () => {
    const { github, harness, driven } = await approvedFixture({ confirm: false });
    const mergeInput = {
      runId: driven.runId,
      repositoryIdentity: driven.identity,
      pullNumber: 1,
      exactHeadSha: driven.candidateHead,
      expectedBaseSha: driven.baseHead,
      mergeStrategy: "merge_commit" as const,
      ownerSessionId: driven.ownerSessionId,
      ownerBindingGeneration: driven.ownerBindingGeneration,
    };
    const beforeConfirmation = await harness.cp.github.mergeExecute(mergeInput);
    expect(beforeConfirmation.reasonCode).toBe(ReasonCode.WRITE_RUN_NOT_ACTIVE);
    expect(github.mergeCount).toBe(0);

    const ceo = harness.cp.bindings.active(roleKeyFor(Role.CEO))!;
    const confirmed = harness.cp.ceo.submitCeoDecision({
      runId: driven.runId,
      decision: "CONFIRM",
      candidateSnapshotDigest: driven.candidateSnapshotDigest,
      ceoSessionId: ceo.sessionId,
      rationale: "real CEO confirmation is required before daemon finalization",
    });
    expect(confirmed.allowed).toBe(true);
    const directAfterConfirmation = await harness.cp.github.mergeExecute(mergeInput);
    expect(directAfterConfirmation.reasonCode).toBe(ReasonCode.MERGE_AUTHORITY_DENIED);
    expect(github.mergeCount).toBe(0);
  });

  it("does not treat a bare state transition as a durable CEO confirmation", async () => {
    const { github, harness, driven } = await approvedFixture({ confirm: false });
    const synthetic = harness.cp.runs.transition(
      driven.runId,
      RunState.CEO_APPROVED,
      "synthetic fixture state without a CEO decision",
      { candidateSnapshotDigest: driven.candidateSnapshotDigest },
    );
    expect(synthetic.allowed).toBe(true);
    const daemon = new Daemon(harness.cp, { stateDir: tempDir("acp-finalizer-ceo-proof-") });
    const started = await daemon.start();
    expect(started.allowed).toBe(true);
    expect(harness.cp.runs.require(driven.runId).state).toBe(RunState.CEO_APPROVED);
    expect(github.mergeCount).toBe(0);
    await daemon.stop();
  });

  it("finalizes one repository through the production daemon entry point and replays with zero external writes", async () => {
    const { github, harness, driven } = await approvedFixture();
    const daemon = new Daemon(harness.cp, { stateDir: tempDir("acp-finalizer-daemon-") });
    const started = await daemon.start();
    expect(started.allowed).toBe(true);
    if (!started.allowed) return;

    expect(started.value.resumedFinalizations).toContain(driven.runId);
    expect(harness.cp.runs.require(driven.runId).state).toBe(RunState.COMPLETED);
    expect(github.pulls).toHaveLength(1);
    expect(github.checkRuns.filter((check) => check.name === "acp-production-gate")).toHaveLength(1);
    expect(github.mergeCount).toBe(1);
    expect(
      harness.cp.db.get<{ state: string; last_step: string }>(
        `SELECT state, last_step FROM finalization_attempts WHERE run_id = ?`,
        [driven.runId],
      ),
    ).toEqual({ state: "COMPLETED", last_step: "COMPLETED" });

    const beforeReplay = {
      pulls: github.pulls.length,
      gates: github.checkRuns.filter((check) => check.name === "acp-production-gate").length,
      merges: github.mergeCount,
    };
    const replay = await daemon.finalizeApprovedRun(driven.runId);
    expect(replay.allowed).toBe(true);
    expect(replay.reasonCode).toBe("MERGE_IDEMPOTENT_REPLAY");
    expect({
      pulls: github.pulls.length,
      gates: github.checkRuns.filter((check) => check.name === "acp-production-gate").length,
      merges: github.mergeCount,
    }).toEqual(beforeReplay);
    await daemon.stop();
  });

  it("returns completed gate, merge and tag receipts without issuing another GitHub write", async () => {
    const fixture = await approvedFixture();
    const { github, harness, driven } = fixture;
    const daemon = new Daemon(harness.cp, { stateDir: tempDir("acp-finalizer-completed-replay-") });
    const started = await daemon.start();
    expect(started.allowed).toBe(true);
    if (!started.allowed) return;
    expect(harness.cp.runs.require(driven.runId).state).toBe(RunState.COMPLETED);

    const releaseCommit = "r".repeat(40);
    recordExistingReleaseTag(fixture, releaseCommit);
    const before = {
      pulls: github.calls.filter((call) => call.method === "POST" && call.path.endsWith("/pulls")).length,
      gates: github.calls.filter((call) => call.method === "POST" && call.path.endsWith("/check-runs")).length,
      merges: github.calls.filter((call) => call.method === "PUT" && call.path.endsWith("/merge")).length,
      tags: github.calls.filter((call) => call.method === "POST" && call.path.endsWith("/git/refs")).length,
    };

    const gate = await harness.cp.github.gatePublish(gatePayloadFor(fixture), driven.identity);
    expect(gate.reasonCode).toBe(ReasonCode.MERGE_IDEMPOTENT_REPLAY);
    const pull = github.pulls[0]!;
    const merge = await harness.cp.github.mergeExecute({
      runId: driven.runId,
      repositoryIdentity: driven.identity,
      pullNumber: pull.number,
      exactHeadSha: driven.candidateHead,
      expectedBaseSha: driven.baseHead,
      mergeStrategy: "merge_commit",
      ownerSessionId: driven.ownerSessionId,
      ownerBindingGeneration: driven.ownerBindingGeneration,
    });
    expect(merge.reasonCode).toBe(ReasonCode.MERGE_IDEMPOTENT_REPLAY);
    const tag = await harness.cp.github.releaseTag(
      driven.runId,
      driven.identity,
      "1.2.3",
      releaseCommit,
      {
        ownerSessionId: driven.ownerSessionId,
        ownerBindingGeneration: driven.ownerBindingGeneration,
      },
    );
    expect(tag.reasonCode).toBe(ReasonCode.MERGE_IDEMPOTENT_REPLAY);
    expect({
      pulls: github.calls.filter((call) => call.method === "POST" && call.path.endsWith("/pulls")).length,
      gates: github.calls.filter((call) => call.method === "POST" && call.path.endsWith("/check-runs")).length,
      merges: github.calls.filter((call) => call.method === "PUT" && call.path.endsWith("/merge")).length,
      tags: github.calls.filter((call) => call.method === "POST" && call.path.endsWith("/git/refs")).length,
    }).toEqual(before);
    await daemon.stop();
  });

  it("blocks a partial merge with a durable compensation plan instead of releasing another write", async () => {
    const { github, harness, driven } = await approvedFixture();
    github.onMerge = ({ mergeSha }) => github.setPostMergeCheck(mergeSha, "project-ci", "failure");
    const daemon = new Daemon(harness.cp, { stateDir: tempDir("acp-finalizer-compensation-") });
    const started = await daemon.start();
    expect(started.allowed).toBe(true);
    if (!started.allowed) return;

    expect(harness.cp.runs.require(driven.runId).state).toBe(RunState.BLOCKED_POST_MERGE);
    const attempt = harness.cp.db.get<{ state: string; failure_reason: string; compensation_plan_json: string }>(
      `SELECT state, failure_reason, compensation_plan_json FROM finalization_attempts WHERE run_id = ?`,
      [driven.runId],
    );
    expect(attempt?.state).toBe("BLOCKED");
    expect(attempt?.failure_reason).toBe(ReasonCode.POST_MERGE_VERIFICATION_FAILED);
    expect(JSON.parse(attempt!.compensation_plan_json)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        repositoryIdentity: driven.identity,
        requiredAction: "halt and review rollback plan",
      }),
    ]));
    const beforeRetry = github.mergeCount;
    const blocked = await daemon.finalizeApprovedRun(driven.runId);
    expect(blocked.reasonCode).toBe(ReasonCode.FINALIZATION_COMPENSATION_REQUIRED);
    expect(github.mergeCount).toBe(beforeRetry);
    await daemon.stop();
  });

  it("prepares both repositories but releases the second merge only after the first exact post-merge PASS", async () => {
    const { harness, firstGitHub, secondGitHub, runId, order } = await twoRepositoryApprovedFixture();
    const daemon = new Daemon(harness.cp, { stateDir: tempDir("acp-finalizer-two-") });
    const started = await daemon.start();
    expect(started.allowed).toBe(true);
    if (!started.allowed) return;

    expect(harness.cp.runs.require(runId).state).toBe(RunState.COMPLETED);
    expect(firstGitHub.mergeCount).toBe(1);
    expect(secondGitHub.mergeCount).toBe(1);
    expect(order.indexOf("first-merge")).toBeLessThan(order.indexOf("first-post-merge-pass"));
    expect(order.indexOf("first-post-merge-pass")).toBeLessThan(order.indexOf("second-merge"));
    await daemon.stop();
  });

  it("reclaims a crashed finalization lease and reconciles its PENDING gate receipt without a duplicate check", async () => {
    const { github, harness, driven } = await approvedFixture();
    const payload = gatePayloadFor({ github, harness, driven });
    const payloadDigest = digestOf(payload);
    // Model a process death after GitHub accepted the POST but before its local reread could
    // complete the PENDING→APPLIED receipt. The new daemon must reread this exact check.
    github.checkRuns.push({
      id: 771,
      name: "acp-production-gate",
      head_sha: driven.candidateHead,
      conclusion: "success",
      status: "completed",
      app: { slug: "acp-trusted-app" },
      output: { title: "gate", summary: `payloadDigest=${payloadDigest}` },
      completed_at: harness.clock.nowIso(),
    });
    harness.cp.db.run(
      `INSERT INTO github_receipts
         (receipt_id, idempotency_key, operation, run_id, repository_identity, resource_type,
          resource_identity, preexisting, before_state_digest, after_state_digest, request_digest,
          response_json, created_at, reread_at, verified, status)
       VALUES (?, ?, 'gate_publish', ?, ?, 'check_run', ?, 0, NULL, NULL, ?, '{"pending":true}', ?, NULL, 0, 'PENDING')`,
      [
        "receipt_crashed_gate",
        `gate_publish:${driven.identity}:${driven.candidateHead}:${payloadDigest}`,
        driven.runId,
        driven.identity,
        `acme/fixture@${driven.candidateHead}/acp-production-gate`,
        payloadDigest,
        harness.clock.nowIso(),
      ],
    );
    const staleAt = new Date(harness.clock.now().getTime() - 31 * 60_000).toISOString();
    const deadlineAt = new Date(harness.clock.now().getTime() - 60_000).toISOString();
    harness.cp.db.run(
      `INSERT INTO finalization_attempts
         (run_id, attempt_id, lease_owner, candidate_digest, state, started_at, deadline_at, last_step)
       VALUES (?, 'finalize_crashed', 'dead-daemon', ?, 'RUNNING', ?, ?, 'PUBLISH_GATE')`,
      [driven.runId, driven.candidateSnapshotDigest, staleAt, deadlineAt],
    );

    const daemon = new Daemon(harness.cp, { stateDir: tempDir("acp-finalizer-recovery-") });
    const started = await daemon.start();
    expect(started.allowed).toBe(true);
    if (!started.allowed) return;
    expect(started.value.reclaimedFinalizationAttempts).toContainEqual(expect.objectContaining({
      runId: driven.runId,
      attemptId: "finalize_crashed",
    }));
    expect(harness.cp.runs.require(driven.runId).state).toBe(RunState.COMPLETED);
    expect(github.checkRuns.filter((check) => check.name === "acp-production-gate")).toHaveLength(1);
    expect(github.calls.filter((call) => call.method === "POST" && call.path.endsWith("/check-runs"))).toHaveLength(0);
    expect(harness.cp.db.get<{ status: string; verified: number }>(
      `SELECT status, verified FROM github_receipts WHERE receipt_id = 'receipt_crashed_gate'`,
    )).toEqual({ status: "APPLIED", verified: 1 });
    await daemon.stop();
  });
});
