import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { digestOf } from "../../src/core/digest.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ExecutionMode, RunKind, RunState } from "../../src/domain/types.ts";
import { bootstrapCoverageKeys, bootstrapPlan, callCtoToolAsOwner, cleanTreeManifest } from "../helpers/bootstrap-plan.ts";
import { FakeGitHub as FakeGitHubClient } from "../helpers/fake-github.ts";
import { FakeGitHub as FakeGitHubWritePort } from "../helpers/fake-github-write-port.ts";
import { cleanupTempDirs, tempDir } from "../helpers/fixtures.ts";
import {
  bindCeo,
  bindWorker,
  carryContractChange,
  dispatchBootstrapRun,
  type Harness,
  makeHarness,
  registerFixtureProject,
  reviewerPass,
} from "../helpers/harness.ts";

afterAll(cleanupTempDirs);
afterEach(() => vi.restoreAllMocks());

/**
 * CEO 1792120507 / 1792120860 — a project-less PROJECT_BOOTSTRAP run's review entry is separate from
 * its execution completion. The owner's `result_submit` alone takes the run to CEO review with its
 * PLAN's task READY and no execution: the task is the external create, which nothing may claim before
 * the owner's approval and the CEO's CONFIRM. Every other run kind keeps task completeness exactly.
 */

const CONTRACT = {
  goal: "bootstrap a new project",
  why: "the owner asked for a repository that does not exist yet",
  scope: [],
  nonGoals: [],
  acceptance: ["the planned repository is what the manifest describes"],
  priority: "NORMAL" as const,
  humanGate: [],
  references: [],
};

let keys = 0;

const world = () => {
  const client = new FakeGitHubClient();
  const writePort = new FakeGitHubWritePort(tempDir("acp-bre-github-"));
  const harness = makeHarness({ githubClient: client, repoFactory: { workRoot: tempDir("acp-bre-factory-"), githubPort: writePort } });
  return { harness, client, writePort };
};

/** A dispatched project-less bootstrap run whose owner's PLAN, with its one task, was accepted. */
const plannedBootstrap = async (harness: Harness, projectId = "bre-project") => {
  bindCeo(harness);
  const created = harness.cp.runs.create({ kind: RunKind.PROJECT_BOOTSTRAP, executionMode: ExecutionMode.STANDARD, contract: CONTRACT });
  if (!created.allowed) throw new Error(created.message);
  const runId = created.value.runId;
  await dispatchBootstrapRun(harness.cp, harness.clock, runId);
  const planned = await callCtoToolAsOwner(harness, runId, "plan_submit", {
    idempotencyKey: `bre-plan-${++keys}`,
    runId,
    plan: bootstrapPlan(cleanTreeManifest(projectId)),
    tasks: [{ key: "bootstrap", title: "create the repository", category: "implementation" }],
  });
  expect(planned.body, planned.text).toMatchObject({ ok: true });
  const run = harness.cp.runs.require(runId);
  return { runId, ownerSessionId: run.ownerSessionId!, ownerBindingGeneration: run.ownerBindingGeneration! };
};

const resultSubmit = (harness: Harness, runId: string) => {
  harness.scripted.script({ match: /Bootstrap plan review/, text: reviewerPass(bootstrapCoverageKeys(harness, runId)) });
  return callCtoToolAsOwner(harness, runId, "result_submit", {
    idempotencyKey: `bre-result-${++keys}`,
    runId,
    resultSummary: "the planned bootstrap outputs",
    recommendation: "create the repository",
  });
};

