import { readFileSync, realpathSync } from "node:fs";
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
  /**
   * This launch's own id. The channel server writes it into every receipt (`--launch-id`), and only a receipt carrying
   * it proves this launch's channel registered (`channelEmittedBy`).
   */
  readonly launchId?: string;
  /** A fresh conversation's switch time in whole seconds (`--history-before`): what was signed at or before it is shown as history. */
  readonly historyBefore?: number;
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
          ...(input.launchId === undefined ? [] : ["--launch-id", input.launchId]),
          ...(input.historyBefore === undefined ? [] : ["--history-before", String(input.historyBefore)]),
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

/** Whether a claude argv, element by element, loads the acp-buzz-channel development channel. */
export const argvCarriesChannel = (argv: readonly string[] | null | undefined): boolean => {
  if (!argv) return false;
  const wanted = `server:${BUZZ_CHANNEL_SERVER}`;
  for (let at = 0; at < argv.length; at++) {
    const element = argv[at]!;
    if (element.startsWith(`${CHANNEL_DEV_FLAG}=`) && element.slice(CHANNEL_DEV_FLAG.length + 1).split(/[ ,]/).includes(wanted)) return true;
    if (element !== CHANNEL_DEV_FLAG) continue;
    for (let value = at + 1; value < argv.length && (value === at + 1 || !argv[value]!.startsWith("-")); value++) if (argv[value] === wanted) return true;
  }
  return false;
};

// ---- the folder Claude Code will start in is already trusted ------------------------------------
//
// The one keystroke below is sent on a screen read a moment earlier, and tmux cannot make reading a pane and pressing a key
// one step: a pane that is redrawn between them gets the key. So what could be on the other side of that gap is removed
// before Claude Code starts. Claude Code's startup dialogs run in a fixed order (2.1.323): onboarding; the workspace trust
// dialog; a project's .mcp.json servers; CLAUDE.md files that import from outside the folder; account and policy notices
// (code mode, Grove, a Pro trial); an API key that was never approved; the bypass-permissions warning; this channel's
// development-channels warning; then, only with Claude in Chrome on, its two dialogs. Only the last two can follow the one
// this module presses; the rest come first, and a dialog the launcher reads that is not that warning is refused unpressed.
//
// The trust dialog is the one the launcher can rule out for certain, so it does: the launch folder must already carry the
// trust record `~/.claude/scripts/claude-trust-dir.sh` writes, `projects[<real path>].hasTrustDialogAccepted`, and a launch
// without it never starts Claude. Nothing is ever trusted here: this only reads, and the owner records trust. The record
// must be the folder's own: Claude Code also accepts a trusted folder above it, under rules about git roots that are not
// modelled here, so a folder trusted only that way is refused, and the owner runs the script on the folder itself.
//
// Not excluded, and so a Limit of this launcher: a first run's onboarding screens (`hasCompletedOnboarding`), a project
// `.mcp.json` server nobody approved, a CLAUDE.md import from outside the folder nobody approved, a pending account or
// policy notice, an unapproved `ANTHROPIC_API_KEY`, and the bypass-permissions warning when `skipDangerousModePermissionPrompt`
// is not set (both resident launches pass the bypass flags). Each comes before the warning, so none can follow a screen read
// as the warning; the launcher only refuses to press them. After the key, a screen that is not the registered line, such as
// a Claude in Chrome dialog, is recorded as CTO_CHANNEL_STARTUP_REFUSED and no second key is sent.

export type FolderTrustRefusal =
  | "folder-unresolvable"
  | "persisted-trust-ignored"
  | "home-folder"
  | "store-unreadable"
  | "no-record";

export type FolderTrust =
  | { readonly trusted: true; readonly folder: string }
  | { readonly trusted: false; readonly folder: string | null; readonly reason: FolderTrustRefusal };

/**
 * Whether Claude Code, started in `cwd`, would find that folder already trusted, by the record the trust script writes.
 * Reads Claude Code's global config (`$CLAUDE_CONFIG_DIR/.claude.json`, else `<home>/.claude.json`) and writes nothing.
 * The home folder is never trusted: Claude Code keeps its answer there for one session only. A launch environment that
 * tells Claude Code to ignore persisted trust is never trusted either.
 */
