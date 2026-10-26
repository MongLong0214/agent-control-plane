import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

import { sha256 } from "../../src/core/digest.ts";
import { ExecutionMode } from "../../src/domain/types.ts";
import type { ReviewPacket } from "../../src/review/blind-review.ts";
import { WorkerTurnEvent, type WorkerSuccessDigestInputs, workerDiffDigest, workerSuccessDigest } from "../../src/run/worker-turn.ts";
import type * as SandboxModule from "../../src/verify/sandbox.ts";
import type { SandboxOutcome } from "../../src/verify/sandbox.ts";
import { cleanupTempDirs, commitAll, writeFiles } from "../helpers/fixtures.ts";
import { bindCeo, bindWorker, fixtureManifest, makeHarness, registerFixtureProject, startWorkBranch } from "../helpers/harness.ts";

/**
 * #1232 — a task's imported files reach blind review as their manifest, not as raw binaries. The
 * receipt a worker turn finishes with binds the import manifest (each path, size and sha256); the
 * review reads it from a receipt whose recorded inputs reproduce the execution's resultDigest, checks
 * each entry against the bytes the frozen candidate holds at that path, and gives the reviewer the
 * manifest. A binary patch for an imported path whose frozen bytes are exactly the manifest's is
 * replaced by its manifest entry, and the packet records that representation.
 */

// The official run's process is not under test here.
vi.mock("../../src/verify/sandbox.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof SandboxModule>();
  return { ...actual, runSandboxed: vi.fn(async (): Promise<SandboxOutcome> => ({
    status: "PASS", exitCode: 0, signal: null, startedAt: "2026-10-27T00:00:00.000Z",
    endedAt: "2026-10-27T00:00:00.000Z", durationMs: 1, stdout: "", stderr: "",
    outputDigest: "sha256:fixture", outputTruncated: false, peakRssMb: 1, reasonCode: null,
    enforcement: { worktreeIsolated: true, secretsStripped: true, networkPolicy: "deny",
      networkEnforced: true, writeConfinement: true, readConfinement: "sensitive-paths",
      processGroupKill: true, resourceLimitsEnforced: true, memoryLimit: "hard",
      childContainmentEnforced: true, childContainmentReason: null, mechanism: "seatbelt" },
  })) };
});

afterAll(cleanupTempDirs);

const PACKAGE_JSON = `${JSON.stringify({ name: "fixture", private: true, scripts: { test: "node verify.js" } }, null, 2)}\n`;
const APP_BYTES = "module.exports = () => 2;\n";
/** A PNG signature and IHDR chunk start, then bytes git reads as binary. */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]),
  Buffer.from("IHDR"),
  Buffer.alloc(256, 0xff),
  Buffer.from([0x00, 0x01, 0x02, 0x03]),
]);

const prepareRun = async () => {
  const harness = makeHarness();
  writeFiles(harness.repoPath, { "package.json": PACKAGE_JSON });
  const baseHead = commitAll(harness.repoPath, "base with config files");
  const command = { ...fixtureManifest("x").verificationCommands[0]!, id: "test", argv: ["npm", "test"], cwd: "." };
  const { projectId, repositoryId, identity } = await registerFixtureProject(harness, "fixture-project", {
    verificationCommands: [command], verificationProfiles: { simple: ["test"], standard: ["test"], guarded: ["test"] },
  });
  bindCeo(harness);
  const created = harness.cp.runs.create({ projectId, executionMode: ExecutionMode.STANDARD,
    contract: { goal: "app returns 2 and shows the logo", why: "fixture", scope: ["src"], nonGoals: [], acceptance: ["app returns 2"],
      priority: "NORMAL", humanGate: [], references: [] },
    repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }] });
  if (!created.allowed) throw new Error(created.message);
  const dispatched = await harness.cp.runs.dispatch(created.value.runId);
  if (!dispatched.allowed) throw new Error(dispatched.message);
  return { harness, run: dispatched.value, repositoryId, identity, baseHead };
};

const jsonAfter = (prompt: string, heading: string): unknown => {
  const section = prompt.split(`## ${heading}\n`)[1];
  expect(section, heading).toBeDefined();
  return JSON.parse(section!.split("```json\n")[1]!.split("\n```")[0]!);
};

