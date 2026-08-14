import { afterAll, describe, expect, it, vi } from "vitest";
import { join } from "node:path";

import { deny } from "../../src/core/errors.ts";
import { digestOf } from "../../src/core/digest.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { IngressGuard, ownerApprovalPayload } from "../../src/ingress/ingress-guard.ts";
import { WriteOperation } from "../../src/guard/managed-write-guard.ts";
import {
  ArtifactKind,
  ExecutionMode,
  Role,
  RunKind,
  RunState,
  SessionLifecycle,
  roleKeyFor,
} from "../../src/domain/types.ts";
import type { ReviewPacket } from "../../src/review/blind-review.ts";
import type { TaskContract } from "../../src/run/run-engine.ts";
import type { VerificationReport } from "../../src/verify/verification-engine.ts";
import { candidateSnapshotDigest } from "../../src/snapshot/candidate-snapshot.ts";
import { cleanupTempDirs, commitAll, makeRepo, writeFiles } from "../helpers/fixtures.ts";
import { TEST_OWNER, bindCeo, bindWorker, makeHarness, registerFixtureProject } from "../helpers/harness.ts";
import { testReviewerEgressEvidence } from "../helpers/production-adapter.ts";

afterAll(cleanupTempDirs);

const CONTRACT = (humanGate: string[] = []): TaskContract => ({
  goal: "gate hardening",
  why: "regression coverage",
  scope: ["src/app.js"],
  nonGoals: [],
  acceptance: ["a valid packet is possible"],
  priority: "NORMAL",
  humanGate,
  references: [],
});

