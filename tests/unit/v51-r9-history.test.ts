import Database from "better-sqlite3";
import { chmodSync } from "node:fs";
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

// Focused5 witnesses: equal-clock changes must invalidate the migrated anchor, and every
// migration-derived comparison floor must round up without changing the stored precision.

const SECRET = "v51-r7-room-history-secret";
const ROOM_A = "room-a-where-the-role-was-bound";
const ROOM_B = "room-b-with-older-history";
const PROJECT = "room-history";

type Harness = ReturnType<typeof makeHarness>;
/** A `role_room_history_unknown` row, as v51 writes it. */
interface UnknownHistory {
  role_key: string; unknown_before: string; room: string | null; known_since: string | null;
  binding_generation: number | null; session_id: string | null; anchor_fallback: string | null; anchor_json: string; audit_high_water: number;
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

it.each(["room", "runtime"] as const)("FCR-15: a post-migration %s return at equal millisecond must invalidate", async (what) => {
  const f = start();
  try {
    f.h.clock.advance(1000);
    const duringStop = mention(f, ROOM_A, "not previously admitted");
    f.h.clock.advance(1200);
    const migrationTime = f.h.clock.nowIso();
    const highWater = f.h.cp.db.get<{ high_water: number }>("SELECT MAX(event_id) AS high_water FROM audit_events")!.high_water;
    const { unknown } = migratedAt(f, "acp-focused5-equal-", migrationTime);
    if (what === "room") {
      f.h.cp.sessions.setBuzzAddress(f.first.sessionId, ROOM_B);
      f.h.cp.sessions.setBuzzAddress(f.first.sessionId, ROOM_A);
    } else {
      const second = readyIn(f.h, ROOM_B, channelKey(f.dir, "other"));
      moveRuntime(f, second.sessionId, "away after migration");
      moveRuntime(f, f.first.sessionId, "return after migration");
    }
    const live = await daemon(f, [ROOM_A]);
    try {
      const outcome = await outcomeOf(f, live, duringStop);
      expect(f.h.cp.audit.byKind(what === "room" ? "SESSION_BUZZ_ADDRESS_CHANGED" : "BINDING_RUNTIME_MOVED").slice(-2).map(row => row.at)).toEqual([migrationTime, migrationTime]);
      expect(outcome).toBe("refused and recorded");
      expect(unknown[0]!.audit_high_water).toBe(highWater);
      expect(f.h.cp.audit.byKind(what === "room" ? "SESSION_BUZZ_ADDRESS_CHANGED" : "BINDING_RUNTIME_MOVED").slice(-2)
        .every(row => row.eventId > highWater)).toBe(true);
    } finally { await live.close(); }
  } finally { f.h.cp.close(); }
});

it("FCR-16: fallback migration floor must refuse a signed event in its fractional second", async () => {
  const f = start();
  try {
    const other = readyIn(f.h, ROOM_B, channelKey(f.dir, "other"));
    f.h.clock.advance(1000);
    moveRuntime(f, other.sessionId, "away");
    f.h.clock.advance(1000);
    f.h.cp.db.run("UPDATE conversational_actors SET current_session_id = ?, current_session_incarnation = ? WHERE current_session_id = ?",
      [f.first.sessionId, f.first.incarnation, other.sessionId]);
    let result = migrated(v50Image(f, "acp-focused5-fallback-"));
    while (Date.parse(result.unknown[0]!.unknown_before) % 1000 === 0) {
      result = migrated(v50Image(f, "acp-focused5-fallback-"));
    }
    const { rows, unknown } = result;
    expect(unknown[0]!.anchor_fallback).toBe("RUNTIME_MOVE_UNRECORDED");
    const marker = unknown[0]!;
    expect(Date.parse(marker.unknown_before) % 1000).not.toBe(0);
    f.install(rows, unknown);
    expect(rows[0]!.joined_at).toBe(marker.unknown_before);
    f.h.clock.advance(Date.parse(marker.unknown_before) + 1000 - Date.parse(f.h.clock.nowIso()));
    const live = await daemon(f, [ROOM_A]);
    try {
      const event = signedIn(f, seconds(marker.unknown_before), "pre-migration fraction of S");
      const outcome = await outcomeOf(f, live, event);
      expect(outcome).toBe("refused and recorded");
    } finally { await live.close(); }
  } finally { f.h.cp.close(); }
});


it("FCR-16: a non-fallback anchor later than migration also keeps its comparison rounding", async () => {
  const f = start();
  try {
    const anchorMs = Math.floor(Date.now() / 1000) * 1000 + 3600500;
    f.h.clock.advance(anchorMs - Date.parse(f.h.clock.nowIso()));
    f.h.cp.sessions.setPid(f.first.sessionId, null);
    const { rows, unknown } = migrated(v50Image(f, "acp-focused5-future-anchor-"));
    expect(unknown[0]!.anchor_fallback).toBeNull();
    expect(unknown[0]!.known_since).toBe(new Date(anchorMs).toISOString());
    expect(unknown[0]!.unknown_before).toBe(unknown[0]!.known_since);
    f.install(rows, unknown);
    f.h.clock.advance(1000);
    const live = await daemon(f, [ROOM_A]);
    try {
      const event = signedIn(f, Math.floor(anchorMs / 1000), "before known-since in its fractional second");
      const outcome = await outcomeOf(f, live, event);
      expect(outcome).toBe("refused and recorded");
    } finally { await live.close(); }
  } finally { f.h.cp.close(); }
});


it.each([0, 500])("r10: a newly recorded membership at S + %i ms keeps the round-down comparison contract", (fraction) => {
  const f = start(null);
  try {
    f.h.clock.advance(fraction);
    f.h.cp.sessions.setBuzzAddress(f.first.sessionId, ROOM_A);
    f.bind(f.first.sessionId);
    const joinedAt = f.h.clock.nowIso();
    const seam = createBuzzMessageIngress(f.h.cp, { allowedActors: [f.owner.pubkey], secret: SECRET }, {
      ownerActors: [f.owner.pubkey], ceoConversation: new CeoConversationPort(),
    });
    expect(seam.port.recipientHistorySince!(f.roleKey, ROOM_A))
      .toBe(joinedAt);
    expect(f.h.cp.db.get<{ joined_at: string }>(
      "SELECT joined_at FROM role_room_memberships WHERE role_key = ? AND conversation = ?", [f.roleKey, ROOM_A])!.joined_at).toBe(joinedAt);
  } finally { f.h.cp.close(); }
});

// v51-r9b / CEO 41c27e93: exercise both sides of each floor through signed relay mail,
// the daemon listener and production admission. Whole seconds must not acquire an extra second.
const boundaryFloors = ["anchor", "invalidated anchor", "fallback anchor", "anchor after migration", "fresh membership"] as const;
const boundaryCases = boundaryFloors.flatMap((floor) => [0, 500].map((fraction) => ({
  floor, fraction, precision: fraction === 0 ? "000" : "500",
})));

it.each(boundaryCases)("r9b: $floor at S.$precision refuses past mail and admits the first safe second", async ({ floor, fraction }) => {
  const f = start(floor === "fresh membership" ? null : ROOM_A);
  try {
    const base = floor === "anchor after migration"
      ? Math.floor(Date.now() / 1000) * 1000 + 3_600_000
      : Date.parse(f.h.clock.nowIso()) + 10_000;
    const floorAt = new Date(base + fraction).toISOString();
    const atFloor = () => f.h.clock.advance(Date.parse(floorAt) - Date.parse(f.h.clock.nowIso()));

    if (floor === "fresh membership") {
      atFloor();
      f.h.cp.sessions.setBuzzAddress(f.first.sessionId, ROOM_A);
      f.bind(f.first.sessionId);
      expect(f.h.cp.db.get("SELECT * FROM role_room_history_unknown WHERE role_key = ?", [f.roleKey])).toBeUndefined();
    } else if (floor === "fallback anchor") {
      const other = readyIn(f.h, ROOM_B, channelKey(f.dir, "other-boundary"));
      f.h.clock.advance(1000);
      moveRuntime(f, other.sessionId, "away before migration");
      f.h.cp.db.run("UPDATE conversational_actors SET current_session_id = ?, current_session_incarnation = ? WHERE current_session_id = ?",
        [f.first.sessionId, f.first.incarnation, other.sessionId]);
      const { rows, unknown } = migrated(v50Image(f, "acp-r9b-fallback-"));
      expect(unknown[0]!.anchor_fallback).toBe("RUNTIME_MOVE_UNRECORDED");
      expect(rows[0]!.joined_at).toBe(unknown[0]!.known_since);
      expect(unknown[0]!.known_since).toBe(unknown[0]!.unknown_before);
      // Pin the migration clock in all three output columns, as migratedAt pins its marker.
      f.install(rows.map((row) => ({ ...row, joined_at: floorAt })),
        unknown.map((row) => ({ ...row, known_since: floorAt, unknown_before: floorAt })));
      atFloor();
    } else {
      // For an invalidated anchor the join is earlier; the migration clock is the tested floor.
      if (floor !== "invalidated anchor") {
        atFloor();
        f.h.cp.sessions.setPid(f.first.sessionId, null);
      }
      const migrationAt = floor === "anchor" ? new Date(base + 10_000).toISOString() : floorAt;
      const result = floor === "anchor after migration"
        ? migrated(v50Image(f, "acp-r9b-future-"))
        : migratedAt(f, "acp-r9b-anchor-", migrationAt);
      expect(result.unknown[0]!.anchor_fallback).toBeNull();
      if (floor === "anchor after migration") {
        expect(Date.now()).toBeLessThan(base);
        expect(result.unknown[0]!.unknown_before).toBe(floorAt);
        f.install(result.rows, result.unknown);
      }
      if (floor === "invalidated anchor") {
        expect(Date.parse(result.rows[0]!.joined_at)).toBeLessThan(base);
        atFloor();
        f.h.cp.sessions.setBuzzAddress(f.first.sessionId, ROOM_B);
        f.h.cp.sessions.setBuzzAddress(f.first.sessionId, ROOM_A);
        expect(f.h.cp.audit.byKind("SESSION_BUZZ_ADDRESS_CHANGED").slice(-2)
          .every((row) => row.eventId > result.unknown[0]!.audit_high_water)).toBe(true);
      } else {
        expect(result.rows[0]!.joined_at).toBe(floorAt);
        expect(result.unknown[0]!.known_since).toBe(floorAt);
      }
    }

    const stored = () => ({
      membership: f.h.cp.db.get<{ joined_at: string }>(
        "SELECT joined_at FROM role_room_memberships WHERE role_key = ? AND conversation = ?", [f.roleKey, ROOM_A]),
      history: f.h.cp.db.get<UnknownHistory>("SELECT * FROM role_room_history_unknown WHERE role_key = ?", [f.roleKey]),
    });
    const before = stored();
    expect(floor === "invalidated anchor" ? before.history!.unknown_before : before.membership!.joined_at).toBe(floorAt);
    const live = await daemon(f, [ROOM_A]);
    try {
      const s = base / 1000;
      const refused = signedIn(f, floor === "fresh membership" || fraction === 0 ? s - 1 : s, "before the floor");
      if (floor === "fresh membership") {
        // A fresh post-migration join proves history, so pre-join mail is refused without an unknown-history record.
        expect.soft(await outcomeOf(f, live, refused)).toBe("refused unrecorded");
        // Proven-history pre-join refusals return PRECEDES_BINDING and write no unknown-history record.
        expect.soft({
          decision: await f.deliver(ROOM_A, finalizeEvent({ ...refused, tags: refused.tags.map((tag) => [...tag]) }, f.owner.secretKey)),
          records: refusalsRecorded(f.h),
        }).toMatchObject({
          decision: { allowed: false, reasonCode: ReasonCode.BUZZ_MENTION_PRECEDES_BINDING }, records: [],
        });
      } else {
        expect.soft(await outcomeOf(f, live, refused)).toBe("refused and recorded");
        expect.soft(refusalsRecorded(f.h)).toEqual(expect.arrayContaining([expect.objectContaining({
          role_key: f.roleKey, actor: f.owner.pubkey, reason_code: ReasonCode.BUZZ_MENTION_PRECEDES_BINDING,
          evidence_json: expect.objectContaining({ eventId: refused.id }),
        })]));
      }
      const admitted = signedIn(f, floor === "fresh membership" || fraction === 0 ? s : s + 1, "first safe second, no extra delay");
      f.h.clock.advance(Math.max(0, admitted.created_at * 1000 - Date.parse(f.h.clock.nowIso())));
      expect(await outcomeOf(f, live, admitted)).toBe("admitted");
      expect(stored()).toEqual(before);
    } finally { await live.close(); }
  } finally { f.h.cp.close(); }
});

it("r10: a migration floor at S.500 refuses S with a record while a fresh binding admits S", async () => {
  for (const path of ["migration", "fresh binding", "plain binding", "fresh room after migration"] as const) {
    const f = start(path === "fresh binding" || path === "plain binding" ? null : ROOM_A);
    try {
      const s = seconds(f.h.clock.nowIso()) + 10;
      const floorAt = new Date(s * 1000 + 500).toISOString();
      const room = path === "fresh room after migration" ? ROOM_B : ROOM_A;
      if (path === "fresh room after migration") {
        migratedAt(f, "acp-r10-fresh-room-", new Date((s - 5) * 1000).toISOString());
      }
      f.h.clock.advance(Date.parse(floorAt) - Date.parse(f.h.clock.nowIso()));
      if (path === "migration") {
        f.h.cp.sessions.setPid(f.first.sessionId, null);
        migratedAt(f, "acp-r10-fractional-", new Date((s + 10) * 1000).toISOString());
      } else {
        f.h.cp.sessions.setBuzzAddress(f.first.sessionId, room);
        if (path !== "fresh room after migration") f.bind(f.first.sessionId);
        if (path === "plain binding") {
          f.h.cp.db.run("DELETE FROM role_room_memberships WHERE role_key = ?", [f.roleKey]);
          expect(f.h.cp.bindings.active(f.roleKey)!.createdAt).toBe(floorAt);
        }
      }
      const stored = () => f.h.cp.db.get<{ joined_at: string }>(
        "SELECT joined_at FROM role_room_memberships WHERE role_key = ? AND conversation = ?", [f.roleKey, room]);
      expect(stored()?.joined_at).toBe(path === "plain binding" ? undefined : floorAt);
      const live = await daemon(f, [room]);
      try {
        const eventAt = (second: number) => signedMention({
          author: f.owner.secretKey, addressedTo: f.cto.pubkey, room, createdAt: second, text: `${path} at ${second}`,
        });
        const before = eventAt(s - 1);
        const sameSecond = eventAt(s);
        expect(await outcomeOf(f, live, before)).toBe(path === "migration" ? "refused and recorded" : "refused unrecorded");
        expect(await outcomeOf(f, live, sameSecond)).toBe(path === "migration" ? "refused and recorded" : "admitted");
        if (path === "migration") {
          expect(refusalsRecorded(f.h)).toEqual(expect.arrayContaining([expect.objectContaining({
            role_key: f.roleKey, actor: f.owner.pubkey, reason_code: ReasonCode.BUZZ_MENTION_PRECEDES_BINDING,
            evidence_json: expect.objectContaining({ eventId: sameSecond.id, knownSince: floorAt }),
          })]));
        } else expect(refusalsRecorded(f.h)).toEqual([]);
        f.h.clock.advance(500);
        expect(await outcomeOf(f, live, eventAt(s + 1))).toBe("admitted");
        expect(stored()?.joined_at).toBe(path === "plain binding" ? undefined : floorAt);
      } finally { await live.close(); }
    } finally { f.h.cp.close(); }
  }
});
