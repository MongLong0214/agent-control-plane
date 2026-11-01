import type * as FsModule from "node:fs";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { parseVerificationCommand } from "../../src/contracts/verification-command.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { __testing as sandboxTesting, runSandboxed, type SandboxOutcome } from "../../src/verify/sandbox.ts";
import { cleanupTempDirs, makeRepo, tempDir } from "../helpers/fixtures.ts";
import { requireSeatbelt } from "../helpers/seatbelt.ts";

/**
 * A command whose contract says `network: "deny"` runs with the network denied (CEO decision on #1328,
 * which had opened it for every command): its seatbelt profile denies IP networking and every unix
 * socket outside its worktree and scratch, its own IPC inside them still works, and the result
 * records `deny` and `networkEnforced: true` only when that profile was in force. Where the denial
 * cannot be applied the command is refused, never run with the network open.
 */

// One case hides seatbelt, as on a host without it; one makes the profile impossible to build.
const fault = vi.hoisted(() => ({ hideSeatbelt: false, failProfile: false }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof FsModule>();
  const realpathSync = Object.assign(
    (path: FsModule.PathLike, options?: never) => {
      // The profile resolves the pinned runtime; nothing on the path to the profile asks for it.
      if (fault.failProfile && path === process.execPath) throw new Error("simulated profile build failure");
      return actual.realpathSync(path, options);
    },
    { native: actual.realpathSync.native },
  );
  return {
    ...actual,
    existsSync: (path: FsModule.PathLike) =>
      !(fault.hideSeatbelt && path === "/usr/bin/sandbox-exec") && actual.existsSync(path),
    realpathSync,
  };
});

afterEach(() => {
  fault.hideSeatbelt = false;
  fault.failProfile = false;
  cleanupTempDirs();
});

let tcpServer: Server;
let unixServer: Server;
let port = 0;
let socketDir = "";
let socketPath = "";
let accepted = 0;

beforeAll(async () => {
  const answer = (socket: Socket) => {
    accepted += 1;
    socket.on("error", () => undefined);
    socket.end("reached\n");
  };
  tcpServer = createServer(answer);
  port = await new Promise<number>((resolvePort, reject) => {
    tcpServer.once("error", reject);
    tcpServer.listen(0, "127.0.0.1", () => resolvePort((tcpServer.address() as AddressInfo).port));
  });
  // Outside every worktree and scratch the sandbox gives a command, and not a secret path.
  socketDir = mkdtempSync(join(tmpdir(), "acp-net-deny-sock-"));
  socketPath = join(socketDir, "local.sock");
  unixServer = createServer(answer);
  await new Promise<void>((resolveListen, reject) => {
    unixServer.once("error", reject);
    unixServer.listen(socketPath, () => resolveListen());
  });
});

afterAll(async () => {
  await Promise.all([tcpServer, unixServer].map((server) => new Promise<void>((done) => server.close(() => done()))));
  rmSync(socketDir, { recursive: true, force: true });
});

const described = (outcome: SandboxOutcome): string =>
  `sandbox ${outcome.status} exit=${outcome.exitCode} reason=${outcome.reasonCode ?? "none"} ` +
  `stdout: ${outcome.stdout.trim().slice(-1_000)} stderr: ${outcome.stderr.trim().slice(-1_000)}`;

/**
 * Leaves a marker in its worktree, tries an outbound TCP connect and a connect to a unix socket
 * outside, then binds and connects its own unix socket in the worktree and in TMPDIR (the scratch).
 */
const probeSource = (): string => `
  const fs = require('node:fs');
  const net = require('node:net');
  fs.writeFileSync('ran', 'ran');
  const attempt = (options) => new Promise((done) => {
    const socket = net.connect(options);
    const timer = setTimeout(() => { socket.destroy(); done('TIMEOUT'); }, 2_000);
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); done('CONNECTED'); });
    socket.once('error', (error) => { clearTimeout(timer); done(error.code ?? 'ERROR'); });
  });
  const ownSocket = (path) => new Promise((done) => {
    const server = net.createServer((socket) => socket.end('pong'));
    server.once('error', (error) => done('bind ' + error.code));
    server.listen(path, () => {
      const client = net.connect({ path });
      let data = '';
      client.on('data', (chunk) => { data += chunk; });
      client.on('error', (error) => { server.close(); done('connect ' + error.code); });
      client.on('end', () => { server.close(); done(data); });
    });
  });
  (async () => {
    const tcp = await attempt({ host: '127.0.0.1', port: ${port} });
    const unix = await attempt({ path: ${JSON.stringify(socketPath)} });
    const worktreeIpc = await ownSocket('ipc.sock');
    // By a relative path: the absolute one in TMPDIR is longer than a socket address holds.
    process.chdir(process.env.TMPDIR);
    const tmpdirIpc = await ownSocket('ipc.sock');
    console.log(JSON.stringify({ tcp, unix, worktreeIpc, tmpdirIpc }));
  })();
`;

