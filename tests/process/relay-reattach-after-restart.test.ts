import { mkdtempSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ATTACH_EXIT,
  DEFAULT_REATTACH_POLICY,
  RELAY_REATTACHING_ERROR,
  runAttachRelay,
  runAttachRelayCommand,
  type ReattachPolicy,
} from "../../src/cli/attach-relay.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { startLocalMcpListeners, type LocalMcpListeners } from "../../src/daemon/agentcpd.ts";
import { count } from "../helpers/adopted-ceo.ts";
import {
  canonicalCtoFixture,
  CLAUDE,
  CLAUDE_TOKEN,
  claudeProcess,
  CONVERSATION,
  CTO,
  OTHER_CLAUDE,
  PROJECT,
  type CanonicalCtoFixture,
} from "../helpers/canonical-cto-reattach.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { clearSessionMessagingEnv } from "../helpers/session-messaging-env.ts";

/**
 * A canonical CTO's relay across a daemon restart (#1037 follow-up, measured live at 12:1xZ: the
 * restart closed the relay's connection, the relay exited by design, Claude Code does not respawn
 * a dead stdio MCP server, and the ACTIVE binding was left with no tools and no wake path).
 *
 * The daemon here is the real listener pair and reattach door, closed and opened again on the same
 * state directory the way a restart does. The relay is the real one, run in-process so the kernel
 * reports this test process as the peer; the process tree above it is stated. The claim socket is a
 * fixture that counts what reaches it: a reattach must never fall back to a claim.
 */

const TOKEN = "fixture-mcp-token";
const POLICY: Partial<ReattachPolicy> = { maxWaitMs: 5_000, initialDelayMs: 20, maxDelayMs: 100, attemptTimeoutMs: 2_000 };
const qualified = { name: "claude-code", version: "2.1.323" };
/** What a stand-in door's acknowledgement names: one binding and one runtime. */
const STAND_IN_TUPLE = { assignmentId: "stand-in-assignment", bindingGeneration: 1, sessionId: "stand-in-session", sessionIncarnation: "stand-in-incarnation" };

interface Wire {
  id?: unknown;
  result?: { tools?: Array<{ name: string }>; structuredContent?: Record<string, unknown> };
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

/**
 * The relay's CLI entry reads the session's messaging socket and token from the environment, and a
 * run from inside a Claude Code session inherits that session's real ones: the relay would open its
 * wake proxy beside the live session's socket, outside this file's scratch roots. Every
 * CLAUDE_CODE_MESSAGING_* variable is cleared before any relay runs (`clearSessionMessagingEnv`), so
 * the only socket directories a run uses are the mkdtemp roots below.
 */
/**
 * R1154-01 — every CLAUDE_CODE_MESSAGING_* variable is removed before this file's imports evaluate:
 * vi.hoisted runs ahead of them, where a module-level call would run after. Inlined because a hoisted
 * body cannot use an import; `clearSessionMessagingEnv` repeats it before each case.
 */
vi.hoisted(() => {
  for (const name of Object.keys(process.env)) {
    if (name.startsWith("CLAUDE_CODE_MESSAGING_")) delete process.env[name];
  }
});
beforeEach(() => clearSessionMessagingEnv());

const roots: string[] = [];
const fixtures: CanonicalCtoFixture[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close().catch(() => undefined);
  for (const made of fixtures.splice(0)) made.h.cp.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
afterAll(cleanupTempDirs);

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
  return { open, stop, current: () => current };
};

const started = async () => {
  const subject = canonicalCtoFixture();
  fixtures.push(subject);
  // The kernel will report this process as the peer: it runs under the stated claude.
  subject.processes.set(process.pid, { ppid: CLAUDE, startedAt: "darwin-tv:1790000500.000005", argv: ["node"] });
  const dir = mkdtempSync("/tmp/acp37r-");
  roots.push(dir);
  const daemon = await daemonOn(subject, dir);
  const claims: string[] = [];
  const sockets: Socket[] = [];
  const claimServer: Server = createServer((socket) => {
    sockets.push(socket);
    socket.once("data", (chunk) => {
      claims.push(chunk.toString("utf8"));
      socket.end(`${JSON.stringify({ allowed: false, reasonCode: ReasonCode.BINDING_ALREADY_ACTIVE })}\n`);
    });
  });
  const claimPath = join(dir, "c.sock");
  await new Promise<void>((resolve) => claimServer.listen(claimPath, resolve));
  closers.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => claimServer.close(() => resolve()));
  });
  return {
    subject,
    daemon,
    claims,
    paths: {
      claimPath,
      ctoPath: join(dir, "cto.mcp.sock"),
      reattachPath: join(dir, "agentcpd.canonical-cto-tools.sock"),
    },
  };
};

/**
 * How a test drives the relay: `stdout` replaces the reading client with one the test controls
 * (it is handed what the client parses), and `entry` picks the CLI entry over `runAttachRelay`.
 */
interface Drive {
  stdout?: (read: (chunk: Buffer) => void) => Writable;
  entry?: "relay" | "command";
}

