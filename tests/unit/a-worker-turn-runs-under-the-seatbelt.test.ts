import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

import { ACP_SCRATCH_ROOT } from "../../src/core/scratch-root.ts";
import { ClaudeCliAdapter } from "../../src/runtime/cli-adapters.ts";
import type { InvocationRequest, InvocationResult, ProviderAdapter } from "../../src/runtime/provider.ts";
import { WorkerTurnRunner } from "../../src/run/worker-turn.ts";
import { requireSeatbelt, seatbeltStatus } from "../helpers/seatbelt.ts";
import { cleanupTempDirs, gitSync, makeCore, tempDir } from "../helpers/fixtures.ts";
import { seedWorkerWorld } from "../helpers/worker-turn-fixture.ts";

/**
 * The adapter allocates its per-invocation scratch under `~/.agent-control-plane/scratch`, read from
 * HOME when the module loads. That is the live daemon's state root, so this file points HOME at a
 * private directory before anything is imported; the scratch, its profile rules and the probe's HOME
 * all follow it.
 */
const isolatedHome = vi.hoisted(() => {
  const home = `${(process.env["TMPDIR"] ?? "/tmp").replace(/\/+$/, "")}/acp-worker-seatbelt-home-${process.pid}`;
  process.env["HOME"] = home;
  return home;
});

afterAll(() => {
  cleanupTempDirs();
  rmSync(isolatedHome, { recursive: true, force: true });
});


/**
 * A provider stand-in for the real ClaudeCliAdapter. It reports the argv it was given, edits the one
 * owned file inside its working tree, tries to write outside it, and answers as the session it was
 * told to be — the shape of a `claude -p --output-format json` answer.
 */
const workerProbe = (dir: string, outside: string): string => {
  const binary = join(dir, "worker-probe.mjs");
  writeFileSync(binary, `#!${process.execPath}
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const sessionId = argv[argv.indexOf("--session-id") + 1];
writeFileSync(join(process.cwd(), "src", "app.js"), "module.exports = () => 2;\\n");
let outsideDenied = false;
try {
  writeFileSync(${JSON.stringify(join(outside, "escaped.txt"))}, "escaped");
} catch (error) {
  outsideDenied = Boolean(error && (error.code === "EPERM" || error.code === "EACCES"));
}
const report = { argv, outsideDenied };
process.stdout.write(JSON.stringify({ type: "result", session_id: sessionId, result: JSON.stringify(report) }));
`);
  chmodSync(binary, 0o700);
  return binary;
};

describe("#512 a worker turn under the real Claude adapter and seatbelt", () => {
  it("edits only inside the claimed worktree with acceptEdits and no extra grant, and commits it", async (ctx) => {
    expect(ACP_SCRATCH_ROOT.startsWith(`${isolatedHome}/`)).toBe(true);
    const core = makeCore();
    const world = seedWorkerWorld(core);
    const probeDir = tempDir("acp-worker-probe-");
    const outside = tempDir("acp-worker-outside-");
    mkdirSync(join(outside, "x"), { recursive: true });
    const adapter = new ClaudeCliAdapter({
      clock: core.clock,
      capacityFile: join(probeDir, "capacity.json"),
      binary: workerProbe(probeDir, outside),
      managedWriteBroker: world.broker,
    });
    // The real adapter, observed: every answer it returns is kept for the assertions below.
    const answers: InvocationResult[] = [];
    const observed = {
      provider: adapter.provider,
      isProduction: adapter.isProduction,
      defaultModels: adapter.defaultModels,
      invoke: async (request: InvocationRequest) => {
        const answer = await adapter.invoke(request);
        answers.push(answer);
        return answer;
      },
    } as unknown as ProviderAdapter;
    const runner = new WorkerTurnRunner(
      { db: world.db, clock: world.clock, audit: world.audit, tasks: world.tasks, guard: world.guard, workerAdapter: () => observed },
      { pollMs: 20 },
    );
    const base = gitSync(world.repoPath, ["rev-parse", "HEAD"]);
    const started = await runner.start({
      runId: world.runId,
      taskId: world.taskId,
      claimId: world.claimId,
      ownerSessionId: world.cto.sessionId,
      ownerBindingGeneration: world.cto.generation,
      timeoutMs: 20_000,
    });
    if (!started.allowed) throw new Error(`${started.reasonCode}: ${started.message}`);
    await runner.settled(started.value.executionId);
    const execution = world.tasks.execution(started.value.executionId)!;

    if (!seatbeltStatus().applies) {
      // No unconfined fallback exists: without seatbelt the turn cannot succeed or commit. The
      // confinement this test claims is then unverified here, so it is skipped loudly — never passed.
      expect(execution.status).not.toBe("SUCCEEDED");
      expect(gitSync(world.repoPath, ["rev-parse", "HEAD"])).toBe(base);
      requireSeatbelt(ctx);
    }

    expect(execution.status, JSON.stringify(runner.describe(execution.executionId, world.runId))).toBe("SUCCEEDED");
    expect(execution.workerProcessId).not.toBeNull();
    expect(execution.workerProcessStartedAt).toMatch(/^darwin-tv:/);
    const commitHead = gitSync(world.repoPath, ["rev-parse", "HEAD"]);
    expect(gitSync(world.repoPath, ["rev-parse", `${commitHead}^`])).toBe(base);
    expect(readFileSync(join(world.repoPath, "src", "app.js"), "utf8")).toBe("module.exports = () => 2;\n");
    expect(existsSync(join(outside, "escaped.txt"))).toBe(false);

    const succeeded = world.audit.byKind("TASK_WORKER_TURN_SUCCEEDED");
    expect(succeeded).toHaveLength(1);
    expect(succeeded[0]!.evidence["commitHead"]).toBe(commitHead);
    expect(succeeded[0]!.evidence["providerSessionId"]).toBe(world.worker.externalSessionId);

    // What the provider process was actually given: acceptEdits, its own session id, and no grant of
    // Bash, network or any tool beyond what acceptEdits means.
    expect(answers).toHaveLength(1);
    const report = JSON.parse(answers[0]!.text) as { argv: string[]; outsideDenied: boolean };
    expect(report.outsideDenied).toBe(true);
    const mode = report.argv.indexOf("--permission-mode");
    expect(report.argv[mode + 1]).toBe("acceptEdits");
    expect(report.argv[report.argv.indexOf("--session-id") + 1]).toBe(world.worker.externalSessionId);
    expect(report.argv[report.argv.indexOf("--model") + 1]).toBe("opus");
    for (const grant of ["--allowedTools", "--allowed-tools", "--dangerously-skip-permissions", "--add-dir"]) {
      expect(report.argv).not.toContain(grant);
    }
    // ...and not the operator's configuration: the worktree's setting sources only, no MCP server.
    expect(report.argv[report.argv.indexOf("--setting-sources") + 1]).toBe("project,local");
    expect(report.argv[report.argv.indexOf("--mcp-config") + 1]).toBe(JSON.stringify({ mcpServers: {} }));
    expect(report.argv).toContain("--strict-mcp-config");
  });
});
