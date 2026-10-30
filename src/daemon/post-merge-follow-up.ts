import { ReasonCode } from "../core/reason-codes.ts";
import type { Db } from "../db/database.ts";
import { Role, RunKind, RunState, roleKeyFor } from "../domain/types.ts";

/**
 * #1189 B13 (CEO ruling 4) — the follow-up retry of a run blocked after a verified merge. Only two causes
 * are retried, each on the same merged SHAs, pinned manifest, grant and target, with no re-merge:
 *
 * - POST_MERGE_CHECKS_INCOMPLETE: the bounded post-merge wait ended with every failing declared check
 *   still missing or incomplete. No receipt answered it (github-kernel), so the lookup is asked again.
 * - ACTIVATION_READ_TRANSIENT: a CONTRACT_CHANGE's activation was refused because a workflow could not
 *   be read (PROBE_FAILED, or an exact-commit object GitHub did not return). Activation is asked again.
 *
 * A real check FAIL, any other activation refusal, a changed candidate, a repository of the run not yet
 * merged, or a grant that is consumed or absent is not retried. Retries are counted from the durable
 * FINALIZATION_POST_MERGE_RESUMED rows that name a follow-up cause; at the budget the run stays
 * BLOCKED_POST_MERGE and the blocker is recorded once with its owner, the CEO.
 */
export const FOLLOW_UP_RETRY_BUDGET = 3;

export type FollowUpCause = "POST_MERGE_CHECKS_INCOMPLETE" | "ACTIVATION_READ_TRANSIENT";

export type FollowUpRefusal =
  | "NOT_RETRYABLE"
  | "CANDIDATE_CHANGED"
  | "MERGES_INCOMPLETE"
  | "GRANT_UNAVAILABLE"
  | "GRANT_CONSUMED"
  | "BUDGET_EXHAUSTED";

/** The owner the blocker is recorded against when the budget is spent. */
export const FOLLOW_UP_OWNER = roleKeyFor(Role.CEO);

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/**
 * Which follow-up cause a finalization failure is, or null for one that is not retried. Read from the
 * failure's own reason code and evidence: at the moment it happens, and for a block an earlier build
 * recorded, from the RUN_TRANSITION that recorded it.
 */
export const followUpCauseOf = (reasonCode: string | null | undefined, evidence: unknown): FollowUpCause | null => {
  if (reasonCode === ReasonCode.POST_MERGE_CHECKS_INCOMPLETE) return "POST_MERGE_CHECKS_INCOMPLETE";
  if (reasonCode !== ReasonCode.MANIFEST_ACTIVATION_REFUSED) return null;
  const refusal = record(record(evidence)?.["refusal"]);
  if (refusal?.["reasonCode"] !== ReasonCode.MANIFEST_ACTIVATION_WORKFLOW_UNVERIFIED) return null;
  const cause = record(record(refusal["evidence"])?.["cause"]);
  if (cause?.["reasonCode"] === ReasonCode.PROBE_FAILED) return "ACTIVATION_READ_TRANSIENT";
  // A first activation's exact-commit reader names an object GitHub did not return this way.
  if (cause?.["reasonCode"] === ReasonCode.MANIFEST_ACTIVATION_WORKFLOW_UNVERIFIED &&
      record(cause["evidence"])?.["refusal"] === "EXACT_READ_OBJECT_UNREADABLE") return "ACTIVATION_READ_TRANSIENT";
  return null;
};

const evidenceOf = (json: string | null | undefined): Record<string, unknown> | null => {
  if (!json) return null;
  try {
    return record(JSON.parse(json));
  } catch {
    return null;
  }
};

