import { afterAll, describe, expect, it } from "vitest";

import { digestOf } from "../../src/core/digest.ts";
import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ExecutionMode, Role, RunState, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { IngressGuard, ownerApprovalPayload } from "../../src/ingress/ingress-guard.ts";
import { cleanupTempDirs, gitSync, makeRepo } from "../helpers/fixtures.ts";
import {
  TEST_OWNER,
  type Harness,
  bindCeo,
  driveToReviewedCandidate,
  makeHarness,
  registerFixtureProject,
} from "../helpers/harness.ts";
import type { TaskContract } from "../../src/run/run-engine.ts";
import type { HandoffAcknowledgement, HandoffPackage } from "../../src/cto/cto-lifecycle.ts";

afterAll(cleanupTempDirs);

const CONTRACT: TaskContract = {
  goal: "runtime hardening",
  why: "scenario",
  scope: ["src/app.js"],
  nonGoals: [],
  acceptance: ["verify.js exits 0"],
  priority: "NORMAL",
  humanGate: [],
  references: [],
};

const authenticateHandoffsForTest = (harness: Harness): void => {
  harness.cp.cto.attach({
    handoffAuthentication: { verifyHandoffAcknowledgement: () => allow(ReasonCode.OK, undefined) },
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

const activeRun = async (harness: Harness, projectId = "fixture-project") => {
  const registered = await registerFixtureProject(harness, projectId);
  bindCeo(harness);
  const created = harness.cp.runs.create({
    projectId: registered.projectId,
    executionMode: ExecutionMode.STANDARD,
    contract: CONTRACT,
    repositories: [
      { repositoryId: registered.repositoryId, repositoryRole: "primary", baseBranch: "dev" },
    ],
  });
  if (!created.allowed) throw new Error(created.message);
  const dispatched = await harness.cp.runs.dispatch(created.value.runId);
  if (!dispatched.allowed) throw new Error(dispatched.message);
  return { ...registered, runId: created.value.runId, run: dispatched.value };
};

/** Mints the operation-bound owner proof that ProductionGate, not the caller, verifies. */
const ownerDecisionReceipt = (
  harness: Harness,
  runId: string,
  item: string,
  approved: boolean,
  note: string,
  actor: string = TEST_OWNER.actor,
) => {
  const guard = new IngressGuard(harness.cp.db, harness.cp.clock, harness.cp.audit, {
    cli: { allowedActors: [actor] },
  });
  const approval = {
    runId,
    operation: "owner_decision_submit",
    parameters: { item, approved, note },
    idempotencyKey: `owner-decision:${digestOf({ runId, item, approved, note, actor })}`,
    approved,
  };
  const admitted = guard.admitOwnerApproval({
    channel: "cli",
    actor,
    nonce: `owner-decision:${digestOf(approval)}`,
    payload: ownerApprovalPayload(approval),
  }, approval);
  if (!admitted.allowed) throw new Error(admitted.message);
  return admitted.value;
};

describe("the dispatch-time contract pin is immutable (CP-HI-03)", () => {
  it("refuses to repoint a run's pinned manifest", async () => {
    const harness = makeHarness();
    const { projectId, runId } = await activeRun(harness);
    const pinned = harness.cp.runs.require(runId).pinnedManifestDigest;
    expect(pinned).toBeTruthy();

    const revised = {
      ...harness.cp.projects.activeManifest(projectId)!.manifest,
      postMergeCommands: ["verify"],
    };
    const stored = harness.cp.projects.storeManifest(revised);
    if (!stored.allowed) throw new Error(stored.message);

    const refused = harness.cp.runs.pinManifest(runId, stored.value);
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.CANDIDATE_CANNOT_WEAKEN_CONTRACT);
    expect(harness.cp.runs.require(runId).pinnedManifestDigest).toBe(pinned);
  });

  it("treats re-pinning the same digest as a no-op", async () => {
    const harness = makeHarness();
    const { runId } = await activeRun(harness);
    const pinned = harness.cp.runs.require(runId).pinnedManifestDigest!;
    expect(harness.cp.runs.pinManifest(runId, pinned).allowed).toBe(true);
  });
});

describe("a CEO decision comes from the session that holds the role (CP-HI-07)", () => {
  const readyForReview = async () => {
    const harness = makeHarness();
    const driven = await driveToReviewedCandidate(harness);
    // Produce the packet so the run is genuinely awaiting a CEO decision.
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
    return { harness, driven };
  };

  it("refuses a decision from a session id that holds no CEO binding", async () => {
    const { harness, driven } = await readyForReview();
    const refused = harness.cp.ceo.submitCeoDecision({
      runId: driven.runId,
      decision: "CONFIRM",
      candidateSnapshotDigest: driven.candidateSnapshotDigest,
      ceoSessionId: "ses_not_a_ceo",
      rationale: "looks fine to me",
    });
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.GATE_AUTHORITY_DENIED);
    expect(harness.cp.runs.require(driven.runId).state).toBe(RunState.READY_FOR_CEO_REVIEW);
  });

  it("refuses an escalation resolution from a session that is not the CEO", async () => {
    const harness = makeHarness();
    const { runId } = await activeRun(harness);
    const refused = harness.cp.ceo.resolveEscalation(runId, "do it anyway", "ses_not_a_ceo");
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.GATE_AUTHORITY_DENIED);
  });

  it("accepts the decision from the bound CEO session", async () => {
    const { harness, driven } = await readyForReview();
    const ceo = harness.cp.bindings.active(roleKeyFor(Role.CEO))!;
    const confirmed = harness.cp.ceo.submitCeoDecision({
      runId: driven.runId,
      decision: "CONFIRM",
      candidateSnapshotDigest: driven.candidateSnapshotDigest,
      ceoSessionId: ceo.sessionId,
      rationale: "evidence is complete",
    });
    expect(confirmed.allowed).toBe(true);
    expect(harness.cp.runs.require(driven.runId).state).toBe(RunState.COMPLETED);
  });
});

