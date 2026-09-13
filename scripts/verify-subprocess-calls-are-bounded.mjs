#!/usr/bin/env node
/**
 * Every blocking subprocess call in `src/` and `tests/` states a time bound, or is accounted for
 * as one that does not yet.
 *
 * `promisify(execFile)` and the `*Sync` family wait forever without a `timeout` option, and this
 * repository awaits several of those probes on paths that decide a verdict. Measured 2026-09-12
 * (#844/#859): with a `ps` made to take 8s and nothing else changed, a sandboxed command needing
 * 50ms against a 3-second budget came back `ERROR` / `SANDBOX_CHILD_CLEANUP_FAILED` after
 * 24,081ms. Probe latency did not merely slow the verdict, it inverted it.
 *
 * Bounding the calls one at a time does not close the class — the next copy arrives unbounded and
 * nothing notices. What surfaced this was two implementations of the *same* `ps -o lstart=` probe,
 * one bounded at 5s and one not, whose own docstring declared them equivalent. A census is what
 * makes that comparable.
 *
 * Parsed with the TypeScript compiler rather than matched with a regex, because the first census
 * I wrote by regex counted `RegExp.prototype.exec` as a subprocess call. A check that miscounts
 * its own subject is the failure mode this file exists to remove.
 *
 * Limit: presence of a `timeout` property is all this proves. It does not read the value, and it
 * cannot tell whether the caller distinguishes "the probe could not answer" from "the subject said
 * no" — the collapse that made a timed-out `lsof` report a working directory as mismatched. That
 * distinction needs its own check.
 *
 * Async `spawn` is counted separately and never a violation: its child outlives the call by design
 * and is bounded by whatever supervises it, which for `runSandboxed` is its own timer.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import { UNBOUNDED_SUBPROCESS_EXCLUSIONS } from "./lib/unbounded-subprocess-exclusions.mjs";
import { UNBOUNDED_SUBPROCESS_TEST_BUDGETS } from "./lib/unbounded-subprocess-test-budgets.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
// `--root=<dir>` exists so a test can point the census at a fixture tree holding one bounded and
// one unbounded call. Without it the only way to check that this census can fail is to break the
// product, which is how a check ends up never having been shown to fail at all.
const rootArgument = process.argv.slice(2).find((argument) => argument.startsWith("--root="));
const FIXTURE_ROOT = rootArgument === undefined ? null : rootArgument.slice("--root=".length);
// `--budgets=<file>` exists for the same reason `--root=` does: the per-file ratchet over `tests/`
// can only be shown to fail if a run can be given a budget that disagrees with the tree it walks.
// Without it the only demonstration would be to add an unbounded call to a real test file.
const budgetsArgument = process.argv.slice(2).find((argument) => argument.startsWith("--budgets="));
const FIXTURE_BUDGETS =
  budgetsArgument === undefined
    ? null
    : new Map(JSON.parse(readFileSync(budgetsArgument.slice("--budgets=".length), "utf8")));

/**
 * Two real scopes with two different policies, because the two trees fail differently.
 *
 * `src/` is nearly bounded, so each remaining call is named by `path:line` and a moved line is
 * reported as stale. `tests/` holds 186 unbounded calls across 60 files, where line keys would go
 * stale on almost every edit — so it is counted per file and the count must match exactly.
 */
const SCOPES =
  FIXTURE_ROOT === null
    ? [
        { dir: join(ROOT, "src"), base: ROOT, label: "src/", excused: UNBOUNDED_SUBPROCESS_EXCLUSIONS, budgets: null },
        { dir: join(ROOT, "tests"), base: ROOT, label: "tests/", excused: new Map(), budgets: UNBOUNDED_SUBPROCESS_TEST_BUDGETS },
      ]
    : [{ dir: FIXTURE_ROOT, base: FIXTURE_ROOT, label: FIXTURE_ROOT, excused: new Map(), budgets: FIXTURE_BUDGETS }];

/** Blocking: the call does not return until the child does, so only a `timeout` bounds it. */
const BLOCKING = new Set(["exec", "execFile", "execSync", "execFileSync", "spawnSync"]);
/** Non-blocking: the child outlives the call and is bounded by its supervisor, not by an option. */
const DETACHED = new Set(["spawn", "fork"]);

const filesUnder = (root) => {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (entry.endsWith(".ts")) found.push(path);
    }
  };
  walk(root);
  return found.sort();
};

const calleeName = (node) => {
  if (ts.isIdentifier(node.expression)) return node.expression.text;
  // `cp.execFile(...)` where `cp` is a namespace import. A property access named `exec` on
  // anything else is `RegExp.prototype.exec`, which is why the name alone is not enough.
  if (ts.isPropertyAccessExpression(node.expression)) {
    const owner = node.expression.expression;
    if (ts.isIdentifier(owner) && /^(cp|childProcess|child_process)$/.test(owner.text)) {
      return node.expression.name.text;
    }
  }
  return null;
};

