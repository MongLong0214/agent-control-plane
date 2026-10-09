import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { Daemon } from "../../src/daemon/daemon.ts";
import { SingleInstanceLock } from "../../src/daemon/single-instance.ts";
import { plumbingWorkerCommit } from "../../src/run/worker-git.ts";
import { WorkerTurnEvent, WorkerTurnRunner, type WorkerTurnOptions } from "../../src/run/worker-turn.ts";
import type { ProviderAdapter } from "../../src/runtime/provider.ts";
import { cleanupTempDirs, gitSync, makeCore, tempDir } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";
import { FakeWorkerAdapter, admittingCapacity, seedWorkerWorld, type WorkerWorld } from "../helpers/worker-turn-fixture.ts";

/**
 * #1070 ACP-WORKER-03 round 3 — no turn commits or writes success once its daemon has begun to stop
 * or has released its authority, whichever point it resumes at.
 *
 * Two fences, both read live at the irreversible step: the runner's stop marker and the execution's
 * row. The ref update asks them under the index lock, with nothing awaited before the ref moves; the
 * success write asks them inside its own transaction. A drain that times out ends each remaining turn
 * ABANDONED in the database before the daemon releases its lock, so a resume after the release finds
 * nothing RUNNING.
 *
 * The daemon cases use the daemon's real 15 s drain. HOME is a private directory for this file.
 */
const isolatedHome = vi.hoisted(() => {
  const home = `${(process.env["TMPDIR"] ?? "/tmp").replace(/\/+$/, "")}/acp-worker-ends-home-${process.pid}`;
  process.env["HOME"] = home;
  return home;
});

const adapters: FakeWorkerAdapter[] = [];
afterEach(() => {
  for (const adapter of adapters.splice(0)) adapter.killAll();
});
afterAll(() => {
  cleanupTempDirs();
  rmSync(isolatedHome, { recursive: true, force: true });
});

const CHANGE = "module.exports = () => 2;\n";

const request = (world: WorkerWorld) => ({
  runId: world.runId,
  taskId: world.taskId,
  claimId: world.claimId,
  ownerSessionId: world.cto.sessionId,
  ownerBindingGeneration: world.cto.generation,
});

const waitFor = async (condition: () => boolean, what: string, timeoutMs = 10_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

/** A pause the test releases: `reached` once the turn waits on it. */
const pause = () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const state = { reached: false, release, wait: async () => { state.reached = true; await gate; } };
  return state;
};

/** A commit port around the real one that can wait before it, or after it. */
const pausedCommit = (at: "before" | "after", gate: ReturnType<typeof pause>): WorkerTurnOptions["commit"] => ({
  commit: async (repo, input) => {
    if (at === "before") await gate.wait();
    const made = await plumbingWorkerCommit.commit(repo, input);
    if (at === "after") await gate.wait();
    return made;
  },
});

const head = (world: WorkerWorld): string => gitSync(world.repoPath, ["rev-parse", "HEAD"]);

/** A world the daemon owns, with a runner the test configures installed as the daemon's own. */
const daemonWorld = (options: WorkerTurnOptions) => {
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
    { pollMs: 10, scratchDir: (prefix: string) => tempDir(prefix), ...options },
  );
  Object.defineProperty(h.cp, "workerTurns", { value: runner, configurable: true });
  const stateDir = tempDir("acp-daemon-ends-");
  const daemon = new Daemon(h.cp, { stateDir });
  expect(daemon.lock.acquire(h.cp.clock.nowIso()).allowed).toBe(true);
  const lockIsFree = (): boolean => {
    const successor = new SingleInstanceLock(join(stateDir, "agentcpd.lock"));
    const acquired = successor.acquire(h.cp.clock.nowIso()).allowed;
    if (acquired) successor.release();
    return acquired;
  };
  return { h, world, runner, daemon, lockIsFree };
};

const lateRefusals = (world: WorkerWorld, executionId: string) =>
  world.audit.byKind(WorkerTurnEvent.LATE_RESULT_REFUSED).filter((row) => row.evidence["executionId"] === executionId);

