import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { sha256 } from "../../src/core/digest.ts";
import { manifestDigest, type ProjectManifest } from "../../src/contracts/manifest.ts";
import { Daemon } from "../../src/daemon/daemon.ts";
import { Role, RunKind, RunState, roleKeyFor } from "../../src/domain/types.ts";
import { createCtoMcpPort } from "../../src/mcp/cto-server.ts";
import type { ReviewPacket } from "../../src/review/blind-review.ts";
import {
  CANDIDATE_SNAPSHOT_SCHEMA_ID,
  buildNoRepositoryCandidateSnapshot,
  candidateSnapshotDigest,
  type CandidateSnapshot,
} from "../../src/snapshot/candidate-snapshot.ts";
import {
  WORKFLOW,
  WORKFLOW_PATH,
  dispatchRun,
  normalized,
  planCarrying,
  storedPlan,
  stricter,
  type DispatchedRun,
} from "../helpers/contract-change.ts";
import { cleanupTempDirs, commitAll, tempDir, writeFiles } from "../helpers/fixtures.ts";
import {
  applyPassingChange,
  bindWorker,
  carryContractChange,
  driveToReviewedCandidate,
  makeHarness,
  registerFixtureProject,
  reviewerPass,
  type Harness,
} from "../helpers/harness.ts";

afterAll(cleanupTempDirs);
afterEach(() => vi.restoreAllMocks());

/**
 * Issue #246 B2-a — a CONTRACT_CHANGE candidate and its blind review are bound to the manifest its
 * PLAN carries and to the base it changes, a PLAN replaced while it is judged leaves it stale, other
 * candidates are unchanged, and nothing here activates anything.
 *
 * PLANs go through the CTO MCP port's own `submitPlan` routing. The pipeline, the review gate and the
 * production gate are the production ones; the reviewer is the harness's scripted one. No PLAN,
 * snapshot, review or state is written by the test.
 */

describe("regression controls: other candidates are unchanged", () => {
  it("snapshot digests without contractChange are byte-identical to the goldens computed before it", () => {
    // The C2 goldens, computed with `candidateSnapshotDigest` at c315463e.
    const golden: CandidateSnapshot = {
      schema: CANDIDATE_SNAPSHOT_SCHEMA_ID,
      runId: "run_golden",
      contractDigest: `sha256:${"7".repeat(64)}`,
      repositories: [{
        identity: "github:acme/golden",
        repositoryRole: "primary",
        baseBranch: "dev",
        baseHead: "1".repeat(40),
        sourceBranch: "dev",
        sourceHead: "2".repeat(40),
        candidateHead: "3".repeat(40),
        treeDigest: `git-tree:${"4".repeat(40)}`,
        diffDigest: `sha256:${"5".repeat(64)}`,
        worktreeId: null,
        manifestDigest: `sha256:${"6".repeat(64)}`,
        touchedPaths: ["src/app.js", "README.md"],
      }],
      createdAt: "2026-10-09T00:00:00.000Z",
    };
    expect(candidateSnapshotDigest(golden)).toBe("sha256:3c56cbbd905484b442ecc8f96cbf8411ed0fbdf691b958b94825e8101fd0ee47");
    expect(candidateSnapshotDigest({ ...golden, repositories: [] })).toBe("sha256:31cb201a618b58959b41b529634f4e2ad9636234beb360390934127f2722741f");
    const administrative = buildNoRepositoryCandidateSnapshot(
      { runId: golden.runId, contractDigest: golden.contractDigest },
      { nowIso: () => "2026-10-09T01:00:00.000Z" } as Parameters<typeof buildNoRepositoryCandidateSnapshot>[1],
    );
    expect(Object.keys(administrative)).not.toContain("contractChange");
    expect(candidateSnapshotDigest(administrative)).toBe("sha256:31cb201a618b58959b41b529634f4e2ad9636234beb360390934127f2722741f");
  });

  it("a contractChange is part of the candidate's identity, field by field", () => {
    const clock = { nowIso: () => "2026-10-09T01:00:00.000Z" } as Parameters<typeof buildNoRepositoryCandidateSnapshot>[1];
    const change = { planDigest: `sha256:${"a".repeat(64)}`, manifestDigest: `sha256:${"b".repeat(64)}`, baseManifestDigest: `sha256:${"c".repeat(64)}` };
    const params = { runId: "run_golden", contractDigest: `sha256:${"7".repeat(64)}` };
    const without = candidateSnapshotDigest(buildNoRepositoryCandidateSnapshot(params, clock));
    const withChange = candidateSnapshotDigest(buildNoRepositoryCandidateSnapshot({ ...params, contractChange: change }, clock));
    expect(withChange).not.toBe(without);
    for (const field of ["planDigest", "manifestDigest", "baseManifestDigest"] as const) {
      const moved = candidateSnapshotDigest(buildNoRepositoryCandidateSnapshot({ ...params, contractChange: { ...change, [field]: `sha256:${"d".repeat(64)}` } }, clock));
      expect(moved).not.toBe(withChange);
    }
  });

  it("a STANDARD_WORK candidate and its review carry no contract change", async () => {
    const harness = makeHarness();
    const driven = await driveToReviewedCandidate(harness);
    const snapshot = harness.cp.artifacts.latestForSnapshot<CandidateSnapshot>(driven.runId, "CANDIDATE_SNAPSHOT", driven.candidateSnapshotDigest)!;
    expect(Object.keys(snapshot.content)).not.toContain("contractChange");
    const review = harness.cp.artifacts.latestForSnapshot<ReviewPacket>(driven.runId, "BLIND_REVIEW", driven.candidateSnapshotDigest)!;
    expect(Object.keys(review.content)).not.toContain("contractChange");
    expect(review.content.inputManifest).toMatchObject({ diff: true, verificationEvidence: true, projectContext: false });
    const prompt = harness.scripted.invocations.find((invocation) => invocation.prompt.startsWith("# Candidate review"))!.prompt;
    expect(prompt).not.toContain("## Contract change");
  });
});

