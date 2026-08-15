import { realpathSync } from "node:fs";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { digestOf, sha256 } from "../../src/core/digest.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ExecutionMode } from "../../src/domain/types.ts";
import {
  GATE_CHECK_NAME,
  NO_HUMAN_GATE_DIGEST,
  type GatePayload,
} from "../../src/github/github-kernel.ts";
import { classifyBranch, validateBranchContract } from "../../src/github/branch-contract.ts";
import { parseVerificationCommand } from "../../src/contracts/verification-command.ts";
import { candidateSnapshotDigest, type CandidateSnapshot } from "../../src/snapshot/candidate-snapshot.ts";
import { cleanupTempDirs, commitAll, gitSync, writeFiles } from "../helpers/fixtures.ts";
import { FakeGitHub } from "../helpers/fake-github.ts";
import {
  type Harness,
  approveReviewedCandidateForFinalization,
  driveToReviewedCandidate,
  installDaemonFinalizerGitHubFixture,
  makeHarness,
  registerFixtureProject,
} from "../helpers/harness.ts";
import type { TaskContract } from "../../src/run/run-engine.ts";

afterAll(cleanupTempDirs);

const CONTRACT: TaskContract = {
  goal: "github kernel scenario",
  why: "scenario",
  scope: [],
  nonGoals: [],
  acceptance: ["merged through the trusted kernel"],
  priority: "NORMAL",
  humanGate: [],
  references: [],
};

const PROFILE = {
  longLived: ["main", "dev"],
  defaultBranch: "dev",
  updateStrategy: "rebase_before_review" as const,
  mergeStrategy: "merge_commit" as const,
  releaseTagPolicy: "semver" as const,
  releaseBranchCleanup: "keep" as const,
};

/** The check the fixture project declares as its post-merge requirement (§24.7). */
const CI_WORKFLOWS = [
  { path: ".github/workflows/ci.yml", checkName: "project-ci", approvedDigest: null, repositoryRole: "primary" },
];

const TRUSTED_CI_COMMANDS = [
  parseVerificationCommand({
    id: "project-ci",
    argv: ["node", "verify.js"],
    repositoryRole: "primary",
    evidenceMode: "TRUSTED_CI",
    timeoutSeconds: 60,
  }),
];

interface Fixture {
  harness: Harness;
  github: FakeGitHub;
  runId: string;
  identity: string;
  ownerSessionId: string;
  ownerBindingGeneration: number;
  caller: { ownerSessionId: string; ownerBindingGeneration: number };
  head: string;
  base: string;
  workBranch: string;
  payload: GatePayload;
}

/** Model GitHub's merged-PR snapshot plus its separately reread target ref. */
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
    const merge = response as { merged?: unknown; sha?: unknown };
    const pullNumber = Number(/\/pulls\/(\d+)\/merge$/.exec(path)?.[1]);
    const pull = github.pulls.find((entry) => entry.number === pullNumber);
    if (merge.merged !== true || typeof merge.sha !== "string" || !pull) return response;
    (pull as typeof pull & { merge_commit_sha?: string }).merge_commit_sha = merge.sha;
    github.setBranch(pull.base.ref, merge.sha);
    return response;
  };
};

/**
 * A real run driven to production-ready, so the gate payload names evidence that exists.
 * The kernel refuses to publish a gate for digests it cannot resolve, which means these
 * scenarios cannot be set up with placeholder digests.
 */
const setup = async (options: { finalization?: boolean } = {}): Promise<Fixture> => {
  const github = new FakeGitHub();
  reflectMergedBase(github);
  const harness = makeHarness({ githubClient: github });
  harness.cp.credentials.install({ token: "test-token", creatorIdentity: "acp-trusted-app" });
  harness.cp.verification.attachCi({
    fetch: async (repositoryIdentity, head) => [
      {
        commandId: "project-ci",
        repositoryIdentity,
        head,
        conclusion: "success" as const,
        workflowDigest: "sha256:approved",
        creatorIdentity: "github-actions",
        completedAt: "2026-08-12T00:00:00.000Z",
        nonVacuous: true,
      },
    ],
    approvedWorkflowDigests: async () => ["sha256:approved"],
    trustedCreators: async () => ["github-actions"],
  });

  const driven = await driveToReviewedCandidate(harness, {
    workBranch: "feature/F1-thing",
    manifestOverrides: {
      ciWorkflows: CI_WORKFLOWS,
      verificationProfiles: { simple: ["project-ci"], standard: ["project-ci"], guarded: ["project-ci"] },
      verificationCommands: TRUSTED_CI_COMMANDS,
    },
  });

  // GitHub's view of the repository matches the frozen candidate.
  github.setBranch("dev", driven.baseHead);
  github.setBranch("main", "c".repeat(40));
  github.setBranch(driven.workBranch, driven.candidateHead);

  // The kernel requires a live claim on the branch it is about to write.
  const claimed = harness.cp.claims.acquire({
    runId: driven.runId,
    ownerSessionId: driven.ownerSessionId,
    ownerBindingGeneration: driven.ownerBindingGeneration,
    ownerRoleKey: harness.cp.runs.require(driven.runId).ownerRoleKey!,
    repositoryIdentity: driven.identity,
    branch: driven.workBranch,
  });
  if (!claimed.allowed) throw new Error(claimed.message);

  if (options.finalization !== false) {
    await approveReviewedCandidateForFinalization(harness, driven);
    installDaemonFinalizerGitHubFixture(harness);
  }

  return {
    harness,
    github,
    runId: driven.runId,
    identity: driven.identity,
    ownerSessionId: driven.ownerSessionId,
    ownerBindingGeneration: driven.ownerBindingGeneration,
    caller: {
      ownerSessionId: driven.ownerSessionId,
      ownerBindingGeneration: driven.ownerBindingGeneration,
    },
    head: driven.candidateHead,
    base: driven.baseHead,
    workBranch: driven.workBranch,
    payload: {
      runId: driven.runId,
      candidateSnapshotDigest: driven.candidateSnapshotDigest,
      contractDigest: driven.contractDigest,
      verificationDigest: driven.verificationDigest,
      blindReviewDigest: driven.blindReviewDigest,
      humanGateDigest: NO_HUMAN_GATE_DIGEST,
      bindingGeneration: driven.ownerBindingGeneration,
      exactHead: driven.candidateHead,
      timestamp: "2026-08-12T00:00:00.000Z",
    },
  };
};

const gatePayload = (fixture: Fixture, head = fixture.head): GatePayload => ({
  ...fixture.payload,
  exactHead: head,
});

/**
 * Build the two branch classes whose legal source and legal PR target deliberately differ.
 * The source branch receives its own commit before the candidate is cut, so the kernel has
 * an actual ancestry fact to prove rather than a branch-name-only fixture.
 */
const setupLineageFixture = async (input: {
  workBranch: string;
  baseBranch: string;
  /** The branch the fixture actually cuts from; freeze independently records the required origin. */
  sourceBranch: string;
  /** Other active releases, needed to prove hotfix propagation against more than one release. */
  activeReleases?: readonly string[];
  /** Advance the required source separately to prove a candidate was cut from the wrong branch. */
  divergentBranch?: "dev" | "main";
  /** Keep main and dev at their shared root so the freeze resolver must reject ambiguity. */
  sharedAncestor?: boolean;
}): Promise<Fixture> => {
  const github = new FakeGitHub();
  reflectMergedBase(github);
  const harness = makeHarness({ githubClient: github });
  harness.cp.credentials.install({ token: "test-token", creatorIdentity: "acp-trusted-app" });

  // `main` begins at the fixture root. Create the parent branches that the matrix needs;
  // every later candidate is still cut by real git from the selected source branch.
  gitSync(harness.repoPath, ["branch", "main"]);
  const requiredBranches = new Set([
    input.sourceBranch,
    input.baseBranch,
    ...(input.activeReleases ?? []),
  ]);
  for (const branch of requiredBranches) {
    if (branch === "main" || branch === "dev") continue;
    if (!gitSync(harness.repoPath, ["branch", "--list", branch]).trim()) {
      gitSync(harness.repoPath, ["branch", branch, "dev"]);
    }
  }
  if (input.divergentBranch && input.divergentBranch !== input.sourceBranch) {
    gitSync(harness.repoPath, ["checkout", "-q", input.divergentBranch]);
    writeFiles(harness.repoPath, {
      "LINEAGE.md": `required source ${input.divergentBranch} advanced separately\n`,
    });
    commitAll(harness.repoPath, `advance required source ${input.divergentBranch}`);
  }
  gitSync(harness.repoPath, ["checkout", "-q", input.sourceBranch]);
  if (!input.sharedAncestor) {
    writeFiles(harness.repoPath, { "LINEAGE.md": `cut ${input.workBranch} from ${input.sourceBranch}\n` });
    commitAll(harness.repoPath, `advance ${input.sourceBranch} before cut`);
  }

  const driven = await driveToReviewedCandidate(harness, {
    workBranch: input.workBranch,
    baseBranch: input.baseBranch,
    reviewedPaths: ["LINEAGE.md", "src/app.js"],
  });
  for (const branch of new Set(["dev", "main", input.sourceBranch, input.baseBranch, ...(input.activeReleases ?? [])])) {
    github.setBranch(branch, gitSync(harness.repoPath, ["rev-parse", branch]));
  }
  github.setBranch(driven.workBranch, driven.candidateHead);

  const claimed = harness.cp.claims.acquire({
    runId: driven.runId,
    ownerSessionId: driven.ownerSessionId,
    ownerBindingGeneration: driven.ownerBindingGeneration,
    ownerRoleKey: harness.cp.runs.require(driven.runId).ownerRoleKey!,
    repositoryIdentity: driven.identity,
    branch: driven.workBranch,
  });
  if (!claimed.allowed) throw new Error(claimed.message);

  await approveReviewedCandidateForFinalization(harness, driven);
  installDaemonFinalizerGitHubFixture(harness);

  return {
    harness,
    github,
    runId: driven.runId,
    identity: driven.identity,
    ownerSessionId: driven.ownerSessionId,
    ownerBindingGeneration: driven.ownerBindingGeneration,
    caller: {
      ownerSessionId: driven.ownerSessionId,
      ownerBindingGeneration: driven.ownerBindingGeneration,
    },
    head: driven.candidateHead,
    base: driven.baseHead,
    workBranch: driven.workBranch,
    payload: {
      runId: driven.runId,
      candidateSnapshotDigest: driven.candidateSnapshotDigest,
      contractDigest: driven.contractDigest,
      verificationDigest: driven.verificationDigest,
      blindReviewDigest: driven.blindReviewDigest,
      humanGateDigest: NO_HUMAN_GATE_DIGEST,
      bindingGeneration: driven.ownerBindingGeneration,
      exactHead: driven.candidateHead,
      timestamp: "2026-08-12T00:00:00.000Z",
    },
  };
};

/** Release tags require historical merge and post-merge evidence the feature-to-dev fixture cannot produce. */
const recordAcceptedReleaseMerge = (fixture: Fixture, commit: string, pullNumber: number): void => {
  const idempotencyKey = `merge_execute:${fixture.identity}:${pullNumber}`;
  fixture.harness.cp.db.run(
    `INSERT INTO github_receipts
       (receipt_id, idempotency_key, operation, run_id, repository_identity, resource_type, resource_identity,
        preexisting, before_state_digest, after_state_digest, request_digest, response_json, created_at,
        reread_at, verified, status)
     VALUES (?, ?, 'merge_execute', ?, ?, 'merge', ?, 0, NULL, NULL, ?, '{"pending":true}', ?, NULL, 0, 'PENDING')`,
    [
      `rcp_release_merge_${pullNumber}`,
      idempotencyKey,
      fixture.runId,
      fixture.identity,
      `acme/fixture#${pullNumber}`,
      digestOf({ releaseMerge: commit }),
      "2026-08-12T00:00:00.000Z",
    ],
  );
  fixture.harness.cp.db.run(
    `UPDATE github_receipts
        SET status = 'APPLIED', after_state_digest = ?, response_json = ?, reread_at = ?, verified = 1
      WHERE idempotency_key = ? AND status = 'PENDING'`,
    [
      sha256(commit),
      JSON.stringify({ mergeCommitSha: commit, sourceBranch: fixture.workBranch, targetBranch: "main" }),
      "2026-08-12T00:00:00.000Z",
      idempotencyKey,
    ],
  );
  fixture.harness.cp.db.run(
    `INSERT INTO github_receipts
       (receipt_id, idempotency_key, operation, run_id, repository_identity, resource_type, resource_identity,
        preexisting, before_state_digest, after_state_digest, request_digest, response_json, created_at,
        reread_at, verified, status)
     VALUES (?, ?, 'post_merge_verify', ?, ?, 'commit', ?, 0, NULL, ?, ?, ?, ?, ?, 1, 'APPLIED')`,
    [
      `rcp_release_postmerge_${pullNumber}`,
      `post_merge_verify:${fixture.identity}:${commit}`,
      fixture.runId,
      fixture.identity,
      `acme/fixture@${commit}`,
      digestOf([{ name: "project-ci", conclusion: "success" }]),
      digestOf({ postMerge: commit }),
      JSON.stringify({ checks: [{ name: "project-ci", conclusion: "success" }] }),
      "2026-08-12T00:00:00.000Z",
      "2026-08-12T00:00:00.000Z",
    ],
  );
  fixture.github.markContains("dev", commit);
};

