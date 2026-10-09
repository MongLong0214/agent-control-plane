#!/usr/bin/env node
/**
 * Merges a pull request through the checks a merge cannot otherwise reach.
 *
 * A squash-merge commit is composed by GitHub from arguments handed to `gh pr merge`. No local
 * hook runs on it. So on 2026-08-22 the `commit-msg` hook — written that same day, installed, and
 * working — watched a wrapped `Limit:` trailer land in the merge commit for #665. Post-merge CI
 * caught it, which is detection after the commit exists, on a `main` that must not be rewritten.
 *
 * Measuring that failure found a larger one underneath it. A squash concatenates every branch
 * commit message, and git reads only the **last paragraph** as the trailer block, so all but the
 * final commit's records are dropped by the merge itself. Across the three merges on `main`:
 *
 *     8ab3342   19 record lines on the branch    3 stored by the merge
 *     108ab1a   30                                0
 *     74c37fa   83                                0        (32 commits)
 *
 * Nothing reported it. The previous range check looked for a continuation line directly after a
 * trailer and could not see a trailer sitting in a paragraph that was not the last one.
 *
 * `commitlore squash-preserve` exists for exactly this (ADR-0004) and I did not call it. So this
 * script does not accept a hand-written merge body as final: it hands the draft to
 * `squash-preserve --message-file`, which appends the branch's inherited records, and only then
 * asks the trailer check whether git will store what results. The body is a summary; the record
 * is inherited rather than retyped.
 *
 * It also refuses to merge on anything but an observed-green head, because "the CI was green" is
 * a claim about a specific commit and the head can move between reading and merging.
 *
 * Limit, stated because this file is about a guard that was true and reachable around: nothing
 * *forces* a merge through here. `gh pr merge` still exists and still works. What closes that hole
 * is the post-merge `pnpm trailers HEAD~1..HEAD` step in CI, which is detection — the two together
 * are prevention on the intended path and a loud failure on any other.
 *
 * Limit: conservation is only checkable for records that declare a `Record-Id:`. `commitlore
 * doctor` reports "every declared Record-Id is reachable" and, on this repository today, adds that
 * 20 branches declared none and could not be checked — a pass that conserved nothing. Inheriting
 * the records fixes the loss; it does not make the check able to see it.
 *
 * The squash names the head it was made from. `verify-merge-preserved-records.mjs` reads a
 * squash's branch up to that head, and nothing GitHub keeps after the merge says which head that
 * was: the pull request's `head.sha` moves, and the squash's tree and inherited sources were shown
 * to accept a rewritten or rolled-back one. So the message carries `Merged-Head: <sha>`, the exact
 * head whose required CI this script checked, and the same sha goes to `--match-head-commit`, so
 * GitHub merges that head or nothing. It is its own paragraph straight after the subject:
 * `commitlore validate` refuses an unknown key inside the trailer block (`unknown-key`), and a
 * paragraph there is outside the record region `verify-trailers-are-parsable.mjs` requires to end
 * the message. After the merge the commit is read back — the trailer, the tree and the records the
 * gate will check — and any mismatch fails loudly, because the merge itself cannot be undone.
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
import { examineSquash, mergedHeadIn, pullRequest, Unanswered } from "./verify-merge-preserved-records.mjs";

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

// 1. The head this merge would take, and whether that exact commit is green. Read before the
//    message is composed, because the records to inherit come from the range this head closes.
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

const head = pr.headRefOid;
// The head is written into history as the squash's `Merged-Head`, so it must be one full sha.
if (typeof head !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(head)) {
  fail(`#${number}'s head from GitHub is not one full commit sha (${String(head)}).`);
}

// 2. The branch's own records, carried onto the merge rather than retyped into it. `squash-preserve`
//    rewrites the draft in place; the merged body is whatever it produces, which is the point —
//    a hand-written summary cannot be the only carrier of a record. The draft opens with the
//    `Merged-Head` paragraph naming the head checked below, so the official bytes carry it.
const draft = join(mkdtempSync(join(tmpdir(), "acp-merge-")), "message");
writeFileSync(draft, `${subject}\n\nMerged-Head: ${head}\n\n${readFileSync(bodyFile === "-" ? 0 : bodyFile, "utf8")}`);
try {
  run("commitlore", ["squash-preserve", `${pr.baseRefOid}..${head}`, "--message-file", draft]);
} catch (error) {
  process.stdout.write(String(error.stdout ?? error.stderr ?? ""));
  fail("could not inherit the branch's records onto the merge message.");
}

// CommitLore 1.5.0 owns the record boundaries. Joining its paragraphs corrupts
// singleton cardinality even though Git's final-paragraph parser accepts it.
// Freeze the official bytes before validation and body extraction.
const expected = `${draft}.official`;
writeFileSync(expected, readFileSync(draft));

// 3. Semantic validity and byte preservation are separate from Git trailer parsing. First, the
//    composed message names the checked head once and only once — a body that already carries a
//    `Merged-Head` line would make the squash unverifiable for good, so it refuses here.
try {
  const named = mergedHeadIn(readFileSync(draft, "utf8"), "the merge message");
  if (named !== head) throw new Unanswered(`the merge message names ${named.slice(0, 8)} as its Merged-Head, not the head checked, ${head.slice(0, 8)}`);
} catch (error) {
  if (!(error instanceof Unanswered)) throw error;
  fail(`${error.message}. Refusing before it becomes history.`);
}
try {
  run("commitlore", ["validate", "--message-file", draft]);
  process.stdout.write(run("node", ["scripts/verify-trailers-are-parsable.mjs", "--message-file", draft,
    "--expected-message-file", expected]));
} catch (error) {
  process.stdout.write(String(error.stdout ?? ""));
  fail("the merge message violates record semantics or preservation. Refusing before it becomes history.");
}

const composed = readFileSync(draft, "utf8");
const inherited = composed.split("\n").filter((l) => RECORD_TRAILER_KEY_PATTERN.test(l));
process.stdout.write(`  ${inherited.length} record line(s) will be stored on the merge commit\n`);
const bodyOut = `${draft}.body`;
writeFileSync(bodyOut, composed.split("\n").slice(2).join("\n"));

// 4. Only now the mergeability gates. They come after the message on purpose: the message is the
//    part that becomes history nobody may rewrite, and a PR sitting at BLOCKED while CI runs is
//    exactly when you want to know the body is wrong — checking it last means a dry run against a
//    pending PR reports the merge state and never looks at the message at all.
if (pr.mergeable !== "MERGEABLE") fail(`#${number} is ${pr.mergeable}.`);
// UNSTABLE is GitHub's "mergeable, and some check branch protection does not require is not green".
// On this repository that has been a superseded run's leftovers: a run cancelled by a force-push,
// or a job since deleted, kept reporting CANCELLED on the head after the required check passed,
// and the only way through was pushing a new commit to change the head. The required check below
// is the verdict; BLOCKED, BEHIND, DIRTY and the rest still refuse.
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

process.stdout.write(
  `\n  #${number} ${pr.title}\n  head ${short} — \`${REQUIRED_CHECK}\` green in ${named}\n`,
);

if (dryRun) {
  process.stdout.write("\nRESULT: PASS — checks only, nothing merged (--dry-run).\n");
  process.exit(0);
}

// 4. Merge the head that was checked, not whatever the head is by now, with the body that was checked.
//    The body opens with `Merged-Head: ${head}`; the same sha is the head GitHub must match.
run("gh", ["pr", "merge", number, "--squash", "--match-head-commit", head, "--subject", subject, "--body-file", bodyOut]);

// Everything after this point reads back a merge that cannot be undone, so a refusal says so.
const failMerged = (why) => {
  process.stdout.write(`\nRESULT: FAIL — #${number} is merged, and reading it back does not match what was checked: ${why}\n`);
  process.exit(1);
};

// The merge commit, as GitHub answers it to the merge-records gate: merged, with its sha.
let merged;
try {
  process.chdir(ROOT);
  const answer = pullRequest(number);
  if (answer === "absent" || !answer.merged) throw new Unanswered(`GitHub does not report #${number} as merged`);
  merged = answer.mergeCommit;
} catch (error) {
  if (!(error instanceof Unanswered)) throw error;
  failMerged(`${error.message}. Read it back by hand: \`pnpm merge-records <merge commit>~1..<merge commit>\`.`);
}

// 5. The same records, onto the notes ref. The message above carries them as trailers and git
//    keeps only the last paragraph of them — `squash-preserve` says so itself when it composes the
//    draft, and this repository has already paid for it: nine of the last twenty-five merges lost
//    trailers that way, and two of those had no note either, so the records existed nowhere until
//    they were recovered by hand. A note is not parsed as a trailer block, so every record
//    survives there whatever git does with the message.
//
//    After the merge because the target is the merge commit, which does not exist until now. A
//    failure to write the note is reported here, and the read-back below then refuses if the merge
//    no longer carries every record; the recovery is `commitlore squash-preserve <range> --target
//    <sha>` run again by hand.
try {
  run("git", ["fetch", "origin", "--quiet"]);
  process.stdout.write(run("commitlore", ["squash-preserve", `${pr.baseRefOid}..${head}`, "--target", merged]));
  run("commitlore", ["sync"]);
  process.stdout.write(`  records mirrored onto ${merged.slice(0, 7)} and published\n`);
} catch (error) {
  process.stdout.write(String(error.stdout ?? error.stderr ?? ""));
  process.stdout.write(`\n  WARN  the note for ${merged.slice(0, 7)} was not written. Recover with:\n`);
  process.stdout.write(`        commitlore squash-preserve ${pr.baseRefOid}..${head} --target ${merged} && commitlore sync\n`);
}

// 6. Read the merge back the way `pnpm merge-records` will: one parent, a `Merged-Head` naming the
//    head checked above, a tree that is that head merged onto the parent, and every record line
//    the branch carried reachable from the merge as a trailer or in its note.
const mismatches = [];
try {
  const parents = run("git", ["rev-list", "--parents", "-n", "1", merged]).trim().split(" ").slice(1);
  if (parents.length !== 1) mismatches.push(`${merged.slice(0, 8)} has ${parents.length} parent(s), not the one a squash has`);
  const { head: named, parent, carried, missing } = examineSquash(merged, number);
  if (named !== head) mismatches.push(`its Merged-Head is ${named.slice(0, 8)}, not the head checked, ${head.slice(0, 8)}`);
  const tree = run("git", ["rev-parse", "--verify", `${merged}^{tree}`]).trim();
  let rebuilt = "";
  try {
    rebuilt = run("git", ["merge-tree", "--write-tree", parent, head]).split("\n")[0]?.trim() ?? "";
  } catch {
    rebuilt = "";
  }
  if (rebuilt !== tree) {
    mismatches.push(`its tree ${tree.slice(0, 8)} is not ${head.slice(0, 8)} merged onto its parent ${parent.slice(0, 8)} (${rebuilt ? rebuilt.slice(0, 8) : "that merge does not resolve"})`);
  }
  for (const [line, from] of missing) mismatches.push(`it does not keep ${from.slice(0, 8)}'s record line "${line.slice(0, 96)}"`);
  if (mismatches.length === 0) {
    process.stdout.write(`  read back ${merged.slice(0, 7)}: Merged-Head ${head.slice(0, 7)}, tree ${tree.slice(0, 7)}, ${carried.size} record line(s) all reachable\n`);
  }
} catch (error) {
  if (!(error instanceof Unanswered) && error?.status === undefined) throw error;
  mismatches.push(error instanceof Unanswered ? error.message : `git could not read ${merged.slice(0, 8)} back`);
}
if (mismatches.length > 0) {
  failMerged(`\n${mismatches.map((line) => `    ${line}`).join("\n")}\n  Recover records with: commitlore squash-preserve ${pr.baseRefOid}..${head} --target ${merged} && commitlore sync`);
}

process.stdout.write(`\nRESULT: PASS — #${number} merged at ${head.slice(0, 7)}.\n`);