export const launchFolderTrust = (
  cwd: string,
  options: { readonly home: string; readonly env?: Readonly<Record<string, string | undefined>> },
): FolderTrust => {
  const env = options.env ?? process.env;
  let folder: string;
  try {
    folder = realpathSync(cwd);
  } catch {
    return { trusted: false, folder: null, reason: "folder-unresolvable" };
  }
  if ((env["CLAUDE_CODE_IGNORE_PERSISTED_TRUST"] ?? "") !== "") return { trusted: false, folder, reason: "persisted-trust-ignored" };
  let home = options.home;
  try {
    home = realpathSync(options.home);
  } catch {
    // An unresolvable home cannot be this folder's link target; compare as given.
  }
  if (folder === home) return { trusted: false, folder, reason: "home-folder" };
  let store: unknown;
  try {
    const configDir = env["CLAUDE_CONFIG_DIR"] ?? "";
    store = JSON.parse(readFileSync(join(configDir === "" ? options.home : configDir, ".claude.json"), "utf8"));
  } catch {
    return { trusted: false, folder, reason: "store-unreadable" };
  }
  if (store === null || typeof store !== "object" || Array.isArray(store)) return { trusted: false, folder, reason: "store-unreadable" };
  const projects = (store as { projects?: unknown }).projects;
  const record = projects !== null && typeof projects === "object" && Object.hasOwn(projects, folder)
    ? (projects as Record<string, unknown>)[folder]
    : undefined;
  const accepted = record !== null && typeof record === "object" && (record as { hasTrustDialogAccepted?: unknown }).hasTrustDialogAccepted === true;
  return accepted ? { trusted: true, folder } : { trusted: false, folder, reason: "no-record" };
};

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

export type ChannelStartupFailure = "UNRECOGNIZED_SCREEN" | "WARNING_DIFFERS" | "NOT_REGISTERED" | "ABORTED";

export type ChannelStartupResult =
  | { readonly ok: true; readonly confirmed: boolean }
  | { readonly ok: false; readonly failure: ChannelStartupFailure; readonly screen: ScreenVerdict; readonly confirmed: boolean };

