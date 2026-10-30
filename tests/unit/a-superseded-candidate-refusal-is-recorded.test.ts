import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Role, RunKind, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import type { ReviewPacket } from "../../src/review/blind-review.ts";
import { candidateSnapshotDigest } from "../../src/snapshot/candidate-snapshot.ts";
import { dispatchRun, stricter, type DispatchedRun } from "../helpers/contract-change.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { carryContractChange, makeHarness, registerFixtureProject, type Harness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);
afterEach(() => vi.restoreAllMocks());

/**
 * A CTO runtime move changes the candidate snapshot, so a candidate frozen before the move is superseded
 * by any freeze after it. A submission paused after its reviewer's PASS, whose lease lapsed while another
 * attempt re-froze the run, must not publish that PASS — and the refusal must be on record: one
 * BLIND_REVIEW_REJECTED row naming the candidate the PASS was for, its attempt and its reviewer. Before,
 * the production gate refused the packet as EVIDENCE_STALE and nothing recorded why the PASS went unused.
 */

const ATTEMPT_LEASE_LAPSED_MS = 31 * 60_000;

const contractChange = async (harness: Harness, projectId: string) => {
  const { projectId: registered } = await registerFixtureProject(harness, projectId);
  const run = await dispatchRun(harness, registered, RunKind.CONTRACT_CHANGE);
  carryContractChange(harness, run.runId, stricter(run.base));
  await harness.cp.continuity.evaluate("contract change candidate");
  return { run, projectId: registered };
};

/** Moves the project's CTO conversation to a new runtime, which changes the next candidate snapshot. */
const moveCto = (harness: Harness, projectId: string) => {
  const next = harness.cp.sessions.create({ provider: "scripted", model: "scripted-cto" });
  expect(harness.cp.sessions.transition(next.sessionId, SessionLifecycle.READY, "replacement runtime").allowed).toBe(true);
  const switched = harness.cp.bindings.switchTo({
    role: Role.PRIMARY_CTO,
    projectId,
    sessionId: next.sessionId,
    reason: "the CTO conversation moved runtimes",
    conversation: "SURVIVED",
  });
  expect(switched.allowed, JSON.stringify(switched)).toBe(true);
};

const submit = (harness: Harness, run: DispatchedRun) =>
  harness.cp.pipeline.submitResult({
    runId: run.runId,
    ownerSessionId: run.ownerSessionId,
    ownerBindingGeneration: run.ownerBindingGeneration,
    resultSummary: "change the contract",
    recommendation: "review",
    residualRisk: [],
  });

const rejected = (harness: Harness, runId: string) =>
  harness.cp.audit.forRun(runId).filter((row) => row.kind === "BLIND_REVIEW_REJECTED");

/** The submission attempt that froze `digest`, as its CANDIDATE_FROZEN row records it. */
const attemptThatFroze = (harness: Harness, runId: string, digest: string | null) =>
  harness.cp.audit
    .forRun(runId)
    .find((row) => row.kind === "CANDIDATE_FROZEN" && row.evidence["candidateSnapshotDigest"] === digest)
    ?.evidence["attemptId"];

