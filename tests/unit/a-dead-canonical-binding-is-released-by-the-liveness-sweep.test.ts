import { spawnSync } from "node:child_process";

import { afterAll, describe, expect, it, vi } from "vitest";

import { DARWIN_START_TOKEN, readProcessStartToken } from "../../src/core/process-argv.ts";
import { Daemon } from "../../src/daemon/daemon.ts";
import {
  DEAD_BINDING_SWEEP_ACTOR,
  DEAD_CANONICAL_BINDING_RECOVERY_REASON_PREFIX,
} from "../../src/daemon/dead-binding-recovery.ts";
import { MessageKind } from "../../src/outbox/envelope.ts";
import { ExecutionMode, Role, RunState, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import type { TaskContract } from "../../src/run/run-engine.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { bindCeo, makeHarness, registerFixtureProject, type Harness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

const CONTRACT: TaskContract = {
  goal: "dead canonical binding release",
  why: "a dead holder must not keep the project's one window",
  scope: [],
  nonGoals: [],
  acceptance: ["verify.js exits 0"],
  priority: "NORMAL",
  humanGate: [],
  references: [],
};

/**
 * A pid that is definitely gone: `spawnSync` returns only after the child exited and was reaped,
 * so `kill(pid, 0)` answers ESRCH from here on. A literal high pid would be a guess.
 */
const deadPid = (): number => {
  const finished = spawnSync("/usr/bin/true", [], { stdio: "ignore", timeout: 30_000 });
  const pid = finished.pid;
  if (finished.signal !== null || typeof pid !== "number" || pid <= 0) {
    throw new Error("could not obtain a reaped child pid");
  }
  expect(() => process.kill(pid, 0)).toThrow();
  return pid;
};

/** This running test process's own start token, read the way the canonical self-claim records it. */
const ownStartToken = (): string => {
  const token = readProcessStartToken(process.pid);
  if (token === null || !DARWIN_START_TOKEN.test(token)) throw new Error("no native start token for this process");
  return token;
};

type Holder = "PRIMARY_CTO" | "CEO";

/** Records exactly this process pair on a session row, whatever the writer would have captured. */
const setProcess = (harness: Harness, sessionId: string, osPid: number | null, osStartedAt: string | null): void => {
  harness.cp.db.run(`UPDATE sessions SET os_pid = ?, os_process_started_at = ? WHERE session_id = ?`, [
    osPid,
    osStartedAt,
    sessionId,
  ]);
};

interface Fixture {
  harness: Harness;
  projectId: string;
  roleKey: string;
  sessionId: string;
  assignmentId: string;
  generation: number;
}

interface HolderOptions {
  role: Holder;
  osPid: number | null;
  osStartedAt?: string;
  /** Leave the session ERROR before the sweep runs, as an earlier pass or build would have. */
  settled?: boolean;
}

/**
 * One ACTIVE canonical binding on a session whose process is whatever the case says. The session
 * is READY unless `settled`, so the sweep is what discovers a dead pid — the production sequence.
 */
const holder = async (options: HolderOptions): Promise<Fixture> => {
  const harness = makeHarness();
  const { projectId } = await registerFixtureProject(harness);
  let sessionId: string;
  let roleKey: string;
  let assignmentId: string;
  let generation: number;
  if (options.role === "CEO") {
    sessionId = bindCeo(harness);
    setProcess(harness, sessionId, options.osPid, options.osStartedAt ?? null);
    const binding = harness.cp.bindings.require(roleKeyFor(Role.CEO));
    roleKey = binding.roleKey;
    assignmentId = binding.assignmentId;
    generation = binding.bindingGeneration;
  } else {
    const session = harness.cp.sessions.create({
      provider: "scripted",
      model: "scripted-cto",
      osPid: options.osPid,
      ...(options.osStartedAt === undefined ? {} : { osStartedAt: options.osStartedAt }),
    });
    const ready = harness.cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "test cto");
    if (!ready.allowed) throw new Error(ready.message);
    roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId });
    const bound = harness.cp.bindings.bind({ role: Role.PRIMARY_CTO, roleKey, projectId, sessionId: session.sessionId });
    if (!bound.allowed) throw new Error(bound.message);
    sessionId = session.sessionId;
    assignmentId = bound.value.assignmentId;
    generation = bound.value.bindingGeneration;
  }
  if (options.settled === true) {
    const errored = harness.cp.sessions.transition(sessionId, SessionLifecycle.ERROR, "test: settled earlier");
    if (!errored.allowed) throw new Error(errored.message);
  }
  return { harness, projectId, roleKey, sessionId, assignmentId, generation };
};

const reconcile = (fixture: Fixture) =>
  new Daemon(fixture.harness.cp, { stateDir: tempDir("acp-liveness-sweep-") }).reconcile();

const assignment = (fixture: Fixture) =>
  fixture.harness.cp.db.get<{ status: string; revoked_reason: string | null }>(
    `SELECT status, revoked_reason FROM assignments WHERE assignment_id = ?`,
    [fixture.assignmentId],
  );

