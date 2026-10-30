import { chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { NotificationKind } from "../../src/ceo/production-gate.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { startConfiguredCeoNotificationRoute, startStallNoticeRoute } from "../../src/daemon/agentcpd.ts";
import { Daemon } from "../../src/daemon/daemon.ts";
import { classifyStartFinding, describeStartStall } from "../../src/daemon/start-stall.ts";
import { TERMINAL_RUN_STATES } from "../../src/domain/run-state.ts";
import { ExecutionMode, Role, roleKeyFor } from "../../src/domain/types.ts";
import { MessageKind } from "../../src/outbox/envelope.ts";
import type { DaemonNoticeBody, DaemonNoticeSendOutcome } from "../../src/runtime/acp-daemon-notice.ts";
import type { TaskContract } from "../../src/run/run-engine.ts";
import { DIGEST, LIVE, GATEWAY, LSTART, TOKEN, adoptedFixture } from "../helpers/adopted-ceo.ts";
import { cleanupTempDirs, gitSync, makeRepo, tempDir } from "../helpers/fixtures.ts";
import {
  admitInbound, bindCeo, bindWorker, fixtureManifest, makeHarness, registerFixtureProject, type Harness,
} from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * #1189 D1 — a start whose doctor blocks on a finding it cannot park on refuses, releases its lock and
 * leaves the supervisor to retry under the crash-loop backoff. Before this, nothing said whether a retry
 * could ever succeed and nobody was told: the operator and CEO doors open only after a start succeeds.
 * Now each blocking finding is classified PERMANENT or TRANSIENT, the stall and the runs it holds back
 * (with whether any execution of theirs ran) are in `health.json` and the startup-failure record, and
 * a PERMANENT stall — or a TRANSIENT one the backoff has not cleared by the crash-loop threshold —
 * reaches the CEO once as CRITICAL_SYSTEM_FAILURE, sent while the start still holds its lock. The
 * refusal itself never completes, fails or dispatches a run.
 *
 * #1189 A4 — a start that parks on a contradicted conversation keeps the quarantine and says so the
 * same way.
 */

const CONTRACT: TaskContract = {
  goal: "stalled start",
  why: "stalled start",
  scope: [],
  nonGoals: [],
  acceptance: ["verify.js exits 0"],
  priority: "NORMAL",
  humanGate: [],
  references: [],
};

const health = (stateDir: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(stateDir, "health.json"), "utf8")) as Record<string, unknown>;

const stallNotices = (h: Harness) =>
  h.cp.db.all<{ message_id: string; status: string; run_id: string | null; payload_json: string }>(
    `SELECT message_id, status, run_id, payload_json FROM outbox
      WHERE kind = 'CEO_NOTIFICATION' AND json_extract(payload_json, '$.notification') = ?
      ORDER BY created_at, rowid`,
    [NotificationKind.CRITICAL_SYSTEM_FAILURE],
  ).map((row) => ({ ...row, payload: JSON.parse(row.payload_json) as Record<string, unknown> }));

const runStates = (h: Harness) =>
  h.cp.db.all<{ run_id: string; state: string; state_reason: string | null; ended_at: string | null }>(
    `SELECT run_id, state, state_reason, ended_at, owner_session_id, continuity_hold_role_key FROM runs ORDER BY run_id`,
  );

/** Every run state change is a RUN_TRANSITION row (the database refuses `UPDATE runs SET state` otherwise). */
const runTransitions = (h: Harness) => h.cp.audit.byKind("RUN_TRANSITION").map((event) => ({
  runId: event.runId, from: event.evidence["from"], to: event.evidence["to"],
}));

/** One run that executed a task (its worker process is long gone) and one that never ran. */
const runsHeldBack = async (h: Harness) => {
  const { projectId, repositoryId } = await registerFixtureProject(h);
  const created = h.cp.runs.create({
    projectId, executionMode: ExecutionMode.STANDARD, contract: CONTRACT,
    repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
  });
  if (!created.allowed) throw new Error(created.message);
  const dispatched = await h.cp.runs.dispatch(created.value.runId);
  if (!dispatched.allowed) throw new Error(dispatched.message);
  const tasks = h.cp.tasks.submit(dispatched.value.runId, [{ key: "a", title: "work", category: "implementation" }]);
  if (!tasks.allowed) throw new Error(tasks.message);
  const workerSessionId = bindWorker(h, tasks.value[0]!.taskId);
  const execution = h.cp.tasks.startExecution({
    runId: dispatched.value.runId, taskId: tasks.value[0]!.taskId,
    ownerBindingGeneration: dispatched.value.ownerBindingGeneration!, workerSessionId,
    workerProcessId: 2_147_483_600, provider: "scripted", model: "scripted-worker", repositoryId,
  });
  if (!execution.allowed) throw new Error(execution.message);
  const queued = h.cp.runs.create({
    projectId, executionMode: ExecutionMode.STANDARD, contract: { ...CONTRACT, goal: "never ran" },
    repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
  });
  if (!queued.allowed) throw new Error(queued.message);
  return { ran: dispatched.value.runId, neverRan: queued.value.runId };
};

