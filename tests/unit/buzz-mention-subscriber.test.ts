import { chmodSync, linkSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { nsecEncode } from "nostr-tools/nip19";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { afterAll, describe, expect, it } from "vitest";

import {
  BUZZ_MENTION_KIND,
  BUZZ_SUBSCRIBER_CONFIG_FILENAME,
  MAX_RELAY_FRAME_BYTES,
  RELAY_RECONNECT_BACKOFF_MS,
  parseBuzzSubscriberConfig,
  startBuzzMentionSubscriberFromStateDir,
  type BuzzMentionAdmission,
  type BuzzMentionRegistry,
  type BuzzMentionSink,
  type BuzzMentionSubscriberHandle,
  type BuzzRelaySocketFactory,
  type BuzzRelaySocketHandlers,
  type BuzzSubscriberScheduler,
} from "../../src/buzz/buzz-mention-subscriber.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/** The secret as its file holds it. Local, so this file declares no dependency of its own. */
const asHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

const RELAY = "wss://relay.example.invalid/buzz";
const ROOM = "buzz-room-1";
const ROLE_KEY = "PRIMARY_CTO:proj-1";

/* ------------------------------------------------------------------ transport and clock seams */

/** One relay connection, held open by nothing: the test is the network and the test is the clock. */
interface ManualSocket {
  url: string;
  sent: string[];
  closed: boolean;
  handlers: BuzzRelaySocketHandlers;
}

const manualTransport = (): { sockets: ManualSocket[]; factory: BuzzRelaySocketFactory } => {
  const sockets: ManualSocket[] = [];
  const factory: BuzzRelaySocketFactory = (url, handlers) => {
    const socket: ManualSocket = { url, sent: [], closed: false, handlers };
    sockets.push(socket);
    return {
      send: (frame) => socket.sent.push(frame),
      close: () => {
        socket.closed = true;
      },
    };
  };
  return { sockets, factory };
};

/**
 * A clock the test steps.
 *
 * The reconnect schedule caps at thirty seconds, and the row that proves the cap has to reach the
 * seventh attempt. Against a real timer that row costs 61 seconds of wall clock and would be the
 * first thing anyone deleted; here it costs seven function calls and asserts the *sequence*, which
 * a `setTimeout`-based row could not do at all.
 */
interface VirtualClock {
  scheduler: BuzzSubscriberScheduler;
  /** Every delay ever requested, in order. */
  delays: number[];
  pending: () => number;
  fireAll: () => void;
}

const virtualClock = (): VirtualClock => {
  const timers = new Map<number, () => void>();
  const delays: number[] = [];
  let next = 1;
  return {
    scheduler: {
      setTimer: (ms, fire) => {
        const handle = next++;
        delays.push(ms);
        timers.set(handle, fire);
        return handle;
      },
      clearTimer: (handle) => {
        timers.delete(handle);
      },
    },
    delays,
    pending: () => timers.size,
    fireAll: () => {
      for (const [handle, fire] of [...timers]) {
        timers.delete(handle);
        fire();
      }
    },
  };
};

/* ------------------------------------------------------------------------------- key fixtures */

interface Identity {
  secretKey: Uint8Array;
  pubkey: string;
  keyFile: string;
}

/** A key file exactly as the config requires one: absolute, regular, owner-only. */
const keyFileIn = (dir: string, name: string, contents: string, mode = 0o600): string => {
  const path = join(dir, name);
  writeFileSync(path, contents, { mode });
  chmodSync(path, mode);
  return path;
};

const hexIdentity = (dir: string, name: string): Identity => {
  const secretKey = generateSecretKey();
  return {
    secretKey,
    pubkey: getPublicKey(secretKey),
    keyFile: keyFileIn(dir, name, `${asHex(secretKey)}\n`),
  };
};

const nsecIdentity = (dir: string, name: string): Identity => {
  const secretKey = generateSecretKey();
  return {
    secretKey,
    pubkey: getPublicKey(secretKey),
    keyFile: keyFileIn(dir, name, `${nsecEncode(secretKey)}\n`),
  };
};

/* ------------------------------------------------------------------------- config and harness */

const writeConfig = (stateDir: string, value: unknown): void => {
  writeFileSync(
    join(stateDir, BUZZ_SUBSCRIBER_CONFIG_FILENAME),
    typeof value === "string" ? value : JSON.stringify(value),
  );
};

const configFor = (identities: readonly { keyFile: string; encoding: string }[], relayUrl = RELAY) => ({
  relayUrl,
  identities: identities.map((identity) => ({
    privateKeyFile: identity.keyFile,
    encoding: identity.encoding,
  })),
});

const registryHolding = (
  bindings: Readonly<Record<string, { roleKey: string; buzzActorId: string }>>,
): BuzzMentionRegistry => ({
  primaryCtoBindingFor: (pubkey) => bindings[pubkey] ?? null,
});

interface RecordingSink extends BuzzMentionSink {
  admitted: { eventId: string; text: string; conversation: string; roleKey: string }[];
  frozen: unknown[];
  answer: BuzzMentionAdmission;
  throwOnce: boolean;
}

const recordingSink = (answer: BuzzMentionAdmission = "DURABLE"): RecordingSink => {
  const sink: RecordingSink = {
    admitted: [],
    frozen: [],
    answer,
    throwOnce: false,
    admit: async (request) => {
      sink.admitted.push({
        eventId: request.event.id,
        text: request.event.content,
        conversation: request.conversation,
        roleKey: request.roleKey,
      });
      sink.frozen.push(request.event);
      if (sink.throwOnce) {
        sink.throwOnce = false;
        throw new Error("the seam threw");
      }
      return sink.answer;
    },
  };
  return sink;
};

/* ------------------------------------------------------------------------------ wire fixtures */

const mentionEvent = (input: {
  author: Uint8Array;
  addressedTo: string;
  /**
   * Further `p` recipients, signed alongside the first.
   *
   * Inside the signature like every other tag, so a row built with these is a genuinely valid
   * event that is wrong for one reason only: how many people it is addressed to.
   */
  alsoAddressedTo?: readonly string[];
  room?: string | readonly string[];
  text?: string;
  kind?: number;
  createdAt?: number;
}) => {
  const rooms =
    input.room === undefined ? [ROOM] : typeof input.room === "string" ? [input.room] : input.room;
  return finalizeEvent(
    {
      kind: input.kind ?? BUZZ_MENTION_KIND,
      created_at: input.createdAt ?? 1_800_000_000,
      tags: [
        ["p", input.addressedTo],
        ...(input.alsoAddressedTo ?? []).map((recipient) => ["p", recipient]),
        ...rooms.map((room) => ["h", room]),
      ],
      content: input.text ?? "CTO, 지금 상태 보고해줘",
    },
    input.author,
  );
};

const frame = (value: unknown): string => JSON.stringify(value);

const sentFrames = (socket: ManualSocket): unknown[][] =>
  socket.sent.map((raw) => JSON.parse(raw) as unknown[]);

/** Walks a connection through NIP-42 and returns the `REQ` the relay was sent, if any. */
const authenticate = async (
  socket: ManualSocket,
  handle: BuzzMentionSubscriberHandle,
  accepted = true,
): Promise<void> => {
  socket.handlers.onFrame(frame(["AUTH", "challenge-0001"]));
  await handle.settled();
  const auth = sentFrames(socket).at(-1) as [string, { id: string }];
  expect(auth[0]).toBe("AUTH");
  socket.handlers.onFrame(frame(["OK", auth[1].id, accepted, ""]));
  await handle.settled();
};

/** A started subscriber with one identity that does hold the role, and its live socket. */
const startOne = (options: {
  answer?: BuzzMentionAdmission;
}): {
  stateDir: string;
  owner: Identity;
  identity: Identity;
  sink: RecordingSink;
  clock: VirtualClock;
  sockets: ManualSocket[];
  handle: BuzzMentionSubscriberHandle;
} => {
  const stateDir = tempDir("acp-buzz-sub-");
  const keys = tempDir("acp-buzz-keys-");
  const identity = hexIdentity(keys, "cto.key");
  const owner = hexIdentity(keys, "owner.key");
  writeConfig(stateDir, configFor([{ keyFile: identity.keyFile, encoding: "hex" }]));
  const sink = recordingSink(options.answer ?? "DURABLE");
  const clock = virtualClock();
  const transport = manualTransport();
  const handle = startBuzzMentionSubscriberFromStateDir(stateDir, {
    registry: registryHolding({
      [identity.pubkey]: { roleKey: ROLE_KEY, buzzActorId: identity.pubkey },
    }),
    sink,
    openSocket: transport.factory,
    scheduler: clock.scheduler,
  });
  return { stateDir, owner, identity, sink, clock, sockets: transport.sockets, handle };
};

const live = (sockets: readonly ManualSocket[]): ManualSocket => {
  const socket = sockets.at(-1);
  if (!socket) throw new Error("no relay socket was opened");
  return socket;
};

/* ------------------------------------------------------- the production adapter's own fixtures */

/**
 * A stand-in for Node 22's `globalThis.WebSocket`.
 *
 * The rows below are the only ones that exercise `nativeRelaySocketFactory` — every other row
 * injects its own socket and therefore says nothing at all about the adapter. That gap is exactly
 * where an abandoned native connection can live: the wrapper's reference is dropped, a reconnect
 * is scheduled, and the real socket stays open with its listeners still attached.
 *
 * So this fake counts the two things the wrapper cannot fake away — how many times `close()` was
 * called on the underlying socket, and how many listeners are still registered on it — and hands
 * back the listener functions themselves, so a row can call a *stale* one after retirement.
 */
interface FakeWebSocketRecord {
  url: string;
  sent: string[];
  closeCalls: number;
  listenerCount: () => number;
  emit: (type: string, event?: { data?: unknown }) => void;
  /** The listener functions as they were registered, kept even after they are removed. */
  captured: (type: string) => ((event: { data?: unknown }) => void)[];
}

const installFakeWebSocket = (): { sockets: FakeWebSocketRecord[]; restore: () => void } => {
  const sockets: FakeWebSocketRecord[] = [];
  type Listener = (event: { data?: unknown }) => void;

  class FakeWebSocket {
    readonly #live = new Map<string, Listener[]>();
    readonly #everRegistered = new Map<string, Listener[]>();
    readonly #record: FakeWebSocketRecord;

    constructor(url: string) {
      this.#record = {
        url,
        sent: [],
        closeCalls: 0,
        listenerCount: () => [...this.#live.values()].reduce((total, list) => total + list.length, 0),
        emit: (type, event) => {
          for (const listener of [...(this.#live.get(type) ?? [])]) listener(event ?? {});
        },
        captured: (type) => [...(this.#everRegistered.get(type) ?? [])],
      };
      sockets.push(this.#record);
    }

    send(data: string): void {
      this.#record.sent.push(data);
    }

    close(): void {
      this.#record.closeCalls += 1;
    }

    addEventListener(type: string, listener: Listener): void {
      this.#live.set(type, [...(this.#live.get(type) ?? []), listener]);
      this.#everRegistered.set(type, [...(this.#everRegistered.get(type) ?? []), listener]);
    }

    removeEventListener(type: string, listener: Listener): void {
      this.#live.set(
        type,
        (this.#live.get(type) ?? []).filter((registered) => registered !== listener),
      );
    }
  }

  const previous = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  Object.defineProperty(globalThis, "WebSocket", {
    value: FakeWebSocket,
    configurable: true,
    writable: true,
  });
  return {
    sockets,
    restore: () => {
      if (previous) Object.defineProperty(globalThis, "WebSocket", previous);
      else delete (globalThis as { WebSocket?: unknown }).WebSocket;
    },
  };
};

/**
 * A sink whose answer the row decides, later.
 *
 * The whole class of defect below lives *inside* `await sink.admit(...)`: the connection the frame
 * arrived on can be retired and replaced while that promise is outstanding. A sink that answers
 * immediately cannot produce that window at all, which is why every row above is silent about it.
 */
interface DeferredSink extends BuzzMentionSink {
  admitted: string[];
  entered: () => boolean;
  resolve: (answer: BuzzMentionAdmission) => void;
  reject: (message: string) => void;
}

const deferredSink = (): DeferredSink => {
  let settle: ((answer: BuzzMentionAdmission) => void) | null = null;
  let fail: ((error: Error) => void) | null = null;
  const sink: DeferredSink = {
    admitted: [],
    entered: () => settle !== null,
    admit: (request) => {
      sink.admitted.push(request.event.id);
      return new Promise<BuzzMentionAdmission>((resolveAdmit, rejectAdmit) => {
        settle = resolveAdmit;
        fail = rejectAdmit;
      });
    },
    resolve: (answer) => {
      const settleNow = settle;
      settle = null;
      fail = null;
      settleNow?.(answer);
    },
    reject: (message) => {
      const failNow = fail;
      settle = null;
      fail = null;
      failNow?.(new Error(message));
    },
  };
  return sink;
};

/** Drains the microtask queue far enough for a handler to reach its first real `await`. */
const flushMicrotasks = async (): Promise<void> => {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
};

/** A subscriber on the **production** adapter: no `openSocket` is injected, only the clock. */
const startOnNativeAdapter = <T extends BuzzMentionSink>(
  sink: T = recordingSink("DURABLE") as unknown as T,
): {
  owner: Identity;
  identity: Identity;
  sink: T;
  clock: VirtualClock;
  handle: BuzzMentionSubscriberHandle;
} => {
  const stateDir = tempDir("acp-buzz-native-");
  const keys = tempDir("acp-buzz-native-keys-");
  const identity = hexIdentity(keys, "cto.key");
  const owner = hexIdentity(keys, "owner.key");
  writeConfig(stateDir, configFor([{ keyFile: identity.keyFile, encoding: "hex" }]));
  const clock = virtualClock();
  const handle = startBuzzMentionSubscriberFromStateDir(stateDir, {
    registry: registryHolding({
      [identity.pubkey]: { roleKey: ROLE_KEY, buzzActorId: identity.pubkey },
    }),
    sink,
    scheduler: clock.scheduler,
  });
  return { owner, identity, sink, clock, handle };
};

/** NIP-42 over the fake native socket; answers with the subscription id the relay must use. */
const authenticateNative = async (
  socket: FakeWebSocketRecord,
  handle: BuzzMentionSubscriberHandle,
): Promise<string> => {
  socket.emit("message", { data: frame(["AUTH", "native-challenge"]) });
  await handle.settled();
  const auth = JSON.parse(socket.sent.at(-1) ?? "[]") as [string, { id: string }];
  expect(auth[0]).toBe("AUTH");
  socket.emit("message", { data: frame(["OK", auth[1].id, true, ""]) });
  await handle.settled();
  const req = socket.sent.map((raw) => JSON.parse(raw) as unknown[]).find((sent) => sent[0] === "REQ");
  if (!req) throw new Error("the subscriber sent no REQ over the native adapter");
  return req[1] as string;
};

/* ====================================================================== production adapter rows */

describe("the buzz mention subscriber's native WebSocket adapter", () => {
  /**
   * The whole of the defect this row exists for: a binary frame and an error both mean "this
   * connection is over", and both used to tell the subscriber so **without closing the socket**.
   * The wrapper's reference was dropped, a reconnect was scheduled, and the real connection stayed
   * open with four live listeners — so a replacement could coexist with an abandoned peer that
   * could still deliver into shared state.
   */
  it("closes the underlying socket exactly once on a binary frame, and once on an error", async () => {
    const fake = installFakeWebSocket();
    try {
      const { handle, clock } = startOnNativeAdapter();
      try {
        expect(fake.sockets).toHaveLength(1);
        const first = fake.sockets[0]!;
        expect(first.listenerCount()).toBe(4);

        // A binary frame is not a Nostr message. It retires the connection.
        first.emit("message", { data: new Uint8Array([1, 2, 3]) });
        await handle.settled();
        expect(first.closeCalls).toBe(1);
        expect(first.listenerCount()).toBe(0);
        expect(clock.pending()).toBe(1);

        // Idempotent: a second binary frame through what is left of it changes nothing, and does
        // not schedule a second reconnect.
        first.emit("message", { data: new Uint8Array([4]) });
        expect(first.closeCalls).toBe(1);
        expect(clock.pending()).toBe(1);

        clock.fireAll();
        expect(fake.sockets).toHaveLength(2);
        const second = fake.sockets[1]!;
        // Exactly one live connection. The abandoned one is closed and deaf.
        expect(second.listenerCount()).toBe(4);
        expect(first.listenerCount()).toBe(0);
        expect(first.closeCalls).toBe(1);

        second.emit("error");
        await handle.settled();
        expect(second.closeCalls).toBe(1);
        expect(second.listenerCount()).toBe(0);
        expect(clock.pending()).toBe(1);
      } finally {
        handle.close();
      }
    } finally {
      fake.restore();
    }
  });

  /**
   * Retiring the listeners is not enough on its own.
   *
   * A frame that was already on the queue when its connection was retired has passed the point
   * where removing a listener helps — it is going to run, and without a fence it would run against
   * whatever connection happens to be current by then. So the connection has a generation, and a
   * frame carries the generation it arrived on.
   */
  it("lets neither a captured stale listener nor an already-queued stale frame reach the replacement", async () => {
    const fake = installFakeWebSocket();
    try {
      const { handle, clock, sink, identity, owner } = startOnNativeAdapter(recordingSink("DURABLE"));
      try {
        const first = fake.sockets[0]!;
        const subId = await authenticateNative(first, handle);
        const staleMessage = first.captured("message");
        const staleOpen = first.captured("open");
        expect(staleMessage).toHaveLength(1);
        expect(staleOpen).toHaveLength(1);

        const event = mentionEvent({
          author: owner.secretKey,
          addressedTo: identity.pubkey,
          createdAt: 1_800_009_000,
        });

        // In flight: three frames are handed over and the connection dies before the queue drains.
        //
        // The `EVENT` is the weakest of the three and is here only for completeness: `#onEvent`
        // refuses it for being unsubscribed anyway, because the queue is serial and a
        // replacement's own AUTH can never overtake a frame already ahead of it. Measured — with
        // the generation fence deleted this line still passes, so it is not what proves the fence.
        //
        // The other two are. A stale `AUTH` reaches `this.#socket?.send`, which by then is the
        // *replacement's* socket, so without the fence the new connection is handed an AUTH it
        // was never challenged for. A stale malformed frame reaches `#reconnect()`, which tears
        // down the replacement and opens a third socket. Neither goes anywhere near `#subscribed`.
        first.emit("message", { data: frame(["EVENT", subId, event]) });
        first.emit("message", { data: frame(["AUTH", "stale-queued-challenge"]) });
        first.emit("message", { data: "}{" });
        first.emit("error");
        clock.fireAll();
        const second = fake.sockets[1]!;
        await handle.settled();

        // Every one of the three belonged to a connection that no longer exists.
        expect(sink.admitted).toEqual([]);
        expect(second.sent).toEqual([]);
        // The replacement was not torn down by the stale malformed frame, and no third socket
        // was opened behind it.
        expect(second.closeCalls).toBe(0);
        expect(second.listenerCount()).toBe(4);
        expect(fake.sockets).toHaveLength(2);
        expect(clock.pending()).toBe(0);

        // And the listener objects a leak would have left behind are inert in both directions:
        // they neither admit, nor write to the socket they came from, nor to the replacement.
        for (const listener of staleMessage) {
          listener({ data: frame(["EVENT", subId, event]) });
          listener({ data: frame(["AUTH", "stale-challenge"]) });
        }
        for (const listener of staleOpen) listener({});
        await handle.settled();
        expect(sink.admitted).toEqual([]);
        expect(second.sent).toEqual([]);
        expect(first.sent.filter((raw) => raw.includes("stale-challenge"))).toEqual([]);
        expect(first.closeCalls).toBe(1);

        // The replacement is untouched and still works: it authenticates and admits normally.
        const resumed = await authenticateNative(second, handle);
        second.emit("message", { data: frame(["EVENT", resumed, event]) });
        await handle.settled();
        expect(sink.admitted.map((entry) => entry.eventId)).toEqual([event.id]);
      } finally {
        handle.close();
      }
    } finally {
      fake.restore();
    }
  });

  /**
   * The window a fence checked once cannot cover.
   *
   * `onFrame`'s fence runs when the frame reaches the front of the queue. `#handleFrame` then
   * *suspends* on the sink. Everything the continuation does afterwards — reconnecting, advancing
   * the mark, sending — happens on the far side of an `await`, by which time the connection it
   * belongs to may be closed and replaced. Passing a fence does not entitle a continuation to act
   * on state that moved while it was suspended.
   *
   * Both rows drive the **production** adapter, because the destroyed object is the replacement's
   * real socket, and a fake wrapper would not show that its listeners went with it.
   */
  const STALE_TAILS: readonly { what: string; settle: (sink: DeferredSink) => void }[] = [
    { what: "answers RETRY", settle: (sink) => sink.resolve("RETRY") },
    { what: "rejects", settle: (sink) => sink.reject("the seam threw after the connection died") },
  ];

  for (const tail of STALE_TAILS) {
    it(`does not let an admission that ${tail.what} after its connection was replaced touch the replacement`, async () => {
      const fake = installFakeWebSocket();
      try {
        const { handle, clock, sink, identity, owner } = startOnNativeAdapter(deferredSink());
        try {
          const first = fake.sockets[0]!;
          const subId = await authenticateNative(first, handle);
          const event = mentionEvent({
            author: owner.secretKey,
            addressedTo: identity.pubkey,
            createdAt: 1_800_020_000,
          });

          // 1. The admission starts and is held open.
          first.emit("message", { data: frame(["EVENT", subId, event]) });
          await flushMicrotasks();
          expect(sink.entered()).toBe(true);
          expect(sink.admitted).toEqual([event.id]);

          // 2. Its connection dies underneath it, and 3. the replacement opens.
          first.emit("error");
          expect(first.closeCalls).toBe(1);
          clock.fireAll();
          const second = fake.sockets[1]!;
          expect(second.listenerCount()).toBe(4);
          expect(second.closeCalls).toBe(0);

          // 4. Only now does the predecessor's tail run.
          tail.settle(sink);
          await handle.settled();

          // The replacement is untouched: still open, still listening, no reconnect scheduled
          // behind it, and no third socket where a stale `#reconnect()` would have left one.
          expect(second.closeCalls).toBe(0);
          expect(second.listenerCount()).toBe(4);
          expect(clock.pending()).toBe(0);
          expect(fake.sockets).toHaveLength(2);
          expect(second.sent).toEqual([]);

          // And it still works, which is what says the row measured a stale tail rather than a
          // subscriber that had simply stopped doing anything.
          const resumed = await authenticateNative(second, handle);
          const next = mentionEvent({
            author: owner.secretKey,
            addressedTo: identity.pubkey,
            text: "교체된 연결로",
            createdAt: 1_800_020_500,
          });
          second.emit("message", { data: frame(["EVENT", resumed, next]) });
          await flushMicrotasks();
          expect(sink.entered()).toBe(true);
          sink.resolve("DURABLE");
          await handle.settled();
          expect(sink.admitted).toEqual([event.id, next.id]);
        } finally {
          handle.close();
        }

        // The close is complete even after all of that.
        expect(clock.pending()).toBe(0);
        for (const socket of fake.sockets) expect(socket.listenerCount()).toBe(0);
      } finally {
        fake.restore();
      }
    });
  }

  /**
   * The other thing a stale continuation must not do.
   *
   * `RETRY` and a rejection both leave the mark alone even when they are *current*, so neither row
   * above can say anything about a stale `since` advance — asserting it there would be an
   * assertion that passes for a reason unrelated to the fence. A stale `DURABLE` is the answer
   * that does advance it, so that is where the claim belongs.
   */
  it("does not advance the mark from an admission whose connection was already replaced", async () => {
    const fake = installFakeWebSocket();
    try {
      const { handle, clock, sink, identity, owner } = startOnNativeAdapter(deferredSink());
      try {
        const first = fake.sockets[0]!;
        const subId = await authenticateNative(first, handle);
        first.emit("message", {
          data: frame([
            "EVENT",
            subId,
            mentionEvent({
              author: owner.secretKey,
              addressedTo: identity.pubkey,
              createdAt: 1_800_030_000,
            }),
          ]),
        });
        await flushMicrotasks();
        expect(sink.entered()).toBe(true);

        first.emit("error");
        clock.fireAll();
        const second = fake.sockets[1]!;

        // Durable — but for a connection that no longer exists. The mark belongs to the live
        // connection's request window, and this answer is not evidence about that window.
        sink.resolve("DURABLE");
        await handle.settled();

        await authenticateNative(second, handle);
        const req = second.sent
          .map((raw) => JSON.parse(raw) as unknown[])
          .find((sent) => sent[0] === "REQ") as [string, string, Record<string, unknown>];
        expect(req[2]["since"]).toBeUndefined();
        expect(Object.keys(req[2])).toEqual(["kinds", "#p"]);
      } finally {
        handle.close();
      }
    } finally {
      fake.restore();
    }
  });

  it("leaves zero listeners, zero timers and zero live connections when it is closed", async () => {
    const fake = installFakeWebSocket();
    try {
      const { handle, clock } = startOnNativeAdapter();
      const first = fake.sockets[0]!;
      await authenticateNative(first, handle);
      first.emit("error");
      clock.fireAll();
      const second = fake.sockets[1]!;
      await authenticateNative(second, handle);

      handle.close();
      expect(clock.pending()).toBe(0);
      for (const socket of fake.sockets) {
        expect(socket.listenerCount()).toBe(0);
        // Each was closed exactly once: the first by its error, the second by this close. An
        // explicit close must not notify, so it must not have scheduled a reconnect either.
        expect(socket.closeCalls).toBe(1);
      }
      expect(fake.sockets).toHaveLength(2);

      // Nothing can wake it afterwards.
      second.emit("close");
      second.emit("error");
      expect(clock.pending()).toBe(0);
      expect(fake.sockets).toHaveLength(2);
      expect(second.closeCalls).toBe(1);
    } finally {
      fake.restore();
    }
  });
});

/* ================================================================================= config rows */

describe("the buzz mention subscriber's config authority", () => {
  it("is disabled, with no socket, when the file is absent", () => {
    const stateDir = tempDir("acp-buzz-sub-absent-");
    const transport = manualTransport();
    const handle = startBuzzMentionSubscriberFromStateDir(stateDir, {
      registry: registryHolding({}),
      sink: recordingSink(),
      openSocket: transport.factory,
      scheduler: virtualClock().scheduler,
    });
    expect(handle.socketCount).toBe(0);
    expect(handle.relayUrl).toBeNull();
    expect(handle.roleKeys).toEqual([]);
    expect(transport.sockets).toEqual([]);
  });

  /**
   * Every one of these is a file an operator could plausibly write, and every one has to open
   * **zero** sockets — not "fewer", not "the good ones". A partial start is the outcome that reads
   * as success in a log and is the one this table exists to make impossible.
   */
  const REFUSED_CONFIGS: readonly { what: string; text: string; matches: RegExp }[] = [
    { what: "not JSON at all", text: "{", matches: /is not JSON/u },
    { what: "a JSON array", text: "[]", matches: /must be a JSON object/u },
    {
      what: "an unknown root field beside the real ones",
      text: JSON.stringify({ relayUrl: RELAY, identities: [], relayURL: RELAY }),
      matches: /unknown field\(s\): relayURL/u,
    },
    {
      what: "no identities key at all",
      text: JSON.stringify({ relayUrl: RELAY }),
      matches: /missing required field\(s\): identities/u,
    },
    {
      what: "an empty identity list",
      text: JSON.stringify({ relayUrl: RELAY, identities: [] }),
      matches: /identities must be a non-empty array/u,
    },
    {
      what: "a ws relay rather than wss",
      text: JSON.stringify({ relayUrl: "ws://relay.example.invalid", identities: [] }),
      matches: /must use the wss scheme/u,
    },
    {
      what: "an http relay",
      text: JSON.stringify({ relayUrl: "https://relay.example.invalid", identities: [] }),
      matches: /must use the wss scheme/u,
    },
    {
      what: "a credential smuggled into the relay url",
      text: JSON.stringify({ relayUrl: "wss://user:pass@relay.example.invalid", identities: [] }),
      matches: /must carry no credentials/u,
    },
    {
      what: "a fragment on the relay url",
      text: JSON.stringify({ relayUrl: `${RELAY}#token`, identities: [] }),
      matches: /must carry no fragment/u,
    },
    {
      what: "a relative key path",
      text: JSON.stringify({
        relayUrl: RELAY,
        identities: [{ privateKeyFile: "keys/cto.key", encoding: "hex" }],
      }),
      matches: /absolute normalized path/u,
    },
    {
      what: "a key path that has not been normalized",
      text: JSON.stringify({
        relayUrl: RELAY,
        identities: [{ privateKeyFile: "/tmp/keys/../keys/cto.key", encoding: "hex" }],
      }),
      matches: /absolute normalized path/u,
    },
    {
      what: "an identity with no declared encoding",
      text: JSON.stringify({
        relayUrl: RELAY,
        identities: [{ privateKeyFile: "/tmp/cto.key" }],
      }),
      matches: /missing required field\(s\): encoding/u,
    },
    {
      what: "an encoding this build cannot read",
      text: JSON.stringify({
        relayUrl: RELAY,
        identities: [{ privateKeyFile: "/tmp/cto.key", encoding: "base64" }],
      }),
      matches: /encoding must be one of/u,
    },
    {
      what: "an unknown field on an identity",
      text: JSON.stringify({
        relayUrl: RELAY,
        identities: [{ privateKeyFile: "/tmp/cto.key", encoding: "hex", role: "PRIMARY_CTO" }],
      }),
      matches: /unknown field\(s\): role/u,
    },
  ];

  for (const row of REFUSED_CONFIGS) {
    it(`refuses ${row.what}, and opens no socket`, () => {
      const stateDir = tempDir("acp-buzz-sub-bad-");
      writeConfig(stateDir, row.text);
      const transport = manualTransport();
      expect(() =>
        startBuzzMentionSubscriberFromStateDir(stateDir, {
          registry: registryHolding({}),
          sink: recordingSink(),
          openSocket: transport.factory,
          scheduler: virtualClock().scheduler,
        }),
      ).toThrow(row.matches);
      expect(transport.sockets).toEqual([]);
    });
  }

  it("accepts both declared key encodings and derives the same address for each", () => {
    const keys = tempDir("acp-buzz-keys-enc-");
    const hex = hexIdentity(keys, "hex.key");
    const nsec = nsecIdentity(keys, "nsec.key");
    for (const identity of [
      { identity: hex, encoding: "hex" },
      { identity: nsec, encoding: "nsec" },
    ]) {
      const stateDir = tempDir("acp-buzz-sub-enc-");
      writeConfig(
        stateDir,
        configFor([{ keyFile: identity.identity.keyFile, encoding: identity.encoding }]),
      );
      const transport = manualTransport();
      const handle = startBuzzMentionSubscriberFromStateDir(stateDir, {
        registry: registryHolding({
          [identity.identity.pubkey]: {
            roleKey: ROLE_KEY,
            buzzActorId: identity.identity.pubkey,
          },
        }),
        sink: recordingSink(),
        openSocket: transport.factory,
        scheduler: virtualClock().scheduler,
      });
      expect(handle.socketCount).toBe(1);
      expect(handle.roleKeys).toEqual([ROLE_KEY]);
      handle.close();
    }
  });

  /**
   * The key file's own properties, and the preflight the registry answers.
   *
   * Each row leaves the config itself valid and breaks exactly one thing, so a row that went green
   * after its check was deleted would be the only one that did.
   */
  it("refuses a symlinked key file without following it", () => {
    const keys = tempDir("acp-buzz-keys-link-");
    const identity = hexIdentity(keys, "real.key");
    const link = join(keys, "linked.key");
    symlinkSync(identity.keyFile, link);
    const stateDir = tempDir("acp-buzz-sub-link-");
    writeConfig(stateDir, configFor([{ keyFile: link, encoding: "hex" }]));
    const transport = manualTransport();
    expect(() =>
      startBuzzMentionSubscriberFromStateDir(stateDir, {
        registry: registryHolding({
          [identity.pubkey]: { roleKey: ROLE_KEY, buzzActorId: identity.pubkey },
        }),
        sink: recordingSink(),
        openSocket: transport.factory,
        scheduler: virtualClock().scheduler,
      }),
    ).toThrow(/without following a symlink/u);
    expect(transport.sockets).toEqual([]);
  });

  it("refuses a key file anyone but its owner can read", () => {
    const keys = tempDir("acp-buzz-keys-mode-");
    const identity = hexIdentity(keys, "loose.key");
    chmodSync(identity.keyFile, 0o644);
    const stateDir = tempDir("acp-buzz-sub-mode-");
    writeConfig(stateDir, configFor([{ keyFile: identity.keyFile, encoding: "hex" }]));
    const transport = manualTransport();
    expect(() =>
      startBuzzMentionSubscriberFromStateDir(stateDir, {
        registry: registryHolding({
          [identity.pubkey]: { roleKey: ROLE_KEY, buzzActorId: identity.pubkey },
        }),
        sink: recordingSink(),
        openSocket: transport.factory,
        scheduler: virtualClock().scheduler,
      }),
    ).toThrow(/readable beyond its owner/u);
    expect(transport.sockets).toEqual([]);
  });

  it("refuses a directory where a key file was declared", () => {
    const keys = tempDir("acp-buzz-keys-dir-");
    const asDirectory = join(keys, "keydir");
    mkdirSync(asDirectory, { mode: 0o700 });
    const stateDir = tempDir("acp-buzz-sub-dir-");
    writeConfig(stateDir, configFor([{ keyFile: asDirectory, encoding: "hex" }]));
    const transport = manualTransport();
    expect(() =>
      startBuzzMentionSubscriberFromStateDir(stateDir, {
        registry: registryHolding({}),
        sink: recordingSink(),
        openSocket: transport.factory,
        scheduler: virtualClock().scheduler,
      }),
    ).toThrow(/not a regular file|could not be opened/u);
    expect(transport.sockets).toEqual([]);
  });

  it("refuses two identities that name the same key path", () => {
    const keys = tempDir("acp-buzz-keys-dup-path-");
    const identity = hexIdentity(keys, "cto.key");
    const stateDir = tempDir("acp-buzz-sub-dup-path-");
    writeConfig(
      stateDir,
      configFor([
        { keyFile: identity.keyFile, encoding: "hex" },
        { keyFile: identity.keyFile, encoding: "hex" },
      ]),
    );
    const transport = manualTransport();
    expect(() =>
      startBuzzMentionSubscriberFromStateDir(stateDir, {
        registry: registryHolding({
          [identity.pubkey]: { roleKey: ROLE_KEY, buzzActorId: identity.pubkey },
        }),
        sink: recordingSink(),
        openSocket: transport.factory,
        scheduler: virtualClock().scheduler,
      }),
    ).toThrow(/names a key file another identity already names/u);
    expect(transport.sockets).toEqual([]);
  });

  /**
   * Two paths, one file. The path check above cannot see this and the inode check is the only
   * thing that can: a hard link is how one key comes to be configured twice without anything
   * looking duplicated.
   */
  it("refuses two identities that are two names for one key file", () => {
    const keys = tempDir("acp-buzz-keys-dup-inode-");
    const identity = hexIdentity(keys, "cto.key");
    const second = join(keys, "cto-again.key");
    linkSync(identity.keyFile, second);
    const stateDir = tempDir("acp-buzz-sub-dup-inode-");
    writeConfig(
      stateDir,
      configFor([
        { keyFile: identity.keyFile, encoding: "hex" },
        { keyFile: second, encoding: "hex" },
      ]),
    );
    const transport = manualTransport();
    expect(() =>
      startBuzzMentionSubscriberFromStateDir(stateDir, {
        registry: registryHolding({
          [identity.pubkey]: { roleKey: ROLE_KEY, buzzActorId: identity.pubkey },
        }),
        sink: recordingSink(),
        openSocket: transport.factory,
        scheduler: virtualClock().scheduler,
      }),
    ).toThrow(/the same file as another identity's/u);
    expect(transport.sockets).toEqual([]);
  });

  /** Two different files carrying one secret: distinct paths, distinct inodes, one address. */
  it("refuses two identities that derive one channel identity", () => {
    const keys = tempDir("acp-buzz-keys-dup-pubkey-");
    const identity = hexIdentity(keys, "cto.key");
    const copy = keyFileIn(keys, "cto-copy.key", `${asHex(identity.secretKey)}\n`);
    const stateDir = tempDir("acp-buzz-sub-dup-pubkey-");
    writeConfig(
      stateDir,
      configFor([
        { keyFile: identity.keyFile, encoding: "hex" },
        { keyFile: copy, encoding: "hex" },
      ]),
    );
    const transport = manualTransport();
    expect(() =>
      startBuzzMentionSubscriberFromStateDir(stateDir, {
        registry: registryHolding({
          [identity.pubkey]: { roleKey: ROLE_KEY, buzzActorId: identity.pubkey },
        }),
        sink: recordingSink(),
        openSocket: transport.factory,
        scheduler: virtualClock().scheduler,
      }),
    ).toThrow(/derives a channel identity another identity already derives/u);
    expect(transport.sockets).toEqual([]);
  });

  it("refuses two identities that resolve to one role", () => {
    const keys = tempDir("acp-buzz-keys-dup-role-");
    const first = hexIdentity(keys, "a.key");
    const second = hexIdentity(keys, "b.key");
    const stateDir = tempDir("acp-buzz-sub-dup-role-");
    writeConfig(
      stateDir,
      configFor([
        { keyFile: first.keyFile, encoding: "hex" },
        { keyFile: second.keyFile, encoding: "hex" },
      ]),
    );
    const transport = manualTransport();
    expect(() =>
      startBuzzMentionSubscriberFromStateDir(stateDir, {
        registry: registryHolding({
          [first.pubkey]: { roleKey: ROLE_KEY, buzzActorId: first.pubkey },
          [second.pubkey]: { roleKey: ROLE_KEY, buzzActorId: second.pubkey },
        }),
        sink: recordingSink(),
        openSocket: transport.factory,
        scheduler: virtualClock().scheduler,
      }),
    ).toThrow(/holds a role another identity already holds/u);
    expect(transport.sockets).toEqual([]);
  });

  it("refuses an identity that holds no live PRIMARY_CTO binding, and opens no socket for its sibling", () => {
    const keys = tempDir("acp-buzz-keys-unbound-");
    const bound = hexIdentity(keys, "bound.key");
    const unbound = hexIdentity(keys, "unbound.key");
    const stateDir = tempDir("acp-buzz-sub-unbound-");
    writeConfig(
      stateDir,
      configFor([
        { keyFile: bound.keyFile, encoding: "hex" },
        { keyFile: unbound.keyFile, encoding: "hex" },
      ]),
    );
    const transport = manualTransport();
    expect(() =>
      startBuzzMentionSubscriberFromStateDir(stateDir, {
        registry: registryHolding({
          [bound.pubkey]: { roleKey: ROLE_KEY, buzzActorId: bound.pubkey },
        }),
        sink: recordingSink(),
        openSocket: transport.factory,
        scheduler: virtualClock().scheduler,
      }),
    ).toThrow(/does not currently hold a live PRIMARY_CTO binding/u);
    // The whole of the "before socket 1" requirement: the first identity was perfectly good and
    // still opened nothing, because the pass had not finished.
    expect(transport.sockets).toEqual([]);
  });

  it("refuses an identity whose session is bound to a different channel identity", () => {
    const keys = tempDir("acp-buzz-keys-mismatch-");
    const identity = hexIdentity(keys, "cto.key");
    const other = hexIdentity(keys, "other.key");
    const stateDir = tempDir("acp-buzz-sub-mismatch-");
    writeConfig(stateDir, configFor([{ keyFile: identity.keyFile, encoding: "hex" }]));
    const transport = manualTransport();
    expect(() =>
      startBuzzMentionSubscriberFromStateDir(stateDir, {
        registry: registryHolding({
          [identity.pubkey]: { roleKey: ROLE_KEY, buzzActorId: other.pubkey },
        }),
        sink: recordingSink(),
        openSocket: transport.factory,
        scheduler: virtualClock().scheduler,
      }),
    ).toThrow(/bound to a different channel identity/u);
    expect(transport.sockets).toEqual([]);
  });

  /**
   * The one thing a config error must never say.
   *
   * These messages reach stderr and, on this deployment, a log an operator pastes into a room. A
   * key path is where a key is, and this file is the only thing that knows both the path and the
   * bytes; naming either is how a secret leaves a 0600 file.
   */
  it("names no key path and no key material in anything it refuses", () => {
    const keys = tempDir("acp-buzz-keys-quiet-");
    const identity = hexIdentity(keys, "secret-place.key");
    chmodSync(identity.keyFile, 0o644);
    const stateDir = tempDir("acp-buzz-sub-quiet-");
    writeConfig(stateDir, configFor([{ keyFile: identity.keyFile, encoding: "hex" }]));
    let message = "";
    try {
      startBuzzMentionSubscriberFromStateDir(stateDir, {
        registry: registryHolding({
          [identity.pubkey]: { roleKey: ROLE_KEY, buzzActorId: identity.pubkey },
        }),
        sink: recordingSink(),
        openSocket: manualTransport().factory,
        scheduler: virtualClock().scheduler,
      });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).not.toBe("");
    expect(message).not.toContain(identity.keyFile);
    expect(message).not.toContain("secret-place");
    expect(message).not.toContain(asHex(identity.secretKey));
    expect(message).toContain("identities[0]");
  });

  it("reads the relay url only from the file, with no environment fallback", () => {
    // Stated as a property of the parser rather than of a process: there is no code path that
    // consults the environment, so the only way to name a relay is the field below.
    expect(() => parseBuzzSubscriberConfig(JSON.stringify({ identities: [] }))).toThrow(
      /missing required field\(s\): relayUrl/u,
    );
    expect(
      parseBuzzSubscriberConfig(
        JSON.stringify({
          relayUrl: "wss://a.invalid",
          identities: [{ privateKeyFile: "/tmp/cto.key", encoding: "hex" }],
        }),
      ).relayUrl,
    ).toBe("wss://a.invalid");
  });
});

/* =============================================================================== protocol rows */

describe("the buzz mention subscriber's relay protocol", () => {
  it("opens one socket per identity, on the configured relay, and requests nothing before AUTH", () => {
    const { sockets, handle } = startOne({});
    try {
      expect(handle.socketCount).toBe(1);
      expect(sockets).toHaveLength(1);
      expect(live(sockets).url).toBe(RELAY);
      expect(live(sockets).sent).toEqual([]);
    } finally {
      handle.close();
    }
  });

  it("answers the NIP-42 challenge with a signed auth event, then asks for exactly kind 9 addressed to itself", async () => {
    const { sockets, handle, identity } = startOne({});
    try {
      const socket = live(sockets);
      socket.handlers.onFrame(frame(["AUTH", "challenge-0001"]));
      await handle.settled();
      const auth = sentFrames(socket)[0] as [string, Record<string, unknown>];
      expect(auth[0]).toBe("AUTH");
      expect(auth[1]["pubkey"]).toBe(identity.pubkey);
      expect(auth[1]["kind"]).toBe(22242);
      expect(JSON.stringify(auth[1]["tags"])).toContain("challenge-0001");
      // Still nothing requested: the assertion has been made and not yet accepted.
      expect(socket.sent).toHaveLength(1);

      socket.handlers.onFrame(frame(["OK", auth[1]["id"], true, ""]));
      await handle.settled();
      const req = sentFrames(socket)[1] as [string, string, Record<string, unknown>];
      expect(req[0]).toBe("REQ");
      expect(req[2]).toEqual({ kinds: [BUZZ_MENTION_KIND], "#p": [identity.pubkey] });
      // No `since` on a first connection: there is no durable cursor to read one from.
      expect(Object.keys(req[2])).toEqual(["kinds", "#p"]);
    } finally {
      handle.close();
    }
  });

  it("requests nothing and reconnects when the relay refuses the auth event", async () => {
    const { sockets, handle, clock } = startOne({});
    try {
      const socket = live(sockets);
      await authenticate(socket, handle, false);
      expect(sentFrames(socket).map((sent) => sent[0])).toEqual(["AUTH"]);
      expect(socket.closed).toBe(true);
      expect(clock.delays).toEqual([RELAY_RECONNECT_BACKOFF_MS[0]]);
    } finally {
      handle.close();
    }
  });

  it("delivers a valid mention to the sink, deep-frozen, with its room and its role", async () => {
    const { sockets, handle, identity, owner, sink } = startOne({});
    try {
      const socket = live(sockets);
      await authenticate(socket, handle);
      const event = mentionEvent({ author: owner.secretKey, addressedTo: identity.pubkey });
      socket.handlers.onFrame(frame(["EVENT", (sentFrames(socket)[1] as string[])[1], event]));
      await handle.settled();

      expect(sink.admitted).toEqual([
        {
          eventId: event.id,
          text: "CTO, 지금 상태 보고해줘",
          conversation: ROOM,
          roleKey: ROLE_KEY,
        },
      ]);
      // Frozen all the way down. A sink that could rewrite `content` after `verifyEvent` returned
      // would hand the admission seam words no signature was checked against.
      const delivered = sink.frozen[0] as { content: string; tags: string[][] };
      expect(Object.isFrozen(delivered)).toBe(true);
      expect(Object.isFrozen(delivered.tags)).toBe(true);
      expect(Object.isFrozen(delivered.tags[0])).toBe(true);
      expect(() => {
        (delivered as { content: string }).content = "그만해";
      }).toThrow(TypeError);
      expect(delivered.content).toBe("CTO, 지금 상태 보고해줘");
      // Nothing was closed and nothing was retried: an accepted event is not a reason to reconnect.
      expect(socket.closed).toBe(false);
    } finally {
      handle.close();
    }
  });

  /**
   * Everything the relay can put on the wire that must not become a turn.
   *
   * Each row breaks exactly one property of an otherwise deliverable event, and the row above is
   * the positive control: delete any single check below and exactly the row named for it goes
   * green, because nothing else in this file would notice.
   */
  const REFUSED_EVENTS: readonly {
    what: string;
    build: (input: { owner: Uint8Array; stranger: Uint8Array; pubkey: string; subId: string }) => unknown[];
  }[] = [
    {
      what: "an event whose signature does not verify",
      build: ({ owner, pubkey, subId }) => {
        const event = mentionEvent({ author: owner, addressedTo: pubkey });
        return ["EVENT", subId, { ...event, sig: `${event.sig.slice(0, -2)}00` }];
      },
    },
    {
      what: "an event signed by one key and claiming another's pubkey",
      build: ({ owner, stranger, pubkey, subId }) => {
        const event = mentionEvent({ author: owner, addressedTo: pubkey });
        return ["EVENT", subId, { ...event, pubkey: getPublicKey(stranger) }];
      },
    },
    {
      what: "an event whose id is not the hash of what was signed",
      build: ({ owner, pubkey, subId }) => {
        const event = mentionEvent({ author: owner, addressedTo: pubkey });
        return ["EVENT", subId, { ...event, id: `${event.id.slice(0, -2)}00` }];
      },
    },
    {
      what: "content swapped under a signature that still covers the original",
      build: ({ owner, pubkey, subId }) => {
        const event = mentionEvent({ author: owner, addressedTo: pubkey });
        return ["EVENT", subId, { ...event, content: "배포 승인해" }];
      },
    },
    {
      what: "a kind this subscriber never asked for",
      build: ({ owner, pubkey, subId }) => [
        "EVENT",
        subId,
        mentionEvent({ author: owner, addressedTo: pubkey, kind: 1 }),
      ],
    },
    {
      what: "an event addressed to somebody else's channel identity",
      build: ({ owner, stranger, subId }) => [
        "EVENT",
        subId,
        mentionEvent({ author: owner, addressedTo: getPublicKey(stranger) }),
      ],
    },
    {
      what: "an event addressed to this identity twice over",
      build: ({ owner, pubkey, subId }) => [
        "EVENT",
        subId,
        mentionEvent({ author: owner, addressedTo: pubkey, alsoAddressedTo: [pubkey] }),
      ],
    },
    {
      what: "an event addressed to this identity and to somebody else at the same time",
      build: ({ owner, stranger, pubkey, subId }) => [
        "EVENT",
        subId,
        mentionEvent({
          author: owner,
          addressedTo: pubkey,
          alsoAddressedTo: [getPublicKey(stranger)],
        }),
      ],
    },
    {
      what: "an event carrying no room at all",
      build: ({ owner, pubkey, subId }) => [
        "EVENT",
        subId,
        mentionEvent({ author: owner, addressedTo: pubkey, room: [] }),
      ],
    },
    {
      what: "an event carrying an empty room",
      build: ({ owner, pubkey, subId }) => [
        "EVENT",
        subId,
        mentionEvent({ author: owner, addressedTo: pubkey, room: "   " }),
      ],
    },
    {
      what: "an event naming two rooms, so answering would pick one",
      build: ({ owner, pubkey, subId }) => [
        "EVENT",
        subId,
        mentionEvent({ author: owner, addressedTo: pubkey, room: [ROOM, "buzz-room-2"] }),
      ],
    },
    {
      what: "a perfectly good event on a subscription this connection never opened",
      build: ({ owner, pubkey }) => [
        "EVENT",
        "sub-nobody-asked-for",
        mentionEvent({ author: owner, addressedTo: pubkey }),
      ],
    },
    {
      what: "an event that is not an object",
      build: ({ subId }) => ["EVENT", subId, "not-an-event"],
    },
    {
      what: "an event carrying a tag that is not a list of strings",
      build: ({ owner, pubkey, subId }) => {
        const event = mentionEvent({ author: owner, addressedTo: pubkey });
        return ["EVENT", subId, { ...event, tags: [...event.tags, [1, 2]] }];
      },
    },
  ];

  for (const row of REFUSED_EVENTS) {
    it(`refuses ${row.what}`, async () => {
      const { sockets, handle, identity, owner, sink } = startOne({});
      const stranger = generateSecretKey();
      try {
        const socket = live(sockets);
        await authenticate(socket, handle);
        const subId = (sentFrames(socket)[1] as string[])[1] ?? "";
        socket.handlers.onFrame(
          frame(row.build({ owner: owner.secretKey, stranger, pubkey: identity.pubkey, subId })),
        );
        await handle.settled();
        expect(sink.admitted).toEqual([]);

        // And the connection survives it. A refused event is the relay behaving, not the socket
        // failing, and reconnecting on one would turn a single bad event into a permanent loop.
        const good = mentionEvent({ author: owner.secretKey, addressedTo: identity.pubkey });
        socket.handlers.onFrame(frame(["EVENT", subId, good]));
        await handle.settled();
        expect(sink.admitted.map((entry) => entry.eventId)).toEqual([good.id]);
      } finally {
        handle.close();
      }
    });
  }

  const REFUSED_FRAMES: readonly { what: string; raw: () => string }[] = [
    { what: "a frame that is not JSON", raw: () => "}{" },
    { what: "a frame that is not an array", raw: () => frame({ EVENT: true }) },
    { what: "a frame whose verb is not a string", raw: () => frame([9, "sub"]) },
    { what: "an AUTH frame with no challenge", raw: () => frame(["AUTH"]) },
    {
      what: "a frame larger than this subscriber will parse",
      raw: () => frame(["EVENT", "sub", "x".repeat(MAX_RELAY_FRAME_BYTES)]),
    },
  ];

  for (const row of REFUSED_FRAMES) {
    it(`drops the connection on ${row.what}`, async () => {
      const { sockets, handle, clock, sink } = startOne({});
      try {
        const socket = live(sockets);
        socket.handlers.onFrame(row.raw());
        await handle.settled();
        expect(sink.admitted).toEqual([]);
        expect(socket.closed).toBe(true);
        expect(clock.delays).toEqual([RELAY_RECONNECT_BACKOFF_MS[0]]);
      } finally {
        handle.close();
      }
    });
  }

  it("ignores relay chatter it has no opinion about", async () => {
    const { sockets, handle, clock, sink, owner, identity } = startOne({});
    try {
      const socket = live(sockets);
      await authenticate(socket, handle);
      socket.handlers.onFrame(frame(["NOTICE", "restarting soon"]));
      socket.handlers.onFrame(frame(["COUNT", "sub", { count: 3 }]));
      await handle.settled();
      expect(socket.closed).toBe(false);
      expect(clock.pending()).toBe(0);

      const subId = (sentFrames(socket)[1] as string[])[1] ?? "";
      const good = mentionEvent({ author: owner.secretKey, addressedTo: identity.pubkey });
      socket.handlers.onFrame(frame(["EVENT", subId, good]));
      await handle.settled();
      expect(sink.admitted).toHaveLength(1);
    } finally {
      handle.close();
    }
  });

  /**
   * The cursor, and the whole of what it is: an inclusive `since` this process holds in memory.
   *
   * Nothing durable is asserted here because nothing durable exists — that is the design. The
   * observable is the second connection's `REQ`, which is where a lost cursor would show up as a
   * request for the entire history rather than as a duplicate message.
   */
  it("carries an inclusive high-water mark into the reconnect, and never writes one down", async () => {
    const { sockets, handle, identity, owner, sink, clock, stateDir } = startOne({});
    try {
      const first = live(sockets);
      await authenticate(first, handle);
      const subId = (sentFrames(first)[1] as string[])[1] ?? "";
      const event = mentionEvent({
        author: owner.secretKey,
        addressedTo: identity.pubkey,
        createdAt: 1_800_000_500,
      });
      first.handlers.onFrame(frame(["EVENT", subId, event]));
      first.handlers.onFrame(frame(["EOSE", subId]));
      await handle.settled();
      expect(sink.admitted).toHaveLength(1);

      first.handlers.onClose();
      clock.fireAll();
      const second = live(sockets);
      expect(second).not.toBe(first);
      await authenticate(second, handle);
      const req = sentFrames(second)[1] as [string, string, Record<string, unknown>];
      // Inclusive: the event that set the mark is asked for again, and the admission seam is the
      // one authority that refuses it as a replay. A subscriber-side dedup here would be a second.
      expect(req[2]["since"]).toBe(1_800_000_500);

      // And the state directory holds exactly the file it was given, with no cursor beside it.
      expect(readdirSync(stateDir)).toEqual([BUZZ_SUBSCRIBER_CONFIG_FILENAME]);
    } finally {
      handle.close();
    }
  });

  it("does not advance the mark for a retryable admission, and drops the socket", async () => {
    const { sockets, handle, identity, owner, sink, clock } = startOne({ answer: "RETRY" });
    try {
      const first = live(sockets);
      await authenticate(first, handle);
      const subId = (sentFrames(first)[1] as string[])[1] ?? "";
      first.handlers.onFrame(
        frame([
          "EVENT",
          subId,
          mentionEvent({
            author: owner.secretKey,
            addressedTo: identity.pubkey,
            createdAt: 1_800_000_900,
          }),
        ]),
      );
      await handle.settled();
      expect(sink.admitted).toHaveLength(1);
      expect(first.closed).toBe(true);

      sink.answer = "DURABLE";
      clock.fireAll();
      const second = live(sockets);
      await authenticate(second, handle);
      const req = sentFrames(second)[1] as [string, string, Record<string, unknown>];
      // No `since` at all: nothing was ever established about this event, so the window is
      // exactly where it was before it arrived.
      expect(req[2]["since"]).toBeUndefined();
    } finally {
      handle.close();
    }
  });

  const ADVANCING: readonly BuzzMentionAdmission[] = ["DURABLE", "ALREADY_DURABLE", "TERMINAL"];
  for (const answer of ADVANCING) {
    it(`advances the mark on ${answer} and keeps the connection`, async () => {
      const { sockets, handle, identity, owner, clock } = startOne({ answer });
      try {
        const first = live(sockets);
        await authenticate(first, handle);
        const subId = (sentFrames(first)[1] as string[])[1] ?? "";
        first.handlers.onFrame(
          frame([
            "EVENT",
            subId,
            mentionEvent({
              author: owner.secretKey,
              addressedTo: identity.pubkey,
              createdAt: 1_800_001_234,
            }),
          ]),
        );
        await handle.settled();
        expect(first.closed).toBe(false);

        first.handlers.onClose();
        clock.fireAll();
        const second = live(sockets);
        await authenticate(second, handle);
        const req = sentFrames(second)[1] as [string, string, Record<string, unknown>];
        expect(req[2]["since"]).toBe(1_800_001_234);
      } finally {
        handle.close();
      }
    });
  }

  it("reconnects on one timer, backing off 1/2/4/8/16/30 and staying at 30", async () => {
    const { sockets, handle, clock } = startOne({});
    try {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        // One timer at a time, always: a second concurrent one is how a flap becomes a flood.
        expect(clock.pending()).toBeLessThanOrEqual(1);
        live(sockets).handlers.onClose();
        expect(clock.pending()).toBe(1);
        clock.fireAll();
      }
      expect(clock.delays).toEqual([
        1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000,
      ]);
      expect(sockets).toHaveLength(9);
    } finally {
      handle.close();
    }
  });

  it("resets the backoff once a connection has reached the end of stored events", async () => {
    const { sockets, handle, clock } = startOne({});
    try {
      live(sockets).handlers.onClose();
      clock.fireAll();
      live(sockets).handlers.onClose();
      clock.fireAll();
      expect(clock.delays).toEqual([1_000, 2_000]);

      const healthy = live(sockets);
      await authenticate(healthy, handle);
      healthy.handlers.onFrame(frame(["EOSE", (sentFrames(healthy)[1] as string[])[1]]));
      await handle.settled();

      healthy.handlers.onClose();
      expect(clock.delays).toEqual([1_000, 2_000, 1_000]);
    } finally {
      handle.close();
    }
  });

  it("treats a role that moved between the preflight and the event as a race, not a delivery", async () => {
    const stateDir = tempDir("acp-buzz-sub-moved-");
    const keys = tempDir("acp-buzz-keys-moved-");
    const identity = hexIdentity(keys, "cto.key");
    const owner = hexIdentity(keys, "owner.key");
    writeConfig(stateDir, configFor([{ keyFile: identity.keyFile, encoding: "hex" }]));
    const sink = recordingSink();
    const clock = virtualClock();
    const transport = manualTransport();
    let held: { roleKey: string; buzzActorId: string } | null = {
      roleKey: ROLE_KEY,
      buzzActorId: identity.pubkey,
    };
    const handle = startBuzzMentionSubscriberFromStateDir(stateDir, {
      registry: { primaryCtoBindingFor: () => held },
      sink,
      openSocket: transport.factory,
      scheduler: clock.scheduler,
    });
    try {
      const socket = live(transport.sockets);
      await authenticate(socket, handle);
      const subId = (sentFrames(socket)[1] as string[])[1] ?? "";

      // The binding goes after the preflight passed. Nothing about the event changed.
      held = null;
      socket.handlers.onFrame(
        frame([
          "EVENT",
          subId,
          mentionEvent({
            author: owner.secretKey,
            addressedTo: identity.pubkey,
            createdAt: 1_800_002_000,
          }),
        ]),
      );
      await handle.settled();
      expect(sink.admitted).toEqual([]);
      expect(socket.closed).toBe(true);

      // Nothing was established, so the window did not move.
      held = { roleKey: ROLE_KEY, buzzActorId: identity.pubkey };
      clock.fireAll();
      const second = live(transport.sockets);
      await authenticate(second, handle);
      expect((sentFrames(second)[1] as [string, string, Record<string, unknown>])[2]["since"]).toBeUndefined();
    } finally {
      handle.close();
    }
  });

  it("refuses to speak for a role whose stored channel identity is not the one it derived", async () => {
    const stateDir = tempDir("acp-buzz-sub-swapped-");
    const keys = tempDir("acp-buzz-keys-swapped-");
    const identity = hexIdentity(keys, "cto.key");
    const owner = hexIdentity(keys, "owner.key");
    const impostor = hexIdentity(keys, "impostor.key");
    writeConfig(stateDir, configFor([{ keyFile: identity.keyFile, encoding: "hex" }]));
    const sink = recordingSink();
    let bound = { roleKey: ROLE_KEY, buzzActorId: identity.pubkey };
    const transport = manualTransport();
    const handle = startBuzzMentionSubscriberFromStateDir(stateDir, {
      registry: { primaryCtoBindingFor: () => bound },
      sink,
      openSocket: transport.factory,
      scheduler: virtualClock().scheduler,
    });
    try {
      const socket = live(transport.sockets);
      await authenticate(socket, handle);
      const subId = (sentFrames(socket)[1] as string[])[1] ?? "";
      // The registry now answers with a session bound to somebody else's identity. The role key
      // is unchanged, so only the identity comparison can catch this.
      bound = { roleKey: ROLE_KEY, buzzActorId: impostor.pubkey };
      socket.handlers.onFrame(
        frame(["EVENT", subId, mentionEvent({ author: owner.secretKey, addressedTo: identity.pubkey })]),
      );
      await handle.settled();
      expect(sink.admitted).toEqual([]);
    } finally {
      handle.close();
    }
  });

  it("keeps reading after a sink that threw, and does not advance past the event it threw on", async () => {
    const { sockets, handle, identity, owner, sink, clock } = startOne({});
    try {
      const first = live(sockets);
      await authenticate(first, handle);
      const subId = (sentFrames(first)[1] as string[])[1] ?? "";
      sink.throwOnce = true;
      first.handlers.onFrame(
        frame([
          "EVENT",
          subId,
          mentionEvent({
            author: owner.secretKey,
            addressedTo: identity.pubkey,
            createdAt: 1_800_003_000,
          }),
        ]),
      );
      await handle.settled();
      expect(first.closed).toBe(true);

      clock.fireAll();
      const second = live(sockets);
      await authenticate(second, handle);
      expect((sentFrames(second)[1] as [string, string, Record<string, unknown>])[2]["since"]).toBeUndefined();
    } finally {
      handle.close();
    }
  });

  it("handles frames one at a time, in the order the relay sent them", async () => {
    const { sockets, handle, identity, owner, sink } = startOne({});
    try {
      const socket = live(sockets);
      await authenticate(socket, handle);
      const subId = (sentFrames(socket)[1] as string[])[1] ?? "";
      const texts = ["첫째", "둘째", "셋째"];
      const events = texts.map((text, index) =>
        mentionEvent({
          author: owner.secretKey,
          addressedTo: identity.pubkey,
          text,
          createdAt: 1_800_004_000 + index,
        }),
      );
      for (const event of events) socket.handlers.onFrame(frame(["EVENT", subId, event]));
      await handle.settled();
      expect(sink.admitted.map((entry) => entry.text)).toEqual(texts);
    } finally {
      handle.close();
    }
  });

  it("stops for good when it is closed: no reconnect, no further sockets", async () => {
    const { sockets, handle, clock } = startOne({});
    const socket = live(sockets);
    await authenticate(socket, handle);
    handle.close();
    expect(socket.closed).toBe(true);
    socket.handlers.onClose();
    expect(clock.pending()).toBe(0);
    expect(sockets).toHaveLength(1);
  });
});
