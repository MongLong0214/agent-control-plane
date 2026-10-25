import { chmodSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { digestOf } from "../../src/core/digest.ts";
import { allow, deny } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ownerMessageLedger } from "../../src/daemon/agentcpd.ts";
import { Role, SessionLifecycle, type RoleBinding } from "../../src/domain/types.ts";
import { ROLE_WAKE_FRAME, RoleConversationPort, WAKE_TRANSPORT_QUALIFIED_CLIENTS } from "../../src/mcp/role-conversation.ts";
import type { McpPeerAuthenticator } from "../../src/mcp/shared.ts";
import { MessageKind } from "../../src/outbox/envelope.ts";
import type { HolderIdentity } from "../../src/outbox/outbox.ts";
import { RoleAttachmentCredentials } from "../../src/session/role-attachment-credentials.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
  vi.restoreAllMocks();
  cleanupTempDirs();
});

const fixture = () => {
  const h = makeHarness();
  cleanup.push(async () => h.cp.close());
  h.cp.db.run("INSERT INTO projects (project_id, name, created_at) VALUES (?, ?, ?)",
    ["fallback", "fallback", h.cp.clock.nowIso()]);
  const session = h.cp.sessions.create({ provider: "scripted", model: "cto" });
  expect(h.cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "test").allowed).toBe(true);
  const bound = h.cp.bindings.bind({ role: Role.PRIMARY_CTO, sessionId: session.sessionId, projectId: "fallback" });
  if (!bound.allowed) throw new Error(bound.message);
  const binding = h.cp.bindings.activePrimaryCto("fallback")!;
  let current = binding;
  const others = new Map<string, RoleBinding>();
  const addBinding = (projectId: string, sessionId = binding.sessionId) => {
    h.cp.db.run("INSERT INTO projects (project_id, name, created_at) VALUES (?, ?, ?)",
      [projectId, projectId, h.cp.clock.nowIso()]);
    const bound = h.cp.bindings.bind({ role: Role.PRIMARY_CTO, sessionId, projectId });
    if (!bound.allowed) throw new Error(bound.message);
    const added = h.cp.bindings.activePrimaryCto(projectId)!;
    others.set(added.roleKey, added);
    return added;
  };
  const dir = tempDir("acp-role-fallback-");
  chmodSync(dir, 0o700);
  const written = vi.fn();
  const hasWork = vi.fn((holder: HolderIdentity) => h.cp.outbox.hasWorkForHolder(holder));
  const port = new RoleConversationPort(Role.PRIMARY_CTO, {
    active: (key) => key === binding.roleKey ? current : others.get(key) ?? null,
    currentCandidates: () => [current, ...others.values()],
  }, { endpointDir: dir, ownerMessages: ownerMessageLedger(h.cp), holderHasWork: hasWork, onWakeWritten: written });
  const makeServer = () => {
    const server = new McpServer({ name: "fallback", version: "1" });
    vi.spyOn(server.server, "getClientVersion").mockReturnValue(WAKE_TRANSPORT_QUALIFIED_CLIENTS[0]);
    return server;
  };
  const attach = (holder = current, authenticate?: McpPeerAuthenticator) => {
    const server = makeServer();
    const close = port.attach(server, authenticate ?? (() => allow(ReasonCode.OK, {
      actor: holder.sessionId, sessionId: holder.sessionId, sessionIncarnation: holder.sessionIncarnation,
    })));
    return { server, close };
  };
  const endpoint = async (name: string, acceptance = false) => {
    const path = join(dir, `${name}.sock`);
    const frames: string[] = [];
    const acknowledgements: (() => void)[] = [];
    const sockets = new Set<Socket>();
    const listener: Server = createServer({ allowHalfOpen: true }, (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => {});
      let frame = "";
      socket.on("data", (chunk) => { frame += chunk.toString(); });
      socket.on("end", () => {
        frames.push(frame);
        if (acceptance) acknowledgements.push(() => socket.end('{"accepted":true}\n'));
        else socket.end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(path, resolve);
    });
    cleanup.push(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    });
    return { path, frames, acknowledgements };
  };
  const enqueue = () => {
    const payload = { text: "message queued during the helper connection" };
    const nonce = "fallback-message";
    h.cp.db.run(
      "INSERT INTO inbound_messages (channel, nonce, actor, received_at, payload_json) VALUES ('buzz', ?, 'owner', ?, ?)",
      [nonce, h.cp.clock.nowIso(), JSON.stringify(payload)],
    );
    const queued = h.cp.outbox.enqueue({
      idempotencyKey: nonce, roleKey: binding.roleKey, bindingGeneration: binding.bindingGeneration,
      targetSessionId: binding.sessionId, runId: null, kind: MessageKind.OWNER_MESSAGE,
      payload: { sourceChannel: "buzz", sourceNonce: nonce, sourcePayloadDigest: digestOf(payload) },
    });
    if (!queued.allowed) throw new Error(queued.message);
    return queued.value.messageId;
  };
  return { h, session, port, binding, attach, makeServer, addBinding, endpoint, enqueue, written, hasWork,
    replace: (replacement: RoleBinding) => { current = replacement; } };
};

