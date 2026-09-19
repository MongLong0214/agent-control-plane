// Composite-decision witness: the unique range names its contained operands.
// This is not a claim of independent mutation sensitivity for each operand.
export default {
  "id": "native-delegation-owns-admission",
  "what": "native delegation admits within its own transaction",
  "file": "src/ceo/cto-binding-delegation.ts",
  "find": "!this.db || this.db.inTransaction || this.#ownsTransaction",
  "replace": "(!this.db || this.db.inTransaction || this.#ownsTransaction) || true",
  "killedBy": [
    "tests/unit/native-owner-auth.test.ts::native"
  ]
};
