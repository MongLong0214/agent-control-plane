import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import { digestOf } from "../../src/core/digest.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import {
  createConfiguredHermesGatewayDaemonNoticeTarget,
  ownerMessageLedger,
  startConfiguredPeerMessageNoticeDelivery,
  startDaemonPeerMessageNoticeDelivery,
} from "../../src/daemon/agentcpd.ts";
import type { HolderIdentity } from "../../src/outbox/outbox.ts";
import { Role, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { MessageKind } from "../../src/outbox/envelope.ts";
import {
  type DaemonNoticeBody,
  type DaemonNoticeDestination,
  type DaemonNoticeTargetResolver,
  canonicalJson,
  daemonNoticeCanonical,
  daemonNoticeEventId,
  daemonNoticeKey,
  daemonNoticePayloadDigest,
  daemonNoticeProbeEventId,
  daemonNoticeSignature,
  deliverOwedPeerMessageNotices,
} from "../../src/runtime/acp-daemon-notice.ts";
import { createHermesGatewayDaemonNoticeSender } from "../../src/runtime/hermes-gateway-conversation.ts";
import { createHermesGatewayIdentityReader, type HermesGatewayIdentity } from "../../src/runtime/hermes-gateway-identity.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { makeHarness, registerFixtureProject, type Harness } from "../helpers/harness.ts";
import { DIGEST, GATEWAY, LIVE, LSTART, TOKEN, adoptedFixture } from "../helpers/adopted-ceo.ts";

afterAll(cleanupTempDirs);

/**
 * #1068 finding 04, `acp-daemon-notice/v1`. A queued CEO peer message that ACP refuses is owed a
 * notice to its sender, and before this the only reader of that notice was the CTO role's next exact
 * holder: after a plain revoke with no successor, the OWED entry sat there and nothing was sent. The
 * daemon now delivers it itself, through the CEO's existing canonical conversation, as a signed daemon
 * notice, and records the delivery append-only: in doubt before the POST, then settled on a matching
 * receipt or failed.
 *
 * Real here: SQLite, the binding registry's revoke, the outbox fence that owes the notice, the
 * adopted Hermes CEO's pinned authority (the same one the conversation turn uses), the HTTP sender and
 * the delivery record. A fake Gateway on an ephemeral loopback port plays Hermes, checking every
 * request the way the contract says Hermes checks it, with the test IKM.
 */

const VECTOR = JSON.parse(readFileSync(
  new URL("../fixtures/acp-daemon-notice-v1-vector.json", import.meta.url), "utf8",
)) as {
  ikm_utf8: string;
  derived_key_hex: string;
  vectors: Array<{
    name: string;
    event_id_input: { message_id: string; role_key: string; reason_code: string };
    body_fields: DaemonNoticeBody;
    canonical: string;
    canonical_utf8_hex: string;
    payload_digest: string;
    signature: string;
  }>;
};
/** The shared vector's IKM: a test constant, never the lane secret. */
const IKM = VECTOR.ikm_utf8;
/** The words the CEO's refused message carried; no notice may contain them. */
const CEO_WORDS = "CEO-INSTRUCTION-TEXT: ship the release tonight";

const config = () => ({
  ACP_HERMES_LINEAGE_ROOT_DIGEST: DIGEST,
  ACP_HERMES_EXECUTABLE: "/opt/test/hermes",
  ACP_HERMES_PROFILE: "test-profile",
  ACP_HERMES_HOME: "/opt/test/home",
  ACP_HERMES_EXECUTOR_RUNTIME_IDENTITY: "hermes-runtime:test",
  ACP_HERMES_GATEWAY_API_KEY: "fixture-gateway-key",
});
const PINNED: HermesGatewayIdentity = {
  session_id: LIVE, lineage_root_digest: DIGEST, process_pid: GATEWAY, process_started_at: TOKEN,
};

describe("acp-daemon-notice/v1: the shared test vector", () => {
  it("derives the same key, canonical bytes, digest and signature as the fixture Hermes copies", () => {
    expect(daemonNoticeKey(IKM).toString("hex")).toBe(VECTOR.derived_key_hex);
    for (const vector of VECTOR.vectors) {
      const { message_id, role_key, reason_code } = vector.event_id_input;
      expect(daemonNoticeEventId(message_id, role_key, reason_code), vector.name).toBe(vector.body_fields.event_id);
      const canonical = daemonNoticeCanonical(vector.body_fields);
      expect(canonical, vector.name).toBe(vector.canonical);
      expect(Buffer.from(canonical, "utf8").toString("hex"), vector.name).toBe(vector.canonical_utf8_hex);
      expect(daemonNoticePayloadDigest(canonical), vector.name).toBe(vector.payload_digest);
      expect(daemonNoticeSignature(daemonNoticeKey(IKM), canonical), vector.name).toBe(vector.signature);
    }
  });

  it("canonicalizes only the restricted shape", () => {
    expect(canonicalJson({ b: 1, a: { d: "x", c: 2 } })).toBe(`{"a":{"c":2,"d":"x"},"b":1}`);
    for (const outside of [1.5, true, null, [1], { a: [] }]) expect(() => canonicalJson(outside)).toThrow();
  });
});

/** One scripted Hermes answer for one POST, after the request has been checked. */
type Script =
  | "ok" | "uncertain" | "hang" | "drop"
  | "wrong-event" | "wrong-digest" | "receipt-not-completed" | "wrong-session" | "wrong-lineage"
  | "accepted-not-200" | "destination-mismatch" | "payload-mismatch"
  | "unknown-shape-409" | "unknown-shape-401" | "unknown-code-409";

/**
 * A Gateway that does what the contract says Hermes does: identity GET; POST checks protocol,
 * principal, digest and HMAC (with its own copy of the test IKM), destination and idempotency by
 * `event_id`, admits one CEO turn per unseen id, and replays the stored answer for a seen one.
 */
const fakeGateway = async (script: Script[], options: { ikm?: string } = {}) => {
  const key = daemonNoticeKey(options.ikm ?? IKM);
  const posts: Array<{ raw: string; body: DaemonNoticeBody; check: string }> = [];
  const turns = new Map<string, { payloadDigest: string; receiptId: string }>();
  let index = 0;
  const reply = (res: ServerResponse, status: number, body: unknown): void => {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(body));
  };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "GET") return reply(res, 200, PINNED);
    let raw = "";
    req.on("data", (chunk: Buffer) => { raw += chunk.toString("utf8"); });
    req.on("end", () => {
      const body = JSON.parse(raw) as DaemonNoticeBody;
      const step = script[Math.min(index, script.length - 1)]!;
      index += 1;
      const canonical = daemonNoticeCanonical(body);
      let check = "valid";
      if (body.protocol !== "acp-daemon-notice/v1" || body.principal !== "acp-daemon") check = "refused";
      else if (daemonNoticePayloadDigest(canonical) !== body.payload_digest ||
               daemonNoticeSignature(key, canonical) !== body.signature) check = "signature";
      posts.push({ raw, body, check });
      if (check === "refused") return reply(res, 403, { error: "daemon_notice_refused" });
      if (check === "signature") return reply(res, 401, { error: "daemon_notice_signature_invalid" });
      if (step === "destination-mismatch") return reply(res, 409, { error: "daemon_notice_destination_mismatch" });
      const seen = turns.get(body.event_id);
      if (step === "payload-mismatch" || (seen && seen.payloadDigest !== body.payload_digest)) {
        return reply(res, 409, { error: "daemon_notice_payload_mismatch" });
      }
      const turn = seen ?? { payloadDigest: body.payload_digest, receiptId: `hermes-notice:${turns.size + 1}` };
      turns.set(body.event_id, turn);
      const answer = {
        event_id: body.event_id,
        payload_digest: body.payload_digest,
        receipt: { receipt_id: turn.receiptId, status: "completed", session_id: LIVE, lineage_root_digest: DIGEST },
        text: "noted",
      };
      switch (step) {
        case "ok": return reply(res, 200, answer);
        case "uncertain": return reply(res, 409, { error: "canonical_event_uncertain" });
        case "hang": return undefined;
        case "drop": req.socket.destroy(); return undefined;
        case "wrong-event": return reply(res, 200, { ...answer, event_id: `acp-notice:${"0".repeat(64)}` });
        case "wrong-digest": return reply(res, 200, { ...answer, payload_digest: `sha256:${"0".repeat(64)}` });
        case "receipt-not-completed": return reply(res, 200, { ...answer, receipt: { ...answer.receipt, status: "failed" } });
        case "wrong-session": return reply(res, 200, { ...answer, receipt: { ...answer.receipt, session_id: "other" } });
        case "wrong-lineage": return reply(res, 200, { ...answer, receipt: { ...answer.receipt, lineage_root_digest: `sha256:${"b".repeat(64)}` } });
        case "accepted-not-200": return reply(res, 202, answer);
        // Not the amendment-1 shape, or not a code it names: never a terminal refusal.
        case "unknown-shape-409": return reply(res, 409, { code: "daemon_notice_payload_mismatch", detail: "x" });
        case "unknown-shape-401": return reply(res, 401, { detail: "daemon_notice_signature_invalid" });
        case "unknown-code-409": return reply(res, 409, { error: "something_else", detail: "x" });
        default: return reply(res, 500, {});
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected a TCP listener");
  return {
    posts,
    turns,
    port: address.port,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
};
type FakeGateway = Awaited<ReturnType<typeof fakeGateway>>;

/** The pin's ports, read through the fake Gateway's port. */
const targetPorts = (gateway: FakeGateway) => ({
  processStartToken: () => TOKEN,
  processStartedAt: () => LSTART,
  identityReader: ((options) => createHermesGatewayIdentityReader({ ...options, port: gateway.port })) as
    typeof createHermesGatewayIdentityReader,
  noticeSenderFactory: ((options) =>
    createHermesGatewayDaemonNoticeSender({ ...options, port: gateway.port, timeoutMs: 300 })) as
    typeof createHermesGatewayDaemonNoticeSender,
});
/** The real pinned CEO authority, read through the fake Gateway's port. */
const noticeTarget = (h: Harness, gateway: FakeGateway): DaemonNoticeTargetResolver =>
  createConfiguredHermesGatewayDaemonNoticeTarget(h.cp, config(), targetPorts(gateway))!;

const harnesses: Harness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) {
    try { h.cp.close(); } catch { /* already closed by a restart */ }
  }
});

