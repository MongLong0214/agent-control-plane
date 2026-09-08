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

/**
 * The message the daemon puts on the wire for a squash.
 *
 * Composed rather than delegated so that what reaches `main` is a statement this process made and
 * can be tested, instead of whatever GitHub assembles from a branch nobody re-read.
 */
export const composeSquashCommitMessage = (commits: readonly BranchCommitMessage[]): string =>
  withoutSessionMetadata(githubSquashCommitMessage(commits));

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
