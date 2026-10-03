import { execFileSync } from "node:child_process";

import { DARWIN_START_TOKEN } from "./process-argv.ts";

/**
 * The start time of a live process, or null if it cannot be established (#505).
 *
 * A pid does not identify a process. Pids are reused, and `sessions.os_pid` is resolved back to a
 * session inside `assertReviewerIndependence` — so a reused pid could hide a producer and let it
 * be admitted as its own blind reviewer. `(pid, startedAt)` stays unique for as long as the
 * process lives, which is exactly as long as the question is being asked.
 *
 * This is the same handshake `src/verify/sandbox.ts` uses to fence a candidate, and it is
 * deliberately not shared with it: that one is async and runs inside the sandbox supervisor's
 * event loop, while session registration is synchronous and on the write path. Copying eight
 * lines is cheaper than making the supervisor's identity capture reentrant.
 *
 * Returns null rather than throwing. A pid that cannot be identified is unverifiable, and the
 * callers treat unverifiable as "resolves to nothing" — the fail-closed direction, since the
 * alternative is resolving to a session that may be the wrong one.
 */
export const processStartedAt = (pid: number | null | undefined): string | null => {
  if (pid === null || pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const stdout = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const startedAt = stdout.trim();
    return startedAt === "" ? null : startedAt;
  } catch {
    return null;
  }
};

const LSTART_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LSTART = /^[A-Z][a-z]{2} ([A-Z][a-z]{2}) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/;

/**
 * The first millisecond of the second `ps -o lstart=` rendered, or null for anything else.
 *
 * `ps` renders in its own local time and is spawned with the daemon's environment, so the
 * daemon's local time is the zone the text is in. A row written by a process whose zone differed
 * is misread, and the reader that uses this has to fail closed on it.
 */
export const lstartSecondStartMs = (lstart: string): number | null => {
  const parts = LSTART.exec(lstart);
  if (parts === null) return null;
  const month = LSTART_MONTHS.indexOf(parts[1]!);
  if (month === -1) return null;
  const started = new Date(
    Number(parts[6]), month, Number(parts[2]), Number(parts[3]), Number(parts[4]), Number(parts[5]),
  ).getTime();
  return Number.isFinite(started) ? started : null;
};

/**
 * Whether a native start token falls in the second an lstart text names (ACP1045-R3-01).
 *
 * Only a `darwin-tv` token carries epoch seconds; a `linux-clk` token counts ticks since boot and
 * has no second to compare, so it is never in one. The lstart is read in the daemon's local time,
 * as `lstartSecondStartMs` says.
 */
export const nativeStartIsInLstartSecond = (token: string, lstart: string): boolean => {
  const second = lstartSecondStartMs(lstart);
  if (second === null) return false;
  const native = DARWIN_START_TOKEN.exec(token);
  if (native === null) return false;
  return Number(native[1]) * 1000 === second;
};
