import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { ATTACH_EXIT } from "../../src/cli/attach-relay.ts";
import type { Decision } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { startDaemonMcpListeners, type LocalMcpListeners } from "../../src/daemon/agentcpd.ts";
import { Daemon } from "../../src/daemon/daemon.ts";
import { Role, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { C0_QUALIFIED_CLIENT } from "../../src/mcp/role-conversation.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { fixtureManifest, makeHarness, type Harness } from "../helpers/harness.ts";

/**
 * `tests/unit/attach-relay.test.ts` drives `runAttachRelay` in this process with in-memory
 * streams. That answers what the relay does; it cannot answer whether a *real* child process's
 * own stdin and stdout carry it — which is the shape Claude Code actually spawns, and where argv
 * and the environment become observable to anything that can read `ps`.
 *
 * So this file spawns the real CLI entry as a separate OS process, speaks MCP over its real
 * pipes to the real `cto.mcp.sock` listener, and then reads back what the child's own argv and
 * stderr contained.
 *
 * argv[0] is `process.execPath` — the already-assessed node binary — and everything after it is
 * read as data, so nothing here creates an inode that macOS would assess (#817).
 */
const TSX_ENTRY = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
const CLI_ENTRY = join(process.cwd(), "src", "cli", "agentctl.ts");

/** Chosen by this file, so its absence from argv and from the child's stderr is a measurement. */
const TOKEN_CANARY = "unit-b-process-token-canary-5d81";
const RECEIPT_CANARY = "unit-b-process-receipt-canary-5d81";

const valueOf = <T>(decision: Decision<T>): T => {
  if (!decision.allowed) throw new Error(JSON.stringify(decision));
  return decision.value;
};

describe("the attach relay as the process Claude Code spawns", () => {
  let h: Harness | undefined;
  let daemon: Daemon | undefined;
  let listeners: LocalMcpListeners | undefined;
  let stateDir: string | undefined;
  let claimServer: Server | undefined;
  let wake: Server | undefined;
  const children: ChildProcess[] = [];

  afterEach(async () => {
    for (const child of children.splice(0)) {
      if (child.pid && child.exitCode === null) {
        try {
          process.kill(child.pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }
    if (claimServer) await new Promise<void>((resolve) => claimServer!.close(() => resolve()));
    if (wake?.listening) await new Promise<void>((resolve) => wake!.close(() => resolve()));
    await listeners?.close();
    daemon?.lock.release();
    h?.cp.db.close();
    if (stateDir) rmSync(stateDir, { recursive: true, force: true });
    claimServer = undefined;
    wake = undefined;
    listeners = undefined;
    daemon = undefined;
    h = undefined;
    stateDir = undefined;
    cleanupTempDirs();
  });

  it("carries a real child's stdio to the daemon and exits zero when that stdin closes", async () => {
    h = makeHarness();
    const manifest = fixtureManifest("attach-relay-process-project");
    valueOf(
      h.cp.projects.register({
        projectId: manifest.projectId,
        name: "fixture",
        manifest,
        authorization: h.cp.manifestAuthorizationForTests(manifest),
      }),
    );
    const session = h.cp.sessions.create({ provider: "scripted", model: "fixture" });
    valueOf(h.cp.sessions.transition(session.sessionId, SessionLifecycle.READY));
    if (!session.sessionSecret) throw new Error("fixture secret unavailable");
    const roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId: manifest.projectId });
    valueOf(
      h.cp.bindings.bind({ role: Role.PRIMARY_CTO, projectId: manifest.projectId, sessionId: session.sessionId }),
    );

    // Short and inside this checkout, including on macOS with its 103-byte `sun_path` limit.
    stateDir = mkdtempSync(join(fileURLToPath(new URL("../../", import.meta.url)), ".arp-"));
    daemon = new Daemon(h.cp, { stateDir });
    valueOf(daemon.lock.acquire(h.clock.nowIso()));
    listeners = await startDaemonMcpListeners(h.cp, stateDir, TOKEN_CANARY, daemon);
    const mcpPath = listeners.socketPaths[1]!;
    const endpoint = join(stateDir, "w.sock");
    wake = createServer((socket) => socket.resume());
    await new Promise<void>((resolve, reject) => {
      wake!.once("error", reject);
      wake!.listen(endpoint, resolve);
    });

    // The claim socket is a fixture for the reason the unit file states: the production listener
    // authenticates the kernel's record of who opened it and walks that peer's ancestry for a real
    // `claude` executable, which `tests/process/canonical-self-claim-listener-claim.test.ts`
    // already pays for once.
    const claimPath = join(stateDir, "c.sock");
    claimServer = createServer((socket) => {
      socket.once("data", () =>
        socket.end(
          `${JSON.stringify({
            allowed: true,
            reasonCode: ReasonCode.OK,
            value: {
              sessionId: session.sessionId,
              sessionSecret: session.sessionSecret,
              canary: RECEIPT_CANARY,
            },
          })}\n`,
        ),
      );
    });
    await new Promise<void>((resolve, reject) => {
      claimServer!.once("error", reject);
      claimServer!.listen(claimPath, resolve);
    });

    const selectors = [
      "--claimed-session-id",
      randomUUID(),
      "--project-id",
      manifest.projectId,
      "--expected-binding-generation",
      "1",
      "--owner-approval-nonce",
      randomUUID(),
    ];
    const child = spawn(
      process.execPath,
      [TSX_ENTRY, CLI_ENTRY, "attach", "canonical-cto", ...selectors],
      {
        cwd: process.cwd(),
        env: {
          HOME: stateDir,
          PATH: process.env["PATH"] ?? "",
          // The documented test-only override. Production sets no environment on this child.
          ACP_MCP_TOKEN: TOKEN_CANARY,
          ACP_CLAIM_CANONICAL_CTO_SOCKET: claimPath,
          ACP_CTO_MCP_SOCKET: mcpPath,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    children.push(child);

    let stderrText = "";
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      stderrText += chunk;
    });

    let stdoutText = "";
    const pending = new Map<number, (message: Record<string, unknown>) => void>();
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      stdoutText += chunk;
      for (;;) {
        const newline = stdoutText.indexOf("\n");
        if (newline < 0) break;
        const line = stdoutText.slice(0, newline);
        stdoutText = stdoutText.slice(newline + 1);
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        const id = message["id"];
        if (typeof id === "number") pending.get(id)?.(message);
      }
    });

    const request = (id: number, method: string, params: unknown): Promise<Record<string, unknown>> =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`timeout awaiting ${method}; stderr=${stderrText}`)),
          30_000,
        );
        pending.set(id, (message) => {
          clearTimeout(timer);
          pending.delete(id);
          resolve(message);
        });
        child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });

    const initialize = await request(1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: C0_QUALIFIED_CLIENT,
    });
    expect(initialize["result"]).toBeDefined();
    child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

    const registered = await request(2, "tools/call", {
      name: "role_wake_endpoint_register",
      arguments: { endpoint },
    });
    const body = (registered["result"] as { structuredContent?: Record<string, unknown> }).structuredContent!;
    expect(body["ok"]).toBe(true);
    expect(listeners.ctoConversation.endpointFor(roleKey)).toBe(endpoint);

    child.stdin!.end();
    const exitCode = await new Promise<number | null>((resolve) => child.once("exit", resolve));
    expect(exitCode).toBe(0);

    // A command line is world-readable through `ps`. Neither secret is on this one.
    expect(child.spawnargs.join(" ")).not.toContain(TOKEN_CANARY);
    expect(child.spawnargs.join(" ")).not.toContain(session.sessionSecret);
    expect(child.spawnargs.join(" ")).not.toContain(RECEIPT_CANARY);
    // stderr is a log wherever Claude Code files it.
    expect(stderrText).not.toContain(TOKEN_CANARY);
    expect(stderrText).not.toContain(session.sessionSecret);
    expect(stderrText).not.toContain(RECEIPT_CANARY);
  });

  /**
   * The relay's stdout is a **pipe**, not a TTY, and `agentctl` ends by calling `process.exit` with
   * whatever `runAttachRelay` resolved. `process.exit` keeps only the bytes the kernel has already
   * accepted: anything still queued in Node's userspace write buffer is discarded. On this host a
   * child that writes 100 006 bytes to a pipe and then exits delivers 65 536 of them.
   *
   * So a terminal path that resolves before stdout has flushed truncates the daemon-to-client MCP
   * stream, and Claude Code reads a JSON-RPC line that stops mid-token. That is the same class of
   * protocol fault as a stray byte on stdout, arriving through the exit path instead of the write
   * path — and the in-process unit tests cannot see it, because a `PassThrough` has no kernel
   * buffer and no `process.exit` behind it.
   *
   * The arrangement below is the one that makes it deterministic rather than a race. The relay
   * accumulates the daemon's first line itself, with no backpressure, and writes it to stdout in a
   * single `write` — so a first line larger than the pipe buffer leaves a known backlog in
   * userspace no matter how the scheduler runs. This test's parent then stays stalled across the
   * whole window in which the relay observes EOF and exits, and only afterwards drains the pipe.
   * What it reads back is exactly what survived the exit.
   */
  it("flushes every byte it piped to stdout before the process exits, with the reader stalled", async () => {
    stateDir = mkdtempSync(join(fileURLToPath(new URL("../../", import.meta.url)), ".arf-"));

    // Comfortably past the 65 536-byte pipe buffer, and under the relay's own 1 MiB line bound.
    const firstLine = `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { text: "x".repeat(900_000), tail: "UNIT-B-FLUSH-TAIL" },
    })}\n`;
    expect(Buffer.byteLength(firstLine)).toBeGreaterThan(65_536);

    const claimPath = join(stateDir, "c.sock");
    claimServer = createServer((socket) => {
      socket.once("data", () =>
        socket.end(
          `${JSON.stringify({
            allowed: true,
            reasonCode: ReasonCode.OK,
            value: { sessionId: randomUUID(), sessionSecret: RECEIPT_CANARY },
          })}\n`,
        ),
      );
    });
    await new Promise<void>((resolve, reject) => {
      claimServer!.once("error", reject);
      claimServer!.listen(claimPath, resolve);
    });

    // Stands in for the daemon at the far end of `cto.mcp.sock`: it takes the handshake line, sends
    // one oversized JSON-RPC line, and closes. The relay must deliver all of it.
    const mcpPath = join(stateDir, "m.sock");
    let delivered!: () => void;
    const deliveredPayload = new Promise<void>((resolve) => {
      delivered = resolve;
    });
    wake = createServer((socket) => {
      socket.once("data", () => {
        socket.end(firstLine, () => delivered());
      });
    });
    await new Promise<void>((resolve, reject) => {
      wake!.once("error", reject);
      wake!.listen(mcpPath, resolve);
    });

    const child = spawn(
      process.execPath,
      [
        TSX_ENTRY,
        CLI_ENTRY,
        "attach",
        "canonical-cto",
        "--claimed-session-id",
        randomUUID(),
        "--project-id",
        "flush-project",
        "--expected-binding-generation",
        "1",
        "--owner-approval-nonce",
        randomUUID(),
      ],
      {
        cwd: process.cwd(),
        env: {
          HOME: stateDir,
          PATH: process.env["PATH"] ?? "",
          ACP_MCP_TOKEN: TOKEN_CANARY,
          ACP_CLAIM_CANONICAL_CTO_SOCKET: claimPath,
          ACP_CTO_MCP_SOCKET: mcpPath,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    children.push(child);

    let stderrText = "";
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      stderrText += chunk;
    });

    // The stall, and it has to be a *reading* stall rather than no reader at all: Node's own
    // `flushStdio` resumes a child stdio stream that was never read once the child exits, and that
    // discards exactly the bytes this test is here to count. So the parent takes one chunk, pauses,
    // and lets the kernel pipe fill behind it — which is what makes the relay's remaining output sit
    // in its userspace buffer at the moment it decides to exit.
    const chunks: Buffer[] = [];
    let stalled = true;
    child.stdout!.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      if (stalled) child.stdout!.pause();
    });
    // Both are registered now, not after the stall: against the defect the child is already gone
    // and its stdout already at EOF by the time the stall window closes, and a listener attached
    // then would wait for an event that has been and gone.
    const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
    const drained = new Promise<void>((resolve) => child.stdout!.once("end", resolve));

    await deliveredPayload;
    await new Promise<void>((resolve) => setTimeout(resolve, 1_500));

    stalled = false;
    child.stdout!.resume();
    const exitCode = await exited;
    await drained;

    const received = Buffer.concat(chunks).toString("utf8");
    expect(received.length).toBe(firstLine.length);
    expect(received).toBe(firstLine);
    // The daemon closed first, so the client's stdin was never ended: this is the stream-closed exit.
    expect(exitCode).toBe(ATTACH_EXIT.STREAM_CLOSED);
    expect(stderrText).not.toContain(TOKEN_CANARY);
  });
});
