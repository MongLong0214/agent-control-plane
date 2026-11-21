import { afterAll, describe, expect, it } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";

import { BuzzChannelRelay } from "../../src/buzz/buzz-channel.ts";
import { answeredSinceReader, ceoPubkeysFromDb, queuedBuzzBacklog } from "../../src/buzz/buzz-channel-daemon-reads.ts";
import { Role, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { MessageKind } from "../../src/outbox/envelope.ts";
import { cleanupTempDirs, makeCore, makeRepo, seedRun } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * What a CTO's channel reads from the daemon's own database, read the way the daemon reads it. Two live
 * facts shaped these rows (Logic Pro MCP, 2026-11-18): the current CEO session carried no Buzz identity and the
 * daemon admitted the CEO through the identity of an older binding, which a channel that read only the live
 * session did not; and 53 Buzz messages sat PENDING in the queue with nothing to deliver them.
 */

const ROOM = "6dcb2a67-b130-4c3c-8280-c32756a1c26a";
const ceo = generateSecretKey();
const ceoPub = getPublicKey(ceo);
const cto = generateSecretKey();
const ctoPub = getPublicKey(cto);

describe("the CEO's key is resolved by the daemon's own rule", () => {
  /** Two CEO bindings: an older session that has the identity, and the current one that has none. */
  const liveShaped = () => {
    const core = makeCore();
    const identified = core.sessions.create({ provider: "scripted", model: "ceo-old" });
    core.sessions.transition(identified.sessionId, SessionLifecycle.READY, "test");
    const bound = core.sessions.bindBuzzActor({ sessionId: identified.sessionId, sessionSecret: identified.sessionSecret!, buzzActorId: ceoPub }, { isAllowedActor: () => true });
    if (!bound.allowed) throw new Error(bound.message);
    const ceoRole = roleKeyFor(Role.CEO);
    expect(core.bindings.bind({ roleKey: ceoRole, role: Role.CEO, sessionId: identified.sessionId }).allowed).toBe(true);
    // The CEO moved on: the old binding is revoked, and the current session was never bound to a Buzz identity.
    expect(core.bindings.revoke(ceoRole, "the CEO session was replaced").allowed).toBe(true);
    const current = core.sessions.create({ provider: "scripted", model: "ceo-current" });
    core.sessions.transition(current.sessionId, SessionLifecycle.READY, "test");
    expect(core.bindings.bind({ roleKey: ceoRole, role: Role.CEO, sessionId: current.sessionId }).allowed).toBe(true);
    return { core, current, identified };
  };

  it("falls back to the latest identified CEO binding when the current CEO session has an empty buzz_actor_id", () => {
    const { core, current } = liveShaped();
    expect(core.db.get<{ buzz_actor_id: string | null }>("SELECT buzz_actor_id FROM sessions WHERE session_id = ?", [current.sessionId])?.buzz_actor_id ?? "").toBe("");
    // The rule the channel used before: only the live session's own identity. On this database it hears nobody.
    expect(core.db.all(
      `SELECT DISTINCT s.buzz_actor_id FROM assignments a JOIN sessions s ON s.session_id = a.session_id
        WHERE a.role_key = 'CEO' AND a.status = 'ACTIVE' AND s.lifecycle IN ('READY','DRAINING') AND COALESCE(s.buzz_actor_id, '') <> ''`,
      [],
    )).toEqual([]);
    expect(ceoPubkeysFromDb(core.db)).toEqual([ceoPub]);
  });

  it("delivers a mention from that CEO, which a channel reading only the live session would have dropped as an unbound actor", () => {
    const { core } = liveShaped();
    const relay = new BuzzChannelRelay({
      relayUrl: "wss://relay.example.test",
      projectId: "prj_logic",
      secretKey: cto,
      rooms: [ROOM],
      ceoPubkeys: () => ceoPubkeysFromDb(core.db),
      ownerPubkeys: [],
      onNotification: async () => undefined,
    });
    const mention = finalizeEvent({ kind: 9, created_at: 1_794_994_481, tags: [["h", ROOM], ["e", "ab".repeat(32), "", "root"], ["e", "cd".repeat(32), "", "reply"], ["p", ctoPub]], content: "@cto-lpm HOLD" }, ceo);
    expect(relay.classify(mention)).toMatchObject({ deliver: true, role: "ceo", room: ROOM });
  });

  it("prefers the live session's own identity when it has one, and hears nobody when no CEO is bound", () => {
    const core = makeCore();
    expect(ceoPubkeysFromDb(core.db)).toEqual([]);
    const own = core.sessions.create({ provider: "scripted", model: "ceo" });
    core.sessions.transition(own.sessionId, SessionLifecycle.READY, "test");
    const other = getPublicKey(generateSecretKey());
    core.sessions.bindBuzzActor({ sessionId: own.sessionId, sessionSecret: own.sessionSecret!, buzzActorId: other }, { isAllowedActor: () => true });
    core.bindings.bind({ roleKey: roleKeyFor(Role.CEO), role: Role.CEO, sessionId: own.sessionId });
    expect(ceoPubkeysFromDb(core.db)).toEqual([other]);
  });
});

describe("the queue's pending Buzz messages for the role, read for the channel", () => {
  const T0 = Date.parse("2026-01-01T00:00:00.000Z") / 1000;
  const signed = (content: string, at: number, room = ROOM) =>
    finalizeEvent({ kind: 9, created_at: at, tags: [["h", room], ["p", ctoPub]], content }, ceo);

  /** One admitted Buzz message in the queue, the way admission leaves it: a pointer on the row and the signed event beside it. */
  const queue = (core: ReturnType<typeof makeCore>, seeded: ReturnType<typeof seedRun>, event: ReturnType<typeof signed>, generation = seeded.generation) => {
    const nonce = `buzz-message:${event.id}:${"cd".repeat(32)}`;
    core.db.run("INSERT INTO buzz_events (event_id, payload_json) VALUES (?, ?)", [event.id, JSON.stringify(event)]);
    const enqueued = core.outbox.enqueue({
      idempotencyKey: `m:${event.id}`,
      roleKey: seeded.roleKey,
      bindingGeneration: generation,
      targetSessionId: seeded.sessionId,
      runId: seeded.runId,
      kind: MessageKind.PEER_MESSAGE,
      payload: { sourceChannel: "buzz", sourceNonce: nonce, sourcePayloadDigest: "sha256:digest" },
    });
    if (!enqueued.allowed) throw new Error(enqueued.message);
    core.clock.advance?.(1_000);
    return enqueued.value.messageId;
  };

  const seed = () => {
    const core = makeCore();
    const seeded = seedRun({ db: core.db, clock: core.clock, repoPath: makeRepo() });
    return { core, seeded, projectId: seeded.roleKey.slice("PRIMARY_CTO:".length) };
  };

  it("lists the pending messages for the role at its current binding, oldest first, each with its signed event", () => {
    const { core, seeded, projectId } = seed();
    const events = [signed("first", T0 + 100), signed("second", T0 + 200), signed("third", T0 + 300)];
    for (const event of events) queue(core, seeded, event);
    const backlog = queuedBuzzBacklog(core.db, projectId);
    expect(backlog.map((m) => m.eventId)).toEqual(events.map((e) => e.id));
    expect(backlog.map((m) => m.event.content)).toEqual(["first", "second", "third"]);
    expect(backlog[0]!.event.sig).toBe(events[0]!.sig);
  });

  it("leaves out what is not owed to this binding: another role's, an earlier generation's, a message already handed over, and one with no retained event", () => {
    const { core, seeded, projectId } = seed();
    const mine = signed("mine", T0 + 100);
    queue(core, seeded, mine);
    const earlier = signed("older generation", T0 + 150);
    const earlierId = queue(core, seeded, earlier);
    core.db.run("UPDATE outbox SET binding_generation = ? WHERE message_id = ?", [seeded.generation + 5, earlierId]);
    const handed = signed("handed over", T0 + 160);
    const handedId = queue(core, seeded, handed);
    core.db.run("UPDATE outbox SET status = 'SENT', sent_at = ? WHERE message_id = ?", [core.clock.nowIso(), handedId]);
    core.outbox.enqueue({ idempotencyKey: "no-event", roleKey: seeded.roleKey, bindingGeneration: seeded.generation, targetSessionId: seeded.sessionId, runId: seeded.runId, kind: MessageKind.PEER_MESSAGE,
      payload: { sourceChannel: "buzz", sourceNonce: `buzz-message:${"ee".repeat(32)}:${"cd".repeat(32)}`, sourcePayloadDigest: "sha256:digest" } });
    expect(queuedBuzzBacklog(core.db, projectId).map((m) => m.event.content)).toEqual(["mine"]);
    expect(queuedBuzzBacklog(core.db, "prj_someone_else")).toEqual([]);
  });

  it("skips a message whose event was signed before the role's known history in that room, the rule the daemon refuses it by", () => {
    const { core, seeded, projectId } = seed();
    core.db.run("INSERT INTO role_room_memberships (role_key, conversation, joined_at, session_id) VALUES (?, ?, ?, ?)",
      [seeded.roleKey, ROOM, "2026-01-01T00:05:00.500Z", seeded.sessionId]);
    queue(core, seeded, signed("before the floor", T0 + 299));
    queue(core, seeded, signed("just before it, in the same second", T0 + 300));
    queue(core, seeded, signed("at the floor", T0 + 301));
    queue(core, seeded, signed("after", T0 + 400));
    // Buzz signs whole seconds, so the floor rounds up to the next whole second: T0 + 301.
    expect(queuedBuzzBacklog(core.db, projectId).map((m) => m.event.content)).toEqual(["at the floor", "after"]);
  });
});

describe("how far back the channel asks for the CTO's own replies", () => {
  it("is an hour before the oldest Buzz message still queued for the CTO, and nothing when none is", () => {
    const opener = (at: string | null) => () => ({ reads: { get: <T>() => ({ at }) as T, all: <T>() => [] as T[] }, close: () => undefined });
    expect(answeredSinceReader("/unused", "prj_logic", opener("2026-11-18T09:33:09.968Z"))()).toBe(Math.floor(Date.parse("2026-11-18T09:33:09.968Z") / 1000) - 3600);
    expect(answeredSinceReader("/unused", "prj_logic", opener(null))()).toBeNull();
  });
});
