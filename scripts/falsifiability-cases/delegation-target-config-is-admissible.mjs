// Composite-decision witness: the unique range names its contained operands.
// This is not a claim of independent mutation sensitivity for each operand.
export default {
  "id": "delegation-target-config-is-admissible",
  "what": "valid unique target pins construct the runtime",
  "file": "src/daemon/cto-binding-runtime.ts",
  "find": "!parsed.success || new Set(parsed.data.map((t) => t.sessionId)).size !== parsed.data.length",
  "replace": "(!parsed.success || new Set(parsed.data.map((t) => t.sessionId)).size !== parsed.data.length) || true",
  "killedBy": [
    "tests/unit/cto-binding-runtime.test.ts::Claude target pins.*success"
  ]
};