describe("a candidate superseded by a CTO runtime move", () => {
  it("moved while the reviewer answers, with no re-freeze: the PASS publishes nothing, and the refusal names its candidate and attempt", async () => {
    const harness = makeHarness();
    const { run, projectId } = await contractChange(harness, "identity-moved-in-review");
    const scripted = harness.scripted;
    const invoke = scripted.invoke.bind(scripted);
    let reviewedDigest: string | null = null;
    vi.spyOn(scripted, "invoke").mockImplementation(async (request) => {
      if (/^# Contract change review/.test(request.prompt)) {
        reviewedDigest = harness.cp.runs.currentCandidate(run.runId);
        moveCto(harness, projectId);
      }
      return invoke(request);
    });

    const outcome = await submit(harness, run);
    expect(harness.cp.runs.currentCandidate(run.runId)).toBe(reviewedDigest);
    expect(outcome, JSON.stringify(outcome)).toMatchObject({
      allowed: true,
      value: { stage: "CANDIDATE_STALE", reasonCode: ReasonCode.EVIDENCE_STALE, snapshotDigest: reviewedDigest },
    });
    expect(harness.cp.artifacts.list(run.runId, "PRODUCTION_READY_PACKET")).toEqual([]);
    const rows = rejected(harness, run.runId);
    expect(rows, JSON.stringify(rows)).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      reasonCode: ReasonCode.EVIDENCE_STALE,
      evidence: {
        candidateSnapshotDigest: reviewedDigest,
        attemptId: attemptThatFroze(harness, run.runId, reviewedDigest),
        stale: "CANDIDATE_AT_PUBLICATION",
        reviewReasonCode: ReasonCode.REVIEW_PASS,
      },
    });
  });

  it("re-frozen between a PASS and its publication: nothing is published, and the refusal names the PASS's candidate, attempt and reviewer", async () => {
    const harness = makeHarness();
    const { run, projectId } = await contractChange(harness, "superseded-after-review");
    const continuity = harness.cp.continuity;
    const evaluate = continuity.evaluate.bind(continuity);
    let changed = false;
    let passed: string | null = null;
    let superseding: string | null = null;
    vi.spyOn(continuity, "evaluate").mockImplementation(async (reason: string) => {
      if (reason === "pre-completion" && !changed) {
        changed = true;
        passed = harness.cp.runs.currentCandidate(run.runId);
        moveCto(harness, projectId);
        harness.clock.advance(ATTEMPT_LEASE_LAPSED_MS);
        await submit(harness, run);
        superseding = harness.cp.runs.currentCandidate(run.runId);
      }
      return evaluate(reason);
    });

    const outcome = await submit(harness, run);
    expect(superseding).not.toBe(passed);
    expect(outcome, JSON.stringify(outcome)).toMatchObject({
      allowed: true,
      value: { stage: "CANDIDATE_STALE", reasonCode: ReasonCode.EVIDENCE_STALE, snapshotDigest: passed },
    });
    expect(harness.cp.artifacts.list(run.runId, "PRODUCTION_READY_PACKET")).toEqual([]);
    // The later freeze marked the PASS superseded; it is still the review the refusal names.
    const review = harness.cp.artifacts
      .list<ReviewPacket>(run.runId, "BLIND_REVIEW")
      .find((artifact) => artifact.candidateSnapshotDigest === passed)!;
    expect(review.content.verdict).toBe("PASS");
    const rows = rejected(harness, run.runId);
    expect(rows, JSON.stringify(rows)).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      reasonCode: ReasonCode.EVIDENCE_STALE,
      evidence: {
        candidateSnapshotDigest: passed,
        attemptId: attemptThatFroze(harness, run.runId, passed),
        stale: "CANDIDATE_AT_PUBLICATION",
        reviewReasonCode: ReasonCode.REVIEW_PASS,
        reviewerRoleBindingGeneration: review.content.reviewerRoleBindingGeneration,
      },
    });
  });

  it("re-frozen while the reviewer answers: one refusal names the reviewed candidate, attempt and reviewer, and no verdict is stored", async () => {
    const harness = makeHarness();
    const { run, projectId } = await contractChange(harness, "superseded-in-review");
    const scripted = harness.scripted;
    const invoke = scripted.invoke.bind(scripted);
    let reviewedDigest: string | null = null;
    let superseding: string | null = null;
    let generation = -1;
    vi.spyOn(scripted, "invoke").mockImplementation(async (request) => {
      if (/^# Contract change review/.test(request.prompt)) {
        reviewedDigest = harness.cp.runs.currentCandidate(run.runId);
        generation = harness.cp.bindings.active(roleKeyFor(Role.BLIND_REVIEWER, { runId: run.runId }))!.bindingGeneration;
        moveCto(harness, projectId);
        const frozen = await harness.cp.pipeline.freeze(run.runId);
        expect(frozen.allowed, JSON.stringify(frozen)).toBe(true);
        if (frozen.allowed) superseding = candidateSnapshotDigest(frozen.value);
      }
      return invoke(request);
    });

    await submit(harness, run);
    expect(superseding).not.toBe(reviewedDigest);
    const rows = rejected(harness, run.runId);
    expect(rows, JSON.stringify(rows)).toHaveLength(1);
    expect(rows[0]!.evidence).toMatchObject({
      candidateSnapshotDigest: reviewedDigest,
      attemptId: attemptThatFroze(harness, run.runId, reviewedDigest),
      stale: "REVIEW_INPUTS",
      reviewerRoleBindingGeneration: generation,
    });
    expect(harness.cp.artifacts.list(run.runId, "BLIND_REVIEW")).toEqual([]);
    expect(harness.cp.artifacts.list(run.runId, "PRODUCTION_READY_PACKET")).toEqual([]);
  });
});
