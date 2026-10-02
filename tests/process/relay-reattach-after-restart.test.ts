import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import {
  ATTACH_EXIT,
  RELAY_REATTACHING_ERROR,
  runAttachRelay,
  type ReattachPolicy,
} from "../../src/cli/attach-relay.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { startLocalMcpListeners, type LocalMcpListeners } from "../../src/daemon/agentcpd.ts";
import { WAKE_TRANSPORT_QUALIFIED_CLIENTS } from "../../src/mcp/role-conversation.ts";
import { count } from "../helpers/adopted-ceo.ts";
import {
  canonicalCtoFixture,
  CLAUDE,
  claudeProcess,
  CONVERSATION,
  CTO,
  OTHER_CLAUDE,
  PROJECT,
  type CanonicalCtoFixture,
} from "../helpers/canonical-cto-reattach.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";

/**
 * A canonical CTO's relay across a daemon restart (#1037 follow-up, measured live at 12:1xZ: the
 * restart closed the relay's connection, the relay exited by design, Claude Code does not respawn
 * a dead stdio MCP server, and the ACTIVE binding was left with no tools and no wake path).
 *
 * The daemon here is the real listener pair and reattach door, closed and opened again on the same
 * state directory the way a restart does. The relay is the real one, run in-process so the kernel
 * reports this test process as the peer; the process tree above it is stated. The claim socket is a
 * fixture that counts what reaches it: a reattach must never fall back to a claim.
 */

const TOKEN = "fixture-mcp-token";
const POLICY: Partial<ReattachPolicy> = { maxWaitMs: 5_000, initialDelayMs: 20, maxDelayMs: 100, attemptTimeoutMs: 2_000 };
const qualified = WAKE_TRANSPORT_QUALIFIED_CLIENTS[0]!;

interface Wire {
  id?: unknown;
  result?: { tools?: Array<{ name: string }>; structuredContent?: Record<string, unknown> };
  error?: { code?: number; message?: string };
}

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

const until = async (condition: () => boolean, budgetMs = 5_000): Promise<boolean> => {
  for (const started = Date.now(); Date.now() - started < budgetMs;) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return condition();
};

const roots: string[] = [];
const fixtures: CanonicalCtoFixture[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close().catch(() => undefined);
  for (const made of fixtures.splice(0)) made.h.cp.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
afterAll(cleanupTempDirs);

/** A daemon's listeners on one state directory, which a test can stop and start again. */
const daemonOn = async (subject: CanonicalCtoFixture, dir: string) => {
  let current: LocalMcpListeners | null = null;
  const open = async (): Promise<LocalMcpListeners> => {
    current = await startLocalMcpListeners(subject.h.cp, dir, TOKEN);
    await current.openCanonicalCtoReattach(subject.reattach(), { lock: { held: () => true } });
    return current;
  };
  const stop = async (): Promise<void> => {
    const closing = current;
    current = null;
    await closing?.close();
  };
  closers.push(stop);
  await open();
  return { open, stop, current: () => current };
};

const started = async () => {
  const subject = canonicalCtoFixture();
  fixtures.push(subject);
  // The kernel will report this process as the peer: it runs under the stated claude.
  subject.processes.set(process.pid, { ppid: CLAUDE, startedAt: "darwin-tv:1790000500.000005", argv: ["node"] });
  const dir = mkdtempSync("/tmp/acp37r-");
  roots.push(dir);
  const daemon = await daemonOn(subject, dir);
  const claims: string[] = [];
  const sockets: Socket[] = [];
  const claimServer: Server = createServer((socket) => {
    sockets.push(socket);
    socket.once("data", (chunk) => {
      claims.push(chunk.toString("utf8"));
      socket.end(`${JSON.stringify({ allowed: false, reasonCode: ReasonCode.BINDING_ALREADY_ACTIVE })}\n`);
    });
  });
  const claimPath = join(dir, "c.sock");
  await new Promise<void>((resolve) => claimServer.listen(claimPath, resolve));
  const endpoint = join(dir, "w.sock");
  const wake = createServer((socket) => socket.resume());
  await new Promise<void>((resolve) => wake.listen(endpoint, resolve));
  closers.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => claimServer.close(() => resolve()));
    await new Promise<void>((resolve) => wake.close(() => resolve()));
  });
  return {
    subject,
    daemon,
    claims,
    endpoint,
    paths: {
      claimPath,
      ctoPath: join(dir, "cto.mcp.sock"),
      reattachPath: join(dir, "agentcpd.canonical-cto-tools.sock"),
    },
  };
};

