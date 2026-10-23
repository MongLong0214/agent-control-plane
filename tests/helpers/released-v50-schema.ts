import type Database from "better-sqlite3";
import { readFileSync } from "node:fs";

/** The only definitions v50 replaces, named independently of the migration. */
export const V50_CHANGED_GUARDS = ["runs_state_transition_guard", "runs_state_transition_authority_guard"];
const V49_SNAPSHOT = readFileSync(new URL("../../src/db/schema-v49.sql", import.meta.url), "utf8");

/** Older fixtures built from a current database must restore v49's terminal topology too. */
export const takeBackV50 = (raw: Database.Database): void => {
  takeBackV52(raw);
  // v51 objects must not survive in a fixture claiming to predate this step.
  raw.exec(`DROP TRIGGER IF EXISTS outbox_holder_message_terminal;
    DROP TABLE IF EXISTS buzz_events; DROP TABLE IF EXISTS holder_message_terminals;
    DROP TABLE IF EXISTS role_room_memberships;`);
  for (const name of V50_CHANGED_GUARDS) {
    const ddl = new RegExp(`CREATE TRIGGER IF NOT EXISTS ${name}\\n[\\s\\S]*?\\nEND;`).exec(V49_SNAPSHOT)?.[0];
    if (!ddl) throw new Error(`${name} is absent from the v49 snapshot`);
    raw.exec(`DROP TRIGGER IF EXISTS ${name}`);
    raw.exec(ddl);
  }
};

/** Historical fixtures must remove v52's additive objects and restore the three parent definitions v51 left. */
export const takeBackV52 = (raw: Database.Database): void => {
  if (!(raw.prepare('PRAGMA table_info(projects)').all() as {name:string}[]).some(c => c.name === 'retired_at')) return;
  const snapshot = readFileSync(new URL('../../src/db/schema-v51.sql',import.meta.url),'utf8');
  raw.pragma('foreign_keys = OFF');raw.pragma('legacy_alter_table = ON');
  for (const name of ['project_retirements','canonical_session_entitlements','resident_project_provisioning']) raw.exec(`DROP TABLE IF EXISTS ${name}`);
  for (const table of ['projects','repositories','bootstrap_applications']) {
    const columns = (raw.prepare(`PRAGMA table_info(${table})`).all() as {name:string}[]).map(c => c.name);
    const rowid = (raw.prepare("SELECT wr FROM pragma_table_list WHERE name = ?").get(table) as {wr:number}).wr === 0;
    const indexes = raw.prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL").all(table) as {name:string}[];
    for (const index of indexes) raw.exec(`DROP INDEX "${index.name}"`);
    raw.exec(`ALTER TABLE ${table} RENAME TO ${table}_v52_fixture`);
    const ddl = new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\)(?: WITHOUT ROWID)?;`).exec(snapshot)?.[0];
    if (!ddl) throw new Error(`v51 table missing: ${table}`);raw.exec(ddl);
    const shared = (raw.prepare(`PRAGMA table_info(${table})`).all() as {name:string}[]).map(c => c.name).filter(c => columns.includes(c));
    const list = [...(rowid ? ['rowid'] : []),...shared].map(c => `"${c}"`).join(',');
    raw.exec(`INSERT INTO ${table} (${list}) SELECT ${list} FROM ${table}_v52_fixture; DROP TABLE ${table}_v52_fixture`);
    for (const match of snapshot.matchAll(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS \w+[\s\S]*?;/g)) if (new RegExp(`ON ${table}\\(`).test(match[0])) raw.exec(match[0]);
    for (const match of snapshot.matchAll(/CREATE TRIGGER IF NOT EXISTS \w+[\s\S]*?\nEND;/g)) if (new RegExp(`ON ${table}\\b`).test(match[0].split('BEGIN')[0]!)) raw.exec(match[0]);
  }
  raw.pragma('legacy_alter_table = OFF');
};

export const V52_ADDED_TRIGGERS = ["resident_project_provisioning", "canonical_session_entitlements", "project_retirements"].flatMap(table => ["identity_immutable", "no_replace", "no_delete"].map(suffix => `${table}_${suffix}`));
