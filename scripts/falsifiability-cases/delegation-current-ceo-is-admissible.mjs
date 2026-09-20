// Composite-decision witness: the unique range names its contained operands.
// This is not a claim of independent mutation sensitivity for each operand.
const delegationCurrentCeoIsAdmissible = {
  "id": "delegation-current-ceo-is-admissible",
  "what": "an unexpired grant for the current CEO permits authorization",
  "file": "src/ceo/cto-binding-delegation.ts",
  "find": "Date.parse(s.expiresAt) <= this.clock.now().getTime() || !ceo ||\n        ceo.sessionId !== s.ceoSessionId || ceo.sessionIncarnation !== s.ceoIncarnation",
  "replace": "Date.parse(s.expiresAt) <= this.clock.now().getTime() || !ceo ||\n        ceo.sessionId !== s.ceoSessionId || ceo.sessionIncarnation === s.ceoIncarnation",
  "killedBy": [
    "tests/unit/cto-binding-delegation.test.ts::authenticates the CEO session"
  ]
};

export default delegationCurrentCeoIsAdmissible;
