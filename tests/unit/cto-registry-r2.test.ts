import { afterAll, describe, expect, it, vi } from "vitest";
import { fork, spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { ControlPlane } from "../../src/app/control-plane.ts";
import { type HandoffAcknowledgement, type HandoffPackage } from "../../src/cto/cto-lifecycle.ts";
import { digestOf } from "../../src/core/digest.ts";
import { allow, deny } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { DrainingCause, ExecutionMode, Role, RunState, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import type { DoctorReport } from "../../src/doctor/doctor.ts";
import { createCtoMcpPort, createCtoServer } from "../../src/mcp/cto-server.ts";
import { createHermesMcpPort, createHermesServer } from "../../src/mcp/hermes-server.ts";
import { cleanupTempDirs, commitAll, makeRepo, writeFiles } from "../helpers/fixtures.ts";
import { TestProductionAdapter } from "../helpers/production-adapter.ts";
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
import type { SessionHandle } from "../../src/runtime/provider.ts";

const deadSessionFinding = (report: DoctorReport) =>
  report.findings.find((f) => f.code === "CTO_BINDING_POINTS_AT_DEAD_SESSION");

const tool = (server: object, name: string) => (
  server as unknown as {
    _registeredTools: Record<
      string,
      { handler: (args: Record<string, unknown>) => Promise<{ structuredContent?: Record<string, unknown> }> }
    >;
  }
)._registeredTools[name]!.handler;

const killSuspendAfterCommit = async (root: string, projectId: string): Promise<void> => {
  const helper = fileURLToPath(new URL("../helpers/run-suspend-crash.ts", import.meta.url));
  const child = fork(helper, [root, projectId], {
    cwd: process.cwd(),
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  try {
    const committed = await new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`suspend child did not reach its committed stop boundary: ${stderr}`));
      }, 10_000);
      const cleanup = (): void => {
        clearTimeout(timeout);
        child.off("message", onMessage);
        child.off("error", onError);
        child.off("exit", onExit);
      };
      const onMessage = (message: unknown): void => {
        cleanup();
        resolve(message);
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        cleanup();
        reject(new Error(`suspend child exited before its commit marker: code=${code} signal=${signal} ${stderr}`));
      };
      child.once("message", onMessage);
      child.once("error", onError);
      child.once("exit", onExit);
    });
    expect(committed).toEqual({ type: "SUSPEND_COMMITTED" });
    expect(child.kill("SIGKILL")).toBe(true);
    await once(child, "exit");
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
  }
};

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

  it("#692 refused switchover stops its unused provider session", async () => {
    const harness = makeHarness();
    const { projectId, repositoryId } = await registerFixtureProject(harness);
    const bound = await harness.cp.cto.ensurePrimaryCto(projectId, "setup");
    if (!bound.allowed) throw new Error(bound.message);

    const originalStart = harness.scripted.startSession.bind(harness.scripted);
    let unusedHandle: SessionHandle | undefined;
    harness.scripted.startSession = async (spec) => {
      unusedHandle = await originalStart(spec);
      const run = harness.cp.runs.create({
        projectId,
        executionMode: ExecutionMode.STANDARD,
        contract: CONTRACT,
        repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
      });
      if (!run.allowed) throw new Error(run.message);
      const dispatched = await harness.cp.runs.dispatch(run.value.runId);
      if (!dispatched.allowed) throw new Error(dispatched.message);
      return unusedHandle;
    };

    const refused = await harness.cp.cto.prepareSwitchover(projectId, HANDOFF);

    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.SWITCHOVER_BLOCKED_ACTIVE_RUNS);
    if (!unusedHandle) throw new Error("replacement provider session was not constituted");
    expect(await harness.scripted.probeSession(unusedHandle)).toBe("UNAVAILABLE");
  });

  it("#692 handoff_submit refuses an in flight internal suspend before starting an incoming runtime", async () => {
    const harness = makeHarness();
    const { projectId } = await registerFixtureProject(harness);
    const bound = await harness.cp.cto.ensurePrimaryCto(projectId, "setup");
    if (!bound.allowed) throw new Error(bound.message);
    const binding = harness.cp.bindings.activePrimaryCto(projectId)!;
    const server = createCtoServer(createCtoMcpPort(harness.cp), () => allow(ReasonCode.OK, {
      actor: "primary-cto",
      sessionId: binding.sessionId,
      sessionIncarnation: binding.sessionIncarnation,
    }));
    const sessionsBefore = harness.cp.db.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM sessions`,
    )!.count;

    let stopEntered!: () => void;
    let releaseStop!: () => void;
    const entered = new Promise<void>((resolve) => { stopEntered = resolve; });
    const held = new Promise<void>((resolve) => { releaseStop = resolve; });
    const originalStop = harness.scripted.stopSession.bind(harness.scripted);
    harness.scripted.stopSession = async (handle) => {
      stopEntered();
      await held;
      return originalStop(handle);
    };

    const suspend = harness.cp.cto.suspendProject(projectId, true, "capacity", TEST_OWNER);
    await entered;
    try {
      const refused = await tool(server, "handoff_submit")({
        idempotencyKey: "handoff-during-suspend-before-spawn",
        projectId,
        handoff: HANDOFF,
      });

      expect(refused.structuredContent?.["reasonCode"]).toBe(ReasonCode.REPLACEMENT_BLOCKED_PROJECT_SUSPENDED);
      expect(harness.cp.db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM sessions`)!.count)
        .toBe(sessionsBefore);
      expect(harness.cp.db.get<{ count: number }>(
        `SELECT COUNT(*) AS count FROM handoffs WHERE project_id = ? AND kind = 'HANDOFF'`,
        [projectId],
      )!.count).toBe(0);
    } finally {
      releaseStop();
      expect((await suspend).allowed).toBe(true);
    }
  });

  it("#692 handoff_submit rechecks suspension after incoming runtime startup", async () => {
    const harness = makeHarness();
    const { projectId } = await registerFixtureProject(harness);
    const bound = await harness.cp.cto.ensurePrimaryCto(projectId, "setup");
    if (!bound.allowed) throw new Error(bound.message);
    const binding = harness.cp.bindings.activePrimaryCto(projectId)!;
    const outgoing = harness.cp.sessions.require(binding.sessionId);
    const outgoingProviderSessionId = outgoing.incarnation.split("#", 1)[0]!;
    const server = createCtoServer(createCtoMcpPort(harness.cp), () => allow(ReasonCode.OK, {
      actor: "primary-cto",
      sessionId: binding.sessionId,
      sessionIncarnation: binding.sessionIncarnation,
    }));

    let incomingStarted!: () => void;
    let releaseIncomingStart!: () => void;
    const incomingStartedPromise = new Promise<void>((resolve) => { incomingStarted = resolve; });
    const incomingStartHeld = new Promise<void>((resolve) => { releaseIncomingStart = resolve; });
    let incomingHandle: SessionHandle | undefined;
    const originalStart = harness.scripted.startSession.bind(harness.scripted);
    harness.scripted.startSession = async (spec) => {
      incomingHandle = await originalStart(spec);
      incomingStarted();
      await incomingStartHeld;
      return incomingHandle;
    };

    let suspendStopEntered!: () => void;
    let releaseSuspendStop!: () => void;
    const suspendStopEnteredPromise = new Promise<void>((resolve) => { suspendStopEntered = resolve; });
    const suspendStopHeld = new Promise<void>((resolve) => { releaseSuspendStop = resolve; });
    const originalStop = harness.scripted.stopSession.bind(harness.scripted);
    harness.scripted.stopSession = async (handle) => {
      if (handle.externalSessionId === outgoingProviderSessionId) {
        suspendStopEntered();
        await suspendStopHeld;
      }
      return originalStop(handle);
    };

    const handoff = tool(server, "handoff_submit")({
      idempotencyKey: "handoff-suspend-after-spawn",
      projectId,
      handoff: HANDOFF,
    });
    await incomingStartedPromise;
    const suspend = harness.cp.cto.suspendProject(projectId, true, "capacity", TEST_OWNER);
    await suspendStopEnteredPromise;

    try {
      releaseIncomingStart();
      const refused = await handoff;
      expect(refused.structuredContent?.["reasonCode"]).toBe(ReasonCode.REPLACEMENT_BLOCKED_PROJECT_SUSPENDED);
      if (!incomingHandle) throw new Error("incoming provider runtime did not start");
      expect(await harness.scripted.probeSession(incomingHandle)).toBe("UNAVAILABLE");
      expect(harness.cp.db.get<{ count: number }>(
        `SELECT COUNT(*) AS count FROM handoffs WHERE project_id = ? AND kind = 'HANDOFF'`,
        [projectId],
      )!.count).toBe(0);
      expect(harness.cp.sessions.require(binding.sessionId)).toMatchObject({
        lifecycle: SessionLifecycle.DRAINING,
        drainingCause: DrainingCause.SUSPEND,
      });
    } finally {
      releaseIncomingStart();
      releaseSuspendStop();
      expect((await suspend).allowed).toBe(true);
    }
  });

  it("#692 internal suspendProject refuses a pending CTO handoff", async () => {
    const harness = makeHarness();
    const { projectId } = await registerFixtureProject(harness);
    const bound = await harness.cp.cto.ensurePrimaryCto(projectId, "setup");
    if (!bound.allowed) throw new Error(bound.message);
    const binding = harness.cp.bindings.activePrimaryCto(projectId)!;
    const server = createCtoServer(createCtoMcpPort(harness.cp), () => allow(ReasonCode.OK, {
      actor: "primary-cto",
      sessionId: binding.sessionId,
      sessionIncarnation: binding.sessionIncarnation,
    }));
    const prepared = await tool(server, "handoff_submit")({
      idempotencyKey: "handoff-before-internal-suspend",
      projectId,
      handoff: HANDOFF,
    });
    expect(prepared.structuredContent?.["ok"]).toBe(true);
    const value = prepared.structuredContent?.["value"] as {
      handoffId: string;
      incomingSessionId: string;
    };
    const incoming = harness.cp.sessions.require(value.incomingSessionId);
    const incomingHandle: SessionHandle = {
      externalSessionId: incoming.incarnation.split("#", 1)[0]!,
      provider: incoming.provider,
      model: incoming.model,
      effort: incoming.effort,
      pid: incoming.osPid,
      workdir: incoming.workdir ?? undefined,
    };
    const stopSession = vi.spyOn(harness.scripted, "stopSession");

    const refused = await harness.cp.cto.suspendProject(projectId, true, "capacity", TEST_OWNER);

    expect(refused.allowed).toBe(false);
    expect(refused.reasonCode).toBe(ReasonCode.SUSPEND_BLOCKED_NON_SUSPEND_DRAINING);
    expect(stopSession).not.toHaveBeenCalled();
    expect(harness.cp.projects.require(projectId).suspended).toBe(false);
    expect(harness.cp.sessions.require(binding.sessionId)).toMatchObject({
      lifecycle: SessionLifecycle.DRAINING,
      drainingCause: DrainingCause.REPLACEMENT,
    });
    expect(await harness.scripted.probeSession(incomingHandle)).toBe("HEALTHY");
    expect(harness.cp.db.get<{ status: string }>(
      `SELECT status FROM handoffs WHERE handoff_id = ?`,
      [value.handoffId],
    )?.status).toBe("PENDING");
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

  it("#692 suspend stops the constituted provider session", async () => {
    const harness = makeHarness();
    const { projectId, repositoryId } = await registerFixtureProject(harness);
    await createActiveRun(harness, projectId, repositoryId);
    const binding = harness.cp.bindings.activePrimaryCto(projectId)!;
    const session = harness.cp.sessions.require(binding.sessionId);
    const providerHandle = {
      externalSessionId: session.incarnation.split("#", 1)[0]!,
      provider: session.provider,
      model: session.model,
      effort: session.effort,
      pid: session.osPid,
      workdir: session.workdir ?? undefined,
    };
    expect(await harness.scripted.probeSession(providerHandle)).toBe("HEALTHY");

    const suspended = await harness.cp.cto.suspendProject(projectId, true, "capacity crisis", TEST_OWNER);

    expect(suspended.allowed).toBe(true);
    expect(await harness.scripted.probeSession(providerHandle)).toBe("UNAVAILABLE");
  });

  it("#692 scripted adapter refuses an unknown provider session", async () => {
    const harness = makeHarness();

    await expect(harness.scripted.stopSession({
      externalSessionId: "provider-session-not-constituted",
      provider: harness.scripted.provider,
      model: "scripted-cto",
      effort: null,
      pid: null,
    })).rejects.toThrow("does not know session provider-session-not-constituted");
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
    "#692 round 3 — resumeProject must not reverse a suspend whose stopSession() is " +
      "still in flight, and a run must not dispatch in that window",
    async () => {
      // The internal suspend method creates the real in-flight state; resume enters through
      // the deployed Hermes cto_resume tool rather than calling the lifecycle method directly.
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

      let resumeDuringWindow: { structuredContent?: Record<string, unknown> } | undefined;
      let dispatchDuringWindow: Awaited<ReturnType<typeof harness.cp.runs.dispatch>> | undefined;
      const hermes = createHermesServer(
        createHermesMcpPort(harness.cp),
        () => allow(ReasonCode.OK, { actor: "hermes-daemon" }),
      );
      const originalStop = harness.scripted.stopSession.bind(harness.scripted);
      harness.scripted.stopSession = async (handle) => {
        // suspendProject has already committed suspended=true and DRAINING/SUSPEND by the
        // time this runs (it only awaits the provider stop after that commit) — the exact
        // window sol's review named.
        resumeDuringWindow = await tool(hermes, "cto_resume")({
          idempotencyKey: "resume-during-internal-suspend",
          projectId,
        });
        dispatchDuringWindow = await harness.cp.runs.dispatch(queuedRun.value.runId);
        return originalStop(handle);
      };

      const suspended = await harness.cp.cto.suspendProject(projectId, true, "capacity crisis", TEST_OWNER);

      expect(resumeDuringWindow?.structuredContent?.["ok"]).toBe(false);
      expect(resumeDuringWindow?.structuredContent?.["reasonCode"])
        .toBe(ReasonCode.RESUME_BLOCKED_SUSPEND_IN_FLIGHT);
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

      const hermes = createHermesServer(
        createHermesMcpPort(harness.cp),
        () => allow(ReasonCode.OK, { actor: "hermes-daemon" }),
      );
      const resumed = await tool(hermes, "cto_resume")({
        idempotencyKey: "resume-after-dead-suspend-process",
        projectId,
      });

      expect(resumed.structuredContent?.["ok"]).toBe(true);
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

  it("#692 daemon restart revokes a binding stranded by a killed suspend", async () => {
    const harness = makeHarness();
    const { projectId, repositoryId } = await registerFixtureProject(harness);
    const run = await createActiveRun(harness, projectId, repositoryId);
    bindCeo(harness);
    const binding = harness.cp.bindings.activePrimaryCto(projectId)!;
    const config = harness.cp.config;
    harness.cp.close();

    await killSuspendAfterCommit(harness.root, projectId);

    const restarted = new ControlPlane(config);
    restarted.credentials.install({ token: "test-token", creatorIdentity: "acme-bot" });
    const daemon = restarted.createDaemon({ stateDir: join(harness.root, "crash-restart") });
    try {
      const started = await daemon.start();

      if (!started.allowed) {
        throw new Error(`cold start refused after killed suspend: ${JSON.stringify(started)}`);
      }
      expect(started.value.unavailableBindingsRevoked).toEqual([
        {
          roleKey: roleKeyFor(Role.PRIMARY_CTO, { projectId }),
          sessionId: binding.sessionId,
          lifecycle: SessionLifecycle.ERROR,
        },
      ]);
      expect(started.value.unavailableBindingRevocationsDeferred).toEqual([]);
      expect(restarted.projects.require(projectId).suspended).toBe(true);
      expect(restarted.sessions.require(binding.sessionId).lifecycle).toBe(SessionLifecycle.ERROR);
      expect(restarted.runs.require(run.runId).state).toBe(RunState.BLOCKED);
      expect(restarted.bindings.activePrimaryCto(projectId)).toBeNull();
      const projectDoctor = await restarted.doctor.run("project", projectId);
      expect(projectDoctor.status).toBe("HEALTHY");
      expect(deadSessionFinding(projectDoctor)).toBeUndefined();
    } finally {
      if (daemon.lock.held()) await daemon.stop();
      restarted.close();
    }
  });

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

      const hermes = createHermesServer(
        createHermesMcpPort(harness.cp),
        () => allow(ReasonCode.OK, { actor: "hermes-daemon" }),
      );
      const resumed = await tool(hermes, "cto_resume")({
        idempotencyKey: "resume-during-replacement",
        projectId,
      });
      expect(resumed.structuredContent?.["ok"]).toBe(false);
      expect(resumed.structuredContent?.["reasonCode"]).toBe(ReasonCode.RESUME_BLOCKED_NON_SUSPEND_DRAINING);

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
    "#692 a suspend crossing run reactivation leaves a cold start recoverable",
    async () => {
      const harness = makeHarness();
      const { projectId, repositoryId } = await registerFixtureProject(harness);
      const run = await createActiveRun(harness, projectId, repositoryId);
      const ceoSessionId = bindCeo(harness);
      const binding = harness.cp.bindings.activePrimaryCto(projectId)!;
      let reactivation: ReturnType<typeof harness.cp.ceo.resolveEscalation> | null = null;

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
        reactivation = harness.cp.ceo.resolveEscalation(run.runId, "resolved mid-suspend", ceoSessionId);
        return result;
      };

      const suspended = await harness.cp.cto.suspendProject(projectId, true, "capacity crisis", TEST_OWNER);

      // Close the first control plane and construct the same production composition root
      // against the durable database. Reusing the first harness would only prove that a
      // later call in the same process can repair its own state; Daemon.start is the cold
      // entry point whose doctor decision controls whether operator and Hermes sockets open.
      const config = harness.cp.config;
      harness.cp.close();
      const restarted = new ControlPlane(config);
      restarted.credentials.install({ token: "test-token", creatorIdentity: "acme-bot" });
      const daemon = restarted.createDaemon({ stateDir: join(harness.root, "cold-start") });
      try {
        const started = await daemon.start();

        // Keep this assertion first. On the old compensation, the durable ACTIVE binding
        // still points at this STOPPED session and this is where the RED reports the real
        // doctor startup refusal rather than stopping at an in-process assertion.
        if (!started.allowed) {
          throw new Error(`cold start refused: ${JSON.stringify(started)}`);
        }
        expect(suspended).toMatchObject({ allowed: true });
        expect(reactivation).toMatchObject({
          allowed: false,
          reasonCode: ReasonCode.RUN_ACTIVATION_BLOCKED_PROJECT_SUSPENDED,
        });
        expect(restarted.sessions.require(binding.sessionId).lifecycle).toBe(SessionLifecycle.STOPPED);
        expect(restarted.runs.require(run.runId).state).toBe(RunState.BLOCKED);
        expect(restarted.bindings.activePrimaryCto(projectId)).toBeNull();
        const projectDoctor = await restarted.doctor.run("project", projectId);
        expect(projectDoctor.status).toBe("HEALTHY");
        expect(deadSessionFinding(projectDoctor)).toBeUndefined();
      } finally {
        if (daemon.lock.held()) await daemon.stop();
        restarted.close();
      }
    },
  );

  it("#692 a suspended checkpoint cannot advance to another live run state during provider stop", async () => {
    const harness = makeHarness();
    const { projectId, repositoryId } = await registerFixtureProject(harness);
    const run = await createActiveRun(harness, projectId, repositoryId);
    let advanced: ReturnType<typeof harness.cp.runs.transition> | null = null;

    const originalStop = harness.scripted.stopSession.bind(harness.scripted);
    harness.scripted.stopSession = async (handle) => {
      await originalStop(handle);
      advanced = harness.cp.runs.transition(
        run.runId,
        RunState.AWAITING_HUMAN,
        "human gate requested while provider stop was in flight",
      );
    };

    const suspended = await harness.cp.cto.suspendProject(
      projectId,
      true,
      "capacity crisis",
      TEST_OWNER,
    );

    expect(suspended.allowed).toBe(true);
    expect(advanced).toMatchObject({
      allowed: false,
      reasonCode: ReasonCode.RUN_ACTIVATION_BLOCKED_PROJECT_SUSPENDED,
    });
    expect(harness.cp.runs.require(run.runId).state).toBe(RunState.BLOCKED);
    expect(harness.cp.bindings.activePrimaryCto(projectId)).toBeNull();
  });

  it("#692 suspend retries a revoke blocked during provider stop and records recovery", async () => {
    const harness = makeHarness();
    const { projectId, repositoryId } = await registerFixtureProject(harness);
    const ensured = await harness.cp.cto.ensurePrimaryCto(projectId, "post-stop retry setup");
    if (!ensured.allowed) throw new Error(ensured.message);

    // Keep an ACTIVE run outside the incumbent's ownership during suspend preflight. The
    // real emergency-owner path then attaches it while stopSession is in flight, so the
    // first real BindingRegistry.revoke observes a blocker that did not exist pre-stop.
    const created = harness.cp.runs.create({
      projectId,
      executionMode: ExecutionMode.STANDARD,
      contract: CONTRACT,
      repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
    });
    if (!created.allowed) throw new Error(created.message);
    const active = harness.cp.runs.transition(
      created.value.runId,
      RunState.ACTIVE,
      "work became active before emergency ownership",
    );
    if (!active.allowed) throw new Error(active.message);
    expect(active.value.ownerSessionId).toBeNull();

    let reassigned: ReturnType<typeof harness.cp.runs.reassignOwner> | null = null;
    const originalStop = harness.scripted.stopSession.bind(harness.scripted);
    harness.scripted.stopSession = async (handle) => {
      await originalStop(handle);
      reassigned = harness.cp.runs.reassignOwner(
        created.value.runId,
        ensured.value,
        "emergency ownership changed during provider stop",
      );
    };

    const suspended = await harness.cp.cto.suspendProject(
      projectId,
      true,
      "capacity crisis",
      TEST_OWNER,
    );

    expect(reassigned).toMatchObject({ allowed: true });
    expect(suspended.allowed).toBe(true);
    expect(harness.cp.runs.require(created.value.runId).state).toBe(RunState.BLOCKED);
    expect(harness.cp.bindings.activePrimaryCto(projectId)).toBeNull();
    expect(harness.cp.audit.byKind("PROJECT_SUSPEND_BINDING_REVOKE_RECOVERED")).toEqual([
      expect.objectContaining({
        projectId,
        sessionId: ensured.value.sessionId,
        evidence: expect.objectContaining({ checkpointedRuns: [created.value.runId] }),
      }),
    ]);
  });

  it("#692 a concurrent revoke after provider stop converges as a successful suspend", async () => {
    const harness = makeHarness();
    const { projectId } = await registerFixtureProject(harness);
    const binding = await harness.cp.cto.ensurePrimaryCto(projectId, "concurrent revoke setup");
    if (!binding.allowed) throw new Error(binding.message);

    const originalStop = harness.scripted.stopSession.bind(harness.scripted);
    harness.scripted.stopSession = async (handle) => {
      await originalStop(handle);
      const revoked = harness.cp.bindings.revoke(
        roleKeyFor(Role.PRIMARY_CTO, { projectId }),
        "concurrent continuity revoke",
        { allowBlockedRuns: true },
      );
      if (!revoked.allowed) throw new Error(`${revoked.reasonCode}: ${revoked.message}`);
    };

    const suspended = await harness.cp.cto.suspendProject(
      projectId,
      true,
      "provider stop races binding revoke",
      TEST_OWNER,
    );
    expect(suspended.allowed).toBe(true);
    expect(harness.cp.projects.require(projectId).suspended).toBe(true);
    expect(harness.cp.bindings.activePrimaryCto(projectId)).toBeNull();
    expect(harness.cp.sessions.require(binding.value.sessionId).lifecycle).toBe(SessionLifecycle.STOPPED);
  });

  it("#692 suspend follows a replacement runtime that wins during provider stop", async () => {
    const harness = makeHarness();
    const { projectId } = await registerFixtureProject(harness);
    const incumbent = await harness.cp.cto.ensurePrimaryCto(projectId, "replacement race setup");
    if (!incumbent.allowed) throw new Error(incumbent.message);

    const originalStop = harness.scripted.stopSession.bind(harness.scripted);
    let replacementHandle: SessionHandle | null = null;
    let replacementSessionId: string | null = null;
    let moved = false;
    harness.scripted.stopSession = async (handle) => {
      await originalStop(handle);
      if (moved) return;
      moved = true;

      replacementHandle = await harness.scripted.startSession({
        model: "replacement-cto",
        purpose: "trusted replacement racing suspend",
        workdir: harness.root,
      });
      const replacement = harness.cp.sessions.create({
        provider: replacementHandle.provider,
        model: replacementHandle.model,
        sessionId: "ses_replacement_racing_suspend",
        incarnation: `${replacementHandle.externalSessionId}#${harness.clock.nowIso()}`,
      });
      replacementSessionId = replacement.sessionId;
      const ready = harness.cp.sessions.transition(replacement.sessionId, SessionLifecycle.READY, "replacement ready");
      if (!ready.allowed) throw new Error(`${ready.reasonCode}: ${ready.message}`);

      // BindingRegistry normally refuses this switch because suspend already committed its
      // project fence. Temporarily clear only that flag to model a trusted concurrent writer
      // that won anyway, entering the post-stop generation-change branch under test.
      const resumed = harness.cp.projects.setSuspended(projectId, false, true);
      if (!resumed.allowed) throw new Error(resumed.message);
      const switched = harness.cp.bindings.switchTo({
        role: Role.PRIMARY_CTO,
        projectId,
        sessionId: replacement.sessionId,
        mode: "FALLBACK",
        reason: "trusted replacement won during provider stop",
        conversation: "SURVIVED",
      });
      if (!switched.allowed) throw new Error(`${switched.reasonCode}: ${switched.message}`);
      const resuspended = harness.cp.projects.setSuspended(projectId, true, true);
      if (!resuspended.allowed) throw new Error(resuspended.message);
    };

    const suspended = await harness.cp.cto.suspendProject(
      projectId,
      true,
      "provider stop races a replacement generation",
      TEST_OWNER,
    );

    expect(suspended.allowed).toBe(true);
    expect(replacementHandle).not.toBeNull();
    expect(replacementSessionId).not.toBeNull();
    expect(await harness.scripted.probeSession(replacementHandle!)).toBe("UNAVAILABLE");
    expect(harness.cp.sessions.require(replacementSessionId!).lifecycle).toBe(SessionLifecycle.STOPPED);
    expect(harness.cp.bindings.activePrimaryCto(projectId)).toBeNull();
    expect(harness.cp.audit.byKind("PROJECT_SUSPEND_BINDING_MOVED_AFTER_STOP")).toHaveLength(1);
  });

  it("#692 suspend follows a replacement generation that wins during provider stop", async () => {
    const harness = makeHarness();
    const { projectId } = await registerFixtureProject(harness);
    const incumbent = await harness.cp.cto.ensurePrimaryCto(projectId, "generation race setup");
    if (!incumbent.allowed) throw new Error(incumbent.message);

    const replacementAdapter = new TestProductionAdapter(harness.clock, "replacement-provider");
    harness.cp.providers.register(replacementAdapter);
    const originalStop = harness.scripted.stopSession.bind(harness.scripted);
    let replacementHandle: SessionHandle | null = null;
    let replacementSessionId: string | null = null;
    let replacementGeneration: number | null = null;
    let moved = false;
    harness.scripted.stopSession = async (handle) => {
      await originalStop(handle);
      if (moved) return;
      moved = true;

      replacementHandle = await replacementAdapter.startSession({
        model: "replacement-cto",
        purpose: "different-provider replacement racing suspend",
        workdir: harness.root,
      });
      const replacement = harness.cp.sessions.create({
        provider: replacementHandle.provider,
        model: replacementHandle.model,
        sessionId: "ses_replacement_generation_racing_suspend",
        incarnation: `${replacementHandle.externalSessionId}#${harness.clock.nowIso()}`,
      });
      replacementSessionId = replacement.sessionId;
      const ready = harness.cp.sessions.transition(replacement.sessionId, SessionLifecycle.READY, "replacement ready");
      if (!ready.allowed) throw new Error(`${ready.reasonCode}: ${ready.message}`);

      // A different provider means continuity replaces the counterpart and mints a new
      // generation. Clear only the ordinary suspension fence to enter the defensive
      // post-stop branch even if a trusted concurrent writer has bypassed that fence.
      const resumed = harness.cp.projects.setSuspended(projectId, false, true);
      if (!resumed.allowed) throw new Error(resumed.message);
      const switched = harness.cp.bindings.switchTo({
        role: Role.PRIMARY_CTO,
        projectId,
        sessionId: replacement.sessionId,
        mode: "FALLBACK",
        reason: "different-provider replacement won during provider stop",
        conversation: "REPLACED",
        takeover: true,
      });
      if (!switched.allowed) throw new Error(`${switched.reasonCode}: ${switched.message}`);
      replacementGeneration = switched.value.bindingGeneration;
      const resuspended = harness.cp.projects.setSuspended(projectId, true, true);
      if (!resuspended.allowed) throw new Error(resuspended.message);
    };

    const suspended = await harness.cp.cto.suspendProject(
      projectId,
      true,
      "provider stop races a replacement generation",
      TEST_OWNER,
    );

    expect(suspended.allowed).toBe(true);
    expect(replacementGeneration).toBeGreaterThan(incumbent.value.bindingGeneration);
    expect(replacementHandle).not.toBeNull();
    expect(replacementSessionId).not.toBeNull();
    expect(await replacementAdapter.probeSession(replacementHandle!)).toBe("UNAVAILABLE");
    expect(harness.cp.sessions.require(replacementSessionId!).lifecycle).toBe(SessionLifecycle.STOPPED);
    expect(harness.cp.bindings.activePrimaryCto(projectId)).toBeNull();
    expect(harness.cp.audit.byKind("PROJECT_SUSPEND_BINDING_MOVED_AFTER_STOP")).toEqual([
      expect.objectContaining({
        evidence: expect.objectContaining({
          expectedGeneration: incumbent.value.bindingGeneration,
          currentGeneration: replacementGeneration,
        }),
      }),
    ]);
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
