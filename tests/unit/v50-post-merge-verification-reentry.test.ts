import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";

import { Db } from "../../src/db/database.ts";
import { approveMigration } from "../../src/db/migration-approval.ts";
import { MIGRATIONS } from "../../src/db/migrations.ts";
import { RunState } from "../../src/domain/types.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { releasedChainImage } from "../helpers/released-chain-image.ts";
import { privateStatePath, schemaRowsOf, userVersionOf } from "../helpers/released-v44-schema.ts";

afterAll(cleanupTempDirs);

const V49_CHECKSUM = "sha256:9a3b1287045bc5857c8415d2018ccfc267d31910bd1e6ab57fbc200b791c59b0";
const GUARDS = ["runs_state_transition_guard", "runs_state_transition_authority_guard"];

describe("v49 → v50 post-merge re-entry", () => {
  it("freezes v49 byte-for-byte and keeps its original migration checksum", () => {
    const bytes = readFileSync(new URL("../../src/db/schema-v49.sql", import.meta.url));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe("945685a38f7413f01944d3e09171a6b722de4bb618a783f604de1f484de00684");
    expect(createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex")).toBe("fa96bf02b980c8d7f1e81851ad2223a2cfea2cbb");
    expect(MIGRATIONS.find((step) => step.toVersion === 49)!.checksum()).toBe(V49_CHECKSUM);
    expect(bytes.toString()).not.toContain("OLD.state = 'BLOCKED_POST_MERGE'");
  });

  it("changes only the two guards, preserves data and receipts, and requires the authority marker for exactly one new edge", () => {
    const path = releasedChainImage(privateStatePath("acp-v50-up-"), 49);
    const beforeSchema = schemaRowsOf(path);
    const before = new Database(path);
    before.prepare(`INSERT INTO runs (run_id, kind, execution_mode, priority, state, goal, contract_digest, created_at)
      VALUES ('run_recover', 'STANDARD_WORK', 'STANDARD', 'NORMAL', 'BLOCKED_POST_MERGE', 'recover', 'sha256:c', '2026-10-20')`).run();
    before.function("acp_run_state_transition_authorized", { varargs: true }, () => 1);
    expect(() => before.prepare("UPDATE runs SET state = 'POST_MERGE_VERIFYING' WHERE run_id = 'run_recover'").run()).toThrow(/RUN_STATE_TRANSITION_ILLEGAL/);
    const rows = before.prepare("SELECT * FROM runs").all();
    const receipts = before.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
    before.close();
    approveMigration(path, "v50 post-merge re-entry");
    let at50: Buffer | undefined;
    new Db(path,{afterMigration:m => {if (m.toVersion === 50) {const reader = new Database(path,{readonly:true});try {at50 = reader.serialize();} finally {reader.close();}}}}).close();
    // This test judges the released v50 boundary, before later additive steps.
    expect(at50).toBeDefined();writeFileSync(path,at50!);
    expect(userVersionOf(path)).toBe(50);
    const afterSchema = schemaRowsOf(path);
    expect(afterSchema.filter((row) => !GUARDS.includes(row.name))).toEqual(beforeSchema.filter((row) => !GUARDS.includes(row.name)));
    expect(afterSchema.filter((row) => GUARDS.includes(row.name) && !beforeSchema.some((old) => old.name === row.name && old.sql === row.sql)).map((row) => row.name).sort()).toEqual([...GUARDS].sort());
    const raw = new Database(path);
    try {
      expect(raw.prepare("SELECT * FROM runs").all()).toEqual(rows);
      expect(raw.prepare("SELECT * FROM schema_migrations WHERE version <= 49 ORDER BY version").all()).toEqual(receipts);
      expect(raw.prepare("SELECT migration_id, checksum FROM schema_migrations WHERE version = 50").get()).toEqual({
        migration_id: "v50-post-merge-verification-reentry", checksum: MIGRATIONS.find((step) => step.toVersion === 50)!.checksum(),
      });
      let authorized = 0;
      raw.function("acp_run_state_transition_authorized", { varargs: true }, () => authorized);
      const update = raw.prepare("UPDATE runs SET state = ? WHERE run_id = 'run_recover'");
      expect(() => update.run(RunState.POST_MERGE_VERIFYING)).toThrow(/RUN_STATE_TRANSITION_AUTHORITY_DENIED/);
      authorized = 1;
      for (const target of Object.values(RunState).filter((state) => state !== RunState.BLOCKED_POST_MERGE && state !== RunState.POST_MERGE_VERIFYING)) {
        expect(() => update.run(target)).toThrow(/RUN_STATE_TRANSITION_ILLEGAL/);
      }
      update.run(RunState.POST_MERGE_VERIFYING);
      expect(raw.prepare("SELECT state FROM runs WHERE run_id = 'run_recover'").pluck().get()).toBe(RunState.POST_MERGE_VERIFYING);
    } finally { raw.close(); }
  });

  it("refuses a drifted guard rather than replacing an unknown definition", () => {
    const path = releasedChainImage(privateStatePath("acp-v50-drift-"), 49);
    const raw = new Database(path);
    try {
      raw.exec("DROP TRIGGER runs_state_transition_guard; CREATE TRIGGER runs_state_transition_guard BEFORE UPDATE OF state ON runs BEGIN SELECT 1; END;");
      expect(() => MIGRATIONS.find((step) => step.toVersion === 50)!.apply(raw)).toThrow(/v50 refuses/);
    } finally { raw.close(); }
  });
});
