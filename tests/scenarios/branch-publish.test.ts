import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { sha256 } from "../../src/core/digest.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import type { ProjectManifest } from "../../src/contracts/manifest.ts";
import { parseVerificationCommand } from "../../src/contracts/verification-command.ts";
import { ApprovedRunFinalizer } from "../../src/daemon/finalizer.ts";
import { RunState } from "../../src/domain/types.ts";
import {
  type ConfirmedMergePlan,
  type ConfirmedMergePorts,
  deriveConfirmedMergePlan,
} from "../../src/github/confirmed-merge-operation.ts";
import type { BranchPublishLimits } from "../../src/git/branch-objects.ts";
import { NO_HUMAN_GATE_DIGEST, type GitHubClient } from "../../src/github/github-kernel.ts";
import type { CandidateSnapshot } from "../../src/snapshot/candidate-snapshot.ts";
import { FakeGitHub } from "../helpers/fake-github.ts";
import { cleanupTempDirs, commitAll, tempDir, writeFiles } from "../helpers/fixtures.ts";
import { GitDataGitHub, bareRemoteAt } from "../helpers/git-data-github.ts";
import {
  type Harness,
  approveReviewedCandidateForFinalization,
  driveToReviewedCandidate,
  makeHarness,
  startWorkBranch,
} from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * #512 S-PUSH (CEO f5879479, 3d0daed0) — `GitHubKernel.publishBranch` delivers a STANDARD_WORK candidate's
 * branch through the Git Data API, before the PR is prepared. The remote is an in-process double over a real
 * bare repository (`GitDataGitHub`); nothing here reaches the network. The PR, gate and merge endpoints are
 * the existing `FakeGitHub`.
 */

const WORK_BRANCH = "feature/F1-publish";
const WORKFLOW_PATH = ".github/workflows/ci.yml";
const WORKFLOW = "name: project-ci\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: node verify.js\n";
const GIT_DATA = /\/git\/(?:blobs|trees|commits|refs)$|\/git\/ref\/heads\/|\/branches\?/;
type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

interface Fixture {
  harness: Harness;
  github: FakeGitHub;
  gitData: GitDataGitHub;
  driven: Awaited<ReturnType<typeof driveToReviewedCandidate>>;
  ports: ConfirmedMergePorts;
  plan: () => ConfirmedMergePlan;
  /** Every request the router saw, in order, whichever double answered it. */
  log: Array<{ method: HttpMethod; path: string; body?: unknown }>;
}

const setup = async (options: {
  finalization?: boolean;
  manifestOverrides?: Partial<ProjectManifest>;
  limits?: Partial<BranchPublishLimits>;
  /** Commits made on the work branch before the passing change, so they belong to the candidate. */
  extraCandidateFiles?: Record<string, string>;
  trustedCi?: boolean;
  /** Runs on the work branch before the passing change, after the base workflow commit (#1161 r1). */
  beforeCandidate?: (harness: Harness) => Promise<void> | void;
  /** Candidate paths the scripted reviewer attests to beyond src/app.js and `extraCandidateFiles`. */
  reviewedPaths?: readonly string[];
} = {}): Promise<Fixture> => {
  const github = new FakeGitHub();
  const log: Fixture["log"] = [];
  const holder: { gitData: GitDataGitHub | null } = { gitData: null };
  const router: GitHubClient = {
    request: async <T>(method: HttpMethod, path: string, body?: unknown, requestOptions?: Parameters<GitHubClient["request"]>[3]) => {
      log.push({ method, path, ...(body === undefined ? {} : { body }) });
      if (holder.gitData && GIT_DATA.test(path)) return holder.gitData.request<T>(method, path, body, requestOptions);
      // The PR endpoints read the work branch from GitHub's refs: mirror the remote's head into the PR double.
      const head = holder.gitData?.head(WORK_BRANCH);
      if (head) github.setBranch(WORK_BRANCH, head);
      return github.request<T>(method, path, body);
    },
  };
  const harness = makeHarness({
    githubClient: router,
    ...(options.limits ? { githubKernelOptions: { branchPublishLimits: options.limits } } : {}),
  });
  harness.cp.credentials.install({ token: "test-token", creatorIdentity: "acp-trusted-app" });
  if (options.trustedCi) {
    harness.cp.verification.attachCi({
      fetch: async (repositoryIdentity, head) => [{
        commandId: "project-ci",
        repositoryIdentity,
        head,
        conclusion: "success" as const,
        workflowDigest: "sha256:approved",
        creatorIdentity: "github-actions",
        completedAt: "2026-08-12T00:00:00.000Z",
        nonVacuous: true,
      }],
      approvedWorkflowDigests: async () => ["sha256:approved"],
      trustedCreators: async () => ["github-actions"],
    });
  }
  // The project's own CI workflow is on the base, so the candidate does not change it.
  writeFiles(harness.repoPath, { [WORKFLOW_PATH]: WORKFLOW });
  commitAll(harness.repoPath, "add trusted project CI workflow");
  if (options.extraCandidateFiles) {
    startWorkBranch(harness.repoPath, WORK_BRANCH);
    writeFiles(harness.repoPath, options.extraCandidateFiles);
    commitAll(harness.repoPath, "an extra candidate change");
  }
  if (options.beforeCandidate) {
    startWorkBranch(harness.repoPath, WORK_BRANCH);
    await options.beforeCandidate(harness);
  }
  const driven = await driveToReviewedCandidate(harness, {
    workBranch: WORK_BRANCH,
    reviewedPaths: ["src/app.js", ...Object.keys(options.extraCandidateFiles ?? {}), ...(options.reviewedPaths ?? [])],
    manifestOverrides: {
      ciWorkflows: [{ path: WORKFLOW_PATH, checkName: "project-ci", approvedDigest: sha256(WORKFLOW), unapprovedFirstActivation: false, repositoryRole: "primary" }],
      ...options.manifestOverrides,
    },
  });
  holder.gitData = new GitDataGitHub(bareRemoteAt(join(tempDir("acp-bp-remote-"), "remote.git"), harness.repoPath, "dev", driven.baseHead));
  const gitData = holder.gitData;
  github.setBranch("dev", driven.baseHead);
  github.setBranch("main", "m".repeat(40));
  github.nextMergeSha = driven.candidateHead;
  github.onMerge = ({ mergeSha, pull }) => {
    github.setTrustedPostMergeCheck(mergeSha, "project-ci", WORKFLOW_PATH);
    // GitHub's base ref moves to the merge commit; the remote double holds it once the branch is published.
    gitData.setHead(pull.base.ref, mergeSha);
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
  if (options.finalization !== false) await approveReviewedCandidateForFinalization(harness, driven);

  const ports: ConfirmedMergePorts = {
    github: harness.cp.github,
    runs: harness.cp.runs,
    artifacts: harness.cp.artifacts,
    projects: harness.cp.projects,
    clock: harness.cp.clock,
    daemonFinalizerAuthority: harness.cp.daemonFinalizationAuthorities().write,
  };
  const plan = (): ConfirmedMergePlan => {
    const snapshot = harness.cp.artifacts.latestForSnapshot<CandidateSnapshot>(
      driven.runId,
      "CANDIDATE_SNAPSHOT",
      driven.candidateSnapshotDigest,
    )!.content.repositories.find((repository) => repository.identity === driven.identity)!;
    const derived = deriveConfirmedMergePlan(ports, {
      runId: driven.runId,
      repositoryIdentity: driven.identity,
      head: driven.workBranch,
      title: `ACP finalization: ${harness.cp.runs.require(driven.runId).goal}`,
      body: `Automated daemon finalization for run ${driven.runId}.`,
      declaredParent: snapshot.sourceBranch ?? null,
      humanGateDigest: NO_HUMAN_GATE_DIGEST,
    });
    if (!derived.allowed) throw new Error(`${derived.reasonCode}: ${derived.message}`);
    return derived.value;
  };
  return { harness, github, gitData, driven, ports, plan, log };
};

const receiptsOf = (fixture: Fixture) =>
  fixture.harness.cp.db.all<{ idempotency_key: string; status: string; verified: number; preexisting: number; request_digest: string; response_json: string }>(
    `SELECT idempotency_key, status, verified, preexisting, request_digest, response_json FROM github_receipts WHERE operation = 'branch_publish' ORDER BY rowid`,
  );

const keyOf = (fixture: Fixture): string =>
  `branch_publish:${fixture.driven.identity}:${fixture.driven.workBranch}:${fixture.driven.candidateHead}`;

/** No force and no rewrite: a publication never PATCHes or DELETEs a ref and never POSTs any ref but its own. */
const expectCreateOnly = (fixture: Fixture): void => {
  expect(fixture.log.filter((call) => call.method === "PATCH" || call.method === "DELETE")).toEqual([]);
  for (const call of fixture.gitData.posts("refs")) {
    expect(call.body).toEqual({ ref: `refs/heads/${fixture.driven.workBranch}`, sha: fixture.driven.candidateHead });
  }
};

/** A commit the remote holds on top of `parent`, as another writer would make it. */
const remoteCommitOn = (fixture: Fixture, parent: string): string => {
  const tree = execFileSync("git", ["-C", fixture.gitData.remote, "rev-parse", `${parent}^{tree}`], { encoding: "utf8", timeout: 30_000 }).trim();
  return execFileSync("git", ["-C", fixture.gitData.remote, "commit-tree", tree, "-p", parent, "-m", "someone else"], {
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, GIT_AUTHOR_NAME: "x", GIT_AUTHOR_EMAIL: "x@example.invalid", GIT_COMMITTER_NAME: "x", GIT_COMMITTER_EMAIL: "x@example.invalid" },
  }).trim();
};

