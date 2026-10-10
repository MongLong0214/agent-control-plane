import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";

import { afterAll, describe, expect, it, vi } from "vitest";

import { sha256 } from "../../src/core/digest.ts";
import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Daemon } from "../../src/daemon/daemon.ts";
import {
  ExecutionMode,
  Role,
  RunState,
  SessionLifecycle,
  TaskState,
  roleKeyFor,
} from "../../src/domain/types.ts";
import type { TaskContract } from "../../src/run/run-engine.ts";
import { WorkerStaffing } from "../../src/run/worker-staffing.ts";
import type { SessionHandle } from "../../src/runtime/provider.ts";
import { FakeGitHub } from "../helpers/fake-github.ts";
import { cleanupTempDirs, commitAll, tempDir, writeFiles } from "../helpers/fixtures.ts";
import {
  applyPassingChange,
  bindCeo,
  bindWorker,
  driveToReviewedCandidate,
  makeHarness,
  registerFixtureProject,
  type Harness,
} from "../helpers/harness.ts";
import { TestProductionAdapter } from "../helpers/production-adapter.ts";

afterAll(cleanupTempDirs);

/**
 * #512 follow-through — a WORKER binding ends with its run.
 *
 * Before this, nothing revoked a WORKER assignment: a run went CANCELLED, COMPLETED or FAILED and its
 * worker stayed ACTIVE, holding the role and reporting a live session for work that was over. The
 * terminal transition now revokes every WORKER of the run in the same transaction and has the
 * worker's session stopped after commit, and the daemon's reconcile pass retires any it finds whose
 * run already ended. A live run's workers, and every other role, are not touched.
 */

const CONTRACT: TaskContract = {
  goal: "retire the workers of an ended run",
  why: "an ended run's WORKER binding is an orphan",
  scope: ["src/app.js"],
  nonGoals: [],
  acceptance: ["no ACTIVE WORKER binding outlives its run"],
  priority: "NORMAL",
  humanGate: [],
  references: [],
};

/** A Claude worker runtime double that records which provider sessions it was asked to stop. */
class ClaudeWorkerDouble extends TestProductionAdapter {
  readonly stopped: string[] = [];

  constructor(clock: Harness["clock"]) {
    super(clock, "claude");
  }

  override async stopSession(handle?: SessionHandle): Promise<void> {
    if (handle) this.stopped.push(handle.externalSessionId);
    return super.stopSession(handle);
  }
}

/** The fixture deployment with the trusted gate credential a daemon start requires. */
const gatedHarness = (): Harness => {
  const harness = makeHarness();
  harness.cp.credentials.install({ token: "test-token", creatorIdentity: "acp-trusted-app" });
  return harness;
};

interface ActiveRun {
  projectId: string;
  repositoryId: string;
  runId: string;
  ownerSessionId: string;
  ownerBindingGeneration: number;
  taskIds: string[];
}

/** A dispatched, ACTIVE run with READY tasks; the project is registered unless one is passed. */
const activeRun = async (
  harness: Harness,
  keys: readonly string[] = ["impl"],
  project?: { projectId: string; repositoryId: string },
): Promise<ActiveRun> => {
  const { projectId, repositoryId } = project ?? await registerFixtureProject(harness);
  if (!harness.cp.bindings.active(roleKeyFor(Role.CEO))) bindCeo(harness);
  const created = harness.cp.runs.create({
    projectId,
    executionMode: ExecutionMode.STANDARD,
    contract: CONTRACT,
    repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
  });
  if (!created.allowed) throw new Error(created.message);
  const dispatched = await harness.cp.runs.dispatch(created.value.runId);
  if (!dispatched.allowed) throw new Error(`${dispatched.reasonCode}: ${dispatched.message}`);
  const submitted = harness.cp.tasks.submit(
    created.value.runId,
    keys.map((key) => ({ key, title: `task ${key}`, category: "implementation" })),
  );
  if (!submitted.allowed) throw new Error(submitted.message);
  return {
    projectId,
    repositoryId,
    runId: created.value.runId,
    ownerSessionId: dispatched.value.ownerSessionId!,
    ownerBindingGeneration: dispatched.value.ownerBindingGeneration!,
    taskIds: harness.cp.tasks.ready(created.value.runId).map((task) => task.taskId),
  };
};

/**
 * The production staffing path (`WorkerStaffing`), on a Claude double registered for the WORKER role.
 * Only the capacity admission and the doctor's readiness are stubbed; `beforeBind` runs inside the
 * readiness await, the last await before the bind transaction.
 */
const staffing = (
  harness: Harness,
  claude: ClaudeWorkerDouble,
  beforeBind: () => void = () => undefined,
): WorkerStaffing =>
  new WorkerStaffing(harness.cp.db, harness.clock, harness.cp.audit, {
    runs: harness.cp.runs,
    tasks: {
      get: (taskId) => harness.cp.tasks.get(taskId),
      admitWorkerFanout: async () => allow(ReasonCode.OK, undefined),
    },
    bindings: harness.cp.bindings,
    sessions: harness.cp.sessions,
    providers: { requireForRole: () => claude },
    readiness: {
      checkSession: async () => {
        beforeBind();
        return allow(ReasonCode.OK, undefined);
      },
    },
  }, tempDir("acp-worker-retire-runtime-"));

const provisionRequest = (run: ActiveRun, taskId: string) => ({
  runId: run.runId,
  taskId,
  provider: "claude",
  ownerBindingGeneration: run.ownerBindingGeneration,
  fence: () => allow(ReasonCode.OK, { sessionId: run.ownerSessionId, bindingGeneration: run.ownerBindingGeneration }),
});

interface AssignmentRow {
  assignment_id: string;
  role: string;
  status: string;
  session_id: string;
  binding_generation: number;
  revoked_at: string | null;
  revoked_reason: string | null;
}

