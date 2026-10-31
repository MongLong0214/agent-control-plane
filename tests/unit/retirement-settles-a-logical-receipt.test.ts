import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ExecutionMode, Role, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { retireProject } from "../../src/registry/project-retirement.ts";
import type { TaskContract } from "../../src/run/run-engine.ts";
import {
  TASK_WORKER_GIT_GROUP_ENDED,
  TASK_WORKER_GIT_GROUP_STARTED,
  TASK_WORKER_GIT_INTENT,
  TASK_WORKER_LAUNCH_ENDED,
  TASK_WORKER_LAUNCH_INTENT,
} from "../../src/run/worker-turn.ts";
import { cleanupTempDirs, makeRepo } from "../helpers/fixtures.ts";
import { bindCeo, fixtureManifest, type Harness, makeHarness, registerFixtureProject } from "../helpers/harness.ts";

/**
 * A project's retirement waits for its worker processes to settle, and only records may say a worker's
 * process ended. Two halves:
 *
 * - A receipt the CTO opened through task_receipt_submit for a worker the control plane never ran
 *   (the E2E-07B' counterexample) keeps holding retirement. It is kept here as evidence: retirement
 *   stays fail-closed for it (CEO msg_a678bbf6).
 * - A runtime-managed receipt with no recorded pid and no guard grant counted as ended even with a
 *   launch intent or a git child of its task that has no recorded end. It now holds retirement until
 *   those ends are on record; with them, retirement proceeds as before.
 *
 * Every refusal is the existing one; no receipt row is written by retirement.
 */

const CONTRACT: TaskContract = {
  goal: "retire a project whose CTO left a receipt behind",
  why: "retirement waits for whatever a receipt's records leave running",
  scope: ["src/app.js"],
  nonGoals: [],
  acceptance: ["retirement proceeds only when the records show its workers ended"],
  priority: "NORMAL",
  humanGate: [],
  references: [],
};

const children: ChildProcess[] = [];
const liveProcess = (): ChildProcess => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  children.push(child);
  return child;
};
const kill = async (child: ChildProcess): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
};

afterEach(async () => {
  vi.restoreAllMocks();
  for (const child of children.splice(0)) await kill(child);
});
afterAll(cleanupTempDirs);

interface Receipt {
  projectId: string;
  runId: string;
  taskId: string;
  executionId: string;
  workerSessionId: string;
}

/** A project on the harness's fixture checkout, or on a checkout of its own when it is a second project. */
const registerProject = async (harness: Harness, projectId: string, ownCheckout: boolean): Promise<{ repositoryId: string }> => {
  if (!ownCheckout) return registerFixtureProject(harness, projectId);
  const identity = `github:acme/${projectId}`;
  const manifest = fixtureManifest(projectId, { repositories: [{ role: "primary", remote: identity, manifestRoot: "." }] });
  const project = harness.cp.projects.register({ projectId, name: projectId, manifest, authorization: harness.cp.manifestAuthorizationForTests(manifest) });
  if (!project.allowed) throw new Error(`project registration failed: ${project.message}`);
  const repository = await harness.cp.repositories.register({
    checkoutPath: makeRepo({ "README.md": `# ${projectId}\n` }),
    projectId,
    repositoryRole: "primary",
    activeManifestDigest: project.value.activeManifestDigest,
    identity,
  });
  if (!repository.allowed) throw new Error(`repository registration failed: ${repository.message}`);
  return { repositoryId: repository.value.repositoryId };
};

/**
 * A dispatched run of a fresh project with one task, its WORKER bound to a session created as a test
 * worker (no provider process unless `sessionPid` names one), and a worker receipt opened through
 * task_receipt_submit's writer.
 */
