import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { nsecEncode } from "nostr-tools/nip19";
import { getPublicKey } from "nostr-tools/pure";

import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import type * as Http from "node:http";

import { digestOf } from "../../src/core/digest.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Role, SessionLifecycle } from "../../src/domain/types.ts";
import { createConfiguredHermesGatewayDaemonNoticeTarget, startConfiguredCeoNotificationRoute } from "../../src/daemon/agentcpd.ts";
import { currentCanonicalCeoBuzzRoute } from "../../src/outbox/ceo-buzz-signer.ts";
import { HostProvisionerError, type HostAllocation, type HostObservation, type HostOperation } from "../../src/runtime/host-project-provisioner.ts";
import { BuzzAdapter, BuzzCliTransport, InMemoryBuzzTransport } from "../../src/buzz/buzz-adapter.ts";
import { Outbox } from "../../src/outbox/outbox.ts";
import { MessageKind } from "../../src/outbox/envelope.ts";
import { daemonNoticeCanonical, daemonNoticeFields, daemonNoticePayloadDigest,
  sendDaemonNoticeProbe, type DaemonNoticeBody } from "../../src/runtime/acp-daemon-notice.ts";
import { createHermesGatewayIdentityReader } from "../../src/runtime/hermes-gateway-identity.ts";
import { createHermesGatewayDaemonNoticeSender } from "../../src/runtime/hermes-gateway-conversation.ts";
import { adoptedFixture, DIGEST, GATEWAY, LIVE, LSTART, RUNTIME, TOKEN } from "../helpers/adopted-ceo.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
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

const signerRefusal = 'buzz send failed: {"error":"mention_policy","message":"signer not registered for channel","retryable":false}';
const signerRoute = async () => {
  const f = await fixture(); await bindBuzz(f);
  const readiness = vi.fn(async (_room: string) => ({ signer: "daemon-signer", registered: true }));
  Object.assign(f.h.buzz, { signerReadiness: readiness });
  return { f, readiness };
};

it("withholds the exact signer refusal once, then re-arms the same sealed row on changed policy plus positive signer readback and ACKs", async () => {
  const { f, readiness } = await signerRoute();
  let policy = "policy-v1";
  Object.assign(f.h.buzz, { localSendPolicyDigest: () => policy });
  const id = notify(f, "signer-race"); await f.h.cp.outbox.deliverCeoNotifications();
  const before = processingOf(f, id)!;
  const send = vi.spyOn(f.h.buzz, "send").mockRejectedValueOnce(new Error(signerRefusal));
  expect((await f.h.buzzAdapter.deliverPending()).failed).toEqual([id]);
  expect(processingOf(f, id)).toMatchObject({ status: "PENDING", failure_class: "repairable",
    reason_code: "BUZZ_LOCAL_SEND_POLICY_REFUSED", retry_eligible: 0, next_attempt_at: null, sent_at: null });
  expect(events(f, "CEO_NOTIFICATION_BUZZ_ROUTE_NOT_READY")).toMatchObject([{ evidence: {
    messageId: id, room: "ceo-room", signer: "daemon-signer", source: "SEND_REFUSAL",
    code: "mention_policy", message: "signer not registered for channel",
  } }]);
  readiness.mockResolvedValue({ signer: "daemon-signer", registered: false });
  // Receiver route changes alone cannot re-arm a sender-membership refusal.
  await bindBuzz(f);
  for (let i = 0; i < 3; i++) await f.h.buzzAdapter.deliverPending();
  expect(send).toHaveBeenCalledTimes(1);
  expect(events(f, "CEO_NOTIFICATION_BUZZ_ROUTE_NOT_READY")).toHaveLength(1);
  expect(f.h.cp.outbox.deliveryReadback().pendingCeoNotifications.map(r => r.messageId)).toContain(id);
  readiness.mockResolvedValue({ signer: "daemon-signer", registered: true });
  await f.h.buzzAdapter.deliverPending();
  expect(send).toHaveBeenCalledTimes(1); // Roster alone does not change local policy.
  policy = "policy-v2";
  await Promise.all([f.h.buzzAdapter.deliverPending(), f.h.cp.outbox.deliverCeoNotifications(), f.h.buzzAdapter.deliverPending()]);
  expect(send).toHaveBeenCalledTimes(2);
  expect(processingOf(f, id)).toMatchObject({ status: "SENT", payload_json: before.payload_json,
    payload_digest: before.payload_digest, target_session_id: before.target_session_id, binding_generation: before.binding_generation });
  const b = f.h.cp.bindings.active("CEO")!;
  expect(f.h.cp.outbox.acknowledge(id, f.gatewaySessionId, b.bindingGeneration + 1, f.h.cp.sessions.get(f.gatewaySessionId)!.incarnation).allowed).toBe(false);
  expect(f.h.cp.outbox.acknowledge(id, f.gatewaySessionId, b.bindingGeneration,
    f.h.cp.sessions.get(f.gatewaySessionId)!.incarnation).allowed).toBe(true);
  expect(f.h.cp.outbox.get(id)?.status).toBe("ACKED");
  expect(readiness.mock.calls.every(([room]) => room === "ceo-room")).toBe(true);
});

it("a negative sender roster pre-check withholds without sending, and a failed readback cannot resume it", async () => {
  const { f, readiness } = await signerRoute();
  readiness.mockResolvedValue({ signer: "daemon-signer", registered: false });
  const id = notify(f, "no-signer-membership"); await f.h.cp.outbox.deliverCeoNotifications();
  const send = vi.spyOn(f.h.buzz, "send");
  await f.h.buzzAdapter.deliverPending();
  expect(send).not.toHaveBeenCalled();
  expect(processingOf(f, id)).toMatchObject({ status: "PENDING", failure_class: "repairable", reason_code: "BUZZ_SIGNER_NOT_REGISTERED" });
  readiness.mockRejectedValue(new Error("roster unavailable"));
  await f.h.buzzAdapter.deliverPending();
  expect(send).not.toHaveBeenCalled();
  readiness.mockResolvedValue({ signer: "daemon-signer", registered: true });
  expect((await f.h.buzzAdapter.deliverPending()).delivered).toEqual([id]);
});

it.each(["recipient not registered for channel", "signer not registered for channel (other policy)"])(
  "another mention_policy refusal keeps its classification: %s", async (message) => {
    const { f } = await signerRoute(); const id = notify(f); await f.h.cp.outbox.deliverCeoNotifications();
    vi.spyOn(f.h.buzz, "send").mockRejectedValue(new Error(`buzz send failed: ${JSON.stringify({ error: "mention_policy", message, retryable: false })}`));
    await f.h.buzzAdapter.deliverPending(); await f.h.buzzAdapter.deliverPending();
    expect(processingOf(f, id)).toMatchObject({ status: "PENDING", failure_class: "contract", retry_eligible: 0 });
    expect(events(f, "CEO_NOTIFICATION_BUZZ_ROUTE_NOT_READY")).toHaveLength(0);
  },
);

