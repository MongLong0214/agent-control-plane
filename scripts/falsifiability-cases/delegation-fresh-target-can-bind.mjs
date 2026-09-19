// Composite-decision witness: the unique range names its contained operands.
// This is not a claim of independent mutation sensitivity for each operand.
const delegationFreshTargetCanBind = {
  "id": "delegation-fresh-target-can-bind",
  "what": "a freshly authorized verified target reaches the binding write",
  "file": "src/daemon/cto-delegated-binding.ts",
  "find": "!fresh.allowed || fresh.value.targetIncarnation !== tuple.incarnation ||\n            tuple.generation !== request.expectedBindingGeneration ||\n            incumbent !== null || (current && !dead(current))",
  "replace": "(!fresh.allowed || fresh.value.targetIncarnation !== tuple.incarnation ||\n            tuple.generation !== request.expectedBindingGeneration ||\n            incumbent !== null || (current && !dead(current))) || true",
  "killedBy": [
    "tests/unit/cto-delegated-binding.test.ts::socket authenticates CEO"
  ]
};

export default delegationFreshTargetCanBind;
