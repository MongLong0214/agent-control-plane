import { createServer, type RequestListener, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { createHermesGatewayConversationSender } from "../../src/runtime/hermes-gateway-conversation.ts";

const identity = {
  session_id: "existing-head", lineage_root_digest: `sha256:${"a".repeat(64)}`,
  process_pid: 321, process_started_at: "boot:123",
};
const source = { eventId: "signed-event-7", actor: "author-7", conversation: "channel-9" };
const servers: Server[] = [];
const listen = async (handler: RequestListener): Promise<number> => {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected TCP listener");
  return address.port;
};
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

const sender = (port: number, expected = identity) => createHermesGatewayConversationSender({
  apiKey: "fixture-key", binding: "daemon-provisioned", expected, port,
});
const reply = { event_id: source.eventId, text: "canonical answer" };

describe("Gateway canonical-event sender", () => {
  it("sends exact authenticated provenance and expected live identity to the existing binding", async () => {
    const seen: { method?: string; url?: string; authorization?: string; body?: unknown } = {};
    const port = await listen((req, res) => {
      if (req.method === "GET") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(identity));
        return;
      }
      seen.method = req.method;
      seen.url = req.url;
      seen.authorization = req.headers.authorization;
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        seen.body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(reply));
      });
    });
    expect(await sender(port)("exact message", source)).toEqual({
      contact: "REACHED", answered: { allowed: true, reasonCode: "OK", evidence: {}, value: "canonical answer" },
    });
    expect(seen).toEqual({
      method: "POST", url: "/v1/canonical-surface/events", authorization: "Bearer fixture-key",
      body: { binding: "daemon-provisioned", event_id: source.eventId, author_id: source.actor,
        channel_id: source.conversation, text: "exact message", ...identity },
    });
  });

  it.each(["session_id", "lineage_root_digest", "process_pid", "process_started_at"])(
    "refuses a changed %s before POST", async (field) => {
      let posts = 0;
      const port = await listen((req, res) => {
        if (req.method === "POST") posts += 1;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ...identity, [field]: field === "process_pid" ? 999 : "other" }));
      });
      const outcome = await sender(port)("message", source);
      expect(outcome.contact).toBe("NEVER_REACHED");
      expect(outcome.answered.allowed).toBe(false);
      expect(posts).toBe(0);
    },
  );

  it("does not POST when the post-GET authority check throws", async () => {
    let posts = 0;
    const port = await listen((req, res) => {
      if (req.method === "POST") posts++;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(identity));
    });
    const send = createHermesGatewayConversationSender({
      apiKey: "fixture-key", binding: "daemon-provisioned", expected: identity, port,
      preDispatch: () => { throw new Error("authority store closed"); },
    });
    expect(await send("message", source)).toMatchObject({ contact: "NEVER_REACHED",
      answered: { allowed: false, reasonCode: "CEO_CONVERSATION_STALE" } });
    expect(posts).toBe(0);
  });

  it("refuses missing authenticated Buzz principals or missing key before any contact", async () => {
    let requests = 0;
    const port = await listen((_req, res) => { requests += 1; res.end("{}"); });
    const noKey = createHermesGatewayConversationSender({
      apiKey: "", binding: "daemon-provisioned", expected: identity, port,
    });
    expect((await noKey("message", source)).contact).toBe("NEVER_REACHED");
    for (const invalid of [{ ...source, actor: "" }, { ...source, conversation: "" },
      { ...source, actor: "owner\n" }]) {
      expect((await sender(port)("message", invalid)).contact).toBe("NEVER_REACHED");
    }
    expect(requests).toBe(0);
  });

  it("returns the exact cached duplicate reply without changing the event id", async () => {
    const events: unknown[] = [];
    const port = await listen((req, res) => {
      res.setHeader("Content-Type", "application/json");
      if (req.method === "GET") { res.end(JSON.stringify(identity)); return; }
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        events.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        res.end(JSON.stringify(reply));
      });
    });
    const send = sender(port);
    expect((await send("message", source)).answered).toMatchObject({ allowed: true, value: reply.text });
    expect((await send("message", source)).answered).toMatchObject({ allowed: true, value: reply.text });
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual(events[1]);
  });

  it.each([302, 409])("treats HTTP %i as reached uncertainty without following redirects", async (status) => {
    let targetRequests = 0;
    const targetPort = await listen((_req, res) => { targetRequests += 1; res.end("leak"); });
    let posts = 0;
    const port = await listen((req, res) => {
      res.setHeader("Content-Type", "application/json");
      if (req.method === "GET") { res.end(JSON.stringify(identity)); return; }
      posts += 1;
      res.writeHead(status, { Location: `http://127.0.0.1:${targetPort}/leak` });
      res.end("not an answer");
    });
    const outcome = await sender(port)("message", source);
    expect(outcome.contact).toBe("REACHED");
    expect(outcome.answered.allowed).toBe(false);
    expect(posts).toBe(1);
    expect(targetRequests).toBe(0);
  });

  it("does not accept an answer with a different event id", async () => {
    const port = await listen((req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(req.method === "GET" ? identity : { ...reply, event_id: "other" }));
    });
    const outcome = await sender(port)("message", source);
    expect(outcome.contact).toBe("REACHED");
    expect(outcome.answered.allowed).toBe(false);
  });

  it("classifies a severed connection after POST as reached, never safe to retry", async () => {
    const port = await listen((req, res) => {
      if (req.method === "GET") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(identity));
      } else {
        req.on("data", () => undefined);
        req.on("end", () => res.destroy());
      }
    });
    const outcome = await sender(port)("message", source);
    expect(outcome.contact).toBe("REACHED");
    expect(outcome.answered.allowed).toBe(false);
  });
});
