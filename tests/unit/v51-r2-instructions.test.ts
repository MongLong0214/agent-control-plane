import { afterAll, expect, it, vi } from "vitest";

import type { BuzzSendReceipt, BuzzTransport } from "../../src/buzz/buzz-adapter.ts";
import { digestOf, sha256 } from "../../src/core/digest.ts";
import { allow } from "../../src/core/errors.ts";
import { readProcessStartToken } from "../../src/core/process-argv.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ExecutionMode, Role, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { SELF_CLAIM_EXECUTOR_KIND, SELF_CLAIM_PROTOCOL } from "../../src/registry/canonical-self-claim.ts";
import type { TaskContract } from "../../src/run/run-engine.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { makeHarness, registerFixtureProject, type Harness } from "../helpers/harness.ts";
import { TestProductionAdapter } from "../helpers/production-adapter.ts";

afterAll(cleanupTempDirs);

/**
 * ACP-R1-01, review round 2 — an actionable instruction is ended only by an ACK or a recorded
 * supersession, on every route. A Buzz-delivered instruction that was sent but never ACKed follows
 * the next recovery with its id (at-least-once), and no delivery TTL expires one, for a live holder
 * or a missing one. Ported from the round-2 review's probes.
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

const takeOver = (f: Fixture, identity: string) => {
  const next = launchedRuntime(f.h, identity);
  const moved = f.h.cp.bindings.switchTo({ role: Role.PRIMARY_CTO, projectId: f.projectId, sessionId: next.sessionId,
    conversation: "REPLACED", reason: "holder recovery", takeover: true });
  if (!moved.allowed) throw new Error(moved.message);
  return { ...next, generation: moved.value.bindingGeneration };
};

it("review: a carried instruction survives the live Buzz holder's TTL", async () => {
  const f = await dispatched();
  try {
    const next = takeOver(f, "actor:late");
    expect(row(f, f.dispatchId)).toMatchObject({ status: "PENDING", target_session_id: next.sessionId });
    f.h.clock.advance(31 * 60_000);
    f.h.cp.outbox.expireOverdue();
    expect(row(f, f.dispatchId)?.status).toBe("PENDING");
    // Still delivered to the live holder, and still settled by its ACK, past the window.
    expect((await f.h.buzzAdapter.deliverPending()).delivered).toContain(f.dispatchId);
    expect(f.h.cp.outbox.acknowledge(f.dispatchId, next.sessionId, next.generation, next.incarnation).allowed).toBe(true);
    expect(row(f, f.dispatchId)?.status).toBe("ACKED");
  } finally { f.h.cp.close(); }
});

it("review: a carried instruction sent over Buzz follows the next recovery until ACK", async () => {
  const f = await dispatched();
  try {
    const second = takeOver(f, "actor:second-sent");
    expect((await f.h.buzzAdapter.deliverPending()).delivered).toContain(f.dispatchId);
    expect(row(f, f.dispatchId)?.status).toBe("SENT");
    const third = takeOver(f, "actor:third-sent");
    expect(row(f, f.dispatchId)).toMatchObject({ status: "PENDING", target_session_id: third.sessionId });
    expect(f.h.cp.outbox.acknowledge(f.dispatchId, second.sessionId, second.generation).allowed).toBe(false);
    expect((await f.h.buzzAdapter.deliverPending()).delivered).toContain(f.dispatchId);
    expect(f.h.cp.outbox.acknowledge(f.dispatchId, third.sessionId, third.generation, third.incarnation).allowed).toBe(true);
  } finally { f.h.cp.close(); }
});

it("an unACKed SENT instruction is kept when its Buzz holder stops, and handed to the next holder", async () => {
  const f = await dispatched();
  try {
    const holder = takeOver(f, "actor:sent-then-stopped");
    expect((await f.h.buzzAdapter.deliverPending()).delivered).toContain(f.dispatchId);
    expect(row(f, f.dispatchId)?.status).toBe("SENT");
    expect(f.h.cp.sessions.transition(holder.sessionId, SessionLifecycle.STOPPED, "died before ACK").allowed).toBe(true);
    // Kept as it is for the next holder: never re-sent to the receiver that may already have it.
    expect(row(f, f.dispatchId)?.status).toBe("SENT");
    f.h.cp.outbox.fenceUndeliverable();
    f.h.clock.advance(31 * 60_000);
    f.h.cp.outbox.expireOverdue();
    expect(row(f, f.dispatchId)?.status).toBe("SENT");
    const next = takeOver(f, "actor:after-the-stop");
    expect(row(f, f.dispatchId)).toMatchObject({ status: "PENDING", target_session_id: next.sessionId });
    expect((await f.h.buzzAdapter.deliverPending()).delivered).toContain(f.dispatchId);
  } finally { f.h.cp.close(); }
});

it("a Buzz delivery that keeps failing never ends an actionable instruction", async () => {
  const f = await dispatched();
  try {
    takeOver(f, "actor:unreachable");
    // A cause that can clear on its own: retried on the backoff, with no attempt budget.
    f.send.mockRejectedValue(new Error("relay temporarily unavailable"));
    for (let i = 0; i < 7; i += 1) {
      await f.h.buzzAdapter.deliverPending();
      f.h.clock.advance(31 * 60_000);
    }
    expect(row(f, f.dispatchId)?.status).toBe("PENDING");
    f.send.mockImplementation(async (_channel: string, _content: string, recipients: readonly string[]) =>
      ({ eventId: "recovered", mentionPubkeys: [...recipients] }));
    expect((await f.h.buzzAdapter.deliverPending()).delivered).toContain(f.dispatchId);
  } finally { f.h.cp.close(); }
});

// CEO decision 9b15c462: an authority refusal is retained and flagged, and no route change reactivates it.
it("a refused Buzz delivery keeps the instruction, unsent into the same refusal, and a takeover does not reactivate it", async () => {
  const f = await dispatched();
  try {
    takeOver(f, "actor:refused");
    f.send.mockRejectedValue(new Error("mention_policy: signer not registered for channel"));
    await f.h.buzzAdapter.deliverPending();
    expect(row(f, f.dispatchId)?.status).toBe("PENDING");
    f.h.clock.advance(31 * 60_000);
    expect((await f.h.buzzAdapter.deliverPending()).failed).toEqual([]);
    f.h.cp.outbox.fenceUndeliverable();
    f.h.cp.outbox.expireOverdue();
    expect(row(f, f.dispatchId)?.status).toBe("PENDING");
    f.send.mockImplementation(async (_channel: string, _content: string, recipients: readonly string[]) =>
      ({ eventId: "next-holder", mentionPubkeys: [...recipients] }));
    const next = takeOver(f, "actor:next-route");
    expect(row(f, f.dispatchId)).toMatchObject({ status: "PENDING", target_session_id: next.sessionId });
    expect((await f.h.buzzAdapter.deliverPending()).delivered).not.toContain(f.dispatchId);
    expect(f.h.cp.db.get("SELECT failure_class FROM outbox WHERE message_id = ?", [f.dispatchId])).toEqual({ failure_class: "contract" });
  } finally { f.h.cp.close(); }
});
