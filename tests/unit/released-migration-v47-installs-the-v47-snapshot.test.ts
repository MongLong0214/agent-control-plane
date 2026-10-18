import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";

import { Db } from "../../src/db/database.ts";
import { approveMigration } from "../../src/db/migration-approval.ts";
import { MIGRATIONS, SCHEMA_VERSION } from "../../src/db/migrations.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { releasedChainImage } from "../helpers/released-chain-image.ts";
import { digestOfSchemaRows, gitBlobId, privateStatePath, schemaRowsOf, v11Image } from "../helpers/released-v44-schema.ts";
import { contentDigests, V45_BASE_CHECKSUM } from "../helpers/released-v45-schema.ts";
import { V46_BASE_CHECKSUM, V46_SCHEMA_DIGEST_FROM_V11 } from "../helpers/released-v46-schema.ts";
import {
  freshV47CreateFromSnapshot,
  V47_BASE_CHECKSUM,
  V47_CANDIDATE_CHECKSUM,
  V47_FRESH_SCHEMA_DIGEST,
  V47_SCHEMA_DIGEST_FROM_RELEASED_CHAIN,
  V47_SNAPSHOT_GIT_BLOB,
  V47_SNAPSHOT_PATH,
  V47_SNAPSHOT_SHA256,
} from "../helpers/released-v47-schema.ts";

afterAll(cleanupTempDirs);

/**
 * The v47 freeze (source level), as #1140 froze v45 and the v46 freeze followed: v47 reads
 * `schema-v47.sql`, not the live schema, and still produces exactly what the v47 build produced — the
 * same `sqlite_schema`. Its receipt checksum is the corrected one (FIX-SEC-R2: the step now refuses
 * canonical labels written before its guard, and its checksum covers that), never the candidate's. The
 * expected values are transcribed in the helper; nothing here derives them from the snapshot it is
 * checking. Historical images come from the released chain (`releasedChainImage`), never from taking a
 * newer database back.
 */

const V45 = MIGRATIONS.find((migration) => migration.id === "v45-first-manifest-activation")!;
const V46 = MIGRATIONS.find((migration) => migration.id === "v46-rowid-no-replace")!;
const V47 = MIGRATIONS.find((migration) => migration.id === "v47-owner-decision-authority-guard")!;

interface Upgrade {
  atV46: string | undefined;
  atV47: string;
  receipts: Record<string, string>;
}

/** Runs the approved chain with this checkout's code; returns the schema at v46 and v47, and the v45–v47 receipts. */
const upgradeThroughV47 = (path: string): Upgrade => {
  approveMigration(path, "v47 freeze source-level witness");
  const at: Record<number, string> = {};
  new Db(path, {
    afterMigration: (migration) => {
      if (migration.toVersion === 46 || migration.toVersion === 47) at[migration.toVersion] = digestOfSchemaRows(schemaRowsOf(path));
    },
  }).close();
  expect(at[47]).toBeDefined();
  const db = new Db(path);
  try {
    const rows = db.all<{ migration_id: string; checksum: string }>(
      "SELECT migration_id, checksum FROM schema_migrations WHERE version IN (45, 46, 47) ORDER BY version",
    );
    return { atV46: at[46], atV47: at[47]!, receipts: Object.fromEntries(rows.map((row) => [row.migration_id, row.checksum])) };
  } finally {
    db.close();
  }
};

/** Every receipt at or below `version`, every column. */
const receiptsThrough = (path: string, version: number): unknown[] => {
  const raw = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return raw.prepare("SELECT * FROM schema_migrations WHERE version <= ? ORDER BY version").all(version);
  } finally {
    raw.close();
  }
};

