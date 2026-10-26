import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ExecutionMode, RunKind, TaskState } from "../../src/domain/types.ts";
import { STANDARD_WORK_TASKS_SUPERSEDED } from "../../src/run/task-graph.ts";
import { bootstrapPlan, callCtoToolAsOwner, cleanTreeManifest } from "../helpers/bootstrap-plan.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import {
  applyPassingChange,
  bindCeo,
  bindWorker,
  dispatchBootstrapRun,
  makeHarness,
  registerFixtureProject,
  reviewerPass,
} from "../helpers/harness.ts";

afterAll(cleanupTempDirs);
afterEach(() => vi.restoreAllMocks());

/**
 * CEO msg_2b439e5a — a STANDARD_WORK re-plan names, in its PLAN's `supersedesTaskIds`, the earlier
 * tasks of the same run it replaces. Only those are cancelled, and only when none of them ever had an
 * execution; anything else refuses the whole plan_submit and changes nothing. Live defect: run_637113d9
 * submitted a second graph and the first graph's four tasks stayed live, one READY duplicate and three
 * PENDING, so "once every task SUCCEEDED, submit the result" could never be met. Every plan_submit here
 * goes through the CTO MCP tool as the run's owner; executions go through TaskGraph's own admission.
 */

const CONTRACT = {
  goal: "make app() return 2",
  why: "downstream callers expect 2",
  scope: ["src/app.js"],
  nonGoals: [],
  acceptance: ["verify.js exits 0"],
  priority: "NORMAL" as const,
  humanGate: [],
  references: [],
};
let seq = 0;

const standardRun = async () => {
  const h = makeHarness();
  const { projectId, repositoryId } = await registerFixtureProject(h, "swsup-project");
  bindCeo(h);
  const created = h.cp.runs.create({
    projectId,
    executionMode: ExecutionMode.STANDARD,
    contract: CONTRACT,
    repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
  });
  if (!created.allowed) throw new Error(created.message);
  const runId = created.value.runId;
  const dispatched = await h.cp.runs.dispatch(runId);
  if (!dispatched.allowed) throw new Error(dispatched.message);
  const owner = { ownerSessionId: dispatched.value.ownerSessionId!, ownerBindingGeneration: dispatched.value.ownerBindingGeneration! };
  const call = (name: string, args: Record<string, unknown>, idempotencyKey = `swsup-${++seq}`) =>
    callCtoToolAsOwner(h, runId, name, { idempotencyKey, runId, ...args });
  const plan = (args: { plan: Record<string, unknown>; tasks: Array<Record<string, unknown>> }, idempotencyKey?: string) =>
    call("plan_submit", args, idempotencyKey);
  /** The tasks of the run, by title, with their states. */
  const states = () => Object.fromEntries(h.cp.tasks.list(runId).map((task) => [task.title, task.state]));
  const byTitle = (title: string) => h.cp.tasks.list(runId).find((task) => task.title === title)!;
  return { h, runId, projectId, repositoryId, owner, call, plan, states, byTitle };
};

type StandardRun = Awaited<ReturnType<typeof standardRun>>;

const docs = (key: string, dependsOn: string[] = []) => ({ key, title: key, category: "docs" as const, dependsOn });

/** The first graph: A and B READY, C PENDING behind A. */
const firstGraph = async (run: StandardRun) => {
  const first = await run.plan({ plan: { summary: "graph 1" }, tasks: [docs("A"), docs("B"), docs("C", ["A"])] });
  expect(first.body, first.text).toMatchObject({ ok: true });
  expect(run.states()).toEqual({ A: TaskState.READY, B: TaskState.READY, C: TaskState.PENDING });
  return { a: run.byTitle("A").taskId, b: run.byTitle("B").taskId, c: run.byTitle("C").taskId };
};

/** Everything a refused plan_submit must leave as it found it. */
const snapshot = (run: StandardRun) => ({
  plan: run.h.cp.artifacts.latest(run.runId, "PLAN")?.digest ?? null,
  tasks: run.h.cp.tasks.list(run.runId),
  superseded: run.h.cp.audit.byKind(STANDARD_WORK_TASKS_SUPERSEDED).length,
  executions: run.h.cp.tasks.executions(run.runId),
});

