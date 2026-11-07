import { type CommitLorePort, commitloreGoverned, checkGeneratedCommitMessage, createCommitLoreCliPort } from "../bootstrap/commitlore-observation.ts";
import { randomUUID } from "node:crypto";

import {
  bootstrapPlanIntentTasks,
  bootstrapReviewIntentCurrent,
  currentBootstrapPlan,
  isProjectlessBootstrap,
  sameBootstrapPlanBinding,
} from "../bootstrap/bootstrap-plan.ts";
import { collectBootstrapCeoDecisions, frozenBootstrapCeoDecisions } from "../bootstrap/bootstrap-ceo-decisions.ts";
import { collectBootstrapReviewEvidence } from "../bootstrap/bootstrap-review-evidence.ts";
import { collectStandardReviewEvidence, privateEvidenceAnswer, runHadStandardReviewEvidence } from "../review/standard-review-evidence.ts";
import type { Clock } from "../core/clock.ts";
import { digestOf, sha256 } from "../core/digest.ts";
import { type Decision, type Evidence, acpError, allow, deny, isAcpError } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { commandsForMode, type BranchProfile } from "../contracts/manifest.ts";
import type { VerificationCommand } from "../contracts/verification-command.ts";
import { EVIDENCE_PRODUCERS, type ArtifactStore } from "../db/artifacts.ts";
import type { AuditLog } from "../db/audit.ts";
import type { Db } from "../db/database.ts";
import { OWNERLESS_STALL_OWED, attemptReleasedNoticeKey } from "../doctor/watchdog.ts";
import { ArtifactKind, RunKind, type RunRow, RunState } from "../domain/types.ts";
import { requiredBaseFor, sourceProbeBranchesFor } from "../github/branch-contract.ts";
import { currentBranch, mergeBase, revParse, tryRevParse } from "../git/git.ts";
import { MessageKind } from "../outbox/envelope.ts";
import type { Outbox } from "../outbox/outbox.ts";
import type { ProductionGate, ProductionReadyPacket } from "../ceo/production-gate.ts";
import { currentContractChangeTarget, isContractChangeRun, sameContractChangeBinding, type WorkflowRevision } from "../registry/contract-change-plan.ts";
import { contractChangeRevertFactsOf, firstActivationFactsOf } from "../registry/manifest-activation-grants.ts";
import type { ProjectRegistry } from "../registry/project-registry.ts";
import type { RepositoryRegistry } from "../registry/repository-registry.ts";
import { residentBaseClone } from "../registry/resident-repositories.ts";
import type { BlindReviewGate, BlindReviewInvoker, ReviewPacket, ReviewProgressStep } from "../review/blind-review.ts";
import { captureContractChangeReviewContext, readCanonicalCtoIdentity, storeContractChangeReviewContext } from "../review/contract-change-review-context.ts";
import type { BindingRegistry } from "../session/binding-registry.ts";
import {
  type CandidateSnapshot,
  type SnapshotRepositoryInput,
  type SnapshotReviewEvidence,
  buildCandidateSnapshot,
  buildNoRepositoryCandidateSnapshot,
  candidateSnapshotDigest,
  expectedCheckoutHead,
  verifySnapshotFreshness,
} from "../snapshot/candidate-snapshot.ts";
import type { Telemetry } from "../telemetry/telemetry.ts";
import { type VerificationEngine, type VerificationReport, reportWithoutCapturedOutput } from "../verify/verification-engine.ts";
import {
  BASE_REF_NAMESPACE,
  CANDIDATE_REF_NAMESPACE,
  type SucceededTaskCommit,
  applyCandidateRefPlan,
  baseRefFor,
  candidateRefFor,
  candidateRefPlan,
  type CheckMergeMessage,
  type MergeCheckBinding,
  PREDECESSOR_BASE_MERGES_CHECKED,
  checkoutHeadAsCandidate,
  checkoutHeadNow,
  foreignCandidateCommit,
  integratePredecessors,
  integrateTaskResults,
  lostTaskChanges,
  recordedPredecessorMergeChecks,
  succeededTaskCommits,
  supersessionOf,
  undoCandidateRefLines,
} from "./candidate-integration.ts";
import type { RunEngine, TaskContract } from "./run-engine.ts";
import type { TaskGraph } from "./task-graph.ts";
import { type PredecessorBase, type StartsFrom, recordedTargetForBranch, recordedWriteTarget } from "./task-write-target.ts";
import type { ManagedWriteGuard } from "../guard/managed-write-guard.ts";

/** An attempt's lease: set at acquisition, and renewed to this from now on each real step. */
const ATTEMPT_LEASE_TTL_MS = 30 * 60 * 1000;
/**
 * However it progresses, an attempt holds the run at most this long from acquisition: no renewal sets a
 * deadline past it, so at the cap the lease lapses and is reclaimed as an unrenewed one is.
 */
const ATTEMPT_LEASE_CAP_MS = 120 * 60 * 1000;

/**
 * The BLIND_REVIEW_UNAVAILABLE row, built field by field and never spread from the denial. A denial
 * can carry provider text, and one free-form string over the audit's bound for an unlisted field
 * makes the audit keep none of the row: not the reason, and not the candidate the official retry
 * (daemon `#bootstrapReviewRetry`) matches on. So the row holds the candidate this attempt froze, the
 * scalar fields named here when their values are numbers, booleans or bounded identifiers (digests
 * and lengths stand in for provider text), and the reviewer attempts by preference and fixed reason.
 * The denial's reason is the row's reason code.
 */
const UNAVAILABLE_REVIEW_FIELDS = [
  "runId", "provider", "model", "effort", "problem", "chunk", "exitCode", "isolationAttested",
  "isolationReasonCode", "answerDigest", "answerLength", "errorDigest", "errorLength",
  "isolationDetailDigest", "isolationDetailLength",
] as const;
const BOUNDED_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/#+-]{0,199}$/;
const ATTEMPT_REASON = /^[A-Za-z0-9][A-Za-z0-9 ._:-]{0,119}$/;
const boundedScalar = (value: unknown, shape: RegExp = BOUNDED_IDENTIFIER): string | number | boolean | null | undefined => {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  return typeof value === "string" && shape.test(value) ? value : undefined;
};

const unavailableReviewEvidence = (candidateSnapshotDigest: string, denial: Evidence | undefined, attemptId: string): Evidence => {
  const source: Record<string, unknown> = denial ?? {};
  const evidence: Record<string, unknown> = {};
  for (const field of UNAVAILABLE_REVIEW_FIELDS) {
    const value = boundedScalar(source[field]);
    if (value !== undefined) evidence[field] = value;
  }
  const attempts = source["attempts"];
  if (Array.isArray(attempts)) {
    evidence["attempts"] = attempts.slice(0, 20).map((attempt: unknown) => {
      const record = (attempt ?? {}) as { preference?: Record<string, unknown>; reason?: unknown };
      return {
        preference: {
          provider: boundedScalar(record.preference?.["provider"]) ?? null,
          model: boundedScalar(record.preference?.["model"]) ?? null,
          effort: boundedScalar(record.preference?.["effort"]) ?? null,
        },
        reason: boundedScalar(record.reason, ATTEMPT_REASON) ?? null,
      };
    });
  }
  evidence["candidateSnapshotDigest"] = candidateSnapshotDigest;
  // #1189 — the submission attempt that wrote this row, so a reader can tell it from another attempt's.
  evidence["attemptId"] = attemptId;
  return evidence as Evidence;
};

/**
 * The REVISION_RETURNED_TO_CTO row, built field by field as the UNAVAILABLE row is. The revision
 * delivered to the CTO carries the review packet or the verification report whole, and spread into
 * the row the reviewer's findings text (and the packet's egress JSONL) made the audit refuse it: the
 * row kept `{auditEvidenceRejected:true}`, its stage and candidate gone with the rest (live run_7717,
 * both REVISE rounds). So the row keeps the stage, the candidate, counts, severities and digests, and
 * names the stored BLIND_REVIEW artifact by digest; the findings themselves are read from that
 * verified artifact, never from the audit. The delivery is unchanged.
 */
const FINDING_SEVERITIES = ["INFO", "MINOR", "MAJOR", "BLOCKER"] as const;
const MAX_AUDITED_FINDING_DIGESTS = 50;

const revisionAuditEvidence = (
  delivered: Record<string, unknown>,
  review: { digest: string; content: ReviewPacket } | null,
): Evidence => {
  const candidateSnapshotDigest = boundedScalar(delivered["candidateSnapshotDigest"]) ?? null;
  if (delivered["stage"] === "verification") {
    const report = (delivered["report"] ?? null) as Partial<VerificationReport> | null;
    return {
      stage: "verification",
      candidateSnapshotDigest,
      reportDigest: digestOf(report),
      status: boundedScalar(report?.status) ?? null,
      expectedInputs: boundedScalar(report?.expectedInputs) ?? null,
      observedInputs: boundedScalar(report?.observedInputs) ?? null,
      results: Array.isArray(report?.results) ? report.results.length : null,
      gaps: Array.isArray(report?.gaps) ? report.gaps.length : null,
    } as Evidence;
  }
  if (review === null) return { stage: "blind-review", candidateSnapshotDigest, reviewArtifactDigest: null } as Evidence;
  const packet = review.content;
  const findings = Array.isArray(packet.findings) ? packet.findings : [];
  const planDigest = packet.bootstrapPlan?.planDigest ?? packet.contractChange?.planDigest;
  return {
    stage: "blind-review",
    candidateSnapshotDigest,
    reviewArtifactDigest: review.digest,
    reviewKind: packet.bootstrapPlan ? "BOOTSTRAP_PLAN" : packet.contractChange ? "CONTRACT_CHANGE" : "CANDIDATE",
    verdict: boundedScalar(packet.verdict) ?? null,
    findings: findings.length,
    findingsBySeverity: Object.fromEntries(
      FINDING_SEVERITIES.map((severity) => [severity, findings.filter((finding) => finding.severity === severity).length]),
    ),
    // A review that read private evidence keeps no digest of its reviewer's text here: a short text is guessable from one.
    ...(packet.inputManifest?.reviewEvidence === undefined
      ? { findingDigests: findings.slice(0, MAX_AUDITED_FINDING_DIGESTS).map((finding) => digestOf(finding)) } : {}),
    coveredFiles: packet.coveredFiles.length,
    omittedItems: packet.omittedItems.length,
    ...(planDigest === undefined ? {} : { planDigest: boundedScalar(planDigest) ?? null }),
    ...(packet.bootstrapPlanIntentDigest === undefined ? {} : { bootstrapPlanIntentDigest: boundedScalar(packet.bootstrapPlanIntentDigest) ?? null }),
  } as Evidence;
};

/**
 * F1 — what the owning CTO is told, in band, when a review did not judge the product: a review that answered on
 * method findings alone, or one that could not be constituted. It is no revision request for the product. The
 * text is fixed here and never carries reviewer text; the reason code beside it is the gate's own.
 */
export const UNJUDGED_REVIEW_NOTICES = {
  METHOD_FINDINGS_ONLY:
    "This is not a product revision. The blind review answered on review-method findings alone, so it did not judge the product. Keep the PLAN and the code exactly as they are and change nothing.",
  REVIEW_UNAVAILABLE:
    "This is not a product revision. The blind review could not judge the product: assurance could not be constituted, for the reason code given. Keep the PLAN and the code exactly as they are and change nothing.",
} as const;

/** F1 — how many unjudged reviews in a row one unchanged candidate gets before its owner is sent to escalation. */
export const UNJUDGED_REVIEW_LIMIT = 2;

/** F1 — the one next step a notice gives, chosen by `unjudgedAttempts` against `UNJUDGED_REVIEW_LIMIT`. */
export const UNJUDGED_REVIEW_NEXT_STEPS = {
  RESUBMIT:
    "Next step: once the result_submit of the attempt this notice names (attemptId) has answered, call result_submit again with a new idempotencyKey; that freezes the candidate afresh and runs a fresh review. Resubmit only while unjudgedAttempts is below unjudgedAttemptLimit.",
  ESCALATE:
    "Next step: this unchanged candidate has had unjudgedAttemptLimit unjudged reviews in a row, so ACP refuses another result_submit of it; do not resubmit it. Open a CEO escalation for this run with escalation_open, then acknowledge this notice.",
} as const;

/** F1 — the refusal of a result_submit for a candidate already unjudged `UNJUDGED_REVIEW_LIMIT` times in a row. */
export const UNJUDGED_REVIEW_LIMIT_REFUSAL =
  "refused: this same unchanged candidate already went unjudged unjudgedAttemptLimit times in a row, so nothing was verified or reviewed for this submission. Do not resubmit it; open a CEO escalation for this run with escalation_open.";
/** F1 — the audit row a refused submission leaves, so the refusal never counts as an attempt that ended the run of unjudged ones. */
const UNJUDGED_REVIEW_LIMIT_REFUSED = "UNJUDGED_REVIEW_LIMIT_REFUSED";

/**
 * #1189 — the answer of a submission whose attempt no longer holds the run (released, reclaimed, expired, at its cap,
 * or its owner binding moved on), so nothing of its result is applied: `attemptLost`, and a review that answered such
 * an attempt without a verdict, whose reason code is the review's own. The text is fixed and never carries reviewer
 * text, so a run with private review evidence is answered with it unchanged. It gives no resubmit instruction.
 */
export const STALE_ATTEMPT_NOT_APPLIED =
  "not applied: this submission's attempt no longer holds the run, so nothing of its result was applied (no verdict, candidate state, revision or notice). This is not an unavailable review of the run's current candidate. What happens next follows from the run's current attempt and state, not from this answer: read the current run state.";

/** #1344 C1 — the owner CTO's notice that ACP released an attempt of its run (`noticeAttemptReleased`). */
export const ATTEMPT_RELEASED_NOTICE = "attempt released, outcome not applied; submit a fresh result";
const ATTEMPT_RELEASED_RECOVERY =
  "Change no PLAN, task or code. Submit that run's result once with mcp__acp-cto__result_submit and a new idempotencyKey, then acknowledge this message with mcp__acp-cto__run_ack.";

/**
 * #1344 B — the audit row that binds a result_submit's idempotency key (as a digest) and MCP request fingerprint to the
 * attempt it started, written with the attempt row; and the row of what that attempt answered (`AttemptEnd`). A replay
 * of the key whose response was never stored is answered from them (`replaySubmission`).
 */
export const CANDIDATE_PIPELINE_ATTEMPT_STARTED = "CANDIDATE_PIPELINE_ATTEMPT_STARTED";
export const CANDIDATE_PIPELINE_ATTEMPT_ENDED = "CANDIDATE_PIPELINE_ATTEMPT_ENDED";
/** #1344 B — a replay's answer when ACP released the attempt its key started: definite, never an unknown outcome. */
export const REPLAYED_ATTEMPT_RELEASED = "attempt released, outcome not applied; submit with a new idempotencyKey";
/** #1344 B — a replay's answer when the attempt its key started ended on an error before any outcome was applied. */
export const REPLAYED_ATTEMPT_ERRORED = "attempt ended with an error; outcome not applied; submit with a new idempotencyKey";
const REPLAYED_ATTEMPT_REFUSED = "the first result_submit with this idempotencyKey was answered with this refusal; nothing was run again";

