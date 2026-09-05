import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer, createConnection, type Server, type Socket } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { OwnerAuthority } from "../../src/ceo/owner-authority.ts";
import { AuditLog } from "../../src/db/audit.ts";
import { Db } from "../../src/db/database.ts";
import { IngressGuard, ownerApprovalPayload } from "../../src/ingress/ingress-guard.ts";
import { BindingRegistry } from "../../src/session/binding-registry.ts";
import { SessionRegistry } from "../../src/session/session-registry.ts";
import { Outbox } from "../../src/outbox/outbox.ts";
import { ManualClock } from "../../src/core/clock.ts";
import { allow, type Decision } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import {
  REQUIRED_EXECUTOR_VERSION,
  SELF_CLAIM_OPERATION,
  makeDefaultTranscriptReader,
} from "../../src/registry/canonical-self-claim.ts";
import {
  assertDirectPeer,
  executeCanonicalSelfClaimOperator,
  type CanonicalSelfClaimOperatorDeps,
} from "../../src/daemon/canonical-self-claim-operator.ts";

/**
 * #760 round 4 — the production `actor.claimCanonicalCto` operator handler, driven against real
 * `AF_UNIX` sockets and real spawned processes. Scoped the same way
 * `tests/unit/g5-peercred.test.ts` states its own scope: this calls
 * `executeCanonicalSelfClaimOperator` — the exact function `src/daemon/agentcpd.ts` wires to the
 * socket — directly, rather than standing up the whole daemon (`ControlPlane`, the single-instance
 * lock, the full `startOperatorSocket` listener, `Daemon.executeApproveCanonicalCtoClaim`'s own
 * bearer-token dispatch). What it does not skip: a real kernel `getsockopt` call against a real
 * connected socket, and — the load-bearing property this round adds — that the claiming
 * connection itself never mints, admits, or otherwise produces the owner approval it presents.
 * `mintOwnerApprovalOutOfBand` below calls the exact same `IngressGuard.admitOwnerApproval` route
 * `Daemon.executeApproveCanonicalCtoClaim` does, standing in for that separate, bearer-authenticated
 * preflight call — never for anything the claiming socket itself could reach.
 */

const roots: string[] = [];
const children: ChildProcess[] = [];
const servers: Server[] = [];
const sockets: Socket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const server of servers.splice(0)) server.close();
  for (const child of children.splice(0)) {
    if (child.pid && child.exitCode === null) {
      try { process.kill(child.pid, "SIGKILL"); } catch { /* already gone */ }
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const tempRoot = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "acp-claim-operator-"));
  roots.push(dir);
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

/** A fresh `AF_UNIX` server; resolves with the accepted `Socket` for the first connection. */
const acceptOneConnection = (socketPath: string): Promise<Socket> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    servers.push(server);
    server.once("error", reject);
    server.once("connection", (socket) => {
      sockets.push(socket);
      resolve(socket);
    });
    server.listen(socketPath);
  });

/**
 * Spawns a real, independent OS process that connects to `socketPath` and then blocks on a
 * `setTimeout`, keeping the connection (and its own pid) alive until this test kills it — the
 * "connection-derived identity" property needs a peer that is provably not the test runner.
 * `identityArgs` land in the child's own real command line, read back by the real `ps`-backed
 * ancestry inspector `CanonicalSelfClaim` uses by default.
 */
const spawnConnectingProcess = (
  executable: string,
  socketPath: string,
  identityArgs: readonly string[],
  cwd: string,
): ChildProcess => {
  const connectScript = `
    const net = require("node:net");
    const socket = net.createConnection(${JSON.stringify(socketPath)});
    socket.on("connect", () => { process.stdout.write("connected\\n"); });
    socket.on("error", () => {});
    setTimeout(() => {}, 120000);
  `;
  const child = spawn(executable, ["-e", connectScript, "argv-guard", ...identityArgs], {
    cwd,
    stdio: ["ignore", "pipe", "ignore"],
  });
  children.push(child);
  return child;
};

const waitForStdout = (child: ChildProcess, needle: string, timeoutMs = 10_000): Promise<void> =>
  new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`timed out waiting for "${needle}"`)), timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes(needle)) {
        clearTimeout(deadline);
        resolve();
      }
    });
  });

const ROLLBACK_TABLES = [
  "sessions",
  "conversational_actors",
  "assignments",
  "actor_target_bindings",
  "actor_target_attestations",
  "audit_events",
] as const;

