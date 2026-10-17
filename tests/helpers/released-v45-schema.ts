import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { chmodSync, readFileSync } from "node:fs";

import { installMigrationLedger } from "../../src/db/migrations.ts";
import { V45_ADDED_TRIGGERS } from "./released-v44-schema.ts";

/**
 * #512 (v45) — fixtures for the v44 → v45 step.
 *
 * A v44 image is taken back from a database written at v45 by removing exactly what v45 adds (its
 * table, index and eight guards) and putting back the v44 bodies of the two guards v45 replaces,
 * read from the frozen v44 snapshot, the way the v40–v44 fixtures build theirs. Every other object
 * and every row is what the v45 code wrote, which for the v44 tables is what v44 writes.
 */

const V44_SNAPSHOT = readFileSync(new URL("../../src/db/schema-v44.sql", import.meta.url), "utf8");

/** The two v44 guards whose bodies v45 replaces. */
export const V45_REPLACED_TRIGGERS = ["projects_active_manifest_moves_by_grant", "runs_contract_change_completes_activated"];

export const v44TriggerBody = (name: string): string => {
  const match = new RegExp(`CREATE TRIGGER IF NOT EXISTS ${name}\\n[\\s\\S]*?\\nEND;`).exec(V44_SNAPSHOT);
  if (!match) throw new Error(`${name} is not in the v44 snapshot`);
  return match[0];
};

/** Turns the database at `path`, written at v45, into a v44 image in place. Not approved. */
export const toV44Image = (path: string): string => {
  const legacy = new Database(path);
  try {
    legacy.exec(V45_ADDED_TRIGGERS.map((name) => `DROP TRIGGER ${name};`).join("\n"));
    legacy.exec("DROP INDEX manifest_first_activation_grants_one_consumed_per_project");
    legacy.exec("DROP TABLE manifest_first_activation_grants");
    for (const name of V45_REPLACED_TRIGGERS) {
      legacy.exec(`DROP TRIGGER ${name};`);
      legacy.exec(v44TriggerBody(name));
    }
    legacy.exec(`
      DROP TRIGGER schema_migrations_no_delete;
      DROP TRIGGER schema_migrations_insert_authority;
      DELETE FROM schema_migrations WHERE version > 44;
      INSERT OR IGNORE INTO schema_migrations (version, migration_id, checksum, applied_at)
        VALUES (44, 'bootstrap-v44', 'sha256:${"0".repeat(64)}', '2026-10-17T00:00:00.000Z');
      PRAGMA user_version = 44;
    `);
    installMigrationLedger(legacy);
  } finally {
    legacy.close();
  }
  chmodSync(path, 0o600);
  return path;
};

const ROWID_NAMES = ["rowid", "_rowid_", "oid"];

/**
 * Per-table content digests of the database at `path`, a rowid table's hidden rowid included, plus
 * the schema rows and user_version — the comparison step 4 of the rehearsal makes. Values are typed
 * and length-prefixed so `'1'`, `1` and `1.0` differ.
 */
export const contentDigests = (path: string): { userVersion: number; schema: string; tables: Record<string, string> } => {
  const raw = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const digestRows = (sql: string): string => {
      const hash = createHash("sha256");
      for (const row of raw.prepare(sql).raw(true).safeIntegers(true).iterate() as Iterable<unknown[]>) {
        hash.update("R");
        for (const value of row) {
          if (value === null) hash.update("n");
          else if (typeof value === "bigint") hash.update(`i${value.toString().length}:${value.toString()}`);
          else if (typeof value === "number") hash.update(`r:${value}`);
          else if (typeof value === "string") hash.update(`s${Buffer.byteLength(value)}:`).update(value);
          else if (value instanceof Uint8Array) hash.update(`b${value.length}:`).update(value);
          else throw new Error(`unencodable value ${typeof value}`);
        }
      }
      return `sha256:${hash.digest("hex")}`;
    };
    const tables: Record<string, string> = {};
    const listed = raw
      .prepare("SELECT name, wr FROM pragma_table_list WHERE schema = 'main' AND type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string; wr: number }>;
    for (const table of listed) {
      const quoted = `"${table.name.replace(/"/g, '""')}"`;
      if (table.wr === 0) {
        const columns = (raw.prepare("SELECT name FROM pragma_table_info(?)").pluck().all(table.name) as string[]).map((name) => name.toLowerCase());
        const rowid = ROWID_NAMES.find((name) => !columns.includes(name))!;
        tables[table.name] = digestRows(`SELECT ${rowid}, * FROM ${quoted} ORDER BY ${rowid}`);
      } else {
        const key = (raw.prepare("SELECT name FROM pragma_table_info(?) WHERE pk > 0 ORDER BY pk").pluck().all(table.name) as string[])
          .map((name) => `"${name}"`)
          .join(", ");
        tables[table.name] = digestRows(`SELECT * FROM ${quoted} ORDER BY ${key}`);
      }
    }
    return {
      userVersion: Number(raw.pragma("user_version", { simple: true })),
      schema: digestRows("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name"),
      tables,
    };
  } finally {
    raw.close();
  }
};
