import { afterAll, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";

import { createConnection } from "node:net";

import { handshake, main, promptFrom, serve } from "../../src/runtime/hermes-ceo.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * The runtime is exercised against a socket that answers, not against itself.
 *
 * `tests/fixtures/hermes-ceo-reference.cjs` already proves the handshake by being spawned in a
 * process test. What that cannot show is the part this runtime exists for: staying attached and
 * answering the owner's turn from a real source. A test that stubbed the socket and asserted the
 * runtime's own view would pass whether or not anything went over the wire.
 */

const servers: Server[] = [];

const listening = async (onConnection: (socket: Socket) => void): Promise<string> => {
  const path = join(tempDir("ceo-rt-"), "socket");
  const server = createServer(onConnection);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return path;
};

afterAll(async () => {
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
});

/** Collects newline-delimited JSON the runtime writes. */
const lines = (socket: Socket, onValue: (value: Record<string, unknown>) => void): void => {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    let boundary = buffer.indexOf("\n");
    while (boundary >= 0) {
      const text = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 1);
      if (text.trim()) onValue(JSON.parse(text) as Record<string, unknown>);
      boundary = buffer.indexOf("\n");
    }
  });
};

const SESSION = { sessionId: "sess-1", sessionSecret: "secret-1", bindingGeneration: 1 };

/** A reply source that prints exactly what it was handed, and nothing else. */
const echoCommand = [process.execPath, "-e", "process.stdout.write(process.argv[1])"];

describe("the CEO runtime's handshake", () => {
  it("proves possession with an HMAC over a nonce it generated", async () => {
    const token = "bootstrap-token-for-the-runtime";
    let claim: Record<string, unknown> | null = null;
    const path = await listening((socket) => {
      lines(socket, (value) => {
        claim = value;
        socket.write(`${JSON.stringify({
          ok: true, sessionId: "sess-9", sessionSecret: "secret-9", bindingGeneration: 3,
        })}\n`);
      });
    });

    const session = await handshake(path, token);

    expect(session).toEqual({ sessionId: "sess-9", sessionSecret: "secret-9", bindingGeneration: 3 });
    const sent = claim as unknown as { runtimeNonce: string; runtimeProof: string };
    expect(sent.runtimeNonce.length).toBeGreaterThanOrEqual(32);
    // The proof is checked by recomputing it, not by asserting it is a 64-character string: a
    // hex-shaped value that is not this HMAC would satisfy the shape and nothing else.
    expect(sent.runtimeProof)
      .toBe(createHmac("sha256", token).update(sent.runtimeNonce, "utf8").digest("hex"));
  });

  it("reports a refusal by its reason code rather than hanging", async () => {
    const path = await listening((socket) => {
      lines(socket, () => {
        socket.write(`${JSON.stringify({ ok: false, reasonCode: "BINDING_ALREADY_ACTIVE" })}\n`);
      });
    });

    await expect(handshake(path, "t")).rejects.toThrow("BINDING_ALREADY_ACTIVE");
  });
});

