import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";

import { type Decision, allow, deny } from "../core/errors.ts";
import { readProcessStartToken } from "../core/process-argv.ts";
import { ReasonCode } from "../core/reason-codes.ts";

/** A process group a stopped daemon could not confirm empty: its id and its leader's OS start time. */
export interface FencedGroup {
  pgid: number;
  leaderStartedAt: string | null;
}

export interface LockInfo {
  pid: number;
  startedAt: string;
  path: string;
  /** The holder's OS start token, so a reused pid is not taken for it; absent in earlier builds' records. */
  startToken?: string | null;
}

/**
 * PRD §33.1 / §34.5 — exactly one `agentcpd` may hold authoritative state.
 *
 * #1070 ACP-WORKER-03-LOCK (narrow review 5): the lock is an open exclusive SQLite transaction on a
 * dedicated database beside the holder record, `<lock>.db`, held by one connection for the holder's
 * lifetime. The operating system answers who holds it: a second process's `BEGIN EXCLUSIVE` is
 * SQLITE_BUSY until the holder's connection closes or the holder exits, by any means, SIGKILL
 * included. Nothing is reclaimed by unlinking a path, which let two reclaimers each delete the
 * other's lock and both hold it. The lock file itself is never deleted or replaced by this code.
 *
 * `<lock>` is no longer the authority. It is the holder record — pid, start, OS start token —
 * written only by the process holding the lock, for observability and for the transition from
 * earlier builds, whose lock that path was: a record naming a running process refuses. That also
 * covers a lock file deleted or replaced while held, where the next process would lock a new file.
 *
 * The lock is POSIX advisory record locking, so it belongs to the process, and closing any other
 * descriptor this process holds on `<lock>.db` releases it. Nothing in the holder may open that
 * file except this connection; SQLite's own second connections are safe (it defers their close).
 * The connection must stay referenced: better-sqlite3 closes an unreferenced one when it is
 * garbage-collected, which would end the lock. It is held by this object for as long as it holds.
 *
 * Moving from an earlier build: stop the old daemon (the launchd job's bootout), wait until
 * `<lock>` is gone (`install-launchd.sh`'s `wait_for_stop` already does), then start the new one.
 * An old daemon does not know this lock, so the two must never start together; a new daemon
 * refuses while an old one's record names a running process, and an old one refuses while a new
 * one's record names its running holder.
 */
export class SingleInstanceLock {
  /** The dedicated connection whose open exclusive transaction is the lock. */
  #db: Database.Database | null = null;
  /** What this instance actually wrote, so release only ever removes its own record. */
  #held: LockInfo | null = null;

  constructor(private readonly path: string) {}

  /**
   * #1070 ACP-WORKER-03-FC — the durable half of a stopping daemon's fence. Written beside the lock
   * when the daemon could not confirm every worker git process group empty, it outlives the daemon's
   * process: no lock is acquired, live holder or stale, while any group it names may still mutate a
   * repository. `null` names none — a stop that could not even say which — and fences until removed.
   *
   * Narrow review 4: every write is its own file, `<lock>.git-fence.<pid>.<start token>.<random>.json`,
   * linked into place without replacing anything, so a name is written once and a replacement fence is
   * always another name. `fencePath` (`<lock>.git-fence.json`) is only a second link to the newest of
   * them, where operators and tooling look; a file an earlier build wrote there is read as a fence too.
   */
  get fencePath(): string {
    return `${this.path}.git-fence.json`;
  }

  /** The database whose exclusive lock is the single-instance lock. Never deleted or replaced. */
  get lockDatabasePath(): string {
    return `${this.path}.db`;
  }

