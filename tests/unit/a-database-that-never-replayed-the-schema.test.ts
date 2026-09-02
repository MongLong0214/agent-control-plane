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
} from "../../src/db/migrations.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * #762 — every chain test started from the v11 fixture, and v11's *second* step
 * (`v12-migration-ledger-and-invariant-replay`) replays the whole of today's `schema.sql`. So
 * every database under test carried every current table from v12 onward, and no migration could
 * be caught depending on a table a later migration creates.
 *
 * The live deployment came up through `bootstrap-v20` instead. It never ran that replay, so it
 * reached v25 with the tables v25 knew about and nothing more — and `v26-ledger-trigger-bodies`,
 * which recreates "the ledger triggers", died on
 * `no such table: main.canonical_turn_dispatches`. That table is created by v29. Zero steps
 * committed; the deployment could not be migrated at all.
 *
 * These are the two halves of not being able to observe that again: one that reads the DDL a
 * migration would run, and one that runs a real chain from a database shaped the way the
 * deployment's was.
 */

/** Every ledger trigger, with the version it first exists at, read out of the source of truth. */
const introducedIn = (name: string): number => {
  // Read through the shipped filter rather than a copy of the table: asking
  // `ledgerTriggerDdl(v)` which names it emits is the same question the migrations ask, so a
  // change in how that filter reads its versions is visible here rather than modelled here.
  for (let version = 0; version <= SCHEMA_VERSION; version += 1) {
    if (ledgerTriggerDdl(version).includes(`CREATE TRIGGER IF NOT EXISTS ${name}\n`)) return version;
  }
  throw new Error(`${name} is never emitted by ledgerTriggerDdl at any version`);
};

describe("#762 a migration installs only the triggers that exist at its own version", () => {
  it("emits no ledger trigger from a version later than the one asked for", () => {
    const offenders: string[] = [];
    for (let version = 0; version <= SCHEMA_VERSION; version += 1) {
      const ddl = ledgerTriggerDdl(version);
      for (const name of LEDGER_TRIGGER_NAMES) {
        const emitted = ddl.includes(`CREATE TRIGGER IF NOT EXISTS ${name}\n`);
        if (emitted && introducedIn(name) > version) {
          offenders.push(`${name} (introduced ${introducedIn(name)}) emitted at v${version}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("still emits the whole set when asked without a version", () => {
    // The negative control. A filter that returned nothing, or that dropped a guard the current
    // schema requires, would satisfy the case above and leave every governed table unguarded.
    const all = ledgerTriggerDdl();
    for (const name of LEDGER_TRIGGER_NAMES) {
      expect(all, `${name} is missing from the unfiltered ledger trigger DDL`).toContain(
        `CREATE TRIGGER IF NOT EXISTS ${name}\n`,
      );
    }
    expect(ledgerTriggerDdl(SCHEMA_VERSION)).toBe(all);
  });

  it("names canonical_turn_dispatches triggers only from the version that creates the table", () => {
    // The specific instance, kept as its own case because the general rule above passes on a
    // filter that is right for the wrong reason — for example one keyed on a hand-written cutoff.
    const dispatchTriggers = LEDGER_TRIGGER_NAMES.filter((name) =>
      name.startsWith("canonical_turn_dispatches_"),
    );
    expect(dispatchTriggers.length).toBeGreaterThan(0);
    for (const name of dispatchTriggers) {
      expect(ledgerTriggerDdl(28)).not.toContain(`CREATE TRIGGER IF NOT EXISTS ${name}\n`);
      expect(ledgerTriggerDdl(29)).toContain(`CREATE TRIGGER IF NOT EXISTS ${name}\n`);
    }
  });
});

/**
 * Builds a v25 database that never ran v12's full-schema replay.
 *
 * Modelled by removing what that replay is the only reason to have: the tables no migration up to
 * v25 creates. That is the difference between the fixture lineage and the deployment's, and it is
 * the difference the defect lived in.
 */
const asV25WithoutLaterTables = (path: string): void => {
  const current = new Db(path);
  current.close();

  const raw = new Database(path);
  try {
    raw.function("acp_schema_migration_authorized", () => 1);
    raw.exec("DROP TRIGGER schema_migrations_immutable; DROP TRIGGER schema_migrations_no_delete;");
    raw.exec("DELETE FROM schema_migrations");
    // Every ledger trigger from after v25 goes with the tables they guard; a trigger cannot
    // outlive its table, and `bootstrap-v20` never had either.
    for (const name of LEDGER_TRIGGER_NAMES) {
      raw.exec(`DROP TRIGGER IF EXISTS ${name}`);
    }
    raw.exec("DROP TABLE IF EXISTS canonical_turn_dispatches");
    raw.exec(ledgerTriggerDdl(25));
    const v25 = MIGRATIONS.find((migration) => migration.toVersion === 25);
    if (!v25) throw new Error("v25 migration is absent from the ordered registry");
    raw.prepare(
      "INSERT INTO schema_migrations (version, migration_id, checksum, applied_at) VALUES (?, ?, ?, ?)",
    ).run(25, v25.id, v25.checksum(), "2026-08-23T02:39:31.318Z");
    installMigrationLedger(raw);
    raw.pragma("user_version = 25");
  } finally {
    raw.close();
    chmodSync(path, 0o600);
  }
  approveMigration(path, "a-database-that-never-replayed-the-schema fixture");
};

describe("#762 a v25 database that never replayed the schema", () => {
  it("does not carry the table a later migration creates", () => {
    const path = join(tempDir("acp-762-shape-"), "state.sqlite");
    asV25WithoutLaterTables(path);

    const raw = new Database(path, { readonly: true, fileMustExist: true });
    try {
      expect(Number(raw.pragma("user_version", { simple: true }))).toBe(25);
      expect(
        raw
          .prepare(
            "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'canonical_turn_dispatches'",
          )
          .get(),
      ).toEqual({ n: 0 });
    } finally {
      raw.close();
    }
  });

  it("migrates all the way to the current version", () => {
    const path = join(tempDir("acp-762-chain-"), "state.sqlite");
    asV25WithoutLaterTables(path);

    const applied: string[] = [];
    const migrated = new Db(path, { afterMigration: (migration) => applied.push(migration.id) });
    try {
      expect(Number(migrated.raw.pragma("user_version", { simple: true }))).toBe(SCHEMA_VERSION);
      // Named rather than counted: the count alone passes on a chain that ran the wrong steps.
      expect(applied[0]).toBe("v26-ledger-trigger-bodies");
      expect(applied).toContain("v29-a-dispatch-is-a-fact");
      expect(applied.at(-1)).toBe(
        MIGRATIONS.find((migration) => migration.toVersion === SCHEMA_VERSION)?.id,
      );
      // And it arrives with the guards, not merely at the version: a chain that skipped the
      // trigger DDL to get past the table would reach 36 with the ledger unguarded.
      const triggers = new Set(
        migrated
          .all<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'trigger'",
          )
          .map((row) => row.name),
      );
      for (const name of LEDGER_TRIGGER_NAMES) {
        expect(triggers.has(name), `${name} is missing after the chain`).toBe(true);
      }
    } finally {
      migrated.close();
    }
  });
});
