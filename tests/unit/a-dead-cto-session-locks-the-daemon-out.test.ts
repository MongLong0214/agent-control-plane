import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, it, vi } from "vitest";

import type { Decision } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import {
  BOOTSTRAP_OPERATOR_METHODS,
  canParkForBootstrap,
  Daemon,
  OPERATOR_METHOD,
  type AuthenticatedOperatorPeer,
  type BlockingFinding,
  type ReconcileReport,
} from "../../src/daemon/daemon.ts";
import {
  DEAD_BINDING_RECOVERY_OPERATION,
  probeSessionLiveness,
} from "../../src/daemon/dead-binding-recovery.ts";
import {
  ExecutionMode,
  Role,
  RunState,
  SessionLifecycle,
  roleKeyFor,
} from "../../src/domain/types.ts";
import type { TaskContract } from "../../src/run/run-engine.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import {
  bindCeo,
  makeHarness,
  registerFixtureProject,
  TEST_OWNER,
  type Harness,
} from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/** The socket-authenticated identity of the deployment's one allowlisted CLI owner. */
const OWNER_PEER: AuthenticatedOperatorPeer = {
  channel: "cli",
  peerId: `cli:${TEST_OWNER.actor}`,
  actor: TEST_OWNER.actor,
  incarnation: "operator-incarnation-1",
};

/** Authenticated on the socket, but not an owner this deployment allowlisted. */
const STRANGER_PEER: AuthenticatedOperatorPeer = {
  channel: "cli",
  peerId: "cli:not-the-owner",
  actor: "not-the-owner",
  incarnation: "operator-incarnation-1",
};

const CONTRACT: TaskContract = {
  goal: "dead session recovery",
  why: "a restart must not be a one-way door",
  scope: [],
  nonGoals: [],
  acceptance: ["verify.js exits 0"],
  priority: "NORMAL",
  humanGate: [],
  references: [],
};

/**
 * A pid that is definitely not alive right now.
 *
 * `spawnSync` returns only after the child has exited and been reaped, so `kill(pid, 0)` fails
 * from here on — which is exactly what the sweep and the recovery probe ask. A literal high pid
 * would be a guess: it can be in use, and a fixture that quietly found the session alive would
 * turn these cases green for a reason that has nothing to do with what they measure.
 */
const deadPid = (): number => {
  const finished = spawnSync("/usr/bin/true", [], { stdio: "ignore" });
  const pid = finished.pid;
  if (typeof pid !== "number" || pid <= 0) throw new Error("could not obtain a reaped child pid");
  expect(() => process.kill(pid, 0)).toThrow();
  return pid;
};

/** Every ACTIVE assignment id, so a case can state what a pass left behind. */
const activeAssignmentIds = (harness: Harness): string[] =>
  harness.cp.db
    .all<{ assignment_id: string }>(
      `SELECT assignment_id FROM assignments WHERE status = 'ACTIVE' ORDER BY created_at`,
    )
    .map((row) => row.assignment_id);

/**
 * Everything the recovery is required to leave untouched when it refuses, read as one comparable
 * value. Case 5 is a claim about *all* of it, so it is captured in one place rather than as a
 * handful of assertions that each happen to hold.
 */
const recoverableState = (harness: Harness) => ({
  assignments: harness.cp.db.all<Record<string, unknown>>(
    `SELECT assignment_id, role_key, session_id, binding_generation, status, revoked_at, revoked_reason
       FROM assignments ORDER BY assignment_id`,
  ),
  runs: harness.cp.db.all<Record<string, unknown>>(
    `SELECT run_id, state, owner_session_id, owner_binding_generation FROM runs ORDER BY run_id`,
  ),
  outbox: harness.cp.db.all<Record<string, unknown>>(
    `SELECT message_id, status, reason_code, binding_generation FROM outbox ORDER BY message_id`,
  ),
  auditKinds: harness.cp.db
    .all<{ kind: string }>(`SELECT kind FROM audit_events ORDER BY event_id`)
    .map((row) => row.kind),
  admittedNonces: harness.cp.db
    .all<{ nonce: string }>(`SELECT nonce FROM inbound_messages ORDER BY nonce`)
    .map((row) => row.nonce),
});

