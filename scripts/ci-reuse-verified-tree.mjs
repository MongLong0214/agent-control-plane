#!/usr/bin/env node
/**
 * Decides whether a `push` run of `project-ci` may skip its test shards because the pull-request run
 * this push merged already passed every shard on the very tree, base and workflow this push lands.
 *
 * Why it exists: a pull request's head got the whole suite, `scripts/merge-pr.mjs` squash-merged it,
 * and the `main` push then ran the whole suite again — about 36 macOS minutes — on a tree identical
 * to the one just judged. Both `main` failures from 2026-10-19 to 2026-10-26 were timing flakes on
 * trees whose pull-request run had passed.
 *
 * What a pull-request run tests is not its head. `actions/checkout` on `pull_request` checks out
 * GitHub's synthetic merge commit (`refs/pull/N/merge`): the head merged into the base tip of that
 * moment, with that commit's own workflow file. And a squash merge's head is never an ancestor of
 * the push — the squash's parent is the previous `main`, and its message carries the head as a
 * `Merged-Head:` line. So identity comes from the message, and what was tested comes from the run.
 *
 * A pull-request run is reused only when all of these hold, and each is checked, not assumed:
 *
 *   1. the event is `push` and the payload says `forced: false`; `pull_request`, `schedule` and
 *      everything else always run the shards;
 *   2. the tree GitHub records for this push equals `git rev-parse HEAD^{tree}` of the checkout,
 *      and the push has exactly one parent;
 *   3. its message names exactly one `Merged-Head: <sha>` (`mergedHeadIn`, the parser the
 *      merge-records gate uses); no line, or more than one, is no reuse;
 *   4. the newest run of this workflow on that head is a `pull_request` run in this repository from
 *      a head in this repository — never a fork, whose workflow could write its own record — and it
 *      is completed/success, and in its latest attempt every job is completed/success, with exactly
 *      one `verify`, exactly one `verify (gates)` and shard jobs `verify (shard i/N)`, i in 1..N;
 *   5. that run holds exactly one unexpired record artifact per job that executed code —
 *      `ci-executed-gates` and `ci-executed-shard-i` — each written by `--record` from that job's own
 *      checkout, and all of them agree on the commit, tree, base and workflow blob they ran;
 *   6. what they ran is what this push lands: recorded tree == this push's tree, recorded base (the
 *      synthetic merge's first parent) == this push's parent, recorded second parent == the
 *      `Merged-Head`, and recorded workflow blob == this push's `.github/workflows/ci.yml` blob.
 *
 * Fail closed: any API error, missing or expired record, unreadable field, or unmet condition answers
 * `reuse=false` and the full sharded suite runs. The script exits 0 for either answer; if it cannot
 * even write its answer it exits 1, the job's output is then empty, and an empty answer also runs
 * the shards.
 *
 * The records are written by the pull request's own workflow, so they are trusted only as far as a
 * same-repository pull request is — the same trust its required `verify` check already rests on.
 * Not covered by any record, and therefore not claimed: the runner image behind the `macos-15`
 * label and the `pnpm` 10.x minor that `pnpm/action-setup` resolves can move between the two runs.
 *
 * Usage (CI):
 *   node scripts/ci-reuse-verified-tree.mjs                 decide; reads GITHUB_* and GH_TOKEN,
 *                                                           writes `reuse`, `run_id`, `head_sha`,
 *                                                           `tree_sha`, `reason` to GITHUB_OUTPUT
 *   node scripts/ci-reuse-verified-tree.mjs --record <job>  write this checkout's record to
 *                                                           evidence/local/ci-executed.json
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { mergedHeadIn } from "./verify-merge-preserved-records.mjs";

export const VERDICT_JOB = "verify";
export const GATES_JOB = "verify (gates)";
export const SHARD_JOB = /^verify \(shard ([1-9]\d*)\/([1-9]\d*)\)$/;
export const RECORD_SCHEMA = "acp.ci-executed.v1";
export const RECORD_FILE = "ci-executed.json";
export const recordArtifact = (job) => `ci-executed-${job}`;
const RECORD_PREFIX = recordArtifact("");
const SHA = /^[0-9a-f]{40}$/;

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const RECORD_PATH = join(ROOT, "evidence", "local", RECORD_FILE);

class Refusal extends Error {}
const refuse = (reason) => {
  throw new Refusal(reason);
};

/**
 * Every job of the attempt succeeded, and the attempt holds the verdict, the gates and a full shard
 * set. Returns `{ shards: N }`, or `{ wrong: reason }`.
 */
