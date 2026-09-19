// Composite-decision witness: the unique range names its contained operands.
// This is not a claim of independent mutation sensitivity for each operand.
const delegationOperatorDispatchesGrant = {
  "id": "delegation-operator-dispatches-grant",
  "what": "the operator dispatches the owner-admitted delegation method",
  "file": "src/daemon/agentcpd.ts",
  "find": "method === \"ctoBinding.delegate\" || method === \"ctoBinding.revoke\"",
  "replace": "(method === \"ctoBinding.delegate\" || method === \"ctoBinding.revoke\") && false",
  "killedBy": [
    "tests/unit/cto-binding-runtime.test.ts::owner-admitted grant reaches CEO MCP.*success"
  ]
};

export default delegationOperatorDispatchesGrant;
