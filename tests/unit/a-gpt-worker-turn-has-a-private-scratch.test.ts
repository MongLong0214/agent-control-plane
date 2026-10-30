import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { acpScratchDir } from "../../src/core/scratch-root.ts";
import { WorkerTurnRunner } from "../../src/run/worker-turn.ts";
import { CodexCliAdapter } from "../../src/runtime/cli-adapters.ts";
import type { InvocationRequest, InvocationResult, ProviderAdapter } from "../../src/runtime/provider.ts";
import { cleanupTempDirs, gitSync, makeCore, tempDir } from "../helpers/fixtures.ts";
import { seedWorkerWorld } from "../helpers/worker-turn-fixture.ts";

afterAll(cleanupTempDirs);

/**
 * A GPT worker turn gets one private writable directory outside the checkout, for the temporary
 * files and caches its tools write. Before it, `$TMPDIR` was a directory the turn's sandbox refused,
 * so the checkout was the only writable place: a worker that exited 0 failed its turn
 * WRITE_TARGET_OUTSIDE_RUN_SCOPE on the node compile cache and `xcrun_db` it had left there.
 *
 * The stub below is Codex `exec -s workspace-write` as far as these witnesses need it: the commands
 * it runs are confined by a seatbelt built from the argv and environment the adapter gave it — the
 * working directory and each `writable_roots` entry, plus /tmp and `$TMPDIR` unless excluded.
 */

const STUB = String.raw`
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const here = dirname(process.argv[1]);
const fixture = (name) => readFileSync(join(here, name), "utf8").trim();
const mode = fixture("mode");
if (mode !== "ok" && mode !== "fail") {
  // Leaves a file in the scratch, lets the test revoke the worker's binding when asked to, then fails.
  // "chmod" leaves the scratch unremovable until its permissions are restored; "uchg" leaves it
  // unremovable for good, with an immutable file inside.
  const evidence = join(process.env.TMPDIR, "cache-evidence.txt");
  writeFileSync(evidence, "written before the turn ended\n");
  writeFileSync(join(here, "tmpdir"), process.env.TMPDIR);
  writeFileSync(join(here, "ready"), "");
  if (mode === "uchg") spawnSync("/usr/bin/chflags", ["uchg", evidence], { timeout: 5000 });
  if (mode.startsWith("chmod")) {
    // A link out of the scratch, to a directory whose permissions the cleanup must not change.
    mkdirSync(join(here, "outside"), { mode: 0o500 });
    symlinkSync(join(here, "outside"), join(process.env.TMPDIR, "outside-link"));
    chmodSync(process.env.TMPDIR, 0o500);
  }
  const until = Date.now() + 20000;
  while (fixture("mode") === "revoke" && !existsSync(join(here, "revoked")) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  process.exit(1);
}
const args = process.argv.slice(2);
const out = args[args.indexOf("-o") + 1];
const setting = (key) => {
  const entry = args.find((arg, index) => args[index - 1] === "-c" && arg.startsWith(key + "="));
  return entry === undefined ? undefined : entry.slice(key.length + 1);
};
const roots = [process.cwd(), ...JSON.parse(setting("sandbox_workspace_write.writable_roots") ?? "[]")];
if (setting("sandbox_workspace_write.exclude_slash_tmp") !== "true") roots.push("/private/tmp");
if (setting("sandbox_workspace_write.exclude_tmpdir_env_var") !== "true") roots.push(process.env.TMPDIR);
const allowed = roots.map((root) => '(subpath "' + realpathSync(root) + '")').join(" ");
const profile = '(version 1) (allow default) (deny file-write*) (allow file-write* (literal "/dev/null") ' + allowed + ")";
const task = spawnSync("/usr/bin/sandbox-exec", ["-p", profile, "/bin/sh", join(here, "task.sh")], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    NODE_BIN: process.execPath,
    TOOL: join(here, "tool.cjs"),
    RESULT_FILE: out,
    SIBLING: fixture("sibling"),
    SLASH_TMP: fixture("slash-tmp"),
  },
  encoding: "utf8",
  timeout: 20_000,
});
const report = {};
for (const line of task.stdout.split("\n")) {
  const at = line.indexOf("=");
  if (at > 0) report[line.slice(0, at)] = line.slice(at + 1);
}
const ok = fixture("mode") === "ok";
if (ok) writeFileSync(join(process.cwd(), "src", "app.js"), "module.exports = () => 2;\n");
writeFileSync(out, JSON.stringify({ args, tmpdir: process.env.TMPDIR, report, stderr: task.stderr }));
process.exit(ok ? 0 : 1);
`;

