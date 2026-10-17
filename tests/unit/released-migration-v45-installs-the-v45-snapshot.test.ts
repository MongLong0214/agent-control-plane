import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";

import { Db } from "../../src/db/database.ts";
import { approveMigration } from "../../src/db/migration-approval.ts";
import { MIGRATIONS } from "../../src/db/migrations.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { digestOfSchemaRows, gitBlobId, privateStatePath, schemaRowsOf, v11Image } from "../helpers/released-v44-schema.ts";
import {
  freshV45CreateFromSnapshot,
  toV44Image,
  V45_BASE_CHECKSUM,
  V45_SCHEMA_DIGEST_FROM_V11,
  V45_SCHEMA_DIGEST_FROM_V44,
  V45_SNAPSHOT_GIT_BLOB,
  V45_SNAPSHOT_PATH,
  V45_SNAPSHOT_SHA256,
} from "../helpers/released-v45-schema.ts";

afterAll(cleanupTempDirs);

/**
 * The v45 freeze (source level), as V45-A0 froze v38–v44: v45 reads `schema-v45.sql`, not the live
 * schema, and still produces exactly what the v45 build produced — the same receipt checksum and the
 * same `sqlite_schema`. The expected values were measured with the pre-change code and are
 * transcribed in the helper; nothing here derives them from the snapshot it is checking.
 */

const V45 = MIGRATIONS.find((migration) => migration.id === "v45-first-manifest-activation")!;

/** Runs the approved chain with this checkout's code; returns the schema as it stood at v45 and v45's receipt. */
const upgradeThroughV45 = (path: string): { atV45: string; receipt: string | undefined } => {
  approveMigration(path, "v45 freeze source-level witness");
  const atV45: string[] = [];
  new Db(path, {
    afterMigration: (migration) => {
      if (migration.toVersion === 45) atV45.push(digestOfSchemaRows(schemaRowsOf(path)));
    },
  }).close();
  expect(atV45).toHaveLength(1);
  const db = new Db(path);
  try {
    const receipt = db.all<{ checksum: string }>(
      "SELECT checksum FROM schema_migrations WHERE version = 45 AND migration_id = 'v45-first-manifest-activation'",
    )[0]?.checksum;
    return { atV45: atV45[0]!, receipt };
  } finally {
    db.close();
  }
};

/** A v44 image of a database this checkout writes; see `toV44Image`. */
const v44Image = (prefix: string): string => {
  const path = privateStatePath(prefix);
  new Db(path).close();
  return toV44Image(path);
};

describe("the v45 freeze: the released v45 step installs the v45 snapshot", () => {
  it("the snapshot is the v45 canonical schema.sql, byte for byte", () => {
    const bytes = readFileSync(new URL(`../../${V45_SNAPSHOT_PATH}`, import.meta.url));
    expect(gitBlobId(bytes)).toBe(V45_SNAPSHOT_GIT_BLOB);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(V45_SNAPSHOT_SHA256);
  });

  it("v45 keeps the receipt checksum it shipped with", () => {
    expect(V45).toMatchObject({ fromVersion: 44, toVersion: 45 });
    expect(V45.checksum()).toBe(V45_BASE_CHECKSUM);
  });

  it("a v44 image reaches the v45 schema the v45 build produced, with v45's shipped receipt", () => {
    const { atV45, receipt } = upgradeThroughV45(v44Image("acp-v45f-v44-"));
    expect(atV45).toBe(V45_SCHEMA_DIGEST_FROM_V44);
    expect(receipt).toBe(V45_BASE_CHECKSUM);
  });

  it("a v11 image runs every step through v45 and reaches the v45 schema the v45 build produced", () => {
    const { atV45, receipt } = upgradeThroughV45(v11Image(privateStatePath("acp-v45f-v11-")));
    expect(atV45).toBe(V45_SCHEMA_DIGEST_FROM_V11);
    expect(receipt).toBe(V45_BASE_CHECKSUM);
  });

  it("a fresh v45 create from the snapshot has the schema a v44 image reaches", () => {
    const path = freshV45CreateFromSnapshot(privateStatePath("acp-v45f-fresh-"));
    expect(digestOfSchemaRows(schemaRowsOf(path))).toBe(V45_SCHEMA_DIGEST_FROM_V44);
  });
});