/**
 * The parts of a `start()` decision these cases are about, flattened into one comparable object.
 * `deny` carries the reconcile report under `evidence.reconcile`, `allow` carries it as `value`;
 * reading both through one shape keeps an assertion from having to know which branch it landed
 * on before it can describe what happened.
 */
const outcomeOf = (
  started: Decision<ReconcileReport>,
): {
  allowed: boolean;
  reasonCode: ReasonCode;
  blockingFindings: BlockingFinding[];
  sessionsMarkedError: string[];
} => {
  const report = started.allowed
    ? started.value
    : ((started.evidence as { reconcile?: ReconcileReport }).reconcile ?? null);
  return {
    allowed: started.allowed,
    reasonCode: started.reasonCode,
    blockingFindings: report?.blockingFindings ?? [],
    sessionsMarkedError: report?.sessionsMarkedError ?? [],
  };
};

/**
 * The daemon's mode as an operator can observe it — through `daemon.status`, which is one of the
 * methods a parked daemon admits. Read this way rather than from a private field so that the
 * assertion is about the surface the CLI and the supervisor actually see.
 */
const modeOf = async (daemon: Daemon): Promise<string> => {
  const status = await daemon.handleOperatorRequest(
    { requestId: "req-status", method: OPERATOR_METHOD.DAEMON_STATUS, params: {} },
    OWNER_PEER,
  );
  if (!status.allowed) throw new Error(`daemon.status refused: ${status.message}`);
  return (status.value as { mode: string }).mode;
};

/** A door that records its own lifecycle: the daemon must open exactly one and close it. */
const recordingDoor = () => {
  const opened: string[] = [];
  const closed: string[] = [];
  return {
    opened,
    closed,
    open: async () => {
      opened.push("open");
      return { close: async () => void closed.push("close") };
    },
  };
};

interface Fixture {
  harness: Harness;
  projectId: string;
  repositoryId: string;
  roleKey: string;
  sessionId: string;
  sessionIncarnation: string;
  assignmentId: string;
  bindingGeneration: number;
  messageId: string;
}

/**
 * The exact shape measured on the owner's host on 2026-09-08: one project, an ACTIVE PRIMARY_CTO
 * assignment, and the bound session's OS process gone.
 *
 * Built directly rather than through `runs.dispatch`, because dispatch leaves an open run behind
 * and the first case is about what happens when there is no work left to protect — the state in
 * which a daemon has nothing to lose by starting.
 *
 * `lifecycle: "SWEEP"` is the production sequence: the session is READY with a dead pid and
 * `reconcile()` is what discovers it. The other two settings produce states the sweep cannot
 * reach, so the cases about a live or unprovable process can exist at all.
 */
const deadCanonicalCto = async (
  options: {
    osPid?: number | null;
    lifecycle?: "SWEEP" | "ERROR";
  } = {},
): Promise<Fixture> => {
  const harness = makeHarness();
  // Without this the system doctor blocks on TRUSTED_GATE_CREDENTIAL_MISSING, and start() would
  // then refuse for a reason that is not the one under test.
  harness.cp.credentials.install({ token: "test-token", creatorIdentity: "acme-bot" });
  bindCeo(harness);
  const { projectId, repositoryId } = await registerFixtureProject(harness);

  const session = harness.cp.sessions.create({
    provider: "scripted",
    model: "scripted-cto",
    osPid: options.osPid === undefined ? deadPid() : options.osPid,
  });
  const ready = harness.cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "test cto");
  if (!ready.allowed) throw new Error(`session readiness failed: ${ready.message}`);

  const roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId });
  const bound = harness.cp.bindings.bind({
    role: Role.PRIMARY_CTO,
    roleKey,
    projectId,
    sessionId: session.sessionId,
  });
  if (!bound.allowed) throw new Error(`primary CTO binding failed: ${bound.message}`);

  // A real deployment has traffic in flight for the role it is about to lose. The recovery has to
  // fence it on success and leave it exactly as it is on refusal, and neither is observable
  // without a row to observe. Enqueued while the session is still READY, because that is the
  // only state the outbox accepts a target in.
  const message = harness.cp.outbox.enqueue({
    idempotencyKey: `dead-binding-fixture:${projectId}`,
    roleKey,
    bindingGeneration: bound.value.bindingGeneration,
    targetSessionId: session.sessionId,
    kind: "RUN_DISPATCH",
    payload: { projectId },
  });
  if (!message.allowed) throw new Error(`outbox enqueue failed: ${message.message}`);

  if (options.lifecycle === "ERROR") {
    const errored = harness.cp.sessions.transition(
      session.sessionId,
      SessionLifecycle.ERROR,
      "test: lost without a sweep",
    );
    if (!errored.allowed) throw new Error(`session error transition failed: ${errored.message}`);
  }

  return {
    harness,
    projectId,
    repositoryId,
    roleKey,
    sessionId: session.sessionId,
    sessionIncarnation: bound.value.boundSessionIncarnation,
    assignmentId: bound.value.assignmentId,
    bindingGeneration: bound.value.bindingGeneration,
    messageId: message.value.messageId,
  };
};

