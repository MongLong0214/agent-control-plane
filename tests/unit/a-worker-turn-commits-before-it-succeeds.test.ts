import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { sha256 } from "../../src/core/digest.ts";
import { canonical } from "../../src/guard/workspace-probe.ts";
import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Role, SessionLifecycle } from "../../src/domain/types.ts";
import { createCtoMcpPort, createCtoServer, type CtoMcpSource } from "../../src/mcp/cto-server.ts";
import {
  WorkerTurnEvent,
  WorkerTurnRunner,
  type WorkerTurnOptions,
  workerDiffDigest,
  workerSuccessDigest,
  type WorkerSuccessDigestInputs,
} from "../../src/run/worker-turn.ts";
import { cleanupTempDirs, gitSync, makeCore, tempDir } from "../helpers/fixtures.ts";
import { plumbingWorkerCommit } from "../../src/run/worker-git.ts";
import { makeHarness } from "../helpers/harness.ts";
import { FakeWorkerAdapter, seedWorkerWorld, type WorkerWorld } from "../helpers/worker-turn-fixture.ts";
import type { InvocationRequest, InvocationResult, ProviderAdapter } from "../../src/runtime/provider.ts";

/** Launches through the broker like the fake, but its spawn never reaches the receipt: no pid is recorded. */
class UnrecordedSpawnAdapter extends FakeWorkerAdapter {
  override invoke(request: InvocationRequest): Promise<InvocationResult> {
    return super.invoke({ ...request, onSpawn: undefined });
  }
}

const makeRunner = (world: WorkerWorld, adapter: ProviderAdapter, options: WorkerTurnOptions = {}): WorkerTurnRunner =>
  new WorkerTurnRunner(
    { db: world.db, clock: world.clock, audit: world.audit, tasks: world.tasks, guard: world.guard, workerAdapter: () => adapter },
    // Scratch for the pinned git calls stays in this test's own temp tree, never the daemon's state root.
    { pollMs: 10, scratchDir: (prefix) => tempDir(prefix), ...options },
  );

/**
 * #512 PR-B — `task_worker_run`: the control plane runs one worker turn, commits the worker's verified
 * change itself, and only then finishes the execution SUCCEEDED with a digest bound to that commit.
 * Every witness drives the real GuardedInvocationWriteBroker → Managed Write Guard through a fake
 * provider that counts launches and writes.
 */

const adapters: FakeWorkerAdapter[] = [];
afterEach(() => {
  for (const adapter of adapters.splice(0)) adapter.killAll();
});
afterAll(cleanupTempDirs);

const coreWorld = (options: Parameters<typeof seedWorkerWorld>[1] = {}): WorkerWorld => seedWorkerWorld(makeCore(), options);

const fakeFor = (world: WorkerWorld): FakeWorkerAdapter => {
  const adapter = new FakeWorkerAdapter(world.broker);
  adapters.push(adapter);
  return adapter;
};

