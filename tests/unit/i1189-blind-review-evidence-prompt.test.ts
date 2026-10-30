import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { manifestDigest } from "../../src/contracts/manifest.ts";
import { digestOf, sha256 } from "../../src/core/digest.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ArtifactKind, ExecutionMode, RunKind } from "../../src/domain/types.ts";
import type { CandidateSnapshot } from "../../src/snapshot/candidate-snapshot.ts";
import type { VerificationReport } from "../../src/verify/verification-engine.ts";
import type { ReviewPacket } from "../../src/review/blind-review.ts";
import { __testing } from "../../src/review/blind-review.ts";
import { REVIEWER_TRANSPORT_SEPARATOR } from "../../src/runtime/cli-adapters.ts";
import type { TaskContract } from "../../src/run/run-engine.ts";
import { bootstrapCoverageKeys, bootstrapPlan, cleanTreeManifest, submitBootstrapPlan } from "../helpers/bootstrap-plan.ts";
import { dispatchRun, stricter } from "../helpers/contract-change.ts";
import { cleanupTempDirs, commitAll, writeFiles } from "../helpers/fixtures.ts";
import {
  applyPassingChange,
  bindCeo,
  bindWorker,
  carryContractChange,
  dispatchBootstrapRun,
  driveToReviewedCandidate,
  makeHarness,
  registerFixtureProject,
  reviewerPass,
} from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * #1189 §2.B — every reviewer prompt asks a finding's `detail` for the evidence that makes it
 * checkable, keeps the verdict shape, and gives the reviewer no tools. The reviewer here is the
 * harness's scripted one: these tests read the prompts the production gate builds, and say nothing
 * about what a real model does with them.
 */

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

const flat = (prompt: string): string => prompt.replace(/\s+/g, " ");

/** Check the actual production input, including removal of ACP's competing rubric. */
const source = readFileSync(new URL("../../src/review/frontier-simplify.md", import.meta.url), "utf8");

const expectEvidenceStandard = (prompt: string): void => {
  const text = flat(prompt);
  expect(prompt).toContain(source);
  expect(prompt).not.toMatch(/Automatic attempt|Round 2|PASS WITH NITS|INCOMPLETE/);
  expect(text).not.toContain("Each finding's `detail` must state all five");
  expect(text).not.toContain("Your verdict stands as you return it; severities do not change it.");
  expect(text).not.toContain("Everything you need is above");
  expect(text).not.toContain("Do not praise");
};

const promptsStartingWith = (harness: ReturnType<typeof makeHarness>, heading: string): string[] =>
  harness.scripted.invocations.map((call) => call.prompt).filter((prompt) => prompt.startsWith(heading));

/**
 * #1274 — what a packet records for a reviewer call: the digest of its complete transmitted input,
 * system instructions and prompt joined as the Codex adapter sends them.
 */
const transmittedDigest = (harness: ReturnType<typeof makeHarness>, prompt: string): string => {
  const call = harness.scripted.invocations.find((invocation) => invocation.prompt === prompt)!;
  expect(call.systemPrompt).toBeTruthy();
  return sha256(`${call.systemPrompt}${REVIEWER_TRANSPORT_SEPARATOR}${call.prompt}`);
};

