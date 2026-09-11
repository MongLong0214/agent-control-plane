/**
 * The restart rule is enforced by this process's lifecycle, not by the daemon: the session secret's
 * hash is durable and no server-side check can tell a pre-restart plaintext from a post-restart
 * one. A relay that did not exit when its socket closed would survive the restart still holding the
 * credential, which is the reuse path the rule forbids.
 */
const attachRelayExitOnClose = {
  id: "attach-relay-exit-on-close",
  what: "the relay exits when its mcp socket closes under it",
  file: "src/cli/attach-relay.ts",
  find: "    socket.once(\"close\", () => finish(stdinEnded ? ATTACH_EXIT.OK : ATTACH_EXIT.STREAM_CLOSED));",
  replace: "    socket.once(\"close\", () => undefined);",
  killedBy: ["tests/unit/attach-relay.test.ts::exits when the socket closes under it, and opens exactly one connection in its lifetime"],
};

export default attachRelayExitOnClose;
