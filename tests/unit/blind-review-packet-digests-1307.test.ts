import { afterAll, describe, expect, it } from "vitest";

import { sha256, sha256Hex } from "../../src/core/digest.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ExecutionMode } from "../../src/domain/types.ts";
import type { ReviewPacket } from "../../src/review/blind-review.ts";
import type { TaskContract } from "../../src/run/run-engine.ts";
import { WorkerTurnEvent, type WorkerSuccessDigestInputs, workerDiffDigest, workerSuccessDigest } from "../../src/run/worker-turn.ts";
import { candidateSnapshotDigest, type CandidateSnapshot } from "../../src/snapshot/candidate-snapshot.ts";
import type { VerificationReport } from "../../src/verify/verification-engine.ts";
import { cleanupTempDirs, commitAll, gitSync, writeFiles } from "../helpers/fixtures.ts";
import { applyPassingChange, bindCeo, bindWorker, makeHarness, registerFixtureProject, reviewerPass } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

const CONTRACT: TaskContract = {
  goal: "make app() return 2", why: "downstream callers expect 2", scope: ["src/app.js"], nonGoals: [],
  acceptance: ["verify.js exits 0"], priority: "NORMAL", humanGate: [], references: [],
};
const APP_BYTES = "module.exports = () => 2;\n";
/** Synthetic values only: digests of fixed fixture strings, never of anything real. */
const hexOf = (digest: string): string => digest.slice("sha256:".length);

