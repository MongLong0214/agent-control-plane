import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { CONTINUITY_COVERAGE_REVOCATION_REASON } from "../../src/continuity/continuity-kernel.ts";
import { deny } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { startLocalMcpListeners, startSessionLaunchChannel } from "../../src/daemon/agentcpd.ts";
import {
  ExecutionMode,
  Role,
  RunState,
  SessionLifecycle,
  TaskState,
  roleKeyFor,
} from "../../src/domain/types.ts";
import { RefreshTrigger } from "../../src/capacity/capacity-monitor.ts";
import type { TaskContract } from "../../src/run/run-engine.ts";
import type { CapacityReading, SessionHandle, SessionSpec } from "../../src/runtime/provider.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { bindWorker, fixtureManifest, makeHarness, registerFixtureProject, type Harness } from "../helpers/harness.ts";
import { TestProductionAdapter } from "../helpers/production-adapter.ts";

afterAll(cleanupTempDirs);
afterEach(() => vi.restoreAllMocks());

/**
 * #512 PR-A — the production path that mints a task's first WORKER binding.
 *
 * Every row that can goes through the real `cto.mcp.sock` served by `startLocalMcpListeners`, as
 * the CTO the run was dispatched to, authenticated with the credential its launch channel issued.
 * The worker provider is Claude, registered per role the way the shipped composition registers it
 * (`CTO_ROLES` in control-plane.ts): one adapter for CEO, BOOTSTRAP_CTO, PRIMARY_CTO and WORKER.
 * The adapter is a scripted double; only the model runtime is scripted.
 */
const TOKEN = "worker-provisioning-token";
const CTO_ROLES = [Role.CEO, Role.BOOTSTRAP_CTO, Role.PRIMARY_CTO, Role.WORKER] as const;
const BUCKET = "five_hour";

const CONTRACT: TaskContract = {
  goal: "staff a worker",
  why: "a run's task needs an implementer that is not its CTO",
  scope: ["src/app.js"],
  nonGoals: [],
  acceptance: ["the task runs on its own WORKER session"],
  priority: "NORMAL",
  humanGate: [],
  references: [],
};

/** A Claude double that records what was started and stopped, and can act during an await. */
class ClaudeDouble extends TestProductionAdapter {
  readonly started: SessionSpec[] = [];
  readonly stopped: string[] = [];
  capacityProbes = 0;
  /** Runs inside `startSession`, after the provider made the session and before it answers. */
  onStart: (() => void) | null = null;
  /** Runs inside `probeCapacity`, before the reading is answered. */
  onProbeCapacity: (() => void) | null = null;

  constructor(clock: Harness["clock"]) {
    super(clock, "claude");
  }

  override async startSession(spec: SessionSpec): Promise<SessionHandle> {
    this.started.push(spec);
    const handle = await super.startSession(spec);
    this.onStart?.();
    return handle;
  }

  override async stopSession(handle?: SessionHandle): Promise<void> {
    if (handle) this.stopped.push(handle.externalSessionId);
    return super.stopSession(handle);
  }

  override async probeCapacity(): Promise<CapacityReading> {
    this.capacityProbes += 1;
    this.onProbeCapacity?.();
    return super.probeCapacity();
  }
}

const resetAtFrom = (harness: Harness): string =>
  new Date(harness.clock.now().getTime() + 2 * 60 * 60 * 1000).toISOString();

/** What the Claude usage collector reports for one window: Claude's capabilities, worker included. */
const claudeReading = (harness: Harness, remainingPercent = 80): CapacityReading => ({
  provider: "claude",
  sensorHealth: "HEALTHY",
  runtimeHealth: "HEALTHY",
  observedAt: harness.clock.nowIso(),
  source: "worker-provisioning-fixture",
  buckets: [{
    id: BUCKET,
    remainingPercent,
    resetAt: resetAtFrom(harness),
    capabilities: ["cto", "ceo", "blind-review", "worker"],
  }],
});

/** A Claude reading `minutesAgo` minutes old, for the window `resetAt` (default: the current one). */
const claudeReadingAt = (
  harness: Harness,
  remainingPercent: number,
  minutesAgo: number,
  resetAt = resetAtFrom(harness),
): CapacityReading => ({
  ...claudeReading(harness, remainingPercent),
  observedAt: new Date(harness.clock.now().getTime() - minutesAgo * 60 * 1000).toISOString(),
  buckets: [{ ...claudeReading(harness, remainingPercent).buckets[0]!, resetAt }],
});

/**
 * Takes one real reading of the WORKER binding through the probe path (`refreshForRole`, the
 * adapter's `probeCapacity`), then leaves the double answering `next`. The §14.5 burn for a
 * role-scoped provider comes only from these in-memory readings; nothing here writes a database row.
 */