/** The follow-up cause recorded for a blocked attempt: its own record, or, before there was one, its block's transition. */
const recordedCause = (db: Pick<Db, "get">, runId: string, attemptId: string, failureReason: string | null): FollowUpCause | null => {
  const marked = db.get<{ evidence_json: string }>(
    `SELECT evidence_json FROM audit_events
      WHERE run_id = ? AND kind = 'FINALIZATION_FOLLOW_UP_RETRYABLE' AND json_extract(evidence_json, '$.attemptId') = ?
      ORDER BY event_id DESC LIMIT 1`,
    [runId, attemptId],
  );
  const cause = evidenceOf(marked?.evidence_json)?.["cause"];
  if (cause === "POST_MERGE_CHECKS_INCOMPLETE" || cause === "ACTIVATION_READ_TRANSIENT") return cause;
  const blocked = db.get<{ evidence_json: string }>(
    `SELECT evidence_json FROM audit_events
      WHERE run_id = ? AND kind = 'RUN_TRANSITION'
        AND json_extract(evidence_json, '$.to') = 'BLOCKED_POST_MERGE'
        AND json_extract(evidence_json, '$.attemptId') = ?
      ORDER BY event_id DESC LIMIT 1`,
    [runId, attemptId],
  );
  const transition = evidenceOf(blocked?.evidence_json);
  return followUpCauseOf((transition?.["failureReasonCode"] as string | undefined) ?? failureReason, transition?.["failure"]);
};

export interface FollowUpAssessment {
  cause: FollowUpCause | null;
  retriesUsed: number;
  budget: number;
  /** Null when the run may be resumed now. */
  refusal: FollowUpRefusal | null;
}

/** The blocked finalization attempt, as the lease table holds it. */
export interface BlockedAttempt {
  attempt_id: string;
  state: string;
  candidate_digest: string;
  failure_reason: string | null;
}

