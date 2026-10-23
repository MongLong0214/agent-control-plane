import { afterAll, expect, it, vi } from "vitest";

import type { BuzzSendReceipt, BuzzTransport } from "../../src/buzz/buzz-adapter.ts";
import { digestOf, sha256 } from "../../src/core/digest.ts";
import { acpError, allow } from "../../src/core/errors.ts";
import { readProcessStartToken } from "../../src/core/process-argv.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ExecutionMode, Role, RunState, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { SELF_CLAIM_EXECUTOR_KIND, SELF_CLAIM_PROTOCOL } from "../../src/registry/canonical-self-claim.ts";
import type { TaskContract } from "../../src/run/run-engine.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { makeHarness, registerFixtureProject, type Harness } from "../helpers/harness.ts";
import { TestProductionAdapter } from "../helpers/production-adapter.ts";

afterAll(cleanupTempDirs);

/**
 * ACP-R1-01, review round 3, within CEO decision 9b15c462 — one re-arm policy. An instruction whose
 * retry was disabled solely because its route was absent (no room, or no channel identity, so nothing
 * was sent) is deliverable again on every authenticated route change of its holder — an address set
 * or restored, a channel identity bound, a takeover, a rebind after a revoke, a runtime move — with its
 * message id, and a replaced holder still cannot settle it. An authority refusal or wrong target is
 * not reactivated by a route change; an outcome-unknown send is not re-sent to the same receiver
 * (Buzz has no same-id dedupe or receipt lookup); a terminal row is never touched; and a handover
 * never widens the item's role, run or payload. Ported from the round-3 review's probes.
 */const CONVERSATION = "55555555-5555-4555-8555-555555555555";
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

const takeOver = (f: Fixture, identity: string) => {
  const next = launchedRuntime(f.h, identity);
  const moved = f.h.cp.bindings.switchTo({ role: Role.PRIMARY_CTO, projectId: f.projectId, sessionId: next.sessionId,
    conversation: "REPLACED", reason: "holder recovery", takeover: true });
  if (!moved.allowed) throw new Error(moved.message);
  return { ...next, generation: moved.value.bindingGeneration };
};

const accept = (f: Fixture) => f.send.mockImplementation(async (_channel: string, _content: string, recipients: readonly string[]) =>
  ({ eventId: "route-recovered", mentionPubkeys: [...recipients] }));
const state = (f: Fixture) =>
  f.h.cp.db.get<{ status: string; failure_class: string | null; retry_eligible: number; target_session_id: string; role_key: string;
    kind: string; run_id: string | null; payload_digest: string }>(
    `SELECT status, failure_class, retry_eligible, target_session_id, role_key, kind, run_id, payload_digest
       FROM outbox WHERE message_id = ?`, [f.dispatchId]);
const sendsOf = (f: Fixture) => f.send.mock.calls.filter((call) => String(call[1]).includes(f.dispatchId)).length;
/** A holder whose session has a room but whose channel identity is not bound yet. */
const holderWithoutIdentity = (f: Fixture) => {
  const session = f.h.cp.sessions.create({ provider: "claude", model: "claude-cli", buzzAddress: SUCCESSOR_ROOM });
  expect(f.h.cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "launched").allowed).toBe(true);
  const moved = f.h.cp.bindings.switchTo({ role: Role.PRIMARY_CTO, projectId: f.projectId, sessionId: session.sessionId,
    conversation: "REPLACED", reason: "holder recovery", takeover: true });
  if (!moved.allowed) throw new Error(moved.message);
  return { session, generation: moved.value.bindingGeneration };
};
/** The dispatch's attempt fails and it stays held, unsent, for an hour, with `failureClass` on record. */
const heldAfterFailure = async (f: Fixture, failureClass: string) => {
  expect((await f.h.buzzAdapter.deliverPending()).failed).toContain(f.dispatchId);
  expect(state(f)).toMatchObject({ status: "PENDING", failure_class: failureClass, retry_eligible: 0 });
  f.h.clock.advance(60 * 60_000);
  expect((await f.h.buzzAdapter.deliverPending()).delivered).not.toContain(f.dispatchId);
};

