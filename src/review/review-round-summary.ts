import { digestOf } from "../core/digest.ts";
import { EVIDENCE_PRODUCERS, type ArtifactStore, type StoredArtifact } from "../db/artifacts.ts";
import type { AuditLog, AuditRow } from "../db/audit.ts";
import type { Db } from "../db/database.ts";
import { ArtifactKind, type ReviewFindingCategory, type ReviewVerdict, RunState } from "../domain/types.ts";
import { MessageKind } from "../outbox/envelope.ts";
import { outboxDeliveryReadback, type Outbox, type OutboxMessage } from "../outbox/outbox.ts";
import type { RunEngine } from "../run/run-engine.ts";
import type { BindingRegistry } from "../session/binding-registry.ts";
import { type CandidateSnapshot, candidateSnapshotDigest } from "../snapshot/candidate-snapshot.ts";
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
 * A round is one candidate freeze (`CANDIDATE_FROZEN`): one submission attempt that reached a freeze.
 * A record is placed on the attempt that wrote it, never by trail order alone:
 * - The pipeline names its attempt (`attemptId`) on the freeze row and on an unavailable review's row
 *   (#1189); a revision's delivery names it in its key. A freeze's stamp is trusted only when it is an
 *   attempt id that names that freeze alone and the run's own records (the lease row, its reclaim
 *   records, its delivery keys) do not tie that attempt to another candidate or run. A record whose
 *   stamp is not trusted, names another candidate, or stands before that attempt's freeze is listed.
 * - A review completion names its reviewer session; the reviewer's first binding row places it on the
 *   attempt that constituted it, when only one attempt could have, and only if it agrees with the
 *   review stored for that reviewer. A return goes to the round whose own trusted attempt delivered
 *   it; a reviewed candidate's move to CEO review is read from its production-ready packet.
 * - A record with none of these (written before the stamp existed, or carrying none) is attributed only
 *   by a correspondence shown unique: its candidate was frozen by one round only, or it is the only
 *   record of its kind and stands where one attempt alone could write (the durable lease lets only the
 *   window's own attempt, and a reclaimed earlier one, write). Identical records of a candidate
 *   submitted more than once stay unattributed.
 * Each round's slot takes the records claimed for it together: one record and its repeats, or, when
 * different records claim one slot, none of them. What cannot be shown is listed in
 * `unattributedEvents` (or `unattributedDeliveries`) with the rounds it could belong to. The lease
 * row, which keeps only the latest attempt, is shown, and used only to contradict a stamp.
 * A chunked review is one review: its chunk reviewers and the final reviewer are reviewer
 * invocations of one round. A row whose evidence the audit refused names no candidate and is not
 * placed on any round.
 */

/**
 * Audit kinds that record an owner, CEO or escalation step: someone outside the CTO–reviewer loop
 * acting on the run. Each is shown on the round whose candidate was the latest frozen when it
 * happened, at once — it does not wait for, or make, another round.
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
  /** A new candidate whose stored content evidence (trees and diffs, planned outputs, manifest) differs. */
  | "SOURCE_CHANGE"
  /**
   * A new candidate digest with the same content evidence: an empty commit, a moved lineage, or a PLAN
   * whose text alone changed. It is still a new candidate, and still needs its own review.
   */
  | "CANDIDATE_IDENTITY_CHANGE"
  /** A new candidate digest, but a snapshot to compare its content with is not stored. */
  | "NEW_CANDIDATE_CONTENT_UNRECORDED"
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
  status: ReturnType<typeof outboxDeliveryReadback>["status"];
  delivery: string;
  automaticResendHeld: boolean;
  delivered: boolean;
  completed: boolean;
  roleKey: string;
  bindingGeneration: number;
  targetSessionId: string;
  /** Whether the delivery's target is exactly the owner role's binding now. */
  toCurrentBinding: boolean;
  acknowledged: boolean;
}

/**
 * F1 — the in-band notice the pipeline sent the owner for a review that did not judge the product
 * (`CandidatePipeline.noticeUnjudgedReview`): a REVISION_REQUEST marked `stage: "review-unavailable"`, which
 * asks for no revision and carries no return. `notice` is its fixed notice code, or null for any other value.
 */
export interface ReviewRoundNotice extends ReviewRoundDelivery {
  notice: "METHOD_FINDINGS_ONLY" | "REVIEW_UNAVAILABLE" | null;
}