describe("S-PUSH: the finalizer publishes the branch before it prepares the PR", () => {
  it("PUBLISH_BRANCH runs before PREPARE_PR; every object and the ref go out before the PR POST; the run completes and a replay sends nothing", async () => {
    const fixture = await setup();
    const { harness, gitData, driven } = fixture;
    expect(gitData.head(WORK_BRANCH)).toBeNull();
    const finalizer = new ApprovedRunFinalizer(harness.cp);
    const done = await finalizer.finalizeApprovedRun(driven.runId);
    expect(done.allowed, JSON.stringify(done)).toBe(true);
    expect(harness.cp.runs.require(driven.runId).state).toBe(RunState.COMPLETED);
    expect(gitData.head(WORK_BRANCH)).toBe(driven.candidateHead);

    const firstPr = fixture.log.findIndex((call) => call.method === "POST" && /\/pulls$/.test(call.path));
    const lastPublish = fixture.log.map((call) => call.method === "POST" && GIT_DATA.test(call.path)).lastIndexOf(true);
    expect(firstPr).toBeGreaterThan(-1);
    expect(gitData.objectUploads().length).toBeGreaterThan(0);
    expect(gitData.posts("refs")).toHaveLength(1);
    expect(lastPublish).toBeLessThan(firstPr);
    expect(harness.cp.audit.byKind("BRANCH_PUBLISHED").map((row) => (row.evidence as { how?: string }).how)).toEqual(["CREATED"]);

    const receipts = receiptsOf(fixture);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ idempotency_key: keyOf(fixture), status: "APPLIED", verified: 1, preexisting: 0 });
    expect(JSON.parse(receipts[0]!.response_json)).toMatchObject({ ref: `refs/heads/${WORK_BRANCH}`, sha: driven.candidateHead, sent: true });
    expectCreateOnly(fixture);

    const sentBefore = fixture.log.filter((call) => call.method === "POST" && GIT_DATA.test(call.path)).length;
    const replay = await finalizer.finalizeApprovedRun(driven.runId);
    expect(replay.allowed).toBe(true);
    expect(fixture.log.filter((call) => call.method === "POST" && GIT_DATA.test(call.path)).length).toBe(sentBefore);
    expect(receiptsOf(fixture)).toHaveLength(1);
  });
});

