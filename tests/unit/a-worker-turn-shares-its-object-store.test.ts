import { execFileSync } from "node:child_process";
import { readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import type { ProviderAdapter } from "../../src/runtime/provider.ts";
import { WorkerTurnRunner } from "../../src/run/worker-turn.ts";
import { cleanupTempDirs, gitSync, makeCore, makeRepo, tempDir } from "../helpers/fixtures.ts";
import { FakeWorkerAdapter, seedWorkerWorld, type WorkerWorld } from "../helpers/worker-turn-fixture.ts";

/**
 * #1227 — a resident project's worker checkout is a linked worktree of the resident's clone, so a
 * worker turn shares that clone's object store, and every git write there (the resident's commit or
 * fetch, the control plane's own write-tree and hash-object) adds or freshens loose objects and packs
 * in the common dir. Live, a turn that made only file edits and read-only git calls was refused
 * GIT_DIR_CHANGED naming eight `objects/xx/<sha>` entries another writer had freshened that second.
 *
 * Content-addressed storage is not a worker-scope violation: loose objects (`objects/[0-9a-f]{2}/*`)
 * and `objects/pack/*` added, freshened or repacked, in the common dir or a main checkout's git dir,
 * do not refuse a turn. `objects/info/*` (alternates), refs and config written by another process
 * still do, and the refusal names those entries only, with the total.
 *
 * Each case also freshens and adds objects during the same turn, so the guarded cases tell the two
 * apart: before this change the refusal named the object store as well.
 */

const adapters: FakeWorkerAdapter[] = [];
afterEach(() => {
  for (const adapter of adapters.splice(0)) adapter.killAll();
});
afterAll(cleanupTempDirs);

const CHANGE = "module.exports = () => 2;\n";

type Layout = "linked" | "main";

/** A world whose checkout is a linked worktree of a main checkout (the resident's clone), or the main checkout itself. */
const worldIn = (layout: Layout): WorkerWorld => {
  const world = seedWorkerWorld(makeCore(), { linkedWorktree: layout === "linked" });
  gitSync(world.mainRepoPath, ["config", "core.excludesFile", "/dev/null"]);
  return world;
};

const commonDirOf = (world: WorkerWorld): string => join(world.mainRepoPath, ".git");
/** How the refusal names the directory that holds `objects/`: the common dir of a linked worktree, a main checkout's own git dir. */
const rootOf = (layout: Layout): string => (layout === "linked" ? "commonDir" : "gitDir");

/** Another writer of the object store, run in the main checkout as the resident's git would be. */
const otherGit = (world: WorkerWorld, args: readonly string[], input?: string): string =>
  execFileSync("git", ["-C", world.mainRepoPath, "-c", "gc.auto=0", ...args], {
    encoding: "utf8",
    timeout: 30_000,
    ...(input === undefined ? {} : { input }),
  });

/**
 * What another writer does to the object store in one second: every loose object freshened (git's own
 * freshen is a utime), a new loose object written, and the whole store repacked into one pack with the
 * loose copies and old packs removed (`-d`), without touching `objects/info` (`-n`).
 */
const storeWrites = (world: WorkerWorld): void => {
  const objects = join(commonDirOf(world), "objects");
  const later = Math.floor(Date.now() / 1000) + 5;
  for (const fanout of readdirSync(objects).filter((name) => /^[0-9a-f]{2}$/.test(name))) {
    for (const object of readdirSync(join(objects, fanout))) utimesSync(join(objects, fanout, object), later, later);
  }
  otherGit(world, ["hash-object", "-w", "--stdin"], `written by another process at ${Date.now()}\n`);
  otherGit(world, ["repack", "-q", "-a", "-d", "-n"]);
  otherGit(world, ["hash-object", "-w", "--stdin"], `and one more loose object at ${Date.now()}\n`);
};

/** One turn on the fake provider, which writes the owned file and then runs `whileLatched`. */
const turn = async (world: WorkerWorld, whileLatched: () => void) => {
  const adapter = new FakeWorkerAdapter(world.broker);
  adapters.push(adapter);
  adapter.script = { writes: { "src/app.js": CHANGE }, whileLatched };
  const runner = new WorkerTurnRunner(
    { db: world.db, clock: world.clock, audit: world.audit, tasks: world.tasks, guard: world.guard, workerAdapter: () => adapter as ProviderAdapter },
    { pollMs: 10, scratchDir: (prefix) => tempDir(prefix) },
  );
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
  const view = runner.describe(started.value.executionId, world.runId);
  const diagnostics = view.allowed ? (view.value.diagnostics?.evidence ?? {}) : {};
  return {
    status: world.tasks.execution(started.value.executionId)!.status,
    reason: diagnostics["reason"] ?? null,
    changes: (diagnostics["gitDirChanges"] ?? []) as Array<Record<string, string>>,
    count: diagnostics["gitDirChangeCount"],
  };
};

const inObjectStore = (path: string): boolean => /^objects\/(?:[0-9a-f]{2}|pack)(?:\/|$)/.test(path) || path === "objects";

describe("#1227 (a) another process adds, freshens and repacks objects during the turn", () => {
  for (const layout of ["linked", "main"] as const) {
    it(`does not refuse the turn (${layout} checkout): content-addressed storage is not the worker's scope`, async () => {
      const world = worldIn(layout);
      const base = gitSync(world.repoPath, ["rev-parse", "HEAD"]);
      const outcome = await turn(world, () => storeWrites(world));
      expect(outcome, JSON.stringify(outcome.changes.slice(0, 5))).toMatchObject({ status: "SUCCEEDED", reason: null });
      const head = gitSync(world.repoPath, ["rev-parse", "HEAD"]);
      expect(gitSync(world.repoPath, ["rev-parse", `${head}^`])).toBe(base);
      expect(gitSync(world.repoPath, ["show", `${head}:src/app.js`])).toBe(CHANGE.trim());
      // The store really was repacked under the turn: one pack holds it.
      expect(readdirSync(join(commonDirOf(world), "objects", "pack")).filter((name) => name.endsWith(".pack"))).toHaveLength(1);
    });
  }
});

describe("#1227 (b) objects/info/alternates written during the turn", () => {
  for (const layout of ["linked", "main"] as const) {
    it(`is still refused GIT_DIR_CHANGED (${layout} checkout), naming objects/info and nothing of the object store`, async () => {
      const world = worldIn(layout);
      const elsewhere = join(makeRepo(), ".git", "objects");
      const outcome = await turn(world, () => {
        storeWrites(world);
        writeFileSync(join(commonDirOf(world), "objects", "info", "alternates"), `${elsewhere}\n`);
      });
      expect({ status: outcome.status, reason: outcome.reason }).toEqual({ status: "FAILED", reason: "GIT_DIR_CHANGED" });
      expect(outcome.changes).toEqual([
        { change: "changed", root: rootOf(layout), path: "objects/info", kind: "directory" },
        { change: "added", root: rootOf(layout), path: "objects/info/alternates", kind: "file" },
      ]);
      expect(outcome.count).toBe(2);
    });
  }
});

describe("#1227 (c) a ref or config written by another process during the turn", () => {
  const cases: Array<[string, (world: WorkerWorld) => void, Record<string, string>]> = [
    ["a ref", (world) => otherGit(world, ["update-ref", "refs/heads/stray", "HEAD"]), { change: "added", path: "refs/heads/stray", kind: "file" }],
    ["config", (world) => otherGit(world, ["config", "--local", "acp.stray", "1"]), { change: "changed", path: "config", kind: "file" }],
  ];
  for (const layout of ["linked", "main"] as const) {
    for (const [name, write, named] of cases) {
      it(`${name} is still refused GIT_DIR_CHANGED (${layout} checkout), naming it and nothing of the object store`, async () => {
        const world = worldIn(layout);
        const outcome = await turn(world, () => {
          storeWrites(world);
          write(world);
        });
        expect({ status: outcome.status, reason: outcome.reason }).toEqual({ status: "FAILED", reason: "GIT_DIR_CHANGED" });
        expect(outcome.changes).toEqual(expect.arrayContaining([{ ...named, root: rootOf(layout) }]));
        expect(outcome.changes.filter((change) => inObjectStore(change["path"]!))).toEqual([]);
        expect(outcome.count).toBe(outcome.changes.length);
      });
    }
  }
});
