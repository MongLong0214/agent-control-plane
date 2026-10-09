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
 * the choice; it disputes that `pnpm trailers` is that failure.
 *
 * What this converts is a silent loss into a red `main` that names the lost lines, the commits
 * they came from, and the command that puts them back.
 *
 * Which commit is a squash comes from GitHub, and only from the two facts GitHub records about the
 * merge itself. A `(#N)` subject is not proof: 1e3ab0b7 ("test: pin the integrated migrations.ts
 * ... (#1070)") was an ordinary commit on #1070's branch, and reading it as #1070's squash reported
 * the records of 04412845, a commit made after it, as dropped by it. Ancestry could not tell them
 * apart (narrow review 4), and neither could #N's commit list, whose completeness a duplicated page
 * faked (narrow review 5). So, for each single-parent `(#N)` commit S, `GET /repos/{repo}/pulls/N`:
 *
 *   * `merged`, and `merge_commit_sha` is S: S is #N's squash, and its records are checked.
 *   * a valid answer that is anything else -- not merged, or merged as another commit: S is
 *     attribution non-target, printed as that. It is not a "records preserved" pass.
 *   * 404 with GitHub's own not-found body: N is not a pull request (an issue), not examined.
 *     A 404 whose body is anything else, every other status, a failed call and a body missing what
 *     this reads all refuse.
 *
 * A squash's branch is read up to the head it was merged from, and that head is the one its own
 * message names: one `Merged-Head: <full sha>` line, which `merge-pr.mjs` writes from the head whose
 * required CI it checked and hands GitHub as `--match-head-commit`, so GitHub merged exactly it.
 * The pull request's `head.sha` is not consulted: it moves after the merge, and every way of
 * corroborating it from the squash -- the tree it reproduces, the `Provenance: inherited` sources
 * it contains -- was shown to accept a rewritten or rolled-back head (narrow review 5). A squash
 * whose message carries no such line, more than one, a malformed one, or one naming a commit that
 * cannot be fetched and read, is refused as unverifiable. Nothing else a historical squash
 * preserved names its head (GitHub's composed body does not; `Provenance: inherited` names record
 * sources, not the boundary), so a historical squash without the line is refused too.
 *
 * Every lookup that fails refuses -- the range, a message, the trailer parser, the notes, a fetch,
 * the API, a parse. None of them reads as empty evidence.
 *
 * The API is `gh api`; `ACP_MERGE_RECORDS_GH` names another executable that answers the same call,
 * which is how the tests run it offline. The repository is `GITHUB_REPOSITORY`, or origin's GitHub
 * URL. `merge-pr.mjs` imports `pullRequest`, `examineSquash` and `mergedHeadIn` to read its own merge
 * back the way this check will.
 *
 * Usage:  node scripts/verify-merge-preserved-records.mjs [<range>]
 *         default range `HEAD~1..HEAD`, which is what CI hands the trailer check beside it.
 */
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** A lookup that failed: it refuses the commit it was asked about, never answers it emptily. */
export class Unanswered extends Error {}

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

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const isSha = (value) => typeof value === "string" && SHA.test(value);

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
    const listed = new Map();
    const exists = spawnSync("git", ["rev-parse", "--quiet", "--verify", "refs/notes/commitlore"], { stdio: "ignore" }).status;
    if (exists === 0) {
      for (const line of git("the commitlore notes", ["notes", "--ref=commitlore", "list"]).split("\n").filter(Boolean)) {
        const [blob, object] = line.split(" ");
        if (!isSha(blob) || !isSha(object)) throw new Unanswered("could not parse the commitlore notes list");
        listed.set(object, blob);
      }
    } else if (exists !== 1) {
      throw new Unanswered("could not tell whether a commitlore notes ref exists");
    }
    notes = listed;
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
    const found = named || fromUrl;
    if (!found || !/^[^/\s]+\/[^/\s]+$/u.test(found)) throw new Unanswered("could not tell which GitHub repository this is");
    repository = found;
  }
  return repository;
};

/**
 * GitHub's own answer that nothing is at the path: `{"message":"Not Found",
 * "documentation_url":..., "status":"404"}`. A 404 is read as "no such pull request" only with
 * this body; a proxy's HTML page, an empty body or anything else is not an answer about #N.
 */
const isNotFoundBody = (body) =>
  typeof body === "object" && body !== null && body.message === "Not Found" &&
  Object.keys(body).every((key) => key === "message" || key === "documentation_url" || key === "status") &&
  (body.documentation_url === undefined || typeof body.documentation_url === "string") &&
  (body.status === undefined || body.status === "404");

/**
 * `GET /repos/{repo}/pulls/N`: "absent" on GitHub's own not-found answer, otherwise `merged` and
 * `merge_commit_sha` from a body that carries both validly. Anything else refuses.
 */
