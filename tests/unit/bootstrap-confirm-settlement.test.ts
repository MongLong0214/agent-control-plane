import { acknowledgeBootstrapHandoff } from "../helpers/bootstrap-handoff-ack.ts";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { digestOf } from "../../src/core/digest.ts";
import { deny } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import type { ProjectManifest } from "../../src/contracts/manifest.ts";
import { ExecutionMode, RunState } from "../../src/domain/types.ts";
import type { RepoFactoryResult } from "../../src/bootstrap/repo-factory-result.ts";
import { bootstrapPlan, cleanTreeManifest } from "../helpers/bootstrap-plan.ts";
import { ownerApprovalFor, type PreparedBootstrapRun, prepareBootstrapRun, writesOf } from "../helpers/bootstrap-runner.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import { bindWorker, registerFixtureProject } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);
afterEach(() => vi.restoreAllMocks());

/**
 * CEO 1792120507 / 1792120860 — a project-less bootstrap's execution task is settled only inside the
 * CEO CONFIRM transaction, from the producer's stored create receipt and the activation result that
 * transaction writes, bound to the run, its current PLAN, the create operation and that one task. The
 * GitHub write cannot be rolled back: when activation or settlement fails after it, the receipt stays,
 * nothing is sent again, nothing reads COMPLETED, and the existing CONFIRM retry finishes the run.
 */

type Operation = PreparedBootstrapRun["ops"][number];

const IDENTITY = "github:acme/fixture";
const CREATE_OPERATION = "create-repository:fixture";

const createOnlyOperations = (): Operation[] => [
  { operationId: CREATE_OPERATION, resourceType: "repository", resourceIdentity: IDENTITY, desiredState: { visibility: "public", autoInit: true } },
] as Operation[];

const manifestFor = (projectId: string): ProjectManifest => {
  const base = cleanTreeManifest(projectId);
  return { ...base, branchProfile: { ...base.branchProfile, defaultBranch: "main" } };
};

const prepare = (projectId: string, options: { earlierPlan?: Record<string, unknown> } = {}) =>
  prepareBootstrapRun(projectId, { ops: createOnlyOperations(), manifest: manifestFor(projectId), ...options });

/** produce under the owner's approval, acknowledge the activation handoff, activate again: WRITTEN and ready to CONFIRM. */
const produceAndActivate = async (prepared: PreparedBootstrapRun) => {
  const { harness } = prepared;
  const input = { ...prepared.input, ownerApproval: ownerApprovalFor(prepared) };
  const first = await prepared.runner.produceAndActivate(input);
  expect(first).toMatchObject({ allowed: false, reasonCode: ReasonCode.BOOTSTRAP_ACTIVATION_INCOMPLETE });
  const primary = harness.cp.bindings.activePrimaryCto(prepared.manifest.projectId)!;
  expect((await acknowledgeBootstrapHandoff(harness, first.evidence["pendingHandoffId"] as string, primary.sessionId)).allowed).toBe(true);
  const second = await prepared.runner.produceAndActivate(input);
  expect(second, JSON.stringify(second)).toMatchObject({ allowed: true });
  await harness.cp.continuity.evaluate("bootstrap confirmation");
  return input;
};

const confirm = (prepared: PreparedBootstrapRun) =>
  prepared.harness.cp.ceo.submitCeoDecision({
    runId: prepared.runId,
    decision: "CONFIRM",
    candidateSnapshotDigest: prepared.snapshotDigest,
    ceoSessionId: prepared.ceoSessionId,
    rationale: "apply the bootstrap",
  });

/** The CONFIRM the existing recovery path makes: the runner again (a WRITTEN application resumes), then the decision. */
const confirmAgain = async (prepared: PreparedBootstrapRun, input: PreparedBootstrapRun["input"]) => {
  const resumed = await prepared.runner.produceAndActivate(input);
  expect(resumed, JSON.stringify(resumed)).toMatchObject({ allowed: true });
  return confirm(prepared);
};

