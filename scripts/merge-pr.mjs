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
 *     8ab3342   3 branch records   3 survived
 *     108ab1a  11 branch records   0 survived
 *     74c37fa  30 branch records   0 survived   (32 commits)
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
 * Usage:
 *   merge-pr.mjs <number> --subject <text> --body-file <path> [--dry-run]
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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
const pr = JSON.parse(
  run("gh", ["pr", "view", number, "--json", "mergeable,mergeStateStatus,headRefOid,baseRefOid,state,title"]),
);
if (pr.state !== "OPEN") fail(`#${number} is ${pr.state}.`);
if (pr.mergeable !== "MERGEABLE") fail(`#${number} is ${pr.mergeable}.`);
if (pr.mergeStateStatus !== "CLEAN") fail(`#${number} merge state is ${pr.mergeStateStatus}, not CLEAN.`);

const head = pr.headRefOid;

// 2. The branch's own records, carried onto the merge rather than retyped into it. `squash-preserve`
//    rewrites the draft in place; the merged body is whatever it produces, which is the point —
//    a hand-written summary cannot be the only carrier of a record.
const draft = join(mkdtempSync(join(tmpdir(), "acp-merge-")), "message");
writeFileSync(draft, `${subject}\n\n${readFileSync(bodyFile === "-" ? 0 : bodyFile, "utf8")}`);
try {
  run("commitlore", ["squash-preserve", `${pr.baseRefOid}..${head}`, "--message-file", draft]);
} catch (error) {
  process.stdout.write(String(error.stdout ?? error.stderr ?? ""));
  fail("could not inherit the branch's records onto the merge message.");
}

// 3. What results, against git's own parser, before it becomes a commit nobody may rewrite.
try {
  process.stdout.write(run("node", ["scripts/verify-trailers-are-parsable.mjs", "--message-file", draft]));
} catch (error) {
  process.stdout.write(String(error.stdout ?? ""));
  fail("the merge message carries a trailer git will not store. Fix it here; after the merge it is history.");
}

const composed = readFileSync(draft, "utf8");
const inherited = composed.split("\n").filter((l) => /^(Limit|Ruled-out|Warn|Supersedes|Refs|Record-Id):/.test(l));
process.stdout.write(`  ${inherited.length} record line(s) will be stored on the merge commit\n`);
const bodyOut = `${draft}.body`;
writeFileSync(bodyOut, composed.split("\n").slice(2).join("\n"));
const runs = JSON.parse(
  run("gh", ["run", "list", "--commit", head, "--limit", "20", "--json", "conclusion,status,databaseId,workflowName"]),
);
const finished = runs.filter((r) => r.status === "completed");
if (finished.length === 0) fail(`no completed CI run for ${head.slice(0, 7)}. A green claim needs a run.`);
const red = finished.filter((r) => r.conclusion !== "success" && r.conclusion !== "skipped");
if (red.length > 0) {
  for (const r of red) process.stdout.write(`  ${r.databaseId} ${r.workflowName}: ${r.conclusion}\n`);
  fail(`${red.length} non-green run(s) on ${head.slice(0, 7)}.`);
}

process.stdout.write(
  `\n  #${number} ${pr.title}\n  head ${head.slice(0, 7)} — ${finished.length} completed run(s), all green\n`,
);

if (dryRun) {
  process.stdout.write("\nRESULT: PASS — checks only, nothing merged (--dry-run).\n");
  process.exit(0);
}

// 4. Merge the head that was checked, not whatever the head is by now, with the body that was checked.
run("gh", ["pr", "merge", number, "--squash", "--match-head-commit", head, "--subject", subject, "--body-file", bodyOut]);
process.stdout.write(`\nRESULT: PASS — #${number} merged at ${head.slice(0, 7)}.\n`);
