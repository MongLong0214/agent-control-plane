import { digestOf } from "../core/digest.ts";
import { redact } from "../db/audit.ts";
import type { Db } from "../db/database.ts";
import { TERMINAL_RUN_STATES } from "../domain/run-state.ts";

/**
 * #1096 — the one way an unidentified worker orphan (a launch the guard admitted whose pid was never
 * recorded) stops blocking its task: a successful run of the operator repair
 * `release_unidentified_worker_orphan` for exactly that orphan event.
 *
 * What releases the orphan is the release record that repair writes itself, never an audit row any
 * other path can write. At the moment of use the repair proves the owner live through the configured
 * owner authority — the receipt names an allowlisted owner, its ingress admission still stands, and the
 * repair has just consumed it — and then records the release with an authorization digest
 * (`orphanReleaseAuthorization`) binding the execution, its task and run, the worker session, the
 * process the execution recorded (none, for an unidentified orphan: no pid, no start token, no group),
 * the orphan event, and the owner receipt approved for exactly this release. That record is durable:
 * its reader recomputes the digest from the orphan and the execution row, and never asks the ingress
 * replay cache again (the P1-18 lesson), so a release does not expire when that cache is pruned.
 *
 * The audit API cannot write a release. `AuditLog.record` passes all evidence through `redact`, which
 * stores every value under a key naming authorization as `[redacted]`, so a row written through it
 * never carries the digest; the release repair writes its record with its own insert. One receipt
 * releases one orphan once: the receipt binds this orphan's exact parameters, the owner authority
 * consumes it once, and a repair a precondition refused consumed nothing, so its later successful run
 * releases the orphan.
 *
 * Limit: schema v44 has no insert-authority marker for audit rows, so a raw SQL writer — a second
 * SQLite connection as this account, or `Db.run` on ACP's own — can still insert a release record with a
 * matching digest. Refusing that writer needs a trigger-guarded release record, which is a schema change.
 */

/** The allowlisted repair that releases one unidentified orphan. */
export const ORPHAN_RELEASE_REPAIR_ID = "release_unidentified_worker_orphan";
/** The value of the `confirm` parameter by which the operator attests that nothing of the orphan runs. */
export const ORPHAN_RELEASE_CONFIRMATION = "nothing-running";
/** An earlier turn of a task launched a process that was never recorded: it blocks the task. */
export const ORPHAN_UNIDENTIFIED_EVENT = "TASK_WORKER_ORPHAN_UNIDENTIFIED";
/** What the release repair writes; it counts only as `orphanResolutionVerified` checks it. */
export const ORPHAN_RESOLVED_EVENT = "TASK_WORKER_ORPHAN_RESOLVED";
/**
 * The ingress operation every owner-authorised repair receipt names. It is `REPAIR_OWNER_APPROVAL_OPERATION`,
 * written out because the repair module imports this one; `repair.ts` fails to compile if they differ.
 */
export const ORPHAN_RELEASE_APPROVAL_OPERATION = "repair_execute";
/**
 * The evidence key a release record carries its authorization digest under. It names authorization on
 * purpose: `redact` stores any value under such a key as `[redacted]`, so `AuditLog.record` cannot write it.
 */
export const ORPHAN_RELEASE_AUTHORIZATION_KEY = "releaseAuthorization";

/**
 * Whether the audit API still redacts the authorization key. If a change to `redact` ever let it through,
 * a release written through `AuditLog.record` would verify; every release then fails closed instead.
 */
const AUDIT_API_CANNOT_WRITE_AUTHORIZATION = ((): boolean => {
  const probe = "sha256:orphan-release-probe";
  const stored = redact({ [ORPHAN_RELEASE_AUTHORIZATION_KEY]: probe }) as Record<string, unknown>;
  return stored[ORPHAN_RELEASE_AUTHORIZATION_KEY] !== probe;
})();

/** One unidentified-orphan record: the audit event, the execution it names, and that execution's task. */
export interface UnidentifiedOrphan {
  eventId: number;
  executionId: string;
  taskId: string;
  runId: string | null;
}

/** Exactly the parameters a release of this one orphan event carries, and the operator's receipt binds. */
export const orphanReleaseParameters = (executionId: string, orphanEventId: number): Record<string, string> => ({
  executionId,
  orphanEventId: String(orphanEventId),
  confirm: ORPHAN_RELEASE_CONFIRMATION,
});

