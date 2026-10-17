/**
 * The commit message the daemon states when it squashes an approved pull request.
 *
 * Until this module existed the merge PUT carried `{ sha, merge_method }` and nothing more, so
 * GitHub composed the squash message itself from the branch's commit messages — the repository is
 * configured `squash_merge_commit_message = COMMIT_MESSAGES`. Whatever a branch commit said landed
 * verbatim in a history nobody may rewrite, and two open branches carry a session-identifying URL.
 *
 * Composing the message here buys that exclusion and takes on the opposite risk in the same
 * breath. `COMMIT_MESSAGES` was set precisely because composing a merge body by hand had already
 * dropped 129 of 132 CommitLore record lines across three merges, while a check reported those
 * merges clean. So this module is built to *preserve by default and exclude by name*: everything
 * GitHub would have written survives unless a rule below removes it, and the rules remove nothing
 * but the identifier. A filter phrased the other way round — keep the known-good keys — can only
 * ever be as complete as its list, and the list is always a guess about next month.
 *
 * Two rules, both operating on the message content rather than on trailer structure:
 *
 *   1. Whole-line removal by the *identity* of the key. Not by its shape: CommitLore's `commit-msg`
 *      hook accepts "a key from SPEC §3 or `X-<Name>`", and the line to remove is written today as
 *      `X-Claude-Session:` — which *is* an `X-<Name>`. A rule phrased as "keep SPEC §3 and `X-*`"
 *      keeps the one line it most needs to drop.
 *
 *   2. Redaction of the identifier wherever it still appears. The metadata is not always a trailer:
 *      one branch writes `Claude-Session: <url>` as an ordinary closing prose line precisely
 *      because the hook refuses it as a trailer key, and `git interpret-trailers --parse` returns
 *      nothing for that message. Rule 1 already catches that shape, because it reads lines rather
 *      than the parsed trailer block. Rule 2 is the backstop for a key nobody enumerated: it
 *      removes the identifier and leaves the prose, so an unlisted key cannot become a leak and
 *      cannot become a silent deletion either.
 *
 * Rule 2 runs after rule 1 and never deletes a line, which is what keeps the two rules from
 * combining into a way to lose a record. `SESSION_METADATA_KEYS` is asserted disjoint from the
 * repository's own record keys in `tests/unit/merge-commit-message.test.ts`; that assertion, not a
 * second copy of the record list, is what stops this file from eating a record.
 *
 * The load-bearing assumption was measured against the real merge endpoint on 2026-09-08:
 * a supplied `commit_message` replaces GitHub's composition under this configuration. The reading
 * came from a different, throwaway private repository configured like this one:
 * `squash_merge_commit_message = COMMIT_MESSAGES` and
 * `squash_merge_commit_title = COMMIT_OR_PR_TITLE`. Its two-commit branch carried distinct body
 * markers, record lines, and a session reference in both trailer and prose form; the merge supplied
 * `commit_title` and `commit_message`. A marker census of the published squash found the supplied
 * body present, both branch bodies absent, both forms of the session reference absent, and record
 * lines present only because the supplied body carried them. The repository was deleted after the
 * reading. This is evidence about the API under that configuration, not about any merge in this
 * repository. The daemon was down when these branches merged through the repository's manual path;
 * its composer governs the merges it performs once deployed.
 */

import { type Decision, allow, deny, isAcpError } from "../core/errors.ts";
import { ReasonCode } from "../core/reason-codes.ts";
import {
  MERGE_RECORDS_GATE,
  PRESERVATION_TIMEOUT_MS,
  type SquashRecordPreservation,
  squashRecordPreservation,
} from "../git/squash-records.ts";

/** One branch commit, as GitHub's list-commits endpoint reports it. */
export interface BranchCommitMessage {
  readonly sha: string;
  readonly message: string;
}

/**
 * Keys whose entire line is agent, session or model metadata.
 *
 * Deliberately short and literal. Each is a key whose whole purpose is to name a session or the
 * agent that held it, so removing the line loses nothing else. `Claude-Session` and
 * `X-Claude-Session` are the two shapes measured on this repository's open branches; the rest are
 * the same construction for the other agents this daemon launches (`ACP_CODEX_BINARY`,
 * `ACP_GROK_BINARY`) and the generic form, so that the next tool to adopt the convention is
 * already covered.
 *
 * Not included, on purpose:
 *   - `Co-Authored-By`, which is a legitimate key naming humans. Excluding it by identity would
 *     delete real co-authors to remove an agent, and the agent's session URL — the thing that must
 *     not reach `main` — is caught by rule 2 wherever it sits.
 *   - `Model` and similar single words, which are ordinary sentence openings in prose. Removing
 *     whole lines on a word that common trades a leak for a silent deletion.
 */
export const SESSION_METADATA_KEYS: readonly string[] = Object.freeze([
  "Claude-Session",
  "X-Claude-Session",
  "Codex-Session",
  "X-Codex-Session",
  "Grok-Session",
  "X-Grok-Session",
  "Agent-Session",
  "X-Agent-Session",
]);

