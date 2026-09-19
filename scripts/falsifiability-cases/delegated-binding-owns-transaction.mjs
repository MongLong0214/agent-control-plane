// Composite-decision witness: the unique range names its contained operands.
// This is not a claim of independent mutation sensitivity for each operand.
export default {
  "id": "delegated-binding-owns-transaction",
  "what": "an unnested delegated binding can own its transaction",
  "file": "src/ceo/cto-binding-delegation.ts",
  "find": "db.inTransaction || this.#ownsTransaction || this.db !== db",
  "replace": "(db.inTransaction || this.#ownsTransaction || this.db !== db) || true",
  "killedBy": [
    "tests/unit/cto-binding-runtime.test.ts::Claude target pins.*success"
  ]
};