/** The parameter digest of an owner receipt approving the release of exactly this orphan event (`assertRepairApproval`). */
export const orphanReleaseParameterDigest = (executionId: string, orphanEventId: number): string =>
  digestOf({
    operationId: ORPHAN_RELEASE_REPAIR_ID,
    parameters: orphanReleaseParameters(executionId, orphanEventId),
    dryRun: false,
  });

/** What a release record carries of the owner receipt it was written under. */
export interface OrphanReleaseApproval {
  channel: string;
  actor: string;
  nonce: string;
  receiptDigest: string;
  parameterDigest: string;
}

/** The execution row an orphan names, as the release binds it. */
export interface OrphanExecution {
  taskId: string;
  runId: string;
  workerSessionId: string;
  workerProcessId: number | null;
  workerProcessStartedAt: string | null;
}

/** The execution row of an orphan event, from `task_executions`; its worker identity columns are immutable. */
export const orphanExecutionOf = (db: Db, executionId: string): OrphanExecution | null => {
  const row = db.get<{
    task_id: string;
    run_id: string;
    worker_session_id: string;
    worker_process_id: number | null;
    worker_process_started_at: string | null;
  }>(
    `SELECT task_id, run_id, worker_session_id, worker_process_id, worker_process_started_at
       FROM task_executions WHERE execution_id = ?`,
    [executionId],
  );
  return row
    ? {
        taskId: row.task_id,
        runId: row.run_id,
        workerSessionId: row.worker_session_id,
        workerProcessId: row.worker_process_id,
        workerProcessStartedAt: row.worker_process_started_at,
      }
    : null;
};

/**
 * The digest a release of exactly this orphan event records, under exactly this owner receipt: the
 * execution, its task and run, the worker session, the process the execution recorded, the orphan event,
 * and the receipt. The repair computes it when it writes the release; the reader recomputes it.
 */
export const orphanReleaseAuthorization = (
  orphan: UnidentifiedOrphan,
  execution: OrphanExecution,
  approval: OrphanReleaseApproval,
): string =>
  digestOf({
    operationId: ORPHAN_RELEASE_REPAIR_ID,
    executionId: orphan.executionId,
    taskId: execution.taskId,
    runId: execution.runId,
    orphanEventId: orphan.eventId,
    orphanRunId: orphan.runId,
    workerSessionId: execution.workerSessionId,
    workerProcessId: execution.workerProcessId,
    workerProcessStartedAt: execution.workerProcessStartedAt,
    owner: { channel: approval.channel, actor: approval.actor, nonce: approval.nonce },
    receiptDigest: approval.receiptDigest,
    parameterDigest: approval.parameterDigest,
  });

/**
 * Every unidentified-orphan record (no recorded pid) of a task, or of one execution, that no verified
 * resolution follows, oldest first. A record whose execution id cannot be read still blocks: nothing can
 * name it for release.
 */
export const unresolvedUnidentifiedOrphans = (
  db: Db,
  scope: { taskId: string } | { executionId: string },
): UnidentifiedOrphan[] => {
  const byTask = "taskId" in scope;
  const rows = db.all<{ event_id: number; run_id: string | null; evidence_json: string }>(
    `SELECT event_id, run_id, evidence_json FROM audit_events
      WHERE kind = ? AND json_extract(evidence_json, ?) = ?
      ORDER BY event_id`,
    [ORPHAN_UNIDENTIFIED_EVENT, byTask ? "$.taskId" : "$.executionId", byTask ? scope.taskId : scope.executionId],
  );
  const unresolved: UnidentifiedOrphan[] = [];
  for (const row of rows) {
    const evidence = parsedRecord(row.evidence_json);
    if (evidence === null || (evidence["pid"] !== null && evidence["pid"] !== undefined)) continue;
    const orphan: UnidentifiedOrphan = {
      eventId: row.event_id,
      executionId: String(evidence["executionId"] ?? ""),
      taskId: String(evidence["taskId"] ?? ""),
      runId: row.run_id,
    };
    if (!orphanResolutionVerified(db, orphan)) unresolved.push(orphan);
  }
  return unresolved;
};