// What a worker's tools do: write a temporary file, run node with its compile cache, ask xcrun for a
// tool. Then the writes that must stay refused: /tmp, the result file and its directory, and the
// scratch of another turn.
const TASK = String.raw`
probe() { if ( : > "$1" ) 2>/dev/null; then echo "$2=written"; else echo "$2=refused"; fi; }
if ( echo scratch > "$TMPDIR/probe.txt" ) 2>/dev/null; then echo "tmpdir=written"; else
  echo "tmpdir=refused"
  # A worker whose temporary directory refuses writes retries where it can write: the checkout.
  TMPDIR="$PWD"; export TMPDIR
fi
echo "compile=$("$NODE_BIN" "$TOOL" 2>/dev/null)"
if /usr/bin/xcrun --find clang >/dev/null 2>&1; then echo "xcrun=ran"; else echo "xcrun=unavailable"; fi
if [ -n "$xcrun_db" ] && [ -f "$xcrun_db" ]; then echo "xcrundb=$xcrun_db"; fi
probe "$SLASH_TMP" slashtmp
probe "$RESULT_FILE" result
probe "$(dirname "$RESULT_FILE")/planted" resultdir
probe "$SIBLING/planted" sibling
`;

// The compile cache as tools enable it, with no directory named: NODE_COMPILE_CACHE, else the temp dir.
// It reports how many entries the cache directory holds right after its own flush.
const TOOL = String.raw`
const { readdirSync } = require("node:fs");
const compile = require("node:module");
const status = compile.enableCompileCache();
require("./lib.cjs");
compile.flushCompileCache();
if (status.status === compile.constants.compileCacheStatus.FAILED || status.directory === undefined) {
  process.stdout.write("failed");
} else {
  process.stdout.write(readdirSync(status.directory).length + ":" + status.directory);
}
`;

type Mode = "ok" | "fail" | "revoke" | "throw" | "chmod" | "chmod-throw" | "uchg";

const stubCodex = (root: string, mode: Mode, sibling: string, slashTmp: string): string => {
  const binary = join(root, "codex");
  writeFileSync(join(root, "mode"), mode);
  writeFileSync(join(root, "sibling"), sibling);
  writeFileSync(join(root, "slash-tmp"), slashTmp);
  writeFileSync(join(root, "task.sh"), TASK);
  writeFileSync(join(root, "tool.cjs"), TOOL);
  writeFileSync(join(root, "lib.cjs"), "module.exports = 1;\n");
  writeFileSync(binary, `#!${process.execPath}\n${STUB}`);
  chmodSync(binary, 0o700);
  return binary;
};

// Where xcrun can run at all, the turn's xcrun must have run and written its database to the scratch.
const xcrunRuns = (): boolean => spawnSync("/usr/bin/xcrun", ["--find", "clang"], {
  stdio: "ignore",
  timeout: 20_000,
  env: { ...process.env, xcrun_db: join(tempDir("acp-xcrun-check-"), "xcrun_db") },
}).status === 0;

interface StubReport {
  args: string[];
  tmpdir: string;
  report: Record<string, string>;
  stderr: string;
}

