import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { afterAll, describe, expect, it } from "vitest";

import {
  BUZZ_MENTION_ADDRESSED_TO,
  BUZZ_SUBSCRIBER_CONFIG_FILENAME,
  type BuzzMentionEvent,
  type BuzzRelaySocketFactory,
  type BuzzRelaySocketHandlers,
  type BuzzSubscriberScheduler,
} from "../../src/buzz/buzz-mention-subscriber.ts";
import { OWNER_REPLY_OUTBOX_CHANNEL } from "../../src/conversation/owner-reply-outbox.ts";
import { deny } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import {
  buzzMentionInputFor,
  buzzMentionSubscriberRegistry,
  ownerMessageLedger,
  startBuzzMessageIngressListener,
  startDaemonBuzzMentionSubscriber,
} from "../../src/daemon/agentcpd.ts";
import { Role, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import {
  buzzMessageNonce,
  buzzMessageSigningRequest,
  deliverBuzzMessage,
  type BuzzMessageIngressInput,
} from "../../src/ingress/buzz-message.ts";
import { ingressSignature } from "../../src/ingress/ingress-guard.ts";
import { CeoConversationPort } from "../../src/mcp/ceo-conversation.ts";
import type { RoleConversationPort } from "../../src/mcp/role-conversation.ts";
import { MessageKind } from "../../src/outbox/envelope.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { makeHarness, registerFixtureProject } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * #1038 — the CEO instructs the CTO through ACP, as a `peer` and never as the owner.
 *
 * Every refusal row below asserts **zero writes**: `total_changes()` on the control plane's own
 * connection does not move. A row count over a few tables would miss an audit row or a journal
 * row, and an audit row is exactly what a refusal placed after the ingress guard would leave.
 *
 * Every refusal row also carries its own control — the same fixture's valid peer event admitted —
 * because on the base every non-owner mention is refused with zero writes, and a refusal row with
 * no control would pass there for a reason that has nothing to do with the condition it names.
 */

const SECRET = "buzz-peer-ingress-test-secret";
const PROJECT_ROOM = "buzz-project-room";
const OTHER_PROJECT_ROOM = "buzz-other-project-room";
const anyBuzzActorIsAuthenticated = { isAllowedActor: () => true };

interface Key {
  secret: Uint8Array;
  pubkey: string;
}
const newKey = (): Key => {
  const secret = generateSecretKey();
  return { secret, pubkey: getPublicKey(secret) };
};

type Harness = ReturnType<typeof makeHarness>;

const readySession = (
  harness: Harness,
  model: string,
  buzzAddress: string | null,
): { sessionId: string; sessionSecret: string; incarnation: string } => {
  const session = harness.cp.sessions.create({ provider: "scripted", model, buzzAddress });
  expect(
    harness.cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "test").reasonCode,
  ).toBe(ReasonCode.OK);
  return {
    sessionId: session.sessionId,
    sessionSecret: session.sessionSecret!,
    incarnation: harness.cp.sessions.require(session.sessionId).incarnation,
  };
};

/** The production writer of `sessions.buzz_actor_id`, never a raw UPDATE. */
const bindChannelIdentity = (
  harness: Harness,
  session: { sessionId: string; sessionSecret: string },
  pubkey: string,
): void => {
  const bound = harness.cp.sessions.bindBuzzActor(
    { sessionId: session.sessionId, sessionSecret: session.sessionSecret, buzzActorId: pubkey },
    anyBuzzActorIsAuthenticated,
  );
  if (!bound.allowed) throw new Error(`buzz channel identity binding failed: ${bound.message}`);
};

const bindCeoSession = (
  harness: Harness,
  session: { sessionId: string },
): number => {
  const bound = harness.cp.bindings.bind({
    roleKey: roleKeyFor(Role.CEO),
    role: Role.CEO,
    sessionId: session.sessionId,
  });
  if (!bound.allowed) throw new Error(`CEO binding failed: ${bound.message}`);
  return bound.value.bindingGeneration;
};

interface ManualRelaySocket {
  sent: string[];
  closed: boolean;
  handlers: BuzzRelaySocketHandlers;
}

const manualRelay = () => {
  const sockets: ManualRelaySocket[] = [];
  const factory: BuzzRelaySocketFactory = (_url, handlers) => {
    const socket: ManualRelaySocket = { sent: [], closed: false, handlers };
    sockets.push(socket);
    return {
      send: (raw) => socket.sent.push(raw),
      close: () => {
        socket.closed = true;
      },
    };
  };
  const live = (): ManualRelaySocket => {
    const socket = sockets.at(-1);
    if (!socket) throw new Error("the subscriber opened no relay socket");
    return socket;
  };
  const framesOf = (socket: ManualRelaySocket): unknown[][] =>
    socket.sent.map((raw) => JSON.parse(raw) as unknown[]);
  return {
    factory,
    live,
    authenticateAndSubscribe: async (handle: { settled(): Promise<void> }): Promise<string> => {
      const socket = live();
      socket.handlers.onFrame(JSON.stringify(["AUTH", "relay-challenge"]));
      await handle.settled();
      const auth = framesOf(socket).at(-1) as [string, { id: string }];
      socket.handlers.onFrame(JSON.stringify(["OK", auth[1].id, true, ""]));
      await handle.settled();
      const req = framesOf(socket).find((sent) => sent[0] === "REQ") as [string, string, unknown];
      return req[1];
    },
  };
};

const scheduler = (): BuzzSubscriberScheduler => ({
  setTimer: () => 0,
  clearTimer: () => undefined,
  nowSeconds: () => 1_900_000_000,
});

/**
 * One deployment: an owner, a project whose PRIMARY_CTO answers on `PROJECT_ROOM`, and a CEO
 * binding whose runtime does — or, for the NULL row, does not yet — carry a Buzz channel identity.
 *
 * The relay allowlist holds every key in the fixture, the stranger's included, as production's
 * does (`ACP_BUZZ_ALLOWED_ACTORS` lists every ACTIVE Buzz channel identity). So a refusal here is
 * never the relay credential's; it is the peer rule's.
 */
