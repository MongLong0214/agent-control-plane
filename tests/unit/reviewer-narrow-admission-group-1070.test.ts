import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import { Daemon } from "../../src/daemon/daemon.ts";
import { SingleInstanceLock } from "../../src/daemon/single-instance.ts";
import { GitChildren } from "../../src/run/worker-git.ts";
import { WorkerTurnRunner } from "../../src/run/worker-turn.ts";
import { cleanupTempDirs, gitSync, tempDir } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";
import { FakeWorkerAdapter, admittingCapacity, seedWorkerWorld } from "../helpers/worker-turn-fixture.ts";

const isolatedHome = vi.hoisted(() => {
  const home = `/private/tmp/acp-review-admission-home-${process.pid}`;
  process.env["HOME"] = home;
  return home;
});
afterAll(() => { cleanupTempDirs(); rmSync(isolatedHome, { recursive: true, force: true }); });
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const groupAlive = (pgid: number) => { try { process.kill(-pgid, 0); return true; } catch { return false; } };
const waitFor = async (condition: () => boolean) => {
  const until = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() > until) throw new Error("admission descendant did not pause");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};
const fixture = () => {
  const h = makeHarness();
  const world = seedWorkerWorld({ db: h.cp.db, clock: h.cp.clock, audit: h.cp.audit,
    sessions: h.cp.sessions, bindings: h.cp.bindings, telemetry: h.cp.telemetry });
  h.cp.tasks.attach({ capacity: admittingCapacity });
  const adapter = new FakeWorkerAdapter(world.broker);
  adapter.script = { writes: { "src/app.js": "module.exports = () => 2;\n" } };
  const runner = new WorkerTurnRunner({ db: world.db, clock: world.clock, audit: world.audit,
    tasks: world.tasks, guard: world.guard, workerAdapter: () => adapter },
  { pollMs: 10, scratchDir: prefix => tempDir(prefix) });
  Object.defineProperty(h.cp, "workerTurns", { value: runner, configurable: true });
  const state = tempDir("acp-review-admission-daemon-");
  const daemon = new Daemon(h.cp, { stateDir: state });
  expect(daemon.lock.acquire(h.cp.clock.nowIso()).allowed).toBe(true);
  const request = { runId: world.runId, taskId: world.taskId, claimId: world.claimId,
    ownerSessionId: world.cto.sessionId, ownerBindingGeneration: world.cto.generation };
  return { h, world, adapter, runner, state, daemon, request };
};

it("ACP-WORKER-03: a refused admission's exited leader does not hide its mutation descendant", async () => {
  const { h, world, adapter, runner, state, daemon, request } = fixture();
  const base = gitSync(world.repoPath, ["rev-parse", "HEAD"]);
  // Preparation will refuse the dirty worktree; it still owns every group it opened to inspect it.
  writeFileSync(join(world.repoPath, "src/app.js"), "dirty before admission\n");
  const bin = tempDir("acp-review-admission-git-");
  const parentFile = join(bin, "parent");
  const childFile = join(bin, "child");
  const release = join(bin, "release");
  const done = join(bin, "done");
  const descendant = join(bin, "descendant.sh");
  writeFileSync(descendant, ["#!/bin/sh", `echo $$ > '${childFile}'`,
    `while [ ! -e '${release}' ]; do /bin/sleep 0.01; done`,
    `/usr/bin/git -C '${world.repoPath}' update-ref refs/heads/${world.branch} '${base}'`,
    `echo $? > '${done}'`, ""].join("\n"));
  writeFileSync(join(bin, "git"), ["#!/bin/sh", 'case "$*" in *"rev-parse --show-object-format"*)',
    `echo $$ > '${parentFile}'`, `/bin/sh '${descendant}' </dev/null >/dev/null 2>&1 &`,
    "esac", 'exec /usr/bin/git "$@"', ""].join("\n"));
  chmodSync(join(bin, "git"), 0o755);
  const path = process.env["PATH"];
  process.env["PATH"] = `${bin}${delimiter}${path}`;
  let pgid = 0;
  const successor = new SingleInstanceLock(join(state, "agentcpd.lock"));
  try {
    const admitted = await runner.start(request);
    expect(admitted.allowed).toBe(false);
    expect(adapter.launches).toBe(0);
    await waitFor(() => existsSync(childFile) && readFileSync(childFile, "utf8").trim() !== "");
    pgid = Number(readFileSync(parentFile, "utf8").trim());
    const child = Number(readFileSync(childFile, "utf8").trim());
    await waitFor(() => !alive(pgid));
    expect(groupAlive(pgid)).toBe(true);
    expect(alive(child)).toBe(true);
    expect((await daemon.stop()).complete).toBe(true);
    expect(groupAlive(pgid)).toBe(false);
    expect(alive(child)).toBe(false);
    expect(successor.acquire(h.cp.clock.nowIso()).allowed).toBe(true);
    writeFileSync(release, "resume after authority release");
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(existsSync(done)).toBe(false);
  } finally {
    process.env["PATH"] = path;
    if (pgid) { try { process.kill(-pgid, "SIGKILL"); } catch {} }
    successor.release();
    daemon.lock.release();
    adapter.killAll();
  }
});

