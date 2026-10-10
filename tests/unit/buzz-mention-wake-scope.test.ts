import { chmodSync } from "node:fs";
import type * as NodeNet from "node:net";
import { createServer, type Server } from "node:net";
import { join } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterAll, describe, expect, it, vi } from "vitest";

import type { BuzzMentionEvent } from "../../src/buzz/buzz-mention-subscriber.ts";
import { digestOf, sha256 } from "../../src/core/digest.ts";
import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import {
  buzzMentionInputFor,
  rejudgeBuzzMentionSubscriberOnBindingSwitch,
  startBuzzMessageIngressListener,
  startDaemonBuzzMentionSubscriber,
  startDaemonMcpListeners,
} from "../../src/daemon/agentcpd.ts";
import { Role, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { deliverBuzzMessage } from "../../src/ingress/buzz-message.ts";
import { CeoConversationPort } from "../../src/mcp/ceo-conversation.ts";
import { ROLE_WAKE_FRAME, WAKE_TRANSPORT_QUALIFIED_CLIENTS } from "../../src/mcp/role-conversation.ts";
import { IN_BAND_KINDS } from "../../src/outbox/outbox.ts";
import { SELF_CLAIM_EXECUTOR_KIND, SELF_CLAIM_PROTOCOL } from "../../src/registry/canonical-self-claim.ts";
import { channelKey, signedMention, steppedClock, storingRelay, writeSubscriberConfig } from "../helpers/buzz-mention-relay.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * Which wakes the mention gate governs (1080-N3-01, N3-02).
 *
 * The gate on a mention's identity, role and room applies to a wake only when the daemon's own
 * subscriber delivered a mention and that delivery's verified context rides with it. In-band work,
 * a peer turn from the local socket and a registration's drain keep the current-holder check
 * alone, and a holder no configured identity stands behind is judged by itself, not by a former
 * identity's role pin. Each row runs the daemon-built CTO port; only the wake connection's
 * completion is held.
 */

const wakes = vi.hoisted(() => {
  class PendingWake {
    readonly listeners = new Map<string, (argument?: unknown) => void>();
    frame: string | null = null;
    destroyed = false;
    #flushed: (() => void) | null = null;
    setTimeout(): this {
      return this;
    }
    once(event: string, listener: (argument?: unknown) => void): this {
      this.listeners.set(event, listener);
      return this;
    }
    end(frame: string, flushed: () => void): this {
      this.frame = frame;
      this.#flushed = flushed;
      return this;
    }
    destroy(): this {
      this.destroyed = true;
      return this;
    }
    succeed(): void {
      this.listeners.get("connect")?.();
      this.#flushed?.();
    }
    refuse(): void {
      const error: NodeJS.ErrnoException = new Error("connect ECONNREFUSED");
      error.code = "ECONNREFUSED";
      this.listeners.get("error")?.(error);
    }
  }
  const dialled: PendingWake[] = [];
  return { dialled, open: () => dialled[dialled.push(new PendingWake()) - 1]! };
});

vi.mock("node:net", async (importOriginal) => ({
  ...(await importOriginal<typeof NodeNet>()),
  connect: () => wakes.open(),
}));

const PROJECT = "repo-factory";
const ROOM = "room-repo-factory";
const CONVERSATION = "44444444-4444-4444-8444-444444444444";
const secondsOf = (iso: string): number => Math.floor(Date.parse(iso) / 1000);

const socketAt = async (path: string): Promise<Server> => {
  const server = createServer();
  await new Promise<void>((bound, failed) => {
    server.once("error", failed);
    server.listen(path, () => {
      server.removeListener("error", failed);
      bound();
    });
  });
  return server;
};

/** Lets the port dial; answers the newest dial if one was made. Returns how many were dialled. */
const completeDials = async (before: number): Promise<number> => {
  for (let turn = 0; turn < 20; turn += 1) await new Promise((tick) => setImmediate(tick));
  const count = wakes.dialled.length - before;
  if (count > 0) wakes.dialled.at(-1)!.succeed();
  for (let turn = 0; turn < 5; turn += 1) await new Promise((tick) => setImmediate(tick));
  return count;
};

/** A canonical CTO bound on its conversation, its subscriber identity, and the daemon-built CTO port. */
const start = async () => {
  const dir = tempDir("acp-wks-");
  chmodSync(dir, 0o700);
  const cto = channelKey(dir, "cto.key");
  const owner = channelKey(dir, "owner.key");
  const ceo = channelKey(dir, "ceo.key");
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
      attestationDigest: digestOf({ fixture: "wake-scope", sessionId: session.sessionId }),
      verify: () => claimed,
    },
  }).allowed).toBe(true);
  writeSubscriberConfig(dir, [{ keyFile: cto.keyFile, rooms: [ROOM] }]);
  const policy = { allowedActors: [owner.pubkey, ceo.pubkey], secret: "buzz-wake-scope-secret" };
  // The daemon's own composition: its MCP listeners (the in-band wake callback included) build the port.
  const listeners = await startDaemonMcpListeners(h.cp, dir, "wake-scope-mcp-token", { finalizeApprovedRun: () => undefined });
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

  const attach = async (sessionId: string, incarnation: string, socketName: string) => {
    const server = new McpServer({ name: "wake-scope", version: "1" });
    vi.spyOn(server.server, "getClientVersion").mockReturnValue(WAKE_TRANSPORT_QUALIFIED_CLIENTS[0]);
    conversation.attach(server, () => allow(ReasonCode.OK, { actor: sessionId, sessionId, sessionIncarnation: incarnation }));
    const endpoint = await socketAt(join(dir, socketName));
    const before = wakes.dialled.length;
    const registration = conversation.registerEndpoint(server, join(dir, socketName));
    const dials = await completeDials(before);
    return { server, endpoint, registration: await registration, dials, frame: dials > 0 ? wakes.dialled.at(-1)!.frame : null };
  };
  const holder = h.cp.bindings.active(roleKey)!;
  const attached = await attach(holder.sessionId, holder.sessionIncarnation, "wake.sock");
  expect(attached.registration.allowed).toBe(true);
  const endpoints: Server[] = [attached.endpoint];

  /** The holder's room is moved to one its identity does not subscribe in: the identity is EXCLUDED. */
  const excludeIdentity = (): void => {
    h.cp.sessions.setBuzzAddress(h.cp.bindings.active(roleKey)!.sessionId, "room-unsubscribed");
    subscriber.rejudge();
    expect(subscriber.admission().identities[0]).toMatchObject({ state: "EXCLUDED", reason: "ROOM_NOT_SUBSCRIBED" });
  };
  return {
    h,
    dir,
    cto,
    ceo,
    owner,
    policy,
    ingress,
    roleKey,
    relay,
    subscriber,
    conversation,
    server: attached.server,
    attach: async (sessionId: string, incarnation: string, socketName: string) => {
      const next = await attach(sessionId, incarnation, socketName);
      endpoints.push(next.endpoint);
      return next;
    },
    excludeIdentity,
    close: async () => {
      for (const wake of wakes.dialled) if (wake.frame === null && !wake.destroyed) wake.refuse();
      for (const endpoint of endpoints) await new Promise<void>((resolve) => endpoint.close(() => resolve()));
      subscriber.close();
      await ingress.close();
      await listeners.close();
      h.cp.close();
    },
  };
};

