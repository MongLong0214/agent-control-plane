// Composite-decision witness: the unique range names its contained operands.
// This is not a claim of independent mutation sensitivity for each operand.
const durableCurrentFenceRemainsUsable = {
  "id": "durable-current-fence-remains-usable",
  "what": "the current owned operation fence permits its request",
  "file": "src/ceo/cto-binding-delegation.ts",
  "find": "delegationId === id && operationId !== this.#operation?.operationId",
  "replace": "(delegationId === id && operationId !== this.#operation?.operationId) || true",
  "killedBy": [
    "tests/unit/cto-binding-delegation-durable.test.ts::reconstructs only an explicitly durable"
  ]
};

export default durableCurrentFenceRemainsUsable;
