import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ATTACH_EXIT, runAttachRelay, type ReattachPolicy, type SessionMessaging } from "../../src/cli/attach-relay.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { startLocalMcpListeners, type LocalMcpListeners } from "../../src/daemon/agentcpd.ts";
import { Role, SessionLifecycle } from "../../src/domain/types.ts";
import { RoleConversationPort, WAKE_TRANSPORT_QUALIFIED_CLIENTS } from "../../src/mcp/role-conversation.ts";
import { count } from "../helpers/adopted-ceo.ts";
import {
  canonicalCtoFixture,
  CLAUDE,
  CONVERSATION,
  CTO,
  PROJECT,
  type CanonicalCtoFixture,
} from "../helpers/canonical-cto-reattach.ts";
import { doorTap } from "../helpers/door-tap.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { fixtureManifest } from "../helpers/harness.ts";
import {
  LIST_CHANGED,
  recordingMcpClient,
  toolNames,
  type RecordedWire,
  type RecordingMcpClient,
} from "../helpers/recording-mcp-client.ts";

/**
 * A canonical CTO's relay carries its client across a daemon restart by replaying `initialize`,
 * `notifications/initialized` and the last wake registration on a new connection through the
 * reattach door, and only then stops answering the client's requests with "reattaching"
 * (src/cli/attach-relay.ts `restore`). The client never asks for the tool list again on its own, so
 * a restart onto a build with other tools leaves it holding the old list. The daemon tells it
 * `notifications/tools/list_changed`: every connection at `initialized`, whatever ids it uses, and
 * a connection the reattach door admitted again after each wake registration is answered.
 *
 * The client here records every notification and sends `tools/list` the moment it reads one. What
 * these cases measure is that client, the real relay and the real daemon listeners. Whether Claude
 * Code itself re-lists on the notification, or keeps working after a refresh the relay refused,
 * is a separate question this file does not answer.
 *
 * The daemon is the real listener pair and reattach door, closed and opened again on one state
 * directory the way a restart does. The relay is the real one: in this process (where the kernel
 * reports this process as the peer), or as a child process speaking over real pipes.
 */

const TOKEN = "fixture-mcp-token";
const MESSAGING_TOKEN = "fixture-messaging-token-4c1e";
const POLICY: Partial<ReattachPolicy> = { maxWaitMs: 8_000, initialDelayMs: 20, maxDelayMs: 100, attemptTimeoutMs: 3_000 };
const qualified = WAKE_TRANSPORT_QUALIFIED_CLIENTS[0]!;
const RELAY_REATTACHING_ERROR_CODE = -32001;

const MESSAGING_ENV = ["CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN"] as const;
const clearMessagingEnv = (): void => {
  for (const name of MESSAGING_ENV) delete process.env[name];
};
clearMessagingEnv();
beforeEach(clearMessagingEnv);

const until = async (condition: () => boolean, budgetMs = 10_000): Promise<boolean> => {
  for (const started = Date.now(); Date.now() - started < budgetMs;) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return condition();
};
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const roots: string[] = [];
const fixtures: CanonicalCtoFixture[] = [];
const closers: Array<() => Promise<void>> = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
  for (const close of closers.splice(0).reverse()) await close().catch(() => undefined);
  for (const made of fixtures.splice(0)) made.h.cp.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
afterAll(cleanupTempDirs);
afterEach(() => {
  vi.restoreAllMocks();
});

const listening = (path: string, onConnection: (socket: Socket) => void): Promise<Server> =>
  new Promise((resolve) => {
    const server = createServer(onConnection);
    server.listen(path, () => resolve(server));
  });
const closed = (server: Server): Promise<void> => new Promise((resolve) => server.close(() => resolve()));

