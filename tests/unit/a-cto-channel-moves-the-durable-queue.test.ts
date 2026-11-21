import { appendFileSync, mkdirSync, realpathSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";

import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { afterAll, describe, expect, it } from "vitest";

import type { ChannelReceipt } from "../../src/buzz/buzz-channel.ts";
import { applyChannelReceipts, watchChannelReceipts, type ChannelQueueDeps, type ChannelQueueMessage } from "../../src/buzz/buzz-channel-queue.ts";
import { channelReceiptPath } from "../../src/buzz/buzz-channel-files.ts";
import { allow, type Decision } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { outboxDeliveryReadback } from "../../src/outbox/outbox.ts";
import { channelQueueDepsFor, startBuzzMessageIngressListener } from "../../src/daemon/agentcpd.ts";
import type { CtoProcessReader } from "../../src/cto/one-cto-per-project.ts";
import { BUZZ_CHANNEL_MISSED_AFTER_MS, BUZZ_CHANNEL_PENDING_AFTER_MS } from "../../src/doctor/doctor.ts";
import { Role, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { buzzMessageSigningRequest } from "../../src/ingress/buzz-message.ts";
import { ingressSignature } from "../../src/ingress/ingress-guard.ts";
import { CeoConversationPort } from "../../src/mcp/ceo-conversation.ts";
import { RoleConversationPort } from "../../src/mcp/role-conversation.ts";
import type { McpPeerAuthenticator } from "../../src/mcp/shared.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { makeHarness, registerFixtureProject } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * A CTO session's Buzz channel moves the durable queue: delivered when the channel wrote the message
 * into the session, completed when the CTO's own signed reply, in the right room and under the right
 * event, was posted. The queue stays the record, and the doctor names what no channel delivered.
 *
 * The first block drives the pure rules with a fake queue; the second drives the production ledger
 * over a real admitted message, so a change that stops the claim from taking exactly one message, or
 * stops a reply signed by someone else from completing it, fails against the real rows.
 */

const ROOM = "buzz-ceo-room";
const cto = generateSecretKey();
const ctoPub = getPublicKey(cto);
const ceo = generateSecretKey();
const SECRET = "channel-queue-secret";
const OWNER = "npub-owner";

const signedReply = (key: Uint8Array, tags: string[][], content = "done") =>
  finalizeEvent({ kind: 9, created_at: 1_700_000_000, tags, content }, key);

const emitted = (eventId: string, room = ROOM): ChannelReceipt => ({ type: "emitted", eventId, room, senderPubkey: OWNER, emittedAt: 1 });
const replied = (event: ReturnType<typeof signedReply>, parentEventId: string, room = ROOM, ack: "ACCEPTED" | "DUPLICATE" = "ACCEPTED"): ChannelReceipt => ({
  type: "replied", event, room, parentEventId, ack, repliedAt: 2,
});

describe("the rules for what a receipt may move", () => {
  const holder = { roleKey: "PRIMARY_CTO:p", bindingGeneration: 1, targetSessionId: "s", sessionIncarnation: "i" };
  const fake = () => {
    const state = { status: "PENDING" as "PENDING" | "SENT" | "ACKED" };
    const calls: string[] = [];
    const message = (): ChannelQueueMessage[] =>
      state.status === "ACKED" ? [] : [{ messageId: "m1", delivery: outboxDeliveryReadback({ status: state.status, failureClass: null }), holder, eventId: "evt-1", room: ROOM }];
    const ok: Decision<void> = allow(ReasonCode.OK, undefined);
    const deps: ChannelQueueDeps = {
      messages: message,
      boundActor: () => ctoPub,
      deliver: () => {
        calls.push("deliver");
        state.status = "SENT";
        return ok;
      },
      complete: () => {
        calls.push("complete");
        state.status = "ACKED";
        return ok;
      },
    };
    return { deps, calls, state };
  };

  it("delivers on emission, once, and does not complete on emission alone", () => {
    const f = fake();
    expect(applyChannelReceipts(f.deps, holder.roleKey, [emitted("evt-1")]).delivered).toEqual(["m1"]);
    applyChannelReceipts(f.deps, holder.roleKey, [emitted("evt-1"), emitted("evt-1")]);
    expect(f.calls).toEqual(["deliver"]);
    expect(f.state.status).toBe("SENT");
  });

  it("completes only on the bound CTO's own signed reply in the message's room under the message's event", () => {
    const good = signedReply(cto, [["h", ROOM], ["e", "evt-1", "", "reply"], ["p", OWNER]]);
    const f = fake();
    expect(applyChannelReceipts(f.deps, holder.roleKey, [replied(good, "evt-1")]).completed).toEqual(["m1"]);
    expect(f.calls).toEqual(["deliver", "complete"]);

    const refused: [string, ChannelReceipt][] = [
      ["signed by the CEO's key", replied(signedReply(ceo, [["h", ROOM], ["e", "evt-1", "", "reply"]]), "evt-1")],
      ["another room", replied(signedReply(cto, [["h", "elsewhere"], ["e", "evt-1", "", "reply"]]), "evt-1")],
      ["another parent", replied(signedReply(cto, [["h", ROOM], ["e", "evt-9", "", "reply"]]), "evt-1")],
      ["no parent tag", replied(signedReply(cto, [["h", ROOM]]), "evt-1")],
      ["two rooms", replied(signedReply(cto, [["h", ROOM], ["h", "elsewhere"], ["e", "evt-1", "", "reply"]]), "evt-1")],
      ["tampered after signing", replied({ ...good, content: "something else" }, "evt-1")],
      ["a receipt naming another room", replied(good, "evt-1", "elsewhere")],
    ];
    for (const [name, receipt] of refused) {
      const g = fake();
      const out = applyChannelReceipts(g.deps, holder.roleKey, [receipt]);
      expect(out.completed, name).toEqual([]);
      expect(g.calls, name).toEqual([]);
    }
  });

  it("reads a message's delivery through the shared interpretation: one whose outcome is unknown is neither delivered nor completed", () => {
    const f = fake();
    const held: ChannelQueueDeps = {
      ...f.deps,
      messages: () => [{ messageId: "m1", delivery: outboxDeliveryReadback({ status: "PENDING", failureClass: "unknown_observed" }), holder, eventId: "evt-1", room: ROOM }],
    };
    const own = signedReply(cto, [["h", ROOM], ["e", "evt-1", "", "reply"], ["p", OWNER]]);
    const out = applyChannelReceipts(held, holder.roleKey, [emitted("evt-1"), replied(own, "evt-1")]);
    expect(out).toMatchObject({ delivered: [], completed: [], ignored: 2 });
    expect(f.calls).toEqual([]);
  });

  it("changes nothing for an event that is no queued message, or a room that is not the message's", () => {
    const f = fake();
    const out = applyChannelReceipts(f.deps, holder.roleKey, [emitted("evt-unknown"), emitted("evt-1", "elsewhere")]);
    expect(out).toEqual({ delivered: [], completed: [], ignored: 2, invalid: 0 });
    expect(f.calls).toEqual([]);
  });
});

describe("a CTO's reply in a thread completes what it was shown there, whatever sent the reply", () => {
  const holder = { roleKey: "PRIMARY_CTO:p", bindingGeneration: 1, targetSessionId: "s", sessionIncarnation: "i" };
  const hex = (c: string) => c.repeat(64);
  const [T, U, A, B, C, D, X] = ["1", "2", "a", "b", "c", "d", "e"].map(hex);
  const queue = () => {
    const status = new Map<string, "PENDING" | "SENT" | "ACKED">([["m1", "SENT"], ["m2", "SENT"], ["m3", "SENT"], ["m4", "PENDING"]]);
    const shape: Record<string, { eventId: string; thread: string; createdAt: number }> = {
      m1: { eventId: A!, thread: T!, createdAt: 100 }, // delivered, in the thread, before the reply: completed
      m2: { eventId: B!, thread: T!, createdAt: 300 }, // signed after the reply: not answered by it
      m3: { eventId: C!, thread: U!, createdAt: 100 }, // another thread
      m4: { eventId: D!, thread: T!, createdAt: 100 }, // never delivered: a thread reply does not complete what the CTO was never shown
    };
    const completed: string[] = [];
    const deps: ChannelQueueDeps = {
      messages: () => [...status].filter(([, st]) => st !== "ACKED").map(([id, st]) => ({
        messageId: id, delivery: outboxDeliveryReadback({ status: st as "PENDING" | "SENT", failureClass: null }), holder, room: ROOM, ...shape[id]!,
      })),
      boundActor: () => ctoPub,
      deliver: (m) => { status.set(m.messageId, "SENT"); return allow(ReasonCode.OK, undefined); },
      complete: (m) => { status.set(m.messageId, "ACKED"); completed.push(m.messageId); return allow(ReasonCode.OK, undefined); },
    };
    return { deps, completed, status };
  };
  const reply = (key: Uint8Array, parent: string, at = 200) =>
    finalizeEvent({ kind: 9, created_at: at, tags: [["h", ROOM], ["e", T!, "", "root"], ["e", parent, "", "reply"], ["p", OWNER]], content: "answered by the buzz CLI" }, key);

  it("completes the delivered messages of the thread signed no later than the reply, and nothing else", () => {
    const q = queue();
    const out = applyChannelReceipts(q.deps, holder.roleKey, [replied(reply(cto, X!), X!)]);
    expect(out.completed).toEqual(["m1"]);
    expect([...q.status]).toEqual([["m1", "ACKED"], ["m2", "SENT"], ["m3", "SENT"], ["m4", "PENDING"]]);
  });

  it("still completes the exact message answered, delivering it first, and completes nothing for a reply someone else signed", () => {
    const q = queue();
    expect(applyChannelReceipts(q.deps, holder.roleKey, [replied(reply(ceo, X!), X!)]).completed).toEqual([]);
    expect(applyChannelReceipts(q.deps, holder.roleKey, [replied(reply(cto, D!), D!)]).completed.sort()).toEqual(["m1", "m4"]);
  });
});

describe("a malformed receipt is skipped and does not stop the batch", () => {
  const holder = { roleKey: "PRIMARY_CTO:p", bindingGeneration: 1, targetSessionId: "s", sessionIncarnation: "i" };
  const queue = () => {
    const state = { status: "PENDING" as "PENDING" | "SENT" };
    const deps: ChannelQueueDeps = {
      messages: () => [{ messageId: "m1", delivery: outboxDeliveryReadback({ status: state.status, failureClass: null }), holder, eventId: "evt-1", room: ROOM }],
      boundActor: () => ctoPub,
      deliver: () => {
        state.status = "SENT";
        return allow(ReasonCode.OK, undefined);
      },
      complete: () => allow(ReasonCode.OK, undefined),
    };
    return deps;
  };

  it("counts what is not a receipt, and applies the receipts after it", () => {
    const broken = [
      { type: "replied", event: {}, room: ROOM, parentEventId: "evt-1", ack: "ACCEPTED", repliedAt: 1 },
      { type: "replied", room: ROOM, parentEventId: "evt-1", ack: "ACCEPTED", repliedAt: 1 },
      { type: "emitted", eventId: 7, room: ROOM, senderPubkey: OWNER, emittedAt: 1 },
      null,
      "text",
    ];
    const out = applyChannelReceipts(queue(), holder.roleKey, [...broken, emitted("evt-1")]);
    expect(out).toMatchObject({ delivered: ["m1"], invalid: 5 });
  });

  it("does not let a receipt whose handling throws take the rest with it", () => {
    const deps = queue();
    let first = true;
    const original = deps.messages;
    deps.messages = (role) => {
      if (first) {
        first = false;
        throw new Error("a row the queue cannot read");
      }
      return original(role);
    };
    const out = applyChannelReceipts(deps, holder.roleKey, [emitted("evt-1"), emitted("evt-1")]);
    expect(out).toMatchObject({ delivered: ["m1"], invalid: 1 });
  });

  it("reports a skipped line once, not on every replay of the file", () => {
    const stateDir = tempDir("acp-channel-skip-");
    mkdirSync(join(stateDir, "buzz-channel"), { recursive: true });
    appendFileSync(channelReceiptPath(stateDir, "p"), `${JSON.stringify({ type: "replied", event: {} })}\n${JSON.stringify(emitted("evt-1"))}\n`);
    const skipped: string[] = [];
    const watcher = watchChannelReceipts(stateDir, () => holder.roleKey, queue(), () => undefined, (project, line) => skipped.push(`${project}:${line}`));
    try {
      watcher.apply();
      watcher.apply();
      expect(skipped).toEqual(["p:1"]);
    } finally {
      watcher.close();
    }
  });
});

describe("over a real admitted message", () => {
  const envelope = (eventId: string, text: string) => {
    const message = { actor: OWNER, conversation: ROOM, eventId, addressedTo: "CTO", mention: ctoPub, text };
    return { ...message, signature: ingressSignature(SECRET, buzzMessageSigningRequest(message)) };
  };
  const exchange = (socketPath: string, line: unknown): Promise<string> =>
    new Promise((resolve, reject) => {
      const socket = createConnection(socketPath);
      let received = "";
      socket.setEncoding("utf8");
      socket.once("connect", () => socket.write(`${JSON.stringify(line)}\n`));
      socket.on("data", (chunk: string) => {
        received += chunk;
        if (received.includes('"reasonCode"')) socket.end();
      });
      socket.once("error", reject);
      socket.once("close", () => resolve(received));
    });

  const setup = async () => {
    const harness = makeHarness();
    const { projectId } = await registerFixtureProject(harness);
    const roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId });
    const session = harness.cp.sessions.create({ provider: "scripted", model: "cto-channel" });
    harness.cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "test");
    const bound = harness.cp.bindings.bind({ role: Role.PRIMARY_CTO, sessionId: session.sessionId, projectId });
    if (!bound.allowed) throw new Error("bind failed");
    const actor = harness.cp.sessions.bindBuzzActor(
      { sessionId: session.sessionId, sessionSecret: session.sessionSecret!, buzzActorId: ctoPub },
      { isAllowedActor: () => true },
    );
    if (!actor.allowed) throw new Error("buzz actor bind failed");
    const incarnation = harness.cp.sessions.require(session.sessionId).incarnation;
    const roleConversation = new RoleConversationPort(Role.PRIMARY_CTO, {
      active: (key) => harness.cp.bindings.active(key),
      currentCandidates: () => harness.cp.projects.list().map((p) => harness.cp.bindings.activePrimaryCto(p.projectId)).filter((b): b is NonNullable<typeof b> => b !== null),
    });
    const peer: McpPeerAuthenticator = () => allow(ReasonCode.OK, { actor: "role-peer", sessionId: session.sessionId, sessionIncarnation: incarnation });
    roleConversation.attach(
      { server: { getClientCapabilities: () => ({ sampling: {} }), getClientVersion: () => ({ name: "claude-code", version: "2.1.323" }), createMessage: async () => ({ model: "f", role: "assistant", content: { type: "text", text: "ok" } }) } } as never,
      peer,
    );
    const listener = await startBuzzMessageIngressListener(
      harness.cp,
      tempDir("acp-channel-queue-"),
      { allowedActors: [OWNER], secret: SECRET },
      { ceoConversation: new CeoConversationPort(), ownerActors: [OWNER], roleConversation },
    );
    const status = (id: string) => harness.cp.db.get<{ status: string }>("SELECT status FROM outbox WHERE message_id = ?", [id])?.status;
    const rows = () => harness.cp.db.all<{ message_id: string; status: string }>("SELECT message_id, status FROM outbox ORDER BY created_at, rowid", []);
    return { harness, roleKey, listener, status, rows, session };
  };

  it("delivers exactly the emitted message, leaves its neighbour pending, and completes only on the CTO's reply", async () => {
    const s = await setup();
    try {
      for (const id of ["evt-a", "evt-b"]) {
        expect(JSON.parse((await exchange(s.listener.socketPath, envelope(id, `message ${id}`))).trim())).toMatchObject({ ok: true });
      }
      const [first, second] = s.rows();
      expect([first!.status, second!.status]).toEqual(["PENDING", "PENDING"]);

      const deps = channelQueueDepsFor(s.harness.cp);
      // The channel showed the SECOND message first: only it moves, not the oldest.
      expect(applyChannelReceipts(deps, s.roleKey, [emitted("evt-b")]).delivered).toEqual([second!.message_id]);
      expect([s.status(first!.message_id), s.status(second!.message_id)]).toEqual(["PENDING", "SENT"]);

      // A reply signed by anyone but the session's bound Buzz actor completes nothing.
      const forged = replied(signedReply(ceo, [["h", ROOM], ["e", "evt-b", "", "reply"]]), "evt-b");
      expect(applyChannelReceipts(deps, s.roleKey, [forged]).completed).toEqual([]);
      expect(s.status(second!.message_id)).toBe("SENT");

      const own = replied(signedReply(cto, [["h", ROOM], ["e", "evt-b", "", "reply"], ["p", OWNER]]), "evt-b");
      expect(applyChannelReceipts(deps, s.roleKey, [own]).completed).toEqual([second!.message_id]);
      expect([s.status(first!.message_id), s.status(second!.message_id)]).toEqual(["PENDING", "ACKED"]);

      // Applying everything again is a no-op: the file is replayed whole every time.
      expect(applyChannelReceipts(deps, s.roleKey, [emitted("evt-b"), own])).toMatchObject({ delivered: [], completed: [] });
    } finally {
      await s.listener.close();
    }
  }, 30_000);

  it("drains: a reply the CTO posted in a thread outside the reply tool completes every delivered message of that thread before it, and leaves another thread's", async () => {
    const s = await setup();
    try {
      const [A, B, C] = ["a", "b", "c"].map((c) => c.repeat(64)) as [string, string, string];
      const retained: Record<string, string[][]> = { [A]: [["h", ROOM]], [B]: [["h", ROOM], ["e", A, "", "root"], ["e", A, "", "reply"]], [C]: [["h", ROOM]] };
      for (const [id, tags] of Object.entries(retained)) {
        expect(JSON.parse((await exchange(s.listener.socketPath, envelope(id, `message ${id.slice(0, 1)}`))).trim())).toMatchObject({ ok: true });
        s.harness.cp.db.run("INSERT OR IGNORE INTO buzz_events (event_id, payload_json) VALUES (?, ?)", [id, JSON.stringify({ id, tags, created_at: 1_699_999_000 })]);
      }
      const deps = channelQueueDepsFor(s.harness.cp);
      expect(applyChannelReceipts(deps, s.roleKey, [emitted(A), emitted(B), emitted(C)]).delivered).toHaveLength(3);
      // What `buzz messages send --reply-to <B>` posts: the thread's root and the parent, no acp-kind.
      const cli = signedReply(cto, [["h", ROOM], ["e", A, "", "root"], ["e", B, "", "reply"], ["p", OWNER]]);
      expect(applyChannelReceipts(deps, s.roleKey, [replied(cli, B)]).completed).toHaveLength(2);
      expect(s.rows().map((row) => row.status)).toEqual(["ACKED", "ACKED", "SENT"]);
    } finally {
      await s.listener.close();
    }
  }, 30_000);

  it("applies a receipt appended to the state directory without being asked", async () => {
    const s = await setup();
    const stateDir = tempDir("acp-channel-state-");
    mkdirSync(join(stateDir, "buzz-channel"), { recursive: true });
    const watcher = watchChannelReceipts(stateDir, () => s.roleKey, channelQueueDepsFor(s.harness.cp));
    try {
      await exchange(s.listener.socketPath, envelope("evt-w", "watched"));
      const [row] = s.rows();
      expect(row!.status).toBe("PENDING");
      appendFileSync(channelReceiptPath(stateDir, "p"), `${JSON.stringify(emitted("evt-w"))}\n`);
      const deadline = Date.now() + 5_000;
      while (s.status(row!.message_id) !== "SENT" && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
      expect(s.status(row!.message_id)).toBe("SENT");
    } finally {
      watcher.close();
      await s.listener.close();
    }
  }, 30_000);

  it("names, as an ERROR, messages a CTO with no live channel process has left PENDING or SENT for more than 10 minutes", async () => {
    const s = await setup();
    /** One claude process in the project's checkout, with or without the channel loaded. */
    const processes = (argv: string[]): CtoProcessReader => {
      const uid = process.getuid?.() ?? 0;
      const rows = [{ pid: process.pid, ppid: 1, uid, startedAt: "s", command: "node vitest" }, { pid: 91_001, ppid: 1, uid, startedAt: "s", command: argv.join(" ") }];
      return {
        table: async () => rows,
        argv: (pid) => (pid === 91_001 ? argv : ["node", "vitest"]),
        cwds: async (pids) => new Map(pids.includes(91_001) ? [[91_001, realpathSync(s.harness.repoPath)]] : []),
        tmuxPanes: async () => new Map(),
        alive: (pid) => rows.some((row) => row.pid === pid),
        startToken: () => null,
      };
    };
    const missed = async () => (await s.harness.cp.doctor.run("system")).findings.filter((f) => f.code === "BUZZ_CHANNEL_MESSAGES_PENDING" && f.severity === "ERROR");
    try {
      for (const id of ["evt-m1", "evt-m2"]) await exchange(s.listener.socketPath, envelope(id, `message ${id}`));
      applyChannelReceipts(channelQueueDepsFor(s.harness.cp), s.roleKey, [emitted("evt-m1")]);
      s.harness.cp.doctor.useCtoProcessReader(processes(["claude", "--resume", "11111111-1111-4111-8111-111111111111"]));
      expect(await missed()).toEqual([]);
      s.harness.clock.advance(BUZZ_CHANNEL_MISSED_AFTER_MS + 1_000);
      const [finding] = await missed();
      expect(finding).toMatchObject({
        blocking: false,
        observedEvidence: { condition: "NO_LIVE_CHANNEL_PROCESS", roleKey: s.roleKey, count: 2, pending: 1, sent: 1 },
        recommendedAction: expect.stringContaining("messages for this CTO are being missed"),
      });
      // The same CTO running with its channel loaded is not missing them.
      s.harness.cp.doctor.useCtoProcessReader(processes(["claude", "--resume", "11111111-1111-4111-8111-111111111111", "--dangerously-load-development-channels", "server:acp-buzz-channel"]));
      expect(await missed()).toEqual([]);
    } finally {
      await s.listener.close();
    }
  }, 30_000);

  it("names a message no channel delivered, and does not name one that was", async () => {
    const s = await setup();
    try {
      await exchange(s.listener.socketPath, envelope("evt-d", "waiting"));
      const quiet = await s.harness.cp.doctor.run("system");
      expect(quiet.findings.find((f) => f.code === "BUZZ_CHANNEL_MESSAGES_PENDING")).toBeUndefined();

      s.harness.clock.advance(BUZZ_CHANNEL_PENDING_AFTER_MS + 1_000);
      const report = await s.harness.cp.doctor.run("system");
      const finding = report.findings.find((f) => f.code === "BUZZ_CHANNEL_MESSAGES_PENDING");
      expect(finding).toMatchObject({ severity: "WARN", blocking: false, observedEvidence: { count: 1, roleKeys: [s.roleKey] } });

      applyChannelReceipts(channelQueueDepsFor(s.harness.cp), s.roleKey, [emitted("evt-d")]);
      const after = await s.harness.cp.doctor.run("system");
      expect(after.findings.find((f) => f.code === "BUZZ_CHANNEL_MESSAGES_PENDING")).toBeUndefined();
    } finally {
      await s.listener.close();
    }
  }, 30_000);
});
