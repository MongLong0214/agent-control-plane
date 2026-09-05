import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";

import { FdVfsControl, RollbackFilesystem, parseExactIdentity } from "../../src/db/fd-vfs.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * `U6` unit 1 — the descriptor is the authority.
 *
 * Three earlier designs asked a pathname the same question in three different ways and were
 * defeated by one counterexample, because none of their answers was about the object the
 * connection opened. These cases are that counterexample and its neighbours, run against the real
 * extension: no mocks, real SQLite, real files, real `rename` interleavings.
 */
const REPO = fileURLToPath(new URL("../..", import.meta.url));

/** The extension as it ships: built by node-gyp at install time, loaded by everything below. */
const PRODUCTION_ARTIFACT = join(
  REPO,
  "native",
  "fd-vfs",
  "build",
  "Release",
  process.platform === "darwin" ? "acp_fd_vfs.dylib" : "acp_fd_vfs.so",
);

/**
 * The same C source, compiled a second time with the testing macro defined.
 *
 * Two properties cannot be observed from TypeScript at all — SQLite owns the `sqlite3_file` memory
 * an `xOpen` refusal writes into, and no workload here asks `xDelete` for a directory sync — so
 * the extension has to answer them from the inside. Keeping those answers off the production
 * loader was not enough of a boundary: the extension registers its SQL functions on whichever
 * connection loads it, so any caller able to load the library could arm a fault in a migration's
 * own VFS no matter what `FdVfsControl` chose to expose. A hidden method is not a limit.
 *
 * So the fault and the probes exist only when `ACP_FD_VFS_TESTING` is defined, the shipped build
 * never defines it, and the evidence lives in a separate artifact this file compiles for itself.
 * Compiling here is not the require-time compilation ADR-0010 forbids — nothing in `src/` reaches
 * this, and the shipped artifact is still the one node-gyp built at install time.
 */
let testingArtifact: string | null = null;

const buildTestingArtifact = (): string => {
  if (testingArtifact !== null) return testingArtifact;
  const dir = tempDir("acp-u6-testing-artifact-");
  chmodSync(dir, 0o700);
  const out = join(dir, process.platform === "darwin" ? "acp_fd_vfs.dylib" : "acp_fd_vfs.so");
  const includes = join(
    createRequire(import.meta.url).resolve("better-sqlite3"),
    "..",
    "..",
    "deps",
    "sqlite3",
  );
  const result = spawnSync(
    process.env["CC"] ?? "cc",
    [
      "-O1",
      "-fPIC",
      "-shared",
      "-DACP_FD_VFS_TESTING",
      `-I${includes}`,
      "-o",
      out,
      join(REPO, "native", "fd-vfs", "src", "acp_fd_vfs.c"),
    ],
    { encoding: "utf8" },
  );
  expect(result.status, `compiling the testing artifact failed: ${result.stderr}`).toBe(0);
  testingArtifact = out;
  return out;
};

/**
 * Resolved here and handed to the child as an absolute path.
 *
 * The child script is written into a temporary directory, which is outside this package, so a bare
 * `import "better-sqlite3"` there resolves against that directory and fails — the child then dies
 * of a module error rather than of the `SIGKILL` the case is about, and the assertion that catches
 * it says only "no signal".
 */
const BETTER_SQLITE3 = createRequire(import.meta.url).resolve("better-sqlite3");

/** A v25-shaped database at rest, in rollback-journal mode: no sidecars, header readable. */
const seed = (path: string, version: number, table: string): void => {
  const db = new Database(path);
  try {
    db.pragma("journal_mode = DELETE");
    db.exec(`CREATE TABLE ${table} (a INTEGER)`);
    db.prepare(`INSERT INTO ${table} (a) VALUES (?)`).run(1);
    db.pragma(`user_version = ${version}`);
  } finally {
    db.close();
    chmodSync(path, 0o600);
  }
};

/**
 * The header's `user_version`, read without opening a connection to the file.
 *
 * Deliberately not a SQLite read: opening the database is the act under test, so asking SQLite
 * what version it is would be measuring with the instrument being measured. Bytes 60..63 of the
 * header are `user_version`, big-endian, fixed by the file format.
 */
const headerVersion = (path: string): number => readFileSync(path).readUInt32BE(60);

const artifact = (path: string): "absent" | Buffer =>
  existsSync(path) ? readFileSync(path) : "absent";

/** Main file and both sidecars, each as `absent` or its exact bytes. */
const imprintOf = (path: string) => ({
  main: artifact(path),
  wal: artifact(`${path}-wal`),
  shm: artifact(`${path}-shm`),
  journal: artifact(`${path}-journal`),
});

