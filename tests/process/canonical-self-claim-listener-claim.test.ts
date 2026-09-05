import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { OPERATOR_METHOD, type Daemon } from "../../src/daemon/daemon.ts";
import {
  startCanonicalSelfClaimListener,
  CANONICAL_SELF_CLAIM_SOCKET_FILENAME,
  MAX_SUN_PATH_BYTES,
  type CanonicalSelfClaimListener,
} from "../../src/daemon/canonical-self-claim-listener.ts";
import {
  executeCanonicalSelfClaimOperator,
  type CanonicalSelfClaimOperatorDeps,
} from "../../src/daemon/canonical-self-claim-operator.ts";
import { IngressGuard } from "../../src/ingress/ingress-guard.ts";
import { allow, type Decision } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { REQUIRED_EXECUTOR_VERSION, makeDefaultTranscriptReader } from "../../src/registry/canonical-self-claim.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { makeStartedOperator, TEST_OPERATOR_TOKEN, type Harness, type StartedOperator } from "../helpers/harness.ts";
import { createConnection } from "node:net";

/**
 * #760 round 6 — the CEO's ruling on the mint/claim separation: "a process may prove who it is,
 * but it cannot approve itself." Separate the sockets, not the credentials.
 *
 * This file drives BOTH real sockets a live deployment now has for this feature end to end: the
 * real, bearer-authenticated operator socket for the mint (`owner.approveClaimCanonicalCto`), and
 * the real, token-less canonical self-claim listener for the claim (`actor.claimCanonicalCto`).
 *
 * Every claim in this file is made by a real, independently spawned "claude"-shaped OS process
 * that connects **directly** to the self-claim listener's own socket and sends its one request
 * over that same connection — never by this test process connecting on the claimant's behalf.
 * That distinction is load-bearing: `CanonicalSelfClaim`'s ancestry walk and the listener's
 * kernel-credential check both inspect *whoever actually opened the socket*, and this test
 * process is not a claude process.
 *
 * Kept in its own file, separate from the method-rejection tests
 * (`canonical-self-claim-listener-methods.test.ts`): `vitest.config.ts`'s own `pool: "forks"`
 * comment documents that this native-addon (`better-sqlite3`, and this feature's own
 * `peercred.node`) plus real-spawned-child combination has crashed a shared worker outright on
 * this platform before ("Segmentation fault: 11, exit 139, with the suite otherwise passing").
 * Forks isolate each *file* into its own process, so keeping the heaviest real-process tests in a
 * smaller file of their own is the same mitigation that comment already prescribes, not a new one.
 */

const roots: string[] = [];
const children: ChildProcess[] = [];
const claimListeners: CanonicalSelfClaimListener[] = [];
const startedOperators: StartedOperator[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.pid && child.exitCode === null) {
      try { process.kill(child.pid, "SIGKILL"); } catch { /* already gone */ }
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  for (const listener of claimListeners.splice(0)) await listener.close();
  for (const started of startedOperators.splice(0)) await started.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  cleanupTempDirs();
});

/**
 * `/tmp` directly, never `os.tmpdir()`: on macOS, `TMPDIR` resolves to a long, per-user sandboxed
 * path (`/var/folders/<hash>/<hash>/T/`, itself 50+ bytes on this host) that leaves almost no
 * margin before a joined `AF_UNIX` socket path exceeds Darwin's 104-byte `sun_path` limit — the
 * root cause behind what round 6/7 misread as a load-correlated hang in
 * `startCanonicalSelfClaimListener` (#760 round 8). `/tmp` is short and stable across hosts; the
 * assertion below verifies the margin actually holds for this file's one fixed socket filename
 * rather than assuming a short prefix is enough on every machine this ever runs on.
 */
const tempRoot = (): string => {
  const dir = mkdtempSync(join("/tmp", "ascl-"));
  roots.push(dir);
  const socketPath = join(dir, CANONICAL_SELF_CLAIM_SOCKET_FILENAME);
  const bytes = Buffer.byteLength(socketPath, "utf8");
  if (bytes > MAX_SUN_PATH_BYTES) {
    throw new Error(
      `test fixture directory produces a socket path over the ${MAX_SUN_PATH_BYTES}-byte AF_UNIX ` +
        `sun_path limit (${bytes} bytes): ${socketPath}`,
    );
  }
  return dir;
};

