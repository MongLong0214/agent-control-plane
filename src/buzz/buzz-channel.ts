import { finalizeEvent, getPublicKey, validateEvent, verifyEvent } from "nostr-tools/pure";
import { makeAuthEvent } from "nostr-tools/nip42";

import {
  BUZZ_MENTION_KIND,
  MAX_RELAY_FRAME_BYTES,
  RELAY_RECONNECT_BACKOFF_MS,
  nativeRelaySocketFactory,
  type BuzzRelaySocket,
  type BuzzRelaySocketFactory,
} from "./buzz-mention-subscriber.ts";

/**
 * The Buzz side of a CTO session's Claude Code channel (`notifications/claude/channel`).
 *
 * One instance is one CTO identity in its project's room(s): it holds that CTO's own key, an
 * authenticated relay subscription, and nothing else. It never holds the CEO's key and cannot be
 * given one: `signer` is whatever key the instance was built with, `ceoPubkeys` only ever names who
 * may be heard, and construction refuses a key whose public half is a heard actor.
 *
 * What it delivers is deliberately narrower than what the daemon's mention subscriber admits. The
 * daemon's queue stays the durable record; this is the real-time path in front of it. An event is
 * delivered when it is a verified kind-9 in one of the bound rooms, was authored by the bound CEO
 * actor or a declared owner, and is addressed to this CTO: it names this CTO as its only `p`, or
 * answers (an `e` tag) an event this CTO has been delivered or has published, or is an owner's
 * message that names nobody. The author, never the text, decides who may speak: the content is
 * handed over as untrusted data and carries no authority of its own.
 */

/** The server name Claude Code shows as the `source` of a channel message. */
export const BUZZ_CHANNEL_SERVER_NAME = "acp-buzz-channel";

/** The relay's cap on a body this module will sign. */
export const MAX_REPLY_CHARACTERS = 16_000;

/** How long a published reply waits for the relay's verdict. */
export const PUBLISH_TIMEOUT_MS = 10_000;

/** How often an idle connection proves it is still answered, and how long it has to answer. */
export const KEEPALIVE_INTERVAL_MS = 45_000;
export const KEEPALIVE_ANSWER_MS = 15_000;

/**
 * An event is asked for again from a little before the newest one seen. The relay orders by its own
 * clock and a sender's `created_at` is the sender's, so "the last one seen" is not "nothing earlier
 * is still coming". The dedupe set makes the overlap free.
 */
export const RESUME_OVERLAP_SECONDS = 10;

/** First start with no saved cursor: ask this far back, so a message sent while the session was starting is not lost. */
export const FIRST_START_LOOKBACK_SECONDS = 300;

const THREAD_LIMIT = 4096;
const PERSISTED_THREADS = 1024;

export type ChannelSenderRole = "ceo" | "owner";

/** The `params` of `notifications/claude/channel`. Meta keys are identifiers; values are strings. */
export interface ChannelNotification {
  readonly content: string;
  readonly meta: Readonly<Record<string, string>>;
}

/** What the daemon is told, in order to move its durable queue. Written by the server, applied by the daemon. */
export type ChannelReceipt =
  | {
      readonly type: "emitted";
      readonly eventId: string;
      readonly room: string;
      readonly senderPubkey: string;
      readonly emittedAt: number;
    }
  | {
      readonly type: "replied";
      readonly event: SignedEvent;
      readonly room: string;
      readonly parentEventId: string;
      readonly ack: "ACCEPTED" | "DUPLICATE";
      readonly repliedAt: number;
    };

export interface SignedEvent {
  readonly id: string;
  readonly pubkey: string;
  readonly created_at: number;
  readonly kind: number;
  readonly tags: readonly (readonly string[])[];
  readonly content: string;
  readonly sig: string;
}

const isString = (value: unknown): value is string => typeof value === "string";
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/**
 * Whether a parsed value has the exact shape of a receipt. Receipts come from a file any process of this
 * user can append to, so a reader checks each one's shape before reading a field of it: one malformed
 * receipt is skipped and counted, never allowed to abort the ones around it.
 */
