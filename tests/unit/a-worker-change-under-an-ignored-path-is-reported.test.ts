import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { WorkerTurnRunner } from "../../src/run/worker-turn.ts";
import { cleanupTempDirs, gitSync, makeCore, tempDir } from "../helpers/fixtures.ts";
import { FakeWorkerAdapter, recordSeededTarget, seedWorkerWorld, type WorkerWorld } from "../helpers/worker-turn-fixture.ts";

/**
 * #1097 — the worker's diff scan lists untracked paths with `--exclude-standard`, so a change under an
 * ignored path was neither committed nor reported: worker output could be lost with no word in the
 * result. The turn now reads every ignored path before and after, and the receipt names each one the
 * turn created, changed or removed. Nothing ignored is ever committed.
 */

const adapters: FakeWorkerAdapter[] = [];
afterEach(() => {
  for (const adapter of adapters.splice(0)) adapter.killAll();
});
afterAll(cleanupTempDirs);

/** A worker world whose checkout ignores `build/`, with one ignored file already there before the turn. */
const ignoringWorld = (): WorkerWorld => {
  const world = seedWorkerWorld(makeCore());
  writeFileSync(join(world.repoPath, ".gitignore"), "build/\n");
  gitSync(world.repoPath, ["add", ".gitignore"]);
  gitSync(world.repoPath, ["commit", "-q", "-m", "ignore build output"]);
  // #512 S-TB: the commit is the task branch's base, as the control plane would have recorded it.
  recordSeededTarget(world);
  mkdirSync(join(world.repoPath, "build"), { recursive: true });
  writeFileSync(join(world.repoPath, "build", "untouched.txt"), "from before the turn\n");
  writeFileSync(join(world.repoPath, "build", "rewritten.txt"), "from before the turn\n");
  return world;
};

const turnOf = async (world: WorkerWorld, writes: Record<string, string>) => {
  const adapter = new FakeWorkerAdapter(world.broker);
  adapters.push(adapter);
  adapter.script = { writes };
  const runner = new WorkerTurnRunner(
    { db: world.db, clock: world.clock, audit: world.audit, tasks: world.tasks, guard: world.guard, workerAdapter: () => adapter },
    { pollMs: 10, scratchDir: (prefix) => tempDir(prefix) },
  );
  const started = await runner.start({
    runId: world.runId, taskId: world.taskId, claimId: world.claimId,
    ownerSessionId: world.cto.sessionId, ownerBindingGeneration: world.cto.generation,
  });
  if (!started.allowed) throw new Error(`start refused: ${started.reasonCode} ${started.message}`);
  await runner.settled(started.value.executionId);
  const view = runner.describe(started.value.executionId, world.runId);
  if (!view.allowed) throw new Error(view.message);
  return view.value;
};

describe("#1097 a worker change under an ignored path is reported, never dropped silently", () => {
  it("RED/GREEN: a successful turn's receipt names the ignored paths it wrote, and only those", async () => {
    const world = ignoringWorld();
    const view = await turnOf(world, {
      "src/app.js": "module.exports = () => 2;\n",
      "build/out.txt": "the worker's output under an ignored path\n",
      "build/rewritten.txt": "changed by the turn\n",
    });
    const inputs = view.success?.inputs ?? null;
    console.error(`WITNESS ignored-change-receipt ${JSON.stringify({ status: view.execution.status, inputs })}`);
    expect(view.execution.status).toBe("SUCCEEDED");
    // What was committed is unchanged: the owned, tracked change only.
    expect(inputs?.["paths"]).toEqual(["src/app.js"]);
    expect(gitSync(world.repoPath, ["show", "--name-only", "--format=", "HEAD"]).split("\n").filter(Boolean)).toEqual(["src/app.js"]);
    // What was not committed is named: the new and the rewritten ignored file, not the untouched one.
    expect(inputs?.["ignoredChanges"]).toEqual({ paths: ["build/out.txt", "build/rewritten.txt"], total: 2, error: null });
  });

  it("a failed turn's diagnostics name the ignored paths too", async () => {
    const world = ignoringWorld();
    const view = await turnOf(world, {
      "README.md": "# outside the claim\n",
      "build/out.txt": "the worker's output under an ignored path\n",
    });
    const evidence = view.diagnostics?.evidence ?? null;
    console.error(`WITNESS ignored-change-failure ${JSON.stringify({ status: view.execution.status, evidence })}`);
    expect(view.execution.status).toBe("FAILED");
    expect(evidence?.["reason"]).toBe("OUT_OF_SCOPE");
    expect(evidence?.["ignoredChanges"]).toEqual({ paths: ["build/out.txt"], total: 1, error: null });
  });

  it("control: a turn that touches no ignored path reports none", async () => {
    const world = ignoringWorld();
    const view = await turnOf(world, { "src/app.js": "module.exports = () => 2;\n" });
    expect(view.execution.status).toBe("SUCCEEDED");
    expect(view.success?.inputs?.["ignoredChanges"]).toEqual({ paths: [], total: 0, error: null });
  });
});
