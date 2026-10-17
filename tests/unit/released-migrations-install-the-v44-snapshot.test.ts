import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";

import { Db } from "../../src/db/database.ts";
import { approveMigration } from "../../src/db/migration-approval.ts";
import { MIGRATIONS } from "../../src/db/migrations.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import {
  digestOfSchemaRows,
  freshV44CreateFromSnapshot,
  gitBlobId,
  privateStatePath,
  schemaRowsOf,
  V38_TO_V44_BASE_CHECKSUMS,
  V44_SCHEMA_DIGEST_FROM_V11,
  V44_SCHEMA_DIGEST_FROM_V43,
  V44_SNAPSHOT_GIT_BLOB,
  V44_SNAPSHOT_PATH,
  V44_SNAPSHOT_SHA256,
  v11Image,
  v43Image,
} from "../helpers/released-v44-schema.ts";

afterAll(cleanupTempDirs);

/**
 * V45-A0, witness A0-1 (source level). v38–v44 read `schema-v44.sql`, not the live schema, and
 * still produce exactly what the v44 build produced: the same receipt checksums and the same
 * `sqlite_schema`. The expected values were measured with the pre-change code and are transcribed
 * in the helper; nothing here derives them from the snapshot it is checking.
 */

const RELEASED = MIGRATIONS.filter((migration) => migration.toVersion >= 38 && migration.toVersion <= 44);

/** Runs the approved chain with this checkout's code; returns the schema as it stood at v44. */
const upgradeToV44 = (path: string): { atV44: string; receipts: Record<string, string> } => {
  approveMigration(path, "V45-A0 source-level witness");
  const atV44: string[] = [];
  new Db(path, {
    afterMigration: (migration) => {
      if (migration.toVersion === 44) atV44.push(digestOfSchemaRows(schemaRowsOf(path)));
    },
  }).close();
  expect(atV44).toHaveLength(1);
  const db = new Db(path);
  try {
    const receipts = db.all<{ migration_id: string; checksum: string }>(
      "SELECT migration_id, checksum FROM schema_migrations WHERE version BETWEEN 38 AND 44 ORDER BY version",
    );
    // Only the released steps' own receipts: a fixture's bootstrap receipt is not a step that ran.
    const ran = receipts.filter((row) => row.migration_id in V38_TO_V44_BASE_CHECKSUMS);
    return { atV44: atV44[0]!, receipts: Object.fromEntries(ran.map((row) => [row.migration_id, row.checksum])) };
  } finally {
    db.close();
  }
};

describe("V45-A0: the released steps v38–v44 install the v44 snapshot", () => {
  it("the snapshot is the v44 canonical schema.sql, byte for byte", () => {
    const bytes = readFileSync(new URL(`../../${V44_SNAPSHOT_PATH}`, import.meta.url));
    expect(gitBlobId(bytes)).toBe(V44_SNAPSHOT_GIT_BLOB);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(V44_SNAPSHOT_SHA256);
  });

  it("each of v38–v44 keeps the receipt checksum it shipped with", () => {
    expect(RELEASED.map((migration) => migration.toVersion)).toEqual([38, 39, 40, 41, 42, 43, 44]);
    expect(Object.fromEntries(RELEASED.map((migration) => [migration.id, migration.checksum()])))
      .toEqual(V38_TO_V44_BASE_CHECKSUMS);
  });

  it("a v43 image reaches the v44 schema the v44 build produced", () => {
    const path = v43Image(privateStatePath("acp-a0-v43-"));
    const { atV44, receipts } = upgradeToV44(path);
    expect(atV44).toBe(V44_SCHEMA_DIGEST_FROM_V43);
    expect(receipts).toEqual({
      "v44-manifest-activation-grant": V38_TO_V44_BASE_CHECKSUMS["v44-manifest-activation-grant"],
    });
  });

  it("a v11 image runs every one of v38–v44 and reaches the v44 schema the v44 build produced", () => {
    const path = v11Image(privateStatePath("acp-a0-v11-"));
    const { atV44, receipts } = upgradeToV44(path);
    expect(atV44).toBe(V44_SCHEMA_DIGEST_FROM_V11);
    expect(receipts).toEqual(V38_TO_V44_BASE_CHECKSUMS);
  });

  it("a fresh v44 create from the snapshot has the schema a v43 image reaches", () => {
    const path = freshV44CreateFromSnapshot(privateStatePath("acp-a0-fresh-"));
    expect(digestOfSchemaRows(schemaRowsOf(path))).toBe(V44_SCHEMA_DIGEST_FROM_V43);
  });
});