describe("the v47 freeze: the released v47 step installs the v47 snapshot", () => {
  it("the snapshot is the v47 canonical schema.sql, byte for byte", () => {
    const bytes = readFileSync(new URL(`../../${V47_SNAPSHOT_PATH}`, import.meta.url));
    expect(gitBlobId(bytes)).toBe(V47_SNAPSHOT_GIT_BLOB);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(V47_SNAPSHOT_SHA256);
  });

  it("v46 and v45 keep the full receipt checksums they shipped with, and v47 has the corrected one, in the step and in the checksum map", () => {
    expect(V47).toMatchObject({ fromVersion: 46, toVersion: 47 });
    expect(V47.checksum()).toBe(V47_BASE_CHECKSUM);
    // FIX-SEC-R2 (CEO 85eac6ef option B): the unreleased candidate's receipt is told apart from this step's.
    expect(V47_BASE_CHECKSUM).not.toBe(V47_CANDIDATE_CHECKSUM);
    expect(V46.checksum()).toBe(V46_BASE_CHECKSUM);
    expect(V45.checksum()).toBe(V45_BASE_CHECKSUM);
    const manifest = JSON.parse(readFileSync(new URL("../../src/db/migration-checksums.json", import.meta.url), "utf8")) as {
      live: Record<string, string>;
    };
    expect(manifest.live["v47-owner-decision-authority-guard"]).toBe(V47_BASE_CHECKSUM);
    expect(manifest.live["v46-rowid-no-replace"]).toBe(V46_BASE_CHECKSUM);
    expect(manifest.live["v45-first-manifest-activation"]).toBe(V45_BASE_CHECKSUM);
  });

  it("the released v46 image reaches the v47 schema the v47 build produced, with v47's shipped receipt and every earlier receipt unchanged", () => {
    const path = releasedChainImage(privateStatePath("acp-v47f-v46-"), 46);
    const before = receiptsThrough(path, 46);
    const { atV46, atV47, receipts } = upgradeThroughV47(path);
    expect(atV46).toBeUndefined();
    expect(atV47).toBe(V47_SCHEMA_DIGEST_FROM_RELEASED_CHAIN);
    expect(receipts["v47-owner-decision-authority-guard"]).toBe(V47_BASE_CHECKSUM);
    expect(receiptsThrough(path, 46)).toEqual(before);
  });

  it("the released v45 image runs v46 then v47 and reaches both builds' schemas, with every shipped receipt", () => {
    const { atV46, atV47, receipts } = upgradeThroughV47(releasedChainImage(privateStatePath("acp-v47f-v45-"), 45));
    expect(atV46).toBe(V46_SCHEMA_DIGEST_FROM_V11);
    expect(atV47).toBe(V47_SCHEMA_DIGEST_FROM_RELEASED_CHAIN);
    expect(receipts).toEqual({
      "v45-first-manifest-activation": V45_BASE_CHECKSUM,
      "v46-rowid-no-replace": V46_BASE_CHECKSUM,
      "v47-owner-decision-authority-guard": V47_BASE_CHECKSUM,
    });
  });

  it("a v11 image runs every step through v47 and reaches the v47 schema the v47 build produced", () => {
    const { atV46, atV47, receipts } = upgradeThroughV47(v11Image(privateStatePath("acp-v47f-v11-")));
    expect(atV46).toBe(V46_SCHEMA_DIGEST_FROM_V11);
    expect(atV47).toBe(V47_SCHEMA_DIGEST_FROM_RELEASED_CHAIN);
    expect(receipts).toEqual({
      "v45-first-manifest-activation": V45_BASE_CHECKSUM,
      "v46-rowid-no-replace": V46_BASE_CHECKSUM,
      "v47-owner-decision-authority-guard": V47_BASE_CHECKSUM,
    });
  });

  it("a fresh v47 create from the snapshot has the schema the v47 build's fresh create had", () => {
    const path = freshV47CreateFromSnapshot(privateStatePath("acp-v47f-fresh-"));
    expect(digestOfSchemaRows(schemaRowsOf(path))).toBe(V47_FRESH_SCHEMA_DIGEST);
  });

  it("a database holding the v47 receipt reopens unchanged: schema, every table and user_version", () => {
    const path = releasedChainImage(privateStatePath("acp-v47f-reopen-"), 46);
    expect(upgradeThroughV47(path).receipts["v47-owner-decision-authority-guard"]).toBe(V47_BASE_CHECKSUM);
    const before = contentDigests(path);
    expect(before.userVersion).toBe(SCHEMA_VERSION);
    new Db(path).close();
    expect(contentDigests(path)).toEqual(before);
  });
});
