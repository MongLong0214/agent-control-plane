import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";

import { Db, SCHEMA_VERSION } from "../../src/db/database.ts";
import { approveMigration } from "../../src/db/migration-approval.ts";
import { MIGRATIONS } from "../../src/db/migrations.ts";
import { RunState } from "../../src/domain/types.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { releasedChainImage } from "../helpers/released-chain-image.ts";
import { privateStatePath, schemaRowsOf, userVersionOf } from "../helpers/released-v44-schema.ts";

afterAll(cleanupTempDirs);

/** v52's receipt as the build before its freeze computed it, from schema.sql at 5d45ae8b. */
const V52_CHECKSUM = "sha256:0845cd390419398556f771eb137242c82a18fe138bc04d8eb09767a3a9bbbc56";
const GUARDS = ["runs_state_transition_guard", "runs_state_transition_authority_guard"];

/** The run states v52 lets a CEO_APPROVED or MERGING run move to, named here rather than read from the code under test. */
const V52_TARGETS: Readonly<Record<string, readonly string[]>> = {
  [RunState.CEO_APPROVED]: [RunState.MERGING],
  [RunState.MERGING]: [RunState.POST_MERGE_VERIFYING, RunState.BLOCKED_POST_MERGE],
};

const insertRun = (raw: Database.Database, runId: string, state: string): void => {
  raw.prepare(`INSERT INTO runs (run_id, kind, execution_mode, priority, state, goal, contract_digest, created_at)
    VALUES (?, 'STANDARD_WORK', 'STANDARD', 'NORMAL', ?, 'revise', 'sha256:c', '2026-10-27')`).run(runId, state);
};

describe("v52 → v53 approved-run revision re-entry", () => {
  it("freezes v52 byte for byte, keeps its released checksum, and chains v53 after it", () => {
    const bytes = readFileSync(new URL("../../src/db/schema-v52.sql", import.meta.url));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe("f0d5f8ac7272a1d26a092f99e4dc75c97a24fe75cdf46f5707e4a54d294b5dc1");
    expect(createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex")).toBe("4d92c12346efdb6096955d66fd83933c3a3a9eb5");
    expect(MIGRATIONS.find((step) => step.toVersion === 52)!.checksum()).toBe(V52_CHECKSUM);
    expect(bytes.toString()).toContain("(OLD.state = 'CEO_APPROVED' AND NEW.state IN ('MERGING')) OR");
    expect(SCHEMA_VERSION).toBe(53);
    expect(MIGRATIONS.slice(-2).map((step) => [step.id, step.fromVersion, step.toVersion])).toEqual([
      ["v52-resident-project-provisioning", 51, 52],
      ["v53-approved-run-revision-reentry", 52, 53],
    ]);
  });

  it("changes only the two guards, keeps every row, and opens CEO_APPROVED/MERGING → REVISION_REQUIRED only behind the marker", () => {
    const path = releasedChainImage(privateStatePath("acp-v53-up-"), 52);
    const beforeSchema = schemaRowsOf(path);
    const before = new Database(path);
    insertRun(before, "run_approved", RunState.CEO_APPROVED);
    insertRun(before, "run_merging", RunState.MERGING);
    before.function("acp_run_state_transition_authorized", { varargs: true }, () => 1);
    // v52, red: neither edge exists, even with the marker.
    for (const runId of ["run_approved", "run_merging"]) {
      expect(() => before.prepare("UPDATE runs SET state = 'REVISION_REQUIRED' WHERE run_id = ?").run(runId))
        .toThrow(/RUN_STATE_TRANSITION_ILLEGAL/);
    }
    const rows = before.prepare("SELECT * FROM runs ORDER BY run_id").all();
    const receipts = before.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
    before.close();

    approveMigration(path, "v53 approved-run revision re-entry");
    let at53: Buffer | undefined;
    new Db(path, { afterMigration: (migration) => {
      if (migration.toVersion !== 53) return;
      const reader = new Database(path, { readonly: true });
      try { at53 = reader.serialize(); } finally { reader.close(); }
    } }).close();
    expect(at53).toBeDefined();
    writeFileSync(path, at53!);
    expect(userVersionOf(path)).toBe(53);
    const afterSchema = schemaRowsOf(path);
    expect(afterSchema.filter((row) => !GUARDS.includes(row.name))).toEqual(beforeSchema.filter((row) => !GUARDS.includes(row.name)));
    expect(afterSchema.filter((row) => GUARDS.includes(row.name) && !beforeSchema.some((old) => old.name === row.name && old.sql === row.sql))
      .map((row) => row.name).sort()).toEqual([...GUARDS].sort());

    const raw = new Database(path);
    try {
      expect(raw.prepare("SELECT * FROM runs ORDER BY run_id").all()).toEqual(rows);
      expect(raw.prepare("SELECT * FROM schema_migrations WHERE version <= 52 ORDER BY version").all()).toEqual(receipts);
      expect(raw.prepare("SELECT migration_id, checksum FROM schema_migrations WHERE version = 53").get()).toEqual({
        migration_id: "v53-approved-run-revision-reentry", checksum: MIGRATIONS.find((step) => step.toVersion === 53)!.checksum(),
      });
      let authorized = 0;
      raw.function("acp_run_state_transition_authorized", { varargs: true }, () => authorized);
      const update = raw.prepare("UPDATE runs SET state = ? WHERE run_id = ?");
      for (const runId of ["run_approved", "run_merging"]) {
        expect(() => update.run(RunState.REVISION_REQUIRED, runId)).toThrow(/RUN_STATE_TRANSITION_AUTHORITY_DENIED/);
      }
      authorized = 1;
      for (const [runId, from] of [["run_approved", RunState.CEO_APPROVED], ["run_merging", RunState.MERGING]] as const) {
        const illegal = Object.values(RunState).filter((state) =>
          state !== from && state !== RunState.REVISION_REQUIRED && !V52_TARGETS[from]!.includes(state));
        for (const target of illegal) expect(() => update.run(target, runId), `${from} → ${target}`).toThrow(/RUN_STATE_TRANSITION_ILLEGAL/);
        update.run(RunState.REVISION_REQUIRED, runId);
        expect(raw.prepare("SELECT state FROM runs WHERE run_id = ?").pluck().get(runId)).toBe(RunState.REVISION_REQUIRED);
      }
    } finally { raw.close(); }
  });

  it("refuses a drifted guard rather than replacing an unknown definition", () => {
    const path = releasedChainImage(privateStatePath("acp-v53-drift-"), 52);
    const raw = new Database(path);
    try {
      raw.exec("DROP TRIGGER runs_state_transition_authority_guard; CREATE TRIGGER runs_state_transition_authority_guard BEFORE UPDATE OF state ON runs BEGIN SELECT 1; END;");
      expect(() => MIGRATIONS.find((step) => step.toVersion === 53)!.apply(raw)).toThrow(/v53 refuses/);
    } finally { raw.close(); }
  });
});