export const jobsProveTheSuite = (jobs, { runId, headSha }) => {
  const wrong = (reason) => ({ wrong: reason });
  if (!Array.isArray(jobs) || jobs.length === 0) return wrong("the run lists no jobs");
  const names = jobs.map((job) => job?.name);
  for (const job of jobs) {
    if (job?.run_id !== runId || job?.head_sha !== headSha) return wrong(`job ${JSON.stringify(job?.name)} is not from run ${runId} on ${headSha}`);
    if (job.status !== "completed" || job.conclusion !== "success") {
      return wrong(`job ${JSON.stringify(job.name)} is ${job.status}/${job.conclusion ?? "none"}, not completed/success`);
    }
  }
  if (names.filter((name) => name === VERDICT_JOB).length !== 1) return wrong(`the run does not have exactly one \`${VERDICT_JOB}\` job`);
  if (names.filter((name) => name === GATES_JOB).length !== 1) return wrong(`the run does not have exactly one \`${GATES_JOB}\` job`);
  const shards = names.map((name) => SHARD_JOB.exec(name ?? "")).filter(Boolean);
  if (shards.length === 0) return wrong("the run has no test shard jobs");
  const total = Number(shards[0][2]);
  const indices = new Set();
  for (const [, index, of] of shards) {
    if (Number(of) !== total) return wrong("the run's shard jobs disagree on the shard count");
    if (indices.has(Number(index))) return wrong(`shard ${index}/${total} appears twice`);
    indices.add(Number(index));
  }
  for (let index = 1; index <= total; index += 1) {
    if (!indices.has(index)) return wrong(`shard ${index}/${total} is missing`);
  }
  return { shards: total };
};

/** The fields a record pins, in the order they are compared. */
const RECORDED = ["head", "tree", "base", "mergedHead", "workflowBlob"];

/**
 * `context` holds the runner's own facts; `api(path)` returns GitHub's parsed JSON or throws;
 * `download(runId, artifactName)` returns that artifact's parsed record or throws.
 * Returns `{ reuse: true, reason, evidence }` or `{ reuse: false, reason }`.
 */