/** A live canonical CTO binding, its daemon on a 0700 state directory, and the sockets beside it. */
const started = async (options: { tap?: boolean } = {}) => {
  const subject = canonicalCtoFixture();
  fixtures.push(subject);
  // The kernel reports this process as the peer of an in-process relay: it runs under the stated claude.
  subject.processes.set(process.pid, { ppid: CLAUDE, startedAt: "darwin-tv:1790000500.000005", argv: ["node"] });
  const dir = mkdtempSync("/tmp/acplc-");
  roots.push(dir);
  let current: LocalMcpListeners | null = null;
  const open = async (): Promise<void> => {
    current = await startLocalMcpListeners(subject.h.cp, dir, TOKEN);
    await current.openCanonicalCtoReattach(subject.reattach(), { lock: { held: () => true } });
  };
  const stop = async (): Promise<void> => {
    const closing = current;
    current = null;
    await closing?.close();
  };
  closers.push(stop);
  await open();
  const claims: string[] = [];
  const claimServer = await listening(join(dir, "c.sock"), (socket) => {
    socket.on("error", () => undefined);
    socket.once("data", (chunk: Buffer) => {
      claims.push(chunk.toString("utf8"));
      socket.end(`${JSON.stringify({ allowed: false, reasonCode: ReasonCode.BINDING_ALREADY_ACTIVE })}\n`);
    });
  });
  // The client's own wake endpoint, and the session's messaging socket a relay may proxy.
  const wakeSockets = new Set<Socket>();
  const wake = await listening(join(dir, "w.sock"), (socket) => {
    wakeSockets.add(socket);
    socket.on("error", () => undefined);
    socket.resume();
  });
  let wakeOpen = true;
  const closeWake = async (): Promise<void> => {
    if (!wakeOpen) return;
    wakeOpen = false;
    for (const socket of wakeSockets) socket.destroy();
    await closed(wake);
  };
  const session = await listening(join(dir, "client.sock"), (socket) => {
    socket.on("error", () => undefined);
    socket.resume();
  });
  const reattachPath = join(dir, "agentcpd.canonical-cto-tools.sock");
  const tap = options.tap ? await doorTap(join(dir, "tap.sock"), reattachPath) : null;
  closers.push(async () => {
    await tap?.close();
    await closed(claimServer);
    await closeWake();
    await closed(session);
  });
  return {
    subject,
    dir,
    claims,
    tap,
    closeWake,
    restart: async () => {
      await stop();
      await open();
    },
    endpoint: () => current?.ctoConversation.endpointFor(CTO) ?? null,
    wakeEndpoint: join(dir, "w.sock"),
    messaging: { socketPath: join(dir, "client.sock"), token: MESSAGING_TOKEN } satisfies SessionMessaging,
    paths: {
      claimPath: join(dir, "c.sock"),
      ctoPath: join(dir, "cto.mcp.sock"),
      reattachPath: tap ? join(dir, "tap.sock") : reattachPath,
    },
  };
};
type Started = Awaited<ReturnType<typeof started>>;

/** The binding, the runtime and the claims a restart must leave as they were. */
const tuple = (f: Started) => ({
  assignments: f.subject.h.cp.db.all(
    "SELECT assignment_id, binding_generation, status FROM assignments WHERE role_key = ? ORDER BY assignment_id",
    [CTO],
  ),
  sessions: f.subject.h.cp.db.all("SELECT session_id, incarnation, lifecycle FROM sessions ORDER BY session_id", []),
  sessionCount: count(f.subject.h, "SELECT COUNT(*) AS n FROM sessions"),
  claims: f.claims.length,
});

/** The real relay in this process, its stdout read by a recording client as if across a pipe. */
const inProcessRelay = (f: Started, messaging?: SessionMessaging) => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let errText = "";
  stderr.on("data", (chunk: Buffer) => {
    errText += chunk.toString("utf8");
  });
  const exit = runAttachRelay(
    {
      claimSocketPath: f.paths.claimPath,
      mcpSocketPath: f.paths.ctoPath,
      reattachSocketPath: f.paths.reattachPath,
      claim: { claimedSessionUuid: CONVERSATION, projectId: PROJECT, expectedBindingGeneration: 2 },
      reattach: POLICY,
      mcpToken: TOKEN,
      messaging,
    },
    { stdin, stdout, stderr },
  );
  const client = recordingMcpClient({ stdin, stdout }, { separateProcess: true });
  return {
    client,
    err: () => errText,
    finish: async () => {
      stdin.end();
      expect(await exit).toBe(ATTACH_EXIT.OK);
    },
  };
};