export interface ReviewRound {
  round: number;
  frozenEventId: number;
  candidateSnapshotDigest: string | null;
  /** Digest of the candidate's content evidence, from its stored snapshot; null when none is stored. */
  contentDigest: string | null;
  entry: ReviewRoundEntry;
  /** Owner, CEO or escalation facts after this freeze and before the next one, shown at once. */
  interventions: Array<{ eventId: number; kind: string }>;
  outcome: ReviewRoundOutcome;
  reasonCode: string | null;
  /** The submission attempt this round belongs to, when the records name exactly one. */
  attemptId: string | null;
  /** The attempt's lease was reclaimed while it ran: it may have written after the next freeze. */
  attemptReclaimed: boolean;
  review: ReviewRoundReview | null;
  deliveries: ReviewRoundDelivery[];
  /** Review-unavailable notices sent for this round's own unavailable review; never a revision delivery. */
  notices: ReviewRoundNotice[];
  /** This attempt moved the run to READY_FOR_CEO_REVIEW. Never true unless its review passed. */
  readyForCeo: boolean;
  /** The first later round with a different candidate digest. */
  nextNewCandidate: { round: number; candidateSnapshotDigest: string } | null;
  duplicateEventsIgnored: number;
}

/** A record this projection could not place on exactly one round. */
export interface UnattributedReviewEvent {
  eventId: number;
  kind: string;
  /** The rounds it could belong to: two or more when ambiguous, none when no round can take it. */
  candidateRounds: number[];
}

export interface ReviewRoundSummary {
  runId: string;
  runState: string | null;
  currentCandidateDigest: string | null;
  ownerBinding: { roleKey: string; bindingGeneration: number; sessionId: string } | null;
  /** The run's submission lease: the latest attempt only, which is all the lease row keeps. */
  latestAttempt: { attemptId: string; state: string; candidateDigest: string | null; startedAt: string; releasedAt: string | null } | null;
  rounds: ReviewRound[];
  /** Interventions recorded before the run's first freeze. */
  interventionsBeforeFirstRound: Array<{ eventId: number; kind: string }>;
  /** Records placed on no round, with the rounds each could belong to. Never guessed onto one. */
  unattributedEvents: UnattributedReviewEvent[];
  /** REVISION_REQUEST deliveries that match more than one round's return and no single attempt, or a notice no round's unavailable review fits. */
  unattributedDeliveries: Array<{ messageId: string; candidateRounds: number[] } & Partial<ReturnType<typeof outboxDeliveryReadback>>>;
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
    candidateIdentityChanges: number;
    sameCandidateResubmissions: number;
    infrastructureRetries: number;
    roundsWithIntervention: number;
    duplicateEventsIgnored: number;
    unattributedEvents: number;
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

/** A revision's key, `revision:<run>:<candidate>:<reason>:<attempt>`, read back; null when it is not one. */
const revisionKeyOf = (
  idempotencyKey: string,
): { runId: string; candidateDigest: string; reasonCode: string; attemptId: string } | null => {
  if (!idempotencyKey.startsWith("revision:")) return null;
  const rest = idempotencyKey.slice("revision:".length);
  const runEnd = rest.indexOf(":");
  const attemptStart = rest.lastIndexOf(":");
  const reasonStart = rest.lastIndexOf(":", attemptStart - 1);
  if (runEnd <= 0 || reasonStart <= runEnd || attemptStart <= reasonStart + 1) return null;
  const attemptId = rest.slice(attemptStart + 1);
  if (!ATTEMPT_ID.test(attemptId)) return null;
  return {
    runId: rest.slice(0, runEnd),
    candidateDigest: rest.slice(runEnd + 1, reasonStart),
    reasonCode: rest.slice(reasonStart + 1, attemptStart),
    attemptId,
  };
};

const attemptOfKey = (idempotencyKey: string): string | null => {
  const last = idempotencyKey.slice(idempotencyKey.lastIndexOf(":") + 1);
  return last.startsWith("attempt_") ? last : null;
};

const reviewKindOf = (packet: ReviewPacket): ReviewRoundReview["reviewKind"] =>
  packet.bootstrapPlan ? "BOOTSTRAP_PLAN" : packet.contractChange ? "CONTRACT_CHANGE" : "CANDIDATE";

/**
 * What a candidate's content is, apart from its identity: each repository's tree and diff, a
 * bootstrap PLAN's planned outputs and the manifest it plans, a contract change's manifests and
 * workflow revisions. Heads, lineage, the PLAN's own text and the task contract are identity only.
 */
const contentDigestOf = (snapshot: CandidateSnapshot): string =>
  digestOf({
    repositories: snapshot.repositories
      .map((repository) => ({ identity: repository.identity, treeDigest: repository.treeDigest, diffDigest: repository.diffDigest }))
      .sort((a, b) => (a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0)),
    bootstrapPlan: snapshot.bootstrapPlan
      ? { plannedOutputsDigest: snapshot.bootstrapPlan.plannedOutputsDigest, projectManifestDigest: snapshot.bootstrapPlan.projectManifestDigest }
      : null,
    contractChange: snapshot.contractChange
      ? {
          manifestDigest: snapshot.contractChange.manifestDigest,
          baseManifestDigest: snapshot.contractChange.baseManifestDigest,
          workflowRevisionsDigest: "workflowRevisionsDigest" in snapshot.contractChange ? snapshot.contractChange.workflowRevisionsDigest : null,
        }
      : null,
  });

/** The shape of a pipeline attempt id (`attempt_` and 24 hex digits); anything else is not one. */
const ATTEMPT_ID = /^attempt_[0-9a-f]{24}$/;

/** The role key prefix of a run's blind-reviewer bindings (`roleKeyFor(BLIND_REVIEWER, { runId })`). */
const REVIEWER_ROLE_PREFIX = "BLIND_REVIEWER:";
/** A review constitutes exactly one of these per attempt: its single reviewer, or its final one. */
const TERMINAL_PURPOSES = new Set(["blind-review", "blind-review-final"]);

interface RoundState {
  index: number;
  freeze: AuditRow;
  digest: string | null;
  reclaimed: boolean;
  /** Its freeze carries an attempt stamp the run's own records contradict: nothing is attributed to it. */
  tainted: boolean;
  /** The attempt this round is, once a record proves it; never replaced or cleared afterwards. */
  attemptId: string | null;
  bindings: Array<{ sessionId: string; purpose: string | null }>;
  completed: AuditRow[];
  unavailable: AuditRow[];
  returned: AuditRow[];
  ready: AuditRow[];
  /** Production-ready packets resting on this round's review, by artifact digest. */
  readyPackets: Set<string>;
  duplicates: number;
  interventions: Array<{ eventId: number; kind: string }>;
}

type Slot = "completed" | "unavailable" | "returned" | "ready";

/** What makes two rows the same record: a replay repeats every one of these. */
const keyOf = (row: AuditRow): string =>
  [
    row.kind,
    row.sessionId ?? "",
    row.reasonCode ?? "",
    text(row.evidence["candidateSnapshotDigest"]) ?? "",
    String(row.evidence["verdict"] ?? ""),
    String(row.evidence["stage"] ?? ""),
    String(row.evidence["reviewArtifactDigest"] ?? row.evidence["reportDigest"] ?? ""),
    String(row.evidence["to"] ?? ""),
  ].join("|");

const isReadyTransition = (row: AuditRow): boolean =>
  row.kind === "RUN_TRANSITION" && row.evidence["to"] === RunState.READY_FOR_CEO_REVIEW;

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
  const readyPackets = sources.artifacts.filter(
    (artifact) =>
      artifact.kind === ArtifactKind.PRODUCTION_READY_PACKET && artifact.producedBy === EVIDENCE_PRODUCERS.PRODUCTION_READY_PACKET,
  );
  const revisionMessages = sources.outbox.filter((message) => message.kind === MessageKind.REVISION_REQUEST);
  const dispositions = options.dispositions ?? [];
  const linked = new Set<string>();
  const unattributed: UnattributedReviewEvent[] = [];
  const unattributedDeliveries: ReviewRoundSummary["unattributedDeliveries"] = [];
  const interventionsBeforeFirstRound: Array<{ eventId: number; kind: string }> = [];

