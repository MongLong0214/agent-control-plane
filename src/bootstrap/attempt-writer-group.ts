import { execFileSync } from "node:child_process";

/**
 * #246 C3, review 1076-R2 — the process group an attempt's writer ran its subprocesses in.
 *
 * The daemon spawns the bootstrap's git and gh subprocesses without detaching them, so each runs in
 * the daemon's process group, and so do their own children (git's remote helpers, index-pack, gh's
 * credential helper). The launchd job that runs the daemon leads its own process group, and launchd
 * stops what is left of that group when the job dies. A subprocess that outlives its daemon is
 * therefore still a member of the group the daemon led, and an empty group is positive evidence
 * that none survives: `kill(-pgid, 0)` answers ESRCH only when no process is in the group.
 *
 * What this cannot see, and the callers state: a subprocess that left the group (setsid or setpgid),
 * and a group id reused by an unrelated process — which reads as a member, so it refuses rather than
 * admits. Nothing here sends a signal that does anything: signal 0 only asks.
 */

/** The process group of `pid`, or null when it cannot be read. */
export const readProcessGroup = (pid: number): number | null => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const stdout = execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const pgid = Number(stdout.trim());
    return Number.isSafeInteger(pgid) && pgid > 0 ? pgid : null;
  } catch {
    return null;
  }
};

/** Whether no process is in group `pgid`: true on ESRCH, false when one is, null when it cannot be told. */
export const processGroupEmpty = (pgid: number): boolean | null => {
  if (!Number.isSafeInteger(pgid) || pgid <= 1) return null;
  try {
    process.kill(-pgid, 0);
    return false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return true;
    if (code === "EPERM") return false;
    return null;
  }
};

export interface GroupMember {
  pid: number;
  ppid: number;
  command: string;
}

/**
 * The members of group `pgid` other than this process and the `ps` that lists them, or null when the
 * list cannot be read. For the group this process is in: the subprocesses that may still be writing.
 * When this process leads the group every other member is its own subprocess or one orphaned from
 * it; when it does not, only its descendants are counted, since the rest are not its subprocesses.
 */
export const ownGroupSubprocesses = (pgid: number): GroupMember[] | null => {
  if (!Number.isSafeInteger(pgid) || pgid <= 1) return null;
  let stdout: string;
  try {
    stdout = execFileSync("ps", ["-o", "pid=,ppid=,comm=", "-g", String(pgid)], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
  const members: GroupMember[] = [];
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match === null) continue;
    members.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3]!.trim() });
  }
  const others = members.filter(
    (member) =>
      member.pid !== process.pid &&
      // The `ps` this call spawned lists itself.
      !(member.ppid === process.pid && /(^|\/)ps$/.test(member.command)),
  );
  if (pgid === process.pid) return others;
  const descendants = new Set<number>([process.pid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const member of others) {
      if (!descendants.has(member.pid) && descendants.has(member.ppid)) {
        descendants.add(member.pid);
        grew = true;
      }
    }
  }
  return others.filter((member) => descendants.has(member.pid));
};
