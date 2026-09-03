import Database from "better-sqlite3";
import { existsSync, fstatSync, lstatSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { acpError, fail, isAcpError, type Decision } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import { SingleInstanceLock } from "../daemon/single-instance.ts";
import {
  DEFAULT_BACKUP_RETENTION,
  assertIntegrity,
  backupDatabase,
  backupOpenDatabaseSync,
  nextBackupPath,
  pruneAutomaticBackups,
  restoreMigrationBackup,
  type DatabaseBackup,
} from "./backup.ts";
import {
  SCHEMA_VERSION as CURRENT_SCHEMA_VERSION,
  assertLoadBearingInvariants,
  assertMigrationLedgerAt,
  bootstrapChecksum,
  installMigrationLedger,
  migrationChainFrom,
  schemaDdl,
  type SchemaMigration,
} from "./migrations.ts";
import {
  assertMigrationApproved,
  migrationPlanFrom,
  readMigrationApproval,
  retireMigrationApproval,
  retireStaleMigrationApproval,
  type ApprovalRetirement,
  type MigrationApproval,
} from "./migration-approval.ts";
import {
  assertPrivateDatabaseFiles,
  ensurePrivateDirectory,
  finalizeNewPrivateDatabaseFiles,
} from "./state-preflight.ts";
import { FdVfsControl, withBoundDescriptor } from "./fd-vfs.ts";
import { isSameTarget, targetIdentityOf, type TargetIdentity } from "./target-identity.ts";

export type SqliteDatabase = Database.Database;

/** Diagnostics deliberately expose neither a SQL executor nor function registration. */
export interface DatabaseDiagnostics {
  readonly name: string;
  pragma(source: string, options?: Database.PragmaOptions): unknown;
}

const USER_VERSION_PRAGMA = /^\s*user_version(?:\s*=\s*\d+)?\s*;?\s*$/i;
const TABLE_INFO_PRAGMA = /^\s*PRAGMA\s+(?:main\.)?table_info\s*\([^)]*\)\s*;?\s*$/i;

const firstSqlVerb = (sql: string): string =>
  sql
    .replace(/^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/, "")
    .match(/^([A-Za-z]+)/)?.[1]?.toUpperCase() ?? "";

// The Db facade has no schema-administration use at runtime. Keeping only data statements
// here means a handler that receives it cannot remove the triggers that enforce authority.
const assertDataMutation = (sql: string): void => {
  if (["INSERT", "UPDATE", "DELETE", "REPLACE", "WITH"].includes(firstSqlVerb(sql))) return;
  fail(ReasonCode.INVALID_ARGUMENT, "database mutations must be data statements", {});
};

// Schema introspection keeps compatibility checks from depending on an engine-private handle;
// every other PRAGMA remains unavailable here because a setter changes connection authority.
const assertReadQuery = (sql: string): void => {
  if (["SELECT", "WITH", "EXPLAIN"].includes(firstSqlVerb(sql)) || TABLE_INFO_PRAGMA.test(sql)) return;
  fail(ReasonCode.INVALID_ARGUMENT, "database reads must be queries", {});
};

/** Version of the shape in schema.sql plus its ordered migration registry. */
export const SCHEMA_VERSION = CURRENT_SCHEMA_VERSION;

export interface DbOpenOptions {
  /** Number of generated manual/pre-migration backups retained beside the database. */
  backupRetention?: number;
  /** Keep SQLite's transient query state off environment-selected filesystem paths. */
  temporaryStorage?: "MEMORY";
  /**
   * A migration lock this caller already holds over the same directory.
   *
   * Not a boolean. `migrationLockHeld?: true` would be a claim any caller could make while holding
   * nothing; the lock itself can only be obtained by acquiring it, and `held()` is true only for
   * the instance whose descriptor is open. Supplied so a command that must take the lock *before*
   * it opens anything does not then deadlock against this class taking the same lock again — the
   * lock denies rather than waits, so the second acquisition refused with the caller's own pid.
   */
  migrationLock?: SingleInstanceLock;
  /** Test-only fault injection that proves a committed migration is restored from its backup. */
  afterMigration?: (migration: SchemaMigration) => void;
  /**
   * Test-only scheduling seam at the one point a migration race is decidable: after this open
   * has read the on-disk version and validated its approval, and before it acquires
   * exclusivity (#747).
   *
   * `SingleInstanceLock.acquire` denies rather than blocking, so the interleaving that the
   * re-read below exists for cannot be produced by starting two processes and hoping — the
   * second one has to arrive *after* the first released, still holding a version it read
   * before the first committed. This seam schedules that window; it does not simulate it. What
   * runs inside it is a real second process taking the real lock and running the real chain.
   */
  beforeMigrationExclusivity?: () => void;
  /**
   * An approval delivered in-process rather than through the state directory's approval file
   * (#738). Held to the identical checks, so this is a second way to hand over an approval and
   * not a way past one. Omitting it does not permit a migration: it means the only approval
   * this open will consider is the one on disk.
   */
  migrationApproval?: MigrationApproval;
}
const EVIDENCE_WRITE_MINT: unique symbol = Symbol("evidence-write-mint");
const TURN_MATERIALIZATION_MINT: unique symbol = Symbol("turn-materialization-mint");
const RUN_STATE_TRANSITION_MINT: unique symbol = Symbol("run-state-transition-mint");

/** Issuance follows the file rather than a connection, so a second Db cannot remint authority. */
const ISSUED_EVIDENCE_WRITE_PORTS = new Set<string>();
const ISSUED_TURN_MATERIALIZATION_AUTHORITIES = new Set<string>();
const ISSUED_RUN_STATE_TRANSITION_AUTHORITIES = new Set<string>();

/**
 * Opaque authority to enter the evidence-write marker. The token never crosses the
 * ArtifactStore boundary: a producer capability carries it in a module-private WeakMap.
 */
class EvidenceWritePortToken {
  readonly #minted = true;
  readonly #db: Db;

  constructor(mint: symbol, db: Db) {
    this.#db = db;
    if (mint !== EVIDENCE_WRITE_MINT) {
      fail(
        ReasonCode.COMPLETION_AUTHORITY_DENIED,
        "an evidence-write port cannot be constructed outside its issuer",
        {},
      );
    }
  }

