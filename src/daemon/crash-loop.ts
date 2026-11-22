import { randomBytes } from "node:crypto";
import { closeSync, constants, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";

/**
 * §33.1 crash-loop record: `crash-loop.json` in the state directory, outside the database.
 *
 * The daemon and the gate that runs before it opens the database (`start-gate.ts`) count a failed start
 * the same way, so the backoff a supervisor reads is one number whichever of them refused.
 */
export interface CrashLoopFile {
  failures: number;
  firstAt: string;
  retryNotBefore?: string;
  /**
   * A start refused before it opened the database (migrate-before-start). It leaves no audit row, so its
   * reason is kept here. `databaseWritten` is a statement about this refusal: nothing was opened, so nothing
   * of the database changed, not even its journal mode, and no `-wal` or `-shm` was created.
   */
  lastRefusal?: {
    /**
     * Minted when the refusal is recorded and carried by the CEO notice that tells of it, so the receiver can
     * match a notice to this record. A retry inside the backoff reads it and never mints another.
     */
    refusalId: string;
    host: string;
    at: string;
    reasonCode: string;
    stage: "before-open";
    doctorStatus: string;
    blockingFindings: Array<{ code: string; severity: string; scope: string }>;
    databaseWritten: false;
    /** What became of the CEO notice for this refusal. Written after the refusal, by `recordRefusalNotice`. */
    notice?: RefusalNoticeOutcome;
  };
}

/**
 * The outcome of the one CEO notice a gate-refused start sends. Kept here and nowhere else: the notice
 * never goes through the database or the outbox, so this file is the only record that it was tried.
 */
export type RefusalNoticeOutcome =
  | { outcome: "delivered"; at: string; eventId: string; receiptId: string }
  | { outcome: "failed"; at: string; reason: string; detail?: string; eventId?: string }
  /** The request was out when the bound expired: the receiver may or may not have it. Neither is claimed. */
  | { outcome: "unknown"; at: string; reason: string; eventId: string }
  | { outcome: "route-unconfigured"; at: string; reason: string };

export const crashLoopPath = (stateDir: string): string => join(stateDir, "crash-loop.json");

const readJson = <T>(path: string): T | null => {
  try {
    // A record that is not a regular file (a link to somewhere else) is not read as one.
    if (!lstatSync(path).isFile()) return null;
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
};

/**
 * Replaces the record atomically and never through a link.
 *
 * `writeFileSync` on a path opens it and follows a symbolic link, so a `crash-loop.json` that points at
 * `state.sqlite` made a refusal overwrite the database while reporting `databaseWritten: false`. The
 * record is written to a new file beside it, created exclusively with `O_NOFOLLOW` at 0600, and renamed
 * over the path: a rename replaces a link at the target and never writes through it.
 */
const replaceRecord = (stateDir: string, contents: string): void => {
  const target = crashLoopPath(stateDir);
  const staged = join(stateDir, `.crash-loop.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(staged, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeSync(fd, contents);
  } catch (error) {
    closeSync(fd);
    unlinkSync(staged);
    throw error;
  }
  closeSync(fd);
  try {
    renameSync(staged, target);
  } catch (error) {
    unlinkSync(staged);
    throw error;
  }
};

const LOCK_WAIT_MS = 3_000;
const LOCK_STALE_MS = 10_000;
const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/**
 * Runs one read-modify-write of the record while no other start is doing the same. Starts that refuse run
 * at once and concurrently (a held lock, a gate refusal still waiting on its CEO notice, a retry in the
 * backoff), and each of them rewrites this file from what it read: without this, the one that read first and
 * wrote last erased what the others wrote, a `lastRefusal` and its notice outcome among it, and the next
 * start inside the backoff told the CEO again.
 *
 * The lock is a file created exclusively beside the record and never through a link, held only for the
 * read-modify-write (never for a notice's delivery), and given up on as stale after `LOCK_STALE_MS`. A start
 * that cannot take it within `LOCK_WAIT_MS` throws, and its caller keeps the refusal without the record, as
 * it always has when the record could not be written.
 */
const withRecordLock = <T>(stateDir: string, action: () => T): T => {
  const lock = join(stateDir, ".crash-loop.lock");
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const fd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      closeSync(fd);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - lstatSync(lock).mtimeMs > LOCK_STALE_MS) unlinkSync(lock);
        else if (Date.now() >= deadline) throw new Error("crash-loop.json is being written by another start");
        else sleepSync(15);
      } catch (inner) {
        if ((inner as NodeJS.ErrnoException).code !== "ENOENT") throw inner;
      }
    }
  }
  try {
    return action();
  } finally {
    try { unlinkSync(lock); } catch { /* already gone */ }
  }
};

export const readCrashLoopFile = (stateDir: string, nowIso: string): CrashLoopFile =>
  readJson<CrashLoopFile>(crashLoopPath(stateDir)) ?? { failures: 0, firstAt: nowIso };

export const backoffSecondsFor = (failures: number): number => (failures === 0 ? 0 : Math.min(300, 2 ** failures));

/**
 * Counts one failed start in the file and returns what it wrote. An existing `lastRefusal`, with its notice
 * outcome, is kept: only a newer refusal (`refusal`) replaces it, so a start that is refused for another
 * reason (the lock held, a failure after the open) cannot make the next start forget what it already told.
 */
export const countStartupFailure = (
  stateDir: string,
  nowIso: string,
  refusal?: NonNullable<CrashLoopFile["lastRefusal"]>,
): { next: CrashLoopFile; backoffSeconds: number } => {
  // A state directory that does not exist yet (a first start refused before anything created it) is made
  // here, owner-only, so the refusal has somewhere to be recorded.
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  return withRecordLock(stateDir, () => {
    const previous = readCrashLoopFile(stateDir, nowIso);
    const failures = previous.failures + 1;
    const backoffSeconds = backoffSecondsFor(failures);
    const kept = refusal ?? previous.lastRefusal;
    const next: CrashLoopFile = {
      failures,
      firstAt: previous.failures === 0 ? nowIso : previous.firstAt,
      retryNotBefore: new Date(Date.parse(nowIso) + backoffSeconds * 1000).toISOString(),
      ...(kept ? { lastRefusal: kept } : {}),
    };
    replaceRecord(stateDir, JSON.stringify(next));
    return { next, backoffSeconds };
  });
};

/**
 * Adds the CEO notice's outcome to the refusal it belongs to and changes nothing else, so the count and
 * the backoff the supervisor reads are the ones the refusal wrote. A record that no longer names this
 * `refusalId` (another refusal replaced it) is left alone.
 */
export const recordRefusalNotice = (stateDir: string, refusalId: string, notice: RefusalNoticeOutcome): boolean =>
  withRecordLock(stateDir, () => {
    const current = readJson<CrashLoopFile>(crashLoopPath(stateDir));
    if (!current?.lastRefusal || current.lastRefusal.refusalId !== refusalId) return false;
    replaceRecord(stateDir, JSON.stringify({ ...current, lastRefusal: { ...current.lastRefusal, notice } }));
    return true;
  });

/** A start that succeeded: the count and the refusal it answered are both over. */
export const clearCrashLoopFile = (stateDir: string): void => {
  withRecordLock(stateDir, () => replaceRecord(stateDir, JSON.stringify({ failures: 0 })));
};