const cloneExecutable = (dest: string): void => {
  mkdirSync(join(dest, ".."), { recursive: true });
  try {
    execFileSync("cp", ["-c", process.execPath, dest], { stdio: "ignore" });
    return;
  } catch { /* not APFS */ }
  try {
    execFileSync("cp", ["--reflink=auto", process.execPath, dest], { stdio: "ignore" });
    return;
  } catch { /* no reflink */ }
  execFileSync("cp", [process.execPath, dest]);
};

const writeVersionedClaude = (versionsRoot: string, version: string): string => {
  const dir = join(versionsRoot, version);
  mkdirSync(dir, { recursive: true });
  const executable = join(dir, "claude");
  cloneExecutable(executable);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version }));
  return executable;
};

const writeTranscriptFixture = (root: string, sessionUuid: string): void => {
  const projectDir = join(root, "transcripts", "-work-canonical");
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, `${sessionUuid}.jsonl`), '{"line":1}\n');
};

const spawnAndSendOneRequest = (
  executable: string,
  socketPath: string,
  identityArgs: readonly string[],
  cwd: string,
  requestBody: Record<string, unknown>,
): ChildProcess => {
  const script = `
    const net = require("node:net");
    const socket = net.createConnection(${JSON.stringify(socketPath)});
    let received = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => { socket.write(${JSON.stringify(`${JSON.stringify(requestBody)}\n`)}); });
    socket.on("data", (chunk) => {
      received += chunk;
      if (!received.includes("\\n")) return;
      process.stdout.write("CLAIM_RESULT " + received);
    });
    socket.on("error", (err) => { process.stdout.write("CLAIM_ERROR " + err.message + "\\n"); });
    setTimeout(() => {}, 120000);
  `;
  const child = spawn(executable, ["-e", script, "argv-guard", ...identityArgs], {
    cwd,
    stdio: ["ignore", "pipe", "ignore"],
  });
  children.push(child);
  return child;
};

const waitForClaimResult = (child: ChildProcess, timeoutMs = 30_000): Promise<Decision<unknown>> =>
  new Promise((resolve, reject) => {
    let buffer = "";
    const deadline = setTimeout(() => reject(new Error("timed out waiting for a claim result")), timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const okAt = buffer.indexOf("CLAIM_RESULT ");
      if (okAt !== -1) {
        const rest = buffer.slice(okAt + "CLAIM_RESULT ".length);
        const newline = rest.indexOf("\n");
        if (newline !== -1) {
          clearTimeout(deadline);
          resolve(JSON.parse(rest.slice(0, newline)) as Decision<unknown>);
          return;
        }
      }
      const errAt = buffer.indexOf("CLAIM_ERROR ");
      if (errAt !== -1) {
        const rest = buffer.slice(errAt + "CLAIM_ERROR ".length);
        const newline = rest.indexOf("\n");
        if (newline !== -1) {
          clearTimeout(deadline);
          reject(new Error(rest.slice(0, newline)));
        }
      }
    });
  });

const claimAsRealClaudeProcess = (
  root: string,
  socketPath: string,
  requestBody: Record<string, unknown>,
  sessionUuid: string = TEST_SESSION_UUID,
): Promise<Decision<unknown>> => {
  const claude = writeVersionedClaude(join(root, "versions"), REQUIRED_EXECUTOR_VERSION);
  writeTranscriptFixture(root, sessionUuid);
  const child = spawnAndSendOneRequest(claude, socketPath, ["--session-id", sessionUuid], root, requestBody);
  return waitForClaimResult(child);
};

const claimAsRealPlainProcess = (
  root: string,
  socketPath: string,
  requestBody: Record<string, unknown>,
): Promise<Decision<unknown>> => {
  const child = spawnAndSendOneRequest(process.execPath, socketPath, [], root, requestBody);
  return waitForClaimResult(child);
};

const MUTATION_TABLES = [
  "sessions",
  "conversational_actors",
  "assignments",
  "actor_target_bindings",
  "actor_target_attestations",
] as const;

const ROLLBACK_TABLES = [...MUTATION_TABLES, "audit_events"] as const;