const relay = (paths: { claimPath: string; ctoPath: string; reattachPath: string }, policy = POLICY) => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let errText = "";
  let pendingText = "";
  let nextId = 1;
  const pending = new Map<number, (message: Wire) => void>();
  stdout.on("data", (chunk: Buffer) => {
    pendingText += chunk.toString("utf8");
    for (;;) {
      const newline = pendingText.indexOf("\n");
      if (newline < 0) break;
      const message = JSON.parse(pendingText.slice(0, newline)) as Wire;
      pendingText = pendingText.slice(newline + 1);
      if (typeof message.id === "number") pending.get(message.id)?.(message);
    }
  });
  stderr.on("data", (chunk: Buffer) => {
    errText += chunk.toString("utf8");
  });
  const exit = runAttachRelay(
    {
      claimSocketPath: paths.claimPath,
      mcpSocketPath: paths.ctoPath,
      reattachSocketPath: paths.reattachPath,
      mcpToken: TOKEN,
      claim: { claimedSessionUuid: CONVERSATION, projectId: PROJECT, expectedBindingGeneration: 2 },
      reattach: policy,
    },
    { stdin, stdout, stderr },
  );
  let exited: number | null = null;
  void exit.then((code) => {
    exited = code;
  });
  return {
    exit,
    stdin,
    exited: () => exited,
    err: () => errText,
    request: (method: string, params: unknown) =>
      new Promise<Wire>((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => reject(new Error(`timeout awaiting ${method}; stderr=${errText}`)), 10_000);
        pending.set(id, (message) => {
          clearTimeout(timer);
          resolve(message);
        });
        stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      }),
    notify: (method: string) => stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`),
  };
};

/** Attached, initialized and registered for wake, the state a live canonical CTO is in. */
const attachedAndRegistered = async () => {
  const fixture = await started();
  const r = relay(fixture.paths);
  const init = await r.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: qualified });
  expect(init.error).toBeUndefined();
  r.notify("notifications/initialized");
  const registered = await r.request("tools/call", {
    name: "role_wake_endpoint_register",
    arguments: { endpoint: fixture.endpoint },
  });
  expect(registered.result?.structuredContent).toMatchObject({ ok: true });
  expect(fixture.daemon.current()?.ctoConversation.endpointFor(CTO)).toBe(fixture.endpoint);
  return { ...fixture, r };
};

const generation = (subject: CanonicalCtoFixture) =>
  subject.h.cp.db.all("SELECT assignment_id, binding_generation, status FROM assignments WHERE role_key = ?", [CTO]);

describe("a canonical CTO relay across a daemon restart", () => {
  it("reattaches, re-registers its wake endpoint, and keeps the generation, the session and the client's stdio", async () => {
    const { subject, daemon, claims, endpoint, r } = await attachedAndRegistered();
    const before = generation(subject);
    await daemon.stop();
    await daemon.open();
    // The restarted daemon learns the wake endpoint from the relay, with no client involvement.
    expect(await until(() => daemon.current()?.ctoConversation.endpointFor(CTO) === endpoint)).toBe(true);
    expect(r.exited()).toBeNull();
    const listed = await r.request("tools/list", {});
    expect(listed.result?.tools?.map((tool) => tool.name)).toContain("role_owner_message_claim");
    expect(generation(subject)).toEqual(before);
    expect(count(subject.h, "SELECT COUNT(*) AS n FROM sessions")).toBe(1);
    expect(claims).toEqual([]);
    r.stdin.end();
    expect(await settles(r.exit)).toBe(ATTACH_EXIT.OK);
  });

  it("answers a request sent while it is reattaching with the defined error, and serves the next one", async () => {
    const { daemon, r } = await attachedAndRegistered();
    await daemon.stop();
    const refused = await r.request("tools/list", {});
    expect(refused.error).toMatchObject({ code: RELAY_REATTACHING_ERROR });
    expect(refused.result).toBeUndefined();
    await daemon.open();
    expect(await until(() => daemon.current()?.ctoConversation.endpointFor(CTO) !== null)).toBe(true);
    const listed = await r.request("tools/list", {});
    expect(listed.error).toBeUndefined();
    r.stdin.end();
    expect(await settles(r.exit)).toBe(ATTACH_EXIT.OK);
  });

  it("exits without claiming when the binding was revoked before the daemon came back", async () => {
    const { subject, daemon, claims, r } = await attachedAndRegistered();
    await daemon.stop();
    expect(subject.h.cp.bindings.revoke(CTO, "revoked across the restart").allowed).toBe(true);
    await daemon.open();
    expect(await settles(r.exit)).toBe(ATTACH_EXIT.HANDSHAKE_REFUSED);
    expect(r.err()).toBe(`attach: reattach refused ${ReasonCode.CTO_REATTACH_UNBOUND}\n`);
    expect(claims).toEqual([]);
  });

  it("exits without claiming when the binding's runtime is another process", async () => {
    const { subject, daemon, claims, r } = await attachedAndRegistered();
    await daemon.stop();
    // The same conversation, now under another claude: this relay's ancestry no longer holds it.
    subject.processes.set(OTHER_CLAUDE, claudeProcess(CONVERSATION, "darwin-tv:1790000400.000004"));
    subject.processes.set(process.pid, { ppid: OTHER_CLAUDE, startedAt: "darwin-tv:1790000500.000005", argv: ["node"] });
    await daemon.open();
    expect(await settles(r.exit)).toBe(ATTACH_EXIT.HANDSHAKE_REFUSED);
    expect(r.err()).toBe(`attach: reattach refused ${ReasonCode.CTO_REATTACH_UNBOUND}\n`);
    expect(claims).toEqual([]);
  });

  it("answers a request in flight when the connection closed with the defined error, outcome unknown", async () => {
    // A stand-in daemon behind the reattach door: it admits, answers `initialize`, never answers a
    // tool call, and drops the first connection while that call is outstanding.
    const dir = mkdtempSync("/tmp/acp37f-");
    roots.push(dir);
    const door = join(dir, "door.sock");
    const connections: Socket[] = [];
    const server = createServer((socket) => {
      connections.push(socket);
      socket.write(`${JSON.stringify({ ok: true, reasonCode: ReasonCode.OK })}\n`);
      let held = "";
      socket.on("data", (chunk: Buffer) => {
        held += chunk.toString("utf8");
        for (let newline = held.indexOf("\n"); newline >= 0; newline = held.indexOf("\n")) {
          const message = JSON.parse(held.slice(0, newline)) as { id?: unknown; method?: string };
          held = held.slice(newline + 1);
          if (message.method === "initialize") {
            socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "stand-in", version: "1" } } })}\n`);
          }
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(door, resolve));
    closers.push(async () => {
      for (const socket of connections) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const r = relay({ claimPath: join(dir, "absent.sock"), ctoPath: join(dir, "absent.sock"), reattachPath: door });
    expect((await r.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: qualified })).error)
      .toBeUndefined();
    const outstanding = r.request("tools/call", { name: "anything", arguments: {} });
    expect(await until(() => connections.length === 1)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    connections[0]!.destroy();
    const answered = await outstanding;
    expect(answered.error).toMatchObject({ code: RELAY_REATTACHING_ERROR });
    expect(answered.error?.message).toContain("outcome is unknown");
    // It came back through the door and replayed the client's own initialize there.
    expect(await until(() => connections.length === 2)).toBe(true);
    r.stdin.end();
    expect(await settles(r.exit)).toBe(ATTACH_EXIT.OK);
  });

  it("exits once the daemon has not come back within its bound", async () => {
    const fixture = await started();
    const r = relay(fixture.paths, { ...POLICY, maxWaitMs: 300 });
    const init = await r.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: qualified });
    expect(init.error).toBeUndefined();
    await fixture.daemon.stop();
    expect(await settles(r.exit)).toBe(ATTACH_EXIT.UNAVAILABLE);
    expect(r.err()).toBe("attach: daemon did not return\n");
    expect(fixture.claims).toEqual([]);
  });
});