describe("#1189 D1: a stalled start's blocking findings are permanent or transient", () => {
  it("classifies credential, security, owner-gated, dead-session and run-decision findings as permanent, and probes, live processes and coverage as transient", () => {
    const classes = Object.fromEntries([
      "STATE_PATH_INSECURE", "TRUSTED_GATE_CREDENTIAL_MISSING", "TRUSTED_GATE_CREDENTIAL_PERMISSIONS",
      "CANONICAL_TURN_CONTRADICTED", "REPOSITORY_UNREADABLE", "ACTIVE_RUN_WITHOUT_OWNER",
      "WORKER_IDENTITY_MISSING", "WORKER_IDENTITY_UNVERIFIABLE", "DEAD_WORKER_WITH_OPEN_RECEIPT",
      "SESSION_PROCESS_MISSING", "REPOSITORY_PROBE_FAILED", "WORKTREE_PROBE_FAILED",
      "ROLE_COVERAGE_NO_VALID_COVERAGE", "CAPACITY_SWEEP_NOT_REACHED", "SOMETHING_NEW",
    ].map((code) => {
      const classified = classifyStartFinding({ code, severity: "ERROR", scope: "x" });
      return [code, `${classified.cause}/${classified.repairOwner}/${classified.basis}`];
    }));
    expect(classes).toEqual({
      STATE_PATH_INSECURE: "PERMANENT/OWNER/SECURITY",
      TRUSTED_GATE_CREDENTIAL_MISSING: "PERMANENT/OWNER/CREDENTIAL",
      TRUSTED_GATE_CREDENTIAL_PERMISSIONS: "PERMANENT/OWNER/SECURITY",
      CANONICAL_TURN_CONTRADICTED: "PERMANENT/OWNER/SECURITY",
      REPOSITORY_UNREADABLE: "PERMANENT/OWNER/OWNER_GATED",
      ACTIVE_RUN_WITHOUT_OWNER: "PERMANENT/CEO/RUN_DECISION",
      WORKER_IDENTITY_MISSING: "PERMANENT/OWNER/RECEIPT",
      WORKER_IDENTITY_UNVERIFIABLE: "PERMANENT/OWNER/RECEIPT",
      // The restart reconcile marks the session ERROR and the finding stays blocking
      // (doctor-daemon-r2 "keeps a dead ... actionable after settlement"): no restart clears it.
      SESSION_PROCESS_MISSING: "PERMANENT/OWNER/DEAD_SESSION",
      DEAD_WORKER_WITH_OPEN_RECEIPT: "TRANSIENT/DAEMON/PROCESS",
      REPOSITORY_PROBE_FAILED: "TRANSIENT/DAEMON/PROBE",
      WORKTREE_PROBE_FAILED: "TRANSIENT/DAEMON/PROBE",
      ROLE_COVERAGE_NO_VALID_COVERAGE: "TRANSIENT/DAEMON/COVERAGE",
      CAPACITY_SWEEP_NOT_REACHED: "TRANSIENT/DAEMON/COVERAGE",
      // A code nobody classified is told, not left to a backoff that may never end.
      SOMETHING_NEW: "PERMANENT/OWNER/UNCLASSIFIED",
    });
  });
});

describe("#1189 D1: a start refused on a permanent finding", () => {
  it("records the stall and the runs it holds, tells the CEO once across restarts while holding its lock, and moves no run", async () => {
    const h = makeHarness();
    try {
      // No trusted gate credential: TRUSTED_GATE_CREDENTIAL_MISSING blocks and cannot park.
      bindCeo(h);
      const runs = await runsHeldBack(h);
      const before = runStates(h);
      const transitionsBefore = runTransitions(h);
      const stateDir = tempDir("acp-1189-refused-");
      const sent: Array<{ messageIds: readonly string[]; lockHeld: boolean }> = [];
      const start = async () => {
        const daemon = new Daemon(h.cp, { stateDir });
        return daemon.start({
          stallNotice: { deliver: async (messageIds) => { sent.push({ messageIds, lockHeld: daemon.lock.held() }); } },
        });
      };

      const refused = await start();
      expect(refused).toMatchObject({ allowed: false, reasonCode: ReasonCode.DOCTOR_BLOCKED });

      const notices = stallNotices(h);
      expect(notices).toHaveLength(1);
      const [notice] = notices;
      expect(notice!.run_id).toBeNull();
      expect(notice!.payload).toMatchObject({
        notification: NotificationKind.CRITICAL_SYSTEM_FAILURE,
        source: "DAEMON_START_STALL",
        phase: "REFUSED",
        cause: "PERMANENT",
        crashLoop: false,
        findings: [{ code: "TRUSTED_GATE_CREDENTIAL_MISSING", scope: "github", cause: "PERMANENT", repairOwner: "OWNER", basis: "CREDENTIAL" }],
        blockedRunCount: 2,
      });
      // Whether execution ran, per held run: the dead worker's receipt was abandoned by the restart
      // reconcile, so it ran and has nothing still open; the queued run never ran.
      expect(notice!.payload["blockedRuns"]).toEqual(expect.arrayContaining([
        { runId: runs.ran, state: "ACTIVE", executionRan: true, openExecutions: [], finalizationAttempt: null },
        { runId: runs.neverRan, state: "QUEUED", executionRan: false, openExecutions: [], finalizationAttempt: null },
      ]));
      // The notice's own delivery record keeps its evidence: nothing in it is a payload the audit log refuses.
      expect(h.cp.audit.byKind("OWNERLESS_STALL_ROUTED").at(-1)!.evidence).toMatchObject({
        notification: NotificationKind.CRITICAL_SYSTEM_FAILURE, source: "DAEMON_START_STALL", cause: "PERMANENT",
        incidentClass: "RESOURCE_STALLED", correlation: "ceo-incident:RESOURCE_STALLED:daemon-start", episode: notice!.payload["stallId"],
      });
      // Sent before the lock was let go: the one moment this process may speak for the deployment.
      expect(sent).toEqual([{ messageIds: [notice!.message_id], lockHeld: true }]);

      const stall = health(stateDir)["startStall"] as Record<string, unknown>;
      expect(stall).toMatchObject({
        phase: "REFUSED", cause: "PERMANENT", blockedRunCount: 2,
        routing: { status: "ROUTED", messageId: notice!.message_id, delivery: { status: "PENDING", delivered: false, attempts: 0 } },
      });
      const failure = h.cp.audit.byKind("DAEMON_START_FAILED").at(-1)!;
      expect(failure.evidence).toMatchObject({
        stall: { cause: "PERMANENT", stallId: stall["stallId"], routing: { status: "ROUTED" } },
      });

      // The supervisor's retry, after the backoff: the same stall, so no second notice. The one still
      // PENDING is offered to the route again.
      const tasksAfterFirst = h.cp.db.all(`SELECT task_id, state FROM tasks ORDER BY task_id`);
      h.clock.advance(10 * 60_000);
      const again = await start();
      expect(again).toMatchObject({ allowed: false, reasonCode: ReasonCode.DOCTOR_BLOCKED });
      expect(stallNotices(h)).toHaveLength(1);
      expect(health(stateDir)["startStall"]).toMatchObject({
        stallId: stall["stallId"], routing: { status: "ALREADY_ROUTED", messageId: notice!.message_id },
      });
      expect(sent).toHaveLength(2);
      expect(sent[1]).toEqual({ messageIds: [notice!.message_id], lockHeld: true });

      // Neither refusal completed, failed, dispatched or otherwise moved a run, or a task after the first.
      expect(runStates(h)).toEqual(before);
      expect(runTransitions(h)).toEqual(transitionsBefore);
      expect(h.cp.db.all(`SELECT task_id, state FROM tasks ORDER BY task_id`)).toEqual(tasksAfterFirst);
    } finally {
      h.cp.close();
    }
  });

  it("with no CEO bound records the stall unrouted, and routes it once a CEO is there", async () => {
    const h = makeHarness();
    try {
      const stateDir = tempDir("acp-1189-no-ceo-");
      const daemon = () => new Daemon(h.cp, { stateDir });
      expect((await daemon().start()).allowed).toBe(false);
      expect(stallNotices(h)).toHaveLength(0);
      expect(health(stateDir)["startStall"]).toMatchObject({
        cause: "PERMANENT", routing: { status: "NOT_ROUTED", reasonCode: ReasonCode.GATE_AUTHORITY_DENIED },
      });

      bindCeo(h);
      h.clock.advance(10 * 60_000);
      expect((await daemon().start()).allowed).toBe(false);
      expect(stallNotices(h)).toHaveLength(1);
      expect(health(stateDir)["startStall"]).toMatchObject({ routing: { status: "ROUTED" } });
    } finally {
      h.cp.close();
    }
  });

  it("is a new stall after a start succeeded, even on the same finding", async () => {
    const h = makeHarness();
    try {
      bindCeo(h);
      h.cp.credentials.install({ token: "test-token", creatorIdentity: "acme-bot" });
      const stateDir = tempDir("acp-1189-epoch-");
      const capacityDir = join(h.root, "capacity");

      chmodSync(capacityDir, 0o755);
      expect(await new Daemon(h.cp, { stateDir }).start()).toMatchObject({ allowed: false, reasonCode: ReasonCode.DOCTOR_ERROR });
      expect(stallNotices(h).map((row) => (row.payload["findings"] as Array<{ code: string }>).map((f) => f.code)))
        .toEqual([["STATE_PATH_INSECURE"]]);

      chmodSync(capacityDir, 0o700);
      h.clock.advance(10 * 60_000);
      const healthy = new Daemon(h.cp, { stateDir });
      expect((await healthy.start()).allowed).toBe(true);
      expect(health(stateDir)["startStall"]).toBeNull();
      await healthy.stop();

      chmodSync(capacityDir, 0o755);
      expect((await new Daemon(h.cp, { stateDir }).start()).allowed).toBe(false);
      const notices = stallNotices(h);
      expect(notices).toHaveLength(2);
      expect(notices[1]!.payload["stallId"]).not.toEqual(notices[0]!.payload["stallId"]);
    } finally {
      h.cp.close();
    }
  });
});

