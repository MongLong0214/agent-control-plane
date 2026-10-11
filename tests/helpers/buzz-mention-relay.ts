import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";

import {
  BUZZ_MENTION_KIND,
  BUZZ_SUBSCRIBER_CONFIG_FILENAME,
  type BuzzMentionAdmission,
  type BuzzMentionDeliveryBinding,
  type BuzzMentionEvent,
  type BuzzMentionRegistry,
  type BuzzMentionRoleBinding,
  type BuzzMentionSink,
  type BuzzMentionSubscriberHandle,
  type BuzzRelaySocketFactory,
  type BuzzRelaySocketHandlers,
  type BuzzSubscriberScheduler,
} from "../../src/buzz/buzz-mention-subscriber.ts";

/**
 * A relay that keeps what it is sent and answers a `REQ` the way the live one does: stored events
 * matching the filter, `since` inclusive, then `EOSE`, then live pushes for as long as the
 * subscription stays open. NIP-42 is answered with a challenge on open and `OK` for any `AUTH`.
 *
 * A stored event is never removed. Whether a message was *consumed* is therefore a question about
 * which connections asked for it, which `requested` records, rather than about this store.
 */
export interface StoringRelay {
  readonly factory: BuzzRelaySocketFactory;
  /** Stores an event and pushes it to every open subscription whose filter matches it. */
  publish(event: BuzzMentionEvent): void;
  /** Every `REQ` filter sent, with the channel identity (`#p`) it asked for. */
  readonly requested: { readonly pubkey: string; readonly filter: Record<string, unknown> }[];
  /** Connections opened, in order, with the identity each one authenticated as. */
  readonly connections: RelayConnection[];
  /** Open connections authenticated as `pubkey`. */
  openFor(pubkey: string): RelayConnection[];
  /** Runs the subscriber's queue until the relay has nothing more to say. */
  drain(handle: BuzzMentionSubscriberHandle): Promise<void>;
  /** Every EVENT a client sent, in order, when the relay accepts publishes (#246). */
  readonly published: BuzzMentionEvent[];
}

export interface StoringRelayOptions {
  /**
   * #246 — answer a client's EVENT the way the live relay does: store it, push it to every matching
   * subscription, and say `OK`, or `duplicate:` for an id it already holds. Off by default, so a
   * client's EVENT is ignored as it always was here.
   */
  readonly acceptPublishes?: boolean;
}

export interface RelayConnection {
  authenticatedAs: string | null;
  closed: boolean;
  readonly handlers: BuzzRelaySocketHandlers;
  readonly subscriptions: Map<string, Record<string, unknown>>;
}

const tagValues = (event: BuzzMentionEvent, name: string): string[] =>
  event.tags.filter((tag) => tag[0] === name).map((tag) => tag[1] ?? "");

const matches = (filter: Record<string, unknown>, event: BuzzMentionEvent): boolean => {
  const kinds = filter["kinds"] as readonly number[] | undefined;
  if (kinds && !kinds.includes(event.kind)) return false;
  for (const name of ["p", "h", "e"]) {
    const wanted = filter[`#${name}`] as readonly string[] | undefined;
    if (wanted && !tagValues(event, name).some((value) => wanted.includes(value))) return false;
  }
  const since = filter["since"];
  return typeof since !== "number" || event.created_at >= since;
};

export const storingRelay = (options: StoringRelayOptions = {}): StoringRelay => {
  const stored: BuzzMentionEvent[] = [];
  const published: BuzzMentionEvent[] = [];
  const requested: { pubkey: string; filter: Record<string, unknown> }[] = [];
  const connections: RelayConnection[] = [];
  let traffic = 0;

  const say = (connection: RelayConnection, frame: unknown[]): void => {
    if (connection.closed) return;
    traffic += 1;
    connection.handlers.onFrame(JSON.stringify(frame));
  };

  const factory: BuzzRelaySocketFactory = (_url, handlers) => {
    const connection: RelayConnection = { authenticatedAs: null, closed: false, handlers, subscriptions: new Map() };
    connections.push(connection);
    queueMicrotask(() => say(connection, ["AUTH", `challenge-${connections.length}`]));
    return {
      send: (raw) => {
        if (connection.closed) return;
        traffic += 1;
        const frame = JSON.parse(raw) as unknown[];
        if (frame[0] === "AUTH") {
          const auth = frame[1] as { id: string; pubkey: string };
          connection.authenticatedAs = auth.pubkey;
          queueMicrotask(() => say(connection, ["OK", auth.id, true, ""]));
        } else if (frame[0] === "CLOSE") {
          connection.subscriptions.delete(frame[1] as string);
        } else if (frame[0] === "EVENT" && options.acceptPublishes === true) {
          const event = frame[1] as BuzzMentionEvent;
          published.push(event);
          const duplicate = stored.some((held) => held.id === event.id);
          queueMicrotask(() => say(connection, ["OK", event.id, true, duplicate ? "duplicate: already have this event" : ""]));
          if (!duplicate) relayPublish(event);
        } else if (frame[0] === "REQ") {
          const id = frame[1] as string;
          const filter = frame[2] as Record<string, unknown>;
          requested.push({ pubkey: ((filter["#p"] as string[]) ?? [])[0] ?? "", filter });
          connection.subscriptions.set(id, filter);
          const backlog = stored.filter((event) => matches(filter, event));
          queueMicrotask(() => {
            for (const event of backlog) say(connection, ["EVENT", id, event]);
            say(connection, ["EOSE", id]);
          });
        }
      },
      close: () => {
        connection.closed = true;
        connection.subscriptions.clear();
      },
    };
  };

  function relayPublish(event: BuzzMentionEvent): void {
    stored.push(event);
    for (const connection of connections) {
      for (const [id, filter] of connection.subscriptions) {
        if (matches(filter, event)) say(connection, ["EVENT", id, event]);
      }
    }
  }

  return {
    factory,
    requested,
    connections,
    published,
    publish: relayPublish,
    openFor: (pubkey) => connections.filter((one) => !one.closed && one.authenticatedAs === pubkey),
    drain: async (handle) => {
      for (let round = 0; round < 50; round += 1) {
        const before = traffic;
        await handle.settled();
        await new Promise<void>((resolve) => setImmediate(resolve));
        await handle.settled();
        if (traffic === before) return;
      }
      throw new Error("the relay and the subscriber did not go quiet");
    },
  };
};

