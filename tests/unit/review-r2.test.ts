import { afterAll, describe, expect, it } from "vitest";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ExecutionMode } from "../../src/domain/types.ts";
import { BlindReviewGate, __testing } from "../../src/review/blind-review.ts";
import { CandidatePipeline } from "../../src/run/candidate-pipeline.ts";
import { canonical } from "../../src/guard/workspace-probe.ts";
import { ClaudeCliAdapter, CodexCliAdapter, reviewerEnvironment } from "../../src/runtime/cli-adapters.ts";
import type { InvocationRequest, InvocationResult } from "../../src/runtime/provider.ts";
import type { TaskContract } from "../../src/run/run-engine.ts";
import { candidateSnapshotDigest } from "../../src/snapshot/candidate-snapshot.ts";
import type { CandidateSnapshot } from "../../src/snapshot/candidate-snapshot.ts";
import type { VerificationReport } from "../../src/verify/verification-engine.ts";
import { cleanupTempDirs, commitAll, writeFiles } from "../helpers/fixtures.ts";
import {
  applyPassingChange,
  bindCeo,
  makeHarness,
  registerFixtureProject,
  reviewerPass,
} from "../helpers/harness.ts";
import { TestProductionAdapter } from "../helpers/production-adapter.ts";

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
  const execution = harness.cp.tasks.startExecution({
    runId: run.runId,
    taskId: task.taskId,
    ownerBindingGeneration: run.ownerBindingGeneration!,
    workerSessionId: run.ownerSessionId,
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

const writeAttestingReviewerStub = (directory: string, coveredFiles: readonly string[]): string => {
  const binary = join(directory, "attesting-reviewer.mjs");
  writeFileSync(
    binary,
    `#!${process.execPath}
const sessionIndex = process.argv.indexOf("--session-id");
const sessionId = sessionIndex >= 0 ? process.argv[sessionIndex + 1] : null;
const result = ${JSON.stringify(reviewerPass([...coveredFiles]))};
process.stdout.write(JSON.stringify({ result, session_id: sessionId }));
`,
  );
  chmodSync(binary, 0o700);
  return binary;
};

const seatbeltCanApply = (): boolean =>
  process.platform === "darwin" &&
  existsSync("/usr/bin/sandbox-exec") &&
  spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1)\n(allow default)", "/usr/bin/true"]).status === 0;

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
    };
  }
}

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

  it("#128 records the final chunk reviewer's binding as authoritative", async () => {
    const setup = await prepareReviewedInputs();
    writeFiles(setup.harness.repoPath, { "src/app.js": `module.exports = () => 2;\n// ${"x".repeat(130_000)}\n` });
    commitAll(setup.harness.repoPath, "large reviewed change");
    const frozen = await setup.harness.cp.pipeline.freeze(setup.run.runId);
    if (!frozen.allowed) throw new Error(frozen.message);
    const verification = persistPassingVerification(setup, frozen.value);
    setup.harness.scripted.script(
      { match: /Review chunk/, text: reviewerPass([`${setup.identity}:src/app.js`]), once: false },
      { match: /Final review/, text: reviewerPass([]) },
    );
    const result = await setup.harness.cp.review.controlPlaneInvoker()({
      runId: setup.run.runId,
      projectId: setup.projectId,
      executionMode: setup.run.executionMode,
      snapshot: frozen.value,
      contract: CONTRACT,
      contractDigest: setup.run.contractDigest,
      verification,
    });
    if (!result.allowed) throw new Error(`${result.reasonCode}: ${result.message}`);
    expect(result.value.chunked).toBe(true);
    expect(result.value.reviewerRoleBindingGeneration).toBe(2);
    expect(setup.harness.cp.sessions.require(result.value.reviewerSessionId).lifecycle).toBe("STOPPED");
  });

  it("#129 rejects a chunk reviewer claiming a path assigned to another chunk", () => {
    const coverage = __testing.validateChunkCoverage(["github:acme/fixture:two.ts"], [{
      identity: "github:acme/fixture",
      diff: "diff --git a/one.ts b/one.ts\n",
      files: ["one.ts"],
    }]);
    expect(coverage.allowed).toBe(false);
    expect(coverage.reasonCode).toBe(ReasonCode.COVERAGE_INCOMPLETE);
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

  it("#333 skips a preferred adapter that cannot attest reviewer isolation", async () => {
    const setup = await prepareReviewedInputs();
    const preferred = new CodexCliAdapter({
      clock: setup.harness.clock,
      capacityFile: join(setup.harness.root, "gpt-capacity.json"),
      binary: "codex-not-used-by-reviewer-capability-test",
    });
    let probes = 0;
    preferred.probeRuntime = async () => {
      probes += 1;
      return "HEALTHY";
    };
    const fallback = new TestProductionAdapter(setup.harness.clock, "claude");
    fallback.script({
      match: /Candidate review/,
      text: reviewerPass([`${setup.identity}:src/app.js`]),
    });
    setup.harness.cp.providers.register(preferred);
    setup.harness.cp.providers.register(fallback);

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
        preferred: { provider: "gpt", model: "gpt-5.6-sol", effort: "xhigh" },
        fallbacks: [{ provider: "claude", model: "opus", effort: null }],
      },
    );
    const result = await invokeGate(gate, setup);

    expect(result.allowed).toBe(true);
    expect(result.reasonCode).toBe(ReasonCode.REVIEW_PASS);
    expect(result.allowed && result.value.provider).toBe("claude");
    expect(probes).toBe(0);
  });

  it("#332 accepts a packet only after the real reviewer adapter attests isolation", async () => {
    const setup = await prepareReviewedInputs();
    const claude = new ClaudeCliAdapter({
      clock: setup.harness.clock,
      capacityFile: join(setup.harness.root, "claude-capacity.json"),
      binary: writeAttestingReviewerStub(setup.harness.root, [`${setup.identity}:src/app.js`]),
    });
    const canApplySeatbelt = seatbeltCanApply();
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

    if (!canApplySeatbelt) {
      // A real adapter must expose an unapplied profile as an isolation loss, never as a PASS.
      expect(direct).toMatchObject({
        ok: false,
        isolationAttested: false,
        isolationReasonCode: ReasonCode.ISOLATION_LOST,
      });
      expect(result).toMatchObject({ allowed: false, reasonCode: ReasonCode.ISOLATION_LOST });
      return;
    }

    expect(direct).toMatchObject({
      ok: true,
      isolationAttested: true,
      isolationReasonCode: undefined,
    });
    expect(result).toMatchObject({
      allowed: true,
      reasonCode: ReasonCode.REVIEW_PASS,
      value: { provider: "claude" },
    });
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

  it("#132 gives the reviewer an empty packet-only working directory", async () => {
    const setup = await prepareReviewedInputs();
    const result = await directReview(setup);
    expect(result.allowed).toBe(true);
    expect(setup.harness.scripted.invocations[0]?.workdir).not.toBe(setup.harness.repoPath);
    expect(result.allowed && result.value.inputManifest.withheld).toContain("daemon state");
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
    expect(evaluations).toBe(1);
    expect(setup.harness.cp.audit.byKind("REVISION_RETURNED_TO_CTO")).toHaveLength(0);
  });
});
