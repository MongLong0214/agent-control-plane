import Database from "better-sqlite3";
import { chmodSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { finalizeEvent } from "nostr-tools/pure";
import { afterAll, expect, it } from "vitest";

import type { BuzzTransport } from "../../src/buzz/buzz-adapter.ts";
import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import {
  buzzMentionInputFor,
  createBuzzMessageIngress,
  startBuzzMessageIngressListener,
  startDaemonBuzzMentionSubscriber,
} from "../../src/daemon/agentcpd.ts";
import { Db } from "../../src/db/database.ts";
import { approveMigration } from "../../src/db/migration-approval.ts";
import { Role, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { deliverBuzzMessage } from "../../src/ingress/buzz-message.ts";
import { CeoConversationPort } from "../../src/mcp/ceo-conversation.ts";
import { channelKey, type ChannelKey, signedMention, steppedClock, storingRelay, writeSubscriberConfig } from "../helpers/buzz-mention-relay.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";
import { carryRows, releasedChainImage } from "../helpers/released-chain-image.ts";
import { privateStatePath } from "../helpers/released-v44-schema.ts";

afterAll(cleanupTempDirs);

/**
 * ACP-R1-04, fourth focused review, within CEO decisions 5f6ab731 and fc5e4bdf. FCR-12: every floor v51
 * derives — the anchor, and the migration itself once the anchor no longer holds — is rounded up to a
 * whole second for admission only, so mail signed in that time's own second is refused and recorded;
 * nothing stored is rounded. FCR-13: the stop window is admitted on the anchor only while nothing has
 * changed since the migration — the binding generation and runtime are the anchored ones, no address
 * change audit for the anchored session and no runtime move were recorded since — so A→B→A or
 * S→T→S cannot revive it. Restart writes preserve admission (r8). Each change that could move a role's room
 * or runtime leaves one of those records, which a census below pins. Ported from the fourth focused
 * review's probes.
 */

const SECRET = "v51-r7-room-history-secret";
const ROOM_A = "room-a-where-the-role-was-bound";
const ROOM_B = "room-b-with-older-history";
const PROJECT = "room-history";

type Harness = ReturnType<typeof makeHarness>;
/** A `role_room_history_unknown` row, as v51 writes it. */
interface UnknownHistory {
  role_key: string; unknown_before: string; room: string | null; known_since: string | null;
  binding_generation: number | null; session_id: string | null; anchor_fallback: string | null; anchor_json: string;
}
const seconds = (iso: string): number => Math.floor(Date.parse(iso) / 1000);

const readyIn = (h: Harness, room: string | null, key: ChannelKey) => {
  const session = h.cp.sessions.create({ provider: "scripted", model: "test", buzzAddress: room });
  expect(h.cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "test").allowed).toBe(true);
  expect(h.cp.sessions.bindBuzzActor({ sessionId: session.sessionId, sessionSecret: session.sessionSecret!, buzzActorId: key.pubkey },
    { isAllowedActor: () => true }).allowed).toBe(true);
  return session;
};

/** A role bound in ROOM_A (or a runtime with no room yet, unbound), with a transport whose next channel is `opens.room`. */
const start = (firstRoom: string | null = ROOM_A) => {
  const dir = tempDir("acp-v51-r7-room-");
  chmodSync(dir, 0o700);
  const owner = channelKey(dir, "owner");
  const cto = channelKey(dir, "cto");
  const opens = { room: ROOM_B };
  const transport: BuzzTransport = {
    available: async () => true,
    openChannel: async () => opens.room,
    send: async () => ({ eventId: "unused", mentionPubkeys: [] }),
  };
  const h = makeHarness({ ownerIdentities: [{ channel: "buzz", actor: owner.pubkey }], buzzTransport: transport });
  h.cp.db.run("INSERT INTO projects (project_id, name, created_at) VALUES (?, ?, ?)", [PROJECT, PROJECT, h.clock.nowIso()]);
  const roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId: PROJECT });
  const first = readyIn(h, firstRoom, cto);
  const bind = (sessionId: string) => {
    const bound = h.cp.bindings.bind({ role: Role.PRIMARY_CTO, projectId: PROJECT, sessionId });
    if (!bound.allowed) throw new Error(bound.message);
    return bound.value;
  };
  // A role with a room is bound at once; one without is bound by the test, after its connect.
  if (firstRoom !== null) bind(first.sessionId);
  const seam = createBuzzMessageIngress(h.cp, { allowedActors: [owner.pubkey], secret: SECRET }, {
    ownerActors: [owner.pubkey], ceoConversation: new CeoConversationPort(),
  });
  seam.port.wakeRole = async () => allow(ReasonCode.OK, undefined);
  const broadcast = (room: string, content: string) =>
    finalizeEvent({ kind: 9, created_at: seconds(h.clock.nowIso()), tags: [["h", room]], content }, owner.secretKey);
  const deliver = (room: string, event: ReturnType<typeof broadcast>) =>
    deliverBuzzMessage(seam.ingress, seam.port, buzzMentionInputFor(seam.ingress, SECRET, {
      roleKey, identityPubkey: cto.pubkey, conversation: room, event, receipt: null,
    }));
  const holder = () => h.cp.bindings.active(roleKey)!;
  /** Moves the role to a new generation whose runtime answers on `room`, with the same channel identity. */
  const moveTo = (room: string) => {
    h.clock.advance(10_000);
    expect(h.cp.sessions.transition(holder().sessionId, SessionLifecycle.STOPPED, "moved").allowed).toBe(true);
    const next = readyIn(h, room, cto);
    const switched = h.cp.bindings.switchTo({ role: Role.PRIMARY_CTO, projectId: PROJECT, sessionId: next.sessionId,
      conversation: "REPLACED", reason: "the role moves rooms" });
    if (!switched.allowed) throw new Error(switched.message);
    return next;
  };
  /** The migration's output — memberships, and its record of unknown history — installed in the live database. */
  const install = (rows: ReadonlyArray<{ role_key: string; conversation: string; joined_at: string }>,
    unknown: readonly UnknownHistory[] = []) => {
    h.cp.db.run("DELETE FROM role_room_memberships WHERE role_key = ?", [roleKey]);
    for (const row of rows.filter((candidate) => candidate.role_key === roleKey)) {
      h.cp.db.run("INSERT INTO role_room_memberships (role_key, conversation, joined_at, session_id) VALUES (?, ?, ?, ?)",
        [row.role_key, row.conversation, row.joined_at, holder()?.sessionId ?? first.sessionId]);
    }
    for (const row of unknown) {
      // Every column the migrated row has, as it has it.
      const columns = Object.keys(row);
      h.cp.db.run(`INSERT INTO role_room_history_unknown (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
        columns.map((column) => (row as unknown as Record<string, unknown>)[column]) as Array<string | number | null>);
    }
  };
  return { h, dir, owner, cto, opens, roleKey, first, bind, broadcast, deliver, holder, moveTo, install };
};
type Fixture = ReturnType<typeof start>;

/** The harness's rows carried into a released v50 image: what a v50 database would hold. */
const v50Image = (f: Fixture, prefix: string, outOfBand?: (raw: Database.Database) => void): string => {
  const path = releasedChainImage(privateStatePath(prefix), 50);
  carryRows(join(f.h.root, "state.sqlite"), path);
  if (outOfBand) {
    const raw = new Database(path);
    try { outOfBand(raw); } finally { raw.close(); }
  }
  return path;
};


/** The full runner on the image, and the wall-clock window the migration ran in. */
const migrated = (path: string) => {
  approveMigration(path, "v51-r7 room history");
  const before = new Date().toISOString();
  const db = new Db(path);
  const after = new Date().toISOString();
  try {
    return {
      before, after,
      rows: db.all<{ role_key: string; conversation: string; joined_at: string }>(
        "SELECT role_key, conversation, joined_at FROM role_room_memberships ORDER BY role_key, joined_at"),
      // Read only where the step created the table, so a database without it shows no record rather than an error.
      unknown: db.all<{ name: string }>("SELECT name FROM sqlite_schema WHERE name = 'role_room_history_unknown'").length === 0 ? []
        : db.all<UnknownHistory>("SELECT * FROM role_room_history_unknown ORDER BY role_key"),
    };
  } finally { db.close(); }
};

/** A daemon's ingress listener and mention subscriber over the harness, fed by a storing relay. */
const daemon = async (f: Fixture, rooms: readonly string[]) => {
  writeSubscriberConfig(f.dir, [{ keyFile: f.cto.keyFile, rooms }]);
  const policy = { allowedActors: [f.owner.pubkey], secret: SECRET };
  const ingress = await startBuzzMessageIngressListener(f.h.cp, f.dir, policy, {
    ceoConversation: new CeoConversationPort(), ownerActors: [f.owner.pubkey],
  });
  const relay = storingRelay();
  const clock = steppedClock();
  const subscriber = startDaemonBuzzMentionSubscriber(f.h.cp, f.dir, policy, ingress, {
    openSocket: relay.factory, scheduler: clock.scheduler, reportAdmission: () => undefined,
  });
  await relay.drain(subscriber);
  return {
    publish: async (event: ReturnType<typeof signedMention>) => { relay.publish(event); await relay.drain(subscriber); },
    subscriber,
    close: async () => { subscriber.close(); await ingress.close(); },
  };
};

const refusalsRecorded = (h: Harness) => h.cp.db.all<{ reason_code: string; role_key: string; actor: string; evidence_json: string }>(
  "SELECT reason_code, role_key, actor, evidence_json FROM audit_events WHERE kind = 'BUZZ_MENTION_REFUSED' ORDER BY event_id",
).map((row) => ({ ...row, evidence_json: JSON.parse(row.evidence_json) as unknown }));

const mention = (f: Fixture, room: string, text: string) =>
  signedMention({ author: f.owner.secretKey, addressedTo: f.cto.pubkey, room, createdAt: seconds(f.h.clock.nowIso()), text });
const ownerMessages = (h: Harness) => h.cp.db.all("SELECT message_id FROM outbox WHERE kind = 'OWNER_MESSAGE'");

/** Moves the role's surviving conversation onto `sessionId` (a same-generation runtime move, recorded). */
const moveRuntime = (f: Fixture, sessionId: string, reason: string) => {
  const moved = f.h.cp.bindings.switchTo({ role: Role.PRIMARY_CTO, projectId: PROJECT, sessionId, conversation: "SURVIVED", reason });
  if (!moved.allowed) throw new Error(moved.message);
};
/** Every mention outcome for a role's room, by name: admitted, refused with a record, or refused without one. */
const outcomeOf = async (f: Fixture, live: Awaited<ReturnType<typeof daemon>>, event: ReturnType<typeof mention>) => {
  const admittedBefore = ownerMessages(f.h).length;
  await live.publish(event);
  if (ownerMessages(f.h).length > admittedBefore) return "admitted";
  return refusalsRecorded(f.h).some((row) => (row.evidence_json as { eventId: string }).eventId === event.id)
    ? "refused and recorded" : "refused unrecorded";
};
const signedIn = (f: Fixture, second: number, text: string) =>
  signedMention({ author: f.owner.secretKey, addressedTo: f.cto.pubkey, room: ROOM_A, createdAt: second, text });
/** Migrates the role's image and installs the output, with the migration's time set to `unknownBefore`. */
const migratedAt = (f: Fixture, prefix: string, unknownBefore: string) => {
  const { rows, unknown } = migrated(v50Image(f, prefix));
  f.install(rows, unknown);
  // The migration's own time, placed exactly (the step writes the wall clock; this pins the boundary).
  f.h.cp.db.run("UPDATE role_room_history_unknown SET unknown_before = ? WHERE role_key = ?", [unknownBefore, f.roleKey]);
  return { rows, unknown };
};

/** A migration at whole second S plus `offsetMs`; the binding then changes; mail signed in S-1, S and S+1. */
const migrationFloorCase = async (offsetMs: number) => {
  const f = start();
  f.h.clock.advance(10_000);
  const wholeSecond = seconds(f.h.clock.nowIso());
  const unknownBefore = new Date(wholeSecond * 1000 + offsetMs).toISOString();
  migratedAt(f, "acp-r7-v50-migration-floor-", unknownBefore);
  f.h.clock.advance(5_000);
  f.moveTo(ROOM_A);
  const live = await daemon(f, [ROOM_A]);
  try {
    const outcomes: Record<string, string> = {};
    for (const [name, second] of [["S-1", wholeSecond - 1], ["S", wholeSecond], ["S+1", wholeSecond + 1]] as const) {
      outcomes[name] = await outcomeOf(f, live, signedIn(f, second, `signed at ${name}`));
    }
    return outcomes;
  } finally { await live.close(); f.h.cp.close(); }
};

it("FCR-12: after the binding changes, a migration 500 ms into S refuses mail signed in S (it may precede the migration) with a record, and admits S+1", async () => {
  expect(await migrationFloorCase(500)).toEqual({ "S-1": "refused and recorded", S: "refused and recorded", "S+1": "admitted" });
});

it("FCR-12 boundary (already held before this change): a migration exactly on S admits mail signed in S and refuses S-1 with a record", async () => {
  expect(await migrationFloorCase(0)).toEqual({ "S-1": "refused and recorded", S: "admitted", "S+1": "admitted" });
});

it.each(["room", "runtime"] as const)("FCR-13: changing the anchored %s away and back after the migration does not revive stop-window authority", async (what) => {
  const f = start();
  try {
    f.h.clock.advance(1000);
    const duringStop = mention(f, ROOM_A, "mail signed during the stop, before the anchor was changed");
    const { rows, unknown } = migrated(v50Image(f, "acp-r7-v50-return-"));
    f.install(rows, unknown);
    f.h.clock.advance(Date.parse(unknown[0]!.unknown_before) + 1000 - Date.parse(f.h.clock.nowIso()));
    if (what === "room") {
      f.h.cp.sessions.setBuzzAddress(f.first.sessionId, ROOM_B);
      f.h.clock.advance(1000);
      f.h.cp.sessions.setBuzzAddress(f.first.sessionId, ROOM_A);
    } else {
      const second = readyIn(f.h, ROOM_B, channelKey(f.dir, "other-runtime"));
      moveRuntime(f, second.sessionId, "post-migration move away");
      f.h.clock.advance(1000);
      moveRuntime(f, f.first.sessionId, "post-migration return");
    }
    const live = await daemon(f, [ROOM_A]);
    try {
      expect(await outcomeOf(f, live, duringStop)).toBe("refused and recorded");
    } finally { await live.close(); }
  } finally { f.h.cp.close(); }
});

it.each([
  ["no change", "admitted", null],
  ["an address change 500 ms after the migration, in its own second", "refused and recorded", "address"],
  ["a same-address write after the migration", "admitted", "same-address"],
  ["any other write to the anchored session after the migration (a pid update)", "admitted", "pid"],
] as const)("FCR-13 / CEO fc5e4bdf: with %s, stop-window mail is %s", async (_what, expected, change) => {
  const f = start();
  try {
    f.h.clock.advance(1000);
    const duringStop = mention(f, ROOM_A, "mail signed during the stop");
    f.h.clock.advance(1000);
    // The migration 200 ms into a second; a change, if any, 500 ms later in that same second.
    f.h.clock.advance(200);
    migratedAt(f, "acp-r7-v50-same-second-", f.h.clock.nowIso());
    f.h.clock.advance(500);
    if (change === "address") {
      f.h.cp.sessions.setBuzzAddress(f.first.sessionId, ROOM_B);
      f.h.cp.sessions.setBuzzAddress(f.first.sessionId, ROOM_A);
    }
    if (change === "same-address") f.h.cp.sessions.setBuzzAddress(f.first.sessionId, ROOM_A);
    if (change === "pid") f.h.cp.sessions.setPid(f.first.sessionId, null);
    const live = await daemon(f, [ROOM_A]);
    try {
      expect(await outcomeOf(f, live, duringStop)).toBe(expected);
    } finally { await live.close(); }
  } finally { f.h.cp.close(); }
});

/**
 * CEO fc5e4bdf (2) — the census the stop-window authority rests on. A role's room or runtime can change
 * only through these writers, and each leaves a record the check reads:
 *   - `sessions.buzz_address`: `SessionRegistry.create` (two INSERTs) makes a new session, which
 *     requires a new binding or a recorded move to become a role's runtime. `setBuzzAddress` writes
 *     SESSION_BUZZ_ADDRESS_CHANGED in its address transaction, including canonical reattach's
 *     correction. Every session writer still stamps updated_at for the pre-migration v50 proof;
 *     unrelated post-migration writes do not invalidate an anchor;
 *   - `conversational_actors.current_session_id`: `BindingRegistry.bind` reusing an actor (in the same
 *     transaction as its new assignment: a new generation), `switchTo` SURVIVED (in the same transaction
 *     as its `BINDING_RUNTIME_MOVED` record); both UPDATE paths also record moves for every active
 *     sibling sharing that actor (a new initiating generation cannot fence a sibling), and `mintActor`'s INSERT (a new actor, minted only by
 *     `bind` and `switchTo` REPLACED, each for its own new assignment);
 *   - `assignments`: INSERT (a new generation) and the revocations, which set only status, revoked_at
 *     and revoked_reason — no writer changes a binding's generation, session or actor in place.
 * A writer added outside this list fails here, and the anchor must not be revived until it is checked.
 * (Schema steps in `migrations.ts` are not runtime writers: they run only during an upgrade, before
 * the stop window this check governs, and v51 is the last of them.)
 */
it("CEO fc5e4bdf (2): every writer of a role's room, runtime and binding leaves a record the stop-window check reads", () => {
  const sessionRegistry = readFileSync(new URL("../../src/session/session-registry.ts", import.meta.url), "utf8");
  const bindingRegistry = readFileSync(new URL("../../src/session/binding-registry.ts", import.meta.url), "utf8");
  // Scan all runtime TS sources: a newly added writer cannot escape a hand-picked file list.
  const sources = readdirSync(new URL("../../src/", import.meta.url), { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".ts") && file !== "db/migrations.ts")
    .map((file) => [file, readFileSync(new URL(`../../src/${file}`, import.meta.url), "utf8")] as const);
  const statements = (text: string, pattern: RegExp) => [...text.matchAll(/`([^`]*)`|'((?:\\.|[^'\\\r\n])*)'|"((?:\\.|[^"\\\r\n])*)"/g)].map((m) => m[1] ?? m[2] ?? m[3]!).filter((sql) => pattern.test(sql));
  // sessions: only SessionRegistry writes, and every statement stamps updated_at.
  for (const [file, text] of sources) {
    const writes = statements(text, /\b(UPDATE\s+sessions\s+SET|INSERT\s+(?:OR\s+\w+\s+)?INTO\s+sessions\s*\()/);
    if (file !== "session/session-registry.ts") expect(writes, file).toEqual([]);
  }
  const sessionWrites = statements(sessionRegistry, /\b(UPDATE\s+sessions\s+SET|INSERT\s+(?:OR\s+\w+\s+)?INTO\s+sessions\s*\()/);
  expect(sessionWrites).toHaveLength(8);
  for (const sql of sessionWrites) expect(sql).toMatch(/\bupdated_at\b/);
  // Post-migration address evidence: creation cannot replace a session; its only UPDATE is audited.
  const addressWrites = sessionWrites.filter((sql) => /\bbuzz_address\b/.test(sql));
  expect(addressWrites).toHaveLength(3);
  expect(addressWrites.filter((sql) => /INSERT INTO sessions/.test(sql))).toHaveLength(2);
  expect(addressWrites.every((sql) => !/REPLACE|ON CONFLICT/.test(sql))).toBe(true);
  const setAddress = sessionRegistry.slice(sessionRegistry.indexOf("  setBuzzAddress("), sessionRegistry.indexOf("  recordRoomMembership("));
  expect(setAddress).toMatch(/this\.db\.tx\([\s\S]*UPDATE sessions SET buzz_address[\s\S]*this\.audit\.record\(\{\s*kind: "SESSION_BUZZ_ADDRESS_CHANGED"/);
  const correction = sources.find(([file]) => file === "registry/canonical-cto-reattach.ts")![1];
  expect(correction).toContain("cp.sessions.setBuzzAddress(held.sessionId, room)");
  // Every assignment insertion (bind/rebind, switch/takeover, renewal) advances generation
  // inside its transaction. A fresh session's address alone never grants a role authority.
  for (const [start, end] of [["  bind(input:", "  switchTo("], ["  switchTo(", "  renewSameSession("],
    ["  renewSameSession(", "  #assertWorkerScope("]] as const) {
    const body = bindingRegistry.slice(bindingRegistry.indexOf(start), bindingRegistry.indexOf(end));
    expect(body).toContain("this.db.txDecision(");
    expect(body).toContain("this.nextGeneration(");
    expect(body).toContain("INSERT INTO assignments");
  }
  // The runtime pointer: three writers, each beside a new generation or a recorded move.
  for (const [file, text] of sources) {
    if (file !== "session/binding-registry.ts") {
      expect(statements(text, /UPDATE\s+conversational_actors\b[\s\S]*\bcurrent_session_id\b|INSERT\s+INTO\s+conversational_actors\b/), file).toEqual([]);
    }
  }
  const pointerWrites = [...bindingRegistry.matchAll(/(UPDATE conversational_actors\s+SET current_session_id|INSERT INTO conversational_actors)/g)];
  expect(pointerWrites).toHaveLength(3);
  for (const write of pointerWrites) {
    const at = write.index!;
    const around = bindingRegistry.slice(at, at + 4000);
    if (write[1]!.startsWith("INSERT")) {
      // mintActor: called only from bind and switchTo REPLACED, each ahead of its own assignment INSERT.
      const calls = [...bindingRegistry.matchAll(/this\.mintActor\(/g)];
      expect(calls).toHaveLength(2);
      for (const call of calls) expect(bindingRegistry.slice(call.index!, call.index! + 2000)).toContain("INSERT INTO assignments");
    } else {
      expect(/INSERT INTO assignments|kind: "BINDING_RUNTIME_MOVED"/.test(around)).toBe(true);
    }
  }
  // Both pointer UPDATEs also record the affected sibling roles, whose generations stay put.
  expect([...bindingRegistry.matchAll(/this\.recordSiblingRuntimeMoves\(/g)]).toHaveLength(2);
  for (const write of pointerWrites.filter((write) => write[1]!.startsWith("UPDATE"))) {
    expect(bindingRegistry.slice(write.index! - 250, write.index!)).toContain("this.recordSiblingRuntimeMoves(");
  }
  const siblings = bindingRegistry.slice(bindingRegistry.indexOf("  private recordSiblingRuntimeMoves("), bindingRegistry.indexOf("  #notifySwitch("));
  expect(siblings).toContain("status = 'ACTIVE' AND role_key <> ?");
  expect(siblings).toContain('kind: "BINDING_RUNTIME_MOVED"');
  expect(siblings).toContain("roleKey: sibling.role_key");
  // assignments: inserted, or revoked; never re-pointed or re-numbered in place.
  for (const [file, text] of sources) {
    for (const sql of statements(text, /\bUPDATE\s+assignments\s+SET\b/)) {
      expect(sql, file).toMatch(/SET status = 'REVOKED', revoked_at = \?, revoked_reason = \?/);
      expect(sql, file).not.toMatch(/binding_generation\s*=|session_id\s*=|actor_id\s*=/);
    }
  }
});
