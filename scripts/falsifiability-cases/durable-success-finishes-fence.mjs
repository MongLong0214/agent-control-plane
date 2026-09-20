// Composite-decision witness: the unique range names its contained operands.
// This is not a claim of independent mutation sensitivity for each operand.
const durableSuccessFinishesFence = {
  "id": "durable-success-finishes-fence",
  "what": "a successful owned operation finishes its fence",
  "file": "src/ceo/cto-binding-delegation.ts",
  "find": "result.allowed && this.#operation",
  "replace": "!result.allowed && this.#operation",
  "killedBy": [
    "tests/unit/cto-binding-delegation-durable.test.ts::external transaction is refused"
  ]
};

export default durableSuccessFinishesFence;
