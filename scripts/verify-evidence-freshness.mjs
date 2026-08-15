#!/usr/bin/env node
/**
 * Reports whether each committed file under `evidence/` still describes the current source.
 *
 * CP-HI-06 does this inside a run: evidence binds a candidate snapshot digest, and changed
 * source stales it. That property stops at the run boundary, and nothing said whether a
 * committed file describes the tree in front of the reader (#448 item 3).
 *
 * ## Why this was rewritten
 *
 * The first version watched `src`, `deploy` and `scripts` and called a file STALE when any
 * commit touched any of them after the file was written. Measured against the repository, that
 * reported **52 of 52 files stale**. A check that fires on everything discriminates nothing, and
 * a check that discriminates nothing gets switched off — and a switched-off check reads as green.
 * The same failure had already happened here with a name-based static check that produced 65
 * false alarms and was disabled.
 *
 * ## The distinction that makes it discriminate
 *
 * `docs/TERMINOLOGY.md` already draws the line this needed:
 *
 *   > `evidence` is a content-addressed `run_artifacts` row that goes stale automatically
 *   > (CP-HI-06); a hand-written file is a `report`.
 *
 * So the directory holds two different kinds of thing and only one of them can go stale:
 *
 *   EVIDENCE  carries a source digest, so what it was measured against is *recorded*.
 *             Staleness is decidable, and this is CP-HI-06 generalised outside the run.
 *   REPORT    carries no digest. It records what someone found at a time. It does not
 *             describe a tree, so calling it STALE is a category error — which is exactly
 *             what produced 47 of the 52 alarms.
 *
 * A report is dated, not failed. Evidence is checked.
 *
 * ## The ratchet
 *
 * Existing reports are listed as a baseline rather than fixed in bulk. What is enforced is that
 * the baseline does not grow: a *new* file under `evidence/` must either carry a digest or be
 * added to the list deliberately. That keeps the check honest about the 47 without pretending
 * they are a build break, and stops the 48th appearing by accident.
 *
 * Dependency-free, matching the other verify scripts.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const strict = process.argv.includes("--strict");

/** Keys that record the source a file was measured against, at any nesting depth. */
const DIGEST_KEYS = ["candidatesnapshotdigest", "snapshotdigest", "headsha", "commitsha"];

/**
 * Files that are reports rather than evidence, recorded so the count cannot grow silently.
 * Shrinking this list is progress; growing it is a decision someone has to make on purpose.
 */
const KNOWN_REPORTS = new Set([
  "evidence/p0-09-buzz-live-delivery.json",
  "evidence/review-grok/binding.json",
  "evidence/review-grok/github.json",
  "evidence/review-grok/guard.json",
  "evidence/review-grok/review.json",
  "evidence/review-grok/runtime.json",
  "evidence/review-grok/summary.json",
  "evidence/review-grok/verify.json",
  "evidence/review-round1/binding.json",
  "evidence/review-round1/binding.schema.json",
  "evidence/review-round1/continuity.json",
  "evidence/review-round1/continuity.schema.json",
  "evidence/review-round1/core.json",
  "evidence/review-round1/core.schema.json",
  "evidence/review-round1/github.json",
  "evidence/review-round1/github.schema.json",
  "evidence/review-round1/guard.json",
  "evidence/review-round1/guard.schema.json",
  "evidence/review-round1/ops.json",
  "evidence/review-round1/ops.schema.json",
  "evidence/review-round1/review.json",
  "evidence/review-round1/review.schema.json",
  "evidence/review-round1/runtime.json",
  "evidence/review-round1/runtime.schema.json",
  "evidence/review-round1/summary.json",
  "evidence/review-round1/verify.json",
  "evidence/review-round1/verify.schema.json",
  "evidence/review/binding.json",
  "evidence/review/binding.schema.json",
  "evidence/review/continuity.json",
  "evidence/review/continuity.schema.json",
  "evidence/review/core.json",
  "evidence/review/core.schema.json",
  "evidence/review/github.json",
  "evidence/review/github.schema.json",
  "evidence/review/guard.json",
  "evidence/review/guard.schema.json",
  "evidence/review/ops.json",
  "evidence/review/ops.schema.json",
  "evidence/review/review.json",
  "evidence/review/review.schema.json",
  "evidence/review/runtime.json",
  "evidence/review/runtime.schema.json",
  "evidence/review/summary.json",
  "evidence/review/verify.json",
  "evidence/review/verify.schema.json",
  "evidence/traceability.json",
]);

