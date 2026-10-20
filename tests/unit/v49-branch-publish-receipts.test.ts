import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import { Db } from "../../src/db/database.ts";
import { approveMigration } from "../../src/db/migration-approval.ts";
import { MIGRATIONS, SCHEMA_VERSION } from "../../src/db/migrations.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { releasedChainImage } from "../helpers/released-chain-image.ts";
import {
  digestOfSchemaRows,
  privateStatePath,
  schemaRowsOf,
  type SchemaRow,
  userVersionOf,
  v11Image,
} from "../helpers/released-v44-schema.ts";
import {
  V48_BASE_CHECKSUM,
  V48_SCHEMA_DIGEST_FROM_RELEASED_CHAIN,
  V48_SNAPSHOT_GIT_BLOB,
  V48_SNAPSHOT_PATH,
  V48_SNAPSHOT_SHA256,
} from "../helpers/released-v48-schema.ts";
import { RECEIPT_PROTOCOL_VIOLATION, V49_RECEIPT_INDEX, V49_RECEIPT_TRIGGERS } from "../helpers/released-v49-schema.ts";

afterAll(cleanupTempDirs);

/**
 * #512 S-PUSH (CEO f5879479, 3d0daed0) — the v48 freeze and the v49 `github_receipts` rebuild.
 *
 * v48 now reads its frozen snapshot, so its step installs exactly what it installed before v49 existed.
 * v49 adds `branch_publish` to the receipts CHECK and to the reservation guard, and nothing else: every
 * existing row, rowid, value, storage class, constraint, index and guard is kept, a failure leaves no
 * partial rebuild, and a v48 database reaches it only through an approved migration.
 */

const NOW = "2026-10-19T00:00:00.000Z";
const V49 = MIGRATIONS.find((step) => step.toVersion === 49)!;

const INSERT = `INSERT INTO github_receipts
  (receipt_id, idempotency_key, operation, run_id, repository_identity, resource_type, resource_identity,
   preexisting, before_state_digest, after_state_digest, request_digest, response_json, created_at, reread_at,
   verified, status) VALUES (?, ?, ?, ?, 'github:acme/fixture', 'r', ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`;

/** Receipts of every operation v48 knows, PENDING and APPLIED, with a deleted reservation leaving a rowid gap. */
const seedReceipts = (path: string): void => {
  const raw = new Database(path);
  try {
    const pending = (id: string, operation: string): void => {
      raw.prepare(INSERT).run(id, `${operation}:${id}`, operation, "run_v49", `res-${id}`, 0, null, `sha256:req-${id}`, '{"pending":true}', NOW, null, 0, "PENDING");
    };
    const complete = (id: string): void => {
      raw.prepare(`UPDATE github_receipts SET status = 'APPLIED', after_state_digest = ?, response_json = ?, reread_at = ?, verified = 1
                    WHERE receipt_id = ?`).run(`sha256:after-${id}`, JSON.stringify({ id, n: 1 }), NOW, id);
    };
    pending("rcp_a", "pr_prepare");
    complete("rcp_a");
    raw.prepare(INSERT).run("rcp_b", "pr_prepare:observed", "pr_prepare", null, "res-b", 1, "sha256:after-b", "sha256:req-b", '{"observed":true}', NOW, NOW, 1, "APPLIED");
    pending("rcp_gap", "gate_publish");
    raw.prepare("DELETE FROM github_receipts WHERE receipt_id = 'rcp_gap'").run();
    for (const [id, operation] of [["rcp_c", "gate_publish"], ["rcp_d", "merge_execute"], ["rcp_e", "release_tag"], ["rcp_f", "issue_project"]]) {
      pending(id!, operation!);
      complete(id!);
    }
    pending("rcp_g", "merge_execute");
    raw.prepare(INSERT).run("rcp_h", "post_merge_verify:h", "post_merge_verify", "run_v49", "res-h", 0, "sha256:after-h", "sha256:req-h", "{}", NOW, NOW, 1, "APPLIED");
    raw.prepare(INSERT).run("rcp_i", "rollback_prepare:i", "rollback_prepare", "run_v49", "res-i", 0, null, "sha256:req-i", "{}", NOW, null, 0, "APPLIED");
  } finally {
    raw.close();
  }
};

