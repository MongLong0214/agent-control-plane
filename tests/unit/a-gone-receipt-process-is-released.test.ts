import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { allow } from "../../src/core/errors.ts";
import type * as ProcessArgv from "../../src/core/process-argv.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Daemon } from "../../src/daemon/daemon.ts";
import { ExecutionMode } from "../../src/domain/types.ts";
import type { TaskContract } from "../../src/run/run-engine.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { bindCeo, bindWorker, type Harness, makeHarness, registerFixtureProject } from "../helpers/harness.ts";

/**
 * A CTO-opened receipt has no runner to confirm its worker process gone, so the daemon does, at
 * restart and on its worker-retirement tick: once the pid the receipt named names no process and leads
 * no group, the process is recorded released through the release authority, once, whatever start the
 * receipt bound. A pid still held — by the worker, or by another process since, or with no start bound
 * to tell which — is not released.
 *
 * A pid reuse is simulated where it is observed: the start token the OS reports for the pid is replaced.
 */
const reportedStart = vi.hoisted(() => new Map<number, string | null>());
vi.mock("../../src/core/process-argv.ts", async (importOriginal) => {
  const original = await importOriginal<typeof ProcessArgv>();
  return {
    ...original,
    readProcessStartToken: (pid: number): string | null =>
      reportedStart.has(pid) ? reportedStart.get(pid)! : original.readProcessStartToken(pid),
  };
});

const CONTRACT: TaskContract = {
  goal: "release a CTO receipt's worker process once it is gone",
  why: "an outstanding process keeps its task from another turn",
  scope: [],
  nonGoals: [],
  acceptance: ["a gone receipt process is recorded released, once"],
  priority: "NORMAL",
  humanGate: [],
  references: [],
};

const ANOTHER_START = "darwin-tv:1.000001";

const children: ChildProcess[] = [];
const liveWorker = (): ChildProcess => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  children.push(child);
  return child;
};
const stop = async (child: ChildProcess): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
};

afterEach(async () => {
  reportedStart.clear();
  vi.restoreAllMocks();
  for (const child of children.splice(0)) await stop(child);
});
afterAll(cleanupTempDirs);

/** `daemonReady`: the credentials and CEO binding a daemon start needs. */
const openRun = async (taskKeys: string[], daemonReady = false) => {
  const harness = makeHarness();
  if (daemonReady) {
    harness.cp.credentials.install({ token: "test-token", creatorIdentity: "acp-trusted-app" });
    bindCeo(harness);
  }
  const { projectId, repositoryId } = await registerFixtureProject(harness);
  const created = harness.cp.runs.create({
    projectId,
    executionMode: ExecutionMode.STANDARD,
    contract: CONTRACT,
    repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
  });
  if (!created.allowed) throw new Error(created.message);
  const run = await harness.cp.runs.dispatch(created.value.runId);
  if (!run.allowed) throw new Error(run.message);
  const tasks = harness.cp.tasks.submit(
    run.value.runId,
    taskKeys.map((key) => ({ key, title: key, category: "implementation" })),
  );
  if (!tasks.allowed) throw new Error(tasks.message);
  vi.spyOn(harness.cp.tasks, "admitWorkerFanout").mockResolvedValue(allow(ReasonCode.OK, undefined));
  const receipt = (index: number, workerProcessId: number) => ({
    runId: run.value.runId,
    taskId: tasks.value[index]!.taskId,
    ownerBindingGeneration: run.value.ownerBindingGeneration!,
    workerSessionId: bindWorker(harness, tasks.value[index]!.taskId),
    workerProcessId,
    provider: "scripted",
    model: "scripted-worker",
    repositoryId,
  });
  return { harness, runId: run.value.runId, receipt };
};

/** task_receipt_submit's writer for a `started` receipt: binds the pid's OS start at open. */
const openedWithStart = async (worker: ChildProcess, daemonReady = false) => {
  const { harness, runId, receipt } = await openRun(["work"], daemonReady);
  const opened = await harness.cp.tasks.startWorkerExecution(receipt(0, worker.pid!));
  if (!opened.allowed) throw new Error(opened.message);
  return { harness, runId, executionId: opened.value.executionId };
};

const releasedAt = (harness: Harness, executionId: string): string | null =>
  harness.cp.db.get<{ released: string | null }>(
    `SELECT worker_process_released_at AS released FROM task_executions WHERE execution_id = ?`,
    [executionId],
  )!.released;

const statusOf = (harness: Harness, executionId: string) => harness.cp.tasks.execution(executionId)?.status;

