import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, expect, it } from "vitest";
import { ManualClock } from "../../src/core/clock.ts";
import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { WorkerTurnRunner, type WorkerProcessPort } from "../../src/run/worker-turn.ts";
import { ClaudeCliAdapter, CodexCliAdapter, runtimeEnvironment, __testing } from "../../src/runtime/cli-adapters.ts";
import type { InvocationRequest } from "../../src/runtime/provider.ts";
import { cleanupTempDirs, makeCore, tempDir } from "../helpers/fixtures.ts";
import { seedWorkerWorld } from "../helpers/worker-turn-fixture.ts";

afterEach(() => { __testing.setRunCli(null); });
afterAll(cleanupTempDirs);

const reaped = { pgid: 424242, reaped: true, signalled: true, signals: ["sent"], delivered: 1, ownership: "HELD" as const, detail: null };
const ok = { stdout: "ok", stderr: "", exitCode: 0, timedOut: false, isolationEnforced: false, processGroup: reaped };
const START = "darwin-tv:1234.000001";

const managedWrite = (root: string): NonNullable<InvocationRequest["managedWrite"]> => ({
  operation: "FILE_MUTATION",
  targetPath: realpathSync(root),
  assignedWorktreeId: realpathSync(root),
  taskId: "review",
  taskReceiptId: "review#1",
  runId: "review",
  sessionId: "review",
  sessionIncarnation: "review#now",
  bindingGeneration: 1,
});

/**
 * Launch one Codex worker turn through the runner, using the adapter's real argv, then reconcile
 * as a restarted daemon would. `adjust` runs after spawn and before that reconcile.
 */
const reconcileCodexLaunch = async (
  adjust: (state: { argv: string[]; token: { value: string } }) => void,
): Promise<{ outcome: string; killed: number; argv: string[]; sandbox: string | undefined; codexHome: string | undefined }> => {
  const core = makeCore();
  const world = seedWorkerWorld(core);
  world.db.run("UPDATE sessions SET provider = 'gpt', model = 'gpt-6.1-sol' WHERE session_id = ?", [world.worker.sessionId]);
  const account = join(tempDir("codex-r1-account-"), "home");
  mkdirSync(account);
  let live = true;
  let killed = 0;
  let argv: string[] = [];
  let sandbox: string | undefined;
  let codexHome: string | undefined;
  const token = { value: START };
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  let spawned!: () => void;
  const sawSpawn = new Promise<void>((resolve) => { spawned = resolve; });
  const processes: WorkerProcessPort = {
    alive: () => live,
    groupAlive: () => live,
    startToken: () => token.value,
    argv: () => argv,
    killGroup: () => { killed += 1; live = false; finish(); },
  };
  __testing.setRunCli(async (file, args, options) => {
    argv = ["/bin/ksh", "-c", "holder-script", "acp-group-holder", file, ...args];
    sandbox = options.sandbox;
    codexHome = options.codexHome;
    await options.onSpawn?.(424242, START);
    spawned();
    await pending;
    return ok;
  });
  const adapter = new CodexCliAdapter({
    clock: core.clock,
    binary: process.execPath,
    capacityFile: join(account, "capacity.json"),
    codexHome: account,
    managedWriteBroker: world.broker,
  });
  const ports = { db: world.db, clock: world.clock, audit: world.audit, tasks: world.tasks, guard: world.guard, workerAdapter: () => adapter };
  const runner = new WorkerTurnRunner(ports, { processes, pollMs: 10, processSettleMs: 10 });
  let executionId: string | undefined;
  try {
    const started = await runner.start({
      runId: world.runId,
      taskId: world.taskId,
      claimId: world.claimId,
      ownerSessionId: world.cto.sessionId,
      ownerBindingGeneration: world.cto.generation,
    });
    expect(started.allowed).toBe(true);
    if (!started.allowed) return { outcome: "REFUSED", killed, argv, sandbox, codexHome };
    executionId = started.value.executionId;
    await sawSpawn;
    const marker = argv.indexOf("--thread-source");
    expect(argv[marker + 1]).toBe(world.worker.externalSessionId);
    expect(argv).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    adjust({ argv, token });
    const restarted = new WorkerTurnRunner(ports, { processes, processSettleMs: 10 });
    const outcomes = await restarted.reconcileAfterRestart();
    return { outcome: outcomes[0]?.outcome ?? "MISSING", killed, argv, sandbox, codexHome };
  } finally {
    live = false;
    finish();
    if (executionId) await runner.settled(executionId);
    await runner.shutdown(1000);
    core.db.close();
  }
};

