import { afterAll, describe, expect, it, vi } from "vitest";

import { ExecutionMode } from "../../src/domain/types.ts";
import type * as SandboxModule from "../../src/verify/sandbox.ts";
import type { SandboxOutcome } from "../../src/verify/sandbox.ts";
import { cleanupTempDirs, commitAll, writeFiles } from "../helpers/fixtures.ts";
import { applyPassingChange, bindCeo, bindWorker, makeHarness, registerFixtureProject } from "../helpers/harness.ts";

// Packet tests keep canonical verification persistence; process confinement is tested separately.
vi.mock("../../src/verify/sandbox.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof SandboxModule>();
  return { ...actual, runSandboxed: vi.fn(async (): Promise<SandboxOutcome> => ({
    status: "PASS", exitCode: 0, signal: null, startedAt: "2026-08-12T00:00:00.000Z",
    endedAt: "2026-08-12T00:00:00.000Z", durationMs: 1, stdout: "fixture", stderr: "",
    outputDigest: "sha256:fixture", outputTruncated: false, peakRssMb: 1, reasonCode: null,
    enforcement: { worktreeIsolated: true, secretsStripped: true, networkPolicy: "deny",
      networkEnforced: true, writeConfinement: true, readConfinement: "sensitive-paths",
      processGroupKill: true, resourceLimitsEnforced: true, memoryLimit: "hard",
      childContainmentEnforced: true, childContainmentReason: null, mechanism: "seatbelt" },
  })) };
});

afterAll(cleanupTempDirs);

const prepare = async (options: { largeTree?: boolean } = {}) => {
  const harness = makeHarness();
  if (options.largeTree) {
    writeFiles(harness.repoPath, Object.fromEntries(Array.from({ length: 2001 }, (_, i) => [`files/${"segment/".repeat(10)}${String(i).padStart(4, "0")}`, "x"])));
    commitAll(harness.repoPath, "large baseline tree");
  }
  const { projectId, repositoryId } = await registerFixtureProject(harness);
  bindCeo(harness);
  const created = harness.cp.runs.create({
    projectId,
    executionMode: ExecutionMode.STANDARD,
    contract: { goal: "app returns 2", why: "fixture", scope: ["src/app.js"], nonGoals: [],
      acceptance: ["app returns 2", "official dispatch, one WORKER and CTO delegation", "at final closure: CEO approval, PR/CI, merge and exact merged-SHA readback"],
      priority: "NORMAL", humanGate: [], references: [] },
    repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
  });
  if (!created.allowed) throw new Error(created.message);
  const dispatched = await harness.cp.runs.dispatch(created.value.runId);
  if (!dispatched.allowed) throw new Error(dispatched.message);
  const run = dispatched.value;
  const tasks = harness.cp.tasks.submit(run.runId, [{ key: "impl", title: "private producer self-assessment", category: "implementation" }]);
  if (!tasks.allowed) throw new Error(tasks.message);
  const task = harness.cp.tasks.ready(run.runId)[0]!;
  const worker = bindWorker(harness, task.taskId);
  const execution = harness.cp.tasks.startExecution({ runId: run.runId, taskId: task.taskId,
    ownerBindingGeneration: run.ownerBindingGeneration!, workerSessionId: worker,
    provider: "scripted", model: "scripted-worker", repositoryId });
  if (!execution.allowed) throw new Error(execution.message);
  const head = applyPassingChange(harness.repoPath);
  harness.cp.tasks.finishExecution(execution.value.executionId, { status: "SUCCEEDED", resultDigest: `sha256:${head}` });
  const submit = () => harness.cp.pipeline.submitResult({ runId: run.runId,
    ownerSessionId: run.ownerSessionId!, ownerBindingGeneration: run.ownerBindingGeneration!,
    resultSummary: "app returns 2", recommendation: "merge" });
  return { harness, run, task, worker, head, submit };
};


describe("PR1166 R2 control-plane budget", () => {
  it("a small change remains reviewable with canonical historical tasks", async () => {
    const { harness, run, submit } = await prepare();
    try {
      const tasks = harness.cp.tasks.submit(run.runId, Array.from({ length: 650 }, (_, i) => ({ key: `old-${i}`, title: `old-${i}`, category: "implementation" as const })));
      expect(tasks.allowed).toBe(true);
      expect(harness.cp.tasks.cancelAll(run.runId, "superseded unexecuted work")).toBe(650);
      expect(harness.cp.tasks.completeness(run.runId).allowed).toBe(true);
      harness.scripted.script({ match: /Candidate review/, text: JSON.stringify({ verdict: "PASS", coveredFiles: ["github:acme/fixture:src/app.js"], omittedItems: [], findings: [] }) });
      const outcome = await submit();
      expect(outcome, JSON.stringify(outcome)).toMatchObject({ allowed: true, value: { stage: "COMPLETED_REVIEW" } });
      const prompts = harness.scripted.invocations.filter((r) => r.prompt.includes("Candidate review"));
      expect(prompts.length).toBeGreaterThan(0);
      // Added by the implementer: the summary still counts every task while the list is cut.
      const section = prompts.at(-1)!.prompt.split("## Control-plane evidence\n")[1]!;
      const evidence = JSON.parse(section.split("```json\n")[1]!.split("\n```")[0]!) as {
        taskSummary: { total: number; byState: Record<string, number>; workerBindingCount: number; listed: number; truncated: boolean };
        tasks: { workerBindingCount: number }[] };
      expect(evidence.taskSummary).toMatchObject({ total: 651, byState: { SUCCEEDED: 1, CANCELLED: 650 }, workerBindingCount: 1, truncated: true });
      expect(evidence.tasks.length).toBe(evidence.taskSummary.listed);
      expect(evidence.tasks.length).toBeLessThan(651);
      expect(evidence.tasks[0]!.workerBindingCount).toBe(1);
    } finally { harness.cp.close(); }
  });
});