const statesATimeout = (node) =>
  node.arguments.some(
    (argument) =>
      ts.isObjectLiteralExpression(argument) &&
      argument.properties.some(
        (property) =>
          property.name !== undefined &&
          ts.isIdentifier(property.name) &&
          property.name.text === "timeout",
      ),
  );

const censusOf = (scope) => {
  const files = filesUnder(scope.dir);
  const bounded = [];
  const unbounded = [];
  const detached = [];

  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
    const visit = (node) => {
      if (ts.isCallExpression(node)) {
        const name = calleeName(node);
        if (name !== null) {
          const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
          const at = `${relative(scope.base, file)}:${line}`;
          if (DETACHED.has(name)) detached.push({ at, name });
          else if (BLOCKING.has(name)) (statesATimeout(node) ? bounded : unbounded).push({ at, name });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { files, bounded, unbounded, detached };
};

/** `path:line` -> `path`. The budget list is per file, so the counts have to be too. */
const fileOf = (at) => at.slice(0, at.lastIndexOf(":"));

const problems = [];

for (const scope of SCOPES) {
  const { files, bounded, unbounded, detached } = censusOf(scope);

  // What was inspected, beside what exists. A census that prints only its verdict cannot be told
  // apart from one whose walk found nothing.
  process.stdout.write(
    `verify-subprocess-calls-are-bounded: ${files.length} file(s) under ${scope.label} parsed; ` +
      `${bounded.length + unbounded.length} blocking call(s), of which ${bounded.length} state a ` +
      `timeout and ${unbounded.length} do not; ${detached.length} detached call(s) are out of scope.\n`,
  );

  if (FIXTURE_ROOT !== null) {
    // The `src/` list names calls by `path:line`; against a fixture tree it matches nothing, and
    // reporting all of it as stale would make every fixture run fail. So a `--root=` census
    // carries no excuses and says so, rather than inheriting a list about a different tree.
    process.stdout.write(
      `  scope is ${scope.label}, so the ${UNBOUNDED_SUBPROCESS_EXCLUSIONS.size} src/ exclusion(s) do not apply here.\n`,
    );
  }

  if (scope.budgets === null) {
    const unexcused = unbounded.filter((call) => !scope.excused.has(call.at));
    const stale = [...scope.excused.keys()].filter((at) => !unbounded.some((call) => call.at === at));
    for (const call of unexcused) process.stdout.write(`  UNBOUNDED  ${call.at}  ${call.name}\n`);
    // A name that no longer matches is not harmless: it keeps a call excused by a line number that
    // has moved, and the call it now points at is excused by accident.
    for (const at of stale) process.stdout.write(`  STALE EXCLUSION  ${at}\n`);
    if (unexcused.length > 0 || stale.length > 0) {
      problems.push(
        `${scope.label}: bound the call, or name it in scripts/lib/unbounded-subprocess-exclusions.mjs ` +
          "with the reason it cannot be bounded yet",
      );
    }
    continue;
  }

  // Per-file budgets. Both directions are reported: a count that rose is a new unbounded call, and
  // a count that fell is a budget that now permits a future one for free.
  const actual = new Map();
  for (const call of unbounded) actual.set(fileOf(call.at), (actual.get(fileOf(call.at)) ?? 0) + 1);
  let mismatched = 0;
  for (const path of [...new Set([...actual.keys(), ...scope.budgets.keys()])].sort()) {
    const has = actual.get(path) ?? 0;
    const allowed = scope.budgets.get(path) ?? 0;
    if (has === allowed) continue;
    mismatched += 1;
    const verb = has > allowed ? "OVER BUDGET" : "BUDGET NOW STALE";
    process.stdout.write(`  ${verb}  ${path}  ${has} unbounded call(s), budget ${allowed}\n`);
  }
  const total = [...scope.budgets.values()].reduce((sum, one) => sum + one, 0);
  process.stdout.write(
    `  ${scope.budgets.size} file(s) carry a budget totalling ${total}; ${unbounded.length} unbounded ` +
      `call(s) found in ${actual.size} file(s).\n`,
  );
  if (mismatched > 0) {
    problems.push(
      `${scope.label}: bound the call and lower the number, or raise it in ` +
        "scripts/lib/unbounded-subprocess-test-budgets.mjs — the budget is checked for equality, " +
        "not as a ceiling",
    );
  }
}

if (problems.length > 0) {
  for (const problem of problems) process.stdout.write(`RESULT: FAIL — ${problem}.\n`);
  process.exit(1);
}

const excusedTotal =
  FIXTURE_ROOT === null
    ? UNBOUNDED_SUBPROCESS_EXCLUSIONS.size +
      [...UNBOUNDED_SUBPROCESS_TEST_BUDGETS.values()].reduce((sum, one) => sum + one, 0)
    : 0;
process.stdout.write(
  `RESULT: PASS — ${excusedTotal} call(s) are excused by name or by budget and remain ` +
    "unbounded; a passing census is not a bounded codebase.\n",
);
