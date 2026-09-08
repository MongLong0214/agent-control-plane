export default {
  "id": "the-squash-title-is-sanitized",
  "what": "the chosen squash title passes through the metadata filter",
  "file": "src/github/merge-commit-message.ts",
  "find": "  const title = withoutSessionMetadata(subject).trim();",
  "replace": "  const title = subject.trim();",
  "killedBy": [
    "tests/unit/github-squash-request.test.ts::sanitizes the actual PUT title and body"
  ]
};
