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

/**
 * #1189 — the run-state exits the CEO ruled on (B14, B15) are one schema step. It is built here on a
 * temporary database the released chain left at v53, never on a live one.
 *
 * The step is found by its id, not by its number, so the file still judges it once it is renumbered
 * behind another step at integration (only STEP_ID, FROM and the prior-version receipts change).
 */
const STEP_ID = "v54-run-state-exits";
const FROM = 53;
const V52_CHECKSUM = "sha256:0845cd390419398556f771eb137242c82a18fe138bc04d8eb09767a3a9bbbc56";
const REPLACED = ["runs_state_transition_guard", "runs_state_transition_authority_guard"];
const ADDED = ["runs_cancel_after_approval_requires_no_grant"];
const step = () => MIGRATIONS.find((migration) => migration.id === STEP_ID);

const AT = "2026-10-30T00:00:00.000Z";
const insertRun = (raw: Database.Database, runId: string, kind: string, state: string): void => {
  raw.prepare(`INSERT INTO runs (run_id, kind, execution_mode, priority, state, goal, contract_digest, created_at)
    VALUES (?, ?, 'STANDARD', 'NORMAL', ?, 'exit', 'sha256:c', ?)`).run(runId, kind, state, AT);
};

/** A grant row as CONFIRM writes one; the structural guards on the grant table admit it. */
const insertGrant = (raw: Database.Database, runId: string): void => {
  raw.prepare(`INSERT INTO manifest_activation_grants (grant_id, run_id, project_id, run_kind, manifest_digest,
      from_manifest_digest, plan_digest, candidate_snapshot_digest, packet_digest, ceo_assignment_id, ceo_actor_id,
      ceo_session_id, ceo_session_incarnation, ceo_binding_generation, issued_at, grant_digest, consumer_session_id,
      consumer_session_incarnation, consumer_bound_at)
    VALUES (?, ?, 'prj_exit', 'CONTRACT_CHANGE', 'sha256:m1', 'sha256:m0', 'sha256:plan', 'sha256:cand', 'sha256:packet',
      'asg_ceo', 'actor', 'ses_ceo', 'ses_ceo#1', 1, ?, ?, 'ses_ceo', 'ses_ceo#1', ?)`)
    .run(`grant_${runId}`, runId, AT, `sha256:grant-${runId}`, AT);
};

/** The fixture rows, written to the v53 image before the step. */
const seed = (raw: Database.Database): void => {
  insertRun(raw, "run_review_std", "STANDARD_WORK", RunState.READY_FOR_CEO_REVIEW);
  insertRun(raw, "run_review_boot", "PROJECT_BOOTSTRAP", RunState.READY_FOR_CEO_REVIEW);
  insertRun(raw, "run_cc_approved", "CONTRACT_CHANGE", RunState.CEO_APPROVED);
  insertRun(raw, "run_cc_merging", "CONTRACT_CHANGE", RunState.MERGING);
  insertRun(raw, "run_cc_verifying", "CONTRACT_CHANGE", RunState.POST_MERGE_VERIFYING);
  insertRun(raw, "run_cc_granted", "CONTRACT_CHANGE", RunState.CEO_APPROVED);
  insertRun(raw, "run_cc_blocked", "CONTRACT_CHANGE", RunState.BLOCKED_POST_MERGE);
  insertRun(raw, "run_std_approved", "STANDARD_WORK", RunState.CEO_APPROVED);
  insertRun(raw, "run_std_merging", "STANDARD_WORK", RunState.MERGING);
  insertGrant(raw, "run_cc_granted");
};

/** A v53 image with the fixture rows, approved, then migrated through this step only; the image at its end. */
const migrated = (prefix: string) => {
  const path = releasedChainImage(privateStatePath(prefix), FROM);
  const raw = new Database(path);
  raw.pragma("foreign_keys = OFF");
  seed(raw);
  raw.close();
  const before = { schema: schemaRowsOf(path), rows: (() => {
    const reader = new Database(path, { readonly: true });
    try {
      return {
        runs: reader.prepare("SELECT * FROM runs ORDER BY run_id").all(),
        grants: reader.prepare("SELECT * FROM manifest_activation_grants ORDER BY grant_id").all(),
        receipts: reader.prepare("SELECT * FROM schema_migrations ORDER BY version").all(),
      };
    } finally { reader.close(); }
  })() };
  approveMigration(path, "#1189 run-state exits");
  let image: Buffer | undefined;
  new Db(path, { afterMigration: (migration) => {
    if (migration.id !== STEP_ID) return;
    const reader = new Database(path, { readonly: true });
    try { image = reader.serialize(); } finally { reader.close(); }
  } }).close();
  expect(image).toBeDefined();
  writeFileSync(path, image!);
  return { path, before };
};