describe("#1189 D1: a start refused only on transient findings", () => {
  /** `rev-parse` still answers and `git status` refuses: the repository probe throws on every start. */
  const transientlyStalled = async () => {
    const h = makeHarness();
    bindCeo(h);
    h.cp.credentials.install({ token: "test-token", creatorIdentity: "acme-bot" });
    await registerFixtureProject(h);
    gitSync(h.repoPath, ["config", "core.bare", "true"]);
    return h;
  };

  it("is recorded as transient and told to no one while the backoff may still clear it", async () => {
    const h = await transientlyStalled();
    try {
      const stateDir = tempDir("acp-1189-transient-");
      const sent: Array<readonly string[]> = [];
      const refused = await new Daemon(h.cp, { stateDir }).start({
        stallNotice: { deliver: async (messageIds) => { sent.push(messageIds); } },
      });
      expect(refused).toMatchObject({ allowed: false, reasonCode: ReasonCode.DOCTOR_BLOCKED });
      const stall = health(stateDir)["startStall"] as { cause: string; crashLoop: boolean; findings: Array<{ code: string; cause: string }>; routing: unknown };
      expect(stall.cause).toBe("TRANSIENT");
      expect(stall.crashLoop).toBe(false);
      expect(stall.findings.map((f) => f.code)).toContain("REPOSITORY_PROBE_FAILED");
      expect(stall.findings.every((f) => f.cause === "TRANSIENT")).toBe(true);
      expect(stall.routing).toEqual({ status: "NOT_ROUTED_TRANSIENT" });
      expect(stallNotices(h)).toHaveLength(0);
      expect(sent).toEqual([]);
    } finally {
      h.cp.close();
    }
  });

  it("is told to the CEO once when its refusal reaches the crash-loop threshold", async () => {
    const h = await transientlyStalled();
    try {
      const stateDir = tempDir("acp-1189-crash-loop-");
      const sent: Array<readonly string[]> = [];
      const refuse = async () => {
        h.clock.advance(10 * 60_000);
        const refused = await new Daemon(h.cp, { stateDir, crashLoopThreshold: 3 }).start({
          stallNotice: { deliver: async (messageIds) => { sent.push(messageIds); } },
        });
        expect(refused).toMatchObject({ allowed: false, reasonCode: ReasonCode.DOCTOR_BLOCKED });
        return health(stateDir)["startStall"] as Record<string, unknown>;
      };

      for (const failure of [1, 2]) {
        expect(await refuse(), `refusal ${failure}`).toMatchObject({
          cause: "TRANSIENT", crashLoop: false, routing: { status: "NOT_ROUTED_TRANSIENT" },
        });
      }
      expect(stallNotices(h)).toHaveLength(0);

      // The third refusal is the one the daemon already calls a crash loop (DAEMON_CRASH_LOOP).
      const third = await refuse();
      expect(third).toMatchObject({ cause: "TRANSIENT", crashLoop: true, routing: { status: "ROUTED" } });
      expect(h.cp.audit.byKind("DAEMON_CRASH_LOOP")).toHaveLength(1);
      const [notice] = stallNotices(h);
      expect(notice!.payload).toMatchObject({
        source: "DAEMON_START_STALL", phase: "REFUSED", cause: "TRANSIENT", crashLoop: true, stallId: third["stallId"],
      });
      expect(sent).toEqual([[notice!.message_id]]);

      expect(await refuse()).toMatchObject({ stallId: third["stallId"], routing: { status: "ALREADY_ROUTED" } });
      expect(stallNotices(h)).toHaveLength(1);
    } finally {
      h.cp.close();
    }
  });
});

