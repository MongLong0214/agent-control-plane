import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createServer, type Socket } from "node:net";
import { PassThrough, type Readable, type Writable } from "node:stream";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ATTACH_EXIT, RELAY_REATTACHING_ERROR, runAdoptedCeoAttachRelay, type ReattachPolicy } from "../../src/cli/attach-relay.ts";
import { allow, type Decision } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { startAdoptedCeoToolSocket, startLocalMcpListeners } from "../../src/daemon/agentcpd.ts";
import {
  ADOPTED_CEO_TOOL_SOCKET_FILENAME,
  startAdoptedCeoToolListener,
  type CanonicalCtoAdmittedTuple,
  type CanonicalSelfClaimListener,
} from "../../src/daemon/canonical-self-claim-listener.ts";
import { HERMES_PROVENANCE_META_KEY } from "../../src/mcp/hermes-provenance.ts";
import { adoptedFixture, CEO, count, DIGEST, GATEWAY, LIVE, type AdoptedCeoFixture } from "../helpers/adopted-ceo.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { clearSessionMessagingEnv } from "../helpers/session-messaging-env.ts";

/**
 * The adopted CEO relay across a daemon restart — what every deploy is to it. Before, the relay exited when the daemon's
 * side closed, Hermes kept the dead stdio server, and the CEO's first tool call after the deploy failed with "stdio
 * process disconnected". Here the relay outlives the restart: the first call after it succeeds, a reconnect admitted
 * under another binding forwards nothing, and a write that was on the lost connection is answered, never sent again.
 */

vi.hoisted(() => {
  for (const name of Object.keys(process.env)) {
    if (name.startsWith("CLAUDE_CODE_MESSAGING_")) delete process.env[name];
  }
});
beforeEach(() => clearSessionMessagingEnv());

const CLI_ENTRY = join(process.cwd(), "src", "cli", "agentctl.ts");
const MCP_TOKEN = "fixture-mcp-token";
/** Fast backoff for the in-process cases; the spawned relay keeps its production policy. */
/**
 * Lets the relay see the daemon's side close before the next client line: a line written before it has, was written
 * to the lost connection, and is answered "outcome unknown" rather than held.
 */
const LOSS_SEEN_MS = 200;
const FAST: Partial<ReattachPolicy> = { initialDelayMs: 20, maxDelayMs: 100 };

const OWNER_TURN = {
  [HERMES_PROVENANCE_META_KEY]: {
    session_id: LIVE,
    session_key: "agent:main:telegram:dm:1001",
    platform: "telegram",
    chat_id: "1001",
    cron: false,
    parent_chat_id: null,
    principal: "owner",
    delegation_depth: 0,
    lineage_root_digest: DIGEST,
  },
};

const roots: string[] = [];
const fixtures: AdoptedCeoFixture[] = [];
const closers: Array<() => Promise<void>> = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  for (const close of closers.splice(0).reverse()) await close();
  for (const fixture of fixtures.splice(0)) fixture.h.cp.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
afterAll(cleanupTempDirs);

/** `/tmp` directly: a per-user TMPDIR leaves too little of Darwin's 104-byte `sun_path`. */
const stateDir = (): string => {
  const dir = mkdtempSync("/tmp/acprs-");
  roots.push(dir);
  return dir;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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

interface Wire {
  id?: number;
  method?: string;
  result?: { structuredContent?: Record<string, unknown> };
  error?: { code: number; message: string };
}

/** A JSON-RPC client on a relay's stdio, the way Hermes's MCP client uses it: one line per message, ids its own. */
const client = (stdin: Writable, stdout: Readable, stderr: Readable) => {
  let pendingText = "";
  let errText = "";
  let nextId = 1;
  const received: Wire[] = [];
  const waiting = new Map<number, (message: Wire) => void>();
  stdout.on("data", (chunk: Buffer) => {
    pendingText += chunk.toString("utf8");
    for (let newline = pendingText.indexOf("\n"); newline >= 0; newline = pendingText.indexOf("\n")) {
      const message = JSON.parse(pendingText.slice(0, newline)) as Wire;
      pendingText = pendingText.slice(newline + 1);
      received.push(message);
      if (message.id !== undefined && message.method === undefined) waiting.get(message.id)?.(message);
    }
  });
  stderr.on("data", (chunk: Buffer) => {
    errText += chunk.toString("utf8");
  });
  const request = (method: string, params: unknown, budgetMs = 15_000): Promise<Wire> =>
    new Promise<Wire>((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => reject(new Error(`timeout awaiting ${method}; stderr=${errText}`)), budgetMs);
      waiting.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  const initialize = async (): Promise<void> => {
    const init = await request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "hermes-gateway", version: "1" },
    });
    expect(init.error).toBeUndefined();
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  };
  return { request, initialize, received, err: () => errText };
};

