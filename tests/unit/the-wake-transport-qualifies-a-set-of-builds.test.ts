import { createConnection, type Socket } from "node:net";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { allow, type Decision } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { startDaemonMcpListeners } from "../../src/daemon/agentcpd.ts";
import { Daemon, OPERATOR_METHOD, type AuthenticatedOperatorPeer } from "../../src/daemon/daemon.ts";
import { Role, SessionLifecycle, roleKeyFor, type RoleBinding } from "../../src/domain/types.ts";
import {
  RoleConversationPort,
  WAKE_TRANSPORT_QUALIFIED_CLIENTS,
  isWakeTransportQualified,
} from "../../src/mcp/role-conversation.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { fixtureManifest, makeHarness } from "../helpers/harness.ts";

/**
 * The wake transport qualifies a **set** of builds, and membership in it is exact.
 *
 * Measured on 2026-09-27: four live clients on three builds, none of them the single build the
 * transport then admitted. Every binding on those clients held its role, could not register a wake
 * endpoint, and had nothing to say so — its messages were stored and waited for a registration
 * that could not come. These rows are about the two halves of the repair: the set admits each of
 * its members and nothing near one, and a binding whose holder is outside it is reported.
 *
 * Every build named below is a fixture, never one read off this host: nothing here depends on
 * which client happens to be installed, and no row spawns one.
 */

afterEach(() => {
  vi.restoreAllMocks();
  cleanupTempDirs();
});

const valueOf = <T>(decision: Decision<T>): T => {
  if (!decision.allowed) throw new Error(JSON.stringify(decision));
  return decision.value;
};

/** A build outside the committed set, derived from a member so it can never become one by a move. */
const NOT_A_MEMBER = {
  name: WAKE_TRANSPORT_QUALIFIED_CLIENTS[0].name,
  version: `${WAKE_TRANSPORT_QUALIFIED_CLIENTS[0].version}.9999-not-a-member`,
};

describe("membership in the qualified set is exact", () => {
  it("admits each member of a set of several builds exactly, and nothing near one", () => {
    const members = [
      { name: "claude-code", version: "2.1.268" },
      { name: "claude-code", version: "2.1.282" },
      { name: "claude-code", version: "2.1.283" },
    ];
    // Copies, so what is compared is the pair's value and never an object's identity.
    for (const member of members) {
      expect(isWakeTransportQualified({ ...member }, members), `${member.version} is a member`).toBe(true);
    }

    // Each of these would be admitted by a floor, a range, a prefix or a vendor check, and each is
    // a build nobody measured.
    const near = [
      { name: "claude-code", version: "2.1.284" }, // newer than every member
      { name: "claude-code", version: "2.1.270" }, // between two members
      { name: "claude-code", version: "2.1.26" }, // a prefix of a member
      { name: "claude-code", version: "2.1.268.1" }, // extends a member
      { name: "claude-code", version: "2.1.268 " },
      { name: "claude-code", version: "" },
      { name: "claude", version: "2.1.268" }, // a member's version under another name
      { name: "Claude-Code", version: "2.1.282" },
    ];
    for (const client of near) {
      expect(isWakeTransportQualified(client, members), JSON.stringify(client)).toBe(false);
    }
    expect(isWakeTransportQualified(undefined, members)).toBe(false);
    expect(isWakeTransportQualified(members[0], []), "an empty set admits nothing").toBe(false);

    // The committed set is what every production caller gets by default.
    for (const member of WAKE_TRANSPORT_QUALIFIED_CLIENTS) {
      expect(isWakeTransportQualified({ ...member })).toBe(true);
    }
    expect(isWakeTransportQualified(NOT_A_MEMBER)).toBe(false);
  });
});

