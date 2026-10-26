import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

import { sha256 } from "../../src/core/digest.ts";
import { ExecutionMode } from "../../src/domain/types.ts";
import type { ReviewPacket } from "../../src/review/blind-review.ts";
import { IMPORT_MAX_FILES, IMPORT_MAX_FILE_BYTES, IMPORT_MAX_TOTAL_BYTES, parseImportManifest } from "../../src/run/task-import.ts";
import { WorkerTurnEvent, type WorkerSuccessDigestInputs, workerDiffDigest, workerSuccessDigest } from "../../src/run/worker-turn.ts";
import type { CandidateSnapshot } from "../../src/snapshot/candidate-snapshot.ts";
import type * as SandboxModule from "../../src/verify/sandbox.ts";
import type { SandboxOutcome } from "../../src/verify/sandbox.ts";
import { cleanupTempDirs, commitAll, writeFiles } from "../helpers/fixtures.ts";
import { bindCeo, bindWorker, fixtureManifest, makeHarness, registerFixtureProject, startWorkBranch } from "../helpers/harness.ts";

/**
 * #1232 — a task's imported files reach the freeze and blind review bound by their manifest, never as
 * raw bytes. The receipt a worker turn finishes with binds the import manifest (each path, size and
 * sha256). The freeze reads that manifest from the run's SUCCEEDED receipts, reads the blob the
 * candidate head holds at each path, and binds every import whose bytes are exactly the manifest's
 * by path, size, sha256 and git blob in the snapshot; their patch is not materialised or digested
 * (the candidate's tree stays exact through its head and tree digest). The reviewer gets one manifest
 * entry per imported file in the diff, inside the packet budget, and the packet records that
 * representation.
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
    contract: { goal: "app returns 2 and ships its assets", why: "fixture", scope: ["src"], nonGoals: [], acceptance: ["app returns 2"],
      priority: "NORMAL", humanGate: [], references: [] },
    repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }] });
  if (!created.allowed) throw new Error(created.message);
  const dispatched = await harness.cp.runs.dispatch(created.value.runId);
  if (!dispatched.allowed) throw new Error(dispatched.message);
  return { harness, run: dispatched.value, repositoryId, identity, baseHead };
};

interface Imported { path: string; bytes: Buffer }

/**
 * One task's worker turn as it finishes: the worker's change and the imported files committed on the
 * work branch, and the SUCCEEDED receipt whose resultDigest binds the import manifest. Then the run's
 * result is submitted: freeze, verification and blind review, with a reviewer that passes everything.
 */
const reviewImports = async (files: readonly Imported[]) => {
  const { harness, run, repositoryId, identity, baseHead } = await prepareRun();
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
  for (const file of files) {
    mkdirSync(dirname(join(harness.repoPath, file.path)), { recursive: true });
    writeFileSync(join(harness.repoPath, file.path), file.bytes);
  }
  const head = commitAll(harness.repoPath, "make app() return 2 and import its assets");

  const imports = [...files].sort((a, b) => (a.path < b.path ? -1 : 1)).map((file) => ({ path: file.path, size: file.bytes.length, sha256: sha256(file.bytes) }));
  const parsed = parseImportManifest(imports, ["src"]);
  if (!parsed.allowed) throw new Error(`the manifest is not one validation accepts: ${parsed.message}`);
  const changed = [{ path: "src/app.js", sha256: sha256(APP_BYTES) }, ...imports.map((entry) => ({ path: entry.path, sha256: entry.sha256 }))];
  const diffDigest = workerDiffDigest(baseHead, changed.map((entry) => ({ ...entry, mode: "100644" as const, blob: null })));
  const inputs = { executionId, workerSessionId: worker, sessionIncarnation: "incarnation-1", providerSessionId: "provider-session-1",
    exitCode: 0, stdoutSha256: sha256("worker stdout"), commitHead: head, diffDigest, imports } as WorkerSuccessDigestInputs;
  const resultDigest = workerSuccessDigest(inputs);
  const recorded = harness.cp.audit.record({ kind: WorkerTurnEvent.SUCCEEDED, runId: run.runId,
    evidence: { ...inputs, resultDigest, taskId, head: baseHead, paths: changed.map((entry) => entry.path) } });
  if (!recorded.allowed) throw new Error(recorded.message);
  harness.cp.tasks.finishExecution(executionId, { status: "SUCCEEDED", resultDigest });

  harness.scripted.script({ match: /Candidate review/, text: JSON.stringify({ verdict: "PASS",
    coveredFiles: changed.map((entry) => `${identity}:${entry.path}`), omittedItems: [], findings: [] }) });
  try {
    const outcome = await harness.cp.pipeline.submitResult({ runId: run.runId, ownerSessionId: run.ownerSessionId!,
      ownerBindingGeneration: run.ownerBindingGeneration!, resultSummary: "app returns 2 and ships its assets", recommendation: "merge" });
    const reviewerInput = harness.scripted.invocations.filter((call) => call.prompt.includes("Candidate review")).map((call) => call.prompt).join("\n");
    const packet = harness.cp.artifacts.list<ReviewPacket>(run.runId, "BLIND_REVIEW").at(-1)?.content ?? null;
    const snapshot = harness.cp.artifacts.list<CandidateSnapshot>(run.runId, "CANDIDATE_SNAPSHOT").at(-1)?.content ?? null;
    return { outcome, reviewerInput, packet, snapshot, imports, identity, taskId, executionId };
  } finally {
    harness.cp.close();
  }
};

