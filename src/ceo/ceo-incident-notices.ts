import { digestOf } from "../core/digest.ts";
import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { AuditLog } from "../db/audit.ts";
import type { Db } from "../db/database.ts";
import { OWNERLESS_STALL_ROUTED, runProgressAt } from "../doctor/watchdog.ts";
import { isTerminal } from "../domain/run-state.ts";
import { Role, type RunState, roleKeyFor } from "../domain/types.ts";
import { MessageKind } from "../outbox/envelope.ts";
import type { Outbox } from "../outbox/outbox.ts";
import type { BindingRegistry } from "../session/binding-registry.ts";

/**
 * #1189 — the one owner of how an incident reaches the CEO: the notification kinds, the incident classes,
 * one correlation per (subject, class), dedup, the recovery of a notice the outbox refused or whose enqueue
 * had an unknown outcome, and re-delivery to a CEO that replaced the one it was sent to. Every detector —
 * the post-merge, bootstrap and contract-change stalls, the held retirement, the watchdog, the continuation
 * wake, an agent-owned wait's CEO escalation, a CTO escalation — states its incident here, and none of them
 * enqueues the notice itself.
 *
 * An incident is open while its detector still finds it and `resolutionOf` finds no evidence that closed it: its
 * run gone, its run ended, or a CEO decision recorded on its run, each after it opened. A stall that cleared is no
 * longer stated, so nothing more is delivered for it; an ACK is receipt, never resolution. A notice of a resolved
 * incident is withdrawn rather than carried to a CEO it was not addressed to (`withdrawResolvedNotices`).
 *
 * Two notices keep their own owners: a candidate's READY_FOR_CEO_REVIEW (`ProductionGate.buildPacket`, and
 * its re-delivery after a CEO recovery, deduplicated by the decision and the candidate, in
 * `AgentOwnedWaits.redeliverPendingReviews`), and an agent-owned wait's RENOTIFY and REASSIGN steps, which
 * re-send that wait's own notice on its deadline ladder by design.
 */

/** PRD §19.3 — the only three automatic Hermes notifications. */
export const NotificationKind = {
  READY_FOR_CEO_REVIEW: "READY_FOR_CEO_REVIEW",
  TRUE_ESCALATION: "TRUE_ESCALATION",
  CRITICAL_SYSTEM_FAILURE: "CRITICAL_SYSTEM_FAILURE",
} as const;
export type NotificationKind = (typeof NotificationKind)[keyof typeof NotificationKind];

/**
 * The incident classes, one correlation per (subject, class): `ceo-incident:<class>:<subject>`.
 *
 * - RUN_STALLED (CRITICAL_SYSTEM_FAILURE; subject: the run). A run nothing will move on its own: blocked
 *   after its merge (BLOCKED_POST_MERGE), a STRANDED bootstrap application, a CONTRACT_CHANGE the
 *   activation path cannot finish, a watchdog stall of the run or of its task execution, claim or
 *   candidate pipeline attempt, a READY task its CTO left after its one continuation wake, and an
 *   agent-owned wait's CEO_ESCALATION step. Its episode is the run's latest progress (`runProgressAt`): two
 *   detectors that see the same unchanged run send one notice, and real progress starts the next episode.
 * - RETIREMENT_HELD (CRITICAL_SYSTEM_FAILURE; subject: the run that holds it). An owner retirement that
 *   waits on a run terminal in BLOCKED_POST_MERGE. Episode: that run's latest progress.
 * - DELIVERY_STALLED (CRITICAL_SYSTEM_FAILURE; subject: the role its messages are addressed to). Messages
 *   PENDING past the delivery deadline. Episode: when the oldest of them was queued.
 * - RESOURCE_STALLED (CRITICAL_SYSTEM_FAILURE; subject: the resource). A stall that belongs to no run, such
 *   as a session left STARTING. Episode: when it started.
 * - CTO_ESCALATION (TRUE_ESCALATION; subject: the run). A CTO escalation. Episode: its CTO_ESCALATION event.
 *
 * Each class names the record its delivery writes. A stall's is OWNERLESS_STALL_ROUTED, which is not
 * progress of the run it names; a CTO escalation's is CEO_NOTIFICATION, as before.
 */
