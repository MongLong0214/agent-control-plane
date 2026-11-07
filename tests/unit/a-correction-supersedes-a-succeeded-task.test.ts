import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { createBootstrapGitHubWritePort } from "../../src/bootstrap/bootstrap-write-guard.ts";
import { sha256 } from "../../src/core/digest.ts";
import { acpError } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ExecutionMode, RunKind, TaskState } from "../../src/domain/types.ts";
import type { GitHubClient } from "../../src/github/github-kernel.ts";
import { TASK_CORRECTION_REGISTERED } from "../../src/run/task-graph.ts";
import type { StartsFrom } from "../../src/run/task-write-target.ts";
import { WorkerTurnEvent, workerSuccessDigest } from "../../src/run/worker-turn.ts";
import { callCtoTool } from "../helpers/cto-tool.ts";
import { cleanupTempDirs, commitAll, gitSync, tempDir, writeFiles } from "../helpers/fixtures.ts";
import { bindCeo, bindWorker, makeHarness, registerFixtureProject, type Harness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);
afterEach(() => vi.restoreAllMocks());

/**
 * CEO msg_8f666e55 — a SUCCEEDED task superseded by a correction: once the run's owner registers the relation
 * with task_correction_register (the correction's PLAN spec names the task in correctionOf.taskId), the
 * candidate freeze counts only the correction. A chain U2a <- U2b <- U2c contributes U2c alone. The live case
 * (myeotnyeon, run_e2e06bf03825473b814a5070): U2a, U2b and U2c SUCCEEDED on the same paths, each branched at
 * the pinned base, and result_submit's freeze refused CONFLICT on the path-level check.
 *
 * Over the real control plane, CTO MCP tools and freeze, with a Repo Factory project whose work units are
 * linked on an in-memory GitHub (read only). Worker receipts are seeded the way #1268 slice 1 seeds them:
 * the write target, the commit on its task branch, startExecution, finishExecution and the SUCCEEDED row.
 */

const OWNER = "acme";
const NAME = "fixture";
const IDENTITY = `github:${OWNER}/${NAME}`;
const SECOND = `github:${OWNER}/second`;
const NODE = "R_kgDOprojectrepo";
const ROOT = `repos/${OWNER}/${NAME}`;
const API = "https://api.github.com";
const PATH = "pipeline/qa/gates.py";

/** The project's repository on GitHub: one milestone holding issue #1. Nothing is created here. */
class LinkedRepository implements GitHubClient {
  readonly milestone = { number: 1, node_id: "MI_1", title: "Repo migration", description: "", url: `${API}/${ROOT}/milestones/1`, state: "open" };
  readonly issues = [{
    number: 1, node_id: "I_1", title: "Migration unit 2", body: "", state: "open", labels: [],
    milestone: { number: 1, node_id: "MI_1", url: `${API}/${ROOT}/milestones/1`, title: "Repo migration" },
    repository_url: `${API}/${ROOT}`,
  }];

  async request<T>(method: string, path: string): Promise<T> {
    const [route, query] = path.split("?");
    if (method !== "GET") throw new Error(`unexpected request ${method} ${path}`);
    if (route === ROOT) return { node_id: NODE, full_name: `${OWNER}/${NAME}`, visibility: "public", private: false, default_branch: "dev", description: null } as T;
    const first = Number(new URLSearchParams(query ?? "").get("page") ?? "1") === 1;
    if (route === `${ROOT}/milestones`) return (first ? [this.milestone] : []) as T;
    if (route === `${ROOT}/issues`) return (first ? this.issues : []) as T;
    if (route === `${ROOT}/issues/1`) return this.issues[0] as T;
    if (route === `${ROOT}/milestones/1`) return this.milestone as T;
    throw acpError(ReasonCode.INTERNAL_ERROR, `gh api GET ${path} failed: (HTTP 404)`, { status: 404, method, path });
  }
}

const CONTRACT = { goal: "move the QA gates", why: "pipeline/qa is independent", scope: [PATH], nonGoals: [], acceptance: ["the QA tests pass"], priority: "NORMAL" as const, humanGate: [], references: [] };
const UNIT = { key: "unit2-qa", issue: { number: 1 }, milestone: { number: 1 } };
const correctionOf = (taskId: string) => ({ correctionOf: { taskId, failure: "the CTO re-run failed", fix: "fix it and change nothing else" } });
let seq = 0;

