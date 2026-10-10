import { chmodSync } from "node:fs";

import { afterAll, describe, expect, it, vi } from "vitest";

import type * as Subscriber from "../../src/buzz/buzz-mention-subscriber.ts";
import type { BuzzMentionEvent, BuzzMentionSink } from "../../src/buzz/buzz-mention-subscriber.ts";
import { digestOf, sha256 } from "../../src/core/digest.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import {
  buzzMentionSubscriberRegistry,
  rejudgeBuzzMentionSubscriberOnBindingSwitch,
  startBuzzMessageIngressListener,
  startDaemonBuzzMentionSubscriber,
} from "../../src/daemon/agentcpd.ts";
import { Role, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { buzzMessageNonce } from "../../src/ingress/buzz-message.ts";
import { CeoConversationPort } from "../../src/mcp/ceo-conversation.ts";
import { MessageKind } from "../../src/outbox/envelope.ts";
import { SELF_CLAIM_EXECUTOR_KIND, SELF_CLAIM_PROTOCOL } from "../../src/registry/canonical-self-claim.ts";
import { channelKey, type ChannelKey, signedMention, steppedClock, storingRelay, writeSubscriberConfig } from "../helpers/buzz-mention-relay.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * The closure witnesses for review 1 of the per-identity Buzz mention admission (1080-N1-02..05
 * and the sink half of 1080-N1-01), through the daemon's own composition: the registry's judgement
 * over one control plane, the real sink and admission seam, and the in-process storing relay.
 */

/** The sink `startDaemonBuzzMentionSubscriber` builds, captured on its way in so a row can call it. */
const captured = vi.hoisted(() => ({ sinks: [] as BuzzMentionSink[] }));
vi.mock("../../src/buzz/buzz-mention-subscriber.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof Subscriber>();
  return {
    ...actual,
    startBuzzMentionSubscriberFromStateDir: (...args: Parameters<typeof actual.startBuzzMentionSubscriberFromStateDir>) => {
      captured.sinks.push(args[1].sink);
      return actual.startBuzzMentionSubscriberFromStateDir(...args);
    },
  };
});

const SECRET = "buzz-review-1080-secret";
const CTOS = ["logic", "repoFactory", "commitlore"] as const;
type Cto = (typeof CTOS)[number];
const PROJECT: Record<Cto, string> = { logic: "logic-pro-mcp", repoFactory: "repo-factory", commitlore: "commitlore" };
const ROOM: Record<Cto, string> = { logic: "room-logic", repoFactory: "room-repo-factory", commitlore: "room-commitlore" };
const CONVERSATION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_CONVERSATION = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

type Harness = ReturnType<typeof makeHarness>;
const secondsOf = (iso: string): number => Math.floor(Date.parse(iso) / 1000);

const liveSession = (h: Harness, key: ChannelKey, room: string | null): string => {
  const session = h.cp.sessions.create({ provider: "scripted", model: "cto", buzzAddress: room });
  expect(h.cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "test").reasonCode).toBe(ReasonCode.OK);
  const bound = h.cp.sessions.bindBuzzActor(
    { sessionId: session.sessionId, sessionSecret: session.sessionSecret!, buzzActorId: key.pubkey },
    { isAllowedActor: () => true },
  );
  if (!bound.allowed) throw new Error(`channel identity binding failed: ${bound.message}`);
  return session.sessionId;
};

/** Binds repo-factory's role with the claude-cli target for `conversation`, as the canonical claim does. */
const bindOnConversation = (h: Harness, sessionId: string, conversation: string) => {
  const claimed = { executorKind: SELF_CLAIM_EXECUTOR_KIND, targetLocator: conversation, targetLocatorDigest: sha256(conversation) };
  return h.cp.bindings.bind({
    role: Role.PRIMARY_CTO,
    sessionId,
    projectId: PROJECT.repoFactory,
    authenticatedTarget: {
      claimed,
      protocolVersion: SELF_CLAIM_PROTOCOL,
      attestationDigest: digestOf({ fixture: "review-1080", sessionId }),
      verify: () => claimed,
    },
  });
};

/**
 * Three CTO identities, each bound and in its own room. With `canonical`, repo-factory is named by a
 * canonical entry for CONVERSATION and is bound on `canonical` evidence: none, another conversation's
 * target, or CONVERSATION's own.
 */
