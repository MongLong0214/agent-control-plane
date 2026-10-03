import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { npubEncode } from "nostr-tools/nip19";
import { finalizeEvent, generateSecretKey, getEventHash, getPublicKey } from "nostr-tools/pure";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import {
  BUZZ_SUBSCRIBER_CONFIG_FILENAME,
  type BuzzMentionEvent,
  type BuzzRelaySocketFactory,
  type BuzzRelaySocketHandlers,
  type BuzzSubscriberScheduler,
} from "../../src/buzz/buzz-mention-subscriber.ts";
import { BuzzBindChallenges } from "../../src/buzz/buzz-bind-challenge.ts";
import { ATTACH_EXIT, runAdoptedCeoAttachRelay } from "../../src/cli/attach-relay.ts";
import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import {
  createDaemonBuzzBindChallenges,
  startAdoptedCeoToolSocket,
  startBuzzMessageIngressListener,
  startDaemonBuzzMentionSubscriber,
} from "../../src/daemon/agentcpd.ts";
import { Role, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { buzzMessageNonce } from "../../src/ingress/buzz-message.ts";
import {
  BuzzActorIngress,
  buzzActorBindingSigningRequest,
  IngressGuard,
  ingressSignature,
} from "../../src/ingress/ingress-guard.ts";
import { CeoConversationPort } from "../../src/mcp/ceo-conversation.ts";
import { HERMES_PROVENANCE_META_KEY } from "../../src/mcp/hermes-provenance.ts";
import { MessageKind } from "../../src/outbox/envelope.ts";
import { adoptedFixture, CEO, DIGEST, GATEWAY, LIVE, type AdoptedCeoFixture } from "../helpers/adopted-ceo.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { registerFixtureProject } from "../helpers/harness.ts";

/**
 * The adopted Hermes CEO binds its Buzz channel identity by proving it holds that identity's key.
 *
 * The CEO asks its admitted tool socket for a challenge (`buzz_actor_bind({actor})`), then posts the
 * challenge token in an ordinary Buzz mention of the CTO signed with its own Nostr key. That event
 * reaches the daemon through the real mention subscriber — `validateEvent`, `verifyEvent`, the `p`
 * and `h` checks, the role check — and the subscriber's sink hands it to the binding rather than to
 * admission. The only stated facts are the process tree above this test process and the Gateway's
 * readback; the events are real nostr-tools events, signed by real keys.
 */

const SECRET = "fixture-buzz-ingress-secret";
const PROJECT_ROOM = "buzz-project-room";
const BIND_REFUSED = "SESSION_BUZZ_ACTOR_BIND_REFUSED";
const TEN_MINUTES_MS = 10 * 60 * 1000;

const OWNER_TURN = {
  [HERMES_PROVENANCE_META_KEY]: {
    session_id: LIVE,
    session_key: "agent:main:telegram:dm:1001",
    platform: "telegram",
    chat_id: "1001",
    cron: false,
    parent_chat_id: null,
    principal: "owner",
    delegation_depth: 0,
    lineage_root_digest: DIGEST,
  },
};

interface Key {
  secret: Uint8Array;
  pubkey: string;
}
const newKey = (): Key => {
  const secret = generateSecretKey();
  return { secret, pubkey: getPublicKey(secret) };
};

interface Wire {
  id?: number;
  result?: { structuredContent?: Record<string, unknown> };
  error?: unknown;
}

const roots: string[] = [];
const fixtures: AdoptedCeoFixture[] = [];
const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  for (const fixture of fixtures.splice(0)) fixture.h.cp.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
afterAll(cleanupTempDirs);

const settles = async (exit: Promise<number>, budgetMs = 10_000): Promise<number | "did-not-settle"> => {
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<"did-not-settle">((resolve) => {
    timer = setTimeout(() => resolve("did-not-settle"), budgetMs);
  });
  try {
    return await Promise.race([exit, guard]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

/** The relay the CEO's Gateway runs, in-process: newline JSON-RPC over its stdio. */
const relay = (toolSocketPath: string) => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let errText = "";
  let pendingText = "";
  let nextId = 1;
  const pending = new Map<number, (message: Wire) => void>();
  stdout.on("data", (chunk: Buffer) => {
    pendingText += chunk.toString("utf8");
    for (;;) {
      const newline = pendingText.indexOf("\n");
      if (newline < 0) break;
      const message = JSON.parse(pendingText.slice(0, newline)) as Wire;
      pendingText = pendingText.slice(newline + 1);
      if (message.id !== undefined) pending.get(message.id)?.(message);
    }
  });
  stderr.on("data", (chunk: Buffer) => {
    errText += chunk.toString("utf8");
  });
  const exit = runAdoptedCeoAttachRelay({ toolSocketPath }, { stdin, stdout, stderr });
  return {
    exit,
    stdin,
    err: () => errText,
    request: (method: string, params: unknown) =>
      new Promise<Wire>((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => reject(new Error(`timeout awaiting ${method}; stderr=${errText}`)), 10_000);
        pending.set(id, (message) => {
          clearTimeout(timer);
          resolve(message);
        });
        stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      }),
    notify: (method: string) => {
      stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
    },
  };
};

const manualRelay = () => {
  const sockets: Array<{ sent: string[]; handlers: BuzzRelaySocketHandlers }> = [];
  const factory: BuzzRelaySocketFactory = (_url, handlers) => {
    const socket = { sent: [] as string[], handlers };
    sockets.push(socket);
    return { send: (raw) => socket.sent.push(raw), close: () => undefined };
  };
  const live = () => {
    const socket = sockets.at(-1);
    if (!socket) throw new Error("the subscriber opened no relay socket");
    return socket;
  };
  return {
    factory,
    live,
    /** NIP-42 on the live socket, then the subscription's id and the filter its `REQ` asked for. */
    authenticateAndSubscribe: async (
      handle: { settled(): Promise<void> },
    ): Promise<{ subId: string; filter: Record<string, unknown> }> => {
      const socket = live();
      socket.handlers.onFrame(JSON.stringify(["AUTH", "relay-challenge"]));
      await handle.settled();
      const auth = JSON.parse(socket.sent.at(-1)!) as [string, { id: string }];
      socket.handlers.onFrame(JSON.stringify(["OK", auth[1].id, true, ""]));
      await handle.settled();
      const req = socket.sent.map((raw) => JSON.parse(raw) as unknown[]).find((sent) => sent[0] === "REQ")!;
      return { subId: req[1] as string, filter: req[2] as Record<string, unknown> };
    },
  };
};

/** A fixed clock, and reconnect timers kept for the test to fire rather than run on their own. */
const scheduler = () => {
  const timers: Array<() => void> = [];
  const value: BuzzSubscriberScheduler = {
    setTimer: (_ms, fire) => timers.push(fire),
    clearTimer: () => undefined,
    nowSeconds: () => 1_900_000_000,
  };
  return { value, timers };
};

/**
 * An adopted CEO (no Buzz channel identity yet — the live state), a project whose PRIMARY_CTO answers
 * on `PROJECT_ROOM` as the subscriber's identity, the adopted CEO tool socket and the mention
 * subscriber sharing one challenge store, as `main` wires them. The relay allowlist holds every key,
 * the stranger's included, so no refusal below is the relay credential's.
 */
const startBindFixture = async (options: { challengeStore?: boolean } = {}) => {
  const fixture = adoptedFixture();
  fixtures.push(fixture);
  const { h } = fixture;
  // The kernel reports this test process as the tool socket's peer; it sits under the Gateway.
  fixture.parents.set(process.pid, GATEWAY);
  const owner = newKey();
  const ceo = newKey();
  const cto = newKey();
  const stranger = newKey();
  /** A second key the relay credential admits, for the relay-signed form to bind first. */
  const otherCeoKey = newKey();

  const { projectId } = await registerFixtureProject(h);
  const ctoRoleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId });
  const ctoSession = h.cp.sessions.create({ provider: "scripted", model: "cto", buzzAddress: PROJECT_ROOM });
  expect(h.cp.sessions.transition(ctoSession.sessionId, SessionLifecycle.READY, "test").allowed).toBe(true);
  expect(h.cp.bindings.bind({ role: Role.PRIMARY_CTO, sessionId: ctoSession.sessionId, projectId }).allowed).toBe(true);
  expect(h.cp.sessions.bindBuzzActor(
    { sessionId: ctoSession.sessionId, sessionSecret: ctoSession.sessionSecret!, buzzActorId: cto.pubkey },
    { isAllowedActor: () => true },
  ).allowed).toBe(true);

  const policy = {
    allowedActors: [owner.pubkey, ceo.pubkey, stranger.pubkey, otherCeoKey.pubkey],
    secret: SECRET,
  };
  const challenges = createDaemonBuzzBindChallenges(h.cp, policy);

  const toolDir = mkdtempSync("/tmp/acpbb-");
  roots.push(toolDir);
  // Wired as `main` wires it: the relay-signed form beside the challenge store, on one guard policy.
  const tools = await startAdoptedCeoToolSocket(h.cp, { lock: { held: () => true } }, toolDir, fixture.admission(), {
    buzzActorIngress: new BuzzActorIngress(new IngressGuard(h.cp.db, h.cp.clock, h.cp.audit, { buzz: policy }), h.cp.sessions),
    buzzBindChallenges: challenges,
  });
  closers.push(() => tools.close());

  const dir = tempDir("acp-buzz-bind-");
  chmodSync(dir, 0o700);
  const keyFile = join(dir, "cto.nostr.key");
  writeFileSync(keyFile, `${Buffer.from(cto.secret).toString("hex")}\n`, { mode: 0o600 });
  chmodSync(keyFile, 0o600);
  writeFileSync(
    join(dir, BUZZ_SUBSCRIBER_CONFIG_FILENAME),
    JSON.stringify({
      relayUrl: "wss://relay.example.invalid/buzz",
      identities: [{ privateKeyFile: keyFile, encoding: "hex", rooms: [PROJECT_ROOM] }],
    }),
  );
  const ingress = await startBuzzMessageIngressListener(h.cp, dir, policy, {
    ceoConversation: new CeoConversationPort(),
    ownerActors: [owner.pubkey],
  });
  closers.push(() => ingress.close());
  const relayOf = manualRelay();
  const clock = scheduler();
  const subscriber = startDaemonBuzzMentionSubscriber(h.cp, dir, policy, ingress, {
    openSocket: relayOf.factory,
    scheduler: clock.value,
    ...(options.challengeStore === false ? {} : { bindChallenges: challenges }),
  });
  closers.push(() => subscriber.close());
  const { subId } = await relayOf.authenticateAndSubscribe(subscriber);

  const nowSeconds = (): number => Math.floor(h.clock.now().getTime() / 1000);
  const ceoSessionId = fixture.gatewaySessionId;

  /** One `buzz_actor_bind` call over a fresh admitted relay connection, as the owner's own turn. */
  const callBind = async (args: Record<string, unknown>, meta: Record<string, unknown> | null = OWNER_TURN) => {
    const r = relay(tools.socketPath);
    const init = await r.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "hermes-gateway", version: "1" },
    });
    expect(init.error).toBeUndefined();
    r.notify("notifications/initialized");
    try {
      return await r.request("tools/call", { name: "buzz_actor_bind", arguments: args, ...(meta ? { _meta: meta } : {}) });
    } finally {
      r.stdin.end();
      await settles(r.exit);
    }
  };

  return {
    fixture,
    h,
    owner,
    ceo,
    cto,
    stranger,
    otherCeoKey,
    ctoRoleKey,
    ceoSessionId,
    tools,
    subscriber,
    nowSeconds,
    callBind,
    /** The challenge token the CEO's tool call is answered with. */
    mint: async (actor: string = ceo.pubkey): Promise<string> => {
      const wire = await callBind({ actor });
      const body = wire.result?.structuredContent;
      if (body?.["ok"] !== true) {
        throw new Error(`buzz_actor_bind minted no challenge: ${JSON.stringify(wire.result ?? wire.error)}`);
      }
      const value = body["value"] as { challenge: string; expiresAt: string };
      expect(value.challenge).toMatch(/^acp-buzz-bind:[0-9a-f]{32}$/);
      expect(Date.parse(value.expiresAt)).toBe(h.clock.now().getTime() + TEN_MINUTES_MS);
      return value.challenge;
    },
    /** A kind-9 mention of the CTO in its project room, signed by `author`. */
    mention: (author: Key, text: string, createdAt = nowSeconds()): BuzzMentionEvent =>
      finalizeEvent(
        { kind: 9, created_at: createdAt, tags: [["p", cto.pubkey], ["h", PROJECT_ROOM]], content: text },
        author.secret,
      ) as BuzzMentionEvent,
    /** One relay frame, through the daemon's own subscriber and sink. */
    relayDelivers: async (event: BuzzMentionEvent): Promise<void> => {
      relayOf.live().handlers.onFrame(JSON.stringify(["EVENT", subId, event]));
      await subscriber.settled();
    },
    /** `sessions.buzz_actor_id` of the CEO runtime, read back from the database. */
    ceoIdentity: () =>
      h.cp.db.get<{ buzz_actor_id: string | null }>(`SELECT buzz_actor_id FROM sessions WHERE session_id = ?`, [
        ceoSessionId,
      ])?.buzz_actor_id ?? null,
    sessionsRows: () => h.cp.db.all(`SELECT * FROM sessions ORDER BY session_id`),
    /** `SESSION_BUZZ_ACTOR_BOUND` rows for the CEO runtime (the CTO's own binding is the fixture's). */
    boundRows: () => h.cp.audit.byKind("SESSION_BUZZ_ACTOR_BOUND").filter((row) => row.sessionId === ceoSessionId).length,
    refusalRows: () =>
      h.cp.audit.byKind(BIND_REFUSED).map((row) => ({
        reasonCode: row.reasonCode,
        sessionId: row.sessionId,
        actor: row.actor,
        cause: row.evidence["cause"],
        nonce: row.evidence["nonce"],
      })),
    inbound: (eventId: string) =>
      h.cp.db.get(`SELECT nonce FROM inbound_messages WHERE channel = 'buzz' AND nonce = ?`, [buzzMessageNonce(eventId)]),
    peerRows: () => h.cp.db.all(`SELECT message_id FROM outbox WHERE kind = ?`, [MessageKind.PEER_MESSAGE]),
    /** Every row a delivered message leaves, for either principal: its ingress row and its outbox row. */
    messageRows: () => ({
      inbound: h.cp.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM inbound_messages`, [])!.n,
      outbox: h.cp.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM outbox`, [])!.n,
    }),
    /**
     * The relay ends the subscription, the reconnect timer fires, and the new connection subscribes
     * again: the filter it asks for is the window the subscriber now trusts.
     */
    reconnect: async (): Promise<Record<string, unknown>> => {
      relayOf.live().handlers.onFrame(JSON.stringify(["CLOSED", subId, "test: subscription ended"]));
      await subscriber.settled();
      const fire = clock.timers.shift();
      if (!fire) throw new Error("the subscriber scheduled no reconnect");
      fire();
      return (await relayOf.authenticateAndSubscribe(subscriber)).filter;
    },
    refusedWith: (reasonCode: string): number => subscriber.counters().rejections[`admission-refused:${reasonCode}`] ?? 0,
  };
};

