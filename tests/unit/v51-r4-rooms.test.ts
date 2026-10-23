import Database from "better-sqlite3";
import { chmodSync, readFileSync } from "node:fs";
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
import { MIGRATIONS, ROLE_ROOM_KNOWN_SINCE_MIGRATION, roleRoomMembershipEvidence } from "../../src/db/migrations.ts";
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
 * ACP-R1-04, focused review, within CEO decision f42efb13 — v51 backfills a role's room history only
 * from what the audit log proves: an audited address change, inside the role's own placement, bounded
 * by the role's next placement and by its binding's revocation. A creation address and a current
 * address are never proof. A role whose current room has no proven join is known there only since the
 * migration: its existing rows stay as they were, mail signed there before the migration is refused,
 * and each refusal is recorded durably with its reason. A connect's address and its audit commit
 * together. Ported from the focused review's probes (FCR-03, FCR-04, FCR-05).
 */

const SECRET = "v51-r4-room-history-secret";
const ROOM_A = "room-a-where-the-role-was-bound";
const ROOM_B = "room-b-with-older-history";
const PROJECT = "room-history";

type Harness = ReturnType<typeof makeHarness>;
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
  const dir = tempDir("acp-v51-r4-room-");
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
  /** The migration's output — memberships, and its records of unproven history — installed in the live database. */
  const install = (rows: ReadonlyArray<{ role_key: string; conversation: string; joined_at: string }>,
    markers: ReadonlyArray<{ at: string; kind: string; role_key: string; session_id: string; evidence_json: string }> = []) => {
    h.cp.db.run("DELETE FROM role_room_memberships WHERE role_key = ?", [roleKey]);
    for (const row of rows.filter((candidate) => candidate.role_key === roleKey)) {
      h.cp.db.run("INSERT INTO role_room_memberships (role_key, conversation, joined_at, session_id) VALUES (?, ?, ?, ?)",
        [row.role_key, row.conversation, row.joined_at, holder()?.sessionId ?? first.sessionId]);
    }
    for (const marker of markers) {
      h.cp.db.run("INSERT INTO audit_events (at, kind, role_key, session_id, evidence_json) VALUES (?, ?, ?, ?, ?)",
        [marker.at, marker.kind, marker.role_key, marker.session_id, marker.evidence_json]);
    }
  };
  return { h, dir, owner, cto, opens, roleKey, first, bind, broadcast, deliver, holder, moveTo, install };
};
type Fixture = ReturnType<typeof start>;

const v51 = MIGRATIONS.find((step) => step.toVersion === 51)!;

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

const judged = (path: string) => {
  const raw = new Database(path, { readonly: true });
  try { return roleRoomMembershipEvidence(raw); } finally { raw.close(); }
};

/** The v51 step's memberships on the image, in a transaction rolled back afterwards. */
const membershipsOf = (path: string) => {
  const raw = new Database(path);
  try {
    raw.exec("BEGIN IMMEDIATE");
    v51.apply(raw);
    const rows = raw.prepare("SELECT role_key, conversation, joined_at FROM role_room_memberships ORDER BY role_key, joined_at")
      .all() as Array<{ role_key: string; conversation: string; joined_at: string }>;
    raw.exec("ROLLBACK");
    return rows;
  } finally { raw.close(); }
};

/** The full runner on the image, and the wall-clock window the migration ran in. */
const migrated = (path: string) => {
  approveMigration(path, "v51-r4 room history");
  const before = new Date().toISOString();
  const db = new Db(path);
  const after = new Date().toISOString();
  try {
    return {
      before, after,
      rows: db.all<{ role_key: string; conversation: string; joined_at: string }>(
        "SELECT role_key, conversation, joined_at FROM role_room_memberships ORDER BY role_key, joined_at"),
      markers: db.all<{ at: string; kind: string; role_key: string; session_id: string; evidence_json: string }>(
        "SELECT at, kind, role_key, session_id, evidence_json FROM audit_events WHERE kind = ? ORDER BY event_id",
        [ROLE_ROOM_KNOWN_SINCE_MIGRATION]),
    };
  } finally { db.close(); }
};

