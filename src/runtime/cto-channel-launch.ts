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
