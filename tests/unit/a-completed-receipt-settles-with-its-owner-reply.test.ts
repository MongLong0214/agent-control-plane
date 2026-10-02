import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { ManualClock } from "../../src/core/clock.ts";
import { digestOf } from "../../src/core/digest.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import {
  OWNER_REPLY_OUTBOX_CHANNEL,
  enqueueOwnerReply,
  ownerReplyFor,
  pendingOwnerReplies,
} from "../../src/conversation/owner-reply-outbox.ts";
import {
  ConversationTurnCoordinator,
  type ReceiptLookupQuery,
  type ReceiptLookupResult,
  type ReceiptPort,
  type TurnPermit,
} from "../../src/conversation/turn-coordinator.ts";
import { AuditLog } from "../../src/db/audit.ts";
import { openDb } from "../../src/db/database.ts";
import { IngressGuard, type TurnIdentity } from "../../src/ingress/ingress-guard.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);
afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * #1036 — contract 6's other half. A matched `COMPLETED` receipt moves the turn and inserts one
 * owner-reply item in the same transaction, on both receipt lanes: the canonical ledger's sweep
 * (`reconcileUnresolved`) and the Telegram ingress lane (`reconcileIngressReceipt`). Neither write
 * may land without the other, a redelivered receipt adds nothing, the item is addressed to the
 * conversation the owner asked from, and `ABORTED` is untouched.
 */
const NOW = "2026-10-02T00:00:00.000Z";

type Fixture = {
  db: ReturnType<typeof openDb>;
  clock: ManualClock;
  audit: AuditLog;
  coordinator: ConversationTurnCoordinator;
};

const stateDir = (): string => {
  const root = join(tempDir("acp-1036-owner-reply-"), "state");
  mkdirSync(root, { recursive: true });
  chmodSync(root, 0o700);
  return root;
};

const withCoordinator = (port: ReceiptPort): Fixture => {
  const db = openDb(join(stateDir(), "state.sqlite"));
  const clock = new ManualClock(NOW);
  const audit = new AuditLog(db, clock);
  return { db, clock, audit, coordinator: new ConversationTurnCoordinator(db, clock, audit, port) };
};

/** Answers by turn id; a test sets the answer, the sweep asks. */
class FakeReceiptPort implements ReceiptPort {
  private readonly answers = new Map<string, ReceiptLookupResult>();
  hold: Promise<void> | null = null;

  answer(turnRequestId: string, result: ReceiptLookupResult): void {
    this.answers.set(turnRequestId, result);
  }

  async lookup(query: ReceiptLookupQuery): Promise<ReceiptLookupResult> {
    if (this.hold) await this.hold;
    return this.answers.get(query.turnRequestId) ?? { found: false };
  }
}

const target = (c: Fixture, name: string): string => {
  const actorId = `actor:${name}`;
  const sessionId = `runtime:${name}`;
  c.db.run(
    `INSERT INTO sessions (session_id, incarnation, provider, model, lifecycle, created_at, updated_at)
     VALUES (?, 'inc-1', 'claude', 'opus', 'READY', ?, ?)`,
    [sessionId, NOW, NOW],
  );
  c.db.run(
    `INSERT INTO conversational_actors
       (actor_id, kind, current_session_id, current_session_incarnation, created_at)
     VALUES (?, 'CEO', ?, 'inc-1', ?)`,
    [actorId, sessionId, NOW],
  );
  c.db.run(
    `INSERT INTO actor_target_bindings
       (target_binding_id, target_actor_id, executor_kind, target_locator, target_locator_digest, bound_at)
     VALUES (?, ?, 'hermes', ?, ?, ?)`,
    [`bind:${name}`, actorId, `locator:${name}`, `digest:${name}`, NOW],
  );
  c.db.run(
    `INSERT INTO assignments
       (assignment_id, role_key, role, actor_id, session_id, session_incarnation,
        binding_generation, mode, status, created_at)
     VALUES (?, ?, 'CEO', ?, ?, 'inc-1', 1, 'PREFERRED', 'ACTIVE', ?)`,
    [`asg:${name}`, `CEO:${name}`, actorId, sessionId, NOW],
  );
  c.db.run(
    `INSERT INTO actor_target_attestations
       (target_attestation_id, target_binding_id, protocol_version, attestation_digest,
        executor_session_id, executor_session_incarnation, binding_generation, assignment_id,
        attested_at)
     VALUES (?, ?, 'v1', ?, ?, 'inc-1', 1, ?, ?)`,
    [`att:${name}`, `bind:${name}`, `attd:${name}`, sessionId, `asg:${name}`, NOW],
  );
  return actorId;
};

