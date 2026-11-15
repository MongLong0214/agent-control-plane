import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type * as HttpModule from "node:http";
import { createServer, type IncomingMessage, type RequestOptions, type Server } from "node:http";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createHermesBootstrapAuthority } from "../../src/bootstrap/hermes-bootstrap.ts";
import type { ReceiptLookupQuery } from "../../src/conversation/turn-coordinator.ts";
import {
  createConfiguredHermesGatewayConversation,
  createConfiguredHermesGatewayDaemonNoticeTarget,
  createConfiguredHermesIncumbentAdoption,
  main,
  withConfiguredHermesGatewayReceipt,
} from "../../src/daemon/agentcpd.ts";
import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import type { DaemonNoticeBody } from "../../src/runtime/acp-daemon-notice.ts";
import { configuredHermesGatewayPort } from "../../src/runtime/hermes-gateway-endpoint.ts";
import { HermesGatewayReceiptPort } from "../../src/runtime/hermes-gateway-receipt-port.ts";
import { adoptedFixture, DIGEST, GATEWAY, LIVE, LSTART, TOKEN } from "../helpers/adopted-ceo.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";

/**
 * U6 B2: one explicit Gateway endpoint for every call ACP makes to the Hermes Gateway, and for the
 * Hermes runtime bootstrap launches. The live Gateway listens on 127.0.0.1:8642, so every request in
 * this file is recorded and one to a port this file did not open is never connected: it is sent to
 * a socket path that does not exist instead, and fails like a refused connection.
 */
const gate = vi.hoisted(() => ({
  attempts: [] as { host: unknown; port: number; path: unknown; authorization: unknown }[],
  open: new Set<number>(),
}));

vi.mock("node:http", async (importOriginal) => {
  const actual = await importOriginal<typeof HttpModule>();
  const request = (options: RequestOptions, callback?: (res: IncomingMessage) => void) => {
    const port = Number(options.port);
    gate.attempts.push({
      host: options.hostname, port, path: options.path,
      authorization: (options.headers as Record<string, unknown> | undefined)?.["Authorization"],
    });
    return actual.request(gate.open.has(port) ? options : {
      ...options, hostname: undefined, port: undefined, socketPath: "/nonexistent/u6-b2-never-connected.sock",
    }, callback);
  };
  return { ...actual, default: { ...actual, request }, request };
});

afterAll(cleanupTempDirs);

const KEY = "u6-b2-fixture-gateway-key";
const IDENTITY = { session_id: LIVE, lineage_root_digest: DIGEST, process_pid: GATEWAY, process_started_at: TOKEN };
const ADOPTION = {
  ACP_HERMES_LINEAGE_ROOT_DIGEST: DIGEST,
  ACP_HERMES_EXECUTABLE: "/opt/test/hermes",
  ACP_HERMES_PROFILE: "test-profile",
  ACP_HERMES_HOME: "/opt/test/home",
  ACP_HERMES_EXECUTOR_RUNTIME_IDENTITY: "hermes-runtime:test",
  ACP_HERMES_GATEWAY_API_KEY: KEY,
};
const processPorts = { processStartToken: () => TOKEN, processStartedAt: () => LSTART };
const source = { eventId: "u6-b2-event", actor: "owner", conversation: "room" };
const UPDATE = 7;
const query = { turnRequestId: "turn-u6-b2" } as ReceiptLookupQuery;

interface Gateway { name: string; port: number; requests: string[] }
const servers: Server[] = [];

/**
 * A Gateway on its own loopback port. Both answer the same identity: a request that reached the
 * wrong one would succeed, so only where it went tells them apart.
 */
const gateway = async (name: string): Promise<Gateway> => {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      if (req.method === "POST") {
        res.end(JSON.stringify({ event_id: (JSON.parse(body) as { event_id: string }).event_id, text: `answered by ${name}` }));
      } else if (req.url === "/v1/canonical-surface/identity") {
        res.end(JSON.stringify(IDENTITY));
      } else {
        res.end(JSON.stringify({
          schema: "hermes.gateway-turn-receipt/v1", status: "NEVER_FOUND", update_id: UPDATE, message_id: null,
          turnRequestId: null, receiptIdentity: null, receiptId: null, evidenceDigest: null, reasonCode: null, delivery: null,
        }));
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected TCP listener");
  gate.open.add(address.port);
  return { name, port: address.port, requests };
};

/** A loopback port nothing listens on: a configured Gateway that is down. */
const closedPort = async (): Promise<number> => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected TCP listener");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  gate.open.add(address.port);
  return address.port;
};