/** The recovery request the owner's `agentctl` would send, with every field overridable. */
const recoveryRequest = (fixture: Fixture, overrides: Record<string, unknown> = {}) => ({
  requestId: "req-recover-dead-binding",
  method: OPERATOR_METHOD.BINDING_RECOVER_DEAD,
  params: {
    projectId: fixture.projectId,
    role: Role.PRIMARY_CTO,
    sessionId: fixture.sessionId,
    sessionIncarnation: fixture.sessionIncarnation,
    expectedBindingGeneration: fixture.bindingGeneration,
    nonce: `owner-recovery-${fixture.projectId}`,
    approved: true,
    ...overrides,
  },
});

describe("a canonical CTO whose process is gone", () => {
  /**
   * Case 1 — the symptom measured live on 2026-09-08, carried through to recovery.
   *
   * The chain that produced it ran entirely inside one `start()`: `reconcile()` swept
   * `sessions.live()`, found the dead `osPid`, marked the session ERROR and left the ACTIVE
   * assignment pointing at it; the same pass ran the doctor, which read that assignment and
   * raised CTO_BINDING_POINTS_AT_DEAD_SESSION — CRITICAL, blocking, recommending "run a recovery
   * takeover for this project"; `canParkForBootstrap` did not admit it, so `start()` denied
   * DOCTOR_ERROR and the entrypoint exited with backoff; and every door that could perform the
   * recommended recovery was opened only after `start()` returned allowed. The remedy the finding
   * named was unreachable in exactly the state that raised it.
   *
   * What this asserts is the whole loop, not just the release: the daemon parks rather than
   * exiting, the restricted door serves the recovery, the doctor then stops blocking, and only
   * then does the park promote to NORMAL. Promotion is the part that must not be assumed —
   * `parkForBootstrap` re-runs the doctor and the sweep before it promotes, so a release that
   * did not actually satisfy the doctor would leave this waiting rather than passing.
   */
  it("parks, is recovered through the restricted door, and then promotes", async () => {
    const fixture = await deadCanonicalCto();
    const { harness, sessionId, assignmentId } = fixture;
    const daemon = new Daemon(harness.cp, { stateDir: tempDir("acp-dsr-recover-") });
    const door = recordingDoor();

    const starting = daemon.start({ bootstrapDoor: door.open });
    await vi.waitFor(() => expect(door.opened).toHaveLength(1));

    // The premise, stated so a failure here reads as "the fixture moved" rather than as the
    // defect: the sweep found the session dead, and its assignment survived that decision.
    expect(harness.cp.sessions.require(sessionId).lifecycle).toBe(SessionLifecycle.ERROR);
    expect(activeAssignmentIds(harness)).toContain(assignmentId);
    expect(await modeOf(daemon)).toBe("BOOTSTRAP");

    // Parking is not admission: normal work stays refused while the door is open.
    const dispatchWhileParked = await daemon.handleOperatorRequest(
      { requestId: "req-run-list", method: OPERATOR_METHOD.RUN_LIST, params: {} },
      OWNER_PEER,
    );
    expect(dispatchWhileParked.allowed).toBe(false);
    expect(dispatchWhileParked.reasonCode).toBe(ReasonCode.DAEMON_BOOTSTRAP_MODE);

    const recovered = await daemon.handleOperatorRequest(recoveryRequest(fixture), OWNER_PEER);
    expect(recovered).toMatchObject({
      allowed: true,
      reasonCode: ReasonCode.OK,
      value: {
        assignmentId,
        sessionId,
        releasedGeneration: fixture.bindingGeneration,
        liveness: "DEAD",
      },
    });

    const started = await starting;
    expect(outcomeOf(started)).toMatchObject({ allowed: true, reasonCode: ReasonCode.OK });
    expect(started.allowed && started.value.bootstrapParked).toBe(true);
    expect(await modeOf(daemon)).toBe("NORMAL");
    expect(door.closed).toHaveLength(1);

    // The release itself: the assignment is REVOKED with a reason naming its cause, and the
    // in-flight message for that generation is fenced rather than left addressable.
    expect(activeAssignmentIds(harness)).not.toContain(assignmentId);
    const assignment = harness.cp.db.get<{ status: string; revoked_reason: string | null }>(
      `SELECT status, revoked_reason FROM assignments WHERE assignment_id = ?`,
      [assignmentId],
    );
    expect(assignment?.status).toBe("REVOKED");
    expect(assignment?.revoked_reason).toContain("dead canonical binding recovery");
    expect(
      harness.cp.db.get<{ status: string }>(`SELECT status FROM outbox WHERE message_id = ?`, [
        fixture.messageId,
      ])?.status,
    ).toBe("REJECTED");
    expect(harness.cp.audit.byKind("DEAD_BINDING_RECOVERED")).toHaveLength(1);
    expect(harness.cp.audit.byKind("OWNER_APPROVAL_CONSUMED")).toHaveLength(1);

    await daemon.stop();
  });

  /**
   * The half of the change that must never land alone. `canParkForBootstrap` admitting this
   * finding, without a method on the door that clears it, is a daemon that parks forever behind
   * a held lock on a state no reachable command can answer — the bypass, wearing the fix's
   * clothes. Asserted as one statement so that deleting either half fails here.
   */
  it("admits the finding for parking only alongside the door method that clears it", () => {
    expect(canParkForBootstrap([
      { code: "CTO_BINDING_POINTS_AT_DEAD_SESSION", severity: "CRITICAL", scope: "project:p" },
    ])).toBe(true);
    expect(BOOTSTRAP_OPERATOR_METHODS.has(OPERATOR_METHOD.BINDING_RECOVER_DEAD)).toBe(true);
  });

  /**
   * Case 2 — unauthorized is refused, at each of the three places authority is established: who
   * the socket says is calling, whether the owner said yes, and whether the request carries a
   * decision at all.
   *
   * Each refusal also has to be inert. A door that denies and still spends the nonce, or denies
   * and still releases the role, is not a door that refused.
   */
  it("refuses a peer this deployment has not allowlisted as an owner", async () => {
    const fixture = await deadCanonicalCto();
    const daemon = new Daemon(fixture.harness.cp, { stateDir: tempDir("acp-dsr-stranger-") });
    const door = recordingDoor();
    const starting = daemon.start({ bootstrapDoor: door.open });
    await vi.waitFor(() => expect(door.opened).toHaveLength(1));
    const before = recoverableState(fixture.harness);

    const refused = await daemon.handleOperatorRequest(recoveryRequest(fixture), STRANGER_PEER);

    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.INGRESS_ACTOR_NOT_ALLOWLISTED);
    expect(recoverableState(fixture.harness)).toEqual(before);
    expect(await modeOf(daemon)).toBe("BOOTSTRAP");
    await daemon.stop();
    await starting;
  });

  it("refuses an owner decision that is a rejection", async () => {
    const fixture = await deadCanonicalCto();
    const daemon = new Daemon(fixture.harness.cp, { stateDir: tempDir("acp-dsr-rejected-") });
    const door = recordingDoor();
    const starting = daemon.start({ bootstrapDoor: door.open });
    await vi.waitFor(() => expect(door.opened).toHaveLength(1));
    const before = recoverableState(fixture.harness);

    const refused = await daemon.handleOperatorRequest(
      recoveryRequest(fixture, { approved: false }),
      OWNER_PEER,
    );

    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE);
    expect(recoverableState(fixture.harness)).toEqual(before);
    await daemon.stop();
    await starting;
  });

  it("refuses a request carrying no owner decision at all", async () => {
    const fixture = await deadCanonicalCto();
    const daemon = new Daemon(fixture.harness.cp, { stateDir: tempDir("acp-dsr-no-decision-") });
    const door = recordingDoor();
    const starting = daemon.start({ bootstrapDoor: door.open });
    await vi.waitFor(() => expect(door.opened).toHaveLength(1));
    const before = recoverableState(fixture.harness);

    for (const missing of [{ approved: undefined }, { nonce: undefined }, { approved: "yes" }]) {
      const refused = await daemon.handleOperatorRequest(
        recoveryRequest(fixture, missing),
        OWNER_PEER,
      );
      expect(refused.allowed).toBe(false);
      expect(refused.reasonCode).toBe(ReasonCode.INVALID_ARGUMENT);
    }
    expect(recoverableState(fixture.harness)).toEqual(before);
    await daemon.stop();
    await starting;
  });

  /**
   * Case 3 — a request naming anything other than the binding actually in force is refused.
   *
   * Every field is exercised separately rather than as one "wrong request", because they fail at
   * different checks and a single case would pass on whichever check happens to run first. The
   * generation row is the one that carries the no-regression property: a replayed request naming
   * a superseded generation must be refused, not applied.
   */
  it("refuses a request that names a different target", async () => {
    const fixture = await deadCanonicalCto();
    const daemon = new Daemon(fixture.harness.cp, { stateDir: tempDir("acp-dsr-wrong-target-") });
    const door = recordingDoor();
    const starting = daemon.start({ bootstrapDoor: door.open });
    await vi.waitFor(() => expect(door.opened).toHaveLength(1));
    const before = recoverableState(fixture.harness);

    const wrong: Array<[string, Record<string, unknown>, ReasonCode]> = [
      ["project", { projectId: "some-other-project" }, ReasonCode.NOT_FOUND],
      ["role", { role: Role.CEO }, ReasonCode.INVALID_ARGUMENT],
      ["session", { sessionId: "ses_not_the_bound_one" }, ReasonCode.INVALID_ARGUMENT],
      ["incarnation", { sessionIncarnation: "not-the-bound-lifetime" }, ReasonCode.INVALID_ARGUMENT],
      [
        "generation",
        { expectedBindingGeneration: fixture.bindingGeneration + 1 },
        ReasonCode.WRITE_BINDING_GENERATION_STALE,
      ],
    ];
    for (const [field, override, expected] of wrong) {
      const refused = await daemon.handleOperatorRequest(
        recoveryRequest(fixture, override),
        OWNER_PEER,
      );
      expect({ field, allowed: refused.allowed, reasonCode: refused.reasonCode }).toEqual({
        field,
        allowed: false,
        reasonCode: expected,
      });
    }

    expect(recoverableState(fixture.harness)).toEqual(before);
    expect(await modeOf(daemon)).toBe("BOOTSTRAP");
    await daemon.stop();
    await starting;
  });

  /**
   * Case 4, first half — a session whose process is still running is not recoverable, however
   * the binding came to look broken. The doctor's finding is about the session's *lifecycle*, and
   * a lifecycle is a record; the process is the fact. Only the fact may release an authority.
   */
  it("refuses a session whose process is still alive", async () => {
    // This test process: unambiguously alive, and `create()` records its start time alongside the
    // pid, so the pair the probe compares is a real one.
    const fixture = await deadCanonicalCto({ osPid: process.pid, lifecycle: "ERROR" });
    const daemon = new Daemon(fixture.harness.cp, { stateDir: tempDir("acp-dsr-alive-") });
    const door = recordingDoor();
    const starting = daemon.start({ bootstrapDoor: door.open });
    await vi.waitFor(() => expect(door.opened).toHaveLength(1));
    const before = recoverableState(fixture.harness);

    const refused = await daemon.handleOperatorRequest(recoveryRequest(fixture), OWNER_PEER);

    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.RECOVERY_TAKEOVER_REQUIRES_UNREACHABLE_OWNER);
    expect(refused.evidence).toMatchObject({ liveness: "ALIVE" });
    expect(recoverableState(fixture.harness)).toEqual(before);
    expect(await modeOf(daemon)).toBe("BOOTSTRAP");
    await daemon.stop();
    await starting;
  });

  /**
   * Case 4, second half, and the one that is easiest to get wrong: a session with no recorded pid
   * cannot be *proven* dead. It is overwhelmingly likely to be dead — nothing is running it — and
   * that is precisely the reasoning this refuses. Unknown is a refusal, not a permission.
   */
  it("refuses a session whose liveness cannot be determined", async () => {
    const fixture = await deadCanonicalCto({ osPid: null, lifecycle: "ERROR" });
    const daemon = new Daemon(fixture.harness.cp, { stateDir: tempDir("acp-dsr-unknown-") });
    const door = recordingDoor();
    const starting = daemon.start({ bootstrapDoor: door.open });
    await vi.waitFor(() => expect(door.opened).toHaveLength(1));
    const before = recoverableState(fixture.harness);

    const refused = await daemon.handleOperatorRequest(recoveryRequest(fixture), OWNER_PEER);

    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.RECOVERY_TAKEOVER_REQUIRES_UNREACHABLE_OWNER);
    expect(refused.evidence).toMatchObject({ liveness: "UNKNOWN" });
    expect(recoverableState(fixture.harness)).toEqual(before);
    await daemon.stop();
    await starting;
  });

  /**
   * Case 5 — a failure part-way through leaves nothing behind.
   *
   * The revoke is made to throw because it is the last write of the sequence: by the time it runs
   * the approval has been admitted *and* consumed, so if any of it were outside the transaction
   * this is where it would show. Comparing the whole of `recoverableState` rather than the
   * binding alone is the point — a rollback that restored the assignment but kept the admitted
   * nonce would leave an owner decision on record for something that did not happen, and the
   * nonce could then never be reused.
   */
  it("leaves no partial change when the release fails mid-flight", async () => {
    const fixture = await deadCanonicalCto();
    const daemon = new Daemon(fixture.harness.cp, { stateDir: tempDir("acp-dsr-midflight-") });
    const door = recordingDoor();
    const starting = daemon.start({ bootstrapDoor: door.open });
    await vi.waitFor(() => expect(door.opened).toHaveLength(1));
    const before = recoverableState(fixture.harness);

    const revoke = vi.spyOn(fixture.harness.cp.bindings, "revoke").mockImplementation(() => {
      throw new Error("simulated storage failure during revoke");
    });
    const failed = await daemon.handleOperatorRequest(recoveryRequest(fixture), OWNER_PEER);
    revoke.mockRestore();

    expect(failed.allowed).toBe(false);
    expect(recoverableState(fixture.harness)).toEqual(before);
    expect(fixture.harness.cp.audit.byKind("DEAD_BINDING_RECOVERED")).toHaveLength(0);
    expect(fixture.harness.cp.audit.byKind("OWNER_APPROVAL_CONSUMED")).toHaveLength(0);
    expect(await modeOf(daemon)).toBe("BOOTSTRAP");

    // And the nonce is genuinely unspent: the same request succeeds once the failure is gone.
    const retried = await daemon.handleOperatorRequest(recoveryRequest(fixture), OWNER_PEER);
    expect(retried.allowed).toBe(true);

    const started = await starting;
    expect(started.allowed).toBe(true);
    await daemon.stop();
  });

  /**
   * The property the whole design turns on, and the one a parkable CRITICAL could quietly cost:
   * a project that still has open work does not get to come up just because its dead binding was
   * released. The release is allowed here — the run is QUEUED and owned by nobody, so there is no
   * live work pinned to the generation for `BindingRegistry.revoke` to protect — and the doctor
   * then raises CTO_MISSING_WITH_OPEN_RUNS, which nothing on this door clears and
   * `canParkForBootstrap` does not admit. So the park abandons and `start()` denies, exactly as
   * it did before this change, with a finding naming the real condition rather than one swept out
   * of sight.
   *
   * This is the case that would fail if the fix had been "make the finding parkable": the daemon
   * would have come up with a project whose work has no owner.
   */
  it("does not come up for a project whose open work has no CTO", async () => {
    const fixture = await deadCanonicalCto();
    const { harness, projectId, repositoryId } = fixture;
    const created = harness.cp.runs.create({
      projectId,
      executionMode: ExecutionMode.STANDARD,
      contract: CONTRACT,
      repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
    });
    if (!created.allowed) throw new Error(created.message);
    expect(harness.cp.runs.require(created.value.runId).state).toBe(RunState.QUEUED);

    const daemon = new Daemon(harness.cp, { stateDir: tempDir("acp-dsr-open-runs-") });
    const door = recordingDoor();
    const starting = daemon.start({ bootstrapDoor: door.open });
    await vi.waitFor(() => expect(door.opened).toHaveLength(1));

    const recovered = await daemon.handleOperatorRequest(recoveryRequest(fixture), OWNER_PEER);
    expect(recovered.allowed).toBe(true);

    const started = await starting;
    expect(started.allowed).toBe(false);
    expect(started.reasonCode).toBe(ReasonCode.DOCTOR_ERROR);
    // The finding that ended the park is read from the abandon record, not from the denial's
    // `reconcile` evidence. `start()` denies with the report it *entered* the park holding —
    // pre-existing behaviour, unchanged here — so that evidence still names the finding the park
    // began with. `DAEMON_BOOTSTRAP_ABANDONED` is where the finding that actually stopped it is
    // written, and that is the one this case is about.
    const abandoned = harness.cp.audit.byKind("DAEMON_BOOTSTRAP_ABANDONED");
    expect(abandoned).toHaveLength(1);
    expect(
      (abandoned[0]!.evidence as { blockingFindings: BlockingFinding[] }).blockingFindings.map(
        (f) => f.code,
      ),
    ).toContain("CTO_MISSING_WITH_OPEN_RUNS");
    expect(daemon.lock.held()).toBe(false);
    expect(door.closed).toHaveLength(1);
    // The run is still there, still queued, still waiting for an owner. Nothing was cancelled to
    // make the daemon's life easier.
    expect(harness.cp.runs.require(created.value.runId).state).toBe(RunState.QUEUED);
  });
});