const workerAssignment = (harness: Harness, taskId: string): AssignmentRow | undefined =>
  harness.cp.db.get<AssignmentRow>(
    `SELECT assignment_id, role, status, session_id, binding_generation, revoked_at, revoked_reason
       FROM assignments WHERE role_key = ? ORDER BY binding_generation DESC LIMIT 1`,
    [roleKeyFor(Role.WORKER, { taskId })],
  );

const nonWorkerAssignments = (harness: Harness): AssignmentRow[] =>
  harness.cp.db.all<AssignmentRow>(
    `SELECT assignment_id, role, status, session_id, binding_generation, revoked_at, revoked_reason
       FROM assignments WHERE role <> 'WORKER' ORDER BY assignment_id`,
  );

const lifecycleOf = (harness: Harness, sessionId: string): string | undefined =>
  harness.cp.sessions.get(sessionId)?.lifecycle;

const retiredFor = (harness: Harness, runId: string) =>
  harness.cp.audit.forRun(runId).filter((entry) => entry.kind === "WORKER_RETIRED");

const runDaemonOnce = async (harness: Harness, prefix: string): Promise<void> => {
  const daemon = new Daemon(harness.cp, { stateDir: tempDir(prefix) });
  const started = await daemon.start();
  if (!started.allowed) throw new Error(`${started.reasonCode}: ${started.message} ${JSON.stringify(started.evidence)}`);
  await daemon.stop();
};

describe("a run that reaches a terminal state retires its WORKER bindings", () => {
  it("CANCELLED: the provisioned WORKER is revoked with its reason, and its session stops", async () => {
    const harness = gatedHarness();
    const run = await activeRun(harness);
    const claude = new ClaudeWorkerDouble(harness.clock);
    harness.cp.providers.registerForRole(claude, Role.WORKER);
    const provisioned = await staffing(harness, claude).provision(provisionRequest(run, run.taskIds[0]!));
    if (!provisioned.allowed) throw new Error(`${provisioned.reasonCode}: ${provisioned.message}`);
    const workerSessionId = provisioned.value.workerSessionId;
    expect(workerAssignment(harness, run.taskIds[0]!)?.status).toBe("ACTIVE");

    expect(harness.cp.runs.cancel(run.runId, "owner cancelled the run").allowed).toBe(true);

    // Authority ends in the transaction that ended the run.
    const assignment = workerAssignment(harness, run.taskIds[0]!)!;
    expect(assignment.status).toBe("REVOKED");
    expect(assignment.revoked_reason).toMatch(/run ended CANCELLED/);
    expect(assignment.revoked_at).not.toBeNull();
    expect(harness.cp.bindings.active(roleKeyFor(Role.WORKER, { taskId: run.taskIds[0]! }))).toBeNull();
    const retired = retiredFor(harness, run.runId);
    expect(retired).toHaveLength(1);
    expect(retired[0]).toMatchObject({
      sessionId: workerSessionId,
      evidence: { trigger: "terminal-transition", to: RunState.CANCELLED },
    });

    // The session is stopped through the provider after commit, and is no longer live.
    await harness.cp.workerRetirement.settled();
    expect(lifecycleOf(harness, workerSessionId)).toBe(SessionLifecycle.STOPPED);
    expect(harness.cp.sessions.live().map((session) => session.sessionId)).not.toContain(workerSessionId);
    const incarnation = harness.cp.sessions.get(workerSessionId)!.incarnation;
    expect(claude.stopped).toContain(incarnation.split("#")[0]);
  });

  it("FAILED: the WORKER is revoked with its reason, and its session stops", async () => {
    const harness = gatedHarness();
    const run = await activeRun(harness);
    const workerSessionId = bindWorker(harness, run.taskIds[0]!);

    expect(harness.cp.runs.transition(run.runId, RunState.FAILED, "the run failed").allowed).toBe(true);

    const assignment = workerAssignment(harness, run.taskIds[0]!)!;
    expect(assignment.status).toBe("REVOKED");
    expect(assignment.revoked_reason).toMatch(/run ended FAILED/);
    expect(retiredFor(harness, run.runId)).toHaveLength(1);
    await harness.cp.workerRetirement.settled();
    expect(lifecycleOf(harness, workerSessionId)).toBe(SessionLifecycle.STOPPED);
  });

  it("COMPLETED through the daemon finalizer: the WORKER is revoked with its reason, and its session stops", async () => {
    const { harness, driven } = await readyForCeo();
    const task = harness.cp.tasks.list(driven.runId)[0]!;
    const before = workerAssignment(harness, task.taskId)!;
    expect(before.status).toBe("ACTIVE");
    const ceo = harness.cp.bindings.active(roleKeyFor(Role.CEO))!;
    const confirmed = harness.cp.ceo.submitCeoDecision({
      runId: driven.runId,
      decision: "CONFIRM",
      candidateSnapshotDigest: driven.candidateSnapshotDigest,
      ceoSessionId: ceo.sessionId,
      rationale: "worker retirement witness",
    });
    if (!confirmed.allowed) throw new Error(`${confirmed.reasonCode}: ${confirmed.message}`);

    await runDaemonOnce(harness, "acp-worker-retire-complete-");
    expect(harness.cp.runs.require(driven.runId).state).toBe(RunState.COMPLETED);

    const assignment = workerAssignment(harness, task.taskId)!;
    expect(assignment.status).toBe("REVOKED");
    expect(assignment.revoked_reason).toMatch(/run ended COMPLETED/);
    expect(retiredFor(harness, driven.runId)).toHaveLength(1);
    await harness.cp.workerRetirement.settled();
    expect(lifecycleOf(harness, before.session_id)).toBe(SessionLifecycle.STOPPED);
  });
});

