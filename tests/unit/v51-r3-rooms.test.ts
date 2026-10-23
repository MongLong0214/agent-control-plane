import Database from "better-sqlite3";
import { join } from "node:path";
import { MIGRATIONS, roleRoomMembershipEvidence } from "../../src/db/migrations.ts";
import { approveMigration } from "../../src/db/migration-approval.ts";
import { Db } from "../../src/db/database.ts";
import { carryRows, releasedChainImage } from "../helpers/released-chain-image.ts";
import { privateStatePath } from "../helpers/released-v44-schema.ts";
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
 * ACP-R1-04, review round 3, within CEO decision 9b15c462 and, since the focused reviews, CEO
 * decisions f42efb13 and 1fd967e8 — v51 infers no room history: a creation address, a current address
 * and address audits prove nothing about the past. A role is known in its current room only since its
 * current binding's anchor: the latest of the binding's creation, a runtime move onto its runtime, and
 * that runtime session's last address write (every v50 and v51 address writer stamps `updated_at` in
 * the same statement). Earlier mail there is refused and recorded (see v51-r4-rooms, v51-r5-history).
 * Built on the round-3 review's released-v50-image probes.
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
  /** Moves the role to a new generation on an existing session, with the same channel identity. */
  const moveToSession = (sessionId: string, sessionSecret: string) => {
    h.clock.advance(10_000);
    const current = h.cp.bindings.active(roleKey)!;
    expect(h.cp.sessions.transition(current.sessionId, SessionLifecycle.STOPPED, "moved").allowed).toBe(true);
    expect(h.cp.sessions.bindBuzzActor({ sessionId, sessionSecret, buzzActorId: cto.pubkey }, { isAllowedActor: () => true }).allowed).toBe(true);
    const switched = h.cp.bindings.switchTo({ role: Role.PRIMARY_CTO, projectId: PROJECT, sessionId,
      conversation: "REPLACED", reason: "the role moves to a session whose room is on record" });
    if (!switched.allowed) throw new Error(switched.message);
  };
  const ownerRows = () => h.cp.db.all<{ message_id: string }>("SELECT message_id FROM outbox WHERE kind = 'OWNER_MESSAGE'");
  return { h, roleKey, boundAtSeconds, broadcast, deliver, moveTo, moveToSession, holder, ownerRows };
};

const v51 = MIGRATIONS.find((step) => step.toVersion === 51)!;

/** The harness's rows carried into a released v50 image: what a v50 database would hold. */
const v50Image = (f: ReturnType<typeof start>, prefix: string, outOfBand?: (raw: Database.Database) => void): string => {
  const path = releasedChainImage(privateStatePath(prefix), 50);
  carryRows(join(f.h.root, "state.sqlite"), path);
  if (outOfBand) {
    const raw = new Database(path);
    try { outOfBand(raw); } finally { raw.close(); }
  }
  return path;
};

/** The full runner on the image: approved and opened, and the memberships it wrote. */
const migratedByTheRunner = (path: string) => {
  approveMigration(path, "v51-r3 room history");
  const db = new Db(path);
  try {
    const rows = db.all<{ role_key: string; conversation: string; joined_at: string }>(
      "SELECT role_key, conversation, joined_at FROM role_room_memberships ORDER BY role_key, joined_at");
    return { rows };
  } finally { db.close(); }
};

/** The v51 step's memberships on the image, in a transaction rolled back afterwards. */
const membershipsOf = (path: string) => {
  const raw = new Database(path);
  try {
    raw.exec("BEGIN IMMEDIATE");
    v51.apply(raw);
    const rows = raw.prepare("SELECT role_key, conversation, joined_at FROM role_room_memberships ORDER BY role_key, joined_at").all();
    raw.exec("ROLLBACK");
    return rows;
  } finally { raw.close(); }
};

it("R3 migration probe: a v50-image address change does not backdate B membership; the audited history migrates exactly", async () => {
  const f = start();
  try {
    const boundAt = f.h.cp.bindings.active(f.roleKey)!.createdAt;
    f.h.clock.advance(1000);
    const old = f.broadcast(ROOM_B, "before the v50 role joined B");
    f.h.clock.advance(10_000);
    const changedAt = f.h.clock.nowIso();
    f.h.cp.sessions.setBuzzAddress(f.holder().targetSessionId, ROOM_B);
    const path = v50Image(f, "acp-r3-v50-room-");
    // No history is inferred (CEO 1fd967e8): the role is known in B since the address was written there.
    expect(boundAt < changedAt).toBe(true);
    expect(membershipsOf(path)).toEqual([{ role_key: f.roleKey, conversation: ROOM_B, joined_at: changedAt }]);
    // The migration's own output, installed into the live ingress, refuses B's pre-join broadcast and
    // admits B work after the join.
    f.h.cp.db.run("UPDATE role_room_memberships SET joined_at = ? WHERE role_key = ? AND conversation = ?", [changedAt, f.roleKey, ROOM_B]);
    expect(await f.deliver(ROOM_B, old)).toMatchObject({ allowed: false, reasonCode: ReasonCode.BUZZ_MENTION_PRECEDES_BINDING });
    f.h.clock.advance(1000);
    expect((await f.deliver(ROOM_B, f.broadcast(ROOM_B, "after the join"))).allowed).toBe(true);
  } finally { f.h.cp.close(); }
});

