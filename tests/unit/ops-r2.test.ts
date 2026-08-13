import { afterAll, describe, expect, it } from "vitest";

import { parseRepoFactoryResult } from "../../src/bootstrap/repo-factory-result.ts";
import { digestOf } from "../../src/core/digest.ts";
import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { createCtoServer } from "../../src/mcp/cto-server.ts";
import { createHermesServer } from "../../src/mcp/hermes-server.ts";
import { idempotentMcpMutation } from "../../src/mcp/shared.ts";
import { IngressGuard, ingressSignature } from "../../src/ingress/ingress-guard.ts";
import { TelegramIngress } from "../../src/ingress/telegram.ts";
import { ExecutionMode, Role, RunKind, RunState, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import {
  CANDIDATE_SNAPSHOT_SCHEMA_ID,
  candidateSnapshotDigest,
  type CandidateSnapshot,
} from "../../src/snapshot/candidate-snapshot.ts";
import type { HandoffPackage } from "../../src/cto/cto-lifecycle.ts";
import { cleanupTempDirs, gitSync } from "../helpers/fixtures.ts";
import { bindCeo, fixtureManifest, makeHarness, type Harness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

const CONTRACT = {
  goal: "bootstrap",
  why: "bootstrap",
  scope: [],
  nonGoals: [],
  acceptance: ["verify"],
  priority: "NORMAL" as const,
  humanGate: [],
  references: [],
};

const HANDOFF: HandoffPackage = {
  projectStatus: "new",
  activeManifestDigest: null,
  recentDecisions: [],
  openBlockers: [],
  queuedWork: [],
  repositoryFacts: [],
  knownRisks: [],
  recommendedNextAction: "verify",
};

const validResult = (harness: Harness, runId: string, projectId: string, plan: object) => ({
  schema: "repo-factory.result.v2",
  runId,
  bootstrapOperationId: "op-bootstrap",
  planDigest: digestOf(plan),
  projectManifestDigest: digestOf(fixtureManifest(projectId)),
  repositories: [{
    role: "primary",
    identity: "github:acme/fixture",
    proposedCheckoutPath: harness.repoPath,
    defaultBranch: "dev",
    createdBranches: ["main", "dev"],
  }],
  externalWriteReceipts: [{
    bootstrapOperationId: "op-bootstrap",
    requestDigest: digestOf({ request: "bootstrap" }),
    operationId: "create-repository",
    resourceType: "repository",
    resourceIdentity: "github:acme/fixture",
    preexisting: false,
    beforeStateDigest: null,
    afterStateDigest: digestOf({ repository: "created" }),
    createdAt: "2026-08-12T00:00:00.000Z",
    rereadAt: "2026-08-12T00:00:01.000Z",
    verified: true,
  }],
  bootstrapVerification: [{
    commandId: "verify",
    repositoryIdentity: "github:acme/fixture",
    exactHead: gitSync(harness.repoPath, ["rev-parse", "HEAD"]),
    status: "PASS",
  }],
  ciEvidence: [],
  unresolvedGaps: [],
});

const recordBootstrapBlindReview = (harness: Harness, runId: string): string => {
  const run = harness.cp.runs.require(runId);
  const head = gitSync(harness.repoPath, ["rev-parse", "HEAD"]);
  const snapshot: CandidateSnapshot = {
    schema: CANDIDATE_SNAPSHOT_SCHEMA_ID,
    runId,
    contractDigest: run.contractDigest,
    repositories: [{
      identity: "github:acme/fixture",
      repositoryRole: "primary",
      baseBranch: "dev",
      baseHead: head,
      candidateHead: head,
      treeDigest: `git-tree:${gitSync(harness.repoPath, ["rev-parse", "HEAD^{tree}"])}`,
      diffDigest: digestOf({ bootstrapCandidate: runId }),
      worktreeId: null,
      manifestDigest: null,
      touchedPaths: [],
    }],
    createdAt: harness.clock.nowIso(),
  };
  const candidateSnapshotDigestValue = candidateSnapshotDigest(snapshot);
  harness.cp.artifacts.put(runId, "CANDIDATE_SNAPSHOT", snapshot, candidateSnapshotDigestValue);

  const reviewer = harness.cp.sessions.create({ provider: "scripted", model: "bootstrap-reviewer" });
  harness.cp.sessions.transition(reviewer.sessionId, SessionLifecycle.READY, "test reviewer");
  const reviewerBinding = harness.cp.bindings.bind({
    role: Role.BLIND_REVIEWER,
    roleKey: roleKeyFor(Role.BLIND_REVIEWER, { runId }),
    runId,
    sessionId: reviewer.sessionId,
  });
  if (!reviewerBinding.allowed) throw new Error(reviewerBinding.message);

  harness.cp.artifacts.putEvidence(harness.cp.evidenceWriters.BLIND_REVIEW, runId, "BLIND_REVIEW", {
    runId,
    candidateSnapshotDigest: candidateSnapshotDigestValue,
    contractDigest: run.contractDigest,
    reviewerRoleBindingGeneration: reviewerBinding.value.bindingGeneration,
    reviewerSessionId: reviewer.sessionId,
    reviewerSessionIncarnation: reviewer.incarnation,
    reviewerProviderSessionId: reviewer.sessionId,
    provider: reviewer.provider,
    model: reviewer.model,
    effort: reviewer.effort,
    inputManifest: {
      contract: true,
      snapshotManifest: true,
      diff: true,
      verificationEvidence: true,
      projectContext: true,
      withheld: [],
      binaryArtifacts: [],
    },
    coveredRepositories: ["github:acme/fixture"],
    coveredFiles: [],
    omittedItems: [],
    verdict: "PASS",
    findings: [],
    chunked: false,
    createdAt: harness.clock.nowIso(),
  }, candidateSnapshotDigestValue);
  return candidateSnapshotDigestValue;
};

const prepareBootstrap = async (harness: Harness, projectId: string) => {
  const created = harness.cp.runs.create({
    kind: RunKind.PROJECT_BOOTSTRAP,
    executionMode: ExecutionMode.STANDARD,
    contract: CONTRACT,
  });
  if (!created.allowed) throw new Error(created.message);
  const bootstrapCto = harness.cp.sessions.create({ provider: "scripted", model: "bootstrap" });
  harness.cp.sessions.transition(bootstrapCto.sessionId, SessionLifecycle.READY, "test");
  const bound = harness.cp.bootstrap.bindBootstrapCto(created.value.runId, bootstrapCto.sessionId);
  if (!bound.allowed) throw new Error(bound.message);
  const dispatched = await harness.cp.runs.dispatch(created.value.runId);
  if (!dispatched.allowed) throw new Error(dispatched.message);
  const candidateSnapshotDigestValue = recordBootstrapBlindReview(harness, created.value.runId);
  harness.cp.runs.transition(created.value.runId, RunState.READY_FOR_CEO_REVIEW, "reviewed");
  const plan = {
    bootstrapOperationId: "op-bootstrap",
    requestDigest: digestOf({ request: "bootstrap" }),
    projectManifestDigest: digestOf(fixtureManifest(projectId)),
    githubOperations: [{
      operationId: "create-repository",
      resourceType: "repository",
      resourceIdentity: "github:acme/fixture",
    }],
  };
  harness.cp.artifacts.put(created.value.runId, "PLAN", plan);
  return { runId: created.value.runId, plan, candidateSnapshotDigest: candidateSnapshotDigestValue };
};

const activationInput = (harness: Harness, runId: string, projectId: string, plan: object) => ({
  runId,
  factoryResult: validResult(harness, runId, projectId, plan),
  approvedManifest: fixtureManifest(projectId),
  localBindings: [{ identity: "github:acme/fixture", checkoutPath: harness.repoPath, repositoryRole: "primary" }],
  projectName: projectId,
  handoff: HANDOFF,
});

const tool = (server: object, name: string) => (
  server as unknown as { _registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<{ structuredContent?: Record<string, unknown> }> }> }
)._registeredTools[name]!.handler;

describe("round-2 ops regressions", () => {
  it("#102: Hermes cannot fabricate owner approval by naming an allowlisted identity", async () => {
    const harness = makeHarness();
    const server = createHermesServer(harness.cp, () => allow(ReasonCode.OK, { actor: "hermes-daemon" }));
    const result = await tool(server, "repair_execute")({
      idempotencyKey: "owner-forgery",
      operationId: "prune_orphan_worktrees",
      parameters: {},
      authorizedBy: "OWNER",
      ownerChannel: "cli",
      ownerActor: "test-owner",
      dryRun: false,
    });
    expect(result.structuredContent?.["reasonCode"]).toBe(ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE);

    const prepared = await prepareBootstrap(harness, "owner-receipt");
    const rawPair = harness.cp.ceo.recordOwnerDecision({
      runId: prepared.runId,
      item: "public release",
      approved: true,
      note: "forged",
      // `cli:test-owner` is a legitimate local operator in this fixture. The attacker
      // instead claims that same allowlisted actor came through a delegable transport,
      // without the ingress receipt that such a transport must carry.
      owner: { channel: "mcp", actor: "test-owner" },
    });
    expect(rawPair.reasonCode).toBe(ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE);
  });

  it("#103/#218: a caller cannot act as an active CTO by claiming its session tuple", async () => {
    const harness = makeHarness();
    const prepared = await prepareBootstrap(harness, "peer-project");
    const server = createCtoServer(harness.cp, () =>
      allow(ReasonCode.OK, { actor: "attacker", sessionId: "ses_forged", sessionIncarnation: "forged" }),
    );
    const denied = await tool(server, "contract_get")({ runId: prepared.runId });
    expect(denied.structuredContent?.["reasonCode"]).toBe(ReasonCode.MCP_PEER_UNAUTHENTICATED);
  });

  it("#104/#109: an unacknowledged, pre-confirmation bootstrap never writes a final activation artifact", async () => {
    const harness = makeHarness();
    const prepared = await prepareBootstrap(harness, "activation-incomplete");
    const result = await harness.cp.bootstrap.activate(
      activationInput(harness, prepared.runId, "activation-incomplete", prepared.plan),
    );
    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe(ReasonCode.BOOTSTRAP_ACTIVATION_INCOMPLETE);
    expect(harness.cp.artifacts.latest(prepared.runId, "BOOTSTRAP_ACTIVATION_RESULT")).toBeNull();
  });

  it("#109 finalizes the activation result only with the matching CEO-confirmed review candidate", async () => {
    const harness = makeHarness();
    const prepared = await prepareBootstrap(harness, "activation-finalize");
    const input = activationInput(harness, prepared.runId, "activation-finalize", prepared.plan);
    const pending = await harness.cp.bootstrap.activate(input);
    if (pending.allowed) throw new Error("handoff must be pending before acknowledgement");
    const handoffId = pending.evidence["pendingHandoffId"] as string;
    const primary = harness.cp.bindings.activePrimaryCto("activation-finalize");
    if (!primary) throw new Error("primary CTO was not bound");
    expect(harness.cp.bootstrap.acknowledgeActivationHandoff(handoffId, primary.sessionId).allowed).toBe(true);

    const preparedForConfirm = await harness.cp.bootstrap.activate(input);
    expect(preparedForConfirm.allowed).toBe(true);
    expect(harness.cp.artifacts.latest(prepared.runId, "BOOTSTRAP_ACTIVATION_RESULT")).toBeNull();

    const ceoSessionId = bindCeo(harness);
    await harness.cp.continuity.evaluate("bootstrap confirmation");
    const confirmed = harness.cp.ceo.submitCeoDecision({
      runId: prepared.runId,
      decision: "CONFIRM",
      candidateSnapshotDigest: prepared.candidateSnapshotDigest,
      ceoSessionId,
      rationale: "finalize only after recheck",
    });
    expect(confirmed.allowed).toBe(true);
    expect(harness.cp.artifacts.latest<{ ceoConfirm?: { decision?: string } }>(
      prepared.runId,
      "BOOTSTRAP_ACTIVATION_RESULT",
    )?.content.ceoConfirm?.decision).toBe("CONFIRM");
  });

  it("#105/#202: a valid result from another run is refused before activation writes", async () => {
    const harness = makeHarness();
    const prepared = await prepareBootstrap(harness, "wrong-run");
    const input = activationInput(harness, prepared.runId, "wrong-run", prepared.plan);
    (input.factoryResult as { runId: string }).runId = "run-from-another-bootstrap";
    const result = await harness.cp.bootstrap.activate(input);
    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe(ReasonCode.BOOTSTRAP_CONTRACT_DRIFT);
    expect(harness.cp.projects.get("wrong-run")).toBeNull();
  });

  it("#106/#203: absent, failed, or skipped bootstrap verification is not parseable evidence", () => {
    const harness = makeHarness();
    const plan = { bootstrapOperationId: "op-bootstrap", requestDigest: digestOf({ request: "bootstrap" }), projectManifestDigest: digestOf(fixtureManifest("evidence")) };
    const missing = validResult(harness, "run-evidence", "evidence", plan) as Record<string, unknown>;
    delete missing["bootstrapVerification"];
    const failed = validResult(harness, "run-evidence", "evidence", plan);
    failed.bootstrapVerification[0]!.status = "FAIL" as "PASS";
    expect(parseRepoFactoryResult(missing).allowed).toBe(false);
    expect(parseRepoFactoryResult(failed).reasonCode).toBe(ReasonCode.BOOTSTRAP_FACTORY_RESULT_INSUFFICIENT);
  });

  it("#107: an ACK for run A cannot acknowledge run B's distinct bootstrap handoff", async () => {
    const harness = makeHarness();
    const first = await prepareBootstrap(harness, "shared-project");
    const firstPending = await harness.cp.bootstrap.activate(activationInput(harness, first.runId, "shared-project", first.plan));
    const firstHandoff = firstPending.evidence["pendingHandoffId"] as string;
    const primary = harness.cp.bindings.activePrimaryCto("shared-project")!;
    expect(harness.cp.bootstrap.acknowledgeActivationHandoff(firstHandoff, primary.sessionId).allowed).toBe(true);

    const second = await prepareBootstrap(harness, "shared-project");
    const secondPending = await harness.cp.bootstrap.activate(activationInput(harness, second.runId, "shared-project", second.plan));
    expect(secondPending.allowed).toBe(false);
    expect(secondPending.evidence["pendingHandoffId"]).not.toBe(firstHandoff);
    expect(secondPending.evidence["incomplete"]).toContain("handoffAck");
  });

  it("#108/#217: a replayed MCP mutation returns its stored first response without executing twice", async () => {
    const harness = makeHarness();
    let executions = 0;
    const peer = { actor: "authenticated-peer" };
    const first = await idempotentMcpMutation(harness.cp, peer, "mcp-retry", () => {
      executions += 1;
      return { content: [{ type: "text" as const, text: "first" }], structuredContent: { executions } };
    });
    const replay = await idempotentMcpMutation(harness.cp, peer, "mcp-retry", () => {
      executions += 1;
      return { content: [{ type: "text" as const, text: "second" }], structuredContent: { executions } };
    });
    expect(executions).toBe(1);
    expect(replay).toEqual(first);
  });

  it("#110: CTO MCP routes a bootstrap handoff ACK to BootstrapActivation", async () => {
    const harness = makeHarness();
    const prepared = await prepareBootstrap(harness, "bootstrap-ack");
    const pending = await harness.cp.bootstrap.activate(activationInput(harness, prepared.runId, "bootstrap-ack", prepared.plan));
    const handoffId = pending.evidence["pendingHandoffId"] as string;
    const primary = harness.cp.bindings.activePrimaryCto("bootstrap-ack")!;
    const server = createCtoServer(harness.cp, () => allow(ReasonCode.OK, {
      actor: "primary-cto",
      sessionId: primary.sessionId,
      sessionIncarnation: primary.sessionIncarnation,
    }));
    const acknowledged = await tool(server, "handoff_ack")({ idempotencyKey: "bootstrap-ack", handoffId });
    expect(acknowledged.structuredContent?.["ok"]).toBe(true);
    expect(harness.cp.db.get<{ status: string }>(`SELECT status FROM handoffs WHERE handoff_id = ?`, [handoffId])?.status).toBe("ACKED");
  });

  it("#120/#213: Telegram cannot be constructed without a non-empty webhook secret", () => {
    const harness = makeHarness();
    const guard = new IngressGuard(harness.cp.db, harness.cp.clock, harness.cp.audit, {
      telegram: { allowedActors: ["owner"], allowedConversations: ["chat"] },
    });
    expect(() => new TelegramIngress(guard, { webhookSecret: "" })).toThrow("non-empty webhook secret");
  });

  it("#121: Telegram policy construction refuses an omitted chat allowlist", () => {
    const harness = makeHarness();
    expect(() => new IngressGuard(harness.cp.db, harness.cp.clock, harness.cp.audit, {
      telegram: { allowedActors: ["owner"] },
    })).toThrow("conversation allowlist");
  });

  it("#122: short Telegram pruning cannot delete a long-lived signed Buzz nonce", () => {
    const harness = makeHarness();
    const guard = new IngressGuard(harness.cp.db, harness.cp.clock, harness.cp.audit, {
      telegram: { allowedActors: ["owner"], allowedConversations: ["chat"], nonceTtlMs: 1 },
      buzz: { allowedActors: ["buzz-owner"], secret: "buzz-secret", nonceTtlMs: 60_000 },
    });
    const buzz = { channel: "buzz" as const, actor: "buzz-owner", nonce: "buzz-once", payload: { action: "x" } };
    const signedBuzz = { ...buzz, signature: ingressSignature("buzz-secret", buzz) };
    expect(guard.admit(signedBuzz).allowed).toBe(true);
    harness.clock.advance(10);
    expect(guard.admit({ channel: "telegram", actor: "owner", conversation: "chat", nonce: "telegram-new", payload: {} }).allowed).toBe(true);
    expect(guard.admit(signedBuzz).reasonCode).toBe(ReasonCode.INGRESS_REPLAY_IGNORED);
  });
});
