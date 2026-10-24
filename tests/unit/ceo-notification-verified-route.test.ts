import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import type * as Http from "node:http";

import { ReasonCode } from "../../src/core/reason-codes.ts";
import { createConfiguredHermesGatewayDaemonNoticeTarget, startConfiguredCeoNotificationRoute } from "../../src/daemon/agentcpd.ts";
import { InMemoryBuzzTransport } from "../../src/buzz/buzz-adapter.ts";
import { Outbox } from "../../src/outbox/outbox.ts";
import { MessageKind } from "../../src/outbox/envelope.ts";
import { daemonNoticeCanonical, daemonNoticeFields, daemonNoticePayloadDigest,
  sendDaemonNoticeProbe, type DaemonNoticeBody } from "../../src/runtime/acp-daemon-notice.ts";
import { createHermesGatewayIdentityReader } from "../../src/runtime/hermes-gateway-identity.ts";
import { createHermesGatewayDaemonNoticeSender } from "../../src/runtime/hermes-gateway-conversation.ts";
import { adoptedFixture, DIGEST, GATEWAY, LIVE, LSTART, TOKEN } from "../helpers/adopted-ceo.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";

const http = vi.hoisted(() => ({
  request: vi.fn(),
  posts: [] as DaemonNoticeBody[],
  mode: "refused" as "refused" | "completed" | "timeout" | "lost" | "uncertain" | "409" | "other400" | "wrongShape" | "partial" | "notSent",
  hold: false,
  release: null as (() => void) | null,
  lostMessageId: null as string | null,
  turns: new Map<string, string>(),
}));

// The production HTTP senders and outbox run unchanged. Only the HTTP socket edge is fake:
// no listener, network, real Gateway, Buzz binary, process lookup or credential store is used.
vi.mock("node:http", async (original) => {
  const real = await original<typeof Http>();
  const { EventEmitter } = await import("node:events");
  return { ...real, request: http.request.mockImplementation((_options: { method: string }, respond: (res: unknown) => void) => {
    const req = Object.assign(new EventEmitter(), {
      destroy: () => { req.emit("close"); },
      end: (bytes?: string) => {
        const isPost = _options.method === "POST";
        const notice = isPost ? JSON.parse(bytes!) as DaemonNoticeBody : null;
        if (notice) http.posts.push(notice);
        const deliver = () => {
          if (notice && (http.mode === "completed" || http.mode === "lost" || http.lostMessageId === notice.text.match(/ACP notification (\S+)/)?.[1])) {
            const raw = JSON.stringify(notice);
            const seen = http.turns.get(notice.event_id);
            if (seen && seen !== raw) throw new Error("same event id with different bytes");
            http.turns.set(notice.event_id, raw);
          }
          if (isPost && http.mode === "timeout") return;
          if (isPost && (http.mode === "lost" || (http.lostMessageId && notice?.text.includes(http.lostMessageId)))) {
            req.emit("error", new Error("response lost")); return;
          }
          const res = Object.assign(new EventEmitter(), { statusCode: 200,
            headers: { "content-type": "application/json" }, destroy: () => undefined });
          let body: unknown = { session_id: LIVE, lineage_root_digest: DIGEST, process_pid: GATEWAY, process_started_at: TOKEN };
          if (!isPost && http.mode === "notSent") res.statusCode = 503;
          if (notice) {
            const completed = http.mode === "completed" || (http.mode === "partial" && http.posts.length === 1);
            res.statusCode = completed ? 200 : http.mode === "409" ? 409 : 400;
            body = completed ? { event_id: notice.event_id, payload_digest: notice.payload_digest,
              receipt: { status: "completed", receipt_id: "receipt", session_id: LIVE, lineage_root_digest: DIGEST } }
              : http.mode === "other400" ? { error: { code: "some_other_error" } }
              : http.mode === "wrongShape" ? { error: "canonical_invalid_request" }
              : { error: { code: http.mode === "409" ? "canonical_event_uncertain" : "canonical_invalid_request" } };
          }
          respond(res);
          if (notice && http.mode === "uncertain") res.emit("aborted");
          else {
            res.emit("data", Buffer.from(JSON.stringify(body)));
            res.emit("end");
          }
          req.emit("close");
        };
        if (isPost && http.hold) http.release = deliver;
        else queueMicrotask(deliver);
      },
    });
    return req;
  }) };
});

