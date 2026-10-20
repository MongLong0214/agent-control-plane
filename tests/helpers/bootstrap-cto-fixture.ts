import { createConnection } from "node:net";

import { ReasonCode } from "../../src/core/reason-codes.ts";
import { startLocalMcpListeners, startSessionLaunchChannel, wakeRoleHolder } from "../../src/daemon/agentcpd.ts";
import { Daemon } from "../../src/daemon/daemon.ts";
import { ExecutionMode, Role, RunKind, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import type { TaskContract } from "../../src/run/run-engine.ts";
import type { CapacityReading, SessionHandle, SessionSpec } from "../../src/runtime/provider.ts";
import { tempDir } from "./fixtures.ts";
import { makeHarness } from "./harness.ts";
import { HeadlessRuntimeDouble } from "./headless-runtime.ts";
import { callMcpToolOverSocket } from "./mcp-socket.ts";

export const BOOTSTRAP_FIXTURE_TOKEN = "bootstrap-runtime-token";

const CONTRACT: TaskContract = {
  goal: "bootstrap a new project",
  why: "the owner asked for a repository that does not exist yet",
  scope: [],
  nonGoals: [],
  acceptance: ["the project exists and its CTO is bound"],
  priority: "NORMAL",
  humanGate: [],
  references: [],
};

/** A headless Claude double that also records what was started and stopped. */
export class RecordingRuntimeDouble extends HeadlessRuntimeDouble {
  readonly started: SessionSpec[] = [];
  readonly stopped: string[] = [];

  override async startSession(spec: SessionSpec): Promise<SessionHandle> {
    this.started.push(spec);
    return super.startSession(spec);
  }

  override async stopSession(handle?: SessionHandle): Promise<void> {
    if (handle) this.stopped.push(handle.externalSessionId);
    return super.stopSession(handle);
  }
}

/**
 * #246 C1b — a project-less bootstrap run's world over the real sockets: `hermes.mcp.sock` as the
 * CEO, `cto.mcp.sock` and the take-once launch channel (handing out the socket gate too) as the
 * bootstrap CTO's runtime reaches them, a headless Claude double for the role, a GPT provider
 * standing by, and a daemon to reconcile continuity. Only the model is scripted.
 */
export const bootstrapRuntimeFixture = async (harnessOptions: Parameters<typeof makeHarness>[0] = {}) => {
  const harness = makeHarness(harnessOptions);
  const launch = await startSessionLaunchChannel(tempDir("acp-c1b-launch-"), { mcpToken: BOOTSTRAP_FIXTURE_TOKEN });
  const claude = new RecordingRuntimeDouble(harness.clock, "claude");
  claude.observeCredentialCustody(harness.cp.sessionRuntime, harness.cp.sessions, BOOTSTRAP_FIXTURE_TOKEN);
  harness.cp.providers.registerForRole(claude, Role.BOOTSTRAP_CTO);
  const gpt = new RecordingRuntimeDouble(harness.clock, "gpt");
  gpt.setCapacity({
    provider: "gpt",
    sensorHealth: "HEALTHY",
    runtimeHealth: "HEALTHY",
    observedAt: harness.clock.nowIso(),
    source: "c1b-fixture",
    buckets: [{ id: "gpt-window", remainingPercent: 90, resetAt: null, capabilities: ["ceo", "cto", "blind-review", "worker"] }],
  });
  harness.cp.providers.register(gpt);

  const ceo = harness.cp.sessions.create({ provider: "scripted", model: "c1b-ceo" });
  const ceoSecret = ceo.sessionSecret;
  if (!ceoSecret) throw new Error("the CEO session has no secret");
  harness.cp.sessions.transition(ceo.sessionId, SessionLifecycle.READY, "fixture CEO");
  const boundCeo = harness.cp.bindings.bind({ role: Role.CEO, sessionId: ceo.sessionId });
  if (!boundCeo.allowed) throw new Error(boundCeo.message);

  const listeners = await startLocalMcpListeners(harness.cp, tempDir("acp-c1b-mcp-"), BOOTSTRAP_FIXTURE_TOKEN);
  const [hermesSocket, ctoSocket] = listeners.socketPaths;
  if (!hermesSocket || !ctoSocket) throw new Error("the MCP listeners were not started");
  harness.cp.sessionRuntime.attach({
    delivery: launch,
    route: { launchSocketPath: launch.socketPath, mcpSocketPath: ctoSocket },
  });
  // The daemon's in-band wake, as `startDaemonMcpListeners` attaches it: a provisioned session's
  // RUN_DISPATCH starts a turn of its conversation.
  harness.cp.outbox.attachInBandWake((roleKey, messageIds) =>
    wakeRoleHolder(harness.cp, listeners.ctoConversation, roleKey, { kind: "in-band dispatch", ids: messageIds ?? [] }));
  const daemon = new Daemon(harness.cp, { stateDir: tempDir("acp-c1b-daemon-") });

  let keys = 0;
  const hermes = (name: string, args: Record<string, unknown>) =>
    callMcpToolOverSocket(
      hermesSocket,
      { token: BOOTSTRAP_FIXTURE_TOKEN, sessionId: ceo.sessionId, sessionSecret: ceoSecret },
      name,
      { idempotencyKey: `c1b-${++keys}`, ...args },
    );
  /** A tool call as the session's runtime makes it: with the credential that runtime last took. */
  const cto = (sessionId: string, name: string, args: Record<string, unknown>) => {
    const credential = claude.credentials.get(sessionId);
    if (!credential) throw new Error("the session's runtime never took its credential");
    return callMcpToolOverSocket(
      ctoSocket,
      { token: BOOTSTRAP_FIXTURE_TOKEN, sessionId: credential.sessionId, sessionSecret: credential.sessionSecret },
      name,
      { idempotencyKey: `c1b-${++keys}`, ...args },
    );
  };
  const createBootstrap = async (): Promise<string> => {
    const created = await hermes("run_create", {
      kind: RunKind.PROJECT_BOOTSTRAP,
      executionMode: ExecutionMode.STANDARD,
      contract: CONTRACT,
    });
    if (created["ok"] !== true) throw new Error(`run_create refused: ${JSON.stringify(created)}`);
    return (created["value"] as { runId: string }).runId;
  };
  const dispatchBootstrap = async (): Promise<{ runId: string; ownerSessionId: string; roleKey: string }> => {
    const runId = await createBootstrap();
    const dispatched = await hermes("run_dispatch", { runId });
    if (dispatched["ok"] !== true) throw new Error(`run_dispatch refused: ${JSON.stringify(dispatched)}`);
    return {
      runId,
      ownerSessionId: harness.cp.runs.require(runId).ownerSessionId!,
      roleKey: roleKeyFor(Role.BOOTSTRAP_CTO, { runId }),
    };
  };
  /** Claude's runtime stops answering: the role it fixes cannot be covered. */
  const loseClaude = (forgetCredential = true): void => {
    const reading: CapacityReading = {
      provider: "claude",
      sensorHealth: "HEALTHY",
      runtimeHealth: "UNAVAILABLE",
      observedAt: harness.clock.nowIso(),
      source: "c1b-fixture",
      buckets: [],
    };
    claude.setCapacity(reading);
    claude.setRuntimeHealth("UNAVAILABLE");
    // Simulate the runtime connection being lost, rather than treating its quota as authority.
    for (const session of harness.cp.db.all<{ session_id: string }>("SELECT session_id FROM sessions WHERE provider = 'claude'")) {
      if (forgetCredential) harness.cp.sessionRuntime.release(session.session_id);
    }
  };
  /** Claude answers again with a healthy window. */
  const restoreClaude = (): void => {
    claude.setCapacity(null);
    claude.setRuntimeHealth("HEALTHY");
  };
  /** Turns of this session that have finished: the driver records one when a turn returns. */
  const finishedTurns = (sessionId: string): number =>
    harness.cp.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'SESSION_TURN' AND session_id = ?`,
      [sessionId],
    )?.n ?? 0;
  /**
   * What a session's turns reached, for a failure message: how many finished, whether one is still
   * running or queued, each finished or refused turn's purpose and reason, the in-band rows addressed
   * to the session, and every failed wake of their role.
   */
  const turnState = (sessionId: string): string => {
    const audited = harness.cp.db.all<{ kind: string; reason_code: string | null; evidence_json: string }>(
      `SELECT kind, reason_code, evidence_json FROM audit_events
        WHERE (session_id = ? AND kind IN ('SESSION_TURN', 'SESSION_TURN_REFUSED'))
           OR (kind = 'OUTBOX_IN_BAND_WAKE_FAILED' AND role_key IN (SELECT role_key FROM outbox WHERE target_session_id = ?))
        ORDER BY event_id`,
      [sessionId, sessionId],
    ).map((row) => `${row.kind}(${(JSON.parse(row.evidence_json) as { purpose?: string }).purpose ?? "-"}, ${row.reason_code ?? "-"})`);
    const inBand = harness.cp.db.all<{ kind: string; status: string }>(
      `SELECT kind, status FROM outbox WHERE target_session_id = ? ORDER BY created_at, rowid`,
      [sessionId],
    ).map((row) => `${row.kind}:${row.status}`);
    const lane = harness.cp.sessionRuntime.turnInProgress(sessionId) ? "a turn still running or queued" : "no turn running or queued";
    return `${finishedTurns(sessionId)} finished, ${lane}; turns [${audited.join(", ")}]; in-band rows [${inBand.join(", ")}]`;
  };
  /**
   * #1156 — waits until the session's turn `expected` has finished, or until the session has no turn
   * running or queued short of it, and then requires exactly `expected` finished. A woken turn runs
   * behind the reply of the call that woke it (`run_dispatch` admits its RUN_DISPATCH turn when its
   * transaction commits, before it answers), and how long that turn's socket round trips take is the
   * runner's; so nothing here is bounded by a wall clock. A slow turn is waited for, and only the
   * test's own timeout bounds one that never ends; a turn that never ran fails at once, naming what
   * was reached.
   */
  const awaitFinishedTurns = async (sessionId: string, expected: number): Promise<void> => {
    while (finishedTurns(sessionId) < expected && harness.cp.sessionRuntime.turnInProgress(sessionId)) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (finishedTurns(sessionId) !== expected) {
      throw new Error(`expected ${expected} finished turns of ${sessionId}; reached ${turnState(sessionId)}`);
    }
  };
  return {
    harness,
    claude,
    gpt,
    daemon,
    launch,
    ctoSocket,
    ceoSessionId: ceo.sessionId,
    hermes,
    cto,
    createBootstrap,
    dispatchBootstrap,
    loseClaude,
    restoreClaude,
    finishedTurns,
    awaitFinishedTurns,
    close: async () => {
      await listeners.close();
      await launch.close();
    },
  };
};

export type BootstrapRuntimeFixture = Awaited<ReturnType<typeof bootstrapRuntimeFixture>>;

/** What one work turn read in band and settled: the row's kind, generation and the ack's answer. */
export interface HandledInBand {
  kind: string;
  generation: number;
  acked: unknown;
}

/**
 * Makes every work turn behave as the CTO's prompt asks: read what is addressed to it in band
 * (`role_dispatch_pending`) and acknowledge each row — `run_ack` for a row that names a run,
 * `role_dispatch_ack` otherwise — over the connection its relay authenticated for that turn.
 */
export const acknowledgeInBandOnWorkTurns = (f: BootstrapRuntimeFixture): HandledInBand[] => {
  const handled: HandledInBand[] = [];
  let keys = 0;
  f.claude.onWorkTurn = async (_request, credential) => {
    if (!credential) return;
    const as = { sessionId: credential.sessionId, sessionSecret: credential.sessionSecret, token: credential.token ?? "" };
    const pending = await callMcpToolOverSocket(f.ctoSocket, as, "role_dispatch_pending", {});
    const messages = (pending["value"] as { messages?: Array<{ messageId: string; runId: string | null; kind: string }> } | undefined)
      ?.messages ?? [];
    for (const message of messages) {
      const generation = f.harness.cp.outbox.get(message.messageId)?.bindingGeneration ?? -1;
      const acked = message.runId
        ? await callMcpToolOverSocket(f.ctoSocket, as, "run_ack", {
            idempotencyKey: `inband-ack-${++keys}-${message.messageId}`,
            runId: message.runId,
            messageId: message.messageId,
          })
        : await callMcpToolOverSocket(f.ctoSocket, as, "role_dispatch_ack", { messageId: message.messageId });
      handled.push({ kind: message.kind, generation, acked: acked["ok"] });
    }
  };
  return handled;
};

export const withBootstrapRuntime = async (
  body: (f: BootstrapRuntimeFixture) => Promise<void>,
  harnessOptions: Parameters<typeof makeHarness>[0] = {},
): Promise<void> => {
  const f = await bootstrapRuntimeFixture(harnessOptions);
  try {
    await body(f);
  } finally {
    await f.close();
  }
};

/** One MCP connection kept open across requests, as a runtime's relay keeps one for a turn. */
export interface HeldCtoConnection {
  /** Answers the tool's structured content, or `{ closed: true }` once the daemon ended the socket. */
  call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): void;
}

/**
 * Opens a CTO MCP connection with `credential`, completes the MCP initialize, and keeps it open.
 * Refused at the handshake, it answers the daemon's refusal instead of a connection.
 */
export const openHeldCtoConnection = (
  socketPath: string,
  credential: { sessionId: string; sessionSecret: string },
): Promise<HeldCtoConnection | { refused: Record<string, unknown> }> =>
  new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const waiters = new Map<number, (reply: Record<string, unknown>) => void>();
    let buffer = "";
    let nextId = 10;
    let initialized = false;
    let closed = false;
    socket.setEncoding("utf8");
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("the CTO connection did not initialize"));
    }, 15_000);
    const held: HeldCtoConnection = {
      call: (name, args) =>
        new Promise((answer) => {
          if (closed) {
            answer({ closed: true });
            return;
          }
          const id = nextId++;
          waiters.set(id, answer);
          socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })}\n`);
        }),
      close: () => socket.end(),
    };
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let boundary = buffer.indexOf("\n");
      while (boundary !== -1) {
        const line = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 1);
        boundary = buffer.indexOf("\n");
        const message = JSON.parse(line) as Record<string, unknown>;
        if (!initialized && message["ok"] === false && !("jsonrpc" in message)) {
          clearTimeout(timer);
          resolve({ refused: message });
          return;
        }
        if (message["id"] === 1 && !initialized) {
          initialized = true;
          clearTimeout(timer);
          socket.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
          resolve(held);
          continue;
        }
        const waiter = typeof message["id"] === "number" ? waiters.get(message["id"]) : undefined;
        if (!waiter) continue;
        waiters.delete(message["id"] as number);
        const result = message["result"] as { structuredContent?: Record<string, unknown> } | undefined;
        waiter(result?.structuredContent ?? {
          ok: false,
          reasonCode: ReasonCode.INTERNAL_ERROR,
          message: JSON.stringify(message["error"] ?? message["result"] ?? null),
        });
      }
    });
    socket.once("close", () => {
      closed = true;
      for (const waiter of waiters.values()) waiter({ closed: true });
      waiters.clear();
    });
    socket.once("error", () => undefined);
    socket.once("connect", () =>
      socket.write(`${[
        { token: BOOTSTRAP_FIXTURE_TOKEN, sessionId: credential.sessionId, sessionSecret: credential.sessionSecret },
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "acp-c1b-test", version: "1" } },
        },
      ].map((line) => JSON.stringify(line)).join("\n")}\n`));
  });
