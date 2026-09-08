export default {
  "id": "the-squash-total-must-fit-the-api-cap",
  "what": "a PR exceeding the 250 commit API cap cannot be composed",
  "file": "src/github/github-kernel.ts",
  "find": "    if (expectedCount > 250) {",
  "replace": "    if (false) {",
  "killedBy": [
    "tests/unit/github-squash-request.test.ts::refuses a capped 250-commit list"
  ]
};