  const states: RoundState[] = freezes.map((freeze, index) => ({
    index,
    freeze,
    digest: text(freeze.evidence["candidateSnapshotDigest"]),
    reclaimed: false,
    tainted: false,
    attemptId: null,
    bindings: [],
    completed: [],
    unavailable: [],
    returned: [],
    ready: [],
    readyPackets: new Set<string>(),
    duplicates: 0,
    interventions: [],
  }));

  /** The round whose freeze is the latest before `eventId`, or -1 before the first freeze. */
  const windowOf = (eventId: number): number => {
    let found = -1;
    for (const state of states) if (state.freeze.eventId < eventId) found = state.index;
    return found;
  };
  /** The window's own round, then every earlier round whose attempt was reclaimed; for `digest` when given. */
  const roundsThatCouldWrite = (eventId: number, digest: string | null): RoundState[] => {
    const window = windowOf(eventId);
    if (window < 0) return [];
    return states.filter(
      (state) =>
        (state.index === window || (state.index < window && state.reclaimed)) && (digest === null || state.digest === digest),
    );
  };
  const slotOf = (row: AuditRow): Slot =>
    row.kind === "BLIND_REVIEW_COMPLETED"
      ? "completed"
      : row.kind === "BLIND_REVIEW_UNAVAILABLE"
        ? "unavailable"
        : row.kind === "REVISION_RETURNED_TO_CTO"
          ? "returned"
          : "ready";
  const occupy = (state: RoundState, row: AuditRow): void => {
    state[slotOf(row)].push(row);
  };
  const unplaced = (row: AuditRow, rounds: readonly RoundState[]): void => {
    unattributed.push({ eventId: row.eventId, kind: row.kind, candidateRounds: rounds.map((state) => state.index + 1) });
  };

  // Attempt identity. A round's attempt is set once, from a record that proves it, and never
  // replaced or cleared; an attempt belongs to at most one round. The lease row keeps only the
  // latest attempt, so it is used to contradict a stamp, never to name one.
  const roundOfAttempt = new Map<string, number>();
  /** Attempt ids a stamp check refused: no later path may name them again. */
  const rejectedAttempts = new Set<string>();
  const establish = (state: RoundState, attemptId: string): void => {
    if (state.attemptId !== null || state.tainted || roundOfAttempt.has(attemptId) || rejectedAttempts.has(attemptId)) return;
    state.attemptId = attemptId;
    roundOfAttempt.set(attemptId, state.index);
  };
  const reclaims = audit.filter((entry) => entry.kind === "CANDIDATE_PIPELINE_ATTEMPT_RECLAIMED");