interface Core {
  db: Db;
  clock: ManualClock;
  audit: AuditLog;
  sessions: SessionRegistry;
  bindings: BindingRegistry;
  ownerAuthority: OwnerAuthority;
}

const OWNER_ACTOR = "isaac";
const BUZZ_ACTOR_ID = "buzz:canonical-cto";
const BUZZ_CHANNEL_ID = "channel:test-canonical";
const PEER_PROTOCOL = "acp.operator/v1";
const BUZZ_PURPOSE = "continuity:PRIMARY_CTO";

/**
 * Entirely synthetic — deliberately not `CANONICAL_SESSION_UUID`. Round 5 review: the previous
 * version of this file reused the real production constant and relied on `CanonicalSelfClaim`'s
 * real default transcript reader (`~/.claude/projects/**\/<uuid>.jsonl`), which only ever passed
 * here because this specific developer machine happens to hold a real transcript for that real,
 * live session. Diagnostic CI on a machine with no such file got `NOT_FOUND` instead of the
 * outcome each test actually names. `config.canonicalSessionUuid` is a real, overridable config
 * field for exactly this reason — production supplies the real constant, this file supplies a
 * fixture UUID and a fixture transcript it writes into its own temp directory.
 */
const TEST_SESSION_UUID = "99999999-9999-4999-8999-999999999999";

const makeCore = (): Core => {
  const db = new Db(":memory:");
  const clock = new ManualClock("2027-01-01T00:00:00.000Z");
  const audit = new AuditLog(db, clock);
  const outbox = new Outbox(db, clock, audit);
  const sessions = new SessionRegistry(db, clock, audit);
  const bindings = new BindingRegistry(db, clock, audit, sessions, outbox);
  const ownerAuthority = new OwnerAuthority(db, [{ channel: "cli", actor: OWNER_ACTOR }], clock);
  return { db, clock, audit, sessions, bindings, ownerAuthority };
};

