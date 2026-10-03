import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import type * as NodeFs from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { basename, dirname, join } from "node:path";
import { PassThrough } from "node:stream";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ATTACH_EXIT,
  RELAY_REATTACHING_ERROR,
  runAttachRelay,
  runAttachRelayCommand,
  type ReattachPolicy,
  type SessionMessaging,
} from "../../src/cli/attach-relay.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { startLocalMcpListeners, type LocalMcpListeners } from "../../src/daemon/agentcpd.ts";
import { ROLE_WAKE_FRAME, WAKE_TRANSPORT_QUALIFIED_CLIENTS } from "../../src/mcp/role-conversation.ts";
import {
  canonicalCtoFixture,
  CLAUDE,
  CONVERSATION,
  CTO,
  PROJECT,
  type CanonicalCtoFixture,
} from "../helpers/canonical-cto-reattach.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";

/**
 * The canonical CTO relay as the session's wake proxy.
 *
 * Claude Code 2.1.283 holds a message from a sender that attests no permission mode, for the
 * owner's approval, when the receiving session bypasses permission prompts. The daemon's wake is
 * such a message, so a wake written straight to the session's messaging socket stopped starting a
 * turn (measured 2026-10-03 on two canonical CTO sessions). The session delivers without holding
 * what its own child sends after the auth line carrying `CLAUDE_CODE_MESSAGING_TOKEN`, and the relay
 * is that child: it listens on a proxy of its own, has the daemon wake the proxy, and forwards the
 * one constant frame behind the auth line.
 *
 * The daemon here is the real listener pair, reattach door, wake registry and wake client, run
 * in-process so the kernel reports this test process as the reattaching peer; the process tree
 * above it is stated. The session's messaging socket is a stand-in that keeps every connection's
 * bytes. The messaging token is a synthetic constant.
 */

const TOKEN = "fixture-mcp-token";
const MESSAGING_TOKEN = "fixture-messaging-token-7f3a9c41d2";
const POLICY: Partial<ReattachPolicy> = { maxWaitMs: 5_000, initialDelayMs: 20, maxDelayMs: 100, attemptTimeoutMs: 2_000 };
const FAST: Partial<ReattachPolicy> = { maxWaitMs: 3_000, initialDelayMs: 5, maxDelayMs: 50, attemptTimeoutMs: 200 };
const qualified = WAKE_TRANSPORT_QUALIFIED_CLIENTS[0]!;
const STAND_IN_TUPLE = { assignmentId: "stand-in-assignment", bindingGeneration: 1, sessionId: "stand-in-session", sessionIncarnation: "stand-in-incarnation" };
const PROXY_NAME = /^acp-wake-proxy-[0-9a-f]{16}\.sock$/;
const AUTHENTICATED_WAKE = `${JSON.stringify({ type: "auth", token: MESSAGING_TOKEN })}\n${ROLE_WAKE_FRAME}`;

/**
 * The relay reads the session's messaging socket and token from its environment, and a test run
 * from inside a Claude Code session inherits that session's real ones. No relay here may see them:
 * a proxy would open beside the real session's socket and a wake would reach the real session.
 */
const MESSAGING_ENV = ["CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN"] as const;
const clearMessagingEnv = (): void => {
  for (const name of MESSAGING_ENV) delete process.env[name];
};
clearMessagingEnv();
beforeEach(clearMessagingEnv);

/**
 * A socket another user owns cannot be made without root, and a name swapped between two looks
 * cannot be timed, so `lstatSync` reports them: a path in `foreignOwned` reads as owned by the next
 * uid, to the relay and to the daemon alike; a path in `swappedEveryLook` reads as another inode at
 * each look; every other path reads as it is. Both empty unless a case fills them.
 */
const forged = vi.hoisted(() => ({ foreignOwned: new Set<string>(), swappedEveryLook: new Set<string>(), looks: 0 }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  const lstatSync = ((path: string, options?: never) => {
    const stats = actual.lstatSync(path, options);
    if (stats === undefined) return stats;
    const overrides: PropertyDescriptorMap = {};
    if (forged.foreignOwned.has(String(path))) overrides["uid"] = { value: stats.uid + 1 };
    if (forged.swappedEveryLook.has(String(path))) {
      forged.looks += 1;
      overrides["ino"] = { value: stats.ino + forged.looks };
    }
    if (Object.keys(overrides).length === 0) return stats;
    return Object.create(stats, overrides) as typeof stats;
  }) as typeof actual.lstatSync;
  return { ...actual, lstatSync, default: { ...actual, lstatSync } };
});
afterEach(() => {
  forged.foreignOwned.clear();
  forged.swappedEveryLook.clear();
});

interface Wire {
  id?: unknown;
  result?: { structuredContent?: Record<string, unknown> };
  error?: { code?: number; message?: string };
}

const settles = async (exit: Promise<number>, budgetMs = 10_000): Promise<number | "did-not-settle"> => {
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<"did-not-settle">((resolve) => {
    timer = setTimeout(() => resolve("did-not-settle"), budgetMs);
  });
  try {
    return await Promise.race([exit, guard]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const until = async (condition: () => boolean, budgetMs = 5_000): Promise<boolean> => {
  for (const started = Date.now(); Date.now() - started < budgetMs;) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return condition();
};

const pauseFor = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const listen = (server: Server, path: string): Promise<void> =>
  new Promise<void>((resolve) => server.listen(path, resolve));

const roots: string[] = [];
const fixtures: CanonicalCtoFixture[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close().catch(() => undefined);
  for (const made of fixtures.splice(0)) made.h.cp.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  clearMessagingEnv();
});
afterAll(cleanupTempDirs);

/** A messaging socket that keeps each connection's bytes once the sender ends it. */
const recordingSocket = async (path: string) => {
  const received: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    let bytes = "";
    socket.on("data", (chunk: Buffer) => {
      bytes += chunk.toString("utf8");
    });
    socket.once("end", () => received.push(bytes));
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
  });
  await listen(server, path);
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  closers.push(close);
  return { path, received, close };
};

