import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { Db } from "../db/database.ts";
import { RunKind, RunState, type RunRow } from "../domain/types.ts";

/**
 * #1189 B15 (CEO ruling 3) — whether a CONTRACT_CHANGE confirmed without an activation grant may be
 * cancelled. It may only when non-application is confirmed; "no grant" alone is not that.
 *
 * - GRANTED: the run holds an activation grant. It finalizes, or blocks post-merge; the database refuses
 *   this cancel too (`runs_cancel_after_approval_requires_no_grant`).
 * - APPLIED: something was merged (a merge_execute receipt APPLIED) or activated (a project manifest
 *   activation recorded for the run). The effects are not erased by cancelling: the run stays on the
 *   follow-up recovery path, where the finalizer blocks it post-merge with its compensation plan.
 * - UNKNOWN: a merge request may have been sent and its outcome is not known (a PENDING merge receipt).
 * - DELAY: a finalization attempt holds the run's lease (RUNNING, expired or not). The grant itself is
 *   issued in the transaction that approves (production-gate's CONFIRM), so issuance has no delay to
 *   wait out; a finalization attempt is the only thing still able to act. An expired lease is released
 *   by the daemon's reclaim sweep, after which the cancel is asked again.
 * - ERROR: the approval's own record names a grant (CEO_DECISION evidence) and no grant row exists.
 *   Grants are never deleted, so the records contradict each other and nothing is concluded from them.
 * - NON_APPLICATION_CONFIRMED: none of the above. Pre-merge receipts (a published branch, a prepared PR,
 *   a gate) are listed in the evidence and kept; no remote branch or repository is deleted.
 *
 * Asked inside the cancel's transaction, so what it reads is what the transition commits against.
 */
export type PostApprovalCancelClass = "GRANTED" | "APPLIED" | "UNKNOWN" | "DELAY" | "ERROR" | "NON_APPLICATION_CONFIRMED";

const POST_APPROVAL_STATES: readonly RunState[] = [RunState.CEO_APPROVED, RunState.MERGING, RunState.POST_MERGE_VERIFYING];

export interface PostApprovalCancelEvidence {
  classification: PostApprovalCancelClass;
  state: RunState;
  grantId: string | null;
  finalizationAttempt: { attemptId: string; state: string; deadlineAt: string } | null;
  mergeReceipts: Array<{ repositoryIdentity: string; status: string; verified: boolean }>;
  manifestActivations: number;
  approvalNamesGrant: boolean;
  preMergeEffects: Array<{ operation: string; repositoryIdentity: string; status: string }>;
}

const evidenceOf = (db: Pick<Db, "get" | "all">, run: RunRow): Omit<PostApprovalCancelEvidence, "classification"> => {
  const grant = db.get<{ grant_id: string }>(
    `SELECT grant_id FROM manifest_activation_grants WHERE run_id = ?
     UNION ALL SELECT grant_id FROM manifest_first_activation_grants WHERE run_id = ? LIMIT 1`,
    [run.runId, run.runId],
  );
  const attempt = db.get<{ attempt_id: string; state: string; deadline_at: string }>(
    `SELECT attempt_id, state, deadline_at FROM finalization_attempts WHERE run_id = ?`,
    [run.runId],
  );
  const receipts = db.all<{ operation: string; repository_identity: string; status: string; verified: number }>(
    `SELECT operation, repository_identity, status, verified FROM github_receipts WHERE run_id = ? ORDER BY created_at, receipt_id`,
    [run.runId],
  );
  const activations = db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM audit_events WHERE run_id = ? AND kind = 'PROJECT_MANIFEST_ACTIVATED'`,
    [run.runId],
  )?.n ?? 0;
  // The approval's own record: the CEO_DECISION CONFIRM a grant-issuing build wrote names the grant.
  const namesGrant = db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM audit_events
      WHERE run_id = ? AND kind = 'CEO_DECISION'
        AND json_extract(evidence_json, '$.decision') = 'CONFIRM'
        AND (json_extract(evidence_json, '$.manifestActivationGrantDigest') IS NOT NULL
             OR json_extract(evidence_json, '$.manifestActivation') = 'FIRST')`,
    [run.runId],
  )?.n ?? 0;
  return {
    state: run.state,
    grantId: grant?.grant_id ?? null,
    finalizationAttempt: attempt ? { attemptId: attempt.attempt_id, state: attempt.state, deadlineAt: attempt.deadline_at } : null,
    mergeReceipts: receipts
      .filter((receipt) => receipt.operation === "merge_execute")
      .map((receipt) => ({ repositoryIdentity: receipt.repository_identity, status: receipt.status, verified: receipt.verified === 1 })),
    manifestActivations: activations,
    approvalNamesGrant: namesGrant > 0,
    preMergeEffects: receipts
      .filter((receipt) => receipt.operation !== "merge_execute")
      .map((receipt) => ({ operation: receipt.operation, repositoryIdentity: receipt.repository_identity, status: receipt.status })),
  };
};

