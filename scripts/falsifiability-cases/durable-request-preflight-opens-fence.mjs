// Composite-decision witness: the unique range names its contained operands.
// This is not a claim of independent mutation sensitivity for each operand.
export default {
  "id": "durable-request-preflight-opens-fence",
  "what": "parsed principal and request open the durable operation fence",
  "file": "src/ceo/cto-binding-delegation.ts",
  "find": "principal.success && request.success",
  "replace": "(principal.success && request.success) && false",
  "killedBy": [
    "tests/unit/cto-binding-delegation-durable.test.ts::reconstructs only an explicitly durable"
  ]
};