/** The answer to the tools/list the client sent on its `n`th list_changed, once it has one. */
const answerTo = (client: RecordingMcpClient, n: number): RecordedWire | undefined => {
  const position = client.listChanged()[n - 1];
  return client.refreshes.find((refresh) => refresh.notification === position)?.answer;
};

/** Waits for the `n`th list_changed and the answer to the tools/list the client sent on it. */
const refreshed = async (client: RecordingMcpClient, n: number, budgetMs = 10_000): Promise<RecordedWire> => {
  expect(await until(() => answerTo(client, n) !== undefined, budgetMs)).toBe(true);
  return answerTo(client, n)!;
};

const servesTheList = (answer: RecordedWire): void => {
  expect(answer.error).toBeUndefined();
  expect(toolNames(answer)).toContain("role_owner_message_claim");
};


/** Waits until exactly `n` list_changed have arrived and each tools/list they prompted is answered. */
const settled = async (client: RecordingMcpClient, n: number, budgetMs = 10_000): Promise<void> => {
  expect(await until(() => client.listChanged().length >= n && client.refreshes.length >= n, budgetMs)).toBe(true);
  await pause(250);
  expect(client.listChanged()).toHaveLength(n);
  expect(client.refreshes).toHaveLength(n);
};

const wakeRegistration = (endpoint: string) => ({ name: "role_wake_endpoint_register", arguments: { endpoint } });

/**
 * A client on the reattach door itself, not a relay: the door admits it because this process runs
 * under the stated claude, exactly as it admits an in-process relay.
 */
const reattachDoorClient = (f: Started) => {
  const socket = createConnection(f.paths.reattachPath);
  socket.on("error", () => undefined);
  closers.push(async () => {
    socket.destroy();
  });
  return recordingMcpClient({ stdin: socket, stdout: socket });
};

/** A PRIMARY_CTO of another project on `cto.mcp.sock`, admitted by its session secret. */
const secretDoorClient = async (f: Started) => {
  const { h } = f.subject;
  const projectId = "secret-door-project";
  const manifest = fixtureManifest(projectId);
  expect(h.cp.projects.register({ projectId, name: "fixture", manifest, authorization: h.cp.manifestAuthorizationForTests(manifest) }).allowed).toBe(true);
  const session = h.cp.sessions.create({ provider: "scripted", model: "secret-door-peer" });
  expect(h.cp.sessions.transition(session.sessionId, SessionLifecycle.READY).allowed).toBe(true);
  expect(h.cp.bindings.bind({ role: Role.PRIMARY_CTO, projectId, sessionId: session.sessionId }).allowed).toBe(true);
  const socket = createConnection(f.paths.ctoPath);
  socket.on("error", () => undefined);
  closers.push(async () => {
    socket.destroy();
  });
  await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
  socket.write(`${JSON.stringify({ token: TOKEN, sessionId: session.sessionId, sessionSecret: session.sessionSecret })}\n`);
  return recordingMcpClient({ stdin: socket, stdout: socket });
};

/**
 * The relay as the process Claude Code spawns, from this tree and from any other tree named in
 * ACP_COMPAT_RELAY_ROOT (an exported earlier build with this tree's node_modules), so a relay already
 * running in a live session can be measured against this daemon. argv[0] is `process.execPath`.
 */
const relayRoots = [
  { name: "this tree", root: process.cwd() },
  ...(process.env["ACP_COMPAT_RELAY_ROOT"] ? [{ name: "ACP_COMPAT_RELAY_ROOT", root: process.env["ACP_COMPAT_RELAY_ROOT"] }] : []),
];

