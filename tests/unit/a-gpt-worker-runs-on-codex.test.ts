import { chmodSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { ManualClock } from "../../src/core/clock.ts";
import { allow, deny } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ExecutionMode, Role, roleKeyFor } from "../../src/domain/types.ts";
import type { TaskContract } from "../../src/run/run-engine.ts";
import { WorkerTurnRunner } from "../../src/run/worker-turn.ts";
import { WorkerStaffing } from "../../src/run/worker-staffing.ts";
import { CodexCliAdapter } from "../../src/runtime/cli-adapters.ts";
import type { InvocationRequest, ProviderAdapter } from "../../src/runtime/provider.ts";
import { cleanupTempDirs, gitSync, makeCore, tempDir } from "../helpers/fixtures.ts";
import { bindCeo, makeHarness, registerFixtureProject, type Harness } from "../helpers/harness.ts";
import { FakeWorkerAdapter, admittingCapacity, seedWorkerWorld } from "../helpers/worker-turn-fixture.ts";

afterAll(cleanupTempDirs);

/**
 * FIX-CODEX-WORKER witnesses.
 *
 * A gpt WORKER is ready only when this adapter constituted it, the codex binary resolves, `login
 * status` says the account is logged in, and the session workdir exists. The turn then runs on
 * that session's own provider and model. A Claude worker still launches Opus.
 */

const CONTRACT: TaskContract = {
  goal: "staff a gpt worker",
  why: "the implementer is a Codex session",
  scope: ["src/app.js"],
  nonGoals: [],
  acceptance: ["the worker session is READY"],
  priority: "NORMAL",
  humanGate: [],
  references: [],
};

const stubCodex = (root: string, mode: "ok" | "deny" | "edit", workdir = ""): string => {
  const binary = join(root, "codex");
  writeFileSync(join(root, "mode"), mode);
  writeFileSync(join(root, "workdir"), workdir);
  writeFileSync(
    binary,
    `#!${process.execPath}
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const here = dirname(process.argv[1]);
const mode = readFileSync(join(here, "mode"), "utf8").trim();
const args = process.argv.slice(2);
if (args[0] === "login" && args[1] === "status") {
  const workdir = readFileSync(join(here, "workdir"), "utf8").trim();
  if (process.cwd() === workdir || !process.cwd().includes("acp-runtime-")) process.exit(3);
  if (mode === "deny") {
    process.stderr.write("Not logged in\\n");
    process.exit(1);
  }
  process.stdout.write("Logged in\\n");
  process.exit(0);
}
let stdin = "";
process.stdin.on("data", (chunk) => {
  stdin += chunk.toString("utf8");
});
process.stdin.on("end", () => {
  const out = args[args.indexOf("-o") + 1];
  writeFileSync(out, JSON.stringify({ args, cwd: process.cwd(), stdin }));
  writeFileSync(join(process.cwd(), "src", "app.js"), "module.exports = () => 2;\\n");
  process.exit(0);
});
`,
  );
  chmodSync(binary, 0o700);
  return binary;
};

const adapterFor = (root: string, binary: string): CodexCliAdapter =>
  new CodexCliAdapter({
    clock: new ManualClock("2026-10-20T00:00:00.000Z"),
    capacityFile: join(root, "capacity.json"),
    binary,
    managedWriteBroker: undefined,
  });