describe("wakes the mention gate does not govern keep the current-holder check alone", () => {
  for (const kind of IN_BAND_KINDS) {
    it(`wakes the current holder for in-band ${kind} while its mention identity is excluded`, async () => {
      const f = await start();
      try {
        f.excludeIdentity();
        const holder = f.h.cp.bindings.active(f.roleKey)!;
        const before = wakes.dialled.length;
        const queued = f.h.cp.outbox.enqueue({
          idempotencyKey: `wake-scope-${kind}`,
          roleKey: f.roleKey,
          bindingGeneration: holder.bindingGeneration,
          targetSessionId: holder.sessionId,
          runId: null,
          kind,
          payload: { projectId: PROJECT, reason: "non-mention role work" },
        });
        expect(queued.allowed).toBe(true);
        const dials = await completeDials(before);
        expect(dials, "the current authenticated holder receives its in-band work wake").toBe(1);
        expect(wakes.dialled.at(-1)!.frame).toBe(ROLE_WAKE_FRAME);
        expect(f.h.cp.outbox.pendingInBandFor(holder.sessionId, holder.sessionIncarnation)).toHaveLength(1);
      } finally {
        await f.close();
      }
    });
  }

  it("wakes a peer turn admitted through the local socket while the CTO's mention identity is excluded", async () => {
    const f = await start();
    try {
      const ceoSession = f.h.cp.sessions.create({ provider: "scripted", model: "ceo", buzzAddress: ROOM });
      expect(f.h.cp.sessions.transition(ceoSession.sessionId, SessionLifecycle.READY, "ceo").allowed).toBe(true);
      expect(f.h.cp.sessions.bindBuzzActor(
        { sessionId: ceoSession.sessionId, sessionSecret: ceoSession.sessionSecret!, buzzActorId: f.ceo.pubkey },
        { isAllowedActor: () => true },
      ).allowed).toBe(true);
      expect(f.h.cp.bindings.bind({ role: Role.CEO, sessionId: ceoSession.sessionId }).allowed).toBe(true);
      f.excludeIdentity();
      // The peer rule admits a CEO mention only on the CTO row's room, so the row names it again;
      // the identity stays EXCLUDED until it is judged again.
      const holder = f.h.cp.bindings.active(f.roleKey)!;
      f.h.cp.sessions.setBuzzAddress(holder.sessionId, ROOM);
      expect(f.subscriber.admission().identities[0]?.state).toBe("EXCLUDED");
      f.h.clock.advance(1_000);
      const ceo = f.h.cp.bindings.active(roleKeyFor(Role.CEO))!;
      const event = signedMention({
        author: f.ceo.secretKey, addressedTo: f.cto.pubkey, room: ROOM, createdAt: secondsOf(f.h.cp.clock.nowIso()), text: "valid peer instructions",
      });
      const input = buzzMentionInputFor(f.ingress.seam.ingress, f.policy.secret, {
        roleKey: f.roleKey,
        identityPubkey: f.cto.pubkey,
        conversation: ROOM,
        event,
        receipt: {
          ceoBindingGeneration: ceo.bindingGeneration,
          ceoSessionId: ceo.sessionId,
          ctoRoleKey: f.roleKey,
          ctoBindingGeneration: holder.bindingGeneration,
          ctoSessionId: holder.sessionId,
        },
      });
      const before = wakes.dialled.length;
      const delivery = deliverBuzzMessage(f.ingress.seam.ingress, f.ingress.seam.port, input);
      const dials = await completeDials(before);
      expect((await delivery).allowed).toBe(true);
      expect(dials, "a peer turn with current proof wakes its authenticated holder").toBe(1);
      expect(wakes.dialled.at(-1)!.frame).toBe(ROLE_WAKE_FRAME);
      expect(f.conversation.claimOwnerMessage(f.server, f.roleKey)).toMatchObject({
        allowed: true,
        value: { claimed: { principal: "peer", text: "valid peer instructions" } },
      });
    } finally {
      await f.close();
    }
  });

  it("sends a registration's own wake while the holder's mention identity is excluded", async () => {
    const f = await start();
    try {
      f.excludeIdentity();
      const holder = f.h.cp.bindings.active(f.roleKey)!;
      const again = await f.attach(holder.sessionId, holder.sessionIncarnation, "wake-2.sock");
      expect(again.registration.allowed).toBe(true);
      expect(again.dials).toBe(1);
      expect(again.frame).toBe(ROLE_WAKE_FRAME);
    } finally {
      await f.close();
    }
  });

  it("judges a takeover's new holder by itself: a former identity's role pin does not gate it", async () => {
    const f = await start();
    try {
      const old = f.h.cp.bindings.active(f.roleKey)!;
      expect(f.h.cp.sessions.transition(old.sessionId, SessionLifecycle.STOPPED, "takeover").allowed).toBe(true);
      const replacementKey = channelKey(f.dir, "replacement.key");
      const next = f.h.cp.sessions.create({ provider: "scripted", model: "cto", buzzAddress: ROOM });
      expect(f.h.cp.sessions.transition(next.sessionId, SessionLifecycle.READY, "new holder").allowed).toBe(true);
      expect(f.h.cp.sessions.bindBuzzActor(
        { sessionId: next.sessionId, sessionSecret: next.sessionSecret!, buzzActorId: replacementKey.pubkey },
        { isAllowedActor: () => true },
      ).allowed).toBe(true);
      expect(f.h.cp.bindings.switchTo({
        role: Role.PRIMARY_CTO, projectId: PROJECT, sessionId: next.sessionId, reason: "unconfigured replacement", conversation: "REPLACED",
      }).allowed).toBe(true);
      f.subscriber.rejudge();
      // The former identity keeps its pin and is excluded; the replacement has no configured identity.
      expect(f.subscriber.admission().identities[0]).toMatchObject({ state: "EXCLUDED", roleKey: f.roleKey });
      const attached = await f.attach(next.sessionId, f.h.cp.sessions.require(next.sessionId).incarnation, "next.sock");
      expect(attached.registration.allowed).toBe(true);
      expect(attached.frame).toBe(ROLE_WAKE_FRAME);
      const before = wakes.dialled.length;
      const woken = f.conversation.wake(f.roleKey);
      const dials = await completeDials(before);
      expect((await woken).allowed).toBe(true);
      expect(dials).toBe(1);
      expect(wakes.dialled.at(-1)!.frame).toBe(ROLE_WAKE_FRAME);
    } finally {
      await f.close();
    }
  });
});

