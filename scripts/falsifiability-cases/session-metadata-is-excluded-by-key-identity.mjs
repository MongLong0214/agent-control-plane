/**
 * Rule 1. The metadata is written today as `X-Claude-Session:`, which *is* an `X-<Name>` and so is
 * exactly what CommitLore's commit-msg hook accepts — a filter phrased by trailer shape keeps the
 * one line it most needs to drop. Removing the identity filter leaves the line in the message the
 * daemon publishes.
 */
const sessionMetadataIsExcludedByKeyIdentity = {
  id: "session-metadata-is-excluded-by-key-identity",
  what: "a session metadata line is removed by the identity of its key",
  file: "src/github/merge-commit-message.ts",
  find: "  const kept = lines.filter((line) => !metadataLine.test(line));",
  replace: "  const kept = lines.filter(() => true);",
  killedBy: [
    "tests/unit/merge-commit-message.test.ts::removes the trailer form, which a shape-based filter keeps",
  ],
};

export default sessionMetadataIsExcludedByKeyIdentity;