describe("a gpt worker session is ready only when codex can actually run", () => {
  it("probes HEALTHY for a constituted worker when the binary resolves, login status succeeds, and the workdir exists", async () => {
    const root = tempDir("acp-codex-probe-");
    const workdir = tempDir("acp-codex-workdir-");
    const adapter = adapterFor(root, stubCodex(root, "ok", workdir));
    const handle = await adapter.startSession({
      model: "gpt-6.1-sol",
      effort: null,
      workdir,
      purpose: "worker:task-1",
    });
    expect(await adapter.probeSession(handle)).toBe("HEALTHY");
  });

  it("stays UNAVAILABLE when login status says the account is not logged in", async () => {
    const root = tempDir("acp-codex-probe-deny-");
    const workdir = tempDir("acp-codex-workdir-deny-");
    const adapter = adapterFor(root, stubCodex(root, "deny", workdir));
    const handle = await adapter.startSession({
      model: "gpt-6.1-sol",
      effort: null,
      workdir,
      purpose: "worker:task-1",
    });
    expect(await adapter.probeSession(handle)).toBe("UNAVAILABLE");
  });

  it("stays UNAVAILABLE when the binary does not resolve", async () => {
    const root = tempDir("acp-codex-probe-missing-bin-");
    const workdir = tempDir("acp-codex-workdir-missing-bin-");
    const adapter = adapterFor(root, join(root, "absent-codex"));
    const handle = await adapter.startSession({
      model: "gpt-6.1-sol",
      effort: null,
      workdir,
      purpose: "worker:task-1",
    });
    expect(await adapter.probeSession(handle)).toBe("UNAVAILABLE");
  });

  it("stays UNAVAILABLE when the session workdir is gone", async () => {
    const root = tempDir("acp-codex-probe-missing-wd-");
    const workdir = join(tempDir("acp-codex-wd-parent-"), "missing");
    const adapter = adapterFor(root, stubCodex(root, "ok", workdir));
    const handle = await adapter.startSession({
      model: "gpt-6.1-sol",
      effort: null,
      workdir,
      purpose: "worker:task-1",
    });
    expect(await adapter.probeSession(handle)).toBe("UNAVAILABLE");
  });

  it("does not treat account auth as proof of a session this adapter did not constitute as a worker", async () => {
    const root = tempDir("acp-codex-probe-other-");
    const workdir = tempDir("acp-codex-workdir-other-");
    const adapter = adapterFor(root, stubCodex(root, "ok", workdir));
    const other = await adapter.startSession({
      model: "gpt-6.1-sol",
      effort: null,
      workdir,
      purpose: "continuity:PRIMARY_CTO",
    });
    expect(await adapter.probeSession(other)).toBe("UNAVAILABLE");
    expect(await adapter.probeSession({
      externalSessionId: "not-constituted",
      provider: "gpt",
      model: "gpt-6.1-sol",
      effort: null,
      pid: null,
      workdir,
    })).toBe("UNAVAILABLE");
  });
});

const activeRun = async (harness: Harness) => {
  const { projectId, repositoryId } = await registerFixtureProject(harness);
  if (!harness.cp.bindings.active(roleKeyFor(Role.CEO))) bindCeo(harness);
  const created = harness.cp.runs.create({
    projectId,
    executionMode: ExecutionMode.STANDARD,
    contract: CONTRACT,
    repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
  });
  if (!created.allowed) throw new Error(created.message);
  const dispatched = await harness.cp.runs.dispatch(created.value.runId);
  if (!dispatched.allowed) throw new Error(`${dispatched.reasonCode}: ${dispatched.message}`);
  const submitted = harness.cp.tasks.submit(created.value.runId, [
    { key: "impl", title: "task impl", category: "implementation" },
  ]);
  if (!submitted.allowed) throw new Error(submitted.message);
  return {
    runId: created.value.runId,
    ownerSessionId: dispatched.value.ownerSessionId!,
    ownerBindingGeneration: dispatched.value.ownerBindingGeneration!,
    taskId: harness.cp.tasks.ready(created.value.runId)[0]!.taskId,
  };
};

describe("provisioning a gpt worker", () => {
  it("reaches READY", async () => {
    const harness = makeHarness();
    try {
      const run = await activeRun(harness);
      const root = tempDir("acp-codex-provision-");
      const runtime = tempDir("acp-codex-runtime-");
      mkdirSync(runtime, { recursive: true });
      const codex = new CodexCliAdapter({
        clock: harness.clock,
        capacityFile: join(root, "capacity.json"),
        binary: stubCodex(root, "ok", runtime),
      });
      const staffing = new WorkerStaffing(harness.cp.db, harness.clock, harness.cp.audit, {
        runs: harness.cp.runs,
        tasks: {
          get: (taskId) => harness.cp.tasks.get(taskId),
          admitWorkerFanout: async () => allow(ReasonCode.OK, undefined),
        },
        bindings: harness.cp.bindings,
        sessions: harness.cp.sessions,
        providers: { requireForRole: () => codex },
        readiness: { checkSession: async () => allow(ReasonCode.OK, undefined) },
      }, runtime);
      const provisioned = await staffing.provision({
        runId: run.runId,
        taskId: run.taskId,
        provider: "gpt",
        model: "gpt-6.1-sol",
        ownerBindingGeneration: run.ownerBindingGeneration,
        fence: () => allow(ReasonCode.OK, {
          sessionId: run.ownerSessionId,
          bindingGeneration: run.ownerBindingGeneration,
        }),
      });
      expect(provisioned, JSON.stringify(provisioned)).toMatchObject({ allowed: true });
      if (!provisioned.allowed) return;
      expect(harness.cp.sessions.get(provisioned.value.workerSessionId)?.lifecycle).toBe("READY");
      expect(harness.cp.sessions.get(provisioned.value.workerSessionId)).toMatchObject({
        provider: "gpt",
        model: "gpt-6.1-sol",
      });
    } finally {
      harness.cp.close();
    }
  });
});

