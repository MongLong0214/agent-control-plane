import { randomUUID } from "node:crypto";

import { digestOf, sha256 } from "../core/digest.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { AuditLog } from "../db/audit.ts";
import type { Db } from "../db/database.ts";
import type { DaemonNoticeBody, DaemonNoticeDestination } from "../runtime/acp-daemon-notice.ts";
import type { OutboxMessage } from "./outbox.ts";
import { readHermesTargetHead } from "../session/hermes-target-head.ts";

export interface CeoNoticeAttempt {
  /** Called synchronously before the first POST. Checks retries against hashes of the exact bytes. */
  prepare(destination: DaemonNoticeDestination, requests: DaemonNoticeBody[]):
    | { route: "CANONICAL"; requests: DaemonNoticeBody[] }
    | { route: "BUZZ" | "WITHHELD" };
}

export type CeoNoticeOutcome = "REFUSED" | "UNKNOWN" | "NOT_SENT" | "SETTLED";

/** A route grant names the exact current holder; it is never inferred from a configuration flag. */
export const ceoBuzzGrantSql = (alias: "o" | "outbox"): string => `EXISTS (
  SELECT 1 FROM audit_events ceo_route WHERE ceo_route.kind = 'CEO_NOTIFICATION_BUZZ_ROUTE'
    AND json_extract(ceo_route.evidence_json, '$.messageId') = ${alias}.message_id
    AND json_extract(ceo_route.evidence_json, '$.targetSessionId') = ${alias}.target_session_id
    AND json_extract(ceo_route.evidence_json, '$.bindingGeneration') = ${alias}.binding_generation
)`;

interface AttemptRecord {
  attemptId: string;
  receiver: string;
  requests: { eventId: string; payloadDigest: string; bodyDigest: string }[];
  legacyUnknown: boolean;
  requestCount?: number;
  manifestDigest?: string;
}

/** Commit support beside a completed notice/probe receipt, in audit order even when clocks tie. */
export const recordCeoNoticeReceiptSupport = (db: Db, audit: AuditLog, eventId: string): void => {
  const intent = db.get<{ canonical_json: string }>(`SELECT canonical_json FROM peer_message_notice_deliveries
    WHERE event_id = ? AND entry = 'IN_DOUBT'`, [eventId]);
  if (!intent) throw new Error("completed notice has no canonical intent");
  const destination = JSON.parse(intent.canonical_json).destination as DaemonNoticeDestination;
  const recorded = audit.record({ kind: "CEO_NOTIFICATION_PROTOCOL_SUPPORT", reasonCode: ReasonCode.OK,
    evidence: { receiver: digestOf(destination), support: "SUPPORTED", supportEventId: eventId } });
  if (!recorded.allowed) throw new Error("receipt support evidence was not recorded");
};

/**
 * The append-only audit log is the attempt journal. Intent precedes HTTP, so a crash or lost
 * response leaves an unknown attempt, never proof of non-delivery. A later parser refusal cannot
 * resolve it: Hermes parses before looking up the event-id receipt. Legacy rows stay held; only
 * journaled attempts can use a verified receiver's receipt lookup. No decision or aggregate failure
 * count is evidence of non-delivery.
 */
export class CeoNoticeRoute implements CeoNoticeAttempt {
  #attempt: AttemptRecord | null = null;
  route: "CANONICAL" | "BUZZ" | "WITHHELD" = "CANONICAL";

  constructor(private db: Db, private audit: AuditLog, private message: OutboxMessage) {}