/** A daemon's listeners on one state directory, which a test can stop and start again. */
const daemonOn = async (subject: CanonicalCtoFixture, dir: string) => {
  let current: LocalMcpListeners | null = null;
  const open = async (): Promise<LocalMcpListeners> => {
    current = await startLocalMcpListeners(subject.h.cp, dir, TOKEN);
    await current.openCanonicalCtoReattach(subject.reattach(), { lock: { held: () => true } });
    return current;
  };
  const stop = async (): Promise<void> => {
    const closing = current;
    current = null;
    await closing?.close();
  };
  closers.push(stop);
  await open();
  const live = (): LocalMcpListeners => {
    if (current === null) throw new Error("the daemon is stopped");
    return current;
  };
  return { open, stop, live, endpoint: () => current?.ctoConversation.endpointFor(CTO) ?? null };
};

/** A live canonical CTO binding, its daemon on a 0700 state directory, and the session's socket in it. */
const started = async () => {
  const subject = canonicalCtoFixture();
  fixtures.push(subject);
  // The kernel will report this process as the peer: it runs under the stated claude.
  subject.processes.set(process.pid, { ppid: CLAUDE, startedAt: "darwin-tv:1790000500.000005", argv: ["node"] });
  const dir = mkdtempSync("/tmp/acpwp-");
  roots.push(dir);
  const daemon = await daemonOn(subject, dir);
  const claims: string[] = [];
  const claimServer: Server = createServer((socket) => {
    socket.on("error", () => undefined);
    socket.once("data", (chunk: Buffer) => {
      claims.push(chunk.toString("utf8"));
      socket.end(`${JSON.stringify({ allowed: false, reasonCode: ReasonCode.BINDING_ALREADY_ACTIVE })}\n`);
    });
  });
  const claimPath = join(dir, "c.sock");
  await listen(claimServer, claimPath);
  closers.push(() => new Promise<void>((resolve) => claimServer.close(() => resolve())));
  const session = await recordingSocket(join(dir, "client.sock"));
  return {
    subject,
    daemon,
    dir,
    claims,
    session,
    messaging: { socketPath: session.path, token: MESSAGING_TOKEN } satisfies SessionMessaging,
    paths: {
      claimPath,
      ctoPath: join(dir, "cto.mcp.sock"),
      reattachPath: join(dir, "agentcpd.canonical-cto-tools.sock"),
    },
  };
};

const proxiesIn = (dir: string): string[] => readdirSync(dir).filter((name) => PROXY_NAME.test(name));

/**
 * The relay, in-process. `messaging` is handed to `runAttachRelay`; the `command` entry instead
 * reads it from the environment, as `agentctl attach canonical-cto` does.
 */
const relay = (
  paths: { claimPath: string; ctoPath: string; reattachPath: string },
  drive: { messaging?: SessionMessaging; entry?: "relay" | "command"; policy?: Partial<ReattachPolicy> } = {},
) => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let errText = "";
  let outText = "";
  let pendingText = "";
  let nextId = 1;
  /** Keyed by the id's JSON, so a string id is told from a number with the same digits. */
  const pending = new Map<string, (message: Wire) => void>();
  const received: Wire[] = [];
  stdout.on("data", (chunk: Buffer) => {
    outText += chunk.toString("utf8");
    pendingText += chunk.toString("utf8");
    for (let newline = pendingText.indexOf("\n"); newline >= 0; newline = pendingText.indexOf("\n")) {
      const message = JSON.parse(pendingText.slice(0, newline)) as Wire;
      pendingText = pendingText.slice(newline + 1);
      received.push(message);
      if (message.id !== undefined) pending.get(JSON.stringify(message.id))?.(message);
    }
  });
  stderr.on("data", (chunk: Buffer) => {
    errText += chunk.toString("utf8");
  });
  const common = {
    claimSocketPath: paths.claimPath,
    mcpSocketPath: paths.ctoPath,
    reattachSocketPath: paths.reattachPath,
    claim: { claimedSessionUuid: CONVERSATION, projectId: PROJECT, expectedBindingGeneration: 2 },
    reattach: drive.policy ?? POLICY,
  };
  const exit = drive.entry === "command"
    ? runAttachRelayCommand(common, { stdin, stdout, stderr })
    : runAttachRelay({ ...common, mcpToken: TOKEN, messaging: drive.messaging }, { stdin, stdout, stderr });
  /** A request under an id the caller names: a string id is as valid a JSON-RPC id as a number. */
  const requestAs = (id: string | number, method: string, params: unknown) =>
    new Promise<Wire>((resolve, reject) => {
      const key = JSON.stringify(id);
      const timer = setTimeout(() => reject(new Error(`timeout awaiting ${method}`)), 10_000);
      pending.set(key, (message) => {
        clearTimeout(timer);
        pending.delete(key);
        resolve(message);
      });
      stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  const request = (method: string, params: unknown) => requestAs(nextId++, method, params);
  const r = {
    exit,
    stdin,
    err: () => errText,
    out: () => outText,
    /** Every message the client was sent, in order. */
    received: () => received,
    request,
    requestAs,
    /** `initialize` with a qualified build, then `notifications/initialized`, as Claude Code starts. */
    initialized: async () => {
      const init = await request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: qualified });
      expect(init.error).toBeUndefined();
      stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    },
    register: (endpoint: string) => request("tools/call", { name: "role_wake_endpoint_register", arguments: { endpoint } }),
    finish: async () => {
      stdin.end();
      expect(await settles(exit)).toBe(ATTACH_EXIT.OK);
    },
  };
  return r;
};

/** Writes `bytes` to `path` and ends, then waits for the far side to close; a reset is a close. */
const sendTo = (path: string, bytes: string, end = true): Promise<void> =>
  new Promise<void>((resolve) => {
    const socket = createConnection(path);
    socket.on("error", () => undefined);
    socket.once("close", () => resolve());
    socket.once("connect", () => {
      if (end) socket.end(bytes);
      else socket.write(bytes);
    });
  });

/**
 * The daemon wakes on every registration it accepts (`registerEndpoint`), so the relay's own
 * registration of its proxy is already one wake through it. Waits for that one, checks it, and
 * clears the record, so the case after it counts only its own.
 */
const proxyRegistered = async (
  f: Awaited<ReturnType<typeof started>>,
): Promise<string> => {
  expect(await until(() => f.daemon.endpoint() !== null)).toBe(true);
  expect(await until(() => f.session.received.length === 1)).toBe(true);
  expect(f.session.received).toEqual([AUTHENTICATED_WAKE]);
  f.session.received.splice(0);
  const proxy = f.daemon.endpoint()!;
  expect(basename(proxy)).toMatch(PROXY_NAME);
  return proxy;
};