const retarget = (sessionId: string, db: { run: (sql: string, params: unknown[]) => unknown }, provider: string, model: string): void => {
  db.run(`UPDATE sessions SET provider = ?, model = ? WHERE session_id = ?`, [provider, model, sessionId]);
};

const startTurn = (runner: WorkerTurnRunner, world: ReturnType<typeof seedWorkerWorld>) =>
  runner.start({
    runId: world.runId,
    taskId: world.taskId,
    claimId: world.claimId,
    ownerSessionId: world.cto.sessionId,
    ownerBindingGeneration: world.cto.generation,
    timeoutMs: 20_000,
  });

describe("a worker turn runs on the bound session", () => {
  it("invokes codex exec for a gpt worker, on gpt-6.1-sol, with stdin closed", async () => {
    const core = makeCore();
    const world = seedWorkerWorld(core);
    retarget(world.worker.sessionId, world.db, "gpt", "gpt-6.1-sol");
    const root = tempDir("acp-codex-turn-");
    const codex = new CodexCliAdapter({
      clock: core.clock,
      capacityFile: join(root, "capacity.json"),
      binary: stubCodex(root, "edit"),
      managedWriteBroker: world.broker,
    });
    const claudeCalls: string[] = [];
    const claude = { invoke: () => { claudeCalls.push("claude"); throw new Error("claude must not run"); } } as unknown as ProviderAdapter;
    const texts: string[] = [];
    const prompts: string[] = [];
    const runner = new WorkerTurnRunner(
      {
        db: world.db,
        clock: world.clock,
        audit: world.audit,
        tasks: world.tasks,
        guard: world.guard,
        workerAdapter: (provider) => {
          if (provider !== "gpt") return claude;
          return {
            provider: codex.provider,
            isProduction: codex.isProduction,
            defaultModels: codex.defaultModels,
            invoke: async (request: InvocationRequest) => {
              prompts.push(request.prompt);
              const answer = await codex.invoke(request);
              texts.push(answer.text);
              return answer;
            },
          } as unknown as ProviderAdapter;
        },
      },
      { pollMs: 20 },
    );
    const started = await startTurn(runner, world);
    expect(started, JSON.stringify(started)).toMatchObject({ allowed: true });
    if (!started.allowed) return;
    await runner.settled(started.value.executionId);
    const execution = world.tasks.execution(started.value.executionId)!;
    expect(execution.status, JSON.stringify(runner.describe(execution.executionId, world.runId))).toBe("SUCCEEDED");
    expect(execution.provider).toBe("gpt");
    expect(execution.model).toBe("gpt-6.1-sol");
    expect(claudeCalls).toEqual([]);
    const report = JSON.parse(texts[0] ?? "{}") as { args: string[]; stdin: string; cwd: string };
    expect(report.args.slice(0, 5)).toEqual(["exec", "-m", "gpt-6.1-sol", "--skip-git-repo-check", "-o"]);
    expect(report.args).toContain("-s");
    expect(report.args).toContain("workspace-write");
    expect(report.args).toContain("sandbox_workspace_write.exclude_slash_tmp=true");
    expect(report.args).toContain("sandbox_workspace_write.exclude_tmpdir_env_var=true");
    expect(report.args).toContain("sandbox_workspace_write.network_access=false");
    expect(report.args).toContain("sandbox_workspace_write.writable_roots=[]");
    expect(report.args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(report.args[report.args.indexOf("--thread-source") + 1]).toBe(world.worker.externalSessionId);
    expect(report.stdin).toBe("");
    // #512 — a Codex worker reads through its shell, so its prompt allows read-only commands (the live
    // turn ended NO_CHANGE under "Do not run commands"); writes still go through apply_patch.
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("You may run read-only shell commands inside this working tree");
    expect(prompts[0]).toContain("Make every change with apply_patch");
    expect(prompts[0]).not.toContain("- Do not run commands,");
    expect(report.cwd).toBe(realpathSync(world.repoPath));
    expect(gitSync(world.repoPath, ["rev-parse", "HEAD"])).not.toBe(gitSync(world.repoPath, ["rev-parse", "HEAD^"]));
    const succeeded = world.audit.byKind("TASK_WORKER_TURN_SUCCEEDED");
    expect(succeeded).toHaveLength(1);
    expect(typeof succeeded[0]!.evidence["resultDigest"]).toBe("string");
    expect(succeeded[0]!.evidence["commitHead"]).toBe(gitSync(world.repoPath, ["rev-parse", "HEAD"]));
  });

  it("still launches a claude worker on opus", async () => {
    const core = makeCore();
    const world = seedWorkerWorld(core);
    const claude = new FakeWorkerAdapter(world.broker);
    const asked: string[] = [];
    const runner = new WorkerTurnRunner(
      {
        db: world.db,
        clock: world.clock,
        audit: world.audit,
        tasks: world.tasks,
        guard: world.guard,
        workerAdapter: (provider) => {
          asked.push(provider);
          return claude;
        },
      },
      { pollMs: 20 },
    );
    const started = await startTurn(runner, world);
    expect(started, JSON.stringify(started)).toMatchObject({ allowed: true });
    if (!started.allowed) return;
    await runner.settled(started.value.executionId);
    const execution = world.tasks.execution(started.value.executionId)!;
    expect(execution.status, JSON.stringify(runner.describe(execution.executionId, world.runId))).toBe("SUCCEEDED");
    expect(execution.provider).toBe("claude");
    expect(execution.model).toBe("opus");
    expect(asked).toEqual(["claude"]);
    expect(claude.requests[0]?.model).toBe("opus");
  });

  it("refuses a gpt worker whose model is not gpt-6.1-sol", async () => {
    const core = makeCore();
    const world = seedWorkerWorld(core);
    retarget(world.worker.sessionId, world.db, "gpt", "gpt-5.6-luna-max");
    const runner = new WorkerTurnRunner(
      {
        db: world.db,
        clock: world.clock,
        audit: world.audit,
        tasks: world.tasks,
        guard: world.guard,
        workerAdapter: () => new FakeWorkerAdapter(world.broker),
      },
      { pollMs: 20 },
    );
    const started = await startTurn(runner, world);
    expect(started.allowed).toBe(false);
    if (started.allowed) return;
    expect(started.reasonCode).toBe(ReasonCode.INVALID_ARGUMENT);
    expect(started.evidence).toMatchObject({ provider: "gpt", model: "gpt-5.6-luna-max", required: "gpt-6.1-sol" });
  });

  it("preserves a capacity refusal and does not launch the provider", async () => {
    const core = makeCore();
    const world = seedWorkerWorld(core);
    retarget(world.worker.sessionId, world.db, "gpt", "gpt-6.1-sol");
    world.tasks.attach({
      capacity: {
        refreshForWorkerFanout: async () => deny(ReasonCode.CAPACITY_UNKNOWN_NOT_ROUTABLE, "fixture capacity refusal"),
        hasRoleScoped: () => true,
        workerReserveDemand: admittingCapacity.workerReserveDemand,
      },
    });
    let invoked = false;
    const runner = new WorkerTurnRunner(
      {
        db: world.db,
        clock: world.clock,
        audit: world.audit,
        tasks: world.tasks,
        guard: world.guard,
        workerAdapter: () => {
          const adapter = new FakeWorkerAdapter(world.broker);
          const invoke = adapter.invoke.bind(adapter);
          adapter.invoke = async (request) => {
            invoked = true;
            return invoke(request);
          };
          return adapter;
        },
      },
      { pollMs: 20 },
    );
    const started = await startTurn(runner, world);
    expect(started.allowed).toBe(false);
    if (started.allowed) return;
    expect(started.reasonCode).toBe(ReasonCode.CAPACITY_UNKNOWN_NOT_ROUTABLE);
    expect(invoked).toBe(false);
  });
});
