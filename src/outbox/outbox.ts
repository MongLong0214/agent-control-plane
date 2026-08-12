import type { Clock } from "../core/clock.ts";
import { isoPlus } from "../core/clock.ts";
import { type Decision, allow, deny, isAcpError } from "../core/errors.ts";
import { randomUUID } from "node:crypto";

import { newMessageId } from "../core/ids.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { AuditLog } from "../db/audit.ts";
import type { Db } from "../db/database.ts";
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
  status: "PENDING" | "IN_FLIGHT" | "SENT" | "ACKED" | "REJECTED" | "EXPIRED" | "RETARGETED";
  idempotencyKey: string;
  attempts: number;
  createdAt: string;
}

const DEFAULT_TTL_MS = 30 * 60 * 1000;

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
    const existing = this.byIdempotencyKey(input.idempotencyKey);
    if (existing) {
      return allow(ReasonCode.OUTBOX_DUPLICATE_SUPPRESSED, existing, {
        idempotencyKey: input.idempotencyKey,
      });
    }

    const now = this.clock.nowIso();
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
      expiresAt: isoPlus(now, input.ttlMs ?? DEFAULT_TTL_MS),
      status: "PENDING",
      attempts: 0,
      createdAt: now,
    };

    try {
      this.db.run(
        `INSERT INTO outbox (message_id, idempotency_key, role_key, binding_generation,
                             target_session_id, run_id, kind, payload_json, payload_digest,
                             expires_at, created_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')`,
        [
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
    } catch (err) {
      if (isAcpError(err) && err.reasonCode === ReasonCode.OUTBOX_DUPLICATE_SUPPRESSED) {
        const raced = this.byIdempotencyKey(input.idempotencyKey);
        if (raced) return allow(ReasonCode.OUTBOX_DUPLICATE_SUPPRESSED, raced);
      }
      throw err;
    }
    return allow(ReasonCode.OK, message);
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

      const rows = this.db.all<RawOutbox>(
        `SELECT o.* FROM outbox o
           JOIN assignments a ON a.role_key = o.role_key AND a.status = 'ACTIVE'
          WHERE o.status = 'PENDING'
            AND o.expires_at > ?
            AND a.binding_generation = o.binding_generation
          ORDER BY o.created_at
          LIMIT ?`,
        [now, limit],
      );

      const claimed: Array<OutboxMessage & { claimToken: string }> = [];
      for (const row of rows) {
        const token = `clm_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
        const updated = this.db.run(
          `UPDATE outbox SET status = 'IN_FLIGHT', claim_token = ?, claimed_at = ?
            WHERE message_id = ? AND status = 'PENDING'`,
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
    return this.db.run(
      `UPDATE outbox SET status = 'PENDING', claim_token = NULL, claimed_at = NULL
        WHERE status = 'IN_FLIGHT' AND claimed_at <= ?`,
      [new Date(new Date(this.clock.nowIso()).getTime() - leaseMs).toISOString()],
    ).changes;
  }

  /** Only the holder of the current claim may complete a delivery. */
  markSent(messageId: string, claimToken: string): Decision<void> {
    const changes = this.db.run(
      `UPDATE outbox SET status = 'SENT', sent_at = ?, attempts = attempts + 1,
                         claim_token = NULL, claimed_at = NULL
        WHERE message_id = ? AND status = 'IN_FLIGHT' AND claim_token = ?`,
      [this.clock.nowIso(), messageId, claimToken],
    ).changes;
    if (changes !== 1) {
      return deny(ReasonCode.OUTBOX_STALE_GENERATION_REJECTED, "claim is no longer held", {
        messageId,
      });
    }
    return allow(ReasonCode.OK, undefined);
  }

  markAttemptFailed(messageId: string, claimToken: string, error: string): Decision<void> {
    const changes = this.db.run(
      `UPDATE outbox SET status = 'PENDING', attempts = attempts + 1, last_error = ?,
                         claim_token = NULL, claimed_at = NULL
        WHERE message_id = ? AND status = 'IN_FLIGHT' AND claim_token = ?`,
      [error.slice(0, 500), messageId, claimToken],
    ).changes;
    if (changes !== 1) {
      return deny(ReasonCode.OUTBOX_STALE_GENERATION_REJECTED, "claim is no longer held", {
        messageId,
      });
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
    const current = this.db.get<{ binding_generation: number }>(
      `SELECT binding_generation FROM assignments WHERE role_key = ? AND status = 'ACTIVE'`,
      [row.role_key],
    );
    const staleGeneration = !current || current.binding_generation !== generation;
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

    if (row.target_session_id !== fromSessionId || row.binding_generation !== generation) {
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
   * Called inside the failover transaction (§15.7). Pending messages for the old
   * generation are either deterministically retargeted onto the new binding or
   * rejected as stale — never left addressed to a revoked generation.
   */
  retargetOrReject(
    roleKey: string,
    fromGeneration: number,
    toGeneration: number,
    toSessionId: string,
  ): { retargeted: string[]; rejected: string[] } {
    const now = this.clock.nowIso();
    const pending = this.db.all<RawOutbox>(
      `SELECT * FROM outbox WHERE role_key = ? AND binding_generation = ? AND status = 'PENDING'`,
      [roleKey, fromGeneration],
    );

    const retargeted: string[] = [];
    const rejected: string[] = [];

    for (const row of pending) {
      const retargetable =
        RETARGETABLE_KINDS.has(row.kind as MessageKind) && row.expires_at > now;
      if (retargetable) {
        this.db.run(
          `UPDATE outbox SET binding_generation = ?, target_session_id = ?, reason_code = ?
             WHERE message_id = ?`,
          [toGeneration, toSessionId, ReasonCode.OUTBOX_RETARGETED, row.message_id],
        );
        retargeted.push(row.message_id);
      } else {
        this.db.run(`UPDATE outbox SET status = 'REJECTED', reason_code = ? WHERE message_id = ?`, [
          row.expires_at <= now ? ReasonCode.OUTBOX_EXPIRED : ReasonCode.OUTBOX_STALE_GENERATION_REJECTED,
          row.message_id,
        ]);
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
        WHERE status = 'PENDING' AND expires_at <= ?`,
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
  expires_at: string;
  created_at: string;
  status: OutboxMessage["status"];
  attempts: number;
}

const hydrate = (row: RawOutbox): OutboxMessage => ({
  messageId: row.message_id,
  idempotencyKey: row.idempotency_key,
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
