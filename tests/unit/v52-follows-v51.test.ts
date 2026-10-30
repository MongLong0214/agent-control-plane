import Database from "better-sqlite3";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

import { Db, SCHEMA_VERSION } from "../../src/db/database.ts";
import { approveMigration } from "../../src/db/migration-approval.ts";
import { MIGRATIONS } from "../../src/db/migrations.ts";
import { main as stateAdmin } from "../../src/db/state-admin.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { laterObjectsIn, releasedChainImage } from "../helpers/released-chain-image.ts";
import { privateStatePath, schemaRowsOf, userVersionOf, type SchemaRow } from "../helpers/released-v44-schema.ts";
import { contentDigests } from "../helpers/released-v45-schema.ts";

afterAll(cleanupTempDirs);

/** v51's receipt as the build before its freeze computed it, from schema.sql at 3915f78c. */
const V51_CHECKSUM = "sha256:35966ee416fc1e79d53c1eeb8f00c51b92a2c4e10309838d93fab77060e9d39c";

/** What v51 installs, named here rather than read from the code under test. */
const V51_OBJECTS = [
  "buzz_events", "buzz_events_no_replace", "buzz_events_immutable", "buzz_events_no_delete",
  "holder_message_terminals", "outbox_holder_message_terminal", "holder_message_terminals_immutable",
  "holder_message_terminals_no_delete", "holder_message_terminals_no_replace", "role_room_memberships",
  "role_room_history_unknown", "outbox_sent_destinations",
];

/** The three tables v52 rebuilds, and what it adds. */
const V52_REBUILT = ["projects", "repositories", "bootstrap_applications"];
const V52_ADDED = ["resident_project_provisioning", "canonical_session_entitlements", "project_retirements"];

const rowsOn = (rows: readonly SchemaRow[], tables: readonly string[]): SchemaRow[] =>
  rows.filter((row) => tables.includes(row.tbl_name) && row.sql !== null);

const seedV50 = (path: string): void => {
  const raw = new Database(path);
  try {
    raw.exec(`INSERT INTO projects (project_id, name, created_at) VALUES ('p-old', 'old', '2026-01-01T00:00:00.000Z');
      INSERT INTO repositories (rowid, repository_id, identity, checkout_path, project_id, created_at)
        VALUES (42, 'repo-old', 'github:acme/old', '/old', 'p-old', '2026-01-01T00:00:00.000Z');
      INSERT INTO runs (run_id, kind, execution_mode, priority, state, goal, contract_digest, created_at)
        VALUES ('run-boot', 'STANDARD_WORK', 'STANDARD', 'NORMAL', 'QUEUED', 'boot', 'sha256:c', '2026-01-01');
      INSERT INTO bootstrap_applications (run_id, project_id, repository_identity, bootstrap_operation_id, plan_digest,
          manifest_digest, planned_outputs_digest, candidate_snapshot_digest, review_digest, approval_digest, phase, reserved_at)
        VALUES ('run-boot', 'p-new', 'github:acme/new', 'op-1', 'sha256:p', 'sha256:m', 'sha256:o', 'sha256:s', 'sha256:r',
          'sha256:a', 'RESERVED', '2026-01-01T00:00:00.000Z');
      INSERT INTO outbox (message_id, idempotency_key, role_key, binding_generation, target_session_id, kind, payload_json,
          payload_digest, request_fingerprint, expires_at, created_at, status, last_error)
        VALUES ('acked-before-v51', 'key-acked', 'CEO', 1, 'target', 'CEO_NOTIFICATION', '{}', 'digest', 'fingerprint',
          '2026-01-01', '2025-01-01', 'ACKED', NULL);`);
  } finally {
    raw.close();
  }
};

