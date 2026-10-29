import type { Db } from "../db/database.ts";

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
 * Every recorded trusted-CI result for one check on one repository, newest first.
 *
 * The one place the project read surface reads trusted-CI rows of `verification_results` by check.
 * A CI result's command id is the check name (`ciEvidenceSource` maps a check to
 * `commandId: check.name`). Today a row is replaced per candidate snapshot, so this returns the last
 * result of each snapshot. #1258 keeps history for this table; when it lands, switch over here.
 * The row keeps neither the check's conclusion nor its workflow digest.
 */
export const ciVerificationRecords = (db: Db, repositoryIdentity: string, checkName: string): CiVerificationRecord[] =>
  db.all<{ result_id: string; run_id: string; exact_head: string; ended_at: string;
    status: CiVerificationRecord["status"]; reason_code: string | null; row_order: number }>(
    `SELECT result_id, run_id, exact_head, ended_at, status, reason_code, rowid AS row_order
       FROM verification_results
      WHERE source = 'ci' AND repository_identity = ? AND command_id = ?
      ORDER BY ended_at DESC, rowid DESC`,
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
