// Composite-decision witness: the unique range names its contained operands.
// This is not a claim of independent mutation sensitivity for each operand.
export default {
  "id": "delegation-claude-process-is-admissible",
  "what": "a pinned Claude process with a start token reaches verification",
  "file": "src/daemon/cto-binding-runtime.ts",
  "find": "session.osPid === null || session.osProcessStartedAt === null",
  "replace": "(session.osPid === null || session.osProcessStartedAt === null) || true",
  "killedBy": [
    "tests/unit/cto-binding-runtime.test.ts::Claude target pins.*success"
  ]
};
