import type * as ChildProcessModule from "node:child_process";
import { spawnSync, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import type * as FsModule from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

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

// One case hides seatbelt, as on a host without it; one makes the profile impossible to build; two
// make the real sandbox-exec refuse to apply its profile.
const fault = vi.hoisted(() => ({
  hideSeatbelt: false,
  failProfile: false,
  sandboxExec: null as null | "bad-profile" | "nested",
}));
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

/** An outer profile that applies, so the sandbox-exec run inside it is refused `sandbox_apply` (exit 71). */
const OUTER_PROFILE = '(version 1)\n(allow default)\n(deny file-read-data (literal "/nonexistent/acp-outer-sandbox"))';
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcessModule>();
  const spawn = ((file: string, args: readonly string[], options: SpawnOptions) => {
    if (file !== "/usr/bin/sandbox-exec" || fault.sandboxExec === null) return actual.spawn(file, args, options);
    // A profile sandbox-exec cannot compile (exit 65), or sandbox-exec inside another sandbox (exit 71).
    return fault.sandboxExec === "bad-profile"
      ? actual.spawn(file, ["-p", "(version 1)\n(no-such-rule)", ...args.slice(2)], options)
      : actual.spawn(file, ["-p", OUTER_PROFILE, file, ...args], options);
  }) as typeof actual.spawn;
  return { ...actual, spawn };
});

afterEach(() => {
  fault.hideSeatbelt = false;
  fault.failProfile = false;
  fault.sandboxExec = null;
  cleanupTempDirs();
});

let tcpServer: Server;
let unixServer: Server;
let port = 0;
let socketDir = "";
let socketPath = "";
let accepted = 0;

/** Every outside listener here answers the same way and counts what reached it. */
const answer = (socket: Socket): void => {
  accepted += 1;
  socket.on("error", () => undefined);
  socket.end("reached\n");
};

