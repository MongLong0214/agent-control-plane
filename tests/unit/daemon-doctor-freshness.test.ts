import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ExecutionMode } from "../../src/domain/types.ts";
import { Daemon, OPERATOR_METHOD, type AuthenticatedOperatorPeer } from "../../src/daemon/daemon.ts";
import type { TaskContract } from "../../src/run/run-engine.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { makeHarness, registerFixtureProject } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * #734 — a doctor verdict used to be written only at startup, so an eight-day-old snapshot read
 * as current health while the daemon kept running and its state kept changing underneath it.
 * These tests exercise the daemon-level wiring: the persisted health surface (`health.json`,
 * which `agentctl daemon status` / `OPERATOR_METHOD.DAEMON_STATUS` reads verbatim) has to carry
 * a freshness-bounded doctor snapshot that a reader gets *without restarting the daemon*.
 */
const CONTRACT: TaskContract = {
  goal: "doctor freshness regression",
  why: "#734 — an eight-day-old doctor verdict must not read as current",
  scope: [],
  nonGoals: [],
  acceptance: ["tests pass"],
  priority: "NORMAL",
  humanGate: [],
  references: [],
};

const readHealth = (stateDir: string): {
  doctor?: { status: string; checkedAt: string | null; ageMs: number | null; reason?: string };
} => JSON.parse(readFileSync(join(stateDir, "health.json"), "utf8"));

const PEER: AuthenticatedOperatorPeer = {
  channel: "cli",
  peerId: "cli:fixture-operator",
  actor: "fixture-operator",
  incarnation: "incarnation-1",
};

