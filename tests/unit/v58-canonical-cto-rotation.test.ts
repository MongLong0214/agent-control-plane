import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { Db } from "../../src/db/database.ts";
import { approveMigration } from "../../src/db/migration-approval.ts";
import { MIGRATIONS } from "../../src/db/migrations.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { releasedChainImage } from "../helpers/released-chain-image.ts";
import { privateStatePath, schemaRowsOf } from "../helpers/released-v44-schema.ts";
import { contentDigests } from "../helpers/released-v45-schema.ts";
import { V58_ADDED_TRIGGERS, V58_CHANGED_GUARDS } from "../helpers/released-v50-schema.ts";

afterAll(cleanupTempDirs);

const V58_OBJECTS = ["canonical_cto_rotations", ...V58_ADDED_TRIGGERS];

describe("v58 — the canonical CTO switchover table, and the one rewrite of an actor's target it admits", () => {
  it("v57 → v58 adds exactly its objects, replaces exactly the binding guard, keeps every row, and matches a fresh v58 database", () => {
    expect(MIGRATIONS.at(-1)).toMatchObject({ id: "v58-canonical-cto-rotation", fromVersion: 57, toVersion: 58 });
    const path = releasedChainImage(privateStatePath("acp-v58-from-v57-"), 57);
    const v57Rows = schemaRowsOf(path);
    const before = contentDigests(path, 57);
    expect(before.userVersion).toBe(57);
    approveMigration(path, "v57 → v58 witness");
    new Db(path).close();
    const after = contentDigests(path, 57);
    expect(after.userVersion).toBe(58);
    const { schema_migrations: _receiptsBefore, ...rowsBefore } = before.tables;
    const { schema_migrations: _receiptsAfter, ...rowsAfter } = after.tables;
    expect(rowsAfter).toEqual(rowsBefore);
    const upgraded = schemaRowsOf(path);
    // Every v57 object but the replaced guard is unchanged; the new ones are exactly v58's.
    for (const row of v57Rows.filter((old) => !V58_CHANGED_GUARDS.includes(old.name))) expect(upgraded).toContainEqual(row);
    const changed = upgraded.filter((row) => !v57Rows.some((old) => JSON.stringify(old) === JSON.stringify(row)));
    expect(changed.map((row) => row.name).filter((name) => !name.startsWith("sqlite_autoindex")).sort())
      .toEqual([...V58_OBJECTS, ...V58_CHANGED_GUARDS].sort());
    const freshPath = join(tempDir("acp-v58-fresh-"), "state.sqlite");
    new Db(freshPath).close();
    const fresh = schemaRowsOf(freshPath);
    const named = (rows: typeof fresh) => rows.filter((row) => [...V58_OBJECTS, ...V58_CHANGED_GUARDS].includes(row.name));
    expect(named(upgraded)).toEqual(named(fresh));
    expect(upgraded.map((row) => `${row.type} ${row.name}`).sort()).toEqual(fresh.map((row) => `${row.type} ${row.name}`).sort());
  });
});
