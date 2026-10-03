import { execFileSync } from "node:child_process";

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

interface LocalSecond {
  year: number;
  month: number;
  day: number;
  hours: number;
  minutes: number;
  seconds: number;
}

const rendersAs = (instant: number, local: LocalSecond): boolean => {
  const at = new Date(instant);
  if (at.getFullYear() !== local.year) return false;
  if (at.getMonth() !== local.month) return false;
  if (at.getDate() !== local.day) return false;
  if (at.getHours() !== local.hours) return false;
  if (at.getMinutes() !== local.minutes) return false;
  return at.getSeconds() === local.seconds;
};

/** Every DST shift in use is a multiple of 15 minutes and at most two hours; four hours is margin. */
const OFFSET_STEP_MS = 15 * 60_000;
const OFFSET_STEPS = 16;

/**
 * The first millisecond of the second `ps -o lstart=` rendered, as one UTC instant, or null.
 *
 * `ps` renders in its own local time and is spawned with the daemon's environment, so the
 * daemon's local time is the zone the text is in. A row written by a process whose zone differed
 * is misread, and the reader that uses this has to fail closed on it. A local time is not always
 * one instant either: where clocks fall back it names two (review PR1046-R1, round 2:
 * `Sun Nov  1 01:30:00 2026` in America/New_York is both 05:30Z and 06:30Z), and where they spring
 * forward it names none. Every instant within four hours of the naive reading is tried, and only a
 * reading with exactly one instant is an answer; the rest are null, which every caller refuses.
 *
 * The one parse for both legacy lstart rules — the unread-capacity keep (#1045) and the adopted
 * Gateway's lineage admission (#1037). Each first had its own. The keep's naive reading was
 * replaced rather than kept beside this one: inside a fall-back hour it settled on one of two
 * instants without saying so. So the keep, and `createWithPinnedStart`'s pin, now refuse such an
 * lstart instead, and that row takes the hold, revoke and failover paths.
 */
export const lstartSecondStartMs = (lstart: string): number | null => {
  const parts = LSTART.exec(lstart);
  if (parts === null) return null;
  const month = LSTART_MONTHS.indexOf(parts[1]!);
  if (month === -1) return null;
  const local: LocalSecond = {
    year: Number(parts[6]),
    month,
    day: Number(parts[2]),
    hours: Number(parts[3]),
    minutes: Number(parts[4]),
    seconds: Number(parts[5]),
  };
  const naive = new Date(local.year, local.month, local.day, local.hours, local.minutes, local.seconds).getTime();
  if (!Number.isFinite(naive)) return null;
  const instants: number[] = [];
  for (let step = -OFFSET_STEPS; step <= OFFSET_STEPS; step += 1) {
    const candidate = naive + step * OFFSET_STEP_MS;
    if (rendersAs(candidate, local)) instants.push(candidate);
  }
  return instants.length === 1 ? instants[0]! : null;
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
  const native = /^darwin-tv:(\d+)\.\d{6}$/.exec(token);
  if (native === null) return false;
  return Number(native[1]) * 1000 === second;
};