it.each([false, true])("recovers a live-style contract row only with complete pre-post history; prior unknown = %s", async (unknown) => {
  const { f } = await signerRoute(); const id = notify(f); await f.h.cp.outbox.deliverCeoNotifications();
  // Before this fix Buzz logged only the row's last error and aggregate BUZZ_DELIVERY.
  f.h.cp.db.run("UPDATE outbox SET attempts = ?, failure_class = 'contract', last_error = ? WHERE message_id = ?",
    [unknown ? 2 : 1, signerRefusal, id]);
  const send = vi.spyOn(f.h.buzz, "send");
  await Promise.all([f.h.buzzAdapter.deliverPending(), f.h.buzzAdapter.deliverPending()]);
  expect(send).toHaveBeenCalledTimes(unknown ? 0 : 1);
  expect(f.h.cp.outbox.get(id)?.status).toBe(unknown ? "PENDING" : "SENT");
});

it("a signer refusal never clears a possibly delivered prior destination", async () => {
  const { f } = await signerRoute(); const id = notify(f); await f.h.cp.outbox.deliverCeoNotifications();
  f.h.cp.db.run("UPDATE outbox SET attempts = 1, failure_class = 'contract', last_error = ? WHERE message_id = ?", [signerRefusal, id]);
  f.h.cp.outbox.recordAcceptedSend(id, { room: "earlier-room", recipient: "earlier-recipient" });
  const before = processingOf(f, id);
  const send = vi.spyOn(f.h.buzz, "send"); await f.h.buzzAdapter.deliverPending();
  expect(send).not.toHaveBeenCalled(); expect(processingOf(f, id)).toEqual(before);
});

it("overlapping sweeps and the canonical trigger cannot double a resumed send in flight", async () => {
  const { f, readiness } = await signerRoute();
  readiness.mockResolvedValue({ signer: "daemon-signer", registered: false });
  const id = notify(f); await f.h.cp.outbox.deliverCeoNotifications(); await f.h.buzzAdapter.deliverPending();
  readiness.mockResolvedValue({ signer: "daemon-signer", registered: true });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const original = f.h.buzz.send.bind(f.h.buzz);
  const send = vi.spyOn(f.h.buzz, "send").mockImplementation(async (...args) => { await held; return original(...args); });
  const first = f.h.buzzAdapter.deliverPending();
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  await Promise.all([f.h.buzzAdapter.deliverPending(), f.h.cp.outbox.deliverCeoNotifications()]);
  expect(send).toHaveBeenCalledTimes(1);
  release(); await first;
  expect(f.h.cp.outbox.get(id)?.status).toBe("SENT");
});

it.each(["canonical-unknown", "legacy-unknown"])("an exact signer refusal never clears %s", async (basis) => {
  const { f } = await signerRoute(); const id = notify(f); await f.h.cp.outbox.deliverCeoNotifications();
  if (basis === "canonical-unknown") {
    f.h.cp.audit.record({ kind: "CEO_NOTIFICATION_CANONICAL_ATTEMPT", evidence: { messageId: id, attemptId: "uncertain", legacyUnknown: false } });
    f.h.cp.audit.record({ kind: "CEO_NOTIFICATION_CANONICAL_RESULT", evidence: { messageId: id, attemptId: "uncertain", outcome: "UNKNOWN" } });
  } else f.h.cp.audit.record({ kind: "CEO_NOTIFICATION_LEGACY_OUTCOME_UNKNOWN", evidence: { messageId: id } });
  f.h.cp.db.run("UPDATE outbox SET attempts = ?, failure_class = 'contract', last_error = ? WHERE message_id = ?",
    [basis === "canonical-unknown" ? 2 : 1, signerRefusal, id]);
  const before = processingOf(f, id); const send = vi.spyOn(f.h.buzz, "send");
  await f.h.buzzAdapter.deliverPending();
  expect(send).not.toHaveBeenCalled(); expect(processingOf(f, id)).toEqual(before);
});

it("reclassifies the safe live-style refusal while membership is still absent, with one audit", async () => {
  const { f, readiness } = await signerRoute(); const id = notify(f); await f.h.cp.outbox.deliverCeoNotifications();
  f.h.cp.db.run("UPDATE outbox SET attempts = 1, failure_class = 'contract', last_error = ? WHERE message_id = ?", [signerRefusal, id]);
  readiness.mockResolvedValue({ signer: "daemon-signer", registered: false });
  const send = vi.spyOn(f.h.buzz, "send");
  await f.h.buzzAdapter.deliverPending(); await f.h.buzzAdapter.deliverPending();
  expect(send).not.toHaveBeenCalled();
  expect(processingOf(f, id)).toMatchObject({ status: "PENDING", attempts: 1, reason_code: "BUZZ_SIGNER_NOT_REGISTERED", failure_class: "repairable" });
  expect(events(f, "CEO_NOTIFICATION_BUZZ_ROUTE_NOT_READY")).toHaveLength(1);
  readiness.mockResolvedValue({ signer: "daemon-signer", registered: true });
  expect((await f.h.buzzAdapter.deliverPending()).delivered).toEqual([id]);
});

it("a complete canonical pre-claim refusal plus the one pre-fix Buzz refusal can resume", async () => {
  const f = await fixture(); const id = notify(f);
  await f.h.cp.outbox.deliverCeoNotifications();
  expect(events(f, "CEO_NOTIFICATION_CANONICAL_RESULT")[0]?.evidence).toMatchObject({ outcome: "REFUSED" });
  await bindBuzz(f);
  Object.assign(f.h.buzz, { signerReadiness: async () => ({ signer: "daemon-signer", registered: true }) });
  f.h.cp.db.run("UPDATE outbox SET attempts = 2, failure_class = 'contract', last_error = ? WHERE message_id = ?", [signerRefusal, id]);
  const send = vi.spyOn(f.h.buzz, "send");
  expect((await f.h.buzzAdapter.deliverPending()).delivered).toEqual([id]);
  expect(send).toHaveBeenCalledTimes(1);
  expect(f.h.cp.outbox.get(id)?.status).toBe("SENT");
});

it("a lost refusal audit rolls back both row classification and destination settlement", async () => {
  const { f } = await signerRoute(); const id = notify(f); await f.h.cp.outbox.deliverCeoNotifications();
  vi.spyOn(f.h.buzz, "send").mockRejectedValueOnce(new Error(signerRefusal));
  const record = f.h.cp.audit.record.bind(f.h.cp.audit);
  const audit = vi.spyOn(f.h.cp.audit, "record").mockImplementation(entry => {
    if (entry.kind === "CEO_NOTIFICATION_BUZZ_ROUTE_NOT_READY") throw new Error("refusal audit lost");
    return record(entry);
  });
  await expect(f.h.buzzAdapter.deliverPending()).rejects.toThrow("refusal audit lost");
  audit.mockRestore();
  expect(processingOf(f, id)).toMatchObject({ status: "IN_FLIGHT", attempts: 0, failure_class: null, reason_code: null });
  expect(f.h.cp.db.get<{ outcome: string }>("SELECT outcome FROM outbox_sent_destinations WHERE message_id = ?", [id]))
    .toEqual({ outcome: "PENDING_SEND" });
  expect(events(f, "CEO_NOTIFICATION_BUZZ_ROUTE_NOT_READY")).toHaveLength(0);
});