/** A clock the test steps, as the subscriber's own suite has it. */
export interface SteppedClock {
  readonly scheduler: BuzzSubscriberScheduler;
  pending(): number;
  fireAll(): void;
}

export const steppedClock = (nowSeconds = 1_900_000_000): SteppedClock => {
  const timers = new Map<number, () => void>();
  let next = 1;
  return {
    scheduler: {
      setTimer: (_ms, fire) => {
        const handle = next++;
        timers.set(handle, fire);
        return handle;
      },
      clearTimer: (handle) => {
        timers.delete(handle);
      },
      nowSeconds: () => nowSeconds,
    },
    pending: () => timers.size,
    fireAll: () => {
      for (const [handle, fire] of [...timers]) {
        timers.delete(handle);
        fire();
      }
    },
  };
};

export interface ChannelKey {
  readonly secretKey: Uint8Array;
  readonly pubkey: string;
  readonly keyFile: string;
}

/** A key file exactly as the subscriber's config requires one: absolute, regular, owner-only. */
export const channelKey = (dir: string, name: string): ChannelKey => {
  const secretKey = generateSecretKey();
  const keyFile = join(dir, name);
  writeFileSync(keyFile, `${Buffer.from(secretKey).toString("hex")}\n`, { mode: 0o600 });
  chmodSync(keyFile, 0o600);
  return { secretKey, pubkey: getPublicKey(secretKey), keyFile };
};

export const writeSubscriberConfig = (
  stateDir: string,
  identities: readonly { keyFile: string; rooms: readonly string[] }[],
): void => {
  writeFileSync(
    join(stateDir, BUZZ_SUBSCRIBER_CONFIG_FILENAME),
    JSON.stringify({
      relayUrl: "wss://relay.example.invalid/buzz",
      identities: identities.map((identity) => ({
        privateKeyFile: identity.keyFile,
        encoding: "hex",
        rooms: identity.rooms,
      })),
    }),
  );
};

/** One signed kind-9 mention of `addressedTo`, in `room`. */
export const signedMention = (input: {
  author: Uint8Array;
  addressedTo: string;
  room: string;
  createdAt: number;
  text: string;
}): BuzzMentionEvent =>
  finalizeEvent(
    {
      kind: BUZZ_MENTION_KIND,
      created_at: input.createdAt,
      tags: [
        ["p", input.addressedTo],
        ["h", input.room],
      ],
      content: input.text,
    },
    input.author,
  ) as BuzzMentionEvent;

/** A registry the test moves: each identity's binding, or its absence. */
export interface MovableRegistry extends BuzzMentionRegistry {
  hold(pubkey: string, binding: BuzzMentionRoleBinding | null): void;
}

export const movableRegistry = (): MovableRegistry => {
  const held = new Map<string, BuzzMentionRoleBinding>();
  return {
    primaryCtoBindingFor: (pubkey) => held.get(pubkey) ?? null,
    hold: (pubkey, binding) => {
      if (binding === null) held.delete(pubkey);
      else held.set(pubkey, binding);
    },
  };
};

/** One call the sink received, and whether it was the event's first durable admission. */
export interface SeamCall {
  readonly eventId: string;
  readonly roleKey: string;
  readonly identityPubkey: string;
  readonly binding: BuzzMentionDeliveryBinding | null;
  readonly answer: BuzzMentionAdmission;
}

/**
 * A sink with the one property of the real admission seam these witnesses depend on: replay
 * refusal by event id. The first admission of an event is `DURABLE` and is an *execution*; every
 * later one is `ALREADY_DURABLE` and executes nothing. The subscriber keeps no seen-set of its own,
 * so "no duplicate execution" is this map's answer, exactly as it is the seam's in production.
 */
export interface SeamSink extends BuzzMentionSink {
  readonly calls: SeamCall[];
  executions(): SeamCall[];
}

export const seamSink = (): SeamSink => {
  const durable = new Set<string>();
  const calls: SeamCall[] = [];
  return {
    calls,
    executions: () => calls.filter((call) => call.answer === "DURABLE"),
    admit: async (request) => {
      const answer: BuzzMentionAdmission = durable.has(request.event.id) ? "ALREADY_DURABLE" : "DURABLE";
      durable.add(request.event.id);
      calls.push({
        eventId: request.event.id,
        roleKey: request.roleKey,
        identityPubkey: request.identityPubkey,
        binding: request.binding ?? null,
        answer,
      });
      return answer;
    },
  };
};
