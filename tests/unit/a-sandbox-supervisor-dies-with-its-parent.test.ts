import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { boundedSpawnSync } from "../helpers/bounded-sync-child.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { requireSeatbelt } from "../helpers/seatbelt.ts";

/**
 * #1233 — a real-sandbox verification whose parent dies mid-run leaves nothing behind. The parent
 * here is a process of the test's own (`sandbox-parent-process.ts`) running the real `runSandboxed`
 * under the real seatbelt and supervisor; it is SIGKILLed, so none of its cleanup can run. Before the
 * fix the supervisor was re-parented to launchd and polled its candidate forever, and a candidate
 * still in its pre-exec SIGSTOP was never released or killed.
 *
 * Only processes this file created are read or signalled: the parent it spawned, and the supervisor
 * and candidate that parent recorded, each fenced by pid and start time.
 */

const HELPER = fileURLToPath(new URL("../helpers/sandbox-parent-process.ts", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** How long the supervisor has to notice and clean up. It polls about once a millisecond. */
const REAP_BOUND_MS = 10_000;

interface Recorded {
  pid: number;
  ppid: number;
  stat: string;
  comm: string;
  startedAt: string;
}

const parents: ChildProcess[] = [];
const recorded: Recorded[] = [];
const homes: string[] = [];

/** Still the process that was recorded: the same pid with the same start time, and not a zombie. */
const stillRunning = (target: Recorded): boolean => {
  const ps = boundedSpawnSync("/bin/ps", ["-o", "stat=,lstart=", "-p", String(target.pid)], {
    encoding: "utf8",
    timeout: 5_000,
  });
  const row = String(ps.stdout ?? "").trim();
  if (ps.status !== 0 || !row) return false;
  const [stat = "", ...started] = row.split(/\s+/);
  return !stat.startsWith("Z") && started.join(" ") === target.startedAt.split(/\s+/).join(" ");
};

const delay = (ms: number): Promise<void> => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

afterEach(() => {
  // A red run strands exactly what it recorded; kill only those, candidate first, by identity.
  for (const target of recorded.splice(0)) {
    if (!stillRunning(target)) continue;
    try {
      process.kill(target.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  for (const parent of parents.splice(0)) {
    if (parent.exitCode === null && parent.signalCode === null) parent.kill("SIGKILL");
  }
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  cleanupTempDirs();
});

const cases = [
  ["no-spawn", "stopped"],
  ["no-spawn", "running"],
  ["supervised-budget", "stopped"],
  ["supervised-budget", "running"],
] as const;

describe("a sandbox supervisor dies with the parent that launched it (#1233)", () => {
  for (const [mode, hold] of cases) {
    it(`under ${mode}, a ${hold} candidate and its supervisor are gone soon after the parent is SIGKILLed`, async (context) => {
      requireSeatbelt(context);
      const worktree = tempDir("acp-parent-death-worktree-");
      const control = tempDir("acp-parent-death-control-");
      // The parent's scratch root is HOME-derived; a HOME of its own makes its one candidate report
      // the only one there. Under this file's private HOME, never the operator's.
      const home = mkdtempSync(join(homedir(), "acp-parent-death-home-"));
      homes.push(home);

      const parent = spawn(process.execPath, ["--experimental-transform-types", HELPER, control, worktree, mode, hold], {
        cwd: REPO_ROOT,
        env: { ...process.env, HOME: home },
        stdio: ["ignore", "ignore", "pipe"],
      });
      parents.push(parent);
      const errors: Buffer[] = [];
      parent.stderr!.on("data", (chunk: Buffer) => errors.push(chunk));
      const exited = new Promise<void>((resolveExit) => parent.once("exit", () => resolveExit()));

      const readyPath = join(control, "ready.json");
      const outcomePath = join(control, "outcome.json");
      const deadline = Date.now() + 30_000;
      while (!existsSync(readyPath) && !existsSync(outcomePath) && parent.exitCode === null && Date.now() < deadline) {
        await delay(10);
      }
      if (!existsSync(readyPath)) {
        throw new Error(
          `the parent never recorded its sandbox: exit=${String(parent.exitCode)} ` +
            `outcome=${existsSync(outcomePath) ? readFileSync(outcomePath, "utf8").slice(0, 2_000) : "none"} ` +
            `stderr=${Buffer.concat(errors).toString().slice(-2_000)}`,
        );
      }
      const ready = JSON.parse(readFileSync(readyPath, "utf8")) as {
        parent: number;
        candidate: Recorded;
        supervisor: Recorded | null;
      };
      recorded.push(ready.candidate);
      if (ready.supervisor) recorded.push(ready.supervisor);

      // What is about to be killed is this case's own tree: the supervisor is the parent's child,
      // and the candidate is the supervisor's.
      expect(ready.parent).toBe(parent.pid);
      expect(ready.supervisor).not.toBeNull();
      const supervisor = ready.supervisor!;
      expect(supervisor.ppid).toBe(parent.pid);
      expect(ready.candidate.ppid).toBe(supervisor.pid);
      if (hold === "stopped") expect(ready.candidate.stat).toContain("T");
      else expect(ready.candidate.stat).not.toContain("T");
      expect(stillRunning(supervisor)).toBe(true);
      expect(stillRunning(ready.candidate)).toBe(true);

      parent.kill("SIGKILL");
      await exited;
      const killedAt = Date.now();

      let survivors = [ready.candidate, supervisor].filter(stillRunning);
      while (survivors.length > 0 && Date.now() - killedAt < REAP_BOUND_MS) {
        await delay(25);
        survivors = survivors.filter(stillRunning);
      }
      expect(
        survivors.map((survivor) => `${survivor === supervisor ? "supervisor" : "candidate"} ${survivor.pid}`),
        `still running ${REAP_BOUND_MS}ms after the parent was SIGKILLed`,
      ).toEqual([]);
    });
  }
});
