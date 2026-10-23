import { digestOf } from "../core/digest.ts";
import { EVIDENCE_PRODUCERS, type ArtifactStore, type StoredArtifact } from "../db/artifacts.ts";
import type { AuditLog, AuditRow } from "../db/audit.ts";
import type { Db } from "../db/database.ts";
import { ArtifactKind, type ReviewFindingCategory, type ReviewVerdict, RunState } from "../domain/types.ts";
import { MessageKind } from "../outbox/envelope.ts";
import type { Outbox, OutboxMessage } from "../outbox/outbox.ts";
import type { RunEngine } from "../run/run-engine.ts";
import type { BindingRegistry } from "../session/binding-registry.ts";
import type { ReviewFinding, ReviewPacket } from "./blind-review.ts";

/**
 * #1189 §2.C — what happened to a run's candidates after review, read from records that already
 * exist: the audit trail, the run's immutable artifacts, its outbox and its submission lease.
 *
 * It is a projection for the host and the CTO, and nothing else:
 * - It writes nothing and decides nothing. No gate reads it; the production gate, the pipeline and
 *   the CEO decision keep reading their own records, so nothing here can open or close a gate.
 * - Nothing here is given to a reviewer. Past verdicts, producer claims and CTO reasoning stay out
 *   of the independent reviewer's input; cross-round tracking happens on the host side only.
 * - A disposition (fixed, disputed, intentional, deferred) is a caller's note linked to a finding
 *   by the finding's digest. It is shown beside the finding and changes no verdict, outcome or
 *   readiness field: a new candidate still has to pass verification and a fresh review.
 *
 * A round is one candidate freeze (`CANDIDATE_FROZEN`) and what the trail records after it until
 * the next freeze. Submissions are serialised per run by the durable attempt lease, so a freeze
 * starts each attempt that reached one; a lease reclaimed while its holder still runs can interleave
 * two attempts, whose rows are then placed by freeze order. A chunked review is one review: its chunk
 * reviewers and the final reviewer are counted as reviewer invocations of that one round. An outcome
 * row repeated inside one round is counted once. A row whose evidence the audit refused names no
 * candidate and is not placed in any round.
 */

/**
 * Audit kinds that record an owner, CEO or escalation step: someone outside the CTO–reviewer loop
 * acting on the run. They are listed against the round they precede.
 */
export const REVIEW_ROUND_INTERVENTION_KINDS: readonly string[] = Object.freeze([
  "OWNER_DECISION",
  "OWNER_APPROVAL_INGRESS",
  "OWNER_APPROVAL_CONSUMED",
  "OWNER_REPLY_DELIVERED",
  "CEO_DECISION",
  "CTO_ESCALATION",
  "ESCALATION_REPLY_HELD",
  "ESCALATION_REPLY_CARRIED",
]);

/** How a round's candidate relates to the round before it. */
export type ReviewRoundEntry =
  | "FIRST_SUBMISSION"
  /** A different candidate digest than the previous round: the source changed. */
  | "SOURCE_CHANGE"
  /** The same candidate again after it was judged (returned or passed): nothing was changed. */
  | "SAME_CANDIDATE_RESUBMISSION"
  /** The same candidate again after nothing judged it (review unavailable, or no outcome recorded). */
  | "INFRASTRUCTURE_RETRY"
  /** The freeze row names no candidate digest, so the relation cannot be told. */
  | "CANDIDATE_UNRECORDED";

export type ReviewRoundOutcome =
  | "REVIEW_PASSED"
  /** A reviewer verdict (REVISE, BLOCK, omitted items) returned to the CTO. */
  | "REVISION_RETURNED"
  /** A failed or incomplete verification returned to the CTO. */
  | "VERIFICATION_RETURNED"
  /** Assurance could not be constituted (§18.7); not a code-fix verdict and not returned. */
  | "REVIEW_UNAVAILABLE"
  | "NO_OUTCOME_RECORDED";

export const FINDING_DISPOSITIONS = ["FIXED", "DISPUTED", "INTENTIONAL", "DEFERRED"] as const;

/** A note about one finding. It is linked, never consulted: no verdict or readiness reads it. */
export interface FindingDisposition {
  findingDigest: string;
  disposition: (typeof FINDING_DISPOSITIONS)[number];
  note: string;
  recordedBy: string;
}

