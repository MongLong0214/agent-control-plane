import { afterAll, describe, expect, it } from "vitest";

import { createBootstrapGitHubWritePort } from "../../src/bootstrap/bootstrap-write-guard.ts";
import { ExecutionMode, RunKind, TaskState } from "../../src/domain/types.ts";
import type { GitHubClient } from "../../src/github/github-kernel.ts";
import { suspectEdges, type TaskSpec } from "../../src/run/task-graph.ts";
import { callCtoToolAsOwner } from "../helpers/bootstrap-plan.ts";
import { cleanupTempDirs, gitSync, tempDir } from "../helpers/fixtures.ts";
import { bindCeo, makeHarness, registerFixtureProject, type Harness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * #1458 — plan_submit classifies each submitted dependsOn edge across which nothing reaches the dependent
 * through its checkout: CROSS_REPOSITORY (sound) or DISJOINT_PATHS (a heuristic), and counts the edges it
 * cannot judge. The answer is advisory: every graph here is accepted exactly as before, with the same tasks,
 * dependencies and readiness.
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
const PRIMARY = "github:acme/fixture";
const SECOND = "github:acme/second";
let seq = 0;

type Answer = Awaited<ReturnType<typeof callCtoToolAsOwner>>;
interface Suspect {
  edges: Array<{ task: string; dependsOn: string; kind: string }>;
  omitted: number;
  unjudged: number;
}

const suspectOf = (answer: Answer): Suspect | undefined =>
  (answer.body["evidence"] as { suspectEdges?: Suspect } | undefined)?.suspectEdges;

/** A task whose spec declares `writeTarget` (none when null), after the tasks named in `dependsOn`. */
const task = (key: string, writeTarget: Record<string, unknown> | null, dependsOn: string[] = []) => ({
  key, title: key, category: "implementation" as const, dependsOn, spec: writeTarget === null ? {} : { writeTarget },
});

/** The run's graph as readiness sees it: each task's state and the titles it depends on. */
const graphOf = (h: Harness, runId: string) => {
  const tasks = h.cp.tasks.list(runId);
  const titleOf = new Map(tasks.map((t) => [t.taskId, t.title]));
  return Object.fromEntries(tasks.map((t) => [t.title, { state: t.state, dependsOn: t.dependsOn.map((id) => titleOf.get(id)).sort() }]));
};

const suspectTelemetry = (h: Harness, runId: string) =>
  h.cp.db.all<{ value_num: number; dims_json: string }>(
    `SELECT value_num, dims_json FROM telemetry_metrics WHERE run_id = ? AND scope = 'graph' AND name = 'suspect_edge_count' ORDER BY rowid`,
    [runId],
  ).map((row) => ({ value: row.value_num, dims: JSON.parse(row.dims_json) as Record<string, unknown> }));

/** A dispatched STANDARD run; `second` adds a second repository to the project and the run. */
const runOf = async (options: { second?: boolean } = {}) => {
  const h = makeHarness();
  const projectId = `edges-${++seq}`;
  const { repositoryId } = await registerFixtureProject(h, projectId, options.second
    ? { repositories: [{ role: "primary", remote: PRIMARY, manifestRoot: "." }, { role: "secondary", remote: SECOND, manifestRoot: "." }] }
    : {});
  const repositories = [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }];
  if (options.second) {
    const clone = tempDir("acp-1458-second-");
    gitSync(h.repoPath, ["clone", "-q", "--no-local", h.repoPath, clone]);
    gitSync(clone, ["remote", "remove", "origin"]);
    const registered = await h.cp.repositories.register({ checkoutPath: clone, projectId, repositoryRole: "secondary", identity: SECOND });
    if (!registered.allowed) throw new Error(registered.message);
    repositories.push({ repositoryId: registered.value.repositoryId, repositoryRole: "secondary", baseBranch: "dev" });
  }
  bindCeo(h);
  const created = h.cp.runs.create({ projectId, executionMode: ExecutionMode.STANDARD, contract: CONTRACT, repositories });
  if (!created.allowed) throw new Error(created.message);
  const runId = created.value.runId;
  const dispatched = await h.cp.runs.dispatch(runId);
  if (!dispatched.allowed) throw new Error(dispatched.message);
  const plan = (tasks: Array<Record<string, unknown>>, body: Record<string, unknown> = { summary: "graph" }) =>
    callCtoToolAsOwner(h, runId, "plan_submit", { idempotencyKey: `edges-${++seq}`, runId, plan: body, tasks });
  return { h, runId, plan };
};

