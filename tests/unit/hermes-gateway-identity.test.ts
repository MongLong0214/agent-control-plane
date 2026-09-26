import { createServer, type RequestListener, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { createHermesGatewayIdentityReader } from "../../src/runtime/hermes-gateway-identity.ts";

const proof = {
  session_id: "live-session",
  lineage_root_digest: `sha256:${"a".repeat(64)}`,
  process_pid: 1234,
  process_started_at: "darwin-tv:123.456",
};
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

describe("authenticated Gateway identity reader", () => {
  it("sends a bearer on the fixed GET path and returns the exact identity", async () => {
    const seen: { method?: string; url?: string; bearer?: string } = {};
    const port = await listen((req, res) => {
      seen.method = req.method;
      seen.url = req.url;
      seen.bearer = req.headers.authorization;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(proof));
    });
    expect(await createHermesGatewayIdentityReader({ apiKey: "provisioned-key", port })()).toEqual(proof);
    expect(seen).toEqual({
      method: "GET", url: "/v1/canonical-surface/identity", bearer: "Bearer provisioned-key",
    });
  });

  it("does not contact the Gateway without a separately provisioned key", async () => {
    let requests = 0;
    const port = await listen((_req, res) => { requests += 1; res.end(JSON.stringify(proof)); });
    await expect(createHermesGatewayIdentityReader({ apiKey: "", port })())
      .rejects.toThrow("Gateway identity unavailable");
    expect(requests).toBe(0);
  });

  it.each([401, 403, 409, 503])("refuses HTTP %i without exposing the refusal body", async (status) => {
    const port = await listen((_req, res) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ secret: "do-not-leak", ...proof }));
    });
    await expect(createHermesGatewayIdentityReader({ apiKey: "key", port })())
      .rejects.toThrow(/^Gateway identity unavailable$/);
  });

  it("never follows a redirect", async () => {
    let redirected = false;
    const targetPort = await listen((_req, res) => { redirected = true; res.end(JSON.stringify(proof)); });
    const port = await listen((_req, res) => {
      res.writeHead(302, { Location: `http://127.0.0.1:${targetPort}/steal` });
      res.end("redirect");
    });
    await expect(createHermesGatewayIdentityReader({ apiKey: "key", port })())
      .rejects.toThrow("Gateway identity unavailable");
    expect(redirected).toBe(false);
  });

  it.each([
    { ...proof, session_id: "" },
    { ...proof, lineage_root_digest: "wrong" },
    { ...proof, process_pid: 0 },
    { ...proof, process_started_at: "" },
    { ...proof, extra: "untrusted" },
  ])("rejects identities outside the exact schema: %j", async (body) => {
    const port = await listen((_req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(body));
    });
    await expect(createHermesGatewayIdentityReader({ apiKey: "key", port })())
      .rejects.toThrow(/^Gateway identity unavailable$/);
  });

  it("cuts off an oversized chunked response", async () => {
    const port = await listen((_req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.write("x".repeat(5000));
    });
    await expect(createHermesGatewayIdentityReader({ apiKey: "key", port })())
      .rejects.toThrow(/^Gateway identity unavailable$/);
  });

  it("times out when the response never finishes", async () => {
    const port = await listen((_req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.write("{");
    });
    const started = performance.now();
    await expect(createHermesGatewayIdentityReader({ apiKey: "key", port })())
      .rejects.toThrow(/^Gateway identity unavailable$/);
    expect(performance.now() - started).toBeLessThan(3000);
  }, 5_000);
});