export const IncidentClass = {
  RUN_STALLED: "RUN_STALLED",
  RETIREMENT_HELD: "RETIREMENT_HELD",
  DELIVERY_STALLED: "DELIVERY_STALLED",
  RESOURCE_STALLED: "RESOURCE_STALLED",
  CTO_ESCALATION: "CTO_ESCALATION",
} as const;
export type IncidentClass = (typeof IncidentClass)[keyof typeof IncidentClass];

interface ClassRule {
  notification: NotificationKind;
  record: string;
  /**
   * CEO ruling (#1189 round 2, item 1): an ACK is not a resolution. A notice of this class that is ACKed
   * or refused while its incident stays open is delivered once more to each CEO generation that has not
   * been sent it. A CTO escalation's re-notification belongs to its agent-owned wait's deadline ladder.
   */
  redeliverToNewCeo: boolean;
}

const CLASS_RULES: Readonly<Record<IncidentClass, ClassRule>> = {
  RUN_STALLED: { notification: NotificationKind.CRITICAL_SYSTEM_FAILURE, record: OWNERLESS_STALL_ROUTED, redeliverToNewCeo: true },
  RETIREMENT_HELD: { notification: NotificationKind.CRITICAL_SYSTEM_FAILURE, record: OWNERLESS_STALL_ROUTED, redeliverToNewCeo: true },
  DELIVERY_STALLED: { notification: NotificationKind.CRITICAL_SYSTEM_FAILURE, record: OWNERLESS_STALL_ROUTED, redeliverToNewCeo: true },
  RESOURCE_STALLED: { notification: NotificationKind.CRITICAL_SYSTEM_FAILURE, record: OWNERLESS_STALL_ROUTED, redeliverToNewCeo: true },
  CTO_ESCALATION: { notification: NotificationKind.TRUE_ESCALATION, record: "CEO_NOTIFICATION", redeliverToNewCeo: false },
};

/** A notice the outbox refused while the fact it reports was kept: the record a later pass delivers it from. */
export const CEO_NOTIFICATION_DEFERRED = "CEO_NOTIFICATION_DEFERRED";

export type NoticePorts = { db: Db; audit: AuditLog; outbox: Outbox; bindings: BindingRegistry };

export interface Incident {
  cls: IncidentClass;
  /** The run, or for a stall that belongs to no run the role or resource it is about. */
  subject: string;
  /** The run the notice names and its outbox row is filed under, when there is one. */
  runId: string | null;
  /** One occurrence of the class on the subject. A notice is delivered per episode, never per pass. */
  episode: string;
  /** The audit event the incident opened with; a CEO_DECISION on the run after it resolves the incident. */
  openedEventId?: number | null;
  payload: Record<string, unknown>;
  /**
   * Facts that cost something to read (a process-table scan), read only when a notice is enqueued and never
   * on a pass that delivers nothing; merged over `payload` for that notice and its delivery record.
   */
  describe?: () => Record<string, unknown>;
  /** The delivery record's own evidence; by default the payload without `whyItMatters`. */
  record?: Record<string, unknown>;
}

export const correlationOf = (cls: IncidentClass, subject: string): string => `ceo-incident:${cls}:${subject}`;

/** Every delivery of one episode shares this prefix; the CEO generation it was sent to ends the key. */
const episodePrefix = (incident: Incident): string => `${correlationOf(incident.cls, incident.subject)}|${incident.episode}|`;
const deliveryKey = (incident: Incident, generation: number): string => `${episodePrefix(incident)}g${generation}`;