/** A dispatched CONTRACT_CHANGE run with no repositories, its PLAN carrying M1. */
const noRepositoryChange = async (harness: Harness, projectId = "cc-pipeline") => {
  const registered = await registerFixtureProject(harness, projectId);
  const run = await dispatchRun(harness, registered.projectId, RunKind.CONTRACT_CHANGE);
  const m1 = stricter(run.base);
  carryContractChange(harness, run.runId, m1);
  await harness.cp.continuity.evaluate("contract change candidate");
  return { run, m1, registered };
};

const submit = (harness: Harness, run: DispatchedRun) =>
  harness.cp.pipeline.submitResult({
    runId: run.runId,
    ownerSessionId: run.ownerSessionId,
    ownerBindingGeneration: run.ownerBindingGeneration,
    resultSummary: "the proposed manifest",
    recommendation: "review the contract change",
    residualRisk: [],
  });

const frozenSnapshot = (harness: Harness, runId: string) => {
  const digest = harness.cp.runs.currentCandidate(runId);
  return digest ? harness.cp.artifacts.latestForSnapshot<CandidateSnapshot>(runId, "CANDIDATE_SNAPSHOT", digest)?.content ?? null : null;
};

const manifestKey = (projectId: string, manifest: ProjectManifest) => `${projectId}:#manifest/${manifestDigest(manifest)}`;

/** Holds the next reviewer invocation whose prompt matches until `release` is called. */
const holdNextReview = (harness: Harness, match: RegExp) => {
  const scripted = harness.scripted;
  const original = scripted.invoke.bind(scripted);
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  let held = false;
  vi.spyOn(scripted, "invoke").mockImplementation(async (request) => {
    if (!held && match.test(request.prompt)) {
      held = true;
      enter();
      await released;
    }
    return original(request);
  });
  return { entered, release };
};

/**
 * A dispatched CONTRACT_CHANGE run on the fixture repository: its PLAN carries M1, and its one task's
 * worker commits the passing change and the CI workflow M1 approves.
 */
