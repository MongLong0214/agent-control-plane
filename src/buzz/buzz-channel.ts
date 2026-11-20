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

/** How long a reply waits for the relay to show the event it answers, before it threads under the root it remembers. */
export const PARENT_LOOKUP_TIMEOUT_MS = 5_000;

/** The most of the relay's own refusal text a tool result carries. */
const MAX_RELAY_REASON_CHARACTERS = 200;

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

/**
 * How long a delivered event stays remembered, as an id that is not shown twice and as a parent that can
 * still be answered, when no subscription can ask for it any more. One store and one rule for both, by
 * time and never by count, so what is remembered as shown is also answerable. A thread that goes quiet
 * for longer than this is no longer one this CTO is in.
 */
export const ANSWERABLE_RETENTION_SECONDS = 24 * 60 * 60;

export type ChannelSenderRole = "ceo" | "owner";

/** The `params` of `notifications/claude/channel`. Meta keys are identifiers; values are strings. */
export interface ChannelNotification {
  readonly content: string;
  readonly meta: Readonly<Record<string, string>>;
}

/**
 * What the daemon is told, in order to move its durable queue. Written by the server, applied by the daemon. `launchId`
 * is the launch the server was started by (`--launch-id`), so a launcher can tell its own channel's receipts from an
 * older channel process's.
 */
export type ChannelReceipt = (
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
    }
) & { readonly launchId?: string };

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
  if (r["launchId"] !== undefined && !isString(r["launchId"])) return false;
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
 * One remembered event: its id, when it was written, who wrote it, the room, the thread's root, and whether
 * it was delivered to the session (a reply this CTO posted is remembered, so it can be answered, but was
 * never delivered). An entry with no author or room is an id kept only so it is not shown twice.
 */
export type ChannelEventEntry = readonly [id: string, at: number, author: string, room: string, root: string, delivered: boolean];

/**
 * The state that outlives the process.
 *
 * `cursor` is the newest event handled and `failed` the events whose notification did not reach the session;
 * where a resume asks from is always the lesser of the oldest failed one and the cursor, so a restart cannot
 * move past an event the session never saw. `events` is the one store of what is remembered, pruned by time.
 */
export interface ChannelState {
  readonly cursor: number;
  readonly failed: readonly (readonly [id: string, at: number])[];
  readonly events: readonly ChannelEventEntry[];
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

/** One Buzz message the daemon's queue holds for this role, with the signed event it was admitted from. */
export interface QueuedBuzzMessage {
  readonly eventId: string;
  readonly event: SignedEvent;
}

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
  /**
   * What the daemon's queue still holds for this role, oldest first. Asked once, when the relay first accepts the
   * channel and before the subscription is requested: each is delivered the way a relay event is, once, and the relay's
   * replay of the same event is then a repeat. A message its own rules refuse is skipped, never delivered on the
   * queue's say-so alone.
   */
  readonly backlog?: () => readonly QueuedBuzzMessage[];
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

const EVENT_ID_SHAPE = /^[0-9a-fA-F]{64}$/u;

/**
 * The `root` and `reply` markers of an event's NIP-10 `e` tags, read as the relay reads them: only a tag with four parts,
 * a marker and a 64-hex id counts, and the last valid one of each marker wins.
 */
const threadMarkers = (tags: readonly (readonly string[])[]): { root: string | null; reply: string | null } => {
  let root: string | null = null;
  let reply: string | null = null;
  for (const tag of tags) {
    if (tag.length < 4 || tag[0] !== "e" || !EVENT_ID_SHAPE.test(tag[1] ?? "")) continue;
    if (tag[3] === "root") root = tag[1]!;
    else if (tag[3] === "reply") reply = tag[1]!;
  }
  return { root, reply };
};

/**
 * The root of the thread an event is in, by the relay's whole marker resolution (buzz-core `ThreadMarkers::resolve`): a
 * `root` and a `reply` marker name the root and the parent; a `reply` marker alone names a parent that is itself the root;
 * anything else, a lone `root` marker included, is top-level, and a top-level event is the root of its own thread. A lone
 * `root` marker never anchors a reply, so it is not read as one.
 */
const threadRootOf = (event: { readonly id: string; readonly tags: readonly (readonly string[])[] }): string => {
  const { root, reply } = threadMarkers(event.tags);
  return reply === null ? event.id : (root ?? reply);
};

/**
 * What the relay says refused a publish, as one short line: its own text, control characters made spaces, cut at a bound.
 * The text is the relay's and is shown as data, never as an instruction.
 */
const relayReason = (message: string): string =>
  message.replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/\s+/gu, " ").trim().slice(0, MAX_RELAY_REASON_CHARACTERS);

