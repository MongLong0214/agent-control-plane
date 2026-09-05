import { chmodSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { afterAll, describe, expect, it } from "vitest";

import {
  configuredBuzzMessageOwnerActors,
  startBuzzActorIngressListener,
  startBuzzMessageIngressListener,
  startDaemonBuzzMentionSubscriber,
  startDaemonBuzzMessageIngress,
  startLocalMcpListeners,
} from "../../src/daemon/agentcpd.ts";
import {
  BUZZ_MENTION_ADDRESSED_TO,
  BUZZ_SUBSCRIBER_CONFIG_FILENAME,
  type BuzzRelaySocketFactory,
  type BuzzRelaySocketHandlers,
  type BuzzSubscriberScheduler,
} from "../../src/buzz/buzz-mention-subscriber.ts";
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
  buzzMessagePayload,
  buzzMessageSigningRequest,
  ownerMessageQueuedSentence,
  ownerMessagePointerOf,
  type BuzzMentionRouter,
} from "../../src/ingress/buzz-message.ts";
import { CeoConversationPort } from "../../src/mcp/ceo-conversation.ts";
import {
  C0_QUALIFIED_CLIENT,
  ROLE_WAKE_FRAME,
  RoleConversationPort,
} from "../../src/mcp/role-conversation.ts";
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
  /** `unknown`, so a row can present a `p` tag of the wrong shape the way a relay could. */
  mention?: unknown;
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

/**
 * The same envelope with the `mention` key absent from the wire object rather than null.
 *
 * The two must be one thing to the signature — the daemon reads an absent field as null before it
 * computes the payload — and one thing to the address: a role-addressed envelope names nobody
 * either way. A row that only ever sent an explicit null would not show that.
 */
const omitMention = <T extends { mention?: unknown }>(sent: T): Omit<T, "mention"> => {
  const { mention: _absent, ...rest } = sent;
  return rest;
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

/** Deployment authentication for the real MCP sockets the production-composition row uses. */
const MCP_TOKEN = "buzz-message-ingress-mcp-token";

/** The production writer's authenticator; the relay policy vouches for every actor in a test. */
const anyBuzzActorIsAuthenticated = { isAllowedActor: () => true };

/** `p`-tag resolution has to see the roles a *live* session holds, so the session is READY. */
const readyBoundSession = (
  harness: ReturnType<typeof makeHarness>,
  model: string,
  mention: string,
  projectIds: readonly string[],
): { sessionId: string; incarnation: string; sessionSecret: string } => {
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
    sessionSecret: session.sessionSecret!,
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

/**
 * The `OWNER_MESSAGE` rows the role path enqueued, oldest first.
 *
 * The role route is a durable queue now rather than a push: what a role-addressed envelope
 * produces is one non-retargetable outbox row carrying a pointer, and its holder comes and takes
 * it over its own authenticated connection. `queuedOwnerMessages` is therefore the observable
 * these rows assert on, where they used to assert on a fake peer's `sampling/createMessage` calls.
 */
const queuedOwnerMessages = (harness: ReturnType<typeof makeHarness>) =>
  harness.cp.db.all<{
    message_id: string;
    status: string;
    role_key: string;
    target_session_id: string;
    payload_json: string;
  }>(
    `SELECT message_id, status, role_key, target_session_id, payload_json
       FROM outbox WHERE kind = 'OWNER_MESSAGE' ORDER BY created_at`,
    [],
  );

/** The one durable copy of an admitted envelope's text. */
const admittedText = (harness: ReturnType<typeof makeHarness>, eventId: string): string | null => {
  const row = harness.cp.db.get<{ payload_json: string | null }>(
    `SELECT payload_json FROM inbound_messages WHERE channel = 'buzz' AND nonce = ?`,
    [buzzMessageNonce(eventId)],
  );
  return row?.payload_json ? ((JSON.parse(row.payload_json) as { text?: string }).text ?? null) : null;
};

/** The `(buzz, nonce)` row for one event id, and the turn claim on it if any. */
const admittedRow = (harness: ReturnType<typeof makeHarness>, eventId: string) =>
  harness.cp.db.get<{ nonce: string; turn_claim_json: string | null }>(
    `SELECT nonce, turn_claim_json FROM inbound_messages WHERE channel = 'buzz' AND nonce = ?`,
    [buzzMessageNonce(eventId)],
  ) ?? null;

/** Waits on a condition the daemon reaches asynchronously, rather than on a fixed delay. */
const until = async (predicate: () => boolean, what: string, timeoutMs = 10_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
};

/**
 * A real client on the real `cto.mcp.sock`: credential line, MCP initialize, then it *asks* for
 * its own messages the way the runtime does.
 *
 * The route reversed direction in `#760` Q2: the daemon used to push the text over
 * `sampling/createMessage` and read the peer's reply as the acknowledgement, and this helper used
 * to stand up a peer that answered those. Nothing pushes now, so what a peer needs is the ability
 * to call one connection-bound tool. Shaped after `the-cto-socket-has-a-live-peer.test.ts`, which
 * owns the socket's own rows; nothing here re-measures them.
 */
interface ToolBody {
  ok: boolean;
  reasonCode: string;
  message?: string;
  value?: unknown;
}

const connectRolePeer = async (
  socketPath: string,
  credential: { token: string; sessionId: string; sessionSecret: string },
  /**
   * The client build this connection announces.
   *
   * Defaulted, because only one row needs a specific one: `role_wake_endpoint_register` is pinned
   * to the qualified 2.1.259 runtime, so the row that registers an endpoint has to arrive as that
   * build. Every other row is unaffected by what it says here, and passing the pin unconditionally
   * would have made those rows quietly depend on a version they never exercise.
   */
  clientInfo: { name: string; version: string } = { name: "buzz-role-peer", version: "1" },
): Promise<{
  socket: Socket;
  callTool: (name: string, args: Record<string, unknown>) => Promise<ToolBody>;
  close: () => Promise<void>;
}> => {
  const socket = createConnection(socketPath);
  const pending = new Map<number, (body: ToolBody) => void>();
  let nextId = 2;
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  let buffer = "";
  socket.on("error", () => {
    /* a peer whose socket is destroyed at teardown is not a failure this row asserts on */
  });
  socket.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim().length === 0) continue;
      let message: { id?: number; method?: string; result?: unknown };
      try {
        message = JSON.parse(line) as typeof message;
      } catch {
        continue;
      }
      if (message.method !== undefined || message.id === undefined) continue;
      const settle = pending.get(message.id);
      if (!settle) continue;
      pending.delete(message.id);
      const result = message.result as { structuredContent?: ToolBody } | undefined;
      settle(result?.structuredContent ?? { ok: false, reasonCode: ReasonCode.INTERNAL_ERROR });
    }
  });
  socket.write(
    `${JSON.stringify(credential)}\n${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo,
      },
    })}\n${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`,
  );
  return {
    socket,
    callTool: (name, args) =>
      new Promise<ToolBody>((resolveCall) => {
        const id = nextId++;
        pending.set(id, resolveCall);
        socket.write(
          `${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })}\n`,
        );
      }),
    close: () =>
      new Promise<void>((resolve) => {
        if (socket.destroyed) return resolve();
        socket.once("close", () => resolve());
        socket.destroy();
      }),
  };
};

