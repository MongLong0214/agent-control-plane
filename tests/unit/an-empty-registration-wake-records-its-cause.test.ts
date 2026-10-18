import { chmodSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { digestOf, sha256 } from "../../src/core/digest.ts";
import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { startDaemonMcpListeners, wakeRoleHolder } from "../../src/daemon/agentcpd.ts";
import { Role, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { ROLE_WAKE_FRAME, WAKE_TRANSPORT_QUALIFIED_CLIENTS } from "../../src/mcp/role-conversation.ts";
import { MessageKind } from "../../src/outbox/envelope.ts";
import { SELF_CLAIM_EXECUTOR_KIND, SELF_CLAIM_PROTOCOL } from "../../src/registry/canonical-self-claim.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);
afterEach(() => vi.restoreAllMocks());

/**
 * #1103, then FIX-ROLE-WAKE. CTO sessions received `ACP-ROLE-WAKE` with both `role_dispatch_pending`
 * and `role_owner_message_claim` empty, at daemon starts and after registrations. That wake was the
 * registration wake: every `role_wake_endpoint_register` sent one per registered slot whatever was
 * queued, and a relay re-registers on every reattach, so every daemon start sent one. #1103 recorded
 * each wake frame's cause as a `ROLE_WAKE_SENT` audit row, which is how every empty wake observed
 * live was attributed to `registration`.
 *
 * FIX-ROLE-WAKE: on the daemon-built port a registration wake with no confirmed work is skipped.
 * Only a lookup that answers `false` skips it; a lookup that fails still wakes, so the wake that
 * drains a queue filled while nobody was attached is kept. New registrations and a relay's replay
 * after a restart take the same path. The frame stays a constant that carries nothing.
 *
 * Driven through the CTO port exactly as the daemon builds it (`startDaemonMcpListeners`, with its
 * in-band wake), against a real listening endpoint.
 */
const PROJECT = "wake-cause";
const CONVERSATION = "55555555-5555-4555-8555-555555555555";

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

/** Long enough for a wake the port did send to land and be recorded; nothing here should. */
const quiet = async (): Promise<void> => {
  for (let turn = 0; turn < 50; turn += 1) await new Promise((tick) => setTimeout(tick, 1));
};

/** `canonical` binds the holder as an adopted canonical CTO, whose in-band kinds are delivered in band. */
const start = async (options: { canonical?: boolean } = {}) => {
  const dir = tempDir("acp-wcause-");
  chmodSync(dir, 0o700);
  const h = makeHarness();
  h.cp.db.run(`INSERT INTO projects (project_id, name, created_at) VALUES (?, ?, ?)`, [PROJECT, PROJECT, h.cp.clock.nowIso()]);
  const session = h.cp.sessions.create({ provider: "scripted", model: "cto" });
  expect(h.cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "test").reasonCode).toBe(ReasonCode.OK);
  const claimed = { executorKind: SELF_CLAIM_EXECUTOR_KIND, targetLocator: CONVERSATION, targetLocatorDigest: sha256(CONVERSATION) };
  expect(h.cp.bindings.bind({
    role: Role.PRIMARY_CTO,
    sessionId: session.sessionId,
    projectId: PROJECT,
    ...(options.canonical
      ? {
          authenticatedTarget: {
            claimed,
            protocolVersion: SELF_CLAIM_PROTOCOL,
            attestationDigest: digestOf({ fixture: "wake-cause", sessionId: session.sessionId }),
            verify: () => claimed,
          },
        }
      : {}),
  }).allowed).toBe(true);
  const roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId: PROJECT });
  const listeners = await startDaemonMcpListeners(h.cp, dir, "wake-cause-mcp-token", { finalizeApprovedRun: () => undefined });
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
  const enqueue = (kind: MessageKind, idempotencyKey: string, payload: Record<string, unknown>) =>
    h.cp.outbox.enqueue({
      idempotencyKey,
      roleKey,
      bindingGeneration: holder.bindingGeneration,
      targetSessionId: holder.sessionId,
      runId: null,
      kind,
      payload,
    });
  return {
    h,
    roleKey,
    holder,
    listeners,
    server,
    endpointPath,
    endpoint,
    recorded,
    enqueue,
    close: async () => {
      await new Promise<void>((resolve) => endpoint.server.close(() => resolve()));
      await listeners.close();
      h.cp.close();
    },
  };
};