/** The episode of a run-scoped incident: the run's latest progress, read where every detector reads it. */
export const runEpisode = (db: Pick<Db, "get">, runId: string): string => runProgressAt(db, runId) ?? "no-progress";

/**
 * What the CEO has of an incident:
 * - NOT_ENQUEUED: no notice exists; refused, unknown or never tried, and the next pass tries again;
 * - ENQUEUED: a notice is queued or sent and not yet ACKed (it follows the CEO role's holder);
 * - ACKED: a CEO acknowledged receipt. That is not a resolution;
 * - REJECTED: every notice was refused by its transport or expired;
 * - RESOLVED: evidence closed it (`resolutionOf`). The detectors decide the rest: a stall that cleared is no
 *   longer stated.
 */
export type NoticeState = "NOT_ENQUEUED" | "ENQUEUED" | "ACKED" | "REJECTED" | "RESOLVED";

export interface NoticeStatus {
  state: NoticeState;
  correlation: string;
  deliveries: Array<{ messageId: string; status: string; generation: number }>;
  resolvedBy: Resolution | null;
}

/** The evidence that closed an incident, and the audit event that is it (none for a run that is gone). */
export interface Resolution {
  kind: "RUN_GONE" | "RUN_ENDED" | "CEO_DECISION";
  eventId: number | null;
}

export interface NoticeDelivery {
  state: NoticeState;
  /** The notice delivered now, or the one that already covers the incident. */
  messageId: string | null;
  created: boolean;
  redelivery: boolean;
}

const UNSETTLED = new Set(["PENDING", "IN_FLIGHT", "SENT"]);

const deliveriesOf = (db: Pick<Db, "all">, incident: Incident): NoticeStatus["deliveries"] => {
  const prefix = episodePrefix(incident);
  return db.all<{ message_id: string; status: string; binding_generation: number }>(
    `SELECT message_id, status, binding_generation FROM outbox
      WHERE idempotency_key >= ? AND idempotency_key < ? AND kind = 'CEO_NOTIFICATION'
      ORDER BY created_at, message_id`,
    [prefix, `${prefix}\u007f`],
  ).map((row) => ({ messageId: row.message_id, status: row.status, generation: row.binding_generation }));
};

/**
 * The one definition of an incident's resolution, asked by every path that would hand its notice to a CEO:
 * `deliverIncident` before it delivers, `retryDeferredNotices` before it retries, and the outbox
 * (`withdrawResolvedNotices`) before it carries a notice to a CEO it was not addressed to. An incident about
 * a run is resolved by evidence on that run:
 * - RUN_GONE: the run no longer exists;
 * - CEO_DECISION: a CEO decision was recorded on the run after the incident opened (`openedEventId`, else
 *   its first delivery record);
 * - RUN_ENDED: the run is terminal and a RUN_TRANSITION followed the opening, so it ended since (cancelled,
 *   failed, completed). A run already terminal when its incident opened, as BLOCKED_POST_MERGE is, is not.
 * An incident never delivered has not opened, so only RUN_GONE resolves it. An incident not about a run (a
 * role's stalled messages, a session) has no such evidence; its detector stops stating it when it clears.
 */
