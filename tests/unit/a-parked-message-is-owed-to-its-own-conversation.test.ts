import { afterAll, describe, expect, it } from "vitest";

import { startDaemonTelegramListener } from "../../src/daemon/agentcpd.ts";
import { TelegramInterruption } from "../../src/ingress/telegram-router.ts";
import { IngressGuard, type TurnIdentity } from "../../src/ingress/ingress-guard.ts";
import { digestOf } from "../../src/core/digest.ts";
import type {
  TelegramBotTransport,
  TelegramLongPollConfig,
} from "../../src/ingress/telegram-polling.ts";
import { TelegramIngress, type TelegramUpdate } from "../../src/ingress/telegram.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { makeHarness, TEST_OWNER } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * What a parked message is owed, and to whom (#631).
 *
 * A message that arrives while this conversation has an unresolved turn is parked: admitted,
 * kept, and answered with an advisory rather than run. Until now nothing recorded *which*
 * conversation it was parked for, because the admitted row does not carry one -- `admit` is
 * handed `conversation` and writes it only to the audit trail. Its `actor` column is the sender,
 * which is one person across every chat they are allowlisted in, so it cannot separate two chats.
 *
 * That is the whole reason the batch could not be built. The CEO's ruling on #628/#631 is
 * explicit that a batch never spans a conversation, and a reader with only `actor` to go on would
 * merge two chats on its first run.
 *
 * These cases enter where production enters -- real updates through the long-poll listener -- and
 * read back through the same reader the next claim will use. A test that called `parkForBatch`
 * directly would pass against a router that never calls it, which is the defect this slice is
 * one half of.
 */
const SECRET = "telegram-configured-secret";
const OWNER_ID = "424242";
const CHAT_A = "-100111";
const CHAT_B = "-100222";

// The conversation identity the product uses, spelled the way `TelegramIngress.turnIdentityFor`
// spells it. Restated here on purpose: if that formula changes, these cases must fail rather than
// keep passing against a digest nothing in production computes any more.
const conversationOf = (chatId: string): string =>
  digestOf({ channel: "telegram", conversation: chatId });

const canonicalConversationOf = (chatId: string): string =>
  digestOf({
    projectId: null,
    chatId,
    message_thread_id: null,
    replyRootMessageId: null,
  });

const telegramConfig: TelegramLongPollConfig = {
  botToken: "telegram-test-token",
  webhookSecret: SECRET,
  allowedChatIds: [CHAT_A, CHAT_B],
  allowedOwnerIds: [OWNER_ID],
};

const update = (text: string, updateId: number, chatId: string): TelegramUpdate => ({
  update_id: updateId,
  message: {
    message_id: updateId,
    date: 1_700_000_000,
    text,
    from: { id: Number(OWNER_ID), username: "owner" },
    chat: { id: Number(chatId) },
  },
});

/** The minimum a listener needs: hand it the queued updates once, and accept every reply. */
class OneShotTransport implements TelegramBotTransport {
  readonly redeliveryRetentionMs = 24 * 60 * 60 * 1000;
  updates: TelegramUpdate[] = [];
  #handed = false;

