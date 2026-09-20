// Composite-decision witness: the unique range names its contained operands.
// This is not a claim of independent mutation sensitivity for each operand.
const delegatedMcpInternalDenialIsClosed = {
  "id": "delegated-mcp-internal-denial-is-closed",
  "what": "an internal returned denial is sanitized at MCP publication",
  "file": "src/daemon/agentcpd.ts",
  "find": "!decision.allowed && decision.reasonCode === ReasonCode.INTERNAL_ERROR",
  "replace": "!decision.allowed && decision.reasonCode !== ReasonCode.INTERNAL_ERROR",
  "killedBy": [
    "tests/unit/cto-binding-runtime.test.ts::nested target denial stays closed"
  ]
};

export default delegatedMcpInternalDenialIsClosed;
