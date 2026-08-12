import type { Clock } from "../core/clock.ts";
import { isoPlus } from "../core/clock.ts";
import { type Decision, allow, deny, isAcpError } from "../core/errors.ts";
import { randomUUID } from "node:crypto";

import { newMessageId } from "../core/ids.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { AuditLog } from "../db/audit.ts";
import type { Db } from "../db/database.ts";
import { FailureClass as FailureClassCode, type FailureClass } from "../domain/types.ts";
import {
  type FencedEnvelope,
  type MessageKind,
  RETARGETABLE_KINDS,
  payloadDigestOf,
} from "./envelope.ts";

export interface EnqueueInput {
  idempotencyKey: string;
  roleKey: string;
  bindingGeneration: number;
  targetSessionId: string;
  runId?: string | null;
  kind: MessageKind;
  payload: unknown;
  ttlMs?: number;
}

export interface OutboxMessage extends FencedEnvelope {
  kind: MessageKind;
  payload: unknown;
  status: "PENDING" | "IN_FLIGHT" | "SENT" | "ACKED" | "REJECTED" | "EXPIRED";
  idempotencyKey: string;
  /** Immutable identity of the original enqueue request, retained across retargeting. */
  requestFingerprint: string | null;
  attempts: number;
  createdAt: string;
}

export interface DeliveryFailure {
  failureClass: FailureClass;
  retryable: boolean;
  error: string;
}

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const MAX_RETRY_DELAY_MS = 30 * 60 * 1000;
const RETRYABLE_FAILURE_CLASSES: ReadonlySet<FailureClass> = new Set([
  "transient",
  "capacity",
  "infrastructure",
]);
const KNOWN_FAILURE_CLASSES: ReadonlySet<string> = new Set(Object.values(FailureClassCode));

/**
 * Durable, fenced message queue (PRD §15.7, §27.5, §34.1).
 *
 * Enqueue happens inside the same transaction as the state change that justified the
 * message (§30.3), so a crash can never leave a dispatched run without its dispatch
 * message or vice versa.
 */