/** A raw PENDING row is the durable recovery input after the daemon has lost its memory. */
const reservePendingReceipt = (
  fixture: Fixture,
  receipt: {
    receiptId: string;
    idempotencyKey: string;
    operation: "pr_prepare" | "gate_publish" | "merge_execute";
    resourceType: string;
    resourceIdentity: string;
    beforeStateDigest: string | null;
    requestDigest: string;
  },
): void => {
  fixture.harness.cp.db.run(
    `INSERT INTO github_receipts
       (receipt_id, idempotency_key, operation, run_id, repository_identity, resource_type, resource_identity,
        preexisting, before_state_digest, after_state_digest, request_digest, response_json, created_at,
        reread_at, verified, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, ?, '{"pending":true}', ?, NULL, 0, 'PENDING')`,
    [
      receipt.receiptId,
      receipt.idempotencyKey,
      receipt.operation,
      fixture.runId,
      fixture.identity,
      receipt.resourceType,
      receipt.resourceIdentity,
      receipt.beforeStateDigest,
      receipt.requestDigest,
      "2026-08-12T00:00:00.000Z",
    ],
  );
};

const prepareInput = (fixture: Fixture) => ({
  runId: fixture.runId,
  repositoryIdentity: fixture.identity,
  head: fixture.workBranch,
  base: "dev",
  title: "candidate",
  body: "",
  ownerSessionId: fixture.ownerSessionId,
  ownerBindingGeneration: fixture.ownerBindingGeneration,
  exactHeadSha: fixture.head,
});

const mergeInput = (fixture: Fixture, pullNumber: number) => ({
  runId: fixture.runId,
  repositoryIdentity: fixture.identity,
  pullNumber,
  exactHeadSha: fixture.head,
  expectedBaseSha: fixture.base,
  mergeStrategy: "merge_commit" as const,
  ownerSessionId: fixture.ownerSessionId,
  ownerBindingGeneration: fixture.ownerBindingGeneration,
});

describe("branch contract (CP-S36, RF-S10, RF-S11)", () => {
  it("classifies every pattern in the Integration §9.2 matrix", () => {
    expect(classifyBranch("main", PROFILE).class).toBe("main");
    expect(classifyBranch("dev", PROFILE).class).toBe("dev");
    expect(classifyBranch("feature/F12-widget", PROFILE)).toMatchObject({ class: "feature", identifier: "F12" });
    expect(classifyBranch("task/T34-impl", PROFILE)).toMatchObject({ class: "task", identifier: "T34" });
    expect(classifyBranch("release/1.4.0", PROFILE)).toMatchObject({ class: "release", identifier: "1.4.0" });
    expect(classifyBranch("hotfix/T9-urgent", PROFILE)).toMatchObject({ class: "hotfix", identifier: "T9" });
    expect(classifyBranch("random-branch", PROFILE).class).toBe("unknown");
  });

  it("RF-S10: a feature branch targeting anything but dev is refused", () => {
    expect(validateBranchContract({ head: "feature/F1-x", base: "dev", profile: PROFILE }).allowed).toBe(true);
    const refused = validateBranchContract({ head: "feature/F1-x", base: "main", profile: PROFILE });
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.PR_BRANCH_CONTRACT_VIOLATION);
  });

  it("RF-S11: a task branch may only target its declared parent", () => {
    expect(
      validateBranchContract({
        head: "task/T1-x",
        base: "feature/F1-x",
        profile: PROFILE,
        declaredParent: "feature/F1-x",
      }).allowed,
    ).toBe(true);

    const undeclared = validateBranchContract({ head: "task/T1-x", base: "dev", profile: PROFILE });
    expect(undeclared.allowed).toBe(false);

    const mismatched = validateBranchContract({
      head: "task/T1-x",
      base: "dev",
      profile: PROFILE,
      declaredParent: "feature/F1-x",
    });
    expect(mismatched.allowed).toBe(false);
  });

  it("release and hotfix targets follow the matrix, including active-release checks", () => {
    expect(validateBranchContract({ head: "release/1.2.0", base: "main", profile: PROFILE }).allowed).toBe(true);
    expect(validateBranchContract({ head: "release/not-semver", base: "main", profile: PROFILE }).allowed).toBe(false);
    expect(
      validateBranchContract({
        head: "hotfix/T1-x",
        base: "release/1.2.0",
        profile: PROFILE,
        activeReleases: ["release/1.2.0"],
      }).allowed,
    ).toBe(true);
    expect(
      validateBranchContract({
        head: "hotfix/T1-x",
        base: "release/9.9.9",
        profile: PROFILE,
        activeReleases: ["release/1.2.0"],
      }).allowed,
    ).toBe(false);
  });

  it("CP-S36: pr_prepare refuses a contract-violating target before any external write", async () => {
    const fixture = await setup();
    const refused = await fixture.harness.cp.github.prPrepare({
      runId: fixture.runId,
      repositoryIdentity: fixture.identity,
      head: fixture.workBranch,
      base: "main",
      title: "wrong target",
      body: "",
      ownerSessionId: fixture.ownerSessionId,
      ownerBindingGeneration: fixture.ownerBindingGeneration,
      exactHeadSha: fixture.head,
    });
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.PR_BRANCH_CONTRACT_VIOLATION);
    expect(fixture.github.pulls).toHaveLength(0);
  });

  it("pr_prepare re-reads the pull request and refuses a head that does not match the candidate", async () => {
    const fixture = await setup();
    const refused = await fixture.harness.cp.github.prPrepare({
      runId: fixture.runId,
      repositoryIdentity: fixture.identity,
      head: fixture.workBranch,
      base: "dev",
      title: "ok",
      body: "",
      ownerSessionId: fixture.ownerSessionId,
      ownerBindingGeneration: fixture.ownerBindingGeneration,
      exactHeadSha: "d".repeat(40),
    });
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.SNAPSHOT_STALE);
  });

  const lineageMatrix: ReadonlyArray<{
    name: string;
    workBranch: string;
    sourceBranch: string;
    baseBranch: string;
    declaredParent?: string;
    activeReleases?: readonly string[];
  }> = [
    { name: "feature → dev", workBranch: "feature/F1-thing", sourceBranch: "dev", baseBranch: "dev" },
    {
      name: "task → feature",
      workBranch: "task/T1-feature",
      sourceBranch: "feature/F1-parent",
      baseBranch: "feature/F1-parent",
      declaredParent: "feature/F1-parent",
    },
    {
      name: "task → dev",
      workBranch: "task/T1-dev",
      sourceBranch: "dev",
      baseBranch: "dev",
      declaredParent: "dev",
    },
    {
      name: "task → release",
      workBranch: "task/T1-release",
      sourceBranch: "release/1.2.0",
      baseBranch: "release/1.2.0",
      declaredParent: "release/1.2.0",
      activeReleases: ["release/1.2.0"],
    },
    { name: "release → main", workBranch: "release/1.2.0", sourceBranch: "dev", baseBranch: "main" },
    { name: "release → dev", workBranch: "release/1.2.0", sourceBranch: "dev", baseBranch: "dev" },
    { name: "hotfix → main", workBranch: "hotfix/H1-main", sourceBranch: "main", baseBranch: "main" },
    { name: "hotfix → dev", workBranch: "hotfix/H1-dev", sourceBranch: "main", baseBranch: "dev" },
    {
      name: "hotfix → active release/1.2.0",
      workBranch: "hotfix/H1-release-one",
      sourceBranch: "main",
      baseBranch: "release/1.2.0",
      activeReleases: ["release/1.2.0", "release/2.0.0"],
    },
    {
      name: "hotfix → active release/2.0.0",
      workBranch: "hotfix/H1-release-two",
      sourceBranch: "main",
      baseBranch: "release/2.0.0",
      activeReleases: ["release/1.2.0", "release/2.0.0"],
    },
  ];

  for (const scenario of lineageMatrix) {
    it(`#382: ${scenario.name} prepares and merges with the frozen origin and target`, async () => {
      const fixture = await setupLineageFixture(scenario);
      const gate = await fixture.harness.cp.github.gatePublish(fixture.payload, fixture.identity);
      if (!gate.allowed) throw new Error(`${gate.reasonCode}: ${gate.message}`);
      const prepared = await fixture.harness.cp.github.prPrepare({
        runId: fixture.runId,
        repositoryIdentity: fixture.identity,
        head: fixture.workBranch,
        base: scenario.baseBranch,
        title: `${scenario.name} candidate`,
        body: "",
        ...(scenario.declaredParent ? { declaredParent: scenario.declaredParent } : {}),
        ownerSessionId: fixture.ownerSessionId,
        ownerBindingGeneration: fixture.ownerBindingGeneration,
        exactHeadSha: fixture.head,
      });
      expect(prepared.allowed).toBe(true);
      if (!prepared.allowed) return;

      const frozen = fixture.harness.cp.artifacts.latestForSnapshot<{
        repositories: Array<{ identity: string; sourceBranch?: string | null; sourceHead?: string | null }>;
      }>(fixture.runId, "CANDIDATE_SNAPSHOT", fixture.payload.candidateSnapshotDigest);
      const source = frozen?.content.repositories.find((repository) => repository.identity === fixture.identity);
      expect(source).toMatchObject({ sourceBranch: scenario.sourceBranch });
      expect(source?.sourceHead).toMatch(/^[0-9a-f]{40}$/);

      const receipt = fixture.harness.cp.db.get<{ response_json: string }>(
        `SELECT response_json FROM github_receipts
          WHERE operation = 'pr_prepare' AND run_id = ? AND repository_identity = ?`,
        [fixture.runId, fixture.identity],
      );
      const intent = JSON.parse(receipt!.response_json) as { intent: Record<string, unknown> };
      expect(intent.intent).toMatchObject({
        base: scenario.baseBranch,
        candidateSnapshotDigest: fixture.payload.candidateSnapshotDigest,
        sourceBranch: scenario.sourceBranch,
        sourceHead: source?.sourceHead,
      });
      expect(fixture.github.pulls.find((pull) => pull.number === prepared.value.pullNumber)).toMatchObject({
        head: { ref: scenario.workBranch, sha: fixture.head },
        base: { ref: scenario.baseBranch, sha: fixture.base },
      });

      const merged = await fixture.harness.cp.github.mergeExecute(
        mergeInput(fixture, prepared.value.pullNumber),
      );
      expect(merged.allowed).toBe(true);
      expect(fixture.github.mergeCount).toBe(1);
    });
  }

  it("#382: a source ref advancing after freeze does not replace the frozen origin", async () => {
    const fixture = await setupLineageFixture({
      workBranch: "release/1.2.0",
      sourceBranch: "dev",
      baseBranch: "main",
    });
    const frozen = fixture.harness.cp.artifacts.latestForSnapshot<{
      repositories: Array<{ identity: string; sourceBranch?: string | null; sourceHead?: string | null }>;
    }>(fixture.runId, "CANDIDATE_SNAPSHOT", fixture.payload.candidateSnapshotDigest);
    const source = frozen?.content.repositories.find((repository) => repository.identity === fixture.identity);
    if (!source?.sourceHead) throw new Error("fixture did not freeze a source head");

    gitSync(fixture.harness.repoPath, ["checkout", "-q", "dev"]);
    writeFiles(fixture.harness.repoPath, { "POST_FREEZE.md": "advance dev after freeze\n" });
    const advancedSourceHead = commitAll(fixture.harness.repoPath, "advance source after freeze");
    gitSync(fixture.harness.repoPath, ["checkout", "-q", fixture.workBranch]);
    fixture.github.setBranch("dev", advancedSourceHead);
    expect(advancedSourceHead).not.toBe(source.sourceHead);

    const gate = await fixture.harness.cp.github.gatePublish(fixture.payload, fixture.identity);
    if (!gate.allowed) throw new Error(`${gate.reasonCode}: ${gate.message}`);
    const prepared = await fixture.harness.cp.github.prPrepare({
      runId: fixture.runId,
      repositoryIdentity: fixture.identity,
      head: fixture.workBranch,
      base: "main",
      title: "release candidate with advanced source ref",
      body: "",
      ownerSessionId: fixture.ownerSessionId,
      ownerBindingGeneration: fixture.ownerBindingGeneration,
      exactHeadSha: fixture.head,
    });
    expect(prepared.allowed).toBe(true);
    if (!prepared.allowed) return;

    const receipt = fixture.harness.cp.db.get<{ response_json: string }>(
      `SELECT response_json FROM github_receipts
        WHERE operation = 'pr_prepare' AND run_id = ? AND repository_identity = ?`,
      [fixture.runId, fixture.identity],
    );
    const intent = JSON.parse(receipt!.response_json) as { intent: { sourceHead: string } };
    expect(intent.intent.sourceHead).toBe(source.sourceHead);

    const merged = await fixture.harness.cp.github.mergeExecute(mergeInput(fixture, prepared.value.pullNumber));
    expect(merged.allowed).toBe(true);
  });

  it("#382: a candidate without a frozen source fails closed before PR creation", async () => {
    const fixture = await setup();
    const original = fixture.harness.cp.artifacts.latestForSnapshot<CandidateSnapshot>(
      fixture.runId,
      "CANDIDATE_SNAPSHOT",
      fixture.payload.candidateSnapshotDigest,
    );
    if (!original) throw new Error("fixture did not produce a candidate snapshot");
    const detached: CandidateSnapshot = {
      ...original.content,
      repositories: original.content.repositories.map((repository) => ({
        ...repository,
        sourceBranch: null,
        sourceHead: null,
      })),
    };
    const detachedDigest = candidateSnapshotDigest(detached);
    fixture.harness.cp.artifacts.put(fixture.runId, "CANDIDATE_SNAPSHOT", detached, detachedDigest);
    fixture.harness.cp.runs.promoteCandidate(fixture.runId, detachedDigest);

    const refused = await fixture.harness.cp.github.prPrepare(prepareInput(fixture));
    expect(refused.reasonCode).toBe(ReasonCode.PR_BRANCH_CONTRACT_VIOLATION);
    expect(fixture.github.pulls).toHaveLength(0);
  });

  it("#382: a release cut from main cannot use its main target to masquerade as a dev cut", async () => {
    const fixture = await setupLineageFixture({
      workBranch: "release/1.2.0",
      sourceBranch: "main",
      baseBranch: "main",
      divergentBranch: "dev",
    });

    const refused = await fixture.harness.cp.github.prPrepare({
      runId: fixture.runId,
      repositoryIdentity: fixture.identity,
      head: fixture.workBranch,
      base: "main",
      title: "misbased release candidate",
      body: "",
      ownerSessionId: fixture.ownerSessionId,
      ownerBindingGeneration: fixture.ownerBindingGeneration,
      exactHeadSha: fixture.head,
    });

    // If the merge-base proof is deleted, the required branch name still looks correct and
    // this formerly accepted main target would create a PR. The failure proves ancestry,
    // rather than target naming, is the enforcement.
    expect(refused.reasonCode).toBe(ReasonCode.PR_BRANCH_CONTRACT_VIOLATION);
    expect(fixture.github.pulls).toHaveLength(0);
  });

  it("#422: a release cut from main is refused when main and dev still share their ancestor", async () => {
    // C is the exact tip of both main and dev. The release is then cut from main at C and
    // receives its candidate commit; dev is deliberately never advanced.
    const fixture = await setupLineageFixture({
      workBranch: "release/1.2.0",
      sourceBranch: "main",
      baseBranch: "main",
      sharedAncestor: true,
    });
    expect(gitSync(fixture.harness.repoPath, ["rev-parse", "main"])).toBe(
      gitSync(fixture.harness.repoPath, ["rev-parse", "dev"]),
    );

    const refused = await fixture.harness.cp.github.prPrepare({
      runId: fixture.runId,
      repositoryIdentity: fixture.identity,
      head: fixture.workBranch,
      base: "main",
      title: "ambiguous-origin release candidate",
      body: "",
      ownerSessionId: fixture.ownerSessionId,
      ownerBindingGeneration: fixture.ownerBindingGeneration,
      exactHeadSha: fixture.head,
    });

    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.PR_BRANCH_CONTRACT_VIOLATION);
    expect(fixture.github.pulls).toHaveLength(0);
  });

  it("refuses a PR when the project contract requires issue linkage and none is supplied", async () => {
    const fixture = await setup();
    const refused = await fixture.harness.cp.github.prPrepare({
      runId: fixture.runId,
      repositoryIdentity: fixture.identity,
      head: fixture.workBranch,
      base: "dev",
      title: "ok",
      body: "",
      requireLinkage: true,
      linkedIssues: [],
      ownerSessionId: fixture.ownerSessionId,
      ownerBindingGeneration: fixture.ownerBindingGeneration,
      exactHeadSha: fixture.head,
    });
    expect(refused.reasonCode).toBe(ReasonCode.PR_LINKAGE_MISSING);
  });
});

