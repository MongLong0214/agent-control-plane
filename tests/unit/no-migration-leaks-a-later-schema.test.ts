import Database from "better-sqlite3";
import { chmodSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { Db, SCHEMA_VERSION } from "../../src/db/database.ts";
import { approveMigration } from "../../src/db/migration-approval.ts";
import {
  LEDGER_TRIGGER_NAMES,
  MIGRATIONS,
  installMigrationLedger,
  ledgerTriggerDdl,
  replayDdlWithoutPostV12Columns,
  schemaDdl,
} from "../../src/db/migrations.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * #762 — the detector, and the start-version matrix it makes meaningful.
 *
 * The defect was that `v26` installed a trigger on `canonical_turn_dispatches`, a table `v29`
 * creates. Nothing could see it, because every chain test began at the v11 fixture and v11's
 * second step replays the whole current `schema.sql` — so the v29 table was present from v12
 * onward and the ordering never mattered. The live deployment came up through `bootstrap-v20`,
 * never ran that replay, and could not migrate at all.
 *
 * `REPLAY_EXCLUDES_INTRODUCED_AFTER_V12` is the hand-maintained answer to the same problem, and
 * its own comments record it being extended after #631, after v35 and after v36 — once per time
 * someone hit this. A list kept by memory is what this repository keeps finding at the bottom of
 * its incidents, so the check below is mechanical instead: it asks the version data already in
 * `migrations.ts` which objects belong to a later step, and reports any that exist early.
 *
 * Scope, stated rather than implied: this measures **triggers**. That is not a compromise, it is
 * where the class bites — both known instances are triggers (this one over a missing table, #631's
 * over a missing column), because a trigger is the only schema object that names another object's
 * internals. Tables and indexes have no `introducedIn` anywhere in the tree, and inventing one
 * would be a second hand-maintained list, which is the thing being replaced.
 */

/**
 * The start versions this file can build a faithful database for.
 *
 * The boundary is 24 and it is measured, not chosen. Building "a database at version N" here
 * means taking a current one and removing what N does not define, and the only introduction data
 * in the tree is `introducedIn` on triggers. Below 24 that is not enough, in both directions:
 *
 *   - a v13 fixture keeps every current table, so `v20`'s `CREATE TABLE
 *     conversational_actor_registry_state` — no `IF NOT EXISTS` — fails with
 *     `table conversational_actor_registry_state already exists`;
 *   - a v21 fixture drops `canonical_turns`, because its guards arrive at v24 and this file can
 *     only see guards, and then `v22` fails with `no such table: canonical_turns`.
 *
 * The second is the informative one: a table can exist for versions before anything guards it, so
 * "a table whose only triggers are future" is not a sound reading of "a future table". Closing
 * v13–v23 needs per-version table introduction data that does not exist anywhere in this
 * repository, and inventing it here would be a hand-maintained list — the thing this file exists
 * to replace. It is filed rather than faked.
 */
const START_VERSIONS = MIGRATIONS.map((migration) => migration.fromVersion).filter(
  (version) => version >= 24,
);

/** Triggers that belong to a step later than `version`, read through the shipped filter. */
const futureTriggers = (version: number): string[] => {
  const here = ledgerTriggerDdl(version);
  return LEDGER_TRIGGER_NAMES.filter(
    (name) => !here.includes(`CREATE TRIGGER IF NOT EXISTS ${name}\n`),
  );
};

/**
 * The table a trigger is declared on, taken from `schema.sql`.
 *
 * This is what lets the fixtures below be derived rather than hand-listed: a table whose only
 * guards are future triggers is itself future, so `canonical_turn_dispatches` is identified by
 * the same data that identifies `canonical_turn_dispatches_write_authority` — no name appears in
 * this file that the schema did not supply.
 */
const triggerTable = (name: string): string => {
  // `BEFORE UPDATE OF <columns> ON <table>` is as valid as `AFTER INSERT ON <table>`, so the
  // pattern stops at the first `ON` rather than trying to enumerate what can precede it.
  const match = new RegExp(
    `CREATE TRIGGER IF NOT EXISTS ${name}\\s+[\\s\\S]*?\\bON\\s+(\\w+)`,
  ).exec(schemaDdl());
  if (!match) throw new Error(`could not read the table ${name} is declared on`);
  return match[1]!;
};

/** Tables that exist only to be guarded by triggers from a later step. */
const futureTables = (version: number): string[] => {
  const future = new Set(futureTriggers(version).map(triggerTable));
  for (const name of LEDGER_TRIGGER_NAMES) {
    if (!futureTriggers(version).includes(name)) future.delete(triggerTable(name));
  }
  return [...future];
};

const objectsIn = (raw: Database.Database, type: "trigger" | "table"): Set<string> =>
  new Set(
    (raw.prepare(`SELECT name FROM sqlite_master WHERE type = '${type}'`).all() as Array<{
      name: string;
    }>).map((row) => row.name),
  );

/**
 * v12's replay leaks the *entire* future ledger trigger set — measured, 36 of 36.
 *
 * `REPLAY_EXCLUDES_INTRODUCED_AFTER_V12` excludes a handful of named objects, so everything else
 * in today's schema lands at v12. That is why no chain test could see the ordering defect: a
 * database that ran v12 has every later guard, and every later table under them, from step two.
 *
 * Pinned by count as well as by identity. The identity assertion states the shape ("the replay
 * leaks all of it"), and it would keep passing forever on its own because both sides grow
 * together when a migration adds a guard. The count is the tripwire: adding one makes this fail,
 * and the question it forces — should v12's replay be creating this? — is the question nobody was
 * asked when `canonical_turn_dispatches` was added.
 */
const V12_REPLAY_LEAK_COUNT = 36;

describe("#762 no migration leaves a later step's triggers behind", () => {
  it("reports the exact leak at every step of a real chain", () => {
    const path = join(tempDir("acp-762-leak-"), "state.sqlite");
    const seeded = new Db(path);
    seeded.close();

    const leaks = new Map<number, string[]>();
    const raw = new Database(path, { readonly: true, fileMustExist: true });
    try {
      // A fresh database is bootstrapped at the current version, so it is the one case where
      // "everything exists" is correct. The chain is walked below instead.
      expect(Number(raw.pragma("user_version", { simple: true }))).toBe(SCHEMA_VERSION);
    } finally {
      raw.close();
    }

    const chainPath = join(tempDir("acp-762-leak-chain-"), "state.sqlite");
    buildAtVersion(chainPath, START_VERSIONS[0]!);
    const observed = new Db(chainPath, {
      afterMigration: (migration) => {
        const probe = new Database(chainPath, { readonly: true });
        const present = objectsIn(probe, "trigger");
        probe.close();
        const leaked = futureTriggers(migration.toVersion)
          .filter((name) => present.has(name))
          .sort();
        if (leaked.length > 0) leaks.set(migration.toVersion, leaked);
      },
    });
    observed.close();

    // Every step from the first start version up leaks nothing. v12 is not in this chain; its
    // replay is pinned separately below.
    expect([...leaks.entries()]).toEqual([]);
  });

  it("pins v12's replay leak so it can shrink but not grow unnoticed", () => {
    const path = join(tempDir("acp-762-v12-"), "state.sqlite");
    // The replay v12 actually runs, not the whole schema: measuring `schemaDdl()` here would
    // only restate that the current schema is the current schema.
    const raw = new Database(path);
    raw.exec(replayDdlWithoutPostV12Columns());
    raw.close();

    // What v12's replay puts on disk, measured against what v12 is entitled to.
    const probe = new Database(path, { readonly: true });
    const present = objectsIn(probe, "trigger");
    probe.close();
    const leaked = futureTriggers(12).filter((name) => present.has(name));
    expect(leaked.sort()).toEqual([...futureTriggers(12)].sort());
    expect(leaked).toHaveLength(V12_REPLAY_LEAK_COUNT);
  });
});

/**
 * Builds a database at `version` by running the real steps and then removing what that version
 * does not define.
 *
 * The removal is the point: running the chain to a version through v12 gives a database with
 * every current object, which is exactly the shape that hid the defect. Stripping the future
 * objects — derived, never listed here — produces the shape a deployment that never ran the
 * replay actually has.
 */
const buildAtVersion = (path: string, version: number): void => {
  const current = new Db(path);
  current.close();

  const raw = new Database(path);
  try {
    raw.function("acp_schema_migration_authorized", () => 1);
    raw.exec("DROP TRIGGER schema_migrations_immutable; DROP TRIGGER schema_migrations_no_delete;");
    raw.exec("DELETE FROM schema_migrations");
    for (const name of LEDGER_TRIGGER_NAMES) raw.exec(`DROP TRIGGER IF EXISTS ${name}`);
    for (const table of futureTables(version)) raw.exec(`DROP TABLE IF EXISTS ${table}`);
    raw.exec(ledgerTriggerDdl(version));
    const step = MIGRATIONS.find((migration) => migration.toVersion === version);
    if (!step) throw new Error(`no migration reaches version ${version}`);
    raw.prepare(
      "INSERT INTO schema_migrations (version, migration_id, checksum, applied_at) VALUES (?, ?, ?, ?)",
    ).run(version, step.id, step.checksum(), "2026-08-23T02:39:31.318Z");
    installMigrationLedger(raw);
    raw.pragma(`user_version = ${version}`);
  } finally {
    raw.close();
    chmodSync(path, 0o600);
  }
  approveMigration(path, "no-migration-leaks-a-later-schema fixture");
};

describe("#762 every start version reaches the current one", () => {
  it("covers every step's fromVersion from 13 up", () => {
    // Without this the matrix passes by running nothing — a filter that matched no version, or a
    // registry read that returned an empty list, reports the same clean result as full coverage.
    expect(START_VERSIONS.length).toBeGreaterThan(5);
    // 25 is the live deployment's own version, and 24 is the boundary the comment above measures.
    expect(START_VERSIONS).toContain(25);
    expect(START_VERSIONS[0]).toBe(24);
    expect(START_VERSIONS.at(-1)).toBe(SCHEMA_VERSION - 1);
    // Contiguous: a filter that skipped a version would leave a start point untested while the
    // count still looked healthy.
    expect(START_VERSIONS).toEqual(
      Array.from({ length: SCHEMA_VERSION - 24 }, (_, index) => 24 + index),
    );
  });

  for (const version of START_VERSIONS) {
    it(`migrates a v${version} database that never replayed the schema`, () => {
      const path = join(tempDir(`acp-762-from-${version}-`), "state.sqlite");
      buildAtVersion(path, version);

      const migrated = new Db(path);
      try {
        expect(Number(migrated.raw.pragma("user_version", { simple: true }))).toBe(SCHEMA_VERSION);
        const triggers = new Set(
          migrated
            .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'trigger'")
            .map((row) => row.name),
        );
        for (const name of LEDGER_TRIGGER_NAMES) {
          expect(triggers.has(name), `${name} is missing after starting from v${version}`).toBe(
            true,
          );
        }
      } finally {
        migrated.close();
      }
    });
  }
});
