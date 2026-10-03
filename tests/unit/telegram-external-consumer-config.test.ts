import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { ReasonCode } from "../../src/core/reason-codes.ts";
import { main } from "../../src/daemon/agentcpd.ts";
import {
  configuredTelegramExternalConsumerConfig,
  configuredTelegramLongPollConfig,
} from "../../src/ingress/telegram-polling.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * U4 A1: Hermes is the only Telegram consumer. The flag that says so must never coexist with a bot
 * token ACP could poll with, and the lane exists only once its shared secret does.
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
  it("RED5: refuses startup when the external consumer flag and a bot token are both set", () => {
    const environment = {
      ...LANE,
      ACP_TELEGRAM_BOT_TOKEN: "a-token-acp-must-not-hold",
      ACP_TELEGRAM_WEBHOOK_SECRET: "long-poll-secret",
    };
    for (const parse of [configuredTelegramLongPollConfig, configuredTelegramExternalConsumerConfig]) {
      const refused = refusal(() => parse(OWNERS, environment));
      expect(refused.reasonCode).toBe(ReasonCode.DAEMON_STARTUP_FAILED);
      expect(refused.message).toContain("ACP_TELEGRAM_EXTERNAL_CONSUMER=hermes and ACP_TELEGRAM_BOT_TOKEN are both set");
      // Names only: the token's value is never part of a refusal.
      expect(JSON.stringify(refused)).not.toContain("a-token-acp-must-not-hold");
    }
  });

  it("RED5: main refuses the flag beside a bot token before any control plane exists", async () => {
    const root = tempDir("acp-u4-main-");
    const databasePath = join(root, "state", "state.sqlite");
    const token = "a-token-main-must-not-hold";
    const scrubbed = [
      "ACP_CANONICAL_SESSIONS_JSON", "ACP_CANONICAL_CTO_PEER_PROTOCOL", "ACP_CANONICAL_CTO_BUZZ_PURPOSE",
      "ACP_BUZZ_CHANNEL", "ACP_BUZZ_INGRESS_SECRET", "ACP_BUZZ_ALLOWED_ACTORS", "BUZZ_PRIVATE_KEY",
      "ACP_TELEGRAM_ALLOWED_OWNER_IDS", "ACP_TELEGRAM_ALLOWED_CHAT_IDS", "ACP_TELEGRAM_WEBHOOK_SECRET",
    ];
    const values: Record<string, string> = {
      ...LANE,
      ACP_TELEGRAM_BOT_TOKEN: token,
      ACP_MCP_TOKEN: "u4-main-mcp-token",
      ACP_OPERATOR_TOKEN: "u4-main-operator-token",
      ACP_OPERATOR_ACTOR: "u4-main-operator",
    };
    const names = [...scrubbed, ...Object.keys(values)];
    const before = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    let rejection: unknown = null;
    try {
      for (const name of scrubbed) delete process.env[name];
      Object.assign(process.env, values);
      await main({
        config: {
          databasePath,
          worktreeRoot: join(root, "worktrees"),
          capacityDir: join(root, "capacity"),
          secretsDir: join(root, "secrets"),
          ownerIdentities: [...OWNERS],
        },
      });
    } catch (error) {
      rejection = error;
    } finally {
      for (const name of names) {
        const value = before[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
    const refused = rejection as { reasonCode?: unknown; message?: string } | null;
    expect(refused?.reasonCode).toBe(ReasonCode.DAEMON_STARTUP_FAILED);
    expect(refused?.message).toContain("ACP_TELEGRAM_EXTERNAL_CONSUMER=hermes and ACP_TELEGRAM_BOT_TOKEN are both set");
    expect(JSON.stringify(refused)).not.toContain(token);
    expect(String(refused?.message)).not.toContain(token);
    // Refused before `new ControlPlane`: no database was opened, so nothing was migrated or locked.
    expect(existsSync(databasePath)).toBe(false);
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
    // The long-poll parser stands down: owner and chat ids without a bot token are not a partial
    // long-poll deployment in this mode.
    expect(configuredTelegramLongPollConfig(OWNERS, LANE)).toBeNull();
  });

  it("has no lane without the shared secret, and no lane without the flag", () => {
    const withoutSecret: Record<string, string> = { ...LANE };
    delete withoutSecret["ACP_TELEGRAM_EXTERNAL_SECRET"];
    expect(configuredTelegramExternalConsumerConfig(OWNERS, withoutSecret)).toBeNull();
    expect(configuredTelegramLongPollConfig(OWNERS, withoutSecret)).toBeNull();

    const withoutFlag: Record<string, string> = { ...LANE };
    delete withoutFlag["ACP_TELEGRAM_EXTERNAL_CONSUMER"];
    expect(configuredTelegramExternalConsumerConfig(OWNERS, withoutFlag)).toBeNull();
  });

  it("refuses an unknown consumer, a partial allowlist and an undeclared owner", () => {
    expect(refusal(() => configuredTelegramExternalConsumerConfig(OWNERS, { ...LANE, ACP_TELEGRAM_EXTERNAL_CONSUMER: "acp" }))
      .reasonCode).toBe(ReasonCode.DAEMON_STARTUP_FAILED);
    expect(refusal(() => configuredTelegramLongPollConfig(OWNERS, { ...LANE, ACP_TELEGRAM_EXTERNAL_CONSUMER: "acp" }))
      .reasonCode).toBe(ReasonCode.DAEMON_STARTUP_FAILED);

    const withoutChat: Record<string, string> = { ...LANE };
    delete withoutChat["ACP_TELEGRAM_CHAT_ID"];
    expect(refusal(() => configuredTelegramExternalConsumerConfig(OWNERS, withoutChat)).message)
      .toContain("ACP_TELEGRAM_CHAT_ID or ACP_TELEGRAM_ALLOWED_CHAT_IDS");

    expect(refusal(() => configuredTelegramExternalConsumerConfig([], LANE)).message)
      .toContain("not declared in owner-identities");
  });

  it("leaves a long-poll deployment exactly as it was when the flag is absent", () => {
    expect(configuredTelegramLongPollConfig(OWNERS, {
      ACP_TELEGRAM_BOT_TOKEN: "bot-token",
      ACP_TELEGRAM_OWNER_ID: "7000001",
      ACP_TELEGRAM_CHAT_ID: "7000001",
      ACP_TELEGRAM_WEBHOOK_SECRET: "long-poll-secret",
    })).toMatchObject({ botToken: "bot-token", allowedOwnerIds: ["7000001"], allowedChatIds: ["7000001"] });
  });
});
