/**
 * A `main` push skips the suite only when the pull-request run it merged already passed every shard
 * on the very tree, base and workflow it lands, and the required `verify` check accepts that skip
 * and no other.
 *
 * The suite ran twice per merge: once on the pull request, then again on the squash `main` received.
 * Both red `main` runs from 2026-10-19 to 2026-10-26 were timing flakes on trees their pull request
 * had passed.
 *
 * Two facts shape the proof. ACP merges by squash (`scripts/merge-pr.mjs`): the squash's parent is
 * the previous `main` and its message names the head as `Merged-Head: <sha>`, so the head is never an
 * ancestor of the push and a tree that merely matches proves nothing about which run tested it. And
 * a `pull_request` run executes GitHub's synthetic merge commit, not the head, so the only witness of
 * what it tested is what each of its jobs read from its own checkout.
 *
 * Two halves, both fail-closed:
 *
 *   - `scripts/ci-reuse-verified-tree.mjs` says `true` only for the run on the push's `Merged-Head`
 *     whose every job recorded the push's tree, parent and workflow blob. Each case below removes
 *     one piece of that proof and expects `false`.
 *   - `verify-gate`'s script is read out of `ci.yml` and run, never restated, and judged by what it
 *     does with each combination of results rather than by how its text is spelled.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// @ts-expect-error The production entry point is plain JavaScript and intentionally has no build step.
import * as reuseModule from "../../scripts/ci-reuse-verified-tree.mjs";

type Decision = { reuse: boolean; reason: string; evidence?: Record<string, unknown> };
type Download = (runId: number, name: string) => Promise<unknown>;
const { decideReuse, executionRecord } = reuseModule as {
  decideReuse: (context: Record<string, unknown>, api: (path: string) => Promise<unknown>, download: Download) => Promise<Decision>;
  executionRecord: (options: {
    job: string;
    shards?: number | null;
    env: Record<string, string>;
    rev: (revision: string) => string;
    node?: string;
  }) => Record<string, unknown>;
};

const WORKFLOW = readFileSync(join(process.cwd(), ".github", "workflows", "ci.yml"), "utf8");

const REPO = "acme/acp";
const PUSHED = "a".repeat(40);
const PARENT = "b".repeat(40);
const HEAD = "c".repeat(40);
const SIBLING = "d".repeat(40);
const TREE = "e".repeat(40);
const BLOB = "f".repeat(40);
const MERGE = "1".repeat(40);
const OTHER = "9".repeat(40);
const PUSH_RUN = 900;
const PR_RUN = 800;
const SIBLING_RUN = 850;
const WORKFLOW_ID = 7;
const PATH = ".github/workflows/ci.yml";
const JOBS = ["test reuse", "verify (gates)", "verify (shard 1/3)", "verify (shard 2/3)", "verify (shard 3/3)", "verify"];
const RECORDS = ["gates", "shard-1", "shard-2", "shard-3"];
const MESSAGE = `ci: a change (#9)\n\nMerged-Head: ${HEAD}\n\nWhat it does.\n`;

const prRun = (over: Record<string, unknown> = {}) => ({
  id: PR_RUN,
  run_attempt: 1,
  event: "pull_request",
  workflow_id: WORKFLOW_ID,
  path: PATH,
  repository: { full_name: REPO },
  head_repository: { full_name: REPO },
  head_sha: HEAD,
  head_commit: { tree_id: TREE },
  status: "completed",
  conclusion: "success",
  ...over,
});

const jobs = (runId: number, head: string, names = JOBS, over: Record<string, Record<string, unknown>> = {}) => {
  const list = names.map((name) => ({ name, run_id: runId, head_sha: head, status: "completed", conclusion: "success", ...over[name] }));
  return { total_count: list.length, jobs: list };
};

const artifacts = (runId: number, head: string, records = RECORDS, over: Record<string, Record<string, unknown>> = {}) => {
  const list = [
    { id: 1, name: "vitest-results-22.23.2", expired: false, workflow_run: { id: runId, head_sha: head } },
    ...records.map((job, index) => ({ id: 10 + index, name: `ci-executed-${job}`, expired: false, workflow_run: { id: runId, head_sha: head }, ...over[job] })),
  ];
  return { total_count: list.length, artifacts: list };
};

const NODE = "22.23.2";

/**
 * What a pull-request job reads from its own checkout of GitHub's merge of `head` onto `base`, and
 * the conditions it ran under: its Node, and for a shard, which one of how many.
 */
