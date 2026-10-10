import Database from "better-sqlite3";
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { isAcpError } from "../../src/core/errors.ts";
import { SCHEMA_VERSION, openDb } from "../../src/db/database.ts";
import { approveMigration } from "../../src/db/migration-approval.ts";
import { installMigrationLedger } from "../../src/db/migrations.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { fileCore, seedWorkerWorld } from "../helpers/worker-turn-fixture.ts";

/**
 * Integration of #1068 (v40) and #512 PR-B (v41): a database at v39 — before either — reaches v41
 * through both steps in order, keeping every row; and a v41 step that fails closed restores the whole
 * v39 file, v40's work included.
 *
 * The image is built the way #1068's and PR-B's own fixtures build theirs: written at the current
 * version with real rows, then taken back by removing exactly what v40 and v41 add. v40's record
 * tables are WITHOUT ROWID, so rows are compared as sorted sets, never by rowid.
 */

afterAll(cleanupTempDirs);

const NOW = "2026-10-04T00:00:00.000Z";

/** v40's guards (#1068): the carry record, the refusal notices, the deliveries and the departures. */
const V40_TRIGGERS = [
  "peer_message_carries_immutable",
  "peer_message_carries_insert_authority",
  "peer_message_carries_no_delete",
  "peer_message_carries_no_replace",
  "peer_message_refusal_notices_immutable",
  "peer_message_refusal_notices_insert_authority",
  "peer_message_refusal_notices_no_delete",
  "peer_message_refusal_notices_no_replace",
  "peer_message_notice_deliveries_immutable",
  "peer_message_notice_deliveries_insert_authority",
  "peer_message_notice_deliveries_no_delete",
  "peer_message_notice_deliveries_no_replace",
  "holder_message_departures_immutable",
  "holder_message_departures_no_delete",
  "holder_message_departures_no_replace",
  "holder_message_source_departures_immutable",
  "holder_message_source_departures_no_delete",
  "holder_message_source_departures_no_replace",
  "inbound_messages_turn_terminal_departs",
  "inbound_messages_turn_terminal_departs_on_insert",
  "outbox_departed_no_delete",
  "outbox_holder_message_departs",
  "outbox_holder_message_source_departs",
  "outbox_message_id_immutable",
  "inbound_messages_buzz_source_key_immutable",
];
const V40_TABLES = [
  "peer_message_carries",
  "peer_message_refusal_notices",
  "peer_message_notice_deliveries",
  "holder_message_departures",
  "holder_message_source_departures",
];

/** v41's guards (PR-B): worker-session independence, both directions, and the worker-process record. */
const V41_TRIGGERS = [
  "assignments_worker_session_independent",
  "assignments_worker_session_independent_on_activate",
  "conversational_actors_worker_session_independent",
  "assignments_session_holds_no_worker",
  "assignments_session_holds_no_worker_on_activate",
  "conversational_actors_session_holds_no_worker",
  "runs_owner_session_not_its_worker",
  "task_executions_worker_process_record_authority",
  "task_executions_worker_process_record_not_inserted",
  "task_executions_worker_process_release_authority",
  "task_executions_worker_process_release_not_inserted",
  "task_executions_worker_process_write_once",
  "task_executions_runtime_managed_immutable",
  "task_executions_outstanding_process_no_delete",
];
const V41_COLUMNS = ["runtime_managed", "worker_process_started_at", "worker_process_released_at"];

const statePath = (): string => {
  const root = join(tempDir("acp-v39-to-v41-"), "state");
  mkdirSync(root, { recursive: true });
  chmodSync(root, 0o700);
  return join(root, "state.sqlite");
};

const names = (raw: Database.Database, type: "table" | "trigger"): string[] =>
  (raw.prepare(`SELECT name FROM sqlite_master WHERE type = ? ORDER BY name`).all(type) as { name: string }[])
    .map((row) => row.name);

/** Every row of every table as a sorted set; task_executions without v41's columns. */
const dump = (raw: Database.Database, except: readonly string[]): Record<string, string[]> =>
  Object.fromEntries(
    names(raw, "table")
      .filter((name) => !except.includes(name) && !name.startsWith("sqlite_"))
      .map((name) => {
        const rows = raw.prepare(`SELECT * FROM "${name}"`).all() as Record<string, unknown>[];
        return [name, rows.map((row) => {
          const kept = name === "task_executions"
            ? Object.fromEntries(Object.entries(row).filter(([column]) => !V41_COLUMNS.includes(column)))
            : row;
          return JSON.stringify(kept);
        }).sort()];
      }),
  );

