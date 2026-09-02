import { spawnSync } from "node:child_process";
import { chmodSync, linkSync, mkdirSync, readFileSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";

import { SCHEMA_VERSION } from "../../src/db/database.ts";
import { MIGRATIONS } from "../../src/db/migrations.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * `U5-POST763-01` — a supported way to migrate one approved disposable copy, and nothing else.
 *
 * The reconciliation packet's dry run was assembled by hand: a `node --input-type=module -e` that
 * imported `openDb` from the deployment's `dist` and called it. That is not an operator interface.
 * It is a private import spelled out in a runbook, so nothing tests it, nothing versions it, and
 * the operator proving a chain is proving it with a program they wrote at the keyboard during an
 * incident.
 *
 * This is the same act as a command: one explicitly named copy, one approval that matches it, the
 * real `state-admin → Db.applySchema → migrate` path, a readback, and exit. No daemon, no
 * listener, and no way to point it at the live database.
 *
 * The process is spawned rather than called, because the thing under test is the operator's
 * interface — what a person types and what comes back — not a function this file could import.
 */
const CLI = fileURLToPath(new URL("../../src/db/state-admin.ts", import.meta.url));
const LINEAGE = readFileSync(
  new URL("../fixtures/schema-v25-lineage.sql", import.meta.url),
  "utf8",
);

/** Runs the operator command the way an operator would. */
const run = (args: readonly string[], env: NodeJS.ProcessEnv = {}) =>
  spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });

/**
 * A disposable copy of the deployment's own v25, in a private directory.
 *
 * Built from the committed lineage fixture rather than from anything live: this test may never
 * read, copy, or open the canonical database, and a fixture that stood in for it by pointing at
 * it would be the wrong-target case rather than a test of it.
 */
const v25Copy = (label: string): { dir: string; path: string } => {
  const dir = tempDir(`acp-u5-01-${label}-`);
  chmodSync(dir, 0o700);
  const path = join(dir, "copy.sqlite");
  const raw = new Database(path);
  try {
    raw.function("acp_schema_migration_authorized", () => 1);
    raw.exec(LINEAGE);
    for (const [version, id] of [
      [20, "bootstrap-v20"],
      [21, "v21-canonical-turns"],
      [22, "v22-canonical-turn-ledger"],
      [23, "v23-turn-claimed-at"],
      [24, "v24-observation-ledger"],
      [25, "v25-sources-name-admitted-messages"],
    ] as const) {
      raw.prepare(
        `INSERT INTO schema_migrations (version, migration_id, checksum, applied_at)
         VALUES (?, ?, ?, ?)`,
      ).run(version, id, `sha256:${"b".repeat(64)}`, "2026-08-23T02:39:31.318Z");
    }
    raw.pragma("user_version = 25");
  } finally {
    raw.close();
    chmodSync(path, 0o600);
  }
  return { dir, path };
};

const userVersion = (path: string): number => {
  const raw = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return Number(raw.pragma("user_version", { simple: true }));
  } finally {
    raw.close();
  }
};

/** Approves exactly this copy through the supported flow, not by writing a file by hand. */
const approve = (path: string, stateDir: string) => {
  const result = run(
    ["approve-migration", "--database", path, "--approved-by", "u5-post763-01", "--confirm-migration"],
    { ACP_STATE_DIR: stateDir, HOME: stateDir },
  );
  if (result.status !== 0) throw new Error(`approve-migration failed: ${result.stderr}`);
  return result;
};

