import type * as ChildProcessModule from "node:child_process";
import { spawn, type ChildProcess } from "node:child_process";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { NotificationKind } from "../../src/ceo/production-gate.ts";
import { Daemon } from "../../src/daemon/daemon.ts";
import { ExecutionMode, Role, roleKeyFor } from "../../src/domain/types.ts";
import type { TaskContract } from "../../src/run/run-engine.ts";
import {
  ORPHAN_RELEASE_REPAIR_ID,
  ORPHAN_RESOLVED_EVENT,
  ORPHAN_UNIDENTIFIED_EVENT,
  unresolvedUnidentifiedOrphans,
} from "../../src/run/worker-orphan-release.ts";
import { routeUnreleasedWorkerOrphans } from "../../src/run/worker-orphan-routing.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import { bindCeo, bindWorker, makeHarness, registerFixtureProject, type Harness } from "../helpers/harness.ts";

/**
 * #1189 A2 — a worker launch whose pid was never recorded holds its task from every later worker turn
 * until `release_unidentified_worker_orphan`, which is owner-authorised and stays so. Before this the
 * held task was visible only to a CTO whose next turn was refused, and nobody else was told. Now the
 * doctor names it, and the daemon tells the CEO once per orphan event — with the release's own machine
 * precondition, whether a live process still carries the worker session's id, read at that moment. No
 * release is recorded and nothing about the task changes: the signature stays the owner's.
 */

afterAll(cleanupTempDirs);
const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  processTable.unreadable = false;
});

/** A process-table read that fails the way a sandboxed or overloaded host fails it (EPERM), while set. */
const processTable = vi.hoisted(() => ({ unreadable: false }));
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof ChildProcessModule>();
  const execFileSync = ((file: string, ...rest: unknown[]) => {
    if (processTable.unreadable && file === "/bin/ps") throw Object.assign(new Error("spawnSync /bin/ps EPERM"), { code: "EPERM" });
    return (original.execFileSync as (file: string, ...args: unknown[]) => unknown)(file, ...rest);
  }) as typeof original.execFileSync;
  return { ...original, execFileSync };
});

/** A live process standing in for another executor, or for whatever now holds a pid; killed after each test. */
const live = async (args: string[]): Promise<ChildProcess> => {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)", "--", ...args], { stdio: "ignore" });
  children.push(child);
  await new Promise<void>((resolve, reject) => { child.once("spawn", () => resolve()); child.once("error", reject); });
  return child;
};

const CONTRACT: TaskContract = {
  goal: "held task", why: "held task", scope: [], nonGoals: [], acceptance: ["verify.js exits 0"],
  priority: "NORMAL", humanGate: [], references: [],
};

/** A task an earlier worker turn launched for with no pid recorded, as a restart's reconcile leaves it. */
const heldTask = async (h: Harness) => {
  const { projectId, repositoryId } = await registerFixtureProject(h);
  const created = h.cp.runs.create({
    projectId, executionMode: ExecutionMode.STANDARD, contract: CONTRACT,
    repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
  });
  if (!created.allowed) throw new Error(created.message);
  const run = await h.cp.runs.dispatch(created.value.runId);
  if (!run.allowed) throw new Error(run.message);
  const tasks = h.cp.tasks.submit(run.value.runId, [{ key: "a", title: "work", category: "implementation" }]);
  if (!tasks.allowed) throw new Error(tasks.message);
  const taskId = tasks.value[0]!.taskId;
  const workerSessionId = bindWorker(h, taskId);
  const execution = h.cp.tasks.startExecution({
    runId: run.value.runId, taskId, ownerBindingGeneration: run.value.ownerBindingGeneration!, workerSessionId,
    workerProcessId: null, provider: "scripted", model: "scripted-worker", repositoryId,
  });
  if (!execution.allowed) throw new Error(execution.message);
  const executionId = execution.value.executionId;
  const finished = h.cp.tasks.finishExecution(executionId, { status: "ABANDONED", failureClass: "infrastructure" }, run.value.runId);
  if (!finished.allowed) throw new Error(finished.message);
  const orphan = h.cp.audit.record({
    kind: ORPHAN_UNIDENTIFIED_EVENT, runId: run.value.runId, sessionId: workerSessionId,
    evidence: { executionId, taskId, status: "ABANDONED", pid: null, reexecutionBlocked: true },
  });
  if (!orphan.allowed) throw new Error(orphan.message);
  return { runId: run.value.runId, taskId, executionId, workerSessionId, orphanEventId: orphan.value };
};