const activeRun = async (
  humanGate: string[] = [],
  options: { executionMode?: ExecutionMode; contract?: Partial<TaskContract> } = {},
) => {
  const harness = makeHarness();
  const registered = await registerFixtureProject(harness);
  const ceoSessionId = bindCeo(harness);
  const contract = {
    ...CONTRACT(humanGate),
    ...options.contract,
    humanGate: options.contract?.humanGate ?? humanGate,
  };
  const created = harness.cp.runs.create({
    projectId: registered.projectId,
    executionMode: options.executionMode ?? ExecutionMode.STANDARD,
    contract,
    repositories: [{ repositoryId: registered.repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
  });
  if (!created.allowed) throw new Error(created.message);
  const dispatched = await harness.cp.runs.dispatch(created.value.runId);
  if (!dispatched.allowed) throw new Error(dispatched.message);
  return { harness, ...registered, ceoSessionId, run: dispatched.value, runId: created.value.runId };
};

const evidenceReadyRun = async (
  humanGate: string[] = [],
  options: { executionMode?: ExecutionMode; contract?: Partial<TaskContract> } = {},
) => {
  const fixture = await activeRun(humanGate, options);
  const frozen = await fixture.harness.cp.pipeline.freeze(fixture.runId);
  if (!frozen.allowed) throw new Error(frozen.message);
  const snapshot = frozen.value;
  const digest = candidateSnapshotDigest(snapshot);
  const repository = snapshot.repositories[0]!;
  const report: VerificationReport = {
    runId: fixture.runId,
    candidateSnapshotDigest: digest,
    contractDigest: fixture.run.contractDigest,
    expectedInputs: 1,
    observedInputs: 1,
    results: [{
      commandId: "verify",
      repositoryIdentity: repository.identity,
      source: "local",
      exactHead: repository.candidateHead,
      startedAt: fixture.harness.clock.nowIso(),
      endedAt: fixture.harness.clock.nowIso(),
      exitCode: 0,
      outputDigest: "sha256:verification-output",
      outputTruncated: false,
      status: "PASS",
      reasonCode: null,
    }],
    status: "PASS",
    reasonCode: ReasonCode.OK,
    gaps: [],
  };
  fixture.harness.cp.db.run(
    `INSERT INTO verification_results
       (result_id, run_id, candidate_snapshot_digest, command_id, repository_identity, source,
        exact_head, started_at, ended_at, exit_code, output_digest, output_truncated, status, reason_code)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      `${digest}:verify`, fixture.runId, digest, "verify", repository.identity, "local",
      repository.candidateHead, fixture.harness.clock.nowIso(), fixture.harness.clock.nowIso(), 0,
      "sha256:verification-output", 0, "PASS", null,
    ],
  );
  fixture.harness.cp.artifacts.putEvidence(
    fixture.harness.cp.evidenceWritersForTests().VERIFICATION, fixture.runId, ArtifactKind.VERIFICATION, report, digest,
  );

  const reviewer = fixture.harness.cp.sessions.create({ provider: "scripted", model: "reviewer" });
  fixture.harness.cp.sessions.transition(reviewer.sessionId, SessionLifecycle.READY, "test reviewer");
  const reviewerBinding = fixture.harness.cp.bindings.bind({
    roleKey: roleKeyFor(Role.BLIND_REVIEWER, { runId: fixture.runId }),
    role: Role.BLIND_REVIEWER,
    runId: fixture.runId,
    sessionId: reviewer.sessionId,
  });
  if (!reviewerBinding.allowed) throw new Error(reviewerBinding.message);
  const review: ReviewPacket = {
    runId: fixture.runId,
    candidateSnapshotDigest: digest,
    contractDigest: fixture.run.contractDigest,
    reviewerRoleBindingGeneration: reviewerBinding.value.bindingGeneration,
    reviewerSessionId: reviewer.sessionId,
    reviewerSessionIncarnation: reviewer.incarnation,
    reviewerProviderSessionId: reviewer.sessionId,
    provider: "scripted",
    model: "reviewer",
    effort: null,
    egressEvidence: testReviewerEgressEvidence("scripted"),
    inputManifest: {
      contract: true,
      snapshotManifest: true,
      diff: true,
      verificationEvidence: true,
      projectContext: true,
      binaryArtifacts: [],
      withheld: [],
    },
    coveredRepositories: [repository.identity],
    coveredFiles: [],
    omittedItems: [],
    verdict: "PASS",
    findings: [],
    chunked: false,
    createdAt: fixture.harness.clock.nowIso(),
  };
  fixture.harness.cp.artifacts.putEvidence(
    fixture.harness.cp.evidenceWritersForTests().BLIND_REVIEW, fixture.runId, ArtifactKind.BLIND_REVIEW, review, digest,
  );
  await fixture.harness.cp.continuity.evaluate("test evidence");
  const approval = {
    runId: fixture.runId,
    candidateSnapshotDigest: digest,
    resultSummary: "done",
    recommendation: "ship",
    residualRisk: [],
    approvedBySessionId: fixture.run.ownerSessionId!,
    approvedByGeneration: fixture.run.ownerBindingGeneration!,
    approvedAt: fixture.harness.clock.nowIso(),
  };
  return { ...fixture, snapshot, digest, report, approval };
};

const buildPacket = (fixture: Awaited<ReturnType<typeof evidenceReadyRun>>) => {
  const packet = fixture.harness.cp.ceo.buildPacket({
    runId: fixture.runId,
    candidateSnapshotDigest: fixture.digest,
    approval: fixture.approval,
  });
  if (!packet.allowed) throw new Error(`${packet.reasonCode}: ${packet.message}`);
  return packet.value;
};

const ownerDecisionReceipt = (
  harness: Awaited<ReturnType<typeof evidenceReadyRun>>["harness"],
  runId: string,
  item: string,
  approved: boolean,
  note: string,
) => {
  const guard = new IngressGuard(harness.cp.db, harness.cp.clock, harness.cp.audit, {
    cli: { allowedActors: [TEST_OWNER.actor] },
  });
  const approval = {
    runId,
    candidateSnapshotDigest: harness.cp.runs.currentCandidate(runId),
    operation: "owner_decision_submit",
    parameters: { item, approved, note },
    idempotencyKey: `owner-decision:${digestOf({ runId, item, approved, note })}`,
    approved,
  };
  const receipt = guard.admitOwnerApproval({
    channel: TEST_OWNER.channel,
    actor: TEST_OWNER.actor,
    nonce: `owner-decision:${digestOf(approval)}`,
    payload: ownerApprovalPayload(approval),
  }, approval);
  if (!receipt.allowed) throw new Error(receipt.message);
  return receipt.value;
};

describe("round-2 run and production-gate regressions", () => {
  it("#102 refuses a caller-supplied local owner identity", async () => {
    const fixture = await evidenceReadyRun(["public release"]);
    const forged = fixture.harness.cp.ceo.recordOwnerDecision({
      runId: fixture.runId,
      item: "public release",
      approved: true,
      note: "forged local tuple",
      owner: TEST_OWNER,
    });
    expect(forged.allowed).toBe(false);
    expect(forged.reasonCode).toBe(ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE);
    expect(fixture.harness.cp.ceo.humanGateStatus(fixture.runId).satisfied).toBe(false);
    expect(fixture.harness.cp.artifacts.list(fixture.runId, ArtifactKind.APPROVAL)).toHaveLength(0);
  });

  it("#131 rejects packet publication with a forged or released source-read lease", async () => {
    const fixture = await evidenceReadyRun();
    const forged = fixture.harness.cp.ceo.buildPacket({
      runId: fixture.runId,
      candidateSnapshotDigest: fixture.digest,
      approval: fixture.approval,
      sourceReadLeaseId: "source_read_forged",
    });
    expect(forged.allowed).toBe(false);
    expect(forged.reasonCode).toBe(ReasonCode.SOURCE_READ_LEASE_REQUIRED);

    const held = fixture.harness.cp.guard.acquireSourceReadLease(fixture.runId, [fixture.identity]);
    if (!held.allowed) throw new Error(held.message);
    const mutation = fixture.harness.cp.guard.evaluate({
      operation: WriteOperation.FILE_MUTATION,
      targetPath: join(fixture.harness.repoPath, "src", "app.js"),
      runId: fixture.runId,
      sessionId: fixture.run.ownerSessionId,
      bindingGeneration: fixture.run.ownerBindingGeneration,
    });
    expect(mutation.allowed).toBe(false);
    // The mutation collided with a live lease. SOURCE_READ_LEASE_HELD is the other
    // direction of the same window — acquisition refused because a write already holds the
    // source — so the two conditions keep distinct codes.
    expect(mutation.reasonCode).toBe(ReasonCode.SOURCE_READ_LEASE_CONFLICT);
    held.value.release();
  });

  it("#138 seals repository participation after a candidate is frozen", async () => {
    const fixture = await evidenceReadyRun();
    const secondPath = makeRepo({ "README.md": "second\n" });
    const second = await fixture.harness.cp.repositories.register({
      checkoutPath: secondPath,
      projectId: fixture.projectId,
      repositoryRole: "secondary",
      identity: "local:second",
    });
    if (!second.allowed) throw new Error(second.message);

    const attached = fixture.harness.cp.runs.attachRepository(fixture.runId, {
      repositoryId: second.value.repositoryId,
      repositoryRole: "secondary",
      baseBranch: "dev",
      ownerSessionId: fixture.run.ownerSessionId!,
      ownerBindingGeneration: fixture.run.ownerBindingGeneration!,
    });
    expect(attached.allowed).toBe(true);
    expect(fixture.harness.cp.runs.currentCandidate(fixture.runId)).toBeNull();
    expect(fixture.harness.cp.artifacts.latestForSnapshot(
      fixture.runId, ArtifactKind.VERIFICATION, fixture.digest,
    )).toBeNull();
  });

  it("#139 sends the immutable manifest pin in the dispatch envelope", async () => {
    const fixture = await activeRun();
    const created = fixture.harness.cp.runs.create({
      projectId: fixture.projectId,
      executionMode: ExecutionMode.STANDARD,
      contract: CONTRACT(),
      repositories: [{ repositoryId: fixture.repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
    });
    if (!created.allowed) throw new Error(created.message);
    const revisedManifest = {
      ...fixture.harness.cp.projects.activeManifest(fixture.projectId)!.manifest,
      postMergeCommands: ["verify"],
    };
    const stored = fixture.harness.cp.projects.storeManifest(
      revisedManifest,
      fixture.harness.cp.manifestAuthorizationForTests(revisedManifest),
    );
    if (!stored.allowed) throw new Error(stored.message);
    const pin = stored.value;
    expect(fixture.harness.cp.runs.pinManifest(created.value.runId, pin).allowed).toBe(true);
    const dispatched = await fixture.harness.cp.runs.dispatch(created.value.runId);
    if (!dispatched.allowed) throw new Error(dispatched.message);
    expect(dispatched.value.pinnedManifestDigest).toBe(pin);
    const message = fixture.harness.cp.outbox.listByRun(created.value.runId)
      .find((entry) => entry.kind === "RUN_DISPATCH");
    expect((message?.payload as { pinnedManifestDigest?: string }).pinnedManifestDigest).toBe(pin);
  });

  it("#140 rejects a late execution result from an old owner generation", async () => {
    const fixture = await activeRun();
    const submitted = fixture.harness.cp.tasks.submit(fixture.runId, [
      { key: "work", title: "work", category: "implementation" },
    ]);
    if (!submitted.allowed) throw new Error(submitted.message);
    const task = fixture.harness.cp.tasks.ready(fixture.runId)[0]!;
    const workerSessionId = bindWorker(fixture.harness, task.taskId);
    const execution = fixture.harness.cp.tasks.startExecution({
      runId: fixture.runId,
      taskId: task.taskId,
      ownerBindingGeneration: fixture.run.ownerBindingGeneration!,
      workerSessionId,
      provider: "scripted",
      model: "worker",
    });
    if (!execution.allowed) throw new Error(execution.message);
    const replacement = fixture.harness.cp.sessions.create({ provider: "scripted", model: "replacement" });
    fixture.harness.cp.sessions.transition(replacement.sessionId, SessionLifecycle.READY, "takeover");
    const takeover = fixture.harness.cp.bindings.switchTo({
      roleKey: fixture.run.ownerRoleKey!,
      role: Role.PRIMARY_CTO,
      projectId: fixture.projectId,
      sessionId: replacement.sessionId,
      mode: "FALLBACK",
      reason: "test takeover",
      takeover: true,
    });
    expect(takeover.allowed).toBe(true);
    const late = fixture.harness.cp.tasks.finishExecution(execution.value.executionId, {
      status: "SUCCEEDED",
      resultDigest: "sha256:late",
    });
    expect(late.allowed).toBe(false);
    expect(late.reasonCode).toBe(ReasonCode.BINDING_GENERATION_STALE);
    expect(fixture.harness.cp.tasks.execution(execution.value.executionId)?.status).toBe("ABANDONED");
    expect(fixture.harness.cp.tasks.get(task.taskId)?.state).toBe("READY");
  });

  it("#141 stales the packet when the candidate head moves before CEO confirmation", async () => {
    const fixture = await evidenceReadyRun();
    buildPacket(fixture);
    writeFiles(fixture.harness.repoPath, { "README.md": "changed after review\n" });
    commitAll(fixture.harness.repoPath, "move candidate after review");
    const confirmed = fixture.harness.cp.ceo.submitCeoDecision({
      runId: fixture.runId,
      decision: "CONFIRM",
      candidateSnapshotDigest: fixture.digest,
      ceoSessionId: fixture.ceoSessionId,
      rationale: "stale attack",
    });
    expect(confirmed.allowed).toBe(false);
    expect(confirmed.reasonCode).toBe(ReasonCode.SNAPSHOT_STALE);
    expect(fixture.harness.cp.runs.require(fixture.runId).state).toBe(RunState.ACTIVE);
  });

  it("#142 refuses CEO confirmation after continuity enters SURVIVAL", async () => {
    const fixture = await evidenceReadyRun();
    buildPacket(fixture);
    fixture.harness.cp.ceo.attach({
      continuity: {
        mode: () => "SURVIVAL",
        assertCompletionAllowed: () => deny(ReasonCode.CONTINUITY_SURVIVAL_NO_COMPLETION, "SURVIVAL"),
      },
    });
    const confirmed = fixture.harness.cp.ceo.submitCeoDecision({
      runId: fixture.runId,
      decision: "CONFIRM",
      candidateSnapshotDigest: fixture.digest,
      ceoSessionId: fixture.ceoSessionId,
      rationale: "survival attack",
    });
    expect(confirmed.allowed).toBe(false);
    expect(confirmed.reasonCode).toBe(ReasonCode.CONTINUITY_SURVIVAL_NO_COMPLETION);
  });

  it("#143 denies CEO confirmation after an owner rejection revokes an earlier approval", async () => {
    const fixture = await evidenceReadyRun(["public release"]);
    const approved = ownerDecisionReceipt(fixture.harness, fixture.runId, "public release", true, "yes");
    expect(fixture.harness.cp.ceo.recordOwnerDecision({
      runId: fixture.runId, item: "public release", approved: true, note: "yes", receipt: approved,
    }).allowed).toBe(true);
    expect(fixture.harness.cp.ceo.humanGateStatus(fixture.runId).satisfied).toBe(true);
    buildPacket(fixture);

    const rejected = ownerDecisionReceipt(fixture.harness, fixture.runId, "public release", false, "no");
    expect(fixture.harness.cp.ceo.recordOwnerDecision({
      runId: fixture.runId, item: "public release", approved: false, note: "no", receipt: rejected,
    }).allowed).toBe(true);
    expect(fixture.harness.cp.ceo.humanGateStatus(fixture.runId).satisfied).toBe(false);

    const confirmed = fixture.harness.cp.ceo.submitCeoDecision({
      runId: fixture.runId,
      decision: "CONFIRM",
      candidateSnapshotDigest: fixture.digest,
      ceoSessionId: fixture.ceoSessionId,
      rationale: "owner withdrew approval",
    });
    expect(confirmed.allowed).toBe(false);
    expect(confirmed.reasonCode).toBe(ReasonCode.HUMAN_GATE_UNSATISFIED);
  });

  it("#373 refuses an owner decision before freeze and supersedes legacy null-bound approvals", async () => {
    const fixture = await activeRun(["public release"]);
    const premature = fixture.harness.cp.ceo.recordOwnerDecision({
      runId: fixture.runId,
      item: "public release",
      approved: true,
      note: "approve a candidate that does not exist yet",
      receipt: ownerDecisionReceipt(
        fixture.harness,
        fixture.runId,
        "public release",
        true,
        "approve a candidate that does not exist yet",
      ),
    });
    expect(premature.allowed).toBe(false);
    expect(premature.reasonCode).toBe(ReasonCode.EVIDENCE_STALE);
    expect(fixture.harness.cp.artifacts.list(fixture.runId, ArtifactKind.APPROVAL)).toHaveLength(0);

    // A row from before this hardening must not remain usable once a candidate is promoted.
    const legacy = fixture.harness.cp.artifacts.put(fixture.runId, ArtifactKind.APPROVAL, {
      kind: "OWNER_DECISION",
      item: "public release",
      approved: true,
      note: "legacy unbound approval",
      at: fixture.harness.clock.nowIso(),
      humanGateDigest: digestOf(["public release"]),
      candidateSnapshotDigest: null,
    });
    const frozen = await fixture.harness.cp.pipeline.freeze(fixture.runId);
    if (!frozen.allowed) throw new Error(frozen.message);

    expect(fixture.harness.cp.artifacts.list(fixture.runId, ArtifactKind.APPROVAL)
      .find((artifact) => artifact.artifactId === legacy.artifactId)?.superseded).toBe(true);
    const lateLegacy = fixture.harness.cp.artifacts.put(fixture.runId, ArtifactKind.APPROVAL, {
      kind: "OWNER_DECISION",
      item: "public release",
      approved: true,
      note: "legacy row inserted after candidate promotion",
      at: fixture.harness.clock.nowIso(),
      humanGateDigest: digestOf(["public release"]),
      candidateSnapshotDigest: null,
    });
    expect(lateLegacy.superseded).toBe(false);
    expect(fixture.harness.cp.ceo.humanGateStatus(fixture.runId)).toEqual({
      required: true,
      items: ["public release"],
      satisfied: false,
    });
  });

  it("#381 retains the admitted owner receipt so its decision satisfies the durable human gate", async () => {
    const fixture = await evidenceReadyRun(["public release"]);
    const receipt = ownerDecisionReceipt(
      fixture.harness,
      fixture.runId,
      "public release",
      true,
      "approved after reviewing the release",
    );

    const recorded = fixture.harness.cp.ceo.recordOwnerDecision({
      runId: fixture.runId,
      item: "public release",
      approved: true,
      note: "approved after reviewing the release",
      receipt,
    });
    expect(recorded.allowed).toBe(true);

    const stored = fixture.harness.cp.artifacts
      .list<{ receipt?: unknown }>(fixture.runId, ArtifactKind.APPROVAL)
      .at(-1);
    expect(stored?.content.receipt).toEqual(receipt);
    expect(fixture.harness.cp.ceo.humanGateStatus(fixture.runId)).toEqual({
      required: true,
      items: ["public release"],
      satisfied: true,
    });
  });

  it("#P1-18 consumes an admitted owner receipt on direct reuse", async () => {
    const fixture = await evidenceReadyRun(["public release"]);
    const receipt = ownerDecisionReceipt(fixture.harness, fixture.runId, "public release", true, "approve once");
    const first = fixture.harness.cp.ceo.recordOwnerDecision({
      runId: fixture.runId,
      item: "public release",
      approved: true,
      note: "approve once",
      receipt,
    });
    expect(first.allowed).toBe(true);

    const reused = fixture.harness.cp.ceo.recordOwnerDecision({
      runId: fixture.runId,
      item: "public release",
      approved: true,
      note: "approve once",
      receipt,
    });
    expect(reused.allowed).toBe(false);
    expect(reused.reasonCode).toBe(ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE);
    expect(fixture.harness.cp.audit.byKind("OWNER_APPROVAL_CONSUMED")).toHaveLength(1);
    expect(fixture.harness.cp.artifacts.list(fixture.runId, ArtifactKind.APPROVAL)).toHaveLength(1);
  });

  it("#P1-18 refuses first presentation after the receipt's candidate moved", async () => {
    const fixture = await evidenceReadyRun(["public release"]);
    expect(ownerApprovalPayload({
      runId: fixture.runId,
      candidateSnapshotDigest: fixture.digest,
      operation: "owner_decision_submit",
      parameters: { item: "public release", approved: true, note: "candidate A" },
      idempotencyKey: "payload-binding-probe",
      approved: true,
    })).toMatchObject({ candidateSnapshotDigest: fixture.digest });
    const receipt = ownerDecisionReceipt(fixture.harness, fixture.runId, "public release", true, "candidate A");
    const candidateB = digestOf({ revisedFrom: fixture.digest, revision: 2 });
    fixture.harness.cp.runs.promoteCandidate(fixture.runId, candidateB);

    const presentedOnB = fixture.harness.cp.ceo.recordOwnerDecision({
      runId: fixture.runId,
      item: "public release",
      approved: true,
      note: "candidate A",
      receipt,
    });
    expect(presentedOnB.allowed).toBe(false);
    expect(presentedOnB.reasonCode).toBe(ReasonCode.EVIDENCE_STALE);
    expect(fixture.harness.cp.artifacts.list(fixture.runId, ArtifactKind.APPROVAL)).toHaveLength(0);
    // This is the first-use assertion: the stale receipt was refused before the existing
    // single-use consumption record could be written.
    expect(fixture.harness.cp.audit.byKind("OWNER_APPROVAL_CONSUMED")).toHaveLength(0);
  });

  it("#P1-18 refuses an admitted receipt replayed onto a revised candidate", async () => {
    const fixture = await evidenceReadyRun(["public release"]);
    const receipt = ownerDecisionReceipt(fixture.harness, fixture.runId, "public release", true, "candidate A");
    const first = fixture.harness.cp.ceo.recordOwnerDecision({
      runId: fixture.runId,
      item: "public release",
      approved: true,
      note: "candidate A",
      receipt,
    });
    expect(first.allowed).toBe(true);

    const candidateB = digestOf({ revisedFrom: fixture.digest, revision: 1 });
    fixture.harness.cp.runs.promoteCandidate(fixture.runId, candidateB);
    expect(fixture.harness.cp.runs.currentCandidate(fixture.runId)).toBe(candidateB);

    const replayedOnB = fixture.harness.cp.ceo.recordOwnerDecision({
      runId: fixture.runId,
      item: "public release",
      approved: true,
      note: "candidate A",
      receipt,
    });
    expect(replayedOnB.allowed).toBe(false);
    expect(replayedOnB.reasonCode).toBe(ReasonCode.EVIDENCE_STALE);
    expect(fixture.harness.cp.ceo.humanGateStatus(fixture.runId).satisfied).toBe(false);
    expect(fixture.harness.cp.audit.byKind("OWNER_APPROVAL_CONSUMED")).toHaveLength(1);
  });

  it("#381 ignores owner-decision-shaped rows without an admitted, parameter-bound receipt", async () => {
    const absent = await evidenceReadyRun(["public release"]);
    absent.harness.cp.artifacts.put(absent.runId, ArtifactKind.APPROVAL, {
      kind: "OWNER_DECISION",
      item: "public release",
      approved: true,
      note: "no proof was retained",
      at: absent.harness.clock.nowIso(),
      humanGateDigest: digestOf(["public release"]),
      candidateSnapshotDigest: absent.digest,
    }, absent.digest);
    expect(absent.harness.cp.ceo.humanGateStatus(absent.runId).satisfied).toBe(false);

    const notAdmitted = await evidenceReadyRun(["public release"]);
    const admittedReceipt = ownerDecisionReceipt(
      notAdmitted.harness,
      notAdmitted.runId,
      "public release",
      true,
      "the real decision",
    );
    notAdmitted.harness.cp.artifacts.put(notAdmitted.runId, ArtifactKind.APPROVAL, {
      kind: "OWNER_DECISION",
      item: "public release",
      approved: true,
      note: "the real decision",
      at: notAdmitted.harness.clock.nowIso(),
      humanGateDigest: digestOf(["public release"]),
      candidateSnapshotDigest: notAdmitted.digest,
      receipt: { ...admittedReceipt, inboundNonce: "forged-ingress-nonce" },
    }, notAdmitted.digest);
    expect(notAdmitted.harness.cp.ceo.humanGateStatus(notAdmitted.runId).satisfied).toBe(false);

    const mismatched = await evidenceReadyRun(["public release"]);
    const receiptForOtherParameters = ownerDecisionReceipt(
      mismatched.harness,
      mismatched.runId,
      "public release",
      true,
      "the actual approved note",
    );
    mismatched.harness.cp.artifacts.put(mismatched.runId, ArtifactKind.APPROVAL, {
      kind: "OWNER_DECISION",
      item: "public release",
      approved: true,
      note: "a substituted note",
      at: mismatched.harness.clock.nowIso(),
      humanGateDigest: digestOf(["public release"]),
      candidateSnapshotDigest: mismatched.digest,
      receipt: receiptForOtherParameters,
    }, mismatched.digest);
    expect(mismatched.harness.cp.ceo.humanGateStatus(mismatched.runId).satisfied).toBe(false);
  });

  it("requires an admitted owner receipt to be consumed before a directly retained decision can satisfy a gate", async () => {
    const fixture = await evidenceReadyRun(["public release"]);
    const note = "admitted but never consumed";
    const receipt = ownerDecisionReceipt(fixture.harness, fixture.runId, "public release", true, note);

    // This is an exact receipt from admitted ingress, but it bypasses recordOwnerDecision(),
    // so no authorising write has consumed it for the candidate.
    fixture.harness.cp.artifacts.put(fixture.runId, ArtifactKind.APPROVAL, {
      kind: "OWNER_DECISION",
      item: "public release",
      approved: true,
      note,
      at: fixture.harness.clock.nowIso(),
      humanGateDigest: digestOf(["public release"]),
      candidateSnapshotDigest: fixture.digest,
      receipt,
    }, fixture.digest);

    expect(fixture.harness.cp.audit.byKind("OWNER_APPROVAL_CONSUMED")).toHaveLength(0);
    expect(fixture.harness.cp.ceo.humanGateStatus(fixture.runId).satisfied).toBe(false);
    expect(fixture.harness.cp.ceo.currentHumanGateDecisionDigest(fixture.runId).reasonCode)
      .toBe(ReasonCode.HUMAN_GATE_UNSATISFIED);
  });

  it("P1-18 keeps a consumed owner approval after the ingress replay window is pruned", async () => {
    // The defect: assertConsumedApproval called assertApproval first, which answers from
    // `inbound_messages` — a replay-protection cache with a 24h TTL that is pruned on the
    // next successful admit. A correctly admitted *and consumed* approval therefore stopped
    // satisfying the gate once any later message arrived after the window. GitHub merge
    // re-reads this gate, so an approved run silently became unapproved.
    const fixture = await evidenceReadyRun(["public release"]);
    const receipt = ownerDecisionReceipt(fixture.harness, fixture.runId, "public release", true, "yes");

    expect(fixture.harness.cp.ceo.recordOwnerDecision({
      runId: fixture.runId, item: "public release", approved: true, note: "yes", receipt,
    }).allowed).toBe(true);
    expect(fixture.harness.cp.ceo.humanGateStatus(fixture.runId).satisfied).toBe(true);
    expect(fixture.harness.cp.audit.byKind("OWNER_APPROVAL_CONSUMED")).toHaveLength(1);

    // Exactly what the TTL prune does: drop the replay row for this receipt's nonce. The
    // durable consumption event stays, because that is the record of what the owner decided.
    fixture.harness.cp.db.run("DELETE FROM inbound_messages");

    expect(fixture.harness.cp.ceo.humanGateStatus(fixture.runId).satisfied).toBe(true);
    expect(fixture.harness.cp.ceo.currentHumanGateDecisionDigest(fixture.runId).allowed).toBe(true);
  });

  it("#374 fails closed when a GUARDED run omits every owner decision item", async () => {
    const fixture = await evidenceReadyRun([], { executionMode: ExecutionMode.GUARDED });
    expect(fixture.harness.cp.ceo.humanGateStatus(fixture.runId)).toEqual({
      required: true,
      items: [],
      satisfied: false,
    });

    const packet = fixture.harness.cp.ceo.buildPacket({
      runId: fixture.runId,
      candidateSnapshotDigest: fixture.digest,
      approval: fixture.approval,
    });
    expect(packet.allowed).toBe(false);
    expect(packet.reasonCode).toBe(ReasonCode.HUMAN_GATE_REQUIRED);
    expect(fixture.harness.cp.runs.require(fixture.runId).state).toBe(RunState.ACTIVE);
  });

  it("#374 derives a mandatory owner item from a named §21 public release", async () => {
    const fixture = await evidenceReadyRun([], {
      contract: { goal: "prepare the public release" },
    });
    expect(fixture.harness.cp.ceo.humanGateStatus(fixture.runId)).toEqual({
      required: true,
      items: ["undelegated public release"],
      satisfied: false,
    });
    buildPacket(fixture);

    const confirmed = fixture.harness.cp.ceo.submitCeoDecision({
      runId: fixture.runId,
      decision: "CONFIRM",
      candidateSnapshotDigest: fixture.digest,
      ceoSessionId: fixture.ceoSessionId,
      rationale: "machine evidence is not an owner decision",
    });
    expect(confirmed.allowed).toBe(false);
    expect(confirmed.reasonCode).toBe(ReasonCode.HUMAN_GATE_UNSATISFIED);
  });

  it("#144 refuses report corroboration from another repository identity", async () => {
    const fixture = await evidenceReadyRun();
    fixture.harness.cp.db.run(
      `UPDATE verification_results SET repository_identity = 'github:attacker/reused-command'
        WHERE run_id = ? AND candidate_snapshot_digest = ?`,
      [fixture.runId, fixture.digest],
    );
    const packet = fixture.harness.cp.ceo.buildPacket({
      runId: fixture.runId, candidateSnapshotDigest: fixture.digest, approval: fixture.approval,
    });
    expect(packet.allowed).toBe(false);
    expect(packet.reasonCode).toBe(ReasonCode.VERIFICATION_INCOMPLETE);
  });

  it("#145 rejects an incomplete bootstrap activation artifact", async () => {
    const harness = makeHarness();
    const ceoSessionId = bindCeo(harness);
    const created = harness.cp.runs.create({
      kind: RunKind.PROJECT_BOOTSTRAP,
      executionMode: ExecutionMode.STANDARD,
      contract: CONTRACT(),
    });
    if (!created.allowed) throw new Error(created.message);
    expect(harness.cp.runs.transition(created.value.runId, RunState.ACTIVE, "bootstrap work").allowed).toBe(true);
    expect(harness.cp.runs.transition(created.value.runId, RunState.READY_FOR_CEO_REVIEW, "bootstrap review").allowed).toBe(true);
    harness.cp.artifacts.put(created.value.runId, ArtifactKind.BOOTSTRAP_ACTIVATION_RESULT, {
      schema: "agent-control-plane.bootstrap-activation.v1",
      runId: created.value.runId,
      projectId: "missing-project",
      projectRegistration: { registered: true, activeManifestDigest: "sha256:missing" },
      localBindings: [],
      blindReview: null,
      primaryCtoBinding: null,
      buzz: { connected: false, address: null },
      handoffAck: null,
      doctor: { status: "BLOCKED", findings: 1 },
      activity: "INACTIVE",
    });
    await harness.cp.continuity.evaluate("bootstrap confirm");
    const confirmed = harness.cp.ceo.submitCeoDecision({
      runId: created.value.runId,
      decision: "CONFIRM",
      candidateSnapshotDigest: "sha256:bootstrap",
      ceoSessionId,
      rationale: "incomplete activation",
    });
    expect(confirmed.allowed).toBe(false);
    expect(confirmed.reasonCode).toBe(ReasonCode.BOOTSTRAP_ACTIVATION_INCOMPLETE);
  });

  it("#146 transactionally rolls back packet artifacts when the READY transition fails", async () => {
    const fixture = await evidenceReadyRun();
    const transition = vi.spyOn(fixture.harness.cp.runs, "transition")
      .mockReturnValue(deny(ReasonCode.RUN_TRANSITION_ILLEGAL, "forced transition failure"));
    const packet = fixture.harness.cp.ceo.buildPacket({
      runId: fixture.runId, candidateSnapshotDigest: fixture.digest, approval: fixture.approval,
    });
    transition.mockRestore();
    expect(packet.allowed).toBe(false);
    expect(fixture.harness.cp.artifacts.list(fixture.runId, ArtifactKind.PRODUCTION_READY_PACKET)).toHaveLength(0);
    expect(fixture.harness.cp.artifacts.list(fixture.runId, ArtifactKind.APPROVAL)).toHaveLength(0);
  });

  it("#223 refuses packet publication when no CEO can receive its notification", async () => {
    const fixture = await evidenceReadyRun();
    expect(fixture.harness.cp.bindings.revoke(roleKeyFor(Role.CEO), "test unbound CEO").allowed).toBe(true);
    const packet = fixture.harness.cp.ceo.buildPacket({
      runId: fixture.runId, candidateSnapshotDigest: fixture.digest, approval: fixture.approval,
    });
    expect(packet.allowed).toBe(false);
    expect(packet.reasonCode).toBe(ReasonCode.GATE_AUTHORITY_DENIED);
    expect(fixture.harness.cp.outbox.listByRun(fixture.runId)
      .some((entry) => entry.kind === "CEO_NOTIFICATION")).toBe(false);
  });

  it("#224 resumes an awaiting-human run and enqueues its fenced continuation", async () => {
    const fixture = await evidenceReadyRun(["public release"]);
    buildPacket(fixture);
    const requested = fixture.harness.cp.ceo.submitCeoDecision({
      runId: fixture.runId,
      decision: "OWNER_DECISION_REQUIRED",
      candidateSnapshotDigest: fixture.digest,
      ceoSessionId: fixture.ceoSessionId,
      rationale: "owner must decide",
    });
    expect(requested.allowed).toBe(true);
    expect(fixture.harness.cp.runs.require(fixture.runId).state).toBe(RunState.AWAITING_HUMAN);
    const recorded = fixture.harness.cp.ceo.recordOwnerDecision({
      runId: fixture.runId,
      item: "public release",
      approved: true,
      note: "approved",
      receipt: ownerDecisionReceipt(fixture.harness, fixture.runId, "public release", true, "approved"),
    });
    expect(recorded.allowed).toBe(true);
    expect(fixture.harness.cp.runs.require(fixture.runId).state).toBe(RunState.ACTIVE);
    expect(fixture.harness.cp.outbox.listByRun(fixture.runId)
      .some((entry) => entry.kind === "RUN_DISPATCH" && (entry.payload as { reason?: string }).reason === "OWNER_DECISION_RECORDED"))
      .toBe(true);
  });

  it("#225 refuses a projectless run that has no run-scoped owner binding", async () => {
    const harness = makeHarness();
    const refresh = vi.spyOn(harness.cp.capacity, "refreshForDispatch");
    const created = harness.cp.runs.create({
      executionMode: ExecutionMode.STANDARD,
      contract: CONTRACT(),
    });
    if (!created.allowed) throw new Error(created.message);
    const dispatched = await harness.cp.runs.dispatch(created.value.runId);
    expect(dispatched.allowed).toBe(false);
    expect(dispatched.reasonCode).toBe(ReasonCode.RUN_OWNER_NOT_PINNED);
    expect(refresh).not.toHaveBeenCalled();
    expect(harness.cp.runs.require(created.value.runId).state).toBe(RunState.QUEUED);
  });

  it("#231 refuses packet construction without the authoritative candidate snapshot", async () => {
    const fixture = await evidenceReadyRun();
    fixture.harness.cp.db.run(
      `UPDATE run_artifacts SET superseded = 1
        WHERE run_id = ? AND kind = 'CANDIDATE_SNAPSHOT' AND candidate_snapshot_digest = ?`,
      [fixture.runId, fixture.digest],
    );
    const packet = fixture.harness.cp.ceo.buildPacket({
      runId: fixture.runId, candidateSnapshotDigest: fixture.digest, approval: fixture.approval,
    });
    expect(packet.allowed).toBe(false);
    expect(packet.reasonCode).toBe(ReasonCode.EVIDENCE_MISSING);
  });
});