/**
 * A live role peer for the rows that only need one to exist.
 *
 * It offers the two members `RoleConversationPort` reads off an SDK server — the object identity
 * `attach` keys its slot on, and the client version the wake pin checks — and nothing else. It
 * cannot receive anything, which is the point: after Q2 nothing is pushed to a peer at all.
 */
const fakeRolePeer = () =>
  ({
    server: {
      getClientVersion: () => ({ name: "claude-code", version: "2.1.259" }),
    },
  }) as never;

/**
 * The relay, as a thing this test hands frames to.
 *
 * No network and no `WebSocket`: the subscriber takes its socket factory as an argument precisely
 * so the composition rows can be about the daemon rather than about a relay being up.
 */
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
    /** The filter of the newest connection's `REQ`. */
    reqFilter: (): Record<string, unknown> => {
      const req = framesOf(live()).find((sent) => sent[0] === "REQ");
      if (!req) throw new Error("the subscriber sent no REQ");
      return req[2] as Record<string, unknown>;
    },
    /** NIP-42, then the subscription id the relay must answer on. */
    authenticateAndSubscribe: async (handle: { settled(): Promise<void> }): Promise<string> => {
      const socket = live();
      socket.handlers.onFrame(JSON.stringify(["AUTH", "relay-challenge"]));
      await handle.settled();
      const auth = framesOf(socket).at(-1) as [string, { id: string }];
      expect(auth[0]).toBe("AUTH");
      socket.handlers.onFrame(JSON.stringify(["OK", auth[1].id, true, ""]));
      await handle.settled();
      const req = framesOf(socket).find((sent) => sent[0] === "REQ") as [string, string, unknown];
      expect(req[0]).toBe("REQ");
      return req[1];
    },
  };
};

/** The reconnect clock, stepped rather than waited out. */
const steppedClock = () => {
  const timers = new Map<number, () => void>();
  let next = 1;
  const scheduler: BuzzSubscriberScheduler = {
    setTimer: (_ms, fire) => {
      const handle = next++;
      timers.set(handle, fire);
      return handle;
    },
    clearTimer: (handle) => {
      timers.delete(handle);
    },
  };
  return {
    scheduler,
    fireAll: (): void => {
      for (const [handle, fire] of [...timers]) {
        timers.delete(handle);
        fire();
      }
    },
  };
};