it("restarts a Codex worker from its real --thread-source launch and still requires the start token", async () => {
  const matched = await reconcileCodexLaunch(() => undefined);
  expect(matched.outcome).toBe("KILLED");
  expect(matched.killed).toBe(1);
  expect(matched.sandbox).toBe("codex-workspace-write");
  expect(matched.argv).toContain("sandbox_workspace_write.exclude_slash_tmp=true");
  expect(matched.argv).toContain("sandbox_workspace_write.exclude_tmpdir_env_var=true");
  expect(matched.argv).toContain("sandbox_workspace_write.network_access=false");
  // The one writable root besides the checkout is the turn's own temporary directory.
  expect(matched.argv.filter((arg) => arg.startsWith("sandbox_workspace_write.writable_roots="))).toEqual([
    expect.stringMatching(/^sandbox_workspace_write\.writable_roots=\["[^"]+\/acp-codex-turn-[^"/]+"\]$/),
  ]);
  expect(matched.codexHome).toContain("/home");

  const mismatched = await reconcileCodexLaunch(({ token }) => { token.value = "darwin-tv:9999.000009"; });
  expect(mismatched.outcome).toBe("UNIDENTIFIED");
  expect(mismatched.killed).toBe(0);

  const wrongSession = await reconcileCodexLaunch(({ argv }) => {
    const marker = argv.indexOf("--thread-source");
    argv[marker + 1] = "00000000-0000-4000-8000-000000000000";
  });
  expect(wrongSession.outcome).toBe("UNIDENTIFIED");
  expect(wrongSession.killed).toBe(0);
});

it("pins the configured Codex home on the login probe and keeps the outer profile off the worker turn", async () => {
  const root = tempDir("codex-r1-pin-");
  const account = join(root, "configured-account");
  mkdirSync(account);
  const previous = process.env["CODEX_HOME"];
  const clock = new ManualClock("2026-10-20T00:00:00.000Z");
  const seen: Array<{ command: string; sandbox: string; home: string | undefined; during: string | undefined; child: string | undefined }> = [];
  __testing.setRunCli(async (_file, args, options) => {
    expect(args).not.toContain("sandbox_workspace_write.exclude_slash_tmp=true");
    expect(args).not.toContain("sandbox_workspace_write.network_access=false");
    expect(args.some((arg) => arg.startsWith("sandbox_workspace_write.writable_roots="))).toBe(false);
    expect(options.turnTemp).toBeUndefined();
    seen.push({
      command: args.slice(0, 2).join(" "),
      sandbox: options.sandbox ?? "outer-profile",
      home: options.codexHome,
      during: process.env["CODEX_HOME"],
      child: runtimeEnvironment(options.environmentAllowlist ?? [], root, undefined, options.codexHome)["CODEX_HOME"],
    });
    return ok;
  });
  const adapter = new CodexCliAdapter({
    clock,
    binary: process.execPath,
    capacityFile: join(root, "capacity.json"),
    codexHome: account,
    managedWriteBroker: { authorize: async (_write, effect) => allow(ReasonCode.OK, await effect()) },
  });
  const handle = await adapter.startSession({ model: "gpt-6.1-sol", workdir: root, purpose: "worker:review" });
  expect(await adapter.probeSession(handle)).toBe("HEALTHY");
  await adapter.invoke({
    model: "gpt-6.1-sol",
    workdir: root,
    prompt: "offline witness",
    timeoutMs: 1000,
    correlationId: "review",
    readOnly: false,
    managedWrite: managedWrite(root),
  });
  const session = "11111111-1111-4111-8111-111111111111";
  let workerSandbox: string | undefined;
  __testing.setRunCli(async (_file, args, options) => {
    workerSandbox = options.sandbox;
    expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(args).toContain("sandbox_workspace_write.exclude_slash_tmp=true");
    expect(args).toContain("sandbox_workspace_write.exclude_tmpdir_env_var=true");
    expect(args).toContain("sandbox_workspace_write.network_access=false");
    expect(options.turnTemp).toMatch(/\/acp-codex-turn-[^/]+$/);
    expect(args).toContain(`sandbox_workspace_write.writable_roots=${JSON.stringify([options.turnTemp])}`);
    expect(args[args.indexOf("--thread-source") + 1]).toBe(session);
    expect(options.codexHome).toBe(account);
    return ok;
  });
  await adapter.invoke({
    model: "gpt-6.1-sol",
    workdir: root,
    prompt: "worker turn",
    timeoutMs: 1000,
    correlationId: "worker",
    readOnly: false,
    externalSessionId: session,
    managedWrite: managedWrite(root),
    onSpawn: () => undefined,
  });
  expect(seen.map((call) => call.command)).toEqual(["login status", "exec -m"]);
  expect(seen.map((call) => call.sandbox)).toEqual(["outer-profile", "outer-profile"]);
  expect(seen.map((call) => call.home)).toEqual([account, account]);
  expect(seen.map((call) => call.child)).toEqual([account, account]);
  expect(seen.map((call) => call.during)).toEqual([previous, previous]);
  expect(workerSandbox).toBe("codex-workspace-write");
  expect(process.env["CODEX_HOME"]).toBe(previous);

  const claudeSeen: string[] = [];
  __testing.setRunCli(async (_file, _args, options) => {
    claudeSeen.push(options.sandbox ?? "outer-profile");
    return ok;
  });
  const claude = new ClaudeCliAdapter({ clock, binary: process.execPath, capacityFile: join(root, "claude.json") });
  await claude.invoke({
    prompt: "claude",
    workdir: root,
    timeoutMs: 1000,
    readOnly: true,
    correlationId: "claude",
    externalSessionId: session,
    onSpawn: () => undefined,
  });
  expect(claudeSeen).toEqual(["outer-profile"]);
});

