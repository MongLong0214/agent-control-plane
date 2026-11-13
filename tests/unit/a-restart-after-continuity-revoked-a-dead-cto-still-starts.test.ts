import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";

import Database from "better-sqlite3";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { CONTINUITY_RUNTIME_LOST_REVOCATION_REASON } from "../../src/continuity/continuity-kernel.ts";
import { type Decision, allow } from "../../src/core/errors.ts";
import { readProcessStartToken } from "../../src/core/process-argv.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Daemon, type ReconcileReport } from "../../src/daemon/daemon.ts";
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
 * Measured live (2026-11-13 19:02Z): every restart of agentcpd was refused DOCTOR_BLOCKED on
 * SESSION_PROCESS_MISSING for two dead canonical PRIMARY_CTO sessions. A continuity pass after #1391
 * had already paused each one's ACTIVE run ("the runtime was lost and not failed over") and revoked
 * its binding, and each conversation had re-attached at a new generation. Each dead session so held
 * no ACTIVE binding but still owned a continuity-held BLOCKED run pinned to its generation; the
 * system gate required an ACTIVE binding to call it recoverable, so its owned run blocked, and the
 * #1392 hand-over to the successor only runs in a continuity pass, after start.
 *
 * The system gate now also counts that session as recoverable when every run it owns is owned under
 * its project's PRIMARY_CTO role key and no RUNNING execution or pipeline attempt is on those runs or
 * in its name. After the restart the continuity pass hands the held run to the same-actor successor.
 */

const CANON = "55555555-5555-4555-8555-555555555555";
const CWD = "/work/revoked-cto";
const ROOM = "buzz-revoked-room";
const CTO_ACTOR = "buzz:revoked-cto";
const PEER_PROTOCOL = "mcp/2025-06-18";
const PEER_IDENTITY = "claude-code-mcp-client";
const HANDED_OVER = "CONTINUITY_HOLD_HANDED_TO_SUCCESSOR";

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
  for (const child of stragglers.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
});

/** A pid already exited and reaped, so `kill(pid, 0)` fails for it from here on. */
const deadPid = (): number => {
  const finished = spawnSync("/usr/bin/true", [], { stdio: "ignore", timeout: 30_000 });
  if (finished.signal !== null || typeof finished.pid !== "number") throw new Error("no reaped child pid");
  return finished.pid;
};

/** A running stand-in for a claude process, so liveness probes and the startup sweep see it alive. */
const liveClaude = async (): Promise<{ child: ChildProcess; pid: number; startedAt: string }> => {
  const child = spawn("/bin/sleep", ["600"], { stdio: "ignore" });
  stragglers.push(child);
  await once(child, "spawn");
  const startedAt = readProcessStartToken(child.pid!);
  if (startedAt === null) throw new Error("the stand-in process has no readable start token");
  return { child, pid: child.pid!, startedAt };
};

const claudeChain = (claude: { pid: number; startedAt: string }): ProcessSnapshot[] => [
  {
    pid: 100, ppid: 50, argv: ["/usr/bin/node", "/opt/acp/mcp-server.js"],
    command: "/usr/bin/node /opt/acp/mcp-server.js", cwd: CWD, cwdProbeFailure: null, startedAt: "t1",
  },
  {
    pid: 50, ppid: claude.pid, argv: ["/bin/zsh", "-c", "relay"], command: "/bin/zsh -c relay", cwd: CWD,
    cwdProbeFailure: null, startedAt: "t2",
  },
  {
    pid: claude.pid, ppid: 1, argv: ["/opt/claude/claude", "--resume", CANON],
    command: `/opt/claude/claude --resume ${CANON}`, cwd: CWD, cwdProbeFailure: null, startedAt: claude.startedAt,
  },
];

const signalFrom = (chain: readonly ProcessSnapshot[]) => (pid: number): void => {
  if (chain.some((entry) => entry.pid === pid)) return;
  throw Object.assign(new Error(`no such process: ${pid}`), { code: "ESRCH" });
};