describe("S-PUSH: publishBranch", () => {
  it("scans, uploads, checks every id, creates the ref, reads it back, then records APPLIED under the reconciliation key; a retry sends nothing", async () => {
    const fixture = await setup();
    const { harness, gitData, driven } = fixture;
    const published = await harness.cp.github.publishBranch(fixture.plan().publish);
    expect(published.allowed, JSON.stringify(published)).toBe(true);
    if (!published.allowed) return;
    expect(published.value).toMatchObject({ ref: `refs/heads/${WORK_BRANCH}`, sha: driven.candidateHead, sent: true });
    expect(gitData.head(WORK_BRANCH)).toBe(driven.candidateHead);
    // Order: blobs, then trees, then commits, then the one ref, then its readback.
    const kinds = gitData.calls.filter((call) => call.method === "POST").map((call) => /\/git\/(\w+)$/.exec(call.path)![1]);
    expect(kinds.at(-1)).toBe("refs");
    expect(kinds.indexOf("trees")).toBeGreaterThan(kinds.lastIndexOf("blobs"));
    expect(kinds.indexOf("commits")).toBeGreaterThan(kinds.lastIndexOf("trees"));
    const refPost = gitData.calls.findIndex((call) => call.method === "POST" && call.path.endsWith("/git/refs"));
    expect(gitData.calls.slice(refPost + 1).some((call) => call.method === "GET" && call.path.endsWith(`/git/ref/heads/${WORK_BRANCH}`))).toBe(true);
    const receipts = receiptsOf(fixture);
    expect(receipts).toEqual([expect.objectContaining({ idempotency_key: keyOf(fixture), status: "APPLIED", verified: 1, preexisting: 0 })]);
    expect(JSON.parse(receipts[0]!.response_json).scanDigest).toBe(published.value.scanDigest);
    expect(JSON.parse(receipts[0]!.response_json).request).toEqual({
      runId: driven.runId,
      candidateSnapshotDigest: driven.candidateSnapshotDigest,
      baseHead: driven.baseHead,
      scanDigest: published.value.scanDigest,
    });

    const posts = gitData.calls.filter((call) => call.method === "POST").length;
    const again = await harness.cp.github.publishBranch(fixture.plan().publish);
    expect(again.allowed).toBe(true);
    expect(again.reasonCode).toBe(ReasonCode.MERGE_IDEMPOTENT_REPLAY);
    expect(gitData.calls.filter((call) => call.method === "POST").length).toBe(posts);
    expect(receiptsOf(fixture)).toHaveLength(1);
    expectCreateOnly(fixture);
  });

  it("a branch already at the exact candidate before anything is sent is recorded as an observation, with no upload", async () => {
    const second = await setup();
    // The same commit delivered by anyone else: the remote fetches the work branch from the local checkout.
    execFileSync("git", ["-C", second.gitData.remote, "fetch", "--quiet", second.harness.repoPath, `refs/heads/${WORK_BRANCH}:refs/heads/${WORK_BRANCH}`], { stdio: "ignore", timeout: 30_000 });
    expect(second.gitData.head(WORK_BRANCH)).toBe(second.driven.candidateHead);
    const observed = await second.harness.cp.github.publishBranch(second.plan().publish);
    expect(observed.allowed, JSON.stringify(observed)).toBe(true);
    expect(observed.allowed && observed.value.sent).toBe(false);
    expect(second.gitData.objectUploads()).toEqual([]);
    expect(second.gitData.posts("refs")).toEqual([]);
    expect(receiptsOf(second)).toEqual([expect.objectContaining({ idempotency_key: keyOf(second), status: "APPLIED", verified: 1, preexisting: 1 })]);
  });

  it("refuses non-portable content in the candidate before the first upload: no request at all, no receipt", async () => {
    const token = `ghp_${"Zy9Xw8Vu7T".repeat(4)}`;
    const fixture = await setup({ extraCandidateFiles: { "notes.md": `deploy with ${token}\n` } });
    const refused = await fixture.harness.cp.github.publishBranch(fixture.plan().publish);
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.BRANCH_PUBLISH_CONTENT_REFUSED);
    expect(JSON.stringify(refused.evidence)).not.toContain(token);
    expect(fixture.gitData.calls).toEqual([]);
    expect(receiptsOf(fixture)).toEqual([]);
  });

  it("refuses a session URL in the pull request text that would follow, before the first upload", async () => {
    const fixture = await setup();
    const plan = fixture.plan();
    const refused = await fixture.harness.cp.github.publishBranch({
      ...plan.publish,
      pullRequest: { ...plan.publish.pullRequest, body: "from https://claude.ai/code/session_0123456789abcdef" },
    });
    expect(refused.reasonCode).toBe(ReasonCode.BRANCH_PUBLISH_CONTENT_REFUSED);
    expect(fixture.gitData.calls).toEqual([]);
  });

  it("refuses a candidate past a cap before the first upload", async () => {
    const fixture = await setup({ limits: { maxObjectBytes: 4 } });
    const refused = await fixture.harness.cp.github.publishBranch(fixture.plan().publish);
    expect(refused.reasonCode).toBe(ReasonCode.BRANCH_PUBLISH_LIMIT_EXCEEDED);
    expect(fixture.gitData.calls).toEqual([]);
    expect(receiptsOf(fixture)).toEqual([]);
  });

  it("a commit id GitHub answers that is not the local one (D1): no ref is written and nothing is APPLIED", async () => {
    const fixture = await setup();
    fixture.gitData.intercepts.push((call) => call.method === "POST" && call.path.endsWith("/git/commits")
      ? { answer: { sha: "f".repeat(40), tree: { sha: (call.body as { tree: string }).tree } } }
      : undefined);
    const refused = await fixture.harness.cp.github.publishBranch(fixture.plan().publish);
    expect(refused.reasonCode).toBe(ReasonCode.BRANCH_PUBLISH_OBJECT_MISMATCH);
    expect(fixture.gitData.posts("refs")).toEqual([]);
    expect(fixture.gitData.head(WORK_BRANCH)).toBeNull();
    expect(receiptsOf(fixture)).toEqual([expect.objectContaining({ status: "PENDING", verified: 0 })]);
  });

  it("a tree id that is not the local one refuses before any commit is sent", async () => {
    const fixture = await setup();
    fixture.gitData.intercepts.push((call) => call.method === "POST" && call.path.endsWith("/git/trees") ? { answer: { sha: "e".repeat(40) } } : undefined);
    const refused = await fixture.harness.cp.github.publishBranch(fixture.plan().publish);
    expect(refused.reasonCode).toBe(ReasonCode.BRANCH_PUBLISH_OBJECT_MISMATCH);
    expect(fixture.gitData.posts("commits")).toEqual([]);
    expect(fixture.gitData.posts("refs")).toEqual([]);
  });
});