const processRelay = (f: Started, root: string, messaging: boolean) => {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      join(root, "src", "cli", "agentctl.ts"),
      "attach",
      "canonical-cto",
      "--claimed-session-id",
      CONVERSATION,
      "--project-id",
      PROJECT,
      "--expected-binding-generation",
      "1",
    ],
    {
      cwd: root,
      env: {
        HOME: f.dir,
        PATH: process.env["PATH"] ?? "",
        TMPDIR: f.dir,
        ACP_CLAIM_CANONICAL_CTO_SOCKET: f.paths.claimPath,
        ACP_CTO_MCP_SOCKET: f.paths.ctoPath,
        ACP_CANONICAL_CTO_TOOL_SOCKET: f.paths.reattachPath,
        ...(messaging
          ? { CLAUDE_CODE_MESSAGING_SOCKET: f.messaging.socketPath, CLAUDE_CODE_MESSAGING_TOKEN: MESSAGING_TOKEN }
          : {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  children.push(child);
  // The kernel reports the child as the door's peer; it runs under the stated claude.
  f.subject.processes.set(child.pid!, { ppid: CLAUDE, startedAt: "darwin-tv:1790000600.000006", argv: ["node", "agentctl", "attach"] });
  let errText = "";
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (chunk: string) => {
    errText += chunk;
  });
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  const client = recordingMcpClient({ stdin: child.stdin!, stdout: child.stdout! }, { requestTimeoutMs: 30_000 });
  return {
    client,
    err: () => errText,
    finish: async () => {
      child.stdin!.end();
      expect(await exited).toBe(ATTACH_EXIT.OK);
    },
  };
};

/** Holds every wake registration the daemon answers until `release`, and says when one arrived. */
const withholdRegistrations = () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const held = { entered: false, release: () => release() };
  const original = RoleConversationPort.prototype.registerEndpoint;
  vi.spyOn(RoleConversationPort.prototype, "registerEndpoint").mockImplementation(async function (
    this: RoleConversationPort,
    server,
    endpoint,
  ) {
    held.entered = true;
    await gate;
    return original.call(this, server, endpoint);
  });
  return held;
};

describe("every connection is told at initialized, whatever ids it uses", () => {
  it("W1: a fresh relay connection with no wake proxy, once, and the tools/list sent on receipt is answered", async () => {
    const f = await started();
    const r = inProcessRelay(f);
    expect((await r.client.initialize(qualified)).error).toBeUndefined();
    servesTheList(await refreshed(r.client, 1));
    await settled(r.client, 1);
    await r.finish();
  });

  it("W1: a fresh relay connection with a wake proxy, at initialized and after the proxy's registration is answered", async () => {
    const f = await started();
    const r = inProcessRelay(f, f.messaging);
    expect((await r.client.initialize(qualified)).error).toBeUndefined();
    servesTheList(await refreshed(r.client, 1));
    servesTheList(await refreshed(r.client, 2));
    expect(f.endpoint()).not.toBeNull();
    await settled(r.client, 2);
    await r.finish();
  });

  it("a legal client whose initialize id is the relay's reinitialize shape is told, fresh and after a restart", async () => {
    // Review 1078-N1-01: deciding a replay by this id shape rather than by the door that admitted
    // the connection let a client that never registers a wake go without any notification.
    const f = await started();
    const r = inProcessRelay(f);
    expect((await r.client.initialize(qualified, "acp-relay-reinitialize-client-choice")).error).toBeUndefined();
    servesTheList(await refreshed(r.client, 1));
    await settled(r.client, 1);
    const before = tuple(f);

    await f.restart();
    servesTheList(await refreshed(r.client, 2));
    await settled(r.client, 2);
    expect(tuple(f)).toEqual(before);
    await r.finish();
  });

  it("on the session-secret door, relay-shaped ids neither withhold a notification nor add one, and grant nothing", async () => {
    const f = await started();
    const client = await secretDoorClient(f);
    const before = tuple(f);
    expect((await client.initialize(qualified, "acp-relay-reinitialize-spoof")).error).toBeUndefined();
    servesTheList(await refreshed(client, 1));
    for (const id of ["acp-relay-rewake-spoof", "acp-relay-wake-proxy-spoof"]) {
      const refused = await client.request("tools/call", wakeRegistration(join(f.dir, "missing.sock")), id);
      expect(refused.result?.structuredContent).toMatchObject({ ok: false });
    }
    await settled(client, 1);
    expect(f.endpoint()).toBeNull();
    expect(tuple(f)).toEqual(before);
    expect(before.claims).toBe(0);
  });

  it("on the reattach door, a notification follows each registration's answer whatever its id, and grants nothing", async () => {
    const f = await started();
    const before = tuple(f);
    const client = reattachDoorClient(f);
    expect((await client.initialize(qualified, "acp-relay-reinitialize-spoof")).error).toBeUndefined();
    servesTheList(await refreshed(client, 1));
    const ids: Array<string | number> = ["acp-relay-rewake-spoof", 41];
    for (const [index, id] of ids.entries()) {
      const refused = await client.request("tools/call", wakeRegistration(join(f.dir, "missing.sock")), id);
      expect(refused.result?.structuredContent).toMatchObject({ ok: false });
      servesTheList(await refreshed(client, index + 2));
    }
    await settled(client, 3);
    // A refused registration's notification is a refresh, not a wake: the role has no endpoint.
    expect(f.endpoint()).toBeNull();
    expect(tuple(f)).toEqual(before);
    expect(before.claims).toBe(0);
  });
});

describe("W2: a reattach that re-registers its wake endpoint", () => {
  it("the live setup (wake proxy): the notification after the re-registration's answer is answered, not refused", async () => {
    const f = await started();
    const r = inProcessRelay(f, f.messaging);
    expect((await r.client.initialize(qualified)).error).toBeUndefined();
    await refreshed(r.client, 2);
    expect(f.endpoint()).not.toBeNull();
    await settled(r.client, 2);
    const before = tuple(f);

    await f.restart();
    // At initialized, then after the replayed registration's answer; the first may meet a relay
    // still replaying (the withheld-registration controls below make that deterministic).
    const last = await refreshed(r.client, 4);
    expect(last.error?.code).not.toBe(RELAY_REATTACHING_ERROR_CODE);
    servesTheList(last);
    expect(f.endpoint()).not.toBeNull();
    await settled(r.client, 4);
    expect(tuple(f)).toEqual(before);
    expect(before.sessionCount).toBe(1);
    expect(before.claims).toBe(0);
    await r.finish();
  });

  it("after a refused re-registration, refreshes the list and records no wake endpoint", async () => {
    const f = await started();
    const r = inProcessRelay(f, f.messaging);
    expect((await r.client.initialize(qualified)).error).toBeUndefined();
    await refreshed(r.client, 2);
    // The client's own registration, which the relay keeps and replays in place of its proxy's.
    const registered = await r.client.request("tools/call", wakeRegistration(f.wakeEndpoint));
    expect(registered.result?.structuredContent).toMatchObject({ ok: true });
    await settled(r.client, 3);
    const before = tuple(f);

    // The endpoint is gone when the daemon returns, so the replayed registration is refused.
    await f.closeWake();
    await f.restart();
    servesTheList(await refreshed(r.client, 5));
    expect(r.err()).toContain("attach: wake re-registration refused");
    // The refresh is not a wake: the restarted daemon holds no endpoint for the role.
    expect(f.endpoint()).toBeNull();
    await settled(r.client, 5);
    expect(tuple(f)).toEqual(before);
    await r.finish();
  });

  it("with no proxy, the client's own registration replayed: the notification after its answer is served", async () => {
    const f = await started();
    const r = inProcessRelay(f);
    expect((await r.client.initialize(qualified)).error).toBeUndefined();
    await refreshed(r.client, 1);
    const registered = await r.client.request("tools/call", wakeRegistration(f.wakeEndpoint));
    expect(registered.result?.structuredContent).toMatchObject({ ok: true });
    await settled(r.client, 2);
    const before = tuple(f);

    await f.restart();
    servesTheList(await refreshed(r.client, 4));
    expect(f.endpoint()).toBe(f.wakeEndpoint);
    await settled(r.client, 4);
    expect(tuple(f)).toEqual(before);
    await r.finish();
  });
});

describe("W3: a reattach with no wake registration", () => {
  it("is told once the replay is in, and a tools/list sent on receipt is answered", async () => {
    const f = await started();
    const r = inProcessRelay(f);
    expect((await r.client.initialize(qualified)).error).toBeUndefined();
    await settled(r.client, 1);
    const before = tuple(f);

    await f.restart();
    servesTheList(await refreshed(r.client, 2));
    expect(f.endpoint()).toBeNull();
    await settled(r.client, 2);
    expect(tuple(f)).toEqual(before);
    await r.finish();
  });
});

describe("W4: on the door socket", () => {
  it("on a reattach, one list_changed follows initialized and the last follows the replayed registration's answer", async () => {
    const f = await started({ tap: true });
    const r = inProcessRelay(f, f.messaging);
    expect((await r.client.initialize(qualified)).error).toBeUndefined();
    await refreshed(r.client, 2);
    expect(f.endpoint()).not.toBeNull();

    await f.restart();
    await refreshed(r.client, 4);
    await settled(r.client, 4);
    const tap = f.tap!;
    const reattached = tap.connections() - 1;
    expect(reattached).toBeGreaterThan(0);
    const lines = tap.of(reattached);
    const sent = lines.filter((line) => line.direction === "toDaemon").map((line) => line.message);
    // The relay's replay, in order: initialize, initialized, the wake registration.
    expect(sent.slice(0, 3).map((message) => message["method"])).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/call",
    ]);
    expect((sent[2]!["params"] as { name?: string }).name).toBe("role_wake_endpoint_register");
    const wakeId = sent[2]!["id"];
    const initialized = lines.findIndex((line) => line.direction === "toDaemon" && line.message["method"] === "notifications/initialized");
    const answered = lines.findIndex((line) => line.direction === "fromDaemon" && line.message["id"] === wakeId);
    const told = lines.flatMap((line, index) =>
      line.direction === "fromDaemon" && line.message["method"] === LIST_CHANGED ? [index] : []);
    expect(answered).toBeGreaterThan(-1);
    expect(told).toHaveLength(2);
    expect(told[0]).toBeGreaterThan(initialized);
    expect(told[1]).toBeGreaterThan(answered);
    await r.finish();
  });

  it("on a fresh connection, list_changed leaves after initialized", async () => {
    const f = await started({ tap: true });
    const r = inProcessRelay(f);
    expect((await r.client.initialize(qualified)).error).toBeUndefined();
    await settled(r.client, 1);
    const lines = f.tap!.of(0);
    const initialized = lines.findIndex((line) => line.message["method"] === "notifications/initialized");
    const told = lines.findIndex((line) => line.message["method"] === LIST_CHANGED);
    expect(initialized).toBeGreaterThan(-1);
    expect(told).toBeGreaterThan(initialized);
    await r.finish();
  });
});

