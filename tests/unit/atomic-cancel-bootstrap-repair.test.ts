import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { currentBootstrapPlan } from "../../src/bootstrap/bootstrap-plan.ts";
import { sha256Hex } from "../../src/core/digest.ts";
import type { RepairRequest } from "../../src/doctor/repair.ts";
import { deny } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { RunKind, RunState } from "../../src/domain/types.ts";
import { bootstrapPlan, cleanTreeManifest, reviewBootstrapPlan, submitBootstrapPlan } from "../helpers/bootstrap-plan.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { bindWorkerForTask, dispatchBootstrapRun, makeHarness } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);
afterEach(() => vi.restoreAllMocks());

const fixture = async (review = true, otherTask = false) => {
  const h = makeHarness();
  const created = h.cp.runs.create({ kind: RunKind.PROJECT_BOOTSTRAP, executionMode: "STANDARD", contract: {
    goal: "bootstrap", why: "regression", scope: [], nonGoals: [], acceptance: ["verify"], priority: "NORMAL", humanGate: [], references: [],
  } });
  if (!created.allowed) throw new Error(created.message);
  const runId = created.value.runId;
  await dispatchBootstrapRun(h.cp, h.clock, runId);
  if (otherTask) h.cp.db.run(`INSERT INTO tasks (task_id, run_id, title, category, state, spec_json, created_at, updated_at)
    VALUES ('task_other', ?, 'earlier task', 'implementation', 'CANCELLED', '{}', ?, ?)`,
  [runId, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"]);
  const plan = bootstrapPlan(cleanTreeManifest("prj_cancel_repair"));
  const planDigest = review ? (await reviewBootstrapPlan(h, runId, plan)).planDigest : await submitBootstrapPlan(h, runId, plan);
  const taskId = h.cp.tasks.list(runId).find(task => task.taskId !== "task_other")!.taskId;
  return { ...h, runId, taskId, planDigest };
};

type Fixture = Awaited<ReturnType<typeof fixture>>;
const snapshot = (f: Fixture) => ({
  run: f.cp.runs.require(f.runId), tasks: f.cp.tasks.list(f.runId),
  executions: f.cp.db.all("SELECT * FROM task_executions WHERE run_id = ?", [f.runId]),
  audit: f.cp.audit.forRun(f.runId),
});

describe("atomic run cancel", () => {
  // #1189 B14 — a CEO-review bootstrap may be cancelled now, but not once what its application wrote has
  // landed; that refusal, like every refusal, changes no state and records nothing.
  it("refuses a CEO-review bootstrap cancel whose application is WRITTEN without changing any state or audit", async () => {
    const f = await fixture();
    try {
      reserve(f);
      expect(f.cp.bootstrapApplications.markWritten(f.runId)).toMatchObject({ allowed: true });
      const before = snapshot(f);
      expect(f.cp.runs.cancel(f.runId, "operator cancel")).toMatchObject({
        allowed: false, reasonCode: ReasonCode.BOOTSTRAP_APPLICATION_IN_PROGRESS, evidence: { classification: "APPLIED" },
      });
      expect(snapshot(f)).toEqual(before);
      expect(f.cp.tasks.require(f.taskId).state).toBe("READY");
      expect(f.cp.audit.byKind("TASK_GRAPH_CANCELLED")).toEqual([]);
      expect(f.cp.bootstrapApplications.get(f.runId)).toMatchObject({ phase: "WRITTEN" });
    } finally { f.cp.close(); }
  });

  it("cancels a CEO-review bootstrap with no application: its graph and the run, in one transaction", async () => {
    const f = await fixture();
    try {
      expect(f.cp.runs.cancel(f.runId, "operator cancel")).toMatchObject({ allowed: true, value: { state: RunState.CANCELLED } });
      expect(f.cp.tasks.require(f.taskId).state).toBe("CANCELLED");
      expect(f.cp.audit.byKind("TASK_GRAPH_CANCELLED")).toHaveLength(1);
    } finally { f.cp.close(); }
  });

  it("legally cancels the whole graph and transitions the run", async () => {
    const f = await fixture(false);
    try {
      expect(f.cp.tasks.submit(f.runId, [
        { key: "one", title: "first", category: "implementation" },
        { key: "two", title: "second", category: "implementation", dependsOn: ["one"] },
      ]).allowed).toBe(true);
      const running = f.cp.tasks.ready(f.runId)[0]!;
      const worker = bindWorkerForTask(f.cp, running.taskId);
      expect(f.cp.tasks.startExecution({ runId: f.runId, taskId: running.taskId, workerSessionId: worker,
        ownerBindingGeneration: f.cp.runs.require(f.runId).ownerBindingGeneration!, provider: "scripted", model: "scripted-worker" }).allowed).toBe(true);
      expect(f.cp.runs.cancel(f.runId, "operator cancel")).toMatchObject({ allowed: true, value: { state: RunState.CANCELLED } });
      expect(f.cp.db.all<{ status: string }>("SELECT status FROM task_executions WHERE run_id = ?", [f.runId])).toEqual([{ status: "ABANDONED" }]);
      expect(f.cp.tasks.list(f.runId).every(task => task.state === "CANCELLED")).toBe(true);
      expect(f.cp.audit.byKind("TASK_GRAPH_CANCELLED")).toHaveLength(1);
    } finally { f.cp.close(); }
  });

  it.each(["throw", "deny"])("rolls back graph and audit when transition fails by %s after task cancellation", async failure => {
    const f = await fixture(false);
    try {
      insertExecution(f, "RUNNING");
      f.cp.db.run("UPDATE tasks SET state = 'RUNNING' WHERE task_id = ?", [f.taskId]);
      const before = snapshot(f);
      vi.spyOn(f.cp.runs, "transition").mockImplementation(() => {
        expect(f.cp.tasks.require(f.taskId).state).toBe("CANCELLED");
        if (failure === "throw") throw new Error("injected transition failure");
        return deny(ReasonCode.RUN_TRANSITION_ILLEGAL, "injected refusal");
      });
      if (failure === "throw") expect(() => f.cp.runs.cancel(f.runId, "operator cancel")).toThrow("injected transition failure");
      else expect(f.cp.runs.cancel(f.runId, "operator cancel")).toMatchObject({ allowed: false });
      expect(snapshot(f)).toEqual(before);
    } finally { f.cp.close(); }
  });
});

const repairId = "restore_refused_cancel_bootstrap_task";
const cancelReason = "operator cancel — 취소";
const cancelReasonSha256 = sha256Hex(cancelReason);
const request = (f: Fixture, dryRun = false): RepairRequest => ({
  operationId: repairId, parameters: { runId: f.runId, taskId: f.taskId, cancelReasonSha256 }, authorizedBy: "HERMES", dryRun,
});

/** The frozen application a bootstrap CONFIRM reserves, written through the application record's own API. */
const reserve = (f: Fixture): void => {
  const plan = currentBootstrapPlan(f.runId, f.cp.artifacts.latest(f.runId, "PLAN"));
  if (!plan.allowed) throw new Error(plan.message);
  const candidate = f.cp.runs.currentCandidate(f.runId)!;
  expect(f.cp.bootstrapApplications.reserve({
    runId: f.runId, projectId: "prj_cancel_repair", repositoryIdentity: "github:acme/fixture",
    bootstrapOperationId: "op-bootstrap", planDigest: f.planDigest,
    manifestDigest: plan.value.binding.projectManifestDigest, plannedOutputsDigest: plan.value.binding.plannedOutputsDigest,
    candidateSnapshotDigest: candidate, reviewDigest: "sha256:review", approvalDigest: "sha256:scope",
  }, { writer: null })).toMatchObject({ allowed: true });
};

const damaged = async (auditChanges: number | null = 1, otherTask = false) => {
  const f = await fixture(true, otherTask);
  reserve(f);
  f.clock.advance(1000);
  // The pre-fix path: committed task cancellation followed by a refused run transition.
  if (auditChanges === 1) f.cp.tasks.cancelAll(f.runId, cancelReason);
  else {
    f.cp.db.run("UPDATE tasks SET state = 'CANCELLED', updated_at = ? WHERE task_id = ?", [f.clock.nowIso(), f.taskId]);
    if (auditChanges !== null) f.cp.audit.record({ kind: "TASK_GRAPH_CANCELLED", runId: f.runId, evidence: { reason: cancelReason, changes: auditChanges } });
  }
  // The pre-fix build then refused the run's transition (a CEO-review run had no CANCELLED edge), so the
  // run stayed at CEO review with its task cancelled. #1189 B14 opened that edge; the damage it left stays.
  expect(f.cp.runs.require(f.runId).state).toBe(RunState.READY_FOR_CEO_REVIEW);
  return f;
};

const unchangedRows = (f: Fixture) => ({
  ...snapshot(f), audit: undefined,
  artifacts: f.cp.artifacts.list(f.runId),
  application: f.cp.bootstrapApplications.get(f.runId),
  bindings: f.cp.db.all("SELECT * FROM assignments"),
});

const updateOtherTask = (f: Fixture, state: string, at = f.clock.nowIso()) => {
  f.cp.db.run("UPDATE tasks SET state = ?, updated_at = ? WHERE task_id = 'task_other'", [state, at]);
};

const insertExecution = (f: Fixture, status = "FAILED") => {
  const worker = bindWorkerForTask(f.cp, f.taskId);
  f.cp.db.run(`INSERT INTO task_executions
    (execution_id, run_id, task_id, attempt, owner_binding_generation, worker_session_id, provider, model, started_at, status)
    VALUES ('execution_damage', ?, ?, 1, ?, ?, 'gpt', 'fixture', ?, ?)`,
  [f.runId, f.taskId, f.cp.runs.require(f.runId).ownerBindingGeneration, worker, f.clock.nowIso(), status]);
};

describe("restore_refused_cancel_bootstrap_task", () => {
  it("dry-runs every check, restores exactly the frozen task, passes the CONFIRM task gate, then makes no change on repeat", async () => {
    const f = await damaged();
    try {
      expect(f.cp.repair.catalog().find(op => op.id === repairId)).toMatchObject({ authorization: "HERMES" });
      expect(f.cp.tasks.bootstrapReviewEntry(f.runId, f.planDigest)).toMatchObject({
        allowed: false, reasonCode: ReasonCode.TASK_RESULT_COUNT_MISMATCH, evidence: { refusal: "BOOTSTRAP_PLAN_TASK_COUNT" },
      });
      const before = unchangedRows(f);
      const dry = await f.cp.repair.execute(request(f, true));
      expect(dry, JSON.stringify(dry)).toMatchObject({ allowed: true, value: { dryRun: true, changes: 1 } });
      if (!dry.allowed) throw new Error(dry.message);
      expect(dry.value.preconditionsChecked).toHaveLength(12);
      expect(dry.value.preconditionsChecked).toEqual(expect.arrayContaining([
        expect.objectContaining({ precondition: "CANCEL_REASON_DIGEST", satisfied: true,
          evidence: { expected: cancelReasonSha256, observedDigest: cancelReasonSha256 } }),
        expect.objectContaining({ precondition: "NO_LATER_TASK_CHANGE", satisfied: true }),
      ]));
      expect(JSON.stringify(dry)).not.toContain(cancelReason);
      expect(JSON.stringify(f.cp.audit.byKind("REPAIR_DRY_RUN"))).not.toContain(cancelReason);
      expect(dry.value.preconditionsChecked.every(check => check.satisfied)).toBe(true);
      expect(f.cp.audit.byKind("REPAIR_DRY_RUN")[0]!.evidence["target"]).toMatchObject({
        runId: f.runId, taskId: f.taskId, from: "CANCELLED", to: "READY", planDigest: f.planDigest,
      });
      expect({ ...unchangedRows(f), artifacts: before.artifacts }).toEqual(before);
      f.clock.advance(1000);
      expect(await f.cp.repair.execute(request(f))).toMatchObject({ allowed: true, value: { changes: 1 } });
      expect(JSON.stringify(f.cp.audit.byKind("REPAIR_EXECUTED"))).not.toContain(cancelReason);
      expect(f.cp.tasks.require(f.taskId).state).toBe("READY");
      expect(f.cp.tasks.bootstrapReviewEntry(f.runId, f.planDigest)).toMatchObject({ allowed: true, value: { taskId: f.taskId } });
      const restored = unchangedRows(f);
      expect(restored.run).toEqual(before.run);
      expect(restored.application).toEqual(before.application);
      expect(restored.bindings).toEqual(before.bindings);
      expect(restored.artifacts.filter(a => a.kind !== "REPAIR_RECEIPT")).toEqual(before.artifacts);
      f.clock.advance(1000);
      expect(await f.cp.repair.execute(request(f))).toMatchObject({ allowed: true, value: { changes: 0 } });
      expect(f.cp.tasks.list(f.runId)).toEqual(restored.tasks);
    } finally { f.cp.close(); }
  });

  it.each([undefined, "0".repeat(64), cancelReasonSha256.toUpperCase(), `sha256:${cancelReasonSha256}`])(
    "refuses a missing, wrong or malformed cancel reason digest (%s)", async digest => {
      const f = await damaged();
      try {
        const req = request(f);
        if (digest === undefined) delete req.parameters["cancelReasonSha256"];
        else req.parameters["cancelReasonSha256"] = digest;
        const before = unchangedRows(f);
        for (const dryRun of [true, false]) {
          const result = await f.cp.repair.execute({ ...req, dryRun });
          expect(result).toMatchObject({ allowed: false, reasonCode: ReasonCode.REPAIR_PRECONDITION_UNMET,
            evidence: { refusal: digest === "0".repeat(64) ? "CANCEL_REASON_DIGEST" : "EXACT_PARAMETERS" } });
          expect(unchangedRows(f)).toEqual(before);
          expect(JSON.stringify(result)).not.toContain(cancelReason);
        }
        expect(JSON.stringify(f.cp.audit.byKind("REPAIR_REFUSED"))).not.toContain(cancelReason);
      } finally { f.cp.close(); }
    },
  );

  it.each(["TASK_STATE_CHANGED", "BOOTSTRAP_TASK_UPDATED", "CUSTOM_TASK_OBSERVED", "nested task reference"])(
    "refuses a later audit naming the task: %s, even at the same instant", async kind => {
      const f = await damaged();
      try {
        const evidence = kind === "nested task reference"
          ? { target: { taskIds: [f.taskId] }, reason: cancelReason }
          : { taskId: f.taskId, reason: cancelReason };
        expect(f.cp.audit.record({ kind, runId: f.runId, evidence }).allowed).toBe(true);
        const before = unchangedRows(f);
        for (const dryRun of [true, false]) {
          const result = await f.cp.repair.execute(request(f, dryRun));
          expect(result).toMatchObject({ allowed: false, evidence: { refusal: "NO_LATER_TASK_CHANGE" } });
          expect(unchangedRows(f)).toEqual(before);
          expect(JSON.stringify(result)).not.toContain(cancelReason);
        }
        expect(JSON.stringify(f.cp.audit.byKind("REPAIR_REFUSED"))).not.toContain(cancelReason);
      } finally { f.cp.close(); }
    },
  );

  it("refuses a task changed and returned to CANCELLED after the cancellation", async () => {
    const f = await damaged();
    try {
      f.clock.advance(1000);
      f.cp.db.run("UPDATE tasks SET state = 'READY', updated_at = ? WHERE task_id = ?", [f.clock.nowIso(), f.taskId]);
      f.clock.advance(1000);
      f.cp.db.run("UPDATE tasks SET state = 'CANCELLED', updated_at = ? WHERE task_id = ?", [f.clock.nowIso(), f.taskId]);
      const before = unchangedRows(f);
      for (const dryRun of [true, false]) {
        expect(await f.cp.repair.execute(request(f, dryRun))).toMatchObject({ allowed: false });
        expect(unchangedRows(f)).toEqual(before);
      }
    } finally { f.cp.close(); }
  });

  it("refuses a repeat after a later audit names the restored task", async () => {
    const f = await damaged();
    try {
      expect(await f.cp.repair.execute(request(f))).toMatchObject({ allowed: true, value: { changes: 1 } });
      f.clock.advance(1000);
      expect(f.cp.audit.record({ kind: "TASK_UPDATED", runId: f.runId, evidence: { taskId: f.taskId } }).allowed).toBe(true);
      const before = unchangedRows(f);
      expect(await f.cp.repair.execute(request(f))).toMatchObject({ allowed: false, evidence: { refusal: "NO_LATER_TASK_CHANGE" } });
      expect(unchangedRows(f)).toEqual(before);
    } finally { f.cp.close(); }
  });

  const refusals: Array<{ name: string; reason: string; alter: (f: Fixture) => void; changes?: number | null }> = [
    { name: "wrong task", reason: "LATEST_PLAN_TASK", alter: f => updateOtherTask(f, "CANCELLED", "2026-01-01T00:00:00.000Z") },
    { name: "task with an execution", reason: "CANCELLED_UNEXECUTED_TASK", alter: f => insertExecution(f) },
    { name: "another live task", reason: "NO_OTHER_LIVE_TASK", alter: f => updateOtherTask(f, "READY") },
    { name: "CANCELLED run", reason: "NON_TERMINAL_BOOTSTRAP_RUN", alter: f => {
      expect(f.cp.runs.transition(f.runId, RunState.AWAITING_HUMAN, "fixture").allowed).toBe(true);
      expect(f.cp.runs.cancel(f.runId, "legal later cancellation").allowed).toBe(true);
    } },
    { name: "FAILED run", reason: "NON_TERMINAL_BOOTSTRAP_RUN", alter: f => {
      expect(f.cp.runs.transition(f.runId, RunState.AWAITING_HUMAN, "fixture").allowed).toBe(true);
      expect(f.cp.runs.transition(f.runId, RunState.FAILED, "fixture").allowed).toBe(true);
    } },
    { name: "application not RESERVED", reason: "RESERVED_APPLICATION", alter: f => {
      expect(f.cp.bootstrapApplications.markStranded(f.runId, { cause: "fixture", requiredRecovery: "fixture", evidence: {} }).allowed).toBe(true);
    } },
    { name: "changes greater than one", reason: "SINGLE_CANCEL_CAUSE", changes: 2, alter: () => {} },
    { name: "missing cancellation audit", reason: "SINGLE_CANCEL_CAUSE", changes: null, alter: () => {} },
    { name: "CANCELLED transition audit", reason: "NO_CANCELLED_RUN_TRANSITION", alter: f => {
      f.cp.audit.record({ kind: "RUN_TRANSITION", runId: f.runId, evidence: { from: "ACTIVE", to: "CANCELLED" } });
    } },
    ...["BOOTSTRAP_TASKS_SUPERSEDED", "TASK_GRAPH_SUBMITTED", "BOOTSTRAP_PLAN_TASKS"].map(kind => ({
      name: `newer ${kind}`, reason: kind === "BOOTSTRAP_PLAN_TASKS" ? "LATEST_PLAN_TASK" : "NO_NEWER_TASK_GRAPH",
      alter: (f: Fixture) => { f.cp.audit.record({ kind, runId: f.runId, evidence: { planDigest: "sha256:new", taskIds: ["task_new"] } }); },
    })),
    { name: "newer PLAN", reason: "CURRENT_PLAN_BINDING", alter: f => { f.cp.artifacts.put(f.runId, "PLAN", { newer: true }); } },
    { name: "another cancelled task at the same instant", reason: "SINGLE_CANCEL_CAUSE", alter: f => updateOtherTask(f, "CANCELLED") },
    { name: "ambiguous cancellation audits", reason: "SINGLE_CANCEL_CAUSE", alter: f => {
      f.cp.audit.record({ kind: "TASK_GRAPH_CANCELLED", runId: f.runId, evidence: { changes: 1 } });
    } },
    { name: "task timestamp does not match cancellation", reason: "SINGLE_CANCEL_CAUSE", alter: f => {
      f.cp.db.run("UPDATE tasks SET updated_at = ? WHERE task_id = ?", ["2026-01-01T00:00:00.000Z", f.taskId]);
    } },
  ];
  it.each(refusals)("refuses $name without changing domain rows", async ({ name, reason, alter, changes }) => {
    const f = await damaged(changes === undefined ? 1 : changes, ["wrong task", "another live task", "another cancelled task at the same instant"].includes(name));
    try {
      alter(f);
      const req = request(f);
      if (name === "wrong task") req.parameters["taskId"] = "task_other";
      const before = unchangedRows(f);
      for (const dryRun of [true, false]) {
        const result = await f.cp.repair.execute({ ...req, dryRun });
        expect(result, JSON.stringify(result)).toMatchObject({
          allowed: false, reasonCode: ReasonCode.REPAIR_PRECONDITION_UNMET, evidence: { refusal: reason },
        });
        expect(unchangedRows(f)).toEqual(before);
        expect(result.evidence["preconditions"]).toHaveLength(12);
      }
    } finally { f.cp.close(); }
  });

  it("allows AWAITING_HUMAN while preserving its run state and hold", async () => {
    const f = await damaged();
    try {
      expect(f.cp.runs.transition(f.runId, RunState.AWAITING_HUMAN, "operator attention").allowed).toBe(true);
      const before = f.cp.runs.require(f.runId);
      expect(await f.cp.repair.execute(request(f))).toMatchObject({ allowed: true, value: { changes: 1 } });
      expect(f.cp.runs.require(f.runId)).toEqual(before);
    } finally { f.cp.close(); }
  });

  it("recognizes a repeat when task write and receipt use different clock instants", async () => {
    const f = await damaged();
    try {
      const now = f.clock.nowIso.bind(f.clock);
      vi.spyOn(f.clock, "nowIso").mockImplementation(() => {
        const at = now();
        f.clock.advance(1);
        return at;
      });
      expect(await f.cp.repair.execute(request(f))).toMatchObject({ allowed: true, value: { changes: 1 } });
      const restored = f.cp.tasks.require(f.taskId);
      expect(restored.updatedAt).not.toBe(f.cp.audit.byKind("REPAIR_EXECUTED")[0]!.at);
      expect(await f.cp.repair.execute(request(f))).toMatchObject({ allowed: true, value: { changes: 0 } });
      expect(f.cp.tasks.require(f.taskId)).toEqual(restored);
    } finally { f.cp.close(); }
  });

  it("rolls back the restoration and receipt if its audit fails", async () => {
    const f = await damaged();
    try {
      const before = unchangedRows(f);
      const record = f.cp.audit.record.bind(f.cp.audit);
      vi.spyOn(f.cp.audit, "record").mockImplementation(entry => {
        if (entry.kind === "REPAIR_EXECUTED") throw new Error("injected repair audit failure");
        return record(entry);
      });
      await expect(f.cp.repair.execute(request(f))).rejects.toThrow("injected repair audit failure");
      expect(unchangedRows(f)).toEqual(before);
    } finally { f.cp.close(); }
  });
});