describe("#1189 D1 invariant: daemon absence or refusal never completes or fails a run", () => {
  // Not a new behaviour: every terminal edge is a CEO decision (`submitCeoDecision`), the finalizer
  // under its completion authority, or a cancel, and none of them is on the start path. This holds on
  // the base as well; it is here so a change that breaks it fails.
  it("a start after a long absence, and its first watchdog pass, end no run", async () => {
    const h = makeHarness();
    const stateDir = tempDir("acp-1189-absence-");
    let daemon: Daemon | null = null;
    try {
      bindCeo(h);
      h.cp.credentials.install({ token: "test-token", creatorIdentity: "acme-bot" });
      await runsHeldBack(h);
      h.clock.advance(30 * 24 * 60 * 60_000);
      daemon = new Daemon(h.cp, { stateDir, watchdogIntervalMs: 25 });
      const started = await daemon.start();
      if (!started.allowed) throw new Error(`${started.reasonCode}: ${JSON.stringify(started.evidence)}`);
      // The watchdog saw the month-old run as stalled, and reported it.
      await vi.waitFor(() => expect(h.cp.audit.byKind("WATCHDOG_STALL").length).toBeGreaterThan(0), { timeout: 10_000 });
      expect(runStates(h).filter((run) => (TERMINAL_RUN_STATES as readonly string[]).includes(run.state))).toEqual([]);
      expect(runTransitions(h).filter((edge) => (TERMINAL_RUN_STATES as readonly unknown[]).includes(edge.to))).toEqual([]);
    } finally {
      await daemon?.stop();
    }
  });
});

describe("#1189 A4: a start parked on a contradicted conversation", () => {
  const NOW = "2026-08-22T00:00:00.000Z";
  /** The rows `the-quarantine-has-an-operator-door.test.ts` builds: an actor and its attested target. */
  const quarantinedActor = (h: Harness): { actorId: string; turnRequestId: string } => {
    const actorId = "actor:a4";
    const sessionId = "runtime:a4";
    h.cp.db.run(`INSERT INTO sessions (session_id, incarnation, provider, model, lifecycle, created_at, updated_at)
      VALUES (?, 'inc', 'claude', 'opus', 'READY', ?, ?)`, [sessionId, NOW, NOW]);
    h.cp.db.run(`INSERT INTO conversational_actors (actor_id, kind, current_session_id, current_session_incarnation, created_at)
      VALUES (?, 'CEO', ?, 'inc', ?)`, [actorId, sessionId, NOW]);
    h.cp.db.run(`INSERT INTO actor_target_bindings
      (target_binding_id, target_actor_id, executor_kind, target_locator, target_locator_digest, bound_at)
      VALUES ('bind:a4', ?, 'hermes', 'locator:a4', 'digest:a4', ?)`, [actorId, NOW]);
    h.cp.db.run(`INSERT INTO assignments (assignment_id, role_key, role, actor_id, session_id, session_incarnation,
      binding_generation, mode, status, created_at)
      VALUES ('asg:a4', 'CEO:a4', 'CEO', ?, ?, 'inc', 1, 'PREFERRED', 'ACTIVE', ?)`, [actorId, sessionId, NOW]);
    h.cp.db.run(`INSERT INTO actor_target_attestations (target_attestation_id, target_binding_id, protocol_version,
      attestation_digest, executor_session_id, executor_session_incarnation, binding_generation, assignment_id, attested_at)
      VALUES ('att:a4', 'bind:a4', 'v1', 'attd:a4', ?, 'inc', 1, 'asg:a4', ?)`, [sessionId, NOW]);
    admitInbound(h, { nonce: "m1", payload: {} });
    const claimed = h.cp.conversation.claim({
      targetActorId: actorId, prompt: "m1", sources: [{ channel: "telegram", nonce: "m1", attempt: 1, payload: {} }],
    });
    if (!claimed.allowed) throw new Error(`claim refused: ${claimed.reasonCode}`);
    h.cp.conversation.ports.target.completed(claimed.value, {
      receiptId: "target:m1", evidenceDigest: "sha256:receipt", reasonCode: ReasonCode.OK,
    });
    h.cp.conversation.ports.preDispatch.neverAdmitted(claimed.value, {
      receiptId: "pre:m1", evidenceDigest: "sha256:pre", reasonCode: ReasonCode.CEO_CONVERSATION_UNAVAILABLE,
    });
    return { actorId, turnRequestId: claimed.value.turnRequestId };
  };

  it("tells the CEO before it parks, keeps the quarantine, and adjudicates nothing", async () => {
    const h = makeHarness();
    const daemon = new Daemon(h.cp, { stateDir: tempDir("acp-1189-a4-"), bootstrapRecheckIntervalMs: 600_000 });
    try {
      bindCeo(h);
      h.cp.credentials.install({ token: "test-token", creatorIdentity: "acme-bot" });
      const { actorId, turnRequestId } = quarantinedActor(h);
      const opened: number[] = [];
      const sent: Array<{ messageIds: readonly string[]; lockHeld: boolean }> = [];
      const starting = daemon.start({
        bootstrapDoor: async () => { opened.push(1); return { close: async () => {} }; },
        stallNotice: { deliver: async (messageIds) => { sent.push({ messageIds, lockHeld: daemon.lock.held() }); } },
      });
      await vi.waitFor(() => expect(opened).toHaveLength(1));

      const [notice, ...others] = stallNotices(h);
      expect(others).toEqual([]);
      expect(notice!.payload).toMatchObject({
        source: "DAEMON_START_STALL", phase: "PARKED", cause: "PERMANENT", startRefused: true, acpActionPath: "NOT_RUNNING",
        findings: [{ code: "CANONICAL_TURN_CONTRADICTED", cause: "PERMANENT", repairOwner: "OWNER", basis: "SECURITY" }],
      });
      expect(sent).toEqual([{ messageIds: [notice!.message_id], lockHeld: true }]);

      // The quarantine is the ledger's and stays: the actor takes no new turn, and nothing adjudicated.
      admitInbound(h, { nonce: "m2", payload: {} });
      expect(h.cp.conversation.claim({
        targetActorId: actorId, prompt: "m2", sources: [{ channel: "telegram", nonce: "m2", attempt: 1, payload: {} }],
      })).toMatchObject({ allowed: false, reasonCode: ReasonCode.CONVERSATION_ACTOR_QUARANTINED });
      expect(h.cp.conversation.contradictions().map((c) => c.turnRequestId)).toEqual([turnRequestId]);

      await daemon.stop();
      expect((await starting).allowed).toBe(false);
    } finally {
      await daemon.stop();
      h.cp.close();
    }
  });
});

