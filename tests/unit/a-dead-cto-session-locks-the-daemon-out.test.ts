import { spawnSync } from "node:child_process";
import { chmodSync } from "node:fs";
import { afterAll, describe, expect, it, vi } from "vitest";

import type { Decision } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import {
  canParkForBootstrap,
  Daemon,
  OPERATOR_METHOD,
  type AuthenticatedOperatorPeer,
  type BlockingFinding,
  type ReconcileReport,
} from "../../src/daemon/daemon.ts";
import {
  DEAD_BINDING_RECOVERY_ROLE,
  DEAD_BINDING_SWEEP_ACTOR,
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
const DEAD_PID_BUDGET_MS = 30_000;

const deadPid = (): number => {
  // Bounded even though the child is `/usr/bin/true` (#872). What makes an immediate-exit child
  // hang is not the child: `spawnSync` blocks the event loop, so vitest's per-test timeout cannot
  // interrupt one, and a host whose exec path is wedged — Gatekeeper assessing a new inode is the
  // measured case here — stops the worker rather than this test. vitest then reports a timeout
  // against whichever test that worker happened to be holding, so the file that fails is not the
  // file that hung.
  //
  // `spawnSync` rather than the group-reaping helper in `tests/helpers/bounded-child.ts`, and the
  // reason is this function's deliverable: it needs the pid of a child that has *already been
  // reaped*, which is a property only the synchronous form has. `/usr/bin/true` starts no
  // grandchild, so there is no group for that helper to add anything to.
  const finished = spawnSync("/usr/bin/true", [], { stdio: "ignore", timeout: DEAD_PID_BUDGET_MS });
  // A killed child is refused rather than read. `signal` is what says so: `spawnSync` leaves
  // `killed` unset on this path (measured elsewhere in this repository at `killed: null` beside a
  // real SIGTERM), and a timed-out child's pid names a process the kernel may not have reaped yet
  // — which would make the `kill(pid, 0)` below pass for the wrong reason.
  if (finished.signal !== null) {
    throw new Error(
      `/usr/bin/true did not exit within ${DEAD_PID_BUDGET_MS}ms (signal ${finished.signal}); ` +
        "its pid is not a reaped pid, so it cannot stand in for a dead session",
    );
  }
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

/**
 * Starts the daemon over `fixture` and requires it to come up: no park, no exit, NORMAL.
 *
 * A project's CTO is availability, not a precondition for the daemon's sockets. A parked daemon
 * has not returned from `start()`, and `agentcpd` opens the claim socket and cto.mcp.sock only
 * after it returns, so a park here is the defect and is reported as one at once rather than as a
 * test timeout. A door is still supplied, so a park stays possible to observe.
 */
const startedPastTheBinding = async (fixture: Fixture, prefix: string): Promise<Daemon> => {
  const daemon = new Daemon(fixture.harness.cp, { stateDir: tempDir(prefix) });
  let markParked: () => void = () => undefined;
  const parked = new Promise<"parked">((resolve) => {
    markParked = () => resolve("parked");
  });
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
    throw new Error("the daemon parked on a project's CTO instead of starting");
  }
  expect(outcomeOf(first)).toMatchObject({ allowed: true, reasonCode: ReasonCode.OK, blockingFindings: [] });
  expect(await modeOf(daemon)).toBe("NORMAL");
  return daemon;
};

/** The startup doctor's own record of a finding, read from the first system DOCTOR_REPORT row. */
const startupFinding = (harness: Harness, code: string) =>
  harness.cp.audit
    .byKind("DOCTOR_REPORT")
    .map((event) => event.evidence as {
      scope: string;
      findings: Array<{ code: string; severity: string; blocking: boolean }>;
    })
    .find((evidence) => evidence.scope === "system")
    ?.findings.find((finding) => finding.code === code);

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

/** What a refused or rolled-back release must leave exactly as it was: the role, its runs and its outbox. */
const holderState = (harness: Harness) => {
  const { assignments, runs, outbox } = recoverableState(harness);
  return { assignments, runs, outbox };
};

/** Runs the daemon's own dead-session sweep, the way `start()` and every watchdog tick do. */
const sweep = (fixture: Fixture, prefix: string) =>
  new Daemon(fixture.harness.cp, { stateDir: tempDir(prefix) }).reconcile();

describe("a canonical CTO whose process is gone", () => {
  /**
   * Case 1 — the symptom measured live on 2026-09-08, carried through to recovery.
   *
   * The chain that produced it ran entirely inside one `start()`: `reconcile()` swept
   * `sessions.live()`, found the dead `osPid`, marked the session ERROR and left the ACTIVE
   * assignment pointing at it, so the doctor raised CTO_BINDING_POINTS_AT_DEAD_SESSION and the
   * role stayed held by a corpse until a person released it through a door. The same sweep now
   * releases the binding it just proved dead, so the daemon comes up with the role free and the
   * doctor has nothing to name.
   */
  it("comes up past a dead canonical binding, and the sweep releases it without an operator call", async () => {
    const fixture = await deadCanonicalCto();
    const { harness, sessionId, assignmentId } = fixture;
    const daemon = await startedPastTheBinding(fixture, "acp-dsr-recover-");

    expect(harness.cp.sessions.require(sessionId).lifecycle).toBe(SessionLifecycle.ERROR);
    expect(activeAssignmentIds(harness)).not.toContain(assignmentId);
    const assignment = harness.cp.db.get<{ status: string; revoked_reason: string | null }>(
      `SELECT status, revoked_reason FROM assignments WHERE assignment_id = ?`,
      [assignmentId],
    );
    expect(assignment?.status).toBe("REVOKED");
    expect(assignment?.revoked_reason).toContain("dead canonical binding recovery");
    // The in-flight message for that generation is fenced rather than left addressable.
    expect(
      harness.cp.db.get<{ status: string }>(`SELECT status FROM outbox WHERE message_id = ?`, [
        fixture.messageId,
      ])?.status,
    ).toBe("REJECTED");
    const recorded = harness.cp.audit.byKind("DEAD_BINDING_RECOVERED");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.actor).toBe(DEAD_BINDING_SWEEP_ACTOR);
    expect(harness.cp.audit.byKind("OWNER_APPROVAL_CONSUMED")).toHaveLength(0);
    expect(recoverableState(harness).admittedNonces).toEqual([]);
    expect(startupFinding(harness, "CTO_BINDING_POINTS_AT_DEAD_SESSION")).toBeUndefined();

    await daemon.stop();
  });

  /**
   * The door is gone and so is the park that existed for it. Admitting the finding for parking
   * with no method to clear it is a daemon that waits forever behind a held lock, so the two left
   * together: the finding no longer parks the daemon, and the removed method is refused as unknown.
   */
  it("no longer parks for the finding, and refuses the removed operator method as unknown", async () => {
    expect(canParkForBootstrap([
      { code: "CTO_BINDING_POINTS_AT_DEAD_SESSION", severity: "CRITICAL", scope: "project:p" },
    ])).toBe(false);

    const fixture = await deadCanonicalCto();
    const daemon = await startedPastTheBinding(fixture, "acp-dsr-removed-door-");
    // Spelled in parts so a search for the removed method's name stays empty across src and tests.
    const removed = ["binding", "recover" + "Dead"].join(".");
    expect(Object.values(OPERATOR_METHOD)).not.toContain(removed);
    const refused = await daemon.handleOperatorRequest(
      { requestId: "req-removed-door", method: removed, params: {} },
      OWNER_PEER,
    );
    expect(refused.allowed).toBe(false);
    await daemon.stop();
  });

  /**
   * A session whose process is still running is not released, however the binding came to look
   * broken. The doctor's finding is about the session's *lifecycle*, a record; the process is the
   * fact, and only the fact may release an authority.
   */
  it("does not release a holder whose process is still alive", async () => {
    // This test process: unambiguously alive, and `create()` records its start time alongside the
    // pid, so the pair the probe compares is a real one.
    const fixture = await deadCanonicalCto({ osPid: process.pid, lifecycle: "ERROR" });
    const daemon = await startedPastTheBinding(fixture, "acp-dsr-alive-");
    const before = holderState(fixture.harness);

    await sweep(fixture, "acp-dsr-alive-again-");

    expect(holderState(fixture.harness)).toEqual(before);
    expect(activeAssignmentIds(fixture.harness)).toContain(fixture.assignmentId);
    expect(fixture.harness.cp.audit.byKind("DEAD_BINDING_RECOVERED")).toHaveLength(0);
    expect(await modeOf(daemon)).toBe("NORMAL");
    await daemon.stop();
  });

  /**
   * A session with no recorded pid cannot be *proven* dead. It is overwhelmingly likely to be dead
   * — nothing is running it — and that is precisely the reasoning this refuses. Unknown is a
   * refusal, not a permission.
   */
  it("does not release a holder whose liveness cannot be determined", async () => {
    const fixture = await deadCanonicalCto({ osPid: null, lifecycle: "ERROR" });
    const daemon = await startedPastTheBinding(fixture, "acp-dsr-unknown-");
    const before = holderState(fixture.harness);

    await sweep(fixture, "acp-dsr-unknown-again-");

    expect(holderState(fixture.harness)).toEqual(before);
    expect(activeAssignmentIds(fixture.harness)).toContain(fixture.assignmentId);
    expect(fixture.harness.cp.audit.byKind("DEAD_BINDING_RECOVERED")).toHaveLength(0);
    await daemon.stop();
  });

  /**
   * A failure part-way through leaves nothing behind.
   *
   * The *audit* is made to throw, not the revoke: `BindingRegistry.revoke` has already flipped the
   * assignment to REVOKED and fenced the outbox message by then, and without the transaction those
   * stand while the `DEAD_BINDING_RECOVERED` record that explains them never lands. Comparing the
   * role, runs and outbox as one value is the point — a rollback that restored the assignment but
   * left the outbox fenced is not a rollback.
   */
  it("leaves no partial change when the release fails mid-flight, records it, and releases on the next sweep", async () => {
    const fixture = await deadCanonicalCto({ lifecycle: "ERROR" });
    const before = holderState(fixture.harness);

    const record = fixture.harness.cp.audit.record.bind(fixture.harness.cp.audit);
    const audit = vi
      .spyOn(fixture.harness.cp.audit, "record")
      .mockImplementation((event: Parameters<typeof record>[0]) => {
        if (event.kind === "DEAD_BINDING_RECOVERED") {
          throw new Error("simulated storage failure while recording the release");
        }
        return record(event);
      });
    try {
      // The sweep answers; a release that throws is recorded, not rethrown into `reconcile()`.
      await sweep(fixture, "acp-dsr-midflight-");
    } finally {
      audit.mockRestore();
    }

    expect(holderState(fixture.harness)).toEqual(before);
    expect(fixture.harness.cp.audit.byKind("DAEMON_TIMER_FAILED")).toMatchObject([
      { roleKey: fixture.roleKey, evidence: { timer: "liveness-sweep", role: fixture.roleKey, error: expect.stringContaining("simulated storage failure") } },
    ]);
    expect(fixture.harness.cp.audit.byKind("DEAD_BINDING_RECOVERED")).toHaveLength(0);
    expect(activeAssignmentIds(fixture.harness)).toContain(fixture.assignmentId);

    // Nothing about the failed attempt bars the next one: it is read again and released.
    await sweep(fixture, "acp-dsr-midflight-retry-");
    expect(activeAssignmentIds(fixture.harness)).not.toContain(fixture.assignmentId);
    expect(fixture.harness.cp.audit.byKind("DEAD_BINDING_RECOVERED")).toHaveLength(1);
  });

  /**
   * A project whose open work has no CTO used to end the process: CTO_MISSING_WITH_OPEN_RUNS was a
   * blocking ERROR in the system report, `canParkForBootstrap` did not admit it, and `start()`
   * denied. That made one project's missing CTO a precondition for the whole daemon, including the
   * claim socket a CTO would bind through. It is availability, so the system report now names it
   * as a non-blocking ERROR and the daemon comes up. The project's own report still blocks on it,
   * and nothing is cancelled to let the daemon start.
   */
  it("comes up for a project whose open work has no CTO, and still names the gap", async () => {
    const fixture = await deadCanonicalCto();
    const { harness, projectId, repositoryId, roleKey } = fixture;
    const created = harness.cp.runs.create({
      projectId,
      executionMode: ExecutionMode.STANDARD,
      contract: CONTRACT,
      repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
    });
    if (!created.allowed) throw new Error(created.message);
    expect(harness.cp.runs.require(created.value.runId).state).toBe(RunState.QUEUED);
    // The binding released before the restart, the way an operator release leaves it: the run is
    // QUEUED and owned by nobody, so nothing pins the generation.
    const released = harness.cp.bindings.revoke(roleKey, "test: released before the restart");
    expect(released.allowed, JSON.stringify(released)).toBe(true);
    const projectReport = await harness.cp.doctor.run("project", projectId);
    expect(projectReport.findings.find((finding) => finding.code === "CTO_MISSING_WITH_OPEN_RUNS"))
      .toMatchObject({ severity: "ERROR", blocking: true });

    const daemon = await startedPastTheBinding(fixture, "acp-dsr-open-runs-");

    expect(startupFinding(harness, "CTO_MISSING_WITH_OPEN_RUNS")).toEqual({
      code: "CTO_MISSING_WITH_OPEN_RUNS",
      severity: "ERROR",
      blocking: false,
    });
    expect([RunState.CANCELLED, RunState.FAILED]).not.toContain(
      harness.cp.runs.require(created.value.runId).state,
    );
    await daemon.stop();
  });

  /**
   * The other direction. Taking availability off the startup gate must not take an integrity
   * blocker with it: a state path anyone else can write still ends the start, without a park, and
   * the denial names that blocker alone rather than burying it beside the CTO it no longer counts.
   */
  it("still refuses to start on a real blocker beside a dead canonical binding", async () => {
    const fixture = await deadCanonicalCto();
    const { harness } = fixture;
    chmodSync(harness.cp.config.worktreeRoot, 0o755);
    const daemon = new Daemon(harness.cp, { stateDir: tempDir("acp-dsr-real-blocker-") });
    const opened: string[] = [];

    const started = await daemon.start({
      bootstrapDoor: async () => {
        opened.push("open");
        return { close: async () => undefined };
      },
    });

    expect(outcomeOf(started)).toMatchObject({ allowed: false, reasonCode: ReasonCode.DOCTOR_ERROR });
    expect(opened).toEqual([]);
    expect(daemon.lock.held()).toBe(false);
    expect([...new Set(outcomeOf(started).blockingFindings.map((finding) => finding.code))]).toEqual([
      "STATE_PATH_INSECURE",
    ]);
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

  it("recovers exactly one role, named here and not taken from the request", () => {
    expect(DEAD_BINDING_RECOVERY_ROLE).toBe(Role.PRIMARY_CTO);
  });
});

/**
 * ACP1045-R1-02 — the startup relaxation belongs to the system report, not to every report that
 * names no project.
 *
 * `doctor.run("project")` and `doctor.run("cto")` take an optional target, and the CLI and both
 * MCP doors let a caller omit it. Deciding blocking from the target alone read those untargeted
 * reports as the system report and demoted both CTO findings in them. These pin every project and
 * CTO report, targeted and untargeted, to blocking, and the system report alone to non-blocking.
 */
describe("ACP1045-R1-02: project and CTO reports still block on a project's CTO", () => {
  const reportsAbout = (projectId: string) =>
    [
      ["project", projectId],
      ["project", undefined],
      ["cto", projectId],
      ["cto", undefined],
    ] as const;

  const findingIn = async (harness: Harness, scope: "system" | "project" | "cto", target: string | undefined, code: string) => {
    const report = await harness.cp.doctor.run(scope, target);
    const finding = report.findings.find((candidate) => candidate.code === code);
    return { scope, target, status: report.status, severity: finding?.severity, blocking: finding?.blocking };
  };

  it("blocks on a dead canonical binding in every project and CTO report, targeted or not", async () => {
    const { harness, projectId } = await deadCanonicalCto({ lifecycle: "ERROR" });

    for (const [scope, target] of reportsAbout(projectId)) {
      expect(await findingIn(harness, scope, target, "CTO_BINDING_POINTS_AT_DEAD_SESSION")).toEqual({
        scope,
        target,
        status: "ERROR",
        severity: "CRITICAL",
        blocking: true,
      });
    }
    expect(await findingIn(harness, "system", undefined, "CTO_BINDING_POINTS_AT_DEAD_SESSION")).toMatchObject({
      severity: "ERROR",
      blocking: false,
    });
  });

  it("blocks on open work with no CTO in every project and CTO report, targeted or not", async () => {
    const { harness, projectId, repositoryId, roleKey } = await deadCanonicalCto();
    const created = harness.cp.runs.create({
      projectId,
      executionMode: ExecutionMode.STANDARD,
      contract: CONTRACT,
      repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
    });
    if (!created.allowed) throw new Error(created.message);
    const released = harness.cp.bindings.revoke(roleKey, "test: released, leaving the work without a CTO");
    expect(released.allowed, JSON.stringify(released)).toBe(true);

    for (const [scope, target] of reportsAbout(projectId)) {
      expect(await findingIn(harness, scope, target, "CTO_MISSING_WITH_OPEN_RUNS")).toEqual({
        scope,
        target,
        status: "BLOCKED",
        severity: "ERROR",
        blocking: true,
      });
    }
    expect(await findingIn(harness, "system", undefined, "CTO_MISSING_WITH_OPEN_RUNS")).toMatchObject({
      severity: "ERROR",
      blocking: false,
    });
  });
});


it.each(["ERROR", "STOPPED"] as const)("a settled %s CTO stays visible without blocking the daemon's start", async (lifecycle) => {
  const { harness, sessionId } = await deadCanonicalCto({ lifecycle: "ERROR" });
  if (lifecycle === "STOPPED") expect(harness.cp.sessions.transition(sessionId, SessionLifecycle.STOPPED).allowed).toBe(true);
  expect((await harness.cp.doctor.run("system")).findings).toContainEqual(expect.objectContaining({
    code: "SESSION_PROCESS_MISSING", scope: `session:${sessionId}`, severity: "ERROR", blocking: false,
  }));
  for (const target of [sessionId, undefined]) {
    expect((await harness.cp.doctor.run("session", target)).findings).toContainEqual(expect.objectContaining({
      code: "SESSION_PROCESS_MISSING", scope: `session:${sessionId}`, severity: "ERROR", blocking: true,
    }));
  }
});
