import { digestOf } from "../core/digest.ts";
import { EVIDENCE_PRODUCERS, type ArtifactStore, type StoredArtifact } from "../db/artifacts.ts";
import type { AuditLog, AuditRow } from "../db/audit.ts";
import type { Db } from "../db/database.ts";
import { ArtifactKind, type ReviewFindingCategory, type ReviewVerdict, RunState } from "../domain/types.ts";
import { MessageKind } from "../outbox/envelope.ts";
import type { Outbox, OutboxMessage } from "../outbox/outbox.ts";
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
 * A record is placed on the attempt that wrote it, not on the freeze window it happens to fall in:
 * - A review record names its reviewer session (the completion row's session, the stored review's
 *   `reviewerSessionId`, the delivered packet's), and the reviewer's binding row places that session
 *   on the attempt that constituted it. A replayed row therefore lands on its own round, whatever
 *   window it falls in, and is counted there once.
 * - A record with no such identity (an unavailable review, a verification return, the move to CEO
 *   review) belongs to the window's own attempt, since the durable lease serialises submissions;
 *   only an attempt whose lease was reclaimed (`CANDIDATE_PIPELINE_ATTEMPT_RECLAIMED`) can still
 *   write after the next freeze. Where such an attempt is open, a record goes to the one attempt
 *   that can still take it (each attempt has at most one review outcome, one return and one move to
 *   CEO review); when more than one could, it is listed in `unattributedEvents` with the rounds it
 *   could belong to, and placed on none.
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

/** The role key prefix of a run's blind-reviewer bindings (`roleKeyFor(BLIND_REVIEWER, { runId })`). */
const REVIEWER_ROLE_PREFIX = "BLIND_REVIEWER:";
/** A review constitutes exactly one of these per attempt: its single reviewer, or its final one. */
const TERMINAL_PURPOSES = new Set(["blind-review", "blind-review-final"]);

interface RoundState {
  index: number;
  freeze: AuditRow;
  digest: string | null;
  reclaimed: boolean;
  attemptIds: Set<string>;
  bindings: Array<{ sessionId: string; purpose: string | null }>;
  completed: AuditRow[];
  unavailable: AuditRow[];
  returned: AuditRow[];
  ready: AuditRow[];
  keys: Set<string>;
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
  const unattributed: UnattributedReviewEvent[] = [];
  const interventionsBeforeFirstRound: Array<{ eventId: number; kind: string }> = [];

  const states: RoundState[] = freezes.map((freeze, index) => ({
    index,
    freeze,
    digest: text(freeze.evidence["candidateSnapshotDigest"]),
    reclaimed: false,
    attemptIds: new Set<string>(),
    bindings: [],
    completed: [],
    unavailable: [],
    returned: [],
    ready: [],
    keys: new Set<string>(),
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
  const place = (state: RoundState, slot: Slot, row: AuditRow): void => {
    const key = keyOf(row);
    if (state.keys.has(key)) {
      state.duplicates += 1;
      return;
    }
    state.keys.add(key);
    state[slot].push(row);
  };

  // An attempt reclaimed while it ran, by the lease's own record: it started no later than its freeze.
  for (const row of audit.filter((entry) => entry.kind === "CANDIDATE_PIPELINE_ATTEMPT_RECLAIMED")) {
    const window = windowOf(row.eventId);
    const startedAt = text(row.evidence["startedAt"]);
    const attemptId = text(row.evidence["attemptId"]);
    const state = states[window];
    if (state === undefined || startedAt === null || startedAt > state.freeze.at) continue;
    state.reclaimed = true;
    const previous = states[window - 1];
    if (attemptId !== null && (previous === undefined || startedAt > previous.freeze.at)) state.attemptIds.add(attemptId);
  }

  // Each reviewer session, on the attempt that constituted it. A review constitutes one terminal
  // reviewer ("blind-review", or "blind-review-final" after its chunks), so an attempt that already
  // has a reviewer cannot be the one constituting a later single review's reviewer.
  const sessionRounds = new Map<string, number[]>();
  for (const row of audit) {
    if ((row.kind !== "BINDING_CREATED" && row.kind !== "BINDING_SWITCHED") || !row.roleKey?.startsWith(REVIEWER_ROLE_PREFIX) || !row.sessionId) {
      continue;
    }
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
  const slotOf = (row: AuditRow): Slot =>
    row.kind === "BLIND_REVIEW_COMPLETED" ? "completed" : row.kind === "BLIND_REVIEW_UNAVAILABLE" ? "unavailable" : "returned";
  /** Whether a round can still take a record of this slot: one review outcome and one return per attempt. */
  const open = (state: RoundState, slot: Slot): boolean =>
    slot === "returned" ? state.returned.length === 0 : state.completed.length === 0 && state.unavailable.length === 0;

  // Records that name their reviewer go where that reviewer was constituted.
  const pending: AuditRow[] = [];
  for (const row of audit) {
    if (row.kind !== "BLIND_REVIEW_COMPLETED" && row.kind !== "BLIND_REVIEW_UNAVAILABLE" && row.kind !== "REVISION_RETURNED_TO_CTO") continue;
    const digest = text(row.evidence["candidateSnapshotDigest"]);
    if (digest === null) continue;
    const session = row.kind === "BLIND_REVIEW_UNAVAILABLE" || row.evidence["stage"] === "verification" ? null : reviewSessionOf(row);
    const rounds = session === null ? undefined : sessionRounds.get(session);
    if (rounds === undefined) {
      pending.push(row);
      continue;
    }
    const matching = rounds.filter((index) => states[index]!.digest === digest);
    if (matching.length === 1) place(states[matching[0]!]!, slotOf(row), row);
    else unattributed.push({ eventId: row.eventId, kind: row.kind, candidateRounds: matching.map((index) => index + 1) });
  }

  // The rest go to the one attempt that could still have written them, or to none.
  let progressed = true;
  while (progressed && pending.length > 0) {
    progressed = false;
    for (const row of [...pending]) {
      const slot = slotOf(row);
      const candidates = roundsThatCouldWrite(row.eventId, text(row.evidence["candidateSnapshotDigest"]));
      const free = candidates.filter((state) => open(state, slot));
      if (free.length > 1) continue;
      const repeats = candidates.filter((state) => state.keys.has(keyOf(row)));
      const target = free.length === 1 ? free[0] : repeats.length === 1 ? repeats[0] : undefined;
      if (target !== undefined) place(target, slot, row);
      else unattributed.push({ eventId: row.eventId, kind: row.kind, candidateRounds: repeats.map((state) => state.index + 1) });
      pending.splice(pending.indexOf(row), 1);
      progressed = true;
    }
  }
  for (const row of pending) {
    const candidates = roundsThatCouldWrite(row.eventId, text(row.evidence["candidateSnapshotDigest"]));
    unattributed.push({
      eventId: row.eventId,
      kind: row.kind,
      candidateRounds: candidates.filter((state) => open(state, slotOf(row))).map((state) => state.index + 1),
    });
  }

  // The move to CEO review belongs to the attempt whose review passed, never to an unavailable one.
  const verdictOf = (state: RoundState): string | null => text(state.completed.at(-1)?.evidence["verdict"]);
  for (const row of audit) {
    if (row.kind !== "RUN_TRANSITION" || row.evidence["to"] !== RunState.READY_FOR_CEO_REVIEW) continue;
    const candidates = roundsThatCouldWrite(row.eventId, text(row.evidence["candidateSnapshotDigest"])).filter(
      (state) => state.unavailable.length === 0 && state.returned.length === 0,
    );
    const passed = candidates.filter((state) => verdictOf(state) === "PASS");
    const unreviewed = candidates.filter((state) => state.completed.length === 0);
    const target = passed.length === 1 ? passed[0] : passed.length === 0 && unreviewed.length === 1 ? unreviewed[0] : undefined;
    if (target !== undefined) place(target, "ready", row);
    else unattributed.push({ eventId: row.eventId, kind: row.kind, candidateRounds: [...passed, ...unreviewed].map((state) => state.index + 1) });
  }

  // Interventions are run facts: shown on the latest frozen candidate at once.
  for (const row of audit) {
    if (!REVIEW_ROUND_INTERVENTION_KINDS.includes(row.kind)) continue;
    const window = windowOf(row.eventId);
    (window < 0 ? interventionsBeforeFirstRound : states[window]!.interventions).push({ eventId: row.eventId, kind: row.kind });
  }

  // Content evidence by candidate, from snapshots whose own content proves the digest they are stored under.
  const contentByCandidate = new Map<string, string>();
  for (const artifact of sources.artifacts) {
    if (artifact.kind !== ArtifactKind.CANDIDATE_SNAPSHOT || artifact.candidateSnapshotDigest === null) continue;
    const content = record(artifact.content);
    if (content === null || !Array.isArray(content["repositories"])) continue;
    const snapshot = content as unknown as CandidateSnapshot;
    if (candidateSnapshotDigest(snapshot) === artifact.candidateSnapshotDigest) {
      contentByCandidate.set(artifact.candidateSnapshotDigest, contentDigestOf(snapshot));
    }
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

  const rounds: ReviewRound[] = states.map((state) => {
    const digest = state.digest;
    const lastReturn = state.returned.at(-1);
    const lastCompleted = state.completed.at(-1);
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
    } else if (state.unavailable.length > 0) {
      outcome = "REVIEW_UNAVAILABLE";
      reasonCode = state.unavailable.at(-1)!.reasonCode;
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
    for (const delivery of deliveries) if (delivery.attemptId !== null) state.attemptIds.add(delivery.attemptId);
    const lease = sources.latestAttempt;
    if (state.index === states.length - 1 && lease !== null && digest !== null && lease.candidateDigest === digest) {
      state.attemptIds.add(lease.attemptId);
    }

    return {
      round: state.index + 1,
      frozenEventId: state.freeze.eventId,
      candidateSnapshotDigest: digest,
      contentDigest: digest === null ? null : (contentByCandidate.get(digest) ?? null),
      entry: "FIRST_SUBMISSION",
      interventions: state.interventions,
      outcome,
      reasonCode,
      attemptId: state.attemptIds.size === 1 ? [...state.attemptIds][0]! : null,
      attemptReclaimed: state.reclaimed,
      review,
      deliveries,
      readyForCeo: state.ready.length > 0 && outcome !== "REVIEW_UNAVAILABLE" && (review === null || review.verdict === "PASS"),
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