const startPeerFixture = async (
  options: {
    ceoChannelIdentity?: "bound" | "null";
    /** Milliseconds past the whole second at which the CEO binding is created (#1044 boundary). */
    ceoBoundAtMs?: number;
    /**
     * Holds every wake until it settles, so the subscriber's admission of one frame is still
     * awaiting while the next frame arrives — the real queue, not a simulated one (#1044).
     */
    wakeGate?: Promise<void>;
  } = {},
) => {
  const owner = newKey();
  const ceo = newKey();
  // The key a rotation onto a fresh identity binds; on the relay allowlist from the start, as every
  // ACTIVE Buzz channel identity is in production.
  const ceoNext = newKey();
  const cto = newKey();
  const stranger = newKey();
  const harness = makeHarness({ ownerIdentities: [{ channel: "buzz", actor: owner.pubkey }] });
  const { projectId } = await registerFixtureProject(harness);
  const ctoRoleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId });

  const ctoSession = readySession(harness, "cto", PROJECT_ROOM);
  const ctoBound = harness.cp.bindings.bind({
    role: Role.PRIMARY_CTO,
    sessionId: ctoSession.sessionId,
    projectId,
  });
  if (!ctoBound.allowed) throw new Error(`CTO binding failed: ${ctoBound.message}`);
  bindChannelIdentity(harness, ctoSession, cto.pubkey);

  const ceoSession = readySession(harness, "ceo", null);
  harness.clock.advance(options.ceoBoundAtMs ?? 0);
  const ceoGeneration = bindCeoSession(harness, ceoSession);
  if ((options.ceoChannelIdentity ?? "bound") === "bound") {
    bindChannelIdentity(harness, ceoSession, ceo.pubkey);
  }

  const dir = tempDir("acp-buzz-peer-");
  chmodSync(dir, 0o700);
  const keyFile = join(dir, "cto.nostr.key");
  writeFileSync(keyFile, `${Buffer.from(cto.secret).toString("hex")}\n`, { mode: 0o600 });
  chmodSync(keyFile, 0o600);
  writeFileSync(
    join(dir, BUZZ_SUBSCRIBER_CONFIG_FILENAME),
    JSON.stringify({
      relayUrl: "wss://relay.example.invalid/buzz",
      identities: [
        { privateKeyFile: keyFile, encoding: "hex", rooms: [PROJECT_ROOM, OTHER_PROJECT_ROOM] },
      ],
    }),
  );
  const policy = {
    allowedActors: [owner.pubkey, ceo.pubkey, ceoNext.pubkey, stranger.pubkey],
    secret: SECRET,
  };
  const wakeGate = options.wakeGate;
  const ingress = await startBuzzMessageIngressListener(harness.cp, dir, policy, {
    ceoConversation: new CeoConversationPort(),
    ownerActors: [owner.pubkey],
    ...(wakeGate
      ? {
          roleConversation: {
            wake: async (roleKey: string) => {
              await wakeGate;
              return deny(ReasonCode.ROLE_PEER_ABSENT, "no peer in this fixture", { roleKey });
            },
          } as unknown as RoleConversationPort,
        }
      : {}),
  });
  const relay = manualRelay();
  const subscriber = startDaemonBuzzMentionSubscriber(harness.cp, dir, policy, ingress, {
    openSocket: relay.factory,
    scheduler: scheduler(),
  });
  const subId = await relay.authenticateAndSubscribe(subscriber);

  const nowSeconds = (): number => Math.floor(harness.clock.now().getTime() / 1000);
  const mention = (
    author: Key,
    options: { createdAt?: number; room?: string; p?: readonly string[]; text?: string } = {},
  ): BuzzMentionEvent =>
    finalizeEvent(
      {
        kind: 9,
        created_at: options.createdAt ?? nowSeconds(),
        tags: [...(options.p ?? [cto.pubkey]).map((p) => ["p", p]), ["h", options.room ?? PROJECT_ROOM]],
        content: options.text ?? "CTO, 이 작업을 맡아 주세요",
      },
      author.secret,
    ) as BuzzMentionEvent;

  return {
    harness,
    owner,
    ceo,
    ceoNext,
    cto,
    stranger,
    projectId,
    ctoRoleKey,
    ctoSession,
    ceoSession,
    ceoGeneration,
    ingress,
    subscriber,
    nowSeconds,
    mention,
    /** One relay frame, through the daemon's own subscriber and sink. */
    relayDelivers: async (event: BuzzMentionEvent): Promise<void> => {
      relay.live().handlers.onFrame(JSON.stringify(["EVENT", subId, event]));
      await subscriber.settled();
    },
    /** One relay frame, handed to the subscriber's queue and not waited for. */
    relayPushes: (event: BuzzMentionEvent): void => {
      relay.live().handlers.onFrame(JSON.stringify(["EVENT", subId, event]));
    },
    /** The receipt the daemon's registry would give a frame arriving now. */
    receiptNow: () => buzzMentionSubscriberRegistry(harness.cp).peerReceiptFor!(ctoRoleKey),
    /** The sink's envelope for `event`, carrying the receipt a frame arriving now would carry. */
    inputFor: (event: BuzzMentionEvent, room = PROJECT_ROOM) =>
      buzzMentionInputFor(ingress.seam.ingress, SECRET, {
        roleKey: ctoRoleKey,
        identityPubkey: cto.pubkey,
        conversation: room,
        event,
        receipt: buzzMentionSubscriberRegistry(harness.cp).peerReceiptFor!(ctoRoleKey),
      }),
    /** Rows changed on the control plane's connection since it opened. */
    writes: (): number =>
      harness.cp.db.get<{ n: number }>(`SELECT total_changes() AS n`, [])!.n,
    peerRows: () =>
      harness.cp.db.all<{
        message_id: string;
        status: string;
        role_key: string;
        binding_generation: number;
        target_session_id: string;
      }>(
        `SELECT message_id, status, role_key, binding_generation, target_session_id
           FROM outbox WHERE kind = ? ORDER BY created_at, rowid`,
        [MessageKind.PEER_MESSAGE],
      ),
    ownerRows: () =>
      harness.cp.db.all<{ message_id: string; status: string }>(
        `SELECT message_id, status FROM outbox WHERE kind = 'OWNER_MESSAGE' ORDER BY created_at, rowid`,
        [],
      ),
    admitted: (eventId: string) =>
      harness.cp.db.get<{ actor: string; payload_json: string; turn_claim_json: string | null }>(
        `SELECT actor, payload_json, turn_claim_json FROM inbound_messages
          WHERE channel = 'buzz' AND nonce = ?`,
        [buzzMessageNonce(eventId)],
      ),
    refusedWith: (reasonCode: string): number =>
      subscriber.counters().rejections[`admission-refused:${reasonCode}`] ?? 0,
    holder: () => ({
      roleKey: ctoRoleKey,
      bindingGeneration: harness.cp.bindings.active(ctoRoleKey)!.bindingGeneration,
      targetSessionId: ctoSession.sessionId,
      sessionIncarnation: ctoSession.incarnation,
    }),
    close: async () => {
      subscriber.close();
      await ingress.close();
    },
  };
};

type PeerFixture = Awaited<ReturnType<typeof startPeerFixture>>;

/**
 * Rotates the CEO binding to a new runtime: revoke, retire the old runtime, bind the next
 * generation. `sameKey` reuses the old runtime's Buzz channel identity on the new one — the
 * pubkey-reuse case the generation proof exists for.
 */
const rotateCeo = (
  fixture: PeerFixture,
  options: { sameKey: boolean; advanceMs?: number },
): { generation: number; key: Key } => {
  const { harness } = fixture;
  expect(harness.cp.bindings.revoke(roleKeyFor(Role.CEO), "test rotation").reasonCode).toBe(
    ReasonCode.OK,
  );
  expect(
    harness.cp.sessions.transition(fixture.ceoSession.sessionId, SessionLifecycle.STOPPED, "rotated")
      .reasonCode,
  ).toBe(ReasonCode.OK);
  harness.clock.advance(options.advanceMs ?? 60_000);
  const next = readySession(harness, "ceo-next", null);
  const generation = bindCeoSession(harness, next);
  const key = options.sameKey ? fixture.ceo : fixture.ceoNext;
  bindChannelIdentity(harness, next, key.pubkey);
  return { generation, key };
};

/**
 * Replaces the CTO's runtime: a takeover (`REPLACED`, a new generation) or a surviving move
 * (`SURVIVED`, the same generation). The new runtime answers on the same project channel and, when
 * `takeIdentity` is set, takes over the CTO's channel identity once the old runtime has stopped, so
 * the subscriber still holds the role.
 */
