import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import { defaultConfig, ControlPlane } from "../../src/app/control-plane.ts";
import { defaultBackupDirectory, restoreDatabase } from "../../src/db/backup.ts";
import { Db, SCHEMA_VERSION } from "../../src/db/database.ts";
import { approveMigration } from "../../src/db/migration-approval.ts";
import {
  installMigrationLedger,
  MIGRATIONS,
  replayDdlWithoutPostV12Columns,
  schemaSql,
} from "../../src/db/migrations.ts";
import { isAcpError } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { systemClock } from "../../src/core/clock.ts";
import { Daemon } from "../../src/daemon/daemon.ts";
import { TestProductionAdapter } from "../helpers/production-adapter.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

const NOW = "2026-08-13T00:00:00.000Z";
const V11_SCHEMA = readFileSync(
  fileURLToPath(new URL("../fixtures/schema-v11.sql", import.meta.url)),
  "utf8",
);

/** Explicit v13/v14 shape additions used to build a real v14 file without current schema.sql. */
const V14_FIXTURE_SHAPE = `
PRAGMA foreign_keys = OFF;
DROP TRIGGER IF EXISTS runs_state_transition_guard;
DROP TRIGGER IF EXISTS runs_state_transition_authority_guard;
DROP TRIGGER IF EXISTS tasks_run_work_sealed;

CREATE TABLE runs_v14_fixture (
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

INSERT INTO runs_v14_fixture (
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
ALTER TABLE runs_v14_fixture RENAME TO runs;

CREATE TABLE finalization_attempts (
  run_id                 TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
  attempt_id             TEXT NOT NULL,
  lease_owner            TEXT NOT NULL,
  candidate_digest       TEXT NOT NULL,
  state                  TEXT NOT NULL CHECK (state IN ('RUNNING','RELEASED','COMPLETED','BLOCKED')),
  started_at             TEXT NOT NULL,
  deadline_at            TEXT NOT NULL,
  released_at            TEXT,
  completed_at           TEXT,
  last_step              TEXT NOT NULL,
  failure_reason         TEXT,
  compensation_plan_json TEXT,
  CHECK (compensation_plan_json IS NULL OR json_valid(compensation_plan_json) = 1)
);
CREATE INDEX finalization_attempts_running_deadline ON finalization_attempts(state, deadline_at);

CREATE TRIGGER runs_state_transition_guard
BEFORE UPDATE OF state ON runs
WHEN NEW.state <> OLD.state
 AND NOT (
   (OLD.state = 'QUEUED' AND NEW.state IN ('ACTIVE','CANCELLED')) OR
   (OLD.state = 'ACTIVE' AND NEW.state IN ('BLOCKED','READY_FOR_CEO_REVIEW','FAILED','CANCELLED','AWAITING_HUMAN')) OR
   (OLD.state = 'BLOCKED' AND NEW.state IN ('ACTIVE','FAILED','CANCELLED','AWAITING_HUMAN')) OR
   (OLD.state = 'READY_FOR_CEO_REVIEW' AND NEW.state IN ('CEO_APPROVED','COMPLETED','REVISION_REQUIRED','AWAITING_HUMAN')) OR
   (OLD.state = 'CEO_APPROVED' AND NEW.state IN ('MERGING')) OR
   (OLD.state = 'MERGING' AND NEW.state IN ('POST_MERGE_VERIFYING','BLOCKED_POST_MERGE')) OR
   (OLD.state = 'POST_MERGE_VERIFYING' AND NEW.state IN ('MERGING','COMPLETED','BLOCKED_POST_MERGE')) OR
   (OLD.state = 'REVISION_REQUIRED' AND NEW.state IN ('ACTIVE','FAILED','CANCELLED')) OR
   (OLD.state = 'AWAITING_HUMAN' AND NEW.state IN ('ACTIVE','CANCELLED','FAILED'))
 )
BEGIN
  SELECT RAISE(ABORT, 'RUN_STATE_TRANSITION_ILLEGAL');
END;

CREATE TRIGGER runs_state_transition_authority_guard
BEFORE UPDATE OF state ON runs
WHEN NEW.state <> OLD.state
 AND (
   (OLD.state = 'QUEUED' AND NEW.state IN ('ACTIVE','CANCELLED')) OR
   (OLD.state = 'ACTIVE' AND NEW.state IN ('BLOCKED','READY_FOR_CEO_REVIEW','FAILED','CANCELLED','AWAITING_HUMAN')) OR
   (OLD.state = 'BLOCKED' AND NEW.state IN ('ACTIVE','FAILED','CANCELLED','AWAITING_HUMAN')) OR
   (OLD.state = 'READY_FOR_CEO_REVIEW' AND NEW.state IN ('CEO_APPROVED','COMPLETED','REVISION_REQUIRED','AWAITING_HUMAN')) OR
   (OLD.state = 'CEO_APPROVED' AND NEW.state IN ('MERGING')) OR
   (OLD.state = 'MERGING' AND NEW.state IN ('POST_MERGE_VERIFYING','BLOCKED_POST_MERGE')) OR
   (OLD.state = 'POST_MERGE_VERIFYING' AND NEW.state IN ('MERGING','COMPLETED','BLOCKED_POST_MERGE')) OR
   (OLD.state = 'REVISION_REQUIRED' AND NEW.state IN ('ACTIVE','FAILED','CANCELLED')) OR
   (OLD.state = 'AWAITING_HUMAN' AND NEW.state IN ('ACTIVE','CANCELLED','FAILED'))
 )
 AND acp_run_state_transition_authorized(NEW.run_id, NEW.state) <> 1
BEGIN
  SELECT RAISE(ABORT, 'RUN_STATE_TRANSITION_AUTHORITY_DENIED');
END;

CREATE TRIGGER tasks_run_work_sealed
BEFORE INSERT ON tasks
WHEN EXISTS (
  SELECT 1 FROM runs
   WHERE run_id = NEW.run_id
     AND state IN ('READY_FOR_CEO_REVIEW','CEO_APPROVED','MERGING','POST_MERGE_VERIFYING',
                   'BLOCKED_POST_MERGE','AWAITING_HUMAN','COMPLETED','FAILED','CANCELLED')
)
BEGIN
  SELECT RAISE(ABORT, 'TASK_INSERT_RUN_SEALED');
END;

CREATE TABLE baseline_records (
  record_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id         TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  record_kind    TEXT NOT NULL,
  schema_id      TEXT NOT NULL,
  recorded_at    TEXT NOT NULL,
  payload_json   TEXT NOT NULL,
  payload_digest TEXT NOT NULL CHECK (payload_digest LIKE 'sha256:%'),
  UNIQUE (run_id, record_kind, payload_digest)
);
CREATE TRIGGER baseline_records_immutable
BEFORE UPDATE ON baseline_records
BEGIN
  SELECT RAISE(ABORT, 'BASELINE_RECORD_IMMUTABLE');
END;
CREATE TRIGGER baseline_records_no_delete
BEFORE DELETE ON baseline_records
BEGIN
  SELECT RAISE(ABORT, 'BASELINE_RECORD_IMMUTABLE');
END;
CREATE INDEX baseline_records_run_kind ON baseline_records(run_id, record_kind, recorded_at, record_id);
PRAGMA foreign_keys = ON;
`;