describe("#734 daemon doctor freshness", () => {
  it("criterion 1: health.json carries a checked_at for the system doctor evaluation that just ran at startup", async () => {
    const harness = makeHarness();
    harness.cp.credentials.install({ token: "test-token", creatorIdentity: "acme-bot" });
    const stateDir = tempDir("acp-doctor-freshness-");
    const daemon = new Daemon(harness.cp, { stateDir });

    const started = await daemon.start();
    expect(started.allowed).toBe(true);

    const health = readHealth(stateDir);
    expect(health.doctor).toMatchObject({
      checkedAt: harness.clock.nowIso(),
      ageMs: 0,
    });
    expect(health.doctor?.status).not.toBe("STALE");
    expect(health.doctor?.status).not.toBe("UNKNOWN");
    await daemon.stop();
  });

  it("criterion 2 (reactive): a continuity reconciliation re-evaluates the persisted doctor snapshot, tying it to capacity/continuity state changes rather than only startup", async () => {
    const harness = makeHarness();
    harness.cp.credentials.install({ token: "test-token", creatorIdentity: "acme-bot" });
    const stateDir = tempDir("acp-doctor-freshness-");
    const daemon = new Daemon(harness.cp, {
      stateDir,
      // The default capacity-sensor cadence (4 minutes) is long enough that its periodic tick
      // cannot fire during this test — the point here is the *reactive* trigger, not the
      // periodic one.
      doctorFreshnessMs: 5 * 60_000,
    });
    const started = await daemon.start();
    expect(started.allowed).toBe(true);
    const before = readHealth(stateDir).doctor!;

    harness.clock.advance(10_000);
    await daemon.reconcileContinuity("#734 test: capacity/continuity state change");

    const after = readHealth(stateDir).doctor!;
    expect(after.checkedAt).not.toBe(before.checkedAt);
    expect(after.checkedAt).toBe(harness.clock.nowIso());
    await daemon.stop();
  });

  it("criterion 2 (bounded window): the periodic capacity-sensor tick keeps the doctor snapshot inside its freshness window without a restart", async () => {
    const harness = makeHarness();
    harness.cp.credentials.install({ token: "test-token", creatorIdentity: "acme-bot" });
    const stateDir = tempDir("acp-doctor-freshness-");
    // A sweep must fit inside the interval between sweeps (matches the #244 pattern).
    const daemon = new Daemon(harness.cp, {
      stateDir,
      capacityRefreshIntervalMs: 20,
      capacityRefreshBudgetMs: 10,
      doctorFreshnessMs: 5 * 60_000,
    });
    const started = await daemon.start();
    expect(started.allowed).toBe(true);
    const before = readHealth(stateDir).doctor!.checkedAt;

    harness.clock.advance(60_000);
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 40));

    const after = readHealth(stateDir).doctor!;
    // The tick ran on the live clock at the moment it fired, not at process start — this is what
    // "obtainable without a restart" means for the periodic path.
    expect(after.checkedAt).not.toBe(before);
    expect(after.checkedAt).toBe(harness.clock.nowIso());
    expect(after.status).not.toBe("STALE");
    await daemon.stop();
  });

  it("criterion 3: a re-evaluation that fails yields STALE immediately — never the previous healthy value, even while still inside the freshness window", async () => {
    const harness = makeHarness();
    harness.cp.credentials.install({ token: "test-token", creatorIdentity: "acme-bot" });
    const stateDir = tempDir("acp-doctor-freshness-");
    const daemon = new Daemon(harness.cp, {
      stateDir,
      doctorFreshnessMs: 5 * 60_000,
    });
    const started = await daemon.start();
    expect(started.allowed).toBe(true);
    const healthyBefore = readHealth(stateDir).doctor!;
    expect(healthyBefore.status).not.toBe("STALE");

    vi.spyOn(harness.cp.doctor, "run").mockRejectedValueOnce(new Error("#734 test: doctor probe exploded"));
    // Only ten seconds later — nowhere near the five-minute freshness window. A naive age-only
    // check would still call this fresh; the point of criterion 3 is that it must not.
    harness.clock.advance(10_000);
    await daemon.reconcileContinuity("#734 test: forced re-evaluation failure");

    const after = readHealth(stateDir).doctor!;
    expect(after.status).toBe("STALE");
    expect(after.status).not.toBe(healthyBefore.status);
    expect(after.reason).toContain("#734 test: doctor probe exploded");
    await daemon.stop();
  });

  it("criterion 4: an on-demand operator doctor run refreshes the persisted snapshot without a daemon restart", async () => {
    const harness = makeHarness();
    harness.cp.credentials.install({ token: "test-token", creatorIdentity: "acme-bot" });
    const stateDir = tempDir("acp-doctor-freshness-");
    const daemon = new Daemon(harness.cp, {
      stateDir,
      doctorFreshnessMs: 5 * 60_000,
    });
    const started = await daemon.start();
    expect(started.allowed).toBe(true);
    const before = readHealth(stateDir).doctor!.checkedAt;

    harness.clock.advance(30_000);
    const response = await daemon.handleOperatorRequest(
      { requestId: "req-doctor-run", method: OPERATOR_METHOD.DOCTOR_RUN, params: { scope: "system" } },
      PEER,
    );
    expect(response.allowed).toBe(true);

    const after = readHealth(stateDir).doctor!;
    expect(after.checkedAt).not.toBe(before);
    expect(after.checkedAt).toBe(harness.clock.nowIso());
    await daemon.stop();
  });

  it("regression: DEGRADED still does not block startup dispatch", async () => {
    // A fresh harness with no CEO bound and no capacity sensor file yet written produces
    // CEO_ROLE_UNBOUND (WARN, non-blocking) and CAPACITY_SENSOR_FILE_MISSING (ERROR,
    // non-blocking) — DEGRADED under §25.5's deterministic aggregation, and DEGRADED must still
    // let the daemon come up exactly as before this change.
    const harness = makeHarness();
    harness.cp.credentials.install({ token: "test-token", creatorIdentity: "acme-bot" });
    const stateDir = tempDir("acp-doctor-freshness-");
    const daemon = new Daemon(harness.cp, { stateDir });

    const started = await daemon.start();

    expect(started.allowed).toBe(true);
    if (started.allowed) expect(started.value.doctorStatus).toBe("DEGRADED");
    await daemon.stop();
  });

  it("regression: BLOCKED still refuses to let dispatch resume", async () => {
    const harness = makeHarness();
    const { projectId, repositoryId } = await registerFixtureProject(harness);
    const created = harness.cp.runs.create({
      projectId,
      executionMode: ExecutionMode.STANDARD,
      contract: CONTRACT,
      repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
    });
    if (!created.allowed) throw new Error(created.message);
    const stateDir = tempDir("acp-doctor-freshness-");
    const daemon = new Daemon(harness.cp, { stateDir });

    const started = await daemon.start();

    expect(started.allowed).toBe(false);
    expect(started.reasonCode).toBe(ReasonCode.DOCTOR_BLOCKED);
    expect(harness.cp.runs.require(created.value.runId).state).toBe("QUEUED");
  });
});
