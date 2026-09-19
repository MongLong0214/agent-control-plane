// Composite-decision witness: the unique range names its contained operands.
// This is not a claim of independent mutation sensitivity for each operand.
export default {
  "id": "durable-owned-request-is-admissible",
  "what": "a durable request with its owned fence is admissible",
  "file": "src/ceo/cto-binding-delegation.ts",
  "find": "s.revokePolicy === \"owner-or-ceo-loss\" && this.#operation?.delegationId !== request.delegationId",
  "replace": "(s.revokePolicy === \"owner-or-ceo-loss\" && this.#operation?.delegationId !== request.delegationId) || true",
  "killedBy": [
    "tests/unit/cto-binding-delegation-durable.test.ts::reconstructs only an explicitly durable"
  ]
};
