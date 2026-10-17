import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { Db } from "../../src/db/database.ts";
import { installMigrationLedger } from "../../src/db/migrations.ts";
import { tempDir } from "./fixtures.ts";

/**
 * V45-A0: the released steps v38–v44 install what they installed when they shipped.
 *
 * Until A0 those seven steps read the live `schema.sql`, so the first change to a body one of them
 * owns would have changed what an older database receives at that step. They now read
 * `src/db/schema-v44.sql`, a byte copy of `schema.sql` at the commit below. Every value here was
 * measured with the pre-change code at that commit and is transcribed, not recomputed: a value a
 * run derives from the file it is checking agrees with whatever file it is handed.
 */
export const A0_BASE_COMMIT = "a34d7c2eafdceb8167e11a27e4c7099a7f10290e";

export const V44_SNAPSHOT_PATH = "src/db/schema-v44.sql";
/** `git rev-parse a34d7c2e:src/db/schema.sql`, the v44 canonical source. */
export const V44_SNAPSHOT_GIT_BLOB = "157a8e4d9de12ded5f7a877dc7b966843c9fe425";
export const V44_SNAPSHOT_SHA256 = "04f7a674fb4ee75810d26d340e287f1cd38635a25d49e97e48af2aed5174e15f";

/** Each released step's receipt checksum as the pre-change build computed it. */
export const V38_TO_V44_BASE_CHECKSUMS: Readonly<Record<string, string>> = {
  "v38-canonical-verified-target-override":
    "sha256:5cd405d8160332876dd46a5b91923793d90026df4d94bc41646bf4f6035af910",
  "v39-owner-reply-intent-keeps-its-key":
    "sha256:a39afb71e5c3a6403beddc204cf69c99da33a786580bb6dce6443f715f79bdfb",
  "v40-peer-message-carry-record":
    "sha256:9d4c804d29fd12b8bb44d10f003599cd651d1c55d3a4326a17cf8cf0eab15e86",
  "v41-runtime-managed-worker-turns":
    "sha256:07224d2df964676d25a0c8a35dec7f8d239eca7aacebd69795b5662fedeaafd3",
  "v42-session-credential-epoch":
    "sha256:a5be3e069535b259d3f70a8140bb44e243cec7c91046bb7caa32946bfd4c353c",
  "v43-bootstrap-application-record":
    "sha256:7ffb8367eb3fea440422e1f14f9aef48feb1f8ddea826d2888da48353dfac0f1",
  "v44-manifest-activation-grant":
    "sha256:06a2f0a829718e98c9b9b606c9e53d7cee40ab69f1beda36ee6716158117b380",
};

/**
 * `digestOfSchemaRows` of the database the pre-change build left at v44, from each fixture below.
 * The fresh v44 create the same build makes has the v43 value as well.
 *
 * From v43 only v44 runs; from v11 every step v12–v44 runs, so v38–v43 are exercised as well.
 */
export const V44_SCHEMA_DIGEST_FROM_V43 =
  "sha256:ca4dee5cb8f0d88cccbc4f7bb406be94288a98d030afeefab971832abf28b2ef";
export const V44_SCHEMA_DIGEST_FROM_V11 =
  "sha256:d39325b6b197481946e3da902f6542eb13e121fbbe2ace1f5fc08176539c0f7c";

export const gitBlobId = (bytes: Buffer): string =>
  createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

export interface SchemaRow {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}

/** Everything `sqlite_schema` states except page numbers, in a fixed order. */
export const SCHEMA_ROWS_SQL =
  "SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name";

export const digestOfSchemaRows = (rows: readonly SchemaRow[]): string =>
  `sha256:${createHash("sha256").update(JSON.stringify(rows)).digest("hex")}`;

export const schemaRowsOf = (path: string): SchemaRow[] => {
  const raw = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return raw.prepare(SCHEMA_ROWS_SQL).all() as SchemaRow[];
  } finally {
    raw.close();
  }
};

export const userVersionOf = (path: string): number => {
  const raw = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return raw.pragma("user_version", { simple: true }) as number;
  } finally {
    raw.close();
  }
};

/** A private state directory and the database path inside it, the way the daemon keeps one. */
export const privateStatePath = (prefix: string): string => {
  const root = join(tempDir(prefix), "state");
  mkdirSync(root, { recursive: true });
  chmodSync(root, 0o700);
  return join(root, "state.sqlite");
};

const V11_SCHEMA = readFileSync(new URL("../fixtures/schema-v11.sql", import.meta.url), "utf8");

/** A v11 database from the checked-in prior-release SQL, never from current Db code. Not approved. */
export const v11Image = (path: string): string => {
  const raw = new Database(path);
  try {
    raw.exec(V11_SCHEMA);
    raw.pragma("user_version = 11");
  } finally {
    raw.close();
  }
  chmodSync(path, 0o600);
  return path;
};

/** What v44 adds, and nothing else: one table, its five guards, and three over projects and runs. */
const V44_TRIGGERS = [
  "manifest_activation_grants_born_unconsumed",
  "manifest_activation_grants_no_replace",
  "manifest_activation_grants_immutable",
  "manifest_activation_grants_consumed_once",
  "manifest_activation_grants_no_delete",
  "projects_no_replace",
  "projects_active_manifest_moves_by_grant",
  "runs_contract_change_completes_activated",
];

/**
 * A v43 image, written at the current version and taken back by removing exactly what v44 adds —
 * the way the v40–v43 fixtures build theirs. Not approved.
 */
export const v43Image = (path: string): string => {
  new Db(path).close();
  const legacy = new Database(path);
  try {
    legacy.exec(V44_TRIGGERS.map((name) => `DROP TRIGGER ${name};`).join("\n"));
    legacy.exec("DROP TABLE manifest_activation_grants");
    legacy.exec(`
      DROP TRIGGER schema_migrations_no_delete;
      DROP TRIGGER schema_migrations_insert_authority;
      DELETE FROM schema_migrations WHERE version > 43;
      INSERT INTO schema_migrations (version, migration_id, checksum, applied_at)
        VALUES (43, 'bootstrap-v43', 'sha256:${"0".repeat(64)}', '2026-10-17T00:00:00.000Z');
      PRAGMA user_version = 43;
    `);
    installMigrationLedger(legacy);
  } finally {
    legacy.close();
  }
  chmodSync(path, 0o600);
  return path;
};

/**
 * A fresh v44 create, made from the snapshot rather than from whatever `schema.sql` holds now. The
 * bootstrap path applies the schema's DDL and then the migration ledger; nothing else it does
 * reaches `sqlite_schema`.
 */
export const freshV44CreateFromSnapshot = (path: string): string => {
  const ddl = readFileSync(new URL(`../../${V44_SNAPSHOT_PATH}`, import.meta.url), "utf8")
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
