import { afterAll, describe, expect, it, vi } from "vitest";

import { ArtifactKind, ExecutionMode, RunKind, RunState } from "../../src/domain/types.ts";
import type * as SandboxModule from "../../src/verify/sandbox.ts";
import type { SandboxOutcome } from "../../src/verify/sandbox.ts";
import type { ReviewPacket } from "../../src/review/blind-review.ts";
import { cleanupTempDirs, commitAll, gitSync, makeCore, makeRepo, writeFiles } from "../helpers/fixtures.ts";
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
    writeFiles(harness.repoPath, Object.fromEntries(Array.from({ length: 2001 }, (_, i) => [`files/${String(i).padStart(4, "0")}`, "x"])));
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

const jsonSection = (prompt: string, heading: string): unknown => {
  const section = prompt.split(`## ${heading}\n`)[1];
  expect(section, heading).toBeDefined();
  return JSON.parse(section!.split("```json\n")[1]!.split("\n```")[0]!);
};

describe("frozen candidate packet evidence", () => {
  it("does not manufacture dispatch or delegation evidence when canonical records are absent", async () => {
    const { controlPlaneEvidence } = await import("../../src/review/candidate-review-evidence.ts");
    const core = makeCore();
    try {
      expect(controlPlaneEvidence(core.db, "absent")).toEqual({ dispatched: false, tasks: [], owningPrimaryCtoDelegation: false });
    } finally { core.db.close(); }
  });

  it("includes the complete tracked tree, including unchanged paths, at the candidate SHA", async () => {
    const { harness, head, submit } = await prepare();
    try {
      harness.scripted.script({ match: /Candidate review/, text: JSON.stringify({ verdict: "PASS", coveredFiles: ["github:acme/fixture:src/app.js"], omittedItems: [], findings: [] }) });
      const outcome = await submit();
      expect(outcome, JSON.stringify(outcome)).toMatchObject({ allowed: true, value: { stage: "COMPLETED_REVIEW" } });
      const prompt = harness.scripted.invocations.find((r) => r.prompt.includes("# Candidate review"))!.prompt;
      expect(jsonSection(prompt, "Frozen candidate tracked trees")).toEqual([{
        repository: "github:acme/fixture", candidateHead: head, entryLimit: 2000, truncated: false,
        paths: ["README.md", "src/app.js", "verify.js"],
      }]);
    } finally { harness.cp.close(); }
  });

  it("marks the tree in the reviewer packet incomplete when the entry cap cuts it", async () => {
    const { harness, submit } = await prepare({ largeTree: true });
    try {
      harness.scripted.script({ match: /Candidate review/, text: JSON.stringify({ verdict: "PASS", coveredFiles: ["github:acme/fixture:src/app.js"], omittedItems: [], findings: [] }) });
      await submit();
      const prompt = harness.scripted.invocations.find((r) => r.prompt.includes("# Candidate review"))!.prompt;
      const trees = jsonSection(prompt, "Frozen candidate tracked trees") as Array<{ truncated: boolean; paths: string[] }>;
      expect(trees[0]!.truncated).toBe(true);
      expect(trees[0]!.paths).toHaveLength(2000);
      expect(prompt).toContain("A truncated listing is incomplete");
    } finally { harness.cp.close(); }
  });

  it("reads unreplaced frozen objects rather than HEAD and marks a cut list truncated", async () => {
    const { readTrackedTree } = await import("../../src/review/candidate-review-evidence.ts");
    const repo = makeRepo({ "README.md": "original" });
    const frozen = gitSync(repo, ["rev-parse", "HEAD"]);
    const files = Object.fromEntries(Array.from({ length: 2001 }, (_, i) => [`files/${String(i).padStart(4, "0")}`, "x"]));
    writeFiles(repo, files);
    const next = commitAll(repo, "add paths after freeze");
    gitSync(repo, ["replace", frozen, next]);
    expect(await readTrackedTree(repo, "fixture", frozen)).toMatchObject({ paths: ["README.md"], truncated: false, candidateHead: frozen });
    const cut = await readTrackedTree(repo, "fixture", next);
    expect(cut.paths).toHaveLength(2000);
    expect(cut.truncated).toBe(true);
    expect(cut.entryLimit).toBe(2000);
  });

  it("includes canonical control-plane facts and pending later obligations without identities or prior verdicts; same candidate can be re-reviewed", async () => {
    const { harness, run, task, worker, submit } = await prepare();
    try {
      harness.scripted.script({ match: /Candidate review/, text: JSON.stringify({ verdict: "REVISE",
        coveredFiles: ["github:acme/fixture:src/app.js"], omittedItems: [], findings: [{ category: "correctness", severity: "MAJOR",
          repository: "github:acme/fixture", path: "src/app.js", summary: "prior-verdict-marker", detail: "synthetic" }] }) });
      const outcome = await submit();
      expect(outcome, JSON.stringify(outcome)).toMatchObject({ allowed: true, value: { stage: "REVISION_REQUIRED" } });
      const first = harness.cp.artifacts.latest<ReviewPacket>(run.runId, ArtifactKind.BLIND_REVIEW)!;
      expect(first.content.verdict).toBe("REVISE");
      expect(harness.cp.runs.require(run.runId).state).toBe(RunState.ACTIVE);
      harness.scripted.script({ match: /Candidate review/, text: JSON.stringify({ verdict: "PASS", coveredFiles: ["github:acme/fixture:src/app.js"], omittedItems: [], findings: [] }) });
      const retried = await submit();
      expect(retried, JSON.stringify(retried)).toMatchObject({ allowed: true, value: { stage: "COMPLETED_REVIEW" } });
      const prompts = harness.scripted.invocations.filter((r) => r.prompt.includes("# Candidate review"));
      expect(prompts).toHaveLength(2);
      const prompt = prompts[1]!.prompt;
      expect(jsonSection(prompt, "Control-plane evidence")).toEqual({
        dispatched: true,
        tasks: [{ taskId: task.taskId, category: "implementation", state: "SUCCEEDED", workerBindingCount: 1, activeWorkerBindingCount: 1 }],
        owningPrimaryCtoDelegation: true,
      });
      expect(prompt).toContain("## Obligations verified by later gates, not by this review");
      expect(prompt).toContain("candidate-bound CEO CONFIRM");
      expect(prompt).toContain("publish the candidate branch, prepare its PR and merge, then verify CI");
      expect(prompt).toContain("exact merge commit SHA");
      expect(prompt).toContain("These obligations remain pending");
      for (const secret of [worker, run.ownerSessionId!, "scripted-worker", "private producer self-assessment", "prior-verdict-marker"]) {
        expect(prompt).not.toContain(secret);
      }
      const latest = harness.cp.artifacts.latest<ReviewPacket>(run.runId, ArtifactKind.BLIND_REVIEW)!;
      expect(latest.content.verdict).toBe("PASS");
      expect(latest.digest).not.toBe(first.digest);
      expect(latest.candidateSnapshotDigest).toBe(first.candidateSnapshotDigest);
      expect(harness.cp.artifacts.byDigest(first.digest)).not.toBeNull();
    } finally { harness.cp.close(); }
  });

  it("does not advertise daemon merge obligations when that run kind has no daemon completion gate", async () => {
    const { laterGateSection } = await import("../../src/review/candidate-review-evidence.ts");
    const section = laterGateSection(RunKind.PROJECT_BOOTSTRAP, 1).join("\n");
    expect(section).toContain("BLOCKER");
    expect(section).not.toContain("candidate-bound CEO CONFIRM");
    expect(section).not.toContain("publish the candidate branch, prepare its PR and merge, then verify CI");
    expect(section).not.toContain("exact merge commit SHA");
  });
});
