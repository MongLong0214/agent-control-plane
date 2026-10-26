import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { ReasonCode } from "../../src/core/reason-codes.ts";
import { CLAUDE_CRON_LOCK_PATH } from "../../src/run/worker-git.ts";
import { WorkerTurnRunner } from "../../src/run/worker-turn.ts";
import { cleanupTempDirs, gitSync, makeCore, tempDir } from "../helpers/fixtures.ts";
import { FakeWorkerAdapter, seedWorkerWorld, type WorkerWorld } from "../helpers/worker-turn-fixture.ts";

/**
 * A resident CTO runs Claude Code in the registered clone, and a session-only cron makes the CLI write
 * `.claude/scheduled_tasks.lock` there. Worker turns run in the same checkout. That one file, a regular
 * file at exactly that root path, is the CLI's runtime lock and not agent configuration: a turn starts
 * beside it and never commits it. Every other `.claude` path, `.mcp.json`, and the lock path held by a
 * symlink or a directory still keep a turn from starting.
 */

const LOCK_BYTES = Buffer.from('{"sessionId":"resident-cto","pid":4242,"acquiredAt":1761460000000}\n');
const GRANT = JSON.stringify({ permissions: { allow: ["Bash"] } });

const adapters: FakeWorkerAdapter[] = [];
afterEach(() => {
  for (const adapter of adapters.splice(0)) adapter.killAll();
});
afterAll(cleanupTempDirs);

/** A world whose git ignores nothing but what `ignored` names, so no operator excludes leak in. */
const world = (options: { ignored?: string; ownedPaths?: string[] } = {}): WorkerWorld => {
  const seeded = seedWorkerWorld(makeCore(), options.ownedPaths ? { ownedPaths: options.ownedPaths } : {});
  gitSync(seeded.repoPath, ["config", "core.excludesFile", "/dev/null"]);
  if (options.ignored !== undefined) writeFileSync(join(seeded.repoPath, ".git", "info", "exclude"), `${options.ignored}\n`);
  return seeded;
};

const fakeFor = (target: WorkerWorld): FakeWorkerAdapter => {
  const adapter = new FakeWorkerAdapter(target.broker);
  adapters.push(adapter);
  return adapter;
};

const runnerFor = (target: WorkerWorld, adapter: FakeWorkerAdapter): WorkerTurnRunner =>
  new WorkerTurnRunner(
    { db: target.db, clock: target.clock, audit: target.audit, tasks: target.tasks, guard: target.guard, workerAdapter: () => adapter },
    { pollMs: 10, scratchDir: (prefix) => tempDir(prefix) },
  );

const start = (target: WorkerWorld, runner: WorkerTurnRunner) =>
  runner.start({
    runId: target.runId,
    taskId: target.taskId,
    claimId: target.claimId,
    ownerSessionId: target.cto.sessionId,
    ownerBindingGeneration: target.cto.generation,
  });

const head = (target: WorkerWorld): string => gitSync(target.repoPath, ["rev-parse", "HEAD"]);

const placeLock = (target: WorkerWorld): void => {
  mkdirSync(join(target.repoPath, ".claude"), { recursive: true });
  writeFileSync(join(target.repoPath, CLAUDE_CRON_LOCK_PATH), LOCK_BYTES);
};

const lockBytes = (target: WorkerWorld): Buffer => readFileSync(join(target.repoPath, CLAUDE_CRON_LOCK_PATH));

/** Witness A: the turn is admitted, commits only its write target, and leaves the lock exactly as it was. */
const expectAdmittedBesideTheLock = async (target: WorkerWorld): Promise<void> => {
  const adapter = fakeFor(target);
  const runner = runnerFor(target, adapter);
  const base = head(target);
  const started = await start(target, runner);
  if (!started.allowed) throw new Error(`start refused: ${started.reasonCode} ${started.message} ${JSON.stringify(started.evidence)}`);
  await runner.settled(started.value.executionId);

  expect(target.tasks.execution(started.value.executionId)!.status).toBe("SUCCEEDED");
  expect(adapter.launches).toBe(1);
  const committed = head(target);
  expect(committed).not.toBe(base);
  expect(gitSync(target.repoPath, ["rev-parse", `${committed}^`])).toBe(base);
  expect(gitSync(target.repoPath, ["diff-tree", "--no-commit-id", "--name-only", "-r", base, committed])).toBe("src/app.js");
  expect(gitSync(target.repoPath, ["ls-tree", "-r", "--name-only", committed])).not.toContain(".claude");
  expect(gitSync(target.repoPath, ["log", "--all", "--format=%H", "--", CLAUDE_CRON_LOCK_PATH])).toBe("");
  expect(gitSync(target.repoPath, ["ls-files", "--", ".claude"])).toBe("");
  expect(lockBytes(target).equals(LOCK_BYTES)).toBe(true);
};