type Fixture = ReturnType<typeof adoptedFixture>;
const fixtures: Fixture[] = [];
beforeEach(() => { http.request.mockClear(); http.posts = []; http.turns.clear(); http.mode = "refused"; http.hold = false; http.release = null; http.lostMessageId = null; });
afterEach(async () => {
  for (const f of fixtures.splice(0)) { await f.h.cp.outbox.deliverCeoNotifications(); f.h.cp.close(); }
  vi.restoreAllMocks();
});
afterAll(cleanupTempDirs);

const destination = { session_id: LIVE, lineage_root_digest: DIGEST, process_pid: GATEWAY, process_started_at: TOKEN };
const routeOptions = (httpDiscovery = false) => ({
    environment: { ACP_TELEGRAM_EXTERNAL_SECRET: "lane-secret" },
    hermesConfiguration: { ACP_HERMES_LINEAGE_ROOT_DIGEST: DIGEST, ACP_HERMES_EXECUTABLE: "/opt/test/hermes",
      ACP_HERMES_PROFILE: "test", ACP_HERMES_HOME: "/opt/test/home",
      ACP_HERMES_EXECUTOR_RUNTIME_IDENTITY: "hermes-runtime:test", ACP_HERMES_GATEWAY_API_KEY: "test-key" },
    ports: { authorityHeld: () => true, processStartToken: () => TOKEN, processStartedAt: () => LSTART,
      identityReader: httpDiscovery ? createHermesGatewayIdentityReader : () => async () => destination,
      noticeSenderFactory: (options: Parameters<typeof createHermesGatewayDaemonNoticeSender>[0]) =>
        createHermesGatewayDaemonNoticeSender({ ...options, timeoutMs: http.hold ? 5000 : 20 }) },
});
const start = async (f: Fixture, httpDiscovery = false) => {
  expect(startConfiguredCeoNotificationRoute(f.h.cp, routeOptions(httpDiscovery))).toEqual({ started: true });
  await f.h.cp.outbox.deliverCeoNotifications();
};
const probe = async (f: Fixture, nonce: string) => {
  const options = routeOptions();
  const target = createConfiguredHermesGatewayDaemonNoticeTarget(f.h.cp, options.hermesConfiguration, options.ports)!;
  return sendDaemonNoticeProbe(f.h.cp.outbox, target, "lane-secret", nonce);
};
const fixture = async () => {
  const f = adoptedFixture(); fixtures.push(f); await start(f); return f;
};
const notify = (f: Fixture, key = "notification", question = "decision needed") => {
  const b = f.h.cp.bindings.active("CEO")!;
  const decision = f.h.cp.outbox.enqueue({ idempotencyKey: key, roleKey: "CEO", bindingGeneration: b.bindingGeneration,
    targetSessionId: f.gatewaySessionId, kind: MessageKind.CEO_NOTIFICATION, payload: { question, key } });
  if (!decision.allowed) throw new Error(decision.message);
  return decision.value.messageId;
};
const bindBuzz = async (f: Fixture) => {
  const admitted = await f.admit();
  if (!admitted.allowed) throw new Error(admitted.message);
  f.h.cp.sessions.setBuzzAddress(f.gatewaySessionId, "ceo-room");
  expect(f.h.cp.sessions.bindBuzzActor({ admitted: admitted.value.runtime, buzzActorId: "ceo-key" },
    { isAllowedActor: () => true }).allowed).toBe(true);
};
const events = (f: Fixture, kind: string) => f.h.cp.audit.byKind(kind);
const processingOf = (f: Fixture, id: string) =>
  f.h.cp.db.get<Record<string, unknown>>("SELECT * FROM outbox WHERE message_id = ?", [id]);

