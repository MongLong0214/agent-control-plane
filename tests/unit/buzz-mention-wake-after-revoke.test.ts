import { chmodSync } from "node:fs";
import type * as NodeNet from "node:net";
import { createServer, type Server } from "node:net";
import { join } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterAll, expect, it, vi } from "vitest";

import type { BuzzMentionEvent } from "../../src/buzz/buzz-mention-subscriber.ts";
import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import {
  rejudgeBuzzMentionSubscriberOnBindingSwitch,
  startBuzzMessageIngressListener,
  startDaemonBuzzMentionSubscriber,
} from "../../src/daemon/agentcpd.ts";
import { Role, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { CeoConversationPort } from "../../src/mcp/ceo-conversation.ts";
import { ROLE_WAKE_FRAME, RoleConversationPort, WAKE_TRANSPORT_QUALIFIED_CLIENTS } from "../../src/mcp/role-conversation.ts";
import { MessageKind } from "../../src/outbox/envelope.ts";
import { channelKey, signedMention, steppedClock, storingRelay, writeSubscriberConfig } from "../helpers/buzz-mention-relay.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * 1080-N1-01. A mention's wake goes through the daemon's own subscriber, sink, admission seam and
 * role port; only the wake connection's completion is held, so a revoke can be committed while it
 * is in flight. The holder is checked before the connect, and must be checked again at the write:
 * a revoked session is never woken. The durable message is not the wake's to settle.
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
    /** The connect completes; a frame written by then is flushed. */
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

/** Resolves once the port has dialled `count` wakes; nothing here waits on a wall clock. */
const dialled = async (count: number): Promise<void> => {
  for (let attempt = 0; attempt < 1_000 && wakes.dialled.length < count; attempt += 1) {
    await new Promise((tick) => setImmediate(tick));
  }
  expect(wakes.dialled).toHaveLength(count);
};

const start = async () => {
  const dir = tempDir("acp-wkr-");
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
  expect(h.cp.bindings.bind({ role: Role.PRIMARY_CTO, sessionId: session.sessionId, projectId: PROJECT }).allowed).toBe(true);
  writeSubscriberConfig(dir, [{ keyFile: cto.keyFile, rooms: [ROOM] }]);
  const policy = { allowedActors: [owner.pubkey], secret: "buzz-wake-after-revoke-secret" };
  const conversation = new RoleConversationPort(Role.PRIMARY_CTO, {
    active: (key) => h.cp.bindings.active(key),
    currentCandidates: () => {
      const binding = h.cp.bindings.activePrimaryCto(PROJECT);
      return binding ? [binding] : [];
    },
  }, { endpointDir: dir });
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

  // The holder attaches over the port and registers its endpoint; the registration's own wake lands.
  const holder = h.cp.bindings.active(roleKey)!;
  const server = new McpServer({ name: "wake-witness", version: "1" });
  vi.spyOn(server.server, "getClientVersion").mockReturnValue(WAKE_TRANSPORT_QUALIFIED_CLIENTS[0]);
  conversation.attach(server, () => allow(ReasonCode.OK, {
    actor: holder.sessionId, sessionId: holder.sessionId, sessionIncarnation: holder.sessionIncarnation,
  }));
  const endpoint = await socketAt(join(dir, "wake.sock"));
  const dialledBefore = wakes.dialled.length;
  const registration = conversation.registerEndpoint(server, join(dir, "wake.sock"));
  await dialled(dialledBefore + 1);
  wakes.dialled.at(-1)!.succeed();
  expect((await registration).allowed).toBe(true);

  return {
    h,
    roleKey,
    relay,
    subscriber,
    mention: (text: string): BuzzMentionEvent =>
      signedMention({ author: owner.secretKey, addressedTo: cto.pubkey, room: ROOM, createdAt: secondsOf(h.cp.clock.nowIso()), text }),
    ownerMessages: () =>
      h.cp.db.all<{ status: string }>(`SELECT status FROM outbox WHERE kind = ? AND role_key = ?`, [MessageKind.OWNER_MESSAGE, roleKey]),
    close: async () => {
      for (const wake of wakes.dialled) if (wake.frame === null && !wake.destroyed) wake.refuse();
      await new Promise<void>((resolve) => endpoint.close(() => resolve()));
      subscriber.close();
      await ingress.close();
      h.cp.close();
    },
  };
};

it("writes the wake to the holder that is still current when its connection completes", async () => {
  const f = await start();
  try {
    const before = wakes.dialled.length;
    f.h.clock.advance(1_000);
    f.relay.publish(f.mention("a mention for the current holder"));
    await dialled(before + 1);
    wakes.dialled.at(-1)!.succeed();
    await f.relay.drain(f.subscriber);
    expect(wakes.dialled.at(-1)!.frame).toBe(ROLE_WAKE_FRAME);
    expect(f.ownerMessages()).toEqual([{ status: "PENDING" }]);
  } finally {
    await f.close();
  }
});

it("writes no wake to a holder revoked while the wake was connecting, and leaves the message durable", async () => {
  const f = await start();
  try {
    const before = wakes.dialled.length;
    f.h.clock.advance(1_000);
    f.relay.publish(f.mention("delayed connection"));
    await dialled(before + 1);
    const pending = wakes.dialled.at(-1)!;
    expect(pending.frame).toBeNull();
    expect(f.h.cp.bindings.revoke(f.roleKey, "revoked during the wake's connect").allowed).toBe(true);
    expect(f.h.cp.bindings.active(f.roleKey)).toBeNull();
    pending.succeed();
    await f.relay.drain(f.subscriber);
    expect(pending.frame, "a revoked holder received ROLE_WAKE_FRAME").toBeNull();
    expect(pending.destroyed).toBe(true);
    // The wake attempt is all that was discarded: the message was admitted and is not marked
    // delivered or completed by the wake that was not written.
    expect(f.ownerMessages()).toHaveLength(1);
    expect(f.ownerMessages()[0]!.status).not.toBe("ACKED");
  } finally {
    await f.close();
  }
});
