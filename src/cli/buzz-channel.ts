#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import { BuzzChannelRelay, type ChannelNotification } from "../buzz/buzz-channel.ts";
import { buildChannelMcpServer, emitChannelNotification } from "../buzz/buzz-channel-mcp.ts";
import {
  appendChannelReceipt,
  fileChannelStateStore,
  readBuzzOwnerPubkeys,
  trimChannelReceipts,
} from "../buzz/buzz-channel-files.ts";
import { loadBuzzSubscriberKey, readBuzzSubscriberConfig } from "../buzz/buzz-mention-subscriber.ts";

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
  "--state-dir <dir> [--relay-url <wss url>] [--ceo-pubkey <hex>] [--key-encoding hex|nsec]";

interface Args {
  projectId: string;
  keyFile: string;
  keyEncoding: "hex" | "nsec";
  rooms: string[];
  stateDir: string;
  relayUrl: string | null;
  ceoPubkeys: string[];
}

const parseArgs = (argv: readonly string[]): Args => {
  const out: Args = { projectId: "", keyFile: "", keyEncoding: "hex", rooms: [], stateDir: "", relayUrl: null, ceoPubkeys: [] };
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

/**
 * The bound CEO actor, read from the daemon's database when a message arrives rather than copied at
 * launch, so a CEO re-claim is followed. Read-only, cached for a few seconds, and empty (nobody is
 * heard) when the database cannot be read.
 */
const canonicalCeoResolver = (stateDir: string): (() => readonly string[]) => {
  let cachedAt = 0;
  let cached: readonly string[] = [];
  let open: ((sql: string) => unknown[]) | null = null;
  return () => {
    const now = Date.now();
    if (now - cachedAt < 5_000) return cached;
    cachedAt = now;
    try {
      open ??= (() => {
        const Database = createRequire(import.meta.url)("better-sqlite3") as new (
          path: string,
          options: { readonly: boolean; fileMustExist: boolean },
        ) => { prepare(sql: string): { all(...params: unknown[]): unknown[] } };
        const db = new Database(join(stateDir, "state.sqlite"), { readonly: true, fileMustExist: true });
        return (sql: string) => db.prepare(sql).all();
      })();
      return (cached = ceoRecipients(open));
    } catch {
      open = null;
      return (cached = []);
    }
  };
};

const ceoRecipients = (all: (sql: string) => unknown[]): readonly string[] => {
  // The same single-row authority the daemon's CEO signer uses; two answers mean no answer.
  const rows = all(`SELECT DISTINCT s.buzz_actor_id AS recipient
    FROM assignments a JOIN conversational_actors c ON c.actor_id = a.actor_id
    JOIN sessions s ON s.session_id = c.current_session_id AND s.incarnation = c.current_session_incarnation
    WHERE a.role_key = 'CEO' AND a.role = 'CEO' AND a.status = 'ACTIVE' AND s.lifecycle IN ('READY','DRAINING')
      AND COALESCE(s.buzz_actor_id, '') <> ''`) as { recipient: string }[];
  return rows.length === 1 && /^[0-9a-f]{64}$/u.test(rows[0]!.recipient) ? [rows[0]!.recipient] : [];
};

export const runBuzzChannel = async (argv: readonly string[]): Promise<number> => {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    log(`${(error as Error).message}\n${USAGE}`);
    return 2;
  }

  let relay!: BuzzChannelRelay;
  const server = buildChannelMcpServer((input) => relay.reply(input));

  try {
    const relayUrl = args.relayUrl ?? readBuzzSubscriberConfig(args.stateDir)?.relayUrl ?? process.env["ACP_BUZZ_RELAY_URL"];
    if (!relayUrl?.startsWith("wss://")) throw new Error("no wss relay url: pass --relay-url or configure the daemon's relay");
    const key = loadBuzzSubscriberKey({ privateKeyFile: args.keyFile, encoding: args.keyEncoding, rooms: args.rooms }, "channel identity");
    trimChannelReceipts(args.stateDir, args.projectId);
    const ceoPubkeys = args.ceoPubkeys.length > 0 ? (): readonly string[] => args.ceoPubkeys : canonicalCeoResolver(args.stateDir);
    relay = new BuzzChannelRelay({
      relayUrl,
      projectId: args.projectId,
      secretKey: key.secretKey,
      rooms: args.rooms,
      ceoPubkeys,
      ownerPubkeys: readBuzzOwnerPubkeys(args.stateDir),
      store: fileChannelStateStore(args.stateDir, args.projectId),
      onNotification: (n: ChannelNotification) => emitChannelNotification(server, n),
      onReceipt: (receipt) => {
        try {
          appendChannelReceipt(args.stateDir, args.projectId, receipt);
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
  await new Promise<void>((resolve) => {
    server.onclose = () => resolve();
    process.stdin.once("close", () => resolve());
  });
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
