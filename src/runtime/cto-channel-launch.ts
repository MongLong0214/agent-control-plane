import { dirname, join } from "node:path";

/**
 * How a CTO session ACP starts is given its Buzz channel (`src/cli/buzz-channel.ts`).
 *
 * Claude Code delivers channel messages only from a server the session opted in for. A server that is
 * not on Anthropic's approved plugin list is opted in with `--dangerously-load-development-channels
 * server:<name>`, and the server itself is defined for that launch alone with an inline
 * `--mcp-config`, so nothing is written to the project's or the user's MCP configuration.
 *
 * Both flags take a list, so each is followed by another flag: a list that ran into the launch's
 * positional prompt would take the prompt as a server name. Callers place this array directly before
 * a flag that is not a list (`--session-id`, `--resume`, `--messaging-socket-path`).
 */
export const BUZZ_CHANNEL_SERVER = "acp-buzz-channel";
export const CHANNEL_DEV_FLAG = "--dangerously-load-development-channels";

/** The channel entry beside the agentctl entry a runtime ships: `dist/cli/agentctl.js` -> `dist/cli/buzz-channel.js`. */
export const channelCliPath = (runtimeCli: string): string => join(dirname(runtimeCli), "buzz-channel.js");

export interface ChannelLaunchInput {
  /** The runtime's own Node, absolute: the MCP server runs with the launcher's PATH, which has no nvm bin. */
  readonly runtimeNode: string;
  readonly runtimeCli: string;
  readonly projectId: string;
  /** This CTO's own key file (`~/.hermes/bridge/keys/cto-<project>.priv`); only the path is passed. */
  readonly keyFile: string;
  readonly roomId: string;
  readonly stateDir: string;
}

export const channelMcpConfig = (input: ChannelLaunchInput): string =>
  JSON.stringify({
    mcpServers: {
      [BUZZ_CHANNEL_SERVER]: {
        command: input.runtimeNode,
        args: [
          channelCliPath(input.runtimeCli),
          "--project-id", input.projectId,
          "--key-file", input.keyFile,
          "--room", input.roomId,
          "--state-dir", input.stateDir,
        ],
      },
    },
  });

/** The argv fragment that gives a launch its channel. */
export const channelLaunchArgs = (input: ChannelLaunchInput): string[] => [
  "--mcp-config",
  channelMcpConfig(input),
  CHANNEL_DEV_FLAG,
  `server:${BUZZ_CHANNEL_SERVER}`,
];

// ---- confirming Claude Code's development-channels warning -------------------------------------
//
// `--dangerously-load-development-channels` makes Claude Code stop at a full-screen warning that waits
// for a person. The owner has allowed ACP's CTO launcher to confirm that one screen, and nothing else
// (2026-11-17): the launch was started with `server:acp-buzz-channel`, the screen is that warning word
// for word, and the channel it lists is that one. Any other screen (a trust dialog, a permission or
// login prompt, an unknown dialog, a different channel list, altered text) gets no keystroke at all and
// is reported. The confirmation is one `Enter`, sent once, and the launch is only good when Claude
// Code then shows the line that says the channel registered.

/** The warning as Claude Code 2.1.323 draws it, with the rule lines removed and whitespace collapsed. */
export const DEV_CHANNELS_WARNING =
  "WARNING: Loading development channels " +
  "--dangerously-load-development-channels is for local channel development only. " +
  "Do not use this option to run channels you have downloaded off the internet. " +
  "Please use --channels to run a list of approved channels. " +
  `Channels: server:${BUZZ_CHANNEL_SERVER} ` +
  "❯ 1. I am using this for local development 2. Exit Enter to confirm · Esc to cancel";

/** What the session shows once the channel is registered. */
export const CHANNEL_REGISTERED_LINE =
  `Channels (experimental) messages from server:${BUZZ_CHANNEL_SERVER} inject directly in this session`;

/**
 * A screen reduced to its words: box-drawing rules dropped and every run of whitespace made one space, so
 * a narrow terminal that wraps a line does not change what it says.
 */
export const normalizeScreen = (screen: string): string =>
  screen.replace(/[─-╿]/gu, " ").replace(/\s+/gu, " ").trim();

export type ScreenVerdict =
  | "EXACT_WARNING"
  | "WARNING_OTHER_CHANNELS"
  | "WARNING_ALTERED"
  | "REGISTERED"
  | "OTHER_DIALOG"
  | "OTHER";

export const classifyScreen = (screen: string): ScreenVerdict => {
  const text = normalizeScreen(screen);
  if (text === DEV_CHANNELS_WARNING) return "EXACT_WARNING";
  if (text.includes("Loading development channels") || text.includes("--dangerously-load-development-channels is for")) {
    const listed = /Channels: (.*?) ❯/u.exec(text)?.[1];
    return listed !== undefined && listed !== `server:${BUZZ_CHANNEL_SERVER}` ? "WARNING_OTHER_CHANNELS" : "WARNING_ALTERED";
  }
  if (text.includes(CHANNEL_REGISTERED_LINE)) return "REGISTERED";
  // Every Claude Code dialog that waits on a choice carries this footer; one this module does not know is
  // reported at once rather than waited out.
  if (text.includes("Enter to confirm") || text.includes("Esc to cancel")) return "OTHER_DIALOG";
  return "OTHER";
};

export type ChannelStartupFailure = "UNRECOGNIZED_SCREEN" | "WARNING_DIFFERS" | "NOT_REGISTERED";

export type ChannelStartupResult =
  | { readonly ok: true; readonly confirmed: boolean }
  | { readonly ok: false; readonly failure: ChannelStartupFailure; readonly screen: ScreenVerdict; readonly confirmed: boolean };

