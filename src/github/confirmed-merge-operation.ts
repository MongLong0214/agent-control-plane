import type { Clock } from "../core/clock.ts";
import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { ArtifactStore } from "../db/artifacts.ts";
import { RunState } from "../domain/types.ts";
import type { ProjectRegistry } from "../registry/project-registry.ts";
import type { ReviewPacket } from "../review/blind-review.ts";
import type { RunEngine } from "../run/run-engine.ts";
import type { CandidateSnapshot } from "../snapshot/candidate-snapshot.ts";
import type { VerificationReport } from "../verify/verification-engine.ts";
import {
  NO_HUMAN_GATE_DIGEST,
  type GatePayload,
  type GitHubKernel,
} from "./github-kernel.ts";

/** Input accepted by the daemon/operator surface after the CEO's durable CONFIRM. */
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

export interface ConfirmedMergeResult {
  checkRunId: number;
  pullNumber: number;
  pullUrl: string;
  mergeCommitSha: string;
  replayed: boolean;
}

/** Narrow composition-root ports: this coordinator cannot write artifacts or state itself. */
export interface ConfirmedMergePorts {
  github: Pick<GitHubKernel, "gatePublish" | "prPrepare" | "mergeExecute">;
  runs: Pick<RunEngine, "get" | "currentCandidate">;
  artifacts: Pick<ArtifactStore, "latestForSnapshot">;
  projects: Pick<ProjectRegistry, "manifest">;
  clock: Pick<Clock, "nowIso">;
}

/**
 * The only shipped orchestration path for CP-016. It derives all merge-critical SHA,
 * evidence and owner values from durable state instead of allowing an operator argument
 * to select them. Post-merge checks intentionally run in their own later operation: a
 * successful merge starts CI, and an immediate verification would permanently record a
 * predictable "missing" result before that CI can report.
 */
export const executeConfirmedMerge = async (
  ports: ConfirmedMergePorts,
  input: ConfirmedMergeInput,
): Promise<Decision<ConfirmedMergeResult>> => {
  const run = ports.runs.get(input.runId);
  if (!run) return deny(ReasonCode.NOT_FOUND, "unknown run", { runId: input.runId });
  if (run.state !== RunState.COMPLETED) {
    return deny(
      ReasonCode.GATE_AUTHORITY_DENIED,
      "the GitHub merge operation requires a CEO-confirmed run",
      { runId: input.runId, state: run.state, requiredState: RunState.COMPLETED },
    );
  }
  if (!run.ownerSessionId || run.ownerBindingGeneration == null) {
    return deny(ReasonCode.RUN_OWNER_NOT_PINNED, "confirmed run has no pinned owner", { runId: input.runId });
  }
  if (!run.pinnedManifestDigest) {
    return deny(ReasonCode.CONTRACT_DIGEST_MISMATCH, "confirmed run has no pinned manifest", { runId: input.runId });
  }

  const candidateDigest = ports.runs.currentCandidate(input.runId);
  if (!candidateDigest) {
    return deny(ReasonCode.EVIDENCE_MISSING, "confirmed run has no current candidate", { runId: input.runId });
  }
  const snapshot = ports.artifacts.latestForSnapshot<CandidateSnapshot>(
    input.runId,
    "CANDIDATE_SNAPSHOT",
    candidateDigest,
  );
  const repository = snapshot?.content.repositories.find((entry) => entry.identity === input.repositoryIdentity);
  if (!repository) {
    return deny(ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE, "candidate does not include the requested repository", {
      runId: input.runId,
      repositoryIdentity: input.repositoryIdentity,
    });
  }
  const verification = ports.artifacts.latestForSnapshot<VerificationReport>(
    input.runId,
    "VERIFICATION",
    candidateDigest,
  );
  const review = ports.artifacts.latestForSnapshot<ReviewPacket>(
    input.runId,
    "BLIND_REVIEW",
    candidateDigest,
  );
  if (!verification || !review) {
    return deny(ReasonCode.EVIDENCE_MISSING, "confirmed run is missing merge-gate evidence", {
      runId: input.runId,
      candidateDigest,
      verification: Boolean(verification),
      blindReview: Boolean(review),
    });
  }
  const manifest = ports.projects.manifest(run.pinnedManifestDigest);
  if (!manifest?.branchProfile) {
    return deny(ReasonCode.CONTRACT_DIGEST_MISMATCH, "confirmed run's branch contract is unavailable", {
      runId: input.runId,
      pinnedManifestDigest: run.pinnedManifestDigest,
    });
  }
  const humanGateDigest = input.humanGateDigest ?? (run.humanGateRequired ? null : NO_HUMAN_GATE_DIGEST);
  if (!humanGateDigest) {
    return deny(ReasonCode.HUMAN_GATE_UNSATISFIED, "a human-gated confirmed run needs its current decision digest", {
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
  const gate = await ports.github.gatePublish(payload, input.repositoryIdentity);
  if (!gate.allowed) return gate as Decision<ConfirmedMergeResult>;

  const prepared = await ports.github.prPrepare({
    runId: input.runId,
    repositoryIdentity: input.repositoryIdentity,
    head: input.head,
    base: repository.baseBranch,
    title: input.title,
    body: input.body ?? "",
    declaredParent: input.declaredParent ?? null,
    linkedIssues: input.linkedIssues,
    requireLinkage: input.requireLinkage,
    ownerSessionId: run.ownerSessionId,
    ownerBindingGeneration: run.ownerBindingGeneration,
    exactHeadSha: repository.candidateHead,
  });
  if (!prepared.allowed) return prepared as Decision<ConfirmedMergeResult>;

  const merged = await ports.github.mergeExecute({
    runId: input.runId,
    repositoryIdentity: input.repositoryIdentity,
    pullNumber: prepared.value.pullNumber,
    exactHeadSha: repository.candidateHead,
    expectedBaseSha: repository.baseHead,
    mergeStrategy: manifest.branchProfile.mergeStrategy,
    ownerSessionId: run.ownerSessionId,
    ownerBindingGeneration: run.ownerBindingGeneration,
  });
  if (!merged.allowed) return merged as Decision<ConfirmedMergeResult>;
  return allow(merged.reasonCode, {
    checkRunId: gate.value.checkRunId,
    pullNumber: prepared.value.pullNumber,
    pullUrl: prepared.value.url,
    mergeCommitSha: merged.value.mergeCommitSha,
    replayed: merged.value.replayed,
  });
};