describe("an owner decision needs an owner (§21)", () => {
  it("refuses a decision from an actor that is not an allowlisted owner", async () => {
    const harness = makeHarness();
    const { runId } = await activeRun(harness);
    const refused = harness.cp.ceo.recordOwnerDecision({
      runId,
      item: "public release",
      approved: true,
      note: "",
      receipt: ownerDecisionReceipt(harness, runId, "public release", true, "", "someone-else"),
    });
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.INGRESS_ACTOR_NOT_ALLOWLISTED);
    expect(harness.cp.artifacts.list(runId, "APPROVAL")).toHaveLength(0);
  });

  it("refuses every owner decision when the deployment has no owner identity", async () => {
    const harness = makeHarness({ ownerIdentities: [] });
    const { runId } = await activeRun(harness);
    const refused = harness.cp.ceo.recordOwnerDecision({
      runId,
      item: "public release",
      approved: true,
      note: "",
      receipt: ownerDecisionReceipt(harness, runId, "public release", true, ""),
    });
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.INGRESS_ACTOR_NOT_ALLOWLISTED);
  });

  it("records the real actor, not a generic 'owner', when the identity checks out", async () => {
    const harness = makeHarness();
    const { runId } = await activeRun(harness);
    const recorded = harness.cp.ceo.recordOwnerDecision({
      runId,
      item: "public release",
      approved: true,
      note: "go ahead",
      receipt: ownerDecisionReceipt(harness, runId, "public release", true, "go ahead"),
    });
    expect(recorded.allowed).toBe(true);
    const event = harness.cp.audit.byKind("OWNER_DECISION").at(-1)!;
    expect(event.actor).toBe(`${TEST_OWNER.channel}:${TEST_OWNER.actor}`);
  });

  it("refuses an owner-approved project suspension with no owner identity behind it", async () => {
    const harness = makeHarness();
    const { projectId } = await registerFixtureProject(harness);
    await harness.cp.cto.ensurePrimaryCto(projectId, "setup");

    const refused = await harness.cp.cto.suspendProject(projectId, true, "capacity crisis");
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.INGRESS_ACTOR_NOT_ALLOWLISTED);
    expect(harness.cp.projects.require(projectId).suspended).toBe(false);
  });
});

