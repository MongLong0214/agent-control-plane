import type Database from "better-sqlite3";
import { readFileSync } from "node:fs";

/**
 * #512 S-PUSH (v49) — fixtures for the v48 → v49 step.
 *
 * v49 rebuilds `github_receipts` with one more operation in its CHECK and one more in its reservation
 * guard, and changes nothing else. An older image taken back from a database written at v49 therefore
 * differs from the release by that table and its guard alone, so `takeBackV49` rebuilds them from the
 * frozen v48 snapshot, every row with its rowid. Historical images for the v49 tests themselves come from
 * the released chain (`releasedChainImage`), never from taking a newer database back.
 */

const V48_SNAPSHOT = readFileSync(new URL("../../src/db/schema-v48.sql", import.meta.url), "utf8");

/** The objects v49 re-creates, named here rather than read from the code under test. */
export const V49_RECEIPT_TRIGGERS = [
  "github_receipts_immutable",
  "github_receipts_no_replace",
  "github_receipts_applied_requires_reservation",
  "github_receipts_pending_completion",
  "github_receipts_no_delete",
];
export const V49_RECEIPT_INDEX = "github_receipts_run";
/** The only definitions v49 changes. */
export const V49_CHANGED_OBJECTS = ["github_receipts", "github_receipts_applied_requires_reservation"];

const v48Object = (pattern: RegExp, what: string): string => {
  const match = pattern.exec(V48_SNAPSHOT);
  if (!match) throw new Error(`${what} is not in the v48 snapshot`);
  return match[0];
};

/**
 * Takes v49 back on an open raw connection: `github_receipts`, its index and its guards become the v48
 * snapshot's, every row carried with its rowid. A table already at v48's definition is rebuilt the same way,
 * so the call is harmless on an older build's database.
 */
export const takeBackV49 = (raw: Database.Database): void => {
  const table = v48Object(/CREATE TABLE IF NOT EXISTS github_receipts \([\s\S]*?\n\);/, "the github_receipts table");
  const index = v48Object(/CREATE INDEX IF NOT EXISTS github_receipts_run [^;]*;/, "the github_receipts index");
  const triggers = V49_RECEIPT_TRIGGERS.map((name) =>
    v48Object(new RegExp(`CREATE TRIGGER IF NOT EXISTS ${name}\\n[\\s\\S]*?\\nEND;`), name));
  raw.exec("ALTER TABLE github_receipts RENAME TO github_receipts_take_back");
  raw.exec(V49_RECEIPT_TRIGGERS.map((name) => `DROP TRIGGER IF EXISTS ${name};`).join("\n"));
  raw.exec(`DROP INDEX IF EXISTS ${V49_RECEIPT_INDEX}`);
  raw.exec(table);
  const columns = (raw.prepare("SELECT name FROM pragma_table_info('github_receipts_take_back')").pluck().all() as string[])
    .map((name) => `"${name}"`)
    .join(", ");
  raw.exec(`INSERT INTO github_receipts (rowid, ${columns}) SELECT rowid, ${columns} FROM github_receipts_take_back ORDER BY rowid`);
  raw.exec("DROP TABLE github_receipts_take_back");
  raw.exec(index);
  for (const trigger of triggers) raw.exec(trigger);
};

/** The sentinel the receipt guards raise. */
export const RECEIPT_PROTOCOL_VIOLATION = /GITHUB_RECEIPT_PROTOCOL_VIOLATION/;