  // The pipeline names its attempt on the freeze row (#1189). A stamp is trusted only when it is an
  // attempt id that names this freeze alone and nothing the run's pipeline recorded contradicts it:
  // the lease row binding that attempt to another candidate, a reclaim of it that started after this
  // freeze, or a delivery keyed by it for another run or candidate.
  const stampUses = new Map<string, number>();
  for (const state of states) {
    const stamp = state.freeze.evidence["attemptId"];
    if (typeof stamp === "string") stampUses.set(stamp, (stampUses.get(stamp) ?? 0) + 1);
  }
  const contradicted = (state: RoundState, stamp: string): boolean => {
    if (!ATTEMPT_ID.test(stamp) || stampUses.get(stamp) !== 1 || state.digest === null) return true;
    const lease = sources.latestAttempt;
    if (lease !== null && lease.attemptId === stamp && lease.candidateDigest !== null && lease.candidateDigest !== state.digest) return true;
    if (reclaims.some((row) => row.evidence["attemptId"] === stamp && (text(row.evidence["startedAt"]) ?? "") > state.freeze.at)) return true;
    return revisionMessages.some(
      (message) =>
        attemptOfKey(message.idempotencyKey) === stamp &&
        (message.runId !== sources.runId || !message.idempotencyKey.startsWith(`revision:${sources.runId}:${state.digest}:`)),
    );
  };
  // A stamp that is present but not trusted taints its round and its attempt id for every later path.
  for (const state of states) {
    if (!Object.hasOwn(state.freeze.evidence, "attemptId")) continue;
    const stamp = state.freeze.evidence["attemptId"];
    if (typeof stamp === "string" && !contradicted(state, stamp)) continue;
    state.tainted = true;
    if (typeof stamp === "string") rejectedAttempts.add(stamp);
  }
  for (const state of states) {
    const stamp = state.freeze.evidence["attemptId"];
    if (typeof stamp === "string" && !state.tainted) establish(state, stamp);
  }

  // A reclaimed attempt may still write after the next freeze: exactly that round when its stamp is
  // trusted; without one, the round frozen last before the reclaim, as a possibility only.
  for (const row of reclaims) {
    const attemptId = text(row.evidence["attemptId"]);
    const known = attemptId === null ? undefined : roundOfAttempt.get(attemptId);
    if (known !== undefined) {
      states[known]!.reclaimed = true;
      continue;
    }
    const state = states[windowOf(row.eventId)];
    if (state !== undefined && state.attemptId === null) state.reclaimed = true;
  }

  // Each reviewer session, on the attempt that constituted it: its first binding row only, so a
  // replayed binding cannot move it, and only when one attempt could have constituted it then. A
  // review constitutes one terminal reviewer ("blind-review", or "blind-review-final" after its
  // chunks), so an attempt that already has a reviewer cannot be constituting a later single review's.
  const sessionRounds = new Map<string, number[]>();
  const generationsSeen = new Set<string>();
  for (const row of audit) {
    if ((row.kind !== "BINDING_CREATED" && row.kind !== "BINDING_SWITCHED") || !row.roleKey?.startsWith(REVIEWER_ROLE_PREFIX) || !row.sessionId) {
      continue;
    }
    const generation = row.evidence[row.kind === "BINDING_CREATED" ? "generation" : "toGeneration"];
    const generationKey = `${row.roleKey}#${String(generation)}`;
    if (sessionRounds.has(row.sessionId) || generationsSeen.has(generationKey)) continue;
    generationsSeen.add(generationKey);
    const reason = text(row.evidence["reason"]);
    const purpose = row.kind === "BINDING_SWITCHED" && reason?.startsWith("constituting ") ? reason.slice("constituting ".length) : null;
    const candidates = roundsThatCouldWrite(row.eventId, null).filter((state) =>
      purpose === "blind-review"
        ? state.bindings.length === 0
        : !state.bindings.some((binding) => binding.purpose !== null && TERMINAL_PURPOSES.has(binding.purpose)),
    );
    sessionRounds.set(row.sessionId, candidates.map((state) => state.index));
    if (candidates.length === 1) candidates[0]!.bindings.push({ sessionId: row.sessionId, purpose });
  }

  const reviewSessionOf = (row: AuditRow): string | null => {
    if (row.kind === "BLIND_REVIEW_COMPLETED") return row.sessionId;
    const named = text(row.evidence["reviewArtifactDigest"]);
    return named === null ? null : (reviewArtifacts.find((artifact) => artifact.digest === named)?.content.reviewerSessionId ?? null);
  };