it("records an exact pre-claim 400 per row, switches the SAME id to verified Buzz, then consumes and ACKs once", async () => {
  const f = await fixture();
  const id = notify(f);
  await f.h.cp.outbox.deliverCeoNotifications();
  const request = http.posts[0]!;
  expect(http.posts).toHaveLength(1);
  expect(events(f, "CEO_NOTIFICATION_CANONICAL_RESULT")).toMatchObject([{ reasonCode: ReasonCode.CEO_CONVERSATION_TRANSPORT_FAILED,
    evidence: { messageId: id, outcome: "REFUSED", preClaim: true, status: 400, code: "canonical_invalid_request",
      requests: [{ eventId: request.event_id, payloadDigest: request.payload_digest }] } }]);
  expect(events(f, "CEO_NOTIFICATION_DELIVERY_FAILED")).toMatchObject([{ reasonCode: ReasonCode.CEO_CONVERSATION_TRANSPORT_FAILED }]);
  await bindBuzz(f);
  expect((await f.h.buzzAdapter.deliverPending()).delivered).toEqual([id]);
  expect(f.h.buzz.sent).toEqual([{ channel: "ceo-room", content: expect.stringContaining(id), recipients: ["ceo-key"] }]);
  expect(f.h.cp.outbox.get(id)?.status).toBe("SENT");
  const b = f.h.cp.bindings.active("CEO")!;
  const incarnation = f.h.cp.sessions.get(f.gatewaySessionId)!.incarnation;
  const writes = vi.spyOn(f.h.cp.db, "run");
  expect(f.h.cp.outbox.acknowledge(id, f.gatewaySessionId, b.bindingGeneration, incarnation).allowed).toBe(true);
  expect(f.h.cp.outbox.acknowledge(id, f.gatewaySessionId, b.bindingGeneration, incarnation).allowed).toBe(false);
  await f.h.buzzAdapter.deliverPending();
  await f.h.cp.outbox.deliverCeoNotifications();
  expect(f.h.cp.outbox.get(id)?.status).toBe("ACKED");
  expect(writes.mock.calls.filter(([sql]) => sql.includes("UPDATE outbox SET status = 'ACKED'"))).toHaveLength(1);
  writes.mockRestore();
  expect(f.h.buzz.sent).toHaveLength(1);
  expect(http.posts).toHaveLength(1);
});

it.each(["timeout", "lost", "uncertain", "409", "other400", "wrongShape"] as const)(
  "%s remains withheld without HTTP while receiver support is unverified", async (mode) => {
    const f = await fixture(); http.mode = mode;
    const id = notify(f);
    await f.h.cp.outbox.deliverCeoNotifications();
    expect(f.h.cp.outbox.get(id)?.status).toBe("PENDING");
    const calls = http.request.mock.calls.length;
    await bindBuzz(f);
    await f.h.buzzAdapter.deliverPending();
    expect(f.h.buzz.sent).toHaveLength(0);
    http.mode = "refused";
    await f.h.cp.outbox.deliverCeoNotifications();
    const refusedCount = http.posts.length;
    await f.h.cp.outbox.deliverCeoNotifications();
    await f.h.buzzAdapter.deliverPending();
    expect(http.posts).toHaveLength(refusedCount);
    expect(http.request).toHaveBeenCalledTimes(calls);
    expect(f.h.buzz.sent).toHaveLength(0);
    expect(f.h.cp.outbox.get(id)?.status).toBe("PENDING");
    expect(events(f, "CEO_NOTIFICATION_BUZZ_ROUTE")).toHaveLength(0);
    expect(new Set(http.posts.map((r) => JSON.stringify(r))).size).toBe(1);
  },
);

it("coalesces overlapping delivery triggers and Buzz sweeps across a route switch", async () => {
  const f = await fixture(); http.hold = true;
  const id = notify(f);
  const canonical = f.h.cp.outbox.deliverCeoNotifications();
  await vi.waitFor(() => expect(http.release).not.toBeNull());
  await bindBuzz(f);
  const overlap = f.h.cp.outbox.deliverCeoNotifications();
  await Promise.all([f.h.buzzAdapter.deliverPending(), f.h.buzzAdapter.deliverPending()]);
  expect(f.h.buzz.sent).toHaveLength(0);
  http.release!();
  await Promise.all([canonical, overlap]);
  await Promise.all([f.h.buzzAdapter.deliverPending(), f.h.cp.outbox.deliverCeoNotifications(), f.h.buzzAdapter.deliverPending()]);
  expect(http.posts).toHaveLength(1);
  expect(f.h.buzz.sent).toHaveLength(1);
  expect(f.h.cp.outbox.get(id)?.status).toBe("SENT");
});