export const decideReuse = async (context, api, download) => {
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
    const parents = pushed?.parents;
    if (!Array.isArray(parents) || parents.length !== 1 || !SHA.test(parents[0]?.sha ?? "")) {
      refuse(`${sha} does not have exactly one parent, so it is not a squash a pull-request run could have tested`);
    }
    const base = parents[0].sha;
    let head;
    try {
      head = mergedHeadIn(String(pushed?.commit?.message ?? ""), `push ${sha.slice(0, 12)}`);
    } catch (error) {
      refuse(error?.message ?? String(error));
    }
    if (!SHA.test(head)) refuse(`the Merged-Head ${head} is not a full commit sha`);

    const self = await api(`/repos/${repository}/actions/runs/${runId}`);
    if (self?.head_sha !== sha || self?.event !== "push" || self?.repository?.full_name !== repository || self?.path !== workflowPath) {
      refuse(`this run's own record does not describe a push of ${sha} through ${workflowPath} in ${repository}`);
    }
    const workflowId = self.workflow_id;

    const pushedBlob = (await api(`/repos/${repository}/contents/${workflowPath}?ref=${sha}`))?.sha;
    if (!SHA.test(pushedBlob ?? "") || pushedBlob !== localWorkflowBlob) {
      refuse(`GitHub records ${workflowPath} as ${pushedBlob} at ${sha}, the checkout has ${localWorkflowBlob}`);
    }

    const onHead = (await api(`/repos/${repository}/actions/workflows/${workflowId}/runs?event=pull_request&head_sha=${head}&per_page=100`))?.workflow_runs;
    const runs = (Array.isArray(onHead) ? onHead : []).filter(
      (run) =>
        run?.event === "pull_request" &&
        run?.workflow_id === workflowId &&
        run?.path === workflowPath &&
        run?.head_sha === head &&
        run?.repository?.full_name === repository,
    );
    if (runs.length === 0) refuse(`no pull-request run of ${workflowPath} is recorded on the Merged-Head ${head}`);
    const newest = runs.reduce((a, b) => (b.id > a.id ? b : a));
    if (newest.head_repository?.full_name !== repository) {
      refuse(`the newest run on ${head.slice(0, 12)} came from ${newest.head_repository?.full_name ?? "an unnamed repository"}, not ${repository}`);
    }
    if (newest.status !== "completed" || newest.conclusion !== "success") {
      refuse(`the newest run on ${head.slice(0, 12)}, ${newest.id}, is ${newest.status}/${newest.conclusion ?? "none"}`);
    }

    const attempt = newest.run_attempt;
    const listed = await api(`/repos/${repository}/actions/runs/${newest.id}/attempts/${attempt}/jobs?per_page=100`);
    const jobs = listed?.jobs;
    if (!Array.isArray(jobs) || listed?.total_count !== jobs.length) refuse(`the jobs of run ${newest.id} attempt ${attempt} did not come back whole`);
    const suite = jobsProveTheSuite(jobs, { runId: newest.id, headSha: head });
    if (suite.wrong) refuse(`run ${newest.id} attempt ${attempt}: ${suite.wrong}`);

    // One record per job that executed code: the gates and every shard. Exactly those, once each.
    const expected = ["gates", ...Array.from({ length: suite.shards }, (_, index) => `shard-${index + 1}`)].map(recordArtifact);
    const stored = await api(`/repos/${repository}/actions/runs/${newest.id}/artifacts?per_page=100`);
    const artifacts = stored?.artifacts;
    if (!Array.isArray(artifacts) || stored?.total_count !== artifacts.length) refuse(`the artifacts of run ${newest.id} did not come back whole`);
    const recordNames = artifacts.map((artifact) => artifact?.name).filter((name) => typeof name === "string" && name.startsWith(RECORD_PREFIX)).sort();
    if (JSON.stringify(recordNames) !== JSON.stringify([...expected].sort())) {
      refuse(`run ${newest.id} holds records [${recordNames.join(", ")}], not one each of [${expected.join(", ")}]`);
    }
    for (const artifact of artifacts.filter((entry) => recordNames.includes(entry.name))) {
      if (artifact.expired !== false || artifact.workflow_run?.id !== newest.id || artifact.workflow_run?.head_sha !== head) {
        refuse(`record ${artifact.name} of run ${newest.id} is expired or belongs to another run`);
      }
    }

    const records = [];
    for (const name of expected) {
      let record;
      try {
        record = await download(newest.id, name);
      } catch (error) {
        refuse(`record ${name} of run ${newest.id} could not be read: ${error?.message ?? String(error)}`);
      }
      if (record?.schema !== RECORD_SCHEMA || recordArtifact(record?.job ?? "") !== name || record?.event !== "pull_request") {
        refuse(`record ${name} of run ${newest.id} is not a ${RECORD_SCHEMA} record of a pull_request job named ${name}`);
      }
      for (const field of RECORDED) {
        if (!SHA.test(record[field] ?? "")) refuse(`record ${name} of run ${newest.id} has no full sha for ${field}`);
      }
      records.push(record);
    }
    for (const field of RECORDED) {
      const values = new Set(records.map((record) => record[field]));
      if (values.size !== 1) refuse(`the jobs of run ${newest.id} executed different ${field} values: ${[...values].join(", ")}`);
    }
    const ran = records[0];
    if (ran.tree !== tree) refuse(`run ${newest.id} tested tree ${ran.tree}; this push lands ${tree}`);
    if (ran.base !== base) refuse(`run ${newest.id} tested on base ${ran.base}; this push's parent is ${base}`);
    if (ran.mergedHead !== head) refuse(`run ${newest.id} merged ${ran.mergedHead}, not the Merged-Head ${head}`);
    if (ran.workflowBlob !== pushedBlob) refuse(`run ${newest.id} executed ${workflowPath} ${ran.workflowBlob}; this push has ${pushedBlob}`);

    return {
      reuse: true,
      reason: `pull-request run ${newest.id} attempt ${attempt} passed every shard on ${ran.head}: tree ${tree}, base ${base}, head ${head}`,
      evidence: {
        runId: newest.id,
        attempt,
        headSha: head,
        testedCommit: ran.head,
        treeSha: tree,
        parentSha: base,
        workflowBlob: pushedBlob,
        jobs: jobs.map((job) => job.name).sort(),
        records: expected,
      },
    };
  } catch (error) {
    const reason = error instanceof Refusal ? error.message : `could not ask GitHub: ${error?.message ?? String(error)}`;
    return { reuse: false, reason };
  }
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

