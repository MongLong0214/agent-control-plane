import { digestOf } from "../core/digest.ts";
import type { Db } from "../db/database.ts";

/**
 * #1096 — the one way an unidentified worker orphan (a launch the guard admitted whose pid was never
 * recorded) stops blocking its task: the operator repair `release_unidentified_worker_orphan`, run under
 * an owner receipt admitted through ingress for exactly that orphan event.
 *
 * A resolution is an audit row, and an audit row proves nothing on its own: `AuditLog.record` and a
 * connection ACP did not open can both write one. So the reader never trusts the row. It follows the row
 * to the admitted ingress message it names and checks that message's write-once payload — a row a
 * connection ACP did not open cannot insert — approves this repair for this execution and this orphan
 * event, and nothing else; that the receipt was consumed before the row was written; and that no repair
 * refused it. A row that fails any of these is ignored, and the orphan keeps blocking its task.
 *
 * Limit: the admitted message lives in the ingress replay cache, which is pruned once it is older than
 * the channel's nonce TTL (24 hours by default) and another message is admitted on that channel. After
 * that the resolution no longer verifies and the orphan blocks its task again, fail-closed, until the
 * operator runs the repair once more.
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

/** What a resolution row carries of the receipt it was written under: where it was admitted, and its digest. */
export interface OrphanReleaseApproval {
  channel: string;
  actor: string;
  nonce: string;
  receiptDigest: string;
}

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
 * Whether a resolution of exactly this orphan event stands: written after it, naming its execution and
 * event, and resting on an owner receipt that ingress admitted for the release of exactly this orphan
 * event, that an owner repair consumed before the resolution was written, and that no repair refused.
 */
export const orphanResolutionVerified = (db: Db, orphan: UnidentifiedOrphan): boolean => {
  if (orphan.executionId === "") return false;
  const parameterDigest = digestOf({
    operationId: ORPHAN_RELEASE_REPAIR_ID,
    parameters: orphanReleaseParameters(orphan.executionId, orphan.eventId),
    dryRun: false,
  });
  const resolutions = db.all<{ event_id: number; evidence_json: string }>(
    `SELECT event_id, evidence_json FROM audit_events
      WHERE kind = ? AND event_id > ? AND json_extract(evidence_json, '$.orphanEventId') = ?
      ORDER BY event_id`,
    [ORPHAN_RESOLVED_EVENT, orphan.eventId, orphan.eventId],
  );
  return resolutions.some((resolution) => {
    const evidence = parsedRecord(resolution.evidence_json);
    if (evidence === null || evidence["executionId"] !== orphan.executionId) return false;
    const approval = evidence["ownerApproval"];
    if (typeof approval !== "object" || approval === null) return false;
    const { channel, actor, nonce } = approval as Record<string, unknown>;
    if (typeof channel !== "string" || typeof actor !== "string" || typeof nonce !== "string") return false;
    // The admitted message: its actor, and the write-once payload it was admitted with.
    const inbound = db.get<{ actor: string; payload_json: string | null }>(
      `SELECT actor, payload_json FROM inbound_messages WHERE channel = ? AND nonce = ?`,
      [channel, nonce],
    );
    if (!inbound || inbound.actor !== actor || inbound.payload_json === null) return false;
    const payload = parsedRecord(inbound.payload_json);
    if (
      payload === null ||
      payload["type"] !== "OWNER_APPROVAL" ||
      payload["operation"] !== ORPHAN_RELEASE_APPROVAL_OPERATION ||
      payload["approved"] !== true ||
      payload["parameterDigest"] !== parameterDigest
    ) {
      return false;
    }
    // The receipt ingress minted from that message (`IngressGuard.admitOwnerApproval`), by its digest.
    const receiptDigest = digestOf({
      channel,
      actor,
      inboundNonce: nonce,
      runId: payload["runId"] ?? null,
      candidateSnapshotDigest: payload["candidateSnapshotDigest"] ?? null,
      operation: payload["operation"],
      parameterDigest: payload["parameterDigest"],
      idempotencyKey: payload["idempotencyKey"],
      approved: payload["approved"],
    });
    const consumed = db.get<{ n: number }>(
      `SELECT 1 AS n FROM audit_events
        WHERE kind = 'OWNER_APPROVAL_CONSUMED' AND event_id < ?
          AND json_extract(evidence_json, '$.receiptDigest') = ?
        LIMIT 1`,
      [resolution.event_id, receiptDigest],
    );
    const refused = db.get<{ n: number }>(
      `SELECT 1 AS n FROM audit_events
        WHERE kind = 'REPAIR_REFUSED' AND json_extract(evidence_json, '$.ownerReceiptDigest') = ?
        LIMIT 1`,
      [receiptDigest],
    );
    return consumed !== undefined && refused === undefined;
  });
};

const parsedRecord = (json: string): Record<string, unknown> | null => {
  try {
    const value = JSON.parse(json) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};
