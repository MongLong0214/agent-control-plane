import { createServer, type Server } from "node:http";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, describe, expect, it, vi } from "vitest";

import { allow, deny } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { createCeoNotificationSender } from "../../src/daemon/agentcpd.ts";
import { Role, roleKeyFor } from "../../src/domain/types.ts";
import { IngressGuard } from "../../src/ingress/ingress-guard.ts";
import { TelegramExternalUpdateLane } from "../../src/ingress/telegram-external.ts";
import { TelegramIngress, type TelegramUpdate } from "../../src/ingress/telegram.ts";
import { HERMES_PROVENANCE_META_KEY, type HermesAdmittedTurn } from "../../src/mcp/hermes-provenance.ts";
import { createHermesMcpPort, createHermesServer } from "../../src/mcp/hermes-server.ts";
import type { AuthenticatedMcpPeer } from "../../src/mcp/shared.ts";
import { MessageKind } from "../../src/outbox/envelope.ts";
import type { OutboxMessage } from "../../src/outbox/outbox.ts";
import {
  daemonNoticeCanonical, daemonNoticeKey, daemonNoticeSignature, type DaemonNoticeBody,
} from "../../src/runtime/acp-daemon-notice.ts";
import { createHermesGatewayDaemonNoticeSender } from "../../src/runtime/hermes-gateway-conversation.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { approveReviewedCandidateForFinalization, driveToReviewedCandidate, makeHarness } from "../helpers/harness.ts";
import { envelope, externalLaneFixture, HEAD, LINEAGE, replaceHermesCeo, SECRET } from "../helpers/telegram-external.ts";

/**
 * U6 B1 — a CTO result reaches the owner as a reply to the original `/acp` message only through an
 * origin ACP itself recorded: the owner's `run_dispatch` made in the exact Telegram turn its call names,
 * carried in the signed CEO notification, sent only on the Gateway's daemon-notice route, and dropped,
 * recorded undelivered, once it is no longer that turn's.
 */
afterAll(cleanupTempDirs);

const OWNER_TURN: HermesAdmittedTurn = { principal: "owner", peerGrant: null };
const PEER_TURN: HermesAdmittedTurn = { principal: "peer", peerGrant: `sha256:${"e".repeat(64)}` };

type Fixture = ReturnType<typeof externalLaneFixture>;

const ceoPeer = (fixture: Fixture) => {
  const ceo = fixture.cp.bindings.active(roleKeyFor(Role.CEO))!;
  return { actor: "hermes-ceo", sessionId: ceo.sessionId, sessionIncarnation: ceo.sessionIncarnation };
};

const claimOneTurn = async (fixture: Fixture, updateId: number): Promise<string> => {
  let turnRequestId = "";
  await new TelegramExternalUpdateLane(fixture.cp, fixture.laneConfig).handle(envelope(updateId, "/acp ship it"), (answer) => {
    if (answer.allowed) turnRequestId = answer.turn.turnRequestId;
  });
  expect(turnRequestId).not.toBe("");
  return turnRequestId;
};

/** What the Hermes MCP port hands `runs.dispatch` for one `run_dispatch` per caller, in order. */
const dispatchOptions = async (
  fixture: Fixture, calls: Array<[HermesAdmittedTurn | undefined, AuthenticatedMcpPeer, string?]>,
): Promise<unknown[]> => {
  const dispatch = vi.spyOn(fixture.cp.runs, "dispatch").mockResolvedValue(allow(ReasonCode.OK, {} as never));
  const port = createHermesMcpPort(fixture.cp);
  for (const [turn, peer, turnRequestId] of calls) await port.dispatchRun("run-u6-b1", turn, peer, turnRequestId);
  const options = dispatch.mock.calls.map(([, given]) => given);
  dispatch.mockRestore();
  return options;
};