/** The classification of a post-approval cancel of `run`, or null when `run` is not one. */
export const classifyPostApprovalCancel = (db: Pick<Db, "get" | "all">, run: RunRow): PostApprovalCancelEvidence | null => {
  if (run.kind !== RunKind.CONTRACT_CHANGE || !POST_APPROVAL_STATES.includes(run.state)) return null;
  const facts = evidenceOf(db, run);
  const classification: PostApprovalCancelClass =
    facts.grantId !== null ? "GRANTED"
      : facts.mergeReceipts.some((receipt) => receipt.status === "APPLIED") || facts.manifestActivations > 0 ? "APPLIED"
        : facts.mergeReceipts.length > 0 ? "UNKNOWN"
          : facts.finalizationAttempt?.state === "RUNNING" ? "DELAY"
            : facts.approvalNamesGrant ? "ERROR"
              : "NON_APPLICATION_CONFIRMED";
  return { classification, ...facts };
};

/**
 * #1189 B14 (CEO ruling 2) — the cancel of a PROJECT_BOOTSTRAP run at CEO review, against its CONFIRM.
 * A bootstrap CONFIRM applies before it decides: the runner reserves, writes to GitHub and activates,
 * and only then does the decision commit. So the cancel is refused while that application is in flight
 * in this process (`inFlight`, the runner's own marker, set before it first reads the run), and once
 * what it wrote has landed (WRITTEN: the CONFIRM activates it again, and cancelling would hide it). The
 * runner asks the run's state again before every external write, so after this cancel commits nothing
 * further is written; and the decision asks the state in its own transaction, so it is refused.
 *
 * A RESERVED application (no attempt in flight) and a STRANDED one are cancelled; what becomes of their
 * reservation is the release path's to prove after the commit. With no application the run is cancelled
 * like every other run. Asked inside the cancel's transaction.
 */
export const admitReviewedBootstrapCancel = (
  db: Pick<Db, "get">,
  run: RunRow,
  inFlight: boolean,
): Decision<Record<string, unknown>> => {
  const application = db.get<{ phase: string; attempts: number }>(
    `SELECT phase, attempts FROM bootstrap_applications WHERE run_id = ?`,
    [run.runId],
  ) ?? null;
  const evidence = { bootstrapApplication: application === null ? null : { phase: application.phase, attempts: application.attempts } };
  if (inFlight) {
    return deny(ReasonCode.BOOTSTRAP_APPLICATION_IN_PROGRESS,
      "a CONFIRM's application of this bootstrap run is in flight; it is not cancelled now — ask again once the application has ended",
      { runId: run.runId, classification: "DELAY", ...evidence });
  }
  if (application?.phase === "WRITTEN") {
    return deny(ReasonCode.BOOTSTRAP_APPLICATION_IN_PROGRESS,
      "this bootstrap run's application is WRITTEN: its GitHub writes landed and the CONFIRM activates them; it is not cancelled",
      { runId: run.runId, classification: "APPLIED", ...evidence });
  }
  return allow(ReasonCode.OK, evidence);
};

/**
 * The cancel's admission for a run past CEO approval; any other run is admitted here unchanged (its
 * edge is still `canTransition`'s to judge). On admission, the evidence the transition records.
 */
export const admitPostApprovalCancel = (db: Pick<Db, "get" | "all">, run: RunRow): Decision<Record<string, unknown>> => {
  const classified = classifyPostApprovalCancel(db, run);
  if (classified === null) return allow(ReasonCode.OK, {});
  const evidence = { runId: run.runId, ...classified };
  switch (classified.classification) {
    case "NON_APPLICATION_CONFIRMED":
      return allow(ReasonCode.OK, { cancelAfterApproval: classified });
    case "GRANTED":
      return deny(ReasonCode.RUN_TRANSITION_ILLEGAL,
        "this CONTRACT_CHANGE holds its activation grant: it finalizes, or blocks post-merge, and is not cancelled", evidence);
    case "APPLIED":
      return deny(ReasonCode.FINALIZATION_COMPENSATION_REQUIRED,
        "something this run approved was merged or activated: cancelling would hide it, so the run stays on the follow-up recovery path", evidence);
    default:
      return deny(ReasonCode.CANCEL_NON_APPLICATION_UNCONFIRMED,
        classified.classification === "DELAY"
          ? "a finalization attempt holds this run; once it ends or its lease is reclaimed, ask again"
          : classified.classification === "UNKNOWN"
            ? "a merge request of this run may have been sent and its outcome is unknown; it is reconciled on the follow-up path"
            : "the approval names an activation grant that does not exist; the records disagree and nothing is concluded from them",
        evidence);
  }
};
