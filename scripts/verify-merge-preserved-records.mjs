#!/usr/bin/env node
/**
 * Refuses a merge commit that did not keep the records its branch carried.
 *
 * A squash concatenates every branch commit message and git reads only the **last paragraph** as
 * the trailer block, so every earlier commit's records are dropped by the merge itself. The
 * repository already answers this twice over and neither answer held on 2026-09-15:
 *
 *   * `scripts/merge-pr.mjs` (`pnpm merge`) calls `commitlore squash-preserve` and is the only
 *     sanctioned merge here. Twelve merges that day went through `gh pr merge --squash` instead.
 *     Nothing could refuse that: the merge commit is composed on GitHub's servers, where no local
 *     hook runs;
 *   * the `CommitLore squash inheritance` action exists to catch exactly the other path. It
 *     reported `success` with `records=0` on every one of them, because its "already carried"
 *     test searches the merge commit's **message text** while the property that matters is
 *     whether git will store the line as a trailer. Filed as MongLong0214/commitlore#1029.
 *
 * Measured across those twelve: three were multi-commit branches and each lost its earlier
 * commits' records -- 4, 4 and 9 lines, 17 in all, with no note attached to any of them.
 *
 * `pnpm trailers` did go red, and only by luck: the dropped lines were still *in the text*, in a
 * paragraph that was no longer the last one. A squash whose body is written by hand drops the
 * records entirely, leaves nothing unparseable behind, and that check passes. This one asks the
 * question that is actually at stake -- is every record the branch carried reachable from the
 * merge commit -- and it is answered from the branch, not from the merge's own message.
 *
 * Detection, not prevention, and deliberately so: the merge is performed by a service this
 * repository does not run. `merge-pr.mjs` already recorded that choice -- "nothing forces a merge
 * through `pnpm merge`; `gh pr merge` still works. The post-merge `pnpm trailers HEAD~1..HEAD`
 * step in CI stays as the loud failure on any other path" (0da07459). This check does not dispute
 * the choice; it disputes that `pnpm trailers` is that failure. On 2026-09-15 it went red only
 * because the dropped lines happened to remain in the text in a paragraph that was no longer the
 * last one. A squash whose body is written by hand leaves nothing unparseable behind and that
 * check passes over the same loss.
 *
 * What this converts is a silent loss into a red `main` that names the lost lines, the commits
 * they came from, and the command that puts them back.
 *
 * Usage:  node scripts/verify-merge-preserved-records.mjs [<range>]
 *         default range `HEAD~1..HEAD`, which is what CI hands the trailer check beside it.
 */
import { execFileSync } from "node:child_process";

const range = process.argv[2]?.trim() || "HEAD~1..HEAD";

const git = (...args) => {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    return null;
  }
};

/**
 * The decision-context keys, because counting `Record-Id` alone misses the losses this check was
 * written for. The three merges `scripts/merge-pr.mjs` measured dropped 19, 30 and 83 *record
 * lines*; their branches predate `Record-Id` being emitted at all, so a check keyed on the id
 * passed every one of them. Measured here before this line was written, on 74c37fa: "0 record(s)
 * on the branch", against 83 lines that script's own header records as lost.
 */
const RECORD_KEYS = [
  "Limit", "Ruled-out", "Warn", "Unverified", "Blast", "Undo", "Certainty",
  "Record-Id", "Follows", "Supersedes", "Expires", "Evidence",
];
const isRecordLine = (line) => RECORD_KEYS.some((key) => line.startsWith(`${key}:`));

/** Record lines git will actually hand a reader, never a substring search of the message. */
const storedRecordIds = (sha) => {
  const body = git("log", "-1", "--format=%B", sha) ?? "";
  let parsed = "";
  try {
    parsed = execFileSync("git", ["interpret-trailers", "--parse"], { input: body, encoding: "utf8" });
  } catch {
    return new Set();
  }
  return new Set(parsed.split("\n").map((line) => line.trim()).filter(isRecordLine));
};

