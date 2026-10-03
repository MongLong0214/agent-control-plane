import { canonicalJson, digestOf, sha256 } from "../core/digest.ts";
import type { Clock } from "../core/clock.ts";
import { type Decision, acpError, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { AuditLog } from "../db/audit.ts";
import type { Db } from "../db/database.ts";
import { BUZZ_MESSAGE_NONCE_PREFIX } from "../ingress/buzz-message.ts";

/**
 * The owner-reply outbox lane (#1036): one durable item per turn a target receipt proved
 * `COMPLETED`, addressed to the conversation the owner asked from.
 *
 * Contract 6 pairs the two writes. A matched `COMPLETED` receipt moves the turn and inserts its
 * reply item in one transaction, so no reader can observe a completed turn whose reply obligation
 * was never written down. `enqueueOwnerReply` runs only inside that transaction and only for the
 * holder of this database's `OwnerReplyAuthority`, which the turn coordinator claims once at
 * construction (#1041 review, R1041-03).
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
 * **Delivery (#1036).** The receipt's `evidenceDigest` names the reply. For a Hermes `COMPLETED`
 * receipt it is the digest of the assistant content. The text itself is carried too, as
 * `replyText`, when the receipt port supplies it, stored as its exact UTF-8 bytes (R1056-05). A
 * sender must refuse text that does not hash to that digest. `owner-reply-consumer.ts` is the sender. It records a delivery intent here before
 * it publishes, and records `DELIVERED` with an `evidenceDigest` of its own once the transport
 * accepts. An item it cannot deliver stays `PENDING`, with one audit row per cause. Items from a
 * build before this one carry no `replyText` and stay `PENDING` for that reason.
 *
 * Re-reading the receipt from Hermes at delivery time was decided against rather than adopted: the
 * sender would need the receipt port and the turn's whole identity, where the settlement already
 * holds the port's answer.
 */
export const OWNER_REPLY_OUTBOX_CHANNEL = "owner-reply";

/** Which ledger proved the turn complete. The two ledgers mint different turn ids. */
export type OwnerReplyLedger = "CANONICAL_TURN" | "INGRESS_CLAIM";

/**
 * Where the reply goes, derived from the originating ingress rows' immutable admitted payload and
 * copied into the item, because a terminal ingress row can be pruned after its retention window
 * and the reply must still know where it goes.
 *
 * `payload_json` is the one per-row record nothing can rewrite (`inbound_messages_payload_immutable`),
 * and it is checked against the digest `INGRESS_ADMITTED` recorded for that row before anything in
 * it is used. Nothing here reads `turn_claim_json`: its `legacySessionDigest` is not frozen by the
 * identity trigger, and a reply address that a later write could move is not an address (R1041-01).
 * Addressing from the claim's digests was dropped rather than frozen, because freezing them needs a
 * trigger change and so a migration, and a digest names a conversation without saying where it is.
 *
 * - Telegram: `conversation` is the payload's `chatId`, `threadId` its `messageThreadId`, and
 *   `replyToMessageId` its `messageId`. A row without a chat or a message id is unaddressable.
 * - Buzz: `conversation` is the room the signed envelope names. A row without one is unaddressable.
 *   `replyAs` is the payload's `mention`, when that is a channel identity: the daemon's own
 *   identity the owner wrote to, and so the one that answers.
 * - Any other channel is unaddressable: no reply route exists for it to be addressed by.
 */
export interface OwnerReplyAddress {
  readonly channel: string;
  readonly conversation: string;
  readonly threadId: number | null;
  readonly sourceNonce: string;
  readonly replyToMessageId: number | null;
  /**
   * The Buzz channel identity (hex pubkey) the reply is signed as (#1036). Present only on a Buzz
   * address whose message named one. An address without it, including every item written before
   * this field existed, has no identity to answer as, and its sender refuses it.
   */
  readonly replyAs?: string;
}

/** The receipt that created the obligation. The reply itself is named by `evidenceDigest`. */
export interface OwnerReplyReceipt {
  readonly authority: "HERMES_TARGET";
  readonly receiptId: string;
  readonly evidenceDigest: string;
  readonly reasonCode: string;
}

export interface OwnerReplySource {
  readonly channel: string;
  readonly nonce: string;
}

export interface OwnerReplyItem {
  readonly turnRequestId: string;
  readonly ledger: OwnerReplyLedger;
  readonly targetActorId: string;
  /** Every ingress message the reply answers, in batch order; the address is the last one's. */
  readonly sources: readonly OwnerReplySource[];
  readonly address: OwnerReplyAddress;
  readonly receipt: OwnerReplyReceipt;
  /**
   * The reply's text, when the receipt carried it (#1036). Its digest must equal
   * `receipt.evidenceDigest`. The sender checks that, not the writer. Absent on an item from a
   * receipt port that does not carry content, and on every item written before this field existed.
   * Read back byte for byte, CR and CRLF included (R1056-05).
   */
  readonly replyText?: string;
  /** `PENDING` until a sender records the transport's acceptance; then `DELIVERED`, for good. */
  readonly status: OwnerReplyStatus;
  readonly enqueuedAt: string;
  /** Only on a `DELIVERED` item: what the transport accepted, and the digest over it. */
  readonly delivery?: OwnerReplyDelivery;
}

export type OwnerReplyStatus = "PENDING" | "DELIVERED";

/** The acknowledgements a delivery can record. Nothing outside this list is ever stored. */
export type OwnerReplyRelayAck = "ACCEPTED" | "DUPLICATE";

/**
 * What a sender records when the transport accepted a reply (#1036). `evidenceDigest` is
 * `digestOf` over every other field, so the record names exactly what was accepted.
 */
export interface OwnerReplyDelivery {
  readonly transport: "buzz";
  readonly eventId: string;
  readonly signer: string;
  readonly conversation: string;
  readonly replyToEventId: string;
  readonly relayUrl: string;
  /**
   * What the relay's `OK` said, as a fixed category: `DUPLICATE` when it already held the event.
   * Never the relay's own text, which the relay chooses and may carry anything (R1056-04).
   */
  readonly relayAck: OwnerReplyRelayAck;
  /** The digest of the text published. Equal to the receipt's `evidenceDigest`. */
  readonly contentDigest: string;
  readonly deliveredAt: string;
  readonly evidenceDigest: string;
}

export interface EnqueueOwnerReplyInput {
  readonly turnRequestId: string;
  readonly ledger: OwnerReplyLedger;
  readonly targetActorId: string;
  /** The turn's ingress messages in batch order. The reply answers the last one. */
  readonly sources: readonly OwnerReplySource[];
  readonly receipt: OwnerReplyReceipt;
  /** The reply text the receipt carried, if any. Stored as is; a sender checks it against the digest. */
  readonly replyText?: string | null;
  /**
   * Whether a handler in this process is running for the message right now and may still hand its
   * answer out. Supplied by the coordinator from the ingress guard's handler registry, which a
   * handler enters when it starts and leaves when it finishes or throws (R1041-04).
   */
  readonly handlerRunning: (source: OwnerReplySource) => boolean;
}

/**
 * How an ingress claim records that a target receipt proved its turn `COMPLETED` and the answer is
 * owed through this lane (#1036): `settledAt` with this settlement, because that is the terminal
 * fact meaning "the outcome is no longer unknown" without claiming a transport accepted anything.
 * Named here because both the ingress guard (which writes it) and the coordinator (which checks it
 * before committing) need the one spelling.
 */
export const REPLY_OUTBOX_SETTLEMENT = "REPLY_OUTBOX";
/** The finished-result marker written beside that settlement; neither claimable nor recoverable. */
export const REPLY_OUTBOX_RESULT_KIND = "TELEGRAM_REPLY_OUTBOX";

/**
 * The right to write this lane for one database. Opaque; only `claimOwnerReplyAuthority` makes one.
 *
 * Claimed once per database identity, the way `Db.claimTurnMaterializationAuthority` is, and the
 * turn coordinator claims it at construction — so the only code that can create an obligation is
 * the code that has just verified a receipt. That closes the route where any caller holding a
 * transaction could insert an item with no settlement beside it (R1041-03). Like the database's
 * own authorities, it closes an ordering race rather than an in-process adversary: whoever
 * constructs first holds it.
 */
export interface OwnerReplyAuthority {
  readonly ownerReplyAuthorityFor: string;
}

const ISSUED_OWNER_REPLY_AUTHORITIES = new Map<string, OwnerReplyAuthority>();

export const claimOwnerReplyAuthority = (db: Db): OwnerReplyAuthority => {
  if (ISSUED_OWNER_REPLY_AUTHORITIES.has(db.identity)) {
    throw acpError(
      ReasonCode.COMPLETION_AUTHORITY_DENIED,
      "the owner-reply authority was already issued for this database",
      {},
    );
  }
  const authority: OwnerReplyAuthority = Object.freeze({ ownerReplyAuthorityFor: db.identity });
  ISSUED_OWNER_REPLY_AUTHORITIES.set(db.identity, authority);
  // Handed back when the handle that claimed it closes, as the database's own slots are, so a
  // process that reopens the same file can construct its coordinator again.
  db.releaseOnClose(() => {
    if (ISSUED_OWNER_REPLY_AUTHORITIES.get(db.identity) === authority) {
      ISSUED_OWNER_REPLY_AUTHORITIES.delete(db.identity);
    }
  });
  return authority;
};

/**
 * The right to settle one ingress claim from one receipt the turn coordinator verified (#1041
 * review, R1041-03).
 *
 * Minted only by `issueIngressReceiptSettlement`, which demands the database's owner-reply
 * authority — so only the coordinator holding it can mint one, and only after its sealed port
 * matched every identity field of the receipt. The ingress guard accepts nothing else.
 */
export interface IngressReceiptSettlement {
  readonly channel: string;
  readonly nonce: string;
  readonly query: {
    readonly turnRequestId: string;
    readonly targetActorId: string;
    readonly promptDigest: string;
    readonly bindingGeneration: number;
    readonly targetBindingId: string;
    readonly targetAttestationId: string;
    readonly executorSessionId: string;
    readonly executorSessionIncarnation: string;
  };
  readonly receipt: {
    readonly outcome: "COMPLETED" | "ABORTED";
    readonly receiptId: string;
    readonly evidenceDigest: string;
    readonly reasonCode: string;
  };
}

/** Each live settlement, keyed to the exact `Db` handle that issued it. */
const ISSUED_INGRESS_SETTLEMENTS = new WeakMap<object, Db>();

const assertAuthority = (authority: OwnerReplyAuthority, db: Db, turnRequestId: string): void => {
  if (ISSUED_OWNER_REPLY_AUTHORITIES.get(db.identity) !== authority) {
    throw acpError(
      ReasonCode.COMPLETION_AUTHORITY_DENIED,
      "only the holder of this database's owner-reply authority may do this",
      { turnRequestId },
    );
  }
};

export const issueIngressReceiptSettlement = (
  authority: OwnerReplyAuthority,
  db: Db,
  fields: IngressReceiptSettlement,
): IngressReceiptSettlement => {
  assertAuthority(authority, db, fields.query.turnRequestId);
  const settlement: IngressReceiptSettlement = Object.freeze({
    channel: fields.channel,
    nonce: fields.nonce,
    query: Object.freeze({ ...fields.query }),
    receipt: Object.freeze({ ...fields.receipt }),
  });
  ISSUED_INGRESS_SETTLEMENTS.set(settlement, db);
  return settlement;
};

/** Withdraws a settlement whether or not it was redeemed. The issuer calls this when it is done. */
export const withdrawIngressReceiptSettlement = (settlement: IngressReceiptSettlement): void => {
  ISSUED_INGRESS_SETTLEMENTS.delete(settlement);
};

/**
 * The settlement itself when `value` is one issued against this exact `Db` handle and not yet
 * redeemed; `null` otherwise. Redeeming spends it.
 *
 * Bound to the handle rather than to the file: a settlement minted by database A's coordinator and
 * handed to database B's guard settled B while A rolled its own half back (R1041-03, round 2). The
 * window is the issuer's own transaction: the coordinator issues it, opens its transaction on that
 * same handle before running any caller code, hands it to the closure inside, and withdraws it the
 * moment the transaction returns, so a live settlement can only be redeemed inside that transaction.
 */
export const redeemIngressReceiptSettlement = (value: unknown, db: Db): IngressReceiptSettlement | null => {
  // A WeakMap answers `undefined` for any key that is not a live object, primitives included.
  const settlement = value as IngressReceiptSettlement;
  if (ISSUED_INGRESS_SETTLEMENTS.get(settlement) !== db) return null;
  ISSUED_INGRESS_SETTLEMENTS.delete(settlement);
  return settlement;
};

type StoredPayload = Omit<OwnerReplyItem, "status" | "enqueuedAt" | "replyText" | "delivery"> & {
  /**
   * The reply text's exact UTF-8 bytes, in base64 (R1056-05). `canonicalJson` rewrites CR and
   * CRLF to LF in every string it encodes, and the text has to keep the bytes the receipt's digest
   * was taken over. Base64 carries no CR for it to rewrite. Changing `canonicalJson` was ruled out
   * rather than taken: its newline rule is what keeps other digests equal across checkouts.
   */
  readonly replyTextUtf8Base64?: string;
};

/** The item a stored payload describes, with its reply text decoded back to the exact string. */
const itemFrom = (
  payload: StoredPayload,
  enqueuedAt: string,
): Omit<OwnerReplyItem, "status" | "delivery"> => {
  const { replyTextUtf8Base64, ...rest } = payload;
  return {
    ...rest,
    ...(typeof replyTextUtf8Base64 === "string"
      ? { replyText: Buffer.from(replyTextUtf8Base64, "base64").toString("utf8") }
      : {}),
    enqueuedAt,
  };
};

const recordOf = (json: string | null): Record<string, unknown> | null => {
  try {
    const value: unknown = JSON.parse(json ?? "null");
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

const positiveIdOf = (value: unknown): number | null => {
  if (typeof value !== "number") return null;
  if (!Number.isSafeInteger(value)) return null;
  return value > 0 ? value : null;
};

/** A Nostr public key or event id as the relay writes one: 32 bytes, lowercase hex. */
const CHANNEL_IDENTITY = /^[0-9a-f]{64}$/u;

const unaddressable = <T>(message: string, source: OwnerReplySource): Decision<T> =>
  deny(ReasonCode.CONVERSATION_TURN_REPLY_UNADDRESSABLE, message, { channel: source.channel, nonce: source.nonce });

/** One ingress row's own address, from its immutable admitted payload alone, or a refusal. */
const addressOfSource = (db: Db, source: OwnerReplySource): Decision<OwnerReplyAddress> => {
  const row = db.get<{ payload_json: string | null }>(
    `SELECT payload_json FROM inbound_messages WHERE channel = ? AND nonce = ?`,
    [source.channel, source.nonce],
  );
  if (!row) return unaddressable("an ingress message this turn answers has no durable row", source);
  const payload = recordOf(row.payload_json);
  if (payload === null) return unaddressable("an ingress message this turn answers has no admitted payload", source);
  // The payload column cannot be rewritten after its insert; this is what makes it the payload the
  // guard admitted rather than one a raw insert placed there first.
  const admitted = db.get<{ payload_digest: string | null }>(
    `SELECT json_extract(evidence_json, '$.payloadDigest') AS payload_digest
       FROM audit_events
      WHERE kind = 'INGRESS_ADMITTED'
        AND json_extract(evidence_json, '$.channel') = ?
        AND json_extract(evidence_json, '$.nonce') = ?
      ORDER BY event_id DESC LIMIT 1`,
    [source.channel, source.nonce],
  );
  if (admitted?.payload_digest !== digestOf(payload)) {
    return unaddressable("an ingress message's stored payload is not the one ingress admitted", source);
  }
  if (source.channel === "telegram") {
    const chat = textOf(payload["chatId"]);
    if (chat === null) return unaddressable("a Telegram message this turn answers names no chat", source);
    const messageId = positiveIdOf(payload["messageId"]);
    if (messageId === null) return unaddressable("a Telegram message this turn answers has no message id", source);
    return allow(ReasonCode.OK, {
      channel: source.channel,
      conversation: chat,
      threadId: positiveIdOf(payload["messageThreadId"]),
      sourceNonce: source.nonce,
      replyToMessageId: messageId,
    });
  }
  if (source.channel === "buzz") {
    const room = textOf(payload["conversation"]);
    if (room === null) return unaddressable("a Buzz message this turn answers names no room", source);
    // The identity the owner wrote to is inside the signed payload, so it is read from there too.
    // Anything that is not a channel identity is left out rather than refused: the settlement
    // stands, and the sender refuses an address with no identity to answer as.
    const mention = payload["mention"];
    return allow(ReasonCode.OK, {
      channel: source.channel,
      conversation: room,
      threadId: null,
      sourceNonce: source.nonce,
      replyToMessageId: null,
      ...(typeof mention === "string" && CHANNEL_IDENTITY.test(mention) ? { replyAs: mention } : {}),
    });
  }
  return unaddressable("no reply route exists for this ingress channel", source);
};

/**
 * The address of the turn's last message, after every source proved its own address and all of
 * them agreed on channel, conversation and thread.
 *
 * Each source is read from its own row rather than compared with its neighbours: agreement among
 * batch members is not provenance, only the admitted payload is (R1041-01).
 */
export const ownerReplyAddressFor = (
  db: Db,
  sources: readonly OwnerReplySource[],
): Decision<OwnerReplyAddress> => {
  const anchor = sources.at(-1);
  if (!anchor) {
    return deny(ReasonCode.CONVERSATION_TURN_REPLY_UNADDRESSABLE, "the turn names no ingress message to answer", {});
  }
  const answered = addressOfSource(db, anchor);
  if (!answered.allowed) return deny(answered.reasonCode, answered.message, answered.evidence);
  for (const source of sources) {
    const own = addressOfSource(db, source);
    if (!own.allowed) return deny(own.reasonCode, own.message, own.evidence);
    if (source.channel !== anchor.channel) {
      return deny(
        ReasonCode.CONVERSATION_TURN_REPLY_UNADDRESSABLE,
        "the turn's ingress messages arrived on different channels",
        { channels: [source.channel, anchor.channel] },
      );
    }
    if (own.value.conversation !== answered.value.conversation) {
      return unaddressable("the turn's ingress messages arrived on different conversations", source);
    }
    if (own.value.threadId !== answered.value.threadId) {
      return unaddressable("the turn's ingress messages arrived on different threads", source);
    }
  }
  return answered;
};

/**
 * Whether the owner has already been answered for this message through the ingress reply
 * lifecycle: the transport accepted the CEO's answer (`repliedAt`), or a CEO answer was reserved
 * for the transport and that lifecycle — sent, pending, or awaiting a person — owns it.
 */
const answeredThroughIngress = (db: Db, source: OwnerReplySource): boolean => {
  const row = db.get<{ result_json: string | null; turn_claim_json: string | null }>(
    `SELECT result_json, turn_claim_json FROM inbound_messages WHERE channel = ? AND nonce = ?`,
    [source.channel, source.nonce],
  );
  if (!row) return false;
  const claim = recordOf(row.turn_claim_json);
  if (claim?.["repliedAt"] !== undefined) return true;
  const result = recordOf(row.result_json);
  if (result?.["turnAnswered"] !== true) return false;
  const reply = result["reply"];
  if (typeof reply !== "object") return false;
  return reply !== null;
};

/**
 * The turn whose reply item already answers this message, if any, other than `exceptTurn`.
 *
 * Exported for the ingress guard, which refuses to record an answer for a message this lane already
 * owes one for: the two must exclude each other in either order (R1041-02, round 2).
 */
export const ownerReplyOwing = (db: Db, source: OwnerReplySource, exceptTurn: string | null = null): string | null =>
  db.get<{ nonce: string }>(
    `SELECT item.nonce FROM inbound_messages AS item, json_each(item.payload_json, '$.sources') AS answered
      WHERE item.channel = ?
        AND item.nonce IS NOT ?
        AND json_extract(answered.value, '$.channel') = ?
        AND json_extract(answered.value, '$.nonce') = ?
      ORDER BY item.received_at ASC, item.nonce ASC LIMIT 1`,
    [OWNER_REPLY_OUTBOX_CHANNEL, exceptTurn, source.channel, source.nonce],
  )?.nonce ?? null;


/** Answered through ingress, or already named by another turn's reply item. */
const alreadyAnswered = (db: Db, source: OwnerReplySource, turnRequestId: string): boolean => {
  if (answeredThroughIngress(db, source)) return true;
  return ownerReplyOwing(db, source, turnRequestId) !== null;
};

/** The part of an item that says which obligation it is; the address is derived, not compared. */
const obligationOf = (input: {
  turnRequestId: string;
  ledger: string;
  targetActorId: string;
  sources: readonly OwnerReplySource[];
  receipt: OwnerReplyReceipt;
}): string => canonicalJson({
  turnRequestId: input.turnRequestId,
  ledger: input.ledger,
  targetActorId: input.targetActorId,
  sources: input.sources.map((source) => ({ channel: source.channel, nonce: source.nonce })),
  receipt: {
    authority: input.receipt.authority,
    receiptId: input.receipt.receiptId,
    evidenceDigest: input.receipt.evidenceDigest,
    reasonCode: input.receipt.reasonCode,
  },
});

/**
 * What enqueueing decided. `ALREADY_ANSWERED` creates nothing: every message the turn answers was
 * already answered through ingress or is already owed by another turn's item, so the completion
 * discharges an obligation that exists rather than creating a second one.
 */
export type OwnerReplyEnqueued =
  | { readonly status: "ENQUEUED" | "REDELIVERED"; readonly item: OwnerReplyItem }
  | { readonly status: "ALREADY_ANSWERED"; readonly item: null };

/**
 * Records the reply a completed turn owes, inside the transaction that settles the turn.
 *
 * One owner message gets at most one reply across both receipt lanes (R1041-02):
 *
 * - The same turn's identical item is a redelivery and changes nothing; a different one is refused.
 * - A message already answered through ingress (`repliedAt`, or a reserved CEO answer), or already
 *   named by another turn's item, needs no new obligation. When that is true of every message of
 *   the turn, nothing is written and the completion stands on the existing answer. When it is true
 *   of some and not others, the batches disagree about which reply answers what, and that is
 *   refused rather than resolved by a second reply.
 * - Otherwise the item is written, addressed from the rows' immutable payloads.
 *
 * Every refusal is a denial rather than a throw, so the caller's `txDecision` rolls the settlement
 * back with it. A database error still throws, which rolls back the same way.
 */
export const enqueueOwnerReply = (
  authority: OwnerReplyAuthority,
  db: Db,
  clock: Clock,
  input: EnqueueOwnerReplyInput,
): Decision<OwnerReplyEnqueued> => {
  assertAuthority(authority, db, input.turnRequestId);
  if (!db.inTransaction) {
    // Outside the settlement transaction the item and the turn are two commits, which is the
    // half-written state this lane exists to make unreachable.
    throw acpError(
      ReasonCode.INTERNAL_ERROR,
      "an owner reply must be enqueued inside the transaction that settles its turn",
      { turnRequestId: input.turnRequestId },
    );
  }

  const existing = db.get<{ payload_json: string | null; result_json: string | null; received_at: string }>(
    `SELECT payload_json, result_json, received_at FROM inbound_messages WHERE channel = ? AND nonce = ?`,
    [OWNER_REPLY_OUTBOX_CHANNEL, input.turnRequestId],
  );
  if (existing !== undefined) {
    // Compared on what the obligation is, not on the address: the address was derived from rows
    // that may since have been pruned, and re-deriving it would turn a redelivery into a refusal.
    const stored = itemOf(input.turnRequestId, existing);
    if (obligationOf(stored) !== obligationOf(input)) {
      return deny(
        ReasonCode.CONVERSATION_TURN_REPLY_CONFLICT,
        "this turn already has an owner reply with different content",
        { turnRequestId: input.turnRequestId },
      );
    }
    return allow(ReasonCode.OK, { status: "REDELIVERED", item: stored });
  }

  // A handler that is running for one of these messages may still hand its own answer out, so an
  // obligation created now could be the second reply (R1041-02, round 2). This asks the handler
  // registry rather than inferring a running handler from an open claim, which was ruled out: a
  // handler that finished with an apology or a timeout leaves its claim open on purpose and must
  // not hold the receipt back (R1041-04).
  const inFlight = input.sources.find((source) => input.handlerRunning(source));
  if (inFlight !== undefined) {
    return deny(
      ReasonCode.CONVERSATION_TURN_REPLY_IN_FLIGHT,
      "a handler in this process still holds this message open and may answer it; ask again once it settles",
      { turnRequestId: input.turnRequestId, channel: inFlight.channel, nonce: inFlight.nonce },
    );
  }

  const covered = input.sources.filter((source) => alreadyAnswered(db, source, input.turnRequestId));
  if (covered.length > 0) {
    if (covered.length === input.sources.length) {
      return allow(ReasonCode.OK, { status: "ALREADY_ANSWERED", item: null });
    }
    return deny(
      ReasonCode.CONVERSATION_TURN_REPLY_CONFLICT,
      "some of this turn's messages already have a reply and others do not",
      { turnRequestId: input.turnRequestId, answered: covered.map((source) => `${source.channel}:${source.nonce}`) },
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
    sources: input.sources.map((source) => ({ channel: source.channel, nonce: source.nonce })),
    address: address.value,
    receipt: {
      authority: input.receipt.authority,
      receiptId: input.receipt.receiptId,
      evidenceDigest: input.receipt.evidenceDigest,
      reasonCode: input.receipt.reasonCode,
    },
    // Into the immutable payload, beside the digest it must match, because a reply that could be
    // rewritten after settlement is not the reply the receipt proved.
    ...(typeof input.replyText === "string"
      ? { replyTextUtf8Base64: Buffer.from(input.replyText, "utf8").toString("base64") }
      : {}),
  };
  const payloadJson = canonicalJson(payload);

  const enqueuedAt = clock.nowIso();
  db.run(
    `INSERT INTO inbound_messages (channel, nonce, actor, received_at, payload_json, result_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      OWNER_REPLY_OUTBOX_CHANNEL,
      input.turnRequestId,
      input.targetActorId,
      enqueuedAt,
      payloadJson,
      canonicalJson({ status: "PENDING" }),
    ],
  );
  return allow(ReasonCode.OK, { status: "ENQUEUED", item: { ...itemFrom(payload, enqueuedAt), status: "PENDING" } });
};

const itemOf = (
  turnRequestId: string,
  row: { payload_json: string | null; result_json: string | null; received_at: string },
): OwnerReplyItem => {
  const payload = recordOf(row.payload_json) as StoredPayload | null;
  const result = recordOf(row.result_json);
  if (payload === null) {
    throw acpError(ReasonCode.INTERNAL_ERROR, "an owner reply item has no readable payload", { turnRequestId });
  }
  if (result?.["status"] === "PENDING") return { ...itemFrom(payload, row.received_at), status: "PENDING" };
  // A build before the consumer reads only `PENDING` and throws on `DELIVERED`, so a rollback past
  // this change meets a delivered item as an unreadable one on its redelivery path.
  const delivery = result?.["status"] === "DELIVERED" ? deliveryOf(result["delivery"]) : null;
  if (delivery !== null) return { ...itemFrom(payload, row.received_at), status: "DELIVERED", delivery };
  throw acpError(ReasonCode.INTERNAL_ERROR, "an owner reply item has a status this build cannot read", { turnRequestId });
};

const DELIVERY_TEXT_FIELDS = [
  "eventId", "signer", "conversation", "replyToEventId", "relayUrl", "contentDigest", "deliveredAt", "evidenceDigest",
] as const;

/** A stored delivery record with every field present and a string, or `null`. */
const deliveryOf = (value: unknown): OwnerReplyDelivery | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const fields = value as Record<string, unknown>;
  if (fields["transport"] !== "buzz") return null;
  const relayAck = fields["relayAck"];
  if (relayAck !== "ACCEPTED" && relayAck !== "DUPLICATE") return null;
  const text: Partial<Record<(typeof DELIVERY_TEXT_FIELDS)[number], string>> = {};
  for (const name of DELIVERY_TEXT_FIELDS) {
    const field = fields[name];
    if (typeof field !== "string") return null;
    text[name] = field;
  }
  return {
    transport: "buzz",
    eventId: text.eventId ?? "",
    signer: text.signer ?? "",
    conversation: text.conversation ?? "",
    replyToEventId: text.replyToEventId ?? "",
    relayUrl: text.relayUrl ?? "",
    relayAck,
    contentDigest: text.contentDigest ?? "",
    deliveredAt: text.deliveredAt ?? "",
    evidenceDigest: text.evidenceDigest ?? "",
  };
};

/** The reply item for one turn, or `null` when that turn owes none. */
export const ownerReplyFor = (db: Db, turnRequestId: string): OwnerReplyItem | null => {
  const row = db.get<{ payload_json: string | null; result_json: string | null; received_at: string }>(
    `SELECT payload_json, result_json, received_at FROM inbound_messages WHERE channel = ? AND nonce = ?`,
    [OWNER_REPLY_OUTBOX_CHANNEL, turnRequestId],
  );
  return row ? itemOf(turnRequestId, row) : null;
};

/**
 * Every reply still owed, oldest first. An unreadable row throws rather than disappearing.
 *
 * "Owed" is every status except `DELIVERED`, so a status this build cannot read reaches `itemOf`
 * and throws instead of being filtered out of sight.
 */
export const pendingOwnerReplies = (db: Db): readonly OwnerReplyItem[] =>
  db.all<{ nonce: string; payload_json: string | null; result_json: string | null; received_at: string }>(
    `SELECT nonce, payload_json, result_json, received_at FROM inbound_messages
      WHERE channel = ?
        AND json_extract(result_json, '$.status') IS NOT 'DELIVERED'
      ORDER BY received_at ASC, nonce ASC`,
    [OWNER_REPLY_OUTBOX_CHANNEL],
  ).map((row) => itemOf(row.nonce, row));

/* ----------------------------------------------------------------------------- delivery (#1036) */

/**
 * The right to record delivery state for one database's owner replies.
 *
 * One sender per database, claimed the way the owner-reply authority is and released when the
 * handle closes. Two senders in one process would each work the same item. The intent below
 * already makes their sends one event, but nothing is gained by letting them race for it.
 */
export interface OwnerReplyDeliveryAuthority {
  readonly ownerReplyDeliveryFor: string;
}

const ISSUED_DELIVERY_AUTHORITIES = new Map<string, OwnerReplyDeliveryAuthority>();

export const claimOwnerReplyDeliveryAuthority = (db: Db): OwnerReplyDeliveryAuthority => {
  if (ISSUED_DELIVERY_AUTHORITIES.has(db.identity)) {
    throw acpError(
      ReasonCode.COMPLETION_AUTHORITY_DENIED,
      "the owner-reply delivery authority was already issued for this database",
      {},
    );
  }
  const authority: OwnerReplyDeliveryAuthority = Object.freeze({ ownerReplyDeliveryFor: db.identity });
  ISSUED_DELIVERY_AUTHORITIES.set(db.identity, authority);
  db.releaseOnClose(() => {
    if (ISSUED_DELIVERY_AUTHORITIES.get(db.identity) === authority) {
      ISSUED_DELIVERY_AUTHORITIES.delete(db.identity);
    }
  });
  return authority;
};

const assertDeliveryAuthority = (authority: OwnerReplyDeliveryAuthority, db: Db, turnRequestId: string): void => {
  if (ISSUED_DELIVERY_AUTHORITIES.get(db.identity) !== authority) {
    throw acpError(
      ReasonCode.COMPLETION_AUTHORITY_DENIED,
      "only the holder of this database's owner-reply delivery authority may do this",
      { turnRequestId },
    );
  }
};

/**
 * Where a recorded intent lives: one row per turn, on a channel of its own (R1056-02).
 *
 * The item's own protections, from triggers that exist today: `payload_json` cannot be rewritten
 * (`inbound_messages_payload_immutable`), a second row for the turn cannot be inserted
 * (`inbound_messages_no_replace`), and no row can be deleted without this channel's ingress delete
 * authority, which nothing grants. It lives here rather than in the item's mutable `result_json`,
 * where any writer of that column could replace or drop it, and a dropped intent let the sender
 * sign a second, different event.
 */
export const OWNER_REPLY_INTENT_CHANNEL = "owner-reply-intent";

/** A signed Nostr event, exactly as it goes on the wire. */
export interface OwnerReplySignedEvent {
  readonly id: string;
  readonly pubkey: string;
  readonly created_at: number;
  readonly kind: number;
  readonly tags: readonly (readonly string[])[];
  readonly content: string;
  readonly sig: string;
}

/**
 * The exact signed event a sender is about to publish, committed before the first send.
 *
 * This is what makes delivery exactly once across a crash. A Nostr event's id is the hash of its
 * author, `created_at`, kind, tags and content, so a retry that sends these stored bytes is the
 * same event, not a second reply, and the relay keeps one. A sender that signed afresh after a
 * crash would pick a new `created_at` and so publish a second event.
 */
export interface OwnerReplyIntent {
  readonly transport: "buzz";
  readonly eventId: string;
  readonly event: OwnerReplySignedEvent;
  readonly recordedAt: string;
}

/**
 * A turn's recorded intent: none yet, one that reads back, or one that does not. `UNREADABLE` is
 * kept apart from `ABSENT` on purpose. Reading a damaged intent as no intent is what let the sender
 * sign a second event, so a damaged one blocks the item instead (R1056-02).
 */
export type OwnerReplyIntentRecord =
  | { readonly status: "ABSENT" }
  | { readonly status: "RECORDED"; readonly intent: OwnerReplyIntent }
  | { readonly status: "UNREADABLE" };

/** A Schnorr signature as Nostr writes one: 64 bytes, lowercase hex. */
const SIGNATURE = /^[0-9a-f]{128}$/u;

const signedEventOf = (value: unknown): OwnerReplySignedEvent | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { id, pubkey, created_at: createdAt, kind, tags, content, sig } = value as Record<string, unknown>;
  if (typeof id !== "string" || !CHANNEL_IDENTITY.test(id)) return null;
  if (typeof pubkey !== "string" || !CHANNEL_IDENTITY.test(pubkey)) return null;
  if (typeof sig !== "string" || !SIGNATURE.test(sig)) return null;
  if (typeof createdAt !== "number" || !Number.isSafeInteger(createdAt)) return null;
  if (typeof kind !== "number" || typeof content !== "string" || !Array.isArray(tags)) return null;
  const copied: string[][] = [];
  for (const tag of tags as unknown[]) {
    if (!Array.isArray(tag) || !tag.every((part) => typeof part === "string")) return null;
    copied.push([...(tag as string[])]);
  }
  return { id, pubkey, created_at: createdAt, kind, tags: copied, content, sig };
};

/** The intent recorded for one turn. */
export const ownerReplyIntent = (db: Db, turnRequestId: string): OwnerReplyIntentRecord => {
  const row = db.get<{ payload_json: string | null; received_at: string }>(
    `SELECT payload_json, received_at FROM inbound_messages WHERE channel = ? AND nonce = ?`,
    [OWNER_REPLY_INTENT_CHANNEL, turnRequestId],
  );
  if (!row) return { status: "ABSENT" };
  const stored = recordOf(row.payload_json);
  const event = signedEventOf(stored?.["event"]);
  if (stored?.["transport"] !== "buzz" || event === null) return { status: "UNREADABLE" };
  return { status: "RECORDED", intent: { transport: "buzz", eventId: event.id, event, recordedAt: row.received_at } };
};

const unreadableIntent = <T>(turnRequestId: string): Decision<T> =>
  deny(
    ReasonCode.CONVERSATION_TURN_REPLY_CONFLICT,
    "the intent recorded for this reply cannot be read, and a recorded intent is never replaced",
    { turnRequestId, cause: "recorded-intent-unreadable", transient: false },
  );

/** Why the last attempt did not deliver. */
export interface OwnerReplyBlock {
  readonly reasonCode: string;
  readonly cause: string;
  /** A relay answer that may differ next time, as opposed to an address or configuration fault. */
  readonly transient: boolean;
  readonly since: string;
}

export interface OwnerReplyDeliveryState {
  readonly turnRequestId: string;
  readonly status: OwnerReplyStatus;
  readonly attempts: number;
  readonly retryAt: string | null;
  readonly blocked: OwnerReplyBlock | null;
  /**
   * Every cause already audited for this item, as `reasonCode:cause` (R1056-06). A cause is audited
   * once per item, however the failures interleave. The causes come from a fixed vocabulary, so
   * this list is bounded. It lives in the item's mutable `result_json`, so it bounds this sender's
   * rows, not those of a writer that rewrites that column.
   */
  readonly audited: readonly string[];
}

const blockOf = (value: unknown): OwnerReplyBlock | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const fields = value as Record<string, unknown>;
  const { reasonCode, cause, transient, since } = fields;
  if (typeof reasonCode !== "string" || typeof cause !== "string") return null;
  if (typeof transient !== "boolean" || typeof since !== "string") return null;
  return { reasonCode, cause, transient, since };
};

const deliveryStateOf = (turnRequestId: string, resultJson: string | null): OwnerReplyDeliveryState => {
  const result = recordOf(resultJson);
  const status = result?.["status"];
  if (status !== "PENDING" && status !== "DELIVERED") {
    throw acpError(ReasonCode.INTERNAL_ERROR, "an owner reply item has a status this build cannot read", { turnRequestId });
  }
  const attempts = result?.["attempts"];
  const retryAt = result?.["retryAt"];
  const audited = result?.["audited"];
  return {
    turnRequestId,
    status,
    attempts: typeof attempts === "number" && Number.isSafeInteger(attempts) && attempts > 0 ? attempts : 0,
    retryAt: typeof retryAt === "string" ? retryAt : null,
    blocked: blockOf(result?.["blocked"]),
    audited: Array.isArray(audited) ? audited.filter((key): key is string => typeof key === "string") : [],
  };
};

/** One item's delivery state, or `null` when the turn owes no reply. */
export const ownerReplyDeliveryState = (db: Db, turnRequestId: string): OwnerReplyDeliveryState | null => {
  const row = db.get<{ result_json: string | null }>(
    `SELECT result_json FROM inbound_messages WHERE channel = ? AND nonce = ?`,
    [OWNER_REPLY_OUTBOX_CHANNEL, turnRequestId],
  );
  return row ? deliveryStateOf(turnRequestId, row.result_json) : null;
};

const pendingStateJson = (state: OwnerReplyDeliveryState): string => canonicalJson({
  status: "PENDING",
  ...(state.attempts === 0 ? {} : { attempts: state.attempts }),
  ...(state.retryAt === null ? {} : { retryAt: state.retryAt }),
  ...(state.blocked === null ? {} : { blocked: state.blocked }),
  ...(state.audited.length === 0 ? {} : { audited: state.audited }),
});

const writeResult = (db: Db, turnRequestId: string, resultJson: string): void => {
  db.run(
    `UPDATE inbound_messages SET result_json = ? WHERE channel = ? AND nonce = ?`,
    [resultJson, OWNER_REPLY_OUTBOX_CHANNEL, turnRequestId],
  );
};

const notPending = <T>(turnRequestId: string, state: OwnerReplyDeliveryState | null): Decision<T> =>
  deny(
    ReasonCode.CONVERSATION_TURN_REPLY_CONFLICT,
    state === null ? "no owner reply is owed for this turn" : "this owner reply was already delivered",
    { turnRequestId },
  );

/**
 * Records the event a sender will publish, unless one is already recorded.
 *
 * Returns the intent that stands, so a sender that lost a race, or that resumed after a crash,
 * publishes the stored event and not the one it just built. A recorded intent that cannot be read
 * is refused, never replaced.
 *
 * Written with `JSON.stringify`, not `canonicalJson`: JSON escapes a CR inside the content, where
 * `canonicalJson` would rewrite it, and the event id is a hash over the exact content (R1056-05).
 */
export const recordOwnerReplyIntent = (
  authority: OwnerReplyDeliveryAuthority,
  db: Db,
  clock: Clock,
  turnRequestId: string,
  event: OwnerReplySignedEvent,
): Decision<OwnerReplyIntent> => {
  assertDeliveryAuthority(authority, db, turnRequestId);
  return db.txDecision(() => {
    const state = ownerReplyDeliveryState(db, turnRequestId);
    if (state?.status !== "PENDING") return notPending(turnRequestId, state);
    const recorded = ownerReplyIntent(db, turnRequestId);
    if (recorded.status === "RECORDED") return allow(ReasonCode.OK, recorded.intent);
    if (recorded.status === "UNREADABLE") return unreadableIntent(turnRequestId);
    const exact: OwnerReplySignedEvent = {
      id: event.id,
      pubkey: event.pubkey,
      created_at: event.created_at,
      kind: event.kind,
      tags: event.tags.map((tag) => [...tag]),
      content: event.content,
      sig: event.sig,
    };
    const recordedAt = clock.nowIso();
    db.run(
      `INSERT INTO inbound_messages (channel, nonce, actor, received_at, payload_json, result_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        OWNER_REPLY_INTENT_CHANNEL,
        turnRequestId,
        exact.pubkey,
        recordedAt,
        JSON.stringify({ transport: "buzz", event: exact }),
        canonicalJson({ status: "RECORDED" }),
      ],
    );
    return allow(ReasonCode.OK, { transport: "buzz", eventId: exact.id, event: exact, recordedAt });
  });
};

/**
 * Records the transport's acceptance of the recorded intent. The item is `DELIVERED` from here on.
 *
 * Refused unless the item is `PENDING` with an intent for this exact event, so an acceptance can
 * only be recorded for the event that was meant. Recording it again for the same event changes
 * nothing and writes no second audit row.
 */
export const recordOwnerReplyDelivered = (
  authority: OwnerReplyDeliveryAuthority,
  db: Db,
  clock: Clock,
  audit: AuditLog,
  turnRequestId: string,
  accepted: Omit<OwnerReplyDelivery, "deliveredAt" | "evidenceDigest">,
): Decision<OwnerReplyDelivery> => {
  assertDeliveryAuthority(authority, db, turnRequestId);
  return db.txDecision(() => {
    const row = db.get<{ payload_json: string | null; result_json: string | null; received_at: string }>(
      `SELECT payload_json, result_json, received_at FROM inbound_messages WHERE channel = ? AND nonce = ?`,
      [OWNER_REPLY_OUTBOX_CHANNEL, turnRequestId],
    );
    const item = row ? itemOf(turnRequestId, row) : null;
    if (item?.delivery?.eventId === accepted.eventId) return allow(ReasonCode.OK, item.delivery);
    const state = row ? deliveryStateOf(turnRequestId, row.result_json) : null;
    if (state?.status !== "PENDING") return notPending(turnRequestId, state);
    const recorded = ownerReplyIntent(db, turnRequestId);
    if (recorded.status !== "RECORDED" || recorded.intent.eventId !== accepted.eventId) {
      return deny(
        ReasonCode.CONVERSATION_TURN_REPLY_CONFLICT,
        "the accepted event is not the one this item recorded it would send",
        { turnRequestId, eventId: accepted.eventId },
      );
    }
    const evidence = { ...accepted, deliveredAt: clock.nowIso() };
    const delivery: OwnerReplyDelivery = { ...evidence, evidenceDigest: digestOf(evidence) };
    writeResult(db, turnRequestId, canonicalJson({
      status: "DELIVERED",
      delivery,
      attempts: state.attempts + 1,
      ...(state.audited.length === 0 ? {} : { audited: state.audited }),
    }));
    audit.record({
      kind: "OWNER_REPLY_DELIVERED",
      reasonCode: ReasonCode.OK,
      actor: `buzz:${delivery.signer}`,
      evidence: {
        turnRequestId,
        channel: "buzz",
        conversation: delivery.conversation,
        eventId: delivery.eventId,
        replyToEventId: delivery.replyToEventId,
        relayAck: delivery.relayAck,
        contentDigest: delivery.contentDigest,
        evidenceDigest: delivery.evidenceDigest,
      },
    });
    return allow(ReasonCode.OK, delivery);
  });
};

/**
 * Records one attempt that did not deliver, and when the next may run. The item stays `PENDING`.
 *
 * An audit row is written the first time a cause is seen for this item, and never again for it,
 * however the causes alternate (R1056-06): a refusal, a timeout and a refusal again leave two rows.
 */
export const recordOwnerReplyUndelivered = (
  authority: OwnerReplyDeliveryAuthority,
  db: Db,
  clock: Clock,
  audit: AuditLog,
  turnRequestId: string,
  blocked: {
    readonly reasonCode: ReasonCode;
    readonly cause: string;
    readonly transient: boolean;
    readonly retryAt: string;
  },
): Decision<{ readonly audited: boolean }> => {
  assertDeliveryAuthority(authority, db, turnRequestId);
  return db.txDecision(() => {
    const state = ownerReplyDeliveryState(db, turnRequestId);
    if (state?.status !== "PENDING") return notPending(turnRequestId, state);
    const key = `${blocked.reasonCode}:${blocked.cause}`;
    const seen = state.audited.includes(key);
    const repeated = state.blocked?.reasonCode === blocked.reasonCode && state.blocked.cause === blocked.cause;
    writeResult(db, turnRequestId, pendingStateJson({
      ...state,
      attempts: state.attempts + 1,
      retryAt: blocked.retryAt,
      blocked: {
        reasonCode: blocked.reasonCode,
        cause: blocked.cause,
        transient: blocked.transient,
        since: repeated && state.blocked ? state.blocked.since : clock.nowIso(),
      },
      audited: seen ? state.audited : [...state.audited, key],
    }));
    if (!seen) {
      audit.record({
        kind: "OWNER_REPLY_UNDELIVERED",
        reasonCode: blocked.reasonCode,
        evidence: { turnRequestId, cause: blocked.cause, transient: blocked.transient },
      });
    }
    return allow(ReasonCode.OK, { audited: !seen });
  });
};

/**
 * One stored owner reply, authorized for the Buzz publisher (R1056-01).
 *
 * The publisher signs and sends nothing else. Only `issueOwnerReplyPublication` makes one, only for
 * the holder of this database's delivery authority, and only from the item and intent as stored.
 * Its text is the one the receipt's digest proves, and its room, the event it answers and the
 * identity it is signed as come from the item's address. Each is spent by the publisher's first
 * use of it (`redeemOwnerReplyPublication`), so a caller cannot reuse one or build its own.
 */
export interface OwnerReplyPublication {
  readonly turnRequestId: string;
  readonly signer: string;
  readonly room: string;
  readonly replyToEventId: string;
  readonly content: string;
  /** The `created_at` a reply with no recorded intent is signed with. */
  readonly createdAt: number;
  /** The recorded event, the only event a publication may send; `null` until one is recorded. */
  readonly intent: OwnerReplySignedEvent | null;
}

const ISSUED_PUBLICATIONS = new WeakSet<object>();

/**
 * A publication for one `PENDING` Buzz item, or the refusal that says why there is none. Every
 * refusal carries its `cause`, and `transient: false`: nothing here changes without a new item, a
 * new configuration or a restart.
 */
export const issueOwnerReplyPublication = (
  authority: OwnerReplyDeliveryAuthority,
  db: Db,
  clock: Clock,
  turnRequestId: string,
): Decision<OwnerReplyPublication> => {
  assertDeliveryAuthority(authority, db, turnRequestId);
  const item = ownerReplyFor(db, turnRequestId);
  if (item?.status !== "PENDING") {
    return deny(ReasonCode.CONVERSATION_TURN_REPLY_CONFLICT, "no owner reply is pending for this turn", { turnRequestId });
  }
  const { address } = item;
  if (address.channel !== "buzz" || address.conversation.trim() === "") {
    return deny(ReasonCode.CONVERSATION_TURN_REPLY_UNADDRESSABLE, "the reply names no Buzz room", {
      turnRequestId, cause: "address-names-no-room", transient: false,
    });
  }
  const anchor = item.sources.at(-1);
  if (anchor === undefined || anchor.nonce !== address.sourceNonce) {
    return deny(ReasonCode.CONVERSATION_TURN_REPLY_CONFLICT, "the reply's address is not the message the turn answers", {
      turnRequestId, cause: "address-is-not-the-answered-message", transient: false,
    });
  }
  if (item.sources.some((source) => source.channel !== address.channel)) {
    return deny(ReasonCode.CONVERSATION_TURN_REPLY_CONFLICT, "the turn's messages span channels", {
      turnRequestId, cause: "sources-span-channels", transient: false,
    });
  }
  const replyToEventId = address.sourceNonce.startsWith(BUZZ_MESSAGE_NONCE_PREFIX)
    ? address.sourceNonce.slice(BUZZ_MESSAGE_NONCE_PREFIX.length)
    : "";
  if (!CHANNEL_IDENTITY.test(replyToEventId)) {
    return deny(ReasonCode.CONVERSATION_TURN_REPLY_UNADDRESSABLE, "the reply names no Buzz event to answer", {
      turnRequestId, cause: "address-names-no-event-to-answer", transient: false,
    });
  }
  const signer = address.replyAs;
  if (typeof signer !== "string" || !CHANNEL_IDENTITY.test(signer)) {
    return deny(ReasonCode.OWNER_REPLY_IDENTITY_UNKNOWN, "the reply names no channel identity to sign as", {
      turnRequestId, cause: "address-names-no-identity", transient: false,
    });
  }
  const text = item.replyText;
  if (text === undefined || text.trim() === "" || sha256(text) !== item.receipt.evidenceDigest) {
    return deny(ReasonCode.OWNER_REPLY_BODY_UNAVAILABLE, "the item holds no reply text the receipt proved", {
      turnRequestId,
      cause: text === undefined
        ? "reply-text-absent"
        : text.trim() === "" ? "reply-text-empty" : "reply-text-digest-mismatch",
      transient: false,
    });
  }
  const recorded = ownerReplyIntent(db, turnRequestId);
  if (recorded.status === "UNREADABLE") return unreadableIntent(turnRequestId);
  const publication: OwnerReplyPublication = Object.freeze({
    turnRequestId,
    signer,
    room: address.conversation,
    replyToEventId,
    content: text,
    createdAt: Math.floor(clock.now().getTime() / 1000),
    intent: recorded.status === "RECORDED" ? recorded.intent.event : null,
  });
  ISSUED_PUBLICATIONS.add(publication);
  return allow(ReasonCode.OK, publication);
};

/** The publication itself when `value` is one this module issued and nothing has spent; `null` otherwise. */
export const redeemOwnerReplyPublication = (value: unknown): OwnerReplyPublication | null => {
  if (typeof value !== "object" || value === null || !ISSUED_PUBLICATIONS.has(value)) return null;
  ISSUED_PUBLICATIONS.delete(value);
  return value as OwnerReplyPublication;
};

/**
 * The turn ids of every item not yet `DELIVERED`, oldest first. Ids only, so one unreadable item
 * fails its own read and not the whole list.
 */
export const owedOwnerReplyTurns = (db: Db): readonly string[] =>
  db.all<{ nonce: string }>(
    `SELECT nonce FROM inbound_messages
      WHERE channel = ?
        AND json_extract(result_json, '$.status') IS NOT 'DELIVERED'
      ORDER BY received_at ASC, nonce ASC`,
    [OWNER_REPLY_OUTBOX_CHANNEL],
  ).map((row) => row.nonce);
