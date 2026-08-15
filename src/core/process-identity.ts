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
