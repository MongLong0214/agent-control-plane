import { join } from "node:path";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { ControlPlane } from "../../src/app/control-plane.ts";
import { ManualClock } from "../../src/core/clock.ts";
import { digestOf, sha256 } from "../../src/core/digest.ts";
import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Daemon } from "../../src/daemon/daemon.ts";
import { ExecutionMode, Role, RunState, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import { SELF_CLAIM_EXECUTOR_KIND, SELF_CLAIM_PROTOCOL } from "../../src/registry/canonical-self-claim.ts";
import type { CapacityReading } from "../../src/runtime/provider.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { fixtureManifest } from "../helpers/harness.ts";
import { TestProductionAdapter } from "../helpers/production-adapter.ts";

/**
 * #1445 (R1) — a canonical PRIMARY_CTO is one conversation kept open for a month: a quota reading
 * never pauses or revokes it. Only a lost runtime does. The incumbent here is READY on a DEGRADED
 * runtime with an exhausted window, and its recorded start token cannot be pinned (no process start
 * token is readable for it), which is exactly where the coverage check used to fall through to revoke.
 */

afterEach(() => vi.restoreAllMocks());
afterAll(() => cleanupTempDirs());

const PROJECT = "never-revoked-for-capacity";
const CTO = roleKeyFor(Role.PRIMARY_CTO, { projectId: PROJECT });
const CONVERSATION = "55555555-5555-4555-8555-555555555555";
// Above macOS's PID_MAX: nothing on the host answers on it unless the case says it does.
const CLAUDE_PID = 4_100_020;

const exhaustedOnDegradedRuntime = (clock: ManualClock): CapacityReading => ({
  provider: "claude",
  sensorHealth: "HEALTHY",
  runtimeHealth: "DEGRADED",
  observedAt: clock.nowIso(),
  source: "claude-usage",
  buckets: [{ id: "weekly-all-models", remainingPercent: 0, resetAt: null, capabilities: ["ceo", "cto", "blind-review", "worker"] }],
});

const plane = () => {
  const root = tempDir("acp-never-revoked-");
  const clock = new ManualClock("2026-11-28T09:00:00.000Z");
  const claude = new TestProductionAdapter(clock, "claude");
  const cp = new ControlPlane({
    databasePath: join(root, "state.sqlite"),
    worktreeRoot: join(root, "worktrees"),
    capacityDir: join(root, "capacity"),
    secretsDir: join(root, "secrets"),
    clock,
    adapters: [],
    capacity: { exhaustedPercent: 2 },
    allowTestEvidenceWriters: true,
  });
  for (const role of Object.values(Role)) cp.providers.registerForRole(claude, role);
  cp.continuity.attach({
    readiness: { checkSession: async () => allow(ReasonCode.OK, undefined) },
    buzz: { connect: async (sessionId) => allow(ReasonCode.OK, `buzz:${sessionId}`) },
  });
  const manifest = fixtureManifest(PROJECT);
  const registered = cp.projects.register({ projectId: PROJECT, name: PROJECT, manifest,
    authorization: cp.manifestAuthorizationForTests(manifest) });
  if (!registered.allowed) throw new Error(registered.message);

  const session = cp.sessions.create({ provider: "claude", model: "claude-cli", osPid: CLAUDE_PID, osStartedAt: "darwin-tv:1790000100.000001" });
  expect(cp.sessions.transition(session.sessionId, SessionLifecycle.READY).allowed).toBe(true);
  const claimed = { executorKind: SELF_CLAIM_EXECUTOR_KIND, targetLocator: CONVERSATION, targetLocatorDigest: sha256(CONVERSATION) };
  const bound = cp.bindings.bind({
    role: Role.PRIMARY_CTO,
    projectId: PROJECT,
    sessionId: session.sessionId,
    authenticatedTarget: {
      claimed,
      protocolVersion: SELF_CLAIM_PROTOCOL,
      attestationDigest: digestOf({ fixture: PROJECT, sessionId: session.sessionId }),
      verify: () => claimed,
    },
  });
  if (!bound.allowed) throw new Error(bound.message);

  const created = cp.runs.create({
    projectId: PROJECT, executionMode: ExecutionMode.SIMPLE,
    contract: { goal: "long work", why: "test", scope: [], nonGoals: [], acceptance: ["done"], priority: "NORMAL", humanGate: [], references: [] },
  });
  if (!created.allowed) throw new Error(created.message);
  const active = cp.runs.transition(created.value.runId, RunState.ACTIVE, "test: the CTO is working on it");
  if (!active.allowed) throw new Error(active.message);

  claude.setCapacity(exhaustedOnDegradedRuntime(clock));
  return { cp, binding: bound.value, runId: created.value.runId, daemon: new Daemon(cp, { stateDir: join(root, "daemon") }) };
};

/** The claude process answers `kill(pid, 0)`; its start token is not readable, so nothing can pin it. */
const processAnswers = (): void => {
  const realKill = process.kill.bind(process);
  vi.spyOn(process, "kill").mockImplementation((pid, sig) => {
    if (sig === 0 && pid === CLAUDE_PID) return true;
    return realKill(pid, sig);
  });
};

describe("#1445: a canonical CTO is never revoked for capacity", () => {
  it("keeps a READY canonical CTO bound and its run ACTIVE on an exhausted window", async () => {
    const f = plane();
    processAnswers();

    const report = await f.daemon.reconcileContinuity("weekly window exhausted");

    expect(f.cp.bindings.active(CTO)).toEqual(f.binding);
    expect(f.cp.runs.require(f.runId).state).toBe(RunState.ACTIVE);
    expect(report?.pausedRuns).toEqual([]);
    expect(f.cp.audit.byKind("BINDING_REVOKED").filter((row) => row.roleKey !== null)).toEqual([]);
  });

  it("still pauses and revokes it once its process is dead", async () => {
    const f = plane();

    const report = await f.daemon.reconcileContinuity("the canonical CTO's claude process died");

    expect(f.cp.bindings.active(CTO)).toBeNull();
    expect(f.cp.runs.require(f.runId).state).not.toBe(RunState.ACTIVE);
    expect(report?.pausedRuns).toEqual([{ runId: f.runId, roleKey: CTO, reasonCode: ReasonCode.COVERAGE_INCOMPLETE }]);
  });
});