const tasks = (prepared: PreparedBootstrapRun) =>
  prepared.harness.cp.tasks.list(prepared.runId).map((task) => ({ taskId: task.taskId, state: task.state }));

const settlements = (prepared: PreparedBootstrapRun) =>
  prepared.harness.cp.audit.byKind("BOOTSTRAP_TASK_SETTLED").filter((row) => row.runId === prepared.runId).map((row) => row.evidence);

const stored = (prepared: PreparedBootstrapRun, kind: "REPO_FACTORY_RESULT" | "BOOTSTRAP_ACTIVATION_RESULT") =>
  prepared.harness.cp.artifacts.latest<Record<string, unknown>>(prepared.runId, kind);

/** Nothing reads COMPLETED and nothing is settled; the producer's receipt and WRITTEN application are kept. */
const notCompleted = (prepared: PreparedBootstrapRun, receiptDigest: string) => {
  const { harness, runId } = prepared;
  expect(harness.cp.runs.require(runId).state).toBe(RunState.READY_FOR_CEO_REVIEW);
  expect(tasks(prepared).map((task) => task.state)).toEqual(["READY"]);
  expect(settlements(prepared)).toEqual([]);
  expect(stored(prepared, "REPO_FACTORY_RESULT")?.digest).toBe(receiptDigest);
  expect(harness.cp.bootstrapApplications.get(runId)?.phase).toBe("WRITTEN");
  expect(stored(prepared, "BOOTSTRAP_ACTIVATION_RESULT")).toBeNull();
};

describe("W4: CONFIRM settles the current PLAN's task from the real create receipt and the activation result", () => {
  it("the task is SUCCEEDED in the CONFIRM transaction, its audit binds run, PLAN, operation, task and both digests, and the run COMPLETES", async () => {
    const prepared = await prepare("brs-settle");
    expect(tasks(prepared).map((task) => task.state)).toEqual(["READY"]);
    const [task] = tasks(prepared);
    await produceAndActivate(prepared);
    expect(tasks(prepared).map((row) => row.state)).toEqual(["READY"]);
    expect(confirm(prepared)).toMatchObject({ allowed: true, value: { state: RunState.COMPLETED } });
    expect(tasks(prepared)).toEqual([{ taskId: task!.taskId, state: "SUCCEEDED" }]);
    const factory = stored(prepared, "REPO_FACTORY_RESULT")!;
    const receipt = (factory.content as unknown as RepoFactoryResult).externalWriteReceipts.find((row) => row.operationId === CREATE_OPERATION)!;
    expect(settlements(prepared)).toEqual([{
      taskId: task!.taskId,
      planDigest: prepared.planDigest,
      operationId: CREATE_OPERATION,
      repoFactoryResultDigest: factory.digest,
      createReceiptDigest: digestOf(receipt),
      activationResultDigest: stored(prepared, "BOOTSTRAP_ACTIVATION_RESULT")!.digest,
      candidateSnapshotDigest: prepared.snapshotDigest,
    }]);
    expect(prepared.harness.cp.tasks.completeness(prepared.runId)).toMatchObject({ allowed: true, value: { tasks: 1, succeeded: 1 } });
    expect(prepared.github.createRequests).toHaveLength(1);
  });

  it("a producer refusal leaves the task READY and the run at CEO review", async () => {
    const prepared = await prepare("brs-producer-refusal");
    prepared.github.failNext = "createRepository";
    const refused = await prepared.runner.produceAndActivate(prepared.input);
    expect(refused.allowed).toBe(false);
    expect(confirm(prepared).allowed).toBe(false);
    expect(prepared.harness.cp.runs.require(prepared.runId).state).toBe(RunState.READY_FOR_CEO_REVIEW);
    expect(tasks(prepared).map((task) => task.state)).toEqual(["READY"]);
    expect(settlements(prepared)).toEqual([]);
    expect(prepared.github.createRequests).toHaveLength(1);
    expect(prepared.github.repository("acme", "fixture")).toBeUndefined();
  });
});

