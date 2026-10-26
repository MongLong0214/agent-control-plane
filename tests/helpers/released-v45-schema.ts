import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { chmodSync, readFileSync } from "node:fs";

import { installMigrationLedger } from "../../src/db/migrations.ts";
import { V45_ADDED_TRIGGERS } from "./released-v44-schema.ts";
import { dropV46Triggers } from "./released-v46-schema.ts";
import { dropV47Triggers } from "./released-v47-schema.ts";
import { dropV48Triggers } from "./released-v48-schema.ts";
import { takeBackV49 } from "./released-v49-schema.ts";
import { takeBackV50 } from "./released-v50-schema.ts";

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

/**
 * Turns the database at `path`, written at v45 or later, into a v44 image in place: what v46 adds
 * (#1094) and v47 and v48 add (SEC-OD1) is taken back first, so the image carries nothing a later version
 * installs. Not approved.
 */
export const toV44Image = (path: string): string => {
  const legacy = new Database(path);
  try {
    takeBackV50(legacy);
    takeBackV49(legacy);
    dropV48Triggers(legacy);
    dropV47Triggers(legacy);
    dropV46Triggers(legacy);
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
export const contentDigests = (path: string, throughVersion = Infinity): { userVersion: number; schema: string; tables: Record<string, string> } => {
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
      if (throughVersion < 52 && ['resident_project_provisioning','canonical_session_entitlements','project_retirements'].includes(table.name)) continue;
      const v52Columns:Record<string,string[]> = {projects:['buzz_address','retired_at','supersedes_project_id'],repositories:['retired_at'],bootstrap_applications:['retired_at']};
      // #1258 — v53's attempt column, which an image taken through v52 does not have.
      const laterColumns:Record<string,string[]> = {...(throughVersion < 52 ? v52Columns : {}),...(throughVersion < 53 ? {verification_results:['attempt']} : {})};
      const projection = laterColumns[table.name]
        ? (raw.prepare('SELECT name FROM pragma_table_info(?)').pluck().all(table.name) as string[]).filter(c => !laterColumns[table.name]!.includes(c)).map(c => `"${c}"`).join(',') : '*';
      const quoted = `"${table.name.replace(/"/g, '""')}"`;
      if (table.wr === 0) {
        const columns = (raw.prepare("SELECT name FROM pragma_table_info(?)").pluck().all(table.name) as string[]).map((name) => name.toLowerCase());
        const rowid = ROWID_NAMES.find((name) => !columns.includes(name))!;
        tables[table.name] = digestRows(`SELECT ${rowid}, ${projection} FROM ${quoted} ORDER BY ${rowid}`);
      } else {
        const key = (raw.prepare("SELECT name FROM pragma_table_info(?) WHERE pk > 0 ORDER BY pk").pluck().all(table.name) as string[])
          .map((name) => `"${name}"`)
          .join(", ");
        tables[table.name] = digestRows(`SELECT ${projection} FROM ${quoted} ORDER BY ${key}`);
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

/**
 * The v45 freeze: like v38–v44 (V45-A0), the released v45 step reads its own frozen snapshot,
 * `src/db/schema-v45.sql`, a byte copy of `schema.sql` at the commit below, so a later schema change
 * cannot change what a database receives at its v45 step. Every value here was measured with the
 * pre-change code at that commit and is transcribed, not recomputed: a value a run derives from the
 * file it is checking agrees with whatever file it is handed.
 */
export const V45_FREEZE_BASE_COMMIT = "04a97e36cc0215c5f8a7f4961e2036f858707a06";

export const V45_SNAPSHOT_PATH = "src/db/schema-v45.sql";
/** `git rev-parse 04a97e36:src/db/schema.sql`, the v45 canonical source. */
export const V45_SNAPSHOT_GIT_BLOB = "aee08ad7b91d7e7c7ada0000f6ea7cea8d830489";
export const V45_SNAPSHOT_SHA256 = "70821ad69e99dc006a21751558b2f4eaec1001146e7b65f1e4b052453622a7bf";

/** v45's receipt checksum as the pre-change build computed it. */
export const V45_BASE_CHECKSUM = "sha256:4263f0011ebdd53fb8e645f55b4e391e8247755debd8961fe74c312c983ad1ee";

/**
 * `digestOfSchemaRows` of the database the pre-change build left at v45: from a v44 image (`toV44Image`
 * of a database that build wrote, which is also its fresh v45 create), and from the v11 fixture, which
 * runs every step v12–v45.
 */
export const V45_SCHEMA_DIGEST_FROM_V44 =
  "sha256:992a12b35a87f555b30aac31767a2a04eedf0881c49bc45b31510fe1bad68d60";
export const V45_SCHEMA_DIGEST_FROM_V11 =
  "sha256:62b015f331f512a58fa22bcfca251ab5d12902b4ef9a31be6366821d897711ba";

/**
 * A fresh v45 create, made from the snapshot rather than from whatever `schema.sql` holds now. The
 * bootstrap path applies the schema's DDL and then the migration ledger; nothing else it does
 * reaches `sqlite_schema`.
 */
export const freshV45CreateFromSnapshot = (path: string): string => {
  const ddl = readFileSync(new URL(`../../${V45_SNAPSHOT_PATH}`, import.meta.url), "utf8")
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
