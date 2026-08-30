import { afterAll, describe, expect, it, vi } from "vitest";
import { chmodSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { sha256 } from "../../src/core/digest.ts";
import { artifactDigestMatches } from "../../src/db/artifacts.ts";
import { ExecutionMode, Role, roleKeyFor } from "../../src/domain/types.ts";
import { BlindReviewGate, __testing, type ReviewPacket } from "../../src/review/blind-review.ts";
import { CandidatePipeline } from "../../src/run/candidate-pipeline.ts";
import { canonical } from "../../src/guard/workspace-probe.ts";
import { ClaudeCliAdapter, reviewerEnvironment } from "../../src/runtime/cli-adapters.ts";
import {
  ProviderSessionProvisionError,
  type InvocationRequest,
  type InvocationResult,
  type SessionSpec,
} from "../../src/runtime/provider.ts";
import type { TaskContract } from "../../src/run/run-engine.ts";
import { candidateSnapshotDigest } from "../../src/snapshot/candidate-snapshot.ts";
import type { CandidateSnapshot } from "../../src/snapshot/candidate-snapshot.ts";
import type { VerificationReport } from "../../src/verify/verification-engine.ts";
import { cleanupTempDirs, commitAll, writeFiles } from "../helpers/fixtures.ts";
import {
  applyPassingChange,
  bindCeo,
  bindWorker,
  makeHarness,
  registerFixtureProject,
  reviewerPass,
} from "../helpers/harness.ts";
import { TestProductionAdapter, testReviewerEgressEvidence } from "../helpers/production-adapter.ts";

afterAll(cleanupTempDirs);

const CONTRACT: TaskContract = {
  goal: "make app() return 2",
  why: "downstream callers expect 2",
  scope: ["src/app.js"],
  nonGoals: [],
  acceptance: ["verify.js exits 0"],
  priority: "NORMAL",
  humanGate: [],
  references: [],
};

const persistPassingVerification = (
  setup: { harness: ReturnType<typeof makeHarness>; run: { runId: string; contractDigest: string } },
  snapshot: CandidateSnapshot,
): VerificationReport => {
  const snapshotDigest = candidateSnapshotDigest(snapshot);
  const repository = snapshot.repositories[0]!;
  const now = setup.harness.clock.nowIso();
  const report: VerificationReport = {
    runId: setup.run.runId,
    candidateSnapshotDigest: snapshotDigest,
    contractDigest: setup.run.contractDigest,
    expectedInputs: 1,
    observedInputs: 1,
    results: [{
      commandId: "verify",
      repositoryIdentity: repository.identity,
      source: "local",
      exactHead: repository.candidateHead,
      startedAt: now,
      endedAt: now,
      exitCode: 0,
      outputDigest: "sha256:test-verification-output",
      outputTruncated: false,
      status: "PASS",
      reasonCode: null,
    }],
    status: "PASS",
    reasonCode: ReasonCode.OK,
    gaps: [],
  };
  setup.harness.cp.artifacts.putEvidence(setup.harness.cp.evidenceWritersForTests().VERIFICATION, setup.run.runId, "VERIFICATION", report, snapshotDigest);
  setup.harness.cp.db.run(
    `INSERT OR REPLACE INTO verification_results
       (result_id, run_id, candidate_snapshot_digest, command_id, repository_identity, source,
        exact_head, started_at, ended_at, exit_code, output_digest, output_truncated, status, reason_code)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      `${snapshotDigest}:verify:${repository.identity}:local`,
      setup.run.runId, snapshotDigest, "verify", repository.identity, "local", repository.candidateHead,
      now, now, 0, "sha256:test-verification-output", 0, "PASS", null,
    ],
  );
  return report;
};

const prepareReviewedInputs = async () => {
  const harness = makeHarness();
  const { projectId, repositoryId, identity } = await registerFixtureProject(harness);
  bindCeo(harness);
  const created = harness.cp.runs.create({
    projectId,
    executionMode: ExecutionMode.STANDARD,
    contract: CONTRACT,
    repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
  });
  if (!created.allowed) throw new Error(created.message);
  const dispatched = await harness.cp.runs.dispatch(created.value.runId);
  if (!dispatched.allowed) throw new Error(dispatched.message);
  const run = dispatched.value;
  const submitted = harness.cp.tasks.submit(run.runId, [{ key: "impl", title: "impl", category: "implementation" }]);
  if (!submitted.allowed) throw new Error(submitted.message);
  const task = harness.cp.tasks.ready(run.runId)[0]!;
  const workerSessionId = bindWorker(harness, task.taskId);
  const execution = harness.cp.tasks.startExecution({
    runId: run.runId,
    taskId: task.taskId,
    ownerBindingGeneration: run.ownerBindingGeneration!,
    workerSessionId,
    provider: "scripted",
    model: "scripted-worker",
    repositoryId,
  });
  if (!execution.allowed) throw new Error(execution.message);
  const head = applyPassingChange(harness.repoPath);
  harness.cp.tasks.finishExecution(execution.value.executionId, { status: "SUCCEEDED", resultDigest: `sha256:${head}` });
  const frozen = await harness.cp.pipeline.freeze(run.runId);
  if (!frozen.allowed) throw new Error(frozen.message);
  const verification = persistPassingVerification({ harness, run }, frozen.value);
  return { harness, projectId, repositoryId, identity, run, snapshot: frozen.value, verification };
};

const directReview = async (setup: Awaited<ReturnType<typeof prepareReviewedInputs>>, response = reviewerPass(["github:acme/fixture:src/app.js"])) => {
  setup.harness.scripted.script({ match: /Candidate review/, text: response });
  return setup.harness.cp.review.controlPlaneInvoker()({
    runId: setup.run.runId,
    projectId: setup.projectId,
    executionMode: setup.run.executionMode,
    snapshot: setup.snapshot,
    contract: CONTRACT,
    contractDigest: setup.run.contractDigest,
    verification: setup.verification,
  });
};

const invokePreparedReview = (setup: Awaited<ReturnType<typeof prepareReviewedInputs>>) =>
  setup.harness.cp.review.controlPlaneInvoker()({
    runId: setup.run.runId,
    projectId: setup.projectId,
    executionMode: setup.run.executionMode,
    snapshot: setup.snapshot,
    contract: CONTRACT,
    contractDigest: setup.run.contractDigest,
    verification: setup.verification,
  });

const prepareLargeReviewedInputs = async () => {
  const setup = await prepareReviewedInputs();
  writeFiles(setup.harness.repoPath, {
    "src/app.js": `module.exports = () => 2;\n// ${"x".repeat(130_000)}\n`,
  });
  commitAll(setup.harness.repoPath, "large reviewed change");
  const frozen = await setup.harness.cp.pipeline.freeze(setup.run.runId);
  if (!frozen.allowed) throw new Error(frozen.message);
  return {
    ...setup,
    snapshot: frozen.value,
    verification: persistPassingVerification(setup, frozen.value),
  };
};

