// Composite-decision witness: the unique range names its contained operands.
// This is not a claim of independent mutation sensitivity for each operand.
const delegationHermesTupleIsAdmissible = {
  "id": "delegation-hermes-tuple-is-admissible",
  "what": "the matching Hermes tuple reaches the child target-bind producer",
  "file": "src/daemon/cto-binding-runtime.ts",
  "find": "        verify: (tuple) => {\n          if (tuple.sessionId !== sessionId || tuple.incarnation !== target.incarnation",
  "replace": "        verify: (tuple) => {\n          if ((tuple.sessionId !== sessionId || tuple.incarnation !== target.incarnation) || true",
  "killedBy": [
    "tests/unit/cto-binding-runtime.test.ts::owner-admitted grant reaches CEO MCP.*success"
  ]
};

export default delegationHermesTupleIsAdmissible;
