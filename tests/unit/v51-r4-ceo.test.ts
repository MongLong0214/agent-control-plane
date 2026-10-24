import { afterAll, expect, it, vi } from "vitest";

import type { BuzzSendReceipt, BuzzTransport } from "../../src/buzz/buzz-adapter.ts";
import { Role, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { MessageKind } from "../../src/outbox/envelope.ts";
import { outboxDeliveryReadback } from "../../src/outbox/outbox.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * ACP-R2-01, focused review, within CEO decision 9b15c462 — the same two boundaries for CEO
 * notifications. FCR-01: a relay's authority refusal stays one when the CEO's route disappears while
 * the send is in flight; only a refusal made before sending, for want of a route, is re-armed. FCR-02:
 * a Buzz send of unknown outcome is not sent again to the receiver that may already have it — the same
 * CEO session bound again at a new generation, or another session answering as the very same Buzz
 * recipient (the same room and channel identity) — and is delivered once to a CEO that really differs.
 * Ported from the focused review's probes.
 */
type Harness = ReturnType<typeof makeHarness>;
const recordingTransport = () => {
  const send = vi.fn(async (_channel: string, _content: string, recipients: readonly string[]): Promise<BuzzSendReceipt> =>
    ({ eventId: `evt-${send.mock.calls.length}`, mentionPubkeys: [...recipients] }));
  const transport: BuzzTransport = { openChannel: async (purpose) => `channel:${purpose}`, available: async () => true, send };
  return { transport, send };
};

const readyCeo = (h: Harness, route: { room: string | null; identity: string | null }) => {
  const session = h.cp.sessions.create({ provider: "scripted", model: "ceo", buzzAddress: route.room });
  expect(h.cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "ready").allowed).toBe(true);
  if (route.identity) {
    expect(h.cp.sessions.bindBuzzActor({ sessionId: session.sessionId, sessionSecret: session.sessionSecret!, buzzActorId: route.identity },
      { isAllowedActor: () => true }).allowed).toBe(true);
  }
  return session;
};

const notify = (h: Harness, key: string) => {
  const binding = h.cp.bindings.active(roleKeyFor(Role.CEO))!;
  const queued = h.cp.outbox.enqueue({ idempotencyKey: key, roleKey: "CEO", bindingGeneration: binding.bindingGeneration,
    targetSessionId: binding.sessionId, kind: MessageKind.CEO_NOTIFICATION, payload: { question: "decision required", key } });
  if (!queued.allowed) throw new Error(queued.message);
  return queued.value.messageId;
};
const stateOf = (h: Harness, id: string) =>
  h.cp.db.get<{ status: string; failure_class: string | null; target_session_id: string }>(
    "SELECT status, failure_class, target_session_id FROM outbox WHERE message_id = ?", [id]);

/** A Buzz-backed CEO at generation N, in "first-room" as "first-key". */
const buzzCeo = (verifiedSigner = false) => {
  const { transport, send } = recordingTransport();
  if (verifiedSigner) transport.signerReadiness = async () => ({ signer: "a".repeat(64), registered: true });
  const h = makeHarness({ buzzTransport: transport });
  const first = readyCeo(h, { room: "first-room", identity: "first-key" });
  const bound = h.cp.bindings.bind({ role: Role.CEO, sessionId: first.sessionId });
  if (!bound.allowed) throw new Error(bound.message);
  return { h, send, first, firstGeneration: bound.value.bindingGeneration };
};
const sendsOf = (send: ReturnType<typeof recordingTransport>["send"], id: string) =>
  send.mock.calls.filter((call) => String(call[1]).includes(id)).length;

it("FCR-01 CEO: a relay's refusal stays a contract refusal when the route disappears during the send", async () => {
  const f = buzzCeo();
  try {
    const id = notify(f.h, "race-refusal");
    f.send.mockImplementationOnce(async () => {
      f.h.cp.sessions.setBuzzAddress(f.first.sessionId, null);
      throw new Error("mention_policy: signer not registered for channel");
    });
    expect((await f.h.buzzAdapter.deliverPending()).failed).toEqual([id]);
    expect(stateOf(f.h, id)).toMatchObject({ status: "PENDING", failure_class: "contract" });
    const sent = sendsOf(f.send, id);
    f.h.cp.sessions.setBuzzAddress(f.first.sessionId, "restored-room");
    f.h.clock.advance(60 * 60_000);
    expect((await f.h.buzzAdapter.deliverPending()).delivered).not.toContain(id);
    expect(sendsOf(f.send, id)).toBe(sent);
    expect(stateOf(f.h, id)).toMatchObject({ status: "PENDING", failure_class: "contract" });
  } finally { f.h.cp.close(); }
});