const takeWorkerReading = async (
  harness: Harness,
  claude: ClaudeDouble,
  reading: CapacityReading,
  next: CapacityReading = claudeReading(harness),
): Promise<void> => {
  claude.setCapacity(reading);
  await harness.cp.capacity.refreshForRole("claude", Role.WORKER);
  claude.setCapacity(next);
};

/**
 * Rows a deployment wrote to `capacity_snapshots` for `claude` before #917 made it role-scoped.
 * `measured` is two same-window rows that would measure a burn; `increase` is two rows whose
 * remaining quota rose, which that formula reads as unknown. Neither may reach a WORKER's burn.
 */
const seedPre917ClaudeRows = (harness: Harness, kind: "measured" | "increase"): void => {
  const now = harness.clock.now().getTime();
  const resetAt = resetAtFrom(harness);
  const series = kind === "measured" ? [[2, 82], [1, 81]] as const : [[2, 70], [1, 81]] as const;
  for (const [hoursAgo, remaining] of series) {
    harness.cp.db.run(
      `INSERT INTO capacity_snapshots (snapshot_id, provider, bucket_id, remaining_percent, reset_at,
                                       capabilities_json, sensor_health, runtime_health,
                                       allocation_admission, observed_at, source)
       VALUES (?, 'claude', ?, ?, ?, '["worker"]', 'HEALTHY', 'HEALTHY', 'OPEN', ?, 'pre-917-fixture')`,
      [randomUUID(), BUCKET, remaining, resetAt, new Date(now - hoursAgo * 60 * 60 * 1000).toISOString()],
    );
  }
};

interface ToolBody {
  ok: boolean;
  reasonCode: string;
  message?: string;
  value?: unknown;
  evidence?: Record<string, unknown>;
}

interface CtoClient {
  call(name: string, args: Record<string, unknown>): Promise<ToolBody>;
  listTools(): Promise<string[]>;
  close(): Promise<void>;
}