  #record(kind: string, evidence: Record<string, unknown>, failed = false): void {
    const recorded = this.audit.record({ kind, reasonCode: failed ? ReasonCode.CEO_CONVERSATION_TRANSPORT_FAILED : ReasonCode.OK,
      roleKey: this.message.roleKey, sessionId: this.message.targetSessionId, runId: this.message.runId,
      evidence: { messageId: this.message.messageId, targetSessionId: this.message.targetSessionId,
        bindingGeneration: this.message.bindingGeneration, ...evidence } });
    if (!recorded.allowed) throw new Error("CEO notice route evidence was not recorded");
  }

  #grantBuzz(evidence: Record<string, unknown>): { route: "BUZZ" } {
    this.#record("CEO_NOTIFICATION_BUZZ_ROUTE", evidence);
    this.route = "BUZZ";
    return { route: "BUZZ" };
  }

  #history() {
    const history = this.db.all<{ kind: string; evidence_json: string }>(
      `SELECT kind, evidence_json FROM audit_events WHERE kind IN
        ('CEO_NOTIFICATION_CANONICAL_ATTEMPT','CEO_NOTIFICATION_CANONICAL_RESULT')
        AND json_extract(evidence_json, '$.messageId') = ? ORDER BY rowid`, [this.message.messageId]);
    return {
      attempts: history.filter((e) => e.kind === "CEO_NOTIFICATION_CANONICAL_ATTEMPT")
        .map((e) => JSON.parse(e.evidence_json) as AttemptRecord),
      results: history.filter((e) => e.kind === "CEO_NOTIFICATION_CANONICAL_RESULT")
        .map((e) => JSON.parse(e.evidence_json) as { attemptId: string; outcome: CeoNoticeOutcome }),
    };
  }

  #support(receiver: string): "SUPPORTED" | "UNSUPPORTED" | "UNVERIFIED" {
    const support = this.db.get<{ evidence_json: string; at: string }>(`SELECT evidence_json, at FROM audit_events
      WHERE kind = 'CEO_NOTIFICATION_PROTOCOL_SUPPORT'
        AND json_extract(evidence_json, '$.receiver') = ? ORDER BY rowid DESC LIMIT 1`, [receiver]);
    if (support && JSON.parse(support.evidence_json).support === "SUPPORTED") return "SUPPORTED";
    // Read existing completed daemon-notice receipts; never send a notification to probe support.
    const receipts = this.db.all<{ canonical_json: string }>(`SELECT intent.canonical_json
      FROM peer_message_notice_deliveries settled
      JOIN peer_message_notice_deliveries intent ON intent.event_id = settled.event_id AND intent.entry = 'IN_DOUBT'
      WHERE settled.entry = 'SETTLED' AND settled.created_at > ?
        AND NOT EXISTS (SELECT 1 FROM audit_events e WHERE e.kind = 'CEO_NOTIFICATION_PROTOCOL_SUPPORT'
          AND json_extract(e.evidence_json, '$.supportEventId') = settled.event_id)`, [support?.at ?? ""]);
    if (receipts.some((r) => digestOf(JSON.parse(r.canonical_json).destination) === receiver)) return "SUPPORTED";
    return support ? "UNSUPPORTED" : "UNVERIFIED";
  }

  /** Verify the current actor/session/room locally; Gateway discovery is not Buzz authority. */
  #localBuzzRoute(): { receiver: string | null } | null {
    const current = this.db.get<{ actor_id: string; os_pid: number | null; pin: string | null }>(
      `SELECT actor.actor_id, s.os_pid,
          (SELECT e.evidence_json FROM audit_events e WHERE e.kind = 'SESSION_NATIVE_START_PINNED'
             AND e.session_id = s.session_id ORDER BY e.event_id LIMIT 1) AS pin
       FROM outbox o JOIN assignments a ON a.role_key = o.role_key AND a.binding_generation = o.binding_generation
       JOIN conversational_actors actor ON actor.actor_id = a.actor_id AND actor.current_session_id = o.target_session_id
       JOIN sessions s ON s.session_id = actor.current_session_id AND s.incarnation = actor.current_session_incarnation
       WHERE o.message_id = ? AND o.status = 'PENDING' AND a.status = 'ACTIVE'
         AND o.target_session_id = ? AND o.binding_generation = ? AND s.lifecycle IN ('READY','DRAINING')
         AND COALESCE(s.buzz_address, '') <> '' AND COALESCE(s.buzz_actor_id, '') <> ''`,
      [this.message.messageId, this.message.targetSessionId, this.message.bindingGeneration]);
    if (!current) return null;
    const target = readHermesTargetHead(this.db, current.actor_id);
    const startedAt: unknown = current.pin ? JSON.parse(current.pin).startedAt : null;
    const receiver = target?.executorKind === "hermes" && current.os_pid && typeof startedAt === "string"
      ? digestOf({ session_id: target.head, lineage_root_digest: target.lineageRootDigest,
        process_pid: current.os_pid, process_started_at: startedAt }) : null;
    return { receiver };
  }

  /** Stop canonical dispatch before identity HTTP for held rows or locally verified Buzz mail. */
  withholdBeforeSend(): boolean {
    return this.db.tx(() => {
      const { attempts, results } = this.#history();
      const marked = this.db.get(`SELECT 1 FROM audit_events WHERE kind = 'CEO_NOTIFICATION_LEGACY_OUTCOME_UNKNOWN'
        AND json_extract(evidence_json, '$.messageId') = ?`, [this.message.messageId]);
      const legacyFailure = !attempts.length && (this.message.attempts > 0 || this.db.get(`SELECT 1 FROM audit_events
        WHERE kind = 'CEO_NOTIFICATION_DELIVERY_FAILED' AND json_extract(evidence_json, '$.messageId') = ?`, [this.message.messageId]));
      if (marked || legacyFailure || attempts.some((a) => a.legacyUnknown)) {
        if (!marked) this.#record("CEO_NOTIFICATION_LEGACY_OUTCOME_UNKNOWN", { basis: "PREDATES_ATTEMPT_JOURNAL" }, true);
        this.route = "WITHHELD";
        return true;
      }
      const unknown = attempts.some((a) => {
        const result = results.find((r) => r.attemptId === a.attemptId);
        return !result || result.outcome === "UNKNOWN" || result.outcome === "SETTLED";
      });
      if (unknown && this.#support(attempts.at(-1)!.receiver) !== "SUPPORTED") {
        this.route = "WITHHELD";
        return true;
      }
      if (!unknown) {
        const buzz = this.#localBuzzRoute();
        if (buzz && (!buzz.receiver || this.#support(buzz.receiver) !== "SUPPORTED")) {
          this.#grantBuzz({ receiver: buzz.receiver, basis: attempts.length ? "PER_ROW_NO_DELIVERY" : "UNSENT_SUPPORT_UNVERIFIED" });
          return true;
        }
      }
      return false;
    });
  }

  prepare(destination: DaemonNoticeDestination, requests: DaemonNoticeBody[]): ReturnType<CeoNoticeAttempt["prepare"]> {
    return this.db.tx(() => {
      if (this.withholdBeforeSend()) return { route: "WITHHELD" };
      const current = this.db.get<{ status: string; target_session_id: string; binding_generation: number; buzz_granted: number }>(
        `SELECT o.status, o.target_session_id, o.binding_generation, ${ceoBuzzGrantSql("o")} AS buzz_granted FROM outbox o
          JOIN assignments a ON a.role_key = o.role_key AND a.binding_generation = o.binding_generation AND a.status = 'ACTIVE'
          JOIN conversational_actors actor ON actor.actor_id = a.actor_id AND actor.current_session_id = o.target_session_id
          JOIN sessions s ON s.session_id = o.target_session_id AND s.lifecycle IN ('READY','DRAINING')
          WHERE o.message_id = ?`, [this.message.messageId]);
      if (current?.status !== "PENDING" || current.target_session_id !== this.message.targetSessionId ||
          current.binding_generation !== this.message.bindingGeneration) {
        this.route = "WITHHELD";
        return { route: "WITHHELD" };
      }
      if (current.buzz_granted === 1) { this.route = "BUZZ"; return { route: "BUZZ" }; }
      const receiver = digestOf(destination);
      const { attempts, results } = this.#history();
      const last = attempts.at(-1);
      const lastResult = results.find((r) => r.attemptId === last?.attemptId);
      // Existing pre-journal attempts (the live backlog) cannot be classified from their counts.
      const legacyFailure = this.db.get(`SELECT 1 FROM audit_events
        WHERE kind IN ('CEO_NOTIFICATION_DELIVERY_FAILED','CEO_NOTIFICATION_LEGACY_OUTCOME_UNKNOWN')
        AND json_extract(evidence_json, '$.messageId') = ?`, [this.message.messageId]);
      const legacyUnknown = attempts.some((a) => a.legacyUnknown) || (!last && (this.message.attempts > 0 || !!legacyFailure));
      const unknown = legacyUnknown || attempts.some((a) => {
        const result = results.find((r) => r.attemptId === a.attemptId);
        return !result || result.outcome === "UNKNOWN" || result.outcome === "SETTLED";
      });
      const receiverSupport = this.#support(receiver);
      const unsupported = receiverSupport === "UNSUPPORTED";
      const supported = receiverSupport === "SUPPORTED";
      const buzzBound = this.db.get(`SELECT 1 FROM sessions WHERE session_id = ?
        AND COALESCE(buzz_address, '') <> '' AND COALESCE(buzz_actor_id, '') <> ''`, [this.message.targetSessionId]);

      // Configuration is no support proof. Unsent mail uses the verified existing Buzz binding
      // while support is unverified, and never probes a receiver already known to be unsupported.
      if (!unknown && (unsupported || (!supported && buzzBound))) {
        return this.#grantBuzz({ receiver,
          basis: last ? "PER_ROW_NO_DELIVERY" : unsupported ? "UNSENT_UNSUPPORTED" : "UNSENT_SUPPORT_UNVERIFIED",
          ...(last ? { attemptId: last.attemptId } : {}) });
      }
      if (lastResult?.outcome === "REFUSED" && unsupported) {
        this.route = "WITHHELD";
        return { route: "WITHHELD" };
      }
      // Existing ACP-R2-01 / v51 in-doubt receipt lookup: verified receiver support plus the same
      // event ids AND sealed bytes. Hermes returns the event-id receipt rather than consuming twice.
      const requestDigests = requests.map((r) => ({ eventId: r.event_id, payloadDigest: r.payload_digest,
        bodyDigest: sha256(JSON.stringify(r)) }));
      const requestCount = requestDigests.length;
      const manifestDigest = sha256(JSON.stringify(requestDigests));
      // Old manifests at the audit limit may have lost entries; they cannot prove byte identity.
      const sameManifest = !last || (last.manifestDigest
        ? last.requestCount === requestCount && last.manifestDigest === manifestDigest
        : last.requests.length < 200 && JSON.stringify(last.requests) === JSON.stringify(requestDigests));
      if (last && (last.receiver !== receiver || !sameManifest)) {
        this.route = "WITHHELD";
        return { route: "WITHHELD" };
      }
      const attempt = { attemptId: randomUUID(), receiver, requests: requestDigests, requestCount, manifestDigest, legacyUnknown };
      this.#record("CEO_NOTIFICATION_CANONICAL_ATTEMPT", attempt);
      this.#attempt = attempt;
      return { route: "CANONICAL", requests };
    });
  }

  /** Called in the same transaction as the outbox result; the sweep sees the grant only after it. */
  finish(outcome: CeoNoticeOutcome): void {
    if (!this.#attempt) return;
    const attempt = this.#attempt;
    this.#record("CEO_NOTIFICATION_CANONICAL_RESULT", { attemptId: attempt.attemptId,
      receiver: attempt.receiver, outcome,
      requests: attempt.requests,
      requestCount: attempt.requestCount, manifestDigest: attempt.manifestDigest,
      ...(outcome === "REFUSED" ? { status: 400, code: "canonical_invalid_request", preClaim: true } : {}),
    }, outcome !== "SETTLED" && outcome !== "NOT_SENT");
    if (outcome === "REFUSED" || outcome === "SETTLED") {
      this.#record("CEO_NOTIFICATION_PROTOCOL_SUPPORT", { receiver: attempt.receiver,
        support: outcome === "REFUSED" ? "UNSUPPORTED" : "SUPPORTED", attemptId: attempt.attemptId });
    }
    if (outcome !== "REFUSED") return;
    const unresolved = this.db.get(`SELECT 1 FROM audit_events intent
      WHERE intent.kind = 'CEO_NOTIFICATION_CANONICAL_ATTEMPT'
        AND json_extract(intent.evidence_json, '$.messageId') = ?
        AND (json_extract(intent.evidence_json, '$.legacyUnknown') = 1 OR NOT EXISTS (
          SELECT 1 FROM audit_events result WHERE result.kind = 'CEO_NOTIFICATION_CANONICAL_RESULT'
            AND json_extract(result.evidence_json, '$.attemptId') = json_extract(intent.evidence_json, '$.attemptId')
            AND json_extract(result.evidence_json, '$.outcome') IN ('REFUSED','NOT_SENT')))`, [this.message.messageId]);
    if (!unresolved) this.#grantBuzz({ receiver: attempt.receiver, basis: "PER_ROW_PRECLAIM_REFUSAL", attemptId: attempt.attemptId });
  }
}
