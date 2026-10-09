import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { WorkerTurnRunner } from "../../src/run/worker-turn.ts";
import type { ProviderAdapter } from "../../src/runtime/provider.ts";
import { cleanupTempDirs, gitSync, makeCore, tempDir } from "../helpers/fixtures.ts";
import { FakeWorkerAdapter, seedWorkerWorld, type FakeTurnScript, type WorkerWorld } from "../helpers/worker-turn-fixture.ts";

/**
 * #1070 ACP-WORKER-01 — no git call the control plane makes around a WORKER turn runs code the
 * repository's configuration or the worker selects: not a clean filter, not fsmonitor, not a hook,
 * not an external diff or textconv driver. Configuration the worker changes refuses the turn;
 * configuration the owner set before it is simply never exercised, because every call is plumbing
 * with filters, hooks and fsmonitor off. Each witness checks a marker outside every worktree.
 */

const adapters: FakeWorkerAdapter[] = [];
afterEach(() => {
  for (const adapter of adapters.splice(0)) adapter.killAll();
});
afterAll(cleanupTempDirs);

const CHANGE = "module.exports = () => 2;\n";

interface Rig {
  world: WorkerWorld;
  marker: string;
  /** An executable that leaves the marker, then copies stdin (or its first argument) to stdout. */
  script: string;
}