/** A dispatched STANDARD_WORK run of a Repo Factory project; its holder run is another run of the same project. */
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
  const owner = { sessionId: run.ownerSessionId!, incarnation: h.cp.sessions.get(run.ownerSessionId!)!.incarnation };
  const repo = h.repoPath;
  const base = gitSync(repo, ["rev-parse", "dev"]);
  const call = (name: string, args: Record<string, unknown>) => callCtoTool(h, owner, name, { idempotencyKey: `sup-${++seq}`, runId, ...args });
  const byTitle = (title: string) => h.cp.tasks.list(runId).find((task) => task.title === title)!.taskId;
  /** One PLAN: the unit holds the tasks already planned and the new ones, by key. */
  const plan = async (tasks: Array<{ key: string; spec?: Record<string, unknown>; dependsOn?: string[] }>) => {
    const planned = h.cp.tasks.list(runId).map((task) => task.taskId);
    const answer = await call("plan_submit", {
      plan: { summary: "migration unit 2", workUnits: [{ ...UNIT, tasks: [...planned, ...tasks.map((task) => task.key)] }] },
      tasks: tasks.map((task) => ({ key: task.key, title: task.key, category: "implementation", spec: task.spec ?? {}, ...(task.dependsOn ? { dependsOn: task.dependsOn } : {}) })),
    });
    expect(answer, JSON.stringify(answer).slice(0, 600)).toMatchObject({ ok: true });
    return tasks.map((task) => byTitle(task.key));
  };
  /**
   * One SUCCEEDED turn of `taskId`: its branch at the pinned base (or at `startsFrom`, #1242), its write target,
   * its commit of `content` at PATH (or of `files`), and the receipt naming it. `repositoryId` puts the execution
   * in another repository.
   */
  const succeed = (taskId: string, content: string, options: { files?: Record<string, string>; startsFrom?: StartsFrom; repositoryId?: string } = {}) => {
    const branch = `task/${taskId}`;
    const files = options.files ?? { [PATH]: content };
    gitSync(repo, ["checkout", "-q", "-B", branch, options.startsFrom?.commit ?? base]);
    const writeTarget = { repositoryIdentity: IDENTITY, branch, paths: Object.keys(files), declaredParent: "dev", baseSha: base, ...(options.startsFrom ? { startsFrom: options.startsFrom } : {}) };
    h.cp.audit.record({ kind: "TASK_WRITE_TARGET_RECORDED", runId, evidence: { taskId, writeTarget } });
    writeFiles(repo, files);
    const commit = commitAll(repo, `${taskId}: ${content}`);
    const workerSessionId = bindWorker(h, taskId);
    const opened = h.cp.tasks.startExecution({ runId, taskId, ownerBindingGeneration: h.cp.runs.require(runId).ownerBindingGeneration!, workerSessionId, provider: "scripted", model: "scripted-worker", repositoryId: options.repositoryId ?? project.repositoryId });
    if (!opened.allowed) throw new Error(`${opened.reasonCode}: ${opened.message}`);
    const inputs = {
      executionId: opened.value.executionId, workerSessionId, sessionIncarnation: h.cp.sessions.get(workerSessionId)!.incarnation,
      providerSessionId: "scripted-session", exitCode: 0, stdoutSha256: sha256(""), commitHead: commit, diffDigest: "sha256:stand-in-diff",
    };
    const resultDigest = workerSuccessDigest(inputs);
    const closed = h.cp.tasks.finishExecution(opened.value.executionId, { status: "SUCCEEDED", resultDigest }, runId);
    if (!closed.allowed) throw new Error(`${closed.reasonCode}: ${closed.message}`);
    h.cp.audit.record({ kind: WorkerTurnEvent.SUCCEEDED, runId, sessionId: workerSessionId, evidence: { ...inputs, resultDigest, taskId, head: base, paths: Object.keys(files), commitlore: { outcome: "empty", recordIds: [], nonce: null } } });
    return { commit, executionId: opened.value.executionId };
  };
  const acceptanceOf = async (taskId: string): Promise<string> => {
    const answer = await call("contract_get", {});
    return ((answer["value"] as { tasks: Array<{ taskId: string; acceptanceDigest: string }> }).tasks).find((t) => t.taskId === taskId)!.acceptanceDigest;
  };
  /** The relation `correction` corrects `original`, with the acceptance contract_get answers for it (or `acceptanceDigest`). */
  const register = async (correction: string, original: string, acceptanceDigest?: string) =>
    call("task_correction_register", { taskId: correction, corrects: { taskId: original, acceptanceDigest: acceptanceDigest ?? await acceptanceOf(original) } });
  const records = () => h.cp.audit.byKind(TASK_CORRECTION_REGISTERED);
  const freeze = () => h.cp.pipeline.freeze(runId);
  /** The base #1242 builds for `taskId` from the SUCCEEDED tasks it depends on. */
  const predecessorBase = (taskId: string, predecessors: string[]) =>
    h.cp.pipeline.predecessorBase({ runId, taskId, predecessors, repositoryIdentity: IDENTITY, checkoutPath: repo, baseSha: base });
  /** What a supersession must leave as it was: the task, its executions and its receipts. */
  const rowsOf = (taskId: string) => ({
    task: h.cp.db.get(`SELECT * FROM tasks WHERE task_id = ?`, [taskId]),
    executions: h.cp.db.all(`SELECT * FROM task_executions WHERE task_id = ? ORDER BY attempt`, [taskId]),
    receipts: h.cp.audit.byKind(WorkerTurnEvent.SUCCEEDED).filter((row) => row.evidence["taskId"] === taskId),
  });
  return { h, project, runId, holderRunId: holder.value.runId, repo, base, plan, succeed, register, records, freeze, predecessorBase, rowsOf };
};
type Run = Awaited<ReturnType<typeof governedRun>>;

