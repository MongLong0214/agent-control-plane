import { describe, expect, it } from "vitest";

import { SCHEMA_VERSION } from "../../src/db/database.ts";
import {
  LEDGER_TRIGGER_NAMES,
  ledgerTriggerDdl,
} from "../../src/db/migrations.ts";

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
 * What remains here is the half that reads the DDL a migration would run. The half that runs a
 * real chain moved to `the-deployments-own-v25-migrates` and
 * `an-incremental-migration-owns-what-it-creates`, which start from the deployment's own v25
 * rather than a current database stripped down to look like one.
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