export interface ChannelScreenDriver {
  /** The visible screen of the launch's own terminal. Throws when that terminal is not the launch's. */
  capture(): string | Promise<string>;
  /** The one confirming keystroke (`Enter`). */
  press(): void | Promise<void>;
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface ChannelStartupBounds {
  /** How long the warning (or the registered line) may take to appear after the launch. */
  readonly screenWaitMs: number;
  /** How long the registered line may take to appear after the confirmation. */
  readonly registerWaitMs: number;
  readonly pollMs: number;
}

export const DEFAULT_CHANNEL_STARTUP_BOUNDS: ChannelStartupBounds = { screenWaitMs: 30_000, registerWaitMs: 30_000, pollMs: 500 };

/**
 * Brings a launch that carries the channel flag to a registered channel, confirming Claude Code's
 * development-channels warning on the way and nothing else. At most one keystroke is ever sent, and only
 * on the exact warning; every other screen ends the wait with a failure the caller reports.
 *
 * The registered line is the only evidence taken that the channel came up. Claude Code shows one startup
 * notice line, so a second notice (debug mode, an update) pushes it out of view as "1 more notice hidden";
 * that is reported as NOT_REGISTERED, not guessed at. Both screens are Claude Code 2.1.323's: a version
 * that rewords the warning is refused, not pressed.
 */
export const confirmChannelStartup = async (
  driver: ChannelScreenDriver,
  bounds: ChannelStartupBounds = DEFAULT_CHANNEL_STARTUP_BOUNDS,
): Promise<ChannelStartupResult> => {
  // A screen is read in the middle of being drawn as often as not: a warning cut off after its second sentence is a
  // warning still arriving, not one that differs. So a screen that would end the launch (an altered warning, another
  // channel list, a dialog that is not the warning) ends it only when the next read, a poll later, is the same screen.
  let lastRefusable: string | null = null;
  const look = async (): Promise<{ verdict: ScreenVerdict; settled: boolean }> => {
    let text: string;
    try {
      text = await driver.capture();
    } catch {
      // A terminal that is not the launch's reads as an unknown dialog, the same way twice.
      const settled = lastRefusable === "\u0000unreadable";
      lastRefusable = "\u0000unreadable";
      return { verdict: "OTHER_DIALOG", settled };
    }
    const verdict = classifyScreen(text);
    const refusable = verdict === "WARNING_OTHER_CHANNELS" || verdict === "WARNING_ALTERED" || verdict === "OTHER_DIALOG";
    const normalized = normalizeScreen(text);
    const settled = refusable && lastRefusable === normalized;
    lastRefusable = refusable ? normalized : null;
    return { verdict, settled };
  };
  let verdict: ScreenVerdict = "OTHER";
  const first = driver.now();
  while (true) {
    const read = await look();
    verdict = read.verdict;
    if (verdict === "REGISTERED") return { ok: true, confirmed: false };
    if (verdict === "EXACT_WARNING") break;
    if (read.settled && (verdict === "WARNING_OTHER_CHANNELS" || verdict === "WARNING_ALTERED")) {
      return { ok: false, failure: "WARNING_DIFFERS", screen: verdict, confirmed: false };
    }
    if (read.settled && verdict === "OTHER_DIALOG") return { ok: false, failure: "UNRECOGNIZED_SCREEN", screen: verdict, confirmed: false };
    if (driver.now() - first >= bounds.screenWaitMs) return { ok: false, failure: "UNRECOGNIZED_SCREEN", screen: verdict, confirmed: false };
    await driver.sleep(bounds.pollMs);
  }
  await driver.press();
  lastRefusable = null;
  const pressed = driver.now();
  while (true) {
    await driver.sleep(bounds.pollMs);
    const read = await look();
    verdict = read.verdict;
    if (verdict === "REGISTERED") return { ok: true, confirmed: true };
    if (driver.now() - pressed >= bounds.registerWaitMs) break;
    // The warning may take a moment to be redrawn away, so it is waited out; a different dialog is not.
    if (read.settled && (verdict === "OTHER_DIALOG" || verdict === "WARNING_ALTERED" || verdict === "WARNING_OTHER_CHANNELS")) break;
  }
  return { ok: false, failure: "NOT_REGISTERED", screen: verdict, confirmed: true };
};

/**
 * `tmux` as the driver of one launch's pane. The pane is named once, by its id (`%N`), when the driver first
 * looks: a session name resolves to whichever pane is active at the moment, so a split or a moved window
 * would point the screen read and the keystroke at a pane that is not the launch's. The id is checked to be
 * running exactly the launcher this launch started, and then every capture and the one keystroke use that id.
 */
export const tmuxChannelDriver = (input: {
  readonly tmux: string;
  readonly target: string;
  /** What `#{pane_start_command}` must be: the launcher script this launch started. */
  readonly startCommand: string;
  readonly run: (bin: string, args: string[]) => string;
}): ChannelScreenDriver => {
  let pane: string | null = null;
  const own = (): string => {
    if (pane !== null) return pane;
    const id = input.run(input.tmux, ["display-message", "-p", "-t", input.target, "#{pane_id}"]).trim();
    if (!/^%\d+$/u.test(id)) throw new Error("the launch's pane could not be named");
    const started = input.run(input.tmux, ["display-message", "-p", "-t", id, "#{pane_start_command}"]).replace(/\n$/u, "");
    if (started !== input.startCommand) throw new Error("the pane is not this launch's");
    pane = id;
    return id;
  };
  return {
    capture: () => input.run(input.tmux, ["capture-pane", "-p", "-t", own()]),
    press: () => {
      input.run(input.tmux, ["send-keys", "-t", own(), "Enter"]);
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
};
