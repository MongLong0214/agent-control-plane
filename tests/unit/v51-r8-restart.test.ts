import Database from "better-sqlite3";
import { chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";

import { startBuzzMessageIngressListener, startDaemonBuzzMentionSubscriber } from "../../src/daemon/agentcpd.ts";
import { Db } from "../../src/db/database.ts";
import { approveMigration } from "../../src/db/migration-approval.ts";
import { Role, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { CeoConversationPort } from "../../src/mcp/ceo-conversation.ts";
import { channelKey, signedMention, steppedClock, storingRelay, writeSubscriberConfig } from "../helpers/buzz-mention-relay.ts";
import { cleanupTempDirs, seedRun, tempDir } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";
import { carryRows, releasedChainImage } from "../helpers/released-chain-image.ts";
import { privateStatePath } from "../helpers/released-v44-schema.ts";

afterAll(cleanupTempDirs);
const ROOM = "restart-room-a";
const OTHER_ROOM = "restart-room-b";
const PROJECT = "restart-project";
const SECRET = "restart-ingress-secret";

/** Real v50 -> v51 runner output, installed into the harness as in the r7 history tests. */
const restart = async (sharedActor = false) => {
  const dir = tempDir("acp-v51-r8-");
  chmodSync(dir, 0o700);
  const owner = channelKey(dir, "owner");
  const cto = channelKey(dir, "cto");
  const h = makeHarness({ ownerIdentities: [{ channel: "buzz", actor: owner.pubkey }] });
  h.cp.db.run("INSERT INTO projects (project_id, name, created_at) VALUES (?, ?, ?)", [PROJECT, PROJECT, h.clock.nowIso()]);
  const ready = () => {
    const session = h.cp.sessions.create({ provider: "scripted", model: "test", buzzAddress: ROOM });
    expect(h.cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "test").allowed).toBe(true);
    return session;
  };
  const first = ready();
  expect(h.cp.sessions.bindBuzzActor({ sessionId: first.sessionId, sessionSecret: first.sessionSecret!, buzzActorId: cto.pubkey },
    { isAllowedActor: () => true }).allowed).toBe(true);
  const roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId: PROJECT });
  const target = { executorKind: "hermes", targetLocator: "restart-shared-target", targetLocatorDigest: "sha256:" + "8".repeat(64) };
  expect(h.cp.bindings.bind({ role: Role.PRIMARY_CTO, projectId: PROJECT, sessionId: first.sessionId, verifiedTarget: target }).allowed).toBe(true);
  let siblingRun: string | undefined;
  if (sharedActor) {
    siblingRun = seedRun({ db: h.cp.db, clock: h.clock, repoPath: h.repoPath }).runId;
    expect(h.cp.bindings.bind({ role: Role.OPTIONAL_ADVERSARIAL_REVIEWER, runId: siblingRun, sessionId: first.sessionId,
      verifiedTarget: target }).allowed).toBe(true);
  }
  h.clock.advance(1000);
  const signedAt = Math.floor(Date.parse(h.clock.nowIso()) / 1000);
  const path = releasedChainImage(privateStatePath("acp-r8-v50-"), 50);
  carryRows(join(h.root, "state.sqlite"), path);
  approveMigration(path, "v51-r8 restart regression");
  const migrated = new Db(path);
  try {
    const anchor = migrated.get<{ unknown_before: string; known_since: string; anchor_fallback: string | null }>(
      "SELECT unknown_before, known_since, anchor_fallback FROM role_room_history_unknown WHERE role_key = ?", [roleKey])!;
    expect(anchor.anchor_fallback).toBeNull();
    expect(signedAt * 1000).toBeGreaterThan(Date.parse(anchor.known_since));
    expect(signedAt * 1000).toBeLessThan(Date.parse(anchor.unknown_before));
    h.cp.db.run("DELETE FROM role_room_memberships WHERE role_key = ?", [roleKey]);
    const membership = migrated.get<{ joined_at: string }>(
      "SELECT joined_at FROM role_room_memberships WHERE role_key = ? AND conversation = ?", [roleKey, ROOM])!;
    h.cp.db.run("INSERT INTO role_room_memberships (role_key, conversation, joined_at, session_id) VALUES (?, ?, ?, ?)",
      [roleKey, ROOM, membership.joined_at, first.sessionId]);
    const row = migrated.get<Record<string, string | number | null>>("SELECT * FROM role_room_history_unknown WHERE role_key = ?", [roleKey])!;
    const columns = Object.keys(row);
    h.cp.db.run(`INSERT INTO role_room_history_unknown (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`, Object.values(row));
    // A restart 500ms after migration, including when both fall in the same signed second.
    h.clock.advance(Date.parse(anchor.unknown_before) + 500 - Date.parse(h.clock.nowIso()));
  } finally { migrated.close(); }
  h.cp.sessions.setPid(first.sessionId, null);
  expect(h.cp.sessions.rotateSecret(first.sessionId, 0).allowed).toBe(true);
  writeSubscriberConfig(dir, [{ keyFile: cto.keyFile, rooms: [ROOM] }]);
  const policy = { allowedActors: [owner.pubkey], secret: SECRET };
  const listener = await startBuzzMessageIngressListener(h.cp, dir, policy, {
    ceoConversation: new CeoConversationPort(), ownerActors: [owner.pubkey],
  });
  const relay = storingRelay();
  const clock = steppedClock();
  const subscriber = startDaemonBuzzMentionSubscriber(h.cp, dir, policy, listener, {
    openSocket: relay.factory, scheduler: clock.scheduler, reportAdmission: () => undefined,
  });
  await relay.drain(subscriber);
  const close = async () => { subscriber.close(); await listener.close(); h.cp.close(); };
  const deliver = async (text: string) => {
    const event = signedMention({ author: owner.secretKey, addressedTo: cto.pubkey, room: ROOM, createdAt: signedAt, text });
    const before = h.cp.db.all("SELECT message_id FROM outbox WHERE kind = 'OWNER_MESSAGE'").length;
    relay.publish(event);
    await relay.drain(subscriber);
    const after = h.cp.db.all("SELECT message_id FROM outbox WHERE kind = 'OWNER_MESSAGE'").length;
    if (after > before) return "admitted";
    const refusal = h.cp.db.get<{ evidence_json: string }>(
      "SELECT evidence_json FROM audit_events WHERE kind = 'BUZZ_MENTION_REFUSED' AND json_extract(evidence_json, '$.eventId') = ?", [event.id]);
    return refusal && JSON.parse(refusal.evidence_json).cause === "SIGNED_BEFORE_KNOWN_ROOM_HISTORY"
      ? "refused and recorded" : "refused unrecorded";
  };
  return { h, first, roleKey, ready, deliver, close, target, siblingRun };
};

