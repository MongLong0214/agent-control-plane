import { chmodSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { digestOf } from "../../src/core/digest.ts";
import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ownerMessageLedger } from "../../src/daemon/agentcpd.ts";
import { Role, SessionLifecycle, type RoleBinding } from "../../src/domain/types.ts";
import { ROLE_WAKE_FRAME, RoleConversationPort, WAKE_TRANSPORT_QUALIFIED_CLIENTS } from "../../src/mcp/role-conversation.ts";
import { MessageKind } from "../../src/outbox/envelope.ts";
import type { HolderIdentity } from "../../src/outbox/outbox.ts";
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
  const dir = tempDir("acp-role-fallback-");
  chmodSync(dir, 0o700);
  const written = vi.fn();
  const hasWork = vi.fn((holder: HolderIdentity) => h.cp.outbox.hasWorkForHolder(holder));
  const port = new RoleConversationPort(Role.PRIMARY_CTO, {
    active: () => current,
    currentCandidates: () => [current],
  }, { endpointDir: dir, ownerMessages: ownerMessageLedger(h.cp), holderHasWork: hasWork, onWakeWritten: written });
  const attach = () => {
    const holder = current;
    const server = new McpServer({ name: "fallback", version: "1" });
    vi.spyOn(server.server, "getClientVersion").mockReturnValue(WAKE_TRANSPORT_QUALIFIED_CLIENTS[0]);
    const close = port.attach(server, () => allow(ReasonCode.OK, {
      actor: holder.sessionId, sessionId: holder.sessionId, sessionIncarnation: holder.sessionIncarnation,
    }));
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
  return { port, binding, attach, endpoint, enqueue, written, hasWork,
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

  it.each(["bindingGeneration", "sessionId", "sessionIncarnation"] as const)(
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
