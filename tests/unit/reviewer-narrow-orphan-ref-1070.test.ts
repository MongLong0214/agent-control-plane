import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import { Daemon } from "../../src/daemon/daemon.ts";
import { SingleInstanceLock } from "../../src/daemon/single-instance.ts";
import { WorkerTurnEvent, WorkerTurnRunner } from "../../src/run/worker-turn.ts";
import { cleanupTempDirs, gitSync, tempDir } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";
import { FakeWorkerAdapter, admittingCapacity, seedWorkerWorld } from "../helpers/worker-turn-fixture.ts";

const isolatedHome = vi.hoisted(() => {
  const home = `/private/tmp/acp-review-orphan-home-${process.pid}`;
  process.env["HOME"] = home;
  return home;
});
afterAll(() => {
  cleanupTempDirs();
  rmSync(isolatedHome, { recursive: true, force: true });
});

const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
const groupAlive = (pid: number) => {
  try { process.kill(-pid, 0); return true; } catch { return false; }
};
const waitFor = async (condition: () => boolean, label: string) => {
  const deadline = Date.now() + 15_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};

it("ACP-WORKER-03: an exited git parent must not hide its paused update-ref descendant from shutdown", async () => {
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
  const stateDir = tempDir("acp-orphan-ref-daemon-");
  const daemon = new Daemon(h.cp, { stateDir });
  expect(daemon.lock.acquire(h.cp.clock.nowIso()).allowed).toBe(true);
  const base = gitSync(world.repoPath, ["rev-parse", "HEAD"]);
  const bin = tempDir("acp-orphan-ref-git-");
  const parentPidFile = join(bin, "parent-pid");
  const childPidFile = join(bin, "child-pid");
  const release = join(bin, "release");
  const done = join(bin, "done");
  const helper = join(bin, "descendant.sh");
  writeFileSync(helper, ["#!/bin/sh",
    `echo $$ > '${childPidFile}'`,
    `while [ ! -e '${release}' ]; do /bin/sleep 0.05; done`,
    '/usr/bin/git "$@"',
    `echo $? > '${done}'`, ""].join("\n"));
  writeFileSync(join(bin, "git"), ["#!/bin/sh",
    'case "$*" in *"update-ref -m agent-control-plane: worker commit"*)',
    `  echo $$ > '${parentPidFile}'`,
    `  /bin/sh '${helper}' "$@" &`,
    "  exit 0;;", "esac", 'exec /usr/bin/git "$@"', ""].join("\n"));
  chmodSync(join(bin, "git"), 0o755);
  const priorPath = process.env["PATH"];
  process.env["PATH"] = `${bin}${delimiter}${priorPath}`;
  let executionId = "";
  let parent = 0;
  let successor: SingleInstanceLock | null = null;
  try {
    const started = await runner.start({ runId: world.runId, taskId: world.taskId, claimId: world.claimId,
      ownerSessionId: world.cto.sessionId, ownerBindingGeneration: world.cto.generation });
    if (!started.allowed) throw new Error(started.message);
    executionId = started.value.executionId;
    await waitFor(() => existsSync(childPidFile) && readFileSync(childPidFile, "utf8").trim() !== "", "descendant paused");
    parent = Number(readFileSync(parentPidFile, "utf8").trim());
    const child = Number(readFileSync(childPidFile, "utf8").trim());
    await waitFor(() => !alive(parent), "direct child exited");
    expect(groupAlive(parent)).toBe(true);
    expect(alive(child)).toBe(true);
    expect(gitSync(world.repoPath, ["rev-parse", "HEAD"])).toBe(base);
    await daemon.stop();
    const stop = h.cp.audit.byKind("DAEMON_STOPPED").at(-1)!.evidence;
    successor = new SingleInstanceLock(join(stateDir, "agentcpd.lock"));
    const acquired = successor.acquire(h.cp.clock.nowIso());
    const atAcquire = gitSync(world.repoPath, ["rev-parse", "HEAD"]);
    const descendantAliveAtAcquire = alive(child);
    const groupAliveAtAcquire = groupAlive(parent);
    writeFileSync(release, "resume only after the authority-release check");
    // The oracle accepts "descendant dead": killed and reaped before authority release is a valid closure (CEO condition).
    await waitFor(() => existsSync(done) || !alive(child), "descendant's real update-ref completed");
    await runner.settled(executionId);
    const after = gitSync(world.repoPath, ["rev-parse", "HEAD"]);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ parent, child, stop, successorAllowed: acquired.allowed,
      descendantAliveAtAcquire, groupAliveAtAcquire, base, atAcquire, after,
      realGitExitCode: existsSync(done) ? readFileSync(done, "utf8").trim() : null,
      executionStatus: world.tasks.execution(executionId)!.status,
      successEvents: world.audit.byKind(WorkerTurnEvent.SUCCEEDED).length }));
    expect(after, "an untracked descendant moved HEAD after the successor acquired the daemon lock").toBe(atAcquire);
  } finally {
    writeFileSync(release, "cleanup");
    if (executionId) await runner.settled(executionId);
    if (parent) { try { process.kill(-parent, "SIGKILL"); } catch {} }
    successor?.release();
    daemon.lock.release();
    process.env["PATH"] = priorPath;
    adapter.killAll();
  }
}, 60_000);
