/**
 * The daemon reads the first line on `cto.mcp.sock` as the credential. Without this write, the
 * first line is Claude Code's own `initialize`, the token check fails against it, and the socket
 * is refused `MCP_PEER_UNAUTHENTICATED` — which is exactly the RED this unit was written against.
 * A relay that piped bytes correctly but skipped the handshake would look like working code.
 */
const attachRelayHandshakeFirst = {
  id: "attach-relay-handshake-first",
  what: "the relay's handshake line precedes every byte of the client's",
  file: "src/cli/attach-relay.ts",
  find: "      socket.write(\n        `${JSON.stringify({\n          token: options.mcpToken,\n          sessionId: claimed.sessionId,\n          sessionSecret: claimed.sessionSecret,\n        })}\\n`,\n      );\n",
  replace: "",
  killedBy: ["tests/unit/attach-relay.test.ts::attaches the claimed session and carries the client's own initialize to the daemon"],
};

export default attachRelayHandshakeFirst;