describe("#1189 D1: the stall notice's route while no daemon serves", () => {
  const HERMES = {
    ACP_HERMES_LINEAGE_ROOT_DIGEST: DIGEST, ACP_HERMES_EXECUTABLE: "/opt/test/hermes",
    ACP_HERMES_PROFILE: "test", ACP_HERMES_HOME: "/opt/test/home",
    ACP_HERMES_EXECUTOR_RUNTIME_IDENTITY: "hermes-runtime:test", ACP_HERMES_GATEWAY_API_KEY: "test-key",
  };
  const LANE = { ACP_TELEGRAM_EXTERNAL_SECRET: "lane-secret" };
  const PERMANENT = [{ code: "TRUSTED_GATE_CREDENTIAL_MISSING", severity: "ERROR" as const, scope: "github" }];
  const pinned = (lockHeld: () => boolean) => ({
    authorityHeld: lockHeld, processStartToken: () => TOKEN, processStartedAt: () => LSTART,
    identityReader: () => async () => ({ session_id: LIVE, lineage_root_digest: DIGEST, process_pid: GATEWAY, process_started_at: TOKEN }),
  });
  /** The CEO's Gateway settles every notice it is sent. */
  const accepting = (sent: string[]) => () => async (body: DaemonNoticeBody): Promise<DaemonNoticeSendOutcome> => {
    sent.push(body.event_id);
    return { kind: "RESPONDED", status: 200, body: { event_id: body.event_id, payload_digest: body.payload_digest,
      receipt: { status: "completed", receipt_id: "receipt", session_id: LIVE, lineage_root_digest: DIGEST } } };
  };
  const routedId = (stall: ReturnType<typeof describeStartStall>): string => {
    if (stall.routing.status !== "ROUTED") throw new Error(`not routed: ${JSON.stringify(stall.routing)}`);
    return stall.routing.messageId;
  };
  const enqueueForCeo = (cp: Harness["cp"], idempotencyKey: string): string => {
    const ceo = cp.bindings.active(roleKeyFor(Role.CEO))!;
    const queued = cp.outbox.enqueue({ idempotencyKey, roleKey: "CEO", bindingGeneration: ceo.bindingGeneration,
      targetSessionId: ceo.sessionId, kind: MessageKind.CEO_NOTIFICATION, payload: { question: idempotencyKey } });
    if (!queued.allowed) throw new Error(queued.message);
    return queued.value.messageId;
  };
  const legacyMarked = (cp: Harness["cp"]): string[] => cp.audit.byKind("CEO_NOTIFICATION_LEGACY_OUTCOME_UNKNOWN")
    .map((event) => String(event.evidence["messageId"]));

  it("sends only the stalled start's notice over the canonical CEO route, and only while the lock is held", async () => {
    const sent: string[] = [];
    // A deployment whose canonical route has run before: the attempt journal predates these rows.
    const f = adoptedFixture({
      history: (h) => {
        expect(startConfiguredCeoNotificationRoute(h.cp, { environment: LANE, hermesConfiguration: HERMES,
          ports: { ...pinned(() => false), noticeSenderFactory: accepting(sent) } })).toEqual({ started: true });
      },
    });
    try {
      const cp = f.h.cp;
      const other = enqueueForCeo(cp, "an-ordinary-notification");
      let lockHeld = false;
      const route = startStallNoticeRoute(cp, { environment: LANE, hermesConfiguration: HERMES,
        ports: { ...pinned(() => lockHeld), noticeSenderFactory: accepting(sent) } });
      expect(route.open!()).toEqual({ started: true });
      const messageId = routedId(describeStartStall(cp, PERMANENT, "REFUSED", false));
      const touched = (id: string) => cp.db.all<{ kind: string }>(
        `SELECT kind FROM audit_events WHERE json_extract(evidence_json, '$.messageId') = ? ORDER BY event_id`, [id],
      ).map((row) => row.kind);
      const otherBefore = touched(other);

      // The lock already let go: the pin refuses, nothing is sent, and the notice waits for the next start.
      expect(await route.deliver([messageId])).toEqual({ started: true });
      expect(sent).toEqual([]);
      expect(cp.outbox.get(messageId)?.status).toBe("PENDING");

      lockHeld = true;
      expect(await route.deliver([messageId])).toEqual({ started: true });
      expect(sent).toHaveLength(1);
      expect(cp.outbox.get(messageId)?.status).toBe("ACKED");
      // Everything else queued for the CEO waits for the started daemon's own route, untouched: no
      // attempt and no "route unavailable" record is written against it.
      expect(cp.outbox.get(other)?.status).toBe("PENDING");
      expect(touched(other)).toEqual(otherBefore);

      // Without the lane secret the route does not open, and a route that never opened sends nothing.
      const unopened = startStallNoticeRoute(cp, { environment: {}, hermesConfiguration: HERMES, ports: pinned(() => true) });
      expect(unopened.open!()).toEqual({ started: false, reason: "ACP_TELEGRAM_EXTERNAL_SECRET is not configured" });
      expect(await unopened.deliver([messageId])).toMatchObject({ started: false });
    } finally {
      f.h.cp.close();
    }
  });

  it("I2-1: on a deployment whose canonical route never ran, the stall notice is sent once, and a notice queued before the attempt journal stays held", async () => {
    const sent: string[] = [];
    const f = adoptedFixture();
    try {
      const cp = f.h.cp;
      // Queued before any attempt journal existed: a pre-journal daemon may have sent it, nobody can say.
      const legacy = enqueueForCeo(cp, "a-pre-journal-notification");
      const route = startStallNoticeRoute(cp, { environment: LANE, hermesConfiguration: HERMES,
        ports: { ...pinned(() => true), noticeSenderFactory: accepting(sent) } });
      expect(route.open!()).toEqual({ started: true });
      const messageId = routedId(describeStartStall(cp, PERMANENT, "REFUSED", false));

      expect(await route.deliver([messageId])).toEqual({ started: true });
      expect(sent).toHaveLength(1);
      expect(cp.outbox.get(messageId)?.status).toBe("ACKED");
      // Only the row that predates the journal is held as an unknown outcome; the stall notice never was.
      expect(legacyMarked(cp)).toEqual([legacy]);

      // The started daemon's full route keeps holding it: it is never sent again by this code.
      expect(startConfiguredCeoNotificationRoute(cp, { environment: LANE, hermesConfiguration: HERMES,
        ports: { ...pinned(() => true), noticeSenderFactory: accepting(sent) } })).toEqual({ started: true });
      await cp.outbox.deliverCeoNotifications();
      expect(sent).toHaveLength(1);
      expect(cp.outbox.get(legacy)?.status).toBe("PENDING");
    } finally {
      f.h.cp.close();
    }
  });

  it("a send the CEO's Gateway did not settle is an attempt, not a delivery", async () => {
    const f = adoptedFixture();
    try {
      const cp = f.h.cp;
      const route = startStallNoticeRoute(cp, { environment: LANE, hermesConfiguration: HERMES, ports: {
        ...pinned(() => true),
        noticeSenderFactory: () => async (): Promise<DaemonNoticeSendOutcome> => ({ kind: "RESPONDED", status: 503, body: {} }),
      } });
      expect(route.open!()).toEqual({ started: true });
      const messageId = routedId(describeStartStall(cp, PERMANENT, "REFUSED", false));
      await route.deliver([messageId]);
      expect(cp.outbox.get(messageId)).toMatchObject({ status: "PENDING", attempts: 1 });
      // What the next refused start reports: tried once, not delivered, not completed.
      expect(describeStartStall(cp, PERMANENT, "REFUSED", false).routing).toMatchObject({
        status: "ALREADY_ROUTED", messageId, delivery: { status: "PENDING", delivered: false, completed: false, attempts: 1 },
      });
    } finally {
      f.h.cp.close();
    }
  });

  it("I2-1: a refused start opens its notice route before it writes the notice, and sends after", async () => {
    const h = makeHarness();
    try {
      bindCeo(h);
      const order: string[] = [];
      const refused = await new Daemon(h.cp, { stateDir: tempDir("acp-1189-route-order-") }).start({
        stallNotice: {
          open: () => { order.push(`open with ${stallNotices(h).length} notice(s)`); return { started: true }; },
          deliver: async () => { order.push(`deliver with ${stallNotices(h).length} notice(s)`); },
        },
      });
      expect(refused).toMatchObject({ allowed: false, reasonCode: ReasonCode.DOCTOR_BLOCKED });
      expect(order).toEqual(["open with 0 notice(s)", "deliver with 1 notice(s)"]);
    } finally {
      h.cp.close();
    }
  });

  /**
   * A start of this daemon over the composition's stall route, in the given environment. The CEO's Gateway
   * process is live for the doctor (its pid is the fixture's), so what blocks is the missing credential alone.
   */
  const startOver = async (f: ReturnType<typeof adoptedFixture>, stateDir: string, environment: Record<string, string>, sent: string[]) => {
    const realKill = process.kill.bind(process);
    const kill = vi.spyOn(process, "kill").mockImplementation((pid, sig) => (pid === GATEWAY && sig === 0 ? true : realKill(pid, sig)));
    try {
      const daemon = new Daemon(f.h.cp, { stateDir });
      const result = await daemon.start({ stallNotice: startStallNoticeRoute(f.h.cp, { environment, hermesConfiguration: HERMES,
        ports: { ...pinned(() => daemon.lock.held()), noticeSenderFactory: accepting(sent) } }) });
      return { daemon, result };
    } finally {
      kill.mockRestore();
    }
  };

  it("I3-1: a start refused while the lane secret is missing establishes the attempt journal before its notice, and the next start, with the secret restored, sends that notice exactly once", async () => {
    const sent: string[] = [];
    const f = adoptedFixture();
    try {
      const cp = f.h.cp;
      // Queued before any journal-aware code ran: a pre-journal daemon may have sent it, nobody can say.
      const legacy = enqueueForCeo(cp, "a-pre-journal-notification");
      const stateDir = tempDir("acp-1189-secret-restored-");

      const first = await startOver(f, stateDir, {}, sent);
      expect(first.result).toMatchObject({ allowed: false, reasonCode: ReasonCode.DOCTOR_BLOCKED });
      const [notice, ...others] = stallNotices(f.h);
      expect(others).toEqual([]);
      expect(health(stateDir)["startStall"]).toMatchObject({ routing: { status: "ROUTED", messageId: notice!.message_id,
        undelivered: "route not opened: ACP_TELEGRAM_EXTERNAL_SECRET is not configured" } });
      expect(sent).toEqual([]);

      f.h.clock.advance(10 * 60_000);
      const second = await startOver(f, stateDir, LANE, sent);
      expect(second.result).toMatchObject({ allowed: false, reasonCode: ReasonCode.DOCTOR_BLOCKED });
      expect(sent).toHaveLength(1);
      expect(cp.outbox.get(notice!.message_id)?.status).toBe("ACKED");
      expect(health(stateDir)["startStall"]).toMatchObject({ routing: { status: "ALREADY_ROUTED", messageId: notice!.message_id,
        delivery: { delivered: true } } });
      // The genuinely uncertain row stays held; the stall notice, written after the boundary, never was.
      expect(legacyMarked(cp)).toEqual([legacy]);
      expect(cp.outbox.get(legacy)?.status).toBe("PENDING");
    } finally {
      f.h.cp.close();
    }
  });

  it("I3-1: the route's open establishes the boundary before it asks for the lane secret", async () => {
    const sent: string[] = [];
    const f = adoptedFixture();
    try {
      const cp = f.h.cp;
      const unconfigured = startStallNoticeRoute(cp, { environment: {}, hermesConfiguration: HERMES,
        ports: { ...pinned(() => true), noticeSenderFactory: accepting(sent) } });
      expect(unconfigured.open!()).toEqual({ started: false, reason: "ACP_TELEGRAM_EXTERNAL_SECRET is not configured" });
      const messageId = routedId(describeStartStall(cp, PERMANENT, "REFUSED", false));

      const restored = startStallNoticeRoute(cp, { environment: LANE, hermesConfiguration: HERMES,
        ports: { ...pinned(() => true), noticeSenderFactory: accepting(sent) } });
      expect(restored.open!()).toEqual({ started: true });
      expect(await restored.deliver([messageId])).toEqual({ started: true });
      expect(sent).toHaveLength(1);
      expect(cp.outbox.get(messageId)?.status).toBe("ACKED");
      expect(legacyMarked(cp)).toEqual([]);
    } finally {
      f.h.cp.close();
    }
  });

  it("I3-1: a daemon that started without the lane secret: what it queued is sent once, after a restart restores the secret", async () => {
    const sent: string[] = [];
    const f = adoptedFixture();
    try {
      const cp = f.h.cp;
      cp.credentials.install({ token: "test-token", creatorIdentity: "acme-bot" });
      const stateDir = tempDir("acp-1189-started-without-secret-");
      const first = await startOver(f, stateDir, {}, sent);
      expect(first.result.allowed).toBe(true);
      expect(startConfiguredCeoNotificationRoute(cp, { environment: {}, hermesConfiguration: HERMES,
        ports: { ...pinned(() => first.daemon.lock.held()), noticeSenderFactory: accepting(sent) } }))
        .toEqual({ started: false, reason: "ACP_TELEGRAM_EXTERNAL_SECRET is not configured" });
      const queued = enqueueForCeo(cp, "queued-while-the-secret-was-missing");
      await first.daemon.stop();

      const second = await startOver(f, stateDir, LANE, sent);
      expect(second.result.allowed).toBe(true);
      try {
        expect(startConfiguredCeoNotificationRoute(cp, { environment: LANE, hermesConfiguration: HERMES,
          ports: { ...pinned(() => second.daemon.lock.held()), noticeSenderFactory: accepting(sent) } })).toEqual({ started: true });
        await cp.outbox.deliverCeoNotifications();
        expect(sent).toHaveLength(1);
        expect(cp.outbox.get(queued)?.status).toBe("ACKED");
        expect(legacyMarked(cp)).toEqual([]);
      } finally {
        await second.daemon.stop();
      }
    } finally {
      f.h.cp.close();
    }
  });

  it("I3-2: a successful start resolves the refused start's incident: a canonical route attached after it does not deliver the stale claim", async () => {
    const sent: string[] = [];
    // A deployment whose canonical route has run before: the attempt journal predates the stall notice.
    const f = adoptedFixture({
      history: (h) => {
        expect(startConfiguredCeoNotificationRoute(h.cp, { environment: LANE, hermesConfiguration: HERMES,
          ports: { ...pinned(() => false), noticeSenderFactory: accepting(sent) } })).toEqual({ started: true });
      },
    });
    try {
      const cp = f.h.cp;
      const stateDir = tempDir("acp-1189-late-attach-");
      expect((await startOver(f, stateDir, {}, sent)).result).toMatchObject({ allowed: false, reasonCode: ReasonCode.DOCTOR_BLOCKED });
      const [notice] = stallNotices(f.h);
      expect(notice!.status).toBe("PENDING");

      // The owner repairs the credential and the next start succeeds: ACP's action path is running again.
      cp.credentials.install({ token: "test-token", creatorIdentity: "acme-bot" });
      f.h.clock.advance(10 * 60_000);
      const healthy = await startOver(f, stateDir, LANE, sent);
      expect(healthy.result.allowed).toBe(true);
      try {
        // The composition attaches the full route only after the start returned.
        expect(startConfiguredCeoNotificationRoute(cp, { environment: LANE, hermesConfiguration: HERMES,
          ports: { ...pinned(() => healthy.daemon.lock.held()), noticeSenderFactory: accepting(sent) } })).toEqual({ started: true });
        await cp.outbox.deliverCeoNotifications();
        expect(sent).toEqual([]);
        expect(cp.outbox.get(notice!.message_id)?.status).toBe("REJECTED");
        expect(cp.audit.byKind("CEO_NOTIFICATION_WITHDRAWN").map((event) => event.evidence)).toMatchObject([
          { messageId: notice!.message_id, resolvedBy: "DAEMON_STARTED" },
        ]);
      } finally {
        await healthy.daemon.stop();
      }
    } finally {
      f.h.cp.close();
    }
  });
});

