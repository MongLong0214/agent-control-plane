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
