import { spawn } from "node:child_process";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { readProcessStartToken } from "../../src/core/process-argv.ts";
import { Daemon } from "../../src/daemon/daemon.ts";
import { SingleInstanceLock } from "../../src/daemon/single-instance.ts";
import { GitChildren } from "../../src/run/worker-git.ts";
import { WorkerTurnEvent, WorkerTurnRunner } from "../../src/run/worker-turn.ts";
import type { ProviderAdapter } from "../../src/runtime/provider.ts";
import { cleanupTempDirs, gitSync, tempDir } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";
import { FakeWorkerAdapter, admittingCapacity, seedWorkerWorld } from "../helpers/worker-turn-fixture.ts";

/**
 * #1070 ACP-WORKER-03, narrow review 2 — a worker git process group belongs to the daemon until it is
 * empty, not until its leader exits; and a stop that cannot confirm one empty fences the lock in a way
 * that outlives the daemon's process.
 *
 * The daemon cases use the daemon's real 15 s drain. HOME is a private directory for this file.
 */
const isolatedHome = vi.hoisted(() => {
  const home = `${(process.env["TMPDIR"] ?? "/tmp").replace(/\/+$/, "")}/acp-git-group-home-${process.pid}`;
  process.env["HOME"] = home;
  return home;
});

const adapters: FakeWorkerAdapter[] = [];
const groups: number[] = [];
afterEach(() => {
  for (const adapter of adapters.splice(0)) adapter.killAll();
  for (const pgid of groups.splice(0)) {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
});
afterAll(() => {
  cleanupTempDirs();
  rmSync(isolatedHome, { recursive: true, force: true });
});

const CHANGE = "module.exports = () => 2;\n";

const waitFor = async (condition: () => boolean, what: string, timeoutMs = 60_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const groupAlive = (pgid: number): boolean => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
};

const realGit = (): string =>
  (process.env["PATH"] ?? "").split(delimiter).map((dir) => join(dir, "git")).find((path) => existsSync(path))!;

/**
 * A git on PATH that, for the one call matching `match`, forks a paused descendant into its own group
 * and then either exits at once or runs the real git (so the turn goes on). Released, the descendant
 * runs `then` — a real ref update — and writes `done`.
 */
const forkingGit = (match: string, leader: "exits" | "runs-git", then: string) => {
  const bin = tempDir("acp-git-fork-");
  const files = { parent: join(bin, "parent"), child: join(bin, "child"), release: join(bin, "release"), done: join(bin, "done") };
  writeFileSync(join(bin, "descendant.sh"), [
    "#!/bin/sh",
    `echo $$ > '${files.child}'`,
    `while [ ! -e '${files.release}' ]; do /bin/sleep 0.05; done`,
    then,
    `echo $? > '${files.done}'`,
    "",
  ].join("\n"));
  writeFileSync(join(bin, "git"), [
    "#!/bin/sh",
    `case "$*" in *"${match}"*)`,
    `  echo $$ > '${files.parent}'`,
    // Detached from the git child's pipes when the leader goes on to run git, so that call can finish.
    leader === "exits"
      ? `  /bin/sh '${join(bin, "descendant.sh")}' &`
      : `  /bin/sh '${join(bin, "descendant.sh")}' </dev/null >/dev/null 2>&1 &`,
    leader === "exits" ? "  exit 0;;" : `  exec '${realGit()}' "$@";;`,
    "esac",
    `exec '${realGit()}' "$@"`,
    "",
  ].join("\n"));
  chmodSync(join(bin, "git"), 0o755);
  const read = (path: string): number => Number(readFileSync(path, "utf8").trim());
  return {
    bin,
    descendantPaused: () => existsSync(files.child) && readFileSync(files.child, "utf8").trim() !== "",
    parent: () => read(files.parent),
    child: () => read(files.child),
    release: () => writeFileSync(files.release, "resume"),
    done: () => existsSync(files.done),
  };
};

const daemonWorld = () => {
  const h = makeHarness();
  const world = seedWorkerWorld({
    db: h.cp.db, clock: h.cp.clock, audit: h.cp.audit, sessions: h.cp.sessions, bindings: h.cp.bindings, telemetry: h.cp.telemetry,
  });
  h.cp.tasks.attach({ capacity: admittingCapacity });
  const adapter = new FakeWorkerAdapter(world.broker);
  adapters.push(adapter);
  adapter.script = { writes: { "src/app.js": CHANGE } };
  const runner = new WorkerTurnRunner(
    { db: world.db, clock: world.clock, audit: world.audit, tasks: world.tasks, guard: world.guard, workerAdapter: () => adapter as ProviderAdapter },
    { pollMs: 10, scratchDir: (prefix: string) => tempDir(prefix) },
  );
  Object.defineProperty(h.cp, "workerTurns", { value: runner, configurable: true });
  const stateDir = tempDir("acp-daemon-group-");
  const daemon = new Daemon(h.cp, { stateDir });
  expect(daemon.lock.acquire(h.cp.clock.nowIso()).allowed).toBe(true);
  const successor = (): SingleInstanceLock | null => {
    const lock = new SingleInstanceLock(join(stateDir, "agentcpd.lock"));
    return lock.acquire(h.cp.clock.nowIso()).allowed ? lock : null;
  };
  return { h, world, runner, daemon, successor };
};

/** Runs `daemon.stop()` while asking for the lock; every ask while `member` lives must fail. */
const stopWatchingTheLock = async (
  daemon: Daemon,
  successor: () => SingleInstanceLock | null,
  member: number,
): Promise<{ askedWhileAlive: number; heldThroughout: boolean; complete: boolean }> => {
  let done = false;
  const stopping = daemon.stop().finally(() => {
    done = true;
  });
  let askedWhileAlive = 0;
  let heldThroughout = true;
  while (!done) {
    const memberAlive = alive(member);
    const taken = successor();
    if (taken) {
      taken.release();
      if (memberAlive) heldThroughout = false;
    }
    if (memberAlive) askedWhileAlive += 1;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return { askedWhileAlive, heldThroughout, complete: (await stopping).complete };
};

describe("#1070 ACP-WORKER-03 a worker git group is the daemon's until it is empty", () => {
  it("a group whose leader exited is held through shutdown, its descendant killed and confirmed gone before the lock is released", async () => {
    const { h, world, runner, daemon, successor } = daemonWorld();
    const base = gitSync(world.repoPath, ["rev-parse", "HEAD"]);
    const git = forkingGit("update-ref -m agent-control-plane: worker commit", "exits", `'${realGit()}' -C '${world.repoPath}' update-ref refs/heads/${world.branch} $('${realGit()}' -C '${world.repoPath}' commit-tree HEAD^{tree} -p HEAD -m late)`);
    const path = process.env["PATH"];
    process.env["PATH"] = `${git.bin}${delimiter}${path ?? ""}`;
    let executionId = "";
    try {
      const started = await runner.start({
        runId: world.runId, taskId: world.taskId, claimId: world.claimId,
        ownerSessionId: world.cto.sessionId, ownerBindingGeneration: world.cto.generation,
      });
      if (!started.allowed) throw new Error(started.message);
      executionId = started.value.executionId;
      await waitFor(git.descendantPaused, "the descendant to pause");
      const leader = git.parent();
      const descendant = git.child();
      groups.push(leader);
      await waitFor(() => !alive(leader), "the group's leader to exit");
      expect(groupAlive(leader), "the descendant left the group").toBe(true);

      const watched = await stopWatchingTheLock(daemon, successor, descendant);
      expect(watched.askedWhileAlive, "the lock was never observed while the descendant lived").toBeGreaterThan(0);
      expect(watched.heldThroughout, "a successor took the lock while the descendant was alive").toBe(true);
      expect(watched.complete).toBe(true);
      expect(alive(descendant), "the descendant outlived the daemon's authority").toBe(false);
      expect(groupAlive(leader)).toBe(false);

      const next = successor();
      expect(next).not.toBeNull();
      const atAcquire = gitSync(world.repoPath, ["rev-parse", "HEAD"]);
      git.release();
      await runner.settled(executionId);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(git.done(), "the descendant ran after the daemon released its authority").toBe(false);
      expect(gitSync(world.repoPath, ["rev-parse", "HEAD"])).toBe(atAcquire);
      expect(atAcquire).toBe(base);
      next!.release();
      expect(h.cp.audit.byKind("DAEMON_STOPPED").at(-1)!.evidence["gitStopped"]).toBe(true);
    } finally {
      git.release();
      process.env["PATH"] = path;
      if (executionId) await runner.settled(executionId);
    }
  }, 120_000);

  it("a settled turn's leftover group is stopped and confirmed gone before the lock is released", async () => {
    const { h, world, runner, daemon, successor } = daemonWorld();
    // The commit check's diff-tree leaves a paused descendant behind and then runs the real git, so the
    // turn itself succeeds and settles; released, the descendant would move the branch back.
    const git = forkingGit("diff-tree", "runs-git", `'${realGit()}' -C '${world.repoPath}' update-ref refs/heads/${world.branch} HEAD~1`);
    const path = process.env["PATH"];
    process.env["PATH"] = `${git.bin}${delimiter}${path ?? ""}`;
    let executionId = "";
    try {
      const started = await runner.start({
        runId: world.runId, taskId: world.taskId, claimId: world.claimId,
        ownerSessionId: world.cto.sessionId, ownerBindingGeneration: world.cto.generation,
      });
      if (!started.allowed) throw new Error(started.message);
      executionId = started.value.executionId;
      await runner.settled(executionId);
      expect(world.tasks.execution(executionId)!.status).toBe("SUCCEEDED");
      await waitFor(git.descendantPaused, "the descendant to pause");
      const leader = git.parent();
      const descendant = git.child();
      groups.push(leader);
      await waitFor(() => !alive(leader), "the group's leader to exit");
      const committed = gitSync(world.repoPath, ["rev-parse", "HEAD"]);

      const watched = await stopWatchingTheLock(daemon, successor, descendant);
      expect(watched.heldThroughout, "a successor took the lock while a settled turn's descendant was alive").toBe(true);
      expect(alive(descendant)).toBe(false);
      const next = successor();
      expect(next).not.toBeNull();
      git.release();
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(git.done()).toBe(false);
      expect(gitSync(world.repoPath, ["rev-parse", "HEAD"]), "a settled turn's descendant moved the branch after release").toBe(committed);
      next!.release();
      expect(h.cp.audit.byKind(WorkerTurnEvent.SHUTDOWN_DRAINED).at(-1)!.evidence["lingeringGroupsKilled"]).toBeGreaterThan(0);
    } finally {
      git.release();
      process.env["PATH"] = path;
    }
  }, 120_000);

  it("a group whose leader exited stays registered until it is empty, then close confirms it gone", async () => {
    const children = new GitChildren();
    const bin = tempDir("acp-group-unit-");
    const release = join(bin, "release");
    const leader = spawn("/bin/sh", ["-c", `( while [ ! -e '${release}' ]; do /bin/sleep 0.05; done ) & exit 0`], {
      detached: true,
      stdio: "ignore",
    });
    groups.push(leader.pid!);
    children.track(leader);
    await new Promise<void>((resolve) => leader.once("exit", () => resolve()));
    expect(groupAlive(leader.pid!)).toBe(true);
    expect(children.liveGroups().map((group) => group.pgid)).toEqual([leader.pid]);
    const closed = await children.close(5_000);
    expect(closed.reaped).toBe(true);
    expect(groupAlive(leader.pid!)).toBe(false);
    expect(children.liveGroups()).toEqual([]);
  });
});

describe("#1070 ACP-WORKER-03-FC an unconfirmed group fences the lock beyond the daemon's process", () => {
  it("a daemon that exits after an incomplete stop leaves a fence: refused while the group lives, reclaimed once it is gone", async () => {
    const stateDir = tempDir("acp-fence-exit-");
    const release = join(stateDir, "release");
    const ready = join(stateDir, "ready");
    const helper = fileURLToPath(new URL("../helpers/stopped-daemon-fence-child.ts", import.meta.url));
    const child = spawn(process.execPath, ["--experimental-transform-types", helper, stateDir, release, ready], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    const errors: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
    const report = JSON.parse(readFileSync(ready, "utf8")) as { daemonPid: number; pgid: number; complete: boolean };
    groups.push(report.pgid);
    // The incomplete stop reached the caller, and the process exited saying so.
    expect(code, Buffer.concat(errors).toString()).toBe(75);
    expect(report.complete).toBe(false);
    expect(alive(report.daemonPid)).toBe(false);
    expect(groupAlive(report.pgid)).toBe(true);

    const successor = new SingleInstanceLock(join(stateDir, "agentcpd.lock"));
    const refused = successor.acquire(new Date().toISOString());
    expect(refused.allowed, "a successor reclaimed the lock while the unconfirmed group lived").toBe(false);
    expect(existsSync(successor.fencePath)).toBe(true);

    writeFileSync(release, "the group may end now");
    await waitFor(() => !groupAlive(report.pgid), "the fenced group to end");
    const acquired = successor.acquire(new Date().toISOString());
    expect(acquired.allowed, acquired.allowed ? "" : acquired.message).toBe(true);
    expect(existsSync(successor.fencePath)).toBe(false);
    successor.release();
  }, 60_000);

  it("a fenced group id since reused by an unrelated process does not fence forever", async () => {
    const unrelated = spawn("/bin/sh", ["-c", "/bin/sleep 30"], { detached: true, stdio: "ignore" });
    groups.push(unrelated.pid!);
    await waitFor(() => readProcessStartToken(unrelated.pid!) !== null, "the unrelated process to start");

    // Recorded with its own start time, the group is the fenced one: refused.
    const fenced = new SingleInstanceLock(join(tempDir("acp-fence-reuse-"), "agentcpd.lock"));
    fenced.fence([{ pgid: unrelated.pid!, leaderStartedAt: readProcessStartToken(unrelated.pid!) }], new Date().toISOString());
    expect(fenced.acquire(new Date().toISOString()).allowed).toBe(false);

    // Recorded with another start time, the id belongs to someone else now: the fenced group is gone.
    // Its own state directory: a fence is never overwritten (narrow review 4), so the fence above
    // still stands beside its lock, as it should while that group runs.
    const lock = new SingleInstanceLock(join(tempDir("acp-fence-reuse-"), "agentcpd.lock"));
    lock.fence([{ pgid: unrelated.pid!, leaderStartedAt: "darwin-tv:1.000000" }], new Date().toISOString());
    const acquired = lock.acquire(new Date().toISOString());
    expect(acquired.allowed, acquired.allowed ? "" : acquired.message).toBe(true);
    expect(existsSync(lock.fencePath)).toBe(false);
    expect(alive(unrelated.pid!), "the unrelated process was touched").toBe(true);
    lock.release();
  });
});
