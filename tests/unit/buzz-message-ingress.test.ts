import { createConnection } from "node:net";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, describe, expect, it } from "vitest";

import {
  configuredBuzzMessageOwnerActors,
  startBuzzActorIngressListener,
  startBuzzMessageIngressListener,
} from "../../src/daemon/agentcpd.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { allow } from "../../src/core/errors.ts";
import { digestOf } from "../../src/core/digest.ts";
import { Role, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import {
  IngressGuard,
  buzzActorBindingSigningRequest,
  ingressSignature,
} from "../../src/ingress/ingress-guard.ts";
import {
  BuzzMessageIngress,
  buzzMessageNonce,
  buzzMessageSigningRequest,
  type BuzzMentionRouter,
} from "../../src/ingress/buzz-message.ts";
import { CeoConversationPort } from "../../src/mcp/ceo-conversation.ts";
import { RoleConversationPort } from "../../src/mcp/role-conversation.ts";
import type { McpPeerAuthenticator } from "../../src/mcp/shared.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { bindCeo, fixtureManifest, makeHarness, registerFixtureProject } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

const SECRET = "buzz-message-ingress-test-secret";
const OWNER = "npub-owner";

/**
 * A second channel identity that is every bit as valid as the owner's, and is not the owner.
 *
 * It holds the same relay credential — same shared secret, same `allowedActors` entry — which is
 * what production hands every ACTIVE Buzz actor. So its envelope passes signature, recipient,
 * nonce and allowlist; the only thing wrong with it is who sent it. Every negative test that
 * fails on one of the *other* checks would pass with this actor missing, which is why it exists.
 */
const NON_OWNER = "npub-not-the-owner";

/** The relay allowlist as production composes it: the owner is on it, and so is everyone else. */
const RELAY_ACTORS = [OWNER, NON_OWNER];

/** Stands in for the per-request authenticator every inbound CEO tool call already runs. */
const stillCeo = (): McpPeerAuthenticator => () =>
  allow(ReasonCode.OK, { sessionId: "s", sessionIncarnation: "i", sessionSecret: "x" } as never);

interface FakeCeoPeer {
  calls: string[];
  answer: string;
}

/**
 * The port touches exactly two members of the SDK server, and both are ones a real peer drives
 * over the wire (see `tests/unit/ceo-conversation.test.ts`, which stands the same fake up).
 */
const fakeCeoPeer = (answer: string): { peer: FakeCeoPeer; server: McpServer } => {
  const peer: FakeCeoPeer = { calls: [], answer };
  const server = {
    server: {
      getClientCapabilities: () => ({ sampling: {} }),
      createMessage: async (params: { messages: { content: { text?: string } }[] }) => {
        peer.calls.push(params.messages[0]?.content.text ?? "");
        return { model: "fake", role: "assistant", content: { type: "text", text: peer.answer } };
      },
    },
  } as unknown as McpServer;
  return { peer, server };
};

const exchangeSocketLines = (
  socketPath: string,
  lines: readonly unknown[],
  complete: (received: string) => boolean,
): Promise<string> =>
  new Promise((resolveExchange, rejectExchange) => {
    const socket = createConnection(socketPath);
    let received = "";
    let settled = false;
    let timeout: NodeJS.Timeout | null = null;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (error) rejectExchange(error);
      else resolveExchange(received);
    };
    timeout = setTimeout(() => {
      socket.destroy();
      finish(new Error("local socket response timed out"));
    }, 10_000);
    socket.setEncoding("utf8");
    socket.once("connect", () => {
      if (lines.length > 0) socket.write(`${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
    });
    socket.on("data", (chunk: string) => {
      received += chunk;
      if (complete(received)) socket.end();
    });
    socket.once("error", (error) => finish(error));
    socket.once("close", () => finish());
  });

const hasReasonCode = (received: string): boolean => received.includes('"reasonCode"');

const envelope = (input: {
  eventId: string;
  text: string;
  actor?: string;
  conversation?: string;
  addressedTo?: string;
  mention?: string;
}) => {
  const message = {
    actor: input.actor ?? OWNER,
    conversation: input.conversation ?? "buzz-ceo-room",
    eventId: input.eventId,
    addressedTo: input.addressedTo ?? "CEO",
    // Inside the signature like everything else about the recipient. A `p` tag the relay did not
    // sign for would be an address anyone on the socket could substitute.
    mention: input.mention ?? null,
    text: input.text,
  };
  return { ...message, signature: ingressSignature(SECRET, buzzMessageSigningRequest(message)) };
};

/** Every session id the control plane holds, so a fork would show up as a new row. */
const sessionIds = (harness: ReturnType<typeof makeHarness>): string[] =>
  harness.cp.db
    .all<{ session_id: string }>(`SELECT session_id FROM sessions ORDER BY session_id`, [])
    .map((row) => row.session_id);

const startMessageListener = async (
  harness: ReturnType<typeof makeHarness>,
  ceoConversation: CeoConversationPort,
  roleConversation?: RoleConversationPort,
) =>
  startBuzzMessageIngressListener(
    harness.cp,
    tempDir("acp-buzz-message-"),
    { allowedActors: RELAY_ACTORS, secret: SECRET },
    { ceoConversation, ownerActors: [OWNER], roleConversation },
  );

/**
 * The `p` tag one of the rows below addresses. It is a Buzz channel identity — the same kind of
 * string `sessions.buzz_actor_id` holds — and deliberately not a role name: the address the
 * sender writes is a pubkey the relay can mention, and turning it into a role is the daemon's
 * job at delivery time (`#760` B0).
 */
const CTO_MENTION = "npub-cto-of-record";

/** The production writer's authenticator; the relay policy vouches for every actor in a test. */
const anyBuzzActorIsAuthenticated = { isAllowedActor: () => true };

/** `p`-tag resolution has to see the roles a *live* session holds, so the session is READY. */
const readyBoundSession = (
  harness: ReturnType<typeof makeHarness>,
  model: string,
  mention: string,
  projectIds: readonly string[],
): { sessionId: string; incarnation: string } => {
  const session = harness.cp.sessions.create({ provider: "scripted", model });
  expect(
    harness.cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "test").reasonCode,
  ).toBe(ReasonCode.OK);
  for (const projectId of projectIds) {
    const bound = harness.cp.bindings.bind({
      role: Role.PRIMARY_CTO,
      sessionId: session.sessionId,
      projectId,
    });
    if (!bound.allowed) throw new Error(`CTO binding failed: ${bound.message}`);
  }
  // The production writer, not a raw UPDATE: `sessions.buzz_actor_id` is the column inbound
  // resolution reads, and a test that wrote it directly would not be exercising the mapping an
  // authenticated `bindBuzzActor` establishes.
  const actor = harness.cp.sessions.bindBuzzActor(
    { sessionId: session.sessionId, sessionSecret: session.sessionSecret!, buzzActorId: mention },
    anyBuzzActorIsAuthenticated,
  );
  if (!actor.allowed) throw new Error(`buzz actor binding failed: ${actor.message}`);
  return {
    sessionId: session.sessionId,
    incarnation: harness.cp.sessions.require(session.sessionId).incarnation,
  };
};

/**
 * B2's port, built the way `startLocalMcpListeners` builds it.
 *
 * Its own enforcement (`#isCurrentHolder`) is covered by `the-cto-socket-has-a-live-peer.test.ts`
 * and is not re-measured here; what these rows measure is whether the ingress hands it the right
 * role key, and whether nothing is handed to it at all when the `p` tag resolves to no role.
 */
const roleConversationFor = (harness: ReturnType<typeof makeHarness>): RoleConversationPort =>
  new RoleConversationPort(Role.PRIMARY_CTO, {
    active: (roleKey) => harness.cp.bindings.active(roleKey),
    currentCandidates: () =>
      harness.cp.projects
        .list()
        .map((project) => harness.cp.bindings.activePrimaryCto(project.projectId))
        .filter((binding): binding is NonNullable<typeof binding> => binding !== null),
  });

/** Stands in for the authenticated MCP connection a role's session holds open. */
const stillHeldBy = (session: { sessionId: string; incarnation: string }): McpPeerAuthenticator =>
  () =>
    allow(ReasonCode.OK, {
      actor: "role-peer",
      sessionId: session.sessionId,
      sessionIncarnation: session.incarnation,
    });

/** For the two rows that build an ingress directly and never present a `p` tag. */
const resolvesNothing: BuzzMentionRouter = {
  rolesFor: () => [],
  journalUnbound: () => {
    throw new Error("no row that constructs an ingress directly presents a mention");
  },
};

/** Every journal row this path writes for a `p` tag it could not turn into an address. */
const unboundJournal = (harness: ReturnType<typeof makeHarness>) =>
  harness.cp.audit.all().filter((row) => row.reasonCode === ReasonCode.MENTION_TARGET_UNBOUND);

describe("the daemon's Buzz message ingress", () => {
  it("delivers an owner's Buzz message to the holder of the active CEO binding without spawning a session child", async () => {
    const harness = makeHarness();
    const ceoSessionId = bindCeo(harness);
    const before = sessionIds(harness);
    const childrenBefore = process.getActiveResourcesInfo().filter((r) => r === "ChildProcess").length;

    const conversation = new CeoConversationPort();
    const { peer, server } = fakeCeoPeer("돌고 있어");
    conversation.attach(server, stillCeo());
    const listener = await startMessageListener(harness, conversation);

    try {
      const received = await exchangeSocketLines(
        listener.socketPath,
        [envelope({ eventId: "evt-1", text: "어떻게 돼가?" })],
        hasReasonCode,
      );
      const body = JSON.parse(received.trim()) as {
        ok: boolean;
        reasonCode: string;
        answer?: string;
        answeredByCeo?: boolean;
      };

      // The turn reached the CEO peer, and its answer came back over the socket the relay called.
      expect(body).toMatchObject({ ok: true, reasonCode: ReasonCode.OK, answeredByCeo: true });
      expect(body.answer).toBe("돌고 있어");
      expect(peer.calls).toEqual(["어떻게 돼가?"]);

      // The no-fork property, asserted directly rather than inferred from a successful delivery.
      // A path that forked would leave a new session row and a live child behind; both are read
      // here, and the CEO binding still names the session it named before the message arrived.
      expect(sessionIds(harness)).toEqual(before);
      expect(
        process.getActiveResourcesInfo().filter((r) => r === "ChildProcess").length,
      ).toBe(childrenBefore);
      expect(harness.cp.bindings.active(roleKeyFor(Role.CEO))?.boundSessionId).toBe(ceoSessionId);
    } finally {
      await listener.close();
    }
  });

  it("claims the turn under the CEO generation it was answered by, and refuses the same event twice", async () => {
    const harness = makeHarness();
    bindCeo(harness);
    const generation = harness.cp.bindings.active(roleKeyFor(Role.CEO))!.bindingGeneration;

    const conversation = new CeoConversationPort();
    const { server } = fakeCeoPeer("답");
    conversation.attach(server, stillCeo());
    const listener = await startMessageListener(harness, conversation);

    try {
      const first = await exchangeSocketLines(
        listener.socketPath,
        [envelope({ eventId: "evt-claim", text: "진행 상황" })],
        hasReasonCode,
      );
      expect(JSON.parse(first.trim())).toMatchObject({ ok: true, reasonCode: ReasonCode.OK });

      const claim = harness.cp.db.get<{ turn_claim_json: string | null }>(
        `SELECT turn_claim_json FROM inbound_messages WHERE channel = 'buzz' AND nonce = ?`,
        [buzzMessageNonce("evt-claim")],
      );
      const stored = JSON.parse(claim!.turn_claim_json!) as {
        bindingDigest: string;
        promptDigest: string;
        repliedAt?: string;
      };
      // The fence #639 wired at claim time: the generation the turn ran under is fixed in the
      // claim, not read back from a binding that may since have moved.
      expect(stored.bindingDigest).toBe(digestOf({ bindingGeneration: generation }));
      expect(stored.promptDigest).toBe(digestOf("진행 상황"));
      expect(stored.repliedAt).toBeTypeOf("string");

      const replay = await exchangeSocketLines(
        listener.socketPath,
        [envelope({ eventId: "evt-claim", text: "진행 상황" })],
        hasReasonCode,
      );
      expect(JSON.parse(replay.trim())).toMatchObject({
        ok: false,
        reasonCode: ReasonCode.INGRESS_REPLAY_IGNORED,
      });
    } finally {
      await listener.close();
    }
  });

  it("refuses a forged signature, a channel identity that is not allowlisted, and a message not addressed to the CEO", async () => {
    const harness = makeHarness();
    bindCeo(harness);
    const conversation = new CeoConversationPort();
    const { peer, server } = fakeCeoPeer("답");
    conversation.attach(server, stillCeo());
    const listener = await startMessageListener(harness, conversation);

    try {
      const forged = await exchangeSocketLines(
        listener.socketPath,
        [{ ...envelope({ eventId: "evt-forged", text: "hi" }), signature: "forged" }],
        hasReasonCode,
      );
      expect(JSON.parse(forged.trim())).toMatchObject({
        ok: false,
        reasonCode: ReasonCode.INGRESS_SIGNATURE_INVALID,
      });

      const stranger = await exchangeSocketLines(
        listener.socketPath,
        [envelope({ eventId: "evt-stranger", text: "hi", actor: "npub-stranger" })],
        hasReasonCode,
      );
      expect(JSON.parse(stranger.trim())).toMatchObject({
        ok: false,
        reasonCode: ReasonCode.INGRESS_ACTOR_NOT_ALLOWLISTED,
      });

      // A CEO↔CTO journal message in the same room is not a second CEO turn (SSOT §114): only
      // an envelope the relay addressed to the CEO becomes one.
      const journal = await exchangeSocketLines(
        listener.socketPath,
        [envelope({ eventId: "evt-journal", text: "CTO 보고", addressedTo: "CTO" })],
        hasReasonCode,
      );
      expect(JSON.parse(journal.trim())).toMatchObject({
        ok: false,
        reasonCode: ReasonCode.INVALID_ARGUMENT,
      });

      expect(peer.calls).toEqual([]);
    } finally {
      await listener.close();
    }
  });

  it("tells the owner when no CEO peer is connected instead of starting one", async () => {
    const harness = makeHarness();
    bindCeo(harness);
    const conversation = new CeoConversationPort();
    const before = sessionIds(harness);
    const listener = await startMessageListener(harness, conversation);

    try {
      const received = await exchangeSocketLines(
        listener.socketPath,
        [envelope({ eventId: "evt-nobody", text: "계세요?" })],
        hasReasonCode,
      );
      const body = JSON.parse(received.trim()) as { ok: boolean; reasonCode: string; answer?: string };
      expect(body.ok).toBe(true);
      expect(body.reasonCode).toBe(ReasonCode.CEO_CONVERSATION_UNAVAILABLE);
      expect(body.answer).toContain("No CEO session is connected");
      // Nothing was started to answer it. That is the whole difference from the deployed path.
      expect(sessionIds(harness)).toEqual(before);

      // Nothing was asked of the CEO, so the claim is closed rather than left outstanding.
      const claim = harness.cp.db.get<{ turn_claim_json: string | null }>(
        `SELECT turn_claim_json FROM inbound_messages WHERE channel = 'buzz' AND nonce = ?`,
        [buzzMessageNonce("evt-nobody")],
      );
      expect(JSON.parse(claim!.turn_claim_json!)).toMatchObject({ repliedAt: expect.any(String) });
    } finally {
      await listener.close();
    }
  });

  it("leaves the claim outstanding when the turn reached the CEO and no answer came back", async () => {
    const harness = makeHarness();
    bindCeo(harness);
    const conversation = new CeoConversationPort();
    const slowPeer = {
      server: {
        getClientCapabilities: () => ({ sampling: {} }),
        createMessage: async () => {
          throw new McpError(ErrorCode.RequestTimeout, "budget expired");
        },
      },
    } as unknown as McpServer;
    conversation.attach(slowPeer, stillCeo());
    const listener = await startMessageListener(harness, conversation);

    try {
      const received = await exchangeSocketLines(
        listener.socketPath,
        [envelope({ eventId: "evt-slow", text: "오래 걸리는 질문" })],
        hasReasonCode,
      );
      const body = JSON.parse(received.trim()) as { ok: boolean; reasonCode: string; answeredByCeo: boolean };
      expect(body.reasonCode).toBe(ReasonCode.CEO_CONVERSATION_TIMEOUT);
      expect(body.answeredByCeo).toBe(false);

      // The CEO may still be writing into the canonical transcript. Marking the turn replied
      // would be the unearned claim; `unresolvedTurns` is the surface that reads this.
      const claim = harness.cp.db.get<{ turn_claim_json: string | null }>(
        `SELECT turn_claim_json FROM inbound_messages WHERE channel = 'buzz' AND nonce = ?`,
        [buzzMessageNonce("evt-slow")],
      );
      const stored = JSON.parse(claim!.turn_claim_json!) as Record<string, unknown>;
      expect(stored["repliedAt"]).toBeUndefined();
      expect(stored["noReplyAt"]).toBeUndefined();
    } finally {
      await listener.close();
    }
  });

  it("refuses to deliver at all on an unsigned Buzz policy", () => {
    const harness = makeHarness();
    // Not reachable through `startBuzzMessageIngressListener`, which refuses an empty secret at
    // construction. This is the guard for any other caller: without it, `IngressGuard.admit`
    // skips signature verification entirely and anything on the allowlist speaks as the owner.
    const guard = new IngressGuard(harness.cp.db, harness.cp.clock, harness.cp.audit, {
      buzz: { allowedActors: [OWNER] },
    });
    const ingress = new BuzzMessageIngress(guard, [OWNER], resolvesNothing);

    const admitted = ingress.admit({
      actor: OWNER,
      conversation: "buzz-ceo-room",
      eventId: "evt-unsigned",
      addressedTo: "CEO",
      text: "hi",
    });

    expect(admitted.allowed).toBe(false);
    expect(admitted.reasonCode).toBe(ReasonCode.INGRESS_SIGNATURE_INVALID);
  });

  it("refuses to open a message socket on a policy with no signing secret", async () => {
    const harness = makeHarness();

    await expect(
      startBuzzMessageIngressListener(
        harness.cp,
        tempDir("acp-buzz-unsigned-"),
        { allowedActors: [OWNER] },
        { ceoConversation: new CeoConversationPort(), ownerActors: [OWNER] },
      ),
    ).rejects.toThrow(/non-empty signing secret/u);
  });

  it("keeps a message event id from consuming an actor binding's nonce", async () => {
    const harness = makeHarness();
    bindCeo(harness);
    const session = harness.cp.sessions.create({ provider: "scripted", model: "scripted-buzz-peer" });
    const conversation = new CeoConversationPort();
    const { server } = fakeCeoPeer("답");
    conversation.attach(server, stillCeo());

    const message = await startMessageListener(harness, conversation);
    const binding = await startBuzzActorIngressListener(harness.cp, tempDir("acp-buzz-bind-"), {
      allowedActors: [OWNER],
      secret: SECRET,
    });

    try {
      // Both paths are the `buzz` channel and share one `(channel, nonce)` dedup space. The
      // relay picks the binding nonce; without a namespace of its own, a message whose event id
      // matched it would be refused as a replay of a binding it has nothing to do with.
      const collision = "collide";
      const bindInput = {
        actor: OWNER,
        sessionId: session.sessionId,
        sessionSecret: session.sessionSecret!,
        nonce: collision,
      };
      const bound = await exchangeSocketLines(
        binding.socketPath,
        [{ ...bindInput, signature: ingressSignature(SECRET, buzzActorBindingSigningRequest(bindInput)) }],
        hasReasonCode,
      );
      expect(JSON.parse(bound.trim())).toMatchObject({ ok: true, reasonCode: ReasonCode.OK });

      const delivered = await exchangeSocketLines(
        message.socketPath,
        [envelope({ eventId: collision, text: "어떻게 돼가?" })],
        hasReasonCode,
      );
      expect(JSON.parse(delivered.trim())).toMatchObject({ ok: true, reasonCode: ReasonCode.OK });
    } finally {
      await binding.close();
      await message.close();
    }
  });

  it("keeps the two Buzz sockets from answering each other's envelopes", async () => {
    const harness = makeHarness();
    bindCeo(harness);
    const session = harness.cp.sessions.create({ provider: "scripted", model: "scripted-buzz-peer" });
    const conversation = new CeoConversationPort();
    const { peer, server } = fakeCeoPeer("답");
    conversation.attach(server, stillCeo());

    const message = await startMessageListener(harness, conversation);
    const binding = await startBuzzActorIngressListener(harness.cp, tempDir("acp-buzz-bind-"), {
      allowedActors: [OWNER],
      secret: SECRET,
    });

    try {
      // A binding envelope on the message socket is refused, never bound.
      const bindingOnMessage = await exchangeSocketLines(
        message.socketPath,
        [{
          actor: OWNER,
          sessionId: session.sessionId,
          sessionSecret: session.sessionSecret,
          nonce: "buzz-bind-x",
          signature: "whatever",
        }],
        hasReasonCode,
      );
      expect(JSON.parse(bindingOnMessage.trim())).toMatchObject({
        ok: false,
        reasonCode: ReasonCode.INVALID_ARGUMENT,
      });
      expect(harness.cp.sessions.require(session.sessionId).buzzActorId).toBeNull();

      // A message envelope on the binding socket is refused, never delivered.
      const messageOnBinding = await exchangeSocketLines(
        binding.socketPath,
        [envelope({ eventId: "evt-wrong-socket", text: "어떻게 돼가?" })],
        hasReasonCode,
      );
      expect(JSON.parse(messageOnBinding.trim())).toMatchObject({
        ok: false,
        reasonCode: ReasonCode.INVALID_ARGUMENT,
      });
      expect(peer.calls).toEqual([]);
    } finally {
      await binding.close();
      await message.close();
    }
  });

  it("refuses an ACTIVE non-owner's otherwise valid CEO envelope, and still delivers the owner's identical one", async () => {
    const harness = makeHarness();
    bindCeo(harness);
    const conversation = new CeoConversationPort();
    const { peer, server } = fakeCeoPeer("owner에게만 답한다");
    conversation.attach(server, stillCeo());
    const listener = await startMessageListener(harness, conversation);
    const before = sessionIds(harness);

    try {
      // Everything about this envelope is valid except who sent it: the signature verifies under
      // the relay secret, the actor is on the relay allowlist production composes, the recipient
      // is the CEO, and the nonce is fresh.
      const eventId = "evt-non-owner";
      const text = "CEO, 지금 상태 알려줘";
      const refused = await exchangeSocketLines(
        listener.socketPath,
        [envelope({ eventId, text, actor: NON_OWNER })],
        hasReasonCode,
      );
      expect(JSON.parse(refused.trim())).toMatchObject({
        ok: false,
        reasonCode: ReasonCode.INGRESS_ACTOR_NOT_ALLOWLISTED,
      });

      // The three things the refusal has to have cost nobody.
      expect(peer.calls).toEqual([]);
      expect(
        harness.cp.db.all(
          `SELECT nonce FROM inbound_messages WHERE channel = 'buzz' AND nonce = ?`,
          [buzzMessageNonce(eventId)],
        ),
      ).toEqual([]);
      expect(sessionIds(harness)).toEqual(before);

      // The same event id and the same words from the owner go through. Without this the test
      // above would also pass on an ingress that refused every message, or one that had quietly
      // consumed the nonce and would refuse the owner's as a replay.
      const delivered = await exchangeSocketLines(
        listener.socketPath,
        [envelope({ eventId, text })],
        hasReasonCode,
      );
      expect(JSON.parse(delivered.trim())).toMatchObject({
        ok: true,
        reasonCode: ReasonCode.OK,
        answeredByCeo: true,
      });
      expect(peer.calls).toEqual([text]);
    } finally {
      await listener.close();
    }
  });

  it("delivers a `p`-tagged message to the role's live peer, and keeps that address across a session replacement", async () => {
    const harness = makeHarness();
    const { projectId } = await registerFixtureProject(harness);
    const roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId });
    const first = readyBoundSession(harness, "cto-first", CTO_MENTION, [projectId]);

    const roleConversation = roleConversationFor(harness);
    const firstPeer = fakeCeoPeer("CTO 받았다");
    roleConversation.attach(firstPeer.server, stillHeldBy(first));
    const ceo = fakeCeoPeer("CEO가 답하면 안 된다");
    const ceoConversation = new CeoConversationPort();
    ceoConversation.attach(ceo.server, stillCeo());
    const listener = await startMessageListener(harness, ceoConversation, roleConversation);
    const before = sessionIds(harness);

    try {
      const delivered = await exchangeSocketLines(
        listener.socketPath,
        [envelope({ eventId: "evt-cto", text: "CTO, U6 상태", addressedTo: "CTO", mention: CTO_MENTION })],
        hasReasonCode,
      );
      expect(JSON.parse(delivered.trim())).toMatchObject({ ok: true, reasonCode: ReasonCode.OK });
      expect(firstPeer.peer.calls).toEqual(["CTO, U6 상태"]);
      // The address decided the recipient. Without this the row above would also pass on an
      // ingress that delivered every message to the CEO, which is precisely the base behaviour.
      expect(ceo.peer.calls).toEqual([]);
      // Nothing was started to receive it — the same no-fork property the CEO row asserts.
      expect(sessionIds(harness)).toEqual(before);

      // The claim is fenced by the *role's* generation, not the CEO's. A receipt from a
      // superseded CTO must not pass a claim stamped with whatever the CEO happened to be at.
      const claim = harness.cp.db.get<{ turn_claim_json: string | null }>(
        `SELECT turn_claim_json FROM inbound_messages WHERE channel = 'buzz' AND nonce = ?`,
        [buzzMessageNonce("evt-cto")],
      );
      expect(JSON.parse(claim!.turn_claim_json!)).toMatchObject({
        bindingDigest: digestOf({
          bindingGeneration: harness.cp.bindings.active(roleKey)!.bindingGeneration,
        }),
      });

      // The `(channel, nonce)` dedup #750 already owns is the only one: the same event id does
      // not become a second turn, and nothing was added beside it to make that true.
      const replay = await exchangeSocketLines(
        listener.socketPath,
        [envelope({ eventId: "evt-cto", text: "CTO, U6 상태", addressedTo: "CTO", mention: CTO_MENTION })],
        hasReasonCode,
      );
      expect(JSON.parse(replay.trim())).toMatchObject({
        ok: false,
        reasonCode: ReasonCode.INGRESS_REPLAY_IGNORED,
      });
      expect(firstPeer.peer.calls).toEqual(["CTO, U6 상태"]);

      // B0/B0b — the session holding the role is replaced, which is ordinary operation. The
      // sender's address is unchanged: the same `p` tag string, and nobody had to learn a new one.
      expect(harness.cp.bindings.revoke(roleKey, "test replacement").reasonCode).toBe(ReasonCode.OK);
      expect(
        harness.cp.sessions.transition(first.sessionId, SessionLifecycle.STOPPED, "test").reasonCode,
      ).toBe(ReasonCode.OK);
      const second = readyBoundSession(harness, "cto-second", CTO_MENTION, [projectId]);
      expect(second.sessionId).not.toBe(first.sessionId);
      const secondPeer = fakeCeoPeer("새 세션이 받았다");
      roleConversation.attach(secondPeer.server, stillHeldBy(second));

      const afterReplacement = await exchangeSocketLines(
        listener.socketPath,
        [envelope({ eventId: "evt-cto-2", text: "교체 후에도", addressedTo: "CTO", mention: CTO_MENTION })],
        hasReasonCode,
      );
      expect(JSON.parse(afterReplacement.trim())).toMatchObject({ ok: true, reasonCode: ReasonCode.OK });
      expect(secondPeer.peer.calls).toEqual(["교체 후에도"]);
      expect(firstPeer.peer.calls).toEqual(["CTO, U6 상태"]);
    } finally {
      await listener.close();
    }
  });

  it("makes no turn and no delivery for a `p` tag that names nobody, names too many, or is empty", async () => {
    const harness = makeHarness();
    bindCeo(harness);
    const a = await registerFixtureProject(harness, "project-a");
    const b = harness.cp.projects.register({
      projectId: "project-b",
      name: "fixture",
      manifest: fixtureManifest("project-b"),
      authorization: harness.cp.manifestAuthorizationForTests(fixtureManifest("project-b")),
    });
    if (!b.allowed) throw new Error(`second project failed: ${b.message}`);
    // One session, two projects, both CTO. A legal state — and two roles is not an address.
    const ambiguous = readyBoundSession(harness, "cto-of-two", "npub-cto-of-two", [
      a.projectId,
      "project-b",
    ]);
    expect(ambiguous.sessionId).toBeTypeOf("string");

    const roleConversation = roleConversationFor(harness);
    const ceo = fakeCeoPeer("CEO는 이 중 어느 것도 받지 않는다");
    const ceoConversation = new CeoConversationPort();
    ceoConversation.attach(ceo.server, stillCeo());
    const listener = await startMessageListener(harness, ceoConversation, roleConversation);
    const before = sessionIds(harness);

    const rows: readonly { label: string; eventId: string; mention: string }[] = [
      { label: "bound to nobody", eventId: "evt-unbound", mention: "npub-nobody-holds-this" },
      { label: "bound to two roles at once", eventId: "evt-ambiguous", mention: "npub-cto-of-two" },
      { label: "present but empty", eventId: "evt-empty", mention: "   " },
    ];

    try {
      for (const [index, row] of rows.entries()) {
        const refused = await exchangeSocketLines(
          listener.socketPath,
          [envelope({ eventId: row.eventId, text: "누구에게도 가면 안 된다", addressedTo: "CTO", mention: row.mention })],
          hasReasonCode,
        );
        expect(JSON.parse(refused.trim()), row.label).toMatchObject({
          ok: false,
          reasonCode: ReasonCode.MENTION_TARGET_UNBOUND,
        });

        // No turn: the replay slot for this event id was never consumed, so the same event can
        // still be delivered once its `p` tag names a role.
        expect(
          harness.cp.db.all(
            `SELECT nonce FROM inbound_messages WHERE channel = 'buzz' AND nonce = ?`,
            [buzzMessageNonce(row.eventId)],
          ),
          row.label,
        ).toEqual([]);
        // No delivery, anywhere. The CEO in particular is not the fallback recipient for a
        // message this daemon could not address.
        expect(ceo.peer.calls, row.label).toEqual([]);
        expect(sessionIds(harness), row.label).toEqual(before);
        // Exactly one journal row per refused envelope — not zero, which is the silence #760
        // opens with, and not two.
        expect(unboundJournal(harness).length, row.label).toBe(index + 1);
      }

      const journalled = unboundJournal(harness);
      expect(journalled.map((row) => row.kind)).toEqual([
        "BUZZ_MENTION_TARGET_UNBOUND",
        "BUZZ_MENTION_TARGET_UNBOUND",
        "BUZZ_MENTION_TARGET_UNBOUND",
      ]);
      expect(journalled[0]?.evidence).toMatchObject({
        channel: "buzz",
        target: "npub-nobody-holds-this",
        candidates: 0,
      });
      expect(journalled[1]?.evidence).toMatchObject({ target: "npub-cto-of-two", candidates: 2 });
    } finally {
      await listener.close();
    }
  });

  it("does not let a resolvable mention stand in for owner authority", async () => {
    const harness = makeHarness();
    const { projectId } = await registerFixtureProject(harness);
    const session = readyBoundSession(harness, "cto-peer", CTO_MENTION, [projectId]);
    const roleConversation = roleConversationFor(harness);
    const rolePeer = fakeCeoPeer("owner에게만 답한다");
    roleConversation.attach(rolePeer.server, stillHeldBy(session));
    const listener = await startMessageListener(harness, new CeoConversationPort(), roleConversation);

    try {
      // Everything about this envelope is valid except who sent it — including, now, a `p` tag
      // that resolves to exactly one live role. Resolving a recipient says nothing about the
      // sender's authority, and an ingress that let the first answer the second would have made
      // every ACTIVE relay identity an owner the moment addressing became possible.
      const eventId = "evt-non-owner-mention";
      const refused = await exchangeSocketLines(
        listener.socketPath,
        [envelope({ eventId, text: "CTO, 지금 멈춰", actor: NON_OWNER, addressedTo: "CTO", mention: CTO_MENTION })],
        hasReasonCode,
      );
      expect(JSON.parse(refused.trim())).toMatchObject({
        ok: false,
        reasonCode: ReasonCode.INGRESS_ACTOR_NOT_ALLOWLISTED,
      });
      expect(rolePeer.peer.calls).toEqual([]);
      expect(
        harness.cp.db.all(`SELECT nonce FROM inbound_messages WHERE channel = 'buzz' AND nonce = ?`, [
          buzzMessageNonce(eventId),
        ]),
      ).toEqual([]);
      // A stranger cannot make this daemon write a journal row either: the refusal is decided
      // before the address is looked at, so an unauthenticated sender leaves no trace of its
      // guesses at the deployment's channel identities.
      expect(unboundJournal(harness)).toEqual([]);

      // The owner's identical envelope goes through, so the row above cannot pass on an ingress
      // that refused everything.
      const delivered = await exchangeSocketLines(
        listener.socketPath,
        [envelope({ eventId, text: "CTO, 지금 멈춰", addressedTo: "CTO", mention: CTO_MENTION })],
        hasReasonCode,
      );
      expect(JSON.parse(delivered.trim())).toMatchObject({ ok: true, reasonCode: ReasonCode.OK });
      expect(rolePeer.peer.calls).toEqual(["CTO, 지금 멈춰"]);
    } finally {
      await listener.close();
    }
  });

  it("refuses to construct a message ingress with no declared owner", () => {
    const harness = makeHarness();
    const guard = new IngressGuard(harness.cp.db, harness.cp.clock, harness.cp.audit, {
      buzz: { allowedActors: RELAY_ACTORS, secret: SECRET },
    });

    // Falling back to the guard's own allowlist is exactly the defect; an absent owner
    // declaration has to close the path rather than widen it.
    expect(() => new BuzzMessageIngress(guard, [], resolvesNothing)).toThrow(
      /declared buzz owner identity/u,
    );
    expect(() => new BuzzMessageIngress(guard, ["  "], resolvesNothing)).toThrow(
      /declared buzz owner identity/u,
    );
  });

  it("takes the message path's owners from owner-identities rather than from the relay allowlist", () => {
    expect(
      configuredBuzzMessageOwnerActors([
        { channel: "telegram", actor: "12345" },
        { channel: "buzz", actor: OWNER },
        { channel: "buzz", actor: ` ${OWNER} ` },
        { channel: "cli", actor: "isaac" },
      ]),
    ).toEqual([OWNER]);

    // No buzz owner declared is not "any buzz actor"; `main` reads this empty and leaves the
    // message socket closed.
    expect(configuredBuzzMessageOwnerActors([{ channel: "telegram", actor: "12345" }])).toEqual([]);
  });
});
