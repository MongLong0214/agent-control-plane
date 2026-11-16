import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ATTACH_EXIT, runAttachRelayCommand } from "../../src/cli/attach-relay.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { clearSessionMessagingEnv } from "../helpers/session-messaging-env.ts";

/**
 * A role-holding attach whose session cannot be woken is refused at launch, before the relay
 * connects to anything: the daemon accepts a wake endpoint only directly inside its state
 * directory, so a session started with its messaging socket anywhere else attaches, works, and is
 * silently unwakeable.
 */
vi.hoisted(() => {
  for (const name of Object.keys(process.env)) {
    if (name.startsWith("CLAUDE_CODE_MESSAGING_")) delete process.env[name];
  }
});
beforeEach(() => {
  clearSessionMessagingEnv();
  // The fallback claim presents the deployment token; with none the relay stops before it connects.
  vi.stubEnv("ACP_MCP_TOKEN", "token-for-the-test");
});

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  clearSessionMessagingEnv();
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const listen = (path: string, onConnection: () => void = () => undefined): Promise<Server> =>
  new Promise((resolve, reject) => {
    const server = createServer((socket) => {
      onConnection();
      socket.on("error", () => undefined);
      socket.once("data", () => {
        socket.end(`${JSON.stringify({ allowed: false, reasonCode: ReasonCode.BINDING_ALREADY_ACTIVE })}\n`);
      });
    });
    servers.push(server);
    server.once("error", reject);
    server.listen(path, () => resolve(server));
  });

const scratch = (): string => {
  const dir = mkdtempSync("/tmp/acpas-");
  roots.push(dir);
  return dir;
};

const attach = async (stateDir: string, messagingSocket: string | undefined) => {
  let connections = 0;
  await listen(join(stateDir, "c.sock"), () => (connections += 1));
  if (messagingSocket !== undefined) {
    process.env["CLAUDE_CODE_MESSAGING_SOCKET"] = messagingSocket;
    process.env["CLAUDE_CODE_MESSAGING_TOKEN"] = "token-for-the-test";
  }
  const stderr = new PassThrough();
  let err = "";
  stderr.on("data", (chunk: Buffer) => (err += chunk.toString("utf8")));
  const code = await runAttachRelayCommand(
    {
      claimSocketPath: join(stateDir, "c.sock"),
      mcpSocketPath: join(stateDir, "cto.mcp.sock"),
      claim: { claimedSessionUuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", projectId: "p", expectedBindingGeneration: 1 },
      stateDir,
    },
    { stdin: new PassThrough(), stdout: new PassThrough(), stderr },
  );
  return { code, err, connections: () => connections };
};

describe("attach canonical-cto requires a wakeable messaging socket", () => {
  it("refuses a socket outside the state directory, names the fix, and connects to nothing", async () => {
    const state = scratch();
    const elsewhere = scratch();
    await listen(join(elsewhere, "cc.sock"));
    const run = await attach(state, join(elsewhere, "cc.sock"));
    expect(run.code).toBe(ATTACH_EXIT.USAGE);
    expect(run.err).toContain(`start Claude Code with --messaging-socket-path ${state}/cc-session-<name>.sock`);
    expect(run.err.trim().split("\n")).toHaveLength(1);
    expect(run.connections()).toBe(0);
  });

  it("refuses a session that has no messaging socket", async () => {
    const state = scratch();
    const run = await attach(state, undefined);
    expect(run.code).toBe(ATTACH_EXIT.USAGE);
    expect(run.err).toContain("start Claude Code with --messaging-socket-path");
    expect(run.connections()).toBe(0);
  });

  it("refuses a socket in a subdirectory of the state directory", async () => {
    const state = scratch();
    const run = await attach(state, join(state, "sub", "cc.sock"));
    expect(run.code).toBe(ATTACH_EXIT.USAGE);
    expect(run.connections()).toBe(0);
  });

  it("starts as before when the socket is directly inside the state directory", async () => {
    const state = scratch();
    await listen(join(state, "cc-session-cto.sock"));
    const run = await attach(state, join(state, "cc-session-cto.sock"));
    expect(run.err).not.toContain("cannot be woken");
    expect(run.connections()).toBe(1);
    expect(run.code).toBe(ATTACH_EXIT.CLAIM_REFUSED);
  });
});
