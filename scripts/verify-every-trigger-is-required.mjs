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

const declared = [...schema.matchAll(/CREATE TRIGGER IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
const required = new Set([...migrations.matchAll(/\{ name: "(\w+)", sentinel:/g)].map((m) => m[1]));

const unwatched = declared.filter((name) => !required.has(name));

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
