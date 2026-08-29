import { createConnection } from "node:net";

/**
 * A standalone client process for `tests/unit/g5-peercred.test.ts`. Its only job is to exist as a
 * distinct OS process connected to a socket the test's own process is listening on, so the test
 * can assert the kernel reports *this* process's pid/uid/gid as the peer — not the test runner's
 * own. Spawned with `spawn(process.execPath, ["--import", "tsx", ...])`, the same convention
 * `tests/helpers/run-agentcpd-main.ts` and `tests/unit/daemon-startup.test.ts` already use.
 *
 * Deliberately minimal: it connects and then does nothing else. The open, connected socket keeps
 * the event loop alive on its own, so this process stays up — and stays the same pid — until the
 * parent test kills it during cleanup. That staying-alive is the point: a client that already
 * exited before the parent reads peer credentials would prove nothing about a live peer.
 */
const socketPath = process.argv[2];
if (!socketPath) throw new Error("peercred-client requires a socket path as its first argument");

const socket = createConnection(socketPath);
socket.on("error", (error) => {
  process.stderr.write(`peercred-client: connection error: ${(error as Error).message}\n`);
  process.exit(1);
});
socket.on("connect", () => {
  // Synchronization point for the parent: once this line is written, the kernel has completed
  // the connection this process's own credentials will be read off of.
  process.stdout.write("peercred-client: connected\n");
});