describe("a notification that cannot be sent", () => {
  it("is written to stderr, reaches no client, and the connection goes on answering", async () => {
    const f = await started();
    let rejectedSends = 0;
    const connect = McpServer.prototype.connect;
    vi.spyOn(McpServer.prototype, "connect").mockImplementation(async function (this: McpServer, transport) {
      const send = transport.send.bind(transport);
      transport.send = async (message, options) => {
        if ("method" in message && message.method === LIST_CHANGED) {
          rejectedSends += 1;
          throw new Error("fixture: the transport refused this send");
        }
        return send(message, options);
      };
      return connect.call(this, transport);
    });
    const diagnostics: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array, ...rest: never[]) => {
      if (typeof chunk === "string" && chunk.startsWith("cto tool list")) {
        diagnostics.push(chunk);
        return true;
      }
      return write(chunk, ...rest);
    }) as typeof process.stderr.write);
    const r = inProcessRelay(f);
    expect((await r.client.initialize(qualified)).error).toBeUndefined();
    expect(await until(() => diagnostics.length === 1)).toBe(true);
    // The line names no session, connection or error text.
    expect(diagnostics).toEqual(["cto tool list change notification not sent\n"]);
    expect((await r.client.request("acp/no-such-method", {})).error?.code).toBe(-32601);
    expect((await r.client.request("tools/call", {})).error).toBeDefined();
    servesTheList(await r.client.request("tools/list", {}));
    expect(rejectedSends).toBe(1);
    expect(r.client.listChanged()).toEqual([]);
    await r.finish();
  });
});

