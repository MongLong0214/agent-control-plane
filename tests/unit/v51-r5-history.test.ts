import Database from "better-sqlite3";
import { chmodSync, readdirSync, readFileSync, statSync } from "node:fs";
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
import { roleRoomMembershipEvidence } from "../../src/db/migrations.ts";
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
 * ACP-R1-04, second focused review, within CEO decisions f42efb13 and 1fd967e8 — no room history is
 * inferred. Equal audited endpoints around a v50 connect whose audit failed prove nothing about the
 * time between them (FCR-06), and a later audited presence proves nothing before it (FCR-07): the role
 * is known in its current room only since its current binding's anchor, the latest of the binding's
 * creation, a runtime move onto its runtime and that session's last address write. That anchor rests
 * on one checked precondition: every writer of `sessions.buzz_address` stamps `updated_at` in the same
 * statement. Every mention refused because it was signed before the migration — before the anchor in
 * the current room, or in a room the role joins later — is recorded durably with its cause and never
 * delivered or replayed; rows that already carry an admission are not touched. Ported from the second
 * focused review's probes.
 */

const SECRET = "v51-r5-room-history-secret";
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
  const dir = tempDir("acp-v51-r5-room-");
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
      h.cp.db.run(`INSERT INTO role_room_history_unknown (role_key, unknown_before, room, known_since, binding_generation, session_id,
          anchor_fallback, anchor_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [row.role_key, row.unknown_before, row.room, row.known_since,
        row.binding_generation, row.session_id, row.anchor_fallback, row.anchor_json]);
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

const judged = (path: string) => {
  const raw = new Database(path, { readonly: true });
  try { return roleRoomMembershipEvidence(raw); } finally { raw.close(); }
};

/** The full runner on the image, and the wall-clock window the migration ran in. */
const migrated = (path: string) => {
  approveMigration(path, "v51-r5 room history");
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
        : db.all<UnknownHistory>(`SELECT role_key, unknown_before, room, known_since, binding_generation, session_id, anchor_fallback,
          anchor_json FROM role_room_history_unknown ORDER BY role_key`),
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

/** The v50 `SessionRegistry.setBuzzAddress` statement at a680e971, verbatim: it writes no audit. */
const v50SetAddress = (h: Harness, sessionId: string, address: string | null): void => {
  h.cp.db.run("UPDATE sessions SET buzz_address = ?, updated_at = ? WHERE session_id = ?", [address, h.clock.nowIso(), sessionId]);
};
/** v50 `BuzzAdapter.connect`: that setter, then a separate `BUZZ_CONNECTED` audit, which could fail on its own. */
const v50Connect = (h: Harness, sessionId: string, address: string, audited = true): void => {
  v50SetAddress(h, sessionId, address);
  if (audited) h.cp.audit.record({ kind: "BUZZ_CONNECTED", sessionId, evidence: { purpose: "v50 connect", address } });
};
const mention = (f: Fixture, room: string, text: string) =>
  signedMention({ author: f.owner.secretKey, addressedTo: f.cto.pubkey, room, createdAt: seconds(f.h.clock.nowIso()), text });
const ownerMessages = (h: Harness) => h.cp.db.all("SELECT message_id FROM outbox WHERE kind = 'OWNER_MESSAGE'");

it("FCR-06: equal audited endpoints around a v50 connect whose audit failed prove nothing; A is known only since the last address write", async () => {
  const f = start(null);
  try {
    const first = f.first.sessionId;
    v50Connect(f.h, first, ROOM_A);
    f.h.clock.advance(1000);
    v50Connect(f.h, first, ROOM_B, false);
    f.h.clock.advance(1000);
    const boundAt = f.bind(first).createdAt;
    f.h.clock.advance(1000);
    const prejoin = mention(f, ROOM_A, "A mail before the role was in A");
    f.h.clock.advance(8000);
    const returnedAt = f.h.clock.nowIso();
    v50Connect(f.h, first, ROOM_A);
    const path = v50Image(f, "acp-r5-v50-hidden-connect-");
    const anchored = judged(path).anchored;
    const { rows, unknown } = migrated(path);
    expect(rows).toEqual([{ role_key: f.roleKey, conversation: ROOM_A, joined_at: returnedAt }]);
    expect(anchored).toEqual([{ roleKey: f.roleKey, room: ROOM_A, sessionId: first, bindingCreatedAt: boundAt,
      sessionUpdatedAt: returnedAt, runtimeMovedAt: null, bindingGeneration: expect.any(Number), fallback: null, knownSince: returnedAt }]);
    f.install(rows, unknown);
    const live = await daemon(f, [ROOM_A]);
    try {
      await live.publish(prejoin);
      expect(ownerMessages(f.h)).toEqual([]);
      expect(refusalsRecorded(f.h)).toEqual([expect.objectContaining({ role_key: f.roleKey,
        reason_code: ReasonCode.BUZZ_MENTION_PRECEDES_BINDING,
        evidence_json: expect.objectContaining({ eventId: prejoin.id, cause: "SIGNED_BEFORE_KNOWN_ROOM_HISTORY", knownSince: returnedAt }) })]);
    } finally { await live.close(); }
  } finally { f.h.cp.close(); }
});

it("FCR-07: a later audited presence proves nothing before it; the earlier mail is refused, recorded with its cause, and never delivered", async () => {
  const f = start();
  try {
    f.h.clock.advance(1000);
    const unread = mention(f, ROOM_A, "unread before the first address audit");
    f.h.clock.advance(10_000);
    const connectedAt = f.h.clock.nowIso();
    v50Connect(f.h, f.first.sessionId, ROOM_A);
    const path = v50Image(f, "acp-r5-v50-unknown-prefix-");
    const { rows, unknown } = migrated(path);
    expect(rows).toEqual([{ role_key: f.roleKey, conversation: ROOM_A, joined_at: connectedAt }]);
    expect(unknown).toHaveLength(1);
    const unknownBefore = unknown[0]!.unknown_before;
    f.install(rows, unknown);
    const live = await daemon(f, [ROOM_A]);
    try {
      await live.publish(unread);
      expect(ownerMessages(f.h)).toEqual([]);
      expect(live.subscriber.counters().admitted).toBe(0);
      expect(refusalsRecorded(f.h)).toEqual([{
        reason_code: ReasonCode.BUZZ_MENTION_PRECEDES_BINDING, role_key: f.roleKey, actor: f.owner.pubkey,
        evidence_json: { eventId: unread.id, room: ROOM_A, signedAt: new Date(unread.created_at * 1000).toISOString(),
          cause: "SIGNED_BEFORE_KNOWN_ROOM_HISTORY", knownSince: connectedAt, unknownBefore },
      }]);
    } finally { await live.close(); }
  } finally { f.h.cp.close(); }
});

it("unknown history is every room's: mail signed before the migration in a room the role joins later is refused and recorded; mail after it is judged on recorded history", async () => {
  const f = start();
  try {
    f.h.clock.advance(1000);
    const beforeMigration = mention(f, ROOM_B, "B mail from before the migration");
    f.h.clock.advance(1000);
    const migratedAt = f.h.clock.nowIso();
    // The row v51 writes for a role on record at the migration (see the anchor tests above).
    if (f.h.cp.db.all("SELECT name FROM sqlite_schema WHERE name = 'role_room_history_unknown'").length > 0) {
      f.h.cp.db.run(`INSERT INTO role_room_history_unknown (role_key, unknown_before, room, known_since, binding_generation, session_id,
          anchor_json) VALUES (?, ?, ?, ?, ?, ?, '{}')`,
        [f.roleKey, migratedAt, ROOM_A, f.holder().createdAt, f.holder().bindingGeneration, f.first.sessionId]);
    }
    f.h.clock.advance(1000);
    const afterMigration = mention(f, ROOM_B, "B mail after the migration, before the role joined B");
    f.moveTo(ROOM_B);
    const live = await daemon(f, [ROOM_A, ROOM_B]);
    try {
      await live.publish(beforeMigration);
      await live.publish(afterMigration);
      expect(ownerMessages(f.h)).toEqual([]);
      // Only the refusal unknown history decides is recorded; the other rests on the join v51 recorded.
      expect(refusalsRecorded(f.h)).toEqual([expect.objectContaining({ role_key: f.roleKey,
        evidence_json: expect.objectContaining({ eventId: beforeMigration.id, room: ROOM_B, cause: "SIGNED_BEFORE_KNOWN_ROOM_HISTORY",
          unknownBefore: migratedAt }) })]);
      f.h.clock.advance(1000);
      await live.publish(mention(f, ROOM_B, "B mail after the join"));
      expect(ownerMessages(f.h)).toHaveLength(1);
    } finally { await live.close(); }
  } finally { f.h.cp.close(); }
});

it("a row that already carries an admission is never invalidated: v51 leaves it, and refusing its replay adds no copy", async () => {
  const f = start();
  try {
    f.h.clock.advance(1000);
    const admitted = f.broadcast(ROOM_A, "admitted before the anchor");
    expect((await f.deliver(ROOM_A, admitted)).allowed).toBe(true);
    const row = () => f.h.cp.db.all("SELECT message_id, status, role_key, binding_generation, target_session_id, payload_digest FROM outbox WHERE kind = 'OWNER_MESSAGE'");
    const inbound = () => f.h.cp.db.all("SELECT channel, nonce, actor, received_at FROM inbound_messages ORDER BY channel, nonce");
    const before = { outbox: row(), inbound: inbound() };
    expect(before.outbox).toHaveLength(1);
    f.h.clock.advance(5000);
    v50Connect(f.h, f.first.sessionId, ROOM_A);
    const path = v50Image(f, "acp-r5-v50-admitted-");
    const { rows, unknown } = migrated(path);
    const image = new Database(path, { readonly: true });
    try {
      expect(image.prepare("SELECT message_id, status, role_key, binding_generation, target_session_id, payload_digest FROM outbox WHERE kind = 'OWNER_MESSAGE'").all())
        .toEqual(before.outbox);
      expect(image.prepare("SELECT channel, nonce, actor, received_at FROM inbound_messages ORDER BY channel, nonce").all()).toEqual(before.inbound);
    } finally { image.close(); }
    f.install(rows, unknown);
    await f.deliver(ROOM_A, admitted);
    expect({ outbox: row(), inbound: inbound() }).toEqual(before);
  } finally { f.h.cp.close(); }
});

it("an anchor that cannot be read refuses the migration atomically, with another valid role and a revivable notification present", () => {
  const f = start();
  try {
    const ceo = f.h.cp.sessions.create({ provider: "scripted", model: "ceo", buzzAddress: "ceo-room" });
    expect(f.h.cp.sessions.transition(ceo.sessionId, SessionLifecycle.READY, "test").allowed).toBe(true);
    expect(f.h.cp.bindings.bind({ role: Role.CEO, sessionId: ceo.sessionId }).allowed).toBe(true);
    const path = v50Image(f, "acp-r5-v50-refusal-rollback-", (raw) => {
      raw.prepare("UPDATE sessions SET updated_at = 'not a time' WHERE session_id = ?").run(f.first.sessionId);
      raw.prepare(`INSERT INTO outbox (message_id, idempotency_key, role_key, binding_generation,
        target_session_id, kind, payload_json, payload_digest, request_fingerprint, expires_at, created_at, status)
        VALUES ('revivable', 'rollback-key', 'CEO', 1, ?, 'CEO_NOTIFICATION', '{}', 'digest', 'fp', '2026-01-01', '2025-01-01', 'EXPIRED')`)
        .run(ceo.sessionId);
    });
    const before = contents(path);
    approveMigration(path, "v51-r5 refusal rollback");
    let error: unknown;
    try { new Db(path).close(); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    const reason = JSON.stringify((error as { evidence?: unknown }).evidence);
    expect(reason).toContain(f.roleKey);
    expect(reason).not.toContain("CEO (");
    expect(contents(path)).toEqual(before);
  } finally { f.h.cp.close(); }
});

it("the anchor's precondition: every writer of sessions.buzz_address stamps updated_at in the same statement", () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith(".ts")) files.push(path);
    }
  };
  walk(new URL("../../src", import.meta.url).pathname);
  const writers: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/`([^`]*?\b(?:UPDATE\s+sessions\s+SET|INSERT\s+(?:OR\s+\w+\s+)?INTO\s+sessions\b)[^`]*)`/g)) {
      const statement = match[1]!;
      if (!/\bbuzz_address\b/.test(statement)) continue;
      writers.push(`${file.split("/src/")[1]}: ${statement.replace(/\s+/g, " ").slice(0, 60)}`);
      expect(statement, `${file}: ${statement}`).toMatch(/\bupdated_at\b/);
    }
  }
  // The two creation INSERTs and the one setter; a new writer must be checked against the anchor.
  expect(writers).toHaveLength(3);
});
