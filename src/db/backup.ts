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
  isSameTarget,
  isTargetIdentity,
  targetIdentityOf,
  type TargetIdentity,
} from "./target-identity.ts";
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
  /**
   * The database this snapshot was taken from (#747), recorded by the process that had both
   * files open rather than reconstructed afterwards. Optional in the shape check because
   * manifests written before this field existed are still valid backups and must stay
   * restorable; `assertRollbackPointAt` requires it, because a rollback point for an approved
   * migration has to be an image of *that* target, not any file with a matching schema version.
   */
  source?: TargetIdentity;
}

export interface RestoreResult {
  databasePath: string;
  restoredFrom: string;
  preservedDatabasePath: string | null;
  preservedSidecars: string[];
}

export interface RestoreOptions {
  /** Test-only fault injection at the last point before the staged image is installed. */
  afterPreservingExisting?: () => void;
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

const writeManifest = (
  backupPath: string,
  version: number,
  source: TargetIdentity,
): DatabaseBackup => {
  assertPrivatePath(backupPath, "file");
  const sha256 = hashFile(backupPath);
  const manifestPath = backupManifestPath(backupPath);
  const manifest: BackupManifest = {
    format: "agent-control-plane.sqlite-backup/v1",
    databaseFile: basename(backupPath),
    databaseSha256: sha256,
    schemaVersion: version,
    createdAt: new Date().toISOString(),
    source,
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
    return writeManifest(destination, schemaVersion(raw), targetIdentityOf(sourcePath));
  } catch (error) {
    removePartialBackup(staged);
    if (published) removePartialBackup(destination);
    throw error;
  }
};

/**
 * The recovery point an approved migration is allowed to rest on (#738).
 *
 * `migrate()` makes its own `pre-migration-v<from>` snapshot, but that one is made *by the
 * process that is about to rewrite the file*, at a path it chooses, after it has already
 * decided to proceed — so if anything upstream is wrong the snapshot inherits it and nobody
 * has looked. This one is taken while nothing is migrating and validated before the chain's
 * `DROP TABLE`s run, so the approval can say which file the owner gets back.
 *
 * Synchronous, and it opens the source writable: `VACUUM INTO` is the same snapshot
 * `backupOpenDatabaseSync` takes for the constructor, and the callers here (the approval
 * command, fixtures) already hold the database exclusively.
 */
export const captureRollbackPointSync = (
  databasePath: string,
  destination = nextBackupPath(databasePath, "approved-migration"),
): DatabaseBackup => {
  const raw = new Database(databasePath, { fileMustExist: true });
  try {
    raw.pragma("busy_timeout = 10000");
    assertIntegrity(raw, databasePath);
    return backupOpenDatabaseSync(raw, databasePath, destination);
  } finally {
    raw.close();
  }
};

/**
 * Proves a named path is a usable recovery point for a database at `expectedVersion`.
 *
 * Private mode, manifest shape, checksum, integrity — the properties that make an image a
 * usable way back — plus the one an operator restore does not need to ask: that it is at the
 * version this migration starts from. A snapshot of the *migrated* database is not a way back.
 *
 * Load-bearing invariants are deliberately not asserted, for the same reason
 * `validateMigrationRollbackBackup` skips them: a rollback point is allowed to contain whatever
 * is wrong with the database it was taken from. Holding it to the current build's invariants
 * would refuse an approval for precisely the databases that most need one — measured on a v24
 * image whose ledger the current build reads as malformed, which is a fact about the old
 * database, not a reason to leave it with no recovery point.
 */
export const assertRollbackPointAt = (
  backupPath: string,
  expectedVersion: number,
  target: TargetIdentity,
): DatabaseBackup => {
  const manifest = validateBackup(backupPath, { assertSchemaInvariants: false });
  if (manifest.schemaVersion !== expectedVersion) {
    throw acpError(ReasonCode.SCHEMA_MIGRATION_NOT_APPROVED, "the approved rollback point is not at the version this migration starts from", {
      backupPath,
      expected: expectedVersion,
      found: manifest.schemaVersion,
    });
  }
  // #747 — a version and a checksum say the file is an intact database at the right schema.
  // They do not say it is an image of *this* database, and an approval whose recovery point
  // belongs to a different file is a rollback to somebody else's data. The manifest carries
  // the source identity recorded when the snapshot was taken; an older manifest carries none,
  // and a rollback point with no stated provenance is refused here rather than assumed.
  if (manifest.source === undefined) {
    throw acpError(ReasonCode.SCHEMA_MIGRATION_NOT_APPROVED, "the approved rollback point does not record which database it was taken from", {
      backupPath,
      target,
    });
  }
  if (!isSameTarget(manifest.source, target)) {
    throw acpError(ReasonCode.SCHEMA_MIGRATION_NOT_APPROVED, "the approved rollback point is an image of a different database", {
      backupPath,
      approvedTarget: target,
      backupOf: manifest.source,
    });
  }
  return {
    path: backupPath,
    manifestPath: backupManifestPath(backupPath),
    sha256: manifest.databaseSha256,
    schemaVersion: manifest.schemaVersion,
  };
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
    return writeManifest(destination, schemaVersion(raw), targetIdentityOf(databasePath));
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
      typeof parsed.createdAt !== "string" ||
      // Absent is valid — manifests predating #747 are still restorable. Present-and-malformed
      // is not: it would otherwise read as "no provenance recorded", which is a different claim.
      (parsed.source !== undefined && !isTargetIdentity(parsed.source))
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

const validateBackup = (
  backupPath: string,
  options: { assertSchemaInvariants: boolean } = { assertSchemaInvariants: true },
): BackupManifest => {
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
    if (options.assertSchemaInvariants) {
      assertLoadBearingInvariants(raw, {
        includeMigrationLedger: version >= 12,
        includeBaselineLedger: version >= 14,
        schemaVersion: version,
        // The prompt triggers arrive with v17, so a v16 image is not rejected for lacking them.
        includeTelegramOwnerPrompts: version >= 17,
      });
      if (version >= 12) assertMigrationLedgerAt(raw, version);
    }
  } finally {
    raw.close();
  }
  return manifest;
};

/**
 * A rollback snapshot is allowed to contain the defect that made its migration fail. It still has
 * to be the exact private, checksummed, integral image this process made before changing schema.
 * Operator restores keep the stronger invariant and ledger validation in validateBackup above.
 */
const validateMigrationRollbackBackup = (backup: DatabaseBackup): BackupManifest => {
  if (backup.manifestPath !== backupManifestPath(backup.path)) {
    throw acpError(ReasonCode.INTERNAL_ERROR, "migration backup manifest path changed before rollback", {
      backupPath: backup.path,
      expected: backupManifestPath(backup.path),
      actual: backup.manifestPath,
    });
  }
  const manifest = validateBackup(backup.path, { assertSchemaInvariants: false });
  if (manifest.databaseSha256 !== backup.sha256 || manifest.schemaVersion !== backup.schemaVersion) {
    throw acpError(ReasonCode.INTERNAL_ERROR, "migration backup identity changed before rollback", {
      backupPath: backup.path,
      expectedSha256: backup.sha256,
      actualSha256: manifest.databaseSha256,
      expectedSchemaVersion: backup.schemaVersion,
      actualSchemaVersion: manifest.schemaVersion,
    });
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
 * After the physical source files have been copied, fold committed WAL pages into the live main
 * file before detaching its sidecars. A process death can then reopen the live main file by itself.
 */
const checkpointExistingWal = (databasePath: string): void => {
  if (!databaseSidecarPaths(databasePath).some((sidecar) => existsSync(sidecar))) return;
  const raw = new Database(databasePath, { fileMustExist: true });
  try {
    raw.pragma("busy_timeout = 10000");
    const [checkpoint] = raw.pragma("wal_checkpoint(TRUNCATE)") as Array<{ busy: number }>;
    if (checkpoint?.busy !== 0) {
      throw acpError(ReasonCode.CONFLICT, "database still has a writer during restore", {
        databasePath,
      });
    }
  } finally {
    raw.close();
  }
};

/**
 * Restore only accepts a manifest-checked, owner-private snapshot and stages it in the
 * destination directory before replacement. The old physical database and sidecars are copied
 * under backups/ before the live WAL is checkpointed for forensic recovery. The caller must first
 * stop the daemon, which the maintenance CLI enforces.
 */
const restoreValidatedDatabase = (
  databasePath: string,
  backupPath: string,
  manifest: BackupManifest,
  options: RestoreOptions = {},
): RestoreResult => {
  if (!isAbsolute(databasePath) || !isAbsolute(backupPath)) {
    throw acpError(ReasonCode.STATE_PATH_INSECURE, "database and backup paths must be absolute", {
      databasePath,
      backupPath,
    });
  }
  ensurePrivateDirectory(dirname(databasePath));
  const hadDatabase = existsSync(databasePath);
  if (hadDatabase) assertPrivateDatabaseFiles(databasePath);
  else {
    for (const sidecar of databaseSidecarPaths(databasePath).filter((path) => existsSync(path))) {
      assertPrivatePath(sidecar, "file");
    }
  }
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

    const existingSidecars = databaseSidecarPaths(databasePath).filter((sidecar) => existsSync(sidecar));
    for (const sidecar of existingSidecars) assertPrivatePath(sidecar, "file");

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
    const copiedForensicFiles: string[] = [];
    const copyForensicFile = (from: string, to: string): void => {
      copyFileSync(from, to, fsConstants.COPYFILE_EXCL);
      copiedForensicFiles.push(to);
      chmodSync(to, PRIVATE_FILE_MODE);
      assertPrivatePath(to, "file");
    };
    const preserveExisting = (): void => {
      if (preservedDatabasePath) copyForensicFile(databasePath, preservedDatabasePath);
      for (const sidecar of existingSidecars) {
        const suffix = sidecar.slice(databasePath.length);
        const preserved = `${sidecarPreservationBase}${suffix}`;
        copyForensicFile(sidecar, preserved);
        preservedSidecars.push({ from: sidecar, to: preserved });
      }
    };

    let preservationComplete = false;
    try {
      // Restore copies the original database and sidecars before checkpointing the live database.
      preserveExisting();
      preservationComplete = true;
      if (hadDatabase) checkpointExistingWal(databasePath);

      for (const sidecar of databaseSidecarPaths(databasePath).filter((path) => existsSync(path))) {
        assertPrivatePath(sidecar, "file");
        unlinkSync(sidecar);
      }
      options.afterPreservingExisting?.();
      // rename over an existing entry is one atomic directory operation: readers see either the
      // checkpointed pre-restore inode or the already-validated restored inode, never no database.
      renameSync(temporary, databasePath);
      assertPrivateDatabaseFiles(databasePath);
    } catch (error) {
      // Before the whole physical set is copied, the live files are untouched and incomplete
      // forensic outputs are disposable. Once complete, keep that evidence across every later
      // checkpoint, sidecar-detach, callback, rename, or validation failure.
      if (!preservationComplete) {
        for (const copied of copiedForensicFiles.reverse()) {
          if (existsSync(copied)) unlinkSync(copied);
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

/** Operator restore: the snapshot must already satisfy every invariant for its recorded version. */
export const restoreDatabase = (
  databasePath: string,
  backupPath: string,
  options: RestoreOptions = {},
): RestoreResult =>
  restoreValidatedDatabase(databasePath, backupPath, validateBackup(backupPath), options);

/** Automatic rollback: restores the exact image captured immediately before this migration. */
export const restoreMigrationBackup = (
  databasePath: string,
  backup: DatabaseBackup,
  options: RestoreOptions = {},
): RestoreResult =>
  restoreValidatedDatabase(
    databasePath,
    backup.path,
    validateMigrationRollbackBackup(backup),
    options,
  );

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
