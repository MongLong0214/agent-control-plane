import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";

import { afterAll, describe, expect, it } from "vitest";

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
      expect((await harness.cp.workerRetirement.reconcile()).stopped).toEqual([workerSessionId]);
      expect(lifecycleOf(harness, workerSessionId)).toBe(SessionLifecycle.STOPPED);
    } finally {
      if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL");
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