describe("task executions belong to the run that drives them (§25.2)", () => {
  const twoRuns = async () => {
    const harness = makeHarness();
    const first = await activeRun(harness, "project-a");

    const secondRepo = makeRepo({ "src/app.js": "module.exports = () => 1;\n" });
    const registered = await harness.cp.repositories.register({
      checkoutPath: secondRepo,
      projectId: "project-a",
      repositoryRole: "secondary",
      identity: "github:acme/second",
    });
    if (!registered.allowed) throw new Error(registered.message);
    const created = harness.cp.runs.create({
      projectId: "project-a",
      executionMode: ExecutionMode.STANDARD,
      contract: CONTRACT,
      repositories: [
        {
          repositoryId: registered.value.repositoryId,
          repositoryRole: "secondary",
          baseBranch: "dev",
        },
      ],
    });
    if (!created.allowed) throw new Error(created.message);
    const dispatched = await harness.cp.runs.dispatch(created.value.runId);
    if (!dispatched.allowed) throw new Error(dispatched.message);
    return { harness, first, second: { runId: created.value.runId, run: dispatched.value } };
  };

  it("refuses to start another run's task under this run's authority", async () => {
    const { harness, first, second } = await twoRuns();
    const submitted = harness.cp.tasks.submit(second.runId, [
      { key: "impl", title: "second run work", category: "implementation" },
    ]);
    if (!submitted.allowed) throw new Error(submitted.message);
    const foreignTask = harness.cp.tasks.ready(second.runId)[0]!;

    const refused = harness.cp.tasks.startExecution({
      runId: first.runId,
      taskId: foreignTask.taskId,
      ownerBindingGeneration: first.run.ownerBindingGeneration!,
      workerSessionId: first.run.ownerSessionId,
      provider: "scripted",
      model: "scripted-worker",
    });
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE);
    expect(harness.cp.tasks.get(foreignTask.taskId)!.state).toBe("READY");
  });

  it("refuses to finish another run's execution", async () => {
    const { harness, first, second } = await twoRuns();
    const submitted = harness.cp.tasks.submit(second.runId, [
      { key: "impl", title: "second run work", category: "implementation" },
    ]);
    if (!submitted.allowed) throw new Error(submitted.message);
    const task = harness.cp.tasks.ready(second.runId)[0]!;
    const execution = harness.cp.tasks.startExecution({
      runId: second.runId,
      taskId: task.taskId,
      ownerBindingGeneration: second.run.ownerBindingGeneration!,
      workerSessionId: second.run.ownerSessionId,
      provider: "scripted",
      model: "scripted-worker",
    });
    if (!execution.allowed) throw new Error(execution.message);

    const refused = harness.cp.tasks.finishExecution(
      execution.value.executionId,
      { status: "SUCCEEDED", resultDigest: "sha256:x" },
      first.runId,
    );
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE);
  });

  it("refuses a SUCCEEDED receipt that names nothing it produced", async () => {
    const harness = makeHarness();
    const { runId, run } = await activeRun(harness);
    const submitted = harness.cp.tasks.submit(runId, [
      { key: "impl", title: "work", category: "implementation" },
    ]);
    if (!submitted.allowed) throw new Error(submitted.message);
    const task = harness.cp.tasks.ready(runId)[0]!;
    const execution = harness.cp.tasks.startExecution({
      runId,
      taskId: task.taskId,
      ownerBindingGeneration: run.ownerBindingGeneration!,
      workerSessionId: run.ownerSessionId,
      provider: "scripted",
      model: "scripted-worker",
    });
    if (!execution.allowed) throw new Error(execution.message);

    const refused = harness.cp.tasks.finishExecution(execution.value.executionId, {
      status: "SUCCEEDED",
    });
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.EVIDENCE_MISSING);
    expect(harness.cp.tasks.get(task.taskId)!.state).toBe("RUNNING");

    const finished = harness.cp.tasks.finishExecution(execution.value.executionId, {
      status: "SUCCEEDED",
      resultDigest: "sha256:report",
    });
    expect(finished.allowed).toBe(true);
    // A second finish is refused rather than silently rewriting the receipt.
    const again = harness.cp.tasks.finishExecution(execution.value.executionId, {
      status: "FAILED",
    });
    expect(again.allowed).toBe(false);
    expect(again.reasonCode).toBe(ReasonCode.CONFLICT);
  });
});

