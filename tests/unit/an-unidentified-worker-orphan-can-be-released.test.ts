import { afterAll, afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../../src/db/artifacts.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { RepairService } from "../../src/doctor/repair.ts";
import type { InvocationRequest, InvocationResult } from "../../src/runtime/provider.ts";
import { WorkerTurnEvent, WorkerTurnRunner, type WorkerTurnOptions } from "../../src/run/worker-turn.ts";
import { cleanupTempDirs, makeCore, tempDir } from "../helpers/fixtures.ts";
import { FakeWorkerAdapter, seedWorkerWorld, type WorkerWorld } from "../helpers/worker-turn-fixture.ts";

/**
 * #1096 — a worker launch the guard admitted whose pid never reached the receipt is an unidentified
 * orphan after a restart: no pid can ever be confirmed gone, so every later turn of its task was refused
 * for good. The operator's way out is an audited, allowlisted repair: once nothing of the orphan runs,
 * `release_unidentified_worker_orphan` records it resolved, and the task is admitted again.
 *
 * The repair reads the process table and signals nothing. Its "nothing runs" check is real: the fake
 * provider's child carries `--session-id <the worker session>` as the provider CLI does, and only the
 * test kills that child.
 */

/** Launches through the broker like the fake, but its spawn never reaches the receipt: no pid is recorded. */
class UnrecordedSpawnAdapter extends FakeWorkerAdapter {
  override invoke(request: InvocationRequest): Promise<InvocationResult> {
    return super.invoke({ ...request, onSpawn: undefined });
  }
}

const adapters: FakeWorkerAdapter[] = [];
afterEach(() => {
  for (const adapter of adapters.splice(0)) adapter.killAll();
});
afterAll(cleanupTempDirs);

const makeRunner = (world: WorkerWorld, adapter: FakeWorkerAdapter, options: WorkerTurnOptions = {}): WorkerTurnRunner =>
  new WorkerTurnRunner(
    { db: world.db, clock: world.clock, audit: world.audit, tasks: world.tasks, guard: world.guard, workerAdapter: () => adapter },
    // Scratch for the pinned git calls stays in this test's own temp tree, never the daemon's state root.
    { pollMs: 10, scratchDir: (prefix) => tempDir(prefix), ...options },
  );

/** Only `db`, `clock`, `audit` and `artifacts` are read by this repair; the rest are never reached. */
const repairsFor = (world: WorkerWorld): RepairService =>
  new RepairService(
    world.db, world.clock, world.audit, new ArtifactStore(world.db, world.clock),
    world.claims, {} as never, {} as never, world.guard, {} as never,
  );

const waitFor = async (condition: () => boolean, what: string, timeoutMs = 10_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe("#1096 an operator can release a task held by an unidentified worker orphan", () => {
  it("RED/GREEN: refused while blocked; refused while the orphan still runs or unconfirmed; once released, a new turn is admitted and the action is audited", async () => {
    const world = seedWorkerWorld(makeCore());
    const adapter = new UnrecordedSpawnAdapter(world.broker);
    adapters.push(adapter);
    adapter.script = { hold: true, ignoreAbort: true };
    const runner = makeRunner(world, adapter);
    const started = await runner.start({
      runId: world.runId, taskId: world.taskId, claimId: world.claimId,
      ownerSessionId: world.cto.sessionId, ownerBindingGeneration: world.cto.generation,
    });
    if (!started.allowed) throw new Error(started.message);
    const executionId = started.value.executionId;
    await waitFor(() => adapter.launches === 1, "the provider launch");
    expect(world.tasks.execution(executionId)!.workerProcessId).toBeNull();

    const restarted = makeRunner(world, adapter);
    expect(await restarted.reconcileAfterRestart()).toEqual([{ executionId, outcome: "UNIDENTIFIED" }]);
    const retry = () => restarted.start({
      runId: world.runId, taskId: world.taskId, claimId: world.claimId,
      ownerSessionId: world.cto.sessionId, ownerBindingGeneration: world.cto.generation,
    });
    const blocked = await retry();
    expect(blocked.allowed).toBe(false);
    expect(blocked.allowed ? "" : blocked.message).toMatch(/never recorded/);

    const repairs = repairsFor(world);
    const release = (parameters: Record<string, string>, dryRun = false) =>
      repairs.execute({ operationId: "release_unidentified_worker_orphan", parameters, authorizedBy: "HERMES", dryRun });

    // The orphan still runs, carrying the worker session's id: the operator's word is not enough.
    const whileRunning = await release({ executionId, confirm: "nothing-running" });
    // Nothing of it is gone yet, and the operator has not confirmed anything.
    const unconfirmed = await release({ executionId });
    const scanWhileRunning = whileRunning.allowed
      ? null
      : (whileRunning.evidence["preconditions"] as Array<{ precondition: string; satisfied: boolean }>);
    console.error(`WITNESS orphan-release-refused ${JSON.stringify({ whileRunning: whileRunning.reasonCode, scanWhileRunning, unconfirmed: unconfirmed.reasonCode })}`);
    expect(whileRunning.allowed).toBe(false);
    expect(whileRunning.reasonCode).toBe(ReasonCode.REPAIR_PRECONDITION_UNMET);
    expect(scanWhileRunning?.find((row) => row.precondition.startsWith("no live process"))?.satisfied).toBe(false);
    expect(unconfirmed.allowed).toBe(false);
    expect(unconfirmed.reasonCode).toBe(ReasonCode.REPAIR_PRECONDITION_UNMET);
    expect((await retry()).allowed).toBe(false);

    // The operator stops the orphan outside ACP (here, the test) and confirms it.
    adapter.killAll();
    await runner.settled(executionId);
    const dryRun = await release({ executionId, confirm: "nothing-running" }, true);
    expect(dryRun.allowed).toBe(true);
    expect(world.audit.byKind(WorkerTurnEvent.ORPHAN_RESOLVED)).toHaveLength(0);
    expect((await retry()).allowed).toBe(false);

    const released = await release({ executionId, confirm: "nothing-running" });
    const resolved = world.audit.byKind(WorkerTurnEvent.ORPHAN_RESOLVED);
    const executed = world.audit.byKind("REPAIR_EXECUTED").filter((row) => row.evidence["operationId"] === "release_unidentified_worker_orphan");
    console.error(`WITNESS orphan-released ${JSON.stringify({ released: released.reasonCode, resolved: resolved.map((row) => row.evidence), executed: executed.map((row) => row.evidence) })}`);
    expect(released.allowed).toBe(true);
    expect(resolved).toEqual([expect.objectContaining({ actor: "HERMES", evidence: expect.objectContaining({ executionId, taskId: world.taskId, confirmation: "nothing-running" }) })]);
    expect(executed).toHaveLength(1);
    // The orphan record stays: the resolution is recorded beside it.
    expect(world.audit.byKind(WorkerTurnEvent.ORPHAN_UNIDENTIFIED)).toHaveLength(1);

    adapter.script = { writes: { "src/app.js": "module.exports = () => 2;\n" } };
    const admitted = await retry();
    expect(admitted.allowed, admitted.allowed ? "" : `${admitted.reasonCode} ${admitted.message}`).toBe(true);
    if (admitted.allowed) await restarted.settled(admitted.value.executionId);

    // Released once; a second release has nothing to resolve.
    expect((await release({ executionId, confirm: "nothing-running" })).reasonCode).toBe(ReasonCode.REPAIR_PRECONDITION_UNMET);
  });
});
