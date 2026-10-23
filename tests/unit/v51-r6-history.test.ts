import Database from "better-sqlite3";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import { finalizeEvent } from "nostr-tools/pure";
import { afterAll, expect, it, vi } from "vitest";

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
import { roleRoomMembershipEvidence, v51AnchorFallbackRoles } from "../../src/db/migrations.ts";
import { main as stateAdmin } from "../../src/db/state-admin.ts";
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
 * ACP-R1-04, third focused review, within CEO decisions f42efb13, 1fd967e8 and 5f6ab731. FCR-09: every
 * recorded runtime move within the binding counts toward the anchor, including a move back onto the
 * session the binding names, and a runtime no move record explains is a fallback. FCR-11: a fallback
 * (a role anchored only at the migration itself, whose stop-window mail is refused) is explicit: the
 * step records it, `v51AnchorFallbackRoles` lists it, and `agentcpd-state migration-plan` reports it,
 * so a deployment can refuse to proceed. The CEO's limit conditions: (a) a refused replay of an
 * admitted event leaves its admission, row and receipt exactly as they were; (b) the anchor's second
 * is a deterministic boundary; (c) stop-window mail is admitted only on the anchored binding, runtime
 * and room. Ported from the third focused review's probes.
 */

const SECRET = "v51-r6-room-history-secret";
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
  const dir = tempDir("acp-v51-r6-room-");
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

const judged = (path: string) => {
  const raw = new Database(path, { readonly: true });
  try { return roleRoomMembershipEvidence(raw); } finally { raw.close(); }
};

/** The full runner on the image, and the wall-clock window the migration ran in. */
const migrated = (path: string) => {
  approveMigration(path, "v51-r6 room history");
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

/** Moves the role's surviving conversation onto `sessionId` (a same-generation runtime move, recorded). */
const moveRuntime = (f: Fixture, sessionId: string, reason: string) => {
  const moved = f.h.cp.bindings.switchTo({ role: Role.PRIMARY_CTO, projectId: PROJECT, sessionId, conversation: "SURVIVED", reason });
  if (!moved.allowed) throw new Error(moved.message);
};
/** `agentcpd-state migration-plan` on `path`, parsed. */
const migrationPlan = async (path: string): Promise<{ v51AnchorFallback: unknown }> => {
  const writes: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    writes.push(String(chunk));
    return true;
  });
  try {
    expect(await stateAdmin(["migration-plan", "--database", path])).toBe(0);
  } finally { spy.mockRestore(); }
  return JSON.parse(writes.join("")) as { v51AnchorFallback: unknown };
};

it("FCR-09: a recorded move back onto the binding's own session counts; the room there is known only since that move", async () => {
  const f = start(null);
  try {
    f.bind(f.first.sessionId);
    f.h.clock.advance(1000);
    const second = readyIn(f.h, ROOM_B, channelKey(f.dir, "other-runtime"));
    moveRuntime(f, second.sessionId, "move away from the original runtime");
    f.h.clock.advance(1000);
    v50SetAddress(f.h, f.first.sessionId, ROOM_A);
    f.h.clock.advance(1000);
    const notOurs = f.broadcast(ROOM_A, "A before the role ever joined A");
    f.h.clock.advance(8000);
    const returnedAt = f.h.clock.nowIso();
    moveRuntime(f, f.first.sessionId, "return to the original runtime");
    const path = v50Image(f, "acp-r6-v50-return-original-");
    const { rows, unknown } = migrated(path);
    expect(rows).toEqual([{ role_key: f.roleKey, conversation: ROOM_A, joined_at: returnedAt }]);
    expect(judged(path).anchored).toEqual([expect.objectContaining({ roleKey: f.roleKey, sessionId: f.first.sessionId,
      runtimeMovedAt: returnedAt, knownSince: returnedAt, fallback: null })]);
    f.install(rows, unknown);
    expect(await f.deliver(ROOM_A, notOurs)).toMatchObject({ allowed: false, reasonCode: ReasonCode.BUZZ_MENTION_PRECEDES_BINDING });
  } finally { f.h.cp.close(); }
});

