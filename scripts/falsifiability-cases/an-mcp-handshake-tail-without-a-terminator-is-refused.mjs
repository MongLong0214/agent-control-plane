/**
 * #805. The handshake reader's buffering bound. Without it an unauthenticated peer that never
 * writes a newline holds a growing buffer for the whole handshake window.
 */
const anMcpHandshakeTailWithoutATerminatorIsRefused = {
  id: "an-mcp-handshake-tail-without-a-terminator-is-refused",
  what: "unterminated MCP handshake input past the pending bound is refused rather than buffered",
  file: "src/daemon/agentcpd.ts",
  find: "        if (buffer.length > MAX_MCP_PENDING_BYTES) return reject();\n",
  replace: "",
  killedBy: [
    "tests/unit/an-mcp-line-limit-bounds-one-line.test.ts::refuses a handshake that never terminates its line rather than buffering it without bound",
  ],
};

export default anMcpHandshakeTailWithoutATerminatorIsRefused;
