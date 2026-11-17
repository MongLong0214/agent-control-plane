import { chmodSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterAll, describe, expect, it } from "vitest";

import { digestOf, sha256 } from "../../src/core/digest.ts";
import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import {
  rejudgeBuzzMentionSubscriberOnBindingSwitch,
  startBuzzMessageIngressListener,
  startDaemonBuzzMentionSubscriber,
  startDaemonMcpListeners,
} from "../../src/daemon/agentcpd.ts";
import { Role, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { CeoConversationPort } from "../../src/mcp/ceo-conversation.ts";
import { IN_BAND_KINDS } from "../../src/outbox/outbox.ts";
import { SELF_CLAIM_EXECUTOR_KIND, SELF_CLAIM_PROTOCOL } from "../../src/registry/canonical-self-claim.ts";
import { channelKey, signedMention, steppedClock, storingRelay, writeSubscriberConfig } from "../helpers/buzz-mention-relay.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * No daemon path writes a wake frame into a CTO session.
 *
 * The CTO session reads its mail itself: a message admitted for its role waits in the durable outbox
 * and is taken with `role_owner_message_claim`. Nothing is knocked on, so a socket standing where a
 * wake endpoint used to be registered is never connected to, whatever admits work for the role.
 */

const PROJECT = "repo-factory";
const ROOM = "room-repo-factory";
const CONVERSATION = "44444444-4444-4444-8444-444444444444";
const secondsOf = (iso: string): number => Math.floor(Date.parse(iso) / 1000);
const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 40; turn += 1) await new Promise((tick) => setImmediate(tick));
};

/** A socket that records every byte and every connection it is given. */
const recordingSocket = async (path: string) => {
  const received = { connections: 0, bytes: "" };
  const server: Server = createServer((socket) => {
    received.connections += 1;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => { received.bytes += chunk; });
    socket.on("error", () => undefined);
  });
  await new Promise<void>((bound, failed) => {
    server.once("error", failed);
    server.listen(path, () => { server.removeListener("error", failed); bound(); });
  });
  return { server, received };
};

const start = async () => {
  const dir = tempDir("acp-nowake-");
  chmodSync(dir, 0o700);
  const cto = channelKey(dir, "cto.key");
  const owner = channelKey(dir, "owner.key");
  const h = makeHarness({ ownerIdentities: [{ channel: "buzz", actor: owner.pubkey }] });
  const roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId: PROJECT });
  h.cp.db.run(`INSERT INTO projects (project_id, name, created_at) VALUES (?, ?, ?)`, [PROJECT, PROJECT, h.cp.clock.nowIso()]);
  const session = h.cp.sessions.create({ provider: "scripted", model: "cto", buzzAddress: ROOM });
  expect(h.cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "test").reasonCode).toBe(ReasonCode.OK);
  expect(h.cp.sessions.bindBuzzActor(
    { sessionId: session.sessionId, sessionSecret: session.sessionSecret!, buzzActorId: cto.pubkey },
    { isAllowedActor: () => true },
  ).allowed).toBe(true);
  const claimed = { executorKind: SELF_CLAIM_EXECUTOR_KIND, targetLocator: CONVERSATION, targetLocatorDigest: sha256(CONVERSATION) };
  expect(h.cp.bindings.bind({
    role: Role.PRIMARY_CTO,
    sessionId: session.sessionId,
    projectId: PROJECT,
    authenticatedTarget: {
      claimed,
      protocolVersion: SELF_CLAIM_PROTOCOL,
      attestationDigest: digestOf({ fixture: "no-wake", sessionId: session.sessionId }),
      verify: () => claimed,
    },
  }).allowed).toBe(true);
  writeSubscriberConfig(dir, [{ keyFile: cto.keyFile, rooms: [ROOM] }]);
  const policy = { allowedActors: [owner.pubkey], secret: "no-wake-secret" };
  const listeners = await startDaemonMcpListeners(h.cp, dir, "no-wake-mcp-token", { finalizeApprovedRun: () => undefined });
  const conversation = listeners.ctoConversation;
  const ingress = await startBuzzMessageIngressListener(h.cp, dir, policy, {
    ceoConversation: new CeoConversationPort(),
    ownerActors: [owner.pubkey],
    roleConversation: conversation,
  });
  const relay = storingRelay();
  const subscriber = startDaemonBuzzMentionSubscriber(h.cp, dir, policy, ingress, {
    openSocket: relay.factory,
    scheduler: steppedClock().scheduler,
    reportAdmission: () => undefined,
  });
  rejudgeBuzzMentionSubscriberOnBindingSwitch(h.cp, () => subscriber);
  await relay.drain(subscriber);

  const holder = h.cp.bindings.active(roleKey)!;
  const server = new McpServer({ name: "no-wake", version: "1" });
  conversation.attach(server, () => allow(ReasonCode.OK, {
    actor: holder.sessionId, sessionId: holder.sessionId, sessionIncarnation: holder.sessionIncarnation,
  }));
  // The socket a client would have registered as its wake endpoint. Where an older composition still
  // offers a registration it is made, so that this holds on both sides of the removal.
  const endpoint = await recordingSocket(join(dir, "wake.sock"));
  const registerEndpoint = (conversation as unknown as {
    registerEndpoint?: (server: McpServer, endpoint: string) => Promise<unknown>;
  }).registerEndpoint;
  await registerEndpoint?.call(conversation, server, join(dir, "wake.sock"));
  return {
    h, dir, cto, owner, roleKey, holder, relay, subscriber, conversation, server, received: endpoint.received,
    close: async () => {
      await new Promise<void>((resolve) => endpoint.server.close(() => resolve()));
      subscriber.close();
      await ingress.close();
      await listeners.close();
      h.cp.close();
    },
  };
};