const notice = (destination: DaemonNoticeBody["destination"]): DaemonNoticeBody => ({
  protocol: "acp-daemon-notice/v1", principal: "acp-daemon", binding: "acp-canonical-ceo",
  event_id: `acp-notice:${"0".repeat(64)}`, destination, text: "notice", payload_digest: `sha256:${"1".repeat(64)}`,
  signature: "fixture",
});

/** Every daemon composition that reads the Gateway, once, through the production readers. */
const everyCall = async (configuration: Record<string, string | undefined>) => {
  const fixture = adoptedFixture();
  try {
    const adopted: unknown[] = [];
    const adopt = createConfiguredHermesIncumbentAdoption(fixture.h.cp, configuration, {
      adoptionFactory: (() => ({ adopt: async (input: unknown) => { adopted.push(input); return allow(ReasonCode.OK, {}); } })) as never,
    });
    const adoption = adopt ? await adopt() : undefined;
    const conversation = await createConfiguredHermesGatewayConversation(fixture.h.cp, configuration, processPorts)?.("status", source);
    const target = await createConfiguredHermesGatewayDaemonNoticeTarget(fixture.h.cp, configuration, processPorts)?.();
    const sent = target ? await target.send(notice(target.destination)) : target;
    const receiptOptions = withConfiguredHermesGatewayReceipt(fixture.h.cp.config, configuration).hermesGatewayReceipt;
    const receipt = receiptOptions
      ? await new HermesGatewayReceiptPort(() => ({ updateId: UPDATE }), receiptOptions).lookup(query, new AbortController().signal)
      : undefined;
    return { adopted, adoption, conversation, sent, receipt, receiptOptions };
  } finally {
    fixture.h.cp.close();
  }
};

beforeEach(() => { gate.attempts.length = 0; });
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  gate.open.clear();
});