it("withholds without a verified Buzz binding, audits the refusal once, and resumes on authenticated binding", async () => {
  const f = await fixture(); const id = notify(f);
  for (let i = 0; i < 4; i++) { await f.h.cp.outbox.deliverCeoNotifications(); await f.h.buzzAdapter.deliverPending(); }
  expect(f.h.cp.outbox.get(id)).toMatchObject({ status: "PENDING", attempts: 1 });
  expect(events(f, "CEO_NOTIFICATION_DELIVERY_FAILED")).toHaveLength(1);
  expect(events(f, "CEO_NOTIFICATION_ROUTE_UNAVAILABLE")).toHaveLength(1);
  expect(http.posts).toHaveLength(1);
  expect(f.h.buzz.sent).toHaveLength(0);
  await bindBuzz(f);
  expect((await f.h.buzzAdapter.deliverPending()).delivered).toEqual([id]);
});

it("sends fresh unsent mail straight to verified Buzz when support is unverified", async () => {
  const f = await fixture(); await bindBuzz(f);
  const id = notify(f);
  await f.h.cp.outbox.deliverCeoNotifications();
  expect((await f.h.buzzAdapter.deliverPending()).delivered).toEqual([id]);
  expect(http.posts).toHaveLength(0);
});

it("does not deliberately POST fresh mail to a receiver already known to lack protocol support", async () => {
  const f = await fixture(); notify(f, "prove-unsupported");
  await f.h.cp.outbox.deliverCeoNotifications();
  const id = notify(f, "fresh-unsent");
  await f.h.cp.outbox.deliverCeoNotifications();
  expect(http.posts).toHaveLength(1);
  expect(f.h.cp.outbox.get(id)).toMatchObject({ status: "PENDING", attempts: 0 });
  await bindBuzz(f);
  expect((await f.h.buzzAdapter.deliverPending()).delivered).toContain(id);
  expect(http.posts).toHaveLength(1);
});

it("an attempt that provably never sent a POST keeps the row eligible for verified Buzz while support is unverified", async () => {
  const f = await fixture(); http.mode = "notSent";
  const id = notify(f);
  await f.h.cp.outbox.deliverCeoNotifications();
  expect(http.posts).toHaveLength(0);
  expect(events(f, "CEO_NOTIFICATION_CANONICAL_RESULT")[0]?.evidence).toMatchObject({ outcome: "NOT_SENT" });
  http.mode = "completed";
  await bindBuzz(f); await f.h.cp.outbox.deliverCeoNotifications();
  expect((await f.h.buzzAdapter.deliverPending()).delivered).toEqual([id]);
  expect(http.posts).toHaveLength(0);
});

it("keeps a receiver whose completed notice verifies support on canonical after Buzz is bound", async () => {
  const f = await fixture(); http.mode = "completed";
  const id = notify(f, "first-supported"); await f.h.cp.outbox.deliverCeoNotifications();
  await bindBuzz(f);
  const second = notify(f, "still-canonical"); await f.h.cp.outbox.deliverCeoNotifications();
  expect(f.h.cp.outbox.get(id)?.status).toBe("ACKED");
  expect(f.h.cp.outbox.get(second)?.status).toBe("ACKED");
  await f.h.buzzAdapter.deliverPending();
  expect(http.posts).toHaveLength(2);
  expect(f.h.buzz.sent).toHaveLength(0);
  expect(events(f, "CEO_NOTIFICATION_ACCEPTED")).toHaveLength(2);
});

