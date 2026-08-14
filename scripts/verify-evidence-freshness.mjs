#!/usr/bin/env node
/**
 * Reports whether each committed evidence file still describes the current source.
 *
 * CP-HI-06 already does this inside a run: evidence binds a candidate snapshot digest, and
 * changed source stales it. That property stops at the run boundary. Files under `evidence/`
 * are read by people making merge and release decisions, and nothing has ever said whether
 * they describe the tree in front of the reader — `evidence/review/*.json` sat at 08-12 20:30
 * while egress hardening landed after it, with no marker (#448).
 *
 * The generation of an evidence file is taken from git rather than from a field it declares.
 * A declared field can be copied forward by hand; `git log -1 -- <file>` cannot. It also means
 * existing evidence gets a real answer today instead of a fabricated SHA, which is the wrong
 * way to fix missing provenance.
 *
 * Three outcomes, and keeping them separate is the point (#448):
 *
 *   CURRENT     no watched source changed after the evidence was last written
 *   STALE       source changed after it — the evidence describes an earlier tree
 *   UNDECLARED  never committed, so git knows nothing; not a failure and not a pass
 *
 * STALE is not a failure. It means re-derive, not repair. The exit code stays 0 unless
 * --strict is passed, because a repository full of stale evidence is a fact to see rather
 * than a build to break — and because a check that fails on a true statement gets disabled.
 *
 * Dependency-free, matching the other verify scripts.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const strict = process.argv.includes("--strict");

/** Source whose change invalidates a claim about behaviour. Deliberately broad. */
const WATCHED = ["src", "deploy", "scripts"];

const git = (...args) =>
  execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();

const walk = (dir, out = []) => {
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith(".json")) out.push(full);
  }
  return out;
};

let evidenceFiles = [];
try {
  evidenceFiles = walk(join(repoRoot, "evidence"));
} catch {
  console.log("verify-evidence-freshness: no evidence directory");
  process.exit(0);
}

// Local scratch output, not a claim anyone reads.
const scoped = evidenceFiles.filter((f) => !relative(repoRoot, f).startsWith("evidence/local/"));

const rows = [];
for (const file of scoped) {
  const rel = relative(repoRoot, file);
  const writtenAt = git("log", "-1", "--format=%H", "--", rel);
  if (!writtenAt) {
    rows.push({ rel, state: "UNDECLARED", detail: "never committed" });
    continue;
  }
  // Watched source committed after this evidence was last written.
  const changed = git("log", "--format=%H", `${writtenAt}..HEAD`, "--", ...WATCHED)
    .split("\n")
    .filter(Boolean);
  rows.push(
    changed.length === 0
      ? { rel, state: "CURRENT", detail: writtenAt.slice(0, 7) }
      : {
          rel,
          state: "STALE",
          detail: `${changed.length} source commit(s) since ${writtenAt.slice(0, 7)}`,
        },
  );
}

const byState = (state) => rows.filter((r) => r.state === state);
for (const state of ["STALE", "UNDECLARED", "CURRENT"]) {
  for (const row of byState(state)) console.log(`${state.padEnd(10)} ${row.rel}  (${row.detail})`);
}

const stale = byState("STALE").length;
const undeclared = byState("UNDECLARED").length;
console.log(
  `\nverify-evidence-freshness: ${rows.length} files — ` +
    `${byState("CURRENT").length} current, ${stale} stale, ${undeclared} undeclared`,
);

if (stale > 0) {
  console.log(
    "STALE means the evidence describes an earlier tree. Re-derive it; do not edit it to agree.",
  );
}

// Only --strict fails, and only on STALE. UNDECLARED is an unknown, and failing on an unknown
// is the fold this check exists to prevent.
process.exit(strict && stale > 0 ? 1 : 0);