describe("S-PUSH: reconciliation by branch_publish:<repo>:<branch>:<candidateHead>", () => {
  it("a lost answer to the ref create is APPLIED from the readback in the same call", async () => {
    const fixture = await setup();
    fixture.gitData.intercepts.push((call) => call.method === "POST" && call.path.endsWith("/git/refs") ? { applyThenSilence: true } : undefined);
    const published = await fixture.harness.cp.github.publishBranch(fixture.plan().publish);
    expect(published.allowed, JSON.stringify(published)).toBe(true);
    expect(fixture.gitData.posts("refs")).toHaveLength(1);
    expect(receiptsOf(fixture)).toEqual([expect.objectContaining({ status: "APPLIED", verified: 1 })]);
  });

  it("a PENDING publication whose ref is now at the candidate (an answer lost, or the same commit pushed by anyone) is APPLIED without a resend", async () => {
    const fixture = await setup();
    let silent = true;
    fixture.gitData.intercepts.push((call) => silent && call.method === "POST" && call.path.endsWith("/git/refs") ? { silence: true } : undefined);
    const first = await fixture.harness.cp.github.publishBranch(fixture.plan().publish);
    expect(first.allowed).toBe(false);
    expect(first.reasonCode).toBe(ReasonCode.PROBE_FAILED);
    expect(receiptsOf(fixture)).toEqual([expect.objectContaining({ status: "PENDING" })]);
    silent = false;
    fixture.gitData.setHead(WORK_BRANCH, fixture.driven.candidateHead);
    const posts = fixture.gitData.calls.filter((call) => call.method === "POST").length;
    const reconciled = await fixture.harness.cp.github.publishBranch(fixture.plan().publish);
    expect(reconciled.allowed, JSON.stringify(reconciled)).toBe(true);
    expect(reconciled.reasonCode).toBe(ReasonCode.MERGE_IDEMPOTENT_REPLAY);
    expect(fixture.gitData.calls.filter((call) => call.method === "POST").length).toBe(posts);
    expect(receiptsOf(fixture)).toEqual([expect.objectContaining({ idempotency_key: keyOf(fixture), status: "APPLIED", verified: 1 })]);
  });

  it("a PENDING publication whose ref is missing is sent again under the same reservation", async () => {
    const fixture = await setup();
    let silent = true;
    fixture.gitData.intercepts.push((call) => silent && call.method === "POST" && call.path.endsWith("/git/refs") ? { silence: true } : undefined);
    expect((await fixture.harness.cp.github.publishBranch(fixture.plan().publish)).allowed).toBe(false);
    const firstUploads = fixture.gitData.objectUploads().length;
    silent = false;
    const resent = await fixture.harness.cp.github.publishBranch(fixture.plan().publish);
    expect(resent.allowed, JSON.stringify(resent)).toBe(true);
    expect(fixture.gitData.objectUploads().length).toBe(firstUploads * 2);
    expect(fixture.gitData.posts("refs")).toHaveLength(2);
    expect(fixture.gitData.head(WORK_BRANCH)).toBe(fixture.driven.candidateHead);
    expect(receiptsOf(fixture)).toEqual([expect.objectContaining({ status: "APPLIED", verified: 1 })]);
  });

  it("a ref at another commit is RESOURCE_COLLISION, fresh or pending, and is never forced", async () => {
    const fresh = await setup();
    const other = remoteCommitOn(fresh, fresh.driven.baseHead);
    fresh.gitData.setHead(WORK_BRANCH, other);
    const collided = await fresh.harness.cp.github.publishBranch(fresh.plan().publish);
    expect(collided.reasonCode).toBe(ReasonCode.RESOURCE_COLLISION);
    expect(fresh.gitData.objectUploads()).toEqual([]);
    expect(fresh.gitData.head(WORK_BRANCH)).toBe(other);
    expectCreateOnly(fresh);

    const pending = await setup();
    let silent = true;
    pending.gitData.intercepts.push((call) => silent && call.method === "POST" && call.path.endsWith("/git/refs") ? { silence: true } : undefined);
    expect((await pending.harness.cp.github.publishBranch(pending.plan().publish)).allowed).toBe(false);
    silent = false;
    const another = remoteCommitOn(pending, pending.driven.baseHead);
    pending.gitData.setHead(WORK_BRANCH, another);
    const refused = await pending.harness.cp.github.publishBranch(pending.plan().publish);
    expect(refused.reasonCode).toBe(ReasonCode.RESOURCE_COLLISION);
    expect(pending.gitData.head(WORK_BRANCH)).toBe(another);
    expect(receiptsOf(pending)).toEqual([expect.objectContaining({ status: "PENDING" })]);
    expectCreateOnly(pending);
  });

  it("a 422 on the ref create takes the readback: at the candidate it is APPLIED", async () => {
    const fixture = await setup();
    fixture.gitData.intercepts.push((call) => {
      if (call.method !== "POST" || !call.path.endsWith("/git/refs")) return undefined;
      fixture.gitData.setHead(WORK_BRANCH, fixture.driven.candidateHead);
      return { status: 422 };
    });
    const published = await fixture.harness.cp.github.publishBranch(fixture.plan().publish);
    expect(published.allowed, JSON.stringify(published)).toBe(true);
    expect(receiptsOf(fixture)).toEqual([expect.objectContaining({ status: "APPLIED", verified: 1, preexisting: 0 })]);
  });
});

