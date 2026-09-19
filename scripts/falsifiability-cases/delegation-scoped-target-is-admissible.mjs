// Composite-decision witness: the unique range names its contained operands.
// This is not a claim of independent mutation sensitivity for each operand.
export default {
  "id": "delegation-scoped-target-is-admissible",
  "what": "the exact project role action and distinct target permit authorization",
  "file": "src/ceo/cto-binding-delegation.ts",
  "find": "request.projectId !== s.projectId || request.role !== s.role || request.action !== s.action ||\n        request.targetSessionId === p.sessionId",
  "replace": "(request.projectId !== s.projectId || request.role !== s.role || request.action !== s.action ||\n        request.targetSessionId === p.sessionId) || true",
  "killedBy": [
    "tests/unit/cto-binding-delegation.test.ts::authenticates the CEO session"
  ]
};