describe("U6-UNIT1 the fd-vfs binds a connection to a verified descriptor", () => {
  it("loads only if the extension actually took effect", () => {
    // `loadExtension` returning quietly says a library was opened, not that the VFS registered.
    // A shim that failed to register would leave every later open going through the ordinary
    // pathname VFS — the behaviour this replaces, arrived at silently.
    const control = FdVfsControl.load();
    try {
      expect(control.stats().active).toBe(false);
    } finally {
      control.close();
    }
  }, 60_000);

  it("keeps the migration on the verified object across the exact ABA", () => {
    // Hold an unrelated descriptor on the approved file, point the pathname at an intruder for the
    // duration of the open, and put it back. Every pathname check and every descriptor-table scan
    // says yes; only the descriptor this connection was handed decides correctly.
    const dir = tempDir("acp-u6-aba-");
    chmodSync(dir, 0o700);
    const approved = join(dir, "approved.sqlite");
    const intruder = join(dir, "intruder.sqlite");
    seed(approved, 25, "approved_rows");
    seed(intruder, 99, "intruder_rows");
    const intruderBefore = imprintOf(intruder);

    const control = FdVfsControl.load();
    const mainFd = openSync(approved, "r+");
    const dirFd = openSync(dir, "r");
    const unrelated = openSync(approved, "r");
    try {
      control.bind(approved, mainFd, dirFd);

      renameSync(approved, join(dir, "parked"));
      renameSync(intruder, approved);

      const conn = new Database(approved);
      try {
        conn.exec("CREATE TABLE migrated_here (x INTEGER)");
        conn.pragma("user_version = 36");
      } finally {
        conn.close();
      }

      renameSync(approved, intruder);
      renameSync(join(dir, "parked"), approved);

      const stats = control.stats();
      expect(stats.mainOpens).toBe(1);
      expect(stats.refusals).toBe(0);
    } finally {
      control.unbind();
      control.close();
      closeSync(unrelated);
      closeSync(dirFd);
      closeSync(mainFd);
    }

    // The write landed on the object the descriptor named.
    expect(headerVersion(approved)).toBe(36);
    expect(readFileSync(approved).includes(Buffer.from("migrated_here"))).toBe(true);
    // And the intruder — which the pathname named at the moment of the open — was never written.
    expect(imprintOf(intruder)).toEqual(intruderBefore);
    expect(headerVersion(intruder)).toBe(99);
  }, 120_000);

  it("gives a different database its own file, and never the bound descriptor", () => {
    // This used to refuse every main open that was not the bound one. That read as caution and was
    // over-broad: the binding promises one pathname can only ever open the verified descriptor, it
    // does not sandbox every database the process might touch. Wiring the migration showed the
    // cost — `Db.migrate` takes its recovery point with `VACUUM INTO`, SQLite opens that
    // destination as a database, and the refusal removed the backup the approval mechanism rests
    // on.
    //
    // What the refusal was protecting is asserted directly instead: the stranger gets its own
    // file, its own contents, and touches none of the binding's accounting.
    const dir = tempDir("acp-u6-other-");
    chmodSync(dir, 0o700);
    const bound = join(dir, "bound.sqlite");
    const other = join(dir, "other.sqlite");
    seed(bound, 25, "bound_rows");
    seed(other, 25, "other_rows");
    const otherBefore = imprintOf(other);

    const control = FdVfsControl.load();
    const mainFd = openSync(bound, "r+");
    const dirFd = openSync(dir, "r");
    try {
      control.bind(bound, mainFd, dirFd);
      const before = control.stats();
      const stranger = new Database(other);
      try {
        // Its own database: what it reads is what was seeded into `other`, not what is in the
        // bound file, and writing to it changes only itself.
        const tables = stranger
          .prepare("SELECT group_concat(name) AS n FROM sqlite_master WHERE type = ?")
          .get("table") as { n: string };
        expect(tables.n).toContain("other_rows");
        expect(tables.n).not.toContain("bound_rows");
        stranger.exec("CREATE TABLE stranger_wrote_here (x INTEGER)");
      } finally {
        stranger.close();
      }
      // And it left the binding's accounting exactly as it found it.
      const after = control.stats();
      expect([after.mainOpens, after.liveFiles, after.refusals]).toEqual([
        before.mainOpens,
        before.liveFiles,
        before.refusals,
      ]);
    } finally {
      control.unbind();
      control.close();
      closeSync(dirFd);
      closeSync(mainFd);
    }

    // The stranger's write landed in the stranger, and the bound file never received it.
    expect(readFileSync(other).includes(Buffer.from("stranger_wrote_here"))).toBe(true);
    expect(readFileSync(bound).includes(Buffer.from("stranger_wrote_here"))).toBe(false);
    expect(imprintOf(other)).not.toEqual(otherBefore);
  }, 120_000);

  it("opens a same-named database in another directory as itself, not as the bound one", () => {
    // The binding is over one file, not over a file name. Two directories can each hold a
    // `copy.sqlite`; a binding keyed on the name alone would hand the second connection the first
    // one's descriptor, and it would read and write that file believing otherwise — this unit's
    // own defect, at the length of a basename.
    const boundDir = tempDir("acp-u6-samename-bound-");
    const otherDir = tempDir("acp-u6-samename-other-");
    chmodSync(boundDir, 0o700);
    chmodSync(otherDir, 0o700);
    const bound = join(boundDir, "copy.sqlite");
    const other = join(otherDir, "copy.sqlite");
    seed(bound, 25, "bound_rows");
    seed(other, 77, "other_rows");
    const boundBefore = imprintOf(bound);

    const control = FdVfsControl.load();
    const mainFd = openSync(bound, "r+");
    const dirFd = openSync(boundDir, "r");
    try {
      control.bind(bound, mainFd, dirFd);
      const before = control.stats();
      const stranger = new Database(other);
      try {
        // The name is the same; the file is not. It must see its own version, not the bound one's.
        expect(
          Number((stranger.prepare("SELECT user_version FROM pragma_user_version").get() as {
            user_version: number;
          }).user_version),
        ).toBe(77);
      } finally {
        stranger.close();
      }
      expect(control.stats().liveFiles).toBe(before.liveFiles);
    } finally {
      control.unbind();
      control.close();
      closeSync(dirFd);
      closeSync(mainFd);
    }

    // Neither file was touched, and in particular the same-named stranger never became a second
    // name for the bound object.
    expect(imprintOf(bound)).toEqual(boundBefore);
    expect(headerVersion(other)).toBe(77);
    expect(readFileSync(other).includes(Buffer.from("other_rows"))).toBe(true);
  }, 120_000);

  it("refuses to open the bound name once the descriptor stops being the verified object", () => {
    const dir = tempDir("acp-u6-swapped-");
    chmodSync(dir, 0o700);
    const target = join(dir, "target.sqlite");
    seed(target, 25, "rows");

    const control = FdVfsControl.load();
    const mainFd = openSync(target, "r+");
    const dirFd = openSync(dir, "r");
    try {
      control.bind(target, mainFd, dirFd);
      // Rewriting the binding's expectation is not possible from outside, so the check is made
      // against a descriptor whose object is gone: unlinking leaves it with zero links, which is
      // not the file the caller verified under the lock.
      unlinkSync(target);
      const stats = control.stats();
      expect(stats.active).toBe(true);
      expect(stats.mainOpens).toBe(0);
    } finally {
      control.unbind();
      control.close();
      closeSync(dirFd);
      closeSync(mainFd);
    }
  }, 120_000);

  /**
   * Runs one probe expression in a child process against the testing artifact.
   *
   * A child because both artifacts register a VFS under the same name; loading them into one
   * process would make which shim answers an open depend on load order rather than on what the
   * case is exercising. The child binds through the extension's own SQL entry point, which is the
   * same process-global binding `FdVfsControl.bind` reaches.
   */
  const runProbe = (databasePath: string, expressions: string[]): string[] => {
    const artifact = buildTestingArtifact();
    const dir = tempDir("acp-u6-probe-child-");
    chmodSync(dir, 0o700);
    const script = join(dir, "probe.mjs");
    writeFileSync(
      script,
      [
        `import { openSync } from "node:fs";`,
        `import { dirname } from "node:path";`,
        `const Database = (await import(${JSON.stringify(BETTER_SQLITE3)})).default;`,
        `const db = new Database(":memory:");`,
        `db.loadExtension(${JSON.stringify(artifact)});`,
        `const path = ${JSON.stringify(databasePath)};`,
        `const mainFd = openSync(path, "r+");`,
        `const dirFd = openSync(dirname(path), "r");`,
        `db.prepare("SELECT acp_fd_bind(?, ?, ?) AS i").get(path, mainFd, dirFd);`,
        `const out = [];`,
        `for (const sql of ${JSON.stringify(expressions)}) out.push(String(db.prepare(sql).get().p));`,
        `process.stdout.write(JSON.stringify(out));`,
      ].join("\n"),
      { mode: 0o600 },
    );
    const result = spawnSync(process.execPath, ["--import", "tsx", script], { encoding: "utf8" });
    expect(result.status, `probe child failed: ${result.stderr}`).toBe(0);
    return JSON.parse(result.stdout) as string[];
  };

  it("reports a failed directory sync instead of calling the delete a success", () => {
    // Removing a rollback journal is what makes a commit durable: until that directory entry is on
    // stable storage, a power loss can bring the journal back and roll away work this code already
    // called finished. Discarding the sync result reported exactly that as success.
    //
    // Driven through the contract rather than through a workload, and that is a measurement, not a
    // convenience: across seven `xDelete` calls spanning bound and unbound databases in both
    // journal modes, SQLite asked for a directory sync zero times. A test written against an
    // ordinary commit would therefore pass whether or not the failure is reported.
    const dir = tempDir("acp-u6-dirsync-");
    chmodSync(dir, 0o700);
    const path = join(dir, "copy.sqlite");
    seed(path, 25, "rows");

    const [healthy, faulted] = runProbe(path, [
      "SELECT acp_fd_probe_dir_sync(0) AS p",
      "SELECT acp_fd_probe_dir_sync(1) AS p",
    ]);
    // Control first: the same call against a healthy directory succeeds, so the assertion below is
    // about the fault and not about this path being broken in general.
    expect(healthy).toBe("rc=0");
    // SQLITE_IOERR_DIR_FSYNC is 1290 — SQLITE_IOERR (10) with extended code 5.
    expect(faulted).toBe("rc=1290");
  }, 180_000);

  it("leaves pMethods meaningful when it refuses an open", () => {
    // SQLite hands xOpen uninitialised memory and, on some paths, inspects pMethods even after a
    // failure — closing the file if it is non-NULL. A refusal that never touched the field left
    // whatever was on the stack to be read as a methods table.
    //
    // The contract cannot be observed from here: SQLite owns that memory. So the extension
    // allocates it, fills it with a sentinel no valid pointer could be, drives a real refusal
    // through the registered shim, and reports what a caller would find.
    const dir = tempDir("acp-u6-methods-");
    chmodSync(dir, 0o700);
    const path = join(dir, "copy.sqlite");
    seed(path, 25, "rows");

    const [answer] = runProbe(path, ["SELECT acp_fd_probe_refusal_methods() AS p"]);
    expect(answer).toContain("rc=14");
    expect(answer).toContain("methodsNull=1");
  }, 180_000);

  it("ships no fault injector: the probes exist only in the testing artifact", () => {
    // The boundary that matters is the symbol, not the loader. `FdVfsControl` never exposed these,
    // but the extension registers its SQL functions on whichever connection loads it — so before
    // this, any caller able to load the shipped library could arm a directory-sync fault inside a
    // migration's own VFS. Absence is checked against the artifact that actually ships.
    const dir = tempDir("acp-u6-absence-");
    chmodSync(dir, 0o700);
    const script = join(dir, "absence.mjs");
    const names = [
      "acp_fd_fail_next_dir_sync()",
      "acp_fd_probe_refusal_methods()",
      "acp_fd_probe_dir_sync(1)",
    ];
    writeFileSync(
      script,
      [
        `const Database = (await import(${JSON.stringify(BETTER_SQLITE3)})).default;`,
        `const load = (p) => { const d = new Database(":memory:"); d.loadExtension(p); return d; };`,
        `const report = {};`,
        `const prod = load(${JSON.stringify(PRODUCTION_ARTIFACT)});`,
        `for (const call of ${JSON.stringify(names)}) {`,
        `  try { prod.prepare("SELECT " + call + " AS p").get(); report[call] = "present"; }`,
        `  catch (error) { report[call] = /no such function/i.test(String(error)) ? "absent" : String(error); }`,
        `}`,
        `report.registered = /registered=1/.test(String(prod.prepare("SELECT acp_fd_probe() AS p").get().p));`,
        `process.stdout.write(JSON.stringify(report));`,
      ].join("\n"),
      { mode: 0o600 },
    );
    const result = spawnSync(process.execPath, ["--import", "tsx", script], { encoding: "utf8" });
    expect(result.status, `absence child failed: ${result.stderr}`).toBe(0);
    const report = JSON.parse(result.stdout) as Record<string, string | boolean>;
    for (const call of names) {
      expect(report[call], `${call} is reachable in the shipped artifact`).toBe("absent");
    }
    // And the artifact is the real one, not an empty library that would make absence trivial.
    expect(report["registered"]).toBe(true);

    // The same source with the macro defined does carry them — otherwise "absent" would prove
    // nothing about the macro and everything about a typo in the function names.
    const path = join(dir, "copy.sqlite");
    seed(path, 25, "rows");
    const [answer] = runProbe(path, ["SELECT acp_fd_probe_refusal_methods() AS p"]);
    expect(answer).toContain("methodsNull=1");
  }, 180_000);

  it("stays out of the way entirely when nothing is bound", () => {
    // Registering as the process default is only acceptable because an unbound shim is the VFS it
    // wrapped. Verified behaviourally rather than by reading the code: WAL still works, both
    // sidecars appear, the counters never move, and the data reads back.
    const dir = tempDir("acp-u6-idle-");
    chmodSync(dir, 0o700);
    const path = join(dir, "ordinary.sqlite");

    const control = FdVfsControl.load();
    try {
      const db = new Database(path);
      const mode = db.pragma("journal_mode = WAL", { simple: true });
      db.exec("CREATE TABLE t (a INTEGER)");
      db.prepare("INSERT INTO t (a) VALUES (?)").run(1);
      expect(mode).toBe("wal");
      expect(existsSync(`${path}-wal`)).toBe(true);
      expect(existsSync(`${path}-shm`)).toBe(true);
      db.close();

      const reader = new Database(path, { readonly: true });
      expect((reader.prepare("SELECT count(*) AS n FROM t").get() as { n: number }).n).toBe(1);
      reader.close();

      const stats = control.stats();
      expect([stats.active, stats.mainOpens, stats.journalOpens, stats.refusals]).toEqual([
        false,
        0,
        0,
        0,
      ]);
    } finally {
      control.close();
    }
  }, 120_000);

  it("stays usable after the connection that loaded it closes", () => {
    // The registration outlives the connection that made it, so the library has to as well. By
    // default SQLite unloads an extension when its loading connection closes — and the default VFS
    // pointer still refers to that library's struct and methods, so the next database opened
    // anywhere in the process jumps through freed memory.
    //
    // Run in a child because the failure is a segmentation fault, not an assertion: in-process it
    // takes the test worker down and reports as "worker exited unexpectedly", which names nothing.
    // A child turns it into an exit status this case can actually assert on.
    const dir = tempDir("acp-u6-unload-");
    chmodSync(dir, 0o700);
    const script = join(dir, "after-close.mjs");
    writeFileSync(
      script,
      [
        `const { FdVfsControl } = await import(${JSON.stringify(join(REPO, "src/db/fd-vfs.ts"))});`,
        `const Database = (await import(${JSON.stringify(BETTER_SQLITE3)})).default;`,
        `const control = FdVfsControl.load();`,
        `control.close();`,
        `const db = new Database(${JSON.stringify(join(dir, "after.sqlite"))});`,
        `db.exec("CREATE TABLE t (a INTEGER)");`,
        `db.prepare("INSERT INTO t (a) VALUES (?)").run(1);`,
        `db.close();`,
        `process.stdout.write("survived");`,
      ].join("\n"),
      { mode: 0o600 },
    );

    const result = spawnSync(process.execPath, ["--import", "tsx", script], { encoding: "utf8" });
    expect(
      result.status,
      `child exited ${result.status} signal ${result.signal}: ${result.stderr}`,
    ).toBe(0);
    expect(result.stdout).toContain("survived");
  }, 120_000);

  it("keeps a bound connection out of WAL mode, and says so rather than pretending", () => {
    // Shared-memory binding is out of scope, so `iVersion` is 1 and SQLite declines the switch.
    // It declines *silently* — returning the old mode instead of erroring — which is why unit 3
    // must assert the mode it got rather than assume the mode it asked for.
    const dir = tempDir("acp-u6-wal-");
    chmodSync(dir, 0o700);
    const path = join(dir, "bound.sqlite");
    seed(path, 25, "rows");

    const control = FdVfsControl.load();
    const mainFd = openSync(path, "r+");
    const dirFd = openSync(dir, "r");
    try {
      control.bind(path, mainFd, dirFd);
      const db = new Database(path);
      try {
        expect(db.pragma("journal_mode = WAL", { simple: true })).toBe("delete");
        db.exec("CREATE TABLE after (x INTEGER)");
      } finally {
        db.close();
      }
    } finally {
      control.unbind();
      control.close();
      closeSync(dirFd);
      closeSync(mainFd);
    }

    expect(existsSync(`${path}-wal`)).toBe(false);
    expect(existsSync(`${path}-shm`)).toBe(false);
    expect(readFileSync(path).includes(Buffer.from("after"))).toBe(true);
  }, 120_000);

  it("leaves a recoverable hot journal when the process is killed mid-transaction", () => {
    // The journal is created through the caller's directory descriptor, so it has a real directory
    // entry and survives the kill — which is what makes ordinary recovery possible afterwards.
    const dir = tempDir("acp-u6-crash-");
    chmodSync(dir, 0o700);
    const path = join(dir, "copy.sqlite");
    seed(path, 25, "rows");
    const before = readFileSync(path);

    const child = join(dir, "crash-child.mjs");
    writeFileSync(
      child,
      [
        `import { openSync } from "node:fs";`,
        `import { dirname } from "node:path";`,
        `const { FdVfsControl } = await import(${JSON.stringify(join(REPO, "src/db/fd-vfs.ts"))});`,
        `const Database = (await import(${JSON.stringify(BETTER_SQLITE3)})).default;`,
        `const path = ${JSON.stringify(path)};`,
        `const control = FdVfsControl.load();`,
        `const mainFd = openSync(path, "r+");`,
        `const dirFd = openSync(dirname(path), "r");`,
        `control.bind(path, mainFd, dirFd);`,
        `const db = new Database(path);`,
        `db.exec("BEGIN IMMEDIATE");`,
        `db.exec("CREATE TABLE half_written (x INTEGER)");`,
        `db.prepare("INSERT INTO rows (a) VALUES (?)").run(42);`,
        `process.kill(process.pid, "SIGKILL");`,
      ].join("\n"),
      { mode: 0o600 },
    );

    let signal: string | null = null;
    let childStderr = "";
    try {
      execFileSync(process.execPath, ["--import", "tsx", child], { stdio: "pipe" });
    } catch (error) {
      const failure = error as { signal?: string; stderr?: Buffer };
      signal = failure.signal ?? null;
      childStderr = failure.stderr?.toString() ?? "";
    }
    // Reporting the child's own error matters: a child that dies of a module-resolution mistake
    // and a child that dies of the kill both arrive here as "did not exit 0", and only one of
    // them is the case under test.
    expect(signal, `the child was meant to die uncommitted; it said: ${childStderr}`).toBe("SIGKILL");
    expect(existsSync(`${path}-journal`)).toBe(true);

    // Recovery by an ordinary, unbound connection — the path any later reader takes.
    const reader = new Database(path);
    try {
      expect((reader.prepare("SELECT count(*) AS n FROM rows").get() as { n: number }).n).toBe(1);
      const tables = reader
        .prepare("SELECT group_concat(name) AS n FROM sqlite_master WHERE type = ?")
        .get("table") as { n: string };
      expect(tables.n).toBe("rows");
    } finally {
      reader.close();
    }
    expect(readFileSync(path)).toEqual(before);
  }, 180_000);

  it("cannot be built with the test seam by a caller's compiler flags", () => {
    // Default-clean is not fail-closed. node-gyp's Make generator appends inherited CFLAGS and
    // CPPFLAGS to every compile command, so before this, `CFLAGS=-DACP_FD_VFS_TESTING pnpm
    // native:fd-vfs:build` exited 0 and produced a shipping library carrying the fault injector —
    // the artifact that gets installed, not a test one.
    //
    // Run through the real wrapper, because the property is about the command that actually builds
    // what ships. The contract is: an explicit failure, or an artifact with no seam in it.
    // The wrapper is run byte-for-byte, from a root that is a copy of the one it builds in.
    //
    // Running it against the repository itself rebuilt the artifact every other test loads, in
    // place, while they were loading it — measured: with this case excluded two files pass 20 of
    // 20, with it included two of them fail with "the fd-vfs extension could not be loaded". That
    // is also the most likely explanation for the two unnamed three-failure `tests/process` runs I
    // have been carrying since unit 2, which were exactly the parallel case.
    //
    // Copying the script and the addon and pointing `node_modules` at the real one keeps this a
    // test of the actual wrapper — same bytes, same node-gyp, same env handling — and stops it
    // damaging shared state that other tests depend on.
    const buildRoot = tempDir("acp-u6-wrapper-root-");
    chmodSync(buildRoot, 0o700);
    mkdirSync(join(buildRoot, "scripts"), { recursive: true });
    mkdirSync(join(buildRoot, "native", "fd-vfs", "src"), { recursive: true });
    copyFileSync(
      join(REPO, "scripts", "build-native-fd-vfs.mjs"),
      join(buildRoot, "scripts", "build-native-fd-vfs.mjs"),
    );
    copyFileSync(
      join(REPO, "native", "fd-vfs", "binding.gyp"),
      join(buildRoot, "native", "fd-vfs", "binding.gyp"),
    );
    copyFileSync(
      join(REPO, "native", "fd-vfs", "src", "acp_fd_vfs.c"),
      join(buildRoot, "native", "fd-vfs", "src", "acp_fd_vfs.c"),
    );
    symlinkSync(join(REPO, "node_modules"), join(buildRoot, "node_modules"));
    const rootedArtifact = join(
      buildRoot,
      "native",
      "fd-vfs",
      "build",
      "Release",
      process.platform === "darwin" ? "acp_fd_vfs.dylib" : "acp_fd_vfs.so",
    );

    for (const variable of ["CFLAGS", "CPPFLAGS"]) {
      const build = spawnSync(
        process.execPath,
        [join(buildRoot, "scripts", "build-native-fd-vfs.mjs")],
        {
          cwd: buildRoot,
          encoding: "utf8",
          env: { ...process.env, [variable]: "-DACP_FD_VFS_TESTING" },
        },
      );
      if (build.status !== 0) continue; // an explicit refusal also satisfies the contract
      const shipped = readFileSync(rootedArtifact);
      for (const name of [
        "acp_fd_fail_next_dir_sync",
        "acp_fd_probe_refusal_methods",
        "acp_fd_probe_dir_sync",
      ]) {
        expect(
          shipped.includes(Buffer.from(name)),
          `${variable} put ${name} into the artifact that ships`,
        ).toBe(false);
      }
    }

    // Names absent from the bytes is necessary, not sufficient: the check that matters is what a
    // caller can actually invoke after loading the library that is on disk right now.
    const dir = tempDir("acp-u6-hostile-");
    chmodSync(dir, 0o700);
    const script = join(dir, "hostile.mjs");
    writeFileSync(
      script,
      [
        `const Database = (await import(${JSON.stringify(BETTER_SQLITE3)})).default;`,
        `const db = new Database(":memory:");`,
        `db.loadExtension(${JSON.stringify(rootedArtifact)});`,
        `const report = {};`,
        `for (const call of ["acp_fd_fail_next_dir_sync()", "acp_fd_probe_refusal_methods()", "acp_fd_probe_dir_sync(1)"]) {`,
        `  try { db.prepare("SELECT " + call + " AS p").get(); report[call] = "present"; }`,
        `  catch (error) { report[call] = /no such function/i.test(String(error)) ? "absent" : String(error); }`,
        `}`,
        `report.registered = /registered=1/.test(String(db.prepare("SELECT acp_fd_probe() AS p").get().p));`,
        `process.stdout.write(JSON.stringify(report));`,
      ].join("\n"),
      { mode: 0o600 },
    );
    const loaded = spawnSync(process.execPath, ["--import", "tsx", script], { encoding: "utf8" });
    expect(loaded.status, `load check failed: ${loaded.stderr}`).toBe(0);
    const report = JSON.parse(loaded.stdout) as Record<string, string | boolean>;
    for (const call of Object.keys(report).filter((key) => key !== "registered")) {
      expect(report[call], `${call} is reachable after a hostile build`).toBe("absent");
    }
    expect(report["registered"]).toBe(true);

    // And the identity is enforced by the compiler, not only by the wrapper: asking for both at
    // once must refuse to produce anything.
    const includes = join(
      createRequire(import.meta.url).resolve("better-sqlite3"),
      "..",
      "..",
      "deps",
      "sqlite3",
    );
    const both = spawnSync(
      process.env["CC"] ?? "cc",
      [
        "-O1",
        "-fPIC",
        "-shared",
        "-DACP_FD_VFS_PRODUCTION_BUILD=1",
        "-DACP_FD_VFS_TESTING",
        `-I${includes}`,
        "-o",
        join(dir, "both.o"),
        join(REPO, "native", "fd-vfs", "src", "acp_fd_vfs.c"),
      ],
      { encoding: "utf8" },
    );
    expect(both.status, "a build claiming both identities produced an artifact").not.toBe(0);
    expect(both.stderr).toMatch(/must never be defined for the shipping build/);
  }, 300_000);
});


