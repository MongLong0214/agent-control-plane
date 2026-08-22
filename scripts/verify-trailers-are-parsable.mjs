#!/usr/bin/env node
/**
 * Fails when a message carries a CommitLore trailer git will not parse as one.
 *
 * `git interpret-trailers` reads the final paragraph, one trailer per line. Wrap a `Limit:` across
 * two lines and the continuation is an ordinary line, which ends the block — so every trailer after
 * it, and the wrapped one itself, is stored by nobody. The message looks right in an editor and
 * carries no record at all.
 *
 * Six times on 2026-08-22 in hand-written commits. Each time something noticed: `commitlore
 * validate` printed "looks like a Limit trailer, but git did not parse it" and **exited 0**, which
 * is a warning arriving after the commit it describes already exists.
 *
 * The seventh time was different, and is why this file was rewritten. The `commit-msg` hook was
 * installed and working, and the wrapped trailer landed anyway — in the squash-merge commit for
 * #665, whose message GitHub composed server-side from a `gh pr merge --body` argument. **No local
 * hook runs on a commit a server creates.** The guard existed; the path that produced the commit
 * did not pass through it. So the check now takes a message that is not yet a commit
 * (`--message-file`), which is what lets `scripts/merge-pr.mjs` ask it *before* merging.
 *
 * The rewrite closed a second gap in the same breath. This file used to approximate git's rule
 * with a regex while the hook asked `git interpret-trailers --parse` — two implementations of one
 * rule, and the weaker one could not see a trailer block with no blank line before it, which git
 * also refuses. One rule now has one implementation, and the hook, CI, and the merge path are
 * three callers of it.
 *
 * Usage:
 *   verify-trailers-are-parsable.mjs [<range>]          (default: origin/main..HEAD)
 *   verify-trailers-are-parsable.mjs --message-file <p> (a message that is not a commit yet; `-` = stdin)
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const git = (args, input) =>
  execFileSync("git", args, { cwd: ROOT, encoding: "utf8", ...(input === undefined ? {} : { input }) });

/** Trailer keys this project records. A wrapped line under any of them loses the record. */
const KEYS = /^(Limit|Ruled-out|Warn|Supersedes|Refs|Record-Id):/;

/**
 * What the message claims, against what git will actually store.
 *
 * Asking git rather than reimplementing its rule is the point: every phrasing of the question that
 * is not "run the code that decides" can drift from the answer, and the first version of the
 * `commit-msg` hook drifted exactly that way.
 */
const unparsed = (message) => {
  // Comments are stripped the way git strips them, so a commented-out example is not counted.
  const body = message
    .split("\n")
    .filter((line) => !line.startsWith("#"))
    .join("\n");
  const written = body.split("\n").filter((line) => KEYS.test(line));
  if (written.length === 0) return [];
  const parsed = git(["interpret-trailers", "--parse"], body)
    .split("\n")
    .filter((line) => KEYS.test(line));
  if (written.length <= parsed.length) return [];
  // Report the written lines git did not return. A wrapped trailer usually kills the whole block,
  // so this is normally all of them — naming each is what tells the author which record was lost,
  // rather than that a count disagreed.
  const remaining = [...parsed];
  return written.filter((line) => {
    const at = remaining.findIndex((p) => p.trim() === line.trim());
    if (at === -1) return true;
    remaining.splice(at, 1);
    return false;
  });
};

const report = (lost, subject) => {
  for (const line of lost) process.stdout.write(`  ${subject} loses:  ${line}\n`);
};

const EXPLANATION =
  "\nA trailer must be one line, and the block must be the last paragraph with a blank line\n" +
  "before it. Length is fine; a line break inside a trailer is not.\n";

const messageFileAt = process.argv.indexOf("--message-file");
if (messageFileAt !== -1) {
  const path = process.argv[messageFileAt + 1];
  if (path === undefined) {
    process.stdout.write("  --message-file needs a path (`-` for stdin).\n\nRESULT: FAIL — nothing was examined.\n");
    process.exit(2);
  }
  const message = readFileSync(path === "-" ? 0 : path, "utf8");
  const lost = unparsed(message);
  if (lost.length > 0) {
    report(lost, "the message");
    process.stdout.write(`${EXPLANATION}RESULT: FAIL — ${lost.length} trailer line(s) git will not store.\n`);
    process.exit(1);
  }
  process.stdout.write("RESULT: PASS — every trailer in the message survives `git interpret-trailers --parse`.\n");
  process.exit(0);
}

const range = process.argv[2] ?? "origin/main..HEAD";
let shas;
try {
  shas = git(["rev-list", range]).split("\n").filter(Boolean);
} catch (error) {
  // A range that cannot be resolved is a usage problem, not a clean result. Reporting PASS here
  // would be the same shape as the defect: a check that answers without having looked.
  process.stdout.write(`  could not resolve ${range}: ${String(error)}\n`);
  process.stdout.write("\nRESULT: FAIL — nothing was examined.\n");
  process.exit(2);
}

let broken = 0;
for (const sha of shas) {
  const lost = unparsed(git(["log", "-1", "--format=%B", sha]));
  if (lost.length === 0) continue;
  broken += 1;
  report(lost, sha.slice(0, 7));
}

if (broken > 0) {
  process.stdout.write(`${EXPLANATION}RESULT: FAIL — ${broken} commit(s) in ${range} carry a trailer git will not store.\n`);
  process.exit(1);
}

process.stdout.write(
  `RESULT: PASS — ${shas.length} commit(s) in ${range}, every trailer survives \`git interpret-trailers --parse\`.\n`,
);
