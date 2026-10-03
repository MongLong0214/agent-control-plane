import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import { ATTACH_EXIT, runAttachRelay, runAttachRelayCommand } from "../../src/cli/attach-relay.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { startLocalMcpListeners } from "../../src/daemon/agentcpd.ts";
import {
  CANONICAL_CTO_TOOL_SOCKET_FILENAME,
  MAX_SUN_PATH_BYTES,
} from "../../src/daemon/canonical-self-claim-listener.ts";
import { count, snapshot } from "../helpers/adopted-ceo.ts";
import {
  canonicalCtoFixture,
  CLAUDE,
  CONVERSATION,
  CTO,
  PROJECT,
  type CanonicalCtoFixture,
} from "../helpers/canonical-cto-reattach.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";

/**
 * The canonical CTO's reattach end to end (#1037): the real kernel-peer listener, the real
 * reattach decision, the real CTO MCP server behind it and the real relay in front of it, which
 * asks the reattach socket before it would claim. The claim socket is a fixture that counts what
 * reaches it. The only stated facts are the process tree above this test process — which the
 * kernel reports as the peer, since the relay runs in-process.
 */

const TOKEN = "fixture-mcp-token";
const roots: string[] = [];
const fixtures: CanonicalCtoFixture[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  for (const made of fixtures.splice(0)) made.h.cp.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
afterAll(cleanupTempDirs);

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

interface Wire {
  id?: number;
  result?: { tools?: Array<{ name: string }> };
  error?: unknown;
}

const started = async () => {
  const subject = canonicalCtoFixture();
  fixtures.push(subject);
  // The kernel will report this process as the peer: it runs under the stated claude.
  subject.processes.set(process.pid, { ppid: CLAUDE, startedAt: "darwin-tv:1790000500.000005", argv: ["node"] });
  const dir = mkdtempSync("/tmp/acp37c-");
  roots.push(dir);
  expect(Buffer.byteLength(join(dir, CANONICAL_CTO_TOOL_SOCKET_FILENAME))).toBeLessThanOrEqual(MAX_SUN_PATH_BYTES);
  const opened = await startLocalMcpListeners(subject.h.cp, dir, TOKEN);
  // Closed once, by whichever of the test and the teardown gets there first.
  let closedOnce: Promise<void> | null = null;
  const listeners = { ...opened, close: () => (closedOnce ??= opened.close()) };
  closers.push(() => listeners.close());
  const reattachPath = await listeners.openCanonicalCtoReattach(subject.reattach(), { lock: { held: () => true } });
  // A claim socket that records every request and refuses it, so a claim the relay should not
  // have made is visible and one it should have made ends the attach without minting anything.
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
  closers.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => claimServer.close(() => resolve()));
  });
  return { subject, listeners, claims, claimPath, reattachPath, ctoPath: listeners.socketPaths[1]! };
};

const relay = (paths: { claimPath: string; ctoPath: string; reattachPath: string }, entry: "relay" | "command" = "relay") => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let errText = "";
  let pendingText = "";
  const pending = new Map<number, (message: Wire) => void>();
  stdout.on("data", (chunk: Buffer) => {
    pendingText += chunk.toString("utf8");
    for (;;) {
      const newline = pendingText.indexOf("\n");
      if (newline < 0) break;
      const message = JSON.parse(pendingText.slice(0, newline)) as Wire;
      pendingText = pendingText.slice(newline + 1);
      if (message.id !== undefined) pending.get(message.id)?.(message);
    }
  });
  stderr.on("data", (chunk: Buffer) => {
    errText += chunk.toString("utf8");
  });
  const common = {
    claimSocketPath: paths.claimPath,
    mcpSocketPath: paths.ctoPath,
    reattachSocketPath: paths.reattachPath,
    claim: { claimedSessionUuid: CONVERSATION, projectId: PROJECT, expectedBindingGeneration: 2 },
    // A daemon that never comes back is waited for briefly here, so a closed listener ends a test.
    reattach: { maxWaitMs: 300, initialDelayMs: 20, maxDelayMs: 100, attemptTimeoutMs: 2_000 },
  };
  const exit = entry === "command"
    ? runAttachRelayCommand(common, { stdin, stdout, stderr })
    : runAttachRelay({ ...common, mcpToken: TOKEN }, { stdin, stdout, stderr });
  let nextId = 1;
  return {
    exit,
    stdin,
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
  };
};

/**
 * The CLI entry with no deployment credential to be had: no `ACP_MCP_TOKEN`, and no `security`
 * binary on PATH, so the Keychain read fails before it reaches any Keychain.
 */
const withoutCredential = async <T>(run: () => Promise<T>): Promise<T> => {
  const saved = { token: process.env["ACP_MCP_TOKEN"], path: process.env["PATH"] };
  process.env["ACP_MCP_TOKEN"] = "";
  process.env["PATH"] = "/nonexistent-acp-1037";
  try {
    return await run();
  } finally {
    if (saved.token === undefined) delete process.env["ACP_MCP_TOKEN"];
    else process.env["ACP_MCP_TOKEN"] = saved.token;
    process.env["PATH"] = saved.path;
  }
};