  /** Whether a REVISION_REQUEST delivered exactly this return: the same candidate, reason, and report or review. */
  const deliveredReturn = (message: OutboxMessage, row: AuditRow, fallbackReviewerSessionId: string | null = null): boolean => {
    const payload = record(message.payload);
    if (payload === null || payload["candidateSnapshotDigest"] !== text(row.evidence["candidateSnapshotDigest"])) return false;
    if (payload["reasonCode"] !== row.reasonCode) return false;
    if (row.evidence["stage"] === "verification") {
      const reportDigest = text(row.evidence["reportDigest"]);
      return reportDigest !== null && digestOf(payload["report"] ?? null) === reportDigest;
    }
    const reviewerSessionId = reviewSessionOf(row) ?? fallbackReviewerSessionId;
    return reviewerSessionId !== null && record(payload["packet"])?.["reviewerSessionId"] === reviewerSessionId;
  };

  // Content evidence by candidate, from snapshots whose own content proves the digest they are stored
  // under; and whether that candidate is reviewed at all (an administrative candidate is not).
  const contentByCandidate = new Map<string, string>();
  const unreviewedCandidates = new Set<string>();
  for (const artifact of sources.artifacts) {
    if (artifact.kind !== ArtifactKind.CANDIDATE_SNAPSHOT || artifact.candidateSnapshotDigest === null) continue;
    const content = record(artifact.content);
    if (content === null || !Array.isArray(content["repositories"])) continue;
    const snapshot = content as unknown as CandidateSnapshot;
    if (candidateSnapshotDigest(snapshot) === artifact.candidateSnapshotDigest) {
      contentByCandidate.set(artifact.candidateSnapshotDigest, contentDigestOf(snapshot));
      if (snapshot.repositories.length === 0 && snapshot.bootstrapPlan === undefined && snapshot.contractChange === undefined) {
        unreviewedCandidates.add(artifact.candidateSnapshotDigest);
      }
    }
  }

  // Every record is first given an owner by a proven, unique correspondence, or none; then each
  // round's slot takes its claims together, so no outcome depends on which claim is read first.
  const claims = new Map<RoundState, AuditRow[]>();
  const claim = (state: RoundState, row: AuditRow): void => {
    // A round whose stamp was refused takes nothing, by any path: what would be its own is listed.
    if (state.tainted) {
      unplaced(row, [state]);
      return;
    }
    claims.set(state, [...(claims.get(state) ?? []), row]);
  };
  const frozenAs = (digest: string): RoundState[] => states.filter((state) => state.digest === digest);

  /** A record with no identity of its own: its candidate frozen once, or the only such record where one attempt could write. */
  const identityFree = (rows: readonly AuditRow[], digest: string, couldWrite: (row: AuditRow) => RoundState[]): void => {
    const frozen = frozenAs(digest);
    if (frozen.length === 1) {
      for (const row of rows) claim(frozen[0]!, row);
      return;
    }
    if (rows.length === 1) {
      const writers = couldWrite(rows[0]!);
      if (writers.length === 1) claim(writers[0]!, rows[0]!);
      else unplaced(rows[0]!, writers);
      return;
    }
    // The same record more than once, for a candidate frozen more than once: whose each one is cannot be told.
    for (const row of rows) unplaced(row, frozen);
  };

  const byKey = new Map<string, AuditRow[]>();
  for (const row of audit) {
    const digest = text(row.evidence["candidateSnapshotDigest"]);
    if (digest === null) continue;
    const outcome = row.kind === "BLIND_REVIEW_COMPLETED" || row.kind === "BLIND_REVIEW_UNAVAILABLE" || row.kind === "REVISION_RETURNED_TO_CTO";
    const unreviewedReady = isReadyTransition(row) && unreviewedCandidates.has(digest);
    if (!outcome && !unreviewedReady) continue;

    // A stamped record goes to its attempt's round, when the stamp is trusted and fits: same candidate, after that freeze.
    if (Object.hasOwn(row.evidence, "attemptId")) {
      const stamp = row.evidence["attemptId"];
      const known = typeof stamp === "string" && ATTEMPT_ID.test(stamp) ? roundOfAttempt.get(stamp) : undefined;
      const target = known === undefined ? undefined : states[known]!;
      if (target !== undefined && target.digest === digest && row.eventId > target.freeze.eventId) claim(target, row);
      else unplaced(row, []);
      continue;
    }
    // A record naming its reviewer goes where that reviewer was constituted, if it agrees with the review stored.
    const session = row.kind === "BLIND_REVIEW_COMPLETED" || (row.kind === "REVISION_RETURNED_TO_CTO" && row.evidence["stage"] !== "verification")
      ? reviewSessionOf(row)
      : null;
    const rounds = session === null ? undefined : sessionRounds.get(session);
    if (rounds !== undefined) {
      const matching = rounds.map((index) => states[index]!).filter((state) => state.digest === digest);
      const stored = reviewArtifacts.find((artifact) => artifact.content.reviewerSessionId === session && artifact.candidateSnapshotDigest === digest);
      const agrees = row.kind !== "BLIND_REVIEW_COMPLETED" || stored === undefined || stored.content.verdict === row.evidence["verdict"];
      if (matching.length === 1 && agrees) claim(matching[0]!, row);
      else unplaced(row, matching);
      continue;
    }
    byKey.set(keyOf(row), [...(byKey.get(keyOf(row)) ?? []), row]);
  }

