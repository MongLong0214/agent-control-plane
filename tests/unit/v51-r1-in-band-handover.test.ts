import { afterAll, expect, it, vi } from "vitest";

import type { BuzzSendReceipt, BuzzTransport } from "../../src/buzz/buzz-adapter.ts";
import { digestOf, sha256 } from "../../src/core/digest.ts";
import { allow } from "../../src/core/errors.ts";
import { readProcessStartToken } from "../../src/core/process-argv.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ExecutionMode, Role, RunState, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { MessageKind } from "../../src/outbox/envelope.ts";
import { SELF_CLAIM_EXECUTOR_KIND, SELF_CLAIM_PROTOCOL } from "../../src/registry/canonical-self-claim.ts";
import type { TaskContract } from "../../src/run/run-engine.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { bindCeo, makeHarness, registerFixtureProject, type Harness } from "../helpers/harness.ts";
import { TestProductionAdapter } from "../helpers/production-adapter.ts";

afterAll(cleanupTempDirs);

/**
 * ACP-R1-01 — one handover policy for actionable in-band instructions. A surviving runtime move, a
 * revoke followed by an authenticated rebinding, and a takeover each hand a still-actionable
 * instruction to the successor with its original message id; an instruction whose run has ended is
 * superseded explicitly, with its reason recorded in the same transaction. Nothing is discarded by
 * the handover itself, however many times the role is recovered.
 */

const CONVERSATION = "55555555-5555-4555-8555-555555555555";
const CANONICAL_ROOM = "canonical-cto-room";
const SUCCESSOR_ROOM = "successor-cto-room";

const CONTRACT: TaskContract = {
  goal: "a run whose instructions must survive holder recovery",
  why: "an actionable instruction is never lost to a handover",
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

const recordingTransport = () => {
  const send = vi.fn(async (channel: string, _content: string, recipients: readonly string[]): Promise<BuzzSendReceipt> => {
    if (channel === CANONICAL_ROOM) throw new Error("mention_policy: signer not registered for channel");
    return { eventId: `evt-${send.mock.calls.length}`, mentionPubkeys: [...recipients] };
  });
  const transport: BuzzTransport = { openChannel: async (purpose) => `channel:${purpose}`, available: async () => true, send };
  return { transport, send };
};

const claimedTarget = { executorKind: SELF_CLAIM_EXECUTOR_KIND, targetLocator: CONVERSATION, targetLocatorDigest: sha256(CONVERSATION) };

/**
 * A canonical runtime of the conversation, READY, answering on the canonical room. The channel
 * identity is taken only when no live runtime still holds it.
 */
const canonicalRuntime = (h: Harness, takeIdentity = true) => {
  const session = h.cp.sessions.create({ provider: "claude", model: "claude-cli", osPid: process.pid, osStartedAt: liveToken() });
  expect(h.cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "canonical self-claim").allowed).toBe(true);
  h.cp.db.run("UPDATE sessions SET buzz_address = ?, buzz_actor_id = ? WHERE session_id = ?",
    [CANONICAL_ROOM, takeIdentity ? "actor:canonical-cto" : null, session.sessionId]);
  return { sessionId: session.sessionId, incarnation: h.cp.sessions.require(session.sessionId).incarnation };
};

/** Binds the PRIMARY_CTO the way the canonical self-claim binds one: an authenticated target. */
const bindCanonical = (h: Harness, projectId: string, sessionId: string) => {
  const bound = h.cp.bindings.bind({
    role: Role.PRIMARY_CTO, projectId, sessionId, mode: "PREFERRED",
    authenticatedTarget: {
      claimed: claimedTarget, protocolVersion: SELF_CLAIM_PROTOCOL,
      attestationDigest: digestOf({ fixture: "v51-r1-in-band", sessionId }), verify: () => claimedTarget,
    },
  });
  if (!bound.allowed) throw new Error(bound.message);
  return bound.value;
};

/** A provider-launched successor with its own room and channel identity. */
const launchedRuntime = (h: Harness, identity: string) => {
  const session = h.cp.sessions.create({ provider: "claude", model: "claude-cli", buzzAddress: SUCCESSOR_ROOM });
  expect(h.cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "launched").allowed).toBe(true);
  h.cp.db.run("UPDATE sessions SET buzz_actor_id = ? WHERE session_id = ?", [identity, session.sessionId]);
  return { sessionId: session.sessionId, incarnation: h.cp.sessions.require(session.sessionId).incarnation };
};

