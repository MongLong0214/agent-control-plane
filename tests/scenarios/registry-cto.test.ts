import { afterAll, describe, expect, it } from "vitest";

import { ReasonCode } from "../../src/core/reason-codes.ts";
import { digestOf } from "../../src/core/digest.ts";
import { allow } from "../../src/core/errors.ts";
import { ExecutionMode, RunState, SessionLifecycle, roleKeyFor, Role } from "../../src/domain/types.ts";
import type { HandoffAcknowledgement, HandoffPackage } from "../../src/cto/cto-lifecycle.ts";
import { cleanupTempDirs, makeRepo } from "../helpers/fixtures.ts";
import {
  TEST_OWNER,
  type Harness,
  bindCeo,
  fixtureManifest,
  makeHarness,
  ownerDecisionReceipt,
  registerFixtureProject,
} from "../helpers/harness.ts";
import type { TaskContract } from "../../src/run/run-engine.ts";

afterAll(cleanupTempDirs);

const CONTRACT: TaskContract = {
  goal: "scenario",
  why: "scenario",
  scope: [],
  nonGoals: [],
  acceptance: ["verify.js exits 0"],
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
  recommendedNextAction: "continue the queued work",
};

const deliveredHandoffAck = (
  harness: Harness,
  handoffId: string,
  sessionId: string,
): HandoffAcknowledgement => {
  const message = harness.cp.outbox.byIdempotencyKey(`handoff:${handoffId}`)!;
  harness.cp.db.run(`UPDATE outbox SET status = 'SENT' WHERE message_id = ?`, [message.messageId]);
  return {
    sessionId,
    sessionIncarnation: harness.cp.sessions.require(sessionId).incarnation,
    bindingGeneration: message.bindingGeneration,
    messageId: message.messageId,
    payloadDigest: message.payloadDigest,
    sessionSecret: "scenario-session-secret",
  };
};

const newRun = async (harness: Harness, projectId: string, repositoryId: string) => {
  const created = harness.cp.runs.create({
    projectId,
    executionMode: ExecutionMode.SIMPLE,
    contract: CONTRACT,
    repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
  });
  if (!created.allowed) throw new Error(created.message);
  return created.value;
};