const rowCounts = (core: Core): Record<(typeof ROLLBACK_TABLES)[number], number> =>
  Object.fromEntries(
    ROLLBACK_TABLES.map((table) => [table, core.db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM ${table}`)?.c ?? -1]),
  ) as Record<(typeof ROLLBACK_TABLES)[number], number>;

const insertProject = (core: Core, projectId: string): void => {
  core.db.run(`INSERT INTO projects (project_id, name, created_at) VALUES (?, ?, ?)`, [
    projectId, projectId, core.clock.nowIso(),
  ]);
};

let freshNonces = 0;

/**
 * Stands in for `Daemon.executeApproveCanonicalCtoClaim` — the *separate*, bearer-authenticated
 * operator method that mints a canonical self-claim owner approval. Never called by, or reachable
 * from, the claiming socket: `executeCanonicalSelfClaimOperator` only ever *loads* what this
 * produces, via `(channel="cli", nonce)`. Round 4 correction A exists precisely because an earlier
 * version let the claiming request assemble and admit this receipt itself.
 */
const mintOwnerApprovalOutOfBand = (
  core: Core,
  input: { projectId: string; claimedSessionUuid: string; expectedBindingGeneration: number; approved?: boolean },
): string => {
  const guard = new IngressGuard(core.db, core.clock, core.audit, { cli: { allowedActors: [OWNER_ACTOR] } });
  const approval = {
    runId: null,
    candidateSnapshotDigest: null,
    operation: SELF_CLAIM_OPERATION,
    parameters: {
      domain: SELF_CLAIM_OPERATION,
      projectId: input.projectId,
      claimedSessionUuid: input.claimedSessionUuid,
      role: "PRIMARY_CTO",
      expectedBindingGeneration: input.expectedBindingGeneration,
    },
    idempotencyKey: `claim-canonical-cto:${input.projectId}:${input.expectedBindingGeneration}:${freshNonces}`,
    approved: input.approved ?? true,
  };
  const nonce = `owner-preflight-nonce-${freshNonces++}`;
  const admitted = guard.admitOwnerApproval(
    { channel: "cli", actor: OWNER_ACTOR, nonce, payload: ownerApprovalPayload(approval) },
    approval,
  );
  if (!admitted.allowed) throw new Error(`failed to mint an out-of-band owner approval: ${JSON.stringify(admitted)}`);
  return nonce;
};

/** A fresh nonce nobody has ever admitted anything under — the shape a self-authorizing caller has. */
const freshUnadmittedNonce = (): string => `never-admitted-nonce-${freshNonces++}`;

const resolveBuzzAddressFixture = (
  outcome: Decision<string> = allow(ReasonCode.OK, "buzz://test-canonical-cto"),
) => async (): Promise<Decision<string>> => outcome;

const depsFor = (
  core: Core,
  root: string,
  options: { sessionUuid?: string; maxAncestryHops?: number } = {},
): CanonicalSelfClaimOperatorDeps => ({
  db: core.db,
  clock: core.clock,
  sessions: core.sessions,
  bindings: core.bindings,
  ownerAuthority: core.ownerAuthority,
  buzzActorAuthenticator: new IngressGuard(core.db, core.clock, core.audit, {
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
  // The seam this round added: a real `getPeerCredentials`/`ps`/`lsof` walk is still exercised
  // (nothing here fakes `processInspector` or `imageInspector`), but the transcript lookup reads
  // this test's own fixture directory instead of `~/.claude/projects` — this machine's real
  // transcript for the real production UUID must never be what makes this file green.
  claimDeps: {
    transcriptReader: makeDefaultTranscriptReader(join(root, "transcripts")),
    ...(options.maxAncestryHops !== undefined ? { maxAncestryHops: options.maxAncestryHops } : {}),
  },
});

/** A real claude-shaped peer, connected over a real socket, with a fixture transcript in place. */
const spawnRealClaudePeer = async (root: string, sessionUuid: string = TEST_SESSION_UUID): Promise<Socket> => {
  const claude = writeVersionedClaude(join(root, "versions"), REQUIRED_EXECUTOR_VERSION);
  const socketPath = join(root, "operator.sock");
  const accepted = acceptOneConnection(socketPath);
  const child = spawnConnectingProcess(claude, socketPath, ["--session-id", sessionUuid], root);
  await waitForStdout(child, "connected");
  const transcriptRoot = join(root, "transcripts");
  const projectDir = join(transcriptRoot, "-work-canonical");
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, `${sessionUuid}.jsonl`), '{"line":1}\n');
  return accepted;
};

describe("actor.claimCanonicalCto — the real production handler, against real sockets and real processes", () => {
  it(
    "an independently pre-admitted owner approval succeeds end to end",
    async () => {
      const core = makeCore();
      const projectId = "prj_operator_success";
      insertProject(core, projectId);
      const root = tempRoot();
      const socket = await spawnRealClaudePeer(root);

      // Minted out of band — never through this test's call to the claim handler itself.
      const ownerApprovalNonce = mintOwnerApprovalOutOfBand(core, {
        projectId,
        claimedSessionUuid: TEST_SESSION_UUID,
        expectedBindingGeneration: 1,
      });

      const before = rowCounts(core);
      const result = await executeCanonicalSelfClaimOperator(
        socket,
        { claimedSessionUuid: TEST_SESSION_UUID, projectId, expectedBindingGeneration: 1, ownerApprovalNonce },
        depsFor(core, root),
      );

      expect(result.allowed, JSON.stringify(result)).toBe(true);
      if (!result.allowed) return;
      // `callerPid` was never in the request. It came from a real
      // `getsockopt(SOL_LOCAL, LOCAL_PEERPID)` against `socket`'s own fd.
      expect(result.value.derivedSessionUuid).toBe(TEST_SESSION_UUID);
      expect(result.value.binding.role).toBe("PRIMARY_CTO");

      const after = rowCounts(core);
      for (const table of ["sessions", "conversational_actors", "assignments", "actor_target_bindings", "actor_target_attestations"] as const) {
        expect(after[table], table).toBe(before[table] + 1);
      }
    },
    30_000,
  );

  it(
    "correction A's counterexample: the exact same claude peer, presenting only a fresh nonce nobody admitted, cannot self-authorize",
    async () => {
      const core = makeCore();
      const projectId = "prj_operator_self_authorize";
      insertProject(core, projectId);
      const root = tempRoot();
      const socket = await spawnRealClaudePeer(root);

      // No preflight mint anywhere. This is the exact request shape a compromised or malicious
      // claiming connection would send: a real kernel identity, a nonce it invented, and nothing
      // an owner ever saw.
      const ownerApprovalNonce = freshUnadmittedNonce();

      const before = rowCounts(core);
      const result = await executeCanonicalSelfClaimOperator(
        socket,
        { claimedSessionUuid: TEST_SESSION_UUID, projectId, expectedBindingGeneration: 1, ownerApprovalNonce },
        depsFor(core, root),
      );

      expect(result.allowed).toBe(false);
      if (result.allowed) return;
      expect(result.reasonCode).toBe(ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE);
      // Nothing was admitted, so there is no ingress audit trail either — unlike the wrong-process
      // case below, this denial happens before any lookup could find anything to record against.
      expect(rowCounts(core)).toEqual(before);
    },
    30_000,
  );

  it("approved:false denies with no new claim state and no new claim audit", async () => {
    const core = makeCore();
    const projectId = "prj_operator_rejected";
    insertProject(core, projectId);
    const root = tempRoot();
    const socket = await spawnRealClaudePeer(root);

    const ownerApprovalNonce = mintOwnerApprovalOutOfBand(core, {
      projectId,
      claimedSessionUuid: TEST_SESSION_UUID,
      expectedBindingGeneration: 1,
      approved: false,
    });

    const before = rowCounts(core);
    const result = await executeCanonicalSelfClaimOperator(
      socket,
      { claimedSessionUuid: TEST_SESSION_UUID, projectId, expectedBindingGeneration: 1, ownerApprovalNonce },
      depsFor(core, root),
    );

    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.reasonCode).toBe(ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE);
    const after = rowCounts(core);
    for (const table of ["sessions", "conversational_actors", "assignments", "actor_target_bindings", "actor_target_attestations"] as const) {
      expect(after[table], table).toBe(before[table]);
    }
    // The mint's own ingress-admission pair is real and precedes `claim()` entirely (it happened
    // before this test even called the handler) — no *additional* claim audit rows land on top.
    expect(after.audit_events).toBe(before.audit_events);
  });

  it("a wrong-tuple approval (minted for a different project) denies with no new claim state or audit", async () => {
    const core = makeCore();
    const projectId = "prj_operator_wrong_tuple";
    insertProject(core, projectId);
    const root = tempRoot();
    const socket = await spawnRealClaudePeer(root);

    const ownerApprovalNonce = mintOwnerApprovalOutOfBand(core, {
      projectId: "some-other-project",
      claimedSessionUuid: TEST_SESSION_UUID,
      expectedBindingGeneration: 1,
    });

    const before = rowCounts(core);
    const result = await executeCanonicalSelfClaimOperator(
      socket,
      { claimedSessionUuid: TEST_SESSION_UUID, projectId, expectedBindingGeneration: 1, ownerApprovalNonce },
      depsFor(core, root),
    );

    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.reasonCode).toBe(ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE);
    expect(result.message).toContain("does not bind the exact project");
    expect(rowCounts(core)).toEqual(before);
  });

  it("replaying an already-committed approval's nonce denies with no new claim state or audit", async () => {
    const core = makeCore();
    const projectId = "prj_operator_replay";
    insertProject(core, projectId);
    const root = tempRoot();
    const socket = await spawnRealClaudePeer(root);

    const ownerApprovalNonce = mintOwnerApprovalOutOfBand(core, {
      projectId,
      claimedSessionUuid: TEST_SESSION_UUID,
      expectedBindingGeneration: 1,
    });
    const deps = depsFor(core, root);
    const first = await executeCanonicalSelfClaimOperator(
      socket,
      { claimedSessionUuid: TEST_SESSION_UUID, projectId, expectedBindingGeneration: 1, ownerApprovalNonce },
      deps,
    );
    expect(first.allowed, JSON.stringify(first)).toBe(true);
    const afterFirst = rowCounts(core);

    // The exact same handle, presented again. `CanonicalSelfClaim`'s generation-CAS denies this
    // before `OwnerAuthority` is even asked (round 3's own finding, unchanged by this round) —
    // either way, nothing new lands.
    const replay = await executeCanonicalSelfClaimOperator(
      socket,
      { claimedSessionUuid: TEST_SESSION_UUID, projectId, expectedBindingGeneration: 1, ownerApprovalNonce },
      deps,
    );
    expect(replay.allowed).toBe(false);
    expect(rowCounts(core)).toEqual(afterFirst);
  });

  it(
    "wrong-process denial: a real connected peer that is not a claude process is refused, with zero mutation-table rows",
    async () => {
      const core = makeCore();
      const projectId = "prj_operator_wrong_process";
      insertProject(core, projectId);

      const root = tempRoot();
      const socketPath = join(root, "operator.sock");
      const accepted = acceptOneConnection(socketPath);

      // A real, live, connected peer process — genuinely on the other end of the socket — that is
      // simply not claude. This is the actual identity the kernel will report; nothing here tells
      // the handler what to believe instead.
      const plainScript = `
        const net = require("node:net");
        const socket = net.createConnection(${JSON.stringify(socketPath)});
        socket.on("connect", () => { process.stdout.write("connected\\n"); });
        socket.on("error", () => {});
        setTimeout(() => {}, 120000);
      `;
      const child = spawn(process.execPath, ["-e", plainScript], { cwd: root, stdio: ["ignore", "pipe", "ignore"] });
      children.push(child);
      await waitForStdout(child, "connected");
      const socket = await accepted;

      const ownerApprovalNonce = mintOwnerApprovalOutOfBand(core, {
        projectId,
        claimedSessionUuid: TEST_SESSION_UUID,
        expectedBindingGeneration: 1,
      });

      const before = rowCounts(core);
      // `maxAncestryHops: 1` — round 5 fix. The real, unbounded walk (production's default 64)
      // climbs past this plain child into whatever this environment's own ancestry actually is,
      // which is not this test's business and is not the same on every machine: this sandbox
      // happens to run inside a real, ambient claude session (climbing far enough would find it
      // and deny for a *different* reason than "not a claude process" — a `CONFLICT` from a
      // session/cwd/version mismatch against that unrelated ambient process), while a bare CI
      // runner has no such ancestor and would instead climb all the way to pid 1 and deny
      // `NOT_FOUND`. Neither is what this test's name claims to prove, and neither is stable
      // across machines. Bounding the walk to one hop makes the outcome depend only on what this
      // test itself spawned: the plain child is not claude, its immediate parent (this test
      // process) is not either, and the budget is exhausted before either possibility above can
      // occur — the same `CONFLICT` reason, "process ancestry walk exceeded its hop limit
      // without finding a claude ancestor", on every machine.
      const result = await executeCanonicalSelfClaimOperator(
        socket,
        { claimedSessionUuid: TEST_SESSION_UUID, projectId, expectedBindingGeneration: 1, ownerApprovalNonce },
        depsFor(core, root, { maxAncestryHops: 1 }),
      );

      expect(result.allowed).toBe(false);
      if (result.allowed) return;
      expect(result.reasonCode).toBe(ReasonCode.CONFLICT);
      expect(result.message).toContain("exceeded its hop limit");
      const after = rowCounts(core);
      for (const table of ["sessions", "conversational_actors", "assignments", "actor_target_bindings", "actor_target_attestations"] as const) {
        expect(after[table], table).toBe(before[table]);
      }
    },
    30_000,
  );

  it("refuses when the socket has no live native handle, without ever looking up an approval", async () => {
    const core = makeCore();
    const projectId = "prj_operator_dead_socket";
    insertProject(core, projectId);
    const ownerApprovalNonce = mintOwnerApprovalOutOfBand(core, {
      projectId,
      claimedSessionUuid: TEST_SESSION_UUID,
      expectedBindingGeneration: 1,
    });

    const root = tempRoot();
    const socketPath = join(root, "operator.sock");
    const server = createServer();
    servers.push(server);
    server.listen(socketPath);
    const client = createConnection(socketPath);
    sockets.push(client);
    await new Promise<void>((resolve) => client.once("connect", () => resolve()));
    client.destroy();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const before = rowCounts(core);
    const result = await executeCanonicalSelfClaimOperator(
      client,
      { claimedSessionUuid: TEST_SESSION_UUID, projectId, expectedBindingGeneration: 1, ownerApprovalNonce },
      depsFor(core, root),
    );

    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.reasonCode).toBe(ReasonCode.OPERATOR_UNAUTHENTICATED);
    // The approval that WAS admitted (out of band) is untouched by this refusal, but the refusal
    // itself adds nothing on top of it.
    expect(rowCounts(core)).toEqual(before);

    if (existsSync(socketPath)) unlinkSync(socketPath);
  });
});

describe("correction B — a proxied peer identity is refused before any admission effect", () => {
  it("denies when peerPid !== effectivePid, a focused counterexample with no real proxy required", () => {
    const direct = assertDirectPeer({ peerPid: 100, effectivePid: 100, uid: 0, gid: 0 });
    expect(direct.allowed).toBe(true);

    const proxied = assertDirectPeer({ peerPid: 100, effectivePid: 200, uid: 0, gid: 0 });
    expect(proxied.allowed).toBe(false);
    if (proxied.allowed) return;
    expect(proxied.reasonCode).toBe(ReasonCode.OPERATOR_UNAUTHENTICATED);
    expect(proxied.evidence).toMatchObject({ peerPid: 100, effectivePid: 200 });
  });
});
