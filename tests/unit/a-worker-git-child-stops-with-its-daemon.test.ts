import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { delimiter, join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { Daemon } from "../../src/daemon/daemon.ts";
import { SingleInstanceLock } from "../../src/daemon/single-instance.ts";
import { GitChildren, pinRepository, runPinnedGit } from "../../src/run/worker-git.ts";
import { WorkerTurnEvent, WorkerTurnRunner } from "../../src/run/worker-turn.ts";
import type { ProviderAdapter } from "../../src/runtime/provider.ts";
import { cleanupTempDirs, gitSync, makeRepo, tempDir } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";
import { FakeWorkerAdapter, admittingCapacity, seedWorkerWorld } from "../helpers/worker-turn-fixture.ts";

/**
 * #1070 ACP-WORKER-03, narrow review 1 — a stopping daemon owns its worker turns' git through the
 * release of its authority. A git child the drain left running — the update-ref, or the index update
 * after it — is killed with its process group and its exit observed before the daemon lock is
 * released; the repository is closed so nothing starts or publishes after; the execution records
 * whether the branch moved. A daemon that cannot confirm a git child stopped keeps its lock.
 *
 * The daemon cases use the daemon's real 15 s drain. HOME is a private directory for this file.
 */
const isolatedHome = vi.hoisted(() => {
  const home = `${(process.env["TMPDIR"] ?? "/tmp").replace(/\/+$/, "")}/acp-git-child-stops-home-${process.pid}`;
  process.env["HOME"] = home;
  return home;
});

const adapters: FakeWorkerAdapter[] = [];
const paused: number[] = [];
afterEach(() => {
  for (const adapter of adapters.splice(0)) adapter.killAll();
  for (const pid of paused.splice(0)) {
    try {
      process.kill(-pid, "SIGKILL");
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

const groupAlive = (pid: number): boolean => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * A git on PATH that, for the one call whose arguments contain `match`, records its pid and waits
 * until released, then runs the real git.
 */
const pausingGit = (match: string, options: { inSubshell?: boolean } = {}) => {
  const bin = tempDir("acp-git-pause-");
  const reached = join(bin, "reached");
  const release = join(bin, "release");
  const realGit = (process.env["PATH"] ?? "").split(delimiter).map((dir) => join(dir, "git")).find((path) => existsSync(path))!;
  writeFileSync(join(bin, "git"), (options.inSubshell
    ? [
      // The real git runs in a background subshell — a child of the git child — once released.
      "#!/bin/sh",
      `case "$*" in *"${match}"*)`,
      `  ( while [ ! -e '${release}' ]; do /bin/sleep 0.05; done; exec '${realGit}' "$@" ) &`,
      `  echo $$ > '${reached}'`,
      "  wait $!; exit $?;;",
      "esac",
      `exec '${realGit}' "$@"`,
      "",
    ]
    : [
      "#!/bin/sh",
      `case "$*" in *"${match}"*)`,
      `  echo $$ > '${reached}'`,
      `  while [ ! -e '${release}' ]; do /bin/sleep 0.05; done;;`,
      "esac",
      `exec '${realGit}' "$@"`,
      "",
    ]).join("\n"));
  chmodSync(join(bin, "git"), 0o755);
  return {
    bin,
    reached: () => existsSync(reached) && readFileSync(reached, "utf8").trim() !== "",
    pid: () => Number(readFileSync(reached, "utf8").trim()),
    release: () => writeFileSync(release, "resume"),
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
  const stateDir = tempDir("acp-daemon-git-");
  const daemon = new Daemon(h.cp, { stateDir });
  expect(daemon.lock.acquire(h.cp.clock.nowIso()).allowed).toBe(true);
  const successor = (): SingleInstanceLock | null => {
    const lock = new SingleInstanceLock(join(stateDir, "agentcpd.lock"));
    return lock.acquire(h.cp.clock.nowIso()).allowed ? lock : null;
  };
  return { h, world, runner, daemon, successor };
};

const head = (repo: string): string => gitSync(repo, ["rev-parse", "HEAD"]);

/** What the stopping daemon recorded about the execution's repository once its git was stopped. */
const stopDiagnostic = (world: ReturnType<typeof daemonWorld>["world"], executionId: string) =>
  world.audit.byKind(WorkerTurnEvent.GIT_STOPPED).filter((row) => row.evidence["executionId"] === executionId).at(-1)?.evidence;

/**
 * Runs `daemon.stop()` while asking, every few milliseconds, whether a successor could take the lock;
 * returns how often that was asked while the paused child was still alive. Every such ask must fail.
 */
const stopWatchingTheLock = async (
  daemon: Daemon,
  successor: () => SingleInstanceLock | null,
  child: number,
  whileStopping?: () => void,
): Promise<{ askedWhileChildAlive: number; heldThroughout: boolean }> => {
  let done = false;
  const stopping = daemon.stop().finally(() => {
    done = true;
  });
  let askedWhileChildAlive = 0;
  let heldThroughout = true;
  while (!done) {
    const childAlive = alive(child);
    const taken = successor();
    if (taken) {
      // Taken while stop() had not returned: only acceptable once the child is confirmed gone.
      taken.release();
      if (childAlive) heldThroughout = false;
    }
    if (childAlive) askedWhileChildAlive += 1;
    whileStopping?.();
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  await stopping;
  return { askedWhileChildAlive, heldThroughout };
};

describe("#1070 ACP-WORKER-03 a stopping daemon owns its turns' git through the release of its authority", () => {
  it("an update-ref child paused past the fence is killed and reaped before the successor can take the lock, and the branch never moves", async () => {
    const { world, runner, daemon, successor } = daemonWorld();
    const base = head(world.repoPath);
    const git = pausingGit("update-ref -m agent-control-plane: worker commit");
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
      await waitFor(git.reached, "the update-ref child to pause");
      const child = git.pid();
      paused.push(child);

      const watched = await stopWatchingTheLock(daemon, successor, child);
      expect(watched.askedWhileChildAlive, "the lock was never observed while the child lived").toBeGreaterThan(0);
      expect(watched.heldThroughout, "a successor took the lock while the update-ref child was alive").toBe(true);
      // Before anyone else can take the lock: the paused child and its whole group are gone.
      expect(alive(child), "the paused update-ref child outlived the daemon's authority").toBe(false);
      expect(groupAlive(child)).toBe(false);
      const next = successor();
      expect(next, "the successor could not take the released lock").not.toBeNull();
      const atAcquire = head(world.repoPath);
      expect(atAcquire).toBe(base);

      git.release();
      await runner.settled(executionId);
      expect(head(world.repoPath), "the branch moved after the successor took the lock").toBe(atAcquire);
      next!.release();

      expect(world.tasks.execution(executionId)!.status).toBe("ABANDONED");
      expect(world.audit.byKind(WorkerTurnEvent.SUCCEEDED)).toHaveLength(0);
      const diagnostic = stopDiagnostic(world, executionId)!;
      expect(diagnostic["refMoved"]).toBe(false);
      expect(diagnostic["headAtStop"]).toBe(base);
      expect(diagnostic["gitChildrenReaped"]).toBe(true);
      expect(diagnostic["indexLockLeft"]).toBe(false);
      expect(diagnostic["branchLockLeft"]).toBe(false);
      // Nothing of the turn's is left holding the repository, and its bytes are where it wrote them.
      expect(existsSync(join(world.repoPath, ".git", "index.lock"))).toBe(false);
      expect(gitSync(world.repoPath, ["diff", "--cached", "--name-only"])).toBe("");
      expect(readFileSync(join(world.repoPath, "src", "app.js"), "utf8")).toBe(CHANGE);
    } finally {
      git.release();
      process.env["PATH"] = path;
      if (executionId) await runner.settled(executionId);
    }
  }, 120_000);

  it("a branch that moved before the stop is recorded as moved, and nothing moves or publishes after the successor holds the lock", async () => {
    const { world, runner, daemon, successor } = daemonWorld();
    const base = head(world.repoPath);
    // Paused in the index update that follows the ref update: the branch has moved, the index has not.
    const git = pausingGit("update-index --no-split-index");
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
      await waitFor(git.reached, "the index-update child to pause");
      const child = git.pid();
      paused.push(child);
      const committed = head(world.repoPath);
      expect(committed).not.toBe(base);
      const indexBefore = readFileSync(join(world.repoPath, ".git", "index"));

      await daemon.stop();
      expect(alive(child)).toBe(false);
      const next = successor();
      expect(next).not.toBeNull();
      const atAcquire = head(world.repoPath);

      git.release();
      await runner.settled(executionId);
      expect(head(world.repoPath)).toBe(atAcquire);
      expect(readFileSync(join(world.repoPath, ".git", "index")).equals(indexBefore), "the index was published after the successor took the lock").toBe(true);
      next!.release();

      expect(world.tasks.execution(executionId)!.status).toBe("ABANDONED");
      expect(world.audit.byKind(WorkerTurnEvent.SUCCEEDED)).toHaveLength(0);
      const diagnostic = stopDiagnostic(world, executionId)!;
      expect(diagnostic["refMoved"]).toBe(true);
      expect(diagnostic["headAtStop"]).toBe(committed);
      expect(diagnostic["baseHead"]).toBe(base);
      expect(existsSync(join(world.repoPath, ".git", "index.lock"))).toBe(false);
      expect(readFileSync(join(world.repoPath, "src", "app.js"), "utf8")).toBe(CHANGE);
    } finally {
      git.release();
      process.env["PATH"] = path;
      if (executionId) await runner.settled(executionId);
    }
  }, 120_000);

  it("an update-ref child released during the drain completes under the daemon's authority, and nothing moves after the lock is released", async () => {
    const { world, runner, daemon, successor } = daemonWorld();
    const base = head(world.repoPath);
    const git = pausingGit("update-ref -m agent-control-plane: worker commit");
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
      await waitFor(git.reached, "the update-ref child to pause");
      const child = git.pid();
      paused.push(child);

      // The test chooses the order: the lock is asked for while the child is alive, then the child is
      // let go inside the drain, so it completes — moves the branch — while the daemon still holds it.
      let asks = 0;
      const watched = await stopWatchingTheLock(daemon, successor, child, () => {
        asks += 1;
        if (asks === 20) git.release();
      });
      expect(watched.askedWhileChildAlive).toBeGreaterThan(0);
      expect(watched.heldThroughout, "a successor took the lock while the update-ref child was alive").toBe(true);
      expect(alive(child)).toBe(false);
      expect(world.audit.byKind("DAEMON_STOPPED").at(-1)!.evidence["drained"]).toBe(true);

      const next = successor();
      expect(next).not.toBeNull();
      const atAcquire = head(world.repoPath);
      expect(atAcquire, "the released child's ref update did not complete under authority").not.toBe(base);
      await runner.settled(executionId);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(head(world.repoPath), "the branch moved after the successor took the lock").toBe(atAcquire);
      expect(existsSync(join(world.repoPath, ".git", "index.lock"))).toBe(false);
      next!.release();

      // It moved under authority, so it is recorded with its commit — and it never succeeded.
      expect(world.tasks.execution(executionId)!.status).toBe("ABANDONED");
      expect(world.audit.byKind(WorkerTurnEvent.SUCCEEDED)).toHaveLength(0);
      const failed = world.audit.byKind(WorkerTurnEvent.FAILED).filter((row) => row.evidence["executionId"] === executionId).at(-1)!.evidence;
      expect(failed["reason"]).toBe("DAEMON_STOPPING");
      expect(failed["commitHead"]).toBe(atAcquire);
      expect(readFileSync(join(world.repoPath, "src", "app.js"), "utf8")).toBe(CHANGE);
    } finally {
      git.release();
      process.env["PATH"] = path;
      if (executionId) await runner.settled(executionId);
    }
  }, 120_000);

  it("a git child's own children are stopped with it: the whole process group", async () => {
    const { world, runner, daemon, successor } = daemonWorld();
    const base = head(world.repoPath);
    const git = pausingGit("update-ref -m agent-control-plane: worker commit", { inSubshell: true });
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
      await waitFor(git.reached, "the update-ref child to pause");
      paused.push(git.pid());
      await daemon.stop();
      expect(groupAlive(git.pid()), "a process of the git child's group outlived the daemon's authority").toBe(false);
      const next = successor();
      expect(next).not.toBeNull();
      git.release();
      await runner.settled(executionId);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(head(world.repoPath), "the git child's own child moved the branch after the successor took the lock").toBe(base);
      next!.release();
    } finally {
      git.release();
      process.env["PATH"] = path;
      if (executionId) await runner.settled(executionId);
    }
  }, 120_000);

  it("a daemon that cannot confirm a worker git child stopped keeps its lock", async () => {
    const { h, daemon, successor } = daemonWorld();
    Object.defineProperty(h.cp, "workerTurns", {
      value: { shutdown: async () => ({ drained: false, outstanding: [], gitStopped: false }) },
      configurable: true,
    });
    await daemon.stop();
    expect(successor(), "a successor took authority while a git child might still run").toBeNull();
    const stopped = h.cp.audit.byKind("DAEMON_STOPPED").at(-1)!.evidence;
    expect(stopped["gitStopped"]).toBe(false);
    expect(stopped["lockRetained"]).toBe(true);
    daemon.lock.release();
  });
});

describe("#1070 ACP-WORKER-03 a turn's git children", () => {
  it("are not reported stopped until each one's exit is observed, within the bound", async () => {
    const children = new GitChildren();
    // A child whose exit is never observed — what an unkillable process looks like from here.
    const stuck = Object.assign(new EventEmitter(), { pid: 2_147_483_000, kill: () => true }) as unknown as ChildProcess;
    children.track(stuck);
    const startedAt = Date.now();
    const closed = await children.close(300);
    expect(closed.reaped).toBe(false);
    expect(closed.unreaped.map((group) => group.pgid)).toEqual([2_147_483_000]);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(300);
  });

  it("start nothing once their repository is closed, except the stopping daemon's own read", async () => {
    const repo = makeRepo({ "README.md": "# closed\n" });
    const pinned = pinRepository(repo, tempDir("acp-closed-scratch-"));
    if (!pinned.allowed) throw new Error(pinned.message);
    await pinned.value.children.close(1_000);
    const refused = await runPinnedGit(pinned.value, ["rev-parse", "HEAD"]);
    expect(refused.exitCode).toBeNull();
    expect(refused.stderr).toMatch(/closed by a stopping daemon/);
    const read = await runPinnedGit(pinned.value, ["rev-parse", "HEAD"], { afterClose: true });
    expect(read.exitCode).toBe(0);
  });
});
