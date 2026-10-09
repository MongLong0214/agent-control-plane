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
import { Daemon } from "../../src/daemon/daemon.ts";
import { idempotentMcpMutation } from "../../src/mcp/shared.ts";
import * as ingressGuardExports from "../../src/ingress/ingress-guard.ts";
import { IngressGuard, ingressSignature } from "../../src/ingress/ingress-guard.ts";
import { TelegramIngress } from "../../src/ingress/telegram.ts";
import { ExecutionMode, Role, RunKind, RunState, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { manifestDigest } from "../../src/contracts/manifest.ts";
import type { HandoffPackage } from "../../src/cto/cto-lifecycle.ts";
import { cleanupTempDirs, gitSync, tempDir } from "../helpers/fixtures.ts";
import {
  approveReviewedCandidateForFinalization,
  completeBootstrapRunUntilC3,
  dispatchBootstrapRun,
  driveToReviewedCandidate,
  makeHarness,
  type Harness,
} from "../helpers/harness.ts";
import {
  BOOTSTRAP_IDENTITY,
  BOOTSTRAP_REQUEST_DIGEST,
  bootstrapOperations,
  bootstrapPlan,
  cleanTreeManifest,
  reviewBootstrapPlan,
} from "../helpers/bootstrap-plan.ts";
import { FakeGitHub } from "../helpers/fake-github.ts";

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

/**
 * A factory result that reports every operation of the bootstrap PLAN `prepareBootstrap` reviews,
 * and the manifest's one verification at the checkout's head (#246 C2: an executable PLAN).
 */
const validResult = (harness: Harness, runId: string, projectId: string, planDigest: string) => ({
  schema: "repo-factory.result.v2",
  runId,
  bootstrapOperationId: "op-bootstrap",
  planDigest,
  projectManifestDigest: manifestDigest(cleanTreeManifest(projectId)),
  repositories: [{
    role: "primary",
    identity: BOOTSTRAP_IDENTITY,
    proposedCheckoutPath: harness.repoPath,
    defaultBranch: "dev",
    createdBranches: ["main", "dev"],
  }],
  externalWriteReceipts: bootstrapOperations().map((operation) => ({
    bootstrapOperationId: "op-bootstrap",
    requestDigest: BOOTSTRAP_REQUEST_DIGEST,
    operationId: operation.operationId,
    resourceType: operation.resourceType,
    resourceIdentity: operation.resourceIdentity,
    preexisting: false,
    beforeStateDigest: null,
    afterStateDigest: digestOf({ written: operation.operationId }),
    createdAt: "2026-08-12T00:00:00.000Z",
    rereadAt: "2026-08-12T00:00:01.000Z",
    verified: true,
  })),
  bootstrapVerification: [{
    commandId: "clean-tree",
    repositoryIdentity: BOOTSTRAP_IDENTITY,
    exactHead: gitSync(harness.repoPath, ["rev-parse", "HEAD"]),
    status: "PASS",
  }],
  ciEvidence: [],
  unresolvedGaps: [],
});

/**
 * A PROJECT_BOOTSTRAP run at CEO review: its BOOTSTRAP_CTO submits the PLAN with its manifest, and
 * `result_submit`'s BOOTSTRAP_PLAN review passes it (#246 C2), rather than a hand-written review.
 */
const prepareBootstrap = async (harness: Harness, projectId: string) => {
  const created = harness.cp.runs.create({
    kind: RunKind.PROJECT_BOOTSTRAP,
    executionMode: ExecutionMode.STANDARD,
    contract: CONTRACT,
  });
  if (!created.allowed) throw new Error(created.message);
  // Dispatch staffs the run's BOOTSTRAP_CTO and pins it as the owner (#246).
  const dispatched = await dispatchBootstrapRun(harness.cp, harness.clock, created.value.runId);
  const reviewed = await reviewBootstrapPlan(harness, created.value.runId, bootstrapPlan(cleanTreeManifest(projectId)));
  return {
    runId: created.value.runId,
    plan: reviewed.planDigest,
    candidateSnapshotDigest: reviewed.snapshotDigest,
    ceoSessionId: reviewed.ceoSessionId,
    bootstrapCtoSessionId: dispatched.ownerSessionId!,
  };
};

const activationInput = (harness: Harness, runId: string, projectId: string, planDigest: string) => ({
  runId,
  factoryResult: validResult(harness, runId, projectId, planDigest),
  approvedManifest: cleanTreeManifest(projectId),
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
    const confirmed = await port.submitCeoDecision({
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

  it("#109 / RF-S18: a confirmed activation projects tickets through ACP without restarting Repo Factory", async () => {
    const github = new FakeGitHub();
    const harness = makeHarness({ githubClient: github });
    harness.cp.credentials.install({ token: "test-token", creatorIdentity: "acp-trusted-app" });
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

    const ceoSessionId = prepared.ceoSessionId;
    await harness.cp.continuity.evaluate("bootstrap confirmation");
    const confirmed = harness.cp.ceo.submitCeoDecision({
      runId: prepared.runId,
      decision: "CONFIRM",
      candidateSnapshotDigest: prepared.candidateSnapshotDigest,
      ceoSessionId,
      rationale: "finalize only after recheck",
    });
    // Issue #246 PR-C: the bootstrap CONFIRM is shut until C3.
    expect(confirmed.reasonCode).toBe(ReasonCode.BOOTSTRAP_APPLICATION_NOT_AVAILABLE);
    // TODO(C3): confirm through `submitCeoDecision` again once C3 reopens the bootstrap CONFIRM.
    const completed = completeBootstrapRunUntilC3(harness.cp, {
      runId: prepared.runId,
      candidateSnapshotDigest: prepared.candidateSnapshotDigest,
      ceoSessionId,
    });
    expect(completed.allowed).toBe(true);
    expect(harness.cp.artifacts.latest<{ ceoConfirm?: { decision?: string } }>(
      prepared.runId,
      "BOOTSTRAP_ACTIVATION_RESULT",
    )?.content.ceoConfirm?.decision).toBe("CONFIRM");

    const activatedRepository = harness.cp.repositories.byIdentity("github:acme/fixture");
    if (!activatedRepository) throw new Error("activation did not register its repository");
    const activationCalls = vi.spyOn(harness.cp.bootstrap, "activate");
    const projectionRun = await driveToReviewedCandidate(harness, {
      registeredProject: {
        projectId: "activation-finalize",
        repositoryId: activatedRepository.repositoryId,
        identity: activatedRepository.identity,
      },
    });
    const projectionClaim = harness.cp.claims.acquire({
      runId: projectionRun.runId,
      ownerSessionId: projectionRun.ownerSessionId,
      ownerBindingGeneration: projectionRun.ownerBindingGeneration,
      ownerRoleKey: harness.cp.runs.require(projectionRun.runId).ownerRoleKey!,
      repositoryIdentity: projectionRun.identity,
      branch: projectionRun.workBranch,
    });
    if (!projectionClaim.allowed) throw new Error(projectionClaim.message);
    const daemon = new Daemon(harness.cp, { stateDir: tempDir("acp-rf-s18-projection-") });
    const started = await daemon.start();
    expect(started.allowed).toBe(true);
    try {
      await approveReviewedCandidateForFinalization(harness, projectionRun);
      const first = await daemon.projectTickets(projectionRun.runId, projectionRun.identity, [
        { id: "T001", title: "first", body: "do the thing" },
      ]);
      if (!first.allowed) throw new Error(`${first.reasonCode}: ${first.message}`);
      expect(first.allowed && first.value).toEqual({ created: 1, updated: 0 });
      const second = await daemon.projectTickets(projectionRun.runId, projectionRun.identity, [
        { id: "T001", title: "first, retitled", body: "do the thing" },
      ]);
      expect(second.allowed && second.value).toEqual({ created: 0, updated: 1 });
      expect(github.issues).toHaveLength(1);
      expect(github.issues[0]?.title).toBe("first, retitled");
      expect(activationCalls).not.toHaveBeenCalled();
    } finally {
      await daemon.stop();
    }
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
    const planDigest = digestOf({ bootstrapOperationId: "op-bootstrap", requestDigest: BOOTSTRAP_REQUEST_DIGEST });
    const missing = validResult(harness, "run-evidence", "evidence", planDigest) as Record<string, unknown>;
    delete missing["bootstrapVerification"];
    const failed = validResult(harness, "run-evidence", "evidence", planDigest);
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

  it("keeps an in-flight MCP reservation sealed from raw deletes and exported release issuers", async () => {
    const harness = makeHarness();
    const peer = { actor: "authenticated-peer" };
    const nonce = "mcp-suspended";
    let executions = 0;
    let finish!: (result: { content: [{ type: "text"; text: string }] }) => void;
    const first = idempotentMcpMutation(harness.cp, peer, nonce, () => {
      executions += 1;
      return new Promise((resolve) => { finish = resolve; });
    });
    try {
      expect(() => harness.cp.db.run(
        `DELETE FROM inbound_messages WHERE channel = 'mcp' AND nonce = ?`, [nonce],
      )).toThrow(/INGRESS_MESSAGE_DELETE_AUTHORITY_DENIED/);
      const exposedIssuer = (ingressGuardExports as Record<string, unknown>)["releaseUnfinishedMcpReservation"];
      if (typeof exposedIssuer === "function") {
        (exposedIssuer as (db: typeof harness.cp.db, actor: string, key: string) => void)(
          harness.cp.db, peer.actor, nonce,
        );
      }
      const reservedAt = harness.cp.db.get<{ received_at: string }>(
        `SELECT received_at FROM inbound_messages WHERE channel = 'mcp' AND nonce = ?`, [nonce],
      )?.received_at;
      // The current entry point, driven the way a Db holder can: a timestamp an hour ahead makes
      // the live reservation read stale. A takeover must run nothing while the first handler is in
      // flight, whether its run would throw or succeed.
      const future = new Date(Date.parse(harness.clock.nowIso()) + 60 * 60_000).toISOString();
      const thrown = await ingressGuardExports.runMcpReservedMutation(harness.cp.db, peer.actor, nonce, future, () => {
        executions += 1;
        throw new Error("taken over and thrown");
      });
      expect(thrown.kind).toBe("existing");
      const succeeded = await ingressGuardExports.runMcpReservedMutation(harness.cp.db, peer.actor, nonce, future, () => {
        executions += 1;
        return "second execution";
      });
      expect(succeeded.kind).toBe("existing");
      expect(harness.cp.db.get<{ actor: string; received_at: string }>(
        `SELECT actor, received_at FROM inbound_messages WHERE channel = 'mcp' AND nonce = ?`, [nonce],
      )).toEqual({ actor: peer.actor, received_at: reservedAt });
      const retry = await idempotentMcpMutation(harness.cp, peer, nonce, () => {
        executions += 1;
        return { content: [{ type: "text" as const, text: "duplicate" }] };
      });
      expect(retry.structuredContent?.["reasonCode"]).toBe(ReasonCode.INGRESS_REPLAY_IGNORED);
      expect(executions).toBe(1);
    } finally {
      finish({ content: [{ type: "text", text: "finished" }] });
      await first;
    }
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
    // Keep Telegram's declared transport retention and nonce TTL equally short. That satisfies
    // #673's floor while putting the Buzz row outside Telegram's cutoff and inside Buzz's own TTL,
    // so this test fails if pruning loses its channel predicate.
    const guard = new IngressGuard(harness.cp.db, harness.cp.clock, harness.cp.audit, {
      telegram: {
        allowedActors: ["owner"],
        allowedConversations: ["chat"],
        nonceTtlMs: 1,
        transportRetentionMs: 1,
      },
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