it("holds all 12 pre-journal live-style rows without any HTTP across sweeps and database restarts, one audit each", async () => {
  const buzz = vi.spyOn(InMemoryBuzzTransport.prototype, "send");
  const f = adoptedFixture(); fixtures.push(f);
  const ids = Array.from({ length: 12 }, (_, i) => notify(f, `legacy-${i}`));
  for (const id of ids) {
    f.h.cp.db.run("UPDATE outbox SET attempts = 7 WHERE message_id = ?", [id]);
    f.h.cp.audit.record({ kind: "CEO_NOTIFICATION_DELIVERY_FAILED", reasonCode: ReasonCode.CEO_CONVERSATION_UNAVAILABLE,
      evidence: { messageId: id } });
  }
  // A handover may reset a mutable counter. The legacy failure audit still holds the uncertainty.
  f.h.cp.db.run("UPDATE outbox SET attempts = 0 WHERE message_id = ?", [ids[0]!]);
  const processing = ids.map((id) => processingOf(f, id));
  await bindBuzz(f); await start(f);
  for (let i = 0; i < 3; i++) {
    await f.h.cp.outbox.deliverCeoNotifications(); await f.h.buzzAdapter.deliverPending();
    const { root, repoPath, clock } = f.h;
    f.h.cp.close();
    f.h = makeHarness({ root, repoPath, clock });
    await start(f);
    expect(ids.map((id) => processingOf(f, id))).toEqual(processing);
    expect(buzz).not.toHaveBeenCalled();
  }
  expect(http.request).not.toHaveBeenCalled();
  expect(buzz).not.toHaveBeenCalled();
  expect(http.posts).toHaveLength(0);
  expect(f.h.buzz.sent).toHaveLength(0);
  expect(events(f, "CEO_NOTIFICATION_CANONICAL_ATTEMPT")).toHaveLength(0);
  const held = events(f, "CEO_NOTIFICATION_LEGACY_OUTCOME_UNKNOWN");
  expect(held).toHaveLength(12);
  for (const id of ids) expect(held.filter((e) => e.evidence["messageId"] === id)).toHaveLength(1);
  expect(ids.map((id) => f.h.cp.outbox.get(id)?.status)).toEqual(Array(12).fill("PENDING"));
  expect(f.h.cp.outbox.deliveryReadback().pendingCeoNotifications.map((r) => r.messageId).sort()).toEqual([...ids].sort());
  // Detaching the transport cannot erase the durable unknown-outcome fence.
  const restarted = new Outbox(f.h.cp.db, f.h.cp.clock, f.h.cp.audit);
  expect(restarted.claimDeliverable()).toEqual([]);
});

it("keeps a partial multipart delivery canonical, never reposting the whole notification to Buzz", async () => {
  const f = await fixture(); http.mode = "partial";
  const id = notify(f, "multipart", "x".repeat(2000));
  await f.h.cp.outbox.deliverCeoNotifications();
  await bindBuzz(f); await f.h.buzzAdapter.deliverPending();
  expect(f.h.cp.outbox.get(id)?.status).toBe("PENDING");
  expect(f.h.buzz.sent).toHaveLength(0);
  expect(events(f, "CEO_NOTIFICATION_CANONICAL_RESULT")[0]?.evidence).toMatchObject({ outcome: "UNKNOWN" });
});

it("a pre-journal pending row stays held without HTTP even when an old crash left its counter at zero", async () => {
  const f = adoptedFixture(); fixtures.push(f);
  const id = notify(f, "pre-journal-zero-counter");
  await bindBuzz(f); await start(f); await f.h.buzzAdapter.deliverPending();
  expect(events(f, "CEO_NOTIFICATION_LEGACY_OUTCOME_UNKNOWN")).toMatchObject([{ evidence: { messageId: id } }]);
  expect(events(f, "CEO_NOTIFICATION_CANONICAL_ATTEMPT")).toHaveLength(0);
  expect(http.request).not.toHaveBeenCalled();
  expect(f.h.cp.outbox.get(id)?.status).toBe("PENDING");
  expect(f.h.buzz.sent).toHaveLength(0);
});

