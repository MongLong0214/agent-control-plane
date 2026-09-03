#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

import { isAcpError } from "../core/errors.ts";
import { SingleInstanceLock } from "../daemon/single-instance.ts";
import { backupDatabase, pruneAutomaticBackups, restoreDatabase } from "./backup.ts";
import {
  approveMigration,
  migrationApprovalPath,
  migrationPlanFrom,
  migrationRefusalPath,
  onDiskSchemaVersion,
  readMigrationApproval,
} from "./migration-approval.ts";
import { migrateApprovedCopy } from "./database.ts";
import { SCHEMA_VERSION } from "./migrations.ts";
import { targetIdentityOf } from "./target-identity.ts";
import { assertPrivatePath, ensurePrivateDirectory } from "./state-preflight.ts";

const readApprovalForReport = (databasePath: string): unknown => {
  try {
    return readMigrationApproval(databasePath);
  } catch (error) {
    return { unreadable: migrationApprovalPath(databasePath), error: String(error) };
  }
};

const readJsonIfPresent = (path: string): unknown => {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return { unreadable: path };
  }
};

const defaultDatabasePath = (): string => join(homedir(), ".agent-control-plane", "state.sqlite");

const USAGE = `agentcpd-state — database backup, restore and migration approval

  agentcpd-state backup [--database /absolute/state.sqlite] [--output /absolute/backup.sqlite]
  agentcpd-state restore <backup.sqlite> --confirm-restore [--database /absolute/state.sqlite]
  agentcpd-state migration-plan [--database /absolute/state.sqlite]
  agentcpd-state approve-migration --approved-by <who> --confirm-migration [--database /absolute/state.sqlite]
  agentcpd-state migrate-approved-copy --database-copy /absolute/copy.sqlite --confirm-migration

Backup uses SQLite's online backup API and may run while agentcpd is running.
Restore refuses a live agentcpd lock; stop the launchd job first. It preserves the
replaced database under <state-dir>/backups/ before installing the checked snapshot.

migration-plan reads the database read-only and reports what a start with these bytes
would do to it — the version it is at, the version this build declares, the ordered
migrations between them, any approval already on file, and the last refusal report. It
is the observation path that still answers when the daemon will not start.

migrate-approved-copy runs the approved chain against one disposable copy and exits. It takes
--database-copy and has no default: the default is the one database it must never touch. It
refuses a symlink, a non-regular file, a file with more than one link, a copy with a write-ahead
log beside it, and anything that resolves to the deployment's own database. It opens that pathname
exactly once, read-write, and every later decision is about that descriptor rather than about the
name; the chain runs against a staged image and is written back through the same descriptor, so
the copy is written once, at the end, and every refusal happens before that write. Nothing is
started; there is no daemon, listener or surviving child. This is the supported form of the dry run the reconciliation
packet used to spell out as an inline node evaluation.

approve-migration is the owner's decision to let that happen. It refuses a live agentcpd
lock, takes the recovery point the approval will rest on, and writes an approval naming
the exact chain. It approves one migration between two named versions, not migrations in
general: after the chain runs, the approval no longer matches anything.
`;

const COMMANDS = [
  "backup",
  "restore",
  "migration-plan",
  "approve-migration",
  "migrate-approved-copy",
] as const;
type Command = (typeof COMMANDS)[number];

const isCommand = (value: string | undefined): value is Command =>
  value !== undefined && (COMMANDS as readonly string[]).includes(value);

interface Parsed {
  command: Command;
  databasePath: string;
  output: string | null;
  backupPath: string | null;
  confirmed: boolean;
  approvedBy: string | null;
  confirmedMigration: boolean;
  /** Only `migrate-approved-copy` has this, and it has no default. */
  databaseCopy: string | null;
}

