/**
 * #805. The bound has to be read after the boundary, against the line the boundary ends. Compared
 * against everything buffered, it refuses two legal messages whenever one read delivered both —
 * an outcome decided by where the kernel split the stream rather than by anything either peer did.
 */
const anMcpLineLimitIsMeasuredPerLine = {
  id: "an-mcp-line-limit-is-measured-per-line",
  what: "the MCP transport limit is compared against one line's bytes, not against the whole read",
  file: "src/daemon/agentcpd.ts",
  find: "      if (boundary > MAX_MCP_LINE_BYTES) {\n        this.error(new Error(\"MCP message exceeds local transport limit\"));",
  replace: "      if (this.#buffer.length > MAX_MCP_LINE_BYTES) {\n        this.error(new Error(\"MCP message exceeds local transport limit\"));",
  killedBy: [
    "tests/unit/an-mcp-line-limit-bounds-one-line.test.ts::delivers two legal messages that arrived in a single read",
  ],
};

export default anMcpLineLimitIsMeasuredPerLine;
