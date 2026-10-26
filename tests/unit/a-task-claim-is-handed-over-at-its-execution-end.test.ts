import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { allow } from "../../src/core/errors.ts";
import { readProcessStartToken } from "../../src/core/process-argv.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ExecutionMode, Role, RunKind } from "../../src/domain/types.ts";
import { WorkerTurnRunner } from "../../src/run/worker-turn.ts";
import {
  GuardedInvocationWriteBroker,
  type InvocationRequest,
  type InvocationResult,
  type ManagedInvocationWriteBroker,
} from "../../src/runtime/provider.ts";
import { type BootstrapRuntimeFixture, withBootstrapRuntime } from "../helpers/bootstrap-cto-fixture.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { registerFixtureProject } from "../helpers/harness.ts";
import { FakeWorkerAdapter, type FakeTurnScript } from "../helpers/worker-turn-fixture.ts";

/**
 * S2 — the second task of one STANDARD_WORK run claims the registered checkout the first task's claim
 * held, with no resource_release the live CTO is never told to make.
 *
 * A same-run worktree claim is handed over only once the execution that ran under the earlier one has
 * reached its real end: its turn settled (its commit recorded or refused), its process confirmed gone,
 * and no git child of it left. While any writer of it may still exist, the next task does not enter:
 * its claim is refused, and so is its turn even when the earlier claim was released by hand. Another
 * run is refused the checkout exactly as before, between tasks included.
 *
 * Over the real CTO MCP socket, the real claim registry, guard and worker runner, in scratch
 * repositories only. Stood in: the WORKER provider and its capacity admission.
 */

const children: ChildProcess[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const child of children.splice(0)) {
    try {
      process.kill(-(child.pid ?? 0), "SIGKILL");
    } catch {
      /* gone */
    }
  }
});
afterAll(cleanupTempDirs);

const contract = {
  goal: "update the project",
  why: "two changes in one run",
  scope: ["README.md", "src/app.js"],
  nonGoals: [],
  acceptance: ["both files change"],
  priority: "NORMAL" as const,
  humanGate: [],
  references: [],
};

const TASKS = [
  { key: "one", title: "update readme", category: "docs" as const, spec: { writeTarget: { paths: ["README.md"] } } },
  { key: "two", title: "update app", category: "implementation" as const, spec: { writeTarget: { paths: ["src/app.js"] } } },
];

/** A driven PRIMARY_CTO's STANDARD_WORK run, dispatched, with the real worker path. */
const standardRun = async (f: BootstrapRuntimeFixture, projectId: string) => {
  const cp = f.harness.cp;
  cp.providers.registerForRole(f.claude, Role.PRIMARY_CTO);
  await registerFixtureProject(f.harness, projectId);
  const bootstrap = await f.dispatchBootstrap();
  const bound = await cp.cto.ensureDrivenPrimaryCto(projectId, bootstrap.runId);
  if (!bound.allowed) throw new Error(`driven primary CTO refused: ${bound.reasonCode}: ${bound.message}`);
  const sessionId = bound.value.sessionId;
  const repository = cp.db.get<{ repository_id: string; checkout_path: string }>(
    `SELECT repository_id, checkout_path FROM repositories WHERE project_id = ?`,
    [projectId],
  )!;
  const dispatchRun = async (): Promise<string> => {
    const created = cp.runs.create({
      projectId,
      kind: RunKind.STANDARD_WORK,
      executionMode: ExecutionMode.SIMPLE,
      contract,
      repositories: [{ repositoryId: repository.repository_id, repositoryRole: "primary", baseBranch: "dev" }],
    });
    if (!created.allowed) throw new Error(created.message);
    const turns = f.finishedTurns(sessionId);
    const dispatched = await cp.runs.dispatch(created.value.runId);
    if (!dispatched.allowed) throw new Error(`${dispatched.reasonCode}: ${dispatched.message}`);
    await f.awaitFinishedTurns(sessionId, turns + 1);
    await vi.waitFor(() => expect(cp.sessionRuntime.turnInProgress(sessionId)).toBe(false), { timeout: 10_000, interval: 25 });
    return created.value.runId;
  };
  const runId = await dispatchRun();
  const submitted = cp.tasks.submit(runId, TASKS);
  if (!submitted.allowed) throw new Error(submitted.message);
  cp.providers.registerForRole(f.claude, Role.WORKER);
  vi.spyOn(cp.tasks, "admitWorkerFanout").mockResolvedValue(allow(ReasonCode.OK, undefined) as never);
  return { runId, sessionId, dispatchRun, taskIds: submitted.value.map((task) => task.taskId) as [string, string], checkoutPath: repository.checkout_path };
};
type StandardRun = Awaited<ReturnType<typeof standardRun>>;

interface WriteTarget {
  repositoryIdentity: string;
  branch: string;
  paths: string[];
}

/** The CTO's claim of a task's recorded write target, exactly as its directive says: no release first. */
const claim = (f: BootstrapRuntimeFixture, s: StandardRun, target: WriteTarget, runId = s.runId) =>
  f.cto(s.sessionId, "resource_claim", {
    runId,
    repositoryIdentity: target.repositoryIdentity,
    branch: target.branch,
    worktreeId: s.checkoutPath,
    declaredPaths: target.paths,
  });

const worktreeClaimOf = (answer: Record<string, unknown>): string =>
  (answer["value"] as { claims: Array<{ claimId: string; worktreeId: string | null }> }).claims.find((row) => row.worktreeId !== null)!.claimId;

const provision = async (f: BootstrapRuntimeFixture, s: StandardRun, taskId: string): Promise<WriteTarget> => {
  const provisioned = await f.cto(s.sessionId, "task_worker_provision", { runId: s.runId, taskId, provider: "claude" });
  expect(provisioned).toMatchObject({ ok: true });
  return (provisioned["value"] as { writeTarget: WriteTarget }).writeTarget;
};

const staffAndClaim = async (f: BootstrapRuntimeFixture, s: StandardRun, taskId: string) => {
  const target = await provision(f, s, taskId);
  const answer = await claim(f, s, target);
  expect(answer, "the task's claim of its recorded write target").toMatchObject({ ok: true });
  return { target, claimId: worktreeClaimOf(answer) };
};

const runTask = (f: BootstrapRuntimeFixture, s: StandardRun, taskId: string, claimId: string) =>
  f.cto(s.sessionId, "task_worker_run", { runId: s.runId, taskId, claimId });

const executionOf = (answer: Record<string, unknown>): string => (answer["value"] as { executionId: string }).executionId;

const statusOf = (f: BootstrapRuntimeFixture, claimId: string): string =>
  f.harness.cp.db.get<{ status: string }>(`SELECT status FROM resource_claims WHERE claim_id = ?`, [claimId])!.status;

/** The WORKER provider stood in by a fake that writes what its script says, through the real guard broker. */
const workerDoing = (f: BootstrapRuntimeFixture, script: FakeTurnScript, adapter?: FakeWorkerAdapter): FakeWorkerAdapter => {
  const fake = adapter ?? new FakeWorkerAdapter(new GuardedInvocationWriteBroker(f.harness.cp.guard));
  fake.script = script;
  vi.spyOn(f.claude, "invoke").mockImplementation((request) => fake.invoke(request));
  return fake;
};

/** A live process this runner did not launch: no worker session on its command line, so never its to kill. */
const bystander = async (): Promise<{ pid: number; token: string }> => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  children.push(child);
  await vi.waitFor(() => expect(readProcessStartToken(child.pid!)).not.toBeNull(), { timeout: 5_000, interval: 20 });
  return { pid: child.pid!, token: readProcessStartToken(child.pid!)! };
};

/** A provider that reports a bystander as its process: its turn ends with a writer not confirmed gone. */
class UnconfirmedWriterAdapter extends FakeWorkerAdapter {
  writer: { pid: number; token: string } | null = null;
  override invoke(request: InvocationRequest): Promise<InvocationResult> {
    const writer = this.writer;
    return super.invoke(writer ? { ...request, onSpawn: () => request.onSpawn?.(writer.pid, writer.token) } : request);
  }
}

/**
 * The daemon before a restart: its provider was admitted, launched a process it never reported, and the
 * daemon died before the invocation returned, so its execution is still RUNNING with no recorded pid.
 */
