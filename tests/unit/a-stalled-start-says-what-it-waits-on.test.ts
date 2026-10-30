import { chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { NotificationKind } from "../../src/ceo/production-gate.ts";
import { StallSource, routeStallToCeo } from "../../src/ceo/stall-notice.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { deliverStartStallNotices, startConfiguredCeoNotificationRoute } from "../../src/daemon/agentcpd.ts";
import { Daemon } from "../../src/daemon/daemon.ts";
import { classifyStartFinding } from "../../src/daemon/start-stall.ts";
import { TERMINAL_RUN_STATES } from "../../src/domain/run-state.ts";
import { ExecutionMode, Role, roleKeyFor } from "../../src/domain/types.ts";
import { MessageKind } from "../../src/outbox/envelope.ts";
import type { DaemonNoticeBody, DaemonNoticeSendOutcome } from "../../src/runtime/acp-daemon-notice.ts";
import type { TaskContract } from "../../src/run/run-engine.ts";
import { DIGEST, LIVE, GATEWAY, LSTART, TOKEN, adoptedFixture } from "../helpers/adopted-ceo.ts";
import { cleanupTempDirs, gitSync, tempDir } from "../helpers/fixtures.ts";
import { admitInbound, bindCeo, bindWorker, makeHarness, registerFixtureProject, type Harness } from "../helpers/harness.ts";

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
          stallNotice: async (messageIds) => { sent.push({ messageIds, lockHeld: daemon.lock.held() }); },
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
      // The notice's own audit row keeps its evidence: nothing in it is a payload the audit log refuses.
      expect(h.cp.audit.byKind("CEO_NOTIFICATION").at(-1)!.evidence).toMatchObject({
        notification: NotificationKind.CRITICAL_SYSTEM_FAILURE, source: "DAEMON_START_STALL", cause: "PERMANENT",
      });
      // Sent before the lock was let go: the one moment this process may speak for the deployment.
      expect(sent).toEqual([{ messageIds: [notice!.message_id], lockHeld: true }]);

      const stall = health(stateDir)["startStall"] as Record<string, unknown>;
      expect(stall).toMatchObject({
        phase: "REFUSED", cause: "PERMANENT", blockedRunCount: 2,
        routing: { status: "ROUTED", messageId: notice!.message_id, deliveryStatus: "PENDING" },
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
        stallNotice: async (messageIds) => { sent.push(messageIds); },
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
          stallNotice: async (messageIds) => { sent.push(messageIds); },
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
        stallNotice: async (messageIds) => { sent.push({ messageIds, lockHeld: daemon.lock.held() }); },
      });
      await vi.waitFor(() => expect(opened).toHaveLength(1));

      const [notice, ...others] = stallNotices(h);
      expect(others).toEqual([]);
      expect(notice!.payload).toMatchObject({
        source: "DAEMON_START_STALL", phase: "PARKED", cause: "PERMANENT",
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
  const pinned = (lockHeld: () => boolean) => ({
    authorityHeld: lockHeld, processStartToken: () => TOKEN, processStartedAt: () => LSTART,
    identityReader: () => async () => ({ session_id: LIVE, lineage_root_digest: DIGEST, process_pid: GATEWAY, process_started_at: TOKEN }),
  });

  it("sends only the stalled start's notice over the canonical CEO route, and only while the lock is held", async () => {
    const sent: string[] = [];
    const noticeSenderFactory = () => async (body: DaemonNoticeBody): Promise<DaemonNoticeSendOutcome> => {
      sent.push(body.event_id);
      return { kind: "RESPONDED", status: 200, body: { event_id: body.event_id, payload_digest: body.payload_digest,
        receipt: { status: "completed", receipt_id: "receipt", session_id: LIVE, lineage_root_digest: DIGEST } } };
    };
    // A deployment whose canonical route has run before: the attempt journal predates these rows.
    const f = adoptedFixture({
      history: (h) => {
        expect(startConfiguredCeoNotificationRoute(h.cp, { environment: { ACP_TELEGRAM_EXTERNAL_SECRET: "lane-secret" },
          hermesConfiguration: HERMES, ports: { ...pinned(() => false), noticeSenderFactory } })).toEqual({ started: true });
      },
    });
    try {
      const cp = f.h.cp;
      const ceo = cp.bindings.active(roleKeyFor(Role.CEO))!;
      const other = cp.outbox.enqueue({ idempotencyKey: "an-ordinary-notification", roleKey: "CEO",
        bindingGeneration: ceo.bindingGeneration, targetSessionId: ceo.sessionId, kind: MessageKind.CEO_NOTIFICATION,
        payload: { question: "an ordinary notification" } });
      if (!other.allowed) throw new Error(other.message);
      const routed = routeStallToCeo(cp, {
        source: StallSource.DAEMON_START, stallId: "fixture-stall", runId: null, describe: () => ({ cause: "PERMANENT" }),
      });
      if (routed.status !== "ROUTED") throw new Error(`not routed: ${JSON.stringify(routed)}`);
      const options = { environment: { ACP_TELEGRAM_EXTERNAL_SECRET: "lane-secret" }, hermesConfiguration: HERMES };
      const touched = (messageId: string) => cp.db.all<{ kind: string }>(
        `SELECT kind FROM audit_events WHERE json_extract(evidence_json, '$.messageId') = ? ORDER BY event_id`, [messageId],
      ).map((row) => row.kind);
      const otherBefore = touched(other.value.messageId);

      // The lock already let go: the pin refuses, nothing is sent, and the notice waits for the next start.
      expect(await deliverStartStallNotices(cp, { ...options, ports: { ...pinned(() => false), noticeSenderFactory } },
        [routed.messageId])).toEqual({ started: true });
      expect(sent).toEqual([]);
      expect(cp.outbox.get(routed.messageId)?.status).toBe("PENDING");

      expect(await deliverStartStallNotices(cp, { ...options, ports: { ...pinned(() => true), noticeSenderFactory } },
        [routed.messageId])).toEqual({ started: true });
      expect(sent).toHaveLength(1);
      expect(cp.outbox.get(routed.messageId)?.status).toBe("ACKED");
      // Everything else queued for the CEO waits for the started daemon's own route, untouched: no
      // attempt and no "route unavailable" record is written against it.
      expect(cp.outbox.get(other.value.messageId)?.status).toBe("PENDING");
      expect(touched(other.value.messageId)).toEqual(otherBefore);

      expect(await deliverStartStallNotices(cp, { environment: {}, hermesConfiguration: HERMES, ports: pinned(() => true) },
        [routed.messageId])).toEqual({ started: false, reason: "ACP_TELEGRAM_EXTERNAL_SECRET is not configured" });
    } finally {
      f.h.cp.close();
    }
  });
});
