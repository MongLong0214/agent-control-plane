import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  linkSync,
  openSync,
  unlinkSync,
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
  __runApprovedCopyMigrationWithSeam,
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

  it("refuses a stray positional even when it repeats an earlier flag's value", () => {
    // Every value in this grammar is a path, so a repeated one is what an operator types when
    // they paste the same path twice — not an exotic case.
    //
    // What this asserts is the property, not a particular line: the invocation is refused and the
    // database family is untouched. Which check refuses it was measured rather than assumed — the
    // general token loop does, before `migrate-approved-copy`'s own grammar block runs, and
    // deleting that block's positional walk entirely still refuses every spelling below. So this
    // deliberately does not assert the block's message: an assertion on it would report coverage
    // of a line that decides nothing.
    const { dir, path } = v25Copy("positional-echo");
    approve(path, dir);
    const before = imprintOf(path);

    for (const argv of [
      ["--database-copy", path, "--confirm-migration", path],
      ["--database-copy", path, path, "--confirm-migration"],
      ["--confirm-migration", "--database-copy", path, path],
    ]) {
      const result = run(["migrate-approved-copy", ...argv], { ACP_STATE_DIR: dir, HOME: dir });
      expect(result.status, `${argv.join(" ")} was accepted`).not.toBe(0);
    }

    // The whole family, byte for byte: a grammar refused before anything is decided cannot have
    // opened, created or checkpointed anything.
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
 * A database left in real WAL mode, with the sidecars SQLite itself produced, and no live mapping.
 *
 * Sidecars written as arbitrary bytes are not a WAL fixture: nothing about them behaves the way a
 * log behaves, so an oracle comparing them proves only that nobody wrote those bytes.
 *
 * Nor is a WAL database with a connection still holding it. That was the first attempt here, and
 * it was *insensitive*: a second opener maps the existing shared-memory file instead of building
 * one, so the very probe this oracle exists to catch passed. The three files are therefore copied
 * out while a connection has them live and the source is closed afterwards, which leaves a real,
 * self-consistent WAL triple at rest — the state that makes the next open rebuild `-shm`.
 */
const seedWithRealWal = (path: string): void => {
  const source = `${path}.live`;
  const writer = new Database(source);
  writer.function("acp_schema_migration_authorized", () => 1);
  writer.exec(LINEAGE);
  writer.pragma("journal_mode = WAL");
  writer.pragma("user_version = 25");
  writer.exec("CREATE TABLE IF NOT EXISTS wal_probe (a INTEGER)");
  writer.prepare("INSERT INTO wal_probe (a) VALUES (?)").run(1);
  // Copied while the log is live, so all three files are what SQLite actually wrote.
  for (const suffix of ["", "-wal", "-shm"]) {
    writeFileSync(`${path}${suffix}`, readFileSync(`${source}${suffix}`), { mode: 0o600 });
  }
  writer.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(`${source}${suffix}`)) unlinkSync(`${source}${suffix}`);
  }
};

/**
 * The pathname is resolved once, into a descriptor, and every later decision is about that object.
 *
 * These are the cases the three previous designs could not answer. Each asserts three families
 * byte-for-byte — the approved copy, the intruder, and the deployment's own database at the path
 * the command derives internally — from before the command to after it returns.
 */