  for (const rows of byKey.values()) {
    const first = rows[0]!;
    const digest = text(first.evidence["candidateSnapshotDigest"])!;
    if (isReadyTransition(first)) {
      identityFree(rows, digest, (row) =>
        roundsThatCouldWrite(row.eventId, digest).filter((state) => !(claims.get(state) ?? []).some((held) => !isReadyTransition(held))),
      );
      continue;
    }
    if (first.kind === "REVISION_RETURNED_TO_CTO") {
      // A return is the round's whose own attempt delivered it. Each such round takes the copy written
      // in its own window; another copy repeats the one round's return, or is listed when several rounds delivered it.
      const proven = states.filter(
        (state) =>
          state.attemptId !== null &&
          revisionMessages.some((message) => attemptOfKey(message.idempotencyKey) === state.attemptId && deliveredReturn(message, first)),
      );
      if (proven.length > 0) {
        const taken = new Set<AuditRow>();
        for (const state of proven) {
          const own = rows.find((row) => !taken.has(row) && windowOf(row.eventId) === state.index);
          if (own !== undefined) {
            taken.add(own);
            claim(state, own);
          }
        }
        // Another copy repeats the delivered return only when no other attempt could have written it:
        // every other attempt that could write there has delivered a different return of its own.
        for (const row of rows.filter((row) => !taken.has(row))) {
          const others = roundsThatCouldWrite(row.eventId, digest).filter(
            (state) =>
              !proven.includes(state) &&
              !(state.attemptId !== null && revisionMessages.some((message) => attemptOfKey(message.idempotencyKey) === state.attemptId)),
          );
          if (proven.length === 1 && others.length === 0) claim(proven[0]!, row);
          else unplaced(row, [...proven, ...others].sort((a, b) => a.index - b.index));
        }
        continue;
      }
    }
    identityFree(rows, digest, (row) => roundsThatCouldWrite(row.eventId, digest));
  }

  // Each round takes its claims per slot: one distinct record (its repeats counted once), or, when
  // two different records claim the same slot, neither.
  const groupOf = (row: AuditRow): string =>
    row.kind === "REVISION_RETURNED_TO_CTO" ? "returned" : isReadyTransition(row) ? "ready" : "outcome";
  for (const state of states) {
    const held = (claims.get(state) ?? []).sort((a, b) => a.eventId - b.eventId);
    for (const group of ["outcome", "returned", "ready"]) {
      const rows = held.filter((row) => groupOf(row) === group);
      if (rows.length === 0) continue;
      if (new Set(rows.map(keyOf)).size > 1) {
        for (const row of rows) unplaced(row, [state]);
        continue;
      }
      occupy(state, rows[0]!);
      state.duplicates += rows.length - 1;
    }
  }

  // Each round's review: the artifact its first return names, else the one its first completion's reviewer wrote.
  const reviewArtifactOf = (state: RoundState): StoredArtifact<ReviewPacket> | undefined => {
    const namedDigest = text(state.returned[0]?.evidence["reviewArtifactDigest"]);
    const completed = state.completed[0];
    return (
      (namedDigest === null ? undefined : reviewArtifacts.find((entry) => entry.digest === namedDigest)) ??
      (completed?.sessionId
        ? reviewArtifacts.find((entry) => entry.candidateSnapshotDigest === state.digest && entry.content.reviewerSessionId === completed.sessionId)
        : undefined)
    );
  };

  // A reviewed candidate reached CEO review when a production-ready packet rests on this round's passed review.
  for (const packet of readyPackets) {
    const review = record(record(packet.content)?.["blindReview"]);
    const reviewDigest = text(review?.["digest"]);
    const owners = states.filter((state) => {
      const artifact = reviewArtifactOf(state);
      return artifact !== undefined && artifact.digest === reviewDigest && artifact.content.verdict === "PASS" && state.digest === packet.candidateSnapshotDigest;
    });
    if (owners.length === 1) owners[0]!.readyPackets.add(packet.digest);
  }

  // Interventions are run facts: shown on the latest frozen candidate at once.
  for (const row of audit) {
    if (!REVIEW_ROUND_INTERVENTION_KINDS.includes(row.kind)) continue;
    const window = windowOf(row.eventId);
    (window < 0 ? interventionsBeforeFirstRound : states[window]!.interventions).push({ eventId: row.eventId, kind: row.kind });
  }

