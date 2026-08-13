import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type Database from "better-sqlite3";

import { acpError } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";

/** The ordered registry is the only authority for changing a deployed schema. */
export const SCHEMA_VERSION = 15;

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
  /** A reviewed parent-table rebuild may need foreign-key checks disabled for its transaction. */
  foreignKeysOffDuringApply?: boolean;
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

/**
 * v13 carries the finalization state machine introduced after the v12 ledger release. The
 * state CHECK and its transition/sealing triggers are part of the durable contract, so this
 * is an explicit parent-table rebuild rather than another `CREATE IF NOT EXISTS` replay.
 */
const v13: SchemaMigration = {
  id: "v13-finalization-state-machine",
  fromVersion: 12,
  toVersion: 13,
  foreignKeysOffDuringApply: true,
  apply: (raw) => {
    raw.exec(`
      DROP TRIGGER IF EXISTS runs_state_transition_guard;
      DROP TRIGGER IF EXISTS runs_state_transition_authority_guard;
      DROP TRIGGER IF EXISTS tasks_run_work_sealed;

      CREATE TABLE runs_finalization_migration (
        run_id                    TEXT PRIMARY KEY,
        project_id                TEXT REFERENCES projects(project_id) ON DELETE CASCADE,
        kind                      TEXT NOT NULL
                                  CHECK (kind IN ('STANDARD_WORK','PROJECT_BOOTSTRAP','CONTRACT_CHANGE')),
        execution_mode            TEXT NOT NULL CHECK (execution_mode IN ('SIMPLE','STANDARD','GUARDED')),
        priority                  TEXT NOT NULL CHECK (priority IN ('CRITICAL','NORMAL','LOW')),
        state                     TEXT NOT NULL
                                  CHECK (state IN ('QUEUED','ACTIVE','BLOCKED','READY_FOR_CEO_REVIEW',
                                                   'CEO_APPROVED','MERGING','POST_MERGE_VERIFYING',
                                                   'BLOCKED_POST_MERGE','REVISION_REQUIRED','AWAITING_HUMAN',
                                                   'COMPLETED','FAILED','CANCELLED')),
        goal                      TEXT NOT NULL,
        contract_digest           TEXT NOT NULL,
        pinned_manifest_digest    TEXT REFERENCES manifests(digest),
        pinned_run_scoped_commands_digest TEXT,
        pinned_run_scoped_commands_json   TEXT,
        owner_session_id          TEXT REFERENCES sessions(session_id),
        owner_binding_generation  INTEGER,
        owner_session_incarnation TEXT,
        owner_role_key            TEXT,
        current_candidate_digest  TEXT,
        human_gate_required       INTEGER NOT NULL DEFAULT 0 CHECK (human_gate_required IN (0,1)),
        revision_count            INTEGER NOT NULL DEFAULT 0,
        created_at                TEXT NOT NULL,
        dispatched_at             TEXT,
        ended_at                  TEXT,
        state_reason              TEXT,
        CHECK ((owner_session_id IS NULL) = (owner_binding_generation IS NULL)),
        CHECK ((owner_session_id IS NULL) = (owner_session_incarnation IS NULL)),
        CHECK ((owner_session_id IS NULL) = (owner_role_key IS NULL)),
        CHECK ((pinned_run_scoped_commands_digest IS NULL) = (pinned_run_scoped_commands_json IS NULL)),
        FOREIGN KEY (owner_role_key, owner_binding_generation, owner_session_id, owner_session_incarnation)
          REFERENCES assignments(role_key, binding_generation, session_id, session_incarnation)
          DEFERRABLE INITIALLY DEFERRED
      );

      INSERT INTO runs_finalization_migration (
        run_id, project_id, kind, execution_mode, priority, state, goal, contract_digest,
        pinned_manifest_digest, pinned_run_scoped_commands_digest, pinned_run_scoped_commands_json,
        owner_session_id, owner_binding_generation, owner_session_incarnation, owner_role_key,
        current_candidate_digest, human_gate_required, revision_count, created_at, dispatched_at,
        ended_at, state_reason
      )
      SELECT
        run_id, project_id, kind, execution_mode, priority, state, goal, contract_digest,
        pinned_manifest_digest, pinned_run_scoped_commands_digest, pinned_run_scoped_commands_json,
        owner_session_id, owner_binding_generation, owner_session_incarnation, owner_role_key,
        current_candidate_digest, human_gate_required, revision_count, created_at, dispatched_at,
        ended_at, state_reason
      FROM runs;

      DROP TABLE runs;
      ALTER TABLE runs_finalization_migration RENAME TO runs;
    `);

    // Re-run the current idempotent DDL after the rebuild. The three dropped triggers are
    // recreated with the finalization edges and the new task-sealing states.
    raw.exec(schemaDdl());
  },
  checksum: () => migrationChecksum("v13-finalization-state-machine"),
};

