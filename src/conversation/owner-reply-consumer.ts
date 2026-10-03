import { verifyEvent } from "nostr-tools/pure";

import {
  BUZZ_MENTION_KIND,
  type BuzzReplyPublisher,
  type BuzzSignedEvent,
} from "../buzz/buzz-mention-subscriber.ts";
import type { Clock } from "../core/clock.ts";
import { canonicalJson, sha256 } from "../core/digest.ts";
import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import type { AuditLog } from "../db/audit.ts";
import type { Db } from "../db/database.ts";
import { BUZZ_MESSAGE_NONCE_PREFIX } from "../ingress/buzz-message.ts";
import {
  type OwnerReplyDeliveryAuthority,
  type OwnerReplyDeliveryState,
  type OwnerReplyIntent,
  type OwnerReplyItem,
  claimOwnerReplyDeliveryAuthority,
  owedOwnerReplyTurns,
  ownerReplyDeliveryState,
  ownerReplyFor,
  recordOwnerReplyDelivered,
  recordOwnerReplyIntent,
  recordOwnerReplyUndelivered,
} from "./owner-reply-outbox.ts";

/**
 * The owner-reply consumer (#1036): it delivers each `PENDING` owner-reply item to the
 * conversation the owner asked from, and records what the transport accepted.
 *
 * **Buzz.** The reply is a kind-9 event in the item's room. It answers the owner's event with the
 * reply tag the live relay itself writes (`["e", <id>, "", "reply"]`,
 * `tests/fixtures/buzz-cli/messages-get.json`). It is signed as the daemon's identity the owner
 * mentioned (`address.replyAs`), and sent on that identity's own NIP-42-authenticated subscriber
 * connection (`BuzzReplyPublisher`). The text is the item's `replyText`, sent only if it hashes to
 * the receipt's `evidenceDigest`.
 *
 * **Exactly once.** Before the first send, the whole signed event is committed as the item's
 * intent (`recordOwnerReplyIntent`). Every later attempt, in this process or after a restart,
 * sends those stored bytes. A Nostr event's id is the hash of its author, time, kind, tags and
 * content, so a resend is the same event, and the relay keeps one copy of an id. A crash between
 * the send and the `DELIVERED` record therefore costs a resend of the same event, never a second
 * reply. Querying the relay for the id after a restart was ruled out rather than built: it needs a
 * second subscription path, and still cannot tell "not stored" from "not visible to this query". A
 * relay's `duplicate:` answer is taken as acceptance, because it says the relay already holds
 * this id.
 *
 * **Fail closed.** An item this consumer cannot deliver stays `PENDING` and is never dropped. It
 * gets one `OWNER_REPLY_UNDELIVERED` audit row per distinct cause, and a bounded backoff before
 * its next attempt. That covers no transport (every Telegram item on a deployment without ACP
 * Telegram ingress), a missing or conflicting address, no identity to sign as, a room that
 * identity is not subscribed to, a missing or mismatched body, and a relay refusal or timeout. A
 * Telegram item is never sent through Buzz instead.
 *
 * **Woken, not polled.** The consumer runs when the coordinator announces a new item, when an
 * identity's relay connection authenticates (startup and every reconnect), and once at startup.
 * The one timer it arms is a single backoff timer, for the earliest relay failure due a retry.
 * Address, identity and configuration faults wait for the next wake-up instead, because only a
 * restart or a new settlement can change them.
 */

/** How long one publish waits for the relay's `OK` before it counts as a timeout. */
export const OWNER_REPLY_PUBLISH_TIMEOUT_MS = 15_000;

/** The wait before attempt n+1 after n failed attempts; the last entry repeats. */
export const OWNER_REPLY_RETRY_BACKOFF_MS: readonly number[] = [5_000, 15_000, 60_000, 300_000, 900_000];

/** The timer seam. The subscriber's scheduler satisfies it, and so does a test's virtual clock. */
export interface OwnerReplyTimers {
  setTimer(ms: number, fire: () => void): number;
  clearTimer(handle: number): void;
}

