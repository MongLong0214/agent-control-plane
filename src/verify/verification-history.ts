import type { Db } from "../db/database.ts";

/**
 * One finished execution of one verification input, as `verification_results` holds it. An input is
 * one (candidate snapshot, command, repository, source); `attempt` numbers its executions from 1 in the
 * order they finished (#1258).
 */
export interface VerificationExecution {
  result_id: string;
  command_id: string;
  repository_identity: string;
  source: string;
  attempt: number;
  exact_head: string;
  started_at: string;
  ended_at: string;
  exit_code: number | null;
  output_digest: string;
  output_truncated: number;
  status: string;
  reason_code: string | null;
}

/**
 * Every execution recorded for a run's candidate, each input's in attempt order. A re-verification
 * appends; no row is replaced or deleted here, so an earlier FAIL stays readable beside a later PASS.
 */
export const verificationHistory = (
  db: Db,
  runId: string,
  candidateSnapshotDigest: string,
): VerificationExecution[] =>
  db.all<VerificationExecution>(
    `SELECT result_id, command_id, repository_identity, source, attempt, exact_head, started_at, ended_at,
            exit_code, output_digest, output_truncated, status, reason_code
       FROM verification_results
      WHERE run_id = ? AND candidate_snapshot_digest = ?
      ORDER BY command_id, repository_identity, source, attempt`,
    [runId, candidateSnapshotDigest],
  );

/**
 * #1258 — the one rule for which execution is an input's current verdict.
 *
 * A row is written only once its execution has finished, and the writer gives it the input's next
 * attempt, so an input's highest attempt is its latest completed execution. That row alone is current.
 * Every earlier row stays in the history and decides nothing: a FAIL that a later PASS followed does not
 * fail the candidate, and a PASS that a later FAIL followed does not pass it. An execution still running
 * has no row yet. The pipeline runs a run's verification and the two gates that read these rows (review
 * admission, the production packet) under one attempt lease, so they do not overlap unless that lease
 * was reclaimed as stale while its holder still ran.
 *
 * The current row passes only when its status is PASS (`currentVerdictPasses`). FAIL, TIMEOUT, ERROR,
 * SKIPPED or any other value fails closed, and no earlier PASS is consulted behind it.
 */
export const currentVerificationResults = (
  db: Db,
  runId: string,
  candidateSnapshotDigest: string,
): VerificationExecution[] => {
  const current = new Map<string, VerificationExecution>();
  for (const execution of verificationHistory(db, runId, candidateSnapshotDigest)) {
    // Attempt order, so the last execution of an input to reach here is its highest attempt.
    current.set(JSON.stringify([execution.command_id, execution.repository_identity, execution.source]), execution);
  }
  return [...current.values()];
};

/** Whether an input's current execution passes: PASS, and nothing else. */
export const currentVerdictPasses = (execution: Pick<VerificationExecution, "status">): boolean =>
  execution.status === "PASS";
