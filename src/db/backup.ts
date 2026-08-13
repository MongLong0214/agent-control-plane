import { randomUUID, createHash } from "node:crypto";
import Database from "better-sqlite3";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  constants as fsConstants,
  existsSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";

import { acpError } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import {
  SCHEMA_VERSION,
  assertLoadBearingInvariants,
  assertMigrationLedgerAt,
  migrationChainFrom,
} from "./migrations.ts";
import {
  PRIVATE_FILE_MODE,
  assertPrivateDatabaseFiles,
  assertPrivatePath,
  databaseSidecarPaths,
  ensurePrivateDirectory,
} from "./state-preflight.ts";

export const DEFAULT_BACKUP_RETENTION = 10;

export interface DatabaseBackup {
  path: string;
  manifestPath: string;
  sha256: string;
  schemaVersion: number;
}

interface BackupManifest {
  format: "agent-control-plane.sqlite-backup/v1";
  databaseFile: string;
  databaseSha256: string;
  schemaVersion: number;
  createdAt: string;
}

export interface RestoreResult {
  databasePath: string;
  restoredFrom: string;
  preservedDatabasePath: string | null;
  preservedSidecars: string[];
}

const hashFile = (path: string): string => {
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    let position = 0;
    for (;;) {
      const bytes = readSync(fd, buffer, 0, buffer.length, position);
      if (bytes === 0) break;
      hash.update(buffer.subarray(0, bytes));
      position += bytes;
    }
  } finally {
    closeSync(fd);
  }
  return `sha256:${hash.digest("hex")}`;
};

const backupManifestPath = (backupPath: string): string => `${backupPath}.manifest.json`;

export const defaultBackupDirectory = (databasePath: string): string => join(dirname(databasePath), "backups");

const safeLabel = (label: string): string => {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/i.test(label)) {
    throw acpError(ReasonCode.INVALID_ARGUMENT, "backup label must be a safe filename component", { label });
  }
  return label;
};

export const nextBackupPath = (databasePath: string, label: string): string => {
  if (!isAbsolute(databasePath)) {
    throw acpError(ReasonCode.STATE_PATH_INSECURE, "database path must be absolute for backup", { databasePath });
  }
  const directory = defaultBackupDirectory(databasePath);
  ensurePrivateDirectory(directory);
  return join(
    directory,
    `${basename(databasePath)}-${safeLabel(label)}-${Date.now()}-${randomUUID()}.sqlite`,
  );
};

export const assertIntegrity = (raw: Database.Database, path: string): void => {
  const result = raw.pragma("integrity_check", { simple: true });
  if (result === "ok") return;
  throw acpError(ReasonCode.INTERNAL_ERROR, "SQLite integrity check failed", { path, integrityCheck: result });
};

const schemaVersion = (raw: Database.Database): number =>
  Number(raw.pragma("user_version", { simple: true }));

const assertUnusedBackupDestination = (destination: string): void => {
  if (!isAbsolute(destination)) {
    throw acpError(ReasonCode.STATE_PATH_INSECURE, "backup destination must be absolute", { destination });
  }
  ensurePrivateDirectory(dirname(destination));
  if (existsSync(destination) || existsSync(backupManifestPath(destination))) {
    throw acpError(ReasonCode.CONFLICT, "backup destination already exists", { destination });
  }
};

const stagedBackupPath = (destination: string): string =>
  join(dirname(destination), `.${basename(destination)}.backup-${process.pid}-${randomUUID()}.tmp`);

/** Atomically reserve a destination without ever following a raced-in path or symlink. */
const publishStagedBackup = (staged: string, destination: string): void => {
  linkSync(staged, destination);
  unlinkSync(staged);
};

const writeManifest = (backupPath: string, version: number): DatabaseBackup => {
  assertPrivatePath(backupPath, "file");
  const sha256 = hashFile(backupPath);
  const manifestPath = backupManifestPath(backupPath);
  const manifest: BackupManifest = {
    format: "agent-control-plane.sqlite-backup/v1",
    databaseFile: basename(backupPath),
    databaseSha256: sha256,
    schemaVersion: version,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, { encoding: "utf8", mode: PRIVATE_FILE_MODE, flag: "wx" });
  assertPrivatePath(manifestPath, "file");
  return { path: backupPath, manifestPath, sha256, schemaVersion: version };
};

const removePartialBackup = (path: string): void => {
  for (const target of [path, backupManifestPath(path)]) {
    try {
      if (existsSync(target) && lstatSync(target).isFile() && !lstatSync(target).isSymbolicLink()) {
        unlinkSync(target);
      }
    } catch {
      // A failed backup must never make us remove an unverified path while handling its error.
    }
  }
};

