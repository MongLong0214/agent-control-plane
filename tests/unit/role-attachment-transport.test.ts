import { Socket } from "node:net";

import { describe, expect, it, vi } from "vitest";

import { authenticateSocket } from "../../src/daemon/agentcpd.ts";

// The production handshake and SocketTransport, with data delivered through an unconnected
// Socket. No listener or MCP mock: inspect the backing allocations the transport parses.
describe("attachment handshake buffer retention", () => {
  it.each([
    ["empty", "", ""],
    ["complete", '{"jsonrpc":"2.0","id":1,"result":{}}\n', ""],
    ["partial", '{"jsonrpc":"2.0","id":1,', '"result":{}}\n'],
  ])("the transport detaches the %s handshake remainder and subsequent frames", async (_name, remainder, completion) => {
    const socket = new Socket();
    const secret = "transport-retention-credential-canary";
    const token = "transport-retention-deployment-canary";
    const opening = authenticateSocket(socket, token, 1000);
    socket.emit("data", Buffer.from(`${JSON.stringify({ token, attachmentId: "test", attachmentSecret: secret })}\n${remainder}`));
    const accepted = await opening;
    expect(accepted).not.toBeNull();
    const transport = accepted!.transport;
    const messages: unknown[] = [];
    transport.onmessage = (message) => messages.push(message);

    const retained: { length: number; credentialBytes: boolean; tokenBytes: boolean }[] = [];
    const indexOf = Buffer.prototype.indexOf;
    const inspection = vi.spyOn(Buffer.prototype, "indexOf").mockImplementation(function (this: Buffer, ...args) {
      const backing = Buffer.from(this.buffer);
      retained.push({ length: this.length,
        credentialBytes: indexOf.call(backing, secret) !== -1,
        tokenBytes: indexOf.call(backing, token) !== -1 });
      return indexOf.apply(this, args);
    });
    try {
      await transport.start();
      expect(retained.length).toBeGreaterThan(0);
      expect(retained, "initial and consumed views must not pin credential bytes").toEqual(
        retained.map(({ length }) => ({ length, credentialBytes: false, tokenBytes: false })),
      );
      retained.length = 0;
      socket.emit("data", Buffer.from(`${completion}{"jsonrpc":"2.0","id":2,"result":{}}\n`));
      expect(retained.length).toBeGreaterThan(0);
      expect(retained, "later frames must not regain the credential slab").toEqual(
        retained.map(({ length }) => ({ length, credentialBytes: false, tokenBytes: false })),
      );
      expect(messages).toEqual([
        ...(remainder ? [{ jsonrpc: "2.0", id: 1, result: {} }] : []),
        { jsonrpc: "2.0", id: 2, result: {} },
      ]);
    } finally {
      inspection.mockRestore();
      socket.destroy();
    }
  });
});
