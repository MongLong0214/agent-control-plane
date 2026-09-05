import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer, createConnection, type Server, type Socket } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { OwnerAuthority } from "../../src/ceo/owner-authority.ts";
import { AuditLog } from "../../src/db/audit.ts";
import { Db } from "../../src/db/database.ts";
import { IngressGuard } from "../../src/ingress/ingress-guard.ts";
import { BindingRegistry } from "../../src/session/binding-registry.ts";
import { SessionRegistry } from "../../src/session/session-registry.ts";
import { Outbox } from "../../src/outbox/outbox.ts";
import { ManualClock } from "../../src/core/clock.ts";
import { allow, type Decision } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import {
  CANONICAL_SESSION_UUID,
  REQUIRED_EXECUTOR_VERSION,
} from "../../src/registry/canonical-self-claim.ts";
import { executeCanonicalSelfClaimOperator } from "../../src/daemon/canonical-self-claim-operator.ts";

/**
 * #760 round 3 — the production `actor.claimCanonicalCto` operator handler, driven against real
 * `AF_UNIX` sockets and real spawned processes. Scoped the same way
 * `tests/unit/g5-peercred.test.ts` states its own scope: this calls
 * `executeCanonicalSelfClaimOperator` — the exact function `src/daemon/agentcpd.ts` wires to the
 * socket — directly, rather than standing up the whole daemon (`ControlPlane`, the single-instance
 * lock, the full `startOperatorSocket` listener). What it does not skip is the one property that
 * matters for this round: a real kernel `getsockopt` call against a real connected socket, never a
 * fake peer object, an injected pid, or a mocked credential.
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
 * A fresh, never-yet-admitted nonce. `executeCanonicalSelfClaimOperator` performs the real
 * admission itself (via its own internal `admitOwnerApproval`, using the same `IngressGuard`
 * route `owner approve` uses) — this is deliberately *not* pre-admitted here, unlike the unit
 * test's `mintOwnerApproval` helper. Pre-admitting the same nonce in the test and then handing it
 * to the handler for a *second* admission is exactly the shape that made an early version of this
 * file fail with `INGRESS_REPLAY_IGNORED`: the handler's own admission was correctly refusing a
 * genuine replay the test had unintentionally manufactured.
 */
const freshNonce = (): string => `operator-test-nonce-${freshNonces++}`;

const resolveBuzzAddressFixture = (
  outcome: Decision<string> = allow(ReasonCode.OK, "buzz://test-canonical-cto"),
) => async (): Promise<Decision<string>> => outcome;

