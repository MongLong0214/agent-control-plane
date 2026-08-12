import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import { type Decision, allow, deny } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";

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

  acquire(startedAt: string): Decision<LockInfo> {
    mkdirSync(dirname(this.path), { recursive: true });

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
