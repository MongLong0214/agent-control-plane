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
 *   4. no issue carries a marker that no longer corresponds to a finding
 *
 * Usage: node scripts/ssot-report.mjs [--json]
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const asJson = process.argv.includes("--json");

const listIssues = () => {
  try {
    return execFileSync(
      "gh",
      ["issue", "list", "--state", "all", "--limit", "600", "--json", "number,state,body,labels,title"],
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
      "SSOT reconciliation cannot run: GitHub issues could not be listed. Set GH_TOKEN (in GitHub Actions, use GH_TOKEN: ${{ github.token }}) or authenticate gh locally.",
    );
    if (stderr) console.error(stderr);
    process.exit(1);
  }
};

const issues = JSON.parse(listIssues());

const reviewMarkers = new Map();
const workMarkers = new Map();
for (const issue of issues) {
  const review = /<!-- acp-review:([^\s]+) -->/.exec(issue.body ?? "");
  if (review) reviewMarkers.set(review[1], issue);
  const work = /<!-- acp-work:([^\s]+) -->/.exec(issue.body ?? "");
  if (work) workMarkers.set(work[1], issue);
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

// Every review round the repository holds evidence for. A round whose directory does not
// exist yet contributes nothing, so a new round is one line here and needs no other change.
const ROUNDS = [
  ["r1", join("evidence", "review-round1")],
  ["r2", join("evidence", "review")],
  ["r3", join("evidence", "review-round3")],
];

const rounds = ROUNDS.flatMap(([round, dir]) => findingsOf(dir, round));

const problems = [];
const tally = {};
for (const finding of rounds) {
  const key = `${finding.round}/${finding.severity}`;
  tally[key] = tally[key] ?? { total: 0, open: 0, closed: 0, missing: 0 };
  tally[key].total += 1;
  const issue = reviewMarkers.get(finding.marker);
  if (!issue) {
    tally[key].missing += 1;
    problems.push(`no issue for ${finding.marker} — ${finding.summary}`);
    continue;
  }
  if (issue.state === "OPEN") tally[key].open += 1;
  else tally[key].closed += 1;
}

const workRows = declaredWorkIds.map((id) => {
  const issue = workMarkers.get(id);
  if (!issue) problems.push(`no issue for declared work item ${id}`);
  return { id, number: issue?.number ?? null, state: issue?.state ?? "MISSING" };
});

const knownMarkers = new Set(rounds.map((f) => f.marker));
for (const marker of reviewMarkers.keys()) {
  if (!knownMarkers.has(marker)) {
    problems.push(`issue #${reviewMarkers.get(marker).number} carries unknown marker ${marker}`);
  }
}

const openReview = [...reviewMarkers.values()].filter((i) => i.state === "OPEN").length;
const openWork = workRows.filter((w) => w.state === "OPEN").length;

if (asJson) {
  console.log(JSON.stringify({ tally, workRows, openReview, openWork, problems }, null, 2));
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
  if (problems.length === 0) console.log("\nSSOT reconciled: every finding and work item has an issue.");
}

if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