describe("#1458 — plan_submit reports the dependsOn edges across which nothing flows", () => {
  it("a two-repository run: B in the second repository after A in the first is CROSS_REPOSITORY; C with no writeTarget is unjudged; the telemetry row carries the counts", async () => {
    const { h, runId, plan } = await runOf({ second: true });
    const answer = await plan([
      task("A", { repositoryIdentity: PRIMARY, paths: ["src/a.ts"] }),
      task("B", { repositoryIdentity: SECOND, paths: ["src/a.ts"] }, ["A"]),
      task("C", null, ["A"]),
    ]);
    expect(answer.body, answer.text).toMatchObject({ ok: true, reasonCode: "OK" });
    expect(suspectOf(answer)).toEqual({ edges: [{ task: "B", dependsOn: "A", kind: "CROSS_REPOSITORY" }], omitted: 0, unjudged: 1 });
    expect(graphOf(h, runId)).toEqual({
      A: { state: TaskState.READY, dependsOn: [] },
      B: { state: TaskState.PENDING, dependsOn: ["A"] },
      C: { state: TaskState.PENDING, dependsOn: ["A"] },
    });
    expect(suspectTelemetry(h, runId)).toEqual([{ value: 1, dims: { crossRepository: 1, disjointPaths: 0, unjudged: 1 } }]);
  });

  it("one repository: src/a.ts then docs/b.md is DISJOINT_PATHS; a directory and a file inside it is not listed", async () => {
    const { h, runId, plan } = await runOf();
    const answer = await plan([
      task("A", { paths: ["src/a.ts"] }),
      task("B", { paths: ["docs/b.md"] }, ["A"]),
      task("D", { paths: ["src"] }),
      task("E", { paths: ["src/a.ts"] }, ["D"]),
    ]);
    expect(answer.body, answer.text).toMatchObject({ ok: true });
    expect(suspectOf(answer)).toEqual({ edges: [{ task: "B", dependsOn: "A", kind: "DISJOINT_PATHS" }], omitted: 0, unjudged: 0 });
    expect(graphOf(h, runId)).toEqual({
      A: { state: TaskState.READY, dependsOn: [] },
      B: { state: TaskState.PENDING, dependsOn: ["A"] },
      D: { state: TaskState.READY, dependsOn: [] },
      E: { state: TaskState.PENDING, dependsOn: ["D"] },
    });
    expect(suspectTelemetry(h, runId)).toEqual([{ value: 1, dims: { crossRepository: 0, disjointPaths: 1, unjudged: 0 } }]);
  });

  it("a dependency on an existing task, named by its title, is judged from that task's stored spec, through a superseding PLAN", async () => {
    const { h, runId, plan } = await runOf();
    const first = await plan([task("A", { paths: ["src/a.ts"] }), task("X", { paths: ["src/x.ts"] })]);
    expect(first.body, first.text).toMatchObject({ ok: true });
    expect(suspectOf(first)).toEqual({ edges: [], omitted: 0, unjudged: 0 });
    const x = h.cp.tasks.list(runId).find((t) => t.title === "X")!.taskId;

    const second = await plan(
      [task("B", { paths: ["docs/b.md"] }, ["A"]), task("C", { paths: ["src/a.ts"] }, ["A"])],
      { summary: "graph 2", supersedesTaskIds: [x] },
    );
    expect(second.body, second.text).toMatchObject({ ok: true });
    expect(suspectOf(second)).toEqual({ edges: [{ task: "B", dependsOn: "A", kind: "DISJOINT_PATHS" }], omitted: 0, unjudged: 0 });
    expect(graphOf(h, runId)).toEqual({
      A: { state: TaskState.READY, dependsOn: [] },
      X: { state: TaskState.CANCELLED, dependsOn: [] },
      B: { state: TaskState.PENDING, dependsOn: ["A"] },
      C: { state: TaskState.PENDING, dependsOn: ["A"] },
    });
  });

  it("at most 50 edges are listed; the rest are counted in omitted, and the telemetry counts them all", async () => {
    const { h, runId } = await runOf({ second: true });
    const specs: TaskSpec[] = [
      task("A", { repositoryIdentity: PRIMARY, paths: ["src/a.ts"] }),
      ...Array.from({ length: 53 }, (_, i) => task(`B${i}`, { repositoryIdentity: SECOND, paths: ["src/b.ts"] }, ["A"])),
    ];
    const submitted = h.cp.tasks.submit(runId, specs);
    if (!submitted.allowed) throw new Error(submitted.message);
    expect(submitted.value).toHaveLength(54);
    const suspect = submitted.evidence["suspectEdges"] as Suspect;
    expect(suspect.edges).toHaveLength(50);
    expect(suspect.edges[0]).toEqual({ task: "B0", dependsOn: "A", kind: "CROSS_REPOSITORY" });
    expect(suspect).toMatchObject({ omitted: 3, unjudged: 0 });
    expect(suspectTelemetry(h, runId)).toEqual([{ value: 53, dims: { crossRepository: 53, disjointPaths: 0, unjudged: 0 } }]);
  });

  it("a Repo Factory project's work-unit PLAN carries the classification beside its GitHub tracking", async () => {
    const identity = "github:acme/units";
    // GitHub is unreachable: tracking is reported beside the accepted PLAN and never undoes it.
    const offline: GitHubClient = { request: () => Promise.reject(new Error("GitHub is offline in this test")) };
    const h = makeHarness({ repoFactory: { workRoot: tempDir("acp-1458-rf-"), githubPort: createBootstrapGitHubWritePort(offline, async () => ({ exitCode: 0, stdout: "", stderr: "" })) } });
    const project = await registerFixtureProject(h, "edges-units", {}, { identity });
    bindCeo(h);
    const created = h.cp.runs.create({ projectId: project.projectId, kind: RunKind.STANDARD_WORK, executionMode: ExecutionMode.SIMPLE, contract: CONTRACT, repositories: [{ repositoryId: project.repositoryId, repositoryRole: "primary", baseBranch: "dev" }] });
    if (!created.allowed) throw new Error(created.message);
    const runId = created.value.runId;
    const dispatched = await h.cp.runs.dispatch(runId);
    if (!dispatched.allowed) throw new Error(dispatched.message);
    // The project's provisioning row, as activation leaves it; it belongs to another run of the project.
    const holder = h.cp.runs.create({ projectId: project.projectId, kind: RunKind.STANDARD_WORK, executionMode: ExecutionMode.SIMPLE, contract: CONTRACT, repositories: [] });
    if (!holder.allowed) throw new Error(holder.message);
    h.cp.db.run(
      `INSERT INTO resident_project_provisioning(run_id,project_id,binding_json,allocation_json,confirmation_json,steps_json,status,updated_at)
       VALUES (?,?,'{}',?,'{}','{}','COMPLETE',?)`,
      [holder.value.runId, project.projectId, JSON.stringify({ projectId: project.projectId, repositoryIdentity: identity, repositoryNodeId: "R_kgDOunitsrepo" }), h.clock.nowIso()],
    );

    const answer = await callCtoToolAsOwner(h, runId, "plan_submit", {
      idempotencyKey: `edges-${++seq}`,
      runId,
      plan: { summary: "units", workUnits: [{ key: "lint", tasks: ["A", "B"], issue: { new: { title: "Plan lint", body: "Report empty edges" } }, milestone: { number: 1 } }] },
      tasks: [task("A", { paths: ["src/a.ts"] }), task("B", { paths: ["docs/b.md"] }, ["A"])],
    });
    expect(answer.body, answer.text).toMatchObject({ ok: true, evidence: { githubTracking: { tracked: false } } });
    expect(suspectOf(answer)).toEqual({ edges: [{ task: "B", dependsOn: "A", kind: "DISJOINT_PATHS" }], omitted: 0, unjudged: 0 });
    expect(graphOf(h, runId)).toEqual({
      A: { state: TaskState.READY, dependsOn: [] },
      B: { state: TaskState.PENDING, dependsOn: ["A"] },
    });
  });
});

