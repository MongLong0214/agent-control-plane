import { chmodSync, mkdirSync, readFileSync, rmSync, rmdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { WorkerTurnRunner, type WorkerTurnOptions } from "../../src/run/worker-turn.ts";
import { plumbingWorkerCommit } from "../../src/run/worker-git.ts";
import type { ProviderAdapter } from "../../src/runtime/provider.ts";
import { cleanupTempDirs, commitAll, gitSync, makeCore, makeRepo, tempDir } from "../helpers/fixtures.ts";
import { FakeWorkerAdapter, seedWorkerWorld, type FakeTurnScript, type WorkerWorld } from "../helpers/worker-turn-fixture.ts";

/**
 * #1070 round 2 siblings — what a WORKER turn's three git passes (preparation, observation, the
 * commit's verification) do with every tracked entry type, and with the index someone else may be
 * staging into, and a turn stopped between its admission and its launch.
 *
 * - A gitlink (submodule) is admitted only when nothing is checked out at its path; a turn that puts
 *   anything there, or replaces it, fails in whichever pass sees it (ACP-WORKER-05).
 * - Symlinks, executable bits and type changes are changes like any other: committed when owned,
 *   refused when not, and refused before a turn when already present.
 * - The index's staged content is fenced, not its stat cache (ACP-WORKER-06).
 */

const adapters: FakeWorkerAdapter[] = [];
afterEach(() => {
  for (const adapter of adapters.splice(0)) adapter.killAll();
});
afterAll(cleanupTempDirs);

const CHANGE = "module.exports = () => 2;\n";

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

const head = (world: WorkerWorld): string => gitSync(world.repoPath, ["rev-parse", "HEAD"]);

/** Runs one turn; its status and failure reason, or REFUSED with the refusal's message. */
const turn = async (world: WorkerWorld, script: FakeTurnScript, options: WorkerTurnOptions = {}) => {
  const adapter = new FakeWorkerAdapter(world.broker);
  adapters.push(adapter);
  adapter.script = script;
  const runner = makeRunner(world, adapter, options);
  const started = await runner.start(request(world));
  if (!started.allowed) return { status: "REFUSED", reason: started.message, launches: adapter.launches };
  await runner.settled(started.value.executionId);
  const view = runner.describe(started.value.executionId, world.runId);
  return {
    status: world.tasks.execution(started.value.executionId)!.status,
    reason: view.allowed ? (view.value.diagnostics?.evidence["reason"] ?? null) : null,
    launches: adapter.launches,
  };
};

/** A gitlink at `vendor/dependency` with nothing checked out: the path is an empty directory. */
const withEmptyGitlink = (world: WorkerWorld): string => {
  const dependency = makeRepo({ "lib.js": "module.exports = 'dependency';\n" });
  const commit = gitSync(dependency, ["rev-parse", "HEAD"]);
  gitSync(world.repoPath, ["update-index", "--add", "--cacheinfo", `160000,${commit},vendor/dependency`]);
  gitSync(world.repoPath, ["commit", "-q", "-m", "add an unpopulated gitlink"]);
  const path = join(world.repoPath, "vendor", "dependency");
  mkdirSync(path, { recursive: true });
  return path;
};

describe("#1070 ACP-WORKER-05 a gitlink is admitted only empty, and never left otherwise", () => {
  it("an unpopulated submodule is admitted, and a turn that writes inside it fails", async () => {
    const world = seedWorkerWorld(makeCore());
    const gitlink = withEmptyGitlink(world);
    const base = head(world);
    const outcome = await turn(world, { writes: { "src/app.js": CHANGE, "vendor/dependency/lib.js": "module.exports = 'worker';\n" } });
    expect(outcome.status).toBe("FAILED");
    expect(outcome.reason).toBe("OUT_OF_SCOPE");
    expect(head(world)).toBe(base);
    expect(readFileSync(join(gitlink, "lib.js"), "utf8")).toBe("module.exports = 'worker';\n");
  });

  it("a turn that replaces a submodule's path with a file fails", async () => {
    const world = seedWorkerWorld(makeCore());
    const gitlink = withEmptyGitlink(world);
    const outcome = await turn(world, {
      writes: { "src/app.js": CHANGE },
      whileLatched: () => {
        rmdirSync(gitlink);
        writeFileSync(gitlink, "not a submodule\n");
      },
    });
    expect(outcome.status).toBe("FAILED");
    expect(outcome.reason).toBe("OUT_OF_SCOPE");
  });

  it("a turn that creates a nested repository, even in an owned path, fails", async () => {
    const world = seedWorkerWorld(makeCore());
    const outcome = await turn(world, {
      writes: { "src/app.js": CHANGE, "src/nested/lib.js": "module.exports = 'nested';\n" },
      whileLatched: () => {
        gitSync(join(world.repoPath, "src", "nested"), ["init", "-q"]);
      },
    });
    expect(outcome.status).toBe("FAILED");
    expect(outcome.reason).toBe("OUT_OF_SCOPE");
  });

  it("a checked-out submodule is refused before the turn, even when clean", async () => {
    const world = seedWorkerWorld(makeCore());
    const dependency = makeRepo({ "lib.js": "module.exports = 'dependency';\n" });
    gitSync(world.repoPath, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", dependency, "vendor/dependency"]);
    commitAll(world.repoPath, "add a submodule");
    expect(gitSync(world.repoPath, ["status", "--porcelain"])).toBe("");
    const outcome = await turn(world, { writes: { "src/app.js": CHANGE } });
    expect(outcome.status).toBe("REFUSED");
    expect(outcome.reason).toMatch(/submodule/);
    expect(outcome.launches).toBe(0);
  });

  it("the commit's verification refuses a submodule populated after it", async () => {
    const world = seedWorkerWorld(makeCore());
    const gitlink = withEmptyGitlink(world);
    const outcome = await turn(world, { writes: { "src/app.js": CHANGE } }, {
      commit: {
        commit: async (repo, input) => {
          const made = await plumbingWorkerCommit.commit(repo, input);
          writeFileSync(join(gitlink, "lib.js"), "populated after the commit\n");
          return made;
        },
      },
    });
    expect(outcome.status).toBe("FAILED");
    expect(outcome.reason).toBe("COMMIT_MISMATCH");
  });
});

describe("#1070 symlinks, executable bits and type changes are changes like any other", () => {
  it("an owned symlink is committed as a symlink", async () => {
    const world = seedWorkerWorld(makeCore());
    const outcome = await turn(world, {
      writes: { "src/app.js": CHANGE },
      whileLatched: () => symlinkSync("app.js", join(world.repoPath, "src", "link")),
    });
    expect(outcome.status).toBe("SUCCEEDED");
    expect(gitSync(world.repoPath, ["ls-tree", "HEAD", "src/link"])).toMatch(/^120000 blob /);
    expect(gitSync(world.repoPath, ["cat-file", "-p", "HEAD:src/link"])).toBe("app.js");
  });

  it("an unowned symlink retargeted during the turn fails it", async () => {
    const world = seedWorkerWorld(makeCore());
    symlinkSync("README.md", join(world.repoPath, "pointer"));
    commitAll(world.repoPath, "add a symlink outside the claim");
    const outcome = await turn(world, {
      writes: { "src/app.js": CHANGE },
      whileLatched: () => {
        rmSync(join(world.repoPath, "pointer"));
        symlinkSync("/etc/hosts", join(world.repoPath, "pointer"));
      },
    });
    expect(outcome.status).toBe("FAILED");
    expect(outcome.reason).toBe("OUT_OF_SCOPE");
  });

  it("an owned executable bit is committed, an unowned one fails the turn, and a stale one refuses it", async () => {
    const owned = seedWorkerWorld(makeCore());
    const set = await turn(owned, {
      writes: { "src/app.js": CHANGE },
      whileLatched: () => chmodSync(join(owned.repoPath, "src", "app.js"), 0o755),
    });
    expect(set.status).toBe("SUCCEEDED");
    expect(gitSync(owned.repoPath, ["ls-tree", "HEAD", "src/app.js"])).toMatch(/^100755 blob /);

    const unowned = seedWorkerWorld(makeCore());
    const outside = await turn(unowned, {
      writes: { "src/app.js": CHANGE },
      whileLatched: () => chmodSync(join(unowned.repoPath, "README.md"), 0o755),
    });
    expect(outside.status).toBe("FAILED");
    expect(outside.reason).toBe("OUT_OF_SCOPE");

    const stale = seedWorkerWorld(makeCore());
    chmodSync(join(stale.repoPath, "README.md"), 0o755);
    const refused = await turn(stale, { writes: { "src/app.js": CHANGE } });
    expect(refused.status).toBe("REFUSED");
    expect(refused.launches).toBe(0);
  });

  it("an owned file that becomes a symlink is committed as one; one that becomes a directory fails the turn", async () => {
    const linked = seedWorkerWorld(makeCore());
    const toLink = await turn(linked, {
      writes: {},
      whileLatched: () => {
        rmSync(join(linked.repoPath, "src", "app.js"));
        symlinkSync("../README.md", join(linked.repoPath, "src", "app.js"));
      },
    });
    expect(toLink.status).toBe("SUCCEEDED");
    expect(gitSync(linked.repoPath, ["ls-tree", "HEAD", "src/app.js"])).toMatch(/^120000 blob /);

    const directory = seedWorkerWorld(makeCore());
    const toDirectory = await turn(directory, {
      writes: {},
      whileLatched: () => {
        rmSync(join(directory.repoPath, "src", "app.js"));
        mkdirSync(join(directory.repoPath, "src", "app.js"));
        writeFileSync(join(directory.repoPath, "src", "app.js", "index.js"), CHANGE);
      },
    });
    expect(toDirectory.status).toBe("FAILED");
    expect(toDirectory.reason).toBe("OUT_OF_SCOPE");
  });
});

describe("#1070 ACP-WORKER-06 the index's staged content is fenced, and never overwritten", () => {
  it("a stat-cache refresh during the turn is harmless, and the commit leaves the index matching it", async () => {
    const world = seedWorkerWorld(makeCore());
    const outcome = await turn(world, {
      writes: { "src/app.js": CHANGE },
      whileLatched: () => {
        gitSync(world.repoPath, ["update-index", "-q", "--refresh"]);
        gitSync(world.repoPath, ["status", "--porcelain"]);
      },
    });
    expect(outcome).toMatchObject({ status: "SUCCEEDED", reason: null });
    expect(gitSync(world.repoPath, ["diff", "--cached", "--name-only"])).toBe("");
    expect(gitSync(world.repoPath, ["status", "--porcelain"])).toBe("");
  });

  it("a path staged by someone else during the turn fails it at observation and stays staged", async () => {
    const world = seedWorkerWorld(makeCore());
    const base = head(world);
    // The blob exists before the turn, so staging it changes the index alone, not the object store.
    const notes = join(tempDir("acp-notes-"), "NOTES.md");
    writeFileSync(notes, "someone else's work\n");
    const blob = gitSync(world.repoPath, ["hash-object", "-w", notes]);
    const outcome = await turn(world, {
      writes: { "src/app.js": CHANGE },
      whileLatched: () => {
        gitSync(world.repoPath, ["update-index", "--add", "--cacheinfo", `100644,${blob},NOTES.md`]);
      },
    });
    expect(outcome.status).toBe("FAILED");
    expect(outcome.reason).toBe("STAGED_CONTENT_CHANGED");
    expect(head(world)).toBe(base);
    expect(gitSync(world.repoPath, ["diff", "--cached", "--name-only"])).toBe("NOTES.md");
  });

  it("work staged after the turn was observed is still never erased by the commit", async () => {
    const world = seedWorkerWorld(makeCore());
    const base = head(world);
    const outcome = await turn(world, { writes: { "src/app.js": CHANGE } }, {
      commit: {
        commit: async (repo, input) => {
          // Staged between the last observation and the commit itself.
          writeFileSync(join(world.repoPath, "NOTES.md"), "someone else's work\n");
          gitSync(world.repoPath, ["add", "NOTES.md"]);
          return plumbingWorkerCommit.commit(repo, input);
        },
      },
    });
    expect(outcome.status).toBe("FAILED");
    expect(outcome.reason).toBe("COMMIT_FAILED");
    expect(head(world)).toBe(base);
    expect(gitSync(world.repoPath, ["diff", "--cached", "--name-only"])).toBe("NOTES.md");
  });
});

describe("#1070 ACP-WORKER-03 a turn stopped between its admission and its launch", () => {
  it("never runs its provider, even one that ignores the abort", async () => {
    const world = seedWorkerWorld(makeCore());
    const adapter = new FakeWorkerAdapter(world.broker);
    adapters.push(adapter);
    let launch!: () => void;
    const launchGate = new Promise<void>((resolve) => {
      launch = resolve;
    });
    adapter.script = { hold: true, ignoreAbort: true, beforeSpawn: () => launchGate };
    const runner = makeRunner(world, adapter);
    const started = await runner.start(request(world));
    if (!started.allowed) throw new Error(started.message);
    // Shutdown begins while the provider is still on its way to spawning; then it spawns. Its spawn
    // report is refused, so the adapter kills it — it never runs under a stopped daemon.
    const stopping = runner.shutdown(5_000);
    launch();
    const stopped = await stopping;
    expect(adapter.launches).toBe(1);
    expect(stopped.drained).toBe(true);
    const execution = world.tasks.execution(started.value.executionId)!;
    expect(execution.status).toBe("ABANDONED");
    expect(execution.workerProcessId).toBeNull();
    for (const child of adapter.children) {
      expect(() => process.kill(child.pid!, 0), "the provider outlived the shutdown").toThrow();
    }
  });
});
