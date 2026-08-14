import { afterAll, describe, expect, it } from "vitest";
import { join } from "node:path";

import { type HandoffAcknowledgement, type HandoffPackage } from "../../src/cto/cto-lifecycle.ts";
import { digestOf } from "../../src/core/digest.ts";
import { allow, deny } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ExecutionMode, RunState, SessionLifecycle } from "../../src/domain/types.ts";
import { cleanupTempDirs, commitAll, makeRepo, writeFiles } from "../helpers/fixtures.ts";
import {
  TEST_OWNER,
  type Harness,
  finalizeNoRepositoryRun,
  fixtureManifest,
  makeHarness,
  manifestAuthorizationForRun,
  registerFixtureProject,
} from "../helpers/harness.ts";
import type { TaskContract } from "../../src/run/run-engine.ts";

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
