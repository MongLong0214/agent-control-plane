import { chmodSync } from "node:fs";

import Database from "better-sqlite3";
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
  startLocalMcpListeners,
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
      // Runs at the handoff itself, before the frame is taken: what a writer outside the daemon
      // does at that instant is ordered before the handoff if it commits.
      atHandoff.run?.();
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
  const atHandoff: { run: (() => void) | null } = { run: null };
  const dialled: PendingWake[] = [];
  return { dialled, atHandoff, open: () => dialled[dialled.push(new PendingWake()) - 1]! };
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

const start = async (options: { production?: boolean; serializeWake?: <T>(body: () => T) => T } = {}) => {
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
  // `production` takes the CTO port exactly as the daemon builds it, with its write-transaction hook.
  const listeners = options.production ? await startLocalMcpListeners(h.cp, dir, "wake-witness-mcp-token") : null;
  const conversation = listeners?.ctoConversation ?? new RoleConversationPort(Role.PRIMARY_CTO, {
    active: (key) => h.cp.bindings.active(key),
    currentCandidates: () => {
      const binding = h.cp.bindings.activePrimaryCto(PROJECT);
      return binding ? [binding] : [];
    },
  }, { endpointDir: dir, ...(options.serializeWake ? { serializeWake: options.serializeWake } : {}) });
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
    conversation,
    server,
    mention: (text: string): BuzzMentionEvent =>
      signedMention({ author: owner.secretKey, addressedTo: cto.pubkey, room: ROOM, createdAt: secondsOf(h.cp.clock.nowIso()), text }),
    ownerMessages: () =>
      h.cp.db.all<{ status: string }>(`SELECT status FROM outbox WHERE kind = ? AND role_key = ?`, [MessageKind.OWNER_MESSAGE, roleKey]),
    close: async () => {
      for (const wake of wakes.dialled) if (wake.frame === null && !wake.destroyed) wake.refuse();
      await new Promise<void>((resolve) => endpoint.close(() => resolve()));
      wakes.atHandoff.run = null;
      subscriber.close();
      await ingress.close();
      await listeners?.close();
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

it("hands no wake frame to a holder revoked while the wake was connecting; the revoke's existing fence settles the message REJECTED", async () => {
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
    // The wake frame and the message are two things. The wake attempt is all the port discarded;
    // the message was settled by the ordinary revoke's existing terminal fence, which rejects a
    // queued row of the released generation and settles its ingress claim. It was never handed to
    // the revoked holder, and it was not delivered or completed.
    expect(f.ownerMessages()).toEqual([{ status: "REJECTED" }]);
  } finally {
    await f.close();
  }
});

/**
 * The receiving side. A wake carries no authority: everything it can lead a session to do with ACP
 * goes through that session's own authenticated connection, and each such call judges the holder
 * again when it is made. A former holder that was woken before its revoke finds nothing to take.
 */
it("refuses the claim of a holder revoked after its wake frame landed; the ordinary revoke settles the message REJECTED", async () => {
  const f = await start();
  try {
    const before = wakes.dialled.length;
    f.h.clock.advance(1_000);
    f.relay.publish(f.mention("woken, then revoked"));
    await dialled(before + 1);
    wakes.dialled.at(-1)!.succeed();
    await f.relay.drain(f.subscriber);
    expect(wakes.dialled.at(-1)!.frame).toBe(ROLE_WAKE_FRAME);

    expect(f.h.cp.bindings.revoke(f.roleKey, "revoked after the wake landed").allowed).toBe(true);
    const claimed = f.conversation.claimOwnerMessage(f.server, f.roleKey);
    expect(claimed.allowed).toBe(false);
    expect(claimed.reasonCode).toBe(ReasonCode.ROLE_PEER_STALE);
    // The frame reached the endpoint before the revoke (the Limit: a wake already handed off is not
    // recalled); the message did not reach the holder, and the revoke's fence settled it.
    expect(f.ownerMessages()).toEqual([{ status: "REJECTED" }]);
  } finally {
    await f.close();
  }
});

/**
 * A writer outside the daemon: a separate SQLite connection that takes no daemon lock, as a raw
 * database edit would. It tries to commit a revoke at the instant of the handoff, after the holder
 * was re-checked. The daemon's port runs that check and the handoff inside its write transaction,
 * so the revoke cannot commit between them: it is refused while the transaction is open and lands
 * after the handoff, and the frame went to the holder that was current when it was handed off.
 *
 * What this does not show, and does not claim: the transaction and the socket's delivery are not
 * atomic, so a revoke committed after the handoff still finds the frame on its way.
 */
it("orders an outside writer's revoke after the handoff, never between the re-check and the frame", async () => {
  const f = await start({ production: true });
  const outside = new Database(f.h.cp.config.databasePath);
  outside.pragma("busy_timeout = 0");
  const revoke = outside.prepare(
    `UPDATE assignments SET status = 'REVOKED', revoked_at = ?, revoked_reason = ? WHERE role_key = ? AND status = 'ACTIVE'`,
  );
  try {
    const before = wakes.dialled.length;
    f.h.clock.advance(1_000);
    f.relay.publish(f.mention("raced by a raw writer"));
    await dialled(before + 1);
    const pending = wakes.dialled.at(-1)!;

    const atHandoff: { committed: boolean; refusedBusy: boolean } = { committed: false, refusedBusy: false };
    wakes.atHandoff.run = () => {
      wakes.atHandoff.run = null;
      try {
        atHandoff.committed = revoke.run(f.h.cp.clock.nowIso(), "raw revoke at the handoff", f.roleKey).changes === 1;
      } catch (error) {
        atHandoff.refusedBusy = (error as { code?: string }).code === "SQLITE_BUSY";
      }
    };
    pending.succeed();
    await f.relay.drain(f.subscriber);

    // Never both: a revoke committed before the handoff with the frame still handed to that holder.
    expect(atHandoff.committed && pending.frame !== null, "a revoke committed between the re-check and the handoff").toBe(false);
    expect(atHandoff.refusedBusy).toBe(true);
    expect(pending.frame).toBe(ROLE_WAKE_FRAME);
    // Once the transaction has closed, the same writer's revoke commits: it is ordered after.
    expect(revoke.run(f.h.cp.clock.nowIso(), "raw revoke after the handoff", f.roleKey).changes).toBe(1);
    expect(f.h.cp.bindings.active(f.roleKey)).toBeNull();
    // A raw revoke runs no fence, so the message stays PENDING; the stale holder's claim is refused.
    expect(f.ownerMessages()).toEqual([{ status: "PENDING" }]);
    const claimed = f.conversation.claimOwnerMessage(f.server, f.roleKey);
    expect(claimed.allowed).toBe(false);
    expect(claimed.reasonCode).toBe(ReasonCode.ROLE_PEER_STALE);
  } finally {
    outside.close();
    await f.close();
  }
});

it("does not report a wake as written when its transaction fails, even after the frame was queued", async () => {
  let failCommit = false;
  const f = await start({
    serializeWake: (body) => {
      const out = body();
      if (failCommit) throw new Error("the commit failed");
      return out;
    },
  });
  try {
    failCommit = true;
    const before = wakes.dialled.length;
    const woken = f.conversation.wake(f.roleKey);
    await dialled(before + 1);
    wakes.dialled.at(-1)!.succeed();
    const decision = await woken;
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe(ReasonCode.ROLE_PEER_FAILED);
    expect(wakes.dialled.at(-1)!.destroyed).toBe(true);
  } finally {
    await f.close();
  }
});

/**
 * 1080-N1-01, the room half (the closure review's counterexample). The wake's final check, inside
 * the serialized handoff, includes the delivery eligibility of the identity behind the holder and
 * the room its session answers in. A room lost or changed during the delayed connect hands off no
 * frame. The message itself is untouched: no revoke ran, so it stays PENDING.
 */
for (const [change, room, reason] of [
  ["lost", null, "ROOM_MISSING"],
  ["changed", "room-somewhere-else", "ROOM_NOT_SUBSCRIBED"],
] as const) {
  it(`hands no wake frame when the holder's room is ${change} during the delayed connect`, async () => {
    const f = await start({ production: true });
    try {
      const before = wakes.dialled.length;
      f.h.clock.advance(1_000);
      f.relay.publish(f.mention(`room ${change} during connect`));
      await dialled(before + 1);
      const pending = wakes.dialled.at(-1)!;
      const holder = f.h.cp.bindings.active(f.roleKey)!;
      f.h.cp.sessions.setBuzzAddress(holder.sessionId, room);
      f.subscriber.rejudge();
      expect(f.subscriber.admission().identities[0]).toMatchObject({ state: "EXCLUDED", reason });

      pending.succeed();
      await f.relay.drain(f.subscriber);
      expect(pending.frame, "a holder whose room no longer holds received ROLE_WAKE_FRAME").toBeNull();
      expect(f.ownerMessages()).toEqual([{ status: "PENDING" }]);
    } finally {
      await f.close();
    }
  });
}

it("hands no wake frame when the room changes during the connect with no re-judgement, read inside the handoff", async () => {
  const f = await start({ production: true });
  try {
    const before = wakes.dialled.length;
    f.h.clock.advance(1_000);
    f.relay.publish(f.mention("room rewritten, nobody re-judged"));
    await dialled(before + 1);
    const pending = wakes.dialled.at(-1)!;
    // A raw rewrite of the room with no rejudge: the cached admission still says ADMITTED, and only
    // the fresh judgement inside the handoff can see it.
    f.h.cp.db.run(`UPDATE sessions SET buzz_address = ? WHERE session_id = ?`, [
      "room-somewhere-else",
      f.h.cp.bindings.active(f.roleKey)!.sessionId,
    ]);
    expect(f.subscriber.admission().identities[0]?.state).toBe("ADMITTED");
    pending.succeed();
    await f.relay.drain(f.subscriber);
    expect(pending.frame).toBeNull();
  } finally {
    await f.close();
  }
});
