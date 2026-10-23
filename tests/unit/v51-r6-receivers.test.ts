import { afterAll, expect, it, vi } from "vitest";

import type { BuzzSendReceipt, BuzzTransport } from "../../src/buzz/buzz-adapter.ts";
import { digestOf, sha256 } from "../../src/core/digest.ts";
import { allow } from "../../src/core/errors.ts";
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
 * FCR-10, third focused review, within CEO decisions 9b15c462 and 1fd967e8 — where a send may have
 * landed is recorded whether or not its claim is still held. A handover may take an instruction while
 * its Buzz send is pending; when that send then times out, its destination is still recorded as
 * UNKNOWN, exactly as an acceptance completing after the handover is recorded as ACCEPTED, so the new
 * holder at the same room and recipient is not sent it again. Ported from the third focused review's
 * probes.
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

/** The holder is revoked and stopped with the run blocked, as a replacement after a timed-out send. */
const releaseHolder = (f: Fixture, holderSessionId: string) => {
  expect(f.h.cp.runs.transition(f.runId, RunState.BLOCKED, "CEO_DECISION_REQUIRED").allowed).toBe(true);
  expect(f.h.cp.bindings.revoke(f.roleKey, "replace receiver", { allowBlockedRuns: true }).allowed).toBe(true);
  expect(f.h.cp.sessions.transition(holderSessionId, SessionLifecycle.STOPPED, "replaced").allowed).toBe(true);
};

const destinationsOf = (f: Fixture) =>
  f.h.cp.db.all("SELECT room, recipient, outcome FROM outbox_sent_destinations WHERE message_id = ?", [f.dispatchId]);

it("FCR-10: a send that times out after a handover took its instruction records where it may have landed; the same recipient is not sent it again", async () => {
  const f = await dispatched();
  try {
    const holder = takeOver(f, "actor:late-timeout");
    let rejectSend!: (error: Error) => void;
    f.send.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectSend = reject; }));
    const sending = f.h.buzzAdapter.deliverPending();
    expect(state(f)?.status).toBe("IN_FLIGHT");
    releaseHolder(f, holder.sessionId);
    const next = takeOver(f, "actor:late-timeout");
    rejectSend(new Error("send timed out after 10000ms"));
    await sending;
    expect(destinationsOf(f)).toEqual([{ room: SUCCESSOR_ROOM, recipient: "actor:late-timeout", outcome: "UNKNOWN" }]);
    const sent = sendsOf(f);
    accept(f);
    await f.h.buzzAdapter.deliverPending();
    expect(f.send.mock.calls.filter((call) => String(call[1]).includes(f.dispatchId)).map((call) => [call[0], call[2]]))
      .toEqual([[SUCCESSOR_ROOM, ["actor:late-timeout"]]]);
    expect(sendsOf(f)).toBe(sent);
    expect(state(f)).toMatchObject({ status: "SENT", failure_class: "unknown_observed", target_session_id: next.sessionId });
  } finally { f.h.cp.close(); }
});

it("FCR-10 sibling (already held before this change): an acceptance completing after a handover keeps its destination; the same recipient is not sent it again", async () => {
  const f = await dispatched();
  try {
    const holder = takeOver(f, "actor:late-accepted");
    let resolveSend!: (receipt: BuzzSendReceipt) => void;
    f.send.mockImplementationOnce(() => new Promise((resolve) => { resolveSend = resolve; }));
    const sending = f.h.buzzAdapter.deliverPending();
    releaseHolder(f, holder.sessionId);
    takeOver(f, "actor:late-accepted");
    resolveSend({ eventId: "late-accepted", mentionPubkeys: ["actor:late-accepted"] });
    await sending;
    expect(destinationsOf(f)).toEqual([{ room: SUCCESSOR_ROOM, recipient: "actor:late-accepted", outcome: "ACCEPTED" }]);
    const sent = sendsOf(f);
    accept(f);
    await f.h.buzzAdapter.deliverPending();
    expect(sendsOf(f)).toBe(sent);
    expect(state(f)).toMatchObject({ status: "SENT", failure_class: null });
  } finally { f.h.cp.close(); }
});
