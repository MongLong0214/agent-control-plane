import { afterAll, describe, expect, it, vi } from "vitest";
import { createConnection } from "node:net";
import { readFileSync } from "node:fs";

import { parseRepoFactoryResult } from "../../src/bootstrap/repo-factory-result.ts";
import { digestOf } from "../../src/core/digest.ts";
import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { createCtoMcpPort, createCtoServer } from "../../src/mcp/cto-server.ts";
import { createHermesMcpPort, createHermesServer } from "../../src/mcp/hermes-server.ts";
import { startDaemonMcpListeners } from "../../src/daemon/agentcpd.ts";
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
import { cleanupTempDirs, gitSync, tempDir } from "../helpers/fixtures.ts";
import {
  bindCeo,
  driveToReviewedCandidate,
  fixtureManifest,
  makeHarness,
  type Harness,
} from "../helpers/harness.ts";
import { testReviewerEgressEvidence } from "../helpers/production-adapter.ts";

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

  harness.cp.artifacts.putEvidence(harness.cp.evidenceWritersForTests().BLIND_REVIEW, runId, "BLIND_REVIEW", {
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
    egressEvidence: testReviewerEgressEvidence(reviewer.provider),
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
  return {
    runId: created.value.runId,
    plan,
    candidateSnapshotDigest: candidateSnapshotDigestValue,
    bootstrapCtoSessionId: bootstrapCto.sessionId,
  };
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

const exchangeMcp = (socketPath: string, lines: readonly unknown[]): Promise<string> =>
  new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let received = "";
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("live MCP wiring test timed out"));
    }, 5_000);
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${lines.map((line) => JSON.stringify(line)).join("\n")}\n`));
    socket.on("data", (chunk: string) => {
      received += chunk;
      if (received.includes('"id":2')) {
        clearTimeout(timeout);
        socket.end();
        resolve(received);
      }
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });

describe("round-2 ops regressions", () => {
  it("notifies the daemon-owned finalizer after an ordinary CEO confirmation", async () => {
    const harness = makeHarness();
    const driven = await driveToReviewedCandidate(harness);
    await harness.cp.continuity.evaluate("CEO-to-daemon handoff");
    const packet = harness.cp.ceo.buildPacket({
      runId: driven.runId,
      candidateSnapshotDigest: driven.candidateSnapshotDigest,
      approval: {
        runId: driven.runId,
        candidateSnapshotDigest: driven.candidateSnapshotDigest,
        resultSummary: "ready for finalization",
        recommendation: "merge",
        residualRisk: [],
        approvedBySessionId: driven.ownerSessionId,
        approvedByGeneration: driven.ownerBindingGeneration,
        approvedAt: harness.clock.nowIso(),
      },
    });
    if (!packet.allowed) throw new Error(packet.message);
    const observed: string[] = [];
    const port = createHermesMcpPort(harness.cp, {
      onCeoApproved: (runId) => {
        observed.push(runId);
      },
    });
    const ceo = harness.cp.bindings.active(roleKeyFor(Role.CEO))!;
    const confirmed = port.submitCeoDecision({
      runId: driven.runId,
      decision: "CONFIRM",
      candidateSnapshotDigest: driven.candidateSnapshotDigest,
      ceoSessionId: ceo.sessionId,
      rationale: "notify daemon after durable decision",
    });
    expect(confirmed.allowed).toBe(true);
    expect(harness.cp.runs.require(driven.runId).state).toBe(RunState.CEO_APPROVED);
    expect(observed).toEqual([driven.runId]);
  });

  it("the live daemon listener invokes finalization after the wire CEO confirmation", async () => {
    const harness = makeHarness();
    const driven = await driveToReviewedCandidate(harness);
    // The creation response is the only place a session secret exists. Use a fresh CEO
    // session for the live socket so the test authenticates the actual local transport.
    const createdCeo = harness.cp.sessions.create({ provider: "scripted", model: "wire-ceo" });
    harness.cp.sessions.transition(createdCeo.sessionId, SessionLifecycle.READY, "wire CEO");
    const switched = harness.cp.bindings.switchTo({
      role: Role.CEO,
      sessionId: createdCeo.sessionId,
      reason: "live wiring test CEO",
      conversation: "REPLACED",
    });
    if (!switched.allowed) throw new Error(switched.message);
    await harness.cp.continuity.evaluate("live CEO-to-daemon wiring");
    const packet = harness.cp.ceo.buildPacket({
      runId: driven.runId,
      candidateSnapshotDigest: driven.candidateSnapshotDigest,
      approval: {
        runId: driven.runId,
        candidateSnapshotDigest: driven.candidateSnapshotDigest,
        resultSummary: "ready for finalization",
        recommendation: "merge",
        residualRisk: [],
        approvedBySessionId: driven.ownerSessionId,
        approvedByGeneration: driven.ownerBindingGeneration,
        approvedAt: harness.clock.nowIso(),
      },
    });
    if (!packet.allowed) throw new Error(packet.message);
    const ceo = harness.cp.bindings.active(roleKeyFor(Role.CEO));
    if (!ceo) throw new Error("fixture CEO binding missing");
    if (!createdCeo.sessionSecret) throw new Error("fixture CEO session has no secret");

    const finalize = async (runId: string) => allow(ReasonCode.OK, { runId });
    const finalizer = { finalizeApprovedRun: finalize };
    const listeners = await startDaemonMcpListeners(
      harness.cp,
      tempDir("acp-live-ceo-daemon-wiring-"),
      "live-mcp-token",
      finalizer,
    );
    const hermesSocket = listeners.socketPaths[0];
    if (!hermesSocket) throw new Error("Hermes MCP listener was not started");
    const observed = vi.spyOn(finalizer, "finalizeApprovedRun");
    try {
      const response = await exchangeMcp(hermesSocket, [
        { token: "live-mcp-token", sessionId: createdCeo.sessionId, sessionSecret: createdCeo.sessionSecret },
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "live-wiring-test", version: "1" },
          },
        },
        { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "ceo_decision_submit",
            arguments: {
              idempotencyKey: "live-ceo-confirmation",
              runId: driven.runId,
              decision: "CONFIRM",
              candidateSnapshotDigest: driven.candidateSnapshotDigest,
              ceoSessionId: ceo.sessionId,
              rationale: "exercise the live daemon callback",
            },
          },
        },
      ]);
      expect(response).toContain('"id":2');
      await vi.waitFor(() => expect(observed).toHaveBeenCalledWith(driven.runId));
    } finally {
      observed.mockRestore();
      await listeners.close();
    }
  });

  it("main composes the live listener with the lock-held daemon", () => {
    const source = readFileSync(new URL("../../src/daemon/agentcpd.ts", import.meta.url), "utf8");
    expect(source).toMatch(/listeners = await startDaemonMcpListeners\(cp, stateDir, mcpToken, daemon\)/);
  });

  it("#102: Hermes cannot fabricate owner approval by naming an allowlisted identity", async () => {
    const harness = makeHarness();
    const server = createHermesServer(
      createHermesMcpPort(harness.cp),
      () => allow(ReasonCode.OK, { actor: "hermes-daemon" }),
    );
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

  it("#692 deployed cto_suspend terminates without calling internal suspendProject", async () => {
    const harness = makeHarness();
    const internalSuspend = vi.spyOn(harness.cp.cto, "suspendProject");
    const server = createHermesServer(
      createHermesMcpPort(harness.cp),
      () => allow(ReasonCode.OK, { actor: "hermes-daemon" }),
    );

    const result = await tool(server, "cto_suspend")({
      idempotencyKey: "deployed-suspend-refusal",
      projectId: "project-with-no-owner-ingress",
      reason: "capacity",
    });

    expect(result.structuredContent?.["reasonCode"]).toBe(ReasonCode.OWNER_AUTHORITY_NOT_DELEGABLE);
    expect(internalSuspend).not.toHaveBeenCalled();
  });

  it("#103/#218: a caller cannot act as an active CTO by claiming its session tuple", async () => {
    const harness = makeHarness();
    const prepared = await prepareBootstrap(harness, "peer-project");
    const server = createCtoServer(createCtoMcpPort(harness.cp), () =>
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

    const second = await prepareBootstrap(harness, "shared-project");
    const secondPending = await harness.cp.bootstrap.activate(activationInput(harness, second.runId, "shared-project", second.plan));
    expect(secondPending.allowed).toBe(false);
    const secondHandoff = secondPending.evidence["pendingHandoffId"] as string;
    expect(secondHandoff).not.toBe(firstHandoff);

    // B's real incoming CTO cannot acknowledge A's package merely because it is a live
    // session in the same bootstrap flow.
    const crossRunAck = harness.cp.bootstrap.acknowledgeActivationHandoff(
      firstHandoff,
      second.bootstrapCtoSessionId,
    );
    expect(crossRunAck.reasonCode).toBe(ReasonCode.HANDOFF_ACK_REQUIRED);

    // A's valid ACK after B has opened must still leave B pending: B queries its own
    // run-scoped handoff artifact rather than any ACK for the project/recipient tuple.
    expect(harness.cp.bootstrap.acknowledgeActivationHandoff(firstHandoff, primary.sessionId).reasonCode)
      .toBe(ReasonCode.OK);
    const stillPending = await harness.cp.bootstrap.activate(
      activationInput(harness, second.runId, "shared-project", second.plan),
    );
    expect(stillPending.allowed).toBe(false);
    expect(stillPending.reasonCode).toBe(ReasonCode.BOOTSTRAP_ACTIVATION_INCOMPLETE);
    expect(stillPending.evidence["pendingHandoffId"]).toBe(secondHandoff);
    expect(stillPending.evidence["incomplete"]).toContain("handoffAck");
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

  it("#345: an unfinished MCP mutation reservation recovers after a throw or bounded crash delay", async () => {
    const harness = makeHarness();
    const peer = { actor: "authenticated-peer" };
    let executions = 0;

    await expect(idempotentMcpMutation(harness.cp, peer, "mcp-throw", () => {
      executions += 1;
      throw new Error("tool process exited");
    })).rejects.toThrow("tool process exited");
    expect(harness.cp.db.get(`SELECT nonce FROM inbound_messages WHERE channel = 'mcp' AND nonce = ?`, ["mcp-throw"])).toBeUndefined();

    const afterThrow = await idempotentMcpMutation(harness.cp, peer, "mcp-throw", () => {
      executions += 1;
      return { content: [{ type: "text" as const, text: "retried" }], structuredContent: { reasonCode: ReasonCode.OK } };
    });
    expect(afterThrow.structuredContent?.["reasonCode"]).toBe(ReasonCode.OK);
    expect(executions).toBe(2);

    harness.cp.db.run(
      `INSERT INTO inbound_messages (channel, nonce, actor, received_at) VALUES ('mcp', ?, ?, ?)`,
      ["mcp-crash", peer.actor, harness.clock.nowIso()],
    );
    const inProgress = await idempotentMcpMutation(harness.cp, peer, "mcp-crash", () => {
      throw new Error("must not execute during recovery window");
    });
    expect(inProgress.structuredContent?.["reasonCode"]).toBe(ReasonCode.INGRESS_REPLAY_IGNORED);

    harness.clock.advance(60_000);
    const recovered = await idempotentMcpMutation(harness.cp, peer, "mcp-crash", () => ({
      content: [{ type: "text" as const, text: "recovered" }],
      structuredContent: { reasonCode: ReasonCode.OK },
    }));
    expect(recovered.structuredContent?.["reasonCode"]).toBe(ReasonCode.OK);
  });

  it("#110: CTO MCP routes a bootstrap handoff ACK to BootstrapActivation", async () => {
    const harness = makeHarness();
    const prepared = await prepareBootstrap(harness, "bootstrap-ack");
    const pending = await harness.cp.bootstrap.activate(activationInput(harness, prepared.runId, "bootstrap-ack", prepared.plan));
    const handoffId = pending.evidence["pendingHandoffId"] as string;
    const primary = harness.cp.bindings.activePrimaryCto("bootstrap-ack")!;
    const server = createCtoServer(createCtoMcpPort(harness.cp), () => allow(ReasonCode.OK, {
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
