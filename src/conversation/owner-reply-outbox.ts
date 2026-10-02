import { canonicalJson } from "../core/digest.ts";
import type { Clock } from "../core/clock.ts";
import { type Decision, acpError, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { Db } from "../db/database.ts";

/**
 * The owner-reply outbox lane (#1036): one durable item per turn a target receipt proved
 * `COMPLETED`, addressed to the conversation the owner asked from.
 *
 * Contract 6 pairs the two writes. A matched `COMPLETED` receipt moves the turn and inserts its
 * reply item in one transaction, so no reader can observe a completed turn whose reply obligation
 * was never written down. `enqueueOwnerReply` is only ever called inside that transaction and
 * refuses to run outside one.
 *
 * **Stored in `inbound_messages`, under a channel of its own.** No schema change: the row already
 * has what an outbox item needs, enforced by triggers that exist today — one row per
 * `(channel, nonce)` (`inbound_messages_no_replace`), an immutable `payload_json`
 * (`inbound_messages_payload_immutable`), and no delete without the per-channel ingress delete
 * authority. The nonce is the turn id, so a second item for one turn cannot be inserted.
 * `result_json` is the item's delivery lifecycle, which is what that column already holds for a
 * Telegram row. The owner-prompt reservation (`telegram-owner-prompt`) stores outbound state in
 * this table the same way. No admit path writes this channel, so `IngressGuard.prune` never runs
 * against it.
 *
 * A table of its own was decided against: a foreign key to `canonical_turns` cannot hold for the
 * ingress lane, whose turn ids are not in that table, and a new schema version means editing the
 * digest-pinned `migrations.ts` and an approved live migration. The governed `outbox` table was
 * ruled out too, rather than given an owner-reply kind: its rows are fenced to a role's session
 * and swept by expiry, fencing and the generic delivery loop, none of which an owner reply may
 * pass through before a consumer exists.
 *
 * **What this lane does not do yet: deliver.** No consumer reads it. `ReceiptLookupResult` hands
 * the coordinator the reply's digest and not its text (for a Hermes `COMPLETED` receipt the
 * evidence digest is the digest of the assistant content), so the item pins *which* reply may be
 * delivered without holding one a sender could post. The U6 surface path delivers through the
 * governed outbox once the Hermes side carries canonical replies with signer provenance
 * (MongLong0214/hermes-agent#63); whatever text it delivers must hash to the item's
 * `evidenceDigest`. Until then an item stays `PENDING` and readable through `pendingOwnerReplies`.
 */
export const OWNER_REPLY_OUTBOX_CHANNEL = "owner-reply";

/** Which ledger proved the turn complete. The two ledgers mint different turn ids. */
export type OwnerReplyLedger = "CANONICAL_TURN" | "INGRESS_CLAIM";

/**
 * Where the reply goes, read from the turn's durable ingress row at settlement time and copied
 * into the item, because a terminal ingress row can be pruned after its retention window and the
 * reply must still know where it goes.
 *
 * Each field is what that row actually holds, and nothing is reconstructed:
 *
 * - `conversation` — the room the row's own signed payload names (Buzz). `null` for Telegram:
 *   its admitted payload is `{text, messageId}`, and the audit trail stores `conversation` as
 *   `[not-stored]`, so no durable record holds a Telegram chat id in the clear.
 * - `scopeDigest` — the row's turn claim `sessionDigest`, the project/chat/thread/reply-root scope
 *   the batch was composed under.
 * - `chatDigest` — the claim's `legacySessionDigest`, `digestOf({channel, conversation: chatId})`.
 *   For Telegram this is how a sender finds the chat: the configured chat allowlist is finite, and
 *   exactly one entry hashes to it.
 * - `replyToMessageId` — the admitted payload's `messageId` (Telegram), which threads the answer
 *   under the owner's own message.
 */
export interface OwnerReplyAddress {
  readonly channel: string;
  readonly sourceNonce: string;
  readonly conversation: string | null;
  readonly scopeDigest: string | null;
  readonly chatDigest: string | null;
  readonly replyToMessageId: number | null;
}

/** The receipt that created the obligation. The reply itself is named by `evidenceDigest`. */
export interface OwnerReplyReceipt {
  readonly authority: "HERMES_TARGET";
  readonly receiptId: string;
  readonly evidenceDigest: string;
  readonly reasonCode: string;
}

export interface OwnerReplyItem {
  readonly turnRequestId: string;
  readonly ledger: OwnerReplyLedger;
  readonly targetActorId: string;
  readonly address: OwnerReplyAddress;
  readonly receipt: OwnerReplyReceipt;
  /** Only `PENDING` exists until a consumer is built; a consumer adds its own terminal states. */
  readonly status: "PENDING";
  readonly enqueuedAt: string;
}

export interface OwnerReplySource {
  readonly channel: string;
  readonly nonce: string;
}

export interface EnqueueOwnerReplyInput {
  readonly turnRequestId: string;
  readonly ledger: OwnerReplyLedger;
  readonly targetActorId: string;
  /** The turn's ingress messages in batch order. The reply answers the last one. */
  readonly sources: readonly OwnerReplySource[];
  readonly receipt: OwnerReplyReceipt;
}

type StoredPayload = Omit<OwnerReplyItem, "status" | "enqueuedAt">;

const payloadRecord = (payloadJson: string | null): Record<string, unknown> | null => {
  try {
    const value: unknown = JSON.parse(payloadJson ?? "null");
    if (value === null) return null;
    if (typeof value !== "object") return null;
    return Array.isArray(value) ? null : value as Record<string, unknown>;
  } catch {
    return null;
  }
};

const textOf = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  return value.trim() === "" ? null : value;
};

