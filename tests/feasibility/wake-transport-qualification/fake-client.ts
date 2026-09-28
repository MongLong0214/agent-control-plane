/**
 * A stand-in for the client, for the rows that drive the probe where no client is installed.
 *
 * Not a model of Claude Code and not evidence about it. It exists so the probe's own decisions --
 * what it starts, and what it refuses to proceed without -- can be exercised offline, at the two
 * boundaries the probe actually crosses: the process it starts, and the requests that reach the
 * capture. Everything else in the probe is real when this runs: the fake provider, the temp root,
 * the unix socket, the wake frame, the teardown.
 *
 * It learns where to bind the way the real client does, from `--messaging-socket-path` in its own
 * argv, so a row can assert that the argv it received is the invocation the reading records.
 *
 * `ACP_FAKE_CLIENT_TURN` is the user text it sends as its first turn; a row sets it to something
 * other than the prompt to measure what the probe does when its prompt never becomes a turn.
 */
import { createServer } from "node:net";

const argv = process.argv.slice(2);
const socketPath = argv[argv.indexOf("--messaging-socket-path") + 1];
const baseUrl = process.env.ANTHROPIC_BASE_URL ?? "";
const firstTurn = process.env.ACP_FAKE_CLIENT_TURN ?? "ping";

const turn = async (text: string): Promise<void> => {
  await fetch(`${baseUrl}/v1/messages?beta=true`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY ?? "" },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      system: [{ type: "text", text: "You are Claude Code." }],
      messages: [{ role: "user", content: [{ type: "text", text }] }],
    }),
  });
};

if (typeof socketPath !== "string" || socketPath.length === 0) {
  process.stderr.write("the fake client was started without --messaging-socket-path\n");
  process.exit(2);
}

// The peer message is rendered into prose before it reaches model input, which is what the real
// runtime does and what the wake count is written for: the token arrives embedded, never alone.
const server = createServer((socket) => {
  let frame = "";
  socket.on("data", (chunk: Buffer) => {
    frame += chunk.toString("utf8");
  });
  socket.on("end", () => {
    void turn(`Another Claude session sent a message:\n${frame}\nRead your inbox.`);
  });
});

server.listen(socketPath, () => {
  void turn(firstTurn);
});

// Held open the way a session is, so the probe's own teardown is what ends it.
process.stdin.resume();
