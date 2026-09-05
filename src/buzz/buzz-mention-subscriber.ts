import { randomUUID, timingSafeEqual } from "node:crypto";
import { closeSync, constants as fsConstants, fstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";

import { decode } from "nostr-tools/nip19";
import { makeAuthEvent } from "nostr-tools/nip42";
import { finalizeEvent, getPublicKey, validateEvent, verifyEvent } from "nostr-tools/pure";

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

/** How an identity's secret key is written in its file. Declared, never sniffed. */
export type BuzzSubscriberKeyEncoding = "hex" | "nsec";

/** One channel identity this daemon subscribes as. */
export interface BuzzSubscriberIdentityConfig {
  /** An absolute, already-normalized path. Opened `O_NOFOLLOW`; never logged. */
  readonly privateKeyFile: string;
  readonly encoding: BuzzSubscriberKeyEncoding;
}

/** The whole of what `buzz-nostr-subscriber.json` may say. */
export interface BuzzSubscriberConfig {
  readonly relayUrl: string;
  readonly identities: readonly BuzzSubscriberIdentityConfig[];
}

/** Exactly the keys the file may carry, at each of its two levels. */
const CONFIG_FIELDS: readonly string[] = ["relayUrl", "identities"];
const IDENTITY_FIELDS: readonly string[] = ["privateKeyFile", "encoding"];
const KEY_ENCODINGS: readonly string[] = ["hex", "nsec"];

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
}

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
 * What the admission seam did with one envelope, in the only four answers this subscriber can act
 * on differently.
 *
 * The three that advance the cursor are three ways of "there is nothing more to do with this
 * event": it became durable, it already was, or it was refused for a reason a redelivery would be
 * refused for again. `RETRY` is the only one that means the answer might change, and it is the
 * only one that must not advance anything.
 */
export type BuzzMentionAdmission = "DURABLE" | "ALREADY_DURABLE" | "TERMINAL" | "RETRY";

/** One verified event, addressed, on its way to the admission seam. */
export interface BuzzMentionAdmissionRequest {
  /** The role the `p`-tagged identity holds right now, re-checked immediately before this call. */
  readonly roleKey: string;
  /** The channel identity the event's `p` tag named: this daemon's own subscribed pubkey. */
  readonly identityPubkey: string;
  /** The Buzz room the event arrived on — its single `h` tag. */
  readonly conversation: string;
  readonly event: BuzzMentionEvent;
}

/** Where a verified event goes. The daemon's composition is the only production implementation. */
export interface BuzzMentionSink {
  admit(request: BuzzMentionAdmissionRequest): Promise<BuzzMentionAdmission>;
}

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

/**
 * The timer seam. Injected so the reconnect schedule is a thing a test can *step*, rather than a
 * thing a test has to outlast: a table that proved the 30s cap by sleeping 61 seconds would be a
 * table nobody runs.
 */
export interface BuzzSubscriberScheduler {
  setTimer(ms: number, fire: () => void): number;
  clearTimer(handle: number): void;
}

/** The minimum of `WebSocket` this module uses, so nothing here depends on a DOM lib. */
interface MinimalWebSocket {
  send(data: string): void;
  close(): void;
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void;
}
type MinimalWebSocketConstructor = new (url: string) => MinimalWebSocket;

/**
 * Node 22's own `globalThis.WebSocket`, and no library.
 *
 * `nostr-tools` ships `Relay`/`SimplePool`, which would bring their own socket, their own
 * reconnect policy and their own subscription bookkeeping — three behaviours this daemon has
 * opinions about and would then be unable to state. What is imported from that package is only
 * the pure functions: the signature scheme, and nothing that opens anything.
 */