export interface ReviewRoundFinding {
  /** `digestOf(finding)`, the digest the REVISION_RETURNED_TO_CTO row lists. */
  digest: string;
  category: ReviewFindingCategory;
  severity: ReviewFinding["severity"];
  repository: string;
  path: string | null;
  summary: string;
  /** Linked notes, shown and never read by any gate. */
  dispositions: FindingDisposition[];
}

export interface ReviewRoundReview {
  /** The stored BLIND_REVIEW artifact, or null when the trail names a review no artifact matches. */
  artifactDigest: string | null;
  reviewerSessionId: string | null;
  verdict: ReviewVerdict;
  reviewKind: "CANDIDATE" | "BOOTSTRAP_PLAN" | "CONTRACT_CHANGE";
  chunked: boolean;
  /** Chunk reviewers plus the final reviewer of a chunked review, 1 otherwise; null when unrecorded. */
  reviewerInvocations: number | null;
  omittedItems: number;
  /** The findings as the reviewer returned them, read from the immutable artifact. */
  findings: ReviewRoundFinding[];
}

export interface ReviewRoundDelivery {
  messageId: string;
  /** The submission attempt the revision was keyed by (`revision:<run>:<candidate>:<reason>:<attempt>`). */
  attemptId: string | null;
  status: OutboxMessage["status"];
  roleKey: string;
  bindingGeneration: number;
  targetSessionId: string;
  /** Whether the delivery's target is exactly the owner role's binding now. */
  toCurrentBinding: boolean;
  acknowledged: boolean;
}

export interface ReviewRound {
  round: number;
  frozenEventId: number;
  candidateSnapshotDigest: string | null;
  entry: ReviewRoundEntry;
  /** Owner, CEO or escalation facts after the previous freeze and before this one. */
  interventions: Array<{ eventId: number; kind: string }>;
  outcome: ReviewRoundOutcome;
  reasonCode: string | null;
  /** The submission attempt this round belongs to, when a record names it. */
  attemptId: string | null;
  review: ReviewRoundReview | null;
  deliveries: ReviewRoundDelivery[];
  /** The run moved to READY_FOR_CEO_REVIEW for this candidate within this round. */
  readyForCeo: boolean;
  /** The first later round with a different candidate digest. */
  nextNewCandidate: { round: number; candidateSnapshotDigest: string } | null;
  duplicateEventsIgnored: number;
}

export interface ReviewRoundSummary {
  runId: string;
  runState: string | null;
  currentCandidateDigest: string | null;
  ownerBinding: { roleKey: string; bindingGeneration: number; sessionId: string } | null;
  /** The run's submission lease: the latest attempt only, which is all the lease row keeps. */
  latestAttempt: { attemptId: string; state: string; candidateDigest: string | null; startedAt: string; releasedAt: string | null } | null;
  rounds: ReviewRound[];
  /** The first round whose review returned findings, preserved whatever later rounds did. */
  firstFindings: { round: number; findings: ReviewRoundFinding[] } | null;
  /** Dispositions whose digest names no finding of this run. */
  unlinkedDispositions: FindingDisposition[];
  totals: {
    rounds: number;
    reviews: number;
    reviewerInvocations: number;
    revisionReturns: number;
    verificationReturns: number;
    reviewUnavailable: number;
    sourceChanges: number;
    sameCandidateResubmissions: number;
    infrastructureRetries: number;
    roundsWithIntervention: number;
    duplicateEventsIgnored: number;
  };
}

/** Everything the projection reads, already loaded. */
export interface ReviewRoundSources {
  runId: string;
  runState: string | null;
  currentCandidateDigest: string | null;
  ownerBinding: ReviewRoundSummary["ownerBinding"];
  latestAttempt: ReviewRoundSummary["latestAttempt"];
  audit: readonly AuditRow[];
  artifacts: readonly StoredArtifact[];
  outbox: readonly OutboxMessage[];
}

/** The read-only ports a control plane already has. Only reads are called. */
export interface ReviewRoundReadPorts {
  audit: Pick<AuditLog, "forRun">;
  artifacts: Pick<ArtifactStore, "list">;
  outbox: Pick<Outbox, "listByRun">;
  bindings: Pick<BindingRegistry, "active">;
  runs: Pick<RunEngine, "get" | "ownerRoleKeyFor" | "currentCandidate">;
  db: Pick<Db, "get">;
}