describe("production gate provenance (CP-S35, CP-S37)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await setup();
  });

  it("CP-S35: a same-named check from an untrusted creator or with an unknown payload is refused", async () => {
    // The candidate forges a check with the gate's exact name.
    fixture.github.forgeGate(fixture.head, `payloadDigest=sha256:${"9".repeat(64)}`, "candidate-ci");

    const prepared = await fixture.harness.cp.github.prPrepare({
      runId: fixture.runId,
      repositoryIdentity: fixture.identity,
      head: fixture.workBranch,
      base: "dev",
      title: "candidate",
      body: "",
      ownerSessionId: fixture.ownerSessionId,
      ownerBindingGeneration: fixture.ownerBindingGeneration,
      exactHeadSha: fixture.head,
    });
    if (!prepared.allowed) throw new Error(prepared.message);

    const refused = await fixture.harness.cp.github.mergeEvaluate({
      runId: fixture.runId,
      repositoryIdentity: fixture.identity,
      pullNumber: prepared.value.pullNumber,
      exactHeadSha: fixture.head,
      expectedBaseSha: fixture.base,
      mergeStrategy: "merge_commit",
      ownerSessionId: fixture.ownerSessionId,
      ownerBindingGeneration: fixture.ownerBindingGeneration,
    });
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.GATE_PAYLOAD_PROVENANCE_INVALID);

    const rejections = fixture.harness.cp.audit.byKind("GATE_REJECTED");
    expect(rejections.length).toBeGreaterThan(0);
  });

  it("#388: a copied trusted payload digest from an untrusted app slug cannot approve a merge", async () => {
    const published = await fixture.harness.cp.github.gatePublish(gatePayload(fixture), fixture.identity);
    if (!published.allowed) throw new Error(published.message);
    const prepared = await fixture.harness.cp.github.prPrepare(prepareInput(fixture));
    if (!prepared.allowed) throw new Error(prepared.message);

    // Keep the exact recorded check id and summary: creator provenance is the sole
    // changed fact, so deleting that predicate makes this test incorrectly pass.
    fixture.github.checkRuns.find((check) => check.id === published.value.checkRunId)!.app = { slug: "candidate-ci" };
    const refused = await fixture.harness.cp.github.mergeEvaluate(mergeInput(fixture, prepared.value.pullNumber));
    expect(refused.allowed).toBe(false);
    expect(
      fixture.harness.cp.audit
        .byKind("GATE_REJECTED")
        .some((event) => event.reasonCode === ReasonCode.GATE_CREATOR_UNTRUSTED),
    ).toBe(true);
  });

  it("CP-S35: a gate whose payload the daemon did record, but under a different head, is refused", async () => {
    const published = await fixture.harness.cp.github.gatePublish(gatePayload(fixture), fixture.identity);
    expect(published.allowed).toBe(true);

    const prepared = await fixture.harness.cp.github.prPrepare({
      runId: fixture.runId,
      repositoryIdentity: fixture.identity,
      head: fixture.workBranch,
      base: "dev",
      title: "candidate",
      body: "",
      ownerSessionId: fixture.ownerSessionId,
      ownerBindingGeneration: fixture.ownerBindingGeneration,
      exactHeadSha: fixture.head,
    });
    if (!prepared.allowed) throw new Error(prepared.message);

    // The branch moves and the published check is re-pointed at the new head. The gate is
    // now attached to a commit its own payload does not describe.
    const movedHead = "e".repeat(40);
    const check = fixture.github.checkRuns.find((c) => c.name === GATE_CHECK_NAME)!;
    check.head_sha = movedHead;
    const pull = fixture.github.pulls.find((p) => p.number === prepared.value.pullNumber)!;
    pull.head.sha = movedHead;

    const refused = await fixture.harness.cp.github.mergeEvaluate({
      runId: fixture.runId,
      repositoryIdentity: fixture.identity,
      pullNumber: prepared.value.pullNumber,
      exactHeadSha: movedHead,
      expectedBaseSha: fixture.base,
      mergeStrategy: "merge_commit",
      ownerSessionId: fixture.ownerSessionId,
      ownerBindingGeneration: fixture.ownerBindingGeneration,
    });
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.SNAPSHOT_STALE);
  });

  it("CP-S37: a merge with no gate at all is refused, whatever the target branch is", async () => {
    const prepared = await fixture.harness.cp.github.prPrepare({
      runId: fixture.runId,
      repositoryIdentity: fixture.identity,
      head: fixture.workBranch,
      base: "dev",
      title: "candidate",
      body: "",
      ownerSessionId: fixture.ownerSessionId,
      ownerBindingGeneration: fixture.ownerBindingGeneration,
      exactHeadSha: fixture.head,
    });
    if (!prepared.allowed) throw new Error(prepared.message);

    const refused = await fixture.harness.cp.github.mergeEvaluate({
      runId: fixture.runId,
      repositoryIdentity: fixture.identity,
      pullNumber: prepared.value.pullNumber,
      exactHeadSha: fixture.head,
      expectedBaseSha: fixture.base,
      mergeStrategy: "merge_commit",
      ownerSessionId: fixture.ownerSessionId,
      ownerBindingGeneration: fixture.ownerBindingGeneration,
    });
    expect(refused.reasonCode).toBe(ReasonCode.MERGE_GATE_MISSING);
    expect(fixture.github.mergeCount).toBe(0);
  });

  it("gate_publish reports the missing App env file when the credential is absent", async () => {
    const github = new FakeGitHub();
    const bare = makeHarness({ githubClient: github });
    const refused = await bare.cp.github.gatePublish(
      { ...gatePayload(fixture), runId: "run_x" },
      "github:acme/fixture",
    );
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.GITHUB_APP_ENV_FILE_MISSING);
  });
});