describe("#1070 ACP-WORKER-03 a turn that resumes after its daemon released its authority", () => {
  it("before the commit: the ref update is refused under the index lock, and the turn was ended before the release", async () => {
    const gate = pause();
    const { world, runner, daemon, lockIsFree } = daemonWorld({ commit: pausedCommit("before", gate) });
    const base = head(world);
    const started = await runner.start(request(world));
    if (!started.allowed) throw new Error(started.message);
    const executionId = started.value.executionId;
    await waitFor(() => gate.reached, "the turn to reach its commit");

    await daemon.stop();
    expect(lockIsFree()).toBe(true);
    // Durable before the release: the execution is no longer RUNNING, and the drain says which it ended.
    expect(world.tasks.execution(executionId)!.status).toBe("ABANDONED");
    expect(world.audit.byKind("TASK_WORKER_TURNS_DRAINED").at(-1)!.evidence["fenced"]).toEqual([executionId]);

    gate.release();
    await runner.settled(executionId);
    expect(head(world), "the branch moved after the daemon released its authority").toBe(base);
    expect(world.tasks.execution(executionId)!.status).toBe("ABANDONED");
    expect(world.audit.byKind(WorkerTurnEvent.SUCCEEDED)).toHaveLength(0);
    expect(lateRefusals(world, executionId).at(-1)!.evidence["reason"]).toBe("AUTHORITY_WITHDRAWN");
    expect(existsSync(join(world.repoPath, ".git", "index.lock"))).toBe(false);
    expect(readFileSync(join(world.repoPath, "src", "app.js"), "utf8")).toBe(CHANGE);
  }, 60_000);

  it("between the commit and the success write: the commit stands, success is never written", async () => {
    const gate = pause();
    const { world, runner, daemon, lockIsFree } = daemonWorld({ commit: pausedCommit("after", gate) });
    const base = head(world);
    const started = await runner.start(request(world));
    if (!started.allowed) throw new Error(started.message);
    const executionId = started.value.executionId;
    await waitFor(() => gate.reached, "the turn to make its commit");
    const committed = head(world);
    expect(committed).not.toBe(base);

    await daemon.stop();
    expect(lockIsFree()).toBe(true);
    expect(world.tasks.execution(executionId)!.status).toBe("ABANDONED");

    gate.release();
    await runner.settled(executionId);
    const execution = world.tasks.execution(executionId)!;
    expect(execution.status, "success was written after the daemon released its authority").toBe("ABANDONED");
    expect(execution.resultDigest).toBeNull();
    expect(world.audit.byKind(WorkerTurnEvent.SUCCEEDED)).toHaveLength(0);
    const late = lateRefusals(world, executionId).at(-1)!.evidence;
    expect(late["reason"]).toBe("AUTHORITY_WITHDRAWN");
    expect(late["commitHead"]).toBe(committed);
  }, 60_000);

  it("after the success write: the drain leaves the success and its commit as they are", async () => {
    const { world, runner, daemon, lockIsFree } = daemonWorld({});
    const base = head(world);
    const started = await runner.start(request(world));
    if (!started.allowed) throw new Error(started.message);
    const executionId = started.value.executionId;
    await runner.settled(executionId);
    expect(world.tasks.execution(executionId)!.status).toBe("SUCCEEDED");
    const committed = head(world);

    await daemon.stop();
    expect(lockIsFree()).toBe(true);
    expect(world.audit.byKind("DAEMON_STOPPED").at(-1)!.evidence["drained"]).toBe(true);
    expect(world.audit.byKind("TASK_WORKER_TURNS_DRAINED").at(-1)!.evidence["fenced"]).toEqual([]);
    expect(world.tasks.execution(executionId)!.status).toBe("SUCCEEDED");
    expect(head(world)).toBe(committed);
    expect(committed).not.toBe(base);
    expect(lateRefusals(world, executionId)).toHaveLength(0);
  }, 60_000);
});

describe("#1070 ACP-WORKER-03 the fences are read live, not copied", () => {
  const world = (): { world: WorkerWorld; adapter: FakeWorkerAdapter } => {
    const seeded = seedWorkerWorld(makeCore());
    const adapter = new FakeWorkerAdapter(seeded.broker);
    adapters.push(adapter);
    adapter.script = { writes: { "src/app.js": CHANGE } };
    return { world: seeded, adapter };
  };
  const runnerFor = (seeded: WorkerWorld, adapter: FakeWorkerAdapter, options: WorkerTurnOptions) =>
    new WorkerTurnRunner(
      { db: seeded.db, clock: seeded.clock, audit: seeded.audit, tasks: seeded.tasks, guard: seeded.guard, workerAdapter: () => adapter as ProviderAdapter },
      { pollMs: 10, scratchDir: (prefix: string) => tempDir(prefix), ...options },
    );

  it("a shutdown that begins while the commit waits refuses the ref update", async () => {
    const { world: seeded, adapter } = world();
    const gate = pause();
    const runner = runnerFor(seeded, adapter, { commit: pausedCommit("before", gate) });
    const base = head(seeded);
    const started = await runner.start(request(seeded));
    if (!started.allowed) throw new Error(started.message);
    await waitFor(() => gate.reached, "the turn to reach its commit");
    const stopping = runner.shutdown(10_000);
    gate.release();
    expect((await stopping).drained).toBe(true);
    expect(head(seeded)).toBe(base);
    expect(seeded.tasks.execution(started.value.executionId)!.status).toBe("ABANDONED");
  });

  it("a shutdown that begins between the commit and the success write refuses the success", async () => {
    const { world: seeded, adapter } = world();
    const gate = pause();
    const runner = runnerFor(seeded, adapter, { commit: pausedCommit("after", gate) });
    const started = await runner.start(request(seeded));
    if (!started.allowed) throw new Error(started.message);
    await waitFor(() => gate.reached, "the turn to make its commit");
    const stopping = runner.shutdown(10_000);
    gate.release();
    expect((await stopping).drained).toBe(true);
    const execution = seeded.tasks.execution(started.value.executionId)!;
    expect(execution.status).toBe("ABANDONED");
    expect(execution.resultDigest).toBeNull();
    expect(seeded.audit.byKind(WorkerTurnEvent.SUCCEEDED)).toHaveLength(0);
  });

  it("an execution ended elsewhere while the commit waits is never committed for", async () => {
    const { world: seeded, adapter } = world();
    const gate = pause();
    const runner = runnerFor(seeded, adapter, { commit: pausedCommit("before", gate) });
    const base = head(seeded);
    const started = await runner.start(request(seeded));
    if (!started.allowed) throw new Error(started.message);
    const executionId = started.value.executionId;
    await waitFor(() => gate.reached, "the turn to reach its commit");
    // A cancel, after the guard granted the commit and before the ref moves.
    expect(seeded.tasks.finishExecution(executionId, { status: "ABANDONED", failureClass: "infrastructure" }, seeded.runId).allowed).toBe(true);
    gate.release();
    await runner.settled(executionId);
    expect(head(seeded), "a commit was made for an execution that had ended").toBe(base);
    expect(seeded.audit.byKind(WorkerTurnEvent.SUCCEEDED)).toHaveLength(0);
  });
});
