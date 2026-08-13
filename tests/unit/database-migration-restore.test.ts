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
    return seed ? history(raw) : undefined;
  } finally {
    raw.close();
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
        [SCHEMA_VERSION, "v13-finalization-state-machine"],
      ]);
      expect(receipts).toEqual([
        expect.objectContaining({
          version: 12,
          checksum: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
          backup_checksum: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
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
