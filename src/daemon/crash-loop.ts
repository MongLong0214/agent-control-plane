import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
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
  writeFileSync(crashLoopPath(stateDir), JSON.stringify(next), { mode: 0o600 });
  return { next, backoffSeconds };
};

export const clearCrashLoopFile = (stateDir: string): void => {
  writeFileSync(crashLoopPath(stateDir), JSON.stringify({ failures: 0 }), { mode: 0o600 });
};
