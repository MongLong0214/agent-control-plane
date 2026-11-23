import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { Db, SCHEMA_VERSION } from "../../src/db/database.ts";
import { approveMigration } from "../../src/db/migration-approval.ts";
import { MIGRATIONS } from "../../src/db/migrations.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { releasedChainImage } from "../helpers/released-chain-image.ts";
import { privateStatePath, schemaRowsOf } from "../helpers/released-v44-schema.ts";
import { contentDigests } from "../helpers/released-v45-schema.ts";
import { V61_ADDED_TRIGGERS, V61_CHANGED_GUARDS } from "../helpers/released-v50-schema.ts";

afterAll(cleanupTempDirs);

/** v60's receipt as the build before its freeze computed it, from schema.sql at d1e2b128. */
const V60_CHECKSUM = "sha256:65511a8e156217490cf3b92da02b673e13832007425b438a8cc76cefb15e1a68";
const TABLE = "repository_identity_renames";
const V61_OBJECTS = [TABLE, ...V61_ADDED_TRIGGERS];
const IMMUTABLE = /REPOSITORY_RENAME_IMMUTABLE/;
const DENIED = /MANIFEST_ACTIVATION_AUTHORITY_DENIED/;
const AT = "2026-11-23T00:00:00.000Z";

/** A fresh database holding one project at manifest m1 and its repository at `github:acme/old`. */
const world = () => {
  const path = join(tempDir("acp-v61-world-"), "state.sqlite");
  new Db(path).close();
  const raw = new Database(path);
  for (const digest of ["sha256:m1", "sha256:m2", "sha256:m3"]) {
    raw.prepare(`INSERT INTO manifests (digest, schema_id, content_json, created_at) VALUES (?, 'x', '{}', ?)`).run(digest, AT);
  }
  raw.prepare(`INSERT INTO projects (project_id, name, active_manifest_digest, created_at) VALUES ('p1', 'p1', 'sha256:m1', ?)`).run(AT);
  raw.prepare(`INSERT INTO repositories (repository_id, identity, checkout_path, project_id, repository_role, created_at)
    VALUES ('repo_1', 'github:acme/old', '/tmp/acp-v61-repo', 'p1', 'primary', ?)`).run(AT);
  const rename = (row: Partial<Record<string, string>> = {}) => raw.prepare(
    `INSERT INTO repository_identity_renames (rename_id, repository_id, project_id, from_identity, to_identity, repository_node_id,
       from_manifest_digest, to_manifest_digest, renamed_at) VALUES (@rename_id, @repository_id, @project_id, @from_identity, @to_identity,
       @repository_node_id, @from_manifest_digest, @to_manifest_digest, @renamed_at)`,
  ).run({
    rename_id: "ren_1", repository_id: "repo_1", project_id: "p1", from_identity: "github:acme/old", to_identity: "github:acme/new",
    repository_node_id: "R_node", from_manifest_digest: "sha256:m1", to_manifest_digest: "sha256:m2", renamed_at: AT, ...row,
  });
  const move = (digest: string) => () => raw.prepare(`UPDATE projects SET active_manifest_digest = ? WHERE project_id = 'p1'`).run(digest);
  const pointer = () => raw.prepare(`SELECT active_manifest_digest FROM projects WHERE project_id = 'p1'`).pluck().get();
  return { raw, rename, move, pointer, close: () => raw.close() };
};

