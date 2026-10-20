import { afterAll, describe, expect, it, vi } from "vitest";

import { ExecutionMode } from "../../src/domain/types.ts";
import type * as SandboxModule from "../../src/verify/sandbox.ts";
import type { SandboxOutcome } from "../../src/verify/sandbox.ts";
import { cleanupTempDirs, makeRepo } from "../helpers/fixtures.ts";
import { applyPassingChange, bindCeo, bindWorker, makeHarness, fixtureManifest } from "../helpers/harness.ts";

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

describe("packet listings share the reviewer budget", () => {
  it("keeps a one-line change reviewable with 140 repositories and 650 superseded tasks together", async () => {
    const harness = makeHarness();
    try {
      const count = 140;
      const entries = Array.from({ length: count }, (_, i) => ({
        role: i === 0 ? "primary" : `repo-${i}`,
        remote: `github:acme/repo-${String(i).padStart(3, "0")}`,
        manifestRoot: ".",
      }));
      const manifest = fixtureManifest("many-repositories", { repositories: entries });
      const project = harness.cp.projects.register({ projectId: manifest.projectId, name: "many", manifest,
        authorization: harness.cp.manifestAuthorizationForTests(manifest) });
      if (!project.allowed) throw new Error(project.message);
      const participants = [];
      for (const [i, entry] of entries.entries()) {
        const checkoutPath = i === 0 ? harness.repoPath : makeRepo({ "README.md": "fixture" });
        const repo = await harness.cp.repositories.register({ checkoutPath, projectId: manifest.projectId,
          repositoryRole: entry.role, identity: entry.remote, activeManifestDigest: project.value.activeManifestDigest });
        if (!repo.allowed) throw new Error(repo.message);
        participants.push({ repositoryId: repo.value.repositoryId, repositoryRole: entry.role, baseBranch: "dev" });
      }
      bindCeo(harness);
      const created = harness.cp.runs.create({ projectId: manifest.projectId, executionMode: ExecutionMode.STANDARD,
        contract: { goal: "app returns 2", why: "fixture", scope: ["src/app.js"], nonGoals: [], acceptance: ["app returns 2"],
          priority: "NORMAL", humanGate: [], references: [] }, repositories: participants });
      if (!created.allowed) throw new Error(created.message);
      const dispatched = await harness.cp.runs.dispatch(created.value.runId);
      if (!dispatched.allowed) throw new Error(dispatched.message);
      const run = dispatched.value;
      const old = harness.cp.tasks.submit(run.runId, Array.from({ length: 650 }, (_, i) => ({ key: `old-${i}`, title: `old-${i}`, category: "implementation" as const })));
      expect(old.allowed).toBe(true);
      expect(harness.cp.tasks.cancelAll(run.runId, "superseded unexecuted work")).toBe(650);
      const admitted = harness.cp.tasks.submit(run.runId, [{ key: "impl", title: "impl", category: "implementation" }]);
      if (!admitted.allowed) throw new Error(admitted.message);
      const task = harness.cp.tasks.ready(run.runId)[0]!;
      const worker = bindWorker(harness, task.taskId);
      const execution = harness.cp.tasks.startExecution({ runId: run.runId, taskId: task.taskId,
        ownerBindingGeneration: run.ownerBindingGeneration!, workerSessionId: worker,
        provider: "scripted", model: "scripted-worker", repositoryId: participants[0]!.repositoryId });
      if (!execution.allowed) throw new Error(execution.message);
      applyPassingChange(harness.repoPath);
      harness.cp.tasks.finishExecution(execution.value.executionId, { status: "SUCCEEDED", resultDigest: "sha256:done" });
      harness.scripted.script({ match: /Candidate review|Review chunk|Final review/, text: JSON.stringify({ verdict: "PASS",
        coveredFiles: ["github:acme/repo-000:src/app.js"], omittedItems: [], findings: [] }) });
      const outcome = await harness.cp.pipeline.submitResult({ runId: run.runId, ownerSessionId: run.ownerSessionId!,
        ownerBindingGeneration: run.ownerBindingGeneration!, resultSummary: "app returns 2", recommendation: "merge" });
      const prompts = harness.scripted.invocations.filter((r) => /# Candidate review|# Review chunk|# Final review/.test(r.prompt));
      expect(outcome, JSON.stringify(outcome.allowed ? { allowed: true } : outcome)).toMatchObject({ allowed: true, value: { stage: "COMPLETED_REVIEW" } });
      // A reviewer ran, every prompt fits, and both cuts are declared.
      expect(prompts.length).toBeGreaterThan(0);
      for (const p of prompts) expect(p.prompt.length).toBeLessThanOrEqual(120_000);
      expect(prompts[0]!.prompt).toMatch(/\d+ of 140 participating repositories are omitted from this listing for size/);
      expect(prompts[0]!.prompt).toMatch(/"total": 651/);
      // The candidate's own task and its WORKER binding are listed, not only counted in the summary.
      const section = prompts[0]!.prompt.split("## Control-plane evidence\n")[1]!;
      const evidence = JSON.parse(section.split("```json\n")[1]!.split("\n```")[0]!) as {
        tasks: { taskId: string; state: string; workerBindingCount: number }[] };
      expect(evidence.tasks[0]).toMatchObject({ taskId: task.taskId, state: "SUCCEEDED", workerBindingCount: 1 });
      expect(prompts[0]!.prompt).toMatch(/"truncated": true/);
    } finally { harness.cp.close(); }
  }, 120_000);
});