describe("the CLI entry reattaches before it asks for the deployment credential (PR1046-R2)", () => {
  it("reattaches a live claimant whose credential cannot be read", async () => {
    const paths = await started();
    await withoutCredential(async () => {
      const r = relay(paths, "command");
      const init = await r.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "claude-code", version: "1" } });
      expect(init.error).toBeUndefined();
      const listed = await r.request("tools/list", {});
      expect(listed.result?.tools?.map((tool) => tool.name)).toContain("role_owner_message_claim");
      r.stdin.end();
      expect(await settles(r.exit)).toBe(ATTACH_EXIT.OK);
      expect(r.err()).toBe("");
    });
    expect(paths.claims).toEqual([]);
  });

  it("asks for the credential only on the fallback, and claims nothing it could not then attach", async () => {
    const paths = await started();
    expect(paths.subject.h.cp.bindings.revoke(CTO, "revoked before the respawn").allowed).toBe(true);
    await withoutCredential(async () => {
      const r = relay(paths, "command");
      const exited = await settles(r.exit);
      if (exited === "did-not-settle") r.stdin.end();
      expect(exited).toBe(ATTACH_EXIT.UNAVAILABLE);
      expect(r.err()).toBe("attach: mcp token unavailable\n");
    });
    expect(paths.claims).toEqual([]);
  });
});

describe("closing the listeners does not wait on a reattached relay (PR1046-R3)", () => {
  it("closes with a reattached relay still attached", async () => {
    const paths = await started();
    const r = relay(paths);
    const init = await r.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "claude-code", version: "1" } });
    expect(init.error).toBeUndefined();
    expect(await settles(paths.listeners.close().then(() => 0))).toBe(0);
    // The relay outlives the closed connection and waits for the daemon; none comes back, so it
    // exits once its bounded wait is over.
    expect(await settles(r.exit)).toBe(ATTACH_EXIT.UNAVAILABLE);
  });
});

describe("the canonical CTO relay reattaches before it would claim", () => {
  it("reattaches the live claimant to its own CTO tools without a claim, and again after a respawn", async () => {
    const paths = await started();
    const { subject, claims } = paths;
    const before = subject.h.cp.db.all("SELECT assignment_id, binding_generation, status FROM assignments WHERE role_key = ?", [CTO]);
    for (const attempt of [1, 2]) {
      const r = relay(paths);
      const init = await r.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "claude-code", version: "1" } });
      expect(init.error, `attempt ${attempt}`).toBeUndefined();
      const listed = await r.request("tools/list", {});
      expect(listed.result?.tools?.map((tool) => tool.name)).toContain("role_owner_message_claim");
      r.stdin.end();
      expect(await settles(r.exit)).toBe(ATTACH_EXIT.OK);
    }
    expect(claims).toEqual([]);
    expect(subject.h.cp.db.all("SELECT assignment_id, binding_generation, status FROM assignments WHERE role_key = ?", [CTO])).toEqual(before);
    expect(count(subject.h, "SELECT COUNT(*) AS n FROM sessions")).toBe(1);
  });

  it("claims only when this process holds no binding, and writes nothing on the way", async () => {
    const paths = await started();
    const { subject, claims } = paths;
    expect(subject.h.cp.bindings.revoke(CTO, "revoked before the respawn").allowed).toBe(true);
    const before = snapshot(subject.h);
    const r = relay(paths);
    const exited = await settles(r.exit);
    if (exited === "did-not-settle") r.stdin.end();
    expect(exited).toBe(ATTACH_EXIT.CLAIM_REFUSED);
    expect(claims).toHaveLength(1);
    expect(JSON.parse(claims[0]!)).toMatchObject({ method: "actor.claimCanonicalCto" });
    expect(r.err()).toBe(`attach: claim refused ${ReasonCode.BINDING_ALREADY_ACTIVE}\n`);
    expect(snapshot(subject.h)).toEqual(before);
  });

  it("ends the attach on a refusal that is not 'unbound', without claiming", async () => {
    const paths = await started();
    const { subject, claims } = paths;
    // No claude ancestor at all: the reattach answers as the claim's own derivation would.
    subject.processes.set(process.pid, { ppid: 1, startedAt: "darwin-tv:1790000500.000005", argv: ["node"] });
    const r = relay(paths);
    const exited = await settles(r.exit);
    if (exited === "did-not-settle") r.stdin.end();
    expect(exited).toBe(ATTACH_EXIT.HANDSHAKE_REFUSED);
    expect(r.err()).toMatch(/^attach: reattach refused [A-Z_]+\n$/);
    expect(claims).toEqual([]);
  });
});
