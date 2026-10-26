#!/usr/bin/env node
/**
 * Decides whether a `push` run of `project-ci` may skip its test shards because a pull-request run
 * of the same workflow already passed every shard on the very tree this push lands.
 *
 * Why it exists: a pull request's head got the whole suite, `scripts/merge-pr.mjs` squash-merged it,
 * and the `main` push then ran the whole suite again — about 36 macOS minutes — on a tree identical
 * to the one just judged. Measured over the 44 `main` pushes from 2026-10-19 to 2026-10-26: 35 had
 * a successful pull-request run on an equal tree whose head already contained the push's parent,
 * and both `main` failures in that window were timing flakes on trees whose pull-request run had
 * passed.
 *
 * Every input is a GitHub record — the runner's own event context, the REST API's commit, compare,
 * contents, run and job objects — or this checkout's own `git rev-parse`, which is cross-checked
 * against the API. Nothing a pull request's code wrote (a log line, an artifact, a file) is read.
 *
 * A pull-request run is reused only when all of these hold, and each is checked, not assumed:
 *
 *   1. the event is `push` and the payload says `forced: false`; `pull_request`, `schedule` and
 *      everything else always run the shards;
 *   2. the tree GitHub records for this push equals `git rev-parse HEAD^{tree}` of the checkout;
 *   3. the candidate run is this workflow (same workflow id and path), in this repository, from a
 *      head in this repository, and its head commit's tree (API) equals this push's tree;
 *   4. the push's first parent is an ancestor of that head (compare API: `ahead` or `identical`,
 *      `behind_by` 0). A `pull_request` run tests GitHub's merge of the head into the base tip of
 *      that moment, not the head itself. `main` refuses force-pushes, so that base tip is an
 *      ancestor of the push's parent; when the parent is in turn an ancestor of the head, the
 *      merge GitHub tested has exactly the head's tree. Without this, two heads with one tree can
 *      differ in what was tested — measured: 06da2a27 had one candidate `ahead` and one `diverged`;
 *   5. `.github/workflows/ci.yml` has the same blob at the head and at this push (implied by 3, and
 *      read anyway): runner label, Node version, shard matrix and test command all live there;
 *   6. the newest run of this workflow on that head is completed/success, and in its latest attempt
 *      every job is completed/success, with exactly one `verify`, exactly one `verify (gates)` and
 *      shard jobs `verify (shard i/N)` for every i in 1..N exactly once.
 *
 * Fail closed: any API error, missing field, or unmet condition answers `reuse=false` and the full
 * sharded suite runs. The script exits 0 for either answer; if it cannot even write its answer it
 * exits 1, the job's output is then empty, and an empty answer also runs the shards.
 *
 * Not covered by any record, and therefore not claimed: the runner image behind the `macos-15`
 * label and the `pnpm` 10.x minor that `pnpm/action-setup` resolves can move between the two runs.
 *
 * Usage (CI): node scripts/ci-reuse-verified-tree.mjs   — reads GITHUB_* and GH_TOKEN, writes
 * `reuse`, `run_id`, `head_sha`, `tree_sha` and `reason` to GITHUB_OUTPUT.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const VERDICT_JOB = "verify";
export const GATES_JOB = "verify (gates)";
export const SHARD_JOB = /^verify \(shard ([1-9]\d*)\/([1-9]\d*)\)$/;
const SHA = /^[0-9a-f]{40}$/;
const RECENT_RUNS = 100;
const MAX_CANDIDATE_HEADS = 5;

class Refusal extends Error {}
const refuse = (reason) => {
  throw new Refusal(reason);
};

/** Every job of the attempt succeeded, and the attempt holds the verdict, the gates and a full shard set. */
export const jobsProveTheSuite = (jobs, { runId, headSha }) => {
  if (!Array.isArray(jobs) || jobs.length === 0) return "the run lists no jobs";
  const names = jobs.map((job) => job?.name);
  for (const job of jobs) {
    if (job?.run_id !== runId || job?.head_sha !== headSha) return `job ${JSON.stringify(job?.name)} is not from run ${runId} on ${headSha}`;
    if (job.status !== "completed" || job.conclusion !== "success") {
      return `job ${JSON.stringify(job.name)} is ${job.status}/${job.conclusion ?? "none"}, not completed/success`;
    }
  }
  if (names.filter((name) => name === VERDICT_JOB).length !== 1) return `the run does not have exactly one \`${VERDICT_JOB}\` job`;
  if (names.filter((name) => name === GATES_JOB).length !== 1) return `the run does not have exactly one \`${GATES_JOB}\` job`;
  const shards = names.map((name) => SHARD_JOB.exec(name ?? "")).filter(Boolean);
  if (shards.length === 0) return "the run has no test shard jobs";
  const total = Number(shards[0][2]);
  const indices = new Set();
  for (const [, index, of] of shards) {
    if (Number(of) !== total) return "the run's shard jobs disagree on the shard count";
    if (indices.has(Number(index))) return `shard ${index}/${total} appears twice`;
    indices.add(Number(index));
  }
  for (let index = 1; index <= total; index += 1) {
    if (!indices.has(index)) return `shard ${index}/${total} is missing`;
  }
  if (indices.size !== total) return `the run has ${indices.size} shard jobs for ${total} shards`;
  return null;
};

