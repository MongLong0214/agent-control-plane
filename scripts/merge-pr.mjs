#!/usr/bin/env node
/**
 * Merges a pull request as a merge commit, through the checks a merge cannot otherwise reach.
 *
 * Every pull request ACP manages merges as a merge commit (#1269): two parents, the base and the
 * exact head, so the branch's commits -- and every record their messages carry -- stay in history
 * as they were committed. Squash, rebase and fast-forward are not offered and not fallen back to: a
 * merge GitHub refuses is a refusal here.
 *
 * Until #1269 this script squashed. A squash concatenates every branch commit message and git reads
 * only the last paragraph as the trailer block, so it had to inherit the branch's records onto the
 * squash (`commitlore squash-preserve`) and name the squashed head in a `Merged-Head:` line. A merge
 * commit loses nothing it would have to carry, so neither is done; what replaces them is reading the
 * merge back as the commit it must be.
 *
 * The merge commit's message is history nobody may rewrite, so it is validated before the merge
 * (`commitlore validate` and the trailer check), exactly as the squash message was.
 *
 * It refuses to merge on anything but an observed-green head, because "the CI was green" is a claim
 * about a specific commit and the head can move between reading and merging; the same sha goes to
 * `--match-head-commit`, so GitHub merges that head or nothing. It refuses, too, a head that does
 * not already contain the base tip: CI checked the head's tree, and only then is the merge's tree
 * that same tree. GitHub's merge API takes no expected base, so the base is read back instead: a
 * base that moved in between fails loudly after the merge.
 *
 * After the merge it is read back -- and any mismatch fails loudly, because the merge cannot be
 * undone: GitHub reports the pull request merged at that commit; its parents are exactly the base
 * read before the merge and the checked head, so the head is an ancestor; its tree is that head
 * merged onto that base (`git merge-tree`); and every CommitLore note the branch's commits carry
 * here is on origin after `commitlore sync`, because the commits' own bytes travel with the merge
 * but their notes do not.
 *
 * Limit: nothing *forces* a merge through here. `gh pr merge` still exists. What GitHub accepts is
 * the repository's merge settings; this script is the sanctioned path, not the only one.
 *
 * Usage:
 *   merge-pr.mjs <number> --subject <text> --body-file <path> [--dry-run]
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { RECORD_TRAILER_KEY_PATTERN } from "./lib/record-trailer-keys.mjs";
import { pullRequest, Unanswered } from "./verify-merge-preserved-records.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const run = (file, args, input) =>
  execFileSync(file, args, { cwd: ROOT, encoding: "utf8", ...(input === undefined ? {} : { input }) });

const argv = process.argv.slice(2);
const flag = (name) => {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
};
const number = argv.find((a) => /^\d+$/.test(a));
const subject = flag("--subject");
const bodyFile = flag("--body-file");
const dryRun = argv.includes("--dry-run");

if (number === undefined || subject === undefined || bodyFile === undefined) {
  process.stdout.write("usage: merge-pr.mjs <number> --subject <text> --body-file <path> [--dry-run]\n");
  process.exit(2);
}

const fail = (why) => {
  process.stdout.write(`\nRESULT: FAIL — ${why}\n`);
  process.exit(1);
};

// 1. The head this merge would take and the base it would land on. Both are read back after the
//    merge as its two parents, so each must be one full sha.
let pr;
try {
  pr = JSON.parse(
    run("gh", ["pr", "view", number, "--json", "mergeable,mergeStateStatus,headRefOid,baseRefOid,state,title,statusCheckRollup"]),
  );
} catch (error) {
  process.stdout.write(String(error.stdout ?? error.stderr ?? error.message ?? ""));
  fail(`could not read #${number} from GitHub. A check that cannot look reports that, not a verdict.`);
}
if (pr.state !== "OPEN") fail(`#${number} is ${pr.state}.`);

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const head = pr.headRefOid;
const base = pr.baseRefOid;
if (typeof head !== "string" || !FULL_SHA.test(head)) {
  fail(`#${number}'s head from GitHub is not one full commit sha (${String(head)}).`);
}
if (typeof base !== "string" || !FULL_SHA.test(base)) {
  fail(`#${number}'s base from GitHub is not one full commit sha (${String(base)}).`);
}

// 2. The merge commit's message, validated before it becomes history: record semantics, and that git
//    stores every record line it carries as a trailer.
const draft = join(mkdtempSync(join(tmpdir(), "acp-merge-")), "message");
writeFileSync(draft, `${subject}\n\n${readFileSync(bodyFile === "-" ? 0 : bodyFile, "utf8")}`);
try {
  run("commitlore", ["validate", "--message-file", draft]);
  process.stdout.write(run("node", ["scripts/verify-trailers-are-parsable.mjs", "--message-file", draft]));
} catch (error) {
  process.stdout.write(String(error.stdout ?? ""));
  fail("the merge message violates record semantics or preservation. Refusing before it becomes history.");
}
const composed = readFileSync(draft, "utf8");
const bodyOut = `${draft}.body`;
writeFileSync(bodyOut, composed.split("\n").slice(2).join("\n"));

// 3. Only now the mergeability gates. They come after the message on purpose: the message is the
//    part that becomes history nobody may rewrite, and a PR sitting at BLOCKED while CI runs is
//    exactly when you want to know the body is wrong.
if (pr.mergeable !== "MERGEABLE") fail(`#${number} is ${pr.mergeable}.`);
// UNSTABLE is GitHub's "mergeable, and some check branch protection does not require is not green".
// On this repository that has been a superseded run's leftovers: a run cancelled by a force-push,
// or a job since deleted, kept reporting CANCELLED on the head after the required check passed.
// The required check below is the verdict; BLOCKED, BEHIND, DIRTY and the rest still refuse.
if (pr.mergeStateStatus !== "CLEAN" && pr.mergeStateStatus !== "UNSTABLE") {
  fail(`#${number} merge state is ${pr.mergeStateStatus}, not CLEAN or UNSTABLE.`);
}
// The verdict is the aggregate `verify` job of the newest `project-ci` run on this exact head, at
// that run's latest attempt — not whichever `verify` check the rollup happens to hold. Read from the
// rollup, a previous run's green `verify` stood alone while a newer run was still in its matrix
// (the aggregate job's check does not exist until the matrix finishes), and picking the latest
// `completedAt` chose the job that finished last, so an older run finishing late outranked a newer
// failure. Checks from other or superseded runs, including jobs since deleted, are not consulted.
//
// These are REST calls. The first version of this gate died on an HTTP 403 rate limit from
// `gh run list` with an unhandled exception. A read that fails here is a refusal that says it could
// not look; a stack trace said neither that nor "green".
const WORKFLOW = "project-ci";
const REQUIRED_CHECK = "verify";
const short = head.slice(0, 7);
const ghJson = (args, what) => {
  try {
    return JSON.parse(run("gh", args));
  } catch (error) {
    process.stdout.write(String(error.stdout ?? error.stderr ?? error.message ?? ""));
    return fail(`could not read ${what} for ${short}. A check that cannot look reports that, not a verdict.`);
  }
};
const runs = ghJson(
  ["run", "list", "--commit", head, "--workflow", WORKFLOW, "--limit", "100", "--json", "databaseId,attempt,status,headSha"],
  `the ${WORKFLOW} runs`,
).filter((r) => r.headSha === head);
if (runs.length === 0) fail(`no ${WORKFLOW} run on ${short}. A green claim needs a run.`);
const current = runs.reduce((a, b) => (b.databaseId > a.databaseId ? b : a));
const named = `${WORKFLOW} run ${current.databaseId} attempt ${current.attempt}`;
if (current.status !== "completed") fail(`the newest ${named} on ${short} is ${current.status}, not completed.`);
const { jobs } = ghJson(
  ["run", "view", String(current.databaseId), "--attempt", String(current.attempt), "--json", "jobs"],
  `the jobs of ${named}`,
);
const gate = (jobs ?? []).filter((j) => j.name === REQUIRED_CHECK);
if (gate.length !== 1) fail(`${named} has ${gate.length} \`${REQUIRED_CHECK}\` job(s); exactly one is the verdict.`);
if (gate[0].status !== "completed" || gate[0].conclusion !== "success") {
  fail(`the \`${REQUIRED_CHECK}\` job of ${named} is ${gate[0].status}/${gate[0].conclusion || "none"}, not completed/success.`);
}
// A commit status named `verify` is not a job of any run, so the run above cannot speak for it.
// GitHub keeps one state per status context, so the one in the rollup is current: anything but
// SUCCESS, pending included, refuses.
for (const status of (pr.statusCheckRollup ?? []).filter((c) => c.context === REQUIRED_CHECK)) {
  if (status.state !== "SUCCESS") fail(`the \`${REQUIRED_CHECK}\` commit status on ${short} is ${status.state}.`);
}

// The head must already contain the base tip. CI checked the head's tree; merged onto a base it does
// not contain, the merge commit's tree is one no CI run saw, however green the head. GitHub's compare
// answers it for these exact two shas, so nothing local has to be fetched first.
const compared = ghJson(
  ["api", `repos/{owner}/{repo}/compare/${base}...${head}`, "--jq", "{status: .status}"],
  `how ${short} compares with the base ${base.slice(0, 7)}`,
)?.status;
if (compared !== "ahead" && compared !== "identical") {
  fail(`#${number}'s head ${short} does not contain the base ${base.slice(0, 7)} (GitHub compares it as ${String(compared)}), so CI never checked the tree this merge would make. Update the branch, re-run CI.`);
}

process.stdout.write(
  `\n  #${number} ${pr.title}\n  head ${short} — \`${REQUIRED_CHECK}\` green in ${named}, contains base ${base.slice(0, 7)}\n`,
);

if (dryRun) {
  process.stdout.write("\nRESULT: PASS — checks only, nothing merged (--dry-run).\n");
  process.exit(0);
}

// 4. Merge the head that was checked, as a merge commit and nothing else, with the body that was checked.
run("gh", ["pr", "merge", number, "--merge", "--match-head-commit", head, "--subject", subject, "--body-file", bodyOut]);

// Everything after this point reads back a merge that cannot be undone, so a refusal says so.
const failMerged = (why) => {
  process.stdout.write(`\nRESULT: FAIL — #${number} is merged, and reading it back does not match what was checked: ${why}\n`);
  process.exit(1);
};

// The merge commit, as GitHub answers it: merged, with its sha.
let merged;
try {
  process.chdir(ROOT);
  const answer = pullRequest(number);
  if (answer === "absent" || !answer.merged) throw new Unanswered(`GitHub does not report #${number} as merged`);
  merged = answer.mergeCommit;
} catch (error) {
  if (!(error instanceof Unanswered)) throw error;
  failMerged(`${error.message}.`);
}

// 5. The branch's notes, onto origin. The commits travel with the merge; their notes do not.
try {
  run("git", ["fetch", "origin", "--quiet"]);
  run("commitlore", ["sync"]);
} catch (error) {
  process.stdout.write(String(error.stdout ?? error.stderr ?? ""));
  process.stdout.write("\n  WARN  `commitlore sync` failed; the read-back below says which notes origin lacks.\n");
}

// 6. Read the merge back: its parents, its tree, and the branch's notes as origin holds them.
const NOTES = "refs/notes/commitlore";
const mismatches = [];
let recordLines = 0;
let notesCarried = 0;
try {
  const parents = run("git", ["rev-list", "--parents", "-n", "1", merged]).trim().split(" ").slice(1);
  if (parents.length !== 2 || parents[0] !== base || parents[1] !== head) {
    mismatches.push(`${merged.slice(0, 8)}'s parents are [${parents.map((p) => p.slice(0, 8)).join(", ")}], not the base and head checked, [${base.slice(0, 8)}, ${head.slice(0, 8)}]`);
  }
  try {
    run("git", ["merge-base", "--is-ancestor", head, merged]);
  } catch {
    mismatches.push(`the head checked, ${head.slice(0, 8)}, is not an ancestor of ${merged.slice(0, 8)}`);
  }
  const tree = run("git", ["rev-parse", "--verify", `${merged}^{tree}`]).trim();
  let rebuilt = "";
  try {
    rebuilt = run("git", ["merge-tree", "--write-tree", base, head]).split("\n")[0]?.trim() ?? "";
  } catch {
    rebuilt = "";
  }
  if (rebuilt !== tree) {
    mismatches.push(`its tree ${tree.slice(0, 8)} is not ${head.slice(0, 8)} merged onto ${base.slice(0, 8)} (${rebuilt ? rebuilt.slice(0, 8) : "that merge does not resolve"})`);
  }
  const branch = run("git", ["rev-list", `${base}..${head}`]).split("\n").filter(Boolean);
  for (const sha of branch) {
    const body = run("git", ["log", "-1", "--format=%B", sha]);
    recordLines += run("git", ["interpret-trailers", "--parse"], body).split("\n").filter((l) => RECORD_TRAILER_KEY_PATTERN.test(l)).length;
  }
  const local = new Map();
  if (run("git", ["for-each-ref", "--format=%(refname)", NOTES]).trim() === NOTES) {
    for (const line of run("git", ["notes", `--ref=${NOTES}`, "list"]).split("\n").filter(Boolean)) {
      const [blob, object] = line.split(" ");
      local.set(object, blob);
    }
  }
  const owed = branch.filter((sha) => local.has(sha));
  if (owed.length > 0) {
    const remote = new Map();
    const advertised = run("git", ["ls-remote", "origin", NOTES]).trim().split(/\s+/u)[0] ?? "";
    if (FULL_SHA.test(advertised)) {
      run("git", ["fetch", "--quiet", "--no-tags", "origin", NOTES]);
      for (const line of run("git", ["ls-tree", "-r", advertised]).split("\n").filter(Boolean)) {
        const [meta, path] = line.split("\t");
        remote.set(path.replaceAll("/", ""), meta.split(" ")[2]);
      }
    }
    for (const sha of owed) {
      if (remote.get(sha) === local.get(sha)) notesCarried += 1;
      else mismatches.push(`origin does not carry ${sha.slice(0, 8)}'s CommitLore note`);
    }
  }
  if (mismatches.length === 0) {
    process.stdout.write(`  read back ${merged.slice(0, 7)}: parents ${base.slice(0, 7)} and ${head.slice(0, 7)}, tree ${tree.slice(0, 7)}, ` +
      `${recordLines} record line(s) kept on ${branch.length} branch commit(s), ${notesCarried} note(s) on origin\n`);
  }
} catch (error) {
  if (error?.status === undefined) throw error;
  mismatches.push(`git could not read ${merged.slice(0, 8)} back`);
}
if (mismatches.length > 0) {
  failMerged(`\n${mismatches.map((line) => `    ${line}`).join("\n")}\n  Recover notes with: commitlore sync`);
}

process.stdout.write(`\nRESULT: PASS — #${number} merged at ${head.slice(0, 7)}.\n`);