describe("U5-POST763-01 the descriptor is the authority", () => {
  const fixture = (label: string) => {
    const home = tempDir(`acp-u5-01-fd-${label}-`);
    chmodSync(home, 0o700);
    const stateDir = join(home, ".agent-control-plane");
    mkdirSync(stateDir, { recursive: true });
    chmodSync(stateDir, 0o700);
    // The protected canonical database is a real WAL-mode database, so "untouched" is a claim
    // about a live `-wal` and `-shm` rather than about two files of invented bytes.
    const canonical = join(stateDir, "state.sqlite");
    seedWithRealWal(canonical);
    expect(imprintOf(canonical).wal).not.toBe("absent");
    expect(imprintOf(canonical).shm).not.toBe("absent");

    const approved = seedAt(join(home, "approved.sqlite"));
    const intruder = seedAt(join(home, "intruder.sqlite"));
    approveMigration(approved, `fd-${label}`);
    return {
      home,
      approved,
      intruder,
      canonical,
      before: {
        approved: imprintOf(approved),
        intruder: imprintOf(intruder),
        canonical: imprintOf(canonical),
      },
    };
  };

  const underHome = <T,>(home: string, run: () => T): T => {
    const realHome = process.env["HOME"];
    process.env["HOME"] = home;
    try {
      return run();
    } finally {
      if (realHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = realHome;
    }
  };

  it("refuses the ABA the descriptor-table scan admitted, and never opens the intruder", () => {
    // The exact shape the fd-table scan could not see: some unrelated descriptor in this process
    // is already open on the approved file, the pathname is pointed at an intruder, and then put
    // back. A scan for "is the expected inode open anywhere in this process" answers yes to the
    // unrelated descriptor while the connection is on the intruder.
    //
    // Here the pathname is resolved once and the answer is the descriptor this command opened, so
    // the unrelated one is not consulted and cannot vouch for anything.
    const f = fixture("aba");
    const unrelated = openSync(f.approved, "r");
    try {
      underHome(f.home, () => {
        expect(() =>
          __runApprovedCopyMigrationWithSeam(f.approved, () => {
            renameSync(f.intruder, f.approved);
          }),
          // `rename` onto the pathname unlinks the verified object, so the descriptor reports a
          // link count of zero: the file this command holds open is no longer reachable under any
          // name at all. Either refusal is the same finding read from the same descriptor.
        ).toThrowError(/reachable under 0 names|no longer names the copy this command verified/);
      });
    } finally {
      closeSync(unrelated);
    }

    // The intruder now answers to the approved name and is byte-identical to what it was: the
    // command never opened it, never wrote it, and left no log beside it.
    expect(imprintOf(f.approved)).toEqual({
      main: f.before.intruder.main,
      wal: f.before.approved.wal,
      shm: f.before.approved.shm,
    });
    expect(userVersion(f.approved)).toBe(25);
    // And the deployment's own real-WAL database is untouched in all three artifacts.
    expect(imprintOf(f.canonical)).toEqual(f.before.canonical);
  }, 120_000);

  it("refuses a hard link made onto the verified object before the commit", () => {
    // The pathname is undisturbed here — every name-level answer is unchanged. What differs is
    // the object's own link count, read from the descriptor.
    const f = fixture("link");
    const alias = join(f.home, "alias.sqlite");
    underHome(f.home, () => {
      expect(() =>
        __runApprovedCopyMigrationWithSeam(f.approved, () => {
          linkSync(f.approved, alias);
        }),
      ).toThrowError(/reachable under 2 names/);
    });

    expect(imprintOf(f.approved)).toEqual(f.before.approved);
    expect(userVersion(f.approved)).toBe(25);
    expect(imprintOf(f.intruder)).toEqual(f.before.intruder);
    expect(imprintOf(f.canonical)).toEqual(f.before.canonical);
  }, 120_000);

  it("refuses a symbolic link standing where the copy was, and leaves both files alone", () => {
    const f = fixture("symlink");
    const real = seedAt(join(f.home, "elsewhere.sqlite"));
    const realBefore = imprintOf(real);
    unlinkSync(f.approved);
    symlinkSync(real, f.approved);
      underHome(f.home, () => {
        expect(() => migrateApprovedCopy(f.approved)).toThrowError(/refusing a symbolic link/);
      });

    // The approved pathname's own family, the file the link pointed at, and the canonical
    // database: none of the three moved.
    expect(imprintOf(f.approved)).toEqual({
      main: realBefore.main,
      wal: f.before.approved.wal,
      shm: f.before.approved.shm,
    });
    expect(imprintOf(real)).toEqual(realBefore);
    expect(userVersion(real)).toBe(25);
    expect(imprintOf(f.canonical)).toEqual(f.before.canonical);
  }, 120_000);

  it("refuses a copy that still has a write-ahead log beside it", () => {
    // In WAL mode the main file's header can lag behind frames living in the sidecar, so a copy
    // with a log beside it is one whose version cannot be read from its header and whose bytes
    // cannot be taken from the main file alone. This is also the fixture the `-shm` oracle needs:
    // a real log, produced by SQLite.
    const home = tempDir("acp-u5-01-fd-wal-");
    chmodSync(home, 0o700);
    const copy = join(home, "copy.sqlite");
    seedAt(copy);
    // Approved *before* the log is laid down: recording an approval opens the database read-only,
    // and the last connection to close a WAL database folds the log back and removes the
    // sidecars. The triple is written afterwards, over the same inode, so the approval still
    // names this file.
    approveMigration(copy, "fd-wal");
    seedWithRealWal(copy);
    const before = imprintOf(copy);
    expect(before.wal).not.toBe("absent");
    expect(before.shm).not.toBe("absent");

      underHome(home, () => {
        expect(() => migrateApprovedCopy(copy)).toThrowError(/beside it/);
      });

    expect(imprintOf(copy)).toEqual(before);
    expect(userVersion(copy)).toBe(25);
  }, 120_000);

  it("still migrates the verified object when nothing disturbs it", () => {
    // The negative control. A design that refused whenever a seam existed would satisfy every
    // case above and never let a migration through — and the commit has to land on the object the
    // descriptor named, which is what the version readback proves.
    const f = fixture("ok");
    let fired = false;
      underHome(f.home, () => {
        const report = __runApprovedCopyMigrationWithSeam(f.approved, () => {
          fired = true;
        });
        expect(report.toVersion).toBe(SCHEMA_VERSION);
      });
    expect(fired, "the seam never ran, so the cases above prove nothing").toBe(true);
    expect(userVersion(f.approved)).toBe(SCHEMA_VERSION);
    expect(imprintOf(f.intruder)).toEqual(f.before.intruder);
    expect(imprintOf(f.canonical)).toEqual(f.before.canonical);
  }, 120_000);
});
