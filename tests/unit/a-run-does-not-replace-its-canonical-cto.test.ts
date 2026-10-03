import { spawnSync } from "node:child_process";

import { afterAll, describe, expect, it, vi } from "vitest";

import { digestOf, sha256 } from "../../src/core/digest.ts";
import { readProcessStartToken } from "../../src/core/process-argv.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { recoverDeadCanonicalBinding } from "../../src/daemon/dead-binding-recovery.ts";
import { ExecutionMode, Role, RunState, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { SELF_CLAIM_EXECUTOR_KIND, SELF_CLAIM_PROTOCOL } from "../../src/registry/canonical-self-claim.ts";
import type { TaskContract } from "../../src/run/run-engine.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { makeHarness, registerFixtureProject, type Harness } from "../helpers/harness.ts";
import { TestProductionAdapter } from "../helpers/production-adapter.ts";

afterAll(cleanupTempDirs);

/**
 * 2026-10-03 10:43:46Z, deployed 7f63ea3c: a QUEUED run's dispatch asked the claude provider adapter
 * whether an adopted canonical CTO's session was live. The adapter never launched that session, so
 * it answered UNAVAILABLE; the lifecycle wrote the canonical session ERROR and `recoveryTakeover`
 * spawned an "acting-cto-recovery" session and actor into the canonical role.
 *
 * Liveness here is the real syscall and the real start-token reader, as the operator's
 * dead-binding door takes them: this test's own process is the live canonical runtime, and a
 * recorded token that is not its token is the pid-reuse case the shared rule reads as DEAD.
 */

const CONVERSATION = "33333333-3333-4333-8333-333333333333";

const CONTRACT: TaskContract = {
  goal: "a run queued against a canonical CTO",
  why: "dispatch must not replace an adopted canonical CTO",
  scope: [],
  nonGoals: [],
  acceptance: ["tests pass"],
  priority: "NORMAL",
  humanGate: [],
  references: [],
};

const liveToken = (): string => {
  const token = readProcessStartToken(process.pid);
  if (token === null) throw new Error("this platform cannot read the test process's own start token");
  return token;
};

/** A pid that answered once and is gone now: a child that ran to completion and was reaped. */
const exitedPid = (): number => {
  const child = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore", timeout: 10_000 });
  if (typeof child.pid !== "number") throw new Error("could not start a child process");
  return child.pid;
};

const count = (h: Harness, table: "sessions" | "conversational_actors"): number =>
  h.cp.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)?.n ?? -1;

/**
 * A project whose PRIMARY_CTO is bound the way the canonical self-claim binds one: a `claude` /
 * `claude-cli` runtime row with its pid and start token, and an actor whose lifetime target is a
 * `SELF_CLAIM_EXECUTOR_KIND` conversation. The `claude` adapter registered beside it is the one
 * the deployed daemon asked; it launched nothing here, so it answers UNAVAILABLE for this session.
 */
const canonicalProject = async (recorded: { osPid: number | null; startedAt: string | null }) => {
  const h = makeHarness();
  const { projectId, repositoryId } = await registerFixtureProject(h);
  const claude = new TestProductionAdapter(h.clock, "claude");
  h.cp.providers.register(claude);

  const session = h.cp.sessions.create({
    provider: "claude",
    model: "claude-cli",
    osPid: recorded.osPid,
    osStartedAt: recorded.startedAt,
  });
  expect(h.cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "canonical self-claim").allowed).toBe(true);
  const claimed = {
    executorKind: SELF_CLAIM_EXECUTOR_KIND,
    targetLocator: CONVERSATION,
    targetLocatorDigest: sha256(CONVERSATION),
  };
  const bound = h.cp.bindings.bind({
    role: Role.PRIMARY_CTO,
    projectId,
    sessionId: session.sessionId,
    mode: "PREFERRED",
    authenticatedTarget: {
      claimed,
      protocolVersion: SELF_CLAIM_PROTOCOL,
      attestationDigest: digestOf({ fixture: "canonical-cto-dispatch", sessionId: session.sessionId }),
      verify: () => claimed,
    },
  });
  if (!bound.allowed) throw new Error(bound.message);

  const run = h.cp.runs.create({
    projectId,
    executionMode: ExecutionMode.STANDARD,
    contract: CONTRACT,
    repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
  });
  if (!run.allowed) throw new Error(run.message);

  return {
    h,
    projectId,
    roleKey: roleKeyFor(Role.PRIMARY_CTO, { projectId }),
    sessionId: session.sessionId,
    binding: bound.value,
    runId: run.value.runId,
    sessions: count(h, "sessions"),
    actors: count(h, "conversational_actors"),
    sessionsCreated: h.cp.audit.byKind("SESSION_CREATED").length,
    claudeProbe: vi.spyOn(claude, "probeSession"),
    spawned: vi.spyOn(h.scripted, "startSession"),
  };
};

