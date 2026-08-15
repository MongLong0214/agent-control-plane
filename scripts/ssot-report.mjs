#!/usr/bin/env node
/**
 * Reconciles the issue tracker against every source of open work, and fails if anything
 * is missing. This is what makes "the tracker is the SSOT" a checkable claim rather than
 * a promise.
 *
 * Checks:
 *   1. every finding in `evidence/review/*.json` (round 2) has an issue
 *   2. every finding in `evidence/review-round1/*.json` (round 1) has an issue
 *   3. every work item declared in `scripts/file-open-work.mjs` has an issue
 *   4. no marker is duplicated or points to a finding/work item that no longer exists
 *   5. an issue whose recorded disposition is FIXED / STALE / NOT APPLICABLE is not still open
 *   6. required public documents and their status sections exist
 *
 * Exit codes distinguish three outcomes, because two of them need opposite responses:
 *
 *   0  reconciled — tracker and repository agree
 *   1  unreconciled — they disagree, and the disagreement is listed
 *   2  undetermined — GitHub could not be reached, so nothing was compared
 *
 * 1 and 2 are both failures to CI and that is correct. The difference is what a reader is told
 * to do: 1 means fix something, 2 means look again. Reporting 2 as 1 sends someone hunting a
 * disagreement that may not exist, which is what an HTTP 504 did to a documentation-only PR
 * (#444).
 *
 * `--issues-file` is a fixture seam for this gate's own regression checks; normal CI and
 * operator use must query GitHub directly.
 *
 * Usage: node scripts/ssot-report.mjs [--json] [--issues-file=<path>] [--repo-root=<path>]
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultRepoRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = resolve(
  process.cwd(),
  process.argv.find((argument) => argument.startsWith("--repo-root="))?.slice("--repo-root=".length) ?? defaultRepoRoot,
);
const asJson = process.argv.includes("--json");
const issuesFile = process.argv
  .find((argument) => argument.startsWith("--issues-file="))
  ?.slice("--issues-file=".length);

const listIssues = () => {
  if (issuesFile) return readFileSync(resolve(repoRoot, issuesFile), "utf8");
  try {
    return execFileSync(
      "gh",
      ["issue", "list", "--state", "all", "--limit", "600", "--json", "number,state,body,labels,title,comments"],
      {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch (error) {
    const stderr =
      error && typeof error === "object" && "stderr" in error ? String(error.stderr ?? "").trim() : "";
    console.error(
      "SSOT reconciliation UNDETERMINED: GitHub issues could not be listed. Set GH_TOKEN (in GitHub Actions, use GH_TOKEN: ${{ github.token }}) or authenticate gh locally.",
    );
    if (stderr) console.error(stderr);
    // Exit 2, not 1. Unreachable is not the same answer as unreconciled: one says the tracker
    // and the repository disagree, the other says nobody could look. Reporting the second as
    // the first sends someone hunting a disagreement that may not exist — which is what
    // happened when an HTTP 504 failed a documentation-only PR (#444).
    //
    // 1 stays "reconciliation ran and found problems". CI treats both as failure, which is
    // correct; the difference is what a reader is told to do about it.
    process.exit(2);
  }
};

const issues = JSON.parse(listIssues());

const reviewMarkers = new Map();
const workMarkers = new Map();
const addMarker = (index, marker, issue) => {
  const rows = index.get(marker) ?? [];
  rows.push(issue);
  index.set(marker, rows);
};
for (const issue of issues) {
  const review = /<!-- acp-review:([^\s]+) -->/.exec(issue.body ?? "");
  if (review) addMarker(reviewMarkers, review[1], issue);
  const work = /<!-- acp-work:([^\s]+) -->/.exec(issue.body ?? "");
  if (work) addMarker(workMarkers, work[1], issue);
}

const findingsOf = (dir, round) => {
  const out = [];
  if (!existsSync(join(repoRoot, dir))) return out;
  const files = readdirSync(join(repoRoot, dir))
    .filter((f) => f.endsWith(".json") && !f.endsWith(".schema.json") && f !== "summary.json")
    .sort();
  for (const file of files) {
    const area = file.replace(/\.json$/, "");
    const report = JSON.parse(readFileSync(join(repoRoot, dir, file), "utf8"));
    const counters = {};
    for (const finding of report.findings ?? []) {
      counters[finding.severity] = (counters[finding.severity] ?? 0) + 1;
      out.push({
        round,
        area,
        severity: finding.severity,
        marker: `${round}:${area}#${finding.severity}${counters[finding.severity]}`,
        summary: finding.summary,
      });
    }
  }
  return out;
};

const declaredWorkIds = [
  ...readFileSync(join(repoRoot, "scripts", "file-open-work.mjs"), "utf8").matchAll(
    /^\s{4}id: "([^"]+)",$/gm,
  ),
].map((m) => m[1]);

// #306 is the tracker index itself, not a work item projected by file-open-work.mjs. Keep its
// marker explicit so a typo there is not silently accepted while preserving the work-item tally.
const STRUCTURAL_WORK_MARKERS = new Set(["ssot-index"]);

// Every review round the repository holds evidence for. A round whose directory does not
// exist yet contributes nothing, so a new round is one line here and needs no other change.
const ROUNDS = [
  ["r1", join("evidence", "review-round1")],
  ["r2", join("evidence", "review")],
  ["r3", join("evidence", "review-round3")],
];

const rounds = ROUNDS.flatMap(([round, dir]) => findingsOf(dir, round));

const problems = [];
const REQUIRED_PUBLIC_DOCUMENTS = [
  "README.md",
  "docs/STATUS.md",
  "docs/OPERATIONS.md",
  "docs/SECURITY.md",
  "docs/CONTRIBUTING.md",
];
const publicDocuments = REQUIRED_PUBLIC_DOCUMENTS.map((path) => ({
  path,
  present: existsSync(join(repoRoot, path)),
}));
for (const document of publicDocuments) {
  if (!document.present) problems.push(`required public document missing: ${document.path}`);
}

const statusSections = [
  {
    label: "README status banner",
    path: "README.md",
    pattern: /^>\s*\*\*Status:\s*not production-ready\.\*\*/m,
  },
  {
    label: "current status heading",
    path: "docs/STATUS.md",
    pattern: /^#\s+Current status\b/im,
  },
].map((check) => {
  const path = join(repoRoot, check.path);
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  return { label: check.label, path: check.path, present: check.pattern.test(text) };
});
for (const section of statusSections) {
  if (!section.present) problems.push(`status section missing: ${section.label} in ${section.path}`);
}

