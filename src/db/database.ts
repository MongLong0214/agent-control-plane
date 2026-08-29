import Database from "better-sqlite3";
import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname } from "node:path";

import { acpError, fail, isAcpError, type Decision } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import {
  DEFAULT_BACKUP_RETENTION,
  assertIntegrity,
  backupDatabase,
  backupOpenDatabaseSync,
  nextBackupPath,
  pruneAutomaticBackups,
  restoreDatabase,
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
  assertPrivateDatabaseFiles,
  ensurePrivateDirectory,
  finalizeNewPrivateDatabaseFiles,
} from "./state-preflight.ts";

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
  /** Test-only fault injection that proves a committed migration is restored from its backup. */
  afterMigration?: (migration: SchemaMigration) => void;
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

  constructor(filename: string, private readonly options: DbOpenOptions = {}) {
    const persistent = filename !== ":memory:";
    const databaseExisted = persistent && existsSync(filename);
    if (persistent) {
      ensurePrivateDirectory(dirname(filename));
      if (databaseExisted) assertPrivateDatabaseFiles(filename);
    }
    this.#raw = new Database(filename);
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
      return;
    }
    this.migrate(filename, version);
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
        restoreDatabase(filename, backup.path);
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
        const result = fn();
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
  CANONICAL_TURN_ADJUDICATION_AUTHORITY_DENIED: ReasonCode.COMPLETION_AUTHORITY_DENIED,
  CANONICAL_TURN_ADJUDICATION_APPEND_ONLY: ReasonCode.CONFLICT,
  CANONICAL_TURN_ADJUDICATION_CITATION_AUTHORITY_DENIED: ReasonCode.COMPLETION_AUTHORITY_DENIED,
  CANONICAL_TURN_ADJUDICATION_CITATION_APPEND_ONLY: ReasonCode.CONFLICT,
  CANONICAL_TURN_ADJUDICATION_CITATION_FOREIGN: ReasonCode.CONFLICT,
  ACTOR_TARGET_BINDING_IMMUTABLE: ReasonCode.CONFLICT,
  ACTOR_TARGET_BINDING_NO_REPLACE: ReasonCode.CONFLICT,
  ACTOR_TARGET_ATTESTATION_APPEND_ONLY: ReasonCode.CONFLICT,
  ACTOR_TARGET_ATTESTATION_NO_REPLACE: ReasonCode.CONFLICT,
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
