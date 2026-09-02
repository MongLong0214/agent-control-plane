import { spawnSync } from "node:child_process";
import { chmodSync, closeSync, openSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";

import { FdVfsControl, withBoundDescriptor } from "../../src/db/fd-vfs.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * `U6` unit 2 — the bracket around a process-global binding.
 *
 * The default VFS is process-global, so "who is bound" is process-global too, and unit 1 left three
 * things possible that never announced themselves: a second `bind` silently replaced the first, so
 * a caller could hold a descriptor it believed was bound while every open went to somebody else's
 * file; `unbind` cleared whatever was there for whoever asked, so an unrelated caller could release
 * a migration's binding mid-flight; and the bound database could be opened repeatedly, so "the
 * connection this binding is for" named nothing in particular.
 *
 * A lease closes all three. It is an identifier rather than a secret — anything that can call these
 * functions can read the memory holding it — and what it buys is that each of those mistakes is
 * refused instead of silently absorbed.
 */
const seed = (path: string): string => {
  const db = new Database(path);
  try {
    db.pragma("journal_mode = DELETE");
    db.exec("CREATE TABLE rows (a INTEGER)");
    db.pragma("user_version = 25");
  } finally {
    db.close();
    chmodSync(path, 0o600);
  }
  return path;
};

/**
 * A raw connection with the shipped extension loaded, standing in for an unrelated caller.
 *
 * Deliberately not a method on `FdVfsControl`: a production loader should not carry a way to
 * release somebody else's binding, and the point of this case is precisely that an unrelated
 * caller — which is what any connection able to load the library is — cannot. `acp_fd_unbind` is a
 * production function, so calling it directly is what a stranger would actually do.
 */
const strangerConnection = (): InstanceType<typeof Database> => {
  const db = new Database(":memory:");
  db.loadExtension(
    join(
      fileURLToPath(new URL("../..", import.meta.url)),
      "native",
      "fd-vfs",
      "build",
      "Release",
      process.platform === "darwin" ? "acp_fd_vfs.dylib" : "acp_fd_vfs.so",
    ),
  );
  return db;
};

/**
 * The same C source compiled with the testing macro, for the rendezvous this file needs.
 *
 * Duplicated rather than shared with the binding suite on purpose: this correction is bounded to
 * three paths, and adding a fourth to hold a helper would widen it for tidiness.
 */
let testingArtifact: string | null = null;

const buildTestingArtifact = (): string => {
  if (testingArtifact !== null) return testingArtifact;
  const dir = tempDir("acp-u6-lease-artifact-");
  chmodSync(dir, 0o700);
  const out = join(dir, process.platform === "darwin" ? "acp_fd_vfs.dylib" : "acp_fd_vfs.so");
  const repo = fileURLToPath(new URL("../..", import.meta.url));
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
      join(repo, "native", "fd-vfs", "src", "acp_fd_vfs.c"),
    ],
    { encoding: "utf8" },
  );
  expect(result.status, `compiling the testing artifact failed: ${result.stderr}`).toBe(0);
  testingArtifact = out;
  return out;
};

/** One private directory holding one seeded database, with its descriptors open. */
const held = (label: string) => {
  const dir = tempDir(`acp-u6-lease-${label}-`);
  chmodSync(dir, 0o700);
  const path = seed(join(dir, "copy.sqlite"));
  return { dir, path, mainFd: openSync(path, "r+"), dirFd: openSync(dir, "r") };
};

