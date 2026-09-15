#!/usr/bin/env node
/**
 * The affected closure misses no row, measured two independent ways that must agree.
 *
 * #885, unit 2 of the order the CEO set: *prove against a full baseline that no affected row is
 * missed, and only then introduce the limited selection.* Nothing here narrows any sweep — the
 * full 632-row sweep still runs on every pull request and on `main`. This decides whether a later
 * unit is allowed to.
 *
 * **Why two computations rather than one.** Asking the closure "which rows are affected?" and then
 * asking it "which are unaffected?" is one function answering twice; the partition would be total
 * by construction and prove nothing. So the second answer is computed from the other direction:
 *
 * ```
 * forward   per row      does the row, its definition, or its witness reach a changed file?
 * reverse   per change   walk the import graph's reverse edges from each changed file and
 *                        collect every row whose file or witness is reachable
 * ```
 *
 * Two traversals of the same graph, written independently, over real changed-file sets taken from
 * merge commits rather than invented. They must produce the same set, and their union must be the
 * whole table. A bug in either shows up as a disagreement rather than as a quiet omission — which
 * is the only failure mode that matters here, because a missed row is a guard nothing checked while
 * a green sweep said the selection was complete.
 *
 * **In the gate set as of 2026-09-16, because it passes.** The paragraph here used to say it exits
 * 1 and should, which stopped being true without anyone noticing -- a comment asserting a
 * falsehood about its own file is the class this repository keeps paying for. Measured:
 *
 *     $ node scripts/verify-affected-closure-misses-nothing.mjs ; echo $?
 *     RESULT: PASS ... 0            2 seconds
 *
 * The old default of 12 commits was measuring almost nothing, and that is why passing went
 * unnoticed. A change to `ci.yml`, `package.json` or `verify-guards-are-falsifiable.mjs` forces
 * FULL, which skips the reverse computation entirely, and a week of infrastructure work fills the
 * window with exactly those:
 *
 *     12 sets   7 FULL   5 SELECTED, 3 of them selecting 0 rows   -> 2 real comparisons, identical
 *     60 sets  21 FULL  39 SELECTED, 7 of them selecting 0 rows   -> 32 real comparisons,
 *                                                                    spanning 6..547 of 665 rows
 *
 * So the default is 60. Two identical answers is not evidence that a selection misses no row; the
 * number here is what decides whether this file measures anything at all, and it is the first thing
 * to re-measure if the verdict ever looks too easy.
 *
 * Still wiring nothing. The full sweep runs on every pull request and on `main`, unchanged. What a
 * standing green here establishes is only that the closure and reverse reachability agree -- and
 * the CEO's refusal of the changed-file-only proposal stands on its own ground, that deferring
 * cross-file regression to `main`'s sweep is a quality reduction. This check does not answer that.
 *
 * Limit: this proves the *selection* agrees with reachability. It does not prove reachability is
 * the right relation — a row can stop being killed for a reason no import edge expresses, and
 * `main`'s full sweep is the defence for that, never a substitute for what a pull request missed.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { affectedClosure } from "./lib/affected-closure.mjs";
import { CASES_DIR, loadFalsifiabilityCases } from "./lib/falsifiability-cases.mjs";
import { buildImportGraph, moduleFilesUnder } from "./lib/module-import-graph.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const unknown = process.argv.slice(2).filter((argument) => !argument.startsWith("--commits="));
if (unknown.length > 0) {
  process.stderr.write(
    `verify-affected-closure-misses-nothing: unrecognised argument(s): ${unknown.join(" ")}\n` +
      "this check knows --commits=<n> and nothing else.\n",
  );
  process.exit(2);
}
const commitsArgument = process.argv.slice(2).find((argument) => argument.startsWith("--commits="));
// 60, not 12: see this file's header. At 12 the window fills with FULL verdicts and the
// comparison this file exists to make happens twice, on one answer.
const DEFAULT_COMMITS = 60;
const COMMITS = commitsArgument === undefined
  ? DEFAULT_COMMITS
  : Number(commitsArgument.slice("--commits=".length));
if (!Number.isInteger(COMMITS) || COMMITS < 1) {
  process.stderr.write(`verify-affected-closure-misses-nothing: --commits=${COMMITS} is not a count of 1 or more.\n`);
  process.exit(2);
}

/**
 * The harness's own table, bounded. `--print-rows` writes nothing and exits above the first
 * filesystem write, but it is still a child of a script that mutates source when invoked any other
 * way, so it gets the same time bound every other child in this repository gets (#872).
 */
