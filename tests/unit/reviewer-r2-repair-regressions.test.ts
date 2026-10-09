import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Daemon } from "../../src/daemon/daemon.ts";
import { Role } from "../../src/domain/types.ts";
import { WorkerTurnRunner, type WorkerTurnOptions } from "../../src/run/worker-turn.ts";
import type { ProviderAdapter } from "../../src/runtime/provider.ts";
import { cleanupTempDirs, commitAll, gitSync, makeCore, makeRepo, tempDir } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";
import { FakeWorkerAdapter, admittingCapacity, seedWorkerWorld, type WorkerWorld } from "../helpers/worker-turn-fixture.ts";

/**
 * #1070 round 2 — the reviewer's reproductions against 1577a517 (ACP-WORKER-03 pending admissions,
 * ACP-WORKER-05 submodules, ACP-WORKER-06 concurrent staging), recreated from the review's
 * descriptions. Each is RED on 1577a517 and GREEN after the repair.
 *
 * The daemon's own runner allocates scratch under HOME, so HOME is a private directory for this file.
 */
const isolatedHome = vi.hoisted(() => {
  const home = `${(process.env["TMPDIR"] ?? "/tmp").replace(/\/+$/, "")}/acp-reviewer-r2-home-${process.pid}`;
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

const makeRunner = (world: WorkerWorld, adapter: ProviderAdapter, options: WorkerTurnOptions = {}): WorkerTurnRunner =>
  new WorkerTurnRunner(
    { db: world.db, clock: world.clock, audit: world.audit, tasks: world.tasks, guard: world.guard, workerAdapter: () => adapter },
    { pollMs: 10, scratchDir: (prefix: string) => tempDir(prefix), ...options },
  );

const request = (world: WorkerWorld) => ({
  runId: world.runId,
  taskId: world.taskId,
  claimId: world.claimId,
  ownerSessionId: world.cto.sessionId,
  ownerBindingGeneration: world.cto.generation,
});

const executionsOf = (world: WorkerWorld): number =>
  world.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM task_executions WHERE task_id = ?`, [world.taskId])!.n;

/** Runs one turn to its end; "REFUSED" when it never started. */
const turnOutcome = async (world: WorkerWorld, runner: WorkerTurnRunner): Promise<string> => {
  const started = await runner.start(request(world));
  if (!started.allowed) return "REFUSED";
  await runner.settled(started.value.executionId);
  return world.tasks.execution(started.value.executionId)!.status;
};

/** A checked-out submodule at `vendor/dependency`, committed in the worker's branch. */
const withSubmodule = (world: WorkerWorld): string => {
  const dependency = makeRepo({ "lib.js": "module.exports = 'dependency';\n" });
  gitSync(world.repoPath, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", dependency, "vendor/dependency"]);
  commitAll(world.repoPath, "add a submodule");
  return join(world.repoPath, "vendor", "dependency");
};

describe("#1070 round 2 reviewer reproductions", () => {
  it("ACP-WORKER-03: an admission pending when Daemon.stop() begins never launches a child", async () => {
    const h = makeHarness();
    const world = seedWorkerWorld({
      db: h.cp.db, clock: h.cp.clock, audit: h.cp.audit, sessions: h.cp.sessions, bindings: h.cp.bindings, telemetry: h.cp.telemetry,
    });
    h.cp.tasks.attach({ capacity: admittingCapacity });
    const adapter = fakeFor(world);
    adapter.script = { hold: true };
    h.cp.providers.registerForRole(adapter, Role.WORKER);
    const daemon = new Daemon(h.cp, { stateDir: tempDir("acp-daemon-stop-") });
    expect(daemon.lock.acquire(h.cp.clock.nowIso()).allowed).toBe(true);

    // Admission begins, and is still preparing the worktree when the daemon stops.
    const admission = h.cp.workerTurns.start(request(world));
    await daemon.stop();
    const admitted = await admission;

    expect(admitted.allowed, "a start admitted before shutdown launched after it").toBe(false);
    expect(adapter.launches, "a child was launched after the daemon released its authority").toBe(0);
    expect(executionsOf(world)).toBe(0);
    const drained = h.cp.audit.byKind("TASK_WORKER_TURNS_DRAINED").at(-1)!.evidence;
    expect(drained["admissions"]).toBe(1);
    expect(drained["pendingStarts"]).toBe(0);
    expect(drained["drained"]).toBe(true);
  });

  it("ACP-WORKER-03: a start that begins before shutdown is waited for, and refused before it launches", async () => {
    const world = seedWorkerWorld(makeCore());
    const adapter = fakeFor(world);
    adapter.script = { hold: true };
    const runner = makeRunner(world, adapter);
    const admission = runner.start(request(world));
    const stopped = runner.shutdown(5_000);
    const admitted = await admission;
    const result = await stopped;
    expect(admitted.allowed).toBe(false);
    expect(admitted.reasonCode).toBe(ReasonCode.CONFLICT);
    expect(adapter.launches).toBe(0);
    expect(executionsOf(world)).toBe(0);
    expect(result.drained).toBe(true);
    const drained = world.audit.byKind("TASK_WORKER_TURNS_DRAINED").at(-1)!.evidence;
    expect(drained["admissions"]).toBe(1);
    expect(drained["pendingStarts"]).toBe(0);
  });

  it("ACP-WORKER-03: a start that begins after shutdown is refused at once", async () => {
    const world = seedWorkerWorld(makeCore());
    const adapter = fakeFor(world);
    adapter.script = { hold: true };
    const runner = makeRunner(world, adapter);
    const stopped = runner.shutdown(5_000);
    const admitted = await runner.start(request(world));
    expect(admitted.allowed).toBe(false);
    expect(admitted.reasonCode).toBe(ReasonCode.CONFLICT);
    expect((await stopped).drained).toBe(true);
    expect(adapter.launches).toBe(0);
    expect(executionsOf(world)).toBe(0);
  });

  it("ACP-WORKER-05: a dirty tracked submodule does not admit a worker", async () => {
    const world = seedWorkerWorld(makeCore());
    const submodule = withSubmodule(world);
    writeFileSync(join(submodule, "lib.js"), "module.exports = 'changed before the turn';\n");
    expect(gitSync(world.repoPath, ["status", "--porcelain"])).toContain("vendor/dependency");
    const adapter = fakeFor(world);
    const started = await makeRunner(world, adapter).start(request(world));
    expect(started.allowed, "a worker was admitted on a dirty submodule").toBe(false);
    expect(adapter.launches).toBe(0);
  });

  it("ACP-WORKER-05: an owned edit with an unowned submodule edit does not succeed", async () => {
    const world = seedWorkerWorld(makeCore());
    withSubmodule(world);
    const base = gitSync(world.repoPath, ["rev-parse", "HEAD"]);
    const adapter = fakeFor(world);
    adapter.script = {
      writes: {
        "src/app.js": "module.exports = () => 2;\n",
        "vendor/dependency/lib.js": "module.exports = 'changed by the worker';\n",
      },
    };
    expect(await turnOutcome(world, makeRunner(world, adapter)), "a turn that changed a submodule succeeded").not.toBe("SUCCEEDED");
    expect(gitSync(world.repoPath, ["rev-parse", "HEAD"])).toBe(base);
  });

  it("ACP-WORKER-06: work staged by someone else during a turn is never erased by its commit", async () => {
    const world = seedWorkerWorld(makeCore());
    const staged = join(tempDir("acp-staged-"), "README.md");
    writeFileSync(staged, "# staged by someone else\n");
    const blob = gitSync(world.repoPath, ["hash-object", "-w", staged]);
    const base = gitSync(world.repoPath, ["rev-parse", "HEAD"]);
    const adapter = fakeFor(world);
    adapter.script = {
      writes: { "src/app.js": "module.exports = () => 2;\n" },
      // Staged without touching the working tree: README.md's bytes stay HEAD's.
      whileLatched: () => {
        gitSync(world.repoPath, ["update-index", "--cacheinfo", `100644,${blob},README.md`]);
      },
    };
    const outcome = await turnOutcome(world, makeRunner(world, adapter));
    expect(gitSync(world.repoPath, ["ls-files", "-s", "README.md"]), "the staged blob was replaced").toContain(blob);
    expect(outcome, "a turn that raced staged work succeeded").not.toBe("SUCCEEDED");
    expect(gitSync(world.repoPath, ["rev-parse", "HEAD"])).toBe(base);
    expect(readFileSync(join(world.repoPath, "src", "app.js"), "utf8")).toBe("module.exports = () => 2;\n");
  });
});
