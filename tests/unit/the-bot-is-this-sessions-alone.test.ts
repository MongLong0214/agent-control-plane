import { afterAll, describe, expect, it } from "vitest";

import {
  startTelegramLongPollListener,
  TelegramBotApi,
  TelegramDeliveryError,
  type TelegramBotTransport,
  type TelegramGetUpdatesOptions,
  type TelegramLongPollConfig,
  type TelegramLongPollRuntimeStatus,
} from "../../src/ingress/telegram-polling.ts";
import type { TelegramUpdate } from "../../src/ingress/telegram.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * #510 — Telegram allows one consumer per bot. A second long-poll listener, or a webhook, makes
 * `getUpdates` answer 409 `Conflict: ...`, and until now that landed in `GLOBAL_REJECTION`:
 * retried forever on a backoff. Retrying is wrong in both directions. Waiting never makes the bot
 * exclusive, and each win of the race takes an update away from the other consumer — so the
 * failure mode is not an outage that heals, it is two sessions quietly splitting one owner's
 * messages and each answering half of them.
 *
 * The owner's rule for this deployment (2026-09-15) is that a bot is never shared or mirrored and
 * each session is unique. That is a property nothing measured: the deployment would have run in
 * the forbidden state and logged it as a transport error. A 409 whose description identifies a
 * Telegram conflict now stops the listener, and stops it in a way acknowledgement cannot lift —
 * no recovery nonce is recorded, and `resumeAfterAcknowledgement` matches on one. Getting the
 * daemon back means removing the other consumer, which is an operator act, not a retry.
 *
 * Keyed on the description as well as the status, because 409 is a generic conflict code and this
 * module's own rule is that status alone cannot establish scope. The two negative controls below
 * are what keep that from drifting back into "terminalize on 409".
 */
const SECRET = "exclusivity-secret";

const config: TelegramLongPollConfig = {
  botToken: "fixture-token",
  allowedOwnerIds: ["424242"],
  allowedChatIds: ["999"],
  webhookSecret: SECRET,
  pollTimeoutSeconds: 1,
};

const telegramResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const apiRefusing = (status: number, description: string): TelegramBotApi =>
  new TelegramBotApi("fixture-token", {
    fetcher: async () => telegramResponse(status, { ok: false, error_code: status, description }),
  });

const failureOf = async (api: TelegramBotApi): Promise<TelegramDeliveryError["failure"]> => {
  try {
    await api.getUpdates({ timeoutSeconds: 1 });
  } catch (error) {
    if (error instanceof TelegramDeliveryError) return error.failure;
    throw error;
  }
  throw new Error("getUpdates resolved against a refusing endpoint");
};

/** Throws the classification the real adapter produces, then counts how often it is asked again. */
class ConflictingTransport implements TelegramBotTransport {
  readonly redeliveryRetentionMs = 24 * 60 * 60 * 1000;
  calls = 0;
  constructor(private readonly failure: TelegramDeliveryError["failure"]) {}
  async getUpdates(_options: TelegramGetUpdatesOptions): Promise<readonly TelegramUpdate[]> {
    this.calls += 1;
    throw new TelegramDeliveryError("Telegram Bot API getUpdates returned HTTP 409", this.failure);
  }
  async sendMessage(_input: { text: string }): Promise<{ messageId: number }> {
    throw new Error("a listener that lost exclusivity must not send");
  }
}

describe("#510 the bot this session polls is this session's alone", () => {
  it("classifies both of Telegram's conflict descriptions as lost exclusivity", async () => {
    // The second long-poll listener, and the webhook — the two ways another consumer exists.
    const second = await failureOf(apiRefusing(409, "Conflict: terminated by other getUpdates request"));
    expect(second.kind).toBe("EXCLUSIVITY_LOST");
    expect(second.statusCode).toBe(409);

    const webhook = await failureOf(
      apiRefusing(409, "Conflict: can't use getUpdates method while webhook is active"),
    );
    expect(webhook.kind).toBe("EXCLUSIVITY_LOST");
  });

  it("leaves a 409 that does not name a conflict, and a conflict that is not a 409, retrying", async () => {
    // Two negative controls, one per operand. Without the first, "terminalize on 409" passes; the
    // self-hosted Bot API server and any proxy in front of it can answer 409 for reasons that have
    // nothing to do with a second consumer, and stopping the daemon on that is a new outage.
    const otherConflict = await failureOf(apiRefusing(409, "Too many connections"));
    expect(otherConflict.kind).toBe("GLOBAL_REJECTION");

    // Without the second, the description alone decides, and a 400 quoting a conflict in its text
    // stops the daemon.
    const wrongStatus = await failureOf(apiRefusing(400, "Conflict: terminated by other getUpdates request"));
    expect(wrongStatus.kind).toBe("GLOBAL_REJECTION");
  });

  it("stops the listener, and acknowledgement cannot bring it back", async () => {
    const harness = makeHarness();
    const failure = await failureOf(apiRefusing(409, "Conflict: terminated by other getUpdates request"));
    const transport = new ConflictingTransport(failure);
    const statuses: TelegramLongPollRuntimeStatus[] = [];

    const listener = await startTelegramLongPollListener(harness.cp, config, {
      transport,
      start: false,
      onRuntimeStatus: (status) => statuses.push(status),
    });
    try {
      await expect(listener.service.pollOnce()).rejects.toThrow(/HTTP 409/u);
      expect(statuses).toContainEqual({ running: false, stopReason: "BOT_NOT_EXCLUSIVE", recoveryNonce: null });

      // The refusal is terminal, not a backoff: the transport is never asked a second time.
      await expect(listener.service.pollOnce()).rejects.toThrow(/HTTP 409/u);
      expect(transport.calls, "a stopped listener kept polling the bot it must not share").toBe(1);

      // No nonce was recorded, so there is nothing an operator can acknowledge. The other consumer
      // has to go away and the daemon has to be started again.
      expect(await listener.service.resumeAfterAcknowledgement("any-nonce")).toBe(false);
      expect(() => listener.service.start()).toThrow(/HTTP 409/u);
    } finally {
      await listener.close();
    }
  });
});
