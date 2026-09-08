/**
 * The other direction, and the one with a body count. Composing a merge body by hand is what
 * dropped 129 of 132 CommitLore record lines across three merges, while a check reported those
 * merges clean; `squash_merge_commit_message = COMMIT_MESSAGES` was set because of it. Keeping
 * only the last commit's contribution reproduces that loss exactly.
 */
const theComposedMessageKeepsEveryBranchCommit = {
  id: "the-composed-message-keeps-every-branch-commit",
  what: "the composition carries every commit on the branch, not only the last",
  file: "src/github/merge-commit-message.ts",
  find: '    .join("\\n\\n");',
  replace: '    .slice(-1)\n    .join("\\n\\n");',
  killedBy: [
    "tests/unit/merge-commit-message.test.ts::carries every record line of a multi-commit branch, named rather than counted",
  ],
};

export default theComposedMessageKeepsEveryBranchCommit;
