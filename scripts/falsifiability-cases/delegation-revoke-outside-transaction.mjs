// Composite-decision witness: the unique range names its contained operands.
// This is not a claim of independent mutation sensitivity for each operand.
export default {
  "id": "delegation-revoke-outside-transaction",
  "what": "owner revocation succeeds outside an external transaction",
  "file": "src/ceo/cto-binding-delegation.ts",
  "find": "  revoke(delegationId: string, rawReceipt: unknown): Decision<void> {\n    if (this.db?.inTransaction || this.#ownsTransaction",
  "replace": "  revoke(delegationId: string, rawReceipt: unknown): Decision<void> {\n    if ((this.db?.inTransaction || this.#ownsTransaction) || true",
  "killedBy": [
    "tests/unit/cto-binding-delegation.test.ts::owner revocation invalidates cached retries"
  ]
};