describe("S-PUSH: gates before anything is sent", () => {
  it("refuses a run that is not in finalization, and a caller without the daemon capability", async () => {
    const active = await setup({ finalization: false });
    const derived = deriveConfirmedMergePlan(active.ports, {
      runId: active.driven.runId,
      repositoryIdentity: active.driven.identity,
      head: active.driven.workBranch,
      title: "t",
    });
    expect(derived.allowed).toBe(false);
    const approved = await setup();
    const plan = approved.plan();
    // The same publication, offered while the run is still ACTIVE (taken from a CEO-approved twin).
    const notFinalizing = await active.harness.cp.github.publishBranch({
      ...plan.publish,
      runId: active.driven.runId,
      repositoryIdentity: active.driven.identity,
      exactHeadSha: active.driven.candidateHead,
      expectedBaseSha: active.driven.baseHead,
      candidateSnapshotDigest: active.driven.candidateSnapshotDigest,
      ownerSessionId: active.driven.ownerSessionId,
      ownerBindingGeneration: active.driven.ownerBindingGeneration,
      daemonFinalizerAuthority: active.harness.cp.daemonFinalizationAuthorities().write,
    });
    expect(notFinalizing.reasonCode).toBe(ReasonCode.WRITE_RUN_NOT_ACTIVE);
    expect(active.gitData.calls).toEqual([]);
    const { daemonFinalizerAuthority: _dropped, ...withoutAuthority } = plan.publish;
    const noAuthority = await approved.harness.cp.github.publishBranch(withoutAuthority);
    expect(noAuthority.reasonCode).toBe(ReasonCode.MERGE_AUTHORITY_DENIED);
    expect(approved.gitData.calls).toEqual([]);
    expect(receiptsOf(approved)).toEqual([]);
  });

  it("publishes without re-pinning the owner decision digest (D2)", async () => {
    const fixture = await setup();
    const refused = await fixture.harness.cp.github.publishBranch({ ...fixture.plan().publish, humanGateDigest: sha256("another binding") });
    expect(refused.allowed).toBe(true);
    expect(fixture.gitData.calls.length).toBeGreaterThan(0);
  });

  it("refuses a moved remote base: MERGE_BASE_STALE, no upload, no reservation", async () => {
    const fixture = await setup();
    fixture.gitData.setHead("dev", remoteCommitOn(fixture, fixture.driven.baseHead));
    const refused = await fixture.harness.cp.github.publishBranch(fixture.plan().publish);
    expect(refused.reasonCode).toBe(ReasonCode.MERGE_BASE_STALE);
    expect(fixture.gitData.objectUploads()).toEqual([]);
    expect(fixture.gitData.posts("refs")).toEqual([]);
    expect(receiptsOf(fixture)).toEqual([]);
  });

  it("never writes a long-lived, default or base branch", async () => {
    const fixture = await setup();
    for (const branch of ["dev", "main"]) {
      const refused = await fixture.harness.cp.github.publishBranch({ ...fixture.plan().publish, branch });
      expect(refused.allowed).toBe(false);
    }
    expect(fixture.gitData.calls.filter((call) => call.method === "POST")).toEqual([]);
    expect(fixture.gitData.head("dev")).toBe(fixture.driven.baseHead);
  });

  it("refuses a TRUSTED_CI contract in v1 (D3) before any upload", async () => {
    const fixture = await setup({
      trustedCi: true,
      manifestOverrides: {
        verificationProfiles: { simple: ["project-ci"], standard: ["project-ci"], guarded: ["project-ci"] },
        verificationCommands: [parseVerificationCommand({ id: "project-ci", argv: ["node", "verify.js"], repositoryRole: "primary", evidenceMode: "TRUSTED_CI", timeoutSeconds: 60 })],
      },
    });
    const refused = await fixture.harness.cp.github.publishBranch(fixture.plan().publish);
    expect(refused.reasonCode).toBe(ReasonCode.BRANCH_PUBLISH_UNSUPPORTED);
    expect(fixture.gitData.objectUploads()).toEqual([]);
    expect(receiptsOf(fixture)).toEqual([]);
  });

  it("refuses a change under .github/workflows (D5) before any upload", async () => {
    const fixture = await setup({ extraCandidateFiles: { ".github/workflows/extra.yml": "name: extra\non: [push]\njobs: {}\n" } });
    const refused = await fixture.harness.cp.github.publishBranch(fixture.plan().publish);
    expect(refused.reasonCode).toBe(ReasonCode.BRANCH_PUBLISH_UNSUPPORTED);
    expect(JSON.stringify(refused.evidence)).toContain(".github/workflows/extra.yml");
    expect(fixture.gitData.objectUploads()).toEqual([]);
    expect(receiptsOf(fixture)).toEqual([]);
  });
});

/** A commit on the work branch with exactly these files, message and identity, before the passing change. */
const candidateCommit = (repo: string, files: Record<string, string | Buffer>, message: string, env: Record<string, string> = {}): void => {
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, file)), { recursive: true });
    writeFileSync(join(repo, file), content);
  }
  execFileSync("git", ["-C", repo, "add", "-A"], { stdio: "ignore", timeout: 30_000 });
  execFileSync("git", ["-C", repo, "commit", "-q", "--no-verify", "-m", message], {
    stdio: "ignore",
    timeout: 30_000,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "ACP Test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "ACP Test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
      GIT_CONFIG_NOSYSTEM: "1",
      ...env,
    },
  });
};

/** A second registered checkout under a Unicode path, so that path is one the scan must keep local. */
const registerUnicodeCheckout = async (harness: Harness): Promise<string> => {
  const dir = join(tempDir("acp-bp-uni-"), "팀", "checkouts", "other");
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "dev", dir], { stdio: "ignore", timeout: 30_000 });
  candidateCommit(dir, { "README.md": "other\n" }, "other base");
  const registered = await harness.cp.repositories.register({ checkoutPath: dir, identity: "github:acme/other" });
  if (!registered.allowed) throw new Error(`${registered.reasonCode}: ${registered.message}`);
  expect(registered.value.checkoutPath).toContain("팀");
  return registered.value.checkoutPath;
};

/** Refused before the first upload: no object, no ref, no receipt. */
const expectNothingSent = (fixture: Fixture): void => {
  expect(fixture.gitData.objectUploads()).toEqual([]);
  expect(fixture.gitData.posts("refs")).toEqual([]);
  expect(fixture.gitData.head(WORK_BRANCH)).toBeNull();
  expect(receiptsOf(fixture)).toEqual([]);
};

const CHATGPT = "https://chatgpt.com/c/12345678-1234-5678-1234-123456789012";

