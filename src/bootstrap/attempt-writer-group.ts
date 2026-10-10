import { execFileSync } from "node:child_process";

/**
 * #246 C3, review 1076-R2 — the process group an attempt's writer ran its subprocesses in.
 *
 * The daemon spawns the bootstrap's git and gh subprocesses without detaching them, so each runs in
 * the daemon's process group, and so do their own children (git's remote helpers, index-pack, gh's
 * credential helper). The launchd job that runs the daemon leads its own process group, and launchd
 * stops what is left of that group when the job dies. A subprocess that outlives its daemon is
 * therefore still a member of the group the daemon led, and an empty group is positive evidence
 * that none survives: `kill(-pgid, 0)` answers ESRCH only when no process is in the group. The live
 * daemon asks the same of the group it leads by listing its members (review 1076-R3): none but itself.
 * Both are asked by membership, never by ancestry, and both only of a group the writer led.
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

export interface GroupMembership {
  /** Every process the kernel lists in the group other than this process and the listing's own `ps`. */
  others: GroupMember[];
  /** Whether this process is itself in the group. */
  includesThisProcess: boolean;
}

/**
 * Review 1076-R3 — who is in process group `pgid`, asked of the kernel by group membership and never
 * by ancestry: a subprocess whose parent has exited is reparented, but it stays in the group it was
 * started in, so it is listed here exactly as a direct child is. Everything listed counts, except
 * this process itself and the one `ps` this call runs to list the group, which is this process's
 * own child, in its group, for as long as the call lasts. Null when the list cannot be read, or a
 * line of it cannot be parsed, or off macOS. A snapshot: it says who is in the group now, not that no
 * process will join it later.
 */
export const processGroupMembership = (pgid: number): GroupMembership | null => {
  // `ps -g` selects by process group on macOS, where the daemon runs; procps reads it as a session.
  if (process.platform !== "darwin" || !Number.isSafeInteger(pgid) || pgid <= 1) return null;
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
  const listed: GroupMember[] = [];
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match === null) return null;
    listed.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3]!.trim() });
  }
  const includesThisProcess = listed.some((member) => member.pid === process.pid);
  // The `ps` this call ran lists itself when this process is in the group: one such child, no more.
  const query = includesThisProcess
    ? listed.findIndex((member) => member.ppid === process.pid && /(^|\/)ps$/.test(member.command))
    : -1;
  const others = listed.filter((member, index) => member.pid !== process.pid && index !== query);
  return { others, includesThisProcess };
};
