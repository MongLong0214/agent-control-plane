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
 * A third gap took longer to see, because it looks like the check working. A squash merge strands
 * the branch's earlier records mid-message, and `commitlore squash-preserve` / the
 * `commitlore-preserve` workflow answer that by attaching them to the merge commit as a note on
 * `refs/notes/commitlore` — the repository's sanctioned repair, chosen in 0da07459 over rewriting
 * pushed history. This file read only the message, so it reported those records lost while a note
 * was carrying them. Twice: `573f7eab` (#867), which ci.yml records turned two green pull requests
 * red, answered then by narrowing the range; and `8b38c9d6` (#937), where the range is already
 * `HEAD~1..HEAD` and there is nothing left to narrow. A record is stored when git can read it back,
 * and a note is one of the two places git reads it back from — so this asks both.
 *
 * It asks them in that order and never the other way: a note is a repair for a commit that already
 * exists, so `--message-file`, which runs *before* the merge, has no note to consult and must still
 * require the message itself to carry every record.
 *
 * Usage:
 *   verify-trailers-are-parsable.mjs [<range>]          (default: origin/main..HEAD)
 *   verify-trailers-are-parsable.mjs --message-file <p> (a message that is not a commit yet; `-` = stdin)
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { RECORD_TRAILER_KEY_PATTERN } from "./lib/record-trailer-keys.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const git = (args, input) =>
  execFileSync("git", args, { cwd: ROOT, encoding: "utf8", ...(input === undefined ? {} : { input }) });

/** Trailer keys this project records. A wrapped line under any of them loses the record. */
const KEYS = RECORD_TRAILER_KEY_PATTERN;

/**
 * What the message claims, against what git will actually store.
 *
 * Asking git rather than reimplementing its rule is the point: every phrasing of the question that
 * is not "run the code that decides" can drift from the answer, and the first version of the
 * `commit-msg` hook drifted exactly that way.
 */
const unparsed = (message, carried = [], source = []) => {
  // SPEC §2.4 recovers separate identified record paragraphs. Git's all-message
  // trailer parser sees only the last one; it is not the multi-record authority.
  if ((message.match(/^Record-Id\s*:/gim) ?? []).length > 1) {
    try {
      const cli = (args) => execFileSync("commitlore", args, { cwd: ROOT, encoding: "utf8", input: message });
      const validation = JSON.parse(cli(["validate", ...source, "--json"]));
      const checks = validation.checks;
      if (!Array.isArray(checks) || checks.length !== 2 ||
          !["shape", "reference"].every((required) =>
            checks.filter((check) => check?.class === required && check.status === "ok").length === 1)) {
        return ["multi-record semantic validation was incomplete"];
      }
      const { blocks } = JSON.parse(cli(["parse", "--json"]));
      if (!Array.isArray(blocks) || blocks.length < 2 || blocks.some((block) => block.identityCollision)) {
        return ["invalid multi-record region"];
      }
      const region = blocks.map((block) => block.trailers.map(({ key, value }) => `${key}: ${value}`).join("\n")).join("\n\n");
      const start = message.indexOf(region);
      // Exact canonical paragraphs, ending the message: no prose, hidden record,
      // malformed continuation or second title may be skipped by the parser.
      if (start < 2 || message.slice(start - 2, start) !== "\n\n" ||
          message.slice(start).replace(/\n+$/, "") !== region ||
          message.slice(0, start).split("\n").some((line) => KEYS.test(line))) {
        return ["records must form one final, intact structured region"];
      }
      return [];
    } catch {
      // A note never excuses a malformed multi-record message or an unavailable validator.
      return ["multi-record semantic validation failed or could not run"];
    }
  }
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
  const missing = written.filter((line) => {
    const at = remaining.findIndex((p) => p.trim() === line.trim());
    if (at === -1) return true;
    remaining.splice(at, 1);
    return false;
  });
  // A line the message no longer carries is only lost if nothing else carries it. `carried` is the
  // commit's note, and it is empty on every path where no commit exists yet.
  const elsewhere = carried.map((line) => line.trim());
  return missing.filter((line) => !elsewhere.includes(line.trim()));
};

/** Whether this checkout has the notes ref at all — absent is "not fetched", never "empty". */
const notesRefPresent = () => {
  try {
    git(["rev-parse", "--verify", "--quiet", "refs/notes/commitlore"]);
    return true;
  } catch {
    return false;
  }
};

/** The lines of a commit's CommitLore note, or none when that commit has no note. */
const noteLines = (sha) => {
  try {
    return git(["notes", "--ref=commitlore", "show", sha]).split("\n");
  } catch {
    return [];
  }
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
  const bytes = readFileSync(path === "-" ? 0 : path);
  const expectedAt = process.argv.indexOf("--expected-message-file");
  if (expectedAt !== -1 && !bytes.equals(readFileSync(process.argv[expectedAt + 1]))) {
    process.stdout.write("RESULT: FAIL — the official message bytes changed.\n");
    process.exit(1);
  }
  const message = bytes.toString("utf8");
  const lost = unparsed(message, [], path === "-" ? [] : ["--message-file", path]);
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

const notesFetched = notesRefPresent();

let broken = 0;
for (const sha of shas) {
  const lost = unparsed(git(["log", "-1", "--format=%B", sha]), notesFetched ? noteLines(sha) : [], ["--commit", sha]);
  if (lost.length === 0) continue;
  broken += 1;
  report(lost, sha.slice(0, 7));
}

if (broken > 0) {
  process.stdout.write(EXPLANATION);
  if (!notesFetched) {
    // Saying "lost" from a checkout that cannot see the notes ref would be an answer given without
    // having looked at the other half of the storage. The refusal stands — nothing here can show
    // the record survived — but it names what this checkout could not read.
    process.stdout.write(
      "\nrefs/notes/commitlore is not in this checkout, so a record a note carries could not be\n" +
        "seen. Fetch it and run this again:\n" +
        "  git fetch --no-tags origin '+refs/notes/commitlore:refs/notes/commitlore'\n",
    );
  }
  process.stdout.write(`RESULT: FAIL — ${broken} commit(s) in ${range} carry a trailer git will not store.\n`);
  process.exit(1);
}

process.stdout.write(
  `RESULT: PASS — ${shas.length} commit(s) in ${range}, every trailer survives \`git interpret-trailers --parse\`.\n`,
);