export const isChannelReceipt = (value: unknown): value is ChannelReceipt => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  if (r["type"] === "emitted") {
    return isString(r["eventId"]) && isString(r["room"]) && isString(r["senderPubkey"]) && isCount(r["emittedAt"]);
  }
  if (r["type"] !== "replied") return false;
  const e = r["event"];
  if (typeof e !== "object" || e === null || Array.isArray(e)) return false;
  const event = e as Record<string, unknown>;
  return (
    isString(event["id"]) && isString(event["pubkey"]) && isString(event["sig"]) && isString(event["content"]) &&
    Number.isSafeInteger(event["created_at"]) && Number.isSafeInteger(event["kind"]) &&
    Array.isArray(event["tags"]) && event["tags"].every((tag) => Array.isArray(tag) && tag.every(isString)) &&
    isString(r["room"]) && isString(r["parentEventId"]) && (r["ack"] === "ACCEPTED" || r["ack"] === "DUPLICATE") && isCount(r["repliedAt"])
  );
};

/**
 * The state that outlives the process: where to resume, what has already been shown, and which events a
 * thread can still be answered under.
 *
 * `cursor` is where a restart asks from, never past an event that was not delivered. `seen` holds every
 * delivered id (with the time it was written) that a resume could replay, so it is pruned by that time
 * and never by count. `threads` are `[id, author, room, root]` for every event delivered or posted here.
 */
export interface ChannelState {
  readonly cursor: number;
  readonly seen: readonly (readonly [string, number])[];
  readonly threads: readonly (readonly [string, string, string, string])[];
}

export interface ChannelStateStore {
  load(): ChannelState | null;
  save(state: ChannelState): void;
}

export interface ChannelScheduler {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  nowSeconds(): number;
}

export const nativeChannelScheduler: ChannelScheduler = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
  nowSeconds: () => Math.floor(Date.now() / 1000),
};

export type ChannelSkipReason =
  | "not-kind-9"
  | "own-event"
  | "other-room"
  | "unbound-actor"
  | "other-recipient"
  | "not-addressed"
  | "duplicate";

export type ChannelVerdict =
  | { readonly deliver: true; readonly role: ChannelSenderRole; readonly room: string; readonly replyTo: string }
  | { readonly deliver: false; readonly reason: ChannelSkipReason };

export interface BuzzChannelOptions {
  readonly relayUrl: string;
  readonly projectId: string;
  /** The CTO's own secret key: the only key this instance ever signs with. */
  readonly secretKey: Uint8Array;
  /** The project's room(s). Both subscription and reply are scoped to exactly these. */
  readonly rooms: readonly string[];
  /** The bound CEO actor(s), read when an event arrives so a CEO re-claim is followed. */
  readonly ceoPubkeys: () => readonly string[];
  readonly ownerPubkeys: readonly string[];
  /** Hands one notification to the session. Resolves once it is written to the transport. */
  readonly onNotification: (notification: ChannelNotification) => Promise<void>;
  readonly onReceipt?: (receipt: ChannelReceipt) => void;
  readonly onDiagnostic?: (line: string) => void;
  readonly openSocket?: BuzzRelaySocketFactory;
  readonly scheduler?: ChannelScheduler;
  readonly store?: ChannelStateStore;
}

/**
 * What a reply is, said by its sender: the CEO answers or decides what is marked `question`,
 * `ruling_request` or `conflict`, and only reads a `report`. It is written on the signed event as
 * `["acp-kind", kind]`, so it is the sender's own mark and not something a reader infers from the text.
 */
export const REPLY_KINDS = ["question", "ruling_request", "conflict", "report"] as const;
export type ReplyKind = (typeof REPLY_KINDS)[number];
export const REPLY_KIND_TAG = "acp-kind";

export interface ReplyInput {
  readonly room: string;
  readonly eventId: string;
  readonly kind: ReplyKind;
  readonly text: string;
}

export type ReplyOutcome =
  | { readonly ok: true; readonly eventId: string; readonly ack: "ACCEPTED" | "DUPLICATE" }
  | { readonly ok: false; readonly reason: string };

export interface BuzzChannelStatus {
  readonly connected: boolean;
  readonly subscribed: boolean;
  readonly delivered: number;
  readonly cursor: number | null;
}

const HEX64 = /^[0-9a-f]{64}$/u;
const ROOM_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

