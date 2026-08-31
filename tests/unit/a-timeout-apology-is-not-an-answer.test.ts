/**
 * #639 (2026-08-29 amendment): the ingress reply's resolution must not be spent on a sentence
 * the daemon composed because the CEO route gave up.
 *
 * `answerAsCeo` turns a `CEO_CONVERSATION_TIMEOUT` deny into an apology string, and until this
 * test existed that string travelled the reply path exactly like a CEO answer: Telegram accepted
 * it, `completeReplyAndResolveTurn` wrote `repliedAt`, and the turn read as answered. Nothing
 * between the port and the row distinguished *what the reply was*.
 *
 * The assertions are deliberately on the ingress record rather than on the chat. The owner sees
 * the sentence either way — that is precisely why this went unnoticed for as long as it did.
 *
 * Entry is the production one: `startDaemonTelegramListener` -> `pollOnce`, with the same
 * `onDirect: (input) => answerAsCeo(port, input.text)` wiring `agentcpd`'s `main()` installs.
 * A test that called `completeResponse` directly would prove nothing about the router.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, describe, expect, it } from "vitest";

import { answerAsCeo, startDaemonTelegramListener } from "../../src/daemon/agentcpd.ts";
import {
  TelegramDeliveryError,
  type TelegramBotTransport,
  type TelegramLongPollService,
} from "../../src/ingress/telegram-polling.ts";
import type { TelegramUpdate } from "../../src/ingress/telegram.ts";
import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { CeoConversationPort } from "../../src/mcp/ceo-conversation.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { makeHarness, TEST_OWNER } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

const SECRET = "telegram-configured-secret";
const OWNER_ID = "424242";
const CHAT_ID = "-100999";

const telegramConfig = {
  botToken: "fake-bot-token",
  allowedOwnerIds: [OWNER_ID],
  allowedChatIds: [CHAT_ID],
  webhookSecret: SECRET,
  pollTimeoutSeconds: 1,
  retryDelayMs: 1,
} as const;

const daemonStub = { finalizeApprovedRun: async (_runId: string): Promise<void> => undefined };

const update = (text: string, updateId: number): TelegramUpdate => ({
  update_id: updateId,
  message: {
    message_id: updateId,
    date: 1_700_000_000,
    text,
    from: { id: Number(OWNER_ID), username: "owner" },
    chat: { id: Number(CHAT_ID) },
  },
});

class FakeTelegramTransport implements TelegramBotTransport {
  readonly redeliveryRetentionMs = 24 * 60 * 60 * 1000;
  readonly sent: Array<{ chatId: string; text: string }> = [];
  updates: TelegramUpdate[] = [];
  /** Telegram refusing the reply outright: the reply's lifecycle ends without a delivery. */
  refuseSends = false;

  async getUpdates(): Promise<TelegramUpdate[]> {
    const drained = this.updates;
    this.updates = [];
    return drained;
  }

  async sendMessage(message: { chatId: string; text: string }): Promise<{ messageId: number }> {
    if (this.refuseSends) {
      throw new TelegramDeliveryError("simulated permanent Telegram rejection", {
        kind: "PERMANENT_REJECTION",
        statusCode: 400,
        description: "Bad Request: chat not found",
        migrateToChatId: null,
        retryAfterSeconds: null,
      });
    }
    this.sent.push({ chatId: message.chatId, text: message.text });
    return { messageId: 5_000 + this.sent.length };
  }
}

/**
 * A real `CeoConversationPort` in front of a peer whose `createMessage` raises the SDK's own
 * `RequestTimeout`. The port's classification of that error into `CEO_CONVERSATION_TIMEOUT` is
 * the branch under test, so it is exercised rather than stubbed.
 */
const timingOutCeoPort = (): CeoConversationPort => {
  const port = new CeoConversationPort();
  const server = {
    server: {
      getClientCapabilities: () => ({ sampling: {} }),
      createMessage: async () => {
        throw new McpError(ErrorCode.RequestTimeout, "request timed out");
      },
    },
  } as unknown as McpServer;
  port.attach(server, () => allow(ReasonCode.OK, {} as never));
  return port;
};