/**
 * The channel body is untrusted data inside a `<channel>` tag. A literal closing tag in it would end
 * the element early and let the rest read as the session's own text, so it is broken, not escaped
 * wholesale: everything else reaches the session byte for byte.
 */
export const neutralizeChannelText = (text: string): string => text.replace(/<(\/?)channel/giu, "<$1​channel");

export class BuzzChannelRelay {
  readonly pubkey: string;
  readonly #o: BuzzChannelOptions;
  readonly #open: BuzzRelaySocketFactory;
  readonly #sched: ChannelScheduler;
  /** Events whose notification failed: id -> clamped time. The resume point never passes the oldest of them. */
  readonly #retry = new Map<string, number>();
  /**
   * Everything remembered, delivered here or posted from here: when it was written, by whom, where, the
   * thread it belongs to, and whether it was delivered. Dedupe and parents are both read from this one map.
   */
  readonly #events = new Map<string, KnownEvent>();
  /** The `since` of the subscription that is open now: it can still return anything written at or after it. */
  #activeSince: number | null = null;
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
  #backlogDone = false;
  readonly #pending = new Map<string, { generation: number; settle: (ack: ReplyAckResult) => void; timer: unknown }>();
  /** One-shot questions to the relay about an event a reply is built on: subscription id -> what is asked and heard so far. */
  readonly #lookups = new Map<string, ParentLookup>();
  #lookupSeq = 0;

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
      for (const [id, at] of saved.failed) this.#retry.set(id, at);
      for (const [id, at, author, room, root, delivered] of saved.events) this.#events.set(id, { at, author, room, root, exactRoot: false, delivered });
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
    const role = this.#roleOf(event.pubkey);
    if (role === null) return { deliver: false, reason: "unbound-actor" };
    const recipients = tagValues(event, "p");
    const replyTo = replyToOf(event);
    if (recipients.length > 1 || (recipients.length === 1 && recipients[0] !== this.pubkey)) {
      return { deliver: false, reason: "other-recipient" };
    }
    const mentionsMe = recipients.length === 1;
    // A thread is (room, root): a reply belongs to one this CTO is in only when the event it answers was
    // delivered or posted here, in the same room. An id seen in another room names nothing in this one.
    const parent = replyTo === "" ? undefined : this.#events.get(replyTo);
    const inThread = parent !== undefined && parent.room === room;
    // An owner's message that names nobody is addressed to this room's CTO only when it starts a topic:
    // a reply (any `e` tag) is for the thread it is in, and a thread this CTO never joined is not its own.
    const ownerOpen = role === "owner" && recipients.length === 0 && tagValues(event, "e").length === 0;
    if (!mentionsMe && !inThread && !ownerOpen) return { deliver: false, reason: "not-addressed" };
    if (this.#events.get(event.id)?.delivered === true) return { deliver: false, reason: "duplicate" };
    return { deliver: true, role, room, replyTo };
  }

