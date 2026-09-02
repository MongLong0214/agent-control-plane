import { closeSync, openSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

/**
 * Binds a SQLite connection to a descriptor its caller has already verified (`U6` unit 1).
 *
 * Nothing in `src/` outside this file imports it, and `scripts/verify-fd-vfs-is-unreachable.mjs`
 * holds that as a CI gate. Unit 1 is the primitive and its evidence; wiring
 * `migrate-approved-copy` onto it is unit 3, and a call site appearing before then is meant to
 * fail that check rather than be discovered later.
 *
 * The problem it solves is that a pathname is not a file. `lstat(path)` then `open(path)` are two
 * syscalls and a rename between them is invisible to both — so a migration that verifies a
 * pathname and then hands the same pathname to SQLite has verified one thing and opened another.
 * Checking harder does not help: the counterexample that defeated three such designs is to hold an
 * unrelated descriptor on the approved file, point the pathname at an intruder across the open,
 * and put it back, at which point every pathname- and descriptor-table-based check agrees while
 * the connection is on the intruder.
 *
 * So the descriptor is the authority. The caller opens and verifies the file once; the extension's
 * VFS hands SQLite a `dup()` of exactly that descriptor and manages the journal through the
 * caller's directory descriptor. No pathname is resolved after verification, and there is no
 * fallback — a request that does not match the binding is refused, never opened by name.
 */
export interface FdVfsStats {
  active: boolean;
  mainOpens: number;
  journalOpens: number;
  refusals: number;
  refusal: string;
}

/** The built extension. Never compiled here: ADR-0010 keeps compilation at install time. */
const EXTENSION_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "native",
  "fd-vfs",
  "build",
  "Release",
  process.platform === "darwin" ? "acp_fd_vfs.dylib" : "acp_fd_vfs.so",
);

const parseStats = (line: string): FdVfsStats => {
  const field = (name: string): string => new RegExp(`${name}=([^ ]*)`).exec(line)?.[1] ?? "";
  return {
    active: field("active") === "1",
    mainOpens: Number(field("mainOpens")),
    journalOpens: Number(field("journalOpens")),
    refusals: Number(field("refusals")),
    refusal: line.slice(line.indexOf("refusal=") + "refusal=".length),
  };
};

/**
 * The control connection: it owns the extension and the binding, and never the migrated database.
 *
 * Loading is verified by effect rather than by the absence of a throw. `loadExtension` returning
 * quietly says the library was opened; it does not say the VFS registered, and a shim that failed
 * to register would leave every later open going through the ordinary pathname VFS — the exact
 * behaviour this replaces, arrived at silently. So the probe below asks the loaded code what
 * actually happened and refuses if the answer is not what the caller is about to depend on.
 */
export class FdVfsControl {
  readonly #db: InstanceType<typeof Database>;

  private constructor(db: InstanceType<typeof Database>) {
    this.#db = db;
  }

  static load(): FdVfsControl {
    const db = new Database(":memory:");
    try {
      db.loadExtension(EXTENSION_PATH);
    } catch (error) {
      db.close();
      throw new Error(
        `the fd-vfs extension could not be loaded from ${EXTENSION_PATH}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const probe = String((db.prepare("SELECT acp_fd_probe() AS p").get() as { p: string }).p);
    const registered = /registered=1/.test(probe);
    const isDefault = /isDefault=1/.test(probe);
    if (!registered || !isDefault) {
      db.close();
      throw new Error(`the fd-vfs extension loaded but did not take effect: ${probe}`);
    }
    return new FdVfsControl(db);
  }

  /**
   * Binds one open descriptor as the main database for subsequent opens of `basename`.
   *
   * `mainFd` and `dirFd` stay owned by the caller: the VFS duplicates the first per connection and
   * uses the second only for `openat`/`faccessat`/`unlinkat` on the journal, so closing them is
   * the caller's business and closing them early is the caller's bug.
   */
  bind(databasePath: string, mainFd: number, dirFd: number): void {
    this.#db
      .prepare("SELECT acp_fd_bind(?, ?, ?) AS ino")
      .get(basename(databasePath), mainFd, dirFd);
  }

  unbind(): void {
    this.#db.prepare("SELECT acp_fd_unbind() AS was").get();
  }

  stats(): FdVfsStats {
    return parseStats(String((this.#db.prepare("SELECT acp_fd_stats() AS s").get() as { s: string }).s));
  }

  close(): void {
    this.#db.close();
  }
}

/**
 * Opens `databasePath` bound to the object at that path *as it is right now*.
 *
 * The descriptor is taken first and everything after is about it. The caller is expected to have
 * already refused a symbolic link, a non-regular file, more than one link, and a database with a
 * non-empty `-wal`/`-shm` beside it; unit 3 is where `migrate-approved-copy` does that.
 */
export const withBoundDescriptor = <T>(
  control: FdVfsControl,
  databasePath: string,
  work: (fd: number) => T,
): T => {
  const fd = openSync(databasePath, "r+");
  const dirFd = openSync(dirname(databasePath), "r");
  try {
    control.bind(databasePath, fd, dirFd);
    return work(fd);
  } finally {
    control.unbind();
    closeSync(dirFd);
    closeSync(fd);
  }
};
