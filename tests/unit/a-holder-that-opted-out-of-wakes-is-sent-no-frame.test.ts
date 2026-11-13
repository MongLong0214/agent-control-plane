import { chmodSync } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { join } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

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
import { buzzMessageSigningRequest } from "../../src/ingress/buzz-message.ts";
import { ingressSignature } from "../../src/ingress/ingress-guard.ts";
import { CeoConversationPort } from "../../src/mcp/ceo-conversation.ts";
import { ROLE_WAKE_FRAME, WAKE_TRANSPORT_QUALIFIED_CLIENTS } from "../../src/mcp/role-conversation.ts";
import { MessageKind } from "../../src/outbox/envelope.ts";
import { SELF_CLAIM_EXECUTOR_KIND, SELF_CLAIM_PROTOCOL } from "../../src/registry/canonical-self-claim.ts";
import { channelKey, signedMention, steppedClock, storingRelay, writeSubscriberConfig } from "../helpers/buzz-mention-relay.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);
afterEach(() => vi.restoreAllMocks());

/**
 * The owner asked that `ACP-ROLE-WAKE` stop appearing in his Claude Code sessions. The wake is a
 * "look at your durable ingress" hint and nothing else, so the opt-out takes away the hint and
 * leaves the ingress alone: a holder that registered its endpoint with `wakeOptOut` is written no
 * frame for any cause — the registration's own, an in-band dispatch's, an owner message's and a
 * verified mention's — each suppressed wake is recorded as suppressed rather than failed, and every
 * message it was not woken for is still there to claim and settle.
 *
 * Driven through the CTO port exactly as the daemon builds it (`startDaemonMcpListeners`, with its
 * in-band wake), the daemon's Buzz message ingress over its own socket, and the daemon's mention
 * subscriber over a stored relay, against a test socket. A holder that registered without the
 * opt-out is the control: it is written exactly one frame per cause.
 */
const PROJECT = "wake-opt-out";
const ROOM = "room-wake-opt-out";
const CONVERSATION = "77777777-7777-4777-8777-777777777777";
const SECRET = "wake-opt-out-ingress-secret";
const CAUSES = ["registration", "in-band dispatch", "owner message", "mention"];

const listening = async (path: string): Promise<{ server: Server; frames: string[] }> => {
  const frames: string[] = [];
  const server = createServer((socket) => {
    let data = "";
    socket.on("data", (chunk) => {
      data += chunk.toString("utf8");
    });
    socket.on("end", () => frames.push(data));
  });
  await new Promise<void>((bound, failed) => {
    server.once("error", failed);
    server.listen(path, () => bound());
  });
  return { server, frames };
};

/** Long enough for a wake the port did send to land and be recorded. */
const quiet = async (): Promise<void> => {
  for (let turn = 0; turn < 50; turn += 1) await new Promise((tick) => setTimeout(tick, 1));
};

const settled = async (frames: string[], count: number): Promise<void> => {
  for (let attempt = 0; attempt < 2_000 && frames.length < count; attempt += 1) {
    await new Promise((tick) => setTimeout(tick, 1));
  }
};