/** What rule 2 leaves behind, so a reader of `main` can tell removal from an author's omission. */
export const REDACTED_SESSION_REFERENCE = "[session reference removed]";

/**
 * A URL naming a session. Anchored on the `session_` path segment and a long opaque id rather than
 * on a host, so a second product's console is covered and an ordinary sentence about a
 * `session_id` column is not: sixteen characters of base62 is not something prose contains.
 */
const SESSION_REFERENCE = /https?:\/\/[^\s<>()[\]]*\/session_[A-Za-z0-9_-]{16,}/gi;

const metadataLine = new RegExp(`^\\s*(?:${SESSION_METADATA_KEYS.join("|")})\\s*:`, "i");

/**
 * GitHub's own `COMMIT_MESSAGES` composition, reproduced.
 *
 * Anchored to bytes already on `main` rather than to a reading of the documentation: `git log -1
 * --format=%b d0d885fb41fd8d916d2f5e54bfd50b3bd759dd4c` shows a two-commit squash as `* <subject>`,
 * a blank line, the body, and the next commit's contribution after a blank line. A single-commit
 * squash carries the body alone — its subject becomes the commit title instead.
 *
 * Reproducing it matters because this is the baseline every preservation claim is measured
 * against. A composition that quietly differs makes "nothing was lost" a statement about the wrong
 * thing.
 */
export const githubSquashCommitMessage = (commits: readonly BranchCommitMessage[]): string => {
  if (commits.length === 1) {
    const [subject, ...body] = commits[0]!.message.split("\n");
    void subject;
    return body.join("\n").trim();
  }
  return commits
    .map((commit) => {
      const [subject, ...body] = commit.message.split("\n");
      const rest = body.join("\n").trim();
      return rest === "" ? `* ${subject}` : `* ${subject}\n\n${rest}`;
    })
    .join("\n\n");
};

/**
 * Both rules, applied to any message.
 *
 * Returns the input unchanged when there was nothing to remove. That is not an optimisation: it is
 * the property that makes this safe to run on every squash, because a branch that carries no
 * metadata gets exactly the message GitHub would have written, byte for byte. Blank-line
 * normalisation only runs when a line was actually dropped, so it can never reshape a clean
 * message that merely happened to contain a wide gap.
 */
export const withoutSessionMetadata = (message: string): string => {
  const lines = message.split("\n");
  const kept = lines.filter((line) => !metadataLine.test(line));
  const redacted = kept.map((line) => line.replace(SESSION_REFERENCE, REDACTED_SESSION_REFERENCE));

  if (kept.length === lines.length) {
    // Nothing was removed. Only rule 2 can have fired, and it never changes the line count, so the
    // paragraph structure is untouched and must be handed back as-is.
    return redacted.join("\n");
  }

  // A removed line can leave a paragraph empty, which would read as an accidental gap. Collapsing
  // the run cannot join two paragraphs — one blank line always remains — so a record that was in
  // the final block stays in the final block.
  return redacted
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s+$/, "");
};

/** A full commit sha, the only `Merged-Head` value `verify-merge-preserved-records.mjs` accepts. */
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

/** Any line declaring the key, in any case or spacing: the gate counts each against "exactly one". */
const DECLARES_MERGED_HEAD = /^\s*merged-head\s*:/iu;

/**
 * The message the daemon puts on the wire for a squash.
 *
 * Composed rather than delegated so that what reaches `main` is a statement this process made and
 * can be tested, instead of whatever GitHub assembles from a branch nobody re-read.
 *
 * It opens with `Merged-Head: <mergedHead>` as its own paragraph, the placement `scripts/merge-pr.mjs`
 * uses: `main`'s push CI (`pnpm merge-records`) reads a squash's branch up to that one line and
 * refuses a squash without it as unverifiable. First rather than last, because git parses only the
 * last paragraph as the trailer block, so the records stored there are the branch's, as before.
 *
 * `mergedHead` is the sha the merge PUT fences on. It must be the head the squashed commits end at,
 * and no branch message may already declare the key — either would publish a head the gate cannot
 * verify, so both throw before anything is reserved or sent.
 */
export const composeSquashCommitMessage = (commits: readonly BranchCommitMessage[], mergedHead: string): string => {
  if (!FULL_SHA.test(mergedHead)) throw new Error("the Merged-Head to record is not one full commit sha");
  if (commits.at(-1)?.sha !== mergedHead) {
    throw new Error("the squashed commits do not end at the head this merge would record as its Merged-Head");
  }
  const body = withoutSessionMetadata(githubSquashCommitMessage(commits));
  if (body.split("\n").some((line) => DECLARES_MERGED_HEAD.test(line))) {
    throw new Error("a branch commit message already declares a Merged-Head, so the squash would name more than one");
  }
  const line = `Merged-Head: ${mergedHead}`;
  return body === "" ? line : `${line}\n\n${body}`;
};

