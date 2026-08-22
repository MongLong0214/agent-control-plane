#!/usr/bin/env node
/**
 * Checks that this clone actually runs the hooks in `.githooks`, and that they still refuse.
 *
 * A versioned hooks directory nobody wired up is the shape this repository keeps finding: a name
 * at one site and the enforcement at a different, narrower one. `.githooks/pre-commit` sitting in
 * the tree proves nothing about what happens when someone commits. Wiring is a local step — git
 * will not let a repository install its own hooks, because a clone that silently starts executing
 * them is a code-execution path — so this is the thing that notices the step was skipped.
 *
 * It also runs each hook against a case it must refuse. A hook that exists, is pointed at, and
 * returns zero for everything is the same failure one layer down — and that layer is where the
 * last four of these lived.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const failures = [];

// `resolve`, not `join` — see install-hooks.mjs. This crashed uncaught in a linked worktree,
// which is a check reporting nothing rather than reporting a failure.
const HOOK_DIR = resolve(
  ROOT,
  execFileSync("git", ["rev-parse", "--git-path", "hooks"], { cwd: ROOT, encoding: "utf8" }).trim(),
);

/**
 * Where the installer puts each shim, and why `commit-msg` is not where you would look.
 *
 * `core.hooksPath` would have been one line and would have retired CommitLore's four hooks in
 * silence. The versioned `commit-msg` therefore lives in CommitLore's published chained slot, and
 * this check has to look there — checking the obvious path would pass while nothing ran.
 */
const WIRING = [
  { name: "pre-commit", path: join(HOOK_DIR, "pre-commit") },
  { name: "commit-msg", path: join(HOOK_DIR, "commit-msg.commitlore-chained") },
  { name: "pre-push", path: join(HOOK_DIR, "pre-push.commitlore-chained") },
];

for (const wired of WIRING) {
  let contents = "";
  try {
    contents = readFileSync(wired.path, "utf8");
  } catch {
    failures.push(`${wired.path} does not exist — run \`pnpm hooks:install\``);
    continue;
  }
  if (!contents.includes(`.githooks/${wired.name}`)) {
    failures.push(`${wired.path} exists but does not run .githooks/${wired.name}`);
  }
  try {
    if ((statSync(wired.path).mode & 0o111) === 0) failures.push(`${wired.path} is not executable`);
  } catch {
    /* the missing case is already recorded above */
  }
}

for (const hook of ["pre-commit", "commit-msg", "pre-push"]) {
  const path = join(ROOT, ".githooks", hook);
  try {
    // 0o111: some bit of execute. A hook without it is skipped by git in silence, which is the
    // failure this file exists to make loud.
    if ((statSync(path).mode & 0o111) === 0) failures.push(`.githooks/${hook} is not executable`);
  } catch {
    failures.push(`.githooks/${hook} is missing`);
  }
}

/** A message whose trailer wraps — the exact shape that reached six commits on 2026-08-22. */
const WRAPPED_TRAILER = "subject\n\nbody\n\nLimit: this trailer wraps across\ntwo lines.\n";
/** The same message with the trailer on one line, which must be accepted. */
const INTACT_TRAILER = "subject\n\nbody\n\nLimit: this trailer stays on one line.\n";

const runCommitMsg = (contents) => {
  const dir = mkdtempSync(join(tmpdir(), "acp-hook-check-"));
  chmodSync(dir, 0o700);
  const file = join(dir, "COMMIT_EDITMSG");
  writeFileSync(file, contents);
  return spawnSync(join(ROOT, ".githooks", "commit-msg"), [file], { cwd: ROOT, encoding: "utf8" });
};

if (runCommitMsg(WRAPPED_TRAILER).status === 0) {
  failures.push("commit-msg accepted a wrapped trailer, which git will not parse as one");
}
if (runCommitMsg(INTACT_TRAILER).status !== 0) {
  failures.push("commit-msg refused an ordinary one-line trailer");
}

// The pre-commit hook's sentinel branch, exercised where it can be observed: create the file the
// harness writes, and require a refusal. Removed afterwards whatever happens, because leaving it
// behind would refuse every later commit for a run that never existed.
const sentinel = resolve(
  ROOT,
  execFileSync("git", ["rev-parse", "--git-path", "verify-guards-in-flight.json"], {
    cwd: ROOT,
    encoding: "utf8",
  }).trim(),
);
let sentinelExisted = true;
try {
  statSync(sentinel);
} catch {
  sentinelExisted = false;
}
if (sentinelExisted) {
  failures.push(
    `a falsifiability sentinel is present at ${sentinel}.\n` +
      "  Either a sweep is running, or one died — reconcile it before trusting this check.",
  );
} else {
  writeFileSync(sentinel, "{}");
  try {
    const refused = spawnSync(join(ROOT, ".githooks", "pre-commit"), [], { cwd: ROOT, encoding: "utf8" });
    if (refused.status === 0) {
      failures.push("pre-commit accepted a commit while a harness mutation was applied");
    }
  } finally {
    execFileSync("rm", ["-f", sentinel]);
  }
}

if (failures.length > 0) {
  for (const failure of failures) process.stdout.write(`  ${failure}\n`);
  process.stdout.write("\nRESULT: FAIL — the hooks are not enforcing what they document.\n");
  process.exit(1);
}

process.stdout.write("RESULT: PASS — hooks installed, and each refuses the case it names.\n");