describe("the reconcile pass retires a WORKER whose run already ended", () => {
  it("revokes an ACTIVE WORKER of an already-CANCELLED run at daemon start, and a second pass is a no-op", async () => {
    const harness = gatedHarness();
    const run = await activeRun(harness);
    const workerSessionId = bindWorker(harness, run.taskIds[0]!);
    // The state a run that ended before retirement existed left behind: its terminal transition
    // retired nothing, so its WORKER is still ACTIVE on a CANCELLED run.
    harness.cp.runs.attach({ workerRetirement: { retireRun: () => [] } });
    expect(harness.cp.runs.cancel(run.runId, "owner cancelled the run").allowed).toBe(true);
    harness.cp.runs.attach({ workerRetirement: harness.cp.workerRetirement });
    expect(workerAssignment(harness, run.taskIds[0]!)?.status).toBe("ACTIVE");

    await runDaemonOnce(harness, "acp-worker-retire-reconcile-1-");

    const first = workerAssignment(harness, run.taskIds[0]!)!;
    expect(first.status).toBe("REVOKED");
    expect(first.revoked_reason).toMatch(/run ended CANCELLED/);
    expect(retiredFor(harness, run.runId)).toHaveLength(1);
    expect(retiredFor(harness, run.runId)[0]).toMatchObject({ evidence: { trigger: "reconcile" } });
    expect(lifecycleOf(harness, workerSessionId)).toBe(SessionLifecycle.STOPPED);
    const lifecycleEvents = harness.cp.audit.byKind("SESSION_LIFECYCLE")
      .filter((entry) => entry.sessionId === workerSessionId).length;

    await runDaemonOnce(harness, "acp-worker-retire-reconcile-2-");
    const report = await harness.cp.workerRetirement.reconcile();

    expect([report.revoked, report.stopped, report.remaining, report.stopFailed]).toEqual([[], [], [], []]);
    expect(workerAssignment(harness, run.taskIds[0]!)).toEqual(first);
    expect(retiredFor(harness, run.runId)).toHaveLength(1);
    expect(harness.cp.audit.byKind("SESSION_LIFECYCLE")
      .filter((entry) => entry.sessionId === workerSessionId)).toHaveLength(lifecycleEvents);
  });
});

describe("a late provisioning cannot leave a WORKER on an ended run", () => {
  it("a provisioning the cancel overtakes before its bind binds nothing and stops the session it started", async () => {
    const harness = gatedHarness();
    const run = await activeRun(harness);
    const claude = new ClaudeWorkerDouble(harness.clock);
    harness.cp.providers.registerForRole(claude, Role.WORKER);
    let cancelled = false;
    const provisioned = await staffing(harness, claude, () => {
      cancelled = harness.cp.runs.cancel(run.runId, "cancelled while a worker was provisioned").allowed;
    }).provision(provisionRequest(run, run.taskIds[0]!));

    expect(cancelled).toBe(true);
    expect(provisioned.allowed).toBe(false);
    expect(provisioned.reasonCode).toBe(ReasonCode.RUN_TRANSITION_ILLEGAL);
    const roleKey = roleKeyFor(Role.WORKER, { taskId: run.taskIds[0]! });
    expect(harness.cp.bindings.active(roleKey)).toBeNull();
    expect(harness.cp.bindings.history(roleKey)).toEqual([]);
    expect(claude.stopped).toHaveLength(1);
    const started = harness.cp.db.all<{ session_id: string; lifecycle: string }>(
      `SELECT session_id, lifecycle FROM sessions WHERE provider = 'claude'`,
    );
    expect(started).toEqual([{ session_id: expect.stringMatching(/^ses_wkr_/), lifecycle: SessionLifecycle.STOPPED }]);
  });
});

describe("what retirement leaves alone", () => {
  it("a live run's WORKER whose task SUCCEEDED stays ACTIVE when another run ends, and CEO and PRIMARY_CTO are untouched", async () => {
    const harness = gatedHarness();
    const live = await activeRun(harness, ["impl"]);
    const liveWorker = bindWorker(harness, live.taskIds[0]!);
    const execution = harness.cp.tasks.startExecution({
      runId: live.runId,
      taskId: live.taskIds[0]!,
      ownerBindingGeneration: live.ownerBindingGeneration,
      workerSessionId: liveWorker,
      provider: "scripted",
      model: "scripted-worker",
      repositoryId: live.repositoryId,
    });
    if (!execution.allowed) throw new Error(execution.message);
    const head = applyPassingChange(harness.repoPath, "feature/F1-live");
    expect(harness.cp.tasks.finishExecution(execution.value.executionId, {
      status: "SUCCEEDED",
      resultDigest: `sha256:${head}`,
    }).allowed).toBe(true);
    expect(harness.cp.tasks.get(live.taskIds[0]!)?.state).toBe(TaskState.SUCCEEDED);

    const ended = await activeRun(harness, ["other"], live);
    const endedWorker = bindWorker(harness, ended.taskIds[0]!);
    const othersBefore = nonWorkerAssignments(harness);
    expect(othersBefore.map((row) => row.role).sort()).toEqual([Role.CEO, Role.PRIMARY_CTO]);

    expect(harness.cp.runs.cancel(ended.runId, "owner cancelled one run").allowed).toBe(true);
    await harness.cp.workerRetirement.settled();
    await runDaemonOnce(harness, "acp-worker-retire-controls-");

    expect(workerAssignment(harness, ended.taskIds[0]!)?.status).toBe("REVOKED");
    expect(lifecycleOf(harness, endedWorker)).toBe(SessionLifecycle.STOPPED);

    expect(harness.cp.runs.require(live.runId).state).toBe(RunState.ACTIVE);
    expect(workerAssignment(harness, live.taskIds[0]!)).toMatchObject({ status: "ACTIVE", revoked_reason: null });
    expect(lifecycleOf(harness, liveWorker)).toBe(SessionLifecycle.READY);

    expect(nonWorkerAssignments(harness)).toEqual(othersBefore);
    for (const row of othersBefore) expect(lifecycleOf(harness, row.session_id)).toBe(SessionLifecycle.READY);
  });

  it("a recorded worker process still running: the binding is revoked, the session is not marked gone, and the process is recorded as remaining", async () => {
    const harness = gatedHarness();
    const run = await activeRun(harness);
    const workerSessionId = bindWorker(harness, run.taskIds[0]!);
    // A worker the CTO launched and receipted itself: its own process group, still running.
    const worker: ChildProcess = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore",
    });
    try {
      const pid = worker.pid!;
      const execution = harness.cp.tasks.startExecution({
        runId: run.runId,
        taskId: run.taskIds[0]!,
        ownerBindingGeneration: run.ownerBindingGeneration,
        workerSessionId,
        workerProcessId: pid,
        provider: "scripted",
        model: "scripted-worker",
        repositoryId: run.repositoryId,
      });
      if (!execution.allowed) throw new Error(execution.message);

      expect(harness.cp.runs.cancel(run.runId, "owner cancelled the run").allowed).toBe(true);
      expect(workerAssignment(harness, run.taskIds[0]!)?.status).toBe("REVOKED");
      await harness.cp.workerRetirement.settled();

      expect(lifecycleOf(harness, workerSessionId)).toBe(SessionLifecycle.READY);
      const remaining = harness.cp.audit.byKind("WORKER_PROCESS_REMAINING")
        .filter((entry) => entry.sessionId === workerSessionId);
      expect(remaining).toHaveLength(1);
      expect(remaining[0]!.evidence).toMatchObject({
        executions: [{ executionId: execution.value.executionId, pid, status: "PROCESS_RUNNING" }],
      });
      // The live process was neither signalled nor recorded released.
      expect(worker.exitCode).toBeNull();
      expect(worker.signalCode).toBeNull();
      expect(harness.cp.tasks.execution(execution.value.executionId)).toMatchObject({ workerProcessId: pid });

      // Once the process is gone, the next reconcile pass stops the session.
      const exited = once(worker, "exit");
      worker.kill("SIGKILL");
      await exited;
      await runDaemonOnce(harness, "acp-worker-retire-remaining-");
      expect(lifecycleOf(harness, workerSessionId)).toBe(SessionLifecycle.STOPPED);
    } finally {
      if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL");
    }
  });
});

