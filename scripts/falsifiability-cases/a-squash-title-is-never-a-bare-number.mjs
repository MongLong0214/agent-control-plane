/**
 * #833 — the squash title falls back rather than publishing `(#7)` as a commit subject.
 *
 * The mutation removes the fallback, leaving `title` alone. A multi-commit branch with no pull
 * title, or a one-commit branch whose subject is nothing but session metadata, then sends
 * COMMIT_OR_PR_TITLE as `" (#7)"` — the subject of a merge commit on `main`, forever, with no
 * error from GitHub to notice.
 *
 * The subject is sanitized before it is used (`withoutSessionMetadata`), which is what makes the
 * empty case reachable rather than hypothetical: the sanitizer removes those keys wherever they
 * appear, including from a first line.
 */
const aSquashTitleIsNeverABareNumber = {
  id: "a-squash-title-is-never-a-bare-number",
  what: "an empty sanitized subject becomes a stated fallback, so a squash merge never publishes a bare pull number as its commit subject",
  file: "src/github/merge-commit-message.ts",
  find: '`${title || "Squash pull request"} (#${pullNumber})`',
  replace: "`${title} (#${pullNumber})`",
  // One test, because `killedBy` is passed to vitest as a single `-t` pattern and the harness
  // refuses a list. The multi-commit case is the one named: `subject` is `?? ""` there, so it is
  // the empty subject that needs no sanitizer behaviour to reach.
  killedBy: [
    "tests/unit/merge-commit-message.test.ts::falls back rather than publishing a bare number as the subject",
  ],
};

// Bound to a name rather than exported anonymously: every tracked JavaScript file in this
// repository has to keep a parsed declaration a citation can point at
// (tests/unit/verify-tracker-loci-resolve.test.ts). The loader still sees exactly one export.
export default aSquashTitleIsNeverABareNumber;
