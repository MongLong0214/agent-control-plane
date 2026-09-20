// Composite-decision witness: the unique range names its contained operands.
// This is not a claim of independent mutation sensitivity for each operand.
const delegationGrantCurrentCeo = {
  "id": "delegation-grant-current-ceo",
  "what": "the current READY CEO session can receive a scoped grant",
  "file": "src/ceo/cto-binding-delegation.ts",
  "find": "!session || session.lifecycle !== SessionLifecycle.READY || session.incarnation !== s.ceoIncarnation ||\n        !binding || binding.sessionId !== s.ceoSessionId || binding.sessionIncarnation !== s.ceoIncarnation",
  "replace": "!session || session.lifecycle !== SessionLifecycle.READY || session.incarnation !== s.ceoIncarnation ||\n        !binding || binding.sessionId !== s.ceoSessionId || binding.sessionIncarnation === s.ceoIncarnation",
  "killedBy": [
    "tests/unit/cto-binding-delegation.test.ts::requires an admitted explicit owner decision"
  ]
};

export default delegationGrantCurrentCeo;