const dispatched = async () => {
  const { transport, send } = recordingTransport();
  const h = makeHarness({ buzzTransport: transport });
  const { projectId, repositoryId } = await registerFixtureProject(h);
  h.cp.providers.register(new TestProductionAdapter(h.clock, "claude"));
  const first = canonicalRuntime(h);
  const bound = bindCanonical(h, projectId, first.sessionId);
  const run = h.cp.runs.create({ projectId, executionMode: ExecutionMode.STANDARD, contract: CONTRACT,
    repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }] });
  if (!run.allowed) throw new Error(run.message);
  const wake = vi.fn(async () => allow(ReasonCode.OK, undefined));
  h.cp.outbox.attachInBandWake(wake);
  const started = await h.cp.runs.dispatch(run.value.runId);
  if (!started.allowed) throw new Error(`dispatch refused: ${started.reasonCode} ${started.message}`);
  const row = h.cp.db.get<{ message_id: string }>(
    "SELECT message_id FROM outbox WHERE run_id = ? AND kind = 'RUN_DISPATCH' ORDER BY created_at, rowid LIMIT 1", [run.value.runId]);
  if (!row) throw new Error("the dispatch enqueued no RUN_DISPATCH row");
  return { h, send, wake, projectId, repositoryId, roleKey: roleKeyFor(Role.PRIMARY_CTO, { projectId }), runId: run.value.runId,
    first, generation: bound.bindingGeneration, dispatchId: row.message_id };
};

type Fixture = Awaited<ReturnType<typeof dispatched>>;

const row = (f: Fixture, messageId: string) =>
  f.h.cp.db.get<{ status: string; binding_generation: number; target_session_id: string; reason_code: string | null }>(
    "SELECT status, binding_generation, target_session_id, reason_code FROM outbox WHERE message_id = ?", [messageId]);

const pendingFor = (f: Fixture, runtime: { sessionId: string; incarnation: string }) =>
  f.h.cp.outbox.pendingInBandFor(runtime.sessionId, runtime.incarnation).map((m) => m.messageId);

const takeOver = (f: Fixture, identity: string) => {
  const next = launchedRuntime(f.h, identity);
  const moved = f.h.cp.bindings.switchTo({ role: Role.PRIMARY_CTO, projectId: f.projectId, sessionId: next.sessionId,
    conversation: "REPLACED", reason: "holder recovery", takeover: true });
  if (!moved.allowed) throw new Error(moved.message);
  return { ...next, generation: moved.value.bindingGeneration };
};

it("a surviving runtime move hands the unACKed RUN_DISPATCH to the successor, and the fence keeps it", async () => {
  const f = await dispatched();
  try {
    const next = canonicalRuntime(f.h, false);
    const moved = f.h.cp.bindings.switchTo({ role: Role.PRIMARY_CTO, projectId: f.projectId, sessionId: next.sessionId,
      conversation: "SURVIVED", reason: "same authenticated conversation" });
    expect(moved.allowed).toBe(true);
    expect(pendingFor(f, next)).toContain(f.dispatchId);
    f.h.cp.outbox.fenceUndeliverable();
    expect(row(f, f.dispatchId)).toMatchObject({ status: "PENDING", target_session_id: next.sessionId, binding_generation: f.generation });
    // The outgoing runtime cannot settle what it no longer holds; the successor can.
    expect(f.h.cp.outbox.acknowledgeInBand(f.dispatchId, f.first.sessionId, f.first.incarnation).allowed).toBe(false);
    expect(f.h.cp.outbox.acknowledgeInBand(f.dispatchId, next.sessionId, next.incarnation).allowed).toBe(true);
    expect(row(f, f.dispatchId)?.status).toBe("ACKED");
  } finally { f.h.cp.close(); }
});

it("an allowed revoke of a blocked owner keeps its dispatch for the next authenticated binding of the conversation", async () => {
  const f = await dispatched();
  try {
    expect(f.h.cp.runs.transition(f.runId, RunState.BLOCKED, "CEO_DECISION_REQUIRED").allowed).toBe(true);
    expect(f.h.cp.bindings.revoke(f.roleKey, "recover holder", { allowBlockedRuns: true }).allowed).toBe(true);
    expect(row(f, f.dispatchId)?.status).toBe("PENDING");
    f.h.cp.outbox.fenceUndeliverable();
    f.h.clock.advance(31 * 60_000);
    f.h.cp.outbox.expireOverdue();
    expect(row(f, f.dispatchId)?.status).toBe("PENDING");

    expect(f.h.cp.sessions.transition(f.first.sessionId, SessionLifecycle.STOPPED, "dead").allowed).toBe(true);
    const next = canonicalRuntime(f.h);
    const rebound = bindCanonical(f.h, f.projectId, next.sessionId);
    expect(row(f, f.dispatchId)).toMatchObject({ status: "PENDING", binding_generation: rebound.bindingGeneration,
      target_session_id: next.sessionId });
    expect(pendingFor(f, next)).toEqual([f.dispatchId]);
    expect(f.h.cp.outbox.acknowledgeInBand(f.dispatchId, next.sessionId, next.incarnation).allowed).toBe(true);
  } finally { f.h.cp.close(); }
});