/** A synchronous online snapshot used before a constructor-owned migration begins. */
export const backupOpenDatabaseSync = (
  raw: Database.Database,
  sourcePath: string,
  destination: string,
): DatabaseBackup => {
  assertPrivateDatabaseFiles(sourcePath);
  assertUnusedBackupDestination(destination);
  const staged = stagedBackupPath(destination);
  let published = false;
  try {
    // VACUUM INTO is an SQLite-consistent snapshot, including committed WAL contents. It is
    // synchronous so Db's constructor can make a recovery point before changing schema.
    raw.exec(`VACUUM INTO '${staged.replaceAll("'", "''")}'`);
    chmodSync(staged, PRIVATE_FILE_MODE);
    publishStagedBackup(staged, destination);
    published = true;
    return writeManifest(destination, schemaVersion(raw));
  } catch (error) {
    removePartialBackup(staged);
    if (published) removePartialBackup(destination);
    throw error;
  }
};

/** A human-triggered online snapshot. The backup API keeps a running daemon's WAL coherent. */
export const backupDatabase = async (
  databasePath: string,
  destination = nextBackupPath(databasePath, "manual"),
): Promise<DatabaseBackup> => {
  assertPrivateDatabaseFiles(databasePath);
  assertUnusedBackupDestination(destination);
  const staged = stagedBackupPath(destination);
  let published = false;
  const raw = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    raw.pragma("busy_timeout = 10000");
    assertIntegrity(raw, databasePath);
    await raw.backup(staged);
    chmodSync(staged, PRIVATE_FILE_MODE);
    publishStagedBackup(staged, destination);
    published = true;
    return writeManifest(destination, schemaVersion(raw));
  } catch (error) {
    removePartialBackup(staged);
    if (published) removePartialBackup(destination);
    throw error;
  } finally {
    raw.close();
  }
};

