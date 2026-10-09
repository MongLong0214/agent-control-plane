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
 * A `(#N)` subject is not proof of a squash. A branch commit may end its subject with its own pull
 * request's number; 1e3ab0b7 ("test: pin the integrated migrations.ts ... (#1070)") was one, and
 * this check read it as #1070's squash and reported the records of 04412845, a commit made after
 * it, as dropped by it. A branch commit is an ancestor of its pull request's head, and a squash
 * normally is not. Ancestry alone is not the answer, though: a squash reaches the pull request's
 * head once the base is merged into the branch or the branch is rebased onto it. A squash is on
 * the base branch and a branch commit under squash merging never is. So a commit is skipped as a
 * branch commit only when both answers are positive: it is an ancestor of `refs/pull/N/head`, and
 * it is not on origin's `HEAD`. Every question this check cannot answer refuses: a remote that
 * cannot be asked, a ref that cannot be fetched, an ancestry lookup that fails. An unanswered
 * question never reads as "a branch commit, so skip". One negative answer is not a failure: when
 * the remote answers that it has no `refs/pull/N/head`, the `(#N)` names an issue, so there is no
 * branch to compare against, and the commit is not examined.
 *
 * Usage:  node scripts/verify-merge-preserved-records.mjs [<range>]
 *         default range `HEAD~1..HEAD`, which is what CI hands the trailer check beside it.
 */
import { execFileSync, spawnSync } from "node:child_process";

const range = process.argv[2]?.trim() || "HEAD~1..HEAD";

const git = (...args) => {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    return null;
  }
};

/**
 * Whether origin has `name`: "present", or "absent" only on `ls-remote --exit-code`'s exit 2, which
 * git gives when the remote answered and no ref matched. Any other exit status, or output that is not
 * exactly that one ref, is null: the remote was not asked successfully, which is never "absent".
 */
const listRemoteRef = (name) => {
  const { status, stdout } = spawnSync("git", ["ls-remote", "--exit-code", "origin", name], {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
  });
  if (status === 2) return "absent";
  if (status !== 0) return null;
  const lines = (stdout ?? "").trim().split("\n");
  return lines.length === 1 && /^[0-9a-f]{40,64}\t/u.test(lines[0]) && lines[0].endsWith(`\t${name}`)
    ? "present"
    : null;
};

/**
 * `git merge-base --is-ancestor`, answered: true or false only on exit 0 or 1. A failed lookup (a
 * ref that names no commit, a missing object) exits 128 and is null, which is never read as either.
 */
const isAncestor = (sha, ref) => {
  const { status } = spawnSync("git", ["merge-base", "--is-ancestor", sha, ref], { stdio: "ignore" });
  return status === 0 ? true : status === 1 ? false : null;
};

/** Origin's default branch, fetched once; null when it cannot be read. */
let base;
const baseRef = () => {
  if (base === undefined) {
    base = git("fetch", "--no-tags", "--force", "origin", "+HEAD:refs/merge-audit/base") === null
      ? null
      : "refs/merge-audit/base";
  }
  return base;
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
let unanswered = 0;
let examined = 0;
for (const sha of commits) {
  const subject = (git("log", "-1", "--format=%s", sha) ?? "").trim();
  const pull = /\(#(\d+)\)\s*$/u.exec(subject)?.[1];
  // A commit that does not name a pull request was not composed by the forge, so there is no
  // branch behind it for this check to compare against.
  if (!pull) continue;

  // The branch's own commits survive only on the pull request's ref once the branch is deleted.
  const ref = `refs/merge-audit/${pull}`;
  const listed = listRemoteRef(`refs/pull/${pull}/head`);
  if (listed === "absent") {
    // The remote answered: no pull request ref, so `(#N)` names an issue and no branch stands behind it.
    out(`  ${sha.slice(0, 8)}  #${pull}  not examined (no PR #${pull} on the remote)`);
    continue;
  }
  if (listed === null) {
    // Fail closed: a remote that could not be asked has not said the pull request is absent.
    unanswered += 1;
    out(`  ${sha.slice(0, 8)}  #${pull}  could not ask the remote for refs/pull/${pull}/head — refused`);
    continue;
  }
  if (git("fetch", "--no-tags", "--force", "origin", `+refs/pull/${pull}/head:${ref}`) === null) {
    // Fail closed: the ref was listed, and what this commit dropped cannot be answered without it.
    unanswered += 1;
    out(`  ${sha.slice(0, 8)}  #${pull}  could not fetch refs/pull/${pull}/head — refused, not examined`);
    continue;
  }
  const onBranch = isAncestor(sha, ref);
  if (onBranch === null) {
    unanswered += 1;
    out(`  ${sha.slice(0, 8)}  #${pull}  could not tell whether it is an ancestor of refs/pull/${pull}/head — refused`);
    continue;
  }
  if (onBranch) {
    // An ancestor of the head is a branch commit unless it is on the base, which is where a squash
    // lands and from where the base merged into, or rebased under, the branch brings it.
    const baseTip = baseRef();
    const onBase = baseTip === null ? null : isAncestor(sha, baseTip);
    if (onBase === null) {
      unanswered += 1;
      out(`  ${sha.slice(0, 8)}  #${pull}  an ancestor of refs/pull/${pull}/head, and origin's HEAD could not be read to tell it from a squash — refused`);
      continue;
    }
    if (!onBase) {
      out(`  ${sha.slice(0, 8)}  skipped: branch commit of #${pull}, not a squash (an ancestor of refs/pull/${pull}/head, not on origin's HEAD)`);
      continue;
    }
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
if (refused > 0 || unanswered > 0) {
  if (refused > 0) {
    out("A merge performed with `gh pr merge` cannot preserve them; `pnpm merge` calls");
    out("`commitlore squash-preserve` first and is the only merge path here that can.");
  }
  const reasons = [
    ...(refused > 0 ? [`${refused} merge commit(s) dropped record lines their branch carried`] : []),
    ...(unanswered > 0 ? [`${unanswered} commit(s) naming a pull request could not be checked`] : []),
  ];
  out(`RESULT: FAIL — ${reasons.join("; ")}.`);
  process.exit(1);
}
out("RESULT: PASS");