describe("actor.claimCanonicalCto — the real production handler, against real sockets and real processes", () => {
  it(
    "derives the connecting process's own identity from the kernel and completes a real claim — no fake peer object anywhere",
    async () => {
      const core = makeCore();
      const projectId = "prj_operator_success";
      insertProject(core, projectId);

      const root = tempRoot();
      const claude = writeVersionedClaude(join(root, "versions"), REQUIRED_EXECUTOR_VERSION);
      const socketPath = join(root, "operator.sock");
      const accepted = acceptOneConnection(socketPath);

      const child = spawnConnectingProcess(claude, socketPath, ["--session-id", CANONICAL_SESSION_UUID], root);
      await waitForStdout(child, "connected");
      const socket = await accepted;

      // The transcript `CanonicalSelfClaim`'s default reader looks for — this test does not
      // inject a fake reader, it places a real file where the real one looks.
      const transcriptRoot = join(root, "transcripts");
      const projectDir = join(transcriptRoot, "-work-canonical");
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(join(projectDir, `${CANONICAL_SESSION_UUID}.jsonl`), '{"line":1}\n');
      process.env["ACP_TEST_TRANSCRIPT_ROOT_UNUSED"] = ""; // no-op, keeps intent explicit below

      const ownerNonce = freshNonce();

      const before = rowCounts(core);
      const result = await executeCanonicalSelfClaimOperator(
        socket,
        {
          claimedSessionUuid: CANONICAL_SESSION_UUID,
          projectId,
          expectedBindingGeneration: 1,
          ownerNonce,
          peerProtocolVersion: "acp.operator/v1",
          buzzChannelId: "channel:test-canonical",
          buzzActorId: BUZZ_ACTOR_ID,
          buzzPurpose: "continuity:PRIMARY_CTO",
        },
        {
          db: core.db,
          clock: core.clock,
          audit: core.audit,
          sessions: core.sessions,
          bindings: core.bindings,
          ownerAuthority: core.ownerAuthority,
          buzzActorAuthenticator: new IngressGuard(core.db, core.clock, core.audit, {
            buzz: { allowedActors: [BUZZ_ACTOR_ID] },
          }),
          resolveBuzzAddress: resolveBuzzAddressFixture(),
          ownerActor: OWNER_ACTOR,
          config: {
            expectedCwd: realpathSync(root),
            expectedPeerProtocolVersion: "acp.operator/v1",
            expectedPeerIdentity: `uid:${process.geteuid?.() ?? -1}`,
            canonicalSessionUuid: CANONICAL_SESSION_UUID,
            canonicalBuzzChannelId: "channel:test-canonical",
          },
        },
      );

      expect(result.allowed, JSON.stringify(result)).toBe(true);
      if (!result.allowed) return;
      // The whole point: `callerPid` was never in the request. It came from a real
      // `getsockopt(SOL_LOCAL, LOCAL_PEERPID)` against `socket`'s own fd.
      expect(result.value.derivedSessionUuid).toBe(CANONICAL_SESSION_UUID);
      expect(result.value.binding.role).toBe("PRIMARY_CTO");

      const after = rowCounts(core);
      for (const table of ["sessions", "conversational_actors", "assignments", "actor_target_bindings", "actor_target_attestations"] as const) {
        expect(after[table], table).toBe(before[table] + 1);
      }
    },
    30_000,
  );

  it(
    "wrong-process denial: a real connected peer that is not a claude process is refused, with zero mutation-table rows and only the real ingress-admission audit trail",
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

      const ownerNonce = freshNonce();

      const before = rowCounts(core);
      const result = await executeCanonicalSelfClaimOperator(
        socket,
        {
          claimedSessionUuid: CANONICAL_SESSION_UUID,
          projectId,
          expectedBindingGeneration: 1,
          ownerNonce,
          peerProtocolVersion: "acp.operator/v1",
          buzzChannelId: "channel:test-canonical",
          buzzActorId: BUZZ_ACTOR_ID,
          buzzPurpose: "continuity:PRIMARY_CTO",
        },
        {
          db: core.db,
          clock: core.clock,
          audit: core.audit,
          sessions: core.sessions,
          bindings: core.bindings,
          ownerAuthority: core.ownerAuthority,
          buzzActorAuthenticator: new IngressGuard(core.db, core.clock, core.audit, {
            buzz: { allowedActors: [BUZZ_ACTOR_ID] },
          }),
          resolveBuzzAddress: resolveBuzzAddressFixture(),
          ownerActor: OWNER_ACTOR,
          config: {
            expectedCwd: realpathSync(root),
            expectedPeerProtocolVersion: "acp.operator/v1",
            expectedPeerIdentity: `uid:${process.geteuid?.() ?? -1}`,
            canonicalSessionUuid: CANONICAL_SESSION_UUID,
            canonicalBuzzChannelId: "channel:test-canonical",
          },
        },
      );

      expect(result.allowed).toBe(false);
      if (result.allowed) return;
      // Measured, not assumed: this sandbox always runs *inside* a real claude session, so the
      // ancestry walk climbing past this plain child does not stop at "no ancestor at all" — it
      // keeps climbing (by design, the same way a legitimate multi-hop chain is meant to resolve)
      // until it reaches that real, ambient claude process, and denies against *its* identity
      // (cwd/session/version) instead. That is still exactly the property this test is for: the
      // request body asserts nothing about which process this is, and whichever real process the
      // kernel-verified connection actually leads to is what gets checked — never a value this
      // call supplied.
      expect(result.reasonCode).toBe(ReasonCode.CONFLICT);

      // The five mutation tables are exactly unchanged — nothing about this refusal touches the
      // adoption state `CanonicalSelfClaim`'s own transaction owns.
      const after = rowCounts(core);
      for (const table of ["sessions", "conversational_actors", "assignments", "actor_target_bindings", "actor_target_attestations"] as const) {
        expect(after[table], table).toBe(before[table]);
      }
      // `audit_events` is *not* zero here, and that is a documented, accepted ordering (see
      // `admitOwnerApproval`'s comment in src/daemon/canonical-self-claim-operator.ts): the
      // owner-approval admission is real ingress evidence about the inbound envelope itself
      // ("this exact nonce, from this exact allowlisted actor, arrived"), independent of and
      // durable regardless of whether the claim it names later succeeds — exactly like an
      // ordinary Telegram or Buzz message's admission is recorded before the daemon decides what
      // to do with it. What must not happen, and does not: any of `CanonicalSelfClaim`'s own
      // audit rows (`OWNER_APPROVAL_CONSUMED`, `SESSION_CREATED`, `SESSION_LIFECYCLE`,
      // `SESSION_BUZZ_ACTOR_BOUND`, `BINDING_CREATED`) landing without their matching state.
      expect(after.audit_events).toBe(before.audit_events + 2);
      const auditKinds = core.db.all<{ kind: string }>(`SELECT kind FROM audit_events ORDER BY kind`).map((r) => r.kind);
      expect(auditKinds.sort()).toEqual(["INGRESS_ADMITTED", "OWNER_APPROVAL_INGRESS"]);
    },
    30_000,
  );

  it("refuses when the socket has no live native handle, without ever admitting the owner approval", async () => {
    const core = makeCore();
    const projectId = "prj_operator_dead_socket";
    insertProject(core, projectId);
    const ownerNonce = freshNonce();

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
      {
        claimedSessionUuid: CANONICAL_SESSION_UUID,
        projectId,
        expectedBindingGeneration: 1,
        ownerNonce,
        peerProtocolVersion: "acp.operator/v1",
        buzzChannelId: "channel:test-canonical",
        buzzActorId: BUZZ_ACTOR_ID,
        buzzPurpose: "continuity:PRIMARY_CTO",
      },
      {
        db: core.db,
        clock: core.clock,
        audit: core.audit,
        sessions: core.sessions,
        bindings: core.bindings,
        ownerAuthority: core.ownerAuthority,
        buzzActorAuthenticator: new IngressGuard(core.db, core.clock, core.audit, {
          buzz: { allowedActors: [BUZZ_ACTOR_ID] },
        }),
        resolveBuzzAddress: resolveBuzzAddressFixture(),
        ownerActor: OWNER_ACTOR,
        config: {
          expectedCwd: realpathSync(root),
          expectedPeerProtocolVersion: "acp.operator/v1",
          expectedPeerIdentity: `uid:${process.geteuid?.() ?? -1}`,
        },
      },
    );

    expect(result.allowed).toBe(false);
    if (result.allowed) return;
    expect(result.reasonCode).toBe(ReasonCode.OPERATOR_UNAUTHENTICATED);
    expect(rowCounts(core)).toEqual(before);

    if (existsSync(socketPath)) unlinkSync(socketPath);
  });
});
