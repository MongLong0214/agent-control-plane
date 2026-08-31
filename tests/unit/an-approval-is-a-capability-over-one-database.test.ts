import Database from "better-sqlite3";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { isAcpError } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Db, SCHEMA_VERSION, openDb } from "../../src/db/database.ts";
import { approveMigration, migrationApprovalPath } from "../../src/db/migration-approval.ts";

/**
 * An approval is a capability over one database, and the three ways it was not (#747).
 *
 * Nothing here imports a symbol introduced by the fix, so the whole file runs against the head
 * that has the defects and fails on each of them for its own reason. Every assertion is a
 * filesystem or `PRAGMA user_version` reading, not a property of a new object.
 *
 *   1. The approval named a directory, not a database. Two databases in one private directory
 *      resolved to the same approval path, so an approval taken on A was spent by opening B,
 *      and A's backup became the recovery point for a file it was never an image of.
 *   2. The migration ran before any exclusivity was acquired. `ControlPlane`'s constructor
 *      opens and migrates; `Daemon.start()` takes the single-instance lock afterwards. A second
 *      process therefore rewrote the schema under a daemon that was holding the database and
 *      only learned about the contention later.
 *   3. Filing the spent approval away could fail *after* the migration committed, and the
 *      failure was thrown — producing an upgraded database reported as a failed start, a state
 *      nothing could recognise and nothing would resolve.
 */
const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/u, "");
const MIGRATE_ONE = join(repositoryRoot, "tests/helpers/migrate-one-database.ts");
const V11_SCHEMA = readFileSync(
  fileURLToPath(new URL("../fixtures/schema-v11.sql", import.meta.url)),
  "utf8",
);

const homes: string[] = [];
const children: ChildProcess[] = [];
afterAll(() => {
  for (const child of children) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
  for (const home of homes) {
    // A test deliberately makes a file unrenameable; leaving the flag set would make the
    // cleanup below fail and take the next run's temp space with it.
    try {
      execFileSync("chflags", ["-R", "nouchg", home]);
    } catch {
      /* nothing was flagged */
    }
    rmSync(home, { recursive: true, force: true });
  }
});

const stateRoot = (): string => {
  const home = mkdtempSync(join("/tmp", "acp-747-"));
  homes.push(home);
  const root = join(home, ".agent-control-plane");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  return root;
};

/**
 * A v11 database carrying a distinct row, so a later reading can say *which* database it is
 * looking at rather than only that it is a database at the right version.
 */
const databaseAtV11 = (root: string, name: string, sentinel: string): string => {
  const path = join(root, name);
  const raw = new Database(path);
  try {
    raw.exec(V11_SCHEMA);
    raw.prepare(
      `INSERT INTO sessions
         (session_id, incarnation, provider, model, lifecycle, created_at, updated_at)
       VALUES (?, 'inc', 'fixture', 'fixture', 'STOPPED', '2026-08-13T00:00:00.000Z', '2026-08-13T00:00:00.000Z')`,
    ).run(sentinel);
    raw.pragma("user_version = 11");
  } finally {
    raw.close();
  }
  chmodSync(path, 0o600);
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

const sentinelsIn = (path: string): string[] => {
  const raw = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return (raw.prepare("SELECT session_id FROM sessions ORDER BY session_id").all() as {
      session_id: string;
    }[]).map((row) => row.session_id);
  } finally {
    raw.close();
  }
};

const refusalFrom = (databasePath: string): { reasonCode: string; message: string } => {
  try {
    openDb(databasePath).close();
  } catch (error) {
    if (!isAcpError(error)) throw error;
    return { reasonCode: error.reasonCode, message: error.message };
  }
  throw new Error("the database was migrated by an approval that was not for it");
};

describe("an approval taken on one database", () => {
  it("cannot be spent by opening a different database beside it", () => {
    const root = stateRoot();
    const a = databaseAtV11(root, "a.sqlite", "sentinel-of-a");
    const b = databaseAtV11(root, "b.sqlite", "sentinel-of-b");
    const approval = approveMigration(a, "isaac");
    // The whole defect in one line: the approval is keyed by the directory, so both databases
    // resolve to the same file.
    expect(migrationApprovalPath(b)).toBe(migrationApprovalPath(a));

    const refused = refusalFrom(b);

    expect(refused.reasonCode).toBe(ReasonCode.SCHEMA_MIGRATION_NOT_APPROVED);
    expect(refused.message).toContain("different database");
    // B was not migrated, and A's approval was not spent on it.
    expect(schemaVersionOf(b)).toBe(11);
    expect(existsSync(migrationApprovalPath(a))).toBe(true);
    // A is untouched, and the recovery point A's approval names is still an image of A — it
    // never became the rollback point for a file whose contents it does not contain.
    expect(schemaVersionOf(a)).toBe(11);
    expect(sentinelsIn(approval.backupPath)).toEqual(["sentinel-of-a"]);
    expect(sentinelsIn(b)).toEqual(["sentinel-of-b"]);
  }, 60_000);

  it("is still spendable on the database it was actually taken for", () => {
    const root = stateRoot();
    const a = databaseAtV11(root, "a.sqlite", "sentinel-of-a");
    databaseAtV11(root, "b.sqlite", "sentinel-of-b");
    approveMigration(a, "isaac");

    openDb(a).close();

    expect(schemaVersionOf(a)).toBe(SCHEMA_VERSION);
    expect(existsSync(migrationApprovalPath(a))).toBe(false);
  }, 60_000);
});