const rig = (options: Parameters<typeof seedWorkerWorld>[1] = {}): Rig => {
  const world = seedWorkerWorld(makeCore(), options);
  const dir = tempDir("acp-git-code-");
  const marker = join(dir, "ran");
  const script = join(dir, "marker.sh");
  writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\nif [ -n "$1" ] && [ -f "$1" ]; then cat "$1"; else cat; fi\n`);
  chmodSync(script, 0o755);
  return { world, marker, script };
};

const turn = async (world: WorkerWorld, script: FakeTurnScript) => {
  const adapter = new FakeWorkerAdapter(world.broker);
  adapters.push(adapter);
  adapter.script = script;
  const runner = new WorkerTurnRunner(
    { db: world.db, clock: world.clock, audit: world.audit, tasks: world.tasks, guard: world.guard, workerAdapter: () => adapter as ProviderAdapter },
    { pollMs: 10, scratchDir: (prefix) => tempDir(prefix) },
  );
  const started = await runner.start({
    runId: world.runId, taskId: world.taskId, claimId: world.claimId,
    ownerSessionId: world.cto.sessionId, ownerBindingGeneration: world.cto.generation,
  });
  if (!started.allowed) throw new Error(`${started.reasonCode}: ${started.message}`);
  await runner.settled(started.value.executionId);
  const view = runner.describe(started.value.executionId, world.runId);
  return {
    status: world.tasks.execution(started.value.executionId)!.status,
    reason: view.allowed ? (view.value.diagnostics?.evidence["reason"] ?? null) : null,
  };
};

describe("#1070 ACP-WORKER-01 the control plane's git runs no repository-selected code", () => {
  it("a .gitattributes the worker writes cannot select the owner's clean filter; the commit holds the raw bytes", async () => {
    const { world, marker, script } = rig();
    gitSync(world.repoPath, ["config", "filter.evil.clean", script]);
    const outcome = await turn(world, { writes: { "src/app.js": CHANGE, "src/.gitattributes": "* filter=evil\n" } });
    expect(existsSync(marker), "a clean filter ran").toBe(false);
    expect(outcome.status).toBe("SUCCEEDED");
    expect(gitSync(world.repoPath, ["cat-file", "-p", "HEAD:src/app.js"])).toBe(CHANGE.trimEnd());
  });

  it("a filter the worker writes into .git/config refuses the turn without running", async () => {
    const { world, marker, script } = rig();
    const config = join(world.repoPath, ".git", "config");
    const outcome = await turn(world, {
      writes: { "src/app.js": CHANGE, "src/.gitattributes": "* filter=evil\n" },
      whileLatched: () => writeFileSync(config, `${readFileSync(config, "utf8")}[filter "evil"]\n\tclean = ${script}\n`),
    });
    expect(existsSync(marker), "a clean filter ran").toBe(false);
    expect(outcome.status).toBe("FAILED");
    expect(outcome.reason).toBe("GIT_DIR_CHANGED");
  });

  it("the owner's core.fsmonitor never runs, and one the worker sets refuses the turn", async () => {
    const owned = rig();
    gitSync(owned.world.repoPath, ["config", "core.fsmonitor", owned.script]);
    const outcome = await turn(owned.world, { writes: { "src/app.js": CHANGE } });
    expect(existsSync(owned.marker), "fsmonitor ran").toBe(false);
    expect(outcome.status).toBe("SUCCEEDED");

    const set = rig();
    const config = join(set.world.repoPath, ".git", "config");
    const refused = await turn(set.world, {
      writes: { "src/app.js": CHANGE },
      whileLatched: () => writeFileSync(config, `${readFileSync(config, "utf8")}[core]\n\tfsmonitor = ${set.script}\n`),
    });
    expect(existsSync(set.marker), "fsmonitor ran").toBe(false);
    expect(refused.status).toBe("FAILED");
  });

  it("the owner's hooks never run around the commit, and a hook the worker writes refuses the turn", async () => {
    const owned = rig();
    const hooks = join(owned.world.repoPath, ".git", "hooks");
    mkdirSync(hooks, { recursive: true });
    for (const hook of ["reference-transaction", "post-index-change", "post-commit", "pre-commit", "post-checkout"]) {
      writeFileSync(join(hooks, hook), `#!/bin/sh\ntouch '${owned.marker}'\n`);
      chmodSync(join(hooks, hook), 0o755);
    }
    const outcome = await turn(owned.world, { writes: { "src/app.js": CHANGE } });
    expect(existsSync(owned.marker), "a hook ran").toBe(false);
    expect(outcome.status).toBe("SUCCEEDED");

    const written = rig();
    const writtenHook = join(written.world.repoPath, ".git", "hooks", "reference-transaction");
    const refused = await turn(written.world, {
      writes: { "src/app.js": CHANGE },
      whileLatched: () => {
        mkdirSync(join(written.world.repoPath, ".git", "hooks"), { recursive: true });
        writeFileSync(writtenHook, `#!/bin/sh\ntouch '${written.marker}'\n`);
        chmodSync(writtenHook, 0o755);
      },
    });
    expect(existsSync(written.marker), "a hook ran").toBe(false);
    expect(refused.status).toBe("FAILED");
    expect(refused.reason).toBe("GIT_DIR_CHANGED");
  });

  it("the owner's diff.external and textconv drivers never run", async () => {
    const { world, marker, script } = rig();
    gitSync(world.repoPath, ["config", "diff.external", script]);
    gitSync(world.repoPath, ["config", "diff.evil.textconv", script]);
    const outcome = await turn(world, { writes: { "src/app.js": CHANGE, "src/.gitattributes": "* diff=evil\n" } });
    expect(existsSync(marker), "a diff driver ran").toBe(false);
    expect(outcome.status).toBe("SUCCEEDED");
  });

  it("a main checkout whose .git directory the worker swaps for a .git file refuses the turn", async () => {
    const { world, marker, script } = rig();
    gitSync(world.repoPath, ["config", "filter.evil.clean", script]);
    const outcome = await turn(world, {
      writes: { "src/app.js": CHANGE },
      whileLatched: () => {
        renameSync(join(world.repoPath, ".git"), join(world.repoPath, ".git-moved"));
        writeFileSync(join(world.repoPath, ".git"), "gitdir: .git-moved\n");
        writeFileSync(join(world.repoPath, ".git-moved", "info", "attributes"), "* filter=evil\n");
      },
    });
    expect(existsSync(marker), "git followed the swapped .git").toBe(false);
    expect(outcome.status).toBe("FAILED");
    expect(outcome.reason).toBe("GIT_INDIRECTION_CHANGED");
  });
});