const replaceCto = (
  fixture: PeerFixture,
  options: { conversation: "REPLACED" | "SURVIVED"; takeIdentity?: boolean },
): { sessionId: string; sessionSecret: string; incarnation: string } => {
  const { harness } = fixture;
  const next = readySession(harness, "cto-next", PROJECT_ROOM);
  const switched = harness.cp.bindings.switchTo({
    role: Role.PRIMARY_CTO,
    projectId: fixture.projectId,
    sessionId: next.sessionId,
    reason: "test runtime replacement",
    conversation: options.conversation,
  });
  if (!switched.allowed) throw new Error(`CTO switch failed: ${switched.message}`);
  if (options.takeIdentity) {
    expect(
      harness.cp.sessions.transition(fixture.ctoSession.sessionId, SessionLifecycle.STOPPED, "replaced")
        .reasonCode,
    ).toBe(ReasonCode.OK);
    bindChannelIdentity(harness, next, fixture.cto.pubkey);
  }
  return next;
};

/**
 * Moves the CEO's conversation onto another runtime within its generation (`SURVIVED`): the
 * binding generation stays, the live runtime changes. No clock advance.
 */
const moveCeoRuntime = (fixture: PeerFixture, buzzAddress: string | null = null) => {
  const { harness } = fixture;
  const before = harness.cp.bindings.active(roleKeyFor(Role.CEO))!.bindingGeneration;
  const next = readySession(harness, "ceo-moved", buzzAddress);
  const moved = harness.cp.bindings.switchTo({
    roleKey: roleKeyFor(Role.CEO),
    role: Role.CEO,
    sessionId: next.sessionId,
    reason: "test runtime move",
    conversation: "SURVIVED",
  });
  if (!moved.allowed) throw new Error(`CEO runtime move failed: ${moved.message}`);
  expect(moved.value.bindingGeneration).toBe(before);
  expect(moved.value.sessionId).toBe(next.sessionId);
  return next;
};

/** Until `predicate` holds, yielding to the event loop between looks. */
const until = async (predicate: () => boolean, what: string): Promise<void> => {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolveTick) => setImmediate(resolveTick));
  }
  throw new Error(`timed out waiting for ${what}`);
};

/** A seam-level envelope signed the way the relay-facing socket signs one. */
const signedEnvelope = (
  input: Omit<BuzzMessageIngressInput, "signature">,
): BuzzMessageIngressInput => ({
  ...input,
  signature: ingressSignature(SECRET, buzzMessageSigningRequest(input)),
});

