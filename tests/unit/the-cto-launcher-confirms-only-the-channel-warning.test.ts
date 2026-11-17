import { describe, expect, it } from "vitest";

import {
  CHANNEL_REGISTERED_LINE,
  DEV_CHANNELS_WARNING,
  classifyScreen,
  confirmChannelStartup,
  tmuxChannelDriver,
  type ChannelScreenDriver,
} from "../../src/runtime/cto-channel-launch.ts";

/**
 * The owner allowed the CTO launcher to confirm one screen: Claude Code's development-channels warning for
 * exactly `server:acp-buzz-channel`, on a launch that carries that flag. Every row here is a way a
 * plausible implementation still presses something it should not: any dialog with a footer, the warning
 * for another channel list, the warning with a word changed, a warning that also lists a second channel,
 * a trust or permission prompt, or a keystroke repeated because the first one looked slow.
 */

const RULE = "─".repeat(120);
/** The warning exactly as Claude Code 2.1.323 drew it in a 200-column tmux pane. */
const WARNING = [
  "", RULE,
  "  WARNING: Loading development channels", "",
  "  --dangerously-load-development-channels is for local channel development only. Do not use this option to run channels you have downloaded off the internet.", "",
  "  Please use --channels to run a list of approved channels.", "",
  "  Channels: server:acp-buzz-channel", "",
  "  ❯ 1. I am using this for local development",
  "    2. Exit", "",
  "  Enter to confirm · Esc to cancel", "",
].join("\n");
const REGISTERED = [
  " ▐▛███▛█   Claude Code v2.1.323", "▝▜██████▀  Haiku 5.5 · Claude Ultra", " ▝▝   ▝▝   /private/tmp/project", "",
  `  Channels (experimental) messages from server:acp-buzz-channel inject directly in this session · restart without --dangerously-load-development-channels to stop`,
  RULE, "❯ ", RULE, "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
].join("\n");
const TRUST = [
  RULE, " Accessing workspace:", "", " /private/tmp/project", "",
  " Quick safety check: Is this a project you created or one you trust?", "",
  " ❯ 1. Yes, I trust this folder", "   2. No, exit", "", " Enter to confirm · Esc to cancel",
].join("\n");
const STARTING = ["", "  Loading…", ""].join("\n");

/** A launch's terminal that answers from a script and counts the keys pressed on it. */
const terminal = (screens: (pressed: number, tick: number) => string, bounds = { screenWaitMs: 3_000, registerWaitMs: 3_000, pollMs: 500 }) => {
  let clock = 0;
  let tick = 0;
  const presses: string[] = [];
  const driver: ChannelScreenDriver = {
    capture: () => screens(presses.length, tick++),
    press: () => void presses.push("Enter"),
    now: () => clock,
    sleep: async (ms) => void (clock += ms),
  };
  return { driver, presses, bounds, elapsed: () => clock };
};

describe("the one screen that may be confirmed", () => {
  it("classifies the warning Claude Code drew, the registered session, and everything else", () => {
    expect(classifyScreen(WARNING)).toBe("EXACT_WARNING");
    expect(classifyScreen(REGISTERED)).toBe("REGISTERED");
    expect(classifyScreen(TRUST)).toBe("OTHER_DIALOG");
    expect(classifyScreen(STARTING)).toBe("OTHER");
    expect(classifyScreen("")).toBe("OTHER");
  });

  it("reads the warning the same in a narrow terminal that wraps its lines", () => {
    const wrapped = WARNING.replace("Do not use this option", "Do not use\n  this option").replace("channels you have downloaded", "channels you\n  have downloaded");
    expect(classifyScreen(wrapped)).toBe("EXACT_WARNING");
    expect(DEV_CHANNELS_WARNING).toContain("Channels: server:acp-buzz-channel ");
  });

  it.each([
    ["a second channel listed", WARNING.replace("Channels: server:acp-buzz-channel", "Channels: server:acp-buzz-channel server:other"), "WARNING_OTHER_CHANNELS"],
    ["a different server", WARNING.replace("server:acp-buzz-channel", "server:something-else"), "WARNING_OTHER_CHANNELS"],
    ["a plugin entry", WARNING.replace("server:acp-buzz-channel", "plugin:telegram@claude-plugins-official"), "WARNING_OTHER_CHANNELS"],
    ["a changed sentence", WARNING.replace("for local channel development only", "for production use"), "WARNING_ALTERED"],
    ["a changed confirm label", WARNING.replace("I am using this for local development", "Trust everything"), "WARNING_ALTERED"],
    ["the options swapped", WARNING.replace("1. I am using this for local development\n    2. Exit", "1. Exit\n    2. I am using this for local development"), "WARNING_ALTERED"],
    ["extra text beside the warning", `${WARNING}\n  Never ask again`, "WARNING_ALTERED"],
    ["no title", WARNING.replace("WARNING: Loading development channels", "Loading development channels"), "WARNING_ALTERED"],
  ])("does not treat %s as the warning it may confirm", (_name, screen, expected) => {
    expect(classifyScreen(screen)).toBe(expected);
  });
});