/**
 * The adopted Hermes CEO, a PRIMARY_CTO holding one queued CEO peer message, and the real revoke with
 * no successor: the outbox rejects the row and owes the CEO a notice.
 */
const refusedWithNoSuccessor = async () => {
  const fixture = adoptedFixture();
  const { h } = fixture;
  harnesses.push(h);
  const { projectId } = await registerFixtureProject(h);
  const ctoRoleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId });
  const cto = h.cp.sessions.create({ provider: "scripted", model: "cto" });
  expect(h.cp.sessions.transition(cto.sessionId, SessionLifecycle.READY, "test").reasonCode).toBe(ReasonCode.OK);
  const bound = h.cp.bindings.bind({ role: Role.PRIMARY_CTO, sessionId: cto.sessionId, projectId });
  if (!bound.allowed) throw new Error(`CTO binding failed: ${bound.message}`);
  const nonce = "buzz-message:event-refused";
  const admitted = { text: CEO_WORDS, mention: "npub-cto" };
  h.cp.db.run(
    `INSERT INTO inbound_messages (channel, nonce, actor, received_at, payload_json) VALUES ('buzz', ?, 'npub-ceo', ?, ?)`,
    [nonce, h.clock.nowIso(), JSON.stringify(admitted)],
  );
  const queued = h.cp.outbox.enqueue({
    idempotencyKey: `peer-message:${nonce}`,
    roleKey: ctoRoleKey,
    bindingGeneration: h.cp.bindings.active(ctoRoleKey)!.bindingGeneration,
    targetSessionId: cto.sessionId,
    runId: null,
    kind: MessageKind.PEER_MESSAGE,
    payload: { sourceChannel: "buzz", sourceNonce: nonce, sourcePayloadDigest: digestOf(admitted) },
  });
  if (!queued.allowed) throw new Error(`enqueue failed: ${queued.message}`);
  expect(h.cp.bindings.revoke(ctoRoleKey, "the CTO is gone").reasonCode).toBe(ReasonCode.OK);
  expect(h.cp.bindings.active(ctoRoleKey)).toBeNull();
  const owed = h.cp.db.all<{ message_id: string; role_key: string; reason: string }>(
    `SELECT message_id, role_key, reason FROM peer_message_refusal_notices WHERE entry = 'OWED'`,
  );
  expect(owed).toEqual([{ message_id: queued.value.messageId, role_key: ctoRoleKey, reason: "REVOKED" }]);
  const eventId = daemonNoticeEventId(queued.value.messageId, ctoRoleKey, "REVOKED");
  return { fixture, h, projectId, ctoRoleKey, messageId: queued.value.messageId, eventId };
};

