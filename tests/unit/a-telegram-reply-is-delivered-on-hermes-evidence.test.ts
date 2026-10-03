import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ownerReplyFor, pendingOwnerReplies } from "../../src/conversation/owner-reply-outbox.ts";
import {
  ConversationTurnCoordinator,
  type ReceiptLookupQuery,
  type ReceiptLookupResult,
  type ReceiptPort,
} from "../../src/conversation/turn-coordinator.ts";
import { ManualClock } from "../../src/core/clock.ts";
import { digestOf, sha256 } from "../../src/core/digest.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import {
  startDaemonOwnerReplyConsumer,
  startTelegramExternalIngress,
  withConfiguredHermesGatewayReceipt,
} from "../../src/daemon/agentcpd.ts";
import { AuditLog } from "../../src/db/audit.ts";
import { openDb } from "../../src/db/database.ts";
import { IngressGuard } from "../../src/ingress/ingress-guard.ts";
import type { TelegramExternalTurnIdentity } from "../../src/ingress/telegram-external.ts";
// A namespace import for what only this branch exports, so this file still loads on the commit
// before it and each row fails there on its own assertion rather than at import.
import * as gatewayPort from "../../src/runtime/hermes-gateway-receipt-port.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import {
  CHAT_ID,
  FakeGateway,
  GATEWAY_KEY,
  type GatewayAnswer,
  envelope,
  externalLaneFixture,
  gatewayDelivery,
  gatewayReceipt,
  gatewayReplyDigest,
  sendOverSocket,
} from "../helpers/telegram-external.ts";

afterAll(cleanupTempDirs);
afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * #1036 A3: Hermes is the only Telegram consumer, so it sends the owner's Telegram reply itself and
 * says so in the turn's Gateway receipt. A Telegram owner-reply item is recorded DELIVERED from that
 * evidence — in the settlement's own transaction when the settling receipt carries it, and on a
 * later read of the receipt otherwise — only when every field matches what ACP stored for the turn.
 *
 * Every row runs the production path: the lane's socket admits and claims the update, the daemon's
 * own composition builds the Gateway receipt port, and the coordinator's sweep settles. Only the
 * Gateway's HTTP answers are stated by the test.
 */

let gateway: FakeGateway;
let port: number;
beforeEach(async () => {
  gateway = new FakeGateway();
  port = await gateway.start();
});
afterEach(async () => {
  await gateway.close();
});

type Fixture = ReturnType<typeof externalLaneFixture>;

const daemonFixture = (): Fixture =>
  externalLaneFixture({
    configure: (config) => {
      const composed = withConfiguredHermesGatewayReceipt(config, { ACP_HERMES_GATEWAY_API_KEY: GATEWAY_KEY });
      return { ...composed, hermesGatewayReceipt: { ...composed.hermesGatewayReceipt!, port } };
    },
  });

const claimOne = async (fixture: Fixture, updateId: number): Promise<TelegramExternalTurnIdentity> => {
  const ingress = await startTelegramExternalIngress(fixture.cp, tempDir("a3-"), fixture.laneConfig);
  try {
    const answer = await sendOverSocket(ingress.socketPath, envelope(updateId, `질문 ${updateId}`));
    if (!answer.allowed) throw new Error(`the lane refused the fixture turn: ${JSON.stringify(answer)}`);
    return answer.turn;
  } finally {
    await ingress.close();
  }
};

/** The Gateway answers every update with what `body` says for it. */
const answering = (body: (updateId: number) => Record<string, unknown>): void => {
  gateway.answer = (updateId) => ({ kind: "json", body: body(updateId) });
};

const turnState = (fixture: Fixture, turnRequestId: string) =>
  fixture.cp.db.get<{ lifecycle_state: string; outcome_kind: string | null }>(
    "SELECT lifecycle_state, outcome_kind FROM canonical_turns WHERE turn_request_id = ?",
    [turnRequestId],
  );