it("a lost result transaction keeps the durable attempt unknown across replay instead of inventing a refusal", async () => {
  const f = await fixture();
  const record = f.h.cp.audit.record.bind(f.h.cp.audit);
  let failResult = true;
  const audit = vi.spyOn(f.h.cp.audit, "record").mockImplementation((entry) => {
    if (entry.kind === "CEO_NOTIFICATION_CANONICAL_RESULT" && failResult) { failResult = false; throw new Error("crash before result"); }
    return record(entry);
  });
  const id = notify(f);
  await f.h.cp.outbox.deliverCeoNotifications();
  audit.mockRestore();
  await bindBuzz(f);
  await f.h.cp.outbox.deliverCeoNotifications();
  await f.h.buzzAdapter.deliverPending();
  expect(f.h.cp.outbox.get(id)?.status).toBe("PENDING");
  expect(events(f, "CEO_NOTIFICATION_CANONICAL_ATTEMPT").length)
    .toBeGreaterThan(events(f, "CEO_NOTIFICATION_CANONICAL_RESULT").length);
  expect(events(f, "CEO_NOTIFICATION_BUZZ_ROUTE")).toHaveLength(0);
  expect(new Set(http.posts.map((r) => JSON.stringify(r))).size).toBe(1);
  expect(f.h.buzz.sent).toHaveLength(0);
});

it("records intent before HTTP without duplicating payload or the signed body in audit evidence", async () => {
  const f = await fixture(); http.hold = true;
  notify(f, "intent-before-http", "private decision text");
  const pending = f.h.cp.outbox.deliverCeoNotifications();
  await vi.waitFor(() => expect(http.release).not.toBeNull(), { interval: 1 });
  const intents = events(f, "CEO_NOTIFICATION_CANONICAL_ATTEMPT");
  expect(intents).toHaveLength(1);
  expect(events(f, "CEO_NOTIFICATION_CANONICAL_RESULT")).toHaveLength(0);
  expect(JSON.stringify(intents)).not.toContain("private decision text");
  expect(JSON.stringify(intents)).not.toContain(http.posts[0]!.signature);
  http.release!(); await pending;
});

it.each(["room", "actor"] as const)("a %s alone is not a verified Buzz route", async (only) => {
  const f = await fixture(); const id = notify(f);
  await f.h.cp.outbox.deliverCeoNotifications();
  if (only === "room") f.h.cp.sessions.setBuzzAddress(f.gatewaySessionId, "ceo-room");
  else {
    const admitted = await f.admit();
    if (!admitted.allowed) throw new Error(admitted.message);
    expect(f.h.cp.sessions.bindBuzzActor({ admitted: admitted.value.runtime, buzzActorId: "ceo-key" },
      { isAllowedActor: () => true }).allowed).toBe(true);
  }
  for (let i = 0; i < 3; i++) { await f.h.cp.outbox.deliverCeoNotifications(); await f.h.buzzAdapter.deliverPending(); }
  expect(f.h.cp.outbox.get(id)?.status).toBe("PENDING");
  expect(f.h.buzz.sent).toHaveLength(0);
  expect(http.posts).toHaveLength(1);
  expect(events(f, "CEO_NOTIFICATION_DELIVERY_FAILED")).toHaveLength(1);
});

it("a newer matching completed existing probe permits a journaled v51 receipt lookup after receiver recovery", async () => {
  const f = await fixture(); http.mode = "lost";
  const id = notify(f, "journaled-unknown");
  await f.h.cp.outbox.deliverCeoNotifications();
  expect(f.h.cp.outbox.get(id)?.status).toBe("PENDING");
  f.h.clock.advance(1000);
  const eventId = `acp-notice-probe:${"a".repeat(64)}`;
  const canonicalJson = daemonNoticeCanonical(daemonNoticeFields(eventId, destination, "existing probe"));
  const payloadDigest = daemonNoticePayloadDigest(canonicalJson);
  f.h.cp.outbox.recordDaemonNoticeProbe({ eventId, entry: "IN_DOUBT", payloadDigest, canonicalJson });
  f.h.cp.outbox.recordDaemonNoticeProbe({ eventId, entry: "SETTLED", payloadDigest, receiptId: "recovery-receipt" });
  http.mode = "completed";
  await f.h.cp.outbox.deliverCeoNotifications();
  expect(f.h.cp.outbox.get(id)?.status).toBe("ACKED");
  expect(new Set(http.posts.map((r) => JSON.stringify(r))).size).toBe(1);
  expect(f.h.buzz.sent).toHaveLength(0);
});