describe("CEO msg_2b439e5a (1, 3) — a re-plan cancels exactly the tasks it names", () => {
  it("the named tasks are CANCELLED with the superseding PLAN's digest recorded; the un-named ones are kept; a PLAN without the field cancels nothing", async () => {
    const run = await standardRun();
    const { a, b, c } = await firstGraph(run);

    const second = await run.plan({ plan: { summary: "graph 2", supersedesTaskIds: [a, c] }, tasks: [docs("D")] });
    expect(second.body, second.text).toMatchObject({ ok: true, value: [{ title: "D", state: TaskState.READY }] });
    expect(run.states()).toEqual({ A: TaskState.CANCELLED, B: TaskState.READY, C: TaskState.CANCELLED, D: TaskState.READY });
    const current = run.h.cp.artifacts.latest<Record<string, unknown>>(run.runId, "PLAN")!;
    expect(current.content["supersedesTaskIds"]).toEqual([a, c]);
    const records = run.h.cp.audit.byKind(STANDARD_WORK_TASKS_SUPERSEDED);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      runId: run.runId,
      evidence: {
        planDigest: current.digest,
        reason: `superseded by PLAN ${current.digest}`,
        cancelled: [a, c],
        taskIds: [run.byTitle("D").taskId],
      },
    });
    expect(run.h.cp.tasks.executions(run.runId)).toEqual([]);

    // STANDARD_WORK still adds tasks in stages: a PLAN with no supersedesTaskIds cancels nothing.
    const third = await run.plan({ plan: { summary: "graph 3, a stage" }, tasks: [docs("E", ["B"])] });
    expect(third.body, third.text).toMatchObject({ ok: true });
    expect(run.states()).toEqual({
      A: TaskState.CANCELLED, B: TaskState.READY, C: TaskState.CANCELLED, D: TaskState.READY, E: TaskState.PENDING,
    });
    expect(run.h.cp.audit.byKind(STANDARD_WORK_TASKS_SUPERSEDED)).toHaveLength(1);
    expect(b).toBe(run.byTitle("B").taskId);
  });

  it("a retried request is idempotent: the same key replays, and a new key with the same PLAN and graph is a no-op success", async () => {
    const run = await standardRun();
    const { b } = await firstGraph(run);
    const request = { plan: { summary: "graph 2", supersedesTaskIds: [b] }, tasks: [docs("D")] };
    const first = await run.plan(request, "swsup-replay-key");
    expect(first.body, first.text).toMatchObject({ ok: true });
    const after = snapshot(run);

    const replayed = await run.plan(request, "swsup-replay-key");
    expect(replayed.body).toEqual(first.body);
    expect(snapshot(run)).toEqual(after);

    const again = await run.plan(request);
    expect(again.body, again.text).toMatchObject({ ok: true, value: [{ taskId: run.byTitle("D").taskId, title: "D" }] });
    expect(snapshot(run)).toEqual(after);
    expect(run.h.cp.tasks.list(run.runId)).toHaveLength(4);

    // The same PLAN with a different graph is not a retry: its named task is already CANCELLED.
    const changed = await run.plan({ ...request, tasks: [docs("D2")] });
    expect(changed.body, changed.text).toMatchObject({
      ok: false, reasonCode: ReasonCode.CONFLICT, evidence: { refusal: "SUPERSEDED_TASK_NOT_CANCELLABLE", taskId: b, state: TaskState.CANCELLED },
    });
    expect(snapshot(run)).toEqual(after);
  });
});