  // A delivery goes to the round its own trusted attempt is, and only if that round's return is the
  // one it carries. Without a trusted attempt it goes to the one round whose return it alone carries.
  // Either way its key must agree first: this run, that round's candidate, the reason it carries, and
  // an attempt that is not refused, not another round's, and not other than the round's own. Anything
  // else is listed with the rounds it matches, and names no attempt.
  const deliveriesOf = new Map<number, OutboxMessage[]>();
  const carriersOf = (message: OutboxMessage): RoundState[] =>
    states.filter((state) => state.returned[0] !== undefined && deliveredReturn(message, state.returned[0], state.completed[0]?.sessionId ?? null));
  const keyAgrees = (message: OutboxMessage, owner: RoundState): boolean => {
    const key = revisionKeyOf(message.idempotencyKey);
    const payload = record(message.payload);
    if (key === null || owner.tainted || message.runId !== sources.runId || key.runId !== sources.runId) return false;
    if (key.candidateDigest !== owner.digest || payload?.["candidateSnapshotDigest"] !== owner.digest || payload?.["reasonCode"] !== key.reasonCode) return false;
    if (rejectedAttempts.has(key.attemptId)) return false;
    const holder = roundOfAttempt.get(key.attemptId);
    if (holder !== undefined && holder !== owner.index) return false;
    return owner.attemptId === null || owner.attemptId === key.attemptId;
  };
  // F1 — a review-unavailable notice carries no return, so it is placed by its key alone: the round its trusted
  // attempt is, whose candidate and reason the key and payload name, and for which that attempt stamped an
  // unavailable record with that reason after the round's freeze. The record is matched by its stamp, not by the
  // round's outcome slot, which a method-only round leaves empty (its completion and unavailable record conflict).
  // It goes there as a notice; one that fits no such round is listed below as before.
  const noticesOf = new Map<number, OutboxMessage[]>();
  const noticeRound = (message: OutboxMessage): RoundState | undefined => {
    const payload = record(message.payload);
    const key = revisionKeyOf(message.idempotencyKey);
    if (payload?.["stage"] !== "review-unavailable" || key === null || message.runId !== sources.runId || key.runId !== sources.runId) return undefined;
    if (rejectedAttempts.has(key.attemptId)) return undefined;
    const known = roundOfAttempt.get(key.attemptId);
    const owner = known === undefined ? undefined : states[known]!;
    if (owner === undefined || owner.tainted) return undefined;
    if (key.candidateDigest !== owner.digest || payload["candidateSnapshotDigest"] !== owner.digest || payload["reasonCode"] !== key.reasonCode) return undefined;
    const stamped = audit.some((row) => row.kind === "BLIND_REVIEW_UNAVAILABLE" && row.eventId > owner.freeze.eventId
      && row.reasonCode === key.reasonCode && row.evidence["attemptId"] === key.attemptId && row.evidence["candidateSnapshotDigest"] === owner.digest
      && row.evidence["attemptHeld"] !== false);
    return stamped ? owner : undefined;
  };
  for (const message of revisionMessages) {
    const noticed = noticeRound(message);
    if (noticed !== undefined) {
      noticesOf.set(noticed.index, [...(noticesOf.get(noticed.index) ?? []), message]);
      continue;
    }
    const carriers = carriersOf(message);
    const attemptId = attemptOfKey(message.idempotencyKey);
    const known = attemptId === null ? undefined : roundOfAttempt.get(attemptId);
    let owner: RoundState | undefined;
    if (known !== undefined) owner = carriers.includes(states[known]!) ? states[known]! : undefined;
    else if (carriers.length === 1 && revisionMessages.filter((other) => carriersOf(other).includes(carriers[0]!)).length === 1) owner = carriers[0]!;
    if (owner !== undefined && !keyAgrees(message, owner)) owner = undefined;
    if (owner !== undefined) {
      deliveriesOf.set(owner.index, [...(deliveriesOf.get(owner.index) ?? []), message]);
      if (known === undefined && attemptId !== null) establish(owner, attemptId);
      continue;
    }
    unattributedDeliveries.push({
      messageId: message.messageId,
      ...(outboxDeliveryReadback(message).automaticResendHeld ? outboxDeliveryReadback(message) : {}),
      candidateRounds: [...new Set([...carriers, ...(known === undefined ? [] : [states[known]!])])]
        .sort((a, b) => a.index - b.index)
        .map((state) => state.index + 1),
    });
  }

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
      ...outboxDeliveryReadback(message),
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

