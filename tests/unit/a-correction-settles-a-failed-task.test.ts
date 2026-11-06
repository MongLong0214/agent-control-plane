import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { createBootstrapGitHubWritePort } from "../../src/bootstrap/bootstrap-write-guard.ts";
import { acpError } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ExecutionMode, Role, RunKind, RunState, SessionLifecycle, TaskState, roleKeyFor } from "../../src/domain/types.ts";
import type { GitHubClient } from "../../src/github/github-kernel.ts";
import { TASK_CORRECTION_REGISTERED } from "../../src/run/task-graph.ts";
import { callCtoTool } from "../helpers/cto-tool.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { applyPassingChange, bindCeo, bindWorker, makeHarness, registerFixtureProject, reviewerPass, type Harness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);
afterEach(() => vi.restoreAllMocks());

/**
 * #1368 — a FAILED task replaced by a SUCCEEDED correction task stops blocking the run's result, once the
 * run's owner registers the relation with task_correction_register: same run and work unit, the original
 * FAILED, the correction SUCCEEDED and declared at its PLAN (correctionOf.taskId), and the original's
 * acceptance digest named. The live case (myeotnyeon, run_85fd0674): U1 FAILED, its correction U1b SUCCEEDED
 * with a free-text correctionOf, and result_submit refused TASK_RESULT_COUNT_MISMATCH.
 *
 * Over the real control plane and CTO MCP tools, with a Repo Factory project whose work units are linked on
 * an in-memory GitHub (read only: every unit adopts an existing issue). Executions go through TaskGraph's own
 * admission, as the CTO receipt path records them.
 */

const OWNER = "acme";
const NAME = "fixture";
const IDENTITY = `github:${OWNER}/${NAME}`;
const NODE = "R_kgDOprojectrepo";
const ROOT = `repos/${OWNER}/${NAME}`;
const API = "https://api.github.com";
const COVERED = `${IDENTITY}:src/app.js`;

/** The project's repository on GitHub: one milestone holding issues #1 and #2. Nothing is created here. */
class LinkedRepository implements GitHubClient {
  readonly milestone = { number: 1, node_id: "MI_1", title: "Repo migration", description: "", url: `${API}/${ROOT}/milestones/1`, state: "open" };
  readonly issues = [1, 2].map((number) => ({
    number, node_id: `I_${number}`, title: `Migration unit ${number}`, body: "", state: "open", labels: [],
    milestone: { number: 1, node_id: "MI_1", url: `${API}/${ROOT}/milestones/1`, title: "Repo migration" },
    repository_url: `${API}/${ROOT}`,
  }));

  async request<T>(method: string, path: string): Promise<T> {
    const [route, query] = path.split("?");
    if (method !== "GET") throw new Error(`unexpected request ${method} ${path}`);
    if (route === ROOT) return { node_id: NODE, full_name: `${OWNER}/${NAME}`, visibility: "public", private: false, default_branch: "dev", description: null } as T;
    const first = Number(new URLSearchParams(query ?? "").get("page") ?? "1") === 1;
    if (route === `${ROOT}/milestones`) return (first ? [this.milestone] : []) as T;
    if (route === `${ROOT}/issues`) return (first ? this.issues : []) as T;
    const one = new RegExp(`^${ROOT}/(issues|milestones)/(\\d+)$`).exec(route ?? "");
    const row = one === null ? undefined : one[1] === "issues" ? this.issues.find((issue) => issue.number === Number(one[2])) : Number(one[2]) === 1 ? this.milestone : undefined;
    if (row !== undefined) return row as T;
    throw acpError(ReasonCode.INTERNAL_ERROR, `gh api GET ${path} failed: (HTTP 404)`, { status: 404, method, path });
  }
}

const CONTRACT = { goal: "make app() return 2", why: "downstream callers expect 2", scope: ["src/app.js"], nonGoals: [], acceptance: ["verify.js exits 0"], priority: "NORMAL" as const, humanGate: [], references: [] };
let seq = 0;

