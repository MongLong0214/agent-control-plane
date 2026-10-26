import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { join } from "node:path";

import { executablePlanOf, planForSubmission } from "../../src/bootstrap/bootstrap-plan.ts";
import { createBootstrapGitHubWritePort } from "../../src/bootstrap/bootstrap-write-guard.ts";
import { type GenesisBundle, parseGenesis } from "../../src/bootstrap/genesis-bundle.ts";
import { workUnitMarkers } from "../../src/bootstrap/work-unit-marker.ts";
import { createGitHubApiWritePort, type GitHubRepositoryTarget } from "../../src/bootstrap/github-write-port.ts";
import { produceRepoFactoryResult } from "../../src/bootstrap/repo-factory-producer.ts";
import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { manifestDigest, projectManifestSchema } from "../../src/contracts/manifest.ts";
import { digestOf } from "../../src/core/digest.ts";
import { ExecutionMode, Role, RunKind, roleKeyFor } from "../../src/domain/types.ts";
import type { GitHubClient } from "../../src/github/github-kernel.ts";
import { callCtoTool } from "../helpers/cto-tool.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { GenesisGitHub, genesisBundle, genesisPlanFixture } from "../helpers/genesis-github.ts";
import { bindCeo, bindWorker, fixtureManifest, makeHarness, registerFixtureProject, type Harness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);
afterEach(() => vi.restoreAllMocks());

/**
 * #1240 (ACP part) — a Repo Factory project's approved work exists on GitHub as linked issues and a
 * milestone, read back from the exact repository, before any of it is admitted to execution.
 *
 * The live counterexample (project myeotnyeon): the repository held only the genesis issue #2
 * "Implement the owner's product intent" in the genesis milestone "First product increment", and the
 * approved execution scope added afterwards as STANDARD_WORK runs with task graphs never reached
 * GitHub, yet its tasks were staffed and executed.
 *
 * Over the real control plane (database, task graph, CTO MCP tools) and the production GitHub write
 * port composed exactly as the daemon composes it (`createBootstrapGitHubWritePort`, its write guard
 * included); only GitHub's REST surface is an in-memory double, so no request leaves the process.
 */

const OWNER = "acme";
const NAME = "fixture";
const IDENTITY = `github:${OWNER}/${NAME}`;
const NODE = "R_kgDOprojectrepo";
const ROOT = `repos/${OWNER}/${NAME}`;
const API = "https://api.github.com";
const REFUSED = "WORK_SCOPE_NOT_TRACKED_ON_GITHUB";

interface Milestone { number: number; node_id: string; title: string; description: string; url: string; state: string }
interface Issue {
  number: number;
  node_id: string;
  title: string;
  body: string;
  state: string;
  labels: Array<{ name: string }>;
  milestone: { number: number; node_id: string; url: string; title: string } | null;
  repository_url: string;
  pull_request?: { url: string };
}

/**
 * GitHub's repository, milestones and issues REST surface for one repository. Pages answer `per_page`
 * items at a time, as GitHub's do; issue numbers are shared with pull requests, which the issues list
 * also carries. Every request is recorded.
 */
class IssuesGitHub implements GitHubClient {
  readonly calls: Array<{ method: string; path: string; body?: unknown }> = [];
  nodeId = NODE;
  readonly milestones: Milestone[] = [];
  readonly issues: Issue[] = [];
  /** The next POST to a path ending with `suffix` fails: "before" sends nothing, "after" loses the answer. */
  fault: { suffix: string; when: "before" | "after"; skip?: number } | null = null;
  /** Lists answer with another repository's items, as a misrouted or reused-name answer would. */
  foreign = false;
  /** GitHub accepts an issue and drops its milestone. */
  dropMilestone = false;
  private next = 1;

  milestoneRef(m: Milestone) {
    return { number: m.number, node_id: m.node_id, url: m.url, title: m.title };
  }

  addMilestone(title: string, description: string): Milestone {
    const number = this.milestones.length + 1;
    const m = { number, node_id: `MI_${number}`, title, description, url: `${API}/${ROOT}/milestones/${number}`, state: "open" };
    this.milestones.push(m);
    return m;
  }

  addIssue(title: string, body: string, milestone: Milestone | null, pull = false): Issue {
    const number = this.next++;
    const issue: Issue = {
      number,
      node_id: `I_${number}`,
      title,
      body,
      state: "open",
      labels: [],
      milestone: milestone ? this.milestoneRef(milestone) : null,
      repository_url: `${API}/${ROOT}`,
      ...(pull ? { pull_request: { url: `${API}/${ROOT}/pulls/${number}` } } : {}),
    };
    this.issues.push(issue);
    return issue;
  }

  posts(suffix: string) {
    return this.calls.filter((c) => c.method === "POST" && c.path.endsWith(suffix));
  }