const inProcessRelay = (toolSocketPath: string, reattach: Partial<ReattachPolicy> = FAST) => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const exit = runAdoptedCeoAttachRelay({ toolSocketPath, reattach }, { stdin, stdout, stderr });
  return { exit, stdin, ...client(stdin, stdout, stderr) };
};

const runCreate = (key: string): Record<string, unknown> => ({
  name: "run_create",
  arguments: {
    idempotencyKey: key,
    projectId: null,
    executionMode: "SIMPLE",
    contract: {
      goal: "start the requested work",
      why: "the owner asked for it",
      scope: [],
      nonGoals: [],
      acceptance: ["a run exists"],
      priority: "NORMAL",
      humanGate: [],
      references: [],
    },
    repositories: [],
  },
  _meta: OWNER_TURN,
});

/** The adopted CEO behind the real kernel-peer door, admission and Hermes MCP server, as `agentcpd` starts them. */
const adoptedDaemon = async () => {
  const fixture = adoptedFixture();
  fixtures.push(fixture);
  const dir = stateDir();
  const listeners = await startLocalMcpListeners(fixture.h.cp, dir, MCP_TOKEN);
  closers.push(() => listeners.close());
  let tools: CanonicalSelfClaimListener | null = null;
  const start = async (): Promise<void> => {
    // A fresh admission each time, as a restarted daemon composes it.
    tools = await startAdoptedCeoToolSocket(fixture.h.cp, { lock: { held: () => true } }, dir, fixture.admission());
  };
  const stop = async (): Promise<void> => {
    await tools?.close();
    tools = null;
  };
  closers.push(stop);
  await start();
  return { fixture, socketPath: join(dir, ADOPTED_CEO_TOOL_SOCKET_FILENAME), start, stop };
};

const runIdOf = (created: Wire): string => {
  expect(created.error).toBeUndefined();
  expect(created.result?.structuredContent).toMatchObject({ ok: true });
  const value = created.result!.structuredContent!["value"] as { runId: string };
  return value.runId;
};

