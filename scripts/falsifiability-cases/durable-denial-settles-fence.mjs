// Composite-decision witness: the unique range names its contained operands.
// This is not a claim of independent mutation sensitivity for each operand.
export default {
  "id": "durable-denial-settles-fence",
  "what": "a denied expired operation settles its revocation and fence",
  "file": "src/ceo/cto-binding-delegation.ts",
  "find": "ids.length === 0 && !operation",
  "replace": "(ids.length === 0 && !operation) || true",
  "killedBy": [
    "tests/unit/cto-binding-runtime.test.ts::durable expiry survives a denied production binding"
  ]
};
