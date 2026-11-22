import Database from "better-sqlite3";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A read of a database that does not touch it.
 *
 * A read-only connection to the file itself is not read-only to its neighbours: on a WAL database it
 * creates `-shm` and a zero-length `-wal` beside it, and a later offline step that requires a database with
 * nothing uncheckpointed then refuses what a read left behind. So the read is made on a private copy: the
 * main file, and the write-ahead log or hot journal when one holds anything, copied into a directory only
 * this process can enter, and opened there. The originals are read by the copy and nowhere else, and never
 * opened.
 *
 * The copy is a point-in-time image of files nobody is writing: the callers hold `agentcpd.lock`, or run
 * with the daemon stopped. It is removed when `read` returns.
 */
export class DatabaseSnapshotUnavailable extends Error {
  constructor(readonly databasePath: string, cause: unknown) {
    super(
      `a private copy of ${databasePath} could not be made or opened, so it was not read: ` +
        (cause instanceof Error ? cause.message : String(cause)),
    );
    this.name = "DatabaseSnapshotUnavailable";
  }
}

export const withDatabaseSnapshot = <T>(databasePath: string, read: (copy: Database.Database) => T): T => {
  let directory: string | null = null;
  let copy: Database.Database | null = null;
  try {
    directory = mkdtempSync(join(tmpdir(), "acp-db-snapshot-"));
    chmodSync(directory, 0o700);
    const target = join(directory, "snapshot.sqlite");
    copyFileSync(databasePath, target);
    chmodSync(target, 0o600);
    for (const suffix of ["-wal", "-journal"]) {
      const sidecar = `${databasePath}${suffix}`;
      if (existsSync(sidecar) && statSync(sidecar).size > 0) {
        copyFileSync(sidecar, `${target}${suffix}`);
        chmodSync(`${target}${suffix}`, 0o600);
      }
    }
    // Opened read-write, in a directory that is only the copy's: SQLite rolls a hot journal back and
    // replays a write-ahead log only on a connection that may write, and a hot journal is what a daemon
    // killed mid-transaction leaves. The recovery lands in the copy. The originals are not open at all, so
    // the real open still finds them exactly as they were and recovers them as it always did. Reads from
    // here on are held to reads.
    copy = new Database(target, { fileMustExist: true });
    // Forces recovery now, so a copy that cannot be read fails here and not mid-query.
    copy.pragma("schema_version", { simple: true });
    copy.pragma("query_only = ON");
  } catch (error) {
    try {
      copy?.close();
    } catch {
      /* closing a copy that never opened */
    }
    if (directory !== null) rmSync(directory, { recursive: true, force: true });
    throw new DatabaseSnapshotUnavailable(databasePath, error);
  }
  try {
    return read(copy);
  } finally {
    try {
      copy.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
};
