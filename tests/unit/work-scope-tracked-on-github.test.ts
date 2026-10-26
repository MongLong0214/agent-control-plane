import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { join } from "node:path";

import { executablePlanOf, planForSubmission } from "../../src/bootstrap/bootstrap-plan.ts";
import { createBootstrapGitHubWritePort } from "../../src/bootstrap/bootstrap-write-guard.ts";
import { type GenesisBundle, parseGenesis } from "../../src/bootstrap/genesis-bundle.ts";
import { createGitHubApiWritePort, type GitHubRepositoryTarget } from "../../src/bootstrap/github-write-port.ts";
import { produceRepoFactoryResult } from "../../src/bootstrap/repo-factory-producer.ts";
import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { manifestDigest, projectManifestSchema } from "../../src/contracts/manifest.ts";
import { digestOf } from "../../src/core/digest.ts";
import { ArtifactKind, ExecutionMode, Role, RunKind, roleKeyFor } from "../../src/domain/types.ts";
import type { GitHubClient } from "../../src/github/github-kernel.ts";
import { callCtoTool } from "../helpers/cto-tool.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { GenesisGitHub, genesisBundle, genesisPlanFixture } from "../helpers/genesis-github.ts";
import { approveReviewedCandidateForFinalization, bindCeo, bindWorker, driveToReviewedCandidate, fixtureManifest, makeHarness, registerFixtureProject, type Harness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);
afterEach(() => vi.restoreAllMocks());

/**
 * #1240 (ACP part) — a Repo Factory project's approved work units, as its PLAN declares them, are linked
 * on GitHub (adopted existing issues, or new ones), read back from the exact repository, before any of
 * their tasks is admitted to execution or the run is confirmed.
 *
 * The live counterexample (project myeotnyeon): approved STANDARD_WORK runs executed with no link to
 * GitHub, while the repository holds the genesis catch-all #2 and the issues #3–#10 across milestones
 * 1 "First product increment", 2 "채널 성장: 구독자 1,000명" and 3 "채널 성장: 구독자 5,000명".
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

/**
 * myeotnyeon's repository as it stands: the genesis PR #1, the genesis catch-all #2, and the issues
 * #3–#10 across its three milestones (product implementation, and two channel-growth goals).
 */
const myeotnyeon = (): IssuesGitHub => {
  const github = new IssuesGitHub();
  const product = github.addMilestone("First product increment", "The first product increment\n<!-- acp-genesis:m1 -->");
  const growth1k = github.addMilestone("채널 성장: 구독자 1,000명", "");
  const growth5k = github.addMilestone("채널 성장: 구독자 5,000명", "");
  github.addIssue("Bootstrap genesis", "repo-factory:genesis", null, true);
  github.addIssue("Implement the owner's product intent", "Build what the owner asked for\n<!-- acp-genesis:i1 -->", product);
  github.addIssue("Render the verdict feed", "The home screen lists verdicts", product); // #3
  github.addIssue("Verdict detail page", "One verdict, in full", product); // #4
  github.addIssue("Daily verdict short", "One short a day", growth1k); // #5
  github.addIssue("Thumbnail A/B", "Two thumbnails per short", growth1k); // #6
  github.addIssue("Upload schedule", "19:00 every day", growth1k); // #7
  github.addIssue("Community posts", "Weekly community post", growth5k); // #8
  github.addIssue("Shorts analytics", "Read retention", null); // #9, in no milestone
  github.addIssue("Collaboration outreach", "Reach two channels", growth5k); // #10
  return github;
};

