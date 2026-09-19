// Composite-decision witness: the unique range names its contained operands.
// This is not a claim of independent mutation sensitivity for each operand.
export default {
  "id": "delegation-claude-identity-is-admissible",
  "what": "a verified still-live Claude identity reaches binding",
  "file": "src/daemon/cto-binding-runtime.ts",
  "find": "!checked.allowed || checked.value.identity.startedAt !== session.osProcessStartedAt ||\n                !assertClaudeIdentityStillLive(checked.value.identity).allowed",
  "replace": "(!checked.allowed || checked.value.identity.startedAt !== session.osProcessStartedAt ||\n                !assertClaudeIdentityStillLive(checked.value.identity).allowed) || true",
  "killedBy": [
    "tests/unit/cto-binding-runtime.test.ts::Claude target pins.*success"
  ]
};
