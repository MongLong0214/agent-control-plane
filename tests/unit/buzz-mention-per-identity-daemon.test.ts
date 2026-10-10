import { chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import type { BuzzMentionEvent } from "../../src/buzz/buzz-mention-subscriber.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import {
  buzzMentionBindingMoved,
  buzzMentionSubscriberRegistry,
  rejudgeBuzzMentionSubscriberOnBindingSwitch,
  startBuzzMessageIngressListener,
  startDaemonBuzzMentionSubscriber,
} from "../../src/daemon/agentcpd.ts";
import { Daemon } from "../../src/daemon/daemon.ts";
import { Role, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { buzzMessageNonce } from "../../src/ingress/buzz-message.ts";
import { CeoConversationPort } from "../../src/mcp/ceo-conversation.ts";
import { MessageKind } from "../../src/outbox/envelope.ts";
import {
  channelKey,
  type ChannelKey,
  signedMention,
  steppedClock,
  storingRelay,
  writeSubscriberConfig,
} from "../helpers/buzz-mention-relay.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * The same contract as `buzz-mention-per-identity-admission.test.ts`, through the daemon's own
 * composition: the registry's judgement over one control plane, the sink and the admission seam,
 * and re-judgement driven by the binding registry's own switch events. The relay is the stored
 * in-process one; nothing else is substituted.
 */

const SECRET = "buzz-per-identity-daemon-secret";
const CTOS = ["logic", "repoFactory", "commitlore"] as const;
type Cto = (typeof CTOS)[number];
const PROJECT: Record<Cto, string> = { logic: "logic-pro-mcp", repoFactory: "repo-factory", commitlore: "commitlore" };
const ROOM: Record<Cto, string> = { logic: "room-logic", repoFactory: "room-repo-factory", commitlore: "room-commitlore" };

type Harness = ReturnType<typeof makeHarness>;
const secondsOf = (iso: string): number => Math.floor(Date.parse(iso) / 1000);

/** A READY session carrying `key` as its channel identity and answering in `room`. */
const liveSession = (h: Harness, key: ChannelKey, room: string) => {
  const session = h.cp.sessions.create({ provider: "scripted", model: "cto", buzzAddress: room });
  expect(h.cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "test").reasonCode).toBe(ReasonCode.OK);
  const bound = h.cp.sessions.bindBuzzActor(
    { sessionId: session.sessionId, sessionSecret: session.sessionSecret!, buzzActorId: key.pubkey },
    { isAllowedActor: () => true },
  );
  if (!bound.allowed) throw new Error(`channel identity binding failed: ${bound.message}`);
  return session.sessionId;
};