describe("a completed run's work is sealed (§34.3)", () => {
  it("refuses new tasks once a packet has been produced", async () => {
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
    if (!packet.allowed) throw new Error(packet.message);
    expect(harness.cp.runs.require(driven.runId).state).toBe(RunState.READY_FOR_CEO_REVIEW);

    const refused = harness.cp.tasks.submit(driven.runId, [
      { key: "sneaky", title: "extra work after the packet", category: "implementation" },
    ]);
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.RUN_TRANSITION_ILLEGAL);
    expect(harness.cp.tasks.list(driven.runId).some((t) => t.title.includes("extra work"))).toBe(false);
  });
});

describe("a repository's identity is the one its checkout has (CP-HI-06)", () => {
  it("refuses a declared identity that contradicts the checkout's remote", async () => {
    const harness = makeHarness();
    const repoPath = makeRepo({ "README.md": "# real\n" });
    gitSync(repoPath, ["remote", "add", "origin", "https://github.com/acme/real.git"]);

    const refused = await harness.cp.repositories.register({
      checkoutPath: repoPath,
      repositoryRole: "primary",
      identity: "github:acme/something-else",
    });
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.REPOSITORY_IDENTITY_MISMATCH);
  });

  it("accepts a declared identity that matches the remote", async () => {
    const harness = makeHarness();
    const repoPath = makeRepo({ "README.md": "# real\n" });
    gitSync(repoPath, ["remote", "add", "origin", "https://github.com/acme/real.git"]);

    const registered = await harness.cp.repositories.register({
      checkoutPath: repoPath,
      repositoryRole: "primary",
      identity: "github:acme/real",
    });
    expect(registered.allowed).toBe(true);
  });
});

