/**
 * #805. Moving the bound behind the boundary is only correct while it still refuses. Without this
 * arm a line of any length is parsed and delivered, and the limit is a comment.
 */
const anMcpLineOverTheLimitIsRefused = {
  id: "an-mcp-line-over-the-limit-is-refused",
  what: "a single MCP line longer than the limit is refused and the socket destroyed",
  file: "src/daemon/agentcpd.ts",
  find: "      if (boundary > MAX_MCP_LINE_BYTES) {\n        this.error(new Error(\"MCP message exceeds local transport limit\"));\n        this.socket.destroy();\n        return;\n      }\n",
  replace: "",
  killedBy: [
    "tests/unit/an-mcp-line-limit-bounds-one-line.test.ts::refuses a single line longer than the limit",
  ],
};

export default anMcpLineOverTheLimitIsRefused;
