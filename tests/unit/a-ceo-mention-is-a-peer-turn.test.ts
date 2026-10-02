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
import { ReasonCode } from "../../src/core/reason-codes.ts";
import {
  buzzMentionInputFor,
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
const startPeerFixture = async (options: { ceoChannelIdentity?: "bound" | "null" } = {}) => {
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
  const ingress = await startBuzzMessageIngressListener(harness.cp, dir, policy, {
    ceoConversation: new CeoConversationPort(),
    ownerActors: [owner.pubkey],
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

  it("refuses an event bound under the old generation and dispatched after a rotation, with zero writes", async () => {
    const fixture = await startPeerFixture();
    try {
      // The envelope the sink builds at receipt, under generation 1 ...
      const event = fixture.mention(fixture.ceo, {
        // Dated after the rotation below, so the event's own time cannot be what refuses it.
        createdAt: fixture.nowSeconds() + 60,
        text: "대기열에 있던 지시",
      });
      const queued = buzzMentionInputFor(fixture.ingress.seam.ingress, SECRET, {
        roleKey: fixture.ctoRoleKey,
        identityPubkey: fixture.cto.pubkey,
        conversation: PROJECT_ROOM,
        event,
      });
      expect((queued.peer as { ceoBindingGeneration: number }).ceoBindingGeneration).toBe(
        fixture.ceoGeneration,
      );

      // ... then the CEO rotates onto a new runtime that reuses the same key ...
      const rotated = rotateCeo(fixture, { sameKey: true, advanceMs: 30_000 });

      // ... and only then is it dispatched.
      const before = fixture.writes();
      const refused = await deliverBuzzMessage(
        fixture.ingress.seam.ingress,
        fixture.ingress.seam.port,
        queued,
      );
      expect(refused).toMatchObject({ allowed: false, reasonCode: ReasonCode.BUZZ_PEER_GENERATION_STALE });
      expect(fixture.writes()).toBe(before);
      expect(fixture.admitted(event.id)).toBeUndefined();

      // Control: the same event, bound now, is admitted under the new generation.
      const rebound = buzzMentionInputFor(fixture.ingress.seam.ingress, SECRET, {
        roleKey: fixture.ctoRoleKey,
        identityPubkey: fixture.cto.pubkey,
        conversation: PROJECT_ROOM,
        event,
      });
      const admitted = await deliverBuzzMessage(
        fixture.ingress.seam.ingress,
        fixture.ingress.seam.port,
        rebound,
      );
      expect(admitted.allowed).toBe(true);
      expect(
        (JSON.parse(fixture.admitted(event.id)!.payload_json) as { peer: { ceoBindingGeneration: number } })
          .peer.ceoBindingGeneration,
      ).toBe(rotated.generation);
    } finally {
      await fixture.close();
    }
  });

  it("refuses an event signed before a same-key rotation with zero writes, even when it is re-bound at delivery", async () => {
    const fixture = await startPeerFixture();
    try {
      // Signed during generation 1, by the key generation 2 will reuse.
      const old = fixture.mention(fixture.ceo, { text: "1세대에서 서명됨" });
      rotateCeo(fixture, { sameKey: true });

      // The relay redelivers it after the rotation. The sink binds it fresh — to generation 2 —
      // and its signature still verifies, because the key is the same. Its signed time is what
      // says it was written before generation 2 existed.
      const before = fixture.writes();
      await fixture.relayDelivers(old);
      expect(fixture.writes()).toBe(before);
      expect(fixture.admitted(old.id)).toBeUndefined();
      expect(fixture.refusedWith(ReasonCode.BUZZ_PEER_EVENT_OUTSIDE_GENERATION)).toBe(1);

      // Control: the same key, signing after the rotation, is the current CEO.
      const fresh = fixture.mention(fixture.ceo, { text: "2세대에서 서명됨" });
      await fixture.relayDelivers(fresh);
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
      const valid = buzzMentionInputFor(ingress.seam.ingress, SECRET, {
        roleKey: fixture.ctoRoleKey,
        identityPubkey: fixture.cto.pubkey,
        conversation: PROJECT_ROOM,
        event,
      });
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
      const valid = buzzMentionInputFor(fixture.ingress.seam.ingress, SECRET, {
        roleKey: fixture.ctoRoleKey,
        identityPubkey: fixture.cto.pubkey,
        conversation: PROJECT_ROOM,
        event,
      });
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
      const valid = buzzMentionInputFor(ingress.seam.ingress, SECRET, {
        roleKey: fixture.ctoRoleKey,
        identityPubkey: fixture.cto.pubkey,
        conversation: PROJECT_ROOM,
        event,
      });
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
      expect(fixture.refusedWith(ReasonCode.BUZZ_PEER_CHANNEL_MISMATCH)).toBe(1);
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

describe("#1038 the subscriber's sink presents what the relay signed", () => {
  it("builds the peer envelope from the verified event: author, room, signed time and the generation it was bound under", async () => {
    const fixture = await startPeerFixture();
    try {
      const event = fixture.mention(fixture.ceo);
      const input = buzzMentionInputFor(fixture.ingress.seam.ingress, SECRET, {
        roleKey: fixture.ctoRoleKey,
        identityPubkey: fixture.cto.pubkey,
        conversation: PROJECT_ROOM,
        event,
      });
      expect(input).toMatchObject({
        actor: fixture.ceo.pubkey,
        conversation: PROJECT_ROOM,
        eventId: event.id,
        addressedTo: BUZZ_MENTION_ADDRESSED_TO,
        mention: fixture.cto.pubkey,
        text: event.content,
        createdAt: event.created_at,
      });
      expect(input.signature).toBe(ingressSignature(SECRET, buzzMessageSigningRequest(input)));

      // An owner's event carries no peer proof: the owner path is unchanged.
      const ownerInput = buzzMentionInputFor(fixture.ingress.seam.ingress, SECRET, {
        roleKey: fixture.ctoRoleKey,
        identityPubkey: fixture.cto.pubkey,
        conversation: PROJECT_ROOM,
        event: fixture.mention(fixture.owner),
      });
      expect(ownerInput.peer).toBeUndefined();
    } finally {
      await fixture.close();
    }
  });
});