const repositoryChange = async (harness: Harness, projectId: string) => {
  const registered = await registerFixtureProject(harness, projectId);
  const run = await dispatchRun(harness, registered.projectId, RunKind.CONTRACT_CHANGE, [
    { repositoryId: registered.repositoryId, repositoryRole: "primary", baseBranch: "dev" },
  ]);
  const m1 = stricter(run.base);
  carryContractChange(harness, run.runId, m1);
  const tasks = harness.cp.tasks.submit(run.runId, [{ key: "workflow", title: "add the CI workflow", category: "implementation" }]);
  if (!tasks.allowed) throw new Error(tasks.message);
  const task = harness.cp.tasks.ready(run.runId)[0]!;
  const execution = harness.cp.tasks.startExecution({
    runId: run.runId,
    taskId: task.taskId,
    ownerBindingGeneration: run.ownerBindingGeneration,
    workerSessionId: bindWorker(harness, task.taskId),
    provider: "scripted",
    model: "scripted-worker",
    repositoryId: registered.repositoryId,
  });
  if (!execution.allowed) throw new Error(execution.message);
  applyPassingChange(harness.repoPath, `feature/F1-${projectId}`);
  writeFiles(harness.repoPath, { [WORKFLOW_PATH]: WORKFLOW });
  const head = commitAll(harness.repoPath, "add the CI workflow the contract change approves");
  harness.cp.tasks.finishExecution(execution.value.executionId, { status: "SUCCEEDED", resultDigest: `sha256:${head}` });
  await harness.cp.continuity.evaluate("repository contract change");
  return { registered, run, m1 };
};