const relay = (paths: { claimPath: string; ctoPath: string; reattachPath: string }, policy = POLICY, drive: Drive = {}) => {
  const stdin = new PassThrough();
  const stderr = new PassThrough();
  let errText = "";
  let pendingText = "";
  let nextId = 1;
  const pending = new Map<number, (message: Wire) => void>();
  const read = (chunk: Buffer): void => {
    pendingText += chunk.toString("utf8");
    for (;;) {
      const newline = pendingText.indexOf("\n");
      if (newline < 0) break;
      const message = JSON.parse(pendingText.slice(0, newline)) as Wire;
      pendingText = pendingText.slice(newline + 1);
      if (typeof message.id === "number") pending.get(message.id)?.(message);
    }
  };
  const stdout = drive.stdout?.(read) ?? new PassThrough().on("data", read);
  stderr.on("data", (chunk: Buffer) => {
    errText += chunk.toString("utf8");
  });
  const common = {
    claimSocketPath: paths.claimPath,
    mcpSocketPath: paths.ctoPath,
    reattachSocketPath: paths.reattachPath,
    claim: { claimedSessionUuid: CONVERSATION, projectId: PROJECT, expectedBindingGeneration: 2 },
    reattach: policy,
  };
  const exit = drive.entry === "command"
    ? runAttachRelayCommand(common, { stdin, stdout, stderr })
    : runAttachRelay({ ...common, mcpToken: TOKEN }, { stdin, stdout, stderr });
  let exited: number | null = null;
  void exit.then((code) => {
    exited = code;
  });
  return {
    exit,
    stdin,
    exited: () => exited,
    err: () => errText,
    stdout,
    /** Sends a request without waiting for its answer; the answer still reaches `request`'s waiters. */
    send: (method: string, params: unknown) => {
      const id = nextId++;
      stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      return id;
    },
    request: (method: string, params: unknown) =>
      new Promise<Wire>((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => reject(new Error(`timeout awaiting ${method}; stderr=${errText}`)), 10_000);
        pending.set(id, (message) => {
          clearTimeout(timer);
          resolve(message);
        });
        stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      }),
    notify: (method: string) => stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`),
  };
};

/** The answer the relay gives a request it did not send because it is reattaching. */
const NOT_SENT = { code: RELAY_REATTACHING_ERROR, message: "agent-control-plane is reattaching; this request was not sent" };

/**
 * Waits until the relay carries requests again, and returns the last thing it answered.
 *
 * The relay serves again once its restore is done, and only a request it carries says so. The
 * restoring ping's answer ends the restore (`gatedDoor` holds that answer back). So this sends a
 * `ping` and asks again only while the answer is the "not sent" refusal, which by the relay's
 * contract left nothing behind. Any other answer ends the wait, and so does the deadline; either
 * way the last answer is returned, so a refusal at the deadline fails the caller's assertion
 * rather than passing it.
 */
const servedAgain = async (r: ReturnType<typeof relay>, budgetMs = 5_000): Promise<Wire> => {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const answer = await r.request("ping", {});
    // A ping that was in flight when the connection closed is answered "outcome unknown": a ping has no outcome.
    const retry = answer.error?.code === NOT_SENT.code &&
      (answer.error.message === NOT_SENT.message || answer.error.message?.includes("outcome is unknown") === true);
    if (!retry) return answer;
    if (Date.now() >= deadline) return answer;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

/** The id of a JSON-RPC line, or undefined when it has none or is not JSON. */
const idOf = (line: string): unknown => {
  try {
    return (JSON.parse(line) as { id?: unknown }).id;
  } catch {
    return undefined;
  }
};

/**
 * A pipe in front of the real reattach door that can hold back the daemon's answer to the relay's
 * restoring ping, and every line after it on that connection, until released.
 *
 * It opens the interval a restart case would otherwise cross blind: a returning relay replays its
 * `initialize` and `notifications/initialized`, asks a ping, and serves the client again only once
 * that answer arrives. While it is held the daemon is back and the relay is still reattaching.
 * Everything else passes as it arrived. A connection the door does not take is closed before any
 * line, which the relay reads as a daemon not back yet.
 */
const gatedDoor = async (door: string) => {
  const path = join(door, "..", "gate.sock");
  let arming: ((held: { release: () => void }) => void) | null = null;
  const sockets: Socket[] = [];
  const eachLine = (socket: Socket, onLine: (line: string) => void): void => {
    let text = "";
    socket.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
      for (let newline = text.indexOf("\n"); newline >= 0; newline = text.indexOf("\n")) {
        const line = text.slice(0, newline);
        text = text.slice(newline + 1);
        onLine(line);
      }
    });
  };
  const server = createServer((relaySide) => {
    const daemonSide = createConnection(door);
    sockets.push(relaySide, daemonSide);
    relaySide.on("error", () => undefined);
    daemonSide.on("error", () => undefined);
    relaySide.once("close", () => daemonSide.destroy());
    daemonSide.once("close", () => relaySide.destroy());
    const registrations = new Set<unknown>();
    let held: string[] | null = null;
    eachLine(relaySide, (line) => {
      const message = JSON.parse(line) as { id?: unknown; method?: string; params?: { name?: string } };
      if (message.method === "ping" && String(message.id).startsWith("acp-relay-restored")) registrations.add(message.id);
      daemonSide.write(`${line}\n`);
    });
    eachLine(daemonSide, (line) => {
      if (held !== null) {
        held.push(line);
        return;
      }
      const take = arming;
      if (take === null || !registrations.has(idOf(line))) {
        relaySide.write(`${line}\n`);
        return;
      }
      arming = null;
      const queue = [line];
      held = queue;
      take({
        release: () => {
          held = null;
          for (const each of queue) relaySide.write(`${each}\n`);
        },
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  closers.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    path,
    /** Holds the next answer to the relay's restoring ping; settles once one is held, or fails at the budget. */
    holdNextRestoredAnswer: (budgetMs = 5_000) =>
      new Promise<{ release: () => void }>((resolve, reject) => {
        const timer = setTimeout(() => {
          arming = null;
          reject(new Error("no answer to a restoring ping reached the gate"));
        }, budgetMs);
        arming = (held) => {
          clearTimeout(timer);
          resolve(held);
        };
      }),
  };
};

/** Attached and initialized, the state a live canonical CTO is in. */
const attachedAndInitialized = async (gated = false) => {
  const fixture = await started();
  const gate = gated ? await gatedDoor(fixture.paths.reattachPath) : null;
  const r = relay(gate === null ? fixture.paths : { ...fixture.paths, reattachPath: gate.path });
  const init = await r.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: qualified });
  expect(init.error).toBeUndefined();
  r.notify("notifications/initialized");
  return { ...fixture, r, gate };
};

const generation = (subject: CanonicalCtoFixture) =>
  subject.h.cp.db.all("SELECT assignment_id, binding_generation, status FROM assignments WHERE role_key = ?", [CTO]);

describe("a canonical CTO relay across a daemon restart", () => {
  it("reattaches, and keeps the generation, the session and the client's stdio", async () => {
    const { subject, daemon, claims, r } = await attachedAndInitialized();
    const before = generation(subject);
    await daemon.stop();
    await daemon.open();
    expect(r.exited()).toBeNull();
    // The relay serves again once its restore is answered, so the request below waits for the relay.
    expect((await servedAgain(r)).error).toBeUndefined();
    const listed = await r.request("tools/list", {});
    expect(listed.result?.tools?.map((tool) => tool.name)).toContain("role_owner_message_claim");
    expect(generation(subject)).toEqual(before);
    expect(count(subject.h, "SELECT COUNT(*) AS n FROM sessions")).toBe(1);
    expect(claims).toEqual([]);
    r.stdin.end();
    expect(await settles(r.exit)).toBe(ATTACH_EXIT.OK);
  });

  it("answers a request sent while it is reattaching with the defined error, and serves the next one", async () => {
    const { daemon, gate, r } = await attachedAndInitialized(true);
    await daemon.stop();
    const refused = await r.request("tools/list", {});
    expect(refused.error).toMatchObject({ code: RELAY_REATTACHING_ERROR });
    expect(refused.result).toBeUndefined();
    const holding = gate!.holdNextRestoredAnswer();
    await daemon.open();
    const held = await holding;
    // Held between the daemon answering the restoring ping and the relay reading its answer: the
    // daemon is back and the relay is still reattaching, so a request sent now is the defined
    // refusal, never sent.
    const early = await r.request("tools/list", {});
    expect(early.error).toEqual(NOT_SENT);
    expect(early.result).toBeUndefined();
    held.release();
    expect((await servedAgain(r)).error).toBeUndefined();
    const listed = await r.request("tools/list", {});
    expect(listed.error).toBeUndefined();
    expect(listed.result?.tools?.map((tool) => tool.name)).toContain("role_owner_message_claim");
    r.stdin.end();
    expect(await settles(r.exit)).toBe(ATTACH_EXIT.OK);
  });

  it("exits without claiming when the binding was revoked before the daemon came back", async () => {
    const { subject, daemon, claims, r } = await attachedAndInitialized();
    await daemon.stop();
    expect(subject.h.cp.bindings.revoke(CTO, "revoked across the restart").allowed).toBe(true);
    await daemon.open();
    expect(await settles(r.exit)).toBe(ATTACH_EXIT.HANDSHAKE_REFUSED);
    expect(r.err()).toBe(`attach: reattach refused ${ReasonCode.CTO_REATTACH_UNBOUND}\n`);
    expect(claims).toEqual([]);
  });

  it("exits without claiming when the binding's runtime is another process", async () => {
    const { subject, daemon, claims, r } = await attachedAndInitialized();
    await daemon.stop();
    // The same conversation, now under another claude: this relay's ancestry no longer holds it.
    subject.processes.set(OTHER_CLAUDE, claudeProcess(CONVERSATION, "darwin-tv:1790000400.000004"));
    subject.processes.set(process.pid, { ppid: OTHER_CLAUDE, startedAt: "darwin-tv:1790000500.000005", argv: ["node"] });
    await daemon.open();
    expect(await settles(r.exit)).toBe(ATTACH_EXIT.HANDSHAKE_REFUSED);
    expect(r.err()).toBe(`attach: reattach refused ${ReasonCode.CTO_REATTACH_UNBOUND}\n`);
    expect(claims).toEqual([]);
  });

  it("answers a request in flight when the connection closed with the defined error, outcome unknown", async () => {
    // A stand-in daemon behind the reattach door: it admits, answers `initialize`, never answers a
    // tool call, and drops the first connection while that call is outstanding.
    const dir = mkdtempSync("/tmp/acp37f-");
    roots.push(dir);
    const door = join(dir, "door.sock");
    const connections: Socket[] = [];
    const server = createServer((socket) => {
      connections.push(socket);
      // The door's acknowledgement names what it admitted (PR1051-R1); the same tuple each time.
      socket.write(`${JSON.stringify({ ok: true, reasonCode: ReasonCode.OK, admitted: STAND_IN_TUPLE })}\n`);
      let held = "";
      socket.on("data", (chunk: Buffer) => {
        held += chunk.toString("utf8");
        for (let newline = held.indexOf("\n"); newline >= 0; newline = held.indexOf("\n")) {
          const message = JSON.parse(held.slice(0, newline)) as { id?: unknown; method?: string };
          held = held.slice(newline + 1);
          if (message.method === "initialize") {
            socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "stand-in", version: "1" } } })}\n`);
          }
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(door, resolve));
    closers.push(async () => {
      for (const socket of connections) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const r = relay({ claimPath: join(dir, "absent.sock"), ctoPath: join(dir, "absent.sock"), reattachPath: door });
    expect((await r.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: qualified })).error)
      .toBeUndefined();
    const outstanding = r.request("tools/call", { name: "anything", arguments: {} });
    expect(await until(() => connections.length === 1)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    connections[0]!.destroy();
    const answered = await outstanding;
    expect(answered.error).toMatchObject({ code: RELAY_REATTACHING_ERROR });
    expect(answered.error?.message).toContain("outcome is unknown");
    // It came back through the door and replayed the client's own initialize there.
    expect(await until(() => connections.length === 2)).toBe(true);
    r.stdin.end();
    expect(await settles(r.exit)).toBe(ATTACH_EXIT.OK);
  });

  it("exits once the daemon has not come back within a bound it was given", async () => {
    const fixture = await started();
    const r = relay(fixture.paths, { ...POLICY, maxWaitMs: 300 });
    const init = await r.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: qualified });
    expect(init.error).toBeUndefined();
    await fixture.daemon.stop();
    expect(await settles(r.exit)).toBe(ATTACH_EXIT.UNAVAILABLE);
    expect(r.err()).toBe("attach: daemon did not return\n");
    expect(fixture.claims).toEqual([]);
  });
});