const git = (...args) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();

const walk = (dir, out = []) => {
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith(".json")) out.push(full);
  }
  return out;
};

/** Finds a recorded source digest anywhere in the document, or null. */
const sourceDigest = (value, depth = 0) => {
  if (depth > 4 || value === null || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 20)) {
      const found = sourceDigest(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (DIGEST_KEYS.includes(key.toLowerCase()) && typeof nested === "string" && nested) {
      return nested;
    }
    const found = sourceDigest(nested, depth + 1);
    if (found) return found;
  }
  return null;
};

let files = [];
try {
  files = walk(join(repoRoot, "evidence"));
} catch {
  console.log("verify-evidence-freshness: no evidence directory");
  process.exit(0);
}

// Local scratch output, not a claim anyone reads.
const scoped = files.filter((f) => !relative(repoRoot, f).startsWith("evidence/local/"));

const evidence = [];
const reports = [];
const unreadable = [];

for (const file of scoped) {
  const rel = relative(repoRoot, file);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    unreadable.push(rel);
    continue;
  }
  const writtenAt = git("log", "-1", "--format=%H", "--", rel);
  const digest = sourceDigest(parsed);
  if (digest) evidence.push({ rel, digest, writtenAt });
  else reports.push({ rel, writtenAt });
}

// Evidence: a recorded digest means the question is answerable. Source committed after the
// evidence was written is what stales it — the same rule as before, but now applied only to
// files that actually claim to describe a tree.
const WATCHED = ["src", "deploy", "scripts"];
const stale = [];
for (const item of evidence) {
  if (!item.writtenAt) continue;
  const changed = git("log", "--format=%H", `${item.writtenAt}..HEAD`, "--", ...WATCHED)
    .split("\n")
    .filter(Boolean);
  if (changed.length > 0) {
    stale.push({ ...item, changed: changed.length });
  }
}

for (const item of stale) {
  console.log(
    `STALE     ${item.rel}  (${item.changed} source commit(s) since ${item.writtenAt.slice(0, 7)})`,
  );
}
for (const item of evidence.filter((e) => !stale.some((s) => s.rel === e.rel))) {
  console.log(`CURRENT   ${item.rel}  (${(item.writtenAt || "uncommitted").slice(0, 7)})`);
}
for (const item of reports) {
  console.log(
    `REPORT    ${item.rel}  (written ${(item.writtenAt || "uncommitted").slice(0, 7)}; no source digest, so not a claim about a tree)`,
  );
}

console.log(
  `\nverify-evidence-freshness: ${evidence.length} evidence file(s) — ` +
    `${evidence.length - stale.length} current, ${stale.length} stale; ` +
    `${reports.length} report(s) dated`,
);

if (stale.length > 0) {
  console.log(
    "STALE means the evidence describes an earlier tree. Re-derive it; do not edit it to agree.",
  );
}

// The ratchet. A new file that is neither evidence nor a recorded report is the thing to catch:
// it is the 48th report arriving without anyone deciding it should exist.
const undeclared = reports.filter((r) => !KNOWN_REPORTS.has(r.rel));
if (undeclared.length > 0) {
  console.error(
    `\nverify-evidence-freshness: ${undeclared.length} file(s) under evidence/ carry no source ` +
      `digest and are not recorded reports:`,
  );
  for (const item of undeclared) console.error(`  ${item.rel}`);
  console.error(
    "Either record the digest it was measured against, or add it to KNOWN_REPORTS to say " +
      "deliberately that it is a report and not evidence.",
  );
}

if (unreadable.length > 0) {
  for (const rel of unreadable) console.error(`UNREADABLE ${rel}`);
}

// Undeclared files fail regardless of --strict: that is the ratchet, and it is the only part
// of this check that can fire on a change someone just made. STALE remains advisory unless
// --strict, because a repository full of stale evidence is a fact to see rather than a build
// to break.
process.exit(undeclared.length > 0 || unreadable.length > 0 || (strict && stale.length > 0) ? 1 : 0);
