import { Socket } from "node:net";

import { describe, expect, it } from "vitest";

import { authenticateSocket, MAX_MCP_LINE_BYTES } from "../../src/daemon/agentcpd.ts";

// #805. The transport limit is a statement about one message. Every case here is built from
// MAX_MCP_LINE_BYTES itself rather than a copy of the number, so a change to the deployment's
// limit moves the cases with it instead of leaving them measuring a stale size.

const TOKEN = "line-limit-deployment-token";
const CREDENTIAL = { sessionId: "line-limit-session", sessionSecret: "line-limit-secret" };

/** A well-formed JSON-RPC line whose UTF-8 byte length is exactly `bytes`, terminator excluded. */
const messageOfBytes = (id: number, bytes: number): string => {
  const skeleton = JSON.stringify({ jsonrpc: "2.0", id, result: { pad: "" } });
  const line = JSON.stringify({ jsonrpc: "2.0", id, result: { pad: "a".repeat(bytes - skeleton.length) } });
  if (Buffer.byteLength(line) !== bytes) throw new Error(`built ${Buffer.byteLength(line)} bytes, wanted ${bytes}`);
  return line;
};

/** The handshake line, padded on an ignored key so its own byte length can be chosen. */
const handshakeOfBytes = (bytes: number): string => {
  const skeleton = JSON.stringify({ token: TOKEN, ...CREDENTIAL, pad: "" });
  const line = JSON.stringify({ token: TOKEN, ...CREDENTIAL, pad: "a".repeat(bytes - skeleton.length) });
  if (Buffer.byteLength(line) !== bytes) throw new Error(`built ${Buffer.byteLength(line)} bytes, wanted ${bytes}`);
  return line;
};

const handshake = (): string => JSON.stringify({ token: TOKEN, ...CREDENTIAL });

/**
 * A socket the reader can be driven through, with data delivered by `emit` rather than a kernel.
 * The no-op error listener is the price of never connecting it: a written refusal calls
 * `socket.end`, and a write on a socket with no handle fails asynchronously — with the reader's
 * own listener already removed by then, that would surface as an unhandled error after the
 * assertion it belongs to has passed.
 */
const drivenSocket = (): Socket => {
  const socket = new Socket();
  socket.on("error", () => {});
  return socket;
};

interface Started {
  socket: Socket;
  messages: unknown[];
  errors: Error[];
}

/** Authenticate and start the production transport, with `trailing` delivered by the same read. */
const started = async (trailing = ""): Promise<Started> => {
  const socket = drivenSocket();
  const opening = authenticateSocket(socket, TOKEN, 1000);
  socket.emit("data", Buffer.from(`${handshake()}\n${trailing}`));
  const accepted = await opening;
  if (!accepted) throw new Error("handshake was refused");
  const messages: unknown[] = [];
  const errors: Error[] = [];
  accepted.transport.onmessage = (message) => messages.push(message);
  accepted.transport.onerror = (error) => errors.push(error);
  await accepted.transport.start();
  return { socket, messages, errors };
};