describe("the CEO runtime's attachment", () => {
  it("presents both credentials and declares sampling in the initialize request", async () => {
    const seen: Record<string, unknown>[] = [];
    const path = await listening((socket) => {
      lines(socket, (value) => {
        seen.push(value);
        if (seen.length >= 3) socket.end();
      });
    });

    await serve(SESSION, {
      mcpSocketPath: path, mcpToken: "deployment-token",
      replyCommand: echoCommand, reattach: false,
    });

    // The deployment token says the caller may reach the socket; the session secret says which
    // session is calling. One without the other is not an authenticated CEO.
    expect(seen[0]).toEqual({
      token: "deployment-token", sessionId: "sess-1", sessionSecret: "secret-1",
    });
    const initialize = seen[1] as { method: string; params: { capabilities: unknown } };
    expect(initialize.method).toBe("initialize");
    // Without this the daemon answers ordinary owner conversation with
    // CEO_CONVERSATION_UNSUPPORTED while every tool call still works.
    expect(initialize.params.capabilities).toEqual({ sampling: {} });
    expect((seen[2] as { method: string }).method).toBe("notifications/initialized");
  });

  it("answers the owner's turn with what the reply source printed", async () => {
    const replies: Record<string, unknown>[] = [];
    const path = await listening((socket) => {
      lines(socket, (value) => {
        if ((value as { method?: string }).method === "notifications/initialized") {
          socket.write(`${JSON.stringify({
            jsonrpc: "2.0", id: 7, method: "sampling/createMessage",
            params: { messages: [{ role: "user", content: { type: "text", text: "은행 잔고는?" } }] },
          })}\n`);
          return;
        }
        if ((value as { id?: unknown }).id === 7) {
          replies.push(value);
          socket.end();
        }
      });
    });

    await serve(SESSION, {
      mcpSocketPath: path, mcpToken: "t", replyCommand: echoCommand, reattach: false,
    });

    // The reply is the reply source's stdout, not a string this runtime made up. A canned answer
    // would satisfy the protocol and tell the owner something nobody wrote.
    expect(replies[0]).toMatchObject({
      id: 7,
      result: { role: "assistant", content: { type: "text", text: "은행 잔고는?" } },
    });
  });

  it("tells the owner the reply source failed instead of holding the turn open", async () => {
    const replies: Record<string, unknown>[] = [];
    const path = await listening((socket) => {
      lines(socket, (value) => {
        if ((value as { method?: string }).method === "notifications/initialized") {
          socket.write(`${JSON.stringify({
            jsonrpc: "2.0", id: 8, method: "sampling/createMessage",
            params: { messages: [{ role: "user", content: { type: "text", text: "hello" } }] },
          })}\n`);
          return;
        }
        if ((value as { id?: unknown }).id === 8) {
          replies.push(value);
          socket.end();
        }
      });
    });

    await serve(SESSION, {
      mcpSocketPath: path, mcpToken: "t", reattach: false,
      // Exits non-zero and says why. Silence here is the failure that costs the most: the daemon
      // holds the owner's turn until the budget expires and then reports that the CEO did not
      // answer, which reads as the CEO being slow rather than absent.
      replyCommand: [process.execPath, "-e", "process.stderr.write('no model'); process.exit(3)"],
    });

    expect(replies[0]).toMatchObject({ id: 8 });
    expect(String((replies[0] as { error: { message: string } }).error.message))
      .toContain("CEO reply source failed");
  });
});

describe("the owner's words reach the reply source", () => {
  it("reads text out of every message shape the sampling request may use", () => {
    expect(promptFrom({ messages: [{ content: "plain" }] })).toBe("plain");
    expect(promptFrom({ messages: [{ content: { type: "text", text: "object" } }] })).toBe("object");
    expect(promptFrom({ messages: [{ content: [{ text: "a" }, { text: "b" }] }] })).toBe("ab");
    expect(promptFrom({ messages: [{ content: "one" }, { content: "two" }] })).toBe("one\n\ntwo");
    // No messages is not an empty prompt to send onward — it is nothing to ask.
    expect(promptFrom({})).toBe("");
  });
});


