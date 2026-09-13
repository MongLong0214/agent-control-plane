#!/usr/bin/env node
/**
 * An `ORDER BY` on a timestamp column names a tiebreaker, or is named here as one that does not.
 *
 * #858. `received_at` is millisecond ISO text written from `clock.nowIso()`. Measured: 400
 * consecutive `systemClock.nowIso()` calls returned **one** distinct timestamp, so every message
 * admitted inside the same millisecond carries the same string and a batch of owner messages is
 * exactly what arrives that way. An `ORDER BY received_at ASC` over such rows is a partial order,
 * and SQLite is free to return ties in whatever the chosen access path yields.
 *
 * The consequence is not abstract. Every one of the four sites this census was written for takes
 * `rows[0]` as "the oldest" and hands its `channel`/`nonce` to a person — a doctor finding, an
 * escalation, and a migration's refusal message. Which row gets named was decided by the query
 * planner's index choice, and one added predicate or index changes it without touching the query.
 *
 * Patching the four was not the fix. They shared one definition of "still outstanding" and a
 * comment saying so — *"kept in agreement rather than redefined here"* — while the ordering was
 * copied four times and diverged silently. This is the check that refuses the fifth copy.
 *
 * What it does not prove: that a named tiebreaker is *sufficient*. `(received_at, nonce)` is a
 * total order only because `(channel, nonce)` is `inbound_messages`' primary key, and this census
 * reads the presence of a second ordering term, not whether that term is unique. A site that adds
 * `ORDER BY received_at, actor` passes here and is still not totally ordered.
 *
 * sol-simplify: the ordering half of #858's contract; remove when no timestamp ORDER BY remains.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { PARTIAL_TIMESTAMP_ORDERINGS } from "./lib/partial-timestamp-orderings.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const rootArgument = process.argv.slice(2).find((argument) => argument.startsWith("--root="));
const unknown = process.argv.slice(2).filter((argument) => !argument.startsWith("--root="));
if (unknown.length > 0) {
  process.stderr.write(
    `verify-timestamp-orderings-are-total: unrecognised argument(s): ${unknown.join(" ")}\n` +
      "this census knows --root=<dir> and nothing else.\n",
  );
  process.exit(2);
}
const SCAN = rootArgument === undefined ? join(ROOT, "src") : rootArgument.slice("--root=".length);
const BASE = rootArgument === undefined ? ROOT : SCAN;

/** Columns whose values are timestamps, so an order over them alone admits ties. */
const TIMESTAMP_COLUMNS = ["received_at", "created_at", "observed_at", "claimed_at", "settled_at"];

const files = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path);
    else if (entry.endsWith(".ts") || entry.endsWith(".mjs")) files.push(path);
  }
};
walk(SCAN);
files.sort();

const total = [];
const partial = [];

for (const file of files) {
  const lines = readFileSync(file, "utf8").split("\n");
  for (const [index, line] of lines.entries()) {
    const match = /ORDER BY\s+([A-Za-z0-9_., \t]+?(?:ASC|DESC)?)\s*(?:`|$|LIMIT|\))/i.exec(line);
    if (match === null) continue;
    const terms = match[1];
    const column = TIMESTAMP_COLUMNS.find((one) => new RegExp(`\\b${one}\\b`).test(terms));
    if (column === undefined) continue;
    // The question is whether the ordering has a second *term*, not whether one follows the
    // timestamp. Written the other way first, and it misreported
    // `ORDER BY bucket_id ASC, observed_at DESC` as partial: the discriminator was in front. A
    // tiebreaker does not have to come after the column it breaks ties for — with `bucket_id`
    // leading, the timestamp is already being ordered within a group.
    const termCount = terms.split(",").filter((term) => term.trim().length > 0).length;
    const at = `${relative(BASE, file)}:${index + 1}`;
    (termCount > 1 ? total : partial).push({ at, column, terms: terms.trim() });
  }
}

process.stdout.write(
  `verify-timestamp-orderings-are-total: ${files.length} file(s) under ${relative(ROOT, SCAN) || SCAN} ` +
    `parsed; ${total.length + partial.length} timestamp ordering(s), of which ${total.length} name a ` +
    `tiebreaker and ${partial.length} do not.\n`,
);
// Against a fixture tree the list matches nothing, and reporting all of it as stale would make
// every fixture run fail — so a `--root=` census carries no excuses and says so.
const excused = rootArgument === undefined ? PARTIAL_TIMESTAMP_ORDERINGS : new Map();
if (rootArgument !== undefined) {
  process.stdout.write(
    `  scope is ${SCAN}, so the ${PARTIAL_TIMESTAMP_ORDERINGS.size} src/ exclusion(s) do not apply here.\n`,
  );
}
const unexcused = partial.filter((one) => excused.get(one.at) !== `ORDER BY ${one.terms}`);
// An entry whose text no longer matches is not harmless: it excuses an ordering by a line number
// that has moved, and the ordering it now points at is excused by accident.
const stale = [...excused.entries()].filter(
  ([at, text]) => !partial.some((one) => one.at === at && `ORDER BY ${one.terms}` === text),
);

for (const one of unexcused) process.stdout.write(`  PARTIAL ORDER  ${one.at}  ORDER BY ${one.terms}\n`);
for (const [at, text] of stale) process.stdout.write(`  STALE EXCLUSION  ${at}  ${text}\n`);

if (unexcused.length > 0 || stale.length > 0) {
  process.stdout.write(
    "RESULT: FAIL — add a term that makes the order total, or say in the query why ties cannot " +
      "occur. A timestamp is not unique: 400 consecutive clock reads shared one millisecond.\n",
  );
  process.exit(1);
}
process.stdout.write(
  `RESULT: PASS — ${total.length} timestamp ordering(s) name a tiebreaker and ${excused.size} are ` +
    "excused by name; presence of a second term is all this proves, not that the pair is unique.\n",
);
