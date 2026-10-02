import { canonicalJson, digestOf } from "../core/digest.ts";
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
 * - Any other channel is unaddressable: no reply route exists for it to be addressed by.
 */
export interface OwnerReplyAddress {
  readonly channel: string;
  readonly conversation: string;
  readonly threadId: number | null;
  readonly sourceNonce: string;
  readonly replyToMessageId: number | null;
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
  /** Only `PENDING` exists until a consumer is built; a consumer adds its own terminal states. */
  readonly status: "PENDING";
  readonly enqueuedAt: string;
}

export interface EnqueueOwnerReplyInput {
  readonly turnRequestId: string;
  readonly ledger: OwnerReplyLedger;
  readonly targetActorId: string;
  /** The turn's ingress messages in batch order. The reply answers the last one. */
  readonly sources: readonly OwnerReplySource[];
  readonly receipt: OwnerReplyReceipt;
  /** This process's claim incarnation; a claim it still holds open may yet be answered live. */
  readonly answeringProcess: string;
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

type StoredPayload = Omit<OwnerReplyItem, "status" | "enqueuedAt">;

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
    return allow(ReasonCode.OK, {
      channel: source.channel,
      conversation: room,
      threadId: null,
      sourceNonce: source.nonce,
      replyToMessageId: null,
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

/**
 * Whether a handler in this process still holds the message's ingress claim open — claimed by
 * `answeringProcess` and not yet resolved by any terminal fact. That handler may still produce and
 * deliver the answer, so an obligation created now could be the second reply (R1041-02, round 2).
 * A claim taken by another incarnation belongs to a process that is gone and can answer nothing.
 */
const answerInFlight = (db: Db, source: OwnerReplySource, answeringProcess: string): boolean => {
  const row = db.get<{ turn_claim_json: string | null }>(
    `SELECT turn_claim_json FROM inbound_messages WHERE channel = ? AND nonce = ?`,
    [source.channel, source.nonce],
  );
  const claim = recordOf(row?.turn_claim_json ?? null);
  if (claim?.["claimedByProcess"] !== answeringProcess) return false;
  if (claim["repliedAt"] !== undefined) return false;
  if (claim["noReplyAt"] !== undefined) return false;
  return claim["settledAt"] === undefined;
};

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

  const inFlight = input.sources.find((source) => answerInFlight(db, source, input.answeringProcess));
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
  return allow(ReasonCode.OK, { status: "ENQUEUED", item: { ...payload, status: "PENDING", enqueuedAt } });
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