const writeIsolationProbeReviewerStub = (
  directory: string,
  deniedReadTarget: string,
  coveredFiles: readonly string[],
): string => {
  const binary = join(directory, "isolation-probe-reviewer.mjs");
  writeFileSync(
    binary,
    `#!${process.execPath}
import { readFileSync } from "node:fs";
const sessionIndex = process.argv.indexOf("--session-id");
const sessionId = sessionIndex >= 0 ? process.argv[sessionIndex + 1] : null;
const isRuntimeProbe = process.argv.includes("--version");
let denied = false;
if (!isRuntimeProbe) {
  try {
    readFileSync(${JSON.stringify(deniedReadTarget)}, "utf8");
  } catch {
    denied = true;
  }
}
const result = isRuntimeProbe
  ? "isolation-probe-reviewer 1.0"
  : denied
  ? ${JSON.stringify(reviewerPass([...coveredFiles]))}
  : "isolation probe unexpectedly read the producer checkout";
process.stdout.write(JSON.stringify({ result, session_id: sessionId }));
process.exitCode = isRuntimeProbe || denied ? 0 : 1;
`,
  );
  chmodSync(binary, 0o700);
  return binary;
};

const invokeGate = (
  gate: BlindReviewGate,
  setup: Awaited<ReturnType<typeof prepareReviewedInputs>>,
) => gate.controlPlaneInvoker()({
  runId: setup.run.runId,
  projectId: setup.projectId,
  executionMode: setup.run.executionMode,
  snapshot: setup.snapshot,
  contract: CONTRACT,
  contractDigest: setup.run.contractDigest,
  verification: setup.verification,
});

class HealthyProbeClaudeAdapter extends ClaudeCliAdapter {
  override async probeRuntime(): Promise<"HEALTHY"> {
    return "HEALTHY";
  }

  override async invoke(request: InvocationRequest): Promise<InvocationResult> {
    return {
      ok: false,
      text: "",
      json: null,
      provider: this.provider,
      model: request.model ?? this.defaultModels.reviewer,
      durationMs: 0,
      exitCode: 1,
      error: "model did not answer",
      providerSessionId: request.externalSessionId ?? null,
      isolationAttested: request.isolation !== undefined,
      ...(request.isolation ? { egressEvidence: testReviewerEgressEvidence(this.provider) } : {}),
    };
  }
}

/** A production-eligible test adapter used only to prove the gate's fail-closed policy. */
class IsolationUnsupportedGptAdapter extends TestProductionAdapter {
  readonly supportsReviewerIsolation = false;
}

/** Simulates a real GPT reviewer whose packet/profile/provider-id proof cannot be made. */
class ProviderIdentityFailureGptAdapter extends TestProductionAdapter {
  readonly supportsReviewerIsolation = true;
  readonly requiresReviewerProviderSessionProof = true;

  override async startSession(_spec: SessionSpec): Promise<never> {
    throw new ProviderSessionProvisionError(
      ReasonCode.ISOLATION_LOST,
      "live reviewer isolation proof is unavailable",
    );
  }
}

const gateWithReviewerPreferences = (
  setup: Awaited<ReturnType<typeof prepareReviewedInputs>>,
  preferred: TestProductionAdapter,
  fallback: TestProductionAdapter,
) => new BlindReviewGate(
  setup.harness.cp.clock,
  setup.harness.cp.db,
  setup.harness.cp.audit,
  setup.harness.cp.artifacts,
  setup.harness.cp.evidenceWritersForTests().BLIND_REVIEW,
  setup.harness.cp.sessions,
  setup.harness.cp.bindings,
  setup.harness.cp.providers,
  setup.harness.cp.repositories,
  setup.harness.cp.telemetry,
  {
    preferred: { provider: preferred.provider, model: "gpt-5.6-sol", effort: "xhigh" },
    fallbacks: [{ provider: fallback.provider, model: "opus", effort: null }],
  },
);

