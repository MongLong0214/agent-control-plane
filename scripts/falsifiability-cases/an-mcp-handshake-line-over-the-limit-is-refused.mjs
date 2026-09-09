/**
 * #805. The handshake reader's own refusal arm. Deleting it admits a credential line of any
 * length, so the reader that hands out an authenticated transport has no bound at all.
 */
const anMcpHandshakeLineOverTheLimitIsRefused = {
  id: "an-mcp-handshake-line-over-the-limit-is-refused",
  what: "an MCP handshake line longer than the limit is refused",
  file: "src/daemon/agentcpd.ts",
  find: "      if (boundary > MAX_MCP_LINE_BYTES) return reject();\n",
  replace: "",
  killedBy: [
    "tests/unit/an-mcp-line-limit-bounds-one-line.test.ts::refuses a handshake line longer than the limit",
  ],
};

export default anMcpHandshakeLineOverTheLimitIsRefused;