const parse = (argv: string[]): Parsed => {
  const [command, ...tokens] = argv;
  if (!isCommand(command)) throw new Error(USAGE);
  let databasePath = defaultDatabasePath();
  let output: string | null = null;
  let backupPath: string | null = null;
  let confirmed = false;
  let approvedBy: string | null = null;
  let confirmedMigration = false;
  let databaseCopy: string | null = null;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) continue;
    if (token === "--database") {
      databasePath = tokens[index + 1] ?? "";
      index += 1;
    } else if (token === "--output") {
      output = tokens[index + 1] ?? "";
      index += 1;
    } else if (token === "--approved-by") {
      approvedBy = tokens[index + 1] ?? "";
      index += 1;
    } else if (token === "--database-copy") {
      databaseCopy = tokens[index + 1] ?? "";
      index += 1;
    } else if (token === "--confirm-migration") {
      confirmedMigration = true;
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
  if (command === "approve-migration" && (!confirmedMigration || approvedBy === null)) {
    throw new Error(
      `approve-migration requires --approved-by <who> and --confirm-migration\n\n${USAGE}`,
    );
  }
  if (command === "migrate-approved-copy") {
    // A closed grammar for this one command: exactly `--database-copy <path>` once and
    // `--confirm-migration` once, and nothing else. Every other command's flags are refused here
    // rather than ignored — `--database` in particular, because its default is the one database
    // this command exists never to touch, and accepting it beside `--database-copy` would leave
    // two answers to "which file" in one invocation.
    const allowed = new Set(["--database-copy", "--confirm-migration"]);
    const seen = new Map<string, number>();
    for (const token of tokens) {
      if (!token.startsWith("--")) continue;
      seen.set(token, (seen.get(token) ?? 0) + 1);
      if (!allowed.has(token)) {
        throw new Error(`migrate-approved-copy does not take ${token}\n\n${USAGE}`);
      }
    }
    const repeated = [...seen.entries()].filter(([, count]) => count > 1).map(([flag]) => flag);
    if (repeated.length > 0) {
      // A repeat is not a typo to absorb: the later value silently won, so the operator's first
      // answer and the one that ran were different.
      throw new Error(
        `migrate-approved-copy takes each of ${repeated.sort().join(", ")} once\n\n${USAGE}`,
      );
    }
    // Walked by index, not by value. `tokens.indexOf(token)` answers for the *first* token with
    // that text, so `--database-copy /x --confirm-migration /x` asked about the trailing `/x` and
    // was told about the one at index 1 — which does follow `--database-copy`, so this walk called
    // a stray positional a flag value. Every argument in this grammar is a path, so a repeated
    // value is what an operator types when they paste the same path twice, not an exotic case.
    //
    // Defence in depth, and measured as such: the general token loop above refuses any bare token
    // for this command before control reaches here, so no CLI input observed on 2026-09-02 makes
    // this walk decide anything — deleting it outright still refuses both spellings above. It is
    // kept correct rather than kept as an oracle: what refuses the operator today is that loop,
    // and this file should not read as though this line were the enforcement site.
    const positional: string[] = [];
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index]!;
      if (token.startsWith("--")) continue;
      if (index > 0 && tokens[index - 1] === "--database-copy") continue;
      positional.push(token);
    }
    if (positional.length > 0) {
      throw new Error(`migrate-approved-copy takes no positional argument\n\n${USAGE}`);
    }
  }
  if (command === "migrate-approved-copy") {
    // Two separate refusals with two separate messages. "Which database" and "are you sure" are
    // different questions, and collapsing them into one error makes the operator guess which half
    // they missed.
    if (databaseCopy === null) {
      throw new Error(`migrate-approved-copy requires --database-copy <absolute path>\n\n${USAGE}`);
    }
    if (!confirmedMigration) {
      throw new Error(`migrate-approved-copy requires --confirm-migration\n\n${USAGE}`);
    }
    if (!isAbsolute(databaseCopy)) throw new Error("database, output and backup paths must be absolute");
  } else if (databaseCopy !== null) {
    throw new Error(`--database-copy belongs to migrate-approved-copy\n\n${USAGE}`);
  }
  if (command === "backup" && backupPath !== null) throw new Error(USAGE);
  return {
    command,
    databasePath,
    output,
    backupPath,
    confirmed,
    approvedBy,
    confirmedMigration,
    databaseCopy,
  };
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

  if (parsed.command === "migration-plan") {
    const version = onDiskSchemaVersion(parsed.databasePath);
    process.stdout.write(
      `${JSON.stringify(
        {
          databasePath: parsed.databasePath,
          onDiskVersion: version,
          buildVersion: SCHEMA_VERSION,
          // A start that does not migrate is the ordinary case and says so with an empty plan,
          // rather than by this command having nothing to print.
          plan: version === SCHEMA_VERSION || version === 0 ? null : migrationPlanFrom(version),
          target: targetIdentityOf(parsed.databasePath),
          // Reported, never thrown on: this is the command an owner runs *because* something is
          // wrong, so a malformed approval has to be visible here rather than take the reading
          // down with it. A file naming this build's version while the database already has it
          // is bookkeeping whose rename failed (#747) — inert, and repaired on the next open.
          approvalOnFile: readApprovalForReport(parsed.databasePath),
          approvalIsStale: version === SCHEMA_VERSION && existsSync(migrationApprovalPath(parsed.databasePath)),
          lastRefusal: readJsonIfPresent(migrationRefusalPath(parsed.databasePath)),
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  if (parsed.command === "approve-migration") {
    // The approval's recovery point has to be an image of a database nobody is writing to. A
    // live daemon also means the migration this approves would race that process's handle.
    const holder = daemonIsLive(parsed.databasePath);
    if (holder) {
      throw new Error(
        `refusing to approve a migration while agentcpd pid ${holder.pid} holds the state lock (started ${holder.startedAt})`,
      );
    }
    const approval = approveMigration(parsed.databasePath, parsed.approvedBy!);
    process.stdout.write(
      `${JSON.stringify({ approval, approvalPath: migrationApprovalPath(parsed.databasePath) }, null, 2)}\n`,
    );
    return 0;
  }

  if (parsed.command === "migrate-approved-copy") {
    // Every refusal — link, non-regular file, extra link, canonical identity, version, approval
    // target and ordered plan — is inside `migrateApprovedCopy`, under the migration lock and
    // before the first writable handle. Checking any of them here would be checking them outside
    // that lock, which is the window a replacement at this pathname walks through.
    const report = migrateApprovedCopy(parsed.databaseCopy!);
    // Version, ids, whether each receipt carries a checksum, retirement, and the mode. Not the
    // path: an operator pastes this into a report, and the location of a private copy is not part
    // of what the chain did.
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
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