it("FCR-09: a return to the binding's own session that no move record explains is a fallback, not the session's own anchor", async () => {
  const f = start();
  try {
    f.h.clock.advance(1000);
    const second = readyIn(f.h, ROOM_B, channelKey(f.dir, "other-runtime"));
    moveRuntime(f, second.sessionId, "move away");
    const path = v50Image(f, "acp-r6-v50-unrecorded-return-", (raw) => {
      raw.prepare(`UPDATE conversational_actors SET current_session_id = ?, current_session_incarnation = ?
        WHERE actor_id = (SELECT actor_id FROM assignments WHERE role_key = ? AND status = 'ACTIVE')`)
        .run(f.first.sessionId, f.h.cp.sessions.require(f.first.sessionId).incarnation, f.roleKey);
    });
    expect(judged(path).anchored).toEqual([expect.objectContaining({ roleKey: f.roleKey, sessionId: f.first.sessionId,
      knownSince: null, fallback: "RUNTIME_MOVE_UNRECORDED" })]);
    const raw = new Database(path, { readonly: true });
    try { expect(v51AnchorFallbackRoles(raw)).toEqual([{ roleKey: f.roleKey, reason: "RUNTIME_MOVE_UNRECORDED" }]); } finally { raw.close(); }
  } finally { f.h.cp.close(); }
});

it("FCR-11: a runtime no move record explains is listed by the plan, the evidence and the migrated record; its stop-window mail is refused and recorded", async () => {
  const f = start();
  try {
    f.h.clock.advance(1000);
    const runtime = f.h.cp.sessions.create({ provider: "scripted", model: "legacy-runtime", buzzAddress: ROOM_A });
    expect(f.h.cp.sessions.transition(runtime.sessionId, SessionLifecycle.READY, "legacy ready").allowed).toBe(true);
    const path = v50Image(f, "acp-r6-v50-missing-move-", (raw) => {
      raw.prepare(`UPDATE conversational_actors SET current_session_id = ?, current_session_incarnation = ?
        WHERE actor_id = (SELECT actor_id FROM assignments WHERE role_key = ? AND status = 'ACTIVE')`)
        .run(runtime.sessionId, runtime.incarnation, f.roleKey);
    });
    f.h.clock.advance(1000);
    const duringStop = mention(f, ROOM_A, "mail while the deployment is stopped");
    // Before the upgrade: the read-only plan names it, so a deployment can refuse to proceed.
    expect((await migrationPlan(path)).v51AnchorFallback).toEqual([{ roleKey: f.roleKey, reason: "RUNTIME_MOVE_UNRECORDED" }]);
    const { before, after, rows, unknown } = migrated(path);
    // After it: the step's own record names it too, and its room is known only since the migration.
    expect(unknown).toEqual([expect.objectContaining({ role_key: f.roleKey, anchor_fallback: "RUNTIME_MOVE_UNRECORDED",
      session_id: runtime.sessionId, known_since: unknown[0]!.unknown_before })]);
    expect(unknown[0]!.unknown_before >= before && unknown[0]!.unknown_before <= after).toBe(true);
    f.install(rows, unknown);
    const live = await daemon(f, [ROOM_A]);
    try {
      await live.publish(duringStop);
      expect(ownerMessages(f.h)).toEqual([]);
      expect(refusalsRecorded(f.h)).toEqual([expect.objectContaining({ role_key: f.roleKey,
        evidence_json: expect.objectContaining({ eventId: duringStop.id, cause: "SIGNED_BEFORE_KNOWN_ROOM_HISTORY" }) })]);
    } finally { await live.close(); }
  } finally { f.h.cp.close(); }
});

it("FCR-11: an ordinary v50 database has an empty fallback list in the plan", async () => {
  const f = start();
  try {
    expect((await migrationPlan(v50Image(f, "acp-r6-v50-no-fallback-"))).v51AnchorFallback).toEqual([]);
  } finally { f.h.cp.close(); }
});