const takeoverChange = (f: Fixture) => takeOver(f, "actor:after-takeover");
const rebindChange = (f: Fixture) => {
  expect(f.h.cp.runs.transition(f.runId, RunState.BLOCKED, "CEO_DECISION_REQUIRED").allowed).toBe(true);
  expect(f.h.cp.bindings.revoke(f.roleKey, "recover holder", { allowBlockedRuns: true }).allowed).toBe(true);
  const next = launchedRuntime(f.h, "actor:after-rebind");
  const bound = f.h.cp.bindings.switchTo({ role: Role.PRIMARY_CTO, projectId: f.projectId, sessionId: next.sessionId,
    conversation: "REPLACED", reason: "the role is bound again" });
  if (!bound.allowed) throw new Error(bound.message);
  return { ...next, generation: bound.value.bindingGeneration };
};
const moveChange = (f: Fixture) => {
  const current = f.h.cp.bindings.active(f.roleKey)!;
  expect(f.h.cp.sessions.transition(current.sessionId, SessionLifecycle.STOPPED, "runtime moves").allowed).toBe(true);
  const next = launchedRuntime(f.h, "actor:moved-runtime");
  const moved = f.h.cp.bindings.switchTo({ role: Role.PRIMARY_CTO, projectId: f.projectId, sessionId: next.sessionId,
    conversation: "SURVIVED", reason: "same conversation, new runtime" });
  if (!moved.allowed) throw new Error(moved.message);
  return { ...next, generation: moved.value.bindingGeneration };
};
const HANDOVERS = [["a takeover", takeoverChange], ["a rebind after a revoke", rebindChange], ["a runtime move", moveChange]] as const;

it("R3 instruction probe: a restored Buzz address resumes an instruction whose route was absent, same id", async () => {
  const f = await dispatched();
  try {
    const holder = takeOver(f, "actor:restorable-route");
    f.h.cp.sessions.setBuzzAddress(holder.sessionId, null);
    await heldAfterFailure(f, "repairable");
    f.h.cp.sessions.setBuzzAddress(holder.sessionId, SUCCESSOR_ROOM);
    expect((await f.h.buzzAdapter.deliverPending()).delivered).toContain(f.dispatchId);
    expect(f.h.cp.outbox.acknowledge(f.dispatchId, holder.sessionId, holder.generation, holder.incarnation).allowed).toBe(true);
  } finally { f.h.cp.close(); }
});

it("R3 instruction probe: a bound Buzz channel identity resumes an instruction whose route was absent, same id", async () => {
  const f = await dispatched();
  try {
    const { session } = holderWithoutIdentity(f);
    await heldAfterFailure(f, "repairable");
    expect(f.h.cp.sessions.bindBuzzActor({ sessionId: session.sessionId, sessionSecret: session.sessionSecret!, buzzActorId: "actor:late-identity" },
      { isAllowedActor: () => true }).allowed).toBe(true);
    expect((await f.h.buzzAdapter.deliverPending()).delivered).toContain(f.dispatchId);
  } finally { f.h.cp.close(); }
});

it.each(HANDOVERS)("R3 instruction probe: %s resumes an instruction whose route was absent at the new holder, same id, and the old holder cannot settle it", async (_what, change) => {
  const f = await dispatched();
  try {
    const absent = takeOver(f, "actor:route-absent");
    f.h.cp.sessions.setBuzzAddress(absent.sessionId, null);
    await heldAfterFailure(f, "repairable");
    const before = state(f)!;
    const next = change(f);
    expect(state(f)).toMatchObject({ status: "PENDING", failure_class: null, target_session_id: next.sessionId,
      role_key: before.role_key, kind: before.kind, run_id: before.run_id, payload_digest: before.payload_digest });
    expect((await f.h.buzzAdapter.deliverPending()).delivered).toContain(f.dispatchId);
    expect(f.h.cp.outbox.acknowledge(f.dispatchId, absent.sessionId, absent.generation, absent.incarnation).allowed).toBe(false);
    expect(f.h.cp.outbox.acknowledge(f.dispatchId, next.sessionId, next.generation, next.incarnation).allowed).toBe(true);
  } finally { f.h.cp.close(); }
});