it("ordinary worker success leaves no tracked git process group and permits normal stop/start", async () => {
  const { h, world, adapter, runner, state, daemon, request } = fixture();
  const groups: number[] = [];
  const track = GitChildren.prototype.track;
  const spy = vi.spyOn(GitChildren.prototype, "track").mockImplementation(function (this: GitChildren, child) {
    if (child.pid !== undefined) groups.push(child.pid);
    return track.call(this, child);
  });
  const successor = new SingleInstanceLock(join(state, "agentcpd.lock"));
  try {
    const started = await runner.start(request);
    if (!started.allowed) throw new Error(started.message);
    await runner.settled(started.value.executionId);
    expect(world.tasks.execution(started.value.executionId)!.status).toBe("SUCCEEDED");
    expect(groups.length).toBeGreaterThan(0);
    expect(groups.filter(groupAlive)).toEqual([]);
    expect((await daemon.stop()).complete).toBe(true);
    expect(existsSync(successor.fencePath)).toBe(false);
    expect(successor.acquire(h.cp.clock.nowIso()).allowed).toBe(true);
  } finally {
    spy.mockRestore();
    successor.release();
    daemon.lock.release();
    adapter.killAll();
  }
});

it("normal agentcpd main stop/start reuses the same state directory without a git fence", async () => {
  const root = tempDir("acp-review-normal-restart-");
  const lock = join(root, ".agent-control-plane", "agentcpd.lock");
  const environment = { ...process.env, HOME: root, TMPDIR: "/private/tmp", USER: "startup-owner",
    ACP_MCP_TOKEN: "startup-mcp-token", ACP_OPERATOR_TOKEN: "startup-operator-token",
    ACP_OPERATOR_ACTOR: "startup-owner", ACP_STARTUP_TEST_ROOT: root };
  for (const name of Object.keys(environment)) {
    if (name.startsWith("ACP_TELEGRAM_") || name.startsWith("ACP_CANONICAL_") || name.startsWith("ACP_BUZZ_") ||
      name.startsWith("ACP_STARTUP_TEST_") && name !== "ACP_STARTUP_TEST_ROOT" || name === "BUZZ_PRIVATE_KEY") {
      delete (environment as Record<string, string | undefined>)[name];
    }
  }
  for (const seed of ["1", "0"]) {
    const child = spawn(process.execPath, ["--import", "tsx", "tests/helpers/run-agentcpd-main.ts"], {
      cwd: process.cwd(), env: { ...environment, ACP_STARTUP_TEST_SEED: seed }, stdio: ["ignore", "pipe", "pipe"],
    });
    const output: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => output.push(chunk));
    try {
      const code = await new Promise<number | null>(resolve => child.once("exit", resolve));
      expect(code, Buffer.concat(output).toString()).toBe(0);
      expect(Buffer.concat(output).toString()).toContain("shutting down on STARTUP_TEST");
      expect(existsSync(lock)).toBe(false);
      expect(existsSync(`${lock}.git-fence.json`)).toBe(false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }
}, 60_000);
import { spawn } from "node:child_process";
