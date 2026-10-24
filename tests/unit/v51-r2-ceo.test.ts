import { afterAll, describe, expect, it, vi } from "vitest";

import type { BuzzSendReceipt, BuzzTransport } from "../../src/buzz/buzz-adapter.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { createConfiguredHermesGatewayDaemonNoticeTarget, startConfiguredCeoNotificationRoute } from "../../src/daemon/agentcpd.ts";
import { Role, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { MessageKind } from "../../src/outbox/envelope.ts";
import {
  daemonNoticeCanonical,
  daemonNoticeKey,
  daemonNoticePayloadDigest,
  daemonNoticeSignature,
  type DaemonNoticeBody,
  type DaemonNoticeSendOutcome,
} from "../../src/runtime/acp-daemon-notice.ts";
import { adoptedFixture, DIGEST, LIVE, GATEWAY, TOKEN, LSTART } from "../helpers/adopted-ceo.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * ACP-R1-03 and ACP-R2-01, review round 2. A Buzz-routed CEO notification is never made terminal by
 * a transport failure, and delivery and ACK agree on its lifetime. An adopted Hermes CEO's canonical
 * notice route needs the ACP-Hermes lane secret (it signs every notice) and nothing from the Telegram
 * lane; without the secret the notification is withheld PENDING and recorded as unroutable, never
 * silently. Ported from the round-2 review's probes.
 */

const recordingTransport = () => {
  const send = vi.fn(async (_channel: string, _content: string, recipients: readonly string[]): Promise<BuzzSendReceipt> =>
    ({ eventId: `evt-${send.mock.calls.length}`, mentionPubkeys: [...recipients] }));
  const transport: BuzzTransport = { openChannel: async (purpose) => `channel:${purpose}`, available: async () => true, send,
    signerReadiness: async () => ({ signer: "a".repeat(64), registered: true }),
    policyReadiness: async (_room, _body, recipient, signer) => ({ verdict: "allowed", policyDigest: "fixture-policy", recipient, signer }),
  };
  return { transport, send };
};

type Harness = ReturnType<typeof makeHarness>;

const readyCeo = (h: Harness, route: { room: string; identity: string } | null) => {
  const session = h.cp.sessions.create({ provider: "scripted", model: "ceo", buzzAddress: route?.room ?? null });
  expect(h.cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "ready").allowed).toBe(true);
  if (route) {
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

const statusOf = (h: Harness, messageId: string) => h.cp.outbox.get(messageId)?.status;

it("review: a temporarily unavailable CEO Buzz route retains its notification after the retry budget", async () => {
  const {transport, send} = recordingTransport();
  send.mockRejectedValue(new Error("temporarily unavailable"));
  const h = makeHarness({buzzTransport: transport});
  try {
    const ceo = readyCeo(h, {room:"ceo-room", identity:"ceo-key"});
    expect(h.cp.bindings.bind({role:Role.CEO, sessionId:ceo.sessionId}).allowed).toBe(true);
    const id = notify(h,"retry-budget");
    for (let i=0; i<5; i++) {
      await h.buzzAdapter.deliverPending();
      h.clock.advance(60_000);
    }
    expect(statusOf(h,id)).toBe("PENDING");
    send.mockImplementation(async (_channel, _content, recipients) => ({eventId:"recovered",mentionPubkeys:[...recipients]}));
    expect((await h.buzzAdapter.deliverPending()).delivered).toContain(id);
  } finally {h.cp.close();}
});


it("review: an overdue Buzz-delivered CEO notification is still acknowledgeable", async () => {
  const {transport} = recordingTransport();
  const h = makeHarness({buzzTransport:transport});
  try {
    const ceo=readyCeo(h,{room:"ceo-room",identity:"ceo-key"});
    expect(h.cp.bindings.bind({role:Role.CEO,sessionId:ceo.sessionId}).allowed).toBe(true);
    const id=notify(h,"late-ack");
    h.clock.advance(31 * 60_000);
    expect((await h.buzzAdapter.deliverPending()).delivered).toContain(id);
    const binding=h.cp.bindings.active("CEO")!;
    expect(h.cp.outbox.acknowledge(id,ceo.sessionId,binding.bindingGeneration,ceo.incarnation)).toMatchObject({allowed:true,reasonCode:ReasonCode.OK});
  } finally {h.cp.close();}
});


const HERMES = {
  ACP_HERMES_LINEAGE_ROOT_DIGEST: DIGEST, ACP_HERMES_EXECUTABLE: "/opt/test/hermes",
  ACP_HERMES_PROFILE: "test", ACP_HERMES_HOME: "/opt/test/home",
  ACP_HERMES_EXECUTOR_RUNTIME_IDENTITY: "hermes-runtime:test", ACP_HERMES_GATEWAY_API_KEY: "test-key",
};
const PINNED = {
  authorityHeld: () => true, processStartToken: () => TOKEN, processStartedAt: () => LSTART,
  identityReader: () => async () => ({ session_id: LIVE, lineage_root_digest: DIGEST, process_pid: GATEWAY, process_started_at: TOKEN }),
};

it("review: a configured pinned Hermes target without the lane secret withholds the notification, recorded as unroutable", async () => {
  const f = adoptedFixture();
  try {
    const cp = f.h.cp;
    const target = createConfiguredHermesGatewayDaemonNoticeTarget(cp, HERMES, PINNED);
    expect(target).toBeTypeOf("function");
    expect(await target!()).not.toBeNull();
    const id = notify(f.h, "adopted-no-lane-secret");
    await cp.outbox.deliverCeoNotifications();
    expect(await f.h.buzzAdapter.deliverPending()).toEqual({ delivered: [], failed: [] });
    expect(statusOf(f.h, id)).toBe("PENDING");
    // Not silent: the unroutable notification is on record, once, with why.
    await f.h.buzzAdapter.deliverPending();
    const recorded = cp.audit.byKind("CEO_NOTIFICATION_ROUTE_UNAVAILABLE");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ evidence: { messageId: id, reason: "CANONICAL_TRANSPORT_NOT_ATTACHED" } });
  } finally { f.h.cp.close(); }
});

