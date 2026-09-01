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
import { Role, roleKeyFor } from "../../src/domain/types.ts";
import {
  IngressGuard,
  buzzActorBindingSigningRequest,
  ingressSignature,
} from "../../src/ingress/ingress-guard.ts";
import {
  BuzzMessageIngress,
  buzzMessageNonce,
  buzzMessageSigningRequest,
} from "../../src/ingress/buzz-message.ts";
import { CeoConversationPort } from "../../src/mcp/ceo-conversation.ts";
import type { McpPeerAuthenticator } from "../../src/mcp/shared.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { bindCeo, makeHarness } from "../helpers/harness.ts";

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
}) => {
  const message = {
    actor: input.actor ?? OWNER,
    conversation: input.conversation ?? "buzz-ceo-room",
    eventId: input.eventId,
    addressedTo: input.addressedTo ?? "CEO",
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
) =>
  startBuzzMessageIngressListener(
    harness.cp,
    tempDir("acp-buzz-message-"),
    { allowedActors: RELAY_ACTORS, secret: SECRET },
    { ceoConversation, ownerActors: [OWNER] },
  );

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
    const ingress = new BuzzMessageIngress(guard, [OWNER]);

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

  it("refuses to construct a message ingress with no declared owner", () => {
    const harness = makeHarness();
    const guard = new IngressGuard(harness.cp.db, harness.cp.clock, harness.cp.audit, {
      buzz: { allowedActors: RELAY_ACTORS, secret: SECRET },
    });

    // Falling back to the guard's own allowlist is exactly the defect; an absent owner
    // declaration has to close the path rather than widen it.
    expect(() => new BuzzMessageIngress(guard, [])).toThrow(/declared buzz owner identity/u);
    expect(() => new BuzzMessageIngress(guard, ["  "])).toThrow(/declared buzz owner identity/u);
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