beforeAll(async () => {
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

const probe = async (network: "deny" | "allow", argv: string[] = ["node", "probe.cjs"], source = probeSource()) => {
  const worktree = makeRepo();
  writeFileSync(join(worktree, "probe.cjs"), source);
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

/**
 * Runs `run` while an outside listener serves `relative` inside a cache the profile lets a command
 * write (`SANDBOX_CACHE_HOME_PATHS`), under this file's HOME. Accepts count in `accepted`.
 */
const withCacheListener = async <T>(relative: string, run: (cached: string, cacheDir: string) => Promise<T>): Promise<T> => {
  const cacheDir = join(homedir(), ".npm", "acp-nd1");
  const cached = join(cacheDir, relative);
  mkdirSync(dirname(cached), { recursive: true });
  const listener = createServer(answer);
  await new Promise<void>((resolveListen, reject) => {
    listener.once("error", reject);
    listener.listen(cached, () => resolveListen());
  });
  try {
    return await run(cached, cacheDir);
  } finally {
    await new Promise<void>((done) => listener.close(() => done()));
    rmSync(cacheDir, { recursive: true, force: true });
  }
};

/** A probe that runs `body`, recording into `result`, then prints `result` as one JSON line. */
const moveProbe = (body: string): string => `
  const fs = require('node:fs');
  const net = require('node:net');
  const tried = (operation) => { try { operation(); return 'ok'; } catch (error) { return error.code; } };
  const attempt = (path) => new Promise((done) => {
    const socket = net.connect({ path });
    socket.once('connect', () => { socket.destroy(); done('CONNECTED'); });
    socket.once('error', (error) => done(error.code));
  });
  (async () => {
    const result = {};
    ${body}
    console.log(JSON.stringify(result));
  })();
`;

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
      "(deny job-creation)",
      '(deny mach-lookup (global-name "com.apple.coreservices.launchservicesd") (global-name "com.apple.lsd.mapdb"))',
      `(deny file-write* (require-all (vnode-type SOCKET) (require-not (subpath "${realpathSync(worktree)}")) (require-not (subpath "${realpathSync(scratch)}"))))`,
      `(deny file-write-unlink (require-all (vnode-type DIRECTORY) (require-not (subpath "${realpathSync(worktree)}")) (require-not (subpath "${realpathSync(scratch)}"))))`,
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

  it("refuses to rename or link an outside listener in a writable cache into the worktree", async (context) => {
    requireSeatbelt(context);
    const { outcome, connections, accepted: reached } = await withCacheListener("s.sock", (cached) => probe("deny", ["node", "probe.cjs"], moveProbe(`
      result.linked = tried(() => fs.linkSync(${JSON.stringify(cached)}, 'linked.sock'));
      result.linkedConnect = await attempt('linked.sock');
      result.renamed = tried(() => fs.renameSync(${JSON.stringify(cached)}, 'moved.sock'));
      result.renamedConnect = await attempt('moved.sock');
    `)));
    expect(outcome, described(outcome)).toMatchObject({
      status: "PASS",
      enforcement: { networkPolicy: "deny", networkEnforced: true },
    });
    expect(connections).toEqual({ linked: "EPERM", linkedConnect: "ENOENT", renamed: "EPERM", renamedConnect: "ENOENT" });
    expect(reached).toBe(0);
  });

  it("refuses to rename a cache directory holding an outside listener into the worktree", async (context) => {
    requireSeatbelt(context);
    const { outcome, connections, accepted: reached } = await withCacheListener("sub/s.sock", (_cached, cacheDir) => probe("deny", ["node", "probe.cjs"], moveProbe(`
      result.renamed = tried(() => fs.renameSync(${JSON.stringify(join(cacheDir, "sub"))}, 'sub'));
      result.renamedConnect = await attempt('sub/s.sock');
    `)));
    expect(outcome, described(outcome)).toMatchObject({
      status: "PASS",
      enforcement: { networkPolicy: "deny", networkEnforced: true },
    });
    expect(connections).toEqual({ renamed: "EPERM", renamedConnect: "ENOENT" });
    expect(reached).toBe(0);
  });

  it("refuses the same through a directory two levels above the listener", async (context) => {
    requireSeatbelt(context);
    const { outcome, connections, accepted: reached } = await withCacheListener("a/b/s.sock", (_cached, cacheDir) => probe("deny", ["node", "probe.cjs"], moveProbe(`
      result.renamed = tried(() => fs.renameSync(${JSON.stringify(join(cacheDir, "a"))}, 'a'));
      result.renamedConnect = await attempt('a/b/s.sock');
    `)));
    expect(outcome, described(outcome)).toMatchObject({
      status: "PASS",
      enforcement: { networkPolicy: "deny", networkEnforced: true },
    });
    expect(connections).toEqual({ renamed: "EPERM", renamedConnect: "ENOENT" });
    expect(reached).toBe(0);
  });

  it("still renames files in a cache and directories in its worktree, at the stated cost to cache directories", async (context) => {
    requireSeatbelt(context);
    const { outcome, connections } = await withCacheListener("s.sock", (_cached, cacheDir) => probe("deny", ["node", "probe.cjs"], moveProbe(`
      const cache = ${JSON.stringify(cacheDir)};
      fs.writeFileSync(cache + '/entry.tmp', 'cached');
      result.cacheFileRename = tried(() => fs.renameSync(cache + '/entry.tmp', cache + '/entry'));
      result.cacheMkdir = tried(() => fs.mkdirSync(cache + '/d1'));
      result.cacheDirRename = tried(() => fs.renameSync(cache + '/d1', cache + '/d2'));
      fs.mkdirSync('w1');
      result.worktreeDirRename = tried(() => fs.renameSync('w1', 'w2'));
    `)));
    expect(outcome, described(outcome)).toMatchObject({
      status: "PASS",
      enforcement: { networkPolicy: "deny", networkEnforced: true },
    });
    expect(connections).toEqual({ cacheFileRename: "ok", cacheMkdir: "ok", cacheDirRename: "EPERM", worktreeDirRename: "ok" });
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

  it.for([
    ["deny", "bad-profile", 65],
    ["deny", "nested", 71],
    ["allow", "nested", 71],
  ] as const)("refuses a %s command whose sandbox was not applied (%s, exit %d), without running it", async ([network, failure, exitCode], context) => {
    requireSeatbelt(context);
    fault.sandboxExec = failure;
    const { outcome, connections, ran, accepted: reached } = await probe(network);
    expect(outcome, described(outcome)).toMatchObject({
      status: "ERROR",
      reasonCode: ReasonCode.SANDBOX_NETWORK_DENIED,
      enforcement: { mechanism: "seatbelt", networkPolicy: network, networkEnforced: false },
    });
    expect(outcome.stderr).toContain(`sandbox-exec refused before starting anything (exit ${exitCode})`);
    expect(outcome.stderr).toContain("sandbox-exec:");
    expect(ran).toBe(false);
    expect(connections).toBeNull();
    expect(reached).toBe(0);
  });
});

/** Runs `argv` as a supervised verification command under `network`, in a fresh repository holding `files`. */
const runCommand = (network: "deny" | "allow", argv: string[], files: Record<string, string> = {}) => {
  const worktree = makeRepo();
  for (const [name, content] of Object.entries(files)) writeFileSync(join(worktree, name), content);
  return runSandboxed({
    command: parseVerificationCommand({ id: "delegation-probe", argv, network, timeoutSeconds: 120, maxMemoryMb: 2048 }),
    worktreePath: worktree,
    processLimit: "supervised-budget",
  });
};

const LAUNCH_SERVICES = ["com.apple.coreservices.launchservicesd", "com.apple.lsd.mapdb"] as const;

/** Looks each service up with `bootstrap_look_up` and prints its kern_return_t; nothing is launched. */
const LOOKUP_PY = `import ctypes, json, sys
libc = ctypes.CDLL("/usr/lib/libSystem.B.dylib")
bootstrap = ctypes.c_uint32.in_dll(libc, "bootstrap_port")
result = {}
for name in sys.argv[1:]:
    port = ctypes.c_uint32(0)
    result[name] = libc.bootstrap_look_up(bootstrap, name.encode(), ctypes.byref(port))
print(json.dumps(result))
`;

describe("a deny command cannot delegate a process to launchd or LaunchServices", () => {
  it("refuses launchctl submit from inside a deny command, and no job is left", async (context) => {
    requireSeatbelt(context);
    const label = `acp.test.deny-job-creation.${randomUUID()}`;
    const listed = (): boolean => spawnSync("/bin/launchctl", ["list", label], { stdio: "ignore" }).status === 0;
    try {
      const outcome = await runCommand("deny", ["node", "submit.cjs"], {
        "submit.cjs": `const { spawnSync } = require('node:child_process');
          const run = spawnSync('/bin/launchctl', ['submit', '-l', ${JSON.stringify(label)}, '--', '/usr/bin/true'], { encoding: 'utf8' });
          console.log(JSON.stringify({ status: run.status, error: run.error ? run.error.code : null }));`,
      });
      expect(outcome, described(outcome)).toMatchObject({
        status: "PASS",
        enforcement: { networkPolicy: "deny", networkEnforced: true },
      });
      const submitted = JSON.parse(outcome.stdout.trim()) as { status: number | null; error: string | null };
      expect(submitted.error).toBeNull();
      expect(submitted.status).not.toBe(0);
      expect(listed()).toBe(false);
    } finally {
      // Only this test's own label; any other job is left alone.
      spawnSync("/bin/launchctl", ["remove", label], { stdio: "ignore" });
    }
    expect(listed()).toBe(false);
  });

  it.for([
    ["deny", 1100],
    ["allow", 0],
  ] as const)("looks up the LaunchServices services from a %s command with kern_return %d", async ([network, expected], context) => {
    requireSeatbelt(context);
    const outcome = await runCommand(network, ["python3", "lookup.py", ...LAUNCH_SERVICES], { "lookup.py": LOOKUP_PY });
    expect(outcome, described(outcome)).toMatchObject({ status: "PASS", enforcement: { networkPolicy: network } });
    // 1100 is BOOTSTRAP_NOT_PRIVILEGED; 0 under allow proves both names exist, so a denial is not a typo.
    expect(JSON.parse(outcome.stdout.trim())).toEqual(Object.fromEntries(LAUNCH_SERVICES.map((name) => [name, expected])));
  });
});

describe("toolchains still run under deny", () => {
  it.for([
    ["node -e", ["node", "-e", "console.log('node ran')"], /node ran/],
    ["git status", ["git", "status", "--short"], /^/],
    ["npm --version", ["npm", "--version"], /^\d+\.\d+\.\d+/],
    ["pnpm --version", ["pnpm", "--version"], /^\d+\.\d+\.\d+/],
    ["python3 -c 1", ["python3", "-c", "1"], /^/],
    ["npm test (node --test)", ["npm", "test"], /pass 1/],
  ] as const)("%s", async ([, argv, stdout], context) => {
    requireSeatbelt(context);
    const outcome = await runCommand("deny", [...argv], {
      "package.json": JSON.stringify({ name: "deny-fixture", version: "1.0.0", private: true, scripts: { test: "node --test" } }),
      "adds.test.js": "const test = require('node:test');\nconst assert = require('node:assert');\ntest('adds', () => assert.strictEqual(1 + 1, 2));\n",
    });
    expect(outcome, described(outcome)).toMatchObject({
      status: "PASS",
      exitCode: 0,
      reasonCode: null,
      enforcement: { networkPolicy: "deny", networkEnforced: true },
    });
    expect(outcome.stdout).toMatch(stdout);
  });
});

describe("a sandbox that was not applied is told apart from an escape", () => {
  const notApplied = sandboxTesting.sandboxNotApplied;
  it("names sandbox-exec's own refusals, before any candidate was reported", () => {
    expect(notApplied(71, false, "sandbox-exec: sandbox_apply: Operation not permitted\n")).toBe(true);
    expect(notApplied(65, false, "sandbox-exec: unbound variable: no-such-rule at <input string>, line 2\n")).toBe(true);
  });

  it("does not, once a candidate was reported, since a candidate can print and exit the same way", () => {
    expect(notApplied(71, true, "sandbox-exec: sandbox_apply: Operation not permitted\n")).toBe(false);
  });

  it("does not for another exit status or for output that is not sandbox-exec's", () => {
    expect(notApplied(1, false, "sandbox-exec: sandbox_apply: Operation not permitted\n")).toBe(false);
    expect(notApplied(null, false, "sandbox-exec: sandbox_apply: Operation not permitted\n")).toBe(false);
    expect(notApplied(71, false, "")).toBe(false);
    expect(notApplied(71, false, "node: sandbox-exec: something else\n")).toBe(false);
  });
});
