import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ControlPlane } from "../../src/app/control-plane.ts";
import {
  CONTINUITY_CAPACITY_AND_RUNTIME_REVOCATION_REASON,
  CONTINUITY_CAPACITY_EXHAUSTED_REVOCATION_REASON,
  CONTINUITY_RUNTIME_UNAVAILABLE_REVOCATION_REASON,
  isContinuityRevocationReason,
} from "../../src/continuity/continuity-kernel.ts";
import { ManualClock } from "../../src/core/clock.ts";
import { Daemon } from "../../src/daemon/daemon.ts";
import { Role, SessionLifecycle, roleKeyFor } from "../../src/domain/types.ts";
import type { CapacityReading } from "../../src/runtime/provider.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { fixtureManifest } from "../helpers/harness.ts";
import { TestProductionAdapter } from "../helpers/production-adapter.ts";

/**
 * #1106 — a coverage revocation records what the daemon measured when it wrote it. Before this, every
 * one carried the same literal, so a window that ran out and a runtime that stopped answering read
 * the same, and nothing could restore the first without restoring the second. Capacity counts only
 * as an exhausted window on a HEALTHY reading; both at once is its own, compound reason.
 */

const planes: ControlPlane[] = [];
afterEach(() => {
  for (const cp of planes.splice(0)) cp.close();
  cleanupTempDirs();
});

const PROJECT = "revocation-reason";
const ROLE = roleKeyFor(Role.PRIMARY_CTO, { projectId: PROJECT });

const incumbent = () => {
  const root = tempDir("acp-revocation-reason-");
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
  expect(cp.projects.register({ projectId: PROJECT, name: "fixture", manifest, authorization: cp.manifestAuthorizationForTests(manifest) }).allowed)
    .toBe(true);
  // A recorded process that is not running: no hold, the revocation lands on the first pass.
  const session = cp.sessions.create({ provider: "claude", model: "opus", osPid: 525_252, osStartedAt: "darwin-tv:1790000100.000001" });
  expect(cp.sessions.transition(session.sessionId, SessionLifecycle.READY).allowed).toBe(true);
  expect(cp.bindings.bind({ role: Role.PRIMARY_CTO, projectId: PROJECT, sessionId: session.sessionId }).allowed).toBe(true);
  const daemon = new Daemon(cp, { stateDir: join(root, "daemon") });
  const reading = (overrides: Partial<CapacityReading>, remainingPercent: number): CapacityReading => ({
    provider: "claude",
    sensorHealth: "HEALTHY",
    runtimeHealth: "HEALTHY",
    observedAt: clock.nowIso(),
    source: "claude-usage",
    buckets: [{ id: "weekly-all-models", remainingPercent, resetAt: null, capabilities: ["cto", "ceo"] }],
    ...overrides,
  });
  const revokedReason = (): string | null =>
    cp.db.get<{ revoked_reason: string | null }>(
      `SELECT revoked_reason FROM assignments WHERE role_key = ? ORDER BY binding_generation DESC LIMIT 1`,
      [ROLE],
    )?.revoked_reason ?? null;
  return { cp, claude, daemon, reading, revokedReason };
};

describe("#1106: a coverage revocation says what was measured", () => {
  it("an exhausted window on a HEALTHY reading, with the runtime answering, is capacity alone", async () => {
    const f = incumbent();
    f.claude.setCapacity(f.reading({}, 0));
    await f.daemon.reconcileContinuity("weekly window exhausted");
    expect(f.cp.bindings.active(ROLE)).toBeNull();
    expect(f.revokedReason()).toBe(CONTINUITY_CAPACITY_EXHAUSTED_REVOCATION_REASON);
  });

  it("a runtime measured UNAVAILABLE with quota left is a lost runtime", async () => {
    const f = incumbent();
    f.claude.setCapacity(f.reading({ runtimeHealth: "UNAVAILABLE" }, 90));
    await f.daemon.reconcileContinuity("runtime stopped answering");
    expect(f.revokedReason()).toBe(CONTINUITY_RUNTIME_UNAVAILABLE_REVOCATION_REASON);
  });

  it("both at once is the compound reason, never capacity", async () => {
    const f = incumbent();
    f.claude.setCapacity(f.reading({ runtimeHealth: "UNAVAILABLE" }, 0));
    await f.daemon.reconcileContinuity("exhausted and unavailable");
    expect(f.revokedReason()).toBe(CONTINUITY_CAPACITY_AND_RUNTIME_REVOCATION_REASON);
  });

  it("an exhausted bucket on a reading whose sensor failed is not capacity", async () => {
    const f = incumbent();
    f.claude.setCapacity(f.reading({ sensorHealth: "ERROR", runtimeHealth: "UNAVAILABLE", error: "usage timed out" }, 0));
    await f.daemon.reconcileContinuity("sensor failed, runtime gone");
    expect(f.revokedReason()).toBe(CONTINUITY_RUNTIME_UNAVAILABLE_REVOCATION_REASON);
  });

  it("every split reason is still one continuity wrote, so the role stays owed", () => {
    for (const reason of [
      CONTINUITY_CAPACITY_EXHAUSTED_REVOCATION_REASON,
      CONTINUITY_RUNTIME_UNAVAILABLE_REVOCATION_REASON,
      CONTINUITY_CAPACITY_AND_RUNTIME_REVOCATION_REASON,
    ]) {
      expect(isContinuityRevocationReason(reason)).toBe(true);
    }
  });
});
