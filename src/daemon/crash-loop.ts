import Database from "better-sqlite3";
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
    /**
     * Set once, before the notice is sent, by `claimRefusalNoticeSend`: this refusalId's notice has been
     * handed to a sender, and no start sends it again, whatever became of it (`unknown` included).
     */
    noticeSendClaimedAt?: string;
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
  | { outcome: "route-unconfigured"; at: string; reason: string }
  /** The Gateway serves the CEO's conversation, but the binding has not confirmed its process: nothing was sent. */
  | { outcome: "target-unconfirmed"; at: string; reason: string; detail?: string };

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

/**
 * Runs one read-modify-write of the record while no other start is doing the same. Starts that refuse run
 * at once and concurrently (a held lock, a gate refusal still waiting on its CEO notice, a retry in the
 * backoff), and each of them rewrites this file from what it read: without this, the one that read first and
 * wrote last erased what the others wrote, a `lastRefusal` and its notice outcome among it, and the next
 * start inside the backoff told the CEO again.
 *
 * The lock is an open `BEGIN EXCLUSIVE` transaction on `.crash-loop.lock`, an empty SQLite file beside the
 * record, held by one connection for the read-modify-write only (never for a notice's delivery). The
 * operating system ends it when that connection closes or its process exits, SIGKILL included: an owner
 * that exited leaves it to the next start at once, and one that stalls keeps it for as long as it stalls.
 * Nothing judges it by age and the file is never removed, so no owner, however late it resumes, can take
 * away a lock another start holds. A start that cannot take it within `LOCK_WAIT_MS` throws, and its caller
 * keeps the refusal without the record, as it always has when the record could not be written. It is the
 * primitive `agentcpd.lock.db` uses (`single-instance.ts`), in the normal locking mode with a busy wait,
 * for the reason given there.
 *
 * Rejected: a file created exclusively, reclaimed once older than ten seconds and removed by its owner on
 * release. A stalled owner lost it to the next start and, resuming, removed that start's lock, so two starts
 * rewrote the record at once. Rejected: that file naming its owner's pid and start token, reclaimed only once
 * the owner is proven gone. Two starts that read the same dead owner each remove what is at the path, and
 * the later one removes the lock the first has just taken.
 */
export const withRecordLock = <T>(stateDir: string, action: () => T): T => {
  const lock = join(stateDir, ".crash-loop.lock");
  try {
    closeSync(openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  // SQLite opens a path through a link: a lock that is not this regular file (a link to `state.sqlite`)
  // is never opened as the lock, since locking it would be a write to whatever it names.
  const created = lstatSync(lock);
  if (!created.isFile()) throw new Error("the crash-loop.json lock is not a regular file");
  const db = new Database(lock, { timeout: LOCK_WAIT_MS });
  try {
    const opened = lstatSync(lock);
    if (!opened.isFile() || opened.dev !== created.dev || opened.ino !== created.ino) {
      throw new Error("the crash-loop.json lock changed while it was opened");
    }
    try {
      db.exec("BEGIN EXCLUSIVE");
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") throw new Error("crash-loop.json is being written by another start");
      throw error;
    }
    return action();
  } finally {
    try { db.close(); } catch { /* the lock ends with the process if not before */ }
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

/**
 * Takes the one right to send this refusalId's notice. True exactly once per `refusalId`: the claim is kept in
 * the record before anything is sent, so a second start, a retry or a restart that reaches the same refusal
 * never sends it again, and a notice whose outcome is `unknown` is not re-POSTed either.
 */
export const claimRefusalNoticeSend = (stateDir: string, refusalId: string, nowIso: string): boolean =>
  withRecordLock(stateDir, () => {
    const current = readJson<CrashLoopFile>(crashLoopPath(stateDir));
    if (!current?.lastRefusal || current.lastRefusal.refusalId !== refusalId) return false;
    if (current.lastRefusal.noticeSendClaimedAt !== undefined || current.lastRefusal.notice !== undefined) return false;
    replaceRecord(stateDir, JSON.stringify({ ...current, lastRefusal: { ...current.lastRefusal, noticeSendClaimedAt: nowIso } }));
    return true;
  });

/** A start that succeeded: the count and the refusal it answered are both over. */
export const clearCrashLoopFile = (stateDir: string): void => {
  withRecordLock(stateDir, () => replaceRecord(stateDir, JSON.stringify({ failures: 0 })));
};