describe("merge execution (CP-S38, CP-S39, CP-S40)", () => {
  const prepared = async (fixture: Fixture) => {
    const published = await fixture.harness.cp.github.gatePublish(gatePayload(fixture), fixture.identity);
    if (!published.allowed) throw new Error(published.message);
    const pr = await fixture.harness.cp.github.prPrepare({
      runId: fixture.runId,
      repositoryIdentity: fixture.identity,
      head: fixture.workBranch,
      base: "dev",
      title: "candidate",
      body: "",
      ownerSessionId: fixture.ownerSessionId,
      ownerBindingGeneration: fixture.ownerBindingGeneration,
      exactHeadSha: fixture.head,
    });
    if (!pr.allowed) throw new Error(pr.message);
    return pr.value.pullNumber;
  };

  it("CP-S38: a stale head or base is refused", async () => {
    const fixture = await setup();
    const pullNumber = await prepared(fixture);
    const base = {
      runId: fixture.runId,
      repositoryIdentity: fixture.identity,
      pullNumber,
      mergeStrategy: "merge_commit" as const,
      ownerSessionId: fixture.ownerSessionId,
      ownerBindingGeneration: fixture.ownerBindingGeneration,
    };

    const staleHead = await fixture.harness.cp.github.mergeEvaluate({
      ...base,
      exactHeadSha: "f".repeat(40),
      expectedBaseSha: fixture.base,
    });
    expect(staleHead.reasonCode).toBe(ReasonCode.SNAPSHOT_STALE);

    const staleBase = await fixture.harness.cp.github.mergeEvaluate({
      ...base,
      exactHeadSha: fixture.head,
      expectedBaseSha: "0".repeat(40),
    });
    expect(staleBase.reasonCode).toBe(ReasonCode.SNAPSHOT_STALE);
    expect(fixture.github.mergeCount).toBe(0);
  });

  it("CP-S39: a valid merge happens exactly once and a replay returns the original receipt", async () => {
    const fixture = await setup();
    const pullNumber = await prepared(fixture);
    const input = {
      runId: fixture.runId,
      repositoryIdentity: fixture.identity,
      pullNumber,
      exactHeadSha: fixture.head,
      expectedBaseSha: fixture.base,
      mergeStrategy: "merge_commit" as const,
      ownerSessionId: fixture.ownerSessionId,
      ownerBindingGeneration: fixture.ownerBindingGeneration,
    };

    const first = await fixture.harness.cp.github.mergeExecute(input);
    expect(first.allowed).toBe(true);
    if (!first.allowed) return;
    expect(first.value.replayed).toBe(false);
    expect(fixture.github.mergeCount).toBe(1);

    const replay = await fixture.harness.cp.github.mergeExecute(input);
    expect(replay.allowed).toBe(true);
    if (!replay.allowed) return;
    expect(replay.value.replayed).toBe(true);
    expect(replay.value.mergeCommitSha).toBe(first.value.mergeCommitSha);
    // The decisive assertion: GitHub was not asked to merge a second time.
    expect(fixture.github.mergeCount).toBe(1);
    expect(fixture.harness.cp.audit.byKind("MERGE_REPLAY")).toHaveLength(1);
  });

  it("CP-S40: a failed post-merge check blocks dependent merges and a rollback plan is prepared", async () => {
    const fixture = await setup();
    const pullNumber = await prepared(fixture);
    const merged = await fixture.harness.cp.github.mergeExecute({
      runId: fixture.runId,
      repositoryIdentity: fixture.identity,
      pullNumber,
      exactHeadSha: fixture.head,
      expectedBaseSha: fixture.base,
      mergeStrategy: "merge_commit",
      ownerSessionId: fixture.ownerSessionId,
      ownerBindingGeneration: fixture.ownerBindingGeneration,
    });
    if (!merged.allowed) throw new Error(merged.message);

    fixture.github.setPostMergeCheck(merged.value.mergeCommitSha, "project-ci", "failure");
    const verified = await fixture.harness.cp.github.postMergeVerify(
      fixture.runId,
      fixture.identity,
      merged.value.mergeCommitSha,
      ["project-ci"],
    );
    expect(verified.allowed).toBe(false);
    expect(verified.reasonCode).toBe(ReasonCode.POST_MERGE_VERIFICATION_FAILED);

    const dependent = fixture.harness.cp.github.dependentMergeBlocked(fixture.runId, fixture.identity);
    expect(dependent.allowed).toBe(false);
    expect(dependent.reasonCode).toBe(ReasonCode.DEPENDENT_MERGE_BLOCKED);

    const rollback = fixture.harness.cp.github.rollbackPrepare(
      fixture.runId,
      fixture.identity,
      merged.value.mergeCommitSha,
      "rollback",
    );
    expect(rollback.allowed).toBe(true);
  });

  it("a merged repository blocks dependents while its post-merge is pending (#512)", async () => {
    // CP-S40 above proves the *failure* direction. This is the pending one, and it was open:
    // a merged-but-unverified repository returned `allowed`, folding "not known yet" into
    // "fine" — the CP-HI-08 shape, and the same fold as a delivery timeout recorded as a
    // non-delivery (#451).
    //
    // Correct ordering already came from the finalizer awaiting each postMergeVerify in a
    // sequential loop. That is one caller's property. Measured: deleting the whole gate left
    // the finalizer's two-repository test green, because it observes the order the merges
    // happened in and would observe the same order with no gate at all.
    //
    // The converse — that a verified post-merge *releases* dependents — is not asserted here,
    // and cannot be: this file's fixture declares `approvedDigest: null`, so a post-merge check
    // is always `untrusted` and no trusted pass is reachable. It is covered instead by
    // finalizer.test.ts's two-repository case, which merges the second repository only after the
    // first verifies; that test would fail outright if this gate never released.
    const fixture = await setup();
    const pullNumber = await prepared(fixture);
    const merged = await fixture.harness.cp.github.mergeExecute({
      runId: fixture.runId,
      repositoryIdentity: fixture.identity,
      pullNumber,
      exactHeadSha: fixture.head,
      expectedBaseSha: fixture.base,
      mergeStrategy: "merge_commit",
      ownerSessionId: fixture.ownerSessionId,
      ownerBindingGeneration: fixture.ownerBindingGeneration,
    });
    if (!merged.allowed) throw new Error(merged.message);

    // Merged, and nothing has verified it. Nothing has failed either — the answer is simply
    // not in yet, and that must not read as permission.
    const whilePending = fixture.harness.cp.github.dependentMergeBlocked(
      fixture.runId,
      fixture.identity,
    );
    expect(
      whilePending.allowed,
      "a dependent was released while an earlier repository was merged and unverified",
    ).toBe(false);
    expect(whilePending.reasonCode).toBe(ReasonCode.DEPENDENT_MERGE_BLOCKED);
  });

  it("post-merge verification treats a missing check as a failure, not a pass", async () => {
    const fixture = await setup();
    const pullNumber = await prepared(fixture);
    const merged = await fixture.harness.cp.github.mergeExecute({
      ...{
        runId: fixture.runId,
        repositoryIdentity: fixture.identity,
        pullNumber,
        exactHeadSha: fixture.head,
        expectedBaseSha: fixture.base,
        mergeStrategy: "merge_commit" as const,
        ownerSessionId: fixture.ownerSessionId,
        ownerBindingGeneration: fixture.ownerBindingGeneration,
      },
    });
    if (!merged.allowed) throw new Error(merged.message);
    const verified = await fixture.harness.cp.github.postMergeVerify(
      fixture.runId,
      fixture.identity,
      merged.value.mergeCommitSha,
      ["project-ci"],
    );
    expect(verified.allowed).toBe(false);
    expect(verified.evidence["failed"]).toEqual([{ name: "project-ci", conclusion: "missing" }]);

    // The failed coverage receipt is immutable: a later check cannot rewrite the fact
    // that this run first failed exact post-merge verification.
    fixture.github.setPostMergeCheck(merged.value.mergeCommitSha, "project-ci", "success");
    const replayed = await fixture.harness.cp.github.postMergeVerify(
      fixture.runId,
      fixture.identity,
      merged.value.mergeCommitSha,
      ["project-ci"],
    );
    expect(replayed.reasonCode).toBe(ReasonCode.POST_MERGE_VERIFICATION_FAILED);
    expect(replayed.evidence["failed"]).toEqual([{ name: "project-ci", conclusion: "missing" }]);
  });
});

describe("release and hotfix (CP-S41, CP-S42)", () => {
  it("CP-S41: a tag on an unaccepted commit and a conflicting existing tag are both refused", async () => {
    const fixture = await setupLineageFixture({
      workBranch: "release/1.2.0",
      sourceBranch: "dev",
      baseBranch: "main",
    });
    const notMerged = await fixture.harness.cp.github.releaseTag(
      fixture.runId,
      fixture.identity,
      "1.0.0",
      "1".repeat(40),
      fixture.caller,
    );
    expect(notMerged.allowed).toBe(false);
    expect(notMerged.reasonCode).toBe(ReasonCode.RELEASE_TAG_COMMIT_NOT_ACCEPTED);

    const badSemver = await fixture.harness.cp.github.releaseTag(
      fixture.runId,
      fixture.identity,
      "release-one",
      "1".repeat(40),
      fixture.caller,
    );
    expect(badSemver.reasonCode).toBe(ReasonCode.RELEASE_TAG_SEMVER_MISMATCH);

    const releaseCommit = "r".repeat(40);
    recordAcceptedReleaseMerge(fixture, releaseCommit, 1200);
    const tagged = await fixture.harness.cp.github.releaseTag(
      fixture.runId,
      fixture.identity,
      "1.0.0",
      releaseCommit,
      fixture.caller,
    );
    expect(tagged.reasonCode).toBe(ReasonCode.OK);
    expect(fixture.github.tags).toEqual(new Map([["1.0.0", releaseCommit]]));

    fixture.github.tags.set("1.0.0", "d".repeat(40));
    const duplicate = await fixture.harness.cp.github.releaseTag(
      fixture.runId,
      fixture.identity,
      "1.0.0",
      releaseCommit,
      fixture.caller,
    );
    expect(duplicate.allowed).toBe(false);
    expect(duplicate.reasonCode).toBe(ReasonCode.RELEASE_TAG_DUPLICATE);
    expect(fixture.github.tags.size).toBe(1);
  });

  it("CP-S42: a hotfix missing from an active release reports propagation incomplete", async () => {
    const fixture = await setup();
    fixture.github.setBranch("release/1.1.0", "r".repeat(40));
    const fixSha = "h".repeat(40);
    fixture.github.markContains("main", fixSha);
    fixture.github.markContains("dev", fixSha);
    // release/1.1.0 deliberately does not contain the fix.

    const incomplete = await fixture.harness.cp.github.verifyHotfixPropagation(
      fixture.runId,
      fixture.identity,
      fixSha,
    );
    expect(incomplete.allowed).toBe(false);
    expect(incomplete.reasonCode).toBe(ReasonCode.HOTFIX_PROPAGATION_INCOMPLETE);
    expect(incomplete.evidence["missing"]).toEqual(["release/1.1.0"]);

    fixture.github.markContains("release/1.1.0", fixSha);
    const complete = await fixture.harness.cp.github.verifyHotfixPropagation(
      fixture.runId,
      fixture.identity,
      fixSha,
    );
    expect(complete.allowed).toBe(true);
  });
});

describe("issue projection", () => {
  it("#385: finds a marker past GitHub's first issue page and patches it instead of posting a duplicate", async () => {
    const fixture = await setup();
    for (let number = 1; number <= 100; number += 1) {
      fixture.github.issues.push({ number, title: `noise ${number}`, body: "unrelated" });
    }
    fixture.github.issues.push({
      number: 101,
      title: "stale ticket",
      body: "<!-- acp-ticket:T001 -->\nold body",
    });
    const request = fixture.github.request.bind(fixture.github);
    fixture.github.request = async <T>(
      method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
      path: string,
      body?: unknown,
    ) => {
      if (method === "GET" && /\/issues\?/.test(path)) {
        const page = Number(new URL(path, "https://github.test").searchParams.get("page") ?? "1");
        return fixture.github.issues.slice((page - 1) * 100, page * 100) as T;
      }
      return request<T>(method, path, body);
    };

    const projected = await fixture.harness.cp.github.issueProject(
      fixture.runId,
      fixture.identity,
      [{ id: "T001", title: "current ticket", body: "current body" }],
      fixture.caller,
    );
    expect(projected).toMatchObject({ allowed: true, value: { created: 0, updated: 1 } });
    expect(fixture.github.calls.filter((call) => call.method === "PATCH" && /\/issues\/101$/.test(call.path))).toHaveLength(1);
    expect(fixture.github.calls.filter((call) => call.method === "POST" && /\/issues$/.test(call.path))).toHaveLength(0);
    expect(fixture.github.issues.find((issue) => issue.number === 101)).toMatchObject({
      title: "current ticket",
      body: "<!-- acp-ticket:T001 -->\ncurrent body",
    });
  });

  it("syncs idempotently by marker rather than creating duplicates", async () => {
    const fixture = await setup();
    const tickets = [{ id: "T001", title: "first", body: "do the thing" }];

    const first = await fixture.harness.cp.github.issueProject(fixture.runId, fixture.identity, tickets, fixture.caller);
    expect(first.allowed && first.value).toEqual({ created: 1, updated: 0 });

    const second = await fixture.harness.cp.github.issueProject(
      fixture.runId,
      fixture.identity,
      [{ id: "T001", title: "first, retitled", body: "do the thing" }],
      fixture.caller,
    );
    expect(second.allowed && second.value).toEqual({ created: 0, updated: 1 });
    expect(fixture.github.issues).toHaveLength(1);
    expect(fixture.github.issues[0]?.title).toBe("first, retitled");
    expect(fixture.github.issues[0]?.body).toContain("<!-- acp-ticket:T001 -->");

    // Both projections are recorded as completed reservations: the receipt table refuses a
    // receipt that was not reserved before its external write (#76).
    const receipts = fixture.harness.cp.db.all<{ status: string; verified: number; reread_at: string | null }>(
      `SELECT status, verified, reread_at FROM github_receipts WHERE operation = 'issue_project'`,
    );
    expect(receipts).toHaveLength(2);
    for (const receipt of receipts) {
      expect(receipt.status).toBe("APPLIED");
      expect(receipt.verified).toBe(1);
      expect(receipt.reread_at).not.toBeNull();
    }
  });

  it("#76: reserves the projection receipt before the first issue write", async () => {
    const fixture = await setup();
    const statusAtWrite: Array<string | undefined> = [];
    const original = fixture.github.request.bind(fixture.github);
    fixture.github.request = async (method, path, body) => {
      if (method === "POST" && /\/issues$/.test(path)) {
        statusAtWrite.push(
          fixture.harness.cp.db.get<{ status: string }>(
            `SELECT status FROM github_receipts WHERE operation = 'issue_project'`,
          )?.status,
        );
      }
      return original(method, path, body);
    };
    const tickets = [{ id: "T001", title: "first", body: "do the thing" }];

    const projected = await fixture.harness.cp.github.issueProject(
      fixture.runId,
      fixture.identity,
      tickets,
      fixture.caller,
    );
    expect(projected.reasonCode).toBe(ReasonCode.OK);
    expect(statusAtWrite).toEqual(["PENDING"]);

    // The same ticket set replays from the completed receipt instead of writing again.
    const replayed = await fixture.harness.cp.github.issueProject(
      fixture.runId,
      fixture.identity,
      tickets,
      fixture.caller,
    );
    expect(replayed.reasonCode).toBe(ReasonCode.MERGE_IDEMPOTENT_REPLAY);
    expect(replayed.allowed && replayed.value).toEqual({ created: 1, updated: 0 });
    expect(fixture.github.calls.filter((call) => call.method === "POST" && /\/issues$/.test(call.path))).toHaveLength(1);
  });

  it("#76: a projection GitHub did not persist is refused and its reservation stays open", async () => {
    const fixture = await setup();
    const original = fixture.github.request.bind(fixture.github);
    let written = 0;
    fixture.github.request = async (method, path, body) => {
      // GitHub acknowledges the create but holds something else, which only the reread after
      // the write can reveal: an acknowledgement is not evidence.
      if (written > 0 && method === "GET" && /\/issues\?/.test(path)) {
        fixture.github.issues.at(-1)!.title = "not what was sent";
      }
      if (method === "POST" && /\/issues$/.test(path)) written += 1;
      return original(method, path, body);
    };

    const refused = await fixture.harness.cp.github.issueProject(
      fixture.runId,
      fixture.identity,
      [{ id: "T001", title: "first", body: "do the thing" }],
      fixture.caller,
    );
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.ISSUE_PROJECTION_UNVERIFIED);
    // The write did happen, so the reservation is kept as the record of a projection that
    // still has to be reconciled: it is neither deleted nor completed unverified.
    expect(
      fixture.harness.cp.db.get<{ status: string; verified: number }>(
        `SELECT status, verified FROM github_receipts WHERE operation = 'issue_project'`,
      ),
    ).toMatchObject({ status: "PENDING", verified: 0 });
  });
});

