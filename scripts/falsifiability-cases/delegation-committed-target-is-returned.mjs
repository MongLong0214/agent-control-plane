// Composite-decision witness: the unique range names its contained operands.
// This is not a claim of independent mutation sensitivity for each operand.
const delegationCommittedTargetIsReturned = {
  "id": "delegation-committed-target-is-returned",
  "what": "the exact active committed target is returned as success",
  "file": "src/daemon/cto-delegated-binding.ts",
  "find": "!active || active.assignmentId !== written.value.assignmentId ||\n          active.sessionId !== request.targetSessionId ||\n          active.bindingGeneration !== request.expectedBindingGeneration",
  "replace": "(!active || active.assignmentId !== written.value.assignmentId ||\n          active.sessionId !== request.targetSessionId ||\n          active.bindingGeneration !== request.expectedBindingGeneration) || true",
  "killedBy": [
    "tests/unit/cto-delegated-binding.test.ts::socket authenticates CEO"
  ]
};

export default delegationCommittedTargetIsReturned;
