import { chmodSync } from "node:fs";

import { afterAll, describe, expect, it, vi } from "vitest";

import { digestOf, sha256 } from "../../src/core/digest.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import type { Db } from "../../src/db/database.ts";
import { TrustedCredentialStore } from "../../src/github/credential-store.ts";
import { validateBranchContract } from "../../src/github/branch-contract.ts";
import type { GitHubClient } from "../../src/github/github-kernel.ts";
import * as confirmedMergeOperation from "../../src/github/confirmed-merge-operation.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { FakeGitHub } from "../helpers/fake-github.ts";
import {
  approveReviewedCandidateForFinalization,
  driveToReviewedCandidate,
  installDaemonFinalizerGitHubFixture,
  makeHarness,
} from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

const PROFILE = {
  longLived: ["main", "dev"],
  defaultBranch: "dev",
  updateStrategy: "rebase_before_review" as const,
  mergeStrategy: "merge_commit" as const,
  releaseTagPolicy: "semver" as const,
  releaseBranchCleanup: "keep" as const,
};

/**
 * #76 — an external-write receipt is never inserted APPLIED: it is reserved PENDING before
 * the write and completed once its reread has proved the result. A fixture that needs a
 * historical merge receipt therefore has to model both steps, exactly as the kernel does.
 */
const reservedThenCompletedMerge = (
  db: Db,
  receipt: {
    receiptId: string;
    idempotencyKey: string;
    runId: string;
    repositoryIdentity: string;
    resourceIdentity: string;
    requestDigest: string;
    afterStateDigest: string;
    response: unknown;
  },
): void => {
  db.run(
    `INSERT INTO github_receipts
       (receipt_id, idempotency_key, operation, run_id, repository_identity, resource_type, resource_identity,
        preexisting, before_state_digest, after_state_digest, request_digest, response_json, created_at,
        reread_at, verified, status)
     VALUES (?, ?, 'merge_execute', ?, ?, 'merge', ?, 0, NULL, NULL, ?, '{"pending":true}', ?, NULL, 0, 'PENDING')`,
    [
      receipt.receiptId,
      receipt.idempotencyKey,
      receipt.runId,
      receipt.repositoryIdentity,
      receipt.resourceIdentity,
      receipt.requestDigest,
      "2026-08-12T00:00:00.000Z",
    ],
  );
  db.run(
    `UPDATE github_receipts
        SET status = 'APPLIED', after_state_digest = ?, response_json = ?, reread_at = ?, verified = 1
      WHERE idempotency_key = ? AND status = 'PENDING'`,
    [
      receipt.afterStateDigest,
      JSON.stringify(receipt.response),
      "2026-08-12T00:00:00.000Z",
      receipt.idempotencyKey,
    ],
  );
};

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

const ready = async (
  ciWorkflows: Array<{ path: string; checkName: string; approvedDigest: string | null }> = [],
  options: { preclaimReleaseBranch?: string } = {},
) => {
  const github = new FakeGitHub();
  reflectMergedBase(github);
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
  if (options.preclaimReleaseBranch) {
    // A release tag is a daemon-side effect after CEO confirmation, but its release branch
    // claim must have been established while this run was still allowed to prepare source.
    const releaseClaim = harness.cp.claims.acquire({
      runId: driven.runId,
      ownerSessionId: driven.ownerSessionId,
      ownerBindingGeneration: driven.ownerBindingGeneration,
      ownerRoleKey: harness.cp.runs.require(driven.runId).ownerRoleKey!,
      repositoryIdentity: driven.identity,
      branch: options.preclaimReleaseBranch,
    });
    if (!releaseClaim.allowed) throw new Error(releaseClaim.message);
  }
  await approveReviewedCandidateForFinalization(harness, driven);
  installDaemonFinalizerGitHubFixture(harness);
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
    daemonFinalizerAuthority: harness.cp.daemonFinalizationAuthorities().write,
  };
  return { github, harness, driven, payload, input };
};

