/**
 * The range handed to the trailer gate must end at the pull request's head, not at the checkout's
 * `HEAD`. On a pull_request event the checkout is the merge ref GitHub composed, whose first
 * parent is the base branch tip -- so a range ending at `HEAD` audits every commit the base
 * branch gained since `base.sha`, including squash merges composed by GitHub's own button.
 *
 * That is not a hypothetical: the #867 squash `573f7eab` carries eleven record-trailer lines in
 * its body of which git parses three, and on 2026-09-13 it failed this gate on two unrelated pull
 * requests at once, for a commit neither of them authored and which cannot be corrected without
 * rewriting main. Its records were never lost -- `commitlore-preserve` attached them as notes --
 * so the only thing the red build established was that the range was wrong.
 *
 * The mutation restores the exact defective form rather than deleting the value, because an empty
 * or absent range makes the gate fall back to its local default and the build stays green for a
 * different reason.
 */
const theTrailerAuditReadsThePrsOwnCommits = {
  id: "the-trailer-audit-reads-the-prs-own-commits",
  what: "the trailer gate's commit range ends at the pull request's head SHA, so it never audits a commit the base branch contributed",
  file: ".github/workflows/ci.yml",
  find: "format('{0}..{1}', github.event.pull_request.base.sha, github.event.pull_request.head.sha)",
  replace: "format('{0}..HEAD', github.event.pull_request.base.sha)",
  killedBy: [
    "tests/process/the-gate-set-cannot-drift-from-ci.test.ts::audits the pull request's own commits, not the base branch side of the merge ref",
  ],
};

export default theTrailerAuditReadsThePrsOwnCommits;