describe("confirming, and only confirming", () => {
  it("presses once on the exact warning and succeeds when the channel registers", async () => {
    const t = terminal((pressed, tick) => (pressed === 0 ? (tick < 2 ? STARTING : WARNING) : tick < 6 ? WARNING : REGISTERED));
    const result = await confirmChannelStartup(t.driver, t.bounds);
    expect(result).toEqual({ ok: true, confirmed: true });
    // The warning still on screen for a moment after the key is redrawn away, not pressed again.
    expect(t.presses).toEqual(["Enter"]);
  });

  it("presses nothing when the session is already registered", async () => {
    const t = terminal(() => REGISTERED);
    expect(await confirmChannelStartup(t.driver, t.bounds)).toEqual({ ok: true, confirmed: false });
    expect(t.presses).toEqual([]);
  });

  it.each([
    ["a trust dialog", TRUST, "UNRECOGNIZED_SCREEN", "OTHER_DIALOG"],
    ["a permission prompt", `${RULE}\n Allow this tool?\n ❯ 1. Yes\n   2. No\n Enter to confirm · Esc to cancel`, "UNRECOGNIZED_SCREEN", "OTHER_DIALOG"],
    ["a login prompt", `${RULE}\n Select login method:\n ❯ 1. Claude account\n   2. Console\n Enter to confirm · Esc to cancel`, "UNRECOGNIZED_SCREEN", "OTHER_DIALOG"],
    ["a screen that never becomes anything", STARTING, "UNRECOGNIZED_SCREEN", "OTHER"],
    ["a blank terminal", "", "UNRECOGNIZED_SCREEN", "OTHER"],
    ["the warning for another channel list", WARNING.replace("server:acp-buzz-channel", "server:acp-buzz-channel server:other"), "WARNING_DIFFERS", "WARNING_OTHER_CHANNELS"],
    ["the warning with altered text", WARNING.replace("is for local channel development only", "is fine"), "WARNING_DIFFERS", "WARNING_ALTERED"],
  ])("sends no key on %s, and reports it", async (_name, screen, failure, seen) => {
    const t = terminal(() => screen);
    const result = await confirmChannelStartup(t.driver, t.bounds);
    expect(result).toEqual({ ok: false, failure, screen: seen, confirmed: false });
    expect(t.presses).toEqual([]);
  });

  it("waits no longer than its bound for a screen that never appears", async () => {
    const t = terminal(() => STARTING, { screenWaitMs: 2_000, registerWaitMs: 2_000, pollMs: 500 });
    await confirmChannelStartup(t.driver, t.bounds);
    expect(t.elapsed()).toBeLessThanOrEqual(2_500);
  });

  it("counts a missing startup line after confirming as a failure, and does not press again", async () => {
    const t = terminal((pressed) => (pressed === 0 ? WARNING : STARTING));
    const result = await confirmChannelStartup(t.driver, t.bounds);
    expect(result).toEqual({ ok: false, failure: "NOT_REGISTERED", screen: "OTHER", confirmed: true });
    expect(t.presses).toEqual(["Enter"]);
    expect(t.elapsed()).toBeLessThanOrEqual(3_000 + 1_500 + 500);
  });

  it("counts a warning that never goes away after the key as a failure, with one key", async () => {
    const t = terminal(() => WARNING);
    const result = await confirmChannelStartup(t.driver, t.bounds);
    expect(result).toMatchObject({ ok: false, failure: "NOT_REGISTERED", screen: "EXACT_WARNING", confirmed: true });
    expect(t.presses).toEqual(["Enter"]);
  });

  it("stops at once when a different dialog follows the key, and does not answer it", async () => {
    const t = terminal((pressed) => (pressed === 0 ? WARNING : TRUST));
    const result = await confirmChannelStartup(t.driver, t.bounds);
    expect(result).toMatchObject({ ok: false, failure: "NOT_REGISTERED", screen: "OTHER_DIALOG", confirmed: true });
    expect(t.presses).toEqual(["Enter"]);
  });

  it("treats a terminal that is not the launch's as a screen it may not touch", async () => {
    const t = terminal(() => WARNING);
    t.driver.capture = () => {
      throw new Error("the pane is not this launch's");
    };
    const result = await confirmChannelStartup(t.driver, t.bounds);
    expect(result).toMatchObject({ ok: false, failure: "UNRECOGNIZED_SCREEN", confirmed: false });
    expect(t.presses).toEqual([]);
  });
});

describe("the tmux driver", () => {
  const calls: string[][] = [];
  const driverFor = (startCommand: string, answer: string) =>
    tmuxChannelDriver({
      tmux: "tmux",
      target: "acp-x",
      startCommand,
      run: (bin, args) => {
        calls.push([bin, ...args]);
        return args[0] === "display-message" ? `${answer}\n` : WARNING;
      },
    });

  it("reads and presses only the pane that is running the launcher it started", () => {
    calls.length = 0;
    const own = driverFor("/state/resident-x.sh", "/state/resident-x.sh");
    expect(own.capture()).toBe(WARNING);
    own.press();
    expect(calls.at(-1)).toEqual(["tmux", "send-keys", "-t", "acp-x", "Enter"]);
    expect(calls.filter((c) => c[1] === "send-keys")).toHaveLength(1);

    const other = driverFor("/state/resident-x.sh", "/bin/zsh");
    expect(() => other.capture()).toThrow(/not this launch's/u);
    expect(calls.some((c) => c[1] === "capture-pane" && c.includes("acp-x"))).toBe(true);
  });

  it("names the registered line it waits for", () => {
    expect(CHANNEL_REGISTERED_LINE).toBe("Channels (experimental) messages from server:acp-buzz-channel inject directly in this session");
  });
});
