/**
 * A `main` push skips the suite only when a pull-request run already passed every shard on the very
 * tree it lands, and the required `verify` check accepts that skip and no other.
 *
 * The suite ran twice per merge: once on the pull request's head, then again on the squash `main`
 * received — the same tree whenever the pull request was up to date. 35 of the 44 pushes from
 * 2026-10-19 to 2026-10-26 had such a run, and both red `main` runs in that window were timing
 * flakes on trees their pull request had passed.
 *
 * Two halves, both fail-closed:
 *
 *   - `scripts/ci-reuse-verified-tree.mjs` says `true` only on proof from GitHub's own records. Each
 *     case below removes one piece of that proof and expects `false`.
 *   - `verify-gate`'s script is read out of `ci.yml` and run, never restated: the shard job's `if:`
 *     and the gate's excuse for a skipped matrix are one decision written in two places, and the
 *     last time they drifted (005b3cbd) `main` was red for a day and a half.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// @ts-expect-error The production entry point is plain JavaScript and intentionally has no build step.
import * as reuseModule from "../../scripts/ci-reuse-verified-tree.mjs";

type Decision = { reuse: boolean; reason: string; rejected: string[]; evidence?: Record<string, unknown> };
const { decideReuse } = reuseModule as {
  decideReuse: (context: Record<string, unknown>, api: (path: string) => Promise<unknown>) => Promise<Decision>;
};

const WORKFLOW = readFileSync(join(process.cwd(), ".github", "workflows", "ci.yml"), "utf8");

const REPO = "acme/acp";
const PUSHED = "a".repeat(40);
const PARENT = "b".repeat(40);
const HEAD = "c".repeat(40);
const OTHER_HEAD = "d".repeat(40);
const TREE = "e".repeat(40);
const BLOB = "f".repeat(40);
const PUSH_RUN = 900;
const PR_RUN = 800;
const WORKFLOW_ID = 7;
const PATH = ".github/workflows/ci.yml";
const JOBS = ["test reuse", "verify (gates)", "verify (shard 1/3)", "verify (shard 2/3)", "verify (shard 3/3)", "verify"];

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

/** A GitHub that proves the tree; each case below breaks one route. */
const world = (patch: (routes: Map<string, unknown>) => void = () => {}) => {
  const routes = new Map<string, unknown>([
    [`/repos/${REPO}/commits/${PUSHED}`, { commit: { tree: { sha: TREE } }, parents: [{ sha: PARENT }] }],
    [`/repos/${REPO}/actions/runs/${PUSH_RUN}`, { head_sha: PUSHED, event: "push", repository: { full_name: REPO }, path: PATH, workflow_id: WORKFLOW_ID }],
    [`/repos/${REPO}/contents/${PATH}?ref=${PUSHED}`, { sha: BLOB }],
    [`/repos/${REPO}/actions/workflows/${WORKFLOW_ID}/runs?event=pull_request&per_page=100`, { workflow_runs: [prRun()] }],
    [`/repos/${REPO}/actions/workflows/${WORKFLOW_ID}/runs?event=pull_request&head_sha=${HEAD}&per_page=100`, { workflow_runs: [prRun()] }],
    [`/repos/${REPO}/commits/${HEAD}`, { commit: { tree: { sha: TREE } } }],
    [`/repos/${REPO}/compare/${PARENT}...${HEAD}`, { status: "ahead", behind_by: 0 }],
    [`/repos/${REPO}/contents/${PATH}?ref=${HEAD}`, { sha: BLOB }],
    [`/repos/${REPO}/actions/runs/${PR_RUN}/attempts/1/jobs?per_page=100`, jobs(PR_RUN, HEAD)],
  ]);
  patch(routes);
  const calls: string[] = [];
  const api = async (path: string): Promise<unknown> => {
    calls.push(path);
    if (!routes.has(path)) throw new Error(`HTTP 404 for ${path}`);
    const value = routes.get(path);
    if (value instanceof Error) throw value;
    return structuredClone(value);
  };
  return { api, calls };
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
  ...over,
});

const decide = async (over: Record<string, unknown> = {}, patch?: (routes: Map<string, unknown>) => void) => {
  const { api, calls } = world(patch);
  return { decision: await decideReuse(context(over), api), calls };
};

