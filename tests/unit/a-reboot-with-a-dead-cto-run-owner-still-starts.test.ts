import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";

import Database from "better-sqlite3";

import { afterAll, afterEach, describe, expect, it } from "vitest";

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
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { bindCeo, bindWorker, bootstrapCtoProvider, makeHarness, registerFixtureProject } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * Measured live after the 2026-11-13 reboot: agentcpd refused every start DOCTOR_BLOCKED, and the
 * only blocking findings were SESSION_PROCESS_MISSING for two canonical PRIMARY_CTO sessions the
 * reboot had killed. Each was settled ERROR, held its project's PRIMARY_CTO binding ACTIVE and owned
 * one ACTIVE run, with no RUNNING execution. With the daemon down there was no claim socket for the
 * CTO to reattach through and no CEO tool to cancel the run, so the lock could not be cleared.
 *
 * The system gate now treats that session as recoverable: the finding stays an ERROR and is still
 * reported, but does not block. After startup the run is reached through two existing paths, both
 * proved here: the same actor's next-generation self-claim releases the dead generation and moves
 * its live runs onto the successor (`CanonicalSelfClaim` -> `recoverDeadCanonicalBinding` with
 * `takeOverLiveRunsForSameActorSuccessor` -> `BindingRegistry.repointLiveRunsToSameActorSuccessor`),
 * and the CEO's `run_cancel` (`RunEngine.cancel`) names no owner and cancels it.
 */

const CANON = "88888888-8888-4888-8888-888888888888";
const CWD = "/work/rebooted-cto";
const ROOM = "buzz-rebooted-room";
const CTO_ACTOR = "buzz:rebooted-cto";
const PEER_PROTOCOL = "mcp/2025-06-18";
const PEER_IDENTITY = "claude-code-mcp-client";

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
  expect(() => process.kill(finished.pid!, 0)).toThrow();
  return finished.pid;
};

