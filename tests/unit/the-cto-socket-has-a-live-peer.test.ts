import { createConnection, type Socket } from "node:net";

import { afterAll, describe, expect, it } from "vitest";

import { startLocalMcpListeners } from "../../src/daemon/agentcpd.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Role, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import {
  fixtureManifest,
  makeHarness,
  registerFixtureProject,
  type Harness,
} from "../helpers/harness.ts";
import { ExecutionMode } from "../../src/domain/types.ts";
import type { TaskContract } from "../../src/run/run-engine.ts";

afterAll(cleanupTempDirs);

/**
 * `#760` Part B / B2 — a message addressed to the CTO role reaches the session holding it, and
 * reaches nobody else.
 *
 * The CEO half already existed: `hermes.mcp.sock`'s handler ends with `ceoConversation.attach`,
 * so whoever holds the CEO binding is reachable without spawning anything. `cto.mcp.sock` is
 * served by the same `startMcpSocket` and had no equivalent line, so a message addressed to the
 * CTO had no destination inside the daemon and a person carried it (measured 2026-09-04).
 *
 * **These tests connect over the real socket.** An earlier version attached a fake peer directly
 * to the port, which measured the port and not the wiring — deleting the `attach` line in
 * `agentcpd.ts` left it green. Every row below goes through `startLocalMcpListeners`' own
 * `cto.mcp.sock`, so the wiring is inside what the test can kill.
 *
 * The socket admits `PRIMARY_CTO` **and** `BOOTSTRAP_CTO`, and `PRIMARY_CTO` is scoped per
 * project. Attaching every authenticated connection would let a bootstrap peer, or another
 * project's primary, become the destination for this project's canonical CTO — which is why the
 * rows below are as much about who must *not* receive as about who must.
 */
const TOKEN = "local-test-token";

/** The id `connectPeer` sends `initialize` under, and the id its response comes back on. */
const INITIALIZE_ID = 1;

const CONTRACT: TaskContract = {
  goal: "cto delivery target",
  why: "exercise the role's live peer",
  scope: [],
  nonGoals: [],
  acceptance: ["delivery reaches the holder"],
  priority: "NORMAL",
  humanGate: [],
  references: [],
};

interface PeerHandle {
  socket: Socket;
  /** Texts the daemon delivered to this peer over `sampling/createMessage`. */
  received: string[];
  /**
   * Whether this connection's `initialize` response has come back.
   *
   * A post-attach observable, not a timer. `startMcpSocket` calls its factory — which is where
   * `ctoConversation.attach` runs — and only then awaits `mcp.connect(transport)`, so the server
   * cannot have written a byte of this response until attach had already recorded the connection.
   * Waiting on it is therefore an ordering proof; a sleep is only a guess about scheduling.
   */
  initialized: () => boolean;
  close: () => Promise<void>;
}

/**
 * A real client on the real socket: credential line, then MCP initialize declaring `sampling`,
 * then it answers the server's `sampling/createMessage` requests. Nothing here stands in for the
 * daemon — only for the agent that would normally be on the other end.
 */