  fence(groups: readonly FencedGroup[] | null, recordedAt: string): void {
    const directory = dirname(this.path);
    const lockName = basename(this.path);
    mkdirSync(directory, { recursive: true });
    const token = (readProcessStartToken(process.pid) ?? "unknown").replace(/[^A-Za-z0-9_-]/gu, "-");
    const unique = join(directory, `${lockName}${FENCE_INFIX}${process.pid}.${token}.${randomUUID()}.json`);
    const temporary = join(directory, `.${lockName}${FENCE_INFIX}${process.pid}.${randomUUID()}.tmp`);
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeSync(fd, JSON.stringify({ pid: process.pid, recordedAt, groups }));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(temporary, unique);
    } finally {
      try {
        unlinkSync(temporary);
      } catch {
        /* the fence is the unique name; the temporary is not read */
      }
    }
    // The legacy name becomes a second link to this file. A file already there that is no other
    // fence's link is first given a unique name of its own, so replacing the name loses no fence. Any
    // failure leaves the legacy name as it was: the unique file is the fence.
    const mirror = join(directory, `.${lockName}${FENCE_INFIX}${process.pid}.${randomUUID()}.link.tmp`);
    try {
      let replaceable = true;
      try {
        if (lstatSync(this.fencePath).nlink === 1) {
          linkSync(this.fencePath, join(directory, `${lockName}${FENCE_INFIX}adopted.${randomUUID()}.json`));
        }
      } catch (error) {
        if ((error as { code?: string }).code !== "ENOENT") replaceable = false;
      }
      if (replaceable) {
        linkSync(unique, mirror);
        renameSync(mirror, this.fencePath);
      }
    } catch {
      /* the legacy name is a view; the unique file already fences */
    } finally {
      try {
        unlinkSync(mirror);
      } catch {
        /* renamed into place, or never made */
      }
    }
  }

  /**
   * Every fence file beside this lock that still stands, together (see `assessFences`). Only ever
   * reads: a fence whose groups are all gone answers null here and stays on disk. Fence files are
   * removed only by `acquire()`, under the lock it has just installed.
   */
  liveFence(): LiveFence | null {
    return assessFences(this.path).standing;
  }

  acquire(startedAt: string): Decision<LockInfo> {
    mkdirSync(dirname(this.path), { recursive: true });
    if (this.#db !== null) {
      return deny(ReasonCode.DAEMON_ALREADY_RUNNING, "this lock is already held", { path: this.path });
    }

    // An early, read-only refusal; the same question is asked again under the lock below.
    const fenced = this.liveFence();
    if (fenced) {
      return deny(
        ReasonCode.DAEMON_ALREADY_RUNNING,
        "a stopped agentcpd could not confirm a worker git process group finished; authority is not taken while it may still run",
        { fence: this.fencePath, groups: fenced.groups, alive: fenced.alive },
      );
    }

    const taken = takeExclusive(this.lockDatabasePath);
    if (!taken.ok) {
      return deny(
        ReasonCode.DAEMON_ALREADY_RUNNING,
        taken.busy ? "another agentcpd instance holds the lock" : "the single-instance lock could not be taken",
        { lock: this.lockDatabasePath, sqlite: taken.code, holder: this.read() },
      );
    }
    // From here this process holds the lock, and only from here is anything else touched.
    this.#db = taken.db;
    const refuse = (reasonCode: ReasonCode, message: string, evidence: Record<string, unknown>): Decision<LockInfo> => {
      this.release();
      return deny(reasonCode, message, evidence);
    };
    if (!sameFile(this.lockDatabasePath, taken.identity)) {
      return refuse(ReasonCode.DAEMON_LOCK_LOST, "the lock file at its path is not the file this process locked", {
        lock: this.lockDatabasePath,
      });
    }

    // A record naming a running process: an earlier build's daemon holding the pathname lock, or a
    // holder whose lock file was deleted or replaced. Either way another daemon runs; this one refuses.
    const existing = this.read();
    if (existing && holderRunning(existing)) {
      return refuse(ReasonCode.DAEMON_ALREADY_RUNNING, "another agentcpd instance holds the lock", { holder: existing });
    }
    if (!existing && existsSync(this.path)) {
      // An earlier build wrote its record in place and could leave it truncated for an instant.
      const ageMs = Date.now() - lstatSync(this.path).mtimeMs;
      if (ageMs < MALFORMED_LOCK_GRACE_MS) {
        return refuse(ReasonCode.DAEMON_LOCK_LOST, "lock record is incomplete; waiting for its writer", {
          path: this.path,
          retryAfterMs: MALFORMED_LOCK_GRACE_MS - ageMs,
        });
      }
    }

    const info: LockInfo = { pid: process.pid, startedAt, path: this.path, startToken: readProcessStartToken(process.pid) };
    // ACP-WORKER-03-FC — asked again now that this lock is installed, and before authority is granted.
    // A predecessor writes its fence before it exits and keeps its lock until then, so this install
    // followed a reclamation that saw it dead and any fence it wrote is in place by now, however the
    // two interleaved. Read directly, never through the overridable lookup, so no subclass can answer
    // it from a stale read.
    //
    // This is the only place fence files are removed (narrow review 4), and only these: a unique file
    // whose every group this read confirmed gone, and the legacy name when it is a link to such a file.
    // A unique name is never written twice, so a fence written after this read is another name and
    // cannot be removed here; and removing the legacy name only drops a second link. Anything this read
    // cannot establish refuses, and a removal that fails refuses too.
    const underLock = assessFences(this.path);
    if (underLock.standing) {
      return refuse(
        ReasonCode.DAEMON_ALREADY_RUNNING,
        "a stopped agentcpd could not confirm a worker git process group finished; authority is not taken while it may still run",
        { fence: this.fencePath, groups: underLock.standing.groups, alive: underLock.standing.alive, files: underLock.standing.files, afterInstall: true },
      );
    }
    for (const stale of underLock.stale) {
      try {
        unlinkSync(stale);
      } catch (error) {
        if ((error as { code?: string }).code === "ENOENT") continue;
        return refuse(
          ReasonCode.DAEMON_ALREADY_RUNNING,
          "a git fence whose groups have ended could not be removed; authority is not taken",
          { fence: stale, afterInstall: true },
        );
      }
    }

    // The holder record, replaced under the lock: only the holder writes it.
    try {
      writeRecord(this.path, info);
    } catch (error) {
      return refuse(ReasonCode.DAEMON_LOCK_LOST, "the holder record could not be written", {
        path: this.path,
        error: (error as Error).message,
      });
    }
    this.#held = info;
    // Asked again after every write: a lock file replaced meanwhile means another process may lock it.
    if (!sameFile(this.lockDatabasePath, taken.identity)) {
      return refuse(ReasonCode.DAEMON_LOCK_LOST, "the lock file at its path is not the file this process locked", {
        lock: this.lockDatabasePath,
      });
    }
    return allow(ReasonCode.OK, info);
  }

  read(): LockInfo | null {
    if (!existsSync(this.path)) return null;
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as LockInfo;
      return (
        typeof parsed.pid === "number" &&
        Number.isInteger(parsed.pid) &&
        parsed.pid > 0 &&
        typeof parsed.startedAt === "string" &&
        typeof parsed.path === "string" &&
        (parsed.startToken === undefined || parsed.startToken === null || typeof parsed.startToken === "string")
      )
        ? parsed
        : null;
    } catch {
      return null;
    }
  }

  held(): boolean {
    return this.#db !== null;
  }

  /** Removes this holder's own record while still holding the lock, then ends the lock. */
  release(): void {
    if (this.#db === null) return;
    try {
      const current = this.read();
      if (
        this.#held &&
        current?.pid === this.#held.pid &&
        current.startedAt === this.#held.startedAt &&
        (current.startToken ?? null) === (this.#held.startToken ?? null)
      ) {
        unlinkSync(this.path);
      }
    } catch {
      /* best effort on shutdown */
    }
    this.#held = null;
    const db = this.#db;
    this.#db = null;
    try {
      if (db.inTransaction) db.exec("ROLLBACK");
    } catch {
      /* closing ends the transaction regardless */
    }
    try {
      db.close();
    } catch {
      /* the process exiting releases it in any case */
    }
  }
}

const FENCE_INFIX = ".git-fence.";

interface LiveFence {
  /** The groups the standing fences name; null when any of them names none or cannot be read. */
  groups: FencedGroup[] | null;
  alive: FencedGroup[];
  /** The fence files that stand. */
  files: string[];
}

/** A fence file as read: which file it is and the groups it names (null: an unknown fence). */
interface FenceRead {
  ino: number | null;
  groups: FencedGroup[] | null;
}

/**
 * Reads one fence file, or null when it is not there. Never removes anything. A file that exists but
 * cannot be opened, read or parsed reads as an unknown fence (`groups: null`), which stands.
 */
const readFence = (path: string): FenceRead | null => {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return null;
    return { ino: null, groups: null };
  }
  let ino: number;
  let text: string;
  try {
    ino = fstatSync(fd).ino;
    text = readFileSync(fd, "utf8");
  } catch {
    return { ino: null, groups: null };
  } finally {
    closeSync(fd);
  }
  let groups: FencedGroup[] | null;
  try {
    const parsed = JSON.parse(text) as { groups?: unknown };
    groups = Array.isArray(parsed.groups)
      ? parsed.groups.filter((group): group is FencedGroup =>
        typeof group === "object" && group !== null &&
        Number.isSafeInteger((group as FencedGroup).pgid) && (group as FencedGroup).pgid > 0 &&
        ((group as FencedGroup).leaderStartedAt === null || typeof (group as FencedGroup).leaderStartedAt === "string"))
      : null;
    if (Array.isArray(parsed.groups) && groups !== null && groups.length !== parsed.groups.length) groups = null;
  } catch {
    groups = null;
  }
  return { ino, groups };
};

