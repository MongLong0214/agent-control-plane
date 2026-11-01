import { afterAll, describe, expect, it, vi } from "vitest";
import { chmodSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { allow } from "../../src/core/errors.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { sha256 } from "../../src/core/digest.ts";
import { hasCredentialShape } from "../../src/core/credential-shapes.ts";
import { artifactDigestMatches } from "../../src/db/artifacts.ts";
import { ExecutionMode, Role, roleKeyFor } from "../../src/domain/types.ts";
import { BlindReviewGate, REVIEWER_FALLBACK_SCOPE_UNCONFIGURED, __testing, type ReviewPacket } from "../../src/review/blind-review.ts";
import { CandidatePipeline } from "../../src/run/candidate-pipeline.ts";
import { canonical } from "../../src/guard/workspace-probe.ts";
import { diffPatch } from "../../src/git/git.ts";
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

/** `base`: files the run's base commit holds besides the fixture's own. */
const prepareReviewedInputs = async (base: Record<string, string> = {}) => {
  const harness = makeHarness();
  if (Object.keys(base).length > 0) {
    writeFiles(harness.repoPath, base);
    commitAll(harness.repoPath, "base files");
  }
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

it("re-reviews the same candidate after an accepted 55,000-character MINOR finding within budget", async () => {
  const setup = await prepareReviewedInputs();
  try {
    const finding = { category: "correctness", severity: "MINOR", repository: setup.identity,
      // Long but not credential-shaped: one unbroken 55,000-character run is the long-base64 shape,
      // which ACP redacts before storing (the next test).
      path: "src/app.js", summary: "nonblocking observation", detail: "x ".repeat(27_500) };
    const first = await directReview(setup, JSON.stringify({ verdict: "PASS",
      coveredFiles: [`${setup.identity}:src/app.js`], omittedItems: [], findings: [finding] }));
    expect(first).toMatchObject({ allowed: true, value: { verdict: "PASS", findings: [finding] } });
    const before = setup.harness.scripted.invocations.length;
    const second = await directReview(setup);
    expect(second.allowed, JSON.stringify(second)).toBe(true);
    expect(setup.harness.scripted.invocations.length).toBeGreaterThan(before);
    for (const call of setup.harness.scripted.invocations.slice(before)) {
      expect(call.prompt.length + (call.systemPrompt?.length ?? 0)).toBeLessThanOrEqual(120_000);
    }
    // The finding remains intact in its immutable evidence artifact, as on main.
    expect(setup.harness.cp.artifacts.list<ReviewPacket>(setup.run.runId, "BLIND_REVIEW")[0]!.content.findings).toEqual([finding]);
  } finally {
    setup.harness.cp.close();
  }
});

it("#1254 G-4: a finding's credential-shaped text refuses the review at storage; the refusal is recorded without it", async () => {
  const setup = await prepareReviewedInputs();
  try {
    const run = "Ab9+/Zq7".repeat(10);
    const digest = `sha256:${"0123456789abcdef".repeat(4)}`;
    const token = `ghp_${"A1b2C3d4".repeat(5)}`;
    const finding = { category: "correctness", severity: "MINOR", repository: setup.identity, path: "src/app.js",
      summary: "nonblocking observation", detail: `the log printed ${token} next to ${run}; see ${digest}` };
    const plain = { ...finding, summary: "second observation", detail: "nothing secret here" };
    const reviewed = await directReview(setup, JSON.stringify({ verdict: "PASS",
      coveredFiles: [`${setup.identity}:src/app.js`], omittedItems: [], findings: [finding, plain] }));
    // Checked as the reviewer wrote it, before anything is stored: no review is stored, rewritten or kept raw.
    expect(reviewed, JSON.stringify(reviewed)).toMatchObject({ allowed: false, reasonCode: ReasonCode.TRUSTED_CREDENTIAL_LEAK_BLOCKED });
    expect(setup.harness.cp.artifacts.list<ReviewPacket>(setup.run.runId, "BLIND_REVIEW")).toEqual([]);
    const audit = setup.harness.cp.audit.forRun(setup.run.runId);
    const refusal = audit.filter((row) => row.kind === "BLIND_REVIEW_STORAGE_REFUSED");
    expect(refusal).toHaveLength(1);
    expect(refusal[0]!.evidence).toMatchObject({ candidateSnapshotDigest: candidateSnapshotDigest(setup.snapshot), kind: "BLIND_REVIEW", field: "detail", verdict: "PASS", findings: 2 });
    expect(audit.filter((row) => row.kind === "BLIND_REVIEW_COMPLETED")).toEqual([]);
    expect(JSON.stringify(audit)).not.toContain(token);
    expect(JSON.stringify(audit)).not.toContain(run);
  } finally {
    setup.harness.cp.close();
  }
});

it("chunks when the serialized input exceeds the budget although raw-patch accounting fits", async () => {
  const setup = await prepareReviewedInputs();
  try {
    // Capture a real single review to size the boundary fixture without pinning prompt wording.
    const first = await directReview(setup);
    if (!first.allowed) throw new Error(first.message);
    const baseline = setup.harness.scripted.invocations.at(-1)!;
    const baselineChars = baseline.prompt.length + (baseline.systemPrompt?.length ?? 0);
    const repo = setup.snapshot.repositories[0]!;
    const originalDiff = await diffPatch(setup.harness.repoPath, repo.baseHead, repo.candidateHead);
    const formattedDiff = [`### ${setup.identity}`, "Files:", "- src/app.js", "```diff", originalDiff, "```", ""].join("\n");
    expect(baseline.prompt).toContain(formattedDiff);
    const framingChars = formattedDiff.length - originalDiff.length;
    const targetChars = 120_010;
    const oldEstimate = targetChars - framingChars;
    expect(oldEstimate).toBeLessThanOrEqual(120_000);

    // Extending the existing line changes only patch bytes; all bound IDs keep their widths.
    const padding = targetChars - baselineChars - " // ".length;
    expect(padding).toBeGreaterThan(0);
    writeFiles(setup.harness.repoPath, { "src/app.js": `module.exports = () => 2; // ${"x".repeat(padding)}\n` });
    const head = commitAll(setup.harness.repoPath, "near-budget candidate");
    const diff = await diffPatch(setup.harness.repoPath, repo.baseHead, head);
    expect(baselineChars + diff.length - originalDiff.length).toBe(targetChars);
    const frozen = await setup.harness.cp.pipeline.freeze(setup.run.runId);
    if (!frozen.allowed) throw new Error(frozen.message);
    const next = { ...setup, snapshot: frozen.value, verification: persistPassingVerification(setup, frozen.value) };
    const before = setup.harness.scripted.invocations.length;
    setup.harness.scripted.script(
      { match: /Candidate review|Review chunk/, text: reviewerPass([`${setup.identity}:src/app.js`]), once: false },
      { match: /Final review/, text: reviewerPass([]) },
    );
    const result = await invokePreparedReview(next);
    const calls = setup.harness.scripted.invocations.slice(before);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.prompt.length + (call.systemPrompt?.length ?? 0), `old estimate: ${oldEstimate}`).toBeLessThanOrEqual(120_000);
    }
    expect(result).toMatchObject({ allowed: true, value: { verdict: "PASS", chunked: true } });
    expect(calls.filter(call => call.prompt.startsWith("# Review chunk")).length).toBeGreaterThan(1);
    expect(calls.filter(call => call.prompt.startsWith("# Final review"))).toHaveLength(1);
  } finally {
    setup.harness.cp.close();
  }
});