const startTurn = async (world: WorkerWorld, runner: WorkerTurnRunner, timeoutMs?: number): Promise<string> => {
  const started = await runner.start({
    runId: world.runId,
    taskId: world.taskId,
    claimId: world.claimId,
    ownerSessionId: world.cto.sessionId,
    ownerBindingGeneration: world.cto.generation,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  if (!started.allowed) throw new Error(`start refused: ${started.reasonCode} ${started.message}`);
  return started.value.executionId;
};

const head = (world: WorkerWorld): string => gitSync(world.repoPath, ["rev-parse", "HEAD"]);
const fileAt = (world: WorkerWorld, path: string): string => readFileSync(join(world.repoPath, path), "utf8");
const taskState = (world: WorkerWorld): string => world.tasks.get(world.taskId)!.state;
const eventsOf = (world: WorkerWorld, kind: string) => world.audit.byKind(kind);

const waitFor = async (condition: () => boolean, what: string, timeoutMs = 10_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

/** A failure must carry no success digest anywhere and keep its diagnostics apart. */
const expectFailureShape = (world: WorkerWorld, runner: WorkerTurnRunner, executionId: string) => {
  const execution = world.tasks.execution(executionId)!;
  expect(execution.status).not.toBe("SUCCEEDED");
  expect(execution.resultDigest).toBeNull();
  expect(eventsOf(world, WorkerTurnEvent.SUCCEEDED)).toHaveLength(0);
  const view = runner.describe(executionId, world.runId);
  if (!view.allowed) throw new Error(view.message);
  expect(view.value.success).toBeNull();
  expect(view.value.diagnostics).not.toBeNull();
  return view.value.diagnostics!.evidence;
};

describe("#512 a worker turn commits before it succeeds", () => {
  it("W1 commits only the worker's owned change, then finishes SUCCEEDED bound to that exact HEAD", async () => {
    const world = coreWorld();
    const adapter = fakeFor(world);
    const base = head(world);
    let statusAtCommit: string | null = null;
    const runner = makeRunner(world, adapter, {
      commit: {
        commit: async (repo, input) => {
          // The ordering witness: at the moment the control plane commits, the receipt is still open.
          statusAtCommit = world.tasks.execution(world.tasks.executions(world.runId)[0]!.executionId)!.status;
          return plumbingWorkerCommit.commit(repo, input);
        },
      },
    });

    const executionId = await startTurn(world, runner);
    await runner.settled(executionId);

    const execution = world.tasks.execution(executionId)!;
    expect(execution.status).toBe("SUCCEEDED");
    expect(execution.runtimeManaged).toBe(true);
    expect(taskState(world)).toBe("SUCCEEDED");
    expect(statusAtCommit).toBe("RUNNING");
    expect(adapter.launches).toBe(1);
    expect(adapter.writes).toBe(1);
    expect(adapter.requests[0]!.model).toBe("opus");
    expect(adapter.requests[0]!.readOnly).toBe(false);
    expect(adapter.requests[0]!.workdir).toBe(canonical(world.repoPath));
    expect(adapter.requests[0]!.managedWrite?.targetPath).toBe(canonical(world.repoPath));
    expect(adapter.requests[0]!.externalSessionId).toBe(world.worker.externalSessionId);
    expect(adapter.requests[0]!.correlationId).toBe(executionId);
    expect(adapter.requests[0]!.managedWrite).toMatchObject({
      operation: "FILE_MUTATION",
      taskId: world.taskId,
      taskReceiptId: executionId,
      targetBranch: world.branch,
      runId: world.runId,
      sessionId: world.worker.sessionId,
      sessionIncarnation: world.worker.incarnation,
      bindingGeneration: world.worker.generation,
    });

    // The commit: one parent, the base; exactly the worker's change; nothing left over.
    const commitHead = head(world);
    expect(commitHead).not.toBe(base);
    expect(gitSync(world.repoPath, ["rev-parse", `${commitHead}^`])).toBe(base);
    expect(gitSync(world.repoPath, ["diff-tree", "--no-commit-id", "--name-only", "-r", base, commitHead])).toBe("src/app.js");
    expect(gitSync(world.repoPath, ["status", "--porcelain"])).toBe("");
    expect(gitSync(world.repoPath, ["log", "-1", "--format=%B", commitHead])).toBe("Make app() return 2");

    // The digest is recomputable from the audit inputs, and binds the exact commit HEAD.
    const succeeded = eventsOf(world, WorkerTurnEvent.SUCCEEDED);
    expect(succeeded).toHaveLength(1);
    const evidence = succeeded[0]!.evidence as unknown as WorkerSuccessDigestInputs & { resultDigest: string };
    const inputs: WorkerSuccessDigestInputs = {
      executionId: evidence.executionId,
      workerSessionId: evidence.workerSessionId,
      sessionIncarnation: evidence.sessionIncarnation,
      providerSessionId: evidence.providerSessionId,
      exitCode: evidence.exitCode,
      stdoutSha256: evidence.stdoutSha256,
      commitHead: evidence.commitHead,
      diffDigest: evidence.diffDigest,
    };
    expect(inputs.commitHead).toBe(commitHead);
    expect(inputs.workerSessionId).toBe(world.worker.sessionId);
    expect(inputs.sessionIncarnation).toBe(world.worker.incarnation);
    expect(workerSuccessDigest(inputs)).toBe(execution.resultDigest);
    expect(evidence.resultDigest).toBe(execution.resultDigest);

    // The diff digest is recomputable from the committed bytes; other bytes give other digests.
    const committedBytes = gitSync(world.repoPath, ["show", `${commitHead}:src/app.js`]) + "\n";
    const recomputed = workerDiffDigest(base, [{ path: "src/app.js", mode: "100644", sha256: sha256(committedBytes), blob: null }]);
    expect(recomputed).toBe(inputs.diffDigest);
    const otherBytes = workerDiffDigest(base, [{ path: "src/app.js", mode: "100644", sha256: sha256("module.exports = () => 3;\n"), blob: null }]);
    expect(otherBytes).not.toBe(inputs.diffDigest);
    expect(workerSuccessDigest({ ...inputs, diffDigest: otherBytes })).not.toBe(execution.resultDigest);
    expect(workerSuccessDigest({ ...inputs, commitHead: base })).not.toBe(execution.resultDigest);

    // SUCCEEDED came after the commit: the guard's commit grant is consumed before the finish receipt.
    const audit = world.audit.all();
    const commitConsumed = audit.findIndex(
      (row) => row.kind === "MANAGED_WRITE_GUARD_CONSUMED" && row.evidence["operation"] === "GIT_COMMIT",
    );
    const finished = audit.findIndex((row) => row.kind === "TASK_EXECUTION_FINISHED");
    expect(commitConsumed).toBeGreaterThan(-1);
    expect(finished).toBeGreaterThan(commitConsumed);

    // The read tool keeps the success digest and diagnostics apart.
    const view = runner.describe(executionId, world.runId);
    if (!view.allowed) throw new Error(view.message);
    expect(view.value.success?.resultDigest).toBe(execution.resultDigest);
    expect(view.value.diagnostics).toBeNull();
  });

  describe("W2 every failure ends without SUCCEEDED, without a success digest, with diagnostics, bytes preserved", () => {
    it("never-run", async () => {
      const world = coreWorld();
      const adapter = fakeFor(world);
      adapter.script = { neverRuns: true };
      const runner = makeRunner(world, adapter);
      const base = head(world);
      const executionId = await startTurn(world, runner);
      await runner.settled(executionId);
      expect(world.tasks.execution(executionId)!.status).toBe("FAILED");
      expect(taskState(world)).toBe("FAILED");
      const diagnostics = expectFailureShape(world, runner, executionId);
      expect(diagnostics["reason"]).toBe("NEVER_RAN");
      expect(adapter.launches).toBe(0);
      expect(head(world)).toBe(base);
    });

    it("exit 1", async () => {
      const world = coreWorld();
      const adapter = fakeFor(world);
      adapter.script = { writes: { "src/app.js": "module.exports = () => 2;\n" }, exitCode: 1 };
      const runner = makeRunner(world, adapter);
      const base = head(world);
      const executionId = await startTurn(world, runner);
      await runner.settled(executionId);
      expect(world.tasks.execution(executionId)!.status).toBe("FAILED");
      const diagnostics = expectFailureShape(world, runner, executionId);
      expect(diagnostics["reason"]).toBe("EXIT_NONZERO");
      expect(diagnostics["exitCode"]).toBe(1);
      expect(diagnostics["stdoutSha256"]).toMatch(/^sha256:/);
      expect(diagnostics["diffDigest"]).toMatch(/^sha256:/);
      expect(fileAt(world, "src/app.js")).toBe("module.exports = () => 2;\n");
      expect(head(world)).toBe(base);
    });

    it("timeout", async () => {
      const world = coreWorld();
      const adapter = fakeFor(world);
      adapter.script = { writes: { "src/app.js": "module.exports = () => 2;\n" }, hold: true };
      const runner = makeRunner(world, adapter);
      const base = head(world);
      const executionId = await startTurn(world, runner, 300);
      await runner.settled(executionId);
      expect(world.tasks.execution(executionId)!.status).toBe("TIMEOUT");
      expect(taskState(world)).toBe("FAILED");
      const diagnostics = expectFailureShape(world, runner, executionId);
      expect(diagnostics["reason"]).toBe("TIMEOUT");
      expect(diagnostics["diffDigest"]).toMatch(/^sha256:/);
      expect(fileAt(world, "src/app.js")).toBe("module.exports = () => 2;\n");
      expect(head(world)).toBe(base);
    });

    it("cancel while the effect is latched", async () => {
      const world = coreWorld();
      const adapter = fakeFor(world);
      adapter.script = {
        writes: { "src/app.js": "module.exports = () => 2;\n" },
        hold: true,
        whileLatched: () => {
          world.tasks.cancelAll(world.runId, "cancelled while the worker's write grant is in flight");
        },
      };
      const runner = makeRunner(world, adapter);
      const base = head(world);
      const executionId = await startTurn(world, runner);
      await runner.settled(executionId);
      expect(world.tasks.execution(executionId)!.status).toBe("ABANDONED");
      expect(taskState(world)).toBe("CANCELLED");
      const diagnostics = expectFailureShape(world, runner, executionId);
      expect(diagnostics["reason"]).toBe("EXECUTION_NO_LONGER_RUNNING");
      expect(eventsOf(world, WorkerTurnEvent.LATE_RESULT_REFUSED)).toHaveLength(1);
      expect(fileAt(world, "src/app.js")).toBe("module.exports = () => 2;\n");
      expect(head(world)).toBe(base);
      // The aborted child is gone; the late finish was refused rather than recorded.
      expect(adapter.launches).toBe(1);
    });

    it("takeover while the effect is latched", async () => {
      const core = makeCore();
      const world = seedWorkerWorld(core);
      core.bindings.attach({ tasks: world.tasks });
      const adapter = fakeFor(world);
      const successor = core.sessions.create({ provider: "claude", model: "opus" });
      core.sessions.transition(successor.sessionId, SessionLifecycle.READY, "successor CTO");
      adapter.script = {
        writes: { "src/app.js": "module.exports = () => 2;\n" },
        hold: true,
        whileLatched: () => {
          const taken = core.bindings.switchTo({
            role: Role.PRIMARY_CTO,
            projectId: world.projectId,
            sessionId: successor.sessionId,
            reason: "emergency takeover",
            conversation: "REPLACED",
            takeover: true,
          });
          if (!taken.allowed) throw new Error(`takeover refused: ${taken.reasonCode} ${taken.message}`);
        },
      };
      const runner = makeRunner(world, adapter);
      const base = head(world);
      const executionId = await startTurn(world, runner);
      await runner.settled(executionId);
      expect(world.tasks.execution(executionId)!.status).toBe("ABANDONED");
      expect(taskState(world)).toBe("READY");
      const diagnostics = expectFailureShape(world, runner, executionId);
      expect(diagnostics["reason"]).toBe("EXECUTION_NO_LONGER_RUNNING");
      expect(eventsOf(world, WorkerTurnEvent.LATE_RESULT_REFUSED)).toHaveLength(1);
      expect(fileAt(world, "src/app.js")).toBe("module.exports = () => 2;\n");
      expect(head(world)).toBe(base);
    });

    it("commit failure", async () => {
      const world = coreWorld();
      const adapter = fakeFor(world);
      const lock = join(world.repoPath, ".git", "refs", "heads", `${world.branch}.lock`);
      const runner = makeRunner(world, adapter, {
        commit: {
          commit: async (repo, input) => {
            // A real git refusal: another process holds the branch's ref lock when the commit moves it.
            writeFileSync(lock, "");
            try {
              return await plumbingWorkerCommit.commit(repo, input);
            } finally {
              rmSync(lock, { force: true });
            }
          },
        },
      });
      const base = head(world);
      const executionId = await startTurn(world, runner);
      await runner.settled(executionId);
      expect(world.tasks.execution(executionId)!.status).toBe("FAILED");
      const diagnostics = expectFailureShape(world, runner, executionId);
      expect(diagnostics["reason"]).toBe("COMMIT_FAILED");
      expect(fileAt(world, "src/app.js")).toBe("module.exports = () => 2;\n");
      expect(head(world)).toBe(base);
      expect(existsSync(lock)).toBe(false);
    });

    it("an out-of-scope change", async () => {
      const world = coreWorld();
      const adapter = fakeFor(world);
      adapter.script = { writes: { "src/app.js": "module.exports = () => 2;\n", "README.md": "# rewritten outside the claim\n" } };
      const runner = makeRunner(world, adapter);
      const base = head(world);
      const executionId = await startTurn(world, runner);
      await runner.settled(executionId);
      expect(world.tasks.execution(executionId)!.status).toBe("FAILED");
      const diagnostics = expectFailureShape(world, runner, executionId);
      expect(diagnostics["reason"]).toBe("OUT_OF_SCOPE");
      expect(diagnostics["uncovered"]).toEqual(["README.md"]);
      expect(fileAt(world, "src/app.js")).toBe("module.exports = () => 2;\n");
      expect(fileAt(world, "README.md")).toBe("# rewritten outside the claim\n");
      expect(head(world)).toBe(base);
    });

    describe("agent configuration is never a worker's change, even where the claim owns it", () => {
      const AGENT_OWNED = ["src", ".claude", ".mcp.json"];
      const GRANT = JSON.stringify({ permissions: { allow: ["Bash"] } });
      /**
       * The operator's global git excludes may already ignore `.claude/settings.local.json` (the CLI
       * offers to add it). Each witness states whether git ignores the file instead of inheriting it.
       */
      const agentWorld = (ignored: string | null): WorkerWorld => {
        const world = coreWorld({ ownedPaths: AGENT_OWNED });
        gitSync(world.repoPath, ["config", "core.excludesFile", "/dev/null"]);
        if (ignored !== null) writeFileSync(join(world.repoPath, ".git", "info", "exclude"), `${ignored}\n`);
        return world;
      };

      const expectRefusedUncommitted = async (world: WorkerWorld, adapter: FakeWorkerAdapter, path: string) => {
        const runner = makeRunner(world, adapter);
        const base = head(world);
        const executionId = await startTurn(world, runner);
        await runner.settled(executionId);
        expect(world.tasks.execution(executionId)!.status).toBe("FAILED");
        expect(taskState(world)).toBe("FAILED");
        const diagnostics = expectFailureShape(world, runner, executionId);
        expect(diagnostics["reason"]).toBe("OUT_OF_SCOPE");
        expect(diagnostics["agentConfiguration"]).toEqual([path]);
        expect(diagnostics["uncovered"]).toContain(path);
        expect(head(world)).toBe(base);
        expect(gitSync(world.repoPath, ["log", "--all", "--format=%H", "--", path])).toBe("");
        expect(fileAt(world, path)).toBe(GRANT);
        expect(fileAt(world, "src/app.js")).toBe("module.exports = () => 2;\n");
        return runner;
      };

      it("a turn that writes .claude/settings.local.json fails, uncommitted, bytes preserved", async () => {
        const world = agentWorld(null);
        const adapter = fakeFor(world);
        adapter.script = { writes: { "src/app.js": "module.exports = () => 2;\n", ".claude/settings.local.json": GRANT } };
        await expectRefusedUncommitted(world, adapter, ".claude/settings.local.json");
      });

      it("a turn that writes .claude/settings.local.json fails even where git ignores the file", async () => {
        const world = agentWorld(".claude/settings.local.json");
        const adapter = fakeFor(world);
        adapter.script = { writes: { "src/app.js": "module.exports = () => 2;\n", ".claude/settings.local.json": GRANT } };
        const runner = await expectRefusedUncommitted(world, adapter, ".claude/settings.local.json");
        // Left in place, it would be loaded by the next turn's CLI: that turn does not start.
        const next = await runner.start({
          runId: world.runId, taskId: world.taskId, claimId: world.claimId,
          ownerSessionId: world.cto.sessionId, ownerBindingGeneration: world.cto.generation,
        });
        expect(next.allowed).toBe(false);
        expect(next.reasonCode).toBe(ReasonCode.CONFLICT);
        expect(adapter.launches).toBe(1);
        expect(fileAt(world, ".claude/settings.local.json")).toBe(GRANT);
      });

      it("a turn that writes .mcp.json at the repository root fails, uncommitted, bytes preserved", async () => {
        const world = agentWorld(null);
        const adapter = fakeFor(world);
        adapter.script = { writes: { "src/app.js": "module.exports = () => 2;\n", ".mcp.json": GRANT } };
        await expectRefusedUncommitted(world, adapter, ".mcp.json");
      });

      it("a turn does not start on a worktree that holds untracked agent configuration", async () => {
        const world = agentWorld(".claude/");
        mkdirSync(join(world.repoPath, ".claude"), { recursive: true });
        writeFileSync(join(world.repoPath, ".claude", "settings.local.json"), GRANT);
        const adapter = fakeFor(world);
        const started = await makeRunner(world, adapter).start({
          runId: world.runId, taskId: world.taskId, claimId: world.claimId,
          ownerSessionId: world.cto.sessionId, ownerBindingGeneration: world.cto.generation,
        });
        expect(started.allowed).toBe(false);
        expect(started.reasonCode).toBe(ReasonCode.CONFLICT);
        expect(adapter.launches).toBe(0);
        expect(world.tasks.executions(world.runId)).toHaveLength(0);
        expect(fileAt(world, ".claude/settings.local.json")).toBe(GRANT);
      });
    });

    it("another writer changes an owned file between the turn and the commit", async () => {
      const world = coreWorld();
      const adapter = fakeFor(world);
      const runner = makeRunner(world, adapter, {
        beforeCommit: () => {
          writeFileSync(join(world.repoPath, "src", "app.js"), "module.exports = () => 'another writer';\n");
        },
      });
      const base = head(world);
      const executionId = await startTurn(world, runner);
      await runner.settled(executionId);
      const diagnostics = expectFailureShape(world, runner, executionId);
      expect(diagnostics["reason"]).toBe("DIFF_UNSTABLE");
      expect(head(world)).toBe(base);
      expect(fileAt(world, "src/app.js")).toBe("module.exports = () => 'another writer';\n");
    });

    it("a provider session that is not the worker's", async () => {
      const world = coreWorld();
      const adapter = fakeFor(world);
      adapter.script = { writes: { "src/app.js": "module.exports = () => 2;\n" }, providerSessionId: "a-different-session" };
      const runner = makeRunner(world, adapter);
      const base = head(world);
      const executionId = await startTurn(world, runner);
      await runner.settled(executionId);
      const diagnostics = expectFailureShape(world, runner, executionId);
      expect(diagnostics["reason"]).toBe("SESSION_MISMATCH");
      expect(head(world)).toBe(base);
      expect(fileAt(world, "src/app.js")).toBe("module.exports = () => 2;\n");
    });
  });

  describe("W3 nothing runs twice", () => {
    it("a simulated restart abandons the turn, kills only the identified process, and never re-invokes", async () => {
      const world = coreWorld();
      const adapter = fakeFor(world);
      // The child outlives the runner that launched it, as it does when the daemon dies.
      adapter.script = { writes: { "src/app.js": "module.exports = () => 2;\n" }, hold: true, ignoreAbort: true };
      const runner = makeRunner(world, adapter);
      const executionId = await startTurn(world, runner);
      await waitFor(() => world.tasks.execution(executionId)!.workerProcessId !== null, "the worker process to be recorded");
      const recorded = world.tasks.execution(executionId)!;
      expect(recorded.workerProcessStartedAt).toMatch(/^(darwin-tv|linux-clk):/);

      // The daemon restarts: a fresh runner over the same database reconciles. The old runner is dropped.
      const restarted = makeRunner(world, adapter);
      expect(await restarted.reconcileAfterRestart()).toEqual([{ executionId, outcome: "KILLED" }]);
      expect(world.tasks.execution(executionId)!.status).toBe("ABANDONED");
      // Killed by the reconcile itself — the abandoned runner does not stop this child.
      await waitFor(() => {
        try {
          process.kill(recorded.workerProcessId!, 0);
          return false;
        } catch {
          return true;
        }
      }, "the recorded worker to be killed", 3_000);
      await runner.settled(executionId);
      expect(world.tasks.execution(executionId)!.status).toBe("ABANDONED");
      expect(eventsOf(world, WorkerTurnEvent.SUCCEEDED)).toHaveLength(0);
      expect(eventsOf(world, WorkerTurnEvent.LATE_RESULT_REFUSED)).toHaveLength(1);
      expect(adapter.launches).toBe(1);
      expect(adapter.writes).toBe(1);
    });

    it("an orphan whose pid matches but whose OS start time does not is not killed, and blocks the task", async () => {
      const world = coreWorld();
      const adapter = fakeFor(world);
      adapter.script = { hold: true, ignoreAbort: true, reportedStartedAt: "darwin-tv:1.000000" };
      const runner = makeRunner(world, adapter);
      const executionId = await startTurn(world, runner);
      await waitFor(() => world.tasks.execution(executionId)!.workerProcessId !== null, "the worker process to be recorded");
      const pid = world.tasks.execution(executionId)!.workerProcessId!;

      const restarted = makeRunner(world, adapter);
      expect(await restarted.reconcileAfterRestart()).toEqual([{ executionId, outcome: "UNIDENTIFIED" }]);
      expect(world.tasks.execution(executionId)!.status).toBe("ABANDONED");
      // Still alive well after the abandoned runner has seen the ABANDONED status: nothing killed it.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(() => process.kill(pid, 0)).not.toThrow();
      const blocked = await restarted.start({
        runId: world.runId,
        taskId: world.taskId,
        claimId: world.claimId,
        ownerSessionId: world.cto.sessionId,
        ownerBindingGeneration: world.cto.generation,
      });
      expect(blocked.allowed).toBe(false);
      expect(blocked.reasonCode).toBe(ReasonCode.CONFLICT);
      expect(adapter.launches).toBe(1);

      // Once that process group is gone the block lifts; nothing was killed by the control plane.
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
      const retried = await restarted.start({
        runId: world.runId,
        taskId: world.taskId,
        claimId: world.claimId,
        ownerSessionId: world.cto.sessionId,
        ownerBindingGeneration: world.cto.generation,
      });
      expect(retried.allowed).toBe(true);
      if (retried.allowed) await restarted.settled(retried.value.executionId);
    });

    it("a launch the guard admitted whose process was never recorded blocks every retry of its task", async () => {
      // The provider launched — the guard admitted it — but its pid never reached the receipt, as when
      // the daemon dies between the spawn and the record. Nothing can confirm that process gone.
      const world = coreWorld();
      const adapter = new UnrecordedSpawnAdapter(world.broker);
      adapters.push(adapter);
      adapter.script = { hold: true, ignoreAbort: true };
      const runner = makeRunner(world, adapter);
      const executionId = await startTurn(world, runner);
      await waitFor(() => adapter.launches === 1, "the provider launch");
      expect(world.tasks.execution(executionId)!.workerProcessId).toBeNull();

      const restarted = makeRunner(world, adapter);
      expect(await restarted.reconcileAfterRestart()).toEqual([{ executionId, outcome: "UNIDENTIFIED" }]);
      expect(world.tasks.execution(executionId)!.status).toBe("ABANDONED");

      const retry = () => restarted.start({
        runId: world.runId,
        taskId: world.taskId,
        claimId: world.claimId,
        ownerSessionId: world.cto.sessionId,
        ownerBindingGeneration: world.cto.generation,
      });
      const whileAlive = await retry();
      expect(whileAlive.allowed).toBe(false);
      expect(whileAlive.reasonCode).toBe(ReasonCode.CONFLICT);
      expect(whileAlive.allowed ? "" : whileAlive.message).toMatch(/never recorded/);

      // Even once that process is gone the block stands: there is no pid by which to know it is.
      adapter.killAll();
      await runner.settled(executionId);
      adapter.script = { writes: { "src/app.js": "module.exports = () => 2;\n" } };
      const afterwards = await retry();
      expect(afterwards.allowed).toBe(false);
      expect(afterwards.reasonCode).toBe(ReasonCode.CONFLICT);
      expect(afterwards.allowed ? "" : afterwards.message).toMatch(/never recorded/);
      expect(adapter.launches).toBe(1);
    });
  });

  it("W7 a retry never destroys the failed attempt's preserved bytes", async () => {
    const world = coreWorld();
    const adapter = fakeFor(world);
    adapter.script = { writes: { "src/app.js": "module.exports = () => 2;\n", "README.md": "# attempt 1 outside the claim\n" } };
    const runner = makeRunner(world, adapter);
    const base = head(world);
    const first = await startTurn(world, runner);
    await runner.settled(first);
    expect(world.tasks.execution(first)!.status).toBe("FAILED");

    // Attempt 2 on the same worktree is refused: the preserved state is not safe to build on, and
    // nothing is reset or cleaned to make it so.
    adapter.script = { writes: { "src/app.js": "module.exports = () => 22;\n" } };
    const second = await runner.start({
      runId: world.runId,
      taskId: world.taskId,
      claimId: world.claimId,
      ownerSessionId: world.cto.sessionId,
      ownerBindingGeneration: world.cto.generation,
    });
    expect(second.allowed).toBe(false);
    expect(second.reasonCode).toBe(ReasonCode.CONFLICT);
    expect(adapter.launches).toBe(1);
    expect(fileAt(world, "README.md")).toBe("# attempt 1 outside the claim\n");
    expect(fileAt(world, "src/app.js")).toBe("module.exports = () => 2;\n");
    expect(head(world)).toBe(base);
    expect(world.tasks.executions(world.runId)).toHaveLength(1);

    // An explicit resolution moves attempt 1's bytes onto their own branch; then attempt 2 runs, and
    // attempt 1's bytes and diagnostics are still there.
    gitSync(world.repoPath, ["checkout", "-q", "-b", "preserved/attempt-1"]);
    gitSync(world.repoPath, ["add", "-A"]);
    gitSync(world.repoPath, ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "preserve attempt 1"]);
    gitSync(world.repoPath, ["checkout", "-q", world.branch]);
    const retried = await startTurn(world, runner);
    await runner.settled(retried);
    expect(world.tasks.execution(retried)!.status).toBe("SUCCEEDED");
    expect(world.tasks.execution(retried)!.attempt).toBe(2);
    expect(gitSync(world.repoPath, ["show", "preserved/attempt-1:README.md"])).toBe("# attempt 1 outside the claim");
    expect(runner.describe(first, world.runId).allowed && runner.describe(first, world.runId)).toMatchObject({
      value: { diagnostics: { evidence: { reason: "OUT_OF_SCOPE" } } },
    });
  });
});

/** Through the real CTO MCP tools: idempotency, the receipt refusal, and the read tool. */
describe("#512 the CTO MCP surface of a worker turn", () => {
  const harnessWorld = () => {
    const h = makeHarness();
    const world = seedWorkerWorld(
      { db: h.cp.db, clock: h.cp.clock, audit: h.cp.audit, sessions: h.cp.sessions, bindings: h.cp.bindings, telemetry: h.cp.telemetry },
    );
    const adapter = fakeFor(world);
    const runner = makeRunner(world, adapter);
    const source = { ...h.cp, workerTurns: runner } as unknown as CtoMcpSource;
    const call = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const server = createCtoServer(createCtoMcpPort(source), () =>
        allow(ReasonCode.OK, { actor: `cto:${world.cto.sessionId}`, sessionId: world.cto.sessionId, sessionIncarnation: world.cto.incarnation }),
      );
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client({ name: "worker-turn-cto", version: "1" });
      await client.connect(clientTransport);
      try {
        const result = await client.callTool({ name, arguments: args });
        return (result.structuredContent ?? {}) as Record<string, unknown>;
      } finally {
        await client.close();
        await server.close();
      }
    };
    return { h, world, adapter, runner, call };
  };

  it("W3 the same key twice is one execution, and a different key while RUNNING is refused", async () => {
    const { world, adapter, runner, call } = harnessWorld();
    adapter.script = { writes: { "src/app.js": "module.exports = () => 2;\n" }, hold: true };
    const args = { runId: world.runId, taskId: world.taskId, claimId: world.claimId };
    const first = await call("task_worker_run", { idempotencyKey: "run-1", ...args });
    expect(first).toMatchObject({ ok: true });
    const executionId = (first["value"] as { executionId: string }).executionId;
    await new Promise((resolve) => setTimeout(resolve, 50));
    const again = await call("task_worker_run", { idempotencyKey: "run-1", ...args });
    expect((again["value"] as { executionId: string }).executionId).toBe(executionId);
    const other = await call("task_worker_run", { idempotencyKey: "run-2", ...args });
    expect(other).toMatchObject({ ok: false, reasonCode: ReasonCode.CONFLICT });
    adapter.killAll();
    await runner.settled(executionId);
    expect(adapter.launches).toBe(1);
    expect(adapter.writes).toBe(1);
    expect(world.tasks.executions(world.runId)).toHaveLength(1);
    const over = await call("task_worker_run", { idempotencyKey: "run-3", ...args, timeoutMs: 31 * 60 * 1000 });
    expect(over["ok"]).not.toBe(true);
  });

  it("W2 refuses a CTO finished SUCCEEDED, and a CTO started receipt, for a runtime-managed execution", async () => {
    const { world, adapter, runner, call } = harnessWorld();
    adapter.script = { writes: { "src/app.js": "module.exports = () => 2;\n" }, exitCode: 1 };
    const started = await call("task_worker_run", { idempotencyKey: "run-1", runId: world.runId, taskId: world.taskId, claimId: world.claimId });
    const executionId = (started["value"] as { executionId: string }).executionId;
    await runner.settled(executionId);
    expect(world.tasks.execution(executionId)!.status).toBe("FAILED");

    const forged = await call("task_receipt_submit", {
      idempotencyKey: "forge-finished",
      runId: world.runId,
      taskId: world.taskId,
      phase: "finished",
      executionId,
      workerSessionId: world.worker.sessionId,
      status: "SUCCEEDED",
      resultDigest: `sha256:${"0".repeat(64)}`,
    });
    expect(forged).toMatchObject({ ok: false, reasonCode: ReasonCode.COMPLETION_AUTHORITY_DENIED });
    const reopened = await call("task_receipt_submit", {
      idempotencyKey: "forge-started",
      runId: world.runId,
      taskId: world.taskId,
      phase: "started",
      workerSessionId: world.worker.sessionId,
      provider: "claude",
      model: "opus",
    });
    expect(reopened).toMatchObject({ ok: false, reasonCode: ReasonCode.COMPLETION_AUTHORITY_DENIED });
    expect(world.tasks.execution(executionId)!.status).toBe("FAILED");
    expect(world.tasks.execution(executionId)!.resultDigest).toBeNull();
    expect(world.tasks.executions(world.runId)).toHaveLength(1);

    const read = await call("task_execution_get", { runId: world.runId, executionId });
    expect(read).toMatchObject({ ok: true, value: { success: null, execution: { status: "FAILED", runtimeManaged: true } } });
    expect((read["value"] as { diagnostics: { evidence: Record<string, unknown> } }).diagnostics.evidence["reason"]).toBe("EXIT_NONZERO");
  });
});