const connectPeer = async (
  socketPath: string,
  credential: { token: string; sessionId: string; sessionSecret: string },
): Promise<PeerHandle> => {
  const socket = createConnection(socketPath);
  const received: string[] = [];
  let initialized = false;
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });

  let buffer = "";
  socket.on("error", () => {
    /* a peer whose socket is destroyed mid-test is an outcome the rows assert on, not a throw */
  });
  socket.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim().length === 0) continue;
      let message: { id?: number; method?: string; params?: unknown; result?: unknown };
      try {
        message = JSON.parse(line) as typeof message;
      } catch {
        continue;
      }
      if (message.id === INITIALIZE_ID && message.method === undefined && message.result !== undefined) {
        initialized = true;
        continue;
      }
      if (message.method === "sampling/createMessage" && message.id !== undefined) {
        const params = message.params as { messages?: { content?: { text?: string } }[] } | undefined;
        received.push(params?.messages?.[0]?.content?.text ?? "");
        socket.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              role: "assistant",
              model: "test-peer",
              content: { type: "text", text: "received" },
            },
          })}\n`,
        );
      }
    }
  });

  socket.write(
    `${JSON.stringify(credential)}\n${JSON.stringify({
      jsonrpc: "2.0",
      id: INITIALIZE_ID,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        // The capability delivery travels on. Without it the port refuses rather than hanging.
        capabilities: { sampling: {} },
        clientInfo: { name: "cto-peer", version: "1" },
      },
    })}\n${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`,
  );

  return {
    socket,
    received,
    initialized: () => initialized,
    close: () =>
      new Promise<void>((resolve) => {
        if (socket.destroyed) {
          resolve();
          return;
        }
        socket.once("close", () => resolve());
        socket.destroy();
      }),
  };
};

/** Waits on a condition the daemon reaches asynchronously, rather than on a fixed delay. */
const until = async (predicate: () => boolean, what: string, timeoutMs = 10_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
};

const readySession = (harness: Harness, model: string) => {
  const session = harness.cp.sessions.create({ provider: "scripted", model });
  expect(
    harness.cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "MCP peer").reasonCode,
  ).toBe(ReasonCode.OK);
  if (!session.sessionSecret) throw new Error("test peer needs a session secret");
  return { sessionId: session.sessionId, sessionSecret: session.sessionSecret };
};

describe("a message addressed to the CTO role reaches its holder, and nobody else", () => {
  it("delivers to the canonical PRIMARY_CTO peer over its own socket", async () => {
    const harness = makeHarness();
    const { projectId } = await registerFixtureProject(harness);
    const session = readySession(harness, "cto-peer");
    expect(
      harness.cp.bindings.bind({ role: Role.PRIMARY_CTO, sessionId: session.sessionId, projectId })
        .reasonCode,
    ).toBe(ReasonCode.OK);
    const roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId });

    const listeners = await startLocalMcpListeners(harness.cp, tempDir("acp-cto-peer-"), TOKEN);
    const ctoSocket = listeners.socketPaths[1];
    if (!ctoSocket) throw new Error("the CTO MCP listener was not started");
    const peer = await connectPeer(ctoSocket, { token: TOKEN, ...session });
    try {
      await until(
        () => listeners.ctoConversation.connected(roleKey),
        "the CTO connection to become the role's live peer",
      );

      const delivered = await listeners.ctoConversation.deliver(roleKey, "addressed to the CTO");
      if (!delivered.allowed) throw new Error(`delivery refused: ${delivered.message}`);
      // The peer's own answer is what closes the delivery: `accepted` without it is the fault
      // this whole issue is about (B5).
      expect(delivered.value).toBe("received");
      expect(peer.received).toEqual(["addressed to the CTO"]);
    } finally {
      await peer.close();
      await listeners.close();
    }
  }, 60_000);

  it("does not let a BOOTSTRAP_CTO or another project's PRIMARY_CTO become this role's peer", async () => {
    const harness = makeHarness();
    const canonical = await registerFixtureProject(harness, "canonical-project");
    // A second registered project, but no second repository: a checkout path is bound to one
    // project, and what this row varies is the *scope the CTO role is bound at*. The project has
    // to exist — the binding's authority tuple is a foreign key — but nothing here needs a repo.
    const otherProjectId = "another-project";
    const otherManifest = fixtureManifest(otherProjectId);
    const otherProject = harness.cp.projects.register({
      projectId: otherProjectId,
      name: "fixture",
      manifest: otherManifest,
      authorization: harness.cp.manifestAuthorizationForTests(otherManifest),
    });
    if (!otherProject.allowed) throw new Error(`second project failed: ${otherProject.message}`);
    const roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId: canonical.projectId });
    const otherKey = roleKeyFor(Role.PRIMARY_CTO, { projectId: otherProjectId });

    // BOOTSTRAP_CTO is scoped by run, not project — `BOOTSTRAP_CTO:<runId>` — so it never even
    // collides with this project's key. It is refused on the role as well, and both matter: the
    // key alone would stop being enough the moment two scopes ever produced the same string.
    const run = harness.cp.runs.create({
      projectId: canonical.projectId,
      executionMode: ExecutionMode.STANDARD,
      contract: CONTRACT,
      repositories: [{ repositoryId: canonical.repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
    });
    if (!run.allowed) throw new Error(`run creation failed: ${run.message}`);
    const bootstrap = readySession(harness, "bootstrap-cto");
    expect(
      harness.cp.bindings.bind({
        role: Role.BOOTSTRAP_CTO,
        sessionId: bootstrap.sessionId,
        runId: run.value.runId,
      }).reasonCode,
    ).toBe(ReasonCode.OK);

    const stranger = readySession(harness, "other-project-cto");
    expect(
      harness.cp.bindings.bind({
        role: Role.PRIMARY_CTO,
        sessionId: stranger.sessionId,
        projectId: otherProjectId,
      }).reasonCode,
    ).toBe(ReasonCode.OK);

    const listeners = await startLocalMcpListeners(harness.cp, tempDir("acp-cto-wrong-"), TOKEN);
    const ctoSocket = listeners.socketPaths[1];
    if (!ctoSocket) throw new Error("the CTO MCP listener was not started");
    const bootstrapPeer = await connectPeer(ctoSocket, { token: TOKEN, ...bootstrap });
    const strangerPeer = await connectPeer(ctoSocket, { token: TOKEN, ...stranger });
    try {
      // Both connections are admitted by the socket — that is the socket's contract — and neither
      // may become the destination for the canonical CTO's mail. Waiting on the *other* project's
      // key first gives the daemon time to have attached, so this does not pass on a race.
      await until(
        () => listeners.ctoConversation.connected(otherKey),
        "the other project's CTO to attach under its own key",
      );

      expect(
        listeners.ctoConversation.connected(roleKey),
        "a bootstrap or wrong-project peer became the canonical CTO's destination",
      ).toBe(false);
      const refused = await listeners.ctoConversation.deliver(roleKey, "must not arrive");
      expect(refused.allowed).toBe(false);
      expect(refused.reasonCode).toBe(ReasonCode.ROLE_PEER_ABSENT);
      expect(bootstrapPeer.received, "the bootstrap CTO received the canonical CTO's mail").toEqual([]);
      expect(strangerPeer.received, "another project's CTO received this project's mail").toEqual([]);
    } finally {
      await bootstrapPeer.close();
      await strangerPeer.close();
      await listeners.close();
    }
  }, 60_000);

  it.each([
    { label: "bootstrap bound first", bootstrapFirst: true },
    { label: "bootstrap bound last", bootstrapFirst: false },
  ])(
    "reaches every project a single session is the CTO of, and none of them through the bootstrap binding ($label)",
    async ({ bootstrapFirst }) => {
      const harness = makeHarness();
      const a = await registerFixtureProject(harness, "project-a");
      const bManifest = fixtureManifest("project-b");
      const bProject = harness.cp.projects.register({
        projectId: "project-b",
        name: "fixture",
        manifest: bManifest,
        authorization: harness.cp.manifestAuthorizationForTests(bManifest),
      });
      if (!bProject.allowed) throw new Error(`second project failed: ${bProject.message}`);

      // One session, three live bindings — a legal state, not a contrived one. Socket admission
      // picks exactly one of them to admit the connection under, and which one it picks must not
      // decide which of this session's roles can be reached. The order is varied because the
      // choice admission makes is order-dependent.
      const session = readySession(harness, "multi-bound-cto");
      const run = harness.cp.runs.create({
        projectId: a.projectId,
        executionMode: ExecutionMode.STANDARD,
        contract: CONTRACT,
        repositories: [{ repositoryId: a.repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
      });
      if (!run.allowed) throw new Error(`run creation failed: ${run.message}`);
      const bindBootstrap = () =>
        expect(
          harness.cp.bindings.bind({
            role: Role.BOOTSTRAP_CTO,
            sessionId: session.sessionId,
            runId: run.value.runId,
          }).reasonCode,
        ).toBe(ReasonCode.OK);
      const bindPrimaries = () => {
        for (const projectId of [a.projectId, "project-b"]) {
          expect(
            harness.cp.bindings.bind({ role: Role.PRIMARY_CTO, sessionId: session.sessionId, projectId })
              .reasonCode,
          ).toBe(ReasonCode.OK);
        }
      };
      if (bootstrapFirst) {
        bindBootstrap();
        bindPrimaries();
      } else {
        bindPrimaries();
        bindBootstrap();
      }

      const keyA = roleKeyFor(Role.PRIMARY_CTO, { projectId: a.projectId });
      const keyB = roleKeyFor(Role.PRIMARY_CTO, { projectId: "project-b" });
      const bootstrapKey = roleKeyFor(Role.BOOTSTRAP_CTO, { runId: run.value.runId });

      const listeners = await startLocalMcpListeners(harness.cp, tempDir("acp-cto-multi-"), TOKEN);
      const ctoSocket = listeners.socketPaths[1];
      if (!ctoSocket) throw new Error("the CTO MCP listener was not started");
      const peer = await connectPeer(ctoSocket, { token: TOKEN, ...session });
      try {
        await until(
          () => listeners.ctoConversation.connected(keyA) && listeners.ctoConversation.connected(keyB),
          "both of the session's projects to have this connection as their peer",
        );
        // The bootstrap binding is not a primary destination, whichever order it was bound in.
        expect(
          listeners.ctoConversation.connected(bootstrapKey),
          "a bootstrap binding became a destination on the primary port",
        ).toBe(false);

        const toA = await listeners.ctoConversation.deliver(keyA, "for project A");
        if (!toA.allowed) throw new Error(`project A was unreachable: ${toA.message}`);
        const toB = await listeners.ctoConversation.deliver(keyB, "for project B");
        if (!toB.allowed) throw new Error(`project B was unreachable: ${toB.message}`);
        expect(peer.received).toEqual(["for project A", "for project B"]);
      } finally {
        await peer.close();
        await listeners.close();
      }
    },
    60_000,
  );

  it("does not let one session's connection hold the slot of a project another session is CTO of", async () => {
    const harness = makeHarness();
    const a = await registerFixtureProject(harness, "project-a");
    const bManifest = fixtureManifest("project-b");
    const bProject = harness.cp.projects.register({
      projectId: "project-b",
      name: "fixture",
      manifest: bManifest,
      authorization: harness.cp.manifestAuthorizationForTests(bManifest),
    });
    if (!bProject.allowed) throw new Error(`second project failed: ${bProject.message}`);

    // Two runtimes, one project each. The registry offers both bindings as candidates to every
    // connection — narrowing that list per-connection would put the rule in two places — so the
    // only thing keeping S1 out of B's slot is the holder check inside the port.
    const s1 = readySession(harness, "cto-of-a");
    const s2 = readySession(harness, "cto-of-b");
    expect(
      harness.cp.bindings.bind({ role: Role.PRIMARY_CTO, sessionId: s1.sessionId, projectId: a.projectId })
        .reasonCode,
    ).toBe(ReasonCode.OK);
    expect(
      harness.cp.bindings.bind({ role: Role.PRIMARY_CTO, sessionId: s2.sessionId, projectId: "project-b" })
        .reasonCode,
    ).toBe(ReasonCode.OK);

    const keyA = roleKeyFor(Role.PRIMARY_CTO, { projectId: a.projectId });
    const keyB = roleKeyFor(Role.PRIMARY_CTO, { projectId: "project-b" });

    const listeners = await startLocalMcpListeners(harness.cp, tempDir("acp-cto-wrong-session-"), TOKEN);
    const ctoSocket = listeners.socketPaths[1];
    if (!ctoSocket) throw new Error("the CTO MCP listener was not started");
    const peerOne = await connectPeer(ctoSocket, { token: TOKEN, ...s1 });
    try {
      await until(() => listeners.ctoConversation.connected(keyA), "S1 to hold its own project");
      expect(
        listeners.ctoConversation.connected(keyB),
        "a session took the slot of a project another session is the CTO of",
      ).toBe(false);
      const refused = await listeners.ctoConversation.deliver(keyB, "for project B only");
      expect(refused.allowed).toBe(false);
      expect(refused.reasonCode).toBe(ReasonCode.ROLE_PEER_ABSENT);
      expect(peerOne.received, "S1 received mail addressed to the CTO of project B").toEqual([]);

      // And B's own holder reaches it, so the refusal above is about who asked rather than about
      // the project being unreachable.
      const peerTwo = await connectPeer(ctoSocket, { token: TOKEN, ...s2 });
      try {
        await until(() => listeners.ctoConversation.connected(keyB), "S2 to hold its own project");
        const delivered = await listeners.ctoConversation.deliver(keyB, "for project B only");
        if (!delivered.allowed) throw new Error(`B's own holder was unreachable: ${delivered.message}`);
        expect(peerTwo.received).toEqual(["for project B only"]);
        expect(peerOne.received).toEqual([]);
      } finally {
        await peerTwo.close();
      }
    } finally {
      await peerOne.close();
      await listeners.close();
    }
  }, 60_000);

  it("stops delivering to a runtime the conversation has moved off, while its other role still arrives", async () => {
    const harness = makeHarness();
    const a = await registerFixtureProject(harness, "project-a");
    const bManifest = fixtureManifest("project-b");
    const bProject = harness.cp.projects.register({
      projectId: "project-b",
      name: "fixture",
      manifest: bManifest,
      authorization: harness.cp.manifestAuthorizationForTests(bManifest),
    });
    if (!bProject.allowed) throw new Error(`second project failed: ${bProject.message}`);

    const s1 = readySession(harness, "cto-before-failover");
    const s2 = readySession(harness, "cto-after-failover");
    for (const projectId of [a.projectId, "project-b"]) {
      expect(
        harness.cp.bindings.bind({ role: Role.PRIMARY_CTO, sessionId: s1.sessionId, projectId })
          .reasonCode,
      ).toBe(ReasonCode.OK);
    }
    const keyA = roleKeyFor(Role.PRIMARY_CTO, { projectId: a.projectId });
    const keyB = roleKeyFor(Role.PRIMARY_CTO, { projectId: "project-b" });

    const listeners = await startLocalMcpListeners(harness.cp, tempDir("acp-cto-survived-"), TOKEN);
    const ctoSocket = listeners.socketPaths[1];
    if (!ctoSocket) throw new Error("the CTO MCP listener was not started");
    const before = await connectPeer(ctoSocket, { token: TOKEN, ...s1 });
    try {
      await until(
        () => listeners.ctoConversation.connected(keyA) && listeners.ctoConversation.connected(keyB),
        "S1 to hold both of its projects",
      );

      // The conversation for project B survives onto another runtime. The assignment and its
      // generation do not change — only the actor's live session does — so nothing about the
      // binding's identity distinguishes before from after. What distinguishes them is which
      // runtime the registry now names, and the delivery predicate is the only reader of it.
      const moved = harness.cp.bindings.switchTo({
        role: Role.PRIMARY_CTO,
        projectId: "project-b",
        sessionId: s2.sessionId,
        conversation: "SURVIVED",
        reason: "failover for the delivery test",
      });
      if (!moved.allowed) throw new Error(`the runtime did not move: ${moved.message}`);
      expect(
        harness.cp.bindings.active(keyB)?.sessionId,
        "the registry did not move project B's runtime",
      ).toBe(s2.sessionId);

      const stale = await listeners.ctoConversation.deliver(keyB, "must not reach the old runtime");
      expect(stale.allowed).toBe(false);
      expect(stale.reasonCode).toBe(ReasonCode.ROLE_PEER_STALE);

      // The sibling binding is still valid and still on this connection, so the refusal above is
      // the delivery predicate deciding — not the connection having become ineligible.
      const toA = await listeners.ctoConversation.deliver(keyA, "still for project A");
      if (!toA.allowed) throw new Error(`the surviving sibling role was lost: ${toA.message}`);
      expect(before.received).toEqual(["still for project A"]);

      const after = await connectPeer(ctoSocket, { token: TOKEN, ...s2 });
      try {
        await until(() => listeners.ctoConversation.connected(keyB), "the new runtime to hold B");
        const toB = await listeners.ctoConversation.deliver(keyB, "for the new runtime");
        if (!toB.allowed) throw new Error(`the new runtime was unreachable: ${toB.message}`);
        expect(after.received).toEqual(["for the new runtime"]);
        expect(before.received, "the old runtime received B's mail").toEqual(["still for project A"]);
      } finally {
        await after.close();
      }
    } finally {
      await before.close();
      await listeners.close();
    }
  }, 60_000);

  it("keeps delivering to a sibling role after the binding the connection was admitted under moves away", async () => {
    const harness = makeHarness();
    const a = await registerFixtureProject(harness, "project-a");
    const bManifest = fixtureManifest("project-b");
    const bProject = harness.cp.projects.register({
      projectId: "project-b",
      name: "fixture",
      manifest: bManifest,
      authorization: harness.cp.manifestAuthorizationForTests(bManifest),
    });
    if (!bProject.allowed) throw new Error(`second project failed: ${bProject.message}`);

    const s1 = readySession(harness, "cto-before-failover");
    const s2 = readySession(harness, "cto-after-failover");
    for (const projectId of [a.projectId, "project-b"]) {
      expect(
        harness.cp.bindings.bind({ role: Role.PRIMARY_CTO, sessionId: s1.sessionId, projectId })
          .reasonCode,
      ).toBe(ReasonCode.OK);
    }
    const keyA = roleKeyFor(Role.PRIMARY_CTO, { projectId: a.projectId });
    const keyB = roleKeyFor(Role.PRIMARY_CTO, { projectId: "project-b" });

    const listeners = await startLocalMcpListeners(harness.cp, tempDir("acp-cto-admitted-moved-"), TOKEN);
    const ctoSocket = listeners.socketPaths[1];
    if (!ctoSocket) throw new Error("the CTO MCP listener was not started");
    const before = await connectPeer(ctoSocket, { token: TOKEN, ...s1 });
    try {
      await until(
        () => listeners.ctoConversation.connected(keyA) && listeners.ctoConversation.connected(keyB),
        "S1 to hold both of its projects",
      );

      // The inverse of the row above, and the half that a binding-scoped authenticator gets wrong.
      // Socket admission admitted this connection under *one* of S1's two bindings — project A,
      // the first candidate the registry offers. Moving that one away must not take the other with
      // it: S1 is still the exact current holder of project B, and B's mail is still S1's to
      // receive. Anything that re-checks the admitting binding at delivery time loses the sibling.
      const moved = harness.cp.bindings.switchTo({
        role: Role.PRIMARY_CTO,
        projectId: a.projectId,
        sessionId: s2.sessionId,
        conversation: "SURVIVED",
        reason: "failover of the admitting binding",
      });
      if (!moved.allowed) throw new Error(`the runtime did not move: ${moved.message}`);
      expect(
        harness.cp.bindings.active(keyA)?.sessionId,
        "the registry did not move project A's runtime",
      ).toBe(s2.sessionId);

      // A's own slot is refused, and refusing is what releases it — `connected(keyA)` answers for
      // the recorded slot, so without this the wait below would return on S1's stale entry and the
      // last delivery would measure eviction rather than S2's arrival.
      const stale = await listeners.ctoConversation.deliver(keyA, "must not reach the old runtime");
      expect(stale.allowed).toBe(false);
      expect(stale.reasonCode).toBe(ReasonCode.ROLE_PEER_STALE);

      const toB = await listeners.ctoConversation.deliver(keyB, "still for project B");
      if (!toB.allowed) throw new Error(`the surviving sibling role was lost: ${toB.message}`);
      expect(before.received).toEqual(["still for project B"]);

      const after = await connectPeer(ctoSocket, { token: TOKEN, ...s2 });
      try {
        await until(() => listeners.ctoConversation.connected(keyA), "the new runtime to hold A");
        const toA = await listeners.ctoConversation.deliver(keyA, "for the new runtime");
        if (!toA.allowed) throw new Error(`the new runtime was unreachable: ${toA.message}`);
        expect(after.received).toEqual(["for the new runtime"]);
        expect(before.received, "the old runtime received A's mail").toEqual(["still for project B"]);
      } finally {
        await after.close();
      }
    } finally {
      await before.close();
      await listeners.close();
    }
  }, 60_000);

  it("leaves no peer behind when the holder disconnects, and a late close does not detach its replacement", async () => {
    const harness = makeHarness();
    const { projectId } = await registerFixtureProject(harness);
    const session = readySession(harness, "cto-peer");
    expect(
      harness.cp.bindings.bind({ role: Role.PRIMARY_CTO, sessionId: session.sessionId, projectId })
        .reasonCode,
    ).toBe(ReasonCode.OK);
    const roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId });

    const listeners = await startLocalMcpListeners(harness.cp, tempDir("acp-cto-close-"), TOKEN);
    const ctoSocket = listeners.socketPaths[1];
    if (!ctoSocket) throw new Error("the CTO MCP listener was not started");
    const credential = { token: TOKEN, ...session };
    // Every peer this row opens is closed in the `finally`, on the failing path as much as the
    // passing one. `listeners.close()` waits on its live connections, so a row that fails with a
    // socket still open reports a 60s harness timeout instead of its own message — measured while
    // proving this row kills an unconditional detach.
    const opened: PeerHandle[] = [];
    const open = async (): Promise<PeerHandle> => {
      const peer = await connectPeer(ctoSocket, credential);
      opened.push(peer);
      return peer;
    };
    try {
      const first = await open();
      await until(() => listeners.ctoConversation.connected(roleKey), "the first peer to attach");
      await first.close();
      await until(
        () => !listeners.ctoConversation.connected(roleKey),
        "the disconnected peer to stop being the destination",
      );
      // Nothing is delivered into a socket that has gone: absence is reported as absence.
      const afterClose = await listeners.ctoConversation.deliver(roleKey, "into a closed socket");
      expect(afterClose.allowed).toBe(false);
      expect(afterClose.reasonCode).toBe(ReasonCode.ROLE_PEER_ABSENT);

      // Reconnect, then close the *replaced* connection last. Its detach must not clear the peer
      // that took its place — that would strand delivery on nobody while a live session is there.
      const replaced = await open();
      await until(() => listeners.ctoConversation.connected(roleKey), "the replaced peer to attach");
      const replacement = await open();
      // The ordering this row is about — replacement attached *before* the replaced connection
      // closes — has to be established, not hoped for. `startMcpSocket` runs its factory, and so
      // `attach`, before it awaits `mcp.connect(transport)`; the server therefore cannot answer
      // `initialize` on this socket until the replacement is already the recorded peer. A sleep
      // would only be a guess about scheduling, and would pass for the wrong reason on a slow run.
      await until(
        () => replacement.initialized(),
        "the replacement's initialize response, which the server can only send after its attach ran",
      );
      await replaced.close();

      const delivered = await listeners.ctoConversation.deliver(roleKey, "after the swap");
      if (!delivered.allowed) throw new Error(`the replacement peer was detached: ${delivered.message}`);
      expect(replacement.received).toEqual(["after the swap"]);
    } finally {
      for (const peer of opened) await peer.close();
      await listeners.close();
    }
  }, 60_000);
});