/** Witnesses B and C: the turn does not start, nothing launches, and every file is left as it was. */
const expectRefused = async (target: WorkerWorld, named: string): Promise<void> => {
  const adapter = fakeFor(target);
  const base = head(target);
  const started = await start(target, runnerFor(target, adapter));
  expect(started.allowed).toBe(false);
  if (started.allowed) return;
  expect(started.reasonCode).toBe(ReasonCode.CONFLICT);
  expect(started.evidence["paths"]).toContain(named);
  expect(adapter.launches).toBe(0);
  expect(target.tasks.executions(target.runId)).toHaveLength(0);
  expect(head(target)).toBe(base);
};

describe("the resident CTO's Claude Code cron lock does not keep a worker turn from starting", () => {
  it("names one exact root path", () => {
    expect(CLAUDE_CRON_LOCK_PATH).toBe(".claude/scheduled_tasks.lock");
  });

  describe("A: a regular-file lock is passed over and never committed", () => {
    it("untracked and not ignored", async () => {
      const target = world();
      placeLock(target);
      expect(gitSync(target.repoPath, ["status", "--porcelain", "--untracked-files=all"])).toBe(`?? ${CLAUDE_CRON_LOCK_PATH}`);
      await expectAdmittedBesideTheLock(target);
      expect(gitSync(target.repoPath, ["status", "--porcelain", "--untracked-files=all"])).toBe(`?? ${CLAUDE_CRON_LOCK_PATH}`);
    });

    it("untracked and ignored by git", async () => {
      const target = world({ ignored: ".claude/" });
      placeLock(target);
      await expectAdmittedBesideTheLock(target);
    });

    it("even where the claim owns .claude", async () => {
      const target = world({ ownedPaths: ["src", ".claude"] });
      placeLock(target);
      await expectAdmittedBesideTheLock(target);
    });
  });

  describe("B: every other agent configuration still refuses the turn, lock or no lock", () => {
    for (const [path, ignored] of [
      [".claude/settings.local.json", undefined],
      [".claude/settings.local.json", ".claude/"],
      [".claude/settings.json", undefined],
      [".claude/commands/x.md", undefined],
      [".claude/hooks/pre.sh", ".claude/"],
      [".claude/scheduled_tasks.json", undefined],
      [".mcp.json", undefined],
      [".mcp.json", ".mcp.json"],
    ] as const) {
      it(`${path}${ignored === undefined ? "" : ` (ignored by ${ignored})`}`, async () => {
        const target = world(ignored === undefined ? {} : { ignored });
        placeLock(target);
        mkdirSync(join(target.repoPath, path, ".."), { recursive: true });
        writeFileSync(join(target.repoPath, path), GRANT);
        await expectRefused(target, path);
        expect(readFileSync(join(target.repoPath, path), "utf8")).toBe(GRANT);
        expect(lockBytes(target).equals(LOCK_BYTES)).toBe(true);
      });
    }
  });

  describe("C: the lock path held by anything but a regular file still refuses the turn", () => {
    it("a symlink at the lock path", async () => {
      const target = world();
      mkdirSync(join(target.repoPath, ".claude"), { recursive: true });
      const elsewhere = join(tempDir("acp-cron-lock-target-"), "lock");
      writeFileSync(elsewhere, LOCK_BYTES);
      symlinkSync(elsewhere, join(target.repoPath, CLAUDE_CRON_LOCK_PATH));
      await expectRefused(target, CLAUDE_CRON_LOCK_PATH);
    });

    it("a symlink at the lock path, ignored by git", async () => {
      const target = world({ ignored: ".claude/" });
      mkdirSync(join(target.repoPath, ".claude"), { recursive: true });
      symlinkSync("settings.json", join(target.repoPath, CLAUDE_CRON_LOCK_PATH));
      await expectRefused(target, CLAUDE_CRON_LOCK_PATH);
    });

    it("a directory at the lock path", async () => {
      const target = world();
      mkdirSync(join(target.repoPath, CLAUDE_CRON_LOCK_PATH), { recursive: true });
      writeFileSync(join(target.repoPath, CLAUDE_CRON_LOCK_PATH, "inner"), GRANT);
      await expectRefused(target, `${CLAUDE_CRON_LOCK_PATH}/inner`);
    });

    it("an empty directory at the lock path, which git does not list", async () => {
      const target = world();
      mkdirSync(join(target.repoPath, CLAUDE_CRON_LOCK_PATH), { recursive: true });
      await expectRefused(target, CLAUDE_CRON_LOCK_PATH);
      expect(lstatSync(join(target.repoPath, CLAUDE_CRON_LOCK_PATH)).isDirectory()).toBe(true);
    });

    it("an empty directory at the lock path, ignored by git", async () => {
      const target = world({ ignored: ".claude/" });
      mkdirSync(join(target.repoPath, CLAUDE_CRON_LOCK_PATH), { recursive: true });
      await expectRefused(target, CLAUDE_CRON_LOCK_PATH);
    });

    it("a fifo at the lock path, which git does not list", async () => {
      const target = world();
      mkdirSync(join(target.repoPath, ".claude"), { recursive: true });
      execFileSync("mkfifo", [join(target.repoPath, CLAUDE_CRON_LOCK_PATH)], { timeout: 10_000 });
      await expectRefused(target, CLAUDE_CRON_LOCK_PATH);
      expect(lstatSync(join(target.repoPath, CLAUDE_CRON_LOCK_PATH)).isFIFO()).toBe(true);
    });

    it("a .claude that is a symlink to a directory holding the lock", async () => {
      const target = world();
      const elsewhere = tempDir("acp-cron-lock-dir-");
      writeFileSync(join(elsewhere, "scheduled_tasks.lock"), LOCK_BYTES);
      symlinkSync(elsewhere, join(target.repoPath, ".claude"));
      await expectRefused(target, ".claude");
    });
  });

  describe("D: a lock the turn replaced with anything but a regular file fails the turn, uncommitted", () => {
    for (const ignored of [undefined, ".claude/"] as const) {
      it(`a regular lock swapped for an empty directory mid-turn${ignored === undefined ? "" : ` (ignored by ${ignored})`}`, async () => {
        const target = world(ignored === undefined ? {} : { ignored });
        placeLock(target);
        const adapter = fakeFor(target);
        adapter.script = {
          writes: { "src/app.js": "module.exports = () => 2;\n" },
          whileLatched: () => {
            rmSync(join(target.repoPath, CLAUDE_CRON_LOCK_PATH));
            mkdirSync(join(target.repoPath, CLAUDE_CRON_LOCK_PATH));
          },
        };
        const runner = runnerFor(target, adapter);
        const base = head(target);
        const started = await start(target, runner);
        if (!started.allowed) throw new Error(`start refused: ${started.reasonCode} ${started.message}`);
        await runner.settled(started.value.executionId);

        expect(adapter.launches).toBe(1);
        expect(target.tasks.execution(started.value.executionId)!.status).toBe("FAILED");
        const view = runner.describe(started.value.executionId, target.runId);
        if (!view.allowed) throw new Error(view.message);
        expect(view.value.success).toBeNull();
        const evidence = view.value.diagnostics!.evidence;
        expect(evidence["reason"]).toBe("OUT_OF_SCOPE");
        expect(evidence["uncovered"]).toContain(CLAUDE_CRON_LOCK_PATH);
        expect(evidence["agentConfiguration"]).toContain(CLAUDE_CRON_LOCK_PATH);
        expect(head(target)).toBe(base);
        expect(gitSync(target.repoPath, ["log", "--all", "--format=%H", "--", ".claude"])).toBe("");
        expect(lstatSync(join(target.repoPath, CLAUDE_CRON_LOCK_PATH)).isDirectory()).toBe(true);
      });
    }
  });
});