const exchange = (socketPath: string, line: unknown): Promise<string> =>
  new Promise((resolveExchange, rejectExchange) => {
    const socket = createConnection(socketPath);
    let received = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify(line)}\n`));
    socket.on("data", (chunk: string) => {
      received += chunk;
      if (received.includes('"reasonCode"')) socket.end();
    });
    socket.once("error", rejectExchange);
    socket.once("close", () => resolveExchange(received));
  });

const secondsOf = (iso: string): number => Math.floor(Date.parse(iso) / 1000);

const start = async () => {
  const dir = tempDir("acp-wopt-");
  chmodSync(dir, 0o700);
  const cto = channelKey(dir, "cto.key");
  const owner = channelKey(dir, "owner.key");
  const h = makeHarness({ ownerIdentities: [{ channel: "buzz", actor: owner.pubkey }] });
  h.cp.db.run(`INSERT INTO projects (project_id, name, created_at) VALUES (?, ?, ?)`, [PROJECT, PROJECT, h.cp.clock.nowIso()]);
  const session = h.cp.sessions.create({ provider: "scripted", model: "cto", buzzAddress: ROOM });
  expect(h.cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "test").reasonCode).toBe(ReasonCode.OK);
  expect(h.cp.sessions.bindBuzzActor(
    { sessionId: session.sessionId, sessionSecret: session.sessionSecret!, buzzActorId: cto.pubkey },
    { isAllowedActor: () => true },
  ).allowed).toBe(true);
  // An adopted canonical CTO, so a dispatch is delivered in band and woken for.
  const claimed = { executorKind: SELF_CLAIM_EXECUTOR_KIND, targetLocator: CONVERSATION, targetLocatorDigest: sha256(CONVERSATION) };
  expect(h.cp.bindings.bind({
    role: Role.PRIMARY_CTO,
    sessionId: session.sessionId,
    projectId: PROJECT,
    authenticatedTarget: {
      claimed,
      protocolVersion: SELF_CLAIM_PROTOCOL,
      attestationDigest: digestOf({ fixture: "wake-opt-out", sessionId: session.sessionId }),
      verify: () => claimed,
    },
  }).allowed).toBe(true);
  const roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId: PROJECT });
  writeSubscriberConfig(dir, [{ keyFile: cto.keyFile, rooms: [ROOM] }]);
  const policy = { allowedActors: [owner.pubkey], secret: SECRET };
  const listeners = await startDaemonMcpListeners(h.cp, dir, "wake-opt-out-mcp-token", { finalizeApprovedRun: () => undefined });
  const ingress = await startBuzzMessageIngressListener(h.cp, dir, policy, {
    ceoConversation: new CeoConversationPort(),
    ownerActors: [owner.pubkey],
    roleConversation: listeners.ctoConversation,
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
  const server = new McpServer({ name: "wake-opt-out", version: "1" });
  vi.spyOn(server.server, "getClientVersion").mockReturnValue(WAKE_TRANSPORT_QUALIFIED_CLIENTS[0]);
  listeners.ctoConversation.attach(server, () => allow(ReasonCode.OK, {
    actor: holder.sessionId, sessionId: holder.sessionId, sessionIncarnation: holder.sessionIncarnation,
  }));
  const endpointPath = join(dir, "wake.sock");
  const endpoint = await listening(endpointPath);
  const audited = (kind: string) =>
    h.cp.db.all<{ reason_code: string; evidence_json: string }>(
      `SELECT reason_code, evidence_json FROM audit_events WHERE kind = ? ORDER BY rowid`,
      [kind],
    ).map((row): Record<string, unknown> => ({ reasonCode: row.reason_code, ...(JSON.parse(row.evidence_json) as Record<string, unknown>) }));
  const causesOf = (kind: string) => audited(kind).map((row) => row["cause"]);
  const dispatch = (idempotencyKey: string) =>
    h.cp.outbox.enqueue({
      idempotencyKey,
      roleKey,
      bindingGeneration: holder.bindingGeneration,
      targetSessionId: holder.sessionId,
      runId: null,
      kind: MessageKind.DRAIN_REQUEST,
      payload: { projectId: PROJECT },
    });
  const ownerMessage = async (eventId: string, text: string) => {
    const message = { actor: owner.pubkey, conversation: ROOM, eventId, addressedTo: "CTO", mention: cto.pubkey, text };
    const answer = await exchange(ingress.socketPath, {
      ...message,
      signature: ingressSignature(SECRET, buzzMessageSigningRequest(message)),
    });
    return JSON.parse(answer.trim()) as { ok: boolean; reasonCode: string };
  };
  const mention = async (text: string) => {
    h.clock.advance(1_000);
    relay.publish(signedMention({ author: owner.secretKey, addressedTo: cto.pubkey, room: ROOM, createdAt: secondsOf(h.cp.clock.nowIso()), text }));
    await relay.drain(subscriber);
  };
  const ownerMessages = () =>
    h.cp.db.all<{ status: string }>(`SELECT status FROM outbox WHERE kind = ? AND role_key = ? ORDER BY rowid`, [MessageKind.OWNER_MESSAGE, roleKey])
      .map((row) => row.status);
  return {
    h,
    roleKey,
    holder,
    listeners,
    server,
    endpointPath,
    endpoint,
    audited,
    causesOf,
    dispatch,
    ownerMessage,
    mention,
    ownerMessages,
    close: async () => {
      await new Promise<void>((resolve) => endpoint.server.close(() => resolve()));
      subscriber.close();
      await ingress.close();
      await listeners.close();
      h.cp.close();
    },
  };
};

type Fixture = Awaited<ReturnType<typeof start>>;

/**
 * One wake of each cause, in order. A dispatch is queued before the registration, so the
 * registration has confirmed work and reaches the wake rather than being skipped (FIX-ROLE-WAKE);
 * that dispatch's own wake is refused for want of an endpoint, as it is today.
 */
const everyCause = async (f: Fixture, wakeOptOut: boolean): Promise<void> => {
  expect(f.dispatch("drain-before-registration").allowed).toBe(true);
  await quiet();
  expect(f.endpoint.frames).toEqual([]);
  const registered = await f.listeners.ctoConversation.registerEndpoint(f.server, f.endpointPath, undefined, wakeOptOut);
  expect(registered.reasonCode).toBe(ReasonCode.OK);
  expect(f.listeners.ctoConversation.endpointFor(f.roleKey)).toBe(f.endpointPath);
  if (!wakeOptOut) await settled(f.endpoint.frames, 1);
  await quiet();
  expect(f.dispatch("drain-after-registration").allowed).toBe(true);
  if (!wakeOptOut) await settled(f.endpoint.frames, 2);
  await quiet();
  const queued = await f.ownerMessage("evt-owner-message", "an owner message");
  expect(queued).toMatchObject({ ok: true, reasonCode: ReasonCode.UNTRUSTED_CONTENT_IS_DATA });
  if (!wakeOptOut) await settled(f.endpoint.frames, 3);
  await quiet();
  await f.mention("a verified mention");
  if (!wakeOptOut) await settled(f.endpoint.frames, 4);
  await quiet();
};

/** The ingress is untouched: both dispatches and both owner messages are pending, claimable and settleable. */
const ingressStillWorks = (f: Fixture): void => {
  const { sessionId, sessionIncarnation } = f.holder;
  const dispatches = f.h.cp.outbox.pendingInBandFor(sessionId, sessionIncarnation);
  expect(dispatches).toHaveLength(2);
  expect(f.ownerMessages()).toEqual(["PENDING", "PENDING"]);
  for (const text of ["an owner message", "a verified mention"]) {
    const handover = f.listeners.ctoConversation.claimOwnerMessage(f.server, f.roleKey);
    expect(handover.allowed).toBe(true);
    const claimed = handover.allowed ? handover.value.claimed : null;
    expect(claimed?.text).toBe(text);
    const completed = f.listeners.ctoConversation.completeOwnerMessage(f.server, f.roleKey, claimed!.messageId);
    expect(completed.allowed).toBe(true);
  }
  expect(f.ownerMessages()).toEqual(["ACKED", "ACKED"]);
  for (const row of dispatches) {
    const acknowledged = f.h.cp.outbox.acknowledgeInBand(row.messageId, sessionId, sessionIncarnation);
    expect(acknowledged.allowed).toBe(true);
  }
  expect(f.h.cp.outbox.pendingInBandFor(sessionId, sessionIncarnation)).toEqual([]);
};

describe("a holder that opted out of wake frames is written none, and its ingress is untouched", () => {
  it("writes no frame for any cause to a registration that opted out, and records each wake as suppressed", async () => {
    const f = await start();
    try {
      await everyCause(f, true);
      expect(f.endpoint.frames).toEqual([]);
      expect(f.causesOf("ROLE_WAKE_SENT")).toEqual([]);
      expect(f.audited("ROLE_WAKE_SUPPRESSED")).toEqual(CAUSES.map((cause) => ({
        reasonCode: ReasonCode.ROLE_WAKE_SUPPRESSED,
        cause,
        suppressedBy: "holder-opt-out",
      })));
      // Only the dispatch queued before any endpoint existed failed, as it does without the opt-out:
      // a suppressed wake is not recorded as a failed one.
      expect(f.audited("ROLE_WAKE_FAILED")).toEqual([
        { reasonCode: ReasonCode.ROLE_PEER_UNSUPPORTED, cause: "in-band dispatch" },
      ]);
      ingressStillWorks(f);
    } finally {
      await f.close();
    }
  });

  it("still writes exactly one frame per cause to a registration that did not opt out", async () => {
    const f = await start();
    try {
      await everyCause(f, false);
      expect(f.endpoint.frames).toEqual(CAUSES.map(() => ROLE_WAKE_FRAME));
      expect(f.causesOf("ROLE_WAKE_SENT")).toEqual(CAUSES);
      expect(f.audited("ROLE_WAKE_SUPPRESSED")).toEqual([]);
      expect(f.audited("ROLE_WAKE_FAILED")).toEqual([
        { reasonCode: ReasonCode.ROLE_PEER_UNSUPPORTED, cause: "in-band dispatch" },
      ]);
      ingressStillWorks(f);
    } finally {
      await f.close();
    }
  });

  it("is undone by the holder's next registration without the opt-out, and is the registration's alone", async () => {
    const f = await start();
    try {
      expect((await f.listeners.ctoConversation.registerEndpoint(f.server, f.endpointPath, undefined, true)).allowed).toBe(true);
      expect(f.dispatch("drain-opted-out").allowed).toBe(true);
      await quiet();
      expect(f.endpoint.frames).toEqual([]);
      // The next registration says nothing about wakes, so it is woken again: the opt-out lives on
      // the registration in force and on nothing that outlives it.
      expect((await f.listeners.ctoConversation.registerEndpoint(f.server, f.endpointPath)).allowed).toBe(true);
      await settled(f.endpoint.frames, 1);
      expect(f.endpoint.frames).toEqual([ROLE_WAKE_FRAME]);
      expect(f.causesOf("ROLE_WAKE_SUPPRESSED")).toEqual(["in-band dispatch"]);
      await vi.waitFor(() => expect(f.causesOf("ROLE_WAKE_SENT")).toEqual(["registration"]));
    } finally {
      await f.close();
    }
  });
});
