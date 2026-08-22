#!/usr/bin/env node
/**
 * Fails when a commit in the range carries a CommitLore trailer git will not parse as one.
 *
 * `git interpret-trailers` reads the final paragraph, one trailer per line. Wrap a `Limit:` across
 * two lines and the continuation is an ordinary line, which ends the block — so every trailer after
 * it, and the wrapped one itself, is stored by nobody. The commit looks right in an editor and
 * carries no record at all.
 *
 * Six times on 2026-08-22. Each time something noticed: `commitlore validate` printed
 * "looks like a Limit trailer, but git did not parse it" and **exited 0**, which is a warning
 * arriving after the commit it describes already exists. Detection was never the missing part.
 *
 * The local `commit-msg` hook refuses the same shape before the commit is made. This is the half
 * that holds for a clone that never ran `pnpm hooks:install`, which is every CI runner.
 *
 * Usage: verify-trailers-are-parsable.mjs [<range>]   (default: origin/main..HEAD)
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const range = process.argv[2] ?? "origin/main..HEAD";

const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" });

/** Trailer keys this project records. A wrapped line under any of them loses the record. */
const KEYS = /^(Limit|Ruled-out|Warn|Supersedes|Refs):/;

let shas;
try {
  shas = git("rev-list", range).split("\n").filter(Boolean);
} catch (error) {
  // A range that cannot be resolved is a usage problem, not a clean result. Reporting PASS here
  // would be the same shape as the defect: a check that answers without having looked.
  process.stdout.write(`  could not resolve ${range}: ${String(error)}\n`);
  process.stdout.write("\nRESULT: FAIL — nothing was examined.\n");
  process.exit(2);
}

const broken = [];
for (const sha of shas) {
  const lines = git("log", "-1", "--format=%B", sha).split("\n");
  let inTrailer = false;
  for (const line of lines) {
    if (KEYS.test(line)) {
      inTrailer = true;
      continue;
    }
    if (!inTrailer) continue;
    if (line.trim() === "") {
      inTrailer = false;
      continue;
    }
    if (!/^[A-Za-z-]+:/.test(line)) {
      broken.push({ sha: sha.slice(0, 7), line });
      inTrailer = false;
    }
  }
}

if (broken.length > 0) {
  for (const { sha, line } of broken) {
    process.stdout.write(`  ${sha} continues a trailer instead of being one:\n    ${line}\n`);
  }
  process.stdout.write(
    "\nA trailer must be one line. Length is fine; a line break is not.\n" +
      `RESULT: FAIL — ${broken.length} wrapped trailer line(s) in ${range}.\n`,
  );
  process.exit(1);
}

process.stdout.write(`RESULT: PASS — ${shas.length} commit(s) in ${range}, every trailer on one line.\n`);