describe("#1189 D1, CEO ruling 4: the refused start's notice", () => {
  it("says the start is refused and that ACP's action path is not running", async () => {
    const h = makeHarness();
    try {
      bindCeo(h);
      expect(await new Daemon(h.cp, { stateDir: tempDir("acp-1189-says-") }).start())
        .toMatchObject({ allowed: false, reasonCode: ReasonCode.DOCTOR_BLOCKED });
      const [notice] = stallNotices(h);
      expect(notice!.payload).toMatchObject({ phase: "REFUSED", startRefused: true, acpActionPath: "NOT_RUNNING" });
      expect(notice!.payload["blocker"]).toEqual(expect.stringContaining("the daemon start is refused and ACP's action path is not running"));
    } finally {
      h.cp.close();
    }
  });

  it("a send that throws, or a route that cannot open, never lets the start proceed or retry: one send per start, the notice stays undelivered and says why", async () => {
    const h = makeHarness();
    try {
      bindCeo(h);
      const stateDir = tempDir("acp-1189-send-fails-");
      let sends = 0;
      const start = (stallNotice: NonNullable<Parameters<Daemon["start"]>[0]>["stallNotice"]) => {
        const daemon = new Daemon(h.cp, { stateDir });
        return daemon.start({ stallNotice }).then((result) => ({ result, lockHeld: daemon.lock.held() }));
      };

      const first = await start({ deliver: async () => { sends += 1; throw new Error("gateway unreachable"); } });
      expect(first).toEqual({ result: expect.objectContaining({ allowed: false, reasonCode: ReasonCode.DOCTOR_BLOCKED }), lockHeld: false });
      expect(sends).toBe(1);
      const [notice] = stallNotices(h);
      expect(notice!.status).toBe("PENDING");
      expect(health(stateDir)["startStall"]).toMatchObject({ routing: {
        status: "ROUTED", messageId: notice!.message_id, delivery: { delivered: false, completed: false },
        undelivered: "send failed: gateway unreachable",
      } });

      h.clock.advance(10 * 60_000);
      const second = await start({ open: () => { throw new Error("pin unreadable"); }, deliver: async () => { sends += 1; } });
      expect(second).toEqual({ result: expect.objectContaining({ allowed: false, reasonCode: ReasonCode.DOCTOR_BLOCKED }), lockHeld: false });
      expect(sends).toBe(1);
      expect(health(stateDir)["startStall"]).toMatchObject({ routing: {
        status: "ALREADY_ROUTED", messageId: notice!.message_id, delivery: { delivered: false }, undelivered: "route not opened: pin unreadable",
      } });
      expect(stallNotices(h)).toHaveLength(1);
      expect(h.cp.audit.byKind("DAEMON_STARTED")).toHaveLength(0);
    } finally {
      h.cp.close();
    }
  });
});