export class Outbox {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly audit: AuditLog,
  ) {}

  /**
   * Idempotent by key. A repeated enqueue returns the existing message instead of
   * producing a duplicate dispatch (§34.1).
   */
  enqueue(input: EnqueueInput): Decision<OutboxMessage> {
    try {
      return this.db.tx(() => this.enqueueInTx(input));
    } catch (err) {
      if (isAcpError(err) && err.reasonCode === ReasonCode.OUTBOX_DUPLICATE_SUPPRESSED) {
        const raced = this.byIdempotencyKey(input.idempotencyKey);
        if (raced) return this.replayDecision(raced, input);
      }
      throw err;
    }
  }

  private enqueueInTx(input: EnqueueInput): Decision<OutboxMessage> {
    const existing = this.byIdempotencyKey(input.idempotencyKey);
    if (existing) return this.replayDecision(existing, input);

    if (!this.isCurrentTarget(input.roleKey, input.bindingGeneration, input.targetSessionId)) {
      return deny(
        ReasonCode.OUTBOX_TARGET_NOT_CURRENT,
        "outbox target is not the ready session holding the requested role generation",
        {
          roleKey: input.roleKey,
          bindingGeneration: input.bindingGeneration,
          targetSessionId: input.targetSessionId,
        },
      );
    }

    const now = this.clock.nowIso();
    const requestFingerprint = requestFingerprintOf(input);
    const withFingerprint = this.hasColumn("request_fingerprint");
    const message: OutboxMessage = {
      messageId: newMessageId(),
      idempotencyKey: input.idempotencyKey,
      roleKey: input.roleKey,
      bindingGeneration: input.bindingGeneration,
      targetSessionId: input.targetSessionId,
      runId: input.runId ?? null,
      kind: input.kind,
      payload: input.payload,
      payloadDigest: payloadDigestOf(input.payload),
      requestFingerprint: withFingerprint ? requestFingerprint : null,
      expiresAt: isoPlus(now, input.ttlMs ?? DEFAULT_TTL_MS),
      status: "PENDING",
      attempts: 0,
      createdAt: now,
    };
    this.db.run(
      withFingerprint
        ? `INSERT INTO outbox (message_id, idempotency_key, role_key, binding_generation,
                               target_session_id, run_id, kind, payload_json, payload_digest,
                               request_fingerprint, expires_at, created_at, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')`
        : `INSERT INTO outbox (message_id, idempotency_key, role_key, binding_generation,
                               target_session_id, run_id, kind, payload_json, payload_digest,
                               expires_at, created_at, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')`,
      withFingerprint
        ? [
            message.messageId,
            message.idempotencyKey,
            message.roleKey,
            message.bindingGeneration,
            message.targetSessionId,
            message.runId,
            message.kind,
            JSON.stringify(message.payload),
            message.payloadDigest,
            requestFingerprint,
            message.expiresAt,
            message.createdAt,
          ]
        : [
            message.messageId,
            message.idempotencyKey,
            message.roleKey,
            message.bindingGeneration,
            message.targetSessionId,
            message.runId,
            message.kind,
            JSON.stringify(message.payload),
            message.payloadDigest,
            message.expiresAt,
            message.createdAt,
          ],
    );
    return allow(ReasonCode.OK, message);
  }

  private replayDecision(existing: OutboxMessage, input: EnqueueInput): Decision<OutboxMessage> {
    const matches =
      existing.requestFingerprint === requestFingerprintOf(input) ||
      (!this.hasColumn("request_fingerprint") &&
        existing.roleKey === input.roleKey &&
        existing.bindingGeneration === input.bindingGeneration &&
        existing.targetSessionId === input.targetSessionId &&
        existing.runId === (input.runId ?? null) &&
        existing.kind === input.kind &&
        existing.payloadDigest === payloadDigestOf(input.payload));
    if (matches) {
      return allow(ReasonCode.OUTBOX_DUPLICATE_SUPPRESSED, existing, {
        idempotencyKey: input.idempotencyKey,
      });
    }
    return deny(
      ReasonCode.OUTBOX_PAYLOAD_DIGEST_MISMATCH,
      "idempotency key belongs to a different enqueue request",
      { idempotencyKey: input.idempotencyKey, messageId: existing.messageId },
    );
  }

  /**
   * Atomically claims deliverable messages (§34.1).
   *
   * A read-only SELECT would let two overlapping delivery loops pick the same envelope and
   * both send it. Claiming stamps a token and moves the row to IN_FLIGHT inside one
   * transaction, so a second loop sees nothing to take.
   */
  claimDeliverable(limit = 50): Array<OutboxMessage & { claimToken: string }> {
    return this.db.tx(() => {
      const now = this.clock.nowIso();
      this.expireOverdue();
      this.reclaimStaleLeases();
      const retryPredicate = this.hasRetryPolicyColumns()
        ? "AND (o.next_attempt_at IS NULL OR o.next_attempt_at <= ?)"
        : "";

      const rows = this.db.all<RawOutbox>(
        `SELECT o.* FROM outbox o
           JOIN assignments a ON a.role_key = o.role_key
                              AND a.binding_generation = o.binding_generation
                              AND a.session_id = o.target_session_id
                              AND a.status = 'ACTIVE'
           JOIN sessions s ON s.session_id = o.target_session_id
                          AND s.lifecycle IN ('READY','DRAINING')
          WHERE o.status = 'PENDING'
            AND o.expires_at > ?
            ${retryPredicate}
          ORDER BY o.created_at
          LIMIT ?`,
        this.hasRetryPolicyColumns() ? [now, now, limit] : [now, limit],
      );

      const claimed: Array<OutboxMessage & { claimToken: string }> = [];
      for (const row of rows) {
        const token = `clm_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
        const updated = this.db.run(
          `UPDATE outbox SET status = 'IN_FLIGHT', claim_token = ?, claimed_at = ?
            WHERE message_id = ? AND status = 'PENDING'
              AND EXISTS (
                SELECT 1 FROM assignments a
                  JOIN sessions s ON s.session_id = a.session_id
                 WHERE a.role_key = outbox.role_key
                   AND a.binding_generation = outbox.binding_generation
                   AND a.session_id = outbox.target_session_id
                   AND a.status = 'ACTIVE'
                   AND s.lifecycle IN ('READY','DRAINING')
              )`,
          [token, now, row.message_id],
        );
        // Compare-and-set: another loop may have taken it between the select and here.
        if (updated.changes === 1) claimed.push({ ...hydrate(row), claimToken: token });
      }
      return claimed;
    });
  }

  /** A claim whose holder died must return to PENDING rather than stay stuck IN_FLIGHT. */
  reclaimStaleLeases(leaseMs = 5 * 60 * 1000): number {
    this.fenceUndeliverable();
    return this.db.run(
      `UPDATE outbox SET status = 'PENDING', claim_token = NULL, claimed_at = NULL
        WHERE status = 'IN_FLIGHT' AND claimed_at <= ?
          AND EXISTS (
            SELECT 1 FROM assignments a
              JOIN sessions s ON s.session_id = a.session_id
             WHERE a.role_key = outbox.role_key
               AND a.binding_generation = outbox.binding_generation
               AND a.session_id = outbox.target_session_id
               AND a.status = 'ACTIVE'
               AND s.lifecycle IN ('READY','DRAINING')
          )`,
      [new Date(new Date(this.clock.nowIso()).getTime() - leaseMs).toISOString()],
    ).changes;
  }

  /** Only the holder of the current claim may complete a delivery. */
  markSent(messageId: string, claimToken: string): Decision<void> {
    const changes = this.db.run(
      `UPDATE outbox SET status = 'SENT', sent_at = ?, attempts = attempts + 1,
                         claim_token = NULL, claimed_at = NULL
        WHERE message_id = ? AND status = 'IN_FLIGHT' AND claim_token = ?
          AND EXISTS (
            SELECT 1 FROM assignments a
              JOIN sessions s ON s.session_id = a.session_id
             WHERE a.role_key = outbox.role_key
               AND a.binding_generation = outbox.binding_generation
               AND a.session_id = outbox.target_session_id
               AND a.status = 'ACTIVE'
               AND s.lifecycle IN ('READY','DRAINING')
          )`,
      [this.clock.nowIso(), messageId, claimToken],
    ).changes;
    if (changes !== 1) {
      return deny(ReasonCode.OUTBOX_STALE_GENERATION_REJECTED, "claim is no longer held", {
        messageId,
      });
    }
    return allow(ReasonCode.OK, undefined);
  }

  markAttemptFailed(
    messageId: string,
    claimToken: string,
    failure: DeliveryFailure | string,
  ): Decision<void> {
    const classified = normalizeFailure(failure);
    if (!this.hasRetryPolicyColumns()) {
      const changes = this.db.run(
        `UPDATE outbox SET status = 'REJECTED', attempts = attempts + 1, last_error = ?,
                           reason_code = ?, claim_token = NULL, claimed_at = NULL
          WHERE message_id = ? AND status = 'IN_FLIGHT' AND claim_token = ?
            AND EXISTS (
              SELECT 1 FROM assignments a
                JOIN sessions s ON s.session_id = a.session_id
               WHERE a.role_key = outbox.role_key
                 AND a.binding_generation = outbox.binding_generation
                 AND a.session_id = outbox.target_session_id
                 AND a.status = 'ACTIVE'
                 AND s.lifecycle IN ('READY','DRAINING')
            )`,
        [classified.error.slice(0, 500), ReasonCode.OUTBOX_RETRY_POLICY_UNAVAILABLE, messageId, claimToken],
      ).changes;
      if (changes !== 1) return this.staleClaim(messageId);
      return deny(
        ReasonCode.OUTBOX_RETRY_POLICY_UNAVAILABLE,
        "delivery was terminally rejected because retry policy columns are unavailable",
        { messageId },
      );
    }

    const row = this.db.get<{
      attempts: number;
      retry_max_attempts: number;
      retry_backoff_ms: number;
    }>(
      `SELECT attempts, retry_max_attempts, retry_backoff_ms
         FROM outbox WHERE message_id = ? AND status = 'IN_FLIGHT' AND claim_token = ?`,
      [messageId, claimToken],
    );
    if (!row) return this.staleClaim(messageId);
    const attempts = row.attempts + 1;
    const retryPolicyIsValid =
      Number.isSafeInteger(row.retry_max_attempts) &&
      row.retry_max_attempts >= 0 &&
      Number.isSafeInteger(row.retry_backoff_ms) &&
      // A zero-delay retry would recreate the immediate retry loop that §34.1 forbids.
      row.retry_backoff_ms > 0;
    const retryable =
      retryPolicyIsValid &&
      classified.retryable &&
      RETRYABLE_FAILURE_CLASSES.has(classified.failureClass) &&
      attempts < row.retry_max_attempts;
    const nextAttemptAt = retryable
      ? isoPlus(this.clock.nowIso(), retryDelayMs(attempts, row.retry_backoff_ms))
      : null;
    const changes = this.db.run(
      `UPDATE outbox SET status = ?, attempts = ?, last_error = ?, failure_class = ?,
                         retry_eligible = ?, next_attempt_at = ?, reason_code = ?,
                         claim_token = NULL, claimed_at = NULL
        WHERE message_id = ? AND status = 'IN_FLIGHT' AND claim_token = ?
          AND EXISTS (
            SELECT 1 FROM assignments a
              JOIN sessions s ON s.session_id = a.session_id
             WHERE a.role_key = outbox.role_key
               AND a.binding_generation = outbox.binding_generation
               AND a.session_id = outbox.target_session_id
               AND a.status = 'ACTIVE'
               AND s.lifecycle IN ('READY','DRAINING')
          )`,
      [
        retryable ? "PENDING" : "REJECTED",
        attempts,
        classified.error.slice(0, 500),
        classified.failureClass,
        retryable ? 1 : 0,
        nextAttemptAt,
        retryable ? null : ReasonCode.OUTBOX_DELIVERY_REJECTED,
        messageId,
        claimToken,
      ],
    ).changes;
    if (changes !== 1) {
      return this.staleClaim(messageId);
    }
    if (!retryable) {
      return deny(
        ReasonCode.OUTBOX_DELIVERY_REJECTED,
        "delivery failure is not eligible for another attempt",
        {
          messageId,
          failureClass: classified.failureClass,
          attempts,
          retryMaxAttempts: row.retry_max_attempts,
          retryPolicyIsValid,
        },
      );
    }
    return allow(ReasonCode.OK, undefined);
  }

  /**
   * ACK from a runtime session. An ACK carrying a revoked or superseded generation is
   * audit-only and does not change state (§15.7, §34.4).
   */
  acknowledge(messageId: string, fromSessionId: string, generation: number): Decision<void> {
    return this.db.tx(() => this.acknowledgeInTx(messageId, fromSessionId, generation));
  }

  private acknowledgeInTx(
    messageId: string,
    fromSessionId: string,
    generation: number,
  ): Decision<void> {
    const row = this.db.get<RawOutbox>(`SELECT * FROM outbox WHERE message_id = ?`, [messageId]);
    if (!row) return deny(ReasonCode.NOT_FOUND, "unknown message", { messageId });

    // §15.7 / §34.4 — matching the stored envelope is not enough. A late ACK from a
    // generation that has since been revoked is audit-only, as is an ACK for a message
    // that has expired or was already rejected.
    const current = this.db.get<{ binding_generation: number; session_id: string }>(
      `SELECT a.binding_generation, a.session_id FROM assignments a
        JOIN sessions s ON s.session_id = a.session_id
        WHERE a.role_key = ? AND a.status = 'ACTIVE' AND s.lifecycle IN ('READY','DRAINING')`,
      [row.role_key],
    );
    const staleGeneration =
      !current ||
      current.binding_generation !== generation ||
      current.session_id !== fromSessionId;
    const ineligible =
      row.status === "REJECTED" ||
      row.status === "EXPIRED" ||
      row.status === "ACKED" ||
      row.expires_at <= this.clock.nowIso();

    if (staleGeneration || ineligible) {
      this.audit.record({
        kind: "OUTBOX_ACK_REJECTED",
        reasonCode:
          row.status === "EXPIRED" || row.expires_at <= this.clock.nowIso()
            ? ReasonCode.OUTBOX_EXPIRED
            : ReasonCode.OUTBOX_STALE_GENERATION_REJECTED,
        runId: row.run_id,
        sessionId: fromSessionId,
        roleKey: row.role_key,
        evidence: {
          messageId,
          status: row.status,
          ackGeneration: generation,
          currentGeneration: current?.binding_generation ?? null,
          currentSession: current?.session_id ?? null,
        },
      });
      return deny(
        ReasonCode.OUTBOX_STALE_GENERATION_REJECTED,
        staleGeneration
          ? "ack came from a generation that is no longer active"
          : `message is ${row.status} and cannot be acknowledged`,
        { messageId, status: row.status, ackGeneration: generation },
      );
    }

    const active = current!;

    if (
      row.target_session_id !== fromSessionId ||
      row.binding_generation !== generation ||
      active.session_id !== row.target_session_id
    ) {
      this.audit.record({
        kind: "OUTBOX_ACK_REJECTED",
        reasonCode: ReasonCode.OUTBOX_STALE_GENERATION_REJECTED,
        runId: row.run_id,
        sessionId: fromSessionId,
        roleKey: row.role_key,
        evidence: {
          messageId,
          expectedSession: row.target_session_id,
          expectedGeneration: row.binding_generation,
          gotGeneration: generation,
          activeSession: active.session_id,
        },
      });
      return deny(
        ReasonCode.OUTBOX_STALE_GENERATION_REJECTED,
        "ack came from a session/generation that does not own this message",
        { messageId, expectedGeneration: row.binding_generation, gotGeneration: generation },
      );
    }

    this.db.run(`UPDATE outbox SET status = 'ACKED', acked_at = ? WHERE message_id = ?`, [
      this.clock.nowIso(),
      messageId,
    ]);
    return allow(ReasonCode.OK, undefined);
  }

  /**
   * Called inside the failover transaction (§15.7). A delivery already claimed by the
   * revoked generation cannot be safely retargeted because the external send may have
   * started, so it is terminally fenced. Only still-pending role-level intent moves.
   */
  retargetOrReject(
    roleKey: string,
    fromGeneration: number,
    toGeneration: number,
    toSessionId: string,
  ): { retargeted: string[]; rejected: string[] } {
    const now = this.clock.nowIso();
    const pending = this.db.all<RawOutbox>(
      `SELECT * FROM outbox WHERE role_key = ? AND binding_generation = ?
        AND status IN ('PENDING','IN_FLIGHT')`,
      [roleKey, fromGeneration],
    );

    const retargeted: string[] = [];
    const rejected: string[] = [];

    for (const row of pending) {
      const retargetable =
        row.status === "PENDING" &&
        RETARGETABLE_KINDS.has(row.kind as MessageKind) &&
        row.expires_at > now;
      if (retargetable) {
        this.db.run(
          `UPDATE outbox SET binding_generation = ?, target_session_id = ?, reason_code = ?
             WHERE message_id = ?`,
          [toGeneration, toSessionId, ReasonCode.OUTBOX_RETARGETED, row.message_id],
        );
        retargeted.push(row.message_id);
      } else {
        this.db.run(
          `UPDATE outbox SET status = 'REJECTED', reason_code = ?,
                             claim_token = NULL, claimed_at = NULL
            WHERE message_id = ?`,
          [
            row.expires_at <= now
              ? ReasonCode.OUTBOX_EXPIRED
              : ReasonCode.OUTBOX_STALE_GENERATION_REJECTED,
            row.message_id,
          ],
        );
        rejected.push(row.message_id);
      }
    }

    this.audit.record({
      kind: "OUTBOX_FENCE",
      reasonCode: ReasonCode.OUTBOX_RETARGETED,
      roleKey,
      evidence: { fromGeneration, toGeneration, toSessionId, retargeted, rejected },
    });

    return { retargeted, rejected };
  }

  expireOverdue(): number {
    const result = this.db.run(
      `UPDATE outbox SET status = 'EXPIRED', reason_code = ?
        WHERE status IN ('PENDING','IN_FLIGHT') AND expires_at <= ?`,
      [ReasonCode.OUTBOX_EXPIRED, this.clock.nowIso()],
    );
    return result.changes;
  }

  byIdempotencyKey(key: string): OutboxMessage | null {
    const row = this.db.get<RawOutbox>(`SELECT * FROM outbox WHERE idempotency_key = ?`, [key]);
    return row ? hydrate(row) : null;
  }

  get(messageId: string): OutboxMessage | null {
    const row = this.db.get<RawOutbox>(`SELECT * FROM outbox WHERE message_id = ?`, [messageId]);
    return row ? hydrate(row) : null;
  }

  listByRun(runId: string): OutboxMessage[] {
    return this.db
      .all<RawOutbox>(`SELECT * FROM outbox WHERE run_id = ? ORDER BY created_at`, [runId])
      .map(hydrate);
  }

  /** Fence queued and claimed rows whose binding or target lifecycle is no longer valid. */
  fenceUndeliverable(): number {
    return this.db.run(
      `UPDATE outbox SET status = 'REJECTED', reason_code = ?, claim_token = NULL, claimed_at = NULL
        WHERE status IN ('PENDING','IN_FLIGHT')
          AND NOT EXISTS (
            SELECT 1 FROM assignments a
              JOIN sessions s ON s.session_id = a.session_id
             WHERE a.role_key = outbox.role_key
               AND a.binding_generation = outbox.binding_generation
               AND a.session_id = outbox.target_session_id
               AND a.status = 'ACTIVE'
               AND s.lifecycle IN ('READY','DRAINING')
          )`,
      [ReasonCode.OUTBOX_STALE_GENERATION_REJECTED],
    ).changes;
  }

  /**
   * A message must be fenced by a live binding, and its target must be a session that is
   * legitimately addressable under that binding.
   *
   * Usually the target *is* the holder. A handoff package is the exception §10.1 requires:
   * the outgoing binding stays in force until the ACK, so the package is addressed to the
   * incoming session, which by definition does not hold the binding yet. That case is
   * admitted only when a pending handoff from this exact generation names this session as
   * its recipient — the fence is still the outgoing binding, so a superseded generation
   * cannot send, and a session that is not READY cannot receive.
   */
  private isCurrentTarget(roleKey: string, bindingGeneration: number, sessionId: string): boolean {
    const holder = this.db.get(
      `SELECT 1 FROM assignments a
        JOIN sessions s ON s.session_id = a.session_id
        WHERE a.role_key = ? AND a.binding_generation = ? AND a.session_id = ?
          AND a.status = 'ACTIVE' AND s.lifecycle IN ('READY','DRAINING')`,
      [roleKey, bindingGeneration, sessionId],
    );
    if (holder) return true;

    return Boolean(
      this.db.get(
        `SELECT 1 FROM handoffs h
          JOIN sessions s ON s.session_id = h.to_session_id
          JOIN assignments a ON a.role_key = ? AND a.binding_generation = ?
                            AND a.session_id = h.from_session_id AND a.status = 'ACTIVE'
          WHERE h.to_session_id = ? AND h.status = 'PENDING' AND h.from_generation = ?
            AND s.lifecycle = 'READY'`,
        [roleKey, bindingGeneration, sessionId, bindingGeneration],
      ),
    );
  }

  private staleClaim(messageId: string): Decision<void> {
    return deny(ReasonCode.OUTBOX_STALE_GENERATION_REJECTED, "claim is no longer current", {
      messageId,
    });
  }

  private hasRetryPolicyColumns(): boolean {
    return ["failure_class", "retry_eligible", "next_attempt_at"].every((column) =>
      this.hasColumn(column),
    );
  }

  private hasColumn(column: string): boolean {
    return this.db
      .all<{ name: string }>(`SELECT name FROM pragma_table_info('outbox') WHERE name = ?`, [column])
      .length === 1;
  }
}

interface RawOutbox {
  message_id: string;
  idempotency_key: string;
  role_key: string;
  binding_generation: number;
  target_session_id: string;
  run_id: string | null;
  kind: string;
  payload_json: string;
  payload_digest: string;
  request_fingerprint?: string | null;
  expires_at: string;
  created_at: string;
  status: OutboxMessage["status"];
  attempts: number;
}

const hydrate = (row: RawOutbox): OutboxMessage => ({
  messageId: row.message_id,
  idempotencyKey: row.idempotency_key,
  requestFingerprint: row.request_fingerprint ?? null,
  roleKey: row.role_key,
  bindingGeneration: row.binding_generation,
  targetSessionId: row.target_session_id,
  runId: row.run_id,
  kind: row.kind as MessageKind,
  payload: JSON.parse(row.payload_json) as unknown,
  payloadDigest: row.payload_digest,
  expiresAt: row.expires_at,
  status: row.status,
  attempts: row.attempts,
  createdAt: row.created_at,
});

const requestFingerprintOf = (input: EnqueueInput): string =>
  payloadDigestOf({
    roleKey: input.roleKey,
    bindingGeneration: input.bindingGeneration,
    targetSessionId: input.targetSessionId,
    runId: input.runId ?? null,
    kind: input.kind,
    payloadDigest: payloadDigestOf(input.payload),
  });

const normalizeFailure = (failure: DeliveryFailure | string): DeliveryFailure =>
  typeof failure === "string" ||
  !KNOWN_FAILURE_CLASSES.has(failure.failureClass) ||
  typeof failure.error !== "string"
    ? {
        failureClass: "unknown_observed",
        retryable: false,
        error: typeof failure === "string" ? failure : "delivery failure classification is invalid",
      }
    : {
        failureClass: failure.failureClass,
        retryable: failure.retryable === true,
        error: failure.error,
      };

const retryDelayMs = (attempts: number, baseDelayMs: number): number =>
  Math.min(baseDelayMs * 2 ** Math.max(0, attempts - 1), MAX_RETRY_DELAY_MS);
