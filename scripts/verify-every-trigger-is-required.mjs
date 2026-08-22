#!/usr/bin/env node
/**
 * Fails when a trigger the schema declares is in no required-trigger registry.
 *
 * `assertLoadBearingInvariants` refuses to open a database missing any trigger in those
 * registries. A trigger declared in `schema.sql` and named by none of them is created on a fresh
 * install and never checked again: drop it from a live database and nothing notices, which is the
 * whole failure that check exists to prevent, arriving through the registry rather than through
 * the database.
 *
 * The registries are hand-written lists, and this repository has now been corrected four times for
 * a hand-written list that stopped matching what it enumerates — a census pattern that could not
 * see a trigger form, a drop list covering eight of twenty-eight, a path set naming five of five
 * until a sixth arrived, an exemption list both of whose entries were dead. This is the
 * correspondence check for the largest of them.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const schema = readFileSync(join(ROOT, "src/db/schema.sql"), "utf8");
const migrations = readFileSync(join(ROOT, "src/db/migrations.ts"), "utf8");

// `IF NOT EXISTS` optional. Every trigger in this schema is written with it today, and a check
// that requires it counts only the ones written the way its author pictured — measured: a trigger
// added without it was invisible to this gate and to the REPLACE census, while both printed PASS.
// That is the third time on this branch a pattern has been narrower than the thing it enumerates.
const declared = [...schema.matchAll(/CREATE\s+TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/g)].map(
  (m) => m[1],
);
// Whitespace-tolerant, because a registry entry wrapped across lines is the same entry. The
// pattern this replaces required one line, so re-formatting an entry made this gate say the
// trigger was "named by no registry" — a true failure with a false reason, which sends whoever
// reads it to add a duplicate.
const required = new Set(
  [...migrations.matchAll(/\{\s*name:\s*"(\w+)"\s*,\s*sentinel:/g)].map((m) => m[1]),
);

const unwatched = declared.filter((name) => !required.has(name));

/**
 * A registry entry claiming a schema version has to be installed by that version's migration.
 *
 * `assertLoadBearingInvariants` skips an entry whose `introducedIn` exceeds the database's
 * version. Claim a version too high and the trigger is never required on the databases that do
 * have it; claim one too low and a legitimately older database is refused for missing something
 * its version never installed. Neither shows up as an absent trigger, which is all the check above
 * can see — and two hand-written lists disagreeing is this branch's most repeated defect.
 */
const installedByV26 = new Set(
  ["PROVENANCE_NO_REPLACE_TRIGGERS", "LEDGER_TRIGGER_NAMES"].flatMap((constant) => {
    const body = new RegExp(`${constant}[^=]*= \\[([\\s\\S]*?)\\n\\];`).exec(migrations);
    return body === null ? [] : [...body[1].matchAll(/"(\w+)"/g)].map((m) => m[1]);
  }),
);
const claimedAt26 = [
  ...migrations.matchAll(/\{\s*name:\s*"(\w+)"\s*,\s*sentinel:\s*"[^"]*"\s*,\s*introducedIn:\s*26\s*,?\s*\}/g),
].map((m) => m[1]);
const unclaimed = claimedAt26.filter((name) => !installedByV26.has(name));

if (unclaimed.length > 0) {
  for (const name of unclaimed) {
    process.stdout.write(
      `  ${name} is required from schema version 26 and v26 does not install it.\n` +
        "    Databases at 26 would be refused for missing a trigger nothing gave them.\n",
    );
  }
  process.stdout.write(`\nRESULT: FAIL — ${unclaimed.length} entr(y/ies) claim a version that does not install them.\n`);
  process.exit(1);
}

if (unwatched.length > 0) {
  for (const name of unwatched) {
    process.stdout.write(
      `  ${name} is declared in schema.sql and named by no required-trigger registry.\n` +
        "    A database that lost it would open clean.\n",
    );
  }
  process.stdout.write(
    "\nAdd it to the registry its table belongs to, with the sentinel its body raises.\n" +
      `RESULT: FAIL — ${unwatched.length} declared trigger(s) nothing would miss.\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `RESULT: PASS — all ${declared.length} declared trigger(s) are named by a required registry ` +
    `(${required.size} entries, the extra ${required.size - declared.length} installed by migrations).\n`,
);
