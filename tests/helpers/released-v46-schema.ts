import Database from "better-sqlite3";
import { chmodSync, readFileSync } from "node:fs";

import { installMigrationLedger } from "../../src/db/migrations.ts";
import { dropV47Triggers } from "./released-v47-schema.ts";
import { dropV48Triggers } from "./released-v48-schema.ts";

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

/**
 * Turns the database at `path`, written at v46 or later, into a v45 image in place: what v47 and v48
 * add (SEC-OD1) is taken back as well. Not approved.
 */
export const toV45Image = (path: string): string => {
  const legacy = new Database(path);
  try {
    dropV48Triggers(legacy);
    dropV47Triggers(legacy);
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

/**
 * The v46 freeze: like v45 (#1140), the released v46 step reads its own frozen snapshot,
 * `src/db/schema-v46.sql`, a byte copy of `schema.sql` at v46's squash merge (#1141), so a later schema
 * change cannot change what a database receives at its v46 step. Every value here was measured with the
 * pre-change code, whose `migrations.ts` and `schema.sql` are those of that commit, and is transcribed,
 * not recomputed: a value a run derives from the file it is checking agrees with whatever file it is
 * handed.
 */
export const V46_FREEZE_BASE_COMMIT = "2ef0d0cf6c0372dfd1b73cb22e245886121e99fd";

export const V46_SNAPSHOT_PATH = "src/db/schema-v46.sql";
/** `git rev-parse 2ef0d0cf:src/db/schema.sql`, the v46 canonical source. */
export const V46_SNAPSHOT_GIT_BLOB = "b9ddaf07d9e2145fffe774c00045973e26a52384";
export const V46_SNAPSHOT_SHA256 = "81d5096ab00b7a3eb02aefb9eced972331dae00b0e8a4f788e6ebb90b1c2fef4";

/** v46's receipt checksum as the pre-change build computed it, in full. */
export const V46_BASE_CHECKSUM = "sha256:aa2aa099fe49482d7c9ae5e32ffc6a587287e5cdd9e97b44e268a22a3883e04a";

/**
 * `digestOfSchemaRows` of the database the pre-change build left at v46: from a v45 image (`toV45Image`
 * of a database that build wrote, which is also its fresh v46 create), and from the v11 fixture, which
 * runs every step v12–v46.
 */
export const V46_SCHEMA_DIGEST_FROM_V45 =
  "sha256:9a795a8de0bbaa3402acb8bdb34a9718f57730a7241ed5896f3fb63147f25f95";
export const V46_SCHEMA_DIGEST_FROM_V11 =
  "sha256:a000e8202aac1663eacabb3b103373f5cd7ba5cead980463135703e33708b72c";

/**
 * A fresh v46 create, made from the snapshot rather than from whatever `schema.sql` holds now. The
 * bootstrap path applies the schema's DDL and then the migration ledger; nothing else it does
 * reaches `sqlite_schema`.
 */
export const freshV46CreateFromSnapshot = (path: string): string => {
  const ddl = readFileSync(new URL(`../../${V46_SNAPSHOT_PATH}`, import.meta.url), "utf8")
    .replace(/^\s*PRAGMA\s+(?:journal_mode|foreign_keys|synchronous)\s*=\s*[^;]+;\s*$/gim, "");
  const raw = new Database(path);
  try {
    raw.exec(ddl);
    installMigrationLedger(raw);
  } finally {
    raw.close();
  }
  return path;
};
