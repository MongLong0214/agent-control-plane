import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ATTACH_EXIT, runAdoptedCeoAttachRelay, type InitialConnectPolicy } from "../../src/cli/attach-relay.ts";
import { clearSessionMessagingEnv } from "../helpers/session-messaging-env.ts";

/**
 * Every CLAUDE_CODE_MESSAGING_* variable is removed before this file's imports evaluate, as in the
 * other relay tests: vi.hoisted runs ahead of them, where a module-level call would run after.
 */
vi.hoisted(() => {
  for (const name of Object.keys(process.env)) {
    if (name.startsWith("CLAUDE_CODE_MESSAGING_")) delete process.env[name];
  }
});
beforeEach(() => clearSessionMessagingEnv());

/**
 * The adopted CEO relay's first connect, against a plain listener standing in for the daemon's tool
 * socket. Only the first connect waits, only while the socket is absent or refuses, and within a
 * time and an attempt bound; nothing after a connection is retried.
 */
const TSX_ENTRY = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
const CLI_ENTRY = join(process.cwd(), "src", "cli", "agentctl.ts");

const roots: string[] = [];
const servers: Server[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const root of roots.splice(0)) {
    chmodSync(root, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});

/** `/tmp` directly: a per-user TMPDIR leaves too little of Darwin's 104-byte `sun_path`. */
const socketPath = (): string => {
  const dir = mkdtempSync("/tmp/acr-");
  roots.push(dir);
  return join(dir, "tools.sock");
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

const until = async (condition: () => boolean, budgetMs = 10_000): Promise<void> => {
  const deadline = Date.now() + budgetMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await sleep(20);
  }
};

const request = (id: number): string => `${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list" })}\n`;

interface FakeDaemon {
  connections(): number;
  received(): string;
}

/** A listener at `path` that hands each complete line it receives, with its connection, to `onLine`. */
const serve = (path: string, onLine: (line: string, socket: Socket) => void): Promise<FakeDaemon> =>
  new Promise((resolve, reject) => {
    let connections = 0;
    let received = "";
    const server = createServer((socket) => {
      connections += 1;
      let pending = "";
      socket.on("error", () => undefined);
      socket.on("data", (chunk: Buffer) => {
        received += chunk.toString("utf8");
        pending += chunk.toString("utf8");
        for (let newline = pending.indexOf("\n"); newline >= 0; newline = pending.indexOf("\n")) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          onLine(line, socket);
        }
      });
    });
    servers.push(server);
    server.once("error", reject);
    server.listen(path, () => resolve({ connections: () => connections, received: () => received }));
  });

