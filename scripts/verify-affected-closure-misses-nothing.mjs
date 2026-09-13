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
 * **Not in the gate set, deliberately.** It exits 1 today, and it should: the thing it must prove
 * is not yet provable. Wiring a check that cannot pass would either turn CI red for a property
 * nobody has claimed, or invite someone to relax it into passing. It runs on demand and its
 * refusal is the record of what unit 3 is waiting for.
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
const COMMITS = commitsArgument === undefined ? 12 : Number(commitsArgument.slice("--commits=".length));
if (!Number.isInteger(COMMITS) || COMMITS < 1) {
  process.stderr.write(`verify-affected-closure-misses-nothing: --commits=${COMMITS} is not a count of 1 or more.\n`);
  process.exit(2);
}

const git = (argv) => execFileSync("git", argv, { cwd: ROOT, encoding: "utf8", timeout: 30_000 }).trim();

/**
 * `definedIn` is derived from the id, and the derivation is checked rather than trusted: the case
 * loader does not report which module a row came from, and the convention is
 * `scripts/falsifiability-cases/<id>.mjs`. A derived path that is not on disk is a refusal, not a
 * silently absent term — without it a change to one case file would fall through to whatever
 * coarser rule catches the directory.
 */
const rows = (await loadFalsifiabilityCases(ROOT)).map((row) => ({
  id: row.id,
  file: row.file,
  killedBy: row.killedBy,
  definedIn: `${CASES_DIR}/${row.id}.mjs`,
}));
const misderived = rows.filter((row) => row.definedIn !== undefined && !existsSync(join(ROOT, row.definedIn)));
if (misderived.length > 0) {
  process.stdout.write(
    `verify-affected-closure-misses-nothing: ${misderived.length} row id(s) do not name a module on disk.\n`,
  );
  for (const row of misderived.slice(0, 10)) process.stdout.write(`  NO SUCH MODULE  ${row.id} -> ${row.definedIn}\n`);
  process.stdout.write("\nRESULT: FAIL — a row whose definition cannot be located cannot be selected by it.\n");
  process.exit(1);
}

/**
 * **The rows this check cannot enumerate, and why that forbids narrowing today.**
 *
 * The sweep partitions 632 rows; `loadFalsifiabilityCases` returns only the case directory. The
 * rest live in an inline `GUARDS` array inside the harness. A change to the harness is global
 * scope, so those rows are never narrowed *away* by the closure — but they are also never
 * *selected* by it, because they are not in this table at all. A runner built on a table missing
 * 385 rows would skip every one of them on a change to its own file or witness, which is exactly
 * the missed row this unit exists to rule out.
 *
 * **The blocker is not a missing `export`, and I tried that first.** Adding one makes the array
 * reachable and makes this check unusable: the harness is a script, so importing it *runs the
 * sweep* — the attempt ended in its dirty-tree refusal, having started a mutation run. Reading the
 * array out of the file with a parser instead would put a second authority on the row table, which
 * is the shape this whole area keeps failing on.
 *
 * So the real blocker is structural: the table and the runner are the same module, and the table
 * cannot be read without executing the runner. Until the array moves to a module of its own — or
 * the harness stops executing on import — unit 2 cannot cover the whole sweep and no narrowing is
 * permitted. This check refuses rather than passing on 39% of the rows.
 */
const sweepTotal = Number(
  /partitioning (\d+) row/.exec(
    execFileSync("node", [join(ROOT, "scripts/verify-guards-are-falsifiable.mjs"), "--shard-report=1"], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 120_000,
    }),
  )?.[1] ?? "0",
);
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

if (rows.length !== sweepTotal) {
  process.stdout.write(
    `  NOT ENUMERABLE  ${sweepTotal - rows.length} of ${sweepTotal} row(s) live in the harness's inline ` +
      "GUARDS array and cannot be listed from outside it.\n" +
      "                 and this is a count, not an identity reconciliation: equal cardinalities " +
      "could not exclude one omitted row replaced by another.\n",
  );
}

if (disagreements.length > 0 || rows.length !== sweepTotal) {
  process.stdout.write(
    disagreements.length > 0
      ? "\nRESULT: FAIL — the forward closure and reverse reachability name different rows, so one " +
        "of them is wrong and a row may be missed.\n"
      : "\nRESULT: FAIL — the two traversals agree on every row this can enumerate, and that is " +
        "not the whole table. The harness holds the other rows and runs the sweep when imported, " +
        "so the table has to move to its own module before this can cover it; until then no " +
        "narrowing is permitted.\n",
  );
  process.exit(1);
}
process.stdout.write(
  "\nRESULT: PASS — on every set above, the closure selects exactly the rows reverse reachability " +
    "finds, and selected plus unaffected is the whole table. This is agreement between two " +
    "traversals, not proof that reachability is the right relation.\n",
);