it.each([
  ["an authority refusal", () => new Error("mention_policy: signer not registered for channel"), "contract"],
  ["a wrong target", () => acpError(ReasonCode.BUZZ_MENTION_NOT_RESOLVED, "the recipient is not a member of the room"), "contract"],
  ["a security refusal", () => new Error("relay refused: permission denied for this credential"), "security"],
] as const)("R3 boundary: %s is not reactivated by any route change, and is never re-sent", async (_what, refusal, failureClass) => {
  const f = await dispatched();
  try {
    const holder = takeOver(f, "actor:refusing-route");
    f.send.mockRejectedValue(refusal());
    await heldAfterFailure(f, failureClass);
    accept(f);
    const sent = sendsOf(f);
    f.h.cp.sessions.setBuzzAddress(holder.sessionId, "another-room");
    expect((await f.h.buzzAdapter.deliverPending()).delivered).not.toContain(f.dispatchId);
    for (const [, change] of HANDOVERS) {
      const next = change(f);
      expect(state(f)).toMatchObject({ status: "PENDING", failure_class: failureClass, target_session_id: next.sessionId });
      f.h.clock.advance(60 * 60_000);
      expect((await f.h.buzzAdapter.deliverPending()).delivered).not.toContain(f.dispatchId);
      if (f.h.cp.runs.require(f.runId).state === RunState.BLOCKED) {
        expect(f.h.cp.runs.transition(f.runId, RunState.ACTIVE, "resumed").allowed).toBe(true);
      }
    }
    expect(sendsOf(f)).toBe(sent);
  } finally { f.h.cp.close(); }
});

it("R3 boundary: an outcome-unknown Buzz send is flagged, never re-sent to the same receiver, and delivered to a new one", async () => {
  const f = await dispatched();
  try {
    const holder = takeOver(f, "actor:timed-out");
    f.send.mockRejectedValue(new Error("send timed out after 10000ms"));
    expect((await f.h.buzzAdapter.deliverPending()).failed).toContain(f.dispatchId);
    expect(state(f)).toMatchObject({ status: "SENT", failure_class: "unknown_observed", target_session_id: holder.sessionId });
    accept(f);
    const sent = sendsOf(f);
    f.h.clock.advance(24 * 60 * 60_000);
    f.h.cp.sessions.setBuzzAddress(holder.sessionId, SUCCESSOR_ROOM);
    f.h.cp.outbox.fenceUndeliverable();
    f.h.cp.outbox.expireOverdue();
    expect((await f.h.buzzAdapter.deliverPending()).delivered).toEqual([]);
    expect(sendsOf(f)).toBe(sent);
    expect(state(f)?.status).toBe("SENT");
    // The holder that may already have it can still settle it.
    expect(f.h.cp.outbox.acknowledge(f.dispatchId, holder.sessionId, holder.generation, holder.incarnation).allowed).toBe(true);
  } finally { f.h.cp.close(); }
});

it("R3 boundary: an outcome-unknown Buzz send follows a takeover to the new receiver once, same id", async () => {
  const f = await dispatched();
  try {
    takeOver(f, "actor:timed-out-then-replaced");
    f.send.mockRejectedValue(new Error("send timed out after 10000ms"));
    await f.h.buzzAdapter.deliverPending();
    accept(f);
    const next = takeOver(f, "actor:new-receiver");
    expect(state(f)).toMatchObject({ status: "PENDING", failure_class: null, target_session_id: next.sessionId });
    expect((await f.h.buzzAdapter.deliverPending()).delivered).toEqual([f.dispatchId]);
    expect((await f.h.buzzAdapter.deliverPending()).delivered).toEqual([]);
  } finally { f.h.cp.close(); }
});

it("R3 boundary: a terminal instruction is never reactivated by a route change", async () => {
  const f = await dispatched();
  try {
    const holder = takeOver(f, "actor:acked");
    expect((await f.h.buzzAdapter.deliverPending()).delivered).toContain(f.dispatchId);
    expect(f.h.cp.outbox.acknowledge(f.dispatchId, holder.sessionId, holder.generation, holder.incarnation).allowed).toBe(true);
    const sent = sendsOf(f);
    f.h.cp.sessions.setBuzzAddress(holder.sessionId, "another-room");
    takeOver(f, "actor:after-ack");
    expect((await f.h.buzzAdapter.deliverPending()).delivered).toEqual([]);
    expect(state(f)?.status).toBe("ACKED");
    expect(sendsOf(f)).toBe(sent);
  } finally { f.h.cp.close(); }
});
