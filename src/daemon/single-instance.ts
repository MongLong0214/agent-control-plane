import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";

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
 * The lock is a file created with `O_EXCL`, so acquisition is atomic. A lock left by a
 * crashed process is only reclaimed after confirming that pid is genuinely gone —
 * deleting a live daemon's lock would produce the two-writer situation the binding
 * generation model assumes cannot happen.
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
    }

    try {
      this.#fd = openSync(this.path, "wx", 0o600);
    } catch {
      return deny(ReasonCode.DAEMON_ALREADY_RUNNING, "lock is held by another instance", {
        path: this.path,
      });
    }

    const info: LockInfo = { pid: process.pid, startedAt, path: this.path };
    writeSync(this.#fd, JSON.stringify(info));
    this.#held = info;
    return allow(ReasonCode.OK, info);
  }

  read(): LockInfo | null {
    if (!existsSync(this.path)) return null;
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as LockInfo;
      return typeof parsed.pid === "number" ? parsed : null;
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
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