/** Written at the current version with real rows, then taken back to v39. */
const v39Image = (seed?: (raw: Database.Database) => void): { path: string; before: Record<string, string[]>; execution: string } => {
  const path = statePath();
  const world = seedWorkerWorld(fileCore(path));
  // A CTO-receipted execution, so task_executions holds a row v41's columns must be added beside.
  const started = world.tasks.startExecution({
    runId: world.runId, taskId: world.taskId, ownerBindingGeneration: world.cto.generation,
    workerSessionId: world.worker.sessionId, provider: "claude", model: "opus", workerProcessId: 4_242_424,
  });
  if (!started.allowed) throw new Error(started.message);
  world.db.run(
    `INSERT INTO inbound_messages (channel, nonce, actor, received_at) VALUES ('buzz', 'buzz-message:before-v40', 'ceo', ?)`,
    [NOW],
  );
  world.db.run(
    `INSERT INTO audit_events (at, kind, reason_code, actor, evidence_json) VALUES (?, 'WRITTEN_BEFORE_V40', 'OK', 'test', '{}')`,
    [NOW],
  );
  world.db.close();

  const legacy = new Database(path);
  try {
    legacy.exec([...V41_TRIGGERS, ...V40_TRIGGERS].map((name) => `DROP TRIGGER ${name};`).join("\n"));
    for (const column of V41_COLUMNS) legacy.exec(`ALTER TABLE task_executions DROP COLUMN ${column}`);
    legacy.exec(`DROP INDEX peer_message_carries_by_successor; DROP INDEX peer_message_refusal_notices_by_role;`);
    for (const table of V40_TABLES) legacy.exec(`DROP TABLE ${table}`);
    seed?.(legacy);
    legacy.exec(`
      DROP TRIGGER schema_migrations_no_delete;
      DROP TRIGGER schema_migrations_insert_authority;
      DELETE FROM schema_migrations WHERE version > 39;
      INSERT INTO schema_migrations (version, migration_id, checksum, applied_at)
        VALUES (39, 'bootstrap-v39', 'sha256:${"0".repeat(64)}', '${NOW}');
      PRAGMA user_version = 39;
    `);
    installMigrationLedger(legacy);
    // Nothing of v40's or v41's is left in the image.
    expect(names(legacy, "trigger").filter((name) => [...V40_TRIGGERS, ...V41_TRIGGERS].includes(name))).toEqual([]);
    expect(names(legacy, "table").filter((name) => V40_TABLES.includes(name))).toEqual([]);
    const columns = (legacy.prepare(`SELECT name FROM pragma_table_info('task_executions')`).all() as { name: string }[])
      .map((row) => row.name);
    expect(columns.filter((name) => V41_COLUMNS.includes(name))).toEqual([]);
    return { path, before: dump(legacy, ["schema_migrations"]), execution: started.value.executionId };
  } finally {
    legacy.close();
  }
};