describe("a mention's wake is governed by the mention gate", () => {
  it("hands no frame for a relay mention whose identity is excluded during the connect", async () => {
    const f = await start();
    try {
      const before = wakes.dialled.length;
      f.h.clock.advance(1_000);
      const mention: BuzzMentionEvent = signedMention({
        author: f.owner.secretKey, addressedTo: f.cto.pubkey, room: ROOM, createdAt: secondsOf(f.h.cp.clock.nowIso()), text: "mention",
      });
      f.relay.publish(mention);
      for (let turn = 0; turn < 20 && wakes.dialled.length === before; turn += 1) await new Promise((tick) => setImmediate(tick));
      expect(wakes.dialled.length - before).toBe(1);
      const pending = wakes.dialled.at(-1)!;
      f.excludeIdentity();
      pending.succeed();
      await f.relay.drain(f.subscriber);
      expect(pending.frame).toBeNull();
    } finally {
      await f.close();
    }
  });

  it("refuses a mention wake whose context does not match the holder, and dials nothing", async () => {
    const f = await start();
    try {
      for (const mention of [
        { actorId: f.owner.pubkey, roleKey: f.roleKey, room: ROOM, eventId: "e".repeat(64) },
        { actorId: f.cto.pubkey, roleKey: f.roleKey, room: "room-unsubscribed", eventId: "e".repeat(64) },
        { actorId: f.cto.pubkey, roleKey: roleKeyFor(Role.PRIMARY_CTO, { projectId: "another" }), room: ROOM, eventId: "e".repeat(64) },
      ]) {
        const before = wakes.dialled.length;
        const decision = await f.conversation.wake(f.roleKey, mention);
        expect(decision.allowed).toBe(false);
        expect(decision.reasonCode).toBe(ReasonCode.ROLE_PEER_STALE);
        expect(wakes.dialled.length).toBe(before);
      }
    } finally {
      await f.close();
    }
  });
});