export interface OwnerReplyConsumerOptions {
  readonly db: Db;
  readonly clock: Clock;
  readonly audit: AuditLog;
  /** `null` when this daemon runs no Buzz subscriber. A Buzz item then has no transport. */
  readonly buzz: BuzzReplyPublisher | null;
  readonly timers: OwnerReplyTimers;
  readonly publishTimeoutMs?: number;
  /** Where an item that cannot even be read is reported. It is skipped, and the sweep goes on. */
  readonly onError?: (error: unknown) => void;
}

/**
 * Which items a pass attempts.
 * - `ALL`: every owed item, whatever its backoff. Used at startup, where configuration may have changed.
 * - `DUE`: items never attempted, or whose backoff has run out.
 * - `RELAY`: what `DUE` takes, plus every item held back by a relay failure. Used when a
 *   connection has just authenticated.
 */
export type OwnerReplySweep = "ALL" | "DUE" | "RELAY";

const SWEEP_REACH: Readonly<Record<OwnerReplySweep, number>> = { DUE: 0, RELAY: 1, ALL: 2 };

/**
 * How one attempt ended, when it was not refused.
 * - `DELIVERED`: the transport accepted it and that is recorded.
 * - `WAITING`: the signer's connection has not authenticated yet, and its authentication wakes the
 *   consumer again. Nothing is recorded, because nothing was attempted.
 * - `SETTLED_ELSEWHERE`: another writer moved the item first, so this attempt has nothing to record.
 *
 * A refusal is a denial. Its evidence names the cause, and whether a later attempt may differ.
 */
type AttemptOutcome = "DELIVERED" | "WAITING" | "SETTLED_ELSEWHERE";

/** A fault that only a configuration change, a restart or a new item can clear. */
const parked = (cause: string) => ({ cause, transient: false });
/** A relay answer that may be different next time. */
const relayFailure = (cause: string) => ({ cause, transient: true });

const EVENT_ID = /^[0-9a-f]{64}$/u;

/** Where a Buzz reply goes and who signs it, read from the item alone. */
interface BuzzReplyTarget {
  readonly room: string;
  readonly replyToEventId: string;
  readonly signer: string | null;
}

const buzzTargetOf = (item: OwnerReplyItem): Decision<BuzzReplyTarget> => {
  const { address } = item;
  if (address.conversation.trim() === "") {
    return deny(ReasonCode.CONVERSATION_TURN_REPLY_UNADDRESSABLE, "the reply names no room", parked("address-names-no-room"));
  }
  const anchor = item.sources.at(-1);
  if (anchor === undefined || anchor.nonce !== address.sourceNonce) {
    return deny(
      ReasonCode.CONVERSATION_TURN_REPLY_CONFLICT,
      "the reply's address is not the message the turn answers",
      parked("address-is-not-the-answered-message"),
    );
  }
  if (item.sources.some((source) => source.channel !== address.channel)) {
    return deny(ReasonCode.CONVERSATION_TURN_REPLY_CONFLICT, "the turn's messages span channels", parked("sources-span-channels"));
  }
  const replyToEventId = address.sourceNonce.startsWith(BUZZ_MESSAGE_NONCE_PREFIX)
    ? address.sourceNonce.slice(BUZZ_MESSAGE_NONCE_PREFIX.length)
    : "";
  if (!EVENT_ID.test(replyToEventId)) {
    return deny(
      ReasonCode.CONVERSATION_TURN_REPLY_UNADDRESSABLE,
      "the reply names no Buzz event to answer",
      parked("address-names-no-event-to-answer"),
    );
  }
  const signer = typeof address.replyAs === "string" && EVENT_ID.test(address.replyAs) ? address.replyAs : null;
  return allow(ReasonCode.OK, { room: address.conversation, replyToEventId, signer });
};