/** Starts a daemon over the control plane and reports whether it came up or refused. */
const startDaemon = async (harness: ReturnType<typeof makeHarness>) => {
  const daemon = new Daemon(harness.cp, { stateDir: tempDir("acp-revoked-cto-") });
  let markParked: () => void = () => undefined;
  const parked = new Promise<"parked">((resolve) => { markParked = () => resolve("parked"); });
  const starting = daemon.start({
    bootstrapDoor: async () => {
      markParked();
      return { close: async () => undefined };
    },
  });
  const first = await Promise.race([starting, parked]);
  if (first === "parked") {
    await daemon.stop();
    await starting;
    throw new Error("the daemon parked instead of starting");
  }
  const started = first as Decision<ReconcileReport>;
  const report = started.allowed
    ? started.value
    : (started.evidence as { reconcile?: ReconcileReport }).reconcile ?? null;
  return { daemon, started, blocking: report?.blockingFindings ?? [] };
};

/**
 * The live state: a canonical PRIMARY_CTO (generation 1) owned a dispatched ACTIVE run and died; a
 * daemon started over it, and its continuity pass paused the run for the lost runtime and revoked
 * the binding; then that daemon stopped. `successorBeforeStop` re-attaches the same conversation
 * at generation 2 (a live process) before the stop.
 */
