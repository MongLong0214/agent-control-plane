import Database from "better-sqlite3";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { isAcpError } from "../../src/core/errors.ts";
import { SCHEMA_VERSION, openDb } from "../../src/db/database.ts";
import { approveMigration } from "../../src/db/migration-approval.ts";
import { installMigrationLedger } from "../../src/db/migrations.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { fileCore, seedWorkerWorld } from "../helpers/worker-turn-fixture.ts";

/**
 * Issue #246 PR-C slice C3, schema v43 — the bootstrap application record, as the database states
 * it. Every row writes raw SQL, the way a writer that bypassed `BootstrapApplications` would; the
 * migration rows build a v42 image the way the v40–v42 fixtures build theirs: written at the current
 * version with real rows, then taken back by removing exactly what v43 adds.
 */

afterAll(cleanupTempDirs);

const NOW = "2026-10-09T00:00:00.000Z";

const V43_TRIGGERS = [
  "bootstrap_applications_born_reserved",
  "bootstrap_applications_identity_immutable",
  "bootstrap_applications_no_delete",
  "bootstrap_applications_no_replace",
  "bootstrap_applications_phase_forward",
];

const statePath = (): string => {
  const root = join(tempDir("acp-v43-"), "state");
  mkdirSync(root, { recursive: true });
  chmodSync(root, 0o700);
  return join(root, "state.sqlite");
};

const names = (raw: Database.Database, type: "table" | "trigger"): string[] =>
  (raw.prepare(`SELECT name FROM sqlite_master WHERE type = ? ORDER BY name`).all(type) as { name: string }[])
    .map((row) => row.name);

const dump = (raw: Database.Database, except: readonly string[]): Record<string, string[]> =>
  Object.fromEntries(
    names(raw, "table")
      .filter((name) => !except.includes(name) && !name.startsWith("sqlite_"))
      .map((name) => [name, (raw.prepare(`SELECT * FROM "${name}"`).all() as unknown[]).map((row) => JSON.stringify(row)).sort()]),
  );

const COLUMNS = `run_id, project_id, repository_identity, bootstrap_operation_id, plan_digest, manifest_digest,
  planned_outputs_digest, candidate_snapshot_digest, review_digest, approval_digest, phase, attempts,
  last_refusal_json, reserved_at`;

const reservation = (runId: string, overrides: Record<string, unknown> = {}): unknown[] => {
  const row: Record<string, unknown> = {
    run_id: runId,
    project_id: "prj_reserved",
    repository_identity: "github:acme/reserved",
    bootstrap_operation_id: "op-bootstrap",
    plan_digest: "sha256:plan",
    manifest_digest: "sha256:manifest",
    planned_outputs_digest: "sha256:outputs",
    candidate_snapshot_digest: "sha256:candidate",
    review_digest: "sha256:review",
    approval_digest: "sha256:approval",
    phase: "RESERVED",
    attempts: 0,
    last_refusal_json: null,
    reserved_at: NOW,
    ...overrides,
  };
  return COLUMNS.split(",").map((column) => row[column.trim()]);
};