const runTurn = async (mode: Mode) => {
  const core = makeCore();
  const world = seedWorkerWorld(core);
  world.db.run("UPDATE sessions SET provider = 'gpt', model = 'gpt-6.1-sol' WHERE session_id = ?", [world.worker.sessionId]);
  const root = tempDir("acp-turn-scratch-");
  // Another execution's scratch, beside this turn's own.
  const sibling = realpathSync(acpScratchDir("acp-codex-turn-"));
  writeFileSync(join(sibling, "kept.txt"), "another turn\n");
  const slashTmp = `/private/tmp/acp-turn-scratch-probe-${process.pid}-${mode}`;
  const codex = new CodexCliAdapter({
    clock: core.clock,
    capacityFile: join(root, "capacity.json"),
    binary: stubCodex(root, mode, sibling, slashTmp),
    managedWriteBroker: mode === "throw" || mode === "chmod-throw"
      ? {
        authorize: async (write, effect) => {
          await world.broker.authorize(write, effect);
          throw new Error("the broker failed after the turn ran");
        },
      }
      : world.broker,
  });
  const texts: string[] = [];
  const answers: InvocationResult[] = [];
  const runner = new WorkerTurnRunner(
    {
      db: world.db,
      clock: world.clock,
      audit: world.audit,
      tasks: world.tasks,
      guard: world.guard,
      workerAdapter: () => ({
        provider: codex.provider,
        isProduction: codex.isProduction,
        defaultModels: codex.defaultModels,
        invoke: async (request: InvocationRequest) => {
          const answer = await codex.invoke(request);
          texts.push(answer.text);
          answers.push(answer);
          return answer;
        },
      }) as unknown as ProviderAdapter,
    },
    { pollMs: 20 },
  );
  // The worker's binding is revoked while its turn runs, so the broker refuses once the turn ends.
  const revokeWhenReady = async (): Promise<void> => {
    const until = Date.now() + 25_000;
    while (!existsSync(join(root, "ready"))) {
      if (Date.now() > until) throw new Error("the stub never wrote into its scratch");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    world.db.run(
      `UPDATE assignments SET status = 'REVOKED', revoked_at = ?, revoked_reason = 'revoked while the turn ran'
        WHERE role = 'WORKER' AND task_id = ? AND status = 'ACTIVE'`,
      [new Date().toISOString(), world.taskId],
    );
    writeFileSync(join(root, "revoked"), "");
  };
  try {
    const started = await runner.start({
      runId: world.runId,
      taskId: world.taskId,
      claimId: world.claimId,
      ownerSessionId: world.cto.sessionId,
      ownerBindingGeneration: world.cto.generation,
      timeoutMs: 30_000,
    });
    expect(started, JSON.stringify(started)).toMatchObject({ allowed: true });
    if (!started.allowed) throw new Error("the turn did not start");
    await Promise.all([runner.settled(started.value.executionId), mode === "revoke" ? revokeWhenReady() : undefined]);
    const execution = world.tasks.execution(started.value.executionId)!;
    const described = JSON.stringify(runner.describe(execution.executionId, world.runId));
    const stub = JSON.parse(texts[0] || "{}") as StubReport;
    return {
      world,
      execution,
      described,
      stub,
      answers,
      root,
      revokedScratch: existsSync(join(root, "tmpdir")) ? readFileSync(join(root, "tmpdir"), "utf8") : null,
      sibling,
      slashTmpWritten: existsSync(slashTmp),
      checkout: gitSync(world.repoPath, ["status", "--porcelain", "--ignored", "--untracked-files=all"]),
    };
  } finally {
    rmSync(slashTmp, { force: true });
  }
};

type Turn = Awaited<ReturnType<typeof runTurn>>;

/** Both outcomes: the scratch is the one extra writable root, the tools used it, and it is gone. */
const expectPrivateScratch = (turn: Turn): string => {
  const { stub } = turn;
  const scratch = stub.tmpdir;
  const result = stub.args[stub.args.indexOf("-o") + 1]!;
  expect(stub.args).toContain("sandbox_workspace_write.exclude_slash_tmp=true");
  expect(stub.args).toContain("sandbox_workspace_write.exclude_tmpdir_env_var=true");
  expect(stub.args).toContain("sandbox_workspace_write.network_access=false");
  expect(stub.args.filter((arg) => arg.startsWith("sandbox_workspace_write.writable_roots="))).toEqual([
    `sandbox_workspace_write.writable_roots=${JSON.stringify([scratch])}`,
  ]);
  // Outside the checkout, and not the directory the result file is read back from.
  expect(scratch.startsWith(`${realpathSync(turn.world.repoPath)}/`)).toBe(false);
  expect(dirname(result)).not.toBe(scratch);
  expect(result.startsWith(`${scratch}/`)).toBe(false);

  // The tools wrote into the scratch while it was alive.
  expect(stub.report["tmpdir"], stub.stderr).toBe("written");
  const compile = stub.report["compile"] ?? "failed";
  const at = compile.indexOf(":");
  expect(at, compile).toBeGreaterThan(0);
  expect(Number(compile.slice(0, at))).toBeGreaterThan(0);
  expect(compile.slice(at + 1).startsWith(`${scratch}/node-compile-cache/`)).toBe(true);
  if (xcrunRuns()) expect(stub.report["xcrun"]).toBe("ran");
  if (stub.report["xcrun"] === "ran") expect(stub.report["xcrundb"]).toBe(join(scratch, "xcrun_db"));

  // Nothing else became writable.
  expect(stub.report["slashtmp"]).toBe("refused");
  expect(turn.slashTmpWritten).toBe(false);
  expect(stub.report["result"]).toBe("refused");
  expect(stub.report["resultdir"]).toBe("refused");
  expect(stub.report["sibling"]).toBe("refused");

  // Nothing landed in the checkout, the scratch is gone, and another execution's scratch is untouched.
  expect(turn.checkout).toBe("");
  expect(existsSync(scratch)).toBe(false);
  expect(readFileSync(join(turn.sibling, "kept.txt"), "utf8")).toBe("another turn\n");
  expect(existsSync(join(turn.sibling, "planted"))).toBe(false);
  rmSync(turn.sibling, { recursive: true, force: true });
  return scratch;
};

/** What the turn wrote to its scratch, recorded with the execution before the scratch was removed. */
const expectRecordedScratch = (turn: Turn, evidence: Record<string, unknown>): void => {
  const recorded = evidence["turnScratch"] as { files: number; bytes: number; paths: string[]; complete: boolean } | undefined;
  expect(recorded, JSON.stringify(evidence)).toBeDefined();
  expect(recorded!.complete).toBe(true);
  expect(recorded!.files).toBeGreaterThan(1);
  expect(recorded!.bytes).toBeGreaterThan(0);
  expect(recorded!.paths).toContain("probe.txt");
  expect(recorded!.paths.some((path) => path.startsWith("node-compile-cache/"))).toBe(true);
  if (turn.stub.report["xcrun"] === "ran") expect(recorded!.paths).toContain("xcrun_db");
};

describe("a gpt worker turn has a private scratch outside the checkout", () => {
  it("succeeds when its tools write temporary files and caches, and leaves only the in-scope change", async () => {
    const turn = await runTurn("ok");
    expect(turn.execution.status, turn.described).toBe("SUCCEEDED");
    expectPrivateScratch(turn);
    const succeeded = turn.world.audit.byKind("TASK_WORKER_TURN_SUCCEEDED");
    expect(succeeded).toHaveLength(1);
    expect(succeeded[0]!.evidence["paths"]).toEqual(["src/app.js"]);
    expectRecordedScratch(turn, succeeded[0]!.evidence);
  });

  it("removes the scratch after a failed turn too, with the checkout clean and the result file kept unwritable", async () => {
    const turn = await runTurn("fail");
    expect(turn.execution.status, turn.described).toBe("FAILED");
    expectPrivateScratch(turn);
    const failed = turn.world.audit.byKind("TASK_WORKER_TURN_FAILED");
    expect(failed).toHaveLength(1);
    expect(failed[0]!.evidence["paths"]).toEqual([]);
    expectRecordedScratch(turn, failed[0]!.evidence);
  });

  it("records what the turn wrote to its scratch when the broker refuses after the turn ran, then removes it", async () => {
    const turn = await runTurn("revoke");
    rmSync(turn.sibling, { recursive: true, force: true });
    expect(turn.execution.status, turn.described).not.toBe("SUCCEEDED");
    const answer = turn.answers[0]!;
    expect(answer.ok).toBe(false);
    expect(answer.error).toContain("BINDING_REVOKED");
    expect(answer.turnScratch?.paths).toContain("cache-evidence.txt");
    const recorded = turn.world.audit.forRun(turn.world.runId).filter((event) =>
      event.evidence["executionId"] === turn.execution.executionId && event.evidence["turnScratch"] !== undefined);
    expect(recorded.length, turn.described).toBeGreaterThan(0);
    expect((recorded[0]!.evidence["turnScratch"] as { paths: string[] }).paths).toContain("cache-evidence.txt");
    expect(turn.revokedScratch).toMatch(/\/acp-codex-turn-[^/]+$/);
    expect(existsSync(turn.revokedScratch!)).toBe(false);
  });

  it("records the scratch with the error when the invocation throws, then removes it", async () => {
    const turn = await runTurn("throw");
    rmSync(turn.sibling, { recursive: true, force: true });
    expect(turn.execution.status, turn.described).toBe("FAILED");
    expect(turn.answers).toEqual([]);
    const failed = turn.world.audit.byKind("TASK_WORKER_TURN_FAILED");
    expect(failed).toHaveLength(1);
    expect(failed[0]!.evidence["error"]).toBe("the broker failed after the turn ran");
    expect((failed[0]!.evidence["turnScratch"] as { paths: string[] } | undefined)?.paths).toContain("cache-evidence.txt");
    expect(existsSync(turn.revokedScratch!)).toBe(false);
  });
});

interface RecordedCleanup { paths: string[]; cleanup?: { path: string; code: string; left: boolean } }

/** The failure event's scratch record: what the turn wrote, and the note its failed removal left. */
const failureScratch = (turn: Turn): RecordedCleanup => {
  const failed = turn.world.audit.byKind("TASK_WORKER_TURN_FAILED");
  expect(failed, turn.described).toHaveLength(1);
  return failed[0]!.evidence["turnScratch"] as RecordedCleanup;
};

describe("a scratch that cannot be removed never replaces the turn's outcome", () => {
  it("keeps a returned result, notes the failed removal, and removes the scratch once its permissions are restored", async () => {
    const turn = await runTurn("chmod");
    rmSync(turn.sibling, { recursive: true, force: true });
    expect(turn.execution.status, turn.described).toBe("FAILED");
    expect(turn.answers).toHaveLength(1);
    expect(turn.answers[0]!.exitCode).toBe(1);
    expect(turn.answers[0]!.error ?? "").not.toContain("EACCES");
    const recorded = failureScratch(turn);
    expect(recorded.paths).toContain("cache-evidence.txt");
    expect(recorded.cleanup).toEqual({ path: turn.revokedScratch, code: "EACCES", left: false });
    expect(turn.answers[0]!.turnScratch?.cleanup).toEqual(recorded.cleanup);
    expect(existsSync(turn.revokedScratch!)).toBe(false);
    expect(statSync(join(turn.root, "outside")).mode & 0o777).toBe(0o500);
  });

  it("keeps the thrown error, notes the failed removal, and removes the scratch once its permissions are restored", async () => {
    const turn = await runTurn("chmod-throw");
    rmSync(turn.sibling, { recursive: true, force: true });
    expect(turn.execution.status, turn.described).toBe("FAILED");
    expect(turn.answers).toEqual([]);
    const failed = turn.world.audit.byKind("TASK_WORKER_TURN_FAILED");
    expect(failed[0]!.evidence["error"]).toBe("the broker failed after the turn ran");
    const recorded = failureScratch(turn);
    expect(recorded.paths).toContain("cache-evidence.txt");
    expect(recorded.cleanup).toEqual({ path: turn.revokedScratch, code: "EACCES", left: false });
    expect(existsSync(turn.revokedScratch!)).toBe(false);
  });

  it("records a scratch it could not remove at all as left, and keeps the outcome", async () => {
    const turn = await runTurn("uchg");
    rmSync(turn.sibling, { recursive: true, force: true });
    const scratch = turn.revokedScratch!;
    try {
      expect(turn.execution.status, turn.described).toBe("FAILED");
      expect(turn.answers).toHaveLength(1);
      expect(turn.answers[0]!.exitCode).toBe(1);
      const recorded = failureScratch(turn);
      expect(recorded.paths).toContain("cache-evidence.txt");
      expect(recorded.cleanup).toEqual({ path: scratch, code: "EPERM", left: true });
      expect(existsSync(join(scratch, "cache-evidence.txt"))).toBe(true);
    } finally {
      spawnSync("/usr/bin/chflags", ["-R", "nouchg", scratch], { timeout: 5000 });
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