  const rounds: ReviewRound[] = states.map((state) => {
    const digest = state.digest;
    const firstReturn = state.returned[0];
    const firstCompleted = state.completed[0];
    const artifact = reviewArtifactOf(state);
    const chunkSessions = firstCompleted?.evidence["chunkReviewerSessions"];
    const chunked = artifact?.content.chunked ?? firstCompleted?.evidence["chunked"] === true;
    const verdict = (artifact?.content.verdict ?? text(firstCompleted?.evidence["verdict"])) as ReviewVerdict | null;
    const review: ReviewRoundReview | null =
      verdict === null
        ? null
        : {
            artifactDigest: artifact?.digest ?? null,
            reviewerSessionId: artifact?.content.reviewerSessionId ?? firstCompleted?.sessionId ?? null,
            verdict,
            reviewKind: artifact ? reviewKindOf(artifact.content) : "CANDIDATE",
            chunked,
            reviewerInvocations: !chunked ? 1 : Array.isArray(chunkSessions) ? chunkSessions.length + 1 : null,
            omittedItems: artifact ? artifact.content.omittedItems.length : 0,
            findings: artifact ? findingsOf(artifact.content) : [],
          };

    let outcome: ReviewRoundOutcome = "NO_OUTCOME_RECORDED";
    let reasonCode: string | null = null;
    if (firstReturn) {
      outcome = firstReturn.evidence["stage"] === "verification" ? "VERIFICATION_RETURNED" : "REVISION_RETURNED";
      reasonCode = firstReturn.reasonCode;
    } else if (state.unavailable.length > 0) {
      outcome = "REVIEW_UNAVAILABLE";
      reasonCode = state.unavailable[0]!.reasonCode;
    } else if (review?.verdict === "PASS") {
      outcome = "REVIEW_PASSED";
      reasonCode = firstCompleted?.reasonCode ?? null;
    }

    const reached = review === null ? state.ready.length > 0 : state.readyPackets.size > 0 && review.verdict === "PASS";
    return {
      round: state.index + 1,
      frozenEventId: state.freeze.eventId,
      candidateSnapshotDigest: digest,
      contentDigest: digest === null ? null : (contentByCandidate.get(digest) ?? null),
      entry: "FIRST_SUBMISSION",
      interventions: state.interventions,
      outcome,
      reasonCode,
      attemptId: state.attemptId,
      attemptReclaimed: state.reclaimed,
      review,
      deliveries: (deliveriesOf.get(state.index) ?? []).map(toDelivery),
      notices: (noticesOf.get(state.index) ?? []).map((message) => {
        const notice = record(message.payload)?.["notice"];
        return { ...toDelivery(message), notice: notice === "METHOD_FINDINGS_ONLY" || notice === "REVIEW_UNAVAILABLE" ? notice : null };
      }),
      readyForCeo: reached && outcome !== "REVIEW_UNAVAILABLE" && outcome !== "REVISION_RETURNED" && outcome !== "VERIFICATION_RETURNED",
      nextNewCandidate: null,
      duplicateEventsIgnored: state.duplicates,
    };
  });

  for (const [index, round] of rounds.entries()) {
    const previous = rounds[index - 1];
    if (previous !== undefined) {
      round.entry =
        round.candidateSnapshotDigest === null || previous.candidateSnapshotDigest === null
          ? "CANDIDATE_UNRECORDED"
          : round.candidateSnapshotDigest !== previous.candidateSnapshotDigest
            ? round.contentDigest === null || previous.contentDigest === null
              ? "NEW_CANDIDATE_CONTENT_UNRECORDED"
              : round.contentDigest !== previous.contentDigest
                ? "SOURCE_CHANGE"
                : "CANDIDATE_IDENTITY_CHANGE"
            : previous.outcome === "REVIEW_UNAVAILABLE" || previous.outcome === "NO_OUTCOME_RECORDED"
              ? "INFRASTRUCTURE_RETRY"
              : "SAME_CANDIDATE_RESUBMISSION";
    }
    const later = rounds
      .slice(index + 1)
      .find((candidate) => candidate.candidateSnapshotDigest !== null && candidate.candidateSnapshotDigest !== round.candidateSnapshotDigest);
    round.nextNewCandidate = later ? { round: later.round, candidateSnapshotDigest: later.candidateSnapshotDigest! } : null;
  }

  // The first findings are the earliest round's, from the review that round first holds.
  const first = rounds.find((round) => (round.review?.findings.length ?? 0) > 0);
  const count = (predicate: (round: ReviewRound) => boolean): number => rounds.filter(predicate).length;
  unattributed.sort((a, b) => a.eventId - b.eventId);
  return {
    runId: sources.runId,
    runState: sources.runState,
    currentCandidateDigest: sources.currentCandidateDigest,
    ownerBinding: sources.ownerBinding,
    latestAttempt: sources.latestAttempt,
    rounds,
    interventionsBeforeFirstRound,
    unattributedEvents: unattributed,
    unattributedDeliveries,
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
      candidateIdentityChanges: count((round) => round.entry === "CANDIDATE_IDENTITY_CHANGE"),
      sameCandidateResubmissions: count((round) => round.entry === "SAME_CANDIDATE_RESUBMISSION"),
      infrastructureRetries: count((round) => round.entry === "INFRASTRUCTURE_RETRY"),
      roundsWithIntervention: count((round) => round.interventions.length > 0),
      duplicateEventsIgnored: rounds.reduce((sum, round) => sum + round.duplicateEventsIgnored, 0),
      unattributedEvents: unattributed.length,
    },
  };
};
