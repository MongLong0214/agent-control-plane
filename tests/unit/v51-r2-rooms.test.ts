import { finalizeEvent } from "nostr-tools/pure";
import { afterAll, expect, it } from "vitest";

import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { buzzMentionInputFor, createBuzzMessageIngress } from "../../src/daemon/agentcpd.ts";
import { Role, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { deliverBuzzMessage } from "../../src/ingress/buzz-message.ts";
import { CeoConversationPort } from "../../src/mcp/ceo-conversation.ts";
import { channelKey, type ChannelKey } from "../helpers/buzz-mention-relay.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * ACP-R1-04, review round 2 — the role's history in a room is its durable membership record, not
 * a reading of mutable session addresses or the current runtime pointer: moving an existing session
 * into a room does not backdate the role's history there, and a runtime move within the room keeps
 * the first join. Ported from the round-2 review's probes.
 */

const SECRET = "v51-r1-room-history-secret";
const ROOM_A = "room-a-where-the-role-was-bound";
const ROOM_B = "room-b-with-older-history";
const PROJECT = "room-history";

type Harness = ReturnType<typeof makeHarness>;

const readyIn = (h: Harness, room: string, key: ChannelKey) => {
  const session = h.cp.sessions.create({ provider: "scripted", model: "test", buzzAddress: room });
  expect(h.cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "test").allowed).toBe(true);
  expect(h.cp.sessions.bindBuzzActor({ sessionId: session.sessionId, sessionSecret: session.sessionSecret!, buzzActorId: key.pubkey },
    { isAllowedActor: () => true }).allowed).toBe(true);
  return session;
};

const start = () => {
  const dir = tempDir("acp-v51-r1-room-");
  const owner = channelKey(dir, "owner");
  const cto = channelKey(dir, "cto");
  const h = makeHarness({ ownerIdentities: [{ channel: "buzz", actor: owner.pubkey }] });
  h.cp.db.run("INSERT INTO projects (project_id, name, created_at) VALUES (?, ?, ?)", [PROJECT, PROJECT, h.clock.nowIso()]);
  const roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId: PROJECT });
  const first = readyIn(h, ROOM_A, cto);
  const bound = h.cp.bindings.bind({ role: Role.PRIMARY_CTO, projectId: PROJECT, sessionId: first.sessionId });
  if (!bound.allowed) throw new Error(bound.message);
  const seam = createBuzzMessageIngress(h.cp, { allowedActors: [owner.pubkey], secret: SECRET }, {
    ownerActors: [owner.pubkey], ceoConversation: new CeoConversationPort(),
  });
  seam.port.wakeRole = async () => allow(ReasonCode.OK, undefined);
  const boundAtSeconds = Math.floor(h.clock.now().getTime() / 1000);
  const broadcast = (room: string, content: string, createdAt = Math.floor(h.clock.now().getTime() / 1000)) =>
    finalizeEvent({ kind: 9, created_at: createdAt, tags: [["h", room]], content }, owner.secretKey);
  const deliver = (room: string, event: ReturnType<typeof broadcast>) =>
    deliverBuzzMessage(seam.ingress, seam.port, buzzMentionInputFor(seam.ingress, SECRET, {
      roleKey, identityPubkey: cto.pubkey, conversation: room, event, receipt: null,
    }));
  /** Moves the role to a new generation whose runtime answers on `room`, with the same channel identity. */
  const moveTo = (room: string) => {
    h.clock.advance(10_000);
    const current = h.cp.bindings.active(roleKey)!;
    expect(h.cp.sessions.transition(current.sessionId, SessionLifecycle.STOPPED, "moved").allowed).toBe(true);
    const next = readyIn(h, room, cto);
    const switched = h.cp.bindings.switchTo({ role: Role.PRIMARY_CTO, projectId: PROJECT, sessionId: next.sessionId,
      conversation: "REPLACED", reason: "the role moves rooms" });
    if (!switched.allowed) throw new Error(switched.message);
    return next;
  };
  const holder = () => {
    const binding = h.cp.bindings.active(roleKey)!;
    return { roleKey, bindingGeneration: binding.bindingGeneration, targetSessionId: binding.sessionId,
      sessionIncarnation: binding.sessionIncarnation };
  };
  const ownerRows = () => h.cp.db.all<{ message_id: string }>("SELECT message_id FROM outbox WHERE kind = 'OWNER_MESSAGE'");
  return { h, roleKey, boundAtSeconds, broadcast, deliver, moveTo, holder, ownerRows };
};

it("review: changing an existing session's room does not backdate recipient history", async () => {
  const f = start();
  try {
    f.h.clock.advance(1000);
    const old = f.broadcast(ROOM_B, "before the role joined B");
    f.h.clock.advance(10_000);
    f.h.cp.sessions.setBuzzAddress(f.holder().targetSessionId, ROOM_B);
    expect(await f.deliver(ROOM_B, old)).toMatchObject({allowed:false,reasonCode:ReasonCode.BUZZ_MENTION_PRECEDES_BINDING});
    expect(f.ownerRows()).toHaveLength(0);
    // Control: B work signed after the move into B is the role's.
    f.h.clock.advance(1000);
    expect((await f.deliver(ROOM_B, f.broadcast(ROOM_B, "after the role joined B"))).allowed).toBe(true);
    expect(f.ownerRows()).toHaveLength(1);
  } finally { f.h.cp.close(); }
});

it("review: a new runtime in the same room keeps unread mail from its previous runtime", async () => {
  const f = start();
  try {
    const runtimeKey = {pubkey: f.h.cp.sessions.require(f.holder().targetSessionId).buzzActorId!} as ChannelKey;
    const moveRuntime = (room:string) => {
      f.h.clock.advance(10_000);
      const prior = f.holder().targetSessionId;
      expect(f.h.cp.sessions.transition(prior, SessionLifecycle.STOPPED,"runtime moves").allowed).toBe(true);
      const next = readyIn(f.h,room,runtimeKey);
      expect(f.h.cp.bindings.switchTo({role:Role.PRIMARY_CTO,projectId:PROJECT,sessionId:next.sessionId,
        conversation:"SURVIVED",reason:"same conversation moves runtime"}).allowed).toBe(true);

    };
    moveRuntime(ROOM_B);
    f.h.clock.advance(1000);
    const unread = f.broadcast(ROOM_B,"unread during the first B runtime");
    moveRuntime(ROOM_B);
    expect(await f.deliver(ROOM_B, unread)).toMatchObject({allowed:true,reasonCode:ReasonCode.UNTRUSTED_CONTENT_IS_DATA});
    expect(f.ownerRows()).toHaveLength(1);
  } finally { f.h.cp.close(); }
});