const openReceipt = async (
  harness: Harness,
  projectId: string,
  receipt: { runtimeManaged?: boolean; workerProcessId?: number; sessionPid?: number; ownCheckout?: boolean } = {},
): Promise<Receipt> => {
  const { repositoryId } = await registerProject(harness, projectId, receipt.ownCheckout === true);
  if (!harness.cp.bindings.active(roleKeyFor(Role.CEO))) bindCeo(harness);
  const created = harness.cp.runs.create({
    projectId,
    executionMode: ExecutionMode.STANDARD,
    contract: CONTRACT,
    repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
  });
  if (!created.allowed) throw new Error(created.message);
  const runId = created.value.runId;
  const dispatched = await harness.cp.runs.dispatch(runId);
  if (!dispatched.allowed) throw new Error(`${dispatched.reasonCode}: ${dispatched.message}`);
  const submitted = harness.cp.tasks.submit(runId, [{ key: "impl", title: "task impl", category: "implementation" }]);
  if (!submitted.allowed) throw new Error(submitted.message);
  const taskId = harness.cp.tasks.ready(runId)[0]!.taskId;
  const session = harness.cp.sessions.create({
    provider: "scripted",
    model: "scripted-worker",
    ...(receipt.sessionPid === undefined ? {} : { osPid: receipt.sessionPid }),
  });
  expect(harness.cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "test worker").allowed).toBe(true);
  expect(harness.cp.bindings.bind({ role: Role.WORKER, sessionId: session.sessionId, taskId }).allowed).toBe(true);
  vi.spyOn(harness.cp.tasks, "admitWorkerFanout").mockResolvedValue(allow(ReasonCode.OK, undefined));
  const execution = await harness.cp.tasks.startWorkerExecution({
    runId,
    taskId,
    ownerBindingGeneration: dispatched.value.ownerBindingGeneration!,
    workerSessionId: session.sessionId,
    provider: "scripted",
    model: "scripted-worker",
    repositoryId,
    ...(receipt.runtimeManaged === undefined ? {} : { runtimeManaged: receipt.runtimeManaged }),
    ...(receipt.workerProcessId === undefined ? {} : { workerProcessId: receipt.workerProcessId }),
  });
  if (!execution.allowed) throw new Error(`${execution.reasonCode}: ${execution.message}`);
  return { projectId, runId, taskId, executionId: execution.value.executionId, workerSessionId: session.sessionId };
};

/** The receipt's run ends: the cancel closes the receipt ABANDONED and retires its WORKER. */
const cancelled = async (harness: Harness, receipt: Receipt): Promise<void> => {
  expect(harness.cp.runs.cancel(receipt.runId, "the CTO's run is withdrawn").allowed).toBe(true);
  await harness.cp.workerRetirement.settled();
  expect(harness.cp.tasks.execution(receipt.executionId)).toMatchObject({ status: "ABANDONED", workerProcessId: null });
};

/** The receipt row exactly as stored. */
const receiptRow = (harness: Harness, executionId: string): unknown =>
  harness.cp.db.get(`SELECT * FROM task_executions WHERE execution_id = ?`, [executionId]);

/** Retirement with the host step answered; nothing else is stubbed. */
const retire = async (harness: Harness, projectId: string) => {
  vi.spyOn(harness.cp.residentProjects, "retire").mockResolvedValue(undefined as never);
  return retireProject(harness.cp, projectId, "the owner retires the project");
};

const retirementRows = (harness: Harness, projectId: string): string[] =>
  harness.cp.db.all<{ kind: string }>(
    `SELECT kind FROM audit_events WHERE project_id = ? AND kind LIKE 'PROJECT_RETIRE%' ORDER BY event_id`,
    [projectId],
  ).map((row) => row.kind);

/** The existing refusal, with the existing required order, and nothing retired. */
const expectHeld = (harness: Harness, projectId: string, retired: Awaited<ReturnType<typeof retire>>): void => {
  expect(retired, JSON.stringify(retired)).toMatchObject({
    allowed: false,
    reasonCode: ReasonCode.CONFLICT,
    message: "retirement waits for worker processes to settle; it stopped before the host step",
    evidence: {
      projectId,
      requiredOrder: ["let the project's worker processes stop", `run agentctl project retire ${projectId} again`],
    },
  });
  expect(harness.cp.projects.get(projectId)?.retiredAt ?? null).toBeNull();
  expect(retirementRows(harness, projectId)).not.toContain("PROJECT_RETIRED");
};

