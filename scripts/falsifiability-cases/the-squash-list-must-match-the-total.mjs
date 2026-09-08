export default {
  "id": "the-squash-list-must-match-the-total",
  "what": "the collected count must equal the exact PR total",
  "file": "src/github/github-kernel.ts",
  "find": "commits.length !== expectedCount || new Set",
  "replace": "false || new Set",
  "killedBy": [
    "tests/unit/github-squash-request.test.ts::refuses a collected count that disagrees"
  ]
};
