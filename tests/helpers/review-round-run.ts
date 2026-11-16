import type { ProjectManifest } from "../../src/contracts/manifest.ts";
import { ExecutionMode } from "../../src/domain/types.ts";
import type { TaskContract } from "../../src/run/run-engine.ts";
import {
  type Harness,
  applyFailingChange,
  applyPassingChange,
  bindCeo,
  bindWorker,
  registerFixtureProject,
} from "./harness.ts";

/** The contract of the run below: one acceptance line, one file in scope. */
export const REVIEW_ROUND_CONTRACT: TaskContract = {
  goal: "make app() return 2",
  why: "downstream callers expect 2",
  scope: ["src/app.js"],
  nonGoals: [],
  acceptance: ["verify.js exits 0"],
  priority: "NORMAL",
  humanGate: [],
  references: [],
};

/**
 * A dispatched STANDARD run whose one task's worker committed `change`, ready for result_submit.
 * Driven through the production pipeline, so every review is a scripted-reviewer fixture result,
 * never live reviewer evidence.
 */
export const startReviewedRun = async (
  harness: Harness,
  change: "passing" | "failing" | ((repoPath: string) => string) = "passing",
  contract: TaskContract = REVIEW_ROUND_CONTRACT,
  manifestOverrides: Partial<ProjectManifest> = {},
) => {
  const { projectId, repositoryId, identity } = await registerFixtureProject(harness, "fixture-project", manifestOverrides);
  bindCeo(harness);
  const created = harness.cp.runs.create({
    projectId,
    executionMode: ExecutionMode.STANDARD,
    contract,
    repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
  });
  if (!created.allowed) throw new Error(created.message);
  const runId = created.value.runId;
  const dispatched = await harness.cp.runs.dispatch(runId);
  if (!dispatched.allowed) throw new Error(`${dispatched.reasonCode}: ${dispatched.message}`);
  const run = dispatched.value;
  const tasks = harness.cp.tasks.submit(runId, [{ key: "impl", title: "change app()", category: "implementation" }]);
  if (!tasks.allowed) throw new Error(tasks.message);
  const task = harness.cp.tasks.ready(runId)[0]!;
  const execution = harness.cp.tasks.startExecution({
    runId,
    taskId: task.taskId,
    ownerBindingGeneration: run.ownerBindingGeneration!,
    workerSessionId: bindWorker(harness, task.taskId),
    provider: "scripted",
    model: "scripted-worker",
    repositoryId,
  });
  if (!execution.allowed) throw new Error(execution.message);
  const head =
    typeof change === "function"
      ? change(harness.repoPath)
      : change === "passing"
        ? applyPassingChange(harness.repoPath)
        : applyFailingChange(harness.repoPath);
  harness.cp.tasks.finishExecution(execution.value.executionId, { status: "SUCCEEDED", resultDigest: `sha256:${head}` });
  const submit = (resultSummary = "app() now returns 2") =>
    harness.cp.pipeline.submitResult({
      runId,
      ownerSessionId: run.ownerSessionId!,
      ownerBindingGeneration: run.ownerBindingGeneration!,
      resultSummary,
      recommendation: "merge",
    });
  return { projectId, identity, runId, run, submit, covered: [`${identity}:src/app.js`] };
};

export const stageOf = (outcome: Awaited<ReturnType<Awaited<ReturnType<typeof startReviewedRun>>["submit"]>>): string =>
  outcome.allowed ? outcome.value.stage : `DENIED ${outcome.reasonCode}`;
