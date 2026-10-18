import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";

import { Db } from "../../src/db/database.ts";
import { approveMigration } from "../../src/db/migration-approval.ts";
import { MIGRATIONS, SCHEMA_VERSION } from "../../src/db/migrations.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { digestOfSchemaRows, gitBlobId, privateStatePath, schemaRowsOf, v11Image } from "../helpers/released-v44-schema.ts";
import { contentDigests, toV44Image, V45_BASE_CHECKSUM, V45_SCHEMA_DIGEST_FROM_V44 } from "../helpers/released-v45-schema.ts";
import {
  freshV46CreateFromSnapshot,
  toV45Image,
  V46_BASE_CHECKSUM,
  V46_SCHEMA_DIGEST_FROM_V11,
  V46_SCHEMA_DIGEST_FROM_V45,
  V46_SNAPSHOT_GIT_BLOB,
  V46_SNAPSHOT_PATH,
  V46_SNAPSHOT_SHA256,
} from "../helpers/released-v46-schema.ts";

afterAll(cleanupTempDirs);

/**
 * The v46 freeze (source level), as #1140 froze v45: v46 reads `schema-v46.sql`, not the live schema,
 * and still produces exactly what the v46 build produced — the same receipt checksum and the same
 * `sqlite_schema`. The expected values were measured with the pre-change code and are transcribed in
 * the helper; nothing here derives them from the snapshot it is checking.
 */

const V45 = MIGRATIONS.find((migration) => migration.id === "v45-first-manifest-activation")!;
const V46 = MIGRATIONS.find((migration) => migration.id === "v46-rowid-no-replace")!;

interface Upgrade {
  atV45: string | undefined;
  atV46: string;
  receipts: Record<string, string>;
}

/** Runs the approved chain with this checkout's code; returns the schema at v45 and v46, and the v45/v46 receipts. */
const upgradeThroughV46 = (path: string): Upgrade => {
  approveMigration(path, "v46 freeze source-level witness");
  const at: Record<number, string> = {};
  new Db(path, {
    afterMigration: (migration) => {
      if (migration.toVersion === 45 || migration.toVersion === 46) at[migration.toVersion] = digestOfSchemaRows(schemaRowsOf(path));
    },
  }).close();
  expect(at[46]).toBeDefined();
  const db = new Db(path);
  try {
    const rows = db.all<{ migration_id: string; checksum: string }>(
      "SELECT migration_id, checksum FROM schema_migrations WHERE version IN (45, 46) ORDER BY version",
    );
    return { atV45: at[45], atV46: at[46]!, receipts: Object.fromEntries(rows.map((row) => [row.migration_id, row.checksum])) };
  } finally {
    db.close();
  }
};

/** A v45 image of a database this checkout writes; see `toV45Image`. Not approved. */
const v45Image = (prefix: string): string => {
  const path = privateStatePath(prefix);
  new Db(path).close();
  return toV45Image(path);
};

/** A v44 image of a database this checkout writes; see `toV44Image`. Not approved. */
const v44Image = (prefix: string): string => {
  const path = privateStatePath(prefix);
  new Db(path).close();
  return toV44Image(path);
};

describe("the v46 freeze: the released v46 step installs the v46 snapshot", () => {
  it("the snapshot is the v46 canonical schema.sql, byte for byte", () => {
    const bytes = readFileSync(new URL(`../../${V46_SNAPSHOT_PATH}`, import.meta.url));
    expect(gitBlobId(bytes)).toBe(V46_SNAPSHOT_GIT_BLOB);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(V46_SNAPSHOT_SHA256);
  });

  it("v46 and v45 keep the full receipt checksums they shipped with, in the step and in the checksum map", () => {
    expect(V46).toMatchObject({ fromVersion: 45, toVersion: 46 });
    expect(V46.checksum()).toBe(V46_BASE_CHECKSUM);
    expect(V45.checksum()).toBe(V45_BASE_CHECKSUM);
    const manifest = JSON.parse(readFileSync(new URL("../../src/db/migration-checksums.json", import.meta.url), "utf8")) as {
      live: Record<string, string>;
    };
    expect(manifest.live["v46-rowid-no-replace"]).toBe(V46_BASE_CHECKSUM);
    expect(manifest.live["v45-first-manifest-activation"]).toBe(V45_BASE_CHECKSUM);
  });

  it("a v45 image reaches the v46 schema the v46 build produced, with v46's shipped receipt", () => {
    const { atV46, receipts } = upgradeThroughV46(v45Image("acp-v46f-v45-"));
    expect(atV46).toBe(V46_SCHEMA_DIGEST_FROM_V45);
    expect(receipts["v46-rowid-no-replace"]).toBe(V46_BASE_CHECKSUM);
  });

  it("a v44 image runs v45 then v46 and reaches both builds' schemas, with both shipped receipts", () => {
    const { atV45, atV46, receipts } = upgradeThroughV46(v44Image("acp-v46f-v44-"));
    expect(atV45).toBe(V45_SCHEMA_DIGEST_FROM_V44);
    expect(atV46).toBe(V46_SCHEMA_DIGEST_FROM_V45);
    expect(receipts).toEqual({
      "v45-first-manifest-activation": V45_BASE_CHECKSUM,
      "v46-rowid-no-replace": V46_BASE_CHECKSUM,
    });
  });

  it("a v11 image runs every step through v46 and reaches the v46 schema the v46 build produced", () => {
    const { atV46, receipts } = upgradeThroughV46(v11Image(privateStatePath("acp-v46f-v11-")));
    expect(atV46).toBe(V46_SCHEMA_DIGEST_FROM_V11);
    expect(receipts).toEqual({
      "v45-first-manifest-activation": V45_BASE_CHECKSUM,
      "v46-rowid-no-replace": V46_BASE_CHECKSUM,
    });
  });

  it("a fresh v46 create from the snapshot has the schema a v45 image reaches", () => {
    const path = freshV46CreateFromSnapshot(privateStatePath("acp-v46f-fresh-"));
    expect(digestOfSchemaRows(schemaRowsOf(path))).toBe(V46_SCHEMA_DIGEST_FROM_V45);
  });

  it("a database holding the v46 receipt reopens unchanged: schema, every table and user_version", () => {
    const path = v45Image("acp-v46f-reopen-");
    expect(upgradeThroughV46(path).receipts["v46-rowid-no-replace"]).toBe(V46_BASE_CHECKSUM);
    const before = contentDigests(path);
    expect(before.userVersion).toBe(SCHEMA_VERSION);
    new Db(path).close();
    expect(contentDigests(path)).toEqual(before);
  });
});