const cancel = (harness: Harness, runId: string): void => {
  const cancelled = harness.cp.runs.cancel(runId, "operator cancelled the run");
  if (!cancelled.allowed) throw new Error(cancelled.message);
};

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const restartPass = (harness: Harness) => new Daemon(harness.cp, { stateDir: tempDir("acp-l13-") }).reconcile();

describe("a CTO receipt's worker process confirmed gone is recorded released", () => {
  it("a receipt whose process exited, cancelled to ABANDONED, is released by the restart pass exactly once", async () => {
    const worker = liveWorker();
    const { harness, runId, executionId } = await openedWithStart(worker);
    await stop(worker);
    cancel(harness, runId);
    expect(statusOf(harness, executionId)).toBe("ABANDONED");
    expect(releasedAt(harness, executionId)).toBeNull();

    await restartPass(harness);
    const released = releasedAt(harness, executionId);
    expect(released).not.toBeNull();

    await restartPass(harness);
    expect(releasedAt(harness, executionId)).toBe(released);
  });

  it("a pid now held by a process with another start is not released; once that pid is gone, it is", async () => {
    const worker = liveWorker();
    const { harness, runId, executionId } = await openedWithStart(worker);
    reportedStart.set(worker.pid!, ANOTHER_START);
    cancel(harness, runId);

    await restartPass(harness);
    expect(statusOf(harness, executionId)).toBe("ABANDONED");
    expect(releasedAt(harness, executionId)).toBeNull();

    await stop(worker);
    await restartPass(harness);
    expect(releasedAt(harness, executionId)).not.toBeNull();
  });

  it("a receipt that bound no start: released once its pid names no process, unreleased while the pid is held", async () => {
    const exited = liveWorker();
    const held = liveWorker();
    const { harness, runId, receipt } = await openRun(["exited", "held"]);
    // The synchronous primitive records a start it cannot read as unknown, as a receipt opened before
    // starts were bound has none.
    reportedStart.set(exited.pid!, null);
    reportedStart.set(held.pid!, null);
    const exitedReceipt = harness.cp.tasks.startExecution(receipt(0, exited.pid!));
    if (!exitedReceipt.allowed) throw new Error(exitedReceipt.message);
    const heldReceipt = harness.cp.tasks.startExecution(receipt(1, held.pid!));
    if (!heldReceipt.allowed) throw new Error(heldReceipt.message);
    await stop(exited);
    cancel(harness, runId);

    await restartPass(harness);
    expect(statusOf(harness, exitedReceipt.value.executionId)).toBe("ABANDONED");
    expect(releasedAt(harness, exitedReceipt.value.executionId)).not.toBeNull();
    expect(statusOf(harness, heldReceipt.value.executionId)).toBe("ABANDONED");
    expect(releasedAt(harness, heldReceipt.value.executionId)).toBeNull();
  });

  it("a live worker process is not released; once it exits, it is", async () => {
    const worker = liveWorker();
    const { harness, runId, executionId } = await openedWithStart(worker);
    cancel(harness, runId);

    await restartPass(harness);
    expect(statusOf(harness, executionId)).toBe("ABANDONED");
    expect(releasedAt(harness, executionId)).toBeNull();

    await stop(worker);
    await restartPass(harness);
    expect(releasedAt(harness, executionId)).not.toBeNull();
  });

  it("while the daemon runs, a cancelled receipt whose process exits is released by a later tick, with no restart", async () => {
    const worker = liveWorker();
    const { harness, runId, executionId } = await openedWithStart(worker, true);
    const daemon = new Daemon(harness.cp, { stateDir: tempDir("acp-l13-tick-"), watchdogIntervalMs: 25 });
    const tick = vi.spyOn(harness.cp.watchdog, "tick");
    const ticksAfter = async (count: number): Promise<void> => {
      const target = tick.mock.calls.length + count;
      const deadline = Date.now() + 10_000;
      while (tick.mock.calls.length < target && Date.now() < deadline) await delay(20);
      expect(tick.mock.calls.length).toBeGreaterThanOrEqual(target);
      await harness.cp.workerRetirement.settled();
    };
    try {
      const started = await daemon.start();
      if (!started.allowed) throw new Error(`${started.reasonCode}: ${started.message}`);
      cancel(harness, runId);
      expect(statusOf(harness, executionId)).toBe("ABANDONED");

      await ticksAfter(3);
      expect(releasedAt(harness, executionId)).toBeNull();

      await stop(worker);
      await ticksAfter(3);
      const released = releasedAt(harness, executionId);
      expect(released).not.toBeNull();

      await ticksAfter(3);
      expect(releasedAt(harness, executionId)).toBe(released);
    } finally {
      await daemon.stop();
    }
  });
});