/**
 * The squash as GitHub commits it — the title, a blank line, the message — read back with the
 * merge-records gate's `mergedHeadIn`, which must answer exactly `mergedHead`.
 *
 * The title is checked because the gate reads it: a single commit's subject or a pull request's
 * title can open with `Merged-Head:`, which the body-only refusal in `composeSquashCommitMessage`
 * cannot see, and the gate then refuses the squash as naming two. A refusal throws, before
 * anything is reserved or sent.
 */
export const assertSquashNamesMergedHead = async (title: string, message: string, mergedHead: string): Promise<void> => {
  const { mergedHeadIn } = (await import(MERGE_RECORDS_GATE.href)) as { mergedHeadIn: (message: string, what: string) => string };
  const named = mergedHeadIn(`${title}\n\n${message}`, "the squash message");
  if (named !== mergedHead) {
    throw new Error(`the squash message names ${named} as its Merged-Head, not the head this merge fences on`);
  }
};

/**
 * Why the daemon refuses a squash whose trailer block alone would not keep the branch's records.
 * Names what is lost and the supported path; it asks no one to change the records or the history.
 */
export const notesMirrorRequiredMessage = (pullNumber: number, kept: SquashRecordPreservation): string => {
  const named = [
    ...(kept.recordIds.length > 0 ? [`record(s) ${kept.recordIds.join(", ")}`] : []),
    ...(kept.commitsWithoutRecordId.length > 0
      ? [`record line(s) without a Record-Id from commit(s) ${kept.commitsWithoutRecordId.join(", ")}`]
      : []),
  ].join(" and ");
  return (
    `pull request #${pullNumber}'s squash message would not keep ${kept.unpreserved.length} record line(s) ` +
    `in its trailer block, from ${named}. Keeping them requires the CommitLore notes mirror, which this daemon ` +
    "does not support; this pull request needs the official preservation path " +
    "(`commitlore squash-preserve` with its notes mirror, as `pnpm merge` runs it)."
  );
};

/** COMMIT_OR_PR_TITLE, including GitHub's PR suffix, sanitized before it reaches the PUT. */
export const composeSquashCommitTitle = (
  commits: readonly BranchCommitMessage[],
  pullTitle: string | undefined,
  pullNumber: number,
): string => {
  const subject = (commits.length === 1 ? commits[0]!.message.split("\n")[0] : pullTitle) ?? "";
  const title = withoutSessionMetadata(subject).trim();
  return `${title || "Squash pull request"} (#${pullNumber})`;
};

/**
 * The title and message the daemon may send for a squash fenced on `mergedHead`, or its refusal.
 *
 * Every failure to compose or to examine throws, as the kernel's reading of the branch does, before
 * anything is reserved. The one refusal is an answer about the branch: the merge-records gate's own
 * `examineSquash`, run on these exact bytes, finds record lines the trailer block alone would not
 * keep. Keeping them needs the notes mirror, which this daemon does not write, so it does not merge.
 * Not a count of commits or records: a branch whose last trailer block carries them all proceeds.
 *
 * An examination that outlives its bound (`examinationTimeoutMs`, the whole examination's) is the
 * other refusal, `GIT_TIMEOUT`, named as such: an unanswered question is never an allowed merge.
 */
export const squashCommitForMerge = async (
  commits: readonly BranchCommitMessage[],
  pullTitle: string | undefined,
  pullNumber: number,
  mergedHead: string,
  examinationTimeoutMs: number = PRESERVATION_TIMEOUT_MS,
): Promise<Decision<{ title: string; message: string }>> => {
  const title = composeSquashCommitTitle(commits, pullTitle, pullNumber);
  const message = composeSquashCommitMessage(commits, mergedHead);
  await assertSquashNamesMergedHead(title, message, mergedHead); // the gate reads the title too
  let kept: SquashRecordPreservation;
  try {
    kept = await squashRecordPreservation(commits, title, message, mergedHead, pullNumber, examinationTimeoutMs);
  } catch (error) {
    if (!isAcpError(error) || error.reasonCode !== ReasonCode.GIT_TIMEOUT) throw error;
    return deny(
      ReasonCode.GIT_TIMEOUT,
      `pull request #${pullNumber} is not merged: ${error.message}, so whether its squash keeps the branch's records is unanswered.`,
      { pullNumber, mergedHead, ...error.evidence },
    );
  }
  if (kept.unpreserved.length === 0) return allow(ReasonCode.OK, { title, message });
  return deny(ReasonCode.MERGE_BRANCH_PROFILE_UNSATISFIED, notesMirrorRequiredMessage(pullNumber, kept), {
    pullNumber,
    mergedHead,
    notesMirror: "unsupported",
    unpreservedRecordIds: kept.recordIds,
    unpreservedRecordLines: kept.unpreserved.length,
    commitsWithoutRecordId: kept.commitsWithoutRecordId,
  });
};
