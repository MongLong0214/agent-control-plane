import Database from "better-sqlite3";
import { chmodSync } from "node:fs";

import { installMigrationLedger } from "../../src/db/migrations.ts";

/**
 * #1094 (v46) — fixtures for the v45 → v46 step.
 *
 * A v45 image is taken back from a database written at v46 by removing exactly what v46 adds, its nine
 * rowid guards, the way the v40–v45 fixtures build theirs. v46 adds no table, column or index and
 * replaces no body, so every other object and every row is what the v46 code wrote.
 */

/** The nine triggers v46 adds, named here rather than read from the code under test. */
export const V46_ADDED_TRIGGERS = [
  "outbox_no_rowid_replace",
  "outbox_rowid_immutable",
  "outbox_rowid_positive",
  "inbound_messages_no_rowid_replace",
  "inbound_messages_rowid_immutable",
  "inbound_messages_rowid_positive",
  "canonical_turns_no_rowid_replace",
  "canonical_turns_rowid_immutable",
  "canonical_turns_rowid_positive",
];

/** The v45 build these fixtures are compared against: v45's squash merge on main (#1136), which v46 follows. */
export const V45_BUILD_COMMIT = "65367eead17523e98d874e79e5f35c177096086e";

/**
 * `digestOfSchemaRows(schemaRowsOf(path))` of a fresh database written by the v45 build at
 * `V45_BUILD_COMMIT`. Measured on that build, not recomputed from this one, so an image taken back
 * here is compared with what v45 actually wrote.
 */
export const V45_SCHEMA_DIGEST = "sha256:992a12b35a87f555b30aac31767a2a04eedf0881c49bc45b31510fe1bad68d60";

/** Removes v46's triggers on an open raw connection. `IF EXISTS`, so an older build's database is a no-op. */
export const dropV46Triggers = (raw: Database.Database): void => {
  raw.exec(V46_ADDED_TRIGGERS.map((name) => `DROP TRIGGER IF EXISTS ${name};`).join("\n"));
};

/** Turns the database at `path`, written at v46, into a v45 image in place. Not approved. */
export const toV45Image = (path: string): string => {
  const legacy = new Database(path);
  try {
    dropV46Triggers(legacy);
    legacy.exec(`
      DROP TRIGGER schema_migrations_no_delete;
      DROP TRIGGER schema_migrations_insert_authority;
      DELETE FROM schema_migrations WHERE version > 45;
      INSERT OR IGNORE INTO schema_migrations (version, migration_id, checksum, applied_at)
        VALUES (45, 'bootstrap-v45', 'sha256:${"0".repeat(64)}', '2026-10-18T00:00:00.000Z');
      PRAGMA user_version = 45;
    `);
    installMigrationLedger(legacy);
  } finally {
    legacy.close();
  }
  chmodSync(path, 0o600);
  return path;
};