const record = (job: string, over: Record<string, unknown> = {}) => {
  const shard = /^shard-(\d+)$/.exec(job)?.[1];
  return {
    schema: "acp.ci-executed.v1",
    job,
    event: "pull_request",
    head: MERGE,
    tree: TREE,
    base: PARENT,
    mergedHead: HEAD,
    parents: [PARENT, HEAD],
    workflowBlob: BLOB,
    node: `v${NODE}`,
    shard: shard === undefined ? null : Number(shard),
    shards: shard === undefined ? null : 3,
    ...over,
  };
};

/** GitHub's merged-PR record for the pushed commit: the squash of `HEAD` into `main`, within `REPO`. */
const pull = (over: Record<string, unknown> = {}) => ({
  number: 9,
  merged_at: "2026-10-26T06:57:45Z",
  merge_commit_sha: PUSHED,
  head: { sha: HEAD, repo: { full_name: REPO } },
  base: { ref: "main", repo: { full_name: REPO } },
  ...over,
});
const PULLS = `/repos/${REPO}/commits/${PUSHED}/pulls?per_page=100`;

type World = { routes: Map<string, unknown>; records: Map<string, unknown> };

/**
 * A GitHub that proves the push; each case below breaks one piece. It also answers every route the
 * previous head-ancestry rule asked (the recent-runs list, the head's commit and the compare), so a
 * case that rule wrongly accepted reads as a wrong `true` here rather than as a missing route.
 */
const world = (patch: (world: World) => void = () => {}) => {
  const routes = new Map<string, unknown>([
    [`/repos/${REPO}/commits/${PUSHED}`, { commit: { tree: { sha: TREE }, message: MESSAGE }, parents: [{ sha: PARENT }] }],
    [`/repos/${REPO}/actions/runs/${PUSH_RUN}`, { head_sha: PUSHED, event: "push", repository: { full_name: REPO }, path: PATH, workflow_id: WORKFLOW_ID }],
    [`/repos/${REPO}/contents/${PATH}?ref=${PUSHED}`, { sha: BLOB }],
    [PULLS, [pull()]],
    [`/repos/${REPO}/actions/workflows/${WORKFLOW_ID}/runs?event=pull_request&per_page=100`, { workflow_runs: [prRun()] }],
    [`/repos/${REPO}/actions/workflows/${WORKFLOW_ID}/runs?event=pull_request&head_sha=${HEAD}&per_page=100`, { workflow_runs: [prRun()] }],
    [`/repos/${REPO}/commits/${HEAD}`, { commit: { tree: { sha: TREE } } }],
    [`/repos/${REPO}/compare/${PARENT}...${HEAD}`, { status: "ahead", behind_by: 0 }],
    [`/repos/${REPO}/contents/${PATH}?ref=${HEAD}`, { sha: BLOB }],
    [`/repos/${REPO}/actions/runs/${PR_RUN}/attempts/1/jobs?per_page=100`, jobs(PR_RUN, HEAD)],
    [`/repos/${REPO}/actions/runs/${PR_RUN}/artifacts?per_page=100`, artifacts(PR_RUN, HEAD)],
  ]);
  const records = new Map<string, unknown>(RECORDS.map((job) => [`${PR_RUN}/ci-executed-${job}`, record(job)]));
  patch({ routes, records });
  const calls: string[] = [];
  const api = async (path: string): Promise<unknown> => {
    calls.push(path);
    if (!routes.has(path)) throw new Error(`HTTP 404 for ${path}`);
    const value = routes.get(path);
    if (value instanceof Error) throw value;
    return structuredClone(value);
  };
  const download: Download = async (runId, name) => {
    calls.push(`download ${runId} ${name}`);
    const value = records.get(`${runId}/${name}`);
    if (value === undefined) throw new Error(`no artifact ${name} on run ${runId}`);
    if (value instanceof Error) throw value;
    return structuredClone(value);
  };
  return { api, download, calls };
};

const context = (over: Record<string, unknown> = {}) => ({
  event: "push",
  sha: PUSHED,
  repository: REPO,
  runId: PUSH_RUN,
  forced: false,
  workflowPath: PATH,
  localHead: PUSHED,
  localTree: TREE,
  localWorkflowBlob: BLOB,
  branch: "main",
  expectedNode: NODE,
  ...over,
});

const decide = async (over: Record<string, unknown> = {}, patch?: (world: World) => void) => {
  const { api, download, calls } = world(patch);
  return { decision: await decideReuse(context(over), api, download), calls };
};

const setRecord = (job: string, over: Record<string, unknown>) => ({ records }: World) => {
  records.set(`${PR_RUN}/ci-executed-${job}`, record(job, over));
};

