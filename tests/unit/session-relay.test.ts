import { spawn } from "node:child_process";
import { createConnection, createServer, type Socket } from "node:net";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { readProcessStartToken } from "../../src/core/process-argv.ts";
import type { SessionLaunchCredential } from "../../src/cto/cto-lifecycle.ts";
import { SESSION_LAUNCH_CREDENTIAL_REFUSED } from "../../src/daemon/agentcpd.ts";
import { sessionRelayScript } from "../../src/runtime/cli-adapters.ts";
import { type BootstrapRuntimeFixture, openHeldCtoConnection, withBootstrapRuntime } from "../helpers/bootstrap-cto-fixture.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";

afterAll(cleanupTempDirs);

/**
 * Issue #246 PR-C slice C1b — the acp-cto relay a provisioned session's turn runs as its only MCP
 * server, executed as the CLI executes it (the interpreter running the shipped script) against the
 * real launch channel and the real `cto.mcp.sock`. No model is involved: the test writes the MCP
 * client's side to the relay's stdin, as Claude Code would.
 */

interface RelayRun {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

const MCP_CLIENT_LINES = [
  {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "relay-test", version: "1" } },
  },
  { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
  { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "role_dispatch_pending", arguments: {} } },
];

/**
 * One level of a turn's process tree: run node with the arguments `args` (a JS expression) as this
 * process's only child, sharing all three stdio streams, and exit with its status.
 */
const treeLevel = (args: string): string =>
  `const { spawn } = require("node:child_process");` +
  `const child = spawn(process.execPath, ${args}, { stdio: "inherit" });` +
  `child.on("exit", (code) => process.exit(code === null ? 1 : code));`;

/** In the CLI's place: runs the relay (its own arguments) as its child. */
const CLI_PLACE = treeLevel("process.argv.slice(1)");
/** The holder: runs the CLI's place as its child. */
const HOLDER = treeLevel(`["-e", ${JSON.stringify(CLI_PLACE)}, ...process.argv.slice(1)]`);

/**
 * Runs the relay for one session, feeds it the client's lines, and ends its stdin once answered.
 *
 * O4 — the relay runs where a real turn runs it: under a holder (what the adapter spawns, and what the
 * runtime pins), as the child of the holder's child (the CLI's place). With `pin`, the offered entry is
 * pinned to that holder in the spawn's own tick, with the start token read from the kernel — what the
 * runtime's `onSpawn` writes. The launch channel reads the relay itself from the kernel.
 */
