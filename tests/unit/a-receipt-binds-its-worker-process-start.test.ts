import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { allow } from "../../src/core/errors.ts";
import type * as ProcessArgv from "../../src/core/process-argv.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Daemon } from "../../src/daemon/daemon.ts";
import type { RepairReceipt } from "../../src/doctor/repair.ts";
import { ExecutionMode } from "../../src/domain/types.ts";
import type { TaskContract } from "../../src/run/run-engine.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { bindWorker, type Harness, makeHarness, registerFixtureProject } from "../helpers/harness.ts";

/**
 * A CTO-opened receipt names its worker by pid. A pid is reused, so the receipt binds the process's OS
 * start as well, read when it opens, and every later liveness check asks for that exact process: a pid
 * now held by a process with another start is not the receipt's worker, and the receipt is abandoned
 * rather than kept RUNNING.
 *
 * A real pid reuse cannot be arranged on demand, so the reuse is simulated where it is observed: the
 * start token the OS reports for the worker's pid is replaced by a different one.
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
  goal: "bind a receipt to its worker process",
  why: "a pid alone is reused",
  scope: [],
  nonGoals: [],
  acceptance: ["a reused pid does not keep a receipt RUNNING"],
  priority: "NORMAL",
  humanGate: [],
  references: [],
};

/** A different process start than any real one: the pid's holder is not the process the receipt named. */
const ANOTHER_START = "darwin-tv:1.000001";

const children: ChildProcess[] = [];
const liveWorker = (): ChildProcess => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  children.push(child);
  return child;
};
const exitedPid = async (): Promise<number> => {
  const child = liveWorker();
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
  return child.pid!;
};

afterEach(async () => {
  reportedStart.clear();
  vi.restoreAllMocks();
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
  }
});
afterAll(cleanupTempDirs);

const openReceipt = async (workerProcessId: number) => {
  const harness = makeHarness();
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
  const task = harness.cp.tasks.submit(run.value.runId, [{ key: "work", title: "work", category: "implementation" }]);
  if (!task.allowed) throw new Error(task.message);
  const workerSessionId = bindWorker(harness, task.value[0]!.taskId);
  vi.spyOn(harness.cp.tasks, "admitWorkerFanout").mockResolvedValue(allow(ReasonCode.OK, undefined));
  // task_receipt_submit's writer for a `started` receipt.
  const receipt = await harness.cp.tasks.startWorkerExecution({
    runId: run.value.runId,
    taskId: task.value[0]!.taskId,
    ownerBindingGeneration: run.value.ownerBindingGeneration!,
    workerSessionId,
    workerProcessId,
    provider: "scripted",
    model: "scripted-worker",
    repositoryId,
  });
  return { harness, runId: run.value.runId, receipt };
};

const opened = async (workerProcessId: number) => {
  const { harness, runId, receipt } = await openReceipt(workerProcessId);
  if (!receipt.allowed) throw new Error(receipt.message);
  return { harness, runId, executionId: receipt.value.executionId };
};

const statusOf = (harness: Harness, executionId: string) => harness.cp.tasks.execution(executionId)?.status;

describe("a CTO receipt binds its worker process's start, not only its pid", () => {
  it("a receipt is not opened for a pid whose start cannot be read", async () => {
    const pid = await exitedPid();
    const { harness, runId, receipt } = await openReceipt(pid);
    expect(receipt.allowed).toBe(false);
    expect(receipt.reasonCode).toBe(ReasonCode.INVALID_ARGUMENT);
    expect(harness.cp.tasks.executions(runId)).toHaveLength(0);
  });

  it("restart: the pid held by a process with another start does not keep the receipt RUNNING", async () => {
    const worker = liveWorker();
    const { harness, executionId } = await opened(worker.pid!);
    reportedStart.set(worker.pid!, ANOTHER_START);

    const report = await new Daemon(harness.cp, { stateDir: tempDir("acp-d2-") }).reconcile();

    expect(statusOf(harness, executionId)).toBe("ABANDONED");
    expect(report.orphanedExecutions).toContain(executionId);
  });

  it("control — restart: the same process still running keeps its receipt RUNNING", async () => {
    const worker = liveWorker();
    const { harness, executionId } = await opened(worker.pid!);

    const report = await new Daemon(harness.cp, { stateDir: tempDir("acp-d2-") }).reconcile();

    expect(statusOf(harness, executionId)).toBe("RUNNING");
    expect(report.orphanedExecutions).not.toContain(executionId);
  });

  it("doctor: a receipt whose pid now has another start is reported as a dead worker", async () => {
    const worker = liveWorker();
    const { harness, runId, executionId } = await opened(worker.pid!);
    const deadWorker = async () => (await harness.cp.doctor.run("run", runId)).findings
      .filter((finding) => finding.code === "DEAD_WORKER_WITH_OPEN_RECEIPT")
      .map((finding) => (finding.observedEvidence as { executionId: string }).executionId);

    expect(await deadWorker()).not.toContain(executionId);
    reportedStart.set(worker.pid!, ANOTHER_START);
    expect(await deadWorker()).toContain(executionId);
  });

  it("repair: abandon_dead_executions counts a receipt whose pid now has another start", async () => {
    const worker = liveWorker();
    const { harness, executionId } = await opened(worker.pid!);
    const deadIds = async () => {
      const planned = await harness.cp.repair.execute({
        operationId: "abandon_dead_executions", parameters: {}, authorizedBy: "HERMES", dryRun: true,
      });
      // Refused when nothing is dead; the checked preconditions carry the same evidence either way.
      const checked = planned.allowed
        ? planned.value.preconditionsChecked
        : (planned.evidence as { preconditions: RepairReceipt["preconditionsChecked"] }).preconditions;
      return (checked[0]!.evidence as { deadExecutionIds: string[] }).deadExecutionIds;
    };

    expect(await deadIds()).not.toContain(executionId);
    reportedStart.set(worker.pid!, ANOTHER_START);
    expect(await deadIds()).toContain(executionId);
    expect(statusOf(harness, executionId)).toBe("RUNNING");
  });
});
