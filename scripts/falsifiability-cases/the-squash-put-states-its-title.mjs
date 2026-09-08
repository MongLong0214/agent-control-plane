export default {
  "id": "the-squash-put-states-its-title",
  "what": "the squash PUT explicitly supplies its sanitized title",
  "file": "src/github/github-kernel.ts",
  "find": "            commit_title: outgoingCommitMessage.title,",
  "replace": "",
  "killedBy": [
    "tests/unit/github-squash-request.test.ts::sanitizes the actual PUT title and body"
  ]
};
