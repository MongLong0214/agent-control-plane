import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { Db } from "../../src/db/database.ts";
import { approveMigration } from "../../src/db/migration-approval.ts";
import { MIGRATIONS } from "../../src/db/migrations.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { releasedChainImage } from "../helpers/released-chain-image.ts";
import { privateStatePath, schemaRowsOf } from "../helpers/released-v44-schema.ts";
import { contentDigests } from "../helpers/released-v45-schema.ts";
import { V60_ADDED_TRIGGERS } from "../helpers/released-v50-schema.ts";

afterAll(cleanupTempDirs);

describe("v59 — tasks.plan_key, the PLAN's own key for a task (#1413)", () => {
  it("v58 → v59 adds exactly the column and its index, keeps every row with a NULL key, and matches a fresh v59 database", () => {
    expect(MIGRATIONS.find((step) => step.toVersion === 59)).toMatchObject({ id: "v59-task-plan-key", fromVersion: 58, toVersion: 59 });
    const path = releasedChainImage(privateStatePath("acp-v59-from-v58-"), 58);
    const v58Rows = schemaRowsOf(path);
    const before = contentDigests(path, 58);
    expect(before.userVersion).toBe(58);
    approveMigration(path, "v58 → v59 witness");
    new Db(path).close();
    const after = contentDigests(path, 58);
    expect(after.userVersion).toBe(60);
    const { schema_migrations: _receiptsBefore, ...rowsBefore } = before.tables;
    const { schema_migrations: _receiptsAfter, ...rowsAfter } = after.tables;
    expect(rowsAfter).toEqual(rowsBefore);
    const upgraded = schemaRowsOf(path);
    // The chain runs on through v60, whose trigger is v60's test's to account for.
    const changed = upgraded.filter((row) => !V60_ADDED_TRIGGERS.includes(row.name) && !v58Rows.some((old) => JSON.stringify(old) === JSON.stringify(row)));
    expect(changed.map((row) => `${row.type} ${row.name}`).sort()).toEqual(["index tasks_run_plan_key", "table tasks"]);
    const freshPath = join(tempDir("acp-v59-fresh-"), "state.sqlite");
    new Db(freshPath).close();
    const fresh = schemaRowsOf(freshPath);
    expect(upgraded.map((row) => `${row.type} ${row.name}`).sort()).toEqual(fresh.map((row) => `${row.type} ${row.name}`).sort());
    // The stored text agrees too: the migrated tasks row and index are the fresh database's, byte for byte.
    const named = (rows: typeof fresh) => rows.filter((row) => ["tasks", "tasks_run_plan_key"].includes(row.name));
    expect(named(upgraded)).toEqual(named(fresh));
    const key = (file: string) => new Db(file).all<{ name: string; type: string; notnull: number }>(`SELECT name, type, "notnull" FROM pragma_table_info('tasks') WHERE name = 'plan_key'`);
    expect(key(path)).toEqual([{ name: "plan_key", type: "TEXT", notnull: 0 }]);
    expect(key(freshPath)).toEqual(key(path));
  });
});