describe("a receipt the CTO opened, and the other receipts retirement reads", () => {
  it("(1) a CTO-opened receipt that never had a process, ABANDONED with no pid, still holds retirement (kept as evidence)", async () => {
    // The E2E-07B' counterexample: runtime_managed = 0, no worker_process_id, its session created with no
    // os_pid, and no launch, turn, git or guard record for it. Settling it was tried and not adopted: by
    // records it is indistinguishable from wr-r1-04 (a-worker-retires-with-its-run.test.ts), where a
    // worker the CTO launched outside the control plane is still running and the receipt named no pid.
    // That process is in no record, so any rule that settles this receipt also stops wr-r1-04's session
    // while its worker runs. Retirement stays fail-closed (CEO msg_a678bbf6): the existing refusal, and
    // the receipt and its session as they were.
    const h = makeHarness();
    const receipt = await openReceipt(h, "logical-receipt");
    await cancelled(h, receipt);
    const before = receiptRow(h, receipt.executionId);
    expect(before).toMatchObject({ status: "ABANDONED", runtime_managed: 0, worker_process_id: null, worker_process_released_at: null });

    expectHeld(h, receipt.projectId, await retire(h, receipt.projectId));
    expect(receiptRow(h, receipt.executionId)).toEqual(before);
    expect(h.cp.sessions.get(receipt.workerSessionId)?.lifecycle).toBe(SessionLifecycle.READY);
  });

  it("(2a) a live worker: a receipt whose recorded process still runs holds retirement", async () => {
    const h = makeHarness();
    const worker = liveProcess();
    const receipt = await openReceipt(h, "live-worker", { workerProcessId: worker.pid! });
    expect(h.cp.runs.cancel(receipt.runId, "the CTO's run is withdrawn").allowed).toBe(true);
    await h.cp.workerRetirement.settled();
    const before = receiptRow(h, receipt.executionId);

    expectHeld(h, receipt.projectId, await retire(h, receipt.projectId));
    expect(receiptRow(h, receipt.executionId)).toEqual(before);
    expect(h.cp.sessions.get(receipt.workerSessionId)?.lifecycle).toBe(SessionLifecycle.READY);
    expect(worker.exitCode).toBeNull();
    expect(worker.signalCode).toBeNull();
  });

  it("(2b) a runtime-managed worker that cannot be identified: ABANDONED with no pid, its launch on record and admitted, holds retirement", async () => {
    const h = makeHarness();
    const receipt = await openReceipt(h, "unidentified-worker", { runtimeManaged: true });
    expect(h.cp.audit.record({ kind: TASK_WORKER_LAUNCH_INTENT, runId: receipt.runId, sessionId: receipt.workerSessionId, evidence: { executionId: receipt.executionId, taskId: receipt.taskId } }).allowed).toBe(true);
    expect(h.cp.audit.record({ kind: "MANAGED_WRITE_GUARD", runId: receipt.runId, evidence: { taskReceiptId: receipt.executionId, operation: "FILE_MUTATION", allowed: true } }).allowed).toBe(true);
    await cancelled(h, receipt);
    const before = receiptRow(h, receipt.executionId);

    expectHeld(h, receipt.projectId, await retire(h, receipt.projectId));
    expect(receiptRow(h, receipt.executionId)).toEqual(before);
    expect(h.cp.sessions.get(receipt.workerSessionId)?.lifecycle).toBe(SessionLifecycle.READY);
  });

  it("(2b) a CTO-opened receipt whose worker session recorded its own process holds retirement", async () => {
    const h = makeHarness();
    const session = liveProcess();
    const receipt = await openReceipt(h, "session-process", { sessionPid: session.pid! });
    await cancelled(h, receipt);
    const before = receiptRow(h, receipt.executionId);

    expectHeld(h, receipt.projectId, await retire(h, receipt.projectId));
    expect(receiptRow(h, receipt.executionId)).toEqual(before);
    expect(session.exitCode).toBeNull();
  });

  it("(2c) another project's receipt neither holds this project's retirement nor is settled by it", async () => {
    const h = makeHarness();
    const other = await openReceipt(h, "other-project", { runtimeManaged: true });
    expect(h.cp.audit.record({ kind: TASK_WORKER_LAUNCH_INTENT, runId: other.runId, sessionId: other.workerSessionId, evidence: { executionId: other.executionId, taskId: other.taskId } }).allowed).toBe(true);
    expect(h.cp.audit.record({ kind: "MANAGED_WRITE_GUARD", runId: other.runId, evidence: { taskReceiptId: other.executionId, operation: "FILE_MUTATION", allowed: true } }).allowed).toBe(true);
    await cancelled(h, other);
    // The retiring project's own receipt reports its worker's end, so nothing of its own holds it.
    const target = await openReceipt(h, "retiring-project", { ownCheckout: true });
    expect(h.cp.tasks.finishExecution(target.executionId, { status: "FAILED", failureClass: "repairable" }, target.runId).allowed).toBe(true);
    expect(h.cp.runs.cancel(target.runId, "the CTO's run is withdrawn").allowed).toBe(true);
    await h.cp.workerRetirement.settled();
    const otherBefore = receiptRow(h, other.executionId);
    const otherProject = h.cp.projects.get(other.projectId);

    const retired = await retire(h, target.projectId);

    expect(retired, JSON.stringify(retired)).toMatchObject({ allowed: true, value: { projectId: target.projectId } });
    expect(receiptRow(h, other.executionId)).toEqual(otherBefore);
    expect(h.cp.sessions.get(other.workerSessionId)?.lifecycle).toBe(SessionLifecycle.READY);
    expect(h.cp.projects.get(other.projectId)).toEqual(otherProject);
    expect(retirementRows(h, other.projectId)).toEqual([]);
  });

  it("(2d) a CTO-opened receipt with a launch intent and no recorded end holds retirement", async () => {
    const h = makeHarness();
    const receipt = await openReceipt(h, "unended-launch");
    expect(h.cp.audit.record({ kind: TASK_WORKER_LAUNCH_INTENT, runId: receipt.runId, sessionId: receipt.workerSessionId, evidence: { executionId: receipt.executionId, taskId: receipt.taskId } }).allowed).toBe(true);
    await cancelled(h, receipt);
    const before = receiptRow(h, receipt.executionId);

    expectHeld(h, receipt.projectId, await retire(h, receipt.projectId));
    expect(receiptRow(h, receipt.executionId)).toEqual(before);
  });

  it("(2d) a CTO-opened receipt whose task has a git group with no confirmed end holds retirement", async () => {
    const h = makeHarness();
    const receipt = await openReceipt(h, "unended-git-group");
    expect(h.cp.audit.record({
      kind: TASK_WORKER_GIT_GROUP_STARTED,
      runId: receipt.runId,
      sessionId: receipt.workerSessionId,
      evidence: { nonce: "git-nonce-1", pgid: 999_999, leaderStartedAt: null, worktreeId: "wt", worktreePathKind: "CANONICAL_V1", taskId: receipt.taskId },
    }).allowed).toBe(true);
    await cancelled(h, receipt);
    const before = receiptRow(h, receipt.executionId);

    expectHeld(h, receipt.projectId, await retire(h, receipt.projectId));
    expect(receiptRow(h, receipt.executionId)).toEqual(before);
  });
});

