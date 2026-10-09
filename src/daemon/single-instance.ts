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
}

/**
 * PRD §33.1 / §34.5 — exactly one `agentcpd` may hold authoritative state.
 *
 * A complete owner record is written and synced to a private temporary file, then
 * atomically linked into place. A lock left by a crashed process is only reclaimed after
 * confirming that its pid is genuinely gone — deleting a live daemon's lock would
 * produce the two-writer situation the binding generation model assumes cannot happen.
 */
export class SingleInstanceLock {
  #fd: number | null = null;
  /** What this instance actually wrote, so release only ever removes its own lock. */
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

    const fenced = this.liveFence();
    if (fenced) {
      return deny(
        ReasonCode.DAEMON_ALREADY_RUNNING,
        "a stopped agentcpd could not confirm a worker git process group finished; authority is not taken while it may still run",
        { fence: this.fencePath, groups: fenced.groups, alive: fenced.alive },
      );
    }

    if (this.#fd !== null) {
      return deny(ReasonCode.DAEMON_ALREADY_RUNNING, "this lock is already held", {
        path: this.path,
      });
    }

    const existing = this.read();
    // A live holder blocks acquisition even when it is this process: two lock objects in
    // one process would each believe they own the file, and the second release would
    // delete the first's lock (§33.1).
    if (existing && isAlive(existing.pid)) {
      return deny(ReasonCode.DAEMON_ALREADY_RUNNING, "another agentcpd instance holds the lock", {
        holder: existing,
      });
    }
    if (existing) {
      // Stale: the recorded pid is not running, so the lock is reclaimable.
      try {
        unlinkSync(this.path);
      } catch {
        /* raced with another reclaimer; the O_EXCL below decides the winner */
      }
    } else if (existsSync(this.path)) {
      // The old write-in-place format could leave a truncated file if its owner died in
      // the tiny interval between create and write. New lock records are installed only
      // after a complete temporary file has been synced, so a malformed record can no
      // longer belong to an active writer after this bounded compatibility grace.
      const ageMs = Date.now() - lstatSync(this.path).mtimeMs;
      if (ageMs < MALFORMED_LOCK_GRACE_MS) {
        return deny(ReasonCode.DAEMON_LOCK_LOST, "lock record is incomplete; waiting for its writer", {
          path: this.path,
          retryAfterMs: MALFORMED_LOCK_GRACE_MS - ageMs,
        });
      }
      try {
        unlinkSync(this.path);
      } catch {
        /* raced with another reclaimer; the atomic link below decides the winner */
      }
    }

    const info: LockInfo = { pid: process.pid, startedAt, path: this.path };
    const temporary = join(dirname(this.path), `.${basename(this.path)}.${process.pid}.${randomUUID()}.tmp`);
    let temporaryFd: number | null = null;
    try {
      temporaryFd = openSync(temporary, "wx", 0o600);
      writeSync(temporaryFd, JSON.stringify(info));
      fsyncSync(temporaryFd);
      closeSync(temporaryFd);
      temporaryFd = null;
      // `link` gives the path O_EXCL semantics while making the lock visible only once
      // it contains a complete owner record. A process crash therefore leaves at most an
      // unreferenced temporary file, never a permanent malformed lock.
      linkSync(temporary, this.path);
      this.#fd = openSync(this.path, "r");
    } catch {
      if (temporaryFd !== null) {
        try {
          closeSync(temporaryFd);
        } catch {
          /* best effort while reporting a failed acquisition */
        }
      }
      return deny(ReasonCode.DAEMON_ALREADY_RUNNING, "lock is held by another instance", {
        path: this.path,
      });
    } finally {
      try {
        if (existsSync(temporary)) unlinkSync(temporary);
      } catch {
        /* a crash may leave the temporary file; it is not a lock */
      }
    }

    this.#held = info;
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
      this.release();
      return deny(
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
        this.release();
        return deny(
          ReasonCode.DAEMON_ALREADY_RUNNING,
          "a git fence whose groups have ended could not be removed; authority is not taken",
          { fence: stale, afterInstall: true },
        );
      }
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
        typeof parsed.path === "string"
      )
        ? parsed
        : null;
    } catch {
      return null;
    }
  }

  held(): boolean {
    return this.#fd !== null;
  }

  release(): void {
    if (this.#fd !== null) {
      try {
        closeSync(this.#fd);
      } catch {
        /* already closed */
      }
      this.#fd = null;
    }
    try {
      const current = this.read();
      if (
        this.#held &&
        existsSync(this.path) &&
        current?.pid === this.#held.pid &&
        current.startedAt === this.#held.startedAt
      ) {
        unlinkSync(this.path);
      }
    } catch {
      /* best effort on shutdown */
    }
    this.#held = null;
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