describe("#1232 blind review sees a task's import manifest", () => {
  it("W5 the reviewer gets each imported file's path, size and sha256, not its binary patch", async () => {
    const { harness, run, repositoryId, identity, baseHead } = await prepareRun();
    try {
      const submitted = harness.cp.tasks.submit(run.runId, [{ key: "import", title: "import", category: "implementation" }]);
      if (!submitted.allowed) throw new Error(submitted.message);
      const taskId = harness.cp.tasks.ready(run.runId).find((task) => task.title === "import")!.taskId;
      const worker = bindWorker(harness, taskId);
      const opened = harness.cp.tasks.startExecution({ runId: run.runId, taskId, ownerBindingGeneration: run.ownerBindingGeneration!,
        workerSessionId: worker, provider: "scripted", model: "scripted-worker", repositoryId });
      if (!opened.allowed) throw new Error(opened.message);
      const executionId = opened.value.executionId;

      startWorkBranch(harness.repoPath);
      writeFiles(harness.repoPath, { "src/app.js": APP_BYTES });
      writeFileSync(join(harness.repoPath, "src", "logo.png"), PNG);
      const head = commitAll(harness.repoPath, "make app() return 2 and import the logo");

      // The receipt a worker turn that imported the logo finishes with.
      const imports = [{ path: "src/logo.png", size: PNG.length, sha256: sha256(PNG) }];
      const diffDigest = workerDiffDigest(baseHead, [
        { path: "src/app.js", mode: "100644", sha256: sha256(APP_BYTES), blob: null },
        { path: "src/logo.png", mode: "100644", sha256: sha256(PNG), blob: null },
      ]);
      const inputs = { executionId, workerSessionId: worker, sessionIncarnation: "incarnation-1", providerSessionId: "provider-session-1",
        exitCode: 0, stdoutSha256: sha256("worker stdout"), commitHead: head, diffDigest, imports } as WorkerSuccessDigestInputs;
      const resultDigest = workerSuccessDigest(inputs);
      const recorded = harness.cp.audit.record({ kind: WorkerTurnEvent.SUCCEEDED, runId: run.runId,
        evidence: { ...inputs, resultDigest, taskId, head: baseHead, paths: ["src/app.js", "src/logo.png"] } });
      if (!recorded.allowed) throw new Error(recorded.message);
      harness.cp.tasks.finishExecution(executionId, { status: "SUCCEEDED", resultDigest });

      harness.scripted.script({ match: /Candidate review/, text: JSON.stringify({ verdict: "PASS",
        coveredFiles: [`${identity}:src/app.js`, `${identity}:src/logo.png`], omittedItems: [], findings: [] }) });
      const outcome = await harness.cp.pipeline.submitResult({ runId: run.runId, ownerSessionId: run.ownerSessionId!,
        ownerBindingGeneration: run.ownerBindingGeneration!, resultSummary: "app returns 2 and shows the logo", recommendation: "merge" });
      expect(outcome, JSON.stringify(outcome)).toMatchObject({ allowed: true, value: { stage: "COMPLETED_REVIEW" } });
      const prompt = harness.scripted.invocations.find((call) => call.prompt.startsWith("# Candidate review"))!.prompt;

      // The manifest, checked against the frozen bytes.
      const manifest = jsonAfter(prompt, "Imported files") as { imports: unknown[] };
      expect(manifest.imports).toEqual([{ repository: identity, taskId, executionId, path: "src/logo.png", size: PNG.length,
        sha256: sha256(PNG), frozen: "MATCHES" }]);
      // Not the raw binary: the logo's patch is its manifest entry.
      expect(prompt).not.toContain("GIT binary patch");
      expect(prompt).toContain(`size ${PNG.length} bytes, ${sha256(PNG)}`);
      // The receipt that carries the manifest is linked to the candidate.
      const execution = jsonAfter(prompt, "Untrusted execution evidence") as { receipts: { receipts: Array<Record<string, unknown>> } };
      expect(execution.receipts.receipts).toMatchObject([{ executionId, linked: true, mismatches: [] }]);
      // The stored packet says how the binary path was represented.
      const packet = harness.cp.artifacts.list<ReviewPacket>(run.runId, "BLIND_REVIEW").at(-1)!.content;
      expect(packet.inputManifest.binaryArtifacts).toEqual([{ repository: identity, path: "src/logo.png", digest: sha256(PNG), method: "import-manifest" }]);
    } finally { harness.cp.close(); }
  }, 60_000);
});