  static belongsTo(value: unknown, db: Db): value is EvidenceWritePort {
    if (typeof value !== "object" || value === null || !(#minted in value)) return false;
    return value.#db === db;
  }
}

export type EvidenceWritePort = EvidenceWritePortToken;

/**
 * Opaque authority held by the turn coordinator, and issued once per database.
 *
 * Without it `materializeTurn` was a public method taking an arbitrary closure and an arbitrary
 * tuple, so anything holding a `Db` could raise the marker for whatever it wanted to write. The
 * trigger then stopped only a caller who wrote settlement columns *without* wrapping the write —
 * which is to say it stopped a mistake and not an untrusted writer. The schema comment claiming
 * it was "in the same shape as the run-state and evidence guards" was describing this class
 * before it existed.
 */
class TurnMaterializationAuthorityToken {
  readonly #minted = true;
  readonly #db: Db;

  constructor(mint: symbol, db: Db) {
    this.#db = db;
    if (mint !== TURN_MATERIALIZATION_MINT) {
      fail(
        ReasonCode.COMPLETION_AUTHORITY_DENIED,
        "a turn-materialization authority cannot be constructed outside its issuer",
        {},
      );
    }
  }

  static belongsTo(value: unknown, db: Db): value is TurnMaterializationAuthority {
    if (typeof value !== "object" || value === null || !(#minted in value)) return false;
    return value.#db === db;
  }
}

export type TurnMaterializationAuthority = TurnMaterializationAuthorityToken;

/**
 * Opaque authority held by the run engine. It turns on the connection-local marker only
 * while the one transition operation records its proof, enqueues its envelope, and updates.
 */
class RunStateTransitionAuthorityToken {
  readonly #minted = true;
  readonly #db: Db;

  constructor(mint: symbol, db: Db) {
    this.#db = db;
    if (mint !== RUN_STATE_TRANSITION_MINT) {
      fail(
        ReasonCode.RUN_STATE_TRANSITION_AUTHORITY_DENIED,
        "a run-state transition authority cannot be constructed outside its issuer",
        {},
      );
    }
  }

  static belongsTo(value: unknown, db: Db): value is RunStateTransitionAuthority {
    if (typeof value !== "object" || value === null || !(#minted in value)) return false;
    return value.#db === db;
  }
}

export type RunStateTransitionAuthority = RunStateTransitionAuthorityToken;

export interface EvidenceArtifactInsert {
  artifactId: string;
  runId: string;
  kind: string;
  digest: string;
  candidateSnapshotDigest: string | null;
  contentJson: string;
  producedBy: string;
  createdAt: string;
}

/** The first two admissions must succeed before the marker can cover the state update. */
export interface RunStateTransitionWork<T> {
  /** The only row and target state for which this operation may raise the marker. */
  runId: string;
  toState: string;
  /**
   * Records the evidence for this transition, and answers whether that worked.
   *
   * The value is `unknown` because this seam cares only about the decision. `AuditLog.record`
   * answers with the row's real identity for callers that need to cite it; a caller that only
   * needs "did it land" should not be forced to name a type it will discard.
   */
  recordTransitionEvidence(): Decision<unknown>;
  enqueueTransitionEnvelope(): Decision<unknown>;
  updateState(): T;
}

/**
 * SQLite handle plus the transaction discipline required by PRD §30.3.
 *
 * Every section listed there — binding failover, run owner takeover, gate publish
 * record, merge receipt, claim acquire/release, state transition + outbox enqueue —
 * goes through `tx()`, which uses BEGIN IMMEDIATE so two writers cannot interleave
 * a read-then-write race.
 */
export class Db {
  readonly #raw: SqliteDatabase;
  /** Limited compatibility surface for diagnostics; authority must never receive the handle. */
  readonly raw: DatabaseDiagnostics;
  #depth = 0;
  #poisoned = false;
  #evidenceWriteMarkerDepth = 0;
  #schemaMigrationMarkerDepth = 0;
  #runStateTransitionMarkers: Array<{ runId: string; toState: string }> = [];
  /**
   * The turn whose settlement columns may move, and the exact tuple they may move to.
   *
   * Bound to both, not just to the turn: a marker that authorised "any update to this row" would
   * let the materializer's own transaction be the cover for a different write. What the ledger
   * has to be able to say is that a settlement came from an observation, and the tuple is the
   * part of that claim a trigger can check.
   */
  #turnMaterializationMarkers: Array<{ turnRequestId: string }> = [];

  /**
   * The file this connection opened. Capability issuance is keyed by it: two `Db` objects
   * over the same file are the same resource, and keying by instance let a second one mint
   * a fresh set of evidence writers for rows the composition root already owned (#352).
   */
  readonly file: string;
  /** What the once-per-database capabilities are keyed by: the file itself, not a name for it. */
  readonly identity: string;
  /** The connection's observed SQLite temporary-storage policy. */
  readonly temporaryStorage: "DEFAULT" | "FILE" | "MEMORY";
  /**
   * The approval this open spent, or null when it did not migrate. Read by the composition
   * root so a migration that happened lands in the audit trail with the name of whoever
   * approved it, rather than only in the schema ledger (#738).
   */
  appliedMigrationApproval: MigrationApproval | null = null;
  /**
   * Whether the spent approval was filed away, and why not when it was not. A failed rename is
   * reported rather than thrown, so a committed migration is never reported as a failed start.
   */
  migrationApprovalRetirement: ApprovalRetirement | null = null;
  /** The repair applied to an approval that outlived its own migration, when one was found. */
  staleMigrationApprovalRetirement: ApprovalRetirement | null = null;
  /** The identity the pathname had when this connection opened it; null for `:memory:`. */
  readonly #openedTarget: TargetIdentity | null;

  constructor(filename: string, private readonly options: DbOpenOptions = {}) {
    const persistent = filename !== ":memory:";
    const databaseExisted = persistent && existsSync(filename);
    if (persistent) {
      ensurePrivateDirectory(dirname(filename));
      if (databaseExisted) assertPrivateDatabaseFiles(filename);
    }
    this.#raw = new Database(filename);
    let temporaryStorage: typeof this.temporaryStorage;
    try {
      if (this.options.temporaryStorage === "MEMORY") {
        this.#raw.pragma("temp_store = MEMORY");
      }
      const observed = Number(this.#raw.pragma("temp_store", { simple: true }));
      temporaryStorage = observed === 2 ? "MEMORY" : observed === 1 ? "FILE" : "DEFAULT";
      if (this.options.temporaryStorage === "MEMORY" && temporaryStorage !== "MEMORY") {
        fail(
          ReasonCode.INTERNAL_ERROR,
          "SQLite did not establish the requested in-memory temporary storage",
          { observed, temporaryStorage },
        );
      }
    } catch (error) {
      this.#raw.close();
      throw error;
    }
    this.temporaryStorage = temporaryStorage;
    if (persistent) finalizeNewPrivateDatabaseFiles(filename, databaseExisted);
    // `resolve()` only removes lexical path segments. It leaves a symlink alias distinct,
    // which would let two connections to one SQLite file receive separate capabilities.
    // Resolve after SQLite creates the file so the issuance key names the actual file.
    this.file = filename === ":memory:" ? `:memory:${Math.random()}` : realpathSync(filename);
    // `realpath` collapses symlinks and leaves hard links alone: two names for one inode resolve
    // to two different strings, and a capability keyed by the string then issues twice for one
    // database. Measured — an owner claimed through the real path and a second handle claimed
    // through a hard link, both live. The identity of a file is its (device, inode); the path is
    // a way to reach it, and this comment used to say realpath was enough.
    this.identity =
      filename === ":memory:"
        ? this.file
        : ((): string => {
            const stat = statSync(this.file);
            return `${stat.dev}:${stat.ino}`;
          })();
    // What the pathname resolved to at the moment this connection opened it (#747).
    //
    // `this.identity` answers "which resource is this" for capability issuance. This answers a
    // different question that only matters later: does the name still lead to the file this
    // handle holds. They are computed together and diverge only if something replaces the file
    // between them, which is itself the condition worth refusing on.
    this.#openedTarget = persistent ? targetIdentityOf(this.file) : null;
    this.#raw.pragma("foreign_keys = ON");
    this.#raw.pragma("busy_timeout = 10000");
    // SQLite performs REPLACE's implicit delete *without* firing DELETE triggers unless this is
    // on. Every no-delete guard in this schema — the audit trail, the artifacts, the receipts,
    // the canonical turn ledger — was therefore bypassable by writing REPLACE instead of UPDATE,
    // and `INSERT OR REPLACE` passed the statement check because its first verb is INSERT.
    // Measured on a review head: a settled COMPLETED turn was replaced with an ABORTED one, its
    // completed observation replaced, its source kept, and the retry then admitted.
    this.#raw.pragma("recursive_triggers = ON");
    if (filename !== ":memory:") {
      this.#raw.pragma("journal_mode = WAL");
      this.#raw.pragma("synchronous = FULL");
      finalizeNewPrivateDatabaseFiles(filename, databaseExisted);
    }
    // These functions are connection-local markers, not caller-supplied values. A raw SQL
    // caller can invoke them but cannot make either return true outside the owning operation.
    this.#raw.function("acp_evidence_write_authorized", () =>
      this.#evidenceWriteMarkerDepth > 0 ? 1 : 0,
    );
    this.#raw.function("acp_run_state_transition_authorized", (runId: unknown, toState: unknown) => {
      const marker = this.#runStateTransitionMarkers[this.#runStateTransitionMarkers.length - 1];
      return marker && marker.runId === runId && marker.toState === toState ? 1 : 0;
    });
    this.#raw.function("acp_turn_materialization_authorized", (turnRequestId: unknown) => {
      const marker = this.#turnMaterializationMarkers[this.#turnMaterializationMarkers.length - 1];
      return marker && marker.turnRequestId === turnRequestId ? 1 : 0;
    });
    this.#raw.function("acp_schema_migration_authorized", () =>
      this.#schemaMigrationMarkerDepth > 0 ? 1 : 0,
    );
    this.raw = Object.freeze({
      name: this.#raw.name,
      pragma: (source: string, options?: Database.PragmaOptions): unknown => {
        if (!USER_VERSION_PRAGMA.test(source)) {
          fail(ReasonCode.INVALID_ARGUMENT, "only the schema-version pragma is available for diagnostics", {});
        }
        return this.#raw.pragma(source, options);
      },
    });
    if (persistent) assertIntegrity(this.#raw, this.file);
    this.applySchema(filename);
  }

  /**
   * Applies a fresh schema or an explicit ordered migration chain. A current-version
   * database is inspected, never repaired in place: missing triggers are corruption, not
   * an invitation to silently trust the file after CREATE IF NOT EXISTS happens to pass.
   */
  private applySchema(filename: string): void {
    const version = Number(this.#raw.pragma("user_version", { simple: true }));
    const alreadyPopulated =
      this.#raw
        .prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'runs'`)
        .get() as { n: number };

    if (version > SCHEMA_VERSION) {
      throw acpError(
        ReasonCode.INTERNAL_ERROR,
        "database schema is newer than this build",
        { expected: SCHEMA_VERSION, found: version },
      );
    }
    if (version === 0 && alreadyPopulated.n > 0) {
      throw acpError(
        ReasonCode.INTERNAL_ERROR,
        "database predates schema versioning; its constraints cannot be verified",
        { expected: SCHEMA_VERSION, found: version, action: "recreate or migrate the database" },
      );
    }
    if (version === 0) {
      this.bootstrapFreshSchema();
      return;
    }
    if (version === SCHEMA_VERSION) {
      assertLoadBearingInvariants(this.#raw, {
        includeMigrationLedger: true,
        includeBaselineLedger: true,
        includeTelegramOwnerPrompts: true,
      });
      assertMigrationLedgerAt(this.#raw, version);
      // #747, the repair half of the retirement contract. This branch is also the proof that a
      // spent approval is inert: it returns without ever consulting one, so an approval left on
      // disk by a failed rename authorises nothing. Filing it away here is what keeps the state
      // directory from showing a permission that is no longer one.
      if (filename !== ":memory:") {
        this.staleMigrationApprovalRetirement = retireStaleMigrationApproval(this.file);
      }
      return;
    }
    // #738 — the enforcement site, and the reason it is *here* rather than in the daemon's
    // startup sequence: `ControlPlane`'s constructor opens the database, so by the time
    // `Daemon.start()` runs the migration has already happened. A gate in the startup sequence
    // would name the hazard at a point the mutation never traverses. This line is the last
    // point that can still refuse, and it is upstream of every caller — daemon, CLI, script —
    // because they all arrive through this constructor.
    //
    // A fresh database (version 0) and a database already at this build's version both
    // returned above, so nothing that does not migrate reaches this.
    const approval = assertMigrationApproved(
      this.file,
      targetIdentityOf(this.file),
      migrationPlanFrom(version),
      this.options.migrationApproval ?? null,
    );
    // #747 — the exclusivity a migration needs, acquired by the migration.
    //
    // The gate lives here because `ControlPlane`'s constructor opens the database before
    // `Daemon.start()` runs; that is also why the daemon's single-instance lock is acquired
    // *after* the point where the schema would already have changed. A second process could
    // therefore rewrite the schema under a daemon that was holding the database, and only learn
    // about the contention afterwards. The approval CLI's liveness pre-check does not close
    // that ordering: it is a snapshot taken minutes earlier.
    //
    // So the migration takes the same lock the daemon takes, for exactly as long as it is
    // migrating, and releases it before returning. `Daemon.start()` then acquires it normally.
    // This is not a daemon-specific rule bolted onto a shared constructor — a schema migration
    // is an exclusive operation whoever performs it, so the CLI and the verification scripts
    // that reach this same line take it too, on their own state directory, where it is
    // uncontended. An open that does not migrate never touches the lock.
    this.options.beforeMigrationExclusivity?.();
    this.withMigrationExclusivity(() => {
      // #747 — re-resolve the *pathname* under the lock, from the filesystem, not from the
      // open handle.
      //
      // The version re-read below asks the *handle*, and a handle survives its own name. Replace
      // the file at this path with another database at the same version and `this.#raw` still
      // refers to the unlinked original, so the version reads 11 and that check passes — the
      // guard meant to close the window is exactly what makes this instance invisible.
      //
      // Measured on the head before this line existed, with a v11 replacement swapped in at the
      // pathname: the file *at the pathname* — the replacement, which no approval ever named —
      // came out at version 34 carrying its own rows, the approved inode stayed at 11, and the
      // approval was consumed. So it is not merely split brain. The approval was spent, no
      // approved database was migrated, and a database nobody approved was. WAL and shared-memory
      // sidecars are named by path rather than by the open file, which is the plausible route,
      // but the end state is the finding and does not depend on that explanation.
      //
      // One condition, two questions, because either alone leaves a hole the other covers and a
      // check nothing can falsify is not a check:
      //
      //   - Is the file at this path still the one the approval names? The approval is a
      //     capability over one target and it was matched outside the lock, where the answer
      //     could still change.
      //   - Does the name still lead to the file this connection opened? If not, the handle is a
      //     handle to an orphan. The caller asked to open a *path*; migrating an inode the path
      //     no longer names is not what it asked for, however valid the approval was a moment
      //     ago. **The handle is suspect the instant the pathname moves off it**, and that is
      //     why this refuses rather than trusting the approval it already matched.
      //
      // The second is not implied by the first: a swap away and back between the approval check
      // and this line leaves the path equal to what was approved while the handle holds neither.
      //
      // Refusing costs nothing that has to be recovered: no DDL has run, and the retirement
      // below is not reached, so the approval stays exactly as spendable as it was.
      const underLock = targetIdentityOf(this.file);
      if (
        !isSameTarget(underLock, approval.target) ||
        (this.#openedTarget !== null && !isSameTarget(underLock, this.#openedTarget))
      ) {
        throw acpError(
          ReasonCode.CONFLICT,
          "the database at this path is no longer the one this migration was set up for",
          {
            file: this.file,
            current: underLock,
            approved: approval.target,
            opened: this.#openedTarget,
          },
        );
      }
      // Re-read under the lock. Everything above was decided without exclusivity, so a
      // concurrent migration could have completed in between; a check whose result is used
      // after the lock it was taken without is the defect this whole block is about.
      const current = Number(this.#raw.pragma("user_version", { simple: true }));
      if (current !== version) {
        throw acpError(
          ReasonCode.CONFLICT,
          "the database schema changed while this process was acquiring migration exclusivity",
          { expected: version, found: current, file: this.file },
        );
      }
      this.migrate(filename, version);
    });
    this.appliedMigrationApproval = approval;
    this.migrationApprovalRetirement = retireMigrationApproval(
      this.file,
      approval.fromVersion,
      approval.toVersion,
    );
  }

  /**
   * Runs `work` while holding the deployment's single-instance lock.
   *
   * The lock is the daemon's, deliberately: exclusivity that only excluded other migrations
   * would still let a migration run under a live daemon holding the database. Contention is
   * reported as `DAEMON_ALREADY_RUNNING` — an ordinary unsuccessful start that the supervisor
   * is right to retry, because the holder may exit — and never as a migration refusal, which
   * exits 0 and stays down.
   */
  private withMigrationExclusivity(work: () => void): void {
    const supplied = this.options.migrationLock;
    if (supplied?.held()) {
      // The caller's lease already covers this directory, and a second lock object for the same
      // path in the same process would deny — and releasing it would end the caller's exclusivity
      // early. So the work runs under the lease that exists rather than under a new one.
      work();
      return;
    }
    const lock = new SingleInstanceLock(join(dirname(this.file), "agentcpd.lock"));
    const acquired = lock.acquire(new Date().toISOString());
    if (!acquired.allowed) {
      throw acpError(
        acquired.reasonCode,
        "refusing to migrate the schema while another process holds the state lock",
        { file: this.file, ...acquired.evidence },
      );
    }
    try {
      work();
    } finally {
      lock.release();
    }
  }

  private bootstrapFreshSchema(): void {
    this.#raw.exec("BEGIN IMMEDIATE");
    try {
      this.#raw.exec(schemaDdl());
      installMigrationLedger(this.#raw);
      assertLoadBearingInvariants(this.#raw, {
        includeMigrationLedger: true,
        includeBaselineLedger: true,
        includeTelegramOwnerPrompts: true,
      });
      this.recordMigrationReceipt({
        version: SCHEMA_VERSION,
        migrationId: `bootstrap-v${SCHEMA_VERSION}`,
        checksum: bootstrapChecksum(),
        backup: null,
      });
      this.#raw.pragma(`user_version = ${SCHEMA_VERSION}`);
      this.#raw.exec("COMMIT");
    } catch (error) {
      try {
        this.#raw.exec("ROLLBACK");
      } catch {
        /* a failed schema transaction may already be rolled back by SQLite */
      }
      throw error;
    }
    assertLoadBearingInvariants(this.#raw, {
      includeMigrationLedger: true,
      includeBaselineLedger: true,
      includeTelegramOwnerPrompts: true,
    });
    assertMigrationLedgerAt(this.#raw, SCHEMA_VERSION);
  }

  private migrate(filename: string, fromVersion: number): void {
    const migrations = migrationChainFrom(fromVersion);
    const backup = backupOpenDatabaseSync(
      this.#raw,
      this.file,
      nextBackupPath(this.file, `pre-migration-v${fromVersion}`),
    );
    try {
      for (const migration of migrations) {
        this.applyMigration(migration, migration.fromVersion === fromVersion ? backup : null);
        this.options.afterMigration?.(migration);
      }
      assertLoadBearingInvariants(this.#raw, {
        includeMigrationLedger: true,
        includeBaselineLedger: true,
        includeTelegramOwnerPrompts: true,
      });
      assertMigrationLedgerAt(this.#raw, SCHEMA_VERSION);
      pruneAutomaticBackups(this.file, this.options.backupRetention ?? DEFAULT_BACKUP_RETENTION);
    } catch (error) {
      const migrationError = error instanceof Error ? error.message : String(error);
      if (this.#raw.open) this.#raw.close();
      try {
        restoreMigrationBackup(filename, backup);
      } catch (restoreError) {
        throw acpError(
          ReasonCode.INTERNAL_ERROR,
          "migration failed and the automatic backup could not be restored",
          {
            fromVersion,
            backupPath: backup.path,
            migrationError,
            restoreError: restoreError instanceof Error ? restoreError.message : String(restoreError),
          },
        );
      }
      throw acpError(
        ReasonCode.INTERNAL_ERROR,
        "migration failed; the original database was restored from its automatic backup",
        { fromVersion, backupPath: backup.path, migrationError },
      );
    }
  }

  private applyMigration(migration: SchemaMigration, backup: DatabaseBackup | null): void {
    const foreignKeysOff = migration.foreignKeysOffDuringApply === true;
    if (foreignKeysOff) this.#raw.pragma("foreign_keys = OFF");
    try {
      this.#raw.exec("BEGIN IMMEDIATE");
      migration.apply(this.#raw);
      assertLoadBearingInvariants(this.#raw, {
        includeMigrationLedger: true,
        includeBaselineLedger: migration.toVersion >= 14,
        schemaVersion: migration.toVersion,
        includeTelegramOwnerPrompts: migration.toVersion >= 17,
      });
      this.recordMigrationReceipt({
        version: migration.toVersion,
        migrationId: migration.id,
        checksum: migration.checksum(),
        backup,
      });
      // user_version and the receipt commit together. An interrupted migration is therefore
      // either wholly absent or wholly visible; there is no version that claims a step the
      // ledger did not record.
      this.#raw.pragma(`user_version = ${migration.toVersion}`);
      this.#raw.exec("COMMIT");
      if (foreignKeysOff) {
        this.#raw.pragma("foreign_keys = ON");
        const violations = this.#raw.prepare("PRAGMA foreign_key_check").all();
        if (violations.length > 0) {
          throw new Error(`migration left ${violations.length} foreign-key violation(s)`);
        }
      }
    } catch (error) {
      try {
        this.#raw.exec("ROLLBACK");
      } catch {
        /* a failed migration transaction may already be rolled back by SQLite */
      }
      if (foreignKeysOff) this.#raw.pragma("foreign_keys = ON");
      throw error;
    }
  }

  private recordMigrationReceipt(input: {
    version: number;
    migrationId: string;
    checksum: string;
    backup: DatabaseBackup | null;
  }): void {
    this.#schemaMigrationMarkerDepth += 1;
    try {
      this.#raw
        .prepare(
          `INSERT INTO schema_migrations
             (version, migration_id, checksum, backup_file, backup_checksum, applied_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.version,
          input.migrationId,
          input.checksum,
          input.backup?.path ?? null,
          input.backup?.sha256 ?? null,
          new Date().toISOString(),
        );
    } finally {
      this.#schemaMigrationMarkerDepth -= 1;
    }
  }

  /**
   * Runs `fn` inside a single write transaction. Nested calls join the outer
   * transaction rather than opening a second one — SQLite has no real nesting and a
   * silent second BEGIN would commit the outer work early.
   */
  tx<T>(fn: () => T): T {
    this.assertUsable();
    if (this.#depth > 0) return this.guardSync(fn());
    this.#raw.exec("BEGIN IMMEDIATE");
    this.#depth += 1;
    try {
      const out = this.guardSync(fn());
      this.#raw.exec("COMMIT");
      return out;
    } catch (err) {
      try {
        this.#raw.exec("ROLLBACK");
      } catch {
        /* rollback of an already-aborted tx is not itself an error */
      }
      if (isAsyncTransactionError(err)) this.poison();
      throw translate(err);
    } finally {
      this.#depth -= 1;
    }
  }

  /**
   * `tx()` treats a denied `Decision` as an ordinary return value and commits it — a
   * body that writes and then decides against itself leaves the write behind (#664).
   * `txDecision` closes that gap for bodies whose *entire* return value is the decision
   * being made: a denial rolls back exactly as a throw would, but is still handed back
   * to the caller as data rather than surfacing as an exception.
   *
   * This is deliberately a separate, opt-in primitive rather than a change to `tx()`
   * itself. Some transaction bodies write unconditional housekeeping that a later
   * decision only *reads* — `github-kernel.ts`'s claim-expiry sweep is why the guard and
   * a partial unique index agree inside one transaction, and it must survive regardless
   * of what gets decided afterward. Rolling back on every denial would undo that
   * housekeeping too, so callers opt in per call site instead of inheriting a blanket
   * behaviour change.
   *
   * Nesting joins the outer transaction exactly as `tx()` already does — there is no
   * SAVEPOINT here, so a nested call has no physical boundary of its own to roll back
   * to. A nested `txDecision` therefore hands its `Decision` straight back to its caller
   * without throwing: the caller (and everything above it, up to whichever frame owns
   * the real transaction) decides what a denial there means, the same as it would for
   * any other return value. Only the outermost `txDecision` can turn a denial into an
   * actual ROLLBACK, so a body that must roll back on a nested denial has to be
   * `txDecision` itself, all the way up — see `CtoLifecycle.acknowledgeHandoff`, whose
   * own write must not survive `BindingRegistry.switchTo` denying underneath it.
   */
  txDecision<T>(fn: () => Decision<T>): Decision<T> {
    if (this.#depth > 0) return this.guardSync(fn());
    try {
      return this.tx(() => {
        // `guardSync` here, before `.allowed` is ever read, is load-bearing: an async
        // body returns a pending Promise, which has no `.allowed` and so reads as
        // `undefined` — indistinguishable from a denial unless the thenable is caught
        // first. Checking `.allowed` first would wrap that Promise in the rollback
        // signal below, hand it back through the catch as if it were a real `Decision`,
        // and let the still-running callback's writes after its first `await` land as
        // autocommit outside any transaction, on a handle `tx()`'s own guard would have
        // poisoned. This mirrors `tx()`'s own `guardSync(fn())` exactly, so an async
        // body throws and poisons here the same way it does there.
        const result = this.guardSync(fn());
        if (!result.allowed) throw txDenialSignal(result);
        return result;
      });
    } catch (err) {
      if (isTxDenialSignal(err)) return err.decision as Decision<T>;
      throw err;
    }
  }

  /**
   * A transaction body must be synchronous. An async callback would return a pending
   * promise, COMMIT would run before the work finished, and writes after the first await
   * would land outside the transaction with no way to roll them back — silently voiding
   * every §30.3 atomicity guarantee.
   */
  private guardSync<T>(out: T): T {
    if (out && typeof (out as { then?: unknown }).then === "function") {
      // The callback cannot be cancelled. Consume its rejection and poison the handle after
      // the owner rolls back, so code after its first await cannot escape into autocommit.
      void Promise.resolve(out).catch(() => undefined);
      throw asyncTransactionError();
    }
    return out;
  }

  get inTransaction(): boolean {
    return this.#depth > 0;
  }

  /** Claimed by ArtifactStore while the composition root is still being constructed. */
  /** What *this* handle issued, so closing it releases its own slots and nobody else's. */
  readonly #issuedHere = new Set<"evidence" | "materialization" | "runState">();

  /**
   * Releases registered by capability issuers that live in other modules.
   *
   * `ArtifactStore` and `RunEngine` each keep their own once-per-database set, and this class
   * cannot import them without a cycle. Without a hook their slots outlived the handle: a control
   * plane that threw while constructing took the evidence-writer slot with it, and every corrected
   * retry in that process was refused. Measured.
   */
  readonly #releases = new Set<() => void>();

  /** Called by an issuer that keeps its own registry, so `close()` hands that slot back as well. */
  releaseOnClose(release: () => void): void {
    this.#releases.add(release);
  }

  claimEvidenceWritePort(): EvidenceWritePort {
    if (ISSUED_EVIDENCE_WRITE_PORTS.has(this.identity)) {
      fail(
        ReasonCode.COMPLETION_AUTHORITY_DENIED,
        "evidence-write authority was already issued for this database",
        {},
      );
    }
    ISSUED_EVIDENCE_WRITE_PORTS.add(this.identity);
    this.#issuedHere.add("evidence");
    return new EvidenceWritePortToken(EVIDENCE_WRITE_MINT, this);
  }

  /**
   * Claimed by the turn coordinator at construction; raw callers never receive this capability.
   *
   * Issued once per database file, for the same reason the evidence port is: a second holder is a
   * second materializer, and "the outcome is computed from the observations" stops being a
   * property of the ledger the moment two things can decide it.
   */
  claimTurnMaterializationAuthority(): TurnMaterializationAuthority {
    if (ISSUED_TURN_MATERIALIZATION_AUTHORITIES.has(this.identity)) {
      fail(
        ReasonCode.COMPLETION_AUTHORITY_DENIED,
        "turn-materialization authority was already issued for this database",
        {},
      );
    }
    ISSUED_TURN_MATERIALIZATION_AUTHORITIES.add(this.identity);
    this.#issuedHere.add("materialization");
    return new TurnMaterializationAuthorityToken(TURN_MATERIALIZATION_MINT, this);
  }

  /** Claimed by RunEngine at construction; raw callers never receive this capability. */
  claimRunStateTransitionAuthority(): RunStateTransitionAuthority {
    if (ISSUED_RUN_STATE_TRANSITION_AUTHORITIES.has(this.identity)) {
      fail(
        ReasonCode.RUN_STATE_TRANSITION_AUTHORITY_DENIED,
        "run-state transition authority was already issued for this database",
        {},
      );
    }
    ISSUED_RUN_STATE_TRANSITION_AUTHORITIES.add(this.identity);
    this.#issuedHere.add("runState");
    return new RunStateTransitionAuthorityToken(RUN_STATE_TRANSITION_MINT, this);
  }

  /**
   * The sole transaction-shaped opening for a state update. Evidence and the outbox envelope
   * are written before the marker permits `UPDATE runs SET state`, so any failure rolls all
   * three facts back together rather than leaving a naked state edge behind.
   */
  /**
   * Runs a turn materialization with the marker its trigger requires.
   *
   * The marker is connection-local and lives only for this call, so a raw SQL caller can invoke
   * `acp_turn_materialization_authorized` and cannot make it answer true. That is the same shape
   * the run-state and evidence guards already use, and the reason the trigger is a property of
   * the database rather than a rule the coordinator remembers.
   *
   * It names the turn and not the columns. Unlike `applyRunStateTransition`, whose marker carries
   * the target state and so can refuse a transition it did not authorise, one materialization
   * spans three tables and has no tuple they share. The guarantee is therefore that a
   * materialization of one turn cannot authorise a write to another — not that the values written
   * to this one were the right ones.
   */
  materializeTurn<T>(
    authority: TurnMaterializationAuthority,
    into: { turnRequestId: string },
    write: () => T,
  ): T {
    if (!TurnMaterializationAuthorityToken.belongsTo(authority, this)) {
      fail(
        ReasonCode.COMPLETION_AUTHORITY_DENIED,
        "settling a turn requires the authority held by the turn coordinator",
        {},
      );
    }
    this.#turnMaterializationMarkers.push(into);
    try {
      return write();
    } finally {
      this.#turnMaterializationMarkers.pop();
    }
  }

  applyRunStateTransition<T>(
    authority: RunStateTransitionAuthority,
    work: RunStateTransitionWork<T>,
  ): T {
    if (!RunStateTransitionAuthorityToken.belongsTo(authority, this)) {
      fail(
        ReasonCode.RUN_STATE_TRANSITION_AUTHORITY_DENIED,
        "run-state updates require the authority held by the run engine",
        {},
      );
    }
    return this.tx(() => {
      const evidence = this.guardSync(work.recordTransitionEvidence());
      if (!evidence.allowed) fail(evidence.reasonCode, evidence.message, evidence.evidence);
      const envelope = this.guardSync(work.enqueueTransitionEnvelope());
      if (!envelope.allowed) fail(envelope.reasonCode, envelope.message, envelope.evidence);
      this.#runStateTransitionMarkers.push({ runId: work.runId, toState: work.toState });
      try {
        return this.guardSync(work.updateState());
      } finally {
        this.#runStateTransitionMarkers.pop();
      }
    });
  }

  /**
   * Evidence rows may be inserted only while the opaque producer port holds the marker.
   * `produced_by` remains an auditable label; it is not the thing that authorizes the write.
   */
  insertEvidenceArtifact(
    authority: EvidenceWritePort,
    artifact: EvidenceArtifactInsert,
  ): Database.RunResult {
    if (!EvidenceWritePortToken.belongsTo(authority, this)) {
      fail(
        ReasonCode.COMPLETION_AUTHORITY_DENIED,
        "evidence rows require the writer capability issued to their producer",
        { runId: artifact.runId, kind: artifact.kind },
      );
    }
    this.#evidenceWriteMarkerDepth += 1;
    try {
      return this.run(
        `INSERT INTO run_artifacts (artifact_id, run_id, kind, digest, candidate_snapshot_digest,
                                    content_json, produced_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          artifact.artifactId,
          artifact.runId,
          artifact.kind,
          artifact.digest,
          artifact.candidateSnapshotDigest,
          artifact.contentJson,
          artifact.producedBy,
          artifact.createdAt,
        ],
      );
    } finally {
      this.#evidenceWriteMarkerDepth -= 1;
    }
  }

  all<T>(sql: string, params: unknown[] = []): T[] {
    this.assertUsable();
    assertReadQuery(sql);
    return this.#raw.prepare(sql).all(...(params as never[])) as T[];
  }

  get<T>(sql: string, params: unknown[] = []): T | undefined {
    this.assertUsable();
    assertReadQuery(sql);
    return this.#raw.prepare(sql).get(...(params as never[])) as T | undefined;
  }

  run(sql: string, params: unknown[] = []): Database.RunResult {
    this.assertUsable();
    assertDataMutation(sql);
    try {
      return this.#raw.prepare(sql).run(...(params as never[]));
    } catch (err) {
      throw translate(err);
    }
  }

  /**
   * Creates a manifest-checked, owner-private SQLite snapshot. This is safe while another
   * daemon connection is active, but not from inside this connection's uncommitted write
   * transaction because that would intentionally omit the caller's pending authority facts.
   */
  async backup(destination?: string): Promise<DatabaseBackup> {
    this.assertUsable();
    if (this.file.startsWith(":memory:")) {
      throw acpError(ReasonCode.INVALID_ARGUMENT, "an in-memory database has no restorable backup path", {});
    }
    if (this.#depth > 0) {
      throw acpError(ReasonCode.CONFLICT, "backup cannot run inside an open database transaction", {});
    }
    const backup = destination === undefined
      ? await backupDatabase(this.file)
      : await backupDatabase(this.file, destination);
    // A caller-supplied destination is an operator-named snapshot and is not retention
    // collateral. Generated manual snapshots share the configured bounded retention set.
    if (destination === undefined) {
      pruneAutomaticBackups(this.file, this.options.backupRetention ?? DEFAULT_BACKUP_RETENTION);
    }
    return backup;
  }

  close(): void {
    if (this.#raw.open) this.#raw.close();
    this.releaseIssuedCapabilities();
  }

  /**
   * Hands the once-per-file capability slots back when the connection they belong to is gone.
   *
   * Without this the issuance is a process-lifetime lockout rather than an exclusion: measured on
   * 2026-08-22, opening a database, closing it and opening it again refused the second claim with
   * COMPLETION_AUTHORITY_DENIED, so any path that reopens the same file in one process — a
   * fail-closed rebuild, a doctor repair, a control plane restarted in place — could not construct
   * its coordinator at all.
   *
   * It releases only what *this* handle issued. The first version released by file, so any second
   * connection on the same path — one that had claimed nothing — freed the owner's slot merely by
   * closing, and the next claimant became a second materializer while the owner's brand-checked
   * token went on working. Measured, on the head this paragraph was written for: a bystander's
   * close handed the authority away. Brand-checking the token was never the part at risk; the
   * bookkeeping was.
   */
  private releaseIssuedCapabilities(): void {
    if (this.#issuedHere.has("evidence")) ISSUED_EVIDENCE_WRITE_PORTS.delete(this.identity);
    if (this.#issuedHere.has("materialization")) {
      ISSUED_TURN_MATERIALIZATION_AUTHORITIES.delete(this.identity);
    }
    if (this.#issuedHere.has("runState")) ISSUED_RUN_STATE_TRANSITION_AUTHORITIES.delete(this.identity);
    this.#issuedHere.clear();
    for (const release of this.#releases) release();
    this.#releases.clear();
  }

  private assertUsable(): void {
    if (!this.#poisoned) return;
    throw acpError(
      ReasonCode.INTERNAL_ERROR,
      "database handle was poisoned by an asynchronous transaction callback",
      {},
    );
  }

  private poison(): void {
    this.#poisoned = true;
    if (this.#raw.open) this.#raw.close();
    this.releaseIssuedCapabilities();
  }
}

const ASYNC_TRANSACTION = Symbol("async-transaction");

type AsyncTransactionError = Error & { [ASYNC_TRANSACTION]: true };

const asyncTransactionError = (): AsyncTransactionError =>
  Object.assign(
    acpError(
      ReasonCode.INTERNAL_ERROR,
      "transaction callback returned a promise; transaction bodies must be synchronous",
      {},
    ),
    { [ASYNC_TRANSACTION]: true as const },
  );

const isAsyncTransactionError = (err: unknown): err is AsyncTransactionError =>
  Boolean(
    err &&
      typeof err === "object" &&
      ASYNC_TRANSACTION in err &&
      (err as { [ASYNC_TRANSACTION]?: unknown })[ASYNC_TRANSACTION] === true,
  );

const TX_DENIAL = Symbol("tx-denial");

type TxDenialSignal = Error & { [TX_DENIAL]: true; decision: Decision<unknown> };

/** Thrown by `txDecision` to force `tx()` down its ROLLBACK path, then caught right back. */
const txDenialSignal = (decision: Decision<unknown>): TxDenialSignal =>
  Object.assign(new Error("transaction body denied; rolling back"), {
    [TX_DENIAL]: true as const,
    decision,
  });

const isTxDenialSignal = (err: unknown): err is TxDenialSignal =>
  Boolean(err && typeof err === "object" && TX_DENIAL in err);

/**
 * Turn the DB-level guard rails into the same reason codes the service layer uses,
 * so a constraint violation is never reported as an opaque SQLITE_CONSTRAINT.
 */
const TRIGGER_CODES: Record<string, ReasonCode> = {
  SESSION_INCARNATION_IMMUTABLE: ReasonCode.SESSION_INCARNATION_IMMUTABLE,
  SESSION_BUZZ_ACTOR_IMMUTABLE: ReasonCode.SESSION_BUZZ_ACTOR_IMMUTABLE,
  OUTBOX_REQUEST_FINGERPRINT_IMMUTABLE: ReasonCode.OUTBOX_PAYLOAD_DIGEST_MISMATCH,
  BINDING_GENERATION_NOT_MONOTONIC: ReasonCode.BINDING_GENERATION_STALE,
  BINDING_IDENTITY_IMMUTABLE: ReasonCode.BINDING_GENERATION_STALE,
  BINDING_REVOKED_TERMINAL: ReasonCode.BINDING_REVOKED,
  ACTOR_REGISTRATION_GENERATION_NOT_MONOTONIC: ReasonCode.CONFLICT,
  ACTOR_REGISTRATION_RETIREMENT_TERMINAL: ReasonCode.CONFLICT,
  TASK_EXECUTION_WORKER_BINDING_REQUIRED: ReasonCode.WORKER_BINDING_REQUIRED,
  TASK_EXECUTION_WORKER_IDENTITY_IMMUTABLE: ReasonCode.CONFLICT,
  TASK_INSERT_RUN_SEALED: ReasonCode.RUN_TRANSITION_ILLEGAL,
  PINNED_MANIFEST_IMMUTABLE: ReasonCode.CANDIDATE_CANNOT_WEAKEN_CONTRACT,
  PINNED_RUN_SCOPED_COMMANDS_IMMUTABLE: ReasonCode.CANDIDATE_CANNOT_WEAKEN_CONTRACT,
  RUN_STATE_TRANSITION_ILLEGAL: ReasonCode.RUN_TRANSITION_ILLEGAL,
  RUN_STATE_TRANSITION_AUTHORITY_DENIED: ReasonCode.RUN_STATE_TRANSITION_AUTHORITY_DENIED,
  EVIDENCE_CANDIDATE_MISMATCH: ReasonCode.SNAPSHOT_DIGEST_MISMATCH,
  EVIDENCE_WRITE_AUTHORITY_DENIED: ReasonCode.COMPLETION_AUTHORITY_DENIED,
  ARTIFACT_IMMUTABLE: ReasonCode.CONFLICT,
  GITHUB_RECEIPT_IMMUTABLE: ReasonCode.CONFLICT,
  GITHUB_RECEIPT_PROTOCOL_VIOLATION: ReasonCode.GITHUB_RECEIPT_PROTOCOL_VIOLATION,
  MANIFEST_IMMUTABLE: ReasonCode.CONFLICT,
  AUDIT_APPEND_ONLY: ReasonCode.CONFLICT,
  SCHEMA_MIGRATION_AUTHORITY_DENIED: ReasonCode.COMPLETION_AUTHORITY_DENIED,
  SCHEMA_MIGRATION_RECEIPT_IMMUTABLE: ReasonCode.CONFLICT,
  BASELINE_RECORD_IMMUTABLE: ReasonCode.CONFLICT,
  // #631 — the admitted payload is write-once on both verbs. A caller that trips either of
  // these is trying to rewrite the sender's own words, which is a conflict with a row that
  // already holds them, not an internal fault.
  INBOUND_PAYLOAD_IMMUTABLE: ReasonCode.CONFLICT,
  INBOUND_MESSAGE_NO_REPLACE: ReasonCode.CONFLICT,
  INBOUND_TURN_CLAIM_IDENTITY_IMMUTABLE: ReasonCode.CONFLICT,
  // The canonical-turn ledger, which had no entries here at all: every one of its denials came
  // out of `db.tx` as a raw Error rather than as a typed refusal, so a claim whose source insert
  // tripped a guard threw instead of denying. The guards are what this ledger is *for*, and the
  // callers were the one part not told which one spoke.
  CANONICAL_TURN_IDENTITY_IMMUTABLE: ReasonCode.CONFLICT,
  CANONICAL_TURN_NOT_BORN_IN_DOUBT: ReasonCode.CONFLICT,
  CANONICAL_TURN_LIFECYCLE_NOT_MONOTONE: ReasonCode.CONFLICT,
  CANONICAL_TURN_OUTCOME_WEAKENED: ReasonCode.CONFLICT,
  CANONICAL_TURN_CONSISTENCY_NOT_MONOTONE: ReasonCode.CONFLICT,
  CANONICAL_TURN_SETTLEMENT_PROVENANCE_IMMUTABLE: ReasonCode.CONFLICT,
  CANONICAL_TURN_NO_DELETE: ReasonCode.CONFLICT,
  CANONICAL_TURN_NO_REPLACE: ReasonCode.CONFLICT,
  CANONICAL_TURN_MATERIALIZATION_AUTHORITY_DENIED: ReasonCode.COMPLETION_AUTHORITY_DENIED,
  CANONICAL_TURN_OBSERVATION_AUTHORITY_DENIED: ReasonCode.COMPLETION_AUTHORITY_DENIED,
  CANONICAL_TURN_DISPATCH_AUTHORITY_DENIED: ReasonCode.COMPLETION_AUTHORITY_DENIED,
  CANONICAL_TURN_DISPATCH_IMMUTABLE: ReasonCode.CONFLICT,
  CANONICAL_TURN_DISPATCH_NO_REPLACE: ReasonCode.CONFLICT,
  CANONICAL_TURN_OBSERVATION_APPEND_ONLY: ReasonCode.CONFLICT,
  CANONICAL_TURN_OBSERVATION_NO_REPLACE: ReasonCode.CONFLICT,
  CANONICAL_TURN_SOURCE_IMMUTABLE: ReasonCode.CONFLICT,
  CANONICAL_TURN_SOURCE_NO_REPLACE: ReasonCode.CONFLICT,
  CANONICAL_TURN_SOURCE_NOT_CLAIM_TIME: ReasonCode.CONFLICT,
  CANONICAL_TURN_ADJUDICATION_AUTHORITY_DENIED: ReasonCode.COMPLETION_AUTHORITY_DENIED,
  CANONICAL_TURN_ADJUDICATION_APPEND_ONLY: ReasonCode.CONFLICT,
  CANONICAL_TURN_ADJUDICATION_CITATION_AUTHORITY_DENIED: ReasonCode.COMPLETION_AUTHORITY_DENIED,
  CANONICAL_TURN_ADJUDICATION_CITATION_APPEND_ONLY: ReasonCode.CONFLICT,
  CANONICAL_TURN_ADJUDICATION_CITATION_FOREIGN: ReasonCode.CONFLICT,
  ACTOR_TARGET_BINDING_IMMUTABLE: ReasonCode.CONFLICT,
  ACTOR_TARGET_BINDING_NO_REPLACE: ReasonCode.CONFLICT,
  ACTOR_TARGET_ATTESTATION_APPEND_ONLY: ReasonCode.CONFLICT,
  ACTOR_TARGET_ATTESTATION_NO_REPLACE: ReasonCode.CONFLICT,
  ATTESTATION_GENERATION_MISMATCH: ReasonCode.ATTESTATION_GENERATION_MISMATCH,
  ACTOR_SESSION_INCARNATION_MISMATCH: ReasonCode.ACTOR_SESSION_INCARNATION_MISMATCH,
  CONVERSATIONAL_ACTOR_NO_REPLACE: ReasonCode.CONFLICT,
  MANIFEST_NO_REPLACE: ReasonCode.CONFLICT,
  AUDIT_NO_REPLACE: ReasonCode.CONFLICT,
  BASELINE_RECORD_NO_REPLACE: ReasonCode.CONFLICT,
  TELEGRAM_PROMPT_NO_REPLACE: ReasonCode.CONFLICT,
  // Found by the same census, and older than this branch: five sentinels the schema raises that
  // nothing here translated. A guard whose denial arrives untyped is a guard whose caller cannot
  // tell it apart from a bug.
  // The ten a corrected census found. Its first pattern could not see `BEFORE UPDATE OF`,
  // which is the form four of this schema's most load-bearing guards take.
  SESSION_NO_REPLACE: ReasonCode.CONFLICT,
  RUN_NO_REPLACE: ReasonCode.CONFLICT,
  ASSIGNMENT_NO_REPLACE: ReasonCode.CONFLICT,
  TASK_EXECUTION_NO_REPLACE: ReasonCode.CONFLICT,
  CONVERSATIONAL_ACTOR_REGISTRATION_NO_REPLACE: ReasonCode.CONFLICT,
  OUTBOX_NO_REPLACE: ReasonCode.CONFLICT,
  RUN_ARTIFACT_NO_REPLACE: ReasonCode.CONFLICT,
  GITHUB_RECEIPT_NO_REPLACE: ReasonCode.CONFLICT,
  CANONICAL_TURN_ADJUDICATION_NO_REPLACE: ReasonCode.CONFLICT,
  CANONICAL_TURN_ADJUDICATION_CITATION_NO_REPLACE: ReasonCode.CONFLICT,
  TELEGRAM_PROMPT_IMMUTABLE: ReasonCode.CONFLICT,
  ACTOR_RETIREMENT_TERMINAL: ReasonCode.CONFLICT,
  ACTOR_RUNTIME_NOT_READY: ReasonCode.CONFLICT,
  SESSION_WORKDIR_IMMUTABLE: ReasonCode.CONFLICT,
  SESSION_SECRET_HASH_IMMUTABLE: ReasonCode.CONFLICT,
};

/**
 * SQLite reports a partial-index violation by column list, not by index name, so the
 * patterns below match the columns each guard rail is built on.
 */
const INDEX_CODES: Array<[RegExp, ReasonCode, string]> = [
  [/assignments\.project_id/, ReasonCode.PRIMARY_CTO_ALREADY_BOUND, "project already has an active primary CTO binding"],
  [/assignments\.role_key/, ReasonCode.BINDING_ALREADY_ACTIVE, "role key already has an active binding"],
  [/resource_claims\.worktree_id/, ReasonCode.CLAIM_WORKTREE_CONFLICT, "worktree already claimed by another holder"],
  [/resource_claims\.branch/, ReasonCode.CLAIM_BRANCH_CONFLICT, "branch already claimed by another holder"],
  [/resource_claims\.declared_path/, ReasonCode.CLAIM_PATH_CONFLICT, "declared write path already claimed by another holder"],
  [/outbox\.idempotency_key/, ReasonCode.OUTBOX_DUPLICATE_SUPPRESSED, "outbox idempotency key already used"],
  [/sessions\.buzz_actor_id/, ReasonCode.SESSION_BUZZ_ACTOR_ALREADY_BOUND, "buzz channel identity identity is already bound to a live session"],
  [/github_receipts\.idempotency_key/, ReasonCode.MERGE_IDEMPOTENT_REPLAY, "github operation already executed"],
  [/capacity_snapshots\./, ReasonCode.CONFLICT, "duplicate capacity snapshot"],
  [/verification_results\./, ReasonCode.CONFLICT, "duplicate verification result for this candidate"],
  [/task_executions\./, ReasonCode.CONFLICT, "duplicate task execution attempt"],
  [/manifests\./, ReasonCode.CONFLICT, "manifest digest already stored"],
];

export const translate = (err: unknown): unknown => {
  if (!(err instanceof Error) || isAcpError(err)) return err;
  const msg = err.message;
  for (const [key, code] of Object.entries(TRIGGER_CODES)) {
    if (msg.includes(key)) return acpError(code, msg, { sqlite: key });
  }
  for (const [pattern, code, message] of INDEX_CODES) {
    if (pattern.test(msg)) return acpError(code, message, { sqlite: msg });
  }
  if (msg.includes("CHECK constraint failed")) {
    // A CHECK is a value the caller supplied that the schema refuses. It is an argument
    // fault, and the evidence has to carry which constraint, or the denial says nothing
    // an operator can act on.
    return acpError(ReasonCode.INVALID_ARGUMENT, "value violates a database constraint", {
      sqlite: msg,
    });
  }
  if (msg.includes("FOREIGN KEY constraint failed")) {
    return acpError(ReasonCode.RUN_OWNER_REVOKED, "foreign-key authority tuple is invalid", {
      sqlite: msg,
    });
  }
  return err;
};

export const openDb = (filename: string, options?: DbOpenOptions): Db => new Db(filename, options);

/** The one version an approved copy may start from, and the one this command exists for. */
const APPROVED_COPY_FROM_VERSION = 25;
const SQLITE_HEADER_BYTES = 100;
const SQLITE_MAGIC = "SQLite format 3\u0000";

/**
 * The deployment's own database, derived here rather than supplied.
 *
 * A caller-supplied canonical path is the identity check's own answer handed to it: point it at a
 * scratch file and "this is not the live database" becomes true by construction.
 */
const deploymentDatabasePath = (): string => join(homedir(), ".agent-control-plane", "state.sqlite");

/**
 * The version a database is at, read out of the descriptor rather than by connecting to it.
 *
 * A read-only connection is not a read-only act: opening a WAL database makes SQLite build the
 * shared-memory index beside it, so a probe asking "what version is this copy?" would rewrite a
 * file this command has not yet decided to touch. The header answers the same question and moves
 * nothing — bytes 0..15 are the format string and 60..63 are `user_version`, big-endian.
 */
const versionFromDescriptor = (descriptor: number): number => {
  const header = Buffer.alloc(SQLITE_HEADER_BYTES);
  const read = readSync(descriptor, header, 0, SQLITE_HEADER_BYTES, 0);
  if (read < SQLITE_HEADER_BYTES || header.toString("latin1", 0, 16) !== SQLITE_MAGIC) {
    throw acpError(ReasonCode.INTERNAL_ERROR, "this copy is not an SQLite database", {});
  }
  return header.readUInt32BE(60);
};

/** Refuses the one file this command exists never to touch, compared by object rather than name. */
const assertNotTheDeploymentsOwnDatabase = (target: TargetIdentity): void => {
  const canonicalPath = deploymentDatabasePath();
  if (!existsSync(canonicalPath)) return;
  const canonical = targetIdentityOf(canonicalPath);
  if (canonical.device === target.device && canonical.inode === target.inode) {
    throw acpError(
      ReasonCode.INTERNAL_ERROR,
      "refusing to migrate the deployment's own database through the copy path",
      {},
    );
  }
};

/**
 * Everything that must be true of the object this command is holding open.
 *
 * The identity comes from the descriptor, not from resolving the pathname a second time. That is
 * the whole point of the binding: a name can stop leading to the file it named between any two
 * syscalls, and a check that asks the name again is describing a file that may not be the one the
 * connection got.
 */
const assertApprovedCopyIdentity = (
  databasePath: string,
  descriptor: number,
  target: TargetIdentity,
): void => {
  const opened = fstatSync(descriptor);
  if (!opened.isFile()) {
    throw acpError(ReasonCode.INTERNAL_ERROR, "refusing a target that is not a regular file", {});
  }
  if (opened.nlink !== 1) {
    throw acpError(
      ReasonCode.INTERNAL_ERROR,
      `refusing a copy with ${opened.nlink} links: it is reachable under another name`,
      {},
    );
  }
  assertNotTheDeploymentsOwnDatabase(target);

  const onDisk = versionFromDescriptor(descriptor);
  if (onDisk !== APPROVED_COPY_FROM_VERSION) {
    throw acpError(
      ReasonCode.INTERNAL_ERROR,
      `this copy is at ${onDisk} and this command migrates a copy at ${APPROVED_COPY_FROM_VERSION}`,
      {},
    );
  }

  const approval = readMigrationApproval(databasePath);
  if (!approval) {
    throw acpError(ReasonCode.INTERNAL_ERROR, "no approval is on file for this copy", {});
  }
  if (!isSameTarget(approval.target, target)) {
    // The approval is a capability over one file. Two databases in one private directory, an
    // approval taken on A and this command run on B, is the split `#747` measured — and because
    // `target` came from the descriptor, it also catches an intruder standing at the pathname.
    throw acpError(
      ReasonCode.INTERNAL_ERROR,
      "the approval on file names a different database than this copy",
      {},
    );
  }
  const expected = migrationPlanFrom(APPROVED_COPY_FROM_VERSION);
  if (approval.fromVersion !== expected.fromVersion || approval.toVersion !== expected.toVersion) {
    throw acpError(
      ReasonCode.INTERNAL_ERROR,
      `the approval covers ${approval.fromVersion}\u2192${approval.toVersion} and this command runs ` +
        `${expected.fromVersion}\u2192${expected.toVersion}`,
      {},
    );
  }
  if (
    approval.migrations.length !== expected.migrations.length ||
    approval.migrations.some((id: string, index: number) => id !== expected.migrations[index])
  ) {
    // Same endpoints, different steps. An approval naming another ordered chain approves another
    // migration, and only the ordered comparison can tell them apart.
    throw acpError(
      ReasonCode.INTERNAL_ERROR,
      "the approval names a different ordered chain than this build runs",
      {},
    );
  }
};

/** What one approved-copy migration did, in the terms an operator can check (`U6` unit 3). */
export interface ApprovedCopyMigrationReport {
  fromVersion: number;
  toVersion: number;
  /** Each step that ran, and whether its receipt carries a checksum. Never the checksum itself. */
  migrations: Array<{ id: string; checksum: boolean }>;
  /** Whether the approval this consumed is no longer on file. */
  approvalRetired: boolean;
  /** The journal mode SQLite actually established, not the one the open asked for. */
  journalMode: string;
  /** Always true here, and stated so the report says which program produced it. */
  daemonless: boolean;
}

/**
 * Migrates one disposable copy through the approved chain and reads the result back.
 *
 * The reconciliation packet did this with `node --input-type=module -e`, importing `openDb` from
 * the deployment's `dist`. That is a private import spelled out in a runbook: nothing versions it,
 * nothing tests it, and the operator proving a chain during an incident is running a program they
 * wrote at the keyboard. This is the same act with an owner.
 *
 * **The operator's pathname is resolved exactly once, into a descriptor, and every later decision
 * is about that object.** `lstat(path)` and `open(path)` are two syscalls and a rename between
 * them is invisible to both, so a command that verifies a pathname and then hands the same
 * pathname to SQLite has verified one thing and opened another. Checking harder does not help; the
 * counterexample is to hold an unrelated descriptor on the approved file, point the pathname at an
 * intruder across the open, and put it back.
 *
 * So the descriptor is the authority, and `native/fd-vfs` makes SQLite use it: the connection below
 * opens the operator's own pathname, and the bound VFS hands it a duplicate of the descriptor this
 * function verified. Nothing is staged and nothing is written back — the migration happens in the
 * approved file itself, through a handle that cannot be redirected.
 */
export const migrateApprovedCopy = (databasePath: string): ApprovedCopyMigrationReport => {
  /*
   * The lock comes first, before anything is opened or bound.
   *
   * Leaving it to `Db` was wrong in a way only two processes show: both could bind the same inode
   * and open it before either reached `withMigrationExclusivity`, because the bound VFS's locking
   * methods are deliberately no-ops — this command holds the directory lock, so there is nothing
   * else to exclude *once it holds it*. Without it the loser could migrate a database the winner
   * had already migrated, or restore its own pre-migration image over the winner's result and
   * report success. A descriptor that cannot be moved is not a promise that its bytes are still
   * what they were.
   *
   * The path is spelled exactly as `withMigrationExclusivity` spells it — `dirname` without
   * resolution — because a lock at `/var/...` and a lock at `/private/var/...` are two files and
   * would exclude nobody.
   */
  const lock = new SingleInstanceLock(join(dirname(databasePath), "agentcpd.lock"));
  const acquired = lock.acquire(new Date().toISOString());
  if (!acquired.allowed) {
    throw acpError(
      acquired.reasonCode,
      "refusing to migrate a copy while another process holds the state lock",
      { ...acquired.evidence },
    );
  }
  try {
    // Everything below is decided under the lease. Shape questions come first because `open`
    // follows a symbolic link, and following one would put the descriptor on a file nobody named.
    const named = lstatSync(databasePath, { throwIfNoEntry: false });
    if (!named) throw acpError(ReasonCode.INTERNAL_ERROR, "the named copy does not exist", {});
    if (named.isSymbolicLink()) {
      throw acpError(ReasonCode.INTERNAL_ERROR, "refusing a symbolic link: name the copy itself", {});
    }
    if (!named.isFile()) {
      throw acpError(ReasonCode.INTERNAL_ERROR, "refusing a target that is not a regular file", {});
    }
    // A copy handed to this command has to be at rest. In WAL mode the main file's header can lag
    // behind committed frames living in the sidecar, so a copy with a non-empty log beside it is
    // one whose version cannot be read from its header — and a bound connection cannot own a
    // shared-memory family, so it could not replay that log either.
    for (const suffix of ["-wal", "-shm"]) {
      const sidecar = `${databasePath}${suffix}`;
      if (existsSync(sidecar) && statSync(sidecar).size > 0) {
        throw acpError(
          ReasonCode.INTERNAL_ERROR,
          `refusing a copy with a non-empty ${suffix.slice(1)} beside it: name it at rest`,
          {},
        );
      }
    }

    const control = FdVfsControl.load();
    try {
      return withBoundDescriptor(control, databasePath, (descriptor) => {
        // Identity, link count, version and approval are all read here — under the lease, and from
        // the descriptor this command holds rather than from the pathname a second time.
        const opened = fstatSync(descriptor);
        const target: TargetIdentity = {
          path: realpathSync(databasePath),
          device: opened.dev,
          inode: opened.ino,
        };
        assertApprovedCopyIdentity(databasePath, descriptor, target);

        const writer = new Db(databasePath, { migrationLock: lock });
        try {
          /*
           * The mode SQLite established, not the one it was asked for. `Db` requests WAL on every
           * file-backed open, and a bound connection has no shared-memory support, so SQLite
           * declines and stays on a rollback journal — silently, by returning the old mode rather
           * than an error. Asserting the request would assert nothing.
           */
          const mode = String(
            (writer.get<{ journal_mode: string }>("SELECT journal_mode FROM pragma_journal_mode") ??
              { journal_mode: "" }).journal_mode,
          ).toLowerCase();
          if (mode === "wal" || mode === "") {
            throw acpError(
              ReasonCode.INTERNAL_ERROR,
              `a bound migration must run on a rollback journal and this one reports ${mode || "nothing"}`,
              {},
            );
          }

          /*
           * What this writer did, not what the file happens to look like.
           *
           * Reading the version back and calling it success would report someone else's migration
           * as this command's: a second process arriving after the first finished would find the
           * final version, an absent approval, and print `fromVersion: 25` with nothing of its own
           * behind it. Success therefore requires that *this* open applied *this* approval.
           */
          const applied = writer.appliedMigrationApproval;
          if (applied === null) {
            throw acpError(
              ReasonCode.INTERNAL_ERROR,
              "this open applied no migration, so there is no approved chain to report",
              {},
            );
          }
          const toVersion = Number(
            (writer.get<{ user_version: number }>("SELECT user_version FROM pragma_user_version") ??
              { user_version: 0 }).user_version,
          );
          if (toVersion !== SCHEMA_VERSION) {
            throw acpError(
              ReasonCode.INTERNAL_ERROR,
              `the copy ended at ${toVersion} and this build declares ${SCHEMA_VERSION}`,
              {},
            );
          }
          const receipts = writer.all<{ id: string; checksum: string | null }>(
            `SELECT migration_id AS id, checksum FROM schema_migrations
              WHERE version > ? ORDER BY version`,
            [APPROVED_COPY_FROM_VERSION],
          );
          const planned = migrationPlanFrom(APPROVED_COPY_FROM_VERSION).migrations;
          if (
            receipts.length !== planned.length ||
            receipts.some((receipt, index) => receipt.id !== planned[index])
          ) {
            throw acpError(
              ReasonCode.INTERNAL_ERROR,
              "the receipts on file are not the ordered chain this command approved",
              {},
            );
          }

          return {
            fromVersion: applied.fromVersion,
            toVersion,
            migrations: receipts.map((receipt) => ({
              id: receipt.id,
              checksum: /^sha256:[a-f0-9]{64}$/.test(receipt.checksum ?? ""),
            })),
            approvalRetired: writer.migrationApprovalRetirement?.retired ?? false,
            journalMode: mode,
            daemonless: true,
          };
        } finally {
          // Closed inside the binding, which is released inside the lease: a release is refused
          // while any file of the binding is open, and the lease must outlive both.
          writer.close();
        }
      });
    } finally {
      control.close();
    }
  } finally {
    lock.release();
  }
};
