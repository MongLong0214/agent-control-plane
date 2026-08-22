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
/**
 * Every set of columns a second insert could collide on: the primary key and each UNIQUE.
 *
 * The first version compared against the primary key alone and reported four correct guards as
 * wrong — they also cover a UNIQUE, which is exactly what a REPLACE collides on when the primary
 * key is a surrogate. A rule that calls a broader guard a defect teaches whoever reads it to
 * narrow the guard.
 */
const uniqueKeysOf = (table) => {
  const declaration = new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`).exec(schema);
  if (declaration === null) return null;
  const body = declaration[1];
  const keys = [];
  const inline = [...body.matchAll(/^\s*(\w+)[^\n]*?\bPRIMARY KEY/gm)].map((m) => m[1]);
  if (inline.length > 0) keys.push(inline);
  const composite = /PRIMARY KEY \(([^)]*)\)/.exec(body);
  if (composite !== null) keys.push(composite[1].split(",").map((column) => column.trim()));
  for (const unique of body.matchAll(/\bUNIQUE \(([^)]*)\)/g)) {
    keys.push(unique[1].split(",").map((column) => column.trim()));
  }
  // A *partial* unique index constrains a subset of rows, so its columns alone are not the key —
  // a second insert that does not match the predicate is legitimate. Widening a guard to the
  // columns without the predicate broke fifty-seven tests, all ordinary re-assignments after a
  // revocation. But dropping partial indexes entirely leaves a real hole: measured, a second
  // REGISTERED registration at a higher generation deleted the first one silently.
  //
  // So a partial index contributes a key *with* its predicate, applied to both the existing row
  // and the new one — which is exactly when SQLite's REPLACE would delete.
  for (const index of schema.matchAll(
    new RegExp(`CREATE UNIQUE INDEX IF NOT EXISTS \\w+\\s*\\n?\\s*ON ${table}\\(([^)]*)\\)([^;]*);`, "g"),
  )) {
    const columns = index[1].split(",").map((column) => column.trim());
    const where = /\bWHERE\b([\s\S]*)/.exec(index[2]);
    keys.push(where === null ? columns : { columns, predicate: where[1].trim() });
  }
  return keys.length > 0 ? keys : null;
};

const mismatched = [];
/**
 * Every `_no_replace` trigger, whatever its line breaks.
 *
 * The first version of this required `WHEN EXISTS (SELECT 1 FROM <table>` on one line, and four of
 * the twenty triggers wrap it differently — so it silently checked sixteen and reported PASS. That
 * is the same failure as the census above it, in the check written to close the census's blind
 * spot, one hour later. A pattern that cannot match a formatting choice is a check with a hole
 * whose shape is "however someone typed it".
 *
 * So the body is taken from the whole trigger, and a trigger this cannot read is *reported* rather
 * than skipped: silence is not a pass.
 */
const bodies = [
  ...schema.matchAll(/CREATE TRIGGER IF NOT EXISTS (\w+)_no_replace\n([\s\S]*?)\nEND;/g),
];
for (const guard of bodies) {
  const [, table, body] = guard;
  const when = /WHEN EXISTS \(([\s\S]*?)\)\s*\nBEGIN/.exec(`${body}\nBEGIN`) ?? /WHEN([\s\S]*)/.exec(body);
  if (when === null) {
    mismatched.push({ table, why: "has a no_replace trigger this check cannot read" });
    continue;
  }
  const condition = when[1] ?? "";
  const keys = uniqueKeysOf(table);
  if (keys === null) {
    mismatched.push({ table, why: "has a no_replace trigger and no table declaration in this schema" });
    continue;
  }
  // The condition is an OR of column groups, one per uniqueness constraint it refuses a collision
  // on. Every constraint has to have a group; a group naming something else is a broader guard,
  // which is not a defect.
  const groups = condition
    .split(/\bOR\b/)
    .map((part) => new Set([...part.matchAll(/(\w+) = NEW\./g)].map((m) => m[1])))
    .filter((group) => group.size > 0);
  const uncovered = keys.filter((key) => {
    const columns = Array.isArray(key) ? key : key.columns;
    const covered = groups.some(
      (group) => columns.every((column) => group.has(column)) && group.size === columns.length,
    );
    if (Array.isArray(key)) return !covered;
    // A partial key's group carries the predicate's own column too, so "group.size === columns"
    // will not hold. It is covered when its columns appear together and the predicate's text is
    // somewhere in the condition — a text check, and said to be one: it proves the predicate was
    // carried across, not that it was carried across correctly.
    const named = groups.some((group) => columns.every((column) => group.has(column)));
    return !(named && condition.includes(key.predicate.replace(/\s+/g, " ")));
  });
  if (uncovered.length > 0) {
    mismatched.push({
      table,
      why:
        `nothing in the guard refuses a collision on (${uncovered
          .map((k) => (Array.isArray(k) ? k.join(", ") : `${k.columns.join(", ")} where ${k.predicate}`))
          .join(") or (")})` +
        ` — it compares ${groups.map((g) => `(${[...g].sort().join(", ")})`).join(" or ")}`,
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

// What it inspected, beside what exists. A PASS over a subset reads exactly like a PASS over the
// set, and twice in one day a check here passed on sixteen of twenty without saying so.
const declared = [...schema.matchAll(/CREATE TRIGGER IF NOT EXISTS (\w+)_no_replace/g)].length;
if (bodies.length !== declared) {
  process.stdout.write(
    `  ${declared} no_replace trigger(s) are declared and this check could read ${bodies.length}.\n` +
      "\nRESULT: FAIL — a guard it cannot read is a guard it did not check.\n",
  );
  process.exit(1);
}

process.stdout.write(
  `RESULT: PASS — ${guards.size} guarded table(s), ${bodies.length} of ${declared} no_replace ` +
    `trigger(s) read; every table guarded on UPDATE or DELETE refuses a REPLACE of a key it holds.\n`,
);