describe("the reuse decision", () => {
  it("reuses the run on the push's Merged-Head whose every job recorded what the push lands", async () => {
    const { decision } = await decide();
    expect(decision.reuse, decision.reason).toBe(true);
    expect(decision.evidence).toMatchObject({ runId: PR_RUN, attempt: 1, headSha: HEAD, testedCommit: MERGE, treeSha: TREE, parentSha: PARENT, node: `v${NODE}` });
  });

  it("never reuses off a push, and asks GitHub nothing there", async () => {
    for (const event of ["pull_request", "schedule", "workflow_dispatch", ""]) {
      const { decision, calls } = await decide({ event });
      expect(decision.reuse, event).toBe(false);
      expect(calls, event).toEqual([]);
    }
  });

  it("does not reuse a forced push, or one whose payload does not say", async () => {
    expect((await decide({ forced: true })).decision.reuse).toBe(false);
    expect((await decide({ forced: undefined })).decision.reuse).toBe(false);
  });

  it("does not reuse when the checkout's tree is not the one GitHub records for the push", async () => {
    const { decision } = await decide({ localTree: OTHER });
    expect(decision.reuse).toBe(false);
    expect(decision.reason).toContain("the checkout has");
  });

  it("does not reuse when GitHub cannot be read", async () => {
    const { decision } = await decide({}, ({ routes }) => {
      routes.set(`/repos/${REPO}/actions/workflows/${WORKFLOW_ID}/runs?event=pull_request&head_sha=${HEAD}&per_page=100`, new Error("HTTP 503"));
    });
    expect(decision.reuse).toBe(false);
    expect(decision.reason).toContain("could not ask GitHub");
  });

  // P1-a: identity is the squash's Merged-Head, never a tree that happens to match.

  it("does not reuse a sibling pull request's run because its head's tree happens to match", async () => {
    const sibling = prRun({ id: SIBLING_RUN, head_sha: SIBLING });
    const { decision } = await decide({}, ({ routes, records }) => {
      routes.set(`/repos/${REPO}/actions/workflows/${WORKFLOW_ID}/runs?event=pull_request&per_page=100`, { workflow_runs: [sibling] });
      routes.set(`/repos/${REPO}/actions/workflows/${WORKFLOW_ID}/runs?event=pull_request&head_sha=${HEAD}&per_page=100`, { workflow_runs: [] });
      routes.set(`/repos/${REPO}/actions/workflows/${WORKFLOW_ID}/runs?event=pull_request&head_sha=${SIBLING}&per_page=100`, { workflow_runs: [sibling] });
      routes.set(`/repos/${REPO}/commits/${SIBLING}`, { commit: { tree: { sha: TREE } } });
      routes.set(`/repos/${REPO}/compare/${PARENT}...${SIBLING}`, { status: "ahead", behind_by: 0 });
      routes.set(`/repos/${REPO}/contents/${PATH}?ref=${SIBLING}`, { sha: BLOB });
      routes.set(`/repos/${REPO}/actions/runs/${SIBLING_RUN}/attempts/1/jobs?per_page=100`, jobs(SIBLING_RUN, SIBLING));
      routes.set(`/repos/${REPO}/actions/runs/${SIBLING_RUN}/artifacts?per_page=100`, artifacts(SIBLING_RUN, SIBLING));
      for (const job of RECORDS) records.set(`${SIBLING_RUN}/ci-executed-${job}`, record(job, { mergedHead: SIBLING }));
    });
    expect(decision.reuse).toBe(false);
    expect(decision.reason).toContain(`recorded on the Merged-Head ${HEAD}`);
  });

  it("does not reuse a push whose message names no Merged-Head, or more than one", async () => {
    for (const message of ["ci: a change (#9)\n\nNo trailer here.\n", `ci: a change\n\nMerged-Head: ${HEAD}\nMerged-Head: ${SIBLING}\n`]) {
      const { decision } = await decide({}, ({ routes }) => {
        routes.set(`/repos/${REPO}/commits/${PUSHED}`, { commit: { tree: { sha: TREE }, message }, parents: [{ sha: PARENT }] });
      });
      expect(decision.reuse, message).toBe(false);
      expect(decision.reason, message).toContain("Merged-Head");
    }
  });

  // #1269: a merge commit names its head as its second parent; no trailer is read.
  it("reuses a merge commit push whose parents are the tested base and the pull request's head", async () => {
    const { decision } = await decide({}, ({ routes }) => {
      routes.set(`/repos/${REPO}/commits/${PUSHED}`, { commit: { tree: { sha: TREE }, message: "Merge pull request #9\n\nNo trailer here.\n" }, parents: [{ sha: PARENT }, { sha: HEAD }] });
    });
    expect(decision.reuse, decision.reason).toBe(true);
    expect(decision.evidence).toMatchObject({ headSha: HEAD, parentSha: PARENT });
  });

  it("does not reuse a merge commit push whose second parent is not the pull request's head, or one with three parents", async () => {
    for (const parents of [[PARENT, SIBLING], [PARENT, HEAD, OTHER]]) {
      const { decision } = await decide({}, ({ routes }) => {
        routes.set(`/repos/${REPO}/commits/${PUSHED}`, { commit: { tree: { sha: TREE }, message: MESSAGE }, parents: parents.map((sha) => ({ sha })) });
      });
      expect(decision.reuse, JSON.stringify(parents)).toBe(false);
    }
  });

  // The Merged-Head trailer is a claim in a message; GitHub's merged-PR record must say the same.

  it("does not reuse a forged Merged-Head: the PR GitHub says this push merged has another head", async () => {
    const { decision } = await decide({}, ({ routes }) => routes.set(PULLS, [pull({ head: { sha: SIBLING, repo: { full_name: REPO } } })]));
    expect(decision.reuse).toBe(false);
    expect(decision.reason).toContain(`but the Merged-Head says ${HEAD}`);
  });

  it("does not reuse a pull request from another repository, on either side", async () => {
    for (const fork of [
      pull({ head: { sha: HEAD, repo: { full_name: "someone/fork" } } }),
      pull({ base: { ref: "main", repo: { full_name: "someone/fork" } } }),
      pull({ head: { sha: HEAD, repo: null } }),
    ]) {
      const { decision } = await decide({}, ({ routes }) => routes.set(PULLS, [fork]));
      expect(decision.reuse, JSON.stringify(fork)).toBe(false);
    }
  });

  it("does not reuse a pull request merged into another branch than the one pushed", async () => {
    const { decision } = await decide({}, ({ routes }) => routes.set(PULLS, [pull({ base: { ref: "release/1", repo: { full_name: REPO } } })]));
    expect(decision.reuse).toBe(false);
    expect(decision.reason).toContain("not the pushed branch main");
  });

  it("does not reuse a push GitHub associates with no pull request", async () => {
    const { decision } = await decide({}, ({ routes }) => routes.set(PULLS, []));
    expect(decision.reuse).toBe(false);
    expect(decision.reason).toContain("associates 0 pull request(s)");
  });

  it("does not reuse a push GitHub associates with two pull requests", async () => {
    const { decision } = await decide({}, ({ routes }) => routes.set(PULLS, [pull(), pull({ number: 10 })]));
    expect(decision.reuse).toBe(false);
    expect(decision.reason).toContain("associates 2 pull request(s)");
  });

  it("does not reuse a pull request GitHub does not record as merged, or as merged into this commit", async () => {
    for (const unmerged of [pull({ merged_at: null }), pull({ merge_commit_sha: OTHER })]) {
      const { decision } = await decide({}, ({ routes }) => routes.set(PULLS, [unmerged]));
      expect(decision.reuse, JSON.stringify(unmerged)).toBe(false);
    }
  });

  it("does not reuse when the pushed ref is not a branch, or the merged-PR record cannot be read", async () => {
    expect((await decide({ branch: "" })).decision.reuse).toBe(false);
    const { decision } = await decide({}, ({ routes }) => routes.set(PULLS, new Error("HTTP 403")));
    expect(decision.reuse).toBe(false);
  });

  it("does not reuse a head whose newest run failed, even after an older one passed", async () => {
    const { decision } = await decide({}, ({ routes }) => {
      routes.set(`/repos/${REPO}/actions/workflows/${WORKFLOW_ID}/runs?event=pull_request&head_sha=${HEAD}&per_page=100`, {
        workflow_runs: [prRun(), prRun({ id: PR_RUN + 1, conclusion: "failure" })],
      });
    });
    expect(decision.reuse).toBe(false);
    expect(decision.reason).toContain(`${PR_RUN + 1}, is completed/failure`);
  });

  it("does not reuse a run from a fork, whose workflow could write its own record", async () => {
    const fork = prRun({ head_repository: { full_name: "someone/fork" } });
    const { decision } = await decide({}, ({ routes }) => {
      routes.set(`/repos/${REPO}/actions/workflows/${WORKFLOW_ID}/runs?event=pull_request&per_page=100`, { workflow_runs: [fork] });
      routes.set(`/repos/${REPO}/actions/workflows/${WORKFLOW_ID}/runs?event=pull_request&head_sha=${HEAD}&per_page=100`, { workflow_runs: [fork] });
    });
    expect(decision.reuse).toBe(false);
  });

  // P1-b: what the run tested is what its jobs recorded from their own checkout.

  it("does not reuse a run that was tested against another base than the push's parent", async () => {
    const { decision } = await decide({}, ({ records }) => {
      for (const job of RECORDS) setRecord(job, { base: OTHER, parents: [OTHER, HEAD] })({ records } as World);
    });
    expect(decision.reuse).toBe(false);
    expect(decision.reason).toContain(`tested on base ${OTHER}`);
  });

  it("does not reuse a run whose tested tree differs from the push's, though the head's own tree matches", async () => {
    const { decision } = await decide({}, ({ records }) => {
      for (const job of RECORDS) setRecord(job, { tree: OTHER })({ records } as World);
    });
    expect(decision.reuse).toBe(false);
    expect(decision.reason).toContain(`tested tree ${OTHER}`);
  });

  it("does not reuse a run whose tested workflow file differs from the push's", async () => {
    const { decision } = await decide({}, ({ records }) => {
      for (const job of RECORDS) setRecord(job, { workflowBlob: OTHER })({ records } as World);
    });
    expect(decision.reuse).toBe(false);
  });

  // Execution conditions: a run under another Node or another shard matrix is never reused.

  it("does not reuse a run whose jobs ran on another Node than this workflow's", async () => {
    const { decision } = await decide({}, (world) => {
      for (const job of RECORDS) setRecord(job, { node: "v22.18.0" })(world);
    });
    expect(decision.reuse).toBe(false);
    expect(decision.reason).toContain("ran on Node v22.18.0");
  });

  it("does not reuse when this workflow names no Node version to compare with", async () => {
    expect((await decide({ expectedNode: "" })).decision.reuse).toBe(false);
  });

  it("does not reuse a run whose jobs disagree on Node, or whose record names none", async () => {
    expect((await decide({}, setRecord("shard-2", { node: "v24.18.0" }))).decision.reason).toContain("different node values");
    expect((await decide({}, setRecord("gates", { node: undefined }))).decision.reuse).toBe(false);
  });

  it("does not reuse a run whose shards ran under another shard count, or as another shard", async () => {
    const cases: Array<[string, (world: World) => void]> = [
      ["every shard recorded 4 shards", (world) => { for (const job of RECORDS.slice(1)) setRecord(job, { shards: 4 })(world); }],
      ["shard 2 recorded itself as shard 3", setRecord("shard-2", { shard: 3 })],
      ["the gates recorded a shard", setRecord("gates", { shard: 1, shards: 3 })],
      ["a shard recorded no count", setRecord("shard-1", { shards: null })],
    ];
    for (const [what, patch] of cases) {
      const { decision } = await decide({}, patch);
      expect(decision.reuse, what).toBe(false);
      expect(decision.reason, what).toContain("ran as shard");
    }
  });

  it("does not reuse a run whose recorded merge had other parents than [push parent, Merged-Head]", async () => {
    for (const parents of [[PARENT, HEAD, OTHER], [HEAD, PARENT], [PARENT]]) {
      const { decision } = await decide({}, (world) => {
        for (const job of RECORDS) setRecord(job, { parents })(world);
      });
      expect(decision.reuse, JSON.stringify(parents)).toBe(false);
    }
  });

  it("does not reuse a run whose jobs recorded different checkouts", async () => {
    for (const field of ["head", "tree", "base", "mergedHead", "workflowBlob"]) {
      // A record stays internally consistent: its parents list moves with the parent it names.
      const parents = field === "base" ? [OTHER, HEAD] : field === "mergedHead" ? [PARENT, OTHER] : [PARENT, HEAD];
      const { decision } = await decide({}, setRecord("shard-2", { [field]: OTHER, parents }));
      expect(decision.reuse, field).toBe(false);
      expect(decision.reason, field).toContain(`different ${field} values`);
    }
  });

  it("does not reuse a run whose records are missing, extra, expired, unreadable or malformed", async () => {
    const broken: Array<[string, (world: World) => void]> = [
      ["a shard without a record", ({ routes }) => routes.set(`/repos/${REPO}/actions/runs/${PR_RUN}/artifacts?per_page=100`, artifacts(PR_RUN, HEAD, ["gates", "shard-1", "shard-3"]))],
      ["no gates record", ({ routes }) => routes.set(`/repos/${REPO}/actions/runs/${PR_RUN}/artifacts?per_page=100`, artifacts(PR_RUN, HEAD, ["shard-1", "shard-2", "shard-3"]))],
      ["a record twice", ({ routes }) => routes.set(`/repos/${REPO}/actions/runs/${PR_RUN}/artifacts?per_page=100`, artifacts(PR_RUN, HEAD, [...RECORDS, "shard-2"]))],
      ["an extra record", ({ routes }) => routes.set(`/repos/${REPO}/actions/runs/${PR_RUN}/artifacts?per_page=100`, artifacts(PR_RUN, HEAD, [...RECORDS, "shard-4"]))],
      ["an expired record", ({ routes }) => routes.set(`/repos/${REPO}/actions/runs/${PR_RUN}/artifacts?per_page=100`, artifacts(PR_RUN, HEAD, RECORDS, { "shard-1": { expired: true } }))],
      ["a record from another run", ({ routes }) => routes.set(`/repos/${REPO}/actions/runs/${PR_RUN}/artifacts?per_page=100`, artifacts(PR_RUN, HEAD, RECORDS, { gates: { workflow_run: { id: PR_RUN + 3, head_sha: HEAD } } }))],
      ["an artifact list that did not come back whole", ({ routes }) => {
        const listed = artifacts(PR_RUN, HEAD);
        routes.set(`/repos/${REPO}/actions/runs/${PR_RUN}/artifacts?per_page=100`, { ...listed, total_count: listed.total_count + 1 });
      }],
      ["a record that cannot be downloaded", ({ records }) => records.set(`${PR_RUN}/ci-executed-shard-3`, new Error("HTTP 410"))],
      ["a record that is not JSON", ({ records }) => records.set(`${PR_RUN}/ci-executed-gates`, new SyntaxError("Unexpected token"))],
      ["a record with an unresolved field", setRecord("gates", { base: "" })],
      ["a record from a push event", setRecord("shard-1", { event: "push" })],
      ["a record of another job", setRecord("shard-1", { job: "shard-2" })],
      ["a record of another schema", setRecord("shard-3", { schema: "acp.ci-executed.v0" })],
      ["a record that merged another head", (world) => { for (const job of RECORDS) setRecord(job, { mergedHead: SIBLING })(world); }],
    ];
    for (const [what, patch] of broken) {
      const { decision } = await decide({}, patch);
      expect(decision.reuse, what).toBe(false);
    }
  });

  it("does not reuse a run in which any shard, the gates or the verdict did not succeed", async () => {
    const broken: Array<[string, ReturnType<typeof jobs>]> = [
      ["a cancelled shard", jobs(PR_RUN, HEAD, JOBS, { "verify (shard 2/3)": { conclusion: "cancelled" } })],
      ["skipped shards (a run that itself reused)", jobs(PR_RUN, HEAD, JOBS, {
        "verify (shard 1/3)": { conclusion: "skipped" },
        "verify (shard 2/3)": { conclusion: "skipped" },
        "verify (shard 3/3)": { conclusion: "skipped" },
      })],
      ["a missing shard", jobs(PR_RUN, HEAD, JOBS.filter((name) => name !== "verify (shard 3/3)"))],
      ["no shards", jobs(PR_RUN, HEAD, JOBS.filter((name) => !name.startsWith("verify (shard")))],
      ["failed gates", jobs(PR_RUN, HEAD, JOBS, { "verify (gates)": { conclusion: "failure" } })],
      ["no gates job", jobs(PR_RUN, HEAD, JOBS.filter((name) => name !== "verify (gates)"))],
      ["no verdict job", jobs(PR_RUN, HEAD, JOBS.filter((name) => name !== "verify"))],
      ["a job still running", jobs(PR_RUN, HEAD, JOBS, { verify: { status: "in_progress", conclusion: null } })],
      ["a job from another run", jobs(PR_RUN, HEAD, JOBS, { "verify (shard 1/3)": { run_id: PR_RUN + 5 } })],
      ["skipped gates", jobs(PR_RUN, HEAD, JOBS, { "verify (gates)": { conclusion: "skipped" } })],
      ["cancelled gates", jobs(PR_RUN, HEAD, JOBS, { "verify (gates)": { conclusion: "cancelled" } })],
      ["a cancelled verdict", jobs(PR_RUN, HEAD, JOBS, { verify: { conclusion: "cancelled" } })],
      ["a skipped test-reuse job", jobs(PR_RUN, HEAD, JOBS, { "test reuse": { conclusion: "skipped" } })],
    ];
    for (const [what, listed] of broken) {
      const { decision } = await decide({}, ({ routes }) => {
        routes.set(`/repos/${REPO}/actions/runs/${PR_RUN}/attempts/1/jobs?per_page=100`, listed);
      });
      expect(decision.reuse, what).toBe(false);
    }
    const truncated = jobs(PR_RUN, HEAD);
    const { decision } = await decide({}, ({ routes }) => {
      routes.set(`/repos/${REPO}/actions/runs/${PR_RUN}/attempts/1/jobs?per_page=100`, { ...truncated, total_count: truncated.total_count + 1 });
    });
    expect(decision.reuse, "a job list that did not come back whole").toBe(false);
  });
});