describe("the relay as a process, across a restart", () => {
  for (const { name, root } of relayRoots) {
    for (const proxied of [true, false]) {
      it(`${name}: the last notification after the reattach is answered (${proxied ? "W2, wake proxy" : "W3, no registration"})`, async () => {
        const f = await started();
        const r = processRelay(f, root, proxied);
        const init = await r.client.initialize(qualified);
        expect(init.error, r.err()).toBeUndefined();
        const fresh = proxied ? 2 : 1;
        servesTheList(await refreshed(r.client, fresh));
        if (proxied) expect(await until(() => f.endpoint() !== null)).toBe(true);
        await settled(r.client, fresh);
        const before = tuple(f);

        await f.restart();
        const last = await refreshed(r.client, fresh * 2, 30_000);
        expect(last.error?.code).not.toBe(RELAY_REATTACHING_ERROR_CODE);
        servesTheList(last);
        expect(f.endpoint() !== null).toBe(proxied);
        await settled(r.client, fresh * 2);
        expect(tuple(f)).toEqual(before);
        expect(before.claims).toBe(0);
        await r.finish();
      }, 60_000);
    }
  }
});

/**
 * Controls that hold the daemon's answer to the replayed registration until the relay's state has
 * been measured. While it is held the relay is still replaying, so a refresh sent then is refused;
 * the one that is served is the one after the answer.
 */