const answeringCeoPort = (answer: string): CeoConversationPort => {
  const port = new CeoConversationPort();
  const server = {
    server: {
      getClientCapabilities: () => ({ sampling: {} }),
      createMessage: async () => ({
        model: "fake",
        role: "assistant",
        content: { type: "text", text: answer },
      }),
    },
  } as unknown as McpServer;
  port.attach(server, () => allow(ReasonCode.OK, {} as never));
  return port;
};

const settledPoll = async (service: TelegramLongPollService) => {
  const cycle = await service.pollOnce();
  await service.pendingTurnsSettled();
  return cycle.settled();
};

const claimOf = (harness: ReturnType<typeof makeHarness>, nonce: string) => {
  const row = harness.cp.db.get<{ turn_claim_json: string | null }>(
    `SELECT turn_claim_json FROM inbound_messages WHERE channel = 'telegram' AND nonce = ?`,
    [nonce],
  );
  return row?.turn_claim_json === null || row?.turn_claim_json === undefined
    ? null
    : (JSON.parse(row.turn_claim_json) as Record<string, unknown>);
};

const resultOf = (harness: ReturnType<typeof makeHarness>, nonce: string) => {
  const row = harness.cp.db.get<{ result_json: string | null }>(
    `SELECT result_json FROM inbound_messages WHERE channel = 'telegram' AND nonce = ?`,
    [nonce],
  );
  return row?.result_json === null || row?.result_json === undefined
    ? null
    : (JSON.parse(row.result_json) as Record<string, unknown>);
};