describe("the reuse decision", () => {
  it("reuses a pull-request run that passed every shard on this tree, and names it", async () => {
    const { decision } = await decide();
    expect(decision.reuse, decision.reason).toBe(true);
    expect(decision.evidence).toMatchObject({ runId: PR_RUN, attempt: 1, headSha: HEAD, treeSha: TREE, parentSha: PARENT });
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
    const { decision } = await decide({ localTree: "9".repeat(40) });
    expect(decision.reuse).toBe(false);
    expect(decision.reason).toContain("the checkout has");
  });

  it("does not reuse when GitHub cannot be read", async () => {
    const { decision } = await decide({}, (routes) => {
      routes.set(`/repos/${REPO}/actions/workflows/${WORKFLOW_ID}/runs?event=pull_request&per_page=100`, new Error("HTTP 503"));
    });
    expect(decision.reuse).toBe(false);
    expect(decision.reason).toContain("could not ask GitHub");
  });

  it("does not reuse without a pull-request run on an equal tree", async () => {
    const { decision } = await decide({}, (routes) => {
      routes.set(`/repos/${REPO}/actions/workflows/${WORKFLOW_ID}/runs?event=pull_request&per_page=100`, {
        workflow_runs: [prRun({ head_commit: { tree_id: "1".repeat(40) } })],
      });
    });
    expect(decision.reuse).toBe(false);
  });

  it("does not reuse a head from another repository", async () => {
    const fork = prRun({ head_repository: { full_name: "someone/fork" } });
    const { decision } = await decide({}, (routes) => {
      routes.set(`/repos/${REPO}/actions/workflows/${WORKFLOW_ID}/runs?event=pull_request&per_page=100`, { workflow_runs: [fork] });
    });
    expect(decision.reuse).toBe(false);
  });

  it("does not reuse a head whose newest run failed, even after an older one passed", async () => {
    const { decision } = await decide({}, (routes) => {
      routes.set(`/repos/${REPO}/actions/workflows/${WORKFLOW_ID}/runs?event=pull_request&head_sha=${HEAD}&per_page=100`, {
        workflow_runs: [prRun(), prRun({ id: PR_RUN + 1, conclusion: "failure" })],
      });
    });
    expect(decision.reuse).toBe(false);
    expect(decision.rejected.join("\n")).toContain(`its newest run ${PR_RUN + 1} is completed/failure`);
  });

  /**
   * A pull-request run tests GitHub's merge of the head into the base tip of that moment. Only a
   * head that already contains the push's parent makes that merge equal to the head's own tree.
   * Measured on 06da2a27: two heads with its tree, one `ahead` of its parent and one `diverged`.
   */
  it("rejects a head the push's parent is not an ancestor of, and takes a proven one instead", async () => {
    const diverged = prRun({ id: PR_RUN + 10, head_sha: OTHER_HEAD });
    const { decision } = await decide({}, (routes) => {
      routes.set(`/repos/${REPO}/actions/workflows/${WORKFLOW_ID}/runs?event=pull_request&per_page=100`, { workflow_runs: [prRun(), diverged] });
      routes.set(`/repos/${REPO}/actions/workflows/${WORKFLOW_ID}/runs?event=pull_request&head_sha=${OTHER_HEAD}&per_page=100`, { workflow_runs: [diverged] });
      routes.set(`/repos/${REPO}/commits/${OTHER_HEAD}`, { commit: { tree: { sha: TREE } } });
      routes.set(`/repos/${REPO}/compare/${PARENT}...${OTHER_HEAD}`, { status: "diverged", behind_by: 1 });
    });
    expect(decision.reuse, decision.reason).toBe(true);
    expect(decision.evidence?.["headSha"]).toBe(HEAD);
    expect(decision.rejected.join("\n")).toContain("is not its ancestor (compare: diverged, behind_by 1)");
  });

  it("does not reuse when the parent is not an ancestor of the only head", async () => {
    const { decision } = await decide({}, (routes) => {
      routes.set(`/repos/${REPO}/compare/${PARENT}...${HEAD}`, { status: "diverged", behind_by: 2 });
    });
    expect(decision.reuse).toBe(false);
  });

  it("does not reuse when the workflow file differs at the head", async () => {
    const { decision } = await decide({}, (routes) => {
      routes.set(`/repos/${REPO}/contents/${PATH}?ref=${HEAD}`, { sha: "2".repeat(40) });
    });
    expect(decision.reuse).toBe(false);
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
    ];
    for (const [what, listed] of broken) {
      const { decision } = await decide({}, (routes) => {
        routes.set(`/repos/${REPO}/actions/runs/${PR_RUN}/attempts/1/jobs?per_page=100`, listed);
      });
      expect(decision.reuse, what).toBe(false);
    }
    const truncated = jobs(PR_RUN, HEAD);
    const { decision } = await decide({}, (routes) => {
      routes.set(`/repos/${REPO}/actions/runs/${PR_RUN}/attempts/1/jobs?per_page=100`, { ...truncated, total_count: truncated.total_count + 1 });
    });
    expect(decision.reuse, "a job list that did not come back whole").toBe(false);
  });
});

/** The gate's own `run:` block, lifted from the workflow with its indentation removed. */
const GATE_STEP = "require the gates and every test shard to have actually succeeded";
const gateScript = (): string => {
  const lines = WORKFLOW.split("\n");
  const step = lines.findIndex((line) => line.includes(GATE_STEP));
  expect(step, `the workflow no longer has a step named "${GATE_STEP}"`).toBeGreaterThan(-1);
  const runAt = lines.findIndex((line, index) => index > step && line.trim() === "run: |");
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
/** Actions substitutes `${{ … }}` before bash sees it, so the test does the same. */
const runGate = (needs: Needs): number => {
  const script = gateScript()
    .replaceAll("${{ needs.gates.result }}", needs.gates)
    .replaceAll("${{ needs.verify-matrix.result }}", needs.shards)
    .replaceAll("${{ needs.test-reuse.result }}", needs.reuseJob)
    .replaceAll("${{ needs.test-reuse.outputs.reuse }}", needs.reuse)
    .replaceAll("${{ github.event_name }}", needs.event);
  // An expression this test does not supply would reach bash as literal text and decide nothing.
  expect(script).not.toContain("${{");
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

  it("skips the shards on exactly the answer the gate excuses", () => {
    expect(WORKFLOW).toContain("if: ${{ !cancelled() && needs.test-reuse.outputs.reuse != 'true' }}");
  });

  it("names its shard matrix 1..N, so `strategy.job-total` is the shard count", () => {
    const listed = /^\s+shard: \[([\d, ]+)\]$/m.exec(WORKFLOW)?.[1];
    expect(listed, "the shard matrix is no longer a literal list").toBeDefined();
    const shards = listed!.split(",").map((value) => Number(value.trim()));
    expect(shards).toEqual(shards.map((_, index) => index + 1));
    expect(WORKFLOW).toContain("run: pnpm gates --tests-only --shard ${{ matrix.shard }}/${{ strategy.job-total }}");
  });
});
