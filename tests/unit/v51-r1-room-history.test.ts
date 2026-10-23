import { finalizeEvent } from "nostr-tools/pure";
import { afterAll, expect, it } from "vitest";

import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { buzzMentionInputFor, createBuzzMessageIngress, ownerMessageLedger } from "../../src/daemon/agentcpd.ts";
import { Role, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { deliverBuzzMessage } from "../../src/ingress/buzz-message.ts";
import { CeoConversationPort } from "../../src/mcp/ceo-conversation.ts";
import { channelKey, type ChannelKey } from "../helpers/buzz-mention-relay.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * ACP-R1-04 — historical suppression is judged against the recipient role's own history in the
 * room the event arrived on, never against the role's history in some other room. Same-room mail
 * signed while a holder was replaced still reaches the role (#5).
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

it("refuses a room's retained broadcast signed before the role ever answered in that room, though the role was bound elsewhere", async () => {
  const f = start();
  try {
    f.h.clock.advance(1000);
    // Signed in room B while the role answered only in room A: the role was not its recipient.
    const old = f.broadcast(ROOM_B, "room B history from before the role joined it");
    f.moveTo(ROOM_B);
    const refused = await f.deliver(ROOM_B, old);
    expect(refused).toMatchObject({ allowed: false, reasonCode: ReasonCode.BUZZ_MENTION_PRECEDES_BINDING });
    expect(f.ownerRows()).toHaveLength(0);

    // Control: room B work signed after the role joined it is the role's.
    f.h.clock.advance(1000);
    const fresh = f.broadcast(ROOM_B, "room B work after the role joined it");
    expect((await f.deliver(ROOM_B, fresh)).allowed).toBe(true);
    expect(f.ownerRows()).toHaveLength(1);
  } finally { f.h.cp.close(); }
});

it("keeps same-room mail signed between two generations, judged against the role's history in that room", async () => {
  const f = start();
  try {
    f.h.clock.advance(1000);
    // Signed in room A after the role's first binding there, while its holder was being replaced.
    const unread = f.broadcast(ROOM_A, "same-room unread mail across a generation change");
    f.moveTo(ROOM_A);
    f.moveTo(ROOM_A);
    const admitted = await f.deliver(ROOM_A, unread);
    expect(admitted.allowed).toBe(true);
    const ledger = ownerMessageLedger(f.h.cp);
    const taken = ledger.claim(f.holder());
    expect(taken).toMatchObject({ allowed: true, value: { claimed: { text: "same-room unread mail across a generation change" } } });
    if (!taken.allowed || !taken.value.claimed) throw new Error("the retained mail was not handed over");
    expect(ledger.complete(taken.value.claimed.messageId, f.holder()).allowed).toBe(true);

    // First-binding suppression in the room is unchanged: history signed before the role's first
    // binding in room A is still refused.
    const ancient = f.broadcast(ROOM_A, "room A history from before the role's first binding", f.boundAtSeconds - 60);
    expect(await f.deliver(ROOM_A, ancient)).toMatchObject({ allowed: false, reasonCode: ReasonCode.BUZZ_MENTION_PRECEDES_BINDING });
    expect(f.ownerRows()).toHaveLength(1);
  } finally { f.h.cp.close(); }
});
