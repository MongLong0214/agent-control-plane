// Composite-decision witness: the unique range names its contained operands.
// This is not a claim of independent mutation sensitivity for each operand.
export default {
  "id": "delegation-revoke-known-grant",
  "what": "a parsed revocation can address a known grant",
  "file": "src/ceo/cto-binding-delegation.ts",
  "find": "!receipt.success || (!durable && !this.#grants.has(delegationId))",
  "replace": "(!receipt.success || (!durable && !this.#grants.has(delegationId))) || true",
  "killedBy": [
    "tests/unit/cto-binding-delegation.test.ts::owner revocation invalidates cached retries"
  ]
};
