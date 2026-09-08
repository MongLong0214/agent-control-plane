export default {
  "id": "the-squash-total-must-be-exact",
  "what": "an absent or invalid exact total cannot start collection",
  "file": "src/github/github-kernel.ts",
  "find": "    if (typeof expectedCount !== \"number\" || !Number.isSafeInteger(expectedCount) || expectedCount < 1) {",
  "replace": "    if (false) {",
  "killedBy": [
    "tests/unit/github-squash-request.test.ts::refuses an unusable exact commit total"
  ]
};