const tally = {};
const issueFor = (index, marker, kind) => {
  const matches = index.get(marker) ?? [];
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    problems.push(`${kind} marker ${marker} is duplicated by ${matches.map((issue) => `#${issue.number}`).join(", ")}`);
    return null;
  }
  return matches[0];
};
for (const finding of rounds) {
  const key = `${finding.round}/${finding.severity}`;
  tally[key] = tally[key] ?? { total: 0, open: 0, closed: 0, missing: 0 };
  tally[key].total += 1;
  const issue = issueFor(reviewMarkers, finding.marker, "review");
  if (!issue) {
    tally[key].missing += 1;
    problems.push(`no issue for ${finding.marker} — ${finding.summary}`);
    continue;
  }
  if (issue.state === "OPEN") tally[key].open += 1;
  else tally[key].closed += 1;
}

const workRows = declaredWorkIds.map((id) => {
  const issue = issueFor(workMarkers, id, "work");
  if (!issue) problems.push(`no issue for declared work item ${id}`);
  return { id, number: issue?.number ?? null, state: issue?.state ?? "MISSING" };
});

const knownMarkers = new Set(rounds.map((f) => f.marker));
for (const marker of reviewMarkers.keys()) {
  if (!knownMarkers.has(marker)) {
    const issueNumbers = reviewMarkers.get(marker).map((issue) => `#${issue.number}`).join(", ");
    problems.push(`${issueNumbers} carries unknown review marker ${marker}`);
  }
}
const knownWorkMarkers = new Set([...declaredWorkIds, ...STRUCTURAL_WORK_MARKERS]);
for (const marker of workMarkers.keys()) {
  if (!knownWorkMarkers.has(marker)) {
    const issueNumbers = workMarkers.get(marker).map((issue) => `#${issue.number}`).join(", ");
    problems.push(`${issueNumbers} carries unknown work marker ${marker}`);
  }
}

