import type * as fs from "node:fs";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Role, type RoleBinding } from "../../src/domain/types.ts";
import { C0_QUALIFIED_CLIENT, RoleConversationPort } from "../../src/mcp/role-conversation.ts";

// Filesystem qualification and wake delivery have socket tests. This fixture supplies a
// qualified path so these assertions isolate slot ownership and endpoint collisions.
vi.mock("node:fs", async (original) => ({
  ...await original<typeof fs>(),
  lstatSync: (path: string) => ({
    uid: process.getuid!(), mode: 0o700, isSymbolicLink: () => false,
    isDirectory: () => path === "/attachment-state", isSocket: () => path.endsWith(".sock"),
  }),
}));

afterEach(() => vi.restoreAllMocks());

const fixture = async () => {
  const binding = (projectId: string): RoleBinding => ({
    assignmentId: `assignment-${projectId}`, roleKey: `PRIMARY_CTO:${projectId}`, role: Role.PRIMARY_CTO,
    projectId, runId: null, taskId: null, sessionId: `session-${projectId}`,
    sessionIncarnation: `incarnation-${projectId}`, boundSessionId: `session-${projectId}`,
    boundSessionIncarnation: `incarnation-${projectId}`, bindingGeneration: 1,
    mode: "PREFERRED", status: "ACTIVE", createdAt: "2026-09-08T00:00:00.000Z",
  });
  const first = binding("first");
  const second = binding("second");
  const active = new Map([first, second].map((value) => [value.roleKey, value]));
  const port = new RoleConversationPort(Role.PRIMARY_CTO, {
    active: (key) => active.get(key) ?? null, currentCandidates: () => [...active.values()],
  }, { endpointDir: "/attachment-state" });
  vi.spyOn(port, "wake").mockResolvedValue(allow(ReasonCode.OK, undefined));
  const attach = (holder: RoleBinding) => {
    const server = new McpServer({ name: holder.sessionId, version: "1" });
    vi.spyOn(server.server, "getClientVersion").mockReturnValue(C0_QUALIFIED_CLIENT);
    port.attach(server, () => allow(ReasonCode.OK, { actor: holder.sessionId,
      sessionId: holder.sessionId, sessionIncarnation: holder.sessionIncarnation }), holder.roleKey);
    return server;
  };
  const incumbent = attach(first);
  const current = attach(second);
  const endpoint = "/attachment-state/wake.sock";
  expect((await port.registerEndpoint(incumbent, endpoint)).allowed).toBe(true);
  return { port, active, first, second, current, endpoint };
};

describe("attachment endpoint reservations", () => {
  it("a stale competitor cannot block a current endpoint registration", async () => {
    const { port, active, first, second, current, endpoint } = await fixture();
    active.set(first.roleKey, { ...first, sessionId: "successor", sessionIncarnation: "successor" });
    // No query or reauthorization of the competitor before registration.
    expect(await port.registerEndpoint(current, endpoint)).toMatchObject({ allowed: true, value: [second.roleKey] });
    expect(port.connected(first.roleKey)).toBe(false);
    expect(port.endpointFor(second.roleKey)).toBe(endpoint);
  });

  it("two current peers cannot share an endpoint and refusal names the competing role", async () => {
    const { port, first, second, current, endpoint } = await fixture();
    expect(await port.registerEndpoint(current, endpoint)).toEqual({
      allowed: false, reasonCode: ReasonCode.ROLE_PEER_UNSUPPORTED,
      message: "another live peer of this role already registered that wake endpoint",
      evidence: { role: Role.PRIMARY_CTO, heldBy: first.roleKey },
    });
    expect(port.endpointFor(first.roleKey)).toBe(endpoint);
    expect(port.endpointFor(second.roleKey)).toBeNull();
  });

  it("endpoint lookup does not expose a former holder registration", async () => {
    const { port, active, first } = await fixture();
    active.set(first.roleKey, { ...first, sessionId: "successor", sessionIncarnation: "successor" });
    expect(port.endpointFor(first.roleKey)).toBeNull();
  });
});