/** Every receipt row: rowid, every column, and each value's storage class. */
const receiptRows = (path: string): unknown[] => {
  const raw = new Database(path, { readonly: true });
  try {
    const columns = raw.prepare("SELECT name FROM pragma_table_info('github_receipts')").pluck().all() as string[];
    return raw.prepare(`SELECT rowid AS rid, ${columns.map((c) => `"${c}", typeof("${c}") AS "t_${c}"`).join(", ")} FROM github_receipts ORDER BY rowid`).all();
  } finally {
    raw.close();
  }
};

const receiptObjects = (rows: readonly SchemaRow[]): SchemaRow[] => rows.filter((row) => row.tbl_name === "github_receipts");
const otherObjects = (rows: readonly SchemaRow[]): SchemaRow[] => rows.filter((row) => row.tbl_name !== "github_receipts");

const receiptsOf = (path: string): Array<{ version: number; migration_id: string; checksum: string }> => {
  const raw = new Database(path, { readonly: true });
  try {
    return raw.prepare("SELECT version, migration_id, checksum FROM schema_migrations ORDER BY version").all() as Array<{ version: number; migration_id: string; checksum: string }>;
  } finally {
    raw.close();
  }
};

const freshReceiptObjects = (): SchemaRow[] => {
  const fresh = privateStatePath("acp-v49-fresh-");
  new Db(fresh).close();
  return receiptObjects(schemaRowsOf(fresh));
};

const bytesOf = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

