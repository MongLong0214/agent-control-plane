import { afterAll, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { type HandoffAcknowledgement, type HandoffPackage } from "../../src/cto/cto-lifecycle.ts";
import { digestOf } from "../../src/core/digest.ts";
import { allow, deny } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { DrainingCause, ExecutionMode, Role, RunState, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import type { DoctorReport } from "../../src/doctor/doctor.ts";
import { cleanupTempDirs, commitAll, makeRepo, writeFiles } from "../helpers/fixtures.ts";
import {
  TEST_OWNER,
  type Harness,
  bindCeo,
  driveToReviewedCandidate,
  finalizeNoRepositoryRun,
  fixtureManifest,
  makeHarness,
  manifestAuthorizationForRun,
  registerFixtureProject,
} from "../helpers/harness.ts";
import type { TaskContract } from "../../src/run/run-engine.ts";

const deadSessionFinding = (report: DoctorReport) =>
  report.findings.find((f) => f.code === "CTO_BINDING_POINTS_AT_DEAD_SESSION");

afterAll(cleanupTempDirs);

const CONTRACT: TaskContract = {
  goal: "review regression",
  why: "prove the registry and CTO boundary",
  scope: [],
  nonGoals: [],
  acceptance: ["test passes"],
  priority: "NORMAL",
  humanGate: [],
  references: [],
};

const HANDOFF: HandoffPackage = {
  projectStatus: "ACTIVE/HEALTHY",
  activeManifestDigest: null,
  recentDecisions: [],
  openBlockers: [],
  queuedWork: [],
  repositoryFacts: [],
  knownRisks: [],
  recommendedNextAction: "continue",
};

const createActiveRun = async (harness: Harness, projectId: string, repositoryId: string) => {
  const created = harness.cp.runs.create({
    projectId,
    executionMode: ExecutionMode.STANDARD,
    contract: CONTRACT,
    repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
  });
  if (!created.allowed) throw new Error(created.message);
  const dispatched = await harness.cp.runs.dispatch(created.value.runId);
  if (!dispatched.allowed) throw new Error(dispatched.message);
  return dispatched.value;
};

const authenticateHandoffsForTest = (harness: Harness): void => {
  harness.cp.cto.attach({
    handoffAuthentication: {
      verifyHandoffAcknowledgement: (ack) =>
        ack.sessionSecret === "test-session-secret"
          ? allow(ReasonCode.OK, undefined)
          : deny(ReasonCode.HANDOFF_ACK_AUTHENTICATION_FAILED, "test credential rejected"),
    },
  });
};

const deliveredAck = (
  harness: Harness,
  handoffId: string,
  incomingSessionId: string,
): HandoffAcknowledgement => {
  const message = harness.cp.outbox.byIdempotencyKey(`handoff:${handoffId}`);
  if (!message) throw new Error("handoff message was not persisted");
  harness.cp.db.run(`UPDATE outbox SET status = 'SENT' WHERE message_id = ?`, [message.messageId]);
  return {
    sessionId: incomingSessionId,
    sessionIncarnation: harness.cp.sessions.require(incomingSessionId).incarnation,
    bindingGeneration: message.bindingGeneration,
    messageId: message.messageId,
    payloadDigest: message.payloadDigest,
    sessionSecret: "test-session-secret",
  };
};

const completeContractChangeWithGrant = async (
  harness: Harness,
  projectId: string,
  manifestDigest: string,
) => {
  const finalized = await finalizeNoRepositoryRun(harness, projectId, CONTRACT);
  const { runId, candidateSnapshotDigest } = finalized;

  const grant = {
    schema: "acp.manifest-activation-grant.v1",
    projectId,
    runId,
    runKind: "CONTRACT_CHANGE",
    manifestDigest,
    candidateSnapshotDigest,
  };
  harness.cp.db.run(
    `INSERT INTO run_artifacts (artifact_id, run_id, kind, digest, candidate_snapshot_digest,
                                content_json, produced_by, created_at)
     VALUES (?, ?, 'APPROVAL', ?, ?, ?, 'production-gate', ?)`,
    [
      `art_manifest_${runId.slice(-12)}`,
      runId,
      digestOf(grant),
      candidateSnapshotDigest,
      JSON.stringify(grant),
      harness.clock.nowIso(),
    ],
  );
  return runId;
};

describe("round-2 CTO lifecycle regressions", () => {
  it("handoff P1-06 provisions the CTO in the managed runtime root and persists it", async () => {
    const harness = makeHarness();
    const { projectId } = await registerFixtureProject(harness);
    const bound = await harness.cp.cto.ensurePrimaryCto(projectId, "managed runtime test");
    if (!bound.allowed) throw new Error(bound.message);

    const session = harness.cp.sessions.require(bound.value.sessionId);
    expect(session.workdir).toBe(join(harness.root, "runtime", "provider-returned-workdir"));
    expect(session.workdir).not.toBe(process.cwd());
  });

  it("P1-06 refuses to persist a workdir the adapter reports outside the managed root", async () => {
    // The test above proves the *returned* value is persisted rather than the request echo,
    // but its adapter returns a path under the managed root, so it says nothing about a
    // provider that reports somewhere else. `sessions_workdir_immutable` is BEFORE UPDATE:
    // whatever lands here can never be corrected, so an adapter echoing its own cwd would pin
    // the session to it permanently.
    const harness = makeHarness();
    const escaped = process.cwd();
    const original = harness.scripted.startSession.bind(harness.scripted);
    harness.scripted.startSession = async (spec) => ({ ...(await original(spec)), workdir: escaped });

    const { projectId } = await registerFixtureProject(harness);
    const bound = await harness.cp.cto.ensurePrimaryCto(projectId, "escaping adapter workdir");
    if (!bound.allowed) throw new Error(bound.message);

    const session = harness.cp.sessions.require(bound.value.sessionId);
    expect(session.workdir).not.toBe(escaped);
    expect(session.workdir).toBe(join(harness.root, "runtime"));
  });

  it("#147 refuses an incomplete handoff without leaving the healthy CTO draining", async () => {
    const harness = makeHarness();
    const { projectId } = await registerFixtureProject(harness);
    const bound = await harness.cp.cto.ensurePrimaryCto(projectId, "setup");
    if (!bound.allowed) throw new Error(bound.message);

    const refused = await harness.cp.cto.prepareSwitchover(projectId, {
      ...HANDOFF,
      recommendedNextAction: "",
    });
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.HANDOFF_PACKAGE_INCOMPLETE);
    expect(harness.cp.sessions.require(bound.value.sessionId).lifecycle).toBe(SessionLifecycle.READY);
  });

  it("#148 refuses a handoff ACK that knows only the incoming session id", async () => {
    const harness = makeHarness();
    const { projectId } = await registerFixtureProject(harness);
    await harness.cp.cto.ensurePrimaryCto(projectId, "setup");
    const prepared = await harness.cp.cto.prepareSwitchover(projectId, HANDOFF);
    if (!prepared.allowed) throw new Error(prepared.message);

    const refused = harness.cp.cto.acknowledgeHandoff(
      prepared.value.handoffId,
      prepared.value.incomingSessionId,
    );
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.HANDOFF_ACK_AUTHENTICATION_FAILED);
  });

  it("#149 refuses emergency takeover while the original CTO is merely draining", async () => {
    const harness = makeHarness();
    const { projectId } = await registerFixtureProject(harness);
    await harness.cp.cto.ensurePrimaryCto(projectId, "setup");
    expect(harness.cp.cto.requestReplacement(projectId, "normal replacement").allowed).toBe(true);

    const refused = await harness.cp.cto.recoveryTakeover(projectId, "attempt bypass of normal handoff");
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.RECOVERY_TAKEOVER_REQUIRES_UNREACHABLE_OWNER);
  });

  it("#150 checkpoints active runs before revoking the suspended CTO binding", async () => {
    const harness = makeHarness();
    const { projectId, repositoryId } = await registerFixtureProject(harness);
    const run = await createActiveRun(harness, projectId, repositoryId);

    const suspended = await harness.cp.cto.suspendProject(projectId, true, "capacity crisis", TEST_OWNER);
    expect(suspended.allowed).toBe(true);
    expect(harness.cp.runs.require(run.runId).state).toBe(RunState.BLOCKED);
    expect(harness.cp.cto.latestHandoff(projectId)?.status).toBe("PENDING");
    expect(harness.cp.bindings.activePrimaryCto(projectId)).toBeNull();
  });

  it("#151 reports provider stop failure and keeps the binding instead of claiming a clean suspension", async () => {
    const harness = makeHarness();
    const { projectId, repositoryId } = await registerFixtureProject(harness);
    await createActiveRun(harness, projectId, repositoryId);
    harness.scripted.stopSession = async () => {
      throw new Error("runtime still alive");
    };

    const refused = await harness.cp.cto.suspendProject(projectId, true, "capacity crisis", TEST_OWNER);
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.SESSION_STOP_FAILED);
    expect(harness.cp.bindings.activePrimaryCto(projectId)).not.toBeNull();
    expect(harness.cp.sessions.require(harness.cp.bindings.activePrimaryCto(projectId)!.sessionId).lifecycle).toBe(
      SessionLifecycle.ERROR,
    );
  });

  it(
    "#692 the preflight refuses an ordinary non-race blocker before the irreversible " +
      "provider stop, never calling it at all",
    async () => {
      // A run reaching CEO review through the real evidence pipeline is owned by the CTO
      // binding and sits in READY_FOR_CEO_REVIEW — a state suspendProject's checkpoint
      // loop never touches (it only moves ACTIVE runs to BLOCKED). Without the preflight,
      // this refusal would only surface from bindings.revoke() *after* the provider had
      // already been told to stop; with it, the irreversible call never happens.
      const harness = makeHarness();
      const driven = await driveToReviewedCandidate(harness);
      await harness.cp.continuity.evaluate("test");
      const packet = harness.cp.ceo.buildPacket({
        runId: driven.runId,
        candidateSnapshotDigest: driven.candidateSnapshotDigest,
        approval: {
          runId: driven.runId,
          candidateSnapshotDigest: driven.candidateSnapshotDigest,
          resultSummary: "done",
          recommendation: "merge",
          residualRisk: [],
          approvedBySessionId: driven.ownerSessionId,
          approvedByGeneration: driven.ownerBindingGeneration,
          approvedAt: harness.clock.nowIso(),
        },
      });
      if (!packet.allowed) throw new Error(`${packet.reasonCode}: ${packet.message}`);
      expect(harness.cp.runs.require(driven.runId).state).toBe(RunState.READY_FOR_CEO_REVIEW);

      const binding = harness.cp.bindings.activePrimaryCto(driven.projectId)!;
      const lifecycleBefore = harness.cp.sessions.require(binding.sessionId).lifecycle;
      const stopSession = vi.spyOn(harness.scripted, "stopSession");

      const suspended = await harness.cp.cto.suspendProject(
        driven.projectId,
        true,
        "capacity crisis",
        TEST_OWNER,
      );

      expect(suspended.allowed).toBe(false);
      expect(suspended.reasonCode).toBe(ReasonCode.REVOCATION_BLOCKED_ACTIVE_RUNS);
      expect(stopSession).not.toHaveBeenCalled();
      // The preflight now runs *inside* the same txDecision as the suspended flag, the
      // recovery insert and the DRAINING transition, so a refusal here rolls all of them
      // back — the session never moves to DRAINING at all, not "moves there but it's
      // fine because it's reversible": there is nothing left to reverse. Assert the
      // lifecycle is byte-for-byte unchanged, not merely "not STOPPED" — that weaker
      // assertion is exactly what let a real DRAINING-forever regression pass here once.
      expect(harness.cp.sessions.require(binding.sessionId).lifecycle).toBe(lifecycleBefore);
      expect(harness.cp.sessions.require(binding.sessionId).lifecycle).not.toBe(SessionLifecycle.DRAINING);
      expect(harness.cp.bindings.activePrimaryCto(driven.projectId)?.sessionId).toBe(binding.sessionId);

      // The refused suspend left nothing to undo — dispatch must actually work, not
      // merely report a lifecycle value that looks fine. A second run against the same
      // project reuses the same untouched binding without needing resumeProject at all.
      const secondRun = harness.cp.runs.create({
        projectId: driven.projectId,
        executionMode: ExecutionMode.STANDARD,
        contract: CONTRACT,
        repositories: [{ repositoryId: driven.repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
      });
      if (!secondRun.allowed) throw new Error(secondRun.message);
      const dispatched = await harness.cp.runs.dispatch(secondRun.value.runId);
      expect(dispatched.allowed).toBe(true);
      expect(harness.cp.bindings.activePrimaryCto(driven.projectId)?.sessionId).toBe(binding.sessionId);
    },
  );

  it(
    "#692 resumeProject clears a session stuck in DRAINING, not just the suspended flag",
    async () => {
      // `DRAINING -> READY` is legal in the FSM (session-registry.ts LEGAL_LIFECYCLE)
      // precisely so a suspend that committed DRAINING but never reached STOPPED (a
      // crash between the two transactions, or any other reason the runtime stop never
      // finished) has somewhere to go back to. This drives the session there directly,
      // the same way a crash mid-suspend would leave it, rather than depending on timing
      // a real stopSession() await — the FSM transition is the actual mechanism under
      // test, not the race that can produce it.
      const harness = makeHarness();
      const { projectId, repositoryId } = await registerFixtureProject(harness);
      await createActiveRun(harness, projectId, repositoryId);
      const binding = harness.cp.bindings.activePrimaryCto(projectId)!;
      expect(harness.cp.sessions.require(binding.sessionId).lifecycle).toBe(SessionLifecycle.READY);

      // #692 round 2 — resumeProject now keys on *why* the session is draining, not just that
      // it is (domain/types.ts DrainingCause). The real suspendProject records SUSPEND
      // atomically with this same transition; the simulation has to carry it too, or it stops
      // simulating what a crashed suspend actually leaves behind and starts simulating an
      // unrelated (and now correctly refused) DRAINING-for-unknown-reason state instead.
      const drained = harness.cp.sessions.transition(
        binding.sessionId,
        SessionLifecycle.DRAINING,
        "test: simulate a suspend that committed DRAINING but never reached STOPPED",
        DrainingCause.SUSPEND,
      );
      expect(drained.allowed).toBe(true);

      const resumed = harness.cp.cto.resumeProject(projectId);
      expect(resumed.allowed).toBe(true);
      expect(harness.cp.sessions.require(binding.sessionId).lifecycle).toBe(SessionLifecycle.READY);

      // Dispatch must actually succeed now, not just report a lifecycle value: before
      // this fix, resumeProject cleared only `projects.suspended` and ensurePrimaryCto
      // kept refusing with RUN_DISPATCH_BLOCKED_CTO_DRAINING regardless, wedging the
      // project's dispatch permanently.
      const run = harness.cp.runs.create({
        projectId,
        executionMode: ExecutionMode.STANDARD,
        contract: CONTRACT,
        repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
      });
      if (!run.allowed) throw new Error(run.message);
      const dispatched = await harness.cp.runs.dispatch(run.value.runId);
      expect(dispatched.allowed).toBe(true);
      expect(harness.cp.bindings.activePrimaryCto(projectId)?.sessionId).toBe(binding.sessionId);
    },
  );

  it(
    "#692 round 3 — resumeProject must not reverse a suspend whose stopSession() is " +
      "still in flight, and a run must not dispatch in that window",
    async () => {
      // Unlike the test above, this drives the interleaving through the *real*
      // suspendProject/resumeProject methods rather than assembling the DRAINING state by
      // hand — round 3's review found that hand-assembly cannot distinguish "a suspend
      // whose stopSession() await is still pending" from "a crash that left DRAINING
      // behind", which is exactly the gap this test closes.
      const harness = makeHarness();
      const { projectId, repositoryId } = await registerFixtureProject(harness);
      await createActiveRun(harness, projectId, repositoryId);
      const binding = harness.cp.bindings.activePrimaryCto(projectId)!;
      expect(harness.cp.sessions.require(binding.sessionId).lifecycle).toBe(SessionLifecycle.READY);

      // A second, still-QUEUED run: dispatch's two blocking conditions (project.suspended,
      // CTO draining) are exactly what a same-window resumeProject would clear.
      const queuedRun = harness.cp.runs.create({
        projectId,
        executionMode: ExecutionMode.STANDARD,
        contract: CONTRACT,
        repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
      });
      if (!queuedRun.allowed) throw new Error(queuedRun.message);

      let resumeDuringWindow: ReturnType<typeof harness.cp.cto.resumeProject> | undefined;
      let dispatchDuringWindow: Awaited<ReturnType<typeof harness.cp.runs.dispatch>> | undefined;
      const originalStop = harness.scripted.stopSession.bind(harness.scripted);
      harness.scripted.stopSession = async (handle) => {
        // suspendProject has already committed suspended=true and DRAINING/SUSPEND by the
        // time this runs (it only awaits the provider stop after that commit) — the exact
        // window sol's review named.
        resumeDuringWindow = harness.cp.cto.resumeProject(projectId);
        dispatchDuringWindow = await harness.cp.runs.dispatch(queuedRun.value.runId);
        return originalStop(handle);
      };

      const suspended = await harness.cp.cto.suspendProject(projectId, true, "capacity crisis", TEST_OWNER);

      expect(resumeDuringWindow?.allowed).toBe(false);
      expect(resumeDuringWindow?.reasonCode).toBe(ReasonCode.RESUME_BLOCKED_SUSPEND_IN_FLIGHT);
      expect(dispatchDuringWindow?.allowed).toBe(false);
      // The suspend itself is unaffected by the window closing around it and completes normally.
      expect(suspended.allowed).toBe(true);
      expect(harness.cp.sessions.require(binding.sessionId).lifecycle).toBe(SessionLifecycle.STOPPED);
      expect(harness.cp.projects.get(projectId)?.suspended).toBe(true);
      expect(harness.cp.runs.require(queuedRun.value.runId).state).toBe(RunState.QUEUED);
    },
  );

  it(
    "#692 round 3 — a fence stamped by a process that no longer exists self-heals to " +
      "ERROR instead of resuming as if the suspend had cleanly never happened",
    async () => {
      // A crash mid-suspend leaves exactly this shape behind: DRAINING/SUSPEND committed,
      // draining_stop_pid stamped, and the process that stamped it gone. `spawnSync` blocks
      // until its child has exited, so its pid is dead by the time this reads it back —
      // deterministic, not a race, and the same tolerance for pid reuse daemon.ts's own
      // startup reconcile() already accepts for `os_pid` (see the pid comment on `isAlive`
      // in cto-lifecycle.ts).
      const harness = makeHarness();
      const { projectId, repositoryId } = await registerFixtureProject(harness);
      await createActiveRun(harness, projectId, repositoryId);
      const binding = harness.cp.bindings.activePrimaryCto(projectId)!;

      const deadPid = spawnSync(process.execPath, ["-e", "process.exit(0)"]).pid!;
      expect(deadPid).toBeGreaterThan(0);

      const drained = harness.cp.sessions.transition(
        binding.sessionId,
        SessionLifecycle.DRAINING,
        "test: simulate a crash between suspendProject's commit and its stopSession() call",
        DrainingCause.SUSPEND,
        deadPid,
      );
      expect(drained.allowed).toBe(true);
      expect(harness.cp.sessions.require(binding.sessionId).drainingStopPid).toBe(deadPid);

      const resumed = harness.cp.cto.resumeProject(projectId);

      expect(resumed.allowed).toBe(true);
      // Self-heals to ERROR, not READY: whether the crashed process's stopSession() call
      // ever reached the provider is unknown, so this does not resume as if it hadn't.
      expect(harness.cp.sessions.require(binding.sessionId).lifecycle).toBe(SessionLifecycle.ERROR);
      expect(harness.cp.projects.get(projectId)?.suspended).toBe(false);

      // A fresh CTO spawns on the next dispatch, exactly like any other dead binding.
      const run = harness.cp.runs.create({
        projectId,
        executionMode: ExecutionMode.STANDARD,
        contract: CONTRACT,
        repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
      });
      if (!run.allowed) throw new Error(run.message);
      const dispatched = await harness.cp.runs.dispatch(run.value.runId);
      expect(dispatched.allowed).toBe(true);
    },
  );

  it(
    "#692 round 2 — resumeProject does not reverse a replacement's DRAINING, and its " +
      "DRAIN_REQUEST still governs new dispatch",
    async () => {
      // The exact counter-example the second blind review found: requestReplacement (an
      // ordinary replacement, not a suspend) puts the session into DRAINING and leaves a
      // DRAIN_REQUEST outstanding (cto-lifecycle.ts requestReplacement). The previous fix
      // to resumeProject reversed *any* DRAINING session, so calling it here returned the
      // outgoing CTO to READY with that DRAIN_REQUEST still sitting in the outbox — nothing
      // about the replacement had actually happened, but new work could dispatch again,
      // breaking CP-S09's invariant that work stays QUEUED during a replacement.
      const harness = makeHarness();
      const { projectId, repositoryId } = await registerFixtureProject(harness);
      const first = await createActiveRun(harness, projectId, repositoryId);
      const binding = harness.cp.bindings.activePrimaryCto(projectId)!;
      expect(harness.cp.sessions.require(binding.sessionId).lifecycle).toBe(SessionLifecycle.READY);

      const replacement = harness.cp.cto.requestReplacement(projectId, "operator request");
      expect(replacement.allowed).toBe(true);
      expect(harness.cp.sessions.require(binding.sessionId).lifecycle).toBe(SessionLifecycle.DRAINING);
      const drainRequest = harness.cp.outbox.byIdempotencyKey(`drain:${projectId}:${binding.bindingGeneration}`);
      expect(drainRequest).not.toBeNull();
      expect(["PENDING", "IN_FLIGHT", "SENT"]).toContain(drainRequest!.status);

      const resumed = harness.cp.cto.resumeProject(projectId);
      expect(resumed.allowed).toBe(false);
      expect(resumed.reasonCode).toBe(ReasonCode.RESUME_BLOCKED_NON_SUSPEND_DRAINING);

      // The session must still be DRAINING, not READY — the actual defect: the previous
      // resumeProject reported success here and flipped it back.
      expect(harness.cp.sessions.require(binding.sessionId).lifecycle).toBe(SessionLifecycle.DRAINING);
      // The DRAIN_REQUEST this replacement enqueued is still exactly where it was — not
      // acknowledged, not rejected, not expired — because nothing about the replacement was
      // undone by the refused resume.
      const stillDraining = harness.cp.outbox.byIdempotencyKey(`drain:${projectId}:${binding.bindingGeneration}`);
      expect(stillDraining!.status).toBe(drainRequest!.status);

      // The standing invariant CP-S09 names: new work stays QUEUED while the CTO drains,
      // not merely "the lifecycle string says DRAINING" — dispatch has to actually refuse.
      const second = harness.cp.runs.create({
        projectId,
        executionMode: ExecutionMode.STANDARD,
        contract: CONTRACT,
        repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
      });
      if (!second.allowed) throw new Error(second.message);
      const blocked = await harness.cp.runs.dispatch(second.value.runId);
      expect(blocked.allowed).toBe(false);
      expect(blocked.reasonCode).toBe(ReasonCode.RUN_DISPATCH_BLOCKED_CTO_DRAINING);
      expect(harness.cp.runs.require(second.value.runId).state).toBe(RunState.QUEUED);

      // The other direction, named by the same review: requestReplacement must not be able
      // to paper over an owner suspend either. A project the owner actually suspended
      // refuses a replacement request outright, rather than silently no-op-ing the DRAINING
      // transition and reporting success as though a replacement had started.
      const stillActiveRun = harness.cp.runs.require(first.runId);
      expect([RunState.ACTIVE, RunState.BLOCKED]).toContain(stillActiveRun.state);
    },
  );

  it(
    "#692 round 2 — requestReplacement refuses to drain a project the owner suspended",
    async () => {
      // A *completed* suspend already revokes the binding entirely (STOPPED, no active
      // binding left) — requestReplacement refuses that with NOT_FOUND on its own, before
      // this fix ever mattered. The case this guards is the one the sibling test above
      // simulates the other side of: a suspend that committed `projects.suspended` and the
      // DRAINING transition but crashed before reaching STOPPED, leaving the binding still
      // active. Simulated the same way as that test — driving the real FSM transition
      // directly rather than timing a real stopSession() crash.
      const harness = makeHarness();
      const { projectId } = await registerFixtureProject(harness);
      const bound = await harness.cp.cto.ensurePrimaryCto(projectId, "setup");
      if (!bound.allowed) throw new Error(bound.message);

      const suspendedFlag = harness.cp.projects.setSuspended(projectId, true, true);
      expect(suspendedFlag.allowed).toBe(true);
      const drained = harness.cp.sessions.transition(
        bound.value.sessionId,
        SessionLifecycle.DRAINING,
        "test: simulate a suspend that committed DRAINING but never reached STOPPED",
        DrainingCause.SUSPEND,
      );
      expect(drained.allowed).toBe(true);
      expect(harness.cp.projects.require(projectId).suspended).toBe(true);
      expect(harness.cp.bindings.active(roleKeyFor(Role.PRIMARY_CTO, { projectId }))).not.toBeNull();

      const replacement = harness.cp.cto.requestReplacement(projectId, "operator request");
      expect(replacement.allowed).toBe(false);
      expect(replacement.reasonCode).toBe(ReasonCode.REPLACEMENT_BLOCKED_PROJECT_SUSPENDED);

      // Refused cleanly — the session is still exactly where the simulated crash left it,
      // draining for the suspend, not layered with a second, unrelated drain cause.
      expect(harness.cp.sessions.require(bound.value.sessionId).lifecycle).toBe(SessionLifecycle.DRAINING);
      expect(harness.cp.sessions.require(bound.value.sessionId).drainingCause).toBe(DrainingCause.SUSPEND);
    },
  );

  it(
    "#692 compensates instead of losing a binding revoke denied after the runtime stop " +
      "already happened",
    async () => {
      const harness = makeHarness();
      const { projectId, repositoryId } = await registerFixtureProject(harness);
      const run = await createActiveRun(harness, projectId, repositoryId);
      const ceoSessionId = bindCeo(harness);
      const binding = harness.cp.bindings.activePrimaryCto(projectId)!;

      // suspendProject's own checkpoint tx (before stopSession is ever called) already
      // moved this run to BLOCKED, and the preflight check right before stopSession would
      // see exactly that and let the call proceed. The only gap left is this await
      // itself: a concurrent CEO decision resolving the escalation while the *real*
      // scripted provider stop is in flight flips the run back to ACTIVE before
      // bindings.revoke() runs. Wrapping (not replacing) stopSession means the adapter's
      // own stop behavior (scripted-adapter.ts) still runs, not a stand-in for it.
      const originalStop = harness.scripted.stopSession.bind(harness.scripted);
      harness.scripted.stopSession = async (handle) => {
        const result = await originalStop(handle);
        const resolved = harness.cp.ceo.resolveEscalation(run.runId, "resolved mid-suspend", ceoSessionId);
        if (!resolved.allowed) throw new Error(`${resolved.reasonCode}: ${resolved.message}`);
        return result;
      };

      const suspended = await harness.cp.cto.suspendProject(projectId, true, "capacity crisis", TEST_OWNER);

      expect(suspended.allowed).toBe(false);
      expect(suspended.reasonCode).toBe(ReasonCode.SESSION_STOPPED_BINDING_REVOKE_FAILED);
      // The provider was already told to stop and that cannot be undone — the STOPPED
      // write must stand rather than roll back into a lie about the runtime's state.
      expect(harness.cp.sessions.require(binding.sessionId).lifecycle).toBe(SessionLifecycle.STOPPED);
      // The binding was NOT silently revoked, and it was NOT silently left as if nothing
      // happened either: the mismatch is durable (an active binding pointing at a STOPPED
      // session), it needs no separate flag to be visible, and doctor already reads
      // exactly this join as a CRITICAL finding rather than something this fix invented.
      expect(harness.cp.bindings.activePrimaryCto(projectId)?.sessionId).toBe(binding.sessionId);
      const report = await harness.cp.doctor.run("project", projectId);
      const finding = deadSessionFinding(report);
      expect(finding?.severity).toBe("CRITICAL");
      expect(finding?.observedEvidence).toMatchObject({ sessionId: binding.sessionId });
      const events = harness.cp.audit.byKind("PROJECT_SUSPEND_BINDING_REVOKE_FAILED");
      expect(events.length).toBe(1);
      expect(events[0]?.sessionId).toBe(binding.sessionId);
    },
  );

  it("#692 a retry after the compensation actually completes the revoke, and doctor clears on its own", async () => {
    const harness = makeHarness();
    const { projectId, repositoryId } = await registerFixtureProject(harness);
    const run = await createActiveRun(harness, projectId, repositoryId);
    const ceoSessionId = bindCeo(harness);

    const originalStop = harness.scripted.stopSession.bind(harness.scripted);
    harness.scripted.stopSession = async (handle) => {
      const result = await originalStop(handle);
      const resolved = harness.cp.ceo.resolveEscalation(run.runId, "resolved mid-suspend", ceoSessionId);
      if (!resolved.allowed) throw new Error(`${resolved.reasonCode}: ${resolved.message}`);
      return result;
    };
    const first = await harness.cp.cto.suspendProject(projectId, true, "capacity crisis", TEST_OWNER);
    expect(first.allowed).toBe(false);
    expect(first.reasonCode).toBe(ReasonCode.SESSION_STOPPED_BINDING_REVOKE_FAILED);
    expect(deadSessionFinding(await harness.cp.doctor.run("project", projectId))?.severity).toBe("CRITICAL");

    // The session is already STOPPED now, so a retry must not call the provider again —
    // but it must still be able to finish the revoke the first attempt could not, rather
    // than treating an already-stopped session as proof the binding was cleaned up too.
    harness.scripted.stopSession = async () => {
      throw new Error("stopSession must not be called again for an already-stopped session");
    };
    const retried = await harness.cp.cto.suspendProject(projectId, true, "capacity crisis retry", TEST_OWNER);
    expect(retried.allowed).toBe(true);
    expect(harness.cp.bindings.activePrimaryCto(projectId)).toBeNull();
    // Nothing had to be restored: with no active binding left, the join doctor reads no
    // longer matches anything — the finding is gone because the fact it read is gone,
    // not because something remembered to un-mark it.
    expect(deadSessionFinding(await harness.cp.doctor.run("project", projectId))).toBeUndefined();
  });

  it("#226 leaves a durable blocked run instead of an ACTIVE run owned by a revoked CTO", async () => {
    const harness = makeHarness();
    const { projectId, repositoryId } = await registerFixtureProject(harness);
    const run = await createActiveRun(harness, projectId, repositoryId);

    await harness.cp.cto.suspendProject(projectId, true, "capacity crisis", TEST_OWNER);
    expect(harness.cp.runs.require(run.runId).state).toBe(RunState.BLOCKED);
    expect(harness.cp.runs.require(run.runId).ownerBindingGeneration).toBe(1);
  });

  it("accepts a delivered, session-authenticated handoff envelope", async () => {
    const harness = makeHarness();
    authenticateHandoffsForTest(harness);
    const { projectId } = await registerFixtureProject(harness);
    await harness.cp.cto.ensurePrimaryCto(projectId, "setup");
    const prepared = await harness.cp.cto.prepareSwitchover(projectId, HANDOFF);
    if (!prepared.allowed) throw new Error(prepared.message);

    const acked = harness.cp.cto.acknowledgeHandoff(
      prepared.value.handoffId,
      deliveredAck(harness, prepared.value.handoffId, prepared.value.incomingSessionId),
    );
    expect(acked.allowed).toBe(true);
  });
});