/** Follow-up retries of `runId` taken so far: resumes that named a follow-up cause. */
export const followUpRetriesUsed = (db: Pick<Db, "get">, runId: string): number =>
  db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM audit_events
      WHERE run_id = ? AND kind = 'FINALIZATION_POST_MERGE_RESUMED' AND json_extract(evidence_json, '$.followUp') IS NOT NULL`,
    [runId],
  )?.n ?? 0;

/**
 * Whether a BLOCKED_POST_MERGE run may take one follow-up retry now. Asked inside the transaction that
 * resumes it. `candidateDigest` is the run's current candidate.
 */
export const assessFollowUpRetry = (
  db: Pick<Db, "get" | "all">,
  run: { runId: string; kind: RunKind; state: RunState },
  prior: BlockedAttempt,
  candidateDigest: string | null,
): FollowUpAssessment => {
  const retriesUsed = followUpRetriesUsed(db, run.runId);
  const cause = run.state === RunState.BLOCKED_POST_MERGE && prior.state === "BLOCKED"
    ? recordedCause(db, run.runId, prior.attempt_id, prior.failure_reason)
    : null;
  const answer = (refusal: FollowUpRefusal | null): FollowUpAssessment => ({ cause, retriesUsed, budget: FOLLOW_UP_RETRY_BUDGET, refusal });
  if (cause === null) return answer("NOT_RETRYABLE");
  if (candidateDigest === null || prior.candidate_digest !== candidateDigest) return answer("CANDIDATE_CHANGED");
  // Every repository of the run merged, exactly once and verified: a retry has nothing left to merge.
  const participants = db.all<{ identity: string }>(
    `SELECT r.identity FROM run_repositories rr JOIN repositories r ON r.repository_id = rr.repository_id WHERE rr.run_id = ?`,
    [run.runId],
  ).map((row) => row.identity);
  const merged = db.all<{ repository_identity: string; status: string; verified: number }>(
    `SELECT repository_identity, status, verified FROM github_receipts WHERE run_id = ? AND operation = 'merge_execute'`,
    [run.runId],
  );
  const mergedOnce = (identity: string): boolean => {
    const receipts = merged.filter((receipt) => receipt.repository_identity === identity);
    return receipts.length === 1 && receipts[0]!.status === "APPLIED" && receipts[0]!.verified === 1;
  };
  if (merged.length !== participants.length || !participants.every(mergedOnce)) return answer("MERGES_INCOMPLETE");
  if (run.kind === RunKind.CONTRACT_CHANGE) {
    const grant = db.get<{ consumed_at: string | null }>(
      `SELECT consumed_at FROM manifest_activation_grants WHERE run_id = ?
       UNION ALL SELECT consumed_at FROM manifest_first_activation_grants WHERE run_id = ? LIMIT 1`,
      [run.runId, run.runId],
    );
    if (!grant) return answer("GRANT_UNAVAILABLE");
    if (grant.consumed_at !== null) return answer("GRANT_CONSUMED");
  } else if (cause === "ACTIVATION_READ_TRANSIENT") {
    return answer("GRANT_UNAVAILABLE");
  }
  if (retriesUsed >= FOLLOW_UP_RETRY_BUDGET) return answer("BUDGET_EXHAUSTED");
  return answer(null);
};

/**
 * #1189 A10 (CEO ruling 1) — the recovery responsibility a terminal BLOCKED_POST_MERGE run still holds,
 * from evidence; empty when it holds none and its effects are settled. Open means any of:
 *
 * - FINALIZATION_IN_FLIGHT: a finalization attempt holds its lease (RUNNING);
 * - EXTERNAL_EFFECT_UNKNOWN: a GitHub receipt of the run is PENDING, or a merge is APPLIED but unverified;
 * - FOLLOW_UP_RETRY_PENDING: the finalizer would still take a follow-up retry (B13), which can merge
 *   nothing but can still verify and activate, consuming the run's grant;
 * - EXECUTION_RUNNING / CLAIM_HELD: a task execution still RUNNING, or a resource claim still HELD;
 * - RESERVATION_HELD: a bootstrap application of the run still RESERVED or WRITTEN;
 * - ESCALATION_OPEN: a blocking CTO escalation of the run that no CEO decision has answered.
 *
 * A block that is not retryable (a real check FAIL, a changed candidate, a spent budget) is settled once
 * none of the above holds: its merged commits, receipts, compensation plan and exhaustion record are the
 * facts retirement preserves, and its owner is recorded.
 */
export const openPostMergeResponsibility = (db: Pick<Db, "get" | "all">, runId: string): string[] => {
  const run = db.get<{ kind: RunKind; state: RunState; current_candidate_digest: string | null }>(
    `SELECT kind, state, current_candidate_digest FROM runs WHERE run_id = ?`,
    [runId],
  );
  if (!run) return [];
  const open: string[] = [];
  const count = (sql: string, params: unknown[] = [runId]): number => db.get<{ n: number }>(sql, params)?.n ?? 0;
  const attempt = db.get<BlockedAttempt>(
    `SELECT attempt_id, state, candidate_digest, failure_reason FROM finalization_attempts WHERE run_id = ?`,
    [runId],
  );
  if (attempt?.state === "RUNNING") open.push("FINALIZATION_IN_FLIGHT");
  if (count(`SELECT COUNT(*) AS n FROM github_receipts WHERE run_id = ?
       AND (status = 'PENDING' OR (operation = 'merge_execute' AND verified = 0))`) > 0) open.push("EXTERNAL_EFFECT_UNKNOWN");
  if (attempt && assessFollowUpRetry(db, { runId, kind: run.kind, state: run.state }, attempt, run.current_candidate_digest).refusal === null) {
    open.push("FOLLOW_UP_RETRY_PENDING");
  }
  if (count(`SELECT COUNT(*) AS n FROM task_executions WHERE run_id = ? AND status = 'RUNNING'`) > 0) open.push("EXECUTION_RUNNING");
  if (count(`SELECT COUNT(*) AS n FROM resource_claims WHERE run_id = ? AND status = 'HELD'`) > 0) open.push("CLAIM_HELD");
  if (count(`SELECT COUNT(*) AS n FROM bootstrap_applications WHERE run_id = ? AND phase IN ('RESERVED','WRITTEN')`) > 0) open.push("RESERVATION_HELD");
  // The same question production-gate's openEscalationOf asks: the latest blocking escalation, unanswered.
  if (count(`SELECT COUNT(*) AS n FROM audit_events e
      WHERE e.event_id = (SELECT MAX(event_id) FROM audit_events WHERE run_id = ? AND kind = 'CTO_ESCALATION'
                            AND json_extract(evidence_json, '$.blocksCriticalPath') = 1)
        AND NOT EXISTS (SELECT 1 FROM audit_events d WHERE d.run_id = ? AND d.kind = 'CEO_DECISION'
                          AND d.event_id > e.event_id AND json_extract(d.evidence_json, '$.escalation') = 1)`, [runId, runId]) > 0) {
    open.push("ESCALATION_OPEN");
  }
  return open;
};