const replyToOf = (payload: Record<string, unknown> | null): number | null => {
  const messageId = payload?.["messageId"];
  if (typeof messageId !== "number") return null;
  if (!Number.isSafeInteger(messageId)) return null;
  return messageId > 0 ? messageId : null;
};

type Thread = Pick<OwnerReplyAddress, "conversation" | "scopeDigest" | "chatDigest">;

/** What one ingress row durably says about where it came from, or a refusal. */
const admittedSource = (
  db: Db,
  source: OwnerReplySource,
): Decision<{ thread: Thread; payload: Record<string, unknown> | null }> => {
  const row = db.get<{ payload_json: string | null; turn_claim_json: string | null }>(
    `SELECT payload_json, turn_claim_json FROM inbound_messages WHERE channel = ? AND nonce = ?`,
    [source.channel, source.nonce],
  );
  if (!row) {
    return deny(
      ReasonCode.CONVERSATION_TURN_REPLY_UNADDRESSABLE,
      "an ingress message this turn answers has no durable row",
      { channel: source.channel, nonce: source.nonce },
    );
  }
  const payload = payloadRecord(row.payload_json);
  const claim = payloadRecord(row.turn_claim_json);
  const thread: Thread = {
    conversation: textOf(payload?.["conversation"]),
    scopeDigest: textOf(claim?.["sessionDigest"]),
    chatDigest: textOf(claim?.["legacySessionDigest"]),
  };
  // Neither a signed room nor a claimed scope: nothing durable says which conversation this
  // message belongs to, and a reply addressed by guess is worse than one not sent.
  if (thread.conversation === null) {
    if (thread.scopeDigest === null) {
      return deny(
        ReasonCode.CONVERSATION_TURN_REPLY_UNADDRESSABLE,
        "an ingress message this turn answers names no durable conversation",
        { channel: source.channel, nonce: source.nonce },
      );
    }
  }
  return allow(ReasonCode.OK, { thread, payload });
};

/**
 * The one conversation every source of the turn arrived on, or a refusal.
 *
 * A batch is scoped to one conversation when it is composed, so sources that disagree here mean
 * the ledger holds something that scoping should have prevented. The reply then has no single
 * place to go, and guessing one is how an answer reaches the wrong room.
 */
export const ownerReplyAddressFor = (
  db: Db,
  sources: readonly OwnerReplySource[],
): Decision<OwnerReplyAddress> => {
  const anchor = sources.at(-1);
  if (!anchor) {
    return deny(ReasonCode.CONVERSATION_TURN_REPLY_UNADDRESSABLE, "the turn names no ingress message to answer", {});
  }
  const answered = admittedSource(db, anchor);
  if (!answered.allowed) return deny(answered.reasonCode, answered.message, answered.evidence);
  for (const source of sources) {
    const admitted = admittedSource(db, source);
    if (!admitted.allowed) return deny(admitted.reasonCode, admitted.message, admitted.evidence);
    if (source.channel !== anchor.channel) {
      return deny(
        ReasonCode.CONVERSATION_TURN_REPLY_UNADDRESSABLE,
        "the turn's ingress messages arrived on different channels",
        { channels: [source.channel, anchor.channel] },
      );
    }
    if (canonicalJson(admitted.value.thread) !== canonicalJson(answered.value.thread)) {
      return deny(
        ReasonCode.CONVERSATION_TURN_REPLY_UNADDRESSABLE,
        "the turn's ingress messages arrived on different conversations",
        { channel: source.channel, nonce: source.nonce },
      );
    }
  }
  return allow(ReasonCode.OK, {
    channel: anchor.channel,
    sourceNonce: anchor.nonce,
    ...answered.value.thread,
    replyToMessageId: replyToOf(answered.value.payload),
  });
};

/**
 * Inserts the reply item for one completed turn, inside the caller's settlement transaction.
 *
 * Idempotent on the exact item: an existing row for this turn with the same payload is a
 * redelivery and changes nothing. A row for this turn with a different payload, or another turn's
 * row already answering the same ingress message, is refused — two items would be two replies to
 * one owner message, and only the first can be right.
 *
 * Returns a denial rather than throwing for every refusal it can name, so the caller's
 * `txDecision` rolls the settlement back with it. A database error still throws, which rolls back
 * the same way.
 */
