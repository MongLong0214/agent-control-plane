import { mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import { ATTACH_EXIT, runAdoptedCeoAttachRelay } from "../../src/cli/attach-relay.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import {
  BuzzActorIngress,
  buzzActorBindingSigningRequest,
  IngressGuard,
  ingressSignature,
} from "../../src/ingress/ingress-guard.ts";
import {
  startAdoptedCeoToolSocket,
  startLocalMcpListeners,
  type LocalMcpListeners,
} from "../../src/daemon/agentcpd.ts";
import {
  ADOPTED_CEO_TOOL_SOCKET_FILENAME,
  MAX_SUN_PATH_BYTES,
  startAdoptedCeoToolListener,
  type CanonicalSelfClaimListener,
} from "../../src/daemon/canonical-self-claim-listener.ts";
import { allow, type Decision } from "../../src/core/errors.ts";
import { createConnection } from "node:net";
import { HERMES_PROVENANCE_META_KEY } from "../../src/mcp/hermes-provenance.ts";
import { CeoConversationPort } from "../../src/mcp/ceo-conversation.ts";
import {
  adoptedFixture,
  CEO,
  count,
  DIGEST,
  GATEWAY,
  LIVE,
  snapshot,
  type AdoptedCeoFixture,
} from "../helpers/adopted-ceo.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";

/**
 * The adopted CEO tool socket end to end (#1037): the real kernel-peer listener, the real
 * admission, the real Hermes MCP server behind it, and the real relay in front of it. The only
 * stated facts are the process tree above this test process — which the kernel reports as the peer,
 * since the relay runs in-process — and the Gateway's readback.
 */

const OWNER_TURN = {
  [HERMES_PROVENANCE_META_KEY]: {
    session_id: LIVE,
    session_key: "agent:main:telegram:dm:1001",
    platform: "telegram",
    chat_id: "1001",
    cron: false,
    parent_chat_id: null,
    principal: "owner",
    delegation_depth: 0,
    lineage_root_digest: DIGEST,
  },
};

interface Wire {
  id?: number;
  result?: { structuredContent?: Record<string, unknown>; tools?: Array<{ name: string }> };
  error?: unknown;
}

const roots: string[] = [];
const fixtures: AdoptedCeoFixture[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  for (const fixture of fixtures.splice(0)) fixture.h.cp.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
afterAll(cleanupTempDirs);

/** `/tmp` directly: a per-user TMPDIR leaves too little of Darwin's 104-byte `sun_path`. */
const stateDir = (): string => {
  const dir = mkdtempSync("/tmp/acp37-");
  roots.push(dir);
  expect(Buffer.byteLength(join(dir, ADOPTED_CEO_TOOL_SOCKET_FILENAME))).toBeLessThanOrEqual(MAX_SUN_PATH_BYTES);
  return dir;
};

const lock = { lock: { held: () => true } };

/**
 * The relay's exit, or a sentinel when it does not settle inside the budget: a regression that
 * admits a peer it should refuse must fail an assertion, not wait out vitest's own timeout.
 */
const settles = async (exit: Promise<number>, budgetMs = 10_000): Promise<number | "did-not-settle"> => {
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<"did-not-settle">((resolve) => {
    timer = setTimeout(() => resolve("did-not-settle"), budgetMs);
  });
  try {
    return await Promise.race([exit, guard]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

interface Relay {
  exit: Promise<number>;
  stdin: PassThrough;
  request(method: string, params: unknown): Promise<Wire>;
  notify(method: string): void;
  out(): string;
  err(): string;
}

const relay = (toolSocketPath: string): Relay => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let outText = "";
  let errText = "";
  let pendingText = "";
  let nextId = 1;
  const pending = new Map<number, (message: Wire) => void>();
  stdout.on("data", (chunk: Buffer) => {
    outText += chunk.toString("utf8");
    pendingText += chunk.toString("utf8");
    for (;;) {
      const newline = pendingText.indexOf("\n");
      if (newline < 0) break;
      const line = pendingText.slice(0, newline);
      pendingText = pendingText.slice(newline + 1);
      const message = JSON.parse(line) as Wire;
      if (message.id !== undefined) pending.get(message.id)?.(message);
    }
  });
  stderr.on("data", (chunk: Buffer) => {
    errText += chunk.toString("utf8");
  });
  const exit = runAdoptedCeoAttachRelay({ toolSocketPath }, { stdin, stdout, stderr });
  return {
    exit,
    stdin,
    request: (method, params) =>
      new Promise<Wire>((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => reject(new Error(`timeout awaiting ${method}; stderr=${errText}`)), 10_000);
        pending.set(id, (message) => {
          clearTimeout(timer);
          resolve(message);
        });
        stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      }),
    notify: (method) => {
      stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
    },
    out: () => outText,
    err: () => errText,
  };
};

const runCreate = (key: string, meta?: Record<string, unknown>): Record<string, unknown> => ({
  name: "run_create",
  arguments: {
    idempotencyKey: key,
    projectId: null,
    executionMode: "SIMPLE",
    contract: {
      goal: "start the requested work",
      why: "the owner asked for it",
      scope: [],
      nonGoals: [],
      acceptance: ["a run exists"],
      priority: "NORMAL",
      humanGate: [],
      references: [],
    },
    repositories: [],
  },
  ...(meta ? { _meta: meta } : {}),
});

const BUZZ_SECRET = "fixture-buzz-ingress-secret";
const CEO_KEY = "c".repeat(64);

const started = async (descendsFromGateway: boolean, buzz = false) => {
  const fixture = adoptedFixture();
  fixtures.push(fixture);
  // The kernel will report this process as the peer: state where it sits.
  if (descendsFromGateway) fixture.parents.set(process.pid, GATEWAY);
  else fixture.parents.set(process.pid, 1);
  const dir = stateDir();
  const ceoConversation = new CeoConversationPort();
  const listeners: LocalMcpListeners = await startLocalMcpListeners(fixture.h.cp, dir, "fixture-mcp-token", { ceoConversation });
  closers.push(() => listeners.close());
  const tools: CanonicalSelfClaimListener = await startAdoptedCeoToolSocket(fixture.h.cp, lock, dir, fixture.admission(), buzz
    ? {
        buzzActorIngress: new BuzzActorIngress(
          new IngressGuard(fixture.h.cp.db, fixture.h.cp.clock, fixture.h.cp.audit, {
            buzz: { secret: BUZZ_SECRET, allowedActors: [CEO_KEY] },
          }),
          fixture.h.cp.sessions,
        ),
      }
    : {});
  closers.push(() => tools.close());
  return { fixture, ceoConversation, tools };
};

const initialized = async (path: string): Promise<Relay> => {
  const r = relay(path);
  const init = await r.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "hermes-gateway", version: "1" },
  });
  expect(init.error).toBeUndefined();
  r.notify("notifications/initialized");
  return r;
};

