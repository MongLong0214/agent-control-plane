import { writeFileSync } from "node:fs";
import { Socket, type Server } from "node:net";
import type * as netModule from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import { startBuzzMessageIngressListener, startLocalMcpListeners } from "../../src/daemon/agentcpd.ts";
import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Role, SessionLifecycle } from "../../src/domain/types.ts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { RoleConversationPort } from "../../src/mcp/role-conversation.ts";
import { CeoConversationPort } from "../../src/mcp/ceo-conversation.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { fixtureManifest, makeHarness, TEST_OWNER } from "../helpers/harness.ts";

const servers = vi.hoisted(() => [] as Server[]);
// Feed connections to the production listeners without opening OS sockets. Admission and
// envelope validation remain real; these tests isolate operands that neighbouring checks hide.
vi.mock("node:net", async (original) => {
  const net = await original<typeof netModule>();
  return { ...net, createServer: (handler: (socket: Socket) => void) => {
    const server = new net.Server(handler);
    vi.spyOn(server, "listen").mockImplementation((...args: unknown[]) => {
      writeFileSync(args[0] as string, "");
      (args.at(-1) as () => void)();
      return server;
    });
    vi.spyOn(server, "close").mockImplementation((callback) => { callback?.(); return server; });
    servers.push(server);
    return server;
  } };
});

afterEach(() => { servers.length = 0; vi.restoreAllMocks(); cleanupTempDirs(); });

