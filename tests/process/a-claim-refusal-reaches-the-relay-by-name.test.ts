import { mkdtempSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ATTACH_EXIT, runAttachRelay, type AttachRelayClaim } from "../../src/cli/attach-relay.ts";
import { type Decision, allow, deny } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import {
  CANONICAL_SELF_CLAIM_METHOD,
  startCanonicalSelfClaimListener,
  type CanonicalSelfClaimListener,
} from "../../src/daemon/canonical-self-claim-listener.ts";
import { SelfClaimRefusal } from "../../src/registry/canonical-self-claim.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";

/** R1154-01: nothing this relay runs under may inherit the vitest worker's session messaging. */
vi.hoisted(() => {
  for (const name of Object.keys(process.env)) {
    if (name.startsWith("CLAUDE_CODE_MESSAGING_")) delete process.env[name];
  }
});

/**
 * The claim socket's answer to a refusal, read by the relay that asked. The real listener — the kernel peer check,
 * the framing, `publicClaimResponse` — sits between a scripted handler and the real relay, so what is measured is
 * what crosses that socket: the reason code and the fixed name of the refusing branch, and nothing else of the
 * denial; and a relay that reads a name it may ask again after does, and then attaches.
 */

const roots: string[] = [];
const listeners: CanonicalSelfClaimListener[] = [];
const servers: Server[] = [];
const sockets: Socket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const listener of listeners.splice(0)) await listener.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  cleanupTempDirs();
});

/** `/tmp` directly, for the `sun_path` margin the sibling listener tests give. */
const root = (): string => {
  const dir = mkdtempSync(join("/tmp", "acrn-"));
  roots.push(dir);
  return dir;
};

const SECRET_PATH = "/Users/someone/.agent-control-plane/private-detail";

/** A listener whose handler answers each call with the next decision (the last repeats) and keeps each request. */
const scriptedListener = async (decisions: Decision<unknown>[]) => {
  const asked: Record<string, unknown>[] = [];
  const listener = await startCanonicalSelfClaimListener({ lock: { held: () => true } }, root(), async (_peer, params) => {
    asked.push(params);
    return decisions[Math.min(asked.length - 1, decisions.length - 1)]!;
  });
  listeners.push(listener);
  return { socketPath: listener.socketPath, asked };
};

const rawAnswer = (socketPath: string): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let received = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify({ method: CANONICAL_SELF_CLAIM_METHOD, params: {} })}\n`));
    socket.on("data", (chunk: string) => {
      received += chunk;
      if (received.includes("\n")) {
        socket.end();
        resolve(JSON.parse(received.trim()) as unknown);
      }
    });
    socket.once("error", reject);
  });

/** Stands in for `cto.mcp.sock`: keeps the relay's handshake line, then refuses it so the relay ends. */
const handshakeRecorder = async (dir: string) => {
  const lines: string[] = [];
  const path = join(dir, "m.sock");
  const server = createServer((socket) => {
    sockets.push(socket);
    socket.once("data", (chunk: Buffer) => {
      lines.push(chunk.toString("utf8").split("\n")[0]!);
      socket.end(`${JSON.stringify({ ok: false, reasonCode: ReasonCode.MCP_PEER_UNAUTHENTICATED })}\n`);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  return { path, lines };
};

const relay = (claimSocketPath: string, mcpSocketPath: string, claim: AttachRelayClaim, nextGeneration?: () => Promise<number>) => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let err = "";
  stderr.on("data", (chunk: Buffer) => {
    err += chunk.toString("utf8");
  });
  const exit = runAttachRelay({
    claimSocketPath, mcpSocketPath, mcpToken: "test-token", claim,
    ...(nextGeneration ? { nextGeneration } : {}),
    claimRetry: { initialDelayMs: 20, maxDelayMs: 40, maxWaitMs: 2_000 },
  }, { stdin, stdout, stderr });
  return { exit, err: () => err };
};

const CLAIM: AttachRelayClaim = { claimedSessionUuid: "04a1b7e9-0000-4000-8000-000000000002", projectId: "prj_logic", expectedBindingGeneration: "auto" };
const RECEIPT = allow(ReasonCode.OK, { sessionId: "ses_relay_test", sessionSecret: "relay-test-secret" });

describe("a claim refusal reaches the relay by name through the real claim socket", () => {
  it("sends the branch name and nothing else of the denial; a free-text reason is not a name and is not sent", async () => {
    const named = await scriptedListener([deny(ReasonCode.CONFLICT, `still starting, see ${SECRET_PATH}`, {
      reason: SelfClaimRefusal.DAEMON_STARTING, path: SECRET_PATH,
    })]);
    expect(await rawAnswer(named.socketPath)).toEqual({ allowed: false, reasonCode: ReasonCode.CONFLICT, reason: "DAEMON_STARTING" });

    const prose = await scriptedListener([deny(ReasonCode.CONFLICT, "refused", { reason: `mode is 755 at ${SECRET_PATH}` })]);
    expect(await rawAnswer(prose.socketPath)).toEqual({ allowed: false, reasonCode: ReasonCode.CONFLICT });
  });

  it("a relay told DAEMON_STARTING asks again with the generation it reads, is admitted, and presents the receipt", async () => {
    const claims = await scriptedListener([deny(ReasonCode.CONFLICT, `still starting, see ${SECRET_PATH}`, {
      reason: SelfClaimRefusal.DAEMON_STARTING, path: SECRET_PATH,
    }), RECEIPT]);
    const mcp = await handshakeRecorder(roots[roots.length - 1]!);
    const run = relay(claims.socketPath, mcp.path, CLAIM, async () => 3);

    expect(await run.exit).toBe(ATTACH_EXIT.HANDSHAKE_REFUSED);
    expect(claims.asked.map((params) => params["expectedBindingGeneration"])).toEqual([3, 3]);
    expect(run.err().split("\n")[0]).toBe(`attach: claim refused ${ReasonCode.CONFLICT} DAEMON_STARTING; retrying`);
    expect(run.err()).not.toContain(SECRET_PATH);
    // The second attempt's receipt is what the relay presented: one handshake, naming that session.
    expect(mcp.lines).toHaveLength(1);
    expect(JSON.parse(mcp.lines[0]!)).toMatchObject({ sessionId: "ses_relay_test" });
  });

  it("a relay told a refusal that cannot clear exits on the first answer and names it", async () => {
    const claims = await scriptedListener([deny(ReasonCode.CONFLICT, "not entitled", { reason: SelfClaimRefusal.SESSION_NOT_ENTITLED }), RECEIPT]);
    const mcp = await handshakeRecorder(roots[roots.length - 1]!);
    const run = relay(claims.socketPath, mcp.path, CLAIM, async () => 3);

    expect(await run.exit).toBe(ATTACH_EXIT.CLAIM_REFUSED);
    expect(claims.asked).toHaveLength(1);
    expect(run.err()).toBe(`attach: claim refused ${ReasonCode.CONFLICT} SESSION_NOT_ENTITLED\n`);
    expect(mcp.lines).toEqual([]);
  });
});