/**
 * `context` holds the runner's own facts; `api(path)` returns GitHub's parsed JSON or throws.
 * Returns `{ reuse: true, reason, evidence }` or `{ reuse: false, reason, rejected }`.
 */
export const decideReuse = async (context, api) => {
  const rejected = [];
  try {
    const { event, sha, repository, runId, forced, localHead, localTree, workflowPath, localWorkflowBlob } = context;
    if (event !== "push") refuse(`event is ${event || "unknown"}; only a push may reuse a pull-request result`);
    if (forced !== false) refuse(`the push event does not record forced: false (forced=${String(forced)})`);
    if (!SHA.test(sha ?? "") || localHead !== sha) refuse(`the checkout HEAD ${localHead} is not the pushed commit ${sha}`);
    if (!SHA.test(localTree ?? "")) refuse("the checkout tree could not be read");
    if (!repository || !workflowPath || !runId) refuse("the runner did not supply the repository, workflow path or run id");

    const pushed = await api(`/repos/${repository}/commits/${sha}`);
    const tree = pushed?.commit?.tree?.sha;
    if (tree !== localTree) refuse(`GitHub records tree ${tree} for ${sha}, the checkout has ${localTree}`);
    const base = pushed?.parents?.[0]?.sha;
    if (!SHA.test(base ?? "")) refuse(`${sha} has no parent to have been tested against`);

    const self = await api(`/repos/${repository}/actions/runs/${runId}`);
    if (self?.head_sha !== sha || self?.event !== "push" || self?.repository?.full_name !== repository || self?.path !== workflowPath) {
      refuse(`this run's own record does not describe a push of ${sha} through ${workflowPath} in ${repository}`);
    }
    const workflowId = self.workflow_id;

    const pushedBlob = (await api(`/repos/${repository}/contents/${workflowPath}?ref=${sha}`))?.sha;
    if (!SHA.test(pushedBlob ?? "") || pushedBlob !== localWorkflowBlob) {
      refuse(`GitHub records ${workflowPath} as ${pushedBlob} at ${sha}, the checkout has ${localWorkflowBlob}`);
    }

    const sameOrigin = (run) =>
      run?.event === "pull_request" &&
      run?.workflow_id === workflowId &&
      run?.path === workflowPath &&
      run?.repository?.full_name === repository &&
      run?.head_repository?.full_name === repository;

    const recent = (await api(`/repos/${repository}/actions/workflows/${workflowId}/runs?event=pull_request&per_page=${RECENT_RUNS}`))?.workflow_runs;
    if (!Array.isArray(recent)) refuse("GitHub returned no run list");
    const heads = [];
    for (const run of [...recent].sort((a, b) => b.id - a.id)) {
      if (sameOrigin(run) && run.head_commit?.tree_id === tree && SHA.test(run.head_sha ?? "") && !heads.includes(run.head_sha)) {
        heads.push(run.head_sha);
      }
    }
    if (heads.length === 0) refuse(`no pull-request run among the ${RECENT_RUNS} most recent has tree ${tree}`);

    for (const head of heads.slice(0, MAX_CANDIDATE_HEADS)) {
      const reject = (why) => rejected.push(`${head.slice(0, 12)}: ${why}`);

      const onHead = (await api(`/repos/${repository}/actions/workflows/${workflowId}/runs?event=pull_request&head_sha=${head}&per_page=100`))?.workflow_runs;
      const runs = (Array.isArray(onHead) ? onHead : []).filter((run) => sameOrigin(run) && run.head_sha === head);
      if (runs.length === 0) {
        reject("no run of this workflow is recorded on it");
        continue;
      }
      const newest = runs.reduce((a, b) => (b.id > a.id ? b : a));
      if (newest.status !== "completed" || newest.conclusion !== "success") {
        reject(`its newest run ${newest.id} is ${newest.status}/${newest.conclusion ?? "none"}`);
        continue;
      }

      const headTree = (await api(`/repos/${repository}/commits/${head}`))?.commit?.tree?.sha;
      if (headTree !== tree) {
        reject(`GitHub records its tree as ${headTree}`);
        continue;
      }

      const compare = await api(`/repos/${repository}/compare/${base}...${head}`);
      if (!(compare?.status === "ahead" || compare?.status === "identical") || compare?.behind_by !== 0) {
        reject(`the push's parent ${base.slice(0, 12)} is not its ancestor (compare: ${compare?.status}, behind_by ${compare?.behind_by})`);
        continue;
      }

      const headBlob = (await api(`/repos/${repository}/contents/${workflowPath}?ref=${head}`))?.sha;
      if (headBlob !== pushedBlob) {
        reject(`${workflowPath} is ${headBlob} there and ${pushedBlob} here`);
        continue;
      }

      const attempt = newest.run_attempt;
      const listed = await api(`/repos/${repository}/actions/runs/${newest.id}/attempts/${attempt}/jobs?per_page=100`);
      const jobs = listed?.jobs;
      if (!Array.isArray(jobs) || listed?.total_count !== jobs.length) {
        reject(`the jobs of run ${newest.id} attempt ${attempt} did not come back whole`);
        continue;
      }
      const jobsWrong = jobsProveTheSuite(jobs, { runId: newest.id, headSha: head });
      if (jobsWrong) {
        reject(`run ${newest.id} attempt ${attempt}: ${jobsWrong}`);
        continue;
      }

      const evidence = {
        runId: newest.id,
        attempt,
        headSha: head,
        treeSha: tree,
        parentSha: base,
        workflowBlob: pushedBlob,
        jobs: jobs.map((job) => job.name).sort(),
      };
      return {
        reuse: true,
        reason: `pull-request run ${newest.id} attempt ${attempt} passed every shard on head ${head}, tree ${tree}`,
        evidence,
        rejected,
      };
    }
    refuse(`no candidate head proved the tree (${rejected.length} rejected)`);
  } catch (error) {
    const reason = error instanceof Refusal ? error.message : `could not ask GitHub: ${error?.message ?? String(error)}`;
    return { reuse: false, reason, rejected };
  }
  return { reuse: false, reason: "unreachable", rejected };
};