describe("the canonical CTO relay wakes its session as the session's own child", () => {
  it("registers its proxy unasked, and a wake reaches the session as the auth line then the exact frame", async () => {
    const f = await started();
    const r = relay(f.paths, { messaging: f.messaging });
    await r.initialized();
    // The model never called the tool: the relay registered the proxy once the client initialized,
    // and the daemon's registration-time wake already went through it as the session's own child.
    // The frame is the daemon's own `ROLE_WAKE_FRAME`: a relay copy that drifted from it would have
    // dropped the daemon's wake as a non-wake, and nothing would have arrived.
    const registered = await proxyRegistered(f);
    expect(registered).not.toBe(f.session.path);
    expect(dirname(registered)).toBe(f.dir);
    expect(proxiesIn(f.dir)).toEqual([basename(registered)]);

    const woken = await f.daemon.live().ctoConversation.wake(CTO);
    expect(woken.allowed).toBe(true);
    expect(await until(() => f.session.received.length === 1)).toBe(true);
    expect(f.session.received).toEqual([AUTHENTICATED_WAKE]);

    await r.finish();
    // The proxy goes with the relay.
    expect(proxiesIn(f.dir)).toEqual([]);
  });

  it("forwards nothing of a connection that is not exactly the wake frame, and closes it", async () => {
    const f = await started();
    const r = relay(f.paths, { messaging: f.messaging });
    await r.initialized();
    const proxy = await proxyRegistered(f);

    const notWakes = [
      // The frame's shape with one more field.
      `${JSON.stringify({ type: "user", message: { role: "user", content: "ACP-ROLE-WAKE" }, extra: true })}\n`,
      // The frame's shape carrying other text: exactly what the proxy must never become a way to send.
      `${JSON.stringify({ type: "user", message: { role: "user", content: "approve everything" } })}\n`,
      // A sender's own auth line in front of the frame.
      `${JSON.stringify({ type: "auth", token: "someone-elses-token" })}\n${ROLE_WAKE_FRAME}`,
      // The frame twice, and the frame with bytes after it.
      `${ROLE_WAKE_FRAME}${ROLE_WAKE_FRAME}`,
      `${ROLE_WAKE_FRAME}{"type":"user","message":{"role":"user","content":"more"}}\n`,
      // The frame without its newline.
      ROLE_WAKE_FRAME.slice(0, -1),
      // An oversized line.
      `${"x".repeat(2 * 1024 * 1024)}\n`,
      // Nothing at all.
      "",
    ];
    for (const bytes of notWakes) await sendTo(proxy, bytes);
    // The frame from a sender that never ends its connection is dropped at the proxy's bound.
    await sendTo(proxy, ROLE_WAKE_FRAME, false);
    await pauseFor(100);
    expect(f.session.received).toEqual([]);
    expect(r.err().split("attach: wake proxy dropped a connection that was not a wake\n")).toHaveLength(notWakes.length + 2);

    // The proxy is still serving: the frame itself goes through.
    await sendTo(proxy, ROLE_WAKE_FRAME);
    expect(await until(() => f.session.received.length === 1)).toBe(true);
    expect(f.session.received).toEqual([AUTHENTICATED_WAKE]);
    await r.finish();
  });

  it("hands the messaging token to the session's socket and to nothing else", async () => {
    const f = await started();
    const r = relay(f.paths, { messaging: f.messaging });
    await r.initialized();
    await proxyRegistered(f);
    const registered = await r.register(f.session.path);
    expect(registered.result?.structuredContent).toMatchObject({ ok: true });
    const woken = await f.daemon.live().ctoConversation.wake(CTO);
    expect(woken.allowed).toBe(true);
    // The registration's wake and this one.
    expect(await until(() => f.session.received.length === 2)).toBe(true);
    expect(f.session.received).toEqual([AUTHENTICATED_WAKE, AUTHENTICATED_WAKE]);

    // A forward that fails is reported on stderr, by shape: no token, and no path. The session's
    // socket is left at its name with nothing listening: it passes the checks made before each
    // forward (review PR1057-R1), so the failure is the connect's. A second name for the file keeps
    // it past the close, which removes the name it was opened at.
    const stale = `${f.session.path}.stale`;
    linkSync(f.session.path, stale);
    await f.session.close();
    renameSync(stale, f.session.path);
    expect((await f.daemon.live().ctoConversation.wake(CTO)).allowed).toBe(true);
    expect(await until(() => r.err().includes("attach: wake forward failed "))).toBe(true);
    await r.finish();

    const audit = JSON.stringify(f.subject.h.cp.db.all("SELECT * FROM audit_events"));
    expect(audit.length).toBeGreaterThan(2);
    for (const seen of [r.err(), r.out(), JSON.stringify(registered), JSON.stringify(woken), audit]) {
      expect(seen).not.toContain(MESSAGING_TOKEN);
    }
    expect(r.err()).not.toContain(f.dir);
  });

  it("points the session's registration of its own messaging socket at the proxy", async () => {
    const f = await started();
    const r = relay(f.paths, { messaging: f.messaging });
    await r.initialized();
    const proxy = await proxyRegistered(f);
    const registered = await r.register(f.session.path);
    expect(registered.error).toBeUndefined();
    expect(registered.result?.structuredContent).toMatchObject({ ok: true });
    expect(f.daemon.endpoint()).toBe(proxy);
    // The registration's own wake went through the proxy, not straight to the session.
    expect(await until(() => f.session.received.length === 1)).toBe(true);
    expect(f.session.received).toEqual([AUTHENTICATED_WAKE]);
    await r.finish();
  });

  it("passes a registration of any other path through unchanged, and still forwards only to the session", async () => {
    const f = await started();
    const other = await recordingSocket(join(f.dir, "other.sock"));
    const r = relay(f.paths, { messaging: f.messaging });
    await r.initialized();
    const proxy = await proxyRegistered(f);

    // Another path is the client's to register, and the daemon's to accept or refuse.
    expect((await r.register(other.path)).result?.structuredContent).toMatchObject({ ok: true });
    expect(f.daemon.endpoint()).toBe(other.path);
    expect(await until(() => other.received.length === 1)).toBe(true);
    // Written by the daemon straight to that path: the bare frame, with no auth line in front.
    expect(other.received).toEqual([ROLE_WAKE_FRAME]);
    await pauseFor(100);
    expect(f.session.received).toEqual([]);

    // The session's own socket comes back to the same proxy.
    expect((await r.register(f.session.path)).result?.structuredContent).toMatchObject({ ok: true });
    expect(f.daemon.endpoint()).toBe(proxy);
    expect(await until(() => f.session.received.length === 1)).toBe(true);
    expect(f.session.received).toEqual([AUTHENTICATED_WAKE]);
    expect(other.received).toEqual([ROLE_WAKE_FRAME]);
    await r.finish();
  });

  it("replays the proxy, not the session's socket, to a restarted daemon", async () => {
    const f = await started();
    const r = relay(f.paths, { messaging: f.messaging });
    await r.initialized();
    const proxy = await proxyRegistered(f);
    expect((await r.register(f.session.path)).result?.structuredContent).toMatchObject({ ok: true });
    expect(await until(() => f.session.received.length === 1)).toBe(true);
    f.session.received.splice(0);

    await f.daemon.stop();
    await f.daemon.open();
    expect(await until(() => f.daemon.endpoint() !== null)).toBe(true);
    expect(f.daemon.endpoint()).toBe(proxy);
    // The replayed registration's wake, through the proxy.
    expect(await until(() => f.session.received.length === 1)).toBe(true);
    expect(f.session.received).toEqual([AUTHENTICATED_WAKE]);
    expect(f.claims).toEqual([]);
    await r.finish();
  });

  it("replays the proxy it registered unasked to a restarted daemon", async () => {
    const f = await started();
    const r = relay(f.paths, { messaging: f.messaging });
    await r.initialized();
    const proxy = await proxyRegistered(f);

    await f.daemon.stop();
    await f.daemon.open();
    expect(await until(() => f.daemon.endpoint() !== null)).toBe(true);
    expect(f.daemon.endpoint()).toBe(proxy);
    expect(await until(() => f.session.received.length === 1)).toBe(true);
    expect(f.session.received).toEqual([AUTHENTICATED_WAKE]);
    await r.finish();
  });

  it("registers the proxy in the restore when the daemon went away before answering the first registration", async () => {
    // A stand-in daemon behind the reattach door: it answers `initialize`, leaves the first
    // connection's registration unanswered and drops that connection, then accepts on the next.
    const dir = mkdtempSync("/tmp/acpwq-");
    roots.push(dir);
    const session = await recordingSocket(join(dir, "client.sock"));
    const door = join(dir, "door.sock");
    const connections: Socket[] = [];
    const registrations: Array<{ connection: number; endpoint: unknown }> = [];
    const server = createServer((socket) => {
      socket.on("error", () => undefined);
      const index = connections.length;
      connections.push(socket);
      socket.write(`${JSON.stringify({ ok: true, reasonCode: ReasonCode.OK, admitted: STAND_IN_TUPLE })}\n`);
      let held = "";
      socket.on("data", (chunk: Buffer) => {
        held += chunk.toString("utf8");
        for (let newline = held.indexOf("\n"); newline >= 0; newline = held.indexOf("\n")) {
          const line = JSON.parse(held.slice(0, newline)) as { id?: unknown; method?: string; params?: { name?: string; arguments?: { endpoint?: unknown } } };
          held = held.slice(newline + 1);
          if (line.method === "initialize") {
            socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: line.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "stand-in", version: "1" } } })}\n`);
          }
          if (line.method === "tools/call" && line.params?.name === "role_wake_endpoint_register") {
            registrations.push({ connection: index, endpoint: line.params.arguments?.endpoint });
            if (index === 0) {
              socket.destroy();
              return;
            }
            socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: line.id, result: { structuredContent: { ok: true } } })}\n`);
          }
        }
      });
    });
    await listen(server, door);
    closers.push(async () => {
      for (const socket of connections) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    const r = relay(
      { claimPath: join(dir, "absent.sock"), ctoPath: join(dir, "absent.sock"), reattachPath: door },
      { messaging: { socketPath: session.path, token: MESSAGING_TOKEN }, policy: FAST },
    );
    await r.initialized();
    expect(await until(() => registrations.length === 2)).toBe(true);
    const [lost, restored] = registrations;
    expect(lost!.connection).toBe(0);
    expect(restored!.connection).toBe(1);
    expect(basename(String(restored!.endpoint))).toMatch(PROXY_NAME);
    expect(restored!.endpoint).toBe(lost!.endpoint);
    expect(dirname(String(restored!.endpoint))).toBe(dir);
    await r.finish();
  });

  it("opens the proxy only when the environment names both the session's socket and its token", async () => {
    const f = await started();
    const cases: Array<{ env: Partial<Record<(typeof MESSAGING_ENV)[number], string>>; proxied: boolean }> = [
      { env: {}, proxied: false },
      { env: { CLAUDE_CODE_MESSAGING_SOCKET: f.session.path }, proxied: false },
      { env: { CLAUDE_CODE_MESSAGING_TOKEN: MESSAGING_TOKEN }, proxied: false },
      { env: { CLAUDE_CODE_MESSAGING_SOCKET: f.session.path, CLAUDE_CODE_MESSAGING_TOKEN: MESSAGING_TOKEN }, proxied: true },
    ];
    for (const { env, proxied } of cases) {
      clearMessagingEnv();
      Object.assign(process.env, env);
      const r = relay(f.paths, { entry: "command" });
      await r.initialized();
      if (proxied) await proxyRegistered(f);
      // The registration's own wake is the one counted.
      expect((await r.register(f.session.path)).result?.structuredContent).toMatchObject({ ok: true });
      expect(await until(() => f.session.received.length === 1)).toBe(true);
      if (proxied) {
        expect(basename(f.daemon.endpoint() ?? "")).toMatch(PROXY_NAME);
        expect(f.session.received).toEqual([AUTHENTICATED_WAKE]);
      } else {
        // As before the proxy: the session's socket is registered as given and woken directly.
        expect(f.daemon.endpoint()).toBe(f.session.path);
        expect(proxiesIn(f.dir)).toEqual([]);
        expect(f.session.received).toEqual([ROLE_WAKE_FRAME]);
        expect(r.err()).toBe("");
      }
      f.session.received.splice(0);
      await r.finish();
    }
    expect(f.claims).toEqual([]);
  });

  it("opens no proxy beside a messaging socket whose directory the daemon would refuse", async () => {
    const f = await started();
    // The session's socket in a directory other users can enter: no endpoint there can register.
    const open = join(f.dir, "open");
    mkdirSync(open);
    chmodSync(open, 0o755);
    const session = await recordingSocket(join(open, "client.sock"));
    const r = relay(f.paths, { messaging: { socketPath: session.path, token: MESSAGING_TOKEN } });
    await r.initialized();
    expect(await until(() => r.err().includes("attach: wake proxy not opened"))).toBe(true);
    expect(r.err()).toBe("attach: wake proxy not opened directory-not-owner-only\n");
    expect(readdirSync(open).filter((name) => PROXY_NAME.test(name))).toEqual([]);
    expect(proxiesIn(f.dir)).toEqual([]);
    // The registration leaves unchanged, and the daemon refuses it as it always did.
    const refused = await r.register(session.path);
    expect(refused.result?.structuredContent).toMatchObject({ ok: false, reasonCode: ReasonCode.ROLE_PEER_UNSUPPORTED });
    expect(f.daemon.endpoint()).toBeNull();
    await r.finish();
  });
});

