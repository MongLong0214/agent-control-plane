#!/usr/bin/env node
/**
 * The CEO runtime — the process `agentctl bootstrap hermes -- <command>` spawns, and the one
 * that stays.
 *
 * `tests/fixtures/hermes-ceo-reference.cjs` proves the same handshake in executable form, but it
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
 * command this runtime runs, and the deployment says what it is.
 *
 * **That command has to deliver the turn into an existing conversation.**
 * `--reply-command hermes -z` was the documented deployment and it is wrong: `-z` is a one-shot,
 * so turn two reaches a process that never saw turn one. It does make Hermes answer, which is
 * why it read as correct; what it does not make is *the same* Hermes.
 *
 * `-z` cannot be repaired with a flag. Hermes calls `declare_stateless_channel()` on that path
 * and its own source names it — *"a one-shot runner that exits after its final response
 * (`hermes -z`, cron)"*. `--resume` does not reach it either: `-z` dispatches through
 * `_run_and_exit_oneshot`, which takes no session argument and returns before resume is applied.
 * The stateful entry point is `chat`, which accepts both:
 *
 *     --reply-command hermes chat --resume <session-id> -q
 *
 * `-q` last, because `askReplySource` appends the prompt to the end of the line. The session id
 * is the owner's existing conversation, not a new one. This is the same rule `SSOT.md:99` states
 * for Buzz — a surface reaches the CEO by delivering a turn into the canonical session, never by
 * starting a second one to answer for it.
 *
 * The session secret stays in memory for the life of this process. It is never written to a
 * file, an argument, an environment variable a child inherits, or a log line.
 */
import { spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { chmodSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";

/**
 * Named once so the two ways of omitting it — no flag, or the flag with nothing after it —
 * answer identically. They are the same operator mistake.
 *
 * The example ends in `-q` on purpose: `askReplySource` appends the prompt to the end of the
 * line, so a command ending in `--resume` would receive the prompt as the session id and the
 * real prompt would never be asked.
 */
const REPLY_COMMAND_REQUIRED =
  "--reply-command is required, and it has to deliver the turn into an existing session:\n" +
  "  --reply-command hermes chat --resume <session-id> -q\n" +
  "A one-shot (`hermes -z`) starts a new conversation on every turn, so the CEO would not\n" +
  "remember the owner's previous message. `-z` cannot be pinned: Hermes declares that path\n" +
  "stateless and it ignores --resume. `chat` is the entry point that resumes.\n";

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

/**
 * The tool socket: MCP served to Hermes, forwarded to ACP over the connection that is already
 * authenticated.
 *
 * Hermes is a client here, so its `initialize` is answered by this runtime — forwarding it would
 * put a second initialize on a connection ACP has already initialized, and the two sides would
 * disagree about which handshake they are in. Only `tools/list` and `tools/call` travel.
 *
 * Ids are rewritten. Hermes numbers its requests from 1 and so does this runtime, so passing
 * them through would let Hermes's `id: 1` collide with the initialize this runtime already sent
 * — and the reply to one would be read as the reply to the other.
 */
const openToolSocket = (path: string, upstream: Socket, clientName: string): { close(): void } => {
  // A stale socket from a previous run would make `listen` fail with EADDRINUSE and take the CEO
  // down with it. Removing our own path is safe; the runtime is the only writer of it.
  rmSync(path, { force: true });
  const pending = new Map<number, { socket: Socket; theirId: unknown }>();
  let nextId = 1_000;

  const routeUpstream = (value: Record<string, unknown>): void => {
    const id = value["id"];
    if (typeof id !== "number") return;
    const waiting = pending.get(id);
    if (!waiting) return;
    pending.delete(id);
    if (!waiting.socket.destroyed) line(waiting.socket, { ...value, id: waiting.theirId });
  };
  readLines(upstream, routeUpstream);

  const server: Server = createServer((client) => {
    readLines(client, (value) => {
      const method = String(value["method"] ?? "");
      const theirId = value["id"];
      if (method === "initialize") {
        // Answered here. This runtime is the MCP server Hermes talks to; ACP is upstream of it.
        line(client, {
          jsonrpc: "2.0",
          id: theirId,
          result: {
            protocolVersion: "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: `${clientName}-tools`, version: "1" },
          },
        });
        return;
      }
      if (method === "notifications/initialized") return;
      if (method !== "tools/list" && method !== "tools/call") {
        if (theirId === undefined) return;
        // Refused by name rather than forwarded. A method this bridge does not understand is one
        // ACP did not agree to receive on the CEO's authenticated connection.
        line(client, {
          jsonrpc: "2.0",
          id: theirId,
          error: { code: -32_601, message: `the CEO tool bridge does not forward ${method}` },
        });
        return;
      }
      const ourId = nextId;
      nextId += 1;
      pending.set(ourId, { socket: client, theirId });
      line(upstream, { ...value, id: ourId });
    });
    client.on("close", () => {
      for (const [ourId, waiting] of pending) {
        if (waiting.socket === client) pending.delete(ourId);
      }
    });
  });
  server.listen(path, () => {
    // Whoever can reach this socket calls ACP tools as the CEO. Same trust boundary as the MCP
    // socket itself, and it must not be widened by a permissive default.
    chmodSync(path, 0o600);
  });
  return {
    close: () => {
      server.close();
      rmSync(path, { force: true });
    },
  };
};

export interface ServeOptions {
  mcpSocketPath: string;
  mcpToken: string;
  replyCommand: readonly string[];
  replyTimeoutMs?: number;
  clientName?: string;
  /**
   * Where Hermes reaches ACP's tools. The runtime listens here and forwards; the bridge Hermes
   * spawns holds no credential, because the session secret exists only in this process.
   */
  toolSocketPath?: string;
  onToolSocketReady?: (path: string) => void;
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
  let tools: { close(): void } | null = null;
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
      if (options.toolSocketPath) {
        tools = openToolSocket(options.toolSocketPath, socket, clientName);
        options.onToolSocketReady?.(options.toolSocketPath);
      }
      socket.on("close", () => resolve());
    }).finally(() => {
      tools?.close();
      tools = null;
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
  // `--reply-command` takes the rest of the line, so anything after it would be swallowed as
  // arguments to the reply source. The other flags are read from the part before it.
  //
  // There is deliberately no default. It used to be `hermes -z`, which starts a *fresh* Hermes
  // for every turn: the owner's second message reaches something that never saw the first. The
  // damage is visible in the session store — eleven days of one-shot spawns left a row of
  // abandoned sessions beside the one real conversation.
  //
  // A CEO that answers from a new stranger each turn is worse than an unbound role, because
  // `doctor` reports CEO_ROLE_UNBOUND for the unbound one and nothing at all for this one. So
  // the operator has to name the session, and the runtime will not guess it.
  if (replyAt === -1) {
    process.stderr.write(REPLY_COMMAND_REQUIRED);
    return 2;
  }
  const replyCommand = argv.slice(replyAt + 1);
  const flags = argv.slice(0, replyAt);
  if (replyCommand.length === 0) {
    process.stderr.write(REPLY_COMMAND_REQUIRED);
    return 2;
  }
  const toolAt = flags.indexOf("--tool-socket");
  const toolSocketPath = toolAt === -1 ? undefined : flags[toolAt + 1];
  if (toolAt !== -1 && !toolSocketPath) {
    process.stderr.write("--tool-socket needs a path\n");
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
    await serve(session, { mcpSocketPath, mcpToken, replyCommand, toolSocketPath });
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