export const readReviewRoundSources = (ports: ReviewRoundReadPorts, runId: string): ReviewRoundSources => {
  const run = ports.runs.get(runId);
  const roleKey = run === null ? null : ports.runs.ownerRoleKeyFor(run);
  const binding = roleKey === null ? null : ports.bindings.active(roleKey);
  const lease = ports.db.get<{
    attempt_id: string;
    state: string;
    candidate_digest: string | null;
    started_at: string;
    released_at: string | null;
  }>(
    `SELECT attempt_id, state, candidate_digest, started_at, released_at
       FROM candidate_pipeline_attempts WHERE run_id = ?`,
    [runId],
  );
  return {
    runId,
    runState: run?.state ?? null,
    currentCandidateDigest: ports.runs.currentCandidate(runId),
    ownerBinding: binding === null
      ? null
      : { roleKey: binding.roleKey, bindingGeneration: binding.bindingGeneration, sessionId: binding.sessionId },
    latestAttempt: lease
      ? {
          attemptId: lease.attempt_id,
          state: lease.state,
          candidateDigest: lease.candidate_digest,
          startedAt: lease.started_at,
          releasedAt: lease.released_at,
        }
      : null,
    audit: ports.audit.forRun(runId),
    artifacts: ports.artifacts.list(runId),
    outbox: ports.outbox.listByRun(runId),
  };
};

const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/** One round's rows of one kind, a repeated row (same `key`) counted once. */
const distinctRows = (rows: readonly AuditRow[], key: (row: AuditRow) => string): { rows: AuditRow[]; duplicates: number } => {
  const seen = new Map<string, AuditRow>();
  for (const row of rows) if (!seen.has(key(row))) seen.set(key(row), row);
  return { rows: [...seen.values()], duplicates: rows.length - seen.size };
};

const attemptOfKey = (idempotencyKey: string): string | null => {
  const last = idempotencyKey.slice(idempotencyKey.lastIndexOf(":") + 1);
  return last.startsWith("attempt_") ? last : null;
};

const reviewKindOf = (packet: ReviewPacket): ReviewRoundReview["reviewKind"] =>
  packet.bootstrapPlan ? "BOOTSTRAP_PLAN" : packet.contractChange ? "CONTRACT_CHANGE" : "CANDIDATE";

