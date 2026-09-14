import { DatabaseSync } from "node:sqlite";

import { afterAll, describe, expect, it } from "vitest";

import { startDaemonTelegramListener } from "../../src/daemon/agentcpd.ts";
import type { TelegramBotTransport } from "../../src/ingress/telegram-polling.ts";
import type { TelegramUpdate } from "../../src/ingress/telegram.ts";
import { bindCeo, makeHarness, TEST_OWNER } from "../helpers/harness.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";

/**
 * #631, the acknowledgement half — and the name is what this measures, which is narrower than the
 * one it was written under.
 *
 * `inbound_messages.payload_json` exists so a message is on disk before anything can acknowledge it
 * away, and both its docstring and `IngressGuard.admit`'s comment say the write happens in the
 * admitting statement. That is a reading of two call sites. This asks it where it can fail:
 * `getUpdates(offset)` is Telegram's deletion acknowledgement, so at every request that carries an
 * offset past this update, the row is read back **through a second connection to the same file** —
 * which by definition cannot see an uncommitted write.
 *
 * Two mutations were run and they are why the name changed:
 *
 *   admit without writing `payload_json`         fails here, in 111ms
 *   advance the offset *before* `routeUpdate`    **does not fail here**
 *
 * The second is the measurement. Moving the in-memory advance ahead of admission changes nothing
 * Telegram can observe, because the offset only reaches it on the *next* `getUpdates`, by which
 * time admission has long committed. So the hazard this issue names is not the listener advancing
 * its own number — it is the acknowledgement, and that is the ordering asserted here. A case
 * claiming the stronger within-poll ordering would be green against a product that does not have
 * it, which is the shape #631 exists to stop.
 *
 * What this does not establish: anything about a crash. That is
 * `an-owner-message-outlives-the-process-that-lost-its-turn.test.ts`, three real processes. This is
 * the complementary half — that one proves the copy survives a death, this one proves Telegram is
 * never told to drop a message no copy of which is committed.
 */const OWNER_ID = "424242";
const CHAT_ID = "-100999";
const CHANNEL = "telegram";
const UPDATE_ID = 6310;
const MESSAGE_ID = 11;
const PROMPT = "이 문장은 커밋 순서의 증인이다.";

afterAll(() => {
  cleanupTempDirs();
});

const updateFrom = (): TelegramUpdate => ({
  update_id: UPDATE_ID,
  message: {
    message_id: MESSAGE_ID,
    date: 1,
    text: PROMPT,
    chat: { id: Number(CHAT_ID), type: "supergroup" },
    from: { id: Number(OWNER_ID), is_bot: false },
  },
} as unknown as TelegramUpdate);

/** What a second connection could see at the instant the listener asked to acknowledge. */
interface AcknowledgementReading {
  readonly offset: number;
  readonly payload: string | null | undefined;
}

describe("Telegram is never told to drop an uncopied message", () => {
  it("has the payload committed and visible to another connection before it acknowledges", async () => {
    const harness = makeHarness({ ownerIdentities: [TEST_OWNER, { channel: CHANNEL, actor: OWNER_ID }] });
    bindCeo(harness);
    const databaseFile = harness.cp.db.file;

    const readings: AcknowledgementReading[] = [];
    let queue: TelegramUpdate[] = [updateFrom()];

    const transport: TelegramBotTransport = {
      redeliveryRetentionMs: 24 * 60 * 60 * 1000,
      getUpdates: async (options) => {
        if (options.offset !== undefined && options.offset > UPDATE_ID) {
          // A separate handle. SQLite shows it only what is committed, which is the property
          // under test — not "the row exists by now", but "it existed before this request".
          const observer = new DatabaseSync(databaseFile, { readOnly: true });
          const row = observer
            .prepare("SELECT payload_json FROM inbound_messages WHERE channel = ? AND nonce = ?")
            .get(CHANNEL, `update:${UPDATE_ID}`) as { payload_json: string | null } | undefined;
          readings.push({ offset: options.offset, payload: row === undefined ? undefined : row.payload_json });
          observer.close();
        }
        if (options.offset !== undefined) {
          queue = queue.filter((update) => update.update_id >= options.offset!);
        }
        return [...queue];
      },
      sendMessage: async () => ({ messageId: 1 }),
    };

    const listener = await startDaemonTelegramListener(
      harness.cp,
      {
        botToken: "fake-bot-token",
        allowedOwnerIds: [OWNER_ID],
        allowedChatIds: [CHAT_ID],
        webhookSecret: "telegram-configured-secret",
        pollTimeoutSeconds: 1,
        retryDelayMs: 1,
      },
      { finalizeApprovedRun: async (): Promise<void> => undefined },
      { transport, start: false, onDirect: () => "answered" },
    );

    try {
      const cycle = await listener.service.pollOnce();
      await listener.service.pendingTurnsSettled().catch(() => undefined);
      await cycle.settled().catch(() => undefined);
      // The second poll is what carries the advanced offset to Telegram. Without it the listener
      // has moved its own number and told nobody, and this case would be reading a decision that
      // was never communicated.
      const second = await listener.service.pollOnce();
      await second.settled().catch(() => undefined);
    } finally {
      await listener.close().catch(() => undefined);
    }

    expect(
      readings,
      "the listener never asked for an offset past this update, so nothing was acknowledged and this case measured nothing",
    ).not.toHaveLength(0);

    for (const reading of readings) {
      expect(
        reading.payload,
        `offset ${reading.offset} acknowledged update ${UPDATE_ID} while another connection could not see its row`,
      ).not.toBeUndefined();
      expect(reading.payload, "the row existed but carried no copy of what the owner wrote").toContain(PROMPT);
    }
  }, 120_000);
});