/**
 * #1344 B — how an attempt ended, as its ENDED row records it: `APPLIED`, an outcome committed in the same transaction
 * as this row (`applyHolding`, the only place an attempt applies one); `NOT_APPLIED`, an answer that applied nothing (a
 * refusal, a stale candidate, a lost hold); `ERRORED`, a throw with no outcome applied. So no applied outcome is ever
 * without its row, and an attempt without an APPLIED row applied none.
 */
type AttemptEnd = "APPLIED" | "NOT_APPLIED" | "ERRORED";

/** #1344 B — what an attempt answered, as its ENDED row records it. */
interface AttemptReceipt {
  allowed: boolean;
  reasonCode: ReasonCode;
  stage: PipelineOutcome["stage"] | null;
  stageReasonCode: string | null;
  candidateSnapshotDigest: string | null;
}

const appliedStage = (stage: PipelineOutcome["stage"], snapshotDigest: string, stageReasonCode: string | null = null): AttemptReceipt =>
  ({ allowed: true, reasonCode: ReasonCode.OK, stage, stageReasonCode, candidateSnapshotDigest: snapshotDigest });
const appliedRefusal = (reasonCode: ReasonCode, snapshotDigest: string): AttemptReceipt =>
  ({ allowed: false, reasonCode, stage: null, stageReasonCode: null, candidateSnapshotDigest: snapshotDigest });
const receiptOf = (outcome: Decision<PipelineOutcome>): AttemptReceipt => {
  if (outcome.allowed) {
    return { allowed: true, reasonCode: outcome.reasonCode, stage: outcome.value.stage,
      stageReasonCode: "reasonCode" in outcome.value ? outcome.value.reasonCode : null, candidateSnapshotDigest: outcome.value.snapshotDigest };
  }
  const digest = outcome.evidence["candidateSnapshotDigest"];
  return { allowed: false, reasonCode: outcome.reasonCode, stage: null, stageReasonCode: null,
    candidateSnapshotDigest: typeof digest === "string" ? digest : null };
};
/** The digest a result_submit idempotency key is recorded under; the key itself is never stored. */
const resultSubmitKeyDigestOf = (idempotencyKey: string): string =>
  sha256(JSON.stringify(["acp.result-submit.key.v1", idempotencyKey]));

export interface SubmitResultInput {
  runId: string;
  ownerSessionId: string;
  ownerBindingGeneration: number;
  resultSummary: string;
  recommendation: string;
  residualRisk?: string[];
  /**
   * Run-scoped verification commands. Used only when the repository has no active
   * project manifest (§17.5); otherwise the pinned contract's commands win.
   */
  runScopedCommands?: readonly VerificationCommand[];
  /**
   * Told of each real step once it has renewed the attempt's lease: a verification command, a review
   * chunk, the final review starting and ending. What it does never decides the submission.
   */
  onProgress?: (step: SubmissionProgressStep) => void;
  /**
   * #1344 B — the result_submit request this submission answers: its idempotency key and MCP request fingerprint. The
   * attempt it starts, and what that attempt answers, are recorded under them (`replaySubmission`).
   */
  replayIdentity?: { idempotencyKey: string; requestFingerprint: string };
}

/** A real step of a submission: the only thing that renews its attempt lease. */
export type SubmissionProgressStep = "VERIFICATION_COMMAND_COMPLETED" | ReviewProgressStep;

export type PipelineOutcome =
  | { stage: "COMPLETED_REVIEW"; packet: ProductionReadyPacket; snapshotDigest: string }
  | { stage: "REVISION_REQUIRED"; reasonCode: string; snapshotDigest: string; review?: ReviewPacket }
  | { stage: "VERIFICATION_FAILED"; reasonCode: string; snapshotDigest: string; report: VerificationReport }
  /**
   * §18.7 — assurance could not be constituted. Editing the candidate cannot fix a lost
   * reviewer isolation or a dead provider, so this is *not* a revision request: the run
   * waits, and continuity decides.
   */
  | {
      stage: "REVIEW_UNAVAILABLE";
      reasonCode: string;
      snapshotDigest: string;
      /**
       * Why assurance could not be constituted, not merely that it could not (#512).
       *
       * `ISOLATION_LOST` is returned from about twenty places across the reviewer path — adapter
       * not registered, adapter cannot enforce, no fresh session attested, a named probe refused,
       * egress evidence incomplete. Each of those denials already carries a distinct message and
       * evidence, and `blind-review.ts` went to the trouble of recording *which probe* refused
       * rather than only that one did. This stage dropped all of it and reported the code alone,
       * so a live run failed with a verdict that named twenty possible causes and none of them.
       *
       * The audit event beside this one keeps the evidence, so the fact was durable — it just was
       * not in the answer the caller received, which is where someone reads it.
       */
      detail: { message: string; evidence: Evidence };
    }
  /**
   * The source moved while the candidate was being judged; all its evidence is stale. Review of
   * 2bf6f98c — a freshness denial after the review keeps its message and evidence here (`detail`),
   * so what to do next (a fresh-key plan_submit) is in this answer rather than the next one.
   */
  | { stage: "CANDIDATE_STALE"; reasonCode: string; snapshotDigest: string; detail?: { message: string; evidence: Evidence } };

/**
 * A durable submission lease that a watchdog reclaimed after its holder disappeared.
 * `deadlineAt` is the deadline persisted when the lease was acquired. Recovery must honor
 * that fact rather than reconstructing a potentially changed policy from `startedAt` (#335).
 */
export interface ReclaimedCandidatePipelineAttempt {
  runId: string;
  attemptId: string;
  startedAt: string;
  deadlineAt: string;
  ageMs: number;
}

/**
 * The candidate completion path (PRD §§16–19).
 *
 * Freeze → verify → *automatically* blind review → production-ready packet. The
 * automatic step is the point: §18.2 gives the control plane the invocation, and no
 * agent-facing operation can skip, reorder or repeat it against stale evidence. A
 * REVISE verdict returns to the CTO here and never reaches Hermes (§18.6, CP-S33).
 */
/**
 * #1268 — the first frozen repository whose registered checkout's HEAD is not the one its candidate was frozen
 * from (`expectedCheckoutHead`), or null when none moved.
 */
const movedCheckoutHead = async (
  frozen: readonly { identity: string; candidateHead: string; integration?: CandidateSnapshot["repositories"][number]["integration"] }[],
  repositories: readonly { identity: string; checkoutPath: string }[],
): Promise<Record<string, unknown> | null> => {
  for (const repository of frozen) {
    const checkoutPath = repositories.find((repo) => repo.identity === repository.identity)!.checkoutPath;
    const expected = expectedCheckoutHead(repository);
    const observed = await tryRevParse(checkoutPath, "HEAD");
    if (observed !== expected) {
      return { repositoryIdentity: repository.identity, candidateHead: repository.candidateHead, expectedCheckoutHead: expected, observedCheckoutHead: observed };
    }
  }
  return null;
};

/** #1268 — `movedCheckoutHead`, read with nothing awaited (`checkoutHeadNow`), for a decision inside one transaction. */
const movedCheckoutHeadNow = (
  frozen: readonly { identity: string; candidateHead: string; integration?: CandidateSnapshot["repositories"][number]["integration"] }[],
  repositories: readonly { identity: string; checkoutPath: string }[],
): Record<string, unknown> | null => {
  for (const repository of frozen) {
    const checkoutPath = repositories.find((repo) => repo.identity === repository.identity)!.checkoutPath;
    const expected = expectedCheckoutHead(repository);
    const observed = checkoutHeadNow(checkoutPath);
    if (observed !== expected) {
      return { repositoryIdentity: repository.identity, candidateHead: repository.candidateHead, expectedCheckoutHead: expected, observedCheckoutHead: observed };
    }
  }
  return null;
};