describe("the adopted CEO relay across a daemon restart", () => {
  it("keeps the Hermes-spawned relay process, and the first read after the restart succeeds", async () => {
    const daemon = await adoptedDaemon();
    const home = stateDir();
    // Exactly the Gateway's MCP command, `agentctl attach adopted-ceo`, with the environment it is given.
    // tsx as a loader rather than its CLI, which would run the relay one process further down.
    const child = spawn(process.execPath, ["--import", "tsx", CLI_ENTRY, "attach", "adopted-ceo"], {
      cwd: process.cwd(),
      env: { HOME: home, PATH: process.env["PATH"] ?? "", ACP_STATE_DIR: home, ACP_ADOPTED_CEO_TOOL_SOCKET: daemon.socketPath },
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(child);
    // The kernel reports the child as the peer: it descends from the bound Gateway, as Hermes's child does.
    daemon.fixture.parents.set(child.pid!, GATEWAY);
    const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
    const ceo = client(child.stdin!, child.stdout!, child.stderr!);

    await ceo.initialize();
    const runId = runIdOf(await ceo.request("tools/call", runCreate("before-the-restart")));

    // The deploy: the daemon goes away and a new one starts on the same state directory.
    await daemon.stop();
    await sleep(300);
    await daemon.start();

    // No respawn and no retry: the same process answers the first call after the restart.
    const read = await ceo.request("tools/call", { name: "run_get", arguments: { runId } });
    expect(read.error).toBeUndefined();
    expect(read.result?.structuredContent).toMatchObject({ ok: true });
    expect(child.exitCode).toBeNull();
    expect(ceo.err()).toBe("");
    expect(count(daemon.fixture.h, "SELECT COUNT(*) AS n FROM runs")).toBe(1);

    child.stdin!.end();
    expect(await Promise.race([exited, sleep(10_000).then(() => "did-not-exit")])).toBe(ATTACH_EXIT.OK);
  });

  it("holds a read sent while the daemon is down and answers it once the daemon is back", async () => {
    const daemon = await adoptedDaemon();
    daemon.fixture.parents.set(process.pid, GATEWAY);
    const r = inProcessRelay(daemon.socketPath);
    await r.initialize();
    const runId = runIdOf(await r.request("tools/call", runCreate("before-the-gap")));

    await daemon.stop();
    await sleep(LOSS_SEEN_MS);
    // Sent into the gap: no daemon is listening.
    const read = r.request("tools/call", { name: "run_get", arguments: { runId } });
    await sleep(500);
    await daemon.start();

    const answered = await read;
    expect(answered.error).toBeUndefined();
    expect(answered.result?.structuredContent).toMatchObject({ ok: true });
    expect(r.err()).toBe("");
    r.stdin.end();
    expect(await settles(r.exit)).toBe(ATTACH_EXIT.OK);
  });

  it("is refused by a restarted daemon on which the CEO binding was revoked, and writes nothing", async () => {
    const daemon = await adoptedDaemon();
    daemon.fixture.parents.set(process.pid, GATEWAY);
    const r = inProcessRelay(daemon.socketPath);
    await r.initialize();
    runIdOf(await r.request("tools/call", runCreate("before-the-revoke")));

    await daemon.stop();
    expect(daemon.fixture.h.cp.bindings.revoke(CEO, "operator re-adoption").allowed).toBe(true);
    await sleep(LOSS_SEEN_MS);
    const write = r.request("tools/call", runCreate("into-the-gap"));
    await daemon.start();

    expect(await settles(r.exit)).toBe(ATTACH_EXIT.HANDSHAKE_REFUSED);
    expect(r.err()).toBe(`attach: reattach refused ${ReasonCode.CONFLICT}\n`);
    expect((await write).error).toMatchObject({ code: RELAY_REATTACHING_ERROR, message: expect.stringContaining("not sent") });
    expect(count(daemon.fixture.h, "SELECT COUNT(*) AS n FROM runs")).toBe(1);
  });
});

/**
 * A stand-in for the tool socket's MCP server behind the real door: it answers every request but the ones `holds`
 * names, and records every line each connection carried, so a test can say exactly what reached a daemon.
 */
const standInDaemon = async (tuple: CanonicalCtoAdmittedTuple, holds: (method: string) => boolean = () => false) => {
  const dir = stateDir();
  const socketPath = join(dir, ADOPTED_CEO_TOOL_SOCKET_FILENAME);
  const lines: string[][] = [];
  let listener: CanonicalSelfClaimListener | null = null;
  const serve = (_admitted: CanonicalCtoAdmittedTuple, socket: Socket): void => {
    const carried: string[] = [];
    lines.push(carried);
    let pending = "";
    socket.on("error", () => undefined);
    socket.on("data", (chunk: Buffer) => {
      pending += chunk.toString("utf8");
      for (let newline = pending.indexOf("\n"); newline >= 0; newline = pending.indexOf("\n")) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        carried.push(line);
        const message = JSON.parse(line) as { id?: unknown; method: string };
        if (message.id === undefined || holds(message.method)) continue;
        socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { answeredBy: "stand-in" } })}\n`);
      }
    });
  };
  const start = async (admitted: CanonicalCtoAdmittedTuple = tuple): Promise<void> => {
    listener = await startAdoptedCeoToolListener(
      { lock: { held: () => true } },
      dir,
      async (): Promise<Decision<CanonicalCtoAdmittedTuple>> => allow(ReasonCode.OK, admitted),
      serve,
    );
  };
  const stop = async (): Promise<void> => {
    await listener?.close();
    listener = null;
  };
  closers.push(stop);
  await start();
  return { socketPath, lines, start, stop };
};

const TUPLE: CanonicalCtoAdmittedTuple = {
  roleKey: CEO,
  assignmentId: "ceo-assignment",
  bindingGeneration: 7,
  sessionId: "ceo-session",
  sessionIncarnation: "ceo-incarnation",
};

const methodsOf = (carried: string[] | undefined): string[] =>
  (carried ?? []).map((line) => (JSON.parse(line) as { method?: string }).method ?? "(answer)");

describe("what a reconnect may carry", () => {
  it("forwards nothing to a restarted daemon that admits it under another binding", async () => {
    const daemon = await standInDaemon(TUPLE);
    const r = inProcessRelay(daemon.socketPath);
    await r.initialize();
    expect((await r.request("tools/list", {})).error).toBeUndefined();

    await daemon.stop();
    await sleep(LOSS_SEEN_MS);
    const read = r.request("tools/list", {});
    await daemon.start({ ...TUPLE, bindingGeneration: TUPLE.bindingGeneration + 1 });

    expect(await settles(r.exit)).toBe(ATTACH_EXIT.HANDSHAKE_REFUSED);
    expect(r.err()).toBe("attach: reattach admitted another binding\n");
    expect((await read).error).toMatchObject({ code: RELAY_REATTACHING_ERROR, message: expect.stringContaining("not sent") });
    // The second daemon admitted the connection and was sent not one byte: no replayed initialize, no held request.
    expect(daemon.lines).toHaveLength(2);
    expect(daemon.lines[1]).toEqual([]);
  });

  it("answers a write that was on the lost connection, never sends it again, and serves the next call", async () => {
    const daemon = await standInDaemon(TUPLE, (method) => method === "tools/call");
    const r = inProcessRelay(daemon.socketPath);
    await r.initialize();
    const write = r.request("tools/call", runCreate("in-flight-at-the-restart"));
    await vi.waitFor(() => expect(methodsOf(daemon.lines[0])).toContain("tools/call"));

    await daemon.stop();
    const unknown = await write;
    expect(unknown.error).toMatchObject({ code: RELAY_REATTACHING_ERROR, message: expect.stringContaining("outcome is unknown") });
    await daemon.start();

    const read = await r.request("tools/list", {});
    expect(read.error).toBeUndefined();
    expect(read.result).toEqual({ answeredBy: "stand-in" });
    // The restored connection carried the client's own initialize, its initialized, the relay's ping, then the read:
    // the write appears on the first connection only.
    expect(methodsOf(daemon.lines[1])).toEqual(["initialize", "notifications/initialized", "ping", "tools/list"]);
    expect(daemon.lines.flat().filter((line) => line.includes("in-flight-at-the-restart"))).toHaveLength(1);
    r.stdin.end();
    expect(await settles(r.exit)).toBe(ATTACH_EXIT.OK);
  });

  it("ends, answering what it held, when a restarted daemon lets it in and names no admission", async () => {
    const daemon = await standInDaemon(TUPLE);
    const r = inProcessRelay(daemon.socketPath, { ...FAST, attemptTimeoutMs: 500 });
    await r.initialize();

    await daemon.stop();
    await sleep(LOSS_SEEN_MS);
    const read = r.request("tools/list", {});
    // A daemon older than the acknowledgement: it admits, says nothing, and waits for the client.
    const older = createServer((socket) => socket.on("error", () => undefined));
    await new Promise<void>((resolve) => older.listen(daemon.socketPath, () => resolve()));
    closers.push(() => new Promise<void>((resolve) => older.close(() => resolve())));

    expect(await settles(r.exit)).toBe(ATTACH_EXIT.UNAVAILABLE);
    expect(r.err()).toBe("attach: reattach unacknowledged\n");
    expect((await read).error).toMatchObject({ code: RELAY_REATTACHING_ERROR, message: expect.stringContaining("not sent") });
  });
});