const itemResult = (fixture: Fixture, turnRequestId: string): string | null =>
  fixture.cp.db.get<{ result_json: string | null }>(
    "SELECT result_json FROM inbound_messages WHERE channel = 'owner-reply' AND nonce = ?",
    [turnRequestId],
  )?.result_json ?? null;

const auditRows = (db: Fixture["cp"]["db"], kind: string, turnRequestId: string) =>
  db.all<{ reason_code: string | null; actor: string | null; evidence_json: string }>(
    `SELECT reason_code, actor, evidence_json FROM audit_events
      WHERE kind = ? AND json_extract(evidence_json, '$.turnRequestId') = ?
      ORDER BY event_id ASC`,
    [kind, turnRequestId],
  ).map((row) => ({ ...row, evidence: JSON.parse(row.evidence_json) as Record<string, unknown> }));

const requestsFor = (updateId: number): number =>
  gateway.requests.filter((request) => request.path === `/v1/canonical-surface/receipts/telegram/${updateId}`).length;

/** What the item must record for an update the Gateway reported delivered with `gatewayDelivery`. */
const deliveredRecord = (updateId: number, changes: { messageIds?: number[] } = {}) => ({
  transport: "telegram",
  carrier: "hermes",
  chatId: CHAT_ID,
  replyToMessageId: updateId + 100,
  messageIds: changes.messageIds ?? [9_000 + updateId],
  contentDigest: gatewayReplyDigest(updateId),
  receiptId: `hermes-tg:obligation-${updateId}`,
  obligationId: `obligation-${updateId}`,
});

const NO_TIMERS = { setTimer: () => 0, clearTimer: () => undefined };

describe("A3 parser witness: the Gateway receipt's delivery shape", () => {
  it("names the confirmed state once, refuses the 3-key and 5-key deliveries, and reads the agreed 6-key one", async () => {
    expect(gatewayPort.HERMES_DELIVERY_CONFIRMED_STATE).toBe("delivered");

    const turn: TelegramExternalTurnIdentity = {
      turnRequestId: "tr_query",
      targetActorId: "actor:query",
      promptDigest: digestOf("query"),
      bindingGeneration: 3,
      targetBindingId: "binding:query",
      targetAttestationId: "attestation:query",
      executorSessionId: "session:query",
      executorSessionIncarnation: "incarnation:query",
    };
    const receiptPort = new gatewayPort.HermesGatewayReceiptPort(
      (id) => (id === turn.turnRequestId ? { updateId: 80 } : null),
      { apiKey: GATEWAY_KEY, port },
    );
    const ask = (): Promise<ReceiptLookupResult> => receiptPort.lookup(turn, new AbortController().signal);
    const withDelivery = (delivery: Record<string, unknown> | null, status: "COMPLETED" | "ABORTED" = "COMPLETED") =>
      (): GatewayAnswer => ({ kind: "json", body: gatewayReceipt(80, turn, { status, delivery }) });

    const refused: Array<[string, () => GatewayAnswer]> = [
      // Hermes #84 as first written: no chat and no replied-to message, so nothing to check against the turn.
      ["#84's {obligation_id, state, content_digest}", withDelivery({
        obligation_id: "obligation-80", state: "delivered", content_digest: gatewayReplyDigest(80),
      })],
      ["the earlier 5-key shape without obligation_id", withDelivery(gatewayDelivery(80, { obligation_id: undefined }))],
      ["an unknown seventh key", withDelivery(gatewayDelivery(80, { sent_at: 1 }))],
      ["a delivery that is not an object", withDelivery([] as unknown as Record<string, unknown>)],
      ["ABORTED that also reports a delivery", withDelivery(gatewayDelivery(80), "ABORTED")],
    ];
    for (const [name, answer] of refused) {
      gateway.answer = answer;
      await expect(ask(), name).resolves.toEqual({ found: false });
    }

    gateway.answer = withDelivery(gatewayDelivery(80));
    await expect(ask()).resolves.toMatchObject({
      found: true,
      outcome: "COMPLETED",
      receiptId: "hermes-tg:obligation-80",
      evidenceDigest: gatewayReplyDigest(80),
      delivery: {
        confirmed: true,
        obligationId: "obligation-80",
        contentDigest: gatewayReplyDigest(80),
        chatId: CHAT_ID,
        replyToMessageId: 180,
        messageIds: [9_080],
      },
    });
    // Values of the wrong type do not refuse the receipt; they reach the outbox as unusable.
    gateway.answer = withDelivery(gatewayDelivery(80, { state: "queued", chat_id: "7000001", message_ids: [] }));
    await expect(ask()).resolves.toMatchObject({
      found: true,
      delivery: { confirmed: false, chatId: null, messageIds: null },
    });
    gateway.answer = withDelivery(null);
    await expect(ask()).resolves.toMatchObject({ found: true, outcome: "COMPLETED", delivery: null });
    gateway.answer = withDelivery(null, "ABORTED");
    const aborted = await ask();
    expect(aborted).toMatchObject({ found: true, outcome: "ABORTED" });
    expect(aborted).not.toHaveProperty("delivery");
  });
});

