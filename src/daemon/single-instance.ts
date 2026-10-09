import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
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
   */
  get fencePath(): string {
    return `${this.path}.git-fence.json`;
  }

  fence(groups: readonly FencedGroup[] | null, recordedAt: string): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = join(dirname(this.path), `.${basename(this.fencePath)}.${process.pid}.${randomUUID()}.tmp`);
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeSync(fd, JSON.stringify({ pid: process.pid, recordedAt, groups }));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, this.fencePath);
  }

  /** The fence beside this lock, if it still stands (see `readLiveFence`). */
  liveFence(): LiveFence | null {
    return readLiveFence(this.fencePath);
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
    // could only follow a reclamation that saw it dead: any fence it wrote is in place by now, however
    // the two interleaved, and the check above may have run before it was. Read directly, never through
    // the overridable lookup, so no subclass can answer it from a stale read.
    const fencedNow = readLiveFence(this.fencePath);
    if (fencedNow) {
      this.release();
      return deny(
        ReasonCode.DAEMON_ALREADY_RUNNING,
        "a stopped agentcpd could not confirm a worker git process group finished; authority is not taken while it may still run",
        { fence: this.fencePath, groups: fencedNow.groups, alive: fencedNow.alive, afterInstall: true },
      );
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

interface LiveFence {
  /** The groups the fence names; null when it names none or cannot be read, which fences regardless. */
  groups: FencedGroup[] | null;
  alive: FencedGroup[];
}

/**
 * The fence, if any group it names may still be alive. A group is alive while `kill(-pgid, 0)` finds
 * members, unless a process now holding the group's id started at another time than the recorded
 * leader — a pid is reused only once its group is empty, so that group is gone. A fence that names no
 * group (`null`, an empty list) or cannot be read stands, as an unknown one. Once every named group is
 * gone it is removed.
 */
const readLiveFence = (fencePath: string): LiveFence | null => {
  if (!existsSync(fencePath)) return null;
  let groups: FencedGroup[] | null;
  try {
    const parsed = JSON.parse(readFileSync(fencePath, "utf8")) as { groups?: unknown };
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
  // ACP-WORKER-03-FC-EMPTY: an incomplete stop that names no group is an unknown one, not a finished one.
  if (groups === null || groups.length === 0) return { groups: null, alive: [] };
  const alive = groups.filter((group) => fencedGroupAlive(group));
  if (alive.length > 0) return { groups, alive };
  try {
    unlinkSync(fencePath);
  } catch {
    /* already gone */
  }
  return null;
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