it("restart pid and credential writes preserve admission of stop-window mail", async () => {
  const f = await restart();
  try { expect(await f.deliver("after daemon restart")).toBe("admitted"); }
  finally { await f.close(); }
});

it.each(["address A->B->A", "runtime S->T->S", "binding change"] as const)(
  "after restart, %s refuses stop-window mail with a durable record", async (change) => {
    const f = await restart();
    try {
      // This assertion fails at afde40f5 in every case: a restart already ended admission.
      expect(await f.deliver(`before ${change}`)).toBe("admitted");
      const { cp } = f.h;
      if (change === "address A->B->A") {
        cp.sessions.setBuzzAddress(f.first.sessionId, OTHER_ROOM);
        f.h.clock.advance(1);
        cp.sessions.setBuzzAddress(f.first.sessionId, ROOM);
        expect(cp.audit.byKind("SESSION_BUZZ_ADDRESS_CHANGED")).toHaveLength(2);
      } else if (change === "runtime S->T->S") {
        const next = f.ready();
        for (const sessionId of [next.sessionId, f.first.sessionId]) {
          expect(cp.bindings.switchTo({ role: Role.PRIMARY_CTO, projectId: PROJECT, sessionId,
            conversation: "SURVIVED", reason: "restart runtime move" }).allowed).toBe(true);
          f.h.clock.advance(1);
        }
        expect(cp.audit.byKind("BINDING_RUNTIME_MOVED")).toHaveLength(2);
      } else {
        expect(cp.bindings.switchTo({ role: Role.PRIMARY_CTO, projectId: PROJECT, sessionId: f.first.sessionId,
          conversation: "REPLACED", reason: "new binding" }).allowed).toBe(true);
        expect(cp.bindings.active(f.roleKey)!.bindingGeneration).toBe(2);
      }
      expect(await f.deliver(`after ${change}`)).toBe("refused and recorded");
    } finally { await f.close(); }
  },
);