describe("a switchover holds its barrier until the ack (§10.1)", () => {
  const handoff: HandoffPackage = {
    projectStatus: "green",
    activeManifestDigest: null,
    recentDecisions: ["pinned the contract"],
    openBlockers: [],
    queuedWork: [],
    repositoryFacts: [{ identity: "github:acme/fixture", branch: "dev", head: null }],
    knownRisks: [],
    recommendedNextAction: "continue the queued work",
  };

  it("marks the outgoing CTO draining so no new run can be dispatched to it", async () => {
    const harness = makeHarness();
    const { projectId, repositoryId } = await registerFixtureProject(harness);
    await harness.cp.cto.ensurePrimaryCto(projectId, "setup");

    const prepared = await harness.cp.cto.prepareSwitchover(projectId, handoff);
    if (!prepared.allowed) throw new Error(`${prepared.reasonCode}: ${prepared.message}`);
    expect(harness.cp.cto.isDraining(projectId)).toBe(true);

    const created = harness.cp.runs.create({
      projectId,
      executionMode: ExecutionMode.STANDARD,
      contract: CONTRACT,
      repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
    });
    if (!created.allowed) throw new Error(created.message);
    const refused = await harness.cp.runs.dispatch(created.value.runId);
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.RUN_DISPATCH_BLOCKED_CTO_DRAINING);
  });

  it("refuses the ack when the binding moved after the handoff was prepared", async () => {
    const harness = makeHarness();
    authenticateHandoffsForTest(harness);
    const { projectId } = await registerFixtureProject(harness);
    await harness.cp.cto.ensurePrimaryCto(projectId, "setup");
    const prepared = await harness.cp.cto.prepareSwitchover(projectId, handoff);
    if (!prepared.allowed) throw new Error(prepared.message);

    // An emergency takeover moves the binding while the handoff is still pending.
    const outgoing = harness.cp.bindings.activePrimaryCto(projectId)!;
    harness.cp.sessions.transition(outgoing.sessionId, SessionLifecycle.ERROR, "outgoing session became unavailable");
    const taken = await harness.cp.cto.recoveryTakeover(projectId, "outgoing session died");
    if (!taken.allowed) throw new Error(taken.message);

    const refused = harness.cp.cto.acknowledgeHandoff(
      prepared.value.handoffId,
      deliveredAck(harness, prepared.value.handoffId, prepared.value.incomingSessionId),
    );
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.WRITE_BINDING_GENERATION_STALE);
  });

  it("refuses the ack when the outgoing CTO picked up an active run after prepare", async () => {
    const harness = makeHarness();
    authenticateHandoffsForTest(harness);
    const { projectId, repositoryId } = await registerFixtureProject(harness);
    await harness.cp.cto.ensurePrimaryCto(projectId, "setup");
    const outgoing = harness.cp.bindings.activePrimaryCto(projectId)!;
    const prepared = await harness.cp.cto.prepareSwitchover(projectId, handoff);
    if (!prepared.allowed) throw new Error(prepared.message);

    // The barrier is bypassed out of band: a run is created and pinned to the outgoing
    // session directly, the state the ack must refuse to switch on.
    const created = harness.cp.runs.create({
      projectId,
      executionMode: ExecutionMode.STANDARD,
      contract: CONTRACT,
      repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
    });
    if (!created.allowed) throw new Error(created.message);
    harness.cp.db.run(
      `UPDATE runs SET state = 'ACTIVE', owner_session_id = ?, owner_binding_generation = ?,
                       owner_role_key = ?, owner_session_incarnation = ?
        WHERE run_id = ?`,
      [
        outgoing.sessionId,
        outgoing.bindingGeneration,
        outgoing.roleKey,
        harness.cp.sessions.require(outgoing.sessionId).incarnation,
        created.value.runId,
      ],
    );

    const refused = harness.cp.cto.acknowledgeHandoff(
      prepared.value.handoffId,
      deliveredAck(harness, prepared.value.handoffId, prepared.value.incomingSessionId),
    );
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.SWITCHOVER_BLOCKED_ACTIVE_RUNS);
    expect(harness.cp.bindings.activePrimaryCto(projectId)!.sessionId).toBe(outgoing.sessionId);
    expect(harness.cp.sessions.require(outgoing.sessionId).lifecycle).toBe(SessionLifecycle.DRAINING);
  });

  it("completes the switchover when the barrier held", async () => {
    const harness = makeHarness();
    authenticateHandoffsForTest(harness);
    const { projectId } = await registerFixtureProject(harness);
    await harness.cp.cto.ensurePrimaryCto(projectId, "setup");
    const outgoing = harness.cp.bindings.activePrimaryCto(projectId)!;
    const prepared = await harness.cp.cto.prepareSwitchover(projectId, handoff);
    if (!prepared.allowed) throw new Error(prepared.message);

    const acked = harness.cp.cto.acknowledgeHandoff(
      prepared.value.handoffId,
      deliveredAck(harness, prepared.value.handoffId, prepared.value.incomingSessionId),
    );
    expect(acked.allowed).toBe(true);
    if (!acked.allowed) return;
    expect(acked.value.sessionId).toBe(prepared.value.incomingSessionId);
    expect(acked.value.bindingGeneration).toBe(outgoing.bindingGeneration + 1);
  });
});

describe("round-2 review: completion, claims and post-merge coverage", () => {
  it("refuses a COMPLETED transition that no completion authority carries (runtime#1)", async () => {
    const harness = makeHarness();
    const { runId } = await activeRun(harness);
    harness.cp.runs.transition(runId, RunState.READY_FOR_CEO_REVIEW, "pretend");

    const refused = harness.cp.runs.transition(runId, RunState.COMPLETED, "just say it is done");
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.COMPLETION_AUTHORITY_DENIED);
    expect(harness.cp.runs.require(runId).state).toBe(RunState.READY_FOR_CEO_REVIEW);
  });

  it("refuses to release a claim without naming the run that holds it (runtime#12)", async () => {
    const harness = makeHarness();
    const first = await activeRun(harness);
    const claimed = harness.cp.claims.acquire({
      runId: first.runId,
      ownerSessionId: first.run.ownerSessionId!,
      ownerBindingGeneration: first.run.ownerBindingGeneration!,
      ownerRoleKey: first.run.ownerRoleKey!,
      repositoryIdentity: first.identity,
      branch: "feature/F9-thing",
    });
    if (!claimed.allowed) throw new Error(claimed.message);

    const refused = harness.cp.claims.release(claimed.value[0]!.claimId, "run_not_mine");
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE);
    expect(harness.cp.claims.heldByRun(first.runId).length).toBeGreaterThan(0);
  });
});