export const enqueueOwnerReply = (
  db: Db,
  clock: Clock,
  input: EnqueueOwnerReplyInput,
): Decision<{ item: OwnerReplyItem; replayed: boolean }> => {
  if (!db.inTransaction) {
    // Programming error, not a state: outside the settlement transaction the item and the turn
    // are two commits, which is the half-written state this lane exists to make unreachable.
    throw acpError(
      ReasonCode.INTERNAL_ERROR,
      "an owner reply must be enqueued inside the transaction that settles its turn",
      { turnRequestId: input.turnRequestId },
    );
  }
  const address = ownerReplyAddressFor(db, input.sources);
  if (!address.allowed) {
    return deny(address.reasonCode, address.message, { ...address.evidence, turnRequestId: input.turnRequestId });
  }

  const payload: StoredPayload = {
    turnRequestId: input.turnRequestId,
    ledger: input.ledger,
    targetActorId: input.targetActorId,
    address: address.value,
    receipt: {
      authority: input.receipt.authority,
      receiptId: input.receipt.receiptId,
      evidenceDigest: input.receipt.evidenceDigest,
      reasonCode: input.receipt.reasonCode,
    },
  };
  const payloadJson = canonicalJson(payload);

  const existing = db.get<{ payload_json: string | null; result_json: string | null; received_at: string }>(
    `SELECT payload_json, result_json, received_at FROM inbound_messages WHERE channel = ? AND nonce = ?`,
    [OWNER_REPLY_OUTBOX_CHANNEL, input.turnRequestId],
  );
  if (existing) {
    if (existing.payload_json !== payloadJson) {
      return deny(
        ReasonCode.CONVERSATION_TURN_REPLY_CONFLICT,
        "this turn already has an owner reply with different content",
        { turnRequestId: input.turnRequestId },
      );
    }
    return allow(ReasonCode.OK, { item: itemOf(input.turnRequestId, existing), replayed: true });
  }

  const sibling = db.get<{ nonce: string }>(
    `SELECT nonce FROM inbound_messages
      WHERE channel = ?
        AND json_extract(payload_json, '$.address.channel') = ?
        AND json_extract(payload_json, '$.address.sourceNonce') = ?
      ORDER BY received_at ASC, nonce ASC LIMIT 1`,
    [OWNER_REPLY_OUTBOX_CHANNEL, address.value.channel, address.value.sourceNonce],
  );
  if (sibling) {
    return deny(
      ReasonCode.CONVERSATION_TURN_REPLY_CONFLICT,
      "another turn already owes the owner a reply to this ingress message",
      { turnRequestId: input.turnRequestId, otherTurnRequestId: sibling.nonce },
    );
  }

  const enqueuedAt = clock.nowIso();
  const resultJson = canonicalJson({ status: "PENDING" });
  db.run(
    `INSERT INTO inbound_messages (channel, nonce, actor, received_at, payload_json, result_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [OWNER_REPLY_OUTBOX_CHANNEL, input.turnRequestId, input.targetActorId, enqueuedAt, payloadJson, resultJson],
  );
  return allow(ReasonCode.OK, {
    item: { ...payload, status: "PENDING", enqueuedAt },
    replayed: false,
  });
};

const itemOf = (
  turnRequestId: string,
  row: { payload_json: string | null; result_json: string | null; received_at: string },
): OwnerReplyItem => {
  const payload = payloadRecord(row.payload_json) as StoredPayload | null;
  const result = payloadRecord(row.result_json);
  if (payload === null) {
    throw acpError(ReasonCode.INTERNAL_ERROR, "an owner reply item has no readable payload", { turnRequestId });
  }
  if (result?.["status"] !== "PENDING") {
    throw acpError(ReasonCode.INTERNAL_ERROR, "an owner reply item has a status this build cannot read", { turnRequestId });
  }
  return { ...payload, status: "PENDING", enqueuedAt: row.received_at };
};

/** The reply item for one turn, or `null` when that turn owes none. */
export const ownerReplyFor = (db: Db, turnRequestId: string): OwnerReplyItem | null => {
  const row = db.get<{ payload_json: string | null; result_json: string | null; received_at: string }>(
    `SELECT payload_json, result_json, received_at FROM inbound_messages WHERE channel = ? AND nonce = ?`,
    [OWNER_REPLY_OUTBOX_CHANNEL, turnRequestId],
  );
  return row ? itemOf(turnRequestId, row) : null;
};

/** Every reply still owed, oldest first. An unreadable row throws rather than disappearing. */
export const pendingOwnerReplies = (db: Db): readonly OwnerReplyItem[] =>
  db.all<{ nonce: string; payload_json: string | null; result_json: string | null; received_at: string }>(
    `SELECT nonce, payload_json, result_json, received_at FROM inbound_messages
      WHERE channel = ?
      ORDER BY received_at ASC, nonce ASC`,
    [OWNER_REPLY_OUTBOX_CHANNEL],
  ).map((row) => itemOf(row.nonce, row));
