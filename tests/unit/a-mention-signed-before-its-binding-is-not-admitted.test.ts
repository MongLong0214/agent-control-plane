import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { afterAll, describe, expect, it } from "vitest";

import {
  BUZZ_SUBSCRIBER_CONFIG_FILENAME,
  type BuzzMentionEvent,
  type BuzzRelaySocketFactory,
  type BuzzRelaySocketHandlers,
  type BuzzSubscriberScheduler,
} from "../../src/buzz/buzz-mention-subscriber.ts";
import type { Decision } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import {
  ownerMessageLedger,
  startBuzzMessageIngressListener,
  startDaemonBuzzMentionSubscriber,
} from "../../src/daemon/agentcpd.ts";
import { Role, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { buzzMessageNonce } from "../../src/ingress/buzz-message.ts";
import { CeoConversationPort } from "../../src/mcp/ceo-conversation.ts";
import type { OwnerMessageHandover } from "../../src/mcp/role-conversation.ts";
import { MessageKind } from "../../src/outbox/envelope.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { makeHarness, registerFixtureProject } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * A mention signed before the addressed role's binding generation existed is not admitted for it.
 *
 * Measured live on 2026-10-03: a newly bound CTO identity's first subscription carried no `since`,
 * the relay handed back the room's history, and three owner mentions from 2026-08-09 were queued as
 * new owner messages for a PRIMARY_CTO bound that morning. Every row here runs the daemon's own
 * composition — the subscriber, its sink and the admission seam over one control plane — because
 * the defect was in how those three meet, not in any one of them.
 *
 * The fixture's clock starts at 2026-08-12, so the history below is three days older than the
 * binding, the shape the live rows had.
 */

const SECRET = "buzz-backfill-floor-test-secret";
const PROJECT_ROOM = "buzz-project-room";
const HISTORY_SECONDS = Math.floor(Date.parse("2026-08-09T05:00:00.000Z") / 1000);
const PRECEDES_BINDING = "admission-precedes-binding";

interface Key {
  secret: Uint8Array;
  pubkey: string;
}
const newKey = (): Key => {
  const secret = generateSecretKey();
  return { secret, pubkey: getPublicKey(secret) };
};

type Harness = ReturnType<typeof makeHarness>;

const readySession = (
  harness: Harness,
  model: string,
  buzzAddress: string | null,
): { sessionId: string; sessionSecret: string; incarnation: string } => {
  const session = harness.cp.sessions.create({ provider: "scripted", model, buzzAddress });
  expect(
    harness.cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "test").reasonCode,
  ).toBe(ReasonCode.OK);
  return {
    sessionId: session.sessionId,
    sessionSecret: session.sessionSecret!,
    incarnation: harness.cp.sessions.require(session.sessionId).incarnation,
  };
};

/** The production writer of `sessions.buzz_actor_id`. */
const bindChannelIdentity = (
  harness: Harness,
  session: { sessionId: string; sessionSecret: string },
  pubkey: string,
): void => {
  const bound = harness.cp.sessions.bindBuzzActor(
    { sessionId: session.sessionId, sessionSecret: session.sessionSecret, buzzActorId: pubkey },
    { isAllowedActor: () => true },
  );
  if (!bound.allowed) throw new Error(`buzz channel identity binding failed: ${bound.message}`);
};

const secondsOf = (iso: string): number => Math.floor(Date.parse(iso) / 1000);

interface RelaySocket {
  sent: string[];
  closed: boolean;
  handlers: BuzzRelaySocketHandlers;
}

/**
 * One owner, one project whose PRIMARY_CTO answers on `PROJECT_ROOM` through a subscriber that has
 * just subscribed for the first time, and — with `ceoBoundBeforeCtoMs` — a CEO binding created that
 * long before the CTO's, speaking as its own Buzz channel identity.
 *
 * The CTO binding is created half a second into a whole second, so "the binding's second" and "the
 * binding's millisecond" are different instants and a row can tell which one is the floor.
 */