export interface ChannelScreenDriver {
  /** The visible screen of the launch's own terminal. Throws when that terminal is not the launch's. */
  capture(): string | Promise<string>;
  /** The one confirming keystroke (`Enter`). */
  press(): void | Promise<void>;
  /**
   * A durable sign that the channel is up and delivering into the session (`channelEmittedSince`), for when the screen
   * cannot show it: a backlog flood scrolls the one registered line away. Never a reason to press anything.
   */
  registered?(): boolean | Promise<boolean>;
  /** Asked once, immediately before the keystroke and after the last screen read; false presses nothing (ABORTED). */
  proceed?(): boolean | Promise<boolean>;
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
  const look = async (): Promise<{ verdict: ScreenVerdict; settled: boolean; raw: string | null }> => {
    let text: string;
    try {
      text = await driver.capture();
    } catch {
      // A terminal that is not the launch's reads as an unknown dialog, the same way twice.
      const settled = lastRefusable === "\u0000unreadable";
      lastRefusable = "\u0000unreadable";
      return { verdict: "OTHER_DIALOG", settled, raw: null };
    }
    const verdict = classifyScreen(text);
    const refusable = verdict === "WARNING_OTHER_CHANNELS" || verdict === "WARNING_ALTERED" || verdict === "OTHER_DIALOG";
    const normalized = normalizeScreen(text);
    const settled = refusable && lastRefusable === normalized;
    lastRefusable = refusable ? normalized : null;
    return { verdict, settled, raw: text };
  };
  let verdict: ScreenVerdict = "OTHER";
  const durable = async (): Promise<boolean> => (driver.registered ? (await driver.registered()) === true : false);
  // The one keystroke is authorized by agreement, never by one snapshot: two reads of the same pane in a row, byte for
  // byte the same, each exactly the warning. A screen is redrawn between any two reads, so a single exact read can be
  // followed by something else before the key lands; this narrows that to the one read taken immediately before it.
  let exactBefore: string | null = null;
  const first = driver.now();
  while (true) {
    const read = await look();
    verdict = read.verdict;
    if (verdict === "REGISTERED" || (verdict !== "EXACT_WARNING" && await durable())) return { ok: true, confirmed: false };
    if (verdict === "EXACT_WARNING") {
      if (exactBefore !== null && exactBefore === read.raw) break;
      exactBefore = read.raw;
    } else {
      exactBefore = null;
      if (read.settled && (verdict === "WARNING_OTHER_CHANNELS" || verdict === "WARNING_ALTERED")) {
        return { ok: false, failure: "WARNING_DIFFERS", screen: verdict, confirmed: false };
      }
      if (read.settled && verdict === "OTHER_DIALOG") return { ok: false, failure: "UNRECOGNIZED_SCREEN", screen: verdict, confirmed: false };
    }
    if (driver.now() - first >= bounds.screenWaitMs) return { ok: false, failure: "UNRECOGNIZED_SCREEN", screen: verdict, confirmed: false };
    await driver.sleep(bounds.pollMs);
  }
  // Immediately before the key: read once more. Anything but the very same bytes aborts, and nothing is pressed.
  const last = await look();
  if (last.verdict === "REGISTERED") return { ok: true, confirmed: false };
  if (last.raw === null) return { ok: false, failure: "UNRECOGNIZED_SCREEN", screen: last.verdict, confirmed: false };
  if (last.raw !== exactBefore) {
    return { ok: false, failure: last.verdict === "OTHER_DIALOG" ? "UNRECOGNIZED_SCREEN" : "WARNING_DIFFERS", screen: last.verdict, confirmed: false };
  }
  if (driver.proceed) {
    if (!(await driver.proceed())) return { ok: false, failure: "ABORTED", screen: last.verdict, confirmed: false };
    // The wait above took turns of the event loop, in which the pane may have changed: one more read, the same bytes or nothing is pressed.
    const after = await look();
    if (after.verdict === "REGISTERED") return { ok: true, confirmed: false };
    if (after.raw === null) return { ok: false, failure: "UNRECOGNIZED_SCREEN", screen: after.verdict, confirmed: false };
    if (after.raw !== exactBefore) {
      return { ok: false, failure: after.verdict === "OTHER_DIALOG" ? "UNRECOGNIZED_SCREEN" : "WARNING_DIFFERS", screen: after.verdict, confirmed: false };
    }
  }
  await driver.press();
  lastRefusable = null;
  const pressed = driver.now();
  while (true) {
    await driver.sleep(bounds.pollMs);
    const read = await look();
    verdict = read.verdict;
    // The registered line, or the channel's own receipt when its backlog has scrolled that line off the screen.
    if (verdict === "REGISTERED" || await durable()) return { ok: true, confirmed: true };
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
  /** The launch's durable registration signal, usually `channelEmittedSince`. */
  readonly registered?: () => boolean | Promise<boolean>;
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
    ...(input.registered ? { registered: input.registered } : {}),
  };
};

/**
 * Whether this launch's channel server is up in the session: a `registered` receipt (written when Claude Code completes
 * the MCP handshake, so a CTO with nothing queued has one) or an `emitted` receipt (a message taken into the session),
 * carrying this launch's id (`ChannelLaunchInput.launchId`). Either proves the channel registered whatever the screen
 * shows, because a backlog scrolls the startup line away. Time never counts: an
 * older channel process still appending while this one starts writes no id, or another launch's. The file is
 * `channelReceiptPath`'s (`src/buzz/buzz-channel-files.ts`), named here because that module cannot load under the type
 * stripping the host provisioner runs with. An unreadable file or line is no proof.
 */
export const channelEmittedBy = (
  stateDir: string,
  projectId: string,
  launchId: string,
  read: (path: string) => string = (path) => readFileSync(path, "utf8"),
): (() => boolean) => () => {
  let text: string;
  try {
    text = read(join(stateDir, "buzz-channel", `${projectId}.receipts.jsonl`));
  } catch {
    return false;
  }
  return text.split("\n").some((line) => {
    try {
      const receipt = JSON.parse(line) as { type?: unknown; launchId?: unknown };
      return (receipt.type === "emitted" || receipt.type === "registered") && receipt.launchId === launchId;
    } catch {
      return false;
    }
  });
};