/**
 * #1189 A2 — every unidentified orphan that still holds its task, of a task that may still run (its
 * run has not ended and the task neither SUCCEEDED nor was CANCELLED), or only those of `runId`, oldest
 * first: the tasks that run no further worker turn until the owner's release.
 */
export const unreleasedWorkerOrphans = (db: Db, runId: string | null = null): Array<UnidentifiedOrphan & { runId: string }> => {
  const tasks = db.all<{ task_id: string; run_id: string }>(
    `SELECT t.task_id, t.run_id FROM tasks t JOIN runs r ON r.run_id = t.run_id
      WHERE t.task_id IN (SELECT json_extract(evidence_json, '$.taskId') FROM audit_events WHERE kind = ?)
        AND t.state NOT IN ('SUCCEEDED', 'CANCELLED')
        AND r.state NOT IN (${TERMINAL_RUN_STATES.map(() => "?").join(", ")})
        AND (? IS NULL OR t.run_id = ?)
      ORDER BY t.task_id`,
    [ORPHAN_UNIDENTIFIED_EVENT, ...TERMINAL_RUN_STATES, runId, runId],
  );
  return tasks
    .flatMap((task) => unresolvedUnidentifiedOrphans(db, { taskId: task.task_id }).map((orphan) => ({ ...orphan, runId: task.run_id })))
    .sort((a, b) => a.eventId - b.eventId);
};

/**
 * Whether the release repair released exactly this orphan event: a release record written after it,
 * naming its execution and event, under an owner receipt approving exactly this release that the owner
 * authority consumed before the record, whose authorization digest is the one the repair computes for
 * this orphan, execution and receipt. Nothing here reads the ingress replay cache.
 */
export const orphanResolutionVerified = (db: Db, orphan: UnidentifiedOrphan): boolean => {
  if (orphan.executionId === "" || !AUDIT_API_CANNOT_WRITE_AUTHORIZATION) return false;
  const execution = orphanExecutionOf(db, orphan.executionId);
  if (execution === null || execution.taskId !== orphan.taskId) return false;
  const parameterDigest = orphanReleaseParameterDigest(orphan.executionId, orphan.eventId);
  const resolutions = db.all<{ event_id: number; actor: string | null; evidence_json: string }>(
    `SELECT event_id, actor, evidence_json FROM audit_events
      WHERE kind = ? AND event_id > ? AND json_extract(evidence_json, '$.orphanEventId') = ?
      ORDER BY event_id`,
    [ORPHAN_RESOLVED_EVENT, orphan.eventId, orphan.eventId],
  );
  return resolutions.some((resolution) => {
    const evidence = parsedRecord(resolution.evidence_json);
    if (evidence === null || evidence["executionId"] !== orphan.executionId) return false;
    const approval = releaseApprovalOf(evidence["ownerApproval"]);
    if (
      approval === null ||
      approval.parameterDigest !== parameterDigest ||
      resolution.actor !== `${approval.channel}:${approval.actor}` ||
      evidence[ORPHAN_RELEASE_AUTHORIZATION_KEY] !== orphanReleaseAuthorization(orphan, execution, approval)
    ) {
      return false;
    }
    // The owner authority consumed this receipt, for no candidate, before the release was recorded.
    const consumed = db.get<{ n: number }>(
      `SELECT 1 AS n FROM audit_events
        WHERE kind = 'OWNER_APPROVAL_CONSUMED' AND event_id < ?
          AND json_extract(evidence_json, '$.receiptDigest') = ?
          AND json_extract(evidence_json, '$.candidateSnapshotDigest') IS NULL
        LIMIT 1`,
      [resolution.event_id, approval.receiptDigest],
    );
    return consumed !== undefined;
  });
};

const releaseApprovalOf = (value: unknown): OrphanReleaseApproval | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { channel, actor, nonce, receiptDigest, parameterDigest } = value as Record<string, unknown>;
  return typeof channel === "string" &&
    typeof actor === "string" &&
    typeof nonce === "string" &&
    typeof receiptDigest === "string" &&
    typeof parameterDigest === "string"
    ? { channel, actor, nonce, receiptDigest, parameterDigest }
    : null;
};

const parsedRecord = (json: string): Record<string, unknown> | null => {
  try {
    const value = JSON.parse(json) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};
