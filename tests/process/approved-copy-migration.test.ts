import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";

import {
  SCHEMA_VERSION,
  __setApprovedCopyWindowHook,
  migrateApprovedCopy,
} from "../../src/db/database.ts";
import { approveMigration } from "../../src/db/migration-approval.ts";
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

/** One v25-shaped database at `path`, optionally stamped at another version. */
const seedAt = (path: string, version = 25): string => {
  const raw = new Database(path);
  try {
    raw.function("acp_schema_migration_authorized", () => 1);
    raw.exec(LINEAGE);
    raw.pragma(`user_version = ${version}`);
  } finally {
    raw.close();
    chmodSync(path, 0o600);
  }
  return path;
};

/**
 * A database and its sidecars, each as `absent` or as its exact bytes.
 *
 * Existence booleans were not enough: a `-wal` that already existed could be rewritten in place
 * and compare equal to itself, so "the command did not touch this database" was being read off a
 * pair of `true`s. Bytes say it; presence only says something is there.
 */
const artifact = (path: string): "absent" | Buffer =>
  existsSync(path) ? readFileSync(path) : "absent";

const imprintOf = (path: string) => ({
  main: artifact(path),
  wal: artifact(`${path}-wal`),
  shm: artifact(`${path}-shm`),
});

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

    // The database this command must never touch is not "some other database" — it is the one the
    // command derives internally, from `homedir()`. So the control is seeded at exactly that
    // derived path, under the HOME the command will run with: a bystander copy in an unrelated
    // directory could be left untouched by a command that migrated the deployment.
    const canonical = join(dir, ".agent-control-plane", "state.sqlite");
    mkdirSync(join(dir, ".agent-control-plane"), { recursive: true });
    chmodSync(join(dir, ".agent-control-plane"), 0o700);
    seedAt(canonical);
    // Sidecars with content, so "untouched" is a comparison of bytes and not of two absences.
    writeFileSync(`${canonical}-wal`, Buffer.from("canonical-wal-must-not-move"), { mode: 0o600 });
    writeFileSync(`${canonical}-shm`, Buffer.from("canonical-shm-must-not-move"), { mode: 0o600 });
    // Snapshotted before the command, not after: a protected database compared only to its own
    // later state proves nothing about what the command did in between.
    const canonicalBefore = imprintOf(canonical);

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

    // The report is the command's own account of itself. Everything above is checked again here
    // against the database and the filesystem, because a command that printed the right JSON and
    // did something else would pass every assertion so far.
    const raw = new Database(path, { readonly: true, fileMustExist: true });
    try {
      const receipts = raw
        .prepare(
          "SELECT version, migration_id AS id, checksum FROM schema_migrations WHERE version > 25 ORDER BY version",
        )
        .all() as Array<{ version: number; id: string; checksum: string }>;
      // Version, id *and* checksum, each compared to what `MIGRATIONS` says it should be. The
      // previous spelling checked the checksum against a format regular expression, which any
      // sha256 of anything satisfies — including a checksum recorded for a different migration.
      expect(receipts).toEqual(
        MIGRATIONS.filter((migration) => migration.fromVersion >= 25).map((migration) => ({
          version: migration.toVersion,
          id: migration.id,
          checksum: migration.checksum(),
        })),
      );
    } finally {
      raw.close();
    }

    // Retirement is a fact about a file, and the command's `approvalRetired` is a claim about it.
    expect(existsSync(join(dir, "migration-approval.json"))).toBe(false);

    // The derived canonical database, captured *before* the command ran, so "untouched" is
    // measured against what it was rather than against what it is now — main and both sidecars,
    // byte for byte.
    expect(imprintOf(canonical)).toEqual(canonicalBefore);
    expect(userVersion(canonical)).toBe(25);
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

  it("refuses a copy the approval does not name, without opening it", () => {
    // The `#747` split, one directory: an approval taken on A, the command run on B. Matching the
    // approval's target only inside `Db` matches it *after* the writable open, and the measured
    // cost of that is a moved header on a database the command declined.
    const dir = tempDir("acp-u5-01-ab-");
    chmodSync(dir, 0o700);
    const a = seedAt(join(dir, "a.sqlite"));
    const b = seedAt(join(dir, "b.sqlite"));
    approve(a, dir);

    const before = imprintOf(b);
    const result = run(["migrate-approved-copy", "--database-copy", b, "--confirm-migration"], {
      ACP_STATE_DIR: dir,
      HOME: dir,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("names a different database");
    expect(imprintOf(b)).toEqual(before);
    expect(userVersion(b)).toBe(25);
  }, 120_000);

  it("refuses an approval whose chain does not start at 25", () => {
    // Endpoints are not the plan. An approval for another starting version approves another
    // migration, and this command runs exactly one.
    const dir = tempDir("acp-u5-01-v24-");
    chmodSync(dir, 0o700);
    const path = seedAt(join(dir, "copy.sqlite"), 24);
    approve(path, dir);
    const before = imprintOf(path);

    const result = run(["migrate-approved-copy", "--database-copy", path, "--confirm-migration"], {
      ACP_STATE_DIR: dir,
      HOME: dir,
    });

    expect(result.status).not.toBe(0);
    expect(imprintOf(path)).toEqual(before);
    expect(userVersion(path)).toBe(24);
  }, 120_000);

  it("closes its argv grammar", () => {
    const { dir, path } = v25Copy("argv");
    approve(path, dir);
    const before = imprintOf(path);

    const cases: Array<{ argv: string[]; why: string }> = [
      { argv: ["--database", path, "--database-copy", path, "--confirm-migration"], why: "two database flags" },
      { argv: ["--database-copy", path, "--database-copy", path, "--confirm-migration"], why: "repeated copy" },
      { argv: ["--database-copy", path, "--confirm-migration", "--confirm-migration"], why: "repeated confirm" },
      { argv: ["--database-copy", path, "--confirm-migration", "--output", "/tmp/x"], why: "foreign flag" },
      { argv: ["--database-copy", path, "--confirm-migration", "--confirm-restore"], why: "another command's flag" },
      { argv: ["--database-copy", path, "--confirm-migration", "--nope"], why: "unknown flag" },
      { argv: ["--database-copy", path, "--confirm-migration", "extra"], why: "positional" },
    ];
    for (const { argv, why } of cases) {
      const result = run(["migrate-approved-copy", ...argv], { ACP_STATE_DIR: dir, HOME: dir });
      expect(result.status, `${why} was accepted`).not.toBe(0);
    }

    // A refused grammar never reached the database.
    expect(imprintOf(path)).toEqual(before);
    expect(userVersion(path)).toBe(25);
  }, 180_000);

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

/**
 * The window between the final under-lock check and the first writable open.
 *
 * A same-directory A/B case proves the approval names one file. It does not prove *when* that is
 * checked, and the difference is the defect: the first version verified, then constructed `Db`,
 * and `Db` opens its connection before taking exclusivity — so a file swapped in at that pathname
 * was opened read-write and only then refused. These cases stand in that window, in-process,
 * because a spawned command cannot be interrupted at one instruction.
 */
describe("U5-POST763-01 the replacement window", () => {
  it("refuses a file swapped in after the final check, without opening it", () => {
    const dir = tempDir("acp-u5-01-window-");
    chmodSync(dir, 0o700);
    const approved = seedAt(join(dir, "approved.sqlite"));
    const intruder = seedAt(join(dir, "intruder.sqlite"));
    approveMigration(approved, "window-control");

    const before = imprintOf(intruder);
    __setApprovedCopyWindowHook(() => {
      // Exactly the moment the old code opened. `rename` is atomic and leaves the pathname
      // pointing at a different inode — the shape a real swap takes.
      renameSync(intruder, approved);
    });
    try {
      expect(() => migrateApprovedCopy(approved)).toThrowError(
        /changed after it was verified under the migration lock/,
      );
    } finally {
      __setApprovedCopyWindowHook(null);
    }

    expect(imprintOf(approved)).toEqual(before);
    expect(userVersion(approved)).toBe(25);
  }, 120_000);

  it("refuses a canonical alias hard-linked onto the approved inode after the check", () => {
    // Identity alone cannot see this. A hard link leaves device and inode exactly as they were,
    // so `isSameTarget` still passes while the file has become reachable under a second name —
    // and here that name is the deployment's own database. The copy and the live store are now
    // one inode, and migrating "the copy" migrates the deployment.
    const home = tempDir("acp-u5-01-alias-home-");
    chmodSync(home, 0o700);
    const stateDir = join(home, ".agent-control-plane");
    mkdirSync(stateDir, { recursive: true });
    chmodSync(stateDir, 0o700);

    const dir = tempDir("acp-u5-01-alias-");
    chmodSync(dir, 0o700);
    const approved = seedAt(join(dir, "approved.sqlite"));
    approveMigration(approved, "alias-control");
    // Non-empty sidecars, written last because recording the approval opens and closes the
    // database, and the close takes the sidecars with it. Content rather than absence, so that
    // "unchanged" is a byte comparison of something real instead of of two `absent`s.
    writeFileSync(`${approved}-wal`, Buffer.from("wal-content-that-must-not-move"), { mode: 0o600 });
    writeFileSync(`${approved}-shm`, Buffer.from("shm-content-that-must-not-move"), { mode: 0o600 });

    const before = imprintOf(approved);
    expect(before.wal).not.toBe("absent");
    expect(before.shm).not.toBe("absent");

    const realHome = process.env["HOME"];
    process.env["HOME"] = home;
    let atSeam: ReturnType<typeof imprintOf> | null = null;
    __setApprovedCopyWindowHook(() => {
      // The canonical path did not exist at verification time, which is exactly why a captured
      // canonical identity cannot catch this.
      linkSync(approved, join(stateDir, "state.sqlite"));
      atSeam = imprintOf(approved);
    });
    try {
      expect(() => migrateApprovedCopy(approved)).toThrowError(
        /reachable under 2 names|deployment's own database/,
      );
    } finally {
      __setApprovedCopyWindowHook(null);
      if (realHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = realHome;
    }

    const after = imprintOf(approved);
    // Byte-exact across the seam — all three artifacts. This is where the counterexample lives:
    // everything from the moment the alias appeared to the refusal must have left no mark.
    expect(atSeam).not.toBeNull();
    expect(after).toEqual(atSeam);
    // Across the whole command, the durable bytes are unchanged too. `-shm` is deliberately not
    // held to that: it is a shared-memory index SQLite re-derives whenever a WAL database is
    // opened, and this command has to open the copy read-only to read its version. Demanding
    // stability there would be demanding that nothing ever read the file, which is not a property
    // this command can have or should claim.
    expect(after.main).toEqual(before.main);
    expect(after.wal).toEqual(before.wal);
    expect(userVersion(approved)).toBe(25);
  }, 120_000);

  it("still migrates when nothing happens in the window", () => {
    // The negative control. A guard that refused whenever the hook existed would satisfy the case
    // above and never let a real migration through.
    const dir = tempDir("acp-u5-01-window-ok-");
    chmodSync(dir, 0o700);
    const approved = seedAt(join(dir, "approved.sqlite"));
    approveMigration(approved, "window-control-ok");

    let fired = false;
    __setApprovedCopyWindowHook(() => {
      fired = true;
    });
    try {
      expect(migrateApprovedCopy(approved).toVersion).toBe(SCHEMA_VERSION);
    } finally {
      __setApprovedCopyWindowHook(null);
    }
    expect(fired, "the window hook never ran, so the case above proves nothing").toBe(true);
    expect(userVersion(approved)).toBe(SCHEMA_VERSION);
  }, 120_000);
});
