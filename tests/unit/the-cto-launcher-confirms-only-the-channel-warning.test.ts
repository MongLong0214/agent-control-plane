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

  it("waits for a warning that is still being drawn, and confirms it once it is whole, rather than refusing its first half", async () => {
    // A terminal read in the middle of a redraw shows the warning cut off. That is a screen still arriving, not a
    // warning that differs; the first half must not end the launch.
    const half = WARNING.slice(0, WARNING.indexOf("Please use --channels to run a list") + "Please use --channels to run a list".length);
    expect(classifyScreen(half)).toBe("WARNING_ALTERED");
    const t = terminal((pressed, tick) => (pressed > 0 ? REGISTERED : tick === 0 ? half : WARNING));
    expect(await confirmChannelStartup(t.driver, t.bounds)).toEqual({ ok: true, confirmed: true });
    expect(t.presses).toEqual(["Enter"]);
  });

  it("refuses a cut-off warning only when it stays cut off, and presses nothing", async () => {
    const half = WARNING.slice(0, WARNING.indexOf("Channels: server:acp-buzz-channel"));
    const t = terminal(() => half);
    expect(await confirmChannelStartup(t.driver, t.bounds)).toMatchObject({ ok: false, failure: "WARNING_DIFFERS", confirmed: false });
    expect(t.presses).toEqual([]);
  });

  it("waits for a dialog that is still being drawn too, before calling it unrecognised", async () => {
    const t = terminal((_pressed, tick) => (tick === 0 ? `${RULE}\n Quick safety` : tick === 1 ? TRUST : REGISTERED));
    // The second read is a whole dialog, but it is the first time it has been seen whole: it is read once more, and
    // the third read is a registered session. Nothing is pressed on any of them.
    expect(await confirmChannelStartup(t.driver, t.bounds)).toEqual({ ok: true, confirmed: false });
    expect(t.presses).toEqual([]);
  });

  it("presses nothing when a partial warning, then an exact one, is redrawn to altered text before the key: one exact snapshot does not authorize Enter", async () => {
    const half = WARNING.slice(0, WARNING.indexOf("Please use --channels to run a list") + "Please use --channels to run a list".length);
    const altered = WARNING.replace("is for local channel development only", "is fine");
    const t = terminal((_pressed, tick) => (tick === 0 ? half : tick === 1 ? WARNING : altered));
    const result = await confirmChannelStartup(t.driver, t.bounds);
    expect(result).toMatchObject({ ok: false, failure: "WARNING_DIFFERS", screen: "WARNING_ALTERED", confirmed: false });
    expect(t.presses).toEqual([]);
  });

  it("reads the screen once more immediately before the key, and presses nothing if that read is altered", async () => {
    // Two identical exact reads, then the redraw lands between the last poll and the key.
    const altered = WARNING.replace("Channels: server:acp-buzz-channel", "Channels: server:acp-buzz-channel server:other");
    const t = terminal((_pressed, tick) => (tick < 2 ? WARNING : altered));
    expect(await confirmChannelStartup(t.driver, t.bounds)).toMatchObject({ ok: false, failure: "WARNING_DIFFERS", screen: "WARNING_OTHER_CHANNELS", confirmed: false });
    expect(t.presses).toEqual([]);
  });

  it("presses nothing when the last read is the exact warning but is not the same bytes as the two before it", async () => {
    const redrawn = `${WARNING}   `;
    expect(classifyScreen(redrawn)).toBe("EXACT_WARNING");
    const t = terminal((_pressed, tick) => (tick < 2 ? WARNING : redrawn));
    expect(await confirmChannelStartup(t.driver, t.bounds)).toMatchObject({ ok: false, failure: "WARNING_DIFFERS", confirmed: false });
    expect(t.presses).toEqual([]);
  });

  it("does not take two exact reads that differ in bytes as two identical ones, and presses once they agree", async () => {
    const redrawn = `${WARNING}   `;
    const t = terminal((pressed, tick) => (pressed > 0 ? REGISTERED : tick === 0 ? WARNING : redrawn));
    expect(await confirmChannelStartup(t.driver, t.bounds)).toEqual({ ok: true, confirmed: true });
    expect(t.presses).toEqual(["Enter"]);
  });

  it("presses nothing when the pre-key read cannot be taken", async () => {
    let reads = 0;
    const t = terminal(() => WARNING);
    t.driver.capture = () => {
      reads += 1;
      if (reads >= 3) throw new Error("the pane is not this launch's");
      return WARNING;
    };
    expect(await confirmChannelStartup(t.driver, t.bounds)).toMatchObject({ ok: false, failure: "UNRECOGNIZED_SCREEN", confirmed: false });
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
  /** A tmux that answers for a session name with whichever pane is active now, and for a pane id as itself. */
  const tmuxWith = (panes: Record<string, string>, active: () => string) => {
    const calls: string[][] = [];
    const run = (bin: string, args: string[]): string => {
      calls.push([bin, ...args]);
      const target = args[args.indexOf("-t") + 1]!;
      const pane = target.startsWith("%") ? target : active();
      if (args[0] === "display-message") return args.at(-1) === "#{pane_id}" ? `${pane}\n` : `${panes[pane]}\n`;
      return args[0] === "capture-pane" ? WARNING : "";
    };
    return { calls, run };
  };

  it("names the pane once by its id, and reads and presses that pane and no other", () => {
    let active = "%7";
    const t = tmuxWith({ "%7": "/state/resident-x.sh", "%9": "/bin/zsh" }, () => active);
    const driver = tmuxChannelDriver({ tmux: "tmux", target: "acp-x", startCommand: "/state/resident-x.sh", run: t.run });
    expect(driver.capture()).toBe(WARNING);
    // A person splits the window and the other pane becomes the active one: the session name now means "%9".
    active = "%9";
    expect(driver.capture()).toBe(WARNING);
    driver.press();

    const targets = (verb: string) => t.calls.filter((c) => c[1] === verb).map((c) => c[c.indexOf("-t") + 1]);
    expect(targets("capture-pane")).toEqual(["%7", "%7"]);
    expect(targets("send-keys")).toEqual(["%7"]);
    expect(t.calls.filter((c) => c.at(-1) === "#{pane_id}")).toHaveLength(1);
    expect(t.calls.find((c) => c[1] === "send-keys")).toEqual(["tmux", "send-keys", "-t", "%7", "Enter"]);
    // Nothing but the one lookup of the id ever addressed the session by its name.
    expect(t.calls.filter((c) => c.includes("acp-x")).map((c) => c.at(-1))).toEqual(["#{pane_id}"]);
  });

  it("refuses a pane that is not running the launcher it started, and presses nothing there", () => {
    const t = tmuxWith({ "%9": "/bin/zsh" }, () => "%9");
    const driver = tmuxChannelDriver({ tmux: "tmux", target: "acp-x", startCommand: "/state/resident-x.sh", run: t.run });
    expect(() => driver.capture()).toThrow(/not this launch's/u);
    expect(() => driver.press()).toThrow(/not this launch's/u);
    expect(t.calls.some((c) => c[1] === "send-keys" || c[1] === "capture-pane")).toBe(false);
  });

  it("refuses an answer that is not a pane id", () => {
    const driver = tmuxChannelDriver({ tmux: "tmux", target: "acp-x", startCommand: "/s.sh", run: () => "acp-x\n" });
    expect(() => driver.capture()).toThrow(/could not be named/u);
  });

  it("names the registered line it waits for", () => {
    expect(CHANNEL_REGISTERED_LINE).toBe("Channels (experimental) messages from server:acp-buzz-channel inject directly in this session");
  });
});
