import Database from "better-sqlite3";
import { chmodSync, writeFileSync } from "node:fs";

import { isAcpError } from "../../src/core/errors.ts";
import { Db } from "../../src/db/database.ts";
import { approveMigration } from "../../src/db/migration-approval.ts";
import { privateStatePath, v11Image } from "./released-v44-schema.ts";

/**
 * V46-R1-02. A database at an earlier version as the released chain leaves it, never one taken back
 * from a newer database.
 *
 * Taking a newer database back keeps whatever the builder forgets to remove: measured at 404422d5, the
 * v38/v39 images kept `bootstrap_applications` and both manifest-grant tables, the v42 image both grant
 * tables, and the v13 image all nine v46 guards. Here the checked-in v11 fixture (prior-release SQL,
 * never this build's schema) runs the released steps v12..`version` through this build's migrator,
 * which stops there. The image holds only what those steps install, and its ledger holds the receipts
 * of the steps it took rather than a relabelled bootstrap row.
 */

const STOP = (version: number): string => `the released chain image stops at v${version}`;

/** One serialized image per version per test file: the chain is run once, then copied. */
const built = new Map<number, Buffer>();

const chainBytes = (version: number): Buffer => {
  const cached = built.get(version);
  if (cached !== undefined) return cached;
  const path = v11Image(privateStatePath(`acp-chain-v${version}-`));
  approveMigration(path, `released chain image at v${version}`);
  let bytes: Buffer | undefined;
  try {
    new Db(path, {
      afterMigration: (migration) => {
        if (migration.toVersion !== version) return;
        // The step has committed; a second connection reads the committed image, WAL included.
        const reader = new Database(path, { readonly: true, fileMustExist: true });
        try {
          bytes = reader.serialize();
        } finally {
          reader.close();
        }
        // Stops the chain here. The migrator restores its own v11 file, which is discarded.
        throw new Error(STOP(version));
      },
    }).close();
  } catch (error) {
    if (!(isAcpError(error) && error.evidence["migrationError"] === STOP(version))) throw error;
  }
  if (bytes === undefined) throw new Error(`the released chain never reached v${version}`);
  built.set(version, bytes);
  return bytes;
};

