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
  HOLDER_CLAIMED_KINDS,
  MessageKind,
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
  requestFingerprint: string;
  attempts: number;
  /** Durable classification of the last failed delivery attempt (§34.1). */
  failureClass: FailureClass | null;
  /** Whether the recorded failure admits another attempt. */
  retryEligible: boolean;
  /** Earliest instant a deferred retry may be claimed; null when nothing is deferred. */
  nextAttemptAt: string | null;
  createdAt: string;
}

/**
 * Who is claiming — every field read from the authenticated connection, none from the row.
 *
 * `sessionIncarnation` is the field that makes this an identity rather than an address. The other
 * three are already on the outbox row, so a predicate built from them alone can be satisfied by
 * any runtime that happens to occupy the same binding; the incarnation is what a respawn changes.
 */
export interface HolderIdentity {
  roleKey: string;
  bindingGeneration: number;
  targetSessionId: string;
  sessionIncarnation: string;
}

/**
 * A message handed over to a previous holder whose outcome was never recorded.
 *
 * **There is deliberately no `payload` field.** "Never the payload twice" is enforced by this type
 * having nowhere to put one, rather than by every call site remembering not to. A successor sees
 * that something was taken and not acknowledged, which is what it needs to reconcile, and learns
 * nothing about what it said.
 */
export interface UnresolvedOwnerMessage {
  messageId: string;
  roleKey: string;
  bindingGeneration: number;
  targetSessionId: string;
  kind: MessageKind;
  payloadDigest: string;
  sentAt: string | null;
  attempts: number;
  createdAt: string;
}

export interface HolderClaimResult {
  /**
   * The row this call moved `PENDING -> SENT`, and the only thing here that carries a payload.
   *
   * At most one, and an array rather than a nullable single because the caller's shape should not
   * have to change if a future kind is drained differently.
   */
  claimed: OutboxMessage[];
  /** Rows already `SENT` and never acknowledged. Metadata only. */
  unresolved: UnresolvedOwnerMessage[];
  /**
   * Whether a claimable message remains that this call did not hand over.
   *
   * This is how the holder drains a backlog: it wakes again rather than asking for a batch. It is
   * also true while `unresolved` is blocking the queue, which is the honest answer — there is work
   * waiting, and settling the unknown outcome is what releases it.
   */
  hasMore: boolean;
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
 * The ordinary recipient must still hold the exact active binding. The only exception is
 * the §10.1 handoff package: its recipient is deliberately unbound until that recipient
 * presents the delivered envelope and the binding generation switches. Keep the exception
 * in the delivery predicates as well as enqueue admission; otherwise a valid package can
 * be persisted but can never be claimed or marked SENT.
 */
/**
 * The literal list the generic sweep excludes, built from `HOLDER_CLAIMED_KINDS`.
 *
 * Derived from the set rather than written out here, so the exclusion cannot drift away from the
 * set that defines it. Kind strings are module constants, never caller input, so inlining them is
 * not an injection surface — but the `'` guard is kept because a kind that ever did come from
 * outside would otherwise turn this into one silently.
 */
const HOLDER_CLAIMED_KIND_SQL = [...HOLDER_CLAIMED_KINDS]
  .map((kind) => `'${kind.replace(/'/g, "''")}'`)
  .join(", ");

/**
 * The exact holder, down to the incarnation — the predicate the owner-message lifecycle uses.
 *
 * `liveDeliveryTarget` below asks whether *a* live session holds this role generation. That is the
 * right question for an outward delivery and the wrong one here: a session that was replaced by a
 * respawn keeps its `session_id` and its generation while becoming a different runtime, and the
 * conversation an owner's message was addressed to did not survive that. `assignments`
 * `session_incarnation` is the column that tells the two apart, and it is supplied by the caller
 * from the authenticated connection rather than read back from the row being claimed — a predicate
 * that sourced it from the row would compare the database against itself and match always.
 *
 * Where the first three values come from is a parameter, and the predicate itself is written once.
 * `"o"` / `"outbox"` correlate on the outbox row in the statement; `"bound"` takes all four from
 * the caller, for the replay read-back where there is no outbox row in the statement to correlate
 * with. A second hand-written spelling of this predicate is how the lifecycle clause went missing
 * from the replay path in the first place — the two copies drifted, and the drift was invisible
 * until it was a STOPPED session being told its settle succeeded.
 */
const exactHolderTarget = (source: "o" | "outbox" | "bound"): string => {
  const from = (column: string): string => (source === "bound" ? "?" : `${source}.${column}`);
  return `EXISTS (
  SELECT 1 FROM assignments a
    JOIN sessions s ON s.session_id = a.session_id
   WHERE a.role_key = ${from("role_key")}
     AND a.binding_generation = ${from("binding_generation")}
     AND a.session_id = ${from("target_session_id")}
     AND a.session_incarnation = ?
     AND a.status = 'ACTIVE'
     AND s.lifecycle IN ('READY','DRAINING')
)`;
};

const liveDeliveryTarget = (outboxAlias: "o" | "outbox"): string => `(
  EXISTS (
    SELECT 1 FROM assignments a
      JOIN sessions s ON s.session_id = a.session_id
     WHERE a.role_key = ${outboxAlias}.role_key
       AND a.binding_generation = ${outboxAlias}.binding_generation
       AND a.session_id = ${outboxAlias}.target_session_id
       AND a.status = 'ACTIVE'
       AND s.lifecycle IN ('READY','DRAINING')
  )
  OR EXISTS (
    SELECT 1 FROM handoffs h
      JOIN sessions recipient ON recipient.session_id = h.to_session_id
      JOIN sessions outgoing ON outgoing.session_id = h.from_session_id
      JOIN assignments a ON a.role_key = ${outboxAlias}.role_key
                         AND a.binding_generation = ${outboxAlias}.binding_generation
                         AND a.session_id = h.from_session_id
                         AND a.status = 'ACTIVE'
     WHERE ${outboxAlias}.kind = 'HANDOFF_PACKAGE'
       AND h.kind = 'HANDOFF'
       AND h.to_session_id = ${outboxAlias}.target_session_id
       AND h.from_generation = ${outboxAlias}.binding_generation
       AND h.status = 'PENDING'
       AND ${outboxAlias}.idempotency_key = 'handoff:' || h.handoff_id
       AND recipient.lifecycle = 'READY'
       AND outgoing.lifecycle IN ('READY','DRAINING')
  )
)`;

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

