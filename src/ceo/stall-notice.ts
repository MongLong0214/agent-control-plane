import { ReasonCode } from "../core/reason-codes.ts";
import type { Db } from "../db/database.ts";
import { Role, SessionLifecycle, roleKeyFor } from "../domain/types.ts";
import type { BindingRegistry } from "../session/binding-registry.ts";
import type { SessionRegistry } from "../session/session-registry.ts";
import { NotificationKind, type ProductionGate } from "./production-gate.ts";

/**
 * #1189 — a stall that no agent owns and nothing else reports goes to the CEO as the existing
 * CRITICAL_SYSTEM_FAILURE notification (PRD §19.3), through `ProductionGate.notify`, the only emitter.
 *
 * Interim, and the only place this lane calls the notify path. #1276 makes one module own incident
 * dedup and retry (`deliverIncident`); at integration `routeStallToCeo` is replaced by it — the start
 * stall as a stall that belongs to no run (subject `daemon-start`, episode `stallId`), an unreleased
 * worker orphan as one about its run (episode: the orphan event) — and this file is deleted.
 *
 * Once per stall, not once per call. `stallId` names the stall; the outbox row the first routing wrote
 * is what every later restart or tick finds, and a CEO notification is retained until it is ACKed (TTL
 * never expires that kind), so that row is the whole of the idempotency: it is never enqueued twice,
 * and a row still PENDING is the one a later delivery sends. A payload that describes the stall again
 * differently (a later observation of the same thing) does not make a second notification.
 *
 * Routing is not a decision. Nothing here changes a run, a task or an authority: the notice tells the
 * CEO what is stalled, on what, and who can clear it.
 */
export type StallRouting =
  | { status: "ROUTED" | "ALREADY_ROUTED"; messageId: string; deliveryStatus: string }
  | { status: "NOT_ROUTED"; reasonCode: ReasonCode };

/** The source every stall notice names, so its row can be found again by `(source, stallId)`. */
export const StallSource = {
  DAEMON_START: "DAEMON_START_STALL",
  WORKER_ORPHAN: "WORKER_ORPHAN_UNRELEASED",
} as const;
export type StallSource = (typeof StallSource)[keyof typeof StallSource];

/** The CRITICAL_SYSTEM_FAILURE row already written for this stall, if any. */
export const stallNoticeRow = (
  db: Db,
  source: StallSource,
  stallId: string,
): { messageId: string; status: string } | null => {
  const row = db.get<{ message_id: string; status: string }>(
    `SELECT message_id, status FROM outbox
      WHERE kind = 'CEO_NOTIFICATION'
        AND json_extract(payload_json, '$.notification') = ?
        AND json_extract(payload_json, '$.source') = ?
        AND json_extract(payload_json, '$.stallId') = ?
      ORDER BY created_at, rowid LIMIT 1`,
    [NotificationKind.CRITICAL_SYSTEM_FAILURE, source, stallId],
  );
  return row ? { messageId: row.message_id, status: row.status } : null;
};

/** What routing a stall reads and writes through: the control plane's own registries and its one emitter. */
export interface StallRouter {
  db: Db;
  ceo: Pick<ProductionGate, "notify">;
  bindings: Pick<BindingRegistry, "active">;
  sessions: Pick<SessionRegistry, "get">;
}

/**
 * Routes one stall to the CEO unless it already was. `describe` runs only when a notice is written,
 * so a check that costs something (a process-table read) is paid once per stall, not once per tick.
 * With no CEO bound, or no READY CEO session to address, nothing is written — not even the refusal
 * `notify` would record, since a caller on a timer would record it every tick — and the next call
 * tries again: a delivery that cannot happen yet is not a failure of the thing that stalled.
 */
export const routeStallToCeo = (
  router: StallRouter,
  stall: { source: StallSource; stallId: string; runId: string | null; describe: () => Record<string, unknown> },
): StallRouting => {
  const { db } = router;
  const prior = stallNoticeRow(db, stall.source, stall.stallId);
  if (prior) return { status: "ALREADY_ROUTED", messageId: prior.messageId, deliveryStatus: prior.status };
  const ceo = router.bindings.active(roleKeyFor(Role.CEO));
  if (!ceo) return { status: "NOT_ROUTED", reasonCode: ReasonCode.GATE_AUTHORITY_DENIED };
  if (router.sessions.get(ceo.sessionId)?.lifecycle !== SessionLifecycle.READY) {
    return { status: "NOT_ROUTED", reasonCode: ReasonCode.OUTBOX_TARGET_NOT_CURRENT };
  }
  const notified = router.ceo.notify(NotificationKind.CRITICAL_SYSTEM_FAILURE, stall.runId, {
    ...stall.describe(),
    source: stall.source,
    stallId: stall.stallId,
  });
  if (!notified.allowed) return { status: "NOT_ROUTED", reasonCode: notified.reasonCode };
  // `notify` reports the CEO binding it found, not whether the outbox took the row: an enqueue the
  // outbox refused (its target is not the ready session holding the role) leaves nothing to find.
  const written = stallNoticeRow(db, stall.source, stall.stallId);
  return written
    ? { status: "ROUTED", messageId: written.messageId, deliveryStatus: written.status }
    : { status: "NOT_ROUTED", reasonCode: ReasonCode.OUTBOX_TARGET_NOT_CURRENT };
};