it("overlapping account probes leave process.env.CODEX_HOME unchanged", async () => {
  const root = tempDir("codex-r1-overlap-");
  const inherited = join(root, "inherited");
  const account = join(root, "configured-account");
  mkdirSync(account);
  const previous = process.env["CODEX_HOME"];
  process.env["CODEX_HOME"] = inherited;
  const release: Array<() => void> = [];
  const seen: Array<{ phase: "start" | "end"; env: string | undefined; child: string | undefined }> = [];
  try {
    __testing.setRunCli(async (_file, _args, options) => {
      const child = runtimeEnvironment(options.environmentAllowlist ?? [], root, undefined, options.codexHome)["CODEX_HOME"];
      seen.push({ phase: "start", env: process.env["CODEX_HOME"], child });
      await new Promise<void>((resolve) => release.push(resolve));
      seen.push({ phase: "end", env: process.env["CODEX_HOME"], child });
      return ok;
    });
    const clock = new ManualClock("2026-10-20T00:00:00.000Z");
    const adapter = new CodexCliAdapter({
      clock,
      binary: process.execPath,
      capacityFile: join(root, "capacity.json"),
      codexHome: account,
    });
    const one = await adapter.startSession({ model: "gpt-6.1-sol", workdir: root, purpose: "worker:one" });
    const two = await adapter.startSession({ model: "gpt-6.1-sol", workdir: root, purpose: "worker:two" });
    const first = adapter.probeSession(one);
    const second = adapter.probeSession(two);
    expect(release).toHaveLength(2);
    expect(process.env["CODEX_HOME"]).toBe(inherited);
    release[0]!();
    expect(await first).toBe("HEALTHY");
    expect(process.env["CODEX_HOME"]).toBe(inherited);
    release[1]!();
    expect(await second).toBe("HEALTHY");
    expect(process.env["CODEX_HOME"]).toBe(inherited);
    expect(seen.map((row) => row.phase)).toEqual(["start", "start", "end", "end"]);
    expect(seen.map((row) => row.env)).toEqual([inherited, inherited, inherited, inherited]);
    expect(seen.map((row) => row.child)).toEqual([account, account, account, account]);
  } finally {
    for (const end of release) end();
    if (previous === undefined) delete process.env["CODEX_HOME"];
    else process.env["CODEX_HOME"] = previous;
  }
});
