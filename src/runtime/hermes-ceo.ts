#!/usr/bin/env node
/**
 * The CEO runtime — the process `agentctl bootstrap hermes -- <command>` spawns, and the one
 * that stays.
 *
 * `docs/reference/hermes-ceo-runtime.cjs` proves the same handshake in executable form, but it
 * performs two tool calls and exits because a test needs a terminating process. A CEO that exits
 * is not a CEO: the daemon notices the dead pid, continuity staffs the role from gpt or claude,
 * and the owner's next message is answered by something that is not Hermes.
 *
 * So this one serves. The four steps are the same:
 *
 *   1  connect to ACP_HERMES_BOOTSTRAP_SOCKET, write { runtimeNonce, runtimeProof }
 *      where runtimeProof = HMAC-SHA256(key = ACP_HERMES_BOOTSTRAP_TOKEN, msg = runtimeNonce)
 *   2  read back { ok, sessionId, sessionSecret, ... } — the only time the secret is handed over
 *   3  connect to ACP_HERMES_MCP_SOCKET, write { token, sessionId, sessionSecret }, speak MCP
 *   4  declare the `sampling` client capability in `initialize`
 *
 * What it adds is the fifth: it holds the connection and answers.
 *
 * **The owner's turn arrives as `sampling/createMessage`, and the answer has to come from
 * somewhere real.** Declaring the capability and then replying with a canned string is worse
 * than not declaring it — the owner gets an answer nobody wrote. So the reply source is a
 * command this runtime runs, and the deployment says what it is: `--reply-command hermes -z`
 * makes Hermes the CEO, which is the point of the whole path.
 *
 * The session secret stays in memory for the life of this process. It is never written to a
 * file, an argument, an environment variable a child inherits, or a log line.
 */
import { spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { createConnection, type Socket } from "node:net";

/** How long the reply source may take before the owner is told nobody answered. */
const DEFAULT_REPLY_TIMEOUT_MS = 120_000;
/** A closed MCP socket is usually a daemon restart, so the runtime waits and reattaches. */
const RECONNECT_DELAY_MS = 2_000;

export interface CeoSession {
  sessionId: string;
  sessionSecret: string;
  bindingGeneration: number;
}

const line = (socket: Socket, body: unknown): void => {
  socket.write(`${JSON.stringify(body)}\n`);
};

/**
 * Reads newline-delimited JSON off a socket. A partial chunk is held rather than parsed: the
 * transport guarantees one JSON document per line and nothing about how the kernel splits them.
 */
const readLines = (socket: Socket, onValue: (value: Record<string, unknown>) => void): void => {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    let boundary = buffer.indexOf("\n");
    while (boundary >= 0) {
      const text = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 1);
      if (text.trim()) {
        try {
          onValue(JSON.parse(text) as Record<string, unknown>);
        } catch {
          // Not a JSON line. The transport does not produce these, and tearing down a live CEO
          // connection over a byte nobody claimed is worse than ignoring it.
        }
      }
      boundary = buffer.indexOf("\n");
    }
  });
};

export const handshake = (socketPath: string, token: string): Promise<CeoSession> =>
  new Promise((resolve, reject) => {
    // Fresh per connection. A fixed nonce would make the proof replayable by anyone who saw one
    // exchange, and the door accepts exactly one proof per connection.
    const runtimeNonce = randomBytes(24).toString("hex");
    const runtimeProof = createHmac("sha256", token).update(runtimeNonce, "utf8").digest("hex");
    const socket = createConnection(socketPath, () => line(socket, { runtimeNonce, runtimeProof }));
    socket.once("error", reject);
    readLines(socket, (value) => {
      if (value["ok"] !== true) {
        reject(new Error(`bootstrap refused: ${String(value["reasonCode"] ?? "unknown")}`));
        socket.destroy();
        return;
      }
      resolve({
        sessionId: String(value["sessionId"]),
        sessionSecret: String(value["sessionSecret"]),
        bindingGeneration: Number(value["bindingGeneration"]),
      });
      socket.end();
    });
  });

/**
 * Runs the reply source and returns what it printed. stdout is the answer, which is why
 * `hermes -z` fits: it prints the final response text and nothing else.
 */