  async request<T>(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
    this.calls.push({ method, path, ...(body === undefined ? {} : { body }) });
    const [route, query] = path.split("?");
    const params = new URLSearchParams(query ?? "");
    const perPage = Number(params.get("per_page") ?? "30");
    const page = Number(params.get("page") ?? "1");
    const paged = <X>(rows: X[]): X[] => rows.slice((page - 1) * perPage, page * perPage);
    const elsewhere = <X extends object>(rows: X[]): X[] =>
      this.foreign
        ? rows.map((row) => JSON.parse(JSON.stringify(row).replaceAll(`/${ROOT}`, `/repos/${OWNER}/other`)) as X)
        : rows;
    if (method === "GET" && route === ROOT) {
      return { node_id: this.nodeId, full_name: `${OWNER}/${NAME}`, visibility: "public", private: false, default_branch: "dev", description: null } as T;
    }
    if (route === `${ROOT}/labels` && method === "GET") return [] as T;
    if (route === `${ROOT}/milestones` || route === `${ROOT}/issues`) {
      if (method === "GET") {
        return (route.endsWith("/milestones") ? elsewhere(paged(this.milestones)) : elsewhere(paged(this.issues))) as T;
      }
      if (method !== "POST") throw new Error(`unexpected request ${method} ${path}`);
      const matched = this.fault !== null && route.endsWith(this.fault.suffix);
      const faulted = matched && (this.fault!.skip ?? 0) === 0;
      if (matched && !faulted) this.fault!.skip! -= 1;
      if (faulted && this.fault!.when === "before") {
        this.fault = null;
        throw new Error("HTTP 502 before GitHub acted");
      }
      const value = body as Record<string, unknown>;
      let answer: unknown;
      if (route.endsWith("/milestones")) {
        if (this.milestones.some((m) => m.title.toLowerCase() === String(value["title"]).toLowerCase())) {
          throw new Error("Validation Failed: already_exists (HTTP 422)");
        }
        answer = this.addMilestone(String(value["title"]), String(value["description"]));
      } else {
        const milestone = this.dropMilestone ? null : this.milestones.find((m) => m.number === value["milestone"]) ?? null;
        answer = this.addIssue(String(value["title"]), String(value["body"]), milestone);
      }
      if (faulted && this.fault!.when === "after") {
        this.fault = null;
        throw new Error("connection reset after GitHub accepted the request");
      }
      return answer as T;
    }
    throw new Error(`unexpected request ${method} ${path}`);
  }
}

/** The repository as the genesis left myeotnyeon's: one catch-all issue in the one genesis milestone. */
const genesisRepository = (): IssuesGitHub => {
  const github = new IssuesGitHub();
  const stage = github.addMilestone("First product increment", "The first product increment\n<!-- acp-genesis:m1 -->");
  github.addIssue("Bootstrap genesis", "repo-factory:genesis", null, true);
  github.addIssue("Implement the owner's product intent", "Build what the owner asked for\n<!-- acp-genesis:i1 -->", stage);
  return github;
};

const TASKS = [
  { key: "feed", title: "Render the verdict feed", category: "implementation" as const, spec: { goal: "The home screen lists verdicts", acceptance: ["the feed renders ten verdicts"] } },
  { key: "detail", title: "Show one verdict's detail", category: "implementation" as const, spec: {} },
  { key: "docs", title: "Document the feed", category: "docs" as const, dependsOn: [] as string[], spec: {} },
];

interface Governed {
  h: Harness;
  github: IssuesGitHub;
  runId: string;
  projectId: string;
  taskIds: string[];
  owner: { sessionId: string; incarnation: string };
  generation: number;
}

/**
 * A Repo Factory project, as activation leaves one: registered, with its resident provisioning row
 * naming the repository and the node id the genesis receipted; then a dispatched STANDARD_WORK run
 * whose PLAN's tasks are in the graph.
 */