describe("#1232 freeze and blind review carry a task's import manifest", () => {
  it("W5 the reviewer gets each imported file's path, size and sha256, not its binary patch", async () => {
    const { outcome, reviewerInput, packet, snapshot, imports, identity, taskId } = await reviewImports([{ path: "src/logo.png", bytes: PNG }]);

    expect(outcome, JSON.stringify(outcome)).toMatchObject({ allowed: true, value: { stage: "COMPLETED_REVIEW" } });
    // The freeze bound the import by its bytes at the candidate head.
    expect(snapshot!.repositories[0]!.touchedPaths).toEqual(["src/app.js", "src/logo.png"]);
    expect(JSON.stringify(snapshot)).toContain(imports[0]!.sha256);
    // Not the raw binary: the logo is its manifest entry.
    expect(reviewerInput).not.toContain("GIT binary patch");
    expect(reviewerInput).toContain(`src/logo.png: ${PNG.length} bytes, ${sha256(PNG)}`);
    expect(reviewerInput).toContain(`task ${taskId}`);
    // The stored packet says how the binary path was represented.
    expect(packet!.inputManifest.binaryArtifacts).toEqual([{ repository: identity, path: "src/logo.png", digest: sha256(PNG), method: "import-manifest" }]);
  }, 60_000);

  it("W6 the largest import set validation accepts, every file at its maximum size, freezes and is reviewed", async () => {
    const count = Math.floor(IMPORT_MAX_TOTAL_BYTES / IMPORT_MAX_FILE_BYTES);
    expect(count * IMPORT_MAX_FILE_BYTES).toBe(IMPORT_MAX_TOTAL_BYTES);
    // Random bytes: neither zlib nor git's delta can shrink them, so a binary patch would be larger still.
    const files = Array.from({ length: count }, (_, index) => ({ path: `src/assets/blob-${index}.bin`, bytes: randomBytes(IMPORT_MAX_FILE_BYTES) }));

    const { outcome, reviewerInput, packet, imports } = await reviewImports(files);

    expect(outcome, JSON.stringify(outcome).slice(0, 2000)).toMatchObject({ allowed: true, value: { stage: "COMPLETED_REVIEW" } });
    const missing = imports.filter((entry) => !reviewerInput.includes(entry.path) || !reviewerInput.includes(entry.sha256)).map((entry) => entry.path);
    expect(missing).toEqual([]);
    expect(reviewerInput).not.toContain("GIT binary patch");
    // The receipt check read every imported blob at its maximum size and linked the receipt.
    expect(reviewerInput).toMatch(/"linked": true/);
    expect(packet!.inputManifest.binaryArtifacts.map((artifact) => artifact.method)).toEqual(Array(count).fill("import-manifest"));
  }, 600_000);

  it("W7 the reviewer gets every entry of the largest manifest validation accepts, byte-exact text imports included", async () => {
    const files = Array.from({ length: IMPORT_MAX_FILES }, (_, index) => ({
      path: `src/generated/table-${String(index).padStart(3, "0")}.json`,
      bytes: Buffer.from(`${JSON.stringify({ table: index, rows: [index, index * 2, index * 3] })}\n`),
    }));

    const { outcome, reviewerInput, imports } = await reviewImports(files);

    expect(outcome, JSON.stringify(outcome).slice(0, 2000)).toMatchObject({ allowed: true, value: { stage: "COMPLETED_REVIEW" } });
    // Each entry's path and sha256 reach the reviewer, whatever the packet's layout.
    const missing = imports.filter((entry) => !reviewerInput.includes(entry.path) || !reviewerInput.includes(entry.sha256)).map((entry) => entry.path);
    expect(missing).toEqual([]);
  }, 300_000);
});