const start = async (options: { ceoBoundBeforeCtoMs?: number } = {}) => {
  const owner = newKey();
  const ceo = newKey();
  const cto = newKey();
  const h = makeHarness({ ownerIdentities: [{ channel: "buzz", actor: owner.pubkey }] });
  const { projectId } = await registerFixtureProject(h);
  const ctoRoleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId });

  if (options.ceoBoundBeforeCtoMs !== undefined) {
    const ceoSession = readySession(h, "ceo", null);
    const ceoBound = h.cp.bindings.bind({
      roleKey: roleKeyFor(Role.CEO),
      role: Role.CEO,
      sessionId: ceoSession.sessionId,
    });
    if (!ceoBound.allowed) throw new Error(`CEO binding failed: ${ceoBound.message}`);
    bindChannelIdentity(h, ceoSession, ceo.pubkey);
    h.clock.advance(options.ceoBoundBeforeCtoMs);
  }

  h.clock.advance(500);
  const ctoSession = readySession(h, "cto", PROJECT_ROOM);
  const ctoBound = h.cp.bindings.bind({
    role: Role.PRIMARY_CTO,
    sessionId: ctoSession.sessionId,
    projectId,
  });
  if (!ctoBound.allowed) throw new Error(`CTO binding failed: ${ctoBound.message}`);
  bindChannelIdentity(h, ctoSession, cto.pubkey);

  const dir = tempDir("acp-buzz-backfill-");
  chmodSync(dir, 0o700);
  const keyFile = join(dir, "cto.nostr.key");
  writeFileSync(keyFile, `${Buffer.from(cto.secret).toString("hex")}\n`, { mode: 0o600 });
  chmodSync(keyFile, 0o600);
  writeFileSync(
    join(dir, BUZZ_SUBSCRIBER_CONFIG_FILENAME),
    JSON.stringify({
      relayUrl: "wss://relay.example.invalid/buzz",
      identities: [{ privateKeyFile: keyFile, encoding: "hex", rooms: [PROJECT_ROOM] }],
    }),
  );
  const policy = { allowedActors: [owner.pubkey, ceo.pubkey], secret: SECRET };
  // No role conversation is wired, so no CTO peer is ever attached: every admitted message is
  // stored for the role and waits for its holder to come and claim it.
  const ingress = await startBuzzMessageIngressListener(h.cp, dir, policy, {
    ceoConversation: new CeoConversationPort(),
    ownerActors: [owner.pubkey],
  });

  const sockets: RelaySocket[] = [];
  const openSocket: BuzzRelaySocketFactory = (_url, handlers) => {
    const socket: RelaySocket = { sent: [], closed: false, handlers };
    sockets.push(socket);
    return {
      send: (raw) => socket.sent.push(raw),
      close: () => {
        socket.closed = true;
      },
    };
  };
  const timers: (() => void)[] = [];
  const scheduler: BuzzSubscriberScheduler = {
    setTimer: (_ms, fire) => timers.push(fire),
    clearTimer: () => undefined,
    nowSeconds: () => secondsOf(h.clock.nowIso()),
  };
  const subscriber = startDaemonBuzzMentionSubscriber(h.cp, dir, policy, ingress, {
    openSocket,
    scheduler,
  });
  const live = (): RelaySocket => {
    const socket = sockets.at(-1);
    if (!socket) throw new Error("the subscriber opened no relay socket");
    return socket;
  };
  /** NIP-42, then the `REQ` the subscriber sends; answers that request's filter. */
  const subscribe = async (): Promise<{ subId: string; filter: Record<string, unknown> }> => {
    const socket = live();
    socket.handlers.onFrame(JSON.stringify(["AUTH", "relay-challenge"]));
    await subscriber.settled();
    const auth = JSON.parse(socket.sent.at(-1)!) as [string, { id: string }];
    socket.handlers.onFrame(JSON.stringify(["OK", auth[1].id, true, ""]));
    await subscriber.settled();
    const req = socket.sent
      .map((raw) => JSON.parse(raw) as unknown[])
      .find((frame) => frame[0] === "REQ") as [string, string, Record<string, unknown>];
    return { subId: req[1], filter: req[2] };
  };
  let subscription = await subscribe();

  return {
    h,
    owner,
    ceo,
    ctoRoleKey,
    subscriber,
    live,
    socketsOpened: () => sockets.length,
    timersPending: () => timers.length,
    /** When the CTO's binding generation was created, in whole seconds. */
    ctoBoundAtSeconds: secondsOf(h.cp.bindings.active(ctoRoleKey)!.createdAt),
    ceoBoundAtSeconds: (): number => secondsOf(h.cp.bindings.active(roleKeyFor(Role.CEO))!.createdAt),
    nowSeconds: (): number => secondsOf(h.clock.nowIso()),
    mention: (author: Key, createdAt: number, text: string): BuzzMentionEvent =>
      finalizeEvent(
        { kind: 9, created_at: createdAt, tags: [["p", cto.pubkey], ["h", PROJECT_ROOM]], content: text },
        author.secret,
      ) as BuzzMentionEvent,
    /** One relay frame on the live connection, through the daemon's own subscriber and sink. */
    relayDelivers: async (event: BuzzMentionEvent): Promise<void> => {
      live().handlers.onFrame(JSON.stringify(["EVENT", subscription.subId, event]));
      await subscriber.settled();
    },
    /** The relay drops the connection; the subscriber is down until `reconnect`. */
    relayDrops: (): void => {
      live().handlers.onClose();
    },
    /** The subscriber's one reconnect timer fires and the new connection subscribes. */
    reconnect: async (): Promise<Record<string, unknown>> => {
      for (const fire of timers.splice(0)) fire();
      subscription = await subscribe();
      return subscription.filter;
    },
    /** Every durable row an admission writes, counted — a refusal must leave all three as they were. */
    footprint: () => ({
      audit: h.cp.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_events`, [])!.n,
      inbound: h.cp.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM inbound_messages`, [])!.n,
      outbox: h.cp.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM outbox`, [])!.n,
    }),
    admitted: (eventId: string) =>
      h.cp.db.get<{ actor: string }>(
        `SELECT actor FROM inbound_messages WHERE channel = 'buzz' AND nonce = ?`,
        [buzzMessageNonce(eventId)],
      ),
    rowsOf: (kind: MessageKind) =>
      h.cp.db.all<{ message_id: string; status: string }>(
        `SELECT message_id, status FROM outbox WHERE kind = ? ORDER BY created_at, rowid`,
        [kind],
      ),
    precedesBinding: (): number => subscriber.counters().rejections[PRECEDES_BINDING] ?? 0,
    holder: () => ({
      roleKey: ctoRoleKey,
      bindingGeneration: h.cp.bindings.active(ctoRoleKey)!.bindingGeneration,
      targetSessionId: ctoSession.sessionId,
      sessionIncarnation: ctoSession.incarnation,
    }),
    close: async () => {
      subscriber.close();
      await ingress.close();
    },
  };
};

const claimedText = (taken: Decision<OwnerMessageHandover>): string | null =>
  taken.allowed ? (taken.value.claimed?.text ?? null) : null;

describe("a Buzz mention signed before its role's binding generation", () => {
  it("is refused on a newly bound identity's first subscription, writing nothing, while what follows the binding is admitted", async () => {
    const f = await start();
    try {
      // The room's history, as the relay hands it to a subscription that has no window yet.
      const history = [
        f.mention(f.owner, HISTORY_SECONDS, "@cto-lpm 점검. 정확히 ALIVE 만 답해"),
        f.mention(f.owner, HISTORY_SECONDS + 60, "두 번째 옛 메시지"),
        f.mention(f.owner, HISTORY_SECONDS + 120, "세 번째 옛 메시지"),
        // One second before the binding's own second is still before it.
        f.mention(f.owner, f.ctoBoundAtSeconds - 1, "바인딩 직전의 메시지"),
      ];
      const before = f.footprint();
      for (const event of history) await f.relayDelivers(event);

      expect(f.footprint()).toEqual(before);
      for (const event of history) expect(f.admitted(event.id)).toBeUndefined();
      expect(f.rowsOf(MessageKind.OWNER_MESSAGE)).toEqual([]);
      expect(f.precedesBinding()).toBe(history.length);
      expect(f.subscriber.counters().admitted).toBe(0);

      // The control, through the same subscription: one signed in the binding's own second — the
      // floor is whole seconds, as `created_at` is — and one after it.
      f.h.clock.advance(5_000);
      const sameSecond = f.mention(f.owner, f.ctoBoundAtSeconds, "바인딩과 같은 초의 지시");
      const after = f.mention(f.owner, f.ctoBoundAtSeconds + 3, "바인딩 뒤의 지시");
      await f.relayDelivers(sameSecond);
      await f.relayDelivers(after);

      expect(f.admitted(sameSecond.id)?.actor).toBe(f.owner.pubkey);
      expect(f.admitted(after.id)?.actor).toBe(f.owner.pubkey);
      expect(f.rowsOf(MessageKind.OWNER_MESSAGE)).toHaveLength(2);
      expect(f.subscriber.counters().admitted).toBe(2);
      expect(f.precedesBinding()).toBe(history.length);
    } finally {
      await f.close();
    }
  });

  it("does not hold back a message signed after the binding while nothing was attached: it is admitted on reconnect and is what the holder claims", async () => {
    const f = await start();
    try {
      // The subscriber's connection drops, and no CTO peer is attached either.
      f.relayDrops();
      f.h.clock.advance(2 * 60_000);
      const whileAway = f.mention(f.owner, f.nowSeconds(), "자리 비운 동안 보낸 지시");
      // An hour passes before anything comes back. The floor is the binding, not the moment the
      // message is finally read: a floor of "now" would refuse this message here.
      f.h.clock.advance(60 * 60_000);
      await f.reconnect();

      // The relay's backlog for this subscription: history from before the binding, then the message.
      await f.relayDelivers(f.mention(f.owner, HISTORY_SECONDS, "@cto-lpm 점검. 정확히 ALIVE 만 답해"));
      await f.relayDelivers(whileAway);

      expect(f.admitted(whileAway.id)?.actor).toBe(f.owner.pubkey);
      expect(f.precedesBinding()).toBe(1);
      const [row, ...rest] = f.rowsOf(MessageKind.OWNER_MESSAGE);
      expect(rest).toEqual([]);
      expect(row?.status).toBe("PENDING");

      // The holder attaches and takes its queue: the message sent while it was away, and only that.
      const taken = ownerMessageLedger(f.h.cp).claim(f.holder());
      expect(claimedText(taken)).toBe("자리 비운 동안 보낸 지시");
    } finally {
      await f.close();
    }
  });

  it("is refused again on every redelivery without a reconnect, and the window moves past it", async () => {
    const f = await start();
    try {
      const old = f.mention(f.owner, HISTORY_SECONDS, "@cto-lpm 점검. 정확히 ALIVE 만 답해");
      const before = f.footprint();
      await f.relayDelivers(old);
      // The relay sends the same event again on the same connection.
      await f.relayDelivers(old);

      expect(f.footprint()).toEqual(before);
      expect(f.admitted(old.id)).toBeUndefined();
      expect(f.precedesBinding()).toBe(2);
      // Terminal: nothing to retry, so the connection stays and no reconnect is scheduled.
      expect(f.live().closed).toBe(false);
      expect(f.timersPending()).toBe(0);
      expect(f.socketsOpened()).toBe(1);

      // Cursor-trusted: the next connection asks from that event on, not for the whole history.
      f.relayDrops();
      const filter = await f.reconnect();
      expect(filter["since"]).toBe(HISTORY_SECONDS);
    } finally {
      await f.close();
    }
  });

  it("refuses the CEO's peer mention signed inside its own generation but before the CTO's binding, and admits one after it", async () => {
    const f = await start({ ceoBoundBeforeCtoMs: 120_000 });
    try {
      // Inside the CEO generation, so the peer rule's own window admits it; before the CTO's binding.
      const early = f.mention(f.ceo, f.ceoBoundAtSeconds() + 30, "CTO 바인딩 이전의 지시");
      expect(early.created_at).toBeLessThan(f.ctoBoundAtSeconds);
      const before = f.footprint();
      await f.relayDelivers(early);

      expect(f.footprint()).toEqual(before);
      expect(f.admitted(early.id)).toBeUndefined();
      expect(f.rowsOf(MessageKind.PEER_MESSAGE)).toEqual([]);
      expect(f.precedesBinding()).toBe(1);

      f.h.clock.advance(5_000);
      const late = f.mention(f.ceo, f.nowSeconds(), "CTO 바인딩 이후의 지시");
      await f.relayDelivers(late);
      expect(f.admitted(late.id)?.actor).toBe(f.ceo.pubkey);
      expect(f.rowsOf(MessageKind.PEER_MESSAGE)).toHaveLength(1);
    } finally {
      await f.close();
    }
  });
});
