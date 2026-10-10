import { chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, expect, it } from "vitest";

import type { BuzzMentionEvent } from "../../src/buzz/buzz-mention-subscriber.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import {
  rejudgeBuzzMentionSubscriberOnBindingSwitch,
  startBuzzMessageIngressListener,
  startDaemonBuzzMentionSubscriber,
} from "../../src/daemon/agentcpd.ts";
import { Daemon } from "../../src/daemon/daemon.ts";
import { Role, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { buzzMessageNonce } from "../../src/ingress/buzz-message.ts";
import { CeoConversationPort } from "../../src/mcp/ceo-conversation.ts";
import { MessageKind } from "../../src/outbox/envelope.ts";
import { channelKey, type ChannelKey, signedMention, steppedClock, storingRelay, writeSubscriberConfig } from "../helpers/buzz-mention-relay.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * A mention signed while its CTO identity was excluded, before the binding that re-claimed the role,
 * is history for that binding and not work for it.
 *
 * The seam's floor refuses it and writes nothing, and that refusal stays. What this pins is the
 * subscriber's side of it: the event is never promoted into an execution request for the new
 * binding, it is not counted as processed or delivered, the seam is asked about it once rather
 * than on every redelivery the inclusive window brings, and its event id and reason stay readable.
 */

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

it("leaves a mention signed during exclusion undelivered, asks the seam about it once, and keeps its id and reason", async () => {
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
      buzzMessageNonce(eventId),
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
    const generation = h.cp.bindings.active(roleKey)!.bindingGeneration;

    // The window is inclusive, so every reconnect hands the boundary event back.
    for (let drop = 0; drop < REDELIVERIES; drop += 1) {
      const live = relay.openFor(cto.pubkey).at(-1)!;
      live.closed = true;
      live.handlers.onClose();
      clock.fireAll();
      await relay.drain(subscriber);
    }

    // Not delivered: no inbound row, no execution request for either session, not counted.
    expect(inboundRows(duringExclusion.id)).toBe(0);
    expect(ownerMessagesFor(next)).toBe(0);
    expect(subscriber.counters().admitted).toBe(1);

    // Bounded: the seam refused it once (and the pre-pause mention once, as a spent id under the new
    // generation); each later redelivery was recognised and not submitted again.
    const counters = subscriber.counters();
    expect(counters.rejections["admission-precedes-binding"]).toBe(2);
    expect(counters.rejections["precedes-binding-not-resubmitted"]).toBe(REDELIVERIES);

    // Recoverable: its event id and reason, readable from the subscriber and from health.json.
    const record = {
      eventId: duringExclusion.id,
      roleKey,
      bindingGeneration: generation,
      conversation: ROOM,
      signedAtSeconds: duringExclusion.created_at,
      outcome: "NOT_DELIVERED",
      reason: "PRECEDES_BINDING",
      seamRefusals: 1,
      redeliveriesNotResubmitted: REDELIVERIES,
    };
    expect(subscriber.admission().identities[0]?.notDelivered).toContainEqual(expect.objectContaining(record));
    const daemon = new Daemon(h.cp, { stateDir: dir });
    daemon.setBuzzMentionReceipt({ configuredIdentities: subscriber.socketCount, counters: () => subscriber.counters() });
    const health = JSON.parse(readFileSync(join(dir, "health.json"), "utf8")) as {
      buzzMention: { admission: { identities: { notDelivered: unknown[] }[] } };
    };
    expect(health.buzzMention.admission.identities[0]?.notDelivered).toContainEqual(expect.objectContaining(record));

    // A mention signed after the re-claim is the new binding's, and is the only thing it receives.
    h.clock.advance(1_000);
    relay.publish(mention("after the re-claim"));
    await relay.drain(subscriber);
    expect(ownerMessagesFor(next)).toBe(1);
    expect(inboundRows(duringExclusion.id)).toBe(0);
  } finally {
    subscriber.close();
    await ingress.close();
    h.cp.close();
  }
});
