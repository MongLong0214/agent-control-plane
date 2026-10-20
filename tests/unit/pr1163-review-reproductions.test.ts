import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { ManualClock } from "../../src/core/clock.ts";
import { SpawnCodexRateLimitProbe } from "../../src/capacity/usage-collectors.ts";
import { WorkerTurnRunner, type WorkerProcessPort } from "../../src/run/worker-turn.ts";
import { CodexCliAdapter, runtimeEnvironment, __testing } from "../../src/runtime/cli-adapters.ts";
import { makeCore, tempDir, cleanupTempDirs } from "../helpers/fixtures.ts";
import { seedWorkerWorld } from "../helpers/worker-turn-fixture.ts";

afterEach(() => { __testing.setRunCli(null); vi.restoreAllMocks(); });
afterAll(cleanupTempDirs);

const reaped = { pgid: 424242, reaped: true, signalled: true, signals: ["sent"], delivered: 1, ownership: "HELD" as const, detail: null };
const ok = { stdout: "ok", stderr: "", exitCode: 0, timedOut: false, isolationEnforced: false, processGroup: reaped };

it("PR1163-R1-01: restart can identify a live Codex worker from the actual adapter argv", async () => {
  const core = makeCore();
  const world = seedWorkerWorld(core);
  world.db.run("UPDATE sessions SET provider = 'gpt', model = 'gpt-6.1-sol' WHERE session_id = ?", [world.worker.sessionId]);
  let live = true;
  let killed = 0;
  let argv: string[] = [];
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  let spawned!: () => void;
  const sawSpawn = new Promise<void>((resolve) => { spawned = resolve; });
  const processes: WorkerProcessPort = {
    alive: () => live,
    groupAlive: () => live,
    startToken: () => "darwin-tv:1234.000001",
    argv: () => argv,
    killGroup: () => { killed += 1; live = false; finish(); },
  };
  __testing.setRunCli(async (file, args, options) => {
    argv = ["/bin/ksh", "-c", "holder-script", "acp-group-holder", file, ...args];
    // A positive control for the existing Claude-shaped ownership proof only.
    if (process.env["ACP_REVIEW_APPEND_SESSION_MARKER"] === "1") argv.push("--session-id", world.worker.externalSessionId);
    await options.onSpawn?.(424242, "darwin-tv:1234.000001");
    spawned();
    await pending;
    return ok;
  });
  const root = tempDir("pr1163-recovery-");
  const adapter = new CodexCliAdapter({ clock: core.clock, binary: process.execPath, capacityFile: join(root, "capacity.json"), managedWriteBroker: world.broker });
  const ports = { db: world.db, clock: world.clock, audit: world.audit, tasks: world.tasks, guard: world.guard, workerAdapter: () => adapter };
  const runner = new WorkerTurnRunner(ports, { processes, pollMs: 10, processSettleMs: 10 });
  let executionId: string | undefined;
  try {
    const started = await runner.start({ runId: world.runId, taskId: world.taskId, claimId: world.claimId, ownerSessionId: world.cto.sessionId, ownerBindingGeneration: world.cto.generation });
    expect(started.allowed).toBe(true);
    if (!started.allowed) return;
    executionId = started.value.executionId;
    await sawSpawn;
    const restarted = new WorkerTurnRunner(ports, { processes, processSettleMs: 10 });
    const outcomes = await restarted.reconcileAfterRestart();
    const event = world.audit.byKind("TASK_WORKER_ORPHAN_UNIDENTIFIED").at(-1);
    console.error("PR1163 recovery witness", JSON.stringify({ outcomes, killed, released: world.tasks.execution(executionId)?.workerProcessReleasedAt, ownership: event?.evidence["ownership"], argvHasSessionMarker: argv.includes("--session-id") }));
    expect(outcomes).toEqual([{ executionId, outcome: "KILLED" }]);
    expect(killed).toBe(1);
    expect(world.tasks.execution(executionId)?.workerProcessReleasedAt).not.toBeNull();
  } finally {
    live = false;
    finish();
    if (executionId) await runner.settled(executionId);
    await runner.shutdown(1000);
    core.db.close();
  }
});

it("PR1163-R1-02: capacity, login and worker exec use the configured Codex account", async () => {
  const root = tempDir("pr1163-account-");
  const account = process.env["ACP_REVIEW_USE_DEFAULT_HOME"] === "1" ? join(homedir(), ".codex") : join(root, "configured-account");
  mkdirSync(account);
  writeFileSync(join(account, "auth.json"), "configured-account-placeholder");
  const clock = new ManualClock("2026-10-20T00:00:00.000Z");
  const capacity = vi.spyOn(SpawnCodexRateLimitProbe.prototype, "read").mockResolvedValue({ primary: { usedPercent: 5, windowDurationMins: 300, resetsAt: 1792468800 } });
  const seen: Array<{ command: string; home: string; granted: readonly string[] }> = [];
  __testing.setRunCli(async (_file, args, options) => {
    // productionRunCli passes the configured account as the explicit codexHome argument.
    // The process environment is not a channel for it.
    const env = runtimeEnvironment(options.environmentAllowlist ?? [], root, options.providerCredentialDir, options.codexHome);
    seen.push({ command: args.slice(0, 2).join(" "), home: env["CODEX_HOME"] ?? join(env["HOME"]!, ".codex"), granted: options.writablePaths ?? [] });
    return ok;
  });
  const { allow } = await import("../../src/core/errors.ts");
  const { ReasonCode } = await import("../../src/core/reason-codes.ts");
  const adapter = new CodexCliAdapter({ clock, binary: process.execPath, capacityFile: join(root, "capacity.json"), codexHome: account, managedWriteBroker: { authorize: async (_write, effect) => allow(ReasonCode.OK, await effect()) } });
  const handle = await adapter.startSession({ model: "gpt-6.1-sol", workdir: root, purpose: "worker:review" });
  await adapter.probeCapacity();
  expect(await adapter.probeSession(handle)).toBe("HEALTHY");
  await adapter.invoke({ model: "gpt-6.1-sol", workdir: root, prompt: "offline witness", timeoutMs: 1000, correlationId: "review", readOnly: false, managedWrite: { operation: "FILE_MUTATION", targetPath: realpathSync(root), assignedWorktreeId: realpathSync(root), taskId: "review", taskReceiptId: "review#1", runId: "review", sessionId: "review", sessionIncarnation: "review#now", bindingGeneration: 1 } });
  console.error("PR1163 account witness", JSON.stringify({ capacityHome: capacity.mock.calls[0]?.[0].codexHome, selected: account, defaultHome: join(homedir(), ".codex"), seen }));
  expect(capacity.mock.calls[0]?.[0].codexHome).toBe(account);
  expect(seen.filter((call) => call.command !== "--version").map((call) => call.home)).toEqual([account, account]);
});