describe("#1189 run-state exits, as one schema step on a v53 database", () => {
  it("the step follows v53, and v52 and v53 are frozen byte for byte, v52 with the checksum it was released with", () => {
    const migration = step();
    expect(migration).toMatchObject({ id: STEP_ID, fromVersion: FROM, toVersion: FROM + 1 });
    expect(MIGRATIONS.at(-2)).toMatchObject({ id: "v53-verification-result-history", fromVersion: 52, toVersion: 53 });
    const blob = (bytes: Buffer): string => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    const v52 = readFileSync(new URL("../../src/db/schema-v52.sql", import.meta.url));
    expect(blob(v52)).toBe("4d92c12346efdb6096955d66fd83933c3a3a9eb5");
    expect(MIGRATIONS.find((entry) => entry.toVersion === 52)!.checksum()).toBe(V52_CHECKSUM);
    expect(v52.toString()).not.toContain("runs_cancel_after_approval_requires_no_grant");
    const v53 = readFileSync(new URL("../../src/db/schema-v53.sql", import.meta.url));
    expect(blob(v53)).toBe("9d37653bd7129313560f8c5259587a4d02844a06");
    expect(v53.toString()).not.toContain("runs_cancel_after_approval_requires_no_grant");
  });

  it("on a v53 image: CEO review and approval have no CANCELLED edge before the step", () => {
    const path = releasedChainImage(privateStatePath("acp-v54-before-"), FROM);
    const raw = new Database(path);
    try {
      raw.pragma("foreign_keys = OFF");
      seed(raw);
      raw.function("acp_run_state_transition_authorized", { varargs: true }, () => 1);
      const cancel = raw.prepare("UPDATE runs SET state = 'CANCELLED' WHERE run_id = ?");
      for (const runId of ["run_review_std", "run_review_boot", "run_cc_approved", "run_cc_merging", "run_cc_verifying"]) {
        expect(() => cancel.run(runId)).toThrow(/RUN_STATE_TRANSITION_ILLEGAL/);
      }
    } finally { raw.close(); }
  });

  it("changes only the two guards and adds one, keeps every row and receipt, and records its own receipt", () => {
    const { path, before } = migrated("acp-v54-up-");
    expect(userVersionOf(path)).toBe(FROM + 1);
    const after = schemaRowsOf(path);
    const touched = [...REPLACED, ...ADDED];
    expect(after.filter((row) => !touched.includes(row.name))).toEqual(before.schema.filter((row) => !touched.includes(row.name)));
    expect(after.filter((row) => touched.includes(row.name) && !before.schema.some((old) => old.name === row.name && old.sql === row.sql))
      .map((row) => row.name).sort()).toEqual([...touched].sort());
    // What a fresh database at this build holds is what the step left.
    const freshPath = privateStatePath("acp-v54-fresh-");
    new Db(freshPath).close();
    const fresh = schemaRowsOf(freshPath);
    for (const name of touched) {
      expect(after.find((row) => row.name === name)?.sql).toBe(fresh.find((row) => row.name === name)?.sql);
    }
    const raw = new Database(path, { readonly: true });
    try {
      expect(raw.prepare("SELECT * FROM runs ORDER BY run_id").all()).toEqual(before.rows.runs);
      expect(raw.prepare("SELECT * FROM manifest_activation_grants ORDER BY grant_id").all()).toEqual(before.rows.grants);
      expect(raw.prepare(`SELECT * FROM schema_migrations WHERE version <= ${FROM} ORDER BY version`).all()).toEqual(before.rows.receipts);
      expect(raw.prepare(`SELECT migration_id, checksum FROM schema_migrations WHERE version = ${FROM + 1}`).get())
        .toEqual({ migration_id: STEP_ID, checksum: step()!.checksum() });
    } finally { raw.close(); }
  });

  it("after the step: CEO review → CANCELLED for every kind, and past approval only a CONTRACT_CHANGE holding no grant; each still behind the authority marker", () => {
    const { path } = migrated("acp-v54-edges-");
    const raw = new Database(path);
    try {
      raw.pragma("foreign_keys = OFF");
      let authorized = 0;
      raw.function("acp_run_state_transition_authorized", { varargs: true }, () => authorized);
      const cancel = raw.prepare("UPDATE runs SET state = 'CANCELLED' WHERE run_id = ?");
      const stateOf = (runId: string) => raw.prepare("SELECT state FROM runs WHERE run_id = ?").pluck().get(runId);
      expect(() => cancel.run("run_review_std")).toThrow(/RUN_STATE_TRANSITION_AUTHORITY_DENIED/);
      expect(() => cancel.run("run_cc_approved")).toThrow(/RUN_STATE_TRANSITION_AUTHORITY_DENIED/);
      authorized = 1;
      // Refused: a granted CONTRACT_CHANGE, any other kind past approval, and a terminal block.
      for (const runId of ["run_cc_granted", "run_std_approved", "run_std_merging", "run_cc_blocked"]) {
        expect(() => cancel.run(runId)).toThrow(/RUN_STATE_TRANSITION_ILLEGAL/);
      }
      for (const runId of ["run_review_std", "run_review_boot", "run_cc_approved", "run_cc_merging", "run_cc_verifying"]) {
        cancel.run(runId);
        expect(stateOf(runId)).toBe(RunState.CANCELLED);
      }
      // A first-activation grant is asked the same way (its guards need a registered NULL-manifest project to insert one).
      const guard = raw.prepare("SELECT sql FROM sqlite_master WHERE name = 'runs_cancel_after_approval_requires_no_grant'").pluck().get() as string;
      expect(guard).toContain("manifest_first_activation_grants");
      expect(stateOf("run_cc_granted")).toBe(RunState.CEO_APPROVED);
    } finally { raw.close(); }
  });

  it("refuses a drifted guard rather than replacing a definition it does not know", () => {
    const path = releasedChainImage(privateStatePath("acp-v54-drift-"), FROM);
    const raw = new Database(path);
    try {
      raw.exec("DROP TRIGGER runs_state_transition_authority_guard; CREATE TRIGGER runs_state_transition_authority_guard BEFORE UPDATE OF state ON runs BEGIN SELECT 1; END;");
      expect(() => step()!.apply(raw)).toThrow(new RegExp(`v${FROM + 1} refuses`));
    } finally { raw.close(); }
  });
});