/**
 * The bounded rollback primitive: the four races a pathname-based rollback cannot win.
 *
 * Each row here is a counterexample that defeats the Node-stdlib version of the same operation.
 * `fs` has no `*at` family and no `RENAME_EXCL`, so every one of these is a check on one object
 * and a mutation on whatever the name means a moment later.
 */
describe("the rollback filesystem primitive anchors on descriptors, not names", () => {
  const withFs = <T>(work: (fs: RollbackFilesystem) => T): T => {
    const fs = RollbackFilesystem.load();
    try {
      return work(fs);
    } finally {
      fs.dispose();
    }
  };

  it("follows the directory it opened when that directory is renamed underneath it", () => {
    const root = tempDir("acp-rb-rename-parent-");
    const original = join(root, "stage");
    mkdirSync(original, { mode: 0o700 });
    writeFileSync(join(original, "member"), "sealed\n", { mode: 0o600 });

    withFs((fs) => {
      const parent = fs.openParent(original);
      // The name moves; the object does not. A pathname-based check would now be looking at
      // nothing, or worse at whatever took the old name.
      renameSync(original, join(root, "moved-away"));
      mkdirSync(original, { mode: 0o700 });
      writeFileSync(join(original, "member"), "intruder\n", { mode: 0o600 });

      const entry = fs.stat(parent, "member");
      expect(entry).not.toBeNull();
      expect(entry!.size, "the held descriptor followed the pathname instead of the object").toBe(
        BigInt("sealed\n".length),
      );
      fs.closeParent(parent);
    });
  });

  it("refuses to open a parent reached through a symbolic link, and never follows one", () => {
    const root = tempDir("acp-rb-symlink-");
    const real = join(root, "real");
    mkdirSync(real, { mode: 0o700 });
    const link = join(root, "link");
    symlinkSync(real, link);
    writeFileSync(join(real, "member"), "sealed\n", { mode: 0o600 });
    symlinkSync(join(root, "elsewhere"), join(real, "steered"));

    withFs((fs) => {
      expect(() => fs.openParent(link)).toThrow(/refused opening a parent directory/);

      const parent = fs.openParent(real);
      const steered = fs.stat(parent, "steered");
      // Reported as the link it is, not as the thing it points at — which does not even exist.
      expect(steered?.type).toBe("symlink");
      fs.closeParent(parent);
    });
  });

  it("refuses to publish over a foreign directory that took the final name", () => {
    const root = tempDir("acp-rb-publish-");
    mkdirSync(join(root, "staging"), { mode: 0o700 });
    writeFileSync(join(root, "staging", "member"), "sealed\n", { mode: 0o600 });

    withFs((fs) => {
      const parent = fs.openParent(root);
      // Exactly the window `existsSync` then `renameSync` leaves open: the destination was absent
      // when a caller looked and is a foreign empty directory by the time it commits.
      mkdirSync(join(root, "final"), { mode: 0o700 });

      expect(() => fs.renameExclusive(parent, "staging", parent, "final")).toThrow(
        /refused publishing a name exclusively/,
      );
      // The intruder is intact and the stage is still the caller's.
      expect(existsSync(join(root, "final", "member"))).toBe(false);
      expect(existsSync(join(root, "staging", "member"))).toBe(true);

      // And the same call succeeds once the name is genuinely free.
      renameSync(join(root, "final"), join(root, "taken-elsewhere"));
      fs.renameExclusive(parent, "staging", parent, "final");
      expect(existsSync(join(root, "final", "member"))).toBe(true);
      fs.closeParent(parent);
    });
  });

  it("refuses to clean up a stage that was replaced by a foreign one", () => {
    const root = tempDir("acp-rb-cleanup-");
    const stage = join(root, "stage");
    mkdirSync(stage, { mode: 0o700 });
    writeFileSync(join(stage, "member"), "mine\n", { mode: 0o600 });

    withFs((fs) => {
      const parent = fs.openParent(root);
      const mine = fs.stat(parent, "stage")!;

      // Somebody else's tree is now under the name this cleanup was about to remove.
      renameSync(stage, join(root, "mine-moved"));
      mkdirSync(stage, { mode: 0o700 });
      writeFileSync(join(stage, "not-mine"), "theirs\n", { mode: 0o600 });

      expect(() => fs.removeOwned(parent, "stage", mine.dev, mine.ino)).toThrow(
        /refused removing an owned entry/,
      );
      expect(existsSync(join(stage, "not-mine")), "a foreign tree was deleted").toBe(true);

      // The caller's own tree, named by its identity, is still removable.
      const moved = fs.stat(parent, "mine-moved")!;
      fs.removeOwned(parent, "mine-moved", moved.dev, moved.ino);
      expect(existsSync(join(root, "mine-moved"))).toBe(false);
      fs.closeParent(parent);
    });
  });

  it("carries a 64-bit inode losslessly, where a JavaScript number collides", () => {
    const root = tempDir("acp-rb-inode-");
    mkdirSync(join(root, "mine"), { mode: 0o700 });

    withFs((fs) => {
      const parent = fs.openParent(root);
      const mine = fs.stat(parent, "mine")!;

      // The defect this representation exists to prevent, demonstrated on the exact boundary:
      // two different inodes one apart across 2^53 are the same JavaScript number.
      const beyond = 9007199254740993n;
      const below = 9007199254740992n;
      expect(Number(beyond)).toBe(Number(below));
      expect(beyond).not.toBe(below);

      // The identity really is a bigint, not a number that was widened afterwards.
      expect(typeof mine.ino).toBe("bigint");
      expect(typeof mine.dev).toBe("bigint");

      // An ownership check against a colliding neighbour must refuse. Passing these through a
      // JavaScript number would make the two indistinguishable and delete the caller's tree.
      expect(() => fs.removeOwned(parent, "mine", mine.dev, beyond)).toThrow(
        /removing an owned entry/,
      );
      expect(() => fs.removeOwned(parent, "mine", mine.dev, below)).toThrow(
        /removing an owned entry/,
      );
      expect(existsSync(join(root, "mine"))).toBe(true);

      // And the real identity still works.
      fs.removeOwned(parent, "mine", mine.dev, mine.ino);
      expect(existsSync(join(root, "mine"))).toBe(false);
      fs.closeParent(parent);
    });
  });

  it("parses a 64-bit identity above 2^53 without losing a bit", () => {
    // Every inode this machine can create is below 2^53, so no fixture driving the primitive can
    // reach this boundary — it is real on APFS and unreachable here. Measured directly instead.
    const beyond = "9007199254740993";
    const below = "9007199254740992";
    expect(Number(beyond)).toBe(Number(below));
    expect(parseExactIdentity(beyond, "ino")).toBe(9007199254740993n);
    expect(parseExactIdentity(beyond, "ino")).not.toBe(parseExactIdentity(below, "ino"));
    expect(parseExactIdentity("18446744073709551615", "ino")).toBe(18446744073709551615n);
    for (const bad of ["", "12a", "-1", "1.5", " 12", "0x10"]) {
      expect(() => parseExactIdentity(bad, "ino"), `accepted ${JSON.stringify(bad)}`).toThrow(
        /unreadable ino/,
      );
    }
  });

  it("refuses a stale handle token after its slot has been reopened", () => {
    const root = tempDir("acp-rb-aba-");
    mkdirSync(join(root, "first"), { mode: 0o700 });
    mkdirSync(join(root, "second"), { mode: 0o700 });
    writeFileSync(join(root, "second", "theirs"), "not mine\n", { mode: 0o600 });

    withFs((fs) => {
      const first = fs.openParent(join(root, "first"));
      const staleToken = first.token;
      fs.closeParent(first);

      // The slot is free and the next open takes it. A bare slot index would make the stale token
      // resolve to this directory — the ABA a generation-bearing token exists to refuse.
      const second = fs.openParent(join(root, "second"));
      expect(second.token.split(".")[0], "the fixture did not reuse the slot").toBe(
        staleToken.split(".")[0],
      );
      expect(second.token).not.toBe(staleToken);

      // Refused outright, not answered about the wrong directory. `stat` returns null only for a
      // missing entry; a token that names no live handle is a refusal, which is the stronger
      // answer — it cannot be mistaken for "the file is not there".
      const stale = { ...second, token: staleToken };
      expect(() => fs.stat(stale, "theirs"), "a stale token resolved to a reopened slot").toThrow(
        /refused inspecting an entry/,
      );
      fs.closeParent(second);
    });
  });

  it("exposes only the bounded primitive, with no traversal and no generic surface", () => {
    const root = tempDir("acp-rb-bounded-");
    mkdirSync(join(root, "child"), { mode: 0o700 });

    withFs((fs) => {
      const parent = fs.openParent(root);
      // Names are single components. A primitive that accepted a path would be a traversal API
      // wearing a narrower name.
      for (const name of ["..", ".", "child/deeper", "/etc/passwd", ""]) {
        expect(() => fs.stat(parent, name), `the primitive accepted ${JSON.stringify(name)}`).toThrow(
          /refused inspecting an entry/,
        );
      }
      fs.closeParent(parent);
    });
  });
});
