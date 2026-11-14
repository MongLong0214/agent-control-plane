import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";

import Database from "better-sqlite3";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { CONTINUITY_RUNTIME_LOST_REVOCATION_REASON } from "../../src/continuity/continuity-kernel.ts";
import { type Decision, allow, deny } from "../../src/core/errors.ts";
import { readProcessStartToken } from "../../src/core/process-argv.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Daemon } from "../../src/daemon/daemon.ts";
import { DEAD_CANONICAL_BINDING_RECOVERY_REASON_PREFIX } from "../../src/daemon/dead-binding-recovery.ts";
import { ExecutionMode, Role, RunState, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import {
  CanonicalSelfClaim,
  hostSessionRegistryAbsent,
  type CanonicalSelfClaimReceipt,
  type ProcessSnapshot,
} from "../../src/registry/canonical-self-claim.ts";
import { CONTINUITY_PAUSE_RUNTIME_LOST_REASON } from "../../src/run/run-engine.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { bindCeo, bindWorker, bootstrapCtoProvider, makeHarness, registerFixtureProject } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * Measured live (2026-11-14, run_525e6b28): the run was BLOCKED for a CEO decision when its canonical
 * CTO's process died. Continuity revoked that generation for the lost runtime but paused nothing (the run
 * was not ACTIVE), so the run held no continuity hold. The same conversation self-claimed the next
 * generation and, with no ACTIVE predecessor, took no run over. The CEO then resolved the escalation:
 * the run was ACTIVE, pinned to the revoked generation, and the successor's run_ack was RUN_OWNER_REVOKED.
 *
 * The continuity pass that finds the successor covering its role now hands it every such run
 * (`RunEngine.takeOverLostPredecessorRuns`), on the hold hand-over's predecessor chain rules. Each
 * refusal below stays where it was.
 */

const CANON = "55555555-5555-4555-8555-555555555555";
const OTHER_CANON = "44444444-4444-4444-8444-444444444444";
const CWD = "/work/stranded-cto";
const ROOM = "buzz-stranded-room";
const CTO_ACTOR = "buzz:stranded-cto";
const OTHER_ACTOR = "buzz:other-cto";
const PEER_PROTOCOL = "mcp/2025-06-18";
const PEER_IDENTITY = "claude-code-mcp-client";
const TAKEN_OVER = "CANONICAL_LIVE_RUNS_TAKEN_OVER";
const report = (takenOver: string[], kept: Array<{ runId: string; why: string }> = []) => ({ takenOver, kept, refused: [] });
const CHAIN_KEPT = "the run's owner pin is not a lost generation of its successor's canonical conversation";

const CONTRACT = {
  goal: "make app() return 2",
  why: "downstream callers expect 2",
  scope: ["src/app.js"],
  nonGoals: [],
  acceptance: ["verify.js exits 0"],
  priority: "NORMAL" as const,
  humanGate: [],
  references: [],
};

const stragglers: ChildProcess[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const child of stragglers.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
});

/** The CTO's claude process as run number `run` of conversation `uuid`. */
const claudeRun = (
  run: number,
  uuid: string,
  claude = { pid: 9 + run, startedAt: `Fri Jan  1 0${run}:00:00 2027` },
): ProcessSnapshot[] => [
  {
    pid: 100, ppid: 50, argv: ["/usr/bin/node", "/opt/acp/mcp-server.js"],
    command: "/usr/bin/node /opt/acp/mcp-server.js", cwd: CWD, cwdProbeFailure: null, startedAt: "t1",
  },
  {
    pid: 50, ppid: claude.pid, argv: ["/bin/zsh", "-c", "relay"], command: "/bin/zsh -c relay", cwd: CWD,
    cwdProbeFailure: null, startedAt: "t2",
  },
  {
    pid: claude.pid, ppid: 1, argv: ["/opt/claude/claude", "--resume", uuid],
    command: `/opt/claude/claude --resume ${uuid}`, cwd: CWD, cwdProbeFailure: null, startedAt: claude.startedAt,
  },
];