describe("integration of v40 (#1068) and v41 (#512 PR-B) from a v39 database", () => {
  it("names every trigger the registry records for v40 and v41", () => {
    // The lists above are what the image removes; a guard added to either version later must be here too.
    const source = readFileSync(fileURLToPath(new URL("../../src/db/migrations.ts", import.meta.url)), "utf8");
    const introducedIn = (version: number): string[] =>
      [...source.matchAll(new RegExp(`\\{ name: "([a-z_]+)", sentinel: [^}]*introducedIn: ${version} \\}`, "g"))]
        .map((match) => match[1]!)
        .sort();
    expect(introducedIn(40)).toEqual([...V40_TRIGGERS].sort());
    expect(introducedIn(41)).toEqual([...V41_TRIGGERS].sort());
  });

  it("migrates v39 through v40 to v41, keeping every row, with both steps' objects installed and guarding", () => {
    const { path, before, execution } = v39Image();
    approveMigration(path, "v39 to v41 integration fixture");
    const migrated = openDb(path);
    try {
      // #246 C1b adds v42 on top; this row is about v40 and v41, which the chain still runs in order.
      expect(SCHEMA_VERSION).toBe(42);
      expect(Number(migrated.raw.pragma("user_version", { simple: true }))).toBe(SCHEMA_VERSION);
      expect(migrated.all<{ version: number; migration_id: string }>(
        `SELECT version, migration_id FROM schema_migrations WHERE version >= 39 ORDER BY version`,
      )).toEqual([
        { version: 39, migration_id: "bootstrap-v39" },
        { version: 40, migration_id: "v40-peer-message-carry-record" },
        { version: 41, migration_id: "v41-runtime-managed-worker-turns" },
        { version: 42, migration_id: "v42-session-credential-epoch" },
      ]);
      const triggers = migrated.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'trigger'`).map((row) => row.name);
      for (const name of [...V40_TRIGGERS, ...V41_TRIGGERS]) expect(triggers, name).toContain(name);
      const tables = migrated.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'`).map((row) => row.name);
      for (const name of V40_TABLES) expect(tables, name).toContain(name);
      // The existing execution gets v41's columns at their defaults: not the runtime's, no process record.
      expect(migrated.get<{ runtime_managed: number; worker_process_started_at: string | null; worker_process_released_at: string | null }>(
        `SELECT runtime_managed, worker_process_started_at, worker_process_released_at FROM task_executions WHERE execution_id = ?`,
        [execution],
      )).toEqual({ runtime_managed: 0, worker_process_started_at: null, worker_process_released_at: null });
      // v41's guards bite from the first write after the upgrade; v40's too.
      expect(() => migrated.run(`UPDATE task_executions SET runtime_managed = 1 WHERE execution_id = ?`, [execution]))
        .toThrow(/TASK_EXECUTION_RUNTIME_MANAGED_IMMUTABLE/);
      expect(() => migrated.run(`UPDATE task_executions SET worker_process_id = NULL WHERE execution_id = ?`, [execution]))
        .toThrow(/TASK_EXECUTION_WORKER_PROCESS_IMMUTABLE/);
      expect(() => migrated.run(`UPDATE inbound_messages SET nonce = nonce || ':moved' WHERE channel = 'buzz'`))
        .toThrow(/INBOUND_BUZZ_SOURCE_KEY_IMMUTABLE/);
    } finally {
      migrated.close();
    }
    const after = new Database(path, { readonly: true });
    try {
      expect(dump(after, ["schema_migrations", ...V40_TABLES])).toEqual(before);
    } finally {
      after.close();
    }
  });

  it("a v41 step that fails closed restores the whole v39 file, v40's work included", () => {
    const { path, before } = v39Image((raw) => {
      // A WORKER bound to the session that holds the PRIMARY_CTO role: v41 refuses to install over it.
      raw.exec(`
        INSERT INTO projects (project_id, name, created_at) VALUES ('prj_v41', 'v41', '${NOW}');
        INSERT INTO sessions (session_id, incarnation, provider, model, lifecycle, created_at, updated_at)
          VALUES ('ses_cto_v41', 'inc-cto', 'claude', 'opus', 'READY', '${NOW}', '${NOW}');
        INSERT INTO conversational_actors (actor_id, kind, current_session_id, current_session_incarnation, created_at)
          VALUES ('actor:cto_v41', 'PRIMARY_CTO', 'ses_cto_v41', 'inc-cto', '${NOW}');
        INSERT INTO conversational_actors (actor_id, kind, current_session_id, current_session_incarnation, created_at)
          VALUES ('actor:worker_v41', 'WORKER', 'ses_cto_v41', 'inc-cto', '${NOW}');
        INSERT INTO assignments (assignment_id, role_key, role, project_id, actor_id, session_id, session_incarnation,
                                 binding_generation, mode, status, created_at)
          VALUES ('asg_cto_v41', 'PRIMARY_CTO:prj_v41', 'PRIMARY_CTO', 'prj_v41', 'actor:cto_v41', 'ses_cto_v41', 'inc-cto',
                  1, 'PREFERRED', 'ACTIVE', '${NOW}');
        INSERT INTO assignments (assignment_id, role_key, role, task_id, actor_id, session_id, session_incarnation,
                                 binding_generation, mode, status, created_at)
          VALUES ('asg_worker_v41', 'WORKER:tsk_v41', 'WORKER', 'tsk_v41', 'actor:worker_v41', 'ses_cto_v41', 'inc-cto',
                  1, 'PREFERRED', 'ACTIVE', '${NOW}');
      `);
    });
    approveMigration(path, "v39 to v41 integration fixture, failing at v41");
    let refusal: unknown = null;
    try {
      openDb(path).close();
    } catch (error) {
      refusal = error;
    }
    expect(isAcpError(refusal)).toBe(true);
    expect(isAcpError(refusal) && String(refusal.evidence["migrationError"])).toMatch(/v41 refuses to migrate: 1 ACTIVE WORKER binding/);
    const restored = new Database(path, { readonly: true, fileMustExist: true });
    try {
      expect(Number(restored.pragma("user_version", { simple: true }))).toBe(39);
      expect(names(restored, "table").filter((name) => V40_TABLES.includes(name))).toEqual([]);
      expect(names(restored, "trigger").filter((name) => [...V40_TRIGGERS, ...V41_TRIGGERS].includes(name))).toEqual([]);
      expect(dump(restored, ["schema_migrations"])).toEqual(before);
    } finally {
      restored.close();
    }
  });
});
