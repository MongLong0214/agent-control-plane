// Composite-decision witness: the unique range names its contained operands.
// This is not a claim of independent mutation sensitivity for each operand.
const nativeDelegationAcceptsDurableScope = {
  "id": "native-delegation-accepts-durable-scope",
  "what": "native delegation accepts its explicitly durable scope",
  "file": "src/ceo/cto-binding-delegation.ts",
  "find": "!scope.success || scope.data.revokePolicy !== \"owner-or-ceo-loss\"",
  "replace": "!scope.success || scope.data.revokePolicy === \"owner-or-ceo-loss\"",
  "killedBy": [
    "tests/unit/cto-binding-durable-admission.test.ts::durable admission on the existing authenticated socket"
  ]
};

export default nativeDelegationAcceptsDurableScope;