interface Admission {
  channel: "telegram" | "buzz";
  nonce: string;
  conversation: string | undefined;
  payload: Record<string, unknown>;
  /** The ingress claim the router writes before it materializes the turn, when there is one. */
  claim?: { sessionDigest: string; legacySessionDigest?: string };
}

/** The two digests `TelegramIngress.turnIdentityFor` writes for a chat (project and thread elided). */
const telegramScope = (chat: string) => ({
  sessionDigest: digestOf({ projectId: null, chatId: chat, message_thread_id: null, replyRootMessageId: null }),
  legacySessionDigest: digestOf({ channel: "telegram", conversation: chat }),
});

const telegramMessage = (nonce: string, chat: string, messageId: number): Admission => ({
  channel: "telegram",
  nonce,
  conversation: chat,
  payload: { text: `message ${nonce}`, messageId },
  claim: telegramScope(chat),
});

const buzzMessage = (nonce: string, room: string): Admission => ({
  channel: "buzz",
  nonce,
  conversation: room,
  payload: { type: "BUZZ_MESSAGE", conversation: room, addressedTo: "CEO", mention: null, text: `message ${nonce}` },
  claim: { sessionDigest: digestOf({ channel: "buzz", conversation: room }) },
});

/** Admits through the production `IngressGuard.admit`, so the address is what ingress recorded. */
const admit = (c: Fixture, message: Admission): void => {
  // Telegram refuses to run without a chat allowlist; the other channels take the conversation as
  // the relay presents it, including none at all.
  const policy = message.conversation === undefined
    ? { allowedActors: ["owner"] }
    : { allowedActors: ["owner"], allowedConversations: [message.conversation] };
  const guard = new IngressGuard(c.db, c.clock, c.audit, { [message.channel]: policy });
  const admitted = guard.admit({
    channel: message.channel,
    actor: "owner",
    ...(message.conversation === undefined ? {} : { conversation: message.conversation }),
    nonce: message.nonce,
    payload: message.payload,
  });
  if (!admitted.allowed) throw new Error(`fixture could not admit ${message.nonce}: ${admitted.reasonCode}`);
  if (!message.claim) return;
  const claimed = guard.claimTurn(message.channel, message.nonce, {
    turnRequestId: `ingress:${message.nonce}`,
    ...message.claim,
    promptDigest: digestOf("hello"),
    bindingDigest: digestOf({ bindingGeneration: 1 }),
  });
  if (!claimed.allowed) throw new Error(`fixture could not claim ${message.nonce}: ${claimed.reasonCode}`);
};

const claimTurn = (c: Fixture, actorId: string, messages: readonly Admission[]): string =>
  claimWithPermit(c, actorId, messages).turnRequestId;

const claimWithPermit = (c: Fixture, actorId: string, messages: readonly Admission[]): TurnPermit => {
  for (const message of messages) admit(c, message);
  const decision = c.coordinator.claim({
    targetActorId: actorId,
    prompt: "hello",
    sources: messages.map((message) => ({
      channel: message.channel,
      nonce: message.nonce,
      attempt: 1,
      payload: message.payload,
    })),
  });
  if (!decision.allowed) throw new Error(`claim refused: ${decision.reasonCode} ${decision.message}`);
  return decision.value;
};