const scratch: string[] = [];
afterAll(() => {
  for (const directory of scratch) rmSync(directory, { recursive: true, force: true });
});

describe("the record a pull-request job writes", () => {
  /**
   * A real synthetic merge, built the way GitHub builds `refs/pull/N/merge`: the head merged with
   * `--no-ff` onto the base tip. (The branch is not named `head`: on a case-insensitive file system
   * git resolves that to `HEAD`.) The record must name that base as `base`, the head as
   * `mergedHead`, and the merge's own tree and workflow blob — not the head's.
   */
  it("reads the merge it checked out: base is the first parent, the head the second", () => {
    const repo = mkdtempSync(join(tmpdir(), "acp-ci-executed-"));
    scratch.push(repo);
    const git = (...args: string[]) =>
      execFileSync(
        "git",
        ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args],
        { encoding: "utf8", timeout: 10_000 },
      ).trim();
    const write = (file: string, text: string) => {
      mkdirSync(join(repo, file, ".."), { recursive: true });
      writeFileSync(join(repo, file), text);
    };
    git("init", "-q", "-b", "main");
    write(PATH, "name: x\n");
    write("a.txt", "a\n");
    git("add", "-A");
    git("commit", "-q", "-m", "root");
    git("checkout", "-q", "-b", "feature");
    write("h.txt", "head\n");
    git("add", "-A");
    git("commit", "-q", "-m", "head");
    git("checkout", "-q", "main");
    write("b.txt", "base moved\n");
    git("add", "-A");
    git("commit", "-q", "-m", "base moved");
    const base = git("rev-parse", "HEAD");
    const head = git("rev-parse", "feature");
    git("merge", "-q", "--no-ff", "-m", "Merge feature into main", "feature");

    const rev = (revision: string) => {
      try {
        return git("rev-parse", "--verify", "--quiet", revision);
      } catch {
        return "";
      }
    };
    const env = { GITHUB_EVENT_NAME: "pull_request", GITHUB_REPOSITORY: REPO, GITHUB_WORKFLOW_REF: `${REPO}/${PATH}@refs/pull/9/merge` };
    const written = executionRecord({ job: "shard-2", shards: 3, env, rev, node: "v22.23.2" });
    expect(written).toEqual({
      schema: "acp.ci-executed.v1",
      job: "shard-2",
      event: "pull_request",
      head: git("rev-parse", "HEAD"),
      tree: git("rev-parse", "HEAD^{tree}"),
      base,
      mergedHead: head,
      parents: [base, head],
      workflowBlob: git("rev-parse", `HEAD:${PATH}`),
      node: "v22.23.2",
      shard: 2,
      shards: 3,
    });
    expect(executionRecord({ job: "gates", env, rev, node: "v22.23.2" })).toMatchObject({ shard: null, shards: null, parents: [base, head] });
    expect(written["tree"]).not.toBe(git("rev-parse", "feature^{tree}"));
  });
});