describe("crash and acknowledgement recovery", () => {
  it("#336: stale absent PR, gate and merge reservations are reclaimed after restart", async () => {
    const prFixture = await setup();
    const preparedInput = prepareInput(prFixture);
    const prBody = `\n\n<!-- acp-run:${prFixture.runId} -->`;
    const prRequestDigest = digestOf({
      runId: preparedInput.runId,
      repositoryIdentity: preparedInput.repositoryIdentity,
      head: preparedInput.head,
      base: preparedInput.base,
      exactHeadSha: preparedInput.exactHeadSha,
      expectedBaseSha: prFixture.base,
      candidateSnapshotDigest: prFixture.payload.candidateSnapshotDigest,
      sourceBranch: "dev",
      sourceHead: prFixture.base,
      title: preparedInput.title,
      body: prBody,
      declaredParent: null,
      linkedIssues: [],
      ownerBindingGeneration: preparedInput.ownerBindingGeneration,
    });
    reservePendingReceipt(prFixture, {
      receiptId: "rcp_pending_pr_absent",
      idempotencyKey: `pr_prepare:${prFixture.identity}:${prFixture.workBranch}:dev`,
      operation: "pr_prepare",
      resourceType: "pull_request",
      resourceIdentity: `acme/fixture@${prFixture.workBranch}->dev`,
      beforeStateDigest: null,
      requestDigest: prRequestDigest,
    });
    const prepared = await prFixture.harness.cp.github.prPrepare(preparedInput);
    expect(prepared.reasonCode).toBe(ReasonCode.OK);
    expect(prFixture.github.pulls).toHaveLength(1);

    const gateFixture = await setup();
    const payloadDigest = digestOf(gateFixture.payload);
    reservePendingReceipt(gateFixture, {
      receiptId: "rcp_pending_gate_absent",
      idempotencyKey: `gate_publish:${gateFixture.identity}:${gateFixture.head}:${payloadDigest}`,
      operation: "gate_publish",
      resourceType: "check_run",
      resourceIdentity: `acme/fixture@${gateFixture.head}/acp-production-gate`,
      beforeStateDigest: null,
      requestDigest: payloadDigest,
    });
    const published = await gateFixture.harness.cp.github.gatePublish(gateFixture.payload, gateFixture.identity);
    expect(published.reasonCode).toBe(ReasonCode.OK);
    expect(gateFixture.github.checkRuns.filter((check) => check.name === GATE_CHECK_NAME)).toHaveLength(1);

    const mergeFixture = await setup();
    const gate = await mergeFixture.harness.cp.github.gatePublish(mergeFixture.payload, mergeFixture.identity);
    if (!gate.allowed) throw new Error(gate.message);
    const pr = await mergeFixture.harness.cp.github.prPrepare(prepareInput(mergeFixture));
    if (!pr.allowed) throw new Error(pr.message);
    const input = mergeInput(mergeFixture, pr.value.pullNumber);
    reservePendingReceipt(mergeFixture, {
      receiptId: "rcp_pending_merge_absent",
      idempotencyKey: `merge_execute:${mergeFixture.identity}:${pr.value.pullNumber}`,
      operation: "merge_execute",
      resourceType: "merge",
      resourceIdentity: `acme/fixture#${pr.value.pullNumber}`,
      beforeStateDigest: digestOf({ head: mergeFixture.head, base: mergeFixture.base }),
      requestDigest: digestOf({
        runId: input.runId,
        repositoryIdentity: input.repositoryIdentity,
        pullNumber: input.pullNumber,
        exactHeadSha: input.exactHeadSha,
        expectedBaseSha: input.expectedBaseSha,
        mergeStrategy: input.mergeStrategy,
        ownerBindingGeneration: input.ownerBindingGeneration,
      }),
    });
    const merged = await mergeFixture.harness.cp.github.mergeExecute(input);
    expect(merged.reasonCode).toBe(ReasonCode.OK);
    expect(mergeFixture.github.mergeCount).toBe(1);
  });

  it("#343: blank mutating acknowledgements stay pending instead of throwing or releasing", async () => {
    const gateFixture = await setup();
    const gateRequest = gateFixture.github.request.bind(gateFixture.github);
    gateFixture.github.request = async (method, path, body) => {
      if (method === "POST" && path.endsWith("/check-runs")) {
        await gateRequest(method, path, body);
        return null as never;
      }
      return gateRequest(method, path, body);
    };
    const blankGate = await gateFixture.harness.cp.github.gatePublish(gateFixture.payload, gateFixture.identity);
    expect(blankGate.reasonCode).toBe(ReasonCode.EVIDENCE_MISSING);
    expect(gateFixture.github.checkRuns).toHaveLength(1);
    expect(
      gateFixture.harness.cp.db.get<{ status: string; verified: number }>(
        `SELECT status, verified FROM github_receipts WHERE operation = 'gate_publish'`,
      ),
    ).toEqual({ status: "PENDING", verified: 0 });

    const mergeFixture = await setup();
    const gate = await mergeFixture.harness.cp.github.gatePublish(mergeFixture.payload, mergeFixture.identity);
    if (!gate.allowed) throw new Error(gate.message);
    const pr = await mergeFixture.harness.cp.github.prPrepare(prepareInput(mergeFixture));
    if (!pr.allowed) throw new Error(pr.message);
    const mergeRequest = mergeFixture.github.request.bind(mergeFixture.github);
    mergeFixture.github.request = async (method, path, body) => {
      if (method === "PUT" && path.endsWith("/merge")) {
        await mergeRequest(method, path, body);
        return null as never;
      }
      return mergeRequest(method, path, body);
    };
    const blankMerge = await mergeFixture.harness.cp.github.mergeExecute(
      mergeInput(mergeFixture, pr.value.pullNumber),
    );
    expect(blankMerge.reasonCode).toBe(ReasonCode.EVIDENCE_MISSING);
    expect(mergeFixture.github.mergeCount).toBe(1);
    expect(
      mergeFixture.harness.cp.db.get<{ status: string; verified: number }>(
        `SELECT status, verified FROM github_receipts WHERE operation = 'merge_execute'`,
      ),
    ).toEqual({ status: "PENDING", verified: 0 });
    expect(
      mergeFixture.harness.cp.runs
        .repositoriesOf(mergeFixture.runId)
        .find((entry) => entry.identity === mergeFixture.identity)?.mergeState,
    ).toBe("FAILED");
  });
});

