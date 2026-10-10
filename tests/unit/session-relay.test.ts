import { spawn } from "node:child_process";

import { afterAll, describe, expect, it, vi } from "vitest";

import { ReasonCode } from "../../src/core/reason-codes.ts";
import { sessionRelayScript } from "../../src/runtime/cli-adapters.ts";
import { type BootstrapRuntimeFixture, openHeldCtoConnection, withBootstrapRuntime } from "../helpers/bootstrap-cto-fixture.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";

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

/** Runs the relay for one session, feeds it the client's lines, and ends its stdin once answered. */
const runRelay = (f: BootstrapRuntimeFixture, externalSessionId: string): Promise<RelayRun> =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [
      sessionRelayScript(),
      "--launch", f.launch.socketPath,
      "--mcp", f.ctoSocket,
      "--session", externalSessionId,
    ], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env["PATH"] ?? "" } });
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
  const offered = await f.launch.provision({
    sessionId: ownerSessionId,
    sessionIncarnation: session.incarnation,
    externalSessionId,
    sessionSecret: secret ?? held.sessionSecret,
  });
  expect(offered, JSON.stringify(offered)).toMatchObject({ allowed: true });
  return { externalSessionId, secret: secret ?? held.sessionSecret };
};

const dispatchedSession = async (f: BootstrapRuntimeFixture) => {
  const { ownerSessionId } = await f.dispatchBootstrap();
  // The attestation and the RUN_DISPATCH turn, both finished: nothing is left on offer.
  await vi.waitFor(() => expect(f.finishedTurns(ownerSessionId)).toBe(2));
  return ownerSessionId;
};

describe("C1b relay: the credential crosses the launch channel once and the MCP socket once, and nowhere else", () => {
  it("takes the credential, authenticates, and carries the client's traffic both ways; the secret is in no output", async () => {
    await withBootstrapRuntime(async (f) => {
      const sessionId = await dispatchedSession(f);
      const { externalSessionId, secret } = await offer(f, sessionId);
      const run = await runRelay(f, externalSessionId);
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
      const { externalSessionId } = await offer(f, sessionId);
      expect((await runRelay(f, externalSessionId)).exitCode).toBe(0);
      const second = await runRelay(f, externalSessionId);
      expect(second.exitCode).toBe(3);
    });
  });

  it("a credential the daemon does not accept is refused at the handshake: exit 4 with the daemon's reason code", async () => {
    await withBootstrapRuntime(async (f) => {
      const sessionId = await dispatchedSession(f);
      const { externalSessionId, secret } = await offer(f, sessionId, "not-this-session's-secret-" + "y".repeat(16));
      const run = await runRelay(f, externalSessionId);
      expect(run.exitCode).toBe(4);
      expect(run.stderr.trim()).toBe("session-relay: handshake SESSION_SECRET_INVALID");
      expect(run.stdout).toBe("");
      expect(run.stderr).not.toContain(secret);
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

describe("C1b socket: a session asked to attest may answer that challenge and nothing else", () => {
  it("admits a STARTING session only while its challenge is pending, and only to session_attest", async () => {
    await withBootstrapRuntime(async (f) => {
      const created = f.harness.cp.sessions.create({ provider: "claude", model: "opus" });
      const credential = { sessionId: created.sessionId, sessionSecret: created.sessionSecret! };
      // No challenge: an unbound STARTING session is not a peer at all.
      expect(await openHeldCtoConnection(f.ctoSocket, credential)).toMatchObject({ refused: { ok: false } });

      const challenge = f.harness.cp.sessionAttestations.challenge(created.sessionId);
      if (!challenge.allowed) throw new Error(challenge.message);
      const held = await openHeldCtoConnection(f.ctoSocket, credential);
      if (!("call" in held)) throw new Error(`refused: ${JSON.stringify(held.refused)}`);
      expect(await held.call("role_dispatch_pending", {})).toMatchObject({
        ok: false,
        reasonCode: ReasonCode.MCP_PEER_UNAUTHENTICATED,
      });
      expect(await held.call("session_attest", { nonce: "att_not-the-challenge" })).toMatchObject({
        ok: false,
        reasonCode: ReasonCode.SESSION_ATTESTATION_FAILED,
      });
      expect(await held.call("session_attest", { nonce: challenge.value.nonce })).toMatchObject({ ok: true });
      expect(f.harness.cp.sessionAttestations.settle(created.sessionId, challenge.value.nonce).allowed).toBe(true);
      // Answered and settled: the connection it was admitted for is over.
      expect(await held.call("session_attest", { nonce: challenge.value.nonce })).toMatchObject({
        ok: false,
        reasonCode: ReasonCode.MCP_PEER_UNAUTHENTICATED,
      });
      held.close();
    });
  });
});
