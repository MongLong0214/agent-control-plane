// Composite-decision witness: the unique range names its contained operands.
// This is not a claim of independent mutation sensitivity for each operand.
const delegationOperatorObjectParamsAreAdmissible = {
  "id": "delegation-operator-object-params-are-admissible",
  "what": "operator object parameters reach delegation dispatch",
  "file": "src/daemon/agentcpd.ts",
  "find": "!params || typeof params !== \"object\" || Array.isArray(params)",
  "replace": "!params || typeof params === \"object\" || Array.isArray(params)",
  "killedBy": [
    "tests/unit/cto-binding-runtime.test.ts::owner-admitted grant reaches CEO MCP.*success"
  ]
};

export default delegationOperatorObjectParamsAreAdmissible;
