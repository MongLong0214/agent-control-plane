import type { Clock } from "../core/clock.ts";
import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { ArtifactStore } from "../db/artifacts.ts";
import { ArtifactKind, RunState } from "../domain/types.ts";
import type { DaemonFinalizerAuthority } from "../guard/managed-write-guard.ts";
import type { ProjectRegistry } from "../registry/project-registry.ts";
import type { ReviewPacket } from "../review/blind-review.ts";
import type { RunEngine } from "../run/run-engine.ts";
import type { CandidateSnapshot } from "../snapshot/candidate-snapshot.ts";
import type { VerificationReport } from "../verify/verification-engine.ts";
import {
  NO_HUMAN_GATE_DIGEST,
  type GatePayload,
  type GitHubKernel,
  type MergeInput,
  type PrepareInput,
} from "./github-kernel.ts";

/** Input derived by the daemon from durable run state; never accepted from an MCP caller. */
export interface ConfirmedMergeInput {
  runId: string;
  repositoryIdentity: string;
  /** Candidate branch to prepare; the kernel proves its SHA from the frozen snapshot. */
  head: string;
  title: string;
  body?: string;
  declaredParent?: string | null;
  linkedIssues?: readonly number[];
  requireLinkage?: boolean;
  /** Required only when the immutable task contract has a human gate. */
  humanGateDigest?: string;
}

export interface ConfirmedMergePlan {
  runId: string;
  repositoryIdentity: string;
  candidateSnapshotDigest: string;
  exactHeadSha: string;
  expectedBaseSha: string;
  payload: GatePayload;
  prepare: PrepareInput;
  merge: Omit<MergeInput, "pullNumber">;
}

/**
 * Narrow composition-root ports. The token is deliberately required here: a coordinator
 * assembled by `agentctl`, Hermes, or a CTO has no way to call the external-write steps.
 */
export interface ConfirmedMergePorts {
  github: Pick<GitHubKernel, "gatePublish" | "prPrepare" | "mergeExecute">;
  runs: Pick<RunEngine, "get" | "currentCandidate">;
  artifacts: Pick<ArtifactStore, "latestForSnapshot">;
  projects: Pick<ProjectRegistry, "manifest">;
  clock: Pick<Clock, "nowIso">;
  daemonFinalizerAuthority: DaemonFinalizerAuthority;
}

const FINALIZATION_STATES: ReadonlySet<RunState> = new Set([
  RunState.CEO_APPROVED,
  RunState.MERGING,
  RunState.POST_MERGE_VERIFYING,
]);

/**
 * Reconstruct one repository's immutable finalization plan from durable evidence. The
 * plan contains no caller-selected SHA, contract digest, owner, or merge strategy.
 */
