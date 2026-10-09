import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { deny } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Daemon } from "../../src/daemon/daemon.ts";
import type { AuditLog } from "../../src/db/audit.ts";
import { Role, SessionLifecycle } from "../../src/domain/types.ts";
import { WorkerTurnRunner, type WorkerProcessPort, type WorkerTurnOptions } from "../../src/run/worker-turn.ts";
import type { ProviderAdapter } from "../../src/runtime/provider.ts";
import { cleanupTempDirs, commitAll, gitSync, makeCore, tempDir } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";
import {
  FakeWorkerAdapter,
  admittingCapacity,
  fileCore,
  forgeWorkerProcessRecord,
  seedWorkerWorld,
  type WorkerWorld,
} from "../helpers/worker-turn-fixture.ts";

/**
 * #1070 round 1 — the six reviewer reproductions against a07e685b, recreated from the review's
 * descriptions (ACP-WORKER-01..04). Each is RED on a07e685b and GREEN after the repair.
 *
 * The daemon's own runner allocates scratch under HOME, so HOME is a private directory for this file.
 */
const isolatedHome = vi.hoisted(() => {
  const home = `${(process.env["TMPDIR"] ?? "/tmp").replace(/\/+$/, "")}/acp-reviewer-regressions-home-${process.pid}`;
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

const fakeFor = (world: WorkerWorld): FakeWorkerAdapter => {
  const adapter = new FakeWorkerAdapter(world.broker);
  adapters.push(adapter);
  return adapter;
};

const makeRunner = (
  world: WorkerWorld,
  adapter: ProviderAdapter,
  options: WorkerTurnOptions = {},
  audit: AuditLog = world.audit,
): WorkerTurnRunner =>
  new WorkerTurnRunner(
    { db: world.db, clock: world.clock, audit, tasks: world.tasks, guard: world.guard, workerAdapter: () => adapter },
    { pollMs: 10, scratchDir: (prefix: string) => tempDir(prefix), ...options } as WorkerTurnOptions,
  );

const startTurn = async (
  world: WorkerWorld,
  runner: WorkerTurnRunner,
  owner: { sessionId: string; generation: number } = world.cto,
) =>
  runner.start({
    runId: world.runId,
    taskId: world.taskId,
    claimId: world.claimId,
    ownerSessionId: owner.sessionId,
    ownerBindingGeneration: owner.generation,
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

/** A clean filter that leaves a marker outside every worktree when git runs it. */
const markerFilter = (marker: string): string => `[filter "evil"]\n\tclean = touch '${marker}'; cat\n`;

describe("#1070 round 1 reviewer reproductions", () => {
  it("ACP-WORKER-01a: an owned include target never makes the control plane's git run a filter", async () => {
    const world = seedWorkerWorld(makeCore());
    const marker = join(tempDir("acp-marker-"), "filter-ran");
    // Before the turn: the repository includes a tracked, owned file into its configuration.
    writeFileSync(join(world.repoPath, "src", "git.inc"), "[user]\n\tname = worker fixture\n");
    commitAll(world.repoPath, "add an included config");
    gitSync(world.repoPath, ["config", "include.path", "../src/git.inc"]);
    const adapter = fakeFor(world);
    adapter.script = {
      writes: {
        "src/app.js": "module.exports = () => 2;\n",
        "src/git.inc": markerFilter(marker),
        "src/.gitattributes": "* filter=evil\n",
      },
    };
    const runner = makeRunner(world, adapter);
    const started = await startTurn(world, runner);
    if (!started.allowed) throw new Error(started.message);
    await runner.settled(started.value.executionId);
    expect(existsSync(marker), "the control plane's git ran a worker-selected filter").toBe(false);
    expect(world.tasks.execution(started.value.executionId)!.status).not.toBe("SUCCEEDED");
  });

  it("ACP-WORKER-01b: a redirected .git file never points the control plane's git at another git dir", async () => {
    const world = seedWorkerWorld(makeCore(), { linkedWorktree: true });
    const marker = join(tempDir("acp-marker-"), "filter-ran");
    // Another git dir, outside the worktree, that runs a filter for every path.
    const evil = join(tempDir("acp-evil-gitdir-"), "git");
    cpSync(join(world.mainRepoPath, ".git"), evil, { recursive: true });
    const linkedGitDir = readFileSync(join(world.repoPath, ".git"), "utf8").replace(/^gitdir:\s*/, "").trim();
    cpSync(join(linkedGitDir, "index"), join(evil, "index"));
    writeFileSync(join(evil, "HEAD"), `ref: refs/heads/${world.branch}\n`);
    writeFileSync(join(evil, "config"), `${readFileSync(join(evil, "config"), "utf8")}${markerFilter(marker)}`);
    writeFileSync(join(evil, "info", "attributes"), "* filter=evil\n");
    const adapter = fakeFor(world);
    adapter.script = {
      writes: { "src/app.js": "module.exports = () => 2;\n" },
      whileLatched: () => {
        writeFileSync(join(world.repoPath, ".git"), `gitdir: ${evil}\n`);
      },
    };
    const runner = makeRunner(world, adapter);
    const started = await startTurn(world, runner);
    if (!started.allowed) throw new Error(started.message);
    await runner.settled(started.value.executionId);
    expect(existsSync(marker), "the control plane's git followed the redirected .git").toBe(false);
    expect(world.tasks.execution(started.value.executionId)!.status).not.toBe("SUCCEEDED");
  });

  it("ACP-WORKER-02: a success whose evidence cannot be stored is not a success", async () => {
    const world = seedWorkerWorld(makeCore());
    const adapter = fakeFor(world);
    // The success evidence write is refused; every other audit write goes through.
    const audit = {
      record: (entry: Parameters<AuditLog["record"]>[0]) =>
        entry.kind === "TASK_WORKER_TURN_SUCCEEDED"
          ? deny(ReasonCode.AUDIT_WRITE_FAILED, "injected: the success evidence cannot be stored", {})
          : world.audit.record(entry),
    } as unknown as AuditLog;
    const runner = makeRunner(world, adapter, {}, audit);
    const started = await startTurn(world, runner);
    if (!started.allowed) throw new Error(started.message);
    await runner.settled(started.value.executionId);
    const execution = world.tasks.execution(started.value.executionId)!;
    expect(execution.status).not.toBe("SUCCEEDED");
    expect(execution.resultDigest).toBeNull();
    const view = runner.describe(started.value.executionId, world.runId);
    expect(view.allowed && view.value.success).toBeNull();
  });

  it("ACP-WORKER-03a: after a takeover the abandoned worker stays outstanding until reconciled, and no turn starts first", async () => {
    const core = makeCore();
    const world = seedWorkerWorld(core);
    core.bindings.attach({ tasks: world.tasks });
    const adapter = fakeFor(world);
    // The worker outlives the runner that launched it, as it does when the daemon dies mid-abort.
    adapter.script = { hold: true, ignoreAbort: true };
    const original = makeRunner(world, adapter);
    const started = await startTurn(world, original);
    if (!started.allowed) throw new Error(started.message);
    const executionId = started.value.executionId;
    await waitFor(() => world.tasks.execution(executionId)!.workerProcessId !== null, "the worker process to be recorded");
    const pid = world.tasks.execution(executionId)!.workerProcessId!;

    // Takeover: the execution is ABANDONED and the task READY before the child is gone.
    const successor = core.sessions.create({ provider: "claude", model: "opus" });
    core.sessions.transition(successor.sessionId, SessionLifecycle.READY, "successor CTO");
    const taken = core.bindings.switchTo({
      role: Role.PRIMARY_CTO, projectId: world.projectId, sessionId: successor.sessionId,
      reason: "emergency takeover", conversation: "REPLACED", takeover: true,
    });
    if (!taken.allowed) throw new Error(taken.message);
    expect(world.tasks.execution(executionId)!.status).toBe("ABANDONED");
    const owner = { sessionId: successor.sessionId, generation: taken.value.bindingGeneration };
    world.claims.releaseRun(world.runId);
    const reclaimed = world.claims.acquire({
      runId: world.runId, ownerSessionId: owner.sessionId, ownerBindingGeneration: owner.generation,
      ownerRoleKey: world.cto.roleKey, repositoryIdentity: world.identity, branch: world.branch,
      worktreeId: world.repoPath, declaredPaths: world.ownedPaths,
    });
    if (!reclaimed.allowed) throw new Error(reclaimed.message);
    world.claimId = reclaimed.value.find((claim) => claim.worktreeId !== null)!.claimId;

    // The daemon "crashed": a fresh runner, the original worker still alive.
    adapter.script = { writes: { "src/app.js": "module.exports = () => 2;\n" } };
    const fresh = makeRunner(world, adapter);
    const premature = await startTurn(world, fresh, owner);
    expect(premature.allowed, "a new turn started while the abandoned worker was alive").toBe(false);
    expect(alive(pid)).toBe(true);
    expect(adapter.launches).toBe(1);

    const reconciled = await fresh.reconcileAfterRestart();
    expect(reconciled).toContainEqual({ executionId, outcome: "KILLED" });
    await waitFor(() => !alive(pid), "the abandoned worker to be gone", 3_000);
    await original.settled(executionId);

    const retried = await startTurn(world, fresh, owner);
    expect(retried.allowed).toBe(true);
    if (retried.allowed) await fresh.settled(retried.value.executionId);
  });

  it("ACP-WORKER-03b: Daemon.stop drains the worker turns it owns before it releases its authority", async () => {
    const h = makeHarness();
    const world = seedWorkerWorld({
      db: h.cp.db, clock: h.cp.clock, audit: h.cp.audit, sessions: h.cp.sessions, bindings: h.cp.bindings, telemetry: h.cp.telemetry,
    });
    h.cp.tasks.attach({ capacity: admittingCapacity });
    const adapter = fakeFor(world);
    adapter.script = { hold: true };
    h.cp.providers.registerForRole(adapter, Role.WORKER);
    const started = await h.cp.workerTurns.start({
      runId: world.runId, taskId: world.taskId, claimId: world.claimId,
      ownerSessionId: world.cto.sessionId, ownerBindingGeneration: world.cto.generation,
    });
    if (!started.allowed) throw new Error(`${started.reasonCode}: ${started.message}`);
    const executionId = started.value.executionId;
    await waitFor(() => h.cp.tasks.execution(executionId)!.workerProcessId !== null, "the worker process to be recorded");
    const pid = h.cp.tasks.execution(executionId)!.workerProcessId!;

    const daemon = new Daemon(h.cp, { stateDir: tempDir("acp-daemon-stop-") });
    expect(daemon.lock.acquire(h.cp.clock.nowIso()).allowed).toBe(true);
    await daemon.stop();

    expect(alive(pid), "the worker outlived the daemon's authority").toBe(false);
    expect(h.cp.tasks.execution(executionId)!.status).not.toBe("RUNNING");
    const kinds = h.cp.audit.all().map((row) => row.kind);
    expect(kinds).toContain("TASK_WORKER_TURNS_DRAINED");
    expect(kinds.indexOf("TASK_WORKER_TURNS_DRAINED")).toBeLessThan(kinds.lastIndexOf("DAEMON_STOPPED"));
  });

  it("ACP-WORKER-04: two receipts claiming one process never authorize killing it", async () => {
    const path = join(tempDir("acp-worker-04-"), "state.sqlite");
    const world = seedWorkerWorld(fileCore(path));
    const added = world.tasks.submit(world.runId, [{ key: "T2", title: "second task", category: "implementation" }]);
    if (!added.allowed) throw new Error(added.message);
    const second = added.value[0]!.taskId;
    const bound = world.bindings.bind({
      role: Role.WORKER, sessionId: world.worker.sessionId, taskId: second, runId: world.runId, projectId: world.projectId,
    });
    if (!bound.allowed) throw new Error(bound.message);
    const pid = 4_242_424;
    const token = "darwin-tv:1700000000.000001";
    for (const taskId of [world.taskId, second]) {
      const started = world.tasks.startExecution({
        runId: world.runId, taskId, ownerBindingGeneration: world.cto.generation, workerSessionId: world.worker.sessionId,
        provider: "claude", model: "opus", repositoryId: world.repositoryId, worktreeId: world.repoPath, runtimeManaged: true,
      });
      if (!started.allowed) throw new Error(started.message);
      // Only the runner's spawn report can record a process now (#1070), so the two claims are written
      // the one way a raw writer still could: an outside connection that answers the authority itself.
      forgeWorkerProcessRecord(path, started.value.executionId, pid, token);
    }
    const kills: number[] = [];
    // A process port double: the pid is alive, reports exactly the recorded start time, and carries the
    // worker session on its command line — everything but a single claim says it is this worker's.
    const processes: WorkerProcessPort = {
      startToken: () => token,
      alive: () => true,
      groupAlive: () => true,
      argv: () => ["claude", "-p", "--session-id", world.worker.externalSessionId],
      killGroup: (target) => kills.push(target),
    };
    const runner = makeRunner(world, fakeFor(world), { processes, processSettleMs: 50 } as WorkerTurnOptions);
    await runner.reconcileAfterRestart();
    expect(kills, "an ambiguously owned process was killed").toEqual([]);
  });
});