describe("review round 1: a WORKER's run is its task's run (wr-r1-03)", () => {
  it("a WORKER bound with another run's or project's scope is refused, by bind and by switchTo", async () => {
    const harness = gatedHarness();
    const live = await activeRun(harness);
    const other = await activeRun(harness, ["other"], live);
    const session = harness.cp.sessions.create({ provider: "scripted", model: "scripted-worker" });
    harness.cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "worker ready");
    const taskId = live.taskIds[0]!;

    const wrongRun = harness.cp.bindings.bind({ role: Role.WORKER, sessionId: session.sessionId, taskId, runId: other.runId, projectId: live.projectId });
    const wrongProject = harness.cp.bindings.bind({ role: Role.WORKER, sessionId: session.sessionId, taskId, runId: live.runId, projectId: "another-project" });
    const wrongSwitch = harness.cp.bindings.switchTo({
      role: Role.WORKER,
      sessionId: session.sessionId,
      taskId,
      runId: other.runId,
      reason: "switch with another run's scope",
      conversation: "REPLACED",
    });

    expect([wrongRun.reasonCode, wrongProject.reasonCode, wrongSwitch.reasonCode]).toEqual([
      ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE,
      ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE,
      ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE,
    ]);
    expect(harness.cp.bindings.history(roleKeyFor(Role.WORKER, { taskId }))).toEqual([]);
    // The task's own scope is accepted.
    expect(harness.cp.bindings.bind({ role: Role.WORKER, sessionId: session.sessionId, taskId, runId: live.runId, projectId: live.projectId }).allowed).toBe(true);
  });

  it("a legacy WORKER row naming another run is never revoked by that run's end, and its own run's end defers it once", async () => {
    const harness = gatedHarness();
    const live = await activeRun(harness);
    const labelled = await activeRun(harness, ["other"], live);
    const workerSessionId = bindWorker(harness, live.taskIds[0]!);
    const roleKey = roleKeyFor(Role.WORKER, { taskId: live.taskIds[0]! });
    // A row the registry accepted before it checked a WORKER's scope: task of run `live`, labelled
    // with run `labelled`. Written here directly, because the registry now refuses it.
    const first = harness.cp.bindings.active(roleKey)!;
    const actor = harness.cp.db.get<{ actor_id: string }>(`SELECT actor_id FROM assignments WHERE assignment_id = ?`, [first.assignmentId])!;
    harness.cp.db.tx(() => {
      harness.cp.db.run(`UPDATE assignments SET status = 'REVOKED', revoked_at = ?, revoked_reason = 'legacy fixture' WHERE assignment_id = ?`, [harness.clock.nowIso(), first.assignmentId]);
      harness.cp.db.run(
        `INSERT INTO assignments (assignment_id, role_key, role, project_id, run_id, task_id, actor_id, session_id,
                                  session_incarnation, binding_generation, mode, status, created_at)
         VALUES ('asg_legacy_scope', ?, 'WORKER', ?, ?, ?, ?, ?, ?, 2, 'PREFERRED', 'ACTIVE', ?)`,
        [roleKey, live.projectId, labelled.runId, live.taskIds[0]!, actor.actor_id, workerSessionId, first.sessionIncarnation, harness.clock.nowIso()],
      );
    });
    expect(harness.cp.bindings.active(roleKey)?.runId).toBe(labelled.runId);

    // The labelled run ends: the task's run is live, so its WORKER is not touched.
    expect(harness.cp.runs.cancel(labelled.runId, "the labelled run ends").allowed).toBe(true);
    await harness.cp.workerRetirement.settled();
    expect(workerAssignment(harness, live.taskIds[0]!)).toMatchObject({ status: "ACTIVE" });
    expect(lifecycleOf(harness, workerSessionId)).toBe(SessionLifecycle.READY);

    // The task's own run ends: the label disagrees, so the row is deferred and recorded, not revoked.
    expect(harness.cp.runs.cancel(live.runId, "the task's run ends").allowed).toBe(true);
    await harness.cp.workerRetirement.settled();
    const report = await harness.cp.workerRetirement.reconcile();
    expect(report.deferred).toEqual([roleKey]);
    expect(report.revoked).toEqual([]);
    expect(workerAssignment(harness, live.taskIds[0]!)).toMatchObject({ status: "ACTIVE" });
    expect(lifecycleOf(harness, workerSessionId)).toBe(SessionLifecycle.READY);
    expect(harness.cp.audit.byKind("WORKER_RETIREMENT_DEFERRED")
      .filter((entry) => entry.roleKey === roleKey)
      .map((entry) => entry.evidence)).toEqual([expect.objectContaining({ refusal: "WORKER_SCOPE_CONFLICT" })]);
  });
});