type BindFixture = Awaited<ReturnType<typeof startBindFixture>>;

/** The CEO answers its challenge and the binding is in the database. */
const bindByChallenge = async (f: BindFixture): Promise<BuzzMentionEvent> => {
  const token = await f.mint();
  const proof = f.mention(f.ceo, `CTO, 채널 신원 바인딩: ${token}`);
  await f.relayDelivers(proof);
  expect(f.ceoIdentity()).toBe(f.ceo.pubkey);
  return proof;
};

describe("the adopted CEO binds its Buzz channel identity with an event its own key signed", () => {
  it("binds the key that signed the challenge token, and the binding event is delivered to no one", async () => {
    const f = await startBindFixture();
    expect(f.ceoIdentity()).toBeNull();
    // The npub form names the same x-only key.
    const token = await f.mint(npubEncode(f.ceo.pubkey));
    expect(f.ceoIdentity()).toBeNull();
    expect(f.boundRows()).toBe(0);

    const proof = f.mention(f.ceo, `CTO, 채널 신원 바인딩: ${token}`);
    await f.relayDelivers(proof);

    // Read back from the row the peer rule reads.
    expect(f.ceoIdentity()).toBe(f.ceo.pubkey);
    expect(f.boundRows()).toBe(1);
    expect(f.h.cp.audit.byKind("SESSION_BUZZ_ACTOR_BOUND").at(-1)).toMatchObject({
      sessionId: f.ceoSessionId,
      actor: `buzz:${f.ceo.pubkey}`,
    });
    expect(f.refusalRows()).toEqual([]);
    // Not a message: no ingress row, no peer message for the CTO.
    expect(f.inbound(proof.id)).toBeUndefined();
    expect(f.peerRows()).toEqual([]);
    expect(f.subscriber.counters().framesHandled).toBeGreaterThan(0);
  });

  it("refuses the token posted under another key, without spending the CEO's challenge", async () => {
    const f = await startBindFixture();
    const token = await f.mint();
    const sessions = f.sessionsRows();

    const wrongCaller = f.mention(f.stranger, `나도 바인딩: ${token}`);
    await f.relayDelivers(wrongCaller);
    expect(f.refusedWith(ReasonCode.SESSION_BUZZ_ACTOR_NOT_AUTHENTICATED)).toBe(1);
    expect(f.ceoIdentity()).toBeNull();
    expect(f.sessionsRows()).toEqual(sessions);
    expect(f.boundRows()).toBe(0);
    expect(f.inbound(wrongCaller.id)).toBeUndefined();
    expect(f.refusalRows()).toEqual([{
      reasonCode: ReasonCode.SESSION_BUZZ_ACTOR_NOT_AUTHENTICATED,
      sessionId: f.ceoSessionId,
      actor: `buzz:${f.stranger.pubkey}`,
      cause: "actor-mismatch",
      nonce: buzzMessageNonce(wrongCaller.id),
    }]);
    // Repeated, it is refused again and recorded no further.
    await f.relayDelivers(f.mention(f.stranger, `다시: ${token}`, f.nowSeconds() + 1));
    expect(f.refusedWith(ReasonCode.SESSION_BUZZ_ACTOR_NOT_AUTHENTICATED)).toBe(2);
    expect(f.refusalRows()).toHaveLength(1);
    expect(f.ceoIdentity()).toBeNull();

    // The challenge is still the CEO's to answer.
    await f.relayDelivers(f.mention(f.ceo, `바인딩: ${token}`));
    expect(f.ceoIdentity()).toBe(f.ceo.pubkey);
  });

  it("refuses the same binding event replayed, with no second write", async () => {
    const f = await startBindFixture();
    const proof = await bindByChallenge(f);
    const sessions = f.sessionsRows();
    expect(f.boundRows()).toBe(1);

    await f.relayDelivers(proof);
    await f.relayDelivers(proof);
    expect(f.sessionsRows()).toEqual(sessions);
    expect(f.boundRows()).toBe(1);
    expect(f.subscriber.counters().rejections["admission-already-durable"]).toBe(2);
    expect(f.refusalRows()).toEqual([{
      reasonCode: ReasonCode.INGRESS_REPLAY_IGNORED,
      sessionId: f.ceoSessionId,
      actor: `buzz:${f.ceo.pubkey}`,
      cause: "event-replayed",
      nonce: buzzMessageNonce(proof.id),
    }]);
    expect(f.inbound(proof.id)).toBeUndefined();
    expect(f.peerRows()).toEqual([]);
  });

  it("refuses a second event that reuses a nonce the binding already consumed", async () => {
    const f = await startBindFixture();
    const proof = await bindByChallenge(f);
    const token = /acp-buzz-bind:[0-9a-f]{32}/.exec(proof.content)![0];
    const sessions = f.sessionsRows();

    const reuse = f.mention(f.ceo, `한 번 더: ${token}`, f.nowSeconds() + 1);
    await f.relayDelivers(reuse);
    expect(f.refusedWith(ReasonCode.SESSION_BUZZ_ACTOR_NOT_AUTHENTICATED)).toBe(1);
    expect(f.sessionsRows()).toEqual(sessions);
    expect(f.boundRows()).toBe(1);
    expect(f.refusalRows()).toEqual([expect.objectContaining({ cause: "challenge-consumed" })]);
    // Not delivered as a peer message either, although the CEO's identity is now bound.
    expect(f.inbound(reuse.id)).toBeUndefined();
    expect(f.peerRows()).toEqual([]);
  });

  it("refuses an answer that arrives after the challenge expired", async () => {
    const f = await startBindFixture();
    const token = await f.mint();
    // Signed while the challenge was open, delivered after it closed.
    const late = f.mention(f.ceo, `늦은 바인딩: ${token}`, f.nowSeconds() + 1);
    f.h.clock.advance(TEN_MINUTES_MS + 1_000);
    await f.relayDelivers(late);
    expect(f.refusedWith(ReasonCode.SESSION_BUZZ_ACTOR_NOT_AUTHENTICATED)).toBe(1);
    expect(f.ceoIdentity()).toBeNull();
    expect(f.boundRows()).toBe(0);
    expect(f.refusalRows()).toEqual([expect.objectContaining({ cause: "challenge-expired" })]);

    // A fresh challenge, answered in time, binds: the refusal above was the expiry.
    await bindByChallenge(f);
  });

  it("refuses an answer signed before the challenge was minted, beyond the clock-skew allowance", async () => {
    const f = await startBindFixture();
    const token = await f.mint();
    const early = f.mention(f.ceo, `미리 서명됨: ${token}`, f.nowSeconds() - 61);
    await f.relayDelivers(early);
    expect(f.refusedWith(ReasonCode.SESSION_BUZZ_ACTOR_NOT_AUTHENTICATED)).toBe(1);
    expect(f.ceoIdentity()).toBeNull();
    expect(f.boundRows()).toBe(0);
    expect(f.refusalRows()).toEqual([expect.objectContaining({ cause: "signed-outside-challenge" })]);

    // Not spent: inside the allowance, the same challenge binds.
    await f.relayDelivers(f.mention(f.ceo, `바인딩: ${token}`, f.nowSeconds() - 60));
    expect(f.ceoIdentity()).toBe(f.ceo.pubkey);
  });

  it("refuses an answer after the CEO binding's generation changed since the challenge was minted", async () => {
    const f = await startBindFixture();
    const token = await f.mint();
    const generation = f.h.cp.bindings.active(CEO)!.bindingGeneration;
    expect(f.h.cp.bindings.revoke(CEO, "test re-adoption").allowed).toBe(true);
    const rebound = f.h.cp.bindings.bind({ role: Role.CEO, sessionId: f.ceoSessionId });
    expect(rebound.allowed).toBe(true);
    expect(f.h.cp.bindings.active(CEO)).toMatchObject({ sessionId: f.ceoSessionId, bindingGeneration: generation + 1 });
    const sessions = f.sessionsRows();

    await f.relayDelivers(f.mention(f.ceo, `바인딩: ${token}`));
    expect(f.refusedWith(ReasonCode.BINDING_GENERATION_STALE)).toBe(1);
    expect(f.ceoIdentity()).toBeNull();
    expect(f.sessionsRows()).toEqual(sessions);
    expect(f.boundRows()).toBe(0);
    expect(f.refusalRows()).toEqual([expect.objectContaining({
      reasonCode: ReasonCode.BINDING_GENERATION_STALE,
      cause: "ceo-binding-moved",
    })]);
  });

  it("drops a forged signature at verifyEvent, before the binding is reached", async () => {
    const f = await startBindFixture();
    const token = await f.mint();
    // The stranger signs the token and relabels the event as the CEO's: the id is recomputed for
    // the CEO's pubkey, so the structure is valid and only the signature is not the CEO's.
    const signed = f.mention(f.stranger, `바인딩: ${token}`);
    const relabeled = { ...signed, tags: signed.tags.map((tag) => [...tag]), pubkey: f.ceo.pubkey };
    const forged: BuzzMentionEvent = { ...relabeled, id: getEventHash(relabeled) };

    await f.relayDelivers(forged);
    expect(f.subscriber.counters().rejections["event-signature-invalid"]).toBe(1);
    expect(f.ceoIdentity()).toBeNull();
    expect(f.boundRows()).toBe(0);
    // The binding never saw it: nothing refused there, nothing recorded.
    expect(f.refusalRows()).toEqual([]);

    // The genuine answer to the same challenge still binds.
    await f.relayDelivers(f.mention(f.ceo, `바인딩: ${token}`));
    expect(f.ceoIdentity()).toBe(f.ceo.pubkey);
  });

  it("lets the CEO's next mention past the peer rule's identity check once its key is bound", async () => {
    const f = await startBindFixture();
    // The live failure: a CEO mention while the runtime carries no identity.
    const before = f.mention(f.ceo, "CTO, 이 작업을 맡아 주세요");
    await f.relayDelivers(before);
    expect(f.refusedWith(ReasonCode.INGRESS_ACTOR_NOT_ALLOWLISTED)).toBe(1);
    expect(f.inbound(before.id)).toBeUndefined();

    await bindByChallenge(f);
    const after = f.mention(f.ceo, "CTO, 이제 이 작업을 맡아 주세요", f.nowSeconds() + 1);
    await f.relayDelivers(after);
    expect(f.refusedWith(ReasonCode.INGRESS_ACTOR_NOT_ALLOWLISTED)).toBe(1);
    expect(f.inbound(after.id)).toBeDefined();
    expect(f.peerRows()).toHaveLength(1);
  });

  it("refuses, at the one writer, a possession proof the challenge store did not mint", async () => {
    const f = await startBindFixture();
    const admitted = await f.fixture.admit();
    if (!admitted.allowed) throw new Error(JSON.stringify(admitted));
    const sessions = f.sessionsRows();
    // A real lineage admission and an allowlisted key, in the possession proof's shape: built here,
    // not by the code that verified a signed answer, so it proves nothing.
    const forged = { runtime: admitted.value.runtime, buzzActorId: f.ceo.pubkey };
    const refused = f.h.cp.sessions.bindBuzzActor({ possession: forged }, { isAllowedActor: () => true });
    expect(refused).toMatchObject({ allowed: false, reasonCode: ReasonCode.CONFLICT });
    expect(f.sessionsRows()).toEqual(sessions);
    expect(f.boundRows()).toBe(0);

    // The proof the store mints for a signed answer is accepted by the same writer.
    await bindByChallenge(f);
  });

  it("mints a challenge only for the admitted CEO connection's own owner turn", async () => {
    const f = await startBindFixture();
    const before = f.h.cp.db.all(`SELECT * FROM sessions ORDER BY session_id`);

    // A peer outside the Gateway's ancestry never reaches a tool: the handshake is refused.
    f.fixture.parents.set(process.pid, 1);
    const stranger = relay(f.tools.socketPath);
    stranger.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
    const exited = await settles(stranger.exit);
    if (exited === "did-not-settle") stranger.stdin.end();
    expect(exited).toBe(ATTACH_EXIT.HANDSHAKE_REFUSED);

    // The admitted connection, on a turn that is not the owner's own, is refused by provenance.
    f.fixture.parents.set(process.pid, GATEWAY);
    const unowned = await f.callBind({ actor: f.ceo.pubkey }, null);
    expect(unowned.result?.structuredContent).toMatchObject({ ok: false, reasonCode: ReasonCode.MCP_TOOL_PROVENANCE_REFUSED });

    // The owner's own turn on the admitted connection gets one; minting writes nothing.
    expect(await f.mint()).toMatch(/^acp-buzz-bind:/);
    expect(f.h.cp.db.all(`SELECT * FROM sessions ORDER BY session_id`)).toEqual(before);
    expect(f.ceoIdentity()).toBeNull();
  });
});