describe("#1038 a bound CEO's Buzz mention is a peer turn for the bound PRIMARY_CTO", () => {
  it("admits the current CEO's mention as one peer message bound to its generation and the receiving CTO session", async () => {
    const fixture = await startPeerFixture();
    try {
      const event = fixture.mention(fixture.ceo, { text: "CTO, 이 PR 을 검토해 주세요" });
      await fixture.relayDelivers(event);

      // One inbound row, authored by the CEO's channel identity — not an owner's.
      const row = fixture.admitted(event.id);
      expect(row?.actor).toBe(fixture.ceo.pubkey);
      // The admitted payload is the generation proof: the CEO generation and the receiving CTO
      // session are inside what the ingress digest and the outbox pointer bind.
      const payload = JSON.parse(row!.payload_json) as Record<string, unknown>;
      expect(payload["peer"]).toEqual({
        ceoBindingGeneration: fixture.ceoGeneration,
        ceoSessionId: fixture.ceoSession.sessionId,
        ctoRoleKey: fixture.ctoRoleKey,
        ctoBindingGeneration: fixture.holder().bindingGeneration,
        ctoSessionId: fixture.ctoSession.sessionId,
      });
      expect(payload["createdAt"]).toBe(event.created_at);

      // One peer message for exactly the bound CTO, and no owner message at all.
      const peers = fixture.peerRows();
      expect(peers).toHaveLength(1);
      expect(peers[0]).toMatchObject({
        status: "PENDING",
        role_key: fixture.ctoRoleKey,
        binding_generation: fixture.holder().bindingGeneration,
        target_session_id: fixture.ctoSession.sessionId,
      });
      expect(fixture.ownerRows()).toEqual([]);
      expect(fixture.subscriber.counters().admitted).toBe(1);
    } finally {
      await fixture.close();
    }
  });

  it("refuses every CEO mention with zero writes while the CEO runtime carries no Buzz channel identity", async () => {
    // The live state on 2026-10-02: the adopted CEO runtime's `buzz_actor_id` is NULL, because the
    // adoption discarded the session secret `bindActor` needs. Nothing may stand in for it.
    const fixture = await startPeerFixture({ ceoChannelIdentity: "null" });
    try {
      const event = fixture.mention(fixture.ceo);
      const before = fixture.writes();
      await fixture.relayDelivers(event);
      expect(fixture.writes()).toBe(before);
      expect(fixture.admitted(event.id)).toBeUndefined();
      expect(fixture.peerRows()).toEqual([]);
      expect(fixture.refusedWith(ReasonCode.INGRESS_ACTOR_NOT_ALLOWLISTED)).toBe(1);

      // Control: once the identity is bound (by the production writer, in a fixture), the same
      // key's next mention is admitted — so the refusal above was the NULL, not a blanket refusal.
      bindChannelIdentity(fixture.harness, fixture.ceoSession, fixture.ceo.pubkey);
      const after = fixture.mention(fixture.ceo, { text: "이제 바인딩됨" });
      await fixture.relayDelivers(after);
      expect(fixture.peerRows()).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });

  it("refuses a stale generation's channel identity with zero writes after the CEO rotates", async () => {
    const fixture = await startPeerFixture();
    try {
      const rotated = rotateCeo(fixture, { sameKey: false });
      // Signed now, by the key the previous generation held. Its signature verifies; it is simply
      // not the current CEO binding's identity any more.
      const stale = fixture.mention(fixture.ceo, { text: "이전 세대" });
      const before = fixture.writes();
      await fixture.relayDelivers(stale);
      expect(fixture.writes()).toBe(before);
      expect(fixture.admitted(stale.id)).toBeUndefined();
      expect(fixture.refusedWith(ReasonCode.INGRESS_ACTOR_NOT_ALLOWLISTED)).toBe(1);

      const current = fixture.mention(rotated.key, { text: "현재 세대" });
      await fixture.relayDelivers(current);
      expect(fixture.peerRows()).toHaveLength(1);
      expect(
        (JSON.parse(fixture.admitted(current.id)!.payload_json) as { peer: { ceoBindingGeneration: number } })
          .peer.ceoBindingGeneration,
      ).toBe(rotated.generation);
    } finally {
      await fixture.close();
    }
  });

  it("refuses an old-generation event after a same-key rotation, whether it carries its own receipt or is rebuilt with a fresh one", async () => {
    const fixture = await startPeerFixture();
    try {
      // The review's reproduction (#1044 ACP-1044-01): signed under generation 1 and dated 60 s
      // ahead, so the event's own time falls inside generation 2's window ...
      const event = fixture.mention(fixture.ceo, {
        createdAt: fixture.nowSeconds() + 60,
        text: "대기열에 있던 지시",
      });
      const queued = fixture.inputFor(event);
      expect((queued.peer as { ceoBindingGeneration: number }).ceoBindingGeneration).toBe(
        fixture.ceoGeneration,
      );

      // ... the CEO rotates 30 s later onto a runtime that reuses the same key ...
      rotateCeo(fixture, { sameKey: true, advanceMs: 30_000 });

      // ... and neither its own envelope nor one rebuilt now is admitted. The rebuilt one is the
      // defect the review measured: it used to be stamped with generation 2 and delivered.
      const before = fixture.writes();
      for (const presented of [queued, fixture.inputFor(event)]) {
        const refused = await deliverBuzzMessage(
          fixture.ingress.seam.ingress,
          fixture.ingress.seam.port,
          presented,
        );
        expect(refused).toMatchObject({ allowed: false, reasonCode: ReasonCode.BUZZ_PEER_ORIGIN_AMBIGUOUS });
      }
      expect(fixture.writes()).toBe(before);
      expect(fixture.admitted(event.id)).toBeUndefined();
    } finally {
      await fixture.close();
    }
  });

  it("refuses every event signed with a reused key after a same-key rotation, and admits one from a fresh key", async () => {
    const fixture = await startPeerFixture();
    try {
      // Signed during generation 1, by the key generation 2 will reuse.
      const old = fixture.mention(fixture.ceo, { text: "1세대에서 서명됨" });
      rotateCeo(fixture, { sameKey: true });

      // The relay redelivers it after the rotation, and the same key signs a new one. Nothing in
      // either event can say which generation signed it, so both are refused.
      const fresh = fixture.mention(fixture.ceo, { text: "2세대에서 서명됨" });
      const before = fixture.writes();
      await fixture.relayDelivers(old);
      await fixture.relayDelivers(fresh);
      expect(fixture.writes()).toBe(before);
      expect(fixture.admitted(old.id)).toBeUndefined();
      expect(fixture.admitted(fresh.id)).toBeUndefined();
      expect(fixture.refusedWith(ReasonCode.BUZZ_PEER_ORIGIN_AMBIGUOUS)).toBe(2);

      // Control: a rotation onto a fresh key is the current CEO.
      const rotated = rotateCeo(fixture, { sameKey: false });
      await fixture.relayDelivers(fixture.mention(rotated.key, { text: "새 키" }));
      expect(fixture.peerRows()).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });

  it("refuses the CEO's events when its runtime is bound again in a new CEO generation", async () => {
    const fixture = await startPeerFixture();
    try {
      const { harness } = fixture;
      // The same runtime, and so the same key, serves generation 1 and then generation 2. An event
      // it signed during generation 1 and one it signs now look the same.
      expect(harness.cp.bindings.revoke(roleKeyFor(Role.CEO), "test re-bind").reasonCode).toBe(ReasonCode.OK);
      harness.clock.advance(60_000);
      const generation = bindCeoSession(harness, fixture.ceoSession);
      expect(generation).toBe(fixture.ceoGeneration + 1);

      const before = fixture.writes();
      await fixture.relayDelivers(fixture.mention(fixture.ceo, { text: "같은 런타임, 새 세대" }));
      expect(fixture.writes()).toBe(before);
      expect(fixture.refusedWith(ReasonCode.BUZZ_PEER_ORIGIN_AMBIGUOUS)).toBe(1);
    } finally {
      await fixture.close();
    }
  });

  it("refuses an earlier generation's event when its runtime is bound again at the very instant it was moved there", async () => {
    // Generation 1 starts on a runtime with no Buzz channel identity.
    const fixture = await startPeerFixture({ ceoChannelIdentity: "null" });
    try {
      const { harness } = fixture;
      const startedAt = harness.clock.nowIso();
      // Generation 1 is moved onto runtime B, which carries the CEO's key, and B signs an event.
      const b = moveCeoRuntime(fixture);
      bindChannelIdentity(harness, b, fixture.ceo.pubkey);
      const event = fixture.mention(fixture.ceo, { text: "1세대, 런타임 B 에서 서명" });

      // Generation 2 is bound to B with the clock where it was: the move and the new binding share
      // one timestamp, so no ordering of times can say B served generation 1. The record can.
      expect(harness.cp.bindings.revoke(roleKeyFor(Role.CEO), "test re-bind").reasonCode).toBe(ReasonCode.OK);
      expect(bindCeoSession(harness, b)).toBe(fixture.ceoGeneration + 1);
      expect(harness.clock.nowIso()).toBe(startedAt);

      const before = fixture.writes();
      expect(
        await deliverBuzzMessage(fixture.ingress.seam.ingress, fixture.ingress.seam.port, fixture.inputFor(event)),
      ).toMatchObject({ allowed: false, reasonCode: ReasonCode.BUZZ_PEER_ORIGIN_AMBIGUOUS });
      await fixture.relayDelivers(event);
      expect(fixture.writes()).toBe(before);
      expect(fixture.admitted(event.id)).toBeUndefined();
      expect(fixture.refusedWith(ReasonCode.BUZZ_PEER_ORIGIN_AMBIGUOUS)).toBe(1);
    } finally {
      await fixture.close();
    }
  });

  it("admits a first-ever key on a runtime that served an earlier generation with no identity, and refuses it once a later generation reuses it", async () => {
    // Generation 1 on runtime R with no Buzz channel identity at all.
    const fixture = await startPeerFixture({ ceoChannelIdentity: "null" });
    try {
      const { harness } = fixture;
      // R is bound again as generation 2, and only then takes its first identity: no earlier
      // generation ever carried this key, so R's own history does not make it ambiguous.
      expect(harness.cp.bindings.revoke(roleKeyFor(Role.CEO), "test re-bind").reasonCode).toBe(ReasonCode.OK);
      expect(bindCeoSession(harness, fixture.ceoSession)).toBe(fixture.ceoGeneration + 1);
      bindChannelIdentity(harness, fixture.ceoSession, fixture.ceo.pubkey);
      const first = fixture.mention(fixture.ceo, { text: "처음 쓰는 키" });
      await fixture.relayDelivers(first);
      expect(fixture.admitted(first.id)).toBeDefined();
      expect(fixture.peerRows()).toHaveLength(1);

      // Generation 3 on the same runtime: the key generation 2 used is now a reused key.
      expect(harness.cp.bindings.revoke(roleKeyFor(Role.CEO), "test re-bind").reasonCode).toBe(ReasonCode.OK);
      expect(bindCeoSession(harness, fixture.ceoSession)).toBe(fixture.ceoGeneration + 2);
      const later = fixture.mention(fixture.ceo, { text: "재사용된 키" });
      const before = fixture.writes();
      await fixture.relayDelivers(later);
      expect(fixture.writes()).toBe(before);
      expect(fixture.admitted(later.id)).toBeUndefined();
      expect(fixture.refusedWith(ReasonCode.BUZZ_PEER_ORIGIN_AMBIGUOUS)).toBe(1);
    } finally {
      await fixture.close();
    }
  });

  it("admits a fresh key that a new runtime took before it was bound as the CEO", async () => {
    const fixture = await startPeerFixture();
    try {
      const { harness } = fixture;
      // The new runtime takes its own, never-used key while generation 1 still runs elsewhere, and is
      // bound as generation 2 only afterwards. No earlier generation ran on it, so the key is its own.
      const next = readySession(harness, "ceo-next", null);
      bindChannelIdentity(harness, next, fixture.ceoNext.pubkey);
      expect(harness.cp.bindings.revoke(roleKeyFor(Role.CEO), "test rotation").reasonCode).toBe(ReasonCode.OK);
      harness.clock.advance(60_000);
      expect(bindCeoSession(harness, next)).toBe(fixture.ceoGeneration + 1);

      const event = fixture.mention(fixture.ceoNext, { text: "미리 받은 새 키" });
      await fixture.relayDelivers(event);
      expect(fixture.admitted(event.id)).toBeDefined();
      expect(fixture.peerRows()).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });

  it("refuses a frame that waited in the subscriber's queue across a same-key CEO rotation, with zero writes", async () => {
    let releaseWake!: () => void;
    const fixture = await startPeerFixture({
      wakeGate: new Promise<void>((resolveGate) => {
        releaseWake = resolveGate;
      }),
    });
    try {
      // An owner's message is admitted and its wake is held, so the subscriber's queue is busy.
      const first = fixture.mention(fixture.owner, { text: "먼저 온 주인의 메시지" });
      fixture.relayPushes(first);
      await until(() => fixture.admitted(first.id) !== undefined, "the first frame's admission");

      // The CEO's event arrives behind it, under generation 1, dated ahead ...
      const queued = fixture.mention(fixture.ceo, { createdAt: fixture.nowSeconds() + 60 });
      fixture.relayPushes(queued);
      // ... the CEO rotates onto the same key while it waits ...
      rotateCeo(fixture, { sameKey: true, advanceMs: 30_000 });
      const before = fixture.writes();
      // ... and only then does it reach the sink.
      releaseWake();
      await fixture.subscriber.settled();

      expect(fixture.writes()).toBe(before);
      expect(fixture.admitted(queued.id)).toBeUndefined();
      expect(fixture.peerRows()).toEqual([]);
      expect(fixture.refusedWith(ReasonCode.BUZZ_PEER_ORIGIN_AMBIGUOUS)).toBe(1);
    } finally {
      releaseWake();
      await fixture.close();
    }
  });

  it("refuses a frame that waited in the subscriber's queue while the CTO was taken over, with zero writes", async () => {
    let releaseWake!: () => void;
    const fixture = await startPeerFixture({
      wakeGate: new Promise<void>((resolveGate) => {
        releaseWake = resolveGate;
      }),
    });
    try {
      const first = fixture.mention(fixture.owner, { text: "먼저 온 주인의 메시지" });
      fixture.relayPushes(first);
      await until(() => fixture.admitted(first.id) !== undefined, "the first frame's admission");

      // The CEO's event arrives for CTO session 1 ...
      const queued = fixture.mention(fixture.ceo, { text: "세션 1 에게 보낸 지시" });
      fixture.relayPushes(queued);
      // ... a new runtime takes the CTO role over, with the CTO's channel identity, so the
      // subscriber still speaks for the role when the frame reaches the front ...
      const next = replaceCto(fixture, { conversation: "REPLACED", takeIdentity: true });
      const before = fixture.writes();
      releaseWake();
      await fixture.subscriber.settled();

      // ... and the event is refused, because it arrived for a CTO session that is not the one
      // processing it. Rebuilding its proof at processing time would have admitted it for `next`.
      expect(fixture.writes()).toBe(before);
      expect(fixture.admitted(queued.id)).toBeUndefined();
      expect(fixture.refusedWith(ReasonCode.BUZZ_PEER_GENERATION_STALE)).toBe(1);

      // Control: the CEO's next event, arriving after the takeover, is admitted for `next`.
      await fixture.relayDelivers(fixture.mention(fixture.ceo, { text: "세션 2 에게 보낸 지시" }));
      const peers = fixture.peerRows();
      expect(peers).toHaveLength(1);
      expect(peers[0]!.target_session_id).toBe(next.sessionId);
    } finally {
      releaseWake();
      await fixture.close();
    }
  });

  it("refuses an exclusive key's event dated before its generation began, and admits one signed in the second it began", async () => {
    // The binding starts at .500 of a second; `created_at` has no fraction.
    const fixture = await startPeerFixture({ ceoBoundAtMs: 500 });
    try {
      const startSecond = fixture.nowSeconds();
      const early = fixture.mention(fixture.ceo, { createdAt: startSecond - 1, text: "세대 이전" });
      const before = fixture.writes();
      await fixture.relayDelivers(early);
      expect(fixture.writes()).toBe(before);
      expect(fixture.refusedWith(ReasonCode.BUZZ_PEER_EVENT_OUTSIDE_GENERATION)).toBe(1);

      const atStart = fixture.mention(fixture.ceo, { createdAt: startSecond, text: "시작한 그 초" });
      await fixture.relayDelivers(atStart);
      expect(fixture.admitted(atStart.id)).toBeDefined();
      expect(fixture.peerRows()).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });

  it("refuses a CEO envelope that does not address exactly the bound PRIMARY_CTO, with zero writes", async () => {
    const fixture = await startPeerFixture();
    try {
      const { ingress } = fixture;
      const event = fixture.mention(fixture.ceo, { text: "대상이 틀린 지시" });
      const valid = fixture.inputFor(event);
      const before = fixture.writes();
      for (const mention of [
        // The CEO's own channel identity: a session holding the CEO role, not the CTO.
        fixture.ceo.pubkey,
        // A channel identity no live session carries.
        fixture.stranger.pubkey,
      ]) {
        const wrong = signedEnvelope({ ...valid, mention });
        const refused = await deliverBuzzMessage(ingress.seam.ingress, ingress.seam.port, wrong);
        expect(refused, String(mention)).toMatchObject({
          allowed: false,
          reasonCode: ReasonCode.BUZZ_PEER_TARGET_NOT_BOUND_CTO,
        });
      }
      expect(fixture.writes()).toBe(before);
      // Not even the unbound-mention journal row the owner path writes after admission.
      expect(fixture.harness.cp.audit.all().filter((row) => row.reasonCode === ReasonCode.MENTION_TARGET_UNBOUND)).toEqual([]);

      const admitted = await deliverBuzzMessage(ingress.seam.ingress, ingress.seam.port, valid);
      expect(admitted.allowed).toBe(true);
      expect(fixture.peerRows()).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });

  it("refuses a CEO event carrying more than one `p` tag with zero writes", async () => {
    const fixture = await startPeerFixture();
    try {
      const before = fixture.writes();
      // At the relay: two recipients, and the degenerate duplicate of this identity.
      const two = fixture.mention(fixture.ceo, { p: [fixture.cto.pubkey, fixture.stranger.pubkey] });
      const duplicate = fixture.mention(fixture.ceo, { p: [fixture.cto.pubkey, fixture.cto.pubkey] });
      await fixture.relayDelivers(two);
      await fixture.relayDelivers(duplicate);
      expect(fixture.subscriber.counters().rejections["event-not-addressed"]).toBe(2);

      // At the seam: a `p` tag that is a list rather than one identity.
      const event = fixture.mention(fixture.ceo, { text: "목록" });
      const valid = fixture.inputFor(event);
      const listed = signedEnvelope({ ...valid, mention: [fixture.cto.pubkey, fixture.stranger.pubkey] });
      const refused = await deliverBuzzMessage(
        fixture.ingress.seam.ingress,
        fixture.ingress.seam.port,
        listed,
      );
      expect(refused).toMatchObject({ allowed: false, reasonCode: ReasonCode.BUZZ_PEER_TARGET_NOT_BOUND_CTO });
      expect(fixture.writes()).toBe(before);

      await fixture.relayDelivers(fixture.mention(fixture.ceo, { text: "하나의 수신자" }));
      expect(fixture.peerRows()).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });

  it("refuses every way the CEO's identity could pass as the owner, with zero writes", async () => {
    const fixture = await startPeerFixture();
    try {
      const { ingress } = fixture;
      const event = fixture.mention(fixture.ceo, { text: "주인처럼 말하기" });
      const valid = fixture.inputFor(event);
      const before = fixture.writes();

      // 1. The owner's own route: a conversation turn with the CEO, which only an owner may open.
      const toCeoRoom = signedEnvelope({ ...valid, addressedTo: "CEO", mention: null });
      expect(
        await deliverBuzzMessage(ingress.seam.ingress, ingress.seam.port, toCeoRoom),
      ).toMatchObject({ allowed: false, reasonCode: ReasonCode.BUZZ_PEER_TARGET_NOT_BOUND_CTO });

      // 2. An owner-shaped envelope: the CEO's identity with no generation proof at all. It is not
      //    read as the owner's for lacking one; it is refused for lacking one.
      const { peer: _proof, ...ownerShaped } = valid;
      expect(
        await deliverBuzzMessage(ingress.seam.ingress, ingress.seam.port, signedEnvelope(ownerShaped)),
      ).toMatchObject({ allowed: false, reasonCode: ReasonCode.BUZZ_PEER_GENERATION_STALE });

      // 3. Someone else presenting the CEO's (public, non-secret) generation proof as their own.
      const borrowed = signedEnvelope({ ...valid, actor: fixture.stranger.pubkey });
      expect(
        await deliverBuzzMessage(ingress.seam.ingress, ingress.seam.port, borrowed),
      ).toMatchObject({ allowed: false, reasonCode: ReasonCode.INGRESS_ACTOR_NOT_ALLOWLISTED });

      expect(fixture.writes()).toBe(before);
      expect(fixture.ownerRows()).toEqual([]);
      // The CEO was never made an owner to get here.
      expect(fixture.harness.cp.ownerAuthority.isAllowedActor("buzz", fixture.ceo.pubkey)).toBe(false);

      const admitted = await deliverBuzzMessage(ingress.seam.ingress, ingress.seam.port, valid);
      expect(admitted.allowed).toBe(true);
      expect(fixture.peerRows()).toHaveLength(1);
      expect(fixture.ownerRows()).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  it("refuses a CEO mention on another project's channel with zero writes, and names the reason in health", async () => {
    const fixture = await startPeerFixture();
    try {
      const elsewhere = fixture.mention(fixture.ceo, { room: OTHER_PROJECT_ROOM, text: "다른 방" });
      const before = fixture.writes();
      await fixture.relayDelivers(elsewhere);
      expect(fixture.writes()).toBe(before);
      expect(fixture.admitted(elsewhere.id)).toBeUndefined();
      // Refused by the subscriber before the seam: the event's room is not the room the CTO's
      // session answers in. The seam's own channel rule (BUZZ_PEER_CHANNEL_MISMATCH) stays behind it.
      expect(fixture.subscriber.counters().rejections["event-room-not-bound"]).toBe(1);
      expect(fixture.refusedWith(ReasonCode.BUZZ_PEER_CHANNEL_MISMATCH)).toBe(0);
      // The bare bucket is what health used to say; the reason code is now part of the key.
      expect(fixture.subscriber.counters().rejections["admission-refused"]).toBeUndefined();

      await fixture.relayDelivers(fixture.mention(fixture.ceo, { text: "같은 프로젝트 방" }));
      expect(fixture.peerRows()).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });

  it("lets the CTO act on a peer turn while giving it no owner gate, no approval and no owner-reply discharge", async () => {
    const fixture = await startPeerFixture();
    try {
      const { harness } = fixture;
      const peerEvent = fixture.mention(fixture.ceo, { text: "CTO, 테스트를 돌려 주세요" });
      await fixture.relayDelivers(peerEvent);
      const ownerEvent = fixture.mention(fixture.owner, { text: "주인의 질문" });
      await fixture.relayDelivers(ownerEvent);
      expect(fixture.peerRows()).toHaveLength(1);
      expect(fixture.ownerRows()).toHaveLength(1);

      // The CTO takes the CEO's instruction with its tools as usual, and is told who sent it.
      const ledger = ownerMessageLedger(harness.cp);
      const first = ledger.claim(fixture.holder());
      expect(first.reasonCode).toBe(ReasonCode.UNTRUSTED_CONTENT_IS_DATA);
      const peerHandover = first.allowed ? first.value.claimed : null;
      expect(peerHandover).toMatchObject({ text: "CTO, 테스트를 돌려 주세요", principal: "peer" });

      // No owner gate and no approval: the peer's admitted row cannot back an owner receipt.
      const receipt = {
        channel: "buzz",
        actor: fixture.ceo.pubkey,
        inboundNonce: buzzMessageNonce(peerEvent.id),
        runId: null,
        candidateSnapshotDigest: null,
        operation: "PROJECT_SUSPEND",
        parameterDigest: "parameters",
        idempotencyKey: "peer-approval-attempt",
        approved: true,
      };
      expect(harness.cp.ownerAuthority.assertApproval(receipt).reasonCode).toBe(
        ReasonCode.INGRESS_ACTOR_NOT_ALLOWLISTED,
      );
      expect(harness.cp.ownerAuthority.consumeApproval(receipt, null).allowed).toBe(false);
      expect(harness.cp.ownerAuthority.isAllowedActor("buzz", fixture.owner.pubkey)).toBe(true);

      // Completing the peer turn settles the peer's own claim as no-reply, and nothing of the
      // owner's: the owner's message stays queued, its claim stays open, and no owner reply is owed
      // or discharged on the strength of a peer's turn.
      const completed = ledger.complete(peerHandover!.messageId, fixture.holder());
      expect(completed.reasonCode).toBe(ReasonCode.OK);
      const peerClaim = JSON.parse(fixture.admitted(peerEvent.id)!.turn_claim_json!) as Record<string, unknown>;
      expect(peerClaim["noReplyAt"]).toEqual(expect.any(String));
      expect(peerClaim["repliedAt"]).toBeUndefined();
      const ownerClaim = JSON.parse(fixture.admitted(ownerEvent.id)!.turn_claim_json!) as Record<string, unknown>;
      expect(ownerClaim["repliedAt"]).toBeUndefined();
      expect(ownerClaim["noReplyAt"]).toBeUndefined();
      expect(ownerClaim["settledAt"]).toBeUndefined();
      expect(fixture.ownerRows().map((row) => row.status)).toEqual(["PENDING"]);
      expect(
        harness.cp.db.all(`SELECT nonce FROM inbound_messages WHERE channel = ?`, [OWNER_REPLY_OUTBOX_CHANNEL]),
      ).toEqual([]);

      // The owner's message is still the owner's when the CTO reaches it.
      const second = ledger.claim(fixture.holder());
      expect(second.allowed && second.value.claimed).toMatchObject({ text: "주인의 질문", principal: "owner" });
    } finally {
      await fixture.close();
    }
  });
});

describe("#1044 a queued peer message keeps its identity fence until it is handed over", () => {
  const claimOf = (
    value: unknown,
  ): { claimed: { text: string; principal: string; messageId: string } | null; withheld: { messageId: string }[] } =>
    value as never;

  it("withholds a queued peer message from its CTO after the CEO rotates, writing nothing, and lets the holder reject it", async () => {
    const fixture = await startPeerFixture();
    try {
      const { harness } = fixture;
      const peerEvent = fixture.mention(fixture.ceo, { text: "1세대 CEO 의 지시" });
      await fixture.relayDelivers(peerEvent);
      const [peerRow] = fixture.peerRows();
      expect(peerRow?.status).toBe("PENDING");

      // Admitted under CEO generation 1; the hand-over is asked for under generation 2.
      rotateCeo(fixture, { sameKey: false });
      const ledger = ownerMessageLedger(harness.cp);
      const before = fixture.writes();
      const refused = ledger.claim(fixture.holder());
      expect(refused.allowed).toBe(true);
      const handover = claimOf(refused.allowed ? refused.value : null);
      expect(handover.claimed).toBeNull();
      expect(handover.withheld.map((row) => row.messageId)).toEqual([peerRow!.message_id]);
      expect(fixture.writes()).toBe(before);
      expect(fixture.peerRows()[0]!.status).toBe("PENDING");

      // It does not stop the queue: the owner's message behind it is handed over.
      await fixture.relayDelivers(fixture.mention(fixture.owner, { text: "뒤에 온 주인의 메시지" }));
      const next = ledger.claim(fixture.holder());
      expect(claimOf(next.allowed ? next.value : null).claimed).toMatchObject({
        text: "뒤에 온 주인의 메시지",
        principal: "owner",
      });

      // The holder retires it by id; that is the one write that does, and it settles its turn.
      expect(ledger.reject(peerRow!.message_id, fixture.holder()).reasonCode).toBe(ReasonCode.OK);
      expect(fixture.peerRows()[0]!.status).toBe("REJECTED");
      const claim = JSON.parse(fixture.admitted(peerEvent.id)!.turn_claim_json!) as Record<string, unknown>;
      expect(claim["noReplyAt"]).toEqual(expect.any(String));
    } finally {
      await fixture.close();
    }
  });

  it("withholds a queued peer message after the CEO's runtime moves within its generation, writing nothing", async () => {
    const fixture = await startPeerFixture();
    try {
      const { harness } = fixture;
      await fixture.relayDelivers(fixture.mention(fixture.ceo, { text: "떠난 런타임의 지시" }));
      const [peerRow] = fixture.peerRows();

      // The generation is unchanged; the runtime that signed is gone, and the one now serving the
      // CEO carries no Buzz channel identity at all.
      moveCeoRuntime(fixture);
      const before = fixture.writes();
      const taken = ownerMessageLedger(harness.cp).claim(fixture.holder());
      expect(claimOf(taken.allowed ? taken.value : null)).toMatchObject({
        claimed: null,
        withheld: [{ messageId: peerRow!.message_id }],
      });
      expect(fixture.writes()).toBe(before);
      expect(fixture.peerRows()[0]!.status).toBe("PENDING");
    } finally {
      await fixture.close();
    }
  });

  it("withholds a queued peer message once the CEO's runtime no longer speaks as the identity that signed it, writing nothing", async () => {
    const fixture = await startPeerFixture();
    try {
      const { harness } = fixture;
      await fixture.relayDelivers(fixture.mention(fixture.ceo, { text: "멈춘 런타임의 지시" }));
      const [peerRow] = fixture.peerRows();

      // Same generation and the same runtime on the binding, but that runtime has stopped, so it no
      // longer speaks as any Buzz channel identity.
      expect(
        harness.cp.sessions.transition(fixture.ceoSession.sessionId, SessionLifecycle.STOPPED, "gone")
          .reasonCode,
      ).toBe(ReasonCode.OK);
      expect(harness.cp.bindings.active(roleKeyFor(Role.CEO))?.sessionId).toBe(fixture.ceoSession.sessionId);
      const before = fixture.writes();
      const taken = ownerMessageLedger(harness.cp).claim(fixture.holder());
      expect(claimOf(taken.allowed ? taken.value : null)).toMatchObject({
        claimed: null,
        withheld: [{ messageId: peerRow!.message_id }],
      });
      expect(fixture.writes()).toBe(before);
    } finally {
      await fixture.close();
    }
  });

  it.each([
    ["no channel at all", null],
    ["another project's room", OTHER_PROJECT_ROOM],
  ])("withholds a queued peer message once the receiving CTO's channel is %s, writing nothing", async (_what, channel) => {
    const fixture = await startPeerFixture();
    try {
      const { harness } = fixture;
      await fixture.relayDelivers(fixture.mention(fixture.ceo, { text: "원래 방에서 받은 지시" }));
      const [peerRow] = fixture.peerRows();

      // The CTO the event was admitted for is still the holder, but it no longer answers on the room
      // the event arrived on. A fresh event there would be refused as a channel mismatch.
      harness.cp.sessions.setBuzzAddress(fixture.ctoSession.sessionId, channel);
      const before = fixture.writes();
      const taken = ownerMessageLedger(harness.cp).claim(fixture.holder());
      expect(claimOf(taken.allowed ? taken.value : null)).toMatchObject({
        claimed: null,
        withheld: [{ messageId: peerRow!.message_id }],
      });
      expect(fixture.writes()).toBe(before);
      expect(fixture.peerRows()[0]!.status).toBe("PENDING");

      // Control: back on its room, the same CTO is handed the message.
      harness.cp.sessions.setBuzzAddress(fixture.ctoSession.sessionId, PROJECT_ROOM);
      const handed = ownerMessageLedger(harness.cp).claim(fixture.holder());
      expect(claimOf(handed.allowed ? handed.value : null).claimed).toMatchObject({
        text: "원래 방에서 받은 지시",
        principal: "peer",
      });
    } finally {
      await fixture.close();
    }
  });

  it("hands over a readable message ahead of a queued row whose stored payload is not readable", async () => {
    const fixture = await startPeerFixture();
    try {
      const { harness } = fixture;
      await fixture.relayDelivers(fixture.mention(fixture.owner, { text: "읽을 수 있는 메시지" }));
      await fixture.relayDelivers(fixture.mention(fixture.owner, { text: "망가질 메시지" }));
      const [, broken] = fixture.ownerRows();
      // A raw writer is inside this repository's threat model, and nothing protects this column.
      harness.cp.db.run(`UPDATE outbox SET payload_json = '{' WHERE message_id = ?`, [broken!.message_id]);

      const taken = ownerMessageLedger(harness.cp).claim(fixture.holder());
      const handover = claimOf(taken.allowed ? taken.value : null);
      expect(handover.claimed).toMatchObject({ text: "읽을 수 있는 메시지", principal: "owner" });
      expect(handover.withheld.map((row) => row.messageId)).toEqual([broken!.message_id]);
    } finally {
      await fixture.close();
    }
  });

  it("still reports an unresolved hand-over when a later queued row's stored payload is not readable", async () => {
    const fixture = await startPeerFixture();
    try {
      const { harness } = fixture;
      await fixture.relayDelivers(fixture.mention(fixture.owner, { text: "건네진 메시지" }));
      await fixture.relayDelivers(fixture.mention(fixture.owner, { text: "망가질 메시지" }));
      const [first, broken] = fixture.ownerRows();
      const ledger = ownerMessageLedger(harness.cp);
      expect(claimOf((ledger.claim(fixture.holder()) as { value: unknown }).value).claimed).toMatchObject({
        messageId: first!.message_id,
      });
      harness.cp.db.run(`UPDATE outbox SET payload_json = '{' WHERE message_id = ?`, [broken!.message_id]);

      const blocked = ledger.claim(fixture.holder());
      expect(blocked.allowed).toBe(true);
      expect(blocked.allowed ? blocked.value : null).toMatchObject({
        claimed: null,
        unresolved: [{ messageId: first!.message_id }],
        withheld: [{ messageId: broken!.message_id }],
      });
    } finally {
      await fixture.close();
    }
  });

  it("rejects a queued peer message on a CTO takeover instead of retargeting it to the successor", async () => {
    const fixture = await startPeerFixture();
    try {
      const { harness } = fixture;
      const peerEvent = fixture.mention(fixture.ceo, { text: "세션 1 에게 보낸 지시" });
      await fixture.relayDelivers(peerEvent);
      await fixture.relayDelivers(fixture.mention(fixture.owner, { text: "주인의 메시지" }));

      const next = replaceCto(fixture, { conversation: "REPLACED" });

      // The peer message is closed, with its turn, rather than handed to a session its proof does
      // not name ...
      expect(fixture.peerRows().map((row) => row.status)).toEqual(["REJECTED"]);
      const claim = JSON.parse(fixture.admitted(peerEvent.id)!.turn_claim_json!) as Record<string, unknown>;
      expect(claim["noReplyAt"]).toEqual(expect.any(String));

      // ... while the owner's message follows the role once, together with the mention's identity:
      // a successor that does not carry the channel identity the mention named is withheld it
      // (1080-N5), and takes it once the identity is its own.
      const successor = {
        roleKey: fixture.ctoRoleKey,
        bindingGeneration: harness.cp.bindings.active(fixture.ctoRoleKey)!.bindingGeneration,
        targetSessionId: next.sessionId,
        sessionIncarnation: next.incarnation,
      };
      const ledger = ownerMessageLedger(harness.cp);
      const withheld = ledger.claim(successor);
      expect(withheld.allowed && withheld.value.claimed).toBe(null);
      expect(withheld.allowed && withheld.value.mentionWithheld?.map((row) => row.reason)).toEqual(["MENTION_NOT_ELIGIBLE"]);
      expect(harness.cp.sessions.transition(fixture.ctoSession.sessionId, SessionLifecycle.STOPPED, "replaced").reasonCode).toBe(ReasonCode.OK);
      bindChannelIdentity(harness, next, fixture.cto.pubkey);
      const taken = ledger.claim(successor);
      expect(claimOf(taken.allowed ? taken.value : null).claimed).toMatchObject({
        text: "주인의 메시지",
        principal: "owner",
      });
      const again = ledger.claim(successor);
      expect(claimOf(again.allowed ? again.value : null)).toMatchObject({ claimed: null, withheld: [] });
    } finally {
      await fixture.close();
    }
  });

  it("rejects a queued peer message when the CTO runtime is replaced within its generation instead of carrying it", async () => {
    const fixture = await startPeerFixture();
    try {
      const { harness } = fixture;
      const peerEvent = fixture.mention(fixture.ceo, { text: "런타임 1 에게 보낸 지시" });
      await fixture.relayDelivers(peerEvent);
      await fixture.relayDelivers(fixture.mention(fixture.owner, { text: "주인의 메시지" }));
      const generation = harness.cp.bindings.active(fixture.ctoRoleKey)!.bindingGeneration;

      const next = replaceCto(fixture, { conversation: "SURVIVED" });
      expect(harness.cp.bindings.active(fixture.ctoRoleKey)!.bindingGeneration).toBe(generation);

      expect(fixture.peerRows().map((row) => row.status)).toEqual(["REJECTED"]);
      const claim = JSON.parse(fixture.admitted(peerEvent.id)!.turn_claim_json!) as Record<string, unknown>;
      expect(claim["noReplyAt"]).toEqual(expect.any(String));

      // The owner's message is carried, and is the successor's to take once the mention's channel
      // identity is its own (1080-N5); before that it is withheld.
      const successor = {
        roleKey: fixture.ctoRoleKey,
        bindingGeneration: generation,
        targetSessionId: next.sessionId,
        sessionIncarnation: next.incarnation,
      };
      const withheld = ownerMessageLedger(harness.cp).claim(successor);
      expect(withheld.allowed && withheld.value.mentionWithheld?.map((row) => row.reason)).toEqual(["MENTION_NOT_ELIGIBLE"]);
      expect(harness.cp.sessions.transition(fixture.ctoSession.sessionId, SessionLifecycle.STOPPED, "replaced").reasonCode).toBe(ReasonCode.OK);
      bindChannelIdentity(harness, next, fixture.cto.pubkey);
      const taken = ownerMessageLedger(harness.cp).claim(successor);
      expect(claimOf(taken.allowed ? taken.value : null).claimed).toMatchObject({
        text: "주인의 메시지",
        principal: "owner",
      });
    } finally {
      await fixture.close();
    }
  });
});

describe("#1038 the subscriber's sink presents what the relay signed", () => {
  it("presents the receipt the frame arrived with as the peer proof, and never builds one of its own", async () => {
    const fixture = await startPeerFixture();
    try {
      const event = fixture.mention(fixture.ceo);
      const receipt = fixture.receiptNow();
      const request = {
        roleKey: fixture.ctoRoleKey,
        identityPubkey: fixture.cto.pubkey,
        conversation: PROJECT_ROOM,
        event,
        receipt,
      };
      const input = buzzMentionInputFor(fixture.ingress.seam.ingress, SECRET, request);
      expect(input).toMatchObject({
        actor: fixture.ceo.pubkey,
        conversation: PROJECT_ROOM,
        eventId: event.id,
        addressedTo: BUZZ_MENTION_ADDRESSED_TO,
        mention: fixture.cto.pubkey,
        text: event.content,
        createdAt: event.created_at,
        peer: receipt,
      });
      expect(input.signature).toBe(ingressSignature(SECRET, buzzMessageSigningRequest(input)));

      // A frame that arrived with no receipt is presented with no proof, and is refused for it
      // rather than given one made at processing time (#1044).
      const unreceipted = buzzMentionInputFor(fixture.ingress.seam.ingress, SECRET, {
        ...request,
        receipt: null,
      });
      expect(unreceipted.peer).toBeUndefined();
      const before = fixture.writes();
      expect(
        await deliverBuzzMessage(fixture.ingress.seam.ingress, fixture.ingress.seam.port, unreceipted),
      ).toMatchObject({ allowed: false, reasonCode: ReasonCode.BUZZ_PEER_GENERATION_STALE });
      expect(fixture.writes()).toBe(before);

      // An owner's event carries no peer proof, receipt or not: the owner path is unchanged.
      const ownerInput = buzzMentionInputFor(fixture.ingress.seam.ingress, SECRET, {
        ...request,
        event: fixture.mention(fixture.owner),
      });
      expect(ownerInput.peer).toBeUndefined();
    } finally {
      await fixture.close();
    }
  });
});