describe("CEO 1792120860 (2): a failure after the create keeps the receipt, sends nothing again and completes nothing", () => {
  for (const failure of ["activation", "settlement", "completion"] as const) {
    it(`an injected ${failure} failure: GitHub create count stays 1, the receipt is preserved, nothing COMPLETED or SUCCEEDED; the existing CONFIRM retry completes it with no re-send`, async () => {
      const prepared = await prepare(`brs-${failure}-failure`);
      const input = await produceAndActivate(prepared);
      expect(prepared.github.createRequests).toHaveLength(1);
      const writes = writesOf(prepared.github);
      const receiptDigest = stored(prepared, "REPO_FACTORY_RESULT")!.digest;
      if (failure === "activation") {
        vi.spyOn(prepared.harness.cp.bootstrap, "finalizeBootstrapActivationConfirm")
          .mockReturnValueOnce(deny(ReasonCode.BOOTSTRAP_ACTIVATION_INCOMPLETE, "injected activation failure", {}));
      } else if (failure === "settlement") {
        vi.spyOn(prepared.harness.cp.tasks, "settleBootstrapExecutionTask")
          .mockReturnValueOnce(deny(ReasonCode.EVIDENCE_STALE, "injected settlement failure", {}));
      } else {
        // After the settlement: the run's COMPLETED transition itself is refused once.
        const runs = prepared.harness.cp.runs;
        const transition = runs.transition.bind(runs);
        let refused = false;
        vi.spyOn(runs, "transition").mockImplementation((...args: Parameters<typeof runs.transition>) => {
          if (!refused && args[1] === RunState.COMPLETED) {
            refused = true;
            return deny(ReasonCode.RUN_TRANSITION_ILLEGAL, "injected completion failure", {});
          }
          return transition(...args);
        });
      }
      expect(confirm(prepared)).toMatchObject({ allowed: false });
      notCompleted(prepared, receiptDigest);
      expect(prepared.github.createRequests).toHaveLength(1);
      expect(writesOf(prepared.github)).toEqual(writes);

      expect(await confirmAgain(prepared, input)).toMatchObject({ allowed: true, value: { state: RunState.COMPLETED } });
      expect(tasks(prepared).map((task) => task.state)).toEqual(["SUCCEEDED"]);
      expect(settlements(prepared)).toHaveLength(1);
      expect(stored(prepared, "REPO_FACTORY_RESULT")!.digest).toBe(receiptDigest);
      expect(prepared.github.createRequests).toHaveLength(1);
      expect(writesOf(prepared.github)).toEqual(writes);
    });
  }
});

describe("W5: a RUNNING execution at CONFIRM is refused and the whole transaction rolls back", () => {
  it("no COMPLETED, no activation result, no settlement, the application stays WRITTEN and the execution is left as found", async () => {
    const prepared = await prepare("brs-running");
    await produceAndActivate(prepared);
    const receiptDigest = stored(prepared, "REPO_FACTORY_RESULT")!.digest;
    const [task] = tasks(prepared);
    const run = prepared.harness.cp.runs.require(prepared.runId);
    const started = prepared.harness.cp.tasks.startExecution({
      runId: prepared.runId,
      taskId: task!.taskId,
      ownerBindingGeneration: run.ownerBindingGeneration!,
      workerSessionId: bindWorker(prepared.harness, task!.taskId),
      provider: "scripted",
      model: "scripted-worker",
    });
    expect(started.allowed, JSON.stringify(started)).toBe(true);
    expect(confirm(prepared)).toMatchObject({ allowed: false });
    expect(prepared.harness.cp.runs.require(prepared.runId).state).toBe(RunState.READY_FOR_CEO_REVIEW);
    expect(tasks(prepared).map((row) => row.state)).toEqual(["RUNNING"]);
    expect(settlements(prepared)).toEqual([]);
    expect(stored(prepared, "BOOTSTRAP_ACTIVATION_RESULT")).toBeNull();
    expect(stored(prepared, "REPO_FACTORY_RESULT")!.digest).toBe(receiptDigest);
    expect(prepared.harness.cp.bootstrapApplications.get(prepared.runId)?.phase).toBe("WRITTEN");
  });
});

