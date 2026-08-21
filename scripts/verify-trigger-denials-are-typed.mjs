#!/usr/bin/env node
/**
 * Fails when a trigger raises a sentinel that nothing translates into a typed refusal.
 *
 * `TRIGGER_CODES` maps a schema sentinel to a `ReasonCode`, and `db.tx` uses it to turn a SQLite
 * abort into a Decision the caller can act on. A sentinel missing from that table comes out as a
 * raw `Error` instead — so a claim whose insert trips a guard *throws* rather than denying, and
 * the caller cannot tell a refusal it should report from a bug it should escalate.
 *
 * The whole canonical-turn ledger was in that state: twenty-odd guards, none of them mapped, on
 * the tables this branch exists to protect. A review found it; a census then found five more that
 * predate the branch entirely. Both are the same shape — a guard whose *name* is enforced and
 * whose *report* is not.
 *
 * The reverse direction is checked too, more gently: an entry mapping a sentinel no trigger
 * raises is dead weight, and dead entries are how a table stops describing the schema.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const schema = readFileSync(join(ROOT, "src/db/schema.sql"), "utf8");
const database = readFileSync(join(ROOT, "src/db/database.ts"), "utf8");

/**
 * Sentinels raised by triggers a migration installs rather than schema.sql, so the census of
 * schema.sql alone does not see them. Named here so the reverse check does not call them dead.
 */
const RAISED_BY_MIGRATIONS = new Set([
  "SCHEMA_MIGRATION_AUTHORITY_DENIED",
  "SCHEMA_MIGRATION_RECEIPT_IMMUTABLE",
]);

const raised = new Set([...schema.matchAll(/RAISE\(ABORT,\s*'([A-Z_]+)'\)/g)].map((m) => m[1]));

const start = database.indexOf("const TRIGGER_CODES");
if (start === -1) {
  process.stdout.write("  TRIGGER_CODES is not in src/db/database.ts.\n\nRESULT: FAIL — nothing was compared.\n");
  process.exit(2);
}
const table = database.slice(start, database.indexOf("};", start));
const mapped = new Set([...table.matchAll(/^\s*([A-Z_]+):/gm)].map((m) => m[1]));

const untyped = [...raised].filter((sentinel) => !mapped.has(sentinel)).sort();
const dead = [...mapped].filter((s) => !raised.has(s) && !RAISED_BY_MIGRATIONS.has(s)).sort();

if (untyped.length > 0) {
  for (const sentinel of untyped) {
    process.stdout.write(
      `  ${sentinel} is raised by a trigger and has no entry in TRIGGER_CODES.\n` +
        "    Its denial reaches the caller as a raw Error, not as a Decision.\n",
    );
  }
}
if (dead.length > 0) {
  for (const sentinel of dead) {
    process.stdout.write(`  ${sentinel} is mapped and no trigger raises it.\n`);
  }
}

if (untyped.length > 0 || dead.length > 0) {
  process.stdout.write(
    `\nRESULT: FAIL — ${untyped.length} untyped denial(s), ${dead.length} dead entr(y/ies).\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `RESULT: PASS — all ${raised.size} trigger sentinel(s) map to a reason code, and none is dead.\n`,
);
