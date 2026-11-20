#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { realpathSync } from "node:fs";
import { isAbsolute, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import { BuzzChannelRelay, type ChannelNotification } from "../buzz/buzz-channel.ts";
import { buildChannelMcpServer, emitChannelNotification } from "../buzz/buzz-channel-mcp.ts";
import { backlogReader, ceoPubkeyResolver } from "../buzz/buzz-channel-daemon-reads.ts";
import {
  appendChannelReceipt,
  fileChannelStateStore,
  readBuzzOwnerPubkeys,
  trimChannelReceipts,
} from "../buzz/buzz-channel-files.ts";
import { loadBuzzSubscriberKey, readBuzzSubscriberConfig } from "../buzz/buzz-mention-subscriber.ts";
import { createSystemRequestWatcher } from "../buzz/buzz-channel-system-request.ts";

/**
 * A CTO session's Buzz channel, as the stdio MCP server Claude Code spawns for it.
 *
 * Claude Code starts one per CTO session (`--dangerously-load-development-channels
 * server:acp-buzz-channel`) and this process is bound to exactly one CTO identity and its room: it
 * signs with that CTO's own key file and holds no other. What it declares to Claude Code is the
 * channel capability (`experimental["claude/channel"]`) and one tool, `reply`.
 *
 * It speaks to the daemon only through files beneath the daemon's state directory (receipts it
 * appends, a cursor it keeps), never over a socket the daemon authenticates: it has no credential
 * to the control plane and asks for none. Everything on stderr is a closed vocabulary of
 * conditions; a key, a token or an event body is never written there.
 */

const USAGE =
  "usage: buzz-channel --project-id <id> --key-file <absolute path> --room <room id> [--room <room id>] " +
  "--state-dir <dir> [--relay-url <wss url>] [--ceo-pubkey <hex>] [--key-encoding hex|nsec] [--launch-id <id>]";

interface Args {
  projectId: string;
  keyFile: string;
  keyEncoding: "hex" | "nsec";
  rooms: string[];
  stateDir: string;
  relayUrl: string | null;
  ceoPubkeys: string[];
  /** The launch that started this server, written into every receipt so the launcher can tell its own. */
  launchId: string | null;
}

export const parseBuzzChannelArgs = (argv: readonly string[]): Args => {
  const out: Args = { projectId: "", keyFile: "", keyEncoding: "hex", rooms: [], stateDir: "", relayUrl: null, ceoPubkeys: [], launchId: null };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag ?? "argument"} needs a value`);
    if (flag === "--project-id") out.projectId = value;
    else if (flag === "--key-file") out.keyFile = value;
    else if (flag === "--key-encoding") {
      if (value !== "hex" && value !== "nsec") throw new Error("--key-encoding must be hex or nsec");
      out.keyEncoding = value;
    } else if (flag === "--room") out.rooms.push(value);
    else if (flag === "--state-dir") out.stateDir = value;
    else if (flag === "--relay-url") out.relayUrl = value;
    else if (flag === "--ceo-pubkey") out.ceoPubkeys.push(value);
    else if (flag === "--launch-id") {
      if (!/^[A-Za-z0-9][A-Za-z0-9-]{3,63}$/u.test(value)) throw new Error("--launch-id must be 4 to 64 letters, digits or dashes");
      out.launchId = value;
    }
    else throw new Error(`unknown argument ${flag}`);
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(out.projectId)) throw new Error("--project-id is required");
  if (!isAbsolute(out.keyFile) || normalize(out.keyFile) !== out.keyFile) throw new Error("--key-file must be an absolute normalized path");
  if (out.rooms.length === 0) throw new Error("--room is required");
  if (!isAbsolute(out.stateDir)) throw new Error("--state-dir must be an absolute path");
  for (const pubkey of out.ceoPubkeys) if (!/^[0-9a-f]{64}$/u.test(pubkey)) throw new Error("--ceo-pubkey must be 64 hex characters");
  return out;
};

const log = (line: string): void => {
  process.stderr.write(`buzz-channel: ${line}\n`);
};

export const runBuzzChannel = async (argv: readonly string[]): Promise<number> => {
  let args: Args;
  try {
    args = parseBuzzChannelArgs(argv);
  } catch (error) {
    log(`${(error as Error).message}\n${USAGE}`);
    return 2;
  }

  let relay!: BuzzChannelRelay;
  // Claude Code completing the MCP handshake is the moment it has the server and its channel capability. A CTO with nothing
  // queued emits no message, so this receipt, carrying the launch id, is what lets the launcher tell the channel came up.
  const server = buildChannelMcpServer((input) => relay.reply(input), () => {
    try {
      appendChannelReceipt(args.stateDir, args.projectId, { type: "registered", registeredAt: Math.floor(Date.now() / 1000) }, args.launchId ?? undefined);
    } catch {
      log("the registration receipt could not be written");
    }
  });

  try {
    const relayUrl = args.relayUrl ?? readBuzzSubscriberConfig(args.stateDir)?.relayUrl ?? process.env["ACP_BUZZ_RELAY_URL"];
    if (!relayUrl?.startsWith("wss://")) throw new Error("no wss relay url: pass --relay-url or configure the daemon's relay");
    const key = loadBuzzSubscriberKey({ privateKeyFile: args.keyFile, encoding: args.keyEncoding, rooms: args.rooms }, "channel identity");
    trimChannelReceipts(args.stateDir, args.projectId);
    // The bound CEO is read from the daemon's database when a message arrives, not copied at launch, so a CEO re-claim is
    // followed, and by the daemon's own rule. The database is opened for each read and closed again: this process holds
    // nothing of the daemon's between reads, so a deploy that stops the daemon finds no holder.
    const ceoPubkeys = args.ceoPubkeys.length > 0 ? (): readonly string[] => args.ceoPubkeys : ceoPubkeyResolver(args.stateDir);
    relay = new BuzzChannelRelay({
      relayUrl,
      projectId: args.projectId,
      secretKey: key.secretKey,
      rooms: args.rooms,
      ceoPubkeys,
      ownerPubkeys: readBuzzOwnerPubkeys(args.stateDir),
      store: fileChannelStateStore(args.stateDir, args.projectId),
      // What the daemon's queue still holds for this role: delivered once, oldest first, when the relay first accepts the channel.
      backlog: backlogReader(args.stateDir, args.projectId),
      onNotification: (n: ChannelNotification) => emitChannelNotification(server, n),
      onReceipt: (receipt) => {
        try {
          appendChannelReceipt(args.stateDir, args.projectId, receipt, args.launchId ?? undefined);
        } catch {
          log("a receipt could not be written; the message stays pending in the control plane's queue");
        }
      },
      onDiagnostic: log,
    });
  } catch (error) {
    log((error as Error).message);
    return 3;
  }

  await server.connect(new StdioServerTransport());
  relay.start();
  // ACP's own request (a long conversation's handoff) is shown here, once per request, from a file the daemon writes.
  const requests = createSystemRequestWatcher({ stateDir: args.stateDir, projectId: args.projectId, emit: (n) => emitChannelNotification(server, n), onDiagnostic: log });
  requests.start();
  await new Promise<void>((resolve) => {
    server.onclose = () => resolve();
    process.stdin.once("close", () => resolve());
  });
  requests.stop();
  relay.close();
  return 0;
};

/**
 * Whether this module is the program that was started.
 *
 * `import.meta.url` is always the realpath Node resolved the module through, but `process.argv[1]` is whatever
 * path the caller passed, and the resident launcher passes `<state>/current/dist/cli/buzz-channel.js` with `current`
 * a link to the generation in use. Comparing the two literally never matches there: the process exits 0 having done
 * nothing, and Claude Code reports the server closed. Both sides are resolved to their realpath, as `agentctl` does;
 * a path that cannot be resolved is "not main", never thrown.
 */
const isMainModule = (): boolean => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
};

if (isMainModule()) {
  runBuzzChannel(process.argv.slice(2)).then((code) => process.exit(code), () => process.exit(1));
}