const governedRun = async (
  options: { github?: IssuesGitHub; tasks?: typeof TASKS; provisioned?: boolean } = {},
): Promise<Governed> => {
  const github = options.github ?? genesisRepository();
  const h = makeHarness({
    repoFactory: { workRoot: tempDir("rf-work-"), githubPort: createBootstrapGitHubWritePort(github, async () => ({ exitCode: 0, stdout: "", stderr: "" })) },
  });
  const project = await registerFixtureProject(h, "myeotnyeon", {}, { identity: IDENTITY });
  bindCeo(h);
  const contract = {
    goal: "Ship the verdict feed",
    why: "the owner's next product goal",
    scope: ["src/app.js"],
    nonGoals: [],
    acceptance: ["the feed is live"],
    priority: "NORMAL" as const,
    humanGate: [],
    references: [],
  };
  const created = h.cp.runs.create({
    projectId: project.projectId,
    kind: RunKind.STANDARD_WORK,
    executionMode: ExecutionMode.SIMPLE,
    contract,
    repositories: [{ repositoryId: project.repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
  });
  if (!created.allowed) throw new Error(created.message);
  const runId = created.value.runId;
  const dispatched = await h.cp.runs.dispatch(runId);
  if (!dispatched.allowed) throw new Error(`${dispatched.reasonCode}: ${dispatched.message}`);
  if (options.provisioned !== false) {
    // Recorded after dispatch: the resident CTO already holds the project, as it does once activated.
    // The provisioning row references a run; activation's is the bootstrap run, any run row holds it here.
    const holder = h.cp.runs.create({ projectId: project.projectId, kind: RunKind.STANDARD_WORK, executionMode: ExecutionMode.SIMPLE, contract, repositories: [] });
    if (!holder.allowed) throw new Error(holder.message);
    h.cp.db.run(
      `INSERT INTO resident_project_provisioning(run_id,project_id,binding_json,allocation_json,confirmation_json,steps_json,status,updated_at)
       VALUES (?,?,'{}',?,'{}','{}','COMPLETE',?)`,
      [holder.value.runId, project.projectId, JSON.stringify({ projectId: project.projectId, repositoryIdentity: IDENTITY, repositoryNodeId: NODE }), h.clock.nowIso()],
    );
  }
  const submitted = h.cp.tasks.submit(runId, options.tasks ?? TASKS);
  if (!submitted.allowed) throw new Error(submitted.message);
  const run = h.cp.runs.require(runId);
  return {
    h,
    github,
    runId,
    projectId: project.projectId,
    taskIds: submitted.value.map((task) => task.taskId),
    owner: { sessionId: run.ownerSessionId!, incarnation: h.cp.sessions.get(run.ownerSessionId!)!.incarnation },
    generation: run.ownerBindingGeneration!,
  };
};

/** The CTO's task_worker_provision, as the run's owner calls it over the CTO MCP tools. */
const provision = (g: Governed, taskId: string) =>
  callCtoTool(g.h, g.owner, "task_worker_provision", { idempotencyKey: `provision-${taskId}-${Math.random()}`, runId: g.runId, taskId, provider: "scripted" });

/** The task's WORKER, bound once and reused. */
const workerOf = (g: Governed, taskId: string): string =>
  g.h.cp.bindings.active(roleKeyFor(Role.WORKER, { taskId }))?.sessionId ?? bindWorker(g.h, taskId);

/** The synchronous execution receipt every execution start ends in. */
const startExecution = (g: Governed, taskId: string) =>
  g.h.cp.tasks.startExecution({
    runId: g.runId,
    taskId,
    ownerBindingGeneration: g.generation,
    workerSessionId: workerOf(g, taskId),
    provider: "scripted",
    model: "scripted-worker",
  });

/** The admission-bearing worker start task_worker_run and a started receipt go through. */
const startWorkerExecution = (g: Governed, taskId: string) => {
  vi.spyOn(g.h.cp.tasks, "admitWorkerFanout").mockResolvedValue(allow(ReasonCode.OK, undefined) as never);
  return g.h.cp.tasks.startWorkerExecution({
    runId: g.runId,
    taskId,
    ownerBindingGeneration: g.generation,
    workerSessionId: workerOf(g, taskId),
    provider: "scripted",
    model: "scripted-worker",
  });
};

/** A work-unit marker line naming the task, as Repo Factory's genesis issues carry one. */
const marker = (taskId: string, k = 1, n = 1) => `Work unit ${k} of ${n}: ${taskId}`;
const issueOf = (github: IssuesGitHub, taskId: string) => github.issues.filter((i) => workUnitMarkers(i.body).markers.some((m) => m.key === taskId));
const refusal = (answer: Record<string, unknown>) => ({
  ok: answer["ok"],
  reasonCode: answer["reasonCode"],
  untracked: ((answer["evidence"] as { untracked?: Array<{ taskId: string }> } | undefined)?.untracked ?? []).map((u) => u.taskId).sort(),
});

describe("#1240 — a Repo Factory project's approved work is tracked on GitHub before execution", () => {
  it("the myeotnyeon counterexample: a catch-all genesis issue does not let three untracked tasks reach execution", async () => {
    const g = await governedRun();
    g.github.fault = { suffix: "/milestones", when: "before" };
    // Nothing tracks the approved units on GitHub: an execution receipt is not admitted.
    const receipt = startExecution(g, g.taskIds[2]!);
    expect(receipt.allowed).toBe(false);
    expect(receipt.reasonCode).toBe(REFUSED);
    // GitHub is down for the milestone write: nothing can be tracked, and staffing is not admitted either.
    const refused = await provision(g, g.taskIds[0]!);
    expect(refusal(refused)).toEqual({ ok: false, reasonCode: REFUSED, untracked: [...g.taskIds].sort() });
    expect(g.github.issues.map((i) => i.number)).toEqual([1, 2]);
    expect(g.h.cp.tasks.executions(g.runId)).toEqual([]);

    // GitHub answers again: the same admission synchronizes the approved scope, reads it back, and proceeds.
    const tracked = await provision(g, g.taskIds[0]!);
    expect(tracked["reasonCode"]).not.toBe(REFUSED);
    const goal = g.github.milestones.find((m) => m.description.includes(`<!-- acp-work:goal:${g.runId} -->`))!;
    expect(goal.title).toBe("Ship the verdict feed");
    for (const [index, taskId] of g.taskIds.entries()) {
      const issues = issueOf(g.github, taskId);
      expect(issues).toHaveLength(1);
      expect(issues[0]!.title).toBe(TASKS[index]!.title);
      expect(issues[0]!.milestone?.node_id).toBe(goal.node_id);
    }
    // The catch-all genesis issue is neither reused nor touched.
    expect(workUnitMarkers(g.github.issues.find((i) => i.number === 2)!.body).markers).toEqual([]);
    // Each issue ends, after a blank line, with its unit's marker: the task, its place among the run's units.
    expect(g.taskIds.map((taskId) => issueOf(g.github, taskId)[0]!.body.split("\n").slice(-2))).toEqual(
      g.taskIds.map((taskId, index) => ["", marker(taskId, index + 1, 3)]),
    );
    expect(startExecution(g, g.taskIds[1]!).allowed).toBe(true);
  });

  it("plan acceptance synchronizes the approved scope; an addition is not admitted until it is synchronized too", async () => {
    const g = await governedRun({ tasks: [TASKS[0]!] });
    const plan = await callCtoTool(g.h, g.owner, "plan_submit", {
      idempotencyKey: "plan-2",
      runId: g.runId,
      plan: { summary: "add the detail view" },
      tasks: [{ key: "detail", title: "Show one verdict's detail", category: "implementation" }],
    });
    expect(plan["ok"]).toBe(true);
    const all = g.h.cp.tasks.list(g.runId).map((task) => task.taskId);
    expect(all).toHaveLength(2);
    for (const taskId of all) expect(issueOf(g.github, taskId)).toHaveLength(1);
    expect(startExecution(g, all[1]!).allowed).toBe(true);

    // An addition that bypassed plan acceptance is refused by name; the linked units are not held back.
    const added = g.h.cp.tasks.submit(g.runId, [TASKS[2]!]);
    if (!added.allowed) throw new Error(added.message);
    const addedId = added.value[0]!.taskId;
    const blocked = startExecution(g, addedId);
    expect(blocked.reasonCode).toBe(REFUSED);
    expect((blocked.evidence as { untracked: Array<{ taskId: string }> }).untracked.map((u) => u.taskId)).toEqual([addedId]);
    expect(startExecution(g, all[0]!).allowed).toBe(true);
    // Its first admission synchronizes only it: one new issue, the goal milestone reused.
    const before = g.github.posts("/issues").length;
    expect((await startWorkerExecution(g, addedId)).allowed).toBe(true);
    expect(g.github.posts("/issues").length - before).toBe(1);
    expect(g.github.posts("/milestones")).toHaveLength(1);
  });

  it("a GitHub outage holds back only the unit not yet linked; a linked unit's admission asks GitHub nothing", async () => {
    const g = await governedRun({ tasks: [TASKS[0]!] });
    expect((await startWorkerExecution(g, g.taskIds[0]!)).allowed).toBe(true);
    const added = g.h.cp.tasks.submit(g.runId, [TASKS[1]!]);
    if (!added.allowed) throw new Error(added.message);
    const addedId = added.value[0]!.taskId;
    g.github.fault = { suffix: "/issues", when: "before" };
    const refused = await provision(g, addedId);
    expect(refusal(refused)).toEqual({ ok: false, reasonCode: REFUSED, untracked: [addedId] });
    expect((refused["evidence"] as { correction: string }).correction).toMatch(/reuses the milestone and issues already created/);
    // The linked unit is admitted on its record, with no GitHub request.
    const seen = g.github.calls.length;
    expect((await provision(g, g.taskIds[0]!))["reasonCode"]).not.toBe(REFUSED);
    expect(g.github.calls.length).toBe(seen);
    // GitHub answers again: the added unit is linked with one issue, and nothing is duplicated.
    expect((await provision(g, addedId))["reasonCode"]).not.toBe(REFUSED);
    expect(issueOf(g.github, addedId)).toHaveLength(1);
    expect(issueOf(g.github, g.taskIds[0]!)).toHaveLength(1);
    expect(g.github.posts("/milestones")).toHaveLength(1);
  });

  it("an issue already linked for one unit, reused for a new one, is a catch-all, refused", async () => {
    const g = await governedRun({ tasks: [TASKS[0]!] });
    expect((await startWorkerExecution(g, g.taskIds[0]!)).allowed).toBe(true);
    const first = issueOf(g.github, g.taskIds[0]!)[0]!;
    const added = g.h.cp.tasks.submit(g.runId, [TASKS[1]!]);
    if (!added.allowed) throw new Error(added.message);
    const addedId = added.value[0]!.taskId;
    first.body = `${first.body}\n\n${marker(addedId, 2, 2)}`;
    const refused = await provision(g, addedId);
    expect(refused["reasonCode"]).toBe(REFUSED);
    const unmet = (refused["evidence"] as { unmet: Array<{ unmet: string; covers: string[]; correction: string }> }).unmet;
    expect(unmet.map((u) => u.unmet)).toEqual(["CATCH_ALL_ISSUE"]);
    expect(unmet[0]!.covers.sort()).toEqual([addedId, g.taskIds[0]!].sort());
    expect(unmet[0]!.correction).toMatch(new RegExp(`issue #${first.number}`));
    expect(g.github.posts("/issues")).toHaveLength(1);
  });

  it("a retry after GitHub accepted an issue and its answer was lost resumes with no duplicate", async () => {
    const g = await governedRun();
    g.github.fault = { suffix: "/issues", when: "after", skip: 1 };
    const first = await provision(g, g.taskIds[0]!);
    expect(first["reasonCode"]).toBe(REFUSED);
    expect(g.github.posts("/issues")).toHaveLength(2);
    const second = await provision(g, g.taskIds[0]!);
    expect(second["reasonCode"]).not.toBe(REFUSED);
    for (const taskId of g.taskIds) expect(issueOf(g.github, taskId)).toHaveLength(1);
    expect(g.github.posts("/milestones")).toHaveLength(1);
    expect(g.github.posts("/issues")).toHaveLength(3);
  });

  it("a unit's issue found on a later page is not created again", async () => {
    const github = genesisRepository();
    // The repository's history is longer than one page, so the unit's issue lands on page two.
    for (let n = 0; n < 120; n += 1) github.addIssue(`old ${n}`, "unrelated", null);
    const g = await governedRun({ github, tasks: [TASKS[0]!] });
    github.fault = { suffix: "/issues", when: "after" };
    expect((await startWorkerExecution(g, g.taskIds[0]!)).reasonCode).toBe(REFUSED);
    expect((await startWorkerExecution(g, g.taskIds[0]!)).allowed).toBe(true);
    expect(github.posts("/issues")).toHaveLength(1);
    expect(issueOf(github, g.taskIds[0]!)).toHaveLength(1);
  });

  it("a repository at the name with another node id is refused before anything is written", async () => {
    const g = await governedRun();
    g.github.nodeId = "R_kgDOsomeoneelse";
    const refused = await provision(g, g.taskIds[0]!);
    expect(refusal(refused).reasonCode).toBe(REFUSED);
    expect(JSON.stringify(refused["evidence"])).toContain("R_kgDOsomeoneelse");
    expect(g.github.calls.filter((c) => c.method !== "GET")).toEqual([]);
    expect(startExecution(g, g.taskIds[0]!).reasonCode).toBe(REFUSED);
    // task_worker_run is refused before the turn records a write target or makes a branch.
    const turn = await callCtoTool(g.h, g.owner, "task_worker_run", { idempotencyKey: "turn-1", runId: g.runId, taskId: g.taskIds[0]!, claimId: "claim-none" });
    expect(turn["reasonCode"]).toBe(REFUSED);
    expect(g.h.cp.audit.byKind("TASK_WRITE_TARGET_RECORDED")).toEqual([]);
  });

  it("a readback answered with another repository's issues is refused", async () => {
    const g = await governedRun();
    g.github.foreign = true;
    const refused = await provision(g, g.taskIds[0]!);
    expect(refusal(refused).reasonCode).toBe(REFUSED);
    expect(JSON.stringify(refused["evidence"])).toContain(`${OWNER}/other`);
    expect(startExecution(g, g.taskIds[0]!).reasonCode).toBe(REFUSED);
  });

  it("an issue GitHub holds with no milestone, or another milestone, is refused by name", async () => {
    const g = await governedRun();
    g.github.dropMilestone = true;
    const refused = await provision(g, g.taskIds[0]!);
    expect(refused["reasonCode"]).toBe(REFUSED);
    const unmet = (refused["evidence"] as { unmet: Array<{ taskId?: string; unmet: string; correction: string }> }).unmet;
    expect(unmet.map((u) => u.unmet)).toEqual(["MILESTONE_LINK_MISSING", "MILESTONE_LINK_MISSING", "MILESTONE_LINK_MISSING"]);
    expect(unmet.map((u) => u.taskId).sort()).toEqual([...g.taskIds].sort());
    expect(unmet.every((u) => /link issue #\d+ to the run's goal milestone #\d+/.test(u.correction))).toBe(true);

    // Linked to the genesis milestone instead of the run's goal: the wrong milestone, refused.
    const genesisStage = g.github.milestones[0]!;
    for (const issue of g.github.issues.filter((i) => workUnitMarkers(i.body).markers.length > 0)) issue.milestone = g.github.milestoneRef(genesisStage);
    const wrong = await provision(g, g.taskIds[0]!);
    expect((wrong["evidence"] as { unmet: Array<{ unmet: string }> }).unmet.map((u) => u.unmet)).toEqual(["MILESTONE_LINK_WRONG", "MILESTONE_LINK_WRONG", "MILESTONE_LINK_WRONG"]);
    expect(startExecution(g, g.taskIds[0]!).reasonCode).toBe(REFUSED);
  });

  it("one issue standing for two approved units is a catch-all, refused", async () => {
    const g = await governedRun({ tasks: [TASKS[0]!, TASKS[1]!] });
    const goal = g.github.addMilestone("Ship the verdict feed", `goal\n<!-- acp-work:goal:${g.runId} -->`);
    g.github.addIssue("Everything", `all of it\n\n${marker(g.taskIds[0]!, 1, 2)}\n${marker(g.taskIds[1]!, 2, 2)}`, goal);
    const refused = await provision(g, g.taskIds[0]!);
    expect(refused["reasonCode"]).toBe(REFUSED);
    expect((refused["evidence"] as { unmet: Array<{ unmet: string }> }).unmet.map((u) => u.unmet)).toEqual(["CATCH_ALL_ISSUE", "CATCH_ALL_ISSUE"]);
    expect(g.github.posts("/issues")).toHaveLength(0);
  });

  it("a single-unit run gets exactly one issue and its goal's milestone, nothing more", async () => {
    const g = await governedRun({ tasks: [TASKS[1]!] });
    expect((await startWorkerExecution(g, g.taskIds[0]!)).allowed).toBe(true);
    expect(g.github.posts("/issues")).toHaveLength(1);
    expect(g.github.posts("/milestones")).toHaveLength(1);
    expect(g.github.calls.filter((c) => c.method !== "GET" && c.method !== "POST")).toEqual([]);
    // Read back once: a later admission of the same scope asks GitHub nothing.
    const seen = g.github.calls.length;
    expect((await provision(g, g.taskIds[0]!))["reasonCode"]).not.toBe(REFUSED);
    expect(g.github.calls.length).toBe(seen);
  });

  it("a project that is not a Repo Factory project is admitted as before, with no GitHub request", async () => {
    const g = await governedRun({ provisioned: false });
    expect(startExecution(g, g.taskIds[0]!).allowed).toBe(true);
    expect(g.github.calls).toEqual([]);
  });
});

describe("#1240 (i) — the genesis resources readback is bound to the exact repository", () => {
  const target = { owner: OWNER, name: NAME };
  const bundle = {
    labels: [],
    milestones: [{ key: "m1", title: "First product increment", description: "The first product increment" }],
    issues: [{ key: "i1", title: "Implement the owner's product intent", body: "Build what the owner asked for", labels: [], milestoneKey: "m1" }],
  };

  it("a readback answered with another repository's milestone and issue is refused", async () => {
    const github = genesisRepository();
    const port = createGitHubApiWritePort({ client: github });
    expect(await port.observeGenesisResources!(target, bundle, { repositoryNodeId: NODE })).toEqual(bundle);
    github.foreign = true;
    await expect(port.observeGenesisResources!(target, bundle, { repositoryNodeId: NODE })).rejects.toThrow(/another repository/);
  });

  it("a readback from a repository whose node id is not the receipted one is refused", async () => {
    const github = genesisRepository();
    github.nodeId = "R_kgDOsomeoneelse";
    const port = createGitHubApiWritePort({ client: github });
    await expect(port.observeGenesisResources!(target, bundle, { repositoryNodeId: NODE })).rejects.toThrow(/R_kgDOsomeoneelse|not the repository/);
  });

  it("the issue's milestone link is judged by the milestone's node id, not a number another milestone can carry", async () => {
    const github = genesisRepository();
    const port = createGitHubApiWritePort({ client: github });
    github.issues[1]!.milestone = { ...github.milestoneRef(github.milestones[0]!), node_id: "MI_elsewhere" };
    expect(await port.observeGenesisResources!(target, bundle, { repositoryNodeId: NODE })).toBeNull();
  });

  it("the genesis resources step binds every readback to the node id its repository was receipted with", async () => {
    class Recording extends GenesisGitHub {
      readonly bound: unknown[] = [];
      override async observeGenesisResources(t: GitHubRepositoryTarget, b: Pick<GenesisBundle, "labels" | "milestones" | "issues">, options?: { repositoryNodeId?: string }) {
        this.bound.push(options);
        return super.observeGenesisResources(t, b);
      }
    }
    const root = tempDir("genesis-bound-readback-");
    const port = new Recording(root);
    const f = genesisPlanFixture();
    const result = await produceRepoFactoryResult({
      plan: executablePlanOf(f.outputs, f.binding.planDigest),
      workDir: join(root, "work"),
      approvedFiles: f.outputs.files,
      github: { port, authority: { owner: OWNER, visibility: "public" as const, approvedOperations: f.outputs.githubOperations.map(({ operationId, resourceIdentity, resourceType }) => ({ operationId, resourceIdentity, resourceType })) } },
    });
    expect(result.allowed, result.allowed ? "" : `${result.message} ${JSON.stringify(result.evidence)}`).toBe(true);
    const nodeId = port.repository(OWNER, NAME)!.nodeId;
    expect(port.bound.length).toBeGreaterThanOrEqual(3);
    expect(port.bound).toEqual(port.bound.map(() => ({ repositoryNodeId: nodeId })));
  });

  it("a genesis issue on GitHub's second page is found, not created twice", async () => {
    const github = new IssuesGitHub();
    const stage = github.addMilestone("First product increment", "The first product increment\n<!-- acp-genesis:m1 -->");
    for (let n = 0; n < 120; n += 1) github.addIssue(`old ${n}`, "unrelated", null);
    github.addIssue("Implement the owner's product intent", "Build what the owner asked for\n<!-- acp-genesis:i1 -->", stage);
    const port = createGitHubApiWritePort({ client: github });
    await port.ensureGenesisResources!(target, bundle);
    expect(github.posts("/issues")).toHaveLength(0);
    expect(await port.observeGenesisResources!(target, bundle, { repositoryNodeId: NODE })).toEqual(bundle);
  });
});

describe("#1240 (RF lane) — the genesis issues' work-unit markers are checked for structure before approval", () => {
  /** A genesis whose issues have these bodies, each in the one milestone unless `milestoneKey` says otherwise. */
  const genesisWith = (issues: Array<{ body: string; milestoneKey?: string | null }>): GenesisBundle => ({
    ...genesisBundle(),
    labels: [],
    milestones: [{ key: "m1", title: "First product increment", description: "first increment" }],
    issues: issues.map((issue, index) => ({ key: `i${index + 1}`, title: `Unit ${index + 1}`, body: issue.body, labels: [], milestoneKey: issue.milestoneKey === undefined ? "m1" : issue.milestoneKey })),
  });
  const unit = (text: string, k: number, n: number, key: string) => ({ body: `${text}\n\nWork unit ${k} of ${n}: ${key}` });
  const refusalOf = (bundle: GenesisBundle): unknown => {
    try {
      parseGenesis(bundle);
      return null;
    } catch (error) {
      return (error as { evidence?: Record<string, unknown> }).evidence ?? (error as Error).message;
    }
  };

  it("a fully marked plan and a single unmarked issue are valid", () => {
    expect(refusalOf(genesisWith([unit("Feed", 1, 2, "feed"), unit("Detail", 2, 2, "detail")]))).toBeNull();
    expect(refusalOf(genesisWith([{ body: "Build what the owner asked for" }]))).toBeNull();
  });

  it("more than one issue with no marker at all is refused", () => {
    expect(refusalOf(genesisWith([{ body: "one" }, { body: "two" }]))).toMatchObject({ refusal: "GENESIS_WORK_UNITS_UNMARKED", issues: ["i1", "i2"] });
  });

  it("a missing unit index is refused by name", () => {
    expect(refusalOf(genesisWith([unit("a", 1, 3, "a"), unit("b", 3, 3, "b"), unit("c", 3, 3, "c")]))).toMatchObject({ refusal: "GENESIS_WORK_UNIT_INDEX_MISMATCH", missing: [2], repeated: [3] });
  });

  it("mixed totals, and a total that is not the issue count, are refused", () => {
    expect(refusalOf(genesisWith([unit("a", 1, 2, "a"), unit("b", 2, 3, "b")]))).toMatchObject({ refusal: "GENESIS_WORK_UNIT_MIXED_TOTAL", totals: [2, 3] });
    expect(refusalOf(genesisWith([unit("a", 1, 3, "a"), unit("b", 2, 3, "b")]))).toMatchObject({ refusal: "GENESIS_WORK_UNIT_COUNT_MISMATCH", total: 3, issueCount: 2 });
  });

  it("a key on two issues is refused", () => {
    expect(refusalOf(genesisWith([unit("a", 1, 2, "feed"), unit("b", 2, 2, "feed")]))).toMatchObject({ refusal: "GENESIS_WORK_UNIT_KEY_DUPLICATE", keys: ["feed"], issues: ["i1", "i2"] });
  });

  it("an issue with no milestone is refused, marked or not", () => {
    expect(refusalOf(genesisWith([{ body: "Build what the owner asked for", milestoneKey: null }]))).toMatchObject({ refusal: "GENESIS_ISSUE_MILESTONE_MISSING", issues: ["i1"] });
    expect(refusalOf(genesisWith([unit("a", 1, 2, "a"), { ...unit("b", 2, 2, "b"), milestoneKey: null }]))).toMatchObject({ refusal: "GENESIS_ISSUE_MILESTONE_MISSING", issues: ["i2"] });
  });

  it("an unmarked issue beside marked ones is refused", () => {
    expect(refusalOf(genesisWith([unit("a", 1, 2, "a"), { body: "everything else" }]))).toMatchObject({ refusal: "GENESIS_WORK_UNIT_UNMARKED", issues: ["i2"] });
  });

  it("a body with two markers, or a marker that is not its last line, is refused", () => {
    expect(refusalOf(genesisWith([{ body: "a\n\nWork unit 1 of 2: a\nWork unit 2 of 2: b" }, unit("b", 2, 2, "b")]))).toMatchObject({ refusal: "GENESIS_WORK_UNIT_MARKER_NOT_ONE_LAST_LINE", issues: ["i1"] });
    expect(refusalOf(genesisWith([{ body: "Work unit 1 of 2: a\n\nmore text" }, unit("b", 2, 2, "b")]))).toMatchObject({ refusal: "GENESIS_WORK_UNIT_MARKER_NOT_ONE_LAST_LINE", issues: ["i1"] });
  });

  it("plan submission answers with the precise refusal, not only GENESIS_INVALID", () => {
    const genesis = genesisWith([unit("a", 1, 3, "a"), unit("b", 3, 3, "b"), unit("c", 3, 3, "c")]);
    const manifest = projectManifestSchema.parse(fixtureManifest("resident-test", {
      verificationCommands: [{ id: "test", argv: ["node", "test.js"], repositoryRole: "primary", cwd: ".", timeoutSeconds: 30, envAllowlist: [], network: "deny", networkAllowlist: [], required: true, evidenceMode: "LOCAL_COMMAND", maxOutputBytes: 1048576, maxMemoryMb: 1024, maxCpuSeconds: 30 }],
      verificationProfiles: { simple: ["test"], standard: ["test"], guarded: ["test"] },
      ciWorkflows: [{ repositoryRole: "primary", path: ".github/workflows/ci.yml", checkName: "test", approvedDigest: genesis.files[1]!.sha256, unapprovedFirstActivation: false }],
    }));
    const submitted = planForSubmission({ kind: "PROJECT_BOOTSTRAP", projectId: null }, { summary: "create", bootstrapOperationId: "genesis-op", requestDigest: digestOf("request"), projectManifest: manifest, projectManifestDigest: manifestDigest(manifest), genesis });
    expect(submitted.allowed).toBe(false);
    expect(submitted.evidence).toMatchObject({ refusal: "GENESIS_INVALID", genesisRefusal: { refusal: "GENESIS_WORK_UNIT_INDEX_MISMATCH", missing: [2] } });
  });

  it("the acp-genesis-issues readback confirms every marked issue in the exact repository with its milestone", async () => {
    const bundle = genesisWith([unit("a", 1, 2, "a"), unit("b", 2, 2, "b")]);
    const resources = { labels: bundle.labels, milestones: bundle.milestones, issues: bundle.issues };
    const github = new IssuesGitHub();
    const port = createGitHubApiWritePort({ client: github });
    const target = { owner: OWNER, name: NAME };
    await port.ensureGenesisResources!(target, resources);
    expect(await port.observeGenesisResources!(target, resources, { repositoryNodeId: NODE })).toEqual(resources);
    github.issues[1]!.milestone = null;
    expect(await port.observeGenesisResources!(target, resources, { repositoryNodeId: NODE })).toBeNull();
    github.issues[1]!.milestone = github.milestoneRef(github.milestones[0]!);
    github.foreign = true;
    await expect(port.observeGenesisResources!(target, resources, { repositoryNodeId: NODE })).rejects.toThrow(/another repository/);
  });
});