describe("U6 B1 origin of a CEO dispatch", () => {
  it("is the exact owner turn the call names, in doubt on the CEO's own session, and nothing for any other caller, turn or principal", async () => {
    const fixture = externalLaneFixture();
    try {
      const peer = ceoPeer(fixture);
      expect(await dispatchOptions(fixture, [[OWNER_TURN, peer, "turn-u6-b1-none"]])).toEqual([{ hermesTurn: OWNER_TURN }]);

      const turnRequestId = await claimOneTurn(fixture, 41);
      expect(await dispatchOptions(fixture, [
        [OWNER_TURN, peer, turnRequestId],
        // The session has update 41's owner turn in doubt; none of these calls is that turn.
        [OWNER_TURN, peer],
        [OWNER_TURN, peer, "turn-u6-b1-another"],
        [PEER_TURN, peer, turnRequestId],
        [PEER_TURN, peer],
        [OWNER_TURN, { ...peer, sessionId: "ses-not-the-ceo" }, turnRequestId],
        [undefined, peer, turnRequestId],
      ])).toEqual([
        { hermesTurn: OWNER_TURN, originReply: { turnRequestId, updateId: "41" } },
        { hermesTurn: OWNER_TURN },
        { hermesTurn: OWNER_TURN },
        { hermesTurn: PEER_TURN },
        { hermesTurn: PEER_TURN },
        { hermesTurn: OWNER_TURN },
        {},
      ]);
    } finally {
      fixture.cp.close();
    }
  });

  it("is read from the turn_request_id of the admitted call's own provenance, for the owner's call only", async () => {
    const fixture = externalLaneFixture();
    const client = new Client({ name: "u6-b1-hermes-fixture", version: "1" });
    try {
      const turnRequestId = await claimOneTurn(fixture, 41);
      const peer = ceoPeer(fixture);
      const server = createHermesServer(createHermesMcpPort(fixture.cp), () => allow(ReasonCode.OK, peer),
        { provenance: { liveHermesSessionId: HEAD, lineageRootDigest: LINEAGE } });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const dispatch = vi.spyOn(fixture.cp.runs, "dispatch").mockResolvedValue(allow(ReasonCode.OK, {} as never));
      const turn = (overrides: Record<string, unknown>) => ({ [HERMES_PROVENANCE_META_KEY]: {
        session_id: HEAD, lineage_root_digest: LINEAGE, principal: "owner", cron: false, delegation_depth: 0,
        platform: "telegram", ...overrides } });
      let key = 0;
      for (const meta of [
        turn({ turn_request_id: turnRequestId }),
        turn({}),
        turn({ turn_request_id: "turn-u6-b1-another" }),
        turn({ principal: "peer", peer_grant: PEER_TURN.peerGrant, turn_request_id: turnRequestId }),
      ]) {
        await client.callTool({ name: "run_dispatch", arguments: { idempotencyKey: `u6-b1-${key++}`, runId: "run-u6-b1" }, _meta: meta });
      }
      expect(dispatch.mock.calls.map(([, given]) => given)).toEqual([
        { hermesTurn: OWNER_TURN, originReply: { turnRequestId, updateId: "41" } },
        { hermesTurn: OWNER_TURN },
        { hermesTurn: OWNER_TURN },
        { hermesTurn: PEER_TURN },
      ]);
    } finally {
      vi.restoreAllMocks();
      await client.close();
      fixture.cp.close();
    }
  });

  it("is nothing when the turn the call names answers several Telegram updates", async () => {
    const fixture = externalLaneFixture();
    try {
      const { cp, laneConfig } = fixture;
      const guard = new IngressGuard(cp.db, cp.clock, cp.audit, {
        telegram: { allowedActors: laneConfig.allowedOwnerIds, allowedConversations: laneConfig.allowedChatIds },
      });
      const ingress = new TelegramIngress(guard, { webhookSecret: laneConfig.sharedSecret });
      const sources = [51, 52].map((id) => {
        const update = (envelope(id, `/acp part ${id}`) as { update: TelegramUpdate }).update;
        const admitted = ingress.admit(update, SECRET);
        if (!admitted.allowed) throw new Error(admitted.message);
        return { channel: "telegram", nonce: admitted.value.nonce, attempt: 1, payload: ingress.admittedPayloadFor(update) };
      });
      const claimed = cp.conversation.claim({ targetActorId: fixture.ceoActorId!, prompt: "/acp part 51\n/acp part 52", sources });
      expect(claimed, JSON.stringify(claimed)).toMatchObject({ allowed: true });
      expect(cp.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM canonical_turn_sources")!.n).toBe(2);
      const turnRequestId = cp.db.get<{ id: string }>("SELECT turn_request_id AS id FROM canonical_turns")!.id;
      expect(await dispatchOptions(fixture, [[OWNER_TURN, ceoPeer(fixture), turnRequestId]])).toEqual([{ hermesTurn: OWNER_TURN }]);
    } finally {
      fixture.cp.close();
    }
  });
});

const ownerReplyUndelivered = (fixture: Fixture, messageId: string): unknown[] =>
  fixture.cp.db.all<{ evidence_json: string }>(`SELECT evidence_json FROM audit_events
    WHERE kind = 'CEO_NOTIFICATION_OWNER_REPLY_UNDELIVERED' AND json_extract(evidence_json, '$.messageId') = ?
    ORDER BY rowid`, [messageId])
    .map((row) => { const { reason, origin } = JSON.parse(row.evidence_json) as Record<string, unknown>; return { reason, origin }; });

const outboxRow = (fixture: Fixture, messageId: string) =>
  fixture.cp.db.get<{ status: string; reason_code: string | null; attempts: number }>(
    "SELECT status, reason_code, attempts FROM outbox WHERE message_id = ?", [messageId])!;

const enqueueNotice = (fixture: Fixture, key: string, payload: Record<string, unknown>): string => {
  const ceo = fixture.cp.bindings.active(roleKeyFor(Role.CEO))!;
  const enqueued = fixture.cp.outbox.enqueue({
    idempotencyKey: key, roleKey: ceo.roleKey, bindingGeneration: ceo.bindingGeneration, targetSessionId: ceo.sessionId,
    kind: MessageKind.CEO_NOTIFICATION, payload,
  });
  if (!enqueued.allowed) throw new Error(enqueued.message);
  return enqueued.value.messageId;
};

describe("U6 B1 CEO notification origin", () => {
  it("rides from the run's dispatch into the READY_FOR_CEO_REVIEW payload", async () => {
    const harness = makeHarness();
    try {
      const origin = { turnRequestId: "turn-u6-b1", updateId: "901" };
      const dispatch = harness.cp.runs.dispatch.bind(harness.cp.runs);
      vi.spyOn(harness.cp.runs, "dispatch").mockImplementation((runId, options) => dispatch(runId, { ...options, originReply: origin }));
      const driven = await driveToReviewedCandidate(harness);
      vi.restoreAllMocks();
      expect(harness.cp.audit.forRun(driven.runId).filter((e) => e.kind === "DISPATCHED").at(-1)?.evidence["originReply"])
        .toEqual(origin);
      await approveReviewedCandidateForFinalization(harness, driven, { bypassCeoConfirmation: true });
      const notice = harness.cp.db.get<{ payload_json: string }>(
        "SELECT payload_json FROM outbox WHERE kind = 'CEO_NOTIFICATION' AND run_id = ?", [driven.runId])!;
      expect(JSON.parse(notice.payload_json)).toMatchObject({
        notification: "READY_FOR_CEO_REVIEW", origin: { turn_request_id: "turn-u6-b1", update_id: "901" },
      });
    } finally {
      vi.restoreAllMocks();
      harness.cp.close();
    }
  });

  it("is sent while the CEO is the turn's own generation; once the CEO changed it is dropped and the owner's reply recorded undelivered", async () => {
    const fixture = externalLaneFixture();
    try {
      const { cp } = fixture;
      const turnRequestId = await claimOneTurn(fixture, 41);
      const sent: unknown[] = [];
      // While held, the transport answers that no target is up: the notice stays PENDING, unattempted.
      let held = false;
      cp.outbox.attachCeoNotificationDelivery(async (message) => {
        if (held) return deny(ReasonCode.CEO_CONVERSATION_UNAVAILABLE, "fixture: no target yet");
        sent.push(message.payload);
        return allow(ReasonCode.OK, undefined);
      });
      const origin = { turn_request_id: turnRequestId, update_id: "41" };
      const current = enqueueNotice(fixture, "u6-b1-current", { notification: "READY_FOR_CEO_REVIEW", origin });
      await cp.outbox.deliverCeoNotifications();
      expect(sent).toEqual([{ notification: "READY_FOR_CEO_REVIEW", origin }]);
      expect(ownerReplyUndelivered(fixture, current)).toEqual([]);
      expect(outboxRow(fixture, current)).toMatchObject({ status: "ACKED", reason_code: null });

      // Enqueued for the turn's generation, then the CEO is replaced: the notice follows the new holder
      // without its origin, and neither the row nor the audit lets its ACK read as the owner's reply.
      held = true;
      const stale = enqueueNotice(fixture, "u6-b1-stale", { notification: "READY_FOR_CEO_REVIEW", origin });
      await cp.outbox.deliverCeoNotifications();
      replaceHermesCeo(cp, 1);
      held = false;
      await cp.outbox.deliverCeoNotifications();
      expect(sent.slice(1)).toEqual([{ notification: "READY_FOR_CEO_REVIEW" }]);
      // The readdress's own mark stays on the row; the audit names the origin no longer current.
      expect(outboxRow(fixture, stale)).toMatchObject({ status: "ACKED", reason_code: "OUTBOX_RETARGETED" });
      expect(ownerReplyUndelivered(fixture, stale)).toEqual([{ reason: "ORIGIN_NOT_CURRENT", origin }]);
    } finally {
      fixture.cp.close();
    }
  });

  it("naming a turn that does not exist, or another update than its turn answered, is never stripped silently", async () => {
    const fixture = externalLaneFixture();
    try {
      const { cp } = fixture;
      const turnRequestId = await claimOneTurn(fixture, 41);
      const sent: unknown[] = [];
      cp.outbox.attachCeoNotificationDelivery(async (message) => {
        sent.push(message.payload);
        return allow(ReasonCode.OK, undefined);
      });
      const nonexistent = { turn_request_id: "turn-u6-b1-nonexistent", update_id: "41" };
      const otherUpdate = { turn_request_id: turnRequestId, update_id: "42" };
      const first = enqueueNotice(fixture, "u6-b1-nonexistent", { notification: "READY_FOR_CEO_REVIEW", origin: nonexistent });
      const second = enqueueNotice(fixture, "u6-b1-other-update", { notification: "READY_FOR_CEO_REVIEW", origin: otherUpdate });
      await cp.outbox.deliverCeoNotifications();
      await cp.outbox.deliverCeoNotifications();

      expect(sent).toEqual([{ notification: "READY_FOR_CEO_REVIEW" }, { notification: "READY_FOR_CEO_REVIEW" }]);
      for (const [messageId, origin] of [[first, nonexistent], [second, otherUpdate]] as const) {
        expect(outboxRow(fixture, messageId)).toMatchObject({ status: "ACKED", reason_code: "ORIGIN_NOT_CURRENT" });
        expect(ownerReplyUndelivered(fixture, messageId)).toEqual([{ reason: "ORIGIN_NOT_CURRENT", origin }]);
      }
    } finally {
      fixture.cp.close();
    }
  });
});

const DESTINATION = {
  session_id: "20261115_000000_u6b1", lineage_root_digest: `sha256:${"c".repeat(64)}`,
  process_pid: 4242, process_started_at: "darwin-tv:1790000000.000001",
};

describe("U6 B1 daemon notice route", () => {
  const servers: Server[] = [];
  afterAll(async () => { await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve)))); });

  /**
   * A loopback Gateway that answers its identity and records the path of every POST. With `receipts`
   * it settles each notice the way Hermes does; without, every POST is refused.
   */
  const gateway = async (receipts = false): Promise<{ port: number; posts: string[] }> => {
    const posts: string[] = [];
    const server = createServer((req, res) => {
      res.setHeader("Content-Type", "application/json");
      if (req.method === "POST") posts.push(req.url ?? "");
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        if (req.method !== "POST") return res.end(JSON.stringify(DESTINATION));
        if (!receipts) return res.end(JSON.stringify({ error: "fixture" }));
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as DaemonNoticeBody;
        return res.end(JSON.stringify({ event_id: body.event_id, payload_digest: body.payload_digest, receipt: {
          status: "completed", session_id: DESTINATION.session_id, lineage_root_digest: DESTINATION.lineage_root_digest,
          receipt_id: `receipt-${body.event_id.slice(-12)}` } }));
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected a TCP listener");
    return { port: address.port, posts };
  };

  const notification = (payload: Record<string, unknown>): OutboxMessage => ({
    messageId: "msg-u6-b1", idempotencyKey: "u6-b1", roleKey: "CEO", bindingGeneration: 1, targetSessionId: "ses-ceo",
    runId: null, kind: MessageKind.CEO_NOTIFICATION, payload, payloadDigest: "", requestFingerprint: "",
    expiresAt: "2099-01-01T00:00:00.000Z", status: "PENDING", attempts: 0, failureClass: null, retryEligible: false,
    nextAttemptAt: null, createdAt: "2026-11-15T00:00:00.000Z",
  } as OutboxMessage);

  it("signs the origin into the notice and sends that notice to the daemon-notice route, any other to /events", async () => {
    const { port, posts } = await gateway();
    const send = createHermesGatewayDaemonNoticeSender({ apiKey: "u6-b1-fixture-key", port });
    const bodies: DaemonNoticeBody[] = [];
    const sender = createCeoNotificationSender(async () => ({
      destination: DESTINATION, send: async (body) => { bodies.push(body); return send(body); },
    }), "u6-b1 fixture lane secret");
    const origin = { turn_request_id: "turn-u6-b1", update_id: "901" };
    await sender(notification({ notification: "READY_FOR_CEO_REVIEW", runId: "run-1", origin }));
    await sender(notification({ notification: "READY_FOR_CEO_REVIEW", runId: "run-1" }));

    expect(posts).toEqual(["/v1/canonical-surface/daemon-notices", "/v1/canonical-surface/events"]);
    const signed = bodies[0]!;
    expect(signed.text).toContain(JSON.stringify(origin));
    const fields = (text: string) => ({ protocol: signed.protocol, principal: signed.principal, binding: signed.binding,
      event_id: signed.event_id, destination: signed.destination, text });
    const key = daemonNoticeKey("u6-b1 fixture lane secret");
    expect(daemonNoticeSignature(key, daemonNoticeCanonical(fields(signed.text)))).toBe(signed.signature);
    // The origin is inside the HMAC: naming another update is another signature.
    expect(daemonNoticeSignature(key, daemonNoticeCanonical(fields(signed.text.replace('"901"', '"902"')))))
      .not.toBe(signed.signature);
  });

  it("refuses, before any POST, a notice with a current origin that is split in parts, and records the owner's reply undelivered", async () => {
    const fixture = externalLaneFixture();
    try {
      const { cp } = fixture;
      const turnRequestId = await claimOneTurn(fixture, 41);
      const { port, posts } = await gateway(true);
      cp.outbox.attachCeoNotificationDelivery(createCeoNotificationSender(async () => ({
        destination: DESTINATION, send: createHermesGatewayDaemonNoticeSender({ apiKey: "u6-b1-fixture-key", port }),
      }), "u6-b1 fixture lane secret"));
      const origin = { turn_request_id: turnRequestId, update_id: "41" };
      const long = enqueueNotice(fixture, "u6-b1-long", { notification: "READY_FOR_CEO_REVIEW", goal: "g".repeat(1600), origin });
      await cp.outbox.deliverCeoNotifications();
      await cp.outbox.deliverCeoNotifications();

      // Neither /events nor a reported delivery: nothing was posted and the row is still undelivered.
      expect(posts).toEqual([]);
      expect(outboxRow(fixture, long)).toEqual({ status: "PENDING", reason_code: null, attempts: 0 });
      expect(ownerReplyUndelivered(fixture, long)).toEqual([{ reason: "ORIGIN_NOTICE_NOT_ONE_ROUTE", origin }]);
      expect(cp.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_events WHERE kind IN
        ('CEO_NOTIFICATION_ACCEPTED','CEO_NOTIFICATION_CANONICAL_ATTEMPT') AND json_extract(evidence_json, '$.messageId') = ?`,
      [long])!.n).toBe(0);

      // The same notice in one part takes the daemon-notice route and settles as before.
      const short = enqueueNotice(fixture, "u6-b1-short", { notification: "READY_FOR_CEO_REVIEW", origin });
      await cp.outbox.deliverCeoNotifications();
      expect(posts).toEqual(["/v1/canonical-surface/daemon-notices"]);
      expect(outboxRow(fixture, short)).toMatchObject({ status: "ACKED", reason_code: null });
      expect(ownerReplyUndelivered(fixture, short)).toEqual([]);
    } finally {
      fixture.cp.close();
    }
  });
});
