import { chmodSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { startDaemonMcpListeners } from "../../src/daemon/agentcpd.ts";
import { Role, SessionLifecycle } from "../../src/domain/types.ts";
import { RoleConversationPort, type FailedRoleWake } from "../../src/mcp/role-conversation.ts";
import { MessageKind } from "../../src/outbox/envelope.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { makeHarness } from "../helpers/harness.ts";

/**
 * #1427 — a wake that fails says how it failed, and a wake whose forward target is gone is a state
 * of its own. The relay's wake proxy is the endpoint the daemon dials; when the session's own
 * socket no longer resolves, the proxy answers `{"accepted":false,"shape":...}` and the daemon,
 * which can see nothing past the proxy, used to file that as an endpoint that refused the wake.
 *
 * The proxy here is a stand-in that answers the way the relay's does; the relay's own answer is
 * held in tests/process/relay-wake-proxy.test.ts.
 */
afterEach(() => {
  vi.restoreAllMocks();
  cleanupTempDirs();
});

const open: Server[] = [];
afterEach(async () => {
  for (const server of open.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** A relay-v1 endpoint that answers every wake with `reply`. */
const proxyAnswering = async (path: string, reply: string): Promise<void> => {
  const server = createServer({ allowHalfOpen: true }, (socket: Socket) => {
    socket.on("error", () => undefined);
    socket.resume();
    socket.once("end", () => socket.end(reply));
  });
  open.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => resolve());
  });
};

const attachedPort = (onWakeFailed?: (wake: FailedRoleWake) => void) => {
  const dir = tempDir("acp-wake-gone-");
  chmodSync(dir, 0o700);
  const binding = {
    assignmentId: "assignment-gone", roleKey: "PRIMARY_CTO:gone", role: Role.PRIMARY_CTO, projectId: "gone",
    runId: null, taskId: null, sessionId: "session-gone", sessionIncarnation: "incarnation-gone",
    boundSessionId: "session-gone", boundSessionIncarnation: "incarnation-gone", bindingGeneration: 1,
    mode: "PREFERRED" as const, status: "ACTIVE" as const, createdAt: "2026-11-16T00:00:00.000Z",
  };
  const port = new RoleConversationPort(
    Role.PRIMARY_CTO,
    { active: (key) => (key === binding.roleKey ? binding : null), currentCandidates: () => [binding] },
    { endpointDir: dir, ...(onWakeFailed === undefined ? {} : { onWakeFailed }) },
  );
  const server = new McpServer({ name: "gone", version: "1" });
  vi.spyOn(server.server, "getClientVersion").mockReturnValue({ name: "claude-code", version: "2.1.323" });
  port.attach(server, () => allow(ReasonCode.OK, {
    actor: binding.sessionId, sessionId: binding.sessionId, sessionIncarnation: binding.sessionIncarnation,
  }));
  return { port, server, dir, binding };
};

describe("a wake whose forward target no longer resolves", () => {
  for (const shape of ["not-found", "connection-refused"]) {
    it(`reports the holder as unwakeable with its own cause when the relay answers ${shape}`, async () => {
      const failures: FailedRoleWake[] = [];
      const f = attachedPort((wake) => failures.push(wake));
      const path = join(f.dir, "relay.wake.sock");
      await proxyAnswering(path, `${JSON.stringify({ accepted: false, shape })}\n`);
      expect((await f.port.registerEndpoint(f.server, path, "relay-v1")).allowed).toBe(true);

      const wake = await f.port.wake(f.binding.roleKey);
      expect(wake).toMatchObject({ allowed: false, reasonCode: ReasonCode.ROLE_PEER_FAILED, evidence: { shape: `target-${shape}` } });
      expect(f.port.unwakeableHolders()).toMatchObject([
        { roleKey: f.binding.roleKey, cause: "registered-endpoint-target-gone" },
      ]);
      // The registration's own first knock failed the same way, and each failure carries its shape.
      expect(failures.map((failure) => failure.shape)).toEqual([`target-${shape}`, `target-${shape}`]);
    });
  }

  it("keeps the generic cause for any other failure the relay reports, and for a relay that names none", async () => {
    for (const reply of [
      `${JSON.stringify({ accepted: false, shape: "timeout" })}\n`,
      `${JSON.stringify({ accepted: false })}\n`,
    ]) {
      const f = attachedPort();
      const path = join(f.dir, "relay.wake.sock");
      await proxyAnswering(path, reply);
      expect((await f.port.registerEndpoint(f.server, path, "relay-v1")).allowed).toBe(true);
      expect(await f.port.wake(f.binding.roleKey)).toMatchObject({ allowed: false, reasonCode: ReasonCode.ROLE_PEER_FAILED });
      expect(f.port.unwakeableHolders()).toMatchObject([{ cause: "registered-endpoint-refused-the-wake" }]);
    }
  });
});

describe("ROLE_WAKE_FAILED evidence carries the failure shape", () => {
  it("records the shape of a connection that failed, and none for a wake refused before it connected", async () => {
    const h = makeHarness();
    const dir = tempDir("acp-wake-shape-");
    chmodSync(dir, 0o700);
    h.cp.db.run("INSERT INTO projects (project_id, name, created_at) VALUES (?, ?, ?)", ["shape", "shape", h.cp.clock.nowIso()]);
    const session = h.cp.sessions.create({ provider: "scripted", model: "cto" });
    expect(h.cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "test").allowed).toBe(true);
    expect(h.cp.bindings.bind({ role: Role.PRIMARY_CTO, sessionId: session.sessionId, projectId: "shape" }).allowed).toBe(true);
    const binding = h.cp.bindings.activePrimaryCto("shape")!;
    const listeners = await startDaemonMcpListeners(h.cp, dir, "wake-shape-token", { finalizeApprovedRun: () => undefined });
    try {
      const server = new McpServer({ name: "shape", version: "1" });
      vi.spyOn(server.server, "getClientVersion").mockReturnValue({ name: "claude-code", version: "2.1.323" });
      listeners.ctoConversation.attach(server, () => allow(ReasonCode.OK, {
        actor: binding.sessionId, sessionId: binding.sessionId, sessionIncarnation: binding.sessionIncarnation,
      }));
      const audited = () =>
        h.cp.db.all<{ reason_code: string; evidence_json: string }>(
          "SELECT reason_code, evidence_json FROM audit_events WHERE kind = 'ROLE_WAKE_FAILED' ORDER BY rowid",
        ).map((row) => ({ reasonCode: row.reason_code, ...(JSON.parse(row.evidence_json) as Record<string, unknown>) }));

      // No endpoint yet: refused before any connection, so there is no connection shape to record.
      await listeners.ctoConversation.wake(binding.roleKey, undefined, "mention");
      expect(audited()).toEqual([{ reasonCode: ReasonCode.ROLE_PEER_UNSUPPORTED, cause: "mention" }]);

      const path = join(dir, "relay.wake.sock");
      await proxyAnswering(path, `${JSON.stringify({ accepted: false, shape: "not-found" })}\n`);
      expect((await listeners.ctoConversation.registerEndpoint(server, path, "relay-v1")).allowed).toBe(true);
      // A wake that names its cause is for pending work, so there is some.
      expect(h.cp.outbox.enqueue({
        idempotencyKey: "drain-for-shape", roleKey: binding.roleKey, bindingGeneration: binding.bindingGeneration,
        targetSessionId: binding.sessionId, runId: null, kind: MessageKind.OWNER_MESSAGE,
        payload: { sourceChannel: "buzz", sourceNonce: "for-shape", sourcePayloadDigest: "x" },
      }).allowed).toBe(true);
      await listeners.ctoConversation.wake(binding.roleKey, undefined, "owner message");
      expect(audited().at(-1)).toEqual({
        reasonCode: ReasonCode.ROLE_PEER_FAILED, cause: "owner message", shape: "target-not-found",
      });
    } finally {
      await listeners.close();
      h.cp.close();
    }
  });
});
