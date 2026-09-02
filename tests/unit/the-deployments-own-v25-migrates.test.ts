import Database from "better-sqlite3";
import { chmodSync, copyFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { Db, SCHEMA_VERSION } from "../../src/db/database.ts";
import { approveMigration } from "../../src/db/migration-approval.ts";
import { MIGRATIONS } from "../../src/db/migrations.ts";

/** The sealed owner trace — the same immutable input the provenance detector reads. */
const TRACE = JSON.parse(
  readFileSync(new URL("../fixtures/v25-owner-trace.json", import.meta.url), "utf8"),
) as { baselineVersion: number; objects: Record<string, { type: string; owner: number }> };
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * #762 — the deployment's own v25, migrated, with its contents compared before and after.
 *
 * The first attempt at this bootstrapped a current database, dropped the objects a v25 does not
 * have, and overwrote `user_version` — a v36 file wearing a v25 number. Review named it for what
 * it was: it proves nothing about what a real v25 *contains*, because every byte of it was
 * written by today's schema. So the fixture here is the deployment's actual schema, taken from
 * the pre-migration backup of the live `state.sqlite`
 * (`tests/fixtures/schema-v25-lineage.sql`), and the rows below are added to it rather than
 * carved out of something newer.
 *
 * That lineage is the one that could not migrate: bootstrapped at `bootstrap-v20`, carried to 25
 * by the build of the day, and therefore never through `v12`'s replay of the current schema —
 * which is what gave every other fixture the tables that later migrations own.
 */
const LINEAGE = readFileSync(
  new URL("../fixtures/schema-v25-lineage.sql", import.meta.url),
  "utf8",
);

/**
 * The deployment's own receipts, checksums included, sealed from the preserved backup.
 *
 * The previous version wrote `sha256:` + sixty-four `a`s. That is a shape, not a receipt: the
 * before/after comparison it fed proved the prefix survived, which is true of any value that
 * matches the regular expression, including one a rewrite put there. These are the real rows the
 * deployment recorded, read read-only from the pre-migration backup.
 */
const RECEIPTS = (
  JSON.parse(
    readFileSync(new URL("../fixtures/v25-lineage-receipts.json", import.meta.url), "utf8"),
  ) as {
    receipts: Array<{
      version: number;
      migrationId: string;
      checksum: string;
      appliedAt: string;
    }>;
  }
).receipts;

const NOW = "2026-08-23T02:39:31.318Z";

/**
 * Writes the immutable v25 artifact: the deployment's schema, its ledger history, and rows.
 *
 * The rows are the point of the comparison afterwards — a chain that reached 36 by rebuilding
 * tables would satisfy a version check and still have dropped what was in them.
 */
const writeV25Artifact = (path: string): void => {
  const raw = new Database(path);
  try {
    // The lineage carries the ledger's own write-authority guards, which call a function the
    // daemon registers. Registering it here rather than dropping the guards keeps the artifact
    // the shape the deployment has — dropping them would be the laundering this file exists to
    // avoid, one object smaller.
    raw.function("acp_schema_migration_authorized", () => 1);
    raw.exec(LINEAGE);
    for (const receipt of RECEIPTS) {
      raw.prepare(
        `INSERT INTO schema_migrations (version, migration_id, checksum, applied_at)
         VALUES (?, ?, ?, ?)`,
      ).run(receipt.version, receipt.migrationId, receipt.checksum, receipt.appliedAt);
    }
    raw.prepare(
      `INSERT INTO projects (project_id, name, created_at) VALUES (?, ?, ?)`,
    ).run("prj_lineage", "lineage", NOW);
    raw.prepare(
      `INSERT INTO sessions (session_id, incarnation, provider, model, lifecycle, created_at, updated_at)
       VALUES (?, 'inc-1', 'claude', 'opus', 'READY', ?, ?)`,
    ).run("ses_lineage", NOW, NOW);
    // Columns taken from the lineage's own `audit_events`, which is `at` and an autoincrement
    // integer id — not the shape the current schema has. Writing what today's code expects would
    // have been the same mistake as building the fixture from today's schema.
    raw.prepare(
      `INSERT INTO audit_events (at, kind, evidence_json) VALUES (?, ?, ?)`,
    ).run(NOW, "LINEAGE_MARK", JSON.stringify({ mark: "before" }));
    raw.pragma("user_version = 25");
  } finally {
    raw.close();
    chmodSync(path, 0o600);
  }
};

/** Everything the comparison below is about, read the same way before and after. */
const contents = (path: string) => {
  const raw = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return {
      userVersion: Number(raw.pragma("user_version", { simple: true })),
      projects: raw.prepare("SELECT project_id, name, created_at FROM projects ORDER BY project_id").all(),
      sessions: raw.prepare("SELECT session_id, provider, model, lifecycle FROM sessions ORDER BY session_id").all(),
      audit: raw.prepare("SELECT event_id, at, kind, evidence_json FROM audit_events ORDER BY event_id").all(),
      // `checksum` is in the projection because leaving it out let a receipt be rewritten while
      // the comparison still passed: version, id and timestamp can all survive a tampered
      // checksum, and the checksum is the part that says the step ran what it claims.
      ledger: raw
        .prepare(
          "SELECT version, migration_id, checksum, applied_at FROM schema_migrations ORDER BY version",
        )
        .all() as Array<{
        version: number;
        migration_id: string;
        checksum: string;
        applied_at: string;
      }>,
      tables: (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name),
      triggers: (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name),
      indexes: (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name),
    };
  } finally {
    raw.close();
  }
};

