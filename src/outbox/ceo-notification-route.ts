import { randomUUID } from "node:crypto";

import { digestOf, sha256 } from "../core/digest.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { AuditLog } from "../db/audit.ts";
import type { Db } from "../db/database.ts";
import type { DaemonNoticeBody, DaemonNoticeDestination } from "../runtime/acp-daemon-notice.ts";
import type { OutboxMessage } from "./outbox.ts";

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
}

/**
 * The append-only audit log is the attempt journal. Intent precedes HTTP, so a crash or lost
 * response leaves an unknown attempt, never proof of non-delivery. A later parser refusal cannot
 * resolve it: Hermes parses before looking up the event-id receipt. Only a matching completed
 * receipt resolves an unknown attempt. No aggregate failure count authorizes a route change.
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

  prepare(destination: DaemonNoticeDestination, requests: DaemonNoticeBody[]): ReturnType<CeoNoticeAttempt["prepare"]> {
    return this.db.tx(() => {
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
      const history = this.db.all<{ kind: string; evidence_json: string }>(
        `SELECT kind, evidence_json FROM audit_events WHERE kind IN
          ('CEO_NOTIFICATION_CANONICAL_ATTEMPT','CEO_NOTIFICATION_CANONICAL_RESULT')
          AND json_extract(evidence_json, '$.messageId') = ? ORDER BY rowid`, [this.message.messageId],
      );
      const attempts = history.filter((e) => e.kind === "CEO_NOTIFICATION_CANONICAL_ATTEMPT")
        .map((e) => JSON.parse(e.evidence_json) as AttemptRecord);
      const results = history.filter((e) => e.kind === "CEO_NOTIFICATION_CANONICAL_RESULT")
        .map((e) => JSON.parse(e.evidence_json) as { attemptId: string; outcome: CeoNoticeOutcome });
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
      const support = this.db.get<{ evidence_json: string; at: string }>(`SELECT evidence_json, at FROM audit_events
        WHERE kind = 'CEO_NOTIFICATION_PROTOCOL_SUPPORT'
          AND json_extract(evidence_json, '$.receiver') = ? ORDER BY rowid DESC LIMIT 1`, [receiver]);
      // The existing authenticated daemon-notice probe is also support evidence. A newer matching
      // completed receipt permits withheld canonical rows to resume their original receipt lookup.
      const recovered = support && this.db.get(`SELECT 1 FROM peer_message_notice_deliveries settled
        JOIN peer_message_notice_deliveries intent ON intent.event_id = settled.event_id AND intent.entry = 'IN_DOUBT'
        WHERE settled.entry = 'SETTLED' AND settled.created_at > ?
          AND json_extract(intent.canonical_json, '$.destination.session_id') = ?
          AND json_extract(intent.canonical_json, '$.destination.lineage_root_digest') = ?
          AND json_extract(intent.canonical_json, '$.destination.process_pid') = ?
          AND json_extract(intent.canonical_json, '$.destination.process_started_at') = ?`,
      [support.at, destination.session_id, destination.lineage_root_digest,
        destination.process_pid, destination.process_started_at]);
      const unsupported = support && JSON.parse(support.evidence_json).support === "UNSUPPORTED" && !recovered;
      const supported = recovered || (support && JSON.parse(support.evidence_json).support === "SUPPORTED");
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
      // Unknown attempts are receipt lookups only: neither a moving target nor a changed payload
      // permits a fresh canonical send. Keep the exact event ids AND sealed bytes across restart.
      const requestDigests = requests.map((r) => ({ eventId: r.event_id, payloadDigest: r.payload_digest,
        bodyDigest: sha256(JSON.stringify(r)) }));
      if (last && (last.receiver !== receiver || JSON.stringify(last.requests) !== JSON.stringify(requestDigests))) {
        this.route = "WITHHELD";
        return { route: "WITHHELD" };
      }
      const attempt = { attemptId: randomUUID(), receiver, requests: requestDigests, legacyUnknown };
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