/** A successor CTO bound after the revoke: the role's next exact holder, through the real hand-over. */
const successorHolder = (h: Harness, projectId: string, ctoRoleKey: string): HolderIdentity => {
  const session = h.cp.sessions.create({ provider: "scripted", model: "cto-next" });
  expect(h.cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "test").reasonCode).toBe(ReasonCode.OK);
  const bound = h.cp.bindings.bind({ role: Role.PRIMARY_CTO, sessionId: session.sessionId, projectId });
  if (!bound.allowed) throw new Error(`successor binding failed: ${bound.message}`);
  return {
    roleKey: ctoRoleKey,
    bindingGeneration: h.cp.bindings.active(ctoRoleKey)!.bindingGeneration,
    targetSessionId: session.sessionId,
    sessionIncarnation: h.cp.sessions.require(session.sessionId).incarnation,
  };
};
/** The notice ids the holder's claim shows it under `refusedAtRestart`. */
const shownTo = (h: Harness, holder: HolderIdentity): string[] => {
  const taken = ownerMessageLedger(h.cp).claim(holder);
  expect(taken.allowed, JSON.stringify(taken)).toBe(true);
  const value = (taken.allowed ? taken.value : {}) as { refusedAtRestart?: Array<{ messageId: string }> };
  return (value.refusedAtRestart ?? []).map((notice) => notice.messageId);
};
const reported = (h: Harness, messageId: string): boolean =>
  h.cp.db.get(`SELECT 1 AS present FROM peer_message_refusal_notices WHERE message_id = ? AND entry = 'REPORTED'`,
    [messageId]) !== undefined;

