import Database from "better-sqlite3";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { isAcpError } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { captureRollbackPointSync } from "../../src/db/backup.ts";
import { SCHEMA_VERSION, openDb } from "../../src/db/database.ts";
import { targetIdentityOf } from "../../src/db/target-identity.ts";
import {
  MIGRATION_APPROVAL_FORMAT,
  approveMigration,
  migrationApprovalPath,
  migrationPlanFrom,
  writeMigrationApproval,
  type MigrationApproval,
} from "../../src/db/migration-approval.ts";
import { main as stateAdmin } from "../../src/db/state-admin.ts";

/**
 * What an approval has to be, for it to mean the owner decided this migration rather than
 * migrations in general (#738).
 *
 * The refusal itself is proved through the production entry point in
 * `a-restart-that-would-migrate.test.ts`. These are the ways an approval can exist and still
 * not be an approval of what is about to happen.
 */
const V11_SCHEMA = readFileSync(
  fileURLToPath(new URL("../fixtures/schema-v11.sql", import.meta.url)),
  "utf8",
);

const homes: string[] = [];
afterAll(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

const stateRoot = (): string => {
  const home = mkdtempSync(join("/tmp", "acp-738-approval-"));
  homes.push(home);
  const root = join(home, ".agent-control-plane");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  return root;
};

const databaseAtV11 = (): string => {
  const path = join(stateRoot(), "state.sqlite");
  const raw = new Database(path);
  try {
    raw.exec(V11_SCHEMA);
    raw.pragma("user_version = 11");
  } finally {
    raw.close();
  }
  chmodSync(path, 0o600);
  return path;
};

const databaseAtCurrentVersion = (): string => {
  const path = join(stateRoot(), "state.sqlite");
  openDb(path).close();
  return path;
};

const schemaVersionOf = (path: string): number => {
  const raw = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return Number(raw.pragma("user_version", { simple: true }));
  } finally {
    raw.close();
  }
};

const approvalFor = (databasePath: string, overrides: Partial<MigrationApproval>): void => {
  const plan = migrationPlanFrom(11);
  writeMigrationApproval(databasePath, {
    format: MIGRATION_APPROVAL_FORMAT,
    target: targetIdentityOf(databasePath),
    fromVersion: plan.fromVersion,
    toVersion: plan.toVersion,
    migrations: plan.migrations,
    backupPath: "",
    approvedBy: "isaac",
    approvedAt: new Date().toISOString(),
    ...overrides,
  });
};

const refusalFrom = (databasePath: string): { reasonCode: string; message: string } => {
  try {
    openDb(databasePath).close();
  } catch (error) {
    if (!isAcpError(error)) throw error;
    return { reasonCode: error.reasonCode, message: error.message };
  }
  throw new Error("the database was migrated by an approval that did not name that migration");
};

describe("an approval the owner took", () => {
  it("lets the migration run and is spent, so it is never a standing permission", () => {
    const databasePath = databaseAtV11();
    const approval = approveMigration(databasePath, "isaac");
    expect(approval).toMatchObject({ fromVersion: 11, toVersion: SCHEMA_VERSION, approvedBy: "isaac" });

    const db = openDb(databasePath);
    try {
      expect(db.appliedMigrationApproval?.approvedBy).toBe("isaac");
    } finally {
      db.close();
    }

    expect(schemaVersionOf(databasePath)).toBe(SCHEMA_VERSION);
    expect(existsSync(migrationApprovalPath(databasePath))).toBe(false);
    const applied = readdirSync(join(databasePath, "..")).filter((name) =>
      name.startsWith(`migration-approval.applied-v11-v${SCHEMA_VERSION}-`),
    );
    expect(applied.length).toBe(1);
  }, 60_000);

  it("is produced by an operator command that names who took it, not by an environment variable", async () => {
    const databasePath = databaseAtV11();

    await expect(
      stateAdmin(["approve-migration", "--database", databasePath, "--approved-by", "isaac"]),
    ).rejects.toThrow(/--confirm-migration/u);
    expect(existsSync(migrationApprovalPath(databasePath))).toBe(false);

    expect(
      await stateAdmin([
        "approve-migration",
        "--database",
        databasePath,
        "--approved-by",
        "isaac",
        "--confirm-migration",
      ]),
    ).toBe(0);
    const written = JSON.parse(readFileSync(migrationApprovalPath(databasePath), "utf8")) as MigrationApproval;
    expect(written).toMatchObject({ fromVersion: 11, toVersion: SCHEMA_VERSION, approvedBy: "isaac" });
    expect(written.migrations).toEqual([...migrationPlanFrom(11).migrations]);
  }, 60_000);

  it("is reported by a read-only plan command that never opens a writable handle", async () => {
    const databasePath = databaseAtV11();

    expect(await stateAdmin(["migration-plan", "--database", databasePath])).toBe(0);

    expect(schemaVersionOf(databasePath)).toBe(11);
  }, 60_000);
});

