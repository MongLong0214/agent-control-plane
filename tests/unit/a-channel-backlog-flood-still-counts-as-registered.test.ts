import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { channelReceiptPath } from "../../src/buzz/buzz-channel-files.ts";
import { DEV_CHANNELS_WARNING, channelEmittedSince, confirmChannelStartup, type ChannelScreenDriver } from "../../src/runtime/cto-channel-launch.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * deploy135, Logic Pro MCP and freshreadme-2: the relaunched channel worked (54 backlog messages delivered, the role
 * re-claimed), and the launch was reported NOT_REGISTERED because the backlog's `← acp-buzz-channel:` lines pushed
 * Claude Code's one "Channels (experimental) … inject directly" line off the captured screen. After the one permitted
 * keypress the registration is proven by the channel's own durable receipt, not by that line alone.
 */
const FLOOD = Array.from({ length: 40 }, (_, i) => `← acp-buzz-channel: backlog message ${i + 1}`).join("\n");

const terminal = (registered: () => boolean): { driver: ChannelScreenDriver; presses: string[] } => {
  let clock = 0;
  const presses: string[] = [];
  return {
    presses,
    driver: {
      capture: () => (presses.length === 0 ? DEV_CHANNELS_WARNING : FLOOD),
      press: () => void presses.push("Enter"),
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      registered,
    },
  };
};
const BOUNDS = { screenWaitMs: 3_000, registerWaitMs: 3_000, pollMs: 500 };

describe("a channel whose backlog floods the screen", () => {
  it("counts as registered once the channel's own emitted receipt is there, after the one keypress", async () => {
    let receipts = 0;
    const t = terminal(() => t.presses.length > 0 && ++receipts > 1);
    expect(await confirmChannelStartup(t.driver, BOUNDS)).toEqual({ ok: true, confirmed: true });
    expect(t.presses).toEqual(["Enter"]);
  });

  it("is still not registered without that receipt: the flood alone proves nothing", async () => {
    const t = terminal(() => false);
    expect(await confirmChannelStartup(t.driver, BOUNDS)).toMatchObject({ ok: false, failure: "NOT_REGISTERED", confirmed: true });
    expect(t.presses).toEqual(["Enter"]);
  });

  it("reads the channel's receipt file for an emitted receipt after the launch, and no earlier one", () => {
    const state = tempDir("acp-channel-receipts-");
    const file = channelReceiptPath(state, "logic");
    expect(file).toBe(join(state, "buzz-channel", "logic.receipts.jsonl"));
    mkdirSync(join(state, "buzz-channel"), { recursive: true });
    const emitted = (at: number): string => `${JSON.stringify({ type: "emitted", eventId: "e", room: "r", senderPubkey: "p", emittedAt: at })}\n`;
    writeFileSync(file, emitted(100));
    expect(channelEmittedSince(state, "logic", 100)()).toBe(false);
    writeFileSync(file, `${emitted(100)}{"type":"replied"}\nnot json\n${emitted(101)}`);
    expect(channelEmittedSince(state, "logic", 100)()).toBe(true);
    expect(channelEmittedSince(state, "other", 100)()).toBe(false);
  });
});
