import type { Clock } from "../core/clock.ts";
import { isoPlus } from "../core/clock.ts";
import { type Decision, allow, deny, fail, isAcpError } from "../core/errors.ts";
import { randomUUID } from "node:crypto";

import { digestOf } from "../core/digest.ts";

import { newMessageId } from "../core/ids.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { AuditLog } from "../db/audit.ts";
import type { Db } from "../db/database.ts";
import { FailureClass as FailureClassCode, type FailureClass } from "../domain/types.ts";
import { ownerMessagePointerOf } from "../ingress/buzz-message.ts";
import { IngressGuard } from "../ingress/ingress-guard.ts";
import {
  type PeerMessageCarryAuthority,
  type PeerMessageSuccession,
  adoptedCanonicalRuntimeSql,
  isAdoptedCanonicalRuntime,
  peerMessageCarrySuccessionOf,
} from "../registry/canonical-self-claim.ts";
import {
  type FencedEnvelope,
  HOLDER_CLAIMED_KINDS,
  IDENTITY_BOUND_KINDS,
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
   * `PENDING` rows this holder is addressed by and may not be handed, because the caller's
   * `admits` refused them or their stored payload is not readable (#1044). Metadata only, and
   * nothing was written for them: the holder may reject one, by id, through `rejectForHolder`,
   * which is the one write that retires it.
   */
  withheld: UnresolvedOwnerMessage[];
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
export const HOLDER_CLAIMED_KIND_SQL = [...HOLDER_CLAIMED_KINDS]
  .map((kind) => `'${kind.replace(/'/g, "''")}'`)
  .join(", ");

/**
 * The outward, role-level kinds an adopted canonical CTO receives in band rather than over Buzz.
 *
 * A canonical CTO is an interactive runtime no provider launched (`adoptedCanonicalRuntimeSql`). A
 * Buzz send to its room is signed with the daemon's outbound key, and the room's own sender admits
 * only the room's registered CEO and CTO — so the send is refused, non-retryably, and the row goes
 * REJECTED before the CTO can acknowledge it. These kinds are therefore withheld from
 * `claimDeliverable` when, and only when, the target is such a runtime: the row stays PENDING, the
 * role is woken, and the CTO reads it with `pendingInBandFor` and settles it with `acknowledge`,
 * both over its own authenticated connection.
 *
 * Every outward kind that can be addressed to a PRIMARY_CTO's bound session is here, so no message
 * to a canonical CTO depends on that send: `RUN_DISPATCH` (run engine, owner-decision resume),
 * `REVISION_REQUEST` (candidate pipeline, candidate invalidation), `ESCALATION_REPLY` (the CEO's
 * resolution), `DRAIN_REQUEST` (replacement) and `CANCEL_REQUEST`. All are settled by `run_ack`,
 * the only generic acknowledgement there is. Left out: `HANDOFF_PACKAGE`, whose recipient is by
 * construction not yet the role's holder and is settled by `handoff_ack`; `CEO_NOTIFICATION`,
 * addressed to the CEO; and `TASK_ASSIGN`, `REVIEW_REQUEST` and `RECOVERY_PACKAGE`, which nothing
 * enqueues. Disjoint from `HOLDER_CLAIMED_KINDS`, which never reach the sweep at all.
 */
export const IN_BAND_KINDS: ReadonlySet<MessageKind> = new Set<MessageKind>([
  MessageKind.RUN_DISPATCH,
  MessageKind.CANCEL_REQUEST,
  MessageKind.REVISION_REQUEST,
  MessageKind.ESCALATION_REPLY,
  MessageKind.DRAIN_REQUEST,
]);

/** The literal list for `IN_BAND_KINDS`, built the way `HOLDER_CLAIMED_KIND_SQL` is. */
export const IN_BAND_KIND_SQL = [...IN_BAND_KINDS]
  .map((kind) => `'${kind.replace(/'/g, "''")}'`)
  .join(", ");

/** A pending in-band row is woken for at most once per this window, per row. */
export const IN_BAND_REWAKE_MS = 5 * 60 * 1000;

/** Knocks on a role's registered wake endpoint; carries nothing (`RoleConversationPort.wake`). */
export type InBandWake = (roleKey: string) => Promise<Decision<void>>;

/** What an adopted canonical CTO is shown of a row addressed to it in band. */
export interface InBandDispatch {
  messageId: string;
  kind: MessageKind;
  runId: string | null;
  createdAt: string;
  expiresAt: string;
  payload: unknown;
}

/**
 * An in-band row in the generic sweep's terms: the kind is in band and the target is an adopted
 * canonical runtime. `claimDeliverable` excludes it, and every in-band read below selects it.
 */
const inBandRow = (outboxAlias: "o" | "outbox"): string =>
  `(${outboxAlias}.kind IN (${IN_BAND_KIND_SQL})
    AND ${adoptedCanonicalRuntimeSql(`${outboxAlias}.target_session_id`)})`;

/**
 * Which runtime holds a role *right now* — one notion of it, shared by every predicate below.
 *
 * `assignments.session_id` is the runtime the binding was created against, and it does not move.
 * `BindingRegistry.switchTo` with `conversation: "SURVIVED"` moves only
 * `conversational_actors.current_session_id`: the counterpart is the same conversation and its
 * process is not, so the binding is deliberately not rewritten and the assignment row goes on
 * naming a runtime that is gone. Two predicates that disagree about which of those is "the holder"
 * is how an owner's message ends up addressed to a session no connection can present — the row is
 * unclaimable by the runtime that now holds the role, and a fresh admission for the same role is
 * refused `OUTBOX_TARGET_NOT_CURRENT` because `activeRoleTarget` answers with the actor's session
 * while admission checked the assignment's.
 *
 * `BindingRegistry.hydrate` already answers the question one way — the actor's pointer, falling
 * back to the binding's own value for an actor that has not been given a runtime yet — and this is
 * that same expression rather than a second one. Anything narrower would be a *third* notion of
 * current holder standing beside the two this reconciles, and the fallback is what keeps every
 * ordinary binding, whose actor names exactly the assignment's session, answering as it did.
 *
 * Moving the pointer is only half of it: the rows already addressed to the outgoing runtime have to
 * move in the same transaction, which is `carryHolderMessagesToRuntime` below.
 */
const HOLDER_ACTOR_JOIN = "LEFT JOIN conversational_actors actor ON actor.actor_id = a.actor_id";
const CURRENT_HOLDER_SESSION = "COALESCE(actor.current_session_id, a.session_id)";
const CURRENT_HOLDER_INCARNATION =
  "COALESCE(actor.current_session_incarnation, a.session_incarnation)";

/**
 * The exact holder, down to the incarnation — the predicate the owner-message lifecycle uses.
 *
 * `liveDeliveryTarget` below asks whether *a* live session holds this role generation. That is the
 * right question for an outward delivery and the wrong one here: a session that was replaced by a
 * respawn keeps its `session_id` and its generation while becoming a different runtime, and the
 * conversation an owner's message was addressed to did not survive that. The current holder's
 * incarnation is the value that tells the two apart, and it is supplied by the caller from the
 * authenticated connection rather than read back from the row being claimed — a predicate that
 * sourced it from the row would compare the database against itself and match always.
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
    ${HOLDER_ACTOR_JOIN}
    JOIN sessions s ON s.session_id = ${CURRENT_HOLDER_SESSION}
   WHERE a.role_key = ${from("role_key")}
     AND a.binding_generation = ${from("binding_generation")}
     AND ${CURRENT_HOLDER_SESSION} = ${from("target_session_id")}
     AND ${CURRENT_HOLDER_INCARNATION} = ?
     AND a.status = 'ACTIVE'
     AND s.lifecycle IN ('READY','DRAINING')
)`;
};

const liveDeliveryTarget = (outboxAlias: "o" | "outbox"): string => `(
  EXISTS (
    SELECT 1 FROM assignments a
      ${HOLDER_ACTOR_JOIN}
      JOIN sessions s ON s.session_id = ${CURRENT_HOLDER_SESSION}
     WHERE a.role_key = ${outboxAlias}.role_key
       AND a.binding_generation = ${outboxAlias}.binding_generation
       AND ${CURRENT_HOLDER_SESSION} = ${outboxAlias}.target_session_id
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
  /**
   * The ingress no-reply transition, as a caller rather than as a second definition of it.
   *
   * An `OWNER_MESSAGE` is the durable half of an ingress turn: the row in `inbound_messages` holds
   * that turn's claim open, and `IngressGuard.prune` deliberately never deletes a claim carrying
   * none of `repliedAt`/`noReplyAt`/`settledAt`. So every transition that takes such a row out of
   * `PENDING`/`SENT` without handing it to a successor has to settle the claim, in the same
   * transaction — otherwise the `(buzz, nonce)` slot is held forever by an outbox row that is
   * terminal and gone, and `doctor` reports a turn nothing will ever finish.
   *
   * Built here rather than injected, because every caller of this class would otherwise have to
   * remember to wire it and a composition that forgot would lose the coupling silently. Carrying
   * **no channel policy at all** is what keeps it from becoming a second admission authority: with
   * an empty policy map it can admit nothing, sign nothing and refuse nothing. The only method used
   * is `completeNoReplyAndResolveTurn`, which reads the database and the clock and nothing else.
   *
   * Never `resolveTurn`: that writes `repliedAt`, the narrow claim that a reply transport accepted
   * bytes. Nothing on this path hands a reply to any transport.
   */
  private readonly settlement: IngressGuard;

  /** The CTO role's wake port, once the daemon's listeners exist; null wakes nothing. */
  #inBandWake: InBandWake | null = null;
  /**
   * When each pending in-band row was last woken for, by message id (clock milliseconds).
   *
   * Memory only, deliberately: it bounds wakes to one per row per `IN_BAND_REWAKE_MS`, which is a
   * storm guard rather than a delivery record. A restart forgets it and wakes each row once more,
   * which is harmless — the wake carries nothing, and the row is settled only by its ack.
   */
  readonly #inBandWokenAt = new Map<string, number>();

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly audit: AuditLog,
  ) {
    this.settlement = new IngressGuard(db, clock, audit, {});
  }

  /**
   * Settles the ingress claim one holder-claimed row is holding open.
   *
   * The claim is found by `turn_claim_json.turnRequestId`, which **is** the outbox message id
   * (`admitBuzzMessage` mints it from the enqueue's own result), and deliberately *not* by reading
   * the pointer off the row's payload. Two of the transitions that must settle are refusals of a
   * row whose payload is unreadable or no longer resolves to the source it was enqueued for — a
   * settlement that trusted that payload would follow it to the wrong turn on exactly the paths it
   * exists for, or find nothing to follow at all.
   *
   * A row with no claim answers `OK`: an owner-message enqueued outside the ingress path is holding
   * nothing open, which is the same thing `completeNoReplyAndResolveTurn` says for a message that
   * claimed no turn.
   */
  private settleHolderClaim(messageId: string, by: "HOLDER" | "FENCE" = "HOLDER"): Decision<void> {
    const claim = this.db.get<{ channel: string; nonce: string }>(
      `SELECT channel, nonce FROM inbound_messages
        WHERE turn_claim_json IS NOT NULL
          AND json_valid(turn_claim_json) = 1
          AND json_extract(turn_claim_json, '$.turnRequestId') = ?`,
      [messageId],
    );
    if (!claim) return allow(ReasonCode.OK, undefined);
    return this.settlement.completeNoReplyAndResolveTurn(claim.channel, claim.nonce, {
      keepSettled: by === "FENCE",
    });
  }

  /**
   * The same coupling for a sweep, which has no `Decision` to hand a refusal back through.
   *
   * `fenceUndeliverable`, `retargetOrReject`, `carryHolderMessagesToRuntime` and
   * `carryPeerMessagesToSameActorSuccessor` return counts and id lists, and all run inside a
   * caller's transaction (a delivery loop, a binding switch, a restart's claim). A refused settlement
   * there cannot be reported as a denial, and committing the outbox half alone is the split state
   * this whole slice exists to remove — so it throws, and the caller's `db.tx` rolls the whole thing
   * back. Loud and whole beats quiet and half.
   *
   * A fence is not the holder deciding the turn, though: it only takes the row out of the queue. So
   * a turn that already has a terminal outcome keeps it (ACP-RESTART-03) — a receipt that settled it
   * (`settledAt`, e.g. `REPLY_OUTBOX`) stands, exactly as a `repliedAt` or `noReplyAt` already did,
   * and the row is rejected beside it. Before this, that receipt made the no-reply settlement refuse
   * with `RESOURCE_COLLISION`, the throw below rolled the whole fence back, and a canonical restart
   * with one such queued message could never complete.
   */
  private settleHolderClaimOrThrow(messageId: string): void {
    const settled = this.settleHolderClaim(messageId, "FENCE");
    if (settled.allowed) return;
    throw new Error(
      `owner-message ${messageId} could not be taken out of the queue: its ingress claim refused ` +
        `to settle (${settled.reasonCode}), and committing the outbox side alone would strand it`,
    );
  }

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
    // An in-band row is never transmitted, so the role is told it has something to read — after
    // the enclosing transaction commits, so a wake cannot reach the CTO before the row it points
    // at is visible, and a rollback discards it.
    if (IN_BAND_KINDS.has(message.kind) && isAdoptedCanonicalRuntime(this.db, message.targetSessionId)) {
      this.db.afterCommit(() => {
        void this.#wakeInBand([{ messageId: message.messageId, roleKey: message.roleKey }], "enqueue");
      });
    }
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
            -- So is an in-band row: a role-level kind addressed to an adopted canonical CTO. A
            -- Buzz send to it would be signed with the daemon's key, which the room's sender
            -- refuses — the row would go REJECTED before the CTO could acknowledge it — and the
            -- CTO already holds an authenticated connection to this daemon. It stays PENDING and
            -- the CTO reads it in band (pendingInBandFor), for the same reason as the line above:
            -- nothing here may transmit what only its exact target may read.
            AND NOT ${inBandRow("o")}
            AND o.expires_at > ?
            -- A deferred retry is not deliverable until its window opens; the deferral is
            -- durable, so a restarted loop honours it instead of retrying immediately.
            AND (o.next_attempt_at IS NULL OR o.next_attempt_at <= ?)
            -- An already-attempted row is deliverable again only while its recorded failure
            -- is retry-eligible. A queued row that carries attempts but no eligibility was
            -- never judged retryable, so it is not picked up.
            AND (o.attempts = 0 OR o.retry_eligible = 1)
            AND ${liveDeliveryTarget("o")}
          ORDER BY o.created_at, o.rowid
          LIMIT ?`,
        [now, now, limit],
      );

      const claimed: Array<OutboxMessage & { claimToken: string }> = [];
      for (const row of rows) {
        const token = `clm_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
        const updated = this.db.run(
          `UPDATE outbox SET status = 'IN_FLIGHT', claim_token = ?, claimed_at = ?
            WHERE message_id = ? AND status = 'PENDING'
              AND NOT ${inBandRow("outbox")}
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
   * 5. **`admits` is asked about every candidate before anything is written** (#1044), inside this
   *    same transaction, and a refused candidate is skipped rather than handed over or burned. Its
   *    default withholds every `IDENTITY_BOUND_KINDS` row, so a caller that supplies no proof hands
   *    over no peer message. The caller's predicate must only read.
   */
  claimForHolder(
    holder: HolderIdentity,
    admits: (candidate: OutboxMessage) => boolean = withholdsIdentityBound,
  ): HolderClaimResult {
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
            ORDER BY o.created_at, o.message_id`,
          tuple,
        )
        .map(unresolvedOwnerMessage);


      // No `expires_at` here. A holder-claimed row does not expire — see `expireOverdue` — and the
      // exclusion has to hold at *every* query that reads the column, not only at the sweep.
      // Excluding it from the sweep alone produces a subtler strand than the one it removes: the row
      // keeps `status = 'PENDING'`, so nothing sweeps it and nothing reports it, while a condition
      // here would mean no holder can ever be handed it.
      //
      // ORDER BY o.created_at, o.message_id — the tiebreaker is load-bearing here and this is
      // the site where saying so matters most (#858).
      //
      // Two things this pair does not give, both measured rather than assumed.
      //
      // It is not total at the schema level: `message_id TEXT PRIMARY KEY` carries no `NOT NULL`
      // and SQLite permits NULL in a non-INTEGER primary key, so two NULL-id rows insert and the
      // composite ties again. Not reachable from `src/`, where every writer mints through
      // `newMessageId()`, but a raw-SQL writer is in this repository's threat model.
      //
      // `o.rowid`, and the reason is which orders a tiebreaker preserves. Two minted ids were
      // tried and both changed *which row* this `LIMIT` returns —
      // `outbox-owner-message-holder.test.ts` expected the message it had queued and got another,
      // under `message_id` and again under `idempotency_key`. `rowid` does not:
      //
      //     inserted c, a, b        ORDER BY created_at              -> c
      //                             ORDER BY created_at, message_id  -> a   (a different row)
      //                             ORDER BY created_at, rowid       -> c   (the same row)
      //
      // A minted id sorts arbitrarily; rowid is assigned in insertion order, which for a queue is
      // the order the rows arrived. So this pair is total *and* keeps the answer the untied query
      // already gave, which is the part a census cannot check and a consumer can.
      //
      // What it is not: a declared contract. `rowid` is SQLite's, not this schema's — a `VACUUM`
      // or a table rebuild renumbers it, and a delete lets a value be reused, because this table
      // is not `AUTOINCREMENT`. Both only reorder rows that are already tied on `created_at`, and
      // nothing here reads the number itself. Making arrival order a column the schema states is a
      // migration and remains #858's, not this query's.
      //
      // `created_at` is millisecond ISO text, and 400 consecutive `systemClock.nowIso()` calls
      // were measured returning one distinct timestamp. This order decides which PENDING message
      // the holder is handed next. With a tie and no second term, that choice was
      // the query planner's, so two owner messages queued in the same millisecond had no defined
      // order of answering.
      //
      // What the tiebreaker does and does not buy, stated rather than implied: `message_id` is
      // random (`msg_97aa06bf…`), not time-ordered, so `(created_at, message_id)` is **total and
      // reproducible, and it is not arrival order**. Within one millisecond the winner is
      // arbitrary — but the same arbitrary one on every run and every replica, which is what the
      // planner's choice was not. Making it arrival order needs a monotonic column, which is a
      // schema change and is not this.
      //
      // Every queued row is read, not `LIMIT 1`, because `admits` decides which of them may be
      // handed over at all (#1044) — and it decides before anything below writes. A withheld row is
      // skipped, so one stale peer message does not stop the owner's messages queued behind it.
      const queued = this.db.all<RawOutbox>(
        `SELECT o.* FROM outbox o
          WHERE o.kind IN (${HOLDER_CLAIMED_KIND_SQL})
            AND o.status = 'PENDING'
            AND o.role_key = ? AND o.binding_generation = ? AND o.target_session_id = ?
            AND ${exactHolderTarget("o")}
          ORDER BY o.created_at, o.rowid`,
        tuple,
      );
      // Each row is read on its own, and a row whose payload cannot be read is withheld on its own
      // (#1044): an unreadable later row must not cost the holder the readable message ahead of it,
      // nor the report of an unresolved hand-over. Only reading is caught here — a failure inside
      // `admits` is the caller's, and still propagates.
      const admitted: RawOutbox[] = [];
      const withheld: UnresolvedOwnerMessage[] = [];
      for (const row of queued) {
        const message = readableMessage(row);
        if (message !== null && admits(message)) admitted.push(row);
        else withheld.push(unresolvedOwnerMessage(row));
      }

      // The block. An outstanding unknown outcome is exactly the state in which handing out more
      // work is wrong, so the holder is told what is unsettled and that work is waiting, and is
      // given neither payload until it settles the first.
      if (unresolved.length > 0) {
        return { claimed: [], unresolved, withheld, hasMore: admitted.length > 0 };
      }

      const candidate = admitted[0];
      if (!candidate) return { claimed: [], unresolved, withheld, hasMore: false };

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
      if (moved !== 1) return { claimed: [], unresolved, withheld, hasMore: admitted.length > 0 };

      // Re-read rather than patching the candidate: the payload handed over is the one on the row
      // this statement actually moved, and so are the attempts and the hand-over instant.
      const handed = this.db.get<RawOutbox>(`SELECT * FROM outbox WHERE message_id = ?`, [
        candidate.message_id,
      ]);
      return {
        claimed: handed ? [hydrate(handed)] : [],
        unresolved,
        withheld,
        hasMore: admitted.length > 1,
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
    // `txDecision`, not `tx`: this body writes and can then decide against itself, because the
    // settlement below is the second half of one transition. A denial there has to take the
    // `ACKED` with it — an outbox row settled beside an ingress claim still reading unresolved is
    // exactly the split state this whole path exists to remove. Nested inside the ledger's own
    // decision frame it hands the denial straight back, and the outermost frame does the rollback.
    return this.db.txDecision(() => {
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
      if (changes !== 1) return this.holderTerminalReplay(messageId, holder, "ACKED");
      const settled = this.settleHolderClaim(messageId);
      if (!settled.allowed) return settled;
      return allow(ReasonCode.OK, undefined);
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
    // `txDecision` for the same reason as `completeForHolder`: the rejection and the settlement of
    // the ingress claim it closes are one transition, and half of it is worse than none of it.
    return this.db.txDecision(() => {
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
      if (changes !== 1) return this.holderTerminalReplay(messageId, holder, "REJECTED");
      const settled = this.settleHolderClaim(messageId);
      if (!settled.allowed) return settled;
      return allow(ReasonCode.OK, undefined);
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
  acknowledge(
    messageId: string,
    fromSessionId: string,
    generation: number,
    sessionIncarnation?: string,
  ): Decision<void> {
    return this.db.tx(() => this.acknowledgeInTx(messageId, fromSessionId, generation, sessionIncarnation));
  }

  private acknowledgeInTx(
    messageId: string,
    fromSessionId: string,
    generation: number,
    sessionIncarnation: string | undefined,
  ): Decision<void> {
    const row = this.db.get<RawOutbox>(`SELECT * FROM outbox WHERE message_id = ?`, [messageId]);
    if (!row) return deny(ReasonCode.NOT_FOUND, "unknown message", { messageId });

    // A pending in-band row has one acknowledgement authority, the one `role_dispatch_ack` uses, so
    // the run-scoped route and the runless one cannot disagree about who may settle it. `run_ack`
    // has already fenced the caller to a run it owns; the row's own role generation decides the
    // rest. A holder-claimed kind is never in band, so the refusal below still covers it.
    if (row.status === "PENDING" && this.#isInBand(row)) {
      return this.#acknowledgeInBandInTx(row, fromSessionId, sessionIncarnation ?? null);
    }

    // This route is scoped by a *tuple*, not by a message. The `messageId` is whatever the caller
    // supplied, and everything below checks that the caller holds the row's role generation — so a
    // caller presenting its own perfectly valid `run_ack` tuple plus an arbitrary id could drive a
    // holder-claimed row straight to `ACKED`: terminal, and past `completeForHolder`, which is the
    // only place an owner-message's ingress claim is settled.
    //
    // Fail closed on the kind. A holder-claimed message is settled over its holder's own
    // authenticated connection or not at all, which is the same boundary `claimDeliverable`'s
    // exclusion draws on the way out — this is that boundary on the way back in.
    if (HOLDER_CLAIMED_KINDS.has(row.kind as MessageKind)) {
      this.audit.record({
        kind: "OUTBOX_ACK_REJECTED",
        reasonCode: ReasonCode.INVALID_ARGUMENT,
        runId: row.run_id,
        sessionId: fromSessionId,
        roleKey: row.role_key,
        evidence: { messageId, kind: row.kind, status: row.status, ackGeneration: generation },
      });
      return deny(
        ReasonCode.INVALID_ARGUMENT,
        "this message is settled over its holder's own connection, not through the generic ack",
        { messageId, kind: row.kind },
      );
    }

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
   * Acknowledges one in-band row, runless: the authority is the addressed row and the caller's own
   * authenticated session, never a run (`role_dispatch_ack`). A `DRAIN_REQUEST` carries no run, and
   * a canonical CTO that owns none still has to be able to settle it.
   */
  acknowledgeInBand(messageId: string, sessionId: string, sessionIncarnation: string): Decision<void> {
    return this.db.tx(() => {
      const row = this.db.get<RawOutbox>(`SELECT * FROM outbox WHERE message_id = ?`, [messageId]);
      if (!row) return deny(ReasonCode.NOT_FOUND, "unknown message", { messageId });
      return this.#acknowledgeInBandInTx(row, sessionId, sessionIncarnation);
    });
  }

  /** In-band, in `claimDeliverable`'s terms: an in-band kind addressed to a canonical runtime. */
  #isInBand(row: RawOutbox): boolean {
    return IN_BAND_KINDS.has(row.kind as MessageKind) && isAdoptedCanonicalRuntime(this.db, row.target_session_id);
  }

  /**
   * The one in-band acknowledgement authority, for `run_ack` and `role_dispatch_ack` alike.
   *
   * The caller must be the row's exact target and, through `exactHolderTarget` with the row's own
   * role key and generation, that generation's ACTIVE holder at the incarnation its connection
   * presented — the predicate `pendingInBandFor` lists by, so a session can settle exactly what it
   * can see. A holder-claimed kind, a row that is not in band, and a row that is expired, rejected or
   * already settled are refused. Only `PENDING -> ACKED` is written, as a compare-and-set.
   */
  #acknowledgeInBandInTx(row: RawOutbox, sessionId: string, sessionIncarnation: string | null): Decision<void> {
    const messageId = row.message_id;
    const refuse = (reasonCode: ReasonCode, message: string): Decision<void> => {
      this.audit.record({
        kind: "OUTBOX_ACK_REJECTED",
        reasonCode,
        runId: row.run_id,
        sessionId,
        roleKey: row.role_key,
        evidence: { messageId, kind: row.kind, status: row.status, inBand: true },
      });
      return deny(reasonCode, message, { messageId, status: row.status });
    };
    if (HOLDER_CLAIMED_KINDS.has(row.kind as MessageKind)) {
      return refuse(
        ReasonCode.INVALID_ARGUMENT,
        "this message is settled over its holder's own connection, not through the generic ack",
      );
    }
    if (!this.#isInBand(row)) {
      return refuse(ReasonCode.INVALID_ARGUMENT, "this message is not delivered in band; acknowledge it with run_ack");
    }
    if (row.status === "EXPIRED" || row.expires_at <= this.clock.nowIso()) {
      return refuse(ReasonCode.OUTBOX_EXPIRED, `message is ${row.status} and cannot be acknowledged`);
    }
    if (row.status !== "PENDING") {
      return refuse(ReasonCode.OUTBOX_STALE_GENERATION_REJECTED, `message is ${row.status} and cannot be acknowledged`);
    }
    const holder =
      sessionIncarnation !== null &&
      row.target_session_id === sessionId &&
      this.db.get<{ held: number }>(
        `SELECT ${exactHolderTarget("bound")} AS held`,
        [row.role_key, row.binding_generation, row.target_session_id, sessionIncarnation],
      )?.held === 1;
    if (!holder) {
      return refuse(
        ReasonCode.OUTBOX_STALE_GENERATION_REJECTED,
        "ack came from a session, generation or incarnation that does not hold this message",
      );
    }
    const now = this.clock.nowIso();
    const changed = this.db.run(
      `UPDATE outbox SET status = 'ACKED', acked_at = ? WHERE message_id = ? AND status = 'PENDING'`,
      [now, messageId],
    ).changes;
    if (changed !== 1) {
      return refuse(ReasonCode.OUTBOX_STALE_GENERATION_REJECTED, "message left PENDING before it could be acknowledged");
    }
    this.audit.record({
      kind: "OUTBOX_ACKED_IN_BAND",
      reasonCode: ReasonCode.OK,
      runId: row.run_id,
      sessionId,
      roleKey: row.role_key,
      evidence: { messageId, kind: row.kind, bindingGeneration: row.binding_generation },
    });
    this.db.afterCommit(() => this.#inBandWokenAt.delete(messageId));
    return allow(ReasonCode.OK, undefined);
  }

  /**
   * The pending in-band rows addressed to one exact runtime, oldest first: read-only.
   *
   * `sessionIncarnation` comes from the caller's authenticated connection, and the row must be
   * addressed to the current holder of its own role generation down to that incarnation
   * (`exactHolderTarget`) — so a session sees nothing addressed to another session, to a
   * generation it no longer holds, or to a runtime it replaced. Expired rows are not listed; they
   * cannot be acknowledged either.
   */
  pendingInBandFor(sessionId: string, sessionIncarnation: string): InBandDispatch[] {
    const rows = this.db.all<RawOutbox>(
      `SELECT o.* FROM outbox o
        WHERE o.status = 'PENDING'
          AND o.target_session_id = ?
          AND o.expires_at > ?
          AND ${inBandRow("o")}
          AND ${exactHolderTarget("o")}
        ORDER BY o.created_at, o.rowid`,
      [sessionId, this.clock.nowIso(), sessionIncarnation],
    );
    return rows.map((row) => ({
      messageId: row.message_id,
      kind: row.kind as MessageKind,
      runId: row.run_id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      payload: readPayload(row.payload_json),
    }));
  }

  /**
   * Installs the CTO role's wake port. Rows enqueued before this are not woken by it; the next
   * `wakeInBandPending` finds them, which is why the composition root runs one right after.
   */
  attachInBandWake(wake: InBandWake): void {
    this.#inBandWake = wake;
  }

  /**
   * Wakes the role of every pending in-band row not woken for within `IN_BAND_REWAKE_MS`.
   *
   * Run on the daemon's delivery tick and once when the wake port is attached at startup. A row
   * whose target no longer holds its role generation is skipped: the fence sweeps will retire it,
   * and a wake to a former holder is the mistake `RoleConversationPort.wake` exists to refuse.
   * Never throws; a wake that fails is audited by `#wakeInBand` and tried again only after the
   * window, so an unreachable CTO costs one audit row per row per window, not a storm.
   */
  async wakeInBandPending(): Promise<void> {
    if (!this.#inBandWake) return;
    const now = this.clock.nowIso();
    const rows = this.db.all<{ message_id: string; role_key: string }>(
      `SELECT o.message_id, o.role_key FROM outbox o
        WHERE o.status = 'PENDING'
          AND o.expires_at > ?
          AND ${inBandRow("o")}
          AND ${liveDeliveryTarget("o")}
        ORDER BY o.created_at, o.rowid`,
      [now],
    );
    // The memory follows the queue: a row that left PENDING is forgotten, so it cannot grow.
    const pending = new Set(rows.map((row) => row.message_id));
    for (const messageId of [...this.#inBandWokenAt.keys()]) {
      if (!pending.has(messageId)) this.#inBandWokenAt.delete(messageId);
    }
    const nowMs = Date.parse(now);
    const due = rows
      .filter((row) => {
        const last = this.#inBandWokenAt.get(row.message_id);
        return last === undefined || nowMs - last >= IN_BAND_REWAKE_MS;
      })
      .map((row) => ({ messageId: row.message_id, roleKey: row.role_key }));
    await this.#wakeInBand(due, "rewake");
  }

  /**
   * One wake per role for these rows, fire-and-forget for the caller that does not await it.
   *
   * The rows are marked woken before the wake is sent, so a tick that runs while a wake is still in
   * flight does not send a second. Nothing is marked while no port is attached: no wake was tried.
   * The returned promise never rejects — a refused or thrown wake becomes one
   * `OUTBOX_IN_BAND_WAKE_FAILED` audit row carrying the decision's reason code and never the
   * thrown error's text, which for a socket error names the endpoint's private path.
   */
  #wakeInBand(rows: ReadonlyArray<{ messageId: string; roleKey: string }>, trigger: "enqueue" | "rewake"): Promise<void> {
    const wake = this.#inBandWake;
    if (!wake || rows.length === 0) return Promise.resolve();
    const nowMs = Date.parse(this.clock.nowIso());
    const byRole = new Map<string, string[]>();
    for (const row of rows) {
      this.#inBandWokenAt.set(row.messageId, nowMs);
      byRole.set(row.roleKey, [...(byRole.get(row.roleKey) ?? []), row.messageId]);
    }
    return Promise.all(
      [...byRole].map(async ([roleKey, messageIds]) => {
        let refused: ReasonCode | null = null;
        let threw = false;
        try {
          const woke = await wake(roleKey);
          if (!woke.allowed) refused = woke.reasonCode;
        } catch {
          refused = ReasonCode.ROLE_PEER_FAILED;
          threw = true;
        }
        if (refused === null) return;
        try {
          this.audit.record({
            kind: "OUTBOX_IN_BAND_WAKE_FAILED",
            reasonCode: refused,
            roleKey,
            evidence: { trigger, messageIds, threw },
          });
        } catch {
          // A closed database cannot take the row; the wake is retried after the window anyway.
        }
      }),
    ).then(() => undefined);
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
    options: {
      /**
       * Revoke shape only (`fromGeneration === toGeneration`), and only from
       * `BindingRegistry.revoke`'s `holdPeerMessagesForSameActorSuccessor`: a `PENDING`
       * `IDENTITY_BOUND_KINDS` row addressed to exactly `sessionId` and never carried before is
       * left untouched — neither retargeted nor rejected — and listed under `held`, for
       * `carryPeerMessagesToSameActorSuccessor` to carry or reject in the same transaction. Such a
       * row that *was* carried before is rejected as it would be without this option, and its id
       * is added to `alreadyCarried`. Every other row is decided exactly as it is without it.
       */
      holdPeerMessagesAddressedTo?: { sessionId: string; alreadyCarried: string[] };
    } = {},
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
    const held: string[] = [];
    const holdFor = toGeneration === fromGeneration ? options.holdPeerMessagesAddressedTo : undefined;

    for (const row of pending) {
      const holderClaimed = HOLDER_CLAIMED_KINDS.has(row.kind as MessageKind);
      // Whether the restart's carry, not this fence, records the CEO's notice for this row.
      let noticeOwedByCarry = false;
      // The hold (2026-10-03). Only `PENDING` — a `SENT` peer row's outcome is unknown and it is
      // rejected below as always — and only a row that has not been carried before. Whether it has
      // is the carry record's answer (ACP-PEER-SUCCESSION-01), never the row's `OUTBOX_RETARGETED`
      // mark, which any statement can set or clear: a row that already spent its one carry is
      // rejected here, not held, and reported in `alreadyCarried` so its refusal is recorded.
      if (
        holdFor !== undefined &&
        IDENTITY_BOUND_KINDS.has(row.kind as MessageKind) &&
        row.status === "PENDING" &&
        row.target_session_id === holdFor.sessionId
      ) {
        if (!this.#peerMessageCarried(row.message_id)) {
          held.push(row.message_id);
          continue;
        }
        holdFor.alreadyCarried.push(row.message_id);
        noticeOwedByCarry = true;
      }
      const retargetable = holderClaimed
        ? // A holder-claimed row moves only on a *successor takeover*, and only from `PENDING`.
          //
          // `PENDING` means nothing observable has happened to it: nobody was handed it, so the
          // successor may safely have it — the owner addressed a role, and the role still exists.
          // `SENT` falls through to the reject below, because its outcome is unknown and replaying
          // an owner's words into a runtime they were never addressed to is the one thing this
          // kind must never do.
          //
          // "May safely have it" is once. Whether this row has already been carried is not
          // readable from its status, so the compare-and-set below asserts it and a row that
          // fails that assertion falls through to the same reject.
          //
          // `fromGeneration === toGeneration` is the *revoke* shape, not a takeover:
          // `BindingRegistry.revoke` passes the current generation and session because there is
          // nothing to retarget onto, then runs its own direct `UPDATE outbox SET status =
          // 'REJECTED'` over every id returned here as `retargeted`. That write knows nothing about
          // ingress claims, so an owner-message reaching it would be settled behind this method's
          // back. Falling through to the reject below — which settles — is what makes that
          // unreachable rather than merely unused.
          //
          // No `expires_at` test: these rows do not expire. See `expireOverdue`.
          //
          // And never an `IDENTITY_BOUND_KINDS` row (#1044): a peer message was admitted for this
          // generation's exact session, so a successor is exactly who must not be handed it. It
          // falls through to the reject below, which settles its ingress claim. (The one exception,
          // the same conversation restarted, never reaches this line: the hold above takes it.)
          row.status === "PENDING" &&
          toGeneration !== fromGeneration &&
          !IDENTITY_BOUND_KINDS.has(row.kind as MessageKind)
        : row.status === "PENDING" &&
          RETARGETABLE_KINDS.has(row.kind as MessageKind) &&
          row.expires_at > now;
      // Compare-and-set rather than a bare write, and for a holder-claimed row the set it asserts
      // includes *this row has not been carried before*. `PENDING` cannot tell the two apart: a
      // row a previous takeover moved looks exactly like one that was never moved, so `G1 -> G2`
      // followed by `G2 -> G3` handed the owner's words to a second stranger's conversation and
      // would hand them to a third. `OUTBOX_RETARGETED` is the mark the first carry left, and a
      // row already carrying it changes nothing here and falls through to the rejection below —
      // which settles its ingress claim in this same transaction, rather than leaving it queued
      // for a generation nobody holds.
      const carriedOnce = holderClaimed ? " AND (reason_code IS NULL OR reason_code <> ?)" : "";
      const moved = retargetable
        ? this.db.run(
            `UPDATE outbox SET binding_generation = ?, target_session_id = ?, reason_code = ?
               WHERE message_id = ? AND status = 'PENDING'${carriedOnce}`,
            holderClaimed
              ? [
                  toGeneration, toSessionId, ReasonCode.OUTBOX_RETARGETED, row.message_id,
                  ReasonCode.OUTBOX_RETARGETED,
                ]
              : [toGeneration, toSessionId, ReasonCode.OUTBOX_RETARGETED, row.message_id],
          ).changes
        : 0;
      if (moved === 1) {
        retargeted.push(row.message_id);
      } else {
        this.db.run(
          `UPDATE outbox SET status = 'REJECTED', reason_code = ?,
                             claim_token = NULL, claimed_at = NULL,
                             retry_eligible = 0, next_attempt_at = NULL
            WHERE message_id = ?`,
          [
            !holderClaimed && row.expires_at <= now
              ? ReasonCode.OUTBOX_EXPIRED
              : ReasonCode.OUTBOX_STALE_GENERATION_REJECTED,
            row.message_id,
          ],
        );
        // A terminal transition out of `PENDING`/`SENT` with no successor to take it: the ingress
        // claim this row was holding open closes here, in this same transaction, or nothing does.
        if (holderClaimed) this.settleHolderClaimOrThrow(row.message_id);
        // ACP-RESTART-04: a queued CEO peer message rejected here is owed a notice to the CEO,
        // which the role's next holder is shown until it reports it. A revoke has no successor at
        // all and a takeover's is a different runtime, so this is never the carry's REFUSED record.
        if (
          IDENTITY_BOUND_KINDS.has(row.kind as MessageKind) && row.status === "PENDING" && !noticeOwedByCarry
        ) {
          this.#owePeerMessageNotice(
            row,
            toGeneration === fromGeneration ? PeerMessageNoticeReason.REVOKED : PeerMessageNoticeReason.REPLACED,
          );
        }
        rejected.push(row.message_id);
      }
    }

    this.audit.record({
      kind: "OUTBOX_FENCE",
      reasonCode: ReasonCode.OUTBOX_RETARGETED,
      roleKey,
      evidence: holdFor === undefined
        ? { fromGeneration, toGeneration, toSessionId, retargeted, rejected }
        : { fromGeneration, toGeneration, toSessionId, retargeted, rejected, held },
    });

    return { retargeted, rejected };
  }

  /**
   * The carry for peer messages a same-actor dead-predecessor recovery held (2026-10-03), called
   * inside the canonical self-claim's transaction once the successor generation is bound, with the
   * carry authority that claim minted for exactly that succession (ACP-PEER-SUCCESSION-01).
   *
   * #1044 rejects a queued `PEER_MESSAGE` on every takeover and runtime move, because it was
   * admitted for one exact CTO session and a successor is exactly who must not be handed it. A
   * canonical restart is the one move that does not hand it to anyone else: the conversation, its
   * actor and its Buzz channel identity are unchanged, and only the process and the generation
   * moved. So a held row is carried to the successor once, keeping its message id, its admitted
   * event and its stored proof, when — and only when — every one of these holds:
   *
   *   - the succession is proven (`PeerMessageSuccession.proven`): same actor, same conversation
   *     UUID, same Buzz signer, and this transaction's own `DEAD_BINDING_RECOVERED` row;
   *   - the row was never carried (no CARRIED record), never handed over, never in flight and never
   *     attempted, and the turn it opened has no receipt — not replied, not resolved as no-reply,
   *     not settled — and no canonical turn was dispatched for it;
   *   - its source is readable, it was admitted for exactly the released CTO generation and session,
   *     and it was addressed to the Buzz identity this conversation speaks as.
   *
   * A carry is a compare-and-set over the whole predecessor tuple plus a CARRIED record, written
   * under the authority's marker: the record, not the row's `OUTBOX_RETARGETED` mark, is what the
   * hand-over (`selfClaimCarriedTo`) accepts. The proof is never rewritten.
   *
   * Every other held row is rejected and its turn closed — which is what the revoke would have
   * done to it, keeping a receipt that already settled it (ACP-RESTART-03) — and a REFUSED record
   * with the reason category is written, with the notice the CEO is owed (ACP-RESTART-04), which
   * the role's holder is shown until one reports it (`role_owner_message_claim`'s
   * `refusedAtRestart`). So is each row in `alreadyCarried`, which the revoke itself rejected
   * because an earlier restart had carried it. A row this call finds already decided by someone
   * else inside this transaction is left exactly as it is.
   */
  carryPeerMessagesToSameActorSuccessor(
    authority: PeerMessageCarryAuthority,
    alreadyCarried: readonly string[] = [],
  ): { retargeted: string[]; rejected: string[] } {
    const succession = peerMessageCarrySuccessionOf(authority, this.db);
    if (succession === null) {
      return fail(ReasonCode.COMPLETION_AUTHORITY_DENIED, "PEER_MESSAGE_CARRY_AUTHORITY_DENIED", {});
    }
    const { roleKey, fromGeneration, fromSessionId, toGeneration, toSessionId } = succession;
    return this.db.tx(() => {
      const record = (row: RawOutbox, refusal: PeerMessageCarryRefusal | null): void => {
        const outcome = refusal === null ? "CARRIED" : "REFUSED";
        // ACP-RESTART-04: every refused row is owed a notice to the CEO, kept until a holder of the
        // role reports it — the successor or whoever holds the role after it.
        if (refusal !== null) this.#owePeerMessageNotice(row, refusal);
        // One refusal per message: a row revived and refused again keeps its first record.
        if (refusal !== null && this.db.get(
          `SELECT 1 AS present FROM peer_message_carries WHERE message_id = ? AND outcome = 'REFUSED'`,
          [row.message_id],
        )) return;
        const pointer = ownerMessagePointerOf(readPayload(row.payload_json));
        // ACP-RESTART-02: the record binds the digest of the admitted row its key names — read
        // from that row, not from the pointer — and the insert trigger checks it against that row.
        const sourcePayloadDigest = pointer
          ? this.#admittedPayloadDigest(pointer.sourceChannel, pointer.sourceNonce)
          : null;
        this.db.withPeerMessageCarry(authority, () =>
          this.db.run(
            `INSERT INTO peer_message_carries (
               message_id, outcome, refusal, source_channel, source_nonce, source_payload_digest, role_key,
               from_session_id, from_session_incarnation, from_binding_generation, from_assignment_id,
               to_session_id, to_session_incarnation, to_binding_generation, to_assignment_id,
               actor_id, conversation_uuid, buzz_actor_id, recovery_audit_event_id, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              row.message_id, outcome, refusal, pointer?.sourceChannel ?? null, pointer?.sourceNonce ?? null,
              sourcePayloadDigest,
              succession.roleKey,
              succession.fromSessionId, succession.fromSessionIncarnation, succession.fromGeneration,
              succession.fromAssignmentId,
              succession.toSessionId, succession.toSessionIncarnation, succession.toGeneration,
              succession.toAssignmentId,
              succession.actorId, succession.conversationUuid, succession.buzzActorId,
              succession.recoveryAuditEventId, this.clock.nowIso(),
            ],
          ));
      };

      // The revoke's own fence rejected these and settled their turns; only the notice is owed.
      for (const messageId of alreadyCarried) {
        const row = this.db.get<RawOutbox>(`SELECT * FROM outbox WHERE message_id = ?`, [messageId]);
        if (row && IDENTITY_BOUND_KINDS.has(row.kind as MessageKind) && row.status === "REJECTED") {
          record(row, PeerMessageCarryRefusal.ALREADY_CARRIED);
        }
      }

      const rows = this.db.all<RawOutbox>(
        `SELECT * FROM outbox
          WHERE role_key = ? AND binding_generation = ?
            AND kind IN (${HOLDER_CLAIMED_KIND_SQL})
            AND status IN ('PENDING','IN_FLIGHT','SENT')
          ORDER BY created_at, rowid`,
        [roleKey, fromGeneration],
      ).filter((row) => IDENTITY_BOUND_KINDS.has(row.kind as MessageKind));
      if (rows.length === 0) return { retargeted: [], rejected: [] };

      const retargeted: string[] = [];
      const rejected: string[] = [];
      for (const read of rows) {
        let row = read;
        let refusal = this.#peerMessageCarryRefusal(row, succession);
        // Both writes name the whole tuple the read saw, so a row another writer decided in this
        // transaction — carried, handed over, rejected — changes nothing here and is left as it is.
        if (refusal === null) {
          const moved = this.db.run(
            `UPDATE outbox SET binding_generation = ?, target_session_id = ?, reason_code = ?
              WHERE message_id = ? AND status = 'PENDING' AND kind = ?
                AND role_key = ? AND binding_generation = ? AND target_session_id = ?
                AND attempts = 0 AND sent_at IS NULL AND claim_token IS NULL`,
            [
              toGeneration, toSessionId, ReasonCode.OUTBOX_RETARGETED, row.message_id, row.kind,
              roleKey, fromGeneration, fromSessionId,
            ],
          ).changes;
          if (moved === 1) {
            record(row, null);
            retargeted.push(row.message_id);
            continue;
          }
          // Not moved. Decided by someone else (no longer open at the released generation): left
          // alone. Still open there but changed since the read: decided again, and at worst
          // rejected — never left addressed to a generation nobody holds.
          const now = this.db.get<RawOutbox>(`SELECT * FROM outbox WHERE message_id = ?`, [row.message_id]);
          if (!now || now.role_key !== roleKey || now.binding_generation !== fromGeneration ||
              !["PENDING", "IN_FLIGHT", "SENT"].includes(now.status)) {
            continue;
          }
          row = now;
          refusal = this.#peerMessageCarryRefusal(now, succession) ?? PeerMessageCarryRefusal.ALREADY_CLAIMED;
        }
        const closed = this.db.run(
          `UPDATE outbox SET status = 'REJECTED', reason_code = ?,
                             claim_token = NULL, claimed_at = NULL,
                             retry_eligible = 0, next_attempt_at = NULL
            WHERE message_id = ? AND status = ? AND role_key = ? AND binding_generation = ?
              AND target_session_id = ?`,
          [
            ReasonCode.OUTBOX_STALE_GENERATION_REJECTED, row.message_id, row.status,
            roleKey, fromGeneration, row.target_session_id,
          ],
        ).changes;
        if (closed !== 1) continue;
        this.settleHolderClaimOrThrow(row.message_id);
        record(row, refusal);
        rejected.push(row.message_id);
      }

      this.audit.record({
        kind: "OUTBOX_FENCE",
        reasonCode: ReasonCode.OUTBOX_RETARGETED,
        roleKey,
        evidence: { fromGeneration, toGeneration, fromSessionId, toSessionId, retargeted, rejected },
      });
      return { retargeted, rejected };
    });
  }

  /** Whether a CARRIED record exists for this message: the once-only rule, and nothing else is. */
  #peerMessageCarried(messageId: string): boolean {
    return this.db.get<{ present: number }>(
      `SELECT 1 AS present FROM peer_message_carries WHERE message_id = ? AND outcome = 'CARRIED'`,
      [messageId],
    ) !== undefined;
  }

  /** The digest of the admitted payload stored at this ingress key, or null when unreadable. */
  #admittedPayloadDigest(channel: string, nonce: string): string | null {
    const source = this.db.get<{ payload_json: string | null }>(
      `SELECT payload_json FROM inbound_messages WHERE channel = ? AND nonce = ?`,
      [channel, nonce],
    );
    const admitted = source?.payload_json ? readPayload(source.payload_json) : null;
    return isPlainRecord(admitted) ? digestOf(admitted) : null;
  }

  /**
   * Records that the CEO is owed a notice for one queued peer message a fence just rejected
   * (ACP-RESTART-04): its id, the event and the identity that signed it, why, and the generation
   * and session it was addressed to — never the payload. Written in the rejecting fence's own
   * transaction, under a capability minted here for exactly this entry, so ordinary SQL cannot
   * write one and nothing can delete one. The first entry for a message stands: a row revived and
   * rejected again is not owed a second notice.
   */
  #owePeerMessageNotice(row: RawOutbox, reason: PeerMessageNoticeReason): void {
    if (this.db.get(
      `SELECT 1 AS present FROM peer_message_refusal_notices WHERE message_id = ? AND entry = 'OWED'`,
      [row.message_id],
    )) return;
    const pointer = ownerMessagePointerOf(readPayload(row.payload_json));
    const sender = pointer
      ? this.db.get<{ actor: string }>(
        `SELECT actor FROM inbound_messages WHERE channel = ? AND nonce = ?`,
        [pointer.sourceChannel, pointer.sourceNonce],
      )?.actor ?? null
      : null;
    const entry: PeerMessageNoticeEntry = {
      messageId: row.message_id,
      entry: "OWED",
      roleKey: row.role_key,
      reason,
      sender,
      sourceChannel: pointer?.sourceChannel ?? null,
      sourceNonce: pointer?.sourceNonce ?? null,
      bindingGeneration: row.binding_generation,
      sessionId: row.target_session_id,
      sessionIncarnation: null,
    };
    this.#writePeerMessageNotice(entry);
  }

  #writePeerMessageNotice(entry: PeerMessageNoticeEntry): void {
    this.db.withPeerMessageNotice(new PeerMessageNoticeAuthorityToken(this.db, entry), () =>
      this.db.run(
        `INSERT INTO peer_message_refusal_notices (
           message_id, entry, role_key, reason, sender, source_channel, source_nonce,
           binding_generation, session_id, session_incarnation, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          entry.messageId, entry.entry, entry.roleKey, entry.reason, entry.sender, entry.sourceChannel,
          entry.sourceNonce, entry.bindingGeneration, entry.sessionId, entry.sessionIncarnation,
          this.clock.nowIso(),
        ],
      ));
  }

  /**
   * The notices the CEO is still owed for this role's rejected peer messages (ACP-RESTART-04), as
   * the role's current holder is shown them — whoever holds the role now, the carry successor or
   * not. Every OWED entry of the role with no REPORTED one, oldest first, and nothing at all unless
   * `holder` is the exact current holder (`exactHolderTarget`): a former holder's tuple is shown
   * nothing. Metadata only. Only reads.
   */
  peerMessageRefusalNoticesFor(holder: HolderIdentity): PeerMessageRefusalNoticeRow[] {
    if (!this.#isExactHolder(holder)) return [];
    return this.db.all<PeerMessageRefusalNoticeRow>(
      `SELECT n.message_id, n.reason, n.sender, n.source_channel, n.source_nonce
         FROM peer_message_refusal_notices n
        WHERE n.role_key = ? AND n.entry = 'OWED'
          AND NOT EXISTS (
            SELECT 1 FROM peer_message_refusal_notices r
             WHERE r.message_id = n.message_id AND r.entry = 'REPORTED'
          )
        ORDER BY n.created_at, n.message_id`,
      [holder.roleKey],
    );
  }

  /**
   * The role's current holder reports that it told the CEO about one rejected peer message
   * (ACP-RESTART-04), which retires that notice for every later holder. Exact current holder only,
   * and only for a notice this role is owed; a repeat by any current holder answers OK and writes
   * nothing, so a lost acknowledgement can be retried.
   */
  reportPeerMessageRefusal(messageId: string, holder: HolderIdentity): Decision<void> {
    return this.db.txDecision(() => {
      if (!this.#isExactHolder(holder)) {
        return deny(ReasonCode.OUTBOX_STALE_GENERATION_REJECTED, "only the role's current holder may report a refusal notice", {
          messageId,
        });
      }
      const owed = this.db.get<{ present: number }>(
        `SELECT 1 AS present FROM peer_message_refusal_notices
          WHERE message_id = ? AND entry = 'OWED' AND role_key = ?`,
        [messageId, holder.roleKey],
      );
      if (!owed) {
        return deny(ReasonCode.NOT_FOUND, "this role is owed no refusal notice for that message", { messageId });
      }
      if (this.db.get(
        `SELECT 1 AS present FROM peer_message_refusal_notices WHERE message_id = ? AND entry = 'REPORTED'`,
        [messageId],
      )) {
        return allow(ReasonCode.OK, undefined);
      }
      this.#writePeerMessageNotice({
        messageId,
        entry: "REPORTED",
        roleKey: holder.roleKey,
        reason: null,
        sender: null,
        sourceChannel: null,
        sourceNonce: null,
        bindingGeneration: holder.bindingGeneration,
        sessionId: holder.targetSessionId,
        sessionIncarnation: holder.sessionIncarnation,
      });
      return allow(ReasonCode.OK, undefined);
    });
  }

  /** `exactHolderTarget` for a caller-supplied holder tuple. Only reads. */
  #isExactHolder(holder: HolderIdentity): boolean {
    return this.db.get<{ held: number }>(
      `SELECT ${exactHolderTarget("bound")} AS held`,
      [holder.roleKey, holder.bindingGeneration, holder.targetSessionId, holder.sessionIncarnation],
    )?.held === 1;
  }

  /**
   * Why one held peer row may not be carried to `succession`'s successor, or null when it may.
   * Only reads. The order puts what already happened to the row before what it was admitted as,
   * so the category the successor is shown names the first thing that made a carry impossible.
   */
  #peerMessageCarryRefusal(row: RawOutbox, succession: PeerMessageSuccession): PeerMessageCarryRefusal | null {
    if (this.#peerMessageCarried(row.message_id)) return PeerMessageCarryRefusal.ALREADY_CARRIED;
    // Unclaimed: never handed over, never in flight, never attempted. UNKNOWN and IN_DOUBT
    // outcomes are reconciled with what they already have, never moved.
    if (
      row.status !== "PENDING" || row.attempts !== 0 || (row.sent_at ?? null) !== null ||
      (row.claim_token ?? null) !== null
    ) {
      return PeerMessageCarryRefusal.ALREADY_CLAIMED;
    }
    if (row.target_session_id !== succession.fromSessionId) return PeerMessageCarryRefusal.DIFFERENT_LINEAGE;
    // A peer row carrying the retarget mark with no carry record was moved by something that is not
    // a carry (#1044 retargets no identity-bound row). The mark admits nothing; it can still refuse.
    if (row.reason_code === ReasonCode.OUTBOX_RETARGETED) return PeerMessageCarryRefusal.DIFFERENT_LINEAGE;
    const pointer = ownerMessagePointerOf(readPayload(row.payload_json));
    if (!pointer) return PeerMessageCarryRefusal.SOURCE_UNREADABLE;
    const source = this.db.get<{ payload_json: string | null; turn_claim_json: string | null }>(
      `SELECT payload_json, turn_claim_json FROM inbound_messages WHERE channel = ? AND nonce = ?`,
      [pointer.sourceChannel, pointer.sourceNonce],
    );
    const admitted = source?.payload_json ? readPayload(source.payload_json) : null;
    if (!isPlainRecord(admitted) || digestOf(admitted) !== pointer.sourcePayloadDigest) {
      return PeerMessageCarryRefusal.SOURCE_UNREADABLE;
    }
    // No receipt: the turn this message opened is still open, and no canonical turn ran for it.
    if (source?.turn_claim_json != null) {
      const claim = readPayload(source.turn_claim_json);
      if (!isPlainRecord(claim)) return PeerMessageCarryRefusal.SOURCE_UNREADABLE;
      if (claim["repliedAt"] !== undefined || claim["noReplyAt"] !== undefined || claim["settledAt"] !== undefined) {
        return PeerMessageCarryRefusal.ALREADY_CLAIMED;
      }
    }
    if (this.db.get(`SELECT 1 AS present FROM canonical_turns WHERE turn_request_id = ?`, [row.message_id])) {
      return PeerMessageCarryRefusal.ALREADY_CLAIMED;
    }
    // Lineage: admitted for exactly the released CTO generation and session.
    const proof = admitted["peer"];
    if (
      !isPlainRecord(proof) || proof["ctoRoleKey"] !== succession.roleKey ||
      proof["ctoBindingGeneration"] !== succession.fromGeneration ||
      proof["ctoSessionId"] !== succession.fromSessionId
    ) {
      return PeerMessageCarryRefusal.DIFFERENT_LINEAGE;
    }
    // Signer: addressed to the Buzz channel identity this conversation speaks as.
    const mention = typeof admitted["mention"] === "string" ? admitted["mention"].trim() : null;
    if (mention !== succession.buzzActorId) return PeerMessageCarryRefusal.DIFFERENT_ACTOR_OR_SIGNER;
    // Actor, conversation UUID, signer and the recovery record, as the self-claim read them back.
    if (!succession.proven) return PeerMessageCarryRefusal.DIFFERENT_ACTOR_OR_SIGNER;
    return null;
  }

  /**
   * The owner-message half of a *surviving* switch, called inside that switch's transaction.
   *
   * `retargetOrReject` above is the takeover: a new generation, a different counterpart, and the
   * queued row is carried to it once. This is the other move #493 introduced and nothing here
   * followed — `conversation: "SURVIVED"`, where the binding is not rewritten at all and only
   * `conversational_actors.current_session_id` changes. The generation is the same, the
   * conversation is the same, and the process the row is addressed to is gone.
   *
   * So the two statuses part company for the same reason they do on a takeover, and not for the
   * same reason as each other:
   *
   *   `PENDING`  nothing observable happened to it. The counterpart it was addressed to is the one
   *              still holding the role, so the row is simply re-addressed to where that
   *              counterpart now runs. It is not stamped `OUTBOX_RETARGETED`: that mark means "was
   *              carried across a generation to a different conversation", and spending it here
   *              would cost the message the one takeover it is still entitled to.
   *   `SENT`     the previous runtime was handed the payload and never came back, so its outcome
   *              is unknown, and the process that would have known is the one that died. Handing
   *              it to the new runtime would replay an owner's words into a process that never saw
   *              them; leaving it would strand it, because no live holder can claim `SENT`. It is
   *              rejected here and its ingress claim settled in this same transaction.
   *
   * A move that goes nowhere is not a move: when both ends of the carry name one and the same
   * runtime, nothing was replaced, so there is no departed runtime for an unresolved hand-over to
   * have died with, and burning it would be this method inventing a failure out of a no-op.
   */
  carryHolderMessagesToRuntime(
    roleKey: string,
    bindingGeneration: number,
    fromSessionId: string,
    toSessionId: string,
  ): { carried: string[]; rejected: string[] } {
    if (fromSessionId === toSessionId) return { carried: [], rejected: [] };
    return this.db.tx(() => {
      const rows = this.db.all<RawOutbox>(
        `SELECT * FROM outbox
          WHERE role_key = ? AND binding_generation = ? AND target_session_id = ?
            AND kind IN (${HOLDER_CLAIMED_KIND_SQL})
            AND status IN ('PENDING','SENT')
          ORDER BY created_at, message_id`,
        [roleKey, bindingGeneration, fromSessionId],
      );

      const carried: string[] = [];
      const rejected: string[] = [];
      for (const row of rows) {
        // Exact compare-and-set on the whole tuple the caller named, not on the row id: the read
        // above and this write are two statements, and a row that stopped being this role's, this
        // generation's or this runtime's in between must move nothing.
        // Never an `IDENTITY_BOUND_KINDS` row (#1044): the generation is the same, but the receiving
        // session a peer message was admitted for is the one that just went, so it is rejected
        // below rather than re-addressed to a runtime its proof does not name.
        const moved =
          row.status === "PENDING" && !IDENTITY_BOUND_KINDS.has(row.kind as MessageKind)
            ? this.db.run(
                `UPDATE outbox SET target_session_id = ?
                  WHERE message_id = ? AND status = 'PENDING'
                    AND kind IN (${HOLDER_CLAIMED_KIND_SQL})
                    AND role_key = ? AND binding_generation = ? AND target_session_id = ?`,
                [toSessionId, row.message_id, roleKey, bindingGeneration, fromSessionId],
              ).changes
            : 0;
        if (moved === 1) {
          carried.push(row.message_id);
          continue;
        }
        this.db.run(
          `UPDATE outbox SET status = 'REJECTED', reason_code = ?,
                             claim_token = NULL, claimed_at = NULL,
                             retry_eligible = 0, next_attempt_at = NULL
            WHERE message_id = ? AND status IN ('PENDING','SENT')`,
          [ReasonCode.OUTBOX_STALE_GENERATION_REJECTED, row.message_id],
        );
        this.settleHolderClaimOrThrow(row.message_id);
        // ACP-RESTART-04: the queued CEO peer message this move rejected is owed a notice.
        if (IDENTITY_BOUND_KINDS.has(row.kind as MessageKind) && row.status === "PENDING") {
          this.#owePeerMessageNotice(row, PeerMessageNoticeReason.RUNTIME_MOVED);
        }
        rejected.push(row.message_id);
      }

      this.audit.record({
        kind: "OUTBOX_FENCE",
        reasonCode: ReasonCode.OUTBOX_RETARGETED,
        roleKey,
        evidence: { bindingGeneration, fromSessionId, toSessionId, carried, rejected },
      });

      return { carried, rejected };
    });
  }

  /**
   * A queued message whose delivery window has passed. Holder-claimed kinds have no such window.
   *
   * `enqueue` stamps every row with `DEFAULT_TTL_MS` unless the caller names one, so an
   * `OWNER_MESSAGE` used to become `EXPIRED` thirty minutes after it was written — silently, on the
   * next `claimDeliverable` or `Daemon.reconcile`, and terminally: `claimForHolder` requires
   * `PENDING`, `fenceUndeliverable` skips a row that is neither `PENDING`/`IN_FLIGHT` nor `SENT`,
   * and the holder never learned the message existed.
   *
   * A TTL is a statement about a *delivery attempt* — after this instant, stop trying to send. An
   * owner-message is not sent; it is queued for a holder that comes and takes it, and there is no
   * instant after which an owner's words stop being addressed to the role. So the kinds are
   * excluded here, and — because a status the claim path refuses to look at is the same strand
   * wearing a different word — `claimForHolder`'s two `expires_at` conditions are gone with it.
   */
  expireOverdue(): number {
    const result = this.db.run(
      `UPDATE outbox SET status = 'EXPIRED', reason_code = ?,
                         retry_eligible = 0, next_attempt_at = NULL
        WHERE status IN ('PENDING','IN_FLIGHT')
          AND kind NOT IN (${HOLDER_CLAIMED_KIND_SQL})
          AND expires_at <= ?`,
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
      .all<RawOutbox>(`SELECT * FROM outbox WHERE run_id = ? ORDER BY created_at, message_id`, [runId])
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
   * (wrong incarnation) and so the row sits `SENT` forever. The `NOT liveDeliveryTarget` condition
   * is what keeps this off a live holder's outstanding message, which stays claimable and
   * settleable.
   *
   * The mirror of that asymmetry is that a holder-claimed row is *excluded* from the
   * `PENDING`/`IN_FLIGHT` arm, which every other kind is in. A queued owner-message was handed to
   * nobody, so nothing observable has happened to it and it is still safely movable: it belongs to
   * whoever takes the role next, and `retargetOrReject` is what moves it there on a takeover or
   * closes it on a revoke. Fencing it here would be a terminal transition taken by a sweep that has
   * no successor to offer and no idea a takeover is one instant away.
   *
   * Every row this *does* burn out of `SENT` has its ingress claim settled below, in this same
   * transaction.
   */
  fenceUndeliverable(): number {
    return this.db.tx(() => {
      // Read the holder-claimed rows this call is about to burn *before* burning them: after the
      // UPDATE their status no longer says which ones moved, and each of them owns an ingress
      // claim that closes in this same transaction.
      const stranded = this.db
        .all<{ message_id: string }>(
          `SELECT message_id FROM outbox
            WHERE status = 'SENT' AND kind IN (${HOLDER_CLAIMED_KIND_SQL})
              AND NOT ${liveDeliveryTarget("outbox")}`,
        )
        .map((row) => row.message_id);
      const changes = this.db.run(
        `UPDATE outbox SET status = 'REJECTED', reason_code = ?, claim_token = NULL, claimed_at = NULL,
                           retry_eligible = 0, next_attempt_at = NULL
          WHERE (
                  (status IN ('PENDING','IN_FLIGHT')
                    AND kind NOT IN (${HOLDER_CLAIMED_KIND_SQL}))
                  OR (status = 'SENT' AND kind IN (${HOLDER_CLAIMED_KIND_SQL}))
                )
            AND NOT ${liveDeliveryTarget("outbox")}`,
        [ReasonCode.OUTBOX_STALE_GENERATION_REJECTED],
      ).changes;
      for (const messageId of stranded) this.settleHolderClaimOrThrow(messageId);
      return changes;
    });
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
    // The same current holder the delivery predicates use, and for the same reason: after a
    // surviving runtime move the assignment's own session names a process that is gone, so an
    // admission that asked it would refuse the owner's next message to a role that plainly has a
    // holder — the registry hands the caller that holder's session id and this would not admit it.
    const holder = this.db.get(
      `SELECT 1 FROM assignments a
        ${HOLDER_ACTOR_JOIN}
        JOIN sessions s ON s.session_id = ${CURRENT_HOLDER_SESSION}
        WHERE a.role_key = ? AND a.binding_generation = ?
          AND ${CURRENT_HOLDER_SESSION} = ?
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

/**
 * Why a held peer message was not carried to the restarted conversation (ACP-PEER-SUCCESSION-01).
 * Stored on its REFUSED carry record and shown to the successor; the schema's CHECK lists the same
 * five.
 */
export const PeerMessageCarryRefusal = {
  /** The actor, conversation UUID, Buzz signer or recovery record is not one continuous restart. */
  DIFFERENT_ACTOR_OR_SIGNER: "DIFFERENT_ACTOR_OR_SIGNER",
  /** The row, or its admission proof, names a CTO other than the released generation's session. */
  DIFFERENT_LINEAGE: "DIFFERENT_LINEAGE",
  /** An earlier restart carried it once already: one hop only. */
  ALREADY_CARRIED: "ALREADY_CARRIED",
  /** It was handed over, in flight or attempted, or its turn already has a receipt. */
  ALREADY_CLAIMED: "ALREADY_CLAIMED",
  /** Its pointer, its admitted source or its turn claim cannot be read as admitted. */
  SOURCE_UNREADABLE: "SOURCE_UNREADABLE",
} as const;
export type PeerMessageCarryRefusal = (typeof PeerMessageCarryRefusal)[keyof typeof PeerMessageCarryRefusal];

/**
 * Why a queued peer message the CEO is owed a notice for was rejected (ACP-RESTART-04): the path
 * that rejected it, or — when a canonical restart refused to carry it — that refusal's category.
 * The schema's CHECK lists the same eight.
 */
export const PeerMessageNoticeReason = {
  /** The generation it was addressed to was revoked with no successor: a plain revoke or the operator's dead-binding door. */
  REVOKED: "REVOKED",
  /** Another runtime took the role over. */
  REPLACED: "REPLACED",
  /** The same generation moved to another runtime. */
  RUNTIME_MOVED: "RUNTIME_MOVED",
  ...PeerMessageCarryRefusal,
} as const;
export type PeerMessageNoticeReason = (typeof PeerMessageNoticeReason)[keyof typeof PeerMessageNoticeReason];

/** One entry of `peer_message_refusal_notices`, exactly as its insert trigger compares it. */
export interface PeerMessageNoticeEntry {
  readonly messageId: string;
  readonly entry: "OWED" | "REPORTED";
  readonly roleKey: string;
  readonly reason: PeerMessageNoticeReason | null;
  readonly sender: string | null;
  readonly sourceChannel: string | null;
  readonly sourceNonce: string | null;
  readonly bindingGeneration: number;
  readonly sessionId: string;
  readonly sessionIncarnation: string | null;
}

/** An owed notice as `peerMessageRefusalNoticesFor` reads it. */
export interface PeerMessageRefusalNoticeRow {
  message_id: string;
  reason: string;
  sender: string | null;
  source_channel: string | null;
  source_nonce: string | null;
}

/**
 * The capability to write one refusal-notice entry (ACP-RESTART-04).
 *
 * Minted only inside this module — at the fence that rejects a queued peer message and at the
 * current holder's report — for exactly the entry it is about to write; the class is not exported,
 * so no other module can make one, and `Db.withPeerMessageNotice` checks the brand before it raises
 * the marker the entry's insert trigger requires. The same pattern as the carry authority.
 */
class PeerMessageNoticeAuthorityToken {
  readonly #minted = true;
  readonly #db: Db;
  readonly #entry: PeerMessageNoticeEntry;

  constructor(db: Db, entry: PeerMessageNoticeEntry) {
    this.#db = db;
    this.#entry = Object.freeze({ ...entry });
    Object.freeze(this);
  }

  static entryOf(value: unknown, db: Db): PeerMessageNoticeEntry | null {
    if (typeof value !== "object" || value === null || !(#minted in value)) return null;
    return value.#db === db ? value.#entry : null;
  }
}
export type PeerMessageNoticeAuthority = PeerMessageNoticeAuthorityToken;
/** The entry a notice authority names, or null when `value` is not one issued for `db`. */
export const peerMessageNoticeEntryOf = PeerMessageNoticeAuthorityToken.entryOf;

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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
  claim_token?: string | null;
  reason_code?: string | null;
}

/**
 * Projects a raw row onto the no-payload shape. `payload_json` is read off the row and simply
 * never copied — the destination type has no field for it.
 */
/** The row as a message, or null when its stored payload is not readable JSON. */
const readableMessage = (row: RawOutbox): OutboxMessage | null => {
  try {
    return hydrate(row);
  } catch {
    return null;
  }
};

/**
 * `claimForHolder`'s default: hand over no `IDENTITY_BOUND_KINDS` row (#1044). A peer message is
 * handed over only to a caller that supplies the predicate proving its proof still current.
 */
const withholdsIdentityBound = (candidate: OutboxMessage): boolean =>
  !IDENTITY_BOUND_KINDS.has(candidate.kind);

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

/** A stored payload for an in-band reader; one that is not readable JSON is shown as null. */
const readPayload = (payloadJson: string): unknown => {
  try {
    return JSON.parse(payloadJson) as unknown;
  } catch {
    return null;
  }
};

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