const signalFrom = (chain: readonly ProcessSnapshot[]) => (pid: number): void => {
  if (chain.some((entry) => entry.pid === pid)) return;
  throw Object.assign(new Error(`no such process: ${pid}`), { code: "ESRCH" });
};

/** What the fixture's hook is handed: after the daemon started over the dead CTO, before any pass. */
interface Base {
  harness: ReturnType<typeof makeHarness>;
  db: ReturnType<typeof makeHarness>["cp"]["db"];
  runId: string;
  sessionId: string;
  roleKey: string;
  /** Opens a blocking CTO escalation on the run, so it is BLOCKED for a CEO decision. */
  blockForDecision: (runId: string) => void;
}

/**
 * One project whose canonical PRIMARY_CTO (generation 1) owns `runs` dispatched runs. `block` (default)
 * opens a blocking CTO escalation on each, so each is BLOCKED for a CEO decision. Then the CTO's process
 * dies, the daemon starts (`afterStart` runs then), and one continuity pass revokes generation 1 for the
 * lost runtime, as live.
 */
const strandedUnderDaemon = async ({
  runs = 1,
  block = true,
  afterStart,
}: { runs?: number; block?: boolean; afterStart?: (f: Base) => void } = {}) => {
  const harness = makeHarness();
  harness.cp.credentials.install({ token: "test-token", creatorIdentity: "acme-bot" });
  const ceoSessionId = bindCeo(harness);
  const registered = await registerFixtureProject(harness);
  const { projectId } = registered;
  const roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId });
  const { db } = harness.cp;
  bootstrapCtoProvider(harness.cp, harness.clock);

  const live = spawn("/bin/sleep", ["600"], { stdio: "ignore" });
  stragglers.push(live);
  await once(live, "spawn");
  const liveStart = readProcessStartToken(live.pid!);
  if (liveStart === null) throw new Error("the stand-in process has no readable start token");
  const runOne = claudeRun(1, CANON, { pid: live.pid!, startedAt: liveStart });

  const claimAs = (
    run: number,
    who: { uuid: string; actor: string } = { uuid: CANON, actor: CTO_ACTOR },
  ): Promise<Decision<CanonicalSelfClaimReceipt>> => {
    const chain = run === 1 ? runOne : claudeRun(run, who.uuid);
    return new CanonicalSelfClaim(
      db, harness.clock, harness.cp.audit, harness.cp.sessions, harness.cp.bindings,
      { isAllowedActor: () => true },
      async (): Promise<Decision<string>> => allow(ReasonCode.OK, ROOM),
      {
        canonicalSessions: [{ sessionUuid: who.uuid, projectId, buzzActorId: who.actor }],
        canonicalBuzzChannelId: ROOM,
        expectedPeerProtocolVersion: PEER_PROTOCOL,
        expectedPeerIdentity: PEER_IDENTITY,
      },
      {
        processInspector: { snapshot: (pid) => chain.find((entry) => entry.pid === pid) ?? null },
        imageInspector: {
          resolve: () => ({ imagePath: "/fake/claude", version: "0.0.0-test", sha256: `sha256:${"0".repeat(64)}` }),
        },
        transcriptReader: { locate: (uuid) => ({ path: `/fake/transcripts/${uuid}.jsonl`, sizeBytes: 42 }) },
        hostSessionRegistryReader: { read: (pid) => hostSessionRegistryAbsent(`/fake/sessions/${pid}.json is absent`) },
        processSignal: signalFrom(chain),
      },
    ).claim({
      callerPid: 100,
      claimedSessionUuid: who.uuid,
      projectId,
      expectedBindingGeneration: run,
      peerProtocolVersion: PEER_PROTOCOL,
      peerIdentity: PEER_IDENTITY,
      buzzPurpose: "continuity:PRIMARY_CTO",
    });
  };

  const first = await claimAs(1);
  if (!first.allowed) throw new Error(`the first canonical claim failed: ${JSON.stringify(first)}`);
  const sessionId = first.value.sessionId;

  const runIds: string[] = [];
  const escalations = new Map<string, number>();
  for (let index = 0; index < runs; index += 1) {
    const created = harness.cp.runs.create({
      projectId, executionMode: ExecutionMode.STANDARD, contract: CONTRACT,
      repositories: [{ repositoryId: registered.repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
    });
    if (!created.allowed) throw new Error(created.message);
    const runId = created.value.runId;
    const dispatched = await harness.cp.runs.dispatch(runId);
    if (!dispatched.allowed) throw new Error(`${dispatched.reasonCode}: ${dispatched.message}`);
    runIds.push(runId);
  }
  const runId = runIds[0]!;
  const blockForDecision = (id: string) => {
    const opened = harness.cp.ceo.openEscalation({
      runId: id, question: "which schema version?", options: ["v1", "v2"], ctoRecommendation: "v2",
      whyItMatters: "the importer depends on it", blocksCriticalPath: true, openedBySessionId: sessionId,
      openedAt: harness.clock.nowIso(),
    });
    if (!opened.allowed || opened.value.escalationId === null) throw new Error(JSON.stringify(opened));
    escalations.set(id, opened.value.escalationId);
  };
  if (block) for (const id of runIds) blockForDecision(id);

  live.kill("SIGKILL");
  await once(live, "exit");

  const daemon = new Daemon(harness.cp, { stateDir: tempDir("acp-stranded-cto-") });
  const started = await daemon.start({ bootstrapDoor: async () => ({ close: async () => undefined }) });
  if (!started.allowed) throw new Error(`the daemon did not start: ${started.reasonCode}`);
  const base = { harness, db, projectId, roleKey, sessionId, ceoSessionId, runId, runIds, escalations, claimAs, blockForDecision };
  afterStart?.(base);
  await daemon.reconcileContinuity("test: the dead owner");

  const owner = (id = runId) => db.get<{ owner_session_id: string; owner_binding_generation: number; state: string }>(
    `SELECT owner_session_id, owner_binding_generation, state FROM runs WHERE run_id = ?`, [id],
  );
  const takeovers = () => db.all<{ run_id: string; session_id: string; evidence_json: string }>(
    `SELECT run_id, session_id, evidence_json FROM audit_events WHERE kind = ? ORDER BY event_id`, [TAKEN_OVER],
  );
  /** The CEO's answer to the run's escalation, through the CEO door's targeted resolution. */
  const resolve = (id = runId) =>
    harness.cp.ceo.resolveEscalation(id, "use v2", ceoSessionId, { escalationId: escalations.get(id)! });
  return { ...base, daemon, owner, takeovers, resolve };
};
type Fixture = Awaited<ReturnType<typeof strandedUnderDaemon>>;

/** The premise, as live: BLOCKED for the CEO, no continuity hold, generation 1 revoked for its lost runtime. */
const expectStranded = (f: Fixture, state: RunState = RunState.BLOCKED) => {
  expect(f.harness.cp.runs.require(f.runId)).toMatchObject({ state, ownerBindingGeneration: 1, continuityHoldRoleKey: null });
  expect(f.db.get(`SELECT status, revoked_reason FROM assignments WHERE role_key = ? AND binding_generation = 1`, [f.roleKey]))
    .toEqual({ status: "REVOKED", revoked_reason: CONTINUITY_RUNTIME_LOST_REVOCATION_REASON });
};

const claimed = async (claim: Promise<Decision<CanonicalSelfClaimReceipt>>): Promise<CanonicalSelfClaimReceipt> => {
  const result = await claim;
  expect(result.allowed, JSON.stringify(result)).toBe(true);
  if (!result.allowed) throw new Error("unreachable");
  return result.value;
};

/** The role's current holder loses its runtime, and a pass revokes it as continuity does. */
const loseAgain = async (f: Fixture) => {
  const holder = f.harness.cp.bindings.active(f.roleKey)!;
  const settled = f.harness.cp.sessions.transition(holder.sessionId, SessionLifecycle.ERROR, "test: lost again");
  if (!settled.allowed) throw new Error(settled.message);
  await f.daemon.reconcileContinuity("test: lost again");
  expect(f.db.get(`SELECT status, revoked_reason FROM assignments WHERE assignment_id = ?`, [holder.assignmentId]))
    .toEqual({ status: "REVOKED", revoked_reason: CONTINUITY_RUNTIME_LOST_REVOCATION_REASON });
};

/** Every refusal: still pinned to generation 1, no takeover recorded, the successor's run_ack fence refused. */
const expectStillStranded = async (f: Fixture, successor: CanonicalSelfClaimReceipt, why: string) => {
  const pass = await f.daemon.reconcileContinuity("test: the successor");
  expect(pass?.predecessorRuns).toEqual(report([], [{ runId: f.runId, why }]));
  expect(f.owner()?.owner_binding_generation).toBe(1);
  expect(f.owner()?.owner_session_id).toBe(f.sessionId);
  expect(f.takeovers()).toEqual([]);
  expect(f.harness.cp.runs.assertOwner(f.runId, successor.sessionId, successor.binding.bindingGeneration)).toMatchObject({
    allowed: false, reasonCode: ReasonCode.RUN_OWNER_REVOKED,
  });
};

describe("a live run pinned to a dead canonical CTO's revoked generation follows the same conversation's successor", () => {
  it("the live sequence: decision-blocked, the CTO dies and is revoked, the same actor claims, the CEO resolves", async () => {
    const f = await strandedUnderDaemon();
    try {
      expectStranded(f);
      const successor = await claimed(f.claimAs(2));
      expect(f.resolve()).toMatchObject({ allowed: true, value: { state: RunState.ACTIVE } });
      // The live state: ACTIVE ("escalation resolved"), still pinned to the revoked generation.
      expect(f.harness.cp.runs.require(f.runId)).toMatchObject({ state: RunState.ACTIVE, stateReason: "escalation resolved", ownerBindingGeneration: 1 });
      expect(f.harness.cp.runs.assertOwner(f.runId, successor.sessionId, 2)).toMatchObject({ allowed: false, reasonCode: ReasonCode.RUN_OWNER_REVOKED });

      const pass = await f.daemon.reconcileContinuity("test: the successor");
      expect(pass?.predecessorRuns).toEqual(report([f.runId]));
      expect(f.owner()).toEqual({ owner_session_id: successor.sessionId, owner_binding_generation: 2, state: RunState.ACTIVE });
      expect(f.harness.cp.runs.require(f.runId)).toMatchObject({ stateReason: "escalation resolved", continuityHoldRoleKey: null });
      // run_ack: the owner fence admits the successor, and the CEO's reply addressed to it is acknowledged.
      expect(f.harness.cp.runs.assertOwner(f.runId, successor.sessionId, 2).allowed).toBe(true);
      const reply = f.db.get<{ message_id: string }>(
        `SELECT message_id FROM outbox WHERE run_id = ? AND kind = 'ESCALATION_REPLY'`, [f.runId],
      )!;
      expect(f.harness.cp.outbox.acknowledge(reply.message_id, successor.sessionId, 2, successor.binding.sessionIncarnation))
        .toMatchObject({ allowed: true });
      const recorded = f.takeovers();
      expect(recorded.map((row) => ({ runId: row.run_id, sessionId: row.session_id }))).toEqual([
        { runId: f.runId, sessionId: successor.sessionId },
      ]);
      expect(JSON.parse(recorded[0]!.evidence_json)).toMatchObject({
        fromGeneration: 1, toGeneration: 2, fromSession: f.sessionId, toSessionId: successor.sessionId, claimIds: [],
      });
      // A later pass has nothing left to do.
      const again = await f.daemon.reconcileContinuity("test: again");
      expect(again?.predecessorRuns).toEqual(report([]));
      expect(f.takeovers()).toHaveLength(1);
    } finally {
      await f.daemon.stop();
    }
  });

  it("an ACTIVE run, resolved while no CTO was bound, follows the successor that claims after", async () => {
    const f = await strandedUnderDaemon();
    try {
      expectStranded(f);
      // No owner binding to receive a targeted reply, so the in-process resolution, as before.
      expect(f.harness.cp.ceo.resolveEscalation(f.runId, "use v2", f.ceoSessionId)).toMatchObject({ allowed: true });
      expectStranded(f, RunState.ACTIVE);
      await f.daemon.reconcileContinuity("test: no CTO bound");
      expect(f.owner()?.owner_binding_generation).toBe(1);
      const successor = await claimed(f.claimAs(2));
      const pass = await f.daemon.reconcileContinuity("test: the successor");
      expect(pass?.predecessorRuns).toEqual(report([f.runId]));
      expect(f.owner()).toEqual({ owner_session_id: successor.sessionId, owner_binding_generation: 2, state: RunState.ACTIVE });
      expect(f.harness.cp.runs.assertOwner(f.runId, successor.sessionId, 2).allowed).toBe(true);
    } finally {
      await f.daemon.stop();
    }
  });

  it("a decision-blocked run follows at the first pass after the claim, and stays with it once resolved", async () => {
    const f = await strandedUnderDaemon();
    try {
      const successor = await claimed(f.claimAs(2));
      const pass = await f.daemon.reconcileContinuity("test: the successor");
      expect(pass?.predecessorRuns).toEqual(report([f.runId]));
      expect(f.owner()).toEqual({ owner_session_id: successor.sessionId, owner_binding_generation: 2, state: RunState.BLOCKED });
      expect(f.resolve()).toMatchObject({ allowed: true, value: { state: RunState.ACTIVE } });
      expect(f.harness.cp.runs.assertOwner(f.runId, successor.sessionId, 2).allowed).toBe(true);
    } finally {
      await f.daemon.stop();
    }
  });

  it("moves the run's claims of the dead generation with its pin", async () => {
    const f = await strandedUnderDaemon({
      block: false,
      afterStart: (base) => {
        const repo = base.db.get<{ identity: string }>(
          `SELECT r.identity FROM repositories r JOIN run_repositories rr ON rr.repository_id = r.repository_id
            WHERE rr.run_id = ?`,
          [base.runId],
        )!;
        const acquired = base.harness.cp.claims.acquire({
          runId: base.runId, ownerRoleKey: base.roleKey, repositoryIdentity: repo.identity,
          ownerSessionId: base.sessionId, ownerBindingGeneration: 1, branch: "task/stranded",
        } as Parameters<typeof base.harness.cp.claims.acquire>[0]);
        if (!acquired.allowed) throw new Error(JSON.stringify(acquired));
        base.blockForDecision(base.runId);
      },
    });
    try {
      const successor = await claimed(f.claimAs(2));
      await f.daemon.reconcileContinuity("test: the successor");
      expect(f.owner()?.owner_binding_generation).toBe(2);
      const claims = f.db.all<{ claim_id: string; owner_session_id: string; owner_binding_generation: number }>(
        `SELECT claim_id, owner_session_id, owner_binding_generation FROM resource_claims WHERE run_id = ?`, [f.runId],
      );
      expect(claims.map(({ claim_id: _, ...owner }) => owner)).toEqual([{ owner_session_id: successor.sessionId, owner_binding_generation: 2 }]);
      expect(JSON.parse(f.takeovers()[0]!.evidence_json)).toMatchObject({ claimIds: [claims[0]!.claim_id] });
    } finally {
      await f.daemon.stop();
    }
  });

  it("hands every such run over in one transaction: a refused record rolls all of them back", async () => {
    const f = await strandedUnderDaemon({ runs: 2 });
    try {
      await claimed(f.claimAs(2));
      const record = f.harness.cp.audit.record.bind(f.harness.cp.audit);
      let seen = 0;
      vi.spyOn(f.harness.cp.audit, "record").mockImplementation((entry) =>
        entry.kind === TAKEN_OVER && ++seen === 2 ? deny(ReasonCode.AUDIT_WRITE_FAILED, "test: refused") : record(entry));
      const pass = await f.daemon.reconcileContinuity("test: the successor");
      expect(seen).toBe(2);
      expect(pass?.predecessorRuns).toEqual({ takenOver: [], kept: [], refused: [{ roleKey: f.roleKey, reasonCode: ReasonCode.AUDIT_WRITE_FAILED }] });
      for (const runId of f.runIds) expect(f.owner(runId)?.owner_binding_generation).toBe(1);
      expect(f.takeovers()).toEqual([]);
      vi.restoreAllMocks();
      const next = await f.daemon.reconcileContinuity("test: the next pass");
      expect(next?.predecessorRuns.takenOver).toEqual([...f.runIds].sort());
      for (const runId of f.runIds) expect(f.owner(runId)?.owner_binding_generation).toBe(2);
    } finally {
      await f.daemon.stop();
    }
  });

  it("is handed over across a generation of the same conversation that lost its runtime again", async () => {
    const f = await strandedUnderDaemon();
    try {
      await claimed(f.claimAs(2));
      // Gen 2 dies before any pass, so before any hand-over, and continuity revokes it too.
      await loseAgain(f);
      const successor = await claimed(f.claimAs(3));
      const pass = await f.daemon.reconcileContinuity("test: the successor");
      expect(pass?.predecessorRuns).toEqual(report([f.runId]));
      expect(f.owner()).toEqual({ owner_session_id: successor.sessionId, owner_binding_generation: 3, state: RunState.BLOCKED });
      expect(JSON.parse(f.takeovers()[0]!.evidence_json)).toMatchObject({ fromGeneration: 1, toGeneration: 3 });
    } finally {
      await f.daemon.stop();
    }
  });

  it("is handed over when the pinned generation was released by dead-canonical recovery", async () => {
    const f = await strandedUnderDaemon();
    try {
      f.db.run(`UPDATE assignments SET revoked_reason = ? WHERE role_key = ? AND binding_generation = 1`, [
        `${DEAD_CANONICAL_BINDING_RECOVERY_REASON_PREFIX}session ${f.sessionId} process 1 is gone`, f.roleKey,
      ]);
      const successor = await claimed(f.claimAs(2));
      const pass = await f.daemon.reconcileContinuity("test: the successor");
      expect(pass?.predecessorRuns).toEqual(report([f.runId]));
      expect(f.owner()?.owner_session_id).toBe(successor.sessionId);
    } finally {
      await f.daemon.stop();
    }
  });

  describe("stays pinned to the dead generation", () => {
    it("for a different actor's successor", async () => {
      const f = await strandedUnderDaemon();
      try {
        const other = await claimed(f.claimAs(2, { uuid: OTHER_CANON, actor: OTHER_ACTOR }));
        await expectStillStranded(f, other, CHAIN_KEPT);
      } finally {
        await f.daemon.stop();
      }
    });

    it("for a successor whose actor is not a canonical conversation", async () => {
      const f = await strandedUnderDaemon();
      try {
        const successor = await claimed(f.claimAs(2));
        // The one fact changed: the actor's lifetime target is not a self-claimed conversation.
        const side = new Database(f.db.file);
        try {
          side.exec(`DROP TRIGGER actor_target_bindings_immutable`);
          side.prepare(
            `UPDATE actor_target_bindings SET executor_kind = 'hermes'
              WHERE target_actor_id = (SELECT actor_id FROM assignments WHERE role_key = ? AND binding_generation = 1)`,
          ).run(f.roleKey);
        } finally {
          side.close();
        }
        await expectStillStranded(f, successor, CHAIN_KEPT);
      } finally {
        await f.daemon.stop();
      }
    });

    it("for a pin of another role than PRIMARY_CTO", async () => {
      const f = await strandedUnderDaemon();
      try {
        const successor = await claimed(f.claimAs(2));
        // The one fact changed: the pinned assignment's role.
        const side = new Database(f.db.file);
        try {
          side.exec(`DROP TRIGGER assignments_generation_immutable`);
          side.prepare(`UPDATE assignments SET role = 'BOOTSTRAP_CTO' WHERE role_key = ? AND binding_generation = 1`).run(f.roleKey);
        } finally {
          side.close();
        }
        await expectStillStranded(f, successor, CHAIN_KEPT);
      } finally {
        await f.daemon.stop();
      }
    });

    for (const reason of [
      "CEO delegated release: stop this CTO",
      "CEO delegated replacement of proven-dead runtime",
      "project suspended: operator",
    ]) {
      it(`for a pinned generation revoked deliberately: ${reason}`, async () => {
        const f = await strandedUnderDaemon();
        try {
          f.db.run(`UPDATE assignments SET revoked_reason = ? WHERE role_key = ? AND binding_generation = 1`, [reason, f.roleKey]);
          const successor = await claimed(f.claimAs(2));
          await expectStillStranded(f, successor, CHAIN_KEPT);
        } finally {
          await f.daemon.stop();
        }
      });
    }

    it("after a deliberate revocation of a generation between the pin and the successor", async () => {
      const f = await strandedUnderDaemon();
      try {
        // Gen 2 is released deliberately before any pass, so before any hand-over.
        await claimed(f.claimAs(2));
        const released = f.harness.cp.bindings.revoke(f.roleKey, "CEO delegated release: stop this CTO");
        expect(released.allowed, JSON.stringify(released)).toBe(true);
        const successor = await claimed(f.claimAs(3));
        await expectStillStranded(f, successor, CHAIN_KEPT);
      } finally {
        await f.daemon.stop();
      }
    });

    it("across a generation of another actor, though it too lost its runtime", async () => {
      const f = await strandedUnderDaemon();
      try {
        await claimed(f.claimAs(2, { uuid: OTHER_CANON, actor: OTHER_ACTOR }));
        await loseAgain(f);
        const successor = await claimed(f.claimAs(3));
        await expectStillStranded(f, successor, CHAIN_KEPT);
      } finally {
        await f.daemon.stop();
      }
    });

    it("while the owner has suspended the project", async () => {
      const f = await strandedUnderDaemon();
      try {
        // Suspended while no CTO is bound, so the suspension revokes nothing; the successor claims after.
        const suspended = await f.harness.cp.cto.suspendProject(f.projectId, true, "owner stop", undefined, "test-owner");
        expect(suspended.allowed, JSON.stringify(suspended)).toBe(true);
        const successor = await claimed(f.claimAs(2));
        await expectStillStranded(f, successor, "the run's project is suspended");
      } finally {
        await f.daemon.stop();
      }
    });

    it("while a task execution of the run is RUNNING", async () => {
      const f = await strandedUnderDaemon({
        block: false,
        afterStart: (base) => {
          const tasks = base.harness.cp.tasks.submit(base.runId, [{ key: "impl", title: "change app()", category: "implementation" }]);
          if (!tasks.allowed) throw new Error(tasks.message);
          const task = base.harness.cp.tasks.ready(base.runId)[0]!;
          const workerSessionId = bindWorker(base.harness, task.taskId);
          const execution = base.harness.cp.tasks.startExecution({
            runId: base.runId, taskId: task.taskId, ownerBindingGeneration: 1, workerSessionId,
            provider: "scripted", model: "scripted-worker",
          });
          if (!execution.allowed) throw new Error(execution.message);
          base.blockForDecision(base.runId);
        },
      });
      try {
        expectStranded(f);
        const successor = await claimed(f.claimAs(2));
        await expectStillStranded(f, successor, "the predecessor generation still has a RUNNING task execution on the run");
      } finally {
        await f.daemon.stop();
      }
    });

    it("while a candidate pipeline attempt of the dead generation is RUNNING", async () => {
      const f = await strandedUnderDaemon({
        afterStart: (base) => {
          base.db.run(
            `INSERT INTO candidate_pipeline_attempts (run_id, attempt_id, owner_session_id, owner_binding_generation, state, started_at, deadline_at)
             VALUES (?, 'cpa_stranded', ?, 1, 'RUNNING', ?, '2999-01-01T00:00:00.000Z')`,
            [base.runId, base.sessionId, base.harness.clock.nowIso()],
          );
        },
      });
      try {
        const successor = await claimed(f.claimAs(2));
        await expectStillStranded(f, successor, "the predecessor generation still has a RUNNING candidate pipeline attempt on the run");
      } finally {
        await f.daemon.stop();
      }
    });

    it("for a successor that is not READY", async () => {
      const f = await strandedUnderDaemon();
      try {
        await claimed(f.claimAs(2));
        const successor = f.harness.cp.bindings.active(f.roleKey)!;
        const settled = f.harness.cp.sessions.transition(successor.sessionId, SessionLifecycle.ERROR, "test: successor lost");
        if (!settled.allowed) throw new Error(settled.message);
        // A pass does not count it as covering the role, so the hand-over is asked directly.
        expect(f.harness.cp.runs.takeOverLostPredecessorRuns(successor)).toMatchObject({
          allowed: true, value: { takenOver: [], kept: [{ runId: f.runId, why: "the successor's session is not READY" }] },
        });
        expect(f.owner()?.owner_binding_generation).toBe(1);
        expect(f.takeovers()).toEqual([]);
      } finally {
        await f.daemon.stop();
      }
    });

    it("for a successor that is no longer its role's active binding", async () => {
      const f = await strandedUnderDaemon();
      try {
        const second = await claimed(f.claimAs(2));
        // Gen 2 dies before any pass, so before any hand-over; gen 3 claims and is not asked.
        await loseAgain(f);
        await claimed(f.claimAs(3));
        expect(f.harness.cp.runs.takeOverLostPredecessorRuns(second.binding)).toMatchObject({
          allowed: true, value: { takenOver: [], kept: [{ runId: f.runId, why: "the successor is no longer its role's active binding" }] },
        });
        expect(f.owner()?.owner_binding_generation).toBe(1);
        expect(f.takeovers()).toEqual([]);
      } finally {
        await f.daemon.stop();
      }
    });

    it("for a run that has ended", async () => {
      const f = await strandedUnderDaemon();
      try {
        const cancelled = f.harness.cp.runs.transition(f.runId, RunState.CANCELLED, "test: ended");
        expect(cancelled.allowed, JSON.stringify(cancelled)).toBe(true);
        await claimed(f.claimAs(2));
        const pass = await f.daemon.reconcileContinuity("test: the successor");
        expect(pass?.predecessorRuns).toEqual(report([]));
        expect(f.owner()).toMatchObject({ owner_binding_generation: 1, state: RunState.CANCELLED });
      } finally {
        await f.daemon.stop();
      }
    });

    it("for a continuity-held run, which the hold path keeps", async () => {
      const f = await strandedUnderDaemon({ block: false });
      try {
        // ACTIVE when the CTO died: continuity's own hold, then something moved under it.
        expect(f.harness.cp.runs.require(f.runId)).toMatchObject({
          state: RunState.BLOCKED, stateReason: CONTINUITY_PAUSE_RUNTIME_LOST_REASON, continuityHoldRoleKey: f.roleKey,
        });
        f.harness.cp.audit.record({ kind: "RUN_PRIORITY_SET", runId: f.runId, evidence: { priority: "HIGH" } });
        await claimed(f.claimAs(2));
        const pass = await f.daemon.reconcileContinuity("test: the successor");
        expect(pass?.continuityHolds.kept.map((kept) => kept.runId)).toEqual([f.runId]);
        expect(pass?.predecessorRuns).toEqual(report([]));
        expect(f.owner()).toMatchObject({ owner_session_id: f.sessionId, owner_binding_generation: 1, state: RunState.BLOCKED });
        expect(f.takeovers()).toEqual([]);
      } finally {
        await f.daemon.stop();
      }
    });
  });
});