describe("A3: a Telegram owner reply is DELIVERED on Hermes' own delivery evidence", () => {
  it("(a) a COMPLETED receipt with confirmed delivery settles the turn and records the reply DELIVERED in one transaction", async () => {
    const fixture = daemonFixture();
    // The daemon's consumer, woken by the settlement: it must never see this item owed.
    const consumer = startDaemonOwnerReplyConsumer(fixture.cp, null, { timers: NO_TIMERS });
    try {
      await consumer.started;
      const turn = await claimOne(fixture, 101);
      answering((updateId) => gatewayReceipt(updateId, turn));
      const swept = await fixture.cp.conversation.reconcileUnresolved(5_000);
      expect(swept).toMatchObject({ swept: 1, settled: 1, failed: 0 });
      await consumer.consumer.wake("ALL");

      expect(turnState(fixture, turn.turnRequestId)).toEqual({ lifecycle_state: "SETTLED", outcome_kind: "COMPLETED" });
      const item = ownerReplyFor(fixture.cp.db, turn.turnRequestId);
      expect(item?.status).toBe("DELIVERED");
      expect(item?.delivery).toMatchObject(deliveredRecord(101));
      const { evidenceDigest, ...evidence } = item!.delivery!;
      expect(evidenceDigest).toBe(digestOf(evidence));
      expect(pendingOwnerReplies(fixture.cp.db)).toEqual([]);

      const delivered = auditRows(fixture.cp.db, "OWNER_REPLY_DELIVERED", turn.turnRequestId);
      expect(delivered).toHaveLength(1);
      expect(delivered[0]).toMatchObject({ reason_code: ReasonCode.OK, actor: "hermes" });
      expect(delivered[0]!.evidence).toEqual({
        turnRequestId: turn.turnRequestId,
        channel: "telegram",
        carrier: "hermes",
        receiptId: "hermes-tg:obligation-101",
        replyToMessageId: 201,
        messageIds: [9_101],
        contentDigest: gatewayReplyDigest(101),
        evidenceDigest,
      });
      // The consumer never parked it: it was DELIVERED before the settlement committed.
      expect(auditRows(fixture.cp.db, "OWNER_REPLY_UNDELIVERED", turn.turnRequestId)).toEqual([]);
    } finally {
      consumer.close();
      fixture.cp.close();
    }
  });

  it("(a) a DELIVERED write that fails takes the settlement back with it, and the next sweep records both", async () => {
    const fixture = daemonFixture();
    const file = join(fixture.root, "state.sqlite");
    try {
      const turn = await claimOne(fixture, 102);
      answering((updateId) => gatewayReceipt(updateId, turn));
      const raw = new Database(file);
      raw.exec(`
        CREATE TRIGGER a3_inject_delivered_failure
        BEFORE UPDATE OF result_json ON inbound_messages
        WHEN NEW.channel = 'owner-reply' AND json_extract(NEW.result_json, '$.status') = 'DELIVERED'
        BEGIN SELECT RAISE(ABORT, 'A3_INJECTED_DELIVERED_FAILURE'); END;
      `);
      raw.close();

      await expect(fixture.cp.conversation.reconcileUnresolved(5_000)).rejects.toThrow();
      expect(turnState(fixture, turn.turnRequestId)).toEqual({ lifecycle_state: "IN_DOUBT", outcome_kind: null });
      expect(itemResult(fixture, turn.turnRequestId)).toBeNull();

      const again = new Database(file);
      again.exec("DROP TRIGGER a3_inject_delivered_failure");
      again.close();
      await fixture.cp.conversation.reconcileUnresolved(5_000);
      expect(turnState(fixture, turn.turnRequestId)).toEqual({ lifecycle_state: "SETTLED", outcome_kind: "COMPLETED" });
      expect(ownerReplyFor(fixture.cp.db, turn.turnRequestId)?.status).toBe("DELIVERED");
    } finally {
      fixture.cp.close();
    }
  });

  it("(b) each mismatch leaves the settled turn's reply parked with one audit row naming the failed check", async () => {
    const fixture = daemonFixture();
    try {
      const mismatches: Array<[string, (updateId: number) => Record<string, unknown>, string]> = [
        ["state", (u) => gatewayDelivery(u, { state: "queued" }), "delivery-state-not-confirmed"],
        ["content digest", (u) => gatewayDelivery(u, { content_digest: sha256("another reply") }), "delivery-content-digest-mismatch"],
        ["content digest that is no digest", (u) => gatewayDelivery(u, { content_digest: "sha256:short" }), "delivery-content-digest-mismatch"],
        ["chat", (u) => gatewayDelivery(u, { chat_id: CHAT_ID + 1 }), "delivery-chat-mismatch"],
        ["chat as text", (u) => gatewayDelivery(u, { chat_id: String(CHAT_ID) }), "delivery-chat-mismatch"],
        ["reply-to", (u) => gatewayDelivery(u, { reply_to_message_id: u + 101 }), "delivery-reply-to-mismatch"],
        ["empty message ids", (u) => gatewayDelivery(u, { message_ids: [] }), "delivery-message-ids-invalid"],
        ["a message id that is not positive", (u) => gatewayDelivery(u, { message_ids: [9_000 + u, 0] }), "delivery-message-ids-invalid"],
        ["a message id that is text", (u) => gatewayDelivery(u, { message_ids: ["9001"] }), "delivery-message-ids-invalid"],
        ["obligation id", (u) => gatewayDelivery(u, { obligation_id: "" }), "delivery-obligation-id-invalid"],
      ];
      let updateId = 110;
      for (const [name, delivery, cause] of mismatches) {
        updateId += 1;
        const turn = await claimOne(fixture, updateId);
        answering((u) => gatewayReceipt(u, turn, { delivery: delivery(u) }));
        await fixture.cp.conversation.reconcileUnresolved(5_000);

        // The settlement stands; only the delivery is refused.
        expect(turnState(fixture, turn.turnRequestId), name)
          .toEqual({ lifecycle_state: "SETTLED", outcome_kind: "COMPLETED" });
        expect(ownerReplyFor(fixture.cp.db, turn.turnRequestId)?.status, name).toBe("PENDING");
        expect(auditRows(fixture.cp.db, "OWNER_REPLY_DELIVERED", turn.turnRequestId), name).toEqual([]);
        const rows = auditRows(fixture.cp.db, "OWNER_REPLY_UNDELIVERED", turn.turnRequestId);
        expect(rows.map((row) => row.reason_code), name).toEqual([ReasonCode.OWNER_REPLY_DELIVERY_EVIDENCE_REJECTED]);
        // Nothing the receipt reported is written beside the category, beyond the stored receipt id.
        expect(rows[0]!.evidence, name).toEqual({
          turnRequestId: turn.turnRequestId,
          channel: "telegram",
          cause,
          transient: false,
          receiptId: `hermes-tg:obligation-${updateId}`,
        });

        // A refused item is not asked about again, and gets no second row.
        const asked = requestsFor(updateId);
        await fixture.cp.conversation.reconcileUnresolved(5_000);
        expect(requestsFor(updateId), name).toBe(asked);
        expect(auditRows(fixture.cp.db, "OWNER_REPLY_UNDELIVERED", turn.turnRequestId), name).toHaveLength(1);
      }
    } finally {
      fixture.cp.close();
    }
  });

  it("(b) two overlapping reads of the same mismatch still write one row", async () => {
    const fixture = daemonFixture();
    try {
      const turn = await claimOne(fixture, 125);
      answering((updateId) => gatewayReceipt(updateId, turn, { delivery: null }));
      await fixture.cp.conversation.reconcileUnresolved(5_000);

      const mismatch = gatewayReceipt(125, turn, { delivery: gatewayDelivery(125, { chat_id: CHAT_ID + 1 }) });
      let release: (answer: GatewayAnswer) => void = () => undefined;
      const held = new Promise<GatewayAnswer>((resolve) => {
        release = resolve;
      });
      let reads = 0;
      gateway.answer = () => {
        reads += 1;
        return reads === 1 ? { kind: "deferred", answer: held } : { kind: "json", body: mismatch };
      };
      const earlier = fixture.cp.conversation.reconcileUnresolved(5_000);
      await vi.waitFor(() => expect(reads).toBe(1));
      await fixture.cp.conversation.reconcileUnresolved(5_000);
      const parked = itemResult(fixture, turn.turnRequestId);
      release({ kind: "json", body: mismatch });
      await earlier;

      expect(itemResult(fixture, turn.turnRequestId)).toBe(parked);
      expect(auditRows(fixture.cp.db, "OWNER_REPLY_UNDELIVERED", turn.turnRequestId).map((row) => row.evidence["cause"]))
        .toEqual(["delivery-chat-mismatch"]);
    } finally {
      fixture.cp.close();
    }
  });

  it("(c) a reply settled with no delivery evidence, and parked, is DELIVERED when a later read of the receipt confirms it", async () => {
    const fixture = daemonFixture();
    const consumer = startDaemonOwnerReplyConsumer(fixture.cp, null, { timers: NO_TIMERS });
    try {
      await consumer.started;
      const turn = await claimOne(fixture, 121);
      answering((updateId) => gatewayReceipt(updateId, turn, { delivery: null }));
      await fixture.cp.conversation.reconcileUnresolved(5_000);
      await consumer.consumer.wake("ALL");
      expect(turnState(fixture, turn.turnRequestId)).toEqual({ lifecycle_state: "SETTLED", outcome_kind: "COMPLETED" });
      // Today's parked behaviour, unchanged: owed, with its one no-transport row.
      expect(ownerReplyFor(fixture.cp.db, turn.turnRequestId)?.status).toBe("PENDING");
      expect(auditRows(fixture.cp.db, "OWNER_REPLY_UNDELIVERED", turn.turnRequestId).map((row) => row.reason_code))
        .toEqual([ReasonCode.OWNER_REPLY_UNDELIVERABLE_NO_TRANSPORT]);

      // Still no evidence, or no receipt at all: the item stays parked and is asked about again.
      const asked = requestsFor(121);
      await fixture.cp.conversation.reconcileUnresolved(5_000);
      answering((updateId) => gatewayReceipt(updateId, turn, { status: "PENDING" }));
      await fixture.cp.conversation.reconcileUnresolved(5_000);
      expect(requestsFor(121)).toBe(asked + 2);
      expect(ownerReplyFor(fixture.cp.db, turn.turnRequestId)?.status).toBe("PENDING");

      // Hermes' receipt now reports the send.
      answering((updateId) => gatewayReceipt(updateId, turn));
      const swept = await fixture.cp.conversation.reconcileUnresolved(5_000);
      // The in-doubt counts do not include a later read.
      expect(swept).toEqual({ swept: 0, settled: 0, unresolved: 0, failed: 0 });
      const item = ownerReplyFor(fixture.cp.db, turn.turnRequestId);
      expect(item?.status).toBe("DELIVERED");
      expect(item?.delivery).toMatchObject(deliveredRecord(121));
      expect(auditRows(fixture.cp.db, "OWNER_REPLY_DELIVERED", turn.turnRequestId)).toHaveLength(1);
      // The no-transport row stays the only undelivered row, and its audited mark is kept.
      expect(auditRows(fixture.cp.db, "OWNER_REPLY_UNDELIVERED", turn.turnRequestId)).toHaveLength(1);
      expect(JSON.parse(itemResult(fixture, turn.turnRequestId)!)).toMatchObject({
        status: "DELIVERED",
        audited: [`${ReasonCode.OWNER_REPLY_UNDELIVERABLE_NO_TRANSPORT}:telegram-transport-not-configured`],
      });
    } finally {
      consumer.close();
      fixture.cp.close();
    }
  });

  it("(c) a later receipt that is not the item's own receipt is refused, not used", async () => {
    const fixture = daemonFixture();
    try {
      const turn = await claimOne(fixture, 122);
      answering((updateId) => gatewayReceipt(updateId, turn, { delivery: null }));
      await fixture.cp.conversation.reconcileUnresolved(5_000);
      answering((updateId) => gatewayReceipt(updateId, turn, { receiptId: "hermes-tg:another-obligation" }));
      await fixture.cp.conversation.reconcileUnresolved(5_000);
      expect(ownerReplyFor(fixture.cp.db, turn.turnRequestId)?.status).toBe("PENDING");
      expect(auditRows(fixture.cp.db, "OWNER_REPLY_UNDELIVERED", turn.turnRequestId).map((row) => row.evidence["cause"]))
        .toEqual(["receipt-is-not-the-items-receipt"]);
    } finally {
      fixture.cp.close();
    }
  });

  it("(d) a repeat read changes nothing, and conflicting later evidence is refused without touching the record", async () => {
    const fixture = daemonFixture();
    try {
      // Delivered at settlement; the next sweep does not even ask.
      const first = await claimOne(fixture, 131);
      answering((updateId) => gatewayReceipt(updateId, first));
      await fixture.cp.conversation.reconcileUnresolved(5_000);
      const recorded = itemResult(fixture, first.turnRequestId);
      expect(JSON.parse(recorded!)).toMatchObject({ status: "DELIVERED" });
      const asked = requestsFor(131);
      await fixture.cp.conversation.reconcileUnresolved(5_000);
      expect(requestsFor(131)).toBe(asked);
      expect(itemResult(fixture, first.turnRequestId)).toBe(recorded);

      /**
       * Two overlapping passes read one parked item: the earlier pass's answer is held until the
       * later pass has recorded the delivery. The daemon's periodic sweep and the lane's A4 sweep
       * overlap exactly like this.
       */
      const race = async (updateId: number, late: Record<string, unknown>): Promise<string> => {
        const turn = await claimOne(fixture, updateId);
        answering((u) => gatewayReceipt(u, turn, { delivery: null }));
        await fixture.cp.conversation.reconcileUnresolved(5_000);
        expect(ownerReplyFor(fixture.cp.db, turn.turnRequestId)?.status).toBe("PENDING");

        let release: (answer: GatewayAnswer) => void = () => undefined;
        const held = new Promise<GatewayAnswer>((resolve) => {
          release = resolve;
        });
        let reads = 0;
        gateway.answer = (u) => {
          reads += 1;
          return reads === 1 ? { kind: "deferred", answer: held } : { kind: "json", body: gatewayReceipt(u, turn) };
        };
        const earlier = fixture.cp.conversation.reconcileUnresolved(5_000);
        await vi.waitFor(() => expect(reads).toBe(1));
        await fixture.cp.conversation.reconcileUnresolved(5_000);
        const stored = itemResult(fixture, turn.turnRequestId)!;
        expect(JSON.parse(stored)).toMatchObject({ status: "DELIVERED", delivery: deliveredRecord(updateId) });

        release({ kind: "json", body: gatewayReceipt(updateId, turn, { delivery: late }) });
        await earlier;
        expect(itemResult(fixture, turn.turnRequestId)).toBe(stored);
        expect(auditRows(fixture.cp.db, "OWNER_REPLY_DELIVERED", turn.turnRequestId)).toHaveLength(1);
        return turn.turnRequestId;
      };

      // The same evidence read twice: nothing changes, nothing is audited again.
      const same = await race(132, gatewayDelivery(132));
      expect(auditRows(fixture.cp.db, "OWNER_REPLY_DELIVERY_CONFLICT", same)).toEqual([]);

      // Different evidence for a delivered item: refused and audited, the record stands.
      const conflicting = await race(133, gatewayDelivery(133, { message_ids: [4_242] }));
      const conflicts = auditRows(fixture.cp.db, "OWNER_REPLY_DELIVERY_CONFLICT", conflicting);
      expect(conflicts.map((row) => row.reason_code)).toEqual([ReasonCode.OWNER_REPLY_DELIVERY_EVIDENCE_CONFLICT]);
      expect(conflicts[0]!.evidence).toMatchObject({
        turnRequestId: conflicting,
        channel: "telegram",
        cause: "evidence-differs-from-recorded-delivery",
        receiptId: "hermes-tg:obligation-133",
      });
      expect(ownerReplyFor(fixture.cp.db, conflicting)?.delivery).toMatchObject(deliveredRecord(133));
    } finally {
      fixture.cp.close();
    }
  });
});