const reReview = async (h: ReturnType<typeof makeHarness>, runId: string, kind: "CANDIDATE" | "BOOTSTRAP_PLAN" | "CONTRACT_CHANGE") => {
  const snapshot = h.cp.artifacts.latest<CandidateSnapshot>(runId, "CANDIDATE_SNAPSHOT")!.content;
  const contract = h.cp.artifacts.latest<TaskContract>(runId, "TASK_CONTRACT")!.content;
  const original = h.cp.artifacts.list<ReviewPacket>(runId, "BLIND_REVIEW").at(-1)!;
  const run = h.cp.runs.require(runId);
  const before = h.scripted.invocations.length;
  h.scripted.script({ match: /Final review/, text: reviewerPass([]) });
  h.scripted.script({ match: /Candidate review|Review chunk|Bootstrap plan review|Contract change review/, text: reviewerPass(original.content.coveredFiles), once: false });
  const result = await h.cp.review.controlPlaneInvoker()({
    kind, runId, snapshot, contract, contractDigest: snapshot.contractDigest,
    projectId: run.projectId, executionMode: run.executionMode,
    verification: h.cp.artifacts.latest<VerificationReport>(runId, "VERIFICATION")?.content as VerificationReport,
  });
  expect(result.allowed, JSON.stringify(result)).toBe(true);
  const calls = h.scripted.invocations.slice(before);
  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) {
    expectEvidenceStandard(call.prompt);
    expect(call.prompt).not.toMatch(/ROUND1_INVENTORY|PREVIOUS_REVIEW|IMPLEMENTER_RESPONSE|REMEDIATION\.patch/);
    expect((call.systemPrompt?.length ?? 0) + call.prompt.length).toBeLessThanOrEqual(120_000);
    expect(call.systemPrompt).not.toMatch(/Attack the|Do not praise|Judge only/);
  }
};