describe("a registration wake with no confirmed work is skipped (#1103, FIX-ROLE-WAKE)", () => {
  it("a registration with no confirmed work sends no wake and records none, and neither does a re-registration", async () => {
    const f = await start();
    try {
      // Both queues the wake points at are empty for this holder.
      expect(f.h.cp.outbox.pendingInBandFor(f.holder.sessionId, f.holder.sessionIncarnation)).toEqual([]);
      expect(f.h.cp.db.all(`SELECT 1 FROM outbox WHERE status = 'PENDING' AND role_key = ?`, [f.roleKey])).toEqual([]);

      expect((await f.listeners.ctoConversation.registerEndpoint(f.server, f.endpointPath)).allowed).toBe(true);
      // A re-registration (what a relay does after a daemon restart) is refused nothing and sends nothing.
      expect((await f.listeners.ctoConversation.registerEndpoint(f.server, f.endpointPath)).allowed).toBe(true);
      expect(f.listeners.ctoConversation.endpointFor(f.roleKey)).not.toBeNull();
      await quiet();
      expect(f.endpoint.frames).toEqual([]);
      expect(f.recorded()).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it("a registration with an owner message queued for its holder still sends one wake, recorded `registration`", async () => {
    const f = await start();
    try {
      // Queued while nobody was attached: an owner message wakes through its ingress, not on enqueue.
      expect(f.enqueue(MessageKind.OWNER_MESSAGE, "owner-message:queued", {
        sourceChannel: "buzz", sourceNonce: "queued", sourcePayloadDigest: "x",
      }).allowed).toBe(true);

      expect((await f.listeners.ctoConversation.registerEndpoint(f.server, f.endpointPath)).allowed).toBe(true);
      await settled(f.endpoint.frames, 1);
      expect(f.endpoint.frames).toEqual([ROLE_WAKE_FRAME]);
      await vi.waitFor(() => expect(f.recorded()).toEqual([{ roleKey: f.roleKey, cause: "registration" }]));
    } finally {
      await f.close();
    }
  });

  it("a dispatch queued while nobody was attached is drained by the registration, and a dispatch after it still wakes", async () => {
    const f = await start({ canonical: true });
    try {
      // The dispatch's own wake finds no endpoint, so the row waits for the registration.
      expect(f.enqueue(MessageKind.DRAIN_REQUEST, "drain-before", { projectId: PROJECT }).allowed).toBe(true);
      await quiet();
      expect(f.h.cp.outbox.pendingInBandFor(f.holder.sessionId, f.holder.sessionIncarnation)).toHaveLength(1);
      expect(f.endpoint.frames).toEqual([]);

      expect((await f.listeners.ctoConversation.registerEndpoint(f.server, f.endpointPath)).allowed).toBe(true);
      await settled(f.endpoint.frames, 1);
      expect(f.endpoint.frames).toEqual([ROLE_WAKE_FRAME]);
      await vi.waitFor(() => expect(f.recorded()).toEqual([{ roleKey: f.roleKey, cause: "registration" }]));

      // The control: a real dispatch to a registered holder wakes it through its own path.
      expect(f.enqueue(MessageKind.DRAIN_REQUEST, "drain-after", { projectId: PROJECT }).allowed).toBe(true);
      await settled(f.endpoint.frames, 2);
      expect(f.endpoint.frames).toEqual([ROLE_WAKE_FRAME, ROLE_WAKE_FRAME]);
      await vi.waitFor(() => expect(f.recorded()).toEqual([
        { roleKey: f.roleKey, cause: "registration" },
        { roleKey: f.roleKey, cause: "in-band dispatch" },
      ]));
    } finally {
      await f.close();
    }
  });

  it("a registration whose work lookup fails still wakes, recorded `registration`", async () => {
    const f = await start();
    try {
      // Nothing is queued, but the lookup cannot answer: unconfirmed is not `false`.
      const lookup = vi.spyOn(f.h.cp.outbox, "hasWorkForHolder").mockImplementation(() => {
        throw new Error("lookup failed");
      });
      expect((await f.listeners.ctoConversation.registerEndpoint(f.server, f.endpointPath)).allowed).toBe(true);
      expect(lookup).toHaveBeenCalledTimes(1);
      await settled(f.endpoint.frames, 1);
      expect(f.endpoint.frames).toEqual([ROLE_WAKE_FRAME]);
      await vi.waitFor(() => expect(f.recorded()).toEqual([{ roleKey: f.roleKey, cause: "registration" }]));
    } finally {
      await f.close();
    }
  });

  it("a wake for queued work carries its trigger, so it is told apart from a registration's", async () => {
    const f = await start();
    try {
      expect((await f.listeners.ctoConversation.registerEndpoint(f.server, f.endpointPath)).allowed).toBe(true);
      const woke = await wakeRoleHolder(f.h.cp, f.listeners.ctoConversation, f.roleKey, { kind: "in-band dispatch", ids: [] });
      expect(woke.allowed).toBe(true);
      await settled(f.endpoint.frames, 1);
      expect(f.endpoint.frames).toEqual([ROLE_WAKE_FRAME]);
      await vi.waitFor(() => expect(f.recorded()).toEqual([{ roleKey: f.roleKey, cause: "in-band dispatch" }]));
    } finally {
      await f.close();
    }
  });
});