describe("CEO msg_2b439e5a (2) — an ineligible named task refuses the whole plan_submit, and nothing is partial", () => {
  it("execution-history witness: a READY task whose execution was abandoned at a takeover is refused, and nothing is cancelled or stored", async () => {
    const run = await standardRun();
    const { a, b } = await firstGraph(run);
    const opened = run.h.cp.tasks.startExecution({
      runId: run.runId, taskId: a, ownerBindingGeneration: run.owner.ownerBindingGeneration,
      workerSessionId: bindWorker(run.h, a), provider: "scripted", model: "scripted-worker",
    });
    expect(opened.allowed).toBe(true);
    // A takeover abandons the execution and puts the task back to READY, with its execution kept.
    expect(run.h.cp.tasks.abandonStaleExecutions(run.runId, run.owner.ownerBindingGeneration + 1, "takeover")).toBe(1);
    expect(run.h.cp.tasks.require(a)).toMatchObject({ state: TaskState.READY, attemptCount: 1 });
    const before = snapshot(run);

    const refused = await run.plan({ plan: { summary: "graph 2", supersedesTaskIds: [b, a] }, tasks: [docs("D")] });
    expect(refused.body, refused.text).toMatchObject({
      ok: false, reasonCode: ReasonCode.CONFLICT, evidence: { refusal: "SUPERSEDED_TASK_HAS_EXECUTION", taskId: a },
    });
    expect(snapshot(run)).toEqual(before);
    expect(run.states()).toEqual({ A: TaskState.READY, B: TaskState.READY, C: TaskState.PENDING });
  });

  it("a RUNNING task, an unknown task id and another run's task are each refused by name; the eligible task named with them is left READY", async () => {
    const run = await standardRun();
    const { a, b } = await firstGraph(run);
    const otherRun = run.h.cp.runs.create({
      projectId: run.projectId, executionMode: ExecutionMode.STANDARD, contract: CONTRACT,
      repositories: [{ repositoryId: run.repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
    });
    if (!otherRun.allowed) throw new Error(otherRun.message);
    const otherTask = run.h.cp.tasks.submit(otherRun.value.runId, [docs("X")]);
    if (!otherTask.allowed) throw new Error(otherTask.message);
    expect(run.h.cp.tasks.startExecution({
      runId: run.runId, taskId: a, ownerBindingGeneration: run.owner.ownerBindingGeneration,
      workerSessionId: bindWorker(run.h, a), provider: "scripted", model: "scripted-worker",
    }).allowed).toBe(true);
    const before = snapshot(run);
    const cases: Array<[string[], ReasonCode, string]> = [
      [[b, a], ReasonCode.CONFLICT, "SUPERSEDED_TASK_HAS_EXECUTION"],
      [[b, "task_unknown"], ReasonCode.NOT_FOUND, "SUPERSEDED_TASK_UNKNOWN"],
      [[b, otherTask.value[0]!.taskId], ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE, "SUPERSEDED_TASK_OUTSIDE_RUN"],
      [[b, b], ReasonCode.INVALID_ARGUMENT, "SUPERSEDED_TASK_DUPLICATE"],
    ];
    for (const [supersedesTaskIds, reasonCode, refusal] of cases) {
      const refused = await run.plan({ plan: { summary: `graph 2 ${refusal}`, supersedesTaskIds }, tasks: [docs("D")] });
      expect(refused.body, refused.text).toMatchObject({ ok: false, reasonCode, evidence: { refusal } });
      expect(snapshot(run)).toEqual(before);
    }
    expect(run.states()).toEqual({ A: TaskState.RUNNING, B: TaskState.READY, C: TaskState.PENDING });
    expect(run.h.cp.tasks.list(otherRun.value.runId).map((task) => task.state)).toEqual([TaskState.READY]);
  });

  it("a project-less bootstrap PLAN that names supersedesTaskIds is refused before its PLAN or task is stored", async () => {
    const h = makeHarness();
    bindCeo(h);
    const created = h.cp.runs.create({ kind: RunKind.PROJECT_BOOTSTRAP, executionMode: ExecutionMode.STANDARD, contract: { ...CONTRACT, scope: [] } });
    if (!created.allowed) throw new Error(created.message);
    const runId = created.value.runId;
    await dispatchBootstrapRun(h.cp, h.clock, runId);
    const refused = await callCtoToolAsOwner(h, runId, "plan_submit", {
      idempotencyKey: `swsup-${++seq}`, runId,
      plan: { ...bootstrapPlan(cleanTreeManifest("swsup-bootstrap")), supersedesTaskIds: ["task_any"] },
      tasks: [{ key: "create", title: "create repository", category: "implementation" }],
    });
    expect(refused.body, refused.text).toMatchObject({
      ok: false, reasonCode: ReasonCode.INVALID_ARGUMENT, evidence: { refusal: "SUPERSEDES_TASKS_NOT_STANDARD_WORK" },
    });
    expect(h.cp.artifacts.latest(runId, "PLAN")).toBeNull();
    expect(h.cp.tasks.list(runId)).toEqual([]);
  });
});

describe("CEO msg_2b439e5a (2) — an execution start racing the cancel: exactly one wins", () => {
  /** task_worker_run's admission (`startWorkerExecution`), held at its capacity await until released. */
  const heldAdmission = (run: StandardRun, taskId: string) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(run.h.cp.tasks, "admitWorkerFanout").mockImplementation(async () => {
      await gate;
      return allow(ReasonCode.OK, undefined);
    });
    const started = run.h.cp.tasks.startWorkerExecution({
      runId: run.runId, taskId, ownerBindingGeneration: run.owner.ownerBindingGeneration, workerSessionId: bindWorker(run.h, taskId),
    });
    return { release, started };
  };

  it("the cancel commits while the admission awaits capacity: the admission is refused and the cancelled task never gets an execution", async () => {
    const run = await standardRun();
    const { b } = await firstGraph(run);
    const admission = heldAdmission(run, b);
    const cancelled = await run.plan({ plan: { summary: "graph 2", supersedesTaskIds: [b] }, tasks: [docs("D")] });
    expect(cancelled.body, cancelled.text).toMatchObject({ ok: true });
    admission.release();
    expect(await admission.started).toMatchObject({ allowed: false, reasonCode: ReasonCode.TASK_DEPENDENCY_UNSATISFIED, evidence: { state: TaskState.CANCELLED } });
    expect(run.h.cp.tasks.require(b).state).toBe(TaskState.CANCELLED);
    expect(run.h.cp.tasks.executions(run.runId).filter((execution) => execution.taskId === b)).toEqual([]);
  });

  it("the execution opens first: the cancel is refused and the task keeps its execution", async () => {
    const run = await standardRun();
    const { a } = await firstGraph(run);
    const admission = heldAdmission(run, a);
    admission.release();
    expect(await admission.started).toMatchObject({ allowed: true });
    const before = snapshot(run);
    const refused = await run.plan({ plan: { summary: "graph 2", supersedesTaskIds: [a] }, tasks: [docs("D")] });
    expect(refused.body, refused.text).toMatchObject({ ok: false, evidence: { refusal: "SUPERSEDED_TASK_HAS_EXECUTION", taskId: a } });
    expect(snapshot(run)).toEqual(before);
    expect(run.h.cp.tasks.require(a).state).toBe(TaskState.RUNNING);
  });
});

describe("CEO msg_2b439e5a (4) — no task that stays live may depend on a cancelled task", () => {
  it("dependency witness: superseding A while C, which stays, depends on it is refused; superseding both is accepted", async () => {
    const run = await standardRun();
    const { a, c } = await firstGraph(run);
    const before = snapshot(run);
    const refused = await run.plan({ plan: { summary: "graph 2", supersedesTaskIds: [a] }, tasks: [docs("D")] });
    expect(refused.body, refused.text).toMatchObject({
      ok: false, reasonCode: ReasonCode.TASK_DEPENDENCY_UNSATISFIED, evidence: { refusal: "LIVE_TASK_DEPENDS_ON_CANCELLED", taskId: c, dependsOn: a },
    });
    expect(snapshot(run)).toEqual(before);

    const accepted = await run.plan({ plan: { summary: "graph 2", supersedesTaskIds: [a, c] }, tasks: [docs("D")] });
    expect(accepted.body, accepted.text).toMatchObject({ ok: true });
    expect(run.states()).toEqual({ A: TaskState.CANCELLED, B: TaskState.READY, C: TaskState.CANCELLED, D: TaskState.READY });
  });

  it("a new task that depends on a task this PLAN cancels, or on one an earlier PLAN cancelled, is refused", async () => {
    const run = await standardRun();
    const { a, b } = await firstGraph(run);
    const before = snapshot(run);
    const refused = await run.plan({ plan: { summary: "graph 2", supersedesTaskIds: [b] }, tasks: [docs("D", ["B"])] });
    expect(refused.body, refused.text).toMatchObject({
      ok: false, evidence: { refusal: "LIVE_TASK_DEPENDS_ON_CANCELLED", task: "D", dependency: "B", dependsOn: b },
    });
    expect(snapshot(run)).toEqual(before);
    expect((await run.plan({ plan: { summary: "graph 2", supersedesTaskIds: [b] }, tasks: [docs("D", ["A"])] })).body).toMatchObject({ ok: true });
    const later = snapshot(run);
    const staged = await run.plan({ plan: { summary: "a stage on a cancelled task" }, tasks: [docs("E", ["B"])] });
    expect(staged.body, staged.text).toMatchObject({ ok: false, evidence: { refusal: "LIVE_TASK_DEPENDS_ON_CANCELLED", dependsOn: b } });
    expect(run.h.cp.tasks.list(run.runId)).toEqual(later.tasks);
    expect(a).toBe(run.byTitle("A").taskId);
  });
});

describe("CEO msg_2b439e5a (4, 5) — a cancelled task is never staffed or run, and never holds back the result", () => {
  it("worker provisioning and execution admission refuse a cancelled task", async () => {
    const run = await standardRun();
    const { b } = await firstGraph(run);
    expect((await run.plan({ plan: { summary: "graph 2", supersedesTaskIds: [b] }, tasks: [docs("D")] })).body).toMatchObject({ ok: true });
    const fence = () => allow(ReasonCode.OK, { sessionId: run.owner.ownerSessionId, bindingGeneration: run.owner.ownerBindingGeneration });
    expect(await run.h.cp.workers.provision({ runId: run.runId, taskId: b, provider: "claude", ownerBindingGeneration: run.owner.ownerBindingGeneration, fence }))
      .toMatchObject({ allowed: false, reasonCode: ReasonCode.TASK_DEPENDENCY_UNSATISFIED, evidence: { state: TaskState.CANCELLED } });
    vi.spyOn(run.h.cp.tasks, "admitWorkerFanout").mockResolvedValue(allow(ReasonCode.OK, undefined));
    expect(await run.h.cp.tasks.startWorkerExecution({
      runId: run.runId, taskId: b, ownerBindingGeneration: run.owner.ownerBindingGeneration, workerSessionId: bindWorker(run.h, b),
    })).toMatchObject({ allowed: false, reasonCode: ReasonCode.TASK_DEPENDENCY_UNSATISFIED, evidence: { state: TaskState.CANCELLED } });
    expect(run.h.cp.tasks.executions(run.runId)).toEqual([]);
  });

  it("completion: with the superseded tasks CANCELLED and every other task SUCCEEDED, result_submit passes task completeness and reaches its review", async () => {
    const run = await standardRun();
    const { a, b, c } = await firstGraph(run);
    const submit = () => run.h.cp.pipeline.submitResult({ runId: run.runId, ...run.owner, resultSummary: "app() returns 2", recommendation: "merge" });
    // Before the re-plan the first graph's tasks hold the result back, as on run_637113d9.
    expect(await submit()).toMatchObject({ allowed: false, reasonCode: ReasonCode.TASK_RESULT_COUNT_MISMATCH });
    expect((await run.plan({ plan: { summary: "graph 2", supersedesTaskIds: [a, b, c] }, tasks: [docs("impl")] })).body).toMatchObject({ ok: true });
    const impl = run.byTitle("impl").taskId;
    const opened = run.h.cp.tasks.startExecution({
      runId: run.runId, taskId: impl, ownerBindingGeneration: run.owner.ownerBindingGeneration,
      workerSessionId: bindWorker(run.h, impl), provider: "scripted", model: "scripted-worker", repositoryId: run.repositoryId,
    });
    if (!opened.allowed) throw new Error(opened.message);
    const head = applyPassingChange(run.h.repoPath, "feature/F1-thing");
    expect(run.h.cp.tasks.finishExecution(opened.value.executionId, { status: "SUCCEEDED", resultDigest: `sha256:${head}` }).allowed).toBe(true);
    expect(run.h.cp.tasks.completeness(run.runId)).toMatchObject({ allowed: true, value: { tasks: 4, succeeded: 1 } });
    run.h.scripted.script({ match: /Candidate review/, text: reviewerPass(["github:acme/fixture:src/app.js"]) });
    const result = await submit();
    expect(result, JSON.stringify(result)).toMatchObject({ allowed: true, value: { stage: "COMPLETED_REVIEW" } });
    expect(run.states()).toEqual({ A: TaskState.CANCELLED, B: TaskState.CANCELLED, C: TaskState.CANCELLED, impl: TaskState.SUCCEEDED });
  });
});