/** The tags of a reply in `room` to `replyToEventId`, in the shape the live relay writes them. */
const replyTagsFor = (target: BuzzReplyTarget): string[][] => [
  ["h", target.room],
  ["e", target.replyToEventId, "", "reply"],
];

/**
 * The stored intent's event, when it is a validly signed reply to exactly this item: this signer,
 * this room and event, and text whose digest is the receipt's. Anything else is `null`.
 */
const storedEventOf = (intent: OwnerReplyIntent, target: BuzzReplyTarget, digest: string): BuzzSignedEvent | null => {
  const { id, pubkey, created_at: createdAt, kind, tags, content, sig } = intent.event;
  if (typeof id !== "string" || id !== intent.eventId || typeof pubkey !== "string" || typeof sig !== "string") {
    return null;
  }
  if (typeof createdAt !== "number" || typeof kind !== "number" || typeof content !== "string") return null;
  if (!Array.isArray(tags) || !tags.every((tag) => Array.isArray(tag) && tag.every((part) => typeof part === "string"))) {
    return null;
  }
  const event: BuzzSignedEvent = {
    id,
    pubkey,
    created_at: createdAt,
    kind,
    tags: (tags as string[][]).map((tag) => [...tag]),
    content,
    sig,
  };
  if (pubkey !== target.signer || kind !== BUZZ_MENTION_KIND || sha256(content) !== digest) return null;
  if (canonicalJson(event.tags) !== canonicalJson(replyTagsFor(target))) return null;
  // `verifyEvent` marks the object it is given, so it checks a copy and the stored event stays as read.
  return verifyEvent({ ...event, tags: event.tags.map((tag) => [...tag]) }) ? event : null;
};

/** The NIP-01 machine-readable prefix of a relay's refusal, which is all of it an audit row keeps. */
const refusalPrefixOf = (message: string): string => /^([a-z-]{1,32}):/u.exec(message)?.[1] ?? "unprefixed";

export class OwnerReplyConsumer {
  readonly #db: Db;
  readonly #clock: Clock;
  readonly #audit: AuditLog;
  readonly #buzz: BuzzReplyPublisher | null;
  readonly #timers: OwnerReplyTimers;
  readonly #publishTimeoutMs: number;
  readonly #onError: (error: unknown) => void;
  readonly #authority: OwnerReplyDeliveryAuthority;
  #running: Promise<void> | null = null;
  #again: OwnerReplySweep | null = null;
  #timer: number | null = null;
  #closed = false;

  constructor(options: OwnerReplyConsumerOptions) {
    this.#db = options.db;
    this.#clock = options.clock;
    this.#audit = options.audit;
    this.#buzz = options.buzz;
    this.#timers = options.timers;
    this.#publishTimeoutMs = options.publishTimeoutMs ?? OWNER_REPLY_PUBLISH_TIMEOUT_MS;
    this.#onError = options.onError ?? (() => undefined);
    this.#authority = claimOwnerReplyDeliveryAuthority(options.db);
  }

  /** The startup sweep: every owed item, whatever its backoff. */
  start(): Promise<void> {
    return this.wake("ALL");
  }

