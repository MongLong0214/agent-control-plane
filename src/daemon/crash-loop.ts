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
    at: string;
    reasonCode: string;
    stage: "before-open";
    doctorStatus: string;
    blockingFindings: Array<{ code: string; severity: string; scope: string }>;
    databaseWritten: false;
  };
}

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

export const readCrashLoopFile = (stateDir: string, nowIso: string): CrashLoopFile =>
  readJson<CrashLoopFile>(crashLoopPath(stateDir)) ?? { failures: 0, firstAt: nowIso };

export const backoffSecondsFor = (failures: number): number => (failures === 0 ? 0 : Math.min(300, 2 ** failures));

/** Counts one failed start in the file and returns what it wrote. */
export const countStartupFailure = (
  stateDir: string,
  nowIso: string,
  refusal?: NonNullable<CrashLoopFile["lastRefusal"]>,
): { next: CrashLoopFile; backoffSeconds: number } => {
  const previous = readCrashLoopFile(stateDir, nowIso);
  const failures = previous.failures + 1;
  const backoffSeconds = backoffSecondsFor(failures);
  const next: CrashLoopFile = {
    failures,
    firstAt: previous.failures === 0 ? nowIso : previous.firstAt,
    retryNotBefore: new Date(Date.parse(nowIso) + backoffSeconds * 1000).toISOString(),
    ...(refusal ? { lastRefusal: refusal } : {}),
  };
  // A state directory that does not exist yet (a first start refused before anything created it) is made
  // here, owner-only, so the refusal has somewhere to be recorded.
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  replaceRecord(stateDir, JSON.stringify(next));
  return { next, backoffSeconds };
};

export const clearCrashLoopFile = (stateDir: string): void => {
  replaceRecord(stateDir, JSON.stringify({ failures: 0 }));
};
