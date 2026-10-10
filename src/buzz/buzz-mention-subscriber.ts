import { randomUUID, timingSafeEqual } from "node:crypto";
import { closeSync, constants as fsConstants, fstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";

import { decode } from "nostr-tools/nip19";
import { makeAuthEvent } from "nostr-tools/nip42";
import { finalizeEvent, getPublicKey, validateEvent, verifyEvent } from "nostr-tools/pure";

import {
  type OwnerReplyPublication,
  type OwnerReplySignedEvent,
  redeemOwnerReplyPublication,
} from "../conversation/owner-reply-outbox.ts";
import type { BuzzPeerBinding } from "../ingress/buzz-message.ts";

/**
 * The daemon's own front door on the relay (#760, Part C).
 *
 * Everything downstream of this file already exists: a role-addressed envelope is admitted by
 * `BuzzMessageIngress`, enqueued as one non-retargetable `OWNER_MESSAGE` pointing at the single
 * durable copy in `inbound_messages.payload_json`, and taken by the role's holder over its own
 * authenticated connection. What did not exist was anything inside the daemon that *listens*: the
 * messages arrived because a person ran a CLI, which is what `#627` measured.
 *
 * So this module is deliberately only a front door. It owns the socket, NIP-42, the frame grammar
 * and the signature check, and it owns **no** durable state at all — no cursor file, no seen-set,
 * no dedup. Replay refusal already has exactly one authority (`IngressGuard.admit` over the
 * `(channel, nonce)` slot), and a second one here would be a second answer to the same question:
 * the two would disagree the first time a database was restored, or a process restarted, or a
 * relay resent stored history, and the disagreement would be silent in both directions — a message
 * dropped because this file thought it had seen it, or admitted twice because it had not.
 *
 * The high-water mark below is therefore a *volatile* optimisation and nothing else. Losing it
 * costs a redelivery the admission seam refuses; it can never cost a message.
 */

/** The one file this subscriber reads, directly beneath the daemon's own state directory. */
export const BUZZ_SUBSCRIBER_CONFIG_FILENAME = "buzz-nostr-subscriber.json";

/** Buzz carries a chat message as a NIP-C7 `kind 9`. Nothing else is subscribed to. */
export const BUZZ_MENTION_KIND = 9;

/**
 * What a mention-sourced envelope declares as its recipient class.
 *
 * Not `"CEO"`, and that is the whole of it: `BuzzMessageIngress` reads `"CEO"` as "the owner's own
 * conversation, no `p` tag consulted", and every event this subscriber sees arrived because its
 * `p` tag named a role's channel identity. Declaring the recipient class as anything else routes
 * the envelope through the address resolver, which is where the `p` tag becomes a role key.
 */
export const BUZZ_MENTION_ADDRESSED_TO = "ROLE";

/**
 * The largest relay frame this subscriber will even parse.
 *
 * A bound before `JSON.parse` rather than after: a relay is an untrusted peer over a socket the
 * daemon opened, and "parse it and then see how big it was" hands that peer the allocation.
 */
export const MAX_RELAY_FRAME_BYTES = 256 * 1024;

/**
 * One reconnect timer, backing off and capping.
 *
 * It caps rather than growing, because the failure this schedule is for is a relay that is down
 * and will come back, and a subscriber that has backed off to an hour is one an operator has to
 * remember to restart.
 */
export const RELAY_RECONNECT_BACKOFF_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];

/**
 * How many consecutive `role-not-held` rejections for one identity stop being a race.
 *
 * The rejection itself is benign once and catastrophic when it persists, and the two are the same
 * code path — so the only thing that tells them apart is how many times in a row it ran. A single
 * one is the registry settling between a preflight and an event, which is ordinary operation and
 * is deliberately silent; a run of them is a binding that is simply gone, and the loop below will
 * then repeat every thirty seconds for as long as the daemon is up, saying nothing. That ran for
 * 23 hours once (#811) while an operator relayed every message by hand.
 *
 * Five, because a race cannot reach it. Each rejection is an *independent* re-read of the
 * registry, taken on its own connection, and the registry answers from one committed SQLite
 * transaction — so five of them is not one glance repeated but five settled answers. They are also
 * spread across four reconnect cycles: the socket is dropped before `EOSE` can reset `#attempt`,
 * so the schedule grows, and the fifth rejection is about fifteen seconds after the first (1+2+4+8)
 * — four seconds even at the backoff floor. No binding handoff spans either.
 *
 * It is not smaller because the report must never be the ordinary case: an operator who is told
 * about every race learns to skip the line, and the one that matters is the same line.
 */
export const ROLE_NOT_HELD_REPORT_AFTER = 5;

/**
 * How many events refused as preceding their role's binding one identity remembers.
 *
 * A remembered event is not submitted to the seam again when the inclusive window hands it back,
 * so the seam is asked about it once rather than once per reconnect; and its id and reason stay
 * readable in health. Bounded because a first subscription can be handed a room's whole history:
 * the oldest record goes first, and an evicted event that comes back is asked about once more.
 */
export const PRECEDES_BINDING_RECORD_LIMIT = 64;

/** How an identity's secret key is written in its file. Declared, never sniffed. */
export type BuzzSubscriberKeyEncoding = "hex" | "nsec";

/** One channel identity this daemon subscribes as. */
export interface BuzzSubscriberIdentityConfig {
  /** An absolute, already-normalized path. Opened `O_NOFOLLOW`; never logged. */
  readonly privateKeyFile: string;
  readonly encoding: BuzzSubscriberKeyEncoding;
  /**
   * The rooms this identity's `REQ` is scoped to (`#h`, one entry per Buzz room). Required, not
   * optional: every kind-9 mention is channel-scoped on the relay, and a `REQ` with no `#h`
   * registers as a *global*-scope subscription there — which live fan-out never delivers a
   * channel-scoped event to. An identity with an empty or absent room list would connect,
   * authenticate, reach EOSE and then never wake for anything published afterward, which is
   * indistinguishable from a healthy subscriber until the first live mention is lost. Fail-closed
   * on this field for the same reason every other field here is exact rather than defaulted.
   */
  readonly rooms: readonly string[];
}

/** The whole of what `buzz-nostr-subscriber.json` may say. */
export interface BuzzSubscriberConfig {
  readonly relayUrl: string;
  readonly identities: readonly BuzzSubscriberIdentityConfig[];
}

/** Exactly the keys the file may carry, at each of its two levels. */
const CONFIG_FIELDS: readonly string[] = ["relayUrl", "identities"];
const IDENTITY_FIELDS: readonly string[] = ["privateKeyFile", "encoding", "rooms"];
const KEY_ENCODINGS: readonly string[] = ["hex", "nsec"];
/** The relay refuses a `REQ` naming more explicit channels than this; checked at load rather than
 * left for the relay to refuse at connect time, so a misconfiguration is an operator-legible
 * startup error instead of a subscription the relay silently never opens. */
const MAX_REQ_ROOMS = 128;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Unknown fields fail closed.
 *
 * Ignoring one is how a `relayURL` beside a `relayUrl`, or a `privatekeyFile` beside a
 * `privateKeyFile`, becomes a subscriber running on a default nobody wrote down. There is no
 * default to fall back to here — that is the point of the config authority — so the only safe
 * reading of a key this file does not recognise is that the operator meant something this build
 * cannot do.
 */
const requireExactFields = (value: Record<string, unknown>, allowed: readonly string[], what: string): void => {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new Error(`${what} carries unknown field(s): ${unknown.sort().join(", ")}`);
  }
  const missing = allowed.filter((key) => !(key in value));
  if (missing.length > 0) {
    throw new Error(`${what} is missing required field(s): ${missing.sort().join(", ")}`);
  }
};

/**
 * The relay address, and the four things it may not be.
 *
 * `wss` only — a `ws` relay would carry the owner's words and this daemon's NIP-42 assertion in
 * clear text on the way to it. No userinfo and no fragment, because both are places a credential
 * gets written by someone who has one and no other field to put it in, and this file is read by a
 * daemon that logs its own configuration errors.
 */
const requireRelayUrl = (value: unknown): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("relayUrl must be a non-empty string");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("relayUrl must be an absolute URL");
  }
  if (url.protocol !== "wss:") throw new Error("relayUrl must use the wss scheme");
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error("relayUrl must carry no credentials");
  }
  if (url.hash.length > 0) throw new Error("relayUrl must carry no fragment");
  return value;
};

/**
 * A key path this daemon will open, stated in full by whoever configured it.
 *
 * Normalized *and* absolute, checked as a string rather than repaired: `resolve()`-ing a relative
 * path here would make the key that gets opened depend on the daemon's working directory, and a
 * path carrying `..` would let a directory this file did check stand in for one it did not.
 */
const requirePrivateKeyFile = (value: unknown, what: string): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${what}.privateKeyFile must be a non-empty string`);
  }
  if (!isAbsolute(value) || normalize(value) !== value) {
    throw new Error(`${what}.privateKeyFile must be an absolute normalized path`);
  }
  return value;
};

/**
 * The rooms one identity's `REQ` is scoped to. Required and non-empty, not repaired: a blank or
 * whitespace-padded room is checked as a string exactly as it was written, the same way
 * `privateKeyFile` is, rather than trimmed into something the operator did not type. Duplicates are
 * refused because a `REQ` naming the same channel twice reports zero true information at the
 * relay and hides an operator error, and the count is capped at what this relay accepts per `REQ`
 * so a misconfiguration is a startup error here rather than a subscription the relay silently
 * never opens.
 */
const requireRooms = (value: unknown, what: string): readonly string[] => {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${what}.rooms must be a non-empty array`);
  }
  if (value.length > MAX_REQ_ROOMS) {
    throw new Error(`${what}.rooms carries ${value.length} room(s), more than the relay accepts per REQ (${MAX_REQ_ROOMS})`);
  }
  const rooms = value.map((room, roomIndex) => {
    if (typeof room !== "string" || room.length === 0) {
      throw new Error(`${what}.rooms[${roomIndex}] must be a non-empty string`);
    }
    if (room.trim() !== room) {
      throw new Error(`${what}.rooms[${roomIndex}] must carry no leading or trailing whitespace`);
    }
    return room;
  });
  const distinct = new Set(rooms);
  if (distinct.size !== rooms.length) {
    throw new Error(`${what}.rooms carries a duplicate room`);
  }
  return rooms;
};