const expectReleasedBySweep = (fixture: Fixture): void => {
  expect(fixture.harness.cp.bindings.active(fixture.roleKey)).toBeNull();
  expect(assignment(fixture)).toMatchObject({ status: "REVOKED" });
  expect(assignment(fixture)?.revoked_reason?.startsWith(DEAD_CANONICAL_BINDING_RECOVERY_REASON_PREFIX)).toBe(true);
  const recorded = fixture.harness.cp.audit.byKind("DEAD_BINDING_RECOVERED");
  expect(recorded).toHaveLength(1);
  expect(recorded[0]).toMatchObject({
    actor: DEAD_BINDING_SWEEP_ACTOR,
    roleKey: fixture.roleKey,
    sessionId: fixture.sessionId,
    evidence: { assignmentId: fixture.assignmentId, releasedGeneration: fixture.generation, liveness: "DEAD" },
  });
};

const expectUntouched = (fixture: Fixture): void => {
  expect(fixture.harness.cp.bindings.active(fixture.roleKey)?.assignmentId).toBe(fixture.assignmentId);
  expect(assignment(fixture)).toMatchObject({ status: "ACTIVE", revoked_reason: null });
  expect(fixture.harness.cp.audit.byKind("DEAD_BINDING_RECOVERED")).toHaveLength(0);
};

describe.each(["PRIMARY_CTO", "CEO"] as const)("the liveness sweep and a dead %s binding", (role) => {
  it("releases a binding whose process is gone, with no live runs and no operator call", async () => {
    const fixture = await holder({ role, osPid: deadPid() });

    const report = await reconcile(fixture);

    expect(report.sessionsMarkedError).toContain(fixture.sessionId);
    expectReleasedBySweep(fixture);
  });

  it("releases a binding whose session an earlier pass already left ERROR", async () => {
    const fixture = await holder({ role, osPid: deadPid(), settled: true });

    const report = await reconcile(fixture);

    expect(report.sessionsMarkedError).not.toContain(fixture.sessionId);
    expectReleasedBySweep(fixture);
  });

  it("releases a binding whose pid now belongs to another process (same pid, different start token)", async () => {
    // This test process is alive on that pid, and its real start token is not the recorded one.
    const fixture = await holder({ role, osPid: process.pid, osStartedAt: "darwin-tv:1.000001" });

    await reconcile(fixture);

    expectReleasedBySweep(fixture);
  });

  it("leaves the binding of a holder on a live pid with its own start token", async () => {
    const fixture = await holder({ role, osPid: process.pid, osStartedAt: ownStartToken() });

    const report = await reconcile(fixture);

    expect(report.sessionsMarkedError).not.toContain(fixture.sessionId);
    expectUntouched(fixture);
  });

  it("never releases an ERROR session whose liveness cannot be determined (no recorded pid)", async () => {
    const fixture = await holder({ role, osPid: null, settled: true });

    await reconcile(fixture);

    expectUntouched(fixture);
  });

  it("keeps a holder whose pid answers EPERM as ALIVE", async () => {
    const fixture = await holder({ role, osPid: 2147483646, settled: true });
    const realKill = process.kill.bind(process);
    const signal = vi.spyOn(process, "kill").mockImplementation((pid, sig) => {
      if (pid === 2147483646 && sig === 0) throw Object.assign(new Error("permission denied"), { code: "EPERM" });
      return realKill(pid, sig);
    });
    try {
      await reconcile(fixture);
    } finally {
      signal.mockRestore();
    }

    expectUntouched(fixture);
  });
});

describe("the sweep at a watchdog tick", () => {
  it("releases a canonical CTO that dies after start within one tick, with no operator call", async () => {
    // Alive at start, so the start's own reconcile releases nothing and only the periodic sweep can.
    const fixture = await holder({ role: "PRIMARY_CTO", osPid: process.pid, osStartedAt: ownStartToken() });
    fixture.harness.cp.credentials.install({ token: "test-token", creatorIdentity: "acme-bot" });
    bindCeo(fixture.harness);
    const daemon = new Daemon(fixture.harness.cp, { stateDir: tempDir("acp-liveness-tick-"), watchdogIntervalMs: 20 });
    try {
      const started = await daemon.start();
      expect(started.allowed, JSON.stringify(started)).toBe(true);
      expectUntouched(fixture);

      setProcess(fixture.harness, fixture.sessionId, deadPid(), null);
      await vi.waitFor(() => expect(fixture.harness.cp.bindings.active(fixture.roleKey)).toBeNull());
      expectReleasedBySweep(fixture);
    } finally {
      await daemon.stop();
    }
  });
});