describe("daemon refusals exposed by the operand census", () => {
  it("refuses a socket peer with another session ID even when its incarnation matches the holder", async () => {
    const h = makeHarness();
    const stateDir = tempDir("acp-admission-");
    const manifest = fixtureManifest("admission-project");
    expect(h.cp.projects.register({ projectId: manifest.projectId, name: "fixture", manifest,
      authorization: h.cp.manifestAuthorizationForTests(manifest) }).allowed).toBe(true);
    const ready = () => {
      const session = h.cp.sessions.create({ provider: "scripted", model: "fixture", incarnation: "same-incarnation" });
      expect(h.cp.sessions.transition(session.sessionId, SessionLifecycle.READY).allowed).toBe(true);
      return session;
    };
    const holder = ready();
    const stranger = ready();
    expect(h.cp.bindings.bind({ role: Role.PRIMARY_CTO, projectId: manifest.projectId,
      sessionId: holder.sessionId }).allowed).toBe(true);
    const listeners = await startLocalMcpListeners(h.cp, stateDir, "token");
    const socket = new Socket();
    const end = vi.spyOn(socket, "end").mockImplementation(() => socket);
    try {
      servers[1]!.emit("connection", socket);
      socket.emit("data", Buffer.from(`${JSON.stringify({ token: "token", sessionId: stranger.sessionId,
        sessionSecret: stranger.sessionSecret })}\n`));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(end).toHaveBeenCalled();
      expect(JSON.parse(String(end.mock.calls[0]![0]))).toMatchObject({
        ok: false, reasonCode: "BINDING_GENERATION_STALE", message: "session does not hold this socket's current role",
      });
    } finally { socket.destroy(); await listeners.close(); h.cp.db.close(); }
  });

  const buzzResponse = async (change: Record<string, unknown>) => {
    const h = makeHarness();
    const listener = await startBuzzMessageIngressListener(h.cp, tempDir("acp-message-shape-"), {
      allowedActors: [TEST_OWNER.actor], secret: "test-signing-secret",
    }, { ownerActors: [TEST_OWNER.actor], ceoConversation: new CeoConversationPort() });
    const socket = new Socket();
    const end = vi.spyOn(socket, "end").mockImplementation(() => socket);
    try {
      servers[0]!.emit("connection", socket);
      socket.emit("data", Buffer.from(`${JSON.stringify({ actor: TEST_OWNER.actor, conversation: "room",
        eventId: "event", addressedTo: "CEO", text: "hello", signature: "unverified", ...change })}\n`));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(end).toHaveBeenCalled();
      return JSON.parse(String(end.mock.calls[0]![0])) as Record<string, unknown>;
    } finally { socket.destroy(); await listener.close(); h.cp.db.close(); }
  };

  it("refuses a non-string Buzz message body before authentication", async () => {
    expect(await buzzResponse({ text: 42 })).toMatchObject({
      ok: false, reasonCode: "INVALID_ARGUMENT", message: "Buzz message ingress message is incomplete",
    });
  });

  it.each(["actor", "conversation", "eventId", "addressedTo", "signature"])(
    "refuses a non-string Buzz %s before authentication", async (field) => {
      expect(await buzzResponse({ [field]: 42 })).toMatchObject({
        ok: false, reasonCode: "INVALID_ARGUMENT", message: "Buzz message ingress message is incomplete",
      });
    },
  );

  it.each(["undefined", "null"])("a Buzz %s signature reaches authentication", async (shape) => {
    const response = await buzzResponse({ signature: shape === "null" ? null : undefined });
    expect(response).toMatchObject({ ok: false, reasonCode: "INGRESS_SIGNATURE_INVALID" });
  });

  it("refuses the holder session when only its socket binding incarnation differs", async () => {
    const h = makeHarness();
    const manifest = fixtureManifest("incarnation-project");
    expect(h.cp.projects.register({ projectId: manifest.projectId, name: "fixture", manifest,
      authorization: h.cp.manifestAuthorizationForTests(manifest) }).allowed).toBe(true);
    const holder = h.cp.sessions.create({ provider: "scripted", model: "fixture", incarnation: "holder-incarnation" });
    expect(h.cp.sessions.transition(holder.sessionId, SessionLifecycle.READY).allowed).toBe(true);
    expect(h.cp.bindings.bind({ role: Role.PRIMARY_CTO, projectId: manifest.projectId,
      sessionId: holder.sessionId }).allowed).toBe(true);
    const binding = h.cp.bindings.activePrimaryCto(manifest.projectId)!;
    vi.spyOn(h.cp.bindings, "activePrimaryCto").mockReturnValue({ ...binding, sessionIncarnation: "other-incarnation" });
    const listeners = await startLocalMcpListeners(h.cp, tempDir("acp-incarnation-"), "token");
    const socket = new Socket();
    const end = vi.spyOn(socket, "end").mockImplementation(() => socket);
    try {
      servers[1]!.emit("connection", socket);
      socket.emit("data", Buffer.from(`${JSON.stringify({ token: "token", sessionId: holder.sessionId,
        sessionSecret: holder.sessionSecret })}\n`));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(end).toHaveBeenCalled();
      expect(JSON.parse(String(end.mock.calls[0]![0]))).toMatchObject({
        ok: false, reasonCode: "BINDING_GENERATION_STALE", message: "session does not hold this socket's current role",
      });
    } finally { socket.destroy(); await listeners.close(); h.cp.db.close(); }
  });

  it.each([
    ["assignmentId", { assignmentId: "other-assignment" }],
    ["bindingGeneration", { bindingGeneration: 999 }],
    ["role", { role: Role.BOOTSTRAP_CTO }],
    ["sessionIncarnation", { sessionIncarnation: "other-incarnation" }],
  ] as const)("refuses the attached holder when only current %s differs", (_field, change) => {
    const h = makeHarness();
    const manifest = fixtureManifest("holder-project");
    expect(h.cp.projects.register({ projectId: manifest.projectId, name: "fixture", manifest,
      authorization: h.cp.manifestAuthorizationForTests(manifest) }).allowed).toBe(true);
    const holder = h.cp.sessions.create({ provider: "scripted", model: "fixture", incarnation: "holder-incarnation" });
    expect(h.cp.sessions.transition(holder.sessionId, SessionLifecycle.READY).allowed).toBe(true);
    expect(h.cp.bindings.bind({ role: Role.PRIMARY_CTO, projectId: manifest.projectId,
      sessionId: holder.sessionId }).allowed).toBe(true);
    const binding = h.cp.bindings.activePrimaryCto(manifest.projectId)!;
    const port = new RoleConversationPort(Role.PRIMARY_CTO, {
      active: (key) => h.cp.bindings.active(key), currentCandidates: () => [binding],
    });
    const server = new McpServer({ name: "fixture", version: "1" });
    const detach = port.attach(server, () => allow(ReasonCode.OK, {
      actor: holder.sessionId, sessionId: holder.sessionId, sessionIncarnation: holder.incarnation,
    }));
    try {
      expect(port.currentHolderConnected(binding.roleKey)).toBe(true);
      vi.spyOn(h.cp.bindings, "active").mockReturnValue({ ...binding, ...change });
      expect(port.connected(binding.roleKey)).toBe(true);
      expect(port.currentHolderConnected(binding.roleKey)).toBe(false);
      expect(port.connected(binding.roleKey)).toBe(true);
    } finally { detach(); h.cp.db.close(); }
  });
});
