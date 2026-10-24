import { afterAll, expect, it, vi } from "vitest";

import type { BuzzSendReceipt, BuzzTransport } from "../../src/buzz/buzz-adapter.ts";
import { Role, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { MessageKind } from "../../src/outbox/envelope.ts";
import { outboxDeliveryReadback } from "../../src/outbox/outbox.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * FCR-08, second focused review, within CEO decisions 9b15c462 and 1fd967e8 — whether a receiver is
 * the one a CEO notification was already sent to is judged only from where it was actually sent: the
 * exact room and recipient key each send that may have landed addressed, recorded with that send's
 * outcome. Never from a session's current, mutable address or identity: changing the old session's
 * address cannot make the same recipient look new (a resend) or a new recipient look the same (a
 * suppressed first delivery). A row with no such record is unknown, and an unknown outcome is never
 * sent again on a holder change. Ported from the second focused review's probes.
 */
type Harness = ReturnType<typeof makeHarness>;
const recordingTransport = () => {
  const send = vi.fn(async (_channel: string, _content: string, recipients: readonly string[]): Promise<BuzzSendReceipt> =>
    ({ eventId: `evt-${send.mock.calls.length}`, mentionPubkeys: [...recipients] }));
  const policyReadiness = vi.fn<NonNullable<BuzzTransport["policyReadiness"]>>(async (_room, _content, recipient, signer) =>
    ({ verdict: "allowed", policyDigest: "fixture-policy", signer, recipient }));
  const transport: BuzzTransport = { openChannel: async (purpose) => `channel:${purpose}`, available: async () => true, send,
    signerReadiness: async () => ({ signer: "fixture-signer", registered: true }),
    localSendPolicyDigest: () => "fixture-policy",
    policyReadiness,
  };
  return { transport, send, policyReadiness };
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
const buzzCeo = () => {
  const { transport, send, policyReadiness } = recordingTransport();
  const h = makeHarness({ buzzTransport: transport });
  const first = readyCeo(h, { room: "first-room", identity: "first-key" });
  const bound = h.cp.bindings.bind({ role: Role.CEO, sessionId: first.sessionId });
  if (!bound.allowed) throw new Error(bound.message);
  return { h, send, policyReadiness, first, firstGeneration: bound.value.bindingGeneration };
};
const sendsOf = (send: ReturnType<typeof recordingTransport>["send"], id: string) =>
  send.mock.calls.filter((call) => String(call[1]).includes(id)).length;

/** A readiness-qualified CEO send timed out: PENDING/unknown, resend held at the first CEO. */
const timedOut = async (key: string) => {
  const f = buzzCeo();
  const id = notify(f.h, key);
  f.send.mockRejectedValueOnce(new Error("send timed out after 10000ms"));
  await f.h.buzzAdapter.deliverPending();
  expect(f.policyReadiness).toHaveBeenCalledExactlyOnceWith("first-room", expect.stringContaining(id), "first-key", "fixture-signer");
  expect(stateOf(f.h, id)).toMatchObject({ status: "PENDING", failure_class: "unknown_observed", target_session_id: f.first.sessionId });
  expect(sendsOf(f.send, id)).toBe(1);
  expect(outboxDeliveryReadback(f.h.cp.outbox.get(id)!)).toMatchObject({ status: "OUTCOME_UNKNOWN",
    delivered: false, completed: false, automaticResendHeld: true });
  return { ...f, id, sent: sendsOf(f.send, id) };
};

const destinationsOf = (h: Harness, id: string) =>
  h.cp.db.all<{ room: string; recipient: string; outcome: string }>(
    "SELECT room, recipient, outcome FROM outbox_sent_destinations WHERE message_id = ? ORDER BY room, recipient", [id]);
/** The CEO runtime is replaced: revoked, stopped, and another session bound answering at `route`. */
const replaceWith = (f: Awaited<ReturnType<typeof timedOut>>, route: { room: string | null; identity: string | null }) => {
  expect(f.h.cp.bindings.revoke("CEO", "runtime replacement").allowed).toBe(true);
  expect(f.h.cp.sessions.transition(f.first.sessionId, SessionLifecycle.STOPPED, "replaced").allowed).toBe(true);
  const next = readyCeo(f.h, route);
  expect(f.h.cp.bindings.bind({ role: Role.CEO, sessionId: next.sessionId }).allowed).toBe(true);
  return next;
};

it.each(["refused", "undeterminable"] as const)("FCR-08: the recording fixture still enforces a %s policy verdict", async verdict => {
  const f = buzzCeo();
  try {
    const id = notify(f.h, `policy-${verdict}`);
    f.policyReadiness.mockResolvedValue({ verdict, cause: "POLICY", policyDigest: "fixture-policy", signer: "fixture-signer", recipient: "first-key" });
    expect((await f.h.buzzAdapter.deliverPending()).delivered).toEqual([]);
    expect(f.policyReadiness).toHaveBeenCalledExactlyOnceWith("first-room", expect.stringContaining(id), "first-key", "fixture-signer");
    expect(f.send).not.toHaveBeenCalled();
    expect(stateOf(f.h, id)).toMatchObject({ status: "PENDING" });
    expect(destinationsOf(f.h, id)).toEqual([]);
  } finally { f.h.cp.close(); }
});

it("FCR-08: each send that may have landed records its exact room and recipient key, with its outcome", async () => {
  const f = await timedOut("destination-recorded");
  try {
    expect(destinationsOf(f.h, f.id)).toEqual([{ room: "first-room", recipient: "first-key", outcome: "UNKNOWN" }]);
    const accepted = notify(f.h, "destination-accepted");
    expect((await f.h.buzzAdapter.deliverPending()).delivered).toEqual([accepted]);
    expect(destinationsOf(f.h, accepted)).toEqual([{ room: "first-room", recipient: "first-key", outcome: "ACCEPTED" }]);
  } finally { f.h.cp.close(); }
});

it("FCR-08: changing the old session's address cannot make the timed-out recipient look new; it is not sent there again", async () => {
  const f = await timedOut("receiver-address-mutated");
  try {
    f.h.cp.sessions.setBuzzAddress(f.first.sessionId, "changed-after-send");
    const next = replaceWith(f, { room: "first-room", identity: "first-key" });
    expect(stateOf(f.h, f.id)).toMatchObject({ status: "PENDING", failure_class: "unknown_observed", target_session_id: next.sessionId });
    f.h.clock.advance(60 * 60_000);
    expect((await f.h.buzzAdapter.deliverPending()).delivered).not.toContain(f.id);
    expect(sendsOf(f.send, f.id)).toBe(f.sent);
  } finally { f.h.cp.close(); }
});

it("FCR-08: the old session's current address cannot suppress the first delivery to a verified different recipient key", async () => {
  const f = await timedOut("new-receiver-suppressed");
  try {
    f.h.cp.sessions.setBuzzAddress(f.first.sessionId, "new-room");
    const next = replaceWith(f, { room: "new-room", identity: "new-key" });
    expect(stateOf(f.h, f.id)).toMatchObject({ status: "PENDING", failure_class: null, target_session_id: next.sessionId });
    expect((await f.h.buzzAdapter.deliverPending()).delivered).toEqual([f.id]);
    expect(f.send.mock.calls.filter((call) => String(call[1]).includes(f.id)).map((call) => call[0])).toEqual(["first-room", "new-room"]);
    expect(destinationsOf(f.h, f.id)).toEqual([
      { room: "first-room", recipient: "first-key", outcome: "UNKNOWN" },
      { room: "new-room", recipient: "new-key", outcome: "ACCEPTED" },
    ]);
  } finally { f.h.cp.close(); }
});

it("FCR-08: a holder with no route yet gets the row, and when its route turns out to be the recorded destination nothing is sent there again", async () => {
  const f = await timedOut("route-arrives-later");
  try {
    const next = replaceWith(f, { room: null, identity: "first-key" });
    // The receiving key is unchanged: a missing room cannot erase its unknown send history.
    expect(stateOf(f.h, f.id)).toMatchObject({ status: "PENDING", failure_class: "unknown_observed", target_session_id: next.sessionId });
    expect((await f.h.buzzAdapter.deliverPending()).delivered).not.toContain(f.id);
    expect(sendsOf(f.send, f.id)).toBe(f.sent);
    f.h.cp.sessions.setBuzzAddress(next.sessionId, "first-room");
    expect((await f.h.buzzAdapter.deliverPending()).delivered).not.toContain(f.id);
    expect(sendsOf(f.send, f.id)).toBe(f.sent);
    // A route with no accepted post has no inherited sent_at; its unknown outcome stays PENDING.
    expect(stateOf(f.h, f.id)).toMatchObject({ status: "PENDING", failure_class: "unknown_observed", target_session_id: next.sessionId });
    expect(outboxDeliveryReadback(f.h.cp.outbox.get(f.id)!)).toMatchObject({ status: "OUTCOME_UNKNOWN",
      delivered: false, automaticResendHeld: true });
    const incarnation = f.h.cp.sessions.require(next.sessionId).incarnation;
    const generation = f.h.cp.bindings.active("CEO")!.bindingGeneration;
    expect(f.h.cp.outbox.acknowledge(f.id, next.sessionId, generation, incarnation).allowed).toBe(true);
  } finally { f.h.cp.close(); }
});

it("FCR-08: a row with an unknown outcome and no record of where it went is never sent again on a holder change", async () => {
  const f = await timedOut("legacy-unknown");
  try {
    // A row written before v51 recorded destinations: retain its legacy SENT/unknown representation
    // explicitly, even though this fixture's newly qualified timeout follows the PENDING branch.
    f.h.cp.db.run("UPDATE outbox SET status = 'SENT', sent_at = ? WHERE message_id = ?", [f.h.clock.nowIso(), f.id]);
    if (f.h.cp.db.all("SELECT name FROM sqlite_schema WHERE name = 'outbox_sent_destinations'").length > 0) {
      f.h.cp.db.run("DELETE FROM outbox_sent_destinations WHERE message_id = ?", [f.id]);
    }
    const next = replaceWith(f, { room: "next-room", identity: "next-key" });
    expect(stateOf(f.h, f.id)).toMatchObject({ status: "SENT", failure_class: "unknown_observed", target_session_id: next.sessionId });
    f.h.clock.advance(60 * 60_000);
    expect((await f.h.buzzAdapter.deliverPending()).delivered).not.toContain(f.id);
    expect(sendsOf(f.send, f.id)).toBe(f.sent);
  } finally { f.h.cp.close(); }
});
