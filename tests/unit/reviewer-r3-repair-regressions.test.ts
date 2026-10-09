import { chmodSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { Daemon } from "../../src/daemon/daemon.ts";
import { SingleInstanceLock } from "../../src/daemon/single-instance.ts";
import { WorkerTurnEvent, WorkerTurnRunner, type WorkerTurnOptions } from "../../src/run/worker-turn.ts";
import type { ProviderAdapter } from "../../src/runtime/provider.ts";
import { cleanupTempDirs, gitSync, makeCore, tempDir } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";
import { FakeWorkerAdapter, admittingCapacity, seedWorkerWorld, type WorkerWorld } from "../helpers/worker-turn-fixture.ts";

/**
 * #1070 round 3 — the reviewer's two reproductions against 597da060, recreated from the review's
 * descriptions (its clone is gone). Each is RED on 597da060 and GREEN after the repair.
 *
 * - ACP-WORKER-03: a turn paused after its provider exited resumes after the daemon's real 15 s
 *   shutdown has timed out and released the daemon lock. It must commit nothing and never succeed.
 * - ACP-WORKER-06: a different blob is staged for an owned path between preparation's cleanliness
 *   check and its staged baseline. The commit must never overwrite it.
 *
 * The daemon's own runner allocates scratch under HOME, so HOME is a private directory for this file.
 */
const isolatedHome = vi.hoisted(() => {
  const home = `${(process.env["TMPDIR"] ?? "/tmp").replace(/\/+$/, "")}/acp-reviewer-r3-home-${process.pid}`;
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

const CHANGE = "module.exports = () => 2;\n";

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

const waitFor = async (condition: () => boolean, what: string, timeoutMs = 10_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

/** The git the tests' PATH resolves, found without running anything. */
const realGit = (): string => {
  for (const dir of (process.env["PATH"] ?? "").split(delimiter)) {
    if (dir && existsSync(join(dir, "git"))) return join(dir, "git");
  }
  throw new Error("no git on PATH");
};

describe("#1070 round 3 reviewer reproductions", () => {
  it("ACP-WORKER-03: a turn resumed after the daemon's shutdown timed out and released its lock commits nothing and never succeeds", async () => {
    const h = makeHarness();
    const world = seedWorkerWorld({
      db: h.cp.db, clock: h.cp.clock, audit: h.cp.audit, sessions: h.cp.sessions, bindings: h.cp.bindings, telemetry: h.cp.telemetry,
    });
    h.cp.tasks.attach({ capacity: admittingCapacity });
    const adapter = fakeFor(world);
    adapter.script = { writes: { "src/app.js": CHANGE } };
    let paused = false;
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    // Paused after the provider exited and its change was observed, before the commit.
    const runner = makeRunner(world, adapter, {
      beforeCommit: async () => {
        paused = true;
        await gate;
      },
    });
    // The daemon drains the runner it owns.
    Object.defineProperty(h.cp, "workerTurns", { value: runner, configurable: true });
    const stateDir = tempDir("acp-daemon-r3-");
    const daemon = new Daemon(h.cp, { stateDir });
    expect(daemon.lock.acquire(h.cp.clock.nowIso()).allowed).toBe(true);
    const base = gitSync(world.repoPath, ["rev-parse", "HEAD"]);

    const started = await runner.start(request(world));
    if (!started.allowed) throw new Error(started.message);
    const executionId = started.value.executionId;
    await waitFor(() => paused, "the turn to pause before its commit");

    // The real shutdown: its 15 s drain times out on the paused turn, and the daemon releases its lock.
    await daemon.stop();
    const stopped = h.cp.audit.byKind("DAEMON_STOPPED").at(-1)!.evidence;
    expect(stopped["drained"]).toBe(false);
    const successor = new SingleInstanceLock(join(stateDir, "agentcpd.lock"));
    expect(successor.acquire(h.cp.clock.nowIso()).allowed, "the daemon lock is free").toBe(true);
    successor.release();

    resume();
    await runner.settled(executionId);
    expect(world.tasks.execution(executionId)!.status, "a turn succeeded after the daemon released its authority").not.toBe("SUCCEEDED");
    expect(gitSync(world.repoPath, ["rev-parse", "HEAD"]), "a turn committed after the daemon released its authority").toBe(base);
    expect(world.audit.byKind(WorkerTurnEvent.SUCCEEDED)).toHaveLength(0);
  }, 60_000);

  it("ACP-WORKER-06: a blob staged between preparation's cleanliness check and its baseline is never overwritten", async () => {
    const world = seedWorkerWorld(makeCore());
    const staged = join(tempDir("acp-staged-"), "app.js");
    writeFileSync(staged, "module.exports = () => 'staged by someone else';\n");
    const blob = gitSync(world.repoPath, ["hash-object", "-w", staged]);
    const base = gitSync(world.repoPath, ["rev-parse", "HEAD"]);

    // A git on PATH that, the first time the runner reads the effective configuration — which
    // preparation does after its cleanliness check and before its staged baseline — stages that blob
    // for the owned src/app.js in the real index, then runs the real git.
    const bin = tempDir("acp-git-wrapper-");
    const marker = join(bin, "staged");
    const wrapper = join(bin, "git");
    writeFileSync(wrapper, [
      "#!/bin/sh",
      `case "$*" in *"config --list --show-origin"*)`,
      `  if [ ! -e '${marker}' ]; then`,
      `    touch '${marker}'`,
      `    '${realGit()}' update-index --cacheinfo '100644,${blob},src/app.js'`,
      "  fi;;",
      "esac",
      `exec '${realGit()}' "$@"`,
      "",
    ].join("\n"));
    chmodSync(wrapper, 0o755);

    const adapter = fakeFor(world);
    adapter.script = { writes: { "src/app.js": CHANGE } };
    const runner = makeRunner(world, adapter);
    const path = process.env["PATH"];
    process.env["PATH"] = `${bin}${delimiter}${path ?? ""}`;
    let status: string;
    try {
      const started = await runner.start(request(world));
      if (started.allowed) {
        await runner.settled(started.value.executionId);
        status = world.tasks.execution(started.value.executionId)!.status;
      } else {
        status = "REFUSED";
      }
    } finally {
      process.env["PATH"] = path;
    }
    expect(existsSync(marker), "the race was not exercised").toBe(true);
    expect(gitSync(world.repoPath, ["ls-files", "-s", "src/app.js"]), "the staged blob was overwritten").toContain(blob);
    expect(status, "a turn that raced staged work succeeded").not.toBe("SUCCEEDED");
    expect(gitSync(world.repoPath, ["rev-parse", "HEAD"])).toBe(base);
  });
});