const runRelay = (
  f: BootstrapRuntimeFixture,
  externalSessionId: string,
  options: { pin?: SessionLaunchCredential; mcpSocket?: string } = {},
): Promise<RelayRun> =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [
      "-e", HOLDER,
      sessionRelayScript(),
      "--launch", f.launch.socketPath,
      "--mcp", options.mcpSocket ?? f.ctoSocket,
      "--session", externalSessionId,
    ], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env["PATH"] ?? "" }, detached: true });
    if (options.pin) {
      const startToken = readProcessStartToken(child.pid!);
      if (startToken === null) throw new Error("the holder's start token could not be read");
      options.pin.pin = { pid: child.pid!, startToken };
    }
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.includes('"id":2')) child.stdin.end();
    });
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.stdin.on("error", () => undefined);
    child.stdin.write(`${MCP_CLIENT_LINES.map((line) => JSON.stringify(line)).join("\n")}\n`);
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr: stderr.replace(/^\(node:\d+\) ExperimentalWarning:.*\n(\(Use `node --trace-warnings.*\n)?/gm, "") });
    });
  });

/** The session's conversation id and the credential its runtime holds, offered on the launch channel. */
const offer = async (f: BootstrapRuntimeFixture, ownerSessionId: string, secret?: string) => {
  const session = f.harness.cp.sessions.require(ownerSessionId);
  const externalSessionId = session.incarnation.split("#", 1)[0]!;
  const held = f.claude.credentials.get(ownerSessionId)!;
  // A driven turn's entry, offered at the runtime's own door; `runRelay` pins it to its holder.
  const credential: SessionLaunchCredential = {
    sessionId: ownerSessionId,
    sessionIncarnation: session.incarnation,
    externalSessionId,
    sessionSecret: secret ?? held.sessionSecret,
  };
  const offered = await f.launch.provision(credential);
  expect(offered, JSON.stringify(offered)).toMatchObject({ allowed: true });
  return { externalSessionId, secret: secret ?? held.sessionSecret, credential };
};

/**
 * A stand-in for `cto.mcp.sock` in front of the real one: on the relay's first bytes it runs `between`,
 * then forwards everything both ways. `between` runs after the hand-over and before the daemon reads
 * the handshake.
 */
const interposedMcpSocket = async (upstreamPath: string, between: () => void) => {
  const path = join(tempDir("acp-relay-proxy-"), "mcp.sock");
  const sockets = new Set<Socket>();
  const server = createServer((relay) => {
    sockets.add(relay);
    relay.once("data", (first) => {
      between();
      const upstream = createConnection(upstreamPath);
      sockets.add(upstream);
      upstream.write(first);
      relay.pipe(upstream);
      upstream.pipe(relay);
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return {
    path,
    close: () => new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    }),
  };
};

const dispatchedSession = async (f: BootstrapRuntimeFixture) => {
  const { ownerSessionId } = await f.dispatchBootstrap();
  // The attestation and the RUN_DISPATCH turn, both finished: nothing is left on offer.
  await f.awaitFinishedTurns(ownerSessionId, 1);
  return ownerSessionId;
};

describe("C1b relay: the credential crosses the launch channel once and the MCP socket once, and nowhere else", () => {
  it("takes the credential, authenticates, and carries the client's traffic both ways; the secret is in no output", async () => {
    await withBootstrapRuntime(async (f) => {
      const sessionId = await dispatchedSession(f);
      const { externalSessionId, secret, credential } = await offer(f, sessionId);
      const run = await runRelay(f, externalSessionId, { pin: credential });
      expect(run.exitCode).toBe(0);
      const reply = run.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((message) => message["id"] === 2) as { result?: { structuredContent?: Record<string, unknown> } };
      expect(reply.result?.structuredContent).toMatchObject({ ok: true });
      expect(run.stdout).not.toContain(secret);
      expect(run.stderr).not.toContain(secret);
      // Take-once: the entry is gone.
      expect(f.launch.withdraw(externalSessionId)).toBe(false);
    });
  });

  it("with no credential on offer it never connects: exit 3, a closed stderr code, no output", async () => {
    await withBootstrapRuntime(async (f) => {
      const sessionId = await dispatchedSession(f);
      const externalSessionId = f.harness.cp.sessions.require(sessionId).incarnation.split("#", 1)[0]!;
      const run = await runRelay(f, externalSessionId);
      expect(run).toMatchObject({ exitCode: 3, stdout: "" });
      expect(run.stderr.trim()).toBe("session-relay: launch CREDENTIAL_UNAVAILABLE");
    });
  });

  it("a second relay for the same turn finds nothing: the credential was taken once", async () => {
    await withBootstrapRuntime(async (f) => {
      const sessionId = await dispatchedSession(f);
      const { externalSessionId, credential } = await offer(f, sessionId);
      expect((await runRelay(f, externalSessionId, { pin: credential })).exitCode).toBe(0);
      const second = await runRelay(f, externalSessionId);
      expect(second.exitCode).toBe(3);
    });
  });

  it("a credential the daemon stops accepting after its hand-over is refused at the handshake: exit 4 with the daemon's reason code", async () => {
    await withBootstrapRuntime(async (f) => {
      const sessionId = await dispatchedSession(f);
      const { externalSessionId, secret, credential } = await offer(f, sessionId);
      // O4 — the launch channel hands over only the session's current credential, so the daemon refusing
      // one at the handshake means it changed in between: here it is rotated after the relay took it.
      const epoch = f.harness.cp.sessions.require(sessionId).credentialEpoch;
      const proxy = await interposedMcpSocket(f.ctoSocket, () => {
        const rotated = f.harness.cp.sessions.rotateSecret(sessionId, epoch);
        if (!rotated.allowed) throw new Error(rotated.message);
      });
      try {
        const run = await runRelay(f, externalSessionId, { pin: credential, mcpSocket: proxy.path });
        expect(run.exitCode).toBe(4);
        expect(run.stderr.trim()).toBe("session-relay: handshake SESSION_SECRET_INVALID");
        expect(run.stdout).toBe("");
        expect(run.stderr).not.toContain(secret);
      } finally {
        await proxy.close();
      }
    });
  });

  it("O4: a credential that is not the session's current one never leaves the launch channel: exit 3, the entry kept", async () => {
    await withBootstrapRuntime(async (f) => {
      const sessionId = await dispatchedSession(f);
      const { externalSessionId, secret, credential } = await offer(f, sessionId, "not-this-session's-secret-" + "y".repeat(16));
      const run = await runRelay(f, externalSessionId, { pin: credential });
      expect(run).toMatchObject({ exitCode: 3, stdout: "" });
      expect(run.stderr.trim()).toBe("session-relay: launch CREDENTIAL_UNAVAILABLE");
      expect(run.stderr).not.toContain(secret);
      expect(f.harness.cp.audit.byKind(SESSION_LAUNCH_CREDENTIAL_REFUSED).map((event) => event.evidence["refusal"]))
        .toEqual(["CREDENTIAL_NOT_CURRENT"]);
      expect(f.launch.withdraw(externalSessionId)).toBe(true);
    });
  });

  it("rejects an argv that is not exactly its three named options", async () => {
    const child = spawn(process.execPath, [sessionRelayScript(), "--session", "x"], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    const exitCode = await new Promise<number | null>((resolve) => child.on("close", resolve));
    expect(exitCode).toBe(2);
    expect(stderr).toContain("session-relay: usage INVALID_ARGUMENTS");
  });
});

describe("readiness does not open an unbound MCP authority", () => {
  it("keeps an unbound STARTING session off the role socket without readiness challenges", async () => {
    await withBootstrapRuntime(async (f) => {
      const created = f.harness.cp.sessions.create({ provider: "claude", model: "opus" });
      const credential = { sessionId: created.sessionId, sessionSecret: created.sessionSecret! };
      expect(await openHeldCtoConnection(f.ctoSocket, credential)).toMatchObject({ refused: { ok: false } });
    });
  });
});