const V14_LEDGER_DDL = `
CREATE TABLE schema_migrations (
  version         INTEGER PRIMARY KEY CHECK (version > 0),
  migration_id    TEXT NOT NULL UNIQUE,
  checksum        TEXT NOT NULL CHECK (checksum LIKE 'sha256:%'),
  backup_file     TEXT,
  backup_checksum TEXT,
  applied_at      TEXT NOT NULL,
  CHECK ((backup_file IS NULL) = (backup_checksum IS NULL))
);
CREATE TRIGGER schema_migrations_insert_authority
BEFORE INSERT ON schema_migrations
WHEN acp_schema_migration_authorized() <> 1
BEGIN
  SELECT RAISE(ABORT, 'SCHEMA_MIGRATION_AUTHORITY_DENIED');
END;
CREATE TRIGGER schema_migrations_immutable
BEFORE UPDATE ON schema_migrations
BEGIN
  SELECT RAISE(ABORT, 'SCHEMA_MIGRATION_RECEIPT_IMMUTABLE');
END;
CREATE TRIGGER schema_migrations_no_delete
BEFORE DELETE ON schema_migrations
BEGIN
  SELECT RAISE(ABORT, 'SCHEMA_MIGRATION_RECEIPT_IMMUTABLE');
END;
`;

type SqliteHandle = Db | Database.Database;

const execute = (db: SqliteHandle, sql: string, params: unknown[] = []): void => {
  if (db instanceof Db) {
    db.run(sql, params);
    return;
  }
  db.prepare(sql).run(...(params as never[]));
};

const all = <T>(db: SqliteHandle, sql: string, params: unknown[] = []): T[] =>
  db instanceof Db
    ? db.all<T>(sql, params)
    : (db.prepare(sql).all(...(params as never[])) as T[]);

const seedHistory = (db: SqliteHandle): void => {
  execute(
    db,
    `INSERT INTO runs (run_id, kind, execution_mode, priority, state, goal, contract_digest, created_at)
     VALUES ('run_history', 'STANDARD_WORK', 'STANDARD', 'NORMAL', 'READY_FOR_CEO_REVIEW',
             'preserve history', 'sha256:contract', ?)`,
    [NOW],
  );
  execute(
    db,
    `INSERT INTO run_artifacts (artifact_id, run_id, kind, digest, candidate_snapshot_digest,
                                content_json, produced_by, created_at)
     VALUES ('artifact_history', 'run_history', 'CANDIDATE_SNAPSHOT', 'sha256:artifact',
             'sha256:candidate', '{"candidateSnapshotDigest":"sha256:candidate"}', 'fixture', ?)`,
    [NOW],
  );
  // A pre-existing PR observation is the one receipt form permitted directly as APPLIED;
  // it still receives the immutable external-effect receipt guard after migration/restore.
  execute(
    db,
    `INSERT INTO github_receipts
       (receipt_id, idempotency_key, operation, repository_identity, resource_type,
        resource_identity, preexisting, request_digest, response_json, created_at)
     VALUES ('receipt_history', 'receipt-history-key', 'pr_prepare', 'github:acme/fixture',
             'pull_request', '42', 1, 'sha256:request', '{"number":42}', ?)`,
    [NOW],
  );
};

const history = (db: SqliteHandle) => ({
  runs: all(db, `SELECT run_id, state, goal, contract_digest, created_at FROM runs ORDER BY run_id`),
  artifacts: all(
    db,
    `SELECT artifact_id, run_id, kind, digest, candidate_snapshot_digest, content_json, produced_by, created_at
       FROM run_artifacts ORDER BY artifact_id`,
  ),
  receipts: all(
    db,
    `SELECT receipt_id, idempotency_key, operation, repository_identity, resource_identity,
            preexisting, request_digest, response_json, created_at, status
       FROM github_receipts ORDER BY receipt_id`,
  ),
});

/** Builds a v11 database from the checked-in prior-release SQL, never from current Db code. */
/**
 * A historical database file as the daemon would have left it: mode 0600.
 *
 * SQLite creates a new file at 0666 & ~umask, so a developer running under `umask 077` gets
 * 0600 by accident and CI under `umask 022` gets 0644 — and production correctly refuses to
 * open it. The mode is set explicitly here so the fixture means the same thing on both, and
 * so that the `0600` check being exercised is production's, not the shell's.
 */
const asPrivateStateFile = (path: string): void => {
  chmodSync(path, 0o600);
};

const asV11Fixture = (path: string, seed = false): ReturnType<typeof history> | undefined => {
  const raw = new Database(path);
  try {
    raw.exec(V11_SCHEMA);
    if (seed) {
      // The historical binary registered this connection-local producer marker before
      // inserting its own evidence. This fixture-only registration is never exposed by Db.
      raw.function("acp_evidence_write_authorized", () => 1);
      seedHistory(raw);
      raw.prepare(
        `INSERT INTO sessions
           (session_id, incarnation, provider, model, lifecycle, created_at, updated_at, stopped_at)
         VALUES ('session_history', 'inc-history', 'fixture', 'fixture', 'STOPPED', ?, ?, ?)`,
      ).run(NOW, NOW, NOW);
      raw.prepare(
        `INSERT INTO assignments
           (assignment_id, role_key, role, session_id, session_incarnation,
            binding_generation, mode, status, created_at, revoked_at, revoked_reason)
         VALUES ('assignment_history', 'CEO', 'CEO', 'session_history', 'inc-history',
                 1, 'PREFERRED', 'REVOKED', ?, ?, 'fixture retirement')`,
      ).run(NOW, NOW);
    }
    raw.pragma("user_version = 11");
    const result = seed ? history(raw) : undefined;
    raw.close();
    asPrivateStateFile(path);
    // #738 — a database at an older version does not migrate itself any more. A fixture that
    // means "this is what an older deployed build left behind" now has to say so the way the
    // owner does, so these tests exercise the approved path rather than a bypass of it.
    approveMigration(path, "database-migration-restore fixture");
    return result;
  } finally {
    try { raw.close(); } catch { /* already closed on the success path */ }
  }
};

