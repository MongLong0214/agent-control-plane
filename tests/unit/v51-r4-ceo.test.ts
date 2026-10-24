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
  const transport: BuzzTransport = { openChannel: async (purpose) => `channel:${purpose}`, available: async () => true, send,
    signerReadiness: async () => ({ signer: "a".repeat(64), registered: true }),
    policyReadiness: async (_room, _body, recipient, signer) => ({ verdict: "allowed", policyDigest: "fixture-policy", recipient, signer }),
  };
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

/** Retained pre-readiness SENT/unknown history at the first CEO, with the same destination ledger. */
const timedOut = async (key: string) => {
  const f = buzzCeo();
  const id = notify(f.h, key);
  f.send.mockRejectedValueOnce(new Error("send timed out after 10000ms"));
  await f.h.buzzAdapter.deliverPending();
  expect(stateOf(f.h, id)).toMatchObject({ status: "PENDING", failure_class: "unknown_observed", target_session_id: f.first.sessionId });
  // New sends now need readiness. Keep testing the persisted representation from the old
  // unverified-send path, which must retain exactly its previous handover/suppression behavior.
  f.h.cp.db.run("UPDATE outbox SET status = 'SENT', sent_at = ? WHERE message_id = ?", [f.h.clock.nowIso(), id]);
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
    expect(stateOf(f.h, f.id)).toMatchObject({ status: "PENDING", failure_class: "unknown_observed", target_session_id: f.first.sessionId });
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
    expect(stateOf(f.h, f.id)).toMatchObject({ status: "PENDING", failure_class: "unknown_observed", target_session_id: next.sessionId });
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

it("REVIEW-PROBE: known accepted earlier destination cannot make a later unknown destination SENT", async () => {
  const f = buzzCeo(true);
  try {
    const id = notify(f.h, "accepted-then-unknown");
    await f.h.buzzAdapter.deliverPending();
    expect(stateOf(f.h,id)?.status).toBe("SENT");
    f.h.cp.bindings.revoke("CEO", "new receiver");
    const next = readyCeo(f.h, { room: "next-room", identity: "next-key" });
    expect(f.h.cp.bindings.bind({role:Role.CEO, sessionId:next.sessionId}).allowed).toBe(true);
    f.send.mockRejectedValueOnce(new Error("send timed out after 10000ms"));
    await f.h.buzzAdapter.deliverPending();
    expect(stateOf(f.h,id)?.failure_class).toBe("unknown_observed");
    f.h.cp.bindings.revoke("CEO", "third receiver");
    const third=readyCeo(f.h, {room:"third-room",identity:"third-key"});
    expect(f.h.cp.bindings.bind({role:Role.CEO, sessionId:third.sessionId}).allowed).toBe(true);
    await f.h.buzzAdapter.deliverPending();
    f.h.cp.bindings.revoke("CEO", "return unknown receiver");
    expect(f.h.cp.bindings.bind({role:Role.CEO, sessionId:next.sessionId}).allowed).toBe(true);
    await f.h.buzzAdapter.deliverPending();
    expect(sendsOf(f.send,id)).toBe(3);
    expect(f.h.cp.outbox.sentTo(id,{room:"next-room",recipient:"next-key"})).toBe("UNKNOWN");
    expect(stateOf(f.h,id)?.failure_class).toBe("unknown_observed");
    expect(outboxDeliveryReadback(f.h.cp.outbox.get(id)!).automaticResendHeld).toBe(true);
  } finally { f.h.cp.close(); }
});

it.each(["accepted→unknown", "unknown→accepted", "accepted→accepted", "accepted→new"] as const)(
  "ROUND1-ESCAPE-01: retarget %s uses only that destination's outcome", async transition => {
    const f = buzzCeo(true);
    try {
      const id = notify(f.h, transition);
      const sealed = f.h.cp.outbox.get(id)!;
      await f.h.buzzAdapter.deliverPending(); // A accepted.
      const acceptedAt = f.h.cp.db.get<{ sent_at: string }>("SELECT sent_at FROM outbox_sent_destinations WHERE message_id = ? AND room = ?", [id, "first-room"])!.sent_at;
      const bind = (sessionId: string) => {
        expect(f.h.cp.bindings.revoke("CEO", transition).allowed).toBe(true);
        expect(f.h.cp.bindings.bind({ role: Role.CEO, sessionId }).allowed).toBe(true);
      };
      f.h.clock.advance(1000);
      const second = readyCeo(f.h, { room: "second-room", identity: "second-key" }); bind(second.sessionId);
      if (transition !== "accepted→accepted") f.send.mockRejectedValueOnce(new Error("send timed out after 10000ms"));
      await f.h.buzzAdapter.deliverPending(); // B accepted or unknown.
      if (transition.startsWith("accepted→") && transition !== "accepted→accepted") {
        f.h.clock.advance(1000);
        const third = readyCeo(f.h, { room: "third-room", identity: "third-key" }); bind(third.sessionId);
        await f.h.buzzAdapter.deliverPending(); // C accepted.
      }
      const sent = sendsOf(f.send, id);
      const target = transition === "accepted→new"
        ? readyCeo(f.h, { room: "new-room", identity: "new-key" }).sessionId
        : transition === "accepted→unknown" ? second.sessionId : f.first.sessionId;
      bind(target);
      const readback = outboxDeliveryReadback(f.h.cp.outbox.get(id)!);
      expect(readback).toMatchObject({ delivered: transition.endsWith("→accepted"),
        automaticResendHeld: transition.endsWith("→unknown"), completed: false });
      if (transition.endsWith("→unknown")) expect(stateOf(f.h, id)?.status).toBe("PENDING");
      expect(f.h.cp.db.get("SELECT sent_at FROM outbox WHERE message_id = ?", [id]))
        .toEqual({ sent_at: transition.endsWith("→accepted") ? acceptedAt : null });
      await f.h.buzzAdapter.deliverPending(); await f.h.buzzAdapter.deliverPending();
      expect(sendsOf(f.send, id)).toBe(sent + (transition.endsWith("→new") ? 1 : 0));
      expect(f.h.cp.outbox.get(id)).toMatchObject({ messageId: id, payloadDigest: sealed.payloadDigest, payload: sealed.payload });
      expect(f.h.cp.outbox.get(id)?.status).not.toBe("ACKED");
    } finally { f.h.cp.close(); }
  },
);

it.each(["ACCEPTED", "UNKNOWN"] as const)("ROUND1-ESCAPE-01: returning to an in-flight destination waits for its own %s result", async outcome => {
  const f = buzzCeo(true);
  let release = () => {}; let pending: Promise<unknown> | undefined;
  try {
    const id = notify(f.h, `in-flight-${outcome}`); await f.h.buzzAdapter.deliverPending();
    const bind = (sessionId: string) => {
      expect(f.h.cp.bindings.revoke("CEO", "in-flight return").allowed).toBe(true);
      expect(f.h.cp.bindings.bind({ role: Role.CEO, sessionId }).allowed).toBe(true);
    };
    const second = readyCeo(f.h, { room: "second-room", identity: "second-key" }); bind(second.sessionId);
    const held = new Promise<void>(resolve => { release = resolve; });
    let started!: () => void; const began = new Promise<void>(resolve => { started = resolve; });
    f.send.mockImplementationOnce(async (_channel, _content, recipients) => {
      started(); await held;
      if (outcome === "UNKNOWN") throw new Error("send timed out after 10000ms");
      return { eventId: "second-event", mentionPubkeys: [...recipients] };
    });
    pending = f.h.buzzAdapter.deliverPending(); await began;
    const third = readyCeo(f.h, { room: "third-room", identity: "third-key" }); bind(third.sessionId);
    await f.h.buzzAdapter.deliverPending();
    bind(second.sessionId); await f.h.buzzAdapter.deliverPending();
    expect(outboxDeliveryReadback(f.h.cp.outbox.get(id)!).delivered).toBe(false);
    expect(sendsOf(f.send, id)).toBe(2); // The outstanding CEO claim also withholds C.
    release(); await pending;
    f.h.clock.advance(60 * 60_000); // Existing stale-claim recovery, no wall-clock sleep.
    await f.h.buzzAdapter.deliverPending(); await f.h.buzzAdapter.deliverPending();
    expect(outboxDeliveryReadback(f.h.cp.outbox.get(id)!)).toMatchObject({ delivered: outcome === "ACCEPTED",
      automaticResendHeld: outcome === "UNKNOWN", completed: false });
    expect(sendsOf(f.send, id)).toBe(2);
  } finally { release(); await pending; f.h.cp.close(); }
});


it.each(["queued", "contract"] as const)("R3-PROBE: pending %s intermediate destination cannot conceal the selected ledger outcome", async intermediate => {
  const f = buzzCeo(true);
  try {
    const id = notify(f.h, `pending-return-${intermediate}`);
    const bind = (sessionId: string) => {
      expect(f.h.cp.bindings.revoke("CEO", "pending return").allowed).toBe(true);
      expect(f.h.cp.bindings.bind({ role: Role.CEO, sessionId }).allowed).toBe(true);
    };
    await f.h.buzzAdapter.deliverPending(); // A accepted.
    const second = readyCeo(f.h, { room: "second-room", identity: "second-key" }); bind(second.sessionId);
    f.send.mockRejectedValueOnce(new Error("send timed out after 10000ms"));
    await f.h.buzzAdapter.deliverPending(); // B UNKNOWN.
    const third = readyCeo(f.h, { room: "third-room", identity: "third-key" }); bind(third.sessionId);
    if (intermediate === "contract") {
      f.send.mockRejectedValueOnce(new Error('buzz send failed: {"error":"mention_policy","message":"recipient not registered for channel","retryable":false}'));
      await f.h.buzzAdapter.deliverPending(); // C confirmed refusal.
    }
    const sent = sendsOf(f.send, id);
    bind(second.sessionId);
    expect(f.h.cp.outbox.sentTo(id, { room: "second-room", recipient: "second-key" })).toBe("UNKNOWN");
    expect.soft(outboxDeliveryReadback(f.h.cp.outbox.get(id)!)).toMatchObject({ delivered: false, automaticResendHeld: true });
    await f.h.buzzAdapter.deliverPending();
    expect.soft(outboxDeliveryReadback(f.h.cp.outbox.get(id)!)).toMatchObject({ delivered: false, automaticResendHeld: true });
    expect(sendsOf(f.send, id)).toBe(sent);
    bind(f.first.sessionId);
    expect.soft(outboxDeliveryReadback(f.h.cp.outbox.get(id)!)).toMatchObject({ delivered: true, automaticResendHeld: false });
    await f.h.buzzAdapter.deliverPending();
    expect.soft(outboxDeliveryReadback(f.h.cp.outbox.get(id)!)).toMatchObject({ delivered: true, automaticResendHeld: false });
    expect(sendsOf(f.send, id)).toBe(sent);
  } finally { f.h.cp.close(); }
});

const retargetStates = ["accepted", "UNKNOWN", "contract-refused", "queued"] as const;
const selectedStates = ["accepted", "UNKNOWN", "refused", "unseen"] as const;
it.each(retargetStates.flatMap(previous => selectedStates.flatMap(selected =>
  (["rebind", "takeover"] as const).map(path => [previous, selected, path] as const))))(
  "R3 matrix: previous %s → selected %s via %s restores only the selected destination ledger outcome", async (previous, selected, path) => {
    const f = buzzCeo(true);
    try {
      const id = notify(f.h, `matrix-${previous}-${selected}`);
      const sealed = f.h.cp.outbox.get(id)!;
      const refusal = new Error('buzz send failed: {"error":"mention_policy","message":"recipient not registered for channel","retryable":false}');
      if (selected !== "unseen") {
        if (selected === "UNKNOWN") f.send.mockRejectedValueOnce(new Error("send timed out after 10000ms"));
        if (selected === "refused") f.send.mockRejectedValueOnce(refusal);
        await f.h.buzzAdapter.deliverPending();
      }
      const bind = (sessionId: string) => {
        if (path === "takeover") {
          expect(f.h.cp.bindings.switchTo({ role: Role.CEO, sessionId, conversation: "REPLACED", takeover: true,
            reason: "matrix transition" }).allowed).toBe(true);
        } else {
          expect(f.h.cp.bindings.revoke("CEO", "matrix transition").allowed).toBe(true);
          expect(f.h.cp.bindings.bind({ role: Role.CEO, sessionId }).allowed).toBe(true);
        }
      };
      f.h.clock.advance(1_000); // Different destinations must retain their own acceptance timestamp.
      const intermediate = readyCeo(f.h, { room: "intermediate-room", identity: "intermediate-key" }); bind(intermediate.sessionId);
      await f.h.cp.outbox.deliverCeoNotifications(); // Establish the fixture's previous queue before the tested return.
      if (previous !== "queued") {
        if (previous === "UNKNOWN") f.send.mockRejectedValueOnce(new Error("send timed out after 10000ms"));
        if (previous === "contract-refused") f.send.mockRejectedValueOnce(refusal);
        await f.h.buzzAdapter.deliverPending();
      }
      const prior = stateOf(f.h, id)!;
      expect(prior).toMatchObject({ status: previous === "accepted" ? "SENT" : "PENDING",
        failure_class: previous === "UNKNOWN" ? "unknown_observed" : previous === "contract-refused" ? "contract" : null });
      const sent = sendsOf(f.send, id);
      bind(f.first.sessionId);
      // Refusal history belongs to this destination and must hold again on return.
      const check = (sweep: number) => {
        const delivered = selected === "accepted" || (selected === "unseen" && sweep > 0);
        const unknown = selected === "UNKNOWN";
        const contract = selected === "refused";
        const row = f.h.cp.outbox.get(id)!;
        const ledger = f.h.cp.db.get<{ outcome: string; sent_at: string | null }>(
          "SELECT outcome, sent_at FROM outbox_sent_destinations WHERE message_id = ? AND room = ? AND recipient = ?",
          [id, "first-room", "first-key"]);
        expect.soft(stateOf(f.h, id)).toMatchObject({ status: delivered ? "SENT" : "PENDING",
          failure_class: unknown ? "unknown_observed" : contract ? "contract" : null, target_session_id: f.first.sessionId });
        const readback = outboxDeliveryReadback(row);
        expect.soft(readback).toMatchObject({ delivered, automaticResendHeld: unknown, completed: false });
        expect.soft(readback.delivered).toBe(ledger?.outcome === "ACCEPTED");
        expect.soft(row.status).not.toBe("ACKED");
        const timestamps = f.h.cp.db.get<{ sent_at: string | null; acked_at: string | null }>(
          "SELECT sent_at, acked_at FROM outbox WHERE message_id = ?", [id])!;
        expect.soft(timestamps.acked_at).toBeNull();
        expect.soft(timestamps.sent_at).toBe(ledger?.outcome === "ACCEPTED" ? ledger.sent_at : null);
        expect.soft(sendsOf(f.send, id)).toBe(sent + (selected === "unseen" && sweep > 0 ? 1 : 0));
      };
      check(0);
      for (const sweep of [1, 2]) { await f.h.buzzAdapter.deliverPending(); check(sweep); }
      expect(f.h.cp.outbox.get(id)).toMatchObject({ messageId: id, payload: sealed.payload, payloadDigest: sealed.payloadDigest });
    } finally { f.h.cp.close(); }
  },
);

it.each(["accepted", "UNKNOWN"] as const)("R3-PENDING: selected %s evidence cancels another destination's retry deferral", async selected => {
  const f = buzzCeo(true);
  try {
    const id = notify(f.h, `deferred-${selected}`);
    if (selected === "UNKNOWN") f.send.mockRejectedValueOnce(new Error("send timed out after 10000ms"));
    await f.h.buzzAdapter.deliverPending();
    const bind = (sessionId: string) => {
      expect(f.h.cp.bindings.revoke("CEO", "deferred return").allowed).toBe(true);
      expect(f.h.cp.bindings.bind({ role: Role.CEO, sessionId }).allowed).toBe(true);
    };
    const intermediate = readyCeo(f.h, { room: "intermediate-room", identity: "intermediate-key" }); bind(intermediate.sessionId);
    f.send.mockRejectedValueOnce(new Error("connect ECONNREFUSED relay"));
    await f.h.buzzAdapter.deliverPending();
    expect(f.h.cp.outbox.get(id)).toMatchObject({ failureClass: "transient", retryEligible: true });
    const sent = sendsOf(f.send, id); bind(f.first.sessionId);
    for (const sweep of [0, 1, 2]) {
      if (sweep) await f.h.buzzAdapter.deliverPending();
      expect.soft(outboxDeliveryReadback(f.h.cp.outbox.get(id)!)).toMatchObject({ delivered: selected === "accepted",
        automaticResendHeld: selected === "UNKNOWN" });
      expect.soft(f.h.cp.outbox.get(id)).toMatchObject({ retryEligible: false, nextAttemptAt: null });
      expect(sendsOf(f.send, id)).toBe(sent);
    }
  } finally { f.h.cp.close(); }
});

it.each(["rebind", "takeover"] as const)("R3-LEGACY: %s with matching evidence cannot release any of the 12 legacy holds", async path => {
  const f = buzzCeo(true);
  try {
    const ids = Array.from({ length: 12 }, (_, n) => notify(f.h, `legacy-${n}`));
    await f.h.buzzAdapter.deliverPending();
    for (const [index, id] of ids.entries()) {
      f.h.cp.audit.record({ kind: "CEO_NOTIFICATION_LEGACY_OUTCOME_UNKNOWN", evidence: { messageId: id } });
      // A known destination is not proof about the rest of this pre-journal history.
      f.h.cp.db.run("UPDATE outbox SET status = 'PENDING', failure_class = ?, attempts = 2, sent_at = NULL WHERE message_id = ?",
        [[null, "contract", "unknown_observed"][index % 3], id]);
    }
    const bind = (sessionId: string) => {
      if (path === "takeover") {
        expect(f.h.cp.bindings.switchTo({ role: Role.CEO, sessionId, conversation: "REPLACED", takeover: true,
          reason: "legacy hold transition" }).allowed).toBe(true);
      } else {
        expect(f.h.cp.bindings.revoke("CEO", "legacy hold transition").allowed).toBe(true);
        expect(f.h.cp.bindings.bind({ role: Role.CEO, sessionId }).allowed).toBe(true);
      }
    };
    const snapshot = () => f.h.cp.db.all(`SELECT message_id, status, failure_class, attempts, sent_at, acked_at, payload_json, payload_digest
      FROM outbox WHERE message_id IN (${ids.map(() => "?").join(",")}) ORDER BY message_id`, ids);
    const held = snapshot();
    const intermediate = readyCeo(f.h, { room: "intermediate-room", identity: "intermediate-key" }); bind(intermediate.sessionId);
    bind(f.first.sessionId);
    await f.h.buzzAdapter.deliverPending(); await f.h.buzzAdapter.deliverPending();
    expect(snapshot()).toEqual(held); expect(snapshot()).toHaveLength(12);
    expect(f.send).toHaveBeenCalledTimes(12);
  } finally { f.h.cp.close(); }
});


it.each((["UNKNOWN", "ACCEPTED"] as const).flatMap(outcome =>
  (["same-key rebind", "surviving holder"] as const).map(mode => [outcome, mode] as const)))(
  "CEO 6bd2011d: %s history cannot replay for a %s", async (outcome, mode) => {
  const f = buzzCeo(true);
  try {
    const id = notify(f.h, `same-recipient-${outcome}`);
    if (outcome === "UNKNOWN") f.send.mockRejectedValueOnce(new Error("send timed out after 10000ms"));
    await f.h.buzzAdapter.deliverPending();
    expect(f.h.cp.sessions.transition(f.first.sessionId, SessionLifecycle.STOPPED, "replaced").allowed).toBe(true);
    const recipient = mode === "surviving holder" ? "changed-key" : "first-key";
    const next = readyCeo(f.h, { room: "first-room-alias", identity: recipient });
    if (mode === "surviving holder") {
      expect(f.h.cp.bindings.switchTo({ role: Role.CEO, sessionId: next.sessionId, conversation: "SURVIVED", reason: "runtime move" }).allowed).toBe(true);
    } else {
      expect(f.h.cp.bindings.revoke("CEO", "runtime replacement").allowed).toBe(true);
      expect(f.h.cp.bindings.bind({ role: Role.CEO, sessionId: next.sessionId }).allowed).toBe(true);
    }
    for (let n = 0; n < 2; n++) {
      await f.h.buzzAdapter.deliverPending();
      expect(sendsOf(f.send, id)).toBe(1);
      expect(outboxDeliveryReadback(f.h.cp.outbox.get(id)!)).toMatchObject({ delivered: false, automaticResendHeld: true, completed: false });
    }
    expect(f.h.cp.outbox.sentTo(id, { room: "first-room", recipient: "first-key" })).toBe(outcome);
    expect(f.h.cp.outbox.sentTo(id, { room: "first-room-alias", recipient })).toBeNull();
  } finally { f.h.cp.close(); }
});