describe("#1189 D1, I2-2: the start stall is one CEO incident, re-delivered to a CEO that replaced the one it was sent to", () => {
  it("delivered and ACKed, the CEO replaced: the unresolved stall reaches the new CEO once, and later refusals add nothing", async () => {
    const h = makeHarness();
    try {
      bindCeo(h);
      const stateDir = tempDir("acp-1189-redeliver-");
      const refuse = async () => {
        h.clock.advance(10 * 60_000);
        expect(await new Daemon(h.cp, { stateDir }).start()).toMatchObject({ allowed: false, reasonCode: ReasonCode.DOCTOR_BLOCKED });
        return health(stateDir)["startStall"] as Record<string, unknown>;
      };
      const targets = () => h.cp.db.all<{ message_id: string; target_session_id: string }>(
        `SELECT message_id, target_session_id FROM outbox WHERE kind = 'CEO_NOTIFICATION' ORDER BY created_at, rowid`,
      );

      await refuse();
      const [first] = stallNotices(h);
      const ceo = h.cp.bindings.active(roleKeyFor(Role.CEO))!;
      expect(h.cp.outbox.acknowledge(first!.message_id, ceo.sessionId, ceo.bindingGeneration).allowed).toBe(true);
      await refuse();
      // The CEO that ACKed it is not told again.
      expect(stallNotices(h)).toHaveLength(1);

      expect(h.cp.bindings.revoke(roleKeyFor(Role.CEO), "CEO runtime lost").allowed).toBe(true);
      const replacement = bindCeo(h);
      const third = await refuse();
      const notices = stallNotices(h);
      expect(notices).toHaveLength(2);
      const second = notices.find((notice) => notice.message_id !== first!.message_id)!;
      expect(second.payload).toMatchObject({
        redelivery: true, source: "DAEMON_START_STALL", stallId: first!.payload["stallId"],
        correlation: first!.payload["correlation"], episode: first!.payload["episode"],
      });
      expect(targets().find((row) => row.message_id === second.message_id)?.target_session_id).toBe(replacement);
      expect(third).toMatchObject({ routing: { status: "ROUTED", messageId: second.message_id, redelivery: true } });

      await refuse();
      expect(stallNotices(h)).toHaveLength(2);
    } finally {
      h.cp.close();
    }
  });

  it("I3-2: refused, repaired, started, then the CEO replaced: the recovered stall's notice is withdrawn and nothing is claimable for the new CEO", async () => {
    const h = makeHarness();
    try {
      bindCeo(h);
      const stateDir = tempDir("acp-1189-recovered-");
      expect(await new Daemon(h.cp, { stateDir }).start()).toMatchObject({ allowed: false, reasonCode: ReasonCode.DOCTOR_BLOCKED });
      const [notice] = stallNotices(h);
      expect(notice!.status).toBe("PENDING");

      h.cp.credentials.install({ token: "test-token", creatorIdentity: "acme-bot" });
      h.clock.advance(10 * 60_000);
      const healthy = new Daemon(h.cp, { stateDir });
      expect((await healthy.start()).allowed).toBe(true);
      await healthy.stop();

      expect(h.cp.bindings.revoke(roleKeyFor(Role.CEO), "CEO runtime lost").allowed).toBe(true);
      // The replacement is reachable over the generic Buzz sweep: whatever it is owed is claimable.
      h.cp.db.run(`UPDATE sessions SET buzz_address = 'ceo-room', buzz_actor_id = 'actor:ceo' WHERE session_id = ?`, [bindCeo(h)]);
      expect(h.cp.outbox.claimDeliverable().filter((message) => message.kind === MessageKind.CEO_NOTIFICATION)).toEqual([]);
      expect(stallNotices(h).map((row) => ({ messageId: row.message_id, status: row.status })))
        .toEqual([{ messageId: notice!.message_id, status: "REJECTED" }]);
      expect(h.cp.audit.byKind("CEO_NOTIFICATION_WITHDRAWN").map((event) => event.evidence)).toMatchObject([
        { messageId: notice!.message_id, resolvedBy: "DAEMON_STARTED" },
      ]);
    } finally {
      h.cp.close();
    }
  });
});