const insert = (verb = "INSERT") =>
  `${verb} INTO bootstrap_applications (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/** A database at the current version with one run, and its path. */
const currentDatabase = () => {
  const path = statePath();
  const world = seedWorkerWorld(fileCore(path));
  return { path, world };
};

/** Written at the current version with real rows, then taken back to v42. */
const v42Image = (seed?: (raw: Database.Database) => void): { path: string; before: Record<string, string[]> } => {
  const { path, world } = currentDatabase();
  world.db.run(
    `INSERT INTO audit_events (at, kind, reason_code, actor, evidence_json) VALUES (?, 'WRITTEN_BEFORE_V43', 'OK', 'test', '{}')`,
    [NOW],
  );
  world.db.close();
  const legacy = new Database(path);
  try {
    legacy.exec(V43_TRIGGERS.map((name) => `DROP TRIGGER ${name};`).join("\n"));
    legacy.exec(`DROP TABLE bootstrap_applications`);
    seed?.(legacy);
    legacy.exec(`
      DROP TRIGGER schema_migrations_no_delete;
      DROP TRIGGER schema_migrations_insert_authority;
      DELETE FROM schema_migrations WHERE version > 42;
      INSERT INTO schema_migrations (version, migration_id, checksum, applied_at)
        VALUES (42, 'bootstrap-v42', 'sha256:${"0".repeat(64)}', '${NOW}');
      PRAGMA user_version = 42;
    `);
    installMigrationLedger(legacy);
    expect(names(legacy, "trigger").filter((name) => V43_TRIGGERS.includes(name))).toEqual([]);
    return { path, before: dump(legacy, ["schema_migrations", "bootstrap_applications"]) };
  } finally {
    legacy.close();
  }
};

describe("v43: the bootstrap application record (#246 C3)", () => {
  it("names every v43 trigger in the required-trigger registry", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const source = readFileSync(fileURLToPath(new URL("../../src/db/migrations.ts", import.meta.url)), "utf8");
    const introduced = [...source.matchAll(/\{ name: "([a-z_]+)", sentinel: [^}]*introducedIn: 43 \}/g)].map((match) => match[1]!).sort();
    expect(introduced).toEqual([...V43_TRIGGERS].sort());
  });

  it("v42 → v43 installs the table and its triggers, keeps every row, and the guards bite from the first write", () => {
    const { path, before } = v42Image();
    approveMigration(path, "v42 to v43 fixture");
    const migrated = openDb(path);
    try {
      expect(SCHEMA_VERSION).toBe(43);
      expect(Number(migrated.raw.pragma("user_version", { simple: true }))).toBe(43);
      expect(migrated.all<{ version: number; migration_id: string }>(
        `SELECT version, migration_id FROM schema_migrations WHERE version >= 42 ORDER BY version`,
      )).toEqual([
        { version: 42, migration_id: "bootstrap-v42" },
        { version: 43, migration_id: "v43-bootstrap-application-record" },
      ]);
      const objects = (type: string) =>
        migrated.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = ?`, [type]).map((row) => row.name);
      expect(objects("table")).toContain("bootstrap_applications");
      for (const name of V43_TRIGGERS) expect(objects("trigger"), name).toContain(name);
      const runId = migrated.get<{ run_id: string }>(`SELECT run_id FROM runs LIMIT 1`)!.run_id;
      migrated.run(insert(), reservation(runId));
      expect(() => migrated.run(`DELETE FROM bootstrap_applications WHERE run_id = ?`, [runId])).toThrow(/BOOTSTRAP_APPLICATION_IMMUTABLE/);
    } finally {
      migrated.close();
    }
    const after = new Database(path, { readonly: true });
    try {
      expect(dump(after, ["schema_migrations", "bootstrap_applications", "audit_events"])).toEqual(
        Object.fromEntries(Object.entries(before).filter(([name]) => name !== "audit_events")),
      );
      expect(dump(after, ["schema_migrations"])["audit_events"]).toEqual(expect.arrayContaining(before["audit_events"]!));
    } finally {
      after.close();
    }
  });

  it.each([
    ["populated", (raw: Database.Database) => {
      const runId = (raw.prepare(`SELECT run_id FROM runs LIMIT 1`).get() as { run_id: string }).run_id;
      raw.exec(`CREATE TABLE bootstrap_applications (
        run_id TEXT NOT NULL PRIMARY KEY, project_id TEXT NOT NULL, repository_identity TEXT NOT NULL,
        bootstrap_operation_id TEXT NOT NULL, plan_digest TEXT NOT NULL, manifest_digest TEXT NOT NULL,
        planned_outputs_digest TEXT NOT NULL, candidate_snapshot_digest TEXT NOT NULL, review_digest TEXT NOT NULL,
        approval_digest TEXT NOT NULL, phase TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        last_refusal_json TEXT, reserved_at TEXT NOT NULL) WITHOUT ROWID`);
      // A reservation nothing vouched for, already at COMPLETED: stamping it v43 would make it authority.
      raw.prepare(insert()).run(...reservation(runId, { phase: "COMPLETED", attempts: 1 }));
    }],
    ["reshaped", (raw: Database.Database) => {
      raw.exec(`CREATE TABLE bootstrap_applications (run_id TEXT PRIMARY KEY, phase TEXT)`);
    }],
  ] as const)("fails closed on a %s bootstrap_applications table and restores the v42 file, repairing nothing", (_name, seed) => {
    const { path } = v42Image(seed);
    const seeded = new Database(path, { readonly: true });
    const before = dump(seeded, ["schema_migrations"]);
    seeded.close();
    approveMigration(path, "v42 to v43 fixture, failing closed");
    let refusal: unknown = null;
    try {
      openDb(path).close();
    } catch (error) {
      refusal = error;
    }
    expect(isAcpError(refusal)).toBe(true);
    expect(isAcpError(refusal) && String(refusal.evidence["migrationError"]))
      .toMatch(/v43 pre-existing bootstrap_applications table does not match the current schema or is populated/);
    const restored = new Database(path, { readonly: true, fileMustExist: true });
    try {
      expect(Number(restored.pragma("user_version", { simple: true }))).toBe(42);
      expect(names(restored, "trigger").filter((name) => V43_TRIGGERS.includes(name))).toEqual([]);
      expect(dump(restored, ["schema_migrations"])).toEqual(before);
    } finally {
      restored.close();
    }
  });

  it.each(V43_TRIGGERS)("a database that lost %s refuses to open", (trigger) => {
    const { path, world } = currentDatabase();
    world.db.close();
    const raw = new Database(path);
    raw.exec(`DROP TRIGGER ${trigger}`);
    raw.close();
    let refusal: unknown = null;
    try {
      openDb(path).close();
    } catch (error) {
      refusal = error;
    }
    expect(isAcpError(refusal)).toBe(true);
    expect(isAcpError(refusal) && refusal.message).toMatch(/load-bearing schema invariant/);
    expect(isAcpError(refusal) && refusal.evidence["trigger"]).toBe(trigger);
  });

  it("a reservation is born RESERVED, is never replaced by run, project id or identity, and is never deleted", () => {
    const { world } = currentDatabase();
    const db = world.db;
    try {
      expect(() => db.run(insert(), reservation(world.runId, { phase: "WRITTEN", attempts: 1 }))).toThrow(/BOOTSTRAP_APPLICATION_PHASE_INVALID/);
      expect(() => db.run(insert(), reservation(world.runId, { attempts: 2 }))).toThrow(/BOOTSTRAP_APPLICATION_PHASE_INVALID/);
      db.run(insert(), reservation(world.runId));
      for (const verb of ["INSERT", "INSERT OR REPLACE", "REPLACE"]) {
        expect(() => db.run(insert(verb), reservation(world.runId, { project_id: "prj_other", repository_identity: "github:acme/other" })))
          .toThrow(/BOOTSTRAP_APPLICATION_NO_REPLACE/);
      }
      const otherRun = db.get<{ run_id: string }>(`SELECT run_id FROM runs WHERE run_id <> ? LIMIT 1`, [world.runId]);
      if (otherRun) {
        expect(() => db.run(insert(), reservation(otherRun.run_id, { repository_identity: "github:acme/other" })))
          .toThrow(/BOOTSTRAP_APPLICATION_NO_REPLACE/);
        expect(() => db.run(insert(), reservation(otherRun.run_id, { project_id: "prj_other" })))
          .toThrow(/BOOTSTRAP_APPLICATION_NO_REPLACE/);
      }
      expect(() => db.run(`DELETE FROM bootstrap_applications WHERE run_id = ?`, [world.runId])).toThrow(/BOOTSTRAP_APPLICATION_IMMUTABLE/);
      expect(db.get<{ phase: string }>(`SELECT phase FROM bootstrap_applications WHERE run_id = ?`, [world.runId])?.phase).toBe("RESERVED");
    } finally {
      db.close();
    }
  });

  it("the identity and digests are fixed, and the phase only moves forward", () => {
    const { world } = currentDatabase();
    const db = world.db;
    const phase = () => db.get<{ phase: string; attempts: number }>(
      `SELECT phase, attempts FROM bootstrap_applications WHERE run_id = ?`, [world.runId],
    );
    try {
      db.run(insert(), reservation(world.runId));
      for (const column of ["project_id", "repository_identity", "plan_digest", "candidate_snapshot_digest", "approval_digest", "reserved_at"]) {
        expect(() => db.run(`UPDATE bootstrap_applications SET ${column} = 'moved' WHERE run_id = ?`, [world.runId]), column)
          .toThrow(/BOOTSTRAP_APPLICATION_IMMUTABLE/);
      }
      // WRITTEN before any attempt, or an attempt counted twice at once, is refused.
      expect(() => db.run(`UPDATE bootstrap_applications SET phase = 'WRITTEN' WHERE run_id = ?`, [world.runId]))
        .toThrow(/BOOTSTRAP_APPLICATION_PHASE_INVALID/);
      expect(() => db.run(`UPDATE bootstrap_applications SET attempts = 2 WHERE run_id = ?`, [world.runId]))
        .toThrow(/BOOTSTRAP_APPLICATION_PHASE_INVALID/);
      db.run(`UPDATE bootstrap_applications SET attempts = attempts + 1 WHERE run_id = ?`, [world.runId]);
      expect(() => db.run(`UPDATE bootstrap_applications SET attempts = 0 WHERE run_id = ?`, [world.runId]))
        .toThrow(/BOOTSTRAP_APPLICATION_PHASE_INVALID/);
      // STRANDED only with its evidence.
      expect(() => db.run(`UPDATE bootstrap_applications SET phase = 'STRANDED' WHERE run_id = ?`, [world.runId]))
        .toThrow(/BOOTSTRAP_APPLICATION_PHASE_INVALID|CHECK constraint/);
      db.run(`UPDATE bootstrap_applications SET phase = 'WRITTEN' WHERE run_id = ?`, [world.runId]);
      for (const backwards of ["RESERVED", "STRANDED"]) {
        expect(() => db.run(`UPDATE bootstrap_applications SET phase = ?, last_refusal_json = '{}' WHERE run_id = ?`, [backwards, world.runId]), backwards)
          .toThrow(/BOOTSTRAP_APPLICATION_PHASE_INVALID/);
      }
      db.run(`UPDATE bootstrap_applications SET phase = 'COMPLETED' WHERE run_id = ?`, [world.runId]);
      for (const backwards of ["WRITTEN", "RESERVED", "STRANDED"]) {
        expect(() => db.run(`UPDATE bootstrap_applications SET phase = ?, last_refusal_json = '{}' WHERE run_id = ?`, [backwards, world.runId]), backwards)
          .toThrow(/BOOTSTRAP_APPLICATION_PHASE_INVALID/);
      }
      expect(() => db.run(`UPDATE bootstrap_applications SET last_refusal_json = '{}' WHERE run_id = ?`, [world.runId]))
        .toThrow(/BOOTSTRAP_APPLICATION_PHASE_INVALID/);
      expect(phase()).toEqual({ phase: "COMPLETED", attempts: 1 });
    } finally {
      db.close();
    }
  });
});
