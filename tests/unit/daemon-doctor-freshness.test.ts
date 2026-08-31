import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { ReasonCode } from "../../src/core/reason-codes.ts";
import type { DoctorReport } from "../../src/doctor/doctor.ts";
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

/**
 * Real promise control rather than `setTimeout` racing: the overlap tests below assert an
 * ordering, and an ordering asserted against a timer is a flake waiting for a loaded runner.
 * Each stubbed `doctor.run` announces that it has been entered and then blocks on a gate the
 * test releases by hand, so "B finished before A" is a fact of the test, not a hope about it.
 */
interface Deferred {
  readonly promise: Promise<void>;
  readonly release: () => void;
}

const deferred = (): Deferred => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = () => resolve();
  });
  return { promise, release };
};

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

  it("criterion 3 (operator path): a failed on-demand DOCTOR_RUN persists STALE to disk immediately, not only when a later caller happens to writeHealth", async () => {
    // The CEO's counterexample: `runSystemDoctorCheck()`'s failure branch used to update memory
    // only and rethrow, relying on the *caller* to persist. `reconcileContinuity()`'s failure
    // path looked covered only because `runPeriodic`'s own catch calls `writeHealth` — but
    // `OPERATOR_METHOD.DOCTOR_RUN`'s failure is caught by `executeOperatorRequest`'s outer catch,
    // which returns `INTERNAL_ERROR` and never calls `writeHealth`. Without a persist inside the
    // failure branch itself, `DAEMON_STATUS` — which reads `health.json` from disk — would keep
    // answering the previous healthy value until some unrelated write happened to land.
    const harness = makeHarness();
    harness.cp.credentials.install({ token: "test-token", creatorIdentity: "acme-bot" });
    const stateDir = tempDir("acp-doctor-freshness-");
    const daemon = new Daemon(harness.cp, { stateDir, doctorFreshnessMs: 5 * 60_000 });
    const started = await daemon.start();
    expect(started.allowed).toBe(true);
    const healthyBefore = readHealth(stateDir).doctor!;
    expect(healthyBefore.status).not.toBe("STALE");

    vi.spyOn(harness.cp.doctor, "run").mockRejectedValueOnce(new Error("#734 test: operator-triggered probe exploded"));
    harness.clock.advance(10_000);
    const response = await daemon.handleOperatorRequest(
      { requestId: "req-doctor-run-fail", method: OPERATOR_METHOD.DOCTOR_RUN, params: { scope: "system" } },
      PEER,
    );
    expect(response.allowed).toBe(false);
    expect(response.reasonCode).toBe(ReasonCode.INTERNAL_ERROR);

    // Immediately after the failed response — no later write, no additional tick.
    const onDisk = readHealth(stateDir).doctor!;
    expect(onDisk.status).toBe("STALE");
    expect(onDisk.status).not.toBe(healthyBefore.status);
    expect(onDisk.reason).toContain("#734 test: operator-triggered probe exploded");

    const status = await daemon.handleOperatorRequest(
      { requestId: "req-daemon-status", method: OPERATOR_METHOD.DAEMON_STATUS, params: {} },
      PEER,
    );
    expect(status.allowed).toBe(true);
    if (status.allowed) {
      const daemonStatus = status.value as { health: { doctor: { status: string; reason?: string } } };
      expect(daemonStatus.health.doctor.status).toBe("STALE");
      expect(daemonStatus.health.doctor.reason).toContain("#734 test: operator-triggered probe exploded");
    }
    await daemon.stop();
  });

  it("criterion 3 (startup path): a doctor that throws during startup does not leave a previous run's healthy health.json as if current", async () => {
    const harness = makeHarness();
    harness.cp.credentials.install({ token: "test-token", creatorIdentity: "acme-bot" });
    const stateDir = tempDir("acp-doctor-freshness-");

    const first = new Daemon(harness.cp, { stateDir, doctorFreshnessMs: 5 * 60_000 });
    const firstStarted = await first.start();
    expect(firstStarted.allowed).toBe(true);
    const healthyBefore = readHealth(stateDir).doctor!;
    expect(healthyBefore.status).not.toBe("STALE");
    await first.stop();

    // A fresh process (a fresh `Daemon` instance, same on-disk state) whose startup doctor pass
    // throws — the crash a restart is meant to recover from, not the ordinary BLOCKED/ERROR
    // verdict path.
    vi.spyOn(harness.cp.doctor, "run").mockRejectedValueOnce(new Error("#734 test: startup probe exploded"));
    harness.clock.advance(10_000);
    const second = new Daemon(harness.cp, { stateDir, doctorFreshnessMs: 5 * 60_000 });
    const secondStarted = await second.start();
    expect(secondStarted.allowed).toBe(false);
    expect(secondStarted.reasonCode).toBe(ReasonCode.DAEMON_STARTUP_FAILED);

    const onDisk = readHealth(stateDir).doctor!;
    expect(onDisk.status).not.toBe(healthyBefore.status);
    expect(onDisk.status).not.toBe("HEALTHY");
    expect(onDisk.status).not.toBe("DEGRADED");
    expect(onDisk.reason).toContain("#734 test: startup probe exploded");
  });

  it("criterion 5: a slow re-evaluation that FAILS after a fast one succeeded is STALE immediately, with the failure's own provenance", async () => {
    // The CEO's counterexample, and the defect it exposes is a malformed comparison rather than a
    // missing fence. `runSystemDoctorCheck` stamps its attempt *before* the probes; `Doctor.run`
    // stamps `DoctorReport.ranAt` *after* them (`doctor.ts` — the report literal is built once
    // every check has returned). `resolveDoctorHealth` then compared the two as if they were the
    // same lifecycle point. They differ by one probe duration, and when two evaluations overlap
    // the difference is a wrong answer: a failure that began before a fast success finished has
    // the earlier start stamp, so it was ruled older and dropped — the failure hiding behind the
    // healthy verdict it was evidence against.
    const harness = makeHarness();
    harness.cp.credentials.install({ token: "test-token", creatorIdentity: "acme-bot" });
    const stateDir = tempDir("acp-doctor-freshness-");
    const daemon = new Daemon(harness.cp, { stateDir, doctorFreshnessMs: 5 * 60_000 });
    const started = await daemon.start();
    expect(started.allowed).toBe(true);
    expect(readHealth(stateDir).doctor!.status).not.toBe("STALE");

    const enteredFailing = deferred();
    const enteredSucceeding = deferred();
    const releaseFailing = deferred();
    const releaseSucceeding = deferred();
    let calls = 0;
    // Faithful to production: `ranAt` is read from the clock *after* the gate, because that is
    // where the real `Doctor.run` reads it — after its probes, not on entry. Stamping it on entry
    // would make the stub model a doctor this repository does not have, and the ordering under
    // test is exactly the one those two stamps disagree about.
    vi.spyOn(harness.cp.doctor, "run").mockImplementation(async (): Promise<DoctorReport> => {
      const first = calls++ === 0;
      if (first) {
        enteredFailing.release();
        await releaseFailing.promise;
        throw new Error("#734 test: the slow overlapping probe exploded");
      }
      enteredSucceeding.release();
      await releaseSucceeding.promise;
      return { scope: "system", target: null, status: "HEALTHY", findings: [], ranAt: harness.clock.nowIso() };
    });

    // A — the operator door. Starts first, fails last.
    harness.clock.advance(10_000);
    const startedAtFailing = harness.clock.nowIso();
    const slowFailingRun = daemon.handleOperatorRequest(
      { requestId: "req-doctor-run-slow-failure", method: OPERATOR_METHOD.DOCTOR_RUN, params: { scope: "system" } },
      PEER,
    );
    await enteredFailing.promise;

    // B — the reactive continuity trigger. Starts second, succeeds first.
    const reactiveRefresh = daemon.reconcileContinuity("#734 test: a fast success inside a slow failure");
    await enteredSucceeding.promise;
    harness.clock.advance(10_000);
    const ranAtSucceeding = harness.clock.nowIso();
    releaseSucceeding.release();
    await reactiveRefresh;

    const afterSuccess = readHealth(stateDir).doctor!;
    expect(afterSuccess.status).toBe("HEALTHY");
    expect(afterSuccess.checkedAt).toBe(ranAtSucceeding);
    // A's start stamp is genuinely earlier than the success's completion stamp. That is the input
    // the old comparison got wrong, and it is not an artefact of a tie.
    expect(Date.parse(startedAtFailing)).toBeLessThan(Date.parse(ranAtSucceeding));

    // A now fails, completing after B. It is the newest thing the daemon knows.
    harness.clock.advance(10_000);
    releaseFailing.release();
    const response = await slowFailingRun;
    expect(response.allowed).toBe(false);
    expect(response.reasonCode).toBe(ReasonCode.INTERNAL_ERROR);

    // Immediately — no later write, no additional tick.
    const onDisk = readHealth(stateDir).doctor!;
    expect(onDisk.status).toBe("STALE");
    expect(onDisk.status).not.toBe("HEALTHY");
    expect(onDisk.reason).toContain("#734 test: the slow overlapping probe exploded");

    const status = await daemon.handleOperatorRequest(
      { requestId: "req-daemon-status-overlap", method: OPERATOR_METHOD.DAEMON_STATUS, params: {} },
      PEER,
    );
    expect(status.allowed).toBe(true);
    if (status.allowed) {
      const daemonStatus = status.value as { health: { doctor: { status: string; reason?: string } } };
      expect(daemonStatus.health.doctor.status).toBe("STALE");
      expect(daemonStatus.health.doctor.reason).toContain("#734 test: the slow overlapping probe exploded");
    }
    await daemon.stop();
  });

  it("criterion 5 (reverse completion order): a failure that completed FIRST does not overwrite the success that completed after it", async () => {
    // The other direction. Once the ordering authority is "which run finished last", the rule has
    // to be able to say *not stale* as well as *stale* — a rule that only ever escalates is not an
    // ordering, it is a latch, and a daemon whose doctor never recovers from one transient probe
    // failure is the same outage in the other direction. Same two overlapping runs as above, with
    // the completions swapped.
    const harness = makeHarness();
    harness.cp.credentials.install({ token: "test-token", creatorIdentity: "acme-bot" });
    const stateDir = tempDir("acp-doctor-freshness-");
    const daemon = new Daemon(harness.cp, { stateDir, doctorFreshnessMs: 5 * 60_000 });
    const started = await daemon.start();
    expect(started.allowed).toBe(true);

    const enteredFailing = deferred();
    const enteredSucceeding = deferred();
    const releaseFailing = deferred();
    const releaseSucceeding = deferred();
    let calls = 0;
    vi.spyOn(harness.cp.doctor, "run").mockImplementation(async (): Promise<DoctorReport> => {
      const first = calls++ === 0;
      if (first) {
        enteredFailing.release();
        await releaseFailing.promise;
        throw new Error("#734 test: the early overlapping probe exploded");
      }
      enteredSucceeding.release();
      await releaseSucceeding.promise;
      return { scope: "system", target: null, status: "HEALTHY", findings: [], ranAt: harness.clock.nowIso() };
    });

    harness.clock.advance(10_000);
    const failingRun = daemon.handleOperatorRequest(
      { requestId: "req-doctor-run-early-failure", method: OPERATOR_METHOD.DOCTOR_RUN, params: { scope: "system" } },
      PEER,
    );
    await enteredFailing.promise;
    const slowSucceedingRefresh = daemon.reconcileContinuity("#734 test: a slow success outliving a fast failure");
    await enteredSucceeding.promise;

    // The failure completes first, and while it stands it is correctly the newest fact.
    harness.clock.advance(10_000);
    releaseFailing.release();
    const response = await failingRun;
    expect(response.allowed).toBe(false);
    expect(response.reasonCode).toBe(ReasonCode.INTERNAL_ERROR);
    const whileFailingStands = readHealth(stateDir).doctor!;
    expect(whileFailingStands.status).toBe("STALE");
    expect(whileFailingStands.reason).toContain("#734 test: the early overlapping probe exploded");

    // The success completes after it and supersedes it.
    harness.clock.advance(10_000);
    const ranAtSucceeding = harness.clock.nowIso();
    releaseSucceeding.release();
    await slowSucceedingRefresh;

    const afterSuccess = readHealth(stateDir).doctor!;
    expect(afterSuccess.status).toBe("HEALTHY");
    expect(afterSuccess.status).not.toBe("STALE");
    expect(afterSuccess.checkedAt).toBe(ranAtSucceeding);
    expect(afterSuccess.reason).toBeUndefined();
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