describe("W6: a re-plan cancels the superseded PLAN's unexecuted READY task, and CONFIRM settles only the current one", () => {
  it("the earlier task is CANCELLED 'superseded by PLAN <digest>' in the replan; CONFIRM settles exactly the current PLAN's task", async () => {
    const earlier = bootstrapPlan(manifestFor("brs-replan"), { operations: createOnlyOperations(), summary: "the first plan" });
    const prepared = await prepare("brs-replan", { earlierPlan: earlier });
    const rows = tasks(prepared);
    expect(rows.map((row) => row.state)).toEqual(["CANCELLED", "READY"]);
    const superseded = prepared.harness.cp.audit.byKind("BOOTSTRAP_TASKS_SUPERSEDED").filter((row) => row.runId === prepared.runId);
    expect(superseded.map((row) => row.evidence)).toEqual([{
      planDigest: prepared.planDigest,
      reason: `superseded by PLAN ${prepared.planDigest}`,
      cancelled: [rows[0]!.taskId],
      left: [],
    }]);
    await produceAndActivate(prepared);
    expect(confirm(prepared)).toMatchObject({ allowed: true, value: { state: RunState.COMPLETED } });
    expect(tasks(prepared)).toEqual([{ taskId: rows[0]!.taskId, state: "CANCELLED" }, { taskId: rows[1]!.taskId, state: "SUCCEEDED" }]);
    expect(settlements(prepared).map((row) => row["taskId"])).toEqual([rows[1]!.taskId]);
  });
});