describe("merge target proof (#350)", () => {
  const openPreparedPull = async (fixture: Fixture) => {
    const gate = await fixture.harness.cp.github.gatePublish(gatePayload(fixture), fixture.identity);
    if (!gate.allowed) throw new Error(gate.message);
    const pr = await fixture.harness.cp.github.prPrepare(prepareInput(fixture));
    if (!pr.allowed) throw new Error(pr.message);
    return pr.value.pullNumber;
  };

  const expectPendingMergeProof = (fixture: Fixture): void => {
    expect(
      fixture.harness.cp.db.get<{ status: string; verified: number }>(
        `SELECT status, verified FROM github_receipts WHERE operation = 'merge_execute'`,
      ),
    ).toEqual({ status: "PENDING", verified: 0 });
    expect(
      fixture.harness.cp.db.get<{ count: number }>(
        `SELECT COUNT(*) AS count FROM github_receipts WHERE operation = 'rollback_prepare'`,
      )?.count,
    ).toBe(0);
  };

  it("blocks a same-SHA PR base retarget in preflight before GitHub merges", async () => {
    const fixture = await setup();
    const pullNumber = await openPreparedPull(fixture);
    fixture.github.setBranch("other", fixture.base);
    const pull = fixture.github.pulls.find((entry) => entry.number === pullNumber)!;
    const request = fixture.github.request.bind(fixture.github);
    let pullReads = 0;
    fixture.github.request = async (method, path, body) => {
      if (method === "GET" && path.endsWith(`/pulls/${pullNumber}`) && ++pullReads === 2) {
        pull.base = { ref: "other", sha: fixture.base };
      }
      return request(method, path, body);
    };

    const refused = await fixture.harness.cp.github.mergeExecute(mergeInput(fixture, pullNumber));
    expect(refused.reasonCode).toBe(ReasonCode.MERGE_BRANCH_PROFILE_UNSATISFIED);
    expect(fixture.github.mergeCount).toBe(0);
    expect(fixture.github.calls.filter((call) => call.method === "PUT" && call.path.endsWith("/merge"))).toHaveLength(0);
  });

  it("fails an executed retarget and clears its local reservation for reconciliation", async () => {
    const fixture = await setup();
    const pullNumber = await openPreparedPull(fixture);
    fixture.github.setBranch("other", fixture.base);
    const pull = fixture.github.pulls.find((entry) => entry.number === pullNumber)!;
    const request = fixture.github.request.bind(fixture.github);
    fixture.github.request = async (method, path, body) => {
      if (method === "PUT" && path.endsWith("/merge")) {
        // The retarget occurs after the last preflight but before the remote merge; `other`
        // still starts at A, so first-parent-only proof would falsely accept this write.
        pull.base = { ref: "other", sha: fixture.base };
      }
      return request(method, path, body);
    };

    const input = mergeInput(fixture, pullNumber);
    const first = await fixture.harness.cp.github.mergeExecute(input);
    expect(first.reasonCode).toBe(ReasonCode.MERGE_BASE_STALE);
    expect(fixture.github.mergeCount).toBe(1);
    expect(
      fixture.harness.cp.db.get<{ status: string; verified: number }>(
        `SELECT status, verified FROM github_receipts WHERE operation = 'merge_execute'`,
      ),
    ).toEqual({ status: "PENDING", verified: 0 });
    expect(
      fixture.harness.cp.runs.repositoriesOf(fixture.runId).find((entry) => entry.identity === fixture.identity)
        ?.mergeState,
    ).toBe("FAILED");

    // The durable receipt stays PENDING, but the in-process reservation must be released so
    // this call reaches the reconcile proof instead of returning RESOURCE_COLLISION. Model a
    // restart-era PENDING state as well: reconciliation must independently fail closed.
    const repository = fixture.harness.cp.runs
      .repositoriesOf(fixture.runId)
      .find((entry) => entry.identity === fixture.identity)!;
    fixture.harness.cp.runs.setRepositoryMergeState(fixture.runId, repository.repositoryId, "PENDING");
    const reconciled = await fixture.harness.cp.github.mergeExecute(input);
    expect(reconciled.reasonCode).toBe(ReasonCode.MERGE_BASE_STALE);
    expect(fixture.github.mergeCount).toBe(1);
    expect(
      fixture.harness.cp.runs.repositoriesOf(fixture.runId).find((entry) => entry.identity === fixture.identity)
        ?.mergeState,
    ).toBe("FAILED");
  });

  it("keeps a known unequal target generation pending without another merge", async () => {
    const fixture = await setup();
    const pullNumber = await openPreparedPull(fixture);
    const pull = fixture.github.pulls.find((entry) => entry.number === pullNumber)!;
    const request = fixture.github.request.bind(fixture.github);
    fixture.github.request = async <T>(
      method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
      path: string,
      body?: unknown,
    ): Promise<T> => {
      const response = await request<T>(method, path, body);
      if (method === "PUT" && path.endsWith("/merge")) {
        // A target-branch write immediately after the merge acknowledgement must not be
        // mistaken for the acknowledged merge still being the target ref's tip.
        fixture.github.setBranch("dev", fixture.base);
        pull.base.sha = fixture.base;
      }
      return response;
    };

    const input = mergeInput(fixture, pullNumber);
    const refused = await fixture.harness.cp.github.mergeExecute(input);
    expect(refused.reasonCode).toBe(ReasonCode.MERGE_BASE_STALE);
    if (refused.allowed) throw new Error("expected unequal target proof to be denied");
    expect(refused.evidence).toMatchObject({ expected: pull.merge_commit_sha, observed: fixture.base });
    expect(fixture.github.mergeCount).toBe(1);
    expectPendingMergeProof(fixture);

    const reconciled = await fixture.harness.cp.github.mergeExecute(input);
    expect(reconciled.reasonCode).toBe(ReasonCode.MERGE_BASE_STALE);
    expect(fixture.github.mergeCount).toBe(1);
    expect(fixture.github.calls.filter((call) => call.method === "PUT" && call.path.endsWith("/merge"))).toHaveLength(1);
    expectPendingMergeProof(fixture);
  });

  it("reports a missing postflight merge SHA as evidence missing", async () => {
    const fixture = await setup();
    const pullNumber = await openPreparedPull(fixture);
    const pull = fixture.github.pulls.find((entry) => entry.number === pullNumber)!;
    const request = fixture.github.request.bind(fixture.github);
    fixture.github.request = async <T>(
      method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
      path: string,
      body?: unknown,
    ): Promise<T> => {
      const response = await request<T>(method, path, body);
      if (method === "PUT" && path.endsWith("/merge")) pull.merge_commit_sha = null;
      return response;
    };

    const refused = await fixture.harness.cp.github.mergeExecute(mergeInput(fixture, pullNumber));
    expect(refused.reasonCode).toBe(ReasonCode.EVIDENCE_MISSING);
    expect(refused.reasonCode).not.toBe(ReasonCode.MERGE_BASE_STALE);
    expect(fixture.github.mergeCount).toBe(1);
    expectPendingMergeProof(fixture);
  });

  it("reports a missing target-ref SHA as evidence missing", async () => {
    const fixture = await setup();
    const pullNumber = await openPreparedPull(fixture);
    const request = fixture.github.request.bind(fixture.github);
    fixture.github.request = async <T>(
      method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
      path: string,
      body?: unknown,
    ): Promise<T> => {
      if (method === "GET" && path.includes("/git/ref/heads/dev")) return { object: {} } as T;
      return request<T>(method, path, body);
    };

    const refused = await fixture.harness.cp.github.mergeExecute(mergeInput(fixture, pullNumber));
    expect(refused.reasonCode).toBe(ReasonCode.EVIDENCE_MISSING);
    expect(refused.reasonCode).not.toBe(ReasonCode.MERGE_BASE_STALE);
    expect(fixture.github.mergeCount).toBe(1);
    expectPendingMergeProof(fixture);
  });

  it("reconciles a failed postflight pull probe without repeating the merge", async () => {
    const fixture = await setup();
    const pullNumber = await openPreparedPull(fixture);
    const request = fixture.github.request.bind(fixture.github);
    let failPostflightPull = false;
    fixture.github.request = async <T>(
      method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
      path: string,
      body?: unknown,
    ): Promise<T> => {
      if (failPostflightPull && method === "GET" && path.endsWith(`/pulls/${pullNumber}`)) {
        failPostflightPull = false;
        throw new Error("sensitive transport detail");
      }
      const response = await request<T>(method, path, body);
      if (method === "PUT" && path.endsWith("/merge")) failPostflightPull = true;
      return response;
    };

    const input = mergeInput(fixture, pullNumber);
    const unavailable = await fixture.harness.cp.github.mergeExecute(input);
    expect(unavailable.reasonCode).toBe(ReasonCode.PROBE_FAILED);
    expect(unavailable.reasonCode).not.toBe(ReasonCode.MERGE_BASE_STALE);
    if (unavailable.allowed) throw new Error("expected failed postflight pull probe to be denied");
    expect(unavailable.evidence).toMatchObject({ phase: "postflight-pull", pullNumber });
    expect(unavailable.evidence).not.toHaveProperty("error");
    expect(fixture.github.mergeCount).toBe(1);
    expectPendingMergeProof(fixture);

    const reconciled = await fixture.harness.cp.github.mergeExecute(input);
    expect(reconciled.reasonCode).toBe(ReasonCode.MERGE_IDEMPOTENT_REPLAY);
    expect(fixture.github.mergeCount).toBe(1);
    expect(fixture.github.calls.filter((call) => call.method === "PUT" && call.path.endsWith("/merge"))).toHaveLength(1);
    expect(
      fixture.harness.cp.db.get<{ status: string; verified: number }>(
        `SELECT status, verified FROM github_receipts WHERE operation = 'merge_execute'`,
      ),
    ).toEqual({ status: "APPLIED", verified: 1 });
  });

  it("treats a null postflight pull read as a probe failure", async () => {
    const fixture = await setup();
    const pullNumber = await openPreparedPull(fixture);
    const request = fixture.github.request.bind(fixture.github);
    let nullPostflightPull = false;
    fixture.github.request = async <T>(
      method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
      path: string,
      body?: unknown,
    ): Promise<T> => {
      if (nullPostflightPull && method === "GET" && path.endsWith(`/pulls/${pullNumber}`)) {
        nullPostflightPull = false;
        return null as T;
      }
      const response = await request<T>(method, path, body);
      if (method === "PUT" && path.endsWith("/merge")) nullPostflightPull = true;
      return response;
    };

    const unavailable = await fixture.harness.cp.github.mergeExecute(mergeInput(fixture, pullNumber));
    expect(unavailable.reasonCode).toBe(ReasonCode.PROBE_FAILED);
    expect(unavailable.reasonCode).not.toBe(ReasonCode.MERGE_BASE_STALE);
    if (unavailable.allowed) throw new Error("expected null postflight pull read to be denied");
    expect(unavailable.evidence).toMatchObject({ phase: "postflight-pull", pullNumber });
    expect(unavailable.evidence).not.toHaveProperty("error");
    expect(fixture.github.mergeCount).toBe(1);
    expectPendingMergeProof(fixture);
  });

  it.each([
    { label: "exception", outcome: "exception" as const },
    { label: "null", outcome: "null" as const },
  ])("keeps a PENDING replay whose pull probe returns $label reconcilable", async ({ outcome }) => {
      const fixture = await setup();
      const pullNumber = await openPreparedPull(fixture);
      const request = fixture.github.request.bind(fixture.github);
      let seedPending = true;
      let failReplayPull = false;
      fixture.github.request = async <T>(
        method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
        path: string,
        body?: unknown,
      ): Promise<T> => {
        if (failReplayPull && method === "GET" && path.endsWith(`/pulls/${pullNumber}`)) {
          failReplayPull = false;
          if (outcome === "exception") throw new Error("sensitive reconciliation transport detail");
          return null as T;
        }
        if (seedPending && method === "GET" && path.includes("/git/ref/heads/dev")) {
          seedPending = false;
          failReplayPull = true;
          return { object: {} } as T;
        }
        return request<T>(method, path, body);
      };

      const input = mergeInput(fixture, pullNumber);
      const pending = await fixture.harness.cp.github.mergeExecute(input);
      expect(pending.reasonCode).toBe(ReasonCode.EVIDENCE_MISSING);
      expectPendingMergeProof(fixture);

      const unavailable = await fixture.harness.cp.github.mergeExecute(input);
      expect(unavailable.reasonCode).toBe(ReasonCode.PROBE_FAILED);
      if (unavailable.allowed) throw new Error("expected replay pull probe to be denied");
      expect(unavailable.evidence).toMatchObject({ phase: "reconcile-pull", pullNumber });
      expect(unavailable.evidence).not.toHaveProperty("error");
      expect(fixture.github.mergeCount).toBe(1);
      expect(fixture.github.calls.filter((call) => call.method === "PUT" && call.path.endsWith("/merge"))).toHaveLength(1);
      expectPendingMergeProof(fixture);
      expect(fixture.harness.cp.audit.byKind("MERGE_BASE_DRIFT").at(-1)?.reasonCode).toBe(ReasonCode.PROBE_FAILED);

      const reconciled = await fixture.harness.cp.github.mergeExecute(input);
      expect(reconciled.reasonCode).toBe(ReasonCode.MERGE_IDEMPOTENT_REPLAY);
      expect(fixture.github.mergeCount).toBe(1);
      expect(fixture.github.calls.filter((call) => call.method === "PUT" && call.path.endsWith("/merge"))).toHaveLength(1);
      expect(
        fixture.harness.cp.db.get<{ status: string; verified: number }>(
          `SELECT status, verified FROM github_receipts WHERE operation = 'merge_execute'`,
        ),
      ).toEqual({ status: "APPLIED", verified: 1 });
  });

  it.each([
    { label: "missing", merged: undefined },
    { label: "nonboolean", merged: "yes" },
  ])("keeps replay merged=$label as missing evidence without another PUT", async ({ merged }) => {
    const fixture = await setup();
    const pullNumber = await openPreparedPull(fixture);
    const request = fixture.github.request.bind(fixture.github);
    let seedPending = true;
    let alterReplayPull = false;
    fixture.github.request = async <T>(
      method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
      path: string,
      body?: unknown,
    ): Promise<T> => {
      if (alterReplayPull && method === "GET" && path.endsWith(`/pulls/${pullNumber}`)) {
        alterReplayPull = false;
        const response = await request<T>(method, path, body);
        const unreadable = { ...(response as object), merged };
        if (merged === undefined) delete unreadable.merged;
        return unreadable as T;
      }
      if (seedPending && method === "GET" && path.includes("/git/ref/heads/dev")) {
        seedPending = false;
        alterReplayPull = true;
        return { object: {} } as T;
      }
      return request<T>(method, path, body);
    };

    const input = mergeInput(fixture, pullNumber);
    const pending = await fixture.harness.cp.github.mergeExecute(input);
    expect(pending.reasonCode).toBe(ReasonCode.EVIDENCE_MISSING);
    const unavailable = await fixture.harness.cp.github.mergeExecute(input);
    expect(unavailable.reasonCode).toBe(ReasonCode.EVIDENCE_MISSING);
    expect(fixture.github.mergeCount).toBe(1);
    expect(fixture.github.calls.filter((call) => call.method === "PUT" && call.path.endsWith("/merge"))).toHaveLength(1);
    expectPendingMergeProof(fixture);
    expect(fixture.harness.cp.audit.byKind("MERGE_BASE_DRIFT").at(-1)?.reasonCode).toBe(ReasonCode.EVIDENCE_MISSING);
  });

  it.each([
    { label: "missing merge SHA", field: "merge" as const, value: undefined, reasonCode: ReasonCode.EVIDENCE_MISSING },
    { label: "blank merge SHA", field: "merge" as const, value: "  ", reasonCode: ReasonCode.EVIDENCE_MISSING },
    { label: "missing head SHA", field: "head" as const, value: undefined, reasonCode: ReasonCode.EVIDENCE_MISSING },
    { label: "blank head SHA", field: "head" as const, value: "  ", reasonCode: ReasonCode.EVIDENCE_MISSING },
    { label: "unequal head SHA", field: "head" as const, value: "7".repeat(40), reasonCode: ReasonCode.MERGE_HEAD_STALE },
  ])("classifies PENDING replay $label without collision or another PUT", async ({ field, value, reasonCode }) => {
    const fixture = await setup();
    const pullNumber = await openPreparedPull(fixture);
    const request = fixture.github.request.bind(fixture.github);
    let seedPending = true;
    let alterReplayPull = false;
    fixture.github.request = async <T>(
      method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
      path: string,
      body?: unknown,
    ): Promise<T> => {
      if (alterReplayPull && method === "GET" && path.endsWith(`/pulls/${pullNumber}`)) {
        alterReplayPull = false;
        const response = await request<T>(method, path, body);
        const observed = { ...(response as object) } as {
          merge_commit_sha?: unknown;
          head?: { ref?: unknown; sha?: unknown };
        };
        if (field === "merge") {
          observed.merge_commit_sha = value;
          if (value === undefined) delete observed.merge_commit_sha;
        } else {
          observed.head = { ...(observed.head ?? {}), sha: value };
          if (value === undefined) delete observed.head.sha;
        }
        return observed as T;
      }
      if (seedPending && method === "GET" && path.includes("/git/ref/heads/dev")) {
        seedPending = false;
        alterReplayPull = true;
        return { object: {} } as T;
      }
      return request<T>(method, path, body);
    };

    const input = mergeInput(fixture, pullNumber);
    const pending = await fixture.harness.cp.github.mergeExecute(input);
    expect(pending.reasonCode).toBe(ReasonCode.EVIDENCE_MISSING);
    const unavailable = await fixture.harness.cp.github.mergeExecute(input);
    expect(unavailable.reasonCode).toBe(reasonCode);
    expect(unavailable.reasonCode).not.toBe(ReasonCode.RESOURCE_COLLISION);
    if (!unavailable.allowed && reasonCode === ReasonCode.MERGE_HEAD_STALE) {
      expect(unavailable.evidence).toMatchObject({ expected: fixture.head, observed: value });
    }
    expect(fixture.github.mergeCount).toBe(1);
    expect(fixture.github.calls.filter((call) => call.method === "PUT" && call.path.endsWith("/merge"))).toHaveLength(1);
    expectPendingMergeProof(fixture);
  });

  it("keeps a PENDING merge with no prepared contract and does not prepare a halt", async () => {
    const fixture = await setup();
    const pullNumber = 999;
    const input = mergeInput(fixture, pullNumber);
    const mergeCommitSha = "merge-without-prepare".padEnd(40, "0");
    fixture.github.pulls.push({
      number: pullNumber,
      head: { ref: fixture.workBranch, sha: fixture.head },
      base: { ref: "dev", sha: fixture.base },
      merged: true,
      state: "closed",
      html_url: "https://github.test/pull/999",
      merge_commit_sha: mergeCommitSha,
    });
    fixture.github.commitParents.set(mergeCommitSha, [fixture.base, fixture.head]);
    fixture.github.setBranch("dev", mergeCommitSha);
    const idempotencyKey = `merge_execute:${fixture.identity}:${pullNumber}`;
    reservePendingReceipt(fixture, {
      receiptId: "rcp_merge_without_prepare",
      idempotencyKey,
      operation: "merge_execute",
      resourceType: "merge",
      resourceIdentity: `acme/fixture#${pullNumber}`,
      beforeStateDigest: digestOf({ head: fixture.head, base: fixture.base }),
      requestDigest: digestOf({
        runId: input.runId,
        repositoryIdentity: input.repositoryIdentity,
        pullNumber: input.pullNumber,
        exactHeadSha: input.exactHeadSha,
        expectedBaseSha: input.expectedBaseSha,
        mergeStrategy: input.mergeStrategy,
        ownerBindingGeneration: input.ownerBindingGeneration,
      }),
    });

    const unavailable = await fixture.harness.cp.github.mergeExecute(input);
    expect(unavailable.reasonCode).toBe(ReasonCode.EVIDENCE_MISSING);
    expect(fixture.github.calls.filter((call) => call.method === "PUT" && call.path.endsWith("/merge"))).toHaveLength(0);
    expectPendingMergeProof(fixture);
    expect(fixture.harness.cp.audit.byKind("MERGE_BASE_DRIFT").at(-1)?.reasonCode).toBe(ReasonCode.EVIDENCE_MISSING);
  });

  it("reclaims a PENDING receipt only after a fresh pull read reports merged=false", async () => {
    const fixture = await setup();
    const pullNumber = await openPreparedPull(fixture);
    const request = fixture.github.request.bind(fixture.github);
    let putAttempts = 0;
    fixture.github.request = async <T>(
      method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
      path: string,
      body?: unknown,
    ): Promise<T> => {
      if (method === "PUT" && path.endsWith("/merge") && ++putAttempts === 1) return {} as T;
      return request<T>(method, path, body);
    };

    const input = mergeInput(fixture, pullNumber);
    const pending = await fixture.harness.cp.github.mergeExecute(input);
    expect(pending.reasonCode).toBe(ReasonCode.EVIDENCE_MISSING);
    expect(fixture.github.mergeCount).toBe(0);
    expectPendingMergeProof(fixture);

    const retried = await fixture.harness.cp.github.mergeExecute(input);
    expect(retried.reasonCode).toBe(ReasonCode.OK);
    expect(putAttempts).toBe(2);
    expect(fixture.github.mergeCount).toBe(1);
    expect(
      fixture.harness.cp.db.get<{ status: string; verified: number }>(
        `SELECT status, verified FROM github_receipts WHERE operation = 'merge_execute'`,
      ),
    ).toEqual({ status: "APPLIED", verified: 1 });
  });

  it.each([
    { label: "missing", merged: undefined },
    { label: "nonboolean", merged: "yes" },
  ])("treats after-PUT merged=$label as missing evidence", async ({ merged }) => {
    const fixture = await setup();
    const pullNumber = await openPreparedPull(fixture);
    const pull = fixture.github.pulls.find((entry) => entry.number === pullNumber)!;
    const request = fixture.github.request.bind(fixture.github);
    fixture.github.request = async <T>(
      method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
      path: string,
      body?: unknown,
    ): Promise<T> => {
      const response = await request<T>(method, path, body);
      if (method === "PUT" && path.endsWith("/merge")) {
        const observed = pull as unknown as { merged?: unknown };
        observed.merged = merged;
        if (merged === undefined) delete observed.merged;
      }
      return response;
    };

    const unavailable = await fixture.harness.cp.github.mergeExecute(mergeInput(fixture, pullNumber));
    expect(unavailable.reasonCode).toBe(ReasonCode.EVIDENCE_MISSING);
    expect(unavailable.reasonCode).not.toBe(ReasonCode.MERGE_BASE_STALE);
    expect(fixture.github.mergeCount).toBe(1);
    expectPendingMergeProof(fixture);
  });

  it.each([
    { label: "missing", field: "ref", value: undefined, reasonCode: ReasonCode.EVIDENCE_MISSING },
    { label: "blank", field: "ref", value: "  ", reasonCode: ReasonCode.EVIDENCE_MISSING },
    { label: "unequal", field: "ref", value: "other", reasonCode: ReasonCode.MERGE_BASE_STALE },
    { label: "missing", field: "sha", value: undefined, reasonCode: ReasonCode.EVIDENCE_MISSING },
    { label: "blank", field: "sha", value: "  ", reasonCode: ReasonCode.EVIDENCE_MISSING },
    { label: "unequal", field: "sha", value: "7".repeat(40), reasonCode: ReasonCode.MERGE_BASE_STALE },
  ])("classifies after-PUT base $field=$label without unbound staleness", async ({ field, value, reasonCode }) => {
    const fixture = await setup();
    const pullNumber = await openPreparedPull(fixture);
    const pull = fixture.github.pulls.find((entry) => entry.number === pullNumber)!;
    const request = fixture.github.request.bind(fixture.github);
    fixture.github.request = async <T>(
      method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
      path: string,
      body?: unknown,
    ): Promise<T> => {
      const response = await request<T>(method, path, body);
      if (method === "PUT" && path.endsWith("/merge")) {
        const base = pull.base as unknown as { ref?: unknown; sha?: unknown };
        base[field as "ref" | "sha"] = value;
        if (value === undefined) delete base[field as "ref" | "sha"];
      }
      return response;
    };

    const unavailable = await fixture.harness.cp.github.mergeExecute(mergeInput(fixture, pullNumber));
    expect(unavailable.reasonCode).toBe(reasonCode);
    if (unavailable.allowed) throw new Error("expected after-PUT base proof to be denied");
    if (reasonCode === ReasonCode.MERGE_BASE_STALE) {
      expect(unavailable.evidence).toMatchObject({
        expected: field === "ref" ? "dev" : fixture.base,
        observed: value,
      });
    }
    expect(fixture.github.mergeCount).toBe(1);
    expectPendingMergeProof(fixture);
  });

  it("treats an unreadable target ref as a probe failure", async () => {
    const fixture = await setup();
    const pullNumber = await openPreparedPull(fixture);
    const request = fixture.github.request.bind(fixture.github);
    fixture.github.request = async <T>(
      method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
      path: string,
      body?: unknown,
    ): Promise<T> => {
      if (method === "GET" && path.includes("/git/ref/heads/dev")) {
        throw new Error("sensitive target transport detail");
      }
      return request<T>(method, path, body);
    };

    const unavailable = await fixture.harness.cp.github.mergeExecute(mergeInput(fixture, pullNumber));
    expect(unavailable.reasonCode).toBe(ReasonCode.PROBE_FAILED);
    expect(unavailable.reasonCode).not.toBe(ReasonCode.MERGE_BASE_STALE);
    if (unavailable.allowed) throw new Error("expected unreadable target ref to be denied");
    expect(unavailable.evidence).toMatchObject({ phase: "postflight-target-ref", baseRef: "dev" });
    expect(unavailable.evidence).not.toHaveProperty("error");
    expect(fixture.github.mergeCount).toBe(1);
    expectPendingMergeProof(fixture);
  });

  it("treats a null target-ref read as a probe failure", async () => {
    const fixture = await setup();
    const pullNumber = await openPreparedPull(fixture);
    const request = fixture.github.request.bind(fixture.github);
    fixture.github.request = async <T>(
      method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
      path: string,
      body?: unknown,
    ): Promise<T> => {
      if (method === "GET" && path.includes("/git/ref/heads/dev")) return null as T;
      return request<T>(method, path, body);
    };

    const unavailable = await fixture.harness.cp.github.mergeExecute(mergeInput(fixture, pullNumber));
    expect(unavailable.reasonCode).toBe(ReasonCode.PROBE_FAILED);
    expect(unavailable.reasonCode).not.toBe(ReasonCode.MERGE_BASE_STALE);
    if (unavailable.allowed) throw new Error("expected null target-ref read to be denied");
    expect(unavailable.evidence).toMatchObject({
      phase: "postflight-target-ref",
      baseRef: "dev",
      observed: null,
    });
    expect(unavailable.evidence).not.toHaveProperty("error");
    expect(fixture.github.mergeCount).toBe(1);
    expectPendingMergeProof(fixture);
  });

  it("reports an established first-parent mismatch with explicit generations", async () => {
    const fixture = await setup();
    const pullNumber = await openPreparedPull(fixture);
    const observed = "7".repeat(40);
    fixture.github.driftBaseTo = observed;

    const stale = await fixture.harness.cp.github.mergeExecute(mergeInput(fixture, pullNumber));
    expect(stale.reasonCode).toBe(ReasonCode.MERGE_BASE_STALE);
    if (stale.allowed) throw new Error("expected first-parent mismatch to be denied");
    expect(stale.evidence).toMatchObject({ expected: fixture.base, observed });
    expect(fixture.github.mergeCount).toBe(1);
    expectPendingMergeProof(fixture);
  });

  it("treats an unreadable first-parent commit as a probe failure", async () => {
    const fixture = await setup();
    const pullNumber = await openPreparedPull(fixture);
    const request = fixture.github.request.bind(fixture.github);
    fixture.github.request = async <T>(
      method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
      path: string,
      body?: unknown,
    ): Promise<T> => {
      if (method === "GET" && /\/commits\/[^/]+$/.test(path)) {
        throw new Error("sensitive first-parent transport detail");
      }
      return request<T>(method, path, body);
    };

    const unavailable = await fixture.harness.cp.github.mergeExecute(mergeInput(fixture, pullNumber));
    expect(unavailable.reasonCode).toBe(ReasonCode.PROBE_FAILED);
    expect(unavailable.reasonCode).not.toBe(ReasonCode.MERGE_BASE_STALE);
    if (unavailable.allowed) throw new Error("expected unreadable first-parent commit to be denied");
    const pull = fixture.github.pulls.find((entry) => entry.number === pullNumber)!;
    expect(unavailable.evidence).toMatchObject({
      phase: "postflight-first-parent",
      mergeCommitSha: pull.merge_commit_sha,
    });
    expect(unavailable.evidence).not.toHaveProperty("error");
    expect(fixture.github.mergeCount).toBe(1);
    expectPendingMergeProof(fixture);
  });

  it("treats a null first-parent commit read as a probe failure", async () => {
    const fixture = await setup();
    const pullNumber = await openPreparedPull(fixture);
    const request = fixture.github.request.bind(fixture.github);
    fixture.github.request = async <T>(
      method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
      path: string,
      body?: unknown,
    ): Promise<T> => {
      if (method === "GET" && /\/commits\/[^/]+$/.test(path)) return null as T;
      return request<T>(method, path, body);
    };

    const unavailable = await fixture.harness.cp.github.mergeExecute(mergeInput(fixture, pullNumber));
    expect(unavailable.reasonCode).toBe(ReasonCode.PROBE_FAILED);
    expect(unavailable.reasonCode).not.toBe(ReasonCode.MERGE_BASE_STALE);
    if (unavailable.allowed) throw new Error("expected null first-parent commit read to be denied");
    const pull = fixture.github.pulls.find((entry) => entry.number === pullNumber)!;
    expect(unavailable.evidence).toMatchObject({
      phase: "postflight-first-parent",
      mergeCommitSha: pull.merge_commit_sha,
    });
    expect(unavailable.evidence).not.toHaveProperty("error");
    expect(fixture.github.mergeCount).toBe(1);
    expectPendingMergeProof(fixture);
  });

  it.each([
    { label: "missing parents", commit: { sha: "merge-proof" } },
    { label: "empty parents", commit: { sha: "merge-proof", parents: [] } },
    { label: "blank first-parent SHA", commit: { sha: "merge-proof", parents: [{ sha: "  " }] } },
  ])("treats $label as missing first-parent evidence", async ({ commit }) => {
    const fixture = await setup();
    const pullNumber = await openPreparedPull(fixture);
    const request = fixture.github.request.bind(fixture.github);
    fixture.github.request = async <T>(
      method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
      path: string,
      body?: unknown,
    ): Promise<T> => {
      if (method === "GET" && /\/commits\/[^/]+$/.test(path)) return commit as T;
      return request<T>(method, path, body);
    };

    const unavailable = await fixture.harness.cp.github.mergeExecute(mergeInput(fixture, pullNumber));
    expect(unavailable.reasonCode).toBe(ReasonCode.EVIDENCE_MISSING);
    expect(unavailable.reasonCode).not.toBe(ReasonCode.MERGE_BASE_STALE);
    expect(fixture.github.mergeCount).toBe(1);
    expect(fixture.github.calls.filter((call) => call.method === "PUT" && call.path.endsWith("/merge"))).toHaveLength(1);
    expectPendingMergeProof(fixture);
  });

  it("sends a pinned rebase strategy to GitHub as rebase", async () => {
    const fixture = await setup();
    const originalManifest = fixture.harness.cp.projects.manifest.bind(fixture.harness.cp.projects);
    const manifest = vi.spyOn(fixture.harness.cp.projects, "manifest").mockImplementation((digest) => {
      const pinned = originalManifest(digest);
      return pinned
        ? { ...pinned, branchProfile: { ...pinned.branchProfile, mergeStrategy: "rebase" as never } }
        : null;
    });
    try {
      const pullNumber = await openPreparedPull(fixture);
      const merged = await fixture.harness.cp.github.mergeExecute({
        ...mergeInput(fixture, pullNumber),
        mergeStrategy: "rebase" as never,
      });
      expect(merged.reasonCode).toBe(ReasonCode.OK);
      expect(
        fixture.github.calls.find((call) => call.method === "PUT" && call.path.endsWith("/merge"))?.body,
      ).toEqual({ sha: fixture.head, merge_method: "rebase" });
    } finally {
      manifest.mockRestore();
    }
  });
});