/** A runtime-managed receipt with no recorded pid and no guard grant, its run cancelled after `records` are written. */
const unadmittedRuntimeReceipt = async (harness: Harness, projectId: string, records: (receipt: Receipt) => void): Promise<Receipt> => {
  const receipt = await openReceipt(harness, projectId, { runtimeManaged: true });
  records(receipt);
  await cancelled(harness, receipt);
  expect(harness.cp.db.get(`SELECT 1 AS n FROM audit_events WHERE kind = 'MANAGED_WRITE_GUARD' AND json_extract(evidence_json, '$.taskReceiptId') = ?`, [receipt.executionId])).toBeUndefined();
  return receipt;
};

const launch = (harness: Harness, receipt: Receipt, kind: string): void => {
  expect(harness.cp.audit.record({ kind, runId: receipt.runId, sessionId: receipt.workerSessionId, evidence: { executionId: receipt.executionId, taskId: receipt.taskId } }).allowed).toBe(true);
};

const git = (harness: Harness, receipt: Receipt, kind: string, evidence: Record<string, unknown>): void => {
  expect(harness.cp.audit.record({
    kind,
    runId: receipt.runId,
    sessionId: receipt.workerSessionId,
    evidence: { ...evidence, worktreeId: "wt", worktreePathKind: "CANONICAL_V1", taskId: receipt.taskId },
  }).allowed).toBe(true);
};