/**
 * A continuity failover of `WORKER:<task>` from a coverage plan taken while the task's execution was
 * RUNNING, on a Claude double, with route and readiness answered. `duringAdmission` runs inside the
 * provider-switch admission, the failover's first await after the plan.
 */
const workerFailover = async (
  harness: Harness,
  run: ActiveRun,
  duringAdmission: () => Promise<void> = async () => undefined,
  duringReadiness: () => Promise<void> = async () => undefined,
) => {
  const roleKey = roleKeyFor(Role.WORKER, { taskId: run.taskIds[0]! });
  const plan = await harness.cp.continuity.evaluate("worker replacement planned while the turn ran");
  expect(plan.requiredRoles.some((role) => role.roleKey === roleKey)).toBe(true);
  plan.assignments = plan.assignments.map((assignment) =>
    assignment.roleKey === roleKey ? { ...assignment, provider: "claude", reason: "preferred" } : assignment);
  const evaluate = vi.spyOn(harness.cp.continuity, "evaluate").mockResolvedValue(plan);
  const admission = vi.spyOn(harness.cp.capacity, "refreshForProviderSwitch").mockImplementation(async () => {
    await duringAdmission();
    return allow(ReasonCode.OK, undefined as never);
  });
  harness.cp.continuity.attach({
    buzz: { connect: async () => allow(ReasonCode.OK, "test-route") },
    readiness: {
      checkSession: async () => {
        await duringReadiness();
        return allow(ReasonCode.OK, undefined);
      },
    },
  });
  try {
    return await harness.cp.continuity.failover(
      roleKey,
      Role.WORKER,
      { projectId: run.projectId, runId: run.runId, taskId: run.taskIds[0]! },
      "worker runtime lost",
    );
  } finally {
    evaluate.mockRestore();
    admission.mockRestore();
  }
};

/** A run whose task has a bound WORKER with a RUNNING receipt, and a Claude double for its failover. */
const runningWorker = async (harness: Harness) => {
  const run = await activeRun(harness);
  const workerSessionId = bindWorker(harness, run.taskIds[0]!);
  const execution = harness.cp.tasks.startExecution({
    runId: run.runId,
    taskId: run.taskIds[0]!,
    ownerBindingGeneration: run.ownerBindingGeneration,
    workerSessionId,
    provider: "scripted",
    model: "scripted-worker",
    repositoryId: run.repositoryId,
  });
  if (!execution.allowed) throw new Error(execution.message);
  const claude = new ClaudeWorkerDouble(harness.clock);
  harness.cp.providers.registerForRole(claude, Role.WORKER);
  return { run, workerSessionId, claude, roleKey: roleKeyFor(Role.WORKER, { taskId: run.taskIds[0]! }) };
};

const claudeSessions = (harness: Harness) =>
  harness.cp.db.all<{ session_id: string; lifecycle: string }>(
    `SELECT session_id, lifecycle FROM sessions WHERE provider = 'claude' ORDER BY session_id`,
  );

