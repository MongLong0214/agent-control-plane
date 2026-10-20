import { finalizeEvent } from "nostr-tools/pure";
import { afterAll, describe, expect, it } from "vitest";

import { BUZZ_MENTION_KIND, type BuzzMentionEvent } from "../../src/buzz/buzz-mention-subscriber.ts";
import {
  createBuzzMessageIngress,
  ownerMessageLedger,
  startDaemonBuzzMentionSubscriber,
} from "../../src/daemon/agentcpd.ts";
import { Role, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { buzzMessageNonce } from "../../src/ingress/buzz-message.ts";
import { CeoConversationPort } from "../../src/mcp/ceo-conversation.ts";
import { MessageKind } from "../../src/outbox/envelope.ts";
import { channelKey, steppedClock, storingRelay, writeSubscriberConfig } from "../helpers/buzz-mention-relay.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

const PROJECT = "owner-nonmention";
const ROOM = "room-owner-nonmention";
const OTHER_ROOM = "room-other-project";
const ROLE_KEY = roleKeyFor(Role.PRIMARY_CTO, { projectId: PROJECT });

const start = async () => {
  const dir = tempDir("acp-owner-plain-");
  const owner = channelKey(dir, "owner.key");
  const cto = channelKey(dir, "cto.key");
  const ceo = channelKey(dir, "ceo.key");
  const h = makeHarness({ ownerIdentities: [{ channel: "buzz", actor: owner.pubkey }] });
  h.cp.db.run(`INSERT INTO projects (project_id, name, created_at) VALUES (?, ?, ?)`, [
    PROJECT, PROJECT, h.cp.clock.nowIso(),
  ]);
  const sessions = [cto, ceo].map((key) => {
    const session = h.cp.sessions.create({ provider: "scripted", model: "test", buzzAddress: ROOM });
    expect(h.cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "test").allowed).toBe(true);
    expect(h.cp.sessions.bindBuzzActor({
      sessionId: session.sessionId, sessionSecret: session.sessionSecret!, buzzActorId: key.pubkey,
    }, { isAllowedActor: () => true }).allowed).toBe(true);
    return session;
  });
  expect(h.cp.bindings.bind({ role: Role.PRIMARY_CTO, sessionId: sessions[0]!.sessionId, projectId: PROJECT }).allowed).toBe(true);
  expect(h.cp.bindings.bind({ role: Role.CEO, sessionId: sessions[1]!.sessionId }).allowed).toBe(true);
  // Another subscribed room must still not address this room's CTO.
  writeSubscriberConfig(dir, [{ keyFile: cto.keyFile, rooms: [ROOM, OTHER_ROOM] }]);
  // The credential also permits the CEO; that does not make the CEO an owner.
  const policy = { allowedActors: [owner.pubkey, ceo.pubkey], secret: "owner-unmentioned-test" };
  const seam = createBuzzMessageIngress(h.cp, policy, {
    ceoConversation: new CeoConversationPort(), ownerActors: [owner.pubkey],
  });
  const relay = storingRelay();
  const subscriber = startDaemonBuzzMentionSubscriber(h.cp, dir, policy, { seam }, {
    openSocket: relay.factory, scheduler: steppedClock().scheduler, reportAdmission: () => undefined,
  });
  await relay.drain(subscriber);
  h.clock.advance(1_000);
  const event = (tags: string[][] = [], room = ROOM, author = owner): BuzzMentionEvent => finalizeEvent({
    kind: BUZZ_MENTION_KIND,
    created_at: Math.floor(Date.parse(h.cp.clock.nowIso()) / 1000),
    tags: [["h", room], ...tags],
    content: "야 니들 둘",
  }, author.secretKey);
  const hand = async (message: BuzzMentionEvent) => {
    const connection = relay.openFor(cto.pubkey)[0]!;
    const [subscription] = connection.subscriptions.keys();
    connection.handlers.onFrame(JSON.stringify(["EVENT", subscription, message]));
    await relay.drain(subscriber);
  };
  const messages = () => h.cp.db.all<{ role_key: string; target_session_id: string }>(
    `SELECT role_key, target_session_id FROM outbox WHERE kind = ?`, [MessageKind.OWNER_MESSAGE],
  );
  return {
    h, cto, ceo, owner, sessions, seam, relay, subscriber, event, hand, messages,
    close: () => { subscriber.close(); h.cp.close(); },
  };
};