class UnrecordedWriterAdapter extends FakeWorkerAdapter {
  #die: (() => void) | null = null;
  constructor(private readonly admission: ManagedInvocationWriteBroker) {
    super(admission);
  }
  override async invoke(request: InvocationRequest): Promise<InvocationResult> {
    this.launches += 1;
    await this.admission.authorize(request.managedWrite!, async () => {
      this.children.push(spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" }));
    });
    await new Promise<void>((resolve) => {
      this.#die = resolve;
    });
    return {
      ok: false, text: "", json: null, provider: "claude", model: "opus", durationMs: 0,
      exitCode: null, error: "the daemon died", providerSessionId: null, isolationAttested: false,
    };
  }
  /** Lets the dead daemon's pending invocation return, for cleanup only. */
  end(): void {
    this.#die?.();
  }
}

/**
 * A git on PATH that, on the turn's worker-commit ref update, leaves a real child in that git call's own
 * process group (a non-interactive shell's background job keeps its group) and then runs the real git,
 * so the turn goes on and succeeds. The child's exact pid is written to a file the test reads.
 */
const gitLeavingAChild = () => {
  const realGit = (process.env["PATH"] ?? "").split(delimiter).map((dir) => join(dir, "git")).find((path) => existsSync(path))!;
  const bin = tempDir("acp-s2-git-child-");
  const pidFile = join(bin, "child.pid");
  writeFileSync(join(bin, "git"), [
    "#!/bin/sh",
    'case "$*" in *"update-ref -m agent-control-plane: worker commit"*)',
    "  /bin/sleep 600 </dev/null >/dev/null 2>&1 &",
    `  echo $! > '${pidFile}'`,
    `  exec '${realGit}' "$@";;`,
    "esac",
    `exec '${realGit}' "$@"`,
    "",
  ].join("\n"));
  chmodSync(join(bin, "git"), 0o755);
  return { bin, childPid: (): number | null => (existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8").trim()) : null) };
};

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * A provider whose turn is cancelled after its launch was admitted and before its spawn is reported:
 * the runner refuses the report, the child it launched lives on, and its cleanup is not confirmed, so it
 * answers the group it could not confirm ended (#1104). No pid is ever recorded for the execution.
 */
class CancelledBeforeSpawnAdapter extends FakeWorkerAdapter {
  cancel: () => void = () => undefined;
  child: ChildProcess | null = null;
  spawnReportRefused = false;
  constructor(private readonly admission: ManagedInvocationWriteBroker) {
    super(admission);
  }
  override async invoke(request: InvocationRequest): Promise<InvocationResult> {
    this.launches += 1;
    await this.admission.authorize(request.managedWrite!, async () => {
      this.cancel();
      await vi.waitFor(() => expect(request.signal?.aborted).toBe(true), { timeout: 5_000, interval: 20 });
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
      this.child = child;
      this.children.push(child);
      try {
        request.onSpawn?.(child.pid!, readProcessStartToken(child.pid!));
      } catch {
        this.spawnReportRefused = true;
      }
    });
    const pgid = this.child?.pid ?? 0;
    return {
      ok: false, text: "", json: null, provider: "claude", model: "opus", durationMs: 0, exitCode: null,
      error: `PROCESS_GROUP_UNCONFIRMED: the turn's own process group ${pgid} was not confirmed ended (UNVERIFIABLE)`,
      providerSessionId: null, isolationAttested: false,
      processGroup: { pgid, ownership: "UNVERIFIABLE", detail: "the witness's cleanup could not confirm the group ended" },
    };
  }
}

/**
 * S2 round 3 — a git on PATH that, on the first worker git call (the one that names its GIT_DIR), leaves
 * a real child in that call's group, records the call's own pid and the child's, and runs the real git.
 * It runs at all only if git does: a gated child that never passes its gate never reaches it.
 */
const gitLeavingAChildOnIntent = () => {
  const realGit = (process.env["PATH"] ?? "").split(delimiter).map((dir) => join(dir, "git")).find((path) => existsSync(path))!;
  const bin = tempDir("acp-s2-git-intent-");
  const read = (name: string): number | null => (existsSync(join(bin, name)) ? Number(readFileSync(join(bin, name), "utf8").trim()) || null : null);
  writeFileSync(join(bin, "git"), [
    "#!/bin/sh",
    `if [ -n "$GIT_DIR" ] && mkdir '${join(bin, "once")}' 2>/dev/null; then`,
    `  echo $$ > '${join(bin, "leader.pid")}'`,
    "  /bin/sleep 600 </dev/null >/dev/null 2>&1 &",
    `  echo $! > '${join(bin, "child.pid")}'`,
    "fi",
    `exec '${realGit}' "$@"`,
    "",
  ].join("\n"));
  chmodSync(join(bin, "git"), 0o755);
  return { bin, leaderPid: () => read("leader.pid"), childPid: () => read("child.pid") };
};

const CRASH_CHILD = fileURLToPath(new URL("../helpers/s2-git-intent-crash-child.ts", import.meta.url));

/** The live children of `parent` whose argv names a worker git gate (`acp-git-<nonce>`), from `ps`. */
const gatesOf = (parent: number): number[] =>
  execFileSync("/bin/ps", ["-axww", "-o", "pid=,ppid=,command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter(([, ppid, ...command]) => Number(ppid) === parent && command.some((token) => token.startsWith("acp-git-")))
    .map(([pid]) => Number(pid));

/**
 * Whether `/bin/ps` answers with a table that lists this process. The gate witnesses read the process
 * table; without it the product's gate scan fails closed and refuses, so they would fail, never pass
 * vacuously — this says which.
 */
const psReadable = (): boolean => {
  try {
    return execFileSync("/bin/ps", ["-axww", "-o", "pid="], { encoding: "utf8" }).split("\n").some((line) => line.trim() === String(process.pid));
  } catch {
    return false;
  }
};
const PS_REQUIRED = "the process table (/bin/ps) must be readable for this witness; without it the gate scan fails closed and refuses";

/** Waits for a resumed runner process to exit, answering what it printed. */
const exitOf = (runner: ChildProcess, output: () => string): Promise<{ code: number | null; output: string }> =>
  new Promise((resolve) => {
    if (runner.exitCode !== null) {
      resolve({ code: runner.exitCode, output: output() });
      return;
    }
    runner.once("exit", (code) => resolve({ code, output: output() }));
  });

/** Kills, by exact pid, whatever the PATH git recorded it left behind; it may still be writing its pid. */
const killLeftBy = async (git: { childPid: () => number | null; leaderPid: () => number | null }): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 300));
  for (const pid of [git.childPid(), git.leaderPid()]) if (pid !== null && alive(pid)) process.kill(pid, "SIGKILL");
};

/**
 * Runs the turn of `input.taskId` in a runner process of its own over the fixture's database, with
 * `bin` first on its PATH, until that process is killed (`kill`) or stopped (`stop`) at the group record
 * of its first git child. Answers the signal and whatever the process wrote.
 */
const crashRunner = async (
  f: BootstrapRuntimeFixture,
  s: StandardRun,
  bin: string,
  input: {
    taskId: string; claimId: string; ownerSessionId: string; ownerBindingGeneration: number;
    mode: "kill" | "stop" | "stop-after-intent" | "stop-before-intent";
  },
): Promise<{ runner: ChildProcess; signal: NodeJS.Signals | null; output: string; printed: () => string; spawned: () => number | null }> => {
  const spawnedFile = join(bin, "spawned.pid");
  const runner = spawn(process.execPath, ["--experimental-transform-types", CRASH_CHILD, JSON.stringify({
    root: f.harness.root, repoPath: f.harness.repoPath, nowIso: f.harness.cp.clock.nowIso(), runId: s.runId, spawnedFile, ...input,
  })], { env: { ...process.env, PATH: `${bin}${delimiter}${process.env["PATH"] ?? ""}` }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  runner.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
  runner.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
  const signal = await new Promise<NodeJS.Signals | null>((resolve) => {
    runner.once("exit", (_code, exited) => resolve(exited));
    if (input.mode !== "kill") {
      const watch = setInterval(() => {
        try {
          const state = execFileSync("/bin/ps", ["-o", "stat=", "-p", String(runner.pid)], { encoding: "utf8" });
          if (state.trim().startsWith("T")) {
            clearInterval(watch);
            resolve("SIGSTOP");
          }
        } catch {
          clearInterval(watch);
        }
      }, 50);
      runner.once("exit", () => clearInterval(watch));
    }
  });
  return {
    runner, signal, output, printed: () => output,
    spawned: () => (existsSync(spawnedFile) ? Number(readFileSync(spawnedFile, "utf8").trim()) || null : null),
  };
};

/**
 * S2 round 3 (P1-a) — a provider cancelled before its spawn is reported, which then pauses before it
 * answers anything: the child it launched lives, no pid is recorded, and no diagnostic exists.
 */
class PausedAfterRefusedSpawnAdapter extends FakeWorkerAdapter {
  cancel: () => void = () => undefined;
  child: ChildProcess | null = null;
  spawnReportRefused = false;
  #resume: (() => void) | null = null;
  constructor(private readonly admission: ManagedInvocationWriteBroker) {
    super(admission);
  }
  override async invoke(request: InvocationRequest): Promise<InvocationResult> {
    this.launches += 1;
    await this.admission.authorize(request.managedWrite!, async () => {
      this.cancel();
      await vi.waitFor(() => expect(request.signal?.aborted).toBe(true), { timeout: 5_000, interval: 20 });
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
      this.child = child;
      this.children.push(child);
      try {
        request.onSpawn?.(child.pid!, readProcessStartToken(child.pid!));
      } catch {
        this.spawnReportRefused = true;
      }
    });
    await new Promise<void>((resolve) => {
      this.#resume = resolve;
    });
    return {
      ok: false, text: "", json: null, provider: "claude", model: "opus", durationMs: 0, exitCode: null,
      error: "the provider was cancelled", providerSessionId: null, isolationAttested: false,
    };
  }
  /** For cleanup only: the paused provider answers. */
  resume(): void {
    this.#resume?.();
  }
}

describe("S2 — the second task of a run claims the checkout once the first execution has really ended", () => {
  it("after a SUCCEEDED first task, the second task's claim of the same registered checkout is admitted without resource_release, and its turn runs", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const s = await standardRun(f, "s2-success");
      const [one, two] = s.taskIds;
      const worker = workerDoing(f, { writes: { "README.md": "# task one\n" } });
      try {
        const first = await staffAndClaim(f, s, one);
        const ran = await runTask(f, s, one, first.claimId);
        expect(ran).toMatchObject({ ok: true });
        await cp.workerTurns.settled(executionOf(ran));
        expect(cp.tasks.execution(executionOf(ran))?.status).toBe("SUCCEEDED");

        worker.script = { writes: { "src/app.js": "module.exports = () => 2;\n" } };
        const target = await provision(f, s, two);
        const second = await claim(f, s, target);
        expect(second, "the second task's claim, with no resource_release before it").toMatchObject({ ok: true });
        expect(statusOf(f, first.claimId), "the first claim is handed over, not left HELD").toBe("RELEASED");
        const next = await runTask(f, s, two, worktreeClaimOf(second));
        expect(next).toMatchObject({ ok: true });
        await cp.workerTurns.settled(executionOf(next));
        expect(cp.tasks.execution(executionOf(next))?.status).toBe("SUCCEEDED");
      } finally {
        worker.killAll();
      }
    });
  });
  it("after a first task that FAILED with its process confirmed gone, the second task's claim is admitted the same way", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const s = await standardRun(f, "s2-clean-failure");
      const [one, two] = s.taskIds;
      const worker = workerDoing(f, { writes: {} });
      try {
        const first = await staffAndClaim(f, s, one);
        const ran = await runTask(f, s, one, first.claimId);
        expect(ran).toMatchObject({ ok: true });
        await cp.workerTurns.settled(executionOf(ran));
        const ended = cp.tasks.execution(executionOf(ran))!;
        expect(ended.status).toBe("FAILED");
        expect(ended.workerProcessReleasedAt).not.toBeNull();

        const second = await claim(f, s, await provision(f, s, two));
        expect(second).toMatchObject({ ok: true });
        expect(statusOf(f, first.claimId)).toBe("RELEASED");
      } finally {
        worker.killAll();
      }
    });
  });
});

