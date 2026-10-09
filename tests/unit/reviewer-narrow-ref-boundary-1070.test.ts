import { chmodSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { afterAll, expect, it, vi } from "vitest";

import { Daemon } from "../../src/daemon/daemon.ts";
import { SingleInstanceLock } from "../../src/daemon/single-instance.ts";
import { WorkerTurnEvent, WorkerTurnRunner } from "../../src/run/worker-turn.ts";
import { cleanupTempDirs, gitSync, tempDir } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";
import { FakeWorkerAdapter, admittingCapacity, seedWorkerWorld } from "../helpers/worker-turn-fixture.ts";

const isolatedHome = vi.hoisted(() => {
  const home = `${process.env['TMPDIR']}/acp-review-narrow-home-${process.pid}`;
  process.env['HOME'] = home;
  return home;
});
afterAll(() => { cleanupTempDirs(); rmSync(isolatedHome, { recursive: true, force: true }); });

const waitFor = async (condition: () => boolean) => {
  const deadline = Date.now() + 10000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('update-ref subprocess never reached its pause');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};

it('ACP-WORKER-03: an update-ref child paused after the live fence cannot move HEAD after the daemon releases authority', async () => {
  const h = makeHarness();
  const world = seedWorkerWorld({ db: h.cp.db, clock: h.cp.clock, audit: h.cp.audit,
    sessions: h.cp.sessions, bindings: h.cp.bindings, telemetry: h.cp.telemetry });
  h.cp.tasks.attach({ capacity: admittingCapacity });
  const adapter = new FakeWorkerAdapter(world.broker);
  adapter.script = { writes: { 'src/app.js': 'module.exports = () => 2;\n' } };
  const runner = new WorkerTurnRunner({ db: world.db, clock: world.clock, audit: world.audit,
    tasks: world.tasks, guard: world.guard, workerAdapter: () => adapter },
    { pollMs: 10, scratchDir: prefix => tempDir(prefix) });
  Object.defineProperty(h.cp, 'workerTurns', { value: runner, configurable: true });
  const stateDir = tempDir('acp-ref-boundary-daemon-');
  const daemon = new Daemon(h.cp, { stateDir });
  expect(daemon.lock.acquire(h.cp.clock.nowIso()).allowed).toBe(true);
  const base = gitSync(world.repoPath, ['rev-parse', 'HEAD']);
  const bin = tempDir('acp-ref-boundary-git-');
  const reached = join(bin, 'reached');
  const release = join(bin, 'release');
  const wrapper = join(bin, 'git');
  writeFileSync(wrapper, ['#!/bin/sh',
    'case "$*" in *"update-ref -m agent-control-plane: worker commit"*)',
    `  touch '${reached}'`,
    `  while [ ! -e '${release}' ]; do /bin/sleep 0.05; done;;`,
    'esac', 'exec /usr/bin/git "$@"', ''].join('\n'));
  chmodSync(wrapper, 0o755);
  const priorPath = process.env['PATH'];
  process.env['PATH'] = `${bin}${delimiter}${priorPath}`;
  let executionId = '';
  try {
    const started = await runner.start({ runId: world.runId, taskId: world.taskId, claimId: world.claimId,
      ownerSessionId: world.cto.sessionId, ownerBindingGeneration: world.cto.generation });
    if (!started.allowed) throw new Error(started.message);
    executionId = started.value.executionId;
    await waitFor(() => existsSync(reached));
    expect(gitSync(world.repoPath, ['rev-parse', 'HEAD'])).toBe(base);
    await daemon.stop();
    expect(h.cp.audit.byKind('DAEMON_STOPPED').at(-1)!.evidence['drained']).toBe(false);
    expect(world.tasks.execution(executionId)!.status).toBe('ABANDONED');
    const successor = new SingleInstanceLock(join(stateDir, 'agentcpd.lock'));
    expect(successor.acquire(h.cp.clock.nowIso()).allowed).toBe(true);
    successor.release();
    writeFileSync(release, 'resume');
    await runner.settled(executionId);
    const actualHead = gitSync(world.repoPath, ['rev-parse', 'HEAD']);
    expect(world.audit.byKind(WorkerTurnEvent.SUCCEEDED)).toHaveLength(0);
    expect(actualHead, 'update-ref moved the branch after daemon authority was released').toBe(base);
  } finally {
    writeFileSync(release, 'cleanup');
    if (executionId) await runner.settled(executionId);
    process.env['PATH'] = priorPath;
    adapter.killAll();
  }
}, 60000);
