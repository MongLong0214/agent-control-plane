import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools/pure";

import {
  type BuzzMentionSubscriberHandle,
  type BuzzRelaySocketFactory,
  type BuzzRelaySocketHandlers,
  type BuzzSignedEvent,
  type BuzzSubscriberScheduler,
  startBuzzMentionSubscriber,
} from "../../src/buzz/buzz-mention-subscriber.ts";
import { OwnerReplyConsumer } from "../../src/conversation/owner-reply-consumer.ts";
import {
  OWNER_REPLY_OUTBOX_CHANNEL,
  ownerReplyDeliveryState,
  ownerReplyFor,
  pendingOwnerReplies,
} from "../../src/conversation/owner-reply-outbox.ts";
import {
  ConversationTurnCoordinator,
  type ReceiptLookupQuery,
  type ReceiptLookupResult,
  type ReceiptPort,
} from "../../src/conversation/turn-coordinator.ts";
import { ManualClock } from "../../src/core/clock.ts";
import { canonicalJson, digestOf, sha256 } from "../../src/core/digest.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { startDaemonOwnerReplyConsumer } from "../../src/daemon/agentcpd.ts";
import { AuditLog } from "../../src/db/audit.ts";
import { openDb } from "../../src/db/database.ts";
import { IngressGuard } from "../../src/ingress/ingress-guard.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);
afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * #1036, the delivery half. A completed turn's owner-reply item is published to the Buzz room the
 * owner asked in, as a reply to the owner's event, signed by the identity the owner mentioned, over
 * that identity's own authenticated subscriber connection. It is recorded `DELIVERED` with evidence,
 * once. An item that cannot be delivered stays `PENDING` with one audit row per cause, and never
 * travels by another channel.
 *
 * The relay is an in-process fake behind the subscriber's own socket seam. It answers NIP-42 and
 * NIP-01 the way the live relay does, and keeps one copy of an event id. Both timer seams are
 * virtual, so a row steps the backoff and the publish timeout rather than waiting for them.
 */
const NOW = "2026-10-03T00:00:00.000Z";
const RELAY = "wss://relay.example.invalid/buzz";
/** The shape of a live Buzz room id (`tests/fixtures/buzz-cli/messages-get.json`). */
const ROOM = "83da5c36-7be5-4df7-9887-19ec44d7fb0a";
const OTHER_ROOM = "5b0c9d1e-0000-4000-8000-000000000000";
const ROLE_KEY = "PRIMARY_CTO:proj-1036";
const PREVIOUS_PROCESS = "process:previous";
const REPLY = "The deploy finished; all 29 gates passed.";

const eventIdFor = (label: string): string => sha256(label).slice("sha256:".length);
const buzzNonce = (eventId: string): string => `buzz-message:${eventId}`;