/** Builds v14 directly from the pinned v11 fixture plus the explicit v13/v14 shape. */
const asV14Fixture = (path: string): void => {
  const raw = new Database(path);
  try {
    raw.exec(V11_SCHEMA);
    raw.exec(V14_FIXTURE_SHAPE);
    raw.exec(V14_LEDGER_DDL);
    // A real database at v14 reached it either by bootstrap from the full DDL or through the
    // v12 migration, whose replay carries every object available by then. Assembling this
    // fixture from V11_SCHEMA plus deltas skipped that replay, which made it unrepresentative
    // in exactly the way that matters here. Use the migration replay boundary, then drop the
    // v16 trigger so this remains a v14 database rather than a current one wearing v14.
    raw.exec(replayDdlWithoutPostV12Columns());
    for (const introducedAfterV14 of ["sessions_workdir_immutable"]) {
      raw.exec(`DROP TRIGGER IF EXISTS ${introducedAfterV14}`);
    }
    raw.function("acp_schema_migration_authorized", () => 1);
    const insertReceipt = raw.prepare(
      "INSERT INTO schema_migrations (version, migration_id, checksum, applied_at) VALUES (?, ?, ?, ?)",
    );
    insertReceipt.run(12, "v12-migration-ledger-and-invariant-replay", `sha256:${"1".repeat(64)}`, NOW);
    insertReceipt.run(13, "v13-finalization-state-machine", `sha256:${"2".repeat(64)}`, NOW);
    insertReceipt.run(14, "v14-baseline-evidence-ledger", `sha256:${"3".repeat(64)}`, NOW);
    raw.pragma("user_version = 14");
  } finally {
    raw.close();
    // Same reason as the v11 fixture: without an explicit mode this is 0600 under a 077
    // umask and 0644 under CI's 022, and production is right to refuse the second one.
    asPrivateStateFile(path);
  }
  approveMigration(path, "database-migration-restore fixture");
};

/** Builds the immediately previous release boundary without copying current migration internals. */
const asV33Fixture = (path: string): void => {
  const current = new Db(path);
  current.close();

  const raw = new Database(path);
  try {
    for (const column of ["target_bind_executor_runtime_identity", "target_bind_receipt_json"]) {
      const present = raw
        .prepare("SELECT 1 AS present FROM pragma_table_info('actor_target_attestations') WHERE name = ?")
        .get(column);
      if (present) raw.exec(`ALTER TABLE actor_target_attestations DROP COLUMN ${column}`);
    }
    raw.function("acp_schema_migration_authorized", () => 1);
    raw.exec("DROP TRIGGER schema_migrations_immutable; DROP TRIGGER schema_migrations_no_delete;");
    raw.exec("DELETE FROM schema_migrations");
    const v33 = MIGRATIONS.find((migration) => migration.toVersion === 33);
    if (!v33) throw new Error("v33 migration is absent from the ordered registry");
    raw.prepare(
      "INSERT INTO schema_migrations (version, migration_id, checksum, applied_at) VALUES (?, ?, ?, ?)",
    ).run(33, v33.id, v33.checksum(), NOW);
    installMigrationLedger(raw);
    raw.prepare(
      `INSERT INTO sessions (session_id, incarnation, provider, model, lifecycle, created_at, updated_at)
       VALUES ('v33-legacy-session', 'v33-legacy-incarnation', 'fixture', 'fixture', 'READY', ?, ?)`,
    ).run(NOW, NOW);
    raw.prepare(
      `INSERT INTO conversational_actors
         (actor_id, kind, current_session_id, current_session_incarnation, created_at)
       VALUES ('v33-legacy-actor', 'CEO', 'v33-legacy-session', 'v33-legacy-incarnation', ?)`,
    ).run(NOW);
    raw.prepare(
      `INSERT INTO actor_target_bindings
         (target_binding_id, target_actor_id, executor_kind, target_locator, target_locator_digest, bound_at)
       VALUES ('v33-legacy-target', 'v33-legacy-actor', 'hermes', 'target:v33', 'sha256:${"a".repeat(64)}', ?)`,
    ).run(NOW);
    raw.prepare(
      `INSERT INTO assignments
         (assignment_id, role_key, role, actor_id, session_id, session_incarnation,
          binding_generation, mode, status, created_at)
       VALUES ('v33-legacy-assignment', 'CEO', 'CEO', 'v33-legacy-actor', 'v33-legacy-session',
               'v33-legacy-incarnation', 1, 'PREFERRED', 'ACTIVE', ?)`,
    ).run(NOW);
    raw.prepare(
      `INSERT INTO actor_target_attestations
         (target_attestation_id, target_binding_id, protocol_version, attestation_digest,
          executor_session_id, executor_session_incarnation, binding_generation, assignment_id, attested_at)
       VALUES ('v33-legacy-attestation', 'v33-legacy-target', 'hermes.target-bind/v1', 'sha256:${"b".repeat(64)}',
               'v33-legacy-session', 'v33-legacy-incarnation', 1, 'v33-legacy-assignment', ?)`,
    ).run(NOW);
    raw.pragma("user_version = 33");
  } finally {
    raw.close();
    asPrivateStateFile(path);
  }
  approveMigration(path, "database-migration-restore fixture");
};

/**
 * A v34 database: current schema with #631's payload column and its trigger taken back off, an
 * admitted inbound row already in it, and the ledger wound back to 34.
 *
 * The row matters. v35 adds a nullable column with no backfill, and the question a rollback
 * boundary answers is what the snapshot holds if the upgrade is reversed — so the fixture has to
 * carry a row that existed before the column did.
 */
const V34_UNRESOLVED_TURN_CLAIM = JSON.stringify({
  deliveryStatus: "TURN_CLAIMED",
  turnRequestId: "turn:34-unresolved",
  sessionDigest: `sha256:${"c".repeat(64)}`,
  promptDigest: `sha256:${"d".repeat(64)}`,
  bindingDigest: `sha256:${"e".repeat(64)}`,
});

const asV34Fixture = (path: string, options: { unresolvedTurn?: boolean } = {}): void => {
  const current = new Db(path);
  current.close();

  const raw = new Database(path);
  try {
    raw.exec(`
      DROP TRIGGER IF EXISTS inbound_messages_payload_immutable;
      DROP TRIGGER IF EXISTS inbound_messages_no_replace;
    `);
    const present = raw
      .prepare("SELECT 1 AS present FROM pragma_table_info('inbound_messages') WHERE name = 'payload_json'")
      .get();
    if (present) raw.exec("ALTER TABLE inbound_messages DROP COLUMN payload_json");
    raw.function("acp_schema_migration_authorized", () => 1);
    raw.exec("DROP TRIGGER schema_migrations_immutable; DROP TRIGGER schema_migrations_no_delete;");
    raw.exec("DELETE FROM schema_migrations");
    const v34 = MIGRATIONS.find((migration) => migration.toVersion === 34);
    if (!v34) throw new Error("v34 migration is absent from the ordered registry");
    raw.prepare(
      "INSERT INTO schema_migrations (version, migration_id, checksum, applied_at) VALUES (?, ?, ?, ?)",
    ).run(34, v34.id, v34.checksum(), NOW);
    installMigrationLedger(raw);
    raw.prepare(
      `INSERT INTO inbound_messages (channel, nonce, actor, received_at, turn_claim_json)
       VALUES ('telegram', 'update:34', '424242', ?, ?)`,
    ).run(NOW, options.unresolvedTurn ? V34_UNRESOLVED_TURN_CLAIM : null);
    raw.pragma("user_version = 34");
  } finally {
    raw.close();
    asPrivateStateFile(path);
  }
  // #747 — this fixture represents an older deployed database; make the owner approval that
  // authorises its v34→v35 migration explicit, as every other pre-current fixture does.
  approveMigration(path, "database-migration-restore fixture");
};