const start = async (options: { canonical?: "missing" | "different" | "correct" } = {}) => {
  const dir = tempDir("acp-r1080-");
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
    h.cp.db.run(`INSERT INTO projects (project_id, name, created_at) VALUES (?, ?, ?)`, [PROJECT[cto], cto, h.cp.clock.nowIso()]);
    sessions[cto] = liveSession(h, keys[cto], ROOM[cto]);
    const bound =
      cto === "repoFactory" && options.canonical !== undefined && options.canonical !== "missing"
        ? bindOnConversation(h, sessions[cto], options.canonical === "correct" ? CONVERSATION : OTHER_CONVERSATION)
        : h.cp.bindings.bind({ role: Role.PRIMARY_CTO, sessionId: sessions[cto], projectId: PROJECT[cto] });
    if (!bound.allowed) throw new Error(`binding ${cto} failed: ${bound.message}`);
  }
  writeSubscriberConfig(dir, CTOS.map((cto) => ({ keyFile: keys[cto].keyFile, rooms: [ROOM[cto]] })));
  const policy = { allowedActors: [owner.pubkey], secret: SECRET };
  const ingress = await startBuzzMessageIngressListener(h.cp, dir, policy, {
    ceoConversation: new CeoConversationPort(),
    ownerActors: [owner.pubkey],
  });
  const relay = storingRelay();
  const clock = steppedClock();
  const canonical =
    options.canonical === undefined
      ? null
      : { sessions: [{ sessionUuid: CONVERSATION, projectId: PROJECT.repoFactory, buzzActorId: keys.repoFactory.pubkey }] };
  const subscriber = startDaemonBuzzMentionSubscriber(h.cp, dir, policy, ingress, {
    openSocket: relay.factory,
    scheduler: clock.scheduler,
    canonical,
    reportAdmission: () => undefined,
  });
  rejudgeBuzzMentionSubscriberOnBindingSwitch(h.cp, () => subscriber);
  await relay.drain(subscriber);
  return {
    h,
    keys,
    sessions,
    relay,
    clock,
    subscriber,
    canonical,
    sink: captured.sinks.at(-1)!,
    mention: (to: Cto, text: string): BuzzMentionEvent =>
      signedMention({ author: owner.secretKey, addressedTo: keys[to].pubkey, room: ROOM[to], createdAt: secondsOf(h.cp.clock.nowIso()), text }),
    ownerMessagesFor: (to: Cto) =>
      h.cp.db.all(`SELECT message_id FROM outbox WHERE kind = ? AND role_key = ?`, [
        MessageKind.OWNER_MESSAGE,
        roleKeyFor(Role.PRIMARY_CTO, { projectId: PROJECT[to] }),
      ]).length,
    requestsFor: (to: Cto) => relay.requested.filter((request) => request.pubkey === keys[to].pubkey).length,
    inboundRows: (eventId: string) =>
      h.cp.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM inbound_messages WHERE channel = 'buzz' AND nonce = ?`, [
        buzzMessageNonce(eventId),
      ])!.n,
    close: async () => {
      subscriber.close();
      await ingress.close();
      h.cp.close();
    },
  };
};

describe("1080-N1-03: admission requires the session's recorded room", () => {
  it("excludes an identity whose session has no recorded room, and delivers it nothing", async () => {
    const f = await start();
    try {
      f.h.cp.sessions.setBuzzAddress(f.sessions.repoFactory, null);
      f.subscriber.rejudge();
      f.h.clock.advance(1_000);
      f.relay.publish(f.mention("repoFactory", "no recorded room"));
      await f.relay.drain(f.subscriber);
      expect(f.subscriber.admission().identities[1]).toMatchObject({ state: "EXCLUDED", reason: "ROOM_MISSING" });
      expect(f.relay.openFor(f.keys.repoFactory.pubkey)).toHaveLength(0);
      expect(f.ownerMessagesFor("repoFactory")).toBe(0);
      // Its siblings are untouched.
      expect(f.subscriber.admission().admittedIdentities).toBe(2);
    } finally {
      await f.close();
    }
  });
});

describe("1080-N1-04: an exclusion found at delivery suspends the identity", () => {
  it("requests no more of its mail on later ticks, and resumes from the same window once it is admitted again", async () => {
    const f = await start();
    try {
      // A pause with no binding switch: the runtime stops, its assignment stays ACTIVE.
      expect(f.h.cp.sessions.transition(f.sessions.repoFactory, SessionLifecycle.STOPPED, "pause without a switch").allowed).toBe(true);
      f.h.clock.advance(1_000);
      f.relay.publish(f.mention("repoFactory", "paused"));
      await f.relay.drain(f.subscriber);
      expect(f.subscriber.admission().identities[1]).toMatchObject({ state: "EXCLUDED", reason: "NO_LIVE_SESSION" });
      expect(f.relay.openFor(f.keys.repoFactory.pubkey)).toHaveLength(0);
      const requests = f.requestsFor("repoFactory");
      for (let tick = 0; tick < 3; tick += 1) {
        f.clock.fireAll();
        await f.relay.drain(f.subscriber);
      }
      expect(f.requestsFor("repoFactory")).toBe(requests);
      expect(f.ownerMessagesFor("repoFactory")).toBe(0);
    } finally {
      await f.close();
    }
  });

  it("is excluded by a re-judgement when its session stops with no event and no binding switch", async () => {
    const f = await start();
    try {
      expect(f.relay.openFor(f.keys.repoFactory.pubkey)).toHaveLength(1);
      expect(f.h.cp.sessions.transition(f.sessions.repoFactory, SessionLifecycle.STOPPED, "pause without a switch").allowed).toBe(true);
      // What main()'s existing health tick does every thirty seconds.
      f.subscriber.rejudge();
      await f.relay.drain(f.subscriber);
      expect(f.subscriber.admission().identities[1]).toMatchObject({ state: "EXCLUDED", reason: "NO_LIVE_SESSION" });
      expect(f.relay.openFor(f.keys.repoFactory.pubkey)).toHaveLength(0);
      expect(f.subscriber.admission().admittedIdentities).toBe(2);
    } finally {
      await f.close();
    }
  });
});

describe("1080-N1-05: a canonical entry is satisfied only by its own conversation's binding", () => {
  for (const [evidence, admitted] of [["missing", false], ["different", false], ["correct", true]] as const) {
    it(`${admitted ? "admits" : "excludes"} repo-factory bound on ${evidence} canonical evidence, and its siblings keep subscribing`, async () => {
      const f = await start({ canonical: evidence });
      try {
        const judged = buzzMentionSubscriberRegistry(f.h.cp, f.canonical).judgeIdentity!(f.keys.repoFactory.pubkey);
        expect(judged.verdict).toBe(admitted ? "ADMITTED" : "EXCLUDED");
        if (!admitted) expect(judged).toEqual({ verdict: "EXCLUDED", reason: "CANONICAL_TARGET_UNVERIFIED" });
        f.h.clock.advance(1_000);
        for (const cto of CTOS) f.relay.publish(f.mention(cto, `${cto}, status`));
        await f.relay.drain(f.subscriber);
        expect(f.ownerMessagesFor("repoFactory")).toBe(admitted ? 1 : 0);
        expect(f.ownerMessagesFor("logic")).toBe(1);
        expect(f.ownerMessagesFor("commitlore")).toBe(1);
        expect(f.subscriber.admission().continuity).toBe(admitted ? "FULL" : "PARTIAL");
      } finally {
        await f.close();
      }
    });
  }
});

describe("1080-N1-01, the sink half: the daemon's own sink re-reads the binding before the seam writes", () => {
  it("answers RETRY and writes nothing for a delivery judged against a binding that has since moved", async () => {
    const f = await start();
    const roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId: PROJECT.repoFactory });
    try {
      const judged = f.h.cp.bindings.active(roleKey)!;
      f.h.clock.advance(1_000);
      const event = f.mention("repoFactory", "judged before the takeover");
      // The takeover lands between the subscriber's judgement and the sink.
      expect(f.h.cp.sessions.transition(f.sessions.repoFactory, SessionLifecycle.STOPPED, "replaced").reasonCode).toBe(ReasonCode.OK);
      const next = liveSession(f.h, f.keys.repoFactory, ROOM.repoFactory);
      expect(f.h.cp.bindings.switchTo({
        role: Role.PRIMARY_CTO,
        projectId: PROJECT.repoFactory,
        sessionId: next,
        reason: "test takeover",
        conversation: "REPLACED",
      }).allowed).toBe(true);
      const request = {
        roleKey,
        identityPubkey: f.keys.repoFactory.pubkey,
        conversation: ROOM.repoFactory,
        event,
        receipt: null,
        binding: { bindingGeneration: judged.bindingGeneration, sessionId: judged.sessionId },
      };
      const answer = await f.sink.admit(request);
      expect(typeof answer === "string" ? answer : answer.admission).toBe("RETRY");
      expect(f.inboundRows(event.id)).toBe(0);
      expect(f.ownerMessagesFor("repoFactory")).toBe(0);

      // The control: the same event, named against the binding that holds now, is delivered.
      const current = f.h.cp.bindings.active(roleKey)!;
      const delivered = await f.sink.admit({
        ...request,
        binding: { bindingGeneration: current.bindingGeneration, sessionId: current.sessionId },
      });
      expect(typeof delivered === "string" ? delivered : delivered.admission).toBe("DURABLE");
      expect(f.inboundRows(event.id)).toBe(1);
    } finally {
      await f.close();
    }
  });
});
