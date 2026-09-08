/**
 * The records. Duplicate SHAs can make a list reach the reported count while hiding a
 * missing commit. Removing the uniqueness check lets that list pass even when its count
 * and final head agree.
 */
const theSquashListMustNotRepeatCommits = {
  id: "the-squash-list-must-not-repeat-commits",
  what: "duplicate SHAs cannot substitute for missing commit records",
  file: "src/github/github-kernel.ts",
  find: "new Set(commits.map((commit) => commit.sha)).size !== commits.length",
  replace: "false",
  killedBy: [
    "tests/unit/github-squash-request.test.ts::refuses duplicate commits even when the count and final head agree",
  ],
};

export default theSquashListMustNotRepeatCommits;