/** The CTO's claude process as run number `run`: a new pid and start each restart. */
const claudeRun = (run: number, claude = { pid: 9 + run, startedAt: `Fri Jan  1 0${run}:00:00 2027` }): ProcessSnapshot[] => [
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

/**
 * One project whose canonical PRIMARY_CTO (generation 1) owns one dispatched ACTIVE run, and whose
 * process is then killed with nothing revoked: the state the reboot left. The session is still
 * READY; the daemon's startup sweep, or `settle`, makes it ERROR.
 */
const rebootedCto = async () => {
  const harness = makeHarness();
  // Without these the system doctor blocks on a credential or a missing CEO, not the case under test.
  harness.cp.credentials.install({ token: "test-token", creatorIdentity: "acme-bot" });
  const ceoSessionId = bindCeo(harness);
  const registered = await registerFixtureProject(harness);
  const { projectId } = registered;
  const roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId });
  const { db } = harness.cp;
  bootstrapCtoProvider(harness.cp, harness.clock);

  // Dispatch pins a canonical CTO's run only to a running process, so generation 1 is a real one.
  const live = spawn("/bin/sleep", ["600"], { stdio: "ignore" });
  stragglers.push(live);
  await once(live, "spawn");
  const liveStart = readProcessStartToken(live.pid!);
  if (liveStart === null) throw new Error("the stand-in process has no readable start token");
  const runOne = claudeRun(1, { pid: live.pid!, startedAt: liveStart });

  const claimAs = (run: number): Promise<Decision<CanonicalSelfClaimReceipt>> => {
    const chain = run === 1 ? runOne : claudeRun(run);
    return new CanonicalSelfClaim(
      db,
      harness.clock,
      harness.cp.audit,
      harness.cp.sessions,
      harness.cp.bindings,
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

  const first = await claimAs(1);
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
  expect(dispatched.value).toMatchObject({ state: RunState.ACTIVE, ownerSessionId: sessionId, ownerBindingGeneration: 1 });

  // The reboot: the process is gone, and nothing revoked the binding or ended the run.
  live.kill("SIGKILL");
  await once(live, "exit");

  const owner = () => db.get<{ owner_session_id: string; owner_binding_generation: number; state: string }>(
    `SELECT owner_session_id, owner_binding_generation, state FROM runs WHERE run_id = ?`, [runId],
  );
  /** What the startup sweep does to a session whose process is gone. */
  const settle = (id: string) => {
    const settled = harness.cp.sessions.transition(id, SessionLifecycle.ERROR, "test: process gone");
    if (!settled.allowed) throw new Error(settled.message);
  };
  /** The SESSION_PROCESS_MISSING finding `scope`'s report gives `id`, as severity and blocking. */
  const finding = async (scope: "system" | "session", id: string, target?: string) => {
    const report = await harness.cp.doctor.run(scope, target);
    const found = report.findings.find((f) => f.code === "SESSION_PROCESS_MISSING" && f.scope === `session:${id}`);
    return found ? { severity: found.severity, blocking: found.blocking } : null;
  };

  return { harness, db, projectId, roleKey, sessionId, ceoSessionId, runId, claimAs, owner, settle, finding };
};

/** Starts the daemon and reports whether it came up, parked, or refused. */
const startDaemon = async (fixture: Awaited<ReturnType<typeof rebootedCto>>) => {
  const daemon = new Daemon(fixture.harness.cp, { stateDir: tempDir("acp-rebooted-cto-") });
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
 * The startup doctor's own record of the session's finding: the latest system DOCTOR_REPORT, read
 * right after `start()` returns (an earlier one, from dispatch, saw the process still running).
 */
const startupFinding = (fixture: Awaited<ReturnType<typeof rebootedCto>>) =>
  fixture.harness.cp.audit
    .byKind("DOCTOR_REPORT")
    .map((event) => event.evidence as {
      scope: string;
      findings: Array<{ code: string; severity: string; blocking: boolean }>;
    })
    .filter((evidence) => evidence.scope === "system")
    .at(-1)
    ?.findings.filter((f) => f.code === "SESSION_PROCESS_MISSING");

describe("a reboot that kills a canonical CTO owning an ACTIVE run", () => {
  it("starts the daemon, and the same actor's next-generation claim takes the run over", async () => {
    const f = await rebootedCto();
    const { daemon, started, blocking } = await startDaemon(f);
    try {
      expect({ allowed: started.allowed, reasonCode: started.reasonCode, blocking }).toEqual({
        allowed: true, reasonCode: ReasonCode.OK, blocking: [],
      });
      // The premise: the sweep settled it, its binding and its run survived, and it is still reported.
      expect(f.harness.cp.sessions.require(f.sessionId).lifecycle).toBe(SessionLifecycle.ERROR);
      expect(f.harness.cp.bindings.active(f.roleKey)?.bindingGeneration).toBe(1);
      expect(f.owner()).toEqual({ owner_session_id: f.sessionId, owner_binding_generation: 1, state: RunState.ACTIVE });
      // The audit row keeps code, severity and blocking; the live report names the session.
      expect(startupFinding(f)).toEqual([{ code: "SESSION_PROCESS_MISSING", severity: "ERROR", blocking: false }]);
      expect(await f.finding("system", f.sessionId)).toEqual({ severity: "ERROR", blocking: false });

      const claimed = await f.claimAs(2);
      expect(claimed.allowed, JSON.stringify(claimed)).toBe(true);
      if (!claimed.allowed) return;
      expect(claimed.value.binding.bindingGeneration).toBe(2);
      expect(f.owner()).toEqual({
        owner_session_id: claimed.value.sessionId, owner_binding_generation: 2, state: RunState.ACTIVE,
      });
      expect(f.db.all<{ run_id: string }>(
        `SELECT run_id FROM audit_events WHERE kind = 'CANONICAL_LIVE_RUNS_TAKEN_OVER'`,
      )).toEqual([{ run_id: f.runId }]);
      // Released and owning nothing, the dead session is no longer an ERROR.
      expect((await f.finding("system", f.sessionId))?.severity).not.toBe("ERROR");
    } finally {
      await daemon.stop();
    }
  });

  it("starts the daemon, and the CEO's run_cancel reaches the run without its owner", async () => {
    const f = await rebootedCto();
    const { daemon, started } = await startDaemon(f);
    try {
      expect(started.allowed, JSON.stringify(started.allowed ? null : started)).toBe(true);
      // The hermes `run_cancel` tool is `source.runs.cancel(runId, reason)`.
      const cancelled = f.harness.cp.runs.cancel(f.runId, "CEO: the owner died in a reboot");
      expect(cancelled.allowed, JSON.stringify(cancelled)).toBe(true);
      expect(f.owner()?.state).toBe(RunState.CANCELLED);
    } finally {
      await daemon.stop();
    }
  });

  it("names the settled owner in the system report without blocking it", async () => {
    const f = await rebootedCto();
    f.settle(f.sessionId);
    expect(await f.finding("system", f.sessionId)).toEqual({ severity: "ERROR", blocking: false });
  });

  describe("still blocks", () => {
    it("a session that is not settled yet", async () => {
      const f = await rebootedCto();
      expect(f.harness.cp.sessions.require(f.sessionId).lifecycle).toBe(SessionLifecycle.READY);
      expect(await f.finding("system", f.sessionId)).toEqual({ severity: "ERROR", blocking: true });
    });

    it("any report but the system one", async () => {
      const f = await rebootedCto();
      f.settle(f.sessionId);
      for (const target of [f.sessionId, undefined]) {
        expect(await f.finding("session", f.sessionId, target)).toEqual({ severity: "ERROR", blocking: true });
      }
    });

    it("a dead owner with a RUNNING execution in its name", async () => {
      const f = await rebootedCto();
      const tasks = f.harness.cp.tasks.submit(f.runId, [{ key: "impl", title: "change app()", category: "implementation" }]);
      if (!tasks.allowed) throw new Error(tasks.message);
      const task = f.harness.cp.tasks.ready(f.runId)[0]!;
      const execution = f.harness.cp.tasks.startExecution({
        runId: f.runId, taskId: task.taskId, ownerBindingGeneration: 1, workerSessionId: bindWorker(f.harness, task.taskId),
        provider: "scripted", model: "scripted-worker",
      });
      if (!execution.allowed) throw new Error(execution.message);
      // An open execution recorded against the dead session itself. The schema keeps a run owner's
      // session from ever being a worker (CP-HI-04), so only a raw writer reaches this state; the
      // fixture lifts the worker-identity trigger in its own database to build it.
      const raw = new Database(f.db.raw.name);
      try {
        raw.exec(`DROP TRIGGER task_executions_worker_identity_immutable`);
        raw.prepare(`UPDATE task_executions SET worker_session_id = ? WHERE execution_id = ?`)
          .run(f.sessionId, execution.value.executionId);
      } finally { raw.close(); }
      f.settle(f.sessionId);
      expect(await f.finding("system", f.sessionId)).toEqual({ severity: "ERROR", blocking: true });
    });

    it("a dead CEO that owns a live run", async () => {
      const f = await rebootedCto();
      f.harness.cp.sessions.setPid(f.ceoSessionId, deadPid());
      f.settle(f.ceoSessionId);
      // Without the run, a settled CEO is the operator door's other role and does not block.
      expect(await f.finding("system", f.ceoSessionId)).toEqual({ severity: "ERROR", blocking: false });
      // The run re-pinned onto the CEO's own binding tuple, which its owner foreign key admits.
      f.db.run(
        `UPDATE runs SET (owner_role_key, owner_binding_generation, owner_session_id, owner_session_incarnation) =
           (SELECT role_key, binding_generation, session_id, session_incarnation FROM assignments
             WHERE role_key = 'CEO' AND status = 'ACTIVE')
          WHERE run_id = ?`,
        [f.runId],
      );
      expect(f.harness.cp.runs.activeRunsOwnedBy(f.ceoSessionId).map((run) => run.runId)).toEqual([f.runId]);
      expect(await f.finding("system", f.ceoSessionId)).toEqual({ severity: "ERROR", blocking: true });
    });
  });
});
