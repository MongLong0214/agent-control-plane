#!/usr/bin/env node
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

import { isAcpError } from "../core/errors.ts";
import { SingleInstanceLock } from "../daemon/single-instance.ts";
import { backupDatabase, pruneAutomaticBackups, restoreDatabase } from "./backup.ts";
import { assertPrivatePath, ensurePrivateDirectory } from "./state-preflight.ts";

const defaultDatabasePath = (): string => join(homedir(), ".agent-control-plane", "state.sqlite");

const USAGE = `agentcpd-state — database backup and restore maintenance

  agentcpd-state backup [--database /absolute/state.sqlite] [--output /absolute/backup.sqlite]
  agentcpd-state restore <backup.sqlite> --confirm-restore [--database /absolute/state.sqlite]

Backup uses SQLite's online backup API and may run while agentcpd is running.
Restore refuses a live agentcpd lock; stop the launchd job first. It preserves the
replaced database under <state-dir>/backups/ before installing the checked snapshot.
`;

interface Parsed {
  command: "backup" | "restore";
  databasePath: string;
  output: string | null;
  backupPath: string | null;
  confirmed: boolean;
}

const parse = (argv: string[]): Parsed => {
  const [command, ...tokens] = argv;
  if (command !== "backup" && command !== "restore") throw new Error(USAGE);
  let databasePath = defaultDatabasePath();
  let output: string | null = null;
  let backupPath: string | null = null;
  let confirmed = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) continue;
    if (token === "--database") {
      databasePath = tokens[index + 1] ?? "";
      index += 1;
    } else if (token === "--output") {
      output = tokens[index + 1] ?? "";
      index += 1;
    } else if (token === "--confirm-restore") {
      confirmed = true;
    } else if (!token.startsWith("--") && command === "restore" && backupPath === null) {
      backupPath = token;
    } else {
      throw new Error(`unknown or misplaced argument: ${token}\n\n${USAGE}`);
    }
  }
  if (!isAbsolute(databasePath) || (output !== null && !isAbsolute(output)) || (backupPath !== null && !isAbsolute(backupPath))) {
    throw new Error("database, output and backup paths must be absolute");
  }
  if (command === "restore" && (!backupPath || !confirmed)) {
    throw new Error(`restore requires an absolute backup path and --confirm-restore\n\n${USAGE}`);
  }
  if (command === "backup" && backupPath !== null) throw new Error(USAGE);
  return { command, databasePath, output, backupPath, confirmed };
};

const daemonIsLive = (databasePath: string): { pid: number; startedAt: string } | null => {
  ensurePrivateDirectory(dirname(databasePath));
  const lockPath = join(dirname(databasePath), "agentcpd.lock");
  if (!existsSync(lockPath)) return null;
  assertPrivatePath(lockPath, "file");
  const lock = new SingleInstanceLock(lockPath).read();
  if (!lock) {
    throw new Error("agentcpd lock is malformed; wait for its writer or remove it only after confirming the daemon stopped");
  }
  try {
    process.kill(lock.pid, 0);
    return { pid: lock.pid, startedAt: lock.startedAt };
  } catch {
    return null;
  }
};

export const main = async (argv: string[]): Promise<number> => {
  const parsed = parse(argv);
  if (parsed.command === "backup") {
    const backup = parsed.output === null
      ? await backupDatabase(parsed.databasePath)
      : await backupDatabase(parsed.databasePath, parsed.output);
    if (parsed.output === null) pruneAutomaticBackups(parsed.databasePath);
    process.stdout.write(`${JSON.stringify({ backup }, null, 2)}\n`);
    return 0;
  }

  const live = daemonIsLive(parsed.databasePath);
  if (live) {
    throw new Error(`refusing restore while agentcpd pid ${live.pid} holds the state lock (started ${live.startedAt})`);
  }
  const restored = restoreDatabase(parsed.databasePath, parsed.backupPath!);
  process.stdout.write(`${JSON.stringify({ restored }, null, 2)}\n`);
  return 0;
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      const body = isAcpError(error)
        ? { reasonCode: error.reasonCode, message: error.message, evidence: error.evidence }
        : { message: error instanceof Error ? error.message : String(error) };
      process.stderr.write(`${JSON.stringify(body, null, 2)}\n`);
      process.exit(1);
    });
}