/** The live runs' shape: tasks in the graph with no declared unit, as the runs before #1240 left them. */
const LEGACY = [
  { key: "impl", title: "Implement the verdict feed", category: "implementation" as const, spec: {} },
  { key: "review", title: "Review the verdict feed", category: "review" as const, spec: {} },
  { key: "short", title: "Make the daily short", category: "implementation" as const, spec: {} },
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
 * The project's Repo Factory provisioning row, as activation leaves it, naming the repository and its
 * node id. Activation's row belongs to the bootstrap run; a run of the project stands in for it here.
 */
const provisionRow = (h: Harness, projectId: string): void => {
  const contract = { goal: "bootstrap", why: "genesis", scope: [], nonGoals: [], acceptance: [], priority: "NORMAL" as const, humanGate: [], references: [] };
  const holder = h.cp.runs.create({ projectId, kind: RunKind.STANDARD_WORK, executionMode: ExecutionMode.SIMPLE, contract, repositories: [] });
  if (!holder.allowed) throw new Error(holder.message);
  const holderRunId = holder.value.runId;
  h.cp.db.run(
    `INSERT INTO resident_project_provisioning(run_id,project_id,binding_json,allocation_json,confirmation_json,steps_json,status,updated_at)
     VALUES (?,?,'{}',?,'{}','{}','COMPLETE',?)`,
    [holderRunId, projectId, JSON.stringify({ projectId, repositoryIdentity: IDENTITY, repositoryNodeId: NODE }), h.clock.nowIso()],
  );
};

const harnessFor = (github: IssuesGitHub): Harness =>
  makeHarness({ repoFactory: { workRoot: tempDir("rf-work-"), githubPort: createBootstrapGitHubWritePort(github, async () => ({ exitCode: 0, stdout: "", stderr: "" })) } });

/**
 * A Repo Factory project, as activation leaves one, and a dispatched STANDARD_WORK run of it whose
 * `legacy` tasks are in the graph with no declared unit (the provisioning row is recorded after
 * dispatch: the resident CTO already holds the project).
 */
const governedRun = async (options: { github?: IssuesGitHub; legacy?: typeof LEGACY; provisioned?: boolean } = {}): Promise<Governed> => {
  const github = options.github ?? myeotnyeon();
  const h = harnessFor(github);
  const project = await registerFixtureProject(h, "myeotnyeon", {}, { identity: IDENTITY });
  bindCeo(h);
  const contract = { goal: "Ship the verdict feed", why: "the owner's next product goal", scope: ["src/app.js"], nonGoals: [], acceptance: ["the feed is live"], priority: "NORMAL" as const, humanGate: [], references: [] };
  const created = h.cp.runs.create({ projectId: project.projectId, kind: RunKind.STANDARD_WORK, executionMode: ExecutionMode.SIMPLE, contract, repositories: [{ repositoryId: project.repositoryId, repositoryRole: "primary", baseBranch: "dev" }] });
  if (!created.allowed) throw new Error(created.message);
  const runId = created.value.runId;
  const dispatched = await h.cp.runs.dispatch(runId);
  if (!dispatched.allowed) throw new Error(`${dispatched.reasonCode}: ${dispatched.message}`);
  if (options.provisioned !== false) provisionRow(h, project.projectId);
  const legacy = options.legacy ?? LEGACY;
  const submitted = legacy.length === 0 ? { allowed: true as const, value: [] } : h.cp.tasks.submit(runId, legacy);
  if (!submitted.allowed) throw new Error(submitted.message);
  const run = h.cp.runs.require(runId);
  return {
    h, github, runId, projectId: project.projectId,
    taskIds: submitted.value.map((task) => task.taskId),
    owner: { sessionId: run.ownerSessionId!, incarnation: h.cp.sessions.get(run.ownerSessionId!)!.incarnation },
    generation: run.ownerBindingGeneration!,
  };
};

/** The run owner's plan_submit over the CTO MCP tools, declaring `workUnits` (and tasks, when given). */
const planSubmit = (g: Governed, workUnits: unknown, tasks?: unknown[]) =>
  callCtoTool(g.h, g.owner, "plan_submit", { idempotencyKey: `plan-${Math.random()}`, runId: g.runId, plan: { summary: "work units", workUnits }, ...(tasks === undefined ? {} : { tasks }) });

/** The CTO's task_worker_provision, as the run's owner calls it over the CTO MCP tools. */
const provision = (g: Governed, taskId: string) =>
  callCtoTool(g.h, g.owner, "task_worker_provision", { idempotencyKey: `provision-${taskId}-${Math.random()}`, runId: g.runId, taskId, provider: "scripted" });

/** The task's WORKER, bound once and reused. */
const workerOf = (g: Governed, taskId: string): string =>
  g.h.cp.bindings.active(roleKeyFor(Role.WORKER, { taskId }))?.sessionId ?? bindWorker(g.h, taskId);

/** The synchronous execution receipt every execution start ends in. */
const startExecution = (g: Governed, taskId: string) =>
  g.h.cp.tasks.startExecution({ runId: g.runId, taskId, ownerBindingGeneration: g.generation, workerSessionId: workerOf(g, taskId), provider: "scripted", model: "scripted-worker" });

/** The admission-bearing worker start task_worker_run and a started receipt go through. */
const startWorkerExecution = (g: Governed, taskId: string) => {
  vi.spyOn(g.h.cp.tasks, "admitWorkerFanout").mockResolvedValue(allow(ReasonCode.OK, undefined) as never);
  return g.h.cp.tasks.startWorkerExecution({ runId: g.runId, taskId, ownerBindingGeneration: g.generation, workerSessionId: workerOf(g, taskId), provider: "scripted", model: "scripted-worker" });
};

const tracking = (answer: Record<string, unknown>) => (answer["evidence"] as { githubTracking?: Record<string, unknown> } | undefined)?.githubTracking;
const unmetOf = (evidence: unknown) => ((evidence as { unmet?: Array<{ unit: string; unmet: string; issues?: number[]; correction: string }> } | undefined)?.unmet ?? []);
const trackedRecords = (g: Governed) => g.h.cp.audit.byKind("WORK_SCOPE_GITHUB_TRACKED").filter((row) => row.runId === g.runId).map((row) => row.evidence as { units: Array<{ unit: string; issueNumber: number; milestoneNumber: number; adopted: boolean }> });
const INTERNAL_ID = /\b(?:prj|repo|ses|run|task|art|clm|msg|asg)_[0-9a-f]{24}\b/;

describe("#1240 — a Repo Factory project's approved work units are linked on GitHub before execution", () => {
  it("the myeotnyeon counterexample: tasks with no declared unit are refused; a PLAN adopting the existing issues admits them with no POST", async () => {
    const g = await governedRun();
    const [impl, review, short] = g.taskIds as [string, string, string];
    const receipt = startExecution(g, impl);
    expect(receipt.reasonCode).toBe(REFUSED);
    expect((receipt.evidence as { unmapped: Array<{ taskId: string }> }).unmapped.map((t) => t.taskId).sort()).toEqual([...g.taskIds].sort());
    expect((await provision(g, short))["reasonCode"]).toBe(REFUSED);

    // The owner's PLAN re-links the run's existing tasks, adopting #3 (product) and #5 (growth), adding none.
    const answer = await planSubmit(g, [
      { key: "feed", tasks: [impl, review], issue: { number: 3 }, milestone: { number: 1 } },
      { key: "short", tasks: [short], issue: { number: 5 }, milestone: { number: 2 } },
    ]);
    expect(answer["ok"]).toBe(true);
    expect(tracking(answer)).toMatchObject({ tracked: true });
    expect(g.github.calls.filter((c) => c.method !== "GET")).toEqual([]);
    expect(g.h.cp.tasks.list(g.runId)).toHaveLength(3);
    expect(trackedRecords(g).flatMap((r) => r.units).map((u) => [u.unit, u.issueNumber, u.milestoneNumber, u.adopted])).toEqual([["feed", 3, 1, true], ["short", 5, 2, true]]);
    // Implementation and review share #3; the short is #5; the catch-all #2 stands for nothing.
    for (const taskId of [impl, review, short]) expect(startExecution(g, taskId).allowed).toBe(true);
  });

  it("two tasks of one unit share its one new issue: nothing is created per task", async () => {
    const g = await governedRun({ legacy: [] });
    const answer = await planSubmit(g, [{ key: "roundup", tasks: ["impl", "review"], issue: { new: { title: "Weekly verdict roundup", body: "Collect the week's verdicts" } }, milestone: { number: 1 } }], [
      { key: "impl", title: "Build the weekly roundup", category: "implementation" },
      { key: "review", title: "Review the weekly roundup", category: "review" },
    ]);
    expect(tracking(answer)).toMatchObject({ tracked: true });
    expect(g.github.posts("/issues")).toHaveLength(1);
    expect(g.github.posts("/milestones")).toHaveLength(0);
    expect(g.github.issues.at(-1)!.milestone?.number).toBe(1);
    for (const task of g.h.cp.tasks.list(g.runId)) expect(startExecution(g, task.taskId).allowed).toBe(true);
  });

  it("a PLAN change re-verifies only the units whose link changed; an unchanged PLAN asks GitHub nothing", async () => {
    const g = await governedRun({ legacy: LEGACY.slice(0, 2) });
    const [impl, review] = g.taskIds as [string, string];
    const feed = { key: "feed", tasks: [impl], issue: { number: 3 }, milestone: { number: 1 } };
    expect(tracking(await planSubmit(g, [feed, { key: "detail", tasks: [review], issue: { number: 4 }, milestone: { number: 1 } }]))).toMatchObject({ tracked: true });
    expect(trackedRecords(g)).toHaveLength(1);
    // Relinked: detail now adopts #6 in the growth milestone; feed is unchanged and is not verified again.
    expect(tracking(await planSubmit(g, [feed, { key: "detail", tasks: [review], issue: { number: 6 }, milestone: { number: 2 } }]))).toMatchObject({ tracked: true });
    expect(trackedRecords(g)).toHaveLength(2);
    expect(trackedRecords(g)[1]!.units.map((u) => [u.unit, u.issueNumber])).toEqual([["detail", 6]]);
    // The same PLAN again: nothing changed, so GitHub is not asked.
    const seen = g.github.calls.length;
    expect(tracking(await planSubmit(g, [feed, { key: "detail", tasks: [review], issue: { number: 6 }, milestone: { number: 2 } }]))).toMatchObject({ tracked: true });
    expect(g.github.calls.length).toBe(seen);
    // A relink to a wrong milestone holds back that unit only.
    const wrong = await planSubmit(g, [feed, { key: "detail", tasks: [review], issue: { number: 8 }, milestone: { number: 2 } }]);
    expect(unmetOf(tracking(wrong)).map((u) => [u.unit, u.unmet])).toEqual([["detail", "MILESTONE_LINK_WRONG"]]);
    expect(startExecution(g, impl).allowed).toBe(true);
    const held = startExecution(g, review);
    expect(held.reasonCode).toBe(REFUSED);
    expect((held.evidence as { untracked: Array<{ unit: string }> }).untracked.map((u) => u.unit)).toEqual(["detail"]);
  });

  it("a sealed run whose approved units are not tracked is refused at CONFIRM, the units named", async () => {
    const github = myeotnyeon();
    const h = harnessFor(github);
    const driven = await driveToReviewedCandidate(h, { projectId: "myeotnyeon", repositoryIdentity: IDENTITY });
    // The run was executed before #1240 and is now sealed; the project is a Repo Factory one.
    provisionRow(h, driven.projectId);
    await expect(approveReviewedCandidateForFinalization(h, driven)).rejects.toThrow(REFUSED);
    expect(h.cp.runs.require(driven.runId).state).toBe("READY_FOR_CEO_REVIEW");
    const ceo = h.cp.bindings.active(roleKeyFor(Role.CEO))!;
    const admitted = h.cp.ceo.assertCeoDecisionAdmissible({ runId: driven.runId, decision: "CONFIRM", candidateSnapshotDigest: driven.candidateSnapshotDigest, ceoSessionId: ceo.sessionId, rationale: "confirm" });
    expect(admitted.reasonCode).toBe(REFUSED);
    expect((admitted.evidence as { unmapped: Array<{ title: string }> }).unmapped.map((t) => t.title)).toEqual(["change app()"]);
    expect((admitted.evidence as { correction: string }).correction).toMatch(/FINAL_REVISE/);
    expect(github.calls).toEqual([]);
  });

  it("no internal id is published: a created issue and milestone carry the PLAN's text and one digest marker", async () => {
    const g = await governedRun({ legacy: LEGACY.slice(0, 1) });
    const [impl] = g.taskIds as [string];
    const leaked = await planSubmit(g, [{ key: "roundup", tasks: [impl], issue: { new: { title: "Weekly verdict roundup", body: `Implements ${impl}` } }, milestone: { number: 1 } }]);
    expect(leaked).toMatchObject({ ok: false, evidence: { refusal: "WORK_UNITS_TEXT_NOT_PUBLIC" } });
    const answer = await planSubmit(g, [{ key: "roundup", tasks: [impl], issue: { new: { title: "Weekly verdict roundup", body: "Collect the week's verdicts" } }, milestone: { new: { title: "Product: weekly roundup", description: "The weekly product increment" } } }]);
    expect(tracking(answer)).toMatchObject({ tracked: true });
    const bodies = g.github.calls.filter((c) => c.method === "POST").map((c) => c.body as Record<string, unknown>);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toEqual({ title: "Product: weekly roundup", description: expect.stringMatching(/^The weekly product increment\n\n<!-- acp:[0-9a-f]{16} -->$/) });
    expect(bodies[1]).toEqual({ title: "Weekly verdict roundup", body: expect.stringMatching(/^Collect the week's verdicts\n\n<!-- acp:[0-9a-f]{16} -->$/), milestone: 4 });
    const published = JSON.stringify(bodies);
    expect(published).not.toMatch(INTERNAL_ID);
    for (const id of [g.runId, impl, g.owner.sessionId, g.projectId]) expect(published).not.toContain(id);
    expect(published).not.toContain("Work unit");
  });

  it("a new milestone needs only its title, as the PLAN guide states", async () => {
    const g = await governedRun({ legacy: LEGACY.slice(0, 1) });
    const [impl] = g.taskIds as [string];
    const answer = await planSubmit(g, [{ key: "roundup", tasks: [impl], issue: { new: { title: "Weekly verdict roundup", body: "Collect" } }, milestone: { new: { title: "채널 성장: 구독자 10,000명" } } }]);
    expect(tracking(answer)).toMatchObject({ tracked: true });
    expect(g.github.posts("/milestones").map((c) => c.body)).toEqual([{ title: "채널 성장: 구독자 10,000명", description: expect.stringMatching(/^<!-- acp:[0-9a-f]{16} -->$/) }]);
  });

  it("a duplicate-creation attempt for work that already has an issue is refused", async () => {
    const g = await governedRun({ legacy: LEGACY.slice(2) });
    const [short] = g.taskIds as [string];
    // A new unit titled as #5 is the work #5 already tracks.
    const same = await planSubmit(g, [{ key: "short", tasks: [short], issue: { new: { title: "Daily verdict short", body: "One short a day" } }, milestone: { number: 2 } }]);
    expect(tracking(same)).toMatchObject({ tracked: false });
    expect(unmetOf(tracking(same))).toMatchObject([{ unit: "short", unmet: "ISSUE_EXISTS", issues: [5] }]);
    // Adopted, then declared new: a second issue for adopted work.
    expect(tracking(await planSubmit(g, [{ key: "short", tasks: [short], issue: { number: 5 }, milestone: { number: 2 } }]))).toMatchObject({ tracked: true });
    const relinked = await planSubmit(g, [{ key: "short", tasks: [short], issue: { new: { title: "Daily short, second take", body: "One short a day" } }, milestone: { number: 2 } }]);
    expect(unmetOf(tracking(relinked))).toMatchObject([{ unit: "short", unmet: "DUPLICATE_OF_ADOPTED", issues: [5] }]);
    expect(g.github.calls.filter((c) => c.method !== "GET")).toEqual([]);
    expect(startExecution(g, short).reasonCode).toBe(REFUSED);
  });

  it("a retry after GitHub accepted an issue and lost its answer finds it by its marker on a later page: no duplicate", async () => {
    const github = myeotnyeon();
    for (let n = 0; n < 120; n += 1) github.addIssue(`old ${n}`, "unrelated", null);
    const g = await governedRun({ github, legacy: LEGACY.slice(0, 1) });
    const [impl] = g.taskIds as [string];
    github.fault = { suffix: "/issues", when: "after" };
    const first = await planSubmit(g, [{ key: "roundup", tasks: [impl], issue: { new: { title: "Weekly verdict roundup", body: "Collect the week's verdicts" } }, milestone: { number: 1 } }]);
    expect(tracking(first)).toMatchObject({ tracked: false, correction: expect.stringMatching(/never duplicated/) });
    expect((await startWorkerExecution(g, impl)).allowed).toBe(true);
    expect(github.posts("/issues")).toHaveLength(1);
    expect(github.issues.filter((i) => i.title === "Weekly verdict roundup")).toHaveLength(1);
  });

  it("a repository at the name with another node id, or an answer from another repository, is refused with nothing written", async () => {
    const g = await governedRun({ legacy: LEGACY.slice(0, 1) });
    const [impl] = g.taskIds as [string];
    g.github.nodeId = "R_kgDOsomeoneelse";
    const wrong = await planSubmit(g, [{ key: "roundup", tasks: [impl], issue: { new: { title: "Weekly verdict roundup", body: "x" } }, milestone: { number: 1 } }]);
    expect(tracking(wrong)).toMatchObject({ tracked: false, causeRefusal: "WRONG_REPOSITORY" });
    expect(JSON.stringify(tracking(wrong))).toContain("R_kgDOsomeoneelse");
    const turn = await callCtoTool(g.h, g.owner, "task_worker_run", { idempotencyKey: "turn-1", runId: g.runId, taskId: impl, claimId: "claim-none" });
    expect(turn["reasonCode"]).toBe(REFUSED);
    g.github.nodeId = NODE;
    g.github.foreign = true;
    const foreign = await provision(g, impl);
    expect(foreign["reasonCode"]).toBe(REFUSED);
    expect(JSON.stringify(foreign["evidence"])).toContain(`${OWNER}/other`);
    expect(g.github.calls.filter((c) => c.method !== "GET")).toEqual([]);
    expect(g.h.cp.audit.byKind("TASK_WRITE_TARGET_RECORDED")).toEqual([]);
  });

  it("an adopted issue in no milestone, in another milestone, or that is not an issue, is refused by name", async () => {
    const g = await governedRun();
    const [impl, review, short] = g.taskIds as [string, string, string];
    const answer = await planSubmit(g, [
      { key: "analytics", tasks: [impl], issue: { number: 9 }, milestone: { number: 3 } },
      { key: "community", tasks: [review], issue: { number: 8 }, milestone: { number: 2 } },
      { key: "genesis-pr", tasks: [short], issue: { number: 1 }, milestone: { number: 1 } },
    ]);
    expect(unmetOf(tracking(answer)).map((u) => [u.unit, u.unmet])).toEqual([["genesis-pr", "ISSUE_NOT_FOUND"], ["analytics", "MILESTONE_LINK_MISSING"], ["community", "MILESTONE_LINK_WRONG"]]);
    expect(unmetOf(tracking(answer)).find((u) => u.unit === "community")!.correction).toMatch(/issue #8 is in milestone #3, not #2/);
    expect(g.github.calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("two units adopting one issue, or a task in no unit, is refused at plan acceptance with nothing stored", async () => {
    const g = await governedRun();
    const [impl, review, short] = g.taskIds as [string, string, string];
    const plans = g.h.cp.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM run_artifacts WHERE run_id = ? AND kind = 'PLAN'`, [g.runId])!.n;
    const shared = await planSubmit(g, [
      { key: "feed", tasks: [impl, review], issue: { number: 2 }, milestone: { number: 1 } },
      { key: "short", tasks: [short], issue: { number: 2 }, milestone: { number: 1 } },
    ]);
    expect(shared).toMatchObject({ ok: false, evidence: { refusal: "WORK_UNITS_SHARE_AN_ISSUE", issues: [2] } });
    const unmapped = await planSubmit(g, [{ key: "feed", tasks: [impl, review], issue: { number: 3 }, milestone: { number: 1 } }]);
    expect(unmapped).toMatchObject({ ok: false, evidence: { refusal: "WORK_UNITS_TASKS_UNMAPPED", unmapped: [short] } });
    expect(g.h.cp.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM run_artifacts WHERE run_id = ? AND kind = 'PLAN'`, [g.runId])!.n).toBe(plans);
    expect(g.github.calls).toEqual([]);
  });

  it("a GitHub outage holds back only the unit not yet linked; a linked unit's admission asks GitHub nothing", async () => {
    const g = await governedRun({ legacy: LEGACY.slice(0, 1) });
    const [impl] = g.taskIds as [string];
    const feed = { key: "feed", tasks: [impl], issue: { number: 3 }, milestone: { number: 1 } };
    expect(tracking(await planSubmit(g, [feed]))).toMatchObject({ tracked: true });
    g.github.fault = { suffix: "/issues", when: "before" };
    const added = await planSubmit(g, [feed, { key: "roundup", tasks: ["roundup"], issue: { new: { title: "Weekly verdict roundup", body: "Collect" } }, milestone: { number: 1 } }], [{ key: "roundup", title: "Build the weekly roundup", category: "implementation" }]);
    expect(tracking(added)).toMatchObject({ tracked: false });
    const roundup = g.h.cp.tasks.list(g.runId).find((t) => t.title === "Build the weekly roundup")!.taskId;
    const seen = g.github.calls.length;
    expect(startExecution(g, impl).allowed).toBe(true);
    expect((await provision(g, impl))["reasonCode"]).not.toBe(REFUSED);
    expect(g.github.calls.length).toBe(seen);
    expect(startExecution(g, roundup).reasonCode).toBe(REFUSED);
    expect((await startWorkerExecution(g, roundup)).allowed).toBe(true);
    expect(g.github.posts("/issues")).toHaveLength(2);
    expect(g.github.issues.filter((i) => i.title === "Weekly verdict roundup")).toHaveLength(1);
  });

  it("an approval that is not the run's current owner's creates nothing", async () => {
    const g = await governedRun({ legacy: LEGACY.slice(0, 1) });
    const [impl] = g.taskIds as [string];
    const units = [{ key: "roundup", tasks: [impl], issue: { new: { title: "Weekly verdict roundup", body: "Collect" } }, milestone: { number: 1 } }];
    g.github.fault = { suffix: "/issues", when: "before" };
    expect(tracking(await planSubmit(g, units))).toMatchObject({ tracked: false });
    // The same PLAN, as an earlier owner approved it: the run is held by another session now.
    const scope = g.h.cp.tasks.workScope!;
    const declared = scope.declare(g.runId, { workUnits: units }, []);
    if (!declared.allowed || declared.value === null) throw new Error("declaration refused");
    const plan = g.h.cp.artifacts.latest(g.runId, ArtifactKind.PLAN)!;
    expect(scope.approve(g.runId, plan.digest, declared.value, [], [], { sessionId: "ses_000000000000000000000000", bindingGeneration: g.generation }).allowed).toBe(true);
    const refused = await g.h.cp.tasks.ensureWorkScopeTracked(g.runId, impl);
    expect(refused.evidence).toMatchObject({ causeRefusal: "WORK_SCOPE_APPROVAL_NOT_CURRENT_OWNER" });
    expect(g.github.posts("/issues")).toHaveLength(1);
    expect(g.github.issues.filter((i) => i.title === "Weekly verdict roundup")).toEqual([]);
  });

  it("the write guard admits only the PLAN's exact text: an altered body never reaches GitHub", async () => {
    const github = myeotnyeon();
    const port = createBootstrapGitHubWritePort(github, async () => ({ exitCode: 0, stdout: "", stderr: "" }));
    const createWorkIssue = port.createWorkIssue!.bind(port);
    // A port path that edits what it was given: the guard, not the port, is what stops it.
    port.createWorkIssue = (target, nodeId, issue) => createWorkIssue(target, nodeId, { ...issue, body: `${issue.body}\nsee /Users/someone/notes` });
    const h = makeHarness({ repoFactory: { workRoot: tempDir("rf-work-"), githubPort: port } });
    const project = await registerFixtureProject(h, "myeotnyeon", {}, { identity: IDENTITY });
    bindCeo(h);
    const contract = { goal: "Ship", why: "goal", scope: ["src/app.js"], nonGoals: [], acceptance: ["live"], priority: "NORMAL" as const, humanGate: [], references: [] };
    const created = h.cp.runs.create({ projectId: project.projectId, kind: RunKind.STANDARD_WORK, executionMode: ExecutionMode.SIMPLE, contract, repositories: [{ repositoryId: project.repositoryId, repositoryRole: "primary", baseBranch: "dev" }] });
    if (!created.allowed) throw new Error(created.message);
    expect((await h.cp.runs.dispatch(created.value.runId)).allowed).toBe(true);
    provisionRow(h, project.projectId);
    const run = h.cp.runs.require(created.value.runId);
    const g: Governed = { h, github, runId: run.runId, projectId: project.projectId, taskIds: [], owner: { sessionId: run.ownerSessionId!, incarnation: h.cp.sessions.get(run.ownerSessionId!)!.incarnation }, generation: run.ownerBindingGeneration! };
    const answer = await planSubmit(g, [{ key: "roundup", tasks: ["impl"], issue: { new: { title: "Weekly verdict roundup", body: "Collect" } }, milestone: { number: 1 } }], [{ key: "impl", title: "Build", category: "implementation" }]);
    expect(tracking(answer)).toMatchObject({ tracked: false, cause: expect.stringMatching(/writes only the PLAN's own new milestones and issues/) });
    expect(github.calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("a project that is not a Repo Factory project plans and is admitted as before, with no GitHub request", async () => {
    const g = await governedRun({ provisioned: false, legacy: [] });
    const answer = await callCtoTool(g.h, g.owner, "plan_submit", { idempotencyKey: "plan-plain", runId: g.runId, plan: { summary: "plain" }, tasks: [{ key: "impl", title: "Implement", category: "implementation" }] });
    expect(answer["ok"]).toBe(true);
    expect(tracking(answer)).toBeUndefined();
    expect(startExecution(g, g.h.cp.tasks.list(g.runId)[0]!.taskId).allowed).toBe(true);
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