/**
 * Every fence file beside `lockPath`: the unique ones, adopted ones, and the legacy name. A fence
 * stands while any group it names may be alive. A group is alive while `kill(-pgid, 0)` finds members
 * (EPERM included), unless a process now holding the group's id started at another time than the
 * recorded leader — a pid is reused only once its group is empty, so that group is gone. A fence that
 * names no group (`null`, an empty list) or cannot be read stands, as an unknown one
 * (ACP-WORKER-03-FC-EMPTY), and so does a directory that cannot be listed.
 *
 * `stale` lists what may be removed under the lock, and nothing else: each unique file whose every
 * group is confirmed gone, and the legacy name when it is a link to one of them. A legacy file that is
 * no unique file's link (an earlier build's) is read like any fence but never listed: its name may be
 * written again, so a confirmation read here may not be about the file a removal would reach.
 */
const assessFences = (lockPath: string): { standing: LiveFence | null; stale: string[] } => {
  const directory = dirname(lockPath);
  const prefix = `${basename(lockPath)}${FENCE_INFIX}`;
  const legacy = `${lockPath}.git-fence.json`;
  let names: string[];
  try {
    names = readdirSync(directory).filter((name) => name.startsWith(prefix) && name.endsWith(".json")).sort();
  } catch {
    return { standing: { groups: null, alive: [], files: [directory] }, stale: [] };
  }
  const judged = new Map<number, LiveFence | null>();
  const standingFiles: { path: string; ino: number | null; fence: LiveFence }[] = [];
  const staleUnique = new Map<number, string[]>();
  let staleLegacy: { path: string; ino: number } | null = null;
  for (const name of names) {
    const path = join(directory, name);
    const read = readFence(path);
    if (read === null) continue;
    let verdict: LiveFence | null;
    if (read.groups === null || read.groups.length === 0) {
      verdict = { groups: null, alive: [], files: [path] };
    } else if (read.ino !== null && judged.has(read.ino)) {
      verdict = judged.get(read.ino)!;
    } else {
      const groups = read.groups;
      const alive = groups.filter((group) => fencedGroupAlive(group));
      verdict = alive.length > 0 ? { groups, alive, files: [path] } : null;
      if (read.ino !== null) judged.set(read.ino, verdict);
    }
    if (verdict !== null) {
      standingFiles.push({ path, ino: read.ino, fence: verdict });
      continue;
    }
    if (read.ino === null) continue;
    if (path === legacy) {
      staleLegacy = { path, ino: read.ino };
    } else {
      staleUnique.set(read.ino, [...(staleUnique.get(read.ino) ?? []), path]);
    }
  }
  const stale = [...staleUnique.values()].flat();
  if (staleLegacy !== null && staleUnique.has(staleLegacy.ino)) stale.push(staleLegacy.path);
  if (standingFiles.length === 0) return { standing: null, stale };
  // One fence per file, not per name: the legacy name may be a second link to a unique file.
  const seen = new Set<number>();
  const fences = standingFiles.filter(({ ino }) => ino === null || (!seen.has(ino) && seen.add(ino) !== undefined));
  const unknown = fences.some(({ fence }) => fence.groups === null);
  return {
    standing: {
      groups: unknown ? null : fences.flatMap(({ fence }) => fence.groups ?? []),
      alive: fences.flatMap(({ fence }) => fence.alive),
      files: standingFiles.map(({ path }) => path),
    },
    stale,
  };
};