export const summarizeReviewRounds = (
  sources: ReviewRoundSources,
  options: { dispositions?: readonly FindingDisposition[] } = {},
): ReviewRoundSummary => {
  const audit = [...sources.audit].filter((row) => row.runId === sources.runId).sort((a, b) => a.eventId - b.eventId);
  const freezes = audit.filter((row) => row.kind === "CANDIDATE_FROZEN");
  // Only the review gate's own artifacts are reviews; anything else of that kind is not evidence.
  const reviewArtifacts = sources.artifacts.filter(
    (artifact) => artifact.kind === ArtifactKind.BLIND_REVIEW && artifact.producedBy === EVIDENCE_PRODUCERS.BLIND_REVIEW,
  ) as Array<StoredArtifact<ReviewPacket>>;
  const revisionMessages = sources.outbox.filter((message) => message.kind === MessageKind.REVISION_REQUEST);
  const dispositions = options.dispositions ?? [];
  const linked = new Set<string>();

  const findingsOf = (packet: ReviewPacket): ReviewRoundFinding[] =>
    (Array.isArray(packet.findings) ? packet.findings : []).map((finding) => {
      const digest = digestOf(finding);
      const notes = dispositions.filter((entry) => entry.findingDigest === digest);
      if (notes.length > 0) linked.add(digest);
      return {
        digest,
        category: finding.category,
        severity: finding.severity,
        repository: finding.repository,
        path: finding.path,
        summary: finding.summary,
        dispositions: notes.map((entry) => ({ ...entry })),
      };
    });

  const toDelivery = (message: OutboxMessage): ReviewRoundDelivery => {
    const owner = sources.ownerBinding;
    return {
      messageId: message.messageId,
      attemptId: attemptOfKey(message.idempotencyKey),
      status: message.status,
      roleKey: message.roleKey,
      bindingGeneration: message.bindingGeneration,
      targetSessionId: message.targetSessionId,
      toCurrentBinding:
        owner !== null &&
        message.roleKey === owner.roleKey &&
        message.bindingGeneration === owner.bindingGeneration &&
        message.targetSessionId === owner.sessionId,
      acknowledged: message.status === "ACKED",
    };
  };

  const rounds: ReviewRound[] = freezes.map((freeze, index) => {
    const next = freezes[index + 1];
    const previous = freezes[index - 1];
    const digest = text(freeze.evidence["candidateSnapshotDigest"]);
    const window = audit.filter((row) => row.eventId > freeze.eventId && (next === undefined || row.eventId < next.eventId));
    const forCandidate = (row: AuditRow): boolean => text(row.evidence["candidateSnapshotDigest"]) === digest;

    const completed = distinctRows(
      window.filter((row) => row.kind === "BLIND_REVIEW_COMPLETED" && forCandidate(row)),
      (row) => `${row.sessionId ?? ""}|${String(row.evidence["verdict"])}`,
    );
    const unavailable = distinctRows(
      window.filter((row) => row.kind === "BLIND_REVIEW_UNAVAILABLE" && forCandidate(row)),
      (row) => row.reasonCode ?? "",
    );
    const returned = distinctRows(
      window.filter((row) => row.kind === "REVISION_RETURNED_TO_CTO" && forCandidate(row)),
      (row) => [
        String(row.evidence["stage"]),
        row.reasonCode ?? "",
        String(row.evidence["reviewArtifactDigest"] ?? row.evidence["reportDigest"] ?? ""),
      ].join("|"),
    );
    const readyForCeo = window.some(
      (row) => row.kind === "RUN_TRANSITION" && row.evidence["to"] === RunState.READY_FOR_CEO_REVIEW && forCandidate(row),
    );

    // The review of this round: the artifact a return names, else the one its reviewer session wrote.
    const lastReturn = returned.rows.at(-1);
    const lastCompleted = completed.rows.at(-1);
    const namedDigest = text(lastReturn?.evidence["reviewArtifactDigest"]);
    const artifact =
      (namedDigest === null ? undefined : reviewArtifacts.find((entry) => entry.digest === namedDigest)) ??
      (lastCompleted?.sessionId
        ? reviewArtifacts.find(
            (entry) => entry.candidateSnapshotDigest === digest && entry.content.reviewerSessionId === lastCompleted.sessionId,
          )
        : undefined);
    const chunkSessions = lastCompleted?.evidence["chunkReviewerSessions"];
    const chunked = artifact?.content.chunked ?? lastCompleted?.evidence["chunked"] === true;
    const verdict = (artifact?.content.verdict ?? text(lastCompleted?.evidence["verdict"])) as ReviewVerdict | null;
    const review: ReviewRoundReview | null =
      verdict === null
        ? null
        : {
            artifactDigest: artifact?.digest ?? null,
            reviewerSessionId: artifact?.content.reviewerSessionId ?? lastCompleted?.sessionId ?? null,
            verdict,
            reviewKind: artifact ? reviewKindOf(artifact.content) : "CANDIDATE",
            chunked,
            reviewerInvocations: !chunked ? 1 : Array.isArray(chunkSessions) ? chunkSessions.length + 1 : null,
            omittedItems: artifact ? artifact.content.omittedItems.length : 0,
            findings: artifact ? findingsOf(artifact.content) : [],
          };

    let outcome: ReviewRoundOutcome = "NO_OUTCOME_RECORDED";
    let reasonCode: string | null = null;
    if (lastReturn) {
      outcome = lastReturn.evidence["stage"] === "verification" ? "VERIFICATION_RETURNED" : "REVISION_RETURNED";
      reasonCode = lastReturn.reasonCode;
    } else if (unavailable.rows.length > 0) {
      outcome = "REVIEW_UNAVAILABLE";
      reasonCode = unavailable.rows.at(-1)!.reasonCode;
    } else if (review?.verdict === "PASS") {
      outcome = "REVIEW_PASSED";
      reasonCode = lastCompleted?.reasonCode ?? null;
    }

    // The delivery of a return: the REVISION_REQUEST that carried this review, or this report.
    const reportDigest = text(lastReturn?.evidence["reportDigest"]);
    const deliveries = lastReturn
      ? revisionMessages
          .filter((message) => {
            const payload = record(message.payload);
            if (payload === null || payload["candidateSnapshotDigest"] !== digest || payload["reasonCode"] !== lastReturn.reasonCode) {
              return false;
            }
            if (outcome === "VERIFICATION_RETURNED") return reportDigest !== null && digestOf(payload["report"] ?? null) === reportDigest;
            const packet = record(payload["packet"]);
            return review?.reviewerSessionId != null && packet?.["reviewerSessionId"] === review.reviewerSessionId;
          })
          .map(toDelivery)
      : [];

    const lease = sources.latestAttempt;
    const attemptId =
      deliveries.find((delivery) => delivery.attemptId !== null)?.attemptId ??
      (next === undefined && lease !== null && digest !== null && lease.candidateDigest === digest ? lease.attemptId : null);

    const interventions = audit
      .filter(
        (row) =>
          row.eventId < freeze.eventId &&
          (previous === undefined || row.eventId > previous.eventId) &&
          REVIEW_ROUND_INTERVENTION_KINDS.includes(row.kind),
      )
      .map((row) => ({ eventId: row.eventId, kind: row.kind }));

    return {
      round: index + 1,
      frozenEventId: freeze.eventId,
      candidateSnapshotDigest: digest,
      entry: "FIRST_SUBMISSION",
      interventions,
      outcome,
      reasonCode,
      attemptId,
      review,
      deliveries,
      readyForCeo,
      nextNewCandidate: null,
      duplicateEventsIgnored: completed.duplicates + unavailable.duplicates + returned.duplicates,
    };
  });

  for (const [index, round] of rounds.entries()) {
    const previous = rounds[index - 1];
    if (previous !== undefined) {
      round.entry =
        round.candidateSnapshotDigest === null || previous.candidateSnapshotDigest === null
          ? "CANDIDATE_UNRECORDED"
          : round.candidateSnapshotDigest !== previous.candidateSnapshotDigest
            ? "SOURCE_CHANGE"
            : previous.outcome === "REVIEW_UNAVAILABLE" || previous.outcome === "NO_OUTCOME_RECORDED"
              ? "INFRASTRUCTURE_RETRY"
              : "SAME_CANDIDATE_RESUBMISSION";
    }
    const later = rounds
      .slice(index + 1)
      .find((candidate) => candidate.candidateSnapshotDigest !== null && candidate.candidateSnapshotDigest !== round.candidateSnapshotDigest);
    round.nextNewCandidate = later ? { round: later.round, candidateSnapshotDigest: later.candidateSnapshotDigest! } : null;
  }

  const first = rounds.find((round) => (round.review?.findings.length ?? 0) > 0);
  const count = (predicate: (round: ReviewRound) => boolean): number => rounds.filter(predicate).length;
  return {
    runId: sources.runId,
    runState: sources.runState,
    currentCandidateDigest: sources.currentCandidateDigest,
    ownerBinding: sources.ownerBinding,
    latestAttempt: sources.latestAttempt,
    rounds,
    firstFindings: first ? { round: first.round, findings: first.review!.findings } : null,
    unlinkedDispositions: dispositions.filter((entry) => !linked.has(entry.findingDigest)).map((entry) => ({ ...entry })),
    totals: {
      rounds: rounds.length,
      reviews: count((round) => round.review !== null),
      reviewerInvocations: rounds.reduce((sum, round) => sum + (round.review?.reviewerInvocations ?? 0), 0),
      revisionReturns: count((round) => round.outcome === "REVISION_RETURNED"),
      verificationReturns: count((round) => round.outcome === "VERIFICATION_RETURNED"),
      reviewUnavailable: count((round) => round.outcome === "REVIEW_UNAVAILABLE"),
      sourceChanges: count((round) => round.entry === "SOURCE_CHANGE"),
      sameCandidateResubmissions: count((round) => round.entry === "SAME_CANDIDATE_RESUBMISSION"),
      infrastructureRetries: count((round) => round.entry === "INFRASTRUCTURE_RETRY"),
      roundsWithIntervention: count((round) => round.interventions.length > 0),
      duplicateEventsIgnored: rounds.reduce((sum, round) => sum + round.duplicateEventsIgnored, 0),
    },
  };
};
