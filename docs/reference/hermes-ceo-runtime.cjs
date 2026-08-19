/**
 * A working CEO runtime — the executable form of the Hermes bootstrap and MCP handshake.
 *
 * This is what `agentctl bootstrap hermes -- <command>` expects on the other end. It is not a
 * mock: `tests/process/hermes-bootstrap-process.test.ts` spawns this exact file, so it cannot
 * drift from the protocol without a test going red.
 *
 * It exists because the handshake was previously readable only as a string literal inside that
 * test. Whoever writes the real Hermes client needs the protocol, and prose describing a wire
 * format is a second copy that stops matching the first one.
 *
 * The four steps:
 *
 *   1  connect to ACP_HERMES_BOOTSTRAP_SOCKET and write one JSON line:
 *        { runtimeNonce, runtimeProof }
 *      where runtimeProof = HMAC-SHA256(key = ACP_HERMES_BOOTSTRAP_TOKEN, msg = runtimeNonce),
 *      hex. One proof per connection, nothing after the newline, 64 KB and 5 s limits.
 *
 *   2  read one JSON line back:
 *        { ok, sessionId, sessionIncarnation, bindingGeneration, runtimePid, sessionSecret }
 *      This is the only place a session secret is written outside SessionRegistry.create.
 *      Hold it in memory; it is the runtime's identity for the life of the session.
 *
 *   3  connect to ACP_HERMES_MCP_SOCKET and write one JSON line:
 *        { token: ACP_MCP_TOKEN, sessionId, sessionSecret }
 *      then speak MCP over the same socket. The deployment token says the caller may reach the
 *      socket; the session secret says which session is calling, and every request re-verifies
 *      it against the binding generation the socket was admitted under.
 *
 *   4  declare the `sampling` client capability. Ordinary owner conversation arrives that way
 *      (`Server.createMessage`); without it the daemon answers CEO_CONVERSATION_UNSUPPORTED.
 *
 * A real Hermes would keep the connection open and serve. This one performs two tool calls and
 * exits, because a test needs a terminating process — that is the only difference.
 *
 * Usage: node hermes-ceo-runtime.cjs <pidPath> <continuePath> <secretPath> <resultPath>
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const pidPath = process.argv[2];
const continuePath = process.argv[3];
const secretPath = process.argv[4];
const resultPath = process.argv[5];
fs.writeFileSync(pidPath, String(process.pid));

const waitForFile = (path) => new Promise((resolve) => {
  const timer = setInterval(() => {
    if (fs.existsSync(path)) {
      clearInterval(timer);
      resolve();
    }
  }, 25);
});

const oneLine = (socket, body) => socket.write(JSON.stringify(body) + "\n");
const bootstrap = () => new Promise((resolve, reject) => {
  const socketPath = process.env.ACP_HERMES_BOOTSTRAP_SOCKET;
  const token = process.env.ACP_HERMES_BOOTSTRAP_TOKEN;
  const nonce = "process-runtime-possession-nonce-123";
  const proof = crypto.createHmac("sha256", token).update(nonce).digest("hex");
  const socket = net.createConnection(socketPath, () => {
    oneLine(socket, { runtimeNonce: nonce, runtimeProof: proof });
  });
  let received = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    received += chunk;
    const boundary = received.indexOf("\n");
    if (boundary === -1) return;
    const response = JSON.parse(received.slice(0, boundary));
    if (!response.ok) return reject(new Error("bootstrap denied: " + response.reasonCode));
    resolve({ sessionId: response.sessionId, sessionSecret: response.sessionSecret });
  });
  socket.on("error", reject);
});

const mcp = (sessionId, sessionSecret) => new Promise((resolve, reject) => {
  const socket = net.createConnection(process.env.ACP_HERMES_MCP_SOCKET);
  const responses = new Map();
  let received = "";
  let finished = false;
  const finish = (value, error) => {
    if (finished) return;
    finished = true;
    if (error) reject(error);
    else resolve(value);
  };
  const timer = setTimeout(() => finish(null, new Error("MCP response timed out")), 30_000);
  const inspect = () => {
    for (const line of received.split("\n")) {
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line);
        // Declaring `sampling` and then not answering is worse than not declaring it: the
        // daemon holds the owner's turn open until the conversation budget expires and the
        // owner is told the CEO did not answer in time. A real Hermes puts its own reply here.
        if (value && value.method === "sampling/createMessage") {
          oneLine(socket, {
            jsonrpc: "2.0",
            id: value.id,
            result: {
              model: "hermes-ceo-reference",
              role: "assistant",
              content: { type: "text", text: "reference runtime acknowledges the owner's turn" },
            },
          });
          continue;
        }
        if (value && value.id !== undefined) responses.set(value.id, value);
      } catch {
        // The transport only emits JSON lines; incomplete chunks are handled below.
      }
    }
    if (responses.has(2) && responses.has(3)) {
      clearTimeout(timer);
      socket.end();
      finish({ project: responses.get(2), doctor: responses.get(3) });
    }
    if (received.includes("MCP_PEER_UNAUTHENTICATED")) {
      clearTimeout(timer);
      socket.destroy();
      finish(null, new Error("normal Hermes MCP authentication was refused"));
    }
  };
  socket.setEncoding("utf8");
  socket.on("connect", () => {
    oneLine(socket, {
      token: process.env.ACP_MCP_TOKEN,
      sessionId,
      sessionSecret,
    });
    // `sampling` is declared here, in the initialize request, on this same connection — it is
    // not a later step and not a second socket. Without it the daemon answers every ordinary
    // owner message with CEO_CONVERSATION_UNSUPPORTED, and a client copied from an example that
    // omitted it would look correct while the owner's conversation went nowhere.
    oneLine(socket, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: { sampling: {} },
        clientInfo: { name: "hermes-ceo-reference", version: "1" },
      },
    });
    oneLine(socket, { jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    oneLine(socket, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "project_get", arguments: { projectId: "fresh-install-project" } },
    });
    oneLine(socket, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "doctor_run", arguments: { scope: "system" } },
    });
  });
  socket.on("data", (chunk) => {
    received += chunk;
    inspect();
  });
  socket.on("error", (error) => {
    clearTimeout(timer);
    finish(null, error);
  });
  socket.on("close", () => {
    if (!finished) {
      clearTimeout(timer);
      finish(null, new Error("MCP socket closed before authenticated tool responses"));
    }
  });
});

// The handshake returns the secret before the daemon restart. The runtime retains it only
// in this process and never writes it to stdout, stderr, an audit record, or the result file.
bootstrap().then(async ({ sessionId, sessionSecret }) => {
  fs.writeFileSync(secretPath, sessionSecret, { mode: 0o600 });
  await waitForFile(continuePath);
  const result = await mcp(sessionId, sessionSecret);
  const projectText = JSON.stringify(result.project);
  const doctorText = JSON.stringify(result.doctor);
  fs.writeFileSync(resultPath, JSON.stringify({
    projectResponseId: result.project.id,
    doctorResponseId: result.doctor.id,
    projectAuthenticated: !projectText.includes("MCP_PEER_UNAUTHENTICATED"),
    doctorAuthenticated: !doctorText.includes("MCP_PEER_UNAUTHENTICATED"),
    projectNotFound: projectText.includes("NOT_FOUND"),
  }));
  process.exit(0);
}).catch((error) => {
  fs.writeFileSync(resultPath, JSON.stringify({ error: String(error).slice(0, 200) }));
  process.exit(2);
});
