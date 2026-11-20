import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";

import { Db, SCHEMA_VERSION } from "../../src/db/database.ts";
import { approveMigration } from "../../src/db/migration-approval.ts";
import { MIGRATIONS } from "../../src/db/migrations.ts";
import { RunKind, RunState } from "../../src/domain/types.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { releasedChainImage } from "../helpers/released-chain-image.ts";
import { privateStatePath, schemaRowsOf, userVersionOf } from "../helpers/released-v44-schema.ts";

afterAll(cleanupTempDirs);

/** v59's receipt as the build before its freeze computed it, from schema.sql at 744e9bef. */
const V59_CHECKSUM = "sha256:3729cfa5817040d8967779ae0af8772cd7e79c2042ea4a6c3cb1f34d1245705e";
const TRIGGER = "runs_review_completion_bootstrap_only";

const insertRun = (raw: Database.Database, runId: string, kind: string): void => {
  raw.prepare(`INSERT INTO runs (run_id, kind, execution_mode, priority, state, goal, contract_digest, created_at)
    VALUES (?, ?, 'STANDARD', 'NORMAL', ?, 'review', 'sha256:c', '2026-11-20')`).run(runId, kind, RunState.READY_FOR_CEO_REVIEW);
};

describe("v59 → v60 review completion is PROJECT_BOOTSTRAP's alone", () => {
  it("freezes v59 byte for byte, keeps v59's released checksum, and chains v60 after v59", () => {
    const bytes = readFileSync(new URL("../../src/db/schema-v59.sql", import.meta.url));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe("ebcc06641ab3ceadbcb2d2dcf81092593efff11d9353ea515ff884bdacd0d2a6");
    expect(createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex")).toBe("7c2c8a2a6381dcd862217020a3ed97c097531b55");
    expect(bytes.toString()).not.toContain(TRIGGER);
    expect(MIGRATIONS.find((step) => step.toVersion === 59)!.checksum()).toBe(V59_CHECKSUM);
    expect(SCHEMA_VERSION).toBe(60);
    expect(MIGRATIONS.slice(-2).map((step) => [step.id, step.fromVersion, step.toVersion])).toEqual([
      ["v59-task-plan-key", 58, 59],
      ["v60-review-completion-bootstrap-only", 59, 60],
    ]);
  });

  it("adds only the trigger, keeps every row, and refuses review → COMPLETED for every kind but PROJECT_BOOTSTRAP", () => {
    const path = releasedChainImage(privateStatePath("acp-v60-up-"), 59);
    const beforeSchema = schemaRowsOf(path);
    const before = new Database(path);
    insertRun(before, "run_standard", RunKind.STANDARD_WORK);
    insertRun(before, "run_contract", RunKind.CONTRACT_CHANGE);
    insertRun(before, "run_bootstrap", RunKind.PROJECT_BOOTSTRAP);
    before.function("acp_run_state_transition_authorized", { varargs: true }, () => 1);
    // v59, red: a STANDARD_WORK run completes straight from review with the marker set.
    before.exec("BEGIN");
    before.prepare("UPDATE runs SET state = 'COMPLETED' WHERE run_id = 'run_standard'").run();
    before.exec("ROLLBACK");
    const rows = before.prepare("SELECT * FROM runs ORDER BY run_id").all();
    const receipts = before.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
    before.close();

    approveMigration(path, "v60 review completion bootstrap only");
    let at60: Buffer | undefined;
    new Db(path, { afterMigration: (migration) => {
      if (migration.toVersion !== 60) return;
      const reader = new Database(path, { readonly: true });
      try { at60 = reader.serialize(); } finally { reader.close(); }
    } }).close();
    expect(at60).toBeDefined();
    writeFileSync(path, at60!);
    expect(userVersionOf(path)).toBe(60);
    const afterSchema = schemaRowsOf(path);
    expect(afterSchema.filter((row) => row.name !== TRIGGER)).toEqual(beforeSchema);
    expect(afterSchema.filter((row) => row.name === TRIGGER)).toHaveLength(1);

    const raw = new Database(path);
    try {
      expect(raw.prepare("SELECT * FROM runs ORDER BY run_id").all()).toEqual(rows);
      expect(raw.prepare("SELECT * FROM schema_migrations WHERE version <= 59 ORDER BY version").all()).toEqual(receipts);
      expect(raw.prepare("SELECT migration_id, checksum FROM schema_migrations WHERE version = 60").get()).toEqual({
        migration_id: "v60-review-completion-bootstrap-only", checksum: MIGRATIONS.find((step) => step.toVersion === 60)!.checksum(),
      });
      raw.function("acp_run_state_transition_authorized", { varargs: true }, () => 1);
      const complete = raw.prepare("UPDATE runs SET state = 'COMPLETED' WHERE run_id = ?");
      for (const runId of ["run_standard", "run_contract"]) {
        expect(() => complete.run(runId), runId).toThrow(/RUN_STATE_TRANSITION_ILLEGAL/);
      }
      complete.run("run_bootstrap");
      expect(raw.prepare("SELECT state FROM runs WHERE run_id = 'run_bootstrap'").pluck().get()).toBe(RunState.COMPLETED);
    } finally { raw.close(); }
  });

  it("refuses a drifted trigger rather than replacing an unknown definition", () => {
    const path = releasedChainImage(privateStatePath("acp-v60-drift-"), 59);
    const raw = new Database(path);
    try {
      raw.exec(`CREATE TRIGGER ${TRIGGER} BEFORE UPDATE OF state ON runs BEGIN SELECT 1; END;`);
      expect(() => MIGRATIONS.find((step) => step.toVersion === 60)!.apply(raw)).toThrow(/v60 refuses/);
    } finally { raw.close(); }
  });
});