const rowCounts = (cp: Harness["cp"]): Record<(typeof ROLLBACK_TABLES)[number], number> =>
  Object.fromEntries(
    ROLLBACK_TABLES.map((table) => [table, cp.db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM ${table}`)?.c ?? -1]),
  ) as Record<(typeof ROLLBACK_TABLES)[number], number>;

const insertProject = (cp: Harness["cp"], projectId: string): void => {
  cp.db.run(`INSERT INTO projects (project_id, name, created_at) VALUES (?, ?, ?)`, [
    projectId, projectId, cp.clock.nowIso(),
  ]);
};

let freshNonces = 0;

const BUZZ_ACTOR_ID = "buzz:canonical-cto";
const BUZZ_CHANNEL_ID = "channel:test-canonical";
const PEER_PROTOCOL = "acp.operator/v1";
const BUZZ_PURPOSE = "continuity:PRIMARY_CTO";
const TEST_SESSION_UUID = "99999999-9999-4999-8999-999999999999";

const operatorRequest = (
  socketPath: string,
  token: string,
  request: Record<string, unknown>,
): Promise<Decision<unknown>> =>
  new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let received = "";
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("operator socket test timed out"));
    }, 20_000);
    socket.setEncoding("utf8");
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ requestId: `test-req-${freshNonces++}`, token, ...request })}\n`);
    });
    socket.on("data", (chunk: string) => {
      received += chunk;
      if (!received.includes("\n")) return;
      clearTimeout(timeout);
      socket.end();
      resolve(JSON.parse(received.trim()) as Decision<unknown>);
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });

const startMintOperator = async (): Promise<StartedOperator> => {
  const started = await makeStartedOperator();
  startedOperators.push(started);
  return started;
};

const mintOwnerApprovalOverOperatorSocket = (
  started: StartedOperator,
  input: {
    projectId: string;
    claimedSessionUuid: string;
    expectedBindingGeneration: number;
    approved?: boolean;
    nonce?: string;
  },
): Promise<{ nonce: string; result: Decision<unknown> }> => {
  const nonce = input.nonce ?? `owner-preflight-${freshNonces++}`;
  const params: Record<string, unknown> = {
    projectId: input.projectId,
    claimedSessionUuid: input.claimedSessionUuid,
    expectedBindingGeneration: input.expectedBindingGeneration,
    nonce,
    approved: input.approved ?? true,
  };
  return operatorRequest(started.socketPath, TEST_OPERATOR_TOKEN, {
    method: OPERATOR_METHOD.OWNER_APPROVE_CLAIM_CANONICAL_CTO,
    params,
  }).then((result) => ({ nonce, result }));
};

const freshUnadmittedNonce = (): string => `never-admitted-nonce-${freshNonces++}`;

const resolveBuzzAddressFixture = (
  outcome: Decision<string> = allow(ReasonCode.OK, "buzz://test-canonical-cto"),
) => async (): Promise<Decision<string>> => outcome;

const depsFor = (
  cp: Harness["cp"],
  root: string,
  options: { sessionUuid?: string; maxAncestryHops?: number } = {},
): CanonicalSelfClaimOperatorDeps => ({
  db: cp.db,
  clock: cp.clock,
  sessions: cp.sessions,
  bindings: cp.bindings,
  ownerAuthority: cp.ownerAuthority,
  buzzActorAuthenticator: new IngressGuard(cp.db, cp.clock, cp.audit, {
    buzz: { allowedActors: [BUZZ_ACTOR_ID] },
  }),
  resolveBuzzAddress: resolveBuzzAddressFixture(),
  config: {
    expectedCwd: realpathSync(root),
    expectedPeerProtocolVersion: PEER_PROTOCOL,
    expectedPeerIdentity: `uid:${process.geteuid?.() ?? -1}`,
    canonicalSessionUuid: options.sessionUuid ?? TEST_SESSION_UUID,
    canonicalBuzzChannelId: BUZZ_CHANNEL_ID,
    peerProtocolVersion: PEER_PROTOCOL,
    buzzChannelId: BUZZ_CHANNEL_ID,
    buzzActorId: BUZZ_ACTOR_ID,
    buzzPurpose: BUZZ_PURPOSE,
  },
  claimDeps: {
    transcriptReader: makeDefaultTranscriptReader(join(root, "transcripts")),
    ...(options.maxAncestryHops !== undefined ? { maxAncestryHops: options.maxAncestryHops } : {}),
  },
});

