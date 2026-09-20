// Composite-decision witness: the unique range names its contained operands.
// This is not a claim of independent mutation sensitivity for each operand.
const delegationAuthenticatedCeoIsAdmissible = {
  "id": "delegation-authenticated-ceo-is-admissible",
  "what": "a READY authenticated scoped CEO permits authorization",
  "file": "src/ceo/cto-binding-delegation.ts",
  "find": "authenticated.value.lifecycle !== SessionLifecycle.READY ||\n        authenticated.value.incarnation !== s.ceoIncarnation || p.sessionId !== s.ceoSessionId",
  "replace": "authenticated.value.lifecycle !== SessionLifecycle.READY ||\n        authenticated.value.incarnation !== s.ceoIncarnation || p.sessionId === s.ceoSessionId",
  "killedBy": [
    "tests/unit/cto-binding-delegation.test.ts::authenticates the CEO session"
  ]
};

export default delegationAuthenticatedCeoIsAdmissible;
