import { spawnSync } from "node:child_process";
import { chmodSync, closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
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
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const VFS_SOURCE = join(REPO_ROOT, "native", "fd-vfs", "src", "acp_fd_vfs.c");

/** Compiles the VFS with the testing macro, optionally from transformed source. */
const compileTestingArtifact = (label: string, transform?: (source: string) => string): string => {
  const dir = tempDir(`acp-u6-artifact-${label}-`);
  chmodSync(dir, 0o700);
  const out = join(dir, process.platform === "darwin" ? "acp_fd_vfs.dylib" : "acp_fd_vfs.so");
  let source = VFS_SOURCE;
  if (transform) {
    source = join(dir, "acp_fd_vfs.c");
    writeFileSync(source, transform(readFileSync(VFS_SOURCE, "utf8")), { mode: 0o600 });
  }
  const includes = join(
    createRequire(import.meta.url).resolve("better-sqlite3"),
    "..",
    "..",
    "deps",
    "sqlite3",
  );
  const result = spawnSync(
    process.env["CC"] ?? "cc",
    ["-O1", "-fPIC", "-shared", "-DACP_FD_VFS_TESTING", `-I${includes}`, "-o", out, source],
    { encoding: "utf8" },
  );
  expect(result.status, `compiling the ${label} artifact failed: ${result.stderr}`).toBe(0);
  return out;
};

let testingArtifact: string | null = null;
const buildTestingArtifact = (): string => {
  if (testingArtifact === null) testingArtifact = compileTestingArtifact("baseline");
  return testingArtifact;
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

  /** Runs the two-worker bind race against `artifact` and reports what the parent observed. */
  const raceWith = (
    artifact: string,
    label: string,
  ): {
    bound: number;
    errors: string[];
    predicate: { arrived: number; waiters: number };
    joined: number;
    exitCodes: number[];
  } => {
    const dir = tempDir(`acp-u6-race-${label}-`);
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

    // A child process, because artifacts register a VFS under the same name; loading two here
    // would make the result depend on load order.
    const driver = join(dir, "race.mjs");
    writeFileSync(
      driver,
      [
        `import { Worker } from "node:worker_threads";`,
        `const Database = (await import(${JSON.stringify(better)})).default;`,
        `const boot = new Database(":memory:");`,
        `boot.loadExtension(${JSON.stringify(artifact)});`,
        `boot.prepare("SELECT acp_fd_test_seam(?) AS armed").get(1);`,
        `const outcomes = [];`,
        `const exits = [];`,
        `for (const _ of [0, 1]) {`,
        `  const w = new Worker(${JSON.stringify(worker)}, { workerData: {`,
        `    path: ${JSON.stringify(target)}, extension: ${JSON.stringify(artifact)}, better: ${JSON.stringify(better)} } });`,
        `  outcomes.push(new Promise((resolve) => {`,
        `    w.on("message", resolve);`,
        `    w.on("error", (e) => resolve({ bound: false, error: String(e && e.message ? e.message : e) }));`,
        `  }));`,
        `  exits.push(new Promise((resolve) => w.on("exit", resolve)));`,
        `}`,
        `const read = () => {`,
        `  const line = boot.prepare("SELECT acp_fd_test_seam_state() AS s").get().s;`,
        `  const n = (k) => Number(line.split(" ").find((f) => f.startsWith(k + "=")).slice(k.length + 1));`,
        `  return { arrived: n("arrived"), waiters: n("waiters") };`,
        `};`,
        `let seen;`,
        `let polls = 0;`,
        `for (;;) {`,
        `  seen = read();`,
        `  if (seen.arrived >= 2 || (seen.arrived >= 1 && seen.waiters >= 1)) break;`,
        `  // A bound, not a verdict: the predicate decides the outcome, and this only refuses to`,
        `  // hang forever if it never holds. Reaching it is a failure with a diagnosis.`,
        `  if (++polls > 2500) { process.stderr.write("predicate never held: " + JSON.stringify(seen)); process.exit(3); }`,
        `  await new Promise((r) => setTimeout(r, 2));`,
        `}`,
        `boot.prepare("SELECT acp_fd_test_seam_release() AS r").get();`,
        `const results = await Promise.all(outcomes);`,
        `const codes = await Promise.all(exits);`,
        `process.stdout.write(JSON.stringify({`,
        `  bound: results.filter((r) => r.bound).length,`,
        `  errors: results.filter((r) => r.error).map((r) => r.error),`,
        `  predicate: seen,`,
        `  joined: codes.length,`,
        `  exitCodes: codes,`,
        `}));`,
      ].join("\n"),
      { mode: 0o600 },
    );

    const run = spawnSync(process.execPath, ["--import", "tsx", driver], { encoding: "utf8" });
    expect(run.status, `${label} race driver failed: ${run.stderr}`).toBe(0);
    expect(run.stderr, `${label} race driver warned: ${run.stderr}`).toBe("");
    return JSON.parse(run.stdout) as ReturnType<typeof raceWith>;
  };

  it("serialises concurrent binds, decided by a predicate rather than by a timeout", () => {
    // The state behind the lease is process-global and was unsynchronised: two threads could each
    // pass the active-check before either wrote, and one binding would silently replace the other.
    // Worker threads share the process, so they share the loaded extension's statics.
    //
    // The parent decides when to release and waits for a predicate that is definite in both worlds
    // rather than for a duration. With the lock, one thread reaches the seam and the other is
    // queued for it; without it, both reach the seam. Either way the parent then releases, joins
    // both workers, and asserts against finished threads.
    const report = raceWith(buildTestingArtifact(), "baseline");
    expect(report.joined).toBe(2);
    expect(report.exitCodes).toEqual([0, 0]);
    // The lock's signature: one thread inside, the other queued for the lock rather than at the
    // seam. Two arrivals would mean both had passed the active-check.
    expect(report.predicate.arrived).toBe(1);
    expect(report.predicate.waiters).toBeGreaterThanOrEqual(1);
    expect(report.bound, "two threads bound at once").toBe(1);
  }, 300_000);

  it("owns its lock-removal mutant: without the lock, two joined workers both bind", () => {
    // The baseline above is only evidence if something makes it fail. This compiles a disposable
    // artifact from the same source with exactly one locus removed — the body of the acquisition,
    // count-checked so a rename or a refactor turns this into a failure rather than into a mutant
    // that quietly is not one — and runs the identical driver against it.
    const mutant = compileTestingArtifact("no-lock", (source) => {
      // One contiguous span covering both halves of the pair. Removing only the acquisition is not
      // a smaller mutation but a different one: the release then unlocks a mutex nobody holds,
      // which this code treats as unrecoverable and fails closed on, so nothing races and the
      // driver simply never sees its predicate. The mutation has to leave the pair balanced and
      // remove exactly one thing — mutual exclusion.
      const locus = `  acp_seam_enter_lock_queue();
  int rc = pthread_mutex_lock(&acp_mutex);
  acp_seam_leave_lock_queue();
  return rc == 0;
}`;
      const release = `  if (pthread_mutex_unlock(&acp_mutex) != 0) acp_mutex_ready = 0;`;
      expect(source.split(locus).length - 1, "the acquire locus is not exactly one place").toBe(1);
      expect(source.split(release).length - 1, "the release locus is not exactly one place").toBe(1);
      return source
        .replace(
          locus,
          `  acp_seam_enter_lock_queue();
  acp_seam_leave_lock_queue();
  return 1;
}`,
        )
        .replace(release, `  /* mutant: no release, because there is nothing held */`);
    });

    const report = raceWith(mutant, "no-lock");
    // Both workers ran to completion — the failure is a double binding, not a hang or a crash.
    expect(report.joined).toBe(2);
    expect(report.exitCodes).toEqual([0, 0]);
    // Both reached the seam, which is the shape of the defect: each passed the active-check.
    expect(report.predicate.arrived).toBe(2);
    // And the assertion the baseline case makes dies here, without any timeout deciding it.
    expect(report.bound).toBe(2);
  }, 300_000);

  it("refuses an uppercase spelling of the lease", () => {
    // A capability with two spellings has two holders. Review released a binding from a second
    // connection with acp_fd_unbind(upper(lease)) — the decoder took A-F, so the minted form and
    // an alias of it were both accepted.
    const a = held("case");
    const control = FdVfsControl.load();
    const stranger = strangerConnection();
    try {
      const lease = control.bind(a.path, a.mainFd, a.dirFd);
      expect(lease).toBe(lease.toLowerCase());
      expect(() =>
        stranger.prepare("SELECT acp_fd_unbind(upper(?)) AS r").get(lease),
      ).toThrowError(/not the shape of a lease/);
      expect(control.stats().active, "an uppercase alias released the binding").toBe(true);
      // Mixed case is the same alias problem with a smaller edit distance.
      const mixed = `${lease.slice(0, 31).toUpperCase()}${lease[31]}`;
      if (mixed !== lease) {
        expect(() => stranger.prepare("SELECT acp_fd_unbind(?) AS r").get(mixed)).toThrow();
        expect(control.stats().active).toBe(true);
      }
      control.unbind();
      expect(control.stats().active).toBe(false);
    } finally {
      stranger.close();
      control.close();
      closeSync(a.dirFd);
      closeSync(a.mainFd);
    }
  }, 120_000);

  it("retries an interrupted entropy read and refuses when the source cannot be closed", () => {
    // Three failure modes decide whether a lease is trustworthy and none of them happens on a
    // healthy machine: a short read, an interrupted read, and a close that fails. Without a way to
    // induce them the retry and the cleanup would ship unexecuted, which is the condition they
    // exist for. The seams can only make entropy collection fail — never succeed with weaker bytes.
    const a = held("entropy");
    const artifact = buildTestingArtifact();
    const dir = tempDir("acp-u6-entropy-");
    chmodSync(dir, 0o700);
    const script = join(dir, "entropy.mjs");
    writeFileSync(
      script,
      [
        `import { openSync } from "node:fs";`,
        `import { dirname } from "node:path";`,
        `const Database = (await import(${JSON.stringify(createRequire(import.meta.url).resolve("better-sqlite3"))})).default;`,
        `const db = new Database(":memory:");`,
        `db.loadExtension(${JSON.stringify(artifact)});`,
        `const path = ${JSON.stringify(a.path)};`,
        `const mainFd = openSync(path, "r+");`,
        `const dirFd = openSync(dirname(path), "r");`,
        `const attempt = (shortReads, eintr, closeFails) => {`,
        `  db.prepare("SELECT acp_fd_test_entropy(?, ?, ?) AS a").get(shortReads, eintr, closeFails);`,
        `  try {`,
        `    const row = db.prepare("SELECT acp_fd_bind(?, ?, ?) AS lease").get(path, mainFd, dirFd);`,
        `    db.prepare("SELECT acp_fd_unbind(?) AS r").get(row.lease);`,
        `    return { bound: true, lease: row.lease };`,
        `  } catch (error) { return { bound: false, why: String(error).slice(0, 70) }; }`,
        `};`,
        `const report = {`,
        `  short: attempt(32, 0, 0),`,
        `  interrupted: attempt(0, 4, 0),`,
        `  closeFailed: attempt(0, 0, 1),`,
        `  afterCloseFailure: db.prepare("SELECT acp_fd_stats() AS p").get().p,`,
        `  healthy: attempt(0, 0, 0),`,
        `};`,
        `process.stdout.write(JSON.stringify(report));`,
      ].join("\n"),
      { mode: 0o600 },
    );
    const run = spawnSync(process.execPath, ["--import", "tsx", script], { encoding: "utf8" });
    expect(run.status, `entropy child failed: ${run.stderr}`).toBe(0);
    const report = JSON.parse(run.stdout) as Record<string, { bound: boolean; lease?: string } | string>;

    // A short read is served one byte at a time; the loop must keep asking until it has sixteen.
    expect((report["short"] as { bound: boolean }).bound, "a short read defeated the fill").toBe(true);
    expect((report["short"] as { lease?: string }).lease).toMatch(/^[0-9a-f]{32}$/);
    // EINTR produced no bytes and says nothing about the source, so it is retried, not failed.
    expect((report["interrupted"] as { bound: boolean }).bound).toBe(true);
    // A close that fails is treated as failure even though the bytes are in hand: this is the one
    // place where being wrong is unrecoverable, and refusing costs an operator a retry.
    expect((report["closeFailed"] as { bound: boolean }).bound).toBe(false);
    // And it failed before touching any binding state.
    expect(String(report["afterCloseFailure"])).toContain("active=0");
    expect((report["healthy"] as { bound: boolean }).bound).toBe(true);

    closeSync(a.dirFd);
    closeSync(a.mainFd);
  }, 300_000);

  it("refuses everything when the state lock cannot be taken", () => {
    // Every entry point reads or writes state the mutex protects, so an unusable mutex has to mean
    // refusal rather than unsynchronised access — the fault would otherwise surface as corruption
    // somewhere else entirely. A healthy machine never fails to create a mutex, so the failure is
    // induced by a seam that exists only in the testing artifact.
    const a = held("brokenlock");
    const artifact = buildTestingArtifact();
    const dir = tempDir("acp-u6-brokenlock-");
    chmodSync(dir, 0o700);
    const script = join(dir, "broken.mjs");
    writeFileSync(
      script,
      [
        `import { openSync } from "node:fs";`,
        `import { dirname } from "node:path";`,
        `const Database = (await import(${JSON.stringify(createRequire(import.meta.url).resolve("better-sqlite3"))})).default;`,
        `const db = new Database(":memory:");`,
        `db.loadExtension(${JSON.stringify(artifact)});`,
        `const path = ${JSON.stringify(a.path)};`,
        `const mainFd = openSync(path, "r+");`,
        `const dirFd = openSync(dirname(path), "r");`,
        `const attempt = (label, run) => { try { run(); return [label, "accepted"]; }`,
        `  catch (error) { return [label, String(error).slice(0, 60)]; } };`,
        `db.prepare("SELECT acp_fd_test_break_lock(?) AS b").get(1);`,
        `const broken = [`,
        `  attempt("bind", () => db.prepare("SELECT acp_fd_bind(?, ?, ?) AS l").get(path, mainFd, dirFd)),`,
        `  attempt("unbind", () => db.prepare("SELECT acp_fd_unbind(?) AS r").get("0".repeat(32))),`,
        `  attempt("open", () => { const c = new Database(path); c.close(); }),`,
        `  ["stats", db.prepare("SELECT acp_fd_stats() AS p").get().p],`,
        `];`,
        `db.prepare("SELECT acp_fd_test_break_lock(?) AS b").get(0);`,
        `const healthy = attempt("bind", () => {`,
        `  const row = db.prepare("SELECT acp_fd_bind(?, ?, ?) AS l").get(path, mainFd, dirFd);`,
        `  db.prepare("SELECT acp_fd_unbind(?) AS r").get(row.l);`,
        `});`,
        `process.stdout.write(JSON.stringify({ broken, healthy }));`,
      ].join("\n"),
      { mode: 0o600 },
    );
    const run = spawnSync(process.execPath, ["--import", "tsx", script], { encoding: "utf8" });
    expect(run.status, `broken-lock child failed: ${run.stderr}`).toBe(0);
    const report = JSON.parse(run.stdout) as { broken: string[][]; healthy: string[] };

    const answers = Object.fromEntries(report.broken);
    expect(answers["bind"], "bind proceeded without the lock").toContain("lock is unavailable");
    expect(answers["unbind"], "release proceeded without the lock").toContain("lock is unavailable");
    expect(answers["open"], "an open proceeded without the lock").not.toBe("accepted");
    expect(answers["stats"]).toBe("lock unavailable");
    // And the refusal is the lock's doing, not a broken build: with it restored, binding works.
    expect(report.healthy[1]).toBe("accepted");

    closeSync(a.dirFd);
    closeSync(a.mainFd);
  }, 300_000);

  it("refuses to release while the bound database is still open", () => {
    // The lifetime, made explicit. A release while a file is still open leaves that file holding
    // descriptors whose owner has gone, and its close would have to consult state that no longer
    // describes anything. Refusing removes the class; the holder still has the connection.
    const a = held("lifetime");
    const control = FdVfsControl.load();
    try {
      control.bind(a.path, a.mainFd, a.dirFd);
      const db = new Database(a.path);
      let closed = false;
      try {
        expect(() => control.unbind()).toThrowError(/still open; close it before releasing/);
        expect(control.stats().active).toBe(true);
        db.close();
        closed = true;
      } finally {
        if (!closed) db.close();
      }
      // Once nothing is open, the same lease releases normally.
      control.unbind();
      expect(control.stats().active).toBe(false);
    } finally {
      control.close();
      closeSync(a.dirFd);
      closeSync(a.mainFd);
    }
  }, 120_000);

  it("refuses a second main open under one lease even after the first is closed", () => {
    // One lease, one connection, counted for the life of the lease rather than for the moment.
    //
    // I had this wrong: making the cap a live count turned the contract into "not concurrently
    // open", and I then wrote a test asserting the reopen *succeeded* — codifying the weaker rule
    // as though it were the intended one. Admission is monotonic, and the refusal is decided
    // before the descriptor is duplicated.
    const a = held("monotonic");
    const control = FdVfsControl.load();
    try {
      control.bind(a.path, a.mainFd, a.dirFd);
      const first = new Database(a.path);
      first.exec("CREATE TABLE one (x INTEGER)");
      first.close();

      expect(() => new Database(a.path)).toThrowError(/unable to open database file/i);
      expect(control.stats().refusal).toContain("has already been opened under this lease");
      expect(control.stats().mainOpens).toBe(1);

      // A fresh lease admits one again — the rule is per lease, not per process.
      control.unbind();
      control.bind(a.path, a.mainFd, a.dirFd);
      const next = new Database(a.path);
      try {
        expect(Number(next.pragma("user_version", { simple: true }))).toBe(25);
      } finally {
        next.close();
      }
    } finally {
      control.unbind();
      control.close();
      closeSync(a.dirFd);
      closeSync(a.mainFd);
    }
  }, 120_000);

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
        expect(control.stats().refusal).toContain("has already been opened under this lease");
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
