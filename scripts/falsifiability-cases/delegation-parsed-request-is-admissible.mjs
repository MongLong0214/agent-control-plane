// Composite-decision witness: the unique range names its contained operands.
// This is not a claim of independent mutation sensitivity for each operand.
export default {
  "id": "delegation-parsed-request-is-admissible",
  "what": "a well-formed authenticated request is admissible",
  "file": "src/ceo/cto-binding-delegation.ts",
  "find": "!principal.success || !parsed.success",
  "replace": "(!principal.success || !parsed.success) || true",
  "killedBy": [
    "tests/unit/cto-binding-delegation.test.ts::authenticates the CEO session"
  ]
};