const readManifest = (backupPath: string): BackupManifest => {
  const manifestPath = backupManifestPath(backupPath);
  assertPrivatePath(backupPath, "file");
  assertPrivatePath(manifestPath, "file");
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as Partial<BackupManifest>;
    if (
      parsed.format !== "agent-control-plane.sqlite-backup/v1" ||
      parsed.databaseFile !== basename(backupPath) ||
      typeof parsed.databaseSha256 !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(parsed.databaseSha256) ||
      !Number.isInteger(parsed.schemaVersion) ||
      typeof parsed.createdAt !== "string"
    ) {
      throw new Error("backup manifest has an invalid shape");
    }
    return parsed as BackupManifest;
  } catch (error) {
    throw acpError(ReasonCode.INTERNAL_ERROR, "backup manifest is unreadable or invalid", {
      backupPath,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

const validateBackup = (backupPath: string): BackupManifest => {
  const manifest = readManifest(backupPath);
  const actual = hashFile(backupPath);
  if (actual !== manifest.databaseSha256) {
    throw acpError(ReasonCode.INTERNAL_ERROR, "backup checksum does not match its manifest", {
      backupPath,
      expected: manifest.databaseSha256,
      actual,
    });
  }
  const raw = new Database(backupPath, { readonly: true, fileMustExist: true });
  try {
    assertIntegrity(raw, backupPath);
    const version = schemaVersion(raw);
    if (version !== manifest.schemaVersion) {
      throw acpError(ReasonCode.INTERNAL_ERROR, "backup schema version does not match its manifest", {
        backupPath,
        expected: manifest.schemaVersion,
        actual: version,
      });
    }
    if (version > SCHEMA_VERSION) {
      throw acpError(ReasonCode.INTERNAL_ERROR, "backup was made by a newer binary", {
        backupPath,
        expected: SCHEMA_VERSION,
        found: version,
      });
    }
    if (version < SCHEMA_VERSION) migrationChainFrom(version);
    assertLoadBearingInvariants(raw, {
      includeMigrationLedger: version >= 12,
      includeBaselineLedger: version >= 14,
    });
    if (version >= 12) assertMigrationLedgerAt(raw, version);
  } finally {
    raw.close();
  }
  return manifest;
};

const validateRestoredTemporary = (path: string, expectedSha256: string): void => {
  assertPrivatePath(path, "file");
  const actual = hashFile(path);
  if (actual !== expectedSha256) {
    throw acpError(ReasonCode.INTERNAL_ERROR, "copied restore image checksum changed", {
      path,
      expected: expectedSha256,
      actual,
    });
  }
  const raw = new Database(path, { readonly: true, fileMustExist: true });
  try {
    assertIntegrity(raw, path);
  } finally {
    raw.close();
  }
};

/**
 * Restore only accepts a manifest-checked, owner-private snapshot and stages it in the
 * destination directory before replacement. The old database and sidecars are preserved
 * under backups/ for forensic recovery; this is intentionally not a delete-and-copy flow.
 * The caller must first stop the daemon, which the maintenance CLI enforces.
 */
export const restoreDatabase = (databasePath: string, backupPath: string): RestoreResult => {
  if (!isAbsolute(databasePath) || !isAbsolute(backupPath)) {
    throw acpError(ReasonCode.STATE_PATH_INSECURE, "database and backup paths must be absolute", {
      databasePath,
      backupPath,
    });
  }
  ensurePrivateDirectory(dirname(databasePath));
  const hadDatabase = existsSync(databasePath);
  const existingSidecars = databaseSidecarPaths(databasePath).filter((sidecar) => existsSync(sidecar));
  if (hadDatabase) assertPrivateDatabaseFiles(databasePath);
  else for (const sidecar of existingSidecars) assertPrivatePath(sidecar, "file");

  const manifest = validateBackup(backupPath);
  const temporary = join(dirname(databasePath), `.${basename(databasePath)}.restore-${process.pid}-${randomUUID()}.tmp`);
  if (existsSync(temporary)) {
    throw acpError(ReasonCode.CONFLICT, "restore temporary path unexpectedly exists", { temporary });
  }

  copyFileSync(backupPath, temporary, fsConstants.COPYFILE_EXCL);
  try {
    // copyFile follows no target symlink because the destination did not exist. Make the
    // staged image private before opening it for its final integrity check.
    chmodSync(temporary, PRIVATE_FILE_MODE);
    validateRestoredTemporary(temporary, manifest.databaseSha256);

    const backupDirectory = defaultBackupDirectory(databasePath);
    ensurePrivateDirectory(backupDirectory);
    const preservedDatabasePath = hadDatabase
      ? join(backupDirectory, `${basename(databasePath)}-pre-restore-${Date.now()}-${randomUUID()}.sqlite`)
      : null;
    const preservedSidecars: Array<{ from: string; to: string }> = [];
    const sidecarPreservationBase = preservedDatabasePath ?? join(
      backupDirectory,
      `${basename(databasePath)}-orphaned-sidecar-pre-restore-${Date.now()}-${randomUUID()}.sqlite`,
    );

    try {
      if (preservedDatabasePath) {
        renameSync(databasePath, preservedDatabasePath);
      }
      for (const sidecar of existingSidecars) {
        const suffix = sidecar.slice(databasePath.length);
        const preserved = `${sidecarPreservationBase}${suffix}`;
        renameSync(sidecar, preserved);
        preservedSidecars.push({ from: sidecar, to: preserved });
      }
      renameSync(temporary, databasePath);
      assertPrivateDatabaseFiles(databasePath);
    } catch (error) {
      // A failed final rename must leave a recoverable old database, never an empty state
      // path that launchd could restart against.
      if (!existsSync(databasePath)) {
        if (preservedDatabasePath && existsSync(preservedDatabasePath)) {
          renameSync(preservedDatabasePath, databasePath);
        }
        for (const sidecar of preservedSidecars) {
          if (existsSync(sidecar.to)) renameSync(sidecar.to, sidecar.from);
        }
      }
      throw error;
    }

    return {
      databasePath,
      restoredFrom: backupPath,
      preservedDatabasePath,
      preservedSidecars: preservedSidecars.map((sidecar) => sidecar.to),
    };
  } finally {
    removePartialBackup(temporary);
  }
};

/** Keeps generated automatic backups bounded without touching operator-named snapshots. */
export const pruneAutomaticBackups = (databasePath: string, retention = DEFAULT_BACKUP_RETENTION): void => {
  if (!Number.isInteger(retention) || retention < 1) {
    throw acpError(ReasonCode.INVALID_ARGUMENT, "backup retention must be a positive integer", { retention });
  }
  const directory = defaultBackupDirectory(databasePath);
  if (!existsSync(directory)) return;
  assertPrivatePath(directory, "directory");
  // Generated names are the authority boundary, and exact names below prevent an
  // operator's explicitly named snapshot from becoming retention collateral.
  const generated = readdirSync(directory)
    .filter((entry) => new RegExp(`^${escapeRegex(basename(databasePath))}-(?:manual|pre-migration-v\\d+)-\\d+-[a-f0-9-]+\\.sqlite$`, "i").test(entry))
    .map((entry) => join(directory, entry))
    .filter((path) => {
      try {
        return lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink();
      } catch {
        return false;
      }
    })
    .sort((left, right) => lstatSync(right).mtimeMs - lstatSync(left).mtimeMs);
  for (const path of generated.slice(retention)) {
    assertPrivatePath(path, "file");
    const manifest = backupManifestPath(path);
    if (existsSync(manifest)) assertPrivatePath(manifest, "file");
    unlinkSync(path);
    if (existsSync(manifest)) unlinkSync(manifest);
  }
};

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