/** The socket a woken client binds for itself, and a record of the exact bytes that arrived. */
const listeningWakeEndpoint = async (
  path: string,
): Promise<{ path: string; received: string[]; close: () => Promise<void> }> => {
  const received: string[] = [];
  const server: Server = createServer((socket) => {
    let text = "";
    socket.on("data", (chunk: Buffer) => {
      text += chunk.toString();
    });
    socket.on("end", () => received.push(text));
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.removeListener("error", reject);
      resolveListen();
    });
  });
  return {
    path,
    received,
    close: () => new Promise<void>((resolveClose) => server.close(() => resolveClose())),
  };
};

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
      // an envelope the relay addressed to the CEO becomes one. Addressed elsewhere and carrying
      // no `p` tag, it names nobody — which is a refused address, never a fallback to the CEO.
      const journal = await exchangeSocketLines(
        listener.socketPath,
        [envelope({ eventId: "evt-journal", text: "CTO 보고", addressedTo: "CTO" })],
        hasReasonCode,
      );
      expect(JSON.parse(journal.trim())).toMatchObject({
        ok: false,
        reasonCode: ReasonCode.MENTION_TARGET_UNBOUND,
      });

      // The forged and unallowlisted envelopes above were refused by authentication, so neither
      // reached the address lookup: only the third one is in the journal.
      expect(unboundJournal(harness).map((row) => row.evidence["shape"])).toEqual(["missing"]);
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

  it("queues a `p`-tagged message for the role's holder, and keeps that address across a session replacement", async () => {
    const harness = makeHarness();
    const { projectId } = await registerFixtureProject(harness);
    const roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId });
    const first = readyBoundSession(harness, "cto-first", CTO_MENTION, [projectId]);

    const roleConversation = roleConversationFor(harness);
    roleConversation.attach(fakeRolePeer(), stillHeldBy(first));
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
      // Not `OK`: `OK` on this surface means the addressed peer answered, and nobody has. The
      // message is durable and addressed; that is the whole of what this seam observed.
      expect(JSON.parse(delivered.trim())).toMatchObject({
        ok: true,
        reasonCode: ReasonCode.UNTRUSTED_CONTENT_IS_DATA,
        answeredByCeo: false,
      });
      const queued = queuedOwnerMessages(harness);
      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({ status: "PENDING", role_key: roleKey, target_session_id: first.sessionId });
      // The address decided the recipient. Without this the row above would also pass on an
      // ingress that handed every message to the CEO, which is precisely the base behaviour.
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
      // Refused, and named for what it is. The turn claim this admission wrote is deliberately
      // *unresolved* while the outbox row is pending — that is what keeps `prune` off the one
      // durable copy the queued message points at — so a second copy of the event meets an
      // unsettled turn rather than a finished one. Both refuse; only this one tells an operator
      // that the message is still waiting to be taken. It becomes an ordinary
      // `INGRESS_REPLAY_IGNORED` once its holder settles it, which the end-to-end row shows.
      expect(JSON.parse(replay.trim())).toMatchObject({
        ok: false,
        reasonCode: ReasonCode.INGRESS_TURN_OUTCOME_UNKNOWN,
      });
      expect(queuedOwnerMessages(harness)).toHaveLength(1);

      // B0/B0b — the session holding the role is replaced, which is ordinary operation. The
      // sender's address is unchanged: the same `p` tag string, and nobody had to learn a new one.
      expect(harness.cp.bindings.revoke(roleKey, "test replacement").reasonCode).toBe(ReasonCode.OK);
      expect(
        harness.cp.sessions.transition(first.sessionId, SessionLifecycle.STOPPED, "test").reasonCode,
      ).toBe(ReasonCode.OK);
      const second = readyBoundSession(harness, "cto-second", CTO_MENTION, [projectId]);
      expect(second.sessionId).not.toBe(first.sessionId);
      roleConversation.attach(fakeRolePeer(), stillHeldBy(second));

      const afterReplacement = await exchangeSocketLines(
        listener.socketPath,
        [envelope({ eventId: "evt-cto-2", text: "교체 후에도", addressedTo: "CTO", mention: CTO_MENTION })],
        hasReasonCode,
      );
      expect(JSON.parse(afterReplacement.trim())).toMatchObject({
        ok: true,
        reasonCode: ReasonCode.UNTRUSTED_CONTENT_IS_DATA,
      });
      // Addressed to the *new* runtime, under the new generation: the outbox row is fenced by the
      // holder the registry names at admission, not by the one that held the role when the
      // sender learned the address.
      const afterQueue = queuedOwnerMessages(harness);
      expect(afterQueue).toHaveLength(2);
      expect(afterQueue[1]).toMatchObject({ status: "PENDING", role_key: roleKey, target_session_id: second.sessionId });
      // And the first message is still exactly where it was — addressed to a runtime that has
      // gone, waiting for the sweep, never re-pointed at the replacement.
      expect(afterQueue[0]?.target_session_id).toBe(first.sessionId);
    } finally {
      await listener.close();
    }
  });

  it("makes no turn and no delivery for a `p` tag that is missing, null, not a string, blank, unknown, or ambiguous", async () => {
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

    // Every way a role-addressed envelope can fail to name one reachable role. All five are one
    // outcome to the sender and one journal row each — the socket-boundary shapes included, so a
    // relay that stopped attaching tags, or attached one of the wrong type, is visible rather
    // than being reported as a malformed message or silently handed to the CEO.
    const rows: readonly { label: string; eventId: string; shape: string; wire: unknown }[] = [
      {
        label: "no mention key on the wire at all",
        eventId: "evt-missing",
        shape: "missing",
        wire: omitMention(envelope({ eventId: "evt-missing", text: "누구에게도", addressedTo: "CTO" })),
      },
      {
        label: "an explicit null mention",
        eventId: "evt-null",
        shape: "missing",
        wire: envelope({ eventId: "evt-null", text: "누구에게도", addressedTo: "CTO", mention: null }),
      },
      {
        label: "a mention that is a number, not a channel identity",
        eventId: "evt-number",
        shape: "not-a-string",
        wire: envelope({ eventId: "evt-number", text: "누구에게도", addressedTo: "CTO", mention: 42 }),
      },
      {
        label: "a mention that is a list, not a channel identity",
        eventId: "evt-array",
        shape: "not-a-string",
        wire: envelope({
          eventId: "evt-array",
          text: "누구에게도",
          addressedTo: "CTO",
          mention: ["npub-cto-of-two"],
        }),
      },
      {
        label: "present but empty",
        eventId: "evt-empty",
        shape: "blank",
        wire: envelope({ eventId: "evt-empty", text: "누구에게도", addressedTo: "CTO", mention: "   " }),
      },
      {
        label: "bound to nobody",
        eventId: "evt-unbound",
        shape: "unknown",
        wire: envelope({
          eventId: "evt-unbound",
          text: "누구에게도",
          addressedTo: "CTO",
          mention: "npub-nobody-holds-this",
        }),
      },
      {
        label: "bound to two roles at once",
        eventId: "evt-ambiguous",
        shape: "ambiguous",
        wire: envelope({
          eventId: "evt-ambiguous",
          text: "누구에게도",
          addressedTo: "CTO",
          mention: "npub-cto-of-two",
        }),
      },
    ];

    try {
      for (const [index, row] of rows.entries()) {
        const refused = await exchangeSocketLines(listener.socketPath, [row.wire], hasReasonCode);
        expect(JSON.parse(refused.trim()), row.label).toMatchObject({
          ok: false,
          reasonCode: ReasonCode.MENTION_TARGET_UNBOUND,
        });

        // No turn. The envelope authenticated, so its replay slot is spent — that is what stops a
        // resent copy from journalling twice — but nothing claimed a turn against it, which is
        // the fact `unresolvedTurns` reads and the one that decides whether anyone was asked.
        const admitted = admittedRow(harness, row.eventId);
        expect(admitted, row.label).not.toBeNull();
        expect(admitted?.turn_claim_json, row.label).toBeNull();
        // No delivery, anywhere. The CEO in particular is not the fallback recipient for a
        // message this daemon could not address.
        expect(ceo.peer.calls, row.label).toEqual([]);
        expect(sessionIds(harness), row.label).toEqual(before);
        // Exactly one journal row per refused envelope — not zero, which is the silence #760
        // opens with, and not two.
        expect(unboundJournal(harness).length, row.label).toBe(index + 1);
      }

      const journalled = unboundJournal(harness);
      expect(journalled.map((row) => row.kind)).toEqual(rows.map(() => "BUZZ_MENTION_TARGET_UNBOUND"));
      expect(journalled.map((row) => row.evidence["shape"])).toEqual(rows.map((row) => row.shape));
      expect(journalled.at(-2)?.evidence).toMatchObject({
        channel: "buzz",
        target: "npub-nobody-holds-this",
        candidates: 0,
      });
      expect(journalled.at(-1)?.evidence).toMatchObject({ target: "npub-cto-of-two", candidates: 2 });

      // The permitted absent mention, unchanged: the CEO room is addressed by `addressedTo` and
      // has no `p` tag on this path, so a CEO envelope with none is delivered and journals
      // nothing. Without this the rows above would also pass on an ingress that refused every
      // envelope carrying no tag.
      const toCeo = await exchangeSocketLines(
        listener.socketPath,
        [omitMention(envelope({ eventId: "evt-ceo-no-mention", text: "CEO, 상태" }))],
        hasReasonCode,
      );
      expect(JSON.parse(toCeo.trim())).toMatchObject({ ok: true, reasonCode: ReasonCode.OK });
      expect(ceo.peer.calls).toEqual(["CEO, 상태"]);
      expect(unboundJournal(harness).length).toBe(rows.length);
    } finally {
      await listener.close();
    }
  });

  it("authenticates the sender and rejects the replay before it looks up any target", async () => {
    const harness = makeHarness();
    const { projectId } = await registerFixtureProject(harness);
    const session = readyBoundSession(harness, "cto-peer", CTO_MENTION, [projectId]);
    const roleConversation = roleConversationFor(harness);
    roleConversation.attach(fakeRolePeer(), stillHeldBy(session));
    const listener = await startMessageListener(harness, new CeoConversationPort(), roleConversation);

    try {
      // A configured owner string is not authentication. Signature verification is the authority
      // and it runs first, so an unknown `p` tag behind a forged signature never reaches the
      // lookup — no journal row, and no `(buzz, nonce)` row for the owner's real event to
      // collide with later.
      const forged = await exchangeSocketLines(
        listener.socketPath,
        [
          {
            ...envelope({
              eventId: "evt-auth-order",
              text: "위조",
              addressedTo: "CTO",
              mention: "npub-nobody-holds-this",
            }),
            signature: "forged",
          },
        ],
        hasReasonCode,
      );
      expect(JSON.parse(forged.trim())).toMatchObject({
        ok: false,
        reasonCode: ReasonCode.INGRESS_SIGNATURE_INVALID,
      });
      expect(unboundJournal(harness)).toEqual([]);
      expect(admittedRow(harness, "evt-auth-order")).toBeNull();

      // The owner's real event, same id, admitted and queued.
      const delivered = await exchangeSocketLines(
        listener.socketPath,
        [envelope({ eventId: "evt-auth-order", text: "CTO, 상태", addressedTo: "CTO", mention: CTO_MENTION })],
        hasReasonCode,
      );
      expect(JSON.parse(delivered.trim())).toMatchObject({
        ok: true,
        reasonCode: ReasonCode.UNTRUSTED_CONTENT_IS_DATA,
      });
      expect(queuedOwnerMessages(harness)).toHaveLength(1);
      expect(admittedText(harness, "evt-auth-order")).toBe("CTO, 상태");
      expect(unboundJournal(harness)).toEqual([]);

      // The same event id again with the `p` tag rewritten to one that resolves to nobody. The
      // event id is the replay key and it is spent, so this is refused whatever its tag now says:
      // rejected before the lookup, so the admitted turn gains no second target side effect and
      // nothing is enqueued a second time. The code names the queued message's turn as still
      // unsettled rather than as a finished replay — see the row above — and what this row
      // measures is that the refusal happens *before* the address is consulted, which the empty
      // journal is the observable for.
      const rewritten = await exchangeSocketLines(
        listener.socketPath,
        [
          envelope({
            eventId: "evt-auth-order",
            text: "CTO, 상태",
            addressedTo: "CTO",
            mention: "npub-nobody-holds-this",
          }),
        ],
        hasReasonCode,
      );
      expect(JSON.parse(rewritten.trim())).toMatchObject({
        ok: false,
        reasonCode: ReasonCode.INGRESS_TURN_OUTCOME_UNKNOWN,
      });
      expect(unboundJournal(harness)).toEqual([]);
      // Still one queued message, so the replay produced no second one.
      expect(queuedOwnerMessages(harness)).toHaveLength(1);

      // And a repeated *unbound* event journals once, not once per copy. The first is refused at
      // the address and the second at the replay slot, which is the only reason the count stops.
      const unbound = () =>
        exchangeSocketLines(
          listener.socketPath,
          [
            envelope({
              eventId: "evt-unbound-twice",
              text: "누구에게도",
              addressedTo: "CTO",
              mention: "npub-nobody-holds-this",
            }),
          ],
          hasReasonCode,
        );
      expect(JSON.parse((await unbound()).trim())).toMatchObject({
        ok: false,
        reasonCode: ReasonCode.MENTION_TARGET_UNBOUND,
      });
      expect(unboundJournal(harness).length).toBe(1);
      expect(JSON.parse((await unbound()).trim())).toMatchObject({
        ok: false,
        reasonCode: ReasonCode.INGRESS_REPLAY_IGNORED,
      });
      expect(unboundJournal(harness).length).toBe(1);
    } finally {
      await listener.close();
    }
  });

  it("refuses a mention substituted into a validly signed CEO envelope", async () => {
    const harness = makeHarness();
    bindCeo(harness);
    const { projectId } = await registerFixtureProject(harness);
    const session = readyBoundSession(harness, "cto-peer", CTO_MENTION, [projectId]);
    const roleConversation = roleConversationFor(harness);
    const rolePeer = fakeCeoPeer("CTO는 이걸 받으면 안 된다");
    roleConversation.attach(rolePeer.server, stillHeldBy(session));
    const ceo = fakeCeoPeer("CEO 답");
    const ceoConversation = new CeoConversationPort();
    ceoConversation.attach(ceo.server, stillCeo());
    const listener = await startMessageListener(harness, ceoConversation, roleConversation);

    try {
      // A genuine CEO envelope, captured whole. Its signature is not recomputed below — the same
      // bytes travel, and only the `p` tag is substituted, which is exactly what an attacker who
      // captured one off the wire can do. It is refused because `mention` is inside the signed
      // payload; take it out of that payload and this envelope verifies and is delivered.
      const captured = envelope({ eventId: "evt-substituted", text: "CEO, 상태" });
      const tampered = { ...captured, mention: CTO_MENTION };
      expect(tampered.signature).toBe(captured.signature);

      const refused = await exchangeSocketLines(listener.socketPath, [tampered], hasReasonCode);
      expect(JSON.parse(refused.trim())).toMatchObject({
        ok: false,
        reasonCode: ReasonCode.INGRESS_SIGNATURE_INVALID,
      });
      expect(unboundJournal(harness)).toEqual([]);
      expect(admittedRow(harness, "evt-substituted")).toBeNull();
      expect(rolePeer.peer.calls).toEqual([]);
      expect(ceo.peer.calls).toEqual([]);
    } finally {
      await listener.close();
    }
  });

  it("carries an owner's message end to end through the daemon's own composition, and the peer takes it", async () => {
    const harness = makeHarness();
    const { projectId } = await registerFixtureProject(harness);
    const roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId });
    const session = readyBoundSession(harness, "cto-socket-peer", CTO_MENTION, [projectId]);

    // The real MCP listeners, the real `cto.mcp.sock`, and the real per-connection authenticator
    // — no port is constructed by this row. `startDaemonBuzzMessageIngress` is the composition
    // `main` itself calls, so the line that hands the ingress `listeners.ctoConversation` is
    // inside what this row can kill.
    const listeners = await startLocalMcpListeners(harness.cp, tempDir("acp-buzz-prod-mcp-"), MCP_TOKEN);
    const ctoSocket = listeners.socketPaths[1];
    if (!ctoSocket) throw new Error("the CTO MCP listener was not started");
    const peer = await connectRolePeer(ctoSocket, {
      token: MCP_TOKEN,
      sessionId: session.sessionId,
      sessionSecret: session.sessionSecret,
    });
    const ingress = await startDaemonBuzzMessageIngress(
      harness.cp,
      tempDir("acp-buzz-prod-"),
      { allowedActors: RELAY_ACTORS, secret: SECRET },
      listeners,
      [OWNER],
    );

    try {
      await until(
        () => listeners.ctoConversation.connected(roleKey),
        "the CTO connection to become the role's live peer",
      );

      const delivered = await exchangeSocketLines(
        ingress.socketPath,
        [envelope({ eventId: "evt-prod", text: "운영 경로로", addressedTo: "CTO", mention: CTO_MENTION })],
        hasReasonCode,
      );
      const body = JSON.parse(delivered.trim()) as { ok: boolean; reasonCode: string; answer?: string };
      // Queued, not answered — and the relay is told which, in the code and in the sentence.
      expect(body).toMatchObject({ ok: true, reasonCode: ReasonCode.UNTRUSTED_CONTENT_IS_DATA });
      expect(body.answer).toContain("Stored for the role");

      // The other half, over the connection the daemon itself admitted: the holder asks for its
      // own message by role key and is handed the owner's words. This is the row that joins the
      // two sockets — a fake peer handed to a port could not show that the ingress, the outbox and
      // the CTO socket are talking about the same message.
      const claimed = await peer.callTool("role_owner_message_claim", { roleKey });
      expect(claimed.ok, claimed.message).toBe(true);
      expect((claimed.value as { claimed?: { text?: string; messageId?: string } }).claimed?.text).toBe(
        "운영 경로로",
      );
      const messageId = (claimed.value as { claimed: { messageId: string } }).claimed.messageId;

      // And settling it closes both ledgers, through the same connection.
      const completed = await peer.callTool("role_owner_message_complete", { roleKey, messageId });
      expect(completed.ok, completed.message).toBe(true);
      expect(harness.cp.outbox.get(messageId)?.status).toBe("ACKED");
      expect(
        JSON.parse(admittedRow(harness, "evt-prod")!.turn_claim_json!) as { noReplyAt?: unknown },
      ).toMatchObject({ noReplyAt: expect.any(String) });
    } finally {
      await ingress.close();
      await peer.close();
      await listeners.close();
    }
  }, 60_000);

  /**
   * The front door, joined to the seam behind it (#760 Part C).
   *
   * Everything above this row starts at a local socket somebody else wrote to, which is exactly
   * what `#627` measured: the messages arrived because a person ran a CLI. This row starts one
   * step earlier — at a signed relay event — and runs the daemon's own composition all the way to
   * the holder settling it, so the thing under test is the *wiring*: `startDaemonBuzzMentionSubscriber`
   * is the function `main` calls, the ingress is the one `startDaemonBuzzMessageIngress` returned,
   * and the CTO socket is the real one. Nothing here constructs a port or a guard.
   *
   * The counts are the assertion. One relay event has to produce **one** of each durable thing,
   * and the inclusive redelivery that a reconnect necessarily causes has to produce **none** — by
   * the admission seam's own replay refusal, because this subscriber holds no dedup and no cursor
   * file to refuse it with.
   */
  it("carries one signed relay event through the daemon's own subscriber into one durable owner message, and a reconnect's replay adds nothing", async () => {
    const harness = makeHarness();
    const { projectId } = await registerFixtureProject(harness);
    const roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId });

    // Real keys, because the event's signature is the thing the subscriber verifies and a fixture
    // string could not be verified at all.
    const ctoKey = generateSecretKey();
    const ctoPubkey = getPublicKey(ctoKey);
    const ownerKey = generateSecretKey();
    const ownerPubkey = getPublicKey(ownerKey);

    const session = readyBoundSession(harness, "cto-relay-peer", ctoPubkey, [projectId]);

    const mcpStateDir = tempDir("acp-buzz-relay-mcp-");
    chmodSync(mcpStateDir, 0o700);
    const listeners = await startLocalMcpListeners(harness.cp, mcpStateDir, MCP_TOKEN);
    const ctoSocket = listeners.socketPaths[1];
    if (!ctoSocket) throw new Error("the CTO MCP listener was not started");
    const endpoint = await listeningWakeEndpoint(join(mcpStateDir, "cto.wake.sock"));
    const peer = await connectRolePeer(
      ctoSocket,
      { token: MCP_TOKEN, sessionId: session.sessionId, sessionSecret: session.sessionSecret },
      C0_QUALIFIED_CLIENT,
    );

    // One directory for both, the way `main` has one `stateDir`: the ingress socket and the
    // subscriber's config file live beside each other.
    const buzzStateDir = tempDir("acp-buzz-relay-");
    const keyFile = join(buzzStateDir, "cto.nostr.key");
    writeFileSync(keyFile, `${Buffer.from(ctoKey).toString("hex")}\n`, { mode: 0o600 });
    chmodSync(keyFile, 0o600);
    writeFileSync(
      join(buzzStateDir, BUZZ_SUBSCRIBER_CONFIG_FILENAME),
      JSON.stringify({
        relayUrl: "wss://relay.example.invalid/buzz",
        identities: [{ privateKeyFile: keyFile, encoding: "hex" }],
      }),
    );

    const ingress = await startDaemonBuzzMessageIngress(
      harness.cp,
      buzzStateDir,
      // The owner is the key that signs the event; the relay allowlist is wider, as in production.
      { allowedActors: [ownerPubkey, NON_OWNER], secret: SECRET },
      listeners,
      [ownerPubkey],
    );

    const relay = manualRelay();
    const clock = steppedClock();
    const subscriber = startDaemonBuzzMentionSubscriber(
      harness.cp,
      buzzStateDir,
      { allowedActors: [ownerPubkey, NON_OWNER], secret: SECRET },
      ingress,
      { openSocket: relay.factory, scheduler: clock.scheduler },
    );

    try {
      expect(subscriber.socketCount).toBe(1);
      expect(subscriber.roleKeys).toEqual([roleKey]);
      await until(
        () => listeners.ctoConversation.connected(roleKey),
        "the CTO connection to become the role's live peer",
      );
      const registered = await peer.callTool("role_wake_endpoint_register", {
        endpoint: endpoint.path,
      });
      expect(registered.ok, registered.message).toBe(true);
      // Registration's own unconditional drain, before the message exists. Counted here so the
      // wake this row is about is the *next* one rather than this one.
      await until(() => endpoint.received.length === 1, "the registration's unconditional wake");

      const event = finalizeEvent(
        {
          kind: 9,
          created_at: 1_800_500_000,
          tags: [
            ["p", ctoPubkey],
            ["h", "buzz-cto-room"],
          ],
          content: "릴레이로 들어온 지시",
        },
        ownerKey,
      );
      const subId = await relay.authenticateAndSubscribe(subscriber);
      relay.live().handlers.onFrame(JSON.stringify(["EVENT", subId, event]));
      await subscriber.settled();

      // One inbound row, holding the only durable copy of the words.
      expect(admittedText(harness, event.id)).toBe("릴레이로 들어온 지시");
      expect(
        harness.cp.db.all(`SELECT nonce FROM inbound_messages WHERE channel = 'buzz'`, []),
      ).toHaveLength(1);

      // One `OWNER_MESSAGE`, and a pointer rather than a copy — the digest is over the *full*
      // signed payload, so a rewritten address would not resolve to it.
      const queued = queuedOwnerMessages(harness);
      expect(queued).toHaveLength(1);
      const row = queued[0]!;
      expect(row.role_key).toBe(roleKey);
      expect(row.target_session_id).toBe(session.sessionId);
      expect(ownerMessagePointerOf(JSON.parse(row.payload_json) as unknown)).toEqual({
        sourceChannel: "buzz",
        sourceNonce: buzzMessageNonce(event.id),
        sourcePayloadDigest: digestOf(
          buzzMessagePayload({
            conversation: "buzz-cto-room",
            addressedTo: BUZZ_MENTION_ADDRESSED_TO,
            mention: ctoPubkey,
            text: "릴레이로 들어온 지시",
          }),
        ),
      });

      // One turn, and nobody has answered it.
      const claim = JSON.parse(admittedRow(harness, event.id)!.turn_claim_json!) as {
        turnRequestId: string;
        noReplyAt?: unknown;
      };
      expect(claim.turnRequestId).toBe(row.message_id);
      expect(claim.noReplyAt).toBeUndefined();

      // The exact wake, and nothing else on the endpoint. The frame is a version-pinned local
      // contract; a row that accepted any bytes would pass against a wake no real client reads.
      await until(() => endpoint.received.length === 2, "the wake this message's admission sends");
      expect(endpoint.received).toEqual([ROLE_WAKE_FRAME, ROLE_WAKE_FRAME]);

      // The holder takes it, once, over its own authenticated connection.
      const claimed = await peer.callTool("role_owner_message_claim", { roleKey });
      expect(claimed.ok, claimed.message).toBe(true);
      expect((claimed.value as { claimed?: { text?: string } }).claimed?.text).toBe(
        "릴레이로 들어온 지시",
      );
      const again = await peer.callTool("role_owner_message_claim", { roleKey });
      expect((again.value as { claimed?: unknown }).claimed ?? null).toBeNull();

      const completed = await peer.callTool("role_owner_message_complete", {
        roleKey,
        messageId: row.message_id,
      });
      expect(completed.ok, completed.message).toBe(true);
      expect(harness.cp.outbox.get(row.message_id)?.status).toBe("ACKED");
      expect(
        JSON.parse(admittedRow(harness, event.id)!.turn_claim_json!) as { noReplyAt?: unknown },
      ).toMatchObject({ noReplyAt: expect.any(String) });

      // The reconnect, and the redelivery it necessarily causes. `since` is inclusive, so the
      // relay sends this event again — and the admission seam refuses it. Nothing in the
      // subscriber refuses it, because nothing in the subscriber remembers it.
      relay.live().handlers.onClose();
      clock.fireAll();
      const resumed = await relay.authenticateAndSubscribe(subscriber);
      expect(relay.reqFilter()).toMatchObject({ since: 1_800_500_000 });
      relay.live().handlers.onFrame(JSON.stringify(["EVENT", resumed, event]));
      await subscriber.settled();

      expect(
        harness.cp.db.all(`SELECT nonce FROM inbound_messages WHERE channel = 'buzz'`, []),
      ).toHaveLength(1);
      expect(queuedOwnerMessages(harness).map((queuedRow) => queuedRow.message_id)).toEqual([
        row.message_id,
      ]);
      expect(harness.cp.outbox.get(row.message_id)?.status).toBe("ACKED");
      expect(endpoint.received).toEqual([ROLE_WAKE_FRAME, ROLE_WAKE_FRAME]);
    } finally {
      subscriber.close();
      await ingress.close();
      await peer.close();
      await endpoint.close();
      await listeners.close();
    }
  }, 60_000);

  it("does not let a resolvable mention stand in for owner authority", async () => {
    const harness = makeHarness();
    const { projectId } = await registerFixtureProject(harness);
    const session = readyBoundSession(harness, "cto-peer", CTO_MENTION, [projectId]);
    const roleConversation = roleConversationFor(harness);
    roleConversation.attach(fakeRolePeer(), stillHeldBy(session));
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
      expect(queuedOwnerMessages(harness)).toEqual([]);
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
      expect(JSON.parse(delivered.trim())).toMatchObject({
        ok: true,
        reasonCode: ReasonCode.UNTRUSTED_CONTENT_IS_DATA,
      });
      expect(queuedOwnerMessages(harness)).toHaveLength(1);
      expect(admittedText(harness, eventId)).toBe("CTO, 지금 멈춰");
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

  /**
   * The owner is told only the three things this seam observed: the message is durable, nobody has
   * read it, and what happened to the wake. Nothing about who takes it, or when.
   *
   * **Why this is not a list of forbidden phrases.** The previous round's acceptance was one row
   * asserting the text does not match `/next holder/iu`. The text was rewritten to avoid that
   * phrase — "its holder takes it over its own connection whenever it next attaches", "it takes the
   * message the next time it looks" — and kept the promise exactly. A blocklist tests one spelling
   * of one claim; the property is that *no* delivery promise is made, and a blocklist can never be
   * a test of that, because the next author's synonym is by construction not on the list.
   *
   * So the direction is inverted, and it is locked twice:
   *
   *   1. **Closed vocabulary.** Every word any sentence may use is enumerated below with the
   *      observation that licenses it, and a sentence containing anything else fails naming the
   *      word. A synonym reached for is a word not in the set, so it is caught by construction
   *      rather than by having been anticipated. The set is also closed under recombination: it
   *      contains no modal, no forward-looking temporal word and no verb of receipt, so no
   *      arrangement of these words can say that anyone will get the message.
   *   2. **The vocabulary itself is guarded.** The obvious way past (1) is to add the synonym to
   *      the vocabulary, so the vocabulary is asserted disjoint from the classes a delivery promise
   *      is built out of — modals, forward-looking time words, verbs of receipt and the actor nouns
   *      a promise needs a subject from. An author who widens the vocabulary to fit a promise fails
   *      here instead, and this assertion is about the *allow-list*, not about any one sentence, so
   *      it cannot be satisfied by rewording.
   *
   * Neither lock proves the semantic property — no assertion over strings can — but together they
   * make any new wording an explicit, visible widening of a justified vocabulary that is itself
   * checked against the vocabulary of a promise. The exact sentences are pinned as well, so a
   * rewrite has to come here and read this before it can be green.
   *
   * The behavioural half — that a takeover really does carry the queued message once, that a second
   * one closes it, and that a surviving runtime move carries it too — is measured in
   * `outbox-owner-message-holder.test.ts`. What is measured here is that no sentence claims it.
   */
  const OWNER_SENTENCE_VOCABULARY = new Set([
    // The durable fact.
    "stored",
    "for",
    "the",
    "role",
    // The unread fact, as a negative statement about the past: nobody has read it *yet*.
    "nobody",
    "has",
    "read",
    "it",
    "yet",
    // The observed wake outcome, in the past tense, and its three observed refusals.
    "a",
    "wake",
    "was",
    "sent",
    "to",
    "its",
    "registered",
    "peer",
    "no",
    "endpoint",
    "is",
    "attached",
    "so",
    "did",
    "not",
    "land",
    // Punctuation-free connective.
    "and",
  ]);

  /**
   * The words a delivery promise is made of. Not a blocklist over the sentences — the vocabulary
   * above already is — but a constraint on what may ever be *added* to that vocabulary.
   */
  const PROMISE_VOCABULARY = [
    // Modals and futures.
    "will", "shall", "would", "should", "can", "could", "may", "might", "going", "about",
    // Forward-looking time.
    "next", "later", "eventually", "soon", "whenever", "when", "once", "until", "future",
    "afterwards", "then", "upcoming", "pending", "await", "awaits", "awaiting",
    // Verbs of receipt and delivery.
    "take", "takes", "taken", "receive", "receives", "received", "get", "gets", "deliver",
    "delivers", "delivered", "delivery", "collect", "collects", "collected", "fetch", "fetches",
    "fetched", "pick", "picks", "picked", "reads", "sees", "looks", "attaches", "arrives",
    "reaches", "hands", "handed", "claims", "claimed", "consumes", "processes", "answers",
    // The subjects a promise needs.
    "holder", "holders", "successor", "successors", "whoever", "someone", "somebody", "recipient",
    "who", "they", "it's",
  ];

  const wordsOf = (sentence: string): string[] =>
    sentence
      .toLowerCase()
      .split(/[^a-z']+/u)
      .filter((word) => word.length > 0);

  it("tells the owner what is stored, using no word a delivery promise could be built from", () => {
    // Lock 1, first — every word of every sentence comes from the closed vocabulary, so a synonym
    // for a promise fails without anybody having had to guess which synonym. It is asserted before
    // the verbatim pins below so that a promise fails *as a promise*, naming the offending words,
    // rather than as a string that happens to differ from the one on record.
    const wakeOutcomes = [
      null,
      ReasonCode.ROLE_PEER_ABSENT,
      ReasonCode.ROLE_PEER_STALE,
      ReasonCode.ROLE_PEER_UNSUPPORTED,
      ReasonCode.ROLE_PEER_FAILED,
      // Not a wake code at all: the default arm must be as constrained as the named ones.
      ReasonCode.INTERNAL_ERROR,
    ];
    for (const wake of wakeOutcomes) {
      const sentence = ownerMessageQueuedSentence(wake);
      // The two facts every sentence must carry, whatever the wake did.
      expect(sentence).toContain("Stored for the role");
      expect(sentence).toContain("Nobody has read it yet");
      const foreign = wordsOf(sentence).filter((word) => !OWNER_SENTENCE_VOCABULARY.has(word));
      expect({ wake, foreign }).toEqual({ wake, foreign: [] });
    }

    // Lock 2 — and the vocabulary may not be widened into a promise. This is the assertion an
    // author reaching for a synonym hits *after* adding it to the set above.
    const promissory = PROMISE_VOCABULARY.filter((word) => OWNER_SENTENCE_VOCABULARY.has(word));
    expect(promissory).toEqual([]);

    // The exact sentences, pinned. Any rewrite at all has to come here and read the two locks.
    expect(ownerMessageQueuedSentence(null)).toBe(
      "Stored for the role, and a wake was sent to its registered peer. Nobody has read it yet.",
    );
    expect(ownerMessageQueuedSentence(ReasonCode.ROLE_PEER_ABSENT)).toBe(
      "Stored for the role. No peer is attached, so no wake was sent. Nobody has read it yet.",
    );
    expect(ownerMessageQueuedSentence(ReasonCode.ROLE_PEER_STALE)).toBe(
      "Stored for the role. No peer is attached, so no wake was sent. Nobody has read it yet.",
    );
    expect(ownerMessageQueuedSentence(ReasonCode.ROLE_PEER_UNSUPPORTED)).toBe(
      "Stored for the role. No wake endpoint is registered, so no wake was sent. Nobody has read it yet.",
    );
    expect(ownerMessageQueuedSentence(ReasonCode.ROLE_PEER_FAILED)).toBe(
      "Stored for the role. The wake did not land. Nobody has read it yet.",
    );

    // The branches stay distinct: the owner is told which of the four things happened to the wake,
    // and a collapse into one sentence would take that away.
    const distinct = new Set(
      [
        null,
        ReasonCode.ROLE_PEER_ABSENT,
        ReasonCode.ROLE_PEER_UNSUPPORTED,
        ReasonCode.ROLE_PEER_FAILED,
      ].map((wake) => ownerMessageQueuedSentence(wake)),
    );
    expect(distinct.size).toBe(4);
  });
});
