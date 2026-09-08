/**
 * The request. A sanitized title only takes effect when the squash PUT explicitly sends
 * it. Removing that field leaves GitHub to choose a title the outgoing message filter
 * has not checked.
 */
const theSquashPutStatesItsTitle = {
  id: "the-squash-put-states-its-title",
  what: "the squash PUT explicitly supplies its sanitized title",
  file: "src/github/github-kernel.ts",
  find: "            commit_title: outgoingCommitMessage.title,",
  replace: "",
  killedBy: [
    "tests/unit/github-squash-request.test.ts::sanitizes the actual PUT title and body",
  ],
};

export default theSquashPutStatesItsTitle;
