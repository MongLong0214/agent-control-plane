import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ReasonCode } from "../../src/core/reason-codes.ts";
import { configuredTelegramExternalConsumerConfig } from "../../src/ingress/telegram-external.ts";

/**
 * U4 A1: Hermes is the only Telegram consumer, and the lane exists only once its shared secret does.
 * #1444: ACP has no long-poll consumer left, so a bot token left in the environment is not read.
 */
const OWNERS = [{ channel: "telegram", actor: "7000001" }] as const;
const LANE = {
  ACP_TELEGRAM_EXTERNAL_CONSUMER: "hermes",
  ACP_TELEGRAM_EXTERNAL_SECRET: "u4-config-secret",
  ACP_TELEGRAM_OWNER_ID: "7000001",
  ACP_TELEGRAM_CHAT_ID: "7000001",
};

const refusal = (run: () => unknown): { reasonCode?: unknown; message: string } => {
  try {
    run();
  } catch (error) {
    return error as { reasonCode?: unknown; message: string };
  }
  throw new Error("expected the configuration to be refused");
};

describe("U4 external Telegram consumer configuration", () => {
  it("#1444: a leftover bot token beside the lane is not read, so the lane is configured as before", () => {
    expect(configuredTelegramExternalConsumerConfig(OWNERS, {
      ...LANE,
      ACP_TELEGRAM_BOT_TOKEN: "a-token-nothing-reads",
      ACP_TELEGRAM_WEBHOOK_SECRET: "a-secret-nothing-reads",
    })).toEqual({
      consumer: "hermes",
      allowedOwnerIds: ["7000001"],
      allowedChatIds: ["7000001"],
      sharedSecret: "u4-config-secret",
    });
  });

  it("the launcher exports the lane's flag and shared secret from the Keychain like every other optional item", () => {
    const launcher = readFileSync(
      fileURLToPath(new URL("../../deploy/install-launchd.sh", import.meta.url)),
      "utf8",
    );
    const loop = /for optional in([\s\S]*?); do\s*\n\s*optional_keychain_value "\$optional"/.exec(launcher);
    expect(loop, "the launcher's optional Keychain loop moved").not.toBeNull();
    const exported = new Set(loop![1]!.match(/[A-Z][A-Z0-9_]*/g) ?? []);
    for (const name of ["ACP_TELEGRAM_EXTERNAL_CONSUMER", "ACP_TELEGRAM_EXTERNAL_SECRET", "ACP_HERMES_GATEWAY_API_KEY"]) {
      expect(exported.has(name), name).toBe(true);
    }
  });

  it("configures the lane from the flag, the secret and the existing owner and chat allowlists", () => {
    expect(configuredTelegramExternalConsumerConfig(OWNERS, LANE)).toEqual({
      consumer: "hermes",
      allowedOwnerIds: ["7000001"],
      allowedChatIds: ["7000001"],
      sharedSecret: "u4-config-secret",
    });
  });

  it("has no lane without the shared secret, and no lane without the flag", () => {
    const withoutSecret: Record<string, string> = { ...LANE };
    delete withoutSecret["ACP_TELEGRAM_EXTERNAL_SECRET"];
    expect(configuredTelegramExternalConsumerConfig(OWNERS, withoutSecret)).toBeNull();

    const withoutFlag: Record<string, string> = { ...LANE };
    delete withoutFlag["ACP_TELEGRAM_EXTERNAL_CONSUMER"];
    expect(configuredTelegramExternalConsumerConfig(OWNERS, withoutFlag)).toBeNull();
  });

  it("refuses an unknown consumer, a partial allowlist and an undeclared owner", () => {
    expect(refusal(() => configuredTelegramExternalConsumerConfig(OWNERS, { ...LANE, ACP_TELEGRAM_EXTERNAL_CONSUMER: "acp" }))
      .reasonCode).toBe(ReasonCode.DAEMON_STARTUP_FAILED);

    const withoutChat: Record<string, string> = { ...LANE };
    delete withoutChat["ACP_TELEGRAM_CHAT_ID"];
    expect(refusal(() => configuredTelegramExternalConsumerConfig(OWNERS, withoutChat)).message)
      .toContain("ACP_TELEGRAM_CHAT_ID or ACP_TELEGRAM_ALLOWED_CHAT_IDS");

    expect(refusal(() => configuredTelegramExternalConsumerConfig([], LANE)).message)
      .toContain("not declared in owner-identities");
  });
});