/**
 * Review PR1057-R1. The daemon validates the endpoint it is given, and with the proxy that is the
 * proxy, never the session's socket the authenticated forward connects to. So the relay applies the
 * daemon's own checks to that socket — not a symlink, a socket, owned by this uid, in an owner-only
 * directory of this uid's — before it opens the proxy and again before each forward, and a target
 * that fails them is sent nothing: no auth line, no frame.
 */
describe("the wake proxy forwards only to a messaging socket the daemon itself would wake (review PR1057-R1)", () => {
  it("opens no proxy for a messaging socket the daemon would refuse, and hands it no token", async () => {
    const f = await started();
    const elsewhere = mkdtempSync("/tmp/acpwx-");
    roots.push(elsewhere);
    const decoy = await recordingSocket(join(elsewhere, "decoy.sock"));
    const linked = join(f.dir, "linked.sock");
    symlinkSync(decoy.path, linked);
    const plain = join(f.dir, "plain.sock");
    writeFileSync(plain, "");
    const foreign = await recordingSocket(join(f.dir, "foreign.sock"));
    forged.foreignOwned.add(foreign.path);
    const cases = [
      // A name in the right directory that leads to a socket somewhere else.
      { target: linked, check: "endpoint-is-symlink" },
      { target: plain, check: "endpoint-not-a-socket" },
      { target: foreign.path, check: "endpoint-owner-mismatch" },
    ];
    for (const { target, check } of cases) {
      const r = relay(f.paths, { messaging: { socketPath: target, token: MESSAGING_TOKEN } });
      await r.initialized();
      await until(() => r.err() !== "" || decoy.received.length + foreign.received.length > 0);
      expect(decoy.received).toEqual([]);
      expect(foreign.received).toEqual([]);
      expect(r.err()).toBe(`attach: wake proxy not opened ${check}\n`);
      expect(proxiesIn(f.dir)).toEqual([]);
      // The registration leaves as it arrived, and the daemon refuses it as it always did.
      const refused = await r.register(target);
      expect(refused.result?.structuredContent).toMatchObject({ ok: false, reasonCode: ReasonCode.ROLE_PEER_UNSUPPORTED });
      expect(f.daemon.endpoint()).toBeNull();
      await r.finish();
    }
    await pauseFor(100);
    expect(decoy.received).toEqual([]);
    expect(foreign.received).toEqual([]);
    expect(f.session.received).toEqual([]);
  });

  it("forwards nothing once the session's socket is replaced by a symlink after registration, and forwards again once it is back", async () => {
    const f = await started();
    const elsewhere = mkdtempSync("/tmp/acpwx-");
    roots.push(elsewhere);
    const decoy = await recordingSocket(join(elsewhere, "decoy.sock"));
    const r = relay(f.paths, { messaging: f.messaging });
    await r.initialized();
    await proxyRegistered(f);

    // The proxy the daemon validates is unchanged; the name its forward connects to now leads elsewhere.
    rmSync(f.session.path);
    symlinkSync(decoy.path, f.session.path);
    expect((await f.daemon.live().ctoConversation.wake(CTO)).allowed).toBe(true);
    await until(() => r.err() !== "" || decoy.received.length > 0);
    expect(decoy.received).toEqual([]);
    expect(r.err()).toBe("attach: wake forward refused endpoint-is-symlink\n");

    // Refused per forward, not for good: the session's own socket back at its name is woken again.
    rmSync(f.session.path);
    const back = await recordingSocket(f.session.path);
    expect((await f.daemon.live().ctoConversation.wake(CTO)).allowed).toBe(true);
    expect(await until(() => back.received.length === 1)).toBe(true);
    expect(back.received).toEqual([AUTHENTICATED_WAKE]);
    expect(decoy.received).toEqual([]);
    await r.finish();
    expect(r.err()).not.toContain(MESSAGING_TOKEN);
  });

  it("forwards nothing to a session socket another user owns by the time of the wake", async () => {
    const f = await started();
    const r = relay(f.paths, { messaging: f.messaging });
    await r.initialized();
    await proxyRegistered(f);

    forged.foreignOwned.add(f.session.path);
    expect((await f.daemon.live().ctoConversation.wake(CTO)).allowed).toBe(true);
    await until(() => r.err() !== "" || f.session.received.length > 0);
    expect(f.session.received).toEqual([]);
    expect(r.err()).toBe("attach: wake forward refused endpoint-owner-mismatch\n");

    forged.foreignOwned.delete(f.session.path);
    expect((await f.daemon.live().ctoConversation.wake(CTO)).allowed).toBe(true);
    expect(await until(() => f.session.received.length === 1)).toBe(true);
    expect(f.session.received).toEqual([AUTHENTICATED_WAKE]);
    await r.finish();
  });

  it("writes no token when the name is another file after the connect than it was before it", async () => {
    const f = await started();
    const r = relay(f.paths, { messaging: f.messaging });
    await r.initialized();
    await proxyRegistered(f);

    // Each look passes every check, and each finds another inode: the look before the connect and
    // the look after it disagree about which file the connection reached.
    forged.swappedEveryLook.add(f.session.path);
    expect((await f.daemon.live().ctoConversation.wake(CTO)).allowed).toBe(true);
    await until(() => r.err() !== "" || f.session.received.some((bytes) => bytes !== ""));
    expect(f.session.received.filter((bytes) => bytes !== "")).toEqual([]);
    expect(r.err()).toBe("attach: wake forward refused endpoint-replaced\n");
    await r.finish();
  });
});

