#!/usr/bin/env node
/**
 * Fails when a migration that already exists changes what it does.
 *
 * The whole discipline of `migrations.ts` is that a step, once written, is what every database
 * that ran it actually ran. It was broken twice: v24's DDL was edited in place across two
 * correction rounds, and a database created at the earlier v24 then sat at version 24 with bodies
 * nobody's code expected, took the same-version path at startup, and could not settle a turn. The
 * repair for that — v25 — repaired eight objects of twenty-eight, so a third migration was needed
 * to repair the repair.
 *
 * Both times the rule was known and written down in that file's own comments. Naming it did not
 * catch the next instance, which is the pattern this repository keeps finding.
 *
 * So the ids and their checksums are committed, and changing one is a diff someone has to explain
 * rather than an edit that looks like any other. Adding a migration is an ordinary append; the
 * manifest grows and nothing here objects.
 *
 * Usage: verify-migrations-are-immutable.mjs [--update]
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
/**
 * Beside the migrations rather than under evidence/. It is not a measurement of a tree — it is the
 * contract those migrations are held to, and it changes only when one is added. Under evidence/ it
 * failed the freshness gate for having no source digest, which was that gate correctly saying this
 * file is not the kind of thing it checks.
 */
const MANIFEST = join(ROOT, "src/db/migration-checksums.json");

const { MIGRATIONS, SCHEMA_VERSION } = await import(join(ROOT, "src/db/migrations.ts"));

/**
 * Runs `work` with one harmless comment appended to schema.sql, then puts the file back.
 *
 * Classifying by observation rather than by a list: a migration that reads the schema at run time
 * produces a different checksum when the schema differs, and one holding its own DDL does not. A
 * list would have to be maintained by whoever adds the next schema-reading migration, and this
 * file exists because a rule that depends on someone remembering it was already broken twice.
 *
 * The write is restored in `finally`, and the appended line is a SQL comment, so a crash between
 * the two leaves a schema that still parses and differs from git by one line.
 */
const SCHEMA = join(ROOT, "src/db/schema.sql");

/**
 * Where the original is parked while the probe is applied, so a death mid-probe is repairable.
 *
 * The same discipline `verify-guards-are-falsifiable.mjs` uses, for the same reason: this writes
 * to a tracked source file, and a process that dies between the write and the restore leaves that
 * file altered with nothing saying so. A `finally` covers a thrown error and covers neither a
 * SIGKILL nor a machine losing power.
 */
const PARKED = join(ROOT, execFileSync("git", ["rev-parse", "--git-path", "schema-probe-in-flight"], {
  cwd: ROOT,
  encoding: "utf8",
}).trim());

/** Puts back whatever a previous run was holding, before this one reads anything. */
const repairAbandonedProbe = () => {
  if (!existsSync(PARKED)) return;
  const parked = readFileSync(PARKED, "utf8");
  if (readFileSync(SCHEMA, "utf8") !== parked) {
    writeFileSync(SCHEMA, parked);
    process.stdout.write("  a previous run died mid-probe; src/db/schema.sql restored\n");
  }
  rmSync(PARKED, { force: true });
};

let holding = null;
const putBack = () => {
  if (holding === null) return;
  writeFileSync(SCHEMA, holding);
  rmSync(PARKED, { force: true });
  holding = null;
};
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    putBack();
    process.exit(130);
  });
}
process.on("uncaughtException", (error) => {
  putBack();
  throw error;
});

// Before anything reads the schema, including the import above having read it: a run that died
// mid-probe left the file altered, and every check after that would be measuring the probe.
repairAbandonedProbe();

/**
 * Runs `work` with one SQL comment appended to schema.sql, then puts the file back.
 *
 * Classifying by observation rather than by a list: a migration that reads the schema at run time
 * produces a different checksum when the schema differs, and one holding its own DDL does not. A
 * list would have to be maintained by whoever adds the next schema-reading migration, and this
 * file exists because a rule that depends on someone remembering it was already broken twice.
 *
 * The window is one synchronous call wide and the original is on disk throughout it, so a reader
 * that lands inside it sees a schema that still parses and differs by a comment — and the next run
 * of this script puts it back regardless of how the last one ended.
 */
