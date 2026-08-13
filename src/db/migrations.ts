import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type Database from "better-sqlite3";

import { acpError } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";

export const SCHEMA_VERSION = 12;

const schemaPath = fileURLToPath(new URL("./schema.sql", import.meta.url));

export const schemaSql = (): string => readFileSync(schemaPath, "utf8");

/** Connection PRAGMAs are established by Db before any migration transaction begins. */
export const schemaDdl = (): string =>
  schemaSql().replace(/^\s*PRAGMA\s+(?:journal_mode|foreign_keys|synchronous)\s*=\s*[^;]+;\s*$/gim, "");

export interface SchemaMigration {
  id: string;
  fromVersion: number;
  toVersion: number;
  /** Applies only additive DDL or an explicit, reviewed table rebuild. */
  apply(raw: Database.Database): void;
  /** Captures the exact source shape applied in this migration receipt. */
  checksum(): string;
}

const sha256 = (input: string): string =>
  `sha256:${createHash("sha256").update(input).digest("hex")}`;

const migrationChecksum = (id: string): string => sha256(`${id}\n${schemaSql()}`);

/**
 * Migration metadata is intentionally separate from schema.sql. It is bootstrap state for
 * the migrator itself and is protected by the same connection-local authority model as
 * evidence rows, so a runtime handler cannot invent a successful upgrade receipt.
 */
export const installMigrationLedger = (raw: Database.Database): void => {
  raw.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version         INTEGER PRIMARY KEY CHECK (version > 0),
      migration_id    TEXT NOT NULL UNIQUE,
      checksum        TEXT NOT NULL CHECK (checksum LIKE 'sha256:%'),
      backup_file     TEXT,
      backup_checksum TEXT,
      applied_at      TEXT NOT NULL,
      CHECK ((backup_file IS NULL) = (backup_checksum IS NULL))
    );

    CREATE TRIGGER IF NOT EXISTS schema_migrations_insert_authority
    BEFORE INSERT ON schema_migrations
    WHEN acp_schema_migration_authorized() <> 1
    BEGIN
      SELECT RAISE(ABORT, 'SCHEMA_MIGRATION_AUTHORITY_DENIED');
    END;

    CREATE TRIGGER IF NOT EXISTS schema_migrations_immutable
    BEFORE UPDATE ON schema_migrations
    BEGIN
      SELECT RAISE(ABORT, 'SCHEMA_MIGRATION_RECEIPT_IMMUTABLE');
    END;

    CREATE TRIGGER IF NOT EXISTS schema_migrations_no_delete
    BEFORE DELETE ON schema_migrations
    BEGIN
      SELECT RAISE(ABORT, 'SCHEMA_MIGRATION_RECEIPT_IMMUTABLE');
    END;
  `);
};

/**
 * v11 was the previous released state. v12 adds the durable migration ledger and replays
 * the idempotent schema objects so a v11 database missing a load-bearing trigger is repaired
 * only as part of this explicit upgrade. A same-version open never repairs corruption.
 *
 * Any later column/check/table change must add another ordered entry here. Re-running
 * CREATE TABLE IF NOT EXISTS is deliberately not presented as a general migration path.
 */
const v12: SchemaMigration = {
  id: "v12-migration-ledger-and-invariant-replay",
  fromVersion: 11,
  toVersion: 12,
  apply: (raw) => {
    raw.exec(schemaDdl());
    installMigrationLedger(raw);
  },
  checksum: () => migrationChecksum("v12-migration-ledger-and-invariant-replay"),
};

export const MIGRATIONS: readonly SchemaMigration[] = Object.freeze([v12]);

const REQUIRED_TRIGGERS: ReadonlyArray<{ name: string; sentinel: string }> = [
  { name: "runs_state_transition_authority_guard", sentinel: "RUN_STATE_TRANSITION_AUTHORITY_DENIED" },
  { name: "tasks_run_work_sealed", sentinel: "TASK_INSERT_RUN_SEALED" },
  { name: "run_artifacts_evidence_authority_guard", sentinel: "EVIDENCE_WRITE_AUTHORITY_DENIED" },
  { name: "run_artifacts_content_immutable", sentinel: "ARTIFACT_IMMUTABLE" },
  { name: "run_artifacts_no_delete", sentinel: "ARTIFACT_IMMUTABLE" },
  { name: "github_receipts_immutable", sentinel: "GITHUB_RECEIPT_IMMUTABLE" },
  { name: "github_receipts_no_delete", sentinel: "GITHUB_RECEIPT_IMMUTABLE" },
];

const REQUIRED_LEDGER_TRIGGERS: ReadonlyArray<{ name: string; sentinel: string }> = [
  { name: "schema_migrations_insert_authority", sentinel: "SCHEMA_MIGRATION_AUTHORITY_DENIED" },
  { name: "schema_migrations_immutable", sentinel: "SCHEMA_MIGRATION_RECEIPT_IMMUTABLE" },
  { name: "schema_migrations_no_delete", sentinel: "SCHEMA_MIGRATION_RECEIPT_IMMUTABLE" },
];

/**
 * Names alone are not enough: a same-named no-op trigger would make a corrupt database look
 * healthy. The embedded denial marker proves that each load-bearing guard still has its
 * intended enforcement body.
 */
export const assertLoadBearingInvariants = (
  raw: Database.Database,
  options: { includeMigrationLedger: boolean },
): void => {
  const expected = options.includeMigrationLedger
    ? [...REQUIRED_TRIGGERS, ...REQUIRED_LEDGER_TRIGGERS]
    : REQUIRED_TRIGGERS;
  for (const trigger of expected) {
    const row = raw
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?")
      .get(trigger.name) as { sql?: string | null } | undefined;
    if (!row?.sql || !row.sql.includes(trigger.sentinel)) {
      throw acpError(
        ReasonCode.INTERNAL_ERROR,
        "database is missing a load-bearing schema invariant",
        { trigger: trigger.name, sentinel: trigger.sentinel },
      );
    }
  }
};

export const assertMigrationLedgerAt = (raw: Database.Database, version: number): void => {
  const table = raw
    .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get() as { n: number };
  if (table.n !== 1) {
    throw acpError(ReasonCode.INTERNAL_ERROR, "database has no migration ledger", { version });
  }
  const receipt = raw
    .prepare("SELECT migration_id, checksum FROM schema_migrations WHERE version = ?")
    .get(version) as { migration_id: string; checksum: string } | undefined;
  if (!receipt || !/^sha256:[a-f0-9]{64}$/.test(receipt.checksum)) {
    throw acpError(ReasonCode.INTERNAL_ERROR, "database migration receipt is missing or malformed", {
      version,
      receipt: receipt ?? null,
    });
  }
};

export const migrationChainFrom = (version: number): readonly SchemaMigration[] => {
  const chain: SchemaMigration[] = [];
  let cursor = version;
  while (cursor < SCHEMA_VERSION) {
    const next = MIGRATIONS.find((migration) => migration.fromVersion === cursor);
    if (!next) {
      throw acpError(
        ReasonCode.INTERNAL_ERROR,
        "database schema is older than this build and no ordered migration is defined",
        { expected: SCHEMA_VERSION, found: version, missingFromVersion: cursor },
      );
    }
    chain.push(next);
    cursor = next.toVersion;
  }
  return chain;
};

export const bootstrapChecksum = (): string => sha256(`bootstrap-v${SCHEMA_VERSION}\n${schemaSql()}`);