describe("#1458 — suspectEdges", () => {
  const spec = (key: string, writeTarget: unknown, dependsOn: string[] = []): TaskSpec => ({
    key, title: key, category: "implementation", dependsOn, spec: writeTarget === undefined ? {} : { writeTarget },
  });
  const one = [PRIMARY];
  const two = [PRIMARY, SECOND];

  it("a path that only shares a string prefix is disjoint; an equal path or a directory holding the other end's path is not, in either direction", () => {
    expect(suspectEdges([spec("A", { paths: ["src/a"] }), spec("B", { paths: ["src/ab.ts"] }, ["A"])], [], one))
      .toEqual({ edges: [{ task: "B", dependsOn: "A", kind: "DISJOINT_PATHS" }], unjudged: 0 });
    for (const [a, b] of [[["src/a.ts"], ["src/a.ts"]], [["src/a.ts"], ["src"]], [["src"], ["src/x/y.ts"]], [["docs/a.md", "src/a.ts"], ["lib/c.ts", "src/a.ts"]]]) {
      expect(suspectEdges([spec("A", { paths: a }), spec("B", { paths: b }, ["A"])], [], one), JSON.stringify([a, b]))
        .toEqual({ edges: [], unjudged: 0 });
    }
  });

  it("an end resolves to its writeTarget's repository or the run's only one; ends in different repositories are CROSS_REPOSITORY whatever their paths", () => {
    expect(suspectEdges([spec("A", { repositoryIdentity: PRIMARY, paths: ["src/a.ts"] }), spec("B", { paths: ["docs/b.md"] }, ["A"])], [], one))
      .toEqual({ edges: [{ task: "B", dependsOn: "A", kind: "DISJOINT_PATHS" }], unjudged: 0 });
    expect(suspectEdges([spec("A", { repositoryIdentity: PRIMARY }), spec("B", { repositoryIdentity: SECOND }, ["A"])], [], two))
      .toEqual({ edges: [{ task: "B", dependsOn: "A", kind: "CROSS_REPOSITORY" }], unjudged: 0 });
  });

  it("an end with no resolvable repository or paths is counted, not listed", () => {
    const unresolved: unknown[] = [
      undefined,
      "src/a.ts",
      { paths: [] },
      { paths: ["src/"] },
      { paths: ["../a.ts"] },
      { paths: ["/abs/a.ts"] },
      { paths: [7] },
      { repositoryIdentity: "github:acme/elsewhere", paths: ["docs/b.md"] },
      { repositoryIdentity: 7, paths: ["docs/b.md"] },
    ];
    for (const writeTarget of unresolved) {
      expect(suspectEdges([spec("A", { paths: ["src/a.ts"] }), spec("B", writeTarget, ["A"])], [], one), JSON.stringify(writeTarget))
        .toEqual({ edges: [], unjudged: 1 });
    }
    // Two repositories and no repositoryIdentity: the control plane does not pick one.
    expect(suspectEdges([spec("A", { repositoryIdentity: PRIMARY, paths: ["src/a.ts"] }), spec("B", { paths: ["docs/b.md"] }, ["A"])], [], two))
      .toEqual({ edges: [], unjudged: 1 });
  });

  it("a dependency names a key of the submission before an existing task's title, and an existing task by its stored spec", () => {
    const existing = [{ title: "A", spec: { writeTarget: { paths: ["docs/b.md"] } } }, { title: "Z", spec: { writeTarget: { paths: ["src/z.ts"] } } }];
    expect(suspectEdges([spec("A", { paths: ["src/a.ts"] }), spec("B", { paths: ["docs/b.md"] }, ["A", "Z"])], existing, one)).toEqual({
      edges: [{ task: "B", dependsOn: "A", kind: "DISJOINT_PATHS" }, { task: "B", dependsOn: "Z", kind: "DISJOINT_PATHS" }],
      unjudged: 0,
    });
    expect(suspectEdges([spec("B", { paths: ["docs/b.md"] }, ["A"])], existing, one)).toEqual({ edges: [], unjudged: 0 });
  });
});