describe("an approval that does not name what would happen", () => {
  it("is refused when it approves a shorter chain than the one that would run", () => {
    const databasePath = databaseAtV11();
    const real = approveMigration(databasePath, "isaac");
    approvalFor(databasePath, {
      backupPath: real.backupPath,
      migrations: real.migrations.slice(0, 1),
    });

    const refused = refusalFrom(databasePath);

    expect(refused.reasonCode).toBe(ReasonCode.SCHEMA_MIGRATION_NOT_APPROVED);
    expect(refused.message).toContain("does not name the migration");
    expect(schemaVersionOf(databasePath)).toBe(11);
  }, 60_000);

  it("is refused when its recovery point is not an image of the version this migration starts from", () => {
    const databasePath = databaseAtV11();
    const real = approveMigration(databasePath, "isaac");
    // A genuine checksummed, manifest-carrying backup — of a database at the build's own version
    // rather than at 11. Everything else about the approval is exactly right, so the rollback
    // point is the only thing under test: an image of the migrated database is not a way back.
    const stray = captureRollbackPointSync(databaseAtCurrentVersion()).path;
    approvalFor(databasePath, { migrations: real.migrations, backupPath: stray });

    const refused = refusalFrom(databasePath);

    expect(refused.reasonCode).toBe(ReasonCode.SCHEMA_MIGRATION_NOT_APPROVED);
    expect(schemaVersionOf(databasePath)).toBe(11);
  }, 60_000);

  it("is refused when its recovery point is an image of a different database at the same version", () => {
    const databasePath = databaseAtV11();
    const real = approveMigration(databasePath, "isaac");
    // A different v11 database, in its own directory so approving it clobbers nothing. Its
    // backup is intact, checksummed, and at exactly the version this migration starts from —
    // every property the version and checksum checks look at — and it is an image of somebody
    // else's data, which is what a rollback from it would restore.
    const strayBackup = captureRollbackPointSync(databaseAtV11()).path;
    approvalFor(databasePath, { migrations: real.migrations, backupPath: strayBackup });

    const refused = refusalFrom(databasePath);

    expect(refused.reasonCode).toBe(ReasonCode.SCHEMA_MIGRATION_NOT_APPROVED);
    expect(refused.message).toContain("image of a different database");
    expect(schemaVersionOf(databasePath)).toBe(11);
  }, 60_000);

  it("is refused when the file it names is not a backup at all", () => {
    const databasePath = databaseAtV11();
    const stray = join(databasePath, "..", "not-a-backup.sqlite");
    writeFileSync(stray, "not a database", { mode: 0o600 });
    approvalFor(databasePath, { backupPath: stray });

    expect(() => openDb(databasePath).close()).toThrowError();
    expect(schemaVersionOf(databasePath)).toBe(11);
  }, 60_000);

  it("is refused when the approval on file is not the shape an approval has", () => {
    const databasePath = databaseAtV11();
    writeFileSync(migrationApprovalPath(databasePath), JSON.stringify({ approved: true }), {
      mode: 0o600,
    });

    const refused = refusalFrom(databasePath);

    expect(refused.reasonCode).toBe(ReasonCode.SCHEMA_MIGRATION_NOT_APPROVED);
    expect(schemaVersionOf(databasePath)).toBe(11);
  }, 60_000);
});