describe("#1161 r1 BP-01: the scan refuses on every surface before the first upload", () => {
  it("pins the Unicode registered path in a candidate blob", async () => {
    let unicode = "";
    const fixture = await setup({
      reviewedPaths: ["notes.md"],
      beforeCandidate: async (harness) => {
        unicode = await registerUnicodeCheckout(harness);
        candidateCommit(harness.repoPath, { "notes.md": `copied from ${unicode}/private.txt\n` }, "notes");
      },
    });
    const refused = await fixture.harness.cp.github.publishBranch(fixture.plan().publish);
    expect(refused.reasonCode).toBe(ReasonCode.BRANCH_PUBLISH_CONTENT_REFUSED);
    expect(JSON.stringify(refused.evidence)).not.toContain(unicode);
    expectNothingSent(fixture);
  });

  it("pins the Unicode registered path in a commit message, and refuses it in the author field", async () => {
    for (const [message, env] of [
      [`work in ${"__PATH__"}`, {}],
      ["clean", { GIT_AUTHOR_NAME: "dev __PATH__" }],
    ] as const) {
      let unicode = "";
      const fixture = await setup({
        reviewedPaths: ["notes.md"],
        beforeCandidate: async (harness) => {
          unicode = await registerUnicodeCheckout(harness);
          const fill = (text: string): string => text.replace("__PATH__", unicode);
          candidateCommit(harness.repoPath, { "notes.md": "clean\n" }, fill(message), Object.fromEntries(Object.entries(env).map(([k, v]) => [k, fill(v)])));
        },
      });
      const refused = await fixture.harness.cp.github.publishBranch(fixture.plan().publish);
      expect(refused.reasonCode).toBe(ReasonCode.BRANCH_PUBLISH_CONTENT_REFUSED);
      expectNothingSent(fixture);
    }
  });

  it("refuses a chatgpt.com/c session URL in the committer field and in a binary blob", async () => {
    const committer = await setup({
      reviewedPaths: ["notes.md"],
      beforeCandidate: (harness) => candidateCommit(harness.repoPath, { "notes.md": "clean\n" }, "clean", { GIT_COMMITTER_NAME: "chatgpt.com/c/12345678-1234" }),
    });
    expect((await committer.harness.cp.github.publishBranch(committer.plan().publish)).reasonCode).toBe(ReasonCode.BRANCH_PUBLISH_CONTENT_REFUSED);
    expectNothingSent(committer);
    const binary = await setup({
      reviewedPaths: ["asset.bin"],
      beforeCandidate: (harness) => candidateCommit(harness.repoPath, {
        "asset.bin": Buffer.concat([Buffer.from([0xff, 0x00, 0xc3]), Buffer.from(CHATGPT, "utf8"), Buffer.from([0x80])]),
      }, "asset"),
    });
    expect((await binary.harness.cp.github.publishBranch(binary.plan().publish)).reasonCode).toBe(ReasonCode.BRANCH_PUBLISH_CONTENT_REFUSED);
    expectNothingSent(binary);
  });

  it("pins the full tree path ~/.hermes/state", async () => {
    const fixture = await setup({ extraCandidateFiles: { "~/.hermes/state": "clean\n" } });
    const refused = await fixture.harness.cp.github.publishBranch(fixture.plan().publish);
    expect(refused.reasonCode).toBe(ReasonCode.BRANCH_PUBLISH_CONTENT_REFUSED);
    expect((refused.evidence["findings"] as Array<{ rule: string }>).map((finding) => finding.rule)).toContain("home state path");
    expectNothingSent(fixture);
  });

  it("pins chatgpt.com/c/<uuid> in the PR body: no upload, no ref, no receipt, and no PR (the finalizer stops at PUBLISH_BRANCH)", async () => {
    const fixture = await setup();
    const plan = fixture.plan();
    const refused = await fixture.harness.cp.github.publishBranch({ ...plan.publish, pullRequest: { ...plan.publish.pullRequest, body: CHATGPT } });
    expect(refused.reasonCode).toBe(ReasonCode.BRANCH_PUBLISH_CONTENT_REFUSED);
    expect(fixture.gitData.calls).toEqual([]);
    expectNothingSent(fixture);
    const title = await fixture.harness.cp.github.publishBranch({ ...plan.publish, pullRequest: { ...plan.publish.pullRequest, title: "see https://claude.ai/share/0123abcd" } });
    expect(title.reasonCode).toBe(ReasonCode.BRANCH_PUBLISH_CONTENT_REFUSED);
    expect(fixture.github.pulls).toEqual([]);
    expectNothingSent(fixture);
  });
});