/**
 * #1208 — the chunk decision compares `prompt.length + systemPrompt.length` (the budget this test
 * measures as `baselineChars`, scaled by the diff's growth) against the 120,000-char threshold. The
 * adapter that actually sends this to the reviewer CLI joins the two with a `\n\n---\n\n` separator
 * (`REVIEWER_TRANSPORT_SEPARATOR` in `src/runtime/cli-adapters.ts`), seven more characters the
 * decision must count. Landing the combined length exactly on the threshold is the case that fits
 * only if that separator is left uncounted: before the fix it was accepted unchunked and reached
 * the CLI seven characters over budget; this proves it is chunked instead.
 */
it("chunks an input landing exactly on the 120,000-char threshold (separator must be counted)", async () => {
  const setup = await prepareReviewedInputs();
  try {
    // Capture a real single review to size the boundary fixture without pinning prompt wording.
    const first = await directReview(setup);
    if (!first.allowed) throw new Error(first.message);
    const baseline = setup.harness.scripted.invocations.at(-1)!;
    const baselineChars = baseline.prompt.length + (baseline.systemPrompt?.length ?? 0);
    const repo = setup.snapshot.repositories[0]!;
    const originalDiff = await diffPatch(setup.harness.repoPath, repo.baseHead, repo.candidateHead);
    const targetChars = 120_000;

    // Extending the existing line changes only patch bytes; all bound IDs keep their widths.
    const padding = targetChars - baselineChars - " // ".length;
    expect(padding).toBeGreaterThan(0);
    writeFiles(setup.harness.repoPath, { "src/app.js": `module.exports = () => 2; // ${"x".repeat(padding)}\n` });
    const head = commitAll(setup.harness.repoPath, "exactly-at-budget candidate");
    const diff = await diffPatch(setup.harness.repoPath, repo.baseHead, head);
    expect(baselineChars + diff.length - originalDiff.length).toBe(targetChars);
    const frozen = await setup.harness.cp.pipeline.freeze(setup.run.runId);
    if (!frozen.allowed) throw new Error(frozen.message);
    const next = { ...setup, snapshot: frozen.value, verification: persistPassingVerification(setup, frozen.value) };
    const before = setup.harness.scripted.invocations.length;
    setup.harness.scripted.script(
      { match: /Candidate review|Review chunk/, text: reviewerPass([`${setup.identity}:src/app.js`]), once: false },
      { match: /Final review/, text: reviewerPass([]) },
    );
    const result = await invokePreparedReview(next);
    const calls = setup.harness.scripted.invocations.slice(before);
    expect(calls.length).toBeGreaterThan(0);
    expect(result).toMatchObject({ allowed: true, value: { verdict: "PASS", chunked: true } });
    expect(calls.filter(call => call.prompt.startsWith("# Review chunk")).length).toBeGreaterThan(1);
    expect(calls.filter(call => call.prompt.startsWith("# Final review"))).toHaveLength(1);
  } finally {
    setup.harness.cp.close();
  }
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

/**
 * A GPT reviewer that *was* isolated and then did not answer its identity handshake.
 *
 * The distinction is the adapter's own order: `startPacketReviewerSession` verifies
 * `isolationEnforced` and the egress evidence *before* the handshake can time out, so a timeout is
 * never evidence about the boundary. Measured on #512 — the reviewer capsule's credential had not
 * refreshed in five days, the one-word handshake spent its whole 60s budget, and the run was
 * reported as "preferred reviewer isolation could not be proved".
 */
class HandshakeTimeoutGptAdapter extends TestProductionAdapter {
  readonly supportsReviewerIsolation = true;
  readonly requiresReviewerProviderSessionProof = true;

  override async startSession(_spec: SessionSpec): Promise<never> {
    throw new ProviderSessionProvisionError(
      ReasonCode.REVIEWER_SESSION_HANDSHAKE_TIMEOUT,
      "Codex reviewer session identity handshake timed out",
    );
  }
}

/**
 * A GPT reviewer that answered its identity handshake in a shape with no resumable session id.
 *
 * The third of the three ways `startPacketReviewerSession` can fail after proving isolation, and
 * the last one that was reported as lost isolation. #969.
 */
class UnreadableAnswerGptAdapter extends TestProductionAdapter {
  readonly supportsReviewerIsolation = true;
  readonly requiresReviewerProviderSessionProof = true;

  override async startSession(_spec: SessionSpec): Promise<never> {
    throw new ProviderSessionProvisionError(
      ReasonCode.REVIEWER_SESSION_UNREADABLE_ANSWER,
      "Codex did not report a provider thread id for the packet reviewer session",
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
    preferred: { provider: preferred.provider, model: "gpt-6.1-sol", effort: "xhigh" },
    fallbacks: [{ provider: fallback.provider, model: "opus", effort: null }],
  },
);

const roleReviewRequest = (setup: Awaited<ReturnType<typeof prepareReviewedInputs>>) => ({
  runId: setup.run.runId,
  projectId: setup.projectId,
  executionMode: setup.run.executionMode,
  snapshot: setup.snapshot,
  contract: CONTRACT,
  contractDigest: setup.run.contractDigest,
  verification: setup.verification,
});

describe("review role caller selection", () => {
  it.each(["unscoped", "scoped", "mixed"])("constitutes only the %s reviewer identity", async (mode) => {
    const setup = await prepareReviewedInputs();
    const { cp, clock } = setup.harness;
    let workdir: string | undefined;
    try {
      const selected = new TestProductionAdapter(clock, "gpt");
      const wrong = new TestProductionAdapter(clock, "gpt");
      if (mode === "unscoped") cp.providers.register(selected);
      else {
        cp.providers.registerForRole(selected, Role.BLIND_REVIEWER);
        cp.providers.registerForRole(wrong, Role.PRIMARY_CTO);
        if (mode === "mixed") cp.providers.register(wrong);
      }
      const start = vi.spyOn(selected, "startSession");
      const wrongStart = vi.spyOn(wrong, "startSession");
      const gate = gateWithReviewerPreferences(setup, selected, new TestProductionAdapter(clock, "claude"));
      const result = await gate["constituteReviewer"](roleReviewRequest(setup));
      if (result.allowed) workdir = result.value.workdir;
      expect(result.allowed).toBe(true);
      expect(start).toHaveBeenCalledOnce();
      expect(wrongStart).not.toHaveBeenCalled();
    } finally {
      if (workdir) rmSync(workdir, { recursive: true, force: true });
      cp.close();
    }
  });

  it("refuses a configured preferred outage, and keeps an UNCONFIGURED-scope fallback on the reviewer identity", async () => {
    const setup = await prepareReviewedInputs();
    const { cp, clock } = setup.harness;
    let workdir: string | undefined;
    try {
      const preferred = new TestProductionAdapter(clock, "gpt");
      preferred.setRuntimeHealth("UNAVAILABLE");
      const fallback = new TestProductionAdapter(clock, "claude");
      const wrong = new TestProductionAdapter(clock, "claude");
      cp.providers.registerForRole(preferred, Role.BLIND_REVIEWER);
      cp.providers.registerForRole(fallback, Role.BLIND_REVIEWER);
      cp.providers.registerForRole(wrong, Role.PRIMARY_CTO);
      const start = vi.spyOn(fallback, "startSession");
      const wrongStart = vi.spyOn(wrong, "startSession");
      const gate = gateWithReviewerPreferences(setup, preferred, fallback);
      // CEO 1792123922: a measured outage of a configured preferred reviewer is no fallback.
      expect(await gate["constituteReviewer"](roleReviewRequest(setup))).toMatchObject({
        allowed: false, reasonCode: ReasonCode.ISOLATION_LOST,
        evidence: { attempts: [expect.objectContaining({ reason: "runtime unavailable" })] },
      });
      expect(start).not.toHaveBeenCalled();
      gate.attach({ packetReviewerScope: (provider) => provider === "gpt" ? { state: "UNCONFIGURED", root: "/fixture/no-codex-home" } : null });
      const result = await gate["constituteReviewer"](roleReviewRequest(setup));
      if (result.allowed) workdir = result.value.workdir;
      expect(result.allowed && result.value.preference.provider).toBe("claude");
      expect(start).toHaveBeenCalledOnce();
      expect(wrongStart).not.toHaveBeenCalled();
      expect(cp.audit.byKind("BLIND_REVIEW_FALLBACK")).toEqual([
        expect.objectContaining({ evidence: expect.objectContaining({ reason: REVIEWER_FALLBACK_SCOPE_UNCONFIGURED }) }),
      ]);
    } finally {
      if (workdir) rmSync(workdir, { recursive: true, force: true });
      cp.close();
    }
  });

  it("preserves absent preferred denial and absent fallback bookkeeping", async () => {
    const setup = await prepareReviewedInputs();
    const { cp, clock } = setup.harness;
    try {
      const preferred = new TestProductionAdapter(clock, "gpt");
      const fallback = new TestProductionAdapter(clock, "claude");
      const gate = gateWithReviewerPreferences(setup, preferred, fallback);
      expect(await gate["constituteReviewer"](roleReviewRequest(setup))).toMatchObject({
        allowed: false, reasonCode: ReasonCode.ISOLATION_LOST,
        message: "preferred reviewer adapter is not registered",
      });
      preferred.setRuntimeHealth("UNAVAILABLE");
      cp.providers.registerForRole(preferred, Role.BLIND_REVIEWER);
      // A configured preferred outage ends the selection; the fallback is never looked up.
      expect(await gate["constituteReviewer"](roleReviewRequest(setup))).toMatchObject({
        allowed: false, reasonCode: ReasonCode.ISOLATION_LOST,
        evidence: { attempts: [expect.objectContaining({ reason: "runtime unavailable" })] },
      });
      gate.attach({ packetReviewerScope: (provider) => provider === "gpt" ? { state: "UNCONFIGURED", root: "/fixture/no-codex-home" } : null });
      expect(await gate["constituteReviewer"](roleReviewRequest(setup))).toMatchObject({
        allowed: false, reasonCode: ReasonCode.ISOLATION_LOST,
        evidence: { attempts: [
          expect.objectContaining({ reason: REVIEWER_FALLBACK_SCOPE_UNCONFIGURED }),
          expect.objectContaining({ reason: "no adapter registered" }),
        ] },
      });
    } finally { cp.close(); }
  });

  it("refuses a CTO-only provider rather than treating it as an outage", async () => {
    const setup = await prepareReviewedInputs();
    const { cp, clock } = setup.harness;
    try {
      const wrong = new TestProductionAdapter(clock, "gpt");
      const fallback = new TestProductionAdapter(clock, "claude");
      cp.providers.registerForRole(wrong, Role.PRIMARY_CTO);
      cp.providers.register(fallback);
      const wrongStart = vi.spyOn(wrong, "startSession");
      const fallbackStart = vi.spyOn(fallback, "startSession");
      await expect(gateWithReviewerPreferences(setup, wrong, fallback)["constituteReviewer"](roleReviewRequest(setup)))
        .rejects.toThrow("no adapter registered");
      expect(wrongStart).not.toHaveBeenCalled();
      expect(fallbackStart).not.toHaveBeenCalled();
      expect(cp.audit.byKind("BLIND_REVIEW_FALLBACK")).toHaveLength(0);
    } finally { cp.close(); }
  });
});

describe("review role caller invocation", () => {
  it.each([false, true])("keeps single/chunk/final invocations on the reviewer identity (chunked=%s)", async (chunked) => {
    const setup = chunked ? await prepareLargeReviewedInputs() : await prepareReviewedInputs();
    const { cp, clock } = setup.harness;
    try {
      const selected = new TestProductionAdapter(clock, "gpt");
      const wrong = new TestProductionAdapter(clock, "gpt");
      selected.script(
        { match: /Candidate review/, text: reviewerPass([`${setup.identity}:src/app.js`]) },
        { match: /Review chunk/, text: reviewerPass([`${setup.identity}:src/app.js`]), once: false },
        { match: /Final review/, text: reviewerPass([]) },
      );
      cp.providers.register(wrong);
      cp.providers.registerForRole(wrong, Role.PRIMARY_CTO);
      cp.providers.registerForRole(selected, Role.BLIND_REVIEWER);
      const wrongInvoke = vi.spyOn(wrong, "invoke");
      const result = await invokeGate(gateWithReviewerPreferences(setup, selected, new TestProductionAdapter(clock, "claude")), setup);
      expect(result.allowed).toBe(true);
      if (!result.allowed) throw new Error(result.message);
      expect(result.value).toMatchObject({ provider: "gpt", verdict: "PASS", chunked });
      expect(wrongInvoke).not.toHaveBeenCalled();
      if (chunked) {
        expect(selected.invocations.filter((call) => /Review chunk/.test(call.prompt)).length).toBeGreaterThan(1);
        expect(selected.invocations.filter((call) => /Final review/.test(call.prompt))).toHaveLength(1);
      } else expect(selected.invocations).toHaveLength(1);
    } finally { cp.close(); }
  });

  it("uses reviewer capabilities rather than CTO capabilities for effort attestation", async () => {
    const setup = await prepareReviewedInputs();
    const { cp, clock } = setup.harness;
    let workdir: string | undefined;
    try {
      class EffortReviewer extends TestProductionAdapter {
        readonly supportsReviewerEffortAttestation = true;
      }
      const selected = new EffortReviewer(clock, "gpt");
      const wrong = new TestProductionAdapter(clock, "gpt");
      cp.providers.register(wrong);
      cp.providers.registerForRole(wrong, Role.PRIMARY_CTO);
      cp.providers.registerForRole(selected, Role.BLIND_REVIEWER);
      const gate = gateWithReviewerPreferences(setup, selected, new TestProductionAdapter(clock, "claude"));
      const constituted = await gate["constituteReviewer"](roleReviewRequest(setup));
      if (!constituted.allowed) throw new Error(constituted.message);
      workdir = constituted.value.workdir;
      const result: InvocationResult = {
        ok: true, text: "", json: null, provider: "gpt", model: "test", durationMs: 0, exitCode: 0,
        error: null, providerSessionId: constituted.value.externalSessionId, isolationAttested: true,
        egressEvidence: testReviewerEgressEvidence("gpt"),
      };
      expect(gate["assertIsolationAttested"](setup.run.runId, constituted.value, result)).toMatchObject({
        allowed: false, reasonCode: ReasonCode.ISOLATION_LOST,
        message: "reviewer adapter did not attest the configured effort",
      });
      expect(gate["assertIsolationAttested"](setup.run.runId, constituted.value, { ...result, effortAttested: true }))
        .toMatchObject({ allowed: true });
    } finally {
      if (workdir) rmSync(workdir, { recursive: true, force: true });
      cp.close();
    }
  });
});

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

  /** #1258 — one more execution of the fixture's one input, beside the PASS the fixture wrote. */
  const recordExecution = (setup: Awaited<ReturnType<typeof prepareReviewedInputs>>, attempt: number, status: "PASS" | "FAIL") => {
    const digest = candidateSnapshotDigest(setup.snapshot);
    const result = setup.verification.results[0]!;
    setup.harness.cp.db.run(
      `INSERT INTO verification_results
         (result_id, run_id, candidate_snapshot_digest, command_id, repository_identity, source, attempt,
          exact_head, started_at, ended_at, exit_code, output_digest, output_truncated, status, reason_code)
       VALUES (?, ?, ?, ?, ?, 'local', ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      [`${digest}:${result.commandId}:${result.repositoryIdentity}:local:${attempt}`, setup.run.runId, digest, result.commandId,
        result.repositoryIdentity, attempt, result.exactHead, result.startedAt, result.endedAt, status === "PASS" ? 0 : 1,
        `sha256:execution-${attempt}`, status, status === "PASS" ? null : ReasonCode.VERIFICATION_COMMAND_FAILED],
    );
  };

  it("#1258 admits review when an earlier execution of the input failed and its latest passed", async () => {
    const setup = await prepareReviewedInputs();
    // The fixture's PASS becomes the input's second execution, after a FAIL on the same candidate.
    setup.harness.cp.db.run(`UPDATE verification_results SET attempt = 2 WHERE run_id = ?`, [setup.run.runId]);
    recordExecution(setup, 1, "FAIL");
    const reviewed = await directReview(setup);
    expect(reviewed, JSON.stringify(reviewed)).toMatchObject({ allowed: true, value: { verdict: "PASS" } });
  });

  it("#1258 refuses review when the input's latest execution failed after an earlier PASS", async () => {
    const setup = await prepareReviewedInputs();
    recordExecution(setup, 2, "FAIL");
    const reviewed = await directReview(setup);
    expect(reviewed).toMatchObject({ allowed: false, reasonCode: ReasonCode.EVIDENCE_MISSING });
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

  it("#1259 keeps a chunked review whose reviewer also claims a file outside its chunk, recording that claim uncredited", async () => {
    const setup = await prepareLargeReviewedInputs();
    const assigned = `${setup.identity}:src/app.js`;
    const extra = `${setup.identity}:package.json`;
    expect(setup.snapshot.repositories.flatMap((repository) => repository.touchedPaths)).not.toContain("package.json");
    setup.harness.scripted.script(
      { match: /Review chunk/, text: reviewerPass([assigned, extra]), once: false },
      { match: /Final review/, text: reviewerPass([]) },
    );

    const result = await invokePreparedReview(setup);

    if (!result.allowed) throw new Error(`${result.reasonCode}: ${result.message}`);
    expect(result.value).toMatchObject({ chunked: true, verdict: "PASS", omittedItems: [] });
    expect(result.value.coveredFiles).toEqual([assigned]);
    expect(result.value.extraClaims).toEqual([extra]);
    const stored = setup.harness.cp.review.latestPacket(setup.run.runId, candidateSnapshotDigest(setup.snapshot));
    expect(stored?.coveredFiles).toEqual([assigned]);
    expect(stored?.extraClaims).toEqual([extra]);
  });

  it("#1259 an extra claim does not cover an assigned slice its chunk reviewer left unclaimed", async () => {
    const setup = await prepareLargeReviewedInputs();
    const assigned = `${setup.identity}:src/app.js`;
    const extra = `${setup.identity}:package.json`;
    // Chunk 1 claims its slice; every later chunk claims only the file outside it.
    setup.harness.scripted.script(
      { match: /Review chunk 1 of/, text: reviewerPass([assigned]) },
      { match: /Review chunk/, text: reviewerPass([extra]), once: false },
      { match: /Final review/, text: reviewerPass([]) },
    );

    const result = await invokePreparedReview(setup);

    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe(ReasonCode.REVIEW_REVISE);
    const stored = setup.harness.cp.review.latestPacket(setup.run.runId, candidateSnapshotDigest(setup.snapshot));
    expect(stored?.verdict).toBe("REVISE");
    expect(stored?.omittedItems).toContain(assigned);
    expect(stored?.coveredFiles).toEqual([assigned]);
    expect(stored?.extraClaims).toEqual([extra]);
  });

  it("#1259 still refuses a chunk claim that is not <identity>:<path>, naming it as malformed", async () => {
    const setup = await prepareLargeReviewedInputs();
    setup.harness.scripted.script(
      { match: /Review chunk/, text: reviewerPass([`${setup.identity}:src/app.js`, "package.json"]), once: false },
      { match: /Final review/, text: reviewerPass([]) },
    );

    const result = await invokePreparedReview(setup);

    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe(ReasonCode.COVERAGE_INCOMPLETE);
    expect(result.allowed ? null : result.message).toMatch(/not <identity>:<path>/);
    expect(result.evidence).toMatchObject({ claim: "package.json" });
    expect(setup.harness.cp.review.latestPacket(setup.run.runId, candidateSnapshotDigest(setup.snapshot))).toBeNull();
  });

  it("#1259 a single review records a claim outside its coverage items the same way, uncredited", async () => {
    const setup = await prepareReviewedInputs();
    const assigned = `${setup.identity}:src/app.js`;
    const extra = `${setup.identity}:package.json`;

    const result = await directReview(setup, reviewerPass([assigned, extra]));

    if (!result.allowed) throw new Error(`${result.reasonCode}: ${result.message}`);
    expect(result.value.chunked).toBe(false);
    expect(result.value.coveredFiles).toEqual([assigned]);
    expect(result.value.extraClaims).toEqual([extra]);
  });

  it("#1259 a single review refuses a claim that is not <identity>:<path>, as a chunk review does", async () => {
    const setup = await prepareReviewedInputs();

    const result = await directReview(setup, reviewerPass([`${setup.identity}:src/app.js`, "src/app.js"]));

    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe(ReasonCode.COVERAGE_INCOMPLETE);
    expect(result.evidence).toMatchObject({ claim: "src/app.js" });
  });

  it("#1259 stores extra claims as repository paths: a long path is kept, a credential-shaped one is redacted", async () => {
    const setup = await prepareLargeReviewedInputs();
    const assigned = `${setup.identity}:src/app.js`;
    // One unbroken run of the base64 alphabet, `/` included, longer than the long-base64 shape: as a
    // whole value it is credential-shaped, while no `/`-separated segment of it is.
    const longPath = `${setup.identity}:src/main/java/org/apache/commons/collections/iterators/ObjectArrayIterator.java`;
    const plain = `${setup.identity}:package.json`;
    const secret = `ghp_${"A1b2C3d4".repeat(5)}`;
    const shaped = `${setup.identity}:${secret}.txt`;
    expect(hasCredentialShape(plain)).toBe(false);
    expect(hasCredentialShape(plain, { path: ["extraClaims"], store: "artifact" })).toBe(false);
    expect(hasCredentialShape(longPath)).toBe(true);
    expect(hasCredentialShape(longPath, { path: ["extraClaims"], store: "artifact" })).toBe(false);
    setup.harness.scripted.script(
      { match: /Review chunk/, text: reviewerPass([assigned, plain, longPath, shaped]), once: false },
      { match: /Final review/, text: reviewerPass([]) },
    );

    const result = await invokePreparedReview(setup);

    if (!result.allowed) throw new Error(`${result.reasonCode}: ${result.message}`);
    const stored = setup.harness.cp.artifacts.list<ReviewPacket>(setup.run.runId, "BLIND_REVIEW")[0]!;
    expect(stored.content.coveredFiles).toEqual([assigned]);
    expect(stored.content.extraClaims).toEqual([plain, longPath, `${setup.identity}:[redacted].txt`]);
    expect(JSON.stringify(stored.content)).not.toContain(secret);
    expect(artifactDigestMatches(stored)).toBe(true);
  });

  it("#1259 tells each chunk reviewer to list only the files in its own chunk", async () => {
    const setup = await prepareLargeReviewedInputs();
    setup.harness.scripted.script(
      { match: /Review chunk/, text: reviewerPass([`${setup.identity}:src/app.js`]), once: false },
      { match: /Final review/, text: reviewerPass([]) },
    );

    const result = await invokePreparedReview(setup);

    if (!result.allowed) throw new Error(`${result.reasonCode}: ${result.message}`);
    const chunkPrompts = setup.harness.scripted.invocations.filter((call) => /Review chunk/.test(call.prompt));
    expect(chunkPrompts.length).toBeGreaterThan(1);
    for (const call of chunkPrompts) {
      expect(call.prompt).toContain("In this chunk, `coveredFiles` lists only files named under \"## Actual diff\" above");
    }
  });

  /**
   * Review lane-e-fs-r8 P1 — a binary file the candidate makes text is git's binary section followed by
   * the readable text (git.ts `withTextRenderedAsText`). When chunking puts the two in different chunks,
   * the claim of the chunk holding only the binary section must not cover the readable text.
   */
  it.each([
    { textChunkClaims: false, verdict: "REVISE" },
    { textChunkClaims: true, verdict: "PASS" },
  ])("E6-1 the readable text chunked apart from its binary section needs its own coverage (text chunk claims it: $textChunkClaims)", async ({ textChunkClaims, verdict }) => {
    // Inert comment lines behind one NUL byte in the base; the candidate removes the NUL.
    const lines = Array.from({ length: 900 }, (_, index) => `// inert comment line ${index + 1} ${"-".repeat(40)}\n`).join("");
    const setup = await prepareReviewedInputs({ "src/zflip.js": `\0${lines}` });
    // Sorted before src/zflip.js, the padding leaves room in its chunk for the binary section only.
    writeFiles(setup.harness.repoPath, { "src/pad.js": `// ${"p".repeat(60_000)}\n`, "src/zflip.js": lines });
    commitAll(setup.harness.repoPath, "make zflip text and add padding");
    const frozen = await setup.harness.cp.pipeline.freeze(setup.run.runId);
    if (!frozen.allowed) throw new Error(frozen.message);
    const reviewed = { ...setup, snapshot: frozen.value, verification: persistPassingVerification(setup, frozen.value) };
    const key = (path: string): string => `${setup.identity}:${path}`;
    setup.harness.scripted.script(
      { match: /Final review/, text: reviewerPass([]) },
      // The chunk holding the binary section claims every path it was given.
      { match: /^GIT binary patch$/m, text: reviewerPass([key("src/app.js"), key("src/pad.js"), key("src/zflip.js")]) },
      { match: /Review chunk/, text: reviewerPass(textChunkClaims ? [key("src/zflip.js")] : []) },
    );

    const result = await invokePreparedReview(reviewed);

    const chunks = setup.harness.scripted.invocations.map((call) => call.prompt).filter((prompt) => prompt.startsWith("# Review chunk"));
    // The repro's shape: the binary section and the readable text reach different chunk reviewers.
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatch(/^GIT binary patch$/m);
    expect(chunks[0]).not.toContain("+// inert comment line 1 ");
    expect(chunks[1]).not.toMatch(/^GIT binary patch$/m);
    expect(chunks[1]).toContain("+// inert comment line 1 ");
    expect(chunks[1]).toContain("+// inert comment line 900 ");
    expect(result.allowed ? "PASS" : result.reasonCode).toBe(textChunkClaims ? "PASS" : ReasonCode.REVIEW_REVISE);
    const packet = setup.harness.cp.review.latestPacket(setup.run.runId, candidateSnapshotDigest(frozen.value));
    expect(packet).toMatchObject({ verdict, omittedItems: textChunkClaims ? [] : [key("src/zflip.js")] });
  }, 120_000);

  it("E6-1 names a renamed or copied section by its destination, the path git lists as changed, when it chunks a diff (review lane-e-fs-r8)", () => {
    const identity = "github:acme/fixture";
    const section = (kind: "rename" | "copy", from: string, to: string, body: string): string =>
      `diff --git a/${from} b/${to}\nsimilarity index 90%\n${kind} from ${from}\n${kind} to ${to}\nindex 1111111..2222222 100644\n--- a/${from}\n+++ b/${to}\n@@ -1 +1 @@\n${body}`;
    const renamed = section("rename", "src/old.js", "src/new.js", `-${"o".repeat(60)}\n+${"n".repeat(60)}\n`);
    const copied = section("copy", "src/base.js", "src/copy.js", `-${"b".repeat(60)}\n+${"c".repeat(60)}\n`);
    const budget = Math.max(renamed.length, copied.length);
    const parts = __testing.splitDiffs([{ identity, diff: renamed + copied, files: ["src/copy.js", "src/new.js"] }], budget).chunks.flat();
    expect(parts.map((part) => part.files)).toEqual([["src/new.js"], ["src/copy.js"]]);

    // A section larger than the budget is range-split under its destination too.
    const large = section("rename", "src/old.js", "src/new.js", Array.from({ length: 200 }, (_, index) => `+line ${index}\n`).join(""));
    const ranges = __testing.splitDiffs([{ identity, diff: large, files: ["src/new.js"] }], 800).chunks.flat();
    expect(ranges.length).toBeGreaterThan(1);
    expect(ranges.every((part) => part.files.length === 1 && part.files[0] === "src/new.js")).toBe(true);
    // Every range carries the rename's full header.
    const fileHeader = large.slice(0, large.indexOf("\n@@ ") + 1);
    expect(ranges.every((part) => part.diff.startsWith(fileHeader))).toBe(true);
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

  it("falls back to Claude only when GPT's packet scope is UNCONFIGURED, never on a measured outage, and records why", async () => {
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
    const gate = gateWithReviewerPreferences(setup, preferred, fallback);

    // CEO 1792123922 (2026-10-16): a configured GPT reviewer that is down leaves the review unavailable.
    expect(await invokeGate(gate, setup)).toMatchObject({ allowed: false, reasonCode: ReasonCode.ISOLATION_LOST });
    expect(fallback.invocations).toHaveLength(0);
    expect(setup.harness.cp.audit.byKind("BLIND_REVIEW_FALLBACK")).toHaveLength(0);

    gate.attach({ packetReviewerScope: (provider) => provider === "gpt" ? { state: "UNCONFIGURED", root: "/fixture/no-codex-home" } : null });
    const result = await invokeGate(gate, setup);

    expect(result.allowed).toBe(true);
    expect(result.allowed && result.value.provider).toBe("claude");
    expect(preferred.invocations).toHaveLength(0);
    expect(fallback.invocations).toHaveLength(1);
    expect(setup.harness.cp.audit.byKind("BLIND_REVIEW_FALLBACK")).toEqual([
      expect.objectContaining({
        runId: setup.run.runId,
        evidence: expect.objectContaining({ from: "gpt", provider: "claude", reason: REVIEWER_FALLBACK_SCOPE_UNCONFIGURED }),
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

  it("names a handshake timeout as one, and still refuses to fall back", async () => {
    // Two properties, and the second is what makes the first safe to ship. The report must stop
    // calling a timeout "isolation could not be proved" — an operator reading that audits the
    // sandbox and never looks at the credential, which is what #512 produced. And the mandatory
    // GPT gate must be exactly as mandatory as before: nothing branches on `ISOLATION_LOST` as a
    // value, so this changes what is reported and not what is refused.
    const setup = await prepareReviewedInputs();
    const preferred = new HandshakeTimeoutGptAdapter(setup.harness.clock, "gpt");
    const fallback = new TestProductionAdapter(setup.harness.clock, "claude");
    fallback.script({
      match: /Candidate review/,
      text: reviewerPass([`${setup.identity}:src/app.js`]),
    });
    setup.harness.cp.providers.register(preferred);
    setup.harness.cp.providers.register(fallback);

    const result = await invokeGate(gateWithReviewerPreferences(setup, preferred, fallback), setup);

    expect(result.allowed).toBe(false);
    // `Decision` carries `message` only on its denied arm, so the narrowing is explicit rather
    // than implied by the assertion above — a `.message` read on the allowed arm is a type error,
    // not a runtime surprise.
    if (result.allowed) throw new Error("expected the gate to deny a reviewer that never answered");
    expect(result.reasonCode).toBe(ReasonCode.REVIEWER_SESSION_HANDSHAKE_TIMEOUT);
    expect(result.message).toContain("did not answer its identity handshake");
    expect(result.message).not.toContain("isolation could not be proved");
    // The P0-07 property, unchanged: a reviewer that could not run does not become a successful
    // review by another provider, and no fallback is recorded.
    expect(fallback.invocations).toHaveLength(0);
    expect(setup.harness.cp.audit.byKind("BLIND_REVIEW_FALLBACK")).toHaveLength(0);
  });

  it("names an unreadable answer as one, and still refuses to fall back", async () => {
    // The same two properties the timeout row pins, for the reason that was still wearing
    // `ISOLATION_LOST`: the report must send an operator to the provider's output contract rather
    // than to the sandbox, and the mandatory GPT gate must stay exactly as mandatory.
    const setup = await prepareReviewedInputs();
    const preferred = new UnreadableAnswerGptAdapter(setup.harness.clock, "gpt");
    const fallback = new TestProductionAdapter(setup.harness.clock, "claude");
    fallback.script({
      match: /Candidate review/,
      text: reviewerPass([`${setup.identity}:src/app.js`]),
    });
    setup.harness.cp.providers.register(preferred);
    setup.harness.cp.providers.register(fallback);

    const result = await invokeGate(gateWithReviewerPreferences(setup, preferred, fallback), setup);

    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error("expected the gate to deny a reviewer with no session id");
    expect(result.reasonCode).toBe(ReasonCode.REVIEWER_SESSION_UNREADABLE_ANSWER);
    expect(result.message).toContain("without a resumable session id");
    expect(result.message).not.toContain("isolation could not be proved");
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
    const payload = Array.from({ length: 2_500 }, (_, index) => index.toString(36).padStart(4, "0")).join("");
    const chunks = __testing.splitDiffs([{
      identity: "github:acme/fixture",
      diff: `${header}${payload}`,
      files: ["large.ts"],
    }], 1_000).chunks;
    const parts = chunks.flat();
    expect(parts.length).toBeGreaterThan(1);
    // Each part's label is charged to the same budget as its patch.
    expect(parts.every((part) => part.diff.length + (part.rangeLabel?.length ?? 0) <= 1_000)).toBe(true);
    expect(parts.every((part) => part.rangeLabel?.startsWith(`Part ${parts.indexOf(part) + 1} of ${parts.length} `))).toBe(true);
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