    if (!this.isCurrentTarget(
      input.roleKey,
      input.bindingGeneration,
      input.targetSessionId,
      input.kind,
      input.idempotencyKey,
    )) {
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
      requestFingerprint,
      expiresAt: isoPlus(now, input.ttlMs ?? DEFAULT_TTL_MS),
      status: "PENDING",
      attempts: 0,
      failureClass: null,
      retryEligible: false,
      nextAttemptAt: null,
      createdAt: now,
    };
    this.db.run(
      `INSERT INTO outbox (message_id, idempotency_key, role_key, binding_generation,
                           target_session_id, run_id, kind, payload_json, payload_digest,
                           request_fingerprint, expires_at, created_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')`,
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
        requestFingerprint,
        message.expiresAt,
        message.createdAt,
      ],
    );
    return allow(ReasonCode.OK, message);
  }

  private replayDecision(existing: OutboxMessage, input: EnqueueInput): Decision<OutboxMessage> {
    const matches = existing.requestFingerprint === requestFingerprintOf(input);
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

      const rows = this.db.all<RawOutbox>(
        `SELECT o.* FROM outbox o
          WHERE o.status = 'PENDING'
            -- Holder-claimed kinds are invisible to this sweep. BuzzAdapter.deliverPending
            -- transmits whatever comes back from here to the target's Buzz address, so a row that
            -- appeared in this result would have its payload sent over a channel that never
            -- authenticated the holder — the exact disclosure the separate claim path exists to
            -- prevent. The holder takes these through claimForHolder instead.
            AND o.kind NOT IN (${HOLDER_CLAIMED_KIND_SQL})
            AND o.expires_at > ?
            -- A deferred retry is not deliverable until its window opens; the deferral is
            -- durable, so a restarted loop honours it instead of retrying immediately.
            AND (o.next_attempt_at IS NULL OR o.next_attempt_at <= ?)
            -- An already-attempted row is deliverable again only while its recorded failure
            -- is retry-eligible. A queued row that carries attempts but no eligibility was
            -- never judged retryable, so it is not picked up.
            AND (o.attempts = 0 OR o.retry_eligible = 1)
            AND ${liveDeliveryTarget("o")}
          ORDER BY o.created_at
          LIMIT ?`,
        [now, now, limit],
      );

      const claimed: Array<OutboxMessage & { claimToken: string }> = [];
      for (const row of rows) {
        const token = `clm_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
        const updated = this.db.run(
          `UPDATE outbox SET status = 'IN_FLIGHT', claim_token = ?, claimed_at = ?
            WHERE message_id = ? AND status = 'PENDING'
              AND ${liveDeliveryTarget("outbox")}`,
          [token, now, row.message_id],
        );
        // Compare-and-set: another loop may have taken it between the select and here.
        if (updated.changes === 1) claimed.push({ ...hydrate(row), claimToken: token });
      }
      return claimed;
    });
  }

  /**
   * The holder takes its own owner-messages, over its own authenticated connection.
   *
   * Four things make this different from `claimDeliverable`, and each is a place a plausible
   * implementation is still wrong:
   *
   * 1. **An unresolved hand-over stops the queue.** A row already `SENT` is not re-served — its
   *    outcome is genuinely unknown, because the holder may have received it and died before
   *    acknowledging — and while one exists this call hands over *nothing new*. Reporting the
   *    unresolved row beside a fresh payload is the subtly wrong version: it looks like it honours
   *    "never twice" while giving the holder a second message to lose exactly the same way, and it
   *    lets an unknown outcome accumulate silently behind newer work. `UnresolvedOwnerMessage` has
   *    no payload field at all, so "never the payload twice" is a property of the type rather than
   *    of this method remembering not to fill one in.
   * 2. **Exactly one message per call, oldest first, and the caller does not choose.** A
   *    caller-supplied batch size is a caller-supplied blast radius: every row in a batch reaches
   *    `SENT` before the caller has done anything with any of them, so a holder that asked for
   *    twenty-five and then died put twenty-five owner-messages into the unknown-outcome path
   *    instead of one. `hasMore` and another wake drain the rest.
   * 3. **`PENDING -> SENT` happens before the payload is returned**, in the same transaction and
   *    conditioned on the row still being `PENDING`. Reading the row and then marking it would
   *    leave a window where a crash loses the message with no record that it was ever handed over.
   *    The payload returned is re-read from the row the update actually moved, never from the
   *    candidate read.
   * 4. **The compare-and-set carries the caller's whole identity**, rather than standing next to a
   *    check of it. The candidate read and the write are two statements; binding the write to the
   *    row id alone trusts that nothing changed in between. See the `UPDATE` below.
   */
  claimForHolder(holder: HolderIdentity): HolderClaimResult {
    return this.db.tx(() => {
      const now = this.clock.nowIso();
      const tuple = [
        holder.roleKey,
        holder.bindingGeneration,
        holder.targetSessionId,
        holder.sessionIncarnation,
      ];

      // Already handed over and never acknowledged. Read first because its presence decides
      // whether anything new may move at all.
      const unresolved = this.db
        .all<RawOutbox>(
          `SELECT o.* FROM outbox o
            WHERE o.kind IN (${HOLDER_CLAIMED_KIND_SQL})
              AND o.status = 'SENT'
              AND o.role_key = ? AND o.binding_generation = ? AND o.target_session_id = ?
              AND ${exactHolderTarget("o")}
            ORDER BY o.created_at`,
          tuple,
        )
        .map(unresolvedOwnerMessage);

      const queued =
        this.db.get<{ queued: number }>(
          `SELECT COUNT(*) AS queued FROM outbox o
            WHERE o.kind IN (${HOLDER_CLAIMED_KIND_SQL})
              AND o.status = 'PENDING'
              AND o.role_key = ? AND o.binding_generation = ? AND o.target_session_id = ?
              AND ${exactHolderTarget("o")}
              AND o.expires_at > ?`,
          [...tuple, now],
        )?.queued ?? 0;

      // The block. An outstanding unknown outcome is exactly the state in which handing out more
      // work is wrong, so the holder is told what is unsettled and that work is waiting, and is
      // given neither payload until it settles the first.
      if (unresolved.length > 0) return { claimed: [], unresolved, hasMore: queued > 0 };

      const candidate = this.db.get<RawOutbox>(
        `SELECT o.* FROM outbox o
          WHERE o.kind IN (${HOLDER_CLAIMED_KIND_SQL})
            AND o.status = 'PENDING'
            AND o.role_key = ? AND o.binding_generation = ? AND o.target_session_id = ?
            AND ${exactHolderTarget("o")}
            AND o.expires_at > ?
          ORDER BY o.created_at
          LIMIT 1`,
        [...tuple, now],
      );
      if (!candidate) return { claimed: [], unresolved, hasMore: false };

      // Compare-and-set, asserting the full caller tuple rather than the row id and a status.
      // `role_key`, `binding_generation` and `target_session_id` are the caller's values, not the
      // candidate's, so a row that stopped being this caller's between the read above and this
      // write changes nothing. Without them the `EXISTS` correlates on the row's own columns and
      // resolves the *row's* assignment, checking it against the caller's incarnation string —
      // which matches whenever two runtimes happen to share one, and incarnation strings are
      // unique only within a session.
      const moved = this.db.run(
        `UPDATE outbox SET status = 'SENT', sent_at = ?, attempts = attempts + 1,
                           claim_token = NULL, claimed_at = NULL,
                           retry_eligible = 0, next_attempt_at = NULL
          WHERE message_id = ? AND status = 'PENDING'
            AND kind IN (${HOLDER_CLAIMED_KIND_SQL})
            AND role_key = ? AND binding_generation = ? AND target_session_id = ?
            AND ${exactHolderTarget("outbox")}`,
        [
          now,
          candidate.message_id,
          holder.roleKey,
          holder.bindingGeneration,
          holder.targetSessionId,
          holder.sessionIncarnation,
        ],
      ).changes;
      if (moved !== 1) return { claimed: [], unresolved, hasMore: queued > 0 };

      // Re-read rather than patching the candidate: the payload handed over is the one on the row
      // this statement actually moved, and so are the attempts and the hand-over instant.
      const handed = this.db.get<RawOutbox>(`SELECT * FROM outbox WHERE message_id = ?`, [
        candidate.message_id,
      ]);
      return {
        claimed: handed ? [hydrate(handed)] : [],
        unresolved,
        hasMore: queued > 1,
      };
    });
  }

  /**
   * The holder records that it took one of its own owner-messages: `SENT -> ACKED`.
   *
   * Idempotent on an exact repeat, because the acknowledgement can be lost on the way back and a
   * holder that retries it is doing the right thing — but only for the same holder. `ACKED` is
   * re-reported as success; every other terminal state is a collision, because moving `REJECTED`
   * or `EXPIRED` to `ACKED` would rewrite a decision something else already recorded.
   */
  completeForHolder(messageId: string, holder: HolderIdentity): Decision<void> {
    return this.db.tx(() => {
      const changes = this.db.run(
        `UPDATE outbox SET status = 'ACKED', acked_at = ?
          WHERE message_id = ? AND status = 'SENT'
            AND kind IN (${HOLDER_CLAIMED_KIND_SQL})
            AND role_key = ? AND binding_generation = ? AND target_session_id = ?
            AND ${exactHolderTarget("outbox")}`,
        [
          this.clock.nowIso(),
          messageId,
          holder.roleKey,
          holder.bindingGeneration,
          holder.targetSessionId,
          holder.sessionIncarnation,
        ],
      ).changes;
      if (changes === 1) return allow(ReasonCode.OK, undefined);
      return this.holderTerminalReplay(messageId, holder, "ACKED");
    });
  }

  /**
   * The holder refuses one of its own owner-messages: terminal, and exact-holder like the claim.
   *
   * Reachable from `SENT` and from `PENDING`: a holder may decline a message it has taken, and the
   * failover path below may decline one that was never taken. Both end `REJECTED`, which no other
   * transition here moves out of.
   */
  rejectForHolder(messageId: string, holder: HolderIdentity): Decision<void> {
    return this.db.tx(() => {
      const changes = this.db.run(
        `UPDATE outbox SET status = 'REJECTED', reason_code = ?,
                           claim_token = NULL, claimed_at = NULL,
                           retry_eligible = 0, next_attempt_at = NULL
          WHERE message_id = ? AND status IN ('PENDING','SENT')
            AND kind IN (${HOLDER_CLAIMED_KIND_SQL})
            AND role_key = ? AND binding_generation = ? AND target_session_id = ?
            AND ${exactHolderTarget("outbox")}`,
        [
          ReasonCode.OUTBOX_DELIVERY_REJECTED,
          messageId,
          holder.roleKey,
          holder.bindingGeneration,
          holder.targetSessionId,
          holder.sessionIncarnation,
        ],
      ).changes;
      if (changes === 1) return allow(ReasonCode.OK, undefined);
      return this.holderTerminalReplay(messageId, holder, "REJECTED");
    });
  }

  /**
   * Why an exact-holder transition changed no row — an idempotent repeat, or a refusal.
   *
   * The distinction is the whole point: a holder retrying a lost acknowledgement and a stranger
   * trying to settle somebody else's message both produce zero changed rows, and answering both
   * the same way would either turn an ordinary retry into an error or let the stranger's call
   * report success. So the row is re-read and the holder is checked against it explicitly.
   *
   * "The same holder" here is the *same* predicate the claim, complete and reject writes assert —
   * `exactHolderTarget`, lifecycle join included — and not a second hand-written subquery that
   * happens to name the same four columns. An assignment-only match is not a live holder: a
   * `STOPPED` session keeps its `ACTIVE` assignment row, so a predicate that stopped at
   * `assignments` would hand a settled-successfully verdict to a runtime that is gone, on the one
   * path that never touches the write it is standing in for.
   */
  private holderTerminalReplay(
    messageId: string,
    holder: HolderIdentity,
    want: "ACKED" | "REJECTED",
  ): Decision<void> {
    const row = this.db.get<RawOutbox>(`SELECT * FROM outbox WHERE message_id = ?`, [messageId]);
    if (!row) return deny(ReasonCode.NOT_FOUND, "unknown message", { messageId });
    const sameHolder =
      row.role_key === holder.roleKey &&
      row.binding_generation === holder.bindingGeneration &&
      row.target_session_id === holder.targetSessionId &&
      Boolean(
        this.db.get(`SELECT 1 WHERE ${exactHolderTarget("bound")}`, [
          holder.roleKey,
          holder.bindingGeneration,
          holder.targetSessionId,
          holder.sessionIncarnation,
        ]),
      );
    if (!sameHolder) {
      return deny(
        ReasonCode.OUTBOX_STALE_GENERATION_REJECTED,
        "this holder does not own the message it tried to settle",
        { messageId, status: row.status },
      );
    }
    if (row.status === want) {
      return allow(ReasonCode.OUTBOX_DUPLICATE_SUPPRESSED, undefined, { messageId, status: row.status });
    }
    return deny(
      ReasonCode.RESOURCE_COLLISION,
      `message is ${row.status} and cannot move to ${want}`,
      { messageId, status: row.status },
    );
  }

  /** A claim whose holder died must return to PENDING rather than stay stuck IN_FLIGHT. */
  reclaimStaleLeases(leaseMs = 5 * 60 * 1000): number {
    this.fenceUndeliverable();
    return this.db.run(
      `UPDATE outbox SET status = 'PENDING', claim_token = NULL, claimed_at = NULL
        WHERE status = 'IN_FLIGHT' AND claimed_at <= ?
          AND ${liveDeliveryTarget("outbox")}`,
      [new Date(new Date(this.clock.nowIso()).getTime() - leaseMs).toISOString()],
    ).changes;
  }

  /** Only the holder of the current claim may complete a delivery. */
  markSent(messageId: string, claimToken: string): Decision<void> {
    const changes = this.db.run(
      `UPDATE outbox SET status = 'SENT', sent_at = ?, attempts = attempts + 1,
                         claim_token = NULL, claimed_at = NULL,
                         retry_eligible = 0, next_attempt_at = NULL
        WHERE message_id = ? AND status = 'IN_FLIGHT' AND claim_token = ?
          AND ${liveDeliveryTarget("outbox")}`,
      [this.clock.nowIso(), messageId, claimToken],
    ).changes;
    if (changes !== 1) {
      return deny(ReasonCode.OUTBOX_STALE_GENERATION_REJECTED, "claim is no longer held", {
        messageId,
      });
    }
    return allow(ReasonCode.OK, undefined);
  }

  /**
   * Records a failed delivery attempt against the durable retry policy (§34.1).
   *
   * A failure is either *deferred* or terminal — never immediately re-queued. The row
   * returns to PENDING only together with a future `next_attempt_at`, and only when the
   * recorded failure class is one whose cause can clear on its own and the attempt budget
   * is not spent. Everything else is REJECTED, so a contract or security failure cannot be
   * retried into an infinite send loop.
   */
  markAttemptFailed(
    messageId: string,
    claimToken: string,
    failure: DeliveryFailure | string,
  ): Decision<void> {
    const classified = normalizeFailure(failure);
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
    // A defective stored policy is a different denial from "this failure earns no retry":
    // the row carries no usable schedule at all, so nothing about the failure class can
    // rescue it. Naming that separately keeps an operator from reading a policy defect as a
    // verdict on the transport.
    const terminalReason = retryPolicyIsValid
      ? ReasonCode.OUTBOX_DELIVERY_REJECTED
      : ReasonCode.OUTBOX_RETRY_POLICY_UNAVAILABLE;
    const changes = this.db.run(
      `UPDATE outbox SET status = ?, attempts = ?, last_error = ?, failure_class = ?,
                         retry_eligible = ?, next_attempt_at = ?, reason_code = ?,
                         claim_token = NULL, claimed_at = NULL
        WHERE message_id = ? AND status = 'IN_FLIGHT' AND claim_token = ?
          AND ${liveDeliveryTarget("outbox")}`,
      [
        retryable ? "PENDING" : "REJECTED",
        attempts,
        classified.error.slice(0, 500),
        classified.failureClass,
        retryable ? 1 : 0,
        nextAttemptAt,
        retryable ? null : terminalReason,
        messageId,
        claimToken,
      ],
    ).changes;
    if (changes !== 1) {
      return this.staleClaim(messageId);
    }
    if (!retryable) {
      return deny(
        terminalReason,
        retryPolicyIsValid
          ? "delivery failure is not eligible for another attempt"
          : "stored retry policy is unusable, so the delivery cannot be deferred",
        {
          messageId,
          failureClass: classified.failureClass,
          attempts,
          retryMaxAttempts: row.retry_max_attempts,
          retryPolicyIsValid,
        },
      );
    }
    return allow(ReasonCode.OK, undefined, {
      messageId,
      failureClass: classified.failureClass,
      attempts,
      nextAttemptAt,
    });
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
    const expired = row.status === "EXPIRED" || row.expires_at <= this.clock.nowIso();
    const ineligible =
      row.status === "REJECTED" ||
      expired ||
      row.status === "ACKED";
    const rejectionCode = expired
      ? ReasonCode.OUTBOX_EXPIRED
      : ReasonCode.OUTBOX_STALE_GENERATION_REJECTED;

    if (staleGeneration || ineligible) {
      this.audit.record({
        kind: "OUTBOX_ACK_REJECTED",
        reasonCode: rejectionCode,
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
        rejectionCode,
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
        AND (
          status IN ('PENDING','IN_FLIGHT')
          -- A holder-claimed row that reached SENT is *also* swept, which no other kind is.
          --
          -- For an outward delivery, SENT means "the transport took it" and the row is waiting on
          -- an ACK that a later generation can still legitimately supply, so sweeping it here
          -- would fence a delivery that succeeded. For an owner-message, SENT means "the previous
          -- holder was handed the payload and never acknowledged" — its outcome is unknown and it
          -- is addressed to a conversation that no longer exists. Leaving it would strand it in a
          -- state nothing sweeps; retargeting it would replay an owner's message into a runtime it
          -- was never addressed to. So it is rejected, and the loop below cannot retarget it
          -- because the kind is absent from RETARGETABLE_KINDS.
          OR (status = 'SENT' AND kind IN (${HOLDER_CLAIMED_KIND_SQL}))
        )`,
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
                             claim_token = NULL, claimed_at = NULL,
                             retry_eligible = 0, next_attempt_at = NULL
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
      `UPDATE outbox SET status = 'EXPIRED', reason_code = ?,
                         retry_eligible = 0, next_attempt_at = NULL
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

  /**
   * Fence queued and claimed rows whose binding or target lifecycle is no longer valid.
   *
   * A holder-claimed row that reached `SENT` is swept here too, which no other kind is — the same
   * asymmetry `retargetOrReject` makes, and for the same reason. For an outward delivery `SENT`
   * means the transport took it and an ACK may still legitimately arrive, so fencing it would
   * reject a delivery that succeeded. For an owner-message it means the previous holder was handed
   * the payload and never came back; once its target is no longer live, nothing can ever settle
   * it. Without this clause a restart strands it exactly there: the new holder cannot claim it
   * (wrong incarnation), `SessionRegistry`'s own stop-time fence only looks at `PENDING` and
   * `IN_FLIGHT`, and so the row sits `SENT` forever. The `NOT liveDeliveryTarget` condition is what
   * keeps this off a live holder's outstanding message, which stays claimable and settleable.
   */
  fenceUndeliverable(): number {
    return this.db.run(
      `UPDATE outbox SET status = 'REJECTED', reason_code = ?, claim_token = NULL, claimed_at = NULL,
                         retry_eligible = 0, next_attempt_at = NULL
        WHERE (
                status IN ('PENDING','IN_FLIGHT')
                OR (status = 'SENT' AND kind IN (${HOLDER_CLAIMED_KIND_SQL}))
              )
          AND NOT ${liveDeliveryTarget("outbox")}`,
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
  private isCurrentTarget(
    roleKey: string,
    bindingGeneration: number,
    sessionId: string,
    kind: MessageKind,
    idempotencyKey: string,
  ): boolean {
    const holder = this.db.get(
      `SELECT 1 FROM assignments a
        JOIN sessions s ON s.session_id = a.session_id
        WHERE a.role_key = ? AND a.binding_generation = ? AND a.session_id = ?
          AND a.status = 'ACTIVE' AND s.lifecycle IN ('READY','DRAINING')`,
      [roleKey, bindingGeneration, sessionId],
    );
    if (holder) return true;

    if (kind !== MessageKind.HANDOFF_PACKAGE) return false;

    return Boolean(
      this.db.get(
        `SELECT 1 FROM handoffs h
          JOIN sessions recipient ON recipient.session_id = h.to_session_id
          JOIN sessions outgoing ON outgoing.session_id = h.from_session_id
          JOIN assignments a ON a.role_key = ? AND a.binding_generation = ?
                            AND a.session_id = h.from_session_id AND a.status = 'ACTIVE'
          WHERE h.kind = 'HANDOFF' AND h.to_session_id = ?
            AND h.status = 'PENDING' AND h.from_generation = ?
            AND ? = 'handoff:' || h.handoff_id
            AND recipient.lifecycle = 'READY'
            AND outgoing.lifecycle IN ('READY','DRAINING')`,
        [roleKey, bindingGeneration, sessionId, bindingGeneration, idempotencyKey],
      ),
    );
  }

  private staleClaim(messageId: string): Decision<void> {
    return deny(ReasonCode.OUTBOX_STALE_GENERATION_REJECTED, "claim is no longer current", {
      messageId,
    });
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
  request_fingerprint: string;
  expires_at: string;
  created_at: string;
  status: OutboxMessage["status"];
  attempts: number;
  failure_class?: FailureClass | null;
  retry_eligible?: number | null;
  next_attempt_at?: string | null;
  sent_at?: string | null;
}

/**
 * Projects a raw row onto the no-payload shape. `payload_json` is read off the row and simply
 * never copied — the destination type has no field for it.
 */
const unresolvedOwnerMessage = (row: RawOutbox): UnresolvedOwnerMessage => ({
  messageId: row.message_id,
  roleKey: row.role_key,
  bindingGeneration: row.binding_generation,
  targetSessionId: row.target_session_id,
  kind: row.kind as MessageKind,
  payloadDigest: row.payload_digest,
  sentAt: row.sent_at ?? null,
  attempts: row.attempts,
  createdAt: row.created_at,
});

const hydrate = (row: RawOutbox): OutboxMessage => ({
  messageId: row.message_id,
  idempotencyKey: row.idempotency_key,
  requestFingerprint: row.request_fingerprint,
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
  failureClass: row.failure_class ?? null,
  retryEligible: row.retry_eligible === 1,
  nextAttemptAt: row.next_attempt_at ?? null,
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