describe("#1189 D1, CEO ruling 3: one crash-loop notice per failure episode", () => {
  it("a later refusal of the same crash loop on other transient findings adds none, and a crash loop after a successful start is told again", async () => {
    const h = makeHarness();
    try {
      bindCeo(h);
      h.cp.credentials.install({ token: "test-token", creatorIdentity: "acme-bot" });
      await registerFixtureProject(h);
      // A second project on its own checkout, healthy for now.
      const secondRepo = makeRepo();
      const manifest = fixtureManifest("second-project");
      const project = h.cp.projects.register({ projectId: "second-project", name: "second", manifest,
        authorization: h.cp.manifestAuthorizationForTests(manifest) });
      if (!project.allowed) throw new Error(project.message);
      const repository = await h.cp.repositories.register({ checkoutPath: secondRepo, projectId: "second-project",
        repositoryRole: "primary", activeManifestDigest: project.value.activeManifestDigest, identity: "github:acme/second" });
      if (!repository.allowed) throw new Error(repository.message);
      const setBare = (repo: string, bare: boolean) => gitSync(repo, ["config", "core.bare", String(bare)]);

      const stateDir = tempDir("acp-1189-crash-episode-");
      const refuse = async () => {
        h.clock.advance(10 * 60_000);
        expect(await new Daemon(h.cp, { stateDir, crashLoopThreshold: 3 }).start())
          .toMatchObject({ allowed: false, reasonCode: ReasonCode.DOCTOR_BLOCKED });
        return health(stateDir)["startStall"] as { cause: string; crashLoop: boolean; stallId: string; findings: Array<{ scope: string }>; routing: { status: string } };
      };

      setBare(h.repoPath, true);
      await refuse();
      await refuse();
      const third = await refuse();
      expect(third).toMatchObject({ cause: "TRANSIENT", crashLoop: true, routing: { status: "ROUTED" } });
      expect(stallNotices(h)).toHaveLength(1);

      // Same failure episode, different transient findings: the crash loop was told, and is not told again.
      setBare(secondRepo, true);
      const fourth = await refuse();
      expect(fourth.findings.length).toBeGreaterThan(third.findings.length);
      expect(fourth).toMatchObject({ crashLoop: true, stallId: third.stallId, routing: { status: "ALREADY_ROUTED" } });
      expect(stallNotices(h)).toHaveLength(1);

      // Recovery: a start succeeds, which ends the failure episode.
      setBare(h.repoPath, false);
      setBare(secondRepo, false);
      h.clock.advance(10 * 60_000);
      const healthy = new Daemon(h.cp, { stateDir, crashLoopThreshold: 3 });
      expect((await healthy.start()).allowed).toBe(true);
      await healthy.stop();

      // A new failure after recovery is told again, once its refusals reach the threshold.
      setBare(h.repoPath, true);
      await refuse();
      await refuse();
      expect(stallNotices(h)).toHaveLength(1);
      const again = await refuse();
      expect(again).toMatchObject({ crashLoop: true, routing: { status: "ROUTED" } });
      expect(again.stallId).not.toBe(third.stallId);
      expect(stallNotices(h)).toHaveLength(2);
    } finally {
      h.cp.close();
    }
  });
});