describe("the MCP transport limit bounds one line, not one read", () => {
  it("delivers two legal messages that arrived in a single read", async () => {
    const half = Math.floor(MAX_MCP_LINE_BYTES * 0.6);
    const first = messageOfBytes(1, half);
    const second = messageOfBytes(2, half);
    const { socket, messages, errors } = await started();
    try {
      // Two messages, each within the limit, and together over it. Which side of this line the
      // kernel splits a stream on is under neither peer's control.
      socket.emit("data", Buffer.from(`${first}\n${second}\n`));
      expect(errors).toEqual([]);
      expect(messages).toHaveLength(2);
      expect(socket.destroyed).toBe(false);
    } finally {
      socket.destroy();
    }
  });

  it("refuses a single line longer than the limit", async () => {
    const { socket, messages, errors } = await started();
    try {
      socket.emit("data", Buffer.from(`${messageOfBytes(1, MAX_MCP_LINE_BYTES + 1)}\n`));
      expect(errors.map((error) => error.message)).toEqual(["MCP message exceeds local transport limit"]);
      expect(messages).toEqual([]);
      expect(socket.destroyed).toBe(true);
    } finally {
      socket.destroy();
    }
  });

  it("accepts a line of exactly the limit", async () => {
    const { socket, messages, errors } = await started();
    try {
      socket.emit("data", Buffer.from(`${messageOfBytes(1, MAX_MCP_LINE_BYTES)}\n`));
      expect(errors).toEqual([]);
      expect(messages).toHaveLength(1);
      expect(socket.destroyed).toBe(false);
    } finally {
      socket.destroy();
    }
  });

  it("refuses input that never terminates a line rather than buffering it without bound", async () => {
    const { socket, errors } = await started();
    try {
      // Exactly the limit and no newline yet is still a line that may become legal, so it may not
      // be refused here; one byte past it can no longer become one.
      socket.emit("data", Buffer.from("a".repeat(MAX_MCP_LINE_BYTES)));
      expect(errors).toEqual([]);
      expect(socket.destroyed).toBe(false);
      socket.emit("data", Buffer.from("a"));
      expect(errors.map((error) => error.message)).toEqual([
        "MCP message exceeds local transport limit before its terminator",
      ]);
      expect(socket.destroyed).toBe(true);
    } finally {
      socket.destroy();
    }
  });
});

describe("the MCP handshake reader bounds one line, not one read", () => {
  it("accepts a handshake whose read also carried the messages after it", async () => {
    const half = Math.floor(MAX_MCP_LINE_BYTES * 0.6);
    const trailing = `${messageOfBytes(1, half)}\n${messageOfBytes(2, half)}\n`;
    const socket = drivenSocket();
    const opening = authenticateSocket(socket, TOKEN, 1000);
    socket.emit("data", Buffer.from(`${handshake()}\n${trailing}`));
    const accepted = await opening;
    try {
      expect(accepted).not.toBeNull();
      const messages: unknown[] = [];
      accepted!.transport.onmessage = (message) => messages.push(message);
      await accepted!.transport.start();
      expect(messages).toHaveLength(2);
    } finally {
      socket.destroy();
    }
  });

  it("refuses a handshake line longer than the limit", async () => {
    const socket = drivenSocket();
    const opening = authenticateSocket(socket, TOKEN, 1000);
    socket.emit("data", Buffer.from(`${handshakeOfBytes(MAX_MCP_LINE_BYTES + 1)}\n`));
    try {
      expect(await opening).toBeNull();
    } finally {
      socket.destroy();
    }
  });

  it("accepts a handshake line of exactly the limit", async () => {
    const socket = drivenSocket();
    const opening = authenticateSocket(socket, TOKEN, 1000);
    socket.emit("data", Buffer.from(`${handshakeOfBytes(MAX_MCP_LINE_BYTES)}\n`));
    try {
      expect(await opening).not.toBeNull();
    } finally {
      socket.destroy();
    }
  });

  it("refuses a handshake that never terminates its line rather than buffering it without bound", async () => {
    const socket = drivenSocket();
    const opening = authenticateSocket(socket, TOKEN, 1000);
    // Read the outcome without awaiting it: a reader that buffers on without bound never settles,
    // and awaiting that would report the defect as a sixty-second timeout instead of an assertion.
    let outcome: "pending" | "refused" | "accepted" = "pending";
    void opening.then((accepted) => (outcome = accepted ? "accepted" : "refused"));
    const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
    try {
      socket.emit("data", Buffer.from("a".repeat(MAX_MCP_LINE_BYTES)));
      await flush();
      expect(outcome, "exactly the limit with no terminator is still a line that may become legal").toBe("pending");
      socket.emit("data", Buffer.from("a"));
      await flush();
      expect(outcome).toBe("refused");
    } finally {
      socket.destroy();
    }
  });
});