const systemicFixture = async (mode: "success" | "fail" | "mismatch" = "success") => {
  const f = await fixture(); await bindBuzz(f);
  const room = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  f.h.cp.sessions.setBuzzAddress(f.gatewaySessionId, room);
  let member = false;
  const signer = "a".repeat(64);
  const readback = vi.fn(async (_room: string) => ({ signer, registered: member }));
  Object.assign(f.h.buzz, { signerReadiness: readback });
  const invoke = vi.fn(async (operation: HostOperation, allocation: HostAllocation): Promise<HostObservation> => {
    expect(operation).toBe("ensure-buzz");
    if (!("mode" in allocation)) throw new Error("unexpected project allocation");
    if (mode === "fail") throw new HostProvisionerError("REFUSED", { code: "mention_policy", message: "signer not registered for channel" });
    member = mode !== "mismatch";
    return { ceoBuzzSigner: { route: allocation.route, signer: allocation.signer, changed: true, rosterVerified: true } };
  });
  f.h.buzzAdapter = new BuzzAdapter(f.h.cp.db, f.h.cp.clock, f.h.cp.audit, f.h.cp.sessions,
    f.h.cp.bindings, f.h.cp.outbox, f.h.buzz, { invoke });
  return { f, room, signer, readback, invoke, setMember: (value: boolean) => { member = value; } };
};

it("ensures only the actual daemon member of the current canonical CEO room, reads back, then sends once and ACKs", async () => {
  const { f, invoke, room, signer, readback } = await systemicFixture();
  const id = notify(f); await f.h.cp.outbox.deliverCeoNotifications();
  f.h.cp.db.run("UPDATE outbox SET attempts = 1, failure_class = 'contract', last_error = ? WHERE message_id = ?", [signerRefusal, id]);
  const sealed = processingOf(f, id)!;
  const send = vi.spyOn(f.h.buzz, "send");
  await Promise.all([f.h.buzzAdapter.deliverPending(), f.h.cp.outbox.deliverCeoNotifications(), f.h.buzzAdapter.deliverPending()]);
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(invoke.mock.calls[0]).toEqual(["ensure-buzz", { mode: "ceo-route-signer",
    signer, route: currentCanonicalCeoBuzzRoute(f.h.cp.db) }]);
  expect(readback.mock.calls.every(([channel]) => channel === room)).toBe(true);
  expect(readback.mock.calls.length).toBeGreaterThanOrEqual(2);
  expect(send).toHaveBeenCalledTimes(1);
  expect(processingOf(f, id)).toMatchObject({ status: "SENT", payload_json: sealed.payload_json,
    payload_digest: sealed.payload_digest, target_session_id: sealed.target_session_id, binding_generation: sealed.binding_generation });
  expect(events(f, "CEO_BUZZ_SIGNER_ENSURE").map(e => e.evidence["state"])).toEqual(["INTENT", "SUCCEEDED"]);
  expect(events(f, "CEO_BUZZ_SIGNER_READBACK").at(-1)?.evidence).toMatchObject({ registered: true, room, signer });
  const binding = f.h.cp.bindings.active("CEO")!;
  expect(f.h.cp.outbox.acknowledge(id, f.gatewaySessionId, binding.bindingGeneration,
    f.h.cp.sessions.get(f.gatewaySessionId)!.incarnation).allowed).toBe(true);
  expect(f.h.cp.outbox.get(id)?.status).toBe("ACKED");
});

it("an existing daemon member needs no ensure call or join write", async () => {
  const { f, invoke, setMember } = await systemicFixture(); setMember(true);
  const id = notify(f); await f.h.cp.outbox.deliverCeoNotifications();
  await f.h.buzzAdapter.deliverPending(); await f.h.buzzAdapter.deliverPending();
  expect(invoke).not.toHaveBeenCalled(); expect(f.h.cp.outbox.get(id)?.status).toBe("SENT");
});

it.each(["fail", "mismatch"] as const)("ACP1199-03: known host %s requires a validated receipt as well as positive readback", async mode => {
  const { f, invoke, setMember, signer } = await systemicFixture(mode);
  const id = notify(f); await f.h.cp.outbox.deliverCeoNotifications();
  const send = vi.spyOn(f.h.buzz, "send");
  await f.h.buzzAdapter.deliverPending();
  // Reconstruct the adapter: intent must survive all in-memory orchestration state.
  f.h.buzzAdapter = new BuzzAdapter(f.h.cp.db, f.h.cp.clock, f.h.cp.audit, f.h.cp.sessions,
    f.h.cp.bindings, f.h.cp.outbox, f.h.buzz, { invoke });
  for (let i = 0; i < 3; i++) await f.h.buzzAdapter.deliverPending();
  expect(invoke).toHaveBeenCalledTimes(1); expect(send).not.toHaveBeenCalled();
  expect(processingOf(f, id)).toMatchObject({ status: "PENDING", failure_class: "repairable", retry_eligible: 0, sent_at: null });
  expect(events(f, "CEO_BUZZ_SIGNER_READBACK").at(-1)?.evidence).toMatchObject({ registered: false });
  setMember(true);
  await Promise.all([f.h.buzzAdapter.deliverPending(), f.h.buzzAdapter.deliverPending()]);
  expect(send).not.toHaveBeenCalled(); expect(invoke).toHaveBeenCalledTimes(1);
  if (mode === "fail") expect(events(f, "CEO_BUZZ_SIGNER_ENSURE").at(-1)?.evidence).toMatchObject({ state: "REFUSED",
    refusal: { code: "mention_policy", message: "signer not registered for channel" } });
  const route = currentCanonicalCeoBuzzRoute(f.h.cp.db)!;
  f.h.cp.audit.record({ kind: "CEO_BUZZ_SIGNER_ENSURE", evidence: { route, signer, ensureDigest: digestOf({ route, signer }), state: "SUCCEEDED",
    receipt: { route, signer, changed: false, rosterVerified: true } } });
  await f.h.buzzAdapter.deliverPending();
  expect(send).toHaveBeenCalledTimes(1); expect(f.h.cp.outbox.get(id)?.status).toBe("SENT");
});

