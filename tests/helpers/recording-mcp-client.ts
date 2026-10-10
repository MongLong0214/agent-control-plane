import type { Readable, Writable } from "node:stream";

/** One JSON-RPC line as the client parsed it. */
export interface RecordedWire {
  id?: unknown;
  method?: string;
  result?: { tools?: Array<{ name: string }>; structuredContent?: Record<string, unknown> };
  error?: { code?: number; message?: string };
}

/** What the client did when a `notifications/tools/list_changed` reached it. */
export interface ListChangedRefresh {
  /** Position of the notification in `received`. */
  notification: number;
  /** The answer to the `tools/list` the client sent the moment it parsed the notification. */
  answer: RecordedWire;
}

export const LIST_CHANGED = "notifications/tools/list_changed";

/**
 * An MCP client on a relay's stdio that records every line it is sent — notifications included,
 * which the relay tests' own clients drop — and does what Claude Code does on
 * `notifications/tools/list_changed`: asks `tools/list` at once, on receipt, and keeps the answer.
 *
 * `separateProcess` is for a relay run in this process over in-memory streams. A real client is
 * another process across a pipe, so it can never answer inside the relay's own turn of the event
 * loop; in-memory streams can deliver synchronously, and a client answering from there would be
 * measuring the stream, not the relay. Deferring each chunk by one `setImmediate` restores the
 * pipe's ordering. A child process's stdout is already a pipe and needs nothing.
 */
export const recordingMcpClient = (
  io: { stdin: Writable; stdout: Readable },
  options: { separateProcess?: boolean; requestTimeoutMs?: number } = {},
) => {
  const timeoutMs = options.requestTimeoutMs ?? 20_000;
  const received: RecordedWire[] = [];
  const refreshes: ListChangedRefresh[] = [];
  const pending = new Map<string, (message: RecordedWire) => void>();
  let nextId = 1;
  let held = "";

  const request = (method: string, params: unknown): Promise<RecordedWire> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const key = JSON.stringify(id);
      const timer = setTimeout(() => {
        pending.delete(key);
        reject(new Error(`timeout awaiting ${method}`));
      }, timeoutMs);
      pending.set(key, (message) => {
        clearTimeout(timer);
        pending.delete(key);
        resolve(message);
      });
      io.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });

  const parse = (chunk: string): void => {
    held += chunk;
    for (let newline = held.indexOf("\n"); newline >= 0; newline = held.indexOf("\n")) {
      const message = JSON.parse(held.slice(0, newline)) as RecordedWire;
      held = held.slice(newline + 1);
      const position = received.push(message) - 1;
      if (message.id === undefined && message.method === LIST_CHANGED) {
        void request("tools/list", {}).then(
          (answer) => refreshes.push({ notification: position, answer }),
          (err: unknown) => refreshes.push({ notification: position, answer: { error: { message: String(err) } } }),
        );
        continue;
      }
      if (message.id !== undefined && message.method === undefined) pending.get(JSON.stringify(message.id))?.(message);
    }
  };
  io.stdout.on("data", (chunk: Buffer | string) => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (options.separateProcess) setImmediate(() => parse(text));
    else parse(text);
  });

  return {
    received,
    refreshes,
    request,
    notify: (method: string) => io.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`),
    /** Every `list_changed` the client was sent, by position in `received`. */
    listChanged: (): number[] =>
      received.flatMap((message, index) => (message.id === undefined && message.method === LIST_CHANGED ? [index] : [])),
    /** `initialize` under `clientInfo`, then `notifications/initialized`, as Claude Code starts. */
    initialize: async (clientInfo: unknown): Promise<RecordedWire> => {
      const init = await request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo });
      io.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
      return init;
    },
  };
};

export type RecordingMcpClient = ReturnType<typeof recordingMcpClient>;

/** The names a `tools/list` answer carries; empty for an error. */
export const toolNames = (answer: RecordedWire): string[] => (answer.result?.tools ?? []).map((tool) => tool.name);