/** The gate's own `run:` block, lifted from the workflow with its indentation removed. */
const GATE_STEP = "require the gates and every test shard to have actually succeeded";
const gateScript = (workflow: string): string => {
  const lines = workflow.split("\n");
  const step = lines.findIndex((line) => line.includes(GATE_STEP));
  expect(step, `the workflow no longer has a step named "${GATE_STEP}"`).toBeGreaterThan(-1);
  const runAt = lines.findIndex((line, index) => index > step && /^\s*run:\s*\|[-+]?\s*$/.test(line));
  expect(runAt, "the gate step no longer carries a `run: |` block").toBeGreaterThan(-1);
  const indent = (lines[runAt + 1] ?? "").match(/^\s*/)?.[0] ?? "";
  const body: string[] = [];
  for (let index = runAt + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim() !== "" && !line.startsWith(indent)) break;
    body.push(line.slice(indent.length));
  }
  return body.join("\n");
};

type Needs = { gates: string; shards: string; reuseJob: string; reuse: string; event: string };

/**
 * Actions substitutes `${{ … }}` before bash sees it, so the test does the same — by what each
 * expression names, not by how it is spaced. The gate reads plain context paths, so an expression
 * is resolved after dropping its whitespace and lowering its case (context names are
 * case-insensitive in Actions). One this test does not supply fails the test rather than reaching
 * bash as literal text that decides nothing.
 */
