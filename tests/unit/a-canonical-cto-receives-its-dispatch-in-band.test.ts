import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, describe, expect, it, vi } from "vitest";

import type { BuzzSendReceipt, BuzzTransport } from "../../src/buzz/buzz-adapter.ts";
import { digestOf, sha256 } from "../../src/core/digest.ts";
import { allow, deny, type Decision } from "../../src/core/errors.ts";
import { readProcessStartToken } from "../../src/core/process-argv.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ExecutionMode, Role, RunState, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { NotificationKind } from "../../src/ceo/production-gate.ts";
import { createCtoMcpPort, createCtoServer } from "../../src/mcp/cto-server.ts";
import { MessageKind } from "../../src/outbox/envelope.ts";
import { IN_BAND_REWAKE_MS } from "../../src/outbox/outbox.ts";
import { SELF_CLAIM_EXECUTOR_KIND, SELF_CLAIM_PROTOCOL } from "../../src/registry/canonical-self-claim.ts";
import type { TaskContract } from "../../src/run/run-engine.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { bindCeo, makeHarness, registerFixtureProject, type Harness } from "../helpers/harness.ts";
import { TestProductionAdapter } from "../helpers/production-adapter.ts";

afterAll(cleanupTempDirs);

/**
 * 2026-10-03 12:58Z, deployed daemon: a run dispatched to an adopted canonical CTO queued its
 * RUN_DISPATCH for the generic sweep, which `buzz send`s it into the CTO's room signed with the
 * daemon's key. The room's sender admits only the room's registered CEO and CTO, so the send was
 * refused non-retryably, the row went REJECTED, and the CTO's `run_ack` was refused
 * `message is REJECTED`. The CTO already holds an authenticated connection to the daemon, so the
 * row is now withheld from Buzz, the role is woken, and the CTO reads and acknowledges it in band.
 */

const CONVERSATION = "44444444-4444-4444-8444-444444444444";
const CANONICAL_ROOM = "canonical-cto-room";
/** The refusal the host's Buzz sender gives a daemon-signed send into a canonical CTO's room. */
const WRAPPER_REFUSAL = "mention_policy: signer not registered for channel";

const CONTRACT: TaskContract = {
  goal: "a run dispatched to a canonical CTO",
  why: "the canonical CTO must receive its dispatch",
  scope: [],
  nonGoals: [],
  acceptance: ["tests pass"],
  priority: "NORMAL",
  humanGate: [],
  references: [],
};

const liveToken = (): string => {
  const token = readProcessStartToken(process.pid);
  if (token === null) throw new Error("this platform cannot read the test process's own start token");
  return token;
};

/** Refuses a send into the canonical room the way the host's sender does; records every other. */
const hostTransport = () => {
  const send = vi.fn(async (channel: string, _content: string, recipients: readonly string[]): Promise<BuzzSendReceipt> => {
    if (channel === CANONICAL_ROOM) throw new Error(WRAPPER_REFUSAL);
    return { eventId: `evt-${send.mock.calls.length}`, mentionPubkeys: [...recipients] };
  });
  const transport: BuzzTransport = {
    openChannel: async (purpose) => `channel:${purpose}`,
    available: async () => true,
    send,
  };
  return { transport, send };
};

type Wake = (roleKey: string) => Promise<Decision<void>>;

const outboxRow = (h: Harness, messageId: string) =>
  h.cp.db.get<{ status: string; binding_generation: number }>(
    `SELECT status, binding_generation FROM outbox WHERE message_id = ?`,
    [messageId],
  );

const dispatchRow = (h: Harness, runId: string) => {
  const row = h.cp.db.get<{ message_id: string; status: string }>(
    `SELECT message_id, status FROM outbox WHERE run_id = ? AND kind = 'RUN_DISPATCH' ORDER BY created_at, rowid LIMIT 1`,
    [runId],
  );
  if (!row) throw new Error("the dispatch enqueued no RUN_DISPATCH row");
  return row;
};

/** A CTO tool call through a real MCP client and server pair, authenticated as `peer`. */
const callCtoTool = async (
  h: Harness,
  peer: { sessionId: string; incarnation: string },
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
  const server = createCtoServer(createCtoMcpPort(h.cp), () =>
    allow(ReasonCode.OK, { actor: `cto:${peer.sessionId}`, sessionId: peer.sessionId, sessionIncarnation: peer.incarnation }),
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "acp-in-band-cto", version: "1" });
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({ name, arguments: args });
    return (result.structuredContent ?? {}) as Record<string, unknown>;
  } finally {
    await client.close();
    await server.close();
  }
};