describe("#1189 §2.B: the reviewer prompt asks for checkable evidence", () => {
  it("binds a repository-owned REVIEW.md from the exact candidate into the prompt, packet, and packet digest", async () => {
    const harness = makeHarness();
    const policy = [
      "# Project review requirements",
      "",
      "- Treat a claimed native observation as unproved without exact-build evidence.",
      "- Protocol-only changes do not invent native observations.",
      "",
    ].join("\n");
    writeFiles(harness.repoPath, { "REVIEW.md": policy });
    commitAll(harness.repoPath, "add project review requirements");

    const driven = await driveToReviewedCandidate(harness);
    const prompt = promptsStartingWith(harness, "# Candidate review")[0]!;
    const packet = harness.cp.review.latestPacket(driven.runId, driven.candidateSnapshotDigest)!;
    const verification = harness.cp.artifacts.latestForSnapshot<VerificationReport>(
      driven.runId,
      "VERIFICATION",
      driven.candidateSnapshotDigest,
    )!.content;
    const reviewPolicy = {
      repository: driven.identity,
      path: "REVIEW.md",
      revision: driven.candidateHead,
      digest: sha256(policy),
      content: policy,
    };

    expect(packet.inputManifest.reviewPolicies).toEqual([reviewPolicy]);
    expect(packet.inputManifest.reviewerPromptDigests).toEqual([transmittedDigest(harness, prompt)]);
    expect(prompt).toContain("## Repository-owned review requirements");
    expect(prompt).toContain(JSON.stringify([reviewPolicy], null, 2));
    expect(prompt).toContain(`Packet digest: ${digestOf({
      candidateSnapshotDigest: driven.candidateSnapshotDigest,
      contractDigest: driven.contractDigest,
      verificationDigest: digestOf(verification),
      coverageTargets: [`${driven.identity}:src/app.js`],
      reviewPolicies: [reviewPolicy],
    })}`);

    writeFiles(harness.repoPath, { "REVIEW.md": "working-tree-only replacement\n" });
    await reReview(harness, driven.runId, "CANDIDATE");
    const secondPrompt = promptsStartingWith(harness, "# Candidate review").at(-1)!;
    expect(secondPrompt).toContain(JSON.stringify([reviewPolicy], null, 2));
    expect(secondPrompt).not.toContain("working-tree-only replacement");
  });

  it("#1274: keeps a REVIEW.md byte-order mark, so the bound content is exactly the bytes its digest hashes", async () => {
    const harness = makeHarness();
    const policy = "\uFEFF# Review\n\n- A byte-order mark is part of the committed file.\n";
    writeFiles(harness.repoPath, { "REVIEW.md": policy });
    commitAll(harness.repoPath, "add project review requirements with a byte-order mark");
    const committed = readFileSync(join(harness.repoPath, "REVIEW.md"));
    expect([...committed.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);

    const driven = await driveToReviewedCandidate(harness);
    const packet = harness.cp.review.latestPacket(driven.runId, driven.candidateSnapshotDigest)!;
    const reviewPolicy = {
      repository: driven.identity,
      path: "REVIEW.md",
      revision: driven.candidateHead,
      digest: sha256(committed),
      content: policy,
    };
    expect(packet.inputManifest.reviewPolicies).toEqual([reviewPolicy]);
    const [bound] = packet.inputManifest.reviewPolicies;
    expect(sha256(Buffer.from(bound!.content, "utf8"))).toBe(bound!.digest);
    expect(promptsStartingWith(harness, "# Candidate review")[0]).toContain(JSON.stringify([reviewPolicy], null, 2));
  });

  it("#1274: refuses a REVIEW.md that is only a byte-order mark as empty, before any reviewer is asked", async () => {
    const harness = makeHarness();
    writeFiles(harness.repoPath, { "REVIEW.md": "\uFEFF" });
    commitAll(harness.repoPath, "add an empty review requirements file");

    await expect(driveToReviewedCandidate(harness)).rejects.toThrow(
      `${ReasonCode.EVIDENCE_MISSING}: repository review policy is empty`,
    );
    expect(harness.scripted.invocations.filter((call) => call.prompt.startsWith("# Candidate review"))).toEqual([]);
  });

  it("#1274: the BLIND_REVIEW schema refuses review-policy content that is only a byte-order mark, as collection does", async () => {
    const harness = makeHarness();
    writeFiles(harness.repoPath, { "REVIEW.md": "# Review\n" });
    commitAll(harness.repoPath, "add project review requirements");
    const driven = await driveToReviewedCandidate(harness);
    const packet = harness.cp.review.latestPacket(driven.runId, driven.candidateSnapshotDigest)!;
    const withContent = (content: string): ReviewPacket => ({
      ...packet,
      inputManifest: {
        ...packet.inputManifest,
        reviewPolicies: packet.inputManifest.reviewPolicies.map((policy) => ({ ...policy, content, digest: sha256(content) })),
      },
    });
    const store = (content: string) => harness.cp.artifacts.putEvidence(
      harness.cp.evidenceWritersForTests().BLIND_REVIEW,
      driven.runId,
      ArtifactKind.BLIND_REVIEW,
      withContent(content),
      driven.candidateSnapshotDigest,
    );

    expect(() => store("\uFEFF")).toThrow("BLIND_REVIEW has an invalid evidence envelope");
    expect(() => store("")).toThrow("BLIND_REVIEW has an invalid evidence envelope");
    expect(store("\uFEFF# Review\n").content.inputManifest.reviewPolicies[0]!.content).toBe("\uFEFF# Review\n");
  });

  it("candidate first review and re-review use only the original canonical method", async () => {
    const harness = makeHarness();
    const driven = await driveToReviewedCandidate(harness);
    const [prompt] = promptsStartingWith(harness, "# Candidate review");
    expect(prompt).toBeDefined();
    expectEvidenceStandard(prompt!);
    // A large repair must be chunked too, rather than becoming unbounded prompt metadata.
    writeFiles(harness.repoPath, { "src/app.js": `module.exports = () => 2;\n// repair ${"x".repeat(130_000)}\n` });
    commitAll(harness.repoPath, "large repair");
    const frozen = await harness.cp.pipeline.freeze(driven.runId);
    if (!frozen.allowed) throw new Error(frozen.message);
    const verified = await harness.cp.verification.verify({ runId: driven.runId, snapshot: frozen.value,
      commands: harness.cp.projects.activeManifest(driven.projectId)!.manifest.verificationCommands,
      contractDigest: frozen.value.contractDigest });
    if (!verified.allowed) throw new Error(verified.message);
    await reReview(harness, driven.runId, "CANDIDATE");
  });

  it.each([
    [RunKind.STANDARD_WORK, false], [RunKind.STANDARD_WORK, true],
    [RunKind.CONTRACT_CHANGE, false], [RunKind.CONTRACT_CHANGE, true],
  ])("candidate dispatch and re-review use the canonical method (kind=%s, chunked=%s)", async (kind, chunked) => {
    const harness = makeHarness();
    const { projectId, repositoryId, identity } = await registerFixtureProject(harness);
    bindCeo(harness);
    const created = harness.cp.runs.create({
      projectId,
      kind,
      executionMode: ExecutionMode.STANDARD,
      contract: CONTRACT,
      repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
    });
    if (!created.allowed) throw new Error(created.message);
    const runId = created.value.runId;
    const dispatched = await harness.cp.runs.dispatch(runId);
    if (!dispatched.allowed) throw new Error(dispatched.message);
    const run = dispatched.value;
    const proposed = kind === RunKind.CONTRACT_CHANGE ? stricter(harness.cp.projects.activeManifest(projectId)!.manifest) : null;
    if (proposed !== null) carryContractChange(harness, runId, proposed);
    harness.cp.tasks.submit(runId, [{ key: "impl", title: "change app()", category: "implementation" }]);
    const task = harness.cp.tasks.ready(runId)[0]!;
    const execution = harness.cp.tasks.startExecution({
      runId,
      taskId: task.taskId,
      ownerBindingGeneration: run.ownerBindingGeneration!,
      workerSessionId: bindWorker(harness, task.taskId),
      provider: "scripted",
      model: "scripted-worker",
      repositoryId,
    });
    if (!execution.allowed) throw new Error(execution.message);
    applyPassingChange(harness.repoPath);
    // A change too large for one prompt.
    if (chunked) writeFiles(harness.repoPath, { "src/app.js": `module.exports = () => 2;\n// ${"x".repeat(130_000)}\n` });
    const head = chunked ? commitAll(harness.repoPath, "large reviewed change") : "passing-change";
    harness.cp.tasks.finishExecution(execution.value.executionId, { status: "SUCCEEDED", resultDigest: `sha256:${head}` });
    const coverage = [`${identity}:src/app.js`, ...(proposed === null ? [] : [`${projectId}:#manifest/${manifestDigest(proposed)}`])];
    harness.scripted.script(
      { match: /Candidate review|# Review chunk 1 of/, text: reviewerPass(coverage), once: false },
      { match: /Review chunk/, text: reviewerPass([`${identity}:src/app.js`]), once: false },
      { match: /Final review/, text: reviewerPass([]) },
    );
    const outcome = await harness.cp.pipeline.submitResult({
      runId,
      ownerSessionId: run.ownerSessionId!,
      ownerBindingGeneration: run.ownerBindingGeneration!,
      resultSummary: "app() now returns 2",
      recommendation: "merge",
    });
    expect(outcome.allowed && outcome.value.stage, JSON.stringify(outcome).slice(0, 400)).toBe("COMPLETED_REVIEW");

    const chunks = promptsStartingWith(harness, "# Review chunk");
    const finals = promptsStartingWith(harness, "# Final review");
    if (chunked) {
      expect(chunks.length).toBeGreaterThan(1);
      expect(finals).toHaveLength(1);
    } else {
      expect(chunks).toHaveLength(0);
      expect(promptsStartingWith(harness, "# Candidate review")).toHaveLength(1);
    }
    const prompts = [...chunks, ...finals, ...promptsStartingWith(harness, "# Candidate review")];
    for (const prompt of prompts) {
      expectEvidenceStandard(prompt);
      expect(prompt.length).toBeLessThanOrEqual(120_000);
    }
    const packet = harness.cp.review.latestPacket(runId, harness.cp.runs.currentCandidate(runId)!)!;
    expect(packet.inputManifest.reviewerPromptDigests).toEqual(prompts.map((prompt) => transmittedDigest(harness, prompt)));
    await reReview(harness, runId, "CANDIDATE");
  });

  it("a bootstrap plan review prompt states it", async () => {
    const harness = makeHarness();
    bindCeo(harness);
    const created = harness.cp.runs.create({
      kind: RunKind.PROJECT_BOOTSTRAP,
      executionMode: ExecutionMode.STANDARD,
      contract: {
        goal: "bootstrap",
        why: "new repository",
        scope: [],
        nonGoals: [],
        acceptance: ["repository created"],
        priority: "NORMAL",
        humanGate: [],
        references: [],
      },
    });
    if (!created.allowed) throw new Error(created.message);
    const runId = created.value.runId;
    await dispatchBootstrapRun(harness.cp, harness.clock, runId);
    await submitBootstrapPlan(harness, runId, bootstrapPlan(cleanTreeManifest("i1189-prompt")));
    harness.scripted.script({ match: /Bootstrap plan review/, text: reviewerPass(bootstrapCoverageKeys(harness, runId)) });
    const run = harness.cp.runs.require(runId);
    const outcome = await harness.cp.pipeline.submitResult({
      runId,
      ownerSessionId: run.ownerSessionId!,
      ownerBindingGeneration: run.ownerBindingGeneration!,
      resultSummary: "the planned outputs",
      recommendation: "create the repository",
    });
    expect(outcome.allowed && outcome.value.stage, JSON.stringify(outcome)).toBe("COMPLETED_REVIEW");
    const [prompt] = promptsStartingWith(harness, "# Bootstrap plan review");
    expect(prompt).toBeDefined();
    expectEvidenceStandard(prompt!);
    // E2E-02 — the execution evidence is a candidate-review input only; a plan review is unchanged.
    expect(prompt).not.toContain("## Untrusted execution evidence");
    await reReview(harness, runId, "BOOTSTRAP_PLAN");
  });

  it("a contract change review prompt states it", async () => {
    const harness = makeHarness();
    const registered = await registerFixtureProject(harness, "i1189-contract");
    const run = await dispatchRun(harness, registered.projectId, RunKind.CONTRACT_CHANGE);
    const proposed = stricter(run.base);
    carryContractChange(harness, run.runId, proposed);
    await harness.cp.continuity.evaluate("contract change candidate");
    harness.scripted.script({
      match: /Contract change review/,
      text: reviewerPass([`${run.projectId}:#manifest/${manifestDigest(proposed)}`]),
    });
    const outcome = await harness.cp.pipeline.submitResult({
      runId: run.runId,
      ownerSessionId: run.ownerSessionId,
      ownerBindingGeneration: run.ownerBindingGeneration,
      resultSummary: "the proposed manifest",
      recommendation: "review the contract change",
    });
    expect(outcome.allowed && outcome.value.stage, JSON.stringify(outcome)).toBe("COMPLETED_REVIEW");
    const [prompt] = promptsStartingWith(harness, "# Contract change review");
    expect(prompt).toBeDefined();
    expectEvidenceStandard(prompt!);
    // E2E-02 — the execution evidence is a candidate-review input only; a plan review is unchanged.
    expect(prompt).not.toContain("## Untrusted execution evidence");
    await reReview(harness, run.runId, "CONTRACT_CHANGE");
  });
});

describe("#1189 §2.B: the verdict shape and the reviewer's means are unchanged", () => {
  it("the verdict schema is the one every reviewer was already given", () => {
    expect(__testing.VERDICT_SCHEMA).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["verdict", "coveredFiles", "omittedItems", "findings"],
      properties: {
        verdict: { type: "string", enum: ["PASS", "REVISE", "BLOCK"] },
        coveredFiles: { type: "array", items: { type: "string" } },
        omittedItems: { type: "array", items: { type: "string" } },
        findings: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["category", "severity", "repository", "path", "summary", "detail"],
            properties: {
              category: {
                type: "string",
                enum: ["correctness", "regression", "security", "scope", "performance", "maintainability", "evidence", "freshness", "source"],
              },
              severity: { type: "string", enum: ["INFO", "MINOR", "MAJOR", "BLOCKER"] },
              repository: { type: "string" },
              path: { type: ["string", "null"] },
              summary: { type: "string" },
              detail: { type: "string" },
            },
          },
        },
      },
    });
  });

  it("the reviewer is invoked read-only with that schema and no tool list", async () => {
    const harness = makeHarness();
    await driveToReviewedCandidate(harness);
    const call = harness.scripted.invocations.find((invocation) => invocation.prompt.startsWith("# Candidate review"))!;
    expect(call.readOnly).toBe(true);
    expect(call.responseSchema).toEqual(__testing.VERDICT_SCHEMA);
    expect(Object.keys(call).filter((key) => /tool/i.test(key))).toEqual([]);
  });
});