describe("the kernel is on the guard's write path (CP-HI-01)", () => {
  it("a revoked owner generation stops the merge at the guard, not at GitHub", async () => {
    const fixture = await setup();
    const published = await fixture.harness.cp.github.gatePublish(gatePayload(fixture), fixture.identity);
    if (!published.allowed) throw new Error(published.message);
    const pr = await fixture.harness.cp.github.prPrepare({
      runId: fixture.runId,
      repositoryIdentity: fixture.identity,
      head: fixture.workBranch,
      base: "dev",
      title: "candidate",
      body: "",
      ownerSessionId: fixture.ownerSessionId,
      ownerBindingGeneration: fixture.ownerBindingGeneration,
      exactHeadSha: fixture.head,
    });
    if (!pr.allowed) throw new Error(pr.message);

    // Revoke after evaluation issued a grant but before activation revalidates it. This
    // proves the fenced guard, rather than an earlier merge predicate, stopped GitHub.
    const guardEventsBefore = fixture.harness.cp.audit.byKind("MANAGED_WRITE_GUARD").length;
    const originalEvaluate = fixture.harness.cp.guard.evaluate.bind(fixture.harness.cp.guard);
    fixture.harness.cp.guard.evaluate = (request) => {
      const granted = originalEvaluate(request);
      if (granted.allowed) {
        fixture.harness.cp.db.run(
          `UPDATE assignments SET status = 'REVOKED' WHERE role_key = ?`,
          [fixture.harness.cp.runs.require(fixture.runId).ownerRoleKey],
        );
      }
      return granted;
    };
    const refused = await (async () => {
      try {
        return await fixture.harness.cp.github.mergeExecute({
          runId: fixture.runId,
          repositoryIdentity: fixture.identity,
          pullNumber: pr.value.pullNumber,
          exactHeadSha: fixture.head,
          expectedBaseSha: fixture.base,
          mergeStrategy: "merge_commit",
          ownerSessionId: fixture.ownerSessionId,
          ownerBindingGeneration: fixture.ownerBindingGeneration,
        });
      } finally {
        fixture.harness.cp.guard.evaluate = originalEvaluate;
      }
    })();
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.RUN_OWNER_REVOKED);
    expect(fixture.github.mergeCount).toBe(0);
    expect(fixture.harness.cp.audit.byKind("MANAGED_WRITE_GUARD")).toHaveLength(guardEventsBefore + 1);
  });

  it("a successful merge names its branch and checkout in each consumed guard grant", async () => {
    const fixture = await setup();
    const published = await fixture.harness.cp.github.gatePublish(gatePayload(fixture), fixture.identity);
    if (!published.allowed) throw new Error(published.message);
    const pr = await fixture.harness.cp.github.prPrepare({
      runId: fixture.runId,
      repositoryIdentity: fixture.identity,
      head: fixture.workBranch,
      base: "dev",
      title: "candidate",
      body: "",
      ownerSessionId: fixture.ownerSessionId,
      ownerBindingGeneration: fixture.ownerBindingGeneration,
      exactHeadSha: fixture.head,
    });
    if (!pr.allowed) throw new Error(pr.message);

    const merged = await fixture.harness.cp.github.mergeExecute({
      runId: fixture.runId,
      repositoryIdentity: fixture.identity,
      pullNumber: pr.value.pullNumber,
      exactHeadSha: fixture.head,
      expectedBaseSha: fixture.base,
      mergeStrategy: "merge_commit",
      ownerSessionId: fixture.ownerSessionId,
      ownerBindingGeneration: fixture.ownerBindingGeneration,
    });
    expect(merged.allowed).toBe(true);

    // Every remote write the kernel performed burned a guard grant: the guard is on the
    // path, not merely available to be called.
    const consumed = fixture.harness.cp.audit.byKind("MANAGED_WRITE_GUARD_CONSUMED");
    for (const operation of ["PROGRAMMATIC_MERGE", "GITHUB_PR", "GITHUB_CHECK_RUN"]) {
      const grant = consumed.find((event) => event.evidence["operation"] === operation);
      expect(grant?.evidence).toMatchObject({
        targetBranch: fixture.workBranch,
        resolvedPath: realpathSync(fixture.harness.repoPath),
      });
    }
  });

  it("a gate publish for a run with no pinned owner is refused", async () => {
    const github = new FakeGitHub();
    const harness = makeHarness({ githubClient: github });
    harness.cp.credentials.install({ token: "t", creatorIdentity: "acp-trusted-app" });
    const { projectId, repositoryId, identity } = await registerFixtureProject(harness);
    const created = harness.cp.runs.create({
      projectId,
      executionMode: ExecutionMode.SIMPLE,
      contract: CONTRACT,
      repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
    });
    if (!created.allowed) throw new Error(created.message);
    // Never dispatched, so no owner is pinned.

    const refused = await harness.cp.github.gatePublish(
      {
        runId: created.value.runId,
        candidateSnapshotDigest: "sha256:" + "1".repeat(64),
        contractDigest: "sha256:" + "2".repeat(64),
        verificationDigest: "sha256:" + "3".repeat(64),
        blindReviewDigest: "sha256:" + "4".repeat(64),
        humanGateDigest: "sha256:" + "5".repeat(64),
        bindingGeneration: 1,
        exactHead: "a".repeat(40),
        timestamp: "2026-08-12T00:00:00.000Z",
      },
      identity,
    );
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.RUN_OWNER_NOT_PINNED);
    expect(github.checkRuns).toHaveLength(0);
  });

  it("serializes concurrent production-gate publication before either caller can write", async () => {
    const fixture = await setup();
    const concurrent = await Promise.all([
      fixture.harness.cp.github.gatePublish(gatePayload(fixture), fixture.identity),
      fixture.harness.cp.github.gatePublish(gatePayload(fixture), fixture.identity),
    ]);
    expect(concurrent.map((result) => result.reasonCode)).toEqual(
      expect.arrayContaining([ReasonCode.OK, ReasonCode.RESOURCE_COLLISION]),
    );
    expect(fixture.github.checkRuns.filter((check) => check.name === GATE_CHECK_NAME)).toHaveLength(1);
  });
});

