import { chmodSync, readFileSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { allow, type Decision } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { startDaemonMcpListeners } from "../../src/daemon/agentcpd.ts";
import { aggregate, type DoctorReport } from "../../src/doctor/doctor.ts";
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

describe("the CTO port names every holder that cannot be woken", () => {
  const binding = (projectId: string): RoleBinding => ({
    assignmentId: `assignment-${projectId}`, roleKey: `PRIMARY_CTO:${projectId}`, role: Role.PRIMARY_CTO,
    projectId, runId: null, taskId: null, sessionId: `session-${projectId}`,
    sessionIncarnation: `incarnation-${projectId}`, boundSessionId: `session-${projectId}`,
    boundSessionIncarnation: `incarnation-${projectId}`, bindingGeneration: 1,
    mode: "PREFERRED", status: "ACTIVE", createdAt: "2026-09-27T00:00:00.000Z",
  });

  /** A port over a fixed set of active bindings, with the endpoint directory a deployment gives it. */
  const portOver = (holders: readonly RoleBinding[], endpointDir?: string) => {
    const active = new Map(holders.map((value) => [value.roleKey, value]));
    const port = new RoleConversationPort(Role.PRIMARY_CTO, {
      active: (key) => active.get(key) ?? null,
      currentCandidates: () => [...active.values()],
    }, endpointDir === undefined ? {} : { endpointDir });
    const attach = (holder: RoleBinding, client: { name: string; version: string } | undefined) => {
      const server = new McpServer({ name: holder.sessionId, version: "1" });
      vi.spyOn(server.server, "getClientVersion").mockReturnValue(client);
      port.attach(server, () => allow(ReasonCode.OK, {
        actor: holder.sessionId, sessionId: holder.sessionId, sessionIncarnation: holder.sessionIncarnation,
      }));
      return server;
    };
    return { port, active, attach };
  };

  it("reports a holder on a build outside the set and one that declared no build, each with its cause", async () => {
    const outside = binding("outside");
    const noBuild = binding("no-build");
    const { port, active, attach } = portOver([outside, noBuild]);
    attach(outside, NOT_A_MEMBER);
    // No `clientInfo` at all. `registerEndpoint` refuses this peer on the same predicate, so it is
    // exactly as unwakeable as the one outside the set, and the report has no build name to go on.
    const noBuildServer = attach(noBuild, undefined);

    expect(port.unwakeableHolders()).toEqual([
      {
        roleKey: outside.roleKey, role: Role.PRIMARY_CTO,
        presented: `${NOT_A_MEMBER.name}/${NOT_A_MEMBER.version}`, cause: "build-outside-the-qualified-set",
      },
      { roleKey: noBuild.roleKey, role: Role.PRIMARY_CTO, presented: null, cause: "no-declared-build" },
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

  it("reports a holder on a qualified build that registered no endpoint, and stays quiet once it has one", async () => {
    // The state this whole slice exists to make visible, and the one the scan used to skip: the
    // build is a member, so `registerEndpoint` would admit it, and until it does `wake` refuses
    // with ROLE_PEER_UNSUPPORTED and `endpointFor` answers null. Measured here through the port's
    // own three answers rather than asserted from the code.
    const stateDir = tempDir("acp-wq-port-");
    chmodSync(stateDir, 0o700);
    const onMember = binding("on-member");
    const { port, attach } = portOver([onMember], stateDir);
    const server = attach(onMember, { ...WAKE_TRANSPORT_QUALIFIED_CLIENTS[0] });

    expect(port.endpointFor(onMember.roleKey)).toBeNull();
    expect(await port.wake(onMember.roleKey)).toMatchObject({
      allowed: false, reasonCode: ReasonCode.ROLE_PEER_UNSUPPORTED,
    });
    expect(port.unwakeableHolders()).toEqual([
      {
        roleKey: onMember.roleKey, role: Role.PRIMARY_CTO,
        presented: `${WAKE_TRANSPORT_QUALIFIED_CLIENTS[0].name}/${WAKE_TRANSPORT_QUALIFIED_CLIENTS[0].version}`,
        cause: "no-registered-endpoint",
      },
    ]);

    // The control has to be a holder that can actually be woken, not merely one on a member build:
    // a control that was itself unwakeable would agree with the defect this row is about.
    const endpoint = await listeningSocket(join(stateDir, "cto.wake.sock"));
    try {
      expect((await port.registerEndpoint(server, endpoint.path)).allowed).toBe(true);
      expect(port.endpointFor(onMember.roleKey)).toBe(endpoint.path);
      expect(port.unwakeableHolders()).toEqual([]);
      expect((await port.wake(onMember.roleKey)).allowed).toBe(true);
    } finally {
      await endpoint.close();
    }
  });

  it("reports a registered endpoint that has stopped being usable, which is the state a wake would refuse", async () => {
    // `wake` revalidates the path immediately before it connects, so a registration that has since
    // stopped passing those checks delivers nothing -- and a scan that only asked whether an
    // endpoint had ever been registered would call that holder wakeable. Reported with its own
    // cause, because the repair is a directory to put back rather than a build to restart.
    const stateDir = tempDir("acp-wq-port-gone-");
    chmodSync(stateDir, 0o700);
    const onMember = binding("on-member");
    const { port, attach } = portOver([onMember], stateDir);
    const server = attach(onMember, { ...WAKE_TRANSPORT_QUALIFIED_CLIENTS[0] });
    const endpoint = await listeningSocket(join(stateDir, "cto.wake.sock"));
    expect((await port.registerEndpoint(server, endpoint.path)).allowed).toBe(true);
    expect(port.unwakeableHolders()).toEqual([]);

    // The socket goes, the registration stays: nothing tells the port, which is the point.
    await endpoint.close();
    rmSync(endpoint.path, { force: true });

    expect(port.unwakeableHolders()).toEqual([
      {
        roleKey: onMember.roleKey, role: Role.PRIMARY_CTO,
        presented: `${WAKE_TRANSPORT_QUALIFIED_CLIENTS[0].name}/${WAKE_TRANSPORT_QUALIFIED_CLIENTS[0].version}`,
        cause: "registered-endpoint-not-usable",
      },
    ]);
    // The same state the scan now reports is the one a wake refuses, asked of the same port.
    expect(await port.wake(onMember.roleKey)).toMatchObject({ allowed: false });
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

  const MEMBER = { ...WAKE_TRANSPORT_QUALIFIED_CLIENTS[0] };

  /**
   * Starts a real daemon with the production listener composition, and one CTO holder on it.
   *
   * `register` binds a real socket in the daemon's own state directory and registers it through the
   * production tool, so a holder that is meant to be wakeable actually is. A control that skipped
   * this would be a holder on a member build that still cannot be woken -- which is the very state
   * these rows exist to report, so it would agree with the defect instead of ruling it out.
   */
  const startHolder = async (label: string, client: { name: string; version: string } | undefined, register = false) => {
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
    // The endpoint directory a registration is measured against is this one, and it has to be
    // owner-only before the daemon will accept anything inside it.
    chmodSync(stateDir, 0o700);
    const daemon = new Daemon(harness.cp, { stateDir });
    expect((await daemon.start()).allowed).toBe(true);
    // The production composition: this is the call `main` makes, and the one that hands the CTO
    // port to the daemon's report. A test that installed the port itself would measure the port
    // and not the wiring.
    const listeners = await startDaemonMcpListeners(harness.cp, stateDir, TOKEN, daemon);
    const socket = await initializedPeer(listeners.socketPaths[1]!, {
      token: TOKEN, sessionId: session.sessionId, sessionSecret: session.sessionSecret,
    }, client);
    const endpoint = register ? await listeningSocket(join(stateDir, `cto-${label}.wake.sock`)) : null;
    if (endpoint) {
      const registered = await callTool(socket, "role_wake_endpoint_register", { endpoint: endpoint.path });
      expect(registered.ok, `the fixture holder's registration: ${JSON.stringify(registered)}`).toBe(true);
    }
    const close = async (): Promise<void> => {
      socket.destroy();
      await listeners.close();
      await daemon.stop();
      if (endpoint) await endpoint.close();
    };
    return { harness, daemon, roleKey, stateDir, close };
  };

  /** The on-demand door: `OPERATOR_METHOD.DOCTOR_RUN`, the one an operator asks through. */
  const holderOn = async (label: string, client: { name: string; version: string } | undefined, register = false) => {
    const { daemon, roleKey, stateDir, close } = await startHolder(label, client, register);
    const response = await daemon.handleOperatorRequest(
      { requestId: `doctor-${label}`, method: OPERATOR_METHOD.DOCTOR_RUN, params: { scope: "system" } },
      PEER,
    );
    await close();
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
      cause: "build-outside-the-qualified-set",
      wakeTransportQualifiedClients: WAKE_TRANSPORT_QUALIFIED_CLIENTS.map(({ name, version }) => `${name}/${version}`),
      wakeTransportPinSource: "src/mcp/role-conversation.ts WAKE_TRANSPORT_QUALIFIED_CLIENTS",
    });
    expect(finding?.recommendedAction).toContain(presented);
    expect(finding?.recommendedAction).toContain("cannot receive wakes");
    // The repair open to every such holder comes first; qualifying its build is offered only with
    // the condition that closes it -- the updater may have deleted the file the holder runs.
    expect(finding?.recommendedAction).toContain("Restart the holder on a qualified build");
    expect(finding?.recommendedAction).toContain("may already have deleted");

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
      cause: "no-declared-build",
      wakeTransportQualifiedClients: WAKE_TRANSPORT_QUALIFIED_CLIENTS.map(({ name, version }) => `${name}/${version}`),
      wakeTransportPinSource: "src/mcp/role-conversation.ts WAKE_TRANSPORT_QUALIFIED_CLIENTS",
    });
    expect(finding?.recommendedAction).toContain("declared no client build");
    expect(finding?.recommendedAction).toContain("cannot receive wakes");
    expect(finding?.recommendedAction).not.toContain("null");
    // Not a restart: mid-initialize ends on its own, and a missing `clientInfo` survives a restart
    // that sends the same request.
    expect(finding?.recommendedAction).toContain("`clientInfo`");
    expect(finding?.recommendedAction).not.toMatch(/restart the holder on/i);

    const text = JSON.stringify(finding);
    expect(text).not.toContain(stateDir);
    expect(text).not.toContain(".sock");
    expect(text).not.toMatch(/"\/|\s\/[A-Za-z]/);
  });

  it("reports a holder on a qualified build that has registered no wake endpoint", async () => {
    // The production defect this row exists for: `unwakeableHolders` returned early on a qualified
    // build, so the one state this slice is about -- a member build the daemon still cannot wake --
    // was the one it never reported. The binding reads ACTIVE, the peer is live, `wake` refuses for
    // want of an endpoint, and an addressed message waits.
    const { findings, roleKey, stateDir } = await holderOn("member-unregistered", MEMBER);
    const presented = `${MEMBER.name}/${MEMBER.version}`;

    const finding = findings.find((candidate) => candidate.code === CODE);
    expect(finding, "no finding for a qualified holder that registered no wake endpoint").toBeDefined();
    expect(finding?.observedEvidence).toEqual({
      roleKey,
      role: Role.PRIMARY_CTO,
      presentedClient: presented,
      cause: "no-registered-endpoint",
      wakeTransportQualifiedClients: WAKE_TRANSPORT_QUALIFIED_CLIENTS.map(({ name, version }) => `${name}/${version}`),
      wakeTransportPinSource: "src/mcp/role-conversation.ts WAKE_TRANSPORT_QUALIFIED_CLIENTS",
    });
    expect(finding?.recommendedAction).toContain("cannot receive wakes");
    expect(finding?.recommendedAction).toContain("registered no wake endpoint");
    // The repair is a flag, not a restart on another build: this build is already a member.
    expect(finding?.recommendedAction).toContain("--messaging-socket-path");
    expect(finding?.recommendedAction).not.toContain("Restart the holder on a qualified build");

    const text = JSON.stringify(finding);
    expect(text).not.toContain(stateDir);
    expect(text).not.toContain(".sock");
    expect(text).not.toMatch(/"\/|\s\/[A-Za-z]/);
  });

  it("stays quiet when the holder runs a qualified build and has registered a usable endpoint — the control", async () => {
    // A control the defect could not have satisfied: this holder is wakeable, through the real
    // registration tool, against a real socket in the daemon's own state directory.
    const { findings } = await holderOn("member", MEMBER, true);

    expect(findings).not.toContainEqual(expect.objectContaining({ code: CODE }));
  });

  /**
   * The automatic door: a continuity reconciliation, which the periodic capacity-sensor tick and
   * the reactive provider-failure callback both route through, and which re-evaluates the doctor
   * and writes the status to `health.json` -- the file `DAEMON_STATUS` serves and a supervisor reads.
   *
   * This is the path the on-demand rows above never reach. When only the operator door carried the
   * supplemental findings, an operator asking got `DEGRADED` and the next automatic evaluation,
   * clean in every other respect, wrote `HEALTHY` over it while the holder was still unwakeable.
   *
   * "Clean in every other respect" is made literal: the doctor's own checks are replaced by none, so
   * the status is `aggregate` -- production's -- over exactly what the daemon hands `run`. This
   * fixture's own checks already report three non-blocking findings of their own (no Buzz for the
   * CTO, no CEO binding, no packet-reviewer scope), so without that the status is `DEGRADED` for a
   * member too, and `DEGRADED` for a non-member would prove nothing. The control below is what shows
   * the substitution leaves `HEALTHY` reachable.
   */
  const refreshedAutomatically = async (label: string, client: { name: string; version: string } | undefined, register = false) => {
    const { harness, daemon, stateDir, close } = await startHolder(label, client, register);
    try {
      vi.spyOn(harness.cp.doctor, "run").mockImplementation(
        async (scope = "system", target, supplemental = []): Promise<DoctorReport> => ({
          scope,
          target: target ?? null,
          status: aggregate(supplemental),
          findings: [...supplemental],
          ranAt: harness.clock.nowIso(),
        }),
      );
      harness.clock.advance(10_000);
      await daemon.reconcileContinuity(`wake-set test: an automatic refresh with a ${label} holder connected`);
      const health = JSON.parse(readFileSync(join(stateDir, "health.json"), "utf8")) as {
        doctor?: { status: string; checkedAt: string | null };
      };
      // The refresh ran: the snapshot is the evaluation just taken, not the one from startup.
      expect(health.doctor?.checkedAt).toBe(harness.clock.nowIso());
      return health.doctor?.status;
    } finally {
      await close();
    }
  };

  it("the automatic refresh does not persist HEALTHY while a connected holder is outside the set", async () => {
    expect(await refreshedAutomatically("outside", NOT_A_MEMBER)).toBe("DEGRADED");
    expect(await refreshedAutomatically("no-build", undefined)).toBe("DEGRADED");
    // The state the scan used to skip: a member build with no registration reaches this door too.
    expect(await refreshedAutomatically("member-unregistered", MEMBER)).toBe("DEGRADED");
  });

  it("the automatic refresh persists HEALTHY when the holder is on a qualified build and wakeable — the control", async () => {
    expect(await refreshedAutomatically("member", MEMBER, true)).toBe("HEALTHY");
  });
});

/**
 * One tool call on an already-initialized peer socket, answered with the decision body the port
 * returned.
 *
 * The production tool is what registers an endpoint -- `role_wake_endpoint_register` on the CTO
 * connection -- so a fixture that set the port's field directly would be measuring a state no
 * client can reach.
 */
const callTool = async (
  socket: Socket,
  name: string,
  args: Record<string, unknown>,
): Promise<{ ok?: boolean; reasonCode?: string }> => {
  const id = 1_000 + Math.floor(Math.random() * 1_000);
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error(`no response to ${name}`)), 5_000);
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString();
      for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let message: { id?: number; result?: { structuredContent?: { ok?: boolean; reasonCode?: string } } };
        try {
          message = JSON.parse(line) as typeof message;
        } catch {
          continue;
        }
        if (message.id !== id) continue;
        clearTimeout(timer);
        socket.off("data", onData);
        resolve(message.result?.structuredContent ?? { ok: false });
      }
    };
    socket.on("data", onData);
    socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })}\n`);
  });
};

/**
 * Stands in for the socket a woken client binds for itself: a listening unix socket, and a record
 * of what arrived.
 *
 * Deliberately **not** chmod'd. The real qualified runtime binds its own socket under its own umask
 * and never touches that file's mode, so a helper that tightened it here would be testing an
 * endpoint no real client produces. The rows chmod the *directory*, which is where the 0700
 * boundary actually is.
 */
const listeningSocket = async (path: string): Promise<{ path: string; received: string[]; close: () => Promise<void> }> => {
  const received: string[] = [];
  const server: Server = createServer((socket) => {
    let text = "";
    socket.on("data", (chunk: Buffer) => {
      text += chunk.toString();
    });
    socket.on("end", () => received.push(text));
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.removeListener("error", reject);
      resolveListen();
    });
  });
  return {
    path,
    received,
    close: () => new Promise<void>((resolveClose) => server.close(() => resolveClose())),
  };
};

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
