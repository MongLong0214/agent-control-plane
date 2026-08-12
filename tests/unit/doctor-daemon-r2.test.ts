import { execFileSync } from "node:child_process";
import { readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { ReasonCode } from "../../src/core/reason-codes.ts";
import { Daemon } from "../../src/daemon/daemon.ts";
import { localMcpTokenMatches, startLocalMcpListeners } from "../../src/daemon/agentcpd.ts";
import { SingleInstanceLock } from "../../src/daemon/single-instance.ts";
import { ExecutionMode, RunState } from "../../src/domain/types.ts";
import type { TaskContract } from "../../src/run/run-engine.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { bindCeo, makeHarness, registerFixtureProject } from "../helpers/harness.ts";

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
  return { harness, repositoryId, identity, run: created.value };
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

  it("#112/#209: a RUNNING receipt without a worker identity blocks the doctor", async () => {
    const { harness, repositoryId, run } = await createDispatchedRun();
    const task = harness.cp.tasks.submit(run.runId, [{ key: "work", title: "work", category: "implementation" }]);
    if (!task.allowed) throw new Error(task.message);
    const receipt = harness.cp.tasks.startExecution({
      runId: run.runId,
      taskId: task.value[0]!.taskId,
      ownerBindingGeneration: run.ownerBindingGeneration!,
      workerSessionId: null,
      workerProcessId: null,
      provider: "scripted",
      model: "scripted-worker",
      repositoryId,
    });
    expect(receipt.allowed).toBe(true);

    const report = await harness.cp.doctor.run("run", run.runId);
    expect(report.findings.map((finding) => finding.code)).toContain("WORKER_IDENTITY_MISSING");
    expect(report.status).toBe("BLOCKED");
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
    const receipt = harness.cp.tasks.startExecution({
      runId: run.runId,
      taskId: task.value[0]!.taskId,
      ownerBindingGeneration: run.ownerBindingGeneration!,
      workerSessionId: null,
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
    expect(localMcpTokenMatches({ token: "forged" }, "local-test-token")).toBe(false);
    expect(localMcpTokenMatches({ token: "local-test-token" }, "local-test-token")).toBe(true);
    await expect(startLocalMcpListeners(harness.cp, tempDir("acp-mcp-r2-"), "")).rejects.toThrow(
      "ACP_MCP_TOKEN must be configured",
    );
  });

  it("#244: daemon-owned capacity sensors expose missing and stale observations", async () => {
    const { harness } = await makeDaemonStartHealthy();
    const missing = await harness.cp.doctor.run("capacity");
    expect(missing.findings.map((finding) => finding.code)).toContain(ReasonCode.CAPACITY_SENSOR_FILE_MISSING);

    const stateDir = tempDir("acp-daemon-r2-");
    const probe = vi.spyOn(harness.scripted, "probeCapacity");
    const daemon = new Daemon(harness.cp, { stateDir, capacityRefreshIntervalMs: 1 });
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
