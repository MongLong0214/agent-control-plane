import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { digestOf } from "../../src/core/digest.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ExecutionMode } from "../../src/domain/types.ts";
import { GATE_CHECK_NAME, type GatePayload } from "../../src/github/github-kernel.ts";
import { classifyBranch, validateBranchContract } from "../../src/github/branch-contract.ts";
import { parseVerificationCommand } from "../../src/contracts/verification-command.ts";
import { candidateSnapshotDigest } from "../../src/snapshot/candidate-snapshot.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { FakeGitHub } from "../helpers/fake-github.ts";
import {
  type Harness,
  applyPassingChange,
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

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const PROFILE = {
  longLived: ["main", "dev"],
  defaultBranch: "dev",
  updateStrategy: "rebase_before_review" as const,
  mergeStrategy: "merge_commit" as const,
  releaseTagPolicy: "semver" as const,
  releaseBranchCleanup: "keep" as const,
};

interface Fixture {
  harness: Harness;
  github: FakeGitHub;
  runId: string;
  identity: string;
  ownerSessionId: string;
  ownerBindingGeneration: number;
}

const setup = async (): Promise<Fixture> => {
  const github = new FakeGitHub();
  const harness = makeHarness({ githubClient: github });
  harness.cp.credentials.install({ token: "test-token", creatorIdentity: "acp-trusted-app" });

  const { projectId, repositoryId, identity } = await registerFixtureProject(harness);
  const created = harness.cp.runs.create({
    projectId,
    executionMode: ExecutionMode.STANDARD,
    contract: CONTRACT,
    repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
  });
  if (!created.allowed) throw new Error(created.message);
  const dispatched = await harness.cp.runs.dispatch(created.value.runId);
  if (!dispatched.allowed) throw new Error(dispatched.message);

  github.setBranch("dev", BASE);
  github.setBranch("main", "c".repeat(40));
  github.setBranch("feature/F1-thing", HEAD);
  github.setBranch("task/T1-thing", HEAD);

  // The kernel requires a live claim on the repository before it will act.
  harness.cp.claims.acquire({
    runId: created.value.runId,
    ownerSessionId: dispatched.value.ownerSessionId!,
    ownerBindingGeneration: dispatched.value.ownerBindingGeneration!,
    ownerRoleKey: dispatched.value.ownerRoleKey!,
    repositoryIdentity: identity,
    branch: "task/T1-thing",
  });

  return {
    harness,
    github,
    runId: created.value.runId,
    identity,
    ownerSessionId: dispatched.value.ownerSessionId!,
    ownerBindingGeneration: dispatched.value.ownerBindingGeneration!,
  };
};

const gatePayload = (fixture: Fixture, head = HEAD): GatePayload => ({
  runId: fixture.runId,
  candidateSnapshotDigest: "sha256:" + "1".repeat(64),
  contractDigest: "sha256:" + "2".repeat(64),
  verificationDigest: "sha256:" + "3".repeat(64),
  blindReviewDigest: "sha256:" + "4".repeat(64),
  humanGateDigest: "sha256:" + "5".repeat(64),
  bindingGeneration: fixture.ownerBindingGeneration,
  exactHead: head,
  timestamp: "2026-08-12T00:00:00.000Z",
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
      head: "feature/F1-thing",
      base: "main",
      title: "wrong target",
      body: "",
      ownerSessionId: fixture.ownerSessionId,
      ownerBindingGeneration: fixture.ownerBindingGeneration,
      exactHeadSha: HEAD,
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
      head: "feature/F1-thing",
      base: "dev",
      title: "ok",
      body: "",
      ownerSessionId: fixture.ownerSessionId,
      ownerBindingGeneration: fixture.ownerBindingGeneration,
      exactHeadSha: "d".repeat(40),
    });
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.MERGE_HEAD_STALE);
  });

  it("refuses a PR when the project contract requires issue linkage and none is supplied", async () => {
    const fixture = await setup();
    const refused = await fixture.harness.cp.github.prPrepare({
      runId: fixture.runId,
      repositoryIdentity: fixture.identity,
      head: "feature/F1-thing",
      base: "dev",
      title: "ok",
      body: "",
      requireLinkage: true,
      linkedIssues: [],
      ownerSessionId: fixture.ownerSessionId,
      ownerBindingGeneration: fixture.ownerBindingGeneration,
      exactHeadSha: HEAD,
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
    fixture.github.forgeGate(HEAD, `payloadDigest=sha256:${"9".repeat(64)}`, "candidate-ci");

    const prepared = await fixture.harness.cp.github.prPrepare({
      runId: fixture.runId,
      repositoryIdentity: fixture.identity,
      head: "feature/F1-thing",
      base: "dev",
      title: "candidate",
      body: "",
      ownerSessionId: fixture.ownerSessionId,
      ownerBindingGeneration: fixture.ownerBindingGeneration,
      exactHeadSha: HEAD,
    });
    if (!prepared.allowed) throw new Error(prepared.message);

    const refused = await fixture.harness.cp.github.mergeEvaluate({
      runId: fixture.runId,
      repositoryIdentity: fixture.identity,
      pullNumber: prepared.value.pullNumber,
      exactHeadSha: HEAD,
      expectedBaseSha: BASE,
      mergeStrategy: "merge_commit",
      ownerSessionId: fixture.ownerSessionId,
      ownerBindingGeneration: fixture.ownerBindingGeneration,
    });
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.GATE_PAYLOAD_PROVENANCE_INVALID);

    const rejections = fixture.harness.cp.audit.byKind("GATE_REJECTED");
    expect(rejections.length).toBeGreaterThan(0);
  });

  it("CP-S35: a gate whose payload the daemon did record, but under a different head, is refused", async () => {
    const published = await fixture.harness.cp.github.gatePublish(
      gatePayload(fixture, "e".repeat(40)),
      fixture.identity,
    );
    expect(published.allowed).toBe(true);

    // Re-point the recorded payload's check at a different head.
    const check = fixture.github.checkRuns.find((c) => c.name === GATE_CHECK_NAME)!;
    check.head_sha = HEAD;

    const prepared = await fixture.harness.cp.github.prPrepare({
      runId: fixture.runId,
      repositoryIdentity: fixture.identity,
      head: "feature/F1-thing",
      base: "dev",
      title: "candidate",
      body: "",
      ownerSessionId: fixture.ownerSessionId,
      ownerBindingGeneration: fixture.ownerBindingGeneration,
      exactHeadSha: HEAD,
    });
    if (!prepared.allowed) throw new Error(prepared.message);

    const refused = await fixture.harness.cp.github.mergeEvaluate({
      runId: fixture.runId,
      repositoryIdentity: fixture.identity,
      pullNumber: prepared.value.pullNumber,
      exactHeadSha: HEAD,
      expectedBaseSha: BASE,
      mergeStrategy: "merge_commit",
      ownerSessionId: fixture.ownerSessionId,
      ownerBindingGeneration: fixture.ownerBindingGeneration,
    });
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.GATE_PAYLOAD_PROVENANCE_INVALID);
  });

  it("CP-S37: a merge with no gate at all is refused, whatever the target branch is", async () => {
    const prepared = await fixture.harness.cp.github.prPrepare({
      runId: fixture.runId,
      repositoryIdentity: fixture.identity,
      head: "feature/F1-thing",
      base: "dev",
      title: "candidate",
      body: "",
      ownerSessionId: fixture.ownerSessionId,
      ownerBindingGeneration: fixture.ownerBindingGeneration,
      exactHeadSha: HEAD,
    });
    if (!prepared.allowed) throw new Error(prepared.message);

    const refused = await fixture.harness.cp.github.mergeEvaluate({
      runId: fixture.runId,
      repositoryIdentity: fixture.identity,
      pullNumber: prepared.value.pullNumber,
      exactHeadSha: HEAD,
      expectedBaseSha: BASE,
      mergeStrategy: "merge_commit",
      ownerSessionId: fixture.ownerSessionId,
      ownerBindingGeneration: fixture.ownerBindingGeneration,
    });
    expect(refused.reasonCode).toBe(ReasonCode.MERGE_GATE_MISSING);
    expect(fixture.github.mergeCount).toBe(0);
  });

  it("gate_publish refuses when the trusted credential is absent", async () => {
    const github = new FakeGitHub();
    const bare = makeHarness({ githubClient: github });
    const refused = await bare.cp.github.gatePublish(
      { ...gatePayload(fixture), runId: "run_x" },
      "github:acme/fixture",
    );
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.TRUSTED_CREDENTIAL_UNAVAILABLE);
  });
});

