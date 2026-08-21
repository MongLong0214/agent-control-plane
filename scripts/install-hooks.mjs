#!/usr/bin/env node
/**
 * Points this clone's hooks at the versioned ones in `.githooks`, without displacing CommitLore's.
 *
 * `core.hooksPath` was the obvious answer and is the wrong one here: it replaces the hook
 * directory wholesale, so CommitLore's `commit-msg`, `pre-push`, `post-commit` and
 * `prepare-commit-msg` would stop running the moment it was set. Two guards where there used to be
 * five is not an improvement, and it is the kind that reads as one.
 *
 * CommitLore already publishes a chaining convention — it runs `<hook>.commitlore-chained` first
 * and preserves whatever it found there — so the versioned hooks install into exactly that slot.
 * A hook with no CommitLore owner (`pre-commit`) is written directly.
 *
 * Idempotent: every file it writes is a two-line shim naming the versioned script, so running it
 * again produces the same bytes.
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const HOOK_DIR = join(
  ROOT,
  execFileSync("git", ["rev-parse", "--git-path", "hooks"], { cwd: ROOT, encoding: "utf8" }).trim(),
);

/** The marker a shim carries, so reinstalling recognises its own work rather than another's. */
const MARK = "# acp:versioned-hook:v1";

const shim = (name) =>
  `#!/bin/sh\n${MARK}\n` +
  `# Written by scripts/install-hooks.mjs. The logic lives in .githooks/${name}, versioned so it\n` +
  `# can be reviewed; this file only points at it.\n` +
  `#\n` +
  `# Absent is not a failure. A worktree or branch that predates the versioned hooks has nothing\n` +
  `# here to run, and the first version treated that as an error — which blocked every commit on\n` +
  `# those branches. Measured, on a worktree one branch back, while fixing something else.\n` +
  `HOOK="$(git rev-parse --show-toplevel)/.githooks/${name}"\n` +
  `[ -x "$HOOK" ] || exit 0\n` +
  `exec "$HOOK" "$@"\n`;

/**
 * Where each versioned hook has to land.
 *
 * `commit-msg` goes into CommitLore's chained slot rather than over its hook. Installing on top
 * would silently retire `commitlore validate`, and a check that removes another check while
 * reporting success is the exact failure this whole set exists to stop.
 */
const TARGETS = [
  { name: "pre-commit", path: join(HOOK_DIR, "pre-commit") },
  { name: "commit-msg", path: join(HOOK_DIR, "commit-msg.commitlore-chained") },
  { name: "pre-push", path: join(HOOK_DIR, "pre-push.commitlore-chained") },
];

const written = [];
for (const target of TARGETS) {
  const existing = existsSync(target.path) ? readFileSync(target.path, "utf8") : "";
  if (existing !== "" && !existing.includes(MARK)) {
    process.stdout.write(
      `  ${target.path}\n    exists and was not written by this installer. Refusing to overwrite it.\n` +
        "    Move it aside, or fold its contents into .githooks/ and re-run.\n",
    );
    process.stdout.write("\nRESULT: FAIL — nothing installed.\n");
    process.exit(1);
  }
  writeFileSync(target.path, shim(target.name));
  chmodSync(target.path, 0o755);
  written.push(target.path);
}

for (const path of written) process.stdout.write(`  installed ${path}\n`);
process.stdout.write("\nRESULT: PASS — run `pnpm hooks:check` to confirm they refuse what they name.\n");
