import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { SingleInstanceLock } from "../../src/daemon/single-instance.ts";
import { cleanupTempDirs, commitAll, gitSync, makeRepo, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);
const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
const waitFor = async (condition: () => boolean, label: string) => {
  const deadline = Date.now() + 15_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};

it("ACP-WORKER-03-FC: a retained lock must fence a surviving mutation child across the production-style exit", async () => {
  const repo = makeRepo({ "README.md": "base\n" });
  const base = gitSync(repo, ["rev-parse", "HEAD"]);
  const branch = gitSync(repo, ["symbolic-ref", "--short", "HEAD"]);
  writeFileSync(join(repo, "README.md"), "next\n");
  commitAll(repo, "next");
  const target = gitSync(repo, ["rev-parse", "HEAD"]);
  gitSync(repo, ["update-ref", `refs/heads/${branch}`, base, target]);
  const stateDir = tempDir("acp-retained-lock-exit-");
  const release = join(stateDir, "release");
  const ready = join(stateDir, "ready");
  const child = spawn(process.execPath, ["--experimental-transform-types",
    "tests/helpers/reviewer-retained-lock-exit-1070.ts", stateDir, repo, branch, target, base, release, ready,
  ], { cwd: process.cwd(), env: { ...process.env, TMPDIR: "/private/tmp" }, stdio: ["ignore", "pipe", "pipe"] });
  const errors: Buffer[] = [];
  child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
  const exit = new Promise<number | null>(resolve => child.once("exit", resolve));
  let mutationPid = 0;
  const successor = new SingleInstanceLock(join(stateDir, "agentcpd.lock"));
  try {
    const code = await exit;
    expect(code, Buffer.concat(errors).toString()).toBe(0);
    const report = JSON.parse(readFileSync(ready, "utf8"));
    mutationPid = report.childPid;
    expect(report.stopped.gitStopped).toBe(false);
    expect(report.stopped.lockRetained).toBe(true);
    expect(alive(report.daemonPid)).toBe(false);
    expect(alive(mutationPid)).toBe(true);
    expect(existsSync(join(stateDir, "agentcpd.lock"))).toBe(true);
    const acquired = successor.acquire(new Date().toISOString());
    const atAcquire = gitSync(repo, ["rev-parse", "HEAD"]);
    writeFileSync(release, "resume only after successor acquisition");
    await waitFor(() => gitSync(repo, ["rev-parse", "HEAD"]) === target, "real update-ref finished");
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ ...report, successorAllowed: acquired.allowed, base, atAcquire,
      after: gitSync(repo, ["rev-parse", "HEAD"]) }));
    expect(acquired.allowed, "the retained lock became reclaimable before the mutation child was confirmed stopped").toBe(false);
  } finally {
    writeFileSync(release, "cleanup");
    if (mutationPid) { try { process.kill(-mutationPid, "SIGKILL"); } catch {} }
    try { child.kill("SIGKILL"); } catch {}
    successor.release();
  }
}, 60_000);