it("a pinned Hermes target and the lane secret alone, with no Telegram consumer, establish the canonical route and drain what adoption carried", async () => {
  const sent: string[] = [];
  const noticeSenderFactory = () => async (body: DaemonNoticeBody): Promise<DaemonNoticeSendOutcome> => {
    sent.push(body.event_id);
    return { kind: "RESPONDED", status: 200, body: { event_id: body.event_id, payload_digest: body.payload_digest,
      receipt: { status: "completed", receipt_id: "receipt", session_id: LIVE, lineage_root_digest: DIGEST } } };
  };
  const f = adoptedFixture({
    // Journaled unsent mail queued before adoption; pre-journal mail cannot be released.
    history: (h) => {
      expect(startConfiguredCeoNotificationRoute(h.cp, { environment: { ACP_TELEGRAM_EXTERNAL_SECRET: "lane-secret" },
        hermesConfiguration: HERMES, ports: { ...PINNED, noticeSenderFactory } })).toEqual({ started: true });
      const earlier = h.cp.sessions.create({ provider: "scripted", model: "earlier-ceo" });
      expect(h.cp.sessions.transition(earlier.sessionId, SessionLifecycle.READY, "earlier").allowed).toBe(true);
      expect(h.cp.bindings.bind({ role: Role.CEO, sessionId: earlier.sessionId }).allowed).toBe(true);
      notify(h, "queued-before-adoption");
      expect(h.cp.bindings.revoke(roleKeyFor(Role.CEO), "the CEO runtime is replaced").allowed).toBe(true);
      expect(h.cp.sessions.transition(earlier.sessionId, SessionLifecycle.STOPPED, "replaced").allowed).toBe(true);
    },
  });
  try {
    const cp = f.h.cp;
    const queued = cp.outbox.byIdempotencyKey("queued-before-adoption")!;
    expect(queued).toMatchObject({ status: "PENDING", targetSessionId: f.gatewaySessionId });
    const started = startConfiguredCeoNotificationRoute(cp, {
      environment: { ACP_TELEGRAM_EXTERNAL_SECRET: "lane-secret" },
      hermesConfiguration: HERMES,
      ports: {
        ...PINNED,
        noticeSenderFactory,
      },
    });
    expect(started).toEqual({ started: true });
    await cp.outbox.deliverCeoNotifications();
    expect(statusOf(f.h, queued.messageId)).toBe("ACKED");
    expect(sent).toHaveLength(1);
    // The journal preceded enqueue, and adoption carried this unsent row before a routeless sweep.
    expect(cp.audit.byKind("CEO_NOTIFICATION_ROUTE_UNAVAILABLE").map((row) => (row.evidence as { reason?: string }).reason))
      .toEqual([]);
    expect(cp.audit.byKind("CEO_NOTIFICATION_LEGACY_OUTCOME_UNKNOWN")).toHaveLength(0);

    // Without the secret nothing can sign a notice, and the composition says exactly that.
    const g = adoptedFixture();
    try {
      expect(startConfiguredCeoNotificationRoute(g.h.cp, { environment: {}, hermesConfiguration: HERMES, ports: PINNED }))
        .toEqual({ started: false, reason: "ACP_TELEGRAM_EXTERNAL_SECRET is not configured" });
    } finally { g.h.cp.close(); }
  } finally { f.h.cp.close(); }
});