const answer = (line: string, socket: Socket): void => {
  const { id } = JSON.parse(line) as { id: number };
  socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, result: { tools: [] } })}\n`);
};

const relay = (toolSocketPath: string, initialConnect?: Partial<InitialConnectPolicy>) => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = "";
  let err = "";
  stdout.on("data", (chunk: Buffer) => {
    out += chunk.toString("utf8");
  });
  stderr.on("data", (chunk: Buffer) => {
    err += chunk.toString("utf8");
  });
  const started = Date.now();
  const exit = runAdoptedCeoAttachRelay(
    initialConnect === undefined ? { toolSocketPath } : { toolSocketPath, initialConnect },
    { stdin, stdout, stderr },
  );
  return { exit, stdin, started, out: () => out, err: () => err };
};

describe("the adopted CEO relay's first connect", () => {
  it("connects at once to a socket that is already listening, and round-trips a request", async () => {
    const path = socketPath();
    const daemon = await serve(path, answer);
    const r = relay(path);
    r.stdin.write(request(1));
    await until(() => r.out().includes("\n"));
    expect(JSON.parse(r.out())).toEqual({ jsonrpc: "2.0", id: 1, result: { tools: [] } });
    expect(daemon.connections()).toBe(1);
    expect(r.err()).toBe("");
    r.stdin.end();
    expect(await settles(r.exit)).toBe(ATTACH_EXIT.OK);
  });

  it("waits for a socket that appears late and carries the request written while it waited", async () => {
    const path = socketPath();
    const r = relay(path);
    r.stdin.write(request(1));
    await sleep(1_000);
    expect(await settles(r.exit, 0)).toBe("did-not-settle");
    const daemon = await serve(path, answer);
    await until(() => r.out().includes("\n"));
    expect(JSON.parse(r.out())).toEqual({ jsonrpc: "2.0", id: 1, result: { tools: [] } });
    expect(daemon.connections()).toBe(1);
    expect(daemon.received()).toBe(request(1));
    expect(r.err()).toBe("attach: mcp socket waiting\n");
    r.stdin.end();
    expect(await settles(r.exit)).toBe(ATTACH_EXIT.OK);
  });

  it("exits UNAVAILABLE once the time bound passes for a socket that never appears", async () => {
    const r = relay(socketPath(), { maxWaitMs: 1_000, maxAttempts: 1_000, retryDelayMs: 50 });
    expect(await settles(r.exit, 5_000)).toBe(ATTACH_EXIT.UNAVAILABLE);
    expect(Date.now() - r.started).toBeGreaterThanOrEqual(1_000);
    expect(r.err()).toBe("attach: mcp socket waiting\nattach: mcp socket unavailable\n");
    expect(r.out()).toBe("");
  });

  it("exits UNAVAILABLE once the attempt bound is reached, well before the time bound", async () => {
    const r = relay(socketPath(), { maxWaitMs: 60_000, maxAttempts: 3, retryDelayMs: 100 });
    expect(await settles(r.exit, 5_000)).toBe(ATTACH_EXIT.UNAVAILABLE);
    const elapsed = Date.now() - r.started;
    expect(elapsed).toBeGreaterThanOrEqual(200);
    expect(elapsed).toBeLessThan(5_000);
  });

  it("exits UNAVAILABLE at once on a permission error, never waiting it out", async () => {
    const root = socketPath().replace(/\/tools\.sock$/, "");
    const locked = join(root, "locked");
    mkdirSync(locked);
    chmodSync(locked, 0o000);
    try {
      const r = relay(join(locked, "tools.sock"));
      expect(await settles(r.exit, 2_000)).toBe(ATTACH_EXIT.UNAVAILABLE);
      expect(Date.now() - r.started).toBeLessThan(1_000);
      expect(r.err()).toBe("attach: mcp socket unavailable\n");
    } finally {
      chmodSync(locked, 0o700);
    }
  });

  it("exits STREAM_CLOSED when a connected socket closes, without reconnecting or re-sending", async () => {
    const path = socketPath();
    const r = relay(path);
    r.stdin.write(request(7));
    await sleep(300);
    const daemon = await serve(path, (_line, socket) => socket.destroy());
    expect(await settles(r.exit)).toBe(ATTACH_EXIT.STREAM_CLOSED);
    await sleep(600);
    expect(daemon.connections()).toBe(1);
    expect(daemon.received()).toBe(request(7));
    expect(r.out()).toBe("");
  });

  it("ends the wait cleanly when the client's stdin closes, and connects nothing afterwards", async () => {
    const path = socketPath();
    const r = relay(path);
    await until(() => r.err().includes("waiting"));
    r.stdin.write(request(1));
    r.stdin.end();
    expect(await settles(r.exit, 1_000)).toBe(ATTACH_EXIT.OK);
    const daemon = await serve(path, answer);
    await sleep(600);
    expect(daemon.connections()).toBe(0);
    expect(r.out()).toBe("");
  });

  it("terminates on SIGTERM during the wait, and connects nothing afterwards", async () => {
    const path = socketPath();
    const home = path.replace(/\/tools\.sock$/, "");
    const child = spawn(process.execPath, [TSX_ENTRY, CLI_ENTRY, "attach", "adopted-ceo"], {
      cwd: process.cwd(),
      env: {
        HOME: home,
        PATH: process.env["PATH"] ?? "",
        ACP_STATE_DIR: home,
        ACP_ADOPTED_CEO_TOOL_SOCKET: path,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(child);
    let err = "";
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      err += chunk;
    });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      child.once("exit", (code, signal) => resolve({ code, signal })),
    );
    await until(() => err.includes("attach: mcp socket waiting") || child.exitCode !== null, 30_000);
    expect(err).toBe("attach: mcp socket waiting\n");
    child.kill("SIGTERM");
    const ended = await exited;
    // tsx forwards the signal to the CLI it runs and reports that child's death as 128 + 15.
    expect(ended.signal === "SIGTERM" || ended.code === 128 + 15).toBe(true);
    const daemon = await serve(path, answer);
    await sleep(600);
    expect(daemon.connections()).toBe(0);
  });
});