export const resolutionOf = (db: Pick<Db, "get">, incident: Incident): Resolution | null => {
  if (incident.runId === null || incident.subject !== incident.runId) return null;
  const run = db.get<{ state: RunState }>(`SELECT state FROM runs WHERE run_id = ?`, [incident.runId]);
  if (!run) return { kind: "RUN_GONE", eventId: null };
  const opened = incident.openedEventId ?? db.get<{ event_id: number | null }>(
    `SELECT MIN(event_id) AS event_id FROM audit_events WHERE run_id = ? AND kind = ?
       AND json_extract(evidence_json, '$.correlation') = ? AND json_extract(evidence_json, '$.episode') = ?`,
    [incident.runId, CLASS_RULES[incident.cls].record, correlationOf(incident.cls, incident.subject), incident.episode],
  )?.event_id ?? null;
  if (opened === null) return null;
  const decided = db.get<{ event_id: number }>(
    `SELECT event_id FROM audit_events WHERE run_id = ? AND kind = 'CEO_DECISION' AND event_id > ?
      ORDER BY event_id LIMIT 1`,
    [incident.runId, opened],
  );
  if (decided) return { kind: "CEO_DECISION", eventId: decided.event_id };
  if (!isTerminal(run.state)) return null;
  const ended = db.get<{ event_id: number }>(
    `SELECT event_id FROM audit_events WHERE run_id = ? AND kind = 'RUN_TRANSITION' AND event_id > ?
      ORDER BY event_id DESC LIMIT 1`,
    [incident.runId, opened],
  );
  return ended ? { kind: "RUN_ENDED", eventId: ended.event_id } : null;
};

export const noticeStatus = (ports: Pick<NoticePorts, "db">, incident: Incident): NoticeStatus => {
  const deliveries = deliveriesOf(ports.db, incident);
  const resolution = resolutionOf(ports.db, incident);
  const state: NoticeState = resolution !== null ? "RESOLVED"
    : deliveries.length === 0 ? "NOT_ENQUEUED"
      : deliveries.some((delivery) => UNSETTLED.has(delivery.status)) ? "ENQUEUED"
        : deliveries.some((delivery) => delivery.status === "ACKED") ? "ACKED"
          : "REJECTED";
  return {
    state,
    correlation: correlationOf(incident.cls, incident.subject),
    deliveries,
    resolvedBy: resolution,
  };
};

/** The record of a queued notice withdrawn because its incident was resolved (`withdrawResolvedNotices`). */
export const CEO_NOTIFICATION_WITHDRAWN = "CEO_NOTIFICATION_WITHDRAWN";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The incident a queued notice was delivered for, read back from the fields `deliverIncident` wrote on it. */
const incidentOfNotice = (runId: string | null, payloadJson: string): Incident | null => {
  let payload: unknown;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    return null;
  }
  if (!isRecord(payload)) return null;
  const [cls, correlation, episode] = [payload["incidentClass"], payload["correlation"], payload["episode"]];
  if (typeof cls !== "string" || !(cls in CLASS_RULES) || typeof correlation !== "string" || typeof episode !== "string") return null;
  const prefix = correlationOf(cls as IncidentClass, "");
  if (!correlation.startsWith(prefix)) return null;
  return { cls: cls as IncidentClass, subject: correlation.slice(prefix.length), runId, episode, payload: {} };
};

/**
 * #1189 — a resolved incident's notice is not carried to a CEO it was not addressed to. Before the outbox moves
 * its unACKed CEO notices to the role's current holder, every incident notice still owed (PENDING or SENT) and
 * addressed to an earlier holder whose incident `resolutionOf` finds resolved is REJECTED, with a
 * CEO_NOTIFICATION_WITHDRAWN record of the evidence. A notice addressed to the current holder stays as it is: a
 * late notice of a decision that holder already made executes nothing (the decision door refuses it again),
 * and one being sent (IN_FLIGHT) is that send's.
 */
