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
 *
 * `ACP_FAKE_CLIENT_PRE_WAKE_TURN` is a second turn sent *before the socket is bound*, and
 * `ACP_FAKE_CLIENT_IGNORES_FRAME` makes it read an arriving frame and answer nothing. Together they
 * are the session a reviewer built the boundary defect out of: one that takes a turn carrying the
 * wake token of its own accord, before any frame exists, and then ignores the frame it is sent.
 */
import { createServer } from "node:net";

const argv = process.argv.slice(2);
const socketPath = argv[argv.indexOf("--messaging-socket-path") + 1];
const baseUrl = process.env.ANTHROPIC_BASE_URL ?? "";
const firstTurn = process.env.ACP_FAKE_CLIENT_TURN ?? "ping";
const preWakeTurn = process.env.ACP_FAKE_CLIENT_PRE_WAKE_TURN ?? "";
const ignoresFrame = process.env.ACP_FAKE_CLIENT_IGNORES_FRAME === "1";

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
    // A session that reads the frame and takes no turn is a build that ignores the wake, which is
    // the one the boundary exists to refuse. The frame is still consumed, so the probe's write
    // completes either way and the difference is the turn, not the transport.
    if (ignoresFrame) return;
    void turn(`Another Claude session sent a message:\n${frame}\nRead your inbox.`);
  });
});

// Every turn this client takes on its own is sent, and awaited, *before* the socket appears. The
// probe waits for the socket before it waits for the baseline, and reads its boundary after the
// baseline -- so binding last is what makes "these turns preceded the frame" a fact about the
// capture rather than a race against the probe's next poll.
void (async () => {
  await turn(firstTurn);
  if (preWakeTurn.length > 0) await turn(preWakeTurn);
  server.listen(socketPath);
})();

// Held open the way a session is, so the probe's own teardown is what ends it.
process.stdin.resume();