describe("round-2 blind-review regressions", () => {
  it("#125 rejects a caller-fabricated PASS verification report", async () => {
    const setup = await prepareReviewedInputs();
    const fabricated = { ...setup.verification, results: [] };
    const manual = await setup.harness.cp.review.review({
      runId: setup.run.runId,
      projectId: setup.projectId,
      executionMode: setup.run.executionMode,
      snapshot: setup.snapshot,
      contract: CONTRACT,
      contractDigest: setup.run.contractDigest,
      verification: fabricated,
    });
    expect(manual.allowed).toBe(false);
    expect(manual.reasonCode).toBe(ReasonCode.REVIEW_MANUAL_INVOCATION_DENIED);
    const result = await setup.harness.cp.review.controlPlaneInvoker()({
      runId: setup.run.runId,
      projectId: setup.projectId,
      executionMode: setup.run.executionMode,
      snapshot: setup.snapshot,
      contract: CONTRACT,
      contractDigest: setup.run.contractDigest,
      verification: fabricated,
    });
    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe(ReasonCode.EVIDENCE_MISSING);
    expect(setup.harness.cp.review.latestPacket(setup.run.runId, candidateSnapshotDigest(setup.snapshot))).toBeNull();
  });

  it("#126 rejects a contract whose bytes do not hash to the run's pinned contract", async () => {
    const setup = await prepareReviewedInputs();
    const result = await setup.harness.cp.review.controlPlaneInvoker()({
      runId: setup.run.runId,
      projectId: setup.projectId,
      executionMode: setup.run.executionMode,
      snapshot: setup.snapshot,
      contract: { ...CONTRACT, acceptance: [] },
      contractDigest: setup.run.contractDigest,
      verification: setup.verification,
    });
    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe(ReasonCode.CONTRACT_DIGEST_MISMATCH);
  });

  // #448: `#126` above proves the real comparison — a stored contract is in hand and the
  // caller's submission disagrees with it — still reports CONTRACT_DIGEST_MISMATCH. This proves
  // the other half: when the artifact store cannot produce a trustworthy stored contract at all,
  // nothing was compared, so it must report CONTRACT_UNVERIFIED instead. Both used to be the
  // same `deny()` call, folded behind one `||`.
  it("#448 reports CONTRACT_UNVERIFIED when the run's pinned task contract cannot be retrieved from the artifact store", async () => {
    const setup = await prepareReviewedInputs();
    const list = vi.spyOn(setup.harness.cp.artifacts, "list").mockReturnValue([]);
    try {
      const result = await setup.harness.cp.review.controlPlaneInvoker()({
        runId: setup.run.runId,
        projectId: setup.projectId,
        executionMode: setup.run.executionMode,
        snapshot: setup.snapshot,
        contract: CONTRACT,
        contractDigest: setup.run.contractDigest,
        verification: setup.verification,
      });
      expect(result.allowed).toBe(false);
      expect(result.reasonCode).toBe(ReasonCode.CONTRACT_UNVERIFIED);
    } finally {
      list.mockRestore();
    }
  });

  it("#127 refuses a verdict attested to a producer provider session", async () => {
    const setup = await prepareReviewedInputs();
    const producerProviderSession = setup.harness.cp.sessions.require(setup.run.ownerSessionId!).incarnation.split("#", 1)[0]!;
    const originalInvoke = setup.harness.scripted.invoke.bind(setup.harness.scripted);
    setup.harness.scripted.invoke = async (request) => ({
      ...(await originalInvoke(request)),
      providerSessionId: producerProviderSession,
    });
    const result = await directReview(setup);
    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe(ReasonCode.REVIEWER_SESSION_IS_PRODUCER);
  });

  it("#364 rechecks reviewer independence when assembling the packet", async () => {
    const setup = await prepareReviewedInputs();
    const originalProducerSessions = setup.harness.cp.bindings.producerSessions.bind(setup.harness.cp.bindings);
    let injected = false;
    setup.harness.cp.bindings.producerSessions = (runId: string) => {
      const producersBeforeInjection = originalProducerSessions(runId);
      if (!injected && runId === setup.run.runId) {
        const reviewer = setup.harness.cp.bindings.active(roleKeyFor(Role.BLIND_REVIEWER, { runId }));
        if (!reviewer) throw new Error("reviewer was not bound before identity attestation");
        const producerBinding = setup.harness.cp.bindings.bind({
          role: Role.OPTIONAL_ADVERSARIAL_REVIEWER,
          runId,
          sessionId: reviewer.sessionId,
        });
        if (!producerBinding.allowed) throw new Error(producerBinding.message);
        injected = true;
      }
      // The invocation-identity check receives the pre-injection set. The packet-time
      // check must observe the new producer binding and refuse the otherwise valid PASS.
      return producersBeforeInjection;
    };

    const result = await directReview(setup);

    expect(injected).toBe(true);
    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe(ReasonCode.REVIEWER_SESSION_IS_PRODUCER);
    expect(setup.harness.cp.review.latestPacket(
      setup.run.runId,
      candidateSnapshotDigest(setup.snapshot),
    )).toBeNull();
  });

  it("#128 constitutes a distinct reviewer session for every chunk and records the final authority", async () => {
    const setup = await prepareLargeReviewedInputs();
    setup.harness.scripted.script(
      { match: /Review chunk/, text: reviewerPass([`${setup.identity}:src/app.js`]), once: false },
      { match: /Final review/, text: reviewerPass([]) },
    );
    const result = await invokePreparedReview(setup);
    if (!result.allowed) throw new Error(`${result.reasonCode}: ${result.message}`);
    const chunkInvocations = setup.harness.scripted.invocations.filter((invocation) => /Review chunk/.test(invocation.prompt));

    expect(result.value.chunked).toBe(true);
    expect(chunkInvocations.length).toBeGreaterThan(1);
    expect(new Set(chunkInvocations.map((invocation) => invocation.externalSessionId)).size).toBe(chunkInvocations.length);
    expect(result.value.reviewerRoleBindingGeneration).toBe(chunkInvocations.length + 1);
    expect(setup.harness.cp.sessions.require(result.value.reviewerSessionId).lifecycle).toBe("STOPPED");
    expect(setup.harness.cp.audit.byKind("BLIND_REVIEW_COMPLETED")[0]?.evidence).toMatchObject({
      chunkReviewerSessions: expect.arrayContaining([
        expect.objectContaining({ provider: "scripted" }),
      ]),
    });
  });

  it("#129 rejects an out-of-chunk coverage claim through the chunked review gate", async () => {
    const setup = await prepareLargeReviewedInputs();
    setup.harness.scripted.script(
      { match: /Review chunk/, text: reviewerPass([`${setup.identity}:not-in-this-chunk.ts`]), once: false },
      { match: /Final review/, text: reviewerPass([]) },
    );

    const result = await invokePreparedReview(setup);

    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe(ReasonCode.COVERAGE_INCOMPLETE);
  });

  it("#359 keeps a chunk BLOCK with only MAJOR findings from becoming a final PASS", async () => {
    const setup = await prepareLargeReviewedInputs();
    const covered = `${setup.identity}:src/app.js`;
    const chunkBlock = JSON.stringify({
      verdict: "BLOCK",
      coveredFiles: [covered],
      omittedItems: [],
      findings: [{
        category: "correctness",
        severity: "MAJOR",
        repository: setup.identity,
        path: "src/app.js",
        summary: "chunk found a material defect",
        detail: "the reviewer that saw this range blocked the candidate",
      }],
    });
    setup.harness.scripted.script(
      { match: /Review chunk/, text: chunkBlock },
      { match: /Review chunk/, text: reviewerPass([covered]), once: false },
      { match: /Final review/, text: reviewerPass([]) },
    );

    const result = await invokePreparedReview(setup);
    const packet = setup.harness.cp.review.latestPacket(
      setup.run.runId,
      candidateSnapshotDigest(setup.snapshot),
    );

    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe(ReasonCode.REVIEW_BLOCK);
    expect(packet).toMatchObject({
      verdict: "BLOCK",
      findings: [expect.objectContaining({ severity: "MAJOR", summary: "chunk found a material defect" })],
    });
  });

  it("#362 requires every range slice of an oversized file to claim coverage", async () => {
    const setup = await prepareLargeReviewedInputs();
    const covered = `${setup.identity}:src/app.js`;
    // The first range claims the file; every later range returns a usable response but
    // does not claim it. File-level first-slice-wins coverage would incorrectly PASS.
    setup.harness.scripted.script(
      { match: /Review chunk/, text: reviewerPass([covered]) },
      { match: /Review chunk/, text: reviewerPass([]), once: false },
      { match: /Final review/, text: reviewerPass([]) },
    );

    const result = await invokePreparedReview(setup);
    const packet = setup.harness.cp.review.latestPacket(
      setup.run.runId,
      candidateSnapshotDigest(setup.snapshot),
    );

    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe(ReasonCode.REVIEW_REVISE);
    expect(packet).toMatchObject({ verdict: "REVISE" });
    expect(packet?.omittedItems).toContain(covered);
  });

  it("#363 refuses a chunk verdict attested to a producer provider session", async () => {
    const setup = await prepareLargeReviewedInputs();
    const producerProviderSession = setup.harness.cp.sessions
      .require(setup.run.ownerSessionId!)
      .incarnation.split("#", 1)[0]!;
    const originalInvoke = setup.harness.scripted.invoke.bind(setup.harness.scripted);
    setup.harness.scripted.invoke = async (request) => {
      const result = await originalInvoke(request);
      return /Review chunk/.test(request.prompt)
        ? { ...result, providerSessionId: producerProviderSession }
        : result;
    };
    setup.harness.scripted.script(
      { match: /Review chunk/, text: reviewerPass([`${setup.identity}:src/app.js`]), once: false },
      { match: /Final review/, text: reviewerPass([]) },
    );

    const result = await invokePreparedReview(setup);

    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe(ReasonCode.REVIEWER_SESSION_IS_PRODUCER);
    expect(setup.harness.cp.review.latestPacket(
      setup.run.runId,
      candidateSnapshotDigest(setup.snapshot),
    )).toBeNull();
  });

  // #448: the pipeline's own pinned-contract lookup (distinct from the one inside blind review,
  // just above) folded the same two facts into one CONTRACT_DIGEST_MISMATCH — "no trustworthy
  // contract was retrievable" and "the candidate's contract disagrees with the pinned one".
  // Only the first is exercised here; nothing here compares the two, so nothing should read as
  // a disagreement.
  it("#448 reports CONTRACT_UNVERIFIED when submitResult cannot retrieve the run's pinned task contract", async () => {
    const setup = await prepareReviewedInputs();
    setup.harness.cp.verification.verify = async () => allow(ReasonCode.OK, setup.verification);
    const list = vi.spyOn(setup.harness.cp.artifacts, "list").mockReturnValue([]);
    try {
      const result = await setup.harness.cp.pipeline.submitResult({
        runId: setup.run.runId,
        ownerSessionId: setup.run.ownerSessionId!,
        ownerBindingGeneration: setup.run.ownerBindingGeneration!,
        resultSummary: "done",
        recommendation: "merge",
      });
      expect(result.allowed).toBe(false);
      expect(result.reasonCode).toBe(ReasonCode.CONTRACT_UNVERIFIED);
    } finally {
      list.mockRestore();
    }
  });

  it("#130 serializes concurrent candidate submissions across a reconstructed pipeline", async () => {
    const setup = await prepareReviewedInputs();
    setup.harness.cp.verification.verify = async () => allow(ReasonCode.OK, setup.verification);
    setup.harness.scripted.script({
      match: /Candidate review/,
      text: reviewerPass([`${setup.identity}:src/app.js`]),
      delayMs: 25,
    });
    const input = {
      runId: setup.run.runId,
      ownerSessionId: setup.run.ownerSessionId!,
      ownerBindingGeneration: setup.run.ownerBindingGeneration!,
      resultSummary: "done",
      recommendation: "merge",
    };
    const first = setup.harness.cp.pipeline.submitResult(input);
    const restarted = new CandidatePipeline(
      setup.harness.cp.db,
      setup.harness.cp.clock,
      setup.harness.cp.audit,
      setup.harness.cp.artifacts,
      setup.harness.cp.runs,
      setup.harness.cp.tasks,
      setup.harness.cp.projects,
      setup.harness.cp.repositories,
      setup.harness.cp.verification,
      setup.harness.cp.review,
      setup.harness.cp.review.controlPlaneInvoker(),
      setup.harness.cp.ceo,
      setup.harness.cp.bindings,
      setup.harness.cp.outbox,
      setup.harness.cp.telemetry,
      setup.harness.cp.guard,
    );
    const second = await restarted.submitResult(input);
    expect(second.allowed).toBe(false);
    expect(second.reasonCode).toBe(ReasonCode.CONFLICT);
    await first;
  });

  it("#333 does not lower mandatory GPT review to Claude when GPT lacks isolation", async () => {
    const setup = await prepareReviewedInputs();
    const preferred = new IsolationUnsupportedGptAdapter(setup.harness.clock, "gpt");
    const fallback = new TestProductionAdapter(setup.harness.clock, "claude");
    fallback.script({
      match: /Candidate review/,
      text: reviewerPass([`${setup.identity}:src/app.js`]),
    });
    setup.harness.cp.providers.register(preferred);
    setup.harness.cp.providers.register(fallback);

    const gate = gateWithReviewerPreferences(setup, preferred, fallback);
    const result = await invokeGate(gate, setup);

    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe(ReasonCode.ISOLATION_LOST);
    expect(fallback.invocations).toHaveLength(0);
    expect(setup.harness.cp.audit.byKind("BLIND_REVIEW_FALLBACK")).toHaveLength(0);
  });

  it("does not call an absent GPT adapter an outage and silently use Claude", async () => {
    const setup = await prepareReviewedInputs();
    const absentPreferred = new TestProductionAdapter(setup.harness.clock, "gpt");
    const fallback = new TestProductionAdapter(setup.harness.clock, "claude");
    fallback.script({
      match: /Candidate review/,
      text: reviewerPass([`${setup.identity}:src/app.js`]),
    });
    // Register only Claude. A missing GPT adapter has no live health/capacity measurement.
    setup.harness.cp.providers.register(fallback);

    const result = await invokeGate(gateWithReviewerPreferences(setup, absentPreferred, fallback), setup);

    expect(result).toMatchObject({ allowed: false, reasonCode: ReasonCode.ISOLATION_LOST });
    expect(fallback.invocations).toHaveLength(0);
    // Removing the preferred-adapter refusal turns this into a deceptively successful
    // Claude review even though no GPT unavailability was ever measured.
  });

  it("falls back to Claude only after GPT is actually unavailable and records why", async () => {
    const setup = await prepareReviewedInputs();
    const preferred = new TestProductionAdapter(setup.harness.clock, "gpt");
    preferred.setRuntimeHealth("UNAVAILABLE");
    const fallback = new TestProductionAdapter(setup.harness.clock, "claude");
    fallback.script({
      match: /Candidate review/,
      text: reviewerPass([`${setup.identity}:src/app.js`]),
    });
    setup.harness.cp.providers.register(preferred);
    setup.harness.cp.providers.register(fallback);

    const result = await invokeGate(gateWithReviewerPreferences(setup, preferred, fallback), setup);

    expect(result.allowed).toBe(true);
    expect(result.allowed && result.value.provider).toBe("claude");
    expect(preferred.invocations).toHaveLength(0);
    expect(fallback.invocations).toHaveLength(1);
    expect(setup.harness.cp.audit.byKind("BLIND_REVIEW_FALLBACK")).toEqual([
      expect.objectContaining({
        runId: setup.run.runId,
        evidence: expect.objectContaining({ from: "gpt", provider: "claude", reason: "runtime unavailable" }),
      }),
    ]);
  });

  it("does not fall back when GPT provider-session isolation proof fails", async () => {
    const setup = await prepareReviewedInputs();
    const preferred = new ProviderIdentityFailureGptAdapter(setup.harness.clock, "gpt");
    const fallback = new TestProductionAdapter(setup.harness.clock, "claude");
    fallback.script({
      match: /Candidate review/,
      text: reviewerPass([`${setup.identity}:src/app.js`]),
    });
    setup.harness.cp.providers.register(preferred);
    setup.harness.cp.providers.register(fallback);

    const result = await invokeGate(gateWithReviewerPreferences(setup, preferred, fallback), setup);

    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe(ReasonCode.ISOLATION_LOST);
    expect(fallback.invocations).toHaveLength(0);
    expect(setup.harness.cp.audit.byKind("BLIND_REVIEW_FALLBACK")).toHaveLength(0);
  });

  it("#360 refuses a reviewer when daemon-owned egress is not configured", async () => {
    const setup = await prepareReviewedInputs();
    const claude = new ClaudeCliAdapter({
      clock: setup.harness.clock,
      capacityFile: join(setup.harness.root, "claude-capacity.json"),
      binary: writeIsolationProbeReviewerStub(
        setup.harness.root,
        join(setup.harness.repoPath, "src/app.js"),
        [`${setup.identity}:src/app.js`],
      ),
    });
    const direct = await claude.invoke({
      prompt: "Review this packet only.",
      workdir: setup.harness.root,
      timeoutMs: 5_000,
      readOnly: true,
      correlationId: "real-reviewer-attestation",
      externalSessionId: "stub-reviewer-session",
      isolation: {
        packetRoot: setup.harness.root,
        denyReadPaths: [setup.harness.repoPath],
        emptyEnvironment: true,
        network: "provider-only",
        tools: "none",
      },
    });
    setup.harness.cp.providers.register(claude);
    const gate = new BlindReviewGate(
      setup.harness.cp.clock,
      setup.harness.cp.db,
      setup.harness.cp.audit,
      setup.harness.cp.artifacts,
      setup.harness.cp.evidenceWritersForTests().BLIND_REVIEW,
      setup.harness.cp.sessions,
      setup.harness.cp.bindings,
      setup.harness.cp.providers,
      setup.harness.cp.repositories,
      setup.harness.cp.telemetry,
      {
        preferred: { provider: "claude", model: "opus", effort: null },
        fallbacks: [],
      },
    );

    const result = await invokeGate(gate, setup);

    // The reviewer must never fall back to the old allow-default-only profile. Its absence
    // is an isolation loss rather than permission to run a broad-network reviewer.
    expect(direct).toMatchObject({
      ok: false,
      isolationAttested: false,
      isolationReasonCode: ReasonCode.ISOLATION_LOST,
    });
    expect(direct.error).toContain("REVIEWER_EGRESS_CONFIG_MISSING");
    expect(result).toMatchObject({ allowed: false, reasonCode: ReasonCode.ISOLATION_LOST });
  });

  it("#334 uses a packet-local reviewer home and reports answer failure separately", async () => {
    const setup = await prepareReviewedInputs();
    const claude = new HealthyProbeClaudeAdapter({
      clock: setup.harness.clock,
      capacityFile: join(setup.harness.root, "claude-capacity.json"),
      binary: "/bin/false",
    });
    const environment = reviewerEnvironment("/packet-root", "/provider-home");
    expect(environment.HOME).toBe("/packet-root");
    expect(environment.PATH).toContain("/usr/bin");
    expect(environment.CLAUDE_CONFIG_DIR).toBe("/provider-home");
    expect(claude.supportsReviewerIsolation).toBe(true);
    setup.harness.cp.providers.register(claude);
    const gate = new BlindReviewGate(
      setup.harness.cp.clock,
      setup.harness.cp.db,
      setup.harness.cp.audit,
      setup.harness.cp.artifacts,
      setup.harness.cp.evidenceWritersForTests().BLIND_REVIEW,
      setup.harness.cp.sessions,
      setup.harness.cp.bindings,
      setup.harness.cp.providers,
      setup.harness.cp.repositories,
      setup.harness.cp.telemetry,
      {
        preferred: { provider: "claude", model: "opus", effort: null },
        fallbacks: [],
      },
    );

    const result = await invokeGate(gate, setup);

    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe(ReasonCode.EVIDENCE_MISSING);
  });

  it("#335 reclaims a crashed submission lease only after its persisted deadline", async () => {
    const setup = await prepareReviewedInputs();
    setup.harness.cp.verification.verify = async () => allow(ReasonCode.OK, setup.verification);
    setup.harness.scripted.script({
      match: /Candidate review/,
      text: reviewerPass([`${setup.identity}:src/app.js`]),
    });
    const startedAt = new Date(setup.harness.clock.now().getTime() - 31 * 60 * 1000).toISOString();
    const deadlineAt = new Date(setup.harness.clock.now().getTime() + 60_000).toISOString();
    setup.harness.cp.db.run(
      `INSERT INTO candidate_pipeline_attempts
         (run_id, attempt_id, owner_session_id, owner_binding_generation, candidate_digest, state, started_at, deadline_at, released_at)
       VALUES (?, ?, ?, ?, NULL, 'RUNNING', ?, ?, NULL)`,
      [setup.run.runId, "attempt_crashed", "session-crashed", 1, startedAt, deadlineAt],
    );

    // The old started_at policy would reclaim here. The persisted deadline is the lease fact
    // that survives a daemon restart, so a policy change cannot shorten this holder's lease.
    expect(setup.harness.cp.pipeline.reclaimExpiredAttempts()).toEqual([]);
    setup.harness.clock.advance(60_000);
    const reclaimed = setup.harness.cp.pipeline.reclaimExpiredAttempts();

    expect(reclaimed).toEqual([expect.objectContaining({
      runId: setup.run.runId,
      attemptId: "attempt_crashed",
      startedAt,
      deadlineAt,
      ageMs: 32 * 60 * 1000,
    })]);
    expect(setup.harness.cp.db.get<{ state: string; released_at: string | null }>(
      `SELECT state, released_at FROM candidate_pipeline_attempts WHERE run_id = ?`,
      [setup.run.runId],
    )).toEqual({ state: "RELEASED", released_at: setup.harness.clock.nowIso() });

    const result = await setup.harness.cp.pipeline.submitResult({
      runId: setup.run.runId,
      ownerSessionId: setup.run.ownerSessionId!,
      ownerBindingGeneration: setup.run.ownerBindingGeneration!,
      resultSummary: "done",
      recommendation: "merge",
    });

    expect(result.allowed).toBe(true);
    expect(result.reasonCode).toBe(ReasonCode.OK);
  });

  it("#335 lets a new submission reclaim an expired crash lease and records the reclaim", async () => {
    const setup = await prepareReviewedInputs();
    setup.harness.cp.verification.verify = async () => allow(ReasonCode.OK, setup.verification);
    setup.harness.scripted.script({
      match: /Candidate review/,
      text: reviewerPass([`${setup.identity}:src/app.js`]),
    });
    const startedAt = new Date(setup.harness.clock.now().getTime() - 31 * 60 * 1000).toISOString();
    const deadlineAt = new Date(setup.harness.clock.now().getTime() - 1_000).toISOString();
    setup.harness.cp.db.run(
      `INSERT INTO candidate_pipeline_attempts
         (run_id, attempt_id, owner_session_id, owner_binding_generation, candidate_digest, state, started_at, deadline_at, released_at)
       VALUES (?, ?, ?, ?, NULL, 'RUNNING', ?, ?, NULL)`,
      [setup.run.runId, "attempt_crashed", "session-crashed", 1, startedAt, deadlineAt],
    );

    // Do not run the watchdog first: this is the daemon-restart path where acquireAttempt
    // must reclaim the expired durable row itself rather than returning CONFLICT forever.
    const result = await setup.harness.cp.pipeline.submitResult({
      runId: setup.run.runId,
      ownerSessionId: setup.run.ownerSessionId!,
      ownerBindingGeneration: setup.run.ownerBindingGeneration!,
      resultSummary: "done",
      recommendation: "merge",
    });

    expect(result.allowed).toBe(true);
    expect(result.reasonCode).toBe(ReasonCode.OK);
    expect(setup.harness.cp.audit.byKind("CANDIDATE_PIPELINE_ATTEMPT_RECLAIMED")).toHaveLength(1);
    expect(setup.harness.cp.audit.byKind("CANDIDATE_PIPELINE_ATTEMPT_RECLAIMED")[0]).toMatchObject({
      runId: setup.run.runId,
      reasonCode: ReasonCode.CANDIDATE_PIPELINE_ATTEMPT_STALE,
      evidence: expect.objectContaining({ attemptId: "attempt_crashed", deadlineAt, via: "acquire" }),
    });
  });

  it("#344 validates the owner before reserving the submission lease", async () => {
    const setup = await prepareReviewedInputs();
    setup.harness.cp.verification.verify = async () => allow(ReasonCode.OK, setup.verification);
    setup.harness.scripted.script({
      match: /Candidate review/,
      text: reviewerPass([`${setup.identity}:src/app.js`]),
    });
    const input = {
      runId: setup.run.runId,
      ownerSessionId: setup.run.ownerSessionId!,
      ownerBindingGeneration: setup.run.ownerBindingGeneration!,
      resultSummary: "done",
      recommendation: "merge",
    };

    const bogus = setup.harness.cp.pipeline.submitResult({ ...input, ownerSessionId: "not-the-owner" });
    const valid = setup.harness.cp.pipeline.submitResult(input);
    const rejected = await bogus;
    const accepted = await valid;

    expect(rejected.allowed).toBe(false);
    expect(rejected.reasonCode).toBe(ReasonCode.RUN_OWNER_REVOKED);
    expect(accepted.allowed).toBe(true);
    expect(accepted.reasonCode).toBe(ReasonCode.OK);
  });

  it("#360 requests denial of host provider conversation stores for every reviewer", async () => {
    const setup = await prepareReviewedInputs();
    const result = await directReview(setup);
    const invocation = setup.harness.scripted.invocations[0] as unknown as {
      workdir: string;
      isolation?: { denyReadPaths: string[] };
    };

    expect(result.allowed).toBe(true);
    expect(invocation.workdir).not.toBe(setup.harness.repoPath);
    expect(invocation.isolation?.denyReadPaths).toEqual(expect.arrayContaining([
      canonical(setup.harness.repoPath),
      canonical(join(homedir(), ".claude")),
      canonical(join(homedir(), ".codex")),
    ]));
  });

  it("#132 rejects a reviewer adapter that does not attest its requested isolation", async () => {
    const setup = await prepareReviewedInputs();
    const originalInvoke = setup.harness.scripted.invoke.bind(setup.harness.scripted);
    setup.harness.scripted.invoke = async (request) => ({
      ...(await originalInvoke(request)),
      isolationAttested: false,
    });

    const result = await directReview(setup);
    const invocation = setup.harness.scripted.invocations[0] as unknown as {
      workdir: string;
      isolation?: { packetRoot: string; emptyEnvironment: boolean; network: string; tools: string; denyReadPaths: string[] };
    };

    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe(ReasonCode.ISOLATION_LOST);
    expect(invocation.isolation).toEqual(expect.objectContaining({
      packetRoot: invocation.workdir,
      emptyEnvironment: true,
      network: "provider-only",
      tools: "none",
    }));
    expect(invocation.isolation?.denyReadPaths).toContain(canonical(setup.harness.repoPath));
  });

  it("#419 rejects an attestation that is missing this invocation's proxy JSONL evidence", async () => {
    const setup = await prepareReviewedInputs();
    const originalInvoke = setup.harness.scripted.invoke.bind(setup.harness.scripted);
    setup.harness.scripted.invoke = async (request) => {
      const result = await originalInvoke(request);
      if (!request.isolation) return result;
      const { egressEvidence: _discarded, ...withoutEgress } = result;
      return { ...withoutEgress, isolationAttested: true };
    };

    const result = await directReview(setup);

    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe(ReasonCode.ISOLATION_LOST);
    // Removing the gate's non-empty egress-evidence check makes this a false PASS.
  });

  it("#419 treats a durable unexpected proxy ALLOW as ISOLATION_LOST", async () => {
    const setup = await prepareReviewedInputs();
    const originalInvoke = setup.harness.scripted.invoke.bind(setup.harness.scripted);
    setup.harness.scripted.invoke = async (request) => {
      const result = await originalInvoke(request);
      if (!request.isolation || !result.egressEvidence) return result;
      return {
        ...result,
        egressEvidence: result.egressEvidence.map((record) => ({
          ...record,
          jsonl: `${record.jsonl}${JSON.stringify({ t: 4, verdict: "ALLOW", host: "evil.example", port: 443 })}\n`,
        })),
      };
    };

    const result = await directReview(setup);

    expect(result).toMatchObject({
      allowed: false,
      reasonCode: ReasonCode.ISOLATION_LOST,
      evidence: { problem: "unexpected-allow-jsonl" },
    });
    // Deleting reviewerEgressRecordProblem's all-ALLOW allowlist check turns this into a
    // false PASS, so the exact problem assertion guards the independent artifact reader.
  });

  it("#419 refuses an adapter-selected allowlist that differs from daemon policy", async () => {
    const setup = await prepareReviewedInputs();
    const originalInvoke = setup.harness.scripted.invoke.bind(setup.harness.scripted);
    setup.harness.scripted.invoke = async (request) => {
      const result = await originalInvoke(request);
      if (!request.isolation) return result;
      const allowedHost = "evil.example";
      const allowlistDigest = sha256(`${allowedHost}\n`);
      return {
        ...result,
        egressEvidence: [{
          provider: "scripted",
          allowedEndpoints: [allowedHost],
          allowlistDigest,
          proxyPort: 18_443,
          phase: "reviewer-invocation",
          jsonl: [
            JSON.stringify({ t: 1, verdict: "START", port: 18_443, pid: 1, allowlistDigest }),
            JSON.stringify({ t: 2, verdict: "ALLOW", host: allowedHost, port: 443 }),
            JSON.stringify({ t: 3, verdict: "DENY", host: "api.openai.com", port: 443 }),
          ].join("\n") + "\n",
          probes: {
            allowedEndpoint: { host: allowedHost, connected: true, statusCode: 200 },
            deniedEndpoint: { host: "api.openai.com", denied: true, statusCode: 403 },
            directSocket: [
              { host: allowedHost, proxyMode: "unset", connected: false, blocked: true, errorCode: "EPERM" },
              { host: allowedHost, proxyMode: "override", connected: false, blocked: true, errorCode: "EPERM" },
            ],
          },
        }],
      };
    };

    const result = await directReview(setup);

    expect(result).toMatchObject({
      allowed: false,
      reasonCode: ReasonCode.ISOLATION_LOST,
      evidence: { problem: "allowlist-policy-mismatch" },
    });
    // Removing the exact daemon-policy comparison makes this internally consistent forged
    // JSONL pass, which is the gate-shape failure the attestation must prevent.
  });

  it("#419 rejects a durable record whose proxy START digest is not the generated allowlist", async () => {
    const setup = await prepareReviewedInputs();
    const originalInvoke = setup.harness.scripted.invoke.bind(setup.harness.scripted);
    setup.harness.scripted.invoke = async (request) => {
      const result = await originalInvoke(request);
      if (!request.isolation || !result.egressEvidence) return result;
      return {
        ...result,
        egressEvidence: result.egressEvidence.map((record) => ({
          ...record,
          jsonl: record.jsonl.replace(record.allowlistDigest, `sha256:${"0".repeat(64)}`),
        })),
      };
    };

    const result = await directReview(setup);

    expect(result).toMatchObject({
      allowed: false,
      reasonCode: ReasonCode.ISOLATION_LOST,
      evidence: { problem: "allowlist-binding-missing" },
    });
    // Deleting the START-digest comparison leaves all other probe lines consistent and
    // makes this forged binding pass through the independent reader.
  });

  it("#419 rejects .invalid as durable deny evidence", async () => {
    const setup = await prepareReviewedInputs();
    const originalInvoke = setup.harness.scripted.invoke.bind(setup.harness.scripted);
    setup.harness.scripted.invoke = async (request) => {
      const result = await originalInvoke(request);
      if (!request.isolation || !result.egressEvidence) return result;
      return {
        ...result,
        egressEvidence: result.egressEvidence.map((record) => ({
          ...record,
          jsonl: record.jsonl.replace("api.openai.com", "acp-deny.invalid"),
          probes: {
            ...record.probes,
            deniedEndpoint: { host: "acp-deny.invalid", denied: true, statusCode: 403 },
          },
        })),
      };
    };

    const result = await directReview(setup);

    expect(result).toMatchObject({
      allowed: false,
      reasonCode: ReasonCode.ISOLATION_LOST,
      evidence: { problem: "real-deny-probe-missing" },
    });
    // Deleting the controlled-real-host check lets a resolver-only .invalid denial stand
    // in for provider-only reachability evidence.
  });

  it("#419 stores verbatim egress JSONL inside the snapshot-bound BLIND_REVIEW digest", async () => {
    const setup = await prepareReviewedInputs();
    const result = await directReview(setup);
    expect(result.allowed).toBe(true);
    const artifact = setup.harness.cp.artifacts.latest<ReviewPacket>(setup.run.runId, "BLIND_REVIEW");
    if (!artifact) throw new Error("blind-review evidence was not stored");

    expect(artifact.content.egressEvidence).toHaveLength(1);
    expect(artifact.content.egressEvidence[0]?.jsonl).toContain('"verdict":"ALLOW"');
    expect(artifact.content.egressEvidence[0]?.jsonl).toContain('"verdict":"DENY"');
    expect(artifactDigestMatches(artifact)).toBe(true);
    const record = artifact.content.egressEvidence[0];
    if (!record) throw new Error("blind-review egress record was not stored");
    const { allowlistDigest: _discardedDigest, ...unboundRecord } = record;
    expect(() => setup.harness.cp.artifacts.putEvidence(
      setup.harness.cp.evidenceWritersForTests().BLIND_REVIEW,
      setup.run.runId,
      "BLIND_REVIEW",
      { ...artifact.content, egressEvidence: [unboundRecord] },
      artifact.candidateSnapshotDigest!,
    )).toThrow("BLIND_REVIEW has an invalid evidence envelope");
    const tampered = {
      ...artifact,
      content: {
        ...artifact.content,
        egressEvidence: artifact.content.egressEvidence.map((record, index) => index === 0
          ? { ...record, jsonl: `${record.jsonl}{"t":4,"verdict":"ALLOW","host":"tampered.test","port":443}\n` }
          : record),
      },
    };
    expect(artifactDigestMatches(tampered)).toBe(false);
    // Removing the artifact schema's required allowlist digest makes the unbound-record
    // refusal pass; weakening the snapshot-bound digest makes the JSONL mutation assertion
    // flip.
  });

  it("#360 rejects an adapter that contradicts its isolation attestation", async () => {
    const setup = await prepareReviewedInputs();
    const originalInvoke = setup.harness.scripted.invoke.bind(setup.harness.scripted);
    setup.harness.scripted.invoke = async (request) => ({
      ...(await originalInvoke(request)),
      isolationAttested: true,
      isolationReasonCode: ReasonCode.ISOLATION_LOST,
    });

    const result = await directReview(setup);

    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe(ReasonCode.ISOLATION_LOST);
  });

  it("#133 rejects a PASS response that omits required evidence fields", () => {
    expect(__testing.parseVerdict({ verdict: "PASS", coveredFiles: ["github:acme/fixture:src/app.js"] })).toBeNull();
    expect(__testing.parseVerdict({ verdict: "PASS", coveredFiles: [], omittedItems: [], findings: [{}] })).toBeNull();
  });

  it("#134 supplies the complete verification report to the reviewer", async () => {
    const setup = await prepareReviewedInputs();
    const result = await directReview(setup);
    expect(result.allowed).toBe(true);
    const prompt = setup.harness.scripted.invocations[0]!.prompt;
    expect(prompt).toContain("repositoryIdentity");
    expect(prompt).toContain("outputDigest");
    expect(prompt).toContain("reasonCode");
    expect(prompt).toContain("gaps");
    expect(prompt).toMatch(/Packet digest: sha256:[a-f0-9]{64}/);
    expect(prompt).toContain("Required coverage:");
    expect(prompt).toContain(`${setup.identity}:src/app.js`);
    // Removing the packet digest or coverage manifest leaves a reviewer able to return a
    // syntactically valid PASS without seeing the complete packet commitment.
  });

  it("#135 range-splits an oversized single-file patch", () => {
    const header = "diff --git a/large.ts b/large.ts\n";
    const payload = Array.from({ length: 250 }, (_, index) => index.toString(36).padStart(4, "0")).join("");
    const chunks = __testing.splitDiffs([{
      identity: "github:acme/fixture",
      diff: `${header}${payload}`,
      files: ["large.ts"],
    }], 100);
    const parts = chunks.flat();
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((part) => part.diff.length <= 100)).toBe(true);
    expect(parts.every((part) => part.files.length === 1 && part.files[0] === "large.ts")).toBe(true);
    expect(parts.map((part) => part.diff.slice(header.length)).join("")).toBe(payload);
  });

  it("#136 supplies a digest-bound git binary patch instead of permanently omitting it", async () => {
    const setup = await prepareReviewedInputs();
    writeFiles(setup.harness.repoPath, { "asset.bin": `\u0000${"binary".repeat(20)}` });
    commitAll(setup.harness.repoPath, "add binary asset");
    const frozen = await setup.harness.cp.pipeline.freeze(setup.run.runId);
    if (!frozen.allowed) throw new Error(frozen.message);
    const verification = persistPassingVerification(setup, frozen.value);
    setup.harness.scripted.script({ match: /Candidate review/, text: reviewerPass([`${setup.identity}:src/app.js`, `${setup.identity}:asset.bin`]) });
    const result = await setup.harness.cp.review.controlPlaneInvoker()({
      runId: setup.run.runId,
      projectId: setup.projectId,
      executionMode: setup.run.executionMode,
      snapshot: frozen.value,
      contract: CONTRACT,
      contractDigest: setup.run.contractDigest,
      verification,
    });
    expect(result.allowed).toBe(true);
    expect(result.allowed && result.value.omittedItems).toEqual([]);
    expect(result.allowed && result.value.inputManifest.binaryArtifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "asset.bin", method: "git-binary-patch" }),
    ]));
  });

  it("#219 persists a PASS with omissions as REVISE before audit or telemetry", async () => {
    const setup = await prepareReviewedInputs();
    const response = JSON.stringify({
      verdict: "PASS",
      coveredFiles: [`${setup.identity}:src/app.js`],
      omittedItems: ["unreadable generated file"],
      findings: [],
    });
    const result = await directReview(setup, response);
    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe(ReasonCode.REVIEW_REVISE);
    const packet = setup.harness.cp.review.latestPacket(setup.run.runId, candidateSnapshotDigest(setup.snapshot));
    expect(packet?.verdict).toBe("REVISE");
    expect(setup.harness.cp.audit.byKind("BLIND_REVIEW_COMPLETED")[0]?.reasonCode).toBe(ReasonCode.REVIEW_REVISE);
  });

  it("#220 refuses a diff whose digest no longer matches the frozen candidate", async () => {
    const setup = await prepareReviewedInputs();
    const forged = structuredClone(setup.snapshot);
    forged.repositories[0]!.diffDigest = "sha256:forged-diff-digest";
    const digest = candidateSnapshotDigest(forged);
    setup.harness.cp.artifacts.put(setup.run.runId, "CANDIDATE_SNAPSHOT", forged, digest);
    setup.harness.cp.runs.promoteCandidate(setup.run.runId, digest);
    const verification = persistPassingVerification(setup, forged);
    setup.harness.scripted.script({ match: /Candidate review/, text: reviewerPass([`${setup.identity}:src/app.js`]) });
    const result = await setup.harness.cp.review.controlPlaneInvoker()({
      runId: setup.run.runId,
      projectId: setup.projectId,
      executionMode: setup.run.executionMode,
      snapshot: forged,
      contract: CONTRACT,
      contractDigest: setup.run.contractDigest,
      verification,
    });
    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe(ReasonCode.EVIDENCE_STALE);
  });

  it("#220 refuses a candidate repository that has no registry binding", async () => {
    const setup = await prepareReviewedInputs();
    const forged = structuredClone(setup.snapshot);
    forged.repositories[0]!.identity = "github:acme/unregistered";
    const digest = candidateSnapshotDigest(forged);
    setup.harness.cp.artifacts.put(setup.run.runId, "CANDIDATE_SNAPSHOT", forged, digest);
    setup.harness.cp.runs.promoteCandidate(setup.run.runId, digest);
    const verification = persistPassingVerification(setup, forged);
    const result = await setup.harness.cp.review.controlPlaneInvoker()({
      runId: setup.run.runId,
      projectId: setup.projectId,
      executionMode: setup.run.executionMode,
      snapshot: forged,
      contract: CONTRACT,
      contractDigest: setup.run.contractDigest,
      verification,
    });
    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe(ReasonCode.EVIDENCE_MISSING);
  });

  it("#221 evaluates continuity for reviewer isolation loss and does not request revision", async () => {
    const setup = await prepareReviewedInputs();
    setup.harness.cp.verification.verify = async () => allow(ReasonCode.OK, setup.verification);
    let evaluations = 0;
    setup.harness.cp.pipeline.attach({ continuity: { evaluate: async () => { evaluations += 1; } } });
    setup.harness.scripted.setRuntimeHealth("UNAVAILABLE");
    const result = await setup.harness.cp.pipeline.submitResult({
      runId: setup.run.runId,
      ownerSessionId: setup.run.ownerSessionId!,
      ownerBindingGeneration: setup.run.ownerBindingGeneration!,
      resultSummary: "done",
      recommendation: "merge",
    });
    expect(result.allowed).toBe(true);
    if (!result.allowed || result.value.stage !== "REVIEW_UNAVAILABLE") {
      throw new Error(`expected REVIEW_UNAVAILABLE, received ${result.allowed ? result.value.stage : result.reasonCode}`);
    }
    expect(result.value.reasonCode).toBe(ReasonCode.ISOLATION_LOST);
    // #512 — the code alone names about twenty possible causes across the reviewer path, so the
    // stage carries the denial that produced it. A live run failed with exactly this code and
    // nothing else, and the cause could not be localised from the answer the caller received.
    expect(
      result.value.detail.message,
      "REVIEW_UNAVAILABLE reported a code with no statement of which check refused",
    ).toBeTruthy();
    expect(Object.keys(result.value.detail.evidence).length).toBeGreaterThan(0);
    expect(evaluations).toBe(1);
    expect(setup.harness.cp.audit.byKind("REVISION_RETURNED_TO_CTO")).toHaveLength(0);
  });
});