describe("S2 — while any writer of the previous execution may still exist, the next task does not enter", () => {
  it("failure: a first task whose process is not confirmed gone keeps its claim, and the next task is refused its claim and, after a release by hand, its turn, until the writer is gone", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const s = await standardRun(f, "s2-writer-failure");
      const [one, two] = s.taskIds;
      const adapter = new UnconfirmedWriterAdapter(new GuardedInvocationWriteBroker(cp.guard));
      const writer = await bystander();
      adapter.writer = writer;
      workerDoing(f, { writes: {} }, adapter);
      try {
        const first = await staffAndClaim(f, s, one);
        const ran = await runTask(f, s, one, first.claimId);
        expect(ran).toMatchObject({ ok: true });
        await cp.workerTurns.settled(executionOf(ran));
        const ended = cp.tasks.execution(executionOf(ran))!;
        expect(ended.status).toBe("FAILED");
        expect(ended.workerProcessReleasedAt, "the writer is not confirmed gone").toBeNull();

        const target = await provision(f, s, two);
        const refused = await claim(f, s, target);
        expect(refused).toMatchObject({ ok: false, reasonCode: ReasonCode.CLAIM_WORKTREE_CONFLICT });
        expect(String(refused["message"])).toMatch(/this run's claim .*not confirmed gone/);
        expect(refused["evidence"]).toMatchObject({ claimId: first.claimId, writer: { executionId: executionOf(ran), pid: writer.pid } });
        expect(statusOf(f, first.claimId), "the earlier claim is untouched").toBe("HELD");

        // The live CTO is never told to release; one that does still cannot run the next task.
        expect(await f.cto(s.sessionId, "resource_release", { runId: s.runId })).toMatchObject({ ok: true });
        const taken = await claim(f, s, target);
        expect(taken).toMatchObject({ ok: true });
        const launches = adapter.launches;
        const entered = await runTask(f, s, two, worktreeClaimOf(taken));
        expect(entered).toMatchObject({ ok: false, reasonCode: ReasonCode.CONFLICT });
        expect(String(entered["message"])).toMatch(/not confirmed gone; no task of the run enters the checkout/);
        expect(adapter.launches, "nothing was launched for the next task").toBe(launches);
        expect(cp.tasks.executions(s.runId).filter((execution) => execution.taskId === two)).toHaveLength(0);

        // Once the writer is gone, the same claim runs the next task.
        process.kill(-writer.pid, "SIGKILL");
        await vi.waitFor(() => expect(() => process.kill(writer.pid, 0)).toThrow(), { timeout: 5_000, interval: 20 });
        adapter.writer = null;
        adapter.script = { writes: { "src/app.js": "module.exports = () => 2;\n" } };
        const next = await runTask(f, s, two, worktreeClaimOf(taken));
        expect(next).toMatchObject({ ok: true });
        await cp.workerTurns.settled(executionOf(next));
        expect(cp.tasks.execution(executionOf(next))?.status).toBe("SUCCEEDED");
        expect(cp.tasks.execution(executionOf(ran))?.workerProcessReleasedAt, "recorded released once seen gone").not.toBeNull();
      } finally {
        adapter.killAll();
      }
    });
  });

  it("cancel: an execution ended from elsewhere keeps its claim while its process lives and until its turn has concluded, and passes it on only then", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const s = await standardRun(f, "s2-cancel");
      const [one, two] = s.taskIds;
      const run = cp.runs.require(s.runId);
      const probes: Array<{ at: string; allowed: boolean; message: string }> = [];
      let target: WriteTarget | null = null;
      const probeDirect = (at: string): void => {
        const decision = cp.claims.acquire({
          runId: s.runId,
          ownerSessionId: run.ownerSessionId!,
          ownerBindingGeneration: run.ownerBindingGeneration!,
          ownerRoleKey: run.ownerRoleKey!,
          repositoryIdentity: target!.repositoryIdentity,
          branch: target!.branch,
          worktreeId: s.checkoutPath,
          declaredPaths: target!.paths,
        });
        probes.push({ at, allowed: decision.allowed, message: decision.allowed ? "" : decision.message });
      };
      let executionId = "";
      const worker = workerDoing(f, {
        writes: {},
        hold: true,
        whileLatched: async () => {
          // A cancel ends the execution at once, while its process still runs.
          expect(cp.tasks.abandonStaleExecutions(s.runId, run.ownerBindingGeneration! + 1, "cancelled for the witness")).toBe(1);
          const answer = await claim(f, s, target!);
          probes.push({ at: "cancelled", allowed: answer["ok"] === true, message: String(answer["message"] ?? "") });
        },
      });
      const release = cp.tasks.releaseWorkerProcess.bind(cp.tasks);
      vi.spyOn(cp.tasks, "releaseWorkerProcess").mockImplementation((id, authority) => {
        const released = release(id, authority);
        // The process is confirmed gone, but its turn has not concluded yet.
        if (id === executionId && released.allowed) probeDirect("process released");
        return released;
      });
      try {
        const first = await staffAndClaim(f, s, one);
        target = await provision(f, s, two);
        const ran = await runTask(f, s, one, first.claimId);
        expect(ran).toMatchObject({ ok: true });
        executionId = executionOf(ran);
        await cp.workerTurns.settled(executionId);
        expect(cp.tasks.execution(executionId)?.status).toBe("ABANDONED");
        expect(probes.map((probe) => [probe.at, probe.allowed])).toEqual([["cancelled", false], ["process released", false]]);
        expect(probes[0]!.message).toMatch(/this run's claim/);
        expect(probes[1]!.message).toMatch(/in flight on the checkout/);
        expect(statusOf(f, first.claimId)).toBe("HELD");

        const second = await claim(f, s, target);
        expect(second, "passed on once the cancelled turn has concluded").toMatchObject({ ok: true });
        expect(statusOf(f, first.claimId)).toBe("RELEASED");
      } finally {
        worker.killAll();
      }
    });
  });

  it("cancel: an execution ended from elsewhere whose process is not confirmed gone keeps the checkout from the next task after its turn settles, until the writer is gone", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const s = await standardRun(f, "s2-cancel-writer");
      const [one, two] = s.taskIds;
      const run = cp.runs.require(s.runId);
      const adapter = new UnconfirmedWriterAdapter(new GuardedInvocationWriteBroker(cp.guard));
      const writer = await bystander();
      adapter.writer = writer;
      workerDoing(f, {
        writes: {},
        hold: true,
        whileLatched: () => {
          expect(cp.tasks.abandonStaleExecutions(s.runId, run.ownerBindingGeneration! + 1, "cancelled for the witness")).toBe(1);
        },
      }, adapter);
      try {
        const first = await staffAndClaim(f, s, one);
        const ran = await runTask(f, s, one, first.claimId);
        expect(ran).toMatchObject({ ok: true });
        await cp.workerTurns.settled(executionOf(ran));
        expect(cp.tasks.execution(executionOf(ran))?.status).toBe("ABANDONED");
        expect(cp.tasks.execution(executionOf(ran))?.workerProcessReleasedAt).toBeNull();

        const target = await provision(f, s, two);
        const refused = await claim(f, s, target);
        expect(refused).toMatchObject({ ok: false, reasonCode: ReasonCode.CLAIM_WORKTREE_CONFLICT });
        expect(String(refused["message"])).toMatch(/not confirmed gone/);
        expect(statusOf(f, first.claimId)).toBe("HELD");

        process.kill(-writer.pid, "SIGKILL");
        await vi.waitFor(() => expect(() => process.kill(writer.pid, 0)).toThrow(), { timeout: 5_000, interval: 20 });
        const second = await claim(f, s, target);
        expect(second, "passed on once the writer is gone").toMatchObject({ ok: true });
        expect(statusOf(f, first.claimId)).toBe("RELEASED");
      } finally {
        adapter.killAll();
      }
    });
  });
  it("restart: an execution that may have launched a process never recorded keeps the next task out of the checkout, its claim and, after a release by hand, its turn", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const s = await standardRun(f, "s2-unrecorded");
      const [one, two] = s.taskIds;
      const run = cp.runs.require(s.runId);
      const adapter = new UnrecordedWriterAdapter(new GuardedInvocationWriteBroker(cp.guard));
      // The daemon before the restart: its turn launched a process whose spawn report never arrived.
      const previous = new WorkerTurnRunner(
        { db: cp.db, clock: cp.clock, audit: cp.audit, tasks: cp.tasks, guard: cp.guard, workerAdapter: () => adapter },
        { pollMs: 10, processSettleMs: 50 },
      );
      try {
        const first = await staffAndClaim(f, s, one);
        const started = await previous.start({
          runId: s.runId, taskId: one, claimId: first.claimId,
          ownerSessionId: s.sessionId, ownerBindingGeneration: run.ownerBindingGeneration!,
        });
        if (!started.allowed) throw new Error(`${started.reasonCode}: ${started.message}`);
        await vi.waitFor(() => expect(adapter.launches).toBe(1), { timeout: 5_000, interval: 20 });
        expect(cp.tasks.execution(started.value.executionId)?.workerProcessId).toBeNull();
        // The restarted daemon reconciles it: nothing to confirm gone, so it may still be writing.
        expect(await cp.workerTurns.reconcileAfterRestart()).toEqual([{ executionId: started.value.executionId, outcome: "UNIDENTIFIED" }]);
        expect(cp.tasks.execution(started.value.executionId)?.status).toBe("ABANDONED");

        const target = await provision(f, s, two);
        const refused = await claim(f, s, target);
        expect(refused).toMatchObject({ ok: false, reasonCode: ReasonCode.CLAIM_WORKTREE_CONFLICT });
        expect(String(refused["message"])).toMatch(/never recorded/);

        expect(await f.cto(s.sessionId, "resource_release", { runId: s.runId })).toMatchObject({ ok: true });
        const taken = await claim(f, s, target);
        expect(taken).toMatchObject({ ok: true });
        workerDoing(f, { writes: { "src/app.js": "module.exports = () => 2;\n" } });
        const entered = await runTask(f, s, two, worktreeClaimOf(taken));
        expect(entered).toMatchObject({ ok: false, reasonCode: ReasonCode.CONFLICT });
        expect(String(entered["message"])).toMatch(/never recorded; no task of the run enters the checkout/);
        expect(cp.tasks.executions(s.runId).filter((execution) => execution.taskId === two)).toHaveLength(0);
      } finally {
        adapter.killAll();
        adapter.end();
        await previous.settled(cp.tasks.executions(s.runId)[0]?.executionId ?? "");
      }
    });
  });
  it("git child: while a git child of the previous task's turn still runs in the checkout, the hand-over claim and task_worker_run are both refused; once it has exited, both are admitted", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const s = await standardRun(f, "s2-git-child");
      const [one, two] = s.taskIds;
      const worker = workerDoing(f, { writes: { "README.md": "# task one\n" } });
      const git = gitLeavingAChild();
      const path = process.env["PATH"];
      let child: number | null = null;
      try {
        const first = await staffAndClaim(f, s, one);
        process.env["PATH"] = `${git.bin}${delimiter}${path ?? ""}`;
        const ran = await runTask(f, s, one, first.claimId);
        expect(ran).toMatchObject({ ok: true });
        await cp.workerTurns.settled(executionOf(ran));
        process.env["PATH"] = path;
        const ended = cp.tasks.execution(executionOf(ran))!;
        expect(ended.status).toBe("SUCCEEDED");
        expect(ended.workerProcessReleasedAt, "the worker process itself is gone").not.toBeNull();
        child = git.childPid();
        expect(child !== null && alive(child), "the turn's git child still runs").toBe(true);

        // While it runs: the hand-over is refused and the earlier claim is untouched.
        const target = await provision(f, s, two);
        const handOver = await claim(f, s, target);
        expect(handOver).toMatchObject({ ok: false, reasonCode: ReasonCode.CLAIM_WORKTREE_CONFLICT });
        expect(String(handOver["message"])).toMatch(/this run's claim .*git child .*still running/);
        expect(statusOf(f, first.claimId)).toBe("HELD");

        // A claim taken after a release by hand does not let the next task in either.
        expect(await f.cto(s.sessionId, "resource_release", { runId: s.runId })).toMatchObject({ ok: true });
        const taken = await claim(f, s, target);
        expect(taken).toMatchObject({ ok: true });
        const entered = await runTask(f, s, two, worktreeClaimOf(taken));
        expect(entered).toMatchObject({ ok: false, reasonCode: ReasonCode.CONFLICT });
        expect(String(entered["message"])).toMatch(/git child .*still running .*no task of the run enters the checkout/);
        expect(cp.tasks.executions(s.runId).filter((execution) => execution.taskId === two)).toHaveLength(0);
        const again = await claim(f, s, target);
        expect(again, "nor does a hand-over of that claim").toMatchObject({ ok: false, reasonCode: ReasonCode.CLAIM_WORKTREE_CONFLICT });

        // The child exits (killed by its exact pid): the hand-over and the turn are both admitted.
        process.kill(child!, "SIGKILL");
        await vi.waitFor(() => expect(alive(child!)).toBe(false), { timeout: 5_000, interval: 20 });
        const passed = await claim(f, s, target);
        expect(passed, "the hand-over once the git child has exited").toMatchObject({ ok: true });
        expect(statusOf(f, worktreeClaimOf(taken))).toBe("RELEASED");
        worker.script = { writes: { "src/app.js": "module.exports = () => 2;\n" } };
        const next = await runTask(f, s, two, worktreeClaimOf(passed));
        expect(next, "task_worker_run once the git child has exited").toMatchObject({ ok: true });
        await cp.workerTurns.settled(executionOf(next));
        expect(cp.tasks.execution(executionOf(next))?.status).toBe("SUCCEEDED");
      } finally {
        process.env["PATH"] = path;
        if (child !== null && alive(child)) process.kill(child, "SIGKILL");
        worker.killAll();
      }
    });
  });
  it("cancel before the spawn is reported: an execution ABANDONED with no pid whose provider could not confirm its group ended keeps the hand-over claim and task_worker_run refused while the child lives", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const s = await standardRun(f, "s2-cancel-before-spawn");
      const [one, two] = s.taskIds;
      const run = cp.runs.require(s.runId);
      const adapter = new CancelledBeforeSpawnAdapter(new GuardedInvocationWriteBroker(cp.guard));
      adapter.cancel = () => {
        expect(cp.tasks.abandonStaleExecutions(s.runId, run.ownerBindingGeneration! + 1, "cancelled for the witness")).toBe(1);
      };
      workerDoing(f, { writes: {} }, adapter);
      let child: number | null = null;
      try {
        const first = await staffAndClaim(f, s, one);
        const ran = await runTask(f, s, one, first.claimId);
        expect(ran).toMatchObject({ ok: true });
        await cp.workerTurns.settled(executionOf(ran));
        const ended = cp.tasks.execution(executionOf(ran))!;
        expect(ended.status).toBe("ABANDONED");
        expect(ended.workerProcessId, "no pid was ever recorded").toBeNull();
        expect(adapter.spawnReportRefused).toBe(true);
        child = adapter.child!.pid!;
        expect(alive(child), "the launched child lives on").toBe(true);

        const target = await provision(f, s, two);
        const handOver = await claim(f, s, target);
        expect(handOver).toMatchObject({ ok: false, reasonCode: ReasonCode.CLAIM_WORKTREE_CONFLICT });
        expect(String(handOver["message"])).toMatch(/this run's claim .*cleanup did not confirm ended/);
        expect(handOver["evidence"]).toMatchObject({ claimId: first.claimId, writer: { executionId: executionOf(ran), pgid: child } });
        expect(statusOf(f, first.claimId)).toBe("HELD");

        expect(await f.cto(s.sessionId, "resource_release", { runId: s.runId })).toMatchObject({ ok: true });
        const taken = await claim(f, s, target);
        expect(taken).toMatchObject({ ok: true });
        const entered = await runTask(f, s, two, worktreeClaimOf(taken));
        expect(entered).toMatchObject({ ok: false, reasonCode: ReasonCode.CONFLICT });
        expect(String(entered["message"])).toMatch(/cleanup did not confirm ended; no task of the run enters the checkout/);
        expect(cp.tasks.executions(s.runId).filter((execution) => execution.taskId === two)).toHaveLength(0);

        process.kill(child, "SIGKILL");
        await vi.waitFor(() => expect(alive(child!)).toBe(false), { timeout: 5_000, interval: 20 });
        const passed = await claim(f, s, target);
        expect(passed, "the hand-over once the child has exited").toMatchObject({ ok: true });
        workerDoing(f, { writes: { "src/app.js": "module.exports = () => 2;\n" } });
        const next = await runTask(f, s, two, worktreeClaimOf(passed));
        expect(next, "task_worker_run once the child has exited").toMatchObject({ ok: true });
        await cp.workerTurns.settled(executionOf(next));
        expect(cp.tasks.execution(executionOf(next))?.status).toBe("SUCCEEDED");
      } finally {
        if (child !== null && alive(child)) process.kill(child, "SIGKILL");
        adapter.killAll();
      }
    });
  });
  it("restart: a git child a successful turn left alive keeps a fresh runner over the same database refusing the hand-over claim and task_worker_run until it has exited", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const s = await standardRun(f, "s2-git-child-restart");
      const [one, two] = s.taskIds;
      const worker = workerDoing(f, { writes: { "README.md": "# task one\n" } });
      const git = gitLeavingAChild();
      const path = process.env["PATH"];
      const original = cp.workerTurns;
      let child: number | null = null;
      try {
        const first = await staffAndClaim(f, s, one);
        process.env["PATH"] = `${git.bin}${delimiter}${path ?? ""}`;
        const ran = await runTask(f, s, one, first.claimId);
        expect(ran).toMatchObject({ ok: true });
        await original.settled(executionOf(ran));
        process.env["PATH"] = path;
        expect(cp.tasks.execution(executionOf(ran))?.status).toBe("SUCCEEDED");
        child = git.childPid();
        expect(child !== null && alive(child), "the turn's git child still runs").toBe(true);

        // The daemon restarts: a fresh runner over the same database, holding none of the last one's registries.
        const restarted = new WorkerTurnRunner({
          db: cp.db, clock: cp.clock, audit: cp.audit, tasks: cp.tasks, guard: cp.guard,
          workerAdapter: (provider: string) => cp.providers.requireForRole(provider, Role.WORKER),
        });
        Object.defineProperty(cp, "workerTurns", { value: restarted, configurable: true });
        expect(await restarted.reconcileAfterRestart()).toEqual([]);

        const target = await provision(f, s, two);
        const handOver = await claim(f, s, target);
        expect(handOver).toMatchObject({ ok: false, reasonCode: ReasonCode.CLAIM_WORKTREE_CONFLICT });
        expect(String(handOver["message"])).toMatch(/this run's claim .*git child .*still running/);
        expect(statusOf(f, first.claimId)).toBe("HELD");

        expect(await f.cto(s.sessionId, "resource_release", { runId: s.runId })).toMatchObject({ ok: true });
        const taken = await claim(f, s, target);
        expect(taken).toMatchObject({ ok: true });
        const entered = await runTask(f, s, two, worktreeClaimOf(taken));
        expect(entered).toMatchObject({ ok: false, reasonCode: ReasonCode.CONFLICT });
        expect(String(entered["message"])).toMatch(/git child .*still running .*no task of the run enters the checkout/);
        expect(cp.tasks.executions(s.runId).filter((execution) => execution.taskId === two)).toHaveLength(0);

        process.kill(child!, "SIGKILL");
        await vi.waitFor(() => expect(alive(child!)).toBe(false), { timeout: 5_000, interval: 20 });
        const passed = await claim(f, s, target);
        expect(passed, "the hand-over once the git child has exited").toMatchObject({ ok: true });
        worker.script = { writes: { "src/app.js": "module.exports = () => 2;\n" } };
        const next = await runTask(f, s, two, worktreeClaimOf(passed));
        expect(next, "task_worker_run once the git child has exited").toMatchObject({ ok: true });
        await restarted.settled(executionOf(next));
        expect(cp.tasks.execution(executionOf(next))?.status).toBe("SUCCEEDED");
      } finally {
        process.env["PATH"] = path;
        Object.defineProperty(cp, "workerTurns", { value: original, configurable: true });
        if (child !== null && alive(child)) process.kill(child, "SIGKILL");
        worker.killAll();
      }
    });
  });
  it("restart after a cancel before the spawn report: a fresh runner over the same database finds the launch on record with no end, reconciles it as outstanding, and refuses the hand-over claim and task_worker_run, after the child too", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const s = await standardRun(f, "s2-cancel-paused-restart");
      const [one, two] = s.taskIds;
      const run = cp.runs.require(s.runId);
      const adapter = new PausedAfterRefusedSpawnAdapter(new GuardedInvocationWriteBroker(cp.guard));
      adapter.cancel = () => {
        expect(cp.tasks.abandonStaleExecutions(s.runId, run.ownerBindingGeneration! + 1, "cancelled for the witness")).toBe(1);
      };
      workerDoing(f, { writes: {} }, adapter);
      const original = cp.workerTurns;
      let child: number | null = null;
      let executionId = "";
      try {
        const first = await staffAndClaim(f, s, one);
        const ran = await runTask(f, s, one, first.claimId);
        expect(ran).toMatchObject({ ok: true });
        executionId = executionOf(ran);
        await vi.waitFor(() => expect(adapter.spawnReportRefused).toBe(true), { timeout: 10_000, interval: 20 });
        child = adapter.child!.pid!;
        expect(alive(child)).toBe(true);
        expect(cp.tasks.execution(executionId)).toMatchObject({ status: "ABANDONED", workerProcessId: null });

        // The daemon restarts while the provider is still paused, before any diagnostic exists.
        const restarted = new WorkerTurnRunner({
          db: cp.db, clock: cp.clock, audit: cp.audit, tasks: cp.tasks, guard: cp.guard,
          workerAdapter: (provider: string) => cp.providers.requireForRole(provider, Role.WORKER),
        });
        Object.defineProperty(cp, "workerTurns", { value: restarted, configurable: true });
        expect(await restarted.reconcileAfterRestart()).toEqual([{ executionId, outcome: "UNIDENTIFIED" }]);

        const target = await provision(f, s, two);
        const handOver = await claim(f, s, target);
        expect(handOver).toMatchObject({ ok: false, reasonCode: ReasonCode.CLAIM_WORKTREE_CONFLICT });
        expect(String(handOver["message"])).toMatch(/this run's claim .*never recorded/);
        expect(statusOf(f, first.claimId)).toBe("HELD");

        expect(await f.cto(s.sessionId, "resource_release", { runId: s.runId })).toMatchObject({ ok: true });
        const taken = await claim(f, s, target);
        expect(taken).toMatchObject({ ok: true });
        const entered = await runTask(f, s, two, worktreeClaimOf(taken));
        expect(entered).toMatchObject({ ok: false, reasonCode: ReasonCode.CONFLICT });
        expect(String(entered["message"])).toMatch(/never recorded/);
        expect(cp.tasks.executions(s.runId).filter((execution) => execution.taskId === two)).toHaveLength(0);

        // Nothing names the child: with it gone, nothing proves it gone, so only the operator's release clears it.
        process.kill(child, "SIGKILL");
        await vi.waitFor(() => expect(alive(child!)).toBe(false), { timeout: 5_000, interval: 20 });
        const after = await claim(f, s, target);
        expect(after).toMatchObject({ ok: false, reasonCode: ReasonCode.CLAIM_WORKTREE_CONFLICT });
        expect(String(after["message"])).toMatch(/never recorded/);
      } finally {
        Object.defineProperty(cp, "workerTurns", { value: original, configurable: true });
        if (child !== null && alive(child)) process.kill(child, "SIGKILL");
        adapter.resume();
        if (executionId) await original.settled(executionId);
        adapter.killAll();
      }
    });
  });

  it("crash between a git child's intent and its group record (SIGKILL, in admission): the gated child never runs git, so nothing of the run is left to write and the hand-over is admitted", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const s = await standardRun(f, "s2-git-intent-kill");
      const [one, two] = s.taskIds;
      const run = cp.runs.require(s.runId);
      const first = await staffAndClaim(f, s, one);
      const target = await provision(f, s, two);
      const git = gitLeavingAChildOnIntent();
      let runner: ChildProcess | null = null;
      expect(psReadable(), PS_REQUIRED).toBe(true);
      try {
        const crashed = await crashRunner(f, s, git.bin, { taskId: one, claimId: first.claimId, ownerSessionId: run.ownerSessionId!, ownerBindingGeneration: run.ownerBindingGeneration!, mode: "kill" });
        runner = crashed.runner;
        expect(crashed.signal, crashed.output.slice(0, 2000)).toBe("SIGKILL");
        expect(cp.tasks.executions(s.runId), "it died in admission, before any execution existed").toHaveLength(0);
        // The git child the runner spawned, followed until it is gone, whatever it became.
        const spawned = crashed.spawned();
        expect(spawned, "the runner spawned its git child before it died").not.toBeNull();
        await vi.waitFor(() => expect(alive(spawned!)).toBe(false), { timeout: 15_000, interval: 50 });
        expect(git.leaderPid(), "the gated child never ran git").toBeNull();

        const handOver = await claim(f, s, target);
        expect(handOver, "nothing of the run can write the checkout").toMatchObject({ ok: true });
        expect(statusOf(f, first.claimId)).toBe("RELEASED");
        // On record: the intent, no group, and its end, proven once its gate was gone from the process table.
        const recorded = (kind: string) => cp.audit.byKind(kind).filter((row) => row.runId === s.runId).map((row) => row.evidence);
        expect(recorded("TASK_WORKER_GIT_INTENT")).toHaveLength(1);
        expect(recorded("TASK_WORKER_GIT_GROUP_STARTED")).toHaveLength(0);
        expect(recorded("TASK_WORKER_GIT_GROUP_ENDED")).toMatchObject([{ proven: "GATE_GONE" }]);
      } finally {
        if (runner?.pid !== undefined && runner.exitCode === null && runner.signalCode === null) process.kill(runner.pid, "SIGKILL");
        await killLeftBy(git);
      }
    });
  });

  it("a runner frozen between a git child's intent and its group record (SIGSTOP, in admission): its gated child lives on, and the next runner refuses the hand-over claim and task_worker_run until that child is killed by its exact pid", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const s = await standardRun(f, "s2-git-intent-stop");
      const [one, two] = s.taskIds;
      const run = cp.runs.require(s.runId);
      const first = await staffAndClaim(f, s, one);
      const target = await provision(f, s, two);
      const git = gitLeavingAChildOnIntent();
      let runner: ChildProcess | null = null;
      let gated: number | null = null;
      expect(psReadable(), PS_REQUIRED).toBe(true);
      try {
        const frozen = await crashRunner(f, s, git.bin, { taskId: one, claimId: first.claimId, ownerSessionId: run.ownerSessionId!, ownerBindingGeneration: run.ownerBindingGeneration!, mode: "stop" });
        runner = frozen.runner;
        expect(frozen.signal, frozen.output.slice(0, 2000)).toBe("SIGSTOP");
        expect(gatesOf(runner.pid!), "the git child lives, waiting at its gate").toHaveLength(1);
        gated = gatesOf(runner.pid!)[0]!;

        const handOver = await claim(f, s, target);
        expect(handOver).toMatchObject({ ok: false, reasonCode: ReasonCode.CLAIM_WORKTREE_CONFLICT });
        expect(String(handOver["message"])).toMatch(/this run's claim .*git child .*still running/);
        expect(statusOf(f, first.claimId)).toBe("HELD");

        expect(await f.cto(s.sessionId, "resource_release", { runId: s.runId })).toMatchObject({ ok: true });
        const taken = await claim(f, s, target);
        expect(taken).toMatchObject({ ok: true });
        const entered = await runTask(f, s, two, worktreeClaimOf(taken));
        expect(entered).toMatchObject({ ok: false, reasonCode: ReasonCode.CONFLICT });
        expect(String(entered["message"])).toMatch(/git child .*still running .*no task of the run enters the checkout/);
        const again = await claim(f, s, target);
        expect(again, "nor a hand-over of that claim").toMatchObject({ ok: false, reasonCode: ReasonCode.CLAIM_WORKTREE_CONFLICT });

        // Killed, it is a zombie its frozen parent cannot reap: no longer a process that can run git.
        process.kill(gated, "SIGKILL");
        await vi.waitFor(() => expect(gatesOf(runner!.pid!)).toEqual([]), { timeout: 5_000, interval: 20 });
        const passed = await claim(f, s, target);
        expect(passed, "the hand-over once the child has exited").toMatchObject({ ok: true });
        expect(git.leaderPid(), "the gated child never ran git").toBeNull();
        const recorded = (kind: string) => cp.audit.byKind(kind).filter((row) => row.runId === s.runId);
        expect(recorded("TASK_WORKER_GIT_INTENT")).toHaveLength(1);
        expect(recorded("TASK_WORKER_GIT_GROUP_STARTED")).toHaveLength(0);
      } finally {
        if (runner?.pid !== undefined && runner.exitCode === null) process.kill(runner.pid, "SIGKILL");
        if (gated !== null && alive(gated)) process.kill(gated, "SIGKILL");
        await killLeftBy(git);
      }
    });
  });
  it("a runner frozen after its git intent is committed and before it spawns: a recovery that proves the gate-less intent gone means that runner, resumed, records no group and never runs git; the next task then runs", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const s = await standardRun(f, "s2-git-intent-late");
      const [one, two] = s.taskIds;
      const run = cp.runs.require(s.runId);
      const first = await staffAndClaim(f, s, one);
      const git = gitLeavingAChildOnIntent();
      let runner: ChildProcess | null = null;
      expect(psReadable(), PS_REQUIRED).toBe(true);
      const worker = workerDoing(f, { writes: { "src/app.js": "module.exports = () => 2;\n" } });
      try {
        const frozen = await crashRunner(f, s, git.bin, { taskId: one, claimId: first.claimId, ownerSessionId: run.ownerSessionId!, ownerBindingGeneration: run.ownerBindingGeneration!, mode: "stop-after-intent" });
        runner = frozen.runner;
        expect(frozen.signal, frozen.output.slice(0, 2000)).toBe("SIGSTOP");
        const recorded = (kind: string) => cp.audit.byKind(kind).filter((row) => row.runId === s.runId).map((row) => row.evidence);
        expect(recorded("TASK_WORKER_GIT_INTENT"), "the intent is committed").toHaveLength(1);
        expect(gatesOf(runner.pid!), "and nothing is spawned yet").toEqual([]);

        // Recovery, as a hand-over asks it, while the claim stays held: the gate-less intent is proven gone.
        expect(cp.workerTurns.checkoutWriter(s.runId, s.checkoutPath)).toBeNull();
        expect(recorded("TASK_WORKER_GIT_GROUP_ENDED")).toMatchObject([{ proven: "GATE_GONE" }]);
        expect(statusOf(f, first.claimId), "the late runner's claim is still held").toBe("HELD");

        process.kill(runner.pid!, "SIGCONT");
        const resumed = await exitOf(runner, frozen.printed);
        expect(resumed.code, resumed.output.slice(0, 2000)).toBe(0);
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(git.leaderPid(), "the late runner's git never ran").toBeNull();
        expect(recorded("TASK_WORKER_GIT_GROUP_STARTED"), "no group was recorded for the ended intent").toHaveLength(0);
        expect(resumed.output).toMatch(/"allowed":false/);

        const second = await claim(f, s, await provision(f, s, two));
        expect(second).toMatchObject({ ok: true });
        const next = await runTask(f, s, two, worktreeClaimOf(second));
        expect(next).toMatchObject({ ok: true });
        await cp.workerTurns.settled(executionOf(next));
        expect(cp.tasks.execution(executionOf(next))?.status).toBe("SUCCEEDED");
        expect(git.leaderPid(), "nor at any point after").toBeNull();
      } finally {
        if (runner?.pid !== undefined && runner.exitCode === null) process.kill(runner.pid, "SIGKILL");
        await killLeftBy(git);
        worker.killAll();
      }
    });
  });

  it("a runner frozen before its git intent is written, resumed after its claim was handed over: its git child never runs, so the next task's turn runs alone", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const s = await standardRun(f, "s2-git-before-intent");
      const [one, two] = s.taskIds;
      const run = cp.runs.require(s.runId);
      const first = await staffAndClaim(f, s, one);
      const git = gitLeavingAChildOnIntent();
      let runner: ChildProcess | null = null;
      expect(psReadable(), PS_REQUIRED).toBe(true);
      const worker = workerDoing(f, { writes: { "src/app.js": "module.exports = () => 2;\n" } });
      try {
        const frozen = await crashRunner(f, s, git.bin, { taskId: one, claimId: first.claimId, ownerSessionId: run.ownerSessionId!, ownerBindingGeneration: run.ownerBindingGeneration!, mode: "stop-before-intent" });
        runner = frozen.runner;
        expect(frozen.signal, frozen.output.slice(0, 2000)).toBe("SIGSTOP");
        expect(cp.audit.byKind("TASK_WORKER_GIT_INTENT").filter((row) => row.runId === s.runId), "nothing on record yet").toHaveLength(0);

        const second = await claim(f, s, await provision(f, s, two));
        expect(second, "nothing of the run is on record or running").toMatchObject({ ok: true });
        expect(statusOf(f, first.claimId)).toBe("RELEASED");

        process.kill(runner.pid!, "SIGCONT");
        const resumed = await exitOf(runner, frozen.printed);
        expect(resumed.code, resumed.output.slice(0, 2000)).toBe(0);
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(git.leaderPid(), "the resumed runner's git never ran").toBeNull();

        const next = await runTask(f, s, two, worktreeClaimOf(second));
        expect(next).toMatchObject({ ok: true });
        await cp.workerTurns.settled(executionOf(next));
        expect(cp.tasks.execution(executionOf(next))?.status).toBe("SUCCEEDED");
      } finally {
        if (runner?.pid !== undefined && runner.exitCode === null) process.kill(runner.pid, "SIGKILL");
        await killLeftBy(git);
        worker.killAll();
      }
    });
  });

  it("a git group on record after its intent was proven gate-gone still blocks the hand-over until it is gone: an intent's end is not its group's", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const s = await standardRun(f, "s2-group-after-gate-gone");
      const [one, two] = s.taskIds;
      const first = await staffAndClaim(f, s, one);
      const target = await provision(f, s, two);
      const group = spawn("/bin/sleep", ["600"], { detached: true, stdio: "ignore" });
      children.push(group);
      const pgid = group.pid!;
      await vi.waitFor(() => expect(readProcessStartToken(pgid)).not.toBeNull(), { timeout: 5_000, interval: 20 });
      // The records a runner without the round-4 re-read could leave: intent, a recovery's GATE_GONE, then its group.
      const nonce = "4f1c0b9e-6d2a-4c3b-9e8f-7a6b5c4d3e2f";
      const base = { worktreeId: s.checkoutPath, taskId: one, nonce };
      cp.audit.record({ kind: "TASK_WORKER_GIT_INTENT", runId: s.runId, evidence: base });
      cp.audit.record({ kind: "TASK_WORKER_GIT_GROUP_ENDED", runId: s.runId, evidence: { ...base, pgid: null, proven: "GATE_GONE" } });
      cp.audit.record({ kind: "TASK_WORKER_GIT_GROUP_STARTED", runId: s.runId, evidence: { ...base, pgid, leaderStartedAt: readProcessStartToken(pgid) } });

      const refused = await claim(f, s, target);
      expect(refused).toMatchObject({ ok: false, reasonCode: ReasonCode.CLAIM_WORKTREE_CONFLICT });
      expect(String(refused["message"])).toMatch(/git child .*still running/);
      expect(statusOf(f, first.claimId)).toBe("HELD");

      process.kill(pgid, "SIGKILL");
      await vi.waitFor(() => expect(alive(pgid)).toBe(false), { timeout: 5_000, interval: 20 });
      const passed = await claim(f, s, target);
      expect(passed, "once the group is gone").toMatchObject({ ok: true });
    });
  });
});