describe("a migration that would run while another process holds the state", () => {
  it("refuses rather than rewriting the schema under the lock holder", async () => {
    const root = stateRoot();
    const databasePath = databaseAtV11(root, "state.sqlite", "sentinel");
    approveMigration(databasePath, "isaac");

    // A genuinely live process standing in for a daemon that is holding this state directory.
    // The lock record is the same shape `SingleInstanceLock` writes; what matters to the guard
    // is that the recorded pid answers `kill(pid, 0)`.
    const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    children.push(holder);
    await new Promise<void>((resolve, reject) => {
      holder.once("spawn", resolve);
      holder.once("error", reject);
    });
    writeFileSync(
      join(dirname(databasePath), "agentcpd.lock"),
      JSON.stringify({
        pid: holder.pid,
        startedAt: "2026-09-01T00:00:00.000Z",
        path: join(dirname(databasePath), "agentcpd.lock"),
      }),
      { mode: 0o600 },
    );

    const refused = refusalFrom(databasePath);

    // Not a migration refusal: the holder may exit, so this is an ordinary unsuccessful start
    // the supervisor is right to retry, and it must not take the exit-0 path that stays down.
    expect(refused.reasonCode).toBe(ReasonCode.DAEMON_ALREADY_RUNNING);
    expect(schemaVersionOf(databasePath)).toBe(11);
    expect(existsSync(migrationApprovalPath(databasePath))).toBe(true);

    holder.kill("SIGKILL");
    await new Promise<void>((resolve) => holder.once("exit", () => resolve()));

    // And once the holder is gone the same approval still works: the lock is exclusivity for
    // the migration, not a second thing to approve.
    openDb(databasePath).close();
    expect(schemaVersionOf(databasePath)).toBe(SCHEMA_VERSION);
  }, 60_000);
});

describe("a migration whose chain another process already ran", () => {
  it("refuses under the lock rather than re-running it, and the ledger records one run", () => {
    const root = stateRoot();
    const databasePath = databaseAtV11(root, "state.sqlite", "sentinel");
    approveMigration(databasePath, "isaac");

    // Taking the lock and re-reading state under it are two different properties. This is the
    // second one: both processes pass the pre-lock version check at 11, the other one acquires
    // first and runs the whole chain, and this one acquires afterwards still believing the
    // database is at 11. Without the re-read it would apply a chain that has already been
    // applied. `acquire` denies instead of blocking, so this ordering is only reachable for a
    // process that arrives *after* the holder released — which is exactly the window the seam
    // below opens.
    let raced = false;
    let migrator: ReturnType<typeof spawnSync> | null = null;
    expect(
      () =>
        new Db(databasePath, {
          beforeMigrationExclusivity: () => {
            if (raced) return;
            raced = true;
            migrator = spawnSync(
              process.execPath,
              ["--import", "tsx", MIGRATE_ONE, databasePath],
              { cwd: repositoryRoot, encoding: "utf8", timeout: 60_000 },
            );
          },
        }),
    ).toThrowError(/schema changed while this process was acquiring migration exclusivity/);

    expect(raced).toBe(true);
    expect(migrator!.status, `stderr:\n${migrator!.stderr}`).toBe(0);
    expect(schemaVersionOf(databasePath)).toBe(SCHEMA_VERSION);

    // Migrated exactly once. The version alone cannot say that — a chain re-applied over
    // itself would land on the same number — so this reads the ledger the migrations write.
    const raw = new Database(databasePath, { readonly: true, fileMustExist: true });
    try {
      const duplicated = raw
        .prepare("SELECT version FROM schema_migrations GROUP BY version HAVING COUNT(*) > 1")
        .all();
      expect(duplicated).toEqual([]);
      expect(
        raw.prepare("SELECT MAX(version) AS max FROM schema_migrations").get(),
      ).toEqual({ max: SCHEMA_VERSION });
    } finally {
      raw.close();
    }
  }, 120_000);
});

describe("a spent approval that could not be filed away", () => {
  it("does not turn a committed migration into a failed start", () => {
    const root = stateRoot();
    const databasePath = databaseAtV11(root, "state.sqlite", "sentinel");
    approveMigration(databasePath, "isaac");
    // `chflags uchg` makes the file unrenameable while leaving it readable, which is exactly
    // the shape of the failure: the approval can be validated and the migration can run, and
    // then the bookkeeping that describes it cannot be written.
    execFileSync("chflags", ["uchg", migrationApprovalPath(databasePath)]);

    // The migration committed. Reporting that as a failed start is what left an upgraded
    // database behind a refusal report, with nothing on either side saying which happened.
    expect(() => openDb(databasePath).close()).not.toThrow();

    expect(schemaVersionOf(databasePath)).toBe(SCHEMA_VERSION);
    // The state is recognisable: the approval is still there, and it is inert — it names a
    // fromVersion this database no longer has.
    expect(existsSync(migrationApprovalPath(databasePath))).toBe(true);

    execFileSync("chflags", ["nouchg", migrationApprovalPath(databasePath)]);

    // And it resolves itself: the next open at the build's version files it away.
    openDb(databasePath).close();
    expect(existsSync(migrationApprovalPath(databasePath))).toBe(false);
  }, 60_000);
});
