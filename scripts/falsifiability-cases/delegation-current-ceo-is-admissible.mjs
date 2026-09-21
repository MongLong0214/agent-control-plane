// Composite-decision witness: the unique range names its contained operands.
// This is not a claim of independent mutation sensitivity for each operand.
const delegationCurrentCeoIsAdmissible = {
  "id": "delegation-current-ceo-is-admissible",
  "what": "the live CEO binding at its current incarnation permits authorization",
  "file": "src/ceo/cto-binding-delegation.ts",
  "find": "!ceo || ceo.sessionId !== p.sessionId || ceo.sessionIncarnation !== authenticated.value.incarnation",
  "replace": "!ceo || ceo.sessionId !== p.sessionId || ceo.sessionIncarnation === authenticated.value.incarnation",
  "killedBy": [
    "tests/unit/cto-binding-delegation.test.ts::authenticates the CEO session"
  ]
};

export default delegationCurrentCeoIsAdmissible;
