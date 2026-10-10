import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { Server as McpProtocolServer } from "@modelcontextprotocol/sdk/server/index.js";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ATTACH_EXIT, runAttachRelay, type ReattachPolicy, type SessionMessaging } from "../../src/cli/attach-relay.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { startLocalMcpListeners, type LocalMcpListeners } from "../../src/daemon/agentcpd.ts";
import { WAKE_TRANSPORT_QUALIFIED_CLIENTS } from "../../src/mcp/role-conversation.ts";
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
import {
  LIST_CHANGED,
  recordingMcpClient,
  toolNames,
  type RecordedWire,
  type RecordingMcpClient,
} from "../helpers/recording-mcp-client.ts";

/**
 * A canonical CTO's relay carries its client across a daemon restart by replaying `initialize`,
 * `notifications/initialized` and the last wake registration on the new connection, and only then
 * stops answering the client's requests with "reattaching" (src/cli/attach-relay.ts `restore`). The
 * client never asks for the tool list again on its own, so a restart onto a build with other tools
 * leaves it holding the old list. The daemon now tells it `notifications/tools/list_changed`, and
 * these cases measure that the client can act on it: the client here records every notification
 * and sends `tools/list` the moment it reads one.
 *
 * What this measures is the recording client. Whether Claude Code itself re-lists on the
 * notification is a separate question this file does not answer.
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

describe("W1: a fresh connection is told its tool list changed once it is initialized", () => {
  for (const proxied of [false, true]) {
    it(`and a tools/list sent on receipt is answered (${proxied ? "with" : "without"} a wake proxy)`, async () => {
      const f = await started();
      const r = inProcessRelay(f, proxied ? f.messaging : undefined);
      expect((await r.client.initialize(qualified)).error).toBeUndefined();
      servesTheList(await refreshed(r.client, 1));
      await pause(200);
      expect(r.client.listChanged()).toHaveLength(1);
      await r.finish();
    });
  }
});

describe("W2: a reattach that re-registers its wake endpoint", () => {
  it("tells the client after the re-registration, and a tools/list sent on receipt is answered, not refused", async () => {
    // The live setup: the relay's wake proxy listens, so the relay re-registers it before going live.
    const f = await started();
    const r = inProcessRelay(f, f.messaging);
    expect((await r.client.initialize(qualified)).error).toBeUndefined();
    await refreshed(r.client, 1);
    expect(await until(() => f.endpoint() !== null)).toBe(true);
    const before = tuple(f);

    await f.restart();
    const answer = await refreshed(r.client, 2);
    expect(answer.error?.code).not.toBe(RELAY_REATTACHING_ERROR_CODE);
    servesTheList(answer);
    expect(f.endpoint()).not.toBeNull();
    await pause(200);
    // One for the fresh connection and one for the reattach: nothing early to be refused.
    expect(r.client.listChanged()).toHaveLength(2);
    expect([answerTo(r.client, 1)?.error, answerTo(r.client, 2)?.error]).toEqual([undefined, undefined]);
    expect(tuple(f)).toEqual(before);
    expect(before.sessionCount).toBe(1);
    expect(before.claims).toBe(0);
    await r.finish();
  });

  it("after a refused re-registration, refreshes the list and records no wake endpoint", async () => {
    const f = await started();
    const r = inProcessRelay(f, f.messaging);
    expect((await r.client.initialize(qualified)).error).toBeUndefined();
    await refreshed(r.client, 1);
    // The client's own registration, which the relay keeps and replays in place of its proxy's.
    const registered = await r.client.request("tools/call", {
      name: "role_wake_endpoint_register",
      arguments: { endpoint: f.wakeEndpoint },
    });
    expect(registered.result?.structuredContent).toMatchObject({ ok: true });
    const before = tuple(f);

    // The endpoint is gone when the daemon returns, so the replayed registration is refused.
    await f.closeWake();
    await f.restart();
    servesTheList(await refreshed(r.client, 2));
    expect(r.err()).toContain("attach: wake re-registration refused");
    // The refresh is not a wake: the restarted daemon holds no endpoint for the role.
    expect(f.endpoint()).toBeNull();
    await pause(200);
    expect(r.client.listChanged()).toHaveLength(2);
    expect(tuple(f)).toEqual(before);
    await r.finish();
  });

  it("with no proxy, the client's own registration replayed: the last notification follows it and is served", async () => {
    // A relay with no proxy replays the client's own bytes, so the daemon cannot tell this replay
    // from a fresh connection at `initialized`; it tells the client then, and again once the
    // relay's re-registration is answered.
    const f = await started();
    const r = inProcessRelay(f);
    expect((await r.client.initialize(qualified)).error).toBeUndefined();
    await refreshed(r.client, 1);
    const registered = await r.client.request("tools/call", {
      name: "role_wake_endpoint_register",
      arguments: { endpoint: f.wakeEndpoint },
    });
    expect(registered.result?.structuredContent).toMatchObject({ ok: true });
    const before = tuple(f);

    await f.restart();
    servesTheList(await refreshed(r.client, 3));
    expect(f.endpoint()).toBe(f.wakeEndpoint);
    await pause(200);
    expect(r.client.listChanged()).toHaveLength(3);
    expect(tuple(f)).toEqual(before);
    await r.finish();
  });
});

describe("W3: a reattach with no wake registration", () => {
  it("tells the client once the replay is in, and a tools/list sent on receipt is answered", async () => {
    const f = await started();
    const r = inProcessRelay(f);
    expect((await r.client.initialize(qualified)).error).toBeUndefined();
    await refreshed(r.client, 1);
    const before = tuple(f);

    await f.restart();
    servesTheList(await refreshed(r.client, 2));
    expect(f.endpoint()).toBeNull();
    await pause(200);
    expect(r.client.listChanged()).toHaveLength(2);
    expect(tuple(f)).toEqual(before);
    await r.finish();
  });
});

describe("W4: on the door socket", () => {
  it("list_changed leaves after the answer to the replayed wake registration, and only then", async () => {
    const f = await started({ tap: true });
    const r = inProcessRelay(f, f.messaging);
    expect((await r.client.initialize(qualified)).error).toBeUndefined();
    await refreshed(r.client, 1);
    expect(await until(() => f.endpoint() !== null)).toBe(true);

    await f.restart();
    await refreshed(r.client, 2);
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
    const wakeId = sent[2]!["id"];
    expect((sent[2]!["params"] as { name?: string }).name).toBe("role_wake_endpoint_register");
    const answered = lines.findIndex((line) => line.direction === "fromDaemon" && line.message["id"] === wakeId);
    const told = lines.flatMap((line, index) =>
      line.direction === "fromDaemon" && line.message["method"] === LIST_CHANGED ? [index] : []);
    expect(answered).toBeGreaterThan(-1);
    expect(told).toHaveLength(1);
    expect(told[0]).toBeGreaterThan(answered);
    await r.finish();
  });

  it("on a fresh connection, list_changed leaves after initialized", async () => {
    const f = await started({ tap: true });
    const r = inProcessRelay(f);
    expect((await r.client.initialize(qualified)).error).toBeUndefined();
    await refreshed(r.client, 1);
    const lines = f.tap!.of(0);
    const initialized = lines.findIndex((line) => line.message["method"] === "notifications/initialized");
    const told = lines.findIndex((line) => line.message["method"] === LIST_CHANGED);
    expect(initialized).toBeGreaterThan(-1);
    expect(told).toBeGreaterThan(initialized);
    await r.finish();
  });
});

describe("a notification that cannot be sent", () => {
  it("is written to stderr, reaches no client, and the connection serves on", async () => {
    const f = await started();
    vi.spyOn(McpProtocolServer.prototype, "sendToolListChanged").mockRejectedValue(new Error("fixture: send failed"));
    const diagnostics: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array, ...rest: never[]) => {
      if (typeof chunk === "string" && chunk.startsWith("cto tool list")) {
        diagnostics.push(chunk);
        return true;
      }
      return write(chunk, ...rest);
    }) as typeof process.stderr.write);
    const r = inProcessRelay(f, f.messaging);
    expect((await r.client.initialize(qualified)).error).toBeUndefined();
    expect(await until(() => diagnostics.length === 1)).toBe(true);
    expect(diagnostics).toEqual(["cto tool list change notification not sent\n"]);
    // The line names no session, connection or error text.
    servesTheList(await r.client.request("tools/list", {}));
    expect(r.client.listChanged()).toEqual([]);
    await r.finish();
  });
});

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

describe("the relay as a process, across a restart", () => {
  for (const { name, root } of relayRoots) {
    for (const proxied of [true, false]) {
      it(`${name}: told on the fresh connection and again after the reattach, each answered (${proxied ? "W2, wake proxy" : "W3, no registration"})`, async () => {
        const f = await started();
        const r = processRelay(f, root, proxied);
        const init = await r.client.initialize(qualified);
        expect(init.error, r.err()).toBeUndefined();
        servesTheList(await refreshed(r.client, 1));
        if (proxied) expect(await until(() => f.endpoint() !== null)).toBe(true);
        const before = tuple(f);

        await f.restart();
        const answer = await refreshed(r.client, 2, 30_000);
        expect(answer.error?.code).not.toBe(RELAY_REATTACHING_ERROR_CODE);
        servesTheList(answer);
        expect(f.endpoint() !== null).toBe(proxied);
        await pause(300);
        expect(r.client.listChanged()).toHaveLength(2);
        expect(tuple(f)).toEqual(before);
        expect(before.claims).toBe(0);
        await r.finish();
      }, 60_000);
    }
  }
});