/**
 * Review PR1051 (round 1). Each case below is a reproduction the review ran against the relay, kept
 * as a witness: it fails on the reviewed head and passes once the finding is closed.
 *
 * Most of them drive the relay against stand-ins rather than the real daemon, because what they
 * need is a daemon that misbehaves on cue — answers late, drops a connection mid-restore, never
 * answers at all. The two about which binding and which wake endpoint come back use the real
 * listeners, admission and wake registry.
 */

const FAST: Partial<ReattachPolicy> = { maxWaitMs: 3_000, initialDelayMs: 5, maxDelayMs: 50, attemptTimeoutMs: 200 };

interface Line {
  id?: unknown;
  method?: string;
  params?: { clientInfo?: unknown; name?: string; arguments?: unknown };
}

const initializeResult = (id: unknown): string =>
  `${JSON.stringify({ jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "stand-in", version: "1" } } })}\n`;

/**
 * A stand-in for the canonical CTO reattach door. `mode` decides each new connection: admitted with
 * `tuple`, answered unbound, dropped at once, or accepted and never answered (`silent`, a daemon
 * still starting). Every admitted connection's lines are kept by connection, and `onLine` decides
 * what that connection answers.
 */
const standInDoor = async (
  path: string,
  onLine: (socket: Socket, index: number, line: Line) => void,
  listen = true,
) => {
  const door = {
    mode: "admit" as "admit" | "unbound" | "drop" | "silent",
    tuple: STAND_IN_TUPLE as Record<string, unknown>,
    connections: [] as Socket[],
    silent: [] as Socket[],
    closed: [] as boolean[],
    lines: [] as Line[][],
    open: () => door.closed.filter((closed) => !closed).length,
    listen: () => new Promise<void>((resolve) => server.listen(path, resolve)),
  };
  const server = createServer((socket) => {
    socket.on("error", () => undefined);
    if (door.mode === "drop") {
      socket.destroy();
      return;
    }
    if (door.mode === "silent") {
      door.silent.push(socket);
      return;
    }
    if (door.mode === "unbound") {
      socket.end(`${JSON.stringify({ ok: false, reasonCode: ReasonCode.CTO_REATTACH_UNBOUND })}\n`);
      return;
    }
    const index = door.connections.length;
    door.connections.push(socket);
    door.closed.push(false);
    door.lines.push([]);
    socket.once("close", () => {
      door.closed[index] = true;
    });
    socket.write(`${JSON.stringify({ ok: true, reasonCode: ReasonCode.OK, admitted: door.tuple })}\n`);
    let held = "";
    socket.on("data", (chunk: Buffer) => {
      held += chunk.toString("utf8");
      for (let newline = held.indexOf("\n"); newline >= 0; newline = held.indexOf("\n")) {
        const line = JSON.parse(held.slice(0, newline)) as Line;
        held = held.slice(newline + 1);
        door.lines[index]!.push(line);
        onLine(socket, index, line);
      }
    });
  });
  closers.push(async () => {
    for (const socket of [...door.connections, ...door.silent]) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  if (listen) await door.listen();
  return door;
};

/** A directory for stand-in sockets, and the relay pointed at a door there with nothing else up. */
const standInPaths = () => {
  const dir = mkdtempSync("/tmp/acp51-");
  roots.push(dir);
  return {
    dir,
    paths: { claimPath: join(dir, "absent-claim.sock"), ctoPath: join(dir, "absent-cto.sock"), reattachPath: join(dir, "door.sock") },
  };
};

const initializeWith = (r: ReturnType<typeof relay>, clientInfo: unknown = qualified) =>
  r.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo });

