#!/usr/bin/env node
/**
 * Files round 1's BLOCKER findings and closes each one against the commit that fixed it.
 *
 * They are already fixed with regression tests, so they are not open work — but leaving
 * them out of the tracker would mean the tracker is not the whole record. A closed issue
 * with the reviewer's reasoning and the fixing commit is how "this was addressed, here is
 * the proof" survives a session reset.
 *
 * Usage: node scripts/file-round1-blockers.mjs [--dry-run]
 */
import { execFile } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const reviewDir = join(repoRoot, "evidence", "review-round1");
const dryRun = process.argv.includes("--dry-run");

/** The commit that closed each area's round-1 BLOCKERs, and where its regressions live. */
const FIXES = {
  guard: {
    commits: ["d068a17", "453d8b8", "50ad2ae"],
    tests: ["tests/unit/guard-hardening.test.ts", "tests/scenarios/github-hardening.test.ts"],
  },
  core: { commits: ["26c1347"], tests: ["tests/unit/core-hardening.test.ts", "tests/unit/trusted-core.test.ts"] },
  verify: { commits: ["5be2eb9"], tests: ["tests/integration/pipeline.test.ts", "tests/unit/trusted-core.test.ts"] },
  review: { commits: ["5be2eb9", "de86ac0"], tests: ["tests/integration/pipeline.test.ts"] },
  binding: { commits: ["de86ac0"], tests: ["tests/unit/binding-hardening.test.ts"] },
  continuity: { commits: ["ca05ed9"], tests: ["tests/unit/continuity-hardening.test.ts"] },
  github: { commits: ["c79a0be", "bddac71"], tests: ["tests/scenarios/github-hardening.test.ts"] },
  runtime: { commits: ["f9f772a", "bddac71"], tests: ["tests/unit/runtime-hardening.test.ts"] },
  ops: { commits: ["953a0b8"], tests: ["tests/unit/ops-hardening.test.ts", "tests/scenarios/doctor-ingress-bootstrap-daemon.test.ts"] },
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

const findings = [];
for (const file of readdirSync(reviewDir)
  .filter((f) => f.endsWith(".json") && !f.endsWith(".schema.json") && f !== "summary.json")
  .sort()) {
  const area = file.replace(/\.json$/, "");
  const report = JSON.parse(readFileSync(join(reviewDir, file), "utf8"));
  let index = 0;
  for (const finding of report.findings ?? []) {
    if (finding.severity !== "BLOCKER") continue;
    index += 1;
    findings.push({ area, index, ...finding });
  }
}

const marker = (f) => `<!-- acp-review:r1:${f.area}#BLOCKER${f.index} -->`;
const title = (f) => {
  const head = `[blocker:${f.area}] ${f.summary}`;
  return head.length > 240 ? `${head.slice(0, 237)}...` : head;
};
const body = (f) => {
  const fix = FIXES[f.area];
  return [
    marker(f),
    `> **Fixed.** Closed by ${fix.commits.map((c) => `\`${c}\``).join(", ")} with regressions in`,
    `> ${fix.tests.map((t) => `\`${t}\``).join(", ")}. Filed for the record so the tracker holds the`,
    `> whole review history, not only what is still open.`,
    ``,
    `Reported by the independent GPT-5.6 Sol production-readiness review (round \`r1\`,`,
    `read-only sandbox, reasoning effort \`xhigh\`) as a **BLOCKER** in the \`${f.area}\` area.`,
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
    `Evidence: \`evidence/review-round1/${f.area}.json\`.`,
  ].join("\n");
};

const existing = JSON.parse(
  await gh(["issue", "list", "--state", "all", "--limit", "600", "--json", "number,body"]),
);
const byMarker = new Map();
for (const issue of existing) {
  const found = /<!-- acp-review:([^\s]+) -->/.exec(issue.body ?? "");
  if (found) byMarker.set(found[1], issue.number);
}

if (!dryRun) {
  const have = new Set(
    JSON.parse(await gh(["label", "list", "--limit", "200", "--json", "name"])).map((l) => l.name),
  );
  for (const [name, color, description] of [
    ["review-blocker", "b60205", "BLOCKER from the independent production-readiness review"],
    ["round:r1", "fbca04", "Finding from review round 1 (pre-hardening code)"],
  ]) {
    if (!have.has(name)) await gh(["label", "create", name, "--color", color, "--description", description]);
  }
}

let created = 0;
for (const finding of findings) {
  const key = `r1:${finding.area}#BLOCKER${finding.index}`;
  if (byMarker.has(key)) {
    if (dryRun) console.log(`exists #${byMarker.get(key)}  ${title(finding)}`);
    continue;
  }
  if (dryRun) {
    console.log(`create+close  ${title(finding)}`);
    continue;
  }
  const url = await gh(
    [
      "issue",
      "create",
      "--title",
      title(finding),
      "--label",
      "review-blocker",
      "--label",
      `area:${finding.area}`,
      "--label",
      "round:r1",
      "--body-file",
      "-",
    ],
    body(finding),
  );
  const number = url.split("/").pop();
  await gh([
    "issue",
    "close",
    number,
    "--comment",
    `Fixed before the round-2 review: ${FIXES[finding.area].commits.map((c) => c).join(", ")}. Regressions in ${FIXES[finding.area].tests.join(", ")}.`,
  ]);
  created += 1;
  console.log(`created+closed ${url}`);
}

console.log(dryRun ? `${findings.length} round-1 BLOCKERs (dry run)` : `created and closed ${created}`);
