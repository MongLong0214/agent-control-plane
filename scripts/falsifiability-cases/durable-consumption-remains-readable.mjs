// Composite-decision witness: the unique range names its contained operands.
// This is not a claim of independent mutation sensitivity for each operand.
export default {
  "id": "durable-consumption-remains-readable",
  "what": "a unique consumed receipt remains readable",
  "file": "src/ceo/cto-binding-delegation.ts",
  "find": "typeof evidence.receiptDigest !== \"string\" || consumed.has(evidence.receiptDigest)",
  "replace": "(typeof evidence.receiptDigest !== \"string\" || consumed.has(evidence.receiptDigest)) || true",
  "killedBy": [
    "tests/unit/cto-binding-delegation-durable.test.ts::reconstructs only an explicitly durable"
  ]
};
