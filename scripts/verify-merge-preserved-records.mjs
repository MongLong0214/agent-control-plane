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
 * Which commits are merges, and what each one's branch carried, comes from GitHub, not from a
 * guess about ancestry. A `(#N)` subject is not proof of a squash: 1e3ab0b7 ("test: pin the
 * integrated migrations.ts ... (#1070)") was an ordinary commit on #1070's branch, and reading it
 * as #1070's squash reported the records of 04412845, a commit made after it, as dropped by it.
 * Ancestry cannot tell them apart either (narrow review 4): a squash on a release base becomes an
 * ancestor of the pull request's head once that base is merged into the branch, and the movable
 * `refs/pull/N/head` can be pushed or force-moved after the merge, which changed the verdict both
 * ways. So, for each single-parent `(#N)` commit S:
 *
 *   * `GET /repos/{repo}/pulls/N`. 404: N is not a pull request (an issue), nothing to compare —
 *     not examined. Any other failure refuses.
 *   * merged, and `merge_commit_sha` is S: S is #N's squash. Its branch is read up to the head it
 *     squashed, established from what the merge preserved rather than taken from the API: the API's
 *     `head.sha` is accepted only when merging it into S's parent gives exactly S's tree, and every
 *     commit S's records say they were inherited from (`Provenance: inherited <sha>`) lies between
 *     S's parent and it. Otherwise S is refused as unverifiable.
 *   * otherwise, S in #N's complete commit list (every page, and as many as the pull request says
 *     it has): a branch commit of #N — not examined, and said so.
 *   * otherwise S names #N but is neither its squash nor its commit: attribution failed, refused.
 *
 * Every lookup that fails refuses — the range, a message, the trailer parser, the notes, a fetch,
 * the API, a page, a parse. None of them reads as empty evidence.
 *
 * The API is `gh api`; `ACP_MERGE_RECORDS_GH` names another executable that answers the same calls,
 * which is how the tests run it offline. The repository is `GITHUB_REPOSITORY`, or origin's GitHub
 * URL.
 *
 * Usage:  node scripts/verify-merge-preserved-records.mjs [<range>]
 *         default range `HEAD~1..HEAD`, which is what CI hands the trailer check beside it.
 */
import { spawnSync } from "node:child_process";

const range = process.argv[2]?.trim() || "HEAD~1..HEAD";

/** A lookup that failed: it refuses the commit it was asked about, never answers it emptily. */
class Unanswered extends Error {}

/** A git call answered on exit 0, or a refusal naming what could not be read. */
const git = (what, args, input) => {
  const result = spawnSync("git", args, {
    encoding: "utf8", input, maxBuffer: 256 * 1024 * 1024, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  if (result.status !== 0) throw new Unanswered(`could not read ${what}`);
  return result.stdout;
};

/** `git merge-base --is-ancestor`: true or false only on exit 0 or 1, otherwise a refusal. */
const isAncestor = (sha, of) => {
  const { status } = spawnSync("git", ["merge-base", "--is-ancestor", sha, of], { stdio: "ignore" });
  if (status === 0) return true;
  if (status === 1) return false;
  throw new Unanswered(`could not tell whether ${sha.slice(0, 8)} is an ancestor of ${of.slice(0, 8)}`);
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

/** Trailer lines git will actually hand a reader, never a substring search of the message. */
const storedTrailers = (sha) => {
  const body = git(`the message of ${sha.slice(0, 8)}`, ["log", "-1", "--format=%B", sha]);
  const parsed = git(`the trailers of ${sha.slice(0, 8)}`, ["interpret-trailers", "--parse"], body);
  return parsed.split("\n").map((line) => line.trim()).filter(Boolean);
};
const storedRecordIds = (sha) => new Set(storedTrailers(sha).filter(isRecordLine));

/**
 * The notes mirror counts, and it is where the sanctioned path puts them: `merge-pr.mjs` records
 * that its composition "does not collapse the per-commit trailer paragraphs, so git still stores
 * only the last one" (63ace4b6). `commitlore squash-preserve` attaches the rest as notes. So the
 * question here is reachability from the merge commit, not which of the two carries them. A
 * checkout with no notes ref has no notes; one whose notes cannot be listed or read refuses.
 */
let notes;
const noteLines = (sha) => {
  if (notes === undefined) {
    notes = new Map();
    const exists = spawnSync("git", ["rev-parse", "--quiet", "--verify", "refs/notes/commitlore"], { stdio: "ignore" }).status;
    if (exists === 0) {
      for (const line of git("the commitlore notes", ["notes", "--ref=commitlore", "list"]).split("\n").filter(Boolean)) {
        const [blob, object] = line.split(" ");
        if (!/^[0-9a-f]{40,64}$/u.test(blob ?? "") || !/^[0-9a-f]{40,64}$/u.test(object ?? "")) {
          throw new Unanswered("could not parse the commitlore notes list");
        }
        notes.set(object, blob);
      }
    } else if (exists !== 1) {
      throw new Unanswered("could not tell whether a commitlore notes ref exists");
    }
  }
  const blob = notes.get(sha);
  if (blob === undefined) return [];
  return git(`the note on ${sha.slice(0, 8)}`, ["cat-file", "blob", blob]).split("\n").map((line) => line.trim()).filter(Boolean);
};
const notedRecordIds = (sha) => new Set(noteLines(sha).filter(isRecordLine));

/** `owner/name`, from the Actions environment or origin's GitHub URL. */
let repository;
const repo = () => {
  if (repository === undefined) {
    const named = process.env["GITHUB_REPOSITORY"]?.trim();
    const url = named ? "" : git("origin's URL", ["remote", "get-url", "origin"]).trim();
    const fromUrl = /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/u.exec(url)?.[1];
    repository = named || fromUrl;
    if (!repository || !/^[^/\s]+\/[^/\s]+$/u.test(repository)) throw new Unanswered("could not tell which GitHub repository this is");
  }
  return repository;
};

const GH = process.env["ACP_MERGE_RECORDS_GH"]?.trim() || "gh";

/** `GET /repos/{repo}/pulls/N`: the pull request, or "absent" on 404; any other answer refuses. */
const pullRequest = (pull) => {
  const result = spawnSync(GH, ["api", "--include", `repos/${repo()}/pulls/${pull}`], {
    encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  });
  const out = result.stdout ?? "";
  const status = /^HTTP\/[0-9.]+ (\d{3})/u.exec(out)?.[1];
  if (status === "404") return "absent";
  if (result.status !== 0 || status !== "200") {
    throw new Unanswered(`could not read pull request #${pull} from GitHub (${status ? `HTTP ${status}` : `exit ${result.status ?? result.signal}`})`);
  }
  const separator = /\r?\n\r?\n/u.exec(out);
  let body;
  try {
    body = JSON.parse(separator ? out.slice(separator.index + separator[0].length) : "");
  } catch {
    throw new Unanswered(`could not parse pull request #${pull} from GitHub`);
  }
  const sha = (value) => typeof value === "string" && /^[0-9a-f]{40,64}$/u.test(value);
  if (typeof body !== "object" || body === null || typeof body.merged !== "boolean" ||
      !(body.merge_commit_sha === null || sha(body.merge_commit_sha)) || !sha(body.head?.sha) ||
      !Number.isSafeInteger(body.commits) || body.commits < 0) {
    throw new Unanswered(`pull request #${pull} from GitHub is missing what this check reads`);
  }
  return { merged: body.merged, mergeCommit: body.merge_commit_sha, head: body.head.sha, commits: body.commits };
};

/** Every commit of #N, every page; refused unless it is as many as the pull request says it has. */
const pullCommits = (pull, expected) => {
  const result = spawnSync(GH, ["api", "--paginate", "--jq", ".[].sha", `repos/${repo()}/pulls/${pull}/commits`], {
    encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) throw new Unanswered(`could not list the commits of #${pull} from GitHub (exit ${result.status ?? result.signal})`);
  const shas = (result.stdout ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
  if (shas.some((line) => !/^[0-9a-f]{40,64}$/u.test(line))) throw new Unanswered(`could not parse the commits of #${pull} from GitHub`);
  if (shas.length !== expected) {
    throw new Unanswered(`GitHub listed ${shas.length} commit(s) of #${pull}, which says it has ${expected}; the list is incomplete`);
  }
  return new Set(shas);
};

/** A commit that exists here, fetched from origin when it does not; a refusal when it cannot be had. */
const haveCommit = (sha, what) => {
  const present = () => spawnSync("git", ["cat-file", "-e", `${sha}^{commit}`], { stdio: "ignore" }).status === 0;
  if (present()) return;
  spawnSync("git", ["fetch", "--quiet", "--no-tags", "origin", sha], { stdio: "ignore" });
  if (!present()) throw new Unanswered(`could not fetch ${what} ${sha.slice(0, 8)}`);
};

/**
 * The head #N's squash S was made from, or a refusal. The API's `head.sha` is a claim; S itself and
 * the records it carries are what the merge preserved. Merging the head into S's parent must give
 * exactly S's tree, and every commit S's records name as their source must lie between S's parent
 * and the head.
 */
const mergedHead = (squash, pull, claimed) => {
  haveCommit(claimed, `the head GitHub names for #${pull},`);
  // A squash is made from a head that does not contain it; one that does (a head moved onto the
  // squash after the merge) would trivially reproduce its tree.
  if (isAncestor(squash, claimed)) {
    throw new Unanswered(`#${pull}'s merge-time head cannot be established: ${claimed.slice(0, 8)}, the head GitHub names, already contains ${squash.slice(0, 8)}`);
  }
  const parent = git(`the parent of ${squash.slice(0, 8)}`, ["rev-parse", "--verify", `${squash}^1`]).trim();
  const merged = spawnSync("git", ["merge-tree", "--write-tree", parent, claimed], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const tree = git(`the tree of ${squash.slice(0, 8)}`, ["rev-parse", "--verify", `${squash}^{tree}`]).trim();
  if (merged.status !== 0 || (merged.stdout ?? "").split("\n")[0]?.trim() !== tree) {
    throw new Unanswered(`#${pull}'s merge-time head cannot be established: ${claimed.slice(0, 8)}, the head GitHub names, does not merge into ${parent.slice(0, 8)} as ${squash.slice(0, 8)}'s tree`);
  }
  const sources = [...storedTrailers(squash), ...noteLines(squash)]
    .map((line) => /^Provenance:\s*inherited\s+([0-9a-f]{40,64})\s*$/u.exec(line)?.[1])
    .filter(Boolean);
  for (const source of new Set(sources)) {
    if (!isAncestor(source, claimed) || isAncestor(source, parent)) {
      throw new Unanswered(`#${pull}'s merge-time head cannot be established: ${squash.slice(0, 8)} inherits records from ${source.slice(0, 8)}, which is not between ${parent.slice(0, 8)} and ${claimed.slice(0, 8)}`);
    }
  }
  return { parent, head: claimed };
};

const out = (line) => process.stdout.write(`${line}\n`);

let commits;
try {
  commits = git(`the range ${range}`, ["rev-list", "--no-merges", range]).trim().split("\n").filter(Boolean);
} catch (error) {
  out(`verify-merge-preserved-records: ${error.message} — refused.`);
  out(`RESULT: FAIL — the range ${range} could not be read.`);
  process.exit(1);
}
if (commits.length === 0) {
  out(`verify-merge-preserved-records: no single-parent commit in ${range} — nothing a squash could have dropped.`);
  out("RESULT: PASS");
  process.exit(0);
}

let refused = 0;
let unanswered = 0;
let examined = 0;
for (const sha of commits) {
  const short = sha.slice(0, 8);
  let pull;
  try {
    const subject = git(`the subject of ${short}`, ["log", "-1", "--format=%s", sha]).trim();
    pull = /\(#(\d+)\)\s*$/u.exec(subject)?.[1];
    // A commit that does not name a pull request was not composed by the forge, so there is no
    // branch behind it for this check to compare against.
    if (!pull) continue;

    const pr = pullRequest(pull);
    if (pr === "absent") {
      out(`  ${short}  #${pull}  not examined (no PR #${pull})`);
      continue;
    }
    if (!(pr.merged && pr.mergeCommit === sha)) {
      if (!pullCommits(pull, pr.commits).has(sha)) {
        throw new Unanswered(`names #${pull} but is neither its squash nor one of its ${pr.commits} commit(s) — attribution failed`);
      }
      out(`  ${short}  skipped: branch commit of #${pull}, not a squash (one of #${pull}'s commits; #${pull} ${pr.merged ? `merged as ${pr.mergeCommit.slice(0, 8)}` : "is not merged"})`);
      continue;
    }

    const { parent, head } = mergedHead(sha, pull, pr.head);
    examined += 1;
    const branchCommits = git(`#${pull}'s branch`, ["rev-list", `${parent}..${head}`]).trim().split("\n").filter(Boolean);
    const carried = new Map();
    for (const branchSha of branchCommits) {
      for (const line of storedRecordIds(branchSha)) if (!carried.has(line)) carried.set(line, branchSha);
    }
    const reachable = new Set([...storedRecordIds(sha), ...notedRecordIds(sha)]);
    const missing = [...carried].filter(([line]) => !reachable.has(line));
    if (missing.length === 0) {
      out(`  #${pull}  ${carried.size} record line(s) on the branch, all reachable from ${short} (the branch read up to its merge-time head ${head.slice(0, 8)})`);
      continue;
    }
    refused += 1;
    out("");
    out(`  ${short}  #${pull}  ${missing.length} record line(s) the branch carried and this merge does not keep (the branch read up to its merge-time head ${head.slice(0, 8)}):`);
    for (const [line, from] of missing.slice(0, 8)) out(`      ${from.slice(0, 8)}  ${line.slice(0, 96)}`);
    if (missing.length > 8) out(`      ... and ${missing.length - 8} more`);
    out("      The merge kept only the last paragraph, which is every squash's behaviour.");
    out(`      Restore:  git fetch origin ${head}`);
    out(`                git log -1 --format=%B <the commit above> | git interpret-trailers --parse`);
    out(`                git notes --ref=commitlore add -F - ${short}`);
    out(`                git push origin refs/notes/commitlore`);
  } catch (error) {
    if (!(error instanceof Unanswered)) throw error;
    unanswered += 1;
    out(`  ${short}  ${pull ? `#${pull}  ` : ""}refused: ${error.message}`);
  }
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
    ...(unanswered > 0 ? [`${unanswered} commit(s) could not be checked`] : []),
  ];
  out(`RESULT: FAIL — ${reasons.join("; ")}.`);
  process.exit(1);
}
out("RESULT: PASS");
