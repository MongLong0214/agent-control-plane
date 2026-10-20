import type Database from "better-sqlite3";
import { readFileSync } from "node:fs";

/** The only definitions v50 replaces, named independently of the migration. */
export const V50_CHANGED_GUARDS = ["runs_state_transition_guard", "runs_state_transition_authority_guard"];
const V49_SNAPSHOT = readFileSync(new URL("../../src/db/schema-v49.sql", import.meta.url), "utf8");

/** Older fixtures built from a current database must restore v49's terminal topology too. */
export const takeBackV50 = (raw: Database.Database): void => {
  for (const name of V50_CHANGED_GUARDS) {
    const ddl = new RegExp(`CREATE TRIGGER IF NOT EXISTS ${name}\\n[\\s\\S]*?\\nEND;`).exec(V49_SNAPSHOT)?.[0];
    if (!ddl) throw new Error(`${name} is absent from the v49 snapshot`);
    raw.exec(`DROP TRIGGER IF EXISTS ${name}`);
    raw.exec(ddl);
  }
};