it("a takeover hands an undelivered REVISION_REQUEST to the successor with its original id", async () => {
  const f = await dispatched();
  try {
    const revision = f.h.cp.outbox.enqueue({ idempotencyKey: "pending-revision", roleKey: f.roleKey, bindingGeneration: f.generation,
      targetSessionId: f.first.sessionId, runId: f.runId, kind: MessageKind.REVISION_REQUEST,
      payload: { runId: f.runId, instruction: "fix reviewer findings" } });
    if (!revision.allowed) throw new Error(revision.message);
    const next = takeOver(f, "actor:successor");
    expect(row(f, revision.value.messageId)).toMatchObject({ status: "PENDING", binding_generation: next.generation,
      target_session_id: next.sessionId });
    // The successor is reached on its own route.
    const delivered = await f.h.buzzAdapter.deliverPending();
    expect(delivered.delivered).toContain(revision.value.messageId);
    expect(f.send).toHaveBeenCalledWith(SUCCESSOR_ROOM, expect.stringContaining(revision.value.messageId), ["actor:successor"]);
  } finally { f.h.cp.close(); }
});

it("an in-band ESCALATION_REPLY survives repeated holder recovery and is settled by the last holder", async () => {
  const f = await dispatched();
  try {
    const ceo = bindCeo(f.h);
    const opened = f.h.cp.ceo.openEscalation({ runId: f.runId, question: "which option?", options: ["a", "b"], ctoRecommendation: "a",
      whyItMatters: "blocks the run", blocksCriticalPath: true, openedBySessionId: f.first.sessionId, openedAt: f.h.clock.nowIso() });
    if (!opened.allowed || opened.value.escalationId === null) throw new Error("the escalation was not opened");
    const resolved = f.h.cp.ceo.resolveEscalation(f.runId, "take option a", ceo, { escalationId: opened.value.escalationId });
    if (!resolved.allowed || resolved.value.messageId === null) throw new Error("the resolution enqueued no reply");
    const replyId = resolved.value.messageId;
    expect(pendingFor(f, f.first)).toContain(replyId);

    const second = takeOver(f, "actor:second");
    expect(row(f, replyId)).toMatchObject({ status: "PENDING", target_session_id: second.sessionId });
    const third = takeOver(f, "actor:third");
    expect(row(f, replyId)).toMatchObject({ status: "PENDING", binding_generation: third.generation, target_session_id: third.sessionId });
    // The holders it passed through can no longer settle it.
    expect(f.h.cp.outbox.acknowledge(replyId, second.sessionId, second.generation).allowed).toBe(false);
    const delivered = await f.h.buzzAdapter.deliverPending();
    expect(delivered.delivered).toContain(replyId);
    expect(f.h.cp.outbox.acknowledge(replyId, third.sessionId, third.generation).allowed).toBe(true);
    expect(row(f, replyId)?.status).toBe("ACKED");
  } finally { f.h.cp.close(); }
});

it("supersedes an in-band instruction whose run has ended, recording the reason atomically with the handover", async () => {
  const f = await dispatched();
  try {
    expect(f.h.cp.runs.transition(f.runId, RunState.CANCELLED, "operator cancelled").allowed).toBe(true);
    expect(row(f, f.dispatchId)?.status).toBe("PENDING");
    expect(f.h.cp.bindings.revoke(f.roleKey, "recover holder").allowed).toBe(true);
    expect(row(f, f.dispatchId)).toMatchObject({ status: "REJECTED", reason_code: ReasonCode.RUN_ALREADY_TERMINAL });
    const superseded = f.h.cp.audit.byKind("OUTBOX_INSTRUCTION_SUPERSEDED");
    expect(superseded).toHaveLength(1);
    expect(superseded[0]).toMatchObject({ runId: f.runId, roleKey: f.roleKey,
      evidence: { messageId: f.dispatchId, kind: MessageKind.RUN_DISPATCH, reason: "RUN_TERMINAL", runState: RunState.CANCELLED } });
  } finally { f.h.cp.close(); }
});

