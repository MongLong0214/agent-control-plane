import { afterAll, expect, it, vi } from "vitest";

import type { BuzzSendReceipt, BuzzTransport } from "../../src/buzz/buzz-adapter.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { startConfiguredCeoNotificationRoute } from "../../src/daemon/agentcpd.ts";
import { Role, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { MessageKind } from "../../src/outbox/envelope.ts";
import { outboxDeliveryReadback } from "../../src/outbox/outbox.ts";
import type { DaemonNoticeBody, DaemonNoticeSendOutcome } from "../../src/runtime/acp-daemon-notice.ts";
import { adoptedFixture, DIGEST, GATEWAY, LIVE, LSTART, TOKEN } from "../helpers/adopted-ceo.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * ACP-R2-01, review round 3, within CEO decision 9b15c462 — the same re-arm policy for CEO
 * notifications. One whose attempt found no route (the CEO lost its room between the claim and the
 * send) is deliverable again on every authenticated route change of the CEO — an address set or
 * restored, a takeover, a rebind after a revoke, a runtime move — with its message id, and the
 * replaced CEO cannot settle it. Within a binding a relay's refusal stays held; on a holder
 * retarget, CEO 8fa870fa requires restoring only the selected destination's ledger. An unknown send is never
 * re-sent to the same CEO and is delivered once to a new CEO; the canonical Hermes route re-sends
 * only as a receipt lookup (the same event id and the same signed bytes).
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

/** A Buzz-backed CEO, generation N, with one notification whose attempt was failed by `fail`. */
const failedOnce = async (fail: (h: Harness, first: { sessionId: string }, send: ReturnType<typeof recordingTransport>["send"]) => void) => {
  const { transport, send } = recordingTransport();
  const h = makeHarness({ buzzTransport: transport });
  const first = readyCeo(h, { room: "first-room", identity: "first-key" });
  const bound = h.cp.bindings.bind({ role: Role.CEO, sessionId: first.sessionId });
  if (!bound.allowed) throw new Error(bound.message);
  fail(h, first, send);
  return { h, send, transport, first, firstGeneration: bound.value.bindingGeneration };
};

/** The CEO loses its room between the claim and the send: the second notification found no route. */
const routeAbsent = async () => {
  const f = await failedOnce(() => undefined);
  notify(f.h, "sent-before-the-room-was-lost");
  const id = notify(f.h, "found-no-route");
  f.send.mockImplementationOnce(async (_channel, _content, recipients) => {
    f.h.cp.sessions.setBuzzAddress(f.first.sessionId, null);
    return { eventId: "first", mentionPubkeys: [...recipients] };
  });
  expect((await f.h.buzzAdapter.deliverPending()).failed).toEqual([id]);
  expect(stateOf(f.h, id)).toMatchObject({ status: "PENDING", failure_class: "repairable" });
  f.h.clock.advance(60 * 60_000);
  expect((await f.h.buzzAdapter.deliverPending()).delivered).toEqual([]);
  return { ...f, id };
};

/** By default, an explicit registration refusal limited to the receiving recipient. */
const relayRefused = async (error = "buzz send failed: {\"error\":\"mention_policy\",\"message\":\"recipient not registered for channel\",\"retryable\":false}") => {
  const f = await failedOnce(() => undefined);
  const id = notify(f.h, "r3-contract-takeover");
  f.send.mockRejectedValue(new Error(error));
  expect((await f.h.buzzAdapter.deliverPending()).failed).toEqual([id]);
  expect(stateOf(f.h, id)).toMatchObject({ status: "PENDING", failure_class: /permission/.test(error) ? "security" : "contract" });
  f.send.mockImplementation(async (_channel, _content, recipients) => ({ eventId: "working-route", mentionPubkeys: [...recipients] }));
  return { ...f, id };
};

type Failed = Awaited<ReturnType<typeof failedOnce>>;

type Ceo = ReturnType<typeof readyCeo>;
const replaceCeo = (f: Failed, conversation: "REPLACED" | "SURVIVED"): Ceo => {
  const next = readyCeo(f.h, { room: "next-room", identity: null });
  if (conversation === "SURVIVED") {
    expect(f.h.cp.sessions.transition(f.first.sessionId, SessionLifecycle.STOPPED, "runtime moves").allowed).toBe(true);
  }
  const moved = f.h.cp.bindings.switchTo({ role: Role.CEO, sessionId: next.sessionId, conversation,
    reason: "the CEO's route recovers", ...(conversation === "REPLACED" ? { takeover: true } : {}) });
  if (!moved.allowed) throw new Error(moved.message);
  if (conversation === "REPLACED") {
    expect(f.h.cp.sessions.transition(f.first.sessionId, SessionLifecycle.STOPPED, "replaced").allowed).toBe(true);
  }
  expect(f.h.cp.sessions.bindBuzzActor({ sessionId: next.sessionId, sessionSecret: next.sessionSecret!, buzzActorId: "next-key" },
    { isAllowedActor: () => true }).allowed).toBe(true);
  return next;
};
const rebindCeo = (f: Failed): Ceo => {
  expect(f.h.cp.bindings.revoke(roleKeyFor(Role.CEO), "the CEO runtime is replaced").allowed).toBe(true);
  expect(f.h.cp.sessions.transition(f.first.sessionId, SessionLifecycle.STOPPED, "replaced").allowed).toBe(true);
  const next = readyCeo(f.h, { room: "next-room", identity: "next-key" });
  expect(f.h.cp.bindings.bind({ role: Role.CEO, sessionId: next.sessionId }).allowed).toBe(true);
  return next;
};
const CEO_HANDOVERS: ReadonlyArray<readonly [string, (f: Failed) => Ceo | null]> = [
  ["a takeover", (f: Failed) => replaceCeo(f, "REPLACED")],
  ["a runtime move", (f: Failed) => replaceCeo(f, "SURVIVED")],
  ["a rebind after a revoke", rebindCeo],
];

it.each(CEO_HANDOVERS)("R3 probe: a CEO notification whose route was absent resumes after %s, at the new CEO only, same id", async (_what, change) => {
  const f = await routeAbsent();
  try {
    const next = change(f)!;
    const generation = f.h.cp.bindings.active("CEO")!.bindingGeneration;
    const sentEarlier = f.h.cp.outbox.byIdempotencyKey("sent-before-the-room-was-lost")!.messageId;
    // The route-absent row has no departed send. An accepted row needs a genuinely new holder
    // as well as a new destination; a surviving conversation's runtime move is not one.
    const expected = _what === "a runtime move" ? [f.id] : [f.id, sentEarlier];
    expect((await f.h.buzzAdapter.deliverPending()).delivered.sort()).toEqual(expected.sort());
    if (_what === "a runtime move") expect(f.send.mock.calls.filter(call => call[1].includes(sentEarlier))).toHaveLength(1);
    expect(f.send).toHaveBeenCalledWith("next-room", expect.stringContaining(f.id), ["next-key"]);
    expect(f.h.cp.outbox.acknowledge(f.id, f.first.sessionId, f.firstGeneration, f.first.incarnation).allowed).toBe(false);
    expect(f.h.cp.outbox.acknowledge(f.id, next.sessionId, generation, next.incarnation))
      .toMatchObject({ allowed: true, reasonCode: ReasonCode.OK });
  } finally { f.h.cp.close(); }
});

it("R3 probe: a CEO notification whose route was absent resumes when the same CEO's address is restored", async () => {
  const f = await routeAbsent();
  try {
    f.h.cp.sessions.setBuzzAddress(f.first.sessionId, "restored-room");
    expect((await f.h.buzzAdapter.deliverPending()).delivered).toEqual([f.id]);
    expect(f.send).toHaveBeenLastCalledWith("restored-room", expect.stringContaining(f.id), ["first-key"]);
  } finally { f.h.cp.close(); }
});

it.each(CEO_HANDOVERS.filter(([what]) => what !== "a runtime move"))(
  "CEO 6bd2011d: a verified replacement holder and destination may leave a recipient refusal after %s",
  async (_what, change) => {
    const f = await relayRefused();
    try {
      const sends = f.send.mock.calls.length;
      const next = change(f)!;
      expect(f.h.cp.sessions.get(next.sessionId)).toMatchObject({ buzzAddress: "next-room", buzzActorId: "next-key" });
      expect(["next-room", "next-key"]).not.toEqual(["first-room", "first-key"]);
      expect((await f.h.buzzAdapter.deliverPending()).delivered).toEqual([f.id]);
      expect((await f.h.buzzAdapter.deliverPending()).delivered).toEqual([]);
      expect(f.send.mock.calls.length).toBe(sends + 1);
      expect(stateOf(f.h, f.id)).toMatchObject({ status: "SENT", failure_class: null, target_session_id: next.sessionId });
      expect(outboxDeliveryReadback(f.h.cp.outbox.get(f.id)!)).toMatchObject({ delivered: true, completed: false });
    } finally { f.h.cp.close(); }
  },
);

it("CEO 6bd2011d: a surviving holder cannot discard refusal by moving runtime, room and key", async () => {
  const f = await relayRefused();
  try {
    const sends = f.send.mock.calls.length;
    const before = f.h.cp.bindings.active("CEO")!;
    replaceCeo(f, "SURVIVED");
    expect(f.h.cp.bindings.active("CEO")!.bindingGeneration).toBe(before.bindingGeneration);
    for (let n = 0; n < 2; n++) { await f.h.buzzAdapter.deliverPending(); expect(f.send.mock.calls.length).toBe(sends); }
    expect(stateOf(f.h, f.id)).toMatchObject({ status: "PENDING", failure_class: "contract" });
  } finally { f.h.cp.close(); }
});

it("CEO 8fa870fa: an address change within the same binding does not retry a relay refusal", async () => {
  const f = await relayRefused();
  try {
    const sends = f.send.mock.calls.length;
    f.h.cp.sessions.setBuzzAddress(f.first.sessionId, "other-room");
    f.h.clock.advance(60 * 60_000);
    expect((await f.h.buzzAdapter.deliverPending()).delivered).toEqual([]);
    expect(f.send.mock.calls.length).toBe(sends);
    expect(stateOf(f.h, f.id)).toMatchObject({ status: "PENDING", failure_class: "contract" });
  } finally { f.h.cp.close(); }
});

it("R3 boundary: an outcome-unknown Buzz send to the CEO is flagged, never re-sent to the same CEO, and delivered once to a new CEO", async () => {
  const f = await failedOnce(() => undefined);
  try {
    const id = notify(f.h, "timed-out");
    f.send.mockRejectedValueOnce(new Error("send timed out after 10000ms"));
    expect((await f.h.buzzAdapter.deliverPending()).failed).toEqual([id]);
    expect(stateOf(f.h, id)).toMatchObject({ status: "SENT", failure_class: "unknown_observed" });
    const sends = f.send.mock.calls.length;
    f.h.clock.advance(24 * 60 * 60_000);
    f.h.cp.sessions.setBuzzAddress(f.first.sessionId, "first-room-renamed");
    expect((await f.h.buzzAdapter.deliverPending()).delivered).toEqual([]);
    expect(f.send.mock.calls.length).toBe(sends);
    replaceCeo(f, "REPLACED");
    expect((await f.h.buzzAdapter.deliverPending()).delivered).toEqual([id]);
    expect((await f.h.buzzAdapter.deliverPending()).delivered).toEqual([]);
  } finally { f.h.cp.close(); }
});

it("R3 boundary: the canonical Hermes route re-sends an uncertain notice only as a receipt lookup — the same event id and signed bytes, settled once", async () => {
  const f = adoptedFixture();
  try {
    const bodies: DaemonNoticeBody[] = [];
    let answer: "UNCERTAIN" | "COMPLETED" = "COMPLETED";
    const noticeSenderFactory = () => async (body: DaemonNoticeBody): Promise<DaemonNoticeSendOutcome> => {
      bodies.push(body);
      if (answer === "UNCERTAIN") return { kind: "UNCERTAIN", reason: "no answer was read" };
      return { kind: "RESPONDED", status: 200, body: { event_id: body.event_id, payload_digest: body.payload_digest,
        receipt: { status: "completed", receipt_id: "receipt-1", session_id: LIVE, lineage_root_digest: DIGEST } } };
    };
    expect(startConfiguredCeoNotificationRoute(f.h.cp, { environment: { ACP_TELEGRAM_EXTERNAL_SECRET: "lane-secret" },
      hermesConfiguration: { ACP_HERMES_LINEAGE_ROOT_DIGEST: DIGEST, ACP_HERMES_EXECUTABLE: "/opt/test/hermes", ACP_HERMES_PROFILE: "test",
        ACP_HERMES_HOME: "/opt/test/home", ACP_HERMES_EXECUTOR_RUNTIME_IDENTITY: "hermes-runtime:test", ACP_HERMES_GATEWAY_API_KEY: "test-key" },
      ports: { authorityHeld: () => true, processStartToken: () => TOKEN, processStartedAt: () => LSTART,
        identityReader: () => async () => ({ session_id: LIVE, lineage_root_digest: DIGEST, process_pid: GATEWAY, process_started_at: TOKEN }),
        noticeSenderFactory } })).toEqual({ started: true });
    // Receiver support is established independently before any in-doubt receipt lookup.
    notify(f.h, "verify-canonical-support");
    await f.h.cp.outbox.deliverCeoNotifications();
    bodies.length = 0;
    answer = "UNCERTAIN";
    const id = notify(f.h, "uncertain-canonical");
    await f.h.cp.outbox.deliverCeoNotifications();
    expect(f.h.cp.outbox.get(id)?.status).toBe("PENDING");
    answer = "COMPLETED";
    await f.h.cp.outbox.deliverCeoNotifications();
    expect(f.h.cp.outbox.get(id)?.status).toBe("ACKED");
    expect(bodies.length).toBeGreaterThanOrEqual(2);
    expect(new Set(bodies.map((body) => body.event_id)).size).toBe(1);
    expect(new Set(bodies.map((body) => body.payload_digest)).size).toBe(1);
    expect(new Set(bodies.map((body) => body.signature)).size).toBe(1);
    expect(f.h.cp.audit.byKind("CEO_NOTIFICATION_ACCEPTED")).toHaveLength(2);
  } finally { f.h.cp.close(); }
});

it("R3 probe: a CEO notification withheld for want of a channel identity resumes when the identity is bound", async () => {
  const { transport, send } = recordingTransport();
  const h = makeHarness({ buzzTransport: transport });
  try {
    const ceo = readyCeo(h, { room: "ceo-room", identity: null });
    expect(h.cp.bindings.bind({ role: Role.CEO, sessionId: ceo.sessionId }).allowed).toBe(true);
    const id = notify(h, "r3-identity");
    // With no channel identity there is no Buzz route: withheld, never attempted, never failed.
    expect((await h.buzzAdapter.deliverPending())).toEqual({ delivered: [], failed: [] });
    expect(h.cp.outbox.get(id)).toMatchObject({ status: "PENDING", attempts: 0 });
    expect(h.cp.sessions.bindBuzzActor({ sessionId: ceo.sessionId, sessionSecret: ceo.sessionSecret!, buzzActorId: "ceo-key" },
      { isAllowedActor: () => true }).allowed).toBe(true);
    expect((await h.buzzAdapter.deliverPending()).delivered).toEqual([id]);
    expect(send).toHaveBeenLastCalledWith("ceo-room", expect.stringContaining(id), ["ceo-key"]);
  } finally { h.cp.close(); }
});


it.each(["runtime move", "same-runtime rebind", "same-recipient rebind", "address notation"] as const)(
  "CEO 6bd2011d: %s cannot leave the same recipient's refusal behind", async mode => {
    const f = await relayRefused();
    try {
      const sends = f.send.mock.calls.length;
      if (mode === "same-runtime rebind") {
        expect(f.h.cp.bindings.revoke("CEO", "same runtime").allowed).toBe(true);
        expect(f.h.cp.bindings.bind({ role: Role.CEO, sessionId: f.first.sessionId }).allowed).toBe(true);
      } else {
        expect(f.h.cp.sessions.transition(f.first.sessionId, SessionLifecycle.STOPPED, "runtime ends").allowed).toBe(true);
        const next = readyCeo(f.h, { room: mode === "address notation" ? "first-room-alias" : "first-room", identity: "first-key" });
        if (mode === "runtime move") expect(f.h.cp.bindings.switchTo({ role: Role.CEO, sessionId: next.sessionId,
          conversation: "SURVIVED", reason: "same recipient" }).allowed).toBe(true);
        else {
          expect(f.h.cp.bindings.revoke("CEO", "same recipient").allowed).toBe(true);
          expect(f.h.cp.bindings.bind({ role: Role.CEO, sessionId: next.sessionId }).allowed).toBe(true);
        }
      }
      for (let n = 0; n < 2; n++) {
        await f.h.buzzAdapter.deliverPending();
        expect(stateOf(f.h, f.id)).toMatchObject({ status: "PENDING", failure_class: "contract" });
        expect(f.send.mock.calls.length).toBe(sends);
      }
    } finally { f.h.cp.close(); }
  });

it.each(["permission denied for sending credential", "mention_policy: signer not registered for channel"])(
  "CEO 6bd2011d: a new destination cannot release send authority refusal %s", async error => {
    const f = await relayRefused(error);
    try {
      const sends = f.send.mock.calls.length;
      replaceCeo(f, "REPLACED");
      for (let n = 0; n < 2; n++) { await f.h.buzzAdapter.deliverPending(); expect(f.send.mock.calls.length).toBe(sends); }
      expect(stateOf(f.h, f.id)?.status).toBe("PENDING");
    } finally { f.h.cp.close(); }
  });

it("CEO 6bd2011d: a new room without daemon signer readiness is withheld", async () => {
  const f = await relayRefused();
  try {
    const sends = f.send.mock.calls.length;
    replaceCeo(f, "REPLACED");
    let member = false;
    Object.assign(f.transport, { signerReadiness: vi.fn(async (room: string) => {
      expect(room).toBe("next-room"); return { signer: "a".repeat(64), registered: member };
    }) });
    for (let n = 0; n < 2; n++) { await f.h.buzzAdapter.deliverPending(); expect(f.send.mock.calls.length).toBe(sends); }
    expect(f.h.cp.outbox.get(f.id)).toMatchObject({ status: "PENDING", failureClass: "repairable" });
    member = true;
    await Promise.all([f.h.buzzAdapter.deliverPending(), f.h.buzzAdapter.deliverPending()]);
    expect(f.send.mock.calls.length).toBe(sends + 1);
    expect(f.h.cp.outbox.get(f.id)).toMatchObject({ status: "SENT" });
  } finally { f.h.cp.close(); }
});
