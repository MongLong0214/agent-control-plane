import { join } from "node:path";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { ControlPlane } from "../../src/app/control-plane.ts";
import {
  CONTINUITY_RUNTIME_LOST_REVOCATION_REASON,
  CanonicalCtoRestoreCondition,
  readCanonicalCtoRestoreTarget,
} from "../../src/continuity/continuity-kernel.ts";
import { ManualClock } from "../../src/core/clock.ts";
import { digestOf, sha256 } from "../../src/core/digest.ts";
import { type Decision, allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Daemon } from "../../src/daemon/daemon.ts";
import { Role, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import {
  CanonicalSelfClaim,
  SELF_CLAIM_EXECUTOR_KIND,
  SELF_CLAIM_PROTOCOL,
  hostSessionRegistryAbsent,
  type ProcessSnapshot,
} from "../../src/registry/canonical-self-claim.ts";
import type { CapacityReading } from "../../src/runtime/provider.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { fixtureManifest } from "../helpers/harness.ts";
import { TestProductionAdapter } from "../helpers/production-adapter.ts";

/**
 * A PRIMARY_CTO whose claude process died, on a deployment where Claude is registered role-scoped only
 * (as the composition root registers it), with every capacity reading HEALTHY: the live CommitLore CTO
 * revocation of 2026-11-07. Two defects met there. The failover's admission named no role, so a
 * role-scoped provider refused it CAPACITY_UNKNOWN_NOT_ROUTABLE, and that refusal became the revocation
 * reason, read afterwards as a capacity problem. Naming the role makes the admission pass, and then a
 * canonical CTO would be failed over onto a fresh headless session its own restart cannot prove gone.
 */

afterEach(() => vi.restoreAllMocks());
afterAll(() => cleanupTempDirs());

const PROJECT = "dead-canonical-cto";
const CTO = roleKeyFor(Role.PRIMARY_CTO, { projectId: PROJECT });
const CANON = "44444444-4444-4444-8444-444444444444";
const CHANNEL = "channel:dead-canonical-cto";
const PEER_PROTOCOL = "mcp/2025-06-18";
const PEER_IDENTITY = "claude-code-mcp-client";
const CWD = "/work/dead-canonical-cto";
// Above macOS's PID_MAX, so nothing on the host answers on them: only the stated chain is "alive".
const CLAUDE_PID = 4_100_010;
const RESTARTED_PID = 4_100_011;

const healthy = (clock: ManualClock): CapacityReading => ({
  provider: "claude",
  sensorHealth: "HEALTHY",
  runtimeHealth: "HEALTHY",
  observedAt: clock.nowIso(),
  source: "claude-usage",
  buckets: [{ id: "weekly-all-models", remainingPercent: 90, resetAt: null, capabilities: ["ceo", "cto", "blind-review", "worker"] }],
});

const plane = () => {
  const root = tempDir("acp-dead-cto-");
  const clock = new ManualClock("2026-11-07T09:00:00.000Z");
  const claude = new TestProductionAdapter(clock, "claude");
  const cp = new ControlPlane({
    databasePath: join(root, "state.sqlite"),
    worktreeRoot: join(root, "worktrees"),
    capacityDir: join(root, "capacity"),
    secretsDir: join(root, "secrets"),
    clock,
    adapters: [],
    allowTestEvidenceWriters: true,
  });
  // As the composition root registers Claude: role-scoped only, never provider-wide.
  for (const role of Object.values(Role)) cp.providers.registerForRole(claude, role);
  claude.setCapacity(healthy(clock));
  cp.continuity.attach({
    readiness: { checkSession: async () => allow(ReasonCode.OK, undefined) },
    buzz: { connect: async (sessionId) => allow(ReasonCode.OK, `buzz:${sessionId}`) },
  });
  const manifest = fixtureManifest(PROJECT);
  const registered = cp.projects.register({ projectId: PROJECT, name: PROJECT, manifest,
    authorization: cp.manifestAuthorizationForTests(manifest) });
  if (!registered.allowed) throw new Error(registered.message);
  cp.credentials.install({ token: "test-token", creatorIdentity: "acme-bot" });
  return { cp, clock, claude, root };
};
type Plane = ReturnType<typeof plane>;

/** A CTO bound the way the canonical claim binds one: a self-claim target on its own conversation. */
const bindCanonicalCto = (f: Plane): string => {
  const session = f.cp.sessions.create({ provider: "claude", model: "claude-cli", osPid: CLAUDE_PID, osStartedAt: "darwin-tv:1790000100.000001" });
  expect(f.cp.sessions.transition(session.sessionId, SessionLifecycle.READY).allowed).toBe(true);
  const claimed = { executorKind: SELF_CLAIM_EXECUTOR_KIND, targetLocator: CANON, targetLocatorDigest: sha256(CANON) };
  const bound = f.cp.bindings.bind({
    role: Role.PRIMARY_CTO,
    projectId: PROJECT,
    sessionId: session.sessionId,
    authenticatedTarget: {
      claimed,
      protocolVersion: SELF_CLAIM_PROTOCOL,
      attestationDigest: digestOf({ fixture: "dead-canonical-cto", sessionId: session.sessionId }),
      verify: () => claimed,
    },
  });
  if (!bound.allowed) throw new Error(bound.message);
  return session.sessionId;
};

/** A CTO bound on a session continuity may replace: no self-claim target. */
const bindPlainCto = (f: Plane): string => {
  const session = f.cp.sessions.create({ provider: "claude", model: "claude-cli", osPid: CLAUDE_PID, osStartedAt: "darwin-tv:1790000100.000001" });
  expect(f.cp.sessions.transition(session.sessionId, SessionLifecycle.READY).allowed).toBe(true);
  const bound = f.cp.bindings.bind({ role: Role.PRIMARY_CTO, projectId: PROJECT, sessionId: session.sessionId });
  if (!bound.allowed) throw new Error(bound.message);
  return session.sessionId;
};

const withDaemon = async (f: Plane, body: (daemon: Daemon) => Promise<void>): Promise<void> => {
  const daemon = new Daemon(f.cp, { stateDir: join(f.root, "daemon") });
  const started = await daemon.start();
  if (!started.allowed) throw new Error(started.message);
  try {
    await body(daemon);
  } finally {
    await daemon.stop();
  }
};

/** What the daemon's dead-session sweep does to a session whose recorded process is gone. */
const processDied = (f: Plane, sessionId: string): void => {
  expect(f.cp.sessions.transition(sessionId, SessionLifecycle.ERROR, "session process is dead").allowed).toBe(true);
};

const sessionIds = (f: Plane): string[] =>
  f.cp.db.all<{ session_id: string }>(`SELECT session_id FROM sessions ORDER BY created_at, session_id`).map((row) => row.session_id);

const latest = (f: Plane) => f.cp.db.get<{ binding_generation: number; status: string; revoked_reason: string | null }>(
  `SELECT binding_generation, status, revoked_reason FROM assignments WHERE role_key = ?
    ORDER BY binding_generation DESC LIMIT 1`,
  [CTO],
)!;

const revocations = (f: Plane) => f.cp.audit.byKind("BINDING_REVOKED").filter((row) => row.roleKey !== null).map((row) => row.evidence);

describe("a canonical PRIMARY_CTO whose process died is revoked for its lost runtime, never failed over", () => {
  it("creates no session and moves no runtime; the revocation says runtime loss and names the refused failover beside it", async () => {
    const f = plane();
    const original = bindCanonicalCto(f);
    await withDaemon(f, async (daemon) => {
      processDied(f, original);
      const admission = vi.spyOn(f.cp.capacity, "refreshForProviderSwitch");

      const report = await daemon.reconcileContinuity("the canonical CTO's claude process died");

      // Nothing was started for it, and nothing was moved onto anything.
      expect(sessionIds(f)).toEqual([original]);
      expect(f.cp.audit.byKind("BINDING_RUNTIME_MOVED")).toEqual([]);
      expect(admission).not.toHaveBeenCalled();
      expect(report?.reassigned).toEqual([]);
      expect(report?.unresolved).toEqual([{ roleKey: CTO, reasonCode: ReasonCode.ROLE_RUNTIME_SUBSTITUTION_REFUSED }]);
      // The canonical actor still names its own conversation's session.
      expect(f.cp.db.all(`SELECT current_session_id FROM conversational_actors`)).toEqual([{ current_session_id: original }]);

      // Runtime loss is the reason; the failover's refusal is its own field, not the reason.
      expect(latest(f)).toEqual({ binding_generation: 1, status: "REVOKED", revoked_reason: CONTINUITY_RUNTIME_LOST_REVOCATION_REASON });
      expect(revocations(f)).toEqual([{
        reason: CONTINUITY_RUNTIME_LOST_REVOCATION_REASON,
        generation: 1,
        failoverRefusal: ReasonCode.ROLE_RUNTIME_SUBSTITUTION_REFUSED,
      }]);
      // The capacity-only restore still does not take it: a lost runtime waits on the conversation's claim.
      expect(readCanonicalCtoRestoreTarget(f.cp.db, CTO)).toMatchObject({
        kind: "UNMET",
        condition: CanonicalCtoRestoreCondition.REVOKE_NOT_CAPACITY_ONLY,
      });
    });
  });
});

const claudeAncestor = (pid: number, startedAt: string): ProcessSnapshot => ({
  pid,
  ppid: 1,
  argv: ["/opt/claude/claude", "--session-id", CANON],
  command: `/opt/claude/claude --session-id ${CANON}`,
  cwd: CWD,
  cwdProbeFailure: null,
  startedAt,
});

/** The relay under its claude: mcp server, shell, claude, as the claim derives the claimant. */
const chainUnder = (claude: ProcessSnapshot): ProcessSnapshot[] => [
  { pid: 4_100_100, ppid: 4_100_050, argv: ["/usr/bin/node", "/opt/acp/mcp-server.js"], command: "/usr/bin/node /opt/acp/mcp-server.js",
    cwd: CWD, cwdProbeFailure: null, startedAt: "t1" },
  { pid: 4_100_050, ppid: claude.pid, argv: ["/bin/zsh", "-c", "acp"], command: "/bin/zsh -c acp",
    cwd: CWD, cwdProbeFailure: null, startedAt: "t2" },
  claude,
];

/** The real canonical claim over this plane's own registries; only the host it reads is stated. */
const selfClaim = (f: Plane, chain: readonly ProcessSnapshot[]): CanonicalSelfClaim =>
  new CanonicalSelfClaim(
    f.cp.db,
    f.clock,
    f.cp.audit,
    f.cp.sessions,
    f.cp.bindings,
    { isAllowedActor: (channel) => channel === "buzz" },
    async (): Promise<Decision<string>> => allow(ReasonCode.OK, "buzz://dead-canonical-cto"),
    {
      canonicalSessions: [{ sessionUuid: CANON, projectId: PROJECT, buzzActorId: "buzz:dead-canonical-cto" }],
      canonicalBuzzChannelId: CHANNEL,
      expectedPeerProtocolVersion: PEER_PROTOCOL,
      expectedPeerIdentity: PEER_IDENTITY,
    },
    {
      processInspector: { snapshot: (pid) => chain.find((entry) => entry.pid === pid) ?? null },
      imageInspector: { resolve: () => ({ imagePath: "/fake/versions/current/claude", version: "0.0.0-test", sha256: `sha256:${"0".repeat(64)}` }) },
      transcriptReader: { locate: (uuid) => ({ path: `/fake/transcripts/${uuid}.jsonl`, sizeBytes: 42 }) },
      hostSessionRegistryReader: { read: (pid) => hostSessionRegistryAbsent(`/fake/claude/sessions/${pid}.json is absent`) },
      // A pid outside the stated chain is gone (ESRCH); nothing reaches the real kernel.
      processSignal: (pid) => {
        if (chain.some((entry) => entry.pid === pid)) return;
        throw Object.assign(new Error(`no such process: ${pid}`), { code: "ESRCH" });
      },
    },
  );

const claimRequest = (expectedBindingGeneration: number) => ({
  callerPid: 4_100_100,
  claimedSessionUuid: CANON,
  projectId: PROJECT,
  expectedBindingGeneration,
  peerProtocolVersion: PEER_PROTOCOL,
  peerIdentity: PEER_IDENTITY,
  buzzPurpose: "continuity:PRIMARY_CTO",
});

describe("the conversation's own restart claims the role back after a runtime-loss revocation", () => {
  it("the restarted claude proves its predecessor gone and holds the next generation; nothing else restores or releases", async () => {
    const f = plane();
    const first = await selfClaim(f, chainUnder(claudeAncestor(CLAUDE_PID, "Fri Jan  1 00:00:00 2027"))).claim(claimRequest(1));
    expect(first.allowed, JSON.stringify(first)).toBe(true);
    if (!first.allowed) return;
    const predecessor = first.value.sessionId;
    expect(f.cp.sessions.require(predecessor).osPid).toBe(CLAUDE_PID);

    await withDaemon(f, async (daemon) => {
      processDied(f, predecessor);
      const lost = await daemon.reconcileContinuity("the canonical CTO's claude process died");
      expect(sessionIds(f)).toEqual([predecessor]);
      expect(f.cp.audit.byKind("BINDING_RUNTIME_MOVED")).toEqual([]);
      expect(latest(f)).toMatchObject({ binding_generation: 1, status: "REVOKED", revoked_reason: CONTINUITY_RUNTIME_LOST_REVOCATION_REASON });
      expect(lost?.continuityHolds.released).toEqual([]);

      // Waiting for the claim, a later pass restores nothing and releases nothing.
      const waiting = await daemon.reconcileContinuity("the CTO has not restarted yet");
      expect(waiting?.restored).toEqual([]);
      expect(waiting?.continuityHolds.released).toEqual([]);
      expect(f.cp.bindings.active(CTO)).toBeNull();

      // The same conversation restarts under a new claude process; the old pid answers nothing.
      const restarted = chainUnder(claudeAncestor(RESTARTED_PID, "Fri Jan  1 02:00:00 2027"));
      const claimed = await selfClaim(f, restarted).claim(claimRequest(2));
      expect(claimed.allowed, JSON.stringify(claimed)).toBe(true);
      if (!claimed.allowed) return;
      expect(claimed.value.binding.bindingGeneration).toBe(2);
      expect(f.cp.sessions.require(claimed.value.sessionId)).toMatchObject({ osPid: RESTARTED_PID, lifecycle: SessionLifecycle.READY });
      expect(f.cp.bindings.active(CTO)).toMatchObject({ sessionId: claimed.value.sessionId, bindingGeneration: 2 });
      // Only the conversation's own two runtimes ever existed.
      expect(sessionIds(f).sort()).toEqual([predecessor, claimed.value.sessionId].sort());

      const after = await daemon.reconcileContinuity("the CTO claimed its role back");
      expect(after?.reassigned).toEqual([]);
      expect(after?.unresolved).toEqual([]);
      expect(f.cp.bindings.active(CTO)).toMatchObject({ sessionId: claimed.value.sessionId, bindingGeneration: 2 });
    });
  });
});

describe("a PRIMARY_CTO continuity may replace is failed over against its own role-scoped capacity", () => {
  it("names the role at admission and is staffed on a fresh session", async () => {
    const f = plane();
    const original = bindPlainCto(f);
    await withDaemon(f, async (daemon) => {
      processDied(f, original);
      const admission = vi.spyOn(f.cp.capacity, "refreshForProviderSwitch");

      const report = await daemon.reconcileContinuity("the CTO's claude process died");

      expect(admission.mock.calls.map(([target]) => target)).toEqual([
        { provider: "claude", role: Role.PRIMARY_CTO, capabilities: ["cto"], priority: "critical" },
      ]);
      expect(report?.unresolved).toEqual([]);
      expect(report?.reassigned).toEqual([expect.objectContaining({ roleKey: CTO, fromGeneration: 1, toGeneration: 2, provider: "claude" })]);
      const active = f.cp.bindings.active(CTO)!;
      expect(active.sessionId).not.toBe(original);
      expect(f.cp.sessions.require(active.sessionId).lifecycle).toBe(SessionLifecycle.READY);
    });
  });

  it("is still refused when the role's capacity is truly unknown, and the revocation keeps runtime loss apart from that refusal", async () => {
    const f = plane();
    const original = bindPlainCto(f);
    // Provider-only admission of a role-scoped provider is still refused.
    expect(await f.cp.capacity.refreshForProviderSwitch({ provider: "claude", capabilities: ["cto"], priority: "critical" }))
      .toMatchObject({ allowed: false, reasonCode: ReasonCode.CAPACITY_UNKNOWN_NOT_ROUTABLE });
    await withDaemon(f, async (daemon) => {
      processDied(f, original);
      // The role's capacity binding is invalidated while the switch admission measures it, so the reading
      // describes no registered binding: what the role's capacity is, nothing can say.
      let switching = false;
      const admit = f.cp.capacity.refreshForProviderSwitch.bind(f.cp.capacity);
      vi.spyOn(f.cp.capacity, "refreshForProviderSwitch").mockImplementation(async (target) => {
        switching = true;
        try {
          return await admit(target);
        } finally {
          switching = false;
        }
      });
      const measure = f.cp.capacity.refreshForRole.bind(f.cp.capacity);
      vi.spyOn(f.cp.capacity, "refreshForRole").mockImplementation(async (provider, role) => {
        const reading = await measure(provider, role);
        if (switching) f.cp.providers.invalidateCapacityForRole(provider, role);
        return reading;
      });

      const report = await daemon.reconcileContinuity("the CTO's claude process died");

      expect(report?.unresolved).toEqual([{ roleKey: CTO, reasonCode: ReasonCode.CAPACITY_UNKNOWN_NOT_ROUTABLE }]);
      expect(sessionIds(f)).toEqual([original]);
      expect(latest(f)).toEqual({ binding_generation: 1, status: "REVOKED", revoked_reason: CONTINUITY_RUNTIME_LOST_REVOCATION_REASON });
      expect(revocations(f)).toEqual([{
        reason: CONTINUITY_RUNTIME_LOST_REVOCATION_REASON,
        generation: 1,
        failoverRefusal: ReasonCode.CAPACITY_UNKNOWN_NOT_ROUTABLE,
      }]);
    });
  });
});