/** A PASS verification for `snapshot`, its one result carrying a real-shaped outputDigest. */
const persistVerification = (
  setup: { harness: ReturnType<typeof makeHarness>; runId: string; contractDigest: string }, snapshot: CandidateSnapshot, outputDigest: string,
): VerificationReport => {
  const snapshotDigest = candidateSnapshotDigest(snapshot);
  const repository = snapshot.repositories[0]!;
  const now = setup.harness.clock.nowIso();
  const report: VerificationReport = {
    runId: setup.runId, candidateSnapshotDigest: snapshotDigest, contractDigest: setup.contractDigest,
    expectedInputs: 1, observedInputs: 1,
    results: [{ commandId: "verify", repositoryIdentity: repository.identity, source: "local", exactHead: repository.candidateHead,
      startedAt: now, endedAt: now, exitCode: 0, outputDigest, outputTruncated: false, status: "PASS", reasonCode: null }],
    status: "PASS", reasonCode: ReasonCode.OK, gaps: [],
  };
  setup.harness.cp.artifacts.putEvidence(setup.harness.cp.evidenceWritersForTests().VERIFICATION, setup.runId, "VERIFICATION", report, snapshotDigest);
  setup.harness.cp.db.run(
    `INSERT OR REPLACE INTO verification_results
       (result_id, run_id, candidate_snapshot_digest, command_id, repository_identity, source,
        exact_head, started_at, ended_at, exit_code, output_digest, output_truncated, status, reason_code)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [`${snapshotDigest}:verify:${repository.identity}:local`, setup.runId, snapshotDigest, "verify", repository.identity, "local",
      repository.candidateHead, now, now, 0, outputDigest, 0, "PASS", null],
  );
  return report;
};

/** A run whose candidate has a worker receipt linked to it (worker-turn.ts records), frozen and verified. */
const prepare = async () => {
  const harness = makeHarness();
  const { projectId, repositoryId, identity } = await registerFixtureProject(harness);
  bindCeo(harness);
  const created = harness.cp.runs.create({ projectId, executionMode: ExecutionMode.STANDARD, contract: CONTRACT,
    repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }] });
  if (!created.allowed) throw new Error(created.message);
  const dispatched = await harness.cp.runs.dispatch(created.value.runId);
  if (!dispatched.allowed) throw new Error(dispatched.message);
  const run = dispatched.value;
  const submitted = harness.cp.tasks.submit(run.runId, [{ key: "impl", title: "impl", category: "implementation" }]);
  if (!submitted.allowed) throw new Error(submitted.message);
  const task = harness.cp.tasks.ready(run.runId)[0]!;
  const worker = bindWorker(harness, task.taskId);
  const execution = harness.cp.tasks.startExecution({ runId: run.runId, taskId: task.taskId,
    ownerBindingGeneration: run.ownerBindingGeneration!, workerSessionId: worker, provider: "scripted", model: "scripted-worker", repositoryId });
  if (!execution.allowed) throw new Error(execution.message);
  const baseHead = gitSync(harness.repoPath, ["rev-parse", "HEAD"]);
  const head = applyPassingChange(harness.repoPath);
  const receiptDiffDigest = workerDiffDigest(baseHead, [{ path: "src/app.js", mode: "100644", sha256: sha256(APP_BYTES), blob: null }]);
  const inputs: WorkerSuccessDigestInputs = { executionId: execution.value.executionId, workerSessionId: worker,
    sessionIncarnation: "incarnation-1", providerSessionId: "provider-session-1", exitCode: 0,
    stdoutSha256: sha256("worker stdout"), commitHead: head, diffDigest: receiptDiffDigest };
  const resultDigest = workerSuccessDigest(inputs);
  const recorded = harness.cp.audit.record({ kind: WorkerTurnEvent.SUCCEEDED, runId: run.runId,
    evidence: { ...inputs, resultDigest, taskId: task.taskId, head: baseHead, paths: ["src/app.js"] } });
  if (!recorded.allowed) throw new Error(recorded.message);
  harness.cp.tasks.finishExecution(execution.value.executionId, { status: "SUCCEEDED", resultDigest });
  const frozen = await harness.cp.pipeline.freeze(run.runId);
  if (!frozen.allowed) throw new Error(frozen.message);
  const setup = { harness, projectId, identity, runId: run.runId, contractDigest: run.contractDigest, executionMode: run.executionMode,
    receiptDiffDigest, resultDigest };
  const outputDigest = sha256("synthetic verification output");
  return { ...setup, snapshot: frozen.value, verification: persistVerification(setup, frozen.value, outputDigest), outputDigest };
};
type Prepared = Awaited<ReturnType<typeof prepare>>;

const finding = (detail: string, category = "correctness") => ({ category, severity: "MINOR", repository: "github:acme/fixture",
  path: "src/app.js", summary: "nonblocking observation", detail });

/** One review of the prepared candidate; the reviewer answers PASS with `details` as MINOR findings of `category`. */
const review = async (setup: Prepared, details: readonly string[] = [], category = "correctness") => {
  setup.harness.scripted.script({ match: /Candidate review/, text: details.length === 0
    ? reviewerPass([`${setup.identity}:src/app.js`])
    : JSON.stringify({ verdict: "PASS", coveredFiles: [`${setup.identity}:src/app.js`], omittedItems: [], findings: details.map((detail) => finding(detail, category)) }) });
  const result = await setup.harness.cp.review.controlPlaneInvoker()({ runId: setup.runId, projectId: setup.projectId,
    executionMode: setup.executionMode, snapshot: setup.snapshot, contract: CONTRACT, contractDigest: setup.contractDigest,
    verification: setup.verification });
  const prompt = setup.harness.scripted.invocations.at(-1)!.prompt;
  return { result, packetDigest: /Packet digest: (sha256:[0-9a-f]{64})/.exec(prompt)![1]! };
};

const refusals = (setup: Prepared) =>
  setup.harness.cp.audit.forRun(setup.runId).filter((row) => row.kind === "BLIND_REVIEW_STORAGE_REFUSED");

/** The review is refused at storage, and its refusal row names the rule and form class, never the value. */
const expectRefused = async (
  setup: Prepared, detail: string, rule: string, form: string, inPacket: boolean, value: string, category = "correctness",
) => {
  const before = refusals(setup).length;
  const { result } = await review(setup, [detail], category);
  expect(result, detail).toMatchObject({ allowed: false, reasonCode: ReasonCode.TRUSTED_CREDENTIAL_LEAK_BLOCKED,
    evidence: { field: "detail", rule, form, inPacket } });
  const rows = refusals(setup);
  expect(rows).toHaveLength(before + 1);
  expect(rows.at(-1)!.evidence, detail).toMatchObject({ kind: "BLIND_REVIEW", field: "detail", rule, form, inPacket });
  expect(JSON.stringify([result, rows.at(-1)])).not.toContain(value);
};

describe("#1307: a blind review quoting a digest ACP computed for its own packet", () => {
  it("is stored for each packet-computed digest, prefixed and bare", async () => {
    const setup = await prepare();
    try {
      const { packetDigest } = await review(setup);
      const computed = { packet: packetDigest, snapshotDiff: setup.snapshot.repositories[0]!.diffDigest, output: setup.outputDigest,
        receiptDiff: setup.receiptDiffDigest, receiptResult: setup.resultDigest };
      for (const digest of Object.values(computed)) expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
      const details = Object.entries(computed).map(([name, digest]) => `${name} is ${digest}; bare: ${hexOf(digest)}.`);
      const { result } = await review(setup, details);
      expect(result, JSON.stringify(result)).toMatchObject({ allowed: true, value: { verdict: "PASS" } });
      const stored = setup.harness.cp.artifacts.list<ReviewPacket>(setup.runId, "BLIND_REVIEW").at(-1)!.content;
      expect(stored.findings.map((item) => item.detail)).toEqual(details);
      expect(refusals(setup)).toEqual([]);
    } finally {
      setup.harness.cp.close();
    }
  }, 60_000);

  it("refuses another candidate's digest, a stale packet digest and an unlinked receipt's digest", async () => {
    const first = await prepare();
    try {
      const { packetDigest: stalePacket } = await review(first);
      const staleSnapshotDiff = first.snapshot.repositories[0]!.diffDigest;
      writeFiles(first.harness.repoPath, { "src/app.js": "module.exports = () => 2; // second candidate\n" });
      commitAll(first.harness.repoPath, "second candidate");
      const frozen = await first.harness.cp.pipeline.freeze(first.runId);
      if (!frozen.allowed) throw new Error(frozen.message);
      const outputDigest = sha256("synthetic second verification output");
      const second = { ...first, snapshot: frozen.value, outputDigest, verification: persistVerification(first, frozen.value, outputDigest) };
      // The second candidate's own packet digest is stored: the set moved with the candidate.
      const { packetDigest } = await review(second);
      expect(packetDigest).not.toBe(stalePacket);
      expect(await review(second, [`packet ${packetDigest}`]).then(({ result }) => result.allowed)).toBe(true);
      await expectRefused(second, `the earlier packet was ${stalePacket}`, "long_base64_run", "sha256-64hex", false, hexOf(stalePacket));
      await expectRefused(second, `the earlier candidate's diff was ${hexOf(staleSnapshotDiff)}`, "long_base64_run", "hex64", false, hexOf(staleSnapshotDiff));
      // The first candidate's receipt names an earlier commit of the second: listed, never linked.
      await expectRefused(second, `receipt ${first.receiptDiffDigest}`, "long_base64_run", "sha256-64hex", false, hexOf(first.receiptDiffDigest));
    } finally {
      first.harness.cp.close();
    }
  }, 60_000);

  it("refuses an arbitrary 64-hex value and every credential shape, a packet digest beside one included", async () => {
    const setup = await prepare();
    try {
      const { packetDigest } = await review(setup);
      const packetHex = hexOf(packetDigest);
      const arbitrary = sha256Hex("an arbitrary value in no record");
      const token = `ghp_${"A1b2C3d4".repeat(5)}`;
      const base64 = "Ab9+/Zq7".repeat(10);
      await expectRefused(setup, `see ${arbitrary}`, "long_base64_run", "hex64", false, arbitrary);
      await expectRefused(setup, `see sha256:${arbitrary}`, "long_base64_run", "sha256-64hex", false, arbitrary);
      await expectRefused(setup, `the log printed ${token}`, "github_token", "other", false, token);
      await expectRefused(setup, `the log printed ${base64}`, "long_base64_run", "base64", false, base64);
      await expectRefused(setup, "the env had API_TOKEN=hunter2-synthetic", "secret_assignment", "other", false, "hunter2-synthetic");
      // Only the exact digest token is exempt: a credential built on it, or touching it, is not.
      await expectRefused(setup, `token ghp_${packetHex}`, "github_token", "other", true, `ghp_${packetHex}`);
      await expectRefused(setup, `API_TOKEN=${packetDigest}`, "secret_assignment", "other", true, `API_TOKEN=${packetDigest}`);
      await expectRefused(setup, `${packetDigest}Zz9 trailing`, "long_base64_run", "base64", true, `${packetHex}Zz9`);
      expect(setup.harness.cp.artifacts.list<ReviewPacket>(setup.runId, "BLIND_REVIEW")).toHaveLength(1);
    } finally {
      setup.harness.cp.close();
    }
  }, 60_000);

  it("the artifact store reads packet digests only for a BLIND_REVIEW of the run and candidate they name", async () => {
    const setup = await prepare();
    try {
      await review(setup);
      const snapshotDigest = candidateSnapshotDigest(setup.snapshot);
      const quoted = sha256("a digest computed for this packet");
      const stored = setup.harness.cp.artifacts.list<ReviewPacket>(setup.runId, "BLIND_REVIEW").at(-1)!.content;
      const packet = { ...stored, findings: [finding(`quoting ${quoted}`)] };
      const writer = setup.harness.cp.evidenceWritersForTests().BLIND_REVIEW;
      const put = (runId: string, candidate: string) => () => setup.harness.cp.artifacts.putEvidence(
        writer, setup.runId, "BLIND_REVIEW", packet, snapshotDigest, { runId, candidateSnapshotDigest: candidate, digests: new Set([quoted]) });
      expect(put("run_000000000000000000000000", snapshotDigest)).toThrow(/contains a credential/);
      expect(put(setup.runId, sha256("another candidate"))).toThrow(/contains a credential/);
      expect(put(setup.runId, snapshotDigest)()).toMatchObject({ kind: "BLIND_REVIEW", runId: setup.runId });
    } finally {
      setup.harness.cp.close();
    }
  }, 60_000);
});

