import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { ManualClock } from "../../src/core/clock.ts";
import { digestOf } from "../../src/core/digest.ts";
import type { Decision } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import {
  OWNER_REPLY_OUTBOX_CHANNEL,
  type OwnerReplyAuthority,
  claimOwnerReplyAuthority,
  enqueueOwnerReply,
  ownerReplyFor,
  pendingOwnerReplies,
} from "../../src/conversation/owner-reply-outbox.ts";
import {
  ConversationTurnCoordinator,
  type IngressReceiptSettlement,
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
 * may land without the other, a redelivered receipt adds nothing, one owner message gets at most
 * one reply across both lanes, the item is addressed from the originating row's immutable payload,
 * only a receipt the coordinator verified can settle anything, and `ABORTED` is untouched.
 *
 * The cases named `R1041-…` are the witnesses the #1041 review reproduced against 34727b2a.
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

const target = (db: Fixture["db"], name: string): string => {
  const actorId = `actor:${name}`;
  const sessionId = `runtime:${name}`;
  db.run(
    `INSERT INTO sessions (session_id, incarnation, provider, model, lifecycle, created_at, updated_at)
     VALUES (?, 'inc-1', 'claude', 'opus', 'READY', ?, ?)`,
    [sessionId, NOW, NOW],
  );
  db.run(
    `INSERT INTO conversational_actors
       (actor_id, kind, current_session_id, current_session_incarnation, created_at)
     VALUES (?, 'CEO', ?, 'inc-1', ?)`,
    [actorId, sessionId, NOW],
  );
  db.run(
    `INSERT INTO actor_target_bindings
       (target_binding_id, target_actor_id, executor_kind, target_locator, target_locator_digest, bound_at)
     VALUES (?, ?, 'hermes', ?, ?, ?)`,
    [`bind:${name}`, actorId, `locator:${name}`, `digest:${name}`, NOW],
  );
  db.run(
    `INSERT INTO assignments
       (assignment_id, role_key, role, actor_id, session_id, session_incarnation,
        binding_generation, mode, status, created_at)
     VALUES (?, ?, 'CEO', ?, ?, 'inc-1', 1, 'PREFERRED', 'ACTIVE', ?)`,
    [`asg:${name}`, `CEO:${name}`, actorId, sessionId, NOW],
  );
  db.run(
    `INSERT INTO actor_target_attestations
       (target_attestation_id, target_binding_id, protocol_version, attestation_digest,
        executor_session_id, executor_session_incarnation, binding_generation, assignment_id,
        attested_at)
     VALUES (?, ?, 'v1', ?, ?, 'inc-1', 1, ?, ?)`,
    [`att:${name}`, `bind:${name}`, `attd:${name}`, sessionId, `asg:${name}`, NOW],
  );
  return actorId;
};

/** The identity the ingress lane binds a claim to, for an actor `target` installed. */
const ingressQuery = (turnRequestId: string, actorId: string, name: string, prompt: string): ReceiptLookupQuery => ({
  turnRequestId,
  targetActorId: actorId,
  promptDigest: digestOf(prompt),
  bindingGeneration: 1,
  targetBindingId: `bind:${name}`,
  targetAttestationId: `att:${name}`,
  executorSessionId: `runtime:${name}`,
  executorSessionIncarnation: "inc-1",
});

interface Admission {
  channel: "telegram" | "buzz";
  nonce: string;
  conversation: string | undefined;
  payload: Record<string, unknown>;
  /** The ingress claim the router writes before it materializes the turn, when there is one. */
  claim?: { sessionDigest: string; legacySessionDigest?: string } | undefined;
}

/** The two digests `TelegramIngress.turnIdentityFor` writes for a chat (project and thread elided). */
const telegramScope = (chat: string) => ({
  sessionDigest: digestOf({ projectId: null, chatId: chat, message_thread_id: null, replyRootMessageId: null }),
  legacySessionDigest: digestOf({ channel: "telegram", conversation: chat }),
});

/** The payload `TelegramIngress` admits a message under: text, message id, chat and thread. */
const telegramMessage = (nonce: string, chat: string, messageId: number): Admission => ({
  channel: "telegram",
  nonce,
  conversation: chat,
  payload: { text: `message ${nonce}`, messageId, chatId: chat, messageThreadId: null },
  claim: telegramScope(chat),
});

const buzzMessage = (nonce: string, room: string): Admission => ({
  channel: "buzz",
  nonce,
  conversation: room,
  payload: { type: "BUZZ_MESSAGE", conversation: room, addressedTo: "CEO", mention: null, text: `message ${nonce}` },
  claim: { sessionDigest: digestOf({ channel: "buzz", conversation: room }) },
});

/** Admits through the production `IngressGuard.admit`, so the payload is what ingress recorded. */
const admit = (c: Pick<Fixture, "db" | "clock" | "audit">, message: Admission): void => {
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

const claimWithPermit = (c: Fixture, actorId: string, messages: readonly Admission[], admitFirst = true): TurnPermit => {
  if (admitFirst) for (const message of messages) admit(c, message);
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

const claimTurn = (c: Fixture, actorId: string, messages: readonly Admission[]): string =>
  claimWithPermit(c, actorId, messages).turnRequestId;

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

const ingressReceipt = (query: ReceiptLookupQuery, outcome: "COMPLETED" | "ABORTED"): ReceiptLookupResult => ({
  found: true,
  outcome,
  receiptId: `hermes:${query.turnRequestId}`,
  evidenceDigest: `sha256:reply-${query.turnRequestId}`,
  reasonCode: outcome === "COMPLETED" ? ReasonCode.OK : ReasonCode.HERMES_AGENT_RUN_EXCEPTION,
  ...query,
});

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

const replyRows = (c: Pick<Fixture, "db">): number =>
  c.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM inbound_messages WHERE channel = ?`, [
    OWNER_REPLY_OUTBOX_CHANNEL,
  ])!.n;

const claimOf = (c: Pick<Fixture, "db">, channel: string, nonce: string): Record<string, unknown> =>
  JSON.parse(c.db.get<{ turn_claim_json: string }>(
    `SELECT turn_claim_json FROM inbound_messages WHERE channel = ? AND nonce = ?`,
    [channel, nonce],
  )!.turn_claim_json) as Record<string, unknown>;

/** Rewrites only the claim's chat alias, which the identity trigger does not freeze. */
const rewriteChatAlias = (c: Pick<Fixture, "db">, channel: string, nonce: string, chat: string): void => {
  const claim = claimOf(c, channel, nonce);
  c.db.run(`UPDATE inbound_messages SET turn_claim_json = ? WHERE channel = ? AND nonce = ?`, [
    JSON.stringify({ ...claim, legacySessionDigest: digestOf({ channel: "telegram", conversation: chat }) }),
    channel,
    nonce,
  ]);
};

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

/**
 * A Telegram ingress claim bound to a Hermes receipt identity, as the router writes it, plus the
 * production reconcile wiring (`telegram-polling.ts`): the coordinator's settlement handed to the
 * guard unchanged.
 */
const ingressLane = (c: Fixture, actorId: string, nonce: string, turnRequestId: string, chat = "chat-9") => {
  const prompt = `prompt ${nonce}`;
  const query = ingressQuery(turnRequestId, actorId, actorId.replace("actor:", ""), prompt);
  const guard = new IngressGuard(
    c.db,
    c.clock,
    c.audit,
    { telegram: { allowedActors: ["owner"], allowedConversations: [chat] } },
    { receiptIdentityForClaim: (identity) => ({ ...query, turnRequestId: identity.turnRequestId }) },
  );
  if (!c.db.get(`SELECT 1 FROM inbound_messages WHERE channel = 'telegram' AND nonce = ?`, [nonce])) {
    const admitted = guard.admit({
      channel: "telegram",
      actor: "owner",
      conversation: chat,
      nonce,
      payload: { text: prompt, messageId: 7, chatId: chat, messageThreadId: null },
    });
    if (!admitted.allowed) throw new Error(`fixture could not admit: ${admitted.reasonCode}`);
  }
  const identity: TurnIdentity = {
    turnRequestId,
    ...telegramScope(chat),
    promptDigest: query.promptDigest,
    bindingDigest: digestOf({ bindingGeneration: 1 }),
  };
  const claimed = guard.claimTurn("telegram", nonce, identity);
  if (!claimed.allowed) throw new Error(`fixture could not claim: ${claimed.reasonCode}`);
  const stored = guard.receiptIdentityForClaim("telegram", nonce);
  if (!stored) throw new Error("fixture claim carries no receipt identity");
  const reconcile = () => c.coordinator.reconcileIngressReceipt(
    { channel: "telegram", nonce },
    stored,
    (settlement) => guard.completeClaimFromHermesReceipt(settlement),
  );
  const result = () => c.db.get<{ result_json: string | null }>(
    `SELECT result_json FROM inbound_messages WHERE channel = 'telegram' AND nonce = ?`,
    [nonce],
  )!.result_json;
  return { guard, stored, reconcile, claim: () => claimOf(c, "telegram", nonce), result };
};

describe("a COMPLETED receipt on the canonical ledger", () => {
  it("settles the turn and stores one owner reply addressed to the Telegram message it answers", async () => {
    const port = new FakeReceiptPort();
    const c = withCoordinator(port);
    const actorId = target(c.db, "telegram");
    const turn = claimTurn(c, actorId, [telegramMessage("m1", "chat-9", 71), telegramMessage("m2", "chat-9", 72)]);
    port.answer(turn, receiptFor(c, turn, "COMPLETED"));

    const summary = await c.coordinator.reconcileUnresolved();

    expect(summary).toEqual({ swept: 1, settled: 1, unresolved: 0, failed: 0 });
    expect(stateOf(c, turn)).toEqual({ lifecycle_state: "SETTLED", outcome_kind: "COMPLETED" });
    expect(ownerReplyFor(c.db, turn)).toEqual({
      turnRequestId: turn,
      ledger: "CANONICAL_TURN",
      targetActorId: actorId,
      sources: [{ channel: "telegram", nonce: "m1" }, { channel: "telegram", nonce: "m2" }],
      address: { channel: "telegram", conversation: "chat-9", threadId: null, sourceNonce: "m2", replyToMessageId: 72 },
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

  it("addresses a Buzz turn to the room its signed envelope names", async () => {
    const port = new FakeReceiptPort();
    const c = withCoordinator(port);
    const actorId = target(c.db, "buzz");
    const turn = claimTurn(c, actorId, [buzzMessage("buzz-message:e1", "room-7")]);
    port.answer(turn, receiptFor(c, turn, "COMPLETED"));

    await c.coordinator.reconcileUnresolved();

    expect(ownerReplyFor(c.db, turn)?.address).toEqual({
      channel: "buzz",
      conversation: "room-7",
      threadId: null,
      sourceNonce: "buzz-message:e1",
      replyToMessageId: null,
    });
  });

  it("rolls the settlement back when the reply insert fails, and completes once it can be written", async () => {
    const port = new FakeReceiptPort();
    const c = withCoordinator(port);
    const actorId = target(c.db, "rollback");
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
    const actorId = target(c.db, "split");
    const split = claimTurn(c, actorId, [telegramMessage("m1", "chat-9", 71), telegramMessage("m2", "chat-10", 72)]);
    port.answer(split, receiptFor(c, split, "COMPLETED"));

    const summary = await c.coordinator.reconcileUnresolved();

    expect(summary).toEqual({ swept: 1, settled: 0, unresolved: 1, failed: 0 });
    expect(stateOf(c, split)).toEqual({ lifecycle_state: "IN_DOUBT", outcome_kind: null });
    expect(observationsOf(c, split)).toBe(0);
    expect(replyRows(c)).toBe(0);
  });

  /**
   * R1041-01: a claimed scope is not an address. Each row below carries the turn claim the router
   * writes, so a reader that accepts the claim's digests in place of a destination settles them.
   */
  it.each<[string, Admission]>([
    ["R1041-01 a Telegram message whose admitted payload names no chat", {
      channel: "telegram",
      nonce: "update:81",
      conversation: "chat-9",
      payload: { text: "no chat", messageId: 81 },
      claim: { sessionDigest: telegramScope("chat-9").sessionDigest },
    }],
    ["R1041-01 a Buzz message whose envelope names no room", {
      channel: "buzz",
      nonce: "buzz-message:e9",
      conversation: undefined,
      payload: { type: "BUZZ_MESSAGE", addressedTo: "CEO", mention: null, text: "no room" },
      claim: { sessionDigest: digestOf({ channel: "buzz", conversation: "room-7" }) },
    }],
    ["R1041-01 a Telegram message with no message id to reply to", {
      channel: "telegram",
      nonce: "update:82",
      conversation: "chat-9",
      payload: { text: "no message id", chatId: "chat-9", messageThreadId: null },
      claim: telegramScope("chat-9"),
    }],
  ])("leaves the turn unsettled for %s", async (_name, message) => {
    const port = new FakeReceiptPort();
    const c = withCoordinator(port);
    const actorId = target(c.db, "unaddressable");
    const turn = claimTurn(c, actorId, [message]);
    port.answer(turn, receiptFor(c, turn, "COMPLETED"));

    const summary = await c.coordinator.reconcileUnresolved();

    expect(summary).toEqual({ swept: 1, settled: 0, unresolved: 1, failed: 0 });
    expect(stateOf(c, turn)).toEqual({ lifecycle_state: "IN_DOUBT", outcome_kind: null });
    expect(replyRows(c)).toBe(0);
  });

  it("R1041-01 addresses the reply from the admitted payload, not from a rewritten chat alias", async () => {
    const port = new FakeReceiptPort();
    const c = withCoordinator(port);
    const actorId = target(c.db, "alias");
    const turn = claimTurn(c, actorId, [telegramMessage("m1", "chat-9", 71)]);
    rewriteChatAlias(c, "telegram", "m1", "chat-10");
    port.answer(turn, receiptFor(c, turn, "COMPLETED"));

    await c.coordinator.reconcileUnresolved();

    const item = ownerReplyFor(c.db, turn);
    expect(item?.address).toMatchObject({ channel: "telegram", conversation: "chat-9", replyToMessageId: 71 });
    expect(JSON.stringify(item)).not.toContain(digestOf({ channel: "telegram", conversation: "chat-10" }));
  });

  it("stores one reply when two overlapping sweeps settle the same receipt", async () => {
    const port = new FakeReceiptPort();
    const c = withCoordinator(port);
    const actorId = target(c.db, "overlap");
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
    const actorId = target(c.db, "elsewhere");
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

  it("R1041-02 completes a turn whose message ingress already answered without queueing a second reply", async () => {
    const port = new FakeReceiptPort();
    const c = withCoordinator(port);
    const actorId = target(c.db, "answered");
    const turn = claimTurn(c, actorId, [telegramMessage("m1", "chat-9", 71)]);
    // The router's own reply lifecycle for the message: reserved, then accepted by Telegram, which
    // writes `sent: true` and the claim's `repliedAt` together.
    const guard = new IngressGuard(c.db, c.clock, c.audit, {
      telegram: { allowedActors: ["owner"], allowedConversations: ["chat-9"] },
    });
    const reply = { chatId: "chat-9", text: "the CEO's answer", replyToMessageId: 71, correlationId: "corr-m1" };
    const reserved = guard.recordResultIf("telegram", "m1", {
      kind: "TELEGRAM_WORKFLOW", phase: "REPLIED", reply, sent: false, deliveryStatus: "PENDING", turnAnswered: true,
    }, "AVAILABLE");
    expect(reserved.allowed).toBe(true);
    const delivered = guard.completeReplyAndResolveTurn("telegram", "m1", {
      kind: "TELEGRAM_WORKFLOW", phase: "REPLIED", reply, sent: true, deliveryStatus: "APPLIED", turnAnswered: true,
    }, "ANSWERED");
    expect(delivered.allowed).toBe(true);
    expect(claimOf(c, "telegram", "m1")).toHaveProperty("repliedAt");
    port.answer(turn, receiptFor(c, turn, "COMPLETED"));

    const summary = await c.coordinator.reconcileUnresolved();

    expect(summary).toEqual({ swept: 1, settled: 1, unresolved: 0, failed: 0 });
    expect(stateOf(c, turn)).toEqual({ lifecycle_state: "SETTLED", outcome_kind: "COMPLETED" });
    expect(replyRows(c), "an answered message was owed a second reply").toBe(0);
  });

  it("R1041-02 owes nothing new for a message whose reply the transport already accepted", async () => {
    const port = new FakeReceiptPort();
    const c = withCoordinator(port);
    const actorId = target(c.db, "replied");
    const turn = claimTurn(c, actorId, [buzzMessage("buzz-message:e3", "room-7")]);
    // The Buzz path's own record that ACP handed the turn a reply: `repliedAt`, and nothing else.
    const guard = new IngressGuard(c.db, c.clock, c.audit, { buzz: { allowedActors: ["owner"] } });
    expect(guard.resolveTurn("buzz", "buzz-message:e3").allowed).toBe(true);
    port.answer(turn, receiptFor(c, turn, "COMPLETED"));

    const summary = await c.coordinator.reconcileUnresolved();

    expect(summary).toEqual({ swept: 1, settled: 1, unresolved: 0, failed: 0 });
    expect(replyRows(c), "a message the transport already answered was owed a second reply").toBe(0);
  });

  it("R1041-02 owes nothing new while a CEO answer for the message is still in the transport's hands", async () => {
    const port = new FakeReceiptPort();
    const c = withCoordinator(port);
    const actorId = target(c.db, "in-flight");
    const turn = claimTurn(c, actorId, [telegramMessage("m1", "chat-9", 71)]);
    // Reserved and not yet acknowledged: an ambiguous send is the ingress lifecycle's to finish,
    // and a second copy queued beside it is how the owner gets the answer twice.
    const guard = new IngressGuard(c.db, c.clock, c.audit, {
      telegram: { allowedActors: ["owner"], allowedConversations: ["chat-9"] },
    });
    const reserved = guard.recordResultIf("telegram", "m1", {
      kind: "TELEGRAM_WORKFLOW",
      phase: "REPLIED",
      reply: { chatId: "chat-9", text: "the CEO's answer", replyToMessageId: 71, correlationId: "corr-m1" },
      sent: false,
      deliveryStatus: "PENDING",
      turnAnswered: true,
    }, "AVAILABLE");
    expect(reserved.allowed).toBe(true);
    expect(claimOf(c, "telegram", "m1")).not.toHaveProperty("repliedAt");
    port.answer(turn, receiptFor(c, turn, "COMPLETED"));

    const summary = await c.coordinator.reconcileUnresolved();

    expect(summary).toEqual({ swept: 1, settled: 1, unresolved: 0, failed: 0 });
    expect(replyRows(c), "an answer still being sent was owed a second reply").toBe(0);
  });

  it("R1041-02 owes one reply when a canonical batch settles before an ingress claim on one of its messages", async () => {
    const port = new FakeReceiptPort();
    const c = withCoordinator(port);
    const actorId = target(c.db, "overlap-batch");
    const m1 = telegramMessage("update:91", "chat-9", 91);
    const m2 = telegramMessage("update:92", "chat-9", 92);
    for (const message of [m1, m2]) admit(c, { ...message, claim: undefined });
    const lane = ingressLane(c, actorId, "update:91", "ingress-turn-91");
    const canonical = claimWithPermit(c, actorId, [m1, m2], false).turnRequestId;
    port.answer(canonical, receiptFor(c, canonical, "COMPLETED"));
    port.answer("ingress-turn-91", ingressReceipt(lane.stored, "COMPLETED"));

    await c.coordinator.reconcileUnresolved();
    const ingress = await lane.reconcile();

    expect(stateOf(c, canonical)).toEqual({ lifecycle_state: "SETTLED", outcome_kind: "COMPLETED" });
    expect(ingress.allowed, ingress.allowed ? "" : `${ingress.reasonCode}: ${ingress.message}`).toBe(true);
    expect(lane.claim()).toMatchObject({ settlement: "REPLY_OUTBOX" });
    expect(pendingOwnerReplies(c.db).map((item) => item.turnRequestId)).toEqual([canonical]);
  });

  it("R1041-02 refuses a canonical batch that only partly overlaps a message an ingress claim already owes", async () => {
    const port = new FakeReceiptPort();
    const c = withCoordinator(port);
    const actorId = target(c.db, "partial-batch");
    const m1 = telegramMessage("update:93", "chat-9", 93);
    const m2 = telegramMessage("update:94", "chat-9", 94);
    for (const message of [m1, m2]) admit(c, { ...message, claim: undefined });
    const lane = ingressLane(c, actorId, "update:93", "ingress-turn-93");
    const canonical = claimWithPermit(c, actorId, [m1, m2], false).turnRequestId;
    port.answer(canonical, receiptFor(c, canonical, "COMPLETED"));
    port.answer("ingress-turn-93", ingressReceipt(lane.stored, "COMPLETED"));

    expect((await lane.reconcile()).allowed).toBe(true);
    const summary = await c.coordinator.reconcileUnresolved();

    expect(summary).toMatchObject({ settled: 0, unresolved: 1 });
    expect(stateOf(c, canonical)).toEqual({ lifecycle_state: "IN_DOUBT", outcome_kind: null });
    expect(pendingOwnerReplies(c.db).map((item) => item.turnRequestId)).toEqual(["ingress-turn-93"]);
  });

  it("settles an ABORTED receipt exactly as before, with no reply owed", async () => {
    const port = new FakeReceiptPort();
    const c = withCoordinator(port);
    const actorId = target(c.db, "aborted");
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
  const TURN = "ingress-turn-1";
  const NONCE = "update:7";

  const setUp = () => {
    const port = new FakeReceiptPort();
    const c = withCoordinator(port);
    const actorId = target(c.db, "ingress");
    const lane = ingressLane(c, actorId, NONCE, TURN);
    return { port, c, ...lane };
  };

  it("settles the ingress claim and stores one owner reply addressed to the owner's message", async () => {
    const { port, c, stored, reconcile, claim, result } = setUp();
    port.answer(TURN, ingressReceipt(stored, "COMPLETED"));

    const settled = await reconcile();

    expect(settled.allowed, settled.allowed ? "" : `${settled.reasonCode}: ${settled.message}`).toBe(true);
    expect(claim()).toMatchObject({
      settledAt: NOW,
      settlement: "REPLY_OUTBOX",
      hermesReceipt: {
        outcome: "COMPLETED",
        receiptId: `hermes:${TURN}`,
        evidenceDigest: `sha256:reply-${TURN}`,
        reasonCode: ReasonCode.OK,
      },
    });
    expect(claim()).not.toHaveProperty("noReplyAt");
    expect(claim()).not.toHaveProperty("repliedAt");
    expect(JSON.parse(result() ?? "null")).toEqual({ kind: "TELEGRAM_REPLY_OUTBOX" });
    expect(ownerReplyFor(c.db, TURN)).toMatchObject({
      ledger: "INGRESS_CLAIM",
      targetActorId: stored.targetActorId,
      sources: [{ channel: "telegram", nonce: NONCE }],
      address: { channel: "telegram", conversation: "chat-9", threadId: null, sourceNonce: NONCE, replyToMessageId: 7 },
      receipt: { receiptId: `hermes:${TURN}`, evidenceDigest: `sha256:reply-${TURN}` },
      status: "PENDING",
    });
  });

  it("adds nothing when the same receipt settles the claim again", async () => {
    const { port, c, stored, reconcile } = setUp();
    port.answer(TURN, ingressReceipt(stored, "COMPLETED"));

    const first = await reconcile();
    const second = await reconcile();

    expect(first.allowed).toBe(true);
    expect(second).toMatchObject({ allowed: true, reasonCode: ReasonCode.INGRESS_REPLAY_IGNORED });
    expect(replyRows(c)).toBe(1);
  });

  it("rolls the ingress settlement back when the reply insert fails", async () => {
    const { port, c, stored, reconcile, claim, result } = setUp();
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

  it("R1041-01 addresses the reply from the admitted payload, not from a rewritten chat alias", async () => {
    const { port, c, stored, reconcile } = setUp();
    rewriteChatAlias(c, "telegram", NONCE, "chat-10");
    port.answer(TURN, ingressReceipt(stored, "COMPLETED"));

    expect((await reconcile()).allowed).toBe(true);

    const item = ownerReplyFor(c.db, TURN);
    expect(item?.address).toMatchObject({ channel: "telegram", conversation: "chat-9", replyToMessageId: 7 });
    expect(JSON.stringify(item)).not.toContain(digestOf({ channel: "telegram", conversation: "chat-10" }));
  });

  it("R1041-03 refuses a caller-built receipt handed straight to the guard", () => {
    const { c, guard, stored, claim } = setUp();
    // The pre-review signature, called as a caller holding the guard would: no lookup ran.
    const settle = guard.completeClaimFromHermesReceipt as unknown as (...args: unknown[]) => Decision<void>;
    const forged = settle.call(guard, "telegram", NONCE, stored, {
      outcome: "COMPLETED",
      receiptId: "forged-receipt",
      evidenceDigest: "sha256:forged",
      reasonCode: ReasonCode.OK,
    });

    expect(forged.allowed).toBe(false);
    expect(claim()).not.toHaveProperty("settledAt");
    expect(claim()).not.toHaveProperty("hermesReceipt");
    expect(replyRows(c)).toBe(0);
  });

  it("R1041-03 refuses a settlement shaped like the coordinator's but built by a caller", () => {
    const { c, guard, stored, claim } = setUp();
    const shaped: IngressReceiptSettlement = {
      channel: "telegram",
      nonce: NONCE,
      query: stored,
      receipt: { outcome: "COMPLETED", receiptId: "shaped", evidenceDigest: "sha256:shaped", reasonCode: ReasonCode.OK },
    };

    expect(guard.completeClaimFromHermesReceipt(shaped).allowed).toBe(false);
    expect(claim()).not.toHaveProperty("settledAt");
    expect(replyRows(c)).toBe(0);
  });

  it("R1041-03 commits nothing when the callback queues a reply without settling the claim", async () => {
    const { port, c, stored, claim } = setUp();
    port.answer(TURN, ingressReceipt(stored, "COMPLETED"));
    // The pre-review enqueue signature, called from inside the callback's transaction.
    const enqueue = enqueueOwnerReply as unknown as (...args: unknown[]) => unknown;

    const settled = await c.coordinator.reconcileIngressReceipt({ channel: "telegram", nonce: NONCE }, stored, () => {
      try {
        enqueue(c.db, c.clock, {
          turnRequestId: TURN,
          ledger: "INGRESS_CLAIM",
          targetActorId: stored.targetActorId,
          sources: [{ channel: "telegram", nonce: NONCE }],
          receipt: { authority: "HERMES_TARGET", receiptId: `hermes:${TURN}`, evidenceDigest: `sha256:reply-${TURN}`, reasonCode: ReasonCode.OK },
        });
      } catch { /* refused: only the coordinator holds the owner-reply authority */ }
      return { allowed: true, reasonCode: ReasonCode.OK, evidence: {}, value: undefined };
    });

    expect(settled.allowed).toBe(false);
    expect(claim()).not.toHaveProperty("settledAt");
    expect(replyRows(c), "a reply was committed beside an unsettled claim").toBe(0);
  });

  it("refuses a callback that settles the claim by a different receipt than the one verified", async () => {
    const { port, c, stored, claim } = setUp();
    port.answer(TURN, ingressReceipt(stored, "COMPLETED"));

    const settled = await c.coordinator.reconcileIngressReceipt({ channel: "telegram", nonce: NONCE }, stored, () => {
      c.db.run(`UPDATE inbound_messages SET turn_claim_json = ? WHERE channel = 'telegram' AND nonce = ?`, [
        JSON.stringify({
          ...claim(),
          settledAt: NOW,
          settlement: "REPLY_OUTBOX",
          hermesReceipt: { outcome: "COMPLETED", receiptId: "another", evidenceDigest: "sha256:another", reasonCode: ReasonCode.OK },
        }),
        NONCE,
      ]);
      return { allowed: true, reasonCode: ReasonCode.OK, evidence: {}, value: undefined };
    });

    expect(settled).toMatchObject({ allowed: false, reasonCode: ReasonCode.INGRESS_TURN_OUTCOME_UNKNOWN });
    expect(claim()).not.toHaveProperty("settledAt");
    expect(replyRows(c)).toBe(0);
  });

  it("spends the settlement: one captured from the callback settles nothing afterwards", async () => {
    const { port, c, guard, stored, claim } = setUp();
    port.answer(TURN, ingressReceipt(stored, "COMPLETED"));
    let captured: IngressReceiptSettlement | null = null;

    const refused = await c.coordinator.reconcileIngressReceipt({ channel: "telegram", nonce: NONCE }, stored, (settlement) => {
      captured = settlement;
      return { allowed: false, reasonCode: ReasonCode.CONFLICT, evidence: {}, message: "declined" };
    });
    expect(refused.allowed).toBe(false);
    if (captured === null) throw new Error("the callback was never handed a settlement");

    expect(guard.completeClaimFromHermesReceipt(captured).allowed).toBe(false);
    expect(claim()).not.toHaveProperty("settledAt");
    expect(replyRows(c)).toBe(0);
  });

  it("settles an ABORTED receipt exactly as before, with no reply owed", async () => {
    const { port, c, stored, reconcile, claim, result } = setUp();
    port.answer(TURN, ingressReceipt(stored, "ABORTED"));

    const settled = await reconcile();

    expect(settled.allowed).toBe(true);
    expect(claim()).toMatchObject({
      noReplyAt: NOW,
      hermesReceipt: {
        receiptId: `hermes:${TURN}`,
        evidenceDigest: `sha256:reply-${TURN}`,
        reasonCode: ReasonCode.HERMES_AGENT_RUN_EXCEPTION,
      },
    });
    expect(claim()).not.toHaveProperty("settledAt");
    expect(JSON.parse(result() ?? "null")).toEqual({ kind: "TELEGRAM_NO_REPLY" });
    expect(replyRows(c)).toBe(0);
  });
});

describe("the owner-reply lane", () => {
  /** A database whose owner-reply authority the test holds, with no coordinator claiming it first. */
  const withLane = () => {
    const db = openDb(join(stateDir(), "state.sqlite"));
    const clock = new ManualClock(NOW);
    const audit = new AuditLog(db, clock);
    return { db, clock, audit, authority: claimOwnerReplyAuthority(db) };
  };
  const receipt = {
    authority: "HERMES_TARGET" as const,
    receiptId: "r-1",
    evidenceDigest: "sha256:r-1",
    reasonCode: ReasonCode.OK,
  };
  const enqueueAs = (
    lane: ReturnType<typeof withLane>,
    authority: OwnerReplyAuthority,
    turnRequestId: string,
    nonces: readonly string[],
    overrides: Partial<typeof receipt> = {},
  ) => lane.db.tx(() => enqueueOwnerReply(authority, lane.db, lane.clock, {
    turnRequestId,
    ledger: "CANONICAL_TURN",
    targetActorId: "actor:x",
    sources: nonces.map((nonce) => ({ channel: "telegram", nonce })),
    receipt: { ...receipt, ...overrides },
  }));

  it("answers each owner message once: a redelivery is a no-op, a covered message owes nothing new, a partial overlap is refused", () => {
    const lane = withLane();
    admit(lane, telegramMessage("m1", "chat-9", 71));
    admit(lane, telegramMessage("m2", "chat-9", 72));

    expect(enqueueAs(lane, lane.authority, "tr_first", ["m1"])).toMatchObject({ allowed: true, value: { status: "ENQUEUED" } });
    expect(enqueueAs(lane, lane.authority, "tr_first", ["m1"])).toMatchObject({ allowed: true, value: { status: "REDELIVERED" } });
    expect(enqueueAs(lane, lane.authority, "tr_first", ["m1"], { evidenceDigest: "sha256:a-different-reply" }))
      .toMatchObject({ allowed: false, reasonCode: ReasonCode.CONVERSATION_TURN_REPLY_CONFLICT });
    expect(enqueueAs(lane, lane.authority, "tr_second", ["m1"])).toMatchObject({ allowed: true, value: { status: "ALREADY_ANSWERED" } });
    expect(enqueueAs(lane, lane.authority, "tr_third", ["m1", "m2"]))
      .toMatchObject({ allowed: false, reasonCode: ReasonCode.CONVERSATION_TURN_REPLY_CONFLICT });
    expect(replyRows(lane)).toBe(1);
    expect(ownerReplyFor(lane.db, "tr_first")?.receipt.evidenceDigest).toBe("sha256:r-1");
  });

  it("refuses a turn whose messages arrived on two channels", () => {
    const lane = withLane();
    admit(lane, telegramMessage("m1", "chat-9", 71));
    admit(lane, buzzMessage("buzz-message:e1", "chat-9"));

    const enqueued = lane.db.tx(() => enqueueOwnerReply(lane.authority, lane.db, lane.clock, {
      turnRequestId: "tr_two_channels",
      ledger: "CANONICAL_TURN",
      targetActorId: "actor:x",
      sources: [{ channel: "telegram", nonce: "m1" }, { channel: "buzz", nonce: "buzz-message:e1" }],
      receipt,
    }));

    expect(enqueued).toMatchObject({ allowed: false, reasonCode: ReasonCode.CONVERSATION_TURN_REPLY_UNADDRESSABLE });
    expect(replyRows(lane)).toBe(0);
  });

  it("refuses a payload that is not the one ingress admitted", () => {
    const lane = withLane();
    lane.db.run(
      `INSERT INTO inbound_messages (channel, nonce, actor, received_at, payload_json) VALUES ('telegram', 'raw', 'owner', ?, ?)`,
      [NOW, JSON.stringify({ text: "never admitted", messageId: 5, chatId: "chat-elsewhere", messageThreadId: null })],
    );

    expect(enqueueAs(lane, lane.authority, "tr_raw", ["raw"]))
      .toMatchObject({ allowed: false, reasonCode: ReasonCode.CONVERSATION_TURN_REPLY_UNADDRESSABLE });
    expect(replyRows(lane)).toBe(0);
  });

  it("refuses to enqueue outside the transaction that settles the turn", () => {
    const lane = withLane();
    admit(lane, telegramMessage("m1", "chat-9", 71));

    expect(() => enqueueOwnerReply(lane.authority, lane.db, lane.clock, {
      turnRequestId: "tr_outside",
      ledger: "CANONICAL_TURN",
      targetActorId: "actor:x",
      sources: [{ channel: "telegram", nonce: "m1" }],
      receipt,
    })).toThrow(/inside the transaction that settles its turn/);
    expect(replyRows(lane)).toBe(0);
  });

  it("refuses a caller that does not hold this database's owner-reply authority, and issues it once", () => {
    const lane = withLane();
    admit(lane, telegramMessage("m1", "chat-9", 71));
    const imitation = Object.freeze({ ownerReplyAuthorityFor: lane.db.identity });

    expect(() => enqueueAs(lane, imitation, "tr_imitation", ["m1"])).toThrow(/owner-reply authority/);
    expect(() => claimOwnerReplyAuthority(lane.db)).toThrow(/already issued/);
    expect(replyRows(lane)).toBe(0);
  });
});