const EXPRESSION = /\$\{\{([\s\S]*?)\}\}/g;
const resolveExpressions = (script: string, values: Record<string, string>): string =>
  script.replace(EXPRESSION, (whole, inner: string) => {
    const key = inner.replace(/\s+/g, "").toLowerCase();
    expect(Object.hasOwn(values, key), `the gate reads ${whole}, which this test does not supply`).toBe(true);
    return values[key]!;
  });

const runGate = (needs: Needs, workflow = WORKFLOW): number => {
  const script = resolveExpressions(gateScript(workflow), {
    "needs.gates.result": needs.gates,
    "needs.verify-matrix.result": needs.shards,
    "needs.test-reuse.result": needs.reuseJob,
    "needs.test-reuse.outputs.reuse": needs.reuse,
    "github.event_name": needs.event,
  });
  try {
    execFileSync("/bin/bash", ["-e", "-c", script], {
      stdio: "pipe",
      timeout: 10_000,
      env: { ...process.env, REUSED_RUN: "800", REUSED_HEAD: HEAD, REUSED_TREE: TREE },
    });
    return 0;
  } catch (error) {
    return (error as { status?: number }).status ?? -1;
  }
};

const ran: Needs = { gates: "success", shards: "success", reuseJob: "success", reuse: "false", event: "pull_request" };
const reused: Needs = { gates: "success", shards: "skipped", reuseJob: "success", reuse: "true", event: "push" };