describe("withheld registration answers", () => {
  for (const { name, root } of relayRoots) {
    it(`${name}: a proxied replay's served notification is the one after the held registration is answered`, async () => {
      const f = await started();
      const r = processRelay(f, root, true);
      expect((await r.client.initialize(qualified)).error).toBeUndefined();
      await refreshed(r.client, 2);
      expect(await until(() => f.endpoint() !== null)).toBe(true);
      await settled(r.client, 2);
      const before = tuple(f);
      const held = withholdRegistrations();
      try {
        await f.restart();
        expect(await until(() => held.entered)).toBe(true);
        expect((await r.client.request("tools/list", {})).error?.code).toBe(RELAY_REATTACHING_ERROR_CODE);
        expect((await refreshed(r.client, 3)).error?.code).toBe(RELAY_REATTACHING_ERROR_CODE);
        await pause(250);
        expect(r.client.listChanged()).toHaveLength(3);
        held.release();
        servesTheList(await refreshed(r.client, 4));
        await settled(r.client, 4);
        expect(tuple(f)).toEqual(before);
        await r.finish();
      } finally {
        held.release();
      }
    }, 60_000);

    it(`${name}: no proxy, the client's own registration held: an early refused refresh, then a served one`, async () => {
      const f = await started();
      const r = processRelay(f, root, false);
      expect((await r.client.initialize(qualified)).error).toBeUndefined();
      await refreshed(r.client, 1);
      expect((await r.client.request("tools/call", wakeRegistration(f.wakeEndpoint))).result?.structuredContent)
        .toMatchObject({ ok: true });
      await settled(r.client, 2);
      const before = tuple(f);
      const held = withholdRegistrations();
      try {
        await f.restart();
        expect((await refreshed(r.client, 3)).error?.code).toBe(RELAY_REATTACHING_ERROR_CODE);
        held.release();
        servesTheList(await refreshed(r.client, 4));
        await settled(r.client, 4);
        expect(tuple(f)).toEqual(before);
        await r.finish();
      } finally {
        held.release();
      }
    }, 60_000);

    it(`${name}: a refused re-registration is followed by a served refresh, with no wake endpoint and no claim`, async () => {
      const f = await started();
      const r = processRelay(f, root, true);
      expect((await r.client.initialize(qualified)).error).toBeUndefined();
      await refreshed(r.client, 2);
      expect((await r.client.request("tools/call", wakeRegistration(f.wakeEndpoint))).result?.structuredContent)
        .toMatchObject({ ok: true });
      await settled(r.client, 3);
      const before = tuple(f);
      await f.closeWake();
      await f.restart();
      servesTheList(await refreshed(r.client, 5, 30_000));
      expect(r.err()).toContain("attach: wake re-registration refused");
      expect(f.endpoint()).toBeNull();
      await settled(r.client, 5);
      expect(tuple(f)).toEqual(before);
      expect(before.claims).toBe(0);
      await r.finish();
    }, 60_000);
  }
});