/** Resolves with the answer, or with "unanswered" if none comes within `budgetMs`. */
const answeredWithin = <T>(answer: Promise<T>, budgetMs: number): Promise<T | "unanswered"> =>
  Promise.race([answer, new Promise<"unanswered">((resolve) => setTimeout(() => resolve("unanswered"), budgetMs))]);

const pauseFor = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("review PR1051-R1: a reconnect comes back only to the binding and runtime it left", () => {
  it("names the admitted role, binding and runtime in the door's acknowledgement", async () => {
    const { subject, paths } = await started();
    const binding = subject.h.cp.bindings.active(CTO)!;
    const socket = createConnection(paths.reattachPath);
    closers.push(async () => {
      socket.destroy();
    });
    const first = await new Promise<string>((resolve) => {
      let held = "";
      socket.on("data", (chunk: Buffer) => {
        held += chunk.toString("utf8");
        if (held.includes("\n")) resolve(held.slice(0, held.indexOf("\n")));
      });
    });
    expect(JSON.parse(first)).toEqual({
      ok: true,
      reasonCode: ReasonCode.OK,
      admitted: {
        // Review S2B-R2-01 — the role the door admitted this connection as, read from the binding.
        roleKey: binding.roleKey,
        assignmentId: binding.assignmentId,
        bindingGeneration: binding.bindingGeneration,
        sessionId: binding.sessionId,
        sessionIncarnation: binding.sessionIncarnation,
      },
    });
  });

  it("refuses to reconnect when the same claude now holds another assignment and session, and claims nothing", async () => {
    const { subject, daemon, claims, paths, r } = await attachedAndInitialized();
    const before = subject.h.cp.bindings.active(CTO)!;
    await daemon.stop();
    // The same claude process, start and conversation; assignment and session 1 replaced by 2.
    expect(subject.h.cp.bindings.revoke(CTO, "replaced across the restart").allowed).toBe(true);
    const replacement = subject.bindTo(CLAUDE, CLAUDE_TOKEN);
    const after = subject.h.cp.bindings.active(CTO)!;
    expect(after.sessionId).toBe(replacement);
    expect(after.assignmentId).not.toBe(before.assignmentId);
    await daemon.open();
    expect(await settles(r.exit)).toBe(ATTACH_EXIT.HANDSHAKE_REFUSED);
    expect(r.err()).toBe("attach: reattach admitted another binding\n");
    expect(claims).toEqual([]);
    // The door itself admits this process under the replacement: the refusal is the relay's own.
    const probe = relay(paths, FAST);
    expect((await initializeWith(probe)).error).toBeUndefined();
    probe.stdin.end();
    expect(await settles(probe.exit)).toBe(ATTACH_EXIT.OK);
  });
});