/**
 * A project whose PRIMARY_CTO is bound the way the canonical self-claim binds one (as in
 * `a-run-does-not-replace-its-canonical-cto.test.ts`), whose session has a room and a channel
 * identity as a live canonical CTO's does. No run exists yet.
 */
const boundCanonical = async () => {
  const { transport, send } = hostTransport();
  const h = makeHarness({ buzzTransport: transport });
  const { projectId, repositoryId } = await registerFixtureProject(h);
  h.cp.providers.register(new TestProductionAdapter(h.clock, "claude"));
  const session = h.cp.sessions.create({ provider: "claude", model: "claude-cli", osPid: process.pid, osStartedAt: liveToken() });
  expect(h.cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "canonical self-claim").allowed).toBe(true);
  h.cp.db.run(`UPDATE sessions SET buzz_address = ?, buzz_actor_id = ? WHERE session_id = ?`, [
    CANONICAL_ROOM,
    "actor:canonical-cto",
    session.sessionId,
  ]);
  const claimed = { executorKind: SELF_CLAIM_EXECUTOR_KIND, targetLocator: CONVERSATION, targetLocatorDigest: sha256(CONVERSATION) };
  const bound = h.cp.bindings.bind({
    role: Role.PRIMARY_CTO,
    projectId,
    sessionId: session.sessionId,
    mode: "PREFERRED",
    authenticatedTarget: {
      claimed,
      protocolVersion: SELF_CLAIM_PROTOCOL,
      attestationDigest: digestOf({ fixture: "canonical-cto-in-band", sessionId: session.sessionId }),
      verify: () => claimed,
    },
  });
  if (!bound.allowed) throw new Error(bound.message);
  return { h, send, projectId, repositoryId, session, bound: bound.value };
};

/** `boundCanonical`, and a run dispatched to it with a wake port attached. */
const dispatchedToCanonical = async (makeWake: (h: Harness) => Wake) => {
  const { h, send, projectId, repositoryId, session, bound } = await boundCanonical();
  const run = h.cp.runs.create({
    projectId,
    executionMode: ExecutionMode.STANDARD,
    contract: CONTRACT,
    repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
  });
  if (!run.allowed) throw new Error(run.message);

  const wakeSpy = vi.fn(makeWake(h));
  h.cp.outbox.attachInBandWake(wakeSpy);
  const claimSpy = vi.spyOn(h.cp.outbox, "claimDeliverable");
  const dispatched = await h.cp.runs.dispatch(run.value.runId);
  if (!dispatched.allowed) throw new Error(`dispatch refused: ${dispatched.reasonCode} ${dispatched.message}`);
  expect(h.cp.runs.require(run.value.runId).state).toBe(RunState.ACTIVE);

  const sessionId = session.sessionId;
  return {
    h,
    send,
    wake: wakeSpy,
    claimSpy,
    projectId,
    roleKey: roleKeyFor(Role.PRIMARY_CTO, { projectId }),
    runId: run.value.runId,
    sessionId,
    incarnation: h.cp.sessions.require(sessionId).incarnation,
    generation: bound.bindingGeneration,
    messageId: dispatchRow(h, run.value.runId).message_id,
  };
};

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const woken = (): Wake => async () => allow(ReasonCode.OK, undefined);

