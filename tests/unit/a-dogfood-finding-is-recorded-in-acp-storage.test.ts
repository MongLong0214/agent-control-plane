import { afterAll, afterEach, describe, expect, it } from "vitest";

import { COMMITLORE_BINARY_VARIABLE } from "../../src/bootstrap/commitlore-pin.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { cleanTreeManifest, bootstrapOperations } from "../helpers/bootstrap-plan.ts";
import { type Operation, noGitHubCall, ownerApprovalFor, prepareBootstrapRun } from "../helpers/bootstrap-runner.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { approveReviewedCandidateForFinalization, driveToReviewedCandidate, makeHarness } from "../helpers/harness.ts";

/**
 * #1271 — upstream dogfood findings are recorded in ACP's own storage (the state database's audit log) by
 * the production producers: the bootstrap runner's CommitLore probe and observation, and, for
 * frontier-simplify, only the stored blind review whose reviewer performed the check.
 */

afterAll(cleanupTempDirs);

const pinned = process.env[COMMITLORE_BINARY_VARIABLE];
afterEach(() => {
  if (pinned === undefined) delete process.env[COMMITLORE_BINARY_VARIABLE];
  else process.env[COMMITLORE_BINARY_VARIABLE] = pinned;
});

const FINDING_KIND = "UPSTREAM_DOGFOOD_FINDING";

const frontierSimplifyFinding = {
  product: "frontier-simplify",
  kind: "improvement",
  cause: "product",
  basis: "observed",
  reproduced: true,
  signature: "method.no-stop-rule",
  source: "cto.declaration",
  privateEvidenceRef: "a declaration",
  title: "frontier-simplify applied: PASS",
  problem: "Applied.",
  expected: "Applied.",
  actual: "Applied.",
  reproduction: "Applied.",
  productRevision: "0d788506",
  impact: "None.",
  workaround: "None.",
};

describe("a dogfood finding is recorded in ACP storage by its production producer", () => {
  it("a production CommitLore probe failure creates exactly one durable finding, however often it is met", async () => {
    delete process.env[COMMITLORE_BINARY_VARIABLE];
    const prepared = await prepareBootstrapRun("dogfood-probe", {
      manifest: cleanTreeManifest("dogfood-probe", { commitlore: { mode: "required" } }),
      ops: bootstrapOperations() as Operation[],
    });
    const { harness } = prepared;
    const input = { ...prepared.input, ownerApproval: ownerApprovalFor(prepared) };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const refused = await harness.cp.bootstrapProducer.produceAndActivate(input);
      expect(refused, JSON.stringify(refused)).toMatchObject({
        allowed: false,
        reasonCode: ReasonCode.VERIFICATION_GAP,
        evidence: { stage: "precondition", refusal: "COMMITLORE_REQUIRED_NOT_OBSERVED", at: "probe" },
      });
    }
    noGitHubCall(prepared);

    const rows = harness.cp.audit.byKind(FINDING_KIND);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      runId: prepared.runId,
      actor: "repo-factory-bootstrap",
      evidence: {
        product: "commitlore",
        source: "repo-factory.commitlore-observation",
        state: { status: "NOT_REPORTED", reason: "ENVIRONMENT" },
      },
    });
  });

  it("a frontier-simplify finding without the checking actor's bound evidence is refused, and nothing is stored", () => {
    const harness = makeHarness();
    const refused = harness.cp.dogfoodFindings.record(frontierSimplifyFinding, { runId: null, actor: "cto" });
    expect(refused).toMatchObject({ allowed: false, evidence: { refusal: "FRONTIER_SIMPLIFY_EVIDENCE_UNBOUND" } });
    const unbound = harness.cp.dogfoodFindings.recordReviewMethodFindings("run_000000000000000000000000", "art_missing");
    expect(unbound).toMatchObject({ allowed: false, evidence: { refusal: "FRONTIER_SIMPLIFY_EVIDENCE_UNBOUND" } });
    expect(harness.cp.audit.byKind(FINDING_KIND)).toEqual([]);
  });

  it("a review whose reviewer returned a method finding records it bound to that review; a bare PASS records nothing", async () => {
    const plain = makeHarness();
    await driveToReviewedCandidate(plain, { projectId: "dogfood-plain" });
    expect(plain.cp.audit.byKind(FINDING_KIND)).toEqual([]);

    const harness = makeHarness();
    const reviewed = await driveToReviewedCandidate(harness, {
      projectId: "dogfood-method",
      reviewerFindings: [{
        category: "method",
        severity: "MINOR",
        repository: "github:acme/fixture",
        path: null,
        summary: "The method names no rule for when a review round may stop",
        detail: "Three rounds re-raised findings already answered because nothing in the method ends a round.",
      }],
    });
    const review = harness.cp.artifacts.latestForSnapshot(reviewed.runId, "BLIND_REVIEW", reviewed.candidateSnapshotDigest)!;
    const rows = harness.cp.audit.byKind(FINDING_KIND);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      runId: reviewed.runId,
      actor: "blind-review-gate",
      evidence: {
        product: "frontier-simplify",
        source: "blind-review.method-finding",
        title: "The method names no rule for when a review round may stop",
        binding: {
          runId: reviewed.runId,
          artifactId: review.artifactId,
          candidateSnapshotDigest: reviewed.candidateSnapshotDigest,
          contractDigest: reviewed.contractDigest,
          findingIndex: 0,
        },
        state: { status: "QUEUED" },
      },
    });
  });

  it("a method finding, even a BLOCKER, is a dogfood record only: the candidate's review passes the production gate", async () => {
    const harness = makeHarness();
    const reviewed = await driveToReviewedCandidate(harness, {
      projectId: "dogfood-method-blocker",
      reviewerFindings: [{
        category: "method",
        severity: "BLOCKER",
        repository: "github:acme/fixture",
        path: null,
        summary: "The method names no rule for when a review round may stop",
        detail: "Nothing in the method ends a round, so a reviewer can hold any candidate indefinitely.",
      }],
    });
    await expect(approveReviewedCandidateForFinalization(harness, reviewed, { bypassCeoConfirmation: true })).resolves.toBeUndefined();
    const review = harness.cp.artifacts.latestForSnapshot<{ findings: Array<{ category: string }> }>(
      reviewed.runId, "BLIND_REVIEW", reviewed.candidateSnapshotDigest,
    )!;
    expect(review.content.findings.filter((finding) => finding.category === "method")).toEqual([]);
    expect(harness.cp.audit.byKind(FINDING_KIND)).toHaveLength(1);
  });
});
