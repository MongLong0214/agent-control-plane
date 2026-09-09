/**
 * #805. The same defect on the handshake reader, where it is worse: the bytes after the handshake
 * line are the peer's first messages, which this reader hands to the transport. Measuring the
 * whole buffer refuses a credential for the size of something the credential never claimed.
 */
const anMcpHandshakeLimitIsMeasuredPerLine = {
  id: "an-mcp-handshake-limit-is-measured-per-line",
  what: "the MCP handshake limit is compared against the handshake line, not against the whole read",
  file: "src/daemon/agentcpd.ts",
  find: "      if (boundary > MAX_MCP_LINE_BYTES) return reject();",
  replace: "      if (buffer.length > MAX_MCP_LINE_BYTES) return reject();",
  killedBy: [
    "tests/unit/an-mcp-line-limit-bounds-one-line.test.ts::accepts a handshake whose read also carried the messages after it",
  ],
};

export default anMcpHandshakeLimitIsMeasuredPerLine;