const orphanNotices = (h: Harness) =>
  h.cp.db.all<{ message_id: string; run_id: string | null; payload_json: string }>(
    `SELECT message_id, run_id, payload_json FROM outbox
      WHERE kind = 'CEO_NOTIFICATION' AND json_extract(payload_json, '$.notification') = ?
        AND json_extract(payload_json, '$.source') = 'WORKER_ORPHAN_UNRELEASED'
      ORDER BY created_at, rowid`,
    [NotificationKind.CRITICAL_SYSTEM_FAILURE],
  ).map((row) => ({ ...row, payload: JSON.parse(row.payload_json) as Record<string, unknown> }));

describe("#1189 A2: a task an unidentified worker orphan holds", () => {
  it("is named by the doctor, without blocking anything else, until its run ends", async () => {
    const h = makeHarness();
    try {
      const held = await heldTask(h);
      for (const report of [await h.cp.doctor.run("system"), await h.cp.doctor.run("run", held.runId)]) {
        const finding = report.findings.find((f) => f.code === "WORKER_ORPHAN_UNRELEASED");
        expect(finding).toMatchObject({
          severity: "ERROR", blocking: false, scope: `run:${held.runId}`,
          observedEvidence: { taskId: held.taskId, executionId: held.executionId, orphanEventId: held.orphanEventId },
        });
        expect(finding!.recommendedAction).toContain(ORPHAN_RELEASE_REPAIR_ID);
      }
      expect(h.cp.runs.cancel(held.runId, "ended").allowed).toBe(true);
      expect((await h.cp.doctor.run("system")).findings.map((f) => f.code)).not.toContain("WORKER_ORPHAN_UNRELEASED");
    } finally {
      h.cp.close();
    }
  });

  it("is told to the CEO once, with the machine check, and stays held: no release is recorded", async () => {
    const h = makeHarness();
    try {
      bindCeo(h);
      const held = await heldTask(h);
      const first = routeUnreleasedWorkerOrphans(h.cp);
      expect(first).toMatchObject([{ orphanEventId: held.orphanEventId, routing: { allowed: true, value: { state: "ENQUEUED", created: true } } }]);
      expect(routeUnreleasedWorkerOrphans(h.cp)).toMatchObject([{ orphanEventId: held.orphanEventId, routing: {
        allowed: true, value: { state: "ENQUEUED", created: false, messageId: first[0]!.routing.allowed ? first[0]!.routing.value.messageId : null },
      } }]);

      const notices = orphanNotices(h);
      expect(notices).toHaveLength(1);
      expect(notices[0]!.run_id).toBe(held.runId);
      expect(notices[0]!.payload).toMatchObject({
        incidentClass: "RUN_STALLED", correlation: `ceo-incident:RUN_STALLED:${held.runId}`, episode: `worker-orphan:${held.orphanEventId}`,
        taskId: held.taskId, executionId: held.executionId, orphanEventId: held.orphanEventId,
        liveProcessCheck: { result: "NONE_CARRY_THE_WORKER_SESSION", carriers: [] },
        repairOwner: "OWNER",
      });
      expect(String(notices[0]!.payload["recoveryAction"])).toContain(ORPHAN_RELEASE_REPAIR_ID);
      // The notice's delivery record keeps its evidence: nothing in it is a payload the audit log refuses.
      expect(h.cp.audit.byKind("OWNERLESS_STALL_ROUTED").at(-1)!.evidence).toMatchObject({
        notification: NotificationKind.CRITICAL_SYSTEM_FAILURE, source: "WORKER_ORPHAN_UNRELEASED",
        orphanEventId: held.orphanEventId, liveProcessCheck: { result: "NONE_CARRY_THE_WORKER_SESSION" },
      });

      // The release is still the owner's to sign: the orphan still holds the task.
      expect(unresolvedUnidentifiedOrphans(h.cp.db, { taskId: held.taskId })).toHaveLength(1);
      expect(h.cp.audit.byKind(ORPHAN_RESOLVED_EVENT)).toHaveLength(0);
    } finally {
      h.cp.close();
    }
  });

  it("reports a live process that still carries the worker session's id", async () => {
    const h = makeHarness();
    try {
      bindCeo(h);
      const held = await heldTask(h);
      const child = await live(["--session-id", held.workerSessionId]);

      routeUnreleasedWorkerOrphans(h.cp);
      expect(orphanNotices(h)[0]!.payload["liveProcessCheck"]).toEqual({
        result: "LIVE_PROCESS_CARRIES_THE_WORKER_SESSION", carriers: [child.pid],
      });
    } finally {
      h.cp.close();
    }
  });

  it("is routed by the started daemon's watchdog", async () => {
    const h = makeHarness();
    const daemon = new Daemon(h.cp, { stateDir: tempDir("acp-1189-orphan-"), watchdogIntervalMs: 25 });
    try {
      bindCeo(h);
      h.cp.credentials.install({ token: "test-token", creatorIdentity: "acme-bot" });
      const held = await heldTask(h);
      const started = await daemon.start();
      if (!started.allowed) throw new Error(`${started.reasonCode}: ${JSON.stringify(started.evidence)}`);
      const deadline = Date.now() + 10_000;
      while (orphanNotices(h).length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
      expect(orphanNotices(h)).toMatchObject([{ run_id: held.runId, payload: { orphanEventId: held.orphanEventId } }]);
    } finally {
      // Not closed here: a watchdog pass still in flight when the daemon stops writes its own audit row,
      // as the other watchdog tests leave their control plane open for.
      await daemon.stop();
    }
  });
});

describe("#1189 A2, I2-2: the held task is one CEO incident of its run", () => {
  it("delivered and ACKed, the CEO replaced: the task still held reaches the new CEO once, and later passes add nothing", async () => {
    const h = makeHarness();
    try {
      bindCeo(h);
      const held = await heldTask(h);
      routeUnreleasedWorkerOrphans(h.cp);
      const [first] = orphanNotices(h);
      const ceo = h.cp.bindings.active(roleKeyFor(Role.CEO))!;
      expect(h.cp.outbox.acknowledge(first!.message_id, ceo.sessionId, ceo.bindingGeneration).allowed).toBe(true);
      routeUnreleasedWorkerOrphans(h.cp);
      // The CEO that ACKed it is not told again.
      expect(orphanNotices(h)).toHaveLength(1);

      expect(h.cp.bindings.revoke(roleKeyFor(Role.CEO), "CEO runtime lost").allowed).toBe(true);
      const replacement = bindCeo(h);
      routeUnreleasedWorkerOrphans(h.cp);
      routeUnreleasedWorkerOrphans(h.cp);
      const notices = orphanNotices(h);
      expect(notices).toHaveLength(2);
      const second = notices.find((notice) => notice.message_id !== first!.message_id)!;
      expect(second.payload).toMatchObject({
        redelivery: true, orphanEventId: held.orphanEventId,
        correlation: first!.payload["correlation"], episode: first!.payload["episode"],
      });
      expect(h.cp.outbox.get(second.message_id)?.targetSessionId).toBe(replacement);
      // Still the owner's to release.
      expect(h.cp.audit.byKind(ORPHAN_RESOLVED_EVENT)).toHaveLength(0);
    } finally {
      h.cp.close();
    }
  });
});

describe("#1189 A2, CEO ruling 5: what the machine check cannot be mistaken for", () => {
  /** The held task's run also has a task whose worker is live, identified and running. */
  const heldBesideALiveWorker = async (h: Harness) => {
    const { projectId, repositoryId } = await registerFixtureProject(h);
    const created = h.cp.runs.create({
      projectId, executionMode: ExecutionMode.STANDARD, contract: CONTRACT,
      repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
    });
    if (!created.allowed) throw new Error(created.message);
    const run = await h.cp.runs.dispatch(created.value.runId);
    if (!run.allowed) throw new Error(run.message);
    const tasks = h.cp.tasks.submit(run.value.runId, [
      { key: "a", title: "held", category: "implementation" },
      { key: "b", title: "running", category: "implementation" },
    ]);
    if (!tasks.allowed) throw new Error(tasks.message);
    const [held, running] = [tasks.value[0]!.taskId, tasks.value[1]!.taskId];
    const heldSession = bindWorker(h, held);
    const orphaned = h.cp.tasks.startExecution({
      runId: run.value.runId, taskId: held, ownerBindingGeneration: run.value.ownerBindingGeneration!, workerSessionId: heldSession,
      workerProcessId: null, provider: "scripted", model: "scripted-worker", repositoryId,
    });
    if (!orphaned.allowed) throw new Error(orphaned.message);
    const finished = h.cp.tasks.finishExecution(orphaned.value.executionId, { status: "ABANDONED", failureClass: "infrastructure" }, run.value.runId);
    if (!finished.allowed) throw new Error(finished.message);
    const orphan = h.cp.audit.record({
      kind: ORPHAN_UNIDENTIFIED_EVENT, runId: run.value.runId, sessionId: heldSession,
      evidence: { executionId: orphaned.value.executionId, taskId: held, status: "ABANDONED", pid: null, reexecutionBlocked: true },
    });
    if (!orphan.allowed) throw new Error(orphan.message);
    // Another executor: its own session, its own process, recorded and alive.
    const runningSession = bindWorker(h, running);
    const worker = await live(["--session-id", runningSession]);
    const execution = h.cp.tasks.startExecution({
      runId: run.value.runId, taskId: running, ownerBindingGeneration: run.value.ownerBindingGeneration!, workerSessionId: runningSession,
      workerProcessId: worker.pid!, provider: "scripted", model: "scripted-worker", repositoryId,
    });
    if (!execution.allowed) throw new Error(execution.message);
    return { runId: run.value.runId, held, heldSession, running, runningExecution: execution.value.executionId, orphanEventId: orphan.value };
  };

  it("another executor is not read as the orphan: only the held task is named and routed, and the live worker beside it is no carrier", async () => {
    const h = makeHarness();
    try {
      bindCeo(h);
      const fixture = await heldBesideALiveWorker(h);
      // A process whose session id merely begins with the orphan's is another session too.
      await live(["--session-id", `${fixture.heldSession}-other`]);
      routeUnreleasedWorkerOrphans(h.cp);
      expect(orphanNotices(h).map((notice) => notice.payload)).toEqual([expect.objectContaining({
        taskId: fixture.held, orphanEventId: fixture.orphanEventId,
        liveProcessCheck: { result: "NONE_CARRY_THE_WORKER_SESSION", carriers: [] },
      })]);
      const named = (await h.cp.doctor.run("system")).findings.filter((f) => f.code === "WORKER_ORPHAN_UNRELEASED");
      expect(named.map((f) => f.observedEvidence["taskId"])).toEqual([fixture.held]);
      // The other executor's work is untouched, and the held task is still the owner's to release.
      expect(h.cp.db.get<{ status: string }>(`SELECT status FROM task_executions WHERE execution_id = ?`, [fixture.runningExecution]))
        .toEqual({ status: "RUNNING" });
      expect(unresolvedUnidentifiedOrphans(h.cp.db, { taskId: fixture.held })).toHaveLength(1);
      expect(h.cp.audit.byKind(ORPHAN_RESOLVED_EVENT)).toHaveLength(0);
    } finally {
      h.cp.close();
    }
  });

  it("PID reuse: a live process now holding a pid recorded for the worker's session is no carrier; only the session id in a live command line is", async () => {
    const h = makeHarness();
    try {
      bindCeo(h);
      const held = await heldTask(h);
      const reused = await live(["--unrelated"]);
      h.cp.db.run(`UPDATE sessions SET os_pid = ? WHERE session_id = ?`, [reused.pid, held.workerSessionId]);
      routeUnreleasedWorkerOrphans(h.cp);
      expect(orphanNotices(h)[0]!.payload["liveProcessCheck"]).toEqual({ result: "NONE_CARRY_THE_WORKER_SESSION", carriers: [] });
      expect(unresolvedUnidentifiedOrphans(h.cp.db, { taskId: held.taskId })).toHaveLength(1);
      expect(h.cp.audit.byKind(ORPHAN_RESOLVED_EVENT)).toHaveLength(0);
    } finally {
      h.cp.close();
    }
  });

  it("a transient observation failure is UNKNOWN, never 'none', and releases nothing", async () => {
    const h = makeHarness();
    try {
      bindCeo(h);
      const held = await heldTask(h);
      processTable.unreadable = true;
      routeUnreleasedWorkerOrphans(h.cp);
      processTable.unreadable = false;
      const [notice] = orphanNotices(h);
      expect(notice!.payload["liveProcessCheck"]).toEqual({ result: "UNKNOWN", error: expect.stringContaining("EPERM") });
      // A later pass for the same CEO sends nothing more, and nothing about the task changed.
      routeUnreleasedWorkerOrphans(h.cp);
      expect(orphanNotices(h)).toHaveLength(1);
      expect(unresolvedUnidentifiedOrphans(h.cp.db, { taskId: held.taskId })).toHaveLength(1);
      expect(h.cp.audit.byKind(ORPHAN_RESOLVED_EVENT)).toHaveLength(0);
    } finally {
      h.cp.close();
    }
  });
});
