import { chmodSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { startLocalMcpListeners, wakeRoleHolder } from "../../src/daemon/agentcpd.ts";
import { Role, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { ROLE_WAKE_FRAME, WAKE_TRANSPORT_QUALIFIED_CLIENTS } from "../../src/mcp/role-conversation.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);
afterEach(() => vi.restoreAllMocks());

/**
 * #1103. CTO sessions receive `ACP-ROLE-WAKE` with both `role_dispatch_pending` and
 * `role_owner_message_claim` empty, at daemon starts and after registrations. That wake is the
 * registration wake: every `role_wake_endpoint_register` sends one per registered slot whatever is
 * queued (a relay re-registers on every reattach, so every daemon start sends one). It stays, since
 * it is what reaches a message queued while nobody was attached, and the frame stays a constant that
 * carries nothing. What changes is that the daemon records why each wake frame was sent, as a
 * `ROLE_WAKE_SENT` audit row, so an empty wake is attributable.
 *
 * Driven through the CTO port exactly as the daemon builds it (`startLocalMcpListeners`), against a
 * real listening endpoint.
 */
const PROJECT = "wake-cause";

const listening = async (path: string): Promise<{ server: Server; frames: string[] }> => {
  const frames: string[] = [];
  const server = createServer((socket) => {
    let data = "";
    socket.on("data", (chunk) => {
      data += chunk.toString("utf8");
    });
    socket.on("end", () => frames.push(data));
  });
  await new Promise<void>((bound, failed) => {
    server.once("error", failed);
    server.listen(path, () => bound());
  });
  return { server, frames };
};

const settled = async (frames: string[], count: number): Promise<void> => {
  for (let attempt = 0; attempt < 2_000 && frames.length < count; attempt += 1) {
    await new Promise((tick) => setTimeout(tick, 1));
  }
};

const start = async () => {
  const dir = tempDir("acp-wcause-");
  chmodSync(dir, 0o700);
  const h = makeHarness();
  h.cp.db.run(`INSERT INTO projects (project_id, name, created_at) VALUES (?, ?, ?)`, [PROJECT, PROJECT, h.cp.clock.nowIso()]);
  const session = h.cp.sessions.create({ provider: "scripted", model: "cto" });
  expect(h.cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "test").reasonCode).toBe(ReasonCode.OK);
  expect(h.cp.bindings.bind({ role: Role.PRIMARY_CTO, sessionId: session.sessionId, projectId: PROJECT }).allowed).toBe(true);
  const roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId: PROJECT });
  const listeners = await startLocalMcpListeners(h.cp, dir, "wake-cause-mcp-token");
  const holder = h.cp.bindings.active(roleKey)!;
  const server = new McpServer({ name: "wake-cause", version: "1" });
  vi.spyOn(server.server, "getClientVersion").mockReturnValue(WAKE_TRANSPORT_QUALIFIED_CLIENTS[0]);
  listeners.ctoConversation.attach(server, () => allow(ReasonCode.OK, {
    actor: holder.sessionId, sessionId: holder.sessionId, sessionIncarnation: holder.sessionIncarnation,
  }));
  const endpointPath = join(dir, "wake.sock");
  const endpoint = await listening(endpointPath);
  const recorded = () =>
    h.cp.db.all<{ role_key: string; evidence_json: string }>(
      `SELECT role_key, evidence_json FROM audit_events WHERE kind = 'ROLE_WAKE_SENT' ORDER BY rowid`,
    ).map((row) => ({ roleKey: row.role_key, ...(JSON.parse(row.evidence_json) as { cause: string }) }));
  return {
    h,
    roleKey,
    holder,
    listeners,
    server,
    endpointPath,
    endpoint,
    recorded,
    close: async () => {
      await new Promise<void>((resolve) => endpoint.server.close(() => resolve()));
      await listeners.close();
      h.cp.close();
    },
  };
};

describe("an empty wake is attributable to its cause (#1103)", () => {
  it("a registration with empty queues sends one wake, recorded with the cause `registration`", async () => {
    const f = await start();
    try {
      // Both queues the wake points at are empty for this holder.
      expect(f.h.cp.outbox.pendingInBandFor(f.holder.sessionId, f.holder.sessionIncarnation)).toEqual([]);
      expect(f.h.cp.db.all(`SELECT 1 FROM outbox WHERE status = 'PENDING' AND role_key = ?`, [f.roleKey])).toEqual([]);

      expect((await f.listeners.ctoConversation.registerEndpoint(f.server, f.endpointPath)).allowed).toBe(true);
      await settled(f.endpoint.frames, 1);
      expect(f.endpoint.frames).toEqual([ROLE_WAKE_FRAME]);
      await vi.waitFor(() => expect(f.recorded()).toEqual([{ roleKey: f.roleKey, cause: "registration" }]));

      // A re-registration (what a relay does after a daemon restart) is one more, recorded the same.
      expect((await f.listeners.ctoConversation.registerEndpoint(f.server, f.endpointPath)).allowed).toBe(true);
      await settled(f.endpoint.frames, 2);
      expect(f.endpoint.frames).toEqual([ROLE_WAKE_FRAME, ROLE_WAKE_FRAME]);
      await vi.waitFor(() => expect(f.recorded()).toEqual([
        { roleKey: f.roleKey, cause: "registration" },
        { roleKey: f.roleKey, cause: "registration" },
      ]));
    } finally {
      await f.close();
    }
  });

  it("a wake for queued work carries its trigger, so it is told apart from a registration's", async () => {
    const f = await start();
    try {
      expect((await f.listeners.ctoConversation.registerEndpoint(f.server, f.endpointPath)).allowed).toBe(true);
      await settled(f.endpoint.frames, 1);
      const woke = await wakeRoleHolder(f.h.cp, f.listeners.ctoConversation, f.roleKey, { kind: "in-band dispatch", ids: [] });
      expect(woke.allowed).toBe(true);
      await settled(f.endpoint.frames, 2);
      await vi.waitFor(() => expect(f.recorded()).toEqual([
        { roleKey: f.roleKey, cause: "registration" },
        { roleKey: f.roleKey, cause: "in-band dispatch" },
      ]));
    } finally {
      await f.close();
    }
  });
});
