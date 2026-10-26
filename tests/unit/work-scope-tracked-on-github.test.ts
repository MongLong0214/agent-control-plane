import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { join } from "node:path";

import { executablePlanOf, planForSubmission } from "../../src/bootstrap/bootstrap-plan.ts";
import { createBootstrapGitHubWritePort } from "../../src/bootstrap/bootstrap-write-guard.ts";
import { type GenesisBundle, parseGenesis } from "../../src/bootstrap/genesis-bundle.ts";
import { createGitHubApiWritePort, type GitHubRepositoryTarget } from "../../src/bootstrap/github-write-port.ts";
import { produceRepoFactoryResult } from "../../src/bootstrap/repo-factory-producer.ts";
import { acpError, allow, deny } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { manifestDigest, projectManifestSchema } from "../../src/contracts/manifest.ts";
import { digestOf } from "../../src/core/digest.ts";
import { ArtifactKind, ExecutionMode, Role, RunKind, RunState, roleKeyFor } from "../../src/domain/types.ts";
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
  /**
   * The next POST to a path ending with `suffix` fails. "before": GitHub answers an error and creates
   * nothing (with `status`, the HTTP status the client reports; without one, no status is heard).
   * "after": GitHub creates it and the answer is lost. "late": the client gives up with no answer while
   * GitHub is still processing; the issue appears only when `land()` is called.
   */
  fault: { suffix: string; when: "before" | "after" | "late"; skip?: number; status?: number } | null = null;
  private landing: Array<() => void> = [];
  /** GitHub completes the requests a "late" fault left in flight. */
  land(): void {
    for (const complete of this.landing.splice(0)) complete();
  }
  /** Lists answer with another repository's items, as a misrouted or reused-name answer would. */
  foreign = false;
  /** GitHub accepts an issue and drops its milestone. */
  dropMilestone = false;
  private next = 1;
  /** The next GET of `route` waits until released, as a slow GitHub answer would. */
  private hold: { route: string; reached: boolean; release: () => void; released: Promise<void> } | null = null;

  holdNext(route: string): { reached: () => boolean; release: () => void } {
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const hold = { route, reached: false, release, released };
    this.hold = hold;
    return { reached: () => hold.reached, release };
  }

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
    const hold = this.hold;
    if (method === "GET" && hold !== null && route === hold.route) {
      this.hold = null;
      hold.reached = true;
      await hold.released;
    }
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
        const status = this.fault!.status;
        this.fault = null;
        if (status !== undefined) throw acpError(ReasonCode.INTERNAL_ERROR, `gh api POST ${path} failed: (HTTP ${status})`, { status, method, path });
        throw new Error("HTTP 502 before GitHub acted");
      }
      const value = body as Record<string, unknown>;
      if (faulted && this.fault!.when === "late") {
        this.fault = null;
        const milestone = this.milestones.find((m) => m.number === value["milestone"]) ?? null;
        this.landing.push(() => { this.addIssue(String(value["title"]), String(value["body"]), milestone); });
        throw new Error("timed out waiting for GitHub's answer");
      }
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
const planSubmit = (g: Governed, workUnits: unknown, tasks?: unknown[], summary = "work units") =>
  callCtoTool(g.h, g.owner, "plan_submit", { idempotencyKey: `plan-${Math.random()}`, runId: g.runId, plan: { summary, workUnits }, ...(tasks === undefined ? {} : { tasks }) });

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
/** Every create intent of the run that was retired, with why. */
const intentsOf = (g: Governed) => g.h.cp.audit.byKind("WORK_SCOPE_GITHUB_INTENT_RETIRED").filter((row) => row.runId === g.runId).map((row) => {
  const e = row.evidence as { outcome: string; status?: number };
  return { outcome: e.outcome, ...(e.status === undefined ? {} : { status: e.status }) };
});
const unresolved = (answer: Record<string, unknown>) => unmetOf(tracking(answer)).filter((u) => u.unmet === "WORK_SCOPE_CREATION_UNRESOLVED");

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
    g.github.fault = { suffix: "/issues", when: "late" };
    const added = await planSubmit(g, [feed, { key: "roundup", tasks: ["roundup"], issue: { new: { title: "Weekly verdict roundup", body: "Collect" } }, milestone: { number: 1 } }], [{ key: "roundup", title: "Build the weekly roundup", category: "implementation" }]);
    expect(tracking(added)).toMatchObject({ tracked: false });
    const roundup = g.h.cp.tasks.list(g.runId).find((t) => t.title === "Build the weekly roundup")!.taskId;
    const seen = g.github.calls.length;
    expect(startExecution(g, impl).allowed).toBe(true);
    expect((await provision(g, impl))["reasonCode"]).not.toBe(REFUSED);
    expect(g.github.calls.length).toBe(seen);
    // The outage's request may still land: nothing is sent again for roundup until it is known.
    expect(startExecution(g, roundup).reasonCode).toBe(REFUSED);
    expect((await startWorkerExecution(g, roundup)).reasonCode).toBe(REFUSED);
    g.github.land();
    expect((await startWorkerExecution(g, roundup)).allowed).toBe(true);
    expect(g.github.posts("/issues")).toHaveLength(1);
    expect(g.github.issues.filter((i) => i.title === "Weekly verdict roundup")).toHaveLength(1);
  });

  it("an approval that is not the run's current owner's creates nothing", async () => {
    const g = await governedRun({ legacy: LEGACY.slice(0, 1) });
    const [impl] = g.taskIds as [string];
    const units = [{ key: "roundup", tasks: [impl], issue: { new: { title: "Weekly verdict roundup", body: "Collect" } }, milestone: { number: 1 } }];
    g.github.fault = { suffix: "/issues", when: "before", status: 422 };
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

  it("review P1-a: a PLAN superseded while its synchronization waits on GitHub publishes nothing", async () => {
    const g = await governedRun({ legacy: LEGACY.slice(0, 1) });
    const [impl] = g.taskIds as [string];
    g.github.fault = { suffix: "/issues", when: "before", status: 422 };
    expect(tracking(await planSubmit(g, [{ key: "roundup", tasks: [impl], issue: { new: { title: "Weekly verdict roundup", body: "Collect" } }, milestone: { number: 1 } }]))).toMatchObject({ tracked: false });
    // PLAN A's synchronization is paused on GitHub's read; PLAN B, adopting #3 instead, is accepted meanwhile.
    const hold = g.github.holdNext(`${ROOT}/milestones`);
    const syncA = g.h.cp.tasks.ensureWorkScopeTracked(g.runId, impl);
    await vi.waitFor(() => expect(hold.reached()).toBe(true));
    const planB = planSubmit(g, [{ key: "feed", tasks: [impl], issue: { number: 3 }, milestone: { number: 1 } }]);
    await vi.waitFor(() => expect(g.h.cp.audit.byKind("WORK_SCOPE_APPROVED").filter((row) => row.runId === g.runId)).toHaveLength(2));
    hold.release();
    const a = await syncA;
    expect(a.allowed).toBe(false);
    expect(a.evidence).toMatchObject({ causeRefusal: "WORK_SCOPE_PLAN_SUPERSEDED" });
    expect(tracking(await planB)).toMatchObject({ tracked: true });
    expect(g.github.issues.filter((i) => i.title === "Weekly verdict roundup")).toEqual([]);
    expect(g.github.posts("/issues")).toHaveLength(1);
  });

  it("review P1-b: adding a task to a verified unit re-verifies its link before the task is admitted", async () => {
    const g = await governedRun({ legacy: LEGACY.slice(0, 1) });
    const [impl] = g.taskIds as [string];
    expect(tracking(await planSubmit(g, [{ key: "feed", tasks: [impl], issue: { number: 3 }, milestone: { number: 1 } }]))).toMatchObject({ tracked: true });
    // #3's milestone link is removed on GitHub; then the unit grows by a task.
    g.github.issues.find((i) => i.number === 3)!.milestone = null;
    const seen = g.github.calls.length;
    const grown = await planSubmit(g, [{ key: "feed", tasks: [impl, "review"], issue: { number: 3 }, milestone: { number: 1 } }], [{ key: "review", title: "Review the verdict feed", category: "review" }]);
    expect(g.github.calls.length).toBeGreaterThan(seen);
    expect(unmetOf(tracking(grown)).map((u) => [u.unit, u.unmet])).toEqual([["feed", "MILESTONE_LINK_MISSING"]]);
    const review = g.h.cp.tasks.list(g.runId).find((t) => t.title === "Review the verdict feed")!.taskId;
    expect(startExecution(g, review).reasonCode).toBe(REFUSED);
  });

  it("review P1-c: a local path is refused behind any delimiter, and only a path", async () => {
    const g = await governedRun({ legacy: LEGACY.slice(0, 1) });
    const [impl] = g.taskIds as [string];
    const scope = g.h.cp.tasks.workScope!;
    const declare = (text: string) => scope.declare(g.runId, { workUnits: [{ key: "notes", tasks: [impl], issue: { new: { title: "Notes", body: text } }, milestone: { number: 1 } }] }, []);
    for (const text of [
      "See </Users/isaac/private-notes.md>", "\"/home/isaac/x\"", "'/tmp/x'", "`/var/folders/x`", "(/opt/x)", "[/etc/x]", "{/private/x}",
      "a|/Users/isaac/x", "key=/Users/isaac/x", "at:/Users/isaac/x", "file:///Users/isaac/x", "<C:\\Users\\isaac>", "/Users/isaac/x at the start",
    ]) {
      expect(declare(text), text).toMatchObject({ allowed: false, evidence: { refusal: "WORK_UNITS_TEXT_NOT_PUBLIC" } });
    }
    for (const text of ["https://example.com/Users/guide", "docs/home/readme", "the /Users-facing page"]) {
      expect(declare(text).allowed, text).toBe(true);
    }
  });

  it("review P2-a: a unit re-declared with other text is not certified by the issue created for its old text", async () => {
    const g = await governedRun({ legacy: LEGACY.slice(0, 1) });
    const [impl] = g.taskIds as [string];
    expect(tracking(await planSubmit(g, [{ key: "feed-x", tasks: [impl], issue: { new: { title: "Add feed filtering", body: "Filter the feed" } }, milestone: { number: 1 } }]))).toMatchObject({ tracked: true });
    const created = g.github.issues.find((i) => i.title === "Add feed filtering")!;
    const redeclared = await planSubmit(g, [{ key: "feed-x", tasks: [impl], issue: { new: { title: "Add feed export", body: "Export the feed" } }, milestone: { number: 1 } }]);
    expect(unmetOf(tracking(redeclared))).toMatchObject([{ unit: "feed-x", unmet: "ISSUE_TEXT_DIFFERS", issues: [created.number] }]);
    expect(g.github.calls.filter((c) => c.method !== "GET")).toHaveLength(1);
    expect(startExecution(g, impl).reasonCode).toBe(REFUSED);
  });

  it("review R2 P1-a: an owner revoked while the synchronization waits on GitHub publishes nothing", async () => {
    const g = await governedRun({ legacy: LEGACY.slice(0, 1) });
    const [impl] = g.taskIds as [string];
    g.github.fault = { suffix: "/issues", when: "before", status: 422 };
    expect(tracking(await planSubmit(g, [{ key: "roundup", tasks: [impl], issue: { new: { title: "Weekly verdict roundup", body: "Collect" } }, milestone: { number: 1 } }]))).toMatchObject({ tracked: false });
    const hold = g.github.holdNext(`${ROOT}/milestones`);
    const sync = g.h.cp.tasks.ensureWorkScopeTracked(g.runId, impl);
    await vi.waitFor(() => expect(hold.reached()).toBe(true));
    // The run is held and its owner's binding revoked: ACP's own owner check no longer admits that owner.
    const run = g.h.cp.runs.require(g.runId);
    expect(g.h.cp.runs.transition(g.runId, RunState.BLOCKED, "test hold").allowed).toBe(true);
    expect(g.h.cp.bindings.revoke(run.ownerRoleKey!, "test revocation", { allowBlockedRuns: true }).allowed).toBe(true);
    expect(g.h.cp.runs.assertOwner(g.runId, run.ownerSessionId!, run.ownerBindingGeneration!).allowed).toBe(false);
    hold.release();
    const answer = await sync;
    expect(answer.allowed).toBe(false);
    expect(answer.evidence).toMatchObject({ causeRefusal: "WORK_SCOPE_APPROVAL_NOT_CURRENT_OWNER" });
    expect(g.github.issues.filter((i) => i.title === "Weekly verdict roundup")).toEqual([]);
    expect(g.github.posts("/issues")).toHaveLength(1);
  });

  it("review R2 P1-b: restoring an earlier mapping never revives the verification it had before a scope change", async () => {
    // The intervening mapping verified (#4), or never verified (#99, not an issue): both invalidate #3's receipt.
    for (const between of [4, 99]) {
      const g = await governedRun({ legacy: LEGACY.slice(0, 1) });
      const [impl] = g.taskIds as [string];
      const at3 = { key: "feed", tasks: [impl], issue: { number: 3 }, milestone: { number: 1 } };
      expect(tracking(await planSubmit(g, [at3]))).toMatchObject({ tracked: true });
      await planSubmit(g, [{ ...at3, issue: { number: between } }]);
      g.github.issues.find((i) => i.number === 3)!.milestone = null;
      const seen = g.github.calls.length;
      const restored = await planSubmit(g, [at3], undefined, "restored");
      expect(g.github.calls.length, `between #${between}`).toBeGreaterThan(seen);
      expect(unmetOf(tracking(restored)).map((u) => [u.unit, u.unmet]), `between #${between}`).toEqual([["feed", "MILESTONE_LINK_MISSING"]]);
      expect(startExecution(g, impl).reasonCode).toBe(REFUSED);
    }
  });

  it("review R2 P1-c: home-relative, environment and Windows paths are refused like absolute ones; URL paths are not", async () => {
    const g = await governedRun({ legacy: LEGACY.slice(0, 1) });
    const [impl] = g.taskIds as [string];
    const scope = g.h.cp.tasks.workScope!;
    const declare = (text: string) => scope.declare(g.runId, { workUnits: [{ key: "notes", tasks: [impl], issue: { new: { title: "Notes", body: text } }, milestone: { number: 1 } }] }, []);
    for (const text of [
      "See ~/.hermes/private-notes.md", "~isaac/notes.md", "(~/x)", "<~/x>", "path=~/x", "$HOME/notes", "${HOME}/notes", "<$HOME/x>",
      "%USERPROFILE%\\notes", "C:\\Users\\isaac\\notes", "see D:/work/notes", "https://example.com/a?path=/Users/isaac/x", "file:///Users/isaac/x",
    ]) {
      expect(declare(text), text).toMatchObject({ allowed: false, evidence: { refusal: "WORK_UNITS_TEXT_NOT_PUBLIC" } });
    }
    for (const text of ["https://example.com/~user/page", "https://example.com/Users/guide", "about ~5 minutes", "costs ~$5", "https://example.com/a?b=c", "the $HOMEPAGE link"]) {
      expect(declare(text).allowed, text).toBe(true);
    }
  });

  it("review R2 P2: re-submitting an identical earlier PLAN makes it the current PLAN again", async () => {
    const g = await governedRun({ legacy: LEGACY.slice(0, 1) });
    const [impl] = g.taskIds as [string];
    const planA = [{ key: "feed", tasks: [impl], issue: { number: 3 }, milestone: { number: 1 } }];
    expect(tracking(await planSubmit(g, planA))).toMatchObject({ tracked: true });
    expect(tracking(await planSubmit(g, [{ ...planA[0]!, issue: { number: 4 } }]))).toMatchObject({ tracked: true });
    expect(tracking(await planSubmit(g, planA))).toMatchObject({ tracked: true });
    const current = g.h.cp.artifacts.latest<{ workUnits: Array<{ issue: unknown }> }>(g.runId, ArtifactKind.PLAN)!;
    expect(current.content.workUnits[0]!.issue).toEqual({ number: 3 });
    expect(startExecution(g, impl).allowed).toBe(true);
  });

  it("review R3 P1-a: a file URL is screened whatever its host; only an http(s) URL with a real host is set aside", async () => {
    const g = await governedRun({ legacy: LEGACY.slice(0, 1) });
    const [impl] = g.taskIds as [string];
    const scope = g.h.cp.tasks.workScope!;
    const declare = (text: string) => scope.declare(g.runId, { workUnits: [{ key: "notes", tasks: [impl], issue: { new: { title: "Notes", body: text } }, milestone: { number: 1 } }] }, []);
    for (const text of [
      "file://localhost/Users/isaac/x", "file:///Users/isaac/x", "FILE://host/Users/isaac/x",
      "file://localhost/~/notes", "file:///~isaac/notes", "file://host/C:/Users/isaac/x", "file:///C:/x",
      "http://localhost/Users/isaac/x", "http://127.0.0.1:8080/home/isaac/x", "file:///srv/data/x",
    ]) {
      expect(declare(text), text).toMatchObject({ allowed: false, evidence: { refusal: "WORK_UNITS_TEXT_NOT_PUBLIC" } });
    }
    for (const text of ["https://example.com/Users/guide", "https://example.com/~user/page", "http://example.org/home/x/"]) {
      expect(declare(text).allowed, text).toBe(true);
    }
  });

  it("review R3 P1-b: every published field is screened on its own, so a whole-value key is caught in any of them", async () => {
    const g = await governedRun({ legacy: LEGACY.slice(0, 1) });
    const [impl] = g.taskIds as [string];
    const scope = g.h.cp.tasks.workScope!;
    const key = "a".repeat(32) + "0123456789abcdef0123456789abcdef";
    const declare = (issue: { title: string; body: string }, milestone: { title: string; description: string }) =>
      scope.declare(g.runId, { workUnits: [{ key: "notes", tasks: [impl], issue: { new: issue }, milestone: { new: milestone } }] }, []);
    const fine = { title: "Notes", body: "plain" };
    const stage = { title: "Stage", description: "plain" };
    for (const [issue, milestone, field] of [
      [{ title: "Notes", body: key }, stage, "issue body"],
      [{ title: key, body: "plain" }, stage, "issue title"],
      [fine, { title: "Stage", description: key }, "milestone description"],
      [fine, { title: key, description: "plain" }, "milestone title"],
    ] as const) {
      expect(declare(issue, milestone), field).toMatchObject({ allowed: false, evidence: { refusal: "WORK_UNITS_TEXT_NOT_PUBLIC" } });
    }
    expect(declare(fine, stage).allowed).toBe(true);
  });

  it("review R3 P2-a: renaming a unit keeps its tasks' earlier link; a new issue for tracked work is refused by name", async () => {
    const g = await governedRun({ legacy: [LEGACY[0]!, LEGACY[2]!] });
    const [impl, short] = g.taskIds as [string, string];
    expect(tracking(await planSubmit(g, [
      { key: "feed", tasks: [impl], issue: { new: { title: "Add feed filtering", body: "Filter the feed" } }, milestone: { number: 1 } },
      { key: "short", tasks: [short], issue: { number: 5 }, milestone: { number: 2 } },
    ]))).toMatchObject({ tracked: true });
    const created = g.github.issues.find((i) => i.title === "Add feed filtering")!;
    const posts = g.github.posts("/issues").length;
    const renamed = await planSubmit(g, [
      { key: "feed-v2", tasks: [impl], issue: { new: { title: "Feed filtering, second cut", body: "Filter the feed" } }, milestone: { number: 1 } },
      { key: "daily", tasks: [short], issue: { new: { title: "Daily short, second take", body: "One a day" } }, milestone: { number: 2 } },
    ], undefined, "renamed");
    expect(unmetOf(tracking(renamed)).map((u) => [u.unit, u.unmet, u.issues])).toEqual([
      ["feed-v2", "TASK_ALREADY_TRACKED", [created.number]],
      ["daily", "TASK_ALREADY_TRACKED", [5]],
    ]);
    expect(unmetOf(tracking(renamed))[0]!.correction).toBe(`task ${impl} is already tracked by #${created.number}; adopt it by number`);
    expect(g.github.posts("/issues")).toHaveLength(posts);
    expect(startExecution(g, impl).reasonCode).toBe(REFUSED);
  });

  it("review R3 P2-b: PLAN A, B, A, B are each accepted, each the current PLAN with its own approval", async () => {
    const g = await governedRun({ legacy: LEGACY.slice(0, 1) });
    const [impl] = g.taskIds as [string];
    const planA = [{ key: "feed", tasks: [impl], issue: { number: 3 }, milestone: { number: 1 } }];
    const planB = [{ key: "feed", tasks: [impl], issue: { number: 4 }, milestone: { number: 1 } }];
    for (const [units, issue] of [[planA, 3], [planB, 4], [planA, 3], [planB, 4]] as const) {
      const answer = await planSubmit(g, units);
      expect(answer["ok"], `#${issue}`).toBe(true);
      expect(tracking(answer), `#${issue}`).toMatchObject({ tracked: true });
      const current = g.h.cp.artifacts.latest<{ workUnits: Array<{ issue: unknown }> }>(g.runId, ArtifactKind.PLAN)!;
      expect(current.content.workUnits[0]!.issue).toEqual({ number: issue });
      const approval = g.h.cp.audit.byKind("WORK_SCOPE_APPROVED").filter((row) => row.runId === g.runId).at(-1)!.evidence as { planDigest: string };
      expect(approval.planDigest).toBe(current.digest);
      expect(startExecution(g, impl).allowed).toBe(true);
      g.h.cp.tasks.finishExecution(g.h.cp.tasks.executions(g.runId).at(-1)!.executionId, { status: "FAILED", resultDigest: null, failureClass: "transient" });
    }
  });

  it("review R3 P2-c: a refused plan_submit leaves the accepted PLAN and its approval current", async () => {
    const g = await governedRun({ legacy: LEGACY.slice(0, 1) });
    const [impl] = g.taskIds as [string];
    expect(tracking(await planSubmit(g, [{ key: "feed", tasks: [impl], issue: { number: 3 }, milestone: { number: 1 } }]))).toMatchObject({ tracked: true });
    const plan = g.h.cp.artifacts.latest(g.runId, ArtifactKind.PLAN)!.digest;
    const approvals = g.h.cp.audit.byKind("WORK_SCOPE_APPROVED").filter((row) => row.runId === g.runId).length;
    // PLAN B's units are well formed, but its task depends on one that does not exist: the task graph refuses it.
    const refused = await planSubmit(g, [
      { key: "feed", tasks: [impl], issue: { number: 3 }, milestone: { number: 1 } },
      { key: "detail", tasks: ["detail"], issue: { number: 4 }, milestone: { number: 1 } },
    ], [{ key: "detail", title: "Verdict detail page", category: "implementation", dependsOn: ["no-such-task"] }], "B");
    expect(refused["ok"]).toBe(false);
    expect(g.h.cp.artifacts.latest(g.runId, ArtifactKind.PLAN)!.digest).toBe(plan);
    expect(g.h.cp.audit.byKind("WORK_SCOPE_APPROVED").filter((row) => row.runId === g.runId)).toHaveLength(approvals);
    expect(g.h.cp.tasks.list(g.runId)).toHaveLength(1);
    expect(startExecution(g, impl).allowed).toBe(true);
  });

  it("review R4 P2: a unit renamed after GitHub created its issue and lost the answer gains no second issue", async () => {
    const g = await governedRun({ legacy: LEGACY.slice(0, 1) });
    const [impl] = g.taskIds as [string];
    // GitHub creates `feed`'s issue, and the call throws before ACP hears the answer.
    g.github.fault = { suffix: "/issues", when: "after" };
    expect(tracking(await planSubmit(g, [{ key: "feed", tasks: [impl], issue: { new: { title: "Add feed filtering", body: "Filter the feed" } }, milestone: { number: 1 } }]))).toMatchObject({ tracked: false });
    const first = g.github.issues.find((i) => i.title === "Add feed filtering")!;
    // The identical task, resubmitted under another unit key with another issue title.
    const renamed = await planSubmit(g, [{ key: "feed-renamed", tasks: [impl], issue: { new: { title: "Feed filtering, renamed", body: "Filter the feed" } }, milestone: { number: 1 } }], undefined, "renamed");
    expect(unmetOf(tracking(renamed)).map((u) => [u.unit, u.unmet, u.issues])).toEqual([["feed-renamed", "TASK_ALREADY_TRACKED", [first.number]]]);
    expect(unmetOf(tracking(renamed))[0]!.correction).toBe(`task ${impl} is already tracked by #${first.number}; adopt it by number`);
    expect(g.github.posts("/issues")).toHaveLength(1);
    expect(g.github.issues.filter((i) => i.title === "Feed filtering, renamed")).toEqual([]);
    expect(startExecution(g, impl).reasonCode).toBe(REFUSED);
    // Adopting it by number tracks the task.
    expect(tracking(await planSubmit(g, [{ key: "feed-renamed", tasks: [impl], issue: { number: first.number }, milestone: { number: 1 } }], undefined, "adopted"))).toMatchObject({ tracked: true });
    expect(startExecution(g, impl).allowed).toBe(true);
  });

  it("review R5: a definite 4xx is retired at once, and the renamed unit's issue is created once", async () => {
    const g = await governedRun({ legacy: LEGACY.slice(0, 1) });
    const [impl] = g.taskIds as [string];
    g.github.fault = { suffix: "/issues", when: "before", status: 422 };
    expect(tracking(await planSubmit(g, [{ key: "feed", tasks: [impl], issue: { new: { title: "Add feed filtering", body: "Filter the feed" } }, milestone: { number: 1 } }]))).toMatchObject({ tracked: false });
    expect(g.github.issues.filter((i) => i.title === "Add feed filtering")).toEqual([]);
    expect(intentsOf(g)).toEqual([{ outcome: "DEFINITE_NOT_CREATED", status: 422 }]);
    const renamed = await planSubmit(g, [{ key: "feed-renamed", tasks: [impl], issue: { new: { title: "Feed filtering, renamed", body: "Filter the feed" } }, milestone: { number: 1 } }], undefined, "renamed");
    expect(tracking(renamed)).toMatchObject({ tracked: true });
    expect(g.github.issues.filter((i) => /feed filtering/i.test(i.title)).map((i) => i.title)).toEqual(["Feed filtering, renamed"]);
  });

  it("review R4 P2 (milestones): a new milestone whose answer was lost is found again by its title's marker under a renamed unit", async () => {
    const g = await governedRun({ legacy: LEGACY.slice(0, 1) });
    const [impl] = g.taskIds as [string];
    g.github.fault = { suffix: "/milestones", when: "after" };
    const stage = { new: { title: "채널 성장: 구독자 10,000명", description: "The next growth goal" } };
    expect(tracking(await planSubmit(g, [{ key: "feed", tasks: [impl], issue: { number: 3 }, milestone: stage }]))).toMatchObject({ tracked: false });
    const renamed = await planSubmit(g, [{ key: "feed-renamed", tasks: [impl], issue: { new: { title: "Grow to ten thousand", body: "Plan" } }, milestone: stage }], undefined, "renamed");
    expect(tracking(renamed)).toMatchObject({ tracked: true });
    expect(g.github.milestones.filter((m) => m.title === stage.new.title)).toHaveLength(1);
    expect(g.github.posts("/milestones")).toHaveLength(1);
  });

  it("review R5 P2-a: an intent links only to the issue its own POST created, never to another reuse of the unit key", async () => {
    // A's POST fails, definitely (422) or with an unknown outcome (502); `feed` is reused for B, whose created issue's answer is lost.
    for (const status of [422, 502]) {
      const g = await governedRun({ legacy: [LEGACY[0]!, LEGACY[2]!] });
      const [impl, short] = g.taskIds as [string, string];
      g.github.fault = { suffix: "/issues", when: "before", status };
      await planSubmit(g, [
        { key: "feed", tasks: [impl], issue: { new: { title: "Add feed filtering", body: "Filter" } }, milestone: { number: 1 } },
        { key: "short", tasks: [short], issue: { number: 5 }, milestone: { number: 2 } },
      ]);
      g.github.fault = { suffix: "/issues", when: "after" };
      const reused = [
        { key: "feed", tasks: [short], issue: { new: { title: "Daily short pipeline", body: "Shorts" } }, milestone: { number: 2 } },
        { key: "a-unit", tasks: [impl], issue: { new: { title: "Feed filtering", body: "Filter" } }, milestone: { number: 1 } },
      ];
      await planSubmit(g, reused, undefined, `reused ${status}`);
      const next = await planSubmit(g, reused, undefined, `next ${status}`);
      const unmet = unmetOf(tracking(next));
      // A is never taken for tracked by B's issue.
      expect(unmet.filter((u) => u.unmet === "TASK_ALREADY_TRACKED"), `${status}`).toEqual([]);
      expect(g.github.issues.filter((i) => i.title === "Daily short pipeline"), `${status}`).toHaveLength(1);
      if (status === 422) {
        expect(tracking(next), "422").toMatchObject({ tracked: true });
        expect(g.github.issues.filter((i) => i.title === "Feed filtering"), "422").toHaveLength(1);
      } else {
        expect(unmet.map((u) => [u.unit, u.unmet]), "502").toEqual([["a-unit", "WORK_SCOPE_CREATION_UNRESOLVED"]]);
        expect(g.github.issues.filter((i) => i.title === "Feed filtering"), "502").toEqual([]);
      }
      expect(startExecution(g, short).allowed, `${status}: B is tracked by its own issue`).toBe(true);
    }
  });

  it("review R5 P2-b: a POST still in flight blocks a renamed or re-planned create for its task; when it lands it is linked, and nothing is sent twice", async () => {
    const g = await governedRun({ legacy: [LEGACY[0]!, LEGACY[2]!] });
    const [impl, short] = g.taskIds as [string, string];
    const shortUnit = { key: "short", tasks: [short], issue: { number: 5 }, milestone: { number: 2 } };
    g.github.fault = { suffix: "/issues", when: "late" };
    expect(tracking(await planSubmit(g, [{ key: "feed", tasks: [impl], issue: { new: { title: "Add feed filtering", body: "Filter" } }, milestone: { number: 1 } }, shortUnit]))).toMatchObject({ tracked: false });
    // Renamed, then re-planned with other text: both refused, retryably, while the first may still land.
    for (const [key, title, summary] of [["feed-renamed", "Feed filtering, renamed", "renamed"], ["filters", "Filters for the feed", "re-planned"]] as const) {
      const retried = await planSubmit(g, [{ key, tasks: [impl], issue: { new: { title, body: "Filter" } }, milestone: { number: 1 } }, shortUnit], undefined, summary);
      expect(unresolved(retried).map((u) => u.unit), summary).toEqual([key]);
      expect(unresolved(retried)[0]!.correction).toMatch(/may still land/);
    }
    expect(g.github.posts("/issues")).toHaveLength(1);
    expect(startExecution(g, impl).reasonCode).toBe(REFUSED);
    // GitHub completes the first POST: the next sync links it by its own token.
    g.github.land();
    const first = g.github.issues.find((i) => i.title === "Add feed filtering")!;
    const linked = await planSubmit(g, [{ key: "filters", tasks: [impl], issue: { new: { title: "Filters for the feed", body: "Filter" } }, milestone: { number: 1 } }, shortUnit], undefined, "after landing");
    expect(unmetOf(tracking(linked)).map((u) => [u.unit, u.unmet, u.issues])).toEqual([["filters", "TASK_ALREADY_TRACKED", [first.number]]]);
    expect(g.github.posts("/issues")).toHaveLength(1);
    expect(intentsOf(g)).toEqual([]);
  });

  it("review R5: a delayed completion is linked by the next sync of the same unit, and no second issue is created", async () => {
    const g = await governedRun({ legacy: LEGACY.slice(0, 1) });
    const [impl] = g.taskIds as [string];
    const feed = [{ key: "feed", tasks: [impl], issue: { new: { title: "Add feed filtering", body: "Filter" } }, milestone: { number: 1 } }];
    g.github.fault = { suffix: "/issues", when: "late" };
    expect(tracking(await planSubmit(g, feed))).toMatchObject({ tracked: false });
    expect(unresolved(await planSubmit(g, feed, undefined, "retry")).map((u) => u.unit)).toEqual(["feed"]);
    g.github.land();
    expect(tracking(await planSubmit(g, feed, undefined, "landed"))).toMatchObject({ tracked: true });
    expect(g.github.posts("/issues")).toHaveLength(1);
    expect(g.github.issues.filter((i) => i.title === "Add feed filtering")).toHaveLength(1);
    expect(startExecution(g, impl).allowed).toBe(true);
  });

  it("review R5: an unknown create holds back only its own tasks; an unrelated unit is created and admitted", async () => {
    const g = await governedRun({ legacy: [LEGACY[0]!, LEGACY[2]!] });
    const [impl, short] = g.taskIds as [string, string];
    g.github.fault = { suffix: "/issues", when: "late" };
    const units = [
      { key: "feed", tasks: [impl], issue: { new: { title: "Add feed filtering", body: "Filter" } }, milestone: { number: 1 } },
      { key: "short", tasks: [short], issue: { new: { title: "Daily short pipeline", body: "Shorts" } }, milestone: { number: 2 } },
    ];
    await planSubmit(g, units);
    const again = await planSubmit(g, units, undefined, "again");
    expect(unmetOf(tracking(again)).map((u) => [u.unit, u.unmet])).toEqual([["feed", "WORK_SCOPE_CREATION_UNRESOLVED"]]);
    expect(g.github.issues.filter((i) => i.title === "Daily short pipeline")).toHaveLength(1);
    expect(startExecution(g, short).allowed).toBe(true);
    expect(startExecution(g, impl).reasonCode).toBe(REFUSED);
  });

  it("review R5: while a create is unknown, adopting an existing issue by number is verified and then allowed", async () => {
    const g = await governedRun({ legacy: LEGACY.slice(0, 1) });
    const [impl] = g.taskIds as [string];
    const feed = [{ key: "feed", tasks: [impl], issue: { new: { title: "Add feed filtering", body: "Filter" } }, milestone: { number: 1 } }];
    g.github.fault = { suffix: "/issues", when: "late" };
    await planSubmit(g, feed);
    expect(unresolved(await planSubmit(g, feed, undefined, "retry"))).toHaveLength(1);
    // Adoption is verified as always: #8 is not in milestone 2.
    const wrong = await planSubmit(g, [{ key: "feed", tasks: [impl], issue: { number: 8 }, milestone: { number: 2 } }], undefined, "wrong");
    expect(unmetOf(tracking(wrong)).map((u) => u.unmet)).toEqual(["MILESTONE_LINK_WRONG"]);
    const adopted = await planSubmit(g, [{ key: "feed", tasks: [impl], issue: { number: 3 }, milestone: { number: 1 } }], undefined, "adopted");
    expect(tracking(adopted)).toMatchObject({ tracked: true });
    expect(startExecution(g, impl).allowed).toBe(true);
    expect(g.github.posts("/issues")).toHaveLength(1);
    expect(intentsOf(g)).toEqual([]);
  });

  it("merge #1239: a refused work-unit plan_submit that names supersedesTaskIds cancels nothing; the earlier PLAN and approval stay current", async () => {
    const g = await governedRun({ legacy: LEGACY.slice(0, 2) });
    const [impl, review] = g.taskIds as [string, string];
    const feed = { key: "feed", tasks: [impl], issue: { number: 3 }, milestone: { number: 1 } };
    expect(tracking(await planSubmit(g, [feed, { key: "detail", tasks: [review], issue: { number: 4 }, milestone: { number: 1 } }]))).toMatchObject({ tracked: true });
    const plan = g.h.cp.artifacts.latest(g.runId, ArtifactKind.PLAN)!.digest;
    const approvals = () => g.h.cp.audit.byKind("WORK_SCOPE_APPROVED").filter((row) => row.runId === g.runId).length;
    const before = approvals();
    const superseding = (dependsOn: string[]) => callCtoTool(g.h, g.owner, "plan_submit", {
      idempotencyKey: `plan-${Math.random()}`, runId: g.runId,
      plan: { summary: "replace the detail page", supersedesTaskIds: [review], workUnits: [feed, { key: "detail2", tasks: ["detail2"], issue: { number: 6 }, milestone: { number: 2 } }] },
      tasks: [{ key: "detail2", title: "Verdict detail, second cut", category: "implementation", dependsOn }],
    });
    const unchanged = () => {
      expect(g.h.cp.tasks.get(review)!.state).toBe("READY");
      expect(g.h.cp.artifacts.latest(g.runId, ArtifactKind.PLAN)!.digest).toBe(plan);
      expect(approvals()).toBe(before);
      expect(g.h.cp.audit.byKind("STANDARD_WORK_TASKS_SUPERSEDED").filter((row) => row.runId === g.runId)).toEqual([]);
      expect(g.h.cp.tasks.list(g.runId)).toHaveLength(2);
    };
    // Refused by the task graph: the new task depends on one that does not exist.
    expect((await superseding(["no-such-task"]))["ok"]).toBe(false);
    unchanged();
    // Refused after the cancel already ran inside the transaction: the cancel is rolled back with the rest.
    const scope = g.h.cp.tasks.workScope!;
    const approve = vi.spyOn(scope, "approve").mockReturnValue(deny(ReasonCode.CONFLICT, "approval refused for the witness", {}));
    expect((await superseding([]))).toMatchObject({ ok: false, reasonCode: "CONFLICT" });
    expect(approve).toHaveBeenCalledTimes(1);
    approve.mockRestore();
    unchanged();
    expect(startExecution(g, impl).allowed).toBe(true);
  });

  it("merge #1239: an accepted work-unit plan_submit cancels the named tasks and records STANDARD_WORK_TASKS_SUPERSEDED with its PLAN", async () => {
    const g = await governedRun({ legacy: LEGACY.slice(0, 2) });
    const [impl, review] = g.taskIds as [string, string];
    const feed = { key: "feed", tasks: [impl], issue: { number: 3 }, milestone: { number: 1 } };
    expect(tracking(await planSubmit(g, [feed, { key: "detail", tasks: [review], issue: { number: 4 }, milestone: { number: 1 } }]))).toMatchObject({ tracked: true });
    // A unit may not name a task the PLAN supersedes: it is cancelled with the PLAN.
    const naming = await callCtoTool(g.h, g.owner, "plan_submit", {
      idempotencyKey: "plan-naming", runId: g.runId,
      plan: { summary: "keep naming it", supersedesTaskIds: [review], workUnits: [feed, { key: "detail", tasks: [review, "detail2"], issue: { number: 4 }, milestone: { number: 1 } }] },
      tasks: [{ key: "detail2", title: "Verdict detail, second cut", category: "implementation" }],
    });
    expect(naming).toMatchObject({ ok: false, evidence: { refusal: "WORK_UNITS_TASKS_UNMAPPED", unknown: [review] } });
    expect(g.h.cp.tasks.get(review)!.state).toBe("READY");
    const accepted = await callCtoTool(g.h, g.owner, "plan_submit", {
      idempotencyKey: "plan-accepted", runId: g.runId,
      plan: { summary: "replace the detail page", supersedesTaskIds: [review], workUnits: [feed, { key: "detail2", tasks: ["detail2"], issue: { number: 6 }, milestone: { number: 2 } }] },
      tasks: [{ key: "detail2", title: "Verdict detail, second cut", category: "implementation" }],
    });
    expect(accepted["ok"]).toBe(true);
    expect(tracking(accepted)).toMatchObject({ tracked: true });
    expect(g.h.cp.tasks.get(review)!.state).toBe("CANCELLED");
    const plan = g.h.cp.artifacts.latest(g.runId, ArtifactKind.PLAN)!.digest;
    const superseded = g.h.cp.audit.byKind("STANDARD_WORK_TASKS_SUPERSEDED").filter((row) => row.runId === g.runId).map((row) => row.evidence as { planDigest: string; cancelled: string[] });
    expect(superseded).toEqual([expect.objectContaining({ planDigest: plan, cancelled: [review] })]);
    const approval = g.h.cp.audit.byKind("WORK_SCOPE_APPROVED").filter((row) => row.runId === g.runId).at(-1)!.evidence as { planDigest: string };
    expect(approval.planDigest).toBe(plan);
    const detail2 = g.h.cp.tasks.list(g.runId).find((t) => t.title === "Verdict detail, second cut")!.taskId;
    expect(startExecution(g, detail2).allowed).toBe(true);
  });

  it("merge #1239: a unit whose only tasks were superseded no longer blocks admission or confirmation", async () => {
    const g = await governedRun({ legacy: LEGACY.slice(0, 2) });
    const [impl, review] = g.taskIds as [string, string];
    const feed = { key: "feed", tasks: [impl], issue: { number: 3 }, milestone: { number: 1 } };
    // `detail` adopts #8 in milestone 2, but #8 is in milestone 3: it is never tracked, and holds the run back.
    await planSubmit(g, [feed, { key: "detail", tasks: [review], issue: { number: 8 }, milestone: { number: 2 } }]);
    const scope = g.h.cp.tasks.workScope!;
    expect(scope.assertSettled(g.runId)).toMatchObject({ allowed: false, evidence: { untracked: [{ unit: "detail" }] } });
    expect(startExecution(g, review).reasonCode).toBe(REFUSED);
    // A re-plan supersedes the detail task: its unit is gone, and nothing it covered blocks the run.
    const replaced = await callCtoTool(g.h, g.owner, "plan_submit", {
      idempotencyKey: "plan-supersede", runId: g.runId,
      plan: { summary: "drop the detail page", supersedesTaskIds: [review], workUnits: [feed, { key: "docs", tasks: ["docs"], issue: { number: 6 }, milestone: { number: 2 } }] },
      tasks: [{ key: "docs", title: "Document the feed", category: "docs" }],
    });
    expect(tracking(replaced)).toMatchObject({ tracked: true });
    expect(g.h.cp.tasks.get(review)!.state).toBe("CANCELLED");
    expect(scope.assertSettled(g.runId).allowed).toBe(true);
    expect(startExecution(g, impl).allowed).toBe(true);
  });

  it("review R6 P1: superseding a task whose issue create is unknown is refused until it resolves; then the replacement links to the found issue", async () => {
    const g = await governedRun({ legacy: LEGACY.slice(0, 1) });
    const [impl] = g.taskIds as [string];
    const issue = { new: { title: "Add feed filtering", body: "Filter" } };
    g.github.fault = { suffix: "/issues", when: "late" };
    expect(tracking(await planSubmit(g, [{ key: "feed", tasks: [impl], issue, milestone: { number: 1 } }]))).toMatchObject({ tracked: false });
    const plan = g.h.cp.artifacts.latest(g.runId, ArtifactKind.PLAN)!.digest;
    const supersede = (key: string) => callCtoTool(g.h, g.owner, "plan_submit", {
      idempotencyKey: key, runId: g.runId,
      plan: { summary: "replace the feed task", supersedesTaskIds: [impl], workUnits: [{ key: "feed", tasks: ["impl2"], issue, milestone: { number: 1 } }] },
      tasks: [{ key: "impl2", title: "Implement the verdict feed, again", category: "implementation" }],
    });
    const refused = await supersede("supersede-1");
    expect(refused).toMatchObject({ ok: false, evidence: { refusal: "WORK_SCOPE_CREATION_UNRESOLVED", retryable: true } });
    expect((refused["evidence"] as { intents: string[] }).intents).toHaveLength(1);
    expect(g.h.cp.tasks.get(impl)!.state).toBe("READY");
    expect(g.h.cp.artifacts.latest(g.runId, ArtifactKind.PLAN)!.digest).toBe(plan);
    expect(g.github.posts("/issues")).toHaveLength(1);
    // The delayed POST completes; a sync links it, and then the supersede is accepted and reuses it.
    g.github.land();
    expect((await provision(g, impl))["reasonCode"]).not.toBe(REFUSED);
    const accepted = await supersede("supersede-2");
    expect(accepted["ok"]).toBe(true);
    expect(tracking(accepted)).toMatchObject({ tracked: true });
    expect(g.h.cp.tasks.get(impl)!.state).toBe("CANCELLED");
    expect(g.github.posts("/issues")).toHaveLength(1);
    expect(g.github.issues.filter((i) => i.title === "Add feed filtering")).toHaveLength(1);
    const impl2 = g.h.cp.tasks.list(g.runId).find((t) => t.title === "Implement the verdict feed, again")!.taskId;
    expect(startExecution(g, impl2).allowed).toBe(true);
  });

  it("review R6 P1 (adoption): superseding a task whose create is unknown is allowed when the PLAN adopts an existing issue for that work", async () => {
    const g = await governedRun({ legacy: LEGACY.slice(0, 1) });
    const [impl] = g.taskIds as [string];
    g.github.fault = { suffix: "/issues", when: "late" };
    await planSubmit(g, [{ key: "feed", tasks: [impl], issue: { new: { title: "Add feed filtering", body: "Filter" } }, milestone: { number: 1 } }]);
    const adopted = await callCtoTool(g.h, g.owner, "plan_submit", {
      idempotencyKey: "supersede-adopt", runId: g.runId,
      plan: { summary: "replace the feed task", supersedesTaskIds: [impl], workUnits: [{ key: "feed", tasks: ["impl2"], issue: { number: 3 }, milestone: { number: 1 } }] },
      tasks: [{ key: "impl2", title: "Implement the verdict feed, again", category: "implementation" }],
    });
    expect(tracking(adopted)).toMatchObject({ tracked: true });
    expect(g.h.cp.tasks.get(impl)!.state).toBe("CANCELLED");
    expect(g.github.posts("/issues")).toHaveLength(1);
  });

  it("review R6 P2: an identical resend of the current superseding work-unit PLAN with a new key is a no-op success returning its tasks", async () => {
    const g = await governedRun({ legacy: LEGACY.slice(0, 2) });
    const [impl, review] = g.taskIds as [string, string];
    const feed = { key: "feed", tasks: [impl], issue: { number: 3 }, milestone: { number: 1 } };
    expect(tracking(await planSubmit(g, [feed, { key: "detail", tasks: [review], issue: { number: 4 }, milestone: { number: 1 } }]))).toMatchObject({ tracked: true });
    const args = {
      runId: g.runId,
      plan: { summary: "replace the detail page", supersedesTaskIds: [review], workUnits: [feed, { key: "detail2", tasks: ["detail2"], issue: { number: 6 }, milestone: { number: 2 } }] },
      tasks: [{ key: "detail2", title: "Verdict detail, second cut", category: "implementation" }],
    };
    const first = await callCtoTool(g.h, g.owner, "plan_submit", { idempotencyKey: "supersede-first", ...args });
    expect(first["ok"]).toBe(true);
    const plans = g.h.cp.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM run_artifacts WHERE run_id = ? AND kind = 'PLAN'`, [g.runId])!.n;
    const tasks = g.h.cp.tasks.list(g.runId).length;
    const resent = await callCtoTool(g.h, g.owner, "plan_submit", { idempotencyKey: "supersede-resent", ...args });
    expect(resent).toMatchObject({ ok: true });
    expect((resent["value"] as Array<{ taskId: string }>).map((t) => t.taskId)).toEqual((first["value"] as Array<{ taskId: string }>).map((t) => t.taskId));
    expect(g.h.cp.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM run_artifacts WHERE run_id = ? AND kind = 'PLAN'`, [g.runId])!.n).toBe(plans);
    expect(g.h.cp.tasks.list(g.runId)).toHaveLength(tasks);
    expect(g.h.cp.audit.byKind("STANDARD_WORK_TASKS_SUPERSEDED").filter((row) => row.runId === g.runId)).toHaveLength(1);
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

  it("review P2-b: a genesis with no issue, or no milestone, is refused before approval", () => {
    expect(refusalOf(genesisWith([]))).toMatchObject({ refusal: "GENESIS_BACKLOG_MISSING", issueCount: 0, milestoneCount: 1 });
    expect(refusalOf({ ...genesisWith([]), milestones: [] })).toMatchObject({ refusal: "GENESIS_BACKLOG_MISSING", issueCount: 0, milestoneCount: 0 });
    const genesis = { ...genesisWith([]), milestones: [] };
    const manifest = projectManifestSchema.parse(fixtureManifest("resident-test", {
      verificationCommands: [{ id: "test", argv: ["node", "test.js"], repositoryRole: "primary", cwd: ".", timeoutSeconds: 30, envAllowlist: [], network: "deny", networkAllowlist: [], required: true, evidenceMode: "LOCAL_COMMAND", maxOutputBytes: 1048576, maxMemoryMb: 1024, maxCpuSeconds: 30 }],
      verificationProfiles: { simple: ["test"], standard: ["test"], guarded: ["test"] },
      ciWorkflows: [{ repositoryRole: "primary", path: ".github/workflows/ci.yml", checkName: "test", approvedDigest: genesis.files[1]!.sha256, unapprovedFirstActivation: false }],
    }));
    const submitted = planForSubmission({ kind: "PROJECT_BOOTSTRAP", projectId: null }, { summary: "create", bootstrapOperationId: "genesis-op", requestDigest: digestOf("request"), projectManifest: manifest, projectManifestDigest: manifestDigest(manifest), genesis });
    expect(submitted).toMatchObject({ allowed: false, evidence: { refusal: "GENESIS_INVALID", genesisRefusal: { refusal: "GENESIS_BACKLOG_MISSING" } } });
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