export const withdrawResolvedNotices = (
  db: Db,
  audit: AuditLog,
  holder: { generation: number; sessionId: string },
): string[] => {
  const withdrawn: string[] = [];
  const rows = db.all<{
    message_id: string; run_id: string | null; role_key: string; target_session_id: string;
    binding_generation: number; status: string; payload_json: string;
  }>(
    `SELECT message_id, run_id, role_key, target_session_id, binding_generation, status, payload_json FROM outbox
      WHERE kind = 'CEO_NOTIFICATION' AND status IN ('PENDING', 'SENT')
        AND (binding_generation <> ? OR target_session_id <> ?)
        AND json_valid(payload_json) = 1 AND json_extract(payload_json, '$.correlation') LIKE 'ceo-incident:%'
      ORDER BY created_at, rowid`,
    [holder.generation, holder.sessionId],
  );
  for (const row of rows) {
    const incident = incidentOfNotice(row.run_id, row.payload_json);
    const resolution = incident === null ? null : resolutionOf(db, incident);
    if (incident === null || resolution === null) continue;
    db.tx(() => {
      const changed = db.run(
        `UPDATE outbox SET status = 'REJECTED', reason_code = ?, claim_token = NULL, claimed_at = NULL,
                           retry_eligible = 0, next_attempt_at = NULL
          WHERE message_id = ? AND status IN ('PENDING', 'SENT')`,
        [ReasonCode.CEO_INCIDENT_RESOLVED, row.message_id],
      ).changes;
      if (changed !== 1) return;
      audit.record({
        kind: CEO_NOTIFICATION_WITHDRAWN,
        reasonCode: ReasonCode.CEO_INCIDENT_RESOLVED,
        runId: row.run_id,
        roleKey: row.role_key,
        sessionId: row.target_session_id,
        evidence: {
          messageId: row.message_id,
          status: row.status,
          fromGeneration: row.binding_generation,
          toGeneration: holder.generation,
          incidentClass: incident.cls,
          correlation: correlationOf(incident.cls, incident.subject),
          episode: incident.episode,
          resolvedBy: resolution.kind,
          resolvingEventId: resolution.eventId,
        },
      });
      withdrawn.push(row.message_id);
    });
  }
  return withdrawn;
};

const withoutWhy = (payload: Record<string, unknown>): Record<string, unknown> => {
  const { whyItMatters: _whyItMatters, ...rest } = payload;
  return rest;
};

const covered = (state: NoticeState, messageId: string | null): Decision<NoticeDelivery> =>
  allow(ReasonCode.OUTBOX_DUPLICATE_SUPPRESSED, { state, messageId, created: false, redelivery: false });

/**
 * Delivers an open incident's notice, at most once per episode and CEO generation, and is asked on every
 * pass that still finds the incident:
 * - no notice yet (never tried, refused or unknown): delivered now;
 * - a notice queued or sent, not ACKed: nothing; it follows the CEO role's holder;
 * - ACKED or REJECTED: nothing for the CEO it went to; for a CEO generation it never went to, delivered
 *   once more under the same correlation when the class says so;
 * - RESOLVED: nothing, ever.
 * The outbox row, not the enqueue's answer, says whether the notice exists: a refused enqueue and one whose
 * outcome is unknown (it threw) are the same refusal, and the next pass asks again. A refusal writes
 * nothing: on its own it rolls back here, and inside a caller's transaction it is the caller's to handle.
 */