it("a switchTo with no active binding, after a revoke, hands the kept dispatch and queued owner mail to the new holder", async () => {
  const f = await dispatched();
  try {
    const owner = f.h.cp.outbox.enqueue({ idempotencyKey: "owner-message:switch-after-revoke", roleKey: f.roleKey,
      bindingGeneration: f.generation, targetSessionId: f.first.sessionId, runId: null, kind: MessageKind.OWNER_MESSAGE,
      payload: { channel: "buzz", nonce: "switch-after-revoke" } });
    if (!owner.allowed) throw new Error(owner.message);
    expect(f.h.cp.runs.transition(f.runId, RunState.BLOCKED, "CEO_DECISION_REQUIRED").allowed).toBe(true);
    expect(f.h.cp.bindings.revoke(f.roleKey, "recover holder", { allowBlockedRuns: true }).allowed).toBe(true);
    expect(f.h.cp.sessions.transition(f.first.sessionId, SessionLifecycle.STOPPED, "dead").allowed).toBe(true);
    expect(f.h.cp.bindings.active(f.roleKey)).toBeNull();

    const next = launchedRuntime(f.h, "actor:after-revoke");
    const switched = f.h.cp.bindings.switchTo({ role: Role.PRIMARY_CTO, projectId: f.projectId, sessionId: next.sessionId,
      conversation: "REPLACED", reason: "the role is bound again after its revoke" });
    if (!switched.allowed) throw new Error(switched.message);
    const generation = switched.value.bindingGeneration;
    expect(row(f, f.dispatchId)).toMatchObject({ status: "PENDING", binding_generation: generation, target_session_id: next.sessionId });
    expect(row(f, owner.value.messageId)).toMatchObject({ status: "PENDING", binding_generation: generation,
      target_session_id: next.sessionId });
    const delivered = await f.h.buzzAdapter.deliverPending();
    expect(delivered.delivered).toContain(f.dispatchId);
    expect(f.send).toHaveBeenCalledWith(SUCCESSOR_ROOM, expect.stringContaining(f.dispatchId), ["actor:after-revoke"]);
  } finally { f.h.cp.close(); }
});

it("a stopped Buzz-route holder's actionable instructions are kept for the next holder, and a dead run's are superseded", async () => {
  const f = await dispatched();
  try {
    const holder = takeOver(f, "actor:buzz-holder");
    const other = f.h.cp.runs.create({ projectId: f.projectId, executionMode: ExecutionMode.STANDARD, contract: CONTRACT,
      repositories: [{ repositoryId: f.repositoryId, repositoryRole: "primary", baseBranch: "dev" }] });
    if (!other.allowed) throw new Error(other.message);
    expect(f.h.cp.runs.transition(other.value.runId, RunState.CANCELLED, "operator cancelled").allowed).toBe(true);
    const enqueue = (key: string, runId: string) => {
      const queued = f.h.cp.outbox.enqueue({ idempotencyKey: key, roleKey: f.roleKey, bindingGeneration: holder.generation,
        targetSessionId: holder.sessionId, runId, kind: MessageKind.REVISION_REQUEST, payload: { runId, instruction: key } });
      if (!queued.allowed) throw new Error(queued.message);
      return queued.value.messageId;
    };
    const live = enqueue("revision-for-the-live-run", f.runId);
    const dead = enqueue("revision-for-a-cancelled-run", other.value.runId);

    expect(f.h.cp.sessions.transition(holder.sessionId, SessionLifecycle.STOPPED, "the Buzz-route holder died").allowed).toBe(true);
    expect(row(f, live)).toMatchObject({ status: "PENDING", target_session_id: holder.sessionId });
    expect(row(f, dead)).toMatchObject({ status: "REJECTED", reason_code: ReasonCode.RUN_ALREADY_TERMINAL });
    expect(f.h.cp.audit.byKind("OUTBOX_INSTRUCTION_SUPERSEDED")).toEqual([expect.objectContaining({
      runId: other.value.runId, evidence: expect.objectContaining({ messageId: dead, reason: "RUN_TERMINAL", path: "SESSION_STOPPED" }),
    })]);
    // Neither the delivery sweep's fence nor the delivery window disposes of it while nobody holds it.
    f.h.clock.advance(31 * 60_000);
    expect(await f.h.buzzAdapter.deliverPending()).toMatchObject({ failed: [] });
    expect(row(f, live)?.status).toBe("PENDING");

    // The next authenticated holder is handed it with its original id and a fresh delivery window.
    const next = takeOver(f, "actor:next-holder");
    expect(row(f, live)).toMatchObject({ status: "PENDING", binding_generation: next.generation, target_session_id: next.sessionId });
    const delivered = await f.h.buzzAdapter.deliverPending();
    expect(delivered.delivered).toContain(live);
    expect(f.send).toHaveBeenCalledWith(SUCCESSOR_ROOM, expect.stringContaining(live), ["actor:next-holder"]);
  } finally { f.h.cp.close(); }
});