/** The receipt the canonical turn's own row would match, with only the outcome chosen. */
const receiptFor = (
  c: Fixture,
  turnRequestId: string,
  outcome: "COMPLETED" | "ABORTED",
): ReceiptLookupResult => {
  const row = c.db.get<{
    target_actor_id: string;
    prompt_digest: string;
    binding_generation: number;
    target_binding_id: string;
    target_attestation_id: string;
    executor_session_id: string;
    executor_session_incarnation: string;
  }>(`SELECT * FROM canonical_turns WHERE turn_request_id = ?`, [turnRequestId])!;
  return {
    found: true,
    outcome,
    receiptId: `hermes:${turnRequestId}`,
    evidenceDigest: `sha256:reply-${turnRequestId}`,
    reasonCode: ReasonCode.OK,
    turnRequestId,
    targetActorId: row.target_actor_id,
    promptDigest: row.prompt_digest,
    bindingGeneration: row.binding_generation,
    targetBindingId: row.target_binding_id,
    targetAttestationId: row.target_attestation_id,
    executorSessionId: row.executor_session_id,
    executorSessionIncarnation: row.executor_session_incarnation,
  };
};

const stateOf = (c: Fixture, turnRequestId: string) =>
  c.db.get<{ lifecycle_state: string; outcome_kind: string | null }>(
    `SELECT lifecycle_state, outcome_kind FROM canonical_turns WHERE turn_request_id = ?`,
    [turnRequestId],
  );

const observationsOf = (c: Fixture, turnRequestId: string): number =>
  c.db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM canonical_turn_observations WHERE turn_request_id = ?`,
    [turnRequestId],
  )!.n;

const replyRows = (c: Fixture): number =>
  c.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM inbound_messages WHERE channel = ?`, [
    OWNER_REPLY_OUTBOX_CHANNEL,
  ])!.n;

/** Makes the owner-reply insert itself fail, as a full disk or a refused write would. */
const failTheReplyInsert = (c: Fixture): void => {
  const run = c.db.run.bind(c.db);
  vi.spyOn(c.db, "run").mockImplementation((sql: string, params: unknown[] = []) => {
    if (sql.trimStart().startsWith("INSERT INTO inbound_messages") && params[0] === OWNER_REPLY_OUTBOX_CHANNEL) {
      throw new Error("injected owner-reply insert failure");
    }
    return run(sql, params);
  });
};