describe("trusted CI evidence (CP-S29)", () => {
  // The fixture already applied the candidate change and froze it; re-freezing returns the
  // same content-addressed snapshot.
  const frozen = async (fixture: Fixture) => {
    const snapshot = await fixture.harness.cp.pipeline.freeze(fixture.runId);
    if (!snapshot.allowed) throw new Error(snapshot.message);
    return snapshot.value;
  };

  it("CP-S29: a CI result for a different head is refused, not counted", async () => {
    const fixture = await setup({ finalization: false });
    const snapshot = await frozen(fixture);
    const repo = snapshot.repositories[0]!;

    fixture.harness.cp.verification.attachCi({
      // The check reports success, but against a head that is not the candidate's.
      fetch: async () => [
        {
          commandId: "project-ci",
          repositoryIdentity: repo.identity,
          head: "0".repeat(40),
          conclusion: "success",
          workflowDigest: "sha256:approved",
          creatorIdentity: "github-actions",
          completedAt: "2026-08-12T00:00:00.000Z",
          nonVacuous: true,
        },
      ],
      approvedWorkflowDigests: async () => ["sha256:approved"],
      trustedCreators: async () => ["github-actions"],
    });

    const verified = await fixture.harness.cp.verification.verify({
      runId: fixture.runId,
      snapshot,
      commands: TRUSTED_CI_COMMANDS,
      contractDigest: snapshot.contractDigest,
    });
    expect(verified.allowed).toBe(false);

    const report = fixture.harness.cp.verification.latestReport(
      fixture.runId,
      candidateSnapshotDigest(snapshot),
    )!;
    expect(report.results[0]?.reasonCode).toBe(ReasonCode.VERIFICATION_CI_HEAD_MISMATCH);
    expect(report.status).not.toBe("PASS");
  });

  it("CP-S29: an unapproved workflow digest or untrusted creator is also refused", async () => {
    const fixture = await setup({ finalization: false });
    const snapshot = await frozen(fixture);
    const repo = snapshot.repositories[0]!;
    const base = {
      commandId: "project-ci",
      repositoryIdentity: repo.identity,
      head: repo.candidateHead,
      conclusion: "success" as const,
      completedAt: "2026-08-12T00:00:00.000Z",
      nonVacuous: true,
    };

    fixture.harness.cp.verification.attachCi({
      fetch: async () => [{ ...base, workflowDigest: "sha256:candidate-edited", creatorIdentity: "github-actions" }],
      approvedWorkflowDigests: async () => ["sha256:approved"],
      trustedCreators: async () => ["github-actions"],
    });
    const edited = await fixture.harness.cp.verification.verify({
      runId: fixture.runId,
      snapshot,
      commands: TRUSTED_CI_COMMANDS,
      contractDigest: snapshot.contractDigest,
    });
    expect(edited.allowed).toBe(false);
    expect(
      fixture.harness.cp.verification.latestReport(fixture.runId, candidateSnapshotDigest(snapshot))!
        .results[0]?.reasonCode,
    ).toBe(ReasonCode.VERIFICATION_CI_WORKFLOW_DIGEST_MISMATCH);
  });

  it("an older green CI result does not mask a newer red one for the same head", async () => {
    const fixture = await setup({ finalization: false });
    const snapshot = await frozen(fixture);
    const repo = snapshot.repositories[0]!;
    const base = {
      commandId: "project-ci",
      repositoryIdentity: repo.identity,
      head: repo.candidateHead,
      workflowDigest: "sha256:approved",
      creatorIdentity: "github-actions",
      nonVacuous: true,
    };

    fixture.harness.cp.verification.attachCi({
      fetch: async () => [
        { ...base, conclusion: "success", completedAt: "2026-08-12T00:00:00.000Z" },
        { ...base, conclusion: "failure", completedAt: "2026-08-12T01:00:00.000Z" },
      ],
      approvedWorkflowDigests: async () => ["sha256:approved"],
      trustedCreators: async () => ["github-actions"],
    });

    const verified = await fixture.harness.cp.verification.verify({
      runId: fixture.runId,
      snapshot,
      commands: TRUSTED_CI_COMMANDS,
      contractDigest: snapshot.contractDigest,
    });
    expect(verified.allowed).toBe(false);
    expect(
      fixture.harness.cp.verification.latestReport(fixture.runId, candidateSnapshotDigest(snapshot))!
        .results[0]?.status,
    ).toBe("FAIL");
  });

  it("a CI result belonging to another repository is not evidence for this one", async () => {
    const fixture = await setup({ finalization: false });
    const snapshot = await frozen(fixture);
    const repo = snapshot.repositories[0]!;

    fixture.harness.cp.verification.attachCi({
      fetch: async () => [
        {
          commandId: "project-ci",
          repositoryIdentity: "github:acme/somewhere-else",
          head: repo.candidateHead,
          conclusion: "success",
          workflowDigest: "sha256:approved",
          creatorIdentity: "github-actions",
          completedAt: "2026-08-12T00:00:00.000Z",
          nonVacuous: true,
        },
      ],
      approvedWorkflowDigests: async () => ["sha256:approved"],
      trustedCreators: async () => ["github-actions"],
    });

    const verified = await fixture.harness.cp.verification.verify({
      runId: fixture.runId,
      snapshot,
      commands: TRUSTED_CI_COMMANDS,
      contractDigest: snapshot.contractDigest,
    });
    expect(verified.allowed).toBe(false);
    expect(
      fixture.harness.cp.verification.latestReport(fixture.runId, candidateSnapshotDigest(snapshot))!
        .results[0]?.reasonCode,
    ).toBe(ReasonCode.EVIDENCE_MISSING);
  });

  it("CP-HI-03: a command list that does not match the pinned manifest is refused", async () => {
    const fixture = await setup({ finalization: false });
    const snapshot = await frozen(fixture);
    const run = fixture.harness.cp.runs.require(fixture.runId);

    const weaker = [
      parseVerificationCommand({ id: "verify", argv: ["node", "-e", "process.exit(0)"] }),
    ];
    const refused = await fixture.harness.cp.verification.verify({
      runId: fixture.runId,
      snapshot,
      commands: weaker,
      contractDigest: snapshot.contractDigest,
      pinnedManifestDigest: run.pinnedManifestDigest,
      executionMode: run.executionMode,
    });
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.CANDIDATE_CANNOT_WEAKEN_CONTRACT);
  });

  it("CP-S29: a CI result at the exact head from an approved workflow is accepted", async () => {
    const fixture = await setup({ finalization: false });
    const snapshot = await frozen(fixture);
    const repo = snapshot.repositories[0]!;

    fixture.harness.cp.verification.attachCi({
      fetch: async () => [
        {
          commandId: "project-ci",
          repositoryIdentity: repo.identity,
          head: repo.candidateHead,
          conclusion: "success",
          workflowDigest: "sha256:approved",
          creatorIdentity: "github-actions",
          completedAt: "2026-08-12T00:00:00.000Z",
          nonVacuous: true,
        },
      ],
      approvedWorkflowDigests: async () => ["sha256:approved"],
      trustedCreators: async () => ["github-actions"],
    });

    const verified = await fixture.harness.cp.verification.verify({
      runId: fixture.runId,
      snapshot,
      commands: TRUSTED_CI_COMMANDS,
      contractDigest: snapshot.contractDigest,
    });
    expect(verified.allowed).toBe(true);
    expect(verified.allowed && verified.value.status).toBe("PASS");
  });
});

describe("trusted credential boundary (CP-HI-05)", () => {
  it("keeps the token out of every readable surface", async () => {
    const fixture = await setup();
    // The store exposes the creator identity but never the token itself.
    expect(fixture.harness.cp.credentials.creatorIdentity()).toBe("acp-trusted-app");
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(fixture.harness.cp.credentials)).sort()).toEqual([
      "authenticate",
      "availability",
      "available",
      "constructor",
      "creatorIdentity",
      "githubApi",
      "install",
      "permissionsOk",
      "sensitivePaths",
    ]);

    await fixture.harness.cp.github.gatePublish(gatePayload(fixture), fixture.identity);
    const audit = JSON.stringify(fixture.harness.cp.audit.all());
    expect(audit).not.toContain("test-token");

    const receipts = JSON.stringify(fixture.harness.cp.github.receipts(fixture.runId));
    expect(receipts).not.toContain("test-token");
  });
});
