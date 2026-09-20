// Composite-decision witness: the unique range names its contained operands.
// This is not a claim of independent mutation sensitivity for each operand.
const delegationGrantOutsideTransaction = {
  "id": "delegation-grant-outside-transaction",
  "what": "an admitted grant succeeds outside an external transaction",
  "file": "src/ceo/cto-binding-delegation.ts",
  "find": "  grant(rawScope: unknown, rawReceipt: unknown): Decision<CtoBindingDelegationRecord> {\n    if (this.db?.inTransaction || this.#ownsTransaction",
  "replace": "  grant(rawScope: unknown, rawReceipt: unknown): Decision<CtoBindingDelegationRecord> {\n    if ((this.db?.inTransaction || this.#ownsTransaction) || true",
  "killedBy": [
    "tests/unit/cto-binding-delegation.test.ts::requires an admitted explicit owner decision"
  ]
};

export default delegationGrantOutsideTransaction;