  async getUpdates(): Promise<readonly TelegramUpdate[]> {
    if (this.#handed) return [];
    this.#handed = true;
    return this.updates;
  }

  async sendMessage(): Promise<void> {
    // The reply is not what these cases measure, and a transport that refused it would stop the
    // route before it parked.
  }
}

const readerFor = (harness: ReturnType<typeof makeHarness>) =>
  new IngressGuard(harness.cp.db, harness.cp.clock, harness.cp.audit, {
    telegram: {
      allowedActors: [OWNER_ID],
      allowedConversations: [CHAT_A, CHAT_B],
      recoverInFlight: true,
    },
  });

describe("a parked message is owed to its own conversation", () => {
  it("uses project, chat, thread, and reply root as the canonical batch scope", () => {
    const harness = makeHarness({
      ownerIdentities: [TEST_OWNER, { channel: "telegram", actor: OWNER_ID }],
    });
    const ingress = new TelegramIngress(readerFor(harness), { webhookSecret: SECRET });
    const identityFor = ingress.turnIdentityFor.bind(ingress) as unknown as (
      update: TelegramUpdate,
      text: string,
      bindingGeneration: number | null,
      projectId: string | null,
    ) => TurnIdentity;
    const scopedUpdate = (threadId: number, replyRootMessageId: number): TelegramUpdate => {
      const value = update("same owner text", 700, CHAT_A) as TelegramUpdate & {
        message: NonNullable<TelegramUpdate["message"]> & { message_thread_id: number };
      };
      value.message.message_thread_id = threadId;
      value.message.reply_to_message = { message_id: replyRootMessageId };
      return value;
    };

    const base = identityFor(scopedUpdate(11, 21), "same owner text", null, "project-a");
    const otherProject = identityFor(scopedUpdate(11, 21), "same owner text", null, "project-b");
    const otherThread = identityFor(scopedUpdate(12, 21), "same owner text", null, "project-a");
    const otherRoot = identityFor(scopedUpdate(11, 22), "same owner text", null, "project-a");

    expect(base.sessionDigest).toBe(digestOf({
      projectId: "project-a",
      chatId: CHAT_A,
      message_thread_id: 11,
      replyRootMessageId: 21,
    }));
    expect(new Set([
      base.sessionDigest,
      otherProject.sessionDigest,
      otherThread.sessionDigest,
      otherRoot.sessionDigest,
    ]).size).toBe(4);
  });

  it("keeps a legacy chat-only unresolved turn visible without assigning it the new scope", async () => {
    const harness = makeHarness({
      ownerIdentities: [TEST_OWNER, { channel: "telegram", actor: OWNER_ID }],
    });
    const guard = readerFor(harness);
    expect(guard.admit({
      channel: "telegram",
      actor: OWNER_ID,
      conversation: CHAT_A,
      nonce: "update:710",
      payload: { text: "legacy unresolved", messageId: 710 },
    }).allowed).toBe(true);
    expect(guard.claimTurn("telegram", "update:710", {
      turnRequestId: "legacy-turn-710",
      sessionDigest: conversationOf(CHAT_A),
      promptDigest: digestOf("legacy unresolved"),
      bindingDigest: digestOf({ bindingGeneration: null }),
    }).allowed).toBe(true);

    const next = update("new scoped message", 711, CHAT_A);
    next.message!.message_thread_id = 31;
    next.message!.reply_to_message = { message_id: 41 };
    const transport = new OneShotTransport();
    transport.updates = [next];
    let executions = 0;
    const listener = await startDaemonTelegramListener(
      harness.cp,
      { ...telegramConfig, defaultProjectId: "project-a" },
      { handleOperator: async () => ({ ok: true }) } as never,
      {
        transport,
        start: false,
        onDirect: async () => {
          executions += 1;
          return "must remain parked";
        },
      },
    );
    try {
      const cycle = await listener.service.pollOnce();
      await listener.service.pendingTurnsSettled();
      await cycle.settled();
    } finally {
      await listener.close();
    }

    const canonicalScope = digestOf({
      projectId: "project-a",
      chatId: CHAT_A,
      message_thread_id: 31,
      replyRootMessageId: 41,
    });
    expect(executions, "the legacy unresolved turn became invisible to the canonical reader").toBe(0);
    expect(guard.pendingOwnerMessages(canonicalScope).map((item) => item.nonce)).toEqual([
      "update:711",
    ]);
    expect(guard.unresolvedTurns("telegram", conversationOf(CHAT_A))).toHaveLength(1);
  });

  it("uses SQLite arrival sequence to keep same-millisecond updates in arrival order", () => {
    const harness = makeHarness({
      ownerIdentities: [TEST_OWNER, { channel: "telegram", actor: OWNER_ID }],
    });
    const guard = readerFor(harness);
    const scope = "canonical-same-millisecond-scope";
    for (const [nonce, messageId] of [["update:9", 109], ["update:10", 110]] as const) {
      expect(guard.admit({
        channel: "telegram",
        actor: OWNER_ID,
        conversation: CHAT_A,
        nonce,
        payload: { text: nonce, messageId },
      }).allowed).toBe(true);
      guard.parkForBatch(nonce, scope);
    }

    const pending = guard.pendingOwnerMessages(scope) as unknown as ReadonlyArray<{
      nonce: string;
      arrivalSequence?: number;
    }>;
    expect(pending.map((item) => item.nonce)).toEqual(["update:9", "update:10"]);
    expect(pending.map((item) => item.arrivalSequence)).toEqual([
      expect.any(Number),
      expect.any(Number),
    ]);
    expect(pending[0]!.arrivalSequence!).toBeLessThan(pending[1]!.arrivalSequence!);
  });

  it("preserves exact empty batch bookkeeping and never consumes an unknown-scope legacy park", () => {
    const harness = makeHarness({
      ownerIdentities: [TEST_OWNER, { channel: "telegram", actor: OWNER_ID }],
    });
    const guard = readerFor(harness);
    expect(guard.admit({
      channel: "telegram",
      actor: OWNER_ID,
      conversation: CHAT_A,
      nonce: "update:720",
      payload: { text: "legacy unknown scope", messageId: 1720 },
    }).allowed).toBe(true);
    harness.cp.db.run(
      `INSERT INTO inbound_messages (channel, nonce, actor, received_at)
        VALUES ('telegram-owner-parked', 'update:720', ?, ?)`,
      [conversationOf(CHAT_A), harness.clock.nowIso()],
    );

    const canonicalScope = "canonical-project-chat-thread-root";
    for (const nonce of ["update:721", "update:722"] as const) {
      expect(guard.admit({
        channel: "telegram",
        actor: OWNER_ID,
        conversation: CHAT_A,
        nonce,
        payload: { text: nonce, messageId: Number(nonce.split(":")[1]) },
      }).allowed).toBe(true);
    }
    const exact = guard.claimOwnerBatch(
      "telegram",
      "update:721",
      {
        turnRequestId: "turn-721",
        sessionDigest: canonicalScope,
        promptDigest: digestOf("update:721"),
        bindingDigest: digestOf({ bindingGeneration: null }),
      },
      ["update:721"],
      [],
    );
    expect(exact.allowed).toBe(true);
    if (!exact.allowed) return;
    expect(exact.value.batchConsumedNonces).toEqual(["update:721"]);
    expect(exact.value.batchUnconsumedNonces).toEqual([]);
    expect(guard.pendingOwnerMessages().map((item) => item.nonce)).toContain("update:720");

    const guessed = guard.claimOwnerBatch(
      "telegram",
      "update:722",
      {
        turnRequestId: "turn-722",
        sessionDigest: canonicalScope,
        promptDigest: digestOf("legacy unknown scope\nupdate:722"),
        bindingDigest: digestOf({ bindingGeneration: null }),
      },
      ["update:720", "update:722"],
      [],
    );
    expect(guessed.allowed).toBe(false);
    expect(harness.cp.db.get<{ turn_claim_json: string | null }>(
      `SELECT turn_claim_json FROM inbound_messages
        WHERE channel = 'telegram' AND nonce = 'update:720'`,
    )?.turn_claim_json).toBeNull();
  });

  it("keeps two chats' parked messages apart, in arrival order, and drops one once its turn is claimed", async () => {
    const harness = makeHarness({
      ownerIdentities: [TEST_OWNER, { channel: "telegram", actor: OWNER_ID }],
    });

    // Every turn crashes after dispatch. That is what leaves an unresolved turn behind, which is
    // the precondition for parking -- not a detail of this test, but the state the product parks
    // in.
    const crash = async (): Promise<string> => {
      throw new TelegramInterruption("after-dispatch");
    };

    // Chat A: one turn that goes unresolved, then two messages that park behind it. Chat B: the
    // same shape, so the two chats are symmetric and a reader that merged them would be caught by
    // count alone rather than by which text it returned.
    const sequence: Array<{ text: string; id: number; chat: string }> = [
      { text: "a-first", id: 801, chat: CHAT_A },
      { text: "a-parked-1", id: 802, chat: CHAT_A },
      { text: "a-parked-2", id: 803, chat: CHAT_A },
      { text: "b-first", id: 804, chat: CHAT_B },
      { text: "b-parked-1", id: 805, chat: CHAT_B },
    ];

    for (const step of sequence) {
      const transport = new OneShotTransport();
      transport.updates = [update(step.text, step.id, step.chat)];
      const listener = await startDaemonTelegramListener(
        harness.cp,
        telegramConfig,
        { handleOperator: async () => ({ ok: true }) } as never,
        { transport, start: false, onDirect: crash },
      );
      try {
        // The whole cycle, not just the poll: the turn detaches (#630), so its crash surfaces
        // through `pendingTurnsSettled`/`settled` rather than the poll promise. Swallowed here
        // because the crash is this test's setup -- an unresolved turn is what makes the next
        // message park -- and not the behaviour under measurement.
        const cycle = await listener.service.pollOnce();
        await listener.service.pendingTurnsSettled().catch(() => undefined);
        await cycle.settled().catch(() => undefined);
      } finally {
        await listener.close();
      }
    }

    const reader = readerFor(harness);

    const a = reader.pendingOwnerMessages(canonicalConversationOf(CHAT_A));
    const b = reader.pendingOwnerMessages(canonicalConversationOf(CHAT_B));

    // The boundary the CEO's ruling names. Asserted as the whole list rather than "contains", so
    // a reader that returned every parked message regardless of chat fails here instead of
    // passing a membership check.
    expect(a.map((m) => (m.payload as { text?: string } | null)?.text)).toEqual([
      "a-parked-1",
      "a-parked-2",
    ]);
    expect(b.map((m) => (m.payload as { text?: string } | null)?.text)).toEqual(["b-parked-1"]);

    // Arrival order, and it is the index's order rather than the reader's sort of whatever came
    // back: 803 was parked after 802 and must stay behind it.
    expect(a.map((m) => m.nonce)).toEqual(["update:802", "update:803"]);

    // Every returned message names the conversation it is owed to, so a caller composing a batch
    // cannot lose the scope on the way.
    expect(new Set(a.map((m) => m.sessionDigest))).toEqual(new Set([canonicalConversationOf(CHAT_A)]));
  });

  it("claims three same-conversation messages as one ordered execution and fans out success", async () => {
    const harness = makeHarness({
      ownerIdentities: [TEST_OWNER, { channel: "telegram", actor: OWNER_ID }],
    });
    const crash = async (): Promise<string> => {
      throw new TelegramInterruption("after-dispatch");
    };
    const drive = async (
      step: { text: string; id: number; chat: string },
      onDirect: (input: { text: string }) => Promise<string>,
    ): Promise<void> => {
      const transport = new OneShotTransport();
      transport.updates = [update(step.text, step.id, step.chat)];
      const listener = await startDaemonTelegramListener(
        harness.cp,
        telegramConfig,
        { handleOperator: async () => ({ ok: true }) } as never,
        { transport, start: false, onDirect },
      );
      try {
        const cycle = await listener.service.pollOnce();
        await listener.service.pendingTurnsSettled().catch(() => undefined);
        await cycle.settled().catch(() => undefined);
      } finally {
        await listener.close();
      }
    };

    // Leave one unresolved turn in each chat, then park two A messages and one B message behind
    // them. B is the negative scope witness: it must remain owed when A takes its next claim.
    await drive({ text: "a-running", id: 801, chat: CHAT_A }, crash);
    await drive({ text: "a-parked-1", id: 802, chat: CHAT_A }, crash);
    await drive({ text: "a-parked-2", id: 803, chat: CHAT_A }, crash);
    await drive({ text: "b-running", id: 804, chat: CHAT_B }, crash);
    await drive({ text: "b-parked", id: 805, chat: CHAT_B }, crash);

    const guard = readerFor(harness);
    expect(guard.resolveTurn("telegram", "update:801").allowed).toBe(true);

    const executions: string[] = [];
    await drive(
      { text: "a-current", id: 806, chat: CHAT_A },
      async (input) => {
        executions.push(input.text);
        return "batch complete";
      },
    );

    expect(executions).toEqual([
      [
        "[1/3 update_id=802 message_id=802]",
        "a-parked-1",
        "",
        "[2/3 update_id=803 message_id=803]",
        "a-parked-2",
        "",
        "[3/3 update_id=806 message_id=806]",
        "a-current",
      ].join("\n"),
    ]);
    expect(guard.pendingOwnerMessages(canonicalConversationOf(CHAT_A))).toEqual([]);
    expect(guard.pendingOwnerMessages(canonicalConversationOf(CHAT_B)).map((item) => item.nonce)).toEqual([
      "update:805",
    ]);

    const rows = harness.cp.db.all<{ nonce: string; result_json: string; turn_claim_json: string }>(
      `SELECT nonce, result_json, turn_claim_json FROM inbound_messages
        WHERE channel = 'telegram' AND nonce IN ('update:802', 'update:803', 'update:806')
        ORDER BY nonce`,
    );
    expect(rows).toHaveLength(3);
    const claims = rows.map((row) => JSON.parse(row.turn_claim_json) as {
      turnRequestId: string;
      repliedAt?: string;
      batchConsumedNonces?: string[];
      batchUnconsumedNonces?: string[];
    });
    expect(new Set(claims.map((claim) => claim.turnRequestId)).size).toBe(1);
    expect(claims.every((claim) => typeof claim.repliedAt === "string")).toBe(true);
    expect(claims[0]?.batchConsumedNonces).toEqual([
      "update:802",
      "update:803",
      "update:806",
    ]);
    expect(claims[0]?.batchUnconsumedNonces).toEqual(["update:805"]);
    expect(rows.map((row) => (JSON.parse(row.result_json) as { sent?: boolean }).sent)).toEqual([
      true,
      true,
      true,
    ]);

    // Parking participates in the admitted row's lifecycle and audit trail. The old synthetic
    // channel is neither a second authority nor a stale nonce blocker.
    expect(harness.cp.db.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM inbound_messages WHERE channel = 'telegram-owner-parked'`,
    )?.count).toBe(0);
    expect(harness.cp.audit.byKind("INGRESS_OWNER_MESSAGE_PARKED")).toHaveLength(3);
  });

  it("keeps active parked messages past retention while pruning other stale rows", () => {
    const harness = makeHarness({
      ownerIdentities: [TEST_OWNER, { channel: "telegram", actor: OWNER_ID }],
    });
    const guard = readerFor(harness);
    const conversation = conversationOf(CHAT_A);

    for (const [nonce, text] of [
      ["update:920", "parked-first"],
      ["update:921", "parked-second"],
    ] as const) {
      expect(guard.admit({
        channel: "telegram",
        actor: OWNER_ID,
        conversation: CHAT_A,
        nonce,
        payload: { text, messageId: Number(nonce.split(":")[1]) },
      }).allowed).toBe(true);
      guard.parkForBatch(nonce, conversation);
    }

    expect(guard.admit({
      channel: "telegram",
      actor: OWNER_ID,
      conversation: CHAT_A,
      nonce: "update:922",
      payload: { text: "ordinary stale", messageId: 922 },
    }).allowed).toBe(true);
    expect(guard.admit({
      channel: "telegram",
      actor: OWNER_ID,
      conversation: CHAT_A,
      nonce: "update:923",
      payload: { text: "terminal stale", messageId: 923 },
    }).allowed).toBe(true);
    expect(guard.claimTurn("telegram", "update:923", {
      turnRequestId: "turn-923",
      sessionDigest: conversation,
      promptDigest: digestOf("terminal stale"),
      bindingDigest: digestOf({ bindingGeneration: null }),
    }).allowed).toBe(true);
    expect(guard.resolveTurn("telegram", "update:923").allowed).toBe(true);

    harness.clock.advance(24 * 60 * 60 * 1000 + 1);
    const restarted = readerFor(harness);
    expect(restarted.admit({
      channel: "telegram",
      actor: OWNER_ID,
      conversation: CHAT_A,
      nonce: "update:924",
      payload: { text: "current", messageId: 924 },
    }).allowed).toBe(true);

    expect(restarted.pendingOwnerMessages(conversation).map((item) => item.nonce)).toEqual([
      "update:920",
      "update:921",
    ]);
    expect(harness.cp.db.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM inbound_messages
        WHERE channel = 'telegram' AND nonce IN ('update:922', 'update:923')`,
    )?.count).toBe(0);

    const claimed = restarted.claimOwnerBatch(
      "telegram",
      "update:924",
      {
        turnRequestId: "turn-924",
        sessionDigest: conversation,
        promptDigest: digestOf("parked-first\nparked-second\ncurrent"),
        bindingDigest: digestOf({ bindingGeneration: null }),
      },
      ["update:920", "update:921", "update:924"],
      [],
    );
    expect(claimed.allowed).toBe(true);
    if (!claimed.allowed) return;
    expect(claimed.value.batchConsumedNonces).toEqual([
      "update:920",
      "update:921",
      "update:924",
    ]);
    expect(restarted.pendingOwnerMessages(conversation)).toEqual([]);
  });

  it("reads and promotes valid legacy parks without reviving a reused nonce", () => {
    const harness = makeHarness({
      ownerIdentities: [TEST_OWNER, { channel: "telegram", actor: OWNER_ID }],
    });
    const guard = readerFor(harness);
    const sessionA = conversationOf(CHAT_A);
    const sessionB = conversationOf(CHAT_B);
    const validParkedAt = "2026-09-20T00:00:00.001Z";
    const equivalentParkedAt = "2026-09-20T00:00:00.003Z";

    const seedAdmitted = (
      nonce: string,
      text: string,
      receivedAt: string,
      result: unknown = null,
    ): void => {
      harness.cp.db.run(
        `INSERT INTO inbound_messages
          (channel, nonce, actor, received_at, result_json, payload_json)
          VALUES ('telegram', ?, ?, ?, ?, ?)`,
        [nonce, OWNER_ID, receivedAt, result === null ? null : JSON.stringify(result), JSON.stringify({ text })],
      );
    };
    const seedLegacyPark = (nonce: string, sessionDigest: string, parkedAt: string): void => {
      harness.cp.db.run(
        `INSERT INTO inbound_messages (channel, nonce, actor, received_at)
          VALUES ('telegram-owner-parked', ?, ?, ?)`,
        [nonce, sessionDigest, parkedAt],
      );
    };

    // The first pair is the exact pre-#983 shape: the admitted row owns the content and the
    // synthetic row owns only conversation and park time. The second represents an already
    // equivalent canonical row whose legacy half still needs cleanup; the reader must not expose
    // that nonce twice while both rows exist.
    seedAdmitted("update:950", "legacy only", "2026-09-20T00:00:00.000Z");
    seedLegacyPark("update:950", sessionA, validParkedAt);
    seedAdmitted("update:951", "already canonical", "2026-09-20T00:00:00.002Z", {
      kind: "TELEGRAM_WORKFLOW",
      phase: "ADMITTED",
      parked: { sessionDigest: sessionA, parkedAt: equivalentParkedAt },
    });
    seedLegacyPark("update:951", sessionA, equivalentParkedAt);

    // This nonce was reused after the legacy park was written. Joining only on the nonce would
    // promote the old conversation onto the new admitted lifetime, so admitted-at <= parked-at is
    // the compatibility boundary.
    seedLegacyPark("update:952", sessionB, "2000-01-01T00:00:00.000Z");
    seedAdmitted("update:952", "new lifetime", "2026-09-20T00:00:00.004Z");

    expect(guard.pendingOwnerMessages(sessionA).map((item) => ({
      nonce: item.nonce,
      receivedAt: item.receivedAt,
      text: (item.payload as { text?: string } | null)?.text,
    }))).toEqual([
      { nonce: "update:950", receivedAt: validParkedAt, text: "legacy only" },
      { nonce: "update:951", receivedAt: equivalentParkedAt, text: "already canonical" },
    ]);
    expect(guard.pendingOwnerMessages(sessionB)).toEqual([]);

    seedAdmitted("update:953", "sweep trigger", "2026-09-20T00:00:00.005Z");
    guard.parkForBatch("update:953", sessionA);

    // The next park promotes the valid pair and removes both the successful and already-equivalent
    // legacy rows. The stale reused nonce remains unpromoted and therefore is not eligible for
    // deletion; payload_json remains the sole source of returned content.
    expect(harness.cp.db.all<{ nonce: string }>(
      `SELECT nonce FROM inbound_messages
        WHERE channel = 'telegram-owner-parked' ORDER BY nonce`,
    ).map((row) => row.nonce)).toEqual(["update:952"]);
    expect(JSON.parse(harness.cp.db.get<{ result_json: string }>(
      `SELECT result_json FROM inbound_messages WHERE channel = 'telegram' AND nonce = 'update:950'`,
    )!.result_json)).toMatchObject({
      parked: { sessionDigest: sessionA, parkedAt: validParkedAt },
    });
    expect(harness.cp.db.get<{ result_json: string | null }>(
      `SELECT result_json FROM inbound_messages WHERE channel = 'telegram' AND nonce = 'update:952'`,
    )?.result_json).toBeNull();

    const afterSweep = guard.pendingOwnerMessages(sessionA);
    expect(afterSweep.filter((item) => item.nonce === "update:950")).toEqual([
      expect.objectContaining({
        nonce: "update:950",
        sessionDigest: sessionA,
        receivedAt: validParkedAt,
        payload: { text: "legacy only" },
      }),
    ]);
    expect(guard.pendingOwnerMessages(sessionB)).toEqual([]);
  });

  it("a message whose turn was claimed is no longer owed", async () => {
    const harness = makeHarness({
      ownerIdentities: [TEST_OWNER, { channel: "telegram", actor: OWNER_ID }],
    });
    const guard = readerFor(harness);

    // Admitted, then parked, then claimed -- the `/again` path, which claims a parked message
    // directly. Returning it afterwards would put the same message in a batch a second time,
    // which is the duplication this whole issue exists to prevent.
    guard.admit({
      channel: "telegram",
      actor: OWNER_ID,
      conversation: CHAT_A,
      nonce: "update:900",
      payload: { text: "claimed-later", messageId: 900 },
    });
    guard.parkForBatch("update:900", conversationOf(CHAT_A));
    expect(guard.pendingOwnerMessages(conversationOf(CHAT_A)).map((m) => m.nonce)).toEqual(["update:900"]);

    const claimed = guard.claimTurn("telegram", "update:900", {
      turnRequestId: "turn-900",
      sessionDigest: "session-digest",
      promptDigest: "prompt-digest",
      bindingDigest: "binding-digest",
    });
    expect(claimed.allowed).toBe(true);

    expect(guard.pendingOwnerMessages(conversationOf(CHAT_A))).toEqual([]);
  });

  it("parking the same message twice keeps its first place in the queue", () => {
    const harness = makeHarness({
      ownerIdentities: [TEST_OWNER, { channel: "telegram", actor: OWNER_ID }],
    });
    const guard = readerFor(harness);

    for (const [nonce, text] of [
      ["update:910", "first"],
      ["update:911", "second"],
    ] as const) {
      guard.admit({
        channel: "telegram",
        actor: OWNER_ID,
        conversation: CHAT_A,
        nonce,
        payload: { text, messageId: Number(nonce.split(":")[1]) },
      });
      guard.parkForBatch(nonce, conversationOf(CHAT_A));
    }

    // Telegram redelivers any update this listener has not acknowledged, so the router reaches
    // parking again for a message already parked. Re-parking must not move it: an `INSERT OR
    // REPLACE` here would rewrite `received_at` and send the older message to the back of its own
    // batch, reordering the owner's words.
    guard.parkForBatch("update:910", conversationOf(CHAT_A));

    expect(guard.pendingOwnerMessages(conversationOf(CHAT_A)).map((m) => m.nonce)).toEqual([
      "update:910",
      "update:911",
    ]);
  });
});
