export default {
  "id": "the-squash-list-must-end-at-the-head",
  "what": "the collected list must end at the checked PR head",
  "file": "src/github/github-kernel.ts",
  "find": "    if (commits.at(-1)!.sha !== pull.head.sha) {",
  "replace": "    if (false) {",
  "killedBy": [
    "tests/unit/github-squash-request.test.ts::refuses a collected list that does not end at the exact head"
  ]
};