describe("review round 1: a terminal run's WORKER never comes back ACTIVE (wr-r1-02)", () => {
  it("cancel first: a failover the cancel overtakes during its admission binds nothing and leaves no session", async () => {
    const harness = gatedHarness();
    const { run, roleKey } = await runningWorker(harness);
    const result = await workerFailover(harness, run, async () => {
      expect(harness.cp.runs.cancel(run.runId, "cancelled during the failover's admission").allowed).toBe(true);
      await harness.cp.workerRetirement.settled();
      expect(harness.cp.bindings.active(roleKey)).toBeNull();
    });
    await harness.cp.workerRetirement.settled();

    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe(ReasonCode.RUN_ALREADY_TERMINAL);
    expect(harness.cp.runs.require(run.runId).state).toBe(RunState.CANCELLED);
    expect(harness.cp.bindings.active(roleKey)).toBeNull();
    expect(harness.cp.bindings.history(roleKey).map((binding) => binding.status)).toEqual(["REVOKED"]);
    expect(claudeSessions(harness).filter((session) => session.lifecycle !== SessionLifecycle.STOPPED)).toEqual([]);
  });

  it("cancel during provisioning: the session the failover started is stopped once through its provider, then STOPPED", async () => {
    const harness = gatedHarness();
    const { run, roleKey, claude } = await runningWorker(harness);
    const result = await workerFailover(harness, run, async () => undefined, async () => {
      expect(harness.cp.runs.cancel(run.runId, "cancelled while the replacement was provisioned").allowed).toBe(true);
    });
    await harness.cp.workerRetirement.settled();

    expect(result.reasonCode).toBe(ReasonCode.RUN_ALREADY_TERMINAL);
    expect(harness.cp.bindings.active(roleKey)).toBeNull();
    const started = claudeSessions(harness);
    expect(started).toHaveLength(1);
    const replacement = harness.cp.sessions.get(started[0]!.session_id)!;
    expect(claude.stopped).toEqual([replacement.incarnation.split("#")[0]]);
    expect(replacement.lifecycle).toBe(SessionLifecycle.STOPPED);
  });

  it("cancel during provisioning, provider stop fails: the session is not marked STOPPED and is recorded as remaining", async () => {
    const harness = gatedHarness();
    const { run, roleKey, claude } = await runningWorker(harness);
    const stop = vi.spyOn(claude, "stopSession").mockRejectedValue(new Error("provider would not stop the session"));
    try {
      const result = await workerFailover(harness, run, async () => undefined, async () => {
        expect(harness.cp.runs.cancel(run.runId, "cancelled while the replacement was provisioned").allowed).toBe(true);
      });
      await harness.cp.workerRetirement.settled();

      expect(result.reasonCode).toBe(ReasonCode.RUN_ALREADY_TERMINAL);
      expect(harness.cp.bindings.active(roleKey)).toBeNull();
      const started = claudeSessions(harness);
      expect(started).toHaveLength(1);
      expect(stop).toHaveBeenCalledTimes(1);
      expect(started[0]!.lifecycle).not.toBe(SessionLifecycle.STOPPED);
      expect(harness.cp.audit.byKind("CONTINUITY_UNBOUND_SESSION_STOP_FAILED")
        .filter((entry) => entry.sessionId === started[0]!.session_id)
        .map((entry) => entry.evidence)).toEqual([expect.objectContaining({ status: "PROCESS_UNVERIFIED" })]);
    } finally {
      stop.mockRestore();
    }
  });

  it("failover first: the WORKER it binds is retired by the cancel that follows", async () => {
    const harness = gatedHarness();
    const { run, roleKey } = await runningWorker(harness);
    const result = await workerFailover(harness, run);
    if (!result.allowed) throw new Error(`${result.reasonCode}: ${result.message}`);
    expect(result.value.generation).toBe(2);
    const replacement = harness.cp.bindings.active(roleKey)!;

    expect(harness.cp.runs.cancel(run.runId, "cancelled after the failover").allowed).toBe(true);
    await harness.cp.workerRetirement.settled();

    expect(harness.cp.bindings.active(roleKey)).toBeNull();
    expect(harness.cp.bindings.history(roleKey).map((binding) => binding.status)).toEqual(["REVOKED", "REVOKED"]);
    expect(workerAssignment(harness, run.taskIds[0]!)?.revoked_reason).toMatch(/run ended CANCELLED/);
    expect(lifecycleOf(harness, replacement.sessionId)).toBe(SessionLifecycle.STOPPED);
  });

  it("the registry refuses to bind or switch a WORKER whose task's run has ended", async () => {
    const harness = gatedHarness();
    const run = await activeRun(harness);
    expect(harness.cp.runs.cancel(run.runId, "ended before anything was bound").allowed).toBe(true);
    const session = harness.cp.sessions.create({ provider: "scripted", model: "scripted-worker" });
    harness.cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "worker ready");

    const bound = harness.cp.bindings.bind({ role: Role.WORKER, sessionId: session.sessionId, taskId: run.taskIds[0]! });
    const switched = harness.cp.bindings.switchTo({
      role: Role.WORKER,
      sessionId: session.sessionId,
      taskId: run.taskIds[0]!,
      reason: "switch onto an ended run",
      conversation: "REPLACED",
    });

    expect([bound.reasonCode, switched.reasonCode]).toEqual([ReasonCode.RUN_ALREADY_TERMINAL, ReasonCode.RUN_ALREADY_TERMINAL]);
    expect(harness.cp.bindings.history(roleKeyFor(Role.WORKER, { taskId: run.taskIds[0]! }))).toEqual([]);
  });
});

const killChild = async (child: ChildProcess): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
};

/** A worker's own process group, standing in for a worker the CTO launched; killed only by the test. */
const liveWorkerProcess = (): ChildProcess =>
  spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });

const remainingFor = (harness: Harness, sessionId: string) =>
  harness.cp.audit.byKind("WORKER_PROCESS_REMAINING").filter((entry) => entry.sessionId === sessionId);