/** The live chain: U2a, then U2b correcting it, then U2c correcting U2b, each branched at the base, all on PATH. */
const liveChain = async (r: Run) => {
  const [u2a] = await r.plan([{ key: "U2a" }]);
  const a = r.succeed(u2a!, "U2a");
  const [u2b] = await r.plan([{ key: "U2b", spec: correctionOf(u2a!) }]);
  const b = r.succeed(u2b!, "U2b");
  const [u2c] = await r.plan([{ key: "U2c", spec: correctionOf(u2b!) }]);
  const c = r.succeed(u2c!, "U2c");
  // The checkout is left where U2a's turn left it, so the freeze integrates rather than taking HEAD.
  gitSync(r.repo, ["checkout", "-q", `task/${u2a!}`]);
  return { u2a: u2a!, u2b: u2b!, u2c: u2c!, a, b, c };
};

const refusal = (answer: Record<string, unknown>) => (answer["evidence"] as { refusal?: string } | undefined)?.refusal;
const conflictPairs = (evidence: unknown) => ((evidence as { conflicts?: Array<{ tasks: string[] }> }).conflicts ?? []).map((conflict) => [...conflict.tasks].sort());

describe("CEO msg_8f666e55 — a SUCCEEDED task superseded by a registered correction: the freeze counts only the correction", () => {
  it("the live case: U2a <- U2b <- U2c on one path is refused CONFLICT; registered, the freeze holds U2c alone; U2a and U2b stay SUCCEEDED and readable", async () => {
    const r = await governedRun();
    const { u2a, u2b, u2c, c } = await liveChain(r);

    // The live refusal, reproduced: every pair changes PATH and none is built on another.
    const refused = await r.freeze();
    expect(refused).toMatchObject({ allowed: false, reasonCode: ReasonCode.CONFLICT });
    expect(conflictPairs(refused.evidence)).toEqual(expect.arrayContaining([[u2a, u2b].sort(), [u2b, u2c].sort(), [u2a, u2c].sort()]));

    const before = { u2a: r.rowsOf(u2a), u2b: r.rowsOf(u2b) };
    expect(await r.register(u2b, u2a), "U2a -> U2b").toMatchObject({ ok: true, value: { registered: true, correction: { originalTaskId: u2a, correctionTaskId: u2b, workUnit: UNIT.key } } });
    // Half a chain is still two tasks on one path: U2b and U2c.
    const half = await r.freeze();
    expect(half).toMatchObject({ allowed: false, reasonCode: ReasonCode.CONFLICT });
    expect(conflictPairs(half.evidence)).toEqual([[u2b, u2c].sort()]);

    expect(await r.register(u2c, u2b), "U2b -> U2c").toMatchObject({ ok: true, value: { registered: true, correction: { originalTaskId: u2b, correctionTaskId: u2c } } });
    expect(r.records()[1]!.evidence).toMatchObject({
      supersedes: { repositoryIdentity: IDENTITY, original: { taskId: u2b, commitHead: expect.any(String) }, correction: { taskId: u2c, commitHead: c.commit, executionId: c.executionId } },
    });

    const frozen = await r.freeze();
    expect(frozen.allowed, JSON.stringify(frozen).slice(0, 800)).toBe(true);
    if (!frozen.allowed) return;
    const [repository] = frozen.value.repositories;
    expect(repository!.integration?.tasks).toEqual([{ taskId: u2c, commit: c.commit }]);
    expect(repository!.candidateHead).toBe(c.commit);
    expect(gitSync(r.repo, ["show", `${repository!.candidateHead}:${PATH}`])).toBe("U2c");

    // The superseded tasks, their executions and receipts are as they were.
    expect({ u2a: r.rowsOf(u2a), u2b: r.rowsOf(u2b) }).toEqual(before);
    expect(before.u2a.task).toMatchObject({ state: TaskState.SUCCEEDED });
    expect(before.u2b.receipts).toHaveLength(1);
  });

  it("refused: a correction that is not SUCCEEDED, one in another repository, one whose spec does not name the task, a branch either way, another run and a cycle; the same relation again is one record", async () => {
    const r = await governedRun();
    const second = tempDir("acp-supersede-second-");
    gitSync(r.repo, ["clone", "-q", "--no-local", r.repo, second]);
    gitSync(second, ["remote", "remove", "origin"]);
    const registered = await r.h.cp.repositories.register({ checkoutPath: second, projectId: r.project.projectId, repositoryRole: "secondary", identity: SECOND });
    if (!registered.allowed) throw new Error(registered.message);

    const { u2a, u2b, u2c } = await liveChain(r);
    const [pending, elsewhere, undeclared, rival] = await r.plan([
      { key: "P", spec: correctionOf(u2a) },
      { key: "R", spec: correctionOf(u2a) },
      { key: "Z", spec: correctionOf(u2a) },
      { key: "X", spec: correctionOf(u2a) },
    ]) as [string, string, string, string];
    r.succeed(elsewhere, "R", { repositoryId: registered.value.repositoryId });
    r.succeed(undeclared, "Z");
    r.succeed(rival, "X");
    const foreign = r.h.cp.tasks.submit(r.holderRunId, [{ key: "Y", title: "Y", category: "implementation" }]);
    if (!foreign.allowed) throw new Error(foreign.message);

    expect(await r.register(pending, u2a)).toMatchObject({ ok: false, reasonCode: ReasonCode.CONFLICT, evidence: { refusal: "CORRECTION_NOT_SUCCEEDED", correctionState: TaskState.READY } });
    expect(await r.register(elsewhere, u2a)).toMatchObject({ ok: false, evidence: { refusal: "CORRECTION_ACROSS_REPOSITORIES" } });
    // Z declares U2a, not U2b.
    expect(refusal(await r.register(undeclared, u2b))).toBe("CORRECTION_NOT_DECLARED");
    expect(r.records()).toEqual([]);

    expect(await r.register(u2b, u2a)).toMatchObject({ ok: true, value: { registered: true } });
    // The same relation again: answered as registered, one record.
    expect(await r.register(u2b, u2a)).toMatchObject({ ok: true, value: { registered: false, correction: { originalTaskId: u2a, correctionTaskId: u2b } } });
    expect(r.records()).toHaveLength(1);
    // Two corrections of one task, and one correction of two tasks.
    expect(await r.register(rival, u2a)).toMatchObject({ ok: false, evidence: { refusal: "CORRECTION_DUPLICATE", registeredCorrectionTaskId: u2b } });
    expect(await r.register(u2b, rival)).toMatchObject({ ok: false, evidence: { refusal: "CORRECTION_DUPLICATE", registeredTaskId: u2a } });
    expect(await r.register(rival, foreign.value[0]!.taskId, `sha256:${"0".repeat(64)}`)).toMatchObject({ ok: false, evidence: { refusal: "CORRECTION_ACROSS_RUNS" } });

    expect(await r.register(u2c, u2b)).toMatchObject({ ok: true, value: { registered: true } });
    // U2a correcting U2c would close U2a <- U2b <- U2c <- U2a.
    expect(refusal(await r.register(u2a, u2c))).toBe("CORRECTION_CYCLE");
    expect(r.records()).toHaveLength(2);
  });

  it("two unrelated SUCCEEDED tasks on one path still conflict, beside a registered supersession", async () => {
    const r = await governedRun();
    const [u2a, unrelated] = await r.plan([{ key: "U2a" }, { key: "W" }]) as [string, string];
    r.succeed(u2a, "U2a");
    r.succeed(unrelated, "W");
    const [u2b] = await r.plan([{ key: "U2b", spec: correctionOf(u2a) }]) as [string];
    r.succeed(u2b, "U2b");
    expect(await r.register(u2b, u2a)).toMatchObject({ ok: true, value: { registered: true } });

    const refused = await r.freeze();
    expect(refused).toMatchObject({ allowed: false, reasonCode: ReasonCode.CONFLICT });
    expect(conflictPairs(refused.evidence)).toEqual([[u2b, unrelated].sort()]);
  });

  it("review r1 P2-1 — a dependent of a superseded task still starts from that task's commit: provisioning reads every SUCCEEDED receipt", async () => {
    const r = await governedRun();
    const [a] = await r.plan([{ key: "A" }]) as [string];
    const first = r.succeed(a, "A");
    const [b, w] = await r.plan([{ key: "B", spec: correctionOf(a) }, { key: "W", dependsOn: ["A"] }]) as [string, string];
    r.succeed(b, "B");
    const before = await r.predecessorBase(w, [a]);
    expect(before, JSON.stringify(before).slice(0, 400)).toMatchObject({ allowed: true, value: { predecessors: [{ taskId: a, commit: first.commit }] } });
    expect(await r.register(b, a)).toMatchObject({ ok: true, value: { registered: true } });

    // A's execution and receipt are as they were, so W's base is too.
    const after = await r.predecessorBase(w, [a]);
    expect(after, JSON.stringify(after).slice(0, 400)).toMatchObject({ allowed: true });
    expect(after.allowed ? after.value : null).toEqual(before.allowed ? before.value : undefined);
  });

  it("review r1 P2-2 — a correction built on the task it supersedes keeps what it inherited; an unrelated change to an inherited path still conflicts", async () => {
    const r = await governedRun();
    const [a] = await r.plan([{ key: "A" }]) as [string];
    const first = r.succeed(a, "", { files: { "one.txt": "A one\n", "two.txt": "A two\n" } });
    const onA: StartsFrom = { commit: first.commit, predecessors: [{ taskId: a, commit: first.commit }] };
    const [b, w] = await r.plan([{ key: "B", spec: correctionOf(a), dependsOn: ["A"] }, { key: "W", dependsOn: ["A"] }]) as [string, string];
    const correction = r.succeed(b, "", { files: { "one.txt": "B one\n" }, startsFrom: onA });
    const dependent = r.succeed(w, "", { files: { "three.txt": "W three\n" }, startsFrom: onA });
    gitSync(r.repo, ["checkout", "-q", `task/${a}`]);
    const tree = (head: string) => Object.fromEntries(["one.txt", "two.txt", "three.txt"].map((path) => [path, gitSync(r.repo, ["show", `${head}:${path}`])]));
    const expected = { "one.txt": "B one", "two.txt": "A two", "three.txt": "W three" };

    const unregistered = await r.freeze();
    expect(unregistered, JSON.stringify(unregistered).slice(0, 600)).toMatchObject({ allowed: true });
    if (!unregistered.allowed) return;
    expect(tree(unregistered.value.repositories[0]!.candidateHead)).toEqual(expected);

    expect(await r.register(b, a)).toMatchObject({ ok: true, value: { registered: true } });
    const frozen = await r.freeze();
    expect(frozen, JSON.stringify(frozen).slice(0, 600)).toMatchObject({ allowed: true });
    if (!frozen.allowed) return;
    const [repository] = frozen.value.repositories;
    expect(tree(repository!.candidateHead)).toEqual(expected);
    expect(repository!.integration?.tasks.map((task) => task.taskId).sort()).toEqual([b, w].sort());
    expect(repository!.integration?.tasks).toEqual(expect.arrayContaining([{ taskId: b, commit: correction.commit }, { taskId: w, commit: dependent.commit }]));

    // two.txt is A's, inherited by B: an unrelated task changing it is a conflict with B, not a silent replacement.
    const [u] = await r.plan([{ key: "U" }]) as [string];
    r.succeed(u, "", { files: { "two.txt": "U two\n" } });
    gitSync(r.repo, ["checkout", "-q", `task/${a}`]);
    const refused = await r.freeze();
    expect(refused).toMatchObject({ allowed: false, reasonCode: ReasonCode.CONFLICT });
    expect(conflictPairs(refused.evidence)).toEqual([[b, u].sort()]);
  });
});
