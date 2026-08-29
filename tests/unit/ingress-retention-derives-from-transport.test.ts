import { afterAll, describe, expect, it } from "vitest";

import { IngressGuard } from "../../src/ingress/ingress-guard.ts";
import {
  configuredTelegramLongPollConfig,
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
 *
 * Round 8's second follow-up (Sol's second BLOCK) found the derivation had conflated two
 * different situations: a transport whose retention is genuinely *longer* than the default was
 * refused exactly like one whose retention is *unknown* — but a known, longer window is a fact
 * this guard can act on by raising the effective floor to match, not a reason to refuse. A known
 * 48h retention with no explicit `nonceTtlMs` now raises the floor to 48h rather than throwing;
 * an *explicit* `nonceTtlMs` shorter than a known retention is still refused (an operator's own
 * choice is not silently overridden into a floor they never asked for).
 *
 * Round 8's third pass (Sol's third BLOCK) found that refusing an unmeasured transport left an
 * operator who *does* know their self-hosted server's real redelivery window with no production
 * way to say so — `ACP_TELEGRAM_TRANSPORT_RETENTION_MS` (read by `configuredTelegramLongPollConfig`,
 * validated the same way as every other `ACP_TELEGRAM_*` integer setting) is that escape hatch: it
 * fills the gap only when the transport itself reports unknown, and the same #673 check applies
 * to it exactly as it does to a transport-derived retention.
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
  it("raises the effective floor to a longer-than-24h transportRetentionMs rather than refusing, when nonceTtlMs is not explicit", () => {
    const harness = makeHarness();
    const guard = new IngressGuard(harness.cp.db, harness.cp.clock, harness.cp.audit, {
      // No explicit `nonceTtlMs` — the exact shape production wiring uses (see
      // `startTelegramLongPollListener`, which never sets it). A transport that can genuinely
      // redeliver for 48h must raise this guard's own floor to 48h, not be refused for a default
      // nobody configured.
      telegram: { allowedActors: ["owner"], allowedConversations: ["chat"], transportRetentionMs: 48 * 60 * 60 * 1000 },
    });
    const nonce = "48h-transport-update";
    const admit = (n: string) =>
      guard.admit({ channel: "telegram", actor: "owner", conversation: "chat", nonce: n, payload: {} });

    expect(admit(nonce).allowed).toBe(true);

    // Relative to the harness's own (manual) clock, not real wall-clock time — `prune`'s cutoff
    // is computed from `this.clock.nowIso()`, and this harness's clock is fixed at a specific
    // instant rather than tracking `Date.now()`.
    const now = new Date(harness.clock.nowIso()).getTime();
    const hoursAgo = (hours: number): string => new Date(now - hours * 60 * 60 * 1000).toISOString();

    // Aged past the *old* 24h default but well inside the 48h floor this transport's retention
    // must now enforce. Directly, the same idiom `ingress-nonce-ttl-transport-retention.test.ts`
    // uses, rather than advancing the clock 30 real hours.
    harness.cp.db.run(
      "UPDATE inbound_messages SET received_at = ? WHERE channel = 'telegram' AND nonce = ?",
      [hoursAgo(30), nonce],
    );
    // A prune runs on every admit; if the floor were still 24h (the old, buggy refuse-or-nothing
    // behaviour reduced to "refuse" and this test could never even get this far, but if it had
    // instead silently kept the 24h default) this row would already be gone and a redelivery
    // would be treated as fresh. It must still be a replay.
    expect(admit("unrelated-1").allowed).toBe(true);
    const stillThere = admit(nonce);
    expect(stillThere.allowed, "a 30h-old row must not be pruned when the floor is 48h").toBe(false);

    // Past the 48h floor now — this is what proves the floor is 48h, not merely "more than 30h".
    harness.cp.db.run(
      "UPDATE inbound_messages SET received_at = ? WHERE channel = 'telegram' AND nonce = ?",
      [hoursAgo(49), nonce],
    );
    expect(admit("unrelated-2").allowed).toBe(true);
    const redelivered = admit(nonce);
    expect(redelivered.allowed, "a 49h-old row must be pruned once the 48h floor has passed").toBe(true);
  });

  it("still refuses an explicit nonceTtlMs shorter than a known, longer retention", () => {
    const harness = makeHarness();

    // An operator's own explicit choice, not the system default — silently raising it to match
    // the transport's retention would hide a real misconfiguration instead of refusing it.
    expect(
      () =>
        new IngressGuard(harness.cp.db, harness.cp.clock, harness.cp.audit, {
          telegram: {
            allowedActors: ["owner"],
            allowedConversations: ["chat"],
            nonceTtlMs: 60 * 60 * 1000,
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
    "production wiring succeeds against a custom transport that declares a retention longer " +
      "than the unset default nonceTtlMs — a known longer window raises the floor, it is not refused",
    async () => {
      const harness = makeHarness();
      const config = {
        botToken: "fake-token",
        allowedOwnerIds: ["424242"],
        allowedChatIds: ["-100999"],
        webhookSecret: "webhook-secret",
      };

      const listener = await startTelegramLongPollListener(harness.cp, config, {
        transport: new DeclaredRetentionTransport(48 * 60 * 60 * 1000),
        start: false,
      });
      expect(listener.service).toBeDefined();
      await listener.close();
    },
  );

  describe("ACP_TELEGRAM_TRANSPORT_RETENTION_MS — the escape hatch for an unmeasured transport", () => {
    const baseEnv = {
      ACP_TELEGRAM_BOT_TOKEN: "fake-bot-token",
      ACP_TELEGRAM_OWNER_ID: "424242",
      ACP_TELEGRAM_CHAT_ID: "-100999",
      ACP_TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
    };
    const ownerIdentities = [{ channel: "telegram" as const, actor: "424242" }];

    it("is absent from the configured config when unset — an operator who said nothing asserted nothing", () => {
      const config = configuredTelegramLongPollConfig(ownerIdentities, baseEnv);
      expect(config).not.toBeNull();
      expect(config!.transportRetentionMs).toBeUndefined();
    });

    it("is read into the configured config, validated the same way as the other Telegram integer settings", () => {
      const config = configuredTelegramLongPollConfig(ownerIdentities, {
        ...baseEnv,
        ACP_TELEGRAM_TRANSPORT_RETENTION_MS: String(48 * 60 * 60 * 1000),
      });
      expect(config!.transportRetentionMs).toBe(48 * 60 * 60 * 1000);
    });

    it("rejects a value outside its bounds instead of silently accepting a typo'd unit", () => {
      expect(() =>
        configuredTelegramLongPollConfig(ownerIdentities, {
          ...baseEnv,
          // Below the 1-minute floor — almost certainly seconds where milliseconds were meant.
          ACP_TELEGRAM_TRANSPORT_RETENTION_MS: "30",
        }),
      ).toThrow(/between/i);
    });

    it("fills the gap for a transport that reports its own retention as unknown", async () => {
      const harness = makeHarness();
      const config = {
        botToken: "fake-token",
        allowedOwnerIds: ["424242"],
        allowedChatIds: ["-100999"],
        webhookSecret: "webhook-secret",
        // The operator's own assertion — this is what a self-hosted-server operator sets via
        // ACP_TELEGRAM_TRANSPORT_RETENTION_MS in production.
        transportRetentionMs: 48 * 60 * 60 * 1000,
      };

      const listener = await startTelegramLongPollListener(harness.cp, config, {
        // Reports unknown on its own — exactly the self-hosted-server shape this escape hatch
        // exists for. Without `config.transportRetentionMs` this construction would be refused
        // (see "production wiring refuses to start against a transport whose retention is
        // unknown" above); with it, it must succeed.
        transport: new DeclaredRetentionTransport(null),
        start: false,
      });
      expect(listener.service).toBeDefined();
      await listener.close();
    });

    it("does not override a transport that already knows its own retention", async () => {
      const harness = makeHarness();
      const config = {
        botToken: "fake-token",
        allowedOwnerIds: ["424242"],
        allowedChatIds: ["-100999"],
        webhookSecret: "webhook-secret",
        // Deliberately too short to satisfy the default 24h floor on its own — if this ever wins
        // over the transport's own correct 24h report, construction would be refused.
        transportRetentionMs: 60_000,
      };

      const listener = await startTelegramLongPollListener(harness.cp, config, {
        transport: new DeclaredRetentionTransport(24 * 60 * 60 * 1000),
        start: false,
      });
      expect(listener.service).toBeDefined();
      await listener.close();
    });
  });
});