describe("#639 a CEO timeout apology is delivered without being counted as the answer", () => {
  it("leaves the turn unresolved while the reply's own lifecycle records that it was delivered", async () => {
    const harness = makeHarness({
      ownerIdentities: [TEST_OWNER, { channel: "telegram", actor: OWNER_ID }],
    });
    const transport = new FakeTelegramTransport();
    transport.updates = [update("what is the plan", 900)];
    const listener = await startDaemonTelegramListener(harness.cp, telegramConfig, daemonStub, {
      transport,
      start: false,
      onDirect: (input) => answerAsCeo(timingOutCeoPort(), input.text),
    });

    try {
      const settled = await settledPoll(listener.service);
      expect(settled.outcomes[0]?.classification).toBe("DIRECT");

      // Half one — the owner is not left in silence. The sentence reached the chat and the
      // reply's own lifecycle is terminal and says so.
      expect(transport.sent[0]?.text).toContain(ReasonCode.CEO_CONVERSATION_TIMEOUT);
      expect(transport.sent[0]?.text).toContain("has not answered yet");
      const result = resultOf(harness, "update:900");
      expect(result).toMatchObject({ deliveryStatus: "APPLIED", sent: true });
      expect(String((result?.["reply"] as { text?: string } | undefined)?.text))
        .toContain(ReasonCode.CEO_CONVERSATION_TIMEOUT);

      // Half two — and the turn is *not* answered. `repliedAt` is the ingress claim that a CEO
      // answer was accepted by the transport; a sentence this daemon wrote because it gave up is
      // not that, so the claim keeps none of its three terminal facts and stays unknown.
      const claim = claimOf(harness, "update:900");
      expect(claim, "the turn was claimed").not.toBeNull();
      expect(claim?.["repliedAt"], "a daemon-composed apology resolved the turn as answered")
        .toBeUndefined();
      expect(claim?.["noReplyAt"]).toBeUndefined();
      expect(claim?.["settledAt"]).toBeUndefined();

      // #639 contract 6: an unknown outcome stays visible rather than being hidden as a
      // completion. `doctor` is where the owner and the operator both see it.
      const doctor = await harness.cp.doctor.run("system");
      expect(doctor.findings).toContainEqual(expect.objectContaining({ code: "TURN_OUTCOME_UNKNOWN" }));
    } finally {
      await listener.close();
    }
  });

  it("still resolves the turn when the CEO actually answered", async () => {
    // The other direction of the same guard: a fix that simply stopped resolving turns would
    // pass the test above and break every ordinary conversation.
    const harness = makeHarness({
      ownerIdentities: [TEST_OWNER, { channel: "telegram", actor: OWNER_ID }],
    });
    const transport = new FakeTelegramTransport();
    transport.updates = [update("what is the plan", 901)];
    const listener = await startDaemonTelegramListener(harness.cp, telegramConfig, daemonStub, {
      transport,
      start: false,
      onDirect: (input) => answerAsCeo(answeringCeoPort("the plan is to ship"), input.text),
    });

    try {
      await settledPoll(listener.service);
      expect(transport.sent[0]?.text).toContain("the plan is to ship");
      expect(resultOf(harness, "update:901")).toMatchObject({ deliveryStatus: "APPLIED", sent: true });
      expect(claimOf(harness, "update:901")?.["repliedAt"]).toEqual(expect.any(String));

      const doctor = await harness.cp.doctor.run("system");
      expect(doctor.findings).not.toContainEqual(expect.objectContaining({ code: "TURN_OUTCOME_UNKNOWN" }));
    } finally {
      await listener.close();
    }
  });

  it("terminalizes the reply but not the turn when Telegram refuses the apology", async () => {
    // The refusal twin. `settleReplyAndTurn` writes `settledAt`, which closes the turn as "no
    // longer an unknown outcome" — true of a CEO answer whose delivery failed, false of an
    // apology whose delivery failed. Without this the fix would have covered acceptance and left
    // the identical mistake on the path one HTTP status away.
    const harness = makeHarness({
      ownerIdentities: [TEST_OWNER, { channel: "telegram", actor: OWNER_ID }],
    });
    const transport = new FakeTelegramTransport();
    transport.refuseSends = true;
    transport.updates = [update("what is the plan", 905)];
    const listener = await startDaemonTelegramListener(harness.cp, telegramConfig, daemonStub, {
      transport,
      start: false,
      onDirect: (input) => answerAsCeo(timingOutCeoPort(), input.text),
      onError: () => undefined,
    });

    try {
      await settledPoll(listener.service);

      // The reply's lifecycle is terminal and says the send was refused.
      expect(resultOf(harness, "update:905")).toMatchObject({ deliveryStatus: "UNANSWERABLE" });

      // The turn is not. Nothing about a refused apology settles a turn the CEO never answered.
      const claim = claimOf(harness, "update:905");
      expect(claim?.["settledAt"], "a refused apology settled the turn").toBeUndefined();
      expect(claim?.["repliedAt"]).toBeUndefined();
      expect(claim?.["noReplyAt"]).toBeUndefined();

      const doctor = await harness.cp.doctor.run("system");
      expect(doctor.findings).toContainEqual(expect.objectContaining({ code: "TURN_OUTCOME_UNKNOWN" }));
    } finally {
      await listener.close();
    }
  });

  it("does not lock the owner out: the next message is parked with /again, and /again runs", async () => {
    // Leaving the turn unresolved puts this conversation into the #672 hold, so the escape hatch
    // has to be exercised on this exact path. A fix that makes the channel unusable after one
    // timeout is not a fix.
    const harness = makeHarness({
      ownerIdentities: [TEST_OWNER, { channel: "telegram", actor: OWNER_ID }],
    });
    const transport = new FakeTelegramTransport();
    transport.updates = [update("what is the plan", 910)];
    const listener = await startDaemonTelegramListener(harness.cp, telegramConfig, daemonStub, {
      transport,
      start: false,
      onDirect: (input) => answerAsCeo(timingOutCeoPort(), input.text),
    });

    try {
      await settledPoll(listener.service);
      expect(claimOf(harness, "update:910")?.["repliedAt"]).toBeUndefined();

      transport.updates = [update("are you there", 911)];
      const parked = await settledPoll(listener.service);
      expect(parked.outcomes[0]?.reasonCode).toBe(ReasonCode.INGRESS_TURN_UNRESOLVED_CONVERSATION);
      expect(parked.outcomes[0]?.reply?.text).toContain("/again");
      expect(claimOf(harness, "update:911"), "a parked message must not claim a turn").toBeNull();

      transport.updates = [update("/again are you there", 912)];
      const overridden = await settledPoll(listener.service);
      expect(overridden.outcomes[0]?.classification).toBe("DIRECT");
      expect(claimOf(harness, "update:912"), "/again claimed the turn").not.toBeNull();
      expect(claimOf(harness, "update:912")?.["overriddenUnresolvedNonces"]).toEqual(["update:910"]);
    } finally {
      await listener.close();
    }
  });
});