const flush = async (rounds = 30): Promise<void> => {
  for (let round = 0; round < rounds; round += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};

/* --------------------------------------------------------------------------------- the relay */

type RelayMode = "accept" | "refuse" | "silent";

interface FakeRelay {
  readonly factory: BuzzRelaySocketFactory;
  mode: RelayMode;
  refusal: string;
  /** Every EVENT frame received, in order, byte for byte. */
  readonly received: { raw: string; event: BuzzSignedEvent }[];
  /** One entry per distinct event id the relay holds, however often it was sent. */
  readonly stored: Map<string, string>;
  readonly sockets: { handlers: BuzzRelaySocketHandlers; closed: boolean }[];
  /** Challenges the newest connection, which the subscriber answers through NIP-42. */
  connect(): Promise<void>;
}

const fakeRelay = (): FakeRelay => {
  const relay: FakeRelay = {
    factory: (_url, handlers) => {
      const socket = { handlers, closed: false };
      relay.sockets.push(socket);
      const answer = (frame: unknown[]): void => {
        queueMicrotask(() => {
          if (!socket.closed) handlers.onFrame(JSON.stringify(frame));
        });
      };
      return {
        send: (raw) => {
          if (socket.closed) return;
          const frame = JSON.parse(raw) as unknown[];
          if (frame[0] === "AUTH") answer(["OK", (frame[1] as { id: string }).id, true, ""]);
          if (frame[0] === "REQ") answer(["EOSE", frame[1]]);
          if (frame[0] !== "EVENT") return;
          const event = frame[1] as BuzzSignedEvent;
          relay.received.push({ raw, event });
          if (relay.mode === "refuse") {
            answer(["OK", event.id, false, relay.refusal]);
            return;
          }
          const duplicate = relay.stored.has(event.id);
          if (!duplicate) relay.stored.set(event.id, raw);
          if (relay.mode === "silent") return;
          answer(["OK", event.id, true, duplicate ? "duplicate: already have this event" : ""]);
        },
        close: () => {
          socket.closed = true;
        },
      };
    },
    mode: "accept",
    refusal: "",
    received: [],
    stored: new Map(),
    sockets: [],
    connect: async () => {
      const socket = relay.sockets.at(-1);
      if (!socket) throw new Error("no relay socket was opened");
      socket.handlers.onFrame(JSON.stringify(["AUTH", "challenge-1036"]));
      await flush();
    },
  };
  return relay;
};

/** A timer seam the row steps. */
const virtualTimers = (): {
  scheduler: BuzzSubscriberScheduler;
  pending: () => number[];
  fireAll: () => void;
} => {
  const timers = new Map<number, { ms: number; fire: () => void }>();
  let next = 1;
  return {
    scheduler: {
      setTimer: (ms, fire) => {
        const handle = next++;
        timers.set(handle, { ms, fire });
        return handle;
      },
      clearTimer: (handle) => {
        timers.delete(handle);
      },
      nowSeconds: () => Math.floor(Date.parse(NOW) / 1000),
    },
    pending: () => [...timers.values()].map((timer) => timer.ms),
    fireAll: () => {
      for (const [handle, timer] of [...timers]) {
        timers.delete(handle);
        timer.fire();
      }
    },
  };
};

/* --------------------------------------------------------------------------------- the world */

class FakeReceiptPort implements ReceiptPort {
  private readonly answers = new Map<string, ReceiptLookupResult>();

  answer(turnRequestId: string, result: ReceiptLookupResult): void {
    this.answers.set(turnRequestId, result);
  }

  lookup(query: ReceiptLookupQuery): ReceiptLookupResult {
    return this.answers.get(query.turnRequestId) ?? { found: false };
  }
}

interface CtoIdentity {
  pubkey: string;
  keyFile: string;
}

const ctoIdentity = (): CtoIdentity => {
  const dir = tempDir("acp-1036-keys-");
  const secretKey = generateSecretKey();
  const keyFile = join(dir, "cto.key");
  writeFileSync(keyFile, `${Buffer.from(secretKey).toString("hex")}\n`, { mode: 0o600 });
  chmodSync(keyFile, 0o600);
  return { pubkey: getPublicKey(secretKey), keyFile };
};

interface World {
  path: string;
  db: ReturnType<typeof openDb>;
  clock: ManualClock;
  audit: AuditLog;
  coordinator: ConversationTurnCoordinator;
  port: FakeReceiptPort;
  cto: CtoIdentity;
  relay: FakeRelay;
  subscriber: BuzzMentionSubscriberHandle;
  subscriberTimers: ReturnType<typeof virtualTimers>;
  consumer: OwnerReplyConsumer;
  consumerTimers: ReturnType<typeof virtualTimers>;
  wakes: Promise<void>[];
  actorId: string;
}

const statePath = (): string => {
  const root = join(tempDir("acp-1036-delivery-"), "state");
  mkdirSync(root, { recursive: true });
  chmodSync(root, 0o700);
  return join(root, "state.sqlite");
};

/** The canonical target `ConversationTurnCoordinator.claim` needs, as the settlement tests install it. */
const installTarget = (db: World["db"], name: string): string => {
  const actorId = `actor:${name}`;
  const sessionId = `runtime:${name}`;
  db.run(
    `INSERT INTO sessions (session_id, incarnation, provider, model, lifecycle, created_at, updated_at)
     VALUES (?, 'inc-1', 'claude', 'opus', 'READY', ?, ?)`,
    [sessionId, NOW, NOW],
  );
  db.run(
    `INSERT INTO conversational_actors
       (actor_id, kind, current_session_id, current_session_incarnation, created_at)
     VALUES (?, 'CEO', ?, 'inc-1', ?)`,
    [actorId, sessionId, NOW],
  );
  db.run(
    `INSERT INTO actor_target_bindings
       (target_binding_id, target_actor_id, executor_kind, target_locator, target_locator_digest, bound_at)
     VALUES (?, ?, 'hermes', ?, ?, ?)`,
    [`bind:${name}`, actorId, `locator:${name}`, `digest:${name}`, NOW],
  );
  db.run(
    `INSERT INTO assignments
       (assignment_id, role_key, role, actor_id, session_id, session_incarnation,
        binding_generation, mode, status, created_at)
     VALUES (?, ?, 'CEO', ?, ?, 'inc-1', 1, 'PREFERRED', 'ACTIVE', ?)`,
    [`asg:${name}`, `CEO:${name}`, actorId, sessionId, NOW],
  );
  db.run(
    `INSERT INTO actor_target_attestations
       (target_attestation_id, target_binding_id, protocol_version, attestation_digest,
        executor_session_id, executor_session_incarnation, binding_generation, assignment_id,
        attested_at)
     VALUES (?, ?, 'v1', ?, ?, 'inc-1', 1, ?, ?)`,
    [`att:${name}`, `bind:${name}`, `attd:${name}`, sessionId, `asg:${name}`, NOW],
  );
  return actorId;
};

const openWorld = (options: {
  path?: string;
  cto?: CtoIdentity;
  relay?: FakeRelay;
  rooms?: readonly string[];
  clock?: ManualClock;
} = {}): World => {
  const path = options.path ?? statePath();
  const fresh = options.path === undefined;
  const db = openDb(path);
  const clock = options.clock ?? new ManualClock(NOW);
  const audit = new AuditLog(db, clock);
  const port = new FakeReceiptPort();
  const coordinator = new ConversationTurnCoordinator(db, clock, audit, port);
  const cto = options.cto ?? ctoIdentity();
  const relay = options.relay ?? fakeRelay();
  const subscriberTimers = virtualTimers();
  const subscriber = startBuzzMentionSubscriber({
    config: {
      relayUrl: RELAY,
      identities: [{ privateKeyFile: cto.keyFile, encoding: "hex", rooms: options.rooms ?? [ROOM] }],
    },
    registry: {
      primaryCtoBindingFor: (pubkey) => (pubkey === cto.pubkey ? { roleKey: ROLE_KEY, buzzActorId: cto.pubkey } : null),
    },
    sink: { admit: () => Promise.resolve("REFUSED" as const) },
    openSocket: relay.factory,
    scheduler: subscriberTimers.scheduler,
  });
  const consumerTimers = virtualTimers();
  const consumer = new OwnerReplyConsumer({
    db,
    clock,
    audit,
    buzz: subscriber.replies,
    timers: consumerTimers.scheduler,
  });
  // The two wake-ups `startDaemonOwnerReplyConsumer` wires, kept here so a row can await each one.
  const wakes: Promise<void>[] = [];
  coordinator.onOwnerReplyEnqueued(() => {
    wakes.push(consumer.wake("DUE"));
  });
  subscriber.replies.onAuthenticated(() => {
    wakes.push(consumer.wake("RELAY"));
  });
  const actorId = fresh ? installTarget(db, "cto") : "actor:cto";
  return {
    path, db, clock, audit, coordinator, port, cto, relay, subscriber, subscriberTimers, consumer, consumerTimers, wakes,
    actorId,
  };
};

/** Lets every queued frame, announcement and pass finish. Only for rows whose relay answers. */
const quiesce = async (w: World): Promise<void> => {
  for (let round = 0; round < 4; round += 1) {
    await flush();
    await Promise.all(w.wakes);
    await w.subscriber.settled();
  }
};

interface Admitted {
  channel: string;
  nonce: string;
  payload: Record<string, unknown>;
}

/** Admits an owner's Buzz mention through the production guard and claims it, as the router does. */
const admitBuzz = (
  w: World,
  input: { eventId: string; room?: string; mention: string | null; addressedTo?: string },
): Admitted => {
  const room = input.room ?? ROOM;
  const nonce = buzzNonce(input.eventId);
  const payload = {
    type: "BUZZ_MESSAGE",
    conversation: room,
    addressedTo: input.addressedTo ?? "ROLE",
    mention: input.mention,
    text: "what is the status of the deploy?",
  };
  const guard = new IngressGuard(w.db, w.clock, w.audit, {
    buzz: { allowedActors: ["owner"], allowedConversations: [room] },
  }, { claimProcessIncarnation: PREVIOUS_PROCESS });
  const admitted = guard.admit({ channel: "buzz", actor: "owner", conversation: room, nonce, payload });
  if (!admitted.allowed) throw new Error(`fixture could not admit ${nonce}: ${admitted.reasonCode}`);
  const claimed = guard.claimTurn("buzz", nonce, {
    turnRequestId: `ingress:${nonce}`,
    sessionDigest: digestOf({ channel: "buzz", conversation: room }),
    promptDigest: digestOf("hello"),
    bindingDigest: digestOf({ bindingGeneration: 1 }),
  });
  if (!claimed.allowed) throw new Error(`fixture could not claim ${nonce}: ${claimed.reasonCode}`);
  return { channel: "buzz", nonce, payload };
};

/** Admits an owner's Telegram message the way `TelegramIngress` does, and claims it. */
const admitTelegram = (w: World, nonce: string): Admitted => {
  const chat = "chat-9";
  const payload = { text: "what is the status?", messageId: 71, chatId: chat, messageThreadId: null };
  const guard = new IngressGuard(w.db, w.clock, w.audit, {
    telegram: { allowedActors: ["owner"], allowedConversations: [chat] },
  }, { claimProcessIncarnation: PREVIOUS_PROCESS });
  const admitted = guard.admit({ channel: "telegram", actor: "owner", conversation: chat, nonce, payload });
  if (!admitted.allowed) throw new Error(`fixture could not admit ${nonce}: ${admitted.reasonCode}`);
  const claimed = guard.claimTurn("telegram", nonce, {
    turnRequestId: `ingress:${nonce}`,
    sessionDigest: digestOf({ projectId: null, chatId: chat, message_thread_id: null, replyRootMessageId: null }),
    legacySessionDigest: digestOf({ channel: "telegram", conversation: chat }),
    promptDigest: digestOf("hello"),
    bindingDigest: digestOf({ bindingGeneration: 1 }),
  });
  if (!claimed.allowed) throw new Error(`fixture could not claim ${nonce}: ${claimed.reasonCode}`);
  return { channel: "telegram", nonce, payload };
};

/** Claims the canonical turn, has the target answer `COMPLETED`, and runs the sweep that settles it. */
const settle = async (
  w: World,
  source: Admitted,
  reply: { content?: string; evidenceDigest?: string } = { content: REPLY },
): Promise<string> => {
  const claimed = w.coordinator.claim({
    targetActorId: w.actorId,
    prompt: "hello",
    sources: [{ channel: source.channel, nonce: source.nonce, attempt: 1, payload: source.payload }],
  });
  if (!claimed.allowed) throw new Error(`claim refused: ${claimed.reasonCode} ${claimed.message}`);
  const turn = claimed.value.turnRequestId;
  const row = w.db.get<{
    target_actor_id: string;
    prompt_digest: string;
    binding_generation: number;
    target_binding_id: string;
    target_attestation_id: string;
    executor_session_id: string;
    executor_session_incarnation: string;
  }>(`SELECT * FROM canonical_turns WHERE turn_request_id = ?`, [turn]);
  if (!row) throw new Error("the claimed turn has no row");
  w.port.answer(turn, {
    found: true,
    outcome: "COMPLETED",
    receiptId: `hermes:${turn}`,
    evidenceDigest: reply.evidenceDigest ?? sha256(reply.content ?? REPLY),
    reasonCode: ReasonCode.OK,
    ...(reply.content === undefined ? {} : { content: reply.content }),
    turnRequestId: turn,
    targetActorId: row.target_actor_id,
    promptDigest: row.prompt_digest,
    bindingGeneration: row.binding_generation,
    targetBindingId: row.target_binding_id,
    targetAttestationId: row.target_attestation_id,
    executorSessionId: row.executor_session_id,
    executorSessionIncarnation: row.executor_session_incarnation,
  });
  const summary = await w.coordinator.reconcileUnresolved();
  if (summary.settled !== 1) throw new Error(`the sweep settled ${summary.settled} turns`);
  return turn;
};

const auditRows = (w: World, kind: string, turnRequestId: string) =>
  w.db.all<{ reason_code: string | null; evidence_json: string }>(
    `SELECT reason_code, evidence_json FROM audit_events
      WHERE kind = ? AND json_extract(evidence_json, '$.turnRequestId') = ?
      ORDER BY event_id ASC`,
    [kind, turnRequestId],
  );

/** A crafted item, for the malformed addresses no settlement can produce. */
const insertItem = (w: World, turnRequestId: string, address: Record<string, unknown>, anchor: string): void => {
  w.db.run(
    `INSERT INTO inbound_messages (channel, nonce, actor, received_at, payload_json, result_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      OWNER_REPLY_OUTBOX_CHANNEL,
      turnRequestId,
      w.actorId,
      NOW,
      canonicalJson({
        turnRequestId,
        ledger: "CANONICAL_TURN",
        targetActorId: w.actorId,
        sources: [{ channel: "buzz", nonce: anchor }],
        address: { channel: "buzz", threadId: null, replyToMessageId: null, replyAs: w.cto.pubkey, ...address },
        receipt: { authority: "HERMES_TARGET", receiptId: `hermes:${turnRequestId}`, evidenceDigest: sha256(REPLY), reasonCode: "OK" },
        replyText: REPLY,
      }),
      canonicalJson({ status: "PENDING" }),
    ],
  );
};

/* ---------------------------------------------------------------------------------- the rows */

describe("an owner reply on Buzz", () => {
  it("is published in the asked room as a reply to the owner's event, signed by the mentioned identity, and recorded DELIVERED", async () => {
    const w = openWorld();
    await w.relay.connect();
    await w.consumer.start();
    const ownerEvent = eventIdFor("owner-event-happy");
    const turn = await settle(w, admitBuzz(w, { eventId: ownerEvent, mention: w.cto.pubkey }));
    await quiesce(w);

    expect(w.relay.received).toHaveLength(1);
    const { event } = w.relay.received[0]!;
    expect(event.kind).toBe(9);
    expect(event.tags).toEqual([["h", ROOM], ["e", ownerEvent, "", "reply"]]);
    expect(event.pubkey).toBe(w.cto.pubkey);
    expect(event.content).toBe(REPLY);
    expect(verifyEvent({ ...event, tags: event.tags.map((tag) => [...tag]) })).toBe(true);

    const item = ownerReplyFor(w.db, turn);
    expect(item?.status).toBe("DELIVERED");
    expect(item?.replyText).toBe(REPLY);
    const delivery = item?.delivery;
    expect(delivery).toMatchObject({
      transport: "buzz",
      eventId: event.id,
      signer: w.cto.pubkey,
      conversation: ROOM,
      replyToEventId: ownerEvent,
      relayUrl: RELAY,
      contentDigest: sha256(REPLY),
    });
    const { evidenceDigest, ...evidence } = delivery!;
    expect(evidenceDigest).toBe(digestOf(evidence));
    expect(auditRows(w, "OWNER_REPLY_DELIVERED", turn)).toHaveLength(1);
    expect(pendingOwnerReplies(w.db)).toEqual([]);
  });

  it("sends nothing again for a second wake, a redelivered receipt, or a restarted consumer", async () => {
    const w = openWorld();
    await w.relay.connect();
    await w.consumer.start();
    const turn = await settle(w, admitBuzz(w, { eventId: eventIdFor("owner-event-dup"), mention: w.cto.pubkey }));
    await quiesce(w);
    expect(w.relay.received).toHaveLength(1);

    await w.consumer.wake("ALL");
    await w.consumer.wake("DUE");
    // The same receipt again: the turn is already COMPLETED, so the sweep owes nothing new.
    await w.coordinator.reconcileUnresolved();
    await quiesce(w);
    expect(w.relay.received).toHaveLength(1);

    w.subscriber.close();
    w.consumer.close();
    w.db.close();
    const restarted = openWorld({ path: w.path, cto: w.cto, relay: w.relay });
    await restarted.relay.connect();
    await restarted.consumer.start();
    await quiesce(restarted);
    expect(w.relay.received).toHaveLength(1);
    expect(ownerReplyFor(restarted.db, turn)?.status).toBe("DELIVERED");
    expect(auditRows(restarted, "OWNER_REPLY_DELIVERED", turn)).toHaveLength(1);
  });

  it("resends the recorded event after a crash between publish and record, and the relay keeps one", async () => {
    const relay = fakeRelay();
    relay.mode = "silent";
    const before = openWorld({ relay });
    await relay.connect();
    await before.consumer.start();
    const turn = await settle(before, admitBuzz(before, { eventId: eventIdFor("owner-event-crash"), mention: before.cto.pubkey }));
    await flush();

    // The relay took the event and its answer never arrived: the intent is durable, DELIVERED is not.
    expect(relay.received).toHaveLength(1);
    const sent = relay.received[0]!;
    expect(ownerReplyDeliveryState(before.db, turn)).toMatchObject({
      status: "PENDING",
      intent: { eventId: sent.event.id },
    });

    // The crash: the process is gone. Its connection is dead to the relay and nothing it held runs again.
    relay.sockets.at(-1)!.closed = true;
    before.db.close();

    relay.mode = "accept";
    const after = openWorld({ path: before.path, cto: before.cto, relay, clock: new ManualClock("2026-10-03T00:05:00.000Z") });
    await relay.connect();
    await after.consumer.start();
    await quiesce(after);

    expect(relay.received).toHaveLength(2);
    expect(relay.received[1]!.raw).toBe(sent.raw);
    expect(relay.stored.size).toBe(1);
    const item = ownerReplyFor(after.db, turn);
    expect(item?.status).toBe("DELIVERED");
    expect(item?.delivery?.eventId).toBe(sent.event.id);
    expect(item?.delivery?.relayMessage.startsWith("duplicate:")).toBe(true);
    expect(auditRows(after, "OWNER_REPLY_DELIVERED", turn)).toHaveLength(1);
  });

  it("stays PENDING through a relay refusal and a timeout, one audit row per cause, and retries the same event after the backoff", async () => {
    const w = openWorld();
    w.relay.mode = "refuse";
    w.relay.refusal = "blocked: not accepting replies right now";
    await w.relay.connect();
    await w.consumer.start();
    const turn = await settle(w, admitBuzz(w, { eventId: eventIdFor("owner-event-retry"), mention: w.cto.pubkey }));
    await quiesce(w);

    expect(ownerReplyDeliveryState(w.db, turn)).toMatchObject({
      status: "PENDING",
      attempts: 1,
      retryAt: "2026-10-03T00:00:05.000Z",
      blocked: { reasonCode: ReasonCode.OWNER_REPLY_RELAY_REFUSED, cause: "blocked", transient: true },
    });
    expect(auditRows(w, "OWNER_REPLY_UNDELIVERED", turn).map((row) => row.reason_code)).toEqual([
      ReasonCode.OWNER_REPLY_RELAY_REFUSED,
    ]);
    expect(w.consumerTimers.pending()).toEqual([5_000]);

    // Not due yet: a wake before the backoff runs out sends nothing.
    await w.consumer.wake("DUE");
    expect(w.relay.received).toHaveLength(1);

    // Due, and the relay says nothing: the publish times out.
    w.relay.mode = "silent";
    w.clock.advance(5_000);
    w.consumerTimers.fireAll();
    const timingOut = w.consumer.wake("DUE");
    await flush();
    expect(w.relay.received).toHaveLength(2);
    w.subscriberTimers.fireAll();
    await timingOut;
    expect(ownerReplyDeliveryState(w.db, turn)).toMatchObject({
      status: "PENDING",
      attempts: 2,
      blocked: { reasonCode: ReasonCode.OWNER_REPLY_RELAY_TIMEOUT, transient: true },
    });

    // The same cause again writes no second row.
    w.clock.advance(15_000);
    w.consumerTimers.fireAll();
    const again = w.consumer.wake("DUE");
    await flush();
    w.subscriberTimers.fireAll();
    await again;
    expect(ownerReplyDeliveryState(w.db, turn)).toMatchObject({ status: "PENDING", attempts: 3 });
    expect(auditRows(w, "OWNER_REPLY_UNDELIVERED", turn).map((row) => row.reason_code)).toEqual([
      ReasonCode.OWNER_REPLY_RELAY_REFUSED,
      ReasonCode.OWNER_REPLY_RELAY_TIMEOUT,
    ]);

    // The relay answers at last. Every attempt carried the one event.
    w.relay.mode = "accept";
    w.clock.advance(60_000);
    w.consumerTimers.fireAll();
    await w.consumer.wake("DUE");
    await quiesce(w);
    expect(ownerReplyFor(w.db, turn)?.status).toBe("DELIVERED");
    expect(new Set(w.relay.received.map((sent) => sent.event.id)).size).toBe(1);
    expect(w.relay.stored.size).toBe(1);
  });
});

describe("an owner reply the consumer cannot deliver", () => {
  it("stays PENDING for a Telegram item with exactly one audit row, and is never sent through Buzz", async () => {
    const w = openWorld();
    await w.relay.connect();
    await w.consumer.start();
    const turn = await settle(w, admitTelegram(w, "tg-1036"));
    await quiesce(w);
    await w.consumer.wake("ALL");
    w.clock.advance(3_600_000);
    await w.consumer.wake("DUE");
    await w.consumer.start();
    await quiesce(w);

    expect(ownerReplyFor(w.db, turn)?.status).toBe("PENDING");
    expect(ownerReplyFor(w.db, turn)?.address.channel).toBe("telegram");
    expect(ownerReplyDeliveryState(w.db, turn)?.blocked).toMatchObject({
      reasonCode: ReasonCode.OWNER_REPLY_UNDELIVERABLE_NO_TRANSPORT,
      transient: false,
    });
    expect(auditRows(w, "OWNER_REPLY_UNDELIVERED", turn).map((row) => row.reason_code)).toEqual([
      ReasonCode.OWNER_REPLY_UNDELIVERABLE_NO_TRANSPORT,
    ]);
    expect(w.relay.received).toEqual([]);
    // Parked, not polled: nothing a timer could change, so no timer is armed for it.
    expect(w.consumerTimers.pending()).toEqual([]);
  });

  it("refuses an address with no identity to sign as, an identity this daemon does not hold, or a room it does not hold", async () => {
    const w = openWorld();
    await w.relay.connect();
    await w.consumer.start();
    const noIdentity = await settle(w, admitBuzz(w, { eventId: eventIdFor("owner-event-ceo"), mention: null, addressedTo: "CEO" }));
    const stranger = await settle(w, admitBuzz(w, {
      eventId: eventIdFor("owner-event-stranger"),
      mention: getPublicKey(generateSecretKey()),
    }));
    await quiesce(w);

    const other = openWorld({ rooms: [OTHER_ROOM] });
    await other.relay.connect();
    await other.consumer.start();
    const wrongRoom = await settle(other, admitBuzz(other, { eventId: eventIdFor("owner-event-room"), mention: other.cto.pubkey }));
    await quiesce(other);

    for (const [world, turn, reasonCode, cause] of [
      [w, noIdentity, ReasonCode.OWNER_REPLY_IDENTITY_UNKNOWN, "address-names-no-identity"],
      [w, stranger, ReasonCode.OWNER_REPLY_IDENTITY_UNKNOWN, "identity-not-held-by-this-daemon"],
      [other, wrongRoom, ReasonCode.OWNER_REPLY_WRONG_ROOM, "identity-not-subscribed-to-room"],
    ] as const) {
      expect(ownerReplyFor(world.db, turn)?.status).toBe("PENDING");
      expect(ownerReplyDeliveryState(world.db, turn)?.blocked).toMatchObject({ reasonCode, cause, transient: false });
      expect(auditRows(world, "OWNER_REPLY_UNDELIVERED", turn).map((row) => row.reason_code)).toEqual([reasonCode]);
    }
    expect(w.relay.received).toEqual([]);
    expect(other.relay.received).toEqual([]);
  });

  it("refuses a missing or conflicting address", async () => {
    const w = openWorld();
    await w.relay.connect();
    const answered = buzzNonce(eventIdFor("owner-event-a"));
    insertItem(w, "turn:no-room", { conversation: "", sourceNonce: answered }, answered);
    insertItem(w, "turn:no-event", { conversation: ROOM, sourceNonce: "buzz-message:not-an-event" }, "buzz-message:not-an-event");
    insertItem(w, "turn:conflict", { conversation: ROOM, sourceNonce: buzzNonce(eventIdFor("owner-event-b")) }, answered);
    await w.consumer.start();
    await quiesce(w);

    for (const [turn, reasonCode, cause] of [
      ["turn:no-room", ReasonCode.CONVERSATION_TURN_REPLY_UNADDRESSABLE, "address-names-no-room"],
      ["turn:no-event", ReasonCode.CONVERSATION_TURN_REPLY_UNADDRESSABLE, "address-names-no-event-to-answer"],
      ["turn:conflict", ReasonCode.CONVERSATION_TURN_REPLY_CONFLICT, "address-is-not-the-answered-message"],
    ] as const) {
      expect(ownerReplyFor(w.db, turn)?.status).toBe("PENDING");
      expect(ownerReplyDeliveryState(w.db, turn)?.blocked).toMatchObject({ reasonCode, cause });
      expect(auditRows(w, "OWNER_REPLY_UNDELIVERED", turn).map((row) => row.reason_code)).toEqual([reasonCode]);
    }
    expect(w.relay.received).toEqual([]);
  });

  it("refuses a reply whose text is absent or is not the text the receipt proved", async () => {
    const w = openWorld();
    await w.relay.connect();
    await w.consumer.start();
    const absent = await settle(w, admitBuzz(w, { eventId: eventIdFor("owner-event-absent"), mention: w.cto.pubkey }), {
      evidenceDigest: sha256(REPLY),
    });
    const forged = await settle(w, admitBuzz(w, { eventId: eventIdFor("owner-event-forged"), mention: w.cto.pubkey }), {
      content: "something the target never said",
      evidenceDigest: sha256(REPLY),
    });
    await quiesce(w);

    for (const [turn, cause] of [[absent, "reply-text-absent"], [forged, "reply-text-digest-mismatch"]] as const) {
      expect(ownerReplyFor(w.db, turn)?.status).toBe("PENDING");
      expect(ownerReplyDeliveryState(w.db, turn)?.blocked).toMatchObject({
        reasonCode: ReasonCode.OWNER_REPLY_BODY_UNAVAILABLE,
        cause,
      });
    }
    expect(w.relay.received).toEqual([]);
  });
});

describe("the daemon's owner-reply wiring", () => {
  it("wakes the consumer on a committed settlement and on every relay authentication, and sweeps at startup", async () => {
    const harness = makeHarness();
    const relay = fakeRelay();
    const cto = ctoIdentity();
    const subscriber = startBuzzMentionSubscriber({
      config: { relayUrl: RELAY, identities: [{ privateKeyFile: cto.keyFile, encoding: "hex", rooms: [ROOM] }] },
      registry: {
        primaryCtoBindingFor: (pubkey) => (pubkey === cto.pubkey ? { roleKey: ROLE_KEY, buzzActorId: cto.pubkey } : null),
      },
      sink: { admit: () => Promise.resolve("REFUSED" as const) },
      openSocket: relay.factory,
      scheduler: virtualTimers().scheduler,
    });
    const onSettlement = vi.spyOn(harness.cp.conversation, "onOwnerReplyEnqueued");
    const onRelay = vi.spyOn(subscriber.replies, "onAuthenticated");
    const start = vi.spyOn(OwnerReplyConsumer.prototype, "start");

    const started = startDaemonOwnerReplyConsumer(harness.cp, subscriber, { timers: virtualTimers().scheduler });
    await started.started;
    expect(start).toHaveBeenCalledTimes(1);
    expect(onSettlement).toHaveBeenCalledTimes(1);
    expect(onRelay).toHaveBeenCalledTimes(1);

    const wake = vi.spyOn(started.consumer, "wake");
    onSettlement.mock.calls[0]![0]();
    onRelay.mock.calls[0]![0]();
    expect(wake.mock.calls).toEqual([["DUE"], ["RELAY"]]);

    started.close();
    subscriber.close();
  });
});