describe("a COMPLETED receipt on the canonical ledger", () => {
  it("settles the turn and stores one owner reply addressed to the Telegram message it answers", async () => {
    const port = new FakeReceiptPort();
    const c = withCoordinator(port);
    const actorId = target(c, "telegram");
    const turn = claimTurn(c, actorId, [telegramMessage("m1", "chat-9", 71), telegramMessage("m2", "chat-9", 72)]);
    port.answer(turn, receiptFor(c, turn, "COMPLETED"));

    const summary = await c.coordinator.reconcileUnresolved();

    expect(summary).toEqual({ swept: 1, settled: 1, unresolved: 0, failed: 0 });
    expect(stateOf(c, turn)).toEqual({ lifecycle_state: "SETTLED", outcome_kind: "COMPLETED" });
    expect(ownerReplyFor(c.db, turn)).toEqual({
      turnRequestId: turn,
      ledger: "CANONICAL_TURN",
      targetActorId: actorId,
      address: {
        channel: "telegram",
        sourceNonce: "m2",
        conversation: null,
        scopeDigest: telegramScope("chat-9").sessionDigest,
        chatDigest: telegramScope("chat-9").legacySessionDigest,
        replyToMessageId: 72,
      },
      receipt: {
        authority: "HERMES_TARGET",
        receiptId: `hermes:${turn}`,
        evidenceDigest: `sha256:reply-${turn}`,
        reasonCode: ReasonCode.OK,
      },
      status: "PENDING",
      enqueuedAt: NOW,
    });
    expect(pendingOwnerReplies(c.db).map((item) => item.turnRequestId)).toEqual([turn]);
  });

  it("addresses a Buzz turn to the room its ingress row was admitted from", async () => {
    const port = new FakeReceiptPort();
    const c = withCoordinator(port);
    const actorId = target(c, "buzz");
    const turn = claimTurn(c, actorId, [buzzMessage("buzz-message:e1", "room-7")]);
    port.answer(turn, receiptFor(c, turn, "COMPLETED"));

    await c.coordinator.reconcileUnresolved();

    const stored = c.db.get<{ payload_json: string }>(
      `SELECT payload_json FROM inbound_messages WHERE channel = 'buzz' AND nonce = 'buzz-message:e1'`,
    )!;
    expect((JSON.parse(stored.payload_json) as { conversation: string }).conversation).toBe("room-7");
    expect(ownerReplyFor(c.db, turn)?.address).toEqual({
      channel: "buzz",
      sourceNonce: "buzz-message:e1",
      conversation: "room-7",
      scopeDigest: digestOf({ channel: "buzz", conversation: "room-7" }),
      chatDigest: null,
      replyToMessageId: null,
    });
  });

  it("rolls the settlement back when the reply insert fails, and completes once it can be written", async () => {
    const port = new FakeReceiptPort();
    const c = withCoordinator(port);
    const actorId = target(c, "rollback");
    const turn = claimTurn(c, actorId, [telegramMessage("m1", "chat-9", 71)]);
    port.answer(turn, receiptFor(c, turn, "COMPLETED"));

    failTheReplyInsert(c);
    await expect(c.coordinator.reconcileUnresolved()).rejects.toThrow(/injected owner-reply insert failure/);

    expect(stateOf(c, turn)).toEqual({ lifecycle_state: "IN_DOUBT", outcome_kind: null });
    expect(observationsOf(c, turn), "the receipt observation outlived its rolled-back reply").toBe(0);
    expect(replyRows(c)).toBe(0);

    vi.restoreAllMocks();
    const summary = await c.coordinator.reconcileUnresolved();
    expect(summary).toEqual({ swept: 1, settled: 1, unresolved: 0, failed: 0 });
    expect(stateOf(c, turn)).toEqual({ lifecycle_state: "SETTLED", outcome_kind: "COMPLETED" });
    expect(replyRows(c)).toBe(1);
  });

  it("leaves the turn unsettled when its messages do not name one conversation to answer", async () => {
    const port = new FakeReceiptPort();
    const c = withCoordinator(port);
    const actorId = target(c, "split");
    const split = claimTurn(c, actorId, [telegramMessage("m1", "chat-9", 71), telegramMessage("m2", "chat-10", 72)]);
    port.answer(split, receiptFor(c, split, "COMPLETED"));

    const summary = await c.coordinator.reconcileUnresolved();

    expect(summary).toEqual({ swept: 1, settled: 0, unresolved: 1, failed: 0 });
    expect(stateOf(c, split)).toEqual({ lifecycle_state: "IN_DOUBT", outcome_kind: null });
    expect(observationsOf(c, split)).toBe(0);
    expect(replyRows(c)).toBe(0);
  });

  it("leaves the turn unsettled when nothing durable names the conversation its message came from", async () => {
    const port = new FakeReceiptPort();
    const c = withCoordinator(port);
    const actorId = target(c, "nowhere");
    const turn = claimTurn(c, actorId, [
      { channel: "buzz", nonce: "buzz-message:e9", conversation: undefined, payload: { text: "no room" } },
    ]);
    port.answer(turn, receiptFor(c, turn, "COMPLETED"));

    const summary = await c.coordinator.reconcileUnresolved();

    expect(summary).toEqual({ swept: 1, settled: 0, unresolved: 1, failed: 0 });
    expect(stateOf(c, turn)).toEqual({ lifecycle_state: "IN_DOUBT", outcome_kind: null });
    expect(replyRows(c)).toBe(0);
  });

  it("stores one reply when two overlapping sweeps settle the same receipt", async () => {
    const port = new FakeReceiptPort();
    const c = withCoordinator(port);
    const actorId = target(c, "overlap");
    const turn = claimTurn(c, actorId, [telegramMessage("m1", "chat-9", 71)]);
    port.answer(turn, receiptFor(c, turn, "COMPLETED"));
    let release!: () => void;
    port.hold = new Promise<void>((resolve) => { release = resolve; });

    // Both passes read the turn as IN_DOUBT before either lookup returns.
    const first = c.coordinator.reconcileUnresolved();
    const second = c.coordinator.reconcileUnresolved();
    release();
    const summaries = await Promise.all([first, second]);

    expect(summaries.map((summary) => summary.swept)).toEqual([1, 1]);
    expect(stateOf(c, turn)).toEqual({ lifecycle_state: "SETTLED", outcome_kind: "COMPLETED" });
    expect(observationsOf(c, turn)).toBe(1);
    expect(replyRows(c)).toBe(1);
  });

  it("owes nothing new for a turn another settlement completed while the sweep was asking", async () => {
    const port = new FakeReceiptPort();
    const c = withCoordinator(port);
    const actorId = target(c, "elsewhere");
    const permit = claimWithPermit(c, actorId, [telegramMessage("m1", "chat-9", 71)]);
    const receipt = receiptFor(c, permit.turnRequestId, "COMPLETED");
    port.answer(permit.turnRequestId, receipt);
    let release!: () => void;
    port.hold = new Promise<void>((resolve) => { release = resolve; });

    const sweep = c.coordinator.reconcileUnresolved();
    // The live holder reports the same receipt through its permit first; that path delivers its
    // own reply and has no owner-reply item to write.
    if (!receipt.found) throw new Error("fixture receipt must be found");
    const live = c.coordinator.ports.target.completed(permit, {
      receiptId: receipt.receiptId,
      evidenceDigest: receipt.evidenceDigest,
      reasonCode: receipt.reasonCode,
    });
    expect(live.allowed).toBe(true);
    release();
    await sweep;

    expect(stateOf(c, permit.turnRequestId)).toEqual({ lifecycle_state: "SETTLED", outcome_kind: "COMPLETED" });
    expect(observationsOf(c, permit.turnRequestId)).toBe(1);
    expect(replyRows(c), "a redelivered receipt queued a reply for a turn it did not complete").toBe(0);
  });

  it("settles an ABORTED receipt exactly as before, with no reply owed", async () => {
    const port = new FakeReceiptPort();
    const c = withCoordinator(port);
    const actorId = target(c, "aborted");
    const turn = claimTurn(c, actorId, [telegramMessage("m1", "chat-9", 71)]);
    port.answer(turn, receiptFor(c, turn, "ABORTED"));

    const summary = await c.coordinator.reconcileUnresolved();

    expect(summary).toEqual({ swept: 1, settled: 1, unresolved: 0, failed: 0 });
    expect(stateOf(c, turn)).toEqual({ lifecycle_state: "SETTLED", outcome_kind: "ABORTED" });
    expect(ownerReplyFor(c.db, turn)).toBeNull();
    expect(replyRows(c)).toBe(0);
  });
});