const fileSha256 = (path: string): string =>
  `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;

const setManifestChecksum = (backupPath: string, databaseSha256: string): void => {
  const manifestPath = `${backupPath}.manifest.json`;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  manifest.databaseSha256 = databaseSha256;
  writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
};

const generatedBackupFiles = (databasePath: string): string[] =>
  readdirSync(defaultBackupDirectory(databasePath)).filter((entry) =>
    new RegExp(
      `^${basename(databasePath).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-(?:manual|pre-migration-v\\d+)-\\d+-[a-f0-9-]+\\.sqlite$`,
      "i",
    ).test(entry),
  );

const codeOf = (action: () => unknown): string => {
  try {
    action();
  } catch (error) {
    return isAcpError(error) ? error.reasonCode : String(error);
  }
  return "allowed";
};

const assertFourLoadBearingOperations = (db: Db): void => {
  expect(codeOf(() => db.run("UPDATE run_artifacts SET content_json = '{}'"))).toBe(ReasonCode.CONFLICT);
  expect(codeOf(() => db.run("DELETE FROM github_receipts"))).toBe(ReasonCode.CONFLICT);
  expect(codeOf(() => db.run("UPDATE runs SET state = 'CEO_APPROVED' WHERE run_id = 'run_history'"))).toBe(
    ReasonCode.RUN_STATE_TRANSITION_AUTHORITY_DENIED,
  );
  expect(
    codeOf(() =>
      db.run(
        `INSERT INTO tasks (task_id, run_id, title, category, state, spec_json, created_at, updated_at)
         VALUES ('task_after_seal', 'run_history', 'late task', 'test', 'PENDING', '{}', ?, ?)`,
        [NOW, NOW],
      ),
    ),
  ).toBe(ReasonCode.RUN_TRANSITION_ILLEGAL);
};

const assertEmptyActorRegistry = (db: Db): void => {
  expect(db.get<{ registry_id: number; registry_set_generation: number }>(
    `SELECT registry_id, registry_set_generation
       FROM conversational_actor_registry_state`,
  )).toEqual({ registry_id: 1, registry_set_generation: 0 });
  expect(db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM conversational_actor_registrations",
  )).toEqual({ n: 0 });
};

describe("versioned SQLite migration", () => {
  it("refuses a v34 unresolved turn before v35 can add an unrecoverable admitted-payload state", () => {
    const path = join(tempDir("acp-v34-unrecoverable-unresolved-turn-"), "state.sqlite");
    asV34Fixture(path, { unresolvedTurn: true });

    let originalRow: {
      channel: string;
      nonce: string;
      actor: string;
      received_at: string;
      result_json: string | null;
      turn_claim_hex: string;
    } | undefined;
    const before = new Database(path, { readonly: true, fileMustExist: true });
    try {
      expect(Number(before.pragma("user_version", { simple: true }))).toBe(34);
      expect(before.prepare(
        "SELECT 1 AS present FROM pragma_table_info('inbound_messages') WHERE name = 'payload_json'",
      ).get()).toBeUndefined();
      expect(before.prepare(
        `SELECT name FROM sqlite_master
          WHERE type = 'trigger'
            AND name IN ('inbound_messages_payload_immutable', 'inbound_messages_no_replace')
          ORDER BY name`,
      ).all()).toEqual([]);
      originalRow = before.prepare(
        `SELECT channel, nonce, actor, received_at, result_json, hex(turn_claim_json) AS turn_claim_hex
           FROM inbound_messages WHERE channel = 'telegram' AND nonce = 'update:34'`,
      ).get() as typeof originalRow;
      expect(originalRow).toMatchObject({
        channel: "telegram",
        nonce: "update:34",
        actor: "424242",
        received_at: NOW,
        result_json: null,
        turn_claim_hex: Buffer.from(V34_UNRESOLVED_TURN_CLAIM, "utf8").toString("hex").toUpperCase(),
      });
    } finally {
      before.close();
    }

    let migrationFailure: unknown;
    try {
      new Db(path);
    } catch (error) {
      migrationFailure = error;
    }
    expect(isAcpError(migrationFailure)).toBe(true);
    if (!isAcpError(migrationFailure)) throw new Error("v35 unexpectedly opened the unrecoverable v34 fixture");
    expect(migrationFailure).toMatchObject({
      reasonCode: ReasonCode.INTERNAL_ERROR,
      message: "migration failed; the original database was restored from its automatic backup",
      evidence: expect.objectContaining({
        fromVersion: 34,
        migrationError: "v35 cannot migrate unresolved inbound messages without their admitted payload",
      }),
    });

    const after = new Database(path, { readonly: true, fileMustExist: true });
    try {
      expect(Number(after.pragma("user_version", { simple: true }))).toBe(34);
      expect(after.prepare(
        "SELECT 1 AS present FROM pragma_table_info('inbound_messages') WHERE name = 'payload_json'",
      ).get()).toBeUndefined();
      expect(after.prepare(
        `SELECT name FROM sqlite_master
          WHERE type = 'trigger'
            AND name IN ('inbound_messages_payload_immutable', 'inbound_messages_no_replace')
          ORDER BY name`,
      ).all()).toEqual([]);
      expect(after.prepare(
        `SELECT channel, nonce, actor, received_at, result_json, hex(turn_claim_json) AS turn_claim_hex
           FROM inbound_messages WHERE channel = 'telegram' AND nonce = 'update:34'`,
      ).get()).toEqual(originalRow);
    } finally {
      after.close();
    }
  });

  it("opening a v34 database takes an automatic rollback snapshot before v35 admitted-payload state", () => {
    const path = join(tempDir("acp-v34-admitted-payload-boundary-"), "state.sqlite");
    asV34Fixture(path);

    const migrated = new Db(path);
    let backupPath: string;
    try {
      expect(Number(migrated.raw.pragma("user_version", { simple: true }))).toBe(SCHEMA_VERSION);
      const receipt = migrated.get<{
        migration_id: string;
        backup_file: string | null;
        backup_checksum: string | null;
      }>(
        `SELECT migration_id, backup_file, backup_checksum
           FROM schema_migrations WHERE version = 35`,
      );
      expect(receipt).toMatchObject({
        migration_id: "v35-keep-the-admitted-payload-with-its-inbound-row",
        backup_file: expect.stringContaining("-pre-migration-v34-"),
        backup_checksum: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      });
      if (!receipt?.backup_file) throw new Error("v35 receipt did not name its automatic backup");
      backupPath = receipt.backup_file;
      expect(existsSync(backupPath)).toBe(true);

      // No backfill, deliberately: a row admitted before the column existed has no copy of its
      // message anywhere, and writing a placeholder would turn "we never kept this" into a value
      // a later reader takes for the message.
      expect(migrated.get<{ payload_json: string | null }>(
        "SELECT payload_json FROM inbound_messages WHERE channel = 'telegram' AND nonce = 'update:34'",
      )).toEqual({ payload_json: null });

      // And the column arrives with its write-once rule already on it. A migration that added the
      // column and left the trigger to schema.sql would leave every upgraded deployment — as
      // opposed to every fresh one — with a payload any UPDATE could reach.
      expect(() => migrated.run(
        "UPDATE inbound_messages SET payload_json = 'forged' WHERE nonce = 'update:34'",
      )).toThrow(/INBOUND_PAYLOAD_IMMUTABLE/);
    } finally {
      migrated.close();
    }

    const rollbackSnapshot = new Database(backupPath, { readonly: true, fileMustExist: true });
    try {
      expect(Number(rollbackSnapshot.pragma("user_version", { simple: true }))).toBe(34);
      expect(rollbackSnapshot.prepare(
        "SELECT 1 AS present FROM pragma_table_info('inbound_messages') WHERE name = 'payload_json'",
      ).get()).toBeUndefined();
    } finally {
      rollbackSnapshot.close();
    }
  });

  it("opening a v33 database takes an automatic rollback snapshot before v34 target-bind receipt state", () => {
    const path = join(tempDir("acp-v33-hermes-receipt-boundary-"), "state.sqlite");
    asV33Fixture(path);

    const migrated = new Db(path);
    let backupPath: string;
    try {
      expect(Number(migrated.raw.pragma("user_version", { simple: true }))).toBe(SCHEMA_VERSION);
      const receipt = migrated.get<{
        migration_id: string;
        backup_file: string | null;
        backup_checksum: string | null;
      }>(
        `SELECT migration_id, backup_file, backup_checksum
           FROM schema_migrations WHERE version = 34`,
      );
      expect(receipt).toMatchObject({
        migration_id: "v34-persist-hermes-target-bind-receipt-evidence",
        backup_file: expect.stringContaining("-pre-migration-v33-"),
        backup_checksum: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      });
      if (!receipt?.backup_file) throw new Error("v34 receipt did not name its automatic backup");
      backupPath = receipt.backup_file;
      expect(existsSync(backupPath)).toBe(true);
      expect(migrated.get<{
        target_bind_receipt_json: string | null;
        target_bind_executor_runtime_identity: string | null;
      }>(
        `SELECT target_bind_receipt_json, target_bind_executor_runtime_identity
           FROM actor_target_attestations WHERE target_attestation_id = 'v33-legacy-attestation'`,
      )).toEqual({
        target_bind_receipt_json: null,
        target_bind_executor_runtime_identity: null,
      });
      expect(migrated.get(
        "SELECT 1 AS present FROM pragma_table_info('actor_target_attestations') WHERE name = 'target_bind_executor_runtime_identity'",
      )).toEqual({ present: 1 });
    } finally {
      migrated.close();
    }

    const rollbackSnapshot = new Database(backupPath, { readonly: true, fileMustExist: true });
    try {
      expect(Number(rollbackSnapshot.pragma("user_version", { simple: true }))).toBe(33);
      expect(rollbackSnapshot.prepare(
        "SELECT version, migration_id FROM schema_migrations ORDER BY version DESC LIMIT 1",
      ).get()).toEqual({
        version: 33,
        migration_id: "v33-back-up-before-telegram-settlement-state",
      });
      expect(rollbackSnapshot.prepare(
        "SELECT 1 AS present FROM pragma_table_info('actor_target_attestations') WHERE name = 'target_bind_receipt_json'",
      ).get()).toBeUndefined();
      expect(rollbackSnapshot.prepare(
        "SELECT 1 AS present FROM pragma_table_info('actor_target_attestations') WHERE name = 'target_bind_executor_runtime_identity'",
      ).get()).toBeUndefined();
    } finally {
      rollbackSnapshot.close();
    }

    const restored = restoreDatabase(path, backupPath);
    expect(restored.restoredFrom).toBe(backupPath);
    const restoredRollbackBoundary = new Database(path, { readonly: true, fileMustExist: true });
    try {
      expect(Number(restoredRollbackBoundary.pragma("user_version", { simple: true }))).toBe(33);
      expect(restoredRollbackBoundary.prepare(
        "SELECT 1 AS present FROM pragma_table_info('actor_target_attestations') WHERE name = 'target_bind_receipt_json'",
      ).get()).toBeUndefined();
      expect(restoredRollbackBoundary.prepare(
        "SELECT 1 AS present FROM pragma_table_info('actor_target_attestations') WHERE name = 'target_bind_executor_runtime_identity'",
      ).get()).toBeUndefined();
    } finally {
      restoredRollbackBoundary.close();
    }

    const fresh = new Db(join(tempDir("acp-v34-fresh-hermes-receipt-"), "state.sqlite"));
    try {
      expect(fresh.get(
        "SELECT 1 AS present FROM pragma_table_info('actor_target_attestations') WHERE name = 'target_bind_executor_runtime_identity'",
      )).toEqual({ present: 1 });
    } finally {
      fresh.close();
    }
  });

  it("upgrades a genuine v14 fixture through the whole chain and enforces workdir immutability", () => {
    const path = join(tempDir("acp-v14-migration-"), "state.sqlite");
    asV14Fixture(path);

    const before = new Database(path, { readonly: true, fileMustExist: true });
    try {
      expect(Number(before.pragma("user_version", { simple: true }))).toBe(14);
      expect(
        (before
          .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name = 'sessions_workdir_immutable'")
          .get() as { n: number }).n,
      ).toBe(0);
      expect(
        before.prepare(
          `SELECT name FROM sqlite_master
            WHERE type = 'table'
              AND name IN ('conversational_actor_registry_state', 'conversational_actor_registrations')`,
        ).all(),
      ).toEqual([]);
    } finally {
      before.close();
    }

    const migrated = new Db(path);
    try {
      // The fixture must walk the whole ordered chain through v20, not stop at the version
      // the original workdir lane was written on.
      expect(Number(migrated.raw.pragma("user_version", { simple: true }))).toBe(SCHEMA_VERSION);
      // The chain reaches the declared version and nothing is left beyond it. This used to be
      // `toBe(20)`, which restated the constant and so failed on every correct addition while
      // catching nothing a wrong one would do. What can actually go wrong is a migration added
      // without bumping SCHEMA_VERSION, or a gap in `fromVersion`/`toVersion` — the line above
      // passes in both cases, and these do not.
      expect(SCHEMA_VERSION).toBe(Math.max(...MIGRATIONS.map((m) => m.toVersion)));
      expect(MIGRATIONS.map((m) => m.fromVersion)).toEqual(MIGRATIONS.map((m) => m.toVersion - 1));
      assertEmptyActorRegistry(migrated);
      migrated.run(
        `INSERT INTO sessions (session_id, incarnation, provider, model, lifecycle, workdir, created_at, updated_at)
         VALUES ('v14-workdir-session', 'inc-1', 'fixture', 'fixture', 'READY', ?, ?, ?)`,
        ["/managed/runtime", NOW, NOW],
      );
      expect(() => migrated.run(
        `UPDATE sessions SET workdir = ? WHERE session_id = 'v14-workdir-session'`,
        ["/attacker/rewritten"],
      )).toThrowError(/SESSION_WORKDIR_IMMUTABLE/);
    } finally {
      migrated.close();
    }

    // A same-version open validates the v20 guards and singleton; it does not replay or
    // mutate the registration history.
    const reopened = new Db(path);
    try {
      assertEmptyActorRegistry(reopened);
    } finally {
      reopened.close();
    }

    const raw = new Database(path);
    raw.exec("DROP TRIGGER sessions_workdir_immutable");
    raw.close();
    expect(() => new Db(path)).toThrowError(/missing a load-bearing schema invariant/);
  });

  it("migrates a v11 fixture in order, records its backup receipt, and re-establishes load-bearing guards", async () => {
    const path = join(tempDir("acp-v11-migration-"), "state.sqlite");
    const before = asV11Fixture(path, true);
    if (!before) throw new Error("v11 fixture history was not seeded");

    const migrated = new Db(path);
    try {
      expect(Number(migrated.raw.pragma("user_version", { simple: true }))).toBe(SCHEMA_VERSION);
      expect(history(migrated)).toEqual(before);
      const receipts = migrated.all<{
        version: number;
        migration_id: string;
        checksum: string;
        backup_file: string | null;
        backup_checksum: string | null;
      }>(
        `SELECT version, migration_id, checksum, backup_file, backup_checksum
           FROM schema_migrations ORDER BY version`,
      );
      expect(receipts.map((entry) => [entry.version, entry.migration_id])).toEqual([
        [12, "v12-migration-ledger-and-invariant-replay"],
        [13, "v13-finalization-state-machine"],
        [14, "v14-baseline-evidence-ledger"],
        [15, "v15-durable-verification-worktree-ownership"],
        [16, "v16-session-workdir-immutability"],
        [17, "v17-telegram-owner-prompts"],
        [18, "v18-conversational-actor"],
        [19, "v19-session-process-identity"],
        [20, "v20-conversational-actor-registry"],
        [21, "v21-canonical-turns"],
        [22, "v22-canonical-turn-ledger"],
        [23, "v23-turn-claimed-at"],
        [24, "v24-observation-ledger"],
        [25, "v25-ledger-guards"],
        [26, "v26-ledger-trigger-bodies"],
        [27, "v27-an-observation-carries-its-evidence"],
        [28, "v28-an-operator-can-settle-a-turn-nobody-observed"],
        [29, "v29-a-dispatch-is-a-fact"],
        [30, "v30-a-turn-and-a-reply-are-two-lifecycles"],
        [31, "v31-a-generation-means-nothing-without-its-role-key"],
        [32, "v32-a-source-can-only-cite-its-turns-own-claim-event"],
        [33, "v33-back-up-before-telegram-settlement-state"],
        [34, "v34-persist-hermes-target-bind-receipt-evidence"],
        [SCHEMA_VERSION, "v35-keep-the-admitted-payload-with-its-inbound-row"],
      ]);
      // Stated as properties rather than one `objectContaining` per version. The list above
      // already pins the exact order and ids; this block only ever said "every receipt carries a
      // checksum, and only the first carries a backup" — and as an enumeration it needed a new
      // entry for every migration, so it failed on correct additions while catching nothing a
      // wrong one would do.
      expect(receipts.every((entry) => /^sha256:[a-f0-9]{64}$/.test(entry.checksum))).toBe(true);
      // The first migration in the chain takes the automatic backup; the rest run inside it.
      expect(receipts[0]).toMatchObject({ version: 12 });
      expect(receipts[0]?.backup_checksum).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(
        receipts.slice(1).every((e) => e.backup_file === null && e.backup_checksum === null),
      ).toBe(true);
      expect(receipts[0]?.backup_file).toBeTruthy();
      expect(existsSync(receipts[0]!.backup_file!)).toBe(true);
      expect(migrated.get<{
        assignment_actor_id: string;
        actor_id: string;
        kind: string;
        retired_reason: string | null;
      }>(
        `SELECT a.actor_id AS assignment_actor_id, c.actor_id, c.kind, c.retired_reason
           FROM assignments a
           JOIN conversational_actors c ON c.actor_id = a.actor_id
          WHERE a.assignment_id = 'assignment_history'`,
      )).toEqual({
        assignment_actor_id: "actor:assignment_history",
        actor_id: "actor:assignment_history",
        kind: "CEO",
        retired_reason: "fixture retirement",
      });
      assertEmptyActorRegistry(migrated);

      // Four database-level guard rails are exercised after the actual migration, not on a
      // fresh test database. Removing any required trigger makes one negative operation pass.
      assertFourLoadBearingOperations(migrated);

      // v16 is proven by the negative operation it was introduced to enforce, not only by
      // its receipt: a recorded provider workdir cannot be rewritten after migration.
      migrated.run(
        `INSERT INTO sessions (session_id, incarnation, provider, model, lifecycle, workdir, created_at, updated_at)
         VALUES ('migrated-workdir-session', 'inc-1', 'fixture', 'fixture', 'READY', ?, ?, ?)`,
        ["/managed/runtime", NOW, NOW],
      );
      expect(() => migrated.run(
        `UPDATE sessions SET workdir = ? WHERE session_id = 'migrated-workdir-session'`,
        ["/attacker/rewritten"],
      )).toThrowError(/SESSION_WORKDIR_IMMUTABLE/);
    } finally {
      migrated.close();
    }

    // This is the production composition path after the migration, with only the model
    // adapter replaced by a deterministic test provider so the host's CLIs are irrelevant.
    const controlPlane = new ControlPlane({
      ...defaultConfig(join(path, "..")),
      adapters: [new TestProductionAdapter(systemClock)],
      allowTestEvidenceWriters: true,
    });
    const daemon = new Daemon(controlPlane, { stateDir: join(path, "..") });
    let daemonRunning = false;
    try {
      controlPlane.credentials.install({ token: "migration-test-token", creatorIdentity: "fixture" });
      const started = await daemon.start();
      daemonRunning = started.allowed;
      expect(started.allowed).toBe(true);
      if (started.allowed) {
        expect(controlPlane.audit.record({
          kind: "MIGRATED_DATABASE_OPERATION",
          evidence: { source: "v11-fixture" },
        }).allowed).toBe(true);
        expect(controlPlane.audit.byKind("MIGRATED_DATABASE_OPERATION")).toHaveLength(1);
      }
    } finally {
      if (daemonRunning) await daemon.stop();
      controlPlane.close();
    }
  });

  it("gives a v11 database every REPLACE guard the current schema declares", () => {
    // The oldest supported database has to arrive at the current schema with every guard the
    // current schema declares. Twenty `no_replace` triggers were added at v26, and v12 replays the
    // *live* schema.sql minus an exclusion list — so a v11 database meets them twice, from two
    // migrations written apart, and the only way to know what it ends up with is to run the chain
    // and count.
    //
    // What it catches, established by trying each way of breaking it rather than by argument:
    //
    //   excluded from v12's replay        -> still passes, v26 creates it
    //   added to schema.sql and nothing else -> still passes, v12's replay creates it
    //   excluded from replay AND named by no migration -> FAILS
    //
    // So the property is "a guard reaches the oldest supported database by *some* route", and the
    // shape it refuses is one that fell out of both. Two overlapping mechanisms mean neither is
    // load-bearing alone, which is worth knowing: a reader could delete either and this stays
    // green.
    const path = join(tempDir("acp-v11-no-replace-"), "state.sqlite");
    asV11Fixture(path);
    const db = new Db(path);
    try {
      const declared = schemaSql().match(/CREATE TRIGGER IF NOT EXISTS \w+_no_replace/g) ?? [];
      const present = db
        .all<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE '%\\_no\\_replace' ESCAPE '\\'",
        )
        .map((row) => row.name);

      expect(present).toHaveLength(declared.length);
    } finally {
      db.close();
    }
  });

  it("replays the four guards when a pinned v11 file reaches upgrade with them missing", () => {
    const path = join(tempDir("acp-v11-invariant-replay-"), "state.sqlite");
    asV11Fixture(path, true);
    const raw = new Database(path);
    try {
      raw.exec("DROP TRIGGER runs_state_transition_authority_guard");
      raw.exec("DROP TRIGGER tasks_run_work_sealed");
      raw.exec("DROP TRIGGER run_artifacts_content_immutable");
      raw.exec("DROP TRIGGER github_receipts_no_delete");
    } finally {
      raw.close();
    }

    const migrated = new Db(path);
    try {
      assertFourLoadBearingOperations(migrated);
    } finally {
      migrated.close();
    }
  });

  it("refuses a same-version database whose invariant was deleted instead of repairing it silently", () => {
    const path = join(tempDir("acp-current-invariant-"), "state.sqlite");
    const created = new Db(path);
    created.close();
    const raw = new Database(path);
    try {
      raw.exec("DROP TRIGGER github_receipts_no_delete");
    } finally {
      raw.close();
    }

    expect(() => new Db(path)).toThrowError(/missing a load-bearing schema invariant/);
  });

  it("refuses a same-version database with either Telegram owner prompt immutability trigger deleted", () => {
    for (const trigger of ["telegram_owner_prompts_immutable", "telegram_owner_prompts_no_delete"]) {
      const path = join(tempDir(`acp-current-${trigger}-`), "state.sqlite");
      const created = new Db(path);
      created.close();
      const raw = new Database(path);
      try {
        raw.exec(`DROP TRIGGER ${trigger}`);
      } finally {
        raw.close();
      }

      expect(() => {
        const reopened = new Db(path);
        reopened.close();
      }).toThrowError(/missing a load-bearing schema invariant/);
    }
  });

  it("restores the original v11 database when a fault is injected after a migration commits", () => {
    const path = join(tempDir("acp-migration-failure-"), "state.sqlite");
    const before = asV11Fixture(path, true);
    if (!before) throw new Error("v11 fixture history was not seeded");

    expect(
      () =>
        new Db(path, {
          afterMigration: () => {
            throw new Error("injected post-commit failure");
          },
        }),
    ).toThrowError(/original database was restored/);

    const raw = new Database(path, { readonly: true, fileMustExist: true });
    try {
      expect(Number(raw.pragma("user_version", { simple: true }))).toBe(11);
    } finally {
      raw.close();
    }
    // #747 — the rollback links a staged image into place, so the restored database is a new
    // inode and the approval that authorised the failed attempt no longer names it. Retrying
    // therefore needs a fresh decision, which is the right contract: a chain that failed partway
    // is exactly when a restart must not silently try again. Before this, the surviving approval
    // re-armed the same failing migration for the supervisor's next restart, every 30 seconds.
    expect(() => new Db(path)).toThrowError(/for a different database than the one being opened/);
    approveMigration(path, "database-migration-restore fixture");
    const recovered = new Db(path);
    try {
      expect(history(recovered)).toEqual(before);
    } finally {
      recovered.close();
    }
  });

  it("restores a pinned v11 image whose missing guard was repaired before a later migration failure", () => {
    const path = join(tempDir("acp-migration-repair-failure-"), "state.sqlite");
    const before = asV11Fixture(path, true);
    if (!before) throw new Error("v11 fixture history was not seeded");
    const raw = new Database(path);
    raw.exec("DROP TRIGGER github_receipts_no_delete");
    raw.close();

    expect(
      () =>
        new Db(path, {
          afterMigration: () => {
            throw new Error("injected failure after invariant replay committed");
          },
        }),
    ).toThrowError(/original database was restored/);

    const restored = new Database(path, { readonly: true, fileMustExist: true });
    try {
      expect(Number(restored.pragma("user_version", { simple: true }))).toBe(11);
      expect(
        restored
          .prepare(
            "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name = 'github_receipts_no_delete'",
          )
          .get(),
      ).toEqual({ n: 0 });
      expect(history(restored)).toEqual(before);
    } finally {
      restored.close();
    }
  });
});

describe("backup and restore drill", () => {
  it("backs up, loses the database, restores identical history and receipts, and retains immutability", async () => {
    const path = join(tempDir("acp-restore-drill-"), "state.sqlite");
    const source = new Db(path);
    seedHistory(source);
    const before = history(source);
    const backup = await source.backup();
    source.close();

    expect(lstatSync(backup.path).mode & 0o777).toBe(0o600);
    expect(lstatSync(backup.manifestPath).mode & 0o777).toBe(0o600);
    unlinkSync(path); // corrupt-or-delete leg of the restore drill

    const restored = restoreDatabase(path, backup.path);
    expect(restored.preservedDatabasePath).toBeNull();
    const recovered = new Db(path);
    try {
      expect(history(recovered)).toEqual(before);
      expect(codeOf(() => recovered.run("UPDATE run_artifacts SET content_json = '{}'"))).toBe(
        ReasonCode.CONFLICT,
      );
      expect(codeOf(() => recovered.run("DELETE FROM github_receipts"))).toBe(ReasonCode.CONFLICT);
    } finally {
      recovered.close();
    }
  });

  it("restore keeps the live database readable until atomic replacement", async () => {
    const path = join(tempDir("acp-restore-crash-"), "state.sqlite");
    const source = new Db(path);
    seedHistory(source);
    const backup = await source.backup();
    source.run(
      `INSERT INTO runs (run_id, kind, execution_mode, priority, state, goal, contract_digest, created_at)
       VALUES ('run_after_backup', 'STANDARD_WORK', 'STANDARD', 'NORMAL', 'QUEUED',
               'must remain before replacement', 'sha256:after-backup', ?)`,
      [NOW],
    );
    source.close();

    const backupModule = new URL("../../src/db/backup.ts", import.meta.url).href;
    const child = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        `const { restoreDatabase } = await import(${JSON.stringify(backupModule)});
         restoreDatabase(${JSON.stringify(path)}, ${JSON.stringify(backup.path)}, {
           afterPreservingExisting: () => process.kill(process.pid, "SIGKILL"),
         });`,
      ],
      { encoding: "utf8" },
    );

    expect(child.signal).toBe("SIGKILL");
    expect(existsSync(path)).toBe(true);
    const survived = new Database(path, { readonly: true, fileMustExist: true });
    try {
      expect(survived.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(
        survived.prepare("SELECT COUNT(*) AS n FROM runs WHERE run_id = 'run_after_backup'").get(),
      ).toEqual({ n: 1 });
    } finally {
      survived.close();
    }
  });

  it("restore copies the original database and sidecars before checkpointing the live database", async () => {
    const path = join(tempDir("acp-restore-wal-crash-"), "state.sqlite");
    const source = new Db(path);
    seedHistory(source);
    const backup = await source.backup();
    source.close();

    const databaseModule = new URL("../../src/db/database.ts", import.meta.url).href;
    const writer = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        `const { Db } = await import(${JSON.stringify(databaseModule)});
         const source = new Db(${JSON.stringify(path)});
         source.run(
           \`INSERT INTO runs (run_id, kind, execution_mode, priority, state, goal, contract_digest, created_at)
             VALUES ('run_in_wal_before_restore', 'STANDARD_WORK', 'STANDARD', 'NORMAL', 'QUEUED',
                     'must survive in the forensic WAL', 'sha256:forensic-wal', ?)\`,
           [${JSON.stringify(NOW)}],
         );
         process.kill(process.pid, "SIGKILL");`,
      ],
      { encoding: "utf8" },
    );
    expect(writer.signal).toBe("SIGKILL");

    const originalDatabase = readFileSync(path);
    const originalSidecars = new Map(
      ["-wal", "-shm", "-journal"]
        .filter((suffix) => existsSync(`${path}${suffix}`))
        .map((suffix) => [suffix, readFileSync(`${path}${suffix}`)]),
    );
    expect(originalSidecars.has("-wal")).toBe(true);

    const backupModule = new URL("../../src/db/backup.ts", import.meta.url).href;
    const restore = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        `const { restoreDatabase } = await import(${JSON.stringify(backupModule)});
         restoreDatabase(${JSON.stringify(path)}, ${JSON.stringify(backup.path)}, {
           afterPreservingExisting: () => process.kill(process.pid, "SIGKILL"),
         });`,
      ],
      { encoding: "utf8" },
    );
    expect(restore.signal).toBe("SIGKILL");

    const preservedDatabaseNames = readdirSync(defaultBackupDirectory(path)).filter(
      (entry) => entry.startsWith(`${basename(path)}-pre-restore-`) && entry.endsWith(".sqlite"),
    );
    expect(preservedDatabaseNames).toHaveLength(1);
    const preservedDatabasePath = join(defaultBackupDirectory(path), preservedDatabaseNames[0]!);
    expect(readFileSync(preservedDatabasePath)).toEqual(originalDatabase);
    for (const [suffix, bytes] of originalSidecars) {
      expect(readFileSync(`${preservedDatabasePath}${suffix}`)).toEqual(bytes);
    }

    const forensic = new Database(preservedDatabasePath, { readonly: true, fileMustExist: true });
    try {
      expect(forensic.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(
        forensic.prepare("SELECT COUNT(*) AS n FROM runs WHERE run_id = 'run_in_wal_before_restore'").get(),
      ).toEqual({ n: 1 });
    } finally {
      forensic.close();
    }

    const survived = new Database(path, { readonly: true, fileMustExist: true });
    try {
      expect(survived.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(
        survived.prepare("SELECT COUNT(*) AS n FROM runs WHERE run_id = 'run_in_wal_before_restore'").get(),
      ).toEqual({ n: 1 });
    } finally {
      survived.close();
    }
  });

  it("refuses a permissive backup rather than treating it as trusted restore input", async () => {
    const root = tempDir("acp-restore-permissions-");
    const path = join(root, "state.sqlite");
    const source = new Db(path);
    const backup = await source.backup();
    source.close();
    chmodSync(backup.path, 0o644);

    expect(codeOf(() => restoreDatabase(path, backup.path))).toBe(ReasonCode.STATE_PATH_INSECURE);
  });

  it("refuses a physically corrupted backup even when its manifest is updated", async () => {
    const root = tempDir("acp-restore-integrity-");
    const path = join(root, "state.sqlite");
    const source = new Db(path);
    seedHistory(source);
    const backup = await source.backup();
    source.close();

    const raw = new Database(backup.path, { readonly: true, fileMustExist: true });
    const pageSize = Number(raw.pragma("page_size", { simple: true }));
    const rootPage = (raw.prepare("SELECT rootpage FROM sqlite_master WHERE name = ?").get("runs") as { rootpage: number }).rootpage;
    raw.close();

    const bytes = readFileSync(backup.path);
    const pageOffset = (rootPage - 1) * pageSize;
    expect(bytes[pageOffset]).toBe(0x0d);
    bytes[pageOffset] = 0;
    writeFileSync(backup.path, bytes);
    setManifestChecksum(backup.path, fileSha256(backup.path));

    expect(() => restoreDatabase(path, backup.path)).toThrowError(/SQLite integrity check failed/);
  });

  it("refuses a backup whose manifest checksum was tampered", async () => {
    const root = tempDir("acp-restore-checksum-");
    const path = join(root, "state.sqlite");
    const source = new Db(path);
    const backup = await source.backup();
    source.close();
    setManifestChecksum(backup.path, `sha256:${"0".repeat(64)}`);

    expect(() => restoreDatabase(path, backup.path)).toThrowError(/backup checksum does not match its manifest/);
  });

  it("refuses a backup whose load-bearing trigger was deleted", async () => {
    const root = tempDir("acp-restore-invariant-");
    const path = join(root, "state.sqlite");
    const source = new Db(path);
    const backup = await source.backup();
    source.close();

    const raw = new Database(backup.path);
    raw.pragma("journal_mode = DELETE");
    raw.exec("DROP TRIGGER run_artifacts_content_immutable");
    raw.close();
    setManifestChecksum(backup.path, fileSha256(backup.path));

    expect(() => restoreDatabase(path, backup.path)).toThrowError(/missing a load-bearing schema invariant/);
  });

  it("retains bounded automatic and manual backups without deleting an operator-named output", async () => {
    const root = tempDir("acp-backup-retention-");
    const path = join(root, "state.sqlite");
    asV11Fixture(path);
    const migrated = new Db(path, { backupRetention: 1 });
    try {
      // Opening the pinned v11 file creates the automatic pre-migration snapshot.
      const automatic = generatedBackupFiles(path);
      expect(automatic).toHaveLength(1);
      expect(automatic[0]).toContain("-pre-migration-v11-");

      const operatorPath = join(defaultBackupDirectory(path), "operator-named.sqlite");
      await migrated.backup(operatorPath);
      await migrated.backup();
      await migrated.backup();
      const generated = generatedBackupFiles(path);
      expect(generated).toHaveLength(1);
      expect(existsSync(operatorPath)).toBe(true);
      expect(existsSync(`${operatorPath}.manifest.json`)).toBe(true);
    } finally {
      migrated.close();
    }
  });
});

describe("fresh database recovery verifier", () => {
  it("migrates pinned v11 and restores it after the injected post-v12 failure", () => {
    const script = fileURLToPath(new URL("../../scripts/verify-fresh-database.ts", import.meta.url));
    const result = spawnSync(process.execPath, ["--import", "tsx", script, "--json"], {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      encoding: "utf8",
    });
    const report = JSON.parse(result.stdout) as {
      observed: Record<string, { ok?: boolean }>;
      problems: string[];
    };

    expect(report.observed["olderVersion"]).toEqual({ ok: true });
    expect(report.observed["migrationRestore"]).toEqual({ ok: true });
    expect(report.problems).toEqual([]);
    expect(result.status, result.stderr).toBe(0);
  });
});