/**
 * A dispatched STANDARD_WORK run of a Repo Factory project. Its provisioning row names the repository and is
 * recorded after dispatch (the resident CTO already holds the project); its holder run is another run of
 * the same project.
 */
const governedRun = async () => {
  const h: Harness = makeHarness({ repoFactory: { workRoot: tempDir("rf-work-"), githubPort: createBootstrapGitHubWritePort(new LinkedRepository(), async () => ({ exitCode: 0, stdout: "", stderr: "" })) } });
  const project = await registerFixtureProject(h, "myeotnyeon", {}, { identity: IDENTITY });
  bindCeo(h);
  const created = h.cp.runs.create({ projectId: project.projectId, kind: RunKind.STANDARD_WORK, executionMode: ExecutionMode.STANDARD, contract: CONTRACT, repositories: [{ repositoryId: project.repositoryId, repositoryRole: "primary", baseBranch: "dev" }] });
  if (!created.allowed) throw new Error(created.message);
  const runId = created.value.runId;
  const dispatched = await h.cp.runs.dispatch(runId);
  if (!dispatched.allowed) throw new Error(`${dispatched.reasonCode}: ${dispatched.message}`);
  const holder = h.cp.runs.create({ projectId: project.projectId, kind: RunKind.STANDARD_WORK, executionMode: ExecutionMode.SIMPLE, contract: CONTRACT, repositories: [] });
  if (!holder.allowed) throw new Error(holder.message);
  h.cp.db.run(
    `INSERT INTO resident_project_provisioning(run_id,project_id,binding_json,allocation_json,confirmation_json,steps_json,status,updated_at)
     VALUES (?,?,'{}',?,'{}','{}','COMPLETE',?)`,
    [holder.value.runId, project.projectId, JSON.stringify({ projectId: project.projectId, repositoryIdentity: IDENTITY, repositoryNodeId: NODE }), h.clock.nowIso()],
  );
  const run = h.cp.runs.require(runId);
  const peer = (sessionId: string) => ({ sessionId, incarnation: h.cp.sessions.get(sessionId)!.incarnation });
  let owner = peer(run.ownerSessionId!);
  const call = (name: string, args: Record<string, unknown>, as = owner) => callCtoTool(h, as, name, { idempotencyKey: `corr-${++seq}`, runId, ...args });
  const byTitle = (title: string) => h.cp.tasks.list(runId).find((task) => task.title === title)!.taskId;
  const plan = async (workUnits: unknown[], tasks: Array<{ key: string; spec?: Record<string, unknown> }>) => {
    const answer = await call("plan_submit", {
      plan: { summary: "migration", workUnits },
      tasks: tasks.map((task) => ({ key: task.key, title: task.key, category: "implementation", spec: task.spec ?? {} })),
    });
    expect(answer, JSON.stringify(answer).slice(0, 600)).toMatchObject({ ok: true, evidence: { githubTracking: { tracked: true } } });
  };
  const start = (taskId: string) => {
    const generation = h.cp.runs.require(runId).ownerBindingGeneration!;
    const workerSessionId = h.cp.bindings.active(roleKeyFor(Role.WORKER, { taskId }))?.sessionId ?? bindWorker(h, taskId);
    const opened = h.cp.tasks.startExecution({ runId, taskId, ownerBindingGeneration: generation, workerSessionId, provider: "scripted", model: "scripted-worker", repositoryId: project.repositoryId });
    if (!opened.allowed) throw new Error(`${opened.reasonCode}: ${opened.message}`);
    return opened.value.executionId;
  };
  const finish = (executionId: string, outcome: { status: "SUCCEEDED"; head: string } | { status: "FAILED" }) => {
    const closed = outcome.status === "SUCCEEDED"
      ? h.cp.tasks.finishExecution(executionId, { status: "SUCCEEDED", resultDigest: `sha256:${outcome.head}` }, runId)
      : h.cp.tasks.finishExecution(executionId, { status: "FAILED", resultDigest: null, failureClass: "contract" }, runId);
    if (!closed.allowed) throw new Error(`${closed.reasonCode}: ${closed.message}`);
  };
  const execute = (taskId: string, outcome: Parameters<typeof finish>[1]) => finish(start(taskId), outcome);
  /** What the CTO reads with contract_get: the acceptance digest a correction names. */
  const acceptanceOf = async (taskId: string): Promise<string> => {
    const answer = await call("contract_get", {});
    const task = ((answer["value"] as { tasks: Array<{ taskId: string; acceptanceDigest: string }> }).tasks).find((t) => t.taskId === taskId)!;
    return task.acceptanceDigest;
  };
  const register = (taskId: string, corrects: { taskId: string; acceptanceDigest: string }, as = owner) =>
    call("task_correction_register", { taskId, corrects }, as);
  const records = () => h.cp.audit.byKind(TASK_CORRECTION_REGISTERED);
  const submit = () => call("result_submit", { resultSummary: "the caption-split API is in the repo", recommendation: "merge" });
  /** Ownership moves to a replacement session the way a takeover moves it. */
  const takeOver = () => {
    const roleKey = h.cp.runs.require(runId).ownerRoleKey!;
    const held = h.cp.bindings.active(roleKey)!;
    expect(h.cp.runs.transition(runId, RunState.BLOCKED, "test hold").allowed).toBe(true);
    expect(h.cp.bindings.revoke(roleKey, "test takeover", { allowBlockedRuns: true }).allowed).toBe(true);
    const other = h.cp.sessions.create({ provider: "scripted", model: "scripted-cto" });
    h.cp.sessions.transition(other.sessionId, SessionLifecycle.READY, "the replacement owner");
    const bound = h.cp.bindings.bind({ roleKey, role: held.role, sessionId: other.sessionId, projectId: project.projectId });
    if (!bound.allowed) throw new Error(bound.message);
    expect(h.cp.runs.reassignOwner(runId, bound.value, "a replacement took the run").allowed).toBe(true);
    expect(h.cp.runs.transition(runId, RunState.ACTIVE, "test release").allowed).toBe(true);
    const previous = owner;
    owner = peer(other.sessionId);
    return previous;
  };
  return { h, runId, holderRunId: holder.value.runId, plan, start, finish, execute, byTitle, acceptanceOf, register, records, submit, takeOver, call };
};