describe("review PR1051-R2: one wait, one connection, one deadline", () => {
  it("destroys an abandoned restore, so its late answer cannot satisfy the next connection's initialize", async () => {
    const { paths } = standInPaths();
    // Connection 0 is the first admission. Connection 1 answers the replayed initialize only after
    // the relay has given up on it. Every later connection never answers it.
    const door = await standInDoor(paths.reattachPath, (socket, index, line) => {
      if (line.method !== "initialize") return;
      if (index === 0) socket.write(initializeResult(line.id));
      if (index === 1) setTimeout(() => { if (!socket.destroyed) socket.write(initializeResult(line.id)); }, 300);
    });
    const r = relay(paths, FAST);
    expect((await initializeWith(r)).error).toBeUndefined();
    door.connections[0]!.destroy();
    expect(await until(() => door.lines[2]?.some((line) => line.method === "initialize") === true)).toBe(true);
    // Past the moment connection 1 answers: no connection that never answered is live, so the
    // client's request reaches none of them and is answered "not sent".
    await pauseFor(250);
    const listed = await answeredWithin(r.request("tools/list", {}), 1_000);
    expect(door.lines.slice(1).flat().filter((line) => line.method !== "initialize")).toEqual([]);
    expect(listed).not.toBe("unanswered");
    expect((listed as Wire).error).toMatchObject({ code: RELAY_REATTACHING_ERROR });
    expect((listed as Wire).error?.message).toContain("was not sent");
    // Given up on, connection 1 is closed, not left with callbacks into the relay.
    expect(door.closed[1]).toBe(true);
    r.stdin.end();
    expect(await settles(r.exit)).toBe(ATTACH_EXIT.OK);
  });

  it("keeps one connection when the one it is restoring closes, instead of starting a second wait", async () => {
    const { paths } = standInPaths();
    // Connection 1 drops as soon as the replayed initialize arrives; every other answers it.
    const door = await standInDoor(paths.reattachPath, (socket, index, line) => {
      if (line.method === "ping") socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: line.id, result: {} })}\n`);
      if (line.method !== "initialize") return;
      if (index === 1) socket.destroy();
      else socket.write(initializeResult(line.id));
    });
    const r = relay(paths, FAST);
    expect((await initializeWith(r)).error).toBeUndefined();
    door.connections[0]!.destroy();
    expect(await until(() => door.connections.length >= 3)).toBe(true);
    // Long enough for a second wait, had one started, to have opened and restored its own.
    await pauseFor(400);
    expect(door.open()).toBe(1);
    expect(door.connections).toHaveLength(3);
    r.stdin.end();
    expect(await settles(r.exit)).toBe(ATTACH_EXIT.OK);
  });

  it("exits at the wait's deadline even while a restore's own step has longer to run", async () => {
    const { paths } = standInPaths();
    const door = await standInDoor(paths.reattachPath, (socket, index, line) => {
      if (line.method === "initialize" && index === 0) socket.write(initializeResult(line.id));
    });
    const r = relay(paths, { maxWaitMs: 100, initialDelayMs: 5, maxDelayMs: 50, attemptTimeoutMs: 1_500 });
    expect((await initializeWith(r)).error).toBeUndefined();
    const lostAt = Date.now();
    door.connections[0]!.destroy();
    expect(await settles(r.exit)).toBe(ATTACH_EXIT.UNAVAILABLE);
    expect(Date.now() - lostAt).toBeLessThan(600);
    expect(r.err()).toBe("attach: daemon did not return\n");
  });

  it("exits at the wait's deadline even while an admission's own step has longer to run", async () => {
    const { paths } = standInPaths();
    const door = await standInDoor(paths.reattachPath, (socket, _index, line) => {
      if (line.method === "initialize") socket.write(initializeResult(line.id));
    });
    const r = relay(paths, { maxWaitMs: 100, initialDelayMs: 5, maxDelayMs: 50, attemptTimeoutMs: 1_500 });
    expect((await initializeWith(r)).error).toBeUndefined();
    // A door that accepts and never answers: each admission would wait its full step.
    const silent: Socket[] = [];
    door.connections[0]!.removeAllListeners("data");
    const lostAt = Date.now();
    const server = createServer((socket) => {
      silent.push(socket);
      socket.on("error", () => undefined);
    });
    closers.push(async () => {
      for (const socket of silent) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    rmSync(paths.reattachPath, { force: true });
    await new Promise<void>((resolve) => server.listen(paths.reattachPath, resolve));
    door.connections[0]!.destroy();
    expect(await settles(r.exit)).toBe(ATTACH_EXIT.UNAVAILABLE);
    expect(Date.now() - lostAt).toBeLessThan(600);
  });

  it("leaves no connection open once it has given up", async () => {
    const { paths } = standInPaths();
    const door = await standInDoor(paths.reattachPath, (socket, index, line) => {
      if (line.method === "initialize" && index === 0) socket.write(initializeResult(line.id));
    });
    const r = relay(paths, { maxWaitMs: 700, initialDelayMs: 5, maxDelayMs: 20, attemptTimeoutMs: 100 });
    expect((await initializeWith(r)).error).toBeUndefined();
    door.connections[0]!.destroy();
    expect(await settles(r.exit)).toBe(ATTACH_EXIT.UNAVAILABLE);
    expect(door.connections.length).toBeGreaterThan(2);
    expect(await until(() => door.open() === 0, 500)).toBe(true);
  });
});

/** A few turns of the real event loop, so socket I/O lands between fake-timer steps. */
const ioTurns = async (): Promise<void> => {
  for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setImmediate(resolve));
};

describe("a daemon restart that outlasts any fixed wait", () => {
  // A restart measured at 5m47s outlasted the five-minute wait the relay used to have: the relay
  // exited, Claude Code does not respawn a dead stdio MCP server, and every later wake found no
  // peer until the session was reconnected by hand.
  it("keeps asking through six silent minutes, then reattaches and restores", async () => {
    const { paths } = standInPaths();
    const door = await standInDoor(paths.reattachPath, (socket, _index, line) => {
      if (line.method === "initialize") socket.write(initializeResult(line.id));
      if (line.method === "ping") socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: line.id, result: {} })}\n`);
      if (line.method === "tools/list") socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: line.id, result: { tools: [] } })}\n`);
    });
    // The production policy: nothing overridden.
    const r = relay(paths, {});
    expect((await initializeWith(r)).error).toBeUndefined();
    r.notify("notifications/initialized");
    const replayed = (): boolean => door.lines[1]?.some((line) => line.method === "ping") === true;
    let waited = 0;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      door.mode = "silent";
      door.connections[0]!.destroy();
      for (let second = 0; second < 6 * 60; second += 1) {
        await vi.advanceTimersByTimeAsync(1_000);
        await ioTurns();
      }
      expect(r.exited()).toBeNull();
      expect(r.err()).toBe("");
      // It kept asking the whole time, one connection after another rather than one held open.
      expect(door.silent.length).toBeGreaterThan(5);
      door.mode = "admit";
      // Back within one attempt and one capped backoff step: the backoff stayed bounded.
      while (!replayed() && waited <= DEFAULT_REATTACH_POLICY.attemptTimeoutMs + DEFAULT_REATTACH_POLICY.maxDelayMs) {
        await vi.advanceTimersByTimeAsync(1_000);
        await ioTurns();
        waited += 1_000;
      }
    } finally {
      vi.useRealTimers();
    }
    expect(replayed()).toBe(true);
    expect(waited).toBeLessThanOrEqual(DEFAULT_REATTACH_POLICY.attemptTimeoutMs + DEFAULT_REATTACH_POLICY.maxDelayMs);
    expect(door.connections).toHaveLength(2);
    expect(await until(() => door.silent.every((socket) => socket.destroyed))).toBe(true);
    const listed = await r.request("tools/list", {});
    expect(listed.error).toBeUndefined();
    r.stdin.end();
    expect(await settles(r.exit)).toBe(ATTACH_EXIT.OK);
  });
});

describe("review PR1051-R3: only what a daemon confirmed is replayed", () => {
  it("replays the initialize a daemon answered, not one sent while it was away", async () => {
    const { paths } = standInPaths();
    const door = await standInDoor(paths.reattachPath, (socket, _index, line) => {
      if (line.method === "initialize") socket.write(initializeResult(line.id));
    });
    const r = relay(paths, FAST);
    expect((await initializeWith(r, { name: "the-confirmed-client", version: "1" })).error).toBeUndefined();
    door.mode = "drop";
    door.connections[0]!.destroy();
    const unsent = await initializeWith(r, { name: "the-unsent-client", version: "1" });
    expect(unsent.error).toMatchObject({ code: RELAY_REATTACHING_ERROR });
    door.mode = "admit";
    expect(await until(() => door.lines[1]?.some((line) => line.method === "initialize") === true)).toBe(true);
    const replayed = door.lines[1]!.filter((line) => line.method === "initialize");
    expect(replayed.map((line) => line.params?.clientInfo)).toEqual([{ name: "the-confirmed-client", version: "1" }]);
    r.stdin.end();
    expect(await settles(r.exit)).toBe(ATTACH_EXIT.OK);
  });
});

/** A client that reads until told to stop, then holds every write's callback: a stalled pipe. */
const stallingClient = () => {
  const held: Array<() => void> = [];
  let stalled = false;
  return {
    stall: () => {
      stalled = true;
    },
    stdout: (read: (chunk: Buffer) => void) =>
      new Writable({
        highWaterMark: 1_024,
        write(chunk: Buffer, _encoding, callback) {
          if (stalled) {
            held.push(callback);
            return;
          }
          read(chunk);
          callback();
        },
      }),
  };
};

describe("review PR1051-R4: nothing on the gap path is held without bound", () => {
  it("stops reading the client while the client is not reading the relay", async () => {
    const { paths } = standInPaths();
    const door = await standInDoor(paths.reattachPath, (socket, _index, line) => {
      if (line.method === "initialize") socket.write(initializeResult(line.id));
    });
    const client = stallingClient();
    const r = relay(paths, FAST, { stdout: client.stdout });
    expect((await initializeWith(r)).error).toBeUndefined();
    client.stall();
    door.mode = "drop";
    door.connections[0]!.destroy();
    await pauseFor(50);
    for (let sent = 0; sent < 20_000; sent += 1) r.send("tools/list", {});
    await pauseFor(200);
    expect(r.stdout.writableLength).toBeLessThan(16 * 1_024);
    expect(r.stdin.readableFlowing).toBe(false);
    r.stdin.destroy();
  });

  it("exits within its flush bound when the client stopped reading", async () => {
    const { paths } = standInPaths();
    const door = await standInDoor(paths.reattachPath, (socket, _index, line) => {
      if (line.method === "initialize") socket.write(initializeResult(line.id));
    });
    const client = stallingClient();
    const r = relay(paths, { ...FAST, maxWaitMs: 300, flushTimeoutMs: 200 } as Partial<ReattachPolicy>, { stdout: client.stdout });
    expect((await initializeWith(r)).error).toBeUndefined();
    client.stall();
    door.mode = "drop";
    door.connections[0]!.destroy();
    await pauseFor(30);
    for (let sent = 0; sent < 50; sent += 1) r.send("tools/list", {});
    expect(await settles(r.exit, 3_000)).toBe(ATTACH_EXIT.UNAVAILABLE);
    expect(r.err()).toBe("attach: daemon did not return\n");
  });
});

/**
 * A claim socket that answers with a receipt naming `binding`, and a `cto.mcp.sock` that takes the
 * handshake line and then hands each client line to `onLine`. Both count what reaches them.
 */
const claimedStandIns = async (
  dir: string,
  onLine: (socket: Socket, line: Line) => void,
  binding: Record<string, unknown> = STAND_IN_TUPLE,
) => {
  const seen = { claims: [] as string[], handshakes: [] as string[], mcp: [] as Socket[], mcpLines: [] as Line[] };
  const servers: Server[] = [];
  const claimServer = createServer((socket) => {
    socket.on("error", () => undefined);
    socket.once("data", (chunk) => {
      seen.claims.push(chunk.toString("utf8"));
      socket.end(`${JSON.stringify({
        allowed: true,
        reasonCode: ReasonCode.OK,
        value: { sessionId: STAND_IN_TUPLE.sessionId, sessionSecret: "stand-in-secret-canary", binding },
      })}\n`);
    });
  });
  const mcpServer = createServer((socket) => {
    seen.mcp.push(socket);
    socket.on("error", () => undefined);
    let held = "";
    let handshaken = false;
    socket.on("data", (chunk: Buffer) => {
      held += chunk.toString("utf8");
      for (let newline = held.indexOf("\n"); newline >= 0; newline = held.indexOf("\n")) {
        const raw = held.slice(0, newline);
        held = held.slice(newline + 1);
        if (!handshaken) {
          handshaken = true;
          seen.handshakes.push(raw);
          continue;
        }
        const line = JSON.parse(raw) as Line;
        seen.mcpLines.push(line);
        onLine(socket, line);
      }
    });
  });
  servers.push(claimServer, mcpServer);
  await new Promise<void>((resolve) => claimServer.listen(join(dir, "claim.sock"), resolve));
  await new Promise<void>((resolve) => mcpServer.listen(join(dir, "cto.sock"), resolve));
  closers.push(async () => {
    for (const socket of seen.mcp) socket.destroy();
    for (const server of servers) await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { seen, paths: { claimPath: join(dir, "claim.sock"), ctoPath: join(dir, "cto.sock"), reattachPath: join(dir, "door.sock") } };
};

const withToken = async <T>(run: () => Promise<T>): Promise<T> => {
  const saved = process.env["ACP_MCP_TOKEN"];
  process.env["ACP_MCP_TOKEN"] = TOKEN;
  try {
    return await run();
  } finally {
    if (saved === undefined) delete process.env["ACP_MCP_TOKEN"];
    else process.env["ACP_MCP_TOKEN"] = saved;
  }
};

describe("review PR1051-R5: a claimed relay comes back after a restart too", () => {
  for (const entry of ["relay", "command"] as const) {
    it(`reattaches after a loss though the door did not answer when it started (${entry} entry)`, async () => {
      const { dir } = standInPaths();
      const { seen, paths } = await claimedStandIns(dir, (socket, line) => {
        if (line.method === "initialize") socket.write(initializeResult(line.id));
      });
      // The door is configured but not yet listening, as during a daemon's startup.
      const door = await standInDoor(paths.reattachPath, (socket, _index, line) => {
        if (line.method === "initialize") socket.write(initializeResult(line.id));
      }, false);
      await withToken(async () => {
        const r = relay(paths, FAST, { entry });
        expect((await initializeWith(r)).error).toBeUndefined();
        await door.listen();
        seen.mcp[0]!.destroy();
        expect(await until(() => door.lines[0]?.some((line) => line.method === "initialize") === true)).toBe(true);
        expect(r.exited()).toBeNull();
        expect(seen.claims).toHaveLength(1);
        expect(seen.handshakes).toHaveLength(1);
        expect(door.lines.flat().map((line) => JSON.stringify(line)).join("")).not.toContain("stand-in-secret-canary");
        r.stdin.end();
        expect(await settles(r.exit)).toBe(ATTACH_EXIT.OK);
      });
    });
  }

  it("review S2B-R2-01: comes back through a door that names its role, whatever role its claim receipt named", async () => {
    // The claim's connection is admitted under no role: only the door's acknowledgement names one,
    // so the first door admission of the claimed binding is taken under the role it names.
    const { dir } = standInPaths();
    const { seen, paths } = await claimedStandIns(dir, (socket, line) => {
      if (line.method === "initialize") socket.write(initializeResult(line.id));
    }, { ...STAND_IN_TUPLE, roleKey: "PRIMARY_CTO:receipt-role" });
    const door = await standInDoor(paths.reattachPath, (socket, _index, line) => {
      if (line.method === "initialize") socket.write(initializeResult(line.id));
    }, false);
    door.tuple = { ...STAND_IN_TUPLE, roleKey: "PRIMARY_CTO:door-role" };
    const r = relay(paths, FAST);
    expect((await initializeWith(r)).error).toBeUndefined();
    await door.listen();
    seen.mcp[0]!.destroy();
    expect(await until(() => door.lines[0]?.some((line) => line.method === "initialize") === true)).toBe(true);
    expect(r.exited()).toBeNull();
    expect(r.err()).toBe("");
    r.stdin.end();
    expect(await settles(r.exit)).toBe(ATTACH_EXIT.OK);
  });

  it("reattaches when the claimed connection closes before its first answer, with no refusal", async () => {
    const { dir } = standInPaths();
    // The authenticated connection takes the handshake and the client's initialize, then drops.
    const { seen, paths } = await claimedStandIns(dir, (socket, line) => {
      if (line.method === "initialize") socket.destroy();
    });
    const door = await standInDoor(paths.reattachPath, (socket, _index, line) => {
      if (line.method === "initialize") socket.write(initializeResult(line.id));
    });
    door.mode = "unbound";
    const r = relay(paths, FAST);
    expect(await until(() => seen.handshakes.length === 1)).toBe(true);
    door.mode = "admit";
    const first = await initializeWith(r);
    expect(first.error).toMatchObject({ code: RELAY_REATTACHING_ERROR });
    expect(first.error?.message).toContain("outcome is unknown");
    expect(await until(() => door.connections.length === 1)).toBe(true);
    expect(r.exited()).toBeNull();
    const again = await answeredWithin(initializeWith(r), 2_000);
    expect(again).not.toBe("unanswered");
    expect((again as Wire).error).toBeUndefined();
    expect(seen.claims).toHaveLength(1);
    expect(seen.handshakes).toHaveLength(1);
    r.stdin.end();
    expect(await settles(r.exit)).toBe(ATTACH_EXIT.OK);
  });
});

/**
 * What the relay does to the client's traffic. It is a byte pipe with two exceptions: a restore, which
 * replays the client's `initialize` and `notifications/initialized` and then asks a `ping` of its own,
 * and the answer to a request that was in flight when the connection closed. Every other line, in
 * either direction, passes exactly as it arrived, under the client's own ids, `notifications/cancelled`
 * included. The relay sends no request of its own on a live link, so there is no id to keep apart.
 *
 * Every frame below is spaced as `JSON.stringify` never spaces it, and one carries a `\u` escape it would
 * decode, so a line the relay parsed and wrote again cannot pass for the line it was given.
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

const lines = (...frames: string[]): string => frames.map((frame) => `${frame}\n`).join("");

/** The restoring ping, exactly as the relay writes it. */
const RESTORING_PING = JSON.stringify({ jsonrpc: "2.0", id: "acp-relay-restored-1", method: "ping" });

/** The stand-in daemon's answer to a request, spaced as no serializer spaces it, under the id it was sent. */
const spacedAnswer = (id: unknown, method: string): string =>
  `{ "jsonrpc" : "2.0" ,  "id" : ${JSON.stringify(id)} , "result" : { "answered" : ${JSON.stringify(method)} } }`;

/**
 * A stand-in daemon behind the reattach door that keeps each connection's bytes exactly as they
 * arrived and answers every request at once with `spacedAnswer`, but a `tools/call` of `fixture_slow`,
 * which it leaves unanswered. `notifications` are the id-less lines each connection was sent, parsed.
 */
const recordingDoor = async (dir: string) => {
  const path = join(dir, "door.sock");
  const connections: Array<{ socket: Socket; raw: string }> = [];
  const notifications: Line[] = [];
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
        const line = JSON.parse(text.slice(0, newline)) as Line;
        text = text.slice(newline + 1);
        if (line.id === undefined) {
          notifications.push(line);
          continue;
        }
        if (line.method === undefined) continue;
        if (line.method === "tools/call" && (line.params as { name?: string } | undefined)?.name === "fixture_slow") continue;
        socket.write(`${spacedAnswer(line.id, line.method)}\n`);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  closers.push(async () => {
    for (const { socket } of connections) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { path, connections, notifications };
};

/** A relay behind `recordingDoor`, its stdout kept as the client read it. */
const pipedRelay = async () => {
  const { dir } = standInPaths();
  const door = await recordingDoor(dir);
  const r = relay({ claimPath: join(dir, "absent.sock"), ctoPath: join(dir, "absent.sock"), reattachPath: door.path }, FAST);
  let out = "";
  r.stdout.on("data", (chunk: Buffer) => {
    out += chunk.toString("utf8");
  });
  const answered = (id: string | number): boolean => out.includes(`"id" : ${JSON.stringify(id)} ,`) || out.includes(`"id":${JSON.stringify(id)}`);
  return { door, r, out: () => out, answered };
};

describe("the relay changes no byte of the client's traffic (review PR1057-R3)", () => {
  it("passes every line through exactly as it arrived in both directions, and across a restart", async () => {
    const { door, r, out, answered } = await pipedRelay();
    r.stdin.write(lines(SPACED.initialize, SPACED.initialized, SPACED.list, SPACED.held, SPACED.cancel, SPACED.strayCancel));
    expect(await until(() => answered("client-42"))).toBe(true);
    await pauseFor(100);
    // Soft, so each direction and the restore is judged on its own when one of them changes a byte.
    // Client to daemon: each line as the client wrote it, the request ids its own, both cancels sent.
    expect.soft(door.connections[0]!.raw).toBe(
      lines(SPACED.initialize, SPACED.initialized, SPACED.list, SPACED.held, SPACED.cancel, SPACED.strayCancel),
    );

    // Daemon to client: an answer to no request of the client's passes as well, as it always did.
    door.connections[0]!.socket.write(`${SPACED.stray}\n`);
    expect.soft(await until(() => answered("stray-9"), 1_000)).toBe(true);

    // A restarted daemon is given the client's `initialize` as the client sent it, then its
    // `notifications/initialized`, then the relay's own restoring ping, before anything else.
    door.connections[0]!.socket.destroy();
    expect(await until(() => (door.connections[1]?.raw ?? "").includes(RESTORING_PING))).toBe(true);
    await pauseFor(100);
    r.stdin.write(lines(SPACED.afterRestore));
    expect(await until(() => answered("after-restore-3"))).toBe(true);
    expect.soft(door.connections[1]!.raw).toBe(lines(SPACED.initialize, SPACED.initialized, RESTORING_PING, SPACED.afterRestore));

    // Every answer reached the client as the daemon wrote it; the one line of the relay's own is
    // its report that the held request's outcome is unknown, under that request's own id. The
    // restoring ping's answer is the relay's, and never reaches the client.
    expect.soft(out()).toBe(lines(
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
    expect.soft(r.err()).toBe("");
    expect(door.connections).toHaveLength(2);
    r.stdin.end();
    expect(await settles(r.exit)).toBe(ATTACH_EXIT.OK);
  });

  it("answers a request under the client's own id, whatever shape it has, and the daemon never sees one id twice", async () => {
    const { door, r, answered } = await pipedRelay();
    // Numbers, strings, and a string shaped like an id the relay itself would generate: all the client's.
    const ids: Array<string | number> = [1, 2, "acp-relay-restored-1", "acp-relay-rewake-1", "client-42"];
    r.stdin.write(lines(SPACED.initialize, SPACED.initialized));
    expect(await until(() => answered("init-1"))).toBe(true);
    for (const id of ids) {
      r.stdin.write(lines(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "fixture_tool", arguments: {} } })));
    }
    expect(await until(() => ids.every((id) => answered(id)))).toBe(true);
    const sent = door.connections[0]!.raw.split("\n").filter((text) => text !== "").map((text) => JSON.parse(text) as Line);
    const requested = sent.filter((line) => line.method === "tools/call").map((line) => line.id);
    expect(requested).toEqual(ids);
    expect(new Set(requested.map((id) => JSON.stringify(id))).size).toBe(requested.length);
    expect(r.err()).toBe("");
    r.stdin.end();
    expect(await settles(r.exit)).toBe(ATTACH_EXIT.OK);
  });

  it("forwards notifications/cancelled naming the request's own id, even one that names no request in flight", async () => {
    const { door, r, answered } = await pipedRelay();
    r.stdin.write(lines(SPACED.initialize, SPACED.initialized, SPACED.held));
    expect(await until(() => answered("init-1"))).toBe(true);
    r.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "held-7", reason: "fixture" } })}\n`);
    r.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "never-sent", reason: "fixture" } })}\n`);
    expect(await until(() => door.notifications.filter((line) => line.method === "notifications/cancelled").length === 2)).toBe(true);
    expect(
      door.notifications.filter((line) => line.method === "notifications/cancelled").map((line) => (line.params as { requestId?: unknown }).requestId),
    ).toEqual(["held-7", "never-sent"]);
    r.stdin.end();
    expect(await settles(r.exit)).toBe(ATTACH_EXIT.OK);
  });
});
