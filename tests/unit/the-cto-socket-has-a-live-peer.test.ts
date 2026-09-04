import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, afterAll } from "vitest";

import { startLocalMcpListeners } from "../../src/daemon/agentcpd.ts";
import { Role, SessionLifecycle } from "../../src/domain/types.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { allow } from "../../src/core/errors.ts";
import type { McpPeerAuthenticator } from "../../src/mcp/shared.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { makeHarness, registerFixtureProject } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * `#760` Part B / B2 — the daemon has somewhere to push a message addressed to the CTO role.
 *
 * The CEO half of this already exists: `hermes.mcp.sock`'s handler ends with
 * `ceoConversation.attach(server, auth)`, so whoever currently holds the CEO binding is a live
 * peer the daemon can reach without spawning anything. `cto.mcp.sock` is served by the same
 * `startMcpSocket` with the same role authentication and has no equivalent line, so a message
 * addressed to the CTO has no destination inside the daemon at all.
 *
 * That absence is what a person has been standing in for. Measured on 2026-09-04: CEO messages
 * reached this repository's CTO session only because the session polled the relay by hand, and
 * when that polling stopped the owner carried messages between the two roles. `#760` X2 names
 * that arrangement as the violation rather than the workaround.
 *
 * The port is addressed by **role**, not by session (B0). A CTO session is replaced routinely,
 * and the sender must keep using the same address across the replacement.
 */
const stillCto = (): McpPeerAuthenticator => () =>
  allow(ReasonCode.OK, { sessionId: "s", sessionIncarnation: "i", sessionSecret: "x" } as never);

interface FakePeer {
  capabilities: { sampling?: Record<string, unknown> } | undefined;
  answer: (() => Promise<unknown>) | null;
  calls: string[];
}

/** The port touches exactly two members of the SDK server, and both are driven by a real peer. */
const fakePeer = (peer: FakePeer): McpServer =>
  ({
    server: {
      getClientCapabilities: () => peer.capabilities,
      createMessage: async (params: { messages: { content: { text?: string } }[] }) => {
        peer.calls.push(params.messages[0]?.content.text ?? "");
        if (!peer.answer) throw new Error("no scripted answer");
        return peer.answer();
      },
    },
  }) as unknown as McpServer;

describe("the CTO socket has a live peer the daemon can reach", () => {
  it("exposes a conversation port for the CTO role, and a message addressed to it reaches the peer", async () => {
    const harness = makeHarness();
    // The CTO role is scoped to a project — `roleKeyFor(PRIMARY_CTO, { projectId })` — which is
    // B0's point in the schema already: the address names a role in a project, not a session.
    const { projectId } = await registerFixtureProject(harness);
    const session = harness.cp.sessions.create({ provider: "scripted", model: "cto-peer" });
    expect(
      harness.cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "CTO MCP peer")
        .reasonCode,
    ).toBe(ReasonCode.OK);
    expect(harness.cp.bindings.bind({ role: Role.PRIMARY_CTO, sessionId: session.sessionId, projectId })
        .reasonCode)
      .toBe(ReasonCode.OK);

    const listeners = await startLocalMcpListeners(
      harness.cp,
      tempDir("acp-cto-peer-"),
      "local-test-token",
    );
    try {
      // The product fact: the daemon holds a destination for the CTO role, the way it already
      // does for the CEO. Without it there is nothing for a resolved mention to be delivered to.
      const port = listeners.ctoConversation;
      expect(port, "the daemon exposes no conversation port for the CTO role").toBeDefined();

      // No peer is a normal state — a role is replaced routinely — so it refuses rather than
      // spawning a substitute, and says which role had nobody.
      const unreachable = await port.deliver("are you there");
      expect(unreachable.allowed).toBe(false);
      expect(unreachable.reasonCode, "absence is reported as its own fact, not a failure").toBe(
        ReasonCode.ROLE_PEER_ABSENT,
      );

      const peer: FakePeer = { capabilities: { sampling: {} }, answer: null, calls: [] };
      peer.answer = async () => ({ content: { type: "text", text: "received" } });
      const detach = port.attach(fakePeer(peer), stillCto());
      try {
        const answered = await port.deliver("a message addressed to the CTO role");
        if (!answered.allowed) throw new Error(`the attached CTO peer was not reached: ${answered.message}`);
        expect(answered.value, "the peer's acknowledgement is what closes the delivery").toBe("received");
        expect(peer.calls).toEqual(["a message addressed to the CTO role"]);
      } finally {
        detach();
      }
    } finally {
      await listeners.close();
    }
  }, 60_000);
});