  /** Who an author is to this channel: a declared owner, the bound CEO, or nobody. The author decides, never the text. */
  #roleOf(pubkey: string): ChannelSenderRole | null {
    return this.#o.ownerPubkeys.includes(pubkey) ? "owner" : this.#o.ceoPubkeys().includes(pubkey) ? "ceo" : null;
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
    const parent = this.#events.get(input.eventId);
    if (parent === undefined || parent.author === "") return { ok: false, reason: "that event was not received on this channel" };
    if (parent.room !== input.room) return { ok: false, reason: "that event was written in another room" };
    const recipient = parent.author;
    if (recipient === this.pubkey) return { ok: false, reason: "that event is this CTO's own" };
    if (this.#socket === null || !this.#subscribed) return { ok: false, reason: "the relay connection is not up" };
    // The relay holds a thread under its real root, and a reply to a reply must name it. A root read from the event's own
    // markers is that root; one read back from a saved state may be a guess, so the relay is asked what the event says.
    let root = parent.root;
    if (!parent.exactRoot) {
      const shown = await this.#askRelayForParent(input.eventId, input.room);
      if (shown !== null) {
        root = threadRootOf(shown);
        this.#events.set(input.eventId, { ...parent, root, exactRoot: true });
      }
    }
    const socket = this.#socket;
    if (socket === null || !this.#subscribed) return { ok: false, reason: "the relay connection is not up" };
    // NIP-10: a direct answer to the thread's root names it once, as the reply; anything deeper names the root and the parent.
    const thread = root === input.eventId ? [["e", input.eventId, "", "reply"]] : [["e", root, "", "root"], ["e", input.eventId, "", "reply"]];
    const event = finalizeEvent(
      {
        kind: BUZZ_MENTION_KIND,
        created_at: this.#sched.nowSeconds(),
        tags: [["h", input.room], ...thread, ["p", recipient], [REPLY_KIND_TAG, input.kind]],
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
      // Its own words, so a refusal can be told from a timeout and acted on, not guessed at.
      const said = ack.status === "REFUSED" ? relayReason(ack.message) : "";
      if (said !== "") this.#o.onDiagnostic?.(`the relay refused a reply: ${said}`);
      return { ok: false, reason: `the relay did not accept the reply (${ack.status})${said === "" ? "" : `: ${said}`}` };
    }
    this.#events.set(event.id, { at: event.created_at, author: this.pubkey, room: input.room, root, exactRoot: true, delivered: false });
    this.#touchThread(root, input.room, Math.min(event.created_at, this.#sched.nowSeconds()));
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
    this.#activeSince = null;
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
    for (const subId of [...this.#lookups.keys()]) this.#lookupDone(subId);
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
        if (typeof frame[1] === "string" && this.#lookups.has(frame[1])) return this.#lookupHeard(frame[1], frame[2]);
        return await this.#event(frame);
      case "EOSE":
        if (frame[1] === this.#subId) this.#attempt = 0;
        if (typeof frame[1] === "string" && frame[1] === this.#probeId) this.#probeAnswered();
        if (typeof frame[1] === "string") this.#lookupDone(frame[1]);
        return;
      case "CLOSED":
        if (frame[1] === this.#probeId) return this.#probeAnswered();
        if (typeof frame[1] === "string" && this.#lookups.has(frame[1])) return this.#lookupDone(frame[1]);
        if (frame[1] === this.#subId) this.#lost();
        return;
      default:
        return;
    }
  }

  /**
   * Asks the relay for one event by id, in its room, and answers with it, or `null` when the relay does not show it, shows
   * something else, or does not answer in time. Only the event asked for, whole and validly signed, is believed.
   */
  #askRelayForParent(eventId: string, room: string): Promise<RelayEvent | null> {
    const socket = this.#socket;
    if (socket === null) return Promise.resolve(null);
    const subId = `${this.#subId}-at-${++this.#lookupSeq}`;
    return new Promise<RelayEvent | null>((settle) => {
      const timer = this.#sched.setTimeout(() => this.#lookupDone(subId), PARENT_LOOKUP_TIMEOUT_MS);
      this.#lookups.set(subId, { generation: this.#generation, eventId, room, heard: null, settle, timer });
      socket.send(JSON.stringify(["REQ", subId, { ids: [eventId], "#h": [room], limit: 1 }]));
    });
  }

  #lookupHeard(subId: string, raw: unknown): void {
    const lookup = this.#lookups.get(subId);
    if (lookup === undefined || lookup.generation !== this.#generation) return;
    const event = plainEventOf(raw);
    if (event === null || event.id !== lookup.eventId || !validateEvent(event) || !verifyEvent(event)) return;
    const rooms = tagValues(event, "h");
    if (rooms.length !== 1 || rooms[0] !== lookup.room) return;
    lookup.heard = event;
  }

  /** The relay has said all it will (end of stored events, a refusal), or the wait is over: hand over what was heard. */
  #lookupDone(subId: string): void {
    const lookup = this.#lookups.get(subId);
    if (lookup === undefined) return;
    this.#lookups.delete(subId);
    this.#sched.clearTimeout(lookup.timer);
    if (lookup.generation === this.#generation) {
      try {
        this.#socket?.send(JSON.stringify(["CLOSE", subId]));
      } catch {
        /* the connection is going away; the question went with it */
      }
    }
    lookup.settle(lookup.heard);
  }

  async #ok(frame: readonly unknown[], generation: number): Promise<void> {
    if (frame.length !== 4 || typeof frame[1] !== "string" || typeof frame[2] !== "boolean" || typeof frame[3] !== "string") {
      return this.#lost();
    }
    const id = frame[1];
    if (id === this.#authId) {
      if (frame[2] !== true) return this.#lost();
      this.#subscribed = true;
      // The queue first, oldest first, then the relay: what the relay replays after this is a repeat of what was shown.
      await this.#deliverBacklog();
      if (generation !== this.#generation || this.#socket === null) return;
      const filters = this.#filters();
      this.#activeSince = (filters[0] as { since: number }).since;
      this.#socket?.send(JSON.stringify(["REQ", this.#subId, ...filters]));
      this.#armKeepalive();
      return;
    }
    const pending = this.#pending.get(id);
    if (pending === undefined || pending.generation !== generation) return;
    this.#pending.delete(id);
    this.#sched.clearTimeout(pending.timer);
    const message = frame[3];
    pending.settle(
      message.startsWith("duplicate:") ? { status: "DUPLICATE" } : frame[2] ? { status: "ACCEPTED" } : { status: "REFUSED", message },
    );
  }

  async #event(frame: readonly unknown[]): Promise<void> {
    if (frame.length !== 3 || typeof frame[1] !== "string") return this.#lost();
    if (!this.#subscribed || frame[1] !== this.#subId) return;
    this.#armKeepalive();
    const event = plainEventOf(frame[2]);
    if (event === null || !validateEvent(event) || !verifyEvent(event)) return;
    const verdict = this.classify(event);
    if (verdict.deliver && !(await this.#emit(event, verdict, true))) return;
    // A handled event, delivered or not, is behind the cursor; one whose notification failed is not.
    const claimed = Math.min(event.created_at, this.#sched.nowSeconds());
    this.#cursor = Math.max(this.#cursor ?? 0, claimed);
    this.#persist();
  }

  /**
   * Hands one delivered-to-this-CTO event to the session and remembers it: its notification, the one receipt that moves
   * the daemon's queue, and its place in a thread. `false` means the session did not take it; the event is then not marked
   * shown, and when it came from the relay its place in line is kept so a resume asks for it again.
   */
  async #emit(
    event: RelayEvent,
    verdict: { readonly role: ChannelSenderRole; readonly room: string; readonly replyTo: string },
    fromRelay: boolean,
  ): Promise<boolean> {
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
      this.#o.onDiagnostic?.("channel notification was not written to the session");
      if (fromRelay) {
        // Not marked seen, and the resume point stays at or before it however many later events are delivered.
        this.#retry.set(event.id, claimed);
        this.#persist();
      }
      return false;
    }
    this.#retry.delete(event.id);
    // The thread's root as the relay holds it, read from the event's own markers and from nothing the channel happens to
    // know: an event the relay reads as top-level is the root of its own thread, whoever it names.
    this.#events.set(event.id, {
      at: event.created_at,
      author: event.pubkey,
      room: verdict.room,
      root: threadRootOf(event),
      exactRoot: true,
      delivered: true,
    });
    this.#touchThread(this.#events.get(event.id)!.root, verdict.room, claimed);
    this.#delivered += 1;
    this.#o.onReceipt?.({
      type: "emitted",
      eventId: event.id,
      room: verdict.room,
      senderPubkey: event.pubkey,
      emittedAt: this.#sched.nowSeconds(),
    });
    return true;
  }

  /** The queue's pending messages for this role, once per process. See `BuzzChannelOptions.backlog`. */
  async #deliverBacklog(): Promise<void> {
    if (this.#backlogDone || this.#o.backlog === undefined) return;
    this.#backlogDone = true;
    let queued: readonly QueuedBuzzMessage[];
    try {
      queued = this.#o.backlog();
    } catch {
      this.#o.onDiagnostic?.("the daemon's queue could not be read; its messages stay pending");
      return;
    }
    for (const item of queued) {
      if (this.#events.get(item.eventId)?.delivered === true) continue;
      const event = plainEventOf(item.event);
      // The queue names the event; the event must be that one, validly signed, and one this channel would hear.
      if (event === null || event.id !== item.eventId || !validateEvent(event) || !verifyEvent(event)) continue;
      if (event.kind !== BUZZ_MENTION_KIND || event.pubkey === this.pubkey) continue;
      const rooms = tagValues(event, "h");
      const room = rooms.length === 1 ? rooms[0]! : "";
      if (room === "" || !this.#o.rooms.includes(room)) continue;
      const role = this.#roleOf(event.pubkey);
      if (role === null) continue;
      await this.#emit(event, { role, room, replyTo: replyToOf(event) }, false);
    }
    this.#persist();
  }

  /**
   * A follow-up in a thread, or a reply posted in it, is the thread being active: the root and every event before
   * the follow-up in that thread, in that room, are retained from now on as if written then. Retention is by last
   * activity, never by when an event was created, so a thread that is still going does not lose its root.
   */
  #touchThread(root: string, room: string, at: number): void {
    for (const entry of this.#events.values()) {
      if (entry.root === root && entry.room === room && entry.at < at) entry.at = at;
    }
  }

  /**
   * Forgets what nothing can ask for and nothing needs, by time. An id is kept while the open subscription
   * can still return it (anything written at or after its `since`), while a resume could ask for it (from
   * the resume point, less the overlap), and while it is inside the retention a parent is answerable for.
   */
  #prune(): void {
    const resume = this.#resumeFrom();
    const horizon = this.#sched.nowSeconds() - ANSWERABLE_RETENTION_SECONDS;
    const keepFrom = Math.min(
      this.#activeSince ?? Number.POSITIVE_INFINITY,
      resume === null ? Number.POSITIVE_INFINITY : Math.max(0, resume - RESUME_OVERLAP_SECONDS),
      horizon,
    );
    for (const [id, entry] of this.#events) if (entry.at < keepFrom) this.#events.delete(id);
  }

  #persist(): void {
    const resume = this.#resumeFrom();
    if (resume === null) return;
    this.#prune();
    this.#o.store?.save({
      cursor: this.#cursor ?? resume,
      failed: [...this.#retry.entries()],
      events: [...this.#events.entries()].map(([id, e]) => [id, e.at, e.author, e.room, e.root, e.delivered] as const),
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

interface ParentLookup {
  readonly generation: number;
  readonly eventId: string;
  readonly room: string;
  heard: RelayEvent | null;
  readonly settle: (event: RelayEvent | null) => void;
  readonly timer: unknown;
}

interface KnownEvent {
  /** When it was last written or last built on: the time retention counts from, so an active thread stays. */
  at: number;
  readonly author: string;
  readonly room: string;
  readonly root: string;
  /**
   * Whether `root` was read from the event's own thread markers (or built on a root that was): the root the relay holds
   * the thread under. An entry read back from a saved state is not: an earlier version took an event whose parent it
   * had not received for its own thread's root, so such a root is asked of the relay before a reply is built on it.
   */
  readonly exactRoot: boolean;
  readonly delivered: boolean;
}

type ReplyAckResult =
  | { status: "ACCEPTED" | "DUPLICATE" | "TIMEOUT" | "UNAVAILABLE" }
  | { status: "REFUSED"; message: string };
