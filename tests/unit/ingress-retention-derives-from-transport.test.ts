import { afterAll, describe, expect, it } from "vitest";

import { IngressGuard } from "../../src/ingress/ingress-guard.ts";
import {
  startTelegramLongPollListener,
  TelegramBotApi,
  type TelegramBotTransport,
  type TelegramGetUpdatesOptions,
} from "../../src/ingress/telegram-polling.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * #682 (round 8, Sol's BLOCK) — the 24h floor `IngressGuard` enforces (#673) was bound to the
 * string `"telegram"`, not to whatever transport actually backs that channel. Production
 * (`startTelegramLongPollListener`) accepts an arbitrary `TelegramBotTransport` and constructed
 * the guard *before* choosing the real transport, so a permitted custom transport that retains an
 * update longer than 24h — or one whose retention nobody has measured at all — got the same 24h
 * floor as the officially-measured `api.telegram.org` endpoint. That reopens exactly the #673
 * duplicate-turn window: the nonce is pruned as though the transport had stopped redelivering,
 * the transport redelivers anyway, and a fresh admission runs the handler a second time.
 *
 * The fix derives the floor from `transport.redeliveryRetentionMs` — a fact every
 * `TelegramBotTransport` must now state about itself — instead of a table keyed by channel name.
 * `null` means "not measured", and the guard refuses construction rather than assume the
 * official 24h figure applies to a transport nobody vouched for.
 */
class DeclaredRetentionTransport implements TelegramBotTransport {
  constructor(readonly redeliveryRetentionMs: number | null) {}
  async getUpdates(_options: TelegramGetUpdatesOptions) {
    return [];
  }
  async sendMessage(): Promise<{ messageId: number }> {
    throw new Error("no send was expected in this scenario");
  }
}

describe("#682 round 8: the retention floor tracks the transport's own declared retention", () => {
  it("IngressGuard derives its floor from a longer-than-24h transportRetentionMs, not the channel name", () => {
    const harness = makeHarness();

    // A transport that can redeliver for 48h. Left at the default nonceTtlMs (24h) — the exact
    // configuration that let #673's original exploit reopen: the nonce would be pruned a full day
    // before this transport's own redelivery window closes.
    expect(
      () =>
        new IngressGuard(harness.cp.db, harness.cp.clock, harness.cp.audit, {
          telegram: {
            allowedActors: ["owner"],
            allowedConversations: ["chat"],
            transportRetentionMs: 48 * 60 * 60 * 1000,
          },
        }),
    ).toThrow(/retention/i);
  });

  it("succeeds once nonceTtlMs is raised to at least the declared 48h retention", () => {
    const harness = makeHarness();

    expect(
      () =>
        new IngressGuard(harness.cp.db, harness.cp.clock, harness.cp.audit, {
          telegram: {
            allowedActors: ["owner"],
            allowedConversations: ["chat"],
            nonceTtlMs: 48 * 60 * 60 * 1000,
            transportRetentionMs: 48 * 60 * 60 * 1000,
          },
        }),
    ).not.toThrow();
  });

  it("refuses to construct when the transport's retention is unmeasured, regardless of nonceTtlMs", () => {
    const harness = makeHarness();

    expect(
      () =>
        new IngressGuard(harness.cp.db, harness.cp.clock, harness.cp.audit, {
          telegram: {
            allowedActors: ["owner"],
            allowedConversations: ["chat"],
            // Generously long — this must still be refused, since the point is that nobody
            // measured what this transport actually does, not that the configured number is
            // too small.
            nonceTtlMs: 365 * 24 * 60 * 60 * 1000,
            transportRetentionMs: null,
          },
        }),
    ).toThrow(/retention/i);
  });

  it("TelegramBotApi reports the measured 24h retention only for the real api.telegram.org endpoint", () => {
    const official = new TelegramBotApi("fake-token");
    expect(official.redeliveryRetentionMs).toBe(24 * 60 * 60 * 1000);

    // ACP_TELEGRAM_API_BASE_URL can point this same class at a self-hosted Bot API server (or
    // any other endpoint) whose queue retention nobody here has measured. Reusing the official
    // figure for it would be exactly this issue's original mistake in a new spot.
    const selfHosted = new TelegramBotApi("fake-token", { apiBaseUrl: "https://bot-api.internal.example" });
    expect(selfHosted.redeliveryRetentionMs).toBeNull();
  });

  it(
    "production wiring refuses to start against a transport whose retention is unknown, chosen " +
      "before this fix constructed the guard",
    async () => {
      const harness = makeHarness();
      const config = {
        botToken: "fake-token",
        allowedOwnerIds: ["424242"],
        allowedChatIds: ["-100999"],
        webhookSecret: "webhook-secret",
      };

      await expect(
        startTelegramLongPollListener(harness.cp, config, {
          transport: new DeclaredRetentionTransport(null),
          start: false,
        }),
      ).rejects.toThrow(/retention/i);
    },
  );

  it(
    "production wiring accepts a custom transport that honestly declares a retention its " +
      "nonceTtlMs default already covers",
    async () => {
      const harness = makeHarness();
      const config = {
        botToken: "fake-token",
        allowedOwnerIds: ["424242"],
        allowedChatIds: ["-100999"],
        webhookSecret: "webhook-secret",
      };

      const listener = await startTelegramLongPollListener(harness.cp, config, {
        transport: new DeclaredRetentionTransport(24 * 60 * 60 * 1000),
        start: false,
      });
      expect(listener.service).toBeDefined();
      await listener.close();
    },
  );

  it(
    "production wiring refuses to start against a custom transport that declares a retention " +
      "longer than the unset default nonceTtlMs",
    async () => {
      const harness = makeHarness();
      const config = {
        botToken: "fake-token",
        allowedOwnerIds: ["424242"],
        allowedChatIds: ["-100999"],
        webhookSecret: "webhook-secret",
      };

      await expect(
        startTelegramLongPollListener(harness.cp, config, {
          transport: new DeclaredRetentionTransport(48 * 60 * 60 * 1000),
          start: false,
        }),
      ).rejects.toThrow(/retention/i);
    },
  );
});