describe("snapshot and review bind the manifest and its base", () => {
  it("a no-repository CONTRACT_CHANGE candidate binds {PLAN, manifest, base} and is reviewed against both manifests", async () => {
    const harness = makeHarness();
    const { run, m1 } = await noRepositoryChange(harness);
    const outcome = await submit(harness, run);
    expect(outcome.allowed, JSON.stringify(outcome)).toBe(true);
    expect(outcome.allowed && outcome.value.stage).toBe("COMPLETED_REVIEW");

    const snapshot = frozenSnapshot(harness, run.runId)!;
    expect(snapshot.repositories).toEqual([]);
    expect(snapshot.contractChange).toEqual({
      planDigest: storedPlan(harness, run.runId)!.digest,
      manifestDigest: manifestDigest(m1),
      baseManifestDigest: run.baseDigest,
    });

    const prompt = harness.scripted.invocations.find((invocation) => invocation.prompt.startsWith("# Contract change review"))!.prompt;
    expect(prompt).toContain(JSON.stringify(m1, null, 2));
    expect(prompt).toContain(JSON.stringify(run.base, null, 2));
    expect(prompt).toContain(`- ${manifestKey(run.projectId, m1)}`);

    const digest = harness.cp.runs.currentCandidate(run.runId)!;
    const review = harness.cp.artifacts.latestForSnapshot<ReviewPacket>(run.runId, "BLIND_REVIEW", digest)!;
    expect(review.producedBy).toBe("blind-review-gate");
    expect(review.content.verdict).toBe("PASS");
    expect(review.content.coveredFiles).toEqual([manifestKey(run.projectId, m1)]);
    expect(review.content.inputManifest).toMatchObject({ diff: false, verificationEvidence: false, projectContext: true });
    expect(review.content.contractChange).toEqual({
      ...snapshot.contractChange,
      workflowEvidence: [{
        repositoryRole: "primary",
        repositoryRemote: "github:acme/fixture",
        path: WORKFLOW_PATH,
        checkName: "unit-tests",
        approvedDigest: sha256(WORKFLOW),
        unapprovedFirstActivation: false,
        unchangedFromBase: false,
      }],
    });
    expect(harness.cp.artifacts.latestForSnapshot(run.runId, "PRODUCTION_READY_PACKET", digest)).not.toBeNull();
    expect(harness.cp.runs.require(run.runId).state).toBe(RunState.READY_FOR_CEO_REVIEW);
  });

  it("a review that does not cover #manifest/<digest> is not a PASS, and no packet is published", async () => {
    const harness = makeHarness();
    const registered = await registerFixtureProject(harness, "cc-uncovered");
    const run = await dispatchRun(harness, registered.projectId, RunKind.CONTRACT_CHANGE);
    const m1 = stricter(run.base);
    const submitted = createCtoMcpPort(harness.cp).submitPlan(run.runId, planCarrying(m1));
    expect(submitted.allowed).toBe(true);
    harness.scripted.script({ match: /Contract change review/, text: reviewerPass([]) });
    await harness.cp.continuity.evaluate("uncovered review");
    const outcome = await submit(harness, run);
    expect(outcome.allowed && outcome.value.stage).toBe("REVISION_REQUIRED");
    const digest = harness.cp.runs.currentCandidate(run.runId)!;
    const review = harness.cp.artifacts.latestForSnapshot<ReviewPacket>(run.runId, "BLIND_REVIEW", digest)!;
    expect(review.content.verdict).toBe("REVISE");
    expect(review.content.omittedItems).toEqual([manifestKey(run.projectId, m1)]);
    expect(harness.cp.artifacts.list(run.runId, "PRODUCTION_READY_PACKET")).toEqual([]);
    expect(harness.cp.runs.require(run.runId).state).toBe(RunState.ACTIVE);
  });

  it("W12: a PLAN replaced while its review is pending leaves the candidate stale: nothing is stored or published", async () => {
    const harness = makeHarness();
    const { run } = await noRepositoryChange(harness, "cc-swap-review");
    const held = holdNextReview(harness, /Contract change review/);
    const pending = submit(harness, run);
    await held.entered;
    const frozen = frozenSnapshot(harness, run.runId)!;
    const m2 = normalized({ ...stricter(run.base), commitlore: { mode: "required" } });
    expect(createCtoMcpPort(harness.cp).submitPlan(run.runId, planCarrying(m2)).allowed).toBe(true);
    held.release();
    const outcome = await pending;
    expect(outcome.allowed && outcome.value.stage).toBe("CANDIDATE_STALE");
    expect(harness.cp.artifacts.list(run.runId, "BLIND_REVIEW")).toEqual([]);
    expect(harness.cp.artifacts.list(run.runId, "PRODUCTION_READY_PACKET")).toEqual([]);
    expect(frozen.contractChange?.manifestDigest).not.toBe(manifestDigest(m2));
    expect(harness.cp.runs.require(run.runId).state).toBe(RunState.ACTIVE);
  });

  it("W12: a PLAN replaced after a PASS but before publication leaves the candidate stale at publication", async () => {
    const harness = makeHarness();
    const { run } = await noRepositoryChange(harness, "cc-swap-publication");
    const continuity = harness.cp.continuity;
    const evaluate = continuity.evaluate.bind(continuity);
    const m2 = normalized({ ...stricter(run.base), commitlore: { mode: "required" } });
    vi.spyOn(continuity, "evaluate").mockImplementation(async (reason: string) => {
      if (reason === "pre-completion") {
        expect(createCtoMcpPort(harness.cp).submitPlan(run.runId, planCarrying(m2)).allowed).toBe(true);
      }
      return evaluate(reason);
    });
    const outcome = await submit(harness, run);
    expect(outcome.allowed && outcome.value.stage).toBe("CANDIDATE_STALE");
    // The review was of the frozen PLAN and is on record; it publishes nothing for a PLAN since replaced.
    expect(harness.cp.artifacts.list(run.runId, "BLIND_REVIEW")).toHaveLength(1);
    expect(harness.cp.artifacts.list(run.runId, "PRODUCTION_READY_PACKET")).toEqual([]);
  });

  it("a CONTRACT_CHANGE candidate with a repository is reviewed for its files and its manifest, and verified against its pin", async () => {
    const harness = makeHarness();
    const { registered, run, m1 } = await repositoryChange(harness, "cc-with-repository");
    harness.scripted.script({
      match: /# Candidate review/,
      text: reviewerPass([
        `${registered.identity}:src/app.js`,
        `${registered.identity}:${WORKFLOW_PATH}`,
        manifestKey(run.projectId, m1),
      ]),
    });
    const outcome = await submit(harness, run);
    expect(outcome.allowed, JSON.stringify(outcome)).toBe(true);
    expect(outcome.allowed && outcome.value.stage, JSON.stringify(outcome)).toBe("COMPLETED_REVIEW");

    const snapshot = frozenSnapshot(harness, run.runId)!;
    expect(snapshot.repositories.map((repository) => repository.identity)).toEqual([registered.identity]);
    expect(snapshot.contractChange).toMatchObject({ manifestDigest: manifestDigest(m1), baseManifestDigest: run.baseDigest });
    const prompt = harness.scripted.invocations.find((invocation) => invocation.prompt.startsWith("# Candidate review"))!.prompt;
    expect(prompt).toContain("## Contract change");
    expect(prompt).toContain(`- ${manifestKey(run.projectId, m1)}`);
    const digest = harness.cp.runs.currentCandidate(run.runId)!;
    const review = harness.cp.artifacts.latestForSnapshot<ReviewPacket>(run.runId, "BLIND_REVIEW", digest)!;
    expect(review.content.contractChange).toMatchObject(snapshot.contractChange!);
    expect(review.content.coveredRepositories.sort()).toEqual([registered.identity, run.projectId].sort());
    // Verification is the pinned base's bar, never the bar the candidate proposes.
    const verification = harness.cp.artifacts.latestForSnapshot<{ results: Array<{ commandId: string }> }>(run.runId, "VERIFICATION", digest)!;
    expect(verification.content.results.map((result) => result.commandId)).toEqual(["verify"]);
  });

  it("a repository CONTRACT_CHANGE review that omits the manifest is not a PASS", async () => {
    const harness = makeHarness();
    const { registered, run, m1 } = await repositoryChange(harness, "cc-repository-uncovered");
    harness.scripted.script({
      match: /# Candidate review/,
      text: reviewerPass([`${registered.identity}:src/app.js`, `${registered.identity}:${WORKFLOW_PATH}`]),
    });
    const outcome = await submit(harness, run);
    expect(outcome.allowed && outcome.value.stage).toBe("REVISION_REQUIRED");
    const digest = harness.cp.runs.currentCandidate(run.runId)!;
    const review = harness.cp.artifacts.latestForSnapshot<ReviewPacket>(run.runId, "BLIND_REVIEW", digest)!;
    expect(review.content.omittedItems).toEqual([manifestKey(run.projectId, m1)]);
    expect(harness.cp.artifacts.list(run.runId, "PRODUCTION_READY_PACKET")).toEqual([]);
  });

  it("W12: a repository CONTRACT_CHANGE whose PLAN is replaced while it is reviewed stores and publishes nothing", async () => {
    const harness = makeHarness();
    const { registered, run, m1 } = await repositoryChange(harness, "cc-repository-swap");
    harness.scripted.script({
      match: /# Candidate review/,
      text: reviewerPass([
        `${registered.identity}:src/app.js`,
        `${registered.identity}:${WORKFLOW_PATH}`,
        manifestKey(run.projectId, m1),
      ]),
    });
    const held = holdNextReview(harness, /# Candidate review/);
    const pending = submit(harness, run);
    await held.entered;
    const m2 = normalized({ ...m1, commitlore: { mode: "required" } });
    expect(createCtoMcpPort(harness.cp).submitPlan(run.runId, planCarrying(m2)).allowed).toBe(true);
    held.release();
    const outcome = await pending;
    expect(outcome.allowed && outcome.value.stage).toBe("CANDIDATE_STALE");
    expect(harness.cp.artifacts.list(run.runId, "BLIND_REVIEW")).toEqual([]);
    expect(harness.cp.artifacts.list(run.runId, "PRODUCTION_READY_PACKET")).toEqual([]);
  });
});

/** Answers every reviewer the way an honest one would: each chunk claims exactly the items it was given. */
const answerChunksHonestly = (harness: Harness) => {
  const scripted = harness.scripted;
  const original = scripted.invoke.bind(scripted);
  vi.spyOn(scripted, "invoke").mockImplementation(async (request) => {
    if (!/^# (Review chunk|Final review)/.test(request.prompt)) return original(request);
    const claims: string[] = [];
    if (request.prompt.startsWith("# Review chunk")) {
      let identity: string | null = null;
      let listing = false;
      for (const line of request.prompt.slice(request.prompt.indexOf("## Actual diff")).split("\n")) {
        if (line.startsWith("### ")) { identity = line.slice(4); listing = false; continue; }
        if (line === "Files:") { listing = true; continue; }
        if (line.startsWith("```")) { listing = false; continue; }
        if (listing && identity !== null && line.startsWith("- ")) claims.push(`${identity}:${line.slice(2)}`);
      }
    }
    harness.scripted.script({ match: /^# (Review chunk|Final review)/, text: reviewerPass(claims) });
    return original(request);
  });
};

describe("a CONTRACT_CHANGE candidate too large for one reviewer", () => {
  it("is chunked, the first chunk's reviewer accounts for the manifest, and the review binds the change", async () => {
    const harness = makeHarness();
    const { registered, run, m1 } = await repositoryChange(harness, "cc-chunked");
    writeFiles(harness.repoPath, { "src/app.js": `module.exports = () => 2;\n// ${"x".repeat(130_000)}\n` });
    commitAll(harness.repoPath, "a change too large for one reviewer");
    answerChunksHonestly(harness);
    const outcome = await submit(harness, run);
    expect(outcome.allowed && outcome.value.stage, JSON.stringify(outcome).slice(0, 400)).toBe("COMPLETED_REVIEW");
    const chunks = harness.scripted.invocations.filter((invocation) => invocation.prompt.startsWith("# Review chunk"));
    expect(chunks.length).toBeGreaterThan(1);
    const carrying = chunks.filter((invocation) => invocation.prompt.includes(`- #manifest/${manifestDigest(m1)}`));
    expect(carrying.map((invocation) => invocation.prompt.split("\n")[0])).toEqual([`# Review chunk 1 of ${chunks.length}`]);
    const digest = harness.cp.runs.currentCandidate(run.runId)!;
    const review = harness.cp.artifacts.latestForSnapshot<ReviewPacket>(run.runId, "BLIND_REVIEW", digest)!;
    expect(review.content.chunked).toBe(true);
    expect(review.content.coveredFiles).toContain(manifestKey(run.projectId, m1));
    expect(review.content.coveredFiles).toContain(`${registered.identity}:src/app.js`);
    expect(review.content.contractChange?.manifestDigest).toBe(manifestDigest(m1));
  });
});

describe("standalone-deploy safety: nothing is activated, granted or completed differently", () => {
  it("a reviewed, confirmed and finalized CONTRACT_CHANGE leaves the project's active manifest where it was", async () => {
    const harness = makeHarness();
    const { run, m1, registered } = await noRepositoryChange(harness, "cc-no-activation");
    const projectBefore = harness.cp.projects.get(run.projectId)!.activeManifestDigest;
    const outcome = await submit(harness, run);
    expect(outcome.allowed && outcome.value.stage).toBe("COMPLETED_REVIEW");
    const digest = harness.cp.runs.currentCandidate(run.runId)!;
    await harness.cp.continuity.evaluate("confirm the contract change");
    const ceo = harness.cp.bindings.active(roleKeyFor(Role.CEO))!;
    const confirmed = harness.cp.ceo.submitCeoDecision({
      runId: run.runId,
      decision: "CONFIRM",
      candidateSnapshotDigest: digest,
      ceoSessionId: ceo.sessionId,
      rationale: "standalone-deploy safety witness",
    });
    expect(confirmed.allowed, JSON.stringify(confirmed)).toBe(true);
    const daemon = new Daemon(harness.cp, { stateDir: tempDir("acp-cc-no-activation-") });
    expect((await daemon.start()).allowed).toBe(true);
    await daemon.stop();
    // The run completes exactly as a CONTRACT_CHANGE run completed before this slice ...
    expect(harness.cp.runs.require(run.runId).state).toBe(RunState.COMPLETED);
    // ... and nothing moved: no activation, no grant, no stored proposed manifest, no drift.
    expect(harness.cp.projects.get(run.projectId)!.activeManifestDigest).toBe(projectBefore);
    expect(projectBefore).toBe(run.baseDigest);
    expect(harness.cp.projects.manifest(manifestDigest(m1))).toBeNull();
    // The only APPROVAL is the CTO's final approval of the packet; no activation grant exists.
    const approvals = harness.cp.artifacts.list<Record<string, unknown>>(run.runId, "APPROVAL");
    expect(approvals.map((approval) => approval.producedBy)).toEqual(["service"]);
    expect(approvals.filter((approval) => approval.content["schema"] === "acp.manifest-activation-grant.v1")).toEqual([]);
    expect(harness.cp.audit.byKind("PROJECT_MANIFEST_ACTIVATED")).toEqual([]);
    expect(harness.cp.repositories.byId(registered.repositoryId)!.activeManifestDigest).toBe(run.baseDigest);
    // A run dispatched after it still pins, and is verified against, the base.
    const next = await dispatchRun(harness, run.projectId, RunKind.STANDARD_WORK, [
      { repositoryId: registered.repositoryId, repositoryRole: "primary", baseBranch: "dev" },
    ]);
    expect(next.baseDigest).toBe(run.baseDigest);
  });
});
