import Database from "better-sqlite3";
import { createHash } from "node:crypto";
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
    }
    raw.pragma("user_version = 11");
    const result = seed ? history(raw) : undefined;
    raw.close();
    asPrivateStateFile(path);
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

describe("versioned SQLite migration", () => {
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
    } finally {
      before.close();
    }

    const migrated = new Db(path);
    try {
      // v14 → v15 (verification worktree ownership) → v16 (workdir immutability): the
      // fixture must walk the whole chain, not stop at the version this lane was written on.
      expect(Number(migrated.raw.pragma("user_version", { simple: true }))).toBe(SCHEMA_VERSION);
      expect(SCHEMA_VERSION).toBe(16);
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
        [SCHEMA_VERSION, "v16-session-workdir-immutability"],
      ]);
      expect(receipts).toEqual([
        expect.objectContaining({
          version: 12,
          checksum: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
          backup_checksum: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        }),
        expect.objectContaining({
          version: 13,
          checksum: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
          backup_file: null,
          backup_checksum: null,
        }),
        expect.objectContaining({
          version: 14,
          checksum: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
          backup_file: null,
          backup_checksum: null,
        }),
        expect.objectContaining({
          version: 15,
          checksum: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
          backup_file: null,
          backup_checksum: null,
        }),
        expect.objectContaining({
          version: SCHEMA_VERSION,
          checksum: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
          backup_file: null,
          backup_checksum: null,
        }),
      ]);
      expect(receipts[0]?.backup_file).toBeTruthy();
      expect(existsSync(receipts[0]!.backup_file!)).toBe(true);

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
    const recovered = new Db(path);
    try {
      expect(history(recovered)).toEqual(before);
    } finally {
      recovered.close();
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