describe("v61 — a repository rename table, and the one manifest move it admits", () => {
  it("freezes v60 byte for byte, keeps v60's released checksum, and chains v61 after v60", () => {
    const bytes = readFileSync(new URL("../../src/db/schema-v60.sql", import.meta.url));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe("3fa78603e9a8d7d64a3b7122394f8b0e7d279d798a29f98c50203bbc871a7aed");
    expect(createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex")).toBe("e5f124254db4c87105b78afb792ebc275b1c3cca");
    expect(bytes.toString()).not.toContain(TABLE);
    expect(MIGRATIONS.find((step) => step.toVersion === 60)!.checksum()).toBe(V60_CHECKSUM);
    expect(SCHEMA_VERSION).toBe(61);
    expect(MIGRATIONS.at(-1)).toMatchObject({ id: "v61-repository-identity-rename", fromVersion: 60, toVersion: 61 });
  });

  it("v60 → v61 adds exactly its table and guards, replaces exactly the pointer guard, keeps every row, and matches a fresh v61 database", () => {
    const path = releasedChainImage(privateStatePath("acp-v61-from-v60-"), 60);
    const v60Rows = schemaRowsOf(path);
    const before = contentDigests(path, 60);
    expect(before.userVersion).toBe(60);
    approveMigration(path, "v60 → v61 witness");
    new Db(path).close();
    const after = contentDigests(path, 60);
    expect(after.userVersion).toBe(61);
    const { schema_migrations: _receiptsBefore, ...rowsBefore } = before.tables;
    const { schema_migrations: _receiptsAfter, ...rowsAfter } = after.tables;
    expect(rowsAfter).toEqual(rowsBefore);
    const upgraded = schemaRowsOf(path);
    for (const row of v60Rows.filter((old) => !V61_CHANGED_GUARDS.includes(old.name))) expect(upgraded).toContainEqual(row);
    const changed = upgraded.filter((row) => !v60Rows.some((old) => JSON.stringify(old) === JSON.stringify(row)));
    expect(changed.map((row) => row.name).filter((name) => !name.startsWith("sqlite_autoindex")).sort())
      .toEqual([...V61_OBJECTS, ...V61_CHANGED_GUARDS].sort());
    const freshPath = join(tempDir("acp-v61-fresh-"), "state.sqlite");
    new Db(freshPath).close();
    const fresh = schemaRowsOf(freshPath);
    const named = (rows: typeof fresh) => rows.filter((row) => [...V61_OBJECTS, ...V61_CHANGED_GUARDS].includes(row.name));
    expect(named(upgraded)).toEqual(named(fresh));
    expect(upgraded.map((row) => `${row.type} ${row.name}`).sort()).toEqual(fresh.map((row) => `${row.type} ${row.name}`).sort());
  });

  it("refuses a drifted pointer guard rather than replacing an unknown definition", () => {
    const path = releasedChainImage(privateStatePath("acp-v61-drift-"), 60);
    const raw = new Database(path);
    try {
      raw.exec(`DROP TRIGGER projects_active_manifest_moves_by_grant;
        CREATE TRIGGER projects_active_manifest_moves_by_grant BEFORE UPDATE OF active_manifest_digest ON projects BEGIN SELECT 1; END;`);
      expect(() => MIGRATIONS.find((step) => step.toVersion === 61)!.apply(raw)).toThrow(/v61 refuses/);
    } finally { raw.close(); }
  });

  it("a rename row names the repository and the manifest as they stand, and is never rewritten, replaced or erased", () => {
    const w = world();
    try {
      // Not the repository's current name, another project, or not the project's active manifest.
      expect(() => w.rename({ from_identity: "github:acme/other" })).toThrow(IMMUTABLE);
      expect(() => w.rename({ from_manifest_digest: "sha256:m3" })).toThrow(IMMUTABLE);
      w.raw.prepare(`INSERT INTO projects (project_id, name, created_at) VALUES ('p2', 'p2', ?)`).run(AT);
      expect(() => w.rename({ project_id: "p2" })).toThrow(IMMUTABLE);
      // The same name, or the same manifest, is no rename.
      expect(() => w.rename({ to_identity: "github:acme/old" })).toThrow(/CHECK constraint/);
      expect(() => w.rename({ to_manifest_digest: "sha256:m1" })).toThrow(/CHECK constraint/);
      w.rename();
      expect(() => w.rename()).toThrow(IMMUTABLE);
      expect(() => w.raw.prepare(`INSERT OR REPLACE INTO ${TABLE} (rename_id, repository_id, project_id, from_identity, to_identity,
        repository_node_id, from_manifest_digest, to_manifest_digest, renamed_at)
        VALUES ('ren_1', 'repo_1', 'p1', 'github:acme/old', 'github:acme/forged', 'R_node', 'sha256:m1', 'sha256:m3', ?)`).run(AT)).toThrow(IMMUTABLE);
      expect(() => w.raw.prepare(`UPDATE ${TABLE} SET to_identity = 'github:acme/forged'`).run()).toThrow(IMMUTABLE);
      expect(() => w.raw.prepare(`DELETE FROM ${TABLE}`).run()).toThrow(IMMUTABLE);
      expect(w.raw.prepare(`SELECT to_identity FROM ${TABLE}`).pluck().all()).toEqual(["github:acme/new"]);
    } finally { w.close(); }
  });

  it("moves the manifest pointer only along a recorded rename, and only while the repository still holds its old name", () => {
    const w = world();
    try {
      // No rename row: the v60 guard decides, and a move without a grant is refused.
      expect(w.move("sha256:m2")).toThrow(DENIED);
      w.rename();
      // Only the move the row names.
      expect(w.move("sha256:m3")).toThrow(DENIED);
      // Once the repository holds the new name, the row admits no further move along it.
      w.raw.prepare(`UPDATE repositories SET identity = 'github:acme/new' WHERE repository_id = 'repo_1'`).run();
      expect(w.move("sha256:m2")).toThrow(DENIED);
      w.raw.prepare(`UPDATE repositories SET identity = 'github:acme/old' WHERE repository_id = 'repo_1'`).run();
      expect(w.move("sha256:m2")).not.toThrow();
      expect(w.pointer()).toBe("sha256:m2");
    } finally { w.close(); }
  });
});
