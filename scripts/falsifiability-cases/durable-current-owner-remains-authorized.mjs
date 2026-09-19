// Composite-decision witness: the unique range names its contained operands.
// This is not a claim of independent mutation sensitivity for each operand.
export default {
  "id": "durable-current-owner-remains-authorized",
  "what": "the current owner and assignment permit reconstruction",
  "file": "src/ceo/cto-binding-delegation.ts",
  "find": "!g || revoked.has(id) || !this.owner.isAllowedActor(g.receipt.channel, g.receipt.actor) ||\n          this.#currentAssignment(g.scope) !== g.assignmentId",
  "replace": "(!g || revoked.has(id) || !this.owner.isAllowedActor(g.receipt.channel, g.receipt.actor) ||\n          this.#currentAssignment(g.scope) !== g.assignmentId) || true",
  "killedBy": [
    "tests/unit/cto-binding-delegation-durable.test.ts::reconstructs only an explicitly durable"
  ]
};
