import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PassThrough, type Readable, type Writable } from "node:stream";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { ControlPlane } from "../../src/app/control-plane.ts";
import { runAttachRelay, type ReattachPolicy } from "../../src/cli/attach-relay.ts";
import {
  CANONICAL_CTO_CAPACITY_RESTORED,
  CANONICAL_CTO_RESTORE_BACKOFF_MS,
  CANONICAL_CTO_RESTORE_REFUSED,
  CONTINUITY_CAPACITY_AND_RUNTIME_REVOCATION_REASON,
  CONTINUITY_CAPACITY_EXHAUSTED_REVOCATION_REASON,
  CONTINUITY_COVERAGE_REVOCATION_REASON,
  CONTINUITY_RUNTIME_UNAVAILABLE_REVOCATION_REASON,
  CanonicalCtoRestoreCondition,
} from "../../src/continuity/continuity-kernel.ts";
import { RefreshTrigger } from "../../src/capacity/capacity-monitor.ts";
import { ManualClock } from "../../src/core/clock.ts";
import { digestOf, sha256 } from "../../src/core/digest.ts";
import { CANONICAL_CTO_RESTORE_CHALLENGE_PREFIX, startLocalMcpListeners, type LocalMcpListeners } from "../../src/daemon/agentcpd.ts";
import { Daemon } from "../../src/daemon/daemon.ts";
import { Role, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { createCanonicalCtoReattach } from "../../src/registry/canonical-cto-reattach.ts";
import {
  hostSessionRegistryAbsent,
  SELF_CLAIM_EXECUTOR_KIND,
  SELF_CLAIM_PROTOCOL,
  type ProcessAncestryInspector,
  type ProcessSnapshot,
} from "../../src/registry/canonical-self-claim.ts";
import type { CapacityReading } from "../../src/runtime/provider.ts";
import type { ProcessLineageReader } from "../../src/session/runtime-lineage.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { fixtureManifest } from "../helpers/harness.ts";
import { TestProductionAdapter } from "../helpers/production-adapter.ts";

/**
 * #1106 — a canonical PRIMARY_CTO that continuity revoked only for capacity comes back by itself
 * once its window resets: the same session, the next generation, no restart, no new session or
 * process, proven live over the session's own reattach connection.
 *
 * Everything here is the real path: a real `Daemon.reconcileContinuity` revokes and restores, the
 * real daemon listeners and reattach door serve the connection, the real relay carries it, and the
 * client on the relay's stdio is the MCP SDK's own `Client`, which answers the daemon's `ping` the way
 * Claude Code's client does. Only the process tree is stated (the kernel reports this process as the
 * relay; the fixture says it runs under the canonical claude) and the provider's quota is scripted.
 */

const TOKEN = "fixture-mcp-token";
const CLAUDE = 525_252;
const CLAUDE_TOKEN = "darwin-tv:1790000100.000001";
const RESTARTED_TOKEN = "darwin-tv:1790000900.000009";
const CONVERSATION = "33333333-3333-4333-8333-333333333333";
const PROJECT = "capacity-restore";
const CTO = roleKeyFor(Role.PRIMARY_CTO, { projectId: PROJECT });
const POLICY: Partial<ReattachPolicy> = { maxWaitMs: 8_000, initialDelayMs: 20, maxDelayMs: 100, attemptTimeoutMs: 3_000 };
const CHALLENGE_TIMEOUT_MS = 1_500;

interface StatedProcess {
  ppid: number;
  startedAt: string | null;
  argv: readonly string[];
}

const claudeProcess = (startedAt: string): StatedProcess => ({
  ppid: 1,
  startedAt,
  argv: ["/Users/fixture/.local/bin/claude", "--resume", CONVERSATION],
});

const until = async (condition: () => boolean | Promise<boolean>, budgetMs = 10_000): Promise<boolean> => {
  for (const started = Date.now(); Date.now() - started < budgetMs;) {
    if (await condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return condition();
};

/**
 * The MCP SDK client's transport over the relay's stdio. `policy` decides, per message the client
 * sends, whether it leaves now, waits in `held`, or is dropped; every message the client sent is in
 * `sent`, so a test can replay one.
 */
class RelayStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  readonly sent: JSONRPCMessage[] = [];
  readonly held: JSONRPCMessage[] = [];
  policy: (message: JSONRPCMessage) => "send" | "hold" | "drop" = () => "send";
  readonly #buffer = new ReadBuffer();

  constructor(
    private readonly toRelay: Writable,
    private readonly fromRelay: Readable,
  ) {}

  async start(): Promise<void> {
    // A real client is another process across a pipe; deferring each chunk keeps the relay's own
    // turn of the event loop from being answered inside itself.
    this.fromRelay.on("data", (chunk: Buffer) => {
      setImmediate(() => {
        this.#buffer.append(chunk);
        for (let message = this.#buffer.readMessage(); message !== null; message = this.#buffer.readMessage()) {
          this.onmessage?.(message);
        }
      });
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    this.sent.push(message);
    const verdict = this.policy(message);
    if (verdict === "drop") return;
    if (verdict === "hold") {
      this.held.push(message);
      return;
    }
    this.toRelay.write(serializeMessage(message));
  }

  release(): void {
    for (const message of this.held.splice(0)) this.toRelay.write(serializeMessage(message));
  }

  /** Writes a line as if the client had sent it again. */
  inject(message: JSONRPCMessage): void {
    this.toRelay.write(serializeMessage(message));
  }

  async close(): Promise<void> {
    this.toRelay.end();
    this.onclose?.();
  }
}

const isChallengeAnswer = (message: JSONRPCMessage): boolean =>
  !("method" in message) && "id" in message && typeof message.id === "string" &&
  message.id.startsWith(CANONICAL_CTO_RESTORE_CHALLENGE_PREFIX);

const roots: string[] = [];
const planes: ControlPlane[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close().catch(() => undefined);
  for (const cp of planes.splice(0)) cp.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});
afterAll(cleanupTempDirs);

const exhausted = (clock: ManualClock): CapacityReading => ({
  provider: "claude",
  sensorHealth: "HEALTHY",
  runtimeHealth: "HEALTHY",
  observedAt: clock.nowIso(),
  source: "claude-usage",
  buckets: [{ id: "weekly-all-models", remainingPercent: 0, resetAt: null, capabilities: ["cto", "ceo"] }],
});

const healthy = (clock: ManualClock, observedAt = clock.nowIso()): CapacityReading => ({
  provider: "claude",
  sensorHealth: "HEALTHY",
  runtimeHealth: "HEALTHY",
  observedAt,
  source: "claude-usage",
  buckets: [{ id: "weekly-all-models", remainingPercent: 90, resetAt: null, capabilities: ["cto", "ceo"] }],
});

/** A canonical CTO bound the way the canonical claim binds one, its daemon, its relay and its client. */
const started = async () => {
  const root = tempDir("acp-capacity-restore-");
  const clock = new ManualClock("2026-10-10T13:00:00.000Z");
  const claude = new TestProductionAdapter(clock, "claude");
  const cp = new ControlPlane({
    databasePath: join(root, "state.sqlite"),
    worktreeRoot: join(root, "worktrees"),
    capacityDir: join(root, "capacity"),
    secretsDir: join(root, "secrets"),
    clock,
    adapters: [claude],
    capacity: { exhaustedPercent: 2 },
    allowTestEvidenceWriters: true,
  });
  planes.push(cp);
  const manifest = fixtureManifest(PROJECT);
  expect(cp.projects.register({
    projectId: PROJECT,
    name: "fixture",
    manifest,
    authorization: cp.manifestAuthorizationForTests(manifest),
  }).allowed).toBe(true);

  const processes = new Map<number, StatedProcess>([
    [CLAUDE, claudeProcess(CLAUDE_TOKEN)],
    // The kernel reports this process as the reattach door's peer: the in-process relay.
    [process.pid, { ppid: CLAUDE, startedAt: "darwin-tv:1790000500.000005", argv: ["node", "agentctl", "attach"] }],
  ]);
  const inspector: ProcessAncestryInspector = {
    readStartToken: (pid) => processes.get(pid)?.startedAt ?? null,
    snapshot: (pid): ProcessSnapshot | null => {
      const stated = processes.get(pid);
      if (!stated) return null;
      return {
        pid,
        ppid: stated.ppid,
        command: stated.argv.join(" "),
        cwd: "/Users/fixture/work",
        cwdProbeFailure: null,
        startedAt: stated.startedAt,
        argv: stated.argv,
      };
    },
  };
  const lineage: ProcessLineageReader = {
    parentOf: (pid) => processes.get(pid)?.ppid ?? null,
    startToken: (pid) => processes.get(pid)?.startedAt ?? null,
  };
  const registryReader = { read: () => hostSessionRegistryAbsent("absent") };

  const session = cp.sessions.create({ provider: "claude", model: "claude-cli", osPid: CLAUDE, osStartedAt: CLAUDE_TOKEN });
  expect(cp.sessions.transition(session.sessionId, SessionLifecycle.READY).allowed).toBe(true);
  const claimed = { executorKind: SELF_CLAIM_EXECUTOR_KIND, targetLocator: CONVERSATION, targetLocatorDigest: sha256(CONVERSATION) };
  const bound = cp.bindings.bind({
    role: Role.PRIMARY_CTO,
    projectId: PROJECT,
    sessionId: session.sessionId,
    authenticatedTarget: {
      claimed,
      protocolVersion: SELF_CLAIM_PROTOCOL,
      attestationDigest: digestOf({ fixture: "capacity-restore", sessionId: session.sessionId }),
      verify: () => claimed,
    },
  });
  expect(bound.allowed).toBe(true);
  claude.setCapacity(healthy(clock));

  const daemon = new Daemon(cp, { stateDir: join(root, "daemon") });
  const dir = mkdtempSync("/tmp/acpcr-");
  roots.push(dir);
  let listeners: LocalMcpListeners | null = null;
  const open = async (): Promise<void> => {
    listeners = await startLocalMcpListeners(cp, dir, TOKEN);
    await listeners.openCanonicalCtoReattach(
      createCanonicalCtoReattach(cp, { processes: lineage, inspector, registryReader }),
      { lock: { held: () => true } },
      { processes: lineage, inspector, registryReader, challengeTimeoutMs: CHALLENGE_TIMEOUT_MS },
    );
  };
  const stop = async (): Promise<void> => {
    const closing = listeners;
    listeners = null;
    await closing?.close();
  };
  closers.push(stop);
  await open();

  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  stderr.resume();
  let relayEnded = false;
  const exit = runAttachRelay(
    {
      claimSocketPath: join(dir, "no-claim.sock"),
      mcpSocketPath: join(dir, "cto.mcp.sock"),
      reattachSocketPath: join(dir, "agentcpd.canonical-cto-tools.sock"),
      claim: { claimedSessionUuid: CONVERSATION, projectId: PROJECT, expectedBindingGeneration: 2 },
      reattach: POLICY,
      mcpToken: TOKEN,
    },
    { stdin, stdout, stderr },
  ).then((code) => {
    relayEnded = true;
    return code;
  });
  const transport = new RelayStdioTransport(stdin, stdout);
  const client = new Client({ name: "claude-code", version: "2.1.283" });
  await client.connect(transport);
  closers.push(async () => {
    await client.close();
    await exit;
  });

  /** The restore as the restoration pass calls it, with the reattach door's challenger attached. */
  const port = () => ({ restore: (roleKey: string) => cp.continuity.restoreCapacityRevokedCanonicalCto(roleKey) });

  /** One call of a binding-scoped tool: whether the daemon served it under a live binding. */
  const toolServed = async (): Promise<boolean> => {
    try {
      const answer = await client.callTool({ name: "role_dispatch_pending", arguments: {} });
      const body = answer.structuredContent as { ok?: unknown } | undefined;
      return answer.isError !== true && body?.ok !== false;
    } catch {
      return false;
    }
  };

  const revokeForCapacity = async (): Promise<void> => {
    claude.setCapacity(exhausted(clock));
    await daemon.reconcileContinuity("weekly window exhausted");
    expect(cp.bindings.active(CTO)).toBeNull();
    expect(latest().revoked_reason).toBe(CONTINUITY_CAPACITY_EXHAUSTED_REVOCATION_REASON);
  };
  const windowResets = (): void => {
    clock.advance(60 * 60_000);
    claude.setCapacity(null);
  };
  const latest = () => cp.db.get<{ binding_generation: number; status: string; session_id: string; revoked_reason: string | null }>(
    `SELECT binding_generation, status, session_id, revoked_reason FROM assignments WHERE role_key = ?
      ORDER BY binding_generation DESC LIMIT 1`,
    [CTO],
  )!;
  const sessionCount = (): number => cp.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM sessions`)!.n;
  const refusals = () => cp.audit.byKind(CANONICAL_CTO_RESTORE_REFUSED).map((row) => row.evidence.condition);

  expect(await until(toolServed)).toBe(true);
  return {
    cp,
    clock,
    claude,
    daemon,
    sessionId: session.sessionId,
    processes,
    transport,
    client,
    port,
    toolServed,
    revokeForCapacity,
    windowResets,
    latest,
    sessionCount,
    refusals,
    relayEnded: () => relayEnded,
    restart: async () => {
      await stop();
      await open();
    },
  };
};

describe("#1106: a canonical CTO revoked only for capacity returns on its own session", () => {
  it("revoked for capacity, the window resets, and the same session holds the next generation without a restart", async () => {
    const f = await started();
    const sessionsBefore = f.sessionCount();
    await f.revokeForCapacity();
    expect(await f.toolServed()).toBe(false);

    f.windowResets();
    const report = await f.daemon.reconcileContinuity("weekly window reset");

    const active = f.cp.bindings.active(CTO);
    expect(active).toMatchObject({ sessionId: f.sessionId, bindingGeneration: 2 });
    expect(report?.restored).toEqual([CTO]);
    expect(f.cp.audit.byKind(CANONICAL_CTO_CAPACITY_RESTORED)).toHaveLength(1);
    // No session row, no process, no conversation: the same runtime row at the next generation.
    expect(f.sessionCount()).toBe(sessionsBefore);
    expect(f.cp.sessions.require(f.sessionId).lifecycle).toBe(SessionLifecycle.READY);
    // The revoked credential is not revived: rotated once, and nothing holds the new one.
    expect(f.cp.sessions.require(f.sessionId).credentialEpoch).toBe(1);
    // The relay came back through the reattach door under the restored binding and serves again,
    // without having exited.
    expect(await until(f.toolServed)).toBe(true);
    expect(f.relayEnded()).toBe(false);

    // A later daemon restart: the relay comes back under the generation it adopted, not refused.
    await f.restart();
    expect(await until(f.toolServed)).toBe(true);
    expect(f.relayEnded()).toBe(false);
  });

  it("restores the canonical CTO of an idle project, which no open run keeps in the plan", async () => {
    const f = await started();
    expect(f.cp.runs.list({ projectId: PROJECT })).toEqual([]);
    await f.revokeForCapacity();
    f.windowResets();
    const report = await f.daemon.reconcileContinuity("weekly window reset");
    expect(report?.plan.restorationPending).toEqual([CTO]);
    expect(f.cp.bindings.active(CTO)).toMatchObject({ sessionId: f.sessionId, bindingGeneration: 2 });
  });

  it("refuses when another holder took the role first, and never overwrites it", async () => {
    const f = await started();
    await f.revokeForCapacity();
    f.windowResets();
    const other = f.cp.sessions.create({ provider: "claude", model: "opus" });
    expect(f.cp.sessions.transition(other.sessionId, SessionLifecycle.READY).allowed).toBe(true);
    expect(f.cp.bindings.bind({ role: Role.PRIMARY_CTO, projectId: PROJECT, sessionId: other.sessionId }).allowed).toBe(true);

    const refused = await f.port().restore(CTO);
    expect(refused?.allowed).toBe(false);
    expect(refused?.evidence).toMatchObject({ condition: CanonicalCtoRestoreCondition.ANOTHER_HOLDER_ACTIVE });
    await f.daemon.reconcileContinuity("after another holder");
    expect(f.cp.bindings.active(CTO)).toMatchObject({ sessionId: other.sessionId, bindingGeneration: 2 });
    expect(f.cp.audit.byKind(CANONICAL_CTO_CAPACITY_RESTORED)).toHaveLength(0);
  });

  it.each(["owner suspend", "replacement"] as const)(
    "refuses when an %s happens while the challenge is being answered",
    async (event) => {
      const f = await started();
      await f.revokeForCapacity();
      f.windowResets();
      f.transport.policy = (message) => (isChallengeAnswer(message) ? "hold" : "send");
      const restoring = f.port().restore(CTO);
      expect(await until(() => f.transport.held.length === 1)).toBe(true);
      let holder: string | null = null;
      if (event === "owner suspend") {
        expect(f.cp.projects.setSuspended(PROJECT, true, true).allowed).toBe(true);
      } else {
        const other = f.cp.sessions.create({ provider: "claude", model: "opus" });
        expect(f.cp.sessions.transition(other.sessionId, SessionLifecycle.READY).allowed).toBe(true);
        expect(f.cp.bindings.bind({ role: Role.PRIMARY_CTO, projectId: PROJECT, sessionId: other.sessionId }).allowed).toBe(true);
        holder = other.sessionId;
      }
      f.transport.release();
      const refused = await restoring;
      expect(refused?.allowed).toBe(false);
      expect(refused?.evidence).toMatchObject({
        condition: event === "owner suspend"
          ? CanonicalCtoRestoreCondition.OWNER_SUSPENDED
          : CanonicalCtoRestoreCondition.ANOTHER_HOLDER_ACTIVE,
      });
      expect(f.cp.audit.byKind(CANONICAL_CTO_CAPACITY_RESTORED)).toHaveLength(0);
      if (holder === null) {
        expect(f.cp.bindings.active(CTO)).toBeNull();
      } else {
        expect(f.cp.bindings.active(CTO)?.sessionId).toBe(holder);
      }
      expect(f.cp.sessions.require(f.sessionId).credentialEpoch).toBe(0);
    },
  );

  it("does not restore on a replayed answer to an earlier challenge", async () => {
    const f = await started();
    await f.revokeForCapacity();
    f.windowResets();
    // The first challenge is answered, and the attempt is refused after it: the claude behind the
    // relay restarted while the answer was in flight.
    f.transport.policy = (message) => (isChallengeAnswer(message) ? "hold" : "send");
    const first = f.port().restore(CTO);
    expect(await until(() => f.transport.held.length === 1)).toBe(true);
    const answer = f.transport.held[0]!;
    f.processes.set(CLAUDE, claudeProcess(RESTARTED_TOKEN));
    f.transport.release();
    expect((await first)?.evidence).toMatchObject({ condition: CanonicalCtoRestoreCondition.ATTACH_TARGET_NOT_LIVE });

    // The claude is back as it was; the next attempt's challenge is never answered by the client,
    // and the earlier answer is replayed instead — consumed once, and naming another challenge.
    f.processes.set(CLAUDE, claudeProcess(CLAUDE_TOKEN));
    f.clock.advance(CANONICAL_CTO_RESTORE_BACKOFF_MS);
    f.claude.setCapacity(null);
    f.transport.policy = (message) => (isChallengeAnswer(message) ? "drop" : "send");
    const second = f.port().restore(CTO);
    // Only once the second challenge is open, so the replay meets a challenge it could be taken for.
    expect(await until(() => f.transport.sent.filter(isChallengeAnswer).length === 2)).toBe(true);
    f.transport.inject(answer);
    const refused = await second;
    expect(refused?.allowed).toBe(false);
    expect(refused?.evidence).toMatchObject({ condition: CanonicalCtoRestoreCondition.LIVENESS_CHALLENGE_FAILED });
    expect(f.cp.bindings.active(CTO)).toBeNull();
    expect(f.cp.audit.byKind(CANONICAL_CTO_CAPACITY_RESTORED)).toHaveLength(0);
  });

  it("restores exactly once when two restores run at the same time", async () => {
    const f = await started();
    const sessionsBefore = f.sessionCount();
    await f.revokeForCapacity();
    f.windowResets();
    const port = f.port();
    const [first, second] = await Promise.all([port.restore(CTO), port.restore(CTO), f.cp.continuity.restore()]);
    expect([first, second].filter((outcome) => outcome?.allowed === true)).toHaveLength(1);
    expect(f.cp.audit.byKind(CANONICAL_CTO_CAPACITY_RESTORED)).toHaveLength(1);
    expect(f.cp.db.all(`SELECT binding_generation FROM assignments WHERE role_key = ? ORDER BY binding_generation`, [CTO]))
      .toEqual([{ binding_generation: 1 }, { binding_generation: 2 }]);
    expect(f.cp.bindings.active(CTO)).toMatchObject({ sessionId: f.sessionId, bindingGeneration: 2 });
    expect(f.sessionCount()).toBe(sessionsBefore);
    expect(f.cp.sessions.require(f.sessionId).credentialEpoch).toBe(1);
  });

  it("refuses an old measurement and an UNKNOWN one", async () => {
    const f = await started();
    await f.revokeForCapacity();
    const revokedAt = Date.parse(f.clock.nowIso());
    f.clock.advance(60_000);
    // HEALTHY and past the window, but measured before the revocation.
    f.claude.setCapacity(healthy(f.clock, new Date(revokedAt - 1_000).toISOString()));
    const old = await f.port().restore(CTO);
    expect(old?.evidence).toMatchObject({ condition: CanonicalCtoRestoreCondition.CAPACITY_NOT_FRESH });

    f.clock.advance(CANONICAL_CTO_RESTORE_BACKOFF_MS);
    f.claude.setCapacity({ ...healthy(f.clock), runtimeHealth: "UNKNOWN" });
    const unknown = await f.port().restore(CTO);
    expect(unknown?.evidence).toMatchObject({ condition: CanonicalCtoRestoreCondition.CAPACITY_NOT_FRESH });

    expect(f.cp.bindings.active(CTO)).toBeNull();
    expect(f.refusals()).toEqual([CanonicalCtoRestoreCondition.CAPACITY_NOT_FRESH, CanonicalCtoRestoreCondition.CAPACITY_NOT_FRESH]);
  });

  it("refuses while the window has not reset", async () => {
    const f = await started();
    await f.revokeForCapacity();
    f.clock.advance(60_000);
    // A new HEALTHY measurement, still exhausted.
    f.claude.setCapacity(exhausted(f.clock));
    const refused = await f.port().restore(CTO);
    expect(refused?.evidence).toMatchObject({ condition: CanonicalCtoRestoreCondition.CAPACITY_WINDOW_NOT_RESET });
    expect(f.cp.bindings.active(CTO)).toBeNull();
  });

  // Keyed by name and resolved inside the case, so the file still loads at a base without the split.
  const nonCapacityRevocations: Record<string, () => [reason: string, condition: string]> = {
    "a lost runtime": () => [CONTINUITY_RUNTIME_UNAVAILABLE_REVOCATION_REASON, CanonicalCtoRestoreCondition.REVOKE_NOT_CAPACITY_ONLY],
    "capacity and a lost runtime at once": () =>
      [CONTINUITY_CAPACITY_AND_RUNTIME_REVOCATION_REASON, CanonicalCtoRestoreCondition.REVOKE_NOT_CAPACITY_ONLY],
    "the reason written before the split": () =>
      [CONTINUITY_COVERAGE_REVOCATION_REASON, CanonicalCtoRestoreCondition.REVOKE_REASON_UNDISTINGUISHED],
  };
  it.each(Object.keys(nonCapacityRevocations))(
    "refuses a revocation for %s, and the doctor names the role and why", async (label) => {
    const [reason, condition] = nonCapacityRevocations[label]!();
    const f = await started();
    expect(f.cp.bindings.revoke(CTO, reason).allowed).toBe(true);
    f.windowResets();
    const refused = await f.port().restore(CTO);
    expect(refused?.evidence).toMatchObject({ condition });
    await f.daemon.reconcileContinuity("coverage is back");
    expect(f.cp.bindings.active(CTO)).toBeNull();
    expect(f.cp.audit.byKind(CANONICAL_CTO_CAPACITY_RESTORED)).toHaveLength(0);
    const finding = (await f.cp.doctor.run("system")).findings.find((candidate) => candidate.code === "CANONICAL_CTO_RESTORE_UNMET");
    expect(finding).toMatchObject({ blocking: false, observedEvidence: { roleKey: CTO, condition } });
    expect(finding?.recommendedAction).toContain(CTO);
  });

  it("an operator release is not restored, and is not named as a restore that failed", async () => {
    const f = await started();
    expect(f.cp.bindings.revoke(CTO, "operator released the role").allowed).toBe(true);
    f.windowResets();
    expect(await f.port().restore(CTO)).toBeNull();
    const findings = (await f.cp.doctor.run("system")).findings.map((finding) => finding.code);
    expect(findings).not.toContain("CANONICAL_CTO_RESTORE_UNMET");
  });

  it("refuses when the relay is alive but the claude behind it ended while the challenge was answered", async () => {
    const f = await started();
    await f.revokeForCapacity();
    f.windowResets();
    f.transport.policy = (message) => (isChallengeAnswer(message) ? "hold" : "send");
    const restoring = f.port().restore(CTO);
    expect(await until(() => f.transport.held.length === 1)).toBe(true);
    // The relay and its client are still here and still answer; the claude they ran under is gone.
    f.processes.delete(CLAUDE);
    f.transport.release();
    const refused = await restoring;
    expect(refused?.evidence).toMatchObject({ condition: CanonicalCtoRestoreCondition.ATTACH_TARGET_NOT_LIVE });
    expect(f.cp.bindings.active(CTO)).toBeNull();
    expect(f.cp.sessions.require(f.sessionId).credentialEpoch).toBe(0);
  });

  it("refuses when the window closes again while the challenge is answered", async () => {
    const f = await started();
    await f.revokeForCapacity();
    f.windowResets();
    f.transport.policy = (message) => (isChallengeAnswer(message) ? "hold" : "send");
    const restoring = f.port().restore(CTO);
    expect(await until(() => f.transport.held.length === 1)).toBe(true);
    // A newer measurement lands between the restore's own and its bind: exhausted again.
    f.clock.advance(1_000);
    f.claude.setCapacity(exhausted(f.clock));
    await f.cp.capacity.refresh(RefreshTrigger.CONTINUITY_EVALUATION, ["claude"]);
    f.transport.release();
    const refused = await restoring;
    expect(refused?.evidence).toMatchObject({ condition: CanonicalCtoRestoreCondition.CAPACITY_WINDOW_NOT_RESET });
    expect(f.cp.bindings.active(CTO)).toBeNull();
  });

  it("re-proves the attach target inside the bind, and refuses when the claude ends as the bind opens", async () => {
    const f = await started();
    await f.revokeForCapacity();
    f.windowResets();
    const txDecision = f.cp.db.txDecision.bind(f.cp.db);
    let ended = false;
    vi.spyOn(f.cp.db, "txDecision").mockImplementation((body) => {
      if (!ended && f.transport.sent.some(isChallengeAnswer)) {
        // The first transaction after the challenge was answered is the restore's own bind: the
        // claude goes away as it opens, after every check made outside it passed.
        ended = true;
        f.processes.delete(CLAUDE);
      }
      return txDecision(body);
    });
    const refused = await f.port().restore(CTO);
    expect(ended).toBe(true);
    expect(refused?.evidence).toMatchObject({ condition: CanonicalCtoRestoreCondition.ATTACH_TARGET_NOT_LIVE });
    expect(f.cp.bindings.active(CTO)).toBeNull();
    expect(f.cp.sessions.require(f.sessionId).credentialEpoch).toBe(0);
  });

  it("refuses a challenge nobody answers, and the doctor names the role and the unmet condition", async () => {
    const f = await started();
    await f.revokeForCapacity();
    f.windowResets();
    f.transport.policy = (message) => (isChallengeAnswer(message) ? "drop" : "send");
    await f.daemon.reconcileContinuity("weekly window reset");
    expect(f.cp.bindings.active(CTO)).toBeNull();
    expect(f.refusals()).toEqual([CanonicalCtoRestoreCondition.LIVENESS_CHALLENGE_FAILED]);
    const finding = (await f.cp.doctor.run("system")).findings.find((candidate) => candidate.code === "CANONICAL_CTO_RESTORE_UNMET");
    expect(finding).toMatchObject({
      blocking: false,
      observedEvidence: { roleKey: CTO, condition: CanonicalCtoRestoreCondition.LIVENESS_CHALLENGE_FAILED },
    });

    // Once its backoff is over, the next pass tries again, and an answered challenge restores it.
    f.transport.policy = () => "send";
    f.clock.advance(CANONICAL_CTO_RESTORE_BACKOFF_MS);
    f.claude.setCapacity(null);
    await f.daemon.reconcileContinuity("after the backoff");
    expect(f.cp.bindings.active(CTO)).toMatchObject({ sessionId: f.sessionId, bindingGeneration: 2 });
  });

  it("refuses when the challenged connection ends before its answer, and no reconnect can carry it", async () => {
    const f = await started();
    await f.revokeForCapacity();
    f.windowResets();
    f.transport.policy = (message) => (isChallengeAnswer(message) ? "hold" : "send");
    const restoring = f.port().restore(CTO);
    expect(await until(() => f.transport.held.length === 1)).toBe(true);
    // The client goes away with its answer unsent; the relay's connection ends with it, and a revoked
    // binding admits no reconnect that could deliver the answer later.
    await f.client.close();
    const refused = await restoring;
    expect(refused?.evidence).toMatchObject({ condition: CanonicalCtoRestoreCondition.LIVENESS_CHALLENGE_FAILED });
    expect(f.cp.bindings.active(CTO)).toBeNull();
    expect(await until(f.relayEnded)).toBe(true);
  });

  it("after a daemon restart since the revocation there is no connection to prove, and no probe is spent on it", async () => {
    const f = await started();
    await f.revokeForCapacity();
    // The restart ends the relay's connection; its reattach is refused for a revoked binding, and
    // the relay ends with it.
    await f.restart();
    expect(await until(f.relayEnded)).toBe(true);
    f.windowResets();
    const probe = vi.spyOn(f.claude, "probeCapacity");
    const refused = await f.port().restore(CTO);
    expect(refused?.evidence).toMatchObject({ condition: CanonicalCtoRestoreCondition.NO_REATTACH_CONNECTION });
    expect(probe).not.toHaveBeenCalled();
    expect(f.cp.bindings.active(CTO)).toBeNull();
    const finding = (await f.cp.doctor.run("system")).findings.find((candidate) => candidate.code === "CANONICAL_CTO_RESTORE_UNMET");
    expect(finding).toMatchObject({ observedEvidence: { roleKey: CTO, condition: CanonicalCtoRestoreCondition.NO_REATTACH_CONNECTION } });
  });

  it("the doctor names a capacity-revoked canonical CTO that waits for its window", async () => {
    const f = await started();
    await f.revokeForCapacity();
    const finding = (await f.cp.doctor.run("system")).findings.find((candidate) => candidate.code === "CANONICAL_CTO_RESTORE_PENDING");
    expect(finding).toMatchObject({ blocking: false, observedEvidence: { roleKey: CTO, condition: "AWAITING_RESTORE" } });
  });
});