export const deriveConfirmedMergePlan = (
  ports: ConfirmedMergePorts,
  input: ConfirmedMergeInput,
): Decision<ConfirmedMergePlan> => {
  const run = ports.runs.get(input.runId);
  if (!run) return deny(ReasonCode.NOT_FOUND, "unknown run", { runId: input.runId });
  if (!FINALIZATION_STATES.has(run.state)) {
    return deny(
      ReasonCode.GATE_AUTHORITY_DENIED,
      "the GitHub finalization operation requires durable CEO approval",
      { runId: input.runId, state: run.state, requiredStates: [...FINALIZATION_STATES] },
    );
  }
  if (!run.ownerSessionId || run.ownerBindingGeneration == null) {
    return deny(ReasonCode.RUN_OWNER_NOT_PINNED, "CEO-approved run has no pinned owner", { runId: input.runId });
  }
  if (!run.pinnedManifestDigest) {
    return deny(ReasonCode.CONTRACT_DIGEST_MISMATCH, "CEO-approved run has no pinned manifest", { runId: input.runId });
  }

  const candidateDigest = ports.runs.currentCandidate(input.runId);
  if (!candidateDigest) {
    return deny(ReasonCode.EVIDENCE_MISSING, "CEO-approved run has no current candidate", { runId: input.runId });
  }
  const snapshot = ports.artifacts.latestForSnapshot<CandidateSnapshot>(
    input.runId,
    ArtifactKind.CANDIDATE_SNAPSHOT,
    candidateDigest,
  );
  const repository = snapshot?.content.repositories.find((entry) => entry.identity === input.repositoryIdentity);
  if (!snapshot || snapshot.superseded || !repository) {
    return deny(ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE, "candidate does not include the requested repository", {
      runId: input.runId,
      repositoryIdentity: input.repositoryIdentity,
    });
  }
  if (
    snapshot.content.contractDigest !== run.contractDigest ||
    repository.manifestDigest !== run.pinnedManifestDigest
  ) {
    return deny(ReasonCode.CONTRACT_DIGEST_MISMATCH, "candidate no longer proves the pinned contract and manifest", {
      runId: input.runId,
      candidateSnapshotDigest: candidateDigest,
      pinnedManifestDigest: run.pinnedManifestDigest,
    });
  }

  const packet = ports.artifacts.latestForSnapshot<{ candidateSnapshotDigest?: string }>(
    input.runId,
    ArtifactKind.PRODUCTION_READY_PACKET,
    candidateDigest,
  );
  if (!packet || packet.superseded || packet.content.candidateSnapshotDigest !== candidateDigest) {
    return deny(ReasonCode.EVIDENCE_STALE, "CEO-approved run lacks its current production-ready packet", {
      runId: input.runId,
      candidateSnapshotDigest: candidateDigest,
    });
  }
  const verification = ports.artifacts.latestForSnapshot<VerificationReport>(
    input.runId,
    ArtifactKind.VERIFICATION,
    candidateDigest,
  );
  const review = ports.artifacts.latestForSnapshot<ReviewPacket>(
    input.runId,
    ArtifactKind.BLIND_REVIEW,
    candidateDigest,
  );
  if (
    !verification ||
    verification.superseded ||
    verification.content.status !== "PASS" ||
    !review ||
    review.superseded ||
    review.content.verdict !== "PASS"
  ) {
    return deny(ReasonCode.EVIDENCE_MISSING, "CEO-approved run is missing current merge-gate evidence", {
      runId: input.runId,
      candidateSnapshotDigest: candidateDigest,
      verification: Boolean(verification),
      review: Boolean(review),
    });
  }
  const manifest = ports.projects.manifest(run.pinnedManifestDigest);
  if (!manifest?.branchProfile) {
    return deny(ReasonCode.CONTRACT_DIGEST_MISMATCH, "CEO-approved run's branch contract is unavailable", {
      runId: input.runId,
      pinnedManifestDigest: run.pinnedManifestDigest,
    });
  }
  const humanGateDigest = input.humanGateDigest ?? (run.humanGateRequired ? null : NO_HUMAN_GATE_DIGEST);
  if (!humanGateDigest) {
    return deny(ReasonCode.HUMAN_GATE_UNSATISFIED, "a human-gated run needs its current decision digest", {
      runId: input.runId,
    });
  }

  const payload: GatePayload = {
    runId: input.runId,
    candidateSnapshotDigest: candidateDigest,
    contractDigest: run.contractDigest,
    verificationDigest: verification.digest,
    blindReviewDigest: review.digest,
    humanGateDigest,
    bindingGeneration: run.ownerBindingGeneration,
    exactHead: repository.candidateHead,
    timestamp: ports.clock.nowIso(),
  };
  const owner = {
    ownerSessionId: run.ownerSessionId,
    ownerBindingGeneration: run.ownerBindingGeneration,
    daemonFinalizerAuthority: ports.daemonFinalizerAuthority,
  };
  return allow(ReasonCode.OK, {
    runId: input.runId,
    repositoryIdentity: input.repositoryIdentity,
    candidateSnapshotDigest: candidateDigest,
    exactHeadSha: repository.candidateHead,
    expectedBaseSha: repository.baseHead,
    payload,
    prepare: {
      runId: input.runId,
      repositoryIdentity: input.repositoryIdentity,
      head: input.head,
      base: repository.baseBranch,
      title: input.title,
      body: input.body ?? "",
      declaredParent: input.declaredParent ?? null,
      linkedIssues: input.linkedIssues,
      requireLinkage: input.requireLinkage,
      exactHeadSha: repository.candidateHead,
      ...owner,
    },
    merge: {
      runId: input.runId,
      repositoryIdentity: input.repositoryIdentity,
      exactHeadSha: repository.candidateHead,
      expectedBaseSha: repository.baseHead,
      mergeStrategy: manifest.branchProfile.mergeStrategy,
      ...owner,
    },
  });
};

/** Prepare every PR before a gate or merge is released. */
export const prepareConfirmedMerge = async (
  ports: ConfirmedMergePorts,
  plan: ConfirmedMergePlan,
): Promise<Decision<{ pullNumber: number; url: string }>> => ports.github.prPrepare(plan.prepare);

/** Publish the candidate-bound gate after the PR intent is durable. */
export const publishConfirmedMergeGate = async (
  ports: ConfirmedMergePorts,
  plan: ConfirmedMergePlan,
): Promise<Decision<{ checkRunId: number }>> =>
  ports.github.gatePublish(plan.payload, plan.repositoryIdentity, ports.daemonFinalizerAuthority);

/** Execute one already-prepared merge. Exact post-merge verification is a later daemon step. */
export const executePreparedConfirmedMerge = async (
  ports: ConfirmedMergePorts,
  plan: ConfirmedMergePlan,
  pullNumber: number,
): Promise<Decision<{ mergeCommitSha: string; replayed: boolean }>> =>
  ports.github.mergeExecute({ ...plan.merge, pullNumber });