const runBoundedRows = async () => {
  const out = execFileSync("node", [join(ROOT, "scripts/verify-guards-are-falsifiable.mjs"), "--print-rows"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out);
};

const git = (argv) => execFileSync("git", argv, { cwd: ROOT, encoding: "utf8", timeout: 30_000 }).trim();


/**
 * The whole table, from the harness that owns it.
 *
 * `loadFalsifiabilityCases` returns only the case directory; the other rows are an inline literal
 * inside the harness. Reading that literal with a parser would put a second authority on the row
 * table, and `export` is not available either — the harness is a script, so importing it runs the
 * sweep, measured as its own dirty-tree refusal. `--print-rows` (#885) is the owner handing it
 * over: it emits `ALL_ROWS` and exits above every filesystem write.
 *
 * Keyed by `partitionKey` rather than `id` because most inline rows carry none, and that key is
 * the one `assignShards` already refuses duplicates on — so uniqueness here is the uniqueness the
 * sweep itself requires rather than a property invented for this check.
 *
 * `definedIn` is attached only to case-directory rows, derived from the id and checked against
 * disk. The inline rows have no separate definition file: they are declared inside the harness,
 * and a change to the harness is global scope, so the term would be redundant and inventing a
 * path for it would be a second authority of exactly the kind avoided above.
 */
const printed = await runBoundedRows();
const casesById = new Map(
  (await loadFalsifiabilityCases(ROOT)).map((row) => [row.id, `${CASES_DIR}/${row.id}.mjs`]),
);
const rows = printed.rows.map((row) => ({
  id: row.partitionKey,
  file: row.file,
  killedBy: row.killedBy,
  ...(row.id !== undefined && casesById.has(row.id) ? { definedIn: casesById.get(row.id) } : {}),
}));
const misderived = [...casesById.values()].filter((path) => !existsSync(join(ROOT, path)));
if (misderived.length > 0) {
  process.stdout.write(
    `verify-affected-closure-misses-nothing: ${misderived.length} row id(s) do not name a module on disk.\n`,
  );
  for (const path of misderived.slice(0, 10)) process.stdout.write(`  NO SUCH MODULE  ${path}\n`);
  process.stdout.write("\nRESULT: FAIL — a row whose definition cannot be located cannot be selected by it.\n");
  process.exit(1);
}
const sweepTotal = printed.total;
const files = moduleFilesUnder(ROOT, ["src", "tests", "scripts"]);
const { imports, undecidable } = buildImportGraph(ROOT, files);
if (undecidable.length > 0) {
  process.stdout.write(
    `verify-affected-closure-misses-nothing: the import graph could not resolve ${undecidable.length} specifier(s).\n`,
  );
  for (const one of undecidable.slice(0, 10)) process.stdout.write(`  UNRESOLVED  ${one}\n`);
  process.stdout.write("\nRESULT: FAIL — a graph with a missing edge makes a row look unaffected.\n");
  process.exit(1);
}

/**
 * This side's own reading of `killedBy`, deliberately **not** the forward module's helper.
 *
 * Measured, and this is the whole reason it exists: with both sides calling the exported
 * `witnessFilesOf`, replacing that one function with `() => []` dropped the selection on
 * `c2910de9` from 6 rows to 0, on `3b0ec9cc` from 6 to 0, on `5aa84a28` from 166 to 44 and on
 * `814cf6f5` from 223 to 141 — and the two sides **agreed on every set**, with every partition
 * check passing. One shared helper blinded both traversals at once, which is exactly the
 * "coverage implied, not observed" shape this file was written to refuse. gpt-6-astra found it;
 * the numbers above are my re-measurement of its claim, not its report.
 *
 * So the file half of a `killedBy` entry is read here from the entry itself. The two readings
 * being trivially similar is fine — what matters is that breaking one no longer breaks both.
 */
const witnessesHere = (row) => {
  const entries = Array.isArray(row.killedBy) ? row.killedBy : row.killedBy === undefined ? [] : [row.killedBy];
  return entries
    .map((entry) => {
      const text = String(entry);
      const separator = text.indexOf("::");
      return separator === -1 ? text : text.slice(0, separator);
    })
    .filter((file) => file.length > 0);
};

/** Reverse edges: `file -> the files that import it`. */
const importedBy = new Map();
for (const [file, targets] of imports) {
  for (const target of targets) {
    if (!importedBy.has(target)) importedBy.set(target, []);
    importedBy.get(target).push(file);
  }
}

/** Every file that can reach `from` through imports, `from` included. */
const dependentsOf = (from) => {
  const seen = new Set([from]);
  const stack = [from];
  while (stack.length > 0) {
    for (const next of importedBy.get(stack.pop()) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      stack.push(next);
    }
  }
  return seen;
};

/**
 * The second answer, computed from the change rather than from the row.
 *
 * **Where the independence is, and where it is not.** The transitive part is genuinely independent:
 * the closure asks each row whether it reaches a change, this walks reverse edges from each change
 * and collects what it reaches. A bug in either traversal shows as a disagreement. The direct-key
 * terms — the mutated file itself, the row's own definition — are set membership, so both sides
 * necessarily agree on them; the check there is only that neither side *forgot* the term.
 *
 * That distinction is not theoretical. Written without `definedIn`, this reported five rows in the
 * closure and not here on commit `eff670e7`, which added five case modules: a case module is
 * loaded dynamically and imported by nothing, so no import edge reaches it and reverse
 * reachability could never see it. The closure was right and this was incomplete.
 */
const reverseReachableRows = (changedFiles) => {
  const changed = new Set(changedFiles);
  const touched = new Set();
  for (const one of changedFiles) for (const reached of dependentsOf(one)) touched.add(reached);
  const selected = new Set();
  for (const row of rows) {
    const byReachability =
      touched.has(row.file) || witnessesHere(row).some((witness) => touched.has(witness));
    const byDefinition = changed.has(row.definedIn);
    if (byReachability || byDefinition) selected.add(row.id);
  }
  return selected;
};

const commits = git(["log", "--format=%H", `-${COMMITS}`, "origin/main"]).split("\n").filter(Boolean);
const disagreements = [];
const report = [];

for (const commit of commits) {
  const changed = git(["diff", "--name-only", `${commit}~1`, commit]).split("\n").filter(Boolean);
  const forward = affectedClosure({ rows, changedFiles: changed, imports });
  if (forward.kind === "FULL") {
    report.push({ commit: commit.slice(0, 8), changed: changed.length, verdict: "FULL", reason: forward.reason });
    continue;
  }
  const forwardIds = new Set(forward.selected.map((one) => one.row.id));
  const reverseIds = reverseReachableRows(changed);

  const onlyForward = [...forwardIds].filter((id) => !reverseIds.has(id));
  const onlyReverse = [...reverseIds].filter((id) => !forwardIds.has(id));
  const unselected = rows.filter((row) => !forwardIds.has(row.id)).length;

  if (onlyForward.length > 0 || onlyReverse.length > 0) {
    disagreements.push({ commit: commit.slice(0, 8), onlyForward, onlyReverse });
  }
  // Not evidence of unaffectedness, and it was described as such in the first version of this
  // file. `unselected` is the complement of `forwardIds`, so with unique ids this equality holds
  // for any selected subset including an incorrectly empty one. It catches identity and count
  // faults — a duplicated id, a row lost between the two tables — and nothing more.
  if (forwardIds.size + unselected !== rows.length) {
    disagreements.push({ commit: commit.slice(0, 8), partition: `${forwardIds.size} + ${unselected} != ${rows.length}` });
  }
  report.push({
    commit: commit.slice(0, 8),
    changed: changed.length,
    verdict: "SELECTED",
    selected: forwardIds.size,
    unaffected: unselected,
  });
}

process.stdout.write(
  `verify-affected-closure-misses-nothing: ${rows.length} row(s), ${files.length} module(s), ` +
    `${[...imports.values()].reduce((sum, one) => sum + one.length, 0)} import edge(s); ` +
    `${commits.length} real changed-file set(s) from origin/main.\n`,
);
for (const one of report) {
  process.stdout.write(
    one.verdict === "FULL"
      ? `  ${one.commit}  ${String(one.changed).padStart(3)} file(s)  FULL      ${one.reason}\n`
      : `  ${one.commit}  ${String(one.changed).padStart(3)} file(s)  SELECTED  ${one.selected} of ${rows.length}, ${one.unaffected} unaffected\n`,
  );
}
for (const one of disagreements) process.stdout.write(`  DISAGREEMENT  ${JSON.stringify(one)}\n`);

// Identity, not cardinality. Every row the harness printed is in this table under its own
// partition key, and the harness refuses duplicate keys itself, so this is a set equality rather
// than the count comparison the first version of this file settled for — equal cardinalities
// could not have excluded one omitted row replaced by another.
const printedKeys = new Set(printed.rows.map((row) => row.partitionKey));
if (printedKeys.size !== rows.length || rows.some((row) => !printedKeys.has(row.id))) {
  process.stdout.write(
    `  TABLE MISMATCH  the harness printed ${printed.rows.length} row(s) with ${printedKeys.size} ` +
      `distinct key(s); this check holds ${rows.length}.\n`,
  );
}

const tableMismatch = printedKeys.size !== rows.length || rows.some((row) => !printedKeys.has(row.id));
if (disagreements.length > 0 || tableMismatch) {
  process.stdout.write(
    disagreements.length > 0
      ? "\nRESULT: FAIL — the forward closure and reverse reachability name different rows, so one " +
        "of them is wrong and a row may be missed.\n"
      : "\nRESULT: FAIL — the table this check holds is not the table the harness printed.\n",
  );
  process.exit(1);
}
process.stdout.write(
  `\nRESULT: PASS — on every set above, the closure selects exactly the rows reverse reachability ` +
    `finds, over all ${rows.length} row(s) the harness printed, keyed by the partition key it ` +
    "refuses duplicates on.\n" +
    "  What this is: agreement between two traversals of one graph. What it is not: proof that " +
    "reachability is the right relation, that the graph is complete, or — for a FULL verdict — " +
    "any comparison at all, since those skip the reverse computation.\n",
);
