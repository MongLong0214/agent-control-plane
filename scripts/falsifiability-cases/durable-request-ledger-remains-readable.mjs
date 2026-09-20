// Composite-decision witness: the unique range names its contained operands.
// This is not a claim of independent mutation sensitivity for each operand.
const durableRequestLedgerRemainsReadable = {
  "id": "durable-request-ledger-remains-readable",
  "what": "the unchanged durable request can replay after restart",
  "file": "src/ceo/cto-binding-delegation.ts",
  "find": "requestDigest !== digestOf(body) || seen.has(priorKey)",
  "replace": "requestDigest === digestOf(body) || seen.has(priorKey)",
  "killedBy": [
    "tests/unit/cto-binding-delegation-durable.test.ts::changed request replay remains refused"
  ]
};

export default durableRequestLedgerRemainsReadable;
