import { afterAll, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  type PathLike,
  type Stats,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";

import { createHermesBootstrapAuthority } from "../../src/bootstrap/hermes-bootstrap.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Role, roleKeyFor } from "../../src/domain/types.ts";
import { SingleInstanceLock } from "../../src/daemon/single-instance.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { bindCeo, makeHarness, type Harness } from "../helpers/harness.ts";

vi.mock("node:fs", { spy: true });

afterAll(cleanupTempDirs);

const CEO_ROLE_KEY = roleKeyFor(Role.CEO);
const BOOTSTRAP_SOCKET_NAME = "hermes.bootstrap.sock";

const VALID_RUNTIME = String.raw`
const crypto = require("node:crypto");
const net = require("node:net");
const nonce = "mutation-runtime-possession-nonce-123";
const socket = net.createConnection(process.env.ACP_HERMES_BOOTSTRAP_SOCKET, () => {
  const runtimeProof = crypto.createHmac("sha256", process.env.ACP_HERMES_BOOTSTRAP_TOKEN)
    .update(nonce).digest("hex");
  socket.write(JSON.stringify({ runtimeNonce: nonce, runtimeProof }) + "\n");
});
socket.on("data", () => process.exit(0));
socket.on("error", () => process.exit(2));
`;

const GATED_RUNTIME = String.raw`
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const gatePath = process.argv[1];
const nonce = "mutation-gated-runtime-possession-nonce-123";
const connect = () => {
  if (!fs.existsSync(gatePath)) return setTimeout(connect, 10);
  const socket = net.createConnection(process.env.ACP_HERMES_BOOTSTRAP_SOCKET, () => {
    const runtimeProof = crypto.createHmac("sha256", process.env.ACP_HERMES_BOOTSTRAP_TOKEN)
      .update(nonce).digest("hex");
    socket.write(JSON.stringify({ runtimeNonce: nonce, runtimeProof }) + "\n");
  });
  socket.on("data", () => process.exit(0));
  socket.on("error", () => process.exit(2));
};
connect();
`;

const MARKED_RUNTIME = String.raw`
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
fs.writeFileSync(process.argv[1], String(process.pid));
const nonce = "mutation-marked-runtime-possession-nonce-123";
const socket = net.createConnection(process.env.ACP_HERMES_BOOTSTRAP_SOCKET, () => {
  const runtimeProof = crypto.createHmac("sha256", process.env.ACP_HERMES_BOOTSTRAP_TOKEN)
    .update(nonce).digest("hex");
  socket.write(JSON.stringify({ runtimeNonce: nonce, runtimeProof }) + "\n");
});
socket.on("data", () => process.exit(0));
socket.on("error", () => process.exit(2));
`;

const REPLAY_RUNTIME = String.raw`
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const resultPath = process.argv[1];
const nonce = "mutation-replay-runtime-possession-nonce-123";
const token = process.env.ACP_HERMES_BOOTSTRAP_TOKEN;
const runtimeProof = crypto.createHmac("sha256", token).update(nonce).digest("hex");
const line = JSON.stringify({ runtimeNonce: nonce, runtimeProof }) + "\n";
const responses = {};
const buffers = { first: "", replay: "" };
const record = (name, chunk) => {
  buffers[name] += chunk;
  const boundary = buffers[name].indexOf("\n");
  if (boundary === -1) return;
  responses[name] = JSON.parse(buffers[name].slice(0, boundary));
  if (responses.first && responses.replay) {
    fs.writeFileSync(resultPath, JSON.stringify(responses));
    process.exit(0);
  }
};
const first = net.createConnection(process.env.ACP_HERMES_BOOTSTRAP_SOCKET);
const replay = net.createConnection(process.env.ACP_HERMES_BOOTSTRAP_SOCKET);
first.setEncoding("utf8");
replay.setEncoding("utf8");
first.on("data", (chunk) => {
  record("first", chunk);
  if (responses.first) replay.write(line);
});
replay.on("data", (chunk) => record("replay", chunk));
first.on("error", () => process.exit(2));
replay.on("error", () => process.exit(3));
let connected = 0;
const sendFirst = () => {
  connected += 1;
  if (connected === 2) first.write(line);
};
first.once("connect", sendFirst);
replay.once("connect", sendFirst);
`;

const waitForPath = async (path: string, description: string, timeoutMs = 10_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}: ${path}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
};

const commandFor = (script: string, ...args: string[]): string[] => [
  process.execPath,
  "-e",
  script,
  ...args,
];