/** A CEO notification whose Buzz send timed out: SENT, outcome unknown, at the first CEO. */
const timedOut = async (key: string) => {
  const f = buzzCeo();
  const id = notify(f.h, key);
  f.send.mockRejectedValueOnce(new Error("send timed out after 10000ms"));
  await f.h.buzzAdapter.deliverPending();
  expect(stateOf(f.h, id)).toMatchObject({ status: "SENT", failure_class: "unknown_observed", target_session_id: f.first.sessionId });
  return { ...f, id, sent: sendsOf(f.send, id) };
};

it("FCR-02 CEO: the same runtime rebound at a new generation is not a new receiver; an unknown outcome is not sent again", async () => {
  const f = await timedOut("same-runtime-unknown");
  try {
    expect(f.h.cp.bindings.revoke("CEO", "rebind the same runtime").allowed).toBe(true);
    const rebound = f.h.cp.bindings.bind({ role: Role.CEO, sessionId: f.first.sessionId });
    if (!rebound.allowed) throw new Error(rebound.message);
    expect(rebound.value.bindingGeneration).toBeGreaterThan(f.firstGeneration);
    expect(stateOf(f.h, f.id)).toMatchObject({ status: "SENT", failure_class: "unknown_observed", target_session_id: f.first.sessionId });
    f.h.clock.advance(60 * 60_000);
    expect((await f.h.buzzAdapter.deliverPending()).delivered).not.toContain(f.id);
    expect(sendsOf(f.send, f.id)).toBe(f.sent);
    const incarnation = f.h.cp.sessions.require(f.first.sessionId).incarnation;
    expect(f.h.cp.outbox.acknowledge(f.id, f.first.sessionId, rebound.value.bindingGeneration, incarnation).allowed).toBe(true);
  } finally { f.h.cp.close(); }
});

it("FCR-02 CEO: another session answering as the very same Buzz recipient is not a new receiver either", async () => {
  const f = await timedOut("same-recipient-unknown");
  try {
    expect(f.h.cp.bindings.revoke("CEO", "the CEO runtime is replaced").allowed).toBe(true);
    expect(f.h.cp.sessions.transition(f.first.sessionId, SessionLifecycle.STOPPED, "replaced").allowed).toBe(true);
    const next = readyCeo(f.h, { room: "first-room", identity: "first-key" });
    expect(f.h.cp.bindings.bind({ role: Role.CEO, sessionId: next.sessionId }).allowed).toBe(true);
    expect(stateOf(f.h, f.id)).toMatchObject({ status: "SENT", failure_class: "unknown_observed", target_session_id: next.sessionId });
    f.h.clock.advance(60 * 60_000);
    expect((await f.h.buzzAdapter.deliverPending()).delivered).not.toContain(f.id);
    expect(sendsOf(f.send, f.id)).toBe(f.sent);
  } finally { f.h.cp.close(); }
});

it("FCR-02 CEO: a CEO that really differs (another room and channel identity) receives the unknown outcome once, same id", async () => {
  const f = await timedOut("new-receiver-unknown");
  try {
    expect(f.h.cp.bindings.revoke("CEO", "the CEO runtime is replaced").allowed).toBe(true);
    expect(f.h.cp.sessions.transition(f.first.sessionId, SessionLifecycle.STOPPED, "replaced").allowed).toBe(true);
    const next = readyCeo(f.h, { room: "next-room", identity: "next-key" });
    expect(f.h.cp.bindings.bind({ role: Role.CEO, sessionId: next.sessionId }).allowed).toBe(true);
    expect(stateOf(f.h, f.id)).toMatchObject({ status: "PENDING", failure_class: null, target_session_id: next.sessionId });
    expect((await f.h.buzzAdapter.deliverPending()).delivered).toEqual([f.id]);
    expect((await f.h.buzzAdapter.deliverPending()).delivered).toEqual([]);
    expect(sendsOf(f.send, f.id)).toBe(f.sent + 1);
  } finally { f.h.cp.close(); }
});

