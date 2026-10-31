import { chmodSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { ManualClock } from "../../src/core/clock.ts";
import { readProcessStartToken } from "../../src/core/process-argv.ts";
import type { SessionLaunchCredential } from "../../src/cto/cto-lifecycle.ts";
import { startLocalMcpListeners, startSessionLaunchChannel, wakeRoleHolder } from "../../src/daemon/agentcpd.ts";
import { Daemon } from "../../src/daemon/daemon.ts";
import { ExecutionMode, Role, RunKind, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import type { TaskContract } from "../../src/run/run-engine.ts";
import { ClaudeCliAdapter } from "../../src/runtime/cli-adapters.ts";
import type { SessionTurnRequest, SessionTurnResult } from "../../src/runtime/provider.ts";
import {
  DRIVEN_PRIMARY_CTO_SPAWN_RECORD,
  type SessionCredentialDelivery,
  drivenModeOf,
} from "../../src/runtime/provisioned-session-runtime.ts";
import { RecordingRuntimeDouble, withBootstrapRuntime } from "../helpers/bootstrap-cto-fixture.ts";
import { drivenPrimary } from "../helpers/driven-primary-cto.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { type Harness, makeHarness, registerFixtureProject } from "../helpers/harness.ts";
import { callMcpToolOverSocket } from "../helpers/mcp-socket.ts";
import { requireSeatbelt } from "../helpers/seatbelt.ts";

/**
 * Packet O4 slice A — a PRIMARY_CTO started by `cto_start` survives a daemon restart, and a legacy
 * pinless one is reported and never re-credentialed.
 *
 * - W1: `cto_start` (over the real `hermes.mcp.sock`) spawns the PRIMARY_CTO driven, its spawn record
 *   written with its session row under no run. A new control plane over the same database, with a fresh
 *   runtime that holds nothing, recovers it on its own session at credential epoch 1: its own next turn
 *   takes that credential from the take-once launch channel and authenticates on `cto.mcp.sock` with it,
 *   its session, assignment and generation are unchanged, and the CEO's `run_get` answers. No run, task,
 *   execution, claim or outbox row changes across the recovery.
 * - Pin: each relayed turn's pending launch entry names the process the daemon itself spawned for
 *   `claude -p` — its pid, and the start token the daemon read from it — in the same tick as the spawn,
 *   before the CLI can start its MCP child. Driven through the real Claude adapter and a stand-in CLI that
 *   reports its parent: the process the daemon spawned.
 * - W4: after a restart, a legacy pinless ACTIVE PRIMARY_CTO (no driven record, no pid, no pin) gets a
 *   blocking doctor finding that names the official cleanup, and no credential is issued to it: the
 *   restart and the continuity pass rotate nothing, pin nothing and replace nothing.
 *
 * HOME points at a private directory before anything is imported, so every CLI scratch directory and
 * profile follows it and the live daemon's state is never touched.
 */
const isolatedHome = vi.hoisted(() => {
  const home = `${(process.env["TMPDIR"] ?? "/tmp").replace(/\/+$/, "")}/acp-o4a-home-${process.pid}`;
  process.env["HOME"] = home;
  return home;
});

afterEach(() => vi.restoreAllMocks());
afterAll(() => {
  cleanupTempDirs();
  rmSync(isolatedHome, { recursive: true, force: true });
});

const TOKEN = "o4a-mcp-token";

const CONTRACT: TaskContract = {
  goal: "keep working across a daemon restart",
  why: "the owner started this project's CTO with cto_start",
  scope: [],
  nonGoals: [],
  acceptance: ["the CTO reads its run after the restart"],
  priority: "NORMAL",
  humanGate: [],
  references: [],
};

/** One daemon process over `harness`: its own launch channel, MCP sockets and runtime attachment. */
interface DaemonProcess {
  harness: Harness;
  hermesSocket: string;
  ctoSocket: string;
  conversation: Parameters<typeof wakeRoleHolder>[1];
  daemon: Daemon;
  /** Every credential the runtime offered on the launch channel: the very objects its pending entries hold. */
  offered: SessionLaunchCredential[];
  close(): Promise<void>;
}

const startDaemonProcess = async (harness: Harness, claude: RecordingRuntimeDouble): Promise<DaemonProcess> => {
  harness.cp.providers.registerForRole(claude, Role.PRIMARY_CTO);
  const launch = await startSessionLaunchChannel(tempDir("acp-o4a-launch-"), { mcpToken: TOKEN });
  const offered: SessionLaunchCredential[] = [];
  const delivery: SessionCredentialDelivery = {
    prepare: () => launch.prepare(),
    provision: (credential) => {
      offered.push(credential);
      return launch.provision(credential);
    },
    withdraw: (externalSessionId) => launch.withdraw(externalSessionId),
  };
  const listeners = await startLocalMcpListeners(harness.cp, tempDir("acp-o4a-mcp-"), TOKEN);
  const [hermesSocket, ctoSocket] = listeners.socketPaths;
  if (!hermesSocket || !ctoSocket) throw new Error("the MCP listeners were not started");
  harness.cp.sessionRuntime.attach({ delivery, route: { launchSocketPath: launch.socketPath, mcpSocketPath: ctoSocket } });
  harness.cp.outbox.attachInBandWake((roleKey, ids) =>
    wakeRoleHolder(harness.cp, listeners.ctoConversation, roleKey, { kind: "in-band dispatch", ids: ids ?? [] }));
  let closed = false;
  return {
    harness,
    hermesSocket,
    ctoSocket,
    conversation: listeners.ctoConversation,
    daemon: new Daemon(harness.cp, { stateDir: tempDir("acp-o4a-daemon-") }),
    offered,
    close: async () => {
      if (closed) return;
      closed = true;
      await listeners.close();
      await launch.close();
      harness.cp.close();
    },
  };
};

/** The CEO, bound, as the socket credential its `hermes.mcp.sock` calls carry. */
const bindCeo = (harness: Harness) => {
  const ceo = harness.cp.sessions.create({ provider: "scripted", model: "o4a-ceo" });
  harness.cp.sessions.transition(ceo.sessionId, SessionLifecycle.READY, "fixture CEO");
  const bound = harness.cp.bindings.bind({ role: Role.CEO, sessionId: ceo.sessionId });
  if (!bound.allowed || !ceo.sessionSecret) throw new Error("the fixture CEO could not be bound");
  return { token: TOKEN, sessionId: ceo.sessionId, sessionSecret: ceo.sessionSecret };
};

const finishedTurns = (harness: Harness, sessionId: string): number =>
  harness.cp.db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'SESSION_TURN' AND session_id = ?`,
    [sessionId],
  )?.n ?? 0;

/** The rows a recovery must leave exactly as they were. */
const workRows = (harness: Harness) =>
  Object.fromEntries(["runs", "tasks", "task_executions", "resource_claims", "outbox"].map((table) =>
    [table, harness.cp.db.all(`SELECT * FROM ${table} ORDER BY rowid`)]));

describe("O4 W1 — a cto_start PRIMARY_CTO survives a daemon restart", () => {
  it("is spawned driven, and a fresh runtime over the same database recovers it on its own session at epoch 1", async () => {
    const clock = new ManualClock("2026-10-31T00:00:00.000Z");
    const first = makeHarness({ clock });
    // The provider's conversations live outside the daemon, and outlive it.
    const claude = new RecordingRuntimeDouble(clock, "claude");
    const before = await startDaemonProcess(first, claude);
    let after: DaemonProcess | null = null;
    try {
      const { projectId } = await registerFixtureProject(first, "o4a-restart");
      const ceo = bindCeo(first);
      const started = await callMcpToolOverSocket(before.hermesSocket, ceo, "cto_start", { idempotencyKey: "o4a-cto-start", projectId });
      expect(started).toMatchObject({ ok: true });
      const roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId });
      const binding = first.cp.bindings.active(roleKey)!;
      // Driven: the one spawn record, written with the session row, naming no run.
      expect(drivenModeOf(first.cp.db, binding.sessionId)).toBe("DRIVEN");
      expect(first.cp.db.all<{ run_id: string | null }>(
        `SELECT run_id FROM audit_events WHERE kind = ? AND session_id = ?`,
        [DRIVEN_PRIMARY_CTO_SPAWN_RECORD, binding.sessionId],
      )).toEqual([{ run_id: null }]);
      const session = first.cp.sessions.require(binding.sessionId);
      expect(session).toMatchObject({ provider: "claude", lifecycle: SessionLifecycle.READY, credentialEpoch: 0 });
      expect(first.cp.sessionRuntime.holds(binding.sessionId)).toBe(true);
      const run = first.cp.runs.create({ projectId, kind: RunKind.STANDARD_WORK, executionMode: ExecutionMode.STANDARD, contract: CONTRACT });
      if (!run.allowed) throw new Error(run.message);

      // The daemon goes down: what it held in memory for the session goes with it.
      await before.close();
      const second = makeHarness({ root: first.root, repoPath: first.repoPath, clock });
      after = await startDaemonProcess(second, claude);
      const cp = second.cp;
      expect(cp.sessionRuntime.holds(binding.sessionId)).toBe(false);
      const rowsBefore = workRows(second);
      const sessionsBefore = cp.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sessions`)!.n;

      const report = await after.daemon.reconcileContinuity("the daemon restarted");
      expect(report?.unresolved ?? []).not.toContainEqual(expect.objectContaining({ roleKey }));
      expect(workRows(second)).toEqual(rowsBefore);
      expect(cp.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sessions`)!.n).toBe(sessionsBefore);
      expect(cp.sessions.require(binding.sessionId)).toMatchObject({
        incarnation: session.incarnation,
        lifecycle: SessionLifecycle.READY,
        credentialEpoch: 1,
      });
      expect(cp.bindings.active(roleKey)).toMatchObject({
        assignmentId: binding.assignmentId,
        sessionId: binding.sessionId,
        sessionIncarnation: binding.sessionIncarnation,
        bindingGeneration: binding.bindingGeneration,
      });
      expect(cp.sessionRuntime.holds(binding.sessionId)).toBe(true);

      // Its own next turn takes epoch 1's credential from the launch channel and authenticates with it.
      const turns: Array<{ external: string; sessionId: string; pending: Record<string, unknown> }> = [];
      claude.onWorkTurn = async (request, credential) => {
        if (!credential) return;
        const pending = await callMcpToolOverSocket(
          after!.ctoSocket,
          { token: credential.token ?? "", sessionId: credential.sessionId, sessionSecret: credential.sessionSecret },
          "role_dispatch_pending",
          {},
        );
        turns.push({ external: request.handle.externalSessionId, sessionId: credential.sessionId, pending });
      };
      const woke = await wakeRoleHolder(cp, after.conversation, roleKey, { kind: "owner message", ids: [] });
      expect(woke.allowed).toBe(true);
      await vi.waitFor(() => expect(finishedTurns(second, binding.sessionId)).toBe(1), { timeout: 10_000 });
      expect(turns).toEqual([{ external: session.incarnation.split("#")[0], sessionId: binding.sessionId, pending: expect.objectContaining({ ok: true }) }]);
      expect(after.offered.map((credential) => credential.sessionId)).toEqual([binding.sessionId]);
      expect(cp.sessions.require(binding.sessionId).credentialEpoch).toBe(1);

      // And the run it owns a project for is read as before.
      const read = await callMcpToolOverSocket(after.hermesSocket, ceo, "run_get", { runId: run.value.runId });
      expect(read).toMatchObject({ ok: true });
    } finally {
      await after?.close();
      await before.close();
    }
  });
});

/**
 * A `claude` stand-in in the session's own workdir: it answers as the conversation its argv names and
 * reports its parent's pid, which is the process the daemon spawned for the turn (the group holder that
 * runs the CLI as its child).
 */
const standInClaude = (workdir: string): string => {
  const binary = join(workdir, "claude-stand-in.cjs");
  writeFileSync(binary, `#!${process.execPath}
const args = process.argv.slice(2);
const at = Math.max(args.indexOf("--resume"), args.indexOf("--session-id"));
process.stdout.write(JSON.stringify({ type: "result", is_error: false, session_id: args[at + 1], result: String(process.ppid) }), () => process.exit(0));
`);
  chmodSync(binary, 0o700);
  return binary;
};

describe("O4 pin — a relayed turn is pinned to the daemon's own spawn of claude -p", () => {
  it("records the spawned pid and the start token the daemon read in the pending launch entry, in the spawn's own tick", async (ctx) => {
    requireSeatbelt(ctx);
    await withBootstrapRuntime(async (f) => {
      const cp = f.harness.cp;
      const { binding } = await drivenPrimary(f, "o4a-pin");
      const offered: SessionLaunchCredential[] = [];
      const provision = f.launch.provision.bind(f.launch);
      f.launch.provision = (credential) => {
        offered.push(credential);
        return provision(credential);
      };
      const workdir = cp.sessions.require(binding.sessionId).workdir!;
      mkdirSync(workdir, { recursive: true });
      const real = new ClaudeCliAdapter({
        clock: f.harness.clock,
        capacityFile: join(tempDir("acp-o4a-cap-"), "claude.json"),
        binary: standInClaude(realpathSync(workdir)),
      });
      // At the spawn: the pid the adapter reported, what the pending launch entry named in that same tick,
      // and the process's own start token as the kernel reports it.
      const atSpawn: Array<{ pid: number; pin: unknown; token: string | null }> = [];
      const results: SessionTurnResult[] = [];
      f.claude.runSessionTurn = async (request: SessionTurnRequest): Promise<SessionTurnResult> => {
        const pinTurn = (request as { onSpawn?: (pid: number, startedAt: string | null) => void }).onSpawn;
        const result = await real.runSessionTurn({
          ...request,
          onSpawn: (pid: number) => {
            // Whatever an adapter reports beside the pid is not what is pinned: the daemon reads the token.
            pinTurn?.(pid, "a start token the daemon does not take from anyone");
            atSpawn.push({ pid, pin: offered.at(-1)?.pin ?? null, token: readProcessStartToken(pid) });
          },
        } as SessionTurnRequest);
        results.push(result);
        return result;
      };

      expect(cp.sessionRuntime.wake(binding.roleKey, [{ id: "o4a-pinned-turn", kind: "test" }])).toMatchObject({ allowed: true });
      await vi.waitFor(() => expect(results).toHaveLength(1), { timeout: 30_000 });
      expect(results[0]).toMatchObject({ ok: true });
      expect(offered.map((credential) => credential.sessionId)).toEqual([binding.sessionId]);
      expect(atSpawn).toHaveLength(1);
      const [spawned] = atSpawn;
      expect(spawned!.token).not.toBeNull();
      expect(spawned!.pin).toEqual({ pid: spawned!.pid, startToken: spawned!.token });
      // The pid pinned is the parent of the CLI that answered: the daemon's own spawn, not a reported one.
      expect(Number(results[0]!.text)).toBe(spawned!.pid);
      expect(offered[0]!.pin).toEqual({ pid: spawned!.pid, startToken: spawned!.token });
    });
  });
});

describe("O4 W4 — a legacy pinless PRIMARY_CTO is reported after a restart, never re-credentialed", () => {
  it("gets a blocking doctor finding naming the cleanup, and no credential from the restart or continuity", async () => {
    const clock = new ManualClock("2026-10-31T00:00:00.000Z");
    const first = makeHarness({ clock });
    const projectId = "o4a-legacy";
    await registerFixtureProject(first, projectId);
    const roleKey = roleKeyFor(Role.PRIMARY_CTO, { projectId });
    // What an earlier build's cto_start left: interactive and READY, bound, with no driven-spawn record,
    // no recorded process and no native start pin. Its credential lived only in that daemon's memory.
    const legacy = first.cp.sessions.create({ provider: "scripted", model: "scripted-cto" });
    first.cp.sessions.transition(legacy.sessionId, SessionLifecycle.READY, "an earlier build's cto_start");
    const bound = first.cp.bindings.bind({ roleKey, role: Role.PRIMARY_CTO, sessionId: legacy.sessionId, projectId, mode: "PREFERRED" });
    if (!bound.allowed) throw new Error(bound.message);
    // Before any restart nothing says its credential is gone.
    expect((await first.cp.doctor.run("cto", projectId)).findings.map((finding) => finding.code))
      .not.toContain("PRIMARY_CTO_CREDENTIAL_UNRECOVERABLE");
    first.cp.close();

    clock.advance(60_000);
    const second = makeHarness({ root: first.root, repoPath: first.repoPath, clock });
    const cp = second.cp;
    const rotated = () => cp.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'SESSION_CREDENTIAL_ROTATED' AND session_id = ?`,
      [legacy.sessionId],
    )!.n;
    const sessionsBefore = cp.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sessions`)!.n;
    cp.credentials.install({ token: "test-token", creatorIdentity: "acme-bot" });
    const daemon = new Daemon(cp, { stateDir: tempDir("acp-o4a-legacy-daemon-"), watchdogIntervalMs: 600_000 });
    const started = await daemon.start();
    try {
      if (!started.allowed) throw new Error(`${started.reasonCode}: ${started.message} ${JSON.stringify(started.evidence)}`);
      await daemon.reconcileContinuity("the daemon restarted");

      // The project's report blocks on it and names the official cleanup.
      const report = await cp.doctor.run("cto", projectId);
      const finding = report.findings.find((candidate) => candidate.code === "PRIMARY_CTO_CREDENTIAL_UNRECOVERABLE");
      expect(finding).toMatchObject({
        blocking: true,
        scope: `project:${projectId}`,
        observedEvidence: expect.objectContaining({ sessionId: legacy.sessionId, roleKey }),
      });
      for (const step of ["cto_suspend", "cto_resume", "cto_start", "agentctl project retire"]) {
        expect(finding!.recommendedAction).toContain(step);
      }
      expect(report.status).toBe("BLOCKED");
      // The system report, the daemon's own gate, names it without parking the daemon.
      expect((await cp.doctor.run("system")).findings).toContainEqual(expect.objectContaining({
        code: "PRIMARY_CTO_CREDENTIAL_UNRECOVERABLE",
        blocking: false,
      }));

      // No credential was issued to it by the restart or the continuity pass, nothing replaced it, and it
      // is as it was.
      expect(rotated()).toBe(0);
      expect(cp.sessionRuntime.holds(legacy.sessionId)).toBe(false);
      expect(cp.sessions.require(legacy.sessionId)).toMatchObject({ lifecycle: SessionLifecycle.READY, credentialEpoch: 0, osPid: null });
      expect(cp.sessions.pinnedNativeStart(legacy.sessionId)).toBeNull();
      expect(cp.bindings.active(roleKey)).toMatchObject({ assignmentId: bound.value.assignmentId, sessionId: legacy.sessionId });
      expect(cp.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sessions`)!.n).toBe(sessionsBefore);
    } finally {
      await daemon.stop();
      cp.close();
    }
  });
});
