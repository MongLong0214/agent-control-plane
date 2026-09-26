import { createServer } from "node:http";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createConfiguredHermesGatewayConversation } from "../../src/daemon/agentcpd.ts";
import { createHermesGatewayConversationSender } from "../../src/runtime/hermes-gateway-conversation.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { allow } from "../../src/core/errors.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { bindCeo, makeHarness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);
const digest = `sha256:${"a".repeat(64)}`;
const config = () => ({
  ACP_HERMES_EXPECTED_LIVE_SESSION_ID: "live-head",
  ACP_HERMES_TARGET_SESSION_ID: "original-root",
  ACP_HERMES_LINEAGE_ROOT_DIGEST: digest,
  ACP_HERMES_EXECUTABLE: "/opt/test/hermes",
  ACP_HERMES_PROFILE: "test-profile",
  ACP_HERMES_HOME: "/opt/test/home",
  ACP_HERMES_EXECUTOR_RUNTIME_IDENTITY: "hermes-runtime:test",
  ACP_HERMES_GATEWAY_API_KEY: "fixture-gateway-key",
});
const source = { eventId: "signed-7", actor: "owner", conversation: "room" };

describe("daemon Gateway CEO composition", () => {
  it("refuses without POST when the CEO binding is revoked during identity GET", async () => {
    const harness = makeHarness();
    const { cp } = harness;
    let identityRequested!: () => void;
    const requested = new Promise<void>((resolve) => { identityRequested = resolve; });
    let releaseIdentity!: () => void;
    const released = new Promise<void>((resolve) => { releaseIdentity = resolve; });
    let posts = 0;
    const server = createServer((req, res) => {
      if (req.method === "GET") {
        identityRequested();
        void released.then(() => {
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ session_id: "live-head", lineage_root_digest: digest,
            process_pid: 123, process_started_at: "native-start" }));
        });
      } else {
        posts++;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ event_id: source.eventId, text: "must not arrive" }));
      }
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("expected TCP listener");
      const sessionId = bindCeo(harness);
      const originalGet = cp.sessions.get.bind(cp.sessions);
      vi.spyOn(cp.sessions, "get").mockImplementation((id) => {
        const session = originalGet(id);
        return id === sessionId && session ? { ...session, provider: "hermes", osPid: 123,
          osProcessStartedAt: "ps-start" } : session;
      });
      const originalDbGet = cp.db.get.bind(cp.db);
      vi.spyOn(cp.db, "get").mockImplementation((sql, params) =>
        String(sql).includes("FROM actor_target_bindings")
          ? { executor_kind: "hermes", target_locator: "live-head", target_locator_digest: digest } as never
          : originalDbGet(sql, params));
      const send = createConfiguredHermesGatewayConversation(cp, config(), {
        authorityHeld: () => true,
        processStartedAt: () => "ps-start",
        processStartToken: () => "native-start",
        senderFactory: (options) => createHermesGatewayConversationSender({ ...options, port: address.port }),
      });
      expect(send).toBeDefined();
      const outcome = send!("status", source);
      await requested;
      expect(cp.bindings.revoke("CEO", "revoked while Gateway identity pending").allowed).toBe(true);
      releaseIdentity();
      expect(await outcome).toMatchObject({ contact: "NEVER_REACHED",
        answered: { allowed: false, reasonCode: ReasonCode.CEO_CONVERSATION_STALE } });
      expect(posts).toBe(0);
    } finally {
      releaseIdentity();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      cp.close();
      vi.restoreAllMocks();
    }
  });

  it("pins the adopted active CEO and server-owned binding when delivering a turn", async () => {
    const harness = makeHarness();
    const { cp } = harness;
    try {
      const id = bindCeo(harness);
      const active = cp.bindings.active("CEO")!;
      const originalGet = cp.sessions.get.bind(cp.sessions);
      vi.spyOn(cp.sessions, "get").mockImplementation((sessionId) => {
        const session = originalGet(sessionId);
        return sessionId === id && session ? { ...session, provider: "hermes", osPid: 123,
          osProcessStartedAt: "ps-start" } : session;
      });
      const originalDbGet = cp.db.get.bind(cp.db);
      vi.spyOn(cp.db, "get").mockImplementation((sql, params) =>
        String(sql).includes("FROM actor_target_bindings")
          ? { executor_kind: "hermes", target_locator: "live-head", target_locator_digest: digest } as never
          : originalDbGet(sql, params));
      const calls: unknown[] = [];
      let lockHeld = true;
      let loseLockDuringProcessCheck = false;
      const sender = createConfiguredHermesGatewayConversation(cp, config(), {
        authorityHeld: () => lockHeld,
        processStartToken: () => {
          if (loseLockDuringProcessCheck) lockHeld = false;
          return "native-start";
        },
        processStartedAt: () => "ps-start",
        senderFactory: (options) => {
          calls.push(options);
          return async (text, event) => {
            calls.push({ text, event });
            return { contact: "REACHED", answered: allow(ReasonCode.OK, "Gateway answered") };
          };
        },
      });
      expect(sender).toBeDefined();
      expect(await sender!("status", source)).toMatchObject({ contact: "REACHED", answered: { value: "Gateway answered" } });
      expect(calls).toEqual([
        { apiKey: "fixture-gateway-key", binding: "acp-canonical-ceo",
          expected: { session_id: "live-head", lineage_root_digest: digest,
            process_pid: 123, process_started_at: "native-start" },
          preDispatch: expect.any(Function) },
        { text: "status", event: source },
      ]);
      expect(active.sessionId).toBe(id);
      lockHeld = false;
      expect(await sender!("after-lock-loss", source)).toMatchObject({ contact: "NEVER_REACHED",
        answered: { reasonCode: ReasonCode.CEO_CONVERSATION_STALE } });
      expect(calls).toHaveLength(2);
      lockHeld = true;
      loseLockDuringProcessCheck = true;
      expect(await sender!("during-lock-loss", source)).toMatchObject({ contact: "NEVER_REACHED",
        answered: { reasonCode: ReasonCode.CEO_CONVERSATION_STALE } });
      expect(calls).toHaveLength(2);
    } finally { cp.close(); vi.restoreAllMocks(); }
  });

  it("refuses wrong target, wrong process and partial config without invoking Gateway or MCP", async () => {
    const harness = makeHarness();
    const { cp } = harness;
    try {
      const id = bindCeo(harness);
      const originalGet = cp.sessions.get.bind(cp.sessions);
      vi.spyOn(cp.sessions, "get").mockImplementation((sessionId) => {
        const session = originalGet(sessionId);
        return sessionId === id && session ? { ...session, provider: "hermes", osPid: 123,
          osProcessStartedAt: "ps-start" } : session;
      });
      const originalDbGet = cp.db.get.bind(cp.db);
      vi.spyOn(cp.db, "get").mockImplementation((sql, params) =>
        String(sql).includes("FROM actor_target_bindings")
          ? { executor_kind: "hermes", target_locator: "original-root", target_locator_digest: digest } as never
          : originalDbGet(sql, params));
      let dispatched = 0;
      const ports = { processStartToken: () => "native-start", processStartedAt: () => "ps-start",
        senderFactory: () => { dispatched++; return async () => ({ contact: "REACHED" as const,
          answered: allow(ReasonCode.OK, "unexpected") }); } };
      expect((await createConfiguredHermesGatewayConversation(cp, config(), ports)!("status", source)).contact)
        .toBe("NEVER_REACHED");
      expect(dispatched).toBe(0);
      expect((await createConfiguredHermesGatewayConversation(cp, config(), {
        ...ports, processStartedAt: () => "different-process",
      })!("status", source)).contact).toBe("NEVER_REACHED");
      expect(dispatched).toBe(0);
      vi.spyOn(cp.db, "get").mockImplementation((sql, params) =>
        String(sql).includes("FROM actor_target_bindings")
          ? { executor_kind: "hermes", target_locator: "live-head", target_locator_digest: digest } as never
          : originalDbGet(sql, params));
      expect((await createConfiguredHermesGatewayConversation(cp, config(), {
        ...ports, processStartToken: () => null,
      })!("status", source)).contact).toBe("NEVER_REACHED");
      expect(dispatched).toBe(0);
      const partial = { ACP_HERMES_EXPECTED_LIVE_SESSION_ID: "live-head" };
      expect((await createConfiguredHermesGatewayConversation(cp, partial, ports)!("status", source)).contact)
        .toBe("NEVER_REACHED");
      expect(createConfiguredHermesGatewayConversation(cp, {}, ports)).toBeUndefined();
      expect((await createConfiguredHermesGatewayConversation(cp,
        { ACP_HERMES_GATEWAY_API_KEY: "fixture-gateway-key" }, ports)!("status", source)).contact)
        .toBe("NEVER_REACHED");
      expect(dispatched).toBe(0);
    } finally { cp.close(); vi.restoreAllMocks(); }
  });
});