describe("an adopted canonical CTO receives its dispatch in band", () => {
  it("(a) the RUN_DISPATCH is never claimed for Buzz or sent, and the role is woken once after commit", async () => {
    let committedAtWake: { inTransaction: boolean; status: string | undefined } | null = null;
    const f = await dispatchedToCanonical((h) => async () => {
      committedAtWake = {
        inTransaction: h.cp.db.inTransaction,
        status: h.cp.db.get<{ status: string }>(`SELECT status FROM outbox WHERE kind = 'RUN_DISPATCH'`)?.status,
      };
      return allow(ReasonCode.OK, undefined);
    });
    try {
      // The delivery tick, twice: nothing is sent, nothing is claimed, the row stays PENDING.
      const ticks = [await f.h.buzzAdapter.deliverPending(), await f.h.buzzAdapter.deliverPending()];
      expect(f.send).not.toHaveBeenCalled();
      const claimed = f.claimSpy.mock.results.flatMap((result) =>
        (result.value as Array<{ messageId: string }>).map((m) => m.messageId));
      expect(claimed).not.toContain(f.messageId);
      expect(ticks).toEqual([{ delivered: [], failed: [] }, { delivered: [], failed: [] }]);
      expect(f.h.cp.outbox.claimDeliverable()).toEqual([]);
      expect(outboxRow(f.h, f.messageId)?.status).toBe("PENDING");

      expect(f.wake).toHaveBeenCalledTimes(1);
      expect(f.wake).toHaveBeenCalledWith(f.roleKey);
      // The wake ran after the dispatch's transaction committed, and saw the row it points at.
      expect(committedAtWake).toEqual({ inTransaction: false, status: "PENDING" });

      // The periodic pass does not wake the same row again inside the window, and does after it.
      await f.h.cp.outbox.wakeInBandPending();
      expect(f.wake).toHaveBeenCalledTimes(1);
      f.h.clock.advance(IN_BAND_REWAKE_MS);
      await f.h.cp.outbox.wakeInBandPending();
      expect(f.wake).toHaveBeenCalledTimes(2);
      await f.h.cp.outbox.wakeInBandPending();
      expect(f.wake).toHaveBeenCalledTimes(2);
      expect(f.h.cp.audit.byKind("OUTBOX_IN_BAND_WAKE_FAILED")).toHaveLength(0);
    } finally {
      f.h.cp.close();
    }
  });

  it("(a) a wake the role refuses is audited once per window, not retried", async () => {
    const f = await dispatchedToCanonical(() => async (roleKey) =>
      deny(ReasonCode.ROLE_PEER_ABSENT, "no session is currently attached for this role", { roleKey }));
    try {
      await flush();
      const failed = f.h.cp.audit.byKind("OUTBOX_IN_BAND_WAKE_FAILED");
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({ reasonCode: ReasonCode.ROLE_PEER_ABSENT, roleKey: f.roleKey });
      await f.h.cp.outbox.wakeInBandPending();
      await flush();
      expect(f.wake).toHaveBeenCalledTimes(1);
      expect(f.h.cp.audit.byKind("OUTBOX_IN_BAND_WAKE_FAILED")).toHaveLength(1);
      expect(outboxRow(f.h, f.messageId)?.status).toBe("PENDING");
    } finally {
      f.h.cp.close();
    }
  });

  it("(b) role_dispatch_pending lists the row for the exact session only, at its active generation", async () => {
    const f = await dispatchedToCanonical(woken);
    try {
      const listed = await callCtoTool(f.h, { sessionId: f.sessionId, incarnation: f.incarnation }, "role_dispatch_pending", {});
      expect(listed).toMatchObject({ ok: true });
      const messages = (listed.value as { messages: Array<Record<string, unknown>> }).messages;
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({ messageId: f.messageId, kind: MessageKind.RUN_DISPATCH, runId: f.runId });
      expect(messages[0]?.payload).toMatchObject({ runId: f.runId, goal: CONTRACT.goal });
      expect(Object.keys(messages[0] ?? {}).sort()).toEqual(["createdAt", "expiresAt", "kind", "messageId", "payload", "runId"]);

      // Another live session sees nothing; a stale incarnation is refused before any read.
      const other = f.h.cp.sessions.create({ provider: "claude", model: "claude-cli" });
      expect(f.h.cp.sessions.transition(other.sessionId, SessionLifecycle.READY, "another runtime").allowed).toBe(true);
      const otherListed = await callCtoTool(
        f.h,
        { sessionId: other.sessionId, incarnation: f.h.cp.sessions.require(other.sessionId).incarnation },
        "role_dispatch_pending",
        {},
      );
      expect(otherListed).toMatchObject({ ok: true, value: { messages: [] } });
      const stale = await callCtoTool(f.h, { sessionId: f.sessionId, incarnation: "stale-incarnation" }, "role_dispatch_pending", {});
      expect(stale).toMatchObject({ ok: false, reasonCode: ReasonCode.MCP_PEER_UNAUTHENTICATED });
      expect(f.h.cp.outbox.pendingInBandFor(f.sessionId, "stale-incarnation")).toEqual([]);

      // A row addressed to a generation the session does not hold is not listed.
      f.h.cp.db.run(`UPDATE outbox SET binding_generation = ? WHERE message_id = ?`, [f.generation + 1, f.messageId]);
      expect(f.h.cp.outbox.pendingInBandFor(f.sessionId, f.incarnation)).toEqual([]);
      f.h.cp.db.run(`UPDATE outbox SET binding_generation = ? WHERE message_id = ?`, [f.generation, f.messageId]);
      expect(f.h.cp.outbox.pendingInBandFor(f.sessionId, f.incarnation)).toHaveLength(1);
    } finally {
      f.h.cp.close();
    }
  });

  it("(c) run_ack moves the row PENDING -> ACKED for the exact session, after the delivery tick, and refuses others", async () => {
    const f = await dispatchedToCanonical(woken);
    try {
      // The live sequence: the delivery tick runs before the CTO acknowledges.
      await f.h.buzzAdapter.deliverPending();

      const other = f.h.cp.sessions.create({ provider: "claude", model: "claude-cli" });
      expect(f.h.cp.sessions.transition(other.sessionId, SessionLifecycle.READY, "another runtime").allowed).toBe(true);
      expect(f.h.cp.outbox.acknowledge(f.messageId, other.sessionId, f.generation, f.h.cp.sessions.require(other.sessionId).incarnation))
        .toMatchObject({ allowed: false, reasonCode: ReasonCode.OUTBOX_STALE_GENERATION_REJECTED });
      expect(f.h.cp.outbox.acknowledge(f.messageId, f.sessionId, f.generation, "an-old-incarnation"))
        .toMatchObject({ allowed: false, reasonCode: ReasonCode.OUTBOX_STALE_GENERATION_REJECTED });
      const otherAck = await callCtoTool(
        f.h,
        { sessionId: other.sessionId, incarnation: f.h.cp.sessions.require(other.sessionId).incarnation },
        "run_ack",
        { idempotencyKey: "ack-other", runId: f.runId, messageId: f.messageId },
      );
      expect(otherAck).toMatchObject({ ok: false, reasonCode: ReasonCode.MCP_PEER_UNAUTHENTICATED });
      expect(outboxRow(f.h, f.messageId)?.status).toBe("PENDING");
      expect(f.h.cp.audit.byKind("OUTBOX_ACKED_IN_BAND")).toHaveLength(0);

      const acked = await callCtoTool(
        f.h,
        { sessionId: f.sessionId, incarnation: f.incarnation },
        "run_ack",
        { idempotencyKey: "ack-exact", runId: f.runId, messageId: f.messageId },
      );
      expect(acked).toMatchObject({ ok: true, reasonCode: ReasonCode.OK });
      expect(outboxRow(f.h, f.messageId)?.status).toBe("ACKED");
      const audited = f.h.cp.audit.byKind("OUTBOX_ACKED_IN_BAND");
      expect(audited).toHaveLength(1);
      expect(audited[0]).toMatchObject({ runId: f.runId, sessionId: f.sessionId, roleKey: f.roleKey });
      expect(f.h.cp.outbox.pendingInBandFor(f.sessionId, f.incarnation)).toEqual([]);
      expect(f.send).not.toHaveBeenCalled();
    } finally {
      f.h.cp.close();
    }
  });

  it("(c) an expired in-band row is neither listed nor acknowledged", async () => {
    const f = await dispatchedToCanonical(woken);
    try {
      f.h.clock.advance(31 * 60 * 1000);
      expect(f.h.cp.outbox.pendingInBandFor(f.sessionId, f.incarnation)).toEqual([]);
      expect(f.h.cp.outbox.acknowledge(f.messageId, f.sessionId, f.generation, f.incarnation))
        .toMatchObject({ allowed: false, reasonCode: ReasonCode.OUTBOX_EXPIRED });
      expect(outboxRow(f.h, f.messageId)?.status).not.toBe("ACKED");
      expect(f.h.cp.audit.byKind("OUTBOX_ACKED_IN_BAND")).toHaveLength(0);
    } finally {
      f.h.cp.close();
    }
  });

  type Fixture = Awaited<ReturnType<typeof dispatchedToCanonical>>;
  const rowOfKind = (f: Fixture, kind: string): string => {
    const row = f.h.cp.db.get<{ message_id: string }>(
      `SELECT message_id FROM outbox WHERE kind = ? AND target_session_id = ? ORDER BY created_at, rowid LIMIT 1`,
      [kind, f.sessionId],
    );
    if (!row) throw new Error(`no ${kind} row was enqueued for the canonical CTO`);
    return row.message_id;
  };

  it.each([
    [
      MessageKind.ESCALATION_REPLY,
      "the CEO's escalation resolution",
      (f: Fixture) => {
        const ceo = bindCeo(f.h);
        const resolved = f.h.cp.ceo.resolveEscalation(f.runId, "take option A", ceo);
        if (!resolved.allowed) throw new Error(resolved.message);
      },
    ],
    [
      MessageKind.DRAIN_REQUEST,
      "a replacement request",
      (f: Fixture) => {
        const drained = f.h.cp.cto.requestReplacement(f.projectId, "operator replacement");
        if (!drained.allowed) throw new Error(drained.message);
      },
    ],
    [
      MessageKind.REVISION_REQUEST,
      "a revision returned to the CTO (CandidatePipeline.returnToCto's envelope)",
      (f: Fixture) => {
        const binding = f.h.cp.bindings.active(f.roleKey);
        if (!binding) throw new Error("the canonical CTO holds no binding");
        const queued = f.h.cp.outbox.enqueue({
          idempotencyKey: `revision:${f.runId}:sha256:candidate:${ReasonCode.SNAPSHOT_STALE}`,
          roleKey: binding.roleKey,
          bindingGeneration: binding.bindingGeneration,
          targetSessionId: binding.sessionId,
          runId: f.runId,
          kind: MessageKind.REVISION_REQUEST,
          payload: { runId: f.runId, reasonCode: ReasonCode.SNAPSHOT_STALE, candidateSnapshotDigest: "sha256:candidate" },
        });
        if (!queued.allowed) throw new Error(queued.message);
      },
    ],
  ] as const)("(f) %s from %s is withheld from Buzz, woken for, listed and acknowledged in band", async (kind, _from, produce) => {
    const f = await dispatchedToCanonical(woken);
    try {
      const wakesBefore = f.wake.mock.calls.length;
      produce(f);
      const messageId = rowOfKind(f, kind);
      const wakesAfter = f.wake.mock.calls.length;

      await f.h.buzzAdapter.deliverPending();
      expect(f.send).not.toHaveBeenCalled();
      expect(outboxRow(f.h, messageId)?.status).toBe("PENDING");
      expect(wakesAfter).toBe(wakesBefore + 1);

      const peer = { sessionId: f.sessionId, incarnation: f.incarnation };
      const listed = await callCtoTool(f.h, peer, "role_dispatch_pending", {});
      const messages = ((listed.value ?? { messages: [] }) as { messages: Array<{ messageId: string; kind: string }> }).messages;
      expect(messages.map((m) => [m.messageId, m.kind])).toContainEqual([messageId, kind]);

      const acked = await callCtoTool(f.h, peer, "run_ack", { idempotencyKey: `ack-${kind}`, runId: f.runId, messageId });
      expect(acked).toMatchObject({ ok: true, reasonCode: ReasonCode.OK });
      expect(outboxRow(f.h, messageId)?.status).toBe("ACKED");
      expect(f.h.cp.audit.byKind("OUTBOX_ACKED_IN_BAND").map((row) => (row.evidence as { messageId?: string }).messageId))
        .toContain(messageId);
    } finally {
      f.h.cp.close();
    }
  });

  it("(g) a canonical CTO that owns no run settles a drain request with role_dispatch_ack, and only its own", async () => {
    const { h, send, projectId, session, bound } = await boundCanonical();
    try {
      const sessionId = session.sessionId;
      const peer = { sessionId, incarnation: h.cp.sessions.require(sessionId).incarnation };
      expect(h.cp.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM runs`)?.n).toBe(0);
      const drained = h.cp.cto.requestReplacement(projectId, "operator replacement");
      if (!drained.allowed) throw new Error(drained.message);
      const row = h.cp.db.get<{ message_id: string; run_id: string | null }>(
        `SELECT message_id, run_id FROM outbox WHERE kind = 'DRAIN_REQUEST' AND target_session_id = ?`,
        [sessionId],
      );
      if (!row) throw new Error("the replacement enqueued no DRAIN_REQUEST");
      const messageId = row.message_id;
      expect(row.run_id).toBeNull();

      await h.buzzAdapter.deliverPending();
      expect(send).not.toHaveBeenCalled();
      const listed = await callCtoTool(h, peer, "role_dispatch_pending", {});
      expect(listed).toMatchObject({ ok: true, value: { messages: [{ messageId, kind: MessageKind.DRAIN_REQUEST, runId: null }] } });

      // Another live session, the role's generation moved on, and an old incarnation: all refused.
      const other = h.cp.sessions.create({ provider: "claude", model: "claude-cli" });
      expect(h.cp.sessions.transition(other.sessionId, SessionLifecycle.READY, "another runtime").allowed).toBe(true);
      const otherPeer = { sessionId: other.sessionId, incarnation: h.cp.sessions.require(other.sessionId).incarnation };
      expect(await callCtoTool(h, otherPeer, "role_dispatch_ack", { messageId }))
        .toMatchObject({ ok: false, reasonCode: ReasonCode.OUTBOX_STALE_GENERATION_REJECTED });
      h.cp.db.run(`UPDATE outbox SET binding_generation = ? WHERE message_id = ?`, [bound.bindingGeneration + 1, messageId]);
      expect(await callCtoTool(h, peer, "role_dispatch_ack", { messageId }))
        .toMatchObject({ ok: false, reasonCode: ReasonCode.OUTBOX_STALE_GENERATION_REJECTED });
      h.cp.db.run(`UPDATE outbox SET binding_generation = ? WHERE message_id = ?`, [bound.bindingGeneration, messageId]);
      expect(await callCtoTool(h, { sessionId, incarnation: "an-old-incarnation" }, "role_dispatch_ack", { messageId }))
        .toMatchObject({ ok: false, reasonCode: ReasonCode.MCP_PEER_UNAUTHENTICATED });
      expect(h.cp.outbox.acknowledgeInBand(messageId, sessionId, "an-old-incarnation"))
        .toMatchObject({ allowed: false, reasonCode: ReasonCode.OUTBOX_STALE_GENERATION_REJECTED });
      expect(outboxRow(h, messageId)?.status).toBe("PENDING");
      expect(h.cp.audit.byKind("OUTBOX_ACKED_IN_BAND")).toHaveLength(0);

      expect(await callCtoTool(h, peer, "role_dispatch_ack", { messageId })).toMatchObject({ ok: true, reasonCode: ReasonCode.OK });
      expect(outboxRow(h, messageId)?.status).toBe("ACKED");
      const audited = h.cp.audit.byKind("OUTBOX_ACKED_IN_BAND");
      expect(audited).toHaveLength(1);
      expect(audited[0]).toMatchObject({ sessionId, runId: null, evidence: { messageId, kind: MessageKind.DRAIN_REQUEST } });
      // Settled once: a second acknowledgement is refused, and nothing is listed.
      expect(await callCtoTool(h, peer, "role_dispatch_ack", { messageId }))
        .toMatchObject({ ok: false, reasonCode: ReasonCode.OUTBOX_STALE_GENERATION_REJECTED });
      expect(await callCtoTool(h, peer, "role_dispatch_pending", {})).toMatchObject({ ok: true, value: { messages: [] } });
    } finally {
      h.cp.close();
    }
  });

  it("(g) role_dispatch_ack refuses a holder-claimed row and a row that is not in band", async () => {
    const f = await dispatchedToCanonical(woken);
    try {
      const peer = { sessionId: f.sessionId, incarnation: f.incarnation };
      const owner = f.h.cp.outbox.enqueue({
        idempotencyKey: "owner-message:in-band-ack-control",
        roleKey: f.roleKey,
        bindingGeneration: f.generation,
        targetSessionId: f.sessionId,
        runId: null,
        kind: MessageKind.OWNER_MESSAGE,
        payload: { channel: "buzz", nonce: "in-band-ack-control" },
      });
      if (!owner.allowed) throw new Error(owner.message);
      expect(await callCtoTool(f.h, peer, "role_dispatch_ack", { messageId: owner.value.messageId }))
        .toMatchObject({ ok: false, reasonCode: ReasonCode.INVALID_ARGUMENT });
      expect(outboxRow(f.h, owner.value.messageId)?.status).toBe("PENDING");
      // A CEO notification is outward but not in band: it stays Buzz's to deliver.
      const ceo = bindCeo(f.h);
      const notified = f.h.cp.ceo.notify(NotificationKind.TRUE_ESCALATION, f.runId, { question: "q" });
      if (!notified.allowed) throw new Error(notified.message);
      const notice = f.h.cp.db.get<{ message_id: string }>(
        `SELECT message_id FROM outbox WHERE kind = 'CEO_NOTIFICATION' AND target_session_id = ?`,
        [ceo],
      );
      if (!notice) throw new Error("no CEO notification was enqueued");
      expect(await callCtoTool(f.h, peer, "role_dispatch_ack", { messageId: notice.message_id }))
        .toMatchObject({ ok: false, reasonCode: ReasonCode.INVALID_ARGUMENT });
      expect(f.h.cp.audit.byKind("OUTBOX_ACKED_IN_BAND")).toHaveLength(0);
    } finally {
      f.h.cp.close();
    }
  });

  it("(d) control: a CTO the adapter launched still gets its dispatch through claimDeliverable and Buzz", async () => {
    const { transport, send } = hostTransport();
    const h = makeHarness({ buzzTransport: transport });
    try {
      const { projectId, repositoryId } = await registerFixtureProject(h);
      const run = h.cp.runs.create({
        projectId,
        executionMode: ExecutionMode.STANDARD,
        contract: CONTRACT,
        repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
      });
      if (!run.allowed) throw new Error(run.message);
      const wake = vi.fn(woken());
      h.cp.outbox.attachInBandWake(wake);
      const dispatched = await h.cp.runs.dispatch(run.value.runId);
      if (!dispatched.allowed) throw new Error(`dispatch refused: ${dispatched.reasonCode} ${dispatched.message}`);
      const owner = h.cp.runs.require(run.value.runId);
      if (!owner.ownerSessionId || owner.ownerBindingGeneration === null) throw new Error("the run has no owner");
      h.cp.db.run(`UPDATE sessions SET buzz_address = 'cto-room', buzz_actor_id = 'actor:cto' WHERE session_id = ?`, [
        owner.ownerSessionId,
      ]);
      const messageId = dispatchRow(h, run.value.runId).message_id;

      expect(wake).not.toHaveBeenCalled();
      expect(h.cp.outbox.pendingInBandFor(owner.ownerSessionId, h.cp.sessions.require(owner.ownerSessionId).incarnation)).toEqual([]);
      const delivered = await h.buzzAdapter.deliverPending();
      expect(delivered.delivered).toContain(messageId);
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0]?.[0]).toBe("cto-room");
      expect(send.mock.calls[0]?.[1]).toContain(messageId);
      expect(outboxRow(h, messageId)?.status).toBe("SENT");

      await h.cp.outbox.wakeInBandPending();
      expect(wake).not.toHaveBeenCalled();
      expect(h.cp.outbox.acknowledge(messageId, owner.ownerSessionId, owner.ownerBindingGeneration)).toMatchObject({ allowed: true });
      expect(outboxRow(h, messageId)?.status).toBe("ACKED");
      expect(h.cp.audit.byKind("OUTBOX_ACKED_IN_BAND")).toHaveLength(0);
    } finally {
      h.cp.close();
    }
  });

  it("(e) a holder-claimed kind addressed to the canonical CTO is still refused by run_ack and never listed", async () => {
    const f = await dispatchedToCanonical(woken);
    try {
      const wakesBefore = f.wake.mock.calls.length;
      const queued = f.h.cp.outbox.enqueue({
        idempotencyKey: "owner-message:in-band-control",
        roleKey: f.roleKey,
        bindingGeneration: f.generation,
        targetSessionId: f.sessionId,
        runId: null,
        kind: MessageKind.OWNER_MESSAGE,
        payload: { channel: "buzz", nonce: "in-band-control" },
      });
      if (!queued.allowed) throw new Error(queued.message);
      // A holder-claimed row is not in band: enqueueing it wakes nothing through this path.
      expect(f.wake.mock.calls.length).toBe(wakesBefore);

      const acked = await callCtoTool(
        f.h,
        { sessionId: f.sessionId, incarnation: f.incarnation },
        "run_ack",
        { idempotencyKey: "ack-owner-message", runId: f.runId, messageId: queued.value.messageId },
      );
      expect(acked).toMatchObject({ ok: false, reasonCode: ReasonCode.INVALID_ARGUMENT });
      expect(outboxRow(f.h, queued.value.messageId)?.status).toBe("PENDING");
      expect(f.h.cp.outbox.pendingInBandFor(f.sessionId, f.incarnation).map((m) => m.messageId))
        .not.toContain(queued.value.messageId);
    } finally {
      f.h.cp.close();
    }
  });
});
