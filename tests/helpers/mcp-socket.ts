import { createConnection } from "node:net";

import { ReasonCode } from "../../src/core/reason-codes.ts";

/** What a local MCP socket's first line carries: the deployment token and the session credential. */
export interface McpSocketCredential {
  token: string;
  sessionId: string;
  sessionSecret: string;
}

/**
 * One `tools/call` on a real local MCP socket (`hermes.mcp.sock`, `cto.mcp.sock`): the credential
 * line, initialize, initialized, then the call by id. Answers the tool's structured content; a
 * JSON-RPC error or an unstructured result is reported under INTERNAL_ERROR with the transport's
 * own text, so no row can mistake it for a control-plane refusal.
 */
export const callMcpToolOverSocket = (
  socketPath: string,
  credential: McpSocketCredential,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`${name} over ${socketPath} timed out`));
    }, 15_000);
    socket.setEncoding("utf8");
    socket.once("connect", () =>
      socket.write(`${[
        { token: credential.token, sessionId: credential.sessionId, sessionSecret: credential.sessionSecret },
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "acp-test", version: "1" } },
        },
        { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } },
      ].map((line) => JSON.stringify(line)).join("\n")}\n`));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (const line of buffer.split("\n")) {
        if (!line.includes('"id":2')) continue;
        clearTimeout(timer);
        socket.end();
        const reply = JSON.parse(line) as {
          result?: { structuredContent?: Record<string, unknown>; content?: Array<{ text?: string }> };
          error?: { message?: string };
        };
        resolve(
          reply.result?.structuredContent ?? {
            ok: false,
            reasonCode: ReasonCode.INTERNAL_ERROR,
            message: reply.error?.message ?? reply.result?.content?.map((part) => part.text ?? "").join("\n") ?? "",
          },
        );
        return;
      }
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

/** Reads a launched runtime's one-time local credential exactly as the runtime would. */
export const claimLaunchedCredential = (
  socketPath: string,
  externalSessionId: string,
): Promise<{ sessionId: string; sessionSecret: string }> =>
  new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let received = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify({ externalSessionId })}\n`));
    socket.on("data", (chunk: string) => {
      received += chunk;
      if (!received.includes("\n")) return;
      socket.end();
      const body = JSON.parse(received.trim()) as { ok?: unknown; sessionId?: unknown; sessionSecret?: unknown };
      if (body.ok !== true || typeof body.sessionId !== "string" || typeof body.sessionSecret !== "string") {
        reject(new Error("launch credential was not available"));
        return;
      }
      resolve({ sessionId: body.sessionId, sessionSecret: body.sessionSecret });
    });
    socket.once("error", reject);
  });
