import { spawn } from "node:child_process";
import { chmodSync, existsSync, lstatSync, readFileSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { allow, type Decision } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { startDaemonMcpListeners } from "../../src/daemon/agentcpd.ts";
import { Daemon, OPERATOR_METHOD, type AuthenticatedOperatorPeer } from "../../src/daemon/daemon.ts";
import { Role, SessionLifecycle, roleKeyFor, type RoleBinding } from "../../src/domain/types.ts";
import {
  ROLE_WAKE_FRAME,
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

  it("reports a holder whose registration still validates and whose wake was refused", async () => {
    // Both reviewers' reproduction: every check made before a wake is sent passes -- the path is
    // there, it is a socket, this uid owns it, its directory is owner-only -- and the connect is
    // refused, because the process that bound it is gone. A socket path outlives its listener, so
    // no filesystem answer can see this, and the scan called the holder wakeable while `wake`
    // answered ROLE_PEER_FAILED.
    const stateDir = tempDir("acp-wq-port-refused-");
    chmodSync(stateDir, 0o700);
    const onMember = binding("on-member");
    const { port, attach } = portOver([onMember], stateDir);
    const server = attach(onMember, { ...WAKE_TRANSPORT_QUALIFIED_CLIENTS[0] });
    const presented = `${WAKE_TRANSPORT_QUALIFIED_CLIENTS[0].name}/${WAKE_TRANSPORT_QUALIFIED_CLIENTS[0].version}`;
    const path = join(stateDir, "cto.wake.sock");
    await abandonSocket(path);

    // The validation still says yes, which is the whole difficulty: registration is accepted.
    expect((await port.registerEndpoint(server, path)).allowed).toBe(true);
    expect(port.endpointFor(onMember.roleKey)).toBe(path);
    // Registration sends one wake of its own, and that is the delivery that fails here. Nothing
    // dialled this socket to find out: the daemon was sending a wake anyway.
    expect(await port.wake(onMember.roleKey)).toMatchObject({
      allowed: false, reasonCode: ReasonCode.ROLE_PEER_FAILED,
    });
    expect(port.unwakeableHolders()).toEqual([
      {
        roleKey: onMember.roleKey, role: Role.PRIMARY_CTO, presented,
        cause: "registered-endpoint-refused-the-wake",
      },
    ]);

    // What it establishes is a delivery that failed, not one that would fail. A listener bound
    // behind the same path does not reach into the daemon to say so, and the report stays until a
    // wake contradicts it -- which errs towards reporting, and is the direction to err in.
    rmSync(path, { force: true });
    const endpoint = await listeningSocket(path);
    try {
      expect(port.unwakeableHolders()).toHaveLength(1);
      expect((await port.wake(onMember.roleKey)).allowed).toBe(true);
      // The listener sees the frame on a later tick than the wake resolves on: `end` returns when
      // the bytes are flushed, not when the peer has read them.
      for (let attempt = 0; attempt < 50 && endpoint.received.length === 0; attempt += 1) {
        await new Promise((tick) => setTimeout(tick, 20));
      }
      expect(endpoint.received).toEqual([ROLE_WAKE_FRAME]);
      // The wake that landed is the contradiction, and the memory goes with it.
      expect(port.unwakeableHolders()).toEqual([]);
    } finally {
      await endpoint.close();
    }
  });

  it("forgets the refusal an earlier registration earned, before its own wake decides anything", async () => {
    // The rule the surrounding doc states: a refusal is remembered *for the registration that
    // earned it*. A registration is a new fact about where to knock, so a refusal carried across
    // one would outlive the fact it describes -- a holder that rebound and registered again would
    // be reported unwakeable on the strength of a delivery to the process before it.
    //
    // Observing that needs a point inside a registration, because a registration ends by sending
    // one wake of its own whose outcome sets or clears the same field: after `registerEndpoint`
    // returns, the memory always describes that registration's own delivery, whether or not the
    // earlier one was forgotten. So the observation is taken from the listener the wake is being
    // delivered to. Measured 200/200 on this platform: a unix listener's `connection` event is
    // emitted before `socket.end(frame, cb)` calls back, which is where the wake resolves -- the
    // `data` event is the one that lands after, which is why the row above has to poll for it.
    const stateDir = tempDir("acp-wq-port-forget-");
    chmodSync(stateDir, 0o700);
    const onMember = binding("on-member");
    const { port, attach } = portOver([onMember], stateDir);
    const server = attach(onMember, { ...WAKE_TRANSPORT_QUALIFIED_CLIENTS[0] });
    const path = join(stateDir, "cto.wake.sock");

    // One registration that earns a refusal: the socket is there, every check passes, the connect
    // is refused because the process that bound it is gone.
    await abandonSocket(path);
    expect((await port.registerEndpoint(server, path)).allowed).toBe(true);
    expect(port.unwakeableHolders()).toMatchObject([{ cause: "registered-endpoint-refused-the-wake" }]);

    // Then the holder rebinds the same path and registers again. The listener reports what the port
    // said about it at the moment that registration's wake arrived -- after the registration, before
    // the delivery that would decide anything.
    rmSync(path, { force: true });
    let insideTheWake: unknown = "the wake never arrived";
    const listener = createServer((socket) => {
      if (insideTheWake === "the wake never arrived") insideTheWake = port.unwakeableHolders();
      // Drained, not read: with nothing consuming the frame the readable side never reaches EOF,
      // the peer's half-close never completes, and `close()` below waits on an open connection.
      socket.resume();
    });
    await new Promise<void>((bound) => {
      listener.listen(path, bound);
    });
    try {
      expect((await port.registerEndpoint(server, path)).allowed).toBe(true);
      // Not a vacuous pass: the snapshot has to have been taken, and it has to be empty.
      expect(insideTheWake).toEqual([]);
      // And afterwards, for the same reason, the holder is wakeable -- the new registration's own
      // wake landed.
      expect(port.unwakeableHolders()).toEqual([]);
    } finally {
      await new Promise<void>((closed) => {
        listener.close(() => closed());
      });
    }
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
  const startHolder = async (
    label: string,
    client: { name: string; version: string } | undefined,
    register: boolean | "abandoned" = false,
  ) => {
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
    const endpointPath = join(stateDir, `cto-${label}.wake.sock`);
    // "abandoned" is a socket file whose listener is gone: every check the daemon makes before it
    // connects passes, and the connect is refused. Registration succeeds either way -- it is
    // decided by those checks -- and what differs is whether the wake it sends lands.
    if (register === "abandoned") await abandonSocket(endpointPath);
    const endpoint = register === true ? await listeningSocket(endpointPath) : null;
    if (register !== false) {
      const registered = await callTool(socket, "role_wake_endpoint_register", { endpoint: endpointPath });
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
  const holderOn = async (
    label: string,
    client: { name: string; version: string } | undefined,
    register: boolean | "abandoned" = false,
  ) => {
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

  it("reports a holder whose registered endpoint refused the wake it was sent", async () => {
    // Through the production door, with the production registration tool: the holder registers a
    // socket the daemon accepts, the wake registration itself sends is refused, and the report says
    // so with its own cause and its own repair. The repair is a restart of the holder -- there is
    // no directory to put back and no build to change.
    const { findings, roleKey, stateDir } = await holderOn("refused", MEMBER, "abandoned");
    const presented = `${MEMBER.name}/${MEMBER.version}`;

    const finding = findings.find((candidate) => candidate.code === CODE);
    expect(finding, "no finding for a holder whose registered endpoint refused the wake").toBeDefined();
    expect(finding?.observedEvidence).toEqual({
      roleKey,
      role: Role.PRIMARY_CTO,
      presentedClient: presented,
      cause: "registered-endpoint-refused-the-wake",
      wakeTransportQualifiedClients: WAKE_TRANSPORT_QUALIFIED_CLIENTS.map(({ name, version }) => `${name}/${version}`),
      wakeTransportPinSource: "src/mcp/role-conversation.ts WAKE_TRANSPORT_QUALIFIED_CLIENTS",
    });
    expect(finding?.recommendedAction).toContain("cannot receive wakes");
    expect(finding?.recommendedAction).toContain("the last wake sent under the registration it holds now was refused");
    // It says a wake failed, not that the next one must, and the repair is the holder's own restart.
    expect(finding?.recommendedAction).toContain("Restart the holder so it binds and registers again");
    expect(finding?.recommendedAction).not.toContain("Restart the holder on a qualified build");
    expect(finding?.recommendedAction).not.toContain("--messaging-socket-path");

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
   * Nothing here is mocked, and that is a repair. This fixture used to replace `Doctor.run` with a
   * double that aggregated *the third argument the daemon passed it*, which measured the argument
   * and not the report. Once the supplemental findings became a supplier registered on the doctor
   * (#1010), no caller passes that argument any more: the double received `[]`, aggregated to
   * `HEALTHY`, and the row asserted something about a seam production had stopped using.
   *
   * What replaces it is production's own record of the evaluation the persisted status came from.
   * `Doctor.run` audits every report as `DOCTOR_REPORT` carrying each finding's code, severity and
   * blocking flag, and `reconcileContinuity` completes exactly one system evaluation, so the rows
   * added across the call are that evaluation and nothing else. `health.json` cannot serve this
   * alone: its `doctor` field is a `DoctorHealthSnapshot`, which has a status and no findings. So
   * the row asserts both halves -- that the audited report is the one whose status was persisted,
   * and that it carries the finding.
   *
   * The status alone cannot carry the claim without the double. With the doctor's own checks
   * running, this fixture's deployment reports unrelated non-blocking findings of its own, so the
   * persisted status is `DEGRADED` for a wakeable holder too and `DEGRADED` for an unwakeable one
   * would prove nothing. The discriminating assertion is therefore the finding itself, with its
   * severity: a non-blocking `ERROR` cannot aggregate to `HEALTHY` under §25.5, so an evaluation
   * carrying one is an evaluation no persisted status can round up.
   */
  const refreshedAutomatically = async (
    label: string,
    client: { name: string; version: string } | undefined,
    register: boolean | "abandoned" = false,
  ) => {
    const { harness, daemon, stateDir, close } = await startHolder(label, client, register);
    try {
      const auditedBefore = harness.cp.audit.byKind("DOCTOR_REPORT").length;
      harness.clock.advance(10_000);
      await daemon.reconcileContinuity(`wake-set test: an automatic refresh with a ${label} holder connected`);
      const health = JSON.parse(readFileSync(join(stateDir, "health.json"), "utf8")) as {
        doctor?: { status: string; checkedAt: string | null };
      };
      // The refresh ran: the snapshot is the evaluation just taken, not the one from startup.
      expect(health.doctor?.checkedAt).toBe(harness.clock.nowIso());
      // One evaluation, so the report audited across this call *is* the one just persisted. The
      // status is compared as well, because a row belonging to some other pass could otherwise
      // stand in for this one and be read as evidence about it.
      const audited = harness.cp.audit.byKind("DOCTOR_REPORT").slice(auditedBefore);
      expect(audited).toHaveLength(1);
      const report = audited[0]?.evidence as {
        scope?: string;
        status?: string;
        findings?: { code: string; severity: string; blocking: boolean }[];
      };
      expect(report.scope).toBe("system");
      expect(report.status).toBe(health.doctor?.status);
      return {
        persistedStatus: health.doctor?.status,
        unwakeable: (report.findings ?? []).filter((finding) => finding.code === CODE),
      };
    } finally {
      await close();
    }
  };

  /** One unwakeable holder, reported once, in the evaluation whose status reached `health.json`. */
  const expectTheRefreshReportsOneUnwakeableHolder = async (
    label: string,
    client: { name: string; version: string } | undefined,
    register: boolean | "abandoned" = false,
  ): Promise<void> => {
    const { persistedStatus, unwakeable } = await refreshedAutomatically(label, client, register);
    expect(unwakeable, `${label}: the persisted evaluation carried no unwakeable-binding finding`)
      .toHaveLength(1);
    expect(unwakeable[0]).toMatchObject({ severity: "ERROR", blocking: false });
    expect(persistedStatus).not.toBe("HEALTHY");
  };

  it("the automatic refresh does not persist HEALTHY while a connected holder is outside the set", async () => {
    await expectTheRefreshReportsOneUnwakeableHolder("outside", NOT_A_MEMBER);
    await expectTheRefreshReportsOneUnwakeableHolder("no-build", undefined);
    // The state the scan used to skip: a member build with no registration reaches this door too.
    await expectTheRefreshReportsOneUnwakeableHolder("member-unregistered", MEMBER);
    // And the one no filesystem check can see: a registration that validates and takes no wake.
    await expectTheRefreshReportsOneUnwakeableHolder("refused", MEMBER, "abandoned");
  });

  it("the automatic refresh reports no such finding for a holder on a qualified build that is wakeable — the control", async () => {
    // A control the defect could not have satisfied: this holder is wakeable, through the real
    // registration tool, against a real socket in the daemon's own state directory. It no longer
    // asserts a persisted `HEALTHY` -- with the doctor's own checks running, this deployment is
    // `DEGRADED` for reasons that have nothing to do with wakes -- so what it establishes is that
    // the assertion above is not one every deployment satisfies.
    const { unwakeable } = await refreshedAutomatically("member", MEMBER, true);

    expect(unwakeable).toHaveLength(0);
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
 * Leaves a socket file behind with nothing listening on it, the way a client that exited without
 * cleaning up does.
 *
 * A separate process binds it and is killed uncatchably, because a unix socket file outlives the
 * process that bound it and is removed only by an unlink somebody runs. Nothing else here can
 * produce the state: `server.close()` unlinks the path, so a closed listener leaves no file, and a
 * file made any other way is not a socket and would be refused for that instead. The point of the
 * state is that every check the daemon makes before it connects passes and the connect does not.
 *
 * The child is this test's own, started and killed here; nothing is signalled that this row did
 * not spawn.
 */
const abandonSocket = async (path: string): Promise<void> => {
  const child = spawn(
    process.execPath,
    ["-e", "require('net').createServer().listen(process.argv[1], () => console.log('bound'))", path],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the fixture listener never bound\n${stderr}`)), 10_000);
    const stop = (settle: () => void): void => {
      clearTimeout(timer);
      settle();
    };
    child.stdout.on("data", () => stop(resolve));
    child.once("error", (error) => stop(() => reject(error)));
    // A bind that fails exits, and the reason is on stderr -- most often a path over the ~104-byte
    // cap a unix socket has, which is silent in every other way.
    child.once("exit", (code) => stop(() => reject(new Error(`the fixture listener exited ${code}: ${stderr}`))));
  });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGKILL");
  await exited;
  // Stat'd rather than assumed: the row is worthless unless the path is still a socket this uid
  // owns, which is what makes the registration pass and the connect fail.
  expect(existsSync(path) && lstatSync(path).isSocket()).toBe(true);
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