describe("v52 follows v51", () => {
  it("chains v50 → v51 → v52, and frozen v51 keeps the checksum it was released with", () => {
    // #1258 appends v53, #1189's run-state exits v54 and #1189 B5's revision re-entry v55 after v52; this row
    // is about v50 → v52, which the chain still runs in order.
    expect(SCHEMA_VERSION).toBe(56);
    expect(MIGRATIONS.filter((step) => step.toVersion >= 50 && step.toVersion <= 52).map((step) => [step.id, step.fromVersion, step.toVersion])).toEqual([
      ["v50-post-merge-verification-reentry", 49, 50],
      ["v51-durable-recipient-delivery", 50, 51],
      ["v52-resident-project-provisioning", 51, 52],
    ]);
    expect(MIGRATIONS.find((step) => step.toVersion === 51)!.checksum()).toBe(V51_CHECKSUM);
    const frozen = readFileSync(new URL("../../src/db/schema-v51.sql", import.meta.url), "utf8");
    for (const name of V51_OBJECTS) expect(frozen, name).toContain(`IF NOT EXISTS ${name}`);
    for (const name of V52_ADDED) expect(frozen, name).not.toContain(name);
    expect(frozen).not.toContain("-- v52:");
  });

  it("plans a v50 database's start through v51 and v52 and lists v51's anchor fallbacks for the deployment", async () => {
    const path = releasedChainImage(privateStatePath("acp-v52-plan-from-v50-"), 50);
    seedV50(path);
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      expect(await stateAdmin(["migration-plan", "--database", path])).toBe(0);
    } finally {
      spy.mockRestore();
    }
    const plan = JSON.parse(writes.join("")) as Record<string, unknown>;
    expect(plan).toMatchObject({
      onDiskVersion: 50,
      buildVersion: 56,
      plan: {
        fromVersion: 50,
        toVersion: 56,
        migrations: ["v51-durable-recipient-delivery", "v52-resident-project-provisioning", "v53-verification-result-history", "v54-run-state-exits", "v55-approved-run-revision-reentry", "v56-adopted-bootstrap-first-manifest"],
      },
    });
    // The field the deployment refuses on is present across the whole 50 → 52 span, and empty here.
    expect(plan).toHaveProperty("v51AnchorFallback");
    expect(plan["v51AnchorFallback"]).toEqual([]);
    expect(userVersionOf(path)).toBe(50);
  });

  it("upgrades a v50 database through v51 and v52, keeping every row and every v51 object exactly once", () => {
    const path = releasedChainImage(privateStatePath("acp-v52-from-v50-"), 50);
    seedV50(path);
    const before = contentDigests(path, 50);
    const repositoriesBefore = (() => {
      const raw = new Database(path, { readonly: true });
      try { return raw.prepare("SELECT rowid, * FROM repositories ORDER BY rowid").all(); } finally { raw.close(); }
    })();
    expect(before.userVersion).toBe(50);

    approveMigration(path, "v50 → v51 → v52 integration witness");
    let at51: Buffer | undefined;
    new Db(path, {
      afterMigration: (step) => {
        if (step.toVersion !== 51) return;
        const reader = new Database(path, { readonly: true });
        try { at51 = reader.serialize(); } finally { reader.close(); }
      },
    }).close();

    // The intermediate image is v51's: its objects, none of v52's.
    expect(at51).toBeDefined();
    const v51Path = join(tempDir("acp-v52-at51-"), "state.sqlite");
    writeFileSync(v51Path, at51!);
    expect(laterObjectsIn(v51Path, 51)).toEqual([]);
    const v51Names = schemaRowsOf(v51Path).map((row) => row.name);
    for (const name of V51_OBJECTS) expect(v51Names, name).toContain(name);

    // Every row v50 held is still there, v52's new columns aside, and repositories keep their rowids.
    const after = contentDigests(path, 50);
    expect(after.userVersion).toBe(56);
    const { schema_migrations: receiptsBefore, ...restBefore } = before.tables;
    const { schema_migrations: receiptsAfter, ...restAfter } = after.tables;
    expect(Object.fromEntries(Object.keys(restBefore).map((name) => [name, restAfter[name]]))).toEqual(restBefore);
    expect(receiptsAfter).not.toBe(receiptsBefore);

    const raw = new Database(path, { readonly: true });
    try {
      expect(raw.prepare("SELECT rowid, repository_id, identity, project_id FROM repositories ORDER BY rowid").all())
        .toEqual([{ rowid: 42, repository_id: "repo-old", identity: "github:acme/old", project_id: "p-old" }]);
      expect((raw.prepare("SELECT rowid, * FROM repositories ORDER BY rowid").all() as Record<string, unknown>[])
        .map(({ retired_at: _retired, ...row }) => row)).toEqual(repositoriesBefore);
      expect(raw.prepare("SELECT version, migration_id, checksum FROM schema_migrations WHERE version >= 50 ORDER BY version").all())
        .toEqual([
          { version: 50, migration_id: "v50-post-merge-verification-reentry", checksum: MIGRATIONS.find((step) => step.toVersion === 50)!.checksum() },
          { version: 51, migration_id: "v51-durable-recipient-delivery", checksum: V51_CHECKSUM },
          { version: 52, migration_id: "v52-resident-project-provisioning", checksum: MIGRATIONS.find((step) => step.toVersion === 52)!.checksum() },
          { version: 53, migration_id: "v53-verification-result-history", checksum: MIGRATIONS.find((step) => step.toVersion === 53)!.checksum() },
          { version: 54, migration_id: "v54-run-state-exits", checksum: MIGRATIONS.find((step) => step.toVersion === 54)!.checksum() },
          { version: 55, migration_id: "v55-approved-run-revision-reentry", checksum: MIGRATIONS.find((step) => step.toVersion === 55)!.checksum() },
          { version: 56, migration_id: "v56-adopted-bootstrap-first-manifest", checksum: MIGRATIONS.find((step) => step.toVersion === 56)!.checksum() },
        ]);
      // v51's backfill survived the v52 rebuild.
      expect(raw.prepare("SELECT message_id FROM holder_message_terminals").pluck().all()).toEqual(["acked-before-v51"]);
      expect(raw.prepare("SELECT name FROM sqlite_schema WHERE name LIKE '%_v52_prior'").all()).toEqual([]);
    } finally {
      raw.close();
    }

    // The upgraded database carries v51's objects, the three rebuilt tables and v52's additions exactly as
    // a fresh v52 database does: nothing v51 created was dropped, duplicated or redefined by v52.
    const freshPath = join(tempDir("acp-v52-fresh-"), "state.sqlite");
    new Db(freshPath).close();
    expect(userVersionOf(freshPath)).toBe(SCHEMA_VERSION);
    const fresh = schemaRowsOf(freshPath);
    const upgraded = schemaRowsOf(path);
    for (const name of V51_OBJECTS) {
      const held = upgraded.filter((row) => row.name === name);
      expect(held, name).toHaveLength(1);
      expect(held, name).toEqual(fresh.filter((row) => row.name === name));
    }
    expect(rowsOn(upgraded, V52_REBUILT)).toEqual(rowsOn(fresh, V52_REBUILT));
    expect(rowsOn(upgraded, V52_ADDED)).toEqual(rowsOn(fresh, V52_ADDED));
    expect(rowsOn(upgraded, V51_OBJECTS)).toEqual(rowsOn(fresh, V51_OBJECTS));
  });
});