export const nativeRelaySocketFactory: BuzzRelaySocketFactory = (url, handlers) => {
  const ctor = (globalThis as { WebSocket?: MinimalWebSocketConstructor }).WebSocket;
  if (typeof ctor !== "function") {
    throw new Error("this runtime has no global WebSocket; the buzz subscriber requires Node 22 or newer");
  }
  const socket = new ctor(url);
  socket.addEventListener("open", () => handlers.onOpen());
  socket.addEventListener("message", (event) => {
    if (typeof event.data === "string") handlers.onFrame(event.data);
    else handlers.onClose();
  });
  socket.addEventListener("close", () => handlers.onClose());
  socket.addEventListener("error", () => handlers.onClose());
  return {
    send: (frame) => socket.send(frame),
    close: () => socket.close(),
  };
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
  | "role-not-held";

/** What one identity's connection did with one frame. */
interface BuzzMentionFrameOutcome {
  readonly rejected: BuzzMentionRejection | null;
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
  readonly #pubkey: string;
  readonly #secretKey: Uint8Array;
  readonly #roleKey: string;
  readonly #subscriptionId = randomUUID().replace(/-/gu, "");

  #socket: BuzzRelaySocket | null = null;
  #authEventId: string | null = null;
  #subscribed = false;
  /** The volatile high-water mark. Inclusive: `since` is `>=` on the wire. */
  #since: number | null = null;
  #attempt = 0;
  #timer: number | null = null;
  #stopped = false;
  /** Frames are handled one at a time; a second must not overtake the first's admission. */
  #queue: Promise<void> = Promise.resolve();

  constructor(deps: SubscriptionDeps, identity: { pubkey: string; secretKey: Uint8Array; roleKey: string }) {
    this.#deps = deps;
    this.#pubkey = identity.pubkey;
    this.#secretKey = identity.secretKey;
    this.#roleKey = identity.roleKey;
  }

  /** The volatile high-water mark, for the rows that assert a redelivery window rather than a file. */
  get since(): number | null {
    return this.#since;
  }

  get subscriptionId(): string {
    return this.#subscriptionId;
  }

  open(): void {
    if (this.#stopped || this.#socket !== null) return;
    this.#authEventId = null;
    this.#subscribed = false;
    this.#socket = this.#deps.openSocket(this.#deps.relayUrl, {
      onOpen: () => {
        /* NIP-42 first: nothing is requested until the relay has challenged and accepted us. */
      },
      onFrame: (raw) => {
        this.#queue = this.#queue.then(async () => {
          try {
            await this.#handleFrame(raw);
          } catch {
            // A sink that threw established nothing about the message, so this is the `RETRY`
            // shape and is treated as one: the cursor stays where it is and the socket goes.
            // Letting it reject would take the queue's chain with it, and every later frame on
            // this connection would then be dropped silently.
            this.#reconnect();
          }
        });
      },
      onClose: () => this.#onClose(),
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
    this.#subscribed = false;
    this.#authEventId = null;
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
    this.#subscribed = false;
    this.#authEventId = null;
    if (this.#stopped || this.#timer !== null) return;
    const step = Math.min(this.#attempt, RELAY_RECONNECT_BACKOFF_MS.length - 1);
    const delay = RELAY_RECONNECT_BACKOFF_MS[step] ?? 30_000;
    this.#attempt += 1;
    this.#timer = this.#deps.scheduler.setTimer(delay, () => {
      this.#timer = null;
      this.open();
    });
  }

  /** Drops the socket without waiting for the relay to notice, and schedules the reconnect. */
  #reconnect(): void {
    this.#drop();
    this.#onClose();
  }

  async #handleFrame(raw: string): Promise<BuzzMentionFrameOutcome> {
    if (Buffer.byteLength(raw, "utf8") > MAX_RELAY_FRAME_BYTES) {
      this.#reconnect();
      return rejected("frame-too-large");
    }
    let frame: unknown;
    try {
      frame = JSON.parse(raw) as unknown;
    } catch {
      this.#reconnect();
      return rejected("frame-not-json");
    }
    if (!Array.isArray(frame) || typeof frame[0] !== "string") {
      this.#reconnect();
      return rejected("frame-not-a-message");
    }
    switch (frame[0]) {
      case "AUTH":
        return this.#onAuthChallenge(frame);
      case "OK":
        return this.#onOk(frame);
      case "EVENT":
        return await this.#onEvent(frame);
      case "EOSE":
        return this.#onEose(frame);
      case "CLOSED":
        this.#reconnect();
        return rejected("unknown-subscription");
      default:
        // `NOTICE` and anything else a relay chooses to say. Ignored rather than treated as a
        // protocol violation: a relay that adds a message type is not a relay this daemon should
        // stop reading, and nothing below acts on a frame it did not recognise.
        return ACCEPTED;
    }
  }

  #onAuthChallenge(frame: readonly unknown[]): BuzzMentionFrameOutcome {
    const challenge = frame[1];
    if (frame.length !== 2 || typeof challenge !== "string" || challenge.length === 0) {
      this.#reconnect();
      return rejected("frame-not-a-message");
    }
    const signed = finalizeEvent(makeAuthEvent(this.#deps.relayUrl, challenge), this.#secretKey);
    this.#authEventId = signed.id;
    this.#socket?.send(JSON.stringify(["AUTH", signed]));
    return ACCEPTED;
  }

  /**
   * The relay's verdict on our NIP-42 assertion, and the only thing that opens the subscription.
   *
   * A refusal reconnects rather than requesting anyway: an unauthenticated `REQ` on a relay that
   * demanded AUTH either returns nothing or returns a public subset, and the second is worse — the
   * subscriber would look healthy while missing exactly the messages the auth was for.
   */
  #onOk(frame: readonly unknown[]): BuzzMentionFrameOutcome {
    const id = frame[1];
    if (typeof id !== "string" || id !== this.#authEventId) return ACCEPTED;
    if (frame[2] !== true) {
      this.#reconnect();
      return rejected("auth-refused");
    }
    this.#subscribed = true;
    const filter: Record<string, unknown> = {
      kinds: [BUZZ_MENTION_KIND],
      "#p": [this.#pubkey],
    };
    if (this.#since !== null) filter["since"] = this.#since;
    this.#socket?.send(JSON.stringify(["REQ", this.#subscriptionId, filter]));
    return ACCEPTED;
  }

  /**
   * End of stored events.
   *
   * Two things happen here and neither is durable. The high-water mark is floored at whatever has
   * been advanced so far, so a reconnect asks for the tail rather than the whole history; and the
   * backoff resets, because a connection that reached EOSE is a connection that worked.
   */
  #onEose(frame: readonly unknown[]): BuzzMentionFrameOutcome {
    if (frame[1] !== this.#subscriptionId) return rejected("unknown-subscription");
    this.#attempt = 0;
    if (this.#since === null) this.#since = 0;
    return ACCEPTED;
  }

  async #onEvent(frame: readonly unknown[]): Promise<BuzzMentionFrameOutcome> {
    // The subscription id first, before a byte of the event is looked at. A relay that answers a
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
    // The `p` filter is the relay's promise; this is the daemon checking it. A relay that widened
    // the filter would otherwise hand this subscriber someone else's mail to speak for.
    if (!tagValues(event, "p").some((value) => value === this.#pubkey)) {
      return rejected("event-not-addressed");
    }
    // Exactly one `h`, non-empty. The `h` tag is the Buzz room, and the room is what the answer
    // goes back to: none means there is no thread to answer, and two means picking one — which is
    // answering in a room the sender did not write in.
    const rooms = tagValues(event, "h").filter((value) => value.trim().length > 0);
    if (rooms.length !== 1) return rejected("event-conversation-unusable");
    const conversation = rooms[0];
    if (conversation === undefined) return rejected("event-conversation-unusable");

    // Re-checked here, not only at startup. The role can move between the preflight and this
    // event — that is ordinary operation — and a subscriber that spoke for a role it no longer
    // holds would be admitting an owner's message against a stale binding.
    const bound = this.#deps.registry.primaryCtoBindingFor(this.#pubkey);
    if (!bound || bound.roleKey !== this.#roleKey || !constantTimeEquals(bound.buzzActorId, this.#pubkey)) {
      // A race, not a refusal: the cursor is preserved and the socket goes, so the same event is
      // asked for again once the registry has settled.
      this.#reconnect();
      return rejected("role-not-held");
    }

    const frozen: BuzzMentionEvent = deepFreeze(event);
    const admission = await this.#deps.sink.admit({
      roleKey: bound.roleKey,
      identityPubkey: this.#pubkey,
      conversation,
      event: frozen,
    });
    if (admission === "RETRY") {
      this.#reconnect();
      return { rejected: null, admission };
    }
    this.#since = Math.max(this.#since ?? 0, event.created_at);
    return { rejected: null, admission };
  }
}

/** What a started subscriber offers its caller, and what a disabled one offers instead. */
export interface BuzzMentionSubscriberHandle {
  /** How many relay connections this daemon holds open. Zero whenever the path is not configured. */
  readonly socketCount: number;
  readonly relayUrl: string | null;
  /** The roles this daemon subscribes for, in config order. */
  readonly roleKeys: readonly string[];
  /** Settles once every frame delivered so far has been handled. For tests; production ignores it. */
  settled(): Promise<void>;
  close(): void;
}

/** The disabled outcome, stated rather than implied by a null. */
const DISABLED: BuzzMentionSubscriberHandle = {
  socketCount: 0,
  relayUrl: null,
  roleKeys: [],
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
}

/**
 * Every identity is preflighted before the first socket opens, and any failure opens none.
 *
 * The ordering is the whole of it. A loop that opened each socket as it validated would leave a
 * deployment with three of five identities subscribed and an error in the log — which is the state
 * an operator reads as "it started". Preflight is therefore a complete pass with no side effect,
 * and the sockets are opened afterwards or not at all.
 */
export const startBuzzMentionSubscriber = (
  options: BuzzMentionSubscriberOptions,
): BuzzMentionSubscriberHandle => {
  const deps: SubscriptionDeps = {
    relayUrl: options.config.relayUrl,
    sink: options.sink,
    registry: options.registry,
    openSocket: options.openSocket ?? nativeRelaySocketFactory,
    scheduler: options.scheduler ?? nativeSubscriberScheduler(),
  };

  const seenPaths = new Set<string>();
  const seenFiles = new Set<string>();
  const seenPubkeys = new Set<string>();
  const seenRoles = new Set<string>();
  const prepared: BuzzMentionSubscription[] = [];
  const roleKeys: string[] = [];

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

    const bound = deps.registry.primaryCtoBindingFor(material.pubkey);
    if (!bound) {
      throw new Error(`${what} does not currently hold a live PRIMARY_CTO binding`);
    }
    if (!constantTimeEquals(bound.buzzActorId, material.pubkey)) {
      throw new Error(`${what} resolves to a session bound to a different channel identity`);
    }
    if (seenRoles.has(bound.roleKey)) {
      throw new Error(`${what} holds a role another identity already holds`);
    }
    seenRoles.add(bound.roleKey);

    roleKeys.push(bound.roleKey);
    prepared.push(
      new BuzzMentionSubscription(deps, {
        pubkey: material.pubkey,
        secretKey: material.secretKey,
        roleKey: bound.roleKey,
      }),
    );
  });

  for (const subscription of prepared) subscription.open();

  return {
    socketCount: prepared.length,
    relayUrl: options.config.relayUrl,
    roleKeys,
    settled: async () => {
      for (const subscription of prepared) await subscription.settled();
    },
    close: () => {
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