type Fixture = Awaited<ReturnType<typeof ready>>;

/**
 * The evidence `releaseTag` demands before it will tag anything: a verified release-to-main
 * merge this run performed, its exact post-merge verification, and the merge present on the
 * default branch.
 */
const acceptedReleaseMerge = (fixture: Fixture, commit: string): void => {
  reservedThenCompletedMerge(fixture.harness.cp.db, {
    receiptId: "rcp_release_merge",
    idempotencyKey: `merge_execute:${fixture.driven.identity}:1200`,
    runId: fixture.driven.runId,
    repositoryIdentity: fixture.driven.identity,
    resourceIdentity: "acme/fixture#1200",
    requestDigest: "sha256:release-intent",
    afterStateDigest: sha256(commit),
    response: { mergeCommitSha: commit, sourceBranch: "release/1.2.0", targetBranch: "main" },
  });
  // A post-merge verification receipt records an observation rather than an external write,
  // so it is one of the kinds the receipt table still accepts as a single APPLIED insert.
  fixture.harness.cp.db.run(
    `INSERT INTO github_receipts
       (receipt_id, idempotency_key, operation, run_id, repository_identity, resource_type, resource_identity,
        preexisting, before_state_digest, after_state_digest, request_digest, response_json, created_at,
        reread_at, verified, status)
     VALUES ('rcp_release_postmerge', ?, 'post_merge_verify', ?, ?, 'commit', ?, 0, NULL, ?, ?, ?, ?, ?, 1, 'APPLIED')`,
    [
      `post_merge_verify:${fixture.driven.identity}:${commit}`,
      fixture.driven.runId,
      fixture.driven.identity,
      `acme/fixture@${commit}`,
      digestOf([{ name: "project-ci", conclusion: "success" }]),
      "sha256:post-merge",
      JSON.stringify({ checks: [{ name: "project-ci", conclusion: "success" }] }),
      "2026-08-12T00:00:00.000Z",
      "2026-08-12T00:00:00.000Z",
    ],
  );
  fixture.github.markContains(PROFILE.defaultBranch, commit);
};