/** Delivery state for the role's owner mail: every row of the tables an admission or a receipt lives in. */
const deliveryState = (h: Harness) => ({
  outbox: h.cp.db.all("SELECT * FROM outbox WHERE kind = 'OWNER_MESSAGE' ORDER BY message_id"),
  inbound: h.cp.db.all("SELECT * FROM inbound_messages ORDER BY channel, nonce"),
  departures: h.cp.db.all("SELECT * FROM holder_message_departures ORDER BY message_id"),
  terminals: h.cp.db.all("SELECT * FROM holder_message_terminals ORDER BY message_id"),
});

it("limit (a): an admitted event received again and refused leaves its admission, its row and its receipt exactly as they were, with no copy", async () => {
  const f = start();
  try {
    f.h.clock.advance(1000);
    const pending = mention(f, ROOM_A, "admitted, still pending");
    const completed = mention(f, ROOM_A, "admitted and completed");
    const seam = (event: ReturnType<typeof mention>) => f.deliver(ROOM_A, event as unknown as Parameters<typeof f.deliver>[1]);
    expect((await seam(pending)).allowed).toBe(true);
    expect((await seam(completed)).allowed).toBe(true);
    // The holder takes the second and completes it: a receipt.
    const binding = f.holder();
    const holder = { roleKey: f.roleKey, bindingGeneration: binding.bindingGeneration, targetSessionId: binding.sessionId,
      sessionIncarnation: binding.sessionIncarnation };
    const claimed = f.h.cp.outbox.claimForHolder(holder);
    expect(claimed.claimed).toHaveLength(1);
    expect(f.h.cp.outbox.completeForHolder(claimed.claimed[0]!.messageId, holder).allowed).toBe(true);
    // A later address write moves the anchor past both, so a replay of either is refused.
    f.h.clock.advance(5000);
    v50Connect(f.h, f.first.sessionId, ROOM_A);
    const path = v50Image(f, "acp-r6-v50-admitted-replay-");
    const { rows, unknown } = migrated(path);
    f.install(rows, unknown);
    const before = deliveryState(f.h);
    expect(before.outbox).toHaveLength(2);
    const live = await daemon(f, [ROOM_A]);
    try {
      await live.publish(pending);
      await live.publish(completed);
      expect(deliveryState(f.h)).toEqual(before);
      // The pending one is refused as signed before the anchor, and recorded; the completed one's
      // turn is already spent, so it is answered as already durable. Neither touches what exists.
      expect(refusalsRecorded(f.h).map((row) => (row.evidence_json as { eventId: string }).eventId)).toEqual([pending.id]);
      expect(live.subscriber.counters()).toMatchObject({ admitted: 0,
        rejections: { "admission-precedes-binding": 1, "admission-already-durable": 1 } });
    } finally { await live.close(); }
  } finally { f.h.cp.close(); }
});

/** A role whose anchor is `offsetMs` after a whole second S (negative: before it), and mail signed at S-1, S and S+1. */
const boundaryCase = async (offsetMs: number) => {
  const f = start();
  f.h.clock.advance(10_000);
  const wholeSecond = seconds(f.h.clock.nowIso());
  f.h.clock.advance(offsetMs);
  const anchorAt = f.h.clock.nowIso();
  v50SetAddress(f.h, f.first.sessionId, ROOM_A);
  const signedAt = (second: number) => signedMention({ author: f.owner.secretKey, addressedTo: f.cto.pubkey, room: ROOM_A,
    createdAt: second, text: `signed at ${second}` });
  const path = v50Image(f, "acp-r6-v50-boundary-");
  const { rows, unknown } = migrated(path);
  expect(unknown[0]!.known_since).toBe(anchorAt);
  f.install(rows, unknown);
  const live = await daemon(f, [ROOM_A]);
  const outcomes: Record<string, "admitted" | "refused and recorded" | "refused unrecorded"> = {};
  try {
    for (const [name, second] of [["S-1", wholeSecond - 1], ["S", wholeSecond], ["S+1", wholeSecond + 1]] as const) {
      const event = signedAt(second);
      const admittedBefore = ownerMessages(f.h).length;
      await live.publish(event);
      const recorded = refusalsRecorded(f.h).some((row) => (row.evidence_json as { eventId: string }).eventId === event.id);
      outcomes[name] = ownerMessages(f.h).length > admittedBefore ? "admitted" : recorded ? "refused and recorded" : "refused unrecorded";
    }
  } finally { await live.close(); f.h.cp.close(); }
  return { joinedAt: rows[0]!.joined_at, wholeSecond: new Date(wholeSecond * 1000).toISOString(), outcomes };
};