const BASELINE_RECORDS_DDL = `
  CREATE TABLE IF NOT EXISTS baseline_records (
    record_id      INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id         TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    record_kind    TEXT NOT NULL,
    schema_id      TEXT NOT NULL,
    recorded_at    TEXT NOT NULL,
    payload_json   TEXT NOT NULL,
    payload_digest TEXT NOT NULL CHECK (payload_digest LIKE 'sha256:%'),
    UNIQUE (run_id, record_kind, payload_digest)
  );

  CREATE TRIGGER IF NOT EXISTS baseline_records_immutable
  BEFORE UPDATE ON baseline_records
  BEGIN
    SELECT RAISE(ABORT, 'BASELINE_RECORD_IMMUTABLE');
  END;

  CREATE TRIGGER IF NOT EXISTS baseline_records_no_delete
  BEFORE DELETE ON baseline_records
  BEGIN
    SELECT RAISE(ABORT, 'BASELINE_RECORD_IMMUTABLE');
  END;

  CREATE INDEX IF NOT EXISTS baseline_records_run_kind
    ON baseline_records(run_id, record_kind, recorded_at, record_id);
`;

/** v14 adds the immutable baseline evidence ledger after the reserved v13 state machine. */
const v14: SchemaMigration = {
  id: "v14-baseline-evidence-ledger",
  fromVersion: 13,
  toVersion: 14,
  apply: (raw) => raw.exec(BASELINE_RECORDS_DDL),
  checksum: () => sha256(`v14-baseline-evidence-ledger\n${BASELINE_RECORDS_DDL}`),
};

const VERIFICATION_WORKTREES_DDL = `
  CREATE TABLE IF NOT EXISTS verification_worktrees (
    worktree_id               TEXT PRIMARY KEY,
    run_id                    TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    command_id                TEXT NOT NULL,
    candidate_snapshot_digest TEXT NOT NULL,
    repository_identity       TEXT NOT NULL,
    repository_checkout_path  TEXT NOT NULL,
    worktree_path             TEXT NOT NULL UNIQUE,
    head                      TEXT NOT NULL,
    owner_session_id          TEXT NOT NULL REFERENCES sessions(session_id),
    owner_binding_generation  INTEGER NOT NULL,
    owner_role_key            TEXT NOT NULL,
    state                     TEXT NOT NULL
                                CHECK (state IN ('CREATING','ACTIVE','DESTROYING','DESTROYED','FAILED')),
    created_at                TEXT NOT NULL,
    active_at                 TEXT,
    ended_at                  TEXT
  );

  CREATE INDEX IF NOT EXISTS verification_worktrees_live
    ON verification_worktrees(repository_identity, state, worktree_id);
`;

/** v15 makes verification worktree ownership durable before Git materialises the tree. */
const v15: SchemaMigration = {
  id: "v15-durable-verification-worktree-ownership",
  fromVersion: 14,
  toVersion: 15,
  apply: (raw) => raw.exec(VERIFICATION_WORKTREES_DDL),
  checksum: () => sha256(`v15-durable-verification-worktree-ownership\n${VERIFICATION_WORKTREES_DDL}`),
};

export const MIGRATIONS: readonly SchemaMigration[] = Object.freeze([v12, v13, v14, v15]);

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

const REQUIRED_BASELINE_LEDGER_TRIGGERS: ReadonlyArray<{ name: string; sentinel: string }> = [
  { name: "baseline_records_immutable", sentinel: "BASELINE_RECORD_IMMUTABLE" },
  { name: "baseline_records_no_delete", sentinel: "BASELINE_RECORD_IMMUTABLE" },
];

/**
 * Names alone are not enough: a same-named no-op trigger would make a corrupt database look
 * healthy. The embedded denial marker proves that each load-bearing guard still has its
 * intended enforcement body.
 */
export const assertLoadBearingInvariants = (
  raw: Database.Database,
  options: { includeMigrationLedger: boolean; includeBaselineLedger?: boolean },
): void => {
  const expected = [
    ...(options.includeMigrationLedger
      ? [...REQUIRED_TRIGGERS, ...REQUIRED_LEDGER_TRIGGERS]
      : REQUIRED_TRIGGERS),
    ...(options.includeBaselineLedger ? REQUIRED_BASELINE_LEDGER_TRIGGERS : []),
  ];
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