/** A notification the Buzz transport accepted for CEO generation N, never ACKed. */
const sentToFirstCeo = async () => {
  const { transport, send } = recordingTransport();
  const h = makeHarness({ buzzTransport: transport });
  const first = readyCeo(h, { room: "ceo-room", identity: "ceo-key" });
  const bound = h.cp.bindings.bind({ role: Role.CEO, sessionId: first.sessionId });
  if (!bound.allowed) throw new Error(bound.message);
  const id = notify(h, "sent-not-acked");
  expect((await h.buzzAdapter.deliverPending()).delivered).toEqual([id]);
  expect(h.cp.outbox.get(id)).toMatchObject({ status: "SENT", targetSessionId: first.sessionId });
  return { h, send, first, firstGeneration: bound.value.bindingGeneration, id };
};

const settledByTheNewCeo = async (f: Awaited<ReturnType<typeof sentToFirstCeo>>, next: { sessionId: string; incarnation: string }) => {
  const generation = f.h.cp.bindings.active("CEO")!.bindingGeneration;
  expect(generation).toBeGreaterThan(f.firstGeneration);
  const delivered = await f.h.buzzAdapter.deliverPending();
  expect(delivered.delivered).toEqual([f.id]);
  expect(f.send).toHaveBeenLastCalledWith("ceo-room-next", expect.stringContaining(f.id), ["ceo-key-next"]);
  expect(f.h.cp.outbox.get(f.id)).toMatchObject({ status: "SENT", targetSessionId: next.sessionId, bindingGeneration: generation });
  // The departed CEO cannot settle it; the new one does, once.
  expect(f.h.cp.outbox.acknowledge(f.id, f.first.sessionId, f.firstGeneration, f.first.incarnation).allowed).toBe(false);
  expect(f.h.cp.outbox.acknowledge(f.id, next.sessionId, generation, next.incarnation)).toMatchObject({ allowed: true, reasonCode: ReasonCode.OK });
  expect(f.h.cp.outbox.get(f.id)?.status).toBe("ACKED");
  expect((await f.h.buzzAdapter.deliverPending()).delivered).toEqual([]);
};

it("an unACKed notification SENT to CEO generation N is delivered again, same id, to generation N+1 after a rebind, and its ACK settles it", async () => {
  const f = await sentToFirstCeo();
  try {
    expect(f.h.cp.bindings.revoke("CEO", "the CEO runtime is replaced").allowed).toBe(true);
    expect(f.h.cp.sessions.transition(f.first.sessionId, SessionLifecycle.STOPPED, "replaced").allowed).toBe(true);
    const next = readyCeo(f.h, { room: "ceo-room-next", identity: "ceo-key-next" });
    expect(f.h.cp.bindings.bind({ role: Role.CEO, sessionId: next.sessionId }).allowed).toBe(true);
    await settledByTheNewCeo(f, next);
  } finally { f.h.cp.close(); }
});