export const deliverIncident = (ports: NoticePorts, incident: Incident): Decision<NoticeDelivery> =>
  ports.db.txDecision(() => {
    const status = noticeStatus(ports, incident);
    if (status.state === "RESOLVED") {
      return allow(ReasonCode.CEO_INCIDENT_RESOLVED, { state: "RESOLVED", messageId: null, created: false, redelivery: false });
    }
    const live = status.deliveries.find((delivery) => UNSETTLED.has(delivery.status));
    if (live) return covered("ENQUEUED", live.messageId);
    const ceo = ports.bindings.active(roleKeyFor(Role.CEO));
    if (!ceo) {
      return deny(ReasonCode.GATE_AUTHORITY_DENIED, "no CEO binding can receive the notice", {
        correlation: status.correlation,
        episode: incident.episode,
      });
    }
    const rule = CLASS_RULES[incident.cls];
    const redelivery = status.state !== "NOT_ENQUEUED";
    if (redelivery) {
      const toCurrent = status.deliveries.find((delivery) => delivery.generation === ceo.bindingGeneration);
      if (toCurrent || !rule.redeliverToNewCeo) return covered(status.state, (toCurrent ?? status.deliveries.at(-1))?.messageId ?? null);
    }
    const key = deliveryKey(incident, ceo.bindingGeneration);
    const payload = incident.describe ? { ...incident.payload, ...incident.describe() } : incident.payload;
    let refusal: { reasonCode: ReasonCode; outcome: "REFUSED" | "UNKNOWN"; error?: string } | null = null;
    try {
      const enqueued = ports.outbox.enqueue({
        idempotencyKey: key,
        roleKey: ceo.roleKey,
        bindingGeneration: ceo.bindingGeneration,
        targetSessionId: ceo.sessionId,
        runId: incident.runId,
        kind: MessageKind.CEO_NOTIFICATION,
        payload: {
          notification: rule.notification,
          runId: incident.runId,
          ...payload,
          incidentClass: incident.cls,
          correlation: status.correlation,
          episode: incident.episode,
          ...(redelivery ? { redelivery: true } : {}),
        },
      });
      if (!enqueued.allowed) refusal = { reasonCode: enqueued.reasonCode, outcome: "REFUSED" };
    } catch (error) {
      refusal = { reasonCode: ReasonCode.INTERNAL_ERROR, outcome: "UNKNOWN", error: error instanceof Error ? error.message : String(error) };
    }
    const row = ports.outbox.byIdempotencyKey(key);
    if (!row) {
      return deny(refusal?.reasonCode ?? ReasonCode.OUTBOX_TARGET_NOT_CURRENT, "the CEO notice was not queued; a later pass delivers it", {
        correlation: status.correlation,
        episode: incident.episode,
        outcome: refusal?.outcome ?? "REFUSED",
        ...(refusal?.error ? { error: refusal.error } : {}),
      });
    }
    // The delivery record is what a later pass reads the incident's opening from. If AuditLog refuses the
    // incident's facts (an unreviewed field holding free text), the record keeps the incident's identity.
    const identity = {
      notification: rule.notification,
      incidentClass: incident.cls,
      correlation: status.correlation,
      episode: incident.episode,
      messageId: row.messageId,
      generation: ceo.bindingGeneration,
      redelivery,
    };
    const delivery = { kind: rule.record, runId: incident.runId, roleKey: ceo.roleKey, sessionId: ceo.sessionId };
    const recorded = ports.audit.record({ ...delivery, evidence: { ...identity, ...(incident.record ?? withoutWhy(payload)) } });
    if (!recorded.allowed) {
      const kept = ports.audit.record({ ...delivery, evidence: identity });
      if (!kept.allowed) return kept as unknown as Decision<NoticeDelivery>;
    }
    return allow(ReasonCode.OK, { state: "ENQUEUED", messageId: row.messageId, created: true, redelivery });
  });

/**
 * A notice refused while the fact it reports was kept (a CTO escalation opened while no ready CEO session
 * took it): recorded with what the delivery needs, inside the caller's transaction, for
 * `retryDeferredNotices`.
 */
export const deferIncidentNotice = (ports: Pick<NoticePorts, "audit">, incident: Incident, refusal: Decision<unknown>): void => {
  const { whyItMatters, ...evidence } = incident.payload;
  ports.audit.record({
    kind: CEO_NOTIFICATION_DEFERRED,
    runId: incident.runId,
    reasonCode: refusal.reasonCode,
    evidence: {
      notification: CLASS_RULES[incident.cls].notification,
      incidentClass: incident.cls,
      subject: incident.subject,
      correlation: correlationOf(incident.cls, incident.subject),
      episode: incident.episode,
      openedEventId: incident.openedEventId ?? null,
      evidence,
      ...(typeof whyItMatters === "string" ? { detail: whyItMatters } : {}),
    },
  });
};