type Canonical = Awaited<ReturnType<typeof canonicalProject>>;

/** Nothing was created and the canonical binding still holds the role, at its own generation. */
const expectNothingReplaced = (f: Canonical): void => {
  expect(count(f.h, "sessions")).toBe(f.sessions);
  expect(count(f.h, "conversational_actors")).toBe(f.actors);
  expect(f.h.cp.audit.byKind("SESSION_CREATED")).toHaveLength(f.sessionsCreated);
  expect(f.h.cp.audit.byKind("RECOVERY_TAKEOVER")).toHaveLength(0);
  expect(f.spawned).not.toHaveBeenCalled();
  expect(f.claudeProbe).not.toHaveBeenCalled();
  const held = f.h.cp.bindings.require(f.roleKey);
  expect(held.assignmentId).toBe(f.binding.assignmentId);
  expect(held.sessionId).toBe(f.sessionId);
  expect(held.bindingGeneration).toBe(f.binding.bindingGeneration);
};

describe("a run's dispatch does not replace its adopted canonical CTO", () => {
  it("(a) reuses a READY canonical CTO whose recorded process is running, without asking the adapter", async () => {
    const f = await canonicalProject({ osPid: process.pid, startedAt: liveToken() });
    try {
      const ensured = await f.h.cp.cto.ensurePrimaryCto(f.projectId, f.runId);

      expect(ensured).toMatchObject({ allowed: true, reasonCode: ReasonCode.OK });
      if (ensured.allowed) expect(ensured.value.assignmentId).toBe(f.binding.assignmentId);
      expectNothingReplaced(f);
      expect(f.h.cp.sessions.require(f.sessionId).lifecycle).toBe(SessionLifecycle.READY);
      expect(f.h.cp.audit.byKind("CTO_SESSION_PROBE_FAILED")).toHaveLength(0);
      expect(f.h.cp.audit.byKind("CTO_DISPATCH_REFUSED_CANONICAL")).toHaveLength(0);
    } finally {
      f.h.cp.close();
    }
  });

  it.each([
    ["has exited", () => ({ osPid: exitedPid(), startedAt: "darwin-tv:1790000100.000001" })],
    ["was replaced by another process on its pid", () => ({ osPid: process.pid, startedAt: "darwin-tv:1.000001" })],
  ])("(b) refuses the dispatch when the canonical CTO's recorded process %s, and spawns nothing", async (_shape, recorded) => {
    const f = await canonicalProject(recorded());
    try {
      const dispatched = await f.h.cp.runs.dispatch(f.runId);

      expect(dispatched).toMatchObject({ allowed: false, reasonCode: ReasonCode.CANONICAL_CTO_AWAITING_RECLAIM });
      expect(f.h.cp.runs.require(f.runId).state).toBe(RunState.QUEUED);
      expectNothingReplaced(f);
      // No lifecycle write on DEAD: the row is left for the claim and the reconcile to settle.
      expect(f.h.cp.sessions.require(f.sessionId).lifecycle).toBe(SessionLifecycle.READY);
      expect(f.h.cp.audit.byKind("CTO_SESSION_PROBE_FAILED")).toHaveLength(0);
      const refused = f.h.cp.audit.byKind("CTO_DISPATCH_REFUSED_CANONICAL");
      expect(refused).toHaveLength(1);
      expect(refused[0]?.reasonCode).toBe(ReasonCode.CANONICAL_CTO_AWAITING_RECLAIM);
    } finally {
      f.h.cp.close();
    }
  });

  it("(c) refuses the dispatch, and a direct recovery takeover, when the canonical session is already ERROR", async () => {
    const f = await canonicalProject({ osPid: process.pid, startedAt: liveToken() });
    try {
      expect(f.h.cp.sessions.transition(f.sessionId, SessionLifecycle.ERROR, "an earlier misread").allowed).toBe(true);

      const dispatched = await f.h.cp.runs.dispatch(f.runId);
      expect(dispatched).toMatchObject({ allowed: false, reasonCode: ReasonCode.CANONICAL_CTO_AWAITING_RECLAIM });
      expect(f.h.cp.runs.require(f.runId).state).toBe(RunState.QUEUED);

      const takeover = await f.h.cp.cto.recoveryTakeover(f.projectId, "operator asked for a takeover", f.runId);
      expect(takeover).toMatchObject({ allowed: false, reasonCode: ReasonCode.CANONICAL_CTO_AWAITING_RECLAIM });

      expectNothingReplaced(f);
      expect(f.h.cp.sessions.require(f.sessionId).lifecycle).toBe(SessionLifecycle.ERROR);
      expect(f.h.cp.runs.require(f.runId).state).toBe(RunState.QUEUED);
    } finally {
      f.h.cp.close();
    }
  });

  it("refuses as retryable, writing no state, when the recorded start token is missing", async () => {
    const f = await canonicalProject({ osPid: process.pid, startedAt: null });
    try {
      const dispatched = await f.h.cp.runs.dispatch(f.runId);

      expect(dispatched).toMatchObject({ allowed: false, reasonCode: ReasonCode.PROBE_FAILED });
      expect(dispatched.allowed ? null : dispatched.evidence).toMatchObject({ liveness: "UNKNOWN" });
      expect(f.h.cp.runs.require(f.runId).state).toBe(RunState.QUEUED);
      expect(f.h.cp.sessions.require(f.sessionId).lifecycle).toBe(SessionLifecycle.READY);
      expectNothingReplaced(f);
    } finally {
      f.h.cp.close();
    }
  });

  const pidOneRefusesSignal = (): boolean => {
    try {
      process.kill(1, 0);
      return false;
    } catch (error) {
      return (error as { code?: unknown }).code === "EPERM";
    }
  };

  it.runIf(pidOneRefusesSignal())("refuses as retryable when the recorded pid cannot be signalled (EPERM)", async () => {
    const f = await canonicalProject({ osPid: 1, startedAt: "darwin-tv:1.000001" });
    try {
      const dispatched = await f.h.cp.runs.dispatch(f.runId);

      expect(dispatched).toMatchObject({ allowed: false, reasonCode: ReasonCode.PROBE_FAILED });
      expect(dispatched.allowed ? null : dispatched.evidence).toMatchObject({ liveness: "EPERM" });
      expect(f.h.cp.runs.require(f.runId).state).toBe(RunState.QUEUED);
      expect(f.h.cp.sessions.require(f.sessionId).lifecycle).toBe(SessionLifecycle.READY);
      expectNothingReplaced(f);
    } finally {
      f.h.cp.close();
    }
  });

  it("refuses the dispatch, and a direct recovery takeover, for a canonical role whose binding was released", async () => {
    const f = await canonicalProject({ osPid: exitedPid(), startedAt: "darwin-tv:1790000100.000001" });
    try {
      // The operator's dead-binding door: the canonical process is gone, so the role is released
      // and nothing holds it until that conversation claims it again.
      const released = recoverDeadCanonicalBinding("operator", {
        projectId: f.projectId,
        role: Role.PRIMARY_CTO,
        sessionId: f.sessionId,
        sessionIncarnation: f.h.cp.sessions.require(f.sessionId).incarnation,
        expectedBindingGeneration: f.binding.bindingGeneration,
      }, { db: f.h.cp.db, audit: f.h.cp.audit, sessions: f.h.cp.sessions, bindings: f.h.cp.bindings });
      expect(released.allowed).toBe(true);
      expect(f.h.cp.bindings.active(f.roleKey)).toBeNull();
      const assignments = (): number =>
        f.h.cp.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM assignments WHERE role_key = ?`, [f.roleKey])?.n ?? -1;
      const before = assignments();

      const dispatched = await f.h.cp.runs.dispatch(f.runId);
      expect(dispatched).toMatchObject({ allowed: false, reasonCode: ReasonCode.CANONICAL_CTO_AWAITING_RECLAIM });
      const refused = f.h.cp.audit.byKind("CTO_DISPATCH_REFUSED_CANONICAL");
      expect(refused).toHaveLength(1);
      expect(refused[0]?.reasonCode).toBe(ReasonCode.CANONICAL_CTO_AWAITING_RECLAIM);
      expect(dispatched.allowed ? null : dispatched.evidence).toMatchObject({ liveness: null, assignmentStatus: "REVOKED" });

      const takeover = await f.h.cp.cto.recoveryTakeover(f.projectId, "operator asked for a takeover", f.runId);
      expect(takeover).toMatchObject({ allowed: false, reasonCode: ReasonCode.CANONICAL_CTO_AWAITING_RECLAIM });

      expect(f.h.cp.runs.require(f.runId).state).toBe(RunState.QUEUED);
      expect(assignments()).toBe(before);
      expect(f.h.cp.bindings.active(f.roleKey)).toBeNull();
      expect(count(f.h, "sessions")).toBe(f.sessions);
      expect(count(f.h, "conversational_actors")).toBe(f.actors);
      expect(f.h.cp.audit.byKind("SESSION_CREATED")).toHaveLength(f.sessionsCreated);
      expect(f.h.cp.audit.byKind("RECOVERY_TAKEOVER")).toHaveLength(0);
      expect(f.spawned).not.toHaveBeenCalled();
    } finally {
      f.h.cp.close();
    }
  });

  it("control: a role never assigned, or last held by a non-canonical CTO, is still given a spawned CTO", async () => {
    const h = makeHarness();
    try {
      const { projectId } = await registerFixtureProject(h);
      const roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId });
      expect(h.cp.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM assignments WHERE role_key = ?`, [roleKey])?.n).toBe(0);

      const first = await h.cp.cto.ensurePrimaryCto(projectId, "first CTO");
      expect(first.allowed).toBe(true);
      if (!first.allowed) return;
      expect(h.cp.audit.byKind("SESSION_CREATED")).toHaveLength(1);
      expect(h.cp.audit.byKind("PRIMARY_CTO_ACTIVATED")).toHaveLength(1);

      expect(h.cp.bindings.revoke(roleKey, "released for the control").allowed).toBe(true);
      const second = await h.cp.cto.ensurePrimaryCto(projectId, "after a non-canonical release");
      expect(second.allowed).toBe(true);
      if (!second.allowed) return;
      expect(second.value.sessionId).not.toBe(first.value.sessionId);
      expect(h.cp.audit.byKind("SESSION_CREATED")).toHaveLength(2);
      expect(h.cp.audit.byKind("CTO_DISPATCH_REFUSED_CANONICAL")).toHaveLength(0);
    } finally {
      h.cp.close();
    }
  });

  it("(d) control: an adapter-launched CTO whose provider disowns it is still recovered by takeover", async () => {
    const h = makeHarness();
    try {
      const { projectId } = await registerFixtureProject(h);
      const first = await h.cp.cto.ensurePrimaryCto(projectId, "setup");
      if (!first.allowed) throw new Error(first.message);
      const before = count(h, "sessions");
      // The bound session's probe fails once; the replacement's own launch probe answers normally.
      vi.spyOn(h.scripted, "probeSession").mockResolvedValueOnce("UNAVAILABLE");

      const ensured = await h.cp.cto.ensurePrimaryCto(projectId, "a run");

      expect(ensured.allowed).toBe(true);
      if (!ensured.allowed) return;
      expect(ensured.value.sessionId).not.toBe(first.value.sessionId);
      expect(ensured.value.bindingGeneration).toBeGreaterThan(first.value.bindingGeneration);
      expect(h.cp.audit.byKind("CTO_SESSION_PROBE_FAILED")).toHaveLength(1);
      expect(h.cp.audit.byKind("RECOVERY_TAKEOVER")).toHaveLength(1);
      expect(h.cp.audit.byKind("CTO_DISPATCH_REFUSED_CANONICAL")).toHaveLength(0);
      expect(h.cp.sessions.require(first.value.sessionId).lifecycle).toBe(SessionLifecycle.ERROR);
      expect(count(h, "sessions")).toBe(before + 1);
    } finally {
      h.cp.close();
    }
  });
});