/** Writes the released chain's image at `version` to `path`. Not approved. */
export const releasedChainImage = (path: string, version: number): string => {
  writeFileSync(path, chainBytes(version), { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
};

/**
 * Carries every row of `source`, a database this build wrote, into the image at `target`: for each
 * table the image has, and only the columns it has. The rows are this build's; the schema stays the
 * released one. The image's triggers are set aside while the rows go in and recreated from their own
 * stored text, so `sqlite_schema` is unchanged. A row the image already holds must equal the source's
 * on the shared columns, and a row the image cannot hold (a CHECK, a NOT NULL, a foreign key checked at
 * the end) fails the build rather than being dropped.
 */
export const carryRows = (source: string, target: string): void => {
  const raw = new Database(target);
  try {
    raw.pragma("foreign_keys = OFF");
    raw.prepare("ATTACH DATABASE ? AS source").run(source);
    const triggers = raw
      .prepare("SELECT name, sql FROM main.sqlite_schema WHERE type = 'trigger' ORDER BY rowid")
      .all() as Array<{ name: string; sql: string }>;
    const tables = raw
      .prepare("SELECT name, wr FROM pragma_table_list WHERE schema = 'main' AND type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations' ORDER BY name")
      .all() as Array<{ name: string; wr: number }>;
    raw.exec("BEGIN IMMEDIATE");
    for (const trigger of triggers) raw.exec(`DROP TRIGGER main."${trigger.name}"`);
    for (const table of tables) {
      const info = (schema: string) =>
        raw.prepare(`SELECT name, type, pk FROM pragma_table_info(?, ?)`).all(table.name, schema) as Array<{ name: string; type: string; pk: number }>;
      const own = info("main");
      const theirs = info("source").map((column) => column.name);
      if (theirs.length === 0) continue;
      const shared = own.map((column) => column.name).filter((name) => theirs.includes(name));
      const keys = own.filter((column) => column.pk > 0);
      const aliased = keys.length === 1 && keys[0]!.type.toUpperCase() === "INTEGER";
      const rowid = table.wr === 0 && !aliased ? ["rowid"] : [];
      const columns = [...rowid, ...shared.map((name) => `"${name}"`)].join(", ");
      raw.exec(`INSERT OR IGNORE INTO main."${table.name}" (${columns}) SELECT ${columns} FROM source."${table.name}"`);
      const missing = raw.prepare(`SELECT ${columns} FROM source."${table.name}" EXCEPT SELECT ${columns} FROM main."${table.name}"`).all();
      if (missing.length > 0) {
        throw new Error(`${table.name}: ${missing.length} source row(s) differ from what the image already holds`);
      }
    }
    for (const trigger of triggers) raw.exec(trigger.sql);
    const violations = raw.pragma("main.foreign_key_check") as unknown[];
    if (violations.length > 0) throw new Error(`carried rows leave ${violations.length} foreign-key violation(s)`);
    raw.exec("COMMIT");
    raw.exec("DETACH DATABASE source");
  } finally {
    raw.close();
  }
};

/**
 * Objects the released chain installs after a version, named here rather than read from the code under
 * test. An image of `version` holds none of the objects of a later version, nor a later version's columns.
 *
 * Not listed: `baseline_records` (v14) and `telegram_owner_prompts` (v17). The released v12 step replays
 * the frozen schema-v37.sql, which holds both, and v14 and v17 create them `IF NOT EXISTS`, so the
 * chain's own v13 holds them. Measured on this chain, not assumed.
 */
const LATER_OBJECTS: ReadonlyArray<{ version: number; objects?: readonly string[]; columns?: readonly string[] }> = [
  { version: 20, objects: ["conversational_actor_registrations", "conversational_actor_registry_state"] },
  { version: 38, objects: ["inbound_claim_authority_markers"], columns: ["canonical_turns.override_incumbent_turn_request_id"] },
  { version: 39, objects: ["inbound_messages_owner_reply_key_immutable"] },
  {
    version: 40,
    objects: [
      "peer_message_carries", "peer_message_refusal_notices", "peer_message_notice_deliveries",
      "holder_message_departures", "holder_message_source_departures", "inbound_messages_buzz_source_key_immutable",
    ],
  },
  {
    version: 41,
    objects: ["assignments_worker_session_independent", "task_executions_worker_process_write_once"],
    columns: ["task_executions.runtime_managed", "task_executions.worker_process_started_at", "task_executions.worker_process_released_at"],
  },
  { version: 42, objects: ["sessions_credential_epoch_rotation", "sessions_credential_epoch_starts_at_zero", "runs_continuity_hold_not_inserted"] },
  { version: 43, objects: ["bootstrap_applications"] },
  { version: 44, objects: ["manifest_activation_grants", "projects_active_manifest_moves_by_grant"] },
  { version: 45, objects: ["manifest_first_activation_grants", "manifest_activation_grants_not_first"] },
  {
    version: 46,
    objects: [
      "outbox_no_rowid_replace", "outbox_rowid_immutable", "outbox_rowid_positive",
      "inbound_messages_no_rowid_replace", "inbound_messages_rowid_immutable", "inbound_messages_rowid_positive",
      "canonical_turns_no_rowid_replace", "canonical_turns_rowid_immutable", "canonical_turns_rowid_positive",
    ],
  },
];

/**
 * What a historical image must be before a test uses it: at `version`, its top receipt the released
 * step's own, and holding no object or column a later version introduces. Returns the later objects
 * and columns found, which must be empty, so a caller's `expect` names them.
 */
export const laterObjectsIn = (path: string, version: number): string[] => {
  const raw = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const found: string[] = [];
    if (raw.pragma("user_version", { simple: true }) !== version) found.push(`user_version is not ${version}`);
    const top = raw.prepare("SELECT migration_id FROM schema_migrations WHERE version = ?").pluck().get(version) as string | undefined;
    if (top === undefined || top.startsWith("bootstrap-")) found.push(`receipt at v${version} is ${top ?? "absent"}, not a released step's`);
    for (const later of LATER_OBJECTS.filter((entry) => entry.version > version)) {
      for (const name of later.objects ?? []) {
        const held = raw.prepare("SELECT type FROM sqlite_schema WHERE name = ? COLLATE NOCASE").pluck().get(name) as string | undefined;
        if (held !== undefined) found.push(`v${later.version} ${held} ${name}`);
      }
      for (const qualified of later.columns ?? []) {
        const [table, column] = qualified.split(".") as [string, string];
        const held = raw.prepare("SELECT 1 FROM pragma_table_info(?) WHERE name = ?").get(table, column);
        if (held !== undefined) found.push(`v${later.version} column ${qualified}`);
      }
    }
    return found;
  } finally {
    raw.close();
  }
};
