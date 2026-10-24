import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import type * as Http from "node:http";

import { ReasonCode } from "../../src/core/reason-codes.ts";
import { startConfiguredCeoNotificationRoute } from "../../src/daemon/agentcpd.ts";
import { Outbox } from "../../src/outbox/outbox.ts";
import { MessageKind } from "../../src/outbox/envelope.ts";
import { daemonNoticeCanonical, daemonNoticeFields, daemonNoticePayloadDigest,
  type DaemonNoticeBody } from "../../src/runtime/acp-daemon-notice.ts";
import { createHermesGatewayDaemonNoticeSender } from "../../src/runtime/hermes-gateway-conversation.ts";
import { adoptedFixture, DIGEST, GATEWAY, LIVE, LSTART, TOKEN } from "../helpers/adopted-ceo.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";

const http = vi.hoisted(() => ({
  posts: [] as DaemonNoticeBody[],
  mode: "refused" as "refused" | "completed" | "timeout" | "lost" | "uncertain" | "409" | "other400" | "wrongShape" | "partial" | "notSent",
  hold: false,
  release: null as (() => void) | null,
}));

// The production HTTP senders and outbox run unchanged. Only the HTTP socket edge is fake:
// no listener, network, real Gateway, Buzz binary, process lookup or credential store is used.
vi.mock("node:http", async (original) => {
  const real = await original<typeof Http>();
  const { EventEmitter } = await import("node:events");
  return { ...real, request: (_options: { method: string }, respond: (res: unknown) => void) => {
    const req = Object.assign(new EventEmitter(), {
      destroy: () => { req.emit("close"); },
      end: (bytes?: string) => {
        const isPost = _options.method === "POST";
        const notice = isPost ? JSON.parse(bytes!) as DaemonNoticeBody : null;
        if (notice) http.posts.push(notice);
        const deliver = () => {
          if (isPost && http.mode === "timeout") return;
          if (isPost && http.mode === "lost") { req.emit("error", new Error("response lost")); return; }
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
  } };
});

type Fixture = ReturnType<typeof adoptedFixture>;
const fixtures: Fixture[] = [];
beforeEach(() => { http.posts = []; http.mode = "refused"; http.hold = false; http.release = null; });
afterEach(async () => {
  for (const f of fixtures.splice(0)) { await f.h.cp.outbox.deliverCeoNotifications(); f.h.cp.close(); }
});
afterAll(cleanupTempDirs);

const destination = { session_id: LIVE, lineage_root_digest: DIGEST, process_pid: GATEWAY, process_started_at: TOKEN };
const start = async (f: Fixture) => {
  expect(startConfiguredCeoNotificationRoute(f.h.cp, {
    environment: { ACP_TELEGRAM_EXTERNAL_SECRET: "lane-secret" },
    hermesConfiguration: { ACP_HERMES_LINEAGE_ROOT_DIGEST: DIGEST, ACP_HERMES_EXECUTABLE: "/opt/test/hermes",
      ACP_HERMES_PROFILE: "test", ACP_HERMES_HOME: "/opt/test/home",
      ACP_HERMES_EXECUTOR_RUNTIME_IDENTITY: "hermes-runtime:test", ACP_HERMES_GATEWAY_API_KEY: "test-key" },
    ports: { authorityHeld: () => true, processStartToken: () => TOKEN, processStartedAt: () => LSTART,
      identityReader: () => async () => destination,
      noticeSenderFactory: (options) => createHermesGatewayDaemonNoticeSender({ ...options, timeoutMs: http.hold ? 5000 : 20 }) },
  })).toEqual({ started: true });
  await f.h.cp.outbox.deliverCeoNotifications();
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
  "%s remains unknown; even a subsequent exact 400 cannot authorize Buzz", async (mode) => {
    const f = await fixture(); http.mode = mode;
    const id = notify(f);
    await f.h.cp.outbox.deliverCeoNotifications();
    expect(f.h.cp.outbox.get(id)?.status).toBe("PENDING");
    await bindBuzz(f);
    await f.h.buzzAdapter.deliverPending();
    expect(f.h.buzz.sent).toHaveLength(0);
    http.mode = "refused";
    await f.h.cp.outbox.deliverCeoNotifications();
    const refusedCount = http.posts.length;
    await f.h.cp.outbox.deliverCeoNotifications();
    await f.h.buzzAdapter.deliverPending();
    expect(http.posts).toHaveLength(refusedCount);
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

it("classifies all 12 pre-journal live-style rows as unknown even after their own new 400", async () => {
  const f = adoptedFixture(); fixtures.push(f);
  const ids = Array.from({ length: 12 }, (_, i) => notify(f, `legacy-${i}`));
  for (const id of ids) {
    f.h.cp.db.run("UPDATE outbox SET attempts = 7 WHERE message_id = ?", [id]);
    f.h.cp.audit.record({ kind: "CEO_NOTIFICATION_DELIVERY_FAILED", reasonCode: ReasonCode.CEO_CONVERSATION_UNAVAILABLE,
      evidence: { messageId: id } });
  }
  // A handover may reset a mutable counter. The legacy failure audit still holds the uncertainty.
  f.h.cp.db.run("UPDATE outbox SET attempts = 0 WHERE message_id = ?", [ids[0]!]);
  await bindBuzz(f); await start(f);
  for (let i = 0; i < 3; i++) { await f.h.cp.outbox.deliverCeoNotifications(); await f.h.buzzAdapter.deliverPending(); }
  expect(http.posts).toHaveLength(12);
  expect(f.h.buzz.sent).toHaveLength(0);
  expect(events(f, "CEO_NOTIFICATION_CANONICAL_ATTEMPT")).toHaveLength(12);
  for (const event of events(f, "CEO_NOTIFICATION_CANONICAL_ATTEMPT")) expect(event.evidence).toMatchObject({ legacyUnknown: true });
  expect(ids.map((id) => f.h.cp.outbox.get(id)?.status)).toEqual(Array(12).fill("PENDING"));
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

it("a pre-journal pending row is not called unsent merely because an old crash left its counter at zero", async () => {
  const f = adoptedFixture(); fixtures.push(f);
  const id = notify(f, "pre-journal-zero-counter");
  await bindBuzz(f); await start(f); await f.h.buzzAdapter.deliverPending();
  expect(events(f, "CEO_NOTIFICATION_LEGACY_OUTCOME_UNKNOWN")).toMatchObject([{ evidence: { messageId: id } }]);
  expect(events(f, "CEO_NOTIFICATION_CANONICAL_ATTEMPT")).toMatchObject([{ evidence: { legacyUnknown: true } }]);
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

it("a newer matching completed existing probe permits original canonical receipt lookup after receiver recovery", async () => {
  const f = adoptedFixture(); fixtures.push(f);
  const id = notify(f, "old-unknown");
  f.h.cp.db.run("UPDATE outbox SET attempts = 1 WHERE message_id = ?", [id]);
  await start(f);
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
