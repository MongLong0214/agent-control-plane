import Database from "better-sqlite3";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { canonicalJson } from "../../src/core/digest.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { digestArtifactContent } from "../../src/db/artifacts.ts";
import { deriveConfirmedMergePlan, type ConfirmedMergePorts } from "../../src/github/confirmed-merge-operation.ts";
import type { ReviewPacket } from "../../src/review/blind-review.ts";
import type { TaskContract } from "../../src/run/run-engine.ts";
import type { CandidateSnapshot } from "../../src/snapshot/candidate-snapshot.ts";
import type { VerificationReport } from "../../src/verify/verification-engine.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { approveReviewedCandidateForFinalization, driveToReviewedCandidate, makeHarness, reviewerPass } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

type Harness = ReturnType<typeof makeHarness>;
type Driven = Awaited<ReturnType<typeof driveToReviewedCandidate>>;

/**
 * #1270 — a PASS stored before reviews recorded their method: the gate's own packet for the candidate
 * without `inputManifest.methodology`, written to the database file as a daemon of that time wrote it.
 * Returns how to read that row back, to show nothing here rewrites it.
 */
const storePreMethodPass = (h: Harness, driven: Driven): (() => unknown) => {
  const current = h.cp.artifacts.latestForSnapshot<ReviewPacket>(driven.runId, "BLIND_REVIEW", driven.candidateSnapshotDigest)!;
  const { methodology: _methodology, ...inputManifest } = current.content.inputManifest;
  const content = { ...current.content, inputManifest };
  const artifactId = `pre-method-${driven.runId}`;
  const file = new Database(join(h.root, "state.sqlite"));
  try {
    file.function("acp_evidence_write_authorized", () => 1);
    file.prepare(`INSERT INTO run_artifacts (artifact_id, run_id, kind, digest, candidate_snapshot_digest, content_json, produced_by, created_at)
                  VALUES (?, ?, 'BLIND_REVIEW', ?, ?, ?, 'blind-review-gate', ?)`)
      .run(artifactId, driven.runId, digestArtifactContent("BLIND_REVIEW", content, driven.candidateSnapshotDigest),
        driven.candidateSnapshotDigest, canonicalJson(content), h.clock.nowIso());
  } finally {
    file.close();
  }
  const latest = h.cp.artifacts.latestForSnapshot<ReviewPacket>(driven.runId, "BLIND_REVIEW", driven.candidateSnapshotDigest)!;
  expect(latest.content.verdict).toBe("PASS");
  expect(latest.content.inputManifest).not.toHaveProperty("methodology");
  return () => h.cp.db.get("SELECT * FROM run_artifacts WHERE artifact_id = ?", [artifactId]);
};

const confirmPacket = (h: Harness, driven: Driven) => {
  return h.cp.ceo.buildPacket({
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
      approvedAt: h.clock.nowIso(),
    },
  });
};

/** The candidate's fresh review, through the gate's own entry, at the same frozen candidate. */
const reviewAgain = async (h: Harness, driven: Driven): Promise<void> => {
  const run = h.cp.runs.require(driven.runId);
  h.scripted.script({ match: /Candidate review/, text: reviewerPass([`${driven.identity}:src/app.js`]) });
  const reviewed = await h.cp.review.controlPlaneInvoker()({
    runId: driven.runId, projectId: run.projectId, executionMode: run.executionMode,
    snapshot: h.cp.artifacts.latestForSnapshot<CandidateSnapshot>(driven.runId, "CANDIDATE_SNAPSHOT", driven.candidateSnapshotDigest)!.content,
    contract: h.cp.artifacts.latest<TaskContract>(driven.runId, "TASK_CONTRACT")!.content,
    contractDigest: driven.contractDigest,
    verification: h.cp.artifacts.latestForSnapshot<VerificationReport>(driven.runId, "VERIFICATION", driven.candidateSnapshotDigest)!.content,
  });
  expect(reviewed.allowed, JSON.stringify(reviewed).slice(0, 400)).toBe(true);
};

const mergePlan = (h: Harness, driven: Driven) => deriveConfirmedMergePlan({
  github: {} as ConfirmedMergePorts["github"],
  runs: h.cp.runs,
  artifacts: h.cp.artifacts,
  projects: h.cp.projects,
  clock: h.clock,
  daemonFinalizerAuthority: {} as ConfirmedMergePorts["daemonFinalizerAuthority"],
}, { runId: driven.runId, repositoryIdentity: driven.identity, head: driven.candidateHead, title: "finalize" });

describe("#1270: a stored PASS that records no method is not current evidence", () => {
  it("CONFIRM refuses it as stale, leaves its bytes as stored, and admits the candidate's fresh review", async () => {
    const h = makeHarness();
    const driven = await driveToReviewedCandidate(h);
    await h.cp.continuity.evaluate("i1270 confirm");
    const row = storePreMethodPass(h, driven);
    const before = row();

    const refused = confirmPacket(h, driven);
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.EVIDENCE_STALE);
    expect(row()).toEqual(before);

    await reviewAgain(h, driven);
    const admitted = confirmPacket(h, driven);
    expect(admitted.allowed, JSON.stringify(admitted).slice(0, 400)).toBe(true);
    expect(row()).toEqual(before);
  });

  it("the merge plan admits a PASS that records the method and refuses one that records none, leaving its bytes as stored", async () => {
    const h = makeHarness();
    const driven = await driveToReviewedCandidate(h);
    await approveReviewedCandidateForFinalization(h, driven);
    const admitted = mergePlan(h, driven);
    expect(admitted.allowed, JSON.stringify(admitted).slice(0, 400)).toBe(true);

    const row = storePreMethodPass(h, driven);
    const before = row();
    const refused = mergePlan(h, driven);
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.EVIDENCE_STALE);
    expect(row()).toEqual(before);
  });
});