describe("registry authority (CP-S04, CP-S05, CP-S26)", () => {
  it("CP-S05: the absolute checkout path exists only in the repository registry", async () => {
    const harness = makeHarness();
    const projectId = "checkout-path-ssot";
    const project = harness.cp.projects.register({
      projectId,
      name: "fixture",
      manifest: fixtureManifest(projectId),
    });
    expect(project.reasonCode).toBe(ReasonCode.OK);
    if (!project.allowed || !project.value.activeManifestDigest) {
      throw new Error("fixture project registration did not store a manifest");
    }
    const repository = await harness.cp.repositories.register({
      checkoutPath: harness.repoPath,
      projectId,
      repositoryRole: "primary",
      activeManifestDigest: project.value.activeManifestDigest,
      identity: "github:acme/fixture",
    });
    expect(repository.reasonCode).toBe(ReasonCode.OK);
    if (!repository.allowed) throw new Error(repository.message);

    expect(repository.value.checkoutPath).toMatch(/^\//);

    // The value is re-read from durable manifest storage after registration carries the path.
    const stored = harness.cp.db.get<{ content_json: string }>(
      "SELECT content_json FROM manifests WHERE digest = ?",
      [project.value.activeManifestDigest],
    );
    expect(stored?.content_json).not.toContain(harness.repoPath);
    expect(stored?.content_json).not.toContain(repository.value.checkoutPath);
    expect(stored?.content_json).not.toMatch(/\/Users|\/private|\/tmp/);
    expect(JSON.stringify(harness.cp.projects.activeManifest(projectId)?.manifest)).toBe(stored?.content_json);
  });

  it("CP-S26: an unregistered repository gets a run-scoped binding and no active project", async () => {
    const harness = makeHarness();
    const other = makeRepo({ "x.txt": "1\n" });

    const created = harness.cp.runs.create({
      executionMode: ExecutionMode.SIMPLE,
      contract: CONTRACT,
    });
    if (!created.allowed) throw new Error(created.message);

    const temporary = await harness.cp.repositories.registerTemporary(other, created.value.runId);
    expect(temporary.allowed).toBe(true);
    if (!temporary.allowed) return;

    expect(temporary.value.registration).toBe("TEMPORARY");
    expect(temporary.value.temporaryForRun).toBe(created.value.runId);
    expect(temporary.value.projectId).toBeNull();
    expect(harness.cp.projects.list()).toHaveLength(0);
  });

  it("CP-S06: a project cannot hold two active primary CTO bindings", async () => {
    const harness = makeHarness();
    const { projectId } = await registerFixtureProject(harness);
    const roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId });

    const first = harness.cp.sessions.create({ provider: "scripted", model: "scripted-cto" });
    harness.cp.sessions.transition(first.sessionId, SessionLifecycle.READY, "test");
    expect(
      harness.cp.bindings.bind({ roleKey, role: Role.PRIMARY_CTO, sessionId: first.sessionId, projectId })
        .allowed,
    ).toBe(true);

    const second = harness.cp.sessions.create({ provider: "scripted", model: "scripted-cto" });
    harness.cp.sessions.transition(second.sessionId, SessionLifecycle.READY, "test");
    const conflict = harness.cp.bindings.bind({
      roleKey,
      role: Role.PRIMARY_CTO,
      sessionId: second.sessionId,
      projectId,
    });
    expect(conflict.allowed).toBe(false);
    expect(conflict.reasonCode).toBe(ReasonCode.BINDING_ALREADY_ACTIVE);
  });
});