describe("review round 1: an ABANDONED receipt is not exit evidence (wr-r1-04)", () => {
  it("a cancelled receipt without a PID leaves the session live as PROCESS_UNVERIFIED, while the binding is revoked", async () => {
    const harness = gatedHarness();
    const run = await activeRun(harness);
    const workerSessionId = bindWorker(harness, run.taskIds[0]!);
    const capacity = vi.spyOn(harness.cp.tasks, "admitWorkerFanout").mockResolvedValue(allow(ReasonCode.OK, undefined));
    const worker = liveWorkerProcess();
    try {
      // task_receipt_submit's writer: a receipt that names no worker process.
      const execution = await harness.cp.tasks.startWorkerExecution({
        runId: run.runId,
        taskId: run.taskIds[0]!,
        ownerBindingGeneration: run.ownerBindingGeneration,
        workerSessionId,
        provider: "scripted",
        model: "scripted-worker",
        repositoryId: run.repositoryId,
      });
      if (!execution.allowed) throw new Error(execution.message);
      expect(capacity).toHaveBeenCalledTimes(1);

      expect(harness.cp.runs.cancel(run.runId, "cancel a worker whose process was not recorded").allowed).toBe(true);
      await harness.cp.workerRetirement.settled();
      await harness.cp.workerRetirement.reconcile();

      expect(workerAssignment(harness, run.taskIds[0]!)?.status).toBe("REVOKED");
      expect(harness.cp.tasks.execution(execution.value.executionId)).toMatchObject({ status: "ABANDONED", workerProcessId: null });
      expect(lifecycleOf(harness, workerSessionId)).toBe(SessionLifecycle.READY);
      const remaining = remainingFor(harness, workerSessionId);
      expect(remaining).toHaveLength(1);
      expect(remaining[0]!.evidence).toMatchObject({
        executions: [{ executionId: execution.value.executionId, pid: null, status: "PROCESS_UNVERIFIED" }],
      });
      expect(worker.exitCode).toBeNull();
      expect(worker.signalCode).toBeNull();
    } finally {
      await killChild(worker);
      capacity.mockRestore();
    }
  });
});

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("review round 1: retirement is retried by the watchdog (wr-r1-01)", () => {
  it("a watchdog pass settles a retired worker once its process has exited, and repeated passes write nothing", async () => {
    const harness = gatedHarness();
    const run = await activeRun(harness);
    const workerSessionId = bindWorker(harness, run.taskIds[0]!);
    const worker = liveWorkerProcess();
    const daemon = new Daemon(harness.cp, { stateDir: tempDir("acp-worker-retire-ticks-"), watchdogIntervalMs: 25 });
    const tick = vi.spyOn(harness.cp.watchdog, "tick");
    const ticksAfter = async (count: number): Promise<void> => {
      const target = tick.mock.calls.length + count;
      const deadline = Date.now() + 10_000;
      while (tick.mock.calls.length < target && Date.now() < deadline) await delay(20);
      expect(tick.mock.calls.length).toBeGreaterThanOrEqual(target);
      await harness.cp.workerRetirement.settled();
    };
    try {
      const execution = harness.cp.tasks.startExecution({
        runId: run.runId,
        taskId: run.taskIds[0]!,
        ownerBindingGeneration: run.ownerBindingGeneration,
        workerSessionId,
        workerProcessId: worker.pid!,
        provider: "scripted",
        model: "scripted-worker",
        repositoryId: run.repositoryId,
      });
      if (!execution.allowed) throw new Error(execution.message);
      const started = await daemon.start();
      if (!started.allowed) throw new Error(`${started.reasonCode}: ${started.message}`);

      expect(harness.cp.runs.cancel(run.runId, "cancelled while its worker process runs").allowed).toBe(true);
      await harness.cp.workerRetirement.settled();
      expect(lifecycleOf(harness, workerSessionId)).toBe(SessionLifecycle.READY);

      // While the process runs, passes leave the session live and record what remains once.
      await ticksAfter(3);
      expect(lifecycleOf(harness, workerSessionId)).toBe(SessionLifecycle.READY);
      expect(remainingFor(harness, workerSessionId)).toHaveLength(1);

      // Once it has exited, the next pass settles the session, with no restart and no manual call.
      await killChild(worker);
      await ticksAfter(3);
      expect(lifecycleOf(harness, workerSessionId)).toBe(SessionLifecycle.STOPPED);

      // Further passes write nothing.
      const written = harness.cp.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_events WHERE kind LIKE 'WORKER_%' OR (kind = 'SESSION_LIFECYCLE' AND session_id = ?)`, [workerSessionId])!.n;
      await ticksAfter(3);
      expect(harness.cp.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_events WHERE kind LIKE 'WORKER_%' OR (kind = 'SESSION_LIFECYCLE' AND session_id = ?)`, [workerSessionId])!.n).toBe(written);
    } finally {
      await killChild(worker);
      await daemon.stop();
      tick.mockRestore();
    }
  });
});

/**
 * Runs the official cancel immediately before the real `BindingRegistry.switchTo` of a WORKER: the
 * cancel commits after the failover's last read of the run and before the binding transaction, so it
 * is the registry's own fence that refuses.
 */
const cancelAtTheSwitch = (harness: Harness, run: ActiveRun) => {
  const realSwitch = harness.cp.bindings.switchTo.bind(harness.cp.bindings);
  const reached = { count: 0 };
  const spy = vi.spyOn(harness.cp.bindings, "switchTo").mockImplementation((input) => {
    if (input.role === Role.WORKER) {
      reached.count += 1;
      expect(harness.cp.runs.cancel(run.runId, "cancel commits just before the binding transaction").allowed).toBe(true);
    }
    return realSwitch(input);
  });
  return { reached, restore: () => spy.mockRestore() };
};