const fencedGroupAlive = (group: FencedGroup): boolean => {
  try {
    process.kill(-group.pgid, 0);
  } catch (error) {
    if ((error as { code?: string }).code !== "EPERM") return false;
  }
  const holder = readProcessStartToken(group.pgid);
  return !(holder !== null && group.leaderStartedAt !== null && holder !== group.leaderStartedAt);
};

const isAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const MALFORMED_LOCK_GRACE_MS = 5_000;

/** A file's identity: the device and inode a path named when it was looked at. */
interface FileIdentity {
  dev: number;
  ino: number;
}

const identityOf = (path: string): FileIdentity | null => {
  try {
    const stat = lstatSync(path);
    return stat.isFile() ? { dev: stat.dev, ino: stat.ino } : null;
  } catch {
    return null;
  }
};

const sameFile = (path: string, identity: FileIdentity): boolean => {
  const now = identityOf(path);
  return now !== null && now.dev === identity.dev && now.ino === identity.ino;
};

/**
 * Whether this process has a descriptor open on `identity`. The connection's descriptor is not
 * exposed, and opening the file here to compare would release the lock, so the process's own
 * descriptor table is read instead; each entry is only `fstat`ed, never opened or closed.
 */
const processHasOpen = (identity: FileIdentity): boolean => {
  for (const table of ["/dev/fd", "/proc/self/fd"]) {
    let entries: string[];
    try {
      entries = readdirSync(table);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!/^\d+$/u.test(entry)) continue;
      try {
        const stat = fstatSync(Number(entry));
        if (stat.dev === identity.dev && stat.ino === identity.ino) return true;
      } catch {
        /* a descriptor closed meanwhile, such as the one that listed the table */
      }
    }
    return false;
  }
  return false;
};

