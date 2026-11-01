import { afterAll, describe, expect, it, vi } from "vitest";

import { sha256 } from "../../src/core/digest.ts";
import { ExecutionMode } from "../../src/domain/types.ts";
import { candidateEvidenceSection, readExecutionEvidence } from "../../src/review/candidate-review-evidence.ts";
import { WorkerTurnEvent, type WorkerSuccessDigestInputs, workerDiffDigest, workerSuccessDigest } from "../../src/run/worker-turn.ts";
import { candidateSnapshotDigest, type CandidateSnapshot } from "../../src/snapshot/candidate-snapshot.ts";
import type * as SandboxModule from "../../src/verify/sandbox.ts";
import type { SandboxOutcome } from "../../src/verify/sandbox.ts";
import type { VerificationReport } from "../../src/verify/verification-engine.ts";
import { cleanupTempDirs, commitAll, writeFiles } from "../helpers/fixtures.ts";
import { bindCeo, bindWorker, fixtureManifest, makeHarness, registerFixtureProject, startWorkBranch } from "../helpers/harness.ts";

// The official run's process is not under test here.
vi.mock("../../src/verify/sandbox.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof SandboxModule>();
  return { ...actual, runSandboxed: vi.fn(async (): Promise<SandboxOutcome> => ({
    status: "PASS", exitCode: 0, signal: null, startedAt: "2026-10-31T00:00:00.000Z",
    endedAt: "2026-10-31T00:00:00.000Z", durationMs: 1, stdout: "", stderr: "",
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

const prepareRun = async () => {
  const harness = makeHarness();
  writeFiles(harness.repoPath, { "package.json": PACKAGE_JSON });
  const baseHead = commitAll(harness.repoPath, "base");
  const command = { ...fixtureManifest("x").verificationCommands[0]!, id: "test", argv: ["npm", "test"], cwd: "." };
  const { projectId, repositoryId, identity } = await registerFixtureProject(harness, "fixture-project", {
    verificationCommands: [command], verificationProfiles: { simple: ["test"], standard: ["test"], guarded: ["test"] },
  });
  bindCeo(harness);
  const created = harness.cp.runs.create({ projectId, executionMode: ExecutionMode.STANDARD,
    contract: { goal: "app returns 2", why: "fixture", scope: ["src/app.js"], nonGoals: [], acceptance: ["app returns 2"],
      priority: "NORMAL", humanGate: [], references: [] },
    repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }] });
  if (!created.allowed) throw new Error(created.message);
  const dispatched = await harness.cp.runs.dispatch(created.value.runId);
  if (!dispatched.allowed) throw new Error(dispatched.message);
  return { harness, run: dispatched.value, repositoryId, identity, baseHead };
};

type Prepared = Awaited<ReturnType<typeof prepareRun>>;

const openExecution = (setup: Prepared, key: string) => {
  const submitted = setup.harness.cp.tasks.submit(setup.run.runId, [{ key, title: key, category: "implementation" }]);
  if (!submitted.allowed) throw new Error(submitted.message);
  const task = setup.harness.cp.tasks.ready(setup.run.runId).find((candidate) => candidate.title === key)!;
  const worker = bindWorker(setup.harness, task.taskId);
  const execution = setup.harness.cp.tasks.startExecution({ runId: setup.run.runId, taskId: task.taskId,
    ownerBindingGeneration: setup.run.ownerBindingGeneration!, workerSessionId: worker,
    provider: "scripted", model: "scripted-worker", repositoryId: setup.repositoryId });
  if (!execution.allowed) throw new Error(execution.message);
  return { taskId: task.taskId, executionId: execution.value.executionId, worker };
};

/** The worker receipt form of a change, computed here from the bytes, independently of ACP's recomputation. */
const receiptForm = (base: string, changed: Array<[path: string, bytes: string]>): string =>
  workerDiffDigest(base, changed.map(([path, bytes]) => ({ path, mode: "100644" as const, sha256: sha256(bytes), blob: null })));

/** A self-consistent SUCCEEDED receipt: its inputs, `diffDigest` included, reproduce the execution's resultDigest. */
const finishWithReceipt = (setup: Prepared, opened: ReturnType<typeof openExecution>, receipt: {
  base: string; commitHead: string; paths: string[]; diffDigest: string;
}) => {
  const inputs: WorkerSuccessDigestInputs = { executionId: opened.executionId, workerSessionId: opened.worker,
    sessionIncarnation: "incarnation-1", providerSessionId: "provider-session-1", exitCode: 0,
    stdoutSha256: sha256("worker stdout"), commitHead: receipt.commitHead, diffDigest: receipt.diffDigest };
  const resultDigest = workerSuccessDigest(inputs);
  const recorded = setup.harness.cp.audit.record({ kind: WorkerTurnEvent.SUCCEEDED, runId: setup.run.runId,
    evidence: { ...inputs, resultDigest, taskId: opened.taskId, head: receipt.base, paths: receipt.paths } });
  if (!recorded.allowed) throw new Error(recorded.message);
  setup.harness.cp.tasks.finishExecution(opened.executionId, { status: "SUCCEEDED", resultDigest });
};

const jsonAfter = (text: string, heading: string): unknown => {
  const section = text.split(`## ${heading}\n`)[1];
  expect(section, heading).toBeDefined();
  return JSON.parse(section!.split("```json\n")[1]!.split("\n```")[0]!);
};

interface RenderedReceipts {
  receipts: {
    receipts: Array<Record<string, unknown>>;
    diffDigests: Array<{ executionId: string; repository: string | null; snapshotGitPatchDiffDigest: string | null;
      receiptDiffDigest: string | null; recomputedReceiptFormDiffDigest: string | null }>;
  };
}

/** The execution evidence section exactly as the blind review places it in the reviewer's input. */
const renderedEvidence = async (setup: Prepared) => {
  const frozen = await setup.harness.cp.pipeline.freeze(setup.run.runId);
  if (!frozen.allowed) throw new Error(frozen.message);
  const evidence = await readExecutionEvidence(setup.harness.cp.db, { runId: setup.run.runId, snapshot: frozen.value,
    snapshotDigest: candidateSnapshotDigest(frozen.value), contractDigest: setup.run.contractDigest,
    verification: { results: [] } as unknown as VerificationReport, checkoutOf: () => setup.harness.repoPath });
  const text = candidateEvidenceSection(setup.harness.cp.db, setup.run.runId, [], evidence).join("\n");
  return { snapshot: frozen.value, evidence, text, rendered: jsonAfter(text, "Untrusted execution evidence") as RenderedReceipts };
};

describe("the reviewer's input names the snapshot's git-patch digest and the receipt-form digests apart", () => {
  it("a correct candidate: the two computations differ, the recomputed receipt form equals the receipt, the receipt is linked", async () => {
    const setup = await prepareRun();
    const { harness, run, identity, baseHead } = setup;
    try {
      const opened = openExecution(setup, "impl");
      startWorkBranch(harness.repoPath);
      writeFiles(harness.repoPath, { "src/app.js": APP_BYTES });
      const head = commitAll(harness.repoPath, "make app() return 2");
      const receiptDigest = receiptForm(baseHead, [["src/app.js", APP_BYTES]]);
      finishWithReceipt(setup, opened, { base: baseHead, commitHead: head, paths: ["src/app.js"], diffDigest: receiptDigest });
      harness.scripted.script({ match: /Candidate review/, text: JSON.stringify({ verdict: "PASS",
        coveredFiles: [`${identity}:src/app.js`], omittedItems: [], findings: [] }) });

      const outcome = await harness.cp.pipeline.submitResult({ runId: run.runId, ownerSessionId: run.ownerSessionId!,
        ownerBindingGeneration: run.ownerBindingGeneration!, resultSummary: "app returns 2", recommendation: "merge" });
      expect(outcome, JSON.stringify(outcome)).toMatchObject({ allowed: true, value: { stage: "COMPLETED_REVIEW" } });
      const prompt = harness.scripted.invocations.find((call) => call.prompt.startsWith("# Candidate review"))!.prompt;
      const snapshot = harness.cp.artifacts.list<CandidateSnapshot>(run.runId, "CANDIDATE_SNAPSHOT").at(-1)!.content;
      const snapshotDigest = snapshot.repositories[0]!.diffDigest;

      // Two computations over the same change: they differ for this correct candidate.
      expect(snapshotDigest).not.toBe(receiptDigest);
      const rendered = jsonAfter(prompt, "Untrusted execution evidence") as RenderedReceipts;
      expect(rendered.receipts.receipts).toMatchObject([{ executionId: opened.executionId, diffDigest: receiptDigest, linked: true, mismatches: [] }]);
      expect(rendered.receipts.diffDigests).toEqual([{ executionId: opened.executionId, repository: identity,
        snapshotGitPatchDiffDigest: snapshotDigest, receiptDiffDigest: receiptDigest, recomputedReceiptFormDiffDigest: receiptDigest }]);

      // The rule text says which digest is which and what linkage compares, and keeps a mismatch a mismatch.
      expect(prompt).not.toContain("the paths and diffDigest equal the frozen change between them");
      expect(prompt).toContain("the receipt's diffDigest equals recomputedReceiptFormDiffDigest");
      expect(prompt).toContain("snapshotGitPatchDiffDigest is the candidate snapshot manifest's diffDigest: sha256 of the git patch between baseHead and candidateHead");
      expect(prompt).toContain("recomputedReceiptFormDiffDigest is ACP's own computation of that receipt form from the frozen change");
      expect(prompt).toContain("When receiptDiffDigest and recomputedReceiptFormDiffDigest differ, the receipt is not linked and the disagreement is listed in its mismatches");
    } finally { harness.cp.close(); }
  }, 60_000);

  it("a forged receipt diffDigest is still refused, and the input shows the true recomputed value, not the receipt's", async () => {
    const setup = await prepareRun();
    const { harness, identity, baseHead } = setup;
    try {
      startWorkBranch(harness.repoPath);
      writeFiles(harness.repoPath, { "src/app.js": APP_BYTES });
      const head = commitAll(harness.repoPath, "make app() return 2");
      const forged = sha256("a forged receipt digest");
      const forgedReceipt = openExecution(setup, "forged");
      finishWithReceipt(setup, forgedReceipt, { base: baseHead, commitHead: head, paths: ["src/app.js"], diffDigest: forged });
      // Refused before the frozen change is read: nothing is recomputed, and its mismatches say why.
      const wrongBase = openExecution(setup, "wrong-base");
      finishWithReceipt(setup, wrongBase, { base: head, commitHead: head, paths: ["src/app.js"],
        diffDigest: receiptForm(baseHead, [["src/app.js", APP_BYTES]]) });

      const { snapshot, evidence, rendered } = await renderedEvidence(setup);
      const byExecution = new Map(evidence.receipts.map((receipt) => [receipt.executionId, receipt]));
      expect(byExecution.get(forgedReceipt.executionId)).toMatchObject({ linked: false, diffDigest: forged,
        mismatches: ["the receipt's diffDigest is not the frozen change's"] });
      expect(byExecution.get(wrongBase.executionId)).toMatchObject({ linked: false,
        mismatches: [`the receipt's base head is not the snapshot's baseHead ${baseHead}`] });
      expect(evidence.repositories[0]!.linkedExecutionIds).toEqual([]);

      const truth = receiptForm(baseHead, [["src/app.js", APP_BYTES]]);
      const digests = new Map(rendered.receipts.diffDigests.map((entry) => [entry.executionId, entry]));
      expect(digests.get(forgedReceipt.executionId)).toEqual({ executionId: forgedReceipt.executionId, repository: identity,
        snapshotGitPatchDiffDigest: snapshot.repositories[0]!.diffDigest, receiptDiffDigest: forged, recomputedReceiptFormDiffDigest: truth });
      expect(digests.get(wrongBase.executionId)).toMatchObject({ recomputedReceiptFormDiffDigest: null });
    } finally { harness.cp.close(); }
  }, 60_000);

  it("a frozen change other than the one the receipt recorded is still refused; the input shows the frozen change's own digest", async () => {
    const setup = await prepareRun();
    const { harness, identity, baseHead } = setup;
    try {
      const amended = "module.exports = () => 2; // amended after the receipt\n";
      startWorkBranch(harness.repoPath);
      writeFiles(harness.repoPath, { "src/app.js": amended });
      const head = commitAll(harness.repoPath, "make app() return 2");
      // An honest receipt for the bytes the worker committed, naming a head that now holds other bytes.
      const recorded = receiptForm(baseHead, [["src/app.js", APP_BYTES]]);
      const opened = openExecution(setup, "impl");
      finishWithReceipt(setup, opened, { base: baseHead, commitHead: head, paths: ["src/app.js"], diffDigest: recorded });

      const { snapshot, evidence, rendered } = await renderedEvidence(setup);
      expect(evidence.receipts).toMatchObject([{ executionId: opened.executionId, linked: false,
        mismatches: ["the receipt's diffDigest is not the frozen change's"] }]);
      expect(rendered.receipts.diffDigests).toEqual([{ executionId: opened.executionId, repository: identity,
        snapshotGitPatchDiffDigest: snapshot.repositories[0]!.diffDigest, receiptDiffDigest: recorded,
        recomputedReceiptFormDiffDigest: receiptForm(baseHead, [["src/app.js", amended]]) }]);
    } finally { harness.cp.close(); }
  }, 60_000);
});