/** Every object and row of the database, ordered: "applies nothing" is this, unchanged. */
const contents = (path: string) => {
  const raw = new Database(path, { readonly: true });
  try {
    const schema = raw.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name").all() as
      Array<{ type: string; name: string }>;
    const tables = schema.filter((row) => row.type === "table" && !row.name.startsWith("sqlite_")).map((row) => row.name);
    return {
      userVersion: raw.pragma("user_version", { simple: true }),
      schema,
      rows: Object.fromEntries(tables.map((table) => [table,
        (raw.prepare(`SELECT * FROM "${table}"`).all() as unknown[]).map((row) => JSON.stringify(row)).sort()])),
    };
  } finally { raw.close(); }
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

it("FCR-03: a history no audit proves is known only since the migration; the room's earlier mail is refused, recorded, and never delivered", async () => {
  const f = start();
  try {
    const first = f.holder().sessionId;
    f.h.clock.advance(1000);
    const unread = signedMention({ author: f.owner.secretKey, addressedTo: f.cto.pubkey, room: ROOM_A,
      createdAt: seconds(f.h.clock.nowIso()), text: "unread in the first A runtime" });
    // The v50 disconnect: the address cleared, with no audit.
    f.h.cp.db.run("UPDATE sessions SET buzz_address = NULL WHERE session_id = ?", [first]);
    const next = f.moveTo(ROOM_A);
    const path = v50Image(f, "acp-r4-v50-disconnect-");
    const evidence = judged(path);
    expect(evidence.refusals).toEqual([]);
    expect(evidence.memberships.filter((row) => row.roleKey === f.roleKey)).toEqual([]);
    expect(evidence.knownSinceMigration).toEqual([{ roleKey: f.roleKey, room: ROOM_A, sessionId: next.sessionId }]);
    expect(evidence.evidence[f.roleKey]).toEqual(expect.arrayContaining([
      expect.stringContaining("a creation address is not on record"),
      expect.stringContaining(`current room ${ROOM_A} on ${next.sessionId}: no proven join, so known only since the migration`),
    ]));

    // The full runner completes, and the room is joined at the migration, not at a guessed earlier
    // or later point in the role's history.
    const { before, after, rows, markers } = migrated(path);
    expect(rows).toEqual([{ role_key: f.roleKey, conversation: ROOM_A, joined_at: expect.any(String) }]);
    expect(rows[0]!.joined_at >= before && rows[0]!.joined_at <= after).toBe(true);
    // The separation is on record: the role's history in A before the migration is unproven.
    expect(markers.map((marker) => ({ ...marker, evidence_json: JSON.parse(marker.evidence_json) as unknown }))).toEqual([{
      at: rows[0]!.joined_at, kind: ROLE_ROOM_KNOWN_SINCE_MIGRATION, role_key: f.roleKey, session_id: next.sessionId,
      evidence_json: { room: ROOM_A, joinedAt: rows[0]!.joined_at, migration: "v51-durable-recipient-delivery" },
    }]);

    // That output, live: the earlier A mail is refused, recorded with its reason, and not delivered.
    f.install(rows, markers);
    const live = await daemon(f, [ROOM_A]);
    try {
      await live.publish(unread);
      expect(f.h.cp.db.all("SELECT message_id FROM outbox WHERE kind = 'OWNER_MESSAGE'")).toEqual([]);
      expect(live.subscriber.counters().admitted).toBe(0);
      expect(refusalsRecorded(f.h)).toEqual([{
        reason_code: ReasonCode.BUZZ_MENTION_PRECEDES_BINDING,
        role_key: f.roleKey,
        actor: f.owner.pubkey,
        evidence_json: { eventId: unread.id, room: ROOM_A, signedAt: new Date(unread.created_at * 1000).toISOString() },
      }]);
      // From the migration on, the current binding is the basis: A mail signed after it is the role's.
      await live.publish(signedMention({ author: f.owner.secretKey, addressedTo: f.cto.pubkey, room: ROOM_A,
        createdAt: seconds(rows[0]!.joined_at) + 1, text: "signed after the migration" }));
      expect(f.h.cp.db.all("SELECT message_id FROM outbox WHERE kind = 'OWNER_MESSAGE'")).toHaveLength(1);
      expect(refusalsRecorded(f.h)).toHaveLength(1);
    } finally { await live.close(); }
  } finally { f.h.cp.close(); }
});

it("FCR-04: nothing a session does after the role's revocation joins the role to a room", async () => {
  const f = start();
  try {
    const first = f.holder().sessionId;
    f.h.clock.advance(1000);
    expect(f.h.cp.bindings.revoke(f.roleKey, "release the role before its runtime changes room").allowed).toBe(true);
    f.h.clock.advance(1000);
    // The v50 connect on the released session: the address and its audit agree.
    f.h.cp.db.run("UPDATE sessions SET buzz_address = ? WHERE session_id = ?", [ROOM_B, first]);
    f.h.cp.audit.record({ kind: "BUZZ_CONNECTED", sessionId: first, evidence: { purpose: "after the revocation", address: ROOM_B } });
    const path = v50Image(f, "acp-r4-v50-revoked-");
    const rows = membershipsOf(path);
    expect(rows.filter((row) => row.conversation === ROOM_B)).toEqual([]);
    const revokedAt = f.h.cp.db.get<{ revoked_at: string }>("SELECT revoked_at FROM assignments WHERE session_id = ?", [first])!.revoked_at;
    expect(judged(path).evidence[f.roleKey]).toEqual(expect.arrayContaining([
      expect.stringContaining(`on ${first} (`),
      expect.stringContaining(` to ${revokedAt}): room at its start not proven`),
    ]));

    f.h.clock.advance(1000);
    const prejoin = f.broadcast(ROOM_B, "B work before any binding in B");
    f.h.clock.advance(10_000);
    expect(f.h.cp.sessions.transition(first, SessionLifecycle.STOPPED, "released runtime").allowed).toBe(true);
    const next = readyIn(f.h, ROOM_B, f.cto);
    f.install(rows);
    f.bind(next.sessionId);
    expect(await f.deliver(ROOM_B, prejoin)).toMatchObject({ allowed: false, reasonCode: ReasonCode.BUZZ_MENTION_PRECEDES_BINDING });
    f.h.clock.advance(1000);
    expect((await f.deliver(ROOM_B, f.broadcast(ROOM_B, "B work after the binding in B"))).allowed).toBe(true);
  } finally { f.h.cp.close(); }
});

it("FCR-05: a connect whose audit cannot be written leaves the address, its trail and the role's history as they were", async () => {
  const f = start();
  try {
    const first = f.holder().sessionId;
    const historyBefore = f.h.cp.db.all("SELECT * FROM role_room_memberships ORDER BY role_key, conversation");
    const injector = new Database(join(f.h.root, "state.sqlite"));
    try {
      injector.exec(`CREATE TRIGGER fail_buzz_audit BEFORE INSERT ON audit_events
        WHEN NEW.kind = 'BUZZ_CONNECTED' BEGIN SELECT RAISE(ABORT, 'injected audit insert failure'); END`);
    } finally { injector.close(); }
    f.h.clock.advance(11_000);
    const connected = await f.h.buzzAdapter.connect(first, "audit interruption");
    expect(connected).toMatchObject({ allowed: false, reasonCode: ReasonCode.PROBE_FAILED });
    expect(f.h.cp.sessions.require(first).buzzAddress).toBe(ROOM_A);
    expect(f.h.cp.db.all("SELECT kind FROM audit_events WHERE session_id = ? AND kind IN ('BUZZ_CONNECTED','SESSION_BUZZ_ADDRESS_CHANGED')", [first]))
      .toEqual([]);
    expect(f.h.cp.db.all("SELECT * FROM role_room_memberships ORDER BY role_key, conversation")).toEqual(historyBefore);

    // With the audit writable again, the address and its audit land together.
    const repair = new Database(join(f.h.root, "state.sqlite"));
    try { repair.exec("DROP TRIGGER fail_buzz_audit"); } finally { repair.close(); }
    expect((await f.h.buzzAdapter.connect(first, "audit restored")).allowed).toBe(true);
    expect(f.h.cp.sessions.require(first).buzzAddress).toBe(ROOM_B);
    expect(f.h.cp.db.all<{ kind: string }>("SELECT kind FROM audit_events WHERE session_id = ? AND kind IN ('BUZZ_CONNECTED','SESSION_BUZZ_ADDRESS_CHANGED') ORDER BY event_id", [first])
      .map((row) => row.kind)).toEqual(["SESSION_BUZZ_ADDRESS_CHANGED", "BUZZ_CONNECTED"]);
  } finally { f.h.cp.close(); }
});

it("FCR-05: an address change no audit records is never backdated; its room is known only since the migration", () => {
  const f = start();
  try {
    const first = f.holder().sessionId;
    f.h.clock.advance(11_000);
    // What v50's connect left when its audit insert failed: the new address, and no audit.
    f.h.cp.db.run("UPDATE sessions SET buzz_address = ? WHERE session_id = ?", [ROOM_B, first]);
    const path = v50Image(f, "acp-r4-v50-unaudited-connect-");
    const evidence = judged(path);
    expect(evidence.memberships.filter((row) => row.roleKey === f.roleKey)).toEqual([]);
    expect(evidence.knownSinceMigration).toEqual([{ roleKey: f.roleKey, room: ROOM_B, sessionId: first }]);
    const { before, after, rows } = migrated(path);
    expect(rows).toEqual([{ role_key: f.roleKey, conversation: ROOM_B, joined_at: expect.any(String) }]);
    expect(rows[0]!.joined_at >= before && rows[0]!.joined_at <= after).toBe(true);
  } finally { f.h.cp.close(); }
});

it("a history the audit log proves migrates exactly: the audited connect before the binding, and the audited change after it", async () => {
  const f = start(null);
  try {
    const first = f.first.sessionId;
    f.opens.room = ROOM_A;
    expect((await f.h.buzzAdapter.connect(first, "the role's first room")).allowed).toBe(true);
    f.h.clock.advance(1000);
    const boundAt = f.bind(first).createdAt;
    f.h.clock.advance(10_000);
    const changedAt = f.h.clock.nowIso();
    f.h.cp.sessions.setBuzzAddress(first, ROOM_B);
    const path = v50Image(f, "acp-r4-v50-proven-");
    const evidence = judged(path);
    expect(evidence.knownSinceMigration).toEqual([]);
    expect(evidence.evidence[f.roleKey]).toEqual(expect.arrayContaining([
      expect.stringContaining(`room ${ROOM_A} from its start, by audit BUZZ_CONNECTED`),
      expect.stringContaining(`current room ${ROOM_B} on ${first}: proven since ${changedAt}`),
    ]));
    expect(membershipsOf(path)).toEqual([
      { role_key: f.roleKey, conversation: ROOM_A, joined_at: boundAt },
      { role_key: f.roleKey, conversation: ROOM_B, joined_at: changedAt },
    ]);
  } finally { f.h.cp.close(); }
});

it("an address audit that cannot be read refuses the migration, naming the role, and applies nothing", () => {
  const f = start();
  try {
    const first = f.holder().sessionId;
    const path = v50Image(f, "acp-r4-v50-unreadable-", (raw) => {
      raw.prepare("INSERT INTO audit_events (at, kind, session_id, evidence_json) VALUES (?, 'BUZZ_CONNECTED', ?, 'null')")
        .run(f.h.clock.nowIso(), first);
    });
    const before = contents(path);
    approveMigration(path, "v51-r4 unreadable audit");
    let refusal: unknown = null;
    try { new Db(path).close(); } catch (error) { refusal = error; }
    expect(refusal).toBeInstanceOf(Error);
    expect((refusal as Error).message).toBe("migration failed; the original database was restored from its automatic backup");
    expect(contents(path)).toEqual(before);
    const reason = JSON.stringify((refusal as { evidence?: unknown }).evidence);
    expect(reason).toContain(f.roleKey);
    expect(reason).toContain("cannot be read");
  } finally { f.h.cp.close(); }
});

it("terminal ordering: a row v51 revives is live again, so its id is not recorded as terminal; a row still terminal is", () => {
  const raw = new Database(":memory:");
  try {
    raw.exec(readFileSync(new URL("../../src/db/schema-v50.sql", import.meta.url), "utf8"));
    const insert = raw.prepare(`INSERT INTO outbox (message_id, idempotency_key, role_key, binding_generation,
      target_session_id, kind, payload_json, payload_digest, request_fingerprint, expires_at, created_at, status, last_error)
      VALUES (?, ?, ?, 1, 'target', ?, '{}', 'digest', 'fingerprint', '2026-01-01', '2025-01-01', ?, ?)`);
    insert.run("expired-notification", "k1", "CEO", "CEO_NOTIFICATION", "EXPIRED", null);
    insert.run("unroutable-notification", "k2", "CEO", "CEO_NOTIFICATION", "REJECTED", "target session has no buzz address");
    insert.run("expired-instruction", "k3", "PRIMARY_CTO", "ESCALATION_REPLY", "EXPIRED", null);
    insert.run("refused-notification", "k4", "CEO", "CEO_NOTIFICATION", "REJECTED", "explicit refusal");
    insert.run("expired-owner-message", "k5", "PRIMARY_CTO", "OWNER_MESSAGE", "EXPIRED", null);
    v51.apply(raw);
    const revived = ["expired-instruction", "expired-notification", "unroutable-notification"];
    expect(raw.prepare(`SELECT message_id, status FROM outbox WHERE message_id IN (${revived.map(() => "?").join(",")}) ORDER BY message_id`)
      .all(...revived)).toEqual(revived.map((message_id) => ({ message_id, status: "PENDING" })));
    expect(raw.prepare("SELECT message_id FROM holder_message_terminals ORDER BY message_id").all())
      .toEqual([{ message_id: "expired-owner-message" }, { message_id: "refused-notification" }]);
  } finally { raw.close(); }
});
