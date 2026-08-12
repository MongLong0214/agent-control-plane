#!/usr/bin/env node
/**
 * Files the independent review's MAJOR findings as GitHub issues.
 *
 * The point is honesty about what is *not* fixed: BLOCKERs were closed with regression
 * tests, MAJORs are recorded as work with the reviewer's own reasoning attached, so the
 * next session can pick them up from the tracker rather than from a transcript.
 *
 * Idempotent: each issue body carries `<!-- acp-review:<area>#<n> -->`, and an existing
 * issue with that marker is updated instead of duplicated.
 *
 * Usage:
 *   node scripts/file-review-majors.mjs           # create/update issues
 *   node scripts/file-review-majors.mjs --dry-run # print what would be filed
 */
import { execFile } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const reviewDir = join(repoRoot, "evidence", "review");
const dryRun = process.argv.includes("--dry-run");
const LABEL = "review-major";

const gh = (args, input) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      "gh",
      args,
      { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`${error.message}\n${stderr}`));
        else resolve(stdout.trim());
      },
    );
    if (input !== undefined) child.stdin.end(input);
  });

const areas = readdirSync(reviewDir)
  .filter((f) => f.endsWith(".json") && !f.endsWith(".schema.json") && f !== "summary.json")
  .map((f) => f.replace(/\.json$/, ""))
  .sort();

const findings = [];
for (const area of areas) {
  const report = JSON.parse(readFileSync(join(reviewDir, `${area}.json`), "utf8"));
  const majors = (report.findings ?? []).filter((f) => f.severity === "MAJOR");
  majors.forEach((finding, index) => {
    findings.push({ area, index: index + 1, ...finding });
  });
}

if (findings.length === 0) {
  console.log("no MAJOR findings to file");
  process.exit(0);
}

const marker = (f) => `<!-- acp-review:${f.area}#${f.index} -->`;
const title = (f) => {
  const head = `[review:${f.area}] ${f.summary}`;
  return head.length > 240 ? `${head.slice(0, 237)}...` : head;
};
const body = (f) =>
  [
    marker(f),
    `Reported by the independent GPT-5.6 Sol production-readiness review as a **MAJOR**`,
    `finding in the \`${f.area}\` area. Not a Hard Invariant violation — those were closed`,
    `with regression tests — but real work that is deliberately not silently deferred.`,
    ``,
    `**Where** \`${f.file}${f.line ? `:${f.line}` : ""}\``,
    `**Category** ${f.category}`,
    ``,
    `## What the reviewer found`,
    ``,
    f.detail,
    ``,
    `## Suggested direction`,
    ``,
    f.suggestedFix || "_none supplied_",
    ``,
    `---`,
    `Evidence: \`evidence/review/${f.area}.json\`.`,
  ].join("\n");

const existing = JSON.parse(
  await gh(["issue", "list", "--state", "all", "--limit", "300", "--json", "number,body,title"]),
);
const byMarker = new Map();
for (const issue of existing) {
  const found = /<!-- acp-review:([^\s]+) -->/.exec(issue.body ?? "");
  if (found) byMarker.set(found[1], issue.number);
}

if (!dryRun) {
  const labels = await gh(["label", "list", "--limit", "100", "--json", "name"]);
  if (!JSON.parse(labels).some((l) => l.name === LABEL)) {
    await gh([
      "label",
      "create",
      LABEL,
      "--color",
      "d4c5f9",
      "--description",
      "MAJOR finding from the independent production-readiness review",
    ]);
  }
}

let created = 0;
let updated = 0;
for (const finding of findings) {
  const key = `${finding.area}#${finding.index}`;
  const number = byMarker.get(key);
  if (dryRun) {
    console.log(`${number ? `update #${number}` : "create"}  ${title(finding)}`);
    continue;
  }
  if (number) {
    await gh(["issue", "edit", String(number), "--title", title(finding), "--body-file", "-"], body(finding));
    updated += 1;
  } else {
    const url = await gh(
      ["issue", "create", "--title", title(finding), "--label", LABEL, "--body-file", "-"],
      body(finding),
    );
    console.log(`created ${url}`);
    created += 1;
  }
}

console.log(
  dryRun
    ? `${findings.length} MAJOR findings across ${areas.length} areas (dry run)`
    : `filed ${created} new and updated ${updated} existing issues from ${findings.length} MAJOR findings`,
);