describe("round-2 registry regressions", () => {
  it("#152 refuses to activate manifest B with a completed run's grant for manifest A", async () => {
    const harness = makeHarness();
    const { projectId } = await registerFixtureProject(harness);
    const manifestA = { ...fixtureManifest(projectId), postMergeCommands: ["verify"] };
    const manifestB = { ...fixtureManifest(projectId), postMergeCommands: ["other"] };
    const storedA = harness.cp.projects.storeManifest(manifestA, harness.cp.manifestAuthorizationForTests(manifestA));
    if (!storedA.allowed) throw new Error(storedA.message);
    const runId = await completeContractChangeWithGrant(harness, projectId, storedA.value);

    const refused = harness.cp.projects.activateManifest(projectId, manifestB, {
      runKind: "CONTRACT_CHANGE",
      runId,
    }, manifestAuthorizationForRun(harness, projectId, manifestB, runId));
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.MANIFEST_ACTIVATION_EVIDENCE_MISSING);
  });

  it("#153 marks every project repository drifted with the activated manifest digest", async () => {
    const harness = makeHarness();
    const { projectId, repositoryId } = await registerFixtureProject(harness);
    const revised = { ...fixtureManifest(projectId), postMergeCommands: ["verify"] };
    const stored = harness.cp.projects.storeManifest(revised, harness.cp.manifestAuthorizationForTests(revised));
    if (!stored.allowed) throw new Error(stored.message);
    const runId = await completeContractChangeWithGrant(harness, projectId, stored.value);

    const activated = harness.cp.projects.activateManifest(projectId, revised, {
      runKind: "CONTRACT_CHANGE",
      runId,
    }, manifestAuthorizationForRun(harness, projectId, revised, runId));
    expect(activated.allowed).toBe(true);
    const repository = harness.cp.repositories.byId(repositoryId)!;
    expect(repository.activeManifestDigest).toBe(stored.value);
    expect(repository.driftState).toBe("DRIFTED");
  });

  it("#154 refuses a second identity for the same canonical checkout", async () => {
    const harness = makeHarness();
    const repository = makeRepo();
    const first = await harness.cp.repositories.register({
      checkoutPath: repository,
      identity: "local-alias-a",
    });
    if (!first.allowed) throw new Error(first.message);

    const refused = await harness.cp.repositories.register({
      checkoutPath: repository,
      identity: "local-alias-b",
    });
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.REPOSITORY_CHECKOUT_ALREADY_REGISTERED);
  });

  it("#155 preserves trust and project bindings when an existing repository is re-registered", async () => {
    const harness = makeHarness();
    const { projectId } = await registerFixtureProject(harness);
    const repository = makeRepo();
    const first = await harness.cp.repositories.register({
      checkoutPath: repository,
      identity: "local-untrusted",
      projectId,
      repositoryRole: "secondary",
      activeManifestDigest: harness.cp.projects.require(projectId).activeManifestDigest,
      trustClass: "UNTRUSTED",
    });
    if (!first.allowed) throw new Error(first.message);

    const retried = await harness.cp.repositories.register({ checkoutPath: repository, identity: "local-untrusted" });
    expect(retried.allowed).toBe(true);
    if (!retried.allowed) return;
    expect(retried.value.trustClass).toBe("UNTRUSTED");
    expect(retried.value.projectId).toBe(projectId);
    expect(retried.value.activeManifestDigest).toBe(first.value.activeManifestDigest);
  });

  it("#156 and #227 retain the accepted head after repeated observations of an out-of-band move", async () => {
    const harness = makeHarness();
    const { repositoryId, identity } = await registerFixtureProject(harness);
    const accepted = harness.cp.repositories.byId(repositoryId)!.lastObservedHead;
    writeFiles(harness.repoPath, { "README.md": "# changed outside ACP\n" });
    commitAll(harness.repoPath, "out-of-band move");

    const diagnostic = harness.cp.repositories.observed(identity);
    expect(diagnostic).toMatchObject({
      baselineHead: accepted,
      drift: "DRIFTED",
    });
    expect(diagnostic.currentHead).not.toBe(accepted);
    expect(harness.cp.repositories.byId(repositoryId)!.lastObservedHead).toBe(accepted);

    const first = await harness.cp.repositories.observe(repositoryId);
    const second = await harness.cp.repositories.observe(repositoryId);
    expect(first?.driftState).toBe("DRIFTED");
    expect(second?.driftState).toBe("DRIFTED");
    expect(second?.lastObservedHead).toBe(accepted);
  });

  it("#228 refuses to reuse a temporary repository binding created for another run", async () => {
    const harness = makeHarness();
    const repository = makeRepo();
    const first = await harness.cp.repositories.registerTemporary(repository, "run-A");
    if (!first.allowed) throw new Error(first.message);

    const refused = await harness.cp.repositories.registerTemporary(repository, "run-B");
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.TEMPORARY_REPOSITORY_SCOPE_VIOLATION);
    const attachment = harness.cp.repositories.assertRunScope(first.value.repositoryId, "run-B");
    expect(attachment.allowed).toBe(false);
    expect(attachment.reasonCode).toBe(ReasonCode.TEMPORARY_REPOSITORY_SCOPE_VIOLATION);
  });
});