describe("un-mentioned owner messages through the daemon's Buzz subscriber", () => {
  for (const replyToEventId of [undefined, "a".repeat(64)]) {
    it(`delivers an owner's ${replyToEventId ? "thread reply" : "top-level message"} once to the existing room CTO`, async () => {
      const f = await start();
      try {
        const connection = f.relay.openFor(f.cto.pubkey)[0]!;
        expect([...connection.filterSets.values()][0]).toEqual([
          { kinds: [9], "#p": [f.cto.pubkey], "#h": [ROOM, OTHER_ROOM] },
          { kinds: [9], authors: f.seam.ingress.ownerActors, "#h": [ROOM, OTHER_ROOM] },
        ]);
        const message = f.event(replyToEventId ? [["e", replyToEventId, "", "reply"]] : []);
        f.relay.publish(message);
        await f.relay.drain(f.subscriber);
        // A relay replay of the same event must spend no second nonce or outbox item.
        await f.hand(message);
        expect(f.messages()).toEqual([{ role_key: ROLE_KEY, target_session_id: f.sessions[0]!.sessionId }]);
        expect(f.h.cp.db.get<{ n: number }>(
          `SELECT COUNT(*) AS n FROM inbound_messages WHERE channel = 'buzz' AND nonce = ?`,
          [buzzMessageNonce(message.id)],
        )!.n).toBe(1);
        const binding = f.h.cp.bindings.active(ROLE_KEY)!;
        const claimed = ownerMessageLedger(f.h.cp).claim({
          roleKey: ROLE_KEY,
          bindingGeneration: binding.bindingGeneration,
          targetSessionId: binding.sessionId,
          sessionIncarnation: binding.sessionIncarnation,
        });
        expect(claimed.allowed).toBe(true);
        if (!claimed.allowed) throw new Error(claimed.message);
        expect(claimed.value.claimed).toMatchObject({
          text: "야 니들 둘", principal: "owner",
          provenance: { room: ROOM, eventId: message.id, replyToEventId: replyToEventId ?? null },
        });
        expect(f.h.cp.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sessions`)!.n).toBe(2);
      } finally { f.close(); }
    });
  }

  it("leaves an owner's CEO-only mention to the mention path", async () => {
    const f = await start();
    try {
      const message = f.event([["p", f.ceo.pubkey]]);
      f.relay.publish(message); // Matches the owner filter, but names someone else.
      await f.relay.drain(f.subscriber);
      expect(f.subscriber.counters().rejections["event-not-addressed"]).toBe(1);
      expect(f.messages()).toEqual([]);
    } finally { f.close(); }
  });

  it("delivers an owner CTO mention once even when both filters match and the relay repeats it", async () => {
    const f = await start();
    try {
      const message = f.event([["p", f.cto.pubkey]]);
      f.relay.publish(message);
      await f.relay.drain(f.subscriber);
      await f.hand(message);
      expect(f.messages()).toEqual([{ role_key: ROLE_KEY, target_session_id: f.sessions[0]!.sessionId }]);
      expect(f.subscriber.counters().admitted).toBe(1);
    } finally { f.close(); }
  });

  it("refuses a non-owner's plain message even if the relay bypasses its filters", async () => {
    const f = await start();
    try {
      const message = f.event([], ROOM, f.ceo);
      f.relay.publish(message);
      await f.relay.drain(f.subscriber);
      await f.hand(message);
      expect(f.messages()).toEqual([]);
      expect(f.h.cp.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM inbound_messages`)!.n).toBe(0);
    } finally { f.close(); }
  });

  it.each([OTHER_ROOM, "room-not-subscribed"])("refuses an owner's plain message in %s", async (room) => {
    const f = await start();
    try {
      const message = f.event([], room);
      f.relay.publish(message);
      await f.relay.drain(f.subscriber);
      await f.hand(message);
      expect(f.messages()).toEqual([]);
      expect(f.h.cp.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM inbound_messages`)!.n).toBe(0);
    } finally { f.close(); }
  });

  it("does not treat an empty p tag as un-mentioned", async () => {
    const f = await start();
    try {
      f.relay.publish(f.event([["p"]]));
      await f.relay.drain(f.subscriber);
      expect(f.messages()).toEqual([]);
    } finally { f.close(); }
  });
});