const executionCount = (harness: Harness, runId: string): number =>
  harness.cp.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM task_executions WHERE run_id = ?`, [runId])?.n ?? 0;

const taskStates = (harness: Harness, runId: string) => harness.cp.tasks.list(runId).map((task) => task.state);

/**
 * `ProductionGate.buildPacket` as the pipeline calls it, for a candidate the check under test runs
 * before; continuity is reconciled first, as the pipeline does before it publishes.
 */
const buildPacket = async (harness: Harness, run: { runId: string; ownerSessionId: string; ownerBindingGeneration: number }) => {
  await harness.cp.continuity.evaluate("review entry");
  return harness.cp.ceo.buildPacket({
    runId: run.runId,
    candidateSnapshotDigest: "sha256:none",
    approval: {
      runId: run.runId,
      candidateSnapshotDigest: "sha256:none",
      resultSummary: "done",
      recommendation: "ship",
      residualRisk: [],
      approvedBySessionId: run.ownerSessionId,
      approvedByGeneration: run.ownerBindingGeneration,
      approvedAt: harness.clock.nowIso(),
    },
  });
};

const APPROVAL_KINDS = [
  "CEO_DECISION", "OWNER_DECISION", "OWNER_APPROVAL_INGRESS", "OWNER_APPROVAL_CONSUMED",
  "BOOTSTRAP_APPLICATION_APPROVAL", "BOOTSTRAP_ACTIVATION_READY_FOR_CONFIRM", "BUZZ_OWNER_APPROVAL_PROMPTED",
];

describe("W1/W3: a project-less bootstrap reaches CEO review on the owner's result_submit alone", () => {
  it("COMPLETED_REVIEW and READY_FOR_CEO_REVIEW with the task READY and no execution; no GitHub call, no application, nothing minted", async () => {
    const { harness, client, writePort } = world();
    const run = await plannedBootstrap(harness);
    const submitted = await resultSubmit(harness, run.runId);
    expect(submitted.body, submitted.text).toMatchObject({ ok: true, value: { stage: "COMPLETED_REVIEW" } });
    expect(harness.cp.runs.require(run.runId).state).toBe(RunState.READY_FOR_CEO_REVIEW);
    expect(taskStates(harness, run.runId)).toEqual(["READY"]);
    expect(executionCount(harness, run.runId)).toBe(0);
    // W3 — nothing external and nothing approved: the T3 prompt is only eligible.
    expect(client.calls).toEqual([]);
    expect(writePort.writes).toEqual([]);
    expect(writePort.reads).toEqual([]);
    expect(harness.cp.bootstrapApplications.get(run.runId)).toBeNull();
    expect(harness.cp.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM github_receipts`)?.n).toBe(0);
    expect(harness.cp.audit.all().filter((row) => APPROVAL_KINDS.includes(row.kind))).toEqual([]);
    expect(harness.cp.artifacts.latest(run.runId, "REPO_FACTORY_RESULT")).toBeNull();
    // The one APPROVAL is the packet's own: the owner CTO's result.
    expect(harness.cp.artifacts.list<Record<string, unknown>>(run.runId, "APPROVAL").map((row) => row.content["approvedBySessionId"]))
      .toEqual([run.ownerSessionId]);
    const scope = harness.cp.bootstrapProducer.approvalScopeOf(run.runId);
    expect(scope.allowed, JSON.stringify(scope)).toBe(true);
  });
});