describe("ACP_HERMES_GATEWAY_ENDPOINT", () => {
  it("is 127.0.0.1:<port>, the Gateway default when unset, and nothing else", () => {
    expect(configuredHermesGatewayPort({})).toBe(8642);
    expect(configuredHermesGatewayPort({ ACP_HERMES_GATEWAY_ENDPOINT: "127.0.0.1:18642" })).toBe(18642);
    expect(configuredHermesGatewayPort({ ACP_HERMES_GATEWAY_ENDPOINT: "127.0.0.1:1" })).toBe(1);
    expect(configuredHermesGatewayPort({ ACP_HERMES_GATEWAY_ENDPOINT: "127.0.0.1:65535" })).toBe(65535);
    for (const refused of [
      "", "127.0.0.1", "127.0.0.1:", "127.0.0.1:0", "127.0.0.1:08642", "127.0.0.1:65536", "127.0.0.1:99999",
      "127.0.0.1:186420", "localhost:18642", "127.0.0.2:18642", "10.0.0.1:18642", "0.0.0.0:18642", "[::1]:18642",
      "http://127.0.0.1:18642", "127.0.0.1:18642/v1", "user:pw@127.0.0.1:18642", " 127.0.0.1:18642", "127.0.0.1:18642\n",
    ]) {
      expect(configuredHermesGatewayPort({ ACP_HERMES_GATEWAY_ENDPOINT: refused }), JSON.stringify(refused)).toBeNull();
    }
  });

  it.each([["A", "B"], ["B", "A"]])(
    "every Gateway call goes to the configured endpoint %s and never to the other isolated endpoint %s",
    async (configuredName) => {
      const gateways = { A: await gateway("A"), B: await gateway("B") };
      const configured = gateways[configuredName as "A" | "B"];
      const other = configured === gateways.A ? gateways.B : gateways.A;

      const result = await everyCall({ ...ADOPTION, ACP_HERMES_GATEWAY_ENDPOINT: `127.0.0.1:${configured.port}` });

      expect(result.adopted).toEqual([{ gatewayPid: GATEWAY, gatewayStartToken: TOKEN }]);
      expect(result.adoption?.allowed).toBe(true);
      expect(result.conversation).toMatchObject({ contact: "REACHED", answered: { allowed: true, value: `answered by ${configured.name}` } });
      expect(result.sent).toMatchObject({ kind: "RESPONDED", status: 200 });
      expect(result.receipt).toEqual({ found: false });
      expect(configured.requests).toEqual([
        "GET /v1/canonical-surface/identity",
        "GET /v1/canonical-surface/identity", "GET /v1/canonical-surface/identity", "POST /v1/canonical-surface/events",
        "GET /v1/canonical-surface/identity", "GET /v1/canonical-surface/identity", "POST /v1/canonical-surface/events",
        `GET /v1/canonical-surface/receipts/telegram/${UPDATE}`,
      ]);
      expect(other.requests).toEqual([]);
      expect(new Set(gate.attempts.map((attempt) => `${String(attempt.host)}:${attempt.port}`)))
        .toEqual(new Set([`127.0.0.1:${configured.port}`]));
      // The key is a header and only a header.
      for (const attempt of gate.attempts) {
        expect(attempt.authorization).toBe(`Bearer ${KEY}`);
        expect(String(attempt.path)).not.toContain(KEY);
      }
    },
  );

  it("does not fall back to 8642 or to another Gateway when the configured one is down", async () => {
    const live = await gateway("live");
    const down = await closedPort();

    const result = await everyCall({ ...ADOPTION, ACP_HERMES_GATEWAY_ENDPOINT: `127.0.0.1:${down}` });

    expect(result.adopted).toEqual([]);
    expect(result.adoption).toMatchObject({ allowed: false, reasonCode: ReasonCode.CONFLICT });
    expect(result.conversation).toMatchObject({ contact: "NEVER_REACHED", answered: { allowed: false } });
    expect(result.sent).toBeNull();
    expect(result.receipt).toEqual({ found: false, lookupError: { kind: "TRANSPORT", detail: "ECONNREFUSED" } });
    expect(live.requests).toEqual([]);
    expect(gate.attempts.length).toBeGreaterThan(0);
    expect(gate.attempts.every((attempt) => attempt.port === down)).toBe(true);
  });

  it.each(["localhost:PORT", "127.0.0.1:PORT/v1", "http://127.0.0.1:PORT", "127.0.0.1:0", ""])(
    "a configured endpoint %j that is not 127.0.0.1:<port> reaches no Gateway at all",
    async (spelled) => {
      const live = await gateway("live");
      const result = await everyCall({ ...ADOPTION, ACP_HERMES_GATEWAY_ENDPOINT: spelled.replace("PORT", String(live.port)) });

      expect(result.adoption).toBeUndefined();
      expect(result.conversation).toMatchObject({ contact: "NEVER_REACHED", answered: { allowed: false } });
      expect(result.sent).toBeNull();
      expect(result.receiptOptions).toBeUndefined();
      expect(live.requests).toEqual([]);
      expect(gate.attempts).toEqual([]);
    },
  );

  it("is 127.0.0.1:8642 for every call when it is not configured, as before", async () => {
    const result = await everyCall({ ...ADOPTION });

    expect(result.receiptOptions?.apiKey).toBe(KEY);
    expect(gate.attempts.map((attempt) => attempt.path)).toEqual([
      "/v1/canonical-surface/identity", "/v1/canonical-surface/identity", "/v1/canonical-surface/identity",
      `/v1/canonical-surface/receipts/telegram/${UPDATE}`,
    ]);
    // Recorded, never connected: the mock above sends a port this file did not open nowhere.
    expect(new Set(gate.attempts.map((attempt) => `${String(attempt.host)}:${attempt.port}`))).toEqual(new Set(["127.0.0.1:8642"]));
    expect(result.adopted).toEqual([]);
  });

  it("refuses the daemon start, naming the variable and not its value, when it is set to anything else", async () => {
    const root = tempDir("acp-u6-b2-main-");
    const databasePath = join(root, "state", "state.sqlite");
    const secret = "u6-b2-pasted-secret-value";
    const values: Record<string, string> = {
      ACP_HERMES_GATEWAY_ENDPOINT: `http://u6:${secret}@127.0.0.1:18642`,
      ACP_MCP_TOKEN: "u6-b2-main-mcp-token",
      ACP_OPERATOR_TOKEN: "u6-b2-main-operator-token",
      ACP_OPERATOR_ACTOR: "u6-b2-operator",
    };
    const scrubbed = ["ACP_CANONICAL_SESSIONS_JSON", "ACP_CANONICAL_CTO_PEER_PROTOCOL", "ACP_CANONICAL_CTO_BUZZ_PURPOSE"];
    const names = [...scrubbed, ...Object.keys(values)];
    const before = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    let rejection: unknown = null;
    try {
      for (const name of scrubbed) delete process.env[name];
      Object.assign(process.env, values);
      await main({ config: { databasePath, worktreeRoot: join(root, "worktrees"), capacityDir: join(root, "capacity"),
        secretsDir: join(root, "secrets") } });
    } catch (error) {
      rejection = error;
    } finally {
      for (const name of names) {
        const value = before[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
    expect(String((rejection as Error | null)?.message)).toContain("ACP_HERMES_GATEWAY_ENDPOINT must be 127.0.0.1:<port>");
    expect(JSON.stringify(rejection)).not.toContain(secret);
    expect(String((rejection as Error | null)?.message)).not.toContain(secret);
    expect(existsSync(databasePath)).toBe(false);
    expect(gate.attempts).toEqual([]);
  });
});

describe("the Hermes runtime bootstrap launches", () => {
  /** Bootstraps a child that records the Gateway endpoint it was told, then proves the token. */
  const bootstrapped = async (gatewayPort: number | undefined): Promise<Record<string, unknown>> => {
    const h = makeHarness();
    const dir = tempDir("acp-u6-b2-boot-");
    const seen = join(dir, "seen.json");
    const target = join(dir, "target.cjs");
    writeFileSync(target, `#!${process.execPath}\nconst {createHash}=require('node:crypto');let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{const r=JSON.parse(s);const v={domain:'hermes.target-bind',version:1,actor_id:r.actor_id,binding_generation:r.binding_generation,executor_runtime_identity:r.executor_runtime_identity,requested_session_id:r.session_id,lineage_root_digest:r.expected_lineage_root_digest};const c=JSON.stringify(Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))));process.stdout.write(JSON.stringify({...v,receipt_digest:'sha256:'+createHash('sha256').update(c).digest('hex')}));});`, { mode: 0o700 });
    const authority = createHermesBootstrapAuthority(h.cp, {
      stateDir: dir, mcpSocketPath: join(dir, "mcp.sock"), mcpToken: "fixture-mcp", runtimeTimeoutMs: 5000,
      ...(gatewayPort === undefined ? {} : { gatewayPort }),
    });
    try {
      const result = await authority.bootstrap({
        command: [process.execPath, "-e", `const fs=require('node:fs'),net=require('node:net'),c=require('node:crypto'),n='u6-b2-endpoint-nonce';fs.writeFileSync(${JSON.stringify(seen)},JSON.stringify({endpoint:process.env.ACP_HERMES_GATEWAY_ENDPOINT,keys:Object.keys(process.env).filter(k=>k.startsWith('ACP_')).sort()}));const s=net.createConnection(process.env.ACP_HERMES_BOOTSTRAP_SOCKET,()=>s.write(JSON.stringify({runtimeNonce:n,runtimeProof:c.createHmac('sha256',process.env.ACP_HERMES_BOOTSTRAP_TOKEN).update(n).digest('hex')})+'\\n'));s.on('data',()=>process.exit(0));`],
        model: "fixture", hermesExecutable: target, hermesProfile: "fixture", hermesHome: dir,
        requestedSessionId: "fixture-session", expectedLineageRootDigest: `sha256:${"a".repeat(64)}`,
        executorRuntimeIdentity: "fixture-runtime",
      });
      expect(result.allowed).toBe(true);
      return JSON.parse(readFileSync(seen, "utf8")) as Record<string, unknown>;
    } finally {
      await authority.close();
      h.cp.close();
    }
  };

  it("is told the daemon's Gateway endpoint, and the default when the daemon names none", async () => {
    expect(await bootstrapped(18642)).toEqual({
      endpoint: "127.0.0.1:18642",
      keys: ["ACP_HERMES_BOOTSTRAP_SOCKET", "ACP_HERMES_BOOTSTRAP_TOKEN", "ACP_HERMES_GATEWAY_ENDPOINT",
        "ACP_HERMES_MCP_SOCKET", "ACP_MCP_TOKEN"],
    });
    expect((await bootstrapped(undefined)).endpoint).toBe("127.0.0.1:8642");
  });
});