describe("S2 — cross-run exclusivity is unchanged", () => {
  it("another run is refused the checkout while the first task's claim is held after its end, and again after the hand-over to the run's next claim", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const s = await standardRun(f, "s2-cross-run");
      const [one, two] = s.taskIds;
      const worker = workerDoing(f, { writes: { "README.md": "# task one\n" } });
      try {
        const first = await staffAndClaim(f, s, one);
        const ran = await runTask(f, s, one, first.claimId);
        await cp.workerTurns.settled(executionOf(ran));
        expect(cp.tasks.execution(executionOf(ran))?.status).toBe("SUCCEEDED");

        const other = await s.dispatchRun();
        const otherTarget = { repositoryIdentity: first.target.repositoryIdentity, branch: "task/other-run", paths: ["docs/other.md"] };
        const between = await claim(f, s, otherTarget, other);
        expect(between, "between the run's tasks").toMatchObject({ ok: false, reasonCode: ReasonCode.CLAIM_WORKTREE_CONFLICT });
        expect(between["evidence"]).toMatchObject({ heldByRun: s.runId, claimId: first.claimId });
        expect(String(between["message"])).toMatch(/already claimed by another run/);

        const second = await claim(f, s, await provision(f, s, two));
        expect(second).toMatchObject({ ok: true });
        const after = await claim(f, s, otherTarget, other);
        expect(after, "after the hand-over").toMatchObject({ ok: false, reasonCode: ReasonCode.CLAIM_WORKTREE_CONFLICT });
        expect(after["evidence"]).toMatchObject({ heldByRun: s.runId, claimId: worktreeClaimOf(second) });
      } finally {
        worker.killAll();
      }
    });
  });

  it("same millisecond: the hand-over releases only the earlier claim's own acquisition, not a reservation acquired apart at the same instant, which another run is still refused", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const s = await standardRun(f, "s2-same-ms");
      const [one, two] = s.taskIds;
      const claimIdsOf = (answer: Record<string, unknown>): string[] =>
        (answer["value"] as { claims: Array<{ claimId: string }> }).claims.map((row) => row.claimId);
      const firstTarget = await provision(f, s, one);
      const first = await claim(f, s, firstTarget);
      expect(first).toMatchObject({ ok: true });
      const reserved = await f.cto(s.sessionId, "resource_claim", {
        runId: s.runId, repositoryIdentity: firstTarget.repositoryIdentity, declaredPaths: ["docs/reserved.md"],
      });
      expect(reserved).toMatchObject({ ok: true });
      const [reservation] = claimIdsOf(reserved) as [string];
      const acquiredAt = (claimId: string): string =>
        cp.db.get<{ acquired_at: string }>(`SELECT acquired_at FROM resource_claims WHERE claim_id = ?`, [claimId])!.acquired_at;
      expect(acquiredAt(reservation), "the clock did not move between the two acquisitions").toBe(acquiredAt(worktreeClaimOf(first)));

      const second = await claim(f, s, await provision(f, s, two));
      expect(second).toMatchObject({ ok: true });
      expect(claimIdsOf(first).map((claimId) => statusOf(f, claimId)), "the earlier acquisition: worktree, branch, path")
        .toEqual(["RELEASED", "RELEASED", "RELEASED"]);
      expect(statusOf(f, reservation), "the reservation acquired apart").toBe("HELD");

      const other = await s.dispatchRun();
      const taken = await f.cto(s.sessionId, "resource_claim", {
        runId: other, repositoryIdentity: firstTarget.repositoryIdentity, declaredPaths: ["docs/reserved.md"],
      });
      expect(taken, "another run").toMatchObject({ ok: false, reasonCode: ReasonCode.CLAIM_PATH_CONFLICT });
      expect(taken["evidence"]).toMatchObject({ heldByRun: s.runId, claimId: reservation });
    });
  });

  it("same millisecond: the next task's turn runs on its own acquisition, not on a reservation acquired apart at the same instant", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const s = await standardRun(f, "s2-same-ms-turn");
      const [one, two] = s.taskIds;
      const worker = workerDoing(f, { writes: { "README.md": "# task one\n" } });
      try {
        const first = await staffAndClaim(f, s, one);
        const ran = await runTask(f, s, one, first.claimId);
        await cp.workerTurns.settled(executionOf(ran));
        expect(cp.tasks.execution(executionOf(ran))?.status).toBe("SUCCEEDED");
        const reserved = await f.cto(s.sessionId, "resource_claim", {
          runId: s.runId, repositoryIdentity: first.target.repositoryIdentity, declaredPaths: ["docs/reserved.md"],
        });
        expect(reserved).toMatchObject({ ok: true });
        const reservation = (reserved["value"] as { claims: Array<{ claimId: string }> }).claims[0]!.claimId;

        const second = await claim(f, s, await provision(f, s, two));
        expect(second).toMatchObject({ ok: true });
        const acquiredAt = (claimId: string): string =>
          cp.db.get<{ acquired_at: string }>(`SELECT acquired_at FROM resource_claims WHERE claim_id = ?`, [claimId])!.acquired_at;
        expect(acquiredAt(reservation), "the clock did not move").toBe(acquiredAt(worktreeClaimOf(second)));
        worker.script = { writes: { "src/app.js": "module.exports = () => 2;\n" } };
        const next = await runTask(f, s, two, worktreeClaimOf(second));
        expect(next).toMatchObject({ ok: true });
        await cp.workerTurns.settled(executionOf(next));
        expect(cp.tasks.execution(executionOf(next))?.status).toBe("SUCCEEDED");
        expect(statusOf(f, reservation)).toBe("HELD");
      } finally {
        worker.killAll();
      }
    });
  });

  it("an acquisition of 203 rows is handed over whole, nothing of it left held; one whose rows no longer add up is not handed over, nor run on", async () => {
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const s = await standardRun(f, "s2-203-rows");
      const [one, two] = s.taskIds;
      const firstTarget = await provision(f, s, one);
      const paths = Array.from({ length: 201 }, (_, index) => `docs/file${index}.md`);
      const first = await claim(f, s, { ...firstTarget, paths });
      expect(first).toMatchObject({ ok: true });
      const firstIds = (first["value"] as { claims: Array<{ claimId: string }> }).claims.map((row) => row.claimId);
      expect(firstIds).toHaveLength(203);

      const secondTarget = await provision(f, s, two);
      const second = await claim(f, s, secondTarget);
      expect(second).toMatchObject({ ok: true });
      const secondIds = (second["value"] as { claims: Array<{ claimId: string }> }).claims.map((row) => row.claimId);
      expect(firstIds.filter((claimId) => statusOf(f, claimId) !== "RELEASED"), "rows of the first acquisition left unreleased").toEqual([]);
      const held = cp.db.all<{ claim_id: string }>(`SELECT claim_id FROM resource_claims WHERE run_id = ? AND status = 'HELD' ORDER BY claim_id`, [s.runId]);
      expect(held.map((row) => row.claim_id), "only the second acquisition is held").toEqual([...secondIds].sort());

      const other = await s.dispatchRun();
      const taken = await f.cto(s.sessionId, "resource_claim", {
        runId: other, repositoryIdentity: firstTarget.repositoryIdentity, declaredPaths: ["docs/file200.md"],
      });
      expect(taken, "the last path of the first acquisition is free to another run").toMatchObject({ ok: true });

      // A row of the second acquisition goes missing: its membership cannot be proven, so nothing moves.
      const pathRow = cp.db.get<{ claim_id: string }>(
        `SELECT claim_id FROM resource_claims WHERE run_id = ? AND status = 'HELD' AND declared_path IS NOT NULL`, [s.runId])!.claim_id;
      cp.db.run(`DELETE FROM resource_claims WHERE claim_id = ?`, [pathRow]);
      const again = await claim(f, s, secondTarget);
      expect(again).toMatchObject({ ok: false, reasonCode: ReasonCode.CLAIM_WORKTREE_CONFLICT });
      expect(String(again["message"])).toMatch(/cannot be proven complete; nothing is released/);
      expect(secondIds.filter((claimId) => claimId !== pathRow).map((claimId) => statusOf(f, claimId))).toEqual(["HELD", "HELD"]);
      const entered = await runTask(f, s, two, worktreeClaimOf(second));
      expect(entered).toMatchObject({ ok: false, reasonCode: ReasonCode.INVALID_ARGUMENT });
      expect(String(entered["message"])).toMatch(/cannot be proven complete/);
    });
  });
});
