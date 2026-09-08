/**
 * The wiring. A composer that is correct and never reaches the request is the exact shape this
 * work exists to remove: one side prepared, the other side never traversing it. Dropping the field
 * from the PUT body returns the merge to `{ sha, merge_method }`, where GitHub composes the
 * message from the branch's commits and publishes whatever they say.
 */
const theSquashMergeStatesItsOwnCommitMessage = {
  id: "the-squash-merge-states-its-own-commit-message",
  what: "the squash merge request carries the message the daemon composed",
  file: "src/github/github-kernel.ts",
  find: "          ...(outgoingCommitMessage !== undefined ? { commit_message: outgoingCommitMessage } : {}),",
  replace: "          ...(outgoingCommitMessage !== undefined ? {} : {}),",
  killedBy: [
    "tests/scenarios/github-hardening.test.ts::sends a commit_message rather than leaving the composition to COMMIT_MESSAGES",
  ],
};

export default theSquashMergeStatesItsOwnCommitMessage;