/**
 * The liveness probe on its own, for the answers a fixture cannot provoke.
 *
 * `EPERM` is the reason this is three-valued at all and there is no way to arrange a process this
 * test may not signal without root, so the syscall is injected. The pid-reuse row is the only
 * place a pid that *answers* is allowed to mean dead, and it is worth stating separately from the
 * daemon cases: it is the branch that keeps a recovery possible on a host that has cycled through
 * its pid space, and also the branch most likely to be deleted as "redundant".
 */
describe("proving a session's process is gone", () => {
  const startedAt = "Mon Sep  8 08:00:00 2026";

  it("reads each outcome from the evidence, and refuses to guess", () => {
    const esrch = () => {
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    };
    const eperm = () => {
      throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    };
    const answers = () => undefined;

    expect(probeSessionLiveness(4242, startedAt, { signal: esrch })).toBe("DEAD");
    // Exists, not ours to signal. Reading this as dead would evict a live incumbent.
    expect(probeSessionLiveness(4242, startedAt, { signal: eperm })).toBe("ALIVE");
    expect(probeSessionLiveness(null, startedAt)).toBe("UNKNOWN");
    expect(probeSessionLiveness(0, startedAt)).toBe("UNKNOWN");
    expect(
      probeSessionLiveness(4242, startedAt, { signal: answers, startedAt: () => startedAt }),
    ).toBe("ALIVE");
    // The pid answers but belongs to something else now: positive evidence of death.
    expect(
      probeSessionLiveness(4242, startedAt, {
        signal: answers,
        startedAt: () => "Mon Sep  8 09:30:00 2026",
      }),
    ).toBe("DEAD");
    // No recorded pair to compare, or no readable current one: undecided, so refused.
    expect(probeSessionLiveness(4242, null, { signal: answers })).toBe("ALIVE");
    expect(
      probeSessionLiveness(4242, startedAt, { signal: answers, startedAt: () => null }),
    ).toBe("UNKNOWN");
    // An error that names nothing decides nothing.
    expect(
      probeSessionLiveness(4242, startedAt, {
        signal: () => {
          throw new Error("no code at all");
        },
      }),
    ).toBe("UNKNOWN");
  });

  it("names its own operation, so no other owner approval can be replayed at this door", () => {
    expect(DEAD_BINDING_RECOVERY_OPERATION).toBe("binding.recover_dead_canonical");
  });
});