describe("a COMPLETED receipt on the Telegram ingress lane", () => {
  const CHAT = "chat-9";
  const TURN = "ingress-turn-1";

  /** A durable ingress claim bound to a Hermes receipt identity, as the Telegram router writes it. */
  const ingressClaim = (port: FakeReceiptPort) => {
    const c = withCoordinator(port);
    const actorId = target(c, "ingress");
    const query: ReceiptLookupQuery = {
      turnRequestId: TURN,
      targetActorId: actorId,
      promptDigest: digestOf("did Hermes finish?"),
      bindingGeneration: 1,
      targetBindingId: "bind:ingress",
      targetAttestationId: "att:ingress",
      executorSessionId: "runtime:ingress",
      executorSessionIncarnation: "inc-1",
    };
    const guard = new IngressGuard(
      c.db,
      c.clock,
      c.audit,
      { telegram: { allowedActors: ["owner"], allowedConversations: [CHAT] } },
      { receiptIdentityForClaim: (identity) => ({ ...query, turnRequestId: identity.turnRequestId }) },
    );
    const admitted = guard.admit({
      channel: "telegram",
      actor: "owner",
      conversation: CHAT,
      nonce: "update:7",
      payload: { text: "did Hermes finish?", messageId: 7 },
    });
    if (!admitted.allowed) throw new Error(`fixture could not admit: ${admitted.reasonCode}`);
    const identity: TurnIdentity = {
      turnRequestId: TURN,
      ...telegramScope(CHAT),
      promptDigest: query.promptDigest,
      bindingDigest: digestOf({ bindingGeneration: 1 }),
    };
    const claimed = guard.claimTurn("telegram", "update:7", identity);
    if (!claimed.allowed) throw new Error(`fixture could not claim: ${claimed.reasonCode}`);
    const stored = guard.receiptIdentityForClaim("telegram", "update:7");
    if (!stored) throw new Error("fixture claim carries no receipt identity");
    const reconcile = () => c.coordinator.reconcileIngressReceipt(
      stored,
      (receipt) => guard.completeClaimFromHermesReceipt("telegram", "update:7", stored, receipt),
    );
    const claim = () => JSON.parse(c.db.get<{ turn_claim_json: string }>(
      `SELECT turn_claim_json FROM inbound_messages WHERE channel = 'telegram' AND nonce = 'update:7'`,
    )!.turn_claim_json) as Record<string, unknown>;
    const result = () => c.db.get<{ result_json: string | null }>(
      `SELECT result_json FROM inbound_messages WHERE channel = 'telegram' AND nonce = 'update:7'`,
    )!.result_json;
    return { c, guard, stored, reconcile, claim, result };
  };

  const ingressReceipt = (query: ReceiptLookupQuery, outcome: "COMPLETED" | "ABORTED"): ReceiptLookupResult => ({
    found: true,
    outcome,
    receiptId: "hermes:ingress-receipt",
    evidenceDigest: "sha256:ingress-reply",
    reasonCode: outcome === "COMPLETED" ? ReasonCode.OK : ReasonCode.HERMES_AGENT_RUN_EXCEPTION,
    ...query,
  });

  it("settles the ingress claim and stores one owner reply addressed to the owner's message", async () => {
    const port = new FakeReceiptPort();
    const { c, stored, reconcile, claim, result } = ingressClaim(port);
    port.answer(TURN, ingressReceipt(stored, "COMPLETED"));

    const settled = await reconcile();

    expect(settled.allowed, settled.allowed ? "" : `${settled.reasonCode}: ${settled.message}`).toBe(true);
    expect(claim()).toMatchObject({
      settledAt: NOW,
      settlement: "REPLY_OUTBOX",
      hermesReceipt: {
        outcome: "COMPLETED",
        receiptId: "hermes:ingress-receipt",
        evidenceDigest: "sha256:ingress-reply",
        reasonCode: ReasonCode.OK,
      },
    });
    expect(claim()).not.toHaveProperty("noReplyAt");
    expect(claim()).not.toHaveProperty("repliedAt");
    expect(JSON.parse(result() ?? "null")).toEqual({ kind: "TELEGRAM_REPLY_OUTBOX" });
    expect(ownerReplyFor(c.db, TURN)).toMatchObject({
      ledger: "INGRESS_CLAIM",
      targetActorId: stored.targetActorId,
      address: {
        channel: "telegram",
        sourceNonce: "update:7",
        conversation: null,
        scopeDigest: telegramScope(CHAT).sessionDigest,
        chatDigest: telegramScope(CHAT).legacySessionDigest,
        replyToMessageId: 7,
      },
      receipt: { receiptId: "hermes:ingress-receipt", evidenceDigest: "sha256:ingress-reply" },
      status: "PENDING",
    });
  });

  it("adds nothing when the same receipt settles the claim again", async () => {
    const port = new FakeReceiptPort();
    const { c, stored, reconcile } = ingressClaim(port);
    port.answer(TURN, ingressReceipt(stored, "COMPLETED"));

    const first = await reconcile();
    const second = await reconcile();

    expect(first.allowed).toBe(true);
    expect(second).toMatchObject({ allowed: true, reasonCode: ReasonCode.INGRESS_REPLAY_IGNORED });
    expect(replyRows(c)).toBe(1);
  });

  it("rolls the ingress settlement back when the reply insert fails", async () => {
    const port = new FakeReceiptPort();
    const { c, stored, reconcile, claim, result } = ingressClaim(port);
    port.answer(TURN, ingressReceipt(stored, "COMPLETED"));
    const resultBefore = result();

    failTheReplyInsert(c);
    await expect(reconcile()).rejects.toThrow(/injected owner-reply insert failure/);

    expect(claim()).not.toHaveProperty("settledAt");
    expect(claim()).not.toHaveProperty("hermesReceipt");
    expect(result()).toBe(resultBefore);
    expect(replyRows(c)).toBe(0);

    vi.restoreAllMocks();
    expect((await reconcile()).allowed).toBe(true);
    expect(replyRows(c)).toBe(1);
  });

  it("refuses, and rolls back, a settlement that records completion without its reply", async () => {
    const port = new FakeReceiptPort();
    const { c, stored, claim } = ingressClaim(port);
    port.answer(TURN, ingressReceipt(stored, "COMPLETED"));

    const settled = await c.coordinator.reconcileIngressReceipt(stored, () => {
      c.db.run(
        `UPDATE inbound_messages SET result_json = ? WHERE channel = 'telegram' AND nonce = 'update:7'`,
        [JSON.stringify({ kind: "TELEGRAM_REPLY_OUTBOX" })],
      );
      return { allowed: true, reasonCode: ReasonCode.OK, evidence: {}, value: undefined };
    });

    expect(settled).toMatchObject({ allowed: false });
    expect(claim()).not.toHaveProperty("settledAt");
    expect(c.db.get<{ result_json: string | null }>(
      `SELECT result_json FROM inbound_messages WHERE channel = 'telegram' AND nonce = 'update:7'`,
    )!.result_json).toBeNull();
    expect(replyRows(c)).toBe(0);
  });

  it("refuses a settlement whose queued reply names a different receipt than the one matched", async () => {
    const port = new FakeReceiptPort();
    const { c, stored, claim } = ingressClaim(port);
    port.answer(TURN, ingressReceipt(stored, "COMPLETED"));

    for (const wrong of [{ receiptId: "hermes:another-receipt" }, { evidenceDigest: "sha256:another-reply" }]) {
      const settled = await c.coordinator.reconcileIngressReceipt(stored, (receipt) => {
        const queued = enqueueOwnerReply(c.db, c.clock, {
          turnRequestId: TURN,
          ledger: "INGRESS_CLAIM",
          targetActorId: stored.targetActorId,
          sources: [{ channel: "telegram", nonce: "update:7" }],
          receipt: {
            authority: "HERMES_TARGET",
            receiptId: receipt.receiptId,
            evidenceDigest: receipt.evidenceDigest,
            reasonCode: receipt.reasonCode,
            ...wrong,
          },
        });
        if (!queued.allowed) throw new Error(`fixture could not queue: ${queued.reasonCode}`);
        return { allowed: true, reasonCode: ReasonCode.OK, evidence: {}, value: undefined };
      });

      expect(settled, JSON.stringify(wrong)).toMatchObject({ allowed: false, reasonCode: ReasonCode.INGRESS_TURN_OUTCOME_UNKNOWN });
      expect(replyRows(c), JSON.stringify(wrong)).toBe(0);
    }
    expect(claim()).not.toHaveProperty("settledAt");
  });

  it("settles an ABORTED receipt exactly as before, with no reply owed", async () => {
    const port = new FakeReceiptPort();
    const { c, stored, reconcile, claim, result } = ingressClaim(port);
    port.answer(TURN, ingressReceipt(stored, "ABORTED"));

    const settled = await reconcile();

    expect(settled.allowed).toBe(true);
    expect(claim()).toMatchObject({
      noReplyAt: NOW,
      hermesReceipt: {
        receiptId: "hermes:ingress-receipt",
        evidenceDigest: "sha256:ingress-reply",
        reasonCode: ReasonCode.HERMES_AGENT_RUN_EXCEPTION,
      },
    });
    expect(claim()).not.toHaveProperty("settledAt");
    expect(JSON.parse(result() ?? "null")).toEqual({ kind: "TELEGRAM_NO_REPLY" });
    expect(replyRows(c)).toBe(0);
  });
});

