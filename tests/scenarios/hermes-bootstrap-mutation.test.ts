import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
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

import { digestOf } from "../../src/core/digest.ts";
import { runHermesTargetBind } from "../../src/runtime/hermes-target-bind.ts";
import { createHermesBootstrapAuthority } from "../../src/bootstrap/hermes-bootstrap.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Role, roleKeyFor } from "../../src/domain/types.ts";
import { SingleInstanceLock } from "../../src/daemon/single-instance.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { bindCeo, makeHarness, type Harness } from "../helpers/harness.ts";

vi.mock("node:fs", { spy: true });
vi.mock("../../src/runtime/hermes-target-bind.ts", async (original) => ({
  ...(await original<typeof import("../../src/runtime/hermes-target-bind.ts")>()),
  runHermesTargetBind: vi.fn(),
}));

afterAll(cleanupTempDirs);

const CEO_ROLE_KEY = roleKeyFor(Role.CEO);
const BOOTSTRAP_SOCKET_NAME = "hermes.bootstrap.sock";
const TARGET = {
  hermesExecutable: "/opt/owner/hermes", hermesProfile: "owner-profile", hermesHome: "/opt/owner/home",
  requestedSessionId: "hermes-owner-session", expectedLineageRootDigest: digestOf({ root: "owner" }),
  executorRuntimeIdentity: "acp-runtime:owner",
};
const withTarget = (input: { command: readonly string[]; model?: string }) => ({ ...input, ...TARGET });