const deliveries = (h: Harness) =>
  h.cp.db.all<{ event_id: string; entry: string; payload_digest: string; receipt_id: string | null; failure: string | null; diagnostics_json: string | null }>(
    `SELECT event_id, entry, payload_digest, receipt_id, failure, diagnostics_json FROM peer_message_notice_deliveries
      ORDER BY event_id, entry`,
  );
const settledCount = (h: Harness): number =>
  h.cp.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM peer_message_notice_deliveries WHERE entry = 'SETTLED'`)!.n;
const pass = (h: Harness, gateway: FakeGateway) => deliverOwedPeerMessageNotices(h.cp.outbox, noticeTarget(h, gateway), IKM);

describe("acp-daemon-notice/v1: the daemon tells the CEO of a refused peer message with no successor CTO", () => {
  it("revoke with no successor → OWED → the daemon's loop → exactly one POST → a valid 200 settles", async () => {
    const { h, messageId, eventId } = await refusedWithNoSuccessor();
    const gateway = await fakeGateway(["ok"]);
    try {
      const loop = startDaemonPeerMessageNoticeDelivery(h.cp, noticeTarget(h, gateway), IKM, { intervalMs: 3_600_000 });
      const report = await loop.tick();
      loop.close();
      expect(report).toEqual({ settled: [eventId], inDoubt: [], failed: [], waiting: [] });
      expect(gateway.posts).toHaveLength(1);
      const [post] = gateway.posts;
      expect(post!.check).toBe("valid");
      // The contract's body, and nothing the conversation turn sends.
      expect(Object.keys(JSON.parse(post!.raw) as object).sort()).toEqual(
        ["binding", "destination", "event_id", "payload_digest", "principal", "protocol", "signature", "text"],
      );
      expect(post!.body).toMatchObject({
        protocol: "acp-daemon-notice/v1", principal: "acp-daemon", binding: "acp-canonical-ceo",
        event_id: eventId, destination: PINNED,
      });
      expect(gateway.turns.size).toBe(1);
      expect(deliveries(h)).toEqual([
        expect.objectContaining({ event_id: eventId, entry: "IN_DOUBT", payload_digest: post!.body.payload_digest }),
        expect.objectContaining({ event_id: eventId, entry: "SETTLED", receipt_id: "hermes-notice:1" }),
      ]);
      // Settled is settled: the next pass sends nothing.
      expect(await pass(h, gateway)).toEqual({ settled: [], inDoubt: [], failed: [], waiting: [] });
      expect(gateway.posts).toHaveLength(1);
      expect(h.cp.db.get(`SELECT 1 AS owed FROM peer_message_refusal_notices WHERE message_id = ?`, [messageId]))
        .toEqual({ owed: 1 });
    } finally {
      await gateway.close();
    }
  });

  it("the notice text is metadata only: the refused message's words appear nowhere", async () => {
    const { h, messageId } = await refusedWithNoSuccessor();
    const gateway = await fakeGateway(["ok"]);
    try {
      await pass(h, gateway);
      const [post] = gateway.posts;
      expect(post!.raw).not.toContain(CEO_WORDS);
      expect(post!.raw).not.toContain("ship the release");
      expect(post!.body.text).toMatch(new RegExp(
        `^ACP refused a queued peer message addressed to the CTO; it was not delivered\\. message_id=${messageId} ` +
        "source_event_id=event-refused signer=npub-ceo reason=REVOKED at=\\S+$",
      ));
      const stored = h.cp.db.get<{ canonical_json: string }>(
        `SELECT canonical_json FROM peer_message_notice_deliveries WHERE entry = 'IN_DOUBT'`,
      )!;
      expect(stored.canonical_json).not.toContain(CEO_WORDS);
    } finally {
      await gateway.close();
    }
  });

  it.each([
    ["a 409 canonical_event_uncertain", "uncertain"],
    ["a timeout", "hang"],
    ["a connection lost after the Gateway admitted the turn", "drop"],
  ] as const)("%s, then a retry with the same id and bytes, settles exactly once", async (_label, first) => {
    const { h, eventId } = await refusedWithNoSuccessor();
    const gateway = await fakeGateway([first, "ok"]);
    try {
      expect(await pass(h, gateway)).toEqual({ settled: [], inDoubt: [eventId], failed: [], waiting: [] });
      expect(deliveries(h).map((row) => row.entry)).toEqual(["IN_DOUBT"]);
      expect(await pass(h, gateway)).toEqual({ settled: [eventId], inDoubt: [], failed: [], waiting: [] });
      expect(gateway.posts).toHaveLength(2);
      // The retry is the same notice: same id, digest and signature, byte for byte.
      expect(gateway.posts[1]!.raw).toBe(gateway.posts[0]!.raw);
      expect(gateway.turns.size).toBe(1);
      expect(settledCount(h)).toBe(1);
      expect(await pass(h, gateway)).toEqual({ settled: [], inDoubt: [], failed: [], waiting: [] });
      expect(settledCount(h)).toBe(1);
    } finally {
      await gateway.close();
    }
  });

  it("a restart between the lost answer and the retry re-derives the same id and settles exactly once", async () => {
    const first = await refusedWithNoSuccessor();
    const gateway = await fakeGateway(["drop", "ok"]);
    try {
      expect((await pass(first.h, gateway)).inDoubt).toEqual([first.eventId]);
      // The daemon's database connection closes; a new control plane opens the same file.
      const { root, repoPath, clock } = first.h;
      first.h.cp.close();
      const restarted = makeHarness({ root, repoPath, clock });
      harnesses.push(restarted);
      const loop = startDaemonPeerMessageNoticeDelivery(restarted.cp, noticeTarget(restarted, gateway), IKM, {
        intervalMs: 3_600_000,
      });
      expect(await loop.tick()).toEqual({ settled: [first.eventId], inDoubt: [], failed: [], waiting: [] });
      loop.close();
      expect(gateway.posts).toHaveLength(2);
      expect(gateway.posts[1]!.raw).toBe(gateway.posts[0]!.raw);
      expect(gateway.turns.size).toBe(1);
      expect(settledCount(restarted)).toBe(1);
    } finally {
      await gateway.close();
    }
  });

  it.each([
    ["the event id", "wrong-event", "event_id"],
    ["the payload digest", "wrong-digest", "payload_digest"],
    ["a receipt that is not completed", "receipt-not-completed", "receipt.status"],
    ["the receipt's session", "wrong-session", "receipt.session_id"],
    ["the receipt's lineage", "wrong-lineage", "receipt.lineage_root_digest"],
  ] as const)("a 200 with a mismatched %s never settles; it is recorded and the doctor shows it", async (_label, step, field) => {
    const { h, eventId } = await refusedWithNoSuccessor();
    const gateway = await fakeGateway([step, "ok"]);
    try {
      expect(await pass(h, gateway)).toEqual({ settled: [], inDoubt: [], failed: [eventId], waiting: [] });
      expect(settledCount(h)).toBe(0);
      const failed = deliveries(h).find((row) => row.entry === "FAILED")!;
      expect(failed).toMatchObject({ failure: "RESPONSE_MISMATCH" });
      expect(JSON.parse(failed.diagnostics_json!)).toMatchObject({ status: 200, mismatches: [field] });
      // Terminal: a later pass sends nothing more, even with a Gateway that would answer properly.
      expect(await pass(h, gateway)).toEqual({ settled: [], inDoubt: [], failed: [], waiting: [] });
      expect(gateway.posts).toHaveLength(1);
      const report = await h.cp.doctor.run("system");
      expect(report.findings.find((finding) => finding.code === "PEER_MESSAGE_NOTICE_DELIVERY_FAILED"))
        .toMatchObject({ observedEvidence: { count: 1, notices: [expect.objectContaining({ eventId, failure: "RESPONSE_MISMATCH" })] } });
    } finally {
      await gateway.close();
    }
  });

  it("an answer that is not a 200 never settles, even one carrying every matching field", async () => {
    const { h, eventId } = await refusedWithNoSuccessor();
    const gateway = await fakeGateway(["accepted-not-200"]);
    try {
      expect(await pass(h, gateway)).toEqual({ settled: [], inDoubt: [eventId], failed: [], waiting: [] });
      expect(settledCount(h)).toBe(0);
    } finally {
      await gateway.close();
    }
  });

  it.each([
    ["a signature Hermes cannot verify (401)", { ikm: "a different lane secret" }, ["ok"], 401, "daemon_notice_signature_invalid"],
    ["a destination mismatch (409)", {}, ["destination-mismatch"], 409, "daemon_notice_destination_mismatch"],
    ["a payload mismatch on a seen id (409)", {}, ["payload-mismatch"], 409, "daemon_notice_payload_mismatch"],
  ] as const)("%s is terminal: recorded, shown by the doctor, never retried under a new id", async (_label, options, script, status, code) => {
    const { h, eventId } = await refusedWithNoSuccessor();
    const gateway = await fakeGateway([...script], options);
    try {
      expect(await pass(h, gateway)).toEqual({ settled: [], inDoubt: [], failed: [eventId], waiting: [] });
      expect(deliveries(h).find((row) => row.entry === "FAILED")).toMatchObject({ failure: "HERMES_REFUSED" });
      expect(JSON.parse(deliveries(h).find((row) => row.entry === "FAILED")!.diagnostics_json!)).toEqual({ status, code });
      expect(await pass(h, gateway)).toEqual({ settled: [], inDoubt: [], failed: [], waiting: [] });
      expect(gateway.posts.map((post) => post.body.event_id)).toEqual([eventId]);
    } finally {
      await gateway.close();
    }
  });

  it("bytes fixed for one CEO destination are never redirected to another", async () => {
    const { h, eventId } = await refusedWithNoSuccessor();
    const gateway = await fakeGateway(["drop", "ok"]);
    try {
      expect((await pass(h, gateway)).inDoubt).toEqual([eventId]);
      // The pinned CEO moved since the bytes were fixed: the next pass sends nothing.
      const real = noticeTarget(h, gateway);
      const moved: DaemonNoticeTargetResolver = async () => {
        const target = await real();
        const destination: DaemonNoticeDestination = { ...target!.destination, session_id: "20261004_000000_moved" };
        return { ...target!, destination };
      };
      expect(await deliverOwedPeerMessageNotices(h.cp.outbox, moved, IKM))
        .toEqual({ settled: [], inDoubt: [], failed: [eventId], waiting: [] });
      expect(deliveries(h).find((row) => row.entry === "FAILED")).toMatchObject({ failure: "DESTINATION_MOVED" });
      expect(gateway.posts).toHaveLength(1);
    } finally {
      await gateway.close();
    }
  });

  it("with no pinned CEO target nothing is written and nothing is sent; the notice waits", async () => {
    const { h, eventId } = await refusedWithNoSuccessor();
    expect(await deliverOwedPeerMessageNotices(h.cp.outbox, async () => null, IKM))
      .toEqual({ settled: [], inDoubt: [], failed: [], waiting: [eventId] });
    expect(deliveries(h)).toEqual([]);
  });

  it("the delivery record refuses ordinary SQL: no forged settlement, no rewrite, no delete", async () => {
    const { h, eventId, messageId, ctoRoleKey } = await refusedWithNoSuccessor();
    const gateway = await fakeGateway(["drop"]);
    try {
      await pass(h, gateway);
      const [inDoubt] = deliveries(h);
      expect(() => h.cp.db.run(
        `INSERT INTO peer_message_notice_deliveries (event_id, entry, message_id, role_key, reason, payload_digest,
           receipt_id, created_at) VALUES (?, 'SETTLED', ?, ?, 'REVOKED', ?, 'forged', ?)`,
        [eventId, messageId, ctoRoleKey, inDoubt!.payload_digest, h.clock.nowIso()],
      )).toThrow(/PEER_MESSAGE_NOTICE_DELIVERY_AUTHORITY_DENIED/);
      expect(() => h.cp.db.run(
        `UPDATE peer_message_notice_deliveries SET payload_digest = 'x' WHERE event_id = ?`, [eventId],
      )).toThrow(/PEER_MESSAGE_NOTICE_DELIVERY_IMMUTABLE/);
      expect(() => h.cp.db.run(`DELETE FROM peer_message_notice_deliveries WHERE event_id = ?`, [eventId]))
        .toThrow(/PEER_MESSAGE_NOTICE_DELIVERY_IMMUTABLE/);
      expect(deliveries(h)).toEqual([inDoubt]);
    } finally {
      await gateway.close();
    }
  });
});

describe("acp-daemon-notice/v1 amendment 1: one channel per notice", () => {
  it("the daemon sends nothing for a notice a holder already took on itself (REPORTED)", async () => {
    const { h, projectId, ctoRoleKey, messageId } = await refusedWithNoSuccessor();
    const gateway = await fakeGateway(["ok"]);
    try {
      const holder = successorHolder(h, projectId, ctoRoleKey);
      expect(shownTo(h, holder)).toEqual([messageId]);
      expect(ownerMessageLedger(h.cp).reportRefusal(messageId, holder).reasonCode).toBe(ReasonCode.OK);
      expect(await pass(h, gateway)).toEqual({ settled: [], inDoubt: [], failed: [], waiting: [] });
      expect(gateway.posts).toEqual([]);
      expect(deliveries(h)).toEqual([]);
    } finally {
      await gateway.close();
    }
  });

  it("a holder is not shown, and may not report, a notice the daemon has in doubt or settled", async () => {
    const { h, projectId, ctoRoleKey, messageId } = await refusedWithNoSuccessor();
    const gateway = await fakeGateway(["drop", "ok"]);
    try {
      await pass(h, gateway);
      const holder = successorHolder(h, projectId, ctoRoleKey);
      expect(shownTo(h, holder)).toEqual([]);
      expect(ownerMessageLedger(h.cp).reportRefusal(messageId, holder).reasonCode).toBe(ReasonCode.CONFLICT);
      await pass(h, gateway);
      expect(settledCount(h)).toBe(1);
      expect(shownTo(h, holder)).toEqual([]);
      expect(ownerMessageLedger(h.cp).reportRefusal(messageId, holder).reasonCode).toBe(ReasonCode.CONFLICT);
      expect(reported(h, messageId)).toBe(false);
    } finally {
      await gateway.close();
    }
  });

  it("a notice the daemon terminally failed is the holder's again: shown, and reportable", async () => {
    const { h, projectId, ctoRoleKey, messageId, eventId } = await refusedWithNoSuccessor();
    const gateway = await fakeGateway(["wrong-digest"]);
    try {
      expect((await pass(h, gateway)).failed).toEqual([eventId]);
      const holder = successorHolder(h, projectId, ctoRoleKey);
      expect(shownTo(h, holder)).toEqual([messageId]);
      expect(ownerMessageLedger(h.cp).reportRefusal(messageId, holder).reasonCode).toBe(ReasonCode.OK);
      expect(reported(h, messageId)).toBe(true);
    } finally {
      await gateway.close();
    }
  });

  /**
   * The race both orders of which are decided by one transaction each: the holder was shown the notice
   * before the daemon began, then the two claims meet. The report is the holder taking the telling on
   * itself before it speaks (its tool says so), and the daemon's IN_DOUBT entry is the daemon taking
   * it on itself before its POST; each is written in BEGIN IMMEDIATE after checking for the other, so
   * exactly one lands and exactly one channel tells the CEO.
   */
  it("race: shown to a holder, then the daemon goes in doubt — the holder's report is refused, the daemon alone settles", async () => {
    const { h, projectId, ctoRoleKey, messageId, eventId } = await refusedWithNoSuccessor();
    const gateway = await fakeGateway(["drop", "ok"]);
    try {
      const holder = successorHolder(h, projectId, ctoRoleKey);
      expect(shownTo(h, holder)).toEqual([messageId]);
      expect((await pass(h, gateway)).inDoubt).toEqual([eventId]);
      const report = ownerMessageLedger(h.cp).reportRefusal(messageId, holder);
      expect(report.reasonCode).toBe(ReasonCode.CONFLICT);
      expect(JSON.stringify(report)).toMatch(/do not tell the CEO/);
      expect((await pass(h, gateway)).settled).toEqual([eventId]);
      expect(reported(h, messageId)).toBe(false);
      expect(settledCount(h)).toBe(1);
      expect(gateway.turns.size).toBe(1);
    } finally {
      await gateway.close();
    }
  });

  it("race: shown to a holder that reports first — the daemon starts nothing, even inside its own transaction", async () => {
    const { h, projectId, ctoRoleKey, messageId, eventId } = await refusedWithNoSuccessor();
    const gateway = await fakeGateway(["ok"]);
    try {
      const holder = successorHolder(h, projectId, ctoRoleKey);
      expect(shownTo(h, holder)).toEqual([messageId]);
      expect(ownerMessageLedger(h.cp).reportRefusal(messageId, holder).reasonCode).toBe(ReasonCode.OK);
      // The consumer's read is outside the write; the IN_DOUBT write itself still refuses.
      expect(h.cp.outbox.recordPeerMessageNoticeInDoubt({
        eventId, messageId, roleKey: ctoRoleKey, reason: "REVOKED", payloadDigest: `sha256:${"0".repeat(64)}`,
        canonicalJson: "{}",
      })).toBeNull();
      expect(await pass(h, gateway)).toEqual({ settled: [], inDoubt: [], failed: [], waiting: [] });
      expect(gateway.posts).toEqual([]);
      expect(deliveries(h)).toEqual([]);
    } finally {
      await gateway.close();
    }
  });
});

describe("acp-daemon-notice/v1 amendment 1: only the `error` field decides a refusal", () => {
  it.each([
    ["a 409 whose code is in another field", "unknown-shape-409"],
    ["a 401 with no `error` field", "unknown-shape-401"],
    ["a 409 whose `error` the contract does not name", "unknown-code-409"],
  ] as const)("%s stays in doubt and is not terminal", async (_label, step) => {
    const { h, eventId } = await refusedWithNoSuccessor();
    const gateway = await fakeGateway([step, "ok"]);
    try {
      expect(await pass(h, gateway)).toEqual({ settled: [], inDoubt: [eventId], failed: [], waiting: [] });
      expect(deliveries(h).map((row) => row.entry)).toEqual(["IN_DOUBT"]);
      expect(await pass(h, gateway)).toEqual({ settled: [eventId], inDoubt: [], failed: [], waiting: [] });
    } finally {
      await gateway.close();
    }
  });
});

describe("acp-daemon-notice/v1 amendment 1: rollout flag and live probe", () => {
  const start = (h: Harness, gateway: FakeGateway, environment: Record<string, string>) =>
    startConfiguredPeerMessageNoticeDelivery(h.cp, {
      environment, hermesConfiguration: config(), laneSecret: IKM, ports: targetPorts(gateway), intervalMs: 3_600_000,
    });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

  it.each([
    ["absent", {}],
    ["not exactly 1", { ACP_DAEMON_NOTICE_ENABLED: "true" }],
    ["absent, with a probe asked for", { ACP_DAEMON_NOTICE_PROBE: "probe-nonce-0000000000000001" }],
  ] as const)("with the flag %s nothing starts and nothing is sent", async (_label, environment) => {
    const { h } = await refusedWithNoSuccessor();
    const gateway = await fakeGateway(["ok"]);
    try {
      const started = start(h, gateway, { ...environment });
      expect(started).toEqual({ delivery: null, notStarted: "ACP_DAEMON_NOTICE_ENABLED is not 1", probe: null });
      await settle();
      expect(gateway.posts).toEqual([]);
      expect(deliveries(h)).toEqual([]);
    } finally {
      await gateway.close();
    }
  });

  it("with ACP_DAEMON_NOTICE_ENABLED=1 the delivery starts and tells the CEO", async () => {
    const { h, eventId } = await refusedWithNoSuccessor();
    const gateway = await fakeGateway(["ok"]);
    try {
      const started = start(h, gateway, { ACP_DAEMON_NOTICE_ENABLED: "1" });
      expect(started.notStarted).toBeNull();
      expect(await started.delivery!.tick()).toEqual({ settled: [eventId], inDoubt: [], failed: [], waiting: [] });
      started.delivery!.close();
      expect(gateway.posts).toHaveLength(1);
    } finally {
      await gateway.close();
    }
  });

  it("the probe settles, its one resend returns the same receipt with no second turn, and it touches no real notice", async () => {
    const { h, eventId: noticeEventId, messageId } = await refusedWithNoSuccessor();
    const gateway = await fakeGateway(["ok"]);
    const nonce = "probe-nonce-0000000000000001";
    const probeId = daemonNoticeProbeEventId(nonce);
    try {
      const started = start(h, gateway, { ACP_DAEMON_NOTICE_ENABLED: "1", ACP_DAEMON_NOTICE_PROBE: nonce });
      const probe = await started.probe!;
      expect(probe).toMatchObject({
        sent: true, eventId: probeId, first: { outcome: "SETTLED", receiptId: "hermes-notice:1" },
        resend: { outcome: "SETTLED", receiptId: "hermes-notice:1" }, sameReceipt: true,
      });
      const probePosts = gateway.posts.filter((post) => post.body.event_id === probeId);
      expect(probePosts).toHaveLength(2);
      expect(probePosts[1]!.raw).toBe(probePosts[0]!.raw);
      expect(probePosts[0]!.body.text).toBe(`ACP daemon notice probe ${nonce} (synthetic, no action needed)`);
      expect(gateway.turns.has(probeId)).toBe(true);
      const probeRows = h.cp.db.all<Record<string, unknown>>(
        `SELECT entry, kind, message_id, role_key, reason, receipt_id FROM peer_message_notice_deliveries
          WHERE event_id = ? ORDER BY entry`, [probeId],
      );
      expect(probeRows).toEqual([
        { entry: "IN_DOUBT", kind: "PROBE", message_id: null, role_key: null, reason: null, receipt_id: null },
        { entry: "RESENT", kind: "PROBE", message_id: null, role_key: null, reason: null, receipt_id: "hermes-notice:1" },
        { entry: "SETTLED", kind: "PROBE", message_id: null, role_key: null, reason: null, receipt_id: "hermes-notice:1" },
      ]);
      // The real notice is its own delivery, after the probe, under its own id.
      expect(await started.delivery!.tick()).toEqual({ settled: [noticeEventId], inDoubt: [], failed: [], waiting: [] });
      started.delivery!.close();
      expect(gateway.posts.filter((post) => post.body.event_id === noticeEventId)).toHaveLength(1);
      expect(gateway.turns.size).toBe(2);
      expect(h.cp.db.get(`SELECT 1 AS owed FROM peer_message_refusal_notices WHERE message_id = ? AND entry = 'OWED'`,
        [messageId])).toEqual({ owed: 1 });

      // The same nonce again — a restart that kept the variable — sends nothing.
      const again = start(h, gateway, { ACP_DAEMON_NOTICE_ENABLED: "1", ACP_DAEMON_NOTICE_PROBE: nonce });
      expect(await again.probe!).toEqual({ sent: false, reason: "ALREADY_RECORDED", eventId: probeId });
      again.delivery!.close();
      await settle();
      expect(gateway.posts.filter((post) => post.body.event_id === probeId)).toHaveLength(2);
    } finally {
      await gateway.close();
    }
  });

  it("a probe nonce outside 16–64 characters of [A-Za-z0-9-] sends nothing", async () => {
    const { h } = await refusedWithNoSuccessor();
    const gateway = await fakeGateway(["ok"]);
    try {
      for (const nonce of ["short", "has a space in it 0000", "x".repeat(65)]) {
        const started = start(h, gateway, { ACP_DAEMON_NOTICE_ENABLED: "1", ACP_DAEMON_NOTICE_PROBE: nonce });
        expect(await started.probe!).toEqual({ sent: false, reason: "INVALID_NONCE", eventId: null });
        started.delivery!.close();
      }
      await settle();
      expect(gateway.posts.filter((post) => post.body.event_id.startsWith("acp-notice-probe:"))).toEqual([]);
    } finally {
      await gateway.close();
    }
  });
});
