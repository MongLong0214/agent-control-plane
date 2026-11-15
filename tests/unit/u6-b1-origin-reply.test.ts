import { createServer, type Server } from "node:http";

import { afterAll, describe, expect, it, vi } from "vitest";

import { allow, deny } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { createCeoNotificationSender } from "../../src/daemon/agentcpd.ts";
import { Role, roleKeyFor } from "../../src/domain/types.ts";
import { IngressGuard } from "../../src/ingress/ingress-guard.ts";
import { TelegramExternalUpdateLane } from "../../src/ingress/telegram-external.ts";
import { TelegramIngress, type TelegramUpdate } from "../../src/ingress/telegram.ts";
import type { HermesAdmittedTurn } from "../../src/mcp/hermes-provenance.ts";
import { createHermesMcpPort } from "../../src/mcp/hermes-server.ts";
import type { AuthenticatedMcpPeer } from "../../src/mcp/shared.ts";
import { MessageKind } from "../../src/outbox/envelope.ts";
import type { OutboxMessage } from "../../src/outbox/outbox.ts";
import {
  daemonNoticeCanonical, daemonNoticeKey, daemonNoticeSignature, type DaemonNoticeBody,
} from "../../src/runtime/acp-daemon-notice.ts";
import { createHermesGatewayDaemonNoticeSender } from "../../src/runtime/hermes-gateway-conversation.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { approveReviewedCandidateForFinalization, driveToReviewedCandidate, makeHarness } from "../helpers/harness.ts";
import { envelope, externalLaneFixture, replaceHermesCeo, SECRET } from "../helpers/telegram-external.ts";

/**
 * U6 B1 — a CTO result reaches the owner as a reply to the original `/acp` message only through an
 * origin ACP itself recorded: the CEO's `run_dispatch` made in exactly one Telegram turn, carried in the
 * signed CEO notification, sent to the Gateway's daemon-notice route, and dropped once the CEO changed.
 */
afterAll(cleanupTempDirs);

const OWNER_TURN: HermesAdmittedTurn = { principal: "owner", peerGrant: null };

const ceoPeer = (fixture: ReturnType<typeof externalLaneFixture>) => {
  const ceo = fixture.cp.bindings.active(roleKeyFor(Role.CEO))!;
  return { actor: "hermes-ceo", sessionId: ceo.sessionId, sessionIncarnation: ceo.sessionIncarnation };
};

const claimOneTurn = async (fixture: ReturnType<typeof externalLaneFixture>, updateId: number): Promise<string> => {
  let turnRequestId = "";
  await new TelegramExternalUpdateLane(fixture.cp, fixture.laneConfig).handle(envelope(updateId, "/acp ship it"), (answer) => {
    if (answer.allowed) turnRequestId = answer.turn.turnRequestId;
  });
  expect(turnRequestId).not.toBe("");
  return turnRequestId;
};

/** What the Hermes MCP port hands `runs.dispatch` for one `run_dispatch` per caller, in order. */
const dispatchOptions = async (
  fixture: ReturnType<typeof externalLaneFixture>, calls: Array<[HermesAdmittedTurn | undefined, AuthenticatedMcpPeer]>,
): Promise<unknown[]> => {
  const dispatch = vi.spyOn(fixture.cp.runs, "dispatch").mockResolvedValue(allow(ReasonCode.OK, {} as never));
  const port = createHermesMcpPort(fixture.cp);
  for (const [turn, peer] of calls) await port.dispatchRun("run-u6-b1", turn, peer);
  const options = dispatch.mock.calls.map(([, given]) => given);
  dispatch.mockRestore();
  return options;
};

describe("U6 B1 origin of a CEO dispatch", () => {
  it("is the one Telegram turn the CEO's own session has in doubt, and nothing for none, another caller or no admitted turn", async () => {
    const fixture = externalLaneFixture();
    try {
      const peer = ceoPeer(fixture);
      expect(await dispatchOptions(fixture, [[OWNER_TURN, peer]])).toEqual([{ hermesTurn: OWNER_TURN }]);

      const turnRequestId = await claimOneTurn(fixture, 41);
      expect(await dispatchOptions(fixture, [
        [OWNER_TURN, peer],
        [OWNER_TURN, { ...peer, sessionId: "ses-not-the-ceo" }],
        [undefined, peer],
      ])).toEqual([
        { hermesTurn: OWNER_TURN, originReply: { turnRequestId, updateId: "41" } },
        { hermesTurn: OWNER_TURN },
        {},
      ]);
    } finally {
      fixture.cp.close();
    }
  });

  it("is nothing when the CEO's turn in doubt answers several Telegram updates", async () => {
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
      expect(await dispatchOptions(fixture, [[OWNER_TURN, ceoPeer(fixture)]])).toEqual([{ hermesTurn: OWNER_TURN }]);
    } finally {
      fixture.cp.close();
    }
  });
});

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

  it("is sent while the CEO is the turn's own generation, and dropped from the notice once the CEO changed", async () => {
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
      const enqueue = (key: string) => {
        const ceo = cp.bindings.active(roleKeyFor(Role.CEO))!;
        expect(cp.outbox.enqueue({
          idempotencyKey: key, roleKey: ceo.roleKey, bindingGeneration: ceo.bindingGeneration, targetSessionId: ceo.sessionId,
          kind: MessageKind.CEO_NOTIFICATION,
          payload: { notification: "READY_FOR_CEO_REVIEW", origin: { turn_request_id: turnRequestId, update_id: "41" } },
        }).allowed).toBe(true);
      };
      enqueue("u6-b1-current");
      await cp.outbox.deliverCeoNotifications();
      expect(sent).toEqual([{ notification: "READY_FOR_CEO_REVIEW", origin: { turn_request_id: turnRequestId, update_id: "41" } }]);

      // Enqueued for the turn's generation, then the CEO is replaced: the notice follows the new holder
      // without its origin, so nothing can reply to a message that holder never answered.
      held = true;
      enqueue("u6-b1-stale");
      await cp.outbox.deliverCeoNotifications();
      replaceHermesCeo(cp, 1);
      held = false;
      await cp.outbox.deliverCeoNotifications();
      expect(sent.slice(1)).toEqual([{ notification: "READY_FOR_CEO_REVIEW" }]);
    } finally {
      fixture.cp.close();
    }
  });
});

describe("U6 B1 daemon notice route", () => {
  const servers: Server[] = [];
  afterAll(async () => { await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve)))); });

  const DESTINATION = {
    session_id: "20261115_000000_u6b1", lineage_root_digest: `sha256:${"c".repeat(64)}`,
    process_pid: 4242, process_started_at: "darwin-tv:1790000000.000001",
  };

  /** A loopback Gateway that answers its identity and records the path of every POST. */
  const gateway = async (): Promise<{ port: number; posts: string[] }> => {
    const posts: string[] = [];
    const server = createServer((req, res) => {
      res.setHeader("Content-Type", "application/json");
      if (req.method === "POST") posts.push(req.url ?? "");
      req.resume();
      req.on("end", () => res.end(JSON.stringify(req.method === "POST" ? { error: "fixture" } : DESTINATION)));
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
});