beforeEach(() => {
  vi.mocked(runHermesTargetBind).mockImplementation((input) => {
    const receipt = {
      domain: "hermes.target-bind" as const, version: 1 as const, actor_id: input.actorId,
      binding_generation: input.bindingGeneration, executor_runtime_identity: input.executorRuntimeIdentity,
      requested_session_id: input.sessionId, lineage_root_digest: input.expectedLineageRootDigest,
    };
    return { allowed: true, value: { ...receipt, receipt_digest: digestOf(receipt) } };
  });
});

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
  it("atomically records an exact target-bind v1 attestation for the new CEO assignment", async () => {
    const harness = makeHarness();
    const authority = createHermesBootstrapAuthority(harness.cp, bootstrapOptions(tempDir("hb-attest-")));
    try {
      const result = await authority.bootstrap(withTarget({ command: commandFor(VALID_RUNTIME) }));
      expect(result.allowed).toBe(true);
      const binding = harness.cp.db.get<{ actor_id: string; assignment_id: string; binding_generation: number }>(
        "SELECT actor_id, assignment_id, binding_generation FROM assignments WHERE role_key = ?", [CEO_ROLE_KEY],
      );
      expect(harness.cp.db.get("SELECT target_binding_id FROM actor_target_bindings")).toBeDefined();
      expect(harness.cp.db.get<{ protocol_version: string; assignment_id: string; binding_generation: number }>(
        "SELECT protocol_version, assignment_id, binding_generation FROM actor_target_attestations",
      )).toMatchObject({ protocol_version: "hermes.target-bind/v1", assignment_id: binding?.assignment_id, binding_generation: binding?.binding_generation });
    } finally { await closeHarness(authority, harness); }
  });
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
        authority.bootstrap(withTarget({ command, model: "race-first" })),
        authority.bootstrap(withTarget({ command, model: "race-second" })),
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
      const bootstrap = authority.bootstrap(withTarget({
        command: commandFor(GATED_RUNTIME, gatePath),
      }));
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

  // Each authority fence is named by **what it says**, not by where it sits.
  //
  // These cases used to select a fence by matching `hermes-bootstrap.ts:<line>:` in a stack
  // frame. A four-line doc comment above an unrelated constant moved every fence and all three
  // released at no fence at all. That failure was loud, which was luck: a shift that lands one
  // fence's number on another leaves the test green while checking the wrong one.
  //
  // The trigger is the call ordinal, measured rather than assumed — in a run that completes the
  // fences are reached 112, 171, 158, 266, in that order. `158` sits between the other two in
  // the file and is reached third, because it is inside the bootstrap-door callback and that
  // callback only runs once the runtime connects. An earlier attempt at this conversion read an
  // instrumented run that aborted before the runtime connected, saw no 158 at all, and stopped.
  //
  // The ordinal is only the trigger. **The assertion is the message**, which is unique per fence
  // and moves with it. If a fence is added the ordinals shift, and each case then fails naming
  // the fence it actually reached instead of quietly checking a neighbour.
  const FENCES = {
    entry: { ordinal: 1, says: "daemon lock is not held for Hermes bootstrap" },
    preLaunch: { ordinal: 2, says: "daemon lock was lost before Hermes runtime launch" },
    duringDoor: { ordinal: 3, says: "daemon lock was lost during Hermes bootstrap" },
    constitution: { ordinal: 4, says: "daemon lock was lost before CEO constitution" },
  } as const;

  const releasingAt = (ordinal: number, lock: SingleInstanceLock): (() => boolean) => {
    let reached = 0;
    return () => {
      reached += 1;
      if (reached === ordinal) lock.release();
      return lock.held();
    };
  };

  const runLockLossCase = async (
    fence: { ordinal: number; says: string },
    label: string,
    expectLaunched: boolean,
  ): Promise<void> => {
    const harness = makeHarness();
    const stateDir = tempDir(`hb-l-${label.slice(0, 2)}-`);
    const launchedPath = join(stateDir, "runtime-launched");
    const lock = new SingleInstanceLock(join(stateDir, "agentcpd.lock"));
    const acquired = lock.acquire(harness.clock.nowIso());
    expect(acquired.allowed).toBe(true);
    const authority = createHermesBootstrapAuthority(
      harness.cp,
      bootstrapOptions(stateDir, releasingAt(fence.ordinal, lock)),
    );

    try {
      const resultPromise = authority.bootstrap(withTarget({
        command: commandFor(MARKED_RUNTIME, launchedPath),
      }));
      if (expectLaunched) await waitForPath(launchedPath, "Hermes runtime launch before lock loss");
      const result = await resultPromise;

      expect(result.allowed).toBe(false);
      // `Decision` is a discriminated union and `message` lives only on the refusal arm, so the
      // narrowing is real rather than a cast. A cast here would let a future `allowed: true`
      // reach the message assertion as `undefined` and read as a fence that said nothing.
      if (result.allowed) throw new Error("expected a refusal at the fence under test");
      expect(result.reasonCode).toBe(ReasonCode.DAEMON_LOCK_LOST);
      // The fence that answered is the fence this case is about. Without this the ordinal is an
      // unchecked guess and a shift would move the case onto a neighbour in silence.
      expect(result.message).toBe(fence.says);
      expect(existsSync(launchedPath)).toBe(expectLaunched);
      expect(harness.cp.bindings.history(CEO_ROLE_KEY)).toHaveLength(0);
    } finally {
      await authority.close();
      lock.release();
      harness.cp.close();
    }
  };

  it("names every authority fence the source actually has", () => {
    // The ordinals above are positions in a sequence, so a fence added anywhere renumbers the
    // ones after it. This is what notices, and it fails at the table rather than inside a case.
    const source = readFileSync(
      new URL("../../src/bootstrap/hermes-bootstrap.ts", import.meta.url),
      "utf8",
    );
    const said = [...source.matchAll(
      /authorityHeld\(\)\)\s*\{[\s\S]{0,200}?ReasonCode\.DAEMON_LOCK_LOST,\s*"([^"]+)"/g,
    )].map((m) => m[1]);

    // Compared as a set. Source order is not call order — `duringDoor` sits second in the file
    // and is reached third, because its callback waits for the runtime to connect. The ordinal
    // mapping is proved by the four cases below, each asserting the message it reached; this
    // one only checks that the table names every fence the source has, and no others.
    expect([...said].sort()).toEqual(Object.values(FENCES).map((f) => f.says).sort());
  });

  it("refuses when the daemon lock is lost before the bootstrap even begins", async () => {
    // The entry fence had no case at all while three line numbers were being maintained for the
    // other three.
    await runLockLossCase(FENCES.entry, "entry-fence", false);
  });

  it("does not launch Hermes after losing the lock when the bootstrap door opens", async () => {
    await runLockLossCase(FENCES.preLaunch, "prelaunch-fence", false);
  });

  it("refuses when the daemon lock is lost at the first post-launch fence", async () => {
    await runLockLossCase(FENCES.duringDoor, "during-fence", true);
  });

  it("refuses when the daemon lock is lost at the pre-constitution fence", async () => {
    await runLockLossCase(FENCES.constitution, "constitution-fence", true);
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
      const result = await authority.bootstrap(withTarget({
        command: commandFor(REPLAY_RUNTIME, replayPath),
      }));
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
      const result = await authority.bootstrap(withTarget({ command: commandFor(VALID_RUNTIME) }));

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
        conversation: "REPLACED",
      });
    });
    const authority = createHermesBootstrapAuthority(
      harness.cp,
      bootstrapOptions(stateDir),
    );

    try {
      const result = await authority.bootstrap(withTarget({ command: commandFor(VALID_RUNTIME) }));
      const history = harness.cp.bindings.history(CEO_ROLE_KEY);

      expect(bind).toHaveBeenCalledTimes(1);
      expect(result.allowed).toBe(false);
      expect(result.reasonCode).toBe(ReasonCode.HERMES_BOOTSTRAP_ALREADY_INITIALIZED);
      // The fence used to read "must be generation 1", which refused every legitimate
      // re-constitution while catching the same forced bind it catches now. It reads "must be
      // the generation this call planned" — here 1, because the role had no history.
      expect(revoke).toHaveBeenCalledWith(
        CEO_ROLE_KEY, "Hermes bootstrap did not mint the generation it planned");
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
      const result = await authority.bootstrap(withTarget({ command: commandFor(VALID_RUNTIME) }));

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
      const result = await authority.bootstrap(withTarget({ command: commandFor(VALID_RUNTIME) }));

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
