import type Database from "better-sqlite3";

/**
 * SEC-OD1 (v48) — fixtures for the v47 → v48 step.
 *
 * v48 adds four triggers on `run_artifacts` and nothing else, so a v47 (or older) image taken back from a
 * database written at v48 differs from it by those triggers alone. Historical images for the v48 tests
 * themselves come from the released chain (`releasedChainImage`), never from taking a newer database back.
 */

/** The triggers v48 adds, named here rather than read from the code under test. */
export const V48_ADDED_TRIGGERS = [
  "run_artifacts_owner_decision_supersede_guard",
  "run_artifacts_no_rowid_replace",
  "run_artifacts_rowid_immutable",
  "run_artifacts_rowid_positive",
];

/** The sentinel v48's supersede guard raises. */
export const OWNER_DECISION_SUPERSEDE_DENIED = /OWNER_DECISION_SUPERSEDE_AUTHORITY_DENIED/;

/** Removes v48's triggers on an open raw connection. `IF EXISTS`, so an older build's database is a no-op. */
export const dropV48Triggers = (raw: Database.Database): void => {
  raw.exec(V48_ADDED_TRIGGERS.map((name) => `DROP TRIGGER IF EXISTS ${name};`).join("\n"));
};

/**
 * #512 S-PUSH (CEO 3d0daed0) — the v48 freeze: the released v48 step reads its own frozen snapshot,
 * `src/db/schema-v48.sql`, a byte copy of `schema.sql` at c65e73b2 (unchanged since v48's merge ab136549
 * and at 206d8bfe), so v49's receipts table cannot change what a database receives at its v48 step. Every
 * value here was measured with the pre-change code (c65e73b2's migrations.ts and schema.sql) and is
 * transcribed, not recomputed: a value a run derives from the file it is checking agrees with whatever
 * file it is handed.
 */
export const V48_FREEZE_BASE_COMMIT = "c65e73b2f3a97389ae44800e176e323aef2687ce";
export const V48_SNAPSHOT_PATH = "src/db/schema-v48.sql";
/** `git rev-parse c65e73b2:src/db/schema.sql`, the v48 canonical source. */
export const V48_SNAPSHOT_GIT_BLOB = "29f2a057a7892cb60292880a26bce747a5e32826";
export const V48_SNAPSHOT_SHA256 = "eb0b3b5b7b50e665a3ae2518af470a80bc2d6b8116133f5e248dd9fa9606a753";
/** v48's receipt checksum as the pre-change build computed it, in full. */
export const V48_BASE_CHECKSUM = "sha256:2f5037b3a17199018dafd2db4833a2815ba5eeeb15be3de65d49395aa7772f32";
/**
 * `digestOfSchemaRows` of the database the pre-change build left at v48 from the released chain: from the
 * v11 fixture (every step v12–v48) and from the released v47 image. Both reach the same schema.
 */
export const V48_SCHEMA_DIGEST_FROM_RELEASED_CHAIN =
  "sha256:7afecaf8400bc9f286e0702eeda12c5b6e44ed65cc812dd159f889e66f4d167c";
/** `digestOfSchemaRows` of a fresh database the pre-change build created at v48 (`new Db(path)`). */
export const V48_FRESH_SCHEMA_DIGEST =
  "sha256:d9d15b4a391e225ae3fadb4632ef481ec1a1aec81e4fc964adb0fbc66054b358";