it("limit (b): an anchor exactly on a whole second S admits mail signed in S and refuses (with a record) mail signed in S-1", async () => {
  const { joinedAt, wholeSecond, outcomes } = await boundaryCase(0);
  expect(joinedAt).toBe(wholeSecond);
  expect(outcomes).toEqual({ "S-1": "refused and recorded", S: "admitted", "S+1": "admitted" });
});

it("limit (b): an anchor 1 ms after S refuses mail signed in S, which may precede it (with a record), and admits S+1", async () => {
  const { joinedAt, wholeSecond, outcomes } = await boundaryCase(1);
  expect(joinedAt).toBe(new Date(Date.parse(wholeSecond) + 1000).toISOString());
  expect(outcomes).toEqual({ "S-1": "refused and recorded", S: "refused and recorded", "S+1": "admitted" });
});

it("limit (b): an anchor 1 ms before S admits mail signed in S, and refuses mail signed in S-1, which may precede it (with a record)", async () => {
  const { joinedAt, wholeSecond, outcomes } = await boundaryCase(-1);
  expect(joinedAt).toBe(wholeSecond);
  expect(outcomes).toEqual({ "S-1": "refused and recorded", S: "admitted", "S+1": "admitted" });
});

it("limit (c): stop-window mail is admitted while the anchored binding, runtime and room are unchanged", async () => {
  const f = start();
  try {
    f.h.clock.advance(1000);
    const duringStop = mention(f, ROOM_A, "published during the deploy stop");
    const { rows, unknown } = migrated(v50Image(f, "acp-r6-v50-stop-window-"));
    f.install(rows, unknown);
    const live = await daemon(f, [ROOM_A]);
    try {
      await live.publish(duringStop);
      expect(ownerMessages(f.h)).toHaveLength(1);
      expect(refusalsRecorded(f.h)).toEqual([]);
    } finally { await live.close(); }
  } finally { f.h.cp.close(); }
});

it.each([
  ["a new binding generation in the same room", (f: Fixture) => { f.moveTo(ROOM_A); }],
  ["a same-generation runtime move in the same room", (f: Fixture) => {
    f.h.clock.advance(1000);
    expect(f.h.cp.sessions.transition(f.first.sessionId, SessionLifecycle.STOPPED, "runtime moves").allowed).toBe(true);
    moveRuntime(f, readyIn(f.h, ROOM_A, f.cto).sessionId, "same conversation, new runtime");
  }],
] as const)("limit (c): after %s, stop-window mail is refused with a record", async (_what, change) => {
  const f = start();
  try {
    f.h.clock.advance(1000);
    const duringStop = mention(f, ROOM_A, "published during the deploy stop");
    const { rows, unknown } = migrated(v50Image(f, "acp-r6-v50-stop-window-changed-"));
    f.install(rows, unknown);
    change(f);
    const live = await daemon(f, [ROOM_A]);
    try {
      await live.publish(duringStop);
      expect(ownerMessages(f.h)).toEqual([]);
      expect(refusalsRecorded(f.h)).toEqual([expect.objectContaining({ role_key: f.roleKey, reason_code: ReasonCode.BUZZ_MENTION_PRECEDES_BINDING,
        evidence_json: expect.objectContaining({ eventId: duringStop.id, cause: "SIGNED_BEFORE_KNOWN_ROOM_HISTORY" }) })]);
      // Mail signed after the migration is the current binding's, judged on the history recorded since.
      await live.publish(signedMention({ author: f.owner.secretKey, addressedTo: f.cto.pubkey, room: ROOM_A,
        createdAt: seconds(unknown[0]!.unknown_before) + 1, text: "after the migration" }));
      expect(ownerMessages(f.h)).toHaveLength(1);
      expect(refusalsRecorded(f.h)).toHaveLength(1);
    } finally { await live.close(); }
  } finally { f.h.cp.close(); }
});