it("the writer census evidence survives restart and rolls back with a failed address or runtime audit", async () => {
  const f = await restart();
  try {
    // Proves the consumer uses the audited writers' evidence without treating restart as a change.
    expect(await f.deliver("census after restart")).toBe("admitted");
    const { cp } = f.h;
    const raw = new Database(join(f.h.root, "state.sqlite"));
    try {
      for (const kind of ["SESSION_BUZZ_ADDRESS_CHANGED", "BINDING_RUNTIME_MOVED"]) {
        raw.exec(`CREATE TRIGGER r8_fail_audit BEFORE INSERT ON audit_events WHEN NEW.kind = '${kind}'
          BEGIN SELECT RAISE(ABORT, 'r8 audit failure'); END`);
        try {
          if (kind === "SESSION_BUZZ_ADDRESS_CHANGED") {
            expect(() => cp.sessions.setBuzzAddress(f.first.sessionId, OTHER_ROOM)).toThrow("r8 audit failure");
            expect(cp.sessions.get(f.first.sessionId)!.buzzAddress).toBe(ROOM);
          } else {
            const next = f.ready();
            expect(() => cp.bindings.switchTo({ role: Role.PRIMARY_CTO, projectId: PROJECT, sessionId: next.sessionId,
              conversation: "SURVIVED", reason: "failed audit" })).toThrow("r8 audit failure");
            expect(cp.bindings.active(f.roleKey)!.sessionId).toBe(f.first.sessionId);
          }
          expect(cp.audit.byKind(kind)).toHaveLength(0);
        } finally { raw.exec("DROP TRIGGER r8_fail_audit"); }
      }
    } finally { raw.close(); }
    // Creation with an address is an INSERT, never replacement of an anchored session.
    expect(() => cp.sessions.create({ sessionId: f.first.sessionId, provider: "scripted", model: "test",
      buzzAddress: OTHER_ROOM })).toThrow();
    expect(cp.sessions.get(f.first.sessionId)!.buzzAddress).toBe(ROOM);
    const ingress = readFileSync(new URL("../../src/daemon/agentcpd.ts", import.meta.url), "utf8");
    const check = ingress.slice(ingress.indexOf("recipientHistorySince: (roleKey, conversation)"), ingress.indexOf("existingRoleMessage: (input)"));
    expect(check).toContain("SESSION_BUZZ_ADDRESS_CHANGED");
    expect(check).not.toContain("updated_at");
    expect(await f.deliver("census after rollback")).toBe("admitted");
  } finally { await f.close(); }
});


it.each(["switch", "rebind"] as const)("a shared actor's %s through a sibling role records both runtime moves for the anchored role", async (writer) => {
  const f = await restart(true);
  try {
    expect(await f.deliver(`shared actor before ${writer}`)).toBe("admitted");
    const next = f.ready();
    const { cp } = f.h;
    const siblingRoleKey = roleKeyFor(Role.OPTIONAL_ADVERSARIAL_REVIEWER, { runId: f.siblingRun! });
    for (const sessionId of [next.sessionId, f.first.sessionId]) {
      if (writer === "switch") {
        expect(cp.bindings.switchTo({ role: Role.OPTIONAL_ADVERSARIAL_REVIEWER, runId: f.siblingRun!, sessionId,
          conversation: "SURVIVED", reason: "shared runtime move" }).allowed).toBe(true);
      } else {
        expect(cp.bindings.revoke(siblingRoleKey, "shared runtime rebind").allowed).toBe(true);
        expect(cp.bindings.bind({ role: Role.OPTIONAL_ADVERSARIAL_REVIEWER, runId: f.siblingRun!, sessionId,
          verifiedTarget: f.target }).allowed).toBe(true);
      }
      f.h.clock.advance(1);
    }
    expect(cp.bindings.active(f.roleKey)).toMatchObject({ bindingGeneration: 1, sessionId: f.first.sessionId });
    expect(cp.audit.byKind("BINDING_RUNTIME_MOVED").filter((event) => event.roleKey === f.roleKey)).toHaveLength(2);
    expect(await f.deliver(`shared actor after ${writer}`)).toBe("refused and recorded");
  } finally { await f.close(); }
});
