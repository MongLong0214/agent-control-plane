#!/usr/bin/env node
/**
 * Run the mutation sweep over the rows this change can break, or over all of them.
 *
 * #885, unit 3. A pull request spends 7,423 macOS slot-seconds and 6,100 of them re-run all 641
 * rows; queue time is slot-seconds divided by slots, so running fewer rows per pull request is the
 * only lever on that 82%. It is also a reduction in what a pull request proves, which is why every
 * part of the decision is somewhere else and checkable:
 *
 * ```
 * the relation        scripts/lib/affected-closure.mjs          declared, with its own rows
 * the proof           scripts/verify-affected-closure-misses-nothing.mjs
 *                     two traversals over 641 rows and twelve real changed-file sets
 * the row table       the harness's own --print-rows
 * the full sweep      unchanged, and `main` still runs it
 * ```
 *
 * This file only composes them. It computes nothing about which rows matter.
 *
 * **It falls back to the whole table on anything it cannot answer**, and says which: a changed
 * file whose import edges could not be resolved, a change to the harness, the selector, the case
 * directory or CI, or a git range it cannot read. A selective sweep resting on an answer nobody
 * has is the "coverage implied, not observed" shape the whole area is about.
 *
 * `main`'s full sweep is additional defence and never a substitute for what a pull request missed
 * — the CEO's wording, and the reason the fallback is wide rather than clever.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { affectedClosure } from "./lib/affected-closure.mjs";
import { buildImportGraph, moduleFilesUnder } from "./lib/module-import-graph.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const HARNESS = join(ROOT, "scripts/verify-guards-are-falsifiable.mjs");

const passThrough = process.argv.slice(2).filter((one) => !one.startsWith("--base="));
const baseArgument = process.argv.slice(2).find((one) => one.startsWith("--base="));
if (baseArgument === undefined) {
  process.stderr.write(
    "run-affected-falsifiability: --base=<ref> is required — it is what \"changed\" is measured against.\n",
  );
  process.exit(2);
}
const BASE = baseArgument.slice("--base=".length);

const out = (line) => process.stdout.write(`${line}\n`);
const sweep = (extra) => {
  execFileSync(process.execPath, [HARNESS, ...extra, ...passThrough], { cwd: ROOT, stdio: "inherit" });
};

/** Everything below falls back to the full sweep rather than guessing. */
const fullSweep = (reason) => {
  out(`run-affected-falsifiability: sweeping every row — ${reason}`);
  sweep([]);
  process.exit(0);
};

let changed;
try {
  changed = execFileSync("git", ["diff", "--name-only", `${BASE}...HEAD`], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 60_000,
  })
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
} catch (error) {
  fullSweep(`the range ${BASE}...HEAD could not be read (${(error && error.message) || error})`);
}

if (changed.length === 0) fullSweep(`${BASE}...HEAD changed no file, which is not a change this can narrow`);

const printed = JSON.parse(
  execFileSync(process.execPath, [HARNESS, "--print-rows"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
  }),
);
const rows = printed.rows.map((row) => ({ id: row.partitionKey, file: row.file, killedBy: row.killedBy }));

const files = moduleFilesUnder(ROOT, ["src", "tests", "scripts"]);
const { imports, undecidable } = buildImportGraph(ROOT, files);
const verdict = affectedClosure({ rows, changedFiles: changed, imports, undecidable });

if (verdict.kind === "FULL") fullSweep(verdict.reason);

const keysFile = join(mkdtempSync(join(tmpdir(), "acp-affected-")), "keys.txt");
writeFileSync(keysFile, `${verdict.selected.map((one) => one.row.id).join("\n")}\n`);
out(
  `run-affected-falsifiability: ${changed.length} changed file(s) select ${verdict.selected.length} of ` +
    `${rows.length} row(s); the rest are unaffected by this change and are swept on main.`,
);
// Named rather than counted: which rows a pull request stopped checking is the thing a reader has
// to be able to disagree with, and a number cannot be disagreed with.
for (const one of verdict.selected.slice(0, 25)) out(`  ${one.row.file}  ${one.because.join("; ")}`);
if (verdict.selected.length > 25) out(`  ... and ${verdict.selected.length - 25} more`);

if (verdict.selected.length === 0) {
  out("run-affected-falsifiability: nothing selected, so the sweep runs no row and says so.");
  process.exit(0);
}
sweep([`--select-keys=${keysFile}`]);