/** One record artifact of another run of this repository, through `gh` (GH_TOKEN, `actions: read`). */
const ghDownload = (repository) => async (runId, name) => {
  const directory = mkdtempSync(join(tmpdir(), "acp-ci-executed-"));
  try {
    execFileSync("gh", ["run", "download", String(runId), "--repo", repository, "--name", name, "--dir", directory], {
      timeout: 60_000,
      stdio: ["ignore", "ignore", "pipe"],
    });
    return JSON.parse(readFileSync(join(directory, RECORD_FILE), "utf8"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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

/**
 * What this job's checkout is: on `pull_request`, GitHub's synthetic merge, whose first parent is
 * the base it was tested against and whose second is the pull request's head. Written before any
 * gate or test runs; a value that does not resolve is written as "" and makes the record unusable.
 */
export const executionRecord = (job, env = process.env, rev = revParse) => {
  const workflowPath = workflowPathFrom(env.GITHUB_WORKFLOW_REF, env.GITHUB_REPOSITORY ?? "");
  return {
    schema: RECORD_SCHEMA,
    job,
    event: env.GITHUB_EVENT_NAME ?? "",
    head: rev("HEAD"),
    tree: rev("HEAD^{tree}"),
    base: rev("HEAD^1"),
    mergedHead: rev("HEAD^2"),
    workflowBlob: workflowPath ? rev(`HEAD:${workflowPath}`) : "",
  };
};

export const main = async (argv = process.argv.slice(2), env = process.env, out = (line) => process.stdout.write(`${line}\n`)) => {
  if (argv[0] === "--record") {
    const job = argv[1] ?? "";
    if (!/^(gates|shard-[1-9]\d*)$/.test(job) || argv.length !== 2) {
      out("usage: ci-reuse-verified-tree.mjs --record gates|shard-<i>");
      return 2;
    }
    const record = executionRecord(job, env);
    mkdirSync(dirname(RECORD_PATH), { recursive: true });
    writeFileSync(RECORD_PATH, `${JSON.stringify(record)}\n`);
    out(`recorded ${recordArtifact(job)}: ${JSON.stringify(record)}`);
    return 0;
  }
  if (argv.length > 0) {
    out(`unrecognised argument(s): ${argv.join(" ")}`);
    return 2;
  }

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
  const decision = await decideReuse(context, api, ghDownload(repository));

  out(`reuse: ${decision.reuse ? "yes" : "no"} — ${decision.reason}`);
  if (decision.reuse) {
    const e = decision.evidence;
    out(`  matching run ${e.runId} attempt ${e.attempt}, Merged-Head ${e.headSha}, tested merge ${e.testedCommit}`);
    out(`  tree ${e.treeSha}, base ${e.parentSha}, workflow blob ${e.workflowBlob}`);
    out(`  jobs: ${e.jobs.join(", ")}; records: ${e.records.join(", ")}`);
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
            ? ["", `Matching run: ${decision.evidence.runId} (attempt ${decision.evidence.attempt}), Merged-Head \`${decision.evidence.headSha}\`, tested merge \`${decision.evidence.testedCommit}\`, tree \`${decision.evidence.treeSha}\`, base \`${decision.evidence.parentSha}\`.`]
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