describe("the v48 freeze (CEO 3d0daed0)", () => {
  it("v48 reads a byte copy of the v48-era schema and keeps the checksum it shipped with", () => {
    const bytes = readFileSync(new URL(`../../${V48_SNAPSHOT_PATH}`, import.meta.url));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(V48_SNAPSHOT_SHA256);
    expect(createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex")).toBe(V48_SNAPSHOT_GIT_BLOB);
    expect(MIGRATIONS.find((step) => step.toVersion === 48)!.checksum()).toBe(V48_BASE_CHECKSUM);
    expect(bytes.toString("utf8")).not.toContain("branch_publish");
  });

  it("a v11 database migrated in sequence is the pre-change build's v48 at v48, with v48's shipped receipt, and then reaches v49", () => {
    const path = v11Image(privateStatePath("acp-v49-from-v11-"));
    approveMigration(path, "v49 sequential witness");
    let atV48: string | null = null;
    new Db(path, {
      afterMigration: (migration) => {
        if (migration.toVersion === 48) atV48 = digestOfSchemaRows(schemaRowsOf(path));
      },
    }).close();
    expect(atV48).toBe(V48_SCHEMA_DIGEST_FROM_RELEASED_CHAIN);
    expect(userVersionOf(path)).toBe(SCHEMA_VERSION);
    const receipts = receiptsOf(path);
    expect(receipts.find((receipt) => receipt.version === 48)).toEqual({ version: 48, migration_id: "v48-owner-decision-supersede-guard", checksum: V48_BASE_CHECKSUM });
    expect(receipts.find((receipt) => receipt.version === 49)).toEqual({ version: 49, migration_id: "v49-branch-publish-receipts", checksum: V49.checksum() });
    expect(receiptObjects(schemaRowsOf(path))).toEqual(freshReceiptObjects());
  });
});

describe("v48 → v49 on the released v48 image", () => {
  it("keeps every receipt row, rowid, value and storage class; the table, index and guards become a fresh v49's; nothing else changes", () => {
    const path = releasedChainImage(privateStatePath("acp-v49-up-"), 48);
    expect(digestOfSchemaRows(schemaRowsOf(path))).toBe(V48_SCHEMA_DIGEST_FROM_RELEASED_CHAIN);
    seedReceipts(path);
    const rowsBefore = receiptRows(path);
    expect(rowsBefore).toHaveLength(9);
    const schemaBefore = schemaRowsOf(path);
    const migrationReceiptsBefore = receiptsOf(path);
    approveMigration(path, "v49 upgrade witness");
    let schemaAfter: SchemaRow[] = [];
    new Db(path, { afterMigration: (migration) => {
      if (migration.toVersion === 49) schemaAfter = schemaRowsOf(path);
    } }).close();
    expect(userVersionOf(path)).toBe(SCHEMA_VERSION);
    expect(receiptRows(path)).toEqual(rowsBefore);
    expect(otherObjects(schemaAfter)).toEqual(otherObjects(schemaBefore));
    expect(receiptObjects(schemaAfter)).toEqual(freshReceiptObjects());
    // Exactly two definitions changed: the CHECK and the reservation guard.
    const changed = receiptObjects(schemaAfter).filter((row) => !receiptObjects(schemaBefore).some((old) => old.name === row.name && old.sql === row.sql));
    expect(changed.map((row) => row.name).sort()).toEqual(["github_receipts", "github_receipts_applied_requires_reservation"]);
    expect(receiptObjects(schemaAfter).map((row) => row.name).sort()).toEqual(
      ["github_receipts", V49_RECEIPT_INDEX, ...V49_RECEIPT_TRIGGERS, "sqlite_autoindex_github_receipts_1", "sqlite_autoindex_github_receipts_2"].sort(),
    );
    expect(receiptsOf(path).filter((receipt) => receipt.version <= 48)).toEqual(migrationReceiptsBefore);
    expect(receiptsOf(path).find((receipt) => receipt.version === 49)).toEqual({ version: 49, migration_id: "v49-branch-publish-receipts", checksum: V49.checksum() });
  });

  it("accepts branch_publish only through a reservation (or as an observation), and the v48 image refuses it outright", () => {
    const v48 = releasedChainImage(privateStatePath("acp-v49-v48-op-"), 48);
    const old = new Database(v48);
    try {
      expect(() => old.prepare(INSERT).run("x", "branch_publish:x", "branch_publish", "run", "res", 0, null, "sha256:r", '{"pending":true}', NOW, null, 0, "PENDING"))
        .toThrow(/CHECK constraint failed/);
    } finally {
      old.close();
    }
    approveMigration(v48, "v49 operation witness");
    new Db(v48).close();
    const raw = new Database(v48);
    try {
      expect(() => raw.prepare(INSERT).run("direct", "branch_publish:direct", "branch_publish", "run", "res", 0, "sha256:a", "sha256:r", "{}", NOW, NOW, 1, "APPLIED"))
        .toThrow(RECEIPT_PROTOCOL_VIOLATION);
      raw.prepare(INSERT).run("observed", "branch_publish:observed", "branch_publish", "run", "res", 1, "sha256:a", "sha256:r", "{}", NOW, NOW, 1, "APPLIED");
      raw.prepare(INSERT).run("reserved", "branch_publish:reserved", "branch_publish", "run", "res", 0, null, "sha256:r", '{"pending":true}', NOW, null, 0, "PENDING");
      expect(() => raw.prepare("UPDATE github_receipts SET status = 'APPLIED', after_state_digest = 'sha256:a', response_json = '{}', reread_at = ?, verified = 1, preexisting = 1 WHERE receipt_id = 'reserved'").run(NOW))
        .toThrow(RECEIPT_PROTOCOL_VIOLATION);
      raw.prepare("UPDATE github_receipts SET status = 'APPLIED', after_state_digest = 'sha256:a', response_json = '{}', reread_at = ?, verified = 1 WHERE receipt_id = 'reserved'").run(NOW);
      expect(() => raw.prepare("DELETE FROM github_receipts WHERE receipt_id = 'reserved'").run()).toThrow(/GITHUB_RECEIPT_IMMUTABLE/);
      expect(() => raw.prepare(INSERT).run("other", "branch_delete:x", "branch_delete", "run", "res", 0, null, "sha256:r", '{"pending":true}', NOW, null, 0, "PENDING"))
        .toThrow(/CHECK constraint failed/);
    } finally {
      raw.close();
    }
  });

  it("refuses to migrate a v48 database without an approval, leaving it byte for byte", () => {
    const path = releasedChainImage(privateStatePath("acp-v49-refuse-"), 48);
    seedReceipts(path);
    const bytes = bytesOf(path);
    expect(() => new Db(path).close()).toThrow();
    expect(bytesOf(path)).toBe(bytes);
    expect(userVersionOf(path)).toBe(48);
  });

  it("a fault after v49 commits restores the v48 image from the automatic backup, every row with it", () => {
    const path = releasedChainImage(privateStatePath("acp-v49-fault-"), 48);
    seedReceipts(path);
    const rows = receiptRows(path);
    const schema = schemaRowsOf(path);
    approveMigration(path, "v49 fault witness");
    expect(() => new Db(path, {
      afterMigration: (migration) => {
        if (migration.toVersion === 49) throw new Error("injected after v49 commits");
      },
    })).toThrowError(/original database was restored/);
    expect(userVersionOf(path)).toBe(48);
    expect(schemaRowsOf(path)).toEqual(schema);
    expect(receiptRows(path)).toEqual(rows);
  });

  it("a failure inside the step, after the old table is moved and the rows copied, rolls back to the v48 table: no partial rebuild", () => {
    const path = releasedChainImage(privateStatePath("acp-v49-atomic-"), 48);
    seedReceipts(path);
    const rows = receiptRows(path);
    const schema = schemaRowsOf(path);
    const raw = new Database(path);
    const seen: string[] = [];
    const failing = new Proxy(raw, {
      get(target, property) {
        if (property === "exec") {
          return (sql: string) => {
            seen.push(sql.slice(0, 40));
            if (sql.startsWith("DROP TABLE github_receipts_v48_rebuild")) throw new Error("injected inside v49");
            return target.exec(sql);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    try {
      raw.exec("BEGIN IMMEDIATE");
      expect(() => V49.apply(failing)).toThrow(/injected inside v49/);
      raw.exec("ROLLBACK");
    } finally {
      raw.close();
    }
    expect(seen.some((sql) => sql.startsWith("ALTER TABLE github_receipts RENAME"))).toBe(true);
    expect(seen.some((sql) => sql.startsWith("INSERT INTO github_receipts (rowid"))).toBe(true);
    expect(schemaRowsOf(path)).toEqual(schema);
    expect(receiptRows(path)).toEqual(rows);
    expect(userVersionOf(path)).toBe(48);
  });

  it("refuses, before anything moves, a receipts table carrying an object schema.sql does not define", () => {
    const path = releasedChainImage(privateStatePath("acp-v49-extra-"), 48);
    seedReceipts(path);
    const raw = new Database(path);
    try {
      raw.exec("CREATE INDEX operator_extra ON github_receipts(created_at)");
    } finally {
      raw.close();
    }
    const schema = schemaRowsOf(path);
    const rows = receiptRows(path);
    approveMigration(path, "v49 extra-object witness");
    let refusal: unknown;
    try {
      new Db(path).close();
    } catch (error) {
      refusal = error;
    }
    expect(String((refusal as { evidence?: { migrationError?: unknown } }).evidence?.migrationError)).toMatch(/v49 refuses: before the step github_receipts carries index operator_extra/);
    expect(schemaRowsOf(path)).toEqual(schema);
    expect(receiptRows(path)).toEqual(rows);
    expect(userVersionOf(path)).toBe(48);
  });
});