describe("U6-UNIT2 a binding is held under a lease", () => {
  it("refuses a second binding instead of silently replacing the first", () => {
    // The replacement is the dangerous half: the first caller keeps a descriptor it believes is
    // bound, and every open from then on resolves to the second caller's file.
    const a = held("first");
    const b = held("second");
    const control = FdVfsControl.load();
    try {
      const lease = control.bind(a.path, a.mainFd, a.dirFd);
      expect(lease).toMatch(/^[0-9a-f]{32}$/);
      expect(() => control.bind(b.path, b.mainFd, b.dirFd)).toThrowError(
        /a binding is already active/,
      );

      // The first binding is intact, not left in some half-replaced state.
      const db = new Database(a.path);
      try {
        db.exec("CREATE TABLE proof (x INTEGER)");
      } finally {
        db.close();
      }
      expect(control.stats().active).toBe(true);
    } finally {
      control.unbind();
      control.close();
      for (const h of [a, b]) {
        closeSync(h.dirFd);
        closeSync(h.mainFd);
      }
    }
  }, 120_000);

  it("refuses to release a binding to a lease that does not hold it", () => {
    const a = held("release");
    const control = FdVfsControl.load();
    const stranger = strangerConnection();
    try {
      const lease = control.bind(a.path, a.mainFd, a.dirFd);
      // Any connection that can load the library can call this; holding the lease is what decides.
      // A different, well-formed lease is the closest a stranger can legitimately get.
      const other = lease.startsWith("0") ? `1${lease.slice(1)}` : `0${lease.slice(1)}`;
      expect(() =>
        stranger.prepare("SELECT acp_fd_unbind(?) AS released").get(other),
      ).toThrowError(/that lease does not hold the active binding/);
      expect(control.stats().active).toBe(true);
      // The holder can still release it.
      control.unbind();
      expect(control.stats().active).toBe(false);
    } finally {
      stranger.close();
      control.close();
      closeSync(a.dirFd);
      closeSync(a.mainFd);
    }
  }, 120_000);

  it("refuses every guessed or coerced token a stranger can present", () => {
    // This is the case that already got through once. The lease used to be a counter, so it was 1,
    // and `acp_fd_unbind(1.9)` released it — `sqlite3_value_int64` rounds a REAL, so even a wrong
    // *type* worked. A capability a stranger can guess or coerce into is not a capability.
    const a = held("forge");
    const control = FdVfsControl.load();
    const stranger = strangerConnection();
    try {
      const lease = control.bind(a.path, a.mainFd, a.dirFd);
      expect(lease).toMatch(/^[0-9a-f]{32}$/);

      const forged: unknown[] = [
        1,
        1.9,
        0,
        -1,
        "1",
        "2.9",
        "",
        "0".repeat(32),
        "f".repeat(32),
        // What a counter would have minted. The previous lease was 1, 2, 3…, so these are not
        // arbitrary guesses — they are the whole keyspace of that design.
        `${"0".repeat(31)}1`,
        `${"0".repeat(31)}2`,
        `${"0".repeat(30)}0a`,
        lease.slice(0, 31),
        `${lease}0`,
        lease.toUpperCase().replace(/[0-9]/g, "0"),
        `${lease.slice(0, 31)}${lease[31] === "0" ? "1" : "0"}`,
        Buffer.from(lease, "hex"),
        null,
      ];
      for (const token of forged) {
        expect(() => stranger.prepare("SELECT acp_fd_unbind(?) AS r").get(token), `${String(token)} was accepted`)
          .toThrow();
        expect(control.stats().active, `${String(token)} released the binding`).toBe(true);
      }

      // And the real lease still works, so the matrix above is about forgery rather than about
      // release being broken.
      control.unbind();
      expect(control.stats().active).toBe(false);
    } finally {
      stranger.close();
      control.close();
      closeSync(a.dirFd);
      closeSync(a.mainFd);
    }
  }, 180_000);

  it("serialises concurrent binds so only one of two threads takes the binding", () => {
    // The state behind the lease is process-global and was unsynchronised: two threads could each
    // pass the active-check before either wrote, and one binding would silently replace the other.
    // Worker threads share the process, so they share the loaded extension's statics — a real race
    // rather than a simulated one.
    //
    // Driven through the testing artifact's rendezvous rather than by repetition, and that choice
    // is a measurement: with the lock removed, forty unsynchronised rounds produced a double
    // binding only three times, so an eight-round test would have missed the defect about half the
    // time. Armed for two arrivals, the outcome is decided by whether the lock exists — with it,
    // the second thread is still queued and the first waits out the timeout alone; without it,
    // both arrive at once and both bind.
    const artifact = buildTestingArtifact();
    const dir = tempDir("acp-u6-race-");
    chmodSync(dir, 0o700);
    const target = seed(join(dir, "copy.sqlite"));
    const better = createRequire(import.meta.url).resolve("better-sqlite3");

    const worker = join(dir, "bind-worker.mjs");
    writeFileSync(
      worker,
      [
        `import { workerData, parentPort } from "node:worker_threads";`,
        `import { openSync } from "node:fs";`,
        `import { dirname } from "node:path";`,
        `const Database = (await import(workerData.better)).default;`,
        `const db = new Database(":memory:");`,
        `db.loadExtension(workerData.extension);`,
        `const mainFd = openSync(workerData.path, "r+");`,
        `const dirFd = openSync(dirname(workerData.path), "r");`,
        `let outcome;`,
        `try {`,
        `  const row = db.prepare("SELECT acp_fd_bind(?, ?, ?) AS lease").get(workerData.path, mainFd, dirFd);`,
        `  outcome = { bound: true, lease: row.lease };`,
        `} catch { outcome = { bound: false }; }`,
        `parentPort.postMessage(outcome);`,
      ].join("\n"),
      { mode: 0o600 },
    );

    // A child process, because the testing artifact and the shipped one register a VFS under the
    // same name; loading both here would make the result depend on load order.
    const driver = join(dir, "race.mjs");
    writeFileSync(
      driver,
      [
        `import { Worker } from "node:worker_threads";`,
        `const Database = (await import(${JSON.stringify(better)})).default;`,
        `const boot = new Database(":memory:");`,
        `boot.loadExtension(${JSON.stringify(artifact)});`,
        `boot.prepare("SELECT acp_fd_test_barrier(?) AS n").get(2);`,
        `const results = await Promise.all([0, 1].map(() => new Promise((resolve, reject) => {`,
        `  const w = new Worker(${JSON.stringify(worker)}, { workerData: {`,
        `    path: ${JSON.stringify(target)}, extension: ${JSON.stringify(artifact)}, better: ${JSON.stringify(better)} } });`,
        `  w.on("message", resolve); w.on("error", reject);`,
        `})));`,
        `process.stdout.write(JSON.stringify({ bound: results.filter((r) => r.bound).length }));`,
      ].join("\n"),
      { mode: 0o600 },
    );

    const run = spawnSync(process.execPath, ["--import", "tsx", driver], { encoding: "utf8" });
    expect(run.status, `race driver failed: ${run.stderr}`).toBe(0);
    const { bound } = JSON.parse(run.stdout) as { bound: number };
    expect(bound, "two threads bound at once").toBe(1);
  }, 300_000);

  it("keeps its lease when a release is refused, instead of going quiet", () => {
    // The loader used to clear its lease before the native release returned, so a refused release
    // still mutated caller-visible state: the control believed it had let go while the process was
    // still bound, and the binding could then be released by nobody.
    //
    // Observable as silence. With the lease dropped early, the second attempt has nothing to send
    // and returns without complaint; with the lease kept, the refusal repeats — which is the
    // honest answer, because nothing has changed.
    const a = held("refused");
    const control = FdVfsControl.load();
    const stranger = strangerConnection();
    try {
      const mine = control.bind(a.path, a.mainFd, a.dirFd);
      // Take the binding away and give it to someone else, so the control's lease is stale rather
      // than merely spent.
      stranger.prepare("SELECT acp_fd_unbind(?) AS r").get(mine);
      const theirs = stranger
        .prepare("SELECT acp_fd_bind(?, ?, ?) AS lease")
        .get(a.path, a.mainFd, a.dirFd) as { lease: string };
      expect(theirs.lease).not.toBe(mine);

      expect(() => control.unbind()).toThrowError(/that lease does not hold the active binding/);
      // Again: a control that quietly forgot its lease would return without a word here.
      expect(() => control.unbind()).toThrowError(/that lease does not hold the active binding/);
      expect(control.stats().active).toBe(true);

      stranger.prepare("SELECT acp_fd_unbind(?) AS r").get(theirs.lease);
      expect(control.stats().active).toBe(false);
    } finally {
      stranger.close();
      control.close();
      closeSync(a.dirFd);
      closeSync(a.mainFd);
    }
  }, 120_000);

  it("releasing when nothing is bound succeeds, so a bracket can release unconditionally", () => {
    // A release that threw when the acquire never happened would force every caller to track how
    // far it got, which is the bookkeeping a bracket exists to remove.
    const control = FdVfsControl.load();
    try {
      expect(control.stats().active).toBe(false);
      expect(() => control.unbind()).not.toThrow();
      expect(control.stats().active).toBe(false);
    } finally {
      control.close();
    }
  }, 60_000);

  it("allows the bound database to be opened once, and refuses a second connection to it", () => {
    // Two connections on one descriptor share a file position and a lock state that neither is
    // tracking. One lease means one connection.
    const a = held("single");
    const control = FdVfsControl.load();
    try {
      control.bind(a.path, a.mainFd, a.dirFd);
      const first = new Database(a.path);
      try {
        expect(() => new Database(a.path)).toThrowError(/unable to open database file/i);
        expect(control.stats().refusal).toContain("already open under this lease");
        // The connection that got there first is unharmed.
        first.exec("CREATE TABLE proof (x INTEGER)");
      } finally {
        first.close();
      }
      expect(control.stats().mainOpens).toBe(1);
    } finally {
      control.unbind();
      control.close();
      closeSync(a.dirFd);
      closeSync(a.mainFd);
    }
  }, 120_000);

  it("releases the binding when the work throws, and a fresh binding can be taken", () => {
    // The property a bracket exists for: a failure inside the work must not leave the process
    // globally bound, because the next caller would then be refused for a reason that has nothing
    // to do with it.
    const a = held("throwing");
    const control = FdVfsControl.load();
    try {
      expect(() =>
        withBoundDescriptor(control, a.path, () => {
          throw new Error("work failed");
        }),
      ).toThrowError(/work failed/);
      expect(control.stats().active).toBe(false);

      // And the next binding is takeable, which is what "released" has to mean.
      const lease = control.bind(a.path, a.mainFd, a.dirFd);
      expect(lease).toMatch(/^[0-9a-f]{32}$/);
      control.unbind();
      expect(control.stats().active).toBe(false);
    } finally {
      control.close();
      closeSync(a.dirFd);
      closeSync(a.mainFd);
    }
  }, 120_000);

  it("still runs the ordinary bind, work, release cycle more than once", () => {
    // The negative control. Every case above is a refusal; a lease that refused everything would
    // satisfy all of them and never let a migration bind at all.
    const a = held("cycle");
    const control = FdVfsControl.load();
    try {
      for (const round of [1, 2]) {
        const version = withBoundDescriptor(control, a.path, () => {
          const db = new Database(a.path);
          try {
            db.exec(`CREATE TABLE round_${round} (x INTEGER)`);
            return Number(db.pragma("user_version", { simple: true }));
          } finally {
            db.close();
          }
        });
        expect(version).toBe(25);
        expect(control.stats().active).toBe(false);
      }
    } finally {
      control.close();
      closeSync(a.dirFd);
      closeSync(a.mainFd);
    }
  }, 180_000);
});