/** Parses the config text, or throws. There is no partial acceptance and no repair. */
export const parseBuzzSubscriberConfig = (text: string): BuzzSubscriberConfig => {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${BUZZ_SUBSCRIBER_CONFIG_FILENAME} is not JSON`);
  }
  if (!isPlainObject(value)) throw new Error(`${BUZZ_SUBSCRIBER_CONFIG_FILENAME} must be a JSON object`);
  requireExactFields(value, CONFIG_FIELDS, BUZZ_SUBSCRIBER_CONFIG_FILENAME);

  const relayUrl = requireRelayUrl(value["relayUrl"]);
  const declared = value["identities"];
  if (!Array.isArray(declared) || declared.length === 0) {
    throw new Error("identities must be a non-empty array");
  }
  const identities = declared.map((entry, index): BuzzSubscriberIdentityConfig => {
    const what = `identities[${index}]`;
    if (!isPlainObject(entry)) throw new Error(`${what} must be a JSON object`);
    requireExactFields(entry, IDENTITY_FIELDS, what);
    const encoding = entry["encoding"];
    if (typeof encoding !== "string" || !KEY_ENCODINGS.includes(encoding)) {
      throw new Error(`${what}.encoding must be one of: ${KEY_ENCODINGS.join(", ")}`);
    }
    return {
      privateKeyFile: requirePrivateKeyFile(entry["privateKeyFile"], what),
      encoding: encoding as BuzzSubscriberKeyEncoding,
      rooms: requireRooms(entry["rooms"], what),
    };
  });
  return { relayUrl, identities };
};

/**
 * The config as it sits beside the daemon's other state, or `null` for "this daemon does not
 * subscribe".
 *
 * Absent is the only silent outcome. A file that exists and cannot be read, or reads and does not
 * parse, throws — an operator who wrote the file meant the subscriber to run, and starting anyway
 * with zero sockets and no error is how a deployment comes to believe it is listening.
 */
export const readBuzzSubscriberConfig = (stateDir: string): BuzzSubscriberConfig | null => {
  const path = join(stateDir, BUZZ_SUBSCRIBER_CONFIG_FILENAME);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`${BUZZ_SUBSCRIBER_CONFIG_FILENAME} could not be read`);
  }
  return parseBuzzSubscriberConfig(text);
};

/** One identity's key material, and the file identity that proves two entries are two files. */
export interface BuzzSubscriberKeyMaterial {
  readonly secretKey: Uint8Array;
  readonly pubkey: string;
  /** `dev:ino`, so two paths naming one file through a hard link are one identity. */
  readonly fileIdentity: string;
}

const decodeSecretKey = (raw: string, encoding: BuzzSubscriberKeyEncoding, what: string): Uint8Array => {
  const text = raw.trim();
  if (encoding === "hex") {
    if (!/^[0-9a-f]{64}$/u.test(text)) {
      throw new Error(`${what} declares hex encoding and its key file is not 32 hex-encoded bytes`);
    }
    return Uint8Array.from(Buffer.from(text, "hex"));
  }
  let decoded: ReturnType<typeof decode>;
  try {
    decoded = decode(text);
  } catch {
    throw new Error(`${what} declares nsec encoding and its key file is not a decodable bech32 string`);
  }
  if (decoded.type !== "nsec") {
    throw new Error(`${what} declares nsec encoding and its key file decodes to something else`);
  }
  return decoded.data;
};

/**
 * Opens one key file and derives its pubkey.
 *
 * `O_NOFOLLOW` and then `fstat` on the descriptor that was actually opened, rather than `lstat`
 * on the path and `open` after it: between those two calls the path can become something else,
 * and the check would have been of a file this process never read.
 *
 * Nothing here — not a thrown message, not a field of one — carries the path or any byte of the
 * key. `what` is the identity's ordinal, which is enough to say which entry is wrong and says
 * nothing about where a key lives to whoever reads the daemon's stderr.
 */
export const loadBuzzSubscriberKey = (
  identity: BuzzSubscriberIdentityConfig,
  what: string,
): BuzzSubscriberKeyMaterial => {
  let fd: number;
  try {
    fd = openSync(identity.privateKeyFile, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    throw new Error(`${what} key file could not be opened without following a symlink`);
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`${what} key file is not a regular file`);
    if ((stat.mode & 0o077) !== 0) throw new Error(`${what} key file is readable beyond its owner`);
    const uid = process.getuid?.();
    if (uid !== undefined && stat.uid !== uid) {
      throw new Error(`${what} key file is owned by another uid`);
    }
    const secretKey = decodeSecretKey(readFileSync(fd, "utf8"), identity.encoding, what);
    return {
      secretKey,
      pubkey: getPublicKey(secretKey),
      fileIdentity: `${stat.dev}:${stat.ino}`,
    };
  } finally {
    closeSync(fd);
  }
};

/** The live PRIMARY_CTO binding one channel identity holds, as the daemon's registries hold it. */
export interface BuzzMentionRoleBinding {
  readonly roleKey: string;
  /** `sessions.buzz_actor_id` as stored, so this module can compare it rather than trust a lookup. */
  readonly buzzActorId: string;
  /**
   * The binding's generation and the session serving it, when the registry reports them. The
   * subscriber pins what it was admitted under, re-reads both immediately before every delivery,
   * and hands the sink the pair it read, so a sink can refuse a binding that moved after that read.
   */
  readonly bindingGeneration?: number;
  readonly sessionId?: string;
  /** The project the role belongs to, when reported. The role key must name exactly this project. */
  readonly projectId?: string;
  /**
   * The room the bound session answers in (`sessions.buzz_address`), as stored. Required: it must
   * be a usable room and one of the rooms this identity subscribes in. A CTO routed to a room its
   * own identity does not listen in would be admitted and never hear a mention, and a session with
   * no recorded room cannot be shown to answer where its mentions arrive, so `null` excludes.
   */
  readonly room: string | null;
}

/**
 * One identity's admission, as the registry judges it.
 *
 * `EXCLUDED` carries a fixed reason code, never a value read from a request, so it can be written to
 * health and to the daemon's log as it is.
 */
export type BuzzMentionIdentityJudgement =
  | { readonly verdict: "ADMITTED"; readonly binding: BuzzMentionRoleBinding }
  | { readonly verdict: "EXCLUDED"; readonly reason: string };

/**
 * Why a configured identity is not delivering, when this module rather than the registry decided
 * it. A registry that judges (`judgeIdentity`) supplies its own codes; these are the subscriber's.
 */
export const BuzzMentionExclusion = {
  /** The registry answered `null`: no live PRIMARY_CTO binding carries this identity. */
  NO_LIVE_PRIMARY_CTO_BINDING: "NO_LIVE_PRIMARY_CTO_BINDING",
  /** The registry threw, or answered in a shape this module cannot read. */
  BINDING_UNVERIFIABLE: "BINDING_UNVERIFIABLE",
  /** The binding's stored channel identity is not the one this identity's key derives. */
  ACTOR_MISMATCH: "ACTOR_MISMATCH",
  /** The binding names a project its role key does not. */
  PROJECT_MISMATCH: "PROJECT_MISMATCH",
  /** The bound session answers in a room this identity does not subscribe in. */
  ROOM_NOT_SUBSCRIBED: "ROOM_NOT_SUBSCRIBED",
  /** The bound session has no usable recorded room: absent, empty, or not exactly as written. */
  ROOM_MISSING: "ROOM_MISSING",
  /** Another configured identity already holds this role. */
  ROLE_HELD_BY_ANOTHER_IDENTITY: "ROLE_HELD_BY_ANOTHER_IDENTITY",
  /** A live connection found its pinned role no longer held, or held as a different role. */
  ROLE_NOT_HELD: "ROLE_NOT_HELD",
  /** The subscriber was closed; nothing is delivering. */
  SUBSCRIBER_CLOSED: "SUBSCRIBER_CLOSED",
} as const;

/**
 * The registry question this subscriber asks, supplied rather than reached for.
 *
 * Same contract as `BuzzMentionRouter`'s, and for the same reason: routing and addressing
 * questions belong to the daemon's registries, and a transport module that acquired database
 * authority to answer one would be two authorities for the same fact.
 *
 * The implementation must answer only for a **live** (`READY`/`DRAINING`) session holding exactly
 * one `PRIMARY_CTO` role under a current binding, and `null` for everything else.
 */
export interface BuzzMentionRegistry {
  primaryCtoBindingFor(pubkey: string): BuzzMentionRoleBinding | null;
  /**
   * The same question with its answer's reason, and without diagnostics of its own: the subscriber
   * asks it at startup, on every re-judgement and before every delivery, and records the reason in
   * health. Absent, `primaryCtoBindingFor` is asked and a `null` is `NO_LIVE_PRIMARY_CTO_BINDING`.
   */
  judgeIdentity?(pubkey: string): BuzzMentionIdentityJudgement;
  /**
   * The CEO binding and this role's binding as they stand right now — read when a frame *arrives*,
   * before it waits behind another frame's admission (#1044). Reads only. Absent, or answering
   * null, gives the frame no receipt, and the seam refuses a peer envelope that has none.
   */
  peerReceiptFor?(roleKey: string): BuzzPeerBinding | null;
}

/**
 * A string comparison whose duration says nothing about how far the two matched.
 *
 * The value compared is a public key, so this is not defence of a secret. It is defence of the
 * *binding*: the answer decides whether this daemon speaks for a role, and an attacker who can
 * make the relay echo candidate pubkeys back should not be able to walk one out of the timing.
 */
const constantTimeEquals = (a: string, b: string): boolean => {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
};

/**
 * One verified relay event, exactly as its signature covers it.
 *
 * Deep-frozen before anything downstream sees it. A sink that could rewrite `content` after
 * `verifyEvent` returned would be handing the admission seam words no signature was ever checked
 * against, and the seam has no way to notice — it is given a payload, not an event.
 */
export interface BuzzMentionEvent {
  readonly id: string;
  readonly pubkey: string;
  readonly created_at: number;
  readonly kind: number;
  readonly tags: readonly (readonly string[])[];
  readonly content: string;
  readonly sig: string;
}

/**
 * What the admission seam did with one envelope, in the only five answers this subscriber can act
 * on differently.
 *
 * Only the two **durable** answers are cursor-trusted, and the split between `REFUSED` and the
 * rest is a security boundary rather than a taxonomy.
 *
 * The relay's `p` filter authorizes nobody: anyone who can sign a kind-9 event can address one to
 * this subscriber's pubkey. Such an event is refused by the seam — it is not from a declared owner
 * — but a refusal that was allowed to advance the cursor would let that stranger choose the
 * window. One event dated in the far future, refused, and the next `REQ` asks for everything
 * `since` the year 2100: every real message the owner has sent is outside it. The refusal would
 * have become a denial of delivery, mounted by someone with no authority at all.
 *
 * So a refusal is a statement about **one event** and never about where the window should be. It
 * is still deterministic — asking again produces the same refusal — which is why it does not
 * reconnect either; it simply costs nothing and changes nothing.
 *
 * `PRECEDES_BINDING` is the one refusal that is cursor-trusted: the event was signed before the
 * addressed role's current binding generation was created, so it was never this binding's, and
 * the window it moves to is earlier than anything this binding can be handed. Without the advance,
 * a subscriber whose window was never set — a new identity, a new room — would ask for the room's
 * whole history again on every reconnect.
 */
export type BuzzMentionAdmission =
  | "DURABLE"
  | "ALREADY_DURABLE"
  | "REFUSED"
  | "RETRY"
  | "PRECEDES_BINDING";

/** One verified event, addressed, on its way to the admission seam. */
export interface BuzzMentionAdmissionRequest {
  /** The role the `p`-tagged identity holds right now, re-checked immediately before this call. */
  readonly roleKey: string;
  /** The channel identity the event's `p` tag named: this daemon's own subscribed pubkey. */
  readonly identityPubkey: string;
  /** The Buzz room the event arrived on — its single `h` tag. */
  readonly conversation: string;
  readonly event: BuzzMentionEvent;
  /**
   * The CEO generation and receiving CTO session current **when this frame arrived** (#1044), or
   * null. Taken before the frame was queued, so a frame that waited across a rotation carries the
   * generation it arrived under rather than the one it was processed under.
   */
  readonly receipt: BuzzPeerBinding | null;
  /**
   * The binding generation and serving session the registry answered **immediately before this
   * call**, when it reports them. The subscriber has already refused a binding that was not held; a
   * sink that re-reads the binding when it writes can refuse one that moved since, so a binding that
   * moved between the two reads gets no admission. Absent on an envelope built outside the
   * subscriber.
   */
  readonly binding?: BuzzMentionDeliveryBinding;
}

/** What a delivery was judged against: the pinned binding's generation and serving session. */
export interface BuzzMentionDeliveryBinding {
  readonly bindingGeneration: number | null;
  readonly sessionId: string | null;
}

/** Where a verified event goes. The daemon's composition is the only production implementation. */
export interface BuzzMentionSink {
  admit(request: BuzzMentionAdmissionRequest): Promise<BuzzMentionAdmission | BuzzMentionVerdict>;
}

/**
 * An admission answer that also says which refusal it was (#1038).
 *
 * A bare `REFUSED` is still accepted, and counts under the bare bucket. The daemon's sink answers
 * with this so health can tell "a non-owner wrote" from "the CEO wrote on the wrong channel" — 710
 * of 721 live refusals were one reason, and the count alone could not say which.
 */
export interface BuzzMentionVerdict {
  readonly admission: BuzzMentionAdmission;
  /** The seam's reason code. Read only when `admission` is `REFUSED`. */
  readonly reasonCode?: string;
}

/** A reason code is a fixed catalogue string; anything else stays out of the health key space. */
const REASON_CODE_SHAPE = /^[A-Z][A-Z0-9_]{0,63}$/;

const excluded = (reason: string): BuzzMentionIdentityJudgement => ({ verdict: "EXCLUDED", reason });

/**
 * One identity's admission: the registry's answer, and then this module's own checks on it.
 *
 * Each identity is judged alone. A paused, revoked or unverifiable identity is excluded with its
 * reason and nothing else is: the other identities' admission does not read this answer.
 *
 * The checks after the registry's answer are the ones this module can make without database
 * authority: the stored channel identity is the one this key derives, the role key names the
 * project the binding reports, and the room the bound session answers in is one this identity
 * subscribes in. Whether the assignment is ACTIVE and the session live is the registry's answer;
 * neither alone is enough, and the registry is the one place that reads both.
 */
const judgeIdentity = (
  registry: BuzzMentionRegistry,
  pubkey: string,
  rooms: readonly string[],
): BuzzMentionIdentityJudgement => {
  let answer: BuzzMentionIdentityJudgement | null | undefined;
  try {
    if (registry.judgeIdentity) {
      answer = registry.judgeIdentity(pubkey);
    } else {
      const bound = registry.primaryCtoBindingFor(pubkey);
      answer = bound ? { verdict: "ADMITTED", binding: bound } : excluded(BuzzMentionExclusion.NO_LIVE_PRIMARY_CTO_BINDING);
    }
  } catch {
    return excluded(BuzzMentionExclusion.BINDING_UNVERIFIABLE);
  }
  // A registry is supplied, not trusted to be well-formed: an answer this module cannot read is an
  // identity it cannot verify, and that is an exclusion rather than a throw that takes the others.
  if (typeof answer !== "object" || answer === null) return excluded(BuzzMentionExclusion.BINDING_UNVERIFIABLE);
  if (answer.verdict === "EXCLUDED") {
    return excluded(
      typeof answer.reason === "string" && REASON_CODE_SHAPE.test(answer.reason)
        ? answer.reason
        : BuzzMentionExclusion.BINDING_UNVERIFIABLE,
    );
  }
  const binding = answer.verdict === "ADMITTED" ? answer.binding : null;
  if (!isPlainObject(binding) || typeof binding.roleKey !== "string" || typeof binding.buzzActorId !== "string") {
    return excluded(BuzzMentionExclusion.BINDING_UNVERIFIABLE);
  }
  return checkedBinding(binding, pubkey, rooms);
};

/** This module's own checks on a binding the registry answered with. */
const checkedBinding = (
  binding: BuzzMentionRoleBinding,
  pubkey: string,
  rooms: readonly string[],
): BuzzMentionIdentityJudgement => {
  if (!constantTimeEquals(binding.buzzActorId, pubkey)) return excluded(BuzzMentionExclusion.ACTOR_MISMATCH);
  if (binding.projectId !== undefined && binding.roleKey !== `PRIMARY_CTO:${binding.projectId}`) {
    return excluded(BuzzMentionExclusion.PROJECT_MISMATCH);
  }
  // A room that cannot be read is not a room that matches: absence excludes rather than passes.
  if (typeof binding.room !== "string" || binding.room.length === 0 || binding.room.trim() !== binding.room) {
    return excluded(BuzzMentionExclusion.ROOM_MISSING);
  }
  if (!rooms.includes(binding.room)) return excluded(BuzzMentionExclusion.ROOM_NOT_SUBSCRIBED);
  return { verdict: "ADMITTED", binding: Object.freeze({ ...binding }) };
};

/** Whether two answers name one binding: the same role, generation and serving session. */
const sameBinding = (a: BuzzMentionRoleBinding, b: BuzzMentionRoleBinding): boolean =>
  a.roleKey === b.roleKey && a.bindingGeneration === b.bindingGeneration && a.sessionId === b.sessionId;

/** The half of a socket this module drives. */
export interface BuzzRelaySocket {
  send(frame: string): void;
  close(): void;
}

/** The half of a socket this module is driven by. */
export interface BuzzRelaySocketHandlers {
  onOpen(): void;
  /** One text frame. A binary frame is not a Nostr message and must arrive as `onClose`. */
  onFrame(raw: string): void;
  onClose(): void;
}

export type BuzzRelaySocketFactory = (
  url: string,
  handlers: BuzzRelaySocketHandlers,
) => BuzzRelaySocket;

/** One identity's `role-not-held` run, at the moment it stopped being explicable as a race. */
export interface BuzzMentionRoleNotHeldReport {
  /** The channel identity this subscriber speaks as. Public material: it is the `p` tag on the wire. */
  readonly identityPubkey: string;
  /** The role this subscriber was started for and is still trying to hold. */
  readonly roleKey: string;
  /** How many consecutive rejections produced this report. Equal to `ROLE_NOT_HELD_REPORT_AFTER`. */
  readonly consecutive: number;
}

/**
 * Where a persistent `role-not-held` condition is reported.
 *
 * Injected like every other collaborator here, so a test asserts on a value rather than on a file
 * descriptor, and defaulted so a caller cannot obtain the silence this seam exists to end.
 *
 * This is not a rejection reason and does not widen `BuzzMentionRejection`'s rule that none of
 * them is ever spoken: nothing is told this but the operator's own log, it names no event and no
 * check, and the two fields it carries are a public key and a role key — neither derived from a
 * key file's secret half.
 */
export type BuzzMentionRoleNotHeldReporter = (report: BuzzMentionRoleNotHeldReport) => void;

/**
 * One identity leaving or rejoining the admitted set, as judgement decided it.
 *
 * Reported on a change only: an identity excluded for the same reason at every re-judgement is
 * reported once, and an identity admitted at startup is not reported at all.
 */
export interface BuzzMentionAdmissionChange {
  /** The identity's ordinal in the config, `identities[<n>]`. Never its key path. */
  readonly identity: string;
  /** The channel identity. Public material: it is the `p` tag on the wire. */
  readonly identityPubkey: string;
  readonly state: "EXCLUDED" | "ADMITTED";
  /** The exclusion's reason code; `null` for an admission. */
  readonly reason: string | null;
  /** The role an admission pinned; `null` for an exclusion. */
  readonly roleKey: string | null;
}

export type BuzzMentionAdmissionReporter = (change: BuzzMentionAdmissionChange) => void;

/** One configured identity's admission, as health shows it. */
export interface BuzzMentionIdentityAdmission {
  readonly identity: string;
  readonly identityPubkey: string;
  readonly state: "ADMITTED" | "EXCLUDED";
  /** Why it is not delivering; `null` while admitted. */
  readonly reason: string | null;
  /** The role it is pinned to, or `null` if it has never been admitted. */
  readonly roleKey: string | null;
  readonly bindingGeneration: number | null;
  /** Local wall-clock seconds at which the current exclusion began; `null` while admitted. */
  readonly excludedSinceSeconds: number | null;
  /** Events this identity was handed and the seam refused as preceding the role's binding, newest last. */
  readonly notDelivered: readonly BuzzMentionNotDelivered[];
}

/**
 * One event the seam refused because it was signed before the addressed role's binding generation
 * was created — typically a mention sent while its CTO was excluded, handed back after a re-claim.
 *
 * It was not delivered and is not processed: the seam wrote nothing for it, and nothing here
 * promotes it into work for the binding that refused it. The record keeps only the event id and
 * the refusal, never the words; the relay keeps the room's history.
 */
export interface BuzzMentionNotDelivered {
  readonly eventId: string;
  readonly roleKey: string;
  /** The binding generation the refusal was made against. A later one is created later, so it refuses too. */
  readonly bindingGeneration: number | null;
  readonly conversation: string;
  /** The event's own signed `created_at`. */
  readonly signedAtSeconds: number;
  readonly outcome: "NOT_DELIVERED";
  readonly reason: "PRECEDES_BINDING";
  /** How many times the seam was asked about it: one while the record is held. */
  readonly seamRefusals: number;
  /** How many later redeliveries were recognised and not submitted again. */
  readonly redeliveriesNotResubmitted: number;
  readonly firstRefusedAtSeconds: number;
}

/**
 * Whether the configured identities are all delivering, and which are not and why.
 *
 * `continuity` is the one word an operator should read before any count: `PARTIAL` means at least
 * one configured identity is excluded, however many sockets are open. `socketCount` and
 * `configuredIdentities` count configuration, and neither says the subscriber is whole.
 */
export interface BuzzMentionAdmissionSnapshot {
  readonly continuity: "FULL" | "PARTIAL" | "NONE";
  readonly configuredIdentities: number;
  readonly admittedIdentities: number;
  readonly identities: readonly BuzzMentionIdentityAdmission[];
}

/**
 * The timer seam. Injected so the reconnect schedule is a thing a test can *step*, rather than a
 * thing a test has to outlast: a table that proved the 30s cap by sleeping 61 seconds would be a
 * table nobody runs.
 */
export interface BuzzSubscriberScheduler {
  setTimer(ms: number, fire: () => void): number;
  clearTimer(handle: number): void;
  /**
   * Local wall-clock seconds, in the unit a Nostr `created_at` is in.
   *
   * On the scheduler rather than beside it, because it is the same kind of thing — the module's
   * one source of time — and a second, un-injected one is how `Date.now()` gets into a test's
   * expectations without anyone deciding that it should.
   */
  nowSeconds(): number;
}

/** One listener as this adapter registers it, named so it can be taken off again. */
type RelaySocketListener = (event: { data?: unknown }) => void;

/** The minimum of `WebSocket` this module uses, so nothing here depends on a DOM lib. */
interface MinimalWebSocket {
  send(data: string): void;
  close(): void;
  addEventListener(type: string, listener: RelaySocketListener): void;
  /**
   * Optional only so a runtime without it cannot crash the daemon at construction. Node 22's
   * `WebSocket` is an `EventTarget` and has it; the retirement flag below is what makes a
   * listener inert whether or not this call is available.
   */
  removeEventListener?(type: string, listener: RelaySocketListener): void;
}
type MinimalWebSocketConstructor = new (url: string) => MinimalWebSocket;

/**
 * Node 22's own `globalThis.WebSocket`, and no library.
 *
 * `nostr-tools` ships `Relay`/`SimplePool`, which would bring their own socket, their own
 * reconnect policy and their own subscription bookkeeping — three behaviours this daemon has
 * opinions about and would then be unable to state. What is imported from that package is only
 * the pure functions: the signature scheme, and nothing that opens anything.
 *
 * **Every path out of this connection goes through `retire`, and `retire` runs once.**
 *
 * The first version of this adapter answered a binary frame and an `error` by calling
 * `handlers.onClose()` and nothing else. That tells the subscriber the connection is over — it
 * drops its reference and schedules a reconnect — while the underlying socket is still open with
 * four anonymous listeners on it, unremovable because nothing kept a reference to them. The
 * replacement then coexists with an abandoned peer that is still being delivered to, and a late
 * frame from the dead connection reaches shared state through a wrapper nobody is holding.
 *
 * So the three things that end a connection — a binary frame, an error, a remote close — and the
 * one that ends it deliberately all converge here, and the guard makes the convergence safe:
 * listeners come off, the socket is closed exactly once, and the subscriber is told at most once.
 * An explicit `close()` from the wrapper is the one caller that does **not** want the notification:
 * it is already the subscriber's own doing, and notifying would schedule a reconnect for a
 * connection the subscriber deliberately ended.
 */
export const nativeRelaySocketFactory: BuzzRelaySocketFactory = (url, handlers) => {
  const ctor = (globalThis as { WebSocket?: MinimalWebSocketConstructor }).WebSocket;
  if (typeof ctor !== "function") {
    throw new Error("this runtime has no global WebSocket; the buzz subscriber requires Node 22 or newer");
  }
  const socket = new ctor(url);
  let retired = false;

  // Named, and captured in one list, because "remove every listener" has to be a thing this
  // function can actually do. An anonymous listener is registered and then unreachable for ever.
  const onOpen: RelaySocketListener = () => {
    if (retired) return;
    handlers.onOpen();
  };
  const onMessage: RelaySocketListener = (event) => {
    if (retired) return;
    if (typeof event.data === "string") {
      handlers.onFrame(event.data);
      return;
    }
    // A binary frame is not a Nostr message and this connection is not one this daemon can read.
    retire(true);
  };
  const onRemoteClose: RelaySocketListener = () => retire(true);
  const onError: RelaySocketListener = () => retire(true);

  const listeners: readonly (readonly [string, RelaySocketListener])[] = [
    ["open", onOpen],
    ["message", onMessage],
    ["close", onRemoteClose],
    ["error", onError],
  ];

  function retire(notify: boolean): void {
    if (retired) return;
    retired = true;
    for (const [type, listener] of listeners) socket.removeEventListener?.(type, listener);
    try {
      socket.close();
    } catch {
      /* a socket already closing by the runtime's own hand is retired either way */
    }
    if (notify) handlers.onClose();
  }

  for (const [type, listener] of listeners) socket.addEventListener(type, listener);

  return {
    // A send after retirement is a send on a connection this adapter has closed. Dropping it is
    // the point: the caller holding this wrapper may be a stale one.
    send: (frame) => {
      if (retired) return;
      socket.send(frame);
    },
    close: () => retire(false),
  };
};

/**
 * `process.stderr`, which is what the daemon already reports an unbound role on.
 *
 * The same subject reaches an operator by the same route whether its identity was excluded by
 * judgement (`nativeAdmissionReporter`) or its binding went away under a live connection, and
 * launchd captures that stream for both. A queryable `daemon.status` field was the alternative
 * and is not this change: it would make the subscriber a second authority on its own health,
 * reachable only by someone who already suspected something, and the defect was that nobody did.
 */
const nativeRoleNotHeldReporter: BuzzMentionRoleNotHeldReporter = (report) => {
  process.stderr.write(
    `Buzz mention subscriber: ${report.identityPubkey} has not held ${report.roleKey} for ` +
      `${report.consecutive} consecutive relay events; mentions for that role are not being ` +
      "delivered. The subscriber keeps reconnecting; a fresh role claim is what ends this.\n",
  );
};

/**
 * `process.stderr`, beside the role-not-held report. The exclusion line keeps the words the
 * all-or-none refusal used for the same condition, so a search an operator already runs still
 * finds it, and adds what changed: the other identities are still subscribing.
 */
const nativeAdmissionReporter: BuzzMentionAdmissionReporter = (change) => {
  process.stderr.write(
    change.state === "EXCLUDED"
      ? `Buzz mention subscriber excluded ${change.identity} (${change.reason ?? "UNKNOWN"}): ` +
          `${change.identity} does not currently hold a live PRIMARY_CTO binding; continuing without Buzz ` +
          "mention subscriber delivery for that identity. The other configured identities keep subscribing, " +
          "and it is re-judged on the next role claim, revoke or session change.\n"
      : `Buzz mention subscriber admitted ${change.identity} for ${change.roleKey ?? "UNKNOWN"}; ` +
          "its mentions are delivered again from its preserved window.\n",
  );
};

/** `setTimeout` behind the seam. Unreferenced, so a subscriber never holds the process open. */
export const nativeSubscriberScheduler = (): BuzzSubscriberScheduler => {
  const live = new Map<number, NodeJS.Timeout>();
  let next = 1;
  return {
    setTimer: (ms, fire) => {
      const handle = next++;
      const timer = setTimeout(() => {
        live.delete(handle);
        fire();
      }, ms);
      timer.unref();
      live.set(handle, timer);
      return handle;
    },
    clearTimer: (handle) => {
      const timer = live.get(handle);
      if (timer) {
        clearTimeout(timer);
        live.delete(handle);
      }
    },
    nowSeconds: () => Math.floor(Date.now() / 1000),
  };
};

/** Recursively freezes the verified event so nothing downstream can rewrite what was checked. */
const deepFreeze = <T>(value: T): T => {
  if (typeof value !== "object" || value === null) return value;
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze((value as Record<string | symbol, unknown>)[key]);
  }
  return Object.freeze(value);
};

/**
 * The mutable working shape the signature is checked over.
 *
 * `verifyEvent` writes its own verification marker onto the object it is given, so the freeze has
 * to come after it — which is exactly the order the sink needs anyway: verified first, then
 * immutable, then handed on.
 */
interface RelayEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

/**
 * A fresh plain copy of exactly the seven fields a Nostr event has, or `null`.
 *
 * Fresh, because what arrives from `JSON.parse` is an object an untrusted peer chose the shape of:
 * an eighth field rides through `verifyEvent` untouched, and a `__proto__` key is a shape this
 * process should not be carrying around at all. Rebuilding it field by field means the object the
 * signature is checked over is the object the sink receives, with nothing else on it.
 */
const plainEventOf = (value: unknown): RelayEvent | null => {
  if (!isPlainObject(value)) return null;
  const { id, pubkey, created_at: createdAt, kind, tags, content, sig } = value;
  if (typeof id !== "string" || typeof pubkey !== "string" || typeof sig !== "string") return null;
  if (typeof content !== "string") return null;
  if (typeof createdAt !== "number" || !Number.isSafeInteger(createdAt)) return null;
  if (typeof kind !== "number" || !Number.isSafeInteger(kind)) return null;
  if (!Array.isArray(tags)) return null;
  const copiedTags: string[][] = [];
  for (const tag of tags) {
    if (!Array.isArray(tag)) return null;
    if (!tag.every((member): member is string => typeof member === "string")) return null;
    copiedTags.push([...tag]);
  }
  return { id, pubkey, created_at: createdAt, kind, tags: copiedTags, content, sig };
};

/** Every value of one tag name, in order. */
const tagValues = (event: RelayEvent, name: string): string[] =>
  event.tags.filter((tag) => tag[0] === name).map((tag) => tag[1] ?? "");

/**
 * Why one frame or one event was not acted on.
 *
 * Internal, and stays internal: nothing is told this. The relay is never answered with a reason —
 * a subscriber that reported which check refused an event would be telling an unauthenticated peer
 * how to build one that passes — and no reason reaches a log, because two of them are derived from
 * a key file's contents.
 */
type BuzzMentionRejection =
  /**
   * The sink answered `REFUSED`. Not a frame this subscriber found fault with — it verified,
   * addressed and resolved a role for it, and the admission seam turned it down. Counted as
   * `admission-refused:<reasonCode>` when the sink names the reason (`BuzzMentionVerdict`).
   */
  | "admission-refused"
  /**
   * The sink answered `RETRY`: the addressed role is between holders, nothing was spent, and the
   * event will be asked for again. In production this is `ROLE_PEER_ABSENT` — the role's peer is
   * down and *no* message is reaching a session — so it is the reading an operator most needs
   * separated from a delivery, and from "the relay went quiet", which is what `framesHandled`
   * answers.
   */
  | "admission-retry-pending"
  /**
   * Handling the frame threw rather than answering it. Behaviourally the `RETRY` shape — nothing
   * was established, the cursor stays, the socket goes — but a different cause, and the one an
   * operator has to tell apart. Counted separately from `admission-retry-pending` so "the role's
   * peer is down" and "handling is failing" are not one number.
   *
   * **This bucket is now read, and the sentence that used to be here was stale.** It said a
   * handler throwing on every event "leaves the subscriber looking *silent*, which is what
   * `BUZZ_MENTION_SUBSCRIBER_SILENT` fires on". That stopped being true the moment #870 counted
   * the frame: `framesHandled > 0` suppresses the silent finding, so the state had no finding at
   * all until `BUZZ_MENTION_SUBSCRIBER_HANDLING_FAILING` (`src/daemon/daemon.ts`) was given this
   * count to read. A comment describing the diagnosis a bucket produces goes stale when the
   * diagnosis moves, and this one outlived its own repair by two merges.
   *
   * **Named for what the catch can establish, which is not the sink.** It was `seam-threw` until a
   * merge-gate review named three other throws the same catch collects: `finalizeEvent` in
   * `#onAuthChallenge`, `this.#socket?.send(frame)`, and the live
   * `registry.primaryCtoBindingFor(...)` read inside `#onEvent`. The sink is the dominant source
   * and the one this reason was added for, but a registry or transport failure filed as a *seam*
   * failure sends the operator to the wrong side on evidence about something else — the same
   * misdirection this reason exists to repair, one bucket over.
   *
   * Narrowing the guarded region to the `sink.admit` call would have made the old name true, and
   * was not taken: a throw there deliberately drops the socket, and returning a rejection from
   * `#onEvent` instead would leave the connection up. That is a behaviour change, not a naming
   * one.
   */
  | "frame-handler-threw"
  /**
   * The sink answered `ALREADY_DURABLE`: a durable copy of this event exists already. It has its
   * own reason because `since` is inclusive, so every reconnect re-requests the boundary event and
   * the seam answers this — counting it as an admission made the number climb with reconnect count
   * instead of with delivery count.
   *
   * **Not uniformly benign, and the name understates it.** `SUBSCRIBER_ALREADY_DURABLE_CODES`
   * (src/daemon/agentcpd.ts) folds in `INGRESS_TURN_OUTCOME_UNKNOWN` — a turn that was claimed and
   * whose outcome nobody recorded — beside the ordinary replay. So a count here means "a durable
   * copy exists", not "this was answered": one of its causes is precisely the state the reason
   * codes exist to keep separate from a replay. Measured by a merge-gate review; splitting the
   * bucket needs the seam to pass its code through, which this surface does not receive.
   */
  | "admission-already-durable"
  /**
   * The sink answered `PRECEDES_BINDING`: the event was signed before the addressed role's binding
   * generation was created. The one count for that refusal — nothing writes an audit row per event,
   * because a first subscription can be handed a room's whole history.
   */
  | "admission-precedes-binding"
  /**
   * An event the seam already refused as preceding the binding, handed back by the inclusive window
   * on a reconnect and recognised from its record: not submitted again. Counted apart from
   * `admission-precedes-binding`, which counts the seam's own refusals, so the two say how often
   * the seam was asked and how often it was spared.
   */
  | "precedes-binding-not-resubmitted"
  | "frame-too-large"
  | "frame-not-json"
  | "frame-not-a-message"
  | "auth-refused"
  | "unknown-subscription"
  | "event-malformed"
  | "event-signature-invalid"
  | "event-wrong-kind"
  | "event-not-addressed"
  | "event-conversation-unusable"
  /**
   * The event's single room is not the room the bound session answers in, as the registry stores
   * it (`sessions.buzz_address`). Checked here rather than trusted to the relay's `#h` filter, the
   * same way the `p` tag is: a relay that widened the filter would otherwise hand this identity a
   * mention from a room its CTO does not answer in. Deterministic, so it neither reconnects nor
   * moves the window, and nothing is consumed on anyone's behalf.
   */
  | "event-room-not-bound"
  | "role-not-held";

/** A rejection as the tally keys it: one of the fixed reasons, or a refusal with its reason code. */
type BuzzMentionRejectionKey = BuzzMentionRejection | `admission-refused:${string}`;

/**
 * Which bucket a `REFUSED` answer is counted in (#1038). A verdict naming a catalogue-shaped
 * reason code gets its own; a bare answer, or a code of any other shape, keeps the bare bucket.
 */
const refusalKey = (answer: BuzzMentionAdmission | BuzzMentionVerdict): BuzzMentionRejectionKey => {
  const code = typeof answer === "string" ? undefined : answer.reasonCode;
  return code !== undefined && REASON_CODE_SHAPE.test(code)
    ? `admission-refused:${code}`
    : "admission-refused";
};

/**
 * What this subscriber has actually seen, as opposed to what it was configured to see.
 *
 * The only operator-visible signal for this path was `socketCount`, which is the number of
 * configured identities captured once at startup — not a connection, not a subscription, and
 * certainly not a frame. A subscriber that authenticates, reaches EOSE and never wakes again is
 * indistinguishable from a healthy one under that number, and this file's own comment says so
 * (`BuzzSubscriberIdentity.rooms`). #841.
 *
 * `framesHandled` is the fact that was missing: zero means nothing arrived, and that is a
 * different repair from "arrived and was refused". The rejection tally separates the second case
 * into its reasons, because "the relay stopped attaching `p` tags" and "this runtime is the CTO of
 * two projects" are different problems that a bare refusal count cannot tell apart.
 */
export interface BuzzMentionCounters {
  /** Frames that reached `#handleFrame`, whatever became of them. */
  readonly framesHandled: number;
  /**
   * Frames the seam made newly durable — `DURABLE`, and nothing else.
   *
   * Narrowed from "produced an admission attempt", which was true of all four answers and so
   * could not tell a delivery from a refusal. The other four each carry their own reason below,
   * because every one of them is a frame that arrived and did not newly reach a session, and they
   * call for different repairs: a refusal is about authority, a retry is about the role's peer
   * being down, an already-durable is about a reconnect asking for the boundary event again, and a
   * precedes-binding is history from before the role's binding generation.
   */
  readonly admitted: number;
  /**
   * One entry per reason a frame did not newly reach a session; absent reasons are absent, never
   * zero rows.
   *
   * Wider than "rejection": `admission-already-durable` is not a rejection, and it is here for the
   * accounting rather than as a complaint. The identity is
   *
   *     framesHandled = admitted
   *                   + Σrejections
   *                   + protocol frames that carry no verdict
   *                   + frames whose connection was replaced mid-answer
   *
   * The third term is the one an earlier version of this comment omitted, and a merge-gate review
   * measured the difference on a healthy run: `ACCEPTED` is returned for the AUTH challenge, the
   * NIP-42 `OK`, `EOSE` and `NOTICE`, so those frames are in `framesHandled` and in neither of the
   * other two. A reader subtracting without that term concludes the subscriber lost events. The
   * fourth term is the stale tail, deliberately unattributed; see the branch in `#admitEvent`.
   */
  readonly rejections: Readonly<Record<string, number>>;
  /**
   * Which configured identities are delivering, and why the others are not. On the handle's
   * counters only, because that is the object the daemon writes into `health.json`: receipt beside
   * admission, so "nothing arrived" is never read off an identity that was never admitted.
   */
  readonly admission?: BuzzMentionAdmissionSnapshot;
}

/** Accumulates one subscription's outcomes. Plain counters: no sampling, no decay, no reset. */
class FrameTally {
  #framesHandled = 0;
  #admitted = 0;
  readonly #rejections = new Map<BuzzMentionRejectionKey, number>();

  record(outcome: BuzzMentionFrameOutcome): void {
    this.#framesHandled += 1;
    // `DURABLE` and nothing else. Four of the five answers are not deliveries, and an earlier
    // version of this line excluded only `REFUSED` — which left `RETRY` reporting a delivery while
    // the role's peer was down, and `ALREADY_DURABLE` incrementing once per reconnect for one
    // message. A merge-gate review measured both. `health.json` is the one place an operator looks
    // to tell "nothing arrived" from "arrived and did not get through", so the number that names
    // deliveries counts deliveries.
    if (outcome.admission === "DURABLE") this.#admitted += 1;
    if (outcome.rejected !== null) {
      this.#rejections.set(outcome.rejected, (this.#rejections.get(outcome.rejected) ?? 0) + 1);
    }
  }

  snapshot(): BuzzMentionCounters {
    return {
      framesHandled: this.#framesHandled,
      admitted: this.#admitted,
      rejections: Object.fromEntries(this.#rejections),
    };
  }
}

/** What one identity's connection did with one frame. */
interface BuzzMentionFrameOutcome {
  readonly rejected: BuzzMentionRejectionKey | null;
  readonly admission: BuzzMentionAdmission | null;
}

const ACCEPTED: BuzzMentionFrameOutcome = { rejected: null, admission: null };
const rejected = (why: BuzzMentionRejection): BuzzMentionFrameOutcome => ({
  rejected: why,
  admission: null,
});

interface SubscriptionDeps {
  readonly relayUrl: string;
  readonly sink: BuzzMentionSink;
  readonly registry: BuzzMentionRegistry;
  readonly openSocket: BuzzRelaySocketFactory;
  readonly scheduler: BuzzSubscriberScheduler;
  readonly reportRoleNotHeld: BuzzMentionRoleNotHeldReporter;
  /** Told each time a connection authenticates, so a sender can retry what waited for it (#1036). */
  readonly authenticated: () => void;
  /** Re-judges one excluded identity against the registry and its siblings; the judgement timer's work. */
  readonly rejudge: (subscription: BuzzMentionSubscription) => void;
}

/** A publish waiting for the relay's `OK`, tied to the connection it was sent on. */
interface PendingPublish {
  readonly generation: number;
  readonly timer: number;
  readonly answer: Promise<BuzzPublishAck>;
  readonly settle: (ack: BuzzPublishAck) => void;
}

/**
 * One identity, one socket, one subscription.
 *
 * A socket per identity rather than one multiplexed socket, because NIP-42 authenticates a
 * *connection* as one pubkey. Two identities on one socket would mean the relay knows one of them
 * and the second is asserting a role over a connection that authenticated as someone else.
 */
class BuzzMentionSubscription {
  readonly #deps: SubscriptionDeps;
  /** `identities[<n>]`: how this identity is named in health and in the log. Never its key path. */
  readonly #ordinal: string;
  readonly #pubkey: string;
  readonly #secretKey: Uint8Array;
  readonly #rooms: readonly string[];
  readonly #subscriptionId = randomUUID().replace(/-/gu, "");

  /**
   * The binding this identity was last admitted under, or `null` if it never has been.
   *
   * Kept through an exclusion, so health can say which role an excluded identity last held, and
   * replaced only by a later admission. A connection opens only once this is set.
   */
  #binding: BuzzMentionRoleBinding | null = null;
  /** Why this identity is not delivering, and since when; `null` while it is. */
  #exclusion: { readonly reason: string; readonly sinceSeconds: number } | null = null;
  /**
   * Excluded by judgement, with no connection and the judgement timer in place of the reconnect
   * one. Distinct from `#stopped`: a suspended identity is re-judged and comes back, with `#since`
   * where it was, which is the whole of "preserve the cursor across a reconfiguration".
   */
  #suspended = false;
  /** The last exclusion reason the operator was told, so one reason is reported once. */
  #reportedReason: string | null = null;
  /**
   * Events the seam refused as preceding their role's binding, by event id, oldest first. Volatile
   * and bounded (`PRECEDES_BINDING_RECORD_LIMIT`). Not a replay authority: nothing admitted is ever
   * recorded here, and the seam stays the one place that decides what is durable.
   */
  readonly #notDelivered = new Map<string, { -readonly [K in keyof BuzzMentionNotDelivered]: BuzzMentionNotDelivered[K] }>();

  #socket: BuzzRelaySocket | null = null;
  /**
   * Which connection is current, and the fence a queued frame is checked against.
   *
   * `0` means there is no live connection. Every other value names exactly one, and a callback
   * captures the value it was created under.
   *
   * Retiring listeners cannot cover this on its own. A frame handed to `onFrame` is put on a
   * promise queue and runs later; by then its connection may have been retired and replaced, and
   * removing a listener does nothing about a callback that is already scheduled. Without the
   * fence such a frame would be parsed, admitted and — on a refusal — would reconnect *the
   * replacement*, all on behalf of a connection that no longer exists.
   */
  #generation = 0;
  #connections = 0;
  #authEventId: string | null = null;
  #subscribed = false;
  /** The volatile high-water mark. Inclusive: `since` is `>=` on the wire. */
  #since: number | null = null;
  #attempt = 0;
  /**
   * Consecutive `role-not-held` rejections, reset by the first one that holds.
   *
   * Per subscription, which is per identity: one socket asserts one pubkey, so this counts a run
   * for exactly the identity the report names and cannot be advanced by another one's trouble.
   */
  #roleNotHeldRun = 0;
  #timer: number | null = null;
  #stopped = false;
  /** Frames are handled one at a time; a second must not overtake the first's admission. */
  #queue: Promise<void> = Promise.resolve();
  readonly #tally = new FrameTally();
  /** Replies sent on this identity's connection and not yet answered, by event id (#1036). */
  readonly #publishes = new Map<string, PendingPublish>();

  constructor(
    deps: SubscriptionDeps,
    identity: { ordinal: string; pubkey: string; secretKey: Uint8Array; rooms: readonly string[] },
  ) {
    this.#deps = deps;
    this.#ordinal = identity.ordinal;
    this.#pubkey = identity.pubkey;
    this.#secretKey = identity.secretKey;
    this.#rooms = identity.rooms;
  }

  get ordinal(): string {
    return this.#ordinal;
  }

  /** The role this identity is pinned to, or `null` if it has never been admitted. */
  get roleKey(): string | null {
    return this.#binding?.roleKey ?? null;
  }

  /** Admitted and delivering: pinned, and neither excluded by judgement nor in a role-not-held run. */
  get admitted(): boolean {
    return this.#binding !== null && this.#exclusion === null && !this.#stopped;
  }

  admission(): BuzzMentionIdentityAdmission {
    const admitted = this.admitted;
    return {
      identity: this.#ordinal,
      identityPubkey: this.#pubkey,
      state: admitted ? "ADMITTED" : "EXCLUDED",
      reason: admitted ? null : (this.#exclusion?.reason ?? BuzzMentionExclusion.SUBSCRIBER_CLOSED),
      roleKey: this.#binding?.roleKey ?? null,
      bindingGeneration: this.#binding?.bindingGeneration ?? null,
      excludedSinceSeconds: this.#exclusion?.sinceSeconds ?? null,
      notDelivered: [...this.#notDelivered.values()].map((record) => ({ ...record })),
    };
  }

  /** Records the seam's precedes-binding refusal of one event, evicting the oldest past the limit. */
  #recordNotDelivered(event: RelayEvent, conversation: string, bound: BuzzMentionRoleBinding): void {
    const known = this.#notDelivered.get(event.id);
    if (known !== undefined && known.roleKey === bound.roleKey) {
      known.seamRefusals += 1;
      return;
    }
    this.#notDelivered.delete(event.id);
    this.#notDelivered.set(event.id, {
      eventId: event.id,
      roleKey: bound.roleKey,
      bindingGeneration: bound.bindingGeneration ?? null,
      conversation,
      signedAtSeconds: event.created_at,
      outcome: "NOT_DELIVERED",
      reason: "PRECEDES_BINDING",
      seamRefusals: 1,
      redeliveriesNotResubmitted: 0,
      firstRefusedAtSeconds: this.#deps.scheduler.nowSeconds(),
    });
    while (this.#notDelivered.size > PRECEDES_BINDING_RECORD_LIMIT) {
      const oldest = this.#notDelivered.keys().next().value;
      if (oldest === undefined) break;
      this.#notDelivered.delete(oldest);
    }
  }

  /**
   * Admits this identity under `binding`, and reconnects it if judgement had suspended it.
   *
   * Returns whether it was excluded before, which is when an admission is worth reporting. The
   * window (`#since`) is not touched: a suspended identity resumes asking from where it stopped,
   * and one never admitted before asks from the beginning, as a first subscription always has.
   */
  admit(binding: BuzzMentionRoleBinding): boolean {
    const wasReported = this.#reportedReason !== null;
    this.pin(binding);
    if (this.#suspended) {
      this.#suspended = false;
      this.#clearTimer();
      this.#attempt = 0;
    }
    // Opened only after this judgement, never on a timer's say-so alone: a reconnect asks the
    // registry first (`#onClose`), and lands here only when the answer admits.
    if (this.#socket === null && this.#timer === null) this.open();
    return wasReported;
  }

  /** Pins `binding` without opening anything: startup opens every admitted identity in one guarded pass. */
  pin(binding: BuzzMentionRoleBinding): void {
    this.#binding = binding;
    this.#exclusion = null;
    this.#reportedReason = null;
  }

  /**
   * Excludes this identity: its connection goes, nothing of its is asked for or consumed, and the
   * judgement timer asks the registry again on the reconnect schedule.
   *
   * Returns whether the reason is one the operator has not been told yet. `report: false` is the
   * delivery-time path: a single failed answer there may be a registry mid-settle, so it is told
   * only once the judgement timer finds the same exclusion again.
   */
  exclude(reason: string, report = true): boolean {
    this.#noteExclusion(reason);
    if (!this.#suspended) {
      this.#suspended = true;
      this.#clearTimer();
      this.#drop();
    }
    this.#scheduleJudgement();
    if (!report || this.#reportedReason === reason) return false;
    this.#reportedReason = reason;
    return true;
  }

  /** Records an exclusion, keeping the time the current one began. */
  #noteExclusion(reason: string): void {
    if (this.#exclusion?.reason === reason) return;
    this.#exclusion = {
      reason,
      sinceSeconds: this.#exclusion?.sinceSeconds ?? this.#deps.scheduler.nowSeconds(),
    };
  }

  #clearTimer(): void {
    if (this.#timer === null) return;
    this.#deps.scheduler.clearTimer(this.#timer);
    this.#timer = null;
  }

  /**
   * The judgement timer: an excluded identity is asked about again on the same capped schedule a
   * dropped connection is reconnected on, and with no socket open while it waits.
   *
   * The daemon also re-judges on every committed binding switch; this timer is what still notices
   * a change no switch announces, such as a session taking its channel identity after its binding.
   */
  #scheduleJudgement(): void {
    if (this.#stopped || this.#timer !== null) return;
    const step = Math.min(this.#attempt, RELAY_RECONNECT_BACKOFF_MS.length - 1);
    const delay = RELAY_RECONNECT_BACKOFF_MS[step] ?? 30_000;
    this.#attempt += 1;
    this.#timer = this.#deps.scheduler.setTimer(delay, () => {
      this.#timer = null;
      if (this.#stopped || !this.#suspended) return;
      this.#deps.rejudge(this);
    });
  }

  /** The judgement this identity would get right now, before any sibling is consulted. */
  judge(): BuzzMentionIdentityJudgement {
    return judgeIdentity(this.#deps.registry, this.#pubkey, this.#rooms);
  }

  /** The volatile high-water mark, for the rows that assert a redelivery window rather than a file. */
  get since(): number | null {
    return this.#since;
  }

  get subscriptionId(): string {
    return this.#subscriptionId;
  }

  get pubkey(): string {
    return this.#pubkey;
  }

  get rooms(): readonly string[] {
    return this.#rooms;
  }

  /** Authenticated and subscribed on a live connection: the state in which the relay takes an EVENT. */
  get ready(): boolean {
    return this.#isCurrent(this.#generation) && this.#subscribed;
  }

  /**
   * Signs the owner reply a publication describes, as this identity. The template is built here
   * from the publication; a plain copy is returned, never the key.
   */
  signOwnerReply(publication: OwnerReplyPublication): BuzzSignedEvent | null {
    if (publication.intent !== null || publication.signer !== this.#pubkey) return null;
    if (!this.#rooms.includes(publication.room)) return null;
    const signed = finalizeEvent(
      {
        kind: BUZZ_MENTION_KIND,
        created_at: publication.createdAt,
        tags: ownerReplyTags(publication),
        content: publication.content,
      },
      this.#secretKey,
    );
    return {
      id: signed.id,
      pubkey: signed.pubkey,
      created_at: signed.created_at,
      kind: signed.kind,
      tags: signed.tags.map((tag) => [...tag]),
      content: signed.content,
      sig: signed.sig,
    };
  }

  /**
   * Sends a publication's recorded event on this identity's live connection, once `#isOwnerReply`
   * holds for it against `recorded`, the turn's intent as storage held it when the publication was
   * spent, and waits for the relay's verdict on it. What goes out is the stored event.
   *
   * A second publish of an id still waiting shares the first one's answer rather than sending
   * again. A connection that is not authenticated sends nothing and answers `UNAVAILABLE`, and so
   * does one that ends before the relay answers. The relay may or may not hold the event then; the
   * caller resends the same event, and the relay keeps one copy of an id.
   *
   * The verdict is read on this connection's frame queue, behind any mention admission still
   * running, so a slow admission can turn a verdict into a `TIMEOUT`. The resend that follows is
   * the same event.
   */
  publishOwnerReply(
    publication: OwnerReplyPublication,
    recorded: OwnerReplySignedEvent | null,
    timeoutMs: number,
  ): Promise<BuzzPublishAck> {
    const event = publication.intent;
    if (event === null || recorded === null || !this.#isOwnerReply(publication, event, recorded)) {
      return Promise.resolve({ status: "UNAUTHORIZED" });
    }
    return this.#publish(recorded, timeoutMs);
  }

  /**
   * The publication's event is the intent storage holds for its turn now, id and bytes, and is this
   * identity's validly signed reply, to its room and anchor, with its text (R1056-01).
   */
  #isOwnerReply(publication: OwnerReplyPublication, event: BuzzSignedEvent, recorded: BuzzSignedEvent): boolean {
    if (event.id !== recorded.id || eventFrame(event) !== eventFrame(recorded)) return false;
    if (publication.signer !== this.#pubkey || event.pubkey !== this.#pubkey) return false;
    if (!this.#rooms.includes(publication.room)) return false;
    if (event.kind !== BUZZ_MENTION_KIND || event.content !== publication.content) return false;
    if (JSON.stringify(event.tags) !== JSON.stringify(ownerReplyTags(publication))) return false;
    // `verifyEvent` marks the object it checks, so it checks a copy.
    return verifyEvent({ ...event, tags: event.tags.map((tag) => [...tag]) });
  }

  #publish(event: BuzzSignedEvent, timeoutMs: number): Promise<BuzzPublishAck> {
    if (!this.ready) return Promise.resolve({ status: "UNAVAILABLE" });
    const waiting = this.#publishes.get(event.id);
    if (waiting !== undefined) return waiting.answer;
    const generation = this.#generation;
    let settle: (ack: BuzzPublishAck) => void = () => undefined;
    const answer = new Promise<BuzzPublishAck>((resolve) => {
      settle = resolve;
    });
    const timer = this.#deps.scheduler.setTimer(timeoutMs, () => {
      this.#settlePublish(event.id, { status: "TIMEOUT" });
    });
    this.#publishes.set(event.id, { generation, timer, answer, settle });
    try {
      this.#send(generation, JSON.stringify(["EVENT", event]));
    } catch {
      // A socket that refuses the write has not sent anything, and says so now rather than at the timeout.
      this.#settlePublish(event.id, { status: "UNAVAILABLE" });
    }
    return answer;
  }

  #settlePublish(id: string, ack: BuzzPublishAck): void {
    const waiting = this.#publishes.get(id);
    if (waiting === undefined) return;
    this.#publishes.delete(id);
    this.#deps.scheduler.clearTimer(waiting.timer);
    waiting.settle(ack);
  }

  /** A connection that ends takes its unanswered publishes with it. */
  #abandonPublishes(): void {
    for (const id of [...this.#publishes.keys()]) this.#settlePublish(id, { status: "UNAVAILABLE" });
  }

  open(): void {
    // An identity is never connected without a binding it was admitted under, and never while
    // judgement has it excluded: a connection asks the relay for its mail, and an excluded
    // identity's mail stays with the relay until it is admitted again.
    if (this.#stopped || this.#socket !== null || this.#suspended || this.#binding === null) return;
    this.#authEventId = null;
    this.#subscribed = false;
    // Claimed before the socket exists, so every callback the factory registers is already fenced
    // by the time it can fire.
    const generation = ++this.#connections;
    this.#generation = generation;
    this.#socket = this.#deps.openSocket(this.#deps.relayUrl, {
      onOpen: () => {
        /* NIP-42 first: nothing is requested until the relay has challenged and accepted us. */
      },
      onFrame: (raw) => {
        // Before the queue, and that is the point (#1044): the frame may wait behind another
        // frame's admission, and whatever the registry says when it reaches the front describes
        // processing, not arrival.
        const receipt = this.#peerReceipt();
        this.#queue = this.#queue.then(async () => {
          // Checked here, and then again everywhere below. Reaching the front of the queue is the
          // *first* moment "is this still the connection I arrived on" has a truthful answer; it
          // is not the last, because `#handleFrame` suspends on the sink.
          if (!this.#isCurrent(generation)) return;
          try {
            // The outcome was discarded here, which is why "connected and silent" and "receiving
            // and refusing" looked the same from outside (#841).
            //
            // `record` is the *outer* call, so it runs only if `#handleFrame` resolves. An earlier
            // version of this comment claimed the frame was "counted before anything can throw
            // past it"; a merge-gate review measured the opposite — a sink that threw left the
            // `EVENT` frame invisible to all three counters (`framesHandled: 2`). The catch counts
            // it now, which is why that claim is gone from here (#870).
            this.#tally.record(await this.#handleFrame(raw, generation, receipt));
          } catch {
            // A sink that threw established nothing about the message, so this is the `RETRY`
            // shape and is treated as one: the cursor stays where it is and the socket goes.
            // Letting it reject would take the queue's chain with it, and every later frame on
            // this connection would then be dropped silently.
            //
            // Conditional on the generation, and that is the whole of the second defect: a
            // rejection arriving after this connection was replaced used to reach an
            // unconditional `#reconnect()` and drop *the replacement's* socket.
            //
            // Recorded before the reconnect, and unconditionally: the frame arrived whatever the
            // generation says about where its answer belongs, and `framesHandled === 0` is the
            // evidence `BUZZ_MENTION_SUBSCRIBER_SILENT` fires on. A handler throwing on every
            // event would otherwise present as a quiet relay.
            //
            // Unconditional is the documented exception to the stale-tail policy stated at
            // `#onEvent` and carried in `BuzzMentionCounters`: a stale answer normally lands in
            // `framesHandled` alone, unattributed, because the answer belongs to a connection that
            // no longer exists. A *throw* is different — it is evidence about this runtime's
            // handler rather than about where the answer belongs, and suppressing it when the
            // socket happened to be replaced mid-flight would hide exactly the persistent failure
            // this reason was added to surface.
            this.#tally.record({ rejected: "frame-handler-threw", admission: null });
            this.#reconnect(generation);
          }
        });
      },
      onClose: () => {
        if (generation !== this.#generation) return;
        this.#onClose();
      },
    });
  }

  close(): void {
    this.#stopped = true;
    if (this.#timer !== null) {
      this.#deps.scheduler.clearTimer(this.#timer);
      this.#timer = null;
    }
    this.#drop();
  }

  /** Settles once every frame delivered so far has been handled. Tests await this; nothing else. */
  async settled(): Promise<void> {
    await this.#queue;
  }

  #drop(): void {
    const socket = this.#socket;
    this.#socket = null;
    // No live connection from here until `open` claims the next generation. Anything still on the
    // queue from the one just dropped now fails the fence.
    this.#generation = 0;
    this.#subscribed = false;
    this.#authEventId = null;
    this.#abandonPublishes();
    // The adapter's own retire path: listeners off, socket closed once, and deliberately no
    // notification back — this drop *is* the subscriber's decision, and being told about it would
    // schedule a reconnect for a connection the subscriber itself just ended.
    if (socket) socket.close();
  }

  /**
   * A dropped socket is reconnected on **one** timer.
   *
   * One, because the failure mode of "a timer per event that went wrong" is a relay that flapped
   * once and is then reconnected to forty times a second by a daemon that thinks it is being
   * patient.
   */
  #onClose(): void {
    this.#socket = null;
    this.#generation = 0;
    this.#subscribed = false;
    this.#authEventId = null;
    this.#abandonPublishes();
    if (this.#stopped || this.#timer !== null) return;
    const step = Math.min(this.#attempt, RELAY_RECONNECT_BACKOFF_MS.length - 1);
    const delay = RELAY_RECONNECT_BACKOFF_MS[step] ?? 30_000;
    this.#attempt += 1;
    this.#timer = this.#deps.scheduler.setTimer(delay, () => {
      this.#timer = null;
      // Judged before the reconnect asks the relay for anything: a binding that went away while
      // the connection was down suspends the identity here instead of requesting its mail again.
      this.#deps.rejudge(this);
    });
  }

  /**
   * Is `generation` still the connection this subscriber is running?
   *
   * The one question every suspended continuation has to ask again. A check that ran before an
   * `await` is not a check on what happens after it: the connection can be retired, its
   * replacement opened, and the tail of the old frame is still holding a reference to a
   * subscriber whose state has entirely moved on.
   */
  /**
   * The registry's receipt for this role, or null. A registry that throws gives no receipt rather
   * than taking the socket's frame handler with it: no receipt is a refusal at the seam, never an
   * admission (#1044).
   */
  #peerReceipt(): BuzzPeerBinding | null {
    const roleKey = this.#binding?.roleKey;
    if (roleKey === undefined) return null;
    try {
      return this.#deps.registry.peerReceiptFor?.(roleKey) ?? null;
    } catch {
      return null;
    }
  }

  #isCurrent(generation: number): boolean {
    return !this.#stopped && generation !== 0 && generation === this.#generation;
  }

  /** A write, refused unless the connection that asked for it is still the connection. */
  #send(generation: number, frame: string): void {
    if (!this.#isCurrent(generation)) return;
    this.#socket?.send(frame);
  }

  /**
   * Drops the socket without waiting for the relay to notice, and schedules the reconnect.
   *
   * Takes the generation it means to drop, and drops nothing otherwise. Reconnecting is the most
   * destructive thing a frame handler can do — it closes a live socket — so it is the last place
   * that should be willing to act on behalf of a connection that has already gone.
   */
  /**
   * The run, and the one report it produces.
   *
   * Reported at exactly the threshold rather than on every rejection past it. A condition that
   * repeats every thirty seconds would otherwise write two thousand identical lines a day, and a
   * line an operator scrolls past is the silence this change is for, spelled differently.
   */
  #noteRoleNotHeld(): void {
    this.#roleNotHeldRun += 1;
    if (this.#roleNotHeldRun !== ROLE_NOT_HELD_REPORT_AFTER) return;
    this.#deps.reportRoleNotHeld({
      identityPubkey: this.#pubkey,
      roleKey: this.#binding?.roleKey ?? "",
      consecutive: this.#roleNotHeldRun,
    });
  }

  #reconnect(generation: number): void {
    if (!this.#isCurrent(generation)) return;
    this.#drop();
    this.#onClose();
  }

  counters(): BuzzMentionCounters {
    return this.#tally.snapshot();
  }

  async #handleFrame(
    raw: string,
    generation: number,
    receipt: BuzzPeerBinding | null,
  ): Promise<BuzzMentionFrameOutcome> {
    if (Buffer.byteLength(raw, "utf8") > MAX_RELAY_FRAME_BYTES) {
      this.#reconnect(generation);
      return rejected("frame-too-large");
    }
    let frame: unknown;
    try {
      frame = JSON.parse(raw) as unknown;
    } catch {
      this.#reconnect(generation);
      return rejected("frame-not-json");
    }
    if (!Array.isArray(frame) || typeof frame[0] !== "string") {
      this.#reconnect(generation);
      return rejected("frame-not-a-message");
    }
    switch (frame[0]) {
      case "AUTH":
        return this.#onAuthChallenge(frame, generation);
      case "OK":
        return this.#onOk(frame, generation);
      case "EVENT":
        return await this.#onEvent(frame, generation, receipt);
      case "EOSE":
        return this.#onEose(frame, generation);
      case "CLOSED":
        return this.#onClosed(frame, generation);
      default:
        // `NOTICE` and anything else a relay chooses to say. Ignored rather than treated as a
        // protocol violation: a relay that adds a message type is not a relay this daemon should
        // stop reading, and nothing below acts on a frame it did not recognise.
        return ACCEPTED;
    }
  }

  #onAuthChallenge(frame: readonly unknown[], generation: number): BuzzMentionFrameOutcome {
    const challenge = frame[1];
    if (frame.length !== 2 || typeof challenge !== "string" || challenge.length === 0) {
      this.#reconnect(generation);
      return rejected("frame-not-a-message");
    }
    const signed = finalizeEvent(makeAuthEvent(this.#deps.relayUrl, challenge), this.#secretKey);
    // The auth state belongs to one connection, so it is written only while that connection is
    // the one running. A stale challenge that overwrote `#authEventId` would make the
    // replacement's own `OK` unrecognisable, and the subscription would never open.
    if (!this.#isCurrent(generation)) return rejected("unknown-subscription");
    this.#authEventId = signed.id;
    this.#send(generation, JSON.stringify(["AUTH", signed]));
    return ACCEPTED;
  }

  /**
   * The relay's verdict on our NIP-42 assertion, and the only thing that opens the subscription.
   *
   * A refusal reconnects rather than requesting anyway: an unauthenticated `REQ` on a relay that
   * demanded AUTH either returns nothing or returns a public subset, and the second is worse — the
   * subscriber would look healthy while missing exactly the messages the auth was for.
   */
  #onOk(frame: readonly unknown[], generation: number): BuzzMentionFrameOutcome {
    // NIP-20 exactly: `["OK", <id>, <accepted>, <message>]`. Checked whole, before element 2 is
    // read as a verdict — "it starts with OK so element 2 is the answer" is a guess, and the thing
    // being guessed at here is whether this connection is authenticated.
    if (
      frame.length !== 4 ||
      typeof frame[1] !== "string" ||
      typeof frame[2] !== "boolean" ||
      typeof frame[3] !== "string"
    ) {
      this.#reconnect(generation);
      return rejected("frame-not-a-message");
    }
    const id = frame[1];
    if (id !== this.#authEventId) {
      // #1036. The relay's verdict on a reply this connection sent, when it is one. A verdict that
      // arrives on a later connection than the send is not taken: that send was already answered
      // `UNAVAILABLE` when its connection ended.
      if (this.#publishes.get(id)?.generation === generation) {
        this.#settlePublish(id, publishAckOf(frame[2], frame[3]));
      }
      return ACCEPTED;
    }
    if (frame[2] !== true) {
      this.#reconnect(generation);
      return rejected("auth-refused");
    }
    // Subscription state, like auth state, is one connection's. A stale `OK` marking the
    // subscriber subscribed would let the *next* stale event past `#onEvent`'s own guard.
    if (!this.#isCurrent(generation)) return rejected("unknown-subscription");
    this.#subscribed = true;
    // `#h` is not an optimization: every kind-9 is channel-scoped on the relay, and a filter with
    // no channel constraint registers as a *global*-scope subscription there — one live fan-out
    // never delivers a channel-scoped event to. Without this, the historical branch below (EOSE,
    // `since`) still works, because backlog is a stored query rather than fan-out, and that is
    // exactly how this defect passed for as long as it did: everything but the one path #674 is
    // actually for.
    const filter: Record<string, unknown> = {
      kinds: [BUZZ_MENTION_KIND],
      "#p": [this.#pubkey],
      "#h": this.#rooms,
    };
    if (this.#since !== null) filter["since"] = this.#since;
    this.#send(generation, JSON.stringify(["REQ", this.#subscriptionId, filter]));
    this.#deps.authenticated();
    return ACCEPTED;
  }

  /**
   * End of stored events.
   *
   * Two things happen here and neither is durable. The high-water mark is floored at whatever has
   * been advanced so far, so a reconnect asks for the tail rather than the whole history; and the
   * backoff resets, because a connection that reached EOSE is a connection that worked.
   */
  #onEose(frame: readonly unknown[], generation: number): BuzzMentionFrameOutcome {
    if (frame.length !== 2 || typeof frame[1] !== "string") {
      this.#reconnect(generation);
      return rejected("frame-not-a-message");
    }
    if (frame[1] !== this.#subscriptionId) return rejected("unknown-subscription");
    // The attempt reset says "a connection reached the end of stored events and therefore
    // worked". A stale EOSE says that about a connection that is gone, and would hand the live
    // one a backoff schedule earned by a dead peer.
    if (!this.#isCurrent(generation)) return rejected("unknown-subscription");
    this.#attempt = 0;
    if (this.#since === null) this.#since = 0;
    return ACCEPTED;
  }

  /**
   * The relay ending one subscription.
   *
   * Reconnecting is reserved for a well-formed `CLOSED` naming **this** subscription, and that is
   * narrower than the other verbs on purpose. A reconnect closes a working socket, so it needs
   * positive evidence that this subscription is the one that ended — and a malformed frame carries
   * no such evidence: it does not say whose subscription it is, so it cannot be read as saying
   * ours. Attributing it to us anyway is how a relay's stray bytes become this daemon's reconnect
   * loop.
   */
  #onClosed(frame: readonly unknown[], generation: number): BuzzMentionFrameOutcome {
    if (frame.length !== 3 || typeof frame[1] !== "string" || typeof frame[2] !== "string") {
      return rejected("frame-not-a-message");
    }
    if (frame[1] !== this.#subscriptionId) return rejected("unknown-subscription");
    this.#reconnect(generation);
    return rejected("unknown-subscription");
  }

  async #onEvent(
    frame: readonly unknown[],
    generation: number,
    receipt: BuzzPeerBinding | null,
  ): Promise<BuzzMentionFrameOutcome> {
    // `["EVENT", <subscription id>, <event>]`, exactly. A frame carrying a surplus element is not
    // this grammar, and reading elements 1 and 2 out of it anyway would be answering a message
    // nobody in this protocol sent.
    if (frame.length !== 3 || typeof frame[1] !== "string") {
      this.#reconnect(generation);
      return rejected("frame-not-a-message");
    }
    // The subscription id next, before a byte of the event is looked at. A relay that answers a
    // subscription this connection never opened is answering someone else's question.
    if (!this.#subscribed || frame[1] !== this.#subscriptionId) return rejected("unknown-subscription");

    const event = plainEventOf(frame[2]);
    if (event === null) return rejected("event-malformed");
    // `validateEvent` is the structural check and `verifyEvent` is the cryptographic one: the id
    // must be the hash of the serialization, and the signature must be over that id. Both, on the
    // copy this module built, and before anything reads a field for meaning.
    if (!validateEvent(event)) return rejected("event-malformed");
    if (!verifyEvent(event)) return rejected("event-signature-invalid");
    if (event.kind !== BUZZ_MENTION_KIND) return rejected("event-wrong-kind");
    // Exactly one `p`, and it is this identity. The `p` filter is the relay's promise; this is the
    // daemon checking it, and a relay that widened the filter would otherwise hand this subscriber
    // someone else's mail to speak for.
    //
    // The cardinality is the half that matters most, for the same reason the `h` check below
    // enforces one room and harder. Two recipients means the daemon picks which of several
    // addressees it is and then speaks as that one — and everything downstream is built on the
    // answer: `mention` becomes the address the seam resolves to a role, so a multi-recipient
    // envelope admitted here is an owner's message delivered to a role it was not solely sent to.
    // A membership test would accept exactly that, including the degenerate case where the extra
    // tag is a duplicate of this identity.
    const recipients = tagValues(event, "p");
    if (recipients.length !== 1 || recipients[0] !== this.#pubkey) {
      return rejected("event-not-addressed");
    }
    // Exactly one `h`, non-empty. The `h` tag is the Buzz room, and the room is what the answer
    // goes back to: none means there is no thread to answer, and two means picking one — which is
    // answering in a room the sender did not write in.
    //
    // **Counted before anything is discarded.** Filtering the blanks out first and counting the
    // remainder answers a different question — "is there exactly one *usable* room" — and a signed
    // event carrying a real room beside a whitespace one reduces to exactly one under it. That is
    // the sender naming two rooms and this daemon quietly choosing, which is the thing the
    // paragraph above says it will not do. So: the raw cardinality decides, and the sole value is
    // then required to be usable rather than selected for being usable.
    const rooms = tagValues(event, "h");
    const conversation = rooms.length === 1 ? rooms[0] : undefined;
    if (conversation === undefined || conversation.trim().length === 0) {
      return rejected("event-conversation-unusable");
    }

    // Re-judged here, immediately before delivery, not only at startup. The role can move between
    // the preflight and this event — that is ordinary operation — and a subscriber that spoke for a
    // role it no longer holds would be admitting an owner's message against a stale binding. The
    // judgement is the whole admission rule (actor, project, room, live binding), not a subset.
    const pinned = this.#binding;
    const fresh = this.judge();
    if (fresh.verdict !== "ADMITTED" || pinned === null || fresh.binding.roleKey !== pinned.roleKey) {
      // Not delivered and not consumed: the window stays where it was, so the event is asked for
      // again once the identity is admitted. The identity is suspended through the same path
      // judgement uses (1080-N1-04): its socket goes, no connection or mail request follows while
      // it stays excluded, and the judgement timer re-verifies the binding before any reconnect.
      // Quiet here, because one failed answer may be a registry mid-settle; the timer reports the
      // exclusion if it finds it again, and a race the next judgement answers is never reported.
      this.#noteRoleNotHeld();
      if (this.#isCurrent(generation)) {
        this.exclude(fresh.verdict === "EXCLUDED" ? fresh.reason : BuzzMentionExclusion.ROLE_NOT_HELD, false);
      }
      return rejected("role-not-held");
    }
    // The run ends here and only here: the binding answered, so whatever it was, it was a race.
    this.#roleNotHeldRun = 0;
    this.#exclusion = null;
    // The same role under a later generation or another serving session is a re-claim or a session
    // change: the pin follows it, and this delivery names the binding just read, never the one the
    // connection was opened under. A sink that reads the registry again when it writes refuses a
    // binding that has moved since this line.
    if (!sameBinding(pinned, fresh.binding)) this.#binding = fresh.binding;
    const bound = fresh.binding;

    // Exactly the stored room, and one this identity subscribes in. The room tag's cardinality was
    // checked above (none and several are refused); this is its value, against the binding just
    // judged rather than against the relay's filter or the `p` tag.
    if (conversation !== bound.room || !this.#rooms.includes(conversation)) return rejected("event-room-not-bound");

    // An event the seam already refused as preceding this role's binding is not submitted again.
    // The refusal is permanent for the role — a later binding generation is created later, so it
    // refuses the same event — and asking on every reconnect is a retry with no end. Keyed by role:
    // an identity re-pinned to another role's binding has another floor, and that one is asked.
    const refusedBefore = this.#notDelivered.get(event.id);
    if (refusedBefore !== undefined && refusedBefore.roleKey === bound.roleKey) {
      refusedBefore.redeliveriesNotResubmitted += 1;
      return rejected("precedes-binding-not-resubmitted");
    }

    const frozen: BuzzMentionEvent = deepFreeze(event);
    const answer = await this.#deps.sink.admit({
      roleKey: bound.roleKey,
      identityPubkey: this.#pubkey,
      conversation,
      event: frozen,
      receipt,
      binding: { bindingGeneration: bound.bindingGeneration ?? null, sessionId: bound.sessionId ?? null },
    });
    const admission = typeof answer === "string" ? answer : answer.admission;
    // A fact about this event and this role, whichever connection asked: recorded before the
    // stale-tail check below, so a refusal answered after its connection went is still kept.
    if (admission === "PRECEDES_BINDING") this.#recordNotDelivered(event, conversation, bound);

    // **The suspension point.** Admission is the one genuinely slow thing this module does — it
    // reaches a database and a live peer — and it is therefore the window in which this
    // connection is most likely to have died and been replaced. Everything below acts on the
    // subscriber's shared state, so from here the continuation is entitled to nothing until it
    // has asked again.
    //
    // A stale tail is a complete no-op, whichever way the sink answered. Not because the answer
    // is uninteresting, but because neither thing it would do is meaningful any more: a `RETRY`
    // would close the *replacement's* socket to retry a request the replacement never made, and
    // an advance would move the live connection's request window on the strength of a dead
    // connection's answer. The message itself is not lost by either — the seam has it, or it does
    // not, and an unadvanced mark simply means the replacement asks for it again.
    // Unattributed on purpose. The answer belongs to a connection that no longer exists; filing it
    // under the live tally's reasons would credit or blame the replacement for something it never
    // asked, and the replacement will ask again.
    //
    // "Recorded in `framesHandled` and nowhere else" is how an earlier version of this comment put
    // it, and a merge-gate review caught the exception: the outcome carries `admission` through, so
    // a stale `DURABLE` still increments `admitted`. That is the one attribution a stale tail
    // makes, and it is the defensible one — the seam did make the event durable, whoever was
    // listening. Every other stale answer lands in `framesHandled` alone.
    if (!this.#isCurrent(generation)) return { rejected: null, admission };

    if (admission === "RETRY") {
      this.#reconnect(generation);
      return { rejected: "admission-retry-pending", admission };
    }
    // A refusal moves nothing. It is deterministic, so there is nothing to retry and no reason to
    // drop the connection — and it is reachable by anyone who can sign an event, so it must not be
    // allowed to choose where the window sits. See `BuzzMentionAdmission`.
    if (admission === "REFUSED") return { rejected: refusalKey(answer), admission };

    // The second guard, and it is independent of the first on purpose. Refusing to trust a
    // *refusal* covers the stranger; it does nothing about an event this daemon accepted as
    // durable whose `created_at` is nonetheless in the future — an owner with a skewed clock, or
    // an owner key in the wrong hands. Either way a timestamp is a claim made by whoever signed
    // it, and the window is this process's own business, so the claim is clamped to local now
    // before it is allowed to move anything.
    //
    // Clamping down never drops a message: `since` is inclusive, so a mark at or below an event's
    // own timestamp still asks for that event again, and the seam refuses the duplicate. Clamping
    // *up* is what the outer `Math.max` refuses — the mark only ever moves forward.
    const claimed = Math.min(event.created_at, this.#deps.scheduler.nowSeconds());
    this.#since = Math.max(this.#since ?? 0, claimed);
    // Every remaining answer advances the mark — a replay must not be re-requested forever, and an
    // event signed before the role's binding is refused again on every request — and only what they
    // are *called* differs. `DURABLE` is the delivery; `ALREADY_DURABLE` is the boundary event
    // arriving again because `since` is inclusive; `PRECEDES_BINDING` is history from before the
    // binding, whose refusal is terminal. It keeps the connection, like every deterministic answer.
    if (admission === "ALREADY_DURABLE") return { rejected: "admission-already-durable", admission };
    if (admission === "PRECEDES_BINDING") return { rejected: "admission-precedes-binding", admission };
    return { rejected: null, admission };
  }
}

/** A signed Nostr event, exactly as it goes on the wire. */
export interface BuzzSignedEvent {
  readonly id: string;
  readonly pubkey: string;
  readonly created_at: number;
  readonly kind: number;
  readonly tags: readonly (readonly string[])[];
  readonly content: string;
  readonly sig: string;
}

/**
 * What became of one publish.
 *
 * `ACCEPTED`, `DUPLICATE` and `REFUSED` are the relay's NIP-01 `OK` verdict reduced to a fixed
 * category. The relay's own text never leaves this module: the relay chooses it, so it may carry
 * anything at all (R1056-04). Keeping a truncated copy of it, or its prefix, was ruled out rather
 * than kept, because the relay chooses those too. `TIMEOUT` means no verdict came within the bound. `UNAVAILABLE`
 * means the signer had no authenticated connection, or lost it before the relay answered.
 * `UNAUTHORIZED` means the publication was not an issued one, or its event is not the stored
 * owner reply it claims to be.
 */
export type BuzzPublishAck =
  | { readonly status: "ACCEPTED" }
  | { readonly status: "DUPLICATE" }
  | { readonly status: "REFUSED"; readonly category: "REFUSED_RATE_LIMIT" | "REFUSED_OTHER" }
  | { readonly status: "TIMEOUT" }
  | { readonly status: "UNAVAILABLE" }
  | { readonly status: "UNAUTHORIZED" };

/** The relay's `OK`, as the category this module hands out. */
const publishAckOf = (accepted: boolean, message: string): BuzzPublishAck => {
  if (message.startsWith("duplicate:")) return { status: "DUPLICATE" };
  if (accepted) return { status: "ACCEPTED" };
  return { status: "REFUSED", category: message.startsWith("rate-limited:") ? "REFUSED_RATE_LIMIT" : "REFUSED_OTHER" };
};

/** The EVENT frame `event` goes out in, its fields in one fixed order: the bytes the relay receives. */
const eventFrame = (event: BuzzSignedEvent): string => JSON.stringify(["EVENT", {
  id: event.id,
  pubkey: event.pubkey,
  created_at: event.created_at,
  kind: event.kind,
  tags: event.tags,
  content: event.content,
  sig: event.sig,
}]);

/** An owner reply's tags: the room, and the event it answers, in the shape the live relay writes. */
const ownerReplyTags = (publication: OwnerReplyPublication): string[][] => [
  ["h", publication.room],
  ["e", publication.replyToEventId, "", "reply"],
];

/**
 * Publishing as the identities this subscriber holds, over their own connections (#1036).
 *
 * The owner-reply consumer's way out to the relay. It is not a second client. Each identity's
 * socket is already authenticated as that identity (NIP-42), so a reply sent on it is accepted as
 * that identity's. The key never leaves this module: callers get signatures, not secrets.
 *
 * It signs and sends owner replies and nothing else (R1056-01). Both calls take an
 * `OwnerReplyPublication` that the owner-reply outbox issued from a stored item, and that the
 * call spends. The template and the event come from that publication, never from the caller, and
 * are checked here against its text, signer, room and the event it answers.
 *
 * The `buzz messages send` CLI that `BuzzAdapter` delivers through was decided against for owner
 * replies: its invocation takes a channel, content and mentions, and no reply tag.
 */
export interface BuzzReplyPublisher {
  readonly relayUrl: string | null;
  /** The rooms an identity this daemon holds subscribes to, or `null` for one it does not hold. */
  roomsOf(pubkey: string): readonly string[] | null;
  /** Whether that identity's connection has authenticated, so the relay will take an event on it. */
  ready(pubkey: string): boolean;
  /**
   * Signs the reply an issued publication with no recorded intent describes. `null` when the
   * publication is not an issued one, already has an intent, or names an identity or room this
   * daemon does not hold.
   */
  signOwnerReply(publication: OwnerReplyPublication): BuzzSignedEvent | null;
  /**
   * Sends an issued publication's recorded event on its signer's connection, and resolves with the
   * relay's verdict or the lack of one. Anything but that exact, validly signed reply, equal in id
   * and bytes to the intent storage holds for its turn when it is sent, is `UNAUTHORIZED` and is
   * not sent.
   */
  publishOwnerReply(publication: OwnerReplyPublication, timeoutMs: number): Promise<BuzzPublishAck>;
  /** Called after any identity's connection authenticates: at startup and after every reconnect. */
  onAuthenticated(listener: () => void): () => void;
}

const NO_REPLY_PUBLISHER: BuzzReplyPublisher = Object.freeze({
  relayUrl: null,
  roomsOf: () => null,
  ready: () => false,
  signOwnerReply: () => null,
  publishOwnerReply: () => Promise.resolve({ status: "UNAVAILABLE" } as const),
  onAuthenticated: () => () => undefined,
});

/** What a started subscriber offers its caller, and what a disabled one offers instead. */
export interface BuzzMentionSubscriberHandle {
  /**
   * How many identities this daemon was *configured* to subscribe as, fixed at startup.
   *
   * Not a liveness signal, and it used to be documented as one ("how many relay connections this
   * daemon holds open"). It is the configured identity count, captured once; a socket that later
   * dropped, an authentication that never completed, a `REQ` the relay refused, an identity
   * excluded for want of a live binding — none of them move it. Read `counters()` for what this
   * subscriber has actually seen (#841), and `admission()` for which identities are delivering.
   */
  readonly socketCount: number;
  /**
   * Receipt, summed across every identity, with `admission` beside it. `framesHandled === 0` on a
   * subscriber that has been up for a while is the reading that separates "connected and receiving
   * nothing" from "receiving and refusing", which no number here could distinguish before.
   */
  counters(): BuzzMentionCounters;
  /** Which configured identities are delivering, and why each other one is not. */
  admission(): BuzzMentionAdmissionSnapshot;
  /**
   * Judges every configured identity again: an excluded one whose binding is now admissible is
   * connected from its preserved window, and an admitted one whose binding is gone is disconnected
   * with its window kept. The daemon calls this on every committed binding switch (bind, re-claim,
   * session change, revoke). Idempotent, and a no-op once closed.
   */
  rejudge(): void;
  /**
   * Whether the configured identity with channel key `actorId` may be woken for delivery to
   * `roleKey` right now, and the room its session answers in: judged afresh against the registry
   * and required admitted here too. Found by the key alone; no other identity's role pin stands in
   * for it. `null` when no configured identity has that key, or the subscriber is closed.
   */
  deliveryEligibility(holder: { readonly actorId: string; readonly roleKey: string }): BuzzMentionDeliveryEligibility | null;
  readonly relayUrl: string | null;
  /** The roles this daemon's admitted identities are pinned to right now, in config order. */
  readonly roleKeys: readonly string[];
  /**
   * Every room named across every configured identity, deduplicated. Empty exactly when
   * `socketCount` is zero. Exposed so a caller with its own notion of "the room this daemon
   * answers in" (`ACP_BUZZ_CHANNEL`) can check it is actually among these rather than assume it —
   * this module reads no environment variable itself, so that check belongs to the caller.
   */
  readonly rooms: readonly string[];
  /**
   * Each **configured** identity's channel identity (the public key its file derives) and the rooms
   * its own `REQ` is scoped to, in config order, whether or not it is admitted right now. `rooms`
   * above is their union, and a union cannot say which identity hears which room: a caller that
   * routes one identity's mentions to a room of its choosing (a canonical CTO's `buzzAddress`) has
   * to find that room in that identity's list.
   *
   * Configured, not admitted: this list is a room restriction for the paths that write a room (the
   * claim, the reattach correction, the startup cross-check), and an identity's restriction holds
   * while it is excluded too. An exclusion that removed it would turn "this identity listens only
   * in A" into "nothing is known", which those paths read as permission.
   */
  readonly identityRooms: readonly BuzzSubscriberIdentityRooms[];
  /** Settles once every frame delivered so far has been handled. For tests; production ignores it. */
  settled(): Promise<void>;
  /** Publishing as these identities, for the owner-reply consumer (#1036). */
  readonly replies: BuzzReplyPublisher;
  close(): void;
}

/** One subscribed identity: who it listens as, and the rooms it listens in. */
export interface BuzzSubscriberIdentityRooms {
  /** The identity's public key, the value a session's `buzzActorId` is bound to. Not a secret. */
  readonly actorId: string;
  readonly rooms: readonly string[];
}

/** A holder's delivery eligibility, as the wake's final check reads it. */
export interface BuzzMentionDeliveryEligibility {
  readonly eligible: boolean;
  /** The room the holder's session answers in when eligible; `null` otherwise. */
  readonly room: string | null;
}

/** The disabled outcome, stated rather than implied by a null. */
const NO_ADMISSION: BuzzMentionAdmissionSnapshot = Object.freeze({
  continuity: "NONE",
  configuredIdentities: 0,
  admittedIdentities: 0,
  identities: Object.freeze([]),
});

const DISABLED: BuzzMentionSubscriberHandle = {
  socketCount: 0,
  counters: () => ({ framesHandled: 0, admitted: 0, rejections: {} }),
  admission: () => NO_ADMISSION,
  rejudge: () => {
    /* nothing is configured to judge */
  },
  deliveryEligibility: () => null,
  relayUrl: null,
  roleKeys: [],
  rooms: [],
  identityRooms: [],
  replies: NO_REPLY_PUBLISHER,
  settled: () => Promise.resolve(),
  close: () => {
    /* nothing was opened */
  },
};

export interface BuzzMentionSubscriberOptions {
  readonly config: BuzzSubscriberConfig;
  readonly registry: BuzzMentionRegistry;
  readonly sink: BuzzMentionSink;
  readonly openSocket?: BuzzRelaySocketFactory;
  readonly scheduler?: BuzzSubscriberScheduler;
  /** Defaulted, never absent: an omitted reporter would restore the silence, not opt out of it. */
  readonly reportRoleNotHeld?: BuzzMentionRoleNotHeldReporter;
  /** Defaulted for the same reason: an excluded identity the operator is not told of is a silent one. */
  readonly reportAdmission?: BuzzMentionAdmissionReporter;
}

/**
 * The configuration is all-or-none; binding admission is per identity.
 *
 * Two passes, both complete before the first socket opens. The **configuration** pass refuses the
 * whole start on any error — a key path named twice, one file under two names, a key that cannot be
 * opened safely — because an operator who wrote a wrong file meant something this build cannot do.
 *
 * The **admission** pass judges each identity's binding alone. One that is paused, revoked or
 * unverifiable is excluded with its reason, opens no socket and has none of its mail asked for;
 * every other identity is admitted and opens. That split is the repair: one canonical CTO without a
 * live binding used to refuse the subscriber for all of them, and the others fell back to polling.
 *
 * A partial start is not allowed to read as a whole one. The exclusions are reported as they are
 * decided, and `admission()` — written into health beside the counters — says `PARTIAL` with each
 * excluded identity's reason for as long as any is excluded.
 */
export const startBuzzMentionSubscriber = (
  options: BuzzMentionSubscriberOptions,
): BuzzMentionSubscriberHandle => {
  const reportAdmission = options.reportAdmission ?? nativeAdmissionReporter;
  const authenticatedListeners = new Set<() => void>();
  const prepared: BuzzMentionSubscription[] = [];
  let closed = false;

  /**
   * Whether `roleKey` is pinned to an admitted identity other than `self`. The rule two identities
   * resolving to one role has always had, applied per identity: the one already admitted keeps it,
   * and the later claimant is excluded rather than the whole subscriber refused.
   */
  const roleHeldByAnother = (roleKey: string, self: BuzzMentionSubscription): boolean =>
    prepared.some((other) => other !== self && other.admitted && other.roleKey === roleKey);

  /** Applies one judgement to one identity and reports what changed. */
  const apply = (subscription: BuzzMentionSubscription, judgement: BuzzMentionIdentityJudgement): void => {
    if (judgement.verdict === "ADMITTED" && !roleHeldByAnother(judgement.binding.roleKey, subscription)) {
      if (subscription.admit(judgement.binding)) {
        reportAdmission({
          identity: subscription.ordinal,
          identityPubkey: subscription.pubkey,
          state: "ADMITTED",
          reason: null,
          roleKey: judgement.binding.roleKey,
        });
      }
      return;
    }
    const reason =
      judgement.verdict === "EXCLUDED" ? judgement.reason : BuzzMentionExclusion.ROLE_HELD_BY_ANOTHER_IDENTITY;
    if (subscription.exclude(reason)) {
      reportAdmission({
        identity: subscription.ordinal,
        identityPubkey: subscription.pubkey,
        state: "EXCLUDED",
        reason,
        roleKey: null,
      });
    }
  };

  const deps: SubscriptionDeps = {
    relayUrl: options.config.relayUrl,
    sink: options.sink,
    registry: options.registry,
    openSocket: options.openSocket ?? nativeRelaySocketFactory,
    scheduler: options.scheduler ?? nativeSubscriberScheduler(),
    reportRoleNotHeld: options.reportRoleNotHeld ?? nativeRoleNotHeldReporter,
    // On a later microtask, so a listener never runs inside this connection's frame handling.
    authenticated: () => {
      for (const listener of authenticatedListeners) {
        queueMicrotask(() => {
          try {
            listener();
          } catch {
            /* a listener's failure is its own; the connection carries on */
          }
        });
      }
    },
    rejudge: (subscription) => {
      if (!closed) apply(subscription, subscription.judge());
    },
  };

  const seenPaths = new Set<string>();
  const seenFiles = new Set<string>();
  const seenPubkeys = new Set<string>();
  const rooms = new Set<string>();
  const identityRooms: BuzzSubscriberIdentityRooms[] = [];

  // The configuration pass. Every failure here refuses the whole start, before any judgement.
  options.config.identities.forEach((identity, index) => {
    const what = `identities[${index}]`;
    // The path is compared as configured. Two entries naming one path are one identity written
    // twice, and the duplicate would open a second socket asserting the same role — two claimants
    // for one binding, and a race between them for every message.
    if (seenPaths.has(identity.privateKeyFile)) {
      throw new Error(`${what} names a key file another identity already names`);
    }
    seenPaths.add(identity.privateKeyFile);

    const material = loadBuzzSubscriberKey(identity, what);
    if (seenFiles.has(material.fileIdentity)) {
      throw new Error(`${what} key file is the same file as another identity's`);
    }
    seenFiles.add(material.fileIdentity);
    if (seenPubkeys.has(material.pubkey)) {
      throw new Error(`${what} derives a channel identity another identity already derives`);
    }
    seenPubkeys.add(material.pubkey);

    // Every configured identity, admitted or not: its rooms restrict the paths that write a room.
    for (const room of identity.rooms) rooms.add(room);
    identityRooms.push(Object.freeze({ actorId: material.pubkey, rooms: Object.freeze([...identity.rooms]) }));
    prepared.push(
      new BuzzMentionSubscription(deps, {
        ordinal: what,
        pubkey: material.pubkey,
        secretKey: material.secretKey,
        rooms: identity.rooms,
      }),
    );
  });

  // The admission pass: every judgement read before anything is applied, so the role-uniqueness
  // rule sees one consistent answer per identity rather than one the previous identity moved.
  const judgements = prepared.map((subscription) => subscription.judge());
  const startupRoles = new Set<string>();
  const startupDecisions = judgements.map((judgement): BuzzMentionIdentityJudgement => {
    if (judgement.verdict !== "ADMITTED") return judgement;
    if (startupRoles.has(judgement.binding.roleKey)) {
      return excluded(BuzzMentionExclusion.ROLE_HELD_BY_ANOTHER_IDENTITY);
    }
    startupRoles.add(judgement.binding.roleKey);
    return judgement;
  });
  // Pinned, or marked excluded, with no socket and no timer yet: the sockets open below or not at
  // all, and an exclusion's timer and report wait until the start is known to have succeeded.
  startupDecisions.forEach((decision, index) => {
    const subscription = prepared[index]!;
    if (decision.verdict === "ADMITTED") subscription.pin(decision.binding);
  });

  // All-or-none, and this is the half the preflight cannot cover.
  //
  // The preflight refuses before anything is open, so its failures cost nothing to unwind. A
  // *construction* failure is different: by the time the second socket throws, the first is open
  // and listening, and the throw leaves this function without ever returning a handle. That
  // connection is then unreachable by construction — the caller holds no object, so no later
  // `close()` can reach it and no reconnect path leads back to it. A partial start at least has
  // an owner; this would have none.
  //
  // Every prepared subscription is closed, including the generation whose socket failed: `open`
  // claims a generation before it constructs, so closing it is what stops that number from being
  // treated as live by anything still holding it. `close` on one that never opened is a no-op.
  //
  // The original error is rethrown rather than wrapped. The operator needs the constructor's own
  // failure — a relay refusal, a bad URL, a runtime with no `WebSocket` — and an unwind error in
  // its place would report that cleanup happened while hiding why startup refused at all.
  /** The subscription that holds an identity, for publishing as it (#1036). */
  const holding = (pubkey: string): BuzzMentionSubscription | null =>
    prepared.find((subscription) => subscription.pubkey === pubkey) ?? null;

  try {
    for (const subscription of prepared) subscription.open();
  } catch (err) {
    closed = true;
    for (const subscription of prepared) subscription.close();
    throw err;
  }

  // Only now, with the start certain: each excluded identity is reported once, and its judgement
  // timer starts asking the registry again.
  startupDecisions.forEach((decision, index) => {
    if (decision.verdict === "EXCLUDED") apply(prepared[index]!, decision);
  });

  const admission = (): BuzzMentionAdmissionSnapshot => {
    const identities = prepared.map((subscription) => subscription.admission());
    const admittedIdentities = identities.filter((one) => one.state === "ADMITTED").length;
    return {
      continuity:
        admittedIdentities === identities.length ? "FULL" : admittedIdentities === 0 ? "NONE" : "PARTIAL",
      configuredIdentities: identities.length,
      admittedIdentities,
      identities,
    };
  };

  return {
    socketCount: prepared.length,
    // Summed rather than per-identity: the operator question this answers is "is anything
    // arriving at all", and a per-identity breakdown is a later refinement of an answer that does
    // not exist yet. Admission is the per-identity part, and it rides beside the sums.
    counters: () => {
      const totals = prepared.map((subscription) => subscription.counters());
      const rejections: Record<string, number> = {};
      for (const one of totals) {
        for (const [reason, count] of Object.entries(one.rejections)) {
          rejections[reason] = (rejections[reason] ?? 0) + count;
        }
      }
      return {
        framesHandled: totals.reduce((sum, one) => sum + one.framesHandled, 0),
        admitted: totals.reduce((sum, one) => sum + one.admitted, 0),
        rejections,
        admission: admission(),
      };
    },
    admission,
    deliveryEligibility: (holder) => {
      const subscription = prepared.find((one) => one.pubkey === holder.actorId);
      // A closed subscriber judges nothing and gates nothing.
      if (subscription === undefined || closed) return null;
      const judged = subscription.judge();
      const eligible =
        subscription.admitted && judged.verdict === "ADMITTED" && judged.binding.roleKey === holder.roleKey;
      return { eligible, room: eligible && judged.verdict === "ADMITTED" ? judged.binding.room : null };
    },
    rejudge: () => {
      if (closed) return;
      // Every answer read first, as at startup; then the identities that are not admissible are
      // excluded before any is admitted, so a role moving from one identity to another is released
      // by the first before the second asks for it.
      const fresh = prepared.map((subscription) => subscription.judge());
      prepared.forEach((subscription, index) => {
        const judgement = fresh[index]!;
        if (judgement.verdict === "EXCLUDED") apply(subscription, judgement);
      });
      prepared.forEach((subscription, index) => {
        const judgement = fresh[index]!;
        if (judgement.verdict === "ADMITTED") apply(subscription, judgement);
      });
    },
    relayUrl: options.config.relayUrl,
    get roleKeys(): readonly string[] {
      return prepared.flatMap((subscription) =>
        subscription.admitted && subscription.roleKey !== null ? [subscription.roleKey] : [],
      );
    },
    rooms: [...rooms],
    identityRooms,
    settled: async () => {
      for (const subscription of prepared) await subscription.settled();
    },
    replies: {
      relayUrl: options.config.relayUrl,
      roomsOf: (pubkey) => holding(pubkey)?.rooms ?? null,
      ready: (pubkey) => holding(pubkey)?.ready ?? false,
      signOwnerReply: (value) => {
        const redeemed = redeemOwnerReplyPublication(value);
        return redeemed === null ? null : holding(redeemed.publication.signer)?.signOwnerReply(redeemed.publication) ?? null;
      },
      publishOwnerReply: (value, timeoutMs) => {
        // Spent and checked against storage here, with nothing awaited before the frame is written.
        const redeemed = redeemOwnerReplyPublication(value);
        const subscription = redeemed === null ? null : holding(redeemed.publication.signer);
        return redeemed === null || subscription === null
          ? Promise.resolve({ status: "UNAUTHORIZED" })
          : subscription.publishOwnerReply(redeemed.publication, redeemed.recorded, timeoutMs);
      },
      onAuthenticated: (listener) => {
        authenticatedListeners.add(listener);
        return () => {
          authenticatedListeners.delete(listener);
        };
      },
    },
    close: () => {
      closed = true;
      for (const subscription of prepared) subscription.close();
    },
  };
};

/**
 * The whole path, from "is this daemon configured to subscribe" to an open socket.
 *
 * Absent config is the disabled handle rather than a throw, and a present-but-wrong one is a
 * throw rather than a disabled handle. Those are the two halves of the config authority: a
 * deployment that said nothing gets nothing, and a deployment that said something wrong is told.
 */
export const startBuzzMentionSubscriberFromStateDir = (
  stateDir: string,
  options: Omit<BuzzMentionSubscriberOptions, "config">,
): BuzzMentionSubscriberHandle => {
  const config = readBuzzSubscriberConfig(stateDir);
  if (config === null) return DISABLED;
  return startBuzzMentionSubscriber({ ...options, config });
};
