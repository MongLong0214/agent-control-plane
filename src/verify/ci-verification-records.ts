import type { Db } from "../db/database.ts";

/** GitHub check conclusions that mean the check finished and failed. */
export const CI_FAILED_CONCLUSIONS: ReadonlySet<string> =
  new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure"]);

/** One trusted-CI verification result as `VerificationEngine.collectCi` recorded it. */
export interface CiVerificationRecord {
  resultId: string;
  runId: string;
  exactHead: string;
  endedAt: string;
  status: "PASS" | "FAIL" | "TIMEOUT" | "ERROR" | "SKIPPED";
  reasonCode: string | null;
  rowOrder: number;
}

/**
 * Every current trusted-CI result for one check on one repository, newest first.
 *
 * The one place the project read surface reads trusted-CI rows of `verification_results` by check.
 * A CI result's command id is the check name (`ciEvidenceSource` maps a check to
 * `commandId: check.name`). #1258 keeps every execution of an input (candidate snapshot, command,
 * repository, source) as its own row; only the input's highest attempt is its current result
 * (`currentVerificationResults`), and an earlier one decides nothing. So this returns the last result
 * of each snapshot, as it did when a re-verification replaced the row: an older PASS of the same input
 * is not read as the check's last result once a later execution of it is PENDING or FAIL.
 * The row keeps neither the check's conclusion nor its workflow digest. A FAIL row's reason code
 * says which kind of non-success it was: VERIFICATION_CI_CHECK_FAILED for a finished, failing
 * conclusion and VERIFICATION_CI_CHECK_PENDING for an unfinished check. Rows written before those
 * codes existed carry VERIFICATION_COMMAND_FAILED for both.
 */
export const ciVerificationRecords = (db: Db, repositoryIdentity: string, checkName: string): CiVerificationRecord[] =>
  db.all<{ result_id: string; run_id: string; exact_head: string; ended_at: string;
    status: CiVerificationRecord["status"]; reason_code: string | null; row_order: number }>(
    `SELECT v.result_id, v.run_id, v.exact_head, v.ended_at, v.status, v.reason_code, v.rowid AS row_order
       FROM verification_results v
      WHERE v.source = 'ci' AND v.repository_identity = ? AND v.command_id = ?
        AND v.attempt = (SELECT MAX(o.attempt) FROM verification_results o
                          WHERE o.candidate_snapshot_digest = v.candidate_snapshot_digest
                            AND o.command_id = v.command_id
                            AND o.repository_identity = v.repository_identity
                            AND o.source = v.source)
      ORDER BY v.ended_at DESC, v.rowid DESC`,
    [repositoryIdentity, checkName],
  ).map((row) => ({
    resultId: row.result_id,
    runId: row.run_id,
    exactHead: row.exact_head,
    endedAt: row.ended_at,
    status: row.status,
    reasonCode: row.reason_code,
    rowOrder: row.row_order,
  }));