/** The relay-signed form, through the adopted CEO tool socket: binds `actor` with no challenge. */
const bindByRelayEnvelope = async (f: BindFixture, actor: string, nonce: string): Promise<void> => {
  const wire = await f.callBind({
    actor,
    nonce,
    signature: ingressSignature(SECRET, buzzActorBindingSigningRequest({ actor, sessionId: f.ceoSessionId, nonce })),
  });
  expect(wire.result?.structuredContent).toMatchObject({ ok: true, value: { buzzActorId: actor } });
};

/**
 * Content carrying the binding marker in a shape that is not exactly one well-formed token. The last
 * three are the spellings the marker match folds: case, separators and a zero-width character.
 */
const MALFORMED_SHAPES: ReadonlyArray<readonly [string, (token: string) => string]> = [
  ["the same token twice", (token) => `${token} ${token}`],
  ["a valid token beside a malformed prefix", (token) => `${token} 그리고 acp-buzz-bind:not-a-nonce`],
  ["a malformed prefix only", () => "acp-buzz-bind:not-a-nonce"],
  ["an upper-case token", (token) => token.toUpperCase()],
  ["a token whose prefix is spaced", (token) => token.replace("acp-buzz-bind:", "acp buzz bind : ")],
  ["a token whose prefix hides a zero-width space", (token) => token.replace("buzz", "bu​zz")],
];