describe("W2: every other run kind keeps task completeness at both review-entry sites", () => {
  it("STANDARD_WORK with a READY task is refused by result_submit and by buildPacket", async () => {
    const harness = makeHarness();
    const { projectId, repositoryId } = await registerFixtureProject(harness, "bre-standard");
    bindCeo(harness);
    const created = harness.cp.runs.create({
      projectId,
      executionMode: ExecutionMode.STANDARD,
      contract: { ...CONTRACT, goal: "change app()", scope: ["src/app.js"] },
      repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
    });
    if (!created.allowed) throw new Error(created.message);
    const dispatched = await harness.cp.runs.dispatch(created.value.runId);
    if (!dispatched.allowed) throw new Error(dispatched.message);
    expect(harness.cp.tasks.submit(created.value.runId, [{ key: "impl", title: "change app()", category: "implementation" }]).allowed).toBe(true);
    const run = { runId: created.value.runId, ownerSessionId: dispatched.value.ownerSessionId!, ownerBindingGeneration: dispatched.value.ownerBindingGeneration! };
    const submitted = await harness.cp.pipeline.submitResult({ ...run, resultSummary: "x", recommendation: "y" });
    expect(submitted).toMatchObject({ allowed: false, reasonCode: ReasonCode.TASK_RESULT_COUNT_MISMATCH });
    expect(await buildPacket(harness, run)).toMatchObject({ allowed: false, reasonCode: ReasonCode.TASK_RESULT_COUNT_MISMATCH });
    expect(harness.cp.runs.currentCandidate(run.runId)).toBeNull();
  });

  it("a repository-less CONTRACT_CHANGE with a READY task is refused by result_submit and by buildPacket", async () => {
    const harness = makeHarness();
    const { projectId } = await registerFixtureProject(harness, "bre-contract-change");
    bindCeo(harness);
    const created = harness.cp.runs.create({ projectId, kind: RunKind.CONTRACT_CHANGE, executionMode: ExecutionMode.STANDARD, contract: CONTRACT });
    if (!created.allowed) throw new Error(created.message);
    const dispatched = await harness.cp.runs.dispatch(created.value.runId);
    if (!dispatched.allowed) throw new Error(dispatched.message);
    carryContractChange(harness, created.value.runId);
    expect(harness.cp.tasks.submit(created.value.runId, [{ key: "doc", title: "document it", category: "docs" }]).allowed).toBe(true);
    const run = { runId: created.value.runId, ownerSessionId: dispatched.value.ownerSessionId!, ownerBindingGeneration: dispatched.value.ownerBindingGeneration! };
    const submitted = await harness.cp.pipeline.submitResult({ ...run, resultSummary: "x", recommendation: "y" });
    expect(submitted).toMatchObject({ allowed: false, reasonCode: ReasonCode.TASK_RESULT_COUNT_MISMATCH });
    expect(await buildPacket(harness, run)).toMatchObject({ allowed: false, reasonCode: ReasonCode.TASK_RESULT_COUNT_MISMATCH });
    expect(harness.cp.runs.currentCandidate(run.runId)).toBeNull();
  });
});

describe("W7: fake-completion leftovers refuse a bootstrap's review entry with a clear reason, and are left as found", () => {
  const leftover = async (kind: "running" | "succeeded" | "succeeded-without-execution") => {
    const { harness } = world();
    const run = await plannedBootstrap(harness, `bre-leftover-${kind}`);
    const [task] = harness.cp.tasks.ready(run.runId);
    if (kind === "succeeded-without-execution") {
      harness.cp.db.run(`UPDATE tasks SET state = 'SUCCEEDED' WHERE task_id = ?`, [task!.taskId]);
    } else {
      const started = harness.cp.tasks.startExecution({
        runId: run.runId,
        taskId: task!.taskId,
        ownerBindingGeneration: run.ownerBindingGeneration,
        workerSessionId: bindWorker(harness, task!.taskId),
        provider: "scripted",
        model: "scripted-worker",
      });
      if (!started.allowed) throw new Error(started.message);
      if (kind === "succeeded") {
        const finished = harness.cp.tasks.finishExecution(started.value.executionId, { status: "SUCCEEDED", resultDigest: digestOf({ fake: true }) });
        if (!finished.allowed) throw new Error(finished.message);
      }
    }
    return { harness, run, before: { tasks: taskStates(harness, run.runId), executions: executionCount(harness, run.runId) } };
  };

  for (const [kind, refusal] of [
    ["running", "BOOTSTRAP_TASK_HAS_EXECUTION"],
    ["succeeded", "BOOTSTRAP_TASK_HAS_EXECUTION"],
    ["succeeded-without-execution", "BOOTSTRAP_TASK_SUCCEEDED_BEFORE_CONFIRM"],
  ] as const) {
    it(`a ${kind} task: result_submit and buildPacket refuse ${refusal}; nothing is deleted or corrected`, async () => {
      const { harness, run, before } = await leftover(kind);
      const submitted = await resultSubmit(harness, run.runId);
      expect(submitted.body, submitted.text).toMatchObject({
        ok: false,
        reasonCode: ReasonCode.COMPLETION_AUTHORITY_DENIED,
        evidence: { refusal },
      });
      expect(await buildPacket(harness, run)).toMatchObject({
        allowed: false,
        reasonCode: ReasonCode.COMPLETION_AUTHORITY_DENIED,
        evidence: { refusal },
      });
      expect(harness.cp.runs.require(run.runId).state).toBe(RunState.ACTIVE);
      expect(harness.cp.runs.currentCandidate(run.runId)).toBeNull();
      expect({ tasks: taskStates(harness, run.runId), executions: executionCount(harness, run.runId) }).toEqual(before);
    });
  }
});