describe("no wake frame is ever written into a CTO session", () => {
  it("an owner's Buzz mention is admitted and claimable, and its endpoint is never connected to", async () => {
    const f = await start();
    try {
      f.h.clock.advance(1_000);
      f.relay.publish(signedMention({
        author: f.owner.secretKey, addressedTo: f.cto.pubkey, room: ROOM,
        createdAt: secondsOf(f.h.cp.clock.nowIso()), text: "please look at the release branch",
      }));
      await f.relay.drain(f.subscriber);
      await settle();
      expect(f.received).toEqual({ connections: 0, bytes: "" });
      expect(f.conversation.claimOwnerMessage(f.server, f.roleKey)).toMatchObject({
        allowed: true,
        value: { claimed: { principal: "owner", text: "please look at the release branch" } },
      });
    } finally {
      await f.close();
    }
  });

  it.each([...IN_BAND_KINDS])("in-band %s work for the holder writes nothing to its endpoint", async (kind) => {
    const f = await start();
    try {
      expect(f.h.cp.outbox.enqueue({
        idempotencyKey: `no-wake-${kind}`, roleKey: f.roleKey, bindingGeneration: f.holder.bindingGeneration,
        targetSessionId: f.holder.sessionId, runId: null, kind, payload: { projectId: PROJECT, reason: "role work" },
      }).allowed).toBe(true);
      await settle();
      expect(f.received).toEqual({ connections: 0, bytes: "" });
      expect(f.h.cp.outbox.pendingInBandFor(f.holder.sessionId, f.holder.sessionIncarnation)).toHaveLength(1);
    } finally {
      await f.close();
    }
  });

  it("a second connection that attaches with mail waiting is sent nothing either", async () => {
    const f = await start();
    try {
      f.h.clock.advance(1_000);
      f.relay.publish(signedMention({
        author: f.owner.secretKey, addressedTo: f.cto.pubkey, room: ROOM,
        createdAt: secondsOf(f.h.cp.clock.nowIso()), text: "waiting for the next connection",
      }));
      await f.relay.drain(f.subscriber);
      const again = new McpServer({ name: "no-wake-2", version: "1" });
      f.conversation.attach(again, () => allow(ReasonCode.OK, {
        actor: f.holder.sessionId, sessionId: f.holder.sessionId, sessionIncarnation: f.holder.sessionIncarnation,
      }));
      const register = (f.conversation as unknown as {
        registerEndpoint?: (server: McpServer, endpoint: string) => Promise<unknown>;
      }).registerEndpoint;
      await register?.call(f.conversation, again, join(f.dir, "wake.sock"));
      await settle();
      expect(f.received).toEqual({ connections: 0, bytes: "" });
    } finally {
      await f.close();
    }
  });
});