describe("the CTO port names every holder that cannot register a wake endpoint", () => {
  it("reports a connected holder on a build outside the set and one that declared no build, and not a member", async () => {
    const binding = (projectId: string): RoleBinding => ({
      assignmentId: `assignment-${projectId}`, roleKey: `PRIMARY_CTO:${projectId}`, role: Role.PRIMARY_CTO,
      projectId, runId: null, taskId: null, sessionId: `session-${projectId}`,
      sessionIncarnation: `incarnation-${projectId}`, boundSessionId: `session-${projectId}`,
      boundSessionIncarnation: `incarnation-${projectId}`, bindingGeneration: 1,
      mode: "PREFERRED", status: "ACTIVE", createdAt: "2026-09-27T00:00:00.000Z",
    });
    const onMember = binding("on-member");
    const outside = binding("outside");
    const noBuild = binding("no-build");
    const active = new Map([onMember, outside, noBuild].map((value) => [value.roleKey, value]));
    const port = new RoleConversationPort(Role.PRIMARY_CTO, {
      active: (key) => active.get(key) ?? null,
      currentCandidates: () => [...active.values()],
    });
    const attach = (holder: RoleBinding, client: { name: string; version: string } | undefined) => {
      const server = new McpServer({ name: holder.sessionId, version: "1" });
      vi.spyOn(server.server, "getClientVersion").mockReturnValue(client);
      port.attach(server, () => allow(ReasonCode.OK, {
        actor: holder.sessionId, sessionId: holder.sessionId, sessionIncarnation: holder.sessionIncarnation,
      }));
      return server;
    };
    attach(onMember, { ...WAKE_TRANSPORT_QUALIFIED_CLIENTS[0] });
    attach(outside, NOT_A_MEMBER);
    // No `clientInfo` at all. `registerEndpoint` refuses this peer on the same predicate, so it is
    // exactly as unwakeable as the one outside the set, and the report has no build name to go on.
    const noBuildServer = attach(noBuild, undefined);

    expect(port.unwakeableHolders()).toEqual([
      { roleKey: outside.roleKey, role: Role.PRIMARY_CTO, presented: `${NOT_A_MEMBER.name}/${NOT_A_MEMBER.version}` },
      { roleKey: noBuild.roleKey, role: Role.PRIMARY_CTO, presented: null },
    ]);
    // The refusal that makes it unwakeable describes the same peer the same way: `presented: null`.
    expect(await port.registerEndpoint(noBuildServer, "/nonexistent/wake.sock")).toMatchObject({
      allowed: false, reasonCode: ReasonCode.ROLE_PEER_UNSUPPORTED, evidence: { presented: null },
    });

    // A holder that is no longer the registry's current one is not a binding this port serves, so
    // it is not reported either: the finding is about active bindings, not about sockets.
    active.delete(outside.roleKey);
    active.delete(noBuild.roleKey);
    expect(port.unwakeableHolders()).toEqual([]);
  });
});

