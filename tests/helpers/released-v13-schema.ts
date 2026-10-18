import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { chmodSync, readFileSync } from "node:fs";

import { digestOfSchemaRows, SCHEMA_ROWS_SQL, type SchemaRow } from "./released-v44-schema.ts";

/**
 * V46-R1-02 (CEO 414404c6). The released v13, built from the release's own schema.
 *
 * The r1 image ran today's chain from the v11 fixture to v13. The v12 step in that chain replays the
 * frozen schema-v37.sql, so the image held 16 tables, 7 indexes and 58 triggers that the released v13
 * never had. `baseline_records` was one of them, and creating that table is v14's whole job, so the
 * v13 tests still passed with v14 replaced by a no-op. No v13 deployment was ever written by that chain.
 *
 * This image is built the way the v13 release (842830c5, `SCHEMA_VERSION = 13`) set up a new
 * database. It uses that release's `src/db/schema.sql`, kept byte for byte at
 * `tests/fixtures/schema-v13.sql` and pinned in FROZEN_BLOBS by git blob id and sha256. It also uses
 * the release's migration ledger, the release's `bootstrap-v13` receipt with that release's checksum,
 * and user_version 13. Nothing comes from this build's schema or migrations.
 */

/** The v13 release: its `migrations.ts` declares `SCHEMA_VERSION = 13`. */
export const V13_RELEASE_COMMIT = "842830c56488862de2c6f15adf797533cbbc82d3";

/** `git show 842830c5:src/db/schema.sql`, byte for byte. Pinned in FROZEN_BLOBS. */
export const V13_SCHEMA_FIXTURE = "tests/fixtures/schema-v13.sql";

const V13_SCHEMA = readFileSync(new URL("../fixtures/schema-v13.sql", import.meta.url), "utf8");

/** 842830c5's `schemaDdl()`: its schema.sql without the three connection PRAGMAs, which its Db sets itself. */
const V13_DDL = V13_SCHEMA.replace(/^\s*PRAGMA\s+(?:journal_mode|foreign_keys|synchronous)\s*=\s*[^;]+;\s*$/gim, "");

/**
 * 842830c5's `installMigrationLedger`, byte for byte. The release keeps its ledger in migrations.ts
 * rather than in schema.sql. A stored definition keeps the statement's own whitespace, so the
 * indentation is part of what is compared.
 */
export const V13_LEDGER_DDL = `
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version         INTEGER PRIMARY KEY CHECK (version > 0),
      migration_id    TEXT NOT NULL UNIQUE,
      checksum        TEXT NOT NULL CHECK (checksum LIKE 'sha256:%'),
      backup_file     TEXT,
      backup_checksum TEXT,
      applied_at      TEXT NOT NULL,
      CHECK ((backup_file IS NULL) = (backup_checksum IS NULL))
    );

    CREATE TRIGGER IF NOT EXISTS schema_migrations_insert_authority
    BEFORE INSERT ON schema_migrations
    WHEN acp_schema_migration_authorized() <> 1
    BEGIN
      SELECT RAISE(ABORT, 'SCHEMA_MIGRATION_AUTHORITY_DENIED');
    END;

    CREATE TRIGGER IF NOT EXISTS schema_migrations_immutable
    BEFORE UPDATE ON schema_migrations
    BEGIN
      SELECT RAISE(ABORT, 'SCHEMA_MIGRATION_RECEIPT_IMMUTABLE');
    END;

    CREATE TRIGGER IF NOT EXISTS schema_migrations_no_delete
    BEFORE DELETE ON schema_migrations
    BEGIN
      SELECT RAISE(ABORT, 'SCHEMA_MIGRATION_RECEIPT_IMMUTABLE');
    END;
  `;

/** sha256 of the `installMigrationLedger` template literal as it stands in 842830c5:src/db/migrations.ts. */
export const V13_LEDGER_DDL_SHA256 = "2bae1eab462ecac9a94f09a2de9750a1093c17e4b9b47c4fb5e069059a6bdbd3";

/**
 * What the v13 release's own `Db` wrote on a fresh private path: `digestOfSchemaRows(schemaRowsOf(path))`
 * and its single receipt (applied_at aside). Measured by running 842830c5's src/db/database.ts, and not
 * recomputed from this build or from the fixture. The image below is compared with what v13 wrote.
 */