export class CandidatePipeline {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly audit: AuditLog,
    private readonly artifacts: ArtifactStore,
    private readonly runs: RunEngine,
    private readonly tasks: TaskGraph,
    private readonly projects: ProjectRegistry,
    private readonly repositories: RepositoryRegistry,
    private readonly verification: VerificationEngine,
    private readonly review: BlindReviewGate,
    private readonly invokeReview: BlindReviewInvoker,
    private readonly ceo: ProductionGate,
    private readonly bindings: BindingRegistry,
    private readonly outbox: Outbox,
    private readonly telemetry: Telemetry,
    private readonly guard: ManagedWriteGuard,
  ) {}

  #continuity: { evaluate?(reason: string): Promise<unknown> } | null = null;
  /** The attempts this process runs, each with what stops its reviewer and verification children. */
  readonly #attempts = new Map<string, AbortController>();
  /**
   * #1268 — the CommitLore the merge commit messages of a run whose contract requires it are checked by. Defaults
   * to the pinned CLI (`createCommitLoreCliPort`); null is a deployment with none, where such a merge is not made.
   */
  #commitlore: CommitLorePort | null = createCommitLoreCliPort();

  attach(ports: { continuity?: { evaluate?(reason: string): Promise<unknown> }; commitlore?: CommitLorePort | null }): void {
    if (ports.continuity) this.#continuity = ports.continuity;
    if (ports.commitlore !== undefined) this.#commitlore = ports.commitlore;
  }

  /** #1268 — the message check a run's merge commits get, or none when its contract does not require CommitLore. */
  private checkMergeMessages(runId: string): CheckMergeMessage | undefined {
    if (!commitloreGoverned(this.db, runId)) return undefined;
    return (input) => checkGeneratedCommitMessage(this.#commitlore, input);
  }

  /**
   * Freeze the candidate across every repository participating in the run (§16.2). A submission
   * passes its attempt id, which the CANDIDATE_FROZEN row then names (#1189).
   */
  async freeze(runId: string, attemptId?: string): Promise<Decision<CandidateSnapshot>> {
    const run = this.runs.get(runId);
    if (!run) return deny(ReasonCode.NOT_FOUND, "unknown run", { runId });

    const participants = this.runs.repositoriesOf(runId);

    // This is the dispatch-time contract, so a later project-profile change cannot alter
    // the branch a frozen candidate is asserted to have been cut from.
    const profile: BranchProfile | null = run.pinnedManifestDigest
      ? (this.projects.manifest(run.pinnedManifestDigest)?.branchProfile ?? null)
      : null;
    const tasks = participants.length === 0 ? [] : this.tasks.list(runId);
    // One read of the run's SUCCEEDED task commits: what the integration places and what the
    // missing-commit guard below asks the final candidate for are the same commits (S6-B, S6-C).
    const commits = participants.length === 0 ? [] : succeededTaskCommits(this.db, runId);
    // CEO msg_8f666e55 — the task results are those commits less what a registered correction supersedes; the
    // integration and its missing-commit and missing-change checks read these alone. Every receipt still accounts
    // for its own commit (#1268) and binds its imports (#1232), superseded or not.
    const supersession = supersessionOf(this.db, runId, commits);
    const results = commits.filter((commit) => !supersession.superseded.has(commit.taskId));
    const repositories: SnapshotRepositoryInput[] = [];
    // #1268 — every merge commit the integration makes has its message checked by CommitLore when the run requires it.
    const checkMergeMessages = this.checkMergeMessages(runId);
    const commitloreMergeChecks = new Map<string, MergeCheckBinding[]>();
    // #1268 — a run whose contract requires CommitLore: before any repository's integration builds or writes
    // anything, in every repository, every SUCCEEDED task commit and every commit between the run's pinned base and
    // it, and the range of a candidate that will be the checkout's HEAD, is a worker commit of this run whose
    // CommitLore evidence matches the commit's own Record-Id trailers, or a merge recorded for a predecessor base a
    // task of this run starts from. What an integration then adds is only its own merges.
    const accounted = new Set<string>();
    const refuseForeign = (evidence: Record<string, unknown>): Decision<CandidateSnapshot> =>
      deny(ReasonCode.CANDIDATE_FOREIGN_COMMIT, "a commit in the candidate is not one this run's CommitLore path accounts for; nothing was frozen", {
        runId,
        ...evidence,
      });
    if (checkMergeMessages !== undefined) {
      for (const repo of participants) {
        const mergeChecks = recordedPredecessorMergeChecks(this.db, runId, repo.identity);
        for (const task of commits.filter((commit) => commit.repositoryIdentity === repo.identity)) {
          const target = recordedWriteTarget(this.db, runId, task.taskId);
          // A commit with no write target here is not integrated; the candidate's own range check below asks it.
          if (!target || target.repositoryIdentity !== repo.identity) continue;
          const foreign = await foreignCandidateCommit({
            db: this.db,
            runId,
            repositoryIdentity: repo.identity,
            checkoutPath: repo.checkoutPath,
            baseHead: target.baseSha,
            candidateHead: task.commit,
            mergeChecks,
            accounted,
          });
          if (!foreign.allowed) return foreign as Decision<CandidateSnapshot>;
          if (foreign.value !== null) {
            return refuseForeign({ repositoryIdentity: repo.identity, taskId: task.taskId, baseHead: target.baseSha, candidateHead: task.commit, ...foreign.value });
          }
        }
        // A candidate that will be this checkout's HEAD (the integration takes it as it is) is asked now too, from the
        // base its snapshot will be frozen with (`sourceAtFreeze`, else the base branch), read-only like the rest.
        const head = await checkoutHeadAsCandidate({ db: this.db, runId, tasks, commits: results, repositoryIdentity: repo.identity, checkoutPath: repo.checkoutPath });
        if (!head.allowed) return head as Decision<CandidateSnapshot>;
        if (head.value === null) continue;
        const source = await this.sourceAtFreeze(repo.checkoutPath, repo.workBranch, repo.baseBranch, profile, { runId, identity: repo.identity });
        const baseHead = source.taskBaseHead ?? (await tryRevParse(repo.checkoutPath, repo.baseBranch)) ?? "";
        const foreign = await foreignCandidateCommit({
          db: this.db,
          runId,
          repositoryIdentity: repo.identity,
          checkoutPath: repo.checkoutPath,
          baseHead,
          candidateHead: head.value,
          mergeChecks,
          accounted,
        });
        if (!foreign.allowed) return foreign as Decision<CandidateSnapshot>;
        if (foreign.value !== null) return refuseForeign({ repositoryIdentity: repo.identity, baseHead, candidateHead: head.value, ...foreign.value });
      }
    }
    for (const repo of participants) {
      // S6-C — when the checkout's HEAD does not hold every SUCCEEDED task's commit, the candidate is
      // their integration onto the run's pinned base; a conflict between two tasks refuses the freeze.
      const integrated = await integrateTaskResults({
        db: this.db,
        runId,
        tasks,
        commits: results,
        measuredFromBase: supersession.terminals,
        repositoryIdentity: repo.identity,
        checkoutPath: repo.checkoutPath,
        worktree: (input, use) => this.verification.withRunWorktree(run, input, use),
        ...(checkMergeMessages === undefined ? {} : { checkMessage: checkMergeMessages }),
      });
      if (!integrated.allowed) return integrated as Decision<CandidateSnapshot>;
      // Recorded where a check was required or made; a run that requires none keeps its evidence as it was.
      if (integrated.value !== null && (checkMergeMessages !== undefined || integrated.value.commitloreMergeChecks.length > 0)) {
        commitloreMergeChecks.set(repo.identity, integrated.value.commitloreMergeChecks);
      }
      // The integrated candidate's origin is its tasks' recorded one (S-TB-06), as one task's is below.
      const source = integrated.value === null
        ? await this.sourceAtFreeze(repo.checkoutPath, repo.workBranch, repo.baseBranch, profile, { runId, identity: repo.identity })
        : profile
          ? { sourceBranch: integrated.value.declaredParent, sourceHead: integrated.value.baseSha, taskBaseHead: integrated.value.baseSha }
          : { sourceBranch: null, sourceHead: null, taskBaseHead: integrated.value.baseSha };
      const taskBaseHead = integrated.value?.baseSha ?? source.taskBaseHead;
      repositories.push({
        identity: repo.identity,
        repositoryRole: repo.repositoryRole,
        checkoutPath: repo.checkoutPath,
        baseBranch: repo.baseBranch,
        baseRef: taskBaseHead ?? repo.baseBranch,
        ...(taskBaseHead === null ? {} : { baseHeadPinned: true as const }),
        sourceBranch: source.sourceBranch,
        sourceHead: source.sourceHead,
        worktreeId: repo.worktreeId,
        manifestDigest: this.repositories.byIdentity(repo.identity)?.activeManifestDigest ?? null,
        ...(integrated.value === null ? {} : { candidateRef: integrated.value.head, integration: integrated.value.integration }),
        // #1232 — the same receipts' import manifests: an import the candidate holds byte for byte is
        // bound by blob and sha256, and its patch is not materialised (`buildCandidateSnapshot`).
        imports: commits
          .filter((commit) => commit.repositoryIdentity === repo.identity)
          .flatMap((commit) => commit.imports.map((entry) => ({ ...entry, taskId: commit.taskId }))),
      });
    }

    // #246 C2 — a project-less bootstrap run joins no repository; its candidate is its PLAN, the
    // manifest that PLAN carries and the outputs it plans. A PLAN with no plannable outputs freezes
    // nothing, so nothing can be reviewed or confirmed for it.
    let bootstrapPlan: Parameters<typeof buildNoRepositoryCandidateSnapshot>[0]["bootstrapPlan"];
    if (participants.length === 0 && isProjectlessBootstrap(run)) {
      const current = currentBootstrapPlan(runId, this.artifacts.latest<unknown>(runId, ArtifactKind.PLAN));
      if (!current.allowed) return current as Decision<CandidateSnapshot>;
      bootstrapPlan = current.value.binding;
    }
    // #246 B2-a — a CONTRACT_CHANGE candidate, with or without repositories, is also its PLAN: the
    // manifest that PLAN carries and the base it changes. A run whose PLAN carries none freezes nothing.
    // The carried manifest is what is reviewed, and what a later activation may install; the bar this
    // run is verified against stays its dispatch pin, rather than a contract the candidate proposes.
    let contractChange: Parameters<typeof buildNoRepositoryCandidateSnapshot>[0]["contractChange"];
    let boundRevisions: readonly WorkflowRevision[] = [];
    if (isContractChangeRun(run)) {
      // #512 (v45) — or a first activation, judged against the project as it stands now (E2–E6).
      const current = currentContractChangeTarget(
        run,
        this.artifacts.latest<unknown>(runId, ArtifactKind.PLAN),
        (digest) => this.projects.manifest(digest),
        firstActivationFactsOf(this.db, run),
        contractChangeRevertFactsOf(this.db, run),
      );
      if (!current.allowed) return current as Decision<CandidateSnapshot>;
      contractChange = current.value.binding;
      if (current.value.firstActivation) boundRevisions = current.value.workflowRevisions;
    }
    // A CONTRACT_CHANGE candidate of a project is also the project's canonical CTO identity as it stands
    // now, read once: a changed entitlement or PRIMARY_CTO binding is a different candidate, reviewed again.
    const canonicalCtoIdentity = contractChange === undefined || run.projectId === null
      ? undefined
      : readCanonicalCtoIdentity(this.db, run.projectId);

    // A STANDARD_WORK candidate with repositories, or a CONTRACT_CHANGE candidate, is frozen with the review
    // evidence the CEO has bound now, digests only (review/standard-review-evidence.ts). A selection that cannot be
    // read back intact refuses the freeze.
    let reviewEvidence: SnapshotReviewEvidence | null = null;
    if ((run.kind === RunKind.STANDARD_WORK && participants.length > 0) || isContractChangeRun(run)) {
      try { reviewEvidence = collectStandardReviewEvidence({ artifacts: this.artifacts, audit: this.audit, runs: this.runs }, runId); }
      catch { return deny(ReasonCode.SNAPSHOT_DIGEST_MISMATCH, "attached review evidence cannot be frozen", { runId }); }
    }

    const snapshot = participants.length === 0
      ? buildNoRepositoryCandidateSnapshot(
          {
            runId,
            contractDigest: run.contractDigest,
            ...(bootstrapPlan === undefined ? {} : { bootstrapPlan }),
            ...(contractChange === undefined ? {} : { contractChange }),
            ...(canonicalCtoIdentity === undefined ? {} : { canonicalCtoIdentity }),
            ...(reviewEvidence === null ? {} : { reviewEvidence }),
          },
          this.clock,
        )
      : await buildCandidateSnapshot(
          {
            runId,
            contractDigest: run.contractDigest,
            repositories,
            ...(contractChange === undefined ? {} : { contractChange }),
            ...(canonicalCtoIdentity === undefined ? {} : { canonicalCtoIdentity }),
            ...(reviewEvidence === null ? {} : { reviewEvidence }),
          },
          this.clock,
        );

    // CEO (S6-B) — a candidate that is missing a SUCCEEDED task's own commit is refused here,
    // before it is ever persisted as this run's current candidate. Asked of the final candidate
    // head, integrated or not: the post-condition of the integration above, never replaced by it.
    if (participants.length > 0) {
      const missing = await this.missingTaskCommits(results, snapshot.repositories, repositories);
      if (missing.length > 0) {
        return deny(
          ReasonCode.CANDIDATE_MISSING_TASK_COMMIT,
          "a SUCCEEDED task's commit is not in the candidate's history for its repository",
          { runId, missing },
        );
      }
      // S6 review — ancestry is not content: a merge that keeps one side holds a task's commit in its
      // history and none of its change. With two or more task commits, each task's change must stand
      // in the candidate's tree as the task left it.
      for (const frozen of snapshot.repositories) {
        const checkoutPath = repositories.find((repo) => repo.identity === frozen.identity)?.checkoutPath;
        if (!checkoutPath) continue;
        const lost = await lostTaskChanges({ db: this.db, runId, commits: results, repositoryIdentity: frozen.identity, checkoutPath, candidateHead: frozen.candidateHead, measuredFromBase: supersession.terminals });
        if (!lost.allowed) return lost as Decision<CandidateSnapshot>;
        if (lost.value.length > 0) {
          const named = lost.value.map((task) => `${task.taskId} (${task.paths.join(", ")})`).join("; ");
          return deny(
            ReasonCode.CANDIDATE_MISSING_TASK_CHANGE,
            `a SUCCEEDED task's change is not in the candidate's tree although its commit is in the candidate's history: ${named}`,
            { runId, repositoryIdentity: frozen.identity, lost: lost.value },
          );
        }
      }
      // #1268 — and of the candidate as frozen: every commit between the base each repository was frozen at and
      // the exact head frozen for it is one checked above, a merge this freeze's check was bound to, or one
      // recorded for a predecessor base (#1242). Only an inconsistency inside ACP, or a checkout that moved since
      // the check above, can refuse here.
      if (checkMergeMessages !== undefined) {
        for (const frozen of snapshot.repositories) {
          const checkoutPath = repositories.find((repo) => repo.identity === frozen.identity)!.checkoutPath;
          const foreign = await foreignCandidateCommit({
            db: this.db,
            runId,
            repositoryIdentity: frozen.identity,
            checkoutPath,
            baseHead: frozen.baseHead,
            candidateHead: frozen.candidateHead,
            mergeChecks: [...(commitloreMergeChecks.get(frozen.identity) ?? []), ...recordedPredecessorMergeChecks(this.db, runId, frozen.identity)],
            accounted,
          });
          if (!foreign.allowed) return foreign as Decision<CandidateSnapshot>;
          if (foreign.value !== null) {
            return refuseForeign({ repositoryIdentity: frozen.identity, baseHead: frozen.baseHead, candidateHead: frozen.candidateHead, ...foreign.value });
          }
        }
      }
    }

    const digest = candidateSnapshotDigest(snapshot);
    // S6 review — an integrated candidate is a commit no branch names. A private ref keeps it from
    // git gc for as long as it is this run's candidate; it is written, through the guard, before the
    // candidate is recorded, and a freeze that cannot write it records nothing.
    const refWrites: Array<{ identity: string; checkoutPath: string; lines: string[] }> = [];
    for (const frozen of snapshot.repositories) {
      if (frozen.integration === undefined) continue;
      const checkoutPath = repositories.find((repo) => repo.identity === frozen.identity)!.checkoutPath;
      const plan = await candidateRefPlan(checkoutPath, runId, { ref: candidateRefFor(runId, digest), commit: frozen.candidateHead });
      if (!plan.allowed) return plan as Decision<CandidateSnapshot>;
      refWrites.push({ identity: frozen.identity, checkoutPath, lines: plan.value.filter((line) => !line.startsWith("delete ")) });
    }
    // #1268 — no gap between the head checked and the head frozen: before the freeze's first write, each checkout
    // of a run whose contract requires CommitLore still stands where the freeze read it.
    const headMoved = (moved: Record<string, unknown>, leftoverRefs: string[]): Decision<CandidateSnapshot> =>
      deny(ReasonCode.CANDIDATE_HEAD_MOVED, "the checkout's HEAD moved after the candidate's commits were checked; nothing was frozen", {
        runId,
        refusal: "HEAD_MOVED",
        ...moved,
        leftoverRefs,
      });
    if (checkMergeMessages !== undefined) {
      const moved = await movedCheckoutHead(snapshot.repositories, repositories);
      if (moved !== null) return headMoved(moved, []);
    }
    const applied: typeof refWrites = [];
    for (const write of refWrites) {
      const held = await this.writeCandidateRefs(run, write.identity, write.checkoutPath, write.lines);
      if (!held.allowed) return held as Decision<CandidateSnapshot>;
      applied.push(write);
    }

    // #1255 — what a CONTRACT_CHANGE candidate's review is shown beside its PLAN, read by ACP now, at the
    // freeze, and bound to this candidate and this freeze, so the review sees what held when it was frozen.
    const reviewContext = contractChange === undefined || run.projectId === null || canonicalCtoIdentity === undefined
      ? null
      : await captureContractChangeReviewContext(
          { db: this.db, repositories: this.repositories, clock: this.clock },
          {
            runId, projectId: run.projectId, candidateSnapshotDigest: digest, planDigest: contractChange.planDigest,
            workflowRevisions: boundRevisions, canonicalCtoIdentity,
            freezeId: `freeze_${randomUUID().replace(/-/g, "").slice(0, 24)}`, attemptId: attemptId ?? null,
          },
        );

    // #1268 — and again once the refs are applied. A moved HEAD undoes exactly the refs this freeze applied,
    // through the same guarded ref path, and refuses; a ref that cannot be undone is named, and refused all the same.
    const refuseMoved = async (moved: Record<string, unknown>): Promise<Decision<CandidateSnapshot>> => {
      const leftoverRefs: string[] = [];
      for (const write of [...applied].reverse()) {
        const undone = await this.writeCandidateRefs(run, write.identity, write.checkoutPath, undoCandidateRefLines(write.lines));
        if (!undone.allowed) leftoverRefs.push(...write.lines.map((line) => line.split(" ")[1]!));
      }
      return headMoved(moved, leftoverRefs);
    };
    if (checkMergeMessages !== undefined) {
      const moved = await movedCheckoutHead(snapshot.repositories, repositories);
      if (moved !== null) return refuseMoved(moved);
    }

    const frozenRecord = (reviewContextOutcome: ReturnType<typeof storeContractChangeReviewContext> | null) => ({
      kind: "CANDIDATE_FROZEN",
      runId,
      evidence: {
        candidateSnapshotDigest: digest,
        repositories: snapshot.repositories.map((r) => ({
          identity: r.identity,
          candidateHead: r.candidateHead,
          sourceBranch: r.sourceBranch ?? null,
          sourceHead: r.sourceHead ?? null,
          files: r.touchedPaths.length,
          ...(r.integration === undefined ? {} : { integratedTasks: r.integration.tasks.length }),
          // #1268 — internal execution evidence: each merge whose message CommitLore's commit-msg check passed, with
          // the parents and tree that check was bound to. No capture and no record: no session produced a merge.
          ...(commitloreMergeChecks.has(r.identity) ? { commitloreMergeChecks: commitloreMergeChecks.get(r.identity)! } : {}),
        })),
        ...(attemptId === undefined ? {} : { attemptId }),
        ...(reviewContextOutcome === null ? {} : { reviewContext: reviewContextOutcome }),
      },
    });
    // The refs of the candidates this one supersedes go now. Best effort: one left behind keeps an
    // old candidate's objects from gc, nothing more, and the next freeze asks again.
    const removeSupersededRefs = async (): Promise<void> => {
      for (const repo of repositories) {
        const frozen = snapshot.repositories.find((candidate) => candidate.identity === repo.identity);
        const keep = frozen?.integration === undefined ? null : { ref: candidateRefFor(runId, digest), commit: frozen.candidateHead };
        const plan = await candidateRefPlan(repo.checkoutPath, runId, keep);
        const superseded = plan.allowed ? plan.value.filter((line) => line.startsWith("delete ")) : [];
        if (superseded.length > 0) await this.writeCandidateRefs(run, repo.identity, repo.checkoutPath, superseded);
      }
    };

    if (checkMergeMessages !== undefined) {
      // #1268 — a run whose contract requires CommitLore records its candidate in one synchronous transaction: the
      // artifact, the promotion and CANDIDATE_FROZEN, then every checkout's HEAD read again with nothing awaited
      // (`checkoutHeadNow`). A HEAD that is not the one frozen rolls all three back, so no success row exists unless
      // every HEAD matched after they were written; the refs are then undone and the freeze refused.
      const seen: { moved: Record<string, unknown> | null } = { moved: null };
      const persisted = this.db.txDecision(() => {
        this.artifacts.put(runId, ArtifactKind.CANDIDATE_SNAPSHOT, snapshot, digest);
        const reviewContextOutcome = reviewContext === null ? null : storeContractChangeReviewContext(this.artifacts, reviewContext);
        this.runs.promoteCandidate(runId, digest);
        this.audit.record(frozenRecord(reviewContextOutcome));
        seen.moved = movedCheckoutHeadNow(snapshot.repositories, repositories);
        return seen.moved === null
          ? allow(ReasonCode.OK, undefined)
          : deny(ReasonCode.CANDIDATE_HEAD_MOVED, "a checkout's HEAD moved before the candidate was recorded", {});
      });
      if (!persisted.allowed) return seen.moved === null ? (persisted as Decision<CandidateSnapshot>) : refuseMoved(seen.moved);
      // Best-effort cleanup, after the decision and outside it.
      await removeSupersededRefs();
      return allow(ReasonCode.OK, snapshot);
    }

    this.artifacts.put(runId, ArtifactKind.CANDIDATE_SNAPSHOT, snapshot, digest);
    // G-6 — a readback the store refuses is replaced by this freeze's refusal row, so the review names it
    // missing with the refusal rather than showing an earlier freeze's readback of the same candidate.
    const reviewContextOutcome = reviewContext === null ? null : storeContractChangeReviewContext(this.artifacts, reviewContext);
    // One transaction records the new candidate and stales everything bound to an older
    // one, so no window exists in which superseded evidence still reads as current.
    this.runs.promoteCandidate(runId, digest);
    await removeSupersededRefs();
    this.audit.record(frozenRecord(reviewContextOutcome));
    return allow(ReasonCode.OK, snapshot);
  }

  async submitResult(input: SubmitResultInput): Promise<Decision<PipelineOutcome>> {
    // A caller that cannot prove the run owner must not be able to reserve the run's
    // durable submission fence, even briefly. This check is repeated after acquisition
    // to cover a state/ownership change between the two database operations.
    const owner = this.runs.assertOwner(
      input.runId,
      input.ownerSessionId,
      input.ownerBindingGeneration,
    );
    if (!owner.allowed) return owner as Decision<PipelineOutcome>;
    if (owner.value.state !== RunState.ACTIVE) {
      return deny(ReasonCode.RUN_TRANSITION_ILLEGAL, `run is ${owner.value.state}`, { runId: input.runId });
    }

    const attemptId = `attempt_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const acquired = this.acquireAttempt(input, attemptId);
    if (!acquired.allowed) return acquired as Decision<PipelineOutcome>;
    const controller = new AbortController();
    this.#attempts.set(attemptId, controller);
    let outcome: Decision<PipelineOutcome> | undefined;
    try {
      // The answer is stored as the mutation's result and returned to the caller. For a run that had private review
      // evidence it is rebuilt from values of known provenance, before it is serialized or stored, and so is a thrown
      // refusal (`privateEvidenceAnswer`); any other run's answer is exactly as before.
      try { outcome = await this.submitResultOnce(input, attemptId, controller.signal); }
      catch (error) {
        if (!isAcpError(error) || !runHadStandardReviewEvidence({ audit: this.audit }, input.runId)) throw error;
        const refused = privateEvidenceAnswer({ artifacts: this.artifacts, audit: this.audit }, input.runId, deny(error.reasonCode, error.message, error.evidence));
        throw acpError(refused.reasonCode, refused.allowed ? "" : refused.message, refused.evidence);
      }
      if (!runHadStandardReviewEvidence({ audit: this.audit }, input.runId)) return outcome;
      const answered = privateEvidenceAnswer({ artifacts: this.artifacts, audit: this.audit }, input.runId, outcome);
      // #1189 — a stale attempt's not-applied text is a fixed constant, so the projection keeps it where it withholds any other.
      return outcome.allowed || outcome.message !== STALE_ATTEMPT_NOT_APPLIED ? answered
        : deny(answered.reasonCode, STALE_ATTEMPT_NOT_APPLIED, answered.evidence);
    } finally {
      this.#attempts.delete(attemptId);
      this.endAttempt(input, attemptId, outcome);
    }
  }

  /**
   * #1344 B — the answer a result_submit replay gets from durable state, when the key's response was never stored (its
   * daemon ended first, or the call threw). Bound to the run, the key and the MCP request fingerprint the attempt was
   * recorded under; read only, so nothing is frozen, verified or reviewed again. The attempt's ENDED row decides first:
   * an applied outcome (committed with its row, so one is never answered as not applied), an answer that applied
   * nothing, or `REPLAYED_ATTEMPT_ERRORED`. With no ENDED row the attempt applied no outcome: `REPLAYED_ATTEMPT_RELEASED`
   * once ACP released it (its deadline, a daemon restart, a reclaim). A CONFLICT for the same key naming another request.
   * Null otherwise: no attempt recorded under the key, or one still RUNNING (in this process the caller's in-flight
   * answer; one an ended daemon left is released by the restart's reconcile).
   */
  replaySubmission(runId: string, idempotencyKey: string, requestFingerprint: string): Decision<unknown> | null {
    const started = this.db.get<{ evidence_json: string }>(
      `SELECT evidence_json FROM audit_events WHERE run_id = ? AND kind = ?
          AND json_extract(evidence_json, '$.idempotencyKeyDigest') = ? ORDER BY event_id LIMIT 1`,
      [runId, CANDIDATE_PIPELINE_ATTEMPT_STARTED, resultSubmitKeyDigestOf(idempotencyKey)],
    );
    if (!started) return null;
    const recorded = JSON.parse(started.evidence_json) as { attemptId?: unknown; mcpFingerprint?: unknown };
    if (typeof recorded.attemptId !== "string") return null;
    if (recorded.mcpFingerprint !== requestFingerprint) {
      return deny(ReasonCode.CONFLICT, "this idempotencyKey already names a different result_submit request", { runId });
    }
    const attemptId = recorded.attemptId;
    const released = deny(ReasonCode.CANDIDATE_PIPELINE_ATTEMPT_STALE, REPLAYED_ATTEMPT_RELEASED, { runId, attemptId });
    const ended = this.db.get<{ reason_code: string | null; evidence_json: string }>(
      `SELECT reason_code, evidence_json FROM audit_events WHERE run_id = ? AND kind = ?
          AND json_extract(evidence_json, '$.attemptId') = ? ORDER BY event_id LIMIT 1`,
      [runId, CANDIDATE_PIPELINE_ATTEMPT_ENDED, attemptId],
    );
    if (ended) {
      const end = JSON.parse(ended.evidence_json) as { outcome?: unknown; allowed?: unknown; stage?: unknown; stageReasonCode?: unknown; candidateSnapshotDigest?: unknown };
      if (end.outcome === "ERRORED") return deny(ReasonCode.INTERNAL_ERROR, REPLAYED_ATTEMPT_ERRORED, { runId, attemptId, outcome: "NOT_APPLIED" });
      const reasonCode = (ended.reason_code ?? ReasonCode.OK) as ReasonCode;
      const snapshotDigest = typeof end.candidateSnapshotDigest === "string" ? end.candidateSnapshotDigest : null;
      if (end.allowed === true) {
        return allow(reasonCode, {
          stage: end.stage,
          ...(typeof end.stageReasonCode === "string" ? { reasonCode: end.stageReasonCode } : {}),
          snapshotDigest,
          attemptId,
          replayed: "DURABLE_OUTCOME",
        });
      }
      // An attempt that ended not holding the run applied nothing: it was released under its answer.
      if (end.outcome === "NOT_APPLIED" && reasonCode === ReasonCode.CANDIDATE_PIPELINE_ATTEMPT_STALE) return released;
      return deny(reasonCode, REPLAYED_ATTEMPT_REFUSED, { runId, attemptId, ...(snapshotDigest === null ? {} : { candidateSnapshotDigest: snapshotDigest }) });
    }
    const row = this.db.get<{ attempt_id: string; state: string }>(
      "SELECT attempt_id, state FROM candidate_pipeline_attempts WHERE run_id = ?",
      [runId],
    );
    if (row?.attempt_id === attemptId && row.state === "RUNNING") return null;
    const releasedByAcp = this.db.get<{ n: number }>(
      `SELECT 1 AS n FROM audit_events WHERE run_id = ? AND (
          (kind = ? AND json_extract(evidence_json, '$.kind') = 'candidate_pipeline_attempt'
                    AND json_extract(evidence_json, '$.target') = ?)
          OR (kind = 'CANDIDATE_PIPELINE_ATTEMPT_RECLAIMED' AND json_extract(evidence_json, '$.attemptId') = ?)) LIMIT 1`,
      [runId, OWNERLESS_STALL_OWED, attemptId, attemptId],
    ) !== undefined;
    return releasedByAcp ? released : null;
  }

  /**
   * Stops what an attempt this process runs has in flight (its reviewer and verification children)
   * once ACP no longer lets it hold the run: a watchdog or acquisition reclaim, the cap, a refused
   * renewal. What those children still return is fenced off by the same hold.
   */
  abortAttempt(attemptId: string): void {
    this.#attempts.get(attemptId)?.abort();
  }

  /** #1344 — whether this process runs the attempt: one it took and has not ended. */
  runsAttempt(attemptId: string): boolean {
    return this.#attempts.has(attemptId);
  }

  /**
   * #1344 C1 — the run's owner CTO is told that ACP released an attempt of its run, whether its deadline passed or the
   * daemon that ran it restarted: in band, as a revision is (`returnToCto`), keyed by the attempt
   * (`attemptReleasedNoticeKey`), so a release is told once. It asks for no product change: the attempt's outcome was
   * not applied, and a fresh result_submit with a new idempotency key goes on. Answers the notice's id; null when none
   * is owed (a run not ACTIVE, or a project-less bootstrap run, whose driven CTO would replace its PLAN for any
   * REVISION_REQUEST and which the daemon's review retry wakes instead, `Daemon.#bootstrapReviewRetry`; or an attempt
   * whose outcome was applied, #1344 B, whose own notice already told the owner and of which "not applied" is false);
   * and a denial when one is owed and cannot be written now (no active owner binding, or the outbox refused its target),
   * which the watchdog keeps owed and retries (`Watchdog.deliverOwedReleaseNotices`). The release never waits on it.
   */
  noticeAttemptReleased(released: { runId: string; attemptId: string; reason: string }): Decision<string | null> {
    const run = this.runs.get(released.runId);
    if (!run || run.state !== RunState.ACTIVE || isProjectlessBootstrap(run)) return allow(ReasonCode.OK, null);
    const applied = this.db.get<{ n: number }>(
      `SELECT 1 AS n FROM audit_events WHERE run_id = ? AND kind = ?
          AND json_extract(evidence_json, '$.attemptId') = ? AND json_extract(evidence_json, '$.outcome') = 'APPLIED' LIMIT 1`,
      [released.runId, CANDIDATE_PIPELINE_ATTEMPT_ENDED, released.attemptId],
    );
    if (applied) return allow(ReasonCode.OK, null);
    const roleKey = this.runs.ownerRoleKeyFor(run);
    const binding = roleKey ? this.bindings.active(roleKey) : null;
    if (!binding) {
      return deny(ReasonCode.OUTBOX_TARGET_NOT_CURRENT, "the run's owner role has no active binding to tell of the release", {
        runId: released.runId,
        roleKey,
      });
    }
    const enqueued = this.outbox.enqueue({
      idempotencyKey: attemptReleasedNoticeKey(released.runId, released.attemptId),
      roleKey: binding.roleKey,
      bindingGeneration: binding.bindingGeneration,
      targetSessionId: binding.sessionId,
      runId: released.runId,
      kind: MessageKind.REVISION_REQUEST,
      payload: {
        runId: released.runId,
        reasonCode: ReasonCode.CANDIDATE_PIPELINE_ATTEMPT_STALE,
        stage: "attempt-released",
        attemptId: released.attemptId,
        reason: released.reason,
        notice: ATTEMPT_RELEASED_NOTICE,
        recovery: ATTEMPT_RELEASED_RECOVERY,
      },
    });
    return enqueued.allowed ? allow(ReasonCode.OK, enqueued.value.messageId) : (enqueued as Decision<never>);
  }

  private async submitResultOnce(input: SubmitResultInput, attemptId: string, signal: AbortSignal): Promise<Decision<PipelineOutcome>> {
    const owner = this.runs.assertOwner(
      input.runId,
      input.ownerSessionId,
      input.ownerBindingGeneration,
    );
    if (!owner.allowed) return owner as Decision<PipelineOutcome>;
    const run = owner.value;

    if (run.state !== RunState.ACTIVE) {
      return deny(ReasonCode.RUN_TRANSITION_ILLEGAL, `run is ${run.state}`, { runId: input.runId });
    }

    const completeness = this.reviewEntry(run);
    if (!completeness.allowed) return completeness as Decision<PipelineOutcome>;

    const frozen = await this.freeze(input.runId, attemptId);
    if (!frozen.allowed) return frozen as Decision<PipelineOutcome>;
    const snapshot = frozen.value;
    const snapshotDigest = candidateSnapshotDigest(snapshot);
    const boundAttempt = this.bindAttemptCandidate(input.runId, attemptId, snapshotDigest);
    if (!boundAttempt.allowed) return boundAttempt as Decision<PipelineOutcome>;
    // F1 — the bound on unjudged reviews: a candidate whose last UNJUDGED_REVIEW_LIMIT attempts all went unjudged is not
    // verified or reviewed again; the owner was told to escalate (`noticeUnjudgedReview`). The refusal changes no run
    // state, PLAN or task and sends nothing; its row keeps it out of the count, so the next such submit is refused too,
    // and a changed candidate starts its own count. A project-less bootstrap run keeps the daemon's review retry.
    if (!isProjectlessBootstrap(run)) {
      const unjudgedAttempts = this.consecutiveUnjudgedAttempts(input.runId, snapshotDigest, attemptId);
      if (unjudgedAttempts >= UNJUDGED_REVIEW_LIMIT) {
        const evidence = { runId: input.runId, candidateSnapshotDigest: snapshotDigest, attemptId, refusal: UNJUDGED_REVIEW_LIMIT_REFUSED,
          unjudgedAttempts, unjudgedAttemptLimit: UNJUDGED_REVIEW_LIMIT };
        const recorded = this.applyHolding(input, attemptId, () => {
          const row = this.audit.record({ kind: UNJUDGED_REVIEW_LIMIT_REFUSED, runId: input.runId, reasonCode: ReasonCode.REVIEW_UNJUDGED_LIMIT_REACHED, evidence });
          return row.allowed ? allow(ReasonCode.OK, undefined) : (row as Decision<void>);
        }, appliedRefusal(ReasonCode.REVIEW_UNJUDGED_LIMIT_REACHED, snapshotDigest));
        if (recorded === null) return this.attemptLost(input.runId, attemptId, snapshotDigest, null);
        if (!recorded.allowed) return recorded as Decision<PipelineOutcome>;
        return deny(ReasonCode.REVIEW_UNJUDGED_LIMIT_REACHED, UNJUDGED_REVIEW_LIMIT_REFUSAL, evidence);
      }
    }
    const progress = (step: SubmissionProgressStep): boolean => this.renewAttempt(input, attemptId, step);

    // No repository means no source, verification command, or blind-review input exists to
    // inspect. Publish the explicit no-op packet through the same production gate, then let
    // CEO confirmation and the daemon own completion exactly as for a repository run.
    if (snapshot.repositories.length === 0) {
      // The review this candidate had, if any: a refusal at publication records what it refused.
      let reviewedPlan: Decision<ReviewPacket> | null = null;
      // #246 C2 — except a project-less bootstrap candidate, whose planned outputs are exactly the
      // blind-review input there is. Its review is as automatic as a candidate's (§18.2): the gate
      // reloads the outputs from the PLAN artifact, a verdict other than PASS returns the run to its
      // CTO, and only a PASS reaches the production gate.
      if (snapshot.bootstrapPlan !== undefined) {
        const contract = this.pinnedContract(input.runId, run.contractDigest);
        if (!contract.allowed) return contract as Decision<PipelineOutcome>;
        const reviewed = await this.invokeReview({
          kind: "BOOTSTRAP_PLAN",
          runId: input.runId,
          snapshot,
          contract: contract.value,
          contractDigest: run.contractDigest,
          attemptId,
          progress,
          signal,
        });
        reviewedPlan = reviewed;
        // Review rounds 1 and 2 (RF-REVIEW-02) — the review is asynchronous, and `plan_submit` can
        // replace the PLAN while it runs or while anything after it is awaited. A candidate whose PLAN
        // was replaced is stale whatever the verdict: a PASS is not P2's review, and a REVISE or BLOCK
        // is not the CTO's next instruction for P2. So the PLAN is checked after the last await before
        // each thing this path does — the revision request or unavailable-review record
        // (`unpassedReview`), and the packet (below) — never only once after the review.
        // A verdict rests on the review the gate stored, whose intent must still be the run's too
        // (BPI-R1-01): a task replaced during the await keeps the PLAN binding and changes only that.
        const unpassed = await this.unpassedReview(input, snapshotDigest, reviewed, attemptId, (verdict) =>
          this.bootstrapPlanStillCurrent(input.runId, snapshot, verdict ? snapshotDigest : null),
        );
        if (unpassed !== null) return unpassed;
        if (this.#continuity?.evaluate) await this.#continuity.evaluate("pre-completion");
      } else if (snapshot.contractChange !== undefined) {
        // #246 B2-a — a no-repository CONTRACT_CHANGE candidate is reviewed as a bootstrap plan is: the
        // manifest its PLAN carries is the review input, and a PLAN replaced since makes it stale. The
        // packet the production gate builds for it still summarizes its review as not applicable, as for
        // any no-repository candidate that is not a bootstrap plan's; the BLIND_REVIEW is the review.
        const contract = this.pinnedContract(input.runId, run.contractDigest);
        if (!contract.allowed) return contract as Decision<PipelineOutcome>;
        const reviewed = await this.invokeReview({
          kind: "CONTRACT_CHANGE",
          runId: input.runId,
          snapshot,
          contract: contract.value,
          contractDigest: run.contractDigest,
          attemptId,
          progress,
          signal,
        });
        reviewedPlan = reviewed;
        const unpassed = await this.unpassedReview(input, snapshotDigest, reviewed, attemptId, () =>
          this.contractChangePlanStillCurrent(input.runId, snapshot),
        );
        if (unpassed !== null) return unpassed;
        if (this.#continuity?.evaluate) await this.#continuity.evaluate("pre-completion");
      }
      const sourceReadLease = this.guard.acquireSourceReadLease(input.runId, []);
      if (!sourceReadLease.allowed) return sourceReadLease as Decision<PipelineOutcome>;
      try {
        // And again at publication, as a repository candidate's source is: continuity was awaited
        // since, and nothing below awaits before the packet is built.
        if (snapshot.bootstrapPlan !== undefined) {
          const planAtPublication = this.bootstrapPlanStillCurrent(input.runId, snapshot);
          if (!planAtPublication.allowed) {
            this.recordStaleAfterReview(input.runId, snapshotDigest, attemptId, "PLAN_AT_PUBLICATION", planAtPublication, reviewedPlan);
            return allow(ReasonCode.OK, { stage: "CANDIDATE_STALE", reasonCode: planAtPublication.reasonCode, snapshotDigest,
              detail: { message: planAtPublication.message, evidence: planAtPublication.evidence } });
          }
        }
        if (snapshot.contractChange !== undefined) {
          const planAtPublication = this.contractChangePlanStillCurrent(input.runId, snapshot);
          if (!planAtPublication.allowed) {
            this.recordStaleAfterReview(input.runId, snapshotDigest, attemptId, "PLAN_AT_PUBLICATION", planAtPublication, reviewedPlan);
            return allow(ReasonCode.OK, { stage: "CANDIDATE_STALE", reasonCode: planAtPublication.reasonCode, snapshotDigest });
          }
        }
        if (reviewedPlan !== null) {
          const superseded = this.supersededAtPublication(run, snapshot, snapshotDigest, attemptId, reviewedPlan);
          if (superseded !== null) return superseded;
        }
        const built = this.applyHolding(input, attemptId, () => this.ceo.buildPacket({
          runId: input.runId,
          candidateSnapshotDigest: snapshotDigest,
          sourceReadLeaseId: sourceReadLease.value.leaseId,
          approval: {
            runId: input.runId,
            candidateSnapshotDigest: snapshotDigest,
            resultSummary: input.resultSummary,
            recommendation: input.recommendation,
            residualRisk: input.residualRisk ?? [],
            approvedBySessionId: input.ownerSessionId,
            approvedByGeneration: input.ownerBindingGeneration,
            approvedAt: this.clock.nowIso(),
          },
        } as Parameters<ProductionGate["buildPacket"]>[0] & { sourceReadLeaseId: string }), appliedStage("COMPLETED_REVIEW", snapshotDigest));
        if (built === null) return this.attemptLost(input.runId, attemptId, snapshotDigest, reviewedPlan);
        if (!built.allowed) return this.returnBlockedPass(input, attemptId, snapshotDigest, built, reviewedPlan);
        return allow(ReasonCode.OK, {
          stage: "COMPLETED_REVIEW",
          packet: built.value,
          snapshotDigest,
        });
      } finally {
        sourceReadLease.value.release();
      }
    }

    const commands = this.resolveCommands(
      run.pinnedManifestDigest,
      run.executionMode,
      input.runScopedCommands,
    );
    const verified = await this.verification.verify({
      runId: input.runId,
      snapshot,
      commands,
      contractDigest: run.contractDigest,
      pinnedManifestDigest: run.pinnedManifestDigest,
      executionMode: run.executionMode,
      runScoped: Boolean(input.runScopedCommands),
      attempt: { holds: () => this.attemptHolds(input, attemptId), progress: () => progress("VERIFICATION_COMMAND_COMPLETED"), signal },
    });

    if (!verified.allowed) {
      if (verified.reasonCode === ReasonCode.CANDIDATE_PIPELINE_ATTEMPT_STALE) return this.attemptLost(input.runId, attemptId, snapshotDigest, null);
      const report =
        this.verification.latestReport(input.runId, snapshotDigest) ??
        ({
          runId: input.runId,
          candidateSnapshotDigest: snapshotDigest,
          contractDigest: run.contractDigest,
          expectedInputs: commands.length,
          observedInputs: 0,
          results: [],
          status: "INCOMPLETE",
          reasonCode: verified.reasonCode,
          gaps: [],
        } satisfies VerificationReport);

      // §34.2 — a failed verification returns to CTO revision with the evidence still
      // bound to the candidate that failed: its excerpts, not the whole capture the review reads.
      const returned = this.applyHolding(input, attemptId, () => this.returnToCto(input.runId, verified.reasonCode, {
        stage: "verification",
        candidateSnapshotDigest: snapshotDigest,
        report: reportWithoutCapturedOutput(report),
      }, attemptId), appliedStage("VERIFICATION_FAILED", snapshotDigest, verified.reasonCode));
      if (returned === null) return this.attemptLost(input.runId, attemptId, snapshotDigest, null);
      if (!returned.allowed) return returned as Decision<PipelineOutcome>;
      return allow(ReasonCode.OK, {
        stage: "VERIFICATION_FAILED",
        reasonCode: verified.reasonCode,
        snapshotDigest,
        report,
      });
    }

    // CP-HI-06 / §16.2 — verification ran against a detached head, but the source may have
    // moved while it ran. Re-check before spending a review on it.
    const stillFreshAfterVerify = await this.assertStillFresh(snapshot);
    if (!stillFreshAfterVerify.allowed) {
      return allow(ReasonCode.OK, {
        stage: "CANDIDATE_STALE",
        reasonCode: stillFreshAfterVerify.reasonCode,
        snapshotDigest,
      });
    }

    const contract = this.pinnedContract(input.runId, run.contractDigest);
    if (!contract.allowed) return contract as Decision<PipelineOutcome>;

    // §18.2 — automatic, immediately after verification passes.
    if (!this.attemptHolds(input, attemptId)) return this.attemptLost(input.runId, attemptId, snapshotDigest, null);
    const reviewed = await this.invokeReview({
      runId: input.runId,
      projectId: run.projectId,
      executionMode: run.executionMode,
      snapshot,
      contract: contract.value,
      contractDigest: run.contractDigest,
      verification: verified.value,
      attemptId,
      progress,
      signal,
    });

    // #246 B2-a — a CONTRACT_CHANGE candidate's verdict is for the PLAN it names; one replaced since
    // gets no revision request. Any other candidate's verdict is delivered as before.
    const unpassed = snapshot.contractChange === undefined
      ? await this.unpassedReview(input, snapshotDigest, reviewed, attemptId)
      : await this.unpassedReview(input, snapshotDigest, reviewed, attemptId, () =>
          this.contractChangePlanStillCurrent(input.runId, snapshot),
        );
    if (unpassed !== null) return unpassed;

    // Coverage is re-evaluated here, in async context, so the gate's completion check
    // decides on a current mode rather than one that predates a provider outage (§15.6).
    if (this.#continuity?.evaluate) await this.#continuity.evaluate("pre-completion");

    const sourceReadLease = this.guard.acquireSourceReadLease(
      input.runId,
      snapshot.repositories.map((repository) => repository.identity),
    );
    if (!sourceReadLease.allowed) return sourceReadLease as Decision<PipelineOutcome>;
    try {
      // And again before the packet: the review is also asynchronous. Managed source
      // writes cannot slip between this observation and production-ready publication.
      const stillFreshAfterReview = await this.assertStillFresh(snapshot);
      if (!stillFreshAfterReview.allowed) {
        this.recordStaleAfterReview(input.runId, snapshotDigest, attemptId, "SOURCE_AT_PUBLICATION", stillFreshAfterReview, reviewed);
        return allow(ReasonCode.OK, {
          stage: "CANDIDATE_STALE",
          reasonCode: stillFreshAfterReview.reasonCode,
          snapshotDigest,
        });
      }
      // #246 B2-a — and its PLAN, as a no-repository candidate's is; nothing below awaits.
      if (snapshot.contractChange !== undefined) {
        const planAtPublication = this.contractChangePlanStillCurrent(input.runId, snapshot);
        if (!planAtPublication.allowed) {
          this.recordStaleAfterReview(input.runId, snapshotDigest, attemptId, "PLAN_AT_PUBLICATION", planAtPublication, reviewed);
          return allow(ReasonCode.OK, { stage: "CANDIDATE_STALE", reasonCode: planAtPublication.reasonCode, snapshotDigest });
        }
      }
      const superseded = this.supersededAtPublication(run, snapshot, snapshotDigest, attemptId, reviewed);
      if (superseded !== null) return superseded;

      const built = this.applyHolding(input, attemptId, () => this.ceo.buildPacket({
        runId: input.runId,
        candidateSnapshotDigest: snapshotDigest,
        sourceReadLeaseId: sourceReadLease.value.leaseId,
        approval: {
          runId: input.runId,
          candidateSnapshotDigest: snapshotDigest,
          resultSummary: input.resultSummary,
          recommendation: input.recommendation,
          residualRisk: input.residualRisk ?? [],
          approvedBySessionId: input.ownerSessionId,
          approvedByGeneration: input.ownerBindingGeneration,
          approvedAt: this.clock.nowIso(),
        },
      } as Parameters<ProductionGate["buildPacket"]>[0] & { sourceReadLeaseId: string }), appliedStage("COMPLETED_REVIEW", snapshotDigest));
      if (built === null) return this.attemptLost(input.runId, attemptId, snapshotDigest, reviewed);
      if (!built.allowed) return this.returnBlockedPass(input, attemptId, snapshotDigest, built, reviewed);

      return allow(ReasonCode.OK, {
        stage: "COMPLETED_REVIEW",
        packet: built.value,
        snapshotDigest,
      });
    } finally {
      sourceReadLease.value.release();
    }
  }

  /**
   * What review entry asks of the run's tasks (CEO 1792120507 / 1792120860). A project-less
   * PROJECT_BOOTSTRAP run that joins no repository is asked `TaskGraph.bootstrapReviewEntry` against
   * its current PLAN, whose preparation `currentBootstrapPlan` validates here and again at the
   * freeze and the review: its one task is the external create, settled only at CEO CONFIRM from the
   * producer's receipt, so no task success is required or fabricated before review. Every other run
   * keeps `completeness` exactly. The owner was asserted by the caller just before.
   */
  private reviewEntry(run: RunRow): Decision<unknown> {
    if (!isProjectlessBootstrap(run) || this.runs.repositoriesOf(run.runId).length > 0) return this.tasks.administrativeReviewEntry(run.runId);
    const planArtifact = this.artifacts.latest<unknown>(run.runId, ArtifactKind.PLAN);
    const current = currentBootstrapPlan(run.runId, planArtifact);
    if (!current.allowed || planArtifact === null) return current;
    const carried = this.bootstrapPlanCarriesCurrentAuthority(run.runId, planArtifact);
    if (!carried.allowed) return carried;
    return this.tasks.bootstrapReviewEntry(run.runId, current.value.binding.planDigest);
  }

  /**
   * Live run_3884d4fc — attached review evidence and admitted CEO decisions reach a bootstrap PLAN
   * review only as `plan_submit` froze them into the PLAN, and a `plan_submit` under a key an earlier
   * one used replays that earlier PLAN and freezes nothing. So review entry asks the collectors
   * `plan_submit` freezes from, and refuses while the run holds an attachment or a decision its current
   * PLAN lacks: absent from the PLAN is not absent from the run. A run that holds neither is unchanged.
   * `bootstrapPlanStillCurrent` asks it again after the review, for what arrived while it ran.
   */
  private bootstrapPlanCarriesCurrentAuthority(runId: string, plan: { digest: string; content: unknown }): Decision<void> {
    const source = { db: this.db, artifacts: this.artifacts, audit: this.audit, runs: this.runs, bindings: this.bindings };
    let attached: ReturnType<typeof collectBootstrapReviewEvidence>;
    // An attachment `plan_submit` cannot freeze (one naming a replaced PLAN input) is refused as there.
    try { attached = collectBootstrapReviewEvidence(source, runId); }
    catch { return deny(ReasonCode.SNAPSHOT_DIGEST_MISMATCH, "attached review evidence cannot be frozen", { runId }); }
    const content = plan.content as { reviewEvidence?: unknown; bootstrapPlanDigest?: unknown };
    const evidenceUnfrozen = attached !== null
      && (content.reviewEvidence === undefined || digestOf(content.reviewEvidence) !== digestOf(attached));
    // currentBootstrapPlan has already validated the frozen records this reads.
    const frozen = new Set(frozenBootstrapCeoDecisions(plan.content).map((decision) => decision.digest));
    const decisionsUnfrozen = collectBootstrapCeoDecisions(this.db, runId).filter((decision) => !frozen.has(decision.digest));
    if (!evidenceUnfrozen && decisionsUnfrozen.length === 0) return allow(ReasonCode.OK, undefined);
    return deny(
      ReasonCode.BOOTSTRAP_PLAN_AUTHORITY_NOT_FROZEN,
      "this run's current PLAN does not carry the review evidence attached or the CEO decisions admitted since it was submitted, so no review of it is entered or accepted and the run is not made ready for CEO review. Call plan_submit again with the same bootstrapPlanDigest and a NEW idempotencyKey (a key an earlier plan_submit used replays that earlier PLAN and freezes nothing), then result_submit with a new idempotencyKey",
      {
        runId,
        refusal: "BOOTSTRAP_PLAN_AUTHORITY_NOT_FROZEN",
        planDigest: plan.digest,
        bootstrapPlanDigest: typeof content.bootstrapPlanDigest === "string" ? content.bootstrapPlanDigest : null,
        unfrozenReviewEvidenceAttachment: evidenceUnfrozen ? attached!.source.attachmentDigest : null,
        unfrozenCeoDecisionEvents: decisionsUnfrozen.map((decision) => decision.source.decisionEventId),
      },
    );
  }

  /** The run's pinned task contract, read back by its digest. */
  private pinnedContract(runId: string, contractDigest: string): Decision<TaskContract> {
    const contract = this.artifacts
      .list<TaskContract>(runId, ArtifactKind.TASK_CONTRACT)
      .find((artifact) => !artifact.superseded && artifact.digest === contractDigest);
    if (!contract || digestOf(contract.content) !== contractDigest) {
      // #448: nothing was compared — the artifact store has no contract that both matches the
      // run's pinned digest by name and hashes to it. Not a disagreement; a record that could
      // not be produced to compare at all.
      return deny(ReasonCode.CONTRACT_UNVERIFIED, "run's pinned task contract is not retrievable by digest", {
        runId,
        expected: contractDigest,
        found: contract?.digest ?? null,
      });
    }
    return allow(ReasonCode.OK, contract.content);
  }

  /**
   * What a review that did not pass leaves the run with, or null for a PASS: a verdict returns the
   * run to its CTO, and an assurance failure waits (§18.6, §18.7).
   */
  private async unpassedReview(
    input: SubmitResultInput,
    snapshotDigest: string,
    reviewed: Decision<ReviewPacket>,
    /** The submission this review belongs to: its revision is delivered once per attempt. */
    attemptId: string,
    /**
     * Whether the candidate is still the one to act on, asked after the last await and before
     * anything is delivered or recorded, told whether the outcome is a reviewer verdict (one the gate
     * stored a review for). A repository candidate's verdict is delivered as before.
     */
    stillCurrent: (verdict: boolean) => Decision<void> = () => allow(ReasonCode.OK, undefined),
  ): Promise<Decision<PipelineOutcome> | null> {
    if (reviewed.allowed) return null;
    const runId = input.runId;
    // §18.7 — only a reviewer *verdict* enters the CTO revision loop. A lost isolation
    // or a provider that never answered is an assurance failure the candidate cannot
    // repair, so the gate is neither lowered nor handed to the CTO to "fix".
    const isVerdict =
      reviewed.reasonCode === ReasonCode.REVIEW_REVISE ||
      reviewed.reasonCode === ReasonCode.REVIEW_BLOCK ||
      reviewed.reasonCode === ReasonCode.REVIEW_OMITTED_ITEMS_PRESENT;
    // A submission whose attempt no longer holds the run applies no outcome: not the gate's refusal for a
    // lost lease, not a verdict, and nothing after the await below unless a transaction that holds it
    // writes it. Its assurance failure is still that attempt's own history (#1189 R1-01), below.
    if (reviewed.reasonCode === ReasonCode.CANDIDATE_PIPELINE_ATTEMPT_STALE) return this.attemptLost(runId, attemptId, snapshotDigest, reviewed);
    const held = this.attemptHolds(input, attemptId);
    if (!held && isVerdict) return this.attemptLost(runId, attemptId, snapshotDigest, reviewed);
    // §18.7 is an assurance decision too. Re-evaluate continuity before deciding
    // whether a provider/isolation failure waits or moves the system into SURVIVAL. A stale attempt's
    // failure moves nothing, so it is not asked.
    if (held && this.#continuity?.evaluate) await this.#continuity.evaluate("blind-review-unavailable");
    // #246 C2, review round 2 (RF-REVIEW-02) — the review and the evaluation above were awaited, and
    // a bootstrap PLAN replaced during either makes this outcome stale: no revision request and no
    // unavailable-review record is produced for it. Nothing below awaits before either is written.
    const current = stillCurrent(isVerdict);
    if (!current.allowed) {
      this.recordStaleAfterReview(runId, snapshotDigest, attemptId, "AFTER_REVIEW", current, reviewed);
      return allow(ReasonCode.OK, { stage: "CANDIDATE_STALE", reasonCode: current.reasonCode, snapshotDigest,
        detail: { message: current.message, evidence: current.evidence } });
    }

    if (!isVerdict) {
      const recordUnavailable = (attemptHeld: boolean): void => {
        this.audit.record({
          kind: "BLIND_REVIEW_UNAVAILABLE",
          runId,
          reasonCode: reviewed.reasonCode,
          evidence: {
            ...unavailableReviewEvidence(snapshotDigest, reviewed.evidence, attemptId),
            ...(attemptHeld ? {} : { attemptHeld: false }),
          },
        });
      };
      // F1 — the owning CTO is told in the same transaction (`noticeUnjudgedReview`); a notice the outbox
      // refuses is answered as that refusal, with nothing recorded, as a refused revision is.
      const recorded = held
        ? this.applyHolding(input, attemptId, () => {
            recordUnavailable(true);
            return this.noticeUnjudgedReview(runId, snapshotDigest, reviewed, attemptId);
          }, appliedStage("REVIEW_UNAVAILABLE", snapshotDigest, reviewed.reasonCode))
        : null;
      // #1189 R1-01 — an attempt that no longer holds the run keeps its failure as its own history: the
      // row names its attempt and says it did not hold the run, so it is never the run's current outcome
      // and never the cause of a review retry (`Daemon.#bootstrapReviewRetry`). Its answer says, in fixed
      // text, that nothing of it was applied: it is no unavailable review of the current candidate.
      if (recorded === null) {
        recordUnavailable(false);
        return deny(reviewed.reasonCode, STALE_ATTEMPT_NOT_APPLIED, { runId, attemptId, candidateSnapshotDigest: snapshotDigest, attemptHeld: false });
      }
      if (!recorded.allowed) return recorded as Decision<PipelineOutcome>;
      return allow(ReasonCode.OK, {
        stage: "REVIEW_UNAVAILABLE",
        reasonCode: reviewed.reasonCode,
        snapshotDigest,
        detail: { message: reviewed.message, evidence: reviewed.evidence },
      });
    }

    const returned = this.applyHolding(input, attemptId, () => this.returnToCto(runId, reviewed.reasonCode, {
      stage: "blind-review",
      candidateSnapshotDigest: snapshotDigest,
      ...reviewed.evidence,
    }, attemptId), appliedStage("REVISION_REQUIRED", snapshotDigest, reviewed.reasonCode));
    if (returned === null) return this.attemptLost(runId, attemptId, snapshotDigest, reviewed);
    if (!returned.allowed) return returned as Decision<PipelineOutcome>;
    const packet = this.review.latestPacket(runId, snapshotDigest);
    return allow(ReasonCode.OK, {
      stage: "REVISION_REQUIRED",
      reasonCode: reviewed.reasonCode,
      snapshotDigest,
      ...(packet ? { review: packet } : {}),
    });
  }

  /**
   * A candidate refused as stale once its review had run. The refusal is unchanged — no revision, no
   * unavailable-review record, no packet — and this row says so: which check found it stale (`stale`),
   * the candidate, the submission attempt, the review's own outcome and, when the review carried a
   * packet, that reviewer's binding generation. Built field by field, never spread from a denial. An
   * answer the review gate did not keep has the gate's own BLIND_REVIEW_REJECTED row naming its reviewer.
   */
  private recordStaleAfterReview(
    runId: string,
    snapshotDigest: string,
    attemptId: string,
    stale: "AFTER_REVIEW" | "SOURCE_AT_PUBLICATION" | "PLAN_AT_PUBLICATION" | "CANDIDATE_AT_PUBLICATION" | "ATTEMPT_LEASE",
    refusal: Decision<unknown>,
    reviewed: Decision<ReviewPacket> | null,
  ): void {
    const packet = reviewed === null ? null : reviewed.allowed ? reviewed.value : reviewed.evidence["packet"];
    const generation = (packet as Partial<ReviewPacket> | null | undefined)?.reviewerRoleBindingGeneration;
    this.audit.record({
      kind: "BLIND_REVIEW_REJECTED",
      runId,
      reasonCode: refusal.reasonCode,
      evidence: {
        candidateSnapshotDigest: snapshotDigest,
        attemptId,
        stale,
        reviewReasonCode: reviewed?.reasonCode ?? null,
        reviewerRoleBindingGeneration: typeof generation === "number" ? generation : null,
      },
    });
  }

  /**
   * A reviewed candidate that is no longer the run's candidate is stale at publication: a later freeze
   * replaced it while this submission awaited (another attempt re-froze after its lease lapsed), or the
   * canonical CTO identity it froze is no longer the project's (a runtime move with no re-freeze yet).
   * The production gate would refuse the first and publish a superseded identity for the second, so the
   * refusal is recorded here with the candidate, attempt and reviewer it names. Null while current.
   */
  private supersededAtPublication(
    run: RunRow,
    snapshot: CandidateSnapshot,
    snapshotDigest: string,
    attemptId: string,
    reviewed: Decision<ReviewPacket>,
  ): Decision<PipelineOutcome> | null {
    const current = this.runs.currentCandidate(run.runId);
    let refusal: { message: string; evidence: Evidence } | null = null;
    if (current !== snapshotDigest) {
      refusal = { message: "candidate is not the run's current candidate", evidence: { runId: run.runId, supplied: snapshotDigest, current } };
    } else if (snapshot.canonicalCtoIdentity !== undefined && run.projectId !== null) {
      // Read as the freeze reads it; a candidate that froze no identity is not asked.
      const frozenIdentityDigest = digestOf(snapshot.canonicalCtoIdentity);
      const currentIdentityDigest = digestOf(readCanonicalCtoIdentity(this.db, run.projectId));
      if (frozenIdentityDigest !== currentIdentityDigest) {
        refusal = {
          message: "the canonical CTO identity this candidate froze is no longer the project's",
          evidence: { runId: run.runId, candidateSnapshotDigest: snapshotDigest, frozenIdentityDigest, currentIdentityDigest },
        };
      }
    }
    if (refusal === null) return null;
    this.recordStaleAfterReview(run.runId, snapshotDigest, attemptId, "CANDIDATE_AT_PUBLICATION",
      deny(ReasonCode.EVIDENCE_STALE, refusal.message, refusal.evidence), reviewed);
    return allow(ReasonCode.OK, { stage: "CANDIDATE_STALE", reasonCode: ReasonCode.EVIDENCE_STALE, snapshotDigest,
      detail: refusal });
  }

  /** Durable, per-run fence for the whole asynchronous verification/review attempt. */
  private acquireAttempt(input: SubmitResultInput, attemptId: string): Decision<void> {
    // #664 — the upsert below is the reservation itself; a denial means the reservation
    // did not happen and must not leave a row behind.
    return this.db.txDecision(() => {
      const acquiredAt = this.clock.now();
      const startedAt = acquiredAt.toISOString();
      const deadlineAt = new Date(acquiredAt.getTime() + ATTEMPT_LEASE_TTL_MS).toISOString();
      // Read the prior holder in the same transaction so a direct acquisition reclaim is
      // evidence-producing too. A watchdog is not guaranteed to run between a crash and
      // the next submit, so silently replacing an expired RUNNING row would erase the
      // only durable record of that interrupted attempt.
      const prior = this.db.get<{
        attempt_id: string;
        started_at: string;
        deadline_at: string;
        state: string;
      }>(
        `SELECT attempt_id, started_at, deadline_at, state
           FROM candidate_pipeline_attempts WHERE run_id = ?`,
        [input.runId],
      );
      const inserted = this.db.run(
        `INSERT INTO candidate_pipeline_attempts
           (run_id, attempt_id, owner_session_id, owner_binding_generation, candidate_digest, state, started_at, deadline_at, released_at)
         VALUES (?, ?, ?, ?, NULL, 'RUNNING', ?, ?, NULL)
         ON CONFLICT(run_id) DO UPDATE SET
           attempt_id = excluded.attempt_id,
           owner_session_id = excluded.owner_session_id,
           owner_binding_generation = excluded.owner_binding_generation,
           candidate_digest = NULL,
           state = 'RUNNING',
           started_at = excluded.started_at,
           deadline_at = excluded.deadline_at,
           released_at = NULL
         WHERE candidate_pipeline_attempts.state = 'RELEASED'
            OR (candidate_pipeline_attempts.state = 'RUNNING'
                AND candidate_pipeline_attempts.deadline_at <= ?)`,
        [input.runId, attemptId, input.ownerSessionId, input.ownerBindingGeneration, startedAt, deadlineAt, startedAt],
      );
      if (inserted.changes === 1) {
        // #1344 B — the key and request this attempt answers, so a replay of the key can find it.
        if (input.replayIdentity) {
          this.audit.record({
            kind: CANDIDATE_PIPELINE_ATTEMPT_STARTED,
            runId: input.runId,
            evidence: {
              attemptId,
              idempotencyKeyDigest: resultSubmitKeyDigestOf(input.replayIdentity.idempotencyKey),
              mcpFingerprint: input.replayIdentity.requestFingerprint,
            },
          });
        }
        if (prior?.state === "RUNNING" && prior.deadline_at <= startedAt) {
          this.db.afterCommit(() => this.abortAttempt(prior.attempt_id));
          this.recordAttemptReclaimed({
            runId: input.runId,
            attemptId: prior.attempt_id,
            startedAt: prior.started_at,
            deadlineAt: prior.deadline_at,
            ageMs: acquiredAt.getTime() - new Date(prior.started_at).getTime(),
          }, "acquire");
        }
        return allow(ReasonCode.OK, undefined);
      }
      const current = this.db.get<{
        attempt_id: string;
        owner_session_id: string;
        owner_binding_generation: number;
        candidate_digest: string | null;
        state: string;
        deadline_at: string;
      }>(
        `SELECT attempt_id, owner_session_id, owner_binding_generation, candidate_digest, state, deadline_at
           FROM candidate_pipeline_attempts WHERE run_id = ?`,
        [input.runId],
      );
      return deny(ReasonCode.CONFLICT, "a durable candidate submission attempt already owns this run", {
        runId: input.runId,
        current,
      });
    });
  }

  /**
   * Releases leases whose owner can no longer be assumed live. This is deliberately a
   * synchronous, conditional transaction: a watchdog may observe a stale row just as a
   * new submission replaces it, and must never release that new holder's fence.
   *
   * The watchdog owns the diagnostic report; this method owns the candidate pipeline's
   * state transition, durable reclaim audit, and the exact rows it changed.
   */
  reclaimExpiredAttempts(): ReclaimedCandidatePipelineAttempt[] {
    return this.db.tx(() => {
      const now = this.clock.now();
      const releasedAt = now.toISOString();
      const stale = this.db.all<{
        run_id: string;
        attempt_id: string;
        started_at: string;
        deadline_at: string;
      }>(
        `SELECT run_id, attempt_id, started_at, deadline_at
           FROM candidate_pipeline_attempts
          WHERE state = 'RUNNING' AND deadline_at <= ?
          ORDER BY deadline_at, run_id`,
        [releasedAt],
      );
      const reclaimed: ReclaimedCandidatePipelineAttempt[] = [];
      for (const attempt of stale) {
        const released = this.db.run(
          `UPDATE candidate_pipeline_attempts
              SET state = 'RELEASED', released_at = ?
            WHERE run_id = ? AND attempt_id = ? AND state = 'RUNNING' AND deadline_at <= ?`,
          [releasedAt, attempt.run_id, attempt.attempt_id, releasedAt],
        );
        if (released.changes !== 1) continue;
        this.db.afterCommit(() => this.abortAttempt(attempt.attempt_id));
        const startedAt = new Date(attempt.started_at).getTime();
        const reclaimedAttempt = {
          runId: attempt.run_id,
          attemptId: attempt.attempt_id,
          startedAt: attempt.started_at,
          deadlineAt: attempt.deadline_at,
          ageMs: now.getTime() - startedAt,
        };
        reclaimed.push(reclaimedAttempt);
        this.recordAttemptReclaimed(reclaimedAttempt, "sweep");
      }
      return reclaimed;
    });
  }

  /** Records every state-changing reclamation, whether the watchdog or a new submit finds it. */
  private recordAttemptReclaimed(
    attempt: ReclaimedCandidatePipelineAttempt,
    via: "acquire" | "sweep",
  ): void {
    this.audit.record({
      kind: "CANDIDATE_PIPELINE_ATTEMPT_RECLAIMED",
      runId: attempt.runId,
      reasonCode: ReasonCode.CANDIDATE_PIPELINE_ATTEMPT_STALE,
      evidence: {
        attemptId: attempt.attemptId,
        startedAt: attempt.startedAt,
        deadlineAt: attempt.deadlineAt,
        ageMs: attempt.ageMs,
        via,
      },
    });
  }

  private bindAttemptCandidate(runId: string, attemptId: string, candidateDigest: string): Decision<void> {
    const updated = this.db.run(
      `UPDATE candidate_pipeline_attempts
          SET candidate_digest = ?
        WHERE run_id = ? AND attempt_id = ? AND state = 'RUNNING'`,
      [candidateDigest, runId, attemptId],
    );
    return updated.changes === 1
      ? allow(ReasonCode.OK, undefined)
      : deny(ReasonCode.CONFLICT, "candidate submission attempt lease was replaced before snapshot binding", {
          runId,
          attemptId,
          candidateDigest,
        });
  }

  /**
   * Renews this attempt's lease on a real step, and only while the attempt still holds the run
   * (`attemptHolds`): a RELEASED or expired attempt is never revived, and no deadline is set past the cap
   * from acquisition. A compare-and-set on the attempt and the deadline it read; true while the attempt
   * holds the run, and the caller is told only of a renewal that committed.
   */
  private renewAttempt(input: SubmitResultInput, attemptId: string, step: SubmissionProgressStep): boolean {
    return this.db.tx(() => {
      if (!this.attemptHolds(input, attemptId)) return false;
      const now = this.clock.now();
      const held = this.db.get<{ started_at: string; deadline_at: string }>(
        `SELECT started_at, deadline_at FROM candidate_pipeline_attempts WHERE run_id = ? AND attempt_id = ?`,
        [input.runId, attemptId],
      )!;
      const renewal = Math.min(now.getTime() + ATTEMPT_LEASE_TTL_MS, new Date(held.started_at).getTime() + ATTEMPT_LEASE_CAP_MS);
      const deadlineAt = new Date(Math.max(renewal, new Date(held.deadline_at).getTime())).toISOString();
      const renewed = this.db.run(
        `UPDATE candidate_pipeline_attempts SET deadline_at = ?
          WHERE run_id = ? AND attempt_id = ? AND state = 'RUNNING' AND deadline_at = ?`,
        [deadlineAt, input.runId, attemptId, held.deadline_at],
      ).changes === 1;
      if (!renewed) {
        this.abortAttempt(attemptId);
        return false;
      }
      const notify = input.onProgress;
      if (notify) {
        this.db.afterCommit(() => {
          try { notify(step); } catch { /* a notice that fails never decides the submission */ }
        });
      }
      return true;
    });
  }

  /**
   * Whether this attempt still holds the run: RUNNING, unexpired, and its owner still the run's current
   * one. An attempt found not to hold it is stopped (`abortAttempt`).
   */
  private attemptHolds(input: SubmitResultInput, attemptId: string): boolean {
    const holds = this.db.get<{ n: number }>(
      `SELECT 1 AS n FROM candidate_pipeline_attempts
        WHERE run_id = ? AND attempt_id = ? AND owner_session_id = ? AND owner_binding_generation = ?
          AND state = 'RUNNING' AND deadline_at > ?`,
      [input.runId, attemptId, input.ownerSessionId, input.ownerBindingGeneration, this.clock.nowIso()],
    ) !== undefined && this.runs.assertOwner(input.runId, input.ownerSessionId, input.ownerBindingGeneration).allowed;
    if (!holds) this.abortAttempt(attemptId);
    return holds;
  }

  /**
   * Applies an attempt's outcome (a revision request, an unavailable-review row, the packet) only while
   * the attempt holds the run: the check and the writes are one transaction. Null, with nothing applied,
   * when it no longer holds; otherwise what `apply` answered, a denial rolling back what it wrote.
   * #1344 B — `receipt` is what the attempt answers once this outcome is applied: its APPLIED row commits with the
   * outcome, so a daemon that ends right after leaves the outcome's own answer for a replay of its key.
   */
  private applyHolding<T>(input: SubmitResultInput, attemptId: string, apply: () => Decision<T>, receipt: AttemptReceipt): Decision<T> | null {
    let lost = false;
    const applied = this.db.txDecision(() => {
      if (!this.attemptHolds(input, attemptId)) {
        lost = true;
        return deny<T>(ReasonCode.CANDIDATE_PIPELINE_ATTEMPT_STALE, "the attempt no longer holds the run", { runId: input.runId, attemptId });
      }
      const result = apply();
      if (result.allowed) this.recordAttemptEnded(input, attemptId, "APPLIED", receipt);
      return result;
    });
    return lost ? null : applied;
  }

  /**
   * The answer of a submission whose attempt no longer holds the run (released, expired or at its cap):
   * its outcome is not applied (`STALE_ATTEMPT_NOT_APPLIED`), and a review that answered is recorded as refused for it.
   */
  private attemptLost(
    runId: string,
    attemptId: string,
    snapshotDigest: string,
    reviewed: Decision<ReviewPacket> | null,
  ): Decision<PipelineOutcome> {
    const refusal = deny<PipelineOutcome>(
      ReasonCode.CANDIDATE_PIPELINE_ATTEMPT_STALE,
      STALE_ATTEMPT_NOT_APPLIED,
      { runId, attemptId, candidateSnapshotDigest: snapshotDigest },
    );
    // A review the gate ended for this same reason reached no verdict, or recorded the one it did not keep.
    if (reviewed !== null && reviewed.reasonCode !== ReasonCode.CANDIDATE_PIPELINE_ATTEMPT_STALE) {
      this.recordStaleAfterReview(runId, snapshotDigest, attemptId, "ATTEMPT_LEASE", refusal, reviewed);
    }
    return refusal;
  }

  private releaseAttempt(runId: string, attemptId: string): void {
    this.db.run(
      `UPDATE candidate_pipeline_attempts
          SET state = 'RELEASED', released_at = ?
        WHERE run_id = ? AND attempt_id = ? AND state = 'RUNNING'`,
      [this.clock.nowIso(), runId, attemptId],
    );
  }

  /**
   * An attempt ends its own hold; #1344 B — and, for a result_submit whose attempt applied no outcome (none has an
   * APPLIED row: `applyHolding` writes it with the outcome), records with the release what it answered, NOT_APPLIED, or,
   * when it threw, ERRORED. Either way nothing of an outcome was applied, so a replay is told so definitely.
   */
  private endAttempt(input: SubmitResultInput, attemptId: string, outcome: Decision<PipelineOutcome> | undefined): void {
    this.db.tx(() => {
      this.releaseAttempt(input.runId, attemptId);
      if (input.replayIdentity === undefined) return;
      const ended = this.db.get<{ n: number }>(
        `SELECT 1 AS n FROM audit_events WHERE run_id = ? AND kind = ? AND json_extract(evidence_json, '$.attemptId') = ? LIMIT 1`,
        [input.runId, CANDIDATE_PIPELINE_ATTEMPT_ENDED, attemptId],
      );
      if (ended) return;
      if (outcome === undefined) this.recordAttemptEnded(input, attemptId, "ERRORED", null);
      else this.recordAttemptEnded(input, attemptId, "NOT_APPLIED", receiptOf(outcome));
    });
  }

  /** #1344 B — the ENDED row of a result_submit's attempt: how it ended and what it answered. */
  private recordAttemptEnded(input: SubmitResultInput, attemptId: string, outcome: AttemptEnd, receipt: AttemptReceipt | null): void {
    if (input.replayIdentity === undefined) return;
    this.audit.record({
      kind: CANDIDATE_PIPELINE_ATTEMPT_ENDED,
      runId: input.runId,
      reasonCode: receipt?.reasonCode ?? null,
      evidence: {
        attemptId,
        outcome,
        allowed: receipt?.allowed ?? false,
        stage: receipt?.stage ?? null,
        stageReasonCode: receipt?.stageReasonCode ?? null,
        candidateSnapshotDigest: receipt?.candidateSnapshotDigest ?? null,
      },
    });
  }

  /**
   * §18.6 — the revision loop is internal. The run returns to the CTO with the reason
   * and the evidence; Hermes is not notified.
   *
   * PR #1114 BOOT-03 — each submission's verdict is its own revision cycle, so the delivery is keyed
   * by the attempt as well as the candidate: a second verdict on the same PLAN is a second message.
   * A delivery the outbox refuses is answered as that refusal, with nothing recorded as returned.
   */
  private returnToCto(runId: string, reasonCode: string, evidence: Record<string, unknown>, attemptId: string): Decision<void> {
    const run = this.runs.require(runId);
    const roleKey = this.runs.ownerRoleKeyFor(run);
    const binding = roleKey ? this.bindings.active(roleKey) : null;

    if (binding) {
      const enqueued = this.outbox.enqueue({
        idempotencyKey: `revision:${runId}:${String(evidence["candidateSnapshotDigest"])}:${reasonCode}:${attemptId}`,
        roleKey: binding.roleKey,
        bindingGeneration: binding.bindingGeneration,
        targetSessionId: binding.sessionId,
        runId,
        kind: MessageKind.REVISION_REQUEST,
        payload: { runId, reasonCode, ...evidence },
      });
      if (!enqueued.allowed) return enqueued as Decision<void>;
    }

    // The delivery above carries `evidence` whole; the row keeps a fixed field list (revisionAuditEvidence).
    const review = evidence["stage"] === "blind-review" ? this.storedReview(runId, String(evidence["candidateSnapshotDigest"])) : null;
    this.audit.record({
      kind: "REVISION_RETURNED_TO_CTO",
      runId,
      roleKey: binding?.roleKey ?? null,
      reasonCode: reasonCode as never,
      evidence: revisionAuditEvidence(evidence, review),
    });

    // §31.3 — revision count is run-scope telemetry. The FSM keeps a blind-review
    // revision inside ACTIVE (§29.2 has no ACTIVE→REVISION_REQUIRED edge), so the count
    // has to be recorded here rather than inferred from a state change.
    this.telemetry.record({
      scope: "run",
      name: "revision",
      runId,
      value: 1,
      text: reasonCode,
      dims: { stage: evidence["stage"] ?? null, mode: run.executionMode },
    });
    return allow(ReasonCode.OK, undefined);
  }

  /**
   * F1 — a PASS whose findings hold a BLOCKER is refused by the production gate as REVIEW_BLOCK, and goes back to
   * the owning CTO as a BLOCK verdict does: `returnToCto` with the reviewer's packet, keyed by this attempt and
   * candidate, so a replay delivers nothing new. The gate's refusal stays the answer; any other refusal is as before.
   */
  private returnBlockedPass(
    input: SubmitResultInput,
    attemptId: string,
    snapshotDigest: string,
    built: Decision<ProductionReadyPacket>,
    reviewed: Decision<ReviewPacket> | null,
  ): Decision<PipelineOutcome> {
    if (built.reasonCode !== ReasonCode.REVIEW_BLOCK || reviewed === null || !reviewed.allowed) return built as Decision<PipelineOutcome>;
    const returned = this.applyHolding(input, attemptId, () => this.returnToCto(input.runId, ReasonCode.REVIEW_BLOCK, {
      stage: "blind-review",
      candidateSnapshotDigest: snapshotDigest,
      runId: input.runId,
      packet: reviewed.value,
    }, attemptId), appliedRefusal(built.reasonCode as ReasonCode, snapshotDigest));
    if (returned === null) return this.attemptLost(input.runId, attemptId, snapshotDigest, reviewed);
    if (!returned.allowed) return returned as Decision<PipelineOutcome>;
    return built as Decision<PipelineOutcome>;
  }

  /**
   * F1 — a review that did not judge the product (method findings alone, or assurance not constituted) tells the
   * owning CTO so in band, keyed as a revision is by candidate, reason and attempt: the gate's reason code, a fixed
   * notice and its fixed recovery text (`UNJUDGED_REVIEW_NOTICES`). It asks for no product change and records no
   * revision. A method-only review's own method findings ride along, read from the review the gate stored; this
   * private delivery is the only place they go. A run with no active owner binding gets nothing, as a revision.
   * The notice names its attempt and counts the unjudged attempts in a row on this candidate
   * (`consecutiveUnjudgedAttempts`); at `UNJUDGED_REVIEW_LIMIT` its next step is escalation, not another resubmit.
   */
  private noticeUnjudgedReview(runId: string, snapshotDigest: string, reviewed: Decision<ReviewPacket>, attemptId: string): Decision<void> {
    const run = this.runs.require(runId);
    // Limit: a project-less bootstrap run gets no notice. Its driven bootstrap CTO is told to write and submit a new
    // PLAN for any REVISION_REQUEST, which would replace the PLAN under review; it keeps the daemon's review-retry
    // wake (`Daemon.#bootstrapReviewRetry`), which resubmits the same PLAN, as today.
    if (isProjectlessBootstrap(run)) return allow(ReasonCode.OK, undefined);
    const roleKey = this.runs.ownerRoleKeyFor(run);
    const binding = roleKey ? this.bindings.active(roleKey) : null;
    if (!binding) return allow(ReasonCode.OK, undefined);
    const notice = reviewed.evidence["problem"] === "METHOD_FINDINGS_ONLY" ? "METHOD_FINDINGS_ONLY" : "REVIEW_UNAVAILABLE";
    const methodFindings = notice === "METHOD_FINDINGS_ONLY" ? this.storedReview(runId, snapshotDigest)?.content.methodFindings : undefined;
    const unjudgedAttempts = this.consecutiveUnjudgedAttempts(runId, snapshotDigest);
    const nextStep = unjudgedAttempts < UNJUDGED_REVIEW_LIMIT ? "RESUBMIT" : "ESCALATE";
    const enqueued = this.outbox.enqueue({
      idempotencyKey: `revision:${runId}:${snapshotDigest}:${reviewed.reasonCode}:${attemptId}`,
      roleKey: binding.roleKey,
      bindingGeneration: binding.bindingGeneration,
      targetSessionId: binding.sessionId,
      runId,
      kind: MessageKind.REVISION_REQUEST,
      payload: {
        runId,
        reasonCode: reviewed.reasonCode,
        stage: "review-unavailable",
        candidateSnapshotDigest: snapshotDigest,
        attemptId,
        notice,
        unjudgedAttempts,
        unjudgedAttemptLimit: UNJUDGED_REVIEW_LIMIT,
        nextStep,
        recovery: `${UNJUDGED_REVIEW_NOTICES[notice]} ${UNJUDGED_REVIEW_NEXT_STEPS[nextStep]}`,
        ...(methodFindings === undefined ? {} : { methodFindings }),
      },
    });
    return enqueued.allowed ? allow(ReasonCode.OK, undefined) : (enqueued as Decision<void>);
  }

  /**
   * F1 — the unjudged attempts in a row on this candidate: walking the run's submission freezes from the latest back,
   * each one of this candidate whose attempt recorded, while it held the run, a BLIND_REVIEW_UNAVAILABLE row counts,
   * and the first other one (another candidate, or an attempt that ended any other way) stops the count. A freeze
   * outside a submission names no attempt, and a submission refused at the limit (or `except`, the one asking) did
   * not end the run of unjudged attempts; all three are passed over.
   */
  private consecutiveUnjudgedAttempts(runId: string, snapshotDigest: string, except?: string): number {
    const rows = this.audit.forRun(runId);
    const attemptsOf = (kind: string) => new Set(rows
      .filter((row) => row.kind === kind && row.evidence["attemptHeld"] !== false)
      .map((row) => row.evidence["attemptId"]));
    const unjudged = attemptsOf("BLIND_REVIEW_UNAVAILABLE");
    const refused = attemptsOf(UNJUDGED_REVIEW_LIMIT_REFUSED);
    let count = 0;
    for (const freeze of rows.filter((row) => row.kind === "CANDIDATE_FROZEN").sort((a, b) => b.eventId - a.eventId)) {
      const attempt = freeze.evidence["attemptId"];
      if (typeof attempt !== "string" || attempt === except || refused.has(attempt)) continue;
      if (freeze.evidence["candidateSnapshotDigest"] !== snapshotDigest || !unjudged.has(attempt)) break;
      count += 1;
    }
    return count;
  }

  /** The review gate's own BLIND_REVIEW artifact for a candidate, or null when the gate stored none. */
  private storedReview(runId: string, candidateSnapshotDigest: string): { digest: string; content: ReviewPacket } | null {
    const stored = this.artifacts.latestForSnapshot<ReviewPacket>(runId, ArtifactKind.BLIND_REVIEW, candidateSnapshotDigest);
    return stored !== null && stored.producedBy === EVIDENCE_PRODUCERS.BLIND_REVIEW ? stored : null;
  }

  /**
   * §17.1/§17.5 — commands come from the pinned project contract. A repository with no
   * active manifest may use run-scoped commands the CTO proposed, validated against the
   * same argv/sandbox contract and never persisted as a default.
   */
  /**
   * CP-HI-03 — commands come from the manifest this run pinned at dispatch admission, not
   * from whatever is active now. A concurrent CONTRACT_CHANGE must not change the bar a
   * run in flight is judged against.
   */
  private resolveCommands(
    pinnedManifestDigest: string | null,
    mode: "SIMPLE" | "STANDARD" | "GUARDED",
    runScoped: readonly VerificationCommand[] | undefined,
  ): VerificationCommand[] {
    if (pinnedManifestDigest) {
      const pinned = this.projects.manifest(pinnedManifestDigest);
      if (pinned) return commandsForMode(pinned, mode);
    }
    return [...(runScoped ?? [])];
  }

  /**
   * #246 C2, review round 1 (RF-REVIEW-02) — a project-less bootstrap candidate's freshness: the PLAN
   * binding it froze is still the one the run's current PLAN artifact implies. A current PLAN with no
   * plannable outputs has no binding, and is not the candidate's either. Given the snapshot of a
   * stored review an outcome rests on, that review's intent must also be the run's current one
   * (`bootstrapReviewIntentCurrent`, review of #1119 BPI-R1-01).
   */
  private bootstrapPlanStillCurrent(runId: string, snapshot: CandidateSnapshot, reviewedSnapshotDigest: string | null = null): Decision<void> {
    const planArtifact = this.artifacts.latest<unknown>(runId, ArtifactKind.PLAN);
    const current = currentBootstrapPlan(runId, planArtifact);
    const currentBinding = current.allowed ? current.value.binding : null;
    if (!sameBootstrapPlanBinding(currentBinding, snapshot.bootstrapPlan)) {
      return deny(ReasonCode.EVIDENCE_STALE, "the PLAN this candidate names was replaced while it was being judged", {
        runId,
        candidate: snapshot.bootstrapPlan ?? null,
        current: currentBinding,
      });
    }
    // Review of 51a21441 — evidence attached or a CEO decision admitted while the candidate was judged
    // leaves the PLAN binding as it was, so every outcome (PASS, verdict or unavailable) is stale on the
    // same check review entry asks. A matched binding means currentBootstrapPlan read a PLAN.
    const carried = this.bootstrapPlanCarriesCurrentAuthority(runId, planArtifact!);
    if (!carried.allowed) return carried;
    if (reviewedSnapshotDigest === null) return allow(ReasonCode.OK, undefined);
    const intent = bootstrapReviewIntentCurrent({
      runId,
      reviewedIntentDigest: this.storedReview(runId, reviewedSnapshotDigest)?.content.bootstrapPlanIntentDigest,
      planArtifact,
      tasks: bootstrapPlanIntentTasks(this.db, runId),
    });
    return intent.allowed ? allow(ReasonCode.OK, undefined) : (intent as Decision<void>);
  }

  /**
   * #246 B2-a — a CONTRACT_CHANGE candidate's freshness: the change it froze is still the one the
   * run's latest PLAN implies, against the same base. Asked after review and at publication; a PLAN
   * replaced after the packet is published is not refused here, but at the CEO's confirmation.
   */
  private contractChangePlanStillCurrent(runId: string, snapshot: CandidateSnapshot): Decision<void> {
    const run = this.runs.get(runId);
    const current = run
      ? currentContractChangeTarget(
          run,
          this.artifacts.latest<unknown>(runId, ArtifactKind.PLAN),
          (digest) => this.projects.manifest(digest),
          firstActivationFactsOf(this.db, run),
          contractChangeRevertFactsOf(this.db, run),
        )
      : null;
    const currentBinding = current?.allowed ? current.value.binding : null;
    if (!sameContractChangeBinding(currentBinding, snapshot.contractChange)) {
      return deny(ReasonCode.EVIDENCE_STALE, "the PLAN this candidate names was replaced while it was being judged", {
        runId,
        candidate: snapshot.contractChange ?? null,
        current: currentBinding,
      });
    }
    return allow(ReasonCode.OK, undefined);
  }

  /** Re-reads every frozen repository and reports drift (§16.2). */
  private async assertStillFresh(snapshot: CandidateSnapshot): Promise<Decision<CandidateSnapshot>> {
    const probes = snapshot.repositories
      .map((repo) => {
        const record = this.repositories.byIdentity(repo.identity);
        return {
          identity: repo.identity,
          checkoutPath: record?.checkoutPath ?? "",
          residentClone: record ? residentBaseClone(this.db, record.repositoryId, record.checkoutPath) : null,
          activeManifestDigest: record?.activeManifestDigest ?? null,
        };
      })
      .filter((p) => p.checkoutPath);
    return verifySnapshotFreshness(snapshot, probes);
  }

  /**
   * #1242 — the base a task with dependsOn predecessors starts from (`PredecessorBase`): its
   * predecessors' SUCCEEDED commits in its repository, integrated on the run's pinned base by the
   * freeze's own integration, kept from gc by a private ref under `BASE_REF_NAMESPACE` written through
   * the guard before the base is returned. A base that cannot be kept is refused, as one that cannot
   * be built is.
   */
  async predecessorBase(input: Parameters<PredecessorBase>[0]): Promise<Decision<StartsFrom | null>> {
    const run = this.runs.get(input.runId);
    if (!run) return deny(ReasonCode.NOT_FOUND, "unknown run", { runId: input.runId });
    const checkMergeMessages = this.checkMergeMessages(input.runId);
    const checked: MergeCheckBinding[] = [];
    const built = await integratePredecessors({
      db: this.db,
      runId: input.runId,
      taskId: input.taskId,
      tasks: this.tasks.list(input.runId),
      predecessors: input.predecessors,
      repositoryIdentity: input.repositoryIdentity,
      checkoutPath: input.checkoutPath,
      baseSha: input.baseSha,
      worktree: (worktreeInput, use) => this.verification.withRunWorktree(run, worktreeInput, use),
      ...(checkMergeMessages === undefined ? {} : { checkMessage: checkMergeMessages }),
      checked,
    });
    if (!built.allowed || built.value === null) return built;
    const ref = baseRefFor(input.runId, input.taskId);
    const plan = await candidateRefPlan(input.checkoutPath, input.runId, { ref, commit: built.value.commit }, ref);
    if (!plan.allowed) return plan as Decision<never>;
    if (plan.value.length > 0) {
      const held = await this.verification.writeRunRefs(
        run,
        { repositoryIdentity: input.repositoryIdentity, namespace: `${BASE_REF_NAMESPACE}/${input.runId}` },
        () => applyCandidateRefPlan(input.checkoutPath, plan.value),
      );
      if (!held.allowed) return held as Decision<never>;
    }
    // #1268 — the merges this base was built with, each bound to its check, so a freeze of a candidate holding
    // them (the dependent task's branch starts here) accepts them as it accepts its own. A base it cannot record
    // is refused.
    if (checked.length > 0) {
      const recorded = this.audit.record({
        kind: PREDECESSOR_BASE_MERGES_CHECKED,
        runId: input.runId,
        evidence: { taskId: input.taskId, repositoryIdentity: input.repositoryIdentity, commit: built.value.commit, commitloreMergeChecks: checked },
      });
      if (!recorded.allowed) return recorded as Decision<never>;
    }
    return built;
  }

  /**
   * S6 review — one guarded ref transaction under the run's private candidate namespace
   * (`CANDIDATE_REF_NAMESPACE`): never a branch, never HEAD, never a task's ref (S-TB-02).
   */
  private async writeCandidateRefs(run: RunRow, identity: string, checkoutPath: string, lines: readonly string[]): Promise<Decision<void>> {
    if (lines.length === 0) return allow(ReasonCode.OK, undefined);
    return this.verification.writeRunRefs(
      run,
      { repositoryIdentity: identity, namespace: `${CANDIDATE_REF_NAMESPACE}/${run.runId}` },
      () => applyCandidateRefPlan(checkoutPath, lines),
    );
  }

  /**
   * CEO (S6-B) — every task's own commit that a valid SUCCEEDED receipt of this run names
   * (`succeededTaskCommits`), checked against the candidate just frozen for its repository. Each
   * STANDARD_WORK task's work branch is created at the run's pinned base (#512 S-TB), or at its
   * dependsOn predecessors' integration on it (#1242), so the checkout's HEAD can hold one task's
   * branch alone. The integration (S6-C) places every commit it can; this is its post-condition on
   * the final head, so a commit it did not place (no write target, or an integration that dropped
   * one) refuses the freeze instead of being lost. Not drift in an already-frozen snapshot
   * (SNAPSHOT_STALE re-reads one after the fact; this is asked before one is ever recorded).
   */
  private async missingTaskCommits(
    commits: readonly SucceededTaskCommit[],
    snapshotRepositories: readonly { identity: string; candidateHead: string }[],
    repositories: readonly { identity: string; checkoutPath: string }[],
  ): Promise<Array<{ taskId: string; commitHead: string; repositoryIdentity: string }>> {
    const checkoutByIdentity = new Map(repositories.map((repo) => [repo.identity, repo.checkoutPath]));
    const candidateByIdentity = new Map(snapshotRepositories.map((repo) => [repo.identity, repo.candidateHead]));

    const missing: Array<{ taskId: string; commitHead: string; repositoryIdentity: string }> = [];
    for (const receipt of commits) {
      const checkoutPath = checkoutByIdentity.get(receipt.repositoryIdentity);
      const candidateHead = candidateByIdentity.get(receipt.repositoryIdentity);
      if (!checkoutPath || !candidateHead) continue;
      // The same ancestry idiom `sourceAtFreeze` uses below: a commit not resolvable in this
      // checkout at all makes `mergeBase` answer null, which is "not contained" exactly as a
      // resolvable but non-ancestor commit is — fail closed either way. An integrated head's
      // objects are in this checkout's object store: its integration worktree was linked to it.
      const ancestor = await mergeBase(checkoutPath, receipt.commit, candidateHead);
      if (ancestor !== receipt.commit) {
        missing.push({ taskId: receipt.taskId, commitHead: receipt.commit, repositoryIdentity: receipt.repositoryIdentity });
      }
    }
    return missing.sort((a, b) => (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0));
  }

  /**
   * Resolve the origin once, while freezing, and pass the resulting SHA to the snapshot
   * builder. For release/hotfix candidates, a shared ancestor can make both long-lived
   * refs appear ancestral; only a unique most-specific ref is recorded. A non-required
   * winner is retained as evidence so the GitHub kernel can refuse it by branch contract.
   */
  private async sourceAtFreeze(
    checkoutPath: string,
    workBranch: string | null,
    targetBranch: string,
    profile: BranchProfile | null,
    scope: { runId: string; identity: string },
  ): Promise<{ sourceBranch: string | null; sourceHead: string | null; taskBaseHead: string | null }> {
    const observedBranch = await currentBranch(checkoutPath);
    const candidateBranch = observedBranch === "HEAD" ? workBranch : observedBranch;
    if (!candidateBranch) return { sourceBranch: null, sourceHead: null, taskBaseHead: null };

    // #512 S-TB (c98ea8a3, S-TB-06) — a branch the control plane made for one of this run's tasks has
    // its origin on record: the declared parent and the pinned base commit it was created at. That is
    // the lineage frozen, whatever the parent's tip names now; it is never re-derived from a moving tip.
    // The candidate must still descend from that commit, or no origin is carried (fail closed).
    const recorded = recordedTargetForBranch(this.db, scope.runId, scope.identity, candidateBranch);
    if (recorded) {
      const candidateHead = await revParse(checkoutPath, "HEAD");
      const ancestor = await mergeBase(checkoutPath, recorded.baseSha, candidateHead);
      return ancestor === recorded.baseSha
        ? { sourceBranch: profile ? recorded.declaredParent : null, sourceHead: profile ? recorded.baseSha : null, taskBaseHead: recorded.baseSha }
        : { sourceBranch: null, sourceHead: null, taskBaseHead: null };
    }

    if (!profile) return { sourceBranch: null, sourceHead: null, taskBaseHead: null };

    const requiredSource = requiredBaseFor(candidateBranch, profile, targetBranch);
    if (!requiredSource) return { sourceBranch: null, sourceHead: null, taskBaseHead: null };

    const candidateHead = await revParse(checkoutPath, "HEAD");
    const probes = sourceProbeBranchesFor(candidateBranch, profile, targetBranch);
    const qualifying = (
      await Promise.all(
        probes.map(async (branch) => {
          const head = await tryRevParse(checkoutPath, branch);
          if (!head) return null;
          const ancestor = await mergeBase(checkoutPath, head, candidateHead);
          return ancestor === head ? { branch, head } : null;
        }),
      )
    ).filter((probe): probe is { branch: string; head: string } => probe !== null);

    const mostSpecific: Array<{ branch: string; head: string }> = [];
    for (const candidate of qualifying) {
      let isAncestorOfAnother = false;
      for (const other of qualifying) {
        if (candidate.branch === other.branch || candidate.head === other.head) continue;
        const relation = await mergeBase(checkoutPath, candidate.head, other.head);
        if (relation === candidate.head) {
          isAncestorOfAnother = true;
          break;
        }
      }
      if (!isAncestorOfAnother) mostSpecific.push(candidate);
    }

    if (mostSpecific.length !== 1) {
      // No unique fact exists. Carrying no origin preserves the existing fail-closed PR
      // behavior and prevents a shared ancestor from being silently assigned to dev/main.
      return { sourceBranch: null, sourceHead: null, taskBaseHead: null };
    }
    const selected = mostSpecific[0]!;
    // Keep a unique but wrong origin in the digest. assertFrozenSourceLineage then rejects
    // the candidate before any PR write, independently of branch divergence.
    return { sourceBranch: selected.branch, sourceHead: selected.head, taskBaseHead: null };
  }
}
