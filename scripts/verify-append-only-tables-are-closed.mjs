#!/usr/bin/env node
/**
 * Fails when a table is guarded against UPDATE or DELETE and left open on INSERT.
 *
 * `INSERT OR REPLACE` deletes the row it collides with and inserts the new one. SQLite skips the
 * implicit delete's triggers unless `recursive_triggers` is on, and a connection this process did
 * not open has it off — so on a table with only UPDATE and DELETE guards, an ordinary external
 * statement rewrites a row by its key and every foreign key referencing it stays valid.
 *
 * Found twice. The first time it was the five canonical-turn tables. The correction stopped there,
 * and a census weeks later found `audit_events` — the provenance every canonical turn cites —
 * still open, along with the verification baseline and the owner's own Telegram messages.
 * Measured: `ORIGINAL|{"v":1}` became `FORGED|{"v":2}` under the same `event_id`, and
 * `foreign_key_check` reported nothing, because every reference stayed valid while what it
 * referenced changed underneath.
 *
 * Guarding a table means covering INSERT, UPDATE and DELETE. This is the part that notices when
 * the next table only gets two of the three.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const schema = readFileSync(join(ROOT, "src/db/schema.sql"), "utf8");

/**
 * Tables whose UPDATE or DELETE guard is a *protocol* rule rather than an immutability one, where
 * replacing a row is not the thing being refused.
 *
 * Each entry is a claim that has to be re-read when it is added to, which is the point of naming
 * them here rather than pattern-matching a reason out of the trigger body.
 */
const NOT_APPEND_ONLY = new Map([
  [
    "github_receipts",
    "its UPDATE guard permits exactly one transition and its DELETE guard permits withdrawing an " +
      "unapplied reservation; the table is a state machine, and INSERT is guarded separately by " +
      "github_receipts_applied_requires_reservation",
  ],
  [
    "runs",
    "the guard is on the state transition, not on the row's existence; a run is created once by " +
      "an ordinary insert and its identity is not what the trigger protects",
  ],
]);

const guards = new Map();
for (const match of schema.matchAll(
  /CREATE TRIGGER IF NOT EXISTS (\w+)\s*\nBEFORE (INSERT|UPDATE|DELETE) ON (\w+)/g,
)) {
  const [, name, verb, table] = match;
  if (!guards.has(table)) guards.set(table, { verbs: new Set(), names: [] });
  guards.get(table).verbs.add(verb);
  guards.get(table).names.push(name);
}

const open = [];
for (const [table, { verbs, names }] of [...guards].sort()) {
  if (!verbs.has("DELETE") && !verbs.has("UPDATE")) continue;
  if (verbs.has("INSERT")) continue;
  if (NOT_APPEND_ONLY.has(table)) continue;
  open.push({ table, verbs: [...verbs].sort().join(" and "), names });
}

if (open.length > 0) {
  for (const { table, verbs, names } of open) {
    process.stdout.write(
      `  ${table} is guarded on ${verbs} and open on INSERT.\n` +
        `    triggers: ${names.join(", ")}\n` +
        `    An external connection can rewrite a row by its key with INSERT OR REPLACE.\n`,
    );
  }
  process.stdout.write(
    "\nAdd a `<table>_no_replace` BEFORE INSERT trigger that refuses a key already present, or —\n" +
      "if replacing a row is legitimate here — name the table in NOT_APPEND_ONLY with the reason.\n" +
      `RESULT: FAIL — ${open.length} table(s) guarded on some verbs and not others.\n`,
  );
  process.exit(1);
}

const exempt = NOT_APPEND_ONLY.size;
process.stdout.write(
  `RESULT: PASS — every table guarded on UPDATE or DELETE is closed on INSERT ` +
    `(${exempt} named exception${exempt === 1 ? "" : "s"}).\n`,
);