describe("a role keeps its open connections for the current binding", () => {
  it("restores C1's endpoint, wakes work queued under C2, and lets C1 claim it", async () => {
    const f = fixture();
    const c1 = f.attach();
    const endpoint = await f.endpoint("c1");
    expect((await f.port.registerEndpoint(c1.server, endpoint.path)).allowed).toBe(true);
    expect(endpoint.frames).toEqual([]);
    const c2 = f.attach();
    expect(f.port.claimOwnerMessage(c1.server, f.binding.roleKey).reasonCode).toBe(ReasonCode.ROLE_PEER_STALE);
    expect(f.port.endpointFor(f.binding.roleKey)).toBeNull();
    const messageId = f.enqueue();
    c2.close();

    expect(f.port.connected(f.binding.roleKey)).toBe(true);
    expect(f.port.currentHolderConnected(f.binding.roleKey)).toBe(true);
    expect(f.port.endpointFor(f.binding.roleKey)).toBe(endpoint.path);
    await vi.waitFor(() => expect(endpoint.frames).toEqual([ROLE_WAKE_FRAME]));
    expect(f.hasWork).toHaveBeenLastCalledWith({
      roleKey: f.binding.roleKey, bindingGeneration: f.binding.bindingGeneration,
      targetSessionId: f.binding.sessionId, sessionIncarnation: f.binding.sessionIncarnation,
    });
    expect(f.port.claimOwnerMessage(c1.server, f.binding.roleKey)).toMatchObject({
      allowed: true, value: { claimed: { messageId, text: "message queued during the helper connection" } },
    });
    c1.close();
    expect(f.port.currentHolderConnected(f.binding.roleKey)).toBe(false);
    expect(f.port.claimOwnerMessage(c1.server, f.binding.roleKey).reasonCode).toBe(ReasonCode.ROLE_PEER_ABSENT);
  });

  it("restores C1's relay acceptance state, independently of C2's registration", async () => {
    const f = fixture();
    const c1 = f.attach();
    const first = await f.endpoint("c1", true);
    expect((await f.port.registerEndpoint(c1.server, first.path, "relay-v1")).allowed).toBe(true);
    const c2 = f.attach();
    const second = await f.endpoint("c2");
    expect((await f.port.registerEndpoint(c2.server, second.path)).allowed).toBe(true);
    f.enqueue();
    c2.close();

    await vi.waitFor(() => expect(first.frames).toEqual([ROLE_WAKE_FRAME]));
    expect(second.frames).toEqual([]);
    expect(f.written).not.toHaveBeenCalled();
    first.acknowledgements[0]!();
    await vi.waitFor(() => expect(f.written).toHaveBeenCalledTimes(1));
  });

  it("reserves a shadowed connection's endpoint against another role until fallback", async () => {
    const f = fixture();
    const a1 = f.attach();
    const endpoint = await f.endpoint("a1");
    expect((await f.port.registerEndpoint(a1.server, endpoint.path)).allowed).toBe(true);
    const a2 = f.attach();
    const other = f.h.cp.sessions.create({ provider: "scripted", model: "other-cto" });
    expect(f.h.cp.sessions.transition(other.sessionId, SessionLifecycle.READY, "test").allowed).toBe(true);
    const bindingB = f.addBinding("other", other.sessionId);
    const b = f.attach(bindingB);

    const registration = await f.port.registerEndpoint(b.server, endpoint.path);
    a2.close();
    expect(f.port.endpointFor(f.binding.roleKey)).toBe(endpoint.path);
    expect(f.port.currentHolderConnected(bindingB.roleKey)).toBe(true);
    expect(registration).toMatchObject({
      allowed: false, reasonCode: ReasonCode.ROLE_PEER_UNSUPPORTED,
      evidence: { heldBy: f.binding.roleKey },
    });
    expect(f.port.endpointFor(bindingB.roleKey)).toBeNull();
    expect((await f.port.wake(bindingB.roleKey)).reasonCode).toBe(ReasonCode.ROLE_PEER_UNSUPPORTED);
    expect(endpoint.frames).toEqual([]);
    expect((await f.port.wake(f.binding.roleKey)).allowed).toBe(true);
    await vi.waitFor(() => expect(endpoint.frames).toEqual([ROLE_WAKE_FRAME]));
  });

  it("keeps one connection's endpoint registration valid for several roles", async () => {
    const f = fixture();
    const second = f.addBinding("second");
    const c1 = f.attach();
    const endpoint = await f.endpoint("multi-role");
    expect(await f.port.registerEndpoint(c1.server, endpoint.path)).toMatchObject({
      allowed: true, value: [f.binding.roleKey, second.roleKey],
    });
    const c2 = f.attach();
    c2.close();
    expect(f.port.endpointFor(f.binding.roleKey)).toBe(endpoint.path);
    expect(f.port.endpointFor(second.roleKey)).toBe(endpoint.path);
    expect((await f.port.registerEndpoint(c1.server, endpoint.path)).allowed).toBe(true);
  });

  it("does not reserve an endpoint for an ineligible retained connection", async () => {
    const f = fixture();
    let authorized = true;
    const c1 = f.attach(f.binding, () => authorized
      ? allow(ReasonCode.OK, { actor: f.binding.sessionId, sessionId: f.binding.sessionId,
        sessionIncarnation: f.binding.sessionIncarnation })
      : deny(ReasonCode.MCP_PEER_UNAUTHENTICATED, "credential revoked"));
    const endpoint = await f.endpoint("stale");
    expect((await f.port.registerEndpoint(c1.server, endpoint.path)).allowed).toBe(true);
    const c2 = f.attach();
    authorized = false;
    const other = f.h.cp.sessions.create({ provider: "scripted", model: "other-cto" });
    expect(f.h.cp.sessions.transition(other.sessionId, SessionLifecycle.READY, "test").allowed).toBe(true);
    const bindingB = f.addBinding("other", other.sessionId);
    const b = f.attach(bindingB);
    expect((await f.port.registerEndpoint(b.server, endpoint.path)).allowed).toBe(true);
    c2.close();
    expect(f.port.connected(f.binding.roleKey)).toBe(false);
    expect(f.port.endpointFor(bindingB.roleKey)).toBe(endpoint.path);
  });

  it.each(["session secret", "attachment"] as const)(
    "keeps an authenticated attachment across secret rotation and a fresh %s connection", async (credential) => {
      const f = fixture();
      const attachments = new RoleAttachmentCredentials(f.h.cp.sessions, f.h.cp.bindings, f.h.clock);
      const issued = attachments.issue({
        sessionId: f.session.sessionId, sessionSecret: f.session.sessionSecret!, roleKey: f.binding.roleKey,
      });
      if (!issued.allowed) throw new Error(issued.message);
      const c1 = f.makeServer();
      const connected = attachments.connect(c1, f.port, issued.value);
      if (!connected.allowed) throw new Error(connected.message);
      cleanup.push(async () => connected.value());
      const endpoint = await f.endpoint("attachment");
      expect((await f.port.registerEndpoint(c1, endpoint.path)).allowed).toBe(true);
      const authenticateSecret = (secret: string): McpPeerAuthenticator => () => {
        const authenticated = f.h.cp.sessions.verifySecret(f.session.sessionId, secret);
        if (!authenticated.allowed) return authenticated;
        return allow(ReasonCode.OK, { actor: authenticated.value.sessionId,
          sessionId: authenticated.value.sessionId, sessionIncarnation: authenticated.value.incarnation });
      };
      const c2 = f.attach(f.binding, authenticateSecret(f.session.sessionSecret!));
      const rotated = f.h.cp.sessions.rotateSecret(f.session.sessionId, f.session.credentialEpoch);
      if (!rotated.allowed) throw new Error(rotated.message);
      expect(f.h.cp.bindings.active(f.binding.roleKey)).toEqual(f.binding);
      expect(attachments.authorize(issued.value).allowed).toBe(true);
      expect(authenticateSecret(f.session.sessionSecret!)().allowed).toBe(false);
      let c3: { server: McpServer; close: () => void };
      if (credential === "session secret") {
        c3 = f.attach(f.binding, authenticateSecret(rotated.value.sessionSecret));
      } else {
        const fresh = attachments.issue({ sessionId: f.session.sessionId,
          sessionSecret: rotated.value.sessionSecret, roleKey: f.binding.roleKey });
        if (!fresh.allowed) throw new Error(fresh.message);
        const server = f.makeServer();
        const admitted = attachments.connect(server, f.port, fresh.value);
        if (!admitted.allowed) throw new Error(admitted.message);
        c3 = { server, close: admitted.value };
      }
      expect(f.port.claimOwnerMessage(c3.server, f.binding.roleKey).allowed).toBe(true);
      const messageId = f.enqueue();
      c3.close();
      c2.close();

      expect(f.port.connected(f.binding.roleKey)).toBe(true);
      expect(f.port.currentHolderConnected(f.binding.roleKey)).toBe(true);
      expect(f.port.endpointFor(f.binding.roleKey)).toBe(endpoint.path);
      await vi.waitFor(() => expect(endpoint.frames).toEqual([ROLE_WAKE_FRAME]));
      expect(f.port.claimOwnerMessage(c1, f.binding.roleKey)).toMatchObject({
        allowed: true, value: { claimed: { messageId } },
      });
    },
  );

  it("keeps C2 current when C1 closes and never restores the closed C1", () => {
    const f = fixture();
    const c1 = f.attach();
    const c2 = f.attach();
    c1.close();
    expect(f.port.currentHolderConnected(f.binding.roleKey)).toBe(true);
    expect(f.port.claimOwnerMessage(c2.server, f.binding.roleKey).allowed).toBe(true);
    c2.close();
    expect(f.port.connected(f.binding.roleKey)).toBe(false);
  });

  it("falls back in attachment order and tolerates a repeated late close", () => {
    const f = fixture();
    const c1 = f.attach();
    const c2 = f.attach();
    const c3 = f.attach();
    c3.close();
    c3.close();
    expect(f.port.claimOwnerMessage(c2.server, f.binding.roleKey).allowed).toBe(true);
    c2.close();
    expect(f.port.claimOwnerMessage(c1.server, f.binding.roleKey).allowed).toBe(true);
  });

  it("skips an ineligible predecessor when the current connection closes", () => {
    const f = fixture();
    const c1 = f.attach();
    let authorized = true;
    const c2 = f.attach(f.binding, () => authorized
      ? allow(ReasonCode.OK, { actor: f.binding.sessionId, sessionId: f.binding.sessionId,
        sessionIncarnation: f.binding.sessionIncarnation })
      : deny(ReasonCode.MCP_PEER_UNAUTHENTICATED, "credential revoked"));
    const c3 = f.attach();
    authorized = false;
    c3.close();
    c2.close();
    expect(f.port.claimOwnerMessage(c1.server, f.binding.roleKey).allowed).toBe(true);
  });

  it("does not restore an attachment or throw on a late close after the database closes", () => {
    const f = fixture();
    const attachments = new RoleAttachmentCredentials(f.h.cp.sessions, f.h.cp.bindings, f.h.clock);
    const issued = attachments.issue({ sessionId: f.session.sessionId,
      sessionSecret: f.session.sessionSecret!, roleKey: f.binding.roleKey });
    if (!issued.allowed) throw new Error(issued.message);
    const connected = attachments.connect(f.makeServer(), f.port, issued.value);
    if (!connected.allowed) throw new Error(connected.message);
    const c2 = f.attach();
    f.h.cp.db.close();
    expect(() => c2.close()).not.toThrow();
    expect(f.port.connected(f.binding.roleKey)).toBe(false);
    connected.value();
  });

  it.each(["bindingGeneration", "sessionId", "sessionIncarnation", "assignmentId"] as const)(
    "never restores a replaced binding after %s changes", (field) => {
      const f = fixture();
      const c1 = f.attach();
      const c2 = f.attach();
      f.replace({ ...f.binding, [field]: field === "bindingGeneration" ? 2 : "successor" });
      const successor = f.attach();
      // Closing a discarded connection cannot remove the new binding's holder.
      c2.close();
      expect(f.port.currentHolderConnected(f.binding.roleKey)).toBe(true);
      successor.close();
      expect(f.port.connected(f.binding.roleKey)).toBe(false);
      c1.close();
      expect(f.port.connected(f.binding.roleKey)).toBe(false);
    },
  );
});
