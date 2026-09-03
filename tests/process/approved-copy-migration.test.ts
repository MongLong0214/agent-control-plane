import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";

import { SCHEMA_VERSION } from "../../src/db/database.ts";
import { approveMigration } from "../../src/db/migration-approval.ts";
import { MIGRATIONS } from "../../src/db/migrations.ts";
import { SingleInstanceLock } from "../../src/daemon/single-instance.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * `U6` unit 3 — one approved copy is migrated through the descriptor that was verified.
 *
 * The reconciliation packet's dry run was assembled by hand: a `node --input-type=module -e` that
 * imported `openDb` from the deployment's `dist`. That is not an operator interface. It is a
 * private import spelled out in a runbook, so nothing tests it, nothing versions it, and the
 * operator proving a chain is proving it with a program they wrote at the keyboard during an
 * incident.
 *
 * The process is spawned rather than called, because the thing under test is what a person types
 * and what comes back — not a function this file could import.
 */
const CLI = fileURLToPath(new URL("../../src/db/state-admin.ts", import.meta.url));
/** Imported by the parked child below; the CLI passes no seam, so only a test can reach one. */
const DB_MODULE = new URL("../../src/db/database.ts", import.meta.url).href;
const LINEAGE = readFileSync(new URL("../fixtures/schema-v25-lineage.sql", import.meta.url), "utf8");

const run = (args: readonly string[], env: NodeJS.ProcessEnv = {}) =>
  spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 120_000,
  });