it("R3 migration probe: an in-place address change without an audit trail is never backdated; the room is known since that write", () => {
  const f = start();
  try {
    // The runtime's room A is on record (an audited address assignment) before the role is moved onto it.
    f.h.clock.advance(1000);
    const runtime = f.h.cp.sessions.create({ provider: "scripted", model: "audited-room" });
    expect(f.h.cp.sessions.transition(runtime.sessionId, SessionLifecycle.READY, "test").allowed).toBe(true);
    f.h.cp.sessions.setBuzzAddress(runtime.sessionId, ROOM_A);
    f.moveToSession(runtime.sessionId, runtime.sessionSecret!);
    // Then its room changes with no audit, through v50's own setter statement.
    f.h.clock.advance(5000);
    const writtenAt = f.h.clock.nowIso();
    const path = v50Image(f, "acp-r3-v50-unaudited-", (raw) => {
      raw.prepare("UPDATE sessions SET buzz_address = ?, updated_at = ? WHERE session_id = ?").run(ROOM_B, writtenAt, runtime.sessionId);
    });
    const raw = new Database(path, { readonly: true });
    try {
      const judged = roleRoomMembershipEvidence(raw);
      expect(judged.refusals).toEqual([]);
      expect(judged.anchored).toEqual([expect.objectContaining({ roleKey: f.roleKey, room: ROOM_B, sessionId: runtime.sessionId,
        sessionUpdatedAt: writtenAt, knownSince: writtenAt })]);
    } finally { raw.close(); }
    expect(migratedByTheRunner(path).rows).toEqual([{ role_key: f.roleKey, conversation: ROOM_B, joined_at: writtenAt }]);
  } finally { f.h.cp.close(); }
});

it("R3 migration probe: same-generation runtime moves across rooms prove no history; the current room is known since the move onto its runtime", () => {
  const f = start();
  try {
    const runtimeKey = { pubkey: f.h.cp.sessions.require(f.holder().targetSessionId).buzzActorId! } as ChannelKey;
    const moveRuntime = () => {
      f.h.clock.advance(10_000);
      expect(f.h.cp.sessions.transition(f.holder().targetSessionId, SessionLifecycle.STOPPED, "runtime moves").allowed).toBe(true);
      const next = readyIn(f.h, ROOM_B, runtimeKey);
      expect(f.h.cp.bindings.switchTo({ role: Role.PRIMARY_CTO, projectId: PROJECT, sessionId: next.sessionId, conversation: "SURVIVED",
        reason: "same conversation moves runtime" }).allowed).toBe(true);
    };
    moveRuntime();
    f.h.clock.advance(1000);
    moveRuntime();
    const movedAt = f.h.clock.nowIso();
    const path = v50Image(f, "acp-r3-v50-runtime-room-");
    // Known since the last runtime move onto the current runtime, the latest of the anchor's parts.
    const raw = new Database(path, { readonly: true });
    try {
      expect(roleRoomMembershipEvidence(raw).anchored).toEqual([expect.objectContaining({ roleKey: f.roleKey, room: ROOM_B,
        sessionId: f.holder().targetSessionId, runtimeMovedAt: movedAt, knownSince: movedAt })]);
    } finally { raw.close(); }
    expect(migratedByTheRunner(path).rows).toEqual([{ role_key: f.roleKey, conversation: ROOM_B, joined_at: movedAt }]);
  } finally { f.h.cp.close(); }
});

it("R3 migration: a single-room history is known only since the current binding's anchor, never from its earliest binding", () => {
  const f = start();
  try {
    const boundAt = f.h.cp.bindings.active(f.roleKey)!.createdAt;
    f.moveTo(ROOM_A);
    f.moveTo(ROOM_A);
    const anchorAt = f.h.cp.bindings.active(f.roleKey)!.createdAt;
    const path = v50Image(f, "acp-r3-v50-single-room-");
    const { rows } = migratedByTheRunner(path);
    expect(rows).toEqual([{ role_key: f.roleKey, conversation: ROOM_A, joined_at: anchorAt }]);
    expect(rows[0]!.joined_at).not.toBe(boundAt);
  } finally { f.h.cp.close(); }
});