describe("the daemon reports a binding that cannot receive wakes", () => {
  const CODE = "ROLE_BINDING_CANNOT_RECEIVE_WAKES";
  const TOKEN = "wake-set-deployment-token";
  const PEER: AuthenticatedOperatorPeer = {
    channel: "cli",
    peerId: "cli:fixture-operator",
    actor: "fixture-operator",
    incarnation: "incarnation-1",
  };

  /** Starts a real daemon with the production listener composition, and one CTO holder on it. */
  const holderOn = async (label: string, client: { name: string; version: string } | undefined) => {
    const harness = makeHarness();
    harness.cp.credentials.install({ token: "test-token", creatorIdentity: "acme-bot" });
    const manifest = fixtureManifest(`wake-set-${label}`);
    valueOf(harness.cp.projects.register({
      projectId: manifest.projectId, name: "fixture", manifest,
      authorization: harness.cp.manifestAuthorizationForTests(manifest),
    }));
    const session = harness.cp.sessions.create({ provider: "scripted", model: "fixture" });
    valueOf(harness.cp.sessions.transition(session.sessionId, SessionLifecycle.READY));
    if (!session.sessionSecret) throw new Error("fixture secret unavailable");
    const roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId: manifest.projectId });
    valueOf(harness.cp.bindings.bind({ role: Role.PRIMARY_CTO, projectId: manifest.projectId, sessionId: session.sessionId }));

    const stateDir = tempDir(`acp-wq-${label}-`);
    const daemon = new Daemon(harness.cp, { stateDir });
    expect((await daemon.start()).allowed).toBe(true);
    // The production composition: this is the call `main` makes, and the one that hands the CTO
    // port to the daemon's report. A test that installed the port itself would measure the port
    // and not the wiring.
    const listeners = await startDaemonMcpListeners(harness.cp, stateDir, TOKEN, daemon);
    const socket = await initializedPeer(listeners.socketPaths[1]!, {
      token: TOKEN, sessionId: session.sessionId, sessionSecret: session.sessionSecret,
    }, client);

    const response = await daemon.handleOperatorRequest(
      { requestId: `doctor-${label}`, method: OPERATOR_METHOD.DOCTOR_RUN, params: { scope: "system" } },
      PEER,
    );
    socket.destroy();
    await listeners.close();
    await daemon.stop();
    expect(response.allowed).toBe(true);
    const findings = (response as { value: { findings: Array<{ code: string; observedEvidence?: Record<string, unknown>; recommendedAction?: string }> } })
      .value.findings;
    return { findings, roleKey, stateDir };
  };

  it("names the build and says the binding cannot receive wakes, without naming a path", async () => {
    const { findings, roleKey, stateDir } = await holderOn("outside", NOT_A_MEMBER);
    const presented = `${NOT_A_MEMBER.name}/${NOT_A_MEMBER.version}`;

    const finding = findings.find((candidate) => candidate.code === CODE);
    expect(finding, "no finding for a binding whose holder is outside the qualified set").toBeDefined();
    expect(finding?.observedEvidence).toEqual({
      roleKey,
      role: Role.PRIMARY_CTO,
      presentedClient: presented,
      wakeTransportQualifiedClients: WAKE_TRANSPORT_QUALIFIED_CLIENTS.map(({ name, version }) => `${name}/${version}`),
      wakeTransportPinSource: "src/mcp/role-conversation.ts WAKE_TRANSPORT_QUALIFIED_CLIENTS",
    });
    expect(finding?.recommendedAction).toContain(presented);
    expect(finding?.recommendedAction).toContain("cannot receive wakes");

    // Not the state directory, not the socket beside it, and no absolute path of any kind.
    const text = JSON.stringify(finding);
    expect(text).not.toContain(stateDir);
    expect(text).not.toContain(".sock");
    expect(text).not.toMatch(/"\/|\s\/[A-Za-z]/);
  });

  it("reports a holder whose initialize declared no build, with presentedClient null and no path", async () => {
    const { findings, roleKey, stateDir } = await holderOn("no-build", undefined);

    const finding = findings.find((candidate) => candidate.code === CODE);
    expect(finding, "no finding for a binding whose holder declared no build").toBeDefined();
    expect(finding?.observedEvidence).toEqual({
      roleKey,
      role: Role.PRIMARY_CTO,
      presentedClient: null,
      wakeTransportQualifiedClients: WAKE_TRANSPORT_QUALIFIED_CLIENTS.map(({ name, version }) => `${name}/${version}`),
      wakeTransportPinSource: "src/mcp/role-conversation.ts WAKE_TRANSPORT_QUALIFIED_CLIENTS",
    });
    expect(finding?.recommendedAction).toContain("declared no client build");
    expect(finding?.recommendedAction).toContain("cannot receive wakes");
    expect(finding?.recommendedAction).not.toContain("null");

    const text = JSON.stringify(finding);
    expect(text).not.toContain(stateDir);
    expect(text).not.toContain(".sock");
    expect(text).not.toMatch(/"\/|\s\/[A-Za-z]/);
  });

  it("stays quiet when the holder runs a qualified build — the control", async () => {
    const { findings } = await holderOn("member", { ...WAKE_TRANSPORT_QUALIFIED_CLIENTS[0] });

    expect(findings).not.toContainEqual(expect.objectContaining({ code: CODE }));
  });
});

/**
 * One MCP peer on the CTO socket, through `initialize` — the point at which its build is declared.
 *
 * Deliberately not a registration: the finding has to fire for a holder that never tries, because
 * a peer that never asks to be woken is exactly as unreachable as one that is refused.
 *
 * With `clientInfo` undefined the `initialize` is sent without one. The SDK's schema requires it,
 * so the server answers that request with an error and records no build; the answer is awaited
 * either way, because what the rows assert is the report, not how the SDK phrases the refusal.
 */
const initializedPeer = async (
  socketPath: string,
  handshake: { token: string; sessionId: string; sessionSecret: string },
  clientInfo: { name: string; version: string } | undefined,
): Promise<Socket> => {
  const socket = createConnection(socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const initialized = new Promise<void>((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("no initialize response")), 5_000);
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
        const message = JSON.parse(buffer.slice(0, newline)) as { id?: number; ok?: boolean; error?: unknown };
        buffer = buffer.slice(newline + 1);
        if (message.ok === false || (message.error !== undefined && clientInfo !== undefined)) {
          clearTimeout(timer);
          reject(new Error(JSON.stringify(message)));
        } else if (message.id === 1) {
          clearTimeout(timer);
          resolve();
        }
      }
    });
  });
  socket.write(`${JSON.stringify(handshake)}\n`);
  socket.write(`${JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, ...(clientInfo ? { clientInfo } : {}) },
  })}\n`);
  await initialized;
  socket.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  return socket;
};
