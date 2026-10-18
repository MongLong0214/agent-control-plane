import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";

import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { digestOfFile, driftedBlobs, FROZEN_BLOBS, gitBlobOfFile } from "../helpers/frozen-authority.ts";
import { laterObjectsIn, releasedChainImage, todaysChainImage } from "../helpers/released-chain-image.ts";
import {
  releasedV13Image,
  V13_LEDGER_DDL,
  V13_LEDGER_DDL_SHA256,
  V13_RECEIPT,
  V13_SCHEMA_DIGEST,
  V13_SCHEMA_FIXTURE,
} from "../helpers/released-v13-schema.ts";
import { digestOfSchemaRows, privateStatePath, schemaRowsOf, userVersionOf } from "../helpers/released-v44-schema.ts";

afterAll(cleanupTempDirs);

/**
 * V46-R1-02 (CEO 414404c6). The v13 image the v13 tests migrate from is the released v13. It comes
 * from 842830c5's own schema.sql and is compared with what that release wrote. This build's chain to
 * v13 holds objects that v13 never had, and it is refused here.
 */

/** `type name` of every object a SQL text declares. The text is read as text, not run through SQLite. */
const declared = (sql: string): string[] =>
  [...sql.matchAll(/^\s*CREATE\s+(?:UNIQUE\s+)?(TABLE|INDEX|TRIGGER|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/gim)]
    .map((match) => `${match[1]!.toLowerCase()} ${match[2]!}`);

const byType = (keys: readonly string[]): Record<string, number> =>
  keys.reduce<Record<string, number>>((counts, key) => {
    const type = key.split(" ")[0]!;
    counts[type] = (counts[type] ?? 0) + 1;
    return counts;
  }, {});

const NOT_RELEASED = "not in the released v13: ";

describe("V46-R1-02 the v13 image is the released v13", () => {
  it("keeps 842830c5's schema.sql byte for byte, pinned by git blob id and sha256", () => {
    // `git rev-parse 842830c5:src/db/schema.sql` and `git show 842830c5:src/db/schema.sql | shasum -a 256`.
    expect(FROZEN_BLOBS.find((blob) => blob.path === V13_SCHEMA_FIXTURE)).toEqual({
      path: V13_SCHEMA_FIXTURE,
      sha256: "0c401e7d9cbc385819d8733c26dd6f60d269594d0a5a7b87d5bb0b041b487586",
      gitBlob: "5724ce5155ab5c6c0b2a11d0fba2d121585fddc4",
    });
    expect(gitBlobOfFile(V13_SCHEMA_FIXTURE)).toBe("5724ce5155ab5c6c0b2a11d0fba2d121585fddc4");
    expect(digestOfFile(V13_SCHEMA_FIXTURE)).toBe("0c401e7d9cbc385819d8733c26dd6f60d269594d0a5a7b87d5bb0b041b487586");
    expect(driftedBlobs().filter((line) => line.startsWith(V13_SCHEMA_FIXTURE))).toEqual([]);
    // The release's ledger lives in its migrations.ts, so it is carried as text and pinned on its own.
    expect(createHash("sha256").update(V13_LEDGER_DDL).digest("hex")).toBe(V13_LEDGER_DDL_SHA256);
  });

  it("writes what the v13 release wrote and nothing of a later version", () => {
    const path = releasedV13Image(privateStatePath("acp-v13-release-"));
    expect(laterObjectsIn(path, 13)).toEqual([]);
    expect(userVersionOf(path)).toBe(13);

    // The digest 842830c5's own Db produced on a fresh path, with its object counts. SQLite's
    // sqlite_sequence table and its autoindexes are included in both.
    const rows = schemaRowsOf(path);
    expect(digestOfSchemaRows(rows)).toBe(V13_SCHEMA_DIGEST);
    expect(byType(rows.map((row) => `${row.type} ${row.name}`))).toEqual({ index: 59, table: 25, trigger: 30 });

    // The same set read from the release's text alone, with no SQLite involved.
    const schema = readFileSync(new URL("../fixtures/schema-v13.sql", import.meta.url), "utf8");
    const own = rows.filter((row) => !row.name.startsWith("sqlite_")).map((row) => `${row.type} ${row.name}`).sort();
    expect(own).toEqual([...declared(schema), ...declared(V13_LEDGER_DDL)].sort());

    const raw = new Database(path, { readonly: true, fileMustExist: true });
    try {
      expect(
        raw.prepare("SELECT version, migration_id, checksum, backup_file, backup_checksum FROM schema_migrations ORDER BY version").all(),
      ).toEqual([V13_RECEIPT]);
      // What the r1 images held and v13 did not: v14's and v15's tables, a v22 table, and the v46 guards.
      for (const later of ["baseline_records", "verification_worktrees", "canonical_turns", "outbox_no_rowid_replace"]) {
        expect(raw.prepare("SELECT name FROM sqlite_schema WHERE name = ? COLLATE NOCASE").get(later)).toBeUndefined();
      }
    } finally {
      raw.close();
    }
  });

  it("refuses the image this build's chain leaves at v13, naming what the release never had", () => {
    const path = todaysChainImage(privateStatePath("acp-v13-chain-"), 13);
    const found = laterObjectsIn(path, 13);
    const extra = found
      .filter((line) => line.startsWith(NOT_RELEASED))
      .map((line) => line.slice(NOT_RELEASED.length))
      .filter((key) => !key.split(" ")[1]!.startsWith("sqlite_"));
    // The review's count against 842830c5: 16 tables, 7 indexes and 58 triggers.
    expect(byType(extra)).toEqual({ index: 7, table: 16, trigger: 58 });
    expect(extra).toContain("table baseline_records");
    expect(found).toContainEqual(expect.stringMatching(/^schema digest sha256:[a-f0-9]{64} is not the one v13 wrote$/));
    expect(found).toContainEqual(expect.stringMatching(/^receipts are .*, not v13's bootstrap receipt$/));
  });

  it("has no released image below v38 other than v13", () => {
    expect(() => releasedChainImage(privateStatePath("acp-v20-"), 20)).toThrowError(/no released v20 image/);
    expect(laterObjectsIn(releasedChainImage(privateStatePath("acp-v13-via-chain-"), 13), 13)).toEqual([]);
  });
});