describe("#1161 r1 BP-02: only the exact intended ref, a commit, at the candidate, may count", () => {
  it("pins a create answer naming another SHA: refused, nothing APPLIED; the next attempt settles it by the exact-target reconciliation read", async () => {
    const fixture = await setup();
    let contradict = true;
    fixture.gitData.intercepts.push((call) => {
      if (!contradict || call.method !== "POST" || !call.path.endsWith("/git/refs")) return undefined;
      fixture.gitData.setHead(WORK_BRANCH, fixture.driven.candidateHead);
      return { answer: { ref: `refs/heads/${WORK_BRANCH}`, object: { sha: "f".repeat(40), type: "commit" } } };
    });
    const refused = await fixture.harness.cp.github.publishBranch(fixture.plan().publish);
    expect(refused.reasonCode).toBe(ReasonCode.BRANCH_PUBLISH_OBJECT_MISMATCH);
    expect(receiptsOf(fixture)).toEqual([expect.objectContaining({ status: "PENDING", verified: 0 })]);
    contradict = false;
    const posts = fixture.gitData.calls.filter((call) => call.method === "POST").length;
    const settled = await fixture.harness.cp.github.publishBranch(fixture.plan().publish);
    expect(settled.reasonCode).toBe(ReasonCode.MERGE_IDEMPOTENT_REPLAY);
    expect(fixture.gitData.calls.filter((call) => call.method === "POST").length).toBe(posts);
    expect(receiptsOf(fixture)).toEqual([expect.objectContaining({ status: "APPLIED", verified: 1, preexisting: 0 })]);
    expectCreateOnly(fixture);
  });

  for (const [label, answer] of [
    ["another ref name at the candidate", (head: string) => ({ ref: "refs/heads/some-other-branch", object: { sha: head, type: "commit" } })],
    ["a tag object at the candidate", (head: string) => ({ ref: `refs/heads/${WORK_BRANCH}`, object: { sha: head, type: "tag" } })],
    ["no body at all", () => null],
  ] as const) {
    it(`refuses a create answer with ${label}, recording nothing applied`, async () => {
      const fixture = await setup();
      fixture.gitData.intercepts.push((call) => {
        if (call.method !== "POST" || !call.path.endsWith("/git/refs")) return undefined;
        fixture.gitData.setHead(WORK_BRANCH, fixture.driven.candidateHead);
        return { answer: answer(fixture.driven.candidateHead) };
      });
      const refused = await fixture.harness.cp.github.publishBranch(fixture.plan().publish);
      expect(refused.reasonCode).toBe(ReasonCode.BRANCH_PUBLISH_OBJECT_MISMATCH);
      expect(receiptsOf(fixture).some((row) => row.status === "APPLIED")).toBe(false);
      expectCreateOnly(fixture);
    });
  }

  it("pins a read answering another branch's name at the candidate SHA: refused before anything is sent, no receipt, the intended branch absent", async () => {
    const fixture = await setup();
    fixture.gitData.intercepts.push((call) => call.method === "GET" && call.path.endsWith(`/git/ref/heads/${WORK_BRANCH}`)
      ? { answer: { ref: "refs/heads/some-other-branch", object: { sha: fixture.driven.candidateHead, type: "commit" } } }
      : undefined);
    const refused = await fixture.harness.cp.github.publishBranch(fixture.plan().publish);
    expect(refused.reasonCode).toBe(ReasonCode.BRANCH_PUBLISH_OBJECT_MISMATCH);
    expectNothingSent(fixture);
  });

  it("refuses a base read answering another ref name, before anything is sent", async () => {
    const fixture = await setup();
    fixture.gitData.intercepts.push((call) => call.method === "GET" && call.path.endsWith("/git/ref/heads/dev")
      ? { answer: { ref: "refs/heads/main", object: { sha: fixture.driven.baseHead, type: "commit" } } }
      : undefined);
    const refused = await fixture.harness.cp.github.publishBranch(fixture.plan().publish);
    expect(refused.reasonCode).toBe(ReasonCode.BRANCH_PUBLISH_OBJECT_MISMATCH);
    expectNothingSent(fixture);
  });

  it("refuses a post-create readback naming another ref, and a reconciliation readback naming another ref; the receipt stays PENDING", async () => {
    const fixture = await setup();
    let afterCreate = false;
    fixture.gitData.intercepts.push((call) => {
      if (call.method === "POST" && call.path.endsWith("/git/refs")) afterCreate = true;
      return afterCreate && call.method === "GET" && call.path.endsWith(`/git/ref/heads/${WORK_BRANCH}`)
        ? { answer: { ref: "refs/heads/some-other-branch", object: { sha: fixture.driven.candidateHead, type: "commit" } } }
        : undefined;
    });
    const first = await fixture.harness.cp.github.publishBranch(fixture.plan().publish);
    expect(first.reasonCode).toBe(ReasonCode.BRANCH_PUBLISH_OBJECT_MISMATCH);
    expect(receiptsOf(fixture)).toEqual([expect.objectContaining({ status: "PENDING", verified: 0 })]);
    const posts = fixture.gitData.calls.filter((call) => call.method === "POST").length;
    const again = await fixture.harness.cp.github.publishBranch(fixture.plan().publish);
    expect(again.reasonCode).toBe(ReasonCode.BRANCH_PUBLISH_OBJECT_MISMATCH);
    expect(fixture.gitData.calls.filter((call) => call.method === "POST").length).toBe(posts);
    expect(receiptsOf(fixture)).toEqual([expect.objectContaining({ status: "PENDING", verified: 0 })]);
    expectCreateOnly(fixture);
  });
});

describe("#1161 r1 BP-03: the publication's caps and its receipt describe every commit, tree and blob byte", () => {
  const candidateBytes = (fixture: Fixture): { count: number; bytes: number } => {
    const ids = execFileSync("git", ["-C", fixture.harness.repoPath, "rev-list", "--objects", "--no-object-names", fixture.driven.candidateHead, `^${fixture.driven.baseHead}`], { encoding: "utf8", timeout: 30_000 });
    const sizes = execFileSync("git", ["-C", fixture.harness.repoPath, "cat-file", "--batch-check=%(objectsize)"], { input: ids, encoding: "utf8", timeout: 30_000 })
      .split("\n").filter(Boolean).map(Number);
    return { count: sizes.length, bytes: sizes.reduce((sum, size) => sum + size, 0) };
  };

  it("refuses one byte over the total before any request, and the receipt of a publication at the bound counts every byte", async () => {
    const probe = await setup();
    const { bytes } = candidateBytes(probe);
    const over = await setup({ limits: { maxTotalBytes: bytes - 1 } });
    expect(candidateBytes(over).bytes).toBe(bytes);
    const refused = await over.harness.cp.github.publishBranch(over.plan().publish);
    expect(refused.reasonCode).toBe(ReasonCode.BRANCH_PUBLISH_LIMIT_EXCEEDED);
    expect(over.gitData.calls).toEqual([]);
    expectNothingSent(over);
    const at = await setup({ limits: { maxTotalBytes: bytes } });
    const published = await at.harness.cp.github.publishBranch(at.plan().publish);
    expect(published.allowed, JSON.stringify(published)).toBe(true);
    const response = JSON.parse(receiptsOf(at)[0]!.response_json) as { counts: { bytes: number; commits: number; trees: number; blobs: number } };
    expect(response.counts.bytes).toBe(bytes);
    expect(response.counts.commits + response.counts.trees + response.counts.blobs).toBe(candidateBytes(at).count);
  });
});

/**
 * #1161 r1 — the reviewer's scenario probes (pr1161-reviewer-probes-round1/scenario-probes.test.ts), ported:
 * the same cases and assertions, with only the logging dropped and without the reviewer's sandbox stub, because
 * the sandbox runs on this host. The unmodified file is replayed separately (evidence r3/replay-*).
 */
