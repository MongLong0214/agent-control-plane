export default {
  "id": "the-squash-list-must-not-repeat-commits",
  "what": "duplicate SHAs cannot substitute for missing commit records",
  "file": "src/github/github-kernel.ts",
  "find": "new Set(commits.map((commit) => commit.sha)).size !== commits.length",
  "replace": "false",
  "killedBy": [
    "tests/unit/github-squash-request.test.ts::refuses duplicate commits even when the count and final head agree"
  ]
};