it("a journaled unknown row makes no HTTP calls when a different notice establishes UNSUPPORTED", async () => {
  const buzz = vi.spyOn(InMemoryBuzzTransport.prototype, "send");
  const f = await fixture(); http.mode = "lost";
  const id = notify(f, "unknown-before-refutation");
  await f.h.cp.outbox.deliverCeoNotifications();
  http.lostMessageId = id;
  http.mode = "refused";
  notify(f, "separate-support-observation");
  await f.h.cp.outbox.deliverCeoNotifications();
  expect(events(f, "CEO_NOTIFICATION_PROTOCOL_SUPPORT").at(-1)?.evidence).toMatchObject({ support: "UNSUPPORTED" });
  const calls = http.request.mock.calls.length;
  const posts = http.posts.length;
  await bindBuzz(f);
  await f.h.buzzAdapter.deliverPending(); // Settle only the independently refused, safely routable notice.
  expect(buzz.mock.calls.filter(([, content]) => content.includes(id))).toHaveLength(0);
  buzz.mockClear();
  const processing = processingOf(f, id);
  for (let i = 0; i < 3; i++) { await f.h.cp.outbox.deliverCeoNotifications(); await f.h.buzzAdapter.deliverPending(); }
  expect(http.request).toHaveBeenCalledTimes(calls);
  const { root, repoPath, clock } = f.h;
  f.h.cp.close();
  f.h = makeHarness({ root, repoPath, clock });
  await start(f); await f.h.buzzAdapter.deliverPending();
  expect(http.request).toHaveBeenCalledTimes(calls);
  expect(buzz).not.toHaveBeenCalled();
  expect(processingOf(f, id)).toEqual(processing);
  expect(http.posts).toHaveLength(posts);
  expect(events(f, "CEO_NOTIFICATION_CANONICAL_ATTEMPT").filter((e) => e.evidence["messageId"] === id)).toHaveLength(1);
  expect(f.h.cp.outbox.get(id)?.status).toBe("PENDING");
  expect(events(f, "CEO_NOTIFICATION_BUZZ_ROUTE").some((e) => e.evidence["messageId"] === id)).toBe(false);
});

it.each([false, true])("R1-01: verified Buzz works with identity GET 503, prior refusal = %s", async (refuted) => {
  const f = await fixture();
  if (refuted) { notify(f, "prior-refusal"); await f.h.cp.outbox.deliverCeoNotifications(); }
  await bindBuzz(f);
  http.mode = "notSent";
  await start(f, true);
  http.request.mockClear();
  const id = notify(f, "buzz-without-discovery");
  await f.h.cp.outbox.deliverCeoNotifications();
  expect((await f.h.buzzAdapter.deliverPending()).delivered).toContain(id);
  expect(f.h.cp.outbox.get(id)?.status).toBe("SENT");
  expect(http.request).not.toHaveBeenCalled();
  expect(f.h.buzz.sent.filter((s) => s.content.includes(id))).toHaveLength(1);
});

it("R1-02: a completed authenticated probe alone establishes canonical support", async () => {
  const f = await fixture(); http.mode = "completed";
  expect(await probe(f, "initial-support-proof-01")).toMatchObject({ sent: true, sameReceipt: true });
  await bindBuzz(f);
  const id = notify(f, "after-initial-probe");
  await f.h.cp.outbox.deliverCeoNotifications(); await f.h.buzzAdapter.deliverPending();
  expect(f.h.cp.outbox.get(id)?.status).toBe("ACKED");
  expect(http.posts.filter((r) => r.text.includes(id))).toHaveLength(1);
  expect(f.h.buzz.sent).toHaveLength(0);
});