/** A real MCP client on `cto.mcp.sock`: credential line, initialize, then JSON-RPC by id. */
const connectCto = async (
  socketPath: string,
  credential: { sessionId: string; sessionSecret: string },
): Promise<CtoClient> => {
  const socket: Socket = createConnection(socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const pending = new Map<number, (message: { result?: unknown; error?: { message?: string } }) => void>();
  let nextId = 2;
  let buffer = "";
  socket.on("error", () => undefined);
  socket.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim().length === 0) continue;
      let message: { id?: number; method?: string; result?: unknown; error?: { message?: string } };
      try {
        message = JSON.parse(line) as typeof message;
      } catch {
        continue;
      }
      if (message.method === undefined && typeof message.id === "number" && pending.has(message.id)) {
        const settle = pending.get(message.id);
        pending.delete(message.id);
        settle?.(message);
      }
    }
  });
  const rpc = (method: string, params: Record<string, unknown>) =>
    new Promise<{ result?: unknown; error?: { message?: string } }>((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  const initialized = new Promise<void>((resolve) => pending.set(1, () => resolve()));
  socket.write(
    `${JSON.stringify({ token: TOKEN, ...credential })}\n${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "worker-cto", version: "1" } },
    })}\n${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`,
  );
  await initialized;
  return {
    call: async (name, args) => {
      const reply = await rpc("tools/call", { name, arguments: args });
      // A JSON-RPC error or an unstructured result is not a control-plane decision; it is reported
      // under INTERNAL_ERROR with the transport's own text, so no row can mistake it for a refusal.
      if (reply.error) return { ok: false, reasonCode: ReasonCode.INTERNAL_ERROR, message: `json-rpc: ${reply.error.message ?? ""}` };
      const result = reply.result as { structuredContent?: ToolBody; content?: { text?: string }[] } | undefined;
      return result?.structuredContent ?? {
        ok: false,
        reasonCode: ReasonCode.INTERNAL_ERROR,
        message: result?.content?.map((part) => part.text ?? "").join("\n") ?? "",
      };
    },
    listTools: async () => {
      const reply = await rpc("tools/list", {});
      return ((reply.result as { tools?: { name: string }[] } | undefined)?.tools ?? []).map((tool) => tool.name);
    },
    close: () =>
      new Promise<void>((resolve) => {
        if (socket.destroyed) {
          resolve();
          return;
        }
        socket.once("close", () => resolve());
        socket.destroy();
      }),
  };
};

/** Reads a launched runtime's one-time local credential exactly as the runtime would. */
const claimLaunchedCredential = (socketPath: string, externalSessionId: string) =>
  new Promise<{ sessionId: string; sessionSecret: string }>((resolve, reject) => {
    const socket = createConnection(socketPath);
    let received = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify({ externalSessionId })}\n`));
    socket.on("data", (chunk: string) => {
      received += chunk;
      if (!received.includes("\n")) return;
      socket.end();
      const body = JSON.parse(received.trim()) as { ok?: unknown; sessionId?: unknown; sessionSecret?: unknown };
      if (body.ok !== true || typeof body.sessionId !== "string" || typeof body.sessionSecret !== "string") {
        reject(new Error("launch credential was not available"));
        return;
      }
      resolve({ sessionId: body.sessionId, sessionSecret: body.sessionSecret });
    });
    socket.once("error", reject);
  });

/** A dispatched run owned by a launched CTO connected to its socket, and one READY task. */
interface FixtureOptions {
  /**
   * Whether one real, fresh WORKER reading (81%, three minutes old) is taken before the row runs
   * (default true). With it, the admission probe is the second reading and the window's burn is
   * measured.
   */
  primeReading?: boolean;
  /** Rows left in `capacity_snapshots` from before Claude was role-scoped. */
  pre917Rows?: "measured" | "increase";
}

const staffingFixture = async (options: FixtureOptions = {}) => {
  const harness = makeHarness();
  const { projectId, repositoryId } = await registerFixtureProject(harness);
  // As agentcpd composes it (O4): the registry beside the channel, and the lifecycle at its interactive-spawn door.
  const launch = await startSessionLaunchChannel(tempDir("acp-worker-launch-"), { sessions: harness.cp.sessions, audit: harness.cp.audit });
  harness.cp.cto.attach({ sessionLaunch: launch.interactiveSpawns });
  const created = harness.cp.runs.create({
    projectId,
    executionMode: ExecutionMode.STANDARD,
    contract: CONTRACT,
    repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
  });
  if (!created.allowed) throw new Error(created.message);
  const dispatched = await harness.cp.runs.dispatch(created.value.runId);
  if (!dispatched.allowed) throw new Error(dispatched.message);
  const run = dispatched.value;
  const ownerSessionId = run.ownerSessionId!;
  const owner = harness.cp.sessions.require(ownerSessionId);
  const credential = await claimLaunchedCredential(launch.socketPath, owner.incarnation.split("#", 1)[0]!);

  const claude = new ClaudeDouble(harness.clock);
  for (const role of CTO_ROLES) harness.cp.providers.registerForRole(claude, role);
  claude.setCapacity(claudeReading(harness));
  if (options.pre917Rows) seedPre917ClaudeRows(harness, options.pre917Rows);
  if (options.primeReading !== false) await takeWorkerReading(harness, claude, claudeReadingAt(harness, 81, 3));
  // Rows below count the probes *they* cause.
  claude.capacityProbes = 0;

  const submitted = harness.cp.tasks.submit(run.runId, [{ key: "impl", title: "implement", category: "implementation" }]);
  if (!submitted.allowed) throw new Error(submitted.message);
  const taskId = submitted.value[0]!.taskId;

  const listeners = await startLocalMcpListeners(harness.cp, tempDir("acp-worker-mcp-"), TOKEN);
  const ctoSocket = listeners.socketPaths[1];
  if (!ctoSocket) throw new Error("the CTO MCP listener was not started");
  const cto = await connectCto(ctoSocket, credential);
  const provision = (args: Record<string, unknown> = {}) =>
    cto.call("task_worker_provision", {
      idempotencyKey: randomUUID(),
      runId: run.runId,
      taskId,
      provider: "claude",
      ...args,
    });
  return {
    harness,
    run,
    runId: run.runId,
    projectId,
    repositoryId,
    ownerSessionId,
    taskId,
    claude,
    cto,
    ctoSocket,
    provision,
    close: async () => {
      await cto.close();
      await listeners.close();
      await launch.close();
    },
  };
};

type Fixture = Awaited<ReturnType<typeof staffingFixture>>;

const workerRows = (f: Fixture, taskId = f.taskId) =>
  f.harness.cp.db.all<{ status: string; session_id: string; binding_generation: number; run_id: string | null }>(
    `SELECT status, session_id, binding_generation, run_id FROM assignments WHERE role = 'WORKER' AND task_id = ?`,
    [taskId],
  );

const claudeSessions = (f: Fixture) =>
  f.harness.cp.db.all<{ session_id: string; lifecycle: string }>(
    `SELECT session_id, lifecycle FROM sessions WHERE provider = 'claude' ORDER BY created_at`,
  );

/** A refusal before anything was spawned: no capacity spent on a session, no session, no row. */
const expectNothingSpawned = (f: Fixture, workerRowsBefore: number): void => {
  expect(f.claude.started).toEqual([]);
  expect(claudeSessions(f)).toEqual([]);
  expect(workerRows(f)).toHaveLength(workerRowsBefore);
};

/** A refusal after the session existed: it was stopped through the provider, and nothing is READY. */
const expectSpawnedAndStopped = (f: Fixture, workerRowsBefore: number): void => {
  expect(f.claude.started).toHaveLength(1);
  const sessions = claudeSessions(f);
  expect(sessions).toHaveLength(1);
  expect(sessions[0]!.lifecycle).toBe(SessionLifecycle.STOPPED);
  expect(f.claude.stopped).toHaveLength(1);
  expect(workerRows(f).filter((row) => row.session_id === sessions[0]!.session_id)).toEqual([]);
  expect(workerRows(f)).toHaveLength(workerRowsBefore);
};

const withFixture = async (
  body: (f: Fixture) => Promise<void>,
  options: FixtureOptions = {},
): Promise<void> => {
  const f = await staffingFixture(options);
  try {
    await body(f);
  } finally {
    await f.close();
  }
};

describe("task_worker_provision mints a task's first WORKER binding (#512)", () => {
  it("is listed among the CTO tools", async () => {
    await withFixture(async (f) => {
      expect(await f.cto.listTools()).toContain("task_worker_provision");
    });
  });

  it("W1: binds WORKER:<task> at generation 1 on its own READY Claude Opus session, and the started receipt runs the task", async () => {
    await withFixture(async (f) => {
      const provisioned = await f.provision();
      const value = provisioned.value as { workerSessionId?: string; generation?: number } | undefined;
      const workerSessionId = value?.workerSessionId ?? "no-worker-session";
      const receipt = await f.cto.call("task_receipt_submit", {
        idempotencyKey: randomUUID(),
        runId: f.runId,
        taskId: f.taskId,
        phase: "started",
        workerSessionId,
        provider: "claude",
        model: "opus",
        repositoryId: f.repositoryId,
      });
      // Before #512 there was no way to reach this receipt with a bound worker: it was refused as
      // WORKER_BINDING_REQUIRED. Asserted first so a regression names that code.
      expect(receipt.reasonCode, receipt.message).toBe(ReasonCode.OK);
      expect(provisioned).toMatchObject({ ok: true, reasonCode: ReasonCode.OK, value: { generation: 1 } });

      const roleKey = roleKeyFor(Role.WORKER, { taskId: f.taskId });
      expect(f.harness.cp.bindings.active(roleKey)).toMatchObject({
        role: Role.WORKER,
        taskId: f.taskId,
        runId: f.runId,
        sessionId: workerSessionId,
        bindingGeneration: 1,
        status: "ACTIVE",
      });
      expect(workerRows(f)).toEqual([{ status: "ACTIVE", session_id: workerSessionId, binding_generation: 1, run_id: f.runId }]);
      const session = f.harness.cp.sessions.require(workerSessionId);
      expect(session).toMatchObject({ provider: "claude", model: "opus", lifecycle: SessionLifecycle.READY });
      expect(workerSessionId).not.toBe(f.ownerSessionId);
      expect(f.harness.cp.bindings.bySession(workerSessionId).map((binding) => binding.role)).toEqual([Role.WORKER]);
      expect(f.claude.started).toHaveLength(1);
      expect(f.claude.started[0]!.model).toBe("opus");
      expect(f.harness.cp.tasks.get(f.taskId)?.state).toBe(TaskState.RUNNING);
    });
  });

  it("W2: a second call for the same task is refused BINDING_ALREADY_ACTIVE and spawns nothing", async () => {
    await withFixture(async (f) => {
      expect((await f.provision()).ok).toBe(true);
      const firstSession = claudeSessions(f);
      const second = await f.provision();
      expect(second.reasonCode).toBe(ReasonCode.BINDING_ALREADY_ACTIVE);
      expect(f.claude.started).toHaveLength(1);
      expect(claudeSessions(f)).toEqual(firstSession);
      expect(workerRows(f)).toHaveLength(1);
    });
  });

  it("W3: refuses a PENDING task", async () => {
    await withFixture(async (f) => {
      const graph = f.harness.cp.tasks.submit(f.runId, [
        { key: "first", title: "first", category: "implementation" },
        { key: "second", title: "second", category: "implementation", dependsOn: ["first"] },
      ]);
      if (!graph.allowed) throw new Error(graph.message);
      const pending = graph.value[1]!;
      expect(f.harness.cp.tasks.get(pending.taskId)?.state).toBe(TaskState.PENDING);
      const refused = await f.provision({ taskId: pending.taskId });
      expect(refused.reasonCode).toBe(ReasonCode.TASK_DEPENDENCY_UNSATISFIED);
      expect(f.claude.started).toEqual([]);
      expect(claudeSessions(f)).toEqual([]);
      expect(workerRows(f, pending.taskId)).toEqual([]);
    });
  });

  it.each([TaskState.RUNNING, TaskState.SUCCEEDED])("W3: refuses a %s task", async (state) => {
    await withFixture(async (f) => {
      const worker = bindWorker(f.harness, f.taskId);
      const execution = f.harness.cp.tasks.startExecution({
        runId: f.runId,
        taskId: f.taskId,
        ownerBindingGeneration: f.run.ownerBindingGeneration!,
        workerSessionId: worker,
        provider: "scripted",
        model: "scripted-worker",
        repositoryId: f.repositoryId,
      });
      if (!execution.allowed) throw new Error(execution.message);
      if (state === TaskState.SUCCEEDED) {
        const finished = f.harness.cp.tasks.finishExecution(execution.value.executionId, { status: "SUCCEEDED", resultDigest: `sha256:${"a".repeat(64)}` });
        if (!finished.allowed) throw new Error(finished.message);
      }
      expect(f.harness.cp.tasks.get(f.taskId)?.state).toBe(state);
      const refused = await f.provision();
      expect(refused.reasonCode).toBe(ReasonCode.TASK_DEPENDENCY_UNSATISFIED);
      expectNothingSpawned(f, 1);
    });
  });

  it("W3: refuses a task that belongs to another run", async () => {
    await withFixture(async (f) => {
      const other = f.harness.cp.runs.create({
        projectId: f.projectId,
        executionMode: ExecutionMode.STANDARD,
        contract: CONTRACT,
        repositories: [{ repositoryId: f.repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
      });
      if (!other.allowed) throw new Error(other.message);
      const foreign = f.harness.cp.tasks.submit(other.value.runId, [{ key: "x", title: "foreign", category: "implementation" }]);
      if (!foreign.allowed) throw new Error(foreign.message);
      const refused = await f.provision({ taskId: foreign.value[0]!.taskId });
      expect(refused.reasonCode).toBe(ReasonCode.WRITE_TARGET_OUTSIDE_RUN_SCOPE);
      expect(f.claude.started).toEqual([]);
      expect(claudeSessions(f)).toEqual([]);
      expect(workerRows(f, foreign.value[0]!.taskId)).toEqual([]);
    });
  });

  it.each([RunState.BLOCKED, RunState.READY_FOR_CEO_REVIEW])("W4: refuses a run in %s", async (state) => {
    await withFixture(async (f) => {
      expect(f.harness.cp.runs.transition(f.runId, state, "worker provisioning row").allowed).toBe(true);
      const refused = await f.provision();
      expect(refused.reasonCode).toBe(ReasonCode.RUN_TRANSITION_ILLEGAL);
      expectNothingSpawned(f, 0);
    });
  });

  it("W5: refuses a peer that does not own the run, before capacity is probed", async () => {
    await withFixture(async (f) => {
      const otherProjectId = "another-project";
      const manifest = fixtureManifest(otherProjectId);
      const registered = f.harness.cp.projects.register({
        projectId: otherProjectId,
        name: "fixture",
        manifest,
        authorization: f.harness.cp.manifestAuthorizationForTests(manifest),
      });
      if (!registered.allowed) throw new Error(registered.message);
      const stranger = f.harness.cp.sessions.create({ provider: "scripted", model: "other-project-cto" });
      expect(f.harness.cp.sessions.transition(stranger.sessionId, SessionLifecycle.READY, "peer").allowed).toBe(true);
      expect(f.harness.cp.bindings.bind({ role: Role.PRIMARY_CTO, sessionId: stranger.sessionId, projectId: otherProjectId }).allowed)
        .toBe(true);
      const peer = await connectCto(f.ctoSocket, { sessionId: stranger.sessionId, sessionSecret: stranger.sessionSecret! });
      try {
        const refused = await peer.call("task_worker_provision", {
          idempotencyKey: randomUUID(), runId: f.runId, taskId: f.taskId, provider: "claude",
        });
        // The stranger's session is real and currently authenticated; the run-owner fence refuses
        // it for not owning this run, so S9 (CEO 2026-10-26) names that RUN_OWNER_REVOKED, not an
        // authentication failure.
        expect(refused.reasonCode).toBe(ReasonCode.RUN_OWNER_REVOKED);
      } finally {
        await peer.close();
      }
      expect(f.claude.capacityProbes).toBe(0);
      expectNothingSpawned(f, 0);
    });
  });

  it("W5: refuses the run's former owner after a takeover moved the run to a new generation", async () => {
    await withFixture(async (f) => {
      const successor = f.harness.cp.sessions.create({ provider: "scripted", model: "successor-cto" });
      expect(f.harness.cp.sessions.transition(successor.sessionId, SessionLifecycle.READY, "successor").allowed).toBe(true);
      expect(f.harness.cp.bindings.switchTo({
        role: Role.PRIMARY_CTO,
        projectId: f.projectId,
        sessionId: successor.sessionId,
        reason: "takeover before provisioning",
        conversation: "REPLACED",
        takeover: true,
      }).allowed).toBe(true);
      const refused = await f.provision();
      expect(refused.reasonCode).toBe(ReasonCode.BINDING_GENERATION_STALE);
      expect(f.claude.capacityProbes).toBe(0);
      expectNothingSpawned(f, 0);
    });
  });

  it("W5: refuses when the owner is rebound at a new generation while the session is being started", async () => {
    await withFixture(async (f) => {
      f.claude.onStart = () => {
        f.claude.onStart = null;
        const switched = f.harness.cp.bindings.switchTo({
          role: Role.PRIMARY_CTO,
          projectId: f.projectId,
          sessionId: f.ownerSessionId,
          reason: "same owner, new generation",
          conversation: "REPLACED",
          takeover: true,
        });
        if (!switched.allowed) throw new Error(switched.message);
      };
      const refused = await f.provision();
      expect(refused.reasonCode).toBe(ReasonCode.BINDING_GENERATION_STALE);
      expectSpawnedAndStopped(f, 0);
    });
  });

  it("W5: refuses when the run is taken over while the session is being started", async () => {
    await withFixture(async (f) => {
      const successor = f.harness.cp.sessions.create({ provider: "scripted", model: "successor-cto" });
      expect(f.harness.cp.sessions.transition(successor.sessionId, SessionLifecycle.READY, "successor").allowed).toBe(true);
      f.claude.onStart = () => {
        f.claude.onStart = null;
        const switched = f.harness.cp.bindings.switchTo({
          role: Role.PRIMARY_CTO,
          projectId: f.projectId,
          sessionId: successor.sessionId,
          reason: "takeover during provisioning",
          conversation: "REPLACED",
          takeover: true,
        });
        if (!switched.allowed) throw new Error(switched.message);
      };
      const refused = await f.provision();
      // The original owner's session is still a real, currently authenticated session; the
      // takeover moved the run's owner away from it, so S9 (CEO 2026-10-26) names that
      // RUN_OWNER_REVOKED, not an authentication failure.
      expect(refused.reasonCode).toBe(ReasonCode.RUN_OWNER_REVOKED);
      expectSpawnedAndStopped(f, 0);
    });
  });

  it("W5: refuses when the run is taken over during capacity admission, before a session is spawned", async () => {
    await withFixture(async (f) => {
      const successor = f.harness.cp.sessions.create({ provider: "scripted", model: "successor-cto" });
      expect(f.harness.cp.sessions.transition(successor.sessionId, SessionLifecycle.READY, "successor").allowed).toBe(true);
      f.claude.onProbeCapacity = () => {
        f.claude.onProbeCapacity = null;
        const switched = f.harness.cp.bindings.switchTo({
          role: Role.PRIMARY_CTO,
          projectId: f.projectId,
          sessionId: successor.sessionId,
          reason: "takeover during capacity admission",
          conversation: "REPLACED",
          takeover: true,
        });
        if (!switched.allowed) throw new Error(switched.message);
      };
      const refused = await f.provision();
      // Same cause as the prior case, caught at the capacity-admission re-check instead of
      // session start: a real, currently authenticated owner whose takeover-moved run is now
      // RUN_OWNER_REVOKED (S9, CEO 2026-10-26), not MCP_PEER_UNAUTHENTICATED.
      expect(refused.reasonCode).toBe(ReasonCode.RUN_OWNER_REVOKED);
      expectNothingSpawned(f, 0);
    });
  });

  it("W7: refuses a task whose WORKER role continuity revoked: BINDING_REVOKED, replacement is not this tool's", async () => {
    await withFixture(async (f) => {
      bindWorker(f.harness, f.taskId);
      const roleKey = roleKeyFor(Role.WORKER, { taskId: f.taskId });
      expect(f.harness.cp.bindings.revoke(roleKey, CONTINUITY_COVERAGE_REVOCATION_REASON).allowed).toBe(true);
      const refused = await f.provision();
      expect(refused.reasonCode).toBe(ReasonCode.BINDING_REVOKED);
      expect(f.harness.cp.bindings.active(roleKey)).toBeNull();
      expectNothingSpawned(f, 1);
    });
  });

  it("W9: a session whose health probe answers UNAVAILABLE is stopped, and nothing is bound", async () => {
    await withFixture(async (f) => {
      f.claude.setNextSessionHealth("UNAVAILABLE");
      const refused = await f.provision();
      expect(refused.reasonCode).toBe(ReasonCode.SESSION_NOT_READY);
      expectSpawnedAndStopped(f, 0);
    });
  });

  it("W9: a session the doctor's readiness gate refuses is stopped, and nothing is bound", async () => {
    await withFixture(async (f) => {
      const readiness = vi.spyOn(f.harness.cp.doctor, "sessionReadiness")
        .mockResolvedValue(deny(ReasonCode.SESSION_NOT_READY, "runtime is not ready"));
      const refused = await f.provision();
      expect(refused.reasonCode).toBe(ReasonCode.SESSION_NOT_READY);
      expect(readiness).toHaveBeenCalledTimes(1);
      expectSpawnedAndStopped(f, 0);
    });
  });

  it("W10: a binding that appears while the session is started is refused, and the session is stopped", async () => {
    await withFixture(async (f) => {
      let intruder = "";
      f.claude.onStart = () => {
        f.claude.onStart = null;
        intruder = bindWorker(f.harness, f.taskId);
      };
      const refused = await f.provision();
      expect(refused.reasonCode).toBe(ReasonCode.BINDING_ALREADY_ACTIVE);
      expectSpawnedAndStopped(f, 1);
      expect(f.harness.cp.bindings.active(roleKeyFor(Role.WORKER, { taskId: f.taskId }))?.sessionId).toBe(intruder);
    });
  });

  it("W10: a WORKER history that appears while the session is started is refused BINDING_REVOKED", async () => {
    await withFixture(async (f) => {
      f.claude.onStart = () => {
        f.claude.onStart = null;
        bindWorker(f.harness, f.taskId);
        const revoked = f.harness.cp.bindings.revoke(roleKeyFor(Role.WORKER, { taskId: f.taskId }), "operator release");
        if (!revoked.allowed) throw new Error(revoked.message);
      };
      const refused = await f.provision();
      expect(refused.reasonCode).toBe(ReasonCode.BINDING_REVOKED);
      expectSpawnedAndStopped(f, 1);
    });
  });

  it("W10: a run that leaves ACTIVE while the session is started is refused, and the session is stopped", async () => {
    await withFixture(async (f) => {
      f.claude.onStart = () => {
        f.claude.onStart = null;
        const moved = f.harness.cp.runs.transition(f.runId, RunState.BLOCKED, "blocked during provisioning");
        if (!moved.allowed) throw new Error(moved.message);
      };
      const refused = await f.provision();
      expect(refused.reasonCode).toBe(ReasonCode.RUN_TRANSITION_ILLEGAL);
      expectSpawnedAndStopped(f, 0);
    });
  });

  it("W10: a binding that appears during capacity admission is refused before a session is spawned", async () => {
    await withFixture(async (f) => {
      f.claude.onProbeCapacity = () => {
        f.claude.onProbeCapacity = null;
        bindWorker(f.harness, f.taskId);
      };
      const refused = await f.provision();
      expect(refused.reasonCode).toBe(ReasonCode.BINDING_ALREADY_ACTIVE);
      expectNothingSpawned(f, 1);
    });
  });

  it("refuses a provider the worker table does not list and a Claude model other than Opus; never substitutes", async () => {
    await withFixture(async (f) => {
      const unlisted = await f.provision({ provider: "grok" });
      expect(unlisted.reasonCode).toBe(ReasonCode.INVALID_ARGUMENT);
      const sonnet = await f.provision({ model: "sonnet" });
      expect(sonnet.reasonCode).toBe(ReasonCode.INVALID_ARGUMENT);
      expect(f.claude.capacityProbes).toBe(0);
      expectNothingSpawned(f, 0);
      const missing = await f.cto.call("task_worker_provision", {
        idempotencyKey: randomUUID(), runId: f.runId, taskId: f.taskId,
      });
      expect(missing.ok).toBe(false);
      expectNothingSpawned(f, 0);
    });
  });
});

/** Provisions the task's worker through the socket and answers its session id. */
const provisionedWorker = async (f: Fixture): Promise<string> => {
  const provisioned = await f.provision();
  if (!provisioned.ok) throw new Error(`provisioning failed: ${provisioned.reasonCode} ${provisioned.message ?? ""}`);
  return (provisioned.value as { workerSessionId: string }).workerSessionId;
};

describe("ACP1069-R1-03: a worker receipt is admitted and recorded as its session's own provider and model", () => {
  const started = (f: Fixture, workerSessionId: string, fields: Record<string, unknown> = {}) =>
    f.cto.call("task_receipt_submit", {
      idempotencyKey: randomUUID(),
      runId: f.runId,
      taskId: f.taskId,
      phase: "started",
      workerSessionId,
      repositoryId: f.repositoryId,
      ...fields,
    });

  const recorded = (f: Fixture) => ({
    executions: f.harness.cp.db.all<{ provider: string; model: string }>(
      `SELECT provider, model FROM task_executions WHERE task_id = ?`,
      [f.taskId],
    ),
    invocations: f.harness.cp.db.all<{ payload_json: string }>(
      `SELECT payload_json FROM baseline_records WHERE run_id = ? AND record_kind = 'INVOCATION_STARTED'`,
      [f.runId],
    ).map((row) => {
      const payload = (JSON.parse(row.payload_json) as { payload: { provider: string; requestedModel: string } }).payload;
      return { provider: payload.provider, requestedModel: payload.requestedModel };
    }),
  });

  it("refuses a receipt naming gpt, against measured GPT capacity, while Claude is unreadable", async () => {
    await withFixture(async (f) => {
      const worker = await provisionedWorker(f);
      const gpt = new TestProductionAdapter(f.harness.clock, "gpt");
      f.harness.cp.providers.register(gpt);
      const resetAt = resetAtFrom(f.harness);
      for (const [minutesAgo, remaining] of [[2, 81], [0, 80]] as const) {
        gpt.setCapacity({
          provider: "gpt", sensorHealth: "HEALTHY", runtimeHealth: "HEALTHY",
          observedAt: new Date(f.harness.clock.now().getTime() - minutesAgo * 60_000).toISOString(),
          source: "gpt-fixture",
          buckets: [{ id: BUCKET, remainingPercent: remaining, resetAt, capabilities: ["worker"] }],
        });
        await f.harness.cp.capacity.refresh(RefreshTrigger.DOCTOR_CAPACITY_REPORT, ["gpt"]);
      }
      f.claude.setCapacity({ ...claudeReading(f.harness), sensorHealth: "ERROR", buckets: [], error: "collector failed" });
      const probes = f.claude.capacityProbes;
      const refused = await started(f, worker, { provider: "gpt", model: "opus" });
      expect(refused.reasonCode).toBe(ReasonCode.CONFLICT);
      expect(f.claude.capacityProbes).toBe(probes);
      expect(f.harness.cp.tasks.get(f.taskId)?.state).toBe(TaskState.READY);
      expect(recorded(f).executions).toEqual([]);
    });
  });

  it("refuses a receipt naming sonnet for an Opus worker session", async () => {
    await withFixture(async (f) => {
      const worker = await provisionedWorker(f);
      const refused = await started(f, worker, { provider: "claude", model: "sonnet" });
      expect(refused.reasonCode).toBe(ReasonCode.CONFLICT);
      expect(f.harness.cp.tasks.get(f.taskId)?.state).toBe(TaskState.READY);
      expect(recorded(f).executions).toEqual([]);
    });
  });

  it("admits a receipt that omits provider and model as the session's claude/opus, and records those labels", async () => {
    await withFixture(async (f) => {
      const worker = await provisionedWorker(f);
      const probes = f.claude.capacityProbes;
      const accepted = await started(f, worker);
      expect(accepted.reasonCode, accepted.message).toBe(ReasonCode.OK);
      expect(f.claude.capacityProbes).toBe(probes + 1);
      expect(recorded(f)).toEqual({
        executions: [{ provider: "claude", model: "opus" }],
        invocations: [{ provider: "claude", requestedModel: "opus" }],
      });
    });
  });

  it("refuses when the session's identity differs inside the recording transaction from the one admitted", async () => {
    await withFixture(async (f) => {
      const worker = await provisionedWorker(f);
      f.claude.onProbeCapacity = () => {
        f.claude.onProbeCapacity = null;
        // No writer changes a session's model; this stands in for one that would, mid-admission.
        f.harness.cp.db.run(`UPDATE sessions SET model = 'sonnet' WHERE session_id = ?`, [worker]);
      };
      const refused = await started(f, worker, { provider: "claude", model: "opus" });
      expect(refused.reasonCode).toBe(ReasonCode.CONFLICT);
      expect(f.harness.cp.tasks.get(f.taskId)?.state).toBe(TaskState.READY);
      expect(recorded(f).executions).toEqual([]);
    });
  });
});