const start = async (options: { logicBound: boolean }) => {
  const dir = tempDir("acp-bpi-");
  chmodSync(dir, 0o700);
  const keys = {
    logic: channelKey(dir, "logic.key"),
    repoFactory: channelKey(dir, "repo-factory.key"),
    commitlore: channelKey(dir, "commitlore.key"),
  };
  const owner = channelKey(dir, "owner.key");
  const h = makeHarness({ ownerIdentities: [{ channel: "buzz", actor: owner.pubkey }] });
  const sessions = {} as Record<Cto, string>;
  for (const cto of CTOS) {
    h.cp.db.run(`INSERT INTO projects (project_id, name, created_at) VALUES (?, ?, ?)`, [
      PROJECT[cto], cto, h.cp.clock.nowIso(),
    ]);
    sessions[cto] = liveSession(h, keys[cto], ROOM[cto]);
    const bound = h.cp.bindings.bind({ role: Role.PRIMARY_CTO, sessionId: sessions[cto], projectId: PROJECT[cto] });
    if (!bound.allowed) throw new Error(`binding ${cto} failed: ${bound.message}`);
  }
  // The owner paused Logic: its binding is gone and its session still carries its identity.
  if (!options.logicBound) {
    expect(h.cp.bindings.revoke(roleKeyFor(Role.PRIMARY_CTO, { projectId: PROJECT.logic }), "owner pause").allowed).toBe(true);
  }
  writeSubscriberConfig(dir, CTOS.map((cto) => ({ keyFile: keys[cto].keyFile, rooms: [ROOM[cto]] })));
  const policy = { allowedActors: [owner.pubkey], secret: SECRET };
  const ingress = await startBuzzMessageIngressListener(h.cp, dir, policy, {
    ceoConversation: new CeoConversationPort(),
    ownerActors: [owner.pubkey],
  });
  const relay = storingRelay();
  const clock = steppedClock();
  const changes: string[] = [];
  const subscriber = startDaemonBuzzMentionSubscriber(h.cp, dir, policy, ingress, {
    openSocket: relay.factory,
    scheduler: clock.scheduler,
    reportAdmission: (change) => changes.push(`${change.identity}:${change.state}:${change.reason ?? change.roleKey}`),
  });
  rejudgeBuzzMentionSubscriberOnBindingSwitch(h.cp, () => subscriber);
  await relay.drain(subscriber);
  return {
    h,
    dir,
    keys,
    sessions,
    relay,
    clock,
    subscriber,
    changes,
    mention: (to: Cto, text: string): BuzzMentionEvent =>
      signedMention({
        author: owner.secretKey,
        addressedTo: keys[to].pubkey,
        room: ROOM[to],
        createdAt: secondsOf(h.cp.clock.nowIso()),
        text,
      }),
    ownerMessages: () =>
      h.cp.db.all<{ role_key: string; target_session_id: string }>(
        `SELECT role_key, target_session_id FROM outbox WHERE kind = ? ORDER BY created_at, rowid`,
        [MessageKind.OWNER_MESSAGE],
      ),
    admittedRow: (eventId: string) =>
      h.cp.db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM inbound_messages WHERE channel = 'buzz' AND nonce = ?`,
        [buzzMessageNonce(eventId)],
      )!.n,
    close: async () => {
      subscriber.close();
      await ingress.close();
      h.cp.close();
    },
  };
};

describe("the daemon's subscriber with the Logic CTO paused", () => {
  it("starts, delivers repo-factory's and CommitLore's mentions, and leaves Logic's unconsumed", async () => {
    const f = await start({ logicBound: false });
    try {
      expect(f.subscriber.socketCount).toBe(3);
      expect(f.relay.openFor(f.keys.logic.pubkey)).toHaveLength(0);
      expect(f.changes).toEqual(["identities[0]:EXCLUDED:NO_SINGLE_MENTIONABLE_ROLE"]);

      f.h.clock.advance(1_000);
      const toRepoFactory = f.mention("repoFactory", "repo-factory, status");
      const toCommitlore = f.mention("commitlore", "CommitLore, status");
      const toLogic = f.mention("logic", "Logic, status");
      for (const event of [toRepoFactory, toCommitlore, toLogic]) f.relay.publish(event);
      await f.relay.drain(f.subscriber);

      expect(f.ownerMessages()).toEqual([
        { role_key: roleKeyFor(Role.PRIMARY_CTO, { projectId: PROJECT.repoFactory }), target_session_id: f.sessions.repoFactory },
        { role_key: roleKeyFor(Role.PRIMARY_CTO, { projectId: PROJECT.commitlore }), target_session_id: f.sessions.commitlore },
      ]);
      expect(f.admittedRow(toLogic.id)).toBe(0);
      expect(f.relay.requested.map((request) => request.pubkey)).not.toContain(f.keys.logic.pubkey);
    } finally {
      await f.close();
    }
  });

  it("writes the partial state and its reason into health.json, beside the counters", async () => {
    const f = await start({ logicBound: false });
    try {
      const daemon = new Daemon(f.h.cp, { stateDir: f.dir });
      // main()'s wiring, line for line.
      daemon.setBuzzMentionReceipt({
        configuredIdentities: f.subscriber.socketCount,
        counters: () => f.subscriber.counters(),
      });
      const health = JSON.parse(readFileSync(join(f.dir, "health.json"), "utf8")) as {
        buzzMention: { configuredIdentities: number; admission: { continuity: string; identities: { identity: string; state: string; reason: string | null }[] } };
      };
      expect(health.buzzMention.configuredIdentities).toBe(3);
      expect(health.buzzMention.admission.continuity).toBe("PARTIAL");
      expect(health.buzzMention.admission.identities.map((one) => [one.identity, one.state, one.reason])).toEqual([
        ["identities[0]", "EXCLUDED", "NO_SINGLE_MENTIONABLE_ROLE"],
        ["identities[1]", "ADMITTED", null],
        ["identities[2]", "ADMITTED", null],
      ]);
    } finally {
      await f.close();
    }
  });
});

describe("re-judgement through the binding registry's own switch events", () => {
  it("refuses delivery after a revoke, and after a re-claim delivers only to the new session", async () => {
    const f = await start({ logicBound: true });
    const roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId: PROJECT.repoFactory });
    try {
      f.h.clock.advance(1_000);
      f.relay.publish(f.mention("repoFactory", "before the revoke"));
      await f.relay.drain(f.subscriber);
      expect(f.ownerMessages().filter((row) => row.role_key === roleKey)).toEqual([
        { role_key: roleKey, target_session_id: f.sessions.repoFactory },
      ]);

      expect(f.h.cp.bindings.revoke(roleKey, "test revoke").allowed).toBe(true);
      await f.relay.drain(f.subscriber);
      // The switch event re-judged it: no connection, and the reason in health.
      expect(f.relay.openFor(f.keys.repoFactory.pubkey)).toHaveLength(0);
      expect(f.subscriber.admission().identities[1]).toMatchObject({ state: "EXCLUDED", reason: "NO_SINGLE_MENTIONABLE_ROLE" });

      f.h.clock.advance(1_000);
      const whileRevoked = f.mention("repoFactory", "while revoked");
      f.relay.publish(whileRevoked);
      await f.relay.drain(f.subscriber);
      expect(f.admittedRow(whileRevoked.id)).toBe(0);

      // Re-claimed by a new session at the next generation, with the same channel identity.
      f.h.clock.advance(1_000);
      expect(f.h.cp.sessions.transition(f.sessions.repoFactory, SessionLifecycle.STOPPED, "replaced").reasonCode).toBe(ReasonCode.OK);
      const next = liveSession(f.h, f.keys.repoFactory, ROOM.repoFactory);
      expect(f.h.cp.bindings.bind({ role: Role.PRIMARY_CTO, sessionId: next, projectId: PROJECT.repoFactory }).allowed).toBe(true);
      await f.relay.drain(f.subscriber);
      expect(f.relay.openFor(f.keys.repoFactory.pubkey)).toHaveLength(1);

      f.h.clock.advance(1_000);
      f.relay.publish(f.mention("repoFactory", "after the re-claim"));
      await f.relay.drain(f.subscriber);

      const rows = f.ownerMessages().filter((row) => row.role_key === roleKey);
      expect(rows.map((row) => row.target_session_id)).toEqual([f.sessions.repoFactory, next]);
      // The mention sent while revoked was signed before the new binding existed, and the seam's
      // floor refuses it for that binding: it reached neither session.
      expect(f.admittedRow(whileRevoked.id)).toBe(0);
      expect(f.changes).toEqual(["identities[1]:EXCLUDED:NO_SINGLE_MENTIONABLE_ROLE", `identities[1]:ADMITTED:${roleKey}`]);
    } finally {
      await f.close();
    }
  });

  it("refuses at the sink a delivery whose binding moved after the subscriber judged it", async () => {
    const f = await start({ logicBound: true });
    const roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId: PROJECT.repoFactory });
    try {
      const current = f.h.cp.bindings.active(roleKey)!;
      const judged = { bindingGeneration: current.bindingGeneration, sessionId: current.sessionId };
      expect(buzzMentionBindingMoved(f.h.cp, roleKey, judged)).toBe(false);

      expect(f.h.cp.sessions.transition(f.sessions.repoFactory, SessionLifecycle.STOPPED, "replaced").reasonCode).toBe(ReasonCode.OK);
      const next = liveSession(f.h, f.keys.repoFactory, ROOM.repoFactory);
      expect(f.h.cp.bindings.switchTo({
        role: Role.PRIMARY_CTO,
        projectId: PROJECT.repoFactory,
        sessionId: next,
        reason: "test takeover",
        conversation: "REPLACED",
      }).allowed).toBe(true);
      expect(buzzMentionBindingMoved(f.h.cp, roleKey, judged)).toBe(true);
      expect(buzzMentionBindingMoved(f.h.cp, roleKey, { bindingGeneration: judged.bindingGeneration + 1, sessionId: next })).toBe(false);

      expect(f.h.cp.bindings.revoke(roleKey, "test revoke").allowed).toBe(true);
      expect(buzzMentionBindingMoved(f.h.cp, roleKey, { bindingGeneration: judged.bindingGeneration + 1, sessionId: next })).toBe(true);
    } finally {
      await f.close();
    }
  });
});

describe("the registry's judgement of one identity", () => {
  it("names each reason it excludes for, and requires a canonical identity's binding on its entry's project and conversation", async () => {
    const f = await start({ logicBound: true });
    try {
      const key = f.keys.repoFactory.pubkey;
      const entry = { sessionUuid: "11111111-1111-4111-8111-111111111111", buzzActorId: key };
      const onItsProject = buzzMentionSubscriberRegistry(f.h.cp, { sessions: [{ ...entry, projectId: PROJECT.repoFactory }] });
      const onAnother = buzzMentionSubscriberRegistry(f.h.cp, { sessions: [{ ...entry, projectId: PROJECT.commitlore }] });

      // Bound with no canonical target: an entry names one conversation, and an ACTIVE assignment on
      // a READY runtime without that conversation's target is not it (1080-N1-05).
      expect(onItsProject.judgeIdentity!(key)).toEqual({ verdict: "EXCLUDED", reason: "CANONICAL_TARGET_UNVERIFIED" });
      // Outside canonical activation the same binding is admitted, with the room it answers in.
      expect(buzzMentionSubscriberRegistry(f.h.cp).judgeIdentity!(key)).toEqual({
        verdict: "ADMITTED",
        binding: {
          roleKey: roleKeyFor(Role.PRIMARY_CTO, { projectId: PROJECT.repoFactory }),
          buzzActorId: key,
          bindingGeneration: f.h.cp.bindings.active(roleKeyFor(Role.PRIMARY_CTO, { projectId: PROJECT.repoFactory }))!.bindingGeneration,
          sessionId: f.sessions.repoFactory,
          projectId: PROJECT.repoFactory,
          room: ROOM.repoFactory,
        },
      });
      expect(onAnother.judgeIdentity!(key)).toEqual({ verdict: "EXCLUDED", reason: "PROJECT_MISMATCH" });

      // Paused by stopping its session: the ACTIVE assignment alone is not enough.
      expect(f.h.cp.sessions.transition(f.sessions.repoFactory, SessionLifecycle.STOPPED, "paused").reasonCode).toBe(ReasonCode.OK);
      expect(onItsProject.judgeIdentity!(key)).toEqual({ verdict: "EXCLUDED", reason: "NO_LIVE_SESSION" });
      // And a READY session whose binding was revoked: the READY row alone is not enough.
      const commitloreKey = f.keys.commitlore.pubkey;
      expect(f.h.cp.bindings.revoke(roleKeyFor(Role.PRIMARY_CTO, { projectId: PROJECT.commitlore }), "test").allowed).toBe(true);
      expect(onItsProject.judgeIdentity!(commitloreKey)).toEqual({ verdict: "EXCLUDED", reason: "NO_SINGLE_MENTIONABLE_ROLE" });
    } finally {
      await f.close();
    }
  });
});
