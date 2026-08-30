import { execFileSync } from "node:child_process";
import { readFileSync, utimesSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { ReasonCode } from "../../src/core/reason-codes.ts";
import { BuzzAdapter, InMemoryBuzzTransport } from "../../src/buzz/buzz-adapter.ts";
import { Daemon } from "../../src/daemon/daemon.ts";
import {
  startBuzzActorIngressListener,
  startLocalMcpListeners,
  startSessionLaunchChannel,
} from "../../src/daemon/agentcpd.ts";
import { SingleInstanceLock } from "../../src/daemon/single-instance.ts";
import { ExecutionMode, Role, RunState, SessionLifecycle } from "../../src/domain/types.ts";
import type { HandoffPackage } from "../../src/cto/cto-lifecycle.ts";
import { buzzActorBindingSigningRequest, ingressSignature } from "../../src/ingress/ingress-guard.ts";
import type { TaskContract } from "../../src/run/run-engine.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { bindCeo, bindWorker, makeHarness, registerFixtureProject } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

const CONTRACT: TaskContract = {
  goal: "doctor regression",
  why: "exercise daemon safeguards",
  scope: [],
  nonGoals: [],
  acceptance: ["tests pass"],
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

const createQueuedRun = async () => {
  const harness = makeHarness();
  const { projectId, repositoryId, identity } = await registerFixtureProject(harness);
  const created = harness.cp.runs.create({
    projectId,
    executionMode: ExecutionMode.STANDARD,
    contract: CONTRACT,
    repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
  });
  if (!created.allowed) throw new Error(created.message);
  return { harness, projectId, repositoryId, identity, run: created.value };
};

const createDispatchedRun = async () => {
  const setup = await createQueuedRun();
  const dispatched = await setup.harness.cp.runs.dispatch(setup.run.runId);
  if (!dispatched.allowed) throw new Error(dispatched.message);
  return { ...setup, run: dispatched.value };
};

const makeDaemonStartHealthy = async () => {
  const setup = await createQueuedRun();
  setup.harness.cp.credentials.install({ token: "test-token", creatorIdentity: "acme-bot" });
  bindCeo(setup.harness);
  const dispatched = await setup.harness.cp.runs.dispatch(setup.run.runId);
  if (!dispatched.allowed) throw new Error(dispatched.message);
  return { ...setup, run: dispatched.value };
};

/** Sends complete local-protocol lines and waits for a caller-selected terminal response. */
const exchangeSocketLines = (
  socketPath: string,
  lines: readonly unknown[],
  complete: (received: string) => boolean,
): Promise<string> =>
  new Promise((resolveExchange, rejectExchange) => {
    const socket = createConnection(socketPath);
    let received = "";
    let settled = false;
    let timeout: NodeJS.Timeout | null = null;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (error) rejectExchange(error);
      else resolveExchange(received);
    };
    timeout = setTimeout(() => {
      socket.destroy();
      finish(new Error("local socket response timed out"));
    }, 5_000);
    socket.setEncoding("utf8");
    socket.once("connect", () => {
      if (lines.length > 0) socket.write(`${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
    });
    socket.on("data", (chunk: string) => {
      received += chunk;
      if (complete(received)) socket.end();
    });
    socket.once("error", (error) => finish(error));
    socket.once("close", () => finish());
  });

/** A post-initialization switch proves request authentication does not trust the handshake alone. */
const exchangeAfterMcpInitialization = (
  socketPath: string,
  handshake: unknown,
  afterInitialize: () => readonly unknown[],
  complete: (received: string) => boolean,
): Promise<string> =>
  new Promise((resolveExchange, rejectExchange) => {
    const socket = createConnection(socketPath);
    let received = "";
    let initialized = false;
    let settled = false;
    let timeout: NodeJS.Timeout | null = null;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (error) rejectExchange(error);
      else resolveExchange(received);
    };
    timeout = setTimeout(() => {
      socket.destroy();
      finish(new Error("local socket response timed out"));
    }, 5_000);
    socket.setEncoding("utf8");
    socket.once("connect", () => {
      socket.write(`${JSON.stringify(handshake)}\n${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "ops-regression", version: "1" },
        },
      })}\n`);
    });
    socket.on("data", (chunk: string) => {
      received += chunk;
      if (!initialized && received.includes('"id":1')) {
        initialized = true;
        socket.write(`${afterInitialize().map((line) => JSON.stringify(line)).join("\n")}\n`);
      }
      if (complete(received)) socket.end();
    });
    socket.once("error", (error) => finish(error));
    socket.once("close", () => finish());
  });

interface LaunchedCredential {
  sessionId: string;
  sessionIncarnation: string;
  sessionSecret: string;
}

/** Reads a launched runtime's one-time local credential exactly as the runtime would. */
const claimLaunchedCredential = async (
  socketPath: string,
  externalSessionId: string,
): Promise<LaunchedCredential> => {
  const received = await exchangeSocketLines(
    socketPath,
    [{ externalSessionId }],
    (body) => body.includes("\n"),
  );
  const body = JSON.parse(received.trim()) as {
    ok?: unknown;
    sessionId?: unknown;
    sessionIncarnation?: unknown;
    sessionSecret?: unknown;
  };
  if (
    body.ok !== true ||
    typeof body.sessionId !== "string" ||
    typeof body.sessionIncarnation !== "string" ||
    typeof body.sessionSecret !== "string"
  ) {
    throw new Error("launch credential was not available");
  }
  return {
    sessionId: body.sessionId,
    sessionIncarnation: body.sessionIncarnation,
    sessionSecret: body.sessionSecret,
  };
};

const externalSessionIdOf = (incarnation: string): string => {
  const externalSessionId = incarnation.split("#", 1)[0];
  if (!externalSessionId) throw new Error("session incarnation has no external session id");
  return externalSessionId;
};

describe("round 2 doctor regressions", () => {
  it("#111/#208: repeated diagnostics do not acknowledge repository drift", async () => {
    const { harness } = await createQueuedRun();
    const baseline = harness.cp.repositories.list()[0]!;
    writeFileSync(join(harness.repoPath, "README.md"), "# owner changed this out of band\n");
    execFileSync("git", ["add", "README.md"], { cwd: harness.repoPath });
    execFileSync("git", ["commit", "-m", "owner change"], { cwd: harness.repoPath });

    const first = await harness.cp.doctor.run("system");
    const second = await harness.cp.doctor.run("system");

    expect(first.findings.map((finding) => finding.code)).toContain("REPOSITORY_DRIFT");
    expect(second.findings.map((finding) => finding.code)).toContain("REPOSITORY_DRIFT");
    expect(harness.cp.repositories.list()[0]!.lastObservedHead).toBe(baseline.lastObservedHead);
  });

  it("#112/#209: an unbound session cannot create a RUNNING receipt", async () => {
    const { harness, repositoryId, run } = await createDispatchedRun();
    const task = harness.cp.tasks.submit(run.runId, [{ key: "work", title: "work", category: "implementation" }]);
    if (!task.allowed) throw new Error(task.message);
    const worker = harness.cp.sessions.create({ provider: "scripted", model: "scripted-worker" });
    const ready = harness.cp.sessions.transition(worker.sessionId, SessionLifecycle.READY, "test worker");
    if (!ready.allowed) throw new Error(ready.message);
    const receipt = harness.cp.tasks.startExecution({
      runId: run.runId,
      taskId: task.value[0]!.taskId,
      ownerBindingGeneration: run.ownerBindingGeneration!,
      workerSessionId: worker.sessionId,
      workerProcessId: null,
      provider: "scripted",
      model: "scripted-worker",
      repositoryId,
    });
    expect(receipt.allowed).toBe(false);
    expect(receipt.reasonCode).toBe(ReasonCode.WORKER_BINDING_REQUIRED);
    expect(harness.cp.tasks.executions(run.runId)).toHaveLength(0);
  });

  it("#113/#210: a failed worktree probe blocks instead of becoming an empty result", async () => {
    const { harness } = await createQueuedRun();
    vi.spyOn(harness.cp.worktrees, "orphans").mockRejectedValueOnce(new Error("git worktree probe failed"));

    const report = await harness.cp.doctor.run("worktree");

    expect(report.status).toBe("BLOCKED");
    expect(report.findings.find((finding) => finding.code === "WORKTREE_PROBE_FAILED")?.observedEvidence).toMatchObject({
      error: "git worktree probe failed",
    });
  });

  it("#114/#211: an overdue live worker produces a blocking watchdog report", async () => {
    const { harness, repositoryId, run } = await createDispatchedRun();
    const task = harness.cp.tasks.submit(run.runId, [{ key: "work", title: "work", category: "implementation" }]);
    if (!task.allowed) throw new Error(task.message);
    const workerSessionId = bindWorker(harness, task.value[0]!.taskId);
    const receipt = harness.cp.tasks.startExecution({
      runId: run.runId,
      taskId: task.value[0]!.taskId,
      ownerBindingGeneration: run.ownerBindingGeneration!,
      workerSessionId,
      workerProcessId: process.pid,
      provider: "scripted",
      model: "scripted-worker",
      repositoryId,
    });
    if (!receipt.allowed) throw new Error(receipt.message);
    harness.clock.advance(45 * 60 * 1000);

    const tick = await harness.cp.watchdog.tick();
    const report = tick.reports.find((candidate) => candidate.scope === "run" && candidate.target === run.runId);

    expect(report?.status).toBe("BLOCKED");
    expect(report?.findings.map((finding) => finding.code)).toContain("WATCHDOG_STALL");
    expect(harness.cp.audit.byKind("DOCTOR_REPORT").at(-1)?.evidence).toMatchObject({ status: "BLOCKED" });
  });

  it("#335: watchdog reclaims a crashed attempt on its persisted deadline and records its exact finding", async () => {
    const { harness, run } = await createDispatchedRun();
    const startedAt = new Date(harness.clock.now().getTime() - 30 * 60 * 1000).toISOString();
    const deadlineAt = new Date(harness.clock.now().getTime() + 60_000).toISOString();
    harness.cp.db.run(
      `INSERT INTO candidate_pipeline_attempts
         (run_id, attempt_id, owner_session_id, owner_binding_generation, candidate_digest, state, started_at, deadline_at, released_at)
       VALUES (?, ?, ?, ?, NULL, 'RUNNING', ?, ?, NULL)`,
      [
        run.runId,
        "attempt_crashed",
        run.ownerSessionId,
        run.ownerBindingGeneration,
        startedAt,
        deadlineAt,
      ],
    );

    // A legacy started_at sweep would reclaim this old row immediately. The row's own
    // deadline is authoritative until it passes, even if the watchdog's policy later moves.
    const beforeDeadline = await harness.cp.watchdog.tick();
    expect(beforeDeadline.overdue).not.toContainEqual(expect.objectContaining({
      kind: "candidate_pipeline_attempt",
      id: "attempt_crashed",
    }));
    expect(harness.cp.db.get<{ state: string }>(
      `SELECT state FROM candidate_pipeline_attempts WHERE run_id = ?`,
      [run.runId],
    )).toEqual({ state: "RUNNING" });

    harness.clock.advance(60_000);
    const tick = await harness.cp.watchdog.tick();
    const report = tick.reports.find((candidate) => candidate.scope === "run" && candidate.target === run.runId);

    expect(tick.overdue).toContainEqual({
      kind: "candidate_pipeline_attempt",
      id: "attempt_crashed",
      ageMs: 31 * 60 * 1000,
    });
    expect(
      report?.findings.find((finding) => finding.code === ReasonCode.CANDIDATE_PIPELINE_ATTEMPT_STALE),
    ).toMatchObject({
      blocking: true,
      observedEvidence: { attemptId: "attempt_crashed", deadlineAt, reclaimed: true },
    });
    expect(
      harness.cp.db.get<{ state: string; released_at: string | null }>(
        `SELECT state, released_at FROM candidate_pipeline_attempts WHERE run_id = ?`,
        [run.runId],
      ),
    ).toMatchObject({ state: "RELEASED", released_at: harness.clock.nowIso() });
  });

  it("#115/#212: an absent repository denies repair with observed precondition evidence", async () => {
    const { harness } = await createQueuedRun();

    const repair = await harness.cp.repair.execute({
      operationId: "clear_repository_drift",
      parameters: { identity: "github:acme/missing" },
      authorizedBy: "HERMES",
      dryRun: false,
    });

    expect(repair.allowed).toBe(false);
    expect(repair.reasonCode).toBe(ReasonCode.REPAIR_PRECONDITION_UNMET);
    expect(repair.evidence).toMatchObject({
      preconditions: [
        { precondition: "the repository is readable", satisfied: false, evidence: { found: false } },
      ],
    });
    expect(harness.cp.audit.byKind("REPAIR_REFUSED")[0]?.reasonCode).toBe(ReasonCode.REPAIR_PRECONDITION_UNMET);
  });
});

describe("round 2 daemon regressions", () => {
  it("#116/#204: a blocking startup doctor runs before queued dispatch", async () => {
    const { harness, run } = await createQueuedRun();
    const stateDir = tempDir("acp-daemon-r2-");

    const started = await new Daemon(harness.cp, { stateDir }).start();

    expect(started.allowed).toBe(false);
    expect(started.reasonCode).toBe(ReasonCode.DOCTOR_BLOCKED);
    expect(harness.cp.runs.require(run.runId).state).toBe(RunState.QUEUED);
    expect(harness.cp.outbox.listByRun(run.runId)).toHaveLength(0);
  });

  it("#117/#205: a periodic watchdog failure is audited and degrades the health file", async () => {
    const { harness } = await makeDaemonStartHealthy();
    const stateDir = tempDir("acp-daemon-r2-");
    vi.spyOn(harness.cp.watchdog, "tick").mockRejectedValueOnce(new Error("watchdog database unavailable"));
    const daemon = new Daemon(harness.cp, { stateDir, watchdogIntervalMs: 1 });
    const started = await daemon.start();
    expect(started.allowed).toBe(true);

    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 25));
    const health = JSON.parse(readFileSync(join(stateDir, "health.json"), "utf8")) as {
      timerHealth: { status: string; failures: Record<string, { lastError: string }> };
    };

    expect(harness.cp.audit.byKind("DAEMON_TIMER_FAILED")[0]?.reasonCode).toBe(ReasonCode.DAEMON_TIMER_FAILED);
    expect(health.timerHealth).toMatchObject({
      status: "DEGRADED",
      failures: { watchdog: { lastError: "watchdog database unavailable" } },
    });
    await daemon.stop();
  });

  it("#639: a receipt port that fails every lookup is audited and degrades the health file, not read as an empty ledger", async () => {
    // A review found `reconcileUnresolved()` swallowing every per-turn lookup failure and then
    // returning as though it had succeeded — so a port failing on *every* call looked identical
    // to one with nothing to find, to `runPeriodic` and to the health file alike. This spies the
    // sweep straight to a nonzero `failed` count, the same shape a receipt port stuck failing
    // every lookup would actually produce, without needing a real port to make that happen.
    const { harness } = await makeDaemonStartHealthy();
    const stateDir = tempDir("acp-daemon-r2-");
    vi.spyOn(harness.cp.conversation, "reconcileUnresolved").mockResolvedValueOnce({
      swept: 3,
      settled: 0,
      unresolved: 3,
      failed: 3,
    });
    const daemon = new Daemon(harness.cp, {
      stateDir,
      turnReconcileIntervalMs: 2,
      turnReconcileBudgetMs: 1,
    });
    const started = await daemon.start();
    expect(started.allowed).toBe(true);

    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 25));
    const health = JSON.parse(readFileSync(join(stateDir, "health.json"), "utf8")) as {
      timerHealth: { status: string; failures: Record<string, { lastError: string }> };
    };

    expect(harness.cp.audit.byKind("DAEMON_TIMER_FAILED")[0]?.reasonCode).toBe(ReasonCode.DAEMON_TIMER_FAILED);
    expect(health.timerHealth).toMatchObject({
      status: "DEGRADED",
      failures: { turn_reconcile: { lastError: "3 of 3 receipt lookup(s) failed or timed out this sweep" } },
    });
    await daemon.stop();
  });

  it("#118: a stale malformed lock is reclaimed after the bounded writer grace", () => {
    const stateDir = tempDir("acp-lock-r2-");
    const path = join(stateDir, "agentcpd.lock");
    writeFileSync(path, "{");
    const old = new Date(Date.now() - 10_000);
    utimesSync(path, old, old);

    const lock = new SingleInstanceLock(path);
    const acquired = lock.acquire("2026-08-12T00:00:00.000Z");

    expect(acquired.allowed).toBe(true);
    expect(lock.read()?.pid).toBe(process.pid);
    lock.release();
  });

  it("#119/#207: a forged local MCP token is refused before MCP dispatch", async () => {
    const { harness } = await createQueuedRun();
    const peer = harness.cp.sessions.create({ provider: "scripted", model: "mcp-peer" });
    if (!peer.sessionSecret) throw new Error("test peer needs a session secret");
    expect(harness.cp.sessions.transition(peer.sessionId, SessionLifecycle.READY, "MCP test peer").reasonCode)
      .toBe(ReasonCode.OK);
    expect(harness.cp.bindings.bind({ role: Role.CEO, sessionId: peer.sessionId }).reasonCode)
      .toBe(ReasonCode.OK);

    const listeners = await startLocalMcpListeners(harness.cp, tempDir("acp-mcp-r2-"), "local-test-token");
    const hermesSocket = listeners.socketPaths[0];
    if (!hermesSocket) throw new Error("Hermes MCP listener was not started");
    const create = vi.spyOn(harness.cp.runs, "create");
    const mcpRequest = (token: string, idempotencyKey: string) => [
      { token, sessionId: peer.sessionId, sessionSecret: peer.sessionSecret },
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "ops-regression", version: "1" },
        },
      },
      { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "run_create",
          arguments: {
            idempotencyKey,
            executionMode: "SIMPLE",
            contract: CONTRACT,
          },
        },
      },
    ];

    try {
      // First prove that this exact wire sequence does reach the real tool handler when
      // authenticated; otherwise a forged-token test could pass because the protocol was
      // malformed rather than because the token boundary stopped dispatch.
      const admitted = await exchangeSocketLines(
        hermesSocket,
        mcpRequest("local-test-token", "mcp-token-valid"),
        (received) => received.includes('"id":2'),
      );
      expect(admitted).toContain('"id":2');
      expect(create).toHaveBeenCalledTimes(1);
      create.mockClear();

      const refused = await exchangeSocketLines(
        hermesSocket,
        mcpRequest("forged", "mcp-token-forged"),
        (received) => received.includes('"reasonCode"'),
      );
      expect(JSON.parse(refused.trim())).toMatchObject({
        ok: false,
        reasonCode: ReasonCode.MCP_PEER_UNAUTHENTICATED,
      });
      expect(create).not.toHaveBeenCalled();
      expect(
        harness.cp.db.get(`SELECT nonce FROM inbound_messages WHERE channel = 'mcp' AND nonce = ?`, [
          "mcp-token-forged",
        ]),
      ).toBeUndefined();
    } finally {
      create.mockRestore();
      await listeners.close();
    }
  });

  it("#338: Hermes accepts only its current CEO binding at handshake and on every request", async () => {
    const harness = makeHarness();
    const ceo = harness.cp.sessions.create({ provider: "scripted", model: "hermes-ceo" });
    const replacement = harness.cp.sessions.create({ provider: "scripted", model: "replacement-ceo" });
    const worker = harness.cp.sessions.create({ provider: "scripted", model: "worker-with-secret" });
    if (!ceo.sessionSecret || !replacement.sessionSecret || !worker.sessionSecret) {
      throw new Error("test peers need session secrets");
    }
    for (const session of [ceo, replacement, worker]) {
      expect(harness.cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "MCP test peer").reasonCode)
        .toBe(ReasonCode.OK);
    }
    expect(harness.cp.bindings.bind({ role: Role.CEO, sessionId: ceo.sessionId }).reasonCode)
      .toBe(ReasonCode.OK);

    const listeners = await startLocalMcpListeners(harness.cp, tempDir("acp-mcp-binding-"), "local-test-token");
    const hermesSocket = listeners.socketPaths[0];
    if (!hermesSocket) throw new Error("Hermes MCP listener was not started");
    const create = vi.spyOn(harness.cp.runs, "create");
    const toolCall = {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "run_create",
        arguments: { idempotencyKey: "mcp-role-denied", executionMode: "SIMPLE", contract: CONTRACT },
      },
    };

    try {
      const wrongRole = await exchangeSocketLines(
        hermesSocket,
        [
          { token: "local-test-token", sessionId: worker.sessionId, sessionSecret: worker.sessionSecret },
          { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "ops-regression", version: "1" } } },
          { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
          toolCall,
        ],
        (received) => received.includes('"reasonCode"'),
      );
      expect(JSON.parse(wrongRole.trim())).toMatchObject({
        ok: false,
        reasonCode: ReasonCode.BINDING_GENERATION_STALE,
      });

      let switched = false;
      const staleRequest = await exchangeAfterMcpInitialization(
        hermesSocket,
        { token: "local-test-token", sessionId: ceo.sessionId, sessionSecret: ceo.sessionSecret },
        () => {
          const switchResult = harness.cp.bindings.switchTo({
            role: Role.CEO,
            sessionId: replacement.sessionId,
            reason: "test CEO replacement",
            conversation: "REPLACED",
          });
          expect(switchResult.reasonCode).toBe(ReasonCode.OK);
          switched = true;
          return [{ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, toolCall];
        },
        (received) => received.includes(ReasonCode.BINDING_GENERATION_STALE),
      );
      expect(switched).toBe(true);
      expect(staleRequest).toContain(ReasonCode.BINDING_GENERATION_STALE);
      expect(create).not.toHaveBeenCalled();
    } finally {
      create.mockRestore();
      await listeners.close();
    }
  });

  it("#346: silent and non-READY local MCP peers are refused during the bounded handshake", async () => {
    const harness = makeHarness();
    const starting = harness.cp.sessions.create({ provider: "scripted", model: "starting-peer" });
    if (!starting.sessionSecret) throw new Error("test peer needs a session secret");
    const listeners = await startLocalMcpListeners(
      harness.cp,
      tempDir("acp-mcp-handshake-"),
      "local-test-token",
      { handshakeTimeoutMs: 25 },
    );
    const hermesSocket = listeners.socketPaths[0];
    if (!hermesSocket) throw new Error("Hermes MCP listener was not started");

    try {
      const silent = await exchangeSocketLines(
        hermesSocket,
        [],
        (received) => received.includes('"reasonCode"'),
      );
      expect(JSON.parse(silent.trim())).toMatchObject({
        ok: false,
        reasonCode: ReasonCode.MCP_PEER_UNAUTHENTICATED,
      });

      const nonReady = await exchangeSocketLines(
        hermesSocket,
        [{ token: "local-test-token", sessionId: starting.sessionId, sessionSecret: starting.sessionSecret }],
        (received) => received.includes('"reasonCode"'),
      );
      expect(JSON.parse(nonReady.trim())).toMatchObject({
        ok: false,
        reasonCode: ReasonCode.MCP_PEER_UNAUTHENTICATED,
      });
    } finally {
      await listeners.close();
    }
  });

  it("#378: a launched, unbound replacement can acknowledge only its delivered normal handoff", async () => {
    const harness = makeHarness();
    const launch = await startSessionLaunchChannel(tempDir("acp-session-launch-"));
    harness.cp.cto.attach({ sessionLaunch: launch });
    const { projectId } = await registerFixtureProject(harness);

    try {
      const incumbent = await harness.cp.cto.ensurePrimaryCto(projectId, "normal handoff setup");
      expect(incumbent.allowed).toBe(true);
      const prepared = await harness.cp.cto.prepareSwitchover(projectId, HANDOFF);
      expect(prepared.allowed).toBe(true);
      if (!prepared.allowed) return;

      const incoming = harness.cp.sessions.require(prepared.value.incomingSessionId);
      const credential = await claimLaunchedCredential(
        launch.socketPath,
        externalSessionIdOf(incoming.incarnation),
      );
      expect(credential).toMatchObject({
        sessionId: incoming.sessionId,
        sessionIncarnation: incoming.incarnation,
      });

      // The launch credential is consumed before the channel replies, so it cannot be
      // replayed by another local peer that learned the provider session id later.
      const replay = await exchangeSocketLines(
        launch.socketPath,
        [{ externalSessionId: externalSessionIdOf(incoming.incarnation) }],
        (received) => received.includes("\n"),
      );
      expect(JSON.parse(replay.trim())).toMatchObject({
        ok: false,
        reasonCode: ReasonCode.MCP_PEER_UNAUTHENTICATED,
      });

      const envelope = harness.cp.outbox.byIdempotencyKey(`handoff:${prepared.value.handoffId}`);
      expect(envelope).not.toBeNull();
      const claimed = harness.cp.outbox.claimDeliverable();
      const delivery = claimed.find((message) => message.messageId === envelope!.messageId);
      expect(delivery).toBeDefined();
      expect(harness.cp.outbox.markSent(envelope!.messageId, delivery!.claimToken).allowed).toBe(true);

      const listeners = await startLocalMcpListeners(harness.cp, tempDir("acp-mcp-handoff-"), "local-test-token");
      const ctoSocket = listeners.socketPaths[1];
      if (!ctoSocket) throw new Error("CTO MCP listener was not started");
      const handshake = {
        token: "local-test-token",
        sessionId: credential.sessionId,
        sessionSecret: credential.sessionSecret,
      };
      const initialize = {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "replacement-cto", version: "1" },
        },
      };

      try {
        const wrongTool = await exchangeSocketLines(
          ctoSocket,
          [
            handshake,
            initialize,
            { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
            {
              jsonrpc: "2.0",
              id: 2,
              method: "tools/call",
              params: {
                name: "capacity_get",
                arguments: { idempotencyKey: "handoff-wrong-tool", refresh: false },
              },
            },
          ],
          (received) => received.includes('"id":2'),
        );
        expect(wrongTool).toContain(ReasonCode.MCP_PEER_UNAUTHENTICATED);

        const acknowledged = await exchangeSocketLines(
          ctoSocket,
          [
            handshake,
            initialize,
            { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
            {
              jsonrpc: "2.0",
              id: 2,
              method: "tools/call",
              params: {
                name: "handoff_ack",
                arguments: {
                  idempotencyKey: "handoff-ack",
                  handoffId: prepared.value.handoffId,
                  messageId: envelope!.messageId,
                  payloadDigest: envelope!.payloadDigest,
                  bindingGeneration: envelope!.bindingGeneration,
                },
              },
            },
          ],
          (received) => received.includes('"id":2'),
        );
        expect(acknowledged).toContain(ReasonCode.OK);
        expect(harness.cp.bindings.activePrimaryCto(projectId)?.sessionId)
          .toBe(prepared.value.incomingSessionId);
      } finally {
        await listeners.close();
      }
    } finally {
      await launch.close();
    }
  });

  it("#378: a pending recipient is refused when its outgoing CTO generation has moved", async () => {
    const harness = makeHarness();
    const launch = await startSessionLaunchChannel(tempDir("acp-session-launch-stale-"));
    harness.cp.cto.attach({ sessionLaunch: launch });
    const { projectId } = await registerFixtureProject(harness);

    try {
      expect((await harness.cp.cto.ensurePrimaryCto(projectId, "stale handoff setup")).allowed).toBe(true);
      const prepared = await harness.cp.cto.prepareSwitchover(projectId, HANDOFF);
      expect(prepared.allowed).toBe(true);
      if (!prepared.allowed) return;

      const incoming = harness.cp.sessions.require(prepared.value.incomingSessionId);
      const credential = await claimLaunchedCredential(
        launch.socketPath,
        externalSessionIdOf(incoming.incarnation),
      );
      const envelope = harness.cp.outbox.byIdempotencyKey(`handoff:${prepared.value.handoffId}`);
      expect(envelope).not.toBeNull();
      const claimed = harness.cp.outbox.claimDeliverable();
      const delivery = claimed.find((message) => message.messageId === envelope!.messageId);
      expect(delivery).toBeDefined();
      expect(harness.cp.outbox.markSent(envelope!.messageId, delivery!.claimToken).allowed).toBe(true);

      // Model a concurrent binding switch through the binding API rather than mutating the
      // handoff row. The package remains PENDING, but its captured outgoing generation is
      // no longer the authority that could authorize an ACK.
      const successor = harness.cp.sessions.create({ provider: "scripted", model: "replacement" });
      expect(harness.cp.sessions.transition(successor.sessionId, SessionLifecycle.READY, "replacement ready").allowed)
        .toBe(true);
      expect(harness.cp.bindings.switchTo({
        role: Role.PRIMARY_CTO,
        projectId,
        sessionId: successor.sessionId,
        reason: "concurrent binding switch",
        conversation: "REPLACED",
      }).allowed).toBe(true);

      const listeners = await startLocalMcpListeners(harness.cp, tempDir("acp-mcp-stale-handoff-"), "local-test-token");
      const ctoSocket = listeners.socketPaths[1];
      if (!ctoSocket) throw new Error("CTO MCP listener was not started");
      try {
        const refused = await exchangeSocketLines(
          ctoSocket,
          [{ token: "local-test-token", sessionId: credential.sessionId, sessionSecret: credential.sessionSecret }],
          (received) => received.includes('"reasonCode"'),
        );
        expect(JSON.parse(refused.trim())).toMatchObject({
          ok: false,
          reasonCode: ReasonCode.BINDING_GENERATION_STALE,
        });
      } finally {
        await listeners.close();
      }
    } finally {
      await launch.close();
    }
  });

  it("#379/#380: a draining CTO can submit an in-flight receipt and the MCP boundary requires its worker identity", async () => {
    const { harness, projectId, repositoryId, run } = await createQueuedRun();
    const launch = await startSessionLaunchChannel(tempDir("acp-session-launch-"));
    harness.cp.cto.attach({ sessionLaunch: launch });

    try {
      const dispatched = await harness.cp.runs.dispatch(run.runId);
      expect(dispatched.allowed).toBe(true);
      if (!dispatched.allowed || !dispatched.value.ownerSessionId || !dispatched.value.ownerBindingGeneration) return;
      const outgoing = harness.cp.sessions.require(dispatched.value.ownerSessionId);
      const credential = await claimLaunchedCredential(
        launch.socketPath,
        externalSessionIdOf(outgoing.incarnation),
      );

      const task = harness.cp.tasks.submit(run.runId, [{
        key: "finish-existing-work",
        title: "finish existing work",
        category: "implementation",
      }]);
      expect(task.allowed).toBe(true);
      if (!task.allowed) return;
      const taskRecord = task.value[0];
      if (!taskRecord) throw new Error("task submission returned no task");
      const taskId = taskRecord.taskId;
      const workerSessionId = bindWorker(harness, taskId);
      const execution = harness.cp.tasks.startExecution({
        runId: run.runId,
        taskId,
        ownerBindingGeneration: dispatched.value.ownerBindingGeneration,
        workerSessionId,
        provider: "scripted",
        model: "scripted-worker",
        repositoryId,
      });
      expect(execution.allowed).toBe(true);
      if (!execution.allowed) return;
      harness.clock.advance(1_000);

      const draining = harness.cp.cto.requestReplacement(projectId, "replace after existing work");
      expect(draining).toMatchObject({ allowed: true, value: { activeRuns: 1 } });
      expect(harness.cp.sessions.require(outgoing.sessionId).lifecycle).toBe(SessionLifecycle.DRAINING);

      const queued = harness.cp.runs.create({
        projectId,
        executionMode: ExecutionMode.STANDARD,
        contract: CONTRACT,
        repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
      });
      expect(queued.allowed).toBe(true);
      if (!queued.allowed) return;
      const newDispatch = await harness.cp.runs.dispatch(queued.value.runId);
      expect(newDispatch.allowed).toBe(false);
      expect(newDispatch.reasonCode).toBe(ReasonCode.RUN_DISPATCH_BLOCKED_CTO_DRAINING);
      expect(harness.cp.runs.require(queued.value.runId).state).toBe(RunState.QUEUED);

      const listeners = await startLocalMcpListeners(harness.cp, tempDir("acp-mcp-draining-"), "local-test-token");
      const ctoSocket = listeners.socketPaths[1];
      if (!ctoSocket) throw new Error("CTO MCP listener was not started");
      try {
        const missingWorker = await exchangeSocketLines(
          ctoSocket,
          [
            {
              token: "local-test-token",
              sessionId: credential.sessionId,
              sessionSecret: credential.sessionSecret,
            },
            {
              jsonrpc: "2.0",
              id: 1,
              method: "initialize",
              params: {
                protocolVersion: "2025-11-25",
                capabilities: {},
                clientInfo: { name: "draining-cto", version: "1" },
              },
            },
            { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
            {
              jsonrpc: "2.0",
              id: 2,
              method: "tools/call",
              params: {
                name: "task_receipt_submit",
                arguments: {
                  idempotencyKey: "missing-worker-session-id",
                  runId: run.runId,
                  taskId,
                  phase: "started",
                  provider: "scripted",
                  model: "scripted-worker",
                  repositoryId,
                },
              },
            },
          ],
          (received) => received.includes('"id":2'),
        );
        expect(missingWorker).toContain("Input validation error: Invalid arguments for tool task_receipt_submit");
        expect(missingWorker).toContain("workerSessionId");
        expect(missingWorker).not.toContain(ReasonCode.WORKER_BINDING_REQUIRED);
        expect(harness.cp.tasks.executions(run.runId)).toHaveLength(1);

        const submitted = await exchangeSocketLines(
          ctoSocket,
          [
            {
              token: "local-test-token",
              sessionId: credential.sessionId,
              sessionSecret: credential.sessionSecret,
            },
            {
              jsonrpc: "2.0",
              id: 1,
              method: "initialize",
              params: {
                protocolVersion: "2025-11-25",
                capabilities: {},
                clientInfo: { name: "draining-cto", version: "1" },
              },
            },
            { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
            {
              jsonrpc: "2.0",
              id: 2,
              method: "tools/call",
              params: {
                name: "task_receipt_submit",
                arguments: {
                  idempotencyKey: "draining-in-flight-activity",
                  runId: run.runId,
                  taskId,
                  phase: "activity",
                  executionId: execution.value.executionId,
                  workerSessionId,
                },
              },
            },
          ],
          (received) => received.includes('"id":2'),
        );
        expect(submitted).toContain(ReasonCode.OK);
        expect(harness.cp.tasks.execution(execution.value.executionId)?.lastActivityAt)
          .toBe(harness.clock.nowIso());
      } finally {
        await listeners.close();
      }
    } finally {
      await launch.close();
    }
  });

  it("#124/#214: a signed Buzz admission binds the actor identity the adapter resolves", async () => {
    const { harness } = await createQueuedRun();
    const session = harness.cp.sessions.create({ provider: "scripted", model: "buzz-peer" });
    if (!session.sessionSecret) throw new Error("test session needs a session secret");
    expect(harness.cp.sessions.transition(session.sessionId, SessionLifecycle.READY, "Buzz test peer").reasonCode)
      .toBe(ReasonCode.OK);
    expect(harness.cp.bindings.bind({ role: Role.CEO, sessionId: session.sessionId }).reasonCode)
      .toBe(ReasonCode.OK);
    const adapter = new BuzzAdapter(
      harness.cp.db,
      harness.cp.clock,
      harness.cp.audit,
      harness.cp.sessions,
      harness.cp.bindings,
      harness.cp.outbox,
      new InMemoryBuzzTransport(),
    );

    const listener = await startBuzzActorIngressListener(harness.cp, tempDir("acp-buzz-ingress-"), {
      allowedActors: ["npub-authenticated"],
      secret: "buzz-ingress-test-secret",
    });
    const input = {
      actor: "npub-authenticated",
      sessionId: session.sessionId,
      sessionSecret: session.sessionSecret,
      nonce: "buzz-bind-1",
    };

    try {
      const forged = await exchangeSocketLines(
        listener.socketPath,
        [{ ...input, signature: "forged" }],
        (received) => received.includes('"reasonCode"'),
      );
      expect(JSON.parse(forged.trim())).toMatchObject({
        ok: false,
        reasonCode: ReasonCode.INGRESS_SIGNATURE_INVALID,
      });
      expect(harness.cp.sessions.require(session.sessionId).buzzActorId).toBeNull();
      expect(adapter.resolveActor("npub-authenticated")).toBeNull();

      const signature = ingressSignature(
        "buzz-ingress-test-secret",
        buzzActorBindingSigningRequest(input),
      );
      const admitted = await exchangeSocketLines(
        listener.socketPath,
        [{ ...input, signature }],
        (received) => received.includes('"reasonCode"'),
      );
      expect(JSON.parse(admitted.trim())).toMatchObject({ ok: true, reasonCode: ReasonCode.OK });
      expect(harness.cp.sessions.require(session.sessionId).buzzActorId).toBe("npub-authenticated");
      expect(adapter.resolveActor("npub-authenticated")).toMatchObject({
        role: Role.CEO,
        sessionId: session.sessionId,
        status: "ACTIVE",
      });
    } finally {
      await listener.close();
    }
  });

  it("#244: daemon-owned capacity sensors expose missing and stale observations", async () => {
    const { harness } = await makeDaemonStartHealthy();
    const missing = await harness.cp.doctor.run("capacity");
    expect(missing.findings.map((finding) => finding.code)).toContain(ReasonCode.CAPACITY_SENSOR_FILE_MISSING);

    const stateDir = tempDir("acp-daemon-r2-");
    const probe = vi.spyOn(harness.scripted, "probeCapacity");
    // A sweep must fit inside the interval between sweeps, so a test that shrinks the interval
    // to drive the timer has to shrink the budget with it. 1ms left no room for any budget at
    // all; 20ms still fires well inside the 25ms this test waits.
    const daemon = new Daemon(harness.cp, {
      stateDir, capacityRefreshIntervalMs: 20, capacityRefreshBudgetMs: 10,
    });
    const started = await daemon.start();
    expect(started.allowed).toBe(true);

    const sensor = join(harness.cp.config.capacityDir, "scripted.json");
    expect(JSON.parse(readFileSync(sensor, "utf8"))).toMatchObject({
      provider: "scripted",
      observedAt: harness.clock.nowIso(),
    });

    probe.mockClear();
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 25));
    expect(probe).toHaveBeenCalled();
    await daemon.stop();

    harness.clock.advance(5 * 60 * 1000 + 1);
    const stale = await harness.cp.doctor.run("capacity");
    expect(stale.findings.map((finding) => finding.code)).toContain(ReasonCode.CAPACITY_SENSOR_FILE_STALE);
  });

  it("#206: a real startup failure records and enforces crash-loop backoff", async () => {
    const { harness } = await makeDaemonStartHealthy();
    const stateDir = tempDir("acp-daemon-r2-");
    const failing = new Daemon(harness.cp, { stateDir });
    vi.spyOn(failing, "writeHealth").mockImplementation(() => {
      throw new Error("health storage unavailable");
    });

    const failed = await failing.start();
    const backoff = await new Daemon(harness.cp, { stateDir }).start();

    expect(failed.allowed).toBe(false);
    expect(failed.reasonCode).toBe(ReasonCode.DAEMON_STARTUP_FAILED);
    expect(harness.cp.audit.byKind("DAEMON_START_FAILED")[0]?.reasonCode).toBe(ReasonCode.DAEMON_STARTUP_FAILED);
    expect(backoff.allowed).toBe(false);
    expect(backoff.reasonCode).toBe(ReasonCode.DAEMON_BACKOFF_ACTIVE);
  });
});