/** A request line as the stand-in daemon below reads it. */
interface StandInLine {
  id?: unknown;
  method?: string;
  params?: { name?: string; requestId?: unknown; arguments?: { endpoint?: unknown } };
}

/**
 * A stand-in daemon behind the reattach door that answers `initialize` at once and holds every other
 * request until the case answers it, so the case decides the order answers arrive in.
 */
const holdingDoor = async (dir: string) => {
  const path = join(dir, "door.sock");
  const sockets: Socket[] = [];
  const held: Array<{ line: StandInLine; socket: Socket }> = [];
  const notifications: StandInLine[] = [];
  const server = createServer((socket) => {
    socket.on("error", () => undefined);
    sockets.push(socket);
    socket.write(`${JSON.stringify({ ok: true, reasonCode: ReasonCode.OK, admitted: STAND_IN_TUPLE })}\n`);
    let text = "";
    socket.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
      for (let newline = text.indexOf("\n"); newline >= 0; newline = text.indexOf("\n")) {
        const line = JSON.parse(text.slice(0, newline)) as StandInLine;
        text = text.slice(newline + 1);
        if (line.method === "initialize") {
          socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: line.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "stand-in", version: "1" } } })}\n`);
        } else if (line.id === undefined) {
          notifications.push(line);
        } else {
          held.push({ line, socket });
        }
      }
    });
  });
  await listen(server, path);
  closers.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const answer = (entry: { line: StandInLine; socket: Socket }, result: unknown): void => {
    entry.socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: entry.line.id, result })}\n`);
  };
  return { path, held, notifications, answer };
};