it.each(["room", "binding"] as const)("a %s changed during the read-only lookup causes no ensure call", async changed => {
  const { f, invoke, readback } = await systemicFixture(); const id = notify(f);
  await f.h.cp.outbox.deliverCeoNotifications();
  readback.mockImplementationOnce(async () => {
    if (changed === "room") f.h.cp.sessions.setBuzzAddress(f.gatewaySessionId, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    else f.h.cp.bindings.revoke("CEO", "stale CEO binding witness");
    return { signer: "a".repeat(64), registered: false };
  });
  const send = vi.spyOn(f.h.buzz, "send"); await f.h.buzzAdapter.deliverPending();
  expect(invoke).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  expect(f.h.cp.outbox.get(id)?.status).not.toBe("SENT");
});

it("a host response naming a different room is withheld even if a membership readback becomes positive", async () => {
  const { f, invoke, setMember } = await systemicFixture(); const id = notify(f); await f.h.cp.outbox.deliverCeoNotifications();
  invoke.mockImplementationOnce(async (_op, allocation) => {
    if (!("mode" in allocation)) throw new Error("unexpected allocation");
    setMember(true);
    return { ceoBuzzSigner: { route: { ...allocation.route, roomId: "wrong-room" }, signer: allocation.signer, changed: true, rosterVerified: true } };
  });
  const send = vi.spyOn(f.h.buzz, "send"); await f.h.buzzAdapter.deliverPending();
  expect(send).not.toHaveBeenCalled(); expect(f.h.cp.outbox.get(id)).toMatchObject({ status: "PENDING", failureClass: "repairable" });
  expect(events(f, "CEO_BUZZ_SIGNER_ENSURE").at(-1)?.evidence).toMatchObject({ state: "INVALID" });
});

it("membership ensure intent is shared across overlapping rows, sweeps and a lost host response", async () => {
  const { f, invoke } = await systemicFixture();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  invoke.mockImplementationOnce(async () => { await held; throw new HostProvisionerError("LOST"); });
  notify(f, "first-ensure"); await f.h.cp.outbox.deliverCeoNotifications();
  const first = f.h.buzzAdapter.deliverPending(); await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
  const secondId = notify(f, "overlapping-ensure"); await f.h.cp.outbox.deliverCeoNotifications();
  await f.h.buzzAdapter.deliverPending();
  expect(invoke).toHaveBeenCalledTimes(1); expect(f.h.cp.outbox.get(secondId)?.status).toBe("PENDING");
  release(); await first; await f.h.buzzAdapter.deliverPending();
  expect(invoke).toHaveBeenCalledTimes(1); expect(f.h.buzz.sent).toHaveLength(0);
});

it("a signer refusal after ensure/readback stays an actual refusal and cannot repeat the join", async () => {
  const { f, invoke, setMember } = await systemicFixture(); const id = notify(f); await f.h.cp.outbox.deliverCeoNotifications();
  const send = vi.spyOn(f.h.buzz, "send").mockImplementationOnce(async () => {
    setMember(false); throw new Error(signerRefusal);
  });
  for (let i = 0; i < 3; i++) await f.h.buzzAdapter.deliverPending();
  expect(invoke).toHaveBeenCalledTimes(1); expect(send).toHaveBeenCalledTimes(1);
  expect(processingOf(f, id)).toMatchObject({ status: "PENDING", failure_class: "repairable", reason_code: "BUZZ_LOCAL_SEND_POLICY_REFUSED" });
  expect(events(f, "CEO_NOTIFICATION_BUZZ_ROUTE_NOT_READY")).toMatchObject([{ evidence: { source: "SEND_REFUSAL", code: "mention_policy" } }]);
  setMember(true); await f.h.buzzAdapter.deliverPending();
  expect(send).toHaveBeenCalledTimes(1); expect(f.h.cp.outbox.get(id)?.status).toBe("PENDING");
});

it("systemic membership never touches the 12 legacy-unknown rows, even with an exact later refusal", async () => {
  const { f, invoke, readback } = await systemicFixture();
  const ids = Array.from({ length: 12 }, (_, i) => notify(f, `systemic-legacy-${i}`));
  await f.h.cp.outbox.deliverCeoNotifications();
  for (const id of ids) {
    f.h.cp.audit.record({ kind: "CEO_NOTIFICATION_LEGACY_OUTCOME_UNKNOWN", evidence: { messageId: id } });
    f.h.cp.db.run("UPDATE outbox SET attempts = 1, failure_class = 'contract', last_error = ? WHERE message_id = ?", [signerRefusal, id]);
  }
  const before = ids.map(id => processingOf(f, id));
  await f.h.buzzAdapter.deliverPending(); await f.h.buzzAdapter.deliverPending();
  expect(ids.map(id => processingOf(f, id))).toEqual(before);
  expect(invoke).not.toHaveBeenCalled(); expect(readback).not.toHaveBeenCalled(); expect(f.h.buzz.sent).toHaveLength(0);
});

it("an overlapping positive roster cannot bypass a still-pending host ensure receipt", async () => {
  const { f, invoke, setMember } = await systemicFixture(); const id = notify(f); await f.h.cp.outbox.deliverCeoNotifications();
  f.h.cp.db.run("UPDATE outbox SET attempts = 1, failure_class = 'contract', last_error = ? WHERE message_id = ?", [signerRefusal, id]);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  invoke.mockImplementationOnce(async (_operation, allocation) => {
    if (!("mode" in allocation)) throw new Error("unexpected allocation");
    setMember(true); await held;
    return { ceoBuzzSigner: { route: allocation.route, signer: allocation.signer, changed: true, rosterVerified: true } };
  });
  const send = vi.spyOn(f.h.buzz, "send");
  const first = f.h.buzzAdapter.deliverPending(); await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
  await f.h.buzzAdapter.deliverPending();
  expect(send).not.toHaveBeenCalled(); expect(f.h.cp.outbox.get(id)?.status).toBe("PENDING");
  release(); await first;
  expect(invoke).toHaveBeenCalledTimes(1); expect(send).toHaveBeenCalledTimes(1);
  expect(f.h.cp.outbox.get(id)?.status).toBe("SENT");
});

it("a lost ensure receipt recovers through independent membership readback without a second join", async () => {
  const { f, invoke, signer, setMember } = await systemicFixture(); const id = notify(f); await f.h.cp.outbox.deliverCeoNotifications();
  f.h.cp.db.run("UPDATE outbox SET attempts = 1, failure_class = 'contract', last_error = ? WHERE message_id = ?", [signerRefusal, id]);
  const route = currentCanonicalCeoBuzzRoute(f.h.cp.db)!;
  // A previous daemon committed intent and died after the member was added, before its receipt.
  f.h.cp.audit.record({ kind: "CEO_BUZZ_SIGNER_ENSURE", evidence: { route, signer, state: "INTENT", ensureDigest: digestOf({ route, signer }) } });
  setMember(true);
  const send = vi.spyOn(f.h.buzz, "send"); await f.h.buzzAdapter.deliverPending();
  expect(invoke).not.toHaveBeenCalled(); expect(send).toHaveBeenCalledTimes(1);
  expect(f.h.cp.outbox.get(id)?.status).toBe("SENT");
  expect(events(f, "CEO_BUZZ_SIGNER_READBACK").at(-1)?.evidence).toMatchObject({ registered: true, signer });
});

it("ACP1199-01: revocation during a no-host roster read prevents every post", async () => {
  const { f, readiness } = await signerRoute(); const id = notify(f); await f.h.cp.outbox.deliverCeoNotifications();
  readiness.mockImplementationOnce(async () => {
    expect(f.h.cp.bindings.revoke("CEO", "revoke during roster read").allowed).toBe(true);
    return { signer: "daemon-signer", registered: true };
  });
  const send = vi.spyOn(f.h.buzz, "send"); await f.h.buzzAdapter.deliverPending();
  expect(send).not.toHaveBeenCalled(); expect(f.h.cp.outbox.get(id)?.status).not.toBe("SENT");
});

it("ACP1199-01: revocation after positive canonical readiness but before its continuation prevents every post", async () => {
  const { f, setMember, invoke } = await systemicFixture(); setMember(true);
  const id = notify(f); await f.h.cp.outbox.deliverCeoNotifications();
  const all = f.h.cp.db.all.bind(f.h.cp.db);
  let reads = 0; let revoked = false;
  vi.spyOn(f.h.cp.db, "all").mockImplementation((sql, params) => {
    const rows = all(sql, params);
    if (sql.includes("SELECT DISTINCT a.assignment_id AS assignmentId") && ++reads === 2) {
      queueMicrotask(() => { revoked = f.h.cp.bindings.revoke("CEO", "revoke after readiness").allowed; });
    }
    return rows;
  });
  const send = vi.spyOn(f.h.buzz, "send"); await f.h.buzzAdapter.deliverPending();
  expect(revoked).toBe(true); expect(send).not.toHaveBeenCalled(); expect(invoke).not.toHaveBeenCalled();
  expect(f.h.cp.outbox.get(id)?.status).not.toBe("SENT");
});

it.each([false, true])("ACP1199-03: known invalid host receipts cannot be bypassed on later sweeps; resumed = %s", async resumed => {
  const { f, invoke, setMember, signer } = await systemicFixture(); const id = notify(f); await f.h.cp.outbox.deliverCeoNotifications();
  if (resumed) f.h.cp.db.run("UPDATE outbox SET attempts = 1, failure_class = 'contract', last_error = ? WHERE message_id = ?", [signerRefusal, id]);
  invoke.mockImplementationOnce(async (_op, allocation) => {
    if (!("mode" in allocation)) throw new Error("unexpected allocation");
    setMember(true);
    return { ceoBuzzSigner: { route: { ...allocation.route, roomId: "wrong-room" }, signer, changed: true, rosterVerified: true } };
  });
  const send = vi.spyOn(f.h.buzz, "send");
  for (let i = 0; i < 3; i++) await f.h.buzzAdapter.deliverPending();
  expect(invoke).toHaveBeenCalledTimes(1); expect(send).not.toHaveBeenCalled();
  expect(processingOf(f, id)).toMatchObject({ status: "PENDING", sent_at: null, retry_eligible: 0 });
  // Membership, a lost result, or a self-declared success cannot erase a known mismatch.
  const route = currentCanonicalCeoBuzzRoute(f.h.cp.db)!; const ensureDigest = digestOf({ route, signer });
  f.h.cp.audit.record({ kind: "CEO_BUZZ_SIGNER_ENSURE", evidence: { ensureDigest, route, signer, state: "SUCCEEDED" } });
  await f.h.buzzAdapter.deliverPending(); expect(send).not.toHaveBeenCalled();
  // A separately obtained, validated exact-room receipt supplies the missing verification.
  f.h.cp.audit.record({ kind: "CEO_BUZZ_SIGNER_ENSURE", evidence: { ensureDigest, route, signer, state: "SUCCEEDED",
    receipt: { route, signer, changed: false, rosterVerified: true } } });
  await Promise.all([f.h.buzzAdapter.deliverPending(), f.h.buzzAdapter.deliverPending()]);
  expect(send).toHaveBeenCalledTimes(1); expect(f.h.cp.outbox.get(id)?.status).toBe("SENT"); expect(invoke).toHaveBeenCalledTimes(1);
});

it("ACP1199-03: overlapping ensures cannot release mail after a known invalid receipt", async () => {
  const { f, invoke, setMember } = await systemicFixture(); const id = notify(f); await f.h.cp.outbox.deliverCeoNotifications();
  f.h.cp.db.run("UPDATE outbox SET attempts = 1, failure_class = 'contract', last_error = ? WHERE message_id = ?", [signerRefusal, id]);
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  invoke.mockImplementationOnce(async (_op, allocation) => {
    if (!("mode" in allocation)) throw new Error("unexpected allocation");
    setMember(true); await held;
    return { ceoBuzzSigner: { route: allocation.route, signer: "b".repeat(64), changed: true, rosterVerified: true } };
  });
  const send = vi.spyOn(f.h.buzz, "send"); const first = f.h.buzzAdapter.deliverPending();
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
  await f.h.buzzAdapter.deliverPending(); expect(send).not.toHaveBeenCalled();
  release(); await first;
  await Promise.all([f.h.buzzAdapter.deliverPending(), f.h.buzzAdapter.deliverPending()]);
  expect(invoke).toHaveBeenCalledTimes(1); expect(send).not.toHaveBeenCalled();
  expect(processingOf(f, id)).toMatchObject({ status: "PENDING", failure_class: "repairable", sent_at: null });
});

it.each(["roster", "policy"])("ACP1199-03: a known %s mismatch remains withheld on subsequent sweeps", async mismatch => {
  const { f, invoke, setMember } = await systemicFixture(); const id = notify(f); await f.h.cp.outbox.deliverCeoNotifications();
  invoke.mockImplementationOnce(async (_op, allocation) => {
    if (!("mode" in allocation)) throw new Error("unexpected allocation");
    setMember(true);
    return { ceoBuzzSigner: { route: allocation.route, signer: allocation.signer, changed: true,
      rosterVerified: mismatch !== "roster", ...(mismatch === "policy" ? { policyVerified: false } : {}) } } as unknown as HostObservation;
  });
  const send = vi.spyOn(f.h.buzz, "send");
  for (let i = 0; i < 3; i++) await f.h.buzzAdapter.deliverPending();
  expect(send).not.toHaveBeenCalled(); expect(invoke).toHaveBeenCalledTimes(1);
  expect(processingOf(f, id)).toMatchObject({ status: "PENDING", failure_class: "repairable", sent_at: null });
});

it("CEO d0d06bc1: an nsec-authenticated CLI refusal after readiness preserves its exact reason and never marks SENT", async () => {
  const f = await fixture(); await bindBuzz(f); const id = notify(f); await f.h.cp.outbox.deliverCeoNotifications();
  const secret = Buffer.from("1".repeat(64), "hex"); const credential = nsecEncode(secret); const signer = getPublicKey(secret);
  const refusal = JSON.stringify({ error: "authorization", message: "permission denied for this signer", retryable: false });
  const binary = join(tempDir("r1-buzz-cli-"), "buzz.cjs");
  writeFileSync(binary, `#!${process.execPath}
const args = process.argv.slice(2);
if (process.env.BUZZ_PRIVATE_KEY !== ${JSON.stringify(credential)}) process.exit(9);
if (args[0] === 'channels' && args[1] === 'get') process.stdout.write(JSON.stringify({channel_id:args[args.indexOf('--channel')+1]}));
else if (args[0] === 'channels' && args[1] === 'members') process.stdout.write(JSON.stringify([{pubkey:${JSON.stringify(signer)},role:'member'}]));
else if (args[0] === 'messages' && args[1] === 'send') { process.stdin.resume();process.stdin.on('end',()=>{process.stderr.write(${JSON.stringify(refusal)});process.exitCode=1;}); }
else process.exitCode=8;
`, { mode: 0o700 });
  vi.stubEnv("BUZZ_PRIVATE_KEY", credential);
  const transport = new BuzzCliTransport(binary);
  vi.unstubAllEnvs(); // The transport continues using the pinned fixture credential.
  f.h.buzzAdapter = new BuzzAdapter(f.h.cp.db, f.h.cp.clock, f.h.cp.audit, f.h.cp.sessions, f.h.cp.bindings, f.h.cp.outbox, transport);
  const markSent = vi.spyOn(f.h.cp.outbox, "markSent"); const send = vi.spyOn(transport, "send");
  expect((await f.h.buzzAdapter.deliverPending()).failed).toEqual([id]);
  await f.h.buzzAdapter.deliverPending();
  expect(send).toHaveBeenCalledTimes(1); expect(markSent).not.toHaveBeenCalled();
  expect(processingOf(f, id)).toMatchObject({ status: "PENDING", failure_class: "security", retry_eligible: 0,
    last_error: `buzz send failed: ${refusal}`, sent_at: null });
});

it.each(["absent", "unreadable"])("CEO d0d06bc1: durable intent with %s membership is not a successful join", async membership => {
  const { f, invoke, signer, readback } = await systemicFixture(); const id = notify(f); await f.h.cp.outbox.deliverCeoNotifications();
  const route = currentCanonicalCeoBuzzRoute(f.h.cp.db)!;
  f.h.cp.audit.record({ kind: "CEO_BUZZ_SIGNER_ENSURE", evidence: { route, signer, state: "INTENT", ensureDigest: digestOf({ route, signer }) } });
  if (membership === "unreadable") readback.mockRejectedValue(new Error("roster response lost"));
  const send = vi.spyOn(f.h.buzz, "send");
  for (let i = 0; i < 3; i++) await f.h.buzzAdapter.deliverPending();
  expect(invoke).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  expect(processingOf(f, id)).toMatchObject({ status: "PENDING", failure_class: "repairable", sent_at: null, retry_eligible: 0 });
});

it("REVIEW-PROBE: a new daemon signer cannot erase a known invalid host result", async () => {
  const { f, invoke, setMember, signer } = await systemicFixture();
  const id = notify(f); await f.h.cp.outbox.deliverCeoNotifications();
  invoke.mockImplementationOnce(async (_op, allocation) => {
    if (!("mode" in allocation)) throw new Error("unexpected allocation");
    setMember(true);
    return { ceoBuzzSigner: { route: { ...allocation.route, roomId: "wrong-room" }, signer, changed: true, rosterVerified: true } };
  });
  const send = vi.spyOn(f.h.buzz, "send");
  await f.h.buzzAdapter.deliverPending();
  expect(events(f, "CEO_BUZZ_SIGNER_ENSURE").at(-1)?.evidence).toMatchObject({ state: "INVALID" });
  expect(send).not.toHaveBeenCalled();
  // Rebuild the adapter as on a daemon restart with a replacement sending credential.
  const transport = { openChannel: async () => "unused", available: async () => true, send,
    signerReadiness: async () => ({ signer: "b".repeat(64), registered: true }) };
  f.h.buzzAdapter = new BuzzAdapter(f.h.cp.db, f.h.cp.clock, f.h.cp.audit, f.h.cp.sessions,
    f.h.cp.bindings, f.h.cp.outbox, transport, { invoke });
  await f.h.buzzAdapter.deliverPending();
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(send).not.toHaveBeenCalled();
  expect(f.h.cp.outbox.get(id)?.status).toBe("PENDING");
});

it.each([
  ["signer", "INVALID"], ["binding", "INVALID"], ["signer and binding", "INVALID"],
  ["signer", "REFUSED"], ["binding", "REFUSED"], ["signer and binding", "REFUSED"],
] as const)("ACP1199-03 r2: %s change preserves %s until the exact current receipt", async (change, outcome) => {
  const { f, room, invoke, setMember, readback, signer } = await systemicFixture();
  // Establish a confirmed canonical refusal before Buzz is selected, so changing generation
  // exercises membership readiness rather than the separate pre-journal/unknown-history hold.
  f.h.cp.sessions.setBuzzAddress(f.gatewaySessionId, null);
  const id = notify(f); await f.h.cp.outbox.deliverCeoNotifications();
  expect(events(f, "CEO_NOTIFICATION_CANONICAL_RESULT")).toMatchObject([{ evidence: { outcome: "REFUSED" } }]);
  f.h.cp.sessions.setBuzzAddress(f.gatewaySessionId, room);
  await f.h.cp.outbox.deliverCeoNotifications();
  const oldRoute = currentCanonicalCeoBuzzRoute(f.h.cp.db)!;
  invoke.mockImplementationOnce(async (_op, allocation) => {
    if (!("mode" in allocation)) throw new Error("unexpected allocation");
    setMember(true);
    if (outcome === "REFUSED") throw new HostProvisionerError("REFUSED", { code: "authorization", message: "permission denied" });
    return { ceoBuzzSigner: { route: { ...allocation.route, roomId: "wrong-room" }, signer, changed: true, rosterVerified: true } };
  });
  const send = vi.spyOn(f.h.buzz, "send");
  await f.h.buzzAdapter.deliverPending(); expect(send).not.toHaveBeenCalled();
  const currentSigner = change.includes("signer") ? "b".repeat(64) : signer;
  readback.mockResolvedValue({ signer: currentSigner, registered: true });
  if (change.includes("binding")) {
    expect(f.h.cp.bindings.revoke("CEO", "same-room generation transition").allowed).toBe(true);
    const claimed = { executorKind: "hermes", targetLocator: LIVE, targetLocatorDigest: DIGEST };
    let receipt: unknown; let attestationDigest = "";
    const rebound = f.h.cp.bindings.bind({ role: Role.CEO, sessionId: f.gatewaySessionId, authenticatedTarget: {
      claimed, protocolVersion: "hermes.target-bind/v1", expectedExecutorRuntimeIdentity: RUNTIME,
      get targetBindReceipt() { return receipt; }, get attestationDigest() { return attestationDigest; },
      verify: tuple => {
        const fields = { domain: "hermes.target-bind", version: 1, actor_id: tuple.actorId, binding_generation: tuple.generation,
          executor_runtime_identity: RUNTIME, requested_session_id: LIVE, lineage_root_digest: DIGEST };
        attestationDigest = digestOf(fields); receipt = { ...fields, receipt_digest: attestationDigest }; return claimed;
      },
    } });
    expect(rebound.allowed).toBe(true);
    await f.h.cp.outbox.deliverCeoNotifications();
  }
  // Restart is independent of either changed credential or generation.
  f.h.buzzAdapter = new BuzzAdapter(f.h.cp.db, f.h.cp.clock, f.h.cp.audit, f.h.cp.sessions,
    f.h.cp.bindings, f.h.cp.outbox, f.h.buzz, { invoke });
  const route = currentCanonicalCeoBuzzRoute(f.h.cp.db)!;
  expect(route.roomId).toBe(oldRoute.roomId);
  if (change.includes("binding")) expect(route.bindingGeneration).toBeGreaterThan(oldRoute.bindingGeneration);
  const receipt = { route, signer: currentSigner, changed: false, rosterVerified: true };
  const record = (value: typeof receipt) => f.h.cp.audit.record({ kind: "CEO_BUZZ_SIGNER_ENSURE",
    evidence: { route: value.route, signer: value.signer, ensureDigest: digestOf({ route: value.route, signer: value.signer }),
      state: "SUCCEEDED", receipt: value } });
  await f.h.buzzAdapter.deliverPending(); expect(send).not.toHaveBeenCalled();
  for (const wrong of [
    { ...receipt, route: oldRoute, signer },
    { ...receipt, route: { ...route, roomId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" } },
    { ...receipt, signer: "c".repeat(64) },
    { ...receipt, route: { ...route, bindingGeneration: route.bindingGeneration + 1 } },
  ]) {
    record(wrong);
    await Promise.all([f.h.buzzAdapter.deliverPending(), f.h.buzzAdapter.deliverPending()]);
    expect(send).not.toHaveBeenCalled();
  }
  expect(processingOf(f, id)).toMatchObject({ status: "PENDING", sent_at: null, retry_eligible: 0 });
  record(receipt);
  await Promise.all([f.h.buzzAdapter.deliverPending(), f.h.buzzAdapter.deliverPending()]);
  expect(send).toHaveBeenCalledTimes(1); expect(f.h.cp.outbox.get(id)?.status).toBe("SENT");
  expect(invoke).toHaveBeenCalledTimes(1);
});


it.each([false, true])("CEO 6bd2011d: invalid provisioning survives a new-destination takeover; canonical history = %s", async canonicalHistory => {
  const { f, room, invoke, signer, readback, setMember } = await systemicFixture();
  // Exercise both the ordinary Buzz route and the canonical route's independent history fence.
  if (canonicalHistory) f.h.cp.sessions.setBuzzAddress(f.gatewaySessionId, null);
  const id = notify(f); await f.h.cp.outbox.deliverCeoNotifications();
  if (canonicalHistory) {
    f.h.cp.sessions.setBuzzAddress(f.gatewaySessionId, room);
    await f.h.cp.outbox.deliverCeoNotifications();
  }
  invoke.mockImplementationOnce(async (_op, allocation) => {
    if (!("mode" in allocation)) throw new Error("unexpected allocation");
    setMember(true);
    return { ceoBuzzSigner: { route: { ...allocation.route, roomId: "wrong-room" }, signer, changed: true, rosterVerified: true } };
  });
  const send = vi.spyOn(f.h.buzz, "send");
  await f.h.buzzAdapter.deliverPending();
  const oldRoute = currentCanonicalCeoBuzzRoute(f.h.cp.db)!;
  expect(events(f, "CEO_BUZZ_SIGNER_ENSURE").at(-1)?.evidence.state).toBe("INVALID");
  const next = f.h.cp.sessions.create({ provider: "hermes", model: "next-ceo", buzzAddress: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" });
  expect(f.h.cp.sessions.transition(next.sessionId, SessionLifecycle.READY, "ready").allowed).toBe(true);
  expect(f.h.cp.sessions.bindBuzzActor({ sessionId: next.sessionId, sessionSecret: next.sessionSecret!, buzzActorId: "next-ceo-key" },
    { isAllowedActor: () => true }).allowed).toBe(true);
  expect(f.h.cp.bindings.switchTo({ role: Role.CEO, sessionId: next.sessionId, conversation: "REPLACED", takeover: true,
    reason: "new verified recipient" }).allowed).toBe(true);
  readback.mockResolvedValue({ signer, registered: true });
  for (let n = 0; n < 2; n++) { await f.h.buzzAdapter.deliverPending(); expect(send).not.toHaveBeenCalled(); }
  expect(invoke).toHaveBeenCalledTimes(1);
  if (!canonicalHistory) return; // No canonical target exists here: no supported ensure or receipt may be invented.
  // Bind the replacement's own canonical target through the existing authenticated boundary.
  expect(f.h.cp.bindings.revoke("CEO", "attest current target").allowed).toBe(true);
  const claimed = { executorKind: "hermes", targetLocator: "next-live-target", targetLocatorDigest: DIGEST };
  let receipt: unknown; let attestationDigest = "";
  expect(f.h.cp.bindings.bind({ role: Role.CEO, sessionId: next.sessionId, authenticatedTarget: {
    claimed, protocolVersion: "hermes.target-bind/v1", expectedExecutorRuntimeIdentity: RUNTIME,
    get targetBindReceipt() { return receipt; }, get attestationDigest() { return attestationDigest; },
    verify: tuple => {
      const fields = { domain: "hermes.target-bind", version: 1, actor_id: tuple.actorId, binding_generation: tuple.generation,
        executor_runtime_identity: RUNTIME, requested_session_id: claimed.targetLocator, lineage_root_digest: DIGEST };
      attestationDigest = digestOf(fields); receipt = { ...fields, receipt_digest: attestationDigest }; return claimed;
    },
  } }).allowed).toBe(true);
  await f.h.cp.outbox.deliverCeoNotifications();
  const route = currentCanonicalCeoBuzzRoute(f.h.cp.db)!;
  expect(route.roomId).not.toBe(oldRoute.roomId); expect(route.recipient).not.toBe(oldRoute.recipient);
  const record = (current: typeof route) => f.h.cp.audit.record({ kind: "CEO_BUZZ_SIGNER_ENSURE", evidence: {
    route: current, signer, ensureDigest: digestOf({ route: current, signer }), state: "SUCCEEDED",
    receipt: { route: current, signer, changed: false, rosterVerified: true } } });
  record(oldRoute); await f.h.buzzAdapter.deliverPending(); expect(send).not.toHaveBeenCalled();
  record(route);
  await Promise.all([f.h.buzzAdapter.deliverPending(), f.h.buzzAdapter.deliverPending()]);
  expect(send).toHaveBeenCalledTimes(1);
  expect(f.h.cp.outbox.get(id)).toMatchObject({ messageId: id, status: "SENT" });
  expect(invoke).toHaveBeenCalledTimes(1);
});


it("D2: roster-positive local policy refusal holds once across later sweeps and restart", async () => {
  const { f, setMember, invoke } = await systemicFixture(); setMember(true);
  const id = notify(f); await f.h.cp.outbox.deliverCeoNotifications();
  const send = vi.spyOn(f.h.buzz, "send").mockRejectedValue(new Error(signerRefusal));
  await f.h.buzzAdapter.deliverPending();
  f.h.buzzAdapter = new BuzzAdapter(f.h.cp.db, f.h.cp.clock, f.h.cp.audit, f.h.cp.sessions,
    f.h.cp.bindings, f.h.cp.outbox, f.h.buzz, { invoke });
  for (let n = 0; n < 5; n++) {
    f.h.clock.advance(70_000);
    await f.h.cp.outbox.deliverCeoNotifications();
    await Promise.all([f.h.buzzAdapter.deliverPending(), f.h.buzzAdapter.deliverPending()]);
  }
  expect({ sends: send.mock.calls.length, audits: events(f, "CEO_NOTIFICATION_BUZZ_ROUTE_NOT_READY").length })
    .toEqual({ sends: 1, audits: 1 });
  expect(invoke).not.toHaveBeenCalled();
  expect(processingOf(f, id)).toMatchObject({ status: "PENDING", attempts: 1,
    reason_code: "BUZZ_LOCAL_SEND_POLICY_REFUSED", retry_eligible: 0, next_attempt_at: null, sent_at: null });
});


it.each(["policy", "signer", "room", "recipient", "binding"] as const)("D2: a changed %s revalidates once through resume", async change => {
  const { f, readiness } = await signerRoute();
  let policy: string | null = "policy-v1";
  Object.assign(f.h.buzz, { localSendPolicyDigest: () => policy });
  const id = notify(f); await f.h.cp.outbox.deliverCeoNotifications();
  const before = processingOf(f, id)!;
  const send = vi.spyOn(f.h.buzz, "send").mockRejectedValueOnce(new Error(signerRefusal));
  await f.h.buzzAdapter.deliverPending();
  await f.h.buzzAdapter.deliverPending(); expect(send).toHaveBeenCalledTimes(1);
  if (change === "policy") {
    policy = null; await f.h.buzzAdapter.deliverPending(); expect(send).toHaveBeenCalledTimes(1);
    policy = "policy-v2";
  }
  if (change === "signer") readiness.mockResolvedValue({ signer: "replacement-daemon", registered: true });
  if (change === "room") f.h.cp.sessions.setBuzzAddress(f.gatewaySessionId, "changed-ceo-room");
  if (change === "recipient") {
    // Exercise an authenticated replacement holder; a live session cannot replace its bound key.
    const next = f.h.cp.sessions.create({ provider: "hermes", model: "next-ceo", buzzAddress: "ceo-room" });
    expect(f.h.cp.sessions.transition(next.sessionId, SessionLifecycle.READY, "ready").allowed).toBe(true);
    expect(f.h.cp.sessions.bindBuzzActor({ sessionId: next.sessionId, sessionSecret: next.sessionSecret!, buzzActorId: "replacement-ceo-key" },
      { isAllowedActor: () => true }).allowed).toBe(true);
    expect(f.h.cp.bindings.switchTo({ role: Role.CEO, sessionId: next.sessionId, conversation: "REPLACED", takeover: true,
      reason: "new verified recipient" }).allowed).toBe(true);
    await f.h.cp.outbox.deliverCeoNotifications();
  }
  if (change === "binding") {
    expect(f.h.cp.bindings.revoke("CEO", "policy hold generation transition").allowed).toBe(true);
    expect(f.h.cp.bindings.bind({ role: Role.CEO, sessionId: f.gatewaySessionId }).allowed).toBe(true);
    await f.h.cp.outbox.deliverCeoNotifications();
  }
  expect(processingOf(f, id)).toMatchObject({ reason_code: "BUZZ_LOCAL_SEND_POLICY_REFUSED", failure_class: "repairable" });
  readiness.mockResolvedValueOnce({ signer: change === "signer" ? "replacement-daemon" : "daemon-signer", registered: false });
  await f.h.buzzAdapter.deliverPending(); expect(send).toHaveBeenCalledTimes(1);
  await Promise.all([f.h.buzzAdapter.deliverPending(), f.h.buzzAdapter.deliverPending()]);
  expect(send).toHaveBeenCalledTimes(2);
  expect(processingOf(f, id)).toMatchObject({ status: "SENT", payload_digest: before.payload_digest, payload_json: before.payload_json });
  expect(events(f, "CEO_NOTIFICATION_BUZZ_ROUTE_NOT_READY").filter(e => e.reasonCode === ReasonCode.BUZZ_LOCAL_SEND_POLICY_REFUSED)).toHaveLength(1);
});

it("D2: a changed policy that still refuses establishes one new hold", async () => {
  const { f } = await signerRoute(); let policy = "v1";
  Object.assign(f.h.buzz, { localSendPolicyDigest: () => policy });
  const id = notify(f); await f.h.cp.outbox.deliverCeoNotifications();
  const send = vi.spyOn(f.h.buzz, "send").mockRejectedValue(new Error(signerRefusal));
  await f.h.buzzAdapter.deliverPending(); policy = "v2";
  for (let n = 0; n < 4; n++) await f.h.buzzAdapter.deliverPending();
  expect(send).toHaveBeenCalledTimes(2);
  expect(events(f, "CEO_NOTIFICATION_BUZZ_ROUTE_NOT_READY")).toHaveLength(2);
  expect(processingOf(f, id)).toMatchObject({ status: "PENDING", attempts: 2, retry_eligible: 0 });
});

it("D2: CLI policy fingerprint is request-driven, byte-sensitive and unavailable when unreadable", () => {
  const file = join(tempDir("send-policy-"), "required-mentions.json");
  writeFileSync(file, "policy-v1");
  const transport = new BuzzCliTransport("unused-fake", null, file);
  const first = transport.localSendPolicyDigest(); expect(first).not.toBeNull();
  expect(transport.localSendPolicyDigest()).toBe(first);
  writeFileSync(file, "policy-v2"); expect(transport.localSendPolicyDigest()).not.toBe(first);
  expect(new BuzzCliTransport("unused-fake", null, file + ".missing").localSendPolicyDigest()).toBeNull();
  expect(new BuzzCliTransport("unused-fake", null, "relative-policy").localSendPolicyDigest()).toBeNull();
});


it("D2: upgrades an already observed local refusal without another send", async () => {
  const { f } = await signerRoute(); const id = notify(f); await f.h.cp.outbox.deliverCeoNotifications();
  f.h.cp.db.run("UPDATE outbox SET attempts = 1, failure_class = 'repairable', reason_code = ?, last_error = ? WHERE message_id = ?",
    [ReasonCode.BUZZ_SIGNER_NOT_REGISTERED, signerRefusal, id]);
  f.h.cp.audit.record({ kind: "CEO_NOTIFICATION_BUZZ_ROUTE_NOT_READY", reasonCode: ReasonCode.BUZZ_SIGNER_NOT_REGISTERED,
    evidence: { messageId: id, targetSessionId: f.gatewaySessionId, bindingGeneration: 1, room: "ceo-room", recipient: "ceo-key",
      signer: "daemon-signer", source: "SEND_REFUSAL", attemptNumber: 1, code: "mention_policy", message: "signer not registered for channel" } });
  const send = vi.spyOn(f.h.buzz, "send");
  for (let n = 0; n < 4; n++) await f.h.buzzAdapter.deliverPending();
  expect(send).not.toHaveBeenCalled();
  expect(processingOf(f, id)).toMatchObject({ attempts: 1, status: "PENDING", reason_code: "BUZZ_LOCAL_SEND_POLICY_REFUSED" });
  expect(events(f, "CEO_NOTIFICATION_BUZZ_ROUTE_NOT_READY").filter(e => e.reasonCode === ReasonCode.BUZZ_LOCAL_SEND_POLICY_REFUSED)).toHaveLength(1);
});


it("D2: unchanged policy holds never provision a subsequently missing roster member", async () => {
  const { f, setMember, invoke } = await systemicFixture(); setMember(true);
  const id = notify(f); await f.h.cp.outbox.deliverCeoNotifications();
  const send = vi.spyOn(f.h.buzz, "send").mockRejectedValue(new Error(signerRefusal));
  await f.h.buzzAdapter.deliverPending(); setMember(false);
  for (let n = 0; n < 3; n++) await f.h.buzzAdapter.deliverPending();
  expect(send).toHaveBeenCalledTimes(1); expect(invoke).not.toHaveBeenCalled();
  expect(events(f, "CEO_NOTIFICATION_BUZZ_ROUTE_NOT_READY")).toHaveLength(1);
  expect(processingOf(f, id)).toMatchObject({ status: "PENDING", reason_code: "BUZZ_LOCAL_SEND_POLICY_REFUSED" });
});


it("D2: a policy edit during the refused attempt cannot immediately repeat the refusal", async () => {
  const { f } = await signerRoute(); let policy = "v1";
  Object.assign(f.h.buzz, { localSendPolicyDigest: () => policy });
  const id = notify(f); await f.h.cp.outbox.deliverCeoNotifications();
  const send = vi.spyOn(f.h.buzz, "send").mockImplementation(async () => {
    policy = "v2"; throw new Error(signerRefusal);
  });
  for (let n = 0; n < 4; n++) await f.h.buzzAdapter.deliverPending();
  expect(send).toHaveBeenCalledTimes(1);
  expect(events(f, "CEO_NOTIFICATION_BUZZ_ROUTE_NOT_READY")).toMatchObject([
    { evidence: { messageId: id, policyBinding: { policyDigest: "v2" } } },
  ]);
});