describe("#1307: a method finding (stored as `methodFindings`) is read like any other finding", () => {
  it("is stored when it quotes the packet digest, prefixed and bare", async () => {
    const setup = await prepare();
    try {
      const { packetDigest } = await review(setup);
      const details = [`packet ${packetDigest}`, `bare: ${hexOf(packetDigest)}.`, packetDigest];
      const { result } = await review(setup, details, "method");
      expect(result, JSON.stringify(result)).toMatchObject({ allowed: true, value: { verdict: "PASS" } });
      const stored = setup.harness.cp.artifacts.list<ReviewPacket>(setup.runId, "BLIND_REVIEW").at(-1)!.content;
      expect(stored.methodFindings?.map((item) => item.detail)).toEqual(details);
      expect(stored.findings).toEqual([]);
      expect(refusals(setup)).toEqual([]);
    } finally {
      setup.harness.cp.close();
    }
  }, 60_000);

  it("refuses an arbitrary whole sha256:<64hex> and a credential token", async () => {
    const setup = await prepare();
    try {
      await review(setup);
      const arbitrary = sha256Hex("an arbitrary value in no record");
      const token = `ghp_${"A1b2C3d4".repeat(5)}`;
      await expectRefused(setup, `sha256:${arbitrary}`, "long_base64_run", "sha256-64hex", false, arbitrary, "method");
      await expectRefused(setup, `the log printed ${token}`, "github_token", "other", false, token, "method");
      expect(setup.harness.cp.artifacts.list<ReviewPacket>(setup.runId, "BLIND_REVIEW")).toHaveLength(1);
    } finally {
      setup.harness.cp.close();
    }
  }, 60_000);
});