/**
 * The "recorded disposition" rule was removed here (#535).
 *
 * It flagged an OPEN issue whose text recorded a FIXED / STALE / NOT APPLICABLE disposition. Two
 * mechanisms fed it: a machine marker, and a fallback that read any line *beginning* with one of
 * those words. Measured across all 534 issues before deleting it:
 *
 *   machine marker `<!-- acp-resolution:… -->`   0 issues
 *   heading fallback                             5 issues, every one a false positive
 *   genuine catches                              0
 *
 * The five were prose discussing the words — "STALE stays advisory unless `--strict`",
 * "## STALE does not fail the build", "Fixed the synthetic chain; the pinned file still failed".
 * That last one was cited during the day as the rule working; it was not. Its own header told it
 * not to read prose as a disposition, and the fallback did that and only that.
 *
 * It stayed quiet only because the rule fires on OPEN issues and all five were closed, which made
 * it a landmine rather than a check: a comment on #533 beginning "Fixed in #534 — …" — prose about
 * a different PR — was recorded as #533's disposition and turned `main` red.
 *
 * Keeping the marker alone was rejected: it has zero users, and a mechanism with no consumer will
 * accept whatever the first person puts in it while carrying the authority of looking machine-read.
 *
 * **If the problem this aimed at is ever actually observed** — an issue recorded as resolved but
 * left open — the answer is a marker something already writes, not inference from prose formatting.
 * The numbers are here so that is a decision rather than a rediscovery.
 */

const detectability = {
  openIssueWithRecordedDisposition: false,
  codeFixedOpenIssueWithoutDisposition: false,
  note: "Issue resolution is not inferred from issue text; closing an issue is the record (#535).",
};

const openReview = [...reviewMarkers.values()].flat().filter((issue) => issue.state === "OPEN").length;
const openWork = workRows.filter((w) => w.state === "OPEN").length;

if (asJson) {
  console.log(
    JSON.stringify(
      {
        tally,
        workRows,
        openReview,
        openWork,
        publicDocuments,
        statusSections,
        detectability,
        problems,
      },
      null,
      2,
    ),
  );
} else {
  console.log("round/severity      total  open  closed  missing");
  for (const [key, row] of Object.entries(tally).sort()) {
    console.log(
      `${key.padEnd(18)} ${String(row.total).padStart(5)} ${String(row.open).padStart(5)} ${String(row.closed).padStart(7)} ${String(row.missing).padStart(8)}`,
    );
  }
  console.log(`\ndeclared work items: ${workRows.length}, open: ${openWork}`);
  for (const row of workRows) console.log(`  #${row.number ?? "??"} ${row.state.padEnd(7)} ${row.id}`);
  console.log(`\nopen review issues: ${openReview}`);
  console.log(
    `public documents: ${publicDocuments.filter((document) => document.present).length}/${publicDocuments.length} present`,
  );
  console.log(
    `status sections: ${statusSections.filter((section) => section.present).length}/${statusSections.length} present`,
  );
  console.log(`detectability: ${detectability.note}`);
  if (problems.length === 0) console.log("\nSSOT reconciled: every tracked finding and declared work item has one current issue.");
}

if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