it("ACP1199-04: an ordinary CEO keeps Buzz delivery with a host configured", async () => {
  const { transport, send } = recordingTransport();
  const invoke = vi.fn(async () => ({}));
  const h = makeHarness({ buzzTransport: { ...transport, signerReadiness: async () => ({ signer: "a".repeat(64), registered: true }) },
    residentProvisioner: { port: { invoke } } });
  try {
    const ceo = readyCeo(h, { room: "ordinary-room", identity: "ordinary-key" });
    expect(h.cp.bindings.bind({ role: Role.CEO, sessionId: ceo.sessionId }).allowed).toBe(true);
    const id = notify(h, "ordinary-with-host");
    expect((await h.buzzAdapter.deliverPending()).delivered).toEqual([id]);
    expect(stateOf(h, id)).toMatchObject({ status: "SENT" });
    expect(sendsOf(send, id)).toBe(1); expect(invoke).not.toHaveBeenCalled();
  } finally { h.cp.close(); }
});

it("CEO d0d06bc1: a timeout after positive signer readiness stays PENDING and unknown, never SENT or resent", async () => {
  const f = buzzCeo(true);
  try {
    const id = notify(f.h, "verified-timeout");
    f.send.mockRejectedValueOnce(new Error("send timed out after 10000ms"));
    await f.h.buzzAdapter.deliverPending();
    expect(f.h.cp.db.get("SELECT status, sent_at, failure_class, retry_eligible FROM outbox WHERE message_id = ?", [id]))
      .toEqual({ status: "PENDING", sent_at: null, failure_class: "unknown_observed", retry_eligible: 0 });
    expect(outboxDeliveryReadback(f.h.cp.outbox.get(id)!)).toMatchObject({ status: "OUTCOME_UNKNOWN", delivered: false, automaticResendHeld: true });
    expect(f.h.cp.outbox.sentTo(id, { room: "first-room", recipient: "first-key" })).toBe("UNKNOWN");
    expect(f.h.cp.bindings.revoke("CEO", "rebind same unknown receiver").allowed).toBe(true);
    const rebound = f.h.cp.bindings.bind({ role: Role.CEO, sessionId: f.first.sessionId });
    if (!rebound.allowed) throw new Error(rebound.message);
    for (let i = 0; i < 3; i++) await f.h.buzzAdapter.deliverPending();
    expect(sendsOf(f.send, id)).toBe(1);
    expect(stateOf(f.h, id)).toMatchObject({ status: "PENDING", failure_class: "unknown_observed" });
    expect(f.h.cp.outbox.acknowledge(id, f.first.sessionId, rebound.value.bindingGeneration,
      f.h.cp.sessions.require(f.first.sessionId).incarnation).allowed).toBe(true);
    expect(f.h.cp.outbox.get(id)?.status).toBe("ACKED");
  } finally { f.h.cp.close(); }
});

it("CEO d0d06bc1: verified unknown sends retain destination suppression across a receiver round trip", async () => {
  const f = buzzCeo(true);
  try {
    const id = notify(f.h, "verified-timeout-round-trip");
    f.send.mockRejectedValueOnce(new Error("send timed out after 10000ms"));
    await f.h.buzzAdapter.deliverPending();
    expect(f.h.cp.bindings.revoke("CEO", "new receiver").allowed).toBe(true);
    const next = readyCeo(f.h, { room: "next-room", identity: "next-key" });
    expect(f.h.cp.bindings.bind({ role: Role.CEO, sessionId: next.sessionId }).allowed).toBe(true);
    expect(stateOf(f.h, id)).toMatchObject({ status: "PENDING", failure_class: null });
    f.send.mockRejectedValueOnce(new Error("send timed out after 10000ms"));
    await f.h.buzzAdapter.deliverPending();
    expect(f.h.cp.bindings.revoke("CEO", "return to first receiver").allowed).toBe(true);
    expect(f.h.cp.bindings.bind({ role: Role.CEO, sessionId: f.first.sessionId }).allowed).toBe(true);
    await f.h.buzzAdapter.deliverPending(); await f.h.buzzAdapter.deliverPending();
    expect(sendsOf(f.send, id)).toBe(2);
    expect(f.h.cp.db.get("SELECT status, sent_at, failure_class FROM outbox WHERE message_id = ?", [id]))
      .toEqual({ status: "PENDING", sent_at: null, failure_class: "unknown_observed" });
  } finally { f.h.cp.close(); }
});