describe("#1161 r1 reviewer scenario probes, ported", () => {
  it("review: rejects a mismatched ref-create response instead of APPLIED", async () => {
    const fixture = await setup();
    fixture.gitData.intercepts.push(call => {
      if (call.method !== "POST" || !call.path.endsWith("/git/refs")) return undefined;
      fixture.gitData.setHead(WORK_BRANCH, fixture.driven.candidateHead);
      return { answer: { ref: `refs/heads/${WORK_BRANCH}`, object: { sha: "f".repeat(40), type: "commit" } } };
    });
    const result = await fixture.harness.cp.github.publishBranch(fixture.plan().publish);
    expect(result.reasonCode).toBe(ReasonCode.BRANCH_PUBLISH_OBJECT_MISMATCH);
    expect(receiptsOf(fixture).some(row => row.status === "APPLIED")).toBe(false);
  });

  it("review: a readback naming another ref cannot prove the candidate ref exists", async () => {
    const fixture = await setup();
    fixture.gitData.intercepts.push(call => call.method === "GET" && call.path.endsWith(`/git/ref/heads/${WORK_BRANCH}`)
      ? { answer: {ref: "refs/heads/some-other-branch", object: {sha: fixture.driven.candidateHead, type: "commit"}} }
      : undefined);
    const result = await fixture.harness.cp.github.publishBranch(fixture.plan().publish);
    expect(result.allowed).toBe(false);
    expect(receiptsOf(fixture)).toEqual([]);
  });
  it("review: refuses a ChatGPT session URL before publication sends objects", async () => {
    const fixture = await setup();
    const plan = fixture.plan();
    const result = await fixture.harness.cp.github.publishBranch({...plan.publish, pullRequest: {...plan.publish.pullRequest, body: "https://chatgpt.com/c/12345678-1234-5678-1234-123456789012"}});
    const prepared = await fixture.harness.cp.github.prPrepare({...plan.prepare, body: "https://chatgpt.com/c/12345678-1234-5678-1234-123456789012"});
    void prepared; // the original probe logged it
    expect(result.reasonCode).toBe(ReasonCode.BRANCH_PUBLISH_CONTENT_REFUSED);
    expect(fixture.gitData.objectUploads()).toEqual([]);
  });

  for (const endpoint of ["blobs", "trees", "commits"]) {
    it(`review control: lost ${endpoint} answer stays pending and retry is create-only with one receipt`, async () => {
      const fixture = await setup();
      let lose = true;
      fixture.gitData.intercepts.push(call => lose && call.method === "POST" && call.path.endsWith(`/git/${endpoint}`) ? {applyThenSilence: true} : undefined);
      const first = await fixture.harness.cp.github.publishBranch(fixture.plan().publish);
      expect(first.allowed).toBe(false);
      expect(fixture.gitData.posts("refs")).toHaveLength(0);
      expect(receiptsOf(fixture)).toEqual([expect.objectContaining({status: "PENDING", verified: 0})]);
      lose = false;
      const retry = await fixture.harness.cp.github.publishBranch(fixture.plan().publish);
      expect(retry.allowed, JSON.stringify(retry)).toBe(true);
      expect(receiptsOf(fixture)).toEqual([expect.objectContaining({status: "APPLIED", verified: 1})]);
      expectCreateOnly(fixture);
    });
  }
  it("review control: lost ref readback reconciles without another POST", async () => {
    const fixture = await setup();
    let lose = true;
    fixture.gitData.intercepts.push(call => lose && fixture.gitData.posts("refs").length > 0 && call.method === "GET" && call.path.endsWith(`/git/ref/heads/${WORK_BRANCH}`) ? {silence: true} : undefined);
    expect((await fixture.harness.cp.github.publishBranch(fixture.plan().publish)).allowed).toBe(false);
    expect(receiptsOf(fixture)).toEqual([expect.objectContaining({status: "PENDING", verified: 0})]);
    const posts = fixture.gitData.calls.filter(c=>c.method === "POST").length;
    lose = false;
    expect((await fixture.harness.cp.github.publishBranch(fixture.plan().publish)).allowed).toBe(true);
    expect(fixture.gitData.calls.filter(c=>c.method === "POST")).toHaveLength(posts);
    expect(receiptsOf(fixture)).toEqual([expect.objectContaining({status: "APPLIED", verified: 1})]);
  });
  it("review control: ref moved between create and readback stays collision and pending", async () => {
    const fixture = await setup();
    let other = "";
    fixture.gitData.intercepts.push(call => {
      if(call.method !== "POST" || !call.path.endsWith("/git/refs")) return undefined;
      other = remoteCommitOn(fixture, fixture.driven.candidateHead);
      fixture.gitData.setHead(WORK_BRANCH, other);
      return {answer: {ref: `refs/heads/${WORK_BRANCH}`, object: {sha: fixture.driven.candidateHead, type: "commit"}}};
    });
    const result = await fixture.harness.cp.github.publishBranch(fixture.plan().publish);
    expect(result.reasonCode).toBe(ReasonCode.RESOURCE_COLLISION);
    expect(fixture.gitData.head(WORK_BRANCH)).toBe(other);
    expect(receiptsOf(fixture)).toEqual([expect.objectContaining({status: "PENDING", verified: 0})]);
    expectCreateOnly(fixture);
  });
  it("review control: moving local work and source tips still publishes only the frozen candidate", async () => {
    const fixture = await setup();
    const tip=execFileSync("git", ["-C", fixture.harness.repoPath, "commit-tree", `${fixture.driven.candidateHead}^{tree}`, "-p", fixture.driven.candidateHead, "-m", "tip moved"], {encoding: "utf8", timeout: 30_000, env: {...process.env, GIT_AUTHOR_NAME: "x", GIT_AUTHOR_EMAIL: "x@example.invalid", GIT_COMMITTER_NAME: "x", GIT_COMMITTER_EMAIL: "x@example.invalid"}}).trim();
    for(const branch of [WORK_BRANCH, "dev"]) execFileSync("git", ["-C", fixture.harness.repoPath, "update-ref", `refs/heads/${branch}`, tip], {timeout: 30_000});
    const result=await fixture.harness.cp.github.publishBranch(fixture.plan().publish);
    expect(result.allowed, JSON.stringify(result)).toBe(true);
    expect(fixture.gitData.head(WORK_BRANCH)).toBe(fixture.driven.candidateHead);
    expect(fixture.gitData.objectUploads().some(c=>(c.body as {message?: string}).message === "tip moved\n")).toBe(false);
  });
});