it("an unACKed notification SENT to CEO generation N follows a takeover to generation N+1, same id, until its ACK", async () => {
  const f = await sentToFirstCeo();
  try {
    const next = readyCeo(f.h, { room: "ceo-room-next", identity: "ceo-key-next" });
    expect(f.h.cp.bindings.switchTo({ role: Role.CEO, sessionId: next.sessionId, conversation: "REPLACED",
      reason: "the CEO is taken over", takeover: true }).allowed).toBe(true);
    await settledByTheNewCeo(f, next);
  } finally { f.h.cp.close(); }
});

/**
 * The Hermes side of `acp-daemon-notice/v1`, as the contract states it: a notice is accepted only when
 * its digest is the canonical bytes' digest, its HMAC is the one keyed by HKDF of Hermes' own copy of
 * the lane secret, and its destination is the pinned live head. Anything else is the contract's 401.
 * `deliver` may alter a sealed body on the way (a tampering path) and `answer` may replace an accepted
 * notice's receipt (a mismatching receipt). Records every body it accepted or refused.
 */
const hermesSide = (secret: string, options: {
  deliver?: (body: DaemonNoticeBody) => DaemonNoticeBody;
  answer?: (body: DaemonNoticeBody) => { status: number; body: unknown };
} = {}) => {
  const accepted: DaemonNoticeBody[] = [];
  const refused: DaemonNoticeBody[] = [];
  const noticeSenderFactory = () => async (sealed: DaemonNoticeBody): Promise<DaemonNoticeSendOutcome> => {
    const body = options.deliver ? options.deliver(sealed) : sealed;
    const canonical = daemonNoticeCanonical(body);
    const authentic = body.payload_digest === daemonNoticePayloadDigest(canonical) &&
      typeof body.signature === "string" && body.signature === daemonNoticeSignature(daemonNoticeKey(secret), canonical) &&
      body.destination.session_id === LIVE && body.destination.lineage_root_digest === DIGEST;
    if (!authentic) {
      refused.push(body);
      return { kind: "RESPONDED", status: 401, body: { error: "daemon_notice_signature_invalid" } };
    }
    accepted.push(body);
    const answer = options.answer?.(body) ?? { status: 200, body: { event_id: body.event_id, payload_digest: body.payload_digest,
      receipt: { status: "completed", receipt_id: `receipt-${accepted.length}`, session_id: LIVE, lineage_root_digest: DIGEST } } };
    return { kind: "RESPONDED", status: answer.status, body: answer.body };
  };
  return { noticeSenderFactory, accepted, refused };
};

const completions = (h: Harness) => h.cp.audit.byKind("CEO_NOTIFICATION_ACCEPTED").length;