const refusal = (answer: Record<string, unknown>) => (answer["evidence"] as { refusal?: string } | undefined)?.refusal;
const failedSpec = { requirements: ["pipeline/tools/layout.py holds only chunks, wrap, weight and tc", "npm test passes"], ownedPaths: ["pipeline/tools/layout.py"] };
const correctionOf = (taskId: string) => ({
  correctionOf: { taskId, failedExecution: `${taskId}#1`, failure: "contract / NO_CHANGE / EVIDENCE_MISSING: the spec named no SHA-256 and needed a scratch file outside the write paths", fix: "verify by git blob id in memory, no scratch file; acceptance, paths and base unchanged" },
  requirements: ["pipeline/tools/layout.py holds only chunks, wrap, weight and tc", "npm test passes", "the reference is verified in memory"],
});
const rowsOf = (h: Harness, taskId: string) => ({
  task: h.cp.db.get(`SELECT * FROM tasks WHERE task_id = ?`, [taskId]),
  executions: h.cp.db.all(`SELECT * FROM task_executions WHERE task_id = ? ORDER BY attempt`, [taskId]),
});

describe("#1368 — a registered correction settles its FAILED task for completeness, and nothing else", () => {
  it("the live case: U1 FAILED, U1b SUCCEEDED with a free-text correctionOf still blocks; registered, result_submit verifies and reviews; U1 stays FAILED", async () => {
    const r = await governedRun();
    await r.plan([{ key: "unit1-layout", tasks: ["U1"], issue: { number: 1 }, milestone: { number: 1 } }], [{ key: "U1", spec: failedSpec }]);
    const u1 = r.byTitle("U1");
    r.execute(u1, { status: "FAILED" });
    await r.plan([{ key: "unit1-layout", tasks: [u1, "U1b"], issue: { number: 1 }, milestone: { number: 1 } }], [{ key: "U1b", spec: correctionOf(u1) }]);
    const u1b = r.byTitle("U1b");
    const acceptance = await r.acceptanceOf(u1);
    const relation = { taskId: u1, acceptanceDigest: acceptance };

    // While the correction is READY, RUNNING or FAILED, nothing is registered and U1 keeps blocking.
    expect(await r.register(u1b, relation)).toMatchObject({ ok: false, reasonCode: ReasonCode.CONFLICT, evidence: { refusal: "CORRECTION_NOT_SUCCEEDED", correctionState: TaskState.READY } });
    const first = r.start(u1b);
    expect(await r.register(u1b, relation)).toMatchObject({ ok: false, evidence: { refusal: "CORRECTION_NOT_SUCCEEDED", correctionState: TaskState.RUNNING } });
    r.finish(first, { status: "FAILED" });
    expect(await r.register(u1b, relation)).toMatchObject({ ok: false, evidence: { refusal: "CORRECTION_NOT_SUCCEEDED", correctionState: TaskState.FAILED } });
    const second = r.start(u1b);
    r.finish(second, { status: "SUCCEEDED", head: applyPassingChange(r.h.repoPath, "feature/u1b") });

    // The current block, reproduced: a SUCCEEDED correction with only its free-text correctionOf.
    expect(await r.submit()).toMatchObject({ ok: false, reasonCode: ReasonCode.TASK_RESULT_COUNT_MISMATCH, evidence: { unfinished: [{ taskId: u1, state: TaskState.FAILED }] } });
    // An acceptance that is not U1's is refused.
    expect(refusal(await r.register(u1b, { taskId: u1, acceptanceDigest: `sha256:${"0".repeat(64)}` }))).toBe("CORRECTION_ACCEPTANCE_MISMATCH");
    expect(r.records()).toEqual([]);

    const before = rowsOf(r.h, u1);
    const registered = await r.register(u1b, relation);
    expect(registered, JSON.stringify(registered).slice(0, 600)).toMatchObject({
      ok: true,
      value: { registered: true, correction: { originalTaskId: u1, correctionTaskId: u1b, workUnit: "unit1-layout", acceptanceDigest: acceptance } },
    });
    // The same relation again: answered as registered, one record.
    expect(await r.register(u1b, relation)).toMatchObject({ ok: true, value: { registered: false, correction: { originalTaskId: u1, correctionTaskId: u1b } } });
    expect(r.records()).toHaveLength(1);
    expect(r.records()[0]).toMatchObject({
      runId: r.runId,
      evidence: {
        originalTaskId: u1, correctionTaskId: u1b, workUnit: "unit1-layout", acceptanceDigest: acceptance,
        correctionExecution: { executionId: second },
        originalExecutions: [{ executionId: `${u1}#1`, status: "FAILED", failureClass: "contract" }],
      },
    });
    expect(r.h.cp.tasks.completeness(r.runId)).toMatchObject({ allowed: true, value: { tasks: 2, succeeded: 1, settledByCorrection: [{ taskId: u1, correctionTaskId: u1b }] } });

    // Eligible again, and nothing is skipped: the candidate is frozen, verified and blind reviewed, and
    // the run waits for the CEO's decision.
    const count = (kind: string) => r.h.cp.audit.forRun(r.runId).filter((row) => row.kind === kind).length;
    r.h.scripted.script({ match: /Candidate review/, text: reviewerPass([COVERED]) });
    const submitted = await r.submit();
    expect(submitted, JSON.stringify(submitted).slice(0, 600)).toMatchObject({ ok: true, value: { stage: "COMPLETED_REVIEW" } });
    expect([count("CANDIDATE_FROZEN"), count("VERIFICATION_COMPLETED"), count("BLIND_REVIEW_COMPLETED")]).toEqual([1, 1, 1]);
    expect(r.h.cp.runs.require(r.runId).state).toBe(RunState.READY_FOR_CEO_REVIEW);
    // U1 and its execution are as they were: FAILED, with their failure evidence.
    expect(rowsOf(r.h, u1)).toEqual(before);
    expect(before.task).toMatchObject({ state: TaskState.FAILED });
    expect(before.executions).toEqual([expect.objectContaining({ status: "FAILED", failure_class: "contract" })]);
  });

  it("refused: self-reference, another work unit, another run, an undeclared relation, a duplicate either way, a cycle and a stale owner; a correction that stops being SUCCEEDED blocks again", async () => {
    const r = await governedRun();
    await r.plan([
      { key: "unit1", tasks: ["U1"], issue: { number: 1 }, milestone: { number: 1 } },
      { key: "unit2", tasks: ["W"], issue: { number: 2 }, milestone: { number: 1 } },
    ], [{ key: "U1", spec: failedSpec }, { key: "W", spec: failedSpec }]);
    const [u1, w] = [r.byTitle("U1"), r.byTitle("W")];
    r.execute(u1, { status: "FAILED" });
    r.execute(w, { status: "FAILED" });
    await r.plan([
      { key: "unit1", tasks: [u1, "U1b", "U1c"], issue: { number: 1 }, milestone: { number: 1 } },
      { key: "unit2", tasks: [w, "V", "W2"], issue: { number: 2 }, milestone: { number: 1 } },
    ], [{ key: "U1b", spec: correctionOf(u1) }, { key: "U1c", spec: correctionOf(u1) }, { key: "V", spec: correctionOf(u1) }, { key: "W2", spec: correctionOf(w) }]);
    const [u1b, u1c, v, w2] = ["U1b", "U1c", "V", "W2"].map((title) => r.byTitle(title)) as [string, string, string, string];
    const head = applyPassingChange(r.h.repoPath, "feature/corrections");
    for (const taskId of [u1b, u1c, v, w2]) r.execute(taskId, { status: "SUCCEEDED", head });
    const accept = { u1: await r.acceptanceOf(u1), u1b: await r.acceptanceOf(u1b), w: await r.acceptanceOf(w) };
    const foreign = r.h.cp.tasks.submit(r.holderRunId, [{ key: "X", title: "X", category: "implementation" }]);
    if (!foreign.allowed) throw new Error(foreign.message);
    const x = foreign.value[0]!;

    expect(refusal(await r.register(u1b, { taskId: u1b, acceptanceDigest: accept.u1b }))).toBe("CORRECTION_SELF_REFERENCE");
    expect(await r.register(v, { taskId: u1, acceptanceDigest: accept.u1 })).toMatchObject({ ok: false, evidence: { refusal: "CORRECTION_ACROSS_WORK_UNITS", workUnit: "unit1", correctionWorkUnit: "unit2" } });
    expect(await r.register(u1b, { taskId: x.taskId, acceptanceDigest: accept.u1 })).toMatchObject({ ok: false, reasonCode: ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE, evidence: { refusal: "CORRECTION_ACROSS_RUNS", taskRunId: r.holderRunId } });
    // The relation must be the one the correction's PLAN declared: V names U1, not W.
    expect(refusal(await r.register(v, { taskId: w, acceptanceDigest: accept.w }))).toBe("CORRECTION_NOT_DECLARED");
    expect(r.records()).toEqual([]);

    expect(await r.register(u1b, { taskId: u1, acceptanceDigest: accept.u1 })).toMatchObject({ ok: true, value: { registered: true } });
    // Two corrections claiming one task, and one correction claiming a second task.
    expect(await r.register(u1c, { taskId: u1, acceptanceDigest: accept.u1 })).toMatchObject({ ok: false, evidence: { refusal: "CORRECTION_DUPLICATE", registeredCorrectionTaskId: u1b } });
    expect(await r.register(u1b, { taskId: w, acceptanceDigest: accept.w })).toMatchObject({ ok: false, evidence: { refusal: "CORRECTION_DUPLICATE", registeredTaskId: u1 } });
    // U1 corrects U1b would close the cycle U1b → U1 → U1b.
    expect(refusal(await r.register(u1, { taskId: u1b, acceptanceDigest: accept.u1b }))).toBe("CORRECTION_CYCLE");
    expect(r.records()).toHaveLength(1);

    // A stale owner is refused by the owner fence and records nothing; the run's current owner registers.
    const stale = r.takeOver();
    const refused = await r.register(w2, { taskId: w, acceptanceDigest: accept.w }, stale);
    expect(refused["ok"]).toBe(false);
    expect([ReasonCode.RUN_OWNER_REVOKED, ReasonCode.BINDING_GENERATION_STALE, ReasonCode.MCP_PEER_UNAUTHENTICATED]).toContain(refused["reasonCode"]);
    expect(r.records()).toHaveLength(1);
    expect(await r.register(w2, { taskId: w, acceptanceDigest: accept.w })).toMatchObject({ ok: true, value: { registered: true } });
    expect(r.h.cp.tasks.completeness(r.runId)).toMatchObject({ allowed: true, value: { settledByCorrection: [{ taskId: u1, correctionTaskId: u1b }, { taskId: w, correctionTaskId: w2 }] } });

    // Completeness reads the tasks as they are, not the record alone: a correction no longer SUCCEEDED
    // leaves its task blocking again.
    r.h.cp.db.run(`UPDATE tasks SET state = 'FAILED' WHERE task_id = ?`, [u1b]);
    expect(r.h.cp.tasks.completeness(r.runId)).toMatchObject({
      allowed: false, reasonCode: ReasonCode.TASK_RESULT_COUNT_MISMATCH,
      evidence: { unfinished: [{ taskId: u1, state: TaskState.FAILED }, { taskId: u1b, state: TaskState.FAILED }] },
    });
  });

  it("a run with no approved work units cannot register a correction: the same work unit is unproven", async () => {
    const h = makeHarness();
    const { projectId, repositoryId } = await registerFixtureProject(h, "plain-project");
    bindCeo(h);
    const created = h.cp.runs.create({ projectId, executionMode: ExecutionMode.STANDARD, contract: CONTRACT, repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }] });
    if (!created.allowed) throw new Error(created.message);
    const run = await h.cp.runs.dispatch(created.value.runId);
    if (!run.allowed) throw new Error(run.message);
    const runId = run.value.runId;
    const submitted = h.cp.tasks.submit(runId, [{ key: "A", title: "A", category: "implementation", spec: failedSpec }]);
    if (!submitted.allowed) throw new Error(submitted.message);
    const a = submitted.value[0]!;
    const followUp = h.cp.tasks.submit(runId, [{ key: "B", title: "B", category: "implementation", spec: correctionOf(a.taskId) }]);
    if (!followUp.allowed) throw new Error(followUp.message);
    const answer = h.cp.tasks.registerCorrection({
      runId, correctionTaskId: followUp.value[0]!.taskId,
      corrects: { taskId: a.taskId, acceptanceDigest: "sha256:".padEnd(71, "0") },
      owner: { sessionId: run.value.ownerSessionId!, bindingGeneration: run.value.ownerBindingGeneration! },
    });
    expect(answer).toMatchObject({ allowed: false, evidence: { refusal: "CORRECTION_WORK_UNIT_UNPROVEN", workUnit: null, correctionWorkUnit: null } });
    expect(h.cp.audit.byKind(TASK_CORRECTION_REGISTERED)).toEqual([]);
  });
});
