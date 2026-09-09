/**
 * #805. The second of the two bounds, and the only one about buffering. A per-line check alone
 * never fires for a peer that never writes a newline: there is no line to measure, so the buffer
 * grows for as long as the connection lasts.
 */
const anMcpTailWithoutATerminatorIsRefused = {
  id: "an-mcp-tail-without-a-terminator-is-refused",
  what: "unterminated MCP input past the pending bound is refused rather than buffered",
  file: "src/daemon/agentcpd.ts",
  find: "    if (this.#buffer.length > MAX_MCP_PENDING_BYTES) {\n      this.error(new Error(\"MCP message exceeds local transport limit before its terminator\"));\n      this.socket.destroy();\n    }\n",
  replace: "",
  killedBy: [
    "tests/unit/an-mcp-line-limit-bounds-one-line.test.ts::refuses input that never terminates a line rather than buffering it without bound",
  ],
};

export default anMcpTailWithoutATerminatorIsRefused;
