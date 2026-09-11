/**
 * stdout is Claude Code's MCP input; a `{"ok":false,...}` refusal body is not JSON-RPC and has no
 * business there. Deleting the exit forwards the daemon's refusal onto the client's parser and
 * loses the reason code, leaving the operator with a dead server and no stated cause.
 */
const attachRelayRefusalNotForwarded = {
  id: "attach-relay-refusal-not-forwarded",
  what: "a refused handshake exits with its reason code instead of reaching the client's stdout",
  file: "src/cli/attach-relay.ts",
  find: "        io.stderr.write(`attach: handshake refused ${reply.reasonCode}\\n`);\n        return finish(ATTACH_EXIT.HANDSHAKE_REFUSED);\n",
  replace: "",
  killedBy: ["tests/unit/attach-relay.test.ts::exits on a refused handshake with the daemon's reason code and writes no byte to stdout"],
};

export default attachRelayRefusalNotForwarded;
