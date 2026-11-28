import { redactCredentialShapes } from "../core/credential-shapes.ts";
import { acpError } from "../core/errors.ts";
import type { AuditLog } from "../db/audit.ts";
import type { Db } from "../db/database.ts";
import { NotificationKind } from "./ceo-incident-notices.ts";
import type { ProductionGate } from "./production-gate.ts";

/**
 * #1189 — a FAILED run's CEO notice that could not be enqueued when the run ended (no CEO bound, or the outbox
 * refused it) is kept owed in this record: the notice, with `delivered: false`, as a cap's hand-off is kept
 * (`deliverOwedHandOff`). Once the sweep has sent it (`Finalizer.deliverOwedFailedNotices`), a second record with
 * `delivered: true` names the first (`owedEventId`). A notice enqueued at once writes none.
 */
export const FAILED_NOTICE = "FINALIZATION_FAILED_NOTICE";

/**
 * #1189 — what a FAILED notice's owed record keeps when the audit log refuses the notice's own text (a refusal
 * message holding a credential shape, say): the failure's codes, its counts and ACP's own words, with the blocker's
 * shapes redacted. The refusal's free text (`reason`, `evidence`) and the attempt ids are left out.
 */
const MINIMAL_FAILED_NOTICE_FIELDS = [
  "candidateSnapshotDigest", "failureReasonCode", "failureClass", "failureCause", "limit", "outcome", "merged", "owner",
  "action", "refusals", "failureRetryCap", "retries", "retryCap", "whyItMatters",
] as const;

const minimalFailedNotice = (notice: Record<string, unknown>): Record<string, unknown> => ({
  ...Object.fromEntries(MINIMAL_FAILED_NOTICE_FIELDS.filter((field) => notice[field] !== undefined).map((field) => [field, notice[field]])),
  blocker: redactCredentialShapes(String(notice["blocker"] ?? "")).slice(0, 200),
  detailWithheld: true,
});

/**
 * #1189 — a FAILED run's notice to the CEO, enqueued at once, in the transaction that ends the run. One that could
 * not be (no CEO bound, or the outbox refused it) is kept owed instead, for `Finalizer.deliverOwedFailedNotices`,
 * minimal (`minimalFailedNotice`) if the audit log refuses its text; the run never waits on it. A refusal of the
 * minimal record too is a fault, and throws, rolling the run's end back with it. It lives here rather than in the
 * finalizer so that the candidate pipeline (#1454's revision budget) ends a run with it without importing the daemon.
 */
export const notifyRunFailed = (
  ports: { db: Pick<Db, "tx">; audit: AuditLog; ceo: Pick<ProductionGate, "notify"> },
  runId: string,
  notice: Record<string, unknown>,
): void => {
  ports.db.tx(() => {
    const notified = ports.ceo.notify(NotificationKind.CRITICAL_SYSTEM_FAILURE, runId, notice);
    if (notified.allowed) return;
    const owed = { kind: FAILED_NOTICE, runId, reasonCode: notified.reasonCode };
    if (ports.audit.record({ ...owed, evidence: { ...notice, delivered: false } }).allowed) return;
    const kept = ports.audit.record({ ...owed, evidence: { ...minimalFailedNotice(notice), delivered: false } });
    if (!kept.allowed) throw acpError(kept.reasonCode, "the FAILED run's CEO notice could not be kept owed", { runId });
  });
};
