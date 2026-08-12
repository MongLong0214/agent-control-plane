#!/usr/bin/env node
/**
 * Files the independent review's findings as GitHub issues.
 *
 * The point is honesty about what is *not* fixed. Every finding the reviewer reported
 * becomes one issue carrying the reviewer's own reasoning, labelled by severity and area,
 * so the next session works from the tracker rather than from a transcript.
 *
 * Idempotent: each issue body carries `<!-- acp-review:<round>:<area>#<n> -->`, and an
 * existing issue with that marker is updated instead of duplicated.
 *
 * Usage:
 *   node scripts/file-review-majors.mjs                     # BLOCKER and MAJOR
 *   node scripts/file-review-majors.mjs --severity=MAJOR    # one severity
 *   node scripts/file-review-majors.mjs --dry-run
 */
import { execFile } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const reviewDir = join(repoRoot, "evidence", "review");
const dryRun = process.argv.includes("--dry-run");
const severityArg = process.argv.find((a) => a.startsWith("--severity="));
const severities = severityArg
  ? severityArg.slice("--severity=".length).split(",")
  : ["BLOCKER", "MAJOR"];
/** Review round, so a later round's findings never collide with an earlier one's markers. */
const ROUND = process.argv.find((a) => a.startsWith("--round="))?.slice("--round=".length) ?? "r2";

const LABELS = {
  BLOCKER: { name: "review-blocker", color: "b60205", description: "BLOCKER from the independent production-readiness review" },
  MAJOR: { name: "review-major", color: "d4c5f9", description: "MAJOR from the independent production-readiness review" },
  MINOR: { name: "review-minor", color: "fef2c0", description: "MINOR from the independent production-readiness review" },
  INFO: { name: "review-info", color: "c5def5", description: "INFO from the independent production-readiness review" },
};

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
  // Index within severity, so a marker stays stable even if unrelated findings change.
  const counters = {};
  for (const finding of report.findings ?? []) {
    counters[finding.severity] = (counters[finding.severity] ?? 0) + 1;
    if (!severities.includes(finding.severity)) continue;
    findings.push({ area, index: counters[finding.severity], ...finding });
  }
}

if (findings.length === 0) {
  console.log("no findings to file");
  process.exit(0);
}

const marker = (f) => `<!-- acp-review:${ROUND}:${f.area}#${f.severity}${f.index} -->`;
const title = (f) => {
  const head = `[${f.severity.toLowerCase()}:${f.area}] ${f.summary}`;
  return head.length > 240 ? `${head.slice(0, 237)}...` : head;
};
const body = (f) =>
  [
    marker(f),
    `Reported by the independent GPT-5.6 Sol production-readiness review (round \`${ROUND}\`,`,
    `read-only sandbox, reasoning effort \`xhigh\`) as a **${f.severity}** finding in the`,
    `\`${f.area}\` area. Filed verbatim so the reasoning survives a session reset; it has not`,
    `been re-verified by the implementer unless a comment on this issue says so.`,
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
  const existingLabels = new Set(
    JSON.parse(await gh(["label", "list", "--limit", "200", "--json", "name"])).map((l) => l.name),
  );
  for (const severity of severities) {
    const label = LABELS[severity];
    if (label && !existingLabels.has(label.name)) {
      await gh(["label", "create", label.name, "--color", label.color, "--description", label.description]);
      existingLabels.add(label.name);
    }
  }
  for (const area of areas) {
    const name = `area:${area}`;
    if (!existingLabels.has(name)) {
      await gh(["label", "create", name, "--color", "ededed", "--description", `Review area: ${area}`]);
      existingLabels.add(name);
    }
  }
}

let created = 0;
let updated = 0;
for (const finding of findings) {
  const key = `${ROUND}:${finding.area}#${finding.severity}${finding.index}`;
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
      [
        "issue",
        "create",
        "--title",
        title(finding),
        "--label",
        LABELS[finding.severity].name,
        "--label",
        `area:${finding.area}`,
        "--body-file",
        "-",
      ],
      body(finding),
    );
    console.log(`created ${url}`);
    created += 1;
  }
}

console.log(
  dryRun
    ? `${findings.length} findings across ${areas.length} areas (dry run)`
    : `filed ${created} new and updated ${updated} existing issues from ${findings.length} findings`,
);
