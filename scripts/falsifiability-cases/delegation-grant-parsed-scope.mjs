// Composite-decision witness: the unique range names its contained operands.
// This is not a claim of independent mutation sensitivity for each operand.
export default {
  "id": "delegation-grant-parsed-scope",
  "what": "a parsed owner scope and receipt can grant authority",
  "file": "src/ceo/cto-binding-delegation.ts",
  "find": "!scope.success || !receipt.success",
  "replace": "(!scope.success || !receipt.success) || true",
  "killedBy": [
    "tests/unit/cto-binding-delegation.test.ts::requires an admitted explicit owner decision"
  ]
};