interface RelayEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A fresh seven-field copy of what the relay sent, or `null`; the relay chose the shape of the original. */
const plainEventOf = (value: unknown): RelayEvent | null => {
  if (!isPlainObject(value)) return null;
  const { id, pubkey, created_at: createdAt, kind, tags, content, sig } = value;
  if (typeof id !== "string" || typeof pubkey !== "string" || typeof sig !== "string") return null;
  if (typeof content !== "string") return null;
  if (typeof createdAt !== "number" || !Number.isSafeInteger(createdAt)) return null;
  if (typeof kind !== "number" || !Number.isSafeInteger(kind)) return null;
  if (!Array.isArray(tags)) return null;
  const copied: string[][] = [];
  for (const tag of tags) {
    if (!Array.isArray(tag) || !tag.every((member): member is string => typeof member === "string")) return null;
    copied.push([...tag]);
  }
  return { id, pubkey, created_at: createdAt, kind, tags: copied, content, sig };
};

const tagValues = (event: { tags: readonly (readonly string[])[] }, name: string): string[] =>
  event.tags.filter((tag) => tag[0] === name).map((tag) => tag[1] ?? "");

/** The event this one answers: its `reply`-marked `e` tag, else its last `e` tag, else `""`. */
export const replyToOf = (event: { tags: readonly (readonly string[])[] }): string => {
  const marked = event.tags.find((tag) => tag[0] === "e" && tag[3] === "reply");
  if (marked?.[1]) return marked[1];
  const all = event.tags.filter((tag) => tag[0] === "e");
  return all.length === 0 ? "" : (all[all.length - 1]?.[1] ?? "");
};

/**
 * The channel body is untrusted data inside a `<channel>` tag. A literal closing tag in it would end
 * the element early and let the rest read as the session's own text, so it is broken, not escaped
 * wholesale: everything else reaches the session byte for byte.
 */
export const neutralizeChannelText = (text: string): string => text.replace(/<(\/?)channel/giu, "<$1​channel");