/** Every deferred notice whose incident is still open (`resolutionOf`), delivered once. */
export const retryDeferredNotices = (ports: NoticePorts): Array<{ correlation: string; episode: string; delivery: Decision<NoticeDelivery> }> => {
  const results: Array<{ correlation: string; episode: string; delivery: Decision<NoticeDelivery> }> = [];
  for (const row of ports.db.all<{ run_id: string | null; evidence_json: string }>(
    `SELECT run_id, evidence_json FROM audit_events WHERE kind = ? ORDER BY event_id`,
    [CEO_NOTIFICATION_DEFERRED],
  )) {
    let deferred: unknown;
    try {
      deferred = JSON.parse(row.evidence_json);
    } catch {
      continue;
    }
    if (!isRecord(deferred)) continue;
    const cls = deferred["incidentClass"];
    const subject = deferred["subject"];
    const episode = deferred["episode"];
    if (typeof cls !== "string" || !(cls in CLASS_RULES) || typeof subject !== "string" || typeof episode !== "string") continue;
    const opened = deferred["openedEventId"];
    const incident: Incident = {
      cls: cls as IncidentClass,
      subject,
      runId: row.run_id,
      episode,
      openedEventId: typeof opened === "number" ? opened : null,
      payload: {
        ...(isRecord(deferred["evidence"]) ? deferred["evidence"] : {}),
        ...(typeof deferred["detail"] === "string" ? { whyItMatters: deferred["detail"] } : {}),
      },
    };
    const status = noticeStatus(ports, incident);
    if (status.state !== "NOT_ENQUEUED") continue;
    results.push({ correlation: status.correlation, episode, delivery: deliverIncident(ports, incident) });
  }
  return results;
};

/**
 * A notification no incident states (a direct `ProductionGate.notify`): keyed by its payload, as before.
 * A refused enqueue is reported, never dropped: the caller is told and nothing claims a notice was sent.
 */
export const enqueueAdHocNotice = (
  ports: NoticePorts,
  kind: NotificationKind,
  runId: string,
  payload: Record<string, unknown>,
): Decision<void> => {
  const auditEvidence = { notification: kind, ...withoutWhy(payload) };
  const ceo = ports.bindings.active(roleKeyFor(Role.CEO));
  if (!ceo) {
    ports.audit.record({
      kind: "CEO_NOTIFICATION_BLOCKED",
      runId,
      reasonCode: ReasonCode.GATE_AUTHORITY_DENIED,
      roleKey: "CEO",
      evidence: auditEvidence,
    });
    return deny(ReasonCode.GATE_AUTHORITY_DENIED, "no CEO binding can receive notification", { runId, notification: kind });
  }
  const key = `notify:${kind}:${runId}:${digestOf(payload)}`;
  let refused: ReasonCode | null = null;
  let created = false;
  try {
    const enqueued = ports.outbox.enqueue({
      idempotencyKey: key,
      roleKey: ceo.roleKey,
      bindingGeneration: ceo.bindingGeneration,
      targetSessionId: ceo.sessionId,
      runId,
      kind: MessageKind.CEO_NOTIFICATION,
      payload: { notification: kind, runId, ...payload },
    });
    if (!enqueued.allowed) refused = enqueued.reasonCode;
    else created = enqueued.reasonCode === ReasonCode.OK;
  } catch {
    refused = ReasonCode.INTERNAL_ERROR;
  }
  if (!ports.outbox.byIdempotencyKey(key)) {
    const reasonCode = refused ?? ReasonCode.OUTBOX_TARGET_NOT_CURRENT;
    ports.audit.record({ kind: "CEO_NOTIFICATION_BLOCKED", runId, reasonCode, roleKey: ceo.roleKey, evidence: auditEvidence });
    return deny(reasonCode, "the CEO notification was not queued", { runId, notification: kind });
  }
  if (created) ports.audit.record({ kind: "CEO_NOTIFICATION", runId, roleKey: ceo.roleKey, evidence: auditEvidence });
  return allow(ReasonCode.OK, undefined);
};