describe("the tool socket Hermes reaches ACP through", () => {
  /** Drives the bridge's side: connect, speak MCP, collect the replies. */
  const asHermes = async (
    socketPath: string,
    requests: readonly Record<string, unknown>[],
    until: number,
  ): Promise<Record<string, unknown>[]> => {
    const seen: Record<string, unknown>[] = [];
    await new Promise<void>((resolve, reject) => {
      const client = createConnection(socketPath);
      client.once("error", reject);
      client.on("connect", () => {
        for (const request of requests) client.write(`${JSON.stringify(request)}\n`);
      });
      lines(client, (value) => {
        seen.push(value);
        if (seen.length >= until) {
          client.end();
          resolve();
        }
      });
    });
    return seen;
  };

  const attachedRuntime = async (
    onUpstream: (socket: Socket, value: Record<string, unknown>) => void,
  ): Promise<{ toolSocketPath: string; done: Promise<void>; stop: () => void }> => {
    const toolSocketPath = join(tempDir("ceo-tools-"), "tools.sock");
    let upstreamSocket: Socket | null = null;
    const mcpPath = await listening((socket) => {
      upstreamSocket = socket;
      lines(socket, (value) => onUpstream(socket, value));
    });
    let ready: () => void = () => {};
    const attached = new Promise<void>((resolve) => { ready = resolve; });
    const done = serve(SESSION, {
      mcpSocketPath: mcpPath, mcpToken: "t", replyCommand: echoCommand,
      reattach: false, toolSocketPath, onToolSocketReady: () => ready(),
    });
    await attached;
    return { toolSocketPath, done, stop: () => upstreamSocket?.end() };
  };

  it("answers Hermes's initialize itself instead of sending a second one upstream", async () => {
    const upstream: Record<string, unknown>[] = [];
    const runtime = await attachedRuntime((_socket, value) => { upstream.push(value); });

    const replies = await asHermes(runtime.toolSocketPath, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    ], 1);
    runtime.stop();
    await runtime.done;

    expect(replies[0]).toMatchObject({ id: 1, result: { capabilities: { tools: {} } } });
    // ACP's connection was initialized once, by the runtime. Forwarding Hermes's initialize
    // would put a second handshake on a connection already past it, and the two ends would
    // disagree about which one they are in.
    const upstreamInitializes = upstream.filter((v) => v["method"] === "initialize");
    expect(upstreamInitializes).toHaveLength(1);
  });

  it("rewrites ids so Hermes cannot collide with the runtime's own request", async () => {
    const forwarded: Record<string, unknown>[] = [];
    const runtime = await attachedRuntime((socket, value) => {
      if (value["method"] !== "tools/call") return;
      forwarded.push(value);
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: value["id"], result: { ok: true } })}\n`);
    });

    // Hermes numbers from 1 and so does the runtime — its initialize is id 1. Passing this
    // through unchanged would make the reply to one readable as the reply to the other.
    const replies = await asHermes(runtime.toolSocketPath, [
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "doctor_run" } },
    ], 1);
    runtime.stop();
    await runtime.done;

    expect(forwarded[0]?.["id"]).not.toBe(1);
    // And it comes back wearing the id Hermes used, or Hermes cannot match it to its request.
    expect(replies[0]).toMatchObject({ id: 1, result: { ok: true } });
  });

  it("refuses a method it does not forward rather than passing it to ACP", async () => {
    const upstream: Record<string, unknown>[] = [];
    const runtime = await attachedRuntime((_socket, value) => { upstream.push(value); });

    const replies = await asHermes(runtime.toolSocketPath, [
      { jsonrpc: "2.0", id: 5, method: "resources/read", params: {} },
    ], 1);
    runtime.stop();
    await runtime.done;

    expect(replies[0]).toMatchObject({ id: 5 });
    expect(String((replies[0] as { error: { message: string } }).error.message))
      .toContain("does not forward");
    // A method this bridge does not understand is one ACP never agreed to receive on the CEO's
    // authenticated connection.
    expect(upstream.some((v) => v["method"] === "resources/read")).toBe(false);
  });
});

describe("the reply source the runtime is started with", () => {
  /**
   * The runtime used to default to `hermes -z`, and that default is why this test exists.
   *
   * `-z` is a one-shot: every owner turn spawned a new Hermes with no history, so the CEO could
   * not remember the previous message. It answered, so nothing looked broken — the session store
   * is where it showed, as a row of abandoned conversations beside the one real one.
   *
   * Nothing downstream can catch this. A bound-but-amnesiac CEO reports as bound, and `doctor`
   * has no finding for it. The only place it can be refused is before the runtime starts.
   */
  const stderrOf = async (argv: readonly string[]): Promise<{ code: number; text: string }> => {
    let text = "";
    const original = process.stderr.write.bind(process.stderr);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr as any).write = (chunk: any): boolean => {
      text += String(chunk);
      return true;
    };
    try {
      return { code: await main(argv), text };
    } finally {
      process.stderr.write = original;
    }
  };

  it("refuses to start when no reply command is named", async () => {
    // Not `toBeGreaterThan(0)`: the old default made this path return 0-and-run, so an
    // assertion that merely wanted a nonzero code would have been satisfied by a crash later
    // for an unrelated reason.
    const { code, text } = await stderrOf(["--tool-socket", "/tmp/does-not-matter.sock"]);

    expect(code).toBe(2);
    expect(text).toContain("--reply-command is required");
  });

  it("refuses the flag with nothing after it, the same way", async () => {
    const { code, text } = await stderrOf(["--reply-command"]);

    expect(code).toBe(2);
    expect(text).toContain("--reply-command is required");
  });

  it("says how to pin the session, because 'required' alone is satisfied by the broken form", async () => {
    // An operator who reads only "--reply-command is required" supplies `hermes -z` — the exact
    // command that was wrong — and the refusal has taught them nothing. The message has to carry
    // the pinned shape, with `-z` last so the appended prompt lands on `-z` and not on
    // `--resume`.
    const { text } = await stderrOf([]);

    expect(text).toContain("--resume");
    expect(text.indexOf("-z")).toBeGreaterThan(text.indexOf("--resume"));
  });
});