describe("merge execution (CP-S38, CP-S39, CP-S40)", () => {
  const prepared = async (fixture: Fixture) => {
    const published = await fixture.harness.cp.github.gatePublish(gatePayload(fixture), fixture.identity);
    if (!published.allowed) throw new Error(published.message);
    const pr = await fixture.harness.cp.github.prPrepare({
      runId: fixture.runId,
      repositoryIdentity: fixture.identity,
      head: "feature/F1-thing",
      base: "dev",
      title: "candidate",
      body: "",
      ownerSessionId: fixture.ownerSessionId,
      ownerBindingGeneration: fixture.ownerBindingGeneration,
      exactHeadSha: HEAD,
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
      expectedBaseSha: BASE,
    });
    expect(staleHead.reasonCode).toBe(ReasonCode.MERGE_HEAD_STALE);

    const staleBase = await fixture.harness.cp.github.mergeEvaluate({
      ...base,
      exactHeadSha: HEAD,
      expectedBaseSha: "0".repeat(40),
    });
    expect(staleBase.reasonCode).toBe(ReasonCode.MERGE_BASE_STALE);
    expect(fixture.github.mergeCount).toBe(0);
  });

  it("CP-S39: a valid merge happens exactly once and a replay returns the original receipt", async () => {
    const fixture = await setup();
    const pullNumber = await prepared(fixture);
    const input = {
      runId: fixture.runId,
      repositoryIdentity: fixture.identity,
      pullNumber,
      exactHeadSha: HEAD,
      expectedBaseSha: BASE,
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
      exactHeadSha: HEAD,
      expectedBaseSha: BASE,
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

  it("post-merge verification treats a missing check as a failure, not a pass", async () => {
    const fixture = await setup();
    const verified = await fixture.harness.cp.github.postMergeVerify(
      fixture.runId,
      fixture.identity,
      "9".repeat(40),
      ["project-ci"],
    );
    expect(verified.allowed).toBe(false);
    expect(verified.evidence["failed"]).toEqual([{ name: "project-ci", conclusion: "missing" }]);
  });
});

describe("release and hotfix (CP-S41, CP-S42)", () => {
  it("CP-S41: a tag on a commit the kernel never merged, and a duplicate tag, are both refused", async () => {
    const fixture = await setup();
    const notMerged = await fixture.harness.cp.github.releaseTag(
      fixture.runId,
      fixture.identity,
      "1.0.0",
      "1".repeat(40),
    );
    expect(notMerged.allowed).toBe(false);
    expect(notMerged.reasonCode).toBe(ReasonCode.RELEASE_TAG_COMMIT_NOT_ACCEPTED);

    const badSemver = await fixture.harness.cp.github.releaseTag(
      fixture.runId,
      fixture.identity,
      "release-one",
      "1".repeat(40),
    );
    expect(badSemver.reasonCode).toBe(ReasonCode.RELEASE_TAG_SEMVER_MISMATCH);

    // Merge properly, then tag, then attempt to move the tag.
    const published = await fixture.harness.cp.github.gatePublish(gatePayload(fixture), fixture.identity);
    if (!published.allowed) throw new Error(published.message);
    const pr = await fixture.harness.cp.github.prPrepare({
      runId: fixture.runId,
      repositoryIdentity: fixture.identity,
      head: "feature/F1-thing",
      base: "dev",
      title: "candidate",
      body: "",
      ownerSessionId: fixture.ownerSessionId,
      ownerBindingGeneration: fixture.ownerBindingGeneration,
      exactHeadSha: HEAD,
    });
    if (!pr.allowed) throw new Error(pr.message);
    const merged = await fixture.harness.cp.github.mergeExecute({
      runId: fixture.runId,
      repositoryIdentity: fixture.identity,
      pullNumber: pr.value.pullNumber,
      exactHeadSha: HEAD,
      expectedBaseSha: BASE,
      mergeStrategy: "merge_commit",
      ownerSessionId: fixture.ownerSessionId,
      ownerBindingGeneration: fixture.ownerBindingGeneration,
    });
    if (!merged.allowed) throw new Error(merged.message);

    const tagged = await fixture.harness.cp.github.releaseTag(
      fixture.runId,
      fixture.identity,
      "1.0.0",
      merged.value.mergeCommitSha,
    );
    expect(tagged.allowed).toBe(true);

    // Re-tagging the same commit is an idempotent replay.
    const replay = await fixture.harness.cp.github.releaseTag(
      fixture.runId,
      fixture.identity,
      "1.0.0",
      merged.value.mergeCommitSha,
    );
    expect(replay.reasonCode).toBe(ReasonCode.MERGE_IDEMPOTENT_REPLAY);

    // Pointing an existing tag at a different commit is refused.
    fixture.github.markContains("dev", "z".repeat(40));
    const moved = await fixture.harness.cp.github.releaseTag(
      fixture.runId,
      fixture.identity,
      "1.0.0",
      "z".repeat(40),
    );
    expect(moved.allowed).toBe(false);
    expect([ReasonCode.RELEASE_TAG_DUPLICATE, ReasonCode.RELEASE_TAG_COMMIT_NOT_ACCEPTED]).toContain(
      moved.reasonCode,
    );
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
  it("syncs idempotently by marker rather than creating duplicates", async () => {
    const fixture = await setup();
    const tickets = [{ id: "T001", title: "first", body: "do the thing" }];

    const first = await fixture.harness.cp.github.issueProject(fixture.runId, fixture.identity, tickets);
    expect(first.allowed && first.value).toEqual({ created: 1, updated: 0 });

    const second = await fixture.harness.cp.github.issueProject(fixture.runId, fixture.identity, [
      { id: "T001", title: "first, retitled", body: "do the thing" },
    ]);
    expect(second.allowed && second.value).toEqual({ created: 0, updated: 1 });
    expect(fixture.github.issues).toHaveLength(1);
    expect(fixture.github.issues[0]?.title).toBe("first, retitled");
    expect(fixture.github.issues[0]?.body).toContain("<!-- acp-ticket:T001 -->");
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
      head: "feature/F1-thing",
      base: "dev",
      title: "candidate",
      body: "",
      ownerSessionId: fixture.ownerSessionId,
      ownerBindingGeneration: fixture.ownerBindingGeneration,
      exactHeadSha: HEAD,
    });
    if (!pr.allowed) throw new Error(pr.message);

    // Revoke the owner binding: the merge must be refused by the guard even though the
    // gate, the branch contract and the exact head are all still satisfied.
    fixture.harness.cp.db.run(
      `UPDATE assignments SET status = 'REVOKED' WHERE role_key = ?`,
      [fixture.harness.cp.runs.require(fixture.runId).ownerRoleKey],
    );

    const refused = await fixture.harness.cp.github.mergeExecute({
      runId: fixture.runId,
      repositoryIdentity: fixture.identity,
      pullNumber: pr.value.pullNumber,
      exactHeadSha: HEAD,
      expectedBaseSha: BASE,
      mergeStrategy: "merge_commit",
      ownerSessionId: fixture.ownerSessionId,
      ownerBindingGeneration: fixture.ownerBindingGeneration,
    });
    expect(refused.allowed).toBe(false);
    expect(fixture.github.mergeCount).toBe(0);
  });

  it("a successful merge leaves a consumed guard grant, proving mediation", async () => {
    const fixture = await setup();
    const published = await fixture.harness.cp.github.gatePublish(gatePayload(fixture), fixture.identity);
    if (!published.allowed) throw new Error(published.message);
    const pr = await fixture.harness.cp.github.prPrepare({
      runId: fixture.runId,
      repositoryIdentity: fixture.identity,
      head: "feature/F1-thing",
      base: "dev",
      title: "candidate",
      body: "",
      ownerSessionId: fixture.ownerSessionId,
      ownerBindingGeneration: fixture.ownerBindingGeneration,
      exactHeadSha: HEAD,
    });
    if (!pr.allowed) throw new Error(pr.message);

    const merged = await fixture.harness.cp.github.mergeExecute({
      runId: fixture.runId,
      repositoryIdentity: fixture.identity,
      pullNumber: pr.value.pullNumber,
      exactHeadSha: HEAD,
      expectedBaseSha: BASE,
      mergeStrategy: "merge_commit",
      ownerSessionId: fixture.ownerSessionId,
      ownerBindingGeneration: fixture.ownerBindingGeneration,
    });
    expect(merged.allowed).toBe(true);

    // Every remote write the kernel performed burned a guard grant: the guard is on the
    // path, not merely available to be called.
    const consumed = fixture.harness.cp.audit
      .byKind("MANAGED_WRITE_GUARD_CONSUMED")
      .map((e) => e.evidence["operation"]);
    expect(consumed).toContain("PROGRAMMATIC_MERGE");
    expect(consumed).toContain("GITHUB_PR");
    expect(consumed).toContain("GITHUB_CHECK_RUN");
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
        exactHead: HEAD,
        timestamp: "2026-08-12T00:00:00.000Z",
      },
      identity,
    );
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.RUN_OWNER_NOT_PINNED);
    expect(github.checkRuns).toHaveLength(0);
  });
});

