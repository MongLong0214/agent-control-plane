import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { OwnerAuthority, type OwnerApprovalReceipt } from "../../src/ceo/owner-authority.ts";
import { digestOf } from "../../src/core/digest.ts";
import { ArtifactStore } from "../../src/db/artifacts.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { REPAIR_OWNER_APPROVAL_OPERATION, RepairService } from "../../src/doctor/repair.ts";
import { IngressGuard, ownerApprovalPayload } from "../../src/ingress/ingress-guard.ts";
import type { InvocationRequest, InvocationResult } from "../../src/runtime/provider.ts";
import { WorkerTurnEvent, WorkerTurnRunner, type WorkerTurnOptions } from "../../src/run/worker-turn.ts";
import { cleanupTempDirs, makeCore, tempDir } from "../helpers/fixtures.ts";
import { FakeWorkerAdapter, seedWorkerWorld, type WorkerWorld } from "../helpers/worker-turn-fixture.ts";

/**
 * #1096 — a worker launch the guard admitted whose pid never reached the receipt is an unidentified
 * orphan after a restart: no pid can ever be confirmed gone, so every later turn of its task was refused
 * for good. The operator's way out is an audited, allowlisted repair: once nothing of the orphan runs,
 * `release_unidentified_worker_orphan` records that one orphan event resolved, and the task is admitted
 * again. It is owner-authorised: the operator's receipt is admitted through ingress for exactly this
 * orphan event, and the task's reader traces the resolution to that admission, so a resolution row the
 * repair did not write — or wrote under a receipt for something else — releases nothing.
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

/** The operator, as the daemon's CLI ingress admits one. */
const OPERATOR = { channel: "cli", actor: "acp-test-operator" } as const;

/** Only `db`, `clock`, `audit` and `artifacts` are read by this repair; the rest are never reached. */
const repairsFor = (world: WorkerWorld): RepairService => {
  const repairs = new RepairService(
    world.db, world.clock, world.audit, new ArtifactStore(world.db, world.clock),
    world.claims, {} as never, {} as never, world.guard, {} as never,
  );
  repairs.attach({ ownerAuthority: new OwnerAuthority(world.db, [OPERATOR], world.clock) });
  return repairs;
};

/** The operator's receipt for one repair request, admitted through ingress as `agentctl repair --owner` is. */
const operatorReceipt = (world: WorkerWorld, parameters: Record<string, string>, dryRun: boolean): OwnerApprovalReceipt => {
  const guard = new IngressGuard(world.db, world.clock, world.audit, { cli: { allowedActors: [OPERATOR.actor] } });
  const approval = {
    runId: null,
    candidateSnapshotDigest: null,
    operation: REPAIR_OWNER_APPROVAL_OPERATION,
    parameters: { operationId: "release_unidentified_worker_orphan", parameters, dryRun },
    idempotencyKey: `repair:${randomUUID()}`,
    approved: true,
  };
  const admitted = guard.admitOwnerApproval(
    { channel: OPERATOR.channel, actor: OPERATOR.actor, nonce: `repair:${digestOf(approval)}`, payload: ownerApprovalPayload(approval) },
    approval,
  );
  if (!admitted.allowed) throw new Error(admitted.message);
  return admitted.value;
};