describe("ACP-R1-03 closure: the canonical CEO notice route is signed, or it does not deliver", () => {
  it("(a) a pinned target and a valid lane secret deliver an authenticated notice, with no lane consumer, owner or chat ids", async () => {
    const f = adoptedFixture();
    try {
      const hermes = hermesSide("lane-secret");
      const environment = { ACP_TELEGRAM_EXTERNAL_SECRET: "lane-secret" };
      expect(Object.keys(environment).filter((key) => /CONSUMER|OWNER|CHAT/.test(key))).toEqual([]);
      expect(startConfiguredCeoNotificationRoute(f.h.cp, { environment, hermesConfiguration: HERMES,
        ports: { ...PINNED, noticeSenderFactory: hermes.noticeSenderFactory } })).toEqual({ started: true });
      const id = notify(f.h, "criterion-a");
      await f.h.cp.outbox.deliverCeoNotifications();
      expect(statusOf(f.h, id)).toBe("ACKED");
      expect(hermes.refused).toEqual([]);
      expect(hermes.accepted).toHaveLength(1);
      expect(hermes.accepted[0]!.text).toContain(id);
      expect(hermes.accepted[0]!.destination).toMatchObject({ session_id: LIVE, lineage_root_digest: DIGEST, process_pid: GATEWAY });
    } finally { f.h.cp.close(); }
  });

  it("(b) without the lane secret the notification is recorded unroutable and stays durably PENDING, never delivered or completed", async () => {
    const f = adoptedFixture();
    try {
      const hermes = hermesSide("lane-secret");
      expect(startConfiguredCeoNotificationRoute(f.h.cp, { environment: {}, hermesConfiguration: HERMES,
        ports: { ...PINNED, noticeSenderFactory: hermes.noticeSenderFactory } }))
        .toEqual({ started: false, reason: "ACP_TELEGRAM_EXTERNAL_SECRET is not configured" });
      const id = notify(f.h, "criterion-b");
      for (let pass = 0; pass < 3; pass += 1) {
        await f.h.cp.outbox.deliverCeoNotifications();
        expect(await f.h.buzzAdapter.deliverPending()).toEqual({ delivered: [], failed: [] });
        f.h.clock.advance(31 * 60_000);
        f.h.cp.outbox.expireOverdue();
        f.h.cp.outbox.fenceUndeliverable();
      }
      expect(f.h.cp.outbox.get(id)).toMatchObject({ status: "PENDING", attempts: 0 });
      expect(hermes.accepted).toEqual([]);
      expect(hermes.refused).toEqual([]);
      expect(completions(f.h)).toBe(0);
      expect(f.h.cp.audit.byKind("CEO_NOTIFICATION_ROUTE_UNAVAILABLE").map((row) => row.evidence))
        .toEqual([expect.objectContaining({ messageId: id, reason: "CANONICAL_TRANSPORT_NOT_ATTACHED" })]);
    } finally { f.h.cp.close(); }
  });

  it("(c) once the route exists, every queued notification reaches the adopted target exactly once", async () => {
    const hermes = hermesSide("lane-secret");
    const f = adoptedFixture({
      history: (h) => {
        expect(startConfiguredCeoNotificationRoute(h.cp, { environment: { ACP_TELEGRAM_EXTERNAL_SECRET: "lane-secret" },
          hermesConfiguration: HERMES, ports: { ...PINNED, noticeSenderFactory: hermes.noticeSenderFactory } })).toEqual({ started: true });
        const earlier = h.cp.sessions.create({ provider: "scripted", model: "earlier-ceo" });
        expect(h.cp.sessions.transition(earlier.sessionId, SessionLifecycle.READY, "earlier").allowed).toBe(true);
        expect(h.cp.bindings.bind({ role: Role.CEO, sessionId: earlier.sessionId }).allowed).toBe(true);
        notify(h, "queued-1");
        notify(h, "queued-2");
        expect(h.cp.bindings.revoke(roleKeyFor(Role.CEO), "replaced").allowed).toBe(true);
        expect(h.cp.sessions.transition(earlier.sessionId, SessionLifecycle.STOPPED, "replaced").allowed).toBe(true);
      },
    });
    try {
      const ids = ["queued-1", "queued-2"].map((key) => f.h.cp.outbox.byIdempotencyKey(key)!.messageId);
      expect(startConfiguredCeoNotificationRoute(f.h.cp, { environment: { ACP_TELEGRAM_EXTERNAL_SECRET: "lane-secret" },
        hermesConfiguration: HERMES, ports: { ...PINNED, noticeSenderFactory: hermes.noticeSenderFactory } })).toEqual({ started: true });
      for (let pass = 0; pass < 3; pass += 1) {
        await f.h.cp.outbox.deliverCeoNotifications();
        expect(await f.h.buzzAdapter.deliverPending()).toEqual({ delivered: [], failed: [] });
      }
      for (const id of ids) expect(f.h.cp.outbox.get(id)).toMatchObject({ status: "ACKED", targetSessionId: f.gatewaySessionId });
      expect(hermes.accepted.map((body) => ids.find((id) => body.text.includes(id)))).toEqual(ids);
      expect(new Set(hermes.accepted.map((body) => body.event_id)).size).toBe(2);
      expect(hermes.accepted.every((body) => body.destination.session_id === LIVE)).toBe(true);
      expect(completions(f.h)).toBe(2);
    } finally { f.h.cp.close(); }
  });

  const tamper = (body: DaemonNoticeBody): DaemonNoticeBody => ({ ...body, text: `${body.text} (altered)` });
  const unsigned = (body: DaemonNoticeBody): DaemonNoticeBody => ({ ...body, signature: "" });
  const receipt = (patch: (body: DaemonNoticeBody) => Record<string, unknown>) =>
    (body: DaemonNoticeBody) => ({ status: 200, body: { event_id: body.event_id, payload_digest: body.payload_digest,
      receipt: { status: "completed", receipt_id: "receipt", session_id: LIVE, lineage_root_digest: DIGEST }, ...patch(body) } });
  it.each([
    ["a signature under the wrong lane key", "another-secret", {}],
    ["a tampered notice", "lane-secret", { deliver: tamper }],
    ["a notice with its signature missing", "lane-secret", { deliver: unsigned }],
    ["a receipt for another event", "lane-secret", { answer: receipt(() => ({ event_id: "acp-notice:" + "0".repeat(64) })) }],
    ["a receipt for other bytes", "lane-secret", { answer: receipt(() => ({ payload_digest: "sha256:" + "0".repeat(64) })) }],
    ["a receipt from another session", "lane-secret", { answer: receipt(() => ({
      receipt: { status: "completed", receipt_id: "receipt", session_id: "another-session", lineage_root_digest: DIGEST } })) }],
    ["a receipt that is not completed", "lane-secret", { answer: receipt(() => ({
      receipt: { status: "failed", receipt_id: "receipt", session_id: LIVE, lineage_root_digest: DIGEST } })) }],
    ["a non-200 answer", "lane-secret", { answer: (body: DaemonNoticeBody) => ({ status: 500, body: { event_id: body.event_id } }) }],
  ] as const)("(d) %s is never accepted as a canonical delivery; the notification stays PENDING", async (_what, daemonSecret, options) => {
    const f = adoptedFixture();
    try {
      const hermes = hermesSide("lane-secret", options);
      expect(startConfiguredCeoNotificationRoute(f.h.cp, { environment: { ACP_TELEGRAM_EXTERNAL_SECRET: daemonSecret },
        hermesConfiguration: HERMES, ports: { ...PINNED, noticeSenderFactory: hermes.noticeSenderFactory } })).toEqual({ started: true });
      const id = notify(f.h, "criterion-d");
      await f.h.cp.outbox.deliverCeoNotifications();
      expect(statusOf(f.h, id)).toBe("PENDING");
      expect(completions(f.h)).toBe(0);
      expect(f.h.cp.audit.byKind("CEO_NOTIFICATION_DELIVERY_FAILED").length).toBeGreaterThan(0);
    } finally { f.h.cp.close(); }
  });

  it("(d) the Gateway API key alone never stands in for the lane secret: nothing is sent", async () => {
    const f = adoptedFixture();
    try {
      const factory = vi.fn(hermesSide("lane-secret").noticeSenderFactory);
      expect(HERMES.ACP_HERMES_GATEWAY_API_KEY).toBe("test-key");
      expect(startConfiguredCeoNotificationRoute(f.h.cp, { environment: { ACP_HERMES_GATEWAY_API_KEY: "test-key" },
        hermesConfiguration: HERMES, ports: { ...PINNED, noticeSenderFactory: factory } }))
        .toEqual({ started: false, reason: "ACP_TELEGRAM_EXTERNAL_SECRET is not configured" });
      const id = notify(f.h, "criterion-d-api-key");
      await f.h.cp.outbox.deliverCeoNotifications();
      expect(factory).not.toHaveBeenCalled();
      expect(statusOf(f.h, id)).toBe("PENDING");
      expect(completions(f.h)).toBe(0);
    } finally { f.h.cp.close(); }
  });
});
