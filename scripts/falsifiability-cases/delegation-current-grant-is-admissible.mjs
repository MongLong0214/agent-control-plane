// Composite-decision witness: the unique range names its contained operands.
// This is not a claim of independent mutation sensitivity for each operand.
const delegationCurrentGrantIsAdmissible = {
  "id": "delegation-current-grant-is-admissible",
  "what": "an extant grant without pending revocation permits authorization",
  "file": "src/ceo/cto-binding-delegation.ts",
  "find": "!grant || this.#pendingRevocations.has(request.delegationId)",
  "replace": "!grant || !this.#pendingRevocations.has(request.delegationId)",
  "killedBy": [
    "tests/unit/cto-binding-delegation.test.ts::authenticates the CEO session"
  ]
};

export default delegationCurrentGrantIsAdmissible;
