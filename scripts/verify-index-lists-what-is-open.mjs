#!/usr/bin/env node
/**
 * The index's "What is actually open" list must not route a reader to a closed issue, and must not
 * omit an open one.
 *
 * ## Why this exists rather than another correction
 *
 * The list has gone stale four times, and #306's own body records each time it happened:
 *
 * ```
 * Measured 2026-09-12  "all 16" — named seven issues that were already closed
 * Measured 2026-09-13  named #674, #777, #859, #784, all closed; fourteen became twelve
 * 2026-09-15           the heading said 11
 * 2026-09-18           six of nine live bullets named closed issues
 * ```
 *
 * The body also says why the correction keeps not sticking: *"the correction keeps not sticking
 * because the list is a copy"*. A copy with no reconciler drifts on the tracker's schedule, not on
 * anyone's attention, and an index that routes a reader to a closed issue is worse than one that
 * omits it — the reader opens it, sees green, and concludes the area is finished.
 *
 * So this is the reconciler. It does not maintain the list; it refuses a list that has stopped
 * being true, which is the only part a machine can do honestly.
 *
 * ## What it reads, and why that subject and not a wider one
 *
 * Only bullets of the exact shape the section already uses:
 *
 * ```
 * - **#627** — retire the legacy CEO fork...          live
 * - ~~**#674**~~ — **closed 2026-09-13.** ...          struck through
 * ```
 *
 * A first draft took every `#N` in the section and failed on the section's own history — the
 * `> Measured …` notes cite closed issues deliberately, as the record of a previous drift. Those
 * citations are the document working correctly, and a check that calls them defects would teach
 * the maintainer to delete the history. The bullet form is the list; everything else in the section
 * is prose about the list.
 *
 * Strikethrough is the section's existing marker for "named here, but finished", so it is the
 * escape: a closed issue may stay in the list struck through, which is how a reader learns the area
 * is done rather than wondering why it vanished.
 *
 * ## Three rules, and each one is a failure the tracker has actually produced
 *
 * 1. A live bullet must name an open issue. (Four occurrences.)
 * 2. The heading's count must equal the number of live bullets. (Observed at 11 against 9.)
 * 3. An open issue must appear in the section, live. (#954 was absent while the deployment waited
 *    on it.) The index issue itself is exempt: a map does not route to itself.
 *
 * ## Exit codes, matching this repository's other tracker checks
 *
 * 0 the list reconciles · 1 it does not · 2 nobody could look. `verify-tracker-loci-resolve.mjs`
 * draws the same distinction for the same reason: "nobody could look" must not read as "the list
 * disagrees with the tracker", and conflating them sends a reader hunting a disagreement that may
 * not exist.
 *
 * `--issues-file` is the fixture seam this check's own tests use. Normal CI and operator use query
 * GitHub.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { reconcile } from "./lib/index-open-list.mjs";

const issuesFrom = (repoRoot, issuesFile) => {
  if (issuesFile) return JSON.parse(readFileSync(resolve(repoRoot, issuesFile), "utf8"));
  // `--paginate --slurp` follows every Link page; the REST `/issues` endpoint includes pull
  // requests, which `gh issue list` does not, so they are discarded here.
  const pages = JSON.parse(
    execFileSync(
      "gh",
      ["api", "--paginate", "--slurp", "repos/{owner}/{repo}/issues?state=open&per_page=100"],
      { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
    ),
  );
  if (!Array.isArray(pages) || !pages.every(Array.isArray)) {
    throw new Error("GitHub pagination did not return an array of issue pages");
  }
  return pages.flat().filter((issue) => !issue.pull_request);
};

const main = () => {
  const repoRoot = resolve(new URL("..", import.meta.url).pathname);
  const issuesFile = process.argv
    .find((arg) => arg.startsWith("--issues-file="))
    ?.slice("--issues-file=".length);

  let issues;
  try {
    issues = issuesFrom(repoRoot, issuesFile);
  } catch (error) {
    console.error(
      "verify-index-lists-what-is-open UNDETERMINED: the open issues could not be listed. Set " +
        "GH_TOKEN (in GitHub Actions, use GH_TOKEN: ${{ github.token }}) or authenticate gh locally.",
    );
    const stderr = error && typeof error === "object" && "stderr" in error ? String(error.stderr ?? "").trim() : "";
    if (stderr) console.error(stderr);
    return 2;
  }

  const findings = reconcile(issues);
  if (findings.length === 0) {
    console.log(
      `index reconciles: every live bullet names an open issue, the heading's count matches, and all ` +
        `${issues.length - 1} other open issue(s) are listed.`,
    );
    return 0;
  }

  console.log(`INDEX LIST (${findings.length}):`);
  for (const finding of findings) console.log(`  ${finding.rule}  ${finding.detail}`);
  console.log(
    "\nThe list is a copy of the tracker, so it drifts on the tracker's schedule rather than on " +
      "anyone's attention. Strike a finished issue through rather than deleting it, so a reader " +
      "learns the area is done instead of wondering why it vanished.",
  );
  return 1;
};

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "")) {
  process.exit(main());
}