describe("round-two GitHub hardening", () => {
  it("keeps the daemon finalizer as the only high-level merge sequence", () => {
    expect("executeConfirmedMerge" in confirmedMergeOperation).toBe(false);
  });

  it("#77: exposes only the fixed credential-store API", () => {
    const store = new TrustedCredentialStore(tempDir("credential-boundary-"));
    store.install({ token: "never-exposed", creatorIdentity: "acp" });
    const api = Object.getOwnPropertyNames(Object.getPrototypeOf(store));
    expect(api).toEqual(expect.arrayContaining(["availability", "creatorIdentity", "githubApi", "permissionsOk"]));
    expect(api).not.toEqual(expect.arrayContaining(["load", "withToken", "run"]));
  });

  it("#191: rejects a fixture credential after its daemon directory becomes group-readable", async () => {
    const directory = tempDir("credential-mode-");
    const store = new TrustedCredentialStore(directory);
    store.install({ token: "never-exposed", creatorIdentity: "acp" });
    chmodSync(directory, 0o750);
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
      sourceBranch: "dev",
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
      sourceBranch: "release/1.2.0",
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
      preflight: "prepared-base-ref-and-sha",
      postflight: "prepared-base-ref-points-at-merge-commit",
      residualRace: "base-may-move-between-preflight-and-merge",
      proof: "merge-commit-first-parent",
    });
  });

  it("#384: does not advertise an atomic expected-base capability the REST merge endpoint cannot honor", () => {
    const client: GitHubClient = new FakeGitHub();
    expect("supportsAtomicExpectedBase" in client).toBe(false);
    // If a future implementation adds this capability, it must also add a real atomic
    // provider path; silently restoring the old no-op option fails typechecking here.
    // @ts-expect-error GitHubClient deliberately exposes no unsupported atomic-base flag.
    void client.supportsAtomicExpectedBase;
  });

  it("#87/#192: a receipt for the same PR but different merge intent is a resource collision", async () => {
    const fixture = await ready();
    const pullNumber = 999;
    reservedThenCompletedMerge(fixture.harness.cp.db, {
      receiptId: "rcp_other_intent",
      idempotencyKey: `merge_execute:${fixture.driven.identity}:${pullNumber}`,
      runId: fixture.driven.runId,
      repositoryIdentity: fixture.driven.identity,
      resourceIdentity: `acme/fixture#${pullNumber}`,
      requestDigest: "sha256:other",
      afterStateDigest: sha256("a".repeat(40)),
      response: { mergeCommitSha: "a".repeat(40) },
    });
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

  it("#97: refuses a GitHub write when the run owner is revoked during its fenced request", async () => {
    const fixture = await ready();
    const original = fixture.github.request.bind(fixture.github);
    fixture.github.request = async (method, path, body) => {
      if (method === "POST" && /\/pulls$/.test(path)) {
        fixture.harness.cp.db.run(`UPDATE assignments SET status = 'REVOKED' WHERE role_key = ?`, [
          fixture.harness.cp.runs.require(fixture.driven.runId).ownerRoleKey,
        ]);
      }
      return original(method, path, body);
    };

    const result = await fixture.harness.cp.github.prPrepare(fixture.input);

    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe(ReasonCode.RUN_OWNER_REVOKED);
    expect(fixture.github.pulls).toHaveLength(1);
    const receipt = fixture.harness.cp.db.get<{ verified: number }>(
      `SELECT verified FROM github_receipts WHERE operation = 'pr_prepare'`,
    );
    expect(receipt?.verified).toBe(0);
  });

  it("#199: required issue numbers are emitted as GitHub-recognised PR linkage, not merely accepted", async () => {
    const fixture = await ready();
    const result = await fixture.harness.cp.github.prPrepare({
      ...fixture.input,
      requireLinkage: true,
      linkedIssues: [123],
    });
    expect(result.reasonCode).toBe(ReasonCode.OK);
    const created = fixture.github.calls.find((call) => call.method === "POST" && call.path.endsWith("/pulls"));
    expect(JSON.stringify(created?.body)).toContain("Closes #123");
  });

  it("#199: refuses a PR when GitHub does not persist the required linkage", async () => {
    const fixture = await ready();
    const request = fixture.github.request.bind(fixture.github);
    fixture.github.request = async (method, path, body) => {
      if (method === "POST" && path.endsWith("/pulls")) {
        const input = body as { head: string; base: string; title?: string };
        // The remote accepts the create but drops the body. The kernel must fail on its
        // authoritative reread rather than treating the successful POST as proof.
        return request(method, path, { ...input, body: undefined });
      }
      return request(method, path, body);
    };

    const refused = await fixture.harness.cp.github.prPrepare({
      ...fixture.input,
      requireLinkage: true,
      linkedIssues: [123],
    });
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.PR_LINKAGE_MISSING);
    expect(fixture.github.pulls).toHaveLength(1);
  });

  it("#96/#196: a non-release merge receipt cannot authorize a release tag", async () => {
    const fixture = await ready();
    const commit = "r".repeat(40);
    reservedThenCompletedMerge(fixture.harness.cp.db, {
      receiptId: "rcp_non_release",
      idempotencyKey: `merge_execute:${fixture.driven.identity}:1000`,
      runId: fixture.driven.runId,
      repositoryIdentity: fixture.driven.identity,
      resourceIdentity: "acme/fixture#1000",
      requestDigest: "sha256:intent",
      afterStateDigest: sha256(commit),
      response: { mergeCommitSha: commit, sourceBranch: "feature/F1-thing", targetBranch: "dev" },
    });
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

  it("#76: a release tag reserves its receipt before tagging and completes it after the reread", async () => {
    const fixture = await ready([], { preclaimReleaseBranch: "release/1.2.0" });
    const commit = "r".repeat(40);
    acceptedReleaseMerge(fixture, commit);

    const statusAtWrite: Array<string | undefined> = [];
    const original = fixture.github.request.bind(fixture.github);
    fixture.github.request = async (method, path, body) => {
      if (method === "POST" && path.endsWith("/git/refs")) {
        statusAtWrite.push(
          fixture.harness.cp.db.get<{ status: string }>(
            `SELECT status FROM github_receipts WHERE operation = 'release_tag'`,
          )?.status,
        );
      }
      return original(method, path, body);
    };

    const tagged = await fixture.harness.cp.github.releaseTag(
      fixture.driven.runId,
      fixture.driven.identity,
      "1.2.3",
      commit,
      { ownerSessionId: fixture.driven.ownerSessionId, ownerBindingGeneration: fixture.driven.ownerBindingGeneration },
    );
    expect(tagged.reasonCode).toBe(ReasonCode.OK);
    expect(fixture.github.tags.get("1.2.3")).toBe(commit);
    // The reservation existed *before* GitHub was asked to create the ref.
    expect(statusAtWrite).toEqual(["PENDING"]);
    const receipt = fixture.harness.cp.db.get<{
      status: string;
      verified: number;
      preexisting: number;
      reread_at: string | null;
      after_state_digest: string | null;
    }>(
      `SELECT status, verified, preexisting, reread_at, after_state_digest
         FROM github_receipts WHERE operation = 'release_tag'`,
    );
    expect(receipt).toMatchObject({
      status: "APPLIED",
      verified: 1,
      preexisting: 0,
      after_state_digest: sha256(commit),
    });
    expect(receipt?.reread_at).not.toBeNull();

    const replayed = await fixture.harness.cp.github.releaseTag(
      fixture.driven.runId,
      fixture.driven.identity,
      "1.2.3",
      commit,
      { ownerSessionId: fixture.driven.ownerSessionId, ownerBindingGeneration: fixture.driven.ownerBindingGeneration },
    );
    expect(replayed.reasonCode).toBe(ReasonCode.MERGE_IDEMPOTENT_REPLAY);
    expect(fixture.github.calls.filter((call) => call.method === "POST" && call.path.endsWith("/git/refs"))).toHaveLength(1);
  });

  it("#76: a release-tag reservation whose external write never happened is released, not stranded", async () => {
    const fixture = await ready([], { preclaimReleaseBranch: "release/1.2.0" });
    const commit = "r".repeat(40);
    acceptedReleaseMerge(fixture, commit);

    // The guard refuses the fenced write, so no ref was ever created: the reservation is
    // released and the operation stays retryable rather than colliding with itself forever.
    const original = fixture.github.request.bind(fixture.github);
    fixture.github.request = async (method, path, body) => {
      if (method === "GET" && /\/git\/ref\/tags\//.test(path)) {
        fixture.harness.cp.db.run(`UPDATE assignments SET status = 'REVOKED' WHERE role_key = ?`, [
          fixture.harness.cp.runs.require(fixture.driven.runId).ownerRoleKey,
        ]);
      }
      return original(method, path, body);
    };
    const refused = await fixture.harness.cp.github.releaseTag(
      fixture.driven.runId,
      fixture.driven.identity,
      "1.2.3",
      commit,
      { ownerSessionId: fixture.driven.ownerSessionId, ownerBindingGeneration: fixture.driven.ownerBindingGeneration },
    );
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.RUN_OWNER_REVOKED);
    expect(fixture.github.tags.size).toBe(0);
    expect(
      fixture.harness.cp.db.get(`SELECT receipt_id FROM github_receipts WHERE operation = 'release_tag'`),
    ).toBeUndefined();
  });
});