describe("trusted CI evidence (CP-S29)", () => {
  const commands = [
    parseVerificationCommand({
      id: "project-ci",
      argv: ["node", "verify.js"],
      repositoryRole: "primary",
      evidenceMode: "TRUSTED_CI",
      timeoutSeconds: 60,
    }),
  ];

  const frozen = async (fixture: Fixture) => {
    applyPassingChange(fixture.harness.repoPath);
    const snapshot = await fixture.harness.cp.pipeline.freeze(fixture.runId);
    if (!snapshot.allowed) throw new Error(snapshot.message);
    return snapshot.value;
  };

  it("CP-S29: a CI result for a different head is refused, not counted", async () => {
    const fixture = await setup();
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
      commands,
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
    const fixture = await setup();
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
      commands,
      contractDigest: snapshot.contractDigest,
    });
    expect(edited.allowed).toBe(false);
    expect(
      fixture.harness.cp.verification.latestReport(fixture.runId, candidateSnapshotDigest(snapshot))!
        .results[0]?.reasonCode,
    ).toBe(ReasonCode.VERIFICATION_CI_WORKFLOW_DIGEST_MISMATCH);
  });

  it("CP-S29: a CI result at the exact head from an approved workflow is accepted", async () => {
    const fixture = await setup();
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
      commands,
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
    expect(Object.values(fixture.harness.cp.credentials)).not.toContain("test-token");

    await fixture.harness.cp.github.gatePublish(gatePayload(fixture), fixture.identity);
    const audit = JSON.stringify(fixture.harness.cp.audit.all());
    expect(audit).not.toContain("test-token");

    const receipts = JSON.stringify(fixture.harness.cp.github.receipts(fixture.runId));
    expect(receipts).not.toContain("test-token");
    expect(digestOf({ ok: true })).toMatch(/^sha256:/);
  });
});