  /**
   * Runs a pass, or widens the pass already running so it goes round once more. One pass runs at a
   * time, so two wake-ups never work the same item at once. The promise settles when no pass is left.
   */
  wake(sweep: OwnerReplySweep = "DUE"): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (this.#running !== null) {
      if (this.#again === null || SWEEP_REACH[sweep] > SWEEP_REACH[this.#again]) this.#again = sweep;
      return this.#running;
    }
    const running = this.#drain(sweep).finally(() => {
      this.#running = null;
    });
    this.#running = running;
    return running;
  }

  close(): void {
    this.#closed = true;
    if (this.#timer !== null) this.#timers.clearTimer(this.#timer);
    this.#timer = null;
  }

  async #drain(first: OwnerReplySweep): Promise<void> {
    let sweep: OwnerReplySweep | null = first;
    try {
      while (sweep !== null && !this.#closed) {
        this.#again = null;
        await this.#pass(sweep);
        sweep = this.#again;
      }
      this.#arm();
    } catch (error) {
      this.#onError(error);
    }
  }

  async #pass(sweep: OwnerReplySweep): Promise<void> {
    for (const turnRequestId of owedOwnerReplyTurns(this.#db)) {
      if (this.#closed) return;
      try {
        const state = ownerReplyDeliveryState(this.#db, turnRequestId);
        if (state?.status !== "PENDING" || !this.#selected(sweep, state)) continue;
        const item = ownerReplyFor(this.#db, turnRequestId);
        if (item?.status !== "PENDING") continue;
        const attempt = await this.#attempt(item, state);
        if (!attempt.allowed) this.#recordUndelivered(item.turnRequestId, state, attempt);
      } catch (error) {
        this.#onError(error);
      }
    }
  }

  #selected(sweep: OwnerReplySweep, state: OwnerReplyDeliveryState): boolean {
    if (sweep === "ALL") return true;
    if (state.retryAt === null || Date.parse(state.retryAt) <= this.#clock.now().getTime()) return true;
    return sweep === "RELAY" && state.blocked?.transient === true;
  }

  #recordUndelivered(turnRequestId: string, state: OwnerReplyDeliveryState, refusal: Decision<AttemptOutcome>): void {
    const step = Math.min(state.attempts, OWNER_REPLY_RETRY_BACKOFF_MS.length - 1);
    const backoff = OWNER_REPLY_RETRY_BACKOFF_MS[step] ?? 900_000;
    const cause = refusal.evidence["cause"];
    recordOwnerReplyUndelivered(this.#authority, this.#db, this.#clock, this.#audit, turnRequestId, {
      reasonCode: refusal.reasonCode,
      cause: typeof cause === "string" ? cause : "unstated",
      transient: refusal.evidence["transient"] === true,
      retryAt: new Date(this.#clock.now().getTime() + backoff).toISOString(),
    });
  }

  /** One timer, for the earliest relay failure due a retry. Nothing else arms one. */
  #arm(): void {
    if (this.#timer !== null) this.#timers.clearTimer(this.#timer);
    this.#timer = null;
    if (this.#closed) return;
    let earliest: number | null = null;
    for (const turnRequestId of owedOwnerReplyTurns(this.#db)) {
      const state = ownerReplyDeliveryState(this.#db, turnRequestId);
      if (state?.blocked?.transient !== true || state.retryAt === null) continue;
      const at = Date.parse(state.retryAt);
      if (earliest === null || at < earliest) earliest = at;
    }
    if (earliest === null) return;
    this.#timer = this.#timers.setTimer(Math.max(0, earliest - this.#clock.now().getTime()), () => {
      this.#timer = null;
      void this.wake("DUE");
    });
  }

  async #attempt(item: OwnerReplyItem, state: OwnerReplyDeliveryState): Promise<Decision<AttemptOutcome>> {
    if (item.address.channel === "telegram") {
      return deny(
        ReasonCode.OWNER_REPLY_UNDELIVERABLE_NO_TRANSPORT,
        "this daemon has no Telegram reply transport; the reply stays owed and is not sent another way",
        parked("telegram-transport-not-configured"),
      );
    }
    if (item.address.channel !== "buzz") {
      return deny(
        ReasonCode.OWNER_REPLY_UNDELIVERABLE_NO_TRANSPORT,
        "no reply transport exists for this channel",
        parked("no-reply-transport-for-channel"),
      );
    }
    const targeted = buzzTargetOf(item);
    if (!targeted.allowed) return deny(targeted.reasonCode, targeted.message, targeted.evidence);
    const target = targeted.value;
    const buzz = this.#buzz;
    if (buzz === null) {
      return deny(
        ReasonCode.OWNER_REPLY_UNDELIVERABLE_NO_TRANSPORT,
        "this daemon runs no Buzz subscriber to publish through",
        parked("buzz-subscriber-not-running"),
      );
    }
    const rooms = target.signer === null ? null : buzz.roomsOf(target.signer);
    if (target.signer === null || rooms === null) {
      return deny(
        ReasonCode.OWNER_REPLY_IDENTITY_UNKNOWN,
        "the reply names no channel identity this daemon holds",
        parked(target.signer === null ? "address-names-no-identity" : "identity-not-held-by-this-daemon"),
      );
    }
    if (!rooms.includes(target.room)) {
      return deny(
        ReasonCode.OWNER_REPLY_WRONG_ROOM,
        "the signing identity is not subscribed to the reply's room",
        parked("identity-not-subscribed-to-room"),
      );
    }

    const digest = item.receipt.evidenceDigest;
    let intent = state.intent;
    if (intent === null) {
      const text = item.replyText;
      if (text === undefined || text.trim() === "" || sha256(text) !== digest) {
        return deny(
          ReasonCode.OWNER_REPLY_BODY_UNAVAILABLE,
          "the item holds no reply text the receipt proved",
          parked(text === undefined
            ? "reply-text-absent"
            : text.trim() === "" ? "reply-text-empty" : "reply-text-digest-mismatch"),
        );
      }
      if (!buzz.ready(target.signer)) return allow(ReasonCode.OK, "WAITING");
      const signed = buzz.sign(target.signer, {
        kind: BUZZ_MENTION_KIND,
        created_at: Math.floor(this.#clock.now().getTime() / 1000),
        tags: replyTagsFor(target),
        content: text,
      });
      if (signed === null) {
        return deny(
          ReasonCode.OWNER_REPLY_IDENTITY_UNKNOWN,
          "the reply names no channel identity this daemon holds",
          parked("identity-not-held-by-this-daemon"),
        );
      }
      const recorded = recordOwnerReplyIntent(this.#authority, this.#db, this.#clock, item.turnRequestId, {
        transport: "buzz",
        eventId: signed.id,
        event: { ...signed, tags: signed.tags.map((tag) => [...tag]) },
      });
      if (!recorded.allowed) return allow(ReasonCode.OK, "SETTLED_ELSEWHERE");
      intent = recorded.value;
    }
    const event = storedEventOf(intent, target, digest);
    if (event === null) {
      return deny(
        ReasonCode.CONVERSATION_TURN_REPLY_CONFLICT,
        "the event recorded for this reply is not a signed reply to this item",
        parked("recorded-event-does-not-match-item"),
      );
    }
    if (!buzz.ready(target.signer)) return allow(ReasonCode.OK, "WAITING");

    const ack = await buzz.publish(event, this.#publishTimeoutMs);
    if (ack.status === "ACCEPTED" || (ack.status === "REFUSED" && ack.message.startsWith("duplicate:"))) {
      const delivered = recordOwnerReplyDelivered(this.#authority, this.#db, this.#clock, this.#audit, item.turnRequestId, {
        transport: "buzz",
        eventId: event.id,
        signer: event.pubkey,
        conversation: target.room,
        replyToEventId: target.replyToEventId,
        relayUrl: buzz.relayUrl ?? "",
        relayMessage: ack.message.slice(0, 200),
        contentDigest: digest,
      });
      return allow(ReasonCode.OK, delivered.allowed ? "DELIVERED" : "SETTLED_ELSEWHERE");
    }
    if (ack.status === "REFUSED") {
      return deny(ReasonCode.OWNER_REPLY_RELAY_REFUSED, "the relay refused the reply", relayFailure(refusalPrefixOf(ack.message)));
    }
    if (ack.status === "TIMEOUT") {
      return deny(ReasonCode.OWNER_REPLY_RELAY_TIMEOUT, "the relay gave no verdict in time", relayFailure("no-verdict-within-bound"));
    }
    return deny(
      ReasonCode.OWNER_REPLY_RELAY_UNAVAILABLE,
      "the signer's connection ended before the relay answered",
      relayFailure("connection-ended-before-verdict"),
    );
  }
}
