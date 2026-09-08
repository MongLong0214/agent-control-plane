import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OwnerApprovalReceipt } from "../../src/ceo/owner-authority.ts";
import type { Decision } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { startDaemonMcpListeners, type LocalMcpListeners } from "../../src/daemon/agentcpd.ts";
import { Daemon } from "../../src/daemon/daemon.ts";
import { Role, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { C0_QUALIFIED_CLIENT } from "../../src/mcp/role-conversation.ts";
import type { AttachmentCredential } from "../../src/session/role-attachment-credentials.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { fixtureManifest, makeHarness, TEST_OWNER, type Harness } from "../helpers/harness.ts";

const valueOf = <T>(decision: Decision<T>): T => {
  if (!decision.allowed) throw new Error(JSON.stringify(decision));
  return decision.value;
};
interface ToolBody { ok: boolean; reasonCode: string }
interface WireMessage { id?: number; result?: { structuredContent?: ToolBody }; error?: unknown; ok?: boolean }

// These tests require real Unix listeners. They are intentionally separate from authorization
// tests: only this file checks daemon listener composition, connection ownership and close.
describe("role attachment over real daemon sockets", () => {
  let h: Harness;
  let daemon: Daemon;
  let listeners: LocalMcpListeners;
  let stateDir: string;
  let endpoint: string;
  let wake: Server;
  let subject: { sessionId: string; sessionSecret: string };
  let roleKey: string;
  const sockets: Socket[] = [];
  const token = "attachment-test-deployment-token";
  const operator = { channel: "cli", actor: TEST_OWNER.actor, peerId: "test-owner", incarnation: "test" } as const;
  const ready = () => {
    const s = h.cp.sessions.create({ provider: "scripted", model: "fixture" });
    valueOf(h.cp.sessions.transition(s.sessionId, SessionLifecycle.READY));
    if (!s.sessionSecret) throw new Error("fixture secret unavailable");
    return { sessionId: s.sessionId, sessionSecret: s.sessionSecret };
  };
  const grant = async () => {
    const receipt = valueOf(await daemon.handleOperatorRequest({ requestId: randomUUID(),
      method: "owner.approveRoleAttachment", params: { ...subject, roleKey, nonce: randomUUID(), approved: true },
    }, operator)) as OwnerApprovalReceipt;
    return valueOf(daemon.attachments.issue({ ...subject, roleKey, approval: receipt }));
  };
  const open = async (credential: AttachmentCredential | typeof subject, presentedToken = token, socketIndex = 1) => {
    const socket = createConnection(listeners.socketPaths[socketIndex]!);
    sockets.push(socket);
    const pending = new Map<number, { resolve: (value: WireMessage) => void; reject: (error: Error) => void }>();
    let buffer = "";
    let nextId = 1;
    let failure: Error | undefined;
    const fail = (error: Error) => {
      failure = error;
      for (const entry of pending.values()) entry.reject(error);
      pending.clear();
    };
    socket.on("error", fail);
    socket.on("close", () => fail(new Error("connection closed")));
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const message = JSON.parse(buffer.slice(0, newline)) as WireMessage;
        buffer = buffer.slice(newline + 1);
        if (message.ok === false) {
          fail(Object.assign(new Error(JSON.stringify(message)), { refusal: message }));
          continue;
        }
        if (message.id !== undefined) {
          const entry = pending.get(message.id);
          pending.delete(message.id);
          if (message.error) entry?.reject(new Error(JSON.stringify(message.error)));
          else entry?.resolve(message);
        }
      }
    });
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    const request = (method: string, params: unknown): Promise<WireMessage> => new Promise((resolve, reject) => {
      if (failure) { reject(failure); return; }
      const id = nextId++;
      const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`timeout: ${method}`)); }, 3000);
      pending.set(id, {
        resolve: (message) => { clearTimeout(timeout); resolve(message); },
        reject: (error) => { clearTimeout(timeout); reject(error); },
      });
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
    socket.write(`${JSON.stringify({ token: presentedToken, ...credential })}\n`);
    await request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: C0_QUALIFIED_CLIENT });
    socket.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    return {
      socket,
      register: async (extra = {}) => (await request("tools/call", {
        name: "role_wake_endpoint_register", arguments: { endpoint, ...extra },
      })).result!.structuredContent!,
    };
  };

  beforeEach(async () => {
    h = makeHarness();
    const manifest = fixtureManifest("attachment-project");
    valueOf(h.cp.projects.register({ projectId: manifest.projectId, name: "fixture", manifest,
      authorization: h.cp.manifestAuthorizationForTests(manifest) }));
    subject = ready();
    roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId: manifest.projectId });
    valueOf(h.cp.bindings.bind({ role: Role.PRIMARY_CTO, projectId: manifest.projectId, sessionId: subject.sessionId }));
    // Short and inside this checkout, including on macOS with its short Unix path limit.
    stateDir = mkdtempSync(join(fileURLToPath(new URL("../../", import.meta.url)), ".at-"));
    daemon = new Daemon(h.cp, { stateDir });
    valueOf(daemon.lock.acquire(h.clock.nowIso()));
    listeners = await startDaemonMcpListeners(h.cp, stateDir, token, daemon);
    endpoint = join(stateDir, "w.sock");
    wake = createServer((socket) => socket.resume());
    await new Promise<void>((resolve, reject) => { wake.once("error", reject); wake.listen(endpoint, resolve); });
  });
  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.destroy();
    await listeners?.close();
    if (wake?.listening) await new Promise<void>((resolve) => wake.close(() => resolve()));
    daemon?.lock.release();
    h?.cp.db.close();
    if (stateDir) rmSync(stateDir, { recursive: true, force: true });
    cleanupTempDirs();
  });

  it("the production listener admits the approved attachment and registers its own endpoint", async () => {
    const credential = await grant();
    const peer = await open(credential);
    expect((await peer.register({ sessionId: "forged", bindingGeneration: 999, connection: "other" })).ok).toBe(true);
    expect(listeners.ctoConversation.endpointFor(roleKey)).toBe(endpoint);
    expect(h.cp.sessions.verifySecret(subject.sessionId, subject.sessionSecret).allowed).toBe(true);
  });

  it("a different connection cannot register for the attachment holder", async () => {
    const first = await open(await grant());
    const sibling = await open(subject);
    expect((await sibling.register()).ok).toBe(false);
    expect(listeners.ctoConversation.endpointFor(roleKey)).toBeNull();
    expect((await first.register()).ok).toBe(true);
    expect(listeners.ctoConversation.endpointFor(roleKey)).toBe(endpoint);
  });

  it("connection close after MCP initialization clears registration and permanently spends the credential", async () => {
    const credential = await grant();
    const peer = await open(credential);
    expect((await peer.register()).ok).toBe(true);
    peer.socket.destroy();
    await expect.poll(() => listeners.ctoConversation.connected(roleKey)).toBe(false);
    expect(listeners.ctoConversation.endpointFor(roleKey)).toBeNull();
    await expect(open(credential)).rejects.toMatchObject({ refusal: { ok: false,
      reasonCode: ReasonCode.MCP_PEER_UNAUTHENTICATED, message: "attachment credential is unknown or invalid" } });
    expect((await (await open(await grant())).register()).ok).toBe(true);
  });

  it("a close before MCP installs onclose permanently spends the attachment", async () => {
    const credential = await grant();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    // Hold the SDK boundary before it installs transport.onclose. Only the raw socket
    // listener can invalidate this admission; no initialize request or MCP close runs.
    const connecting = vi.spyOn(McpServer.prototype, "connect").mockImplementationOnce(async (transport) => {
      await transport.start();
      await held;
    });
    try {
      const socket = createConnection(listeners.socketPaths[1]!);
      sockets.push(socket);
      await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
      socket.write(`${JSON.stringify({ token, ...credential })}\n`);
      await expect.poll(() => connecting.mock.calls.length).toBe(1);
      expect(listeners.ctoConversation.connected(roleKey)).toBe(true);
      socket.destroy();
      await expect.poll(() => listeners.ctoConversation.connected(roleKey)).toBe(false);
      expect(daemon.attachments.authorize(credential).allowed).toBe(false);
    } finally {
      release();
      connecting.mockRestore();
    }
  });

  it("an occupied ordinary connection is preserved when attachment admission is refused", async () => {
    const incumbent = await open(subject);
    expect((await incumbent.register()).ok).toBe(true);
    const credential = await grant();
    await expect(open(credential)).rejects.toMatchObject({ refusal: { ok: false,
      reasonCode: ReasonCode.CONFLICT, message: "attachment requires an empty role slot" } });
    expect((await incumbent.register()).ok).toBe(true);
    incumbent.socket.destroy();
    await expect.poll(() => listeners.ctoConversation.connected(roleKey)).toBe(false);
    expect((await (await open(credential)).register()).ok).toBe(true);
  });

  it("registration revalidation refuses a changed generation on an already open attachment", async () => {
    // This measures revalidation at registration, not eager cleanup on transfer. Successor
    // admission without an intervening registration is covered by the authorization tests.
    const peer = await open(await grant());
    expect((await peer.register()).ok).toBe(true);
    valueOf(h.cp.bindings.switchTo({ role: Role.PRIMARY_CTO, projectId: "attachment-project",
      ...ready(), conversation: "REPLACED", reason: "test transition" }));
    expect((await peer.register()).ok).toBe(false);
    expect(listeners.ctoConversation.endpointFor(roleKey)).toBeNull();
  });

  it("revocation clears registration on an open connection without revoking the session credential", async () => {
    const credential = await grant();
    const peer = await open(credential);
    expect((await peer.register()).ok).toBe(true);
    valueOf(daemon.attachments.revoke({ ...subject, attachmentId: credential.attachmentId }));
    expect(listeners.ctoConversation.endpointFor(roleKey)).toBeNull();
    expect((await peer.register()).ok).toBe(false);
    expect(h.cp.sessions.verifySecret(subject.sessionId, subject.sessionSecret).allowed).toBe(true);
  });

  it("the deployment token and the CTO attachment route remain required", async () => {
    const credential = await grant();
    await expect(open(credential, "wrong")).rejects.toMatchObject({ refusal: { ok: false,
      reasonCode: ReasonCode.MCP_PEER_UNAUTHENTICATED, message: "local MCP authentication failed" } });
    await expect(open(credential, token, 0)).rejects.toMatchObject({ refusal: { ok: false,
      reasonCode: ReasonCode.MCP_PEER_UNAUTHENTICATED, message: "this socket does not admit attachments" } });
    await expect(open({ ...credential, attachmentSecret: "wrong" })).rejects.toMatchObject({ refusal: { ok: false,
      reasonCode: ReasonCode.MCP_PEER_UNAUTHENTICATED, message: "attachment credential is unknown or invalid" } });
    expect((await (await open(credential)).register()).ok).toBe(true);
  });
});