/** Exact membership: one Map-backed set that forgets its oldest entries, not its newest. */
class Recent<K, V> {
  readonly #map = new Map<K, V>();
  readonly limit: number;
  constructor(limit: number) {
    this.limit = limit;
  }
  has(key: K): boolean {
    return this.#map.has(key);
  }
  get(key: K): V | undefined {
    return this.#map.get(key);
  }
  add(key: K, value: V): void {
    this.#map.delete(key);
    this.#map.set(key, value);
    while (this.#map.size > this.limit) this.#map.delete(this.#map.keys().next().value as K);
  }
  entries(): [K, V][] {
    return [...this.#map.entries()];
  }
}

export class BuzzChannelRelay {
  readonly pubkey: string;
  readonly #o: BuzzChannelOptions;
  readonly #open: BuzzRelaySocketFactory;
  readonly #sched: ChannelScheduler;
  /** Delivered event id -> when it was written. Pruned by that time (a resume never asks before the cursor), not by count. */
  readonly #seen = new Map<string, number>();
  /** Events whose notification failed: id -> clamped time. The resume point never passes the oldest of them. */
  readonly #retry = new Map<string, number>();
  /** Every event delivered here or posted from here: where it was written, by whom, and the thread it belongs to. */
  readonly #known = new Recent<string, KnownEvent>(THREAD_LIMIT);
  readonly #subId: string;
  #socket: BuzzRelaySocket | null = null;
  #generation = 0;
  #authId: string | null = null;
  #subscribed = false;
  #attempt = 0;
  #cursor: number | null = null;
  #delivered = 0;
  #closed = false;
  #reconnect: unknown = null;
  #keepalive: unknown = null;
  #probeId: string | null = null;
  #probeTimer: unknown = null;
  #chain: Promise<void> = Promise.resolve();
  readonly #pending = new Map<string, { generation: number; settle: (ack: ReplyAckResult) => void; timer: unknown }>();

  constructor(options: BuzzChannelOptions) {
    this.#o = options;
    this.pubkey = getPublicKey(options.secretKey);
    this.#open = options.openSocket ?? nativeRelaySocketFactory;
    this.#sched = options.scheduler ?? nativeChannelScheduler;
    this.#subId = `acp-channel-${this.pubkey.slice(0, 12)}`;
    if (options.rooms.length === 0) throw new Error("a Buzz channel needs at least one room");
    for (const room of options.rooms) {
      if (!ROOM_SHAPE.test(room)) throw new Error("a Buzz channel room is not a room id");
    }
    const heard = new Set([...options.ownerPubkeys, ...options.ceoPubkeys()]);
    if (heard.has(this.pubkey)) {
      // The refusal that makes "a reply cannot be signed with the CEO key" structural: a process
      // started with a key that belongs to the heard side is the wrong process, not a configuration.
      throw new Error("the channel's signing key is the CEO's or an owner's, not this CTO's own");
    }
    const saved = options.store?.load() ?? null;
    if (saved !== null) {
      this.#cursor = saved.cursor;
      for (const [id, at] of saved.seen) this.#seen.set(id, at);
      for (const [id, author, room, root] of saved.threads) this.#known.add(id, { author, room, root });
    }
  }

  status(): BuzzChannelStatus {
    return { connected: this.#socket !== null, subscribed: this.#subscribed, delivered: this.#delivered, cursor: this.#resumeFrom() };
  }

  /**
   * Where a resume asks from: the newest event handled, but never past the oldest one whose notification
   * failed, so a failure keeps its place in line however many later events were delivered.
   */
  #resumeFrom(): number | null {
    const oldestFailed = this.#retry.size === 0 ? null : Math.min(...this.#retry.values());
    if (oldestFailed === null) return this.#cursor;
    return this.#cursor === null ? oldestFailed : Math.min(this.#cursor, oldestFailed);
  }

  start(): void {
    this.#closed = false;
    this.#connect();
  }

  close(): void {
    this.#closed = true;
    this.#teardown();
    for (const handle of [this.#reconnect]) if (handle !== null) this.#sched.clearTimeout(handle);
    this.#reconnect = null;
  }

  /** Resolves once every frame already received has been handled. */
  settled(): Promise<void> {
    return this.#chain;
  }

  /**
   * Decides whether one verified event is delivered, and why not when it is not. Pure over this
   * instance's current thread set; it never delivers and never mutates.
   */
  classify(event: {
    pubkey: string;
    kind: number;
    tags: readonly (readonly string[])[];
    id: string;
  }): ChannelVerdict {
    if (event.kind !== BUZZ_MENTION_KIND) return { deliver: false, reason: "not-kind-9" };
    if (event.pubkey === this.pubkey) return { deliver: false, reason: "own-event" };
    const rooms = tagValues(event, "h");
    const room = rooms.length === 1 ? rooms[0]! : "";
    if (room === "" || !this.#o.rooms.includes(room)) return { deliver: false, reason: "other-room" };
    const role: ChannelSenderRole | null = this.#o.ownerPubkeys.includes(event.pubkey)
      ? "owner"
      : this.#o.ceoPubkeys().includes(event.pubkey)
        ? "ceo"
        : null;
    if (role === null) return { deliver: false, reason: "unbound-actor" };
    const recipients = tagValues(event, "p");
    const replyTo = replyToOf(event);
    if (recipients.length > 1 || (recipients.length === 1 && recipients[0] !== this.pubkey)) {
      return { deliver: false, reason: "other-recipient" };
    }
    const mentionsMe = recipients.length === 1;
    // A thread is (room, root): a reply belongs to one this CTO is in only when the event it answers was
    // delivered or posted here, in the same room. An id seen in another room names nothing in this one.
    const parent = replyTo === "" ? undefined : this.#known.get(replyTo);
    const inThread = parent !== undefined && parent.room === room;
    // An owner's message that names nobody is addressed to this room's CTO only when it starts a topic:
    // a reply (any `e` tag) is for the thread it is in, and a thread this CTO never joined is not its own.
    const ownerOpen = role === "owner" && recipients.length === 0 && tagValues(event, "e").length === 0;
    if (!mentionsMe && !inThread && !ownerOpen) return { deliver: false, reason: "not-addressed" };
    if (this.#seen.has(event.id)) return { deliver: false, reason: "duplicate" };
    return { deliver: true, role, room, replyTo };
  }

  /** Signs with this CTO's key, threads under `eventId` in `room`, and waits for the relay's verdict. */
  async reply(input: ReplyInput): Promise<ReplyOutcome> {
    // Nothing is signed for a reply that does not say what it is: no kind, or one of any other spelling.
    if (typeof input.kind !== "string" || !(REPLY_KINDS as readonly string[]).includes(input.kind)) {
      return { ok: false, reason: `kind must be exactly one of ${REPLY_KINDS.join(", ")}` };
    }
    if (!this.#o.rooms.includes(input.room)) return { ok: false, reason: "room is not one of this CTO's rooms" };
    if (!HEX64.test(input.eventId)) return { ok: false, reason: "eventId is not a Buzz event id" };
    if (input.text.trim().length === 0) return { ok: false, reason: "the reply is empty" };
    if (input.text.length > MAX_REPLY_CHARACTERS) return { ok: false, reason: "the reply is too long" };
    // Only an event this channel delivered can be answered, and only in the room it was written in: the
    // reply is addressed to that event's author, so a parent nobody here received has no one to answer.
    const parent = this.#known.get(input.eventId);
    if (parent === undefined) return { ok: false, reason: "that event was not received on this channel" };
    if (parent.room !== input.room) return { ok: false, reason: "that event was written in another room" };
    const recipient = parent.author;
    if (recipient === this.pubkey) return { ok: false, reason: "that event is this CTO's own" };
    const socket = this.#socket;
    if (socket === null || !this.#subscribed) return { ok: false, reason: "the relay connection is not up" };
    const event = finalizeEvent(
      {
        kind: BUZZ_MENTION_KIND,
        created_at: this.#sched.nowSeconds(),
        tags: [["h", input.room], ["e", input.eventId, "", "reply"], ["p", recipient], [REPLY_KIND_TAG, input.kind]],
        content: input.text,
      },
      this.#o.secretKey,
    );
    if (event.pubkey !== this.pubkey) return { ok: false, reason: "the signature is not this CTO's" };
    const generation = this.#generation;
    const ack = await new Promise<ReplyAckResult>((settle) => {
      const timer = this.#sched.setTimeout(() => {
        this.#pending.delete(event.id);
        settle({ status: "TIMEOUT" });
      }, PUBLISH_TIMEOUT_MS);
      this.#pending.set(event.id, { generation, settle, timer });
      socket.send(JSON.stringify(["EVENT", event]));
    });
    if (ack.status !== "ACCEPTED" && ack.status !== "DUPLICATE") {
      return { ok: false, reason: `the relay did not accept the reply (${ack.status})` };
    }
    this.#known.add(event.id, { author: this.pubkey, room: input.room, root: parent.root });
    this.#persist();
    this.#o.onReceipt?.({
      type: "replied",
      event,
      room: input.room,
      parentEventId: input.eventId,
      ack: ack.status,
      repliedAt: this.#sched.nowSeconds(),
    });
    return { ok: true, eventId: event.id, ack: ack.status };
  }

  // ---- connection ---------------------------------------------------------------------------

  #connect(): void {
    if (this.#closed) return;
    this.#teardown();
    const generation = ++this.#generation;
    let socket: BuzzRelaySocket;
    try {
      socket = this.#open(this.#o.relayUrl, {
        onOpen: () => undefined,
        onFrame: (raw) => {
          if (generation !== this.#generation) return;
          this.#chain = this.#chain.then(() => this.#frame(raw, generation)).catch(() => undefined);
        },
        onClose: () => {
          if (generation !== this.#generation) return;
          this.#lost();
        },
      });
    } catch {
      this.#lost();
      return;
    }
    this.#socket = socket;
  }

  #teardown(): void {
    this.#generation += 1;
    const socket = this.#socket;
    this.#socket = null;
    this.#subscribed = false;
    this.#authId = null;
    this.#probeId = null;
    if (this.#keepalive !== null) this.#sched.clearTimeout(this.#keepalive);
    if (this.#probeTimer !== null) this.#sched.clearTimeout(this.#probeTimer);
    this.#keepalive = null;
    this.#probeTimer = null;
    for (const [id, pending] of this.#pending) {
      this.#sched.clearTimeout(pending.timer);
      pending.settle({ status: "UNAVAILABLE" });
      this.#pending.delete(id);
    }
    try {
      socket?.close();
    } catch {
      /* already closing */
    }
  }

  #lost(): void {
    if (this.#closed) return;
    this.#teardown();
    const backoff = RELAY_RECONNECT_BACKOFF_MS[Math.min(this.#attempt, RELAY_RECONNECT_BACKOFF_MS.length - 1)]!;
    this.#attempt += 1;
    if (this.#reconnect !== null) this.#sched.clearTimeout(this.#reconnect);
    this.#reconnect = this.#sched.setTimeout(() => {
      this.#reconnect = null;
      this.#connect();
    }, backoff);
  }

  #filters(): Record<string, unknown>[] {
    const resume = this.#resumeFrom();
    const since = resume === null
      ? this.#sched.nowSeconds() - FIRST_START_LOOKBACK_SECONDS
      : Math.max(0, resume - RESUME_OVERLAP_SECONDS);
    const authors = [...new Set([...this.#o.ownerPubkeys, ...this.#o.ceoPubkeys()])];
    const filters: Record<string, unknown>[] = [
      { kinds: [BUZZ_MENTION_KIND], "#p": [this.pubkey], "#h": [...this.#o.rooms], since },
    ];
    // Replies in a thread and an owner's open messages name nobody, so the `#p` filter cannot see them.
    if (authors.length > 0) filters.push({ kinds: [BUZZ_MENTION_KIND], authors, "#h": [...this.#o.rooms], since });
    return filters;
  }

  async #frame(raw: string, generation: number): Promise<void> {
    if (generation !== this.#generation || Buffer.byteLength(raw, "utf8") > MAX_RELAY_FRAME_BYTES) {
      if (generation === this.#generation) this.#lost();
      return;
    }
    let frame: unknown;
    try {
      frame = JSON.parse(raw) as unknown;
    } catch {
      this.#lost();
      return;
    }
    if (!Array.isArray(frame) || typeof frame[0] !== "string") {
      this.#lost();
      return;
    }
    switch (frame[0]) {
      case "AUTH": {
        if (typeof frame[1] !== "string" || frame[1].length === 0) return this.#lost();
        const signed = finalizeEvent(makeAuthEvent(this.#o.relayUrl, frame[1]), this.#o.secretKey);
        this.#authId = signed.id;
        this.#socket?.send(JSON.stringify(["AUTH", signed]));
        return;
      }
      case "OK":
        return this.#ok(frame, generation);
      case "EVENT":
        return await this.#event(frame);
      case "EOSE":
        if (frame[1] === this.#subId) this.#attempt = 0;
        if (typeof frame[1] === "string" && frame[1] === this.#probeId) this.#probeAnswered();
        return;
      case "CLOSED":
        if (frame[1] === this.#probeId) return this.#probeAnswered();
        if (frame[1] === this.#subId) this.#lost();
        return;
      default:
        return;
    }
  }

  #ok(frame: readonly unknown[], generation: number): void {
    if (frame.length !== 4 || typeof frame[1] !== "string" || typeof frame[2] !== "boolean" || typeof frame[3] !== "string") {
      return this.#lost();
    }
    const id = frame[1];
    if (id === this.#authId) {
      if (frame[2] !== true) return this.#lost();
      this.#subscribed = true;
      this.#socket?.send(JSON.stringify(["REQ", this.#subId, ...this.#filters()]));
      this.#armKeepalive();
      return;
    }
    const pending = this.#pending.get(id);
    if (pending === undefined || pending.generation !== generation) return;
    this.#pending.delete(id);
    this.#sched.clearTimeout(pending.timer);
    const message = frame[3];
    pending.settle(
      message.startsWith("duplicate:") ? { status: "DUPLICATE" } : frame[2] ? { status: "ACCEPTED" } : { status: "REFUSED" },
    );
  }

  async #event(frame: readonly unknown[]): Promise<void> {
    if (frame.length !== 3 || typeof frame[1] !== "string") return this.#lost();
    if (!this.#subscribed || frame[1] !== this.#subId) return;
    this.#armKeepalive();
    const event = plainEventOf(frame[2]);
    if (event === null || !validateEvent(event) || !verifyEvent(event)) return;
    const verdict = this.classify(event);
    if (verdict.deliver) {
      const notification: ChannelNotification = {
        content: neutralizeChannelText(event.content),
        meta: {
          sender_role: verdict.role,
          sender_pubkey: event.pubkey,
          room: verdict.room,
          event_id: event.id,
          reply_to_event_id: verdict.replyTo,
          project: this.#o.projectId,
          trust: "untrusted_peer_message",
        },
      };
      const claimed = Math.min(event.created_at, this.#sched.nowSeconds());
      try {
        await this.#o.onNotification(notification);
      } catch {
        // Not marked seen, and the resume point stays at or before it however many later events are
        // delivered: the next connection asks for it again.
        this.#retry.set(event.id, claimed);
        this.#o.onDiagnostic?.("channel notification was not written to the session");
        this.#persist();
        return;
      }
      this.#retry.delete(event.id);
      this.#seen.set(event.id, event.created_at);
      const parent = verdict.replyTo === "" ? undefined : this.#known.get(verdict.replyTo);
      this.#known.add(event.id, {
        author: event.pubkey,
        room: verdict.room,
        root: parent !== undefined && parent.room === verdict.room ? parent.root : event.id,
      });
      this.#delivered += 1;
      this.#o.onReceipt?.({
        type: "emitted",
        eventId: event.id,
        room: verdict.room,
        senderPubkey: event.pubkey,
        emittedAt: this.#sched.nowSeconds(),
      });
    }
    // A handled event, delivered or not, is behind the cursor; one whose notification failed is not.
    const claimed = Math.min(event.created_at, this.#sched.nowSeconds());
    this.#cursor = Math.max(this.#cursor ?? 0, claimed);
    this.#persist();
  }

  #persist(): void {
    const resume = this.#resumeFrom();
    if (resume === null) return;
    // A resume asks from `since`, so a delivered id older than that can never be replayed: those are
    // dropped by their time, and every id from there on is kept however many there are.
    const since = Math.max(0, resume - RESUME_OVERLAP_SECONDS);
    for (const [id, at] of this.#seen) if (at < since) this.#seen.delete(id);
    this.#o.store?.save({
      cursor: resume,
      seen: [...this.#seen.entries()],
      threads: this.#known.entries().slice(-PERSISTED_THREADS).map(([id, e]) => [id, e.author, e.room, e.root] as const),
    });
  }

  // ---- keepalive ----------------------------------------------------------------------------
  // A relay that stops answering without closing is the failure a socket close never reports. The
  // timer fires only when the connection has been silent for a whole interval, asks the relay one
  // question it must answer (any EOSE or CLOSED counts), and replaces the connection when it does not.

  #armKeepalive(): void {
    if (this.#keepalive !== null) this.#sched.clearTimeout(this.#keepalive);
    const generation = this.#generation;
    this.#keepalive = this.#sched.setTimeout(() => {
      if (generation !== this.#generation || this.#socket === null) return;
      const id = `${this.#subId}-ka-${this.#sched.nowSeconds()}`;
      this.#probeId = id;
      this.#socket.send(JSON.stringify(["REQ", id, { kinds: [BUZZ_MENTION_KIND], authors: [this.pubkey], "#h": [this.#o.rooms[0]], limit: 1 }]));
      this.#probeTimer = this.#sched.setTimeout(() => {
        if (generation === this.#generation && this.#probeId === id) {
          this.#o.onDiagnostic?.("relay stopped answering; reconnecting");
          this.#lost();
        }
      }, KEEPALIVE_ANSWER_MS);
    }, KEEPALIVE_INTERVAL_MS);
  }

  #probeAnswered(): void {
    const id = this.#probeId;
    this.#probeId = null;
    if (this.#probeTimer !== null) this.#sched.clearTimeout(this.#probeTimer);
    this.#probeTimer = null;
    if (id !== null) this.#socket?.send(JSON.stringify(["CLOSE", id]));
    this.#armKeepalive();
  }
}

interface KnownEvent {
  readonly author: string;
  readonly room: string;
  readonly root: string;
}

type ReplyAckResult = { status: "ACCEPTED" | "DUPLICATE" | "REFUSED" | "TIMEOUT" | "UNAVAILABLE" };