/** A resolution row the repair never wrote, naming the admitted receipt `receipt` for `orphanEventId`. */
const appendResolution = (world: WorkerWorld, executionId: string, orphanEventId: number, receipt: OwnerApprovalReceipt): void => {
  const recorded = world.audit.record({
    kind: WorkerTurnEvent.ORPHAN_RESOLVED,
    runId: world.runId,
    actor: `${receipt.channel}:${receipt.actor}`,
    evidence: {
      executionId, taskId: world.taskId, orphanEventId, operationId: "release_unidentified_worker_orphan",
      ownerApproval: { channel: receipt.channel, actor: receipt.actor, nonce: receipt.inboundNonce, receiptDigest: digestOf(receipt) },
    },
  });
  if (!recorded.allowed) throw new Error(recorded.message);
};

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
    // The refusal names the orphan event the operator's release has to name.
    const orphanEventId = blocked.allowed ? null : blocked.evidence["orphanEventId"];
    expect(orphanEventId).toEqual(world.audit.byKind(WorkerTurnEvent.ORPHAN_UNIDENTIFIED)[0]!.eventId);
    if (typeof orphanEventId !== "number") throw new Error("the refusal named no orphan event");

    const repairs = repairsFor(world);
    const exact = { executionId, orphanEventId: String(orphanEventId), confirm: "nothing-running" };
    const release = (parameters: Record<string, string>, dryRun = false) =>
      repairs.execute({
        operationId: "release_unidentified_worker_orphan", parameters, authorizedBy: "OWNER", dryRun,
        ownerApproval: operatorReceipt(world, parameters, dryRun),
      });

    // Hermes alone cannot release it: the repair is the operator's, under an admitted receipt.
    const hermes = await repairs.execute({ operationId: "release_unidentified_worker_orphan", parameters: exact, authorizedBy: "HERMES", dryRun: false });
    expect(hermes.reasonCode).toBe(ReasonCode.REPAIR_REQUIRES_OWNER);

    // The orphan still runs, carrying the worker session's id: the operator's word is not enough.
    const whileRunningReceipt = operatorReceipt(world, exact, false);
    const whileRunning = await repairs.execute({
      operationId: "release_unidentified_worker_orphan", parameters: exact, authorizedBy: "OWNER", dryRun: false, ownerApproval: whileRunningReceipt,
    });
    // Nothing of it is gone yet, and the operator has not confirmed anything; nor may the release name
    // any orphan event but this one.
    const unconfirmed = await release({ executionId, orphanEventId: String(orphanEventId) });
    const otherEvent = await release({ ...exact, orphanEventId: String(orphanEventId + 1000) });
    const scanWhileRunning = whileRunning.allowed
      ? null
      : (whileRunning.evidence["preconditions"] as Array<{ precondition: string; satisfied: boolean }>);
    console.error(`WITNESS orphan-release-refused ${JSON.stringify({ hermes: hermes.reasonCode, whileRunning: whileRunning.reasonCode, scanWhileRunning, unconfirmed: unconfirmed.reasonCode, otherEvent: otherEvent.reasonCode })}`);
    expect(whileRunning.allowed).toBe(false);
    expect(whileRunning.reasonCode).toBe(ReasonCode.REPAIR_PRECONDITION_UNMET);
    expect(scanWhileRunning?.find((row) => row.precondition.startsWith("no live process"))?.satisfied).toBe(false);
    expect(unconfirmed.allowed).toBe(false);
    expect(unconfirmed.reasonCode).toBe(ReasonCode.REPAIR_PRECONDITION_UNMET);
    expect(otherEvent.allowed).toBe(false);
    expect(otherEvent.reasonCode).toBe(ReasonCode.REPAIR_PRECONDITION_UNMET);
    expect((await retry()).allowed).toBe(false);

    // The operator stops the orphan outside ACP (here, the test) and confirms it.
    adapter.killAll();
    await runner.settled(executionId);
    // A resolution row the repair never wrote releases nothing, even naming the exact orphan event and a
    // receipt the operator really had admitted for it: that one a repair refused, and never consumed.
    appendResolution(world, executionId, orphanEventId, whileRunningReceipt);
    expect((await retry()).allowed).toBe(false);

    const dryRunReceipt = operatorReceipt(world, exact, true);
    const dryRun = await repairs.execute({
      operationId: "release_unidentified_worker_orphan", parameters: exact, authorizedBy: "OWNER", dryRun: true, ownerApproval: dryRunReceipt,
    });
    expect(dryRun.allowed).toBe(true);
    expect(world.audit.byKind(WorkerTurnEvent.ORPHAN_RESOLVED)).toHaveLength(1);
    expect((await retry()).allowed).toBe(false);
    // Nor does one naming the receipt a dry run consumed: it approved a dry run, not this release.
    appendResolution(world, executionId, orphanEventId, dryRunReceipt);
    expect((await retry()).allowed).toBe(false);

    const released = await release(exact);
    const resolved = world.audit.byKind(WorkerTurnEvent.ORPHAN_RESOLVED);
    const executed = world.audit.byKind("REPAIR_EXECUTED").filter((row) => row.evidence["operationId"] === "release_unidentified_worker_orphan");
    console.error(`WITNESS orphan-released ${JSON.stringify({ released: released.reasonCode, resolved: resolved.map((row) => row.evidence), executed: executed.map((row) => row.evidence) })}`);
    expect(released.allowed).toBe(true);
    expect(resolved).toHaveLength(3);
    expect(resolved[2]).toEqual(expect.objectContaining({
      actor: `${OPERATOR.channel}:${OPERATOR.actor}`,
      evidence: expect.objectContaining({
        executionId, taskId: world.taskId, orphanEventId, confirmation: "nothing-running",
        ownerApproval: expect.objectContaining({ channel: OPERATOR.channel, actor: OPERATOR.actor }),
      }),
    }));
    // Only the release executed: the dry run is recorded as one, and a refused attempt is not a repair.
    expect(executed).toHaveLength(1);
    // The orphan record stays: the resolution is recorded beside it.
    expect(world.audit.byKind(WorkerTurnEvent.ORPHAN_UNIDENTIFIED)).toHaveLength(1);

    adapter.script = { writes: { "src/app.js": "module.exports = () => 2;\n" } };
    const admitted = await retry();
    expect(admitted.allowed, admitted.allowed ? "" : `${admitted.reasonCode} ${admitted.message}`).toBe(true);
    if (admitted.allowed) await restarted.settled(admitted.value.executionId);

    // Released once; a second release has nothing to resolve.
    expect((await release(exact)).reasonCode).toBe(ReasonCode.REPAIR_PRECONDITION_UNMET);
  });
});