/* ---------------------------------------------------------------------------- (e) Buzz control */

const NOW = "2026-10-03T00:00:00.000Z";
const ROOM = "83da5c36-7be5-4df7-9887-19ec44d7fb0a";
const REPLY = "The deploy finished; all 29 gates passed.";

/** A receipt port that reports Telegram delivery evidence on every answer, even for a Buzz turn. */
class EvidencePort implements ReceiptPort {
  readonly reportsTelegramDelivery = true;
  readonly asked: string[] = [];
  readonly answers = new Map<string, ReceiptLookupResult>();

  lookup(query: ReceiptLookupQuery): ReceiptLookupResult {
    this.asked.push(query.turnRequestId);
    return this.answers.get(query.turnRequestId) ?? { found: false };
  }
}

describe("A3 (e): a Buzz item is untouched by delivery evidence", () => {
  it("settles PENDING for its own sender, with no delivery row, and is never asked about again", async () => {
    const root = join(tempDir("a3-buzz-"), "state");
    mkdirSync(root, { recursive: true });
    chmodSync(root, 0o700);
    const db = openDb(join(root, "state.sqlite"));
    try {
      const clock = new ManualClock(NOW);
      const audit = new AuditLog(db, clock);
      const evidence = new EvidencePort();
      const coordinator = new ConversationTurnCoordinator(db, clock, audit, evidence);
      db.run(
        `INSERT INTO sessions (session_id, incarnation, provider, model, lifecycle, created_at, updated_at)
         VALUES ('runtime:cto', 'inc-1', 'claude', 'opus', 'READY', ?, ?)`,
        [NOW, NOW],
      );
      db.run(
        `INSERT INTO conversational_actors (actor_id, kind, current_session_id, current_session_incarnation, created_at)
         VALUES ('actor:cto', 'CEO', 'runtime:cto', 'inc-1', ?)`,
        [NOW],
      );
      db.run(
        `INSERT INTO actor_target_bindings
           (target_binding_id, target_actor_id, executor_kind, target_locator, target_locator_digest, bound_at)
         VALUES ('bind:cto', 'actor:cto', 'hermes', 'locator:cto', 'digest:cto', ?)`,
        [NOW],
      );
      db.run(
        `INSERT INTO assignments
           (assignment_id, role_key, role, actor_id, session_id, session_incarnation,
            binding_generation, mode, status, created_at)
         VALUES ('asg:cto', 'CEO:cto', 'CEO', 'actor:cto', 'runtime:cto', 'inc-1', 1, 'PREFERRED', 'ACTIVE', ?)`,
        [NOW],
      );
      db.run(
        `INSERT INTO actor_target_attestations
           (target_attestation_id, target_binding_id, protocol_version, attestation_digest,
            executor_session_id, executor_session_incarnation, binding_generation, assignment_id, attested_at)
         VALUES ('att:cto', 'bind:cto', 'v1', 'attd:cto', 'runtime:cto', 'inc-1', 1, 'asg:cto', ?)`,
        [NOW],
      );

      const eventId = sha256("a3-buzz-owner-event").slice("sha256:".length);
      const nonce = `buzz-message:${eventId}`;
      const payload = {
        type: "BUZZ_MESSAGE",
        conversation: ROOM,
        addressedTo: "ROLE",
        mention: "a".repeat(64),
        text: "what is the status of the deploy?",
      };
      const guard = new IngressGuard(db, clock, audit, { buzz: { allowedActors: ["owner"], allowedConversations: [ROOM] } });
      expect(guard.admit({ channel: "buzz", actor: "owner", conversation: ROOM, nonce, payload }).allowed).toBe(true);
      const claimed = coordinator.claim({
        targetActorId: "actor:cto",
        prompt: "hello",
        sources: [{ channel: "buzz", nonce, attempt: 1, payload }],
      });
      if (!claimed.allowed) throw new Error(`claim refused: ${claimed.reasonCode}`);
      const turn = claimed.value.turnRequestId;
      const row = db.get<Record<string, string | number>>("SELECT * FROM canonical_turns WHERE turn_request_id = ?", [turn])!;
      evidence.answers.set(turn, {
        found: true,
        outcome: "COMPLETED",
        receiptId: `hermes:${turn}`,
        evidenceDigest: sha256(REPLY),
        reasonCode: ReasonCode.OK,
        content: REPLY,
        delivery: {
          confirmed: true,
          obligationId: "obligation-buzz",
          contentDigest: sha256(REPLY),
          chatId: CHAT_ID,
          replyToMessageId: 1,
          messageIds: [1],
        },
        turnRequestId: turn,
        targetActorId: String(row["target_actor_id"]),
        promptDigest: String(row["prompt_digest"]),
        bindingGeneration: Number(row["binding_generation"]),
        targetBindingId: String(row["target_binding_id"]),
        targetAttestationId: String(row["target_attestation_id"]),
        executorSessionId: String(row["executor_session_id"]),
        executorSessionIncarnation: String(row["executor_session_incarnation"]),
      });

      expect(await coordinator.reconcileUnresolved()).toMatchObject({ swept: 1, settled: 1 });
      const item = ownerReplyFor(db, turn);
      expect(item).toMatchObject({ status: "PENDING", address: { channel: "buzz", conversation: ROOM } });
      expect(item).not.toHaveProperty("delivery");
      expect(JSON.parse(db.get<{ result_json: string }>(
        "SELECT result_json FROM inbound_messages WHERE channel = 'owner-reply' AND nonce = ?",
        [turn],
      )!.result_json)).toEqual({ status: "PENDING" });
      for (const kind of ["OWNER_REPLY_DELIVERED", "OWNER_REPLY_UNDELIVERED", "OWNER_REPLY_DELIVERY_CONFLICT"]) {
        expect(auditRows(db, kind, turn), kind).toEqual([]);
      }

      // A later sweep asks about no Buzz item.
      const asked = evidence.asked.length;
      await coordinator.reconcileUnresolved();
      expect(evidence.asked.length).toBe(asked);
    } finally {
      db.close();
    }
  });
});
