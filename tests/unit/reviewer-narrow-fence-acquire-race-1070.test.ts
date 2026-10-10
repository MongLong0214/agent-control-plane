import { spawn } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { SingleInstanceLock } from "../../src/daemon/single-instance.ts";
import { cleanupTempDirs, commitAll, gitSync, makeRepo, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitFor = async (condition: () => boolean, label: string) => {
  const until = Date.now() + 45_000;
  while (!condition()) {
    if (Date.now() > until) throw new Error(`timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};

it.each(["race", "empty"])("ACP-WORKER-03-FC: %s must not admit authority while an unconfirmed mutation group lives", async mode => {
  const repo = makeRepo({ "README.md": "base\n" });
  const base = gitSync(repo, ["rev-parse", "HEAD"]);
  const branch = gitSync(repo, ["symbolic-ref", "--short", "HEAD"]);
  writeFileSync(join(repo, "README.md"), "next\n");
  commitAll(repo, "next");
  const target = gitSync(repo, ["rev-parse", "HEAD"]);
  gitSync(repo, ["update-ref", `refs/heads/${branch}`, base, target]);
  const state = tempDir("acp-review-fence-acquire-");
  const release = join(state, "release");
  const ready = join(state, "ready");
  const stop = join(state, "stop");
  const stopped = join(state, "stopped");
  const child = spawn(process.execPath, ["--experimental-transform-types", "tests/helpers/reviewer-fence-acquire-race-1070.ts",
    state, repo, branch, target, base, release, ready, stop, stopped, mode],
  { cwd: process.cwd(), env: { ...process.env, TMPDIR: "/private/tmp" }, stdio: ["ignore", "ignore", "pipe"] });
  const errors: Buffer[] = [];
  child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
  const exited = new Promise<number | null>(resolve => child.once("exit", resolve));
  const successor = new SingleInstanceLock(join(state, "agentcpd.lock"));
  const checked = join(state, "checked");
  const resume = join(state, "resume-acquire");
  const acquiredFile = join(state, "acquired");
  const successorRelease = join(state, "successor-release");
  let acquiring: ReturnType<typeof spawn> | null = null;
  let pgid = 0;
  try {
    await waitFor(() => existsSync(ready), "daemon acquired the lock");
    const report = JSON.parse(readFileSync(ready, "utf8")) as { daemonPid: number; pgid: number };
    pgid = report.pgid;
    expect(alive(pgid)).toBe(true);
    if (mode === "race") {
      acquiring = spawn(process.execPath, ["--experimental-transform-types", "tests/helpers/reviewer-fence-acquirer-1070.ts",
        join(state, "agentcpd.lock"), checked, resume, acquiredFile, successorRelease],
      { cwd: process.cwd(), env: { ...process.env, TMPDIR: "/private/tmp" }, stdio: "ignore" });
      await waitFor(() => existsSync(checked), "successor's initial fence lookup");
      expect(JSON.parse(readFileSync(checked, "utf8")).initial).toBeNull();
    }
    writeFileSync(stop, "stop now");
    expect(await exited, Buffer.concat(errors).toString()).toBe(75);
    expect(alive(report.daemonPid)).toBe(false);
    expect(alive(pgid)).toBe(true);
    let acquired: { allowed: boolean };
    if (mode === "race") {
      // A fresh acquire sees the valid live fence and refuses. Resume the older acquire that
      // already looked up the fence while the predecessor was alive and no fence existed.
      expect(successor.acquire(new Date().toISOString()).allowed).toBe(false);
      writeFileSync(resume, "resume the in-flight acquire");
      await waitFor(() => existsSync(acquiredFile), "the in-flight acquisition result");
      acquired = JSON.parse(readFileSync(acquiredFile, "utf8")).decision;
    } else {
      acquired = successor.acquire(new Date().toISOString());
    }
    const fenceAtAcquire = existsSync(successor.fencePath) ? JSON.parse(readFileSync(successor.fencePath, "utf8")) : null;
    const atAcquire = gitSync(repo, ["rev-parse", "HEAD"]);
    writeFileSync(release, "resume after acquisition");
    await waitFor(() => gitSync(repo, ["rev-parse", "HEAD"]) === target, "real update-ref completed");
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ mode, ...report, stopped: JSON.parse(readFileSync(stopped, "utf8")),
      successorAllowed: acquired.allowed, fenceAtAcquire, atAcquire, after: gitSync(repo, ["rev-parse", "HEAD"]) }));
    expect(acquired.allowed, "authority was acquired while the predecessor's mutation group was still live").toBe(false);
  } finally {
    writeFileSync(stop, "cleanup");
    writeFileSync(resume, "cleanup");
    writeFileSync(successorRelease, "cleanup");
    writeFileSync(release, "cleanup");
    if (pgid) { try { process.kill(-pgid, "SIGKILL"); } catch {} }
    child.kill("SIGKILL");
    acquiring?.kill("SIGKILL");
    successor.release();
  }
}, 120_000);

it.each(["unreadable", "unnamed", "malformed"])("ACP-WORKER-03-FC: an %s fence refuses authority", mode => {
  const lock = new SingleInstanceLock(join(tempDir("acp-review-fence-read-"), "agentcpd.lock"));
  writeFileSync(lock.fencePath, mode === "malformed" ? "not JSON" : JSON.stringify({
    groups: mode === "unreadable" ? [{ pgid: 2_147_483_000, leaderStartedAt: null }] : null,
  }));
  if (mode === "unreadable") {
    chmodSync(lock.fencePath, 0o000);
    expect(() => readFileSync(lock.fencePath, "utf8")).toThrow();
  }
  expect(lock.acquire(new Date().toISOString()).allowed).toBe(false);
  expect(existsSync(lock.fencePath)).toBe(true);
});
