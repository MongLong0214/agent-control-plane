#!/usr/bin/env node
/**
 * Reports which hard invariants have enforcement in `src/` that no test names.
 *
 * `docs/CONTRIBUTING.md` requires a mutation proof per enforcement, and one test per layer where
 * a property has more than one mechanism. Nothing checked whether an invariant had *any* test
 * bound to it at all, and the first measurement found the answer that explains this week:
 *
 *   CP-HI-08 (No Silent Degradation) — 17 enforcement sites in src/, 0 tests naming it.
 *
 * Both #494 and #498 are CP-HI-08 failures: an enforcement that can be removed with the suite
 * staying green. The invariant most concerned with things failing quietly was the one with no
 * test that mentions it, which is as close to a self-demonstrating defect as this gets.
 *
 * ## What this can and cannot see
 *
 * It matches invariant identifiers in comments. A test naming `CP-HI-04` is **not** proof that
 * the invariant is enforced — only that someone tied a test to it by name. The real proof is the
 * mutation table in CONTRIBUTING.md, which no static check can produce.
 *
 * So this deliberately measures the weaker property, and says so. A zero here is conclusive in
 * one direction only: an invariant no test names cannot have a test that fails when it breaks.
 * That is worth catching on its own, and it is checkable today.
 *
 * **It also under-reports, and that was measured.** CP-HI-02 showed 1 test here while four of its
 * six triggers were genuinely mutation-proved — the tests assert the trigger's *sentinel*
 * (`SESSION_INCARNATION_IMMUTABLE`) rather than the invariant's name. So a low count is a place to
 * look, not a verdict, and the sweep that follows it has to be a mutation. Two of those six were
 * in fact uncovered, which is why the number was worth chasing even though it was wrong.
 *
 * ## Ratchet, not audit
 *
 * Bringing every site under a named test is not a v1 prerequisite; it is an unbounded condition,
 * and an unbounded condition is a stall rather than a gate (the same reasoning that reshaped
 * `verify-evidence-freshness.mjs` from 52/52 into something that discriminates).
 *
 * What is enforced is that the recorded state does not get worse: an invariant may not gain
 * enforcement sites while having no test that names it. Reducing a baseline number is progress
 * and is accepted silently; exceeding one fails.
 *
 * Dependency-free, matching the other verify scripts.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * Enforcement-site counts recorded when this check was introduced. An invariant with no test
 * naming it may not grow past its baseline; the goal is that these numbers only fall.
 */
const BASELINE = {
  "CP-HI-01": 10,
  "CP-HI-02": 7,
  "CP-HI-03": 10,
  "CP-HI-04": 34,
  "CP-HI-05": 10,
  "CP-HI-06": 16,
  "CP-HI-07": 7,
  "CP-HI-08": 20,
};

const INVARIANT = /CP-HI-0[1-8]/g;
const SOURCE_EXTENSIONS = new Set([".ts", ".sql", ".mjs", ".py", ".sh"]);

const walk = (dir, out = []) => {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (SOURCE_EXTENSIONS.has(entry.slice(entry.lastIndexOf(".")))) out.push(full);
  }
  return out;
};

const countIn = (roots) => {
  const counts = {};
  for (const root of roots) {
    for (const file of walk(join(repoRoot, root))) {
      const text = readFileSync(file, "utf8");
      for (const match of text.match(INVARIANT) ?? []) {
        counts[match] ??= { total: 0, files: new Set() };
        counts[match].total += 1;
        counts[match].files.add(relative(repoRoot, file));
      }
    }
  }
  return counts;
};

const enforcement = countIn(["src", "deploy"]);
const named = countIn(["tests"]);

const rows = Object.keys(BASELINE).map((id) => ({
  id,
  sites: enforcement[id]?.total ?? 0,
  files: enforcement[id]?.files.size ?? 0,
  tests: named[id]?.total ?? 0,
  baseline: BASELINE[id],
}));

const width = Math.max(...rows.map((r) => r.id.length));
console.log("invariant".padEnd(width) + "  sites  files  tests  baseline");
for (const row of rows) {
  const flag = row.tests === 0 ? "  <- no test names this invariant" : "";
  console.log(
    `${row.id.padEnd(width)}  ${String(row.sites).padStart(5)}  ${String(row.files).padStart(5)}` +
      `  ${String(row.tests).padStart(5)}  ${String(row.baseline).padStart(8)}${flag}`,
  );
}

const untested = rows.filter((r) => r.tests === 0);
const grown = rows.filter((r) => r.sites > r.baseline);

console.log(
  `\nverify-invariant-coverage: ${rows.length} invariants, ` +
    `${untested.length} with no test naming them`,
);
console.log(
  "A test naming an invariant is not proof it is enforced — the proof is the mutation table in " +
    "docs/CONTRIBUTING.md. A zero here is conclusive only in one direction.",
);

if (untested.length > 0) {
  for (const row of untested) {
    console.log(
      `  ${row.id}: ${row.sites} enforcement site(s) across ${row.files} file(s), no test names it`,
    );
  }
}

// The ratchet. Growing an untested invariant is the one thing this can catch on a change
// someone just made, so it is the one thing that fails.
const regressed = grown.filter((r) => r.tests === 0);
if (regressed.length > 0) {
  console.error("\nverify-invariant-coverage: enforcement grew for an invariant with no test:");
  for (const row of regressed) {
    console.error(`  ${row.id}: ${row.sites} sites, baseline ${row.baseline}`);
  }
  console.error(
    "Add a test that names the invariant and fails when its enforcement is removed, or " +
      "update the baseline deliberately.",
  );
  process.exit(1);
}

if (grown.length > 0) {
  console.log(
    `\nnote: ${grown.map((r) => r.id).join(", ")} grew past baseline but have named tests; ` +
      "update BASELINE when convenient.",
  );
}

process.exit(0);