describe("W9: the settlement write is refused off its one path", () => {
  it("refused outside a transaction, outside CONFIRM, for another run kind, without both digests, with unbound evidence, a stale PLAN or candidate, or a non-READY task; the task stays READY", async () => {
    const earlier = bootstrapPlan(manifestFor("brs-guards"), { operations: createOnlyOperations(), summary: "the first plan" });
    const prepared = await prepare("brs-guards", { earlierPlan: earlier });
    const { harness, runId } = prepared;
    await produceAndActivate(prepared);
    const [cancelled, task] = tasks(prepared);
    const good = {
      runId,
      taskId: task!.taskId,
      planDigest: prepared.planDigest,
      operationId: CREATE_OPERATION,
      candidateSnapshotDigest: prepared.snapshotDigest,
      repoFactoryResultDigest: stored(prepared, "REPO_FACTORY_RESULT")!.digest,
      activationResultDigest: "",
    };
    const refusal = (decision: { allowed: boolean; evidence?: Record<string, unknown> }) =>
      decision.allowed ? "ALLOWED" : String(decision.evidence?.["refusal"]);

    // Outside any transaction, and inside one that is not the CONFIRM's (no activation result).
    expect(refusal(harness.cp.tasks.settleBootstrapExecutionTask({ ...good, activationResultDigest: "sha256:any" }))).toBe("OUTSIDE_CONFIRM_TRANSACTION");
    let notConfirm = "";
    harness.cp.db.txDecision(() => {
      notConfirm = refusal(harness.cp.tasks.settleBootstrapExecutionTask({ ...good, activationResultDigest: "sha256:any" }));
      return deny(ReasonCode.CONFLICT, "roll back", {});
    });
    expect(notConfirm).toBe("ACTIVATION_RESULT_NOT_BOUND");

    // Inside a transaction shaped like the CONFIRM's: the finalizer's activation result is there.
    const { projectId, repositoryId } = await registerFixtureProject(harness, "brs-standard", {}, { identity: "github:acme/brs-standard" });
    const standard = harness.cp.runs.create({
      projectId,
      executionMode: ExecutionMode.STANDARD,
      contract: { goal: "g", why: "w", scope: [], nonGoals: [], acceptance: ["a"], priority: "NORMAL", humanGate: [], references: [] },
      repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
    });
    if (!standard.allowed) throw new Error(standard.message);
    const answers: Record<string, string> = {};
    harness.cp.db.txDecision(() => {
      const finalized = harness.cp.bootstrap.finalizeBootstrapActivationConfirm({
        runId,
        candidateSnapshotDigest: prepared.snapshotDigest,
        ceoSessionId: prepared.ceoSessionId,
        confirmedAt: harness.clock.nowIso(),
      });
      expect(finalized, JSON.stringify(finalized)).toMatchObject({ allowed: true });
      const activationResultDigest = stored(prepared, "BOOTSTRAP_ACTIVATION_RESULT")!.digest;
      const settle = (overrides: Partial<typeof good>) =>
        refusal(harness.cp.tasks.settleBootstrapExecutionTask({ ...good, activationResultDigest, ...overrides }));
      answers["otherKind"] = settle({ runId: standard.value.runId });
      answers["noReceiptDigest"] = settle({ repoFactoryResultDigest: "" });
      answers["noActivationDigest"] = settle({ activationResultDigest: "" });
      answers["otherReceipt"] = settle({ repoFactoryResultDigest: "sha256:not-the-stored-result" });
      answers["otherActivation"] = settle({ activationResultDigest: "sha256:not-the-stored-activation" });
      answers["notTheCreate"] = settle({ operationId: "push-default-branch:fixture" });
      answers["stalePlan"] = settle({ planDigest: "sha256:an-earlier-plan" });
      answers["staleCandidate"] = settle({ candidateSnapshotDigest: "sha256:another-candidate" });
      answers["cancelledTask"] = settle({ taskId: cancelled!.taskId });
      answers["unknownTask"] = settle({ taskId: "task_unknown" });
      return deny(ReasonCode.CONFLICT, "roll back", {});
    });
    expect(answers).toEqual({
      otherKind: "RUN_NOT_PROJECTLESS_BOOTSTRAP",
      noReceiptDigest: "SETTLEMENT_EVIDENCE_MISSING",
      noActivationDigest: "SETTLEMENT_EVIDENCE_MISSING",
      otherReceipt: "CREATE_RECEIPT_NOT_BOUND",
      otherActivation: "ACTIVATION_RESULT_NOT_BOUND",
      notTheCreate: "CREATE_RECEIPT_NOT_BOUND",
      stalePlan: "PLAN_NOT_CURRENT",
      staleCandidate: "CANDIDATE_NOT_CURRENT",
      cancelledTask: "TASK_NOT_READY",
      unknownTask: "TASK_NOT_READY",
    });
    expect(tasks(prepared).map((row) => row.state)).toEqual(["CANCELLED", "READY"]);
    expect(settlements(prepared)).toEqual([]);
    // And the real CONFIRM still settles it, exactly once.
    expect(confirm(prepared)).toMatchObject({ allowed: true, value: { state: RunState.COMPLETED } });
    expect(settlements(prepared)).toHaveLength(1);
    // A second settlement of the same receipt is refused: the task is no longer READY.
    let second = "";
    harness.cp.db.txDecision(() => {
      second = refusal(harness.cp.tasks.settleBootstrapExecutionTask({
        ...good,
        activationResultDigest: stored(prepared, "BOOTSTRAP_ACTIVATION_RESULT")!.digest,
      }));
      return deny(ReasonCode.CONFLICT, "roll back", {});
    });
    expect(second).toBe("RUN_NOT_AT_CONFIRM");
  });
});
