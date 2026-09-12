#!/usr/bin/env node
/**
 * Every blocking subprocess call in `src/` states a time bound, or is named here as one that does
 * not yet.
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

const ROOT = fileURLToPath(new URL("..", import.meta.url));
// `--root=<dir>` exists so a test can point the census at a fixture tree holding one bounded and
// one unbounded call. Without it the only way to check that this census can fail is to break the
// product, which is how a check ends up never having been shown to fail at all.
const rootArgument = process.argv.slice(2).find((argument) => argument.startsWith("--root="));
const SRC = rootArgument === undefined ? join(ROOT, "src") : rootArgument.slice("--root=".length);
const SCOPE = rootArgument === undefined ? "src/" : SRC;

/** Blocking: the call does not return until the child does, so only a `timeout` bounds it. */
const BLOCKING = new Set(["exec", "execFile", "execSync", "execFileSync", "spawnSync"]);
/** Non-blocking: the child outlives the call and is bounded by its supervisor, not by an option. */
const DETACHED = new Set(["spawn", "fork"]);

const files = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path);
    else if (entry.endsWith(".ts")) files.push(path);
  }
};
walk(SRC);
files.sort();

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
        const at = `${relative(ROOT, file)}:${line}`;
        if (DETACHED.has(name)) detached.push({ at, name });
        else if (BLOCKING.has(name)) (statesATimeout(node) ? bounded : unbounded).push({ at, name });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

// What was inspected, beside what exists. A census that prints only its verdict cannot be told
// apart from one whose walk found nothing.
process.stdout.write(
  `verify-subprocess-calls-are-bounded: ${files.length} file(s) under ${SCOPE} parsed; ` +
    `${bounded.length + unbounded.length} blocking call(s), of which ${bounded.length} state a ` +
    `timeout and ${unbounded.length} do not; ${detached.length} detached call(s) are out of scope.\n`,
);

// The exclusion list names calls under `src/` by `path:line`. Against a fixture tree it matches
// nothing, and reporting all of it as stale would make every fixture run fail — so a `--root=`
// census carries no excuses and says so, rather than inheriting a list about a different tree.
const excused = rootArgument === undefined ? UNBOUNDED_SUBPROCESS_EXCLUSIONS : new Map();
const unexcused = unbounded.filter((call) => !excused.has(call.at));
const staleExclusions = [...excused.keys()].filter(
  (at) => !unbounded.some((call) => call.at === at),
);
if (rootArgument !== undefined) {
  process.stdout.write(
    `  scope is ${SRC}, so the ${UNBOUNDED_SUBPROCESS_EXCLUSIONS.size} src/ exclusion(s) do not apply here.\n`,
  );
}

for (const call of unexcused) process.stdout.write(`  UNBOUNDED  ${call.at}  ${call.name}\n`);
// A name that no longer matches is not harmless: it keeps a call excused by a line number that
// has moved, and the call it now points at is excused by accident.
for (const at of staleExclusions) process.stdout.write(`  STALE EXCLUSION  ${at}\n`);

if (unexcused.length > 0 || staleExclusions.length > 0) {
  process.stdout.write(
    "RESULT: FAIL — bound the call, or name it in scripts/lib/unbounded-subprocess-exclusions.mjs " +
      "with the reason it cannot be bounded yet.\n",
  );
  process.exit(1);
}

process.stdout.write(
  `RESULT: PASS — ${excused.size} call(s) are excused by name and remain ` +
    "unbounded; a passing census is not a bounded codebase.\n",
);