describe("review round 2: a registry refusal stops the failover's session through its provider (wr-r1-02)", () => {
  it("the registry refuses the switch: the exact session the failover started is stopped once through its provider, then STOPPED", async () => {
    const harness = gatedHarness();
    const { run, roleKey, claude } = await runningWorker(harness);
    const boundary = cancelAtTheSwitch(harness, run);
    try {
      const result = await workerFailover(harness, run);
      await harness.cp.workerRetirement.settled();

      expect(boundary.reached.count).toBe(1);
      expect(result.reasonCode).toBe(ReasonCode.RUN_ALREADY_TERMINAL);
      expect(harness.cp.bindings.active(roleKey)).toBeNull();
      const started = claudeSessions(harness);
      expect(started).toHaveLength(1);
      const session = harness.cp.sessions.get(started[0]!.session_id)!;
      expect(claude.stopped).toEqual([session.incarnation.split("#")[0]]);
      expect(session.lifecycle).toBe(SessionLifecycle.STOPPED);
    } finally {
      boundary.restore();
    }
  });

  it("the registry refuses the switch and the provider stop fails: the session is ERROR, recorded PROCESS_UNVERIFIED, never STOPPED", async () => {
    const harness = gatedHarness();
    const { run, roleKey, claude } = await runningWorker(harness);
    const stop = vi.spyOn(claude, "stopSession").mockRejectedValue(new Error("boundary stop failed"));
    const boundary = cancelAtTheSwitch(harness, run);
    try {
      const result = await workerFailover(harness, run);
      await harness.cp.workerRetirement.settled();

      expect(result.reasonCode).toBe(ReasonCode.RUN_ALREADY_TERMINAL);
      expect(harness.cp.bindings.active(roleKey)).toBeNull();
      const started = claudeSessions(harness);
      expect(started).toHaveLength(1);
      expect(stop).toHaveBeenCalledTimes(1);
      expect(started[0]!.lifecycle).toBe(SessionLifecycle.ERROR);
      expect(harness.cp.audit.byKind("CONTINUITY_UNBOUND_SESSION_STOP_FAILED")
        .filter((entry) => entry.sessionId === started[0]!.session_id)
        .map((entry) => entry.evidence)).toEqual([expect.objectContaining({ status: "PROCESS_UNVERIFIED", error: "boundary stop failed" })]);
    } finally {
      boundary.restore();
      stop.mockRestore();
    }
  });

  it("the registry refuses the switch of a replacement with a real process: the process is stopped by its provider before STOPPED", async () => {
    const harness = gatedHarness();
    const { run, roleKey, claude } = await runningWorker(harness);
    const child = liveWorkerProcess();
    await once(child, "spawn");
    const startSession = claude.startSession.bind(claude);
    const start = vi.spyOn(claude, "startSession").mockImplementation(async (spec) => ({ ...(await startSession(spec)), pid: child.pid! }));
    const stopSession = claude.stopSession.bind(claude);
    // The provider's stop is what ends the replacement's process; nothing else signals it.
    const stop = vi.spyOn(claude, "stopSession").mockImplementation(async (handle) => {
      await killChild(child);
      await stopSession(handle);
    });
    const boundary = cancelAtTheSwitch(harness, run);
    try {
      const result = await workerFailover(harness, run);
      await harness.cp.workerRetirement.settled();
      const replacement = harness.cp.sessions.get(claudeSessions(harness)[0]!.session_id)!;
      let alive = true;
      try {
        process.kill(child.pid!, 0);
      } catch {
        alive = false;
      }

      expect(result.reasonCode).toBe(ReasonCode.RUN_ALREADY_TERMINAL);
      expect(harness.cp.bindings.active(roleKey)).toBeNull();
      expect(replacement.osPid).toBe(child.pid);
      expect(stop).toHaveBeenCalledTimes(1);
      expect(alive).toBe(false);
      expect(replacement.lifecycle).toBe(SessionLifecycle.STOPPED);
    } finally {
      boundary.restore();
      start.mockRestore();
      stop.mockRestore();
      await killChild(child);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// The ordinary finalization path, as tests/unit/ordinary-finalization-authority.test.ts drives it.

const WORKFLOW_PATH = ".github/workflows/ci.yml";
const WORKFLOW = "name: project-ci\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: node verify.js\n";

/** GitHub's merged pull keeps its base snapshot; the target ref is reread separately. */
const reflectMergedBase = (github: FakeGitHub): void => {
  const request = github.request.bind(github);
  github.request = async <T>(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<T> => {
    const response = await request<T>(method, path, body);
    if (method !== "PUT" || !/\/pulls\/\d+\/merge$/.test(path) || !response || typeof response !== "object") {
      return response;
    }
    const merged = response as { merged?: unknown; sha?: unknown };
    const number = Number(/\/pulls\/(\d+)\/merge$/.exec(path)?.[1]);
    const pull = github.pulls.find((entry) => entry.number === number);
    if (merged.merged !== true || typeof merged.sha !== "string" || !pull) return response;
    pull.merge_commit_sha = merged.sha;
    github.setBranch(pull.base.ref, merged.sha);
    return response;
  };
};

/** A STANDARD_WORK run at READY_FOR_CEO_REVIEW with a published packet and a bound WORKER. */
const readyForCeo = async () => {
  const github = new FakeGitHub();
  reflectMergedBase(github);
  const harness = makeHarness({ githubClient: github });
  harness.cp.credentials.install({ token: "test-token", creatorIdentity: "acp-trusted-app" });
  writeFiles(harness.repoPath, { [WORKFLOW_PATH]: WORKFLOW });
  commitAll(harness.repoPath, "add trusted project CI workflow");
  const driven = await driveToReviewedCandidate(harness, {
    workBranch: "feature/F1-retire",
    manifestOverrides: {
      ciWorkflows: [{
        path: WORKFLOW_PATH,
        checkName: "project-ci",
        approvedDigest: sha256(WORKFLOW),
        unapprovedFirstActivation: false,
        repositoryRole: "primary",
      }],
    },
  });
  github.setBranch("dev", driven.baseHead);
  github.setBranch("main", "m".repeat(40));
  github.setBranch(driven.workBranch, driven.candidateHead);
  github.nextMergeSha = driven.candidateHead;
  github.onMerge = ({ mergeSha }) => github.setTrustedPostMergeCheck(mergeSha, "project-ci", WORKFLOW_PATH);
  const claimed = harness.cp.claims.acquire({
    runId: driven.runId,
    ownerSessionId: driven.ownerSessionId,
    ownerBindingGeneration: driven.ownerBindingGeneration,
    ownerRoleKey: harness.cp.runs.require(driven.runId).ownerRoleKey!,
    repositoryIdentity: driven.identity,
    branch: driven.workBranch,
  });
  if (!claimed.allowed) throw new Error(claimed.message);
  await harness.cp.continuity.evaluate("worker retirement packet");
  const packet = harness.cp.ceo.buildPacket({
    runId: driven.runId,
    candidateSnapshotDigest: driven.candidateSnapshotDigest,
    approval: {
      runId: driven.runId,
      candidateSnapshotDigest: driven.candidateSnapshotDigest,
      resultSummary: "candidate verified",
      recommendation: "merge",
      residualRisk: [],
      approvedBySessionId: driven.ownerSessionId,
      approvedByGeneration: driven.ownerBindingGeneration,
      approvedAt: harness.clock.nowIso(),
    },
  });
  if (!packet.allowed) throw new Error(`${packet.reasonCode}: ${packet.message}`);
  expect(harness.cp.runs.require(driven.runId).state).toBe(RunState.READY_FOR_CEO_REVIEW);
  return { github, harness, driven };
};
