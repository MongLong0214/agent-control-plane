import { chmodSync } from "node:fs";

import { afterAll, describe, expect, it, vi } from "vitest";

import { digestOf, sha256 } from "../../src/core/digest.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { TrustedCredentialStore } from "../../src/github/credential-store.ts";
import { validateBranchContract } from "../../src/github/branch-contract.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { FakeGitHub } from "../helpers/fake-github.ts";
import { driveToReviewedCandidate, makeHarness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

const PROFILE = {
  longLived: ["main", "dev"],
  defaultBranch: "dev",
  updateStrategy: "rebase_before_review" as const,
  mergeStrategy: "merge_commit" as const,
  releaseTagPolicy: "semver" as const,
  releaseBranchCleanup: "keep" as const,
};

const ready = async (ciWorkflows: Array<{ path: string; checkName: string; approvedDigest: string | null }> = []) => {
  const github = new FakeGitHub();
  Object.assign(github, { supportsAtomicExpectedBase: true });
  const harness = makeHarness({ githubClient: github });
  harness.cp.credentials.install({ token: "test-token", creatorIdentity: "acp-trusted-app" });
  const driven = await driveToReviewedCandidate(harness, {
    workBranch: "feature/F1-thing",
    manifestOverrides: { ciWorkflows },
  });
  github.setBranch("dev", driven.baseHead);
  github.setBranch("main", "m".repeat(40));
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
  const payload = {
    runId: driven.runId,
    candidateSnapshotDigest: driven.candidateSnapshotDigest,
    contractDigest: driven.contractDigest,
    verificationDigest: driven.verificationDigest,
    blindReviewDigest: driven.blindReviewDigest,
    humanGateDigest: digestOf({ humanGate: "NOT_REQUIRED" }),
    bindingGeneration: driven.ownerBindingGeneration,
    exactHead: driven.candidateHead,
    timestamp: "2026-08-12T00:00:00.000Z",
  };
  const input = {
    runId: driven.runId,
    repositoryIdentity: driven.identity,
    head: driven.workBranch,
    base: "dev",
    title: "candidate",
    body: "",
    ownerSessionId: driven.ownerSessionId,
    ownerBindingGeneration: driven.ownerBindingGeneration,
    exactHeadSha: driven.candidateHead,
  };
  return { github, harness, driven, payload, input };
};

describe("round-two GitHub hardening", () => {
  it("#77: exposes no arbitrary executable runner that could print the authority environment", () => {
    const store = new TrustedCredentialStore(tempDir("credential-boundary-"));
    store.install({ token: "never-exposed", creatorIdentity: "acp" });
    expect(typeof (store as unknown as Record<string, unknown>)["run"]).toBe("undefined");
  });

  it("#191: rejects cached credentials after their token file becomes group-readable", async () => {
    const directory = tempDir("credential-mode-");
    const store = new TrustedCredentialStore(directory);
    store.install({ token: "never-exposed", creatorIdentity: "acp" });
    chmodSync(`${directory}/github-authority.token`, 0o640);
    expect(store.permissionsOk()).toBe(false);
    expect(store.creatorIdentity()).toBeNull();
    const refused = await store.githubApi({ method: "GET", path: "/user" });
    expect(refused.reasonCode).toBe(ReasonCode.TRUSTED_CREDENTIAL_LEAK_BLOCKED);
  });

  it("#92/#194: rejects a branch whose immutable source lineage is not its required base", () => {
    const refused = validateBranchContract({
      head: "hotfix/H1-fix",
      base: "main",
      profile: PROFILE,
      sourceBase: "dev",
    });
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.PR_BRANCH_CONTRACT_VIOLATION);
  });

  it("#92/#194: keeps fix branches on the declared source lineage", () => {
    const refused = validateBranchContract({
      head: "fix/F1-correction",
      base: "dev",
      profile: PROFILE,
      declaredParent: "release/1.2.0",
      sourceBase: "release/1.2.0",
      activeReleases: ["release/1.2.0"],
    });
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.PR_BRANCH_CONTRACT_VIOLATION);
  });

  it("#79: refuses a gate that names superseded evidence after the candidate content is restored", async () => {
    const fixture = await ready();
    fixture.harness.cp.db.run(`UPDATE run_artifacts SET superseded = 1 WHERE digest = ?`, [
      fixture.payload.verificationDigest,
    ]);
    const refused = await fixture.harness.cp.github.gatePublish(fixture.payload, fixture.driven.identity);
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.GATE_EVIDENCE_NOT_BACKED);
  });

  it("#80/#197: an active-release listing failure is a propagation refusal", async () => {
    const fixture = await ready();
    const original = fixture.github.request.bind(fixture.github);
    fixture.github.request = async (method, path, body) => {
      if (method === "GET" && path.includes("/branches?")) throw new Error("enumeration failed");
      return original(method, path, body);
    };
    const refused = await fixture.harness.cp.github.verifyHotfixPropagation(
      fixture.driven.runId,
      fixture.driven.identity,
      fixture.driven.candidateHead,
    );
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.PROBE_FAILED);
  });

  it("#78/#83: a same-name github-actions check without suite and Actions-run provenance is not CI evidence", async () => {
    const fixture = await ready([{ path: ".github/workflows/ci.yml", checkName: "project-ci", approvedDigest: "sha256:approved" }]);
    fixture.github.checkRuns.push({
      id: 17,
      name: "project-ci",
      head_sha: fixture.driven.candidateHead,
      conclusion: "success",
      status: "completed",
      app: { slug: "github-actions" },
      completed_at: "2026-08-12T00:00:00.000Z",
    });
    expect(await fixture.harness.cp.github.ciEvidenceSource().fetch(fixture.driven.identity, fixture.driven.candidateHead)).toEqual([]);
  });

  it("#85: fences the head, proves the base after merging, and records the residual base race", async () => {
    const fixture = await ready();
    Object.assign(fixture.github, { supportsAtomicExpectedBase: false });
    const gate = await fixture.harness.cp.github.gatePublish(fixture.payload, fixture.driven.identity);
    if (!gate.allowed) throw new Error(gate.message);
    const pr = await fixture.harness.cp.github.prPrepare(fixture.input);
    if (!pr.allowed) throw new Error(pr.message);
    const merged = await fixture.harness.cp.github.mergeExecute({
      runId: fixture.driven.runId,
      repositoryIdentity: fixture.driven.identity,
      pullNumber: pr.value.pullNumber,
      exactHeadSha: fixture.driven.candidateHead,
      expectedBaseSha: fixture.driven.baseHead,
      mergeStrategy: "merge_commit",
      ownerSessionId: fixture.driven.ownerSessionId,
      ownerBindingGeneration: fixture.driven.ownerBindingGeneration,
    });
    expect(merged.allowed).toBe(true);
    expect(fixture.github.mergeCount).toBe(1);
    expect(
      fixture.github.calls.find((call) => call.method === "PUT" && call.path.endsWith("/merge"))?.body,
    ).toEqual({ sha: fixture.driven.candidateHead, merge_method: "merge" });
    const receipt = fixture.harness.cp.db.get<{ response_json: string }>(
      `SELECT response_json FROM github_receipts WHERE operation = 'merge_execute'`,
    );
    expect(JSON.parse(receipt!.response_json).baseVerification).toEqual({
      preflight: "exact-base-reread",
      residualRace: "base-may-move-between-preflight-and-merge",
      proof: "merge-commit-first-parent",
    });
  });

  it("#87/#192: a receipt for the same PR but different merge intent is a resource collision", async () => {
    const fixture = await ready();
    const pullNumber = 999;
    fixture.harness.cp.db.run(
      `INSERT INTO github_receipts
         (receipt_id, idempotency_key, operation, run_id, repository_identity, resource_type, resource_identity,
          preexisting, before_state_digest, after_state_digest, request_digest, response_json, created_at, reread_at, verified)
       VALUES (?, ?, 'merge_execute', ?, ?, 'merge', ?, 0, NULL, ?, ?, ?, ?, ?, 1)`,
      [
        "rcp_other_intent",
        `merge_execute:${fixture.driven.identity}:${pullNumber}`,
        fixture.driven.runId,
        fixture.driven.identity,
        `acme/fixture#${pullNumber}`,
        sha256("a".repeat(40)),
        "sha256:other",
        JSON.stringify({ mergeCommitSha: "a".repeat(40) }),
        "2026-08-12T00:00:00.000Z",
        "2026-08-12T00:00:00.000Z",
      ],
    );
    const refused = await fixture.harness.cp.github.mergeExecute({
      runId: fixture.driven.runId,
      repositoryIdentity: fixture.driven.identity,
      pullNumber,
      exactHeadSha: fixture.driven.candidateHead,
      expectedBaseSha: fixture.driven.baseHead,
      mergeStrategy: "merge_commit",
      ownerSessionId: fixture.driven.ownerSessionId,
      ownerBindingGeneration: fixture.driven.ownerBindingGeneration,
    });
    expect(refused.reasonCode).toBe(ReasonCode.RESOURCE_COLLISION);
  });

  it("#88/#195: refuses a caller-selected strategy that differs from the pinned manifest", async () => {
    const fixture = await ready();
    const refused = await fixture.harness.cp.github.mergeEvaluate({
      runId: fixture.driven.runId,
      repositoryIdentity: fixture.driven.identity,
      pullNumber: 1,
      exactHeadSha: fixture.driven.candidateHead,
      expectedBaseSha: fixture.driven.baseHead,
      mergeStrategy: "squash",
      ownerSessionId: fixture.driven.ownerSessionId,
      ownerBindingGeneration: fixture.driven.ownerBindingGeneration,
    });
    expect(refused.reasonCode).toBe(ReasonCode.MERGE_BRANCH_PROFILE_UNSATISFIED);
  });

  it("#89/#200: refuses a GitHub decision when the run's pinned manifest cannot resolve", async () => {
    const fixture = await ready();
    const manifest = vi.spyOn(fixture.harness.cp.projects, "manifest").mockReturnValue(null);
    try {
      const refused = await fixture.harness.cp.github.prPrepare(fixture.input);
      expect(refused.allowed).toBe(false);
      expect(refused.reasonCode).toBe(ReasonCode.CONTRACT_DIGEST_MISMATCH);
    } finally {
      manifest.mockRestore();
    }
  });

  it("#90: refuses PR preparation when no frozen candidate exists", async () => {
    const fixture = await ready();
    fixture.harness.cp.db.run(`UPDATE runs SET current_candidate_digest = NULL WHERE run_id = ?`, [fixture.driven.runId]);
    const refused = await fixture.harness.cp.github.prPrepare(fixture.input);
    expect(refused.reasonCode).toBe(ReasonCode.EVIDENCE_MISSING);
  });

  it("#91/#198: a changed title cannot replay a PR receipt for the same branch pair", async () => {
    const fixture = await ready();
    const first = await fixture.harness.cp.github.prPrepare(fixture.input);
    if (!first.allowed) throw new Error(first.message);
    const refused = await fixture.harness.cp.github.prPrepare({ ...fixture.input, title: "different operation" });
    expect(refused.reasonCode).toBe(ReasonCode.RESOURCE_COLLISION);
  });

  it("#93/#193: merge evaluation rejects a PR retargeted after preparation", async () => {
    const fixture = await ready();
    const gate = await fixture.harness.cp.github.gatePublish(fixture.payload, fixture.driven.identity);
    if (!gate.allowed) throw new Error(gate.message);
    const pr = await fixture.harness.cp.github.prPrepare(fixture.input);
    if (!pr.allowed) throw new Error(pr.message);
    const pull = fixture.github.pulls.find((entry) => entry.number === pr.value.pullNumber)!;
    pull.base = { ref: "main", sha: fixture.github.headShaFor("main") };
    const refused = await fixture.harness.cp.github.mergeEvaluate({
      runId: fixture.driven.runId,
      repositoryIdentity: fixture.driven.identity,
      pullNumber: pr.value.pullNumber,
      exactHeadSha: fixture.driven.candidateHead,
      expectedBaseSha: fixture.driven.baseHead,
      mergeStrategy: "merge_commit",
      ownerSessionId: fixture.driven.ownerSessionId,
      ownerBindingGeneration: fixture.driven.ownerBindingGeneration,
    });
    expect(refused.reasonCode).toBe(ReasonCode.MERGE_BRANCH_PROFILE_UNSATISFIED);
  });

  it("#94: refuses a gate whose post-write reread does not match the requested success", async () => {
    const fixture = await ready();
    const original = fixture.github.request.bind(fixture.github);
    fixture.github.request = async (method, path, body) => {
      if (method === "GET" && /\/check-runs\/\d+$/.test(path)) {
        const id = Number(/\/(\d+)$/.exec(path)?.[1]);
        const check = fixture.github.checkRuns.find((entry) => entry.id === id)!;
        return { ...check, conclusion: "failure" } as never;
      }
      return original(method, path, body);
    };
    const refused = await fixture.harness.cp.github.gatePublish(fixture.payload, fixture.driven.identity);
    expect(refused.reasonCode).toBe(ReasonCode.GATE_PAYLOAD_PROVENANCE_INVALID);
  });

  it("#95: concurrent gate publication reserves one operation before either remote write", async () => {
    const fixture = await ready();
    const [first, second] = await Promise.all([
      fixture.harness.cp.github.gatePublish(fixture.payload, fixture.driven.identity),
      fixture.harness.cp.github.gatePublish(fixture.payload, fixture.driven.identity),
    ]);
    expect([first.reasonCode, second.reasonCode]).toContain(ReasonCode.OK);
    expect([first.reasonCode, second.reasonCode]).toContain(ReasonCode.RESOURCE_COLLISION);
    expect(fixture.github.checkRuns.filter((check) => check.name === "acp-production-gate")).toHaveLength(1);
  });

  it("#199: required issue numbers are emitted as GitHub-recognised PR linkage, not merely accepted", async () => {
    const fixture = await ready();
    const result = await fixture.harness.cp.github.prPrepare({
      ...fixture.input,
      requireLinkage: true,
      linkedIssues: [123],
    });
    expect(result.reasonCode).toBe(ReasonCode.PR_LINKAGE_MISSING);
    const created = fixture.github.calls.find((call) => call.method === "POST" && call.path.endsWith("/pulls"));
    expect(JSON.stringify(created?.body)).toContain("Closes #123");
  });

  it("#96/#196: a non-release merge receipt cannot authorize a release tag", async () => {
    const fixture = await ready();
    const commit = "r".repeat(40);
    fixture.harness.cp.db.run(
      `INSERT INTO github_receipts
         (receipt_id, idempotency_key, operation, run_id, repository_identity, resource_type, resource_identity,
          preexisting, before_state_digest, after_state_digest, request_digest, response_json, created_at, reread_at, verified)
       VALUES (?, ?, 'merge_execute', ?, ?, 'merge', ?, 0, NULL, ?, ?, ?, ?, ?, 1)`,
      [
        "rcp_non_release",
        `merge_execute:${fixture.driven.identity}:1000`,
        fixture.driven.runId,
        fixture.driven.identity,
        "acme/fixture#1000",
        sha256(commit),
        "sha256:intent",
        JSON.stringify({ mergeCommitSha: commit, sourceBranch: "feature/F1-thing", targetBranch: "dev" }),
        "2026-08-12T00:00:00.000Z",
        "2026-08-12T00:00:00.000Z",
      ],
    );
    const refused = await fixture.harness.cp.github.releaseTag(
      fixture.driven.runId,
      fixture.driven.identity,
      "1.2.3",
      commit,
      { ownerSessionId: fixture.driven.ownerSessionId, ownerBindingGeneration: fixture.driven.ownerBindingGeneration },
    );
    expect(refused.reasonCode).toBe(ReasonCode.RELEASE_TAG_COMMIT_NOT_ACCEPTED);
    expect(fixture.github.tags.size).toBe(0);
  });
});