const askReplySource = (
  command: readonly string[],
  prompt: string,
  timeoutMs: number,
): Promise<string> =>
  new Promise((resolve, reject) => {
    const [executable, ...args] = command;
    if (!executable) {
      reject(new Error("no reply command configured"));
      return;
    }
    const child = spawn(executable, [...args, prompt], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`reply source did not answer within ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      err += chunk.slice(0, 2_000);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(out.trim());
        return;
      }
      // The stderr tail travels because a reply source that fails silently is indistinguishable
      // from one that answered with nothing, and the owner can tell those apart.
      reject(new Error(`reply source exited ${String(code)}: ${err.trim().slice(0, 300)}`));
    });
  });

/** The owner's words, however the sampling request shaped them. */
export const promptFrom = (params: unknown): string => {
  const messages = (params as { messages?: unknown })?.messages;
  if (!Array.isArray(messages)) return "";
  return messages
    .map((message) => {
      const content = (message as { content?: unknown }).content;
      if (typeof content === "string") return content;
      if (Array.isArray(content)) {
        return content.map((part) => String((part as { text?: unknown }).text ?? "")).join("");
      }
      return String((content as { text?: unknown } | undefined)?.text ?? "");
    })
    .filter((text) => text.length > 0)
    .join("\n\n");
};

export interface ServeOptions {
  mcpSocketPath: string;
  mcpToken: string;
  replyCommand: readonly string[];
  replyTimeoutMs?: number;
  clientName?: string;
  /** Reattach after the socket closes. False makes one attachment observable in a test. */
  reattach?: boolean;
  onAttached?: (attempt: number) => void;
}

/**
 * Holds one MCP attachment open and answers on it. Returns when the socket closes and
 * reattachment is off; otherwise it reattaches and keeps going.
 */
export const serve = async (session: CeoSession, options: ServeOptions): Promise<void> => {
  const replyTimeoutMs = options.replyTimeoutMs ?? DEFAULT_REPLY_TIMEOUT_MS;
  const clientName = options.clientName ?? "hermes-ceo";
  for (let attempt = 1; ; attempt += 1) {
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection(options.mcpSocketPath);
      socket.once("error", reject);
      socket.on("connect", () => {
        // The deployment token says this caller may reach the socket; the session secret says
        // which session is calling. Both, every attachment — the daemon re-verifies the secret,
        // the incarnation, the lifecycle and the binding generation on every request.
        line(socket, {
          token: options.mcpToken,
          sessionId: session.sessionId,
          sessionSecret: session.sessionSecret,
        });
        line(socket, {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            // Declared here, in this request, on this connection. Without it the daemon answers
            // ordinary owner conversation with CEO_CONVERSATION_UNSUPPORTED while every tool
            // call still works — the failure that looks like nothing is wrong.
            capabilities: { sampling: {} },
            clientInfo: { name: clientName, version: "1" },
          },
        });
        line(socket, { jsonrpc: "2.0", method: "notifications/initialized", params: {} });
        options.onAttached?.(attempt);
      });
      readLines(socket, (value) => {
        if (value["method"] !== "sampling/createMessage") return;
        const id = value["id"];
        void askReplySource(options.replyCommand, promptFrom(value["params"]), replyTimeoutMs)
          .then((text) => {
            line(socket, {
              jsonrpc: "2.0",
              id,
              result: {
                model: clientName,
                role: "assistant",
                content: { type: "text", text },
              },
            });
          })
          // A refusal the owner can read beats a turn held open until the budget expires and the
          // daemon reports that the CEO did not answer in time.
          .catch((error: Error) => {
            line(socket, {
              jsonrpc: "2.0",
              id,
              error: { code: -32_000, message: `CEO reply source failed: ${error.message}` },
            });
          });
      });
      socket.on("close", () => resolve());
    });

    if (options.reattach === false) return;
    // The daemon restarted, or the binding moved. Reattaching with the same secret is what the
    // protocol requires; if the session is gone the daemon refuses and the next attempt errors
    // out rather than spinning forever.
    await new Promise((resolve) => setTimeout(resolve, RECONNECT_DELAY_MS));
  }
};

export const main = async (argv: readonly string[]): Promise<number> => {
  const replyAt = argv.indexOf("--reply-command");
  const replyCommand = replyAt === -1 ? ["hermes", "-z"] : argv.slice(replyAt + 1);
  if (replyCommand.length === 0) {
    process.stderr.write("--reply-command needs a command to run\n");
    return 2;
  }
  const bootstrapSocket = process.env["ACP_HERMES_BOOTSTRAP_SOCKET"];
  const bootstrapToken = process.env["ACP_HERMES_BOOTSTRAP_TOKEN"];
  const mcpSocketPath = process.env["ACP_HERMES_MCP_SOCKET"];
  const mcpToken = process.env["ACP_MCP_TOKEN"];
  if (!bootstrapSocket || !bootstrapToken || !mcpSocketPath || !mcpToken) {
    process.stderr.write("this runtime must be spawned by `agentctl bootstrap hermes`\n");
    return 2;
  }

  try {
    const session = await handshake(bootstrapSocket, bootstrapToken);
    // The generation is the one fact worth printing. The secret is not printed, logged, or
    // written anywhere — it lives in this process and dies with it.
    process.stdout.write(
      `${JSON.stringify({ ceo: "attached", bindingGeneration: session.bindingGeneration })}\n`,
    );
    await serve(session, { mcpSocketPath, mcpToken, replyCommand });
    return 0;
  } catch (error) {
    process.stderr.write(`${String(error instanceof Error ? error.message : error).slice(0, 300)}\n`);
    return 1;
  }
};

const invokedDirectly = (): boolean => {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === new URL(`file://${entry}`).href;
};

if (invokedDirectly()) {
  void main(process.argv.slice(2)).then((code) => {
    process.exit(code);
  });
}