describe("CTO lifecycle (CP-S07 – CP-S11)", () => {
  it("CP-S07: a run against a CTO-less project provisions a fresh CTO and turns it ACTIVE", async () => {
    const harness = makeHarness();
    const { projectId, repositoryId } = await registerFixtureProject(harness);
    expect(harness.cp.projects.require(projectId).activity).toBe("INACTIVE");

    const run = await newRun(harness, projectId, repositoryId);
    const dispatched = await harness.cp.runs.dispatch(run.runId);
    expect(dispatched.allowed).toBe(true);
    if (!dispatched.allowed) return;

    expect(dispatched.value.ownerSessionId).toBeTruthy();
    expect(dispatched.value.ownerBindingGeneration).toBe(1);
    expect(harness.cp.projects.require(projectId).activity).toBe("ACTIVE");
    expect(harness.cp.audit.byKind("PRIMARY_CTO_ACTIVATED")).toHaveLength(1);
  });

  it("CP-S08 / CP-S09: a replacement drains the CTO and new runs stay QUEUED", async () => {
    const harness = makeHarness();
    const { projectId, repositoryId } = await registerFixtureProject(harness);
    const first = await newRun(harness, projectId, repositoryId);
    const dispatched = await harness.cp.runs.dispatch(first.runId);
    if (!dispatched.allowed) throw new Error(dispatched.message);

    const replacement = harness.cp.cto.requestReplacement(projectId, "operator request");
    expect(replacement.allowed).toBe(true);
    if (!replacement.allowed) return;
    expect(replacement.value.draining).toBe(true);
    expect(replacement.value.activeRuns).toBe(1);
    expect(harness.cp.cto.isDraining(projectId)).toBe(true);

    // CP-S09 — a new run is admitted no further than QUEUED while the CTO drains.
    const second = await newRun(harness, projectId, repositoryId);
    const blocked = await harness.cp.runs.dispatch(second.runId);
    expect(blocked.allowed).toBe(false);
    expect(blocked.reasonCode).toBe(ReasonCode.RUN_DISPATCH_BLOCKED_CTO_DRAINING);
    expect(harness.cp.runs.require(second.runId).state).toBe(RunState.QUEUED);
  });

  it("CP-S08: switchover is refused while the outgoing CTO still owns active runs", async () => {
    const harness = makeHarness();
    const { projectId, repositoryId } = await registerFixtureProject(harness);
    const run = await newRun(harness, projectId, repositoryId);
    const dispatched = await harness.cp.runs.dispatch(run.runId);
    if (!dispatched.allowed) throw new Error(dispatched.message);
    harness.cp.cto.requestReplacement(projectId, "operator request");

    const refused = await harness.cp.cto.prepareSwitchover(projectId, HANDOFF);
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.SWITCHOVER_BLOCKED_ACTIVE_RUNS);
  });

  it("CP-S10: the old binding stays in force until HANDOFF_ACK, then switches atomically", async () => {
    const harness = makeHarness();
    harness.cp.cto.attach({
      handoffAuthentication: { verifyHandoffAcknowledgement: () => allow(ReasonCode.OK, undefined) },
    });
    const { projectId, repositoryId } = await registerFixtureProject(harness);
    const run = await newRun(harness, projectId, repositoryId);
    const dispatched = await harness.cp.runs.dispatch(run.runId);
    if (!dispatched.allowed) throw new Error(dispatched.message);
    harness.cp.runs.cancel(run.runId, "make way for switchover");

    harness.cp.cto.requestReplacement(projectId, "operator request");
    const prepared = await harness.cp.cto.prepareSwitchover(projectId, HANDOFF);
    expect(prepared.allowed).toBe(true);
    if (!prepared.allowed) return;

    const roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId });
    const beforeAck = harness.cp.bindings.require(roleKey);
    expect(beforeAck.sessionId).toBe(dispatched.value.ownerSessionId);
    expect(beforeAck.bindingGeneration).toBe(1);

    const acked = harness.cp.cto.acknowledgeHandoff(
      prepared.value.handoffId,
      deliveredHandoffAck(harness, prepared.value.handoffId, prepared.value.incomingSessionId),
    );
    expect(acked.allowed).toBe(true);
    if (!acked.allowed) return;

    expect(acked.value.sessionId).toBe(prepared.value.incomingSessionId);
    expect(acked.value.bindingGeneration).toBe(2);
    expect(harness.cp.sessions.require(beforeAck.sessionId).lifecycle).toBe(SessionLifecycle.STOPPED);
    expect(harness.cp.audit.byKind("HANDOFF_ACK")).toHaveLength(1);
  });

  it("CP-S10: an ack from the wrong session cannot switch the binding", async () => {
    const harness = makeHarness();
    const { projectId } = await registerFixtureProject(harness);
    const provisioned = await harness.cp.cto.ensurePrimaryCto(projectId, "setup");
    if (!provisioned.allowed) throw new Error(provisioned.message);
    harness.cp.cto.requestReplacement(projectId, "operator request");
    const prepared = await harness.cp.cto.prepareSwitchover(projectId, HANDOFF);
    if (!prepared.allowed) throw new Error(prepared.message);

    const message = harness.cp.outbox.byIdempotencyKey(`handoff:${prepared.value.handoffId}`)!;
    const wrong = harness.cp.cto.acknowledgeHandoff(prepared.value.handoffId, {
      sessionId: "ses_imposter",
      sessionIncarnation: "ses_imposter#1",
      bindingGeneration: message.bindingGeneration,
      messageId: message.messageId,
      payloadDigest: message.payloadDigest,
      sessionSecret: "not-relevant",
    });
    expect(wrong.allowed).toBe(false);
    expect(wrong.reasonCode).toBe(ReasonCode.HANDOFF_ACK_REQUIRED);
    expect(harness.cp.bindings.require(roleKeyFor(Role.PRIMARY_CTO, { projectId })).bindingGeneration).toBe(1);
  });

  it("CP-S11: recovery takeover repoints the run and makes late results audit-only", async () => {
    const harness = makeHarness();
    const { projectId, repositoryId } = await registerFixtureProject(harness);
    const run = await newRun(harness, projectId, repositoryId);
    const dispatched = await harness.cp.runs.dispatch(run.runId);
    if (!dispatched.allowed) throw new Error(dispatched.message);

    const deadSession = dispatched.value.ownerSessionId!;
    const deadGeneration = dispatched.value.ownerBindingGeneration!;

    // A healthy session must not be taken over; that is a replacement, not a recovery.
    const refused = await harness.cp.cto.recoveryTakeover(projectId, "premature");
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.RECOVERY_TAKEOVER_REQUIRES_UNREACHABLE_OWNER);

    harness.cp.sessions.transition(deadSession, SessionLifecycle.ERROR, "runtime died");
    const recovered = await harness.cp.cto.recoveryTakeover(projectId, "session unreachable");
    expect(recovered.allowed).toBe(true);
    if (!recovered.allowed) return;

    const reassigned = harness.cp.runs.require(run.runId);
    expect(reassigned.ownerSessionId).toBe(recovered.value.sessionId);
    expect(reassigned.ownerBindingGeneration).toBe(2);

    // A result arriving under the dead generation changes nothing.
    const late = harness.cp.runs.assertOwner(run.runId, deadSession, deadGeneration);
    expect(late.allowed).toBe(false);
    expect(late.reasonCode).toBe(ReasonCode.RUN_OWNER_REVOKED);
    expect(harness.cp.audit.byKind("RECOVERY_TAKEOVER").length).toBeGreaterThan(0);
  });

  it("CP-S55: an owner decision moves the run through AWAITING_HUMAN and back", async () => {
    const harness = makeHarness();
    const { projectId, repositoryId } = await registerFixtureProject(harness);
    bindCeo(harness);

    const created = harness.cp.runs.create({
      projectId,
      executionMode: ExecutionMode.GUARDED,
      contract: { ...CONTRACT, humanGate: ["public release"] },
      repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
    });
    if (!created.allowed) throw new Error(created.message);
    const dispatched = await harness.cp.runs.dispatch(created.value.runId);
    if (!dispatched.allowed) throw new Error(dispatched.message);

    expect(harness.cp.ceo.humanGateStatus(created.value.runId)).toEqual({
      required: true,
      items: ["public release"],
      satisfied: false,
    });

    harness.cp.runs.transition(created.value.runId, RunState.AWAITING_HUMAN, "owner decision needed");
    const approved = harness.cp.ceo.recordOwnerDecision({
      runId: created.value.runId,
      item: "public release",
      approved: true,
      note: "approved by owner",
      receipt: ownerDecisionReceipt(harness, created.value.runId, "public release", true, "approved by owner"),
    });
    expect(approved.allowed).toBe(true);
    expect(harness.cp.ceo.humanGateStatus(created.value.runId).satisfied).toBe(true);
    expect(harness.cp.runs.require(created.value.runId).state).toBe(RunState.ACTIVE);
  });

  it("suspending a project requires owner approval and removes the CTO binding", async () => {
    const harness = makeHarness();
    const { projectId } = await registerFixtureProject(harness);
    await harness.cp.cto.ensurePrimaryCto(projectId, "setup");

    const refused = await harness.cp.cto.suspendProject(projectId, false, "capacity crisis");
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.HUMAN_GATE_REQUIRED);

    const suspended = await harness.cp.cto.suspendProject(projectId, true, "capacity crisis", TEST_OWNER);
    expect(suspended.allowed).toBe(true);
    expect(harness.cp.projects.require(projectId).suspended).toBe(true);
    expect(harness.cp.projects.require(projectId).activity).toBe("INACTIVE");
    expect(harness.cp.bindings.activePrimaryCto(projectId)).toBeNull();
  });

  it("CP-S04: a manifest carrying an absolute path is refused at registration", () => {
    const harness = makeHarness();
    const manifest = fixtureManifest("bad-project");
    const broken = {
      ...manifest,
      repositories: [{ role: "primary", remote: "/Users/example/projects/x", manifestRoot: "." }],
    };
    const stored = harness.cp.projects.storeManifest(broken);
    expect(stored.allowed).toBe(false);
    expect(stored.reasonCode).toBe(ReasonCode.MANIFEST_NOT_PORTABLE);
  });

  it("CP-HI-03: replacing an active manifest outside a CONTRACT_CHANGE run is refused", async () => {
    const harness = makeHarness();
    const { projectId } = await registerFixtureProject(harness);
    const revised = { ...fixtureManifest(projectId), postMergeCommands: ["verify"] };

    const refused = harness.cp.projects.activateManifest(projectId, revised, {
      runKind: "STANDARD_WORK",
      runId: null,
    });
    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.CONTRACT_CHANGE_REQUIRES_DEDICATED_RUN);

    // A CONTRACT_CHANGE *label* is not enough: the change must be carried by a real
    // contract-change run for this project that completed.
    const unbacked = harness.cp.projects.activateManifest(projectId, revised, {
      runKind: "CONTRACT_CHANGE",
      runId: null,
    });
    expect(unbacked.allowed).toBe(false);
    expect(unbacked.reasonCode).toBe(ReasonCode.CONTRACT_CHANGE_REQUIRES_DEDICATED_RUN);

    const change = harness.cp.runs.create({
      projectId,
      kind: "CONTRACT_CHANGE",
      executionMode: ExecutionMode.GUARDED,
      contract: { ...CONTRACT, goal: "revise the project contract" },
    });
    if (!change.allowed) throw new Error(change.message);
    const revisedDigest = harness.cp.projects.storeManifest(revised);
    if (!revisedDigest.allowed) throw new Error(revisedDigest.message);
    const candidateSnapshotDigest = digestOf({ runId: change.value.runId, manifest: revisedDigest.value });
    harness.cp.runs.transition(change.value.runId, RunState.ACTIVE, "contract change started");
    harness.cp.db.run(`UPDATE runs SET current_candidate_digest = ? WHERE run_id = ?`, [
      candidateSnapshotDigest,
      change.value.runId,
    ]);
    harness.cp.runs.transition(
      change.value.runId,
      RunState.READY_FOR_CEO_REVIEW,
      "contract change ready",
    );
    // Standing in for the CEO gate, which is the only production caller allowed to write
    // COMPLETED; the point under test is what the *activation* then accepts.
    harness.cp.runs.transition(
      change.value.runId,
      RunState.COMPLETED,
      "contract change confirmed",
      {},
      harness.cp.completionAuthoritiesForTests().productionGate,
    );
    const grant = {
      schema: "acp.manifest-activation-grant.v1",
      projectId,
      runId: change.value.runId,
      runKind: "CONTRACT_CHANGE",
      manifestDigest: revisedDigest.value,
      candidateSnapshotDigest,
    };
    harness.cp.db.run(
      `INSERT INTO run_artifacts (artifact_id, run_id, kind, digest, candidate_snapshot_digest,
                                  content_json, produced_by, created_at)
       VALUES (?, ?, 'APPROVAL', ?, ?, ?, 'production-gate', ?)`,
      [
        `art_manifest_${change.value.runId.slice(-12)}`,
        change.value.runId,
        digestOf(grant),
        candidateSnapshotDigest,
        JSON.stringify(grant),
        harness.clock.nowIso(),
      ],
    );

    const unknownRun = harness.cp.projects.activateManifest(projectId, revised, {
      runKind: "CONTRACT_CHANGE",
      runId: "run_does_not_exist",
    });
    expect(unknownRun.allowed).toBe(false);

    const allowed = harness.cp.projects.activateManifest(projectId, revised, {
      runKind: "CONTRACT_CHANGE",
      runId: change.value.runId,
    });
    expect(allowed.allowed).toBe(true);
  });
});