type Taken =
  | { ok: true; db: Database.Database; identity: FileIdentity }
  | { ok: false; busy: boolean; code: string };

/**
 * Opens the lock database and takes its exclusive lock, or answers who has it. `timeout: 0` makes a
 * held lock an immediate SQLITE_BUSY. `BEGIN EXCLUSIVE` in rollback-journal mode takes the
 * operating-system lock before it returns, so the lock counts as taken only once that statement has
 * succeeded and the connection reports the transaction open. The lock lasts exactly as long as that
 * transaction: nothing is ever written, so `locking_mode = EXCLUSIVE` does not keep it once the
 * transaction ends (measured: a ROLLBACK alone releases it), and only `release()` ends it. The file
 * locked is then tied to the path: the path's identity must be one this process has open.
 */
const takeExclusive = (path: string): Taken => {
  let db: Database.Database | undefined;
  const close = (): void => {
    try {
      db?.close();
    } catch {
      /* nothing more to release */
    }
  };
  // Private like the rest of the state directory. Created here only if absent: closing a descriptor
  // on a file that did not exist cannot release a lock this process holds on another file.
  try {
    closeSync(openSync(path, "wx", 0o600));
  } catch {
    /* it exists; it is never opened here otherwise */
  }
  try {
    db = new Database(path, { timeout: 0 });
    db.pragma("locking_mode = EXCLUSIVE");
    db.exec("BEGIN EXCLUSIVE");
  } catch (error) {
    close();
    const code = (error as { code?: string }).code ?? "UNKNOWN";
    return { ok: false, busy: code === "SQLITE_BUSY" || code === "SQLITE_LOCKED", code };
  }
  if (!db.inTransaction || String(db.pragma("journal_mode", { simple: true })).toLowerCase() === "wal") {
    close();
    return { ok: false, busy: false, code: "NOT_EXCLUSIVE" };
  }
  const identity = identityOf(path);
  if (identity === null || !processHasOpen(identity)) {
    close();
    return { ok: false, busy: false, code: "LOCK_FILE_CHANGED" };
  }
  return { ok: true, db, identity };
};

/**
 * Whether the process a holder record names is running and is that holder. With a start token, the
 * token must match (an unreadable one counts as a match). An earlier build's record has none, and its
 * `startedAt` is a clock reading, not the process's start: its holder counts as running while the pid
 * answers, so a pid reused since costs a refusal until the record is removed, never a second holder.
 */
const holderRunning = (holder: LockInfo): boolean => {
  if (!isAlive(holder.pid)) return false;
  if (!holder.startToken) return true;
  const current = readProcessStartToken(holder.pid);
  return current === null || current === holder.startToken;
};

/** The holder record, written whole and renamed into place. */
const writeRecord = (path: string, info: LockInfo): void => {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeSync(fd, JSON.stringify(info));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      /* best effort */
    }
    throw error;
  }
};