describe("what a dead holder's release does to the role's queued mail", () => {
  it("keeps a queued CEO notification PENDING, and the next CEO holder is addressed it", async () => {
    const fixture = await holder({ role: "CEO", osPid: deadPid() });
    const { harness } = fixture;
    const queued = harness.cp.outbox.enqueue({
      idempotencyKey: "ceo-notification-across-the-sweep",
      roleKey: fixture.roleKey,
      targetSessionId: fixture.sessionId,
      bindingGeneration: fixture.generation,
      kind: MessageKind.CEO_NOTIFICATION,
      payload: { intent: "queued while the CEO was alive" },
    });
    if (!queued.allowed) throw new Error(queued.message);
    const row = () => harness.cp.db.get<{ status: string; binding_generation: number; target_session_id: string; reason_code: string | null }>(
      `SELECT status, binding_generation, target_session_id, reason_code FROM outbox WHERE message_id = ?`,
      [queued.value.messageId],
    );

    await reconcile(fixture);
    expectReleasedBySweep(fixture);
    expect(row()).toMatchObject({ status: "PENDING", binding_generation: fixture.generation, target_session_id: fixture.sessionId });

    const successor = bindCeo(harness);
    expect(harness.cp.bindings.require(fixture.roleKey).bindingGeneration).toBe(fixture.generation + 1);
    expect(row()).toMatchObject({ status: "PENDING", binding_generation: fixture.generation + 1, target_session_id: successor });
  });
});

describe("a release that throws", () => {
  it("does not block the other binding or reconcile(), is recorded once, and is retried on the next sweep", async () => {
    const fixture = await holder({ role: "PRIMARY_CTO", osPid: deadPid() });
    const { harness } = fixture;
    // The CTO is swept before the CEO, so a throw while releasing it is what could starve the CEO.
    const ceoSessionId = bindCeo(harness);
    setProcess(harness, ceoSessionId, deadPid(), null);
    const ceoRoleKey = roleKeyFor(Role.CEO);
    const ceo = harness.cp.bindings.require(ceoRoleKey);

    const record = harness.cp.audit.record.bind(harness.cp.audit);
    const audit = vi.spyOn(harness.cp.audit, "record").mockImplementation((event: Parameters<typeof record>[0]) => {
      if (event.kind === "DEAD_BINDING_RECOVERED" && event.roleKey === fixture.roleKey) {
        throw new Error("simulated storage failure while recording the CTO release");
      }
      return record(event);
    });
    const daemon = new Daemon(harness.cp, { stateDir: tempDir("acp-liveness-throw-") });
    try {
      await expect(daemon.reconcile()).resolves.toBeDefined();
      // A second sweep with the same failure writes no second record.
      await expect(daemon.reconcile()).resolves.toBeDefined();
    } finally {
      audit.mockRestore();
    }

    // The CTO release rolled back whole; the CEO's went through.
    expect(harness.cp.bindings.active(fixture.roleKey)?.assignmentId).toBe(fixture.assignmentId);
    expect(assignment(fixture)).toMatchObject({ status: "ACTIVE", revoked_reason: null });
    expect(harness.cp.audit.byKind("DEAD_BINDING_RECOVERED").map((event) => event.roleKey)).toEqual([ceoRoleKey]);
    expect(harness.cp.bindings.active(ceoRoleKey)).toBeNull();
    expect(harness.cp.db.get<{ status: string }>(`SELECT status FROM assignments WHERE assignment_id = ?`, [ceo.assignmentId])?.status)
      .toBe("REVOKED");
    expect(harness.cp.audit.byKind("DAEMON_TIMER_FAILED")).toMatchObject([
      { roleKey: fixture.roleKey, evidence: { timer: "liveness-sweep", role: fixture.roleKey, error: expect.stringContaining("simulated storage failure") } },
    ]);

    // The failure is gone: the next sweep releases it.
    await daemon.reconcile();
    expect(harness.cp.bindings.active(fixture.roleKey)).toBeNull();
    expect(assignment(fixture)).toMatchObject({ status: "REVOKED" });
    expect(harness.cp.audit.byKind("DEAD_BINDING_RECOVERED").map((event) => event.roleKey).sort())
      .toEqual([ceoRoleKey, fixture.roleKey].sort());
  });
});

describe("a dead holder that still owns a live run", () => {
  it("stays ACTIVE and the run is not moved by the sweep", async () => {
    const harness = makeHarness();
    const { projectId, repositoryId } = await registerFixtureProject(harness);
    const created = harness.cp.runs.create({
      projectId,
      executionMode: ExecutionMode.STANDARD,
      contract: CONTRACT,
      repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
    });
    if (!created.allowed) throw new Error(created.message);
    const dispatched = await harness.cp.runs.dispatch(created.value.runId);
    if (!dispatched.allowed) throw new Error(dispatched.message);
    const run = dispatched.value;
    const roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId });
    const binding = harness.cp.bindings.require(roleKey);
    expect(run.ownerSessionId).toBe(binding.boundSessionId);
    expect([RunState.COMPLETED, RunState.FAILED, RunState.CANCELLED]).not.toContain(run.state);
    setProcess(harness, binding.boundSessionId, deadPid(), null);
    const fixture: Fixture = {
      harness,
      projectId,
      roleKey,
      sessionId: binding.boundSessionId,
      assignmentId: binding.assignmentId,
      generation: binding.bindingGeneration,
    };
    const before = harness.cp.runs.require(run.runId);

    const report = await reconcile(fixture);

    expect(report.sessionsMarkedError).toContain(fixture.sessionId);
    expectUntouched(fixture);
    expect(harness.cp.runs.require(run.runId)).toEqual(before);
  });
});
