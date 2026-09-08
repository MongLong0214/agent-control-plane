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
  find: "            commit_message: outgoingCommitMessage.message,",
  replace: "",
  killedBy: [
    "tests/unit/github-squash-request.test.ts::sanitizes the actual PUT title and body",
  ],
};

export default theSquashMergeStatesItsOwnCommitMessage;