export const pullRequest = (pull) => {
  const gh = process.env["ACP_MERGE_RECORDS_GH"]?.trim() || "gh";
  const result = spawnSync(gh, ["api", "--include", `repos/${repo()}/pulls/${pull}`], {
    encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  });
  const out = result.stdout ?? "";
  const status = /^HTTP\/[0-9.]+ (\d{3})/u.exec(out)?.[1];
  const separator = /\r?\n\r?\n/u.exec(out);
  let body;
  try {
    body = separator ? JSON.parse(out.slice(separator.index + separator[0].length)) : undefined;
  } catch {
    body = undefined;
  }
  if (status === "404") {
    // `gh api` exits 1 on any HTTP error status, so a 404 that exited otherwise is not that answer.
    if (result.status !== 1 || !isNotFoundBody(body)) {
      throw new Unanswered(`GitHub answered 404 for #${pull} without its not-found body, which is not an answer that #${pull} is no pull request`);
    }
    return "absent";
  }
  if (result.status !== 0 || status !== "200") {
    throw new Unanswered(`could not read pull request #${pull} from GitHub (${status ? `HTTP ${status}` : `exit ${result.status ?? result.signal}`})`);
  }
  if (body === undefined) throw new Unanswered(`could not parse pull request #${pull} from GitHub`);
  if (typeof body !== "object" || body === null || body.number !== Number(pull) ||
      typeof body.merged !== "boolean" || !(body.merge_commit_sha === null || isSha(body.merge_commit_sha)) ||
      (body.merged && !isSha(body.merge_commit_sha))) {
    throw new Unanswered(`pull request #${pull} from GitHub is missing what this check reads`);
  }
  return { merged: body.merged, mergeCommit: body.merge_commit_sha };
};

/** Any line declaring the key, in any case or spacing: each one counts against "exactly one". */
const DECLARES_MERGED_HEAD = /^\s*merged-head\s*:/iu;
const MERGED_HEAD = /^Merged-Head: ([0-9a-f]{40}|[0-9a-f]{64})$/u;

/**
 * The head `message` says it was merged from: exactly one `Merged-Head: <full sha>` line, or a
 * refusal. Missing, duplicate, conflicting and malformed are all "unverifiable", never a guess.
 */
export const mergedHeadIn = (message, what) => {
  const declared = message.split("\n").filter((line) => DECLARES_MERGED_HEAD.test(line));
  if (declared.length === 0) {
    throw new Unanswered(`${what} carries no Merged-Head trailer, and nothing it preserved establishes the head it was merged from — unverifiable`);
  }
  if (declared.length > 1) {
    const kind = new Set(declared.map((line) => line.trim())).size > 1 ? "conflicting" : "duplicate";
    throw new Unanswered(`${what} carries ${declared.length} ${kind} Merged-Head trailers where exactly one names its merge-time head — unverifiable`);
  }
  const head = MERGED_HEAD.exec(declared[0])?.[1];
  if (head === undefined) throw new Unanswered(`${what}'s Merged-Head trailer is not one full commit sha — unverifiable`);
  return head;
};

/** A commit that exists here, fetched from origin when it does not; a refusal when it cannot be had. */
const haveCommit = (sha, what) => {
  const present = () => spawnSync("git", ["cat-file", "-e", `${sha}^{commit}`], { stdio: "ignore" }).status === 0;
  if (present()) return;
  spawnSync("git", ["fetch", "--quiet", "--no-tags", "origin", sha], { stdio: "ignore" });
  if (!present()) throw new Unanswered(`could not fetch or read ${what} ${sha.slice(0, 8)}, as a commit — unverifiable`);
};

/**
 * #N's squash S against its branch, read from S's parent up to the head S's `Merged-Head` names:
 * every record line that branch carried, and those S keeps neither as a trailer nor in its note.
 */
export const examineSquash = (squash, pull) => {
  const short = squash.slice(0, 8);
  const head = mergedHeadIn(git(`the message of ${short}`, ["log", "-1", "--format=%B", squash]), short);
  haveCommit(head, "the commit its Merged-Head trailer names,");
  // A squash is made from a head with commits its parent lacks; a trailer naming one its parent
  // already has names no branch, and would pass an empty one. (A head containing the squash needs
  // no check: the squash's message names it, so it cannot descend from the squash.)
  const parent = git(`the parent of ${short}`, ["rev-parse", "--verify", `${squash}^1`]).trim();
  if (isAncestor(head, parent)) {
    throw new Unanswered(`${short}'s Merged-Head ${head.slice(0, 8)} is already in its parent ${parent.slice(0, 8)}, so it names no branch — unverifiable`);
  }
  const branchCommits = git(`#${pull}'s branch`, ["rev-list", `${parent}..${head}`]).trim().split("\n").filter(Boolean);
  const carried = new Map();
  for (const branchSha of branchCommits) {
    for (const line of storedRecordIds(branchSha)) if (!carried.has(line)) carried.set(line, branchSha);
  }
  const reachable = new Set([...storedRecordIds(squash), ...notedRecordIds(squash)]);
  const missing = [...carried].filter(([line]) => !reachable.has(line));
  return { head, parent, carried, missing };
};

const out = (line) => process.stdout.write(`${line}\n`);

const main = () => {
  const range = process.argv[2]?.trim() || "HEAD~1..HEAD";
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
  let nonTarget = 0;
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
        nonTarget += 1;
        out(`  ${short}  #${pull}  attribution non-target (not PR #${pull}'s squash: #${pull} ${pr.merged ? `merged as ${pr.mergeCommit.slice(0, 8)}` : "is not merged"}); its records are not compared`);
        continue;
      }

      const { head, carried, missing } = examineSquash(sha, pull);
      examined += 1;
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
  out(`verify-merge-preserved-records: ${examined} merge commit(s) examined, ${nonTarget} attribution non-target, in ${range}.`);
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
};

// Run as a script; imported by `merge-pr.mjs` for its read-back, where nothing here runs on import.
const invoked = (() => {
  try {
    return process.argv[1] !== undefined && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
})();
if (invoked) main();