export const V13_SCHEMA_DIGEST = "sha256:fdccfde54673d4e0d79db1daee7431e9f0d38dede400b07c6c680dffc0e6bcab";
export const V13_RECEIPT = {
  version: 13,
  migration_id: "bootstrap-v13",
  checksum: "sha256:eafd786914080955fec3ac52acf2b9cb7938213117871e0550b272a245ff7da6",
  backup_file: null,
  backup_checksum: null,
} as const;

/** The receipt's applied_at, which the release does not fix: the time 842830c5 was committed. */
const V13_APPLIED_AT = "2026-08-13T14:21:58.000Z";

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/**
 * Writes the released v13 to `path` the way 842830c5's `Db` bootstrapped a new database: the same
 * connection settings, then one transaction that holds the schema, the ledger, the `bootstrap-v13`
 * receipt (checksum `sha256("bootstrap-v13\n" + schema.sql)`, the release's `bootstrapChecksum()`), and
 * user_version 13. Not approved.
 */
export const releasedV13Image = (path: string): string => {
  const raw = new Database(path);
  try {
    raw.pragma("foreign_keys = ON");
    raw.pragma("journal_mode = WAL");
    raw.pragma("synchronous = FULL");
    // The release's receipt insert passes its ledger's own authority guard; this is that marker.
    raw.function("acp_schema_migration_authorized", () => 1);
    raw.exec("BEGIN IMMEDIATE");
    raw.exec(V13_DDL);
    raw.exec(V13_LEDGER_DDL);
    raw
      .prepare(
        `INSERT INTO schema_migrations
           (version, migration_id, checksum, backup_file, backup_checksum, applied_at)
         VALUES (?, ?, ?, NULL, NULL, ?)`,
      )
      .run(13, "bootstrap-v13", `sha256:${sha256(`bootstrap-v13\n${V13_SCHEMA}`)}`, V13_APPLIED_AT);
    raw.pragma("user_version = 13");
    raw.exec("COMMIT");
  } finally {
    raw.close();
  }
  chmodSync(path, 0o600);
  return path;
};

/**
 * How the database at `path` differs from the released v13 as that release's own `Db` set up a new
 * database; an empty list means it does not differ. A v11 database that v13's own steps upgraded is a
 * different v13 (its rebuilt `runs` keeps the rename's text, and it holds two step receipts) and is
 * not what this image claims to be.
 * The checks cover user_version, every `sqlite_schema` row (type, name, owning table and stored
 * definition, the internal rows included), the digest the release itself produced, and the receipts.
 * The reference comes from the release's schema and ledger and never from this build.
 */
export const releasedV13Differences = (path: string): string[] => {
  const image = new Database(path, { readonly: true, fileMustExist: true });
  const release = new Database(":memory:");
  try {
    release.exec(V13_DDL);
    release.exec(V13_LEDGER_DDL);
    const found: string[] = [];
    const userVersion = image.pragma("user_version", { simple: true });
    if (userVersion !== 13) found.push(`user_version is ${String(userVersion)}, not 13`);
    const rowsOf = (db: Database.Database) => db.prepare(SCHEMA_ROWS_SQL).all() as SchemaRow[];
    const keyed = (rows: readonly SchemaRow[]) => new Map(rows.map((row) => [`${row.type} ${row.name}`, row]));
    const held = rowsOf(image);
    const released = keyed(rowsOf(release));
    const heldKeys = keyed(held);
    for (const [key, row] of heldKeys) {
      const own = released.get(key);
      if (own === undefined) found.push(`not in the released v13: ${key}`);
      else if (own.tbl_name !== row.tbl_name || own.sql !== row.sql) found.push(`not the released v13 definition: ${key}`);
    }
    for (const key of released.keys()) if (!heldKeys.has(key)) found.push(`missing from the image: ${key}`);
    const digest = digestOfSchemaRows(held);
    if (digest !== V13_SCHEMA_DIGEST) found.push(`schema digest ${digest} is not the one v13 wrote`);
    const hasLedger = image.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations'").get();
    const receipts = hasLedger === undefined ? [] : image
      .prepare("SELECT version, migration_id, checksum, backup_file, backup_checksum FROM schema_migrations ORDER BY version")
      .all();
    if (JSON.stringify(receipts) !== JSON.stringify([V13_RECEIPT])) {
      found.push(`receipts are ${JSON.stringify(receipts)}, not v13's bootstrap receipt`);
    }
    return found;
  } finally {
    image.close();
    release.close();
  }
};
