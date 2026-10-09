import Database from "better-sqlite3";
import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { readProcessStartToken } from "../../src/core/process-argv.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import type { ExecutionRecord, TaskGraph } from "../../src/run/task-graph.ts";
import { WorkerTurnEvent, WorkerTurnRunner } from "../../src/run/worker-turn.ts";
import type { InvocationRequest, InvocationResult, ProviderAdapter } from "../../src/runtime/provider.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import {
  FakeWorkerAdapter,
  fileCore,
  forgeWorkerProcessRecord,
  seedWorkerWorld,
  type WorkerWorld,
} from "../helpers/worker-turn-fixture.ts";

/**
 * #1070 ACP-WORKER-03 — the worker-process record is not raw-writable, and nothing but the process an
 * execution launched is ever killed for it.
 *
 * A restart kills a recorded worker; a recorded worker that is outstanding keeps its task from another
 * turn. Raw SQL writers are in this repository's threat model. One that wrote a pid and start time into
 * an execution would point that kill at any process of this user; one that released, cleared, rewrote
 * or deleted the record would admit a retry while the old process still runs. Each witness writes from
 * the control plane's own connection and from a second, outside one — and where a trigger's own
 * protection is what is measured, from an outside connection that answers the authority itself.
 */

const adapters: FakeWorkerAdapter[] = [];
const outside: Database.Database[] = [];
const bystanders: ChildProcess[] = [];
afterEach(() => {
  for (const adapter of adapters.splice(0)) adapter.killAll();
  for (const connection of outside.splice(0)) connection.close();
  for (const child of bystanders.splice(0)) {
    try {
      process.kill(-(child.pid ?? 0), "SIGKILL");
    } catch {
      /* gone */
    }
  }
});
afterAll(cleanupTempDirs);

const NOW = "2026-10-04T00:00:00.000Z";
const RELEASE = "UPDATE task_executions SET worker_process_released_at = ? WHERE execution_id = ?";
const RECORD = "UPDATE task_executions SET worker_process_id = ?, worker_process_started_at = ? WHERE execution_id = ?";

const fileWorld = (): { world: WorkerWorld; path: string } => {
  const path = join(tempDir("acp-release-"), "state.sqlite");
  return { world: seedWorkerWorld(fileCore(path)), path };
};

/** An outside connection with no authority function at all, like every other SQLite client. */
const plainOutside = (path: string): Database.Database => {
  const connection = new Database(path);
  outside.push(connection);
  return connection;
};

/** An outside connection that answers both authorities itself: what is left is the write-once guards. */
const forgedOutside = (path: string): Database.Database => {
  const connection = plainOutside(path);
  connection.function("acp_worker_process_record_authorized", { varargs: true }, () => 1);
  connection.function("acp_worker_process_release_authorized", { varargs: true }, () => 1);
  return connection;
};

const makeRunner = (world: WorkerWorld, adapter: ProviderAdapter, tasks: TaskGraph = world.tasks): WorkerTurnRunner =>
  new WorkerTurnRunner(
    { db: world.db, clock: world.clock, audit: world.audit, tasks, guard: world.guard, workerAdapter: () => adapter },
    { pollMs: 10, processSettleMs: 200, scratchDir: (prefix) => tempDir(prefix) },
  );

const fakeFor = (world: WorkerWorld): FakeWorkerAdapter => {
  const adapter = new FakeWorkerAdapter(world.broker);
  adapters.push(adapter);
  return adapter;
};

