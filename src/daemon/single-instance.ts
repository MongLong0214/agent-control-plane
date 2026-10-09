import {
  closeSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
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
 * `<lock>` is no longer the authority. It is the holder's directory, holding its record
 * `<lock>/holder.json` — pid, start, OS start token — written only by the process holding the lock,
 * for observability and for the transition from earlier builds, whose lock that path was: a record
 * naming a running process refuses. That also covers a lock file deleted or replaced while held,
 * where the next process would lock a new file.
 *
 * The lock is POSIX advisory record locking, so it belongs to the process, and closing any other
 * descriptor this process holds on `<lock>.db` releases it. Nothing in the holder may open that
 * file except this connection; SQLite's own second connections are safe (it defers their close).
 * The connection must stay referenced: better-sqlite3 closes an unreferenced one when it is
 * garbage-collected, which would end the lock. It is held by this object for as long as it holds.
 *
 * Earlier builds (narrow reviews 6 and 7). An earlier build's lock is the pathname `<lock>` alone, a
 * regular file: it reclaims one naming a dead process, or an unreadable one five seconds after its
 * modification time, by unlinking the path without checking what it removes, then links its own
 * record into place; it does not know `<lock>.db`. So `<lock>` is where the two schemes meet, and
 * they are kept apart by what each can do to the other's object there:
 *
 *   - This build holds `<lock>` as a directory. `unlink` cannot remove a directory (EPERM on Darwin,
 *     EISDIR on Linux) and `link` cannot replace one (EEXIST), so every earlier build refuses while
 *     it stands, live holder or dead, whatever its timestamps say: nothing it reads decides that.
 *   - An empty path is claimed by `mkdir`, which fails if anything got there first, and an earlier
 *     build's `link` fails once the directory exists: whichever is first holds, the other refuses.
 *   - Only this build's own directory is reclaimed, under the lock, after checking it is still the
 *     directory judged dead; its record is replaced inside it. An earlier build's record, or any
 *     file this build cannot read as its own, is never removed or replaced, whether its process runs
 *     or not: this build refuses until it is gone. Stop every earlier-build agentcpd first and let
 *     it remove its own record (`install-launchd.sh` waits until `<lock>` is gone before it
 *     promotes a build); a record whose process died without removing it is removed by hand, only
 *     once no earlier-build agentcpd or agentcpd-state is running.
 *
 * A clean release removes the record and then the directory, leaving the path empty, which is what
 * `install-launchd.sh` waits for (`[[ ! -e <lock> ]]`), and what an earlier build restored by a
 * rollback starts from. A holder killed before it released leaves the directory, which keeps both
 * earlier builds and `wait_for_stop` out until the next holder of this build reclaims it.
 *
 * Rejected: reclaiming a dead earlier-build record carefully (reading it again, moving it aside and
 * checking what moved), because an earlier reclaimer that read it dead unlinks whatever regular file
 * is at the path afterwards.
 * Rejected (narrow review 7): a regular-file record earlier builds read as incomplete, its time pinned
 * in the future, because `touch`, or a copy that does not keep times, hands it back to their
 * five-second reclaim while this build still holds.
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

  /**
   * Writes a fence, under the lock (narrow review 5): the holder writes directly; any other caller
   * takes the lock for the write and gives it back, and cannot while another process holds it.
   */
  fence(groups: readonly FencedGroup[] | null, recordedAt: string): void {
    if (this.#db !== null) {
      writeFence(this.path, groups, recordedAt);
      return;
    }
    mkdirSync(dirname(this.path), { recursive: true });
    const taken = takeExclusive(this.lockDatabasePath);
    if (!taken.ok) throw new Error(`a git fence is written only by the holder of the lock (${taken.code})`);
    try {
      writeFence(this.path, groups, recordedAt);
    } finally {
      try {
        if (taken.db.inTransaction) taken.db.exec("ROLLBACK");
      } catch {
        /* closing ends it regardless */
      }
      taken.db.close();
    }
  }

  /**
   * Every fence file beside this lock that still stands, together (see `assessFences`). Only ever
   * reads: it adopts nothing, and a fence whose groups are all gone answers null here and stays on
   * disk. Fence files are adopted and removed only by `acquire()`, under the lock.
   */
  liveFence(): LiveFence | null {
    return assessFences(this.path, false).standing;
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
    // What stands at the path decides how this holder takes it (narrow reviews 6 and 7): an empty
    // path by `mkdir`, this build's own dead holder's directory by writing the record inside it, and
    // nothing an earlier build may be reclaiming at this moment.
    const standing = standingAt(this.path);
    let claim: { reuse: FileIdentity } | "create";
    if ((standing.kind === "ours" || standing.kind === "earlier") && standing.info !== null && holderRunning(standing.info)) {
      return refuse(ReasonCode.DAEMON_ALREADY_RUNNING, "another agentcpd instance holds the lock", { holder: standing.info });
    }
    if (standing.kind === "absent") {
      claim = "create";
    } else if (standing.kind === "ours" && !standing.unreadable) {
      claim = { reuse: standing.identity };
    } else if (standing.kind !== "other" && standing.unreadable && standing.ageMs < MALFORMED_LOCK_GRACE_MS) {
      // An earlier build wrote its record in place and could leave it truncated for an instant.
      return refuse(ReasonCode.DAEMON_LOCK_LOST, "lock record is incomplete; waiting for its writer", {
        path: this.path,
        retryAfterMs: MALFORMED_LOCK_GRACE_MS - standing.ageMs,
      });
    } else {
      // An earlier build's record whose process is gone, or anything this build cannot read as its
      // own: an earlier build may be reclaiming a file at this path right now.
      return refuse(
        ReasonCode.DAEMON_ALREADY_RUNNING,
        standing.kind === "earlier" && standing.info !== null
          ? "an earlier build's lock record names a process that is not running. An earlier build reclaims such a record by " +
            "unlinking the path without checking what it removes, so this build never removes or replaces it: stop every " +
            "earlier-build agentcpd and agentcpd-state, then remove the record"
          : "the lock path holds something this build cannot read as its own holder, which it does not remove or " +
            "replace: stop every earlier-build agentcpd and agentcpd-state, then remove it",
        { path: this.path, standing: standing.kind, holder: standing.kind === "other" ? null : standing.info },
      );
    }

    const info: LockInfo = { pid: process.pid, startedAt, path: this.path, startToken: readProcessStartToken(process.pid) };
    // ACP-WORKER-03-FC — asked again now that this lock is installed, and before authority is granted.
    // A predecessor writes its fence before it exits and keeps its lock until then, so this install
    // followed a reclamation that saw it dead and any fence it wrote is in place by now, however the
    // two interleaved. Read directly, never through the overridable lookup, so no subclass can answer
    // it from a stale read.
    //
    // This is the only place fence files are adopted or removed, and only while the lock is held, so
    // no other process writes one meanwhile (narrow review 5). Removed are only: a unique file whose
    // every group this read confirmed gone, and the legacy name when it is a link to such a file, each
    // only while the path still names that file. A unique name is never written twice, so a fence
    // written after this read is another name. Anything this read cannot establish refuses, a removal
    // that fails refuses, and the fences are judged once more after the removal.
    const underLock = assessFences(this.path, true);
    if (underLock.standing) {
      return refuse(
        ReasonCode.DAEMON_ALREADY_RUNNING,
        "a stopped agentcpd could not confirm a worker git process group finished; authority is not taken while it may still run",
        { fence: this.fencePath, groups: underLock.standing.groups, alive: underLock.standing.alive, files: underLock.standing.files, afterInstall: true },
      );
    }
    for (const stale of underLock.stale) {
      if (!sameFile(stale.path, stale.identity)) continue;
      try {
        unlinkSync(stale.path);
      } catch (error) {
        if ((error as { code?: string }).code === "ENOENT") continue;
        return refuse(
          ReasonCode.DAEMON_ALREADY_RUNNING,
          "a git fence whose groups have ended could not be removed; authority is not taken",
          { fence: stale.path, afterInstall: true },
        );
      }
    }
    const cleared = assessFences(this.path, true);
    if (cleared.standing) {
      return refuse(
        ReasonCode.DAEMON_ALREADY_RUNNING,
        "a stopped agentcpd could not confirm a worker git process group finished; authority is not taken while it may still run",
        { fence: this.fencePath, groups: cleared.standing.groups, alive: cleared.standing.alive, files: cleared.standing.files, afterInstall: true },
      );
    }

    // The holder's directory: made on an empty path, or this build's own dead holder's, its record
    // replaced inside it; only a holder of this lock writes there. Never over an earlier build's record.
    try {
      installRecord(this.path, info, claim);
    } catch (error) {
      const code = (error as { code?: string }).code;
      return refuse(
        code === "EEXIST" || code === "ESTALE" ? ReasonCode.DAEMON_ALREADY_RUNNING : ReasonCode.DAEMON_LOCK_LOST,
        code === "EEXIST" || code === "ESTALE"
          ? "another agentcpd instance took the lock path first"
          : "the holder record could not be written",
        { path: this.path, error: (error as Error).message },
      );
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

  /**
   * The holder record: `<lock>/holder.json` when `<lock>` is this build's directory, or an earlier
   * build's record when `<lock>` is a regular file; null when there is none to read.
   */
  read(): LockInfo | null {
    let stat;
    try {
      stat = lstatSync(this.path);
    } catch {
      return null;
    }
    if (stat.isDirectory()) return parseRecord(join(this.path, HOLDER_RECORD));
    return stat.isFile() ? parseRecord(this.path) : null;
  }

  held(): boolean {
    return this.#db !== null;
  }

  /**
   * Removes this holder's own record and then its directory while still holding the lock, leaving
   * the path empty, then ends the lock. A directory something else was put into is left standing.
   */
  release(): void {
    if (this.#db === null) return;
    try {
      const current = this.read();
      if (
        this.#held &&
        lstatSync(this.path).isDirectory() &&
        current?.pid === this.#held.pid &&
        current.startedAt === this.#held.startedAt &&
        (current.startToken ?? null) === (this.#held.startToken ?? null)
      ) {
        unlinkSync(join(this.path, HOLDER_RECORD));
        rmdirSync(this.path);
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
 * Writes a fence as its own file, `<lock>.git-fence.<pid>.<start token>.<random>.json`, linked into
 * place without replacing anything. The legacy name `<lock>.git-fence.json` becomes a second link to
 * it only if nothing is there: it is never replaced. Whatever is there is adopted instead (see
 * `adoptLegacy`); if that cannot be done, the next acquisition finds the legacy file unestablished
 * and refuses. Called only under the lock.
 */
const writeFence = (lockPath: string, groups: readonly FencedGroup[] | null, recordedAt: string): void => {
  const directory = dirname(lockPath);
  const lockName = basename(lockPath);
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
  try {
    linkSync(unique, legacyFencePath(lockPath));
  } catch {
    adoptLegacy(lockPath);
  }
};

const legacyFencePath = (lockPath: string): string => `${lockPath}.git-fence.json`;

/** Every fence name beside `lockPath`: unique, adopted, and the legacy name. */
const fenceNames = (lockPath: string): string[] => {
  const prefix = `${basename(lockPath)}${FENCE_INFIX}`;
  return readdirSync(dirname(lockPath)).filter((name) => name.startsWith(prefix) && name.endsWith(".json")).sort();
};

/**
 * Whether the file at the legacy name is kept by a unique name: verified by another scanned unique
 * name linking the same file, or by adopting it under a new unique name (a hard link, checked to name
 * the same file afterwards). A link count proves nothing: the other link may be no fence at all.
 * Answers false when that cannot be established; the caller then refuses. Called only under the lock.
 */
const adoptLegacy = (lockPath: string): boolean => {
  const legacy = legacyFencePath(lockPath);
  let id: FileIdentity;
  try {
    const stat = lstatSync(legacy);
    if (!stat.isFile()) return false;
    id = { dev: stat.dev, ino: stat.ino };
  } catch (error) {
    return (error as { code?: string }).code === "ENOENT";
  }
  const directory = dirname(lockPath);
  let names: string[];
  try {
    names = fenceNames(lockPath);
  } catch {
    return false;
  }
  for (const name of names) {
    const path = join(directory, name);
    if (path !== legacy && sameFile(path, id)) return true;
  }
  const adopted = join(directory, `${basename(lockPath)}${FENCE_INFIX}adopted.${randomUUID()}.json`);
  try {
    linkSync(legacy, adopted);
  } catch {
    return false;
  }
  return sameFile(adopted, id);
};

/** A fence file that may be removed under the lock, and the file its path named when judged. */
interface StaleFence {
  path: string;
  identity: FileIdentity;
}

/**
 * Every fence file beside `lockPath`. A fence stands while any group it names is alive or cannot be
 * shown gone (see `probeGroup`); a fence that names no group (`null`, an empty list) or cannot be read
 * stands, as an unknown one (ACP-WORKER-03-FC-EMPTY), and so does a directory that cannot be listed.
 *
 * Under the lock it first makes sure a file at the legacy name is kept by a unique name, adopting it
 * if need be (ACP-WORKER-03-FC-ADOPT); one that cannot be stands. `stale` then lists what may be
 * removed: each unique file whose every group is confirmed gone, and the legacy name when it is a link
 * to one of them. Outside the lock it adopts nothing and its `stale` is not to be acted on.
 */
const assessFences = (lockPath: string, underLock: boolean): { standing: LiveFence | null; stale: StaleFence[] } => {
  const directory = dirname(lockPath);
  const legacy = legacyFencePath(lockPath);
  if (underLock && !adoptLegacy(lockPath)) {
    return { standing: { groups: null, alive: [], files: [legacy] }, stale: [] };
  }
  let names: string[];
  try {
    names = fenceNames(lockPath);
  } catch {
    return { standing: { groups: null, alive: [], files: [directory] }, stale: [] };
  }
  const judged = new Map<number, LiveFence | null>();
  const standingFiles: { path: string; ino: number | null; fence: LiveFence }[] = [];
  const staleUnique = new Map<number, StaleFence[]>();
  let staleLegacy: StaleFence | null = null;
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
      const answers = groups.map((group) => ({ group, answer: probeGroup(group) }));
      const standingGroups = answers.filter(({ answer }) => answer !== "gone").map(({ group }) => group);
      verdict = standingGroups.length > 0 ? { groups, alive: standingGroups, files: [path] } : null;
      if (read.ino !== null) judged.set(read.ino, verdict);
    }
    if (verdict !== null) {
      standingFiles.push({ path, ino: read.ino, fence: verdict });
      continue;
    }
    const stat = identityOf(path);
    if (read.ino === null || stat === null || stat.ino !== read.ino) continue;
    if (path === legacy) {
      staleLegacy = { path, identity: stat };
    } else {
      staleUnique.set(read.ino, [...(staleUnique.get(read.ino) ?? []), { path, identity: stat }]);
    }
  }
  const stale = [...staleUnique.values()].flat();
  if (staleLegacy !== null && staleUnique.has(staleLegacy.identity.ino)) stale.push(staleLegacy);
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

/**
 * What can be said of a fenced group (ACP-WORKER-03-FC-UNKNOWN). Gone only on a confirmed ESRCH from
 * `kill(-pgid, 0)`, or when the process now holding the id started at another time than the recorded
 * leader (both tokens read): a pid is reused only once its group is empty. Members found, EPERM
 * included, is alive. An id outside what `kill` can be asked about, or any other answer, is unknown,
 * and an unknown group keeps its fence standing like a live one.
 */
const probeGroup = (group: FencedGroup): "gone" | "alive" | "unknown" => {
  if (!Number.isSafeInteger(group.pgid) || group.pgid <= 1 || group.pgid > 2_147_483_647) return "unknown";
  try {
    process.kill(-group.pgid, 0);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ESRCH") return "gone";
    if (code !== "EPERM") return "unknown";
  }
  let holder: string | null;
  try {
    holder = readProcessStartToken(group.pgid);
  } catch {
    return "alive";
  }
  return holder !== null && group.leaderStartedAt !== null && holder !== group.leaderStartedAt ? "gone" : "alive";
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

/** This build's holder record, inside its directory `<lock>`. */
const HOLDER_RECORD = "holder.json";

/** A holder record, this build's or an earlier build's; null when it is absent or cannot be read. */
const parseRecord = (file: string): LockInfo | null => {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as LockInfo;
    return (
      typeof parsed === "object" && parsed !== null &&
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
};

type Standing =
  | { kind: "absent" }
  /** This build's directory; `info` null when it holds no record (`unreadable`: one it cannot read). */
  | { kind: "ours"; identity: FileIdentity; info: LockInfo | null; unreadable: boolean; ageMs: number }
  /** A regular file: an earlier build's record, or one that cannot be read. */
  | { kind: "earlier"; info: LockInfo | null; unreadable: boolean; ageMs: number }
  /** Neither: a symbolic link, a socket. */
  | { kind: "other" };

/** What stands at the lock path, read without following a link. */
const standingAt = (path: string): Standing => {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    return (error as { code?: string }).code === "ENOENT" ? { kind: "absent" } : { kind: "other" };
  }
  if (stat.isDirectory()) {
    const record = join(path, HOLDER_RECORD);
    let recordStat;
    try {
      recordStat = lstatSync(record);
    } catch (error) {
      const absent = (error as { code?: string }).code === "ENOENT";
      return { kind: "ours", identity: { dev: stat.dev, ino: stat.ino }, info: null, unreadable: !absent, ageMs: Date.now() - stat.mtimeMs };
    }
    const info = recordStat.isFile() ? parseRecord(record) : null;
    return { kind: "ours", identity: { dev: stat.dev, ino: stat.ino }, info, unreadable: info === null, ageMs: Date.now() - recordStat.mtimeMs };
  }
  if (!stat.isFile()) return { kind: "other" };
  const info = parseRecord(path);
  return { kind: "earlier", info, unreadable: info === null, ageMs: Date.now() - stat.mtimeMs };
};

/** Whether `path` is still the directory `identity` names. */
const sameDirectory = (path: string, identity: FileIdentity): boolean => {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && stat.dev === identity.dev && stat.ino === identity.ino;
  } catch {
    return false;
  }
};

/**
 * Puts this holder's record in place, whole and synced before it is visible: in a directory made
 * on an empty path by `mkdir`, which fails with EEXIST if anything got there first, or in this
 * build's own directory that `reuse` names, which fails with ESTALE if the path no longer names it.
 * A directory made here is removed again if the record cannot be put in it. Called only under the lock.
 */
const installRecord = (path: string, info: LockInfo, claim: { reuse: FileIdentity } | "create"): void => {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeSync(fd, JSON.stringify(info));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  let made = false;
  try {
    if (claim === "create") {
      mkdirSync(path, { mode: 0o700 });
      made = true;
    } else if (!sameDirectory(path, claim.reuse)) {
      throw Object.assign(new Error("the lock directory is no longer the one judged under the lock"), { code: "ESTALE" });
    }
    renameSync(temporary, join(path, HOLDER_RECORD));
  } catch (error) {
    if (made) {
      try {
        rmdirSync(path);
      } catch {
        /* left for the next holder of this build to reclaim */
      }
    }
    throw error;
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      /* renamed into place */
    }
  }
};