describe("closing a kernel-peer listener does not wait on its connections (PR1046-R3)", () => {
  it("closes with an admitted relay still attached, and the relay sees its stream end", async () => {
    const { tools } = await started(true);
    const r = await initialized(tools.socketPath);
    // The Gateway is alive and the relay's stdin stays open: nothing on the client side ends this.
    expect(await settles(tools.close().then(() => 0))).toBe(0);
    expect(await settles(r.exit)).toBe(ATTACH_EXIT.STREAM_CLOSED);
  });

  it("closes while an admission is still deciding, and serves nothing once it decides", async () => {
    const dir = stateDir();
    let decide: (decision: Decision<string>) => void = () => undefined;
    const pending = new Promise<Decision<string>>((resolve) => {
      decide = resolve;
    });
    let served = 0;
    let admissions = 0;
    const listener = await startAdoptedCeoToolListener(lock, dir, () => {
      admissions += 1;
      return pending;
    }, () => {
      served += 1;
    });
    const client = createConnection(listener.socketPath);
    client.on("error", () => undefined);
    const ended = new Promise<void>((resolve) => client.once("close", () => resolve()));
    await new Promise<void>((resolve) => client.once("connect", () => resolve()));
    for (let wait = 0; admissions === 0 && wait < 100; wait += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(admissions).toBe(1);
    expect(await settles(listener.close().then(() => 0))).toBe(0);
    decide(allow(ReasonCode.OK, "admitted after the close"));
    await ended;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(served).toBe(0);
  });
});

describe("the adopted CEO tool socket, through the relay", () => {
  it("serves the adopted CEO's tools without registering a conversation or writing any identity", async () => {
    const { fixture, ceoConversation, tools } = await started(true);
    const { h } = fixture;
    expect(statSync(tools.socketPath).mode & 0o777).toBe(0o600);
    const identity = () => ({
      actors: count(h, "SELECT COUNT(*) AS n FROM conversational_actors"),
      sessions: count(h, "SELECT COUNT(*) AS n FROM sessions"),
      liveHermes: count(h, "SELECT COUNT(*) AS n FROM sessions WHERE provider = 'hermes' AND lifecycle = 'READY'"),
      assignments: h.cp.db.all("SELECT assignment_id, binding_generation, status FROM assignments WHERE role_key = ?", [CEO]),
      targets: h.cp.db.all("SELECT * FROM actor_target_bindings"),
      attestations: count(h, "SELECT COUNT(*) AS n FROM actor_target_attestations"),
      turns: count(h, "SELECT COUNT(*) AS n FROM canonical_turns"),
    });
    const before = identity();

    const r = await initialized(tools.socketPath);
    const listed = await r.request("tools/list", {});
    expect(listed.result?.tools?.map((tool) => tool.name)).toContain("run_create");
    const refused = await r.request("tools/call", runCreate("adopted-1"));
    expect(refused.result?.structuredContent).toMatchObject({ ok: false, reasonCode: ReasonCode.MCP_TOOL_PROVENANCE_REFUSED });
    expect(count(h, "SELECT COUNT(*) AS n FROM runs")).toBe(0);
    const created = await r.request("tools/call", runCreate("adopted-2", OWNER_TURN));
    expect(created.result?.structuredContent).toMatchObject({ ok: true, value: { state: "QUEUED" } });
    expect(count(h, "SELECT COUNT(*) AS n FROM runs")).toBe(1);

    // Zero new conversation: the channel never became the CEO's conversation peer, and the CEO's
    // identity — actor, runtime rows, generation, lineage, attestations, turns — is as it was.
    expect(ceoConversation.connected()).toBe(false);
    expect(identity()).toEqual(before);

    r.stdin.end();
    expect(await settles(r.exit)).toBe(ATTACH_EXIT.OK);
  });

  it("admits the same Gateway again on reconnect and concurrently, with the generation unchanged", async () => {
    const { fixture, tools } = await started(true);
    const { h } = fixture;
    const generation = () => h.cp.db.all("SELECT assignment_id, binding_generation, status FROM assignments WHERE role_key = ?", [CEO]);
    const before = generation();
    const first = await initialized(tools.socketPath);
    first.stdin.end();
    expect(await settles(first.exit)).toBe(ATTACH_EXIT.OK);
    const [left, right] = await Promise.all([initialized(tools.socketPath), initialized(tools.socketPath)]);
    for (const [index, r] of [left, right].entries()) {
      const created = await r.request("tools/call", runCreate(`reconnect-${index}`, OWNER_TURN));
      expect(created.result?.structuredContent).toMatchObject({ ok: true });
      r.stdin.end();
      expect(await settles(r.exit)).toBe(ATTACH_EXIT.OK);
    }
    expect(generation()).toEqual(before);
    expect(count(h, "SELECT COUNT(*) AS n FROM sessions")).toBe(1);
  });

  it("binds the CEO's own Buzz channel identity over the channel, idempotently, and not once the binding moves", async () => {
    const { fixture, tools } = await started(true, true);
    const { h } = fixture;
    const bind = (r: Relay, nonce: string) =>
      r.request("tools/call", {
        name: "buzz_actor_bind",
        arguments: {
          actor: CEO_KEY,
          nonce,
          signature: ingressSignature(
            BUZZ_SECRET,
            buzzActorBindingSigningRequest({ actor: CEO_KEY, sessionId: fixture.gatewaySessionId, nonce }),
          ),
        },
        _meta: OWNER_TURN,
      }) as Promise<Wire>;
    const r = await initialized(tools.socketPath);
    expect((await bind(r, "bind-1")).result?.structuredContent).toMatchObject({
      ok: true,
      value: { sessionId: fixture.gatewaySessionId, buzzActorId: CEO_KEY },
    });
    expect(h.cp.sessions.get(fixture.gatewaySessionId)?.buzzActorId).toBe(CEO_KEY);
    const bound = snapshot(h);
    expect((await bind(r, "bind-2")).result?.structuredContent).toMatchObject({ ok: true });
    expect(snapshot(h)).toEqual(bound);

    // The operator re-adopts: this channel's runtime no longer holds the CEO binding.
    expect(h.cp.bindings.revoke(CEO, "operator re-adoption").allowed).toBe(true);
    const revoked = snapshot(h);
    expect((await bind(r, "bind-3")).result?.structuredContent).toMatchObject({
      ok: false,
      reasonCode: ReasonCode.BINDING_GENERATION_STALE,
    });
    expect(snapshot(h)).toEqual(revoked);
    r.stdin.end();
    expect(await settles(r.exit)).toBe(ATTACH_EXIT.OK);
  });

  it("refuses a peer outside the Gateway's ancestry with its reason code only, and writes nothing", async () => {
    const { fixture, tools } = await started(false);
    const before = snapshot(fixture.h);
    const r = relay(tools.socketPath);
    r.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
    const exited = await settles(r.exit);
    if (exited === "did-not-settle") r.stdin.end();
    expect(exited).toBe(ATTACH_EXIT.HANDSHAKE_REFUSED);
    expect(r.err()).toBe(`attach: handshake refused ${ReasonCode.CONFLICT}\n`);
    expect(r.out()).toBe("");
    expect(snapshot(fixture.h)).toEqual(before);
  });
});
