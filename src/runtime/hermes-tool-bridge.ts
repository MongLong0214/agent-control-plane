#!/usr/bin/env node
/**
 * The pipe Hermes spawns so it can call ACP's tools — and it carries no credential.
 *
 * Hermes attaches to MCP servers by spawning a command and speaking MCP over its stdio
 * (`mcp_servers:` in `~/.hermes/config.yaml`). ACP's MCP server is on a unix socket and admits
 * a caller only after `{ token, sessionId, sessionSecret }`, and the secret exists in exactly
 * one place: the CEO runtime process that received it from the bootstrap. Nothing else can
 * produce it, and writing it somewhere a second process could read would make every reader of
 * that file the CEO.
 *
 * So this bridge holds nothing. It connects to the tool socket the CEO runtime listens on and
 * copies JSON lines in both directions. The authority stays in the runtime; this is the shape
 * of a pipe, not a client.
 *
 *   Hermes ──stdio──▶ this bridge ──unix socket──▶ CEO runtime ──authenticated──▶ agentcpd
 *
 * Whoever can reach the tool socket can call ACP tools as the CEO, which is why the runtime
 * creates it 0600 and refuses a path it does not own. That is the same trust boundary the MCP
 * socket already has; this does not widen it, and it must not be placed anywhere wider.
 *
 * Usage: hermes-tool-bridge <tool-socket-path>
 */
import { createConnection } from "node:net";

export const main = (argv: readonly string[]): number => {
  const socketPath = argv[0];
  if (!socketPath) {
    process.stderr.write("usage: hermes-tool-bridge <tool-socket-path>\n");
    return 2;
  }

  const socket = createConnection(socketPath);
  socket.on("error", (error: Error) => {
    // Said plainly, because the likely cause is "the CEO runtime is not running" and a raw
    // ENOENT reads as a broken bridge rather than an absent CEO.
    process.stderr.write(
      `cannot reach the CEO runtime's tool socket at ${socketPath}: ${error.message}\n`,
    );
    process.exit(1);
  });

  // Byte-for-byte both ways. The bridge does not parse, rewrite, or buffer whole messages: a
  // pipe that understands the protocol is a pipe that can disagree with it, and the two ends
  // already agree.
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
  socket.on("close", () => {
    process.exit(0);
  });
  return 0;
};

const invokedDirectly = (): boolean => {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === new URL(`file://${entry}`).href;
};

if (invokedDirectly()) {
  const code = main(process.argv.slice(2));
  if (code !== 0) process.exit(code);
}