const deadOwner = async () => {
  const harness = makeHarness();
  harness.cp.credentials.install({ token: "test-token", creatorIdentity: "acme-bot" });
  const ceoSessionId = bindCeo(harness);
  const registered = await registerFixtureProject(harness);
  const { projectId } = registered;
  const roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId });
  const { db } = harness.cp;
  bootstrapCtoProvider(harness.cp, harness.clock);

  const claimAs = (run: number, claude: { pid: number; startedAt: string }): Promise<Decision<CanonicalSelfClaimReceipt>> => {
    const chain = claudeChain(claude);
    return new CanonicalSelfClaim(
      db, harness.clock, harness.cp.audit, harness.cp.sessions, harness.cp.bindings,
      { isAllowedActor: () => true },
      async (): Promise<Decision<string>> => allow(ReasonCode.OK, ROOM),
      {
        canonicalSessions: [{ sessionUuid: CANON, projectId, buzzActorId: CTO_ACTOR }],
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
      claimedSessionUuid: CANON,
      projectId,
      expectedBindingGeneration: run,
      peerProtocolVersion: PEER_PROTOCOL,
      peerIdentity: PEER_IDENTITY,
      buzzPurpose: "continuity:PRIMARY_CTO",
    });
  };

  const genOne = await liveClaude();
  const first = await claimAs(1, genOne);
  if (!first.allowed) throw new Error(`the first canonical claim failed: ${JSON.stringify(first)}`);
  const sessionId = first.value.sessionId;

  const created = harness.cp.runs.create({
    projectId, executionMode: ExecutionMode.STANDARD, contract: CONTRACT,
    repositories: [{ repositoryId: registered.repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
  });
  if (!created.allowed) throw new Error(created.message);
  const runId = created.value.runId;
  const dispatched = await harness.cp.runs.dispatch(runId);
  if (!dispatched.allowed) throw new Error(`${dispatched.reasonCode}: ${dispatched.message}`);

  genOne.child.kill("SIGKILL");
  await once(genOne.child, "exit");

  const owner = () => db.get<{ owner_session_id: string; owner_binding_generation: number; state: string }>(
    `SELECT owner_session_id, owner_binding_generation, state FROM runs WHERE run_id = ?`, [runId],
  );
  const handOvers = () => db.all<{ run_id: string; session_id: string; evidence_json: string }>(
    `SELECT run_id, session_id, evidence_json FROM audit_events WHERE kind = ?`, [HANDED_OVER],
  );
  /** The SESSION_PROCESS_MISSING finding `scope`'s report gives `id`, as severity and blocking. */
  const finding = async (id: string, scope: "system" | "session" = "system", target?: string) => {
    const report = await harness.cp.doctor.run(scope, target);
    const found = report.findings.find((f) => f.code === "SESSION_PROCESS_MISSING" && f.scope === `session:${id}`);
    return found ? { severity: found.severity, blocking: found.blocking } : null;
  };
  return { harness, db, projectId, roleKey, sessionId, ceoSessionId, runId, claimAs, owner, handOvers, finding };
};
type Fixture = Awaited<ReturnType<typeof deadOwner>>;

const pausedRevokedAndStopped = async (steps: {
  beforePause?: (f: Fixture) => void | Promise<void>;
  successorBeforeStop?: boolean;
} = {}): Promise<Fixture> => {
  const f = await deadOwner();
  const { harness, db, roleKey, sessionId, runId, claimAs } = f;
  const before = await startDaemon(harness);
  if (!before.started.allowed) throw new Error(`the first daemon did not start: ${before.started.reasonCode}`);
  try {
    await steps.beforePause?.(f);
    await before.daemon.reconcileContinuity("test: the dead owner");
    // The premise, as measured live: settled, paused for the lost runtime, held, and the dead generation revoked.
    expect(harness.cp.sessions.require(sessionId).lifecycle).toBe(SessionLifecycle.ERROR);
    expect(harness.cp.runs.require(runId)).toMatchObject({
      state: RunState.BLOCKED, stateReason: CONTINUITY_PAUSE_RUNTIME_LOST_REASON,
      ownerSessionId: sessionId, ownerBindingGeneration: 1, continuityHoldRoleKey: roleKey,
    });
    expect(db.get(`SELECT status, revoked_reason FROM assignments WHERE role_key = ? AND binding_generation = 1`, [roleKey]))
      .toEqual({ status: "REVOKED", revoked_reason: CONTINUITY_RUNTIME_LOST_REVOCATION_REASON });
    expect(db.all(`SELECT 1 FROM assignments WHERE status = 'ACTIVE' AND session_id = ?`, [sessionId])).toEqual([]);
    if (steps.successorBeforeStop) {
      const genTwo = await liveClaude();
      const claimed = await claimAs(2, genTwo);
      expect(claimed.allowed, JSON.stringify(claimed)).toBe(true);
    }
  } finally {
    await before.daemon.stop();
  }
  return f;
};

/** The startup doctor's own record of the SESSION_PROCESS_MISSING findings: the latest system DOCTOR_REPORT. */
const startupFindings = (f: Fixture) =>
  f.harness.cp.audit
    .byKind("DOCTOR_REPORT")
    .map((event) => event.evidence as {
      scope: string;
      findings: Array<{ code: string; severity: string; blocking: boolean }>;
    })
    .filter((evidence) => evidence.scope === "system")
    .at(-1)
    ?.findings.filter((found) => found.code === "SESSION_PROCESS_MISSING");

/** After a continuity pass: the run is the successor's, ACTIVE, released, and the hand-over recorded once. */
const expectHandedTo = async (f: Fixture, daemon: Daemon) => {
  await daemon.reconcileContinuity("test: after the restart");
  const successor = f.harness.cp.bindings.active(f.roleKey)!;
  expect(successor).toMatchObject({ bindingGeneration: 2 });
  expect(successor.sessionId).not.toBe(f.sessionId);
  expect(f.owner()).toEqual({ owner_session_id: successor.sessionId, owner_binding_generation: 2, state: RunState.ACTIVE });
  expect(f.harness.cp.runs.require(f.runId).continuityHoldRoleKey).toBeNull();
  expect(f.harness.cp.runs.assertOwner(f.runId, successor.sessionId, 2).allowed).toBe(true);
  const recorded = f.handOvers();
  expect(recorded.map((row) => ({ runId: row.run_id, sessionId: row.session_id }))).toEqual([
    { runId: f.runId, sessionId: successor.sessionId },
  ]);
  expect(JSON.parse(recorded[0]!.evidence_json)).toMatchObject({ fromGeneration: 1, toGeneration: 2, fromSession: f.sessionId });
  // Released and owning nothing, the dead session is no longer an ERROR.
  expect((await f.finding(f.sessionId))?.severity).not.toBe("ERROR");
};

describe("a restart after continuity revoked a dead canonical CTO that still owns a held run", () => {
  it("starts, reports the dead owner without blocking, and hands the run to the generation that self-claims after", async () => {
    const f = await pausedRevokedAndStopped();
    const { daemon, started, blocking } = await startDaemon(f.harness);
    try {
      expect({ allowed: started.allowed, reasonCode: started.reasonCode, blocking }).toEqual({
        allowed: true, reasonCode: ReasonCode.OK, blocking: [],
      });
      expect(startupFindings(f)).toEqual([{ code: "SESSION_PROCESS_MISSING", severity: "ERROR", blocking: false }]);
      expect(await f.finding(f.sessionId)).toEqual({ severity: "ERROR", blocking: false });
      // Still held for the dead generation until the successor exists.
      expect(f.owner()).toEqual({ owner_session_id: f.sessionId, owner_binding_generation: 1, state: RunState.BLOCKED });

      const claimed = await f.claimAs(2, await liveClaude());
      expect(claimed.allowed, JSON.stringify(claimed)).toBe(true);
      await expectHandedTo(f, daemon);
    } finally {
      await daemon.stop();
    }
  });

  it("starts with the successor generation already ACTIVE, and the continuity pass hands the run to it", async () => {
    const f = await pausedRevokedAndStopped({ successorBeforeStop: true });
    expect(f.owner()).toEqual({ owner_session_id: f.sessionId, owner_binding_generation: 1, state: RunState.BLOCKED });
    const { daemon, started, blocking } = await startDaemon(f.harness);
    try {
      expect({ allowed: started.allowed, reasonCode: started.reasonCode, blocking }).toEqual({
        allowed: true, reasonCode: ReasonCode.OK, blocking: [],
      });
      expect(startupFindings(f)).toEqual([{ code: "SESSION_PROCESS_MISSING", severity: "ERROR", blocking: false }]);
      await expectHandedTo(f, daemon);
    } finally {
      await daemon.stop();
    }
  });

  describe("still blocks", () => {
    it("any report but the system one", async () => {
      const f = await pausedRevokedAndStopped();
      for (const target of [f.sessionId, undefined]) {
        expect(await f.finding(f.sessionId, "session", target)).toEqual({ severity: "ERROR", blocking: true });
      }
    });

    it("a session whose lifecycle is not terminal", async () => {
      const f = await pausedRevokedAndStopped();
      f.db.run(`UPDATE sessions SET lifecycle = 'READY' WHERE session_id = ?`, [f.sessionId]);
      expect(f.harness.cp.sessions.require(f.sessionId).lifecycle).toBe(SessionLifecycle.READY);
      expect(await f.finding(f.sessionId)).toEqual({ severity: "ERROR", blocking: true });
    });

    it("a dead CEO that owns a run", async () => {
      const f = await pausedRevokedAndStopped();
      f.harness.cp.sessions.setPid(f.ceoSessionId, deadPid());
      expect(f.harness.cp.sessions.transition(f.ceoSessionId, SessionLifecycle.ERROR, "test: process gone").allowed).toBe(true);
      expect(await f.finding(f.ceoSessionId)).toEqual({ severity: "ERROR", blocking: false });
      f.db.run(
        `UPDATE runs SET (owner_role_key, owner_binding_generation, owner_session_id, owner_session_incarnation) =
           (SELECT role_key, binding_generation, session_id, session_incarnation FROM assignments
             WHERE role_key = 'CEO' AND status = 'ACTIVE')
          WHERE run_id = ?`,
        [f.runId],
      );
      expect(f.harness.cp.runs.activeRunsOwnedBy(f.ceoSessionId).map((run) => run.runId)).toEqual([f.runId]);
      expect(await f.finding(f.ceoSessionId)).toEqual({ severity: "ERROR", blocking: true });
    });

    it("a dead session with no ACTIVE binding whose run is owned under another role key than its project's PRIMARY_CTO", async () => {
      const f = await pausedRevokedAndStopped();
      f.harness.cp.sessions.setPid(f.ceoSessionId, deadPid());
      expect(f.harness.cp.sessions.transition(f.ceoSessionId, SessionLifecycle.ERROR, "test: process gone").allowed).toBe(true);
      f.db.run(
        `UPDATE runs SET (owner_role_key, owner_binding_generation, owner_session_id, owner_session_incarnation) =
           (SELECT role_key, binding_generation, session_id, session_incarnation FROM assignments
             WHERE role_key = 'CEO' AND status = 'ACTIVE')
          WHERE run_id = ?`,
        [f.runId],
      );
      f.db.run(`UPDATE assignments SET status = 'REVOKED', revoked_reason = 'test: released' WHERE role_key = 'CEO' AND status = 'ACTIVE'`);
      expect(f.db.all(`SELECT 1 FROM assignments WHERE status = 'ACTIVE' AND session_id = ?`, [f.ceoSessionId])).toEqual([]);
      expect(f.harness.cp.runs.require(f.runId).ownerRoleKey).toBe("CEO");
      expect(await f.finding(f.ceoSessionId)).toEqual({ severity: "ERROR", blocking: true });
    });

    it("a dead session holding an ACTIVE binding of another authority", async () => {
      let workerSessionId = "";
      const f = await pausedRevokedAndStopped({
        beforePause: (fixture) => {
          const tasks = fixture.harness.cp.tasks.submit(fixture.runId, [{ key: "impl", title: "change app()", category: "implementation" }]);
          if (!tasks.allowed) throw new Error(tasks.message);
          workerSessionId = bindWorker(fixture.harness, fixture.harness.cp.tasks.ready(fixture.runId)[0]!.taskId);
        },
      });
      f.harness.cp.sessions.setPid(workerSessionId, deadPid());
      expect(f.harness.cp.sessions.transition(workerSessionId, SessionLifecycle.ERROR, "test: process gone").allowed).toBe(true);
      expect(f.db.all(`SELECT role FROM assignments WHERE status = 'ACTIVE' AND session_id = ?`, [workerSessionId]))
        .toEqual([{ role: Role.WORKER }]);
      expect(await f.finding(workerSessionId)).toEqual({ severity: "ERROR", blocking: true });
    });

    it("a RUNNING execution on its run, held by a separate WORKER session", async () => {
      let workerSessionId = "";
      const f = await pausedRevokedAndStopped({
        beforePause: (fixture) => {
          const tasks = fixture.harness.cp.tasks.submit(fixture.runId, [{ key: "impl", title: "change app()", category: "implementation" }]);
          if (!tasks.allowed) throw new Error(tasks.message);
          const task = fixture.harness.cp.tasks.ready(fixture.runId)[0]!;
          workerSessionId = bindWorker(fixture.harness, task.taskId);
          const execution = fixture.harness.cp.tasks.startExecution({
            runId: fixture.runId, taskId: task.taskId, ownerBindingGeneration: 1, workerSessionId,
            provider: "scripted", model: "scripted-worker",
          });
          if (!execution.allowed) throw new Error(execution.message);
        },
      });
      expect(workerSessionId).not.toBe(f.sessionId);
      expect(f.db.get(`SELECT status FROM task_executions WHERE run_id = ?`, [f.runId])).toEqual({ status: "RUNNING" });
      expect(await f.finding(f.sessionId)).toEqual({ severity: "ERROR", blocking: true });
    });

    it("a RUNNING candidate pipeline attempt on its run", async () => {
      const f = await pausedRevokedAndStopped();
      // In another session's name, so only the attempt's run ties it to the dead owner.
      f.db.run(
        `INSERT INTO candidate_pipeline_attempts (run_id, attempt_id, owner_session_id, owner_binding_generation, state, started_at, deadline_at)
         VALUES (?, 'cpa_owned_run', 'ses_someone_else', 1, 'RUNNING', ?, '2999-01-01T00:00:00.000Z')`,
        [f.runId, f.harness.clock.nowIso()],
      );
      expect(await f.finding(f.sessionId)).toEqual({ severity: "ERROR", blocking: true });
    });

    it("a RUNNING candidate pipeline attempt in its name on a run it does not own", async () => {
      const f = await pausedRevokedAndStopped();
      const other = f.harness.cp.runs.create({
        projectId: f.projectId, executionMode: ExecutionMode.STANDARD, contract: CONTRACT,
        repositories: [{
          repositoryId: f.db.get<{ repository_id: string }>(`SELECT repository_id FROM run_repositories WHERE run_id = ?`, [f.runId])!.repository_id,
          repositoryRole: "primary", baseBranch: "dev",
        }],
      });
      if (!other.allowed) throw new Error(other.message);
      expect(f.harness.cp.runs.require(other.value.runId).ownerSessionId ?? null).not.toBe(f.sessionId);
      f.db.run(
        `INSERT INTO candidate_pipeline_attempts (run_id, attempt_id, owner_session_id, owner_binding_generation, state, started_at, deadline_at)
         VALUES (?, 'cpa_own_name', ?, 1, 'RUNNING', ?, '2999-01-01T00:00:00.000Z')`,
        [other.value.runId, f.sessionId, f.harness.clock.nowIso()],
      );
      expect(await f.finding(f.sessionId)).toEqual({ severity: "ERROR", blocking: true });
    });

    it("a RUNNING execution in its own name", async () => {
      let workerSessionId = "";
      const f = await pausedRevokedAndStopped({
        beforePause: (fixture) => {
          const tasks = fixture.harness.cp.tasks.submit(fixture.runId, [{ key: "impl", title: "change app()", category: "implementation" }]);
          if (!tasks.allowed) throw new Error(tasks.message);
          const task = fixture.harness.cp.tasks.ready(fixture.runId)[0]!;
          workerSessionId = bindWorker(fixture.harness, task.taskId);
          const execution = fixture.harness.cp.tasks.startExecution({
            runId: fixture.runId, taskId: task.taskId, ownerBindingGeneration: 1, workerSessionId,
            provider: "scripted", model: "scripted-worker",
          });
          if (!execution.allowed) throw new Error(execution.message);
        },
      });
      // The dead worker itself: its binding released, owning no run, its execution still RUNNING.
      f.harness.cp.sessions.setPid(workerSessionId, deadPid());
      expect(f.harness.cp.sessions.transition(workerSessionId, SessionLifecycle.ERROR, "test: process gone").allowed).toBe(true);
      const side = new Database(f.db.file);
      try {
        side.prepare(`UPDATE assignments SET status = 'REVOKED', revoked_reason = 'test: released' WHERE session_id = ? AND status = 'ACTIVE'`)
          .run(workerSessionId);
      } finally {
        side.close();
      }
      expect(f.db.all(`SELECT 1 FROM assignments WHERE status = 'ACTIVE' AND session_id = ?`, [workerSessionId])).toEqual([]);
      expect(f.harness.cp.runs.activeRunsOwnedBy(workerSessionId)).toEqual([]);
      expect(f.db.get(`SELECT status FROM task_executions WHERE worker_session_id = ?`, [workerSessionId])).toEqual({ status: "RUNNING" });
      expect(await f.finding(workerSessionId)).toEqual({ severity: "ERROR", blocking: true });
    });
  });
});