it("R1-02: a later completed probe recovers support even at the refusal's identical timestamp", async () => {
  const f = await fixture(); http.mode = "completed";
  notify(f, "establish-support"); await f.h.cp.outbox.deliverCeoNotifications();
  http.mode = "lost";
  const id = notify(f, "unknown-then-refused"); await f.h.cp.outbox.deliverCeoNotifications();
  http.mode = "refused";
  await f.h.cp.outbox.deliverCeoNotifications();
  expect(events(f, "CEO_NOTIFICATION_PROTOCOL_SUPPORT").at(-1)?.evidence).toMatchObject({ support: "UNSUPPORTED" });
  const at = f.h.clock.nowIso();
  http.mode = "completed";
  expect(await probe(f, "same-clock-recovery-01")).toMatchObject({ sent: true, sameReceipt: true });
  expect(f.h.clock.nowIso()).toBe(at);
  await f.h.cp.outbox.deliverCeoNotifications();
  expect(f.h.cp.outbox.get(id)?.status).toBe("ACKED");
  const bodies = http.posts.filter((r) => r.text.includes(id));
  expect(new Set(bodies.map((r) => JSON.stringify(r))).size).toBe(1);
  expect(http.turns.has(bodies[0]!.event_id)).toBe(true);
  expect(f.h.buzz.sent).toHaveLength(0);
});

it("R1-02: a later refusal wins over an earlier probe at the same timestamp", async () => {
  const f = await fixture(); http.mode = "completed";
  await probe(f, "earlier-support-proof-01");
  http.mode = "refused";
  notify(f, "later-refusal"); await f.h.cp.outbox.deliverCeoNotifications();
  await bindBuzz(f);
  const calls = http.request.mock.calls.length;
  const id = notify(f, "after-later-refusal");
  await f.h.cp.outbox.deliverCeoNotifications();
  expect((await f.h.buzzAdapter.deliverPending()).delivered).toContain(id);
  expect(http.request).toHaveBeenCalledTimes(calls);
});

it("R1-03: 201-part receipt retries retain a complete manifest despite audit array truncation", async () => {
  const f = await fixture(); http.mode = "completed";
  notify(f, "verify-large-receiver"); await f.h.cp.outbox.deliverCeoNotifications();
  http.posts = []; http.turns.clear(); http.mode = "lost";
  const id = notify(f, "large-manifest", "x".repeat(301000));
  await f.h.cp.outbox.deliverCeoNotifications();
  const lost = http.posts.length;
  const intent = events(f, "CEO_NOTIFICATION_CANONICAL_ATTEMPT").filter((e) => e.evidence["messageId"] === id)[0]!;
  http.mode = "completed";
  await f.h.cp.outbox.deliverCeoNotifications();
  expect(f.h.cp.outbox.get(id)?.status).toBe("ACKED");
  expect(intent.evidence).toMatchObject({ requestCount: 201, manifestDigest: expect.stringMatching(/^sha256:/) });
  expect(intent.evidence["requests"]).toHaveLength(200);
  expect(http.posts).toHaveLength(lost + 201);
  expect(http.turns.size).toBe(201);
  expect(JSON.stringify(http.posts[lost])).toBe(JSON.stringify(http.posts[0]));
  expect(f.h.buzz.sent).toHaveLength(0);
});

it("verified receiver support cannot release a legacy row", async () => {
  const f = adoptedFixture(); fixtures.push(f);
  const id = notify(f, "legacy-stays-held");
  await start(f);
  http.mode = "completed";
  const fresh = notify(f, "independent-supported-notice");
  await f.h.cp.outbox.deliverCeoNotifications();
  expect(f.h.cp.outbox.get(fresh)?.status).toBe("ACKED");
  const calls = http.request.mock.calls.length;
  await bindBuzz(f);
  await f.h.cp.outbox.deliverCeoNotifications(); await f.h.buzzAdapter.deliverPending();
  expect(http.request).toHaveBeenCalledTimes(calls);
  expect(f.h.cp.outbox.get(id)?.status).toBe("PENDING");
  expect(events(f, "CEO_NOTIFICATION_LEGACY_OUTCOME_UNKNOWN")).toHaveLength(1);
  expect(http.posts.some((r) => r.text.includes(id))).toBe(false);
});