describe("ACP1055: a binding-shaped message is never delivered, and a refused binding is never durable", () => {
  for (const [shape, contentOf] of MALFORMED_SHAPES) {
    it(`ACP1055-01: delivers ${shape} to neither the owner's path nor the peer's`, async () => {
      const f = await startBindFixture();
      // The CEO's key bound, so a CEO mention without a binding marker is a peer message.
      await bindByChallenge(f);
      const token = await f.mint();
      const before = f.messageRows();
      const signedAt = f.nowSeconds();
      for (const author of [f.owner, f.ceo]) {
        const event = f.mention(author, `CTO, ${contentOf(token)}`, signedAt + 1);
        await f.relayDelivers(event);
        expect(f.inbound(event.id)).toBeUndefined();
      }
      expect(f.messageRows()).toEqual(before);
      expect(f.refusedWith(ReasonCode.INVALID_ARGUMENT)).toBe(2);
      expect(f.ceoIdentity()).toBe(f.ceo.pubkey);

      // Control: the same two principals' messages without the marker are each delivered.
      for (const author of [f.owner, f.ceo]) {
        const plain = f.mention(author, "CTO, 표식 없는 메시지", signedAt + 2);
        await f.relayDelivers(plain);
        expect(f.inbound(plain.id)).toBeDefined();
      }
      expect(f.messageRows().inbound).toBe(before.inbound + 2);
    });
  }

  it("ACP1055-01: delivers no token-carrying message from either principal when no challenge store is wired", async () => {
    const f = await startBindFixture({ challengeStore: false });
    await bindByRelayEnvelope(f, f.ceo.pubkey, "acp1055-no-store");
    const before = f.messageRows();
    for (const author of [f.owner, f.ceo]) {
      const event = f.mention(author, `CTO, acp-buzz-bind:${"0".repeat(32)}`);
      await f.relayDelivers(event);
      expect(f.inbound(event.id)).toBeUndefined();
    }
    expect(f.messageRows()).toEqual(before);
    expect(f.refusedWith(ReasonCode.INVALID_ARGUMENT)).toBe(2);

    const plain = f.mention(f.ceo, "CTO, 표식 없는 지시", f.nowSeconds() + 1);
    await f.relayDelivers(plain);
    expect(f.inbound(plain.id)).toBeDefined();
  });

  it("ACP1055-02: answers a refused binding's replay with the refusal again, so a reconnect asks for the same window", async () => {
    const f = await startBindFixture();
    // A minute past the CTO's binding, so the older owner message below is still signed after it:
    // one signed before the binding is refused (BUZZ_MENTION_PRECEDES_BINDING), and this row is
    // about the window, not about that floor.
    f.h.clock.advance(60_000);
    // A challenge for the CEO's key, then a different key bound through the relay-signed form.
    const token = await f.mint();
    await bindByRelayEnvelope(f, f.otherCeoKey.pubkey, "acp1055-other-key");
    const answer = f.mention(f.ceo, `바인딩: ${token}`);
    await f.relayDelivers(answer);
    expect(f.refusedWith(ReasonCode.SESSION_BUZZ_ACTOR_IMMUTABLE)).toBe(1);
    const sessions = f.sessionsRows();

    await f.relayDelivers(answer);
    expect(f.refusedWith(ReasonCode.SESSION_BUZZ_ACTOR_IMMUTABLE)).toBe(2);
    expect(f.subscriber.counters().rejections["admission-already-durable"]).toBeUndefined();
    expect(f.sessionsRows()).toEqual(sessions);
    expect(f.ceoIdentity()).toBe(f.otherCeoKey.pubkey);

    // An owner message older than the binding event that the relay has not delivered yet. The
    // window the new connection asks for must still reach back to it.
    const older = f.mention(f.owner, "CTO, 아직 전달되지 않은 이전 메시지", answer.created_at - 30);
    const filter = await f.reconnect();
    expect(filter["since"]).toBeUndefined();
    await f.relayDelivers(older);
    expect(f.inbound(older.id)).toBeDefined();
  });

  it("ACP1055-02: answers the replay of a binding whose write threw as not bound, and never binds it twice", async () => {
    const f = await startBindFixture();
    const admitted = await f.fixture.admit();
    if (!admitted.allowed) throw new Error(JSON.stringify(admitted));
    const runtime = admitted.value.runtime;
    const generation = f.h.cp.bindings.active(CEO)!.bindingGeneration;
    let writes = 0;
    const store = new BuzzBindChallenges({
      nowMs: () => f.h.clock.now().getTime(),
      currentCeo: () => ({
        sessionId: runtime.sessionId,
        sessionIncarnation: runtime.sessionIncarnation,
        bindingGeneration: generation,
        live: true,
      }),
      bindable: () => allow(ReasonCode.OK, undefined),
      bind: () => {
        writes += 1;
        throw new Error("the writer failed mid-write");
      },
      recordRefusal: () => undefined,
    });
    const minted = store.mint(runtime, f.ceo.pubkey);
    if (!minted.allowed) throw new Error(JSON.stringify(minted));
    const answer = f.mention(f.ceo, `바인딩: ${minted.value.challenge}`);

    expect(() => store.settle(answer)).toThrow("the writer failed mid-write");
    expect(store.settle(answer)).toMatchObject({ allowed: false, reasonCode: ReasonCode.CONFLICT });
    expect(writes).toBe(1);
  });
});
