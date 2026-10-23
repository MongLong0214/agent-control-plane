import { chmodSync } from "node:fs";

import { afterAll, expect, it } from "vitest";

import type { BuzzMentionEvent } from "../../src/buzz/buzz-mention-subscriber.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import {
  rejudgeBuzzMentionSubscriberOnBindingSwitch,
  startBuzzMessageIngressListener,
  startDaemonBuzzMentionSubscriber,
} from "../../src/daemon/agentcpd.ts";
import { Role, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { buzzMessageNonce } from "../../src/ingress/buzz-message.ts";
import { CeoConversationPort } from "../../src/mcp/ceo-conversation.ts";
import { MessageKind } from "../../src/outbox/envelope.ts";
import { channelKey, type ChannelKey, signedMention, steppedClock, storingRelay, writeSubscriberConfig } from "../helpers/buzz-mention-relay.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

// The stable role floor retains mail signed while a holder is unavailable.

const SECRET = "buzz-precedes-binding-record-secret";
const PROJECT = "repo-factory";
const ROOM = "room-repo-factory";
const REDELIVERIES = 3;

type Harness = ReturnType<typeof makeHarness>;
const secondsOf = (iso: string): number => Math.floor(Date.parse(iso) / 1000);

const liveSession = (h: Harness, key: ChannelKey): string => {
  const session = h.cp.sessions.create({ provider: "scripted", model: "cto", buzzAddress: ROOM });
  expect(h.cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "test").reasonCode).toBe(ReasonCode.OK);
  const bound = h.cp.sessions.bindBuzzActor(
    { sessionId: session.sessionId, sessionSecret: session.sessionSecret!, buzzActorId: key.pubkey },
    { isAllowedActor: () => true },
  );
  if (!bound.allowed) throw new Error(`channel identity binding failed: ${bound.message}`);
  return session.sessionId;
};

it("retains mail signed during exclusion across replacement and relay redelivery", async () => {
  const dir = tempDir("acp-bpb-");
  chmodSync(dir, 0o700);
  const cto = channelKey(dir, "cto.key");
  const owner = channelKey(dir, "owner.key");
  const h = makeHarness({ ownerIdentities: [{ channel: "buzz", actor: owner.pubkey }] });
  const roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId: PROJECT });
  h.cp.db.run(`INSERT INTO projects (project_id, name, created_at) VALUES (?, ?, ?)`, [PROJECT, PROJECT, h.cp.clock.nowIso()]);
  const first = liveSession(h, cto);
  expect(h.cp.bindings.bind({ role: Role.PRIMARY_CTO, sessionId: first, projectId: PROJECT }).allowed).toBe(true);

  writeSubscriberConfig(dir, [{ keyFile: cto.keyFile, rooms: [ROOM] }]);
  const policy = { allowedActors: [owner.pubkey], secret: SECRET };
  const ingress = await startBuzzMessageIngressListener(h.cp, dir, policy, {
    ceoConversation: new CeoConversationPort(),
    ownerActors: [owner.pubkey],
  });
  const relay = storingRelay();
  const clock = steppedClock();
  const subscriber = startDaemonBuzzMentionSubscriber(h.cp, dir, policy, ingress, {
    openSocket: relay.factory,
    scheduler: clock.scheduler,
    reportAdmission: () => undefined,
  });
  rejudgeBuzzMentionSubscriberOnBindingSwitch(h.cp, () => subscriber);
  const mention = (text: string): BuzzMentionEvent =>
    signedMention({ author: owner.secretKey, addressedTo: cto.pubkey, room: ROOM, createdAt: secondsOf(h.cp.clock.nowIso()), text });
  const ownerMessagesFor = (sessionId: string) =>
    h.cp.db.all(`SELECT message_id FROM outbox WHERE kind = ? AND target_session_id = ?`, [MessageKind.OWNER_MESSAGE, sessionId]).length;
  const inboundRows = (eventId: string): number =>
    h.cp.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM inbound_messages WHERE channel = 'buzz' AND nonce = ?`, [
      buzzMessageNonce(eventId, roleKey),
    ])!.n;

  try {
    await relay.drain(subscriber);
    h.clock.advance(1_000);
    relay.publish(mention("before the pause"));
    await relay.drain(subscriber);
    expect(subscriber.counters().admitted).toBe(1);

    // Paused: the binding is revoked and the identity is excluded.
    expect(h.cp.bindings.revoke(roleKey, "owner pause").allowed).toBe(true);
    await relay.drain(subscriber);
    h.clock.advance(1_000);
    const duringExclusion = mention("sent while the CTO was paused");
    relay.publish(duringExclusion);
    await relay.drain(subscriber);

    // Re-claimed by a new session at the next generation.
    h.clock.advance(1_000);
    expect(h.cp.sessions.transition(first, SessionLifecycle.STOPPED, "replaced").reasonCode).toBe(ReasonCode.OK);
    const next = liveSession(h, cto);
    expect(h.cp.bindings.bind({ role: Role.PRIMARY_CTO, sessionId: next, projectId: PROJECT }).allowed).toBe(true);
    await relay.drain(subscriber);

    // The window is inclusive, so every reconnect hands the boundary event back.
    for (let drop = 0; drop < REDELIVERIES; drop += 1) {
      const live = relay.openFor(cto.pubkey).at(-1)!;
      live.closed = true;
      live.handlers.onClose();
      clock.fireAll();
      await relay.drain(subscriber);
    }

    expect(inboundRows(duringExclusion.id)).toBe(1);
    expect(ownerMessagesFor(next)).toBe(2);
    expect(subscriber.counters().admitted).toBe(2);
    expect(subscriber.counters().rejections["admission-precedes-binding"] ?? 0).toBe(0);
    expect(subscriber.admission().identities[0]?.notDelivered ?? []).toEqual([]);

    // New mail joins the retained work on the current holder.
    h.clock.advance(1_000);
    relay.publish(mention("after the re-claim"));
    await relay.drain(subscriber);
    expect(ownerMessagesFor(next)).toBe(3);
    expect(inboundRows(duringExclusion.id)).toBe(1);
  } finally {
    subscriber.close();
    await ingress.close();
    h.cp.close();
  }
});
