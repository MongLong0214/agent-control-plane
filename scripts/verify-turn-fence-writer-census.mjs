#!/usr/bin/env node
/**
 * Fails when a file outside the reviewed writer set inserts, updates, or deletes a row in one of
 * the turn-fence-governed tables: `canonical_turns` and its five satellite tables, plus the two
 * `actor_target_*` tables the ledger cites for its authority checks.
 *
 * The schema already refuses a *bad* write to these tables from anywhere — the append-only,
 * no-replace, no-delete and materialization-authority triggers hold regardless of who issues the
 * statement (`tests/unit/canonical-ledger-immutability.test.ts`). What nothing checks is whether a
 * *second* file has started writing them at all. A new module that reconstructs one of the
 * coordinator's own INSERT/UPDATE statements — same shape, same columns, so it satisfies every
 * CHECK and every trigger precondition — passes the schema cleanly while going around the
 * coordinator's TypeScript-level sequencing (session-generation checks, retry-safety ordering)
 * that the schema cannot see and was never asked to enforce. That is a writer this repository has
 * no way to notice today; the schema would not object and nothing else looks.
 *
 * So this is a source-level count, in the shape of `verify-append-only-tables-are-closed.mjs`
 * next to it: derive the governed table set from the schema, derive the writer set from the
 * source, and require every writer to be one this file already names — printing the census either
 * way, not just on failure.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "src");

/** Every `.ts` file under `src/`, depth-first, in the shape the other census scripts use. */
const walk = (dir) => {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...walk(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
};

/**
 * The governed tables, derived from the schema rather than typed out here a second time.
 *
 * `canonical_turn*` and `actor_target_*` is the whole ledger: the turn and its five satellites,
 * plus the binding and the attestation the ledger's authority triggers reference. Deriving this
 * from `CREATE TABLE` statements means a ninth table in either family enters the census the day
 * it is declared, with no second edit here to remember.
 */
const schema = readFileSync(join(ROOT, "src/db/schema.sql"), "utf8");
const governedTables = [
  ...new Set(
    [...schema.matchAll(/^CREATE TABLE IF NOT EXISTS (canonical_turn\w*|actor_target_\w+) \(/gm)].map(
      (m) => m[1],
    ),
  ),
].sort();

if (governedTables.length === 0) {
  process.stdout.write("RESULT: FAIL — found zero canonical_turn*/actor_target_* tables in the schema.\n");
  process.exit(1);
}

/**
 * The reviewed writer for each table, or `[]` when this repository has never written it at all.
 *
 * `actor_target_attestations` is `[]` on purpose: the attestation is the target executor's own
 * proof that it holds the current binding generation, and ACP has never minted that row itself —
 * ownership belongs to the process being attested to, not to the process doing the attesting. Any
 * writer appearing here is new by definition, not merely unreviewed.
 *
 * An owner that stops matching anything is exactly the exemption the sibling schema census warned
 * about — "an exemption nothing consults is a place for the next reader to believe something was
 * decided" — so a stale entry here fails the same as an unclaimed one, not silently.
 */
const OWNERS = {
  canonical_turns: ["src/conversation/turn-coordinator.ts"],
  canonical_turn_sources: ["src/conversation/turn-coordinator.ts"],
  canonical_turn_observations: ["src/conversation/turn-coordinator.ts"],
  canonical_turn_dispatches: ["src/conversation/turn-coordinator.ts"],
  canonical_turn_adjudications: ["src/conversation/turn-coordinator.ts"],
  canonical_turn_adjudication_citations: ["src/conversation/turn-coordinator.ts"],
  actor_target_bindings: ["src/session/binding-registry.ts"],
  actor_target_attestations: [],
};

const unowned = governedTables.filter((table) => !(table in OWNERS));
if (unowned.length > 0) {
  process.stdout.write(
    `RESULT: FAIL — the schema declares ${unowned.join(", ")} and this census has no owner entry ` +
      "for it. A table this file has never heard of is a table nothing here is watching.\n",
  );
  process.exit(1);
}

/**
 * `src/db/migrations.ts` is schema history, not application code: it carries every past version of
 * this DDL as text (so a line like "a plain `UPDATE canonical_turns SET ...`" describing an old
 * defect, in a comment, would read as a write to this regex) and its one genuine data-moving
 * statement is the ALTER-emulation copy into a `<table>_rebuilt` shadow table when SQLite cannot
 * alter a column in place — a different table name, covered by `migrations:check`, not by this
 * one. Scored separately already: `pnpm schema:registry` and `pnpm schema:denials` cover that
 * file's own correctness. Excluding it here is a scope line, not a blind spot.
 */
const files = walk(SRC)
  .map((f) => relative(ROOT, f))
  .filter((f) => f !== "src/db/migrations.ts");

const WRITE = /\b(?:INSERT INTO|UPDATE|DELETE FROM)\s+(\w+)/g;

const writesByTable = new Map(governedTables.map((t) => [t, []]));
for (const file of files) {
  const content = readFileSync(join(ROOT, file), "utf8");
  for (const match of content.matchAll(WRITE)) {
    const table = match[1];
    if (writesByTable.has(table)) writesByTable.get(table).push(file);
  }
}

const residual = [];
const staleOwners = [];
for (const table of governedTables) {
  const seenFiles = [...new Set(writesByTable.get(table))].sort();
  const allowed = new Set(OWNERS[table]);
  for (const file of seenFiles) {
    if (!allowed.has(file)) residual.push({ table, file });
  }
  for (const owner of OWNERS[table]) {
    if (!seenFiles.includes(owner)) staleOwners.push({ table, owner });
  }
}

// What it inspected, beside what exists — a table this scan found zero writers for is reported as
// zero, not omitted, so a reader can tell "checked, empty" from "not checked".
const report = governedTables
  .map((table) => {
    const seenFiles = [...new Set(writesByTable.get(table))].sort();
    return `  ${table}: ${seenFiles.length} writer file(s)${seenFiles.length > 0 ? ` (${seenFiles.join(", ")})` : ""}`;
  })
  .join("\n");

if (staleOwners.length > 0) {
  process.stdout.write(
    `${report}\n\n` +
      staleOwners
        .map(
          ({ table, owner }) =>
            `  ${table}: the declared owner ${owner} writes nothing here anymore — an unused ` +
            `exemption, not a covered one.\n`,
        )
        .join("") +
      `\nRESULT: FAIL — ${staleOwners.length} owner entry(ies) name a file that no longer writes ` +
      "its table.\n",
  );
  process.exit(1);
}

if (residual.length > 0) {
  process.stdout.write(
    `${report}\n\n` +
      residual
        .map(
          ({ table, file }) =>
            `  ${table}: ${file} writes this table and is not in its owner list (${
              OWNERS[table].join(", ") || "none — expected zero writers"
            }).\n`,
        )
        .join("") +
      "\nA second writer of a turn-fence-governed table can satisfy every schema trigger while " +
      "going around the coordinator's own sequencing. Route the write through the owner above, or " +
      "add this file to OWNERS in this script with the reason it is allowed to hold the pen too.\n" +
      `RESULT: FAIL — ${residual.length} write(s) from a file outside the table's owner list. ` +
      "residual != 0.\n",
  );
  process.exit(1);
}

const totalWriters = governedTables.reduce((n, t) => n + new Set(writesByTable.get(t)).size, 0);
process.stdout.write(
  `${report}\n\n` +
    `RESULT: PASS — ${governedTables.length} governed table(s), ${totalWriters} writer file ` +
    "reference(s), every one inside its table's owner list. residual: 0.\n",
);
