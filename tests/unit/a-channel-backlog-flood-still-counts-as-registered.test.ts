import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { appendChannelReceipt, channelReceiptPath, readChannelReceipts } from "../../src/buzz/buzz-channel-files.ts";
import { parseBuzzChannelArgs } from "../../src/cli/buzz-channel.ts";
import { DEV_CHANNELS_WARNING, channelEmittedBy, channelLaunchArgs, confirmChannelStartup, type ChannelScreenDriver } from "../../src/runtime/cto-channel-launch.ts";
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

  it("#1463 r1: counts only an emitted receipt carrying this launch's id, never one by its time", () => {
    const state = tempDir("acp-channel-receipts-");
    const file = channelReceiptPath(state, "logic");
    expect(file).toBe(join(state, "buzz-channel", "logic.receipts.jsonl"));
    mkdirSync(join(state, "buzz-channel"), { recursive: true });
    const emitted = (at: number, launchId?: string): string =>
      `${JSON.stringify({ type: "emitted", eventId: "e", room: "r", senderPubkey: "p", emittedAt: at, ...(launchId ? { launchId } : {}) })}\n`;
    // The old channel process, still appending while the new one starts: a later time, and no id or another launch's.
    writeFileSync(file, `${emitted(9_999_999_999)}${emitted(9_999_999_999, "an-earlier-launch")}not json\n`);
    expect(channelEmittedBy(state, "logic", "this-launch")()).toBe(false);
    // This launch's channel: its id, whatever its time.
    writeFileSync(file, `${readFileSync(file, "utf8")}${emitted(1, "this-launch")}`);
    expect(channelEmittedBy(state, "logic", "this-launch")()).toBe(true);
    expect(channelEmittedBy(state, "other", "this-launch")()).toBe(false);
  });

  it("#1463 r1: the launch gives its channel server its own id, and the server writes it into every receipt", () => {
    const argv = channelLaunchArgs({ runtimeNode: "/n", runtimeCli: "/d/cli/agentctl.js", projectId: "logic", keyFile: "/k.priv", roomId: "room", stateDir: "/s", launchId: "this-launch" });
    const server = (JSON.parse(argv[1]!) as { mcpServers: Record<string, { args: string[] }> }).mcpServers["acp-buzz-channel"]!.args;
    expect(server.slice(server.indexOf("--launch-id"), server.indexOf("--launch-id") + 2)).toEqual(["--launch-id", "this-launch"]);
    expect(parseBuzzChannelArgs([...server.slice(1)]).launchId).toBe("this-launch");
    const state = tempDir("acp-channel-stamp-");
    appendChannelReceipt(state, "logic", { type: "emitted", eventId: "e", room: "room", senderPubkey: "p", emittedAt: 1 }, "this-launch");
    expect(readChannelReceipts(channelReceiptPath(state, "logic")).receipts).toEqual([expect.objectContaining({ type: "emitted", launchId: "this-launch" })]);
  });

  it("freshreadme-2: a launch with nothing queued registers through the channel's own registered receipt", async () => {
    // Claude Code accepted the channel (its MCP log said so) and the queue was empty: no message, so no `emitted` receipt,
    // and the one startup line had scrolled away. The server writes `registered` once the handshake completes.
    const state = tempDir("acp-channel-registered-");
    const registered = channelEmittedBy(state, "logic", "this-launch");
    expect(registered()).toBe(false);
    let reads = 0;
    const t = terminal(() => {
      // The server's handshake completes a moment after the keypress; the flood is all the screen shows.
      if (t.presses.length > 0 && ++reads === 2) appendChannelReceipt(state, "logic", { type: "registered", registeredAt: 1 }, "this-launch");
      return registered();
    });
    expect(await confirmChannelStartup(t.driver, BOUNDS)).toEqual({ ok: true, confirmed: true });
    expect(t.presses).toEqual(["Enter"]);
  });

  it("counts a registered receipt only when it carries this launch's id", () => {
    const state = tempDir("acp-channel-registered-id-");
    appendChannelReceipt(state, "logic", { type: "registered", registeredAt: 9_999_999_999 });
    appendChannelReceipt(state, "logic", { type: "registered", registeredAt: 9_999_999_999 }, "an-earlier-launch");
    expect(channelEmittedBy(state, "logic", "this-launch")()).toBe(false);
    appendChannelReceipt(state, "logic", { type: "registered", registeredAt: 1 }, "this-launch");
    expect(channelEmittedBy(state, "logic", "this-launch")()).toBe(true);
    expect(readChannelReceipts(channelReceiptPath(state, "logic")).skipped).toEqual([]);
  });
});