/**
 * The notes mirror counts, and it is where the sanctioned path puts them: `merge-pr.mjs` records
 * that its composition "does not collapse the per-commit trailer paragraphs, so git still stores
 * only the last one" (63ace4b6). `commitlore squash-preserve` attaches the rest as notes. So the
 * question here is reachability from the merge commit, not which of the two carries them.
 */
const notedRecordIds = (sha) => {
  const note = git("notes", "--ref=commitlore", "show", sha);
  if (note === null) return new Set();
  return new Set(note.split("\n").map((line) => line.trim()).filter(isRecordLine));
};

const out = (line) => process.stdout.write(`${line}\n`);

const commits = (git("rev-list", "--no-merges", range) ?? "").trim().split("\n").filter(Boolean);
if (commits.length === 0) {
  out(`verify-merge-preserved-records: no single-parent commit in ${range} — nothing a squash could have dropped.`);
  out("RESULT: PASS");
  process.exit(0);
}

let refused = 0;
let examined = 0;
for (const sha of commits) {
  const subject = (git("log", "-1", "--format=%s", sha) ?? "").trim();
  const pull = /\(#(\d+)\)\s*$/u.exec(subject)?.[1];
  // A commit that does not name a pull request was not composed by the forge, so there is no
  // branch behind it for this check to compare against.
  if (!pull) continue;

  // The branch's own commits survive only on the pull request's ref once the branch is deleted.
  const ref = `refs/merge-audit/${pull}`;
  if (git("fetch", "--no-tags", "--force", "origin", `+refs/pull/${pull}/head:${ref}`) === null) {
    // Fail open on the *question*: a checkout with no network cannot answer it, and refusing here
    // would make every offline run red about something it never read.
    out(`  #${pull}  could not fetch refs/pull/${pull}/head — not examined`);
    continue;
  }
  examined += 1;

  const branchCommits = (git("rev-list", `${sha}^..${ref}`) ?? "").trim().split("\n").filter(Boolean);
  const carried = new Map();
  for (const branchSha of branchCommits) {
    for (const line of storedRecordIds(branchSha)) if (!carried.has(line)) carried.set(line, branchSha);
  }
  const reachable = new Set([...storedRecordIds(sha), ...notedRecordIds(sha)]);
  const missing = [...carried].filter(([line]) => !reachable.has(line));
  if (missing.length === 0) {
    out(`  #${pull}  ${carried.size} record line(s) on the branch, all reachable from ${sha.slice(0, 8)}`);
    continue;
  }
  refused += 1;
  out("");
  out(`  ${sha.slice(0, 8)}  #${pull}  ${missing.length} record line(s) the branch carried and this merge does not keep:`);
  for (const [line, from] of missing.slice(0, 8)) out(`      ${from.slice(0, 8)}  ${line.slice(0, 96)}`);
  if (missing.length > 8) out(`      ... and ${missing.length - 8} more`);
  out("      The merge kept only the last paragraph, which is every squash's behaviour.");
  out(`      Restore:  git fetch origin '+refs/pull/${pull}/head:${ref}'`);
  out(`                git log -1 --format=%B <the commit above> | git interpret-trailers --parse`);
  out(`                git notes --ref=commitlore add -F - ${sha.slice(0, 8)}`);
  out(`                git push origin refs/notes/commitlore`);
}

out("");
out(`verify-merge-preserved-records: ${examined} merge commit(s) examined in ${range}.`);
if (refused > 0) {
  out("A merge performed with `gh pr merge` cannot preserve them; `pnpm merge` calls");
  out("`commitlore squash-preserve` first and is the only merge path here that can.");
  out(`RESULT: FAIL — ${refused} merge commit(s) dropped record lines their branch carried.`);
  process.exit(1);
}
out("RESULT: PASS");