describe("#762 the deployment's own v25 lineage", () => {
  it("names nowhere in its bytes the object a later migration owns", () => {
    // Not a stylistic point. The fixture is the artifact an absence contract rests on, and a
    // comment mentioning the name is a grep hit that makes the contract unverifiable by the
    // cheapest check anyone would reach for. Read as raw bytes so no parser is between the
    // assertion and the file.
    const raw = readFileSync(
      new URL("../fixtures/schema-v25-lineage.sql", import.meta.url),
      "utf8",
    );
    const late = Object.entries(TRACE.objects)
      .filter(([, entry]) => entry.owner > TRACE.baselineVersion)
      .map(([name]) => name);
    expect(late.length).toBeGreaterThan(0);
    expect(late.filter((name) => raw.includes(name))).toEqual([]);
  });

  it("is a real v25, not a current database wearing a v25 number", () => {
    const artifact = join(tempDir("acp-762-artifact-"), "state.sqlite");
    writeV25Artifact(artifact);
    const before = contents(artifact);

    expect(before.userVersion).toBe(25);
    // The table v29 creates is absent. This is the difference the whole issue lives in, and a
    // fixture laundered from a current bootstrap would have it.
    expect(before.tables).not.toContain("canonical_turn_dispatches");
    // And the history is the deployment's, not a single synthesised receipt: a v20 bootstrap
    // followed by five steps, which is what `never ran v12` looks like in the ledger.
    expect(before.ledger.map((row) => row.version)).toEqual([20, 21, 22, 23, 24, 25]);
    expect(before.ledger[0]?.migration_id).toBe("bootstrap-v20");
    // The receipts are the deployment's, not synthesised: a real checksum is not a run of one
    // character, and the fixture would be worthless as evidence if it were.
    for (const row of before.ledger) {
      expect(row.checksum).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(row.checksum).not.toMatch(/^sha256:(.)\1{63}$/);
    }
    expect(before.ledger.some((row) => row.migration_id.startsWith("v12-"))).toBe(false);
  });

  it("rejects a receipt that is wrong but well formed", () => {
    // The mutation the format check could not see. Both values below satisfy every regular
    // expression the previous version applied — a real migration id and a real sha256 — and both
    // belong to a different step.
    const artifact = join(tempDir("acp-762-wrong-receipt-"), "state.sqlite");
    writeV25Artifact(artifact);
    const before = contents(artifact);

    const working = join(tempDir("acp-762-wrong-receipt-copy-"), "state.sqlite");
    copyFileSync(artifact, working);
    chmodSync(working, 0o600);
    approveMigration(working, "wrong-but-well-formed");
    const migrated = new Db(working);
    migrated.close();

    const raw = new Database(working);
    try {
      raw.function("acp_schema_migration_authorized", () => 1);
      raw.exec("DROP TRIGGER schema_migrations_immutable; DROP TRIGGER schema_migrations_no_delete;");
      // A checksum that is another step's, not a malformed one.
      const other = MIGRATIONS.find((m) => m.toVersion === 30)!;
      raw.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 29").run(
        other.checksum(),
      );
    } finally {
      raw.close();
    }

    const after = contents(working);
    const appended = after.ledger.slice(before.ledger.length);
    const expected = MIGRATIONS.filter((m) => m.fromVersion >= 25).map(
      (m) => `${m.toVersion}|${m.id}|${m.checksum()}`,
    );
    // Well formed, and not the receipt for the step it sits on.
    const tampered = appended.find((row) => row.version === 29)!;
    expect(tampered.checksum).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(appended.map((row) => `${row.version}|${row.migration_id}|${row.checksum}`)).not.toEqual(
      expected,
    );
  });

  it("migrates a byte-for-byte copy to the current version with its contents intact", () => {
    const artifact = join(tempDir("acp-762-artifact-src-"), "state.sqlite");
    writeV25Artifact(artifact);
    const before = contents(artifact);

    // A copy, so the artifact this run measured is still the artifact it started from.
    const working = join(tempDir("acp-762-artifact-copy-"), "state.sqlite");
    copyFileSync(artifact, working);
    chmodSync(working, 0o600);
    approveMigration(working, "the-deployments-own-v25-migrates");

    const applied: string[] = [];
    const migrated = new Db(working, { afterMigration: (m) => applied.push(m.id) });
    migrated.close();
    const after = contents(working);

    // Reached the current version, by the steps that were supposed to run.
    expect(after.userVersion).toBe(SCHEMA_VERSION);
    expect(applied).toEqual(
      MIGRATIONS.filter((m) => m.fromVersion >= 25).map((m) => m.id),
    );

    // User data is the same data, not merely the same count.
    expect(after.projects).toEqual(before.projects);
    expect(after.sessions).toEqual(before.sessions);
    expect(after.audit).toEqual(before.audit);

    // The original history is still the original history, with the new steps appended after it.
    expect(after.ledger.slice(0, before.ledger.length)).toEqual(before.ledger);
    expect(after.ledger.map((row) => row.version)).toEqual([
      ...before.ledger.map((row) => row.version),
      ...MIGRATIONS.filter((m) => m.fromVersion >= 25).map((m) => m.toVersion),
    ]);

    // Every appended receipt is compared to the migration it claims to be, not to a shape. A
    // well-formed id and a well-formed checksum belonging to a different step both pass a regular
    // expression and neither passes this.
    const appended = after.ledger.slice(before.ledger.length);
    expect(
      appended.map((row) => `${row.version}|${row.migration_id}|${row.checksum}`),
    ).toEqual(
      MIGRATIONS.filter((migration) => migration.fromVersion >= 25).map(
        (migration) => `${migration.toVersion}|${migration.id}|${migration.checksum()}`,
      ),
    );
    for (const row of appended) {
      // Full ISO, not a date prefix: `2026-09-02Tanything` satisfies the old check.
      expect(row.applied_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }

    // Nothing the v25 had was dropped on the way, and the table that could not be created is now
    // there. Stated as a superset rather than an equality: later steps add objects, and pinning
    // the exact set would fail on every correct addition.
    for (const name of before.tables) expect(after.tables).toContain(name);
    for (const name of before.triggers) expect(after.triggers).toContain(name);
    for (const name of before.indexes) expect(after.indexes).toContain(name);
    expect(after.tables).toContain("canonical_turn_dispatches");
  });
});