const startClaimListener = async (
  daemon: Pick<Daemon, "lock">,
  cp: Harness["cp"],
  root: string,
  options: { sessionUuid?: string; maxAncestryHops?: number } = {},
): Promise<CanonicalSelfClaimListener> => {
  const listener = await startCanonicalSelfClaimListener(daemon, tempRoot(), (peer, params) =>
    executeCanonicalSelfClaimOperator(peer, params, depsFor(cp, root, options)),
  );
  claimListeners.push(listener);
  return listener;
};

describe("actor.claimCanonicalCto — the real production handler, against real sockets and real processes", () => {
  it(
    "an owner approval minted over the real, bearer-authenticated operator socket succeeds end to end",
    async () => {
      const started = await startMintOperator();
      const { cp } = started.harness;
      const projectId = "prj_operator_success";
      insertProject(cp, projectId);
      const root = tempRoot();
      const listener = await startClaimListener(started.daemon, cp, root);

      const { nonce, result: mintResult } = await mintOwnerApprovalOverOperatorSocket(started, {
        projectId,
        claimedSessionUuid: TEST_SESSION_UUID,
        expectedBindingGeneration: 1,
      });
      expect(mintResult.allowed, JSON.stringify(mintResult)).toBe(true);

      const before = rowCounts(cp);
      const result = await claimAsRealClaudeProcess(root, listener.socketPath, {
        method: "actor.claimCanonicalCto",
        params: { claimedSessionUuid: TEST_SESSION_UUID, projectId, expectedBindingGeneration: 1, ownerApprovalNonce: nonce },
      });

      expect(result.allowed, JSON.stringify(result)).toBe(true);
      if (!result.allowed) return;
      const after = rowCounts(cp);
      for (const table of MUTATION_TABLES) {
        expect(after[table], table).toBe(before[table] + 1);
      }
    },
    45_000,
  );

  it(
    "correction A's counterexample: a claimant holding no operator token, presenting only a fresh unadmitted nonce, cannot self-authorize",
    async () => {
      const started = await startMintOperator();
      const { cp } = started.harness;
      const projectId = "prj_operator_self_authorize";
      insertProject(cp, projectId);
      const root = tempRoot();
      const listener = await startClaimListener(started.daemon, cp, root);

      const ownerApprovalNonce = freshUnadmittedNonce();

      const before = rowCounts(cp);
      const result = await claimAsRealClaudeProcess(root, listener.socketPath, {
        method: "actor.claimCanonicalCto",
        params: { claimedSessionUuid: TEST_SESSION_UUID, projectId, expectedBindingGeneration: 1, ownerApprovalNonce },
      });

      expect(result.allowed).toBe(false);
      if (result.allowed) return;
      expect(result.reasonCode).toBe(ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE);
      expect(rowCounts(cp)).toEqual(before);
    },
    45_000,
  );

  it(
    "approved:false, minted with an explicit boolean, denies the claim with no new claim state or audit",
    async () => {
      const started = await startMintOperator();
      const { cp } = started.harness;
      const projectId = "prj_operator_rejected";
      insertProject(cp, projectId);
      const root = tempRoot();
      const listener = await startClaimListener(started.daemon, cp, root);

      const { nonce, result: mintResult } = await mintOwnerApprovalOverOperatorSocket(started, {
        projectId,
        claimedSessionUuid: TEST_SESSION_UUID,
        expectedBindingGeneration: 1,
        approved: false,
      });
      expect(mintResult.allowed, JSON.stringify(mintResult)).toBe(true);

      const before = rowCounts(cp);
      const result = await claimAsRealClaudeProcess(root, listener.socketPath, {
        method: "actor.claimCanonicalCto",
        params: { claimedSessionUuid: TEST_SESSION_UUID, projectId, expectedBindingGeneration: 1, ownerApprovalNonce: nonce },
      });

      expect(result.allowed).toBe(false);
      if (result.allowed) return;
      expect(result.reasonCode).toBe(ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE);
      expect(rowCounts(cp)).toEqual(before);
    },
    45_000,
  );

  it(
    "a wrong-tuple approval (minted for a different project) denies with no new claim state or audit",
    async () => {
      const started = await startMintOperator();
      const { cp } = started.harness;
      const projectId = "prj_operator_wrong_tuple";
      insertProject(cp, projectId);
      const root = tempRoot();
      const listener = await startClaimListener(started.daemon, cp, root);

      const { nonce, result: mintResult } = await mintOwnerApprovalOverOperatorSocket(started, {
        projectId: "some-other-project",
        claimedSessionUuid: TEST_SESSION_UUID,
        expectedBindingGeneration: 1,
      });
      expect(mintResult.allowed, JSON.stringify(mintResult)).toBe(true);

      const before = rowCounts(cp);
      const result = await claimAsRealClaudeProcess(root, listener.socketPath, {
        method: "actor.claimCanonicalCto",
        params: { claimedSessionUuid: TEST_SESSION_UUID, projectId, expectedBindingGeneration: 1, ownerApprovalNonce: nonce },
      });

      expect(result.allowed).toBe(false);
      if (result.allowed) return;
      expect(result.reasonCode).toBe(ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE);
      expect(result.message).toContain("does not bind the exact project");
      expect(rowCounts(cp)).toEqual(before);
    },
    45_000,
  );

  it(
    "replaying an already-committed approval's nonce denies with no new claim state or audit",
    async () => {
      const started = await startMintOperator();
      const { cp } = started.harness;
      const projectId = "prj_operator_replay";
      insertProject(cp, projectId);
      const root = tempRoot();
      const listener = await startClaimListener(started.daemon, cp, root);

      const { nonce, result: mintResult } = await mintOwnerApprovalOverOperatorSocket(started, {
        projectId,
        claimedSessionUuid: TEST_SESSION_UUID,
        expectedBindingGeneration: 1,
      });
      expect(mintResult.allowed, JSON.stringify(mintResult)).toBe(true);

      const first = await claimAsRealClaudeProcess(root, listener.socketPath, {
        method: "actor.claimCanonicalCto",
        params: { claimedSessionUuid: TEST_SESSION_UUID, projectId, expectedBindingGeneration: 1, ownerApprovalNonce: nonce },
      });
      expect(first.allowed, JSON.stringify(first)).toBe(true);
      const afterFirst = rowCounts(cp);

      const replay = await claimAsRealClaudeProcess(root, listener.socketPath, {
        method: "actor.claimCanonicalCto",
        params: { claimedSessionUuid: TEST_SESSION_UUID, projectId, expectedBindingGeneration: 1, ownerApprovalNonce: nonce },
      });
      expect(replay.allowed).toBe(false);
      expect(rowCounts(cp)).toEqual(afterFirst);
    },
    45_000,
  );

  it(
    "wrong-process denial: a real connected peer that is not a claude process is refused, with zero mutation-table rows",
    async () => {
      const started = await startMintOperator();
      const { cp } = started.harness;
      const projectId = "prj_operator_wrong_process";
      insertProject(cp, projectId);
      const root = tempRoot();

      const listener = await startClaimListener(started.daemon, cp, root, { maxAncestryHops: 1 });

      const { nonce, result: mintResult } = await mintOwnerApprovalOverOperatorSocket(started, {
        projectId,
        claimedSessionUuid: TEST_SESSION_UUID,
        expectedBindingGeneration: 1,
      });
      expect(mintResult.allowed, JSON.stringify(mintResult)).toBe(true);

      const before = rowCounts(cp);
      const result = await claimAsRealPlainProcess(root, listener.socketPath, {
        method: "actor.claimCanonicalCto",
        params: { claimedSessionUuid: TEST_SESSION_UUID, projectId, expectedBindingGeneration: 1, ownerApprovalNonce: nonce },
      });

      expect(result.allowed).toBe(false);
      if (result.allowed) return;
      expect(result.reasonCode).toBe(ReasonCode.CONFLICT);
      expect(result.message).toContain("exceeded its hop limit");
      expect(rowCounts(cp)).toEqual(before);
    },
    45_000,
  );
});