const bootstrapOptions = (stateDir: string, authorityHeld?: () => boolean) => ({
  stateDir,
  mcpSocketPath: join(stateDir, "hermes.mcp.sock"),
  mcpToken: "mutation-deployment-mcp-token",
  runtimeTimeoutMs: 5_000,
  ...(authorityHeld ? { authorityHeld } : {}),
});

const closeHarness = async (authority: { close(): Promise<void> }, harness: Harness): Promise<void> => {
  await authority.close();
  harness.cp.close();
};

const listenAt = (server: Server, path: string): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => resolve());
  });

describe("Hermes bootstrap mutation-sensitive coverage", () => {
  it("racing real bootstrap attempts bind exactly one generation-1 CEO and explicitly refuse the loser", async () => {
    const harness = makeHarness();
    const stateDir = tempDir("acp-hermes-mutation-race-");
    const authority = createHermesBootstrapAuthority(
      harness.cp,
      bootstrapOptions(stateDir),
    );

    try {
      const command = commandFor(VALID_RUNTIME);
      const decisions = await Promise.all([
        authority.bootstrap({ command, model: "race-first" }),
        authority.bootstrap({ command, model: "race-second" }),
      ]);
      const allowed = decisions.filter((decision) => decision.allowed);
      const refused = decisions.filter((decision) => !decision.allowed);

      expect(allowed).toHaveLength(1);
      expect(refused).toHaveLength(1);
      expect(refused[0]?.reasonCode).toBe(ReasonCode.CONFLICT);
      expect(harness.cp.bindings.history(CEO_ROLE_KEY).map((binding) => binding.bindingGeneration))
        .toEqual([1]);
    } finally {
      await closeHarness(authority, harness);
    }
  });

  it("rejects a competing CEO inserted after the initial check but before proof consumption", async () => {
    const harness = makeHarness();
    const stateDir = tempDir("hb-h-");
    const gatePath = join(stateDir, "release-proof");
    const authority = createHermesBootstrapAuthority(
      harness.cp,
      bootstrapOptions(stateDir),
    );

    try {
      const bootstrap = authority.bootstrap({
        command: commandFor(GATED_RUNTIME, gatePath),
      });
      await waitForPath(join(stateDir, BOOTSTRAP_SOCKET_NAME), "bootstrap door after initial authority check");

      const competingSessionId = bindCeo(harness);
      const revoked = harness.cp.bindings.revoke(CEO_ROLE_KEY, "revoke competing CEO before proof");
      expect(revoked.allowed).toBe(true);
      writeFileSync(gatePath, "proof may now be consumed\n", { mode: 0o600 });
      const result = await bootstrap;

      expect(result.allowed).toBe(false);
      expect(result.reasonCode).toBe(ReasonCode.HERMES_BOOTSTRAP_ALREADY_INITIALIZED);
      expect(harness.cp.bindings.active(CEO_ROLE_KEY)).toBeNull();
      expect(harness.cp.bindings.history(CEO_ROLE_KEY).map((binding) => binding.sessionId))
        .toEqual([competingSessionId]);
      expect(harness.cp.bindings.history(CEO_ROLE_KEY).map((binding) => binding.bindingGeneration))
        .toEqual([1]);
    } finally {
      await closeHarness(authority, harness);
    }
  });

  const runLockLossCase = async (sourceLine: 157 | 259, label: string): Promise<void> => {
    const harness = makeHarness();
    const stateDir = tempDir(`hb-l-${label.slice(0, 2)}-`);
    const launchedPath = join(stateDir, "runtime-launched");
    const lock = new SingleInstanceLock(join(stateDir, "agentcpd.lock"));
    const acquired = lock.acquire(harness.clock.nowIso());
    expect(acquired.allowed).toBe(true);
    const authorityHeld = (): boolean => {
      const stack = new Error().stack ?? "";
      if (stack.split("\n").some((frame) => frame.includes(`hermes-bootstrap.ts:${sourceLine}:`))) {
        lock.release();
      }
      return lock.held();
    };
    const authority = createHermesBootstrapAuthority(
      harness.cp,
      bootstrapOptions(stateDir, authorityHeld),
    );

    try {
      const resultPromise = authority.bootstrap({
        command: commandFor(MARKED_RUNTIME, launchedPath),
      });
      await waitForPath(launchedPath, "Hermes runtime launch before lock loss");
      const result = await resultPromise;

      expect(result.allowed).toBe(false);
      expect(result.reasonCode).toBe(ReasonCode.DAEMON_LOCK_LOST);
      expect(harness.cp.bindings.history(CEO_ROLE_KEY)).toHaveLength(0);
    } finally {
      await authority.close();
      lock.release();
      harness.cp.close();
    }
  };

  it("refuses when the daemon lock is lost at the first post-launch fence", async () => {
    await runLockLossCase(157, "first-fence");
  });

  it("refuses when the daemon lock is lost at the pre-constitution fence", async () => {
    await runLockLossCase(259, "constitution-fence");
  });

  it("does not launch Hermes after losing the lock when the bootstrap door opens", async () => {
    const harness = makeHarness();
    const stateDir = tempDir("hb-l-prelaunch-");
    const launchedPath = join(stateDir, "runtime-launched");
    const lock = new SingleInstanceLock(join(stateDir, "agentcpd.lock"));
    const acquired = lock.acquire(harness.clock.nowIso());
    expect(acquired.allowed).toBe(true);
    const authorityHeld = (): boolean => {
      const stack = new Error().stack ?? "";
      if (stack.split("\n").some((frame) => frame.includes("hermes-bootstrap.ts:170:"))) {
        lock.release();
      }
      return lock.held();
    };
    const authority = createHermesBootstrapAuthority(
      harness.cp,
      bootstrapOptions(stateDir, authorityHeld),
    );

    try {
      const result = await authority.bootstrap({
        command: commandFor(MARKED_RUNTIME, launchedPath),
      });

      expect(existsSync(launchedPath)).toBe(false);
      expect(result.allowed).toBe(false);
      expect(result.reasonCode).toBe(ReasonCode.DAEMON_LOCK_LOST);
      expect(harness.cp.bindings.history(CEO_ROLE_KEY)).toHaveLength(0);
    } finally {
      await authority.close();
      lock.release();
      harness.cp.close();
    }
  });

  it("refuses a proof replay from a connection that was already preconnected", async () => {
    const harness = makeHarness();
    const stateDir = tempDir("hb-r-");
    const replayPath = join(stateDir, "replay-result.json");
    const authority = createHermesBootstrapAuthority(
      harness.cp,
      bootstrapOptions(stateDir),
    );

    try {
      const result = await authority.bootstrap({
        command: commandFor(REPLAY_RUNTIME, replayPath),
      });
      await waitForPath(replayPath, "preconnected proof replay response");
      const replay = JSON.parse(readFileSync(replayPath, "utf8")) as {
        first: { ok: boolean };
        replay: { ok: boolean; reasonCode: string };
      };

      expect(result.allowed).toBe(true);
      expect(replay.first.ok).toBe(true);
      expect(replay.replay.ok).toBe(false);
      expect(replay.replay.reasonCode).toBe(ReasonCode.HERMES_BOOTSTRAP_PROOF_INVALID);
      expect(harness.cp.bindings.history(CEO_ROLE_KEY).map((binding) => binding.bindingGeneration))
        .toEqual([1]);
    } finally {
      await closeHarness(authority, harness);
    }
  });

  it("refuses a READY session whose verified incarnation does not match the created lifetime", async () => {
    const harness = makeHarness();
    const stateDir = tempDir("hb-i-");
    const originalVerifySecret = harness.cp.sessions.verifySecret.bind(harness.cp.sessions);
    const verifySecret = vi.spyOn(harness.cp.sessions, "verifySecret");
    verifySecret.mockImplementation((sessionId, sessionSecret) => {
      const verified = originalVerifySecret(sessionId, sessionSecret);
      if (!verified.allowed) return verified;
      return {
        ...verified,
        value: { ...verified.value, incarnation: `${verified.value.incarnation}-mismatch` },
      };
    });
    const authority = createHermesBootstrapAuthority(
      harness.cp,
      bootstrapOptions(stateDir),
    );

    try {
      const result = await authority.bootstrap({ command: commandFor(VALID_RUNTIME) });

      expect(result.allowed).toBe(false);
      expect(result.reasonCode).toBe(ReasonCode.SESSION_NOT_READY);
      expect(harness.cp.bindings.history(CEO_ROLE_KEY)).toHaveLength(0);
    } finally {
      verifySecret.mockRestore();
      await closeHarness(authority, harness);
    }
  });

  it("refuses a persisted generation-2 bind, revokes it, and leaves no active CEO", async () => {
    const harness = makeHarness();
    const stateDir = tempDir("hb-g1-");
    const originalBind = harness.cp.bindings.bind.bind(harness.cp.bindings);
    const bind = vi.spyOn(harness.cp.bindings, "bind");
    const revoke = vi.spyOn(harness.cp.bindings, "revoke");
    bind.mockImplementation((input) => {
      const first = originalBind(input);
      if (!first.allowed) return first;
      // Keep the real persistence path, but force this injected bind boundary to return
      // the next persisted generation. The production fence must reject that result.
      return harness.cp.bindings.switchTo({
        ...input,
        reason: "mutation test forced a generation-2 bootstrap bind",
      });
    });
    const authority = createHermesBootstrapAuthority(
      harness.cp,
      bootstrapOptions(stateDir),
    );

    try {
      const result = await authority.bootstrap({ command: commandFor(VALID_RUNTIME) });
      const history = harness.cp.bindings.history(CEO_ROLE_KEY);

      expect(bind).toHaveBeenCalledTimes(1);
      expect(result.allowed).toBe(false);
      expect(result.reasonCode).toBe(ReasonCode.HERMES_BOOTSTRAP_ALREADY_INITIALIZED);
      expect(revoke).toHaveBeenCalledWith(CEO_ROLE_KEY, "Hermes bootstrap did not mint generation 1");
      expect(history.map((binding) => binding.bindingGeneration)).toEqual([1, 2]);
      expect(history.map((binding) => binding.status)).toEqual(["REVOKED", "REVOKED"]);
      expect(harness.cp.bindings.active(CEO_ROLE_KEY)).toBeNull();
    } finally {
      bind.mockRestore();
      revoke.mockRestore();
      await closeHarness(authority, harness);
    }
  });

  it("refuses a foreign-owner stale socket with an acceptable mode without unlinking or reusing it", async () => {
    const harness = makeHarness();
    const stateDir = tempDir("hb-s-owner-");
    const socketPath = join(stateDir, BOOTSTRAP_SOCKET_NAME);
    const stale = createServer();
    await listenAt(stale, socketPath);
    chmodSync(socketPath, 0o600);
    const actualFs = await vi.importActual<{ lstatSync(path: PathLike): Stats }>("node:fs");
    const realLstatSync = actualFs.lstatSync;
    const staleBefore = realLstatSync(socketPath);
    const foreignUid = staleBefore.uid + 1;
    const stat = vi.mocked(lstatSync);
    stat.mockImplementation((path) => {
      const observed = realLstatSync(String(path));
      if (String(path) === socketPath) observed.uid = foreignUid;
      return observed;
    });
    const authority = createHermesBootstrapAuthority(
      harness.cp,
      bootstrapOptions(stateDir),
    );

    try {
      const result = await authority.bootstrap({ command: commandFor(VALID_RUNTIME) });

      expect(result.allowed).toBe(false);
      expect(result.reasonCode).toBe(ReasonCode.HERMES_BOOTSTRAP_RUNTIME_FAILED);
      expect(String(result.evidence.error)).toContain("insecure Hermes bootstrap socket");
      expect(existsSync(socketPath)).toBe(true);
      const staleAfter = realLstatSync(socketPath);
      expect(staleAfter.ino).toBe(staleBefore.ino);
      expect(staleAfter.mode & 0o777).toBe(0o600);
      expect(harness.cp.bindings.history(CEO_ROLE_KEY)).toHaveLength(0);
    } finally {
      stat.mockImplementation(realLstatSync);
      await closeHarness(authority, harness);
      await new Promise<void>((resolve, reject) => stale.close((error) => error ? reject(error) : resolve()));
      if (existsSync(socketPath)) unlinkSync(socketPath);
    }
  });

  it("refuses an insecure stale bootstrap socket without unlinking or reusing it", async () => {
    const harness = makeHarness();
    const stateDir = tempDir("hb-s-");
    const socketPath = join(stateDir, BOOTSTRAP_SOCKET_NAME);
    const stale = createServer();
    await listenAt(stale, socketPath);
    chmodSync(socketPath, 0o666);
    const authority = createHermesBootstrapAuthority(
      harness.cp,
      bootstrapOptions(stateDir),
    );

    try {
      const result = await authority.bootstrap({ command: commandFor(VALID_RUNTIME) });

      expect(result.allowed).toBe(false);
      expect(result.reasonCode).toBe(ReasonCode.HERMES_BOOTSTRAP_RUNTIME_FAILED);
      expect(String(result.evidence.error)).toContain("insecure Hermes bootstrap socket");
      expect(existsSync(socketPath)).toBe(true);
      expect(lstatSync(socketPath).mode & 0o777).toBe(0o666);
      expect(harness.cp.bindings.history(CEO_ROLE_KEY)).toHaveLength(0);
    } finally {
      await closeHarness(authority, harness);
      await new Promise<void>((resolve, reject) => stale.close((error) => error ? reject(error) : resolve()));
      if (existsSync(socketPath)) unlinkSync(socketPath);
    }
  });
});
