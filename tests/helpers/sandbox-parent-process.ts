import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parseVerificationCommand } from "../../src/contracts/verification-command.ts";
import { ACP_SCRATCH_ROOT } from "../../src/core/scratch-root.ts";
import { runSandboxed, type ProcessLimitMode } from "../../src/verify/sandbox.ts";

/**
 * The parent of one real-sandbox verification, in a process of its own so the #1233 witness can
 * SIGKILL it mid-run:
 *
 *   <control> <worktree> <no-spawn|supervised-budget> <stopped|running>
 *
 * It starts `runSandboxed` on a candidate that never ends, finds the candidate the supervisor
 * reported in this process's scratch root (HOME is private to the case, so there is one), and
 * publishes `<control>/ready.json`: the candidate and its parent, the supervisor, each with its ppid,
 * state and start time. Then it waits to be killed.
 *
 * `stopped` blocks this process's event loop from the turn the supervisor is spawned in, so the
 * sandbox never releases the candidate from its pre-exec SIGSTOP -- the state #1233 found stranded.
 * `running` publishes once the candidate has exec'd, which only a released candidate can do, and
 * keeps the loop turning, as a parent that dies while the command runs would.
 */
const [control = "", worktree = "", mode = "", hold = ""] = process.argv.slice(2);

interface Observed {
  pid: number;
  ppid: number;
  stat: string;
  comm: string;
  startedAt: string;
}

const ps = (pid: number, fields: string): string => {
  const result = spawnSync("/bin/ps", ["-o", fields, "-p", String(pid)], { encoding: "utf8", timeout: 5_000 });
  return result.status === 0 ? result.stdout.trim() : "";
};

const observe = (pid: number): Observed | null => {
  const row = ps(pid, "ppid=,stat=").split(/\s+/);
  const startedAt = ps(pid, "lstart=");
  const comm = ps(pid, "comm=");
  if (row.length < 2 || !startedAt) return null;
  return { pid, ppid: Number(row[0]), stat: row[1] ?? "", comm, startedAt };
};

const candidatePid = (): number | null => {
  if (!existsSync(ACP_SCRATCH_ROOT)) return null;
  for (const entry of readdirSync(ACP_SCRATCH_ROOT)) {
    if (!entry.startsWith("acp-sbx-")) continue;
    const report = join(ACP_SCRATCH_ROOT, entry, "acp-candidate.pid");
    if (!existsSync(report)) continue;
    const pid = Number.parseInt(readFileSync(report, "utf8").trim(), 10);
    if (Number.isSafeInteger(pid) && pid > 0) return pid;
  }
  return null;
};

const publish = (name: string, value: unknown): void => {
  const path = join(control, name);
  writeFileSync(`${path}.tmp`, JSON.stringify(value));
  renameSync(`${path}.tmp`, path);
};

const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

const record = (candidate: Observed): void => {
  const supervisor = observe(candidate.ppid);
  publish("ready.json", { parent: process.pid, candidate, supervisor });
};

const processLimit = mode as ProcessLimitMode;
void runSandboxed({
  command: parseVerificationCommand({
    id: "parent-death",
    argv: ["node", "-e", "setInterval(() => {}, 1000)"],
    timeoutSeconds: 600,
  }),
  worktreePath: worktree,
  processLimit,
}).then(
  (outcome) => publish("outcome.json", outcome),
  (error: unknown) => publish("outcome.json", { error: String(error) }),
);

if (hold === "stopped") {
  // `runSandboxed` spawns the supervisor before its first real wait, so by this callback the
  // supervisor exists. From here the loop never turns again: the candidate's release cannot run.
  setImmediate(() => {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const pid = candidatePid();
      const candidate = pid === null ? null : observe(pid);
      if (candidate !== null && candidate.stat.includes("T")) {
        record(candidate);
        break;
      }
      if (Date.now() > deadline) {
        publish("outcome.json", { error: "no stopped candidate was reported within 30s" });
        process.exit(1);
      }
      sleepSync(1);
    }
    for (;;) sleepSync(60_000);
  });
} else {
  const poll = setInterval(() => {
    const pid = candidatePid();
    const candidate = pid === null ? null : observe(pid);
    const supervisor = candidate === null ? null : observe(candidate.ppid);
    // The candidate is a fork of the supervisor and execs only after the sandbox continues it, so a
    // candidate no longer running the supervisor's image has been released.
    if (candidate === null || supervisor === null || candidate.comm === supervisor.comm || candidate.stat.includes("T")) {
      return;
    }
    clearInterval(poll);
    record(candidate);
  }, 5);
}
