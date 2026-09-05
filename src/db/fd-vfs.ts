import { closeSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

import { acpError } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";

/**
 * Binds a SQLite connection to a descriptor its caller has already verified (`U6` unit 1).
 *
 * `migrate-approved-copy` is its one caller. Until unit 3 there was none, and a CI gate held that
 * absence so the primitive going live would be a decision rather than a discovery; the gate was
 * removed in the same change that made this reachable, which is the moment it had been waiting
 * for.
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
  /** Files of this binding currently open. A release is refused while any remain. */
  liveFiles: number;
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
    liveFiles: Number(field("liveFiles")),
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
  /** The lease of the binding this control currently holds, or null when it holds none. */
  #lease: string | null = null;

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
  bind(databasePath: string, mainFd: number, dirFd: number): string {
    // The whole path, not its file name. Two databases in different directories can share a name,
    // and a binding keyed on the name alone would hand one connection the other's descriptor —
    // the same defect this exists to end, just at a shorter length.
    //
    // Returns the lease that must be presented to release it: sixteen bytes of kernel entropy as
    // hex, not a counter. Taking a second binding while one is held is refused rather than
    // silently replacing it, because a replacement leaves the first caller still holding a
    // descriptor it believes is bound while every open goes somewhere else.
    const row = this.#db
      .prepare("SELECT acp_fd_bind(?, ?, ?) AS lease")
      .get(databasePath, mainFd, dirFd) as { lease: string };
    this.#lease = row.lease;
    return this.#lease;
  }

  /**
   * Releases the binding this control holds. Safe to call when it holds none.
   *
   * The lease is dropped only after the native release reports success. Clearing it first meant a
   * refused release still mutated caller-visible state: the control would believe it had let go
   * while the process was still bound, and the binding could then be released by nobody.
   */
  unbind(): void {
    if (this.#lease === null) return;
    const released = this.#db.prepare("SELECT acp_fd_unbind(?) AS released").get(this.#lease) as {
      released: number;
    };
    if (released.released === 1 || released.released === 0) this.#lease = null;
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
 * non-empty `-wal`/`-shm` beside it; `migrateApprovedCopy` does exactly that before it binds.
 */
export const withBoundDescriptor = <T>(
  control: FdVfsControl,
  databasePath: string,
  work: (fd: number) => T,
): T => {
  const fd = openSync(databasePath, "r+");
  const dirFd = openSync(dirname(databasePath), "r");
  let failed = false;
  try {
    control.bind(databasePath, fd, dirFd);
    return work(fd);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    /*
     * A release that fails must not replace the reason the work failed.
     *
     * The release refuses while any file of the binding is still open, and work that throws
     * part-way through opening one leaves exactly that state — so the caller would have been told
     * "a file of this binding is still open" instead of what actually went wrong, which is the
     * error that matters and the only one they can act on. When the work succeeded there is
     * nothing to hide behind, and a failed release is itself the news.
     */
    try {
      control.unbind();
    } catch (releaseError) {
      if (!failed) throw releaseError;
    }
    closeSync(dirFd);
    closeSync(fd);
  }
};


/**
 * The bounded rollback filesystem primitive.
 *
 * A rollback verifies a destination and then mutates it, and a pathname can be made to mean
 * something else in between: renaming a parent directory, or replacing a component with a symlink,
 * steers the second walk somewhere the first never saw. Node's standard library cannot close that
 * — it exposes no `*at` family, only `O_NOFOLLOW`, and `fs.constants` carries no `RENAME_EXCL` —
 * so the anchor has to come from the extension, where a held directory descriptor can be the
 * subject of every later operation.
 *
 * This surface is deliberately five operations wide. There is no read, no write, no create-file,
 * no chmod and no traversal: names are single components. It is what an exclusive publication and
 * an ownership-bound cleanup need, and nothing a caller could build a general filesystem out of.
 */
export interface RollbackEntry {
  type: "dir" | "file" | "symlink" | "other";
  mode: number;
  dev: number;
  ino: number;
  nlink: number;
  size: number;
}

export interface RollbackParent {
  handle: number;
  dev: number;
  ino: number;
}

const field = (line: string, name: string): string =>
  new RegExp(`(?:^| )${name}=([^ ]*)`).exec(line)?.[1] ?? "";

/** Every native result is either a value line or `error=WHAT errno=N`; neither is ever guessed. */
const refuse = (operation: string, line: string, detail: Record<string, unknown>): never => {
  throw acpError(ReasonCode.STATE_PATH_INSECURE, `the rollback filesystem refused ${operation}`, {
    ...detail,
    reason: field(line, "error"),
    errno: Number(field(line, "errno")),
  });
};

export class RollbackFilesystem {
  readonly #db: InstanceType<typeof Database>;
  readonly #open = new Set<number>();

  private constructor(db: InstanceType<typeof Database>) {
    this.#db = db;
  }

  static load(): RollbackFilesystem {
    const db = new Database(":memory:");
    try {
      db.loadExtension(EXTENSION_PATH);
    } catch (error) {
      db.close();
      throw acpError(ReasonCode.INTERNAL_ERROR, "the fd-vfs extension could not be loaded", {
        path: EXTENSION_PATH,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return new RollbackFilesystem(db);
  }

  /**
   * Holds a parent directory open, no-follow, and remembers its identity.
   *
   * Everything after this is relative to the descriptor rather than to the path, so renaming the
   * directory afterwards moves the name and not the object being worked on.
   */
  openParent(path: string): RollbackParent {
    const line = String(
      (this.#db.prepare("SELECT acp_rb_open(?) AS r").get(path) as { r: string }).r,
    );
    if (line.startsWith("error=")) refuse("opening a parent directory", line, { path });
    const parent = {
      handle: Number(field(line, "handle")),
      dev: Number(field(line, "dev")),
      ino: Number(field(line, "ino")),
    };
    this.#open.add(parent.handle);
    return parent;
  }

  /** `fstatat(AT_SYMLINK_NOFOLLOW)` under the held parent. `null` when the entry is not there. */
  stat(parent: RollbackParent, name: string): RollbackEntry | null {
    const line = String(
      (this.#db.prepare("SELECT acp_rb_stat(?, ?) AS r").get(parent.handle, name) as { r: string }).r,
    );
    if (line.startsWith("error=")) {
      if (field(line, "error") === "STAT") return null;
      refuse("inspecting an entry", line, { name });
    }
    const type = field(line, "type");
    return {
      type: type === "dir" || type === "file" || type === "symlink" ? type : "other",
      mode: Number.parseInt(field(line, "mode"), 8),
      dev: Number(field(line, "dev")),
      ino: Number(field(line, "ino")),
      nlink: Number(field(line, "nlink")),
      size: Number(field(line, "size")),
    };
  }

  /**
   * `renameatx_np(..., RENAME_EXCL)`: commit the name only if nothing already holds it.
   *
   * The check and the use are one syscall, so a foreign directory that appears under the final
   * name between them is an `EEXIST` rather than something this overwrites.
   */
  renameExclusive(from: RollbackParent, fromName: string, to: RollbackParent, toName: string): void {
    const line = String(
      (
        this.#db
          .prepare("SELECT acp_rb_rename_excl(?, ?, ?, ?) AS r")
          .get(from.handle, fromName, to.handle, toName) as { r: string }
      ).r,
    );
    if (line !== "ok") refuse("publishing a name exclusively", line, { fromName, toName });
  }

  /**
   * Removes an entry under the held parent, and only while it is still the exact object named.
   *
   * Cleanup keyed on a pathname removes whatever is at that name when it runs, which after a
   * foreign replacement is somebody else's tree. Binding it to `(dev, ino)` makes the object the
   * authority, so a swapped stage is refused rather than deleted on the owner's behalf.
   */
  removeOwned(parent: RollbackParent, name: string, dev: number, ino: number): void {
    const line = String(
      (
        this.#db
          .prepare("SELECT acp_rb_remove_owned(?, ?, ?, ?) AS r")
          .get(parent.handle, name, dev, ino) as { r: string }
      ).r,
    );
    if (line !== "ok") refuse("removing an owned entry", line, { name, dev, ino });
  }

  closeParent(parent: RollbackParent): void {
    this.#db.prepare("SELECT acp_rb_close(?) AS r").get(parent.handle);
    this.#open.delete(parent.handle);
  }

  /**
   * Releases every handle and the connection.
   *
   * A cleanup failure must not replace the reason the work failed — the same lesson
   * `withBoundDescriptor` records above. Callers reach this from a `finally`, so a throw here
   * would hide the error that actually matters and is the only one they can act on.
   */
  dispose(): void {
    for (const handle of [...this.#open]) {
      try {
        this.#db.prepare("SELECT acp_rb_close(?) AS r").get(handle);
      } catch {
        /* The descriptor goes with the connection below; nothing here is worth masking with. */
      }
    }
    this.#open.clear();
    this.#db.close();
  }
}