const isRegistration = (entry: { line: StandInLine }): boolean =>
  entry.line.method === "tools/call" && entry.line.params?.name === "role_wake_endpoint_register";

/** The id the relay gave its own registration of the proxy at ca341789: a valid string id for a client too. */
const OLD_GENERATED_ID = "acp-relay-wake-proxy-1";
const CLIENT_RESULT = { content: [{ type: "text", text: "the client's own answer" }] };
const REGISTERED = { structuredContent: { ok: true } };

/** A relay behind `holdingDoor`, with a session socket for its proxy, that has registered the proxy and not been answered. */
const heldRegistration = async (policy: Partial<ReattachPolicy>) => {
  const dir = mkdtempSync("/tmp/acpwr-");
  roots.push(dir);
  const session = await recordingSocket(join(dir, "client.sock"));
  const door = await holdingDoor(dir);
  const r = relay(
    { claimPath: join(dir, "absent.sock"), ctoPath: join(dir, "absent.sock"), reattachPath: door.path },
    { messaging: { socketPath: session.path, token: MESSAGING_TOKEN }, policy },
  );
  await r.initialized();
  expect(await until(() => door.held.some(isRegistration))).toBe(true);
  return { door, r, registration: door.held.find(isRegistration)! };
};

/**
 * Review PR1057-R2. The relay's own requests and the client's share one connection to the daemon,
 * so they must not share one id space: a client id equal to an id the relay generated would have its
 * answer taken by the relay, and the relay's answer handed to the client as the client's.
 */
describe("the relay's own requests cannot take a client's answer (review PR1057-R2)", () => {
  for (const order of ["the client's answer first", "the registration's answer first"] as const) {
    it(`answers a client request whose id is the relay's old registration id with its own answer (${order})`, async () => {
      const { door, r, registration } = await heldRegistration(POLICY);
      const answered = r.requestAs(OLD_GENERATED_ID, "tools/call", { name: "fixture_tool", arguments: {} });
      expect(await until(() => door.held.length === 2)).toBe(true);
      const client = door.held.find((entry) => !isRegistration(entry))!;

      if (order === "the client's answer first") {
        door.answer(client, CLIENT_RESULT);
        await pauseFor(50);
        door.answer(registration, REGISTERED);
      } else {
        door.answer(registration, REGISTERED);
        await pauseFor(50);
        door.answer(client, CLIENT_RESULT);
      }
      expect((await answered).result).toEqual(CLIENT_RESULT);
      await pauseFor(100);
      // One answer under that id, the client's own; the registration's answer reached the client under no id.
      expect(r.received().filter((message) => message.id === OLD_GENERATED_ID)).toEqual([
        { jsonrpc: "2.0", id: OLD_GENERATED_ID, result: CLIENT_RESULT },
      ]);
      expect(r.out()).not.toContain("structuredContent");
      // The relay took its own answer as its own: no refusal reported.
      expect(r.err()).toBe("");
      // And the daemon never had two requests outstanding under one id.
      expect(new Set(door.held.map((entry) => JSON.stringify(entry.line.id))).size).toBe(door.held.length);
      await r.finish();
    });
  }

  it("does not hand a client the late answer to a registration the relay stopped waiting for", async () => {
    const { door, r, registration } = await heldRegistration(FAST);
    const answered = r.requestAs(OLD_GENERATED_ID, "tools/call", { name: "fixture_tool", arguments: {} });
    expect(await until(() => door.held.length === 2)).toBe(true);
    const client = door.held.find((entry) => !isRegistration(entry))!;
    // Past the relay's bound on its own request (FAST.attemptTimeoutMs), then the late answer.
    await pauseFor(400);
    door.answer(registration, REGISTERED);
    await pauseFor(50);
    door.answer(client, CLIENT_RESULT);
    expect((await answered).result).toEqual(CLIENT_RESULT);
    await pauseFor(100);
    expect(r.received().filter((message) => message.id === OLD_GENERATED_ID)).toHaveLength(1);
    expect(r.out()).not.toContain("structuredContent");
    await r.finish();
  });

  it("cancels a client request upstream under the id it was sent under, and forwards no cancel of a request not in flight", async () => {
    const { door, r, registration } = await heldRegistration(POLICY);
    void r.requestAs(OLD_GENERATED_ID, "tools/call", { name: "fixture_tool", arguments: {} }).catch(() => undefined);
    expect(await until(() => door.held.length === 2)).toBe(true);
    const client = door.held.find((entry) => !isRegistration(entry))!;
    const cancel = (requestId: unknown): string =>
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId, reason: "fixture" } })}\n`;
    r.stdin.write(cancel(OLD_GENERATED_ID));
    r.stdin.write(cancel("never-sent"));
    await pauseFor(200);
    const cancels = door.notifications.filter((line) => line.method === "notifications/cancelled");
    // The client's cancel names its own request as the daemon knows it, never the relay's registration.
    expect(cancels.map((line) => line.params?.requestId)).toEqual([client.line.id]);
    expect(JSON.stringify(client.line.id)).not.toBe(JSON.stringify(registration.line.id));
    door.answer(registration, REGISTERED);
    door.answer(client, CLIENT_RESULT);
    await r.finish();
  });
});

/**
 * Review PR1057-R3. The id renaming PR1057-R2 added keeps the relay's own requests apart from the
 * client's, and the relay sends a request of its own on a live link only once its proxy listens.
 * Without one — no messaging in the environment, only half of it, or a socket the proxy may not
 * forward to — the relay is the byte pipe it was before the proxy existed: every line in either
 * direction passes exactly as it arrived, under the client's own ids, a cancel included, and a
 * restore replays the client's `initialize` as the client sent it.
 *
 * Every frame below is spaced as `JSON.stringify` never spaces it, and one carries a `\u` escape it
 * would decode, so a line the relay parsed and wrote again cannot pass for the line it was given.
 */
const SPACED = {
  initialize: `{ "jsonrpc": "2.0", "id": "init-1", "method": "initialize", "params": { "protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name":"fixture-client","version":"1"} } }`,
  initialized: `{"jsonrpc" : "2.0", "method" : "notifications/initialized"}`,
  list: `{  "id":"client-42",  "jsonrpc":"2.0", "method":"tools/list" , "params":{} }`,
  held: `{"jsonrpc":"2.0","id":"held-7","method":"tools/call","params":{ "name":"fixture_slow","arguments":{} }}`,
  cancel: `{ "jsonrpc":"2.0", "method":"notifications/cancelled", "params":{ "requestId":"held-7", "reason":"caf\\u00e9" } }`,
  strayCancel: `{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":"never-sent" , "reason":"fixture"}}`,
  afterRestore: `{"jsonrpc":"2.0", "method":"tools/list", "id":"after-restore-3"}`,
  stray: `{ "jsonrpc":"2.0", "id":"stray-9", "result":{ } }`,
} as const;

