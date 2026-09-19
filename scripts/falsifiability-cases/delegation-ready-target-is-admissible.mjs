// Composite-decision witness: the unique range names its contained operands.
// This is not a claim of independent mutation sensitivity for each operand.
export default {
  "id": "delegation-ready-target-is-admissible",
  "what": "a registered READY target permits authorization",
  "file": "src/ceo/cto-binding-delegation.ts",
  "find": "!target || target.lifecycle !== SessionLifecycle.READY",
  "replace": "(!target || target.lifecycle !== SessionLifecycle.READY) || true",
  "killedBy": [
    "tests/unit/cto-binding-delegation.test.ts::authenticates the CEO session"
  ]
};
