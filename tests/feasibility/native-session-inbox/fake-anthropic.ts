/**
 * A local stand-in for api.anthropic.com, used only by the C0 feasibility harness.
 *
 * Two jobs, and the second is the one that matters. It answers `POST /v1/messages`
 * with a minimal well-formed SSE stream so the CLI's turn completes, and it appends
 * every request it receives -- path, headers, body -- to a JSONL capture file.
 *
 * The capture file is the measurement instrument for this slice. "The wake reached
 * the socket" is not the claim under test; "the wake appears in what the model was
 * asked" is, and the only place that is observable from outside the CLI is the
 * request body this server received.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { appendFileSync } from "node:fs";
import type { AddressInfo } from "node:net";

export interface CapturedRequest {
  readonly at: string;
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

export interface FakeAnthropic {
  readonly baseUrl: string;
  readonly port: number;
  readonly capturePath: string;
  close(): Promise<void>;
}

const SSE_REPLY = [
  `event: message_start\ndata: ${JSON.stringify({
    type: "message_start",
    message: {
      id: "msg_c0_feasibility",
      type: "message",
      role: "assistant",
      model: "claude-c0-fake",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  })}\n\n`,
  `event: content_block_start\ndata: ${JSON.stringify({
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  })}\n\n`,
  `event: content_block_delta\ndata: ${JSON.stringify({
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "ok" },
  })}\n\n`,
  `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
  `event: message_delta\ndata: ${JSON.stringify({
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 1 },
  })}\n\n`,
  `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
].join("");

const readBody = async (req: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
};

/**
 * Starts the fake endpoint on an ephemeral loopback port.
 *
 * Bound to 127.0.0.1 on purpose: a server on 0.0.0.0 would still prove the CLI
 * talked to us, but it would not be evidence that nothing could have left the host.
 */
export const startFakeAnthropic = async (capturePath: string): Promise<FakeAnthropic> => {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const body = await readBody(req);
      const record: CapturedRequest = {
        at: new Date().toISOString(),
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body,
      };
      appendFileSync(capturePath, `${JSON.stringify(record)}\n`);

      if (req.method === "POST" && (req.url ?? "").includes("/v1/messages")) {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        res.end(SSE_REPLY);
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "c0 fake" } }));
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    capturePath,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
};