describe("the owner-reply lane", () => {
  it("refuses a second turn's reply to an ingress message another turn already answers", () => {
    const c = withCoordinator(new FakeReceiptPort());
    admit(c, telegramMessage("m1", "chat-9", 71));
    const receipt = {
      authority: "HERMES_TARGET" as const,
      receiptId: "r-1",
      evidenceDigest: "sha256:r-1",
      reasonCode: ReasonCode.OK,
    };
    const enqueue = (turnRequestId: string) => c.db.tx(() => enqueueOwnerReply(c.db, c.clock, {
      turnRequestId,
      ledger: "CANONICAL_TURN",
      targetActorId: "actor:x",
      sources: [{ channel: "telegram", nonce: "m1" }],
      receipt,
    }));

    expect(enqueue("tr_first").allowed).toBe(true);
    expect(enqueue("tr_first")).toMatchObject({ allowed: true, value: { replayed: true } });
    expect(enqueue("tr_second")).toMatchObject({
      allowed: false,
      reasonCode: ReasonCode.CONVERSATION_TURN_REPLY_CONFLICT,
    });
    expect(c.db.tx(() => enqueueOwnerReply(c.db, c.clock, {
      turnRequestId: "tr_first",
      ledger: "CANONICAL_TURN",
      targetActorId: "actor:x",
      sources: [{ channel: "telegram", nonce: "m1" }],
      receipt: { ...receipt, evidenceDigest: "sha256:a-different-reply" },
    }))).toMatchObject({ allowed: false, reasonCode: ReasonCode.CONVERSATION_TURN_REPLY_CONFLICT });
    expect(replyRows(c)).toBe(1);
    expect(ownerReplyFor(c.db, "tr_first")?.receipt.evidenceDigest).toBe("sha256:r-1");
  });

  it("refuses a turn whose messages arrived on two channels, even under one claimed scope", () => {
    const c = withCoordinator(new FakeReceiptPort());
    const scope = { sessionDigest: "sha256:one-scope" };
    admit(c, { ...telegramMessage("m1", "chat-9", 71), claim: scope });
    admit(c, { channel: "buzz", nonce: "buzz-message:e1", conversation: undefined, payload: { text: "e1" }, claim: scope });

    const enqueued = c.db.tx(() => enqueueOwnerReply(c.db, c.clock, {
      turnRequestId: "tr_two_channels",
      ledger: "CANONICAL_TURN",
      targetActorId: "actor:x",
      sources: [{ channel: "telegram", nonce: "m1" }, { channel: "buzz", nonce: "buzz-message:e1" }],
      receipt: { authority: "HERMES_TARGET", receiptId: "r", evidenceDigest: "sha256:r", reasonCode: ReasonCode.OK },
    }));

    expect(enqueued).toMatchObject({ allowed: false, reasonCode: ReasonCode.CONVERSATION_TURN_REPLY_UNADDRESSABLE });
    expect(replyRows(c)).toBe(0);
  });

  it("refuses to enqueue outside the transaction that settles the turn", () => {
    const c = withCoordinator(new FakeReceiptPort());
    admit(c, telegramMessage("m1", "chat-9", 71));

    expect(() => enqueueOwnerReply(c.db, c.clock, {
      turnRequestId: "tr_outside",
      ledger: "CANONICAL_TURN",
      targetActorId: "actor:x",
      sources: [{ channel: "telegram", nonce: "m1" }],
      receipt: { authority: "HERMES_TARGET", receiptId: "r", evidenceDigest: "sha256:r", reasonCode: ReasonCode.OK },
    })).toThrow(/inside the transaction that settles its turn/);
    expect(replyRows(c)).toBe(0);
  });
});
