import { chmodSync, closeSync, openSync } from "node:fs";
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
      expect(lease).toBeGreaterThan(0n);
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
      expect(() =>
        stranger.prepare("SELECT acp_fd_unbind(?) AS released").get(lease + 1n),
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
      expect(lease).toBeGreaterThan(0n);
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