const startOf = (world: WorkerWorld, runner: WorkerTurnRunner) => runner.start({
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

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A refusal's message; empty for an admitted decision. */
const messageOf = (decision: { allowed: boolean; message?: string }): string => (decision.allowed ? "" : decision.message ?? "");

const refusal = (write: () => unknown): string => {
  try {
    write();
  } catch (error) {
    const reasonCode = (error as { reasonCode?: string }).reasonCode;
    return `${reasonCode ?? "raw"}: ${error instanceof Error ? error.message : String(error)}`;
  }
  return "ADMITTED";
};

/** A harmless live process of this user that no execution launched: the stand-in for anything else running. */
const bystander = async (): Promise<{ pid: number; token: string }> => {
  const child = spawn("/bin/sleep", ["300"], { detached: true, stdio: "ignore" });
  bystanders.push(child);
  const pid = child.pid!;
  let token: string | null = null;
  await waitFor(() => (token = readProcessStartToken(pid)) !== null, "the bystander's start time");
  return { pid, token: token! };
};

/** A runtime-managed execution with no process yet, as `task_worker_run` opens one. */
const openExecution = (world: WorkerWorld): string => {
  const started = world.tasks.startExecution({
    runId: world.runId, taskId: world.taskId, ownerBindingGeneration: world.cto.generation, workerSessionId: world.worker.sessionId,
    provider: "claude", model: "opus", repositoryId: world.repositoryId, worktreeId: world.repoPath, runtimeManaged: true,
  });
  if (!started.allowed) throw new Error(started.message);
  return started.value.executionId;
};

/** An orphan the restart could not identify: its recorded start time does not match, so it is never killed. */
const outstandingOrphan = async (world: WorkerWorld) => {
  const adapter = fakeFor(world);
  adapter.script = { hold: true, ignoreAbort: true, reportedStartedAt: "darwin-tv:1.000000" };
  const runner = makeRunner(world, adapter);
  const started = await startOf(world, runner);
  if (!started.allowed) throw new Error(`start refused: ${started.reasonCode}`);
  const executionId = started.value.executionId;
  await waitFor(() => world.tasks.execution(executionId)!.workerProcessId !== null, "the worker process to be recorded");
  const restarted = makeRunner(world, adapter);
  expect(await restarted.reconcileAfterRestart()).toEqual([{ executionId, outcome: "UNIDENTIFIED" }]);
  return { adapter, runner, restarted, executionId, pid: world.tasks.execution(executionId)!.workerProcessId! };
};

/** The runner's view of its execution, with the recorded process misreported: the release it mints then names that. */
const misreporting = (tasks: TaskGraph, lie: Partial<ExecutionRecord>): TaskGraph =>
  new Proxy(tasks, {
    get(target, property) {
      if (property === "execution") {
        return (executionId: string) => {
          const real = target.execution(executionId);
          return real && real.workerProcessId !== null ? { ...real, ...lie } : real;
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });

/** A pid that named a process a moment ago and names none now. */
const exitedPid = async (): Promise<number> => {
  const child = spawn("/usr/bin/true", [], { stdio: "ignore" });
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  return child.pid!;
};

describe("#1070 a worker process is recorded only by the runner's own spawn report", () => {
  const forgedInsert = `INSERT INTO task_executions (execution_id, run_id, task_id, attempt, owner_binding_generation,
                                                     worker_session_id, provider, model, started_at, status, runtime_managed,
                                                     worker_process_id, worker_process_started_at)
      SELECT 'exec_forged_record', run_id, task_id, 99, owner_binding_generation, worker_session_id, provider, model,
             started_at, 'RUNNING', 1, ?, ? FROM task_executions WHERE execution_id = ?`;

  /** Nothing was recorded, so a restart has nothing to kill, and the bystander lives. */
  const expectNothingRecorded = async (world: WorkerWorld, executionId: string, pid: number) => {
    const execution = world.tasks.execution(executionId)!;
    expect(execution.workerProcessId).toBeNull();
    expect(execution.workerProcessStartedAt).toBeNull();
    expect(world.tasks.execution("exec_forged_record")).toBeNull();
    expect(await makeRunner(world, fakeFor(world)).reconcileAfterRestart()).toEqual([{ executionId, outcome: "NEVER_LAUNCHED" }]);
    expect(alive(pid)).toBe(true);
  };

  it("a raw pid and start time from the control plane's own connection is refused", async () => {
    const { world } = fileWorld();
    const { pid, token } = await bystander();
    const executionId = openExecution(world);
    expect(refusal(() => world.db.run(RECORD, [pid, token, executionId]))).toMatch(
      new RegExp(`^${ReasonCode.COMPLETION_AUTHORITY_DENIED}: .*TASK_EXECUTION_WORKER_PROCESS_RECORD_AUTHORITY_DENIED`),
    );
    // Nor is a runtime-managed row inserted already naming a process, or any row with a start time.
    expect(refusal(() => world.db.run(forgedInsert, [pid, token, executionId]))).toMatch(
      /TASK_EXECUTION_WORKER_PROCESS_RECORD_AUTHORITY_DENIED/,
    );
    await expectNothingRecorded(world, executionId, pid);
  });

  it("a raw pid and start time from an outside connection is refused", async () => {
    const { world, path } = fileWorld();
    const { pid, token } = await bystander();
    const executionId = openExecution(world);
    expect(refusal(() => plainOutside(path).prepare(RECORD).run(pid, token, executionId))).toMatch(
      /no such function: acp_worker_process_record_authorized/,
    );
    expect(refusal(() => plainOutside(path).prepare(forgedInsert).run(pid, token, executionId))).toMatch(
      /TASK_EXECUTION_WORKER_PROCESS_RECORD_AUTHORITY_DENIED/,
    );
    await expectNothingRecorded(world, executionId, pid);
  });

  it("a forged record naming a live unrelated process never gets it killed by a restart", async () => {
    const { world, path } = fileWorld();
    const { pid, token } = await bystander();
    const executionId = openExecution(world);
    // The one forgery the record trigger cannot see: an outside connection answering the authority itself.
    forgeWorkerProcessRecord(path, executionId, pid, token);
    expect(world.tasks.execution(executionId)!.workerProcessId).toBe(pid);

    const restarted = makeRunner(world, fakeFor(world));
    // Its pid, its start time and a single claim all match; its command line carries no worker session.
    expect(await restarted.reconcileAfterRestart()).toEqual([{ executionId, outcome: "UNIDENTIFIED" }]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(alive(pid), "the restart killed a process this execution never launched").toBe(true);
    const evidence = world.audit.byKind(WorkerTurnEvent.ORPHAN_UNIDENTIFIED).at(-1)!.evidence;
    expect(evidence["ownership"]).toBe("COMMAND_LINE_NOT_CONFIRMED");
    expect(evidence["killed"]).toBe(false);
    // Unconfirmed, it blocks its task instead.
    const retry = await startOf(world, restarted);
    expect(retry.allowed).toBe(false);
    expect(messageOf(retry)).toMatch(/not confirmed gone/);
  });

  it("a provider that reports another live process as its own never gets it killed when its turn ends", async () => {
    const { world } = fileWorld();
    const { pid, token } = await bystander();
    // The record authority names whatever the spawn report says; only the kill path can tell.
    class MisreportingAdapter extends FakeWorkerAdapter {
      override invoke(request: InvocationRequest): Promise<InvocationResult> {
        return super.invoke({ ...request, onSpawn: () => request.onSpawn?.(pid, token) });
      }
    }
    const adapter = new MisreportingAdapter(world.broker);
    adapters.push(adapter);
    adapter.script = { writes: { "src/app.js": "module.exports = () => 2;\n" } };
    const runner = makeRunner(world, adapter);
    const started = await startOf(world, runner);
    if (!started.allowed) throw new Error(`start refused: ${started.reasonCode}`);
    await runner.settled(started.value.executionId);
    expect(alive(pid), "the runner killed a process its turn never launched").toBe(true);
    expect(world.tasks.execution(started.value.executionId)!.status).toBe("FAILED");
    const view = runner.describe(started.value.executionId, world.runId);
    expect(view.allowed && view.value.diagnostics?.evidence["reason"]).toBe("PROCESS_OUTSTANDING");
  });

  it("the genuine spawn path still records its own child, and a restart kills it", async () => {
    const { world } = fileWorld();
    const adapter = fakeFor(world);
    adapter.script = { hold: true, ignoreAbort: true };
    const runner = makeRunner(world, adapter);
    const started = await startOf(world, runner);
    if (!started.allowed) throw new Error(`start refused: ${started.reasonCode}`);
    const executionId = started.value.executionId;
    await waitFor(() => world.tasks.execution(executionId)!.workerProcessId !== null, "the worker process to be recorded");
    const pid = world.tasks.execution(executionId)!.workerProcessId!;
    expect(world.tasks.execution(executionId)!.workerProcessStartedAt).toBe(readProcessStartToken(pid));

    expect(await makeRunner(world, adapter).reconcileAfterRestart()).toEqual([{ executionId, outcome: "KILLED" }]);
    expect(alive(pid)).toBe(false);
    expect(world.tasks.execution(executionId)!.workerProcessReleasedAt).not.toBeNull();
    await runner.settled(executionId);
  });
});

describe("#1070 a worker process is released only by the runner that confirmed it gone", () => {
  it("a raw release from an outside connection is refused, and the retry stays refused", async () => {
    const { world, path } = fileWorld();
    const { restarted, executionId, pid } = await outstandingOrphan(world);
    // An outside connection has no release authority to hold at all.
    expect(refusal(() => plainOutside(path).prepare(RELEASE).run(NOW, executionId))).toMatch(/acp_worker_process_release_authorized/);
    expect(world.tasks.execution(executionId)!.workerProcessReleasedAt).toBeNull();
    expect(alive(pid)).toBe(true);
    const retry = await startOf(world, restarted);
    expect(retry.allowed).toBe(false);
    expect(messageOf(retry)).toMatch(/not confirmed gone/);
  });

  it("a raw release from the control plane's own connection is refused, the retry stays refused, and the genuine release works", async () => {
    const { world } = fileWorld();
    const { adapter, runner, restarted, executionId, pid } = await outstandingOrphan(world);

    expect(refusal(() => world.db.run(RELEASE, [NOW, executionId]))).toMatch(
      new RegExp(`^${ReasonCode.COMPLETION_AUTHORITY_DENIED}: .*TASK_EXECUTION_WORKER_PROCESS_RELEASE_AUTHORITY_DENIED`),
    );
    expect(world.tasks.execution(executionId)!.workerProcessReleasedAt).toBeNull();
    expect(alive(pid)).toBe(true);

    const whileAlive = await startOf(world, restarted);
    expect(whileAlive.allowed).toBe(false);
    expect(whileAlive.reasonCode).toBe(ReasonCode.CONFLICT);
    expect(messageOf(whileAlive)).toMatch(/not confirmed gone/);

    // The genuine release still works: once the process is gone, the runner confirms it and records it.
    adapter.killAll();
    await runner.settled(executionId);
    await waitFor(() => {
      try {
        process.kill(-pid, 0);
        return false;
      } catch {
        return true;
      }
    }, "the orphan to exit");
    adapter.script = { writes: { "src/app.js": "module.exports = () => 2;\n" } };
    const retried = await startOf(world, restarted);
    expect(retried.allowed).toBe(true);
    expect(world.tasks.execution(executionId)!.workerProcessReleasedAt).not.toBeNull();
    if (retried.allowed) await restarted.settled(retried.value.executionId);
  });

  it("the record of an outstanding process cannot be cleared, rewritten or deleted, even by a forged authority", async () => {
    const { world, path } = fileWorld();
    const { restarted, executionId, pid } = await outstandingOrphan(world);
    const forged = forgedOutside(path);
    const writes: Array<[string, string, unknown[]]> = [
      ["clear the pid", "UPDATE task_executions SET worker_process_id = NULL WHERE execution_id = ?", [executionId]],
      ["move the pid", "UPDATE task_executions SET worker_process_id = ? WHERE execution_id = ?", [pid + 1, executionId]],
      ["rewrite the start time", "UPDATE task_executions SET worker_process_started_at = ? WHERE execution_id = ?", ["darwin-tv:2.000000", executionId]],
      ["clear the start time", "UPDATE task_executions SET worker_process_started_at = NULL WHERE execution_id = ?", [executionId]],
      ["delete the row", "DELETE FROM task_executions WHERE execution_id = ?", [executionId]],
    ];
    for (const [what, sql, params] of writes) {
      expect(refusal(() => world.db.run(sql, params)), `${what} on the control plane's connection`).toMatch(
        new RegExp(`^${ReasonCode.CONFLICT}: .*TASK_EXECUTION_WORKER_PROCESS_IMMUTABLE`),
      );
      expect(refusal(() => forged.prepare(sql).run(...params)), `${what} on a forged outside connection`).toMatch(
        /TASK_EXECUTION_WORKER_PROCESS_IMMUTABLE/,
      );
    }
    const execution = world.tasks.execution(executionId)!;
    expect(execution.workerProcessId).toBe(pid);
    expect(execution.workerProcessStartedAt).toBe("darwin-tv:1.000000");
    expect(execution.workerProcessReleasedAt).toBeNull();
    const retry = await startOf(world, restarted);
    expect(retry.allowed).toBe(false);
    expect(messageOf(retry)).toMatch(/not confirmed gone/);
  });

  it("a release once written is never cleared or moved, even by a forged authority, and no row is inserted released", async () => {
    const { world, path } = fileWorld();
    const adapter = fakeFor(world);
    const runner = makeRunner(world, adapter);
    const started = await startOf(world, runner);
    if (!started.allowed) throw new Error(`start refused: ${started.reasonCode}`);
    const executionId = started.value.executionId;
    await runner.settled(executionId);
    // The runner's own release, after the provider's process exited.
    const released = world.tasks.execution(executionId)!.workerProcessReleasedAt;
    expect(released).not.toBeNull();
    const forged = forgedOutside(path);

    for (const value of [null, "2099-01-01T00:00:00.000Z"]) {
      expect(refusal(() => world.db.run(RELEASE, [value, executionId]))).toMatch(
        new RegExp(`^${ReasonCode.CONFLICT}: .*TASK_EXECUTION_WORKER_PROCESS_IMMUTABLE`),
      );
      expect(refusal(() => forged.prepare(RELEASE).run(value, executionId))).toMatch(/TASK_EXECUTION_WORKER_PROCESS_IMMUTABLE/);
    }
    expect(world.tasks.execution(executionId)!.workerProcessReleasedAt).toBe(released);

    const inserted = `INSERT INTO task_executions (execution_id, run_id, task_id, attempt, owner_binding_generation,
                                                   worker_session_id, provider, model, started_at, status,
                                                   worker_process_released_at)
      SELECT 'exec_forged_release', run_id, task_id, 99, owner_binding_generation, worker_session_id, provider, model,
             started_at, 'FAILED', ? FROM task_executions WHERE execution_id = ?`;
    expect(refusal(() => world.db.run(inserted, [NOW, executionId]))).toMatch(/TASK_EXECUTION_WORKER_PROCESS_RELEASE_AUTHORITY_DENIED/);
    expect(refusal(() => plainOutside(path).prepare(inserted).run(NOW, executionId))).toMatch(
      /TASK_EXECUTION_WORKER_PROCESS_RELEASE_AUTHORITY_DENIED/,
    );
    expect(world.tasks.execution("exec_forged_release")).toBeNull();
  });

  for (const [field, lie] of [
    ["pid", async (): Promise<Partial<ExecutionRecord>> => ({ workerProcessId: await exitedPid() })],
    ["start time", async (): Promise<Partial<ExecutionRecord>> => ({ workerProcessStartedAt: "darwin-tv:1.000001" })],
  ] as const) {
    it(`the release authority names the ${field} too, not only the execution`, async () => {
      const { world } = fileWorld();
      const adapter = fakeFor(world);
      adapter.script = {};
      // The runner mints its release for the process it believes it is releasing; here that belief is
      // wrong in one field, so the authority names a process the row does not record.
      const runner = makeRunner(world, adapter, misreporting(world.tasks, await lie()));
      const started = await startOf(world, runner);
      if (!started.allowed) throw new Error(`start refused: ${started.reasonCode}`);
      const executionId = started.value.executionId;
      await runner.settled(executionId);
      expect(world.tasks.execution(executionId)!.workerProcessId).not.toBeNull();
      expect(world.tasks.execution(executionId)!.workerProcessReleasedAt, "a release for another process was accepted").toBeNull();

      // The release for the process the row does record still goes through.
      expect(await makeRunner(world, adapter).reconcileAfterRestart()).toEqual([{ executionId, outcome: "GONE" }]);
      expect(world.tasks.execution(executionId)!.workerProcessReleasedAt).not.toBeNull();
    });
  }
});

describe("#1070 whether the runtime launched an execution is fixed at insert", () => {
  it("a raw flip of runtime_managed from either connection is refused", async () => {
    const { world, path } = fileWorld();
    const managed = openExecution(world);
    const flip = "UPDATE task_executions SET runtime_managed = ? WHERE execution_id = ?";
    expect(refusal(() => world.db.run(flip, [0, managed]))).toMatch(
      new RegExp(`^${ReasonCode.CONFLICT}: .*TASK_EXECUTION_RUNTIME_MANAGED_IMMUTABLE`),
    );
    expect(refusal(() => plainOutside(path).prepare(flip).run(0, managed))).toMatch(/TASK_EXECUTION_RUNTIME_MANAGED_IMMUTABLE/);
    expect(refusal(() => forgedOutside(path).prepare(flip).run(0, managed))).toMatch(/TASK_EXECUTION_RUNTIME_MANAGED_IMMUTABLE/);
    expect(world.tasks.execution(managed)!.runtimeManaged).toBe(true);

    // And the other way: a CTO-receipted execution never becomes the runtime's.
    world.tasks.finishExecution(managed, { status: "FAILED", failureClass: "infrastructure" }, world.runId);
    const receipted = world.tasks.startExecution({
      runId: world.runId, taskId: world.taskId, ownerBindingGeneration: world.cto.generation, workerSessionId: world.worker.sessionId,
      provider: "claude", model: "opus",
    });
    if (!receipted.allowed) throw new Error(receipted.message);
    const cto = receipted.value.executionId;
    expect(refusal(() => world.db.run(flip, [1, cto]))).toMatch(/TASK_EXECUTION_RUNTIME_MANAGED_IMMUTABLE/);
    expect(refusal(() => plainOutside(path).prepare(flip).run(1, cto))).toMatch(/TASK_EXECUTION_RUNTIME_MANAGED_IMMUTABLE/);
    expect(world.tasks.execution(cto)!.runtimeManaged).toBe(false);
  });
});