const withPerturbedSchema = (work) => {
  const original = readFileSync(SCHEMA, "utf8");
  writeFileSync(PARKED, original);
  holding = original;
  // Inside a trigger body, not appended at the end. A migration that reads the schema through a
  // narrow extraction — `ledgerTriggerDdl` takes exactly the text between a trigger's name and its
  // `END;` — does not see a trailing comment at all, so the first version of this probe classified
  // v25 and v26 as holding their own DDL and froze them. Its own docstring names v26 as the kind
  // that must be excluded. A review found the contradiction; the consequence was latent, and would
  // have arrived as "v26 changed what it does" the next time a ledger trigger body was legitimately
  // edited, which is the one thing v26 exists to do.
  // Every trigger body, so that any extraction sees it however narrow. Probing one place is not
  // enough: the first attempt appended to the end of the file and a second put a comment in the
  // first trigger, and both left v25 and v26 classified as holding their own DDL — they read the
  // schema through regexes that take exactly the text between a named trigger and its `END;`.
  const probed = original.replaceAll("\nEND;", "\n  -- checksum classification probe\nEND;");
  if (probed === original) {
    process.stdout.write("  schema.sql has no trigger body to probe\n\nRESULT: FAIL\n");
    process.exit(2);
  }
  writeFileSync(SCHEMA, probed);
  try {
    return work();
  } finally {
    putBack();
    // The check the harness learned to make: a restore that did not restore is the failure this
    // whole mechanism exists to prevent, and it is one comparison away from being observable.
    if (readFileSync(SCHEMA, "utf8") !== original) {
      process.stdout.write("  src/db/schema.sql was not restored\n\nRESULT: FAIL\n");
      process.exit(1);
    }
  }
};

/**
 * Migrations whose DDL is read from `schema.sql` when they run, rather than held as a constant.
 *
 * Their checksum hashes the live schema, so it moves every time any table or trigger anywhere is
 * edited — by design: v12 exists to replay the idempotent schema objects onto a v11 database that
 * is missing one, and v26 to replace ledger trigger bodies that drifted. Freezing them would mean
 * re-freezing on every schema change, and a check that has to be re-blessed constantly is a check
 * that gets re-blessed without being read.
 *
 * The case that actually failed twice is the other kind: v24 held its DDL in a constant and that
 * constant was edited across two correction rounds. Those are the ones frozen here.
 *
 * Derived rather than listed, so a new schema-reading migration is classified by what it does.
 */
const derivesFromSchema = (migration) => {
  const before = migration.checksum();
  const after = withPerturbedSchema(() => migration.checksum());
  return before !== after;
};

/** id → checksum, in chain order, for the migrations that hold their own DDL. */
const live = {};
for (const migration of MIGRATIONS) {
  if (derivesFromSchema(migration)) continue;
  live[migration.id] = migration.checksum();
}

if (process.argv.includes("--update")) {
  writeFileSync(MANIFEST, `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, live }, null, 2)}\n`);
  process.stdout.write(`RESULT: PASS — wrote ${Object.keys(live).length} checksum(s) to the manifest.\n`);
  process.exit(0);
}

let recorded;
try {
  recorded = JSON.parse(readFileSync(MANIFEST, "utf8")).live ?? {};
} catch {
  process.stdout.write(
    `  ${MANIFEST} is missing or unreadable.\n  Create it once with \`pnpm migrations:freeze\`.\n` +
      "\nRESULT: FAIL — nothing was compared.\n",
  );
  process.exit(2);
}

const changed = [];
const removed = [];
for (const [id, checksum] of Object.entries(recorded)) {
  if (!(id in live)) removed.push(id);
  else if (live[id] !== checksum) changed.push(id);
}
const added = Object.keys(live).filter((id) => !(id in recorded));

if (changed.length > 0 || removed.length > 0) {
  for (const id of changed) {
    process.stdout.write(
      `  ${id} changed what it does.\n` +
        "    A database that already ran it did not run this. If the step was wrong, the fix is a\n" +
        "    new migration that repairs it — v25 and v26 both exist because that was skipped once.\n",
    );
  }
  for (const id of removed) {
    process.stdout.write(`  ${id} is gone from the chain, and some database has run it.\n`);
  }
  process.stdout.write(
    "\nIf this change is deliberate — the migration has never been in a commit anyone ran —\n" +
      "re-freeze with `pnpm migrations:freeze` and say so in the commit message.\n" +
      `RESULT: FAIL — ${changed.length + removed.length} migration(s) are not what they were.\n`,
  );
  process.exit(1);
}

const note = added.length > 0 ? `, ${added.length} new (${added.join(", ")})` : "";
process.stdout.write(
  `RESULT: PASS — ${Object.keys(recorded).length} frozen migration(s) unchanged${note}.\n`,
);
