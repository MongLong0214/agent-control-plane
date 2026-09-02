#!/usr/bin/env node
import { existsSync, lstatSync, readFileSync } from "node:fs";
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
import { isSameTarget, targetIdentityOf } from "./target-identity.ts";
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
refuses a symlink, a non-regular file, a file with more than one link, and anything that resolves
to the deployment's own database, before it opens anything. Nothing is started; there is no
daemon, listener or surviving child. This is the supported form of the dry run the reconciliation
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
    const copy = parsed.databaseCopy!;
    // Every one of these runs before `Db` is constructed, because `Db`'s first act is to open the
    // file and its second is to migrate it. A check after that point is a check on a database
    // that has already been changed.
    const stat = lstatSync(copy, { throwIfNoEntry: false });
    if (!stat) throw new Error("the named copy does not exist");
    if (stat.isSymbolicLink()) {
      // A symlink is a second name for bytes the approval named once. Following it would migrate
      // a file the operator did not type.
      throw new Error("refusing a symbolic link: name the copy itself");
    }
    if (!stat.isFile()) throw new Error("refusing a target that is not a regular file");
    if (stat.nlink !== 1) {
      // More than one link means the file the approval named is not the only way to reach these
      // bytes, so "this copy" no longer identifies anything.
      throw new Error(`refusing a copy with ${stat.nlink} links: it is reachable under another name`);
    }
    const canonical = defaultDatabasePath();
    if (existsSync(canonical) && isSameTarget(targetIdentityOf(copy), targetIdentityOf(canonical))) {
      // The whole point of the command. Identity rather than path equality, so a different
      // spelling of the same file is refused too.
      throw new Error("refusing to migrate the deployment's own database through the copy path");
    }
    // The approval and the version are checked before anything opens the file read-write. `Db`
    // checks both again — that redundancy is deliberate — but its first act is to open, and an
    // open is a write to the header. Measured: a refusal reached after construction still moved a
    // byte in a database this command had just declined to touch, which is not "unchanged".
    const onDisk = onDiskSchemaVersion(copy);
    const approval = readMigrationApproval(copy);
    if (!approval) throw new Error("no approval is on file for this copy");
    if (approval.fromVersion !== onDisk) {
      throw new Error(
        `the approval starts at ${approval.fromVersion} and this copy is at ${onDisk}`,
      );
    }
    if (approval.toVersion !== SCHEMA_VERSION) {
      throw new Error(
        `the approval ends at ${approval.toVersion} and this build declares ${SCHEMA_VERSION}`,
      );
    }
    const report = migrateApprovedCopy(copy);
    // Version, ids, whether each receipt carries a checksum, retirement, and the mode. Not the
    // path: an operator pastes this into a report, and the location of a private copy is not
    // part of what the chain did.
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