const githubApi = (token, base = "https://api.github.com") => async (path) => {
  const response = await fetch(`${base}${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`GET ${path.split("?")[0]} answered HTTP ${response.status}`);
  return response.json();
};

/** `git rev-parse --verify` of this checkout, or "" when it does not resolve. */
const revParse = (revision) => {
  try {
    return execFileSync("git", ["rev-parse", "--verify", "--quiet", revision], {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
};

/** `owner/repo/.github/workflows/ci.yml@refs/heads/main` → `.github/workflows/ci.yml`. */
const workflowPathFrom = (workflowRef, repository) => {
  const prefix = `${repository}/`;
  if (!workflowRef?.startsWith(prefix)) return "";
  const rest = workflowRef.slice(prefix.length);
  const at = rest.indexOf("@");
  return at === -1 ? rest : rest.slice(0, at);
};

const oneLine = (text) => String(text).replace(/[\r\n]+/g, " ").slice(0, 400);

export const main = async (env = process.env, out = (line) => process.stdout.write(`${line}\n`)) => {
  let forced;
  try {
    const payload = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH ?? "", "utf8"));
    forced = payload?.forced;
  } catch {
    forced = undefined;
  }
  const repository = env.GITHUB_REPOSITORY ?? "";
  const workflowPath = workflowPathFrom(env.GITHUB_WORKFLOW_REF, repository);
  const context = {
    event: env.GITHUB_EVENT_NAME ?? "",
    sha: env.GITHUB_SHA ?? "",
    repository,
    runId: env.GITHUB_RUN_ID ? Number(env.GITHUB_RUN_ID) : 0,
    forced,
    workflowPath,
    localHead: revParse("HEAD"),
    localTree: revParse("HEAD^{tree}"),
    localWorkflowBlob: workflowPath ? revParse(`HEAD:${workflowPath}`) : "",
  };
  const token = env.GH_TOKEN ?? "";
  const api = token ? githubApi(token, env.GITHUB_API_URL || undefined) : async () => refuse("no GH_TOKEN to ask GitHub with");
  const decision = await decideReuse(context, api);

  out(`reuse: ${decision.reuse ? "yes" : "no"} — ${decision.reason}`);
  for (const line of decision.rejected) out(`  rejected ${line}`);
  if (decision.reuse) {
    const e = decision.evidence;
    out(`  matching run ${e.runId} attempt ${e.attempt}, head ${e.headSha}, tree ${e.treeSha}`);
    out(`  parent ${e.parentSha} is an ancestor of that head; workflow blob ${e.workflowBlob}`);
    out(`  jobs: ${e.jobs.join(", ")}`);
  }

  const outputs = [
    `reuse=${decision.reuse ? "true" : "false"}`,
    `run_id=${decision.reuse ? decision.evidence.runId : ""}`,
    `head_sha=${decision.reuse ? decision.evidence.headSha : ""}`,
    `tree_sha=${decision.reuse ? decision.evidence.treeSha : ""}`,
    `reason=${oneLine(decision.reason)}`,
  ];
  try {
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `${outputs.join("\n")}\n`);
    if (env.GITHUB_STEP_SUMMARY) {
      appendFileSync(
        env.GITHUB_STEP_SUMMARY,
        [
          `### Test reuse — ${decision.reuse ? "the shards are skipped" : "the shards run"}`,
          "",
          oneLine(decision.reason),
          ...(decision.reuse
            ? ["", `Matching run: ${decision.evidence.runId} (attempt ${decision.evidence.attempt}), head \`${decision.evidence.headSha}\`, tree \`${decision.evidence.treeSha}\`.`]
            : []),
          "",
        ].join("\n"),
      );
    }
  } catch (error) {
    out(`reuse: could not write the answer: ${error.message}`);
    return 1;
  }
  return 0;
};

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) process.exit(await main());