/** The stand-in daemon's answer to a request, spaced as no serializer spaces it, under the id it was sent. */
const spacedAnswer = (id: unknown, method: string): string =>
  `{ "jsonrpc" : "2.0" ,  "id" : ${JSON.stringify(id)} , "result" : { "answered" : ${JSON.stringify(method)} } }`;

/**
 * A stand-in daemon behind the reattach door that keeps each connection's bytes exactly as they
 * arrived and answers every request at once with `spacedAnswer`, but a `tools/call` of `fixture_slow`,
 * which it never answers.
 */
const recordingDoor = async (dir: string) => {
  const path = join(dir, "door.sock");
  const connections: Array<{ socket: Socket; raw: string }> = [];
  const server = createServer((socket) => {
    socket.on("error", () => undefined);
    const connection = { socket, raw: "" };
    connections.push(connection);
    socket.write(`${JSON.stringify({ ok: true, reasonCode: ReasonCode.OK, admitted: STAND_IN_TUPLE })}\n`);
    let text = "";
    socket.on("data", (chunk: Buffer) => {
      connection.raw += chunk.toString("utf8");
      text += chunk.toString("utf8");
      for (let newline = text.indexOf("\n"); newline >= 0; newline = text.indexOf("\n")) {
        const line = JSON.parse(text.slice(0, newline)) as StandInLine;
        text = text.slice(newline + 1);
        if (line.id === undefined || line.method === undefined) continue;
        if (line.method === "tools/call" && line.params?.name === "fixture_slow") continue;
        socket.write(`${spacedAnswer(line.id, line.method)}\n`);
      }
    });
  });
  await listen(server, path);
  closers.push(async () => {
    for (const { socket } of connections) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { path, connections };
};

const lines = (...frames: string[]): string => frames.map((frame) => `${frame}\n`).join("");

type MessagingVariable = (typeof MESSAGING_ENV)[number];

/** How a case leaves the relay without a proxy: what it hands the relay, or what the environment holds. */
interface Unproxied {
  name: string;
  /** Set: run through `runAttachRelayCommand`, which reads the environment. Unset: `runAttachRelay`. */
  env?: (sessionPath: string) => Partial<Record<MessagingVariable, string>>;
  /** For `runAttachRelay`: the messaging it is handed, given the session's socket in a directory it may not use. */
  messaging?: (sessionPath: string, openSessionPath: string) => SessionMessaging | undefined;
  stderr: string;
}

const UNPROXIED: Unproxied[] = [
  { name: "no messaging is handed to the relay", messaging: () => undefined, stderr: "" },
  { name: "the environment holds neither messaging variable", env: () => ({}), stderr: "" },
  {
    name: "the environment holds the session's socket and no token",
    env: (sessionPath) => ({ CLAUDE_CODE_MESSAGING_SOCKET: sessionPath }),
    stderr: "",
  },
  {
    name: "the environment holds the token and no session socket",
    env: () => ({ CLAUDE_CODE_MESSAGING_TOKEN: MESSAGING_TOKEN }),
    stderr: "",
  },
  {
    name: "the environment holds the session's socket and an empty token",
    env: (sessionPath) => ({ CLAUDE_CODE_MESSAGING_SOCKET: sessionPath, CLAUDE_CODE_MESSAGING_TOKEN: "" }),
    stderr: "",
  },
  {
    name: "the environment holds the token and an empty session socket",
    env: () => ({ CLAUDE_CODE_MESSAGING_SOCKET: "", CLAUDE_CODE_MESSAGING_TOKEN: MESSAGING_TOKEN }),
    stderr: "",
  },
  {
    name: "the session's socket is in a directory the daemon would refuse, so no proxy opens",
    messaging: (_sessionPath, openSessionPath) => ({ socketPath: openSessionPath, token: MESSAGING_TOKEN }),
    stderr: "attach: wake proxy not opened directory-not-owner-only\n",
  },
];

describe("with no wake proxy the relay changes no byte in either direction (review PR1057-R3)", () => {
  for (const unproxied of UNPROXIED) {
    it(`passes every line through exactly as it arrived when ${unproxied.name}`, async () => {
      const dir = mkdtempSync("/tmp/acpwn-");
      roots.push(dir);
      const session = await recordingSocket(join(dir, "client.sock"));
      const open = join(dir, "open");
      mkdirSync(open);
      chmodSync(open, 0o755);
      const openSession = await recordingSocket(join(open, "client.sock"));
      const door = await recordingDoor(dir);
      const paths = { claimPath: join(dir, "absent.sock"), ctoPath: join(dir, "absent.sock"), reattachPath: door.path };
      if (unproxied.env !== undefined) Object.assign(process.env, unproxied.env(session.path));
      const r = unproxied.env !== undefined
        ? relay(paths, { entry: "command" })
        : relay(paths, { messaging: unproxied.messaging?.(session.path, openSession.path) });

      r.stdin.write(lines(SPACED.initialize, SPACED.initialized, SPACED.list, SPACED.held, SPACED.cancel, SPACED.strayCancel));
      expect(await until(() => r.received().some((message) => message.id === "client-42"))).toBe(true);
      await pauseFor(100);
      // Soft, so each direction and the restore is judged on its own when one of them changes a byte.
      // Client to daemon: each line as the client wrote it, the request ids its own, both cancels sent.
      expect.soft(door.connections[0]!.raw).toBe(
        lines(SPACED.initialize, SPACED.initialized, SPACED.list, SPACED.held, SPACED.cancel, SPACED.strayCancel),
      );

      // Daemon to client: an answer to no request of the client's passes as well, as it always did.
      door.connections[0]!.socket.write(`${SPACED.stray}\n`);
      expect.soft(await until(() => r.received().some((message) => message.id === "stray-9"), 1_000)).toBe(true);

      // A restarted daemon is given the client's `initialize` as the client sent it, and then its
      // `notifications/initialized`, before anything else.
      door.connections[0]!.socket.destroy();
      expect(await until(() => (door.connections[1]?.raw ?? "").includes("notifications/initialized"))).toBe(true);
      r.stdin.write(lines(SPACED.afterRestore));
      expect(await until(() => r.received().some((message) => message.id === "after-restore-3"))).toBe(true);
      expect.soft(door.connections[1]!.raw).toBe(lines(SPACED.initialize, SPACED.initialized, SPACED.afterRestore));

      // Every answer reached the client as the daemon wrote it; the one line of the relay's own is
      // its report that the held request's outcome is unknown, under that request's own id.
      expect.soft(r.out()).toBe(lines(
        spacedAnswer("init-1", "initialize"),
        spacedAnswer("client-42", "tools/list"),
        SPACED.stray,
        JSON.stringify({
          jsonrpc: "2.0",
          id: "held-7",
          error: {
            code: RELAY_REATTACHING_ERROR,
            message: "the agent-control-plane connection closed before this request was answered; its outcome is unknown",
          },
        }),
        spacedAnswer("after-restore-3", "tools/list"),
      ));
      expect.soft(r.err()).toBe(unproxied.stderr);
      expect(door.connections).toHaveLength(2);
      // And no proxy: nothing opened beside either socket, and neither was sent a byte.
      expect(proxiesIn(dir)).toEqual([]);
      expect(readdirSync(open).filter((name) => PROXY_NAME.test(name))).toEqual([]);
      expect(session.received).toEqual([]);
      expect(openSession.received).toEqual([]);
      await r.finish();
    });
  }

  it("answers and cancels a request sent before the proxy opened under the client's own id, and counts the relay's ids past it", async () => {
    const dir = mkdtempSync("/tmp/acpwt-");
    roots.push(dir);
    const session = await recordingSocket(join(dir, "client.sock"));
    const door = await holdingDoor(dir);
    const r = relay(
      { claimPath: join(dir, "absent.sock"), ctoPath: join(dir, "absent.sock"), reattachPath: door.path },
      { messaging: { socketPath: session.path, token: MESSAGING_TOKEN } },
    );
    // Written before the relay is admitted, so they are read before its proxy listens: they leave
    // under the client's own ids, one a number the relay counts and one an id it generates.
    const early = [1, OLD_GENERATED_ID].map((id) => r.requestAs(id, "tools/call", { name: "fixture_tool", arguments: {} }));
    const initialize = r.requestAs("init", "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: qualified });
    expect((await initialize).error).toBeUndefined();
    expect(await until(() => door.held.length === 2)).toBe(true);
    expect(door.held.map((entry) => entry.line.id)).toEqual([1, OLD_GENERATED_ID]);

    // Initialized once the proxy listens: the relay registers it, and a later request is renamed.
    r.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    expect(await until(() => door.held.some(isRegistration))).toBe(true);
    const late = r.requestAs("late", "tools/call", { name: "fixture_tool", arguments: {} });
    expect(await until(() => door.held.length === 4)).toBe(true);
    // The daemon never has two requests outstanding under one id.
    const ids = door.held.map((entry) => JSON.stringify(entry.line.id));
    expect(new Set(ids).size).toBe(ids.length);

    // A cancel of an early request names it as the daemon knows it: under the client's own id.
    r.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1, reason: "fixture" } })}\n`);
    expect(await until(() => door.notifications.some((line) => line.method === "notifications/cancelled"))).toBe(true);
    expect(door.notifications.filter((line) => line.method === "notifications/cancelled").map((line) => line.params?.requestId)).toEqual([1]);

    // The registration's answer first, then each client's: every client answer under its own id.
    for (const entry of [door.held.find(isRegistration)!, ...door.held.filter((entry) => !isRegistration(entry))]) {
      door.answer(entry, isRegistration(entry) ? REGISTERED : CLIENT_RESULT);
    }
    for (const answered of [...early, late]) expect((await answered).result).toEqual(CLIENT_RESULT);
    await pauseFor(100);
    expect(r.out()).not.toContain("structuredContent");
    expect(r.err()).toBe("");
    await r.finish();
  });
});