/** One v25-shaped database, built from the committed lineage rather than from anything live. */
const seedAt = (path: string, version = 25): string => {
  const raw = new Database(path);
  try {
    raw.function("acp_schema_migration_authorized", () => 1);
    raw.exec(LINEAGE);
    for (const [applied, id] of [
      [20, "bootstrap-v20"],
      [21, "v21-canonical-turns"],
      [22, "v22-canonical-turn-ledger"],
      [23, "v23-turn-claimed-at"],
      [24, "v24-observation-ledger"],
      [25, "v25-sources-name-admitted-messages"],
    ] as const) {
      raw
        .prepare(
          `INSERT INTO schema_migrations (version, migration_id, checksum, applied_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(applied, id, `sha256:${"b".repeat(64)}`, "2026-08-23T02:39:31.318Z");
    }
    raw.pragma(`user_version = ${version}`);
  } finally {
    raw.close();
    chmodSync(path, 0o600);
  }
  return path;
};

const artifact = (path: string): "absent" | Buffer =>
  existsSync(path) ? readFileSync(path) : "absent";

/** Main file and both sidecars, each as `absent` or its exact bytes. */
const imprintOf = (path: string) => ({
  main: artifact(path),
  wal: artifact(`${path}-wal`),
  shm: artifact(`${path}-shm`),
});

/** The header's `user_version`, read without connecting — the act under test is the connection. */
const headerVersion = (path: string): number => readFileSync(path).readUInt32BE(60);

/** A private directory with a seeded copy and, unless told otherwise, an approval for it. */
const copyIn = (label: string, options: { approve?: boolean; version?: number } = {}) => {
  const dir = tempDir(`acp-u6-unit3-${label}-`);
  chmodSync(dir, 0o700);
  const path = seedAt(join(dir, "copy.sqlite"), options.version ?? 25);
  if (options.approve !== false) approveMigration(path, `unit3-${label}`);
  return { dir, path };
};

describe("U6-UNIT3 migrate-approved-copy runs in the file it verified", () => {
  it("migrates an approved v25 copy in place, on a rollback journal, without starting anything", () => {
    const { dir, path } = copyIn("green");
    const before = statSync(path);

    // The database this command must never touch is the one it derives internally from HOME, so
    // the control is seeded at exactly that path with sidecars of its own.
    const stateDir = join(dir, ".agent-control-plane");
    mkdirSync(stateDir, { recursive: true });
    chmodSync(stateDir, 0o700);
    const canonical = seedAt(join(stateDir, "state.sqlite"));
    writeFileSync(`${canonical}-wal`, Buffer.from("canonical-wal"), { mode: 0o600 });
    writeFileSync(`${canonical}-shm`, Buffer.from("canonical-shm"), { mode: 0o600 });
    const canonicalBefore = imprintOf(canonical);

    const result = run(["migrate-approved-copy", "--database-copy", path, "--confirm-migration"], {
      ACP_STATE_DIR: dir,
      HOME: dir,
    });
    expect(result.status, result.stderr).toBe(0);

    const report = JSON.parse(result.stdout) as {
      fromVersion: number;
      toVersion: number;
      migrations: Array<{ id: string; checksum: boolean }>;
      approvalRetired: boolean;
      journalMode: string;
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
    // The mode SQLite established, not the one the open asked for. `Db` requests WAL on every
    // file-backed open and a bound connection has no shared memory, so SQLite declines — silently,
    // by returning the old mode rather than an error.
    expect(report.journalMode).not.toBe("wal");

    // In place, through the descriptor: the file is the same object, not a staged copy renamed
    // over the original.
    const after = statSync(path);
    expect(after.ino).toBe(before.ino);
    expect(after.dev).toBe(before.dev);
    expect(headerVersion(path)).toBe(SCHEMA_VERSION);
    // A bound connection cannot own a shared-memory family, so none was created.
    expect([existsSync(`${path}-wal`), existsSync(`${path}-shm`)]).toEqual([false, false]);

    // The report is the command's own account of itself; the ledger is checked again against what
    // MIGRATIONS says, version, id and checksum, because a command that printed the right JSON and
    // did something else would pass every assertion so far.
    const raw = new Database(path, { readonly: true, fileMustExist: true });
    try {
      const receipts = raw
        .prepare(
          `SELECT version, migration_id AS id, checksum FROM schema_migrations
            WHERE version > 25 ORDER BY version`,
        )
        .all() as Array<{ version: number; id: string; checksum: string }>;
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

    expect(existsSync(join(dir, "migration-approval.json"))).toBe(false);
    // No private path in what an operator would paste into a report, and nothing was started.
    expect(result.stdout).not.toContain(dir);
    expect(result.stdout).not.toMatch(/listening|socket|daemon started/i);
    // The deployment's own database, captured before the command ran.
    expect(imprintOf(canonical)).toEqual(canonicalBefore);
  }, 300_000);

  it("takes its recovery point, and a failed chain leaves the copy at the version it started", () => {
    // The recovery point is the reason a bound connection may not sandbox every database it
    // touches: `Db.migrate` writes it with `VACUUM INTO`, which makes SQLite open that destination
    // as a database of its own. A binding that refused foreign opens removed the backup the whole
    // approval mechanism rests on, so the delegation this asserts is load-bearing rather than
    // permissive.
    const { dir, path } = copyIn("backup");
    const result = run(["migrate-approved-copy", "--database-copy", path, "--confirm-migration"], {
      ACP_STATE_DIR: dir,
      HOME: dir,
    });
    expect(result.status, result.stderr).toBe(0);

    const backups = readdirSync(join(dir, "backups"));
    const preMigration = backups.filter((name) => name.includes("pre-migration-v25"));
    expect(preMigration.length, `no recovery point among ${backups.join(", ")}`).toBeGreaterThan(0);

    // It is a real image of where the copy started, not an empty file named like one.
    const recovered = join(dir, "backups", preMigration[0]!);
    expect(headerVersion(recovered)).toBe(25);
    const raw = new Database(recovered, { readonly: true, fileMustExist: true });
    try {
      const rows = raw
        .prepare("SELECT count(*) AS n FROM schema_migrations WHERE version > 25")
        .get() as { n: number };
      expect(rows.n, "the recovery point already contains the chain it is meant to undo").toBe(0);
    } finally {
      raw.close();
    }
  }, 300_000);

  it("leaves a copy at its starting version when the chain cannot run", () => {
    // The rollback half of the same contract. An approval naming a chain this build does not run
    // is refused before anything is written, so the copy is exactly where it was.
    const { dir, path } = copyIn("chain");
    const approvalPath = join(dir, "migration-approval.json");
    const approval = JSON.parse(readFileSync(approvalPath, "utf8")) as {
      migrations: string[];
    };
    approval.migrations = [...approval.migrations].reverse();
    writeFileSync(approvalPath, JSON.stringify(approval), { mode: 0o600 });
    const before = imprintOf(path);

    const result = run(["migrate-approved-copy", "--database-copy", path, "--confirm-migration"], {
      ACP_STATE_DIR: dir,
      HOME: dir,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("different ordered chain");
    expect(imprintOf(path)).toEqual(before);
    expect(headerVersion(path)).toBe(25);
  }, 300_000);

  it("lets exactly one of two overlapping commands migrate the same copy", async () => {
    // Two processes, one approved copy, scheduled rather than raced — and what each of them is
    // allowed to conclude when the other one got there first.
    //
    // The lease is taken before anything is opened or bound, so without it both processes can bind
    // the same inode and open it before either reaches `Db`'s exclusivity: the bound VFS's locking
    // methods are deliberately no-ops. What that costs is measured below rather than asserted here.
    // On the interleaving this test schedules it costs nothing to the file, because #747's re-read
    // under the lock catches the loser — so this is a regression test for the *outcome*, and the
    // half that the lease itself owns is the refusal at the bottom of this case.
    const { dir, path } = copyIn("overlap");

    // Then the overlap itself — scheduled, not raced.
    //
    // `Promise.all([start(), start()])` was here and could not fail: `SingleInstanceLock.acquire`
    // denies rather than waiting, so whichever process arrives second is refused at whichever layer
    // it reaches first, and the outcome reads the same with the lease and without it. Measured on
    // this file: the two-process case passed with the outer lease deleted.
    //
    // The defect needs an interleaving no race produces on purpose — both processes past the open,
    // one finishing, the *other one still holding what it read before that*. So the parent puts a
    // process there and holds it: a child parks at `beforeMigrationExclusivity`, which is after the
    // bind, the open, the version read and the approval check, and before exclusivity. Two FIFOs
    // carry the handshake, so every step is an ordering rather than a delay.
    const readyFifo = join(dir, "parked-ready.fifo");
    const releaseFifo = join(dir, "parked-release.fifo");
    expect(spawnSync("mkfifo", [readyFifo, releaseFifo]).status, "mkfifo").toBe(0);
    const parkedScript = join(dir, "parked-child.mjs");
    writeFileSync(
      parkedScript,
      [
        `import { openSync, writeSync, closeSync, readFileSync } from "node:fs";`,
        `import { migrateApprovedCopy } from ${JSON.stringify(DB_MODULE)};`,
        `const [copyPath, ready, release] = process.argv.slice(2);`,
        `try {`,
        `  const report = migrateApprovedCopy(copyPath, {`,
        `    beforeMigrationExclusivity: () => {`,
        `      const fd = openSync(ready, "w");`,
        `      try { writeSync(fd, "parked"); } finally { closeSync(fd); }`,
        `      readFileSync(release, "utf8");`,
        `    },`,
        `  });`,
        `  process.stdout.write(JSON.stringify(report));`,
        `} catch (error) {`,
        `  process.stderr.write(error instanceof Error ? error.message : String(error));`,
        `  process.exit(1);`,
        `}`,
      ].join("\n"),
      { mode: 0o600 },
    );

    const parked = spawn(process.execPath, ["--import", "tsx", parkedScript, path, readyFifo, releaseFifo], {
      env: { ...process.env, ACP_STATE_DIR: dir, HOME: dir },
    });
    let parkedOut = "";
    let parkedErr = "";
    parked.stdout.on("data", (chunk: Buffer) => (parkedOut += chunk.toString()));
    parked.stderr.on("data", (chunk: Buffer) => (parkedErr += chunk.toString()));
    let parkedExited = false;
    const parkedClosed = new Promise<{ status: number | null; stdout: string; stderr: string }>(
      (resolve) =>
        parked.on("close", (status) => {
          parkedExited = true;
          resolve({ status, stdout: parkedOut, stderr: parkedErr });
        }),
    );

    // The child is at the boundary when it says so. If it died on the way, that is this failure and
    // not a hang: the read would otherwise block until the suite's timeout with nothing to show.
    const arrived = await Promise.race([
      readFile(readyFifo, "utf8"),
      parkedClosed.then((outcome) => {
        throw new Error(`the child exited before the boundary: ${JSON.stringify(outcome)}`);
      }),
    ]);
    expect(arrived).toBe("parked");

    let first: { status: number | null; stdout: string; stderr: string };
    let second: { status: number | null; stdout: string; stderr: string };
    try {
      // A whole real CLI run — open, migrate, retire the approval, exit — against the same copy a
      // live process already has open and has already read as version 25.
      const cli = run(["migrate-approved-copy", "--database-copy", path, "--confirm-migration"], {
        ACP_STATE_DIR: dir,
        HOME: dir,
      });
      first = { status: cli.status, stdout: cli.stdout, stderr: cli.stderr };
    } finally {
      // Released last, holding everything it decided before the run above.
      if (!parkedExited) await Promise.race([writeFile(releaseFifo, "go"), parkedClosed]);
      second = await parkedClosed;
    }

    const outcomes = [first, second];
    const winners = outcomes.filter((outcome) => outcome.status === 0);
    const losers = outcomes.filter((outcome) => outcome.status !== 0);

    expect(winners.length, `both commands claimed the copy: ${JSON.stringify(outcomes)}`).toBe(1);
    expect(losers.length).toBe(1);

    // The winner did the work and says so about itself.
    const report = JSON.parse(winners[0]!.stdout) as { fromVersion: number; toVersion: number };
    expect(report.fromVersion).toBe(25);
    expect(report.toVersion).toBe(SCHEMA_VERSION);

    // The loser printed no report at all — not a success, and not a version it did not produce.
    expect(losers[0]!.stdout.trim()).toBe("");

    // And it did not restore its own pre-migration image over the winner. The ordered ids are the
    // assertion rather than a count of them: applying the chain twice and losing it both leave a
    // number, and only one of the two is what a restore looks like.
    expect(headerVersion(path)).toBe(SCHEMA_VERSION);
    const chain = MIGRATIONS.filter((migration) => migration.fromVersion >= 25).map(
      (migration) => migration.id,
    );
    const raw = new Database(path, { readonly: true, fileMustExist: true });
    try {
      const applied = raw
        .prepare("SELECT migration_id FROM schema_migrations WHERE version > 25 ORDER BY version")
        .all() as Array<{ migration_id: string }>;
      expect(
        applied.map((row) => row.migration_id),
        "the copy is not carrying exactly the chain the winner applied, once",
      ).toEqual(chain);
    } finally {
      raw.close();
    }

    // #4 — and afterwards, nobody may report the winner's work as their own. The approval was spent
    // and retired, so a later invocation has nothing to apply and must not print a `fromVersion` it
    // did not migrate from.
    const after = run(["migrate-approved-copy", "--database-copy", path, "--confirm-migration"], {
      ACP_STATE_DIR: dir,
      HOME: dir,
    });
    expect(after.status, "a run after the winner reported success it did not produce").not.toBe(0);
    expect(after.stdout.trim()).toBe("");

    // Last, and separately: a lease already held by someone else, on a copy of its own. The command
    // must refuse before it opens anything.
    //
    // Two overlapping processes alone cannot show this. `Db` takes the same lock a moment later,
    // so the loser is refused either way and the outcome looks identical whether or not this
    // command takes a lease of its own — measured: with the lease removed, the two-process case
    // still passes. Nor do the bytes distinguish it: the only write an aborted open would make is
    // the WAL switch, and a bound connection has that declined, so nothing moves.
    //
    // What does distinguish it is which layer refused. A command that takes the lease before it
    // opens anything refuses as itself, about a copy. One that opens first is refused by `Db`,
    // about a schema, and the evidence then names the file it had already opened.
    const held = copyIn("overlap-held");
    const foreign = new SingleInstanceLock(join(held.dir, "agentcpd.lock"));
    expect(foreign.acquire(new Date().toISOString()).allowed).toBe(true);
    const beforeHeld = imprintOf(held.path);
    const refused = run(["migrate-approved-copy", "--database-copy", held.path, "--confirm-migration"], {
      ACP_STATE_DIR: held.dir,
      HOME: held.dir,
    });
    foreign.release();
    expect(refused.status, "a held lease did not stop the command").not.toBe(0);
    expect(refused.stdout.trim()).toBe("");
    const refusal = JSON.parse(refused.stderr) as { message: string; evidence?: { file?: string } };
    expect(
      refusal.message,
      "the refusal came from Db, so the copy had already been opened before the lease was checked",
    ).toContain("refusing to migrate a copy");
    expect(refusal.evidence?.file).toBeUndefined();
    expect(imprintOf(held.path)).toEqual(beforeHeld);
  }, 300_000);

  it("refuses a copy with a non-empty log beside it, before it connects", () => {
    // In WAL mode the main file's header can lag behind frames living in the sidecar, so a copy
    // with a log beside it is one whose version cannot be read from its header — and a bound
    // connection could not replay that log either.
    for (const suffix of ["-wal", "-shm"]) {
      const { dir, path } = copyIn(`log${suffix}`);
      writeFileSync(`${path}${suffix}`, Buffer.from("not empty"), { mode: 0o600 });
      const before = imprintOf(path);

      const result = run(["migrate-approved-copy", "--database-copy", path, "--confirm-migration"], {
        ACP_STATE_DIR: dir,
        HOME: dir,
      });
      expect(result.status, `${suffix} was accepted`).not.toBe(0);
      expect(result.stderr).toContain("name it at rest");
      expect(imprintOf(path)).toEqual(before);
      expect(headerVersion(path)).toBe(25);
    }
  }, 300_000);

  it("refuses every target that is not the one file the approval names", () => {
    const { dir, path } = copyIn("targets");
    const other = seedAt(join(dir, "other.sqlite"));
    const otherBefore = imprintOf(other);

    const link = join(dir, "link.sqlite");
    symlinkSync(path, link);
    const alias = join(dir, "alias.sqlite");
    linkSync(path, alias);
    expect(statSync(path).nlink).toBe(2);
    const notAFile = join(dir, "not-a-file");
    mkdirSync(notAFile);

    for (const target of [other, link, alias, notAFile]) {
      const result = run(
        ["migrate-approved-copy", "--database-copy", target, "--confirm-migration"],
        { ACP_STATE_DIR: dir, HOME: dir },
      );
      expect(result.status, `${target} was accepted`).not.toBe(0);
    }

    // Every underlying database is where it was — the approved copy included. A refusal that
    // migrated the file it refused would be the defect wearing a non-zero exit code.
    expect(headerVersion(path)).toBe(25);
    expect(imprintOf(other)).toEqual(otherBefore);
  }, 300_000);

  it("refuses a copy at another version, and one with no approval at all", () => {
    const wrongVersion = copyIn("v24", { version: 24 });
    const wrong = run(
      ["migrate-approved-copy", "--database-copy", wrongVersion.path, "--confirm-migration"],
      { ACP_STATE_DIR: wrongVersion.dir, HOME: wrongVersion.dir },
    );
    expect(wrong.status).not.toBe(0);
    expect(headerVersion(wrongVersion.path)).toBe(24);

    const unapproved = copyIn("unapproved", { approve: false });
    const none = run(
      ["migrate-approved-copy", "--database-copy", unapproved.path, "--confirm-migration"],
      { ACP_STATE_DIR: unapproved.dir, HOME: unapproved.dir },
    );
    expect(none.status).not.toBe(0);
    expect(none.stderr).toContain("no approval is on file");
    expect(headerVersion(unapproved.path)).toBe(25);
  }, 300_000);

  it("closes its argv grammar", () => {
    const { dir, path } = copyIn("argv");
    const before = imprintOf(path);

    const cases: Array<{ argv: string[]; why: string }> = [
      { argv: ["--database", path, "--database-copy", path, "--confirm-migration"], why: "two database flags" },
      { argv: ["--database-copy", path, "--database-copy", path, "--confirm-migration"], why: "repeated copy" },
      { argv: ["--database-copy", path, "--confirm-migration", "--confirm-migration"], why: "repeated confirm" },
      { argv: ["--database-copy", path, "--confirm-migration", "--output", "/tmp/x"], why: "foreign flag" },
      { argv: ["--database-copy", path, "--confirm-migration", "--confirm-restore"], why: "another command's flag" },
      { argv: ["--database-copy", path, "--confirm-migration", "extra"], why: "positional" },
      { argv: ["--confirm-migration"], why: "no copy named" },
      { argv: ["--database-copy", path], why: "no confirmation" },
      { argv: ["--database-copy", "relative.sqlite", "--confirm-migration"], why: "relative path" },
    ];
    for (const { argv, why } of cases) {
      const result = run(["migrate-approved-copy", ...argv], { ACP_STATE_DIR: dir, HOME: dir });
      expect(result.status, `${why} was accepted`).not.toBe(0);
    }

    // A refused grammar never reached the database.
    expect(imprintOf(path)).toEqual(before);
    expect(headerVersion(path)).toBe(25);

    // And `--database-copy` belongs to this command alone.
    const elsewhere = run(["migration-plan", "--database-copy", path], { ACP_STATE_DIR: dir, HOME: dir });
    expect(elsewhere.status).not.toBe(0);
    expect(elsewhere.stderr).toContain("belongs to migrate-approved-copy");
  }, 300_000);

  it("names the command in its usage, so it is discoverable rather than folklore", () => {
    // The runbook's `node -e` was invisible to every check in this repository. A supported command
    // that no usage mentions is the same thing with a shorter spelling.
    const usage = run([]);
    expect(usage.stderr + usage.stdout).toContain("migrate-approved-copy");
  }, 120_000);
});