describe("the required verify check", () => {
  it("passes when the gates and every shard succeeded, on any event", () => {
    for (const event of ["pull_request", "push", "schedule"]) expect(runGate({ ...ran, event }), event).toBe(0);
  });

  it("fails when any shard failed or was cancelled, whatever test-reuse said", () => {
    for (const shards of ["failure", "cancelled"]) {
      expect(runGate({ ...ran, shards }), shards).toBe(1);
      expect(runGate({ ...reused, shards }), `${shards} after reuse=true`).toBe(1);
    }
  });

  it("fails when the gates did not succeed, including on a reused push", () => {
    for (const gates of ["failure", "cancelled", "skipped"]) {
      expect(runGate({ ...ran, gates }), gates).toBe(1);
      expect(runGate({ ...reused, gates }), `${gates} on a reused push`).toBe(1);
    }
  });

  it("passes skipped shards only on a push test-reuse proved", () => {
    expect(runGate(reused)).toBe(0);
    expect(runGate({ ...reused, event: "pull_request" })).toBe(1);
    expect(runGate({ ...reused, event: "schedule" })).toBe(1);
    expect(runGate({ ...reused, reuse: "false" })).toBe(1);
    expect(runGate({ ...reused, reuse: "" })).toBe(1);
    expect(runGate({ ...reused, reuseJob: "failure" })).toBe(1);
    expect(runGate({ ...reused, reuseJob: "cancelled" })).toBe(1);
  });

  /**
   * The verdicts above, again, on a copy of the workflow whose gate lines are respaced the way
   * actionlint and Actions both accept — inside every `${{ }}`, after `if:` and after `run:`. The
   * gate's text is not its behaviour, so every verdict must come out the same.
   */
  it("keeps every verdict when the gate's lines are respaced", () => {
    let nth = 0;
    const respaced = WORKFLOW.replace(EXPRESSION, (_whole, inner: string) => {
      nth += 1;
      return nth % 2 === 0 ? `\${{${inner.trim()}}}` : `\${{  ${inner.trim()}  }}`;
    })
      .replace(/^(\s*)run: \|$/gm, "$1run:   |")
      .replace(/^(\s*)if: always\(\)$/gm, "$1if:   always()");
    expect(respaced).not.toBe(WORKFLOW);
    expect(gateScript(respaced)).not.toBe(gateScript(WORKFLOW));
    const cases: Array<[Needs, number]> = [
      ...["pull_request", "push", "schedule"].map((event): [Needs, number] => [{ ...ran, event }, 0]),
      [reused, 0],
      ...["failure", "cancelled"].flatMap((shards): Array<[Needs, number]> => [[{ ...ran, shards }, 1], [{ ...reused, shards }, 1]]),
      ...["failure", "cancelled", "skipped"].flatMap((gates): Array<[Needs, number]> => [[{ ...ran, gates }, 1], [{ ...reused, gates }, 1]]),
      [{ ...reused, event: "pull_request" }, 1],
      [{ ...reused, event: "schedule" }, 1],
      [{ ...reused, reuse: "false" }, 1],
      [{ ...reused, reuse: "" }, 1],
      [{ ...reused, reuseJob: "failure" }, 1],
      [{ ...reused, reuseJob: "cancelled" }, 1],
    ];
    for (const [needs, verdict] of cases) {
      expect(runGate(needs, respaced), JSON.stringify(needs)).toBe(verdict);
    }
  });

  it("names its shard matrix 1..N, so `strategy.job-total` is the shard count", () => {
    const listed = /^\s+shard:\s*\[([\d,\s]+)\]\s*$/m.exec(WORKFLOW)?.[1];
    expect(listed, "the shard matrix is no longer a literal list").toBeDefined();
    const shards = listed!.split(",").map((value) => Number(value.trim()));
    expect(shards).toEqual(shards.map((_, index) => index + 1));
  });
});