const probe = async (network: "deny" | "allow", argv: string[] = ["node", "probe.cjs"]) => {
  const worktree = makeRepo();
  writeFileSync(join(worktree, "probe.cjs"), probeSource());
  accepted = 0;
  const outcome = await runSandboxed({
    command: parseVerificationCommand({ id: "net-probe", argv, network, timeoutSeconds: 60, maxMemoryMb: 1024 }),
    worktreePath: worktree,
    processLimit: "supervised-budget",
  });
  const lastLine = outcome.stdout.trim().split("\n").at(-1);
  return {
    outcome,
    connections: lastLine
      ? (JSON.parse(lastLine) as { tcp: string; unix: string; worktreeIpc: string; tmpdirIpc: string })
      : null,
    ran: existsSync(join(worktree, "ran")),
    accepted,
  };
};

describe("a declared network deny is enforced", () => {
  it("adds the denial to a deny command's profile and leaves an allow command's as it was", () => {
    const [worktree, scratch] = [tempDir("acp-net-deny-profile-"), tempDir("acp-net-deny-scratch-")];
    const open = sandboxTesting.seatbeltProfile(worktree, scratch, []).split("\n");
    const denied = sandboxTesting.seatbeltProfile(worktree, scratch, [], true).split("\n");
    const added = denied.filter((line) => !open.includes(line));
    expect(added).toEqual([
      "(deny network* (remote ip))",
      "(deny network* (local ip))",
      "(deny network* (remote unix-socket))",
      "(deny network* (local unix-socket))",
      `(allow network-bind (local unix-socket (subpath "${realpathSync(worktree)}")))`,
      `(allow network-bind (local unix-socket (subpath "${realpathSync(scratch)}")))`,
    ]);
    expect(denied.filter((line) => !added.includes(line))).toEqual(open);
  });

  it("denies an outbound TCP connect, and records deny as enforced", async (context) => {
    requireSeatbelt(context);
    const { outcome, connections, ran, accepted: reached } = await probe("deny");
    expect(outcome, described(outcome)).toMatchObject({
      status: "PASS",
      reasonCode: null,
      enforcement: { mechanism: "seatbelt", networkPolicy: "deny", networkEnforced: true },
    });
    expect(ran).toBe(true);
    expect(connections?.tcp).toBe("EPERM");
    expect(reached).toBe(0);
  });

  it("denies a unix-socket connect outside the worktree and scratch too", async (context) => {
    requireSeatbelt(context);
    const { outcome, connections, accepted: reached } = await probe("deny");
    expect(outcome, described(outcome)).toMatchObject({ status: "PASS", enforcement: { networkEnforced: true } });
    expect(connections?.unix).toBe("EPERM");
    expect(reached).toBe(0);
  });

  it("lets a deny command bind and connect its own unix socket in the worktree", async (context) => {
    requireSeatbelt(context);
    const { outcome, connections } = await probe("deny");
    expect(outcome, described(outcome)).toMatchObject({
      status: "PASS",
      enforcement: { networkPolicy: "deny", networkEnforced: true },
    });
    expect(connections?.worktreeIpc).toBe("pong");
  });

  it("lets a deny command bind and connect its own unix socket in TMPDIR, the scratch", async (context) => {
    requireSeatbelt(context);
    const { outcome, connections } = await probe("deny");
    expect(outcome, described(outcome)).toMatchObject({
      status: "PASS",
      enforcement: { networkPolicy: "deny", networkEnforced: true },
    });
    expect(connections?.tmpdirIpc).toBe("pong");
  });

  it("leaves an allow command's network open, and records allow as not enforced", async (context) => {
    requireSeatbelt(context);
    const { outcome, connections, ran, accepted: reached } = await probe("allow");
    expect(outcome, described(outcome)).toMatchObject({
      status: "PASS",
      reasonCode: null,
      enforcement: { mechanism: "seatbelt", networkPolicy: "allow", networkEnforced: false },
    });
    expect(ran).toBe(true);
    expect(connections).toEqual({ tcp: "CONNECTED", unix: "CONNECTED", worktreeIpc: "pong", tmpdirIpc: "pong" });
    expect(reached).toBe(2);
  });

  it("refuses a deny command where seatbelt is unavailable, without running it", async () => {
    fault.hideSeatbelt = true;
    const { outcome, connections, ran, accepted: reached } = await probe("deny");
    expect(outcome).toMatchObject({
      status: "ERROR",
      exitCode: null,
      reasonCode: ReasonCode.SANDBOX_NETWORK_DENIED,
      stdout: "",
      enforcement: { mechanism: "none", networkPolicy: "deny", networkEnforced: false },
    });
    expect(ran).toBe(false);
    expect(connections).toBeNull();
    expect(reached).toBe(0);
  });

  it("refuses a deny command whose profile cannot be built, without running it", async (context) => {
    requireSeatbelt(context);
    fault.failProfile = true;
    // /bin/sh, so resolving the launch never asks for the runtime the profile build fails on.
    const { outcome, ran, accepted: reached } = await probe("deny", ["/bin/sh", "-c", "node probe.cjs"]);
    expect(outcome).toMatchObject({
      status: "ERROR",
      exitCode: null,
      reasonCode: ReasonCode.SANDBOX_NETWORK_DENIED,
      enforcement: { mechanism: "seatbelt", networkPolicy: "deny", networkEnforced: false },
    });
    expect(outcome.stderr).toContain("network=deny");
    expect(ran).toBe(false);
    expect(reached).toBe(0);
  });
});