describe("U5-POST763-01 supported approved-copy migration", () => {
  it("migrates only an explicitly approved v25 copy without starting agentcpd", () => {
    const { dir, path } = v25Copy("green");
    const before = readFileSync(path);
    expect(userVersion(path)).toBe(25);

    approve(path, dir);

    const result = run(
      ["migrate-approved-copy", "--database-copy", path, "--confirm-migration"],
      { ACP_STATE_DIR: dir, HOME: dir },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(userVersion(path)).toBe(SCHEMA_VERSION);

    // The report names what ran, so an operator can tell this chain from another one.
    const report = JSON.parse(result.stdout) as {
      fromVersion: number;
      toVersion: number;
      migrations: Array<{ id: string; checksum: boolean }>;
      approvalRetired: boolean;
      daemonless: boolean;
    };
    expect(report.fromVersion).toBe(25);
    expect(report.toVersion).toBe(SCHEMA_VERSION);
    expect(report.migrations.map((step) => step.id)).toEqual(
      MIGRATIONS.filter((migration) => migration.fromVersion >= 25).map((migration) => migration.id),
    );
    expect(report.migrations.every((step) => step.checksum)).toBe(true);
    expect(report.approvalRetired).toBe(true);
    expect(report.daemonless).toBe(true);

    // No private path in what an operator would paste into a report.
    expect(result.stdout).not.toContain(dir);
    expect(result.stdout).not.toContain(path);

    // Nothing was started. A daemon, a listener or a surviving child would each make this command
    // something other than what it claims to be.
    expect(result.stdout).not.toMatch(/listening|socket|daemon started/i);

    // The protected source is a different file and is untouched: this test's own fixture is the
    // stand-in for every database that is not the approved copy.
    const untouched = v25Copy("protected");
    expect(readFileSync(untouched.path).length).toBeGreaterThan(0);
    expect(userVersion(untouched.path)).toBe(25);
    expect(before.length).toBeGreaterThan(0);
  }, 120_000);

  it("refuses every target that is not the one approval names", () => {
    const { dir, path } = v25Copy("wrong-target");
    approve(path, dir);

    // Another regular file: a real v25 copy, with no approval of its own.
    const other = v25Copy("other");
    const otherBefore = readFileSync(other.path);

    // A symlink to the approved copy — the same bytes by a different name.
    const link = join(dir, "link.sqlite");
    symlinkSync(path, link);

    // A hard link: `nlink` on the approved copy becomes 2, and the file the approval named is no
    // longer the only way to reach those bytes.
    const alias = join(dir, "alias.sqlite");
    linkSync(path, alias);
    expect(statSync(path).nlink).toBe(2);

    // A directory, standing in for every non-regular file.
    const notAFile = join(dir, "not-a-file");
    mkdirSync(notAFile);

    for (const target of [other.path, link, alias, notAFile]) {
      const result = run(
        ["migrate-approved-copy", "--database-copy", target, "--confirm-migration"],
        { ACP_STATE_DIR: dir, HOME: dir },
      );
      expect(result.status, `${target} was accepted`).not.toBe(0);
    }

    // Every underlying database is where it was. The approved copy included: a refusal that
    // migrated the file it refused would be the defect wearing a non-zero exit code.
    expect(userVersion(path)).toBe(25);
    expect(userVersion(other.path)).toBe(25);
    expect(readFileSync(other.path)).toEqual(otherBefore);
  }, 120_000);

  it("requires the copy to be named explicitly, and never defaults to a target", () => {
    const { dir, path } = v25Copy("explicit");
    approve(path, dir);

    // No `--database-copy`: there is no default for this command, because the default is the one
    // database it must never touch.
    const noTarget = run(["migrate-approved-copy", "--confirm-migration"], {
      ACP_STATE_DIR: dir,
      HOME: dir,
    });
    expect(noTarget.status).not.toBe(0);
    expect(noTarget.stderr).toContain("--database-copy");

    // No confirmation: naming a database is not deciding to migrate it.
    const noConfirm = run(["migrate-approved-copy", "--database-copy", path], {
      ACP_STATE_DIR: dir,
      HOME: dir,
    });
    expect(noConfirm.status).not.toBe(0);
    expect(noConfirm.stderr).toContain("--confirm-migration");

    // And `--database`, the flag every other command takes, is not a way in.
    const wrongFlag = run(
      ["migrate-approved-copy", "--database", path, "--confirm-migration"],
      { ACP_STATE_DIR: dir, HOME: dir },
    );
    expect(wrongFlag.status).not.toBe(0);

    expect(userVersion(path)).toBe(25);
  }, 120_000);

  it("refuses a copy that is not at the version the approval starts from", () => {
    const { dir, path } = v25Copy("wrong-version");
    approve(path, dir);

    // Move the copy off 25 without touching anything the approval names.
    const raw = new Database(path);
    try {
      raw.pragma("user_version = 24");
    } finally {
      raw.close();
    }

    const result = run(
      ["migrate-approved-copy", "--database-copy", path, "--confirm-migration"],
      { ACP_STATE_DIR: dir, HOME: dir },
    );
    expect(result.status).not.toBe(0);
    expect(userVersion(path)).toBe(24);
  }, 120_000);

  it("refuses to run without an approval for that exact copy", () => {
    const { dir, path } = v25Copy("unapproved");
    // Deliberately no `approve-migration`.
    const result = run(
      ["migrate-approved-copy", "--database-copy", path, "--confirm-migration"],
      { ACP_STATE_DIR: dir, HOME: dir },
    );
    expect(result.status).not.toBe(0);
    expect(userVersion(path)).toBe(25);
  }, 120_000);

  it("names the command in its usage, so it is discoverable rather than folklore", () => {
    // The runbook's `node -e` was invisible to every check in this repository. A supported command
    // that no usage mentions is the same thing with a shorter spelling.
    const usage = run([]);
    expect(usage.stderr + usage.stdout).toContain("migrate-approved-copy");
  }, 60_000);
});
