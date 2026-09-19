// Composite-decision witness: the unique range names its contained operands.
// This is not a claim of independent mutation sensitivity for each operand.
export default {
  "id": "delegation-claude-tuple-is-admissible",
  "what": "the matching Claude session tuple reaches the canonical verifier",
  "file": "src/daemon/cto-binding-runtime.ts",
  "find": "            if (tuple.sessionId !== sessionId || tuple.incarnation !== target.incarnation",
  "replace": "            if ((tuple.sessionId !== sessionId || tuple.incarnation !== target.incarnation) || true",
  "killedBy": [
    "tests/unit/cto-binding-runtime.test.ts::Claude target pins.*success"
  ]
};