describe("a runtime-managed receipt with no pid is ended only by its records", () => {
  it("(3a) its launch intent has no recorded end: retirement is held", async () => {
    const h = makeHarness();
    const receipt = await unadmittedRuntimeReceipt(h, "rm-unended-launch", (r) => launch(h, r, TASK_WORKER_LAUNCH_INTENT));
    const before = receiptRow(h, receipt.executionId);

    expectHeld(h, receipt.projectId, await retire(h, receipt.projectId));
    expect(receiptRow(h, receipt.executionId)).toEqual(before);
    expect(h.cp.sessions.get(receipt.workerSessionId)?.lifecycle).toBe(SessionLifecycle.READY);
  });

  it("(3b) a git group of its task has no recorded end: retirement is held", async () => {
    const h = makeHarness();
    const receipt = await unadmittedRuntimeReceipt(h, "rm-unended-git-group", (r) => {
      git(h, r, TASK_WORKER_GIT_INTENT, { nonce: "n1" });
      git(h, r, TASK_WORKER_GIT_GROUP_STARTED, { nonce: "n1", pgid: 999_999, leaderStartedAt: null });
    });
    const before = receiptRow(h, receipt.executionId);

    expectHeld(h, receipt.projectId, await retire(h, receipt.projectId));
    expect(receiptRow(h, receipt.executionId)).toEqual(before);
  });

  it("(3b) a git group ends only by its own end: a gate's end of its nonce with no pgid does not end it", async () => {
    const h = makeHarness();
    const receipt = await unadmittedRuntimeReceipt(h, "rm-git-group-gate-end", (r) => {
      git(h, r, TASK_WORKER_GIT_INTENT, { nonce: "n1" });
      git(h, r, TASK_WORKER_GIT_GROUP_STARTED, { nonce: "n1", pgid: 999_999, leaderStartedAt: null });
      git(h, r, TASK_WORKER_GIT_GROUP_ENDED, { nonce: "n1", pgid: null, proven: "GATE_GONE" });
    });

    expectHeld(h, receipt.projectId, await retire(h, receipt.projectId));
  });

  it("(3c) a git intent of its task with no group and no end: retirement is held", async () => {
    const h = makeHarness();
    const receipt = await unadmittedRuntimeReceipt(h, "rm-unended-git-intent", (r) => git(h, r, TASK_WORKER_GIT_INTENT, { nonce: "n1" }));

    expectHeld(h, receipt.projectId, await retire(h, receipt.projectId));
  });

  it("(4a) positive control: its launch intent has its recorded end, so retirement proceeds and the receipt row is unchanged", async () => {
    const h = makeHarness();
    const receipt = await unadmittedRuntimeReceipt(h, "rm-ended-launch", (r) => {
      launch(h, r, TASK_WORKER_LAUNCH_INTENT);
      launch(h, r, TASK_WORKER_LAUNCH_ENDED);
    });
    const before = receiptRow(h, receipt.executionId);

    const retired = await retire(h, receipt.projectId);

    expect(retired, JSON.stringify(retired)).toMatchObject({ allowed: true, reasonCode: ReasonCode.OK, value: { projectId: receipt.projectId } });
    expect(retirementRows(h, receipt.projectId)).toEqual(["PROJECT_RETIREMENT_INTENT", "PROJECT_RETIREMENT_INTENT", "PROJECT_RETIRED"]);
    expect(receiptRow(h, receipt.executionId)).toEqual(before);
  });

  it("(4b) positive control: its task's git group has its recorded end, so retirement proceeds and the receipt row is unchanged", async () => {
    const h = makeHarness();
    const receipt = await unadmittedRuntimeReceipt(h, "rm-ended-git-group", (r) => {
      git(h, r, TASK_WORKER_GIT_INTENT, { nonce: "n1" });
      git(h, r, TASK_WORKER_GIT_GROUP_STARTED, { nonce: "n1", pgid: 999_999, leaderStartedAt: null });
      git(h, r, TASK_WORKER_GIT_GROUP_ENDED, { nonce: "n1", pgid: 999_999, proven: "GROUP_GONE" });
    });
    const before = receiptRow(h, receipt.executionId);

    const retired = await retire(h, receipt.projectId);

    expect(retired, JSON.stringify(retired)).toMatchObject({ allowed: true, reasonCode: ReasonCode.OK, value: { projectId: receipt.projectId } });
    expect(receiptRow(h, receipt.executionId)).toEqual(before);
  });
});
