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
 * There is no exemption list, and there was one.
 *
 * It named `github_receipts` and `runs` as state machines whose UPDATE guard is a protocol rule
 * rather than an immutability one, so REPLACE was said not to matter for them. A review found
 * both entries were dead — never reached, because one table had an INSERT trigger the old rule
 * mistook for a REPLACE guard and the other was invisible to the old pattern entirely — while the
 * PASS line went on advertising "2 named exceptions". An exemption nothing consults is a place for
 * the next reader to believe something was decided.
 *
 * Both tables have a `_no_replace` trigger now. A receipt is the proof an operation already
 * happened and a run holds a pinned manifest; neither is something a second insert should be
 * allowed to rewrite, which is what made the exemption wrong rather than merely unused.
 */

// `BEFORE UPDATE OF <columns> ON <table>` is the form four of this schema's most load-bearing
// guards take, and the first version of this pattern did not match it. Sixteen triggers were
// invisible, `sessions` among them — a table whose secret hash a REPLACE rewrote on ACP's own
// connection while this census printed PASS. A census that cannot see a shape cannot report it,
// and the shape it could not see was the one that mattered most.
const guards = new Map();
for (const match of schema.matchAll(
  /CREATE TRIGGER IF NOT EXISTS (\w+)\s*\nBEFORE (INSERT|UPDATE|DELETE)(?: OF [^\n]*?)?\s+ON (\w+)/g,
)) {
  const [, name, verb, table] = match;
  if (!guards.has(table)) guards.set(table, { verbs: new Set(), names: [] });
  guards.get(table).verbs.add(verb);
  guards.get(table).names.push(name);
}

const open = [];
for (const [table, { verbs, names }] of [...guards].sort()) {
  if (!verbs.has("DELETE") && !verbs.has("UPDATE")) continue;
  // An INSERT trigger is not a REPLACE guard. The first version skipped any table that had one,
  // which exempted `task_executions` and `github_receipts` for carrying *validators* — triggers
  // that check a new row's shape and say nothing about a key already present. Only a
  // `<table>_no_replace` refuses the collision, so that is what "closed" has to mean.
  if (names.some((name) => name === `${table}_no_replace`)) continue;
  open.push({ table, verbs: [...verbs].sort().join(" and "), names });
}

/**
 * A REPLACE guard has to name the table's whole key, and only its key.
 *
 * Name less and it refuses legitimate inserts: a trigger on `conversational_actor_registrations`
 * that checked `actor_id` alone refused a *rotation* — a new row at a higher generation, which is
 * the operation that registry exists to perform. Name more, or the wrong column, and the
 * collision it is supposed to catch walks through. Neither shows up as a missing trigger, which is
 * all the census above can see.
 */
const keyOf = (table) => {
  const declaration = new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`).exec(schema);
  if (declaration === null) return null;
  const body = declaration[1];
  const inline = [...body.matchAll(/^\s*(\w+)[^\n]*?\bPRIMARY KEY/gm)].map((m) => m[1]);
  if (inline.length > 0) return inline;
  const composite = /PRIMARY KEY \(([^)]*)\)/.exec(body);
  return composite === null ? null : composite[1].split(",").map((column) => column.trim());
};

const mismatched = [];
for (const guard of schema.matchAll(
  /CREATE TRIGGER IF NOT EXISTS (\w+)_no_replace\nBEFORE INSERT ON \1\nWHEN EXISTS \(SELECT 1 FROM \1\s*([\s\S]*?)\)\nBEGIN/g,
)) {
  const [, table, condition] = guard;
  const key = keyOf(table);
  if (key === null) {
    mismatched.push({ table, why: "has a no_replace trigger and no table declaration in this schema" });
    continue;
  }
  const checked = new Set([...condition.matchAll(/(\w+) = NEW\./g)].map((m) => m[1]));
  const missing = key.filter((column) => !checked.has(column));
  const extra = [...checked].filter((column) => !key.includes(column));
  if (missing.length > 0 || extra.length > 0) {
    mismatched.push({
      table,
      why:
        `its key is (${key.join(", ")}) and the guard compares (${[...checked].sort().join(", ")})` +
        `${missing.length > 0 ? ` — missing ${missing.join(", ")}` : ""}` +
        `${extra.length > 0 ? ` — extra ${extra.join(", ")}` : ""}`,
    });
  }
}

if (mismatched.length > 0) {
  for (const { table, why } of mismatched) process.stdout.write(`  ${table}: ${why}\n`);
  process.stdout.write(
    "\nA guard that names less than the key refuses legitimate inserts; one that names more lets\n" +
      "the collision through.\n" +
      `RESULT: FAIL — ${mismatched.length} no_replace trigger(s) do not name their table's key.\n`,
  );
  process.exit(1);
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

process.stdout.write(
  `RESULT: PASS — all ${guards.size} guarded table(s) checked; ` +
    `every one guarded on UPDATE or DELETE refuses a REPLACE of a key it already holds.\n`,
);
