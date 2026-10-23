import { afterAll, describe, expect, it } from "vitest";

import { manifestDigest } from "../../src/contracts/manifest.ts";
import { ExecutionMode, RunKind } from "../../src/domain/types.ts";
import { __testing } from "../../src/review/blind-review.ts";
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

/** The evidence standard, phrase by phrase, as one reviewer prompt must state it. */
const expectEvidenceStandard = (prompt: string): void => {
  const text = flat(prompt);
  // The five things a finding's detail states.
  expect(text).toContain("Each finding's `detail` must state all five of these:");
  expect(text).toContain("1. Contract: the contract, invariant or acceptance criterion that breaks, and a reachable input or call order that breaks it.");
  expect(text).toContain("2. Location: the packet file and a concrete location or construct in it");
  expect(text).toContain("or a canonical artifact reference");
  expect(text).toContain("3. Effect: the result the contract expects, the result the current code produces, and the consumer or boundary affected.");
  expect(text).toContain("4. Origin: whether it is pre-existing or a regression introduced by this change");
  expect(text).toContain("and why.");
  expect(text).toContain("5. Evidence gap: anything you could not confirm from the packet, stated as an evidence gap, never as an established defect.");
  // Static evidence suffices, and no tools are offered to produce any other.
  expect(text).toContain("Static evidence is enough");
  expect(text).toContain("no executed witness is needed, and you have no tools to run one.");
  // No invented line numbers where none exist.
  expect(text).toContain(
    "A line number is not required, and must not be invented for a binary file, a deletion, a `#manifest/...` or `#operation/...` item, or an evidence or freshness finding.",
  );
  // Style is not a blocker; a contract-breaking maintainability problem is a defect.
  expect(text).toContain("A remark only about style, naming or a possible future extension is not a blocker");
  expect(text).toContain("A maintainability problem that breaks a stated contract is a defect");
  // The verdict is the reviewer's, whatever the severities.
  expect(text).toContain("Your verdict stands as you return it; severities do not change it.");
  // The standard comes before the response the reviewer is asked for.
  expect(prompt.indexOf("## What a finding must show")).toBeGreaterThan(-1);
  expect(prompt.indexOf("## What a finding must show")).toBeLessThan(prompt.indexOf("## Required response"));
};

const promptsStartingWith = (harness: ReturnType<typeof makeHarness>, heading: string): string[] =>
  harness.scripted.invocations.map((call) => call.prompt).filter((prompt) => prompt.startsWith(heading));

describe("#1189 §2.B: the reviewer prompt asks for checkable evidence", () => {
  it("a candidate review prompt states the evidence standard, and its example finding names the five parts", async () => {
    const harness = makeHarness();
    await driveToReviewedCandidate(harness);
    const [prompt] = promptsStartingWith(harness, "# Candidate review");
    expect(prompt).toBeDefined();
    expectEvidenceStandard(prompt!);
    const text = flat(prompt!);
    expect(text).not.toContain("what is wrong and why it matters");
    for (const part of ["Contract:", "Location:", "Effect:", "Origin:", "Evidence gap:"]) {
      expect(text).toMatch(new RegExp(`"detail": "[^"]*${part}`));
    }
    expect(text).toContain("you have no tools and are not expected to look anything up or run anything.");
    expect(text).toContain("Evidence the packet should carry and does not is itself a finding (category `evidence`)");
    expect(text).toContain("a guess about code the packet does not show is not.");
  });

  it("every chunk prompt and the final reviewer's prompt state it too", async () => {
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
    const runId = created.value.runId;
    const dispatched = await harness.cp.runs.dispatch(runId);
    if (!dispatched.allowed) throw new Error(dispatched.message);
    const run = dispatched.value;
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
    writeFiles(harness.repoPath, { "src/app.js": `module.exports = () => 2;\n// ${"x".repeat(130_000)}\n` });
    const head = commitAll(harness.repoPath, "large reviewed change");
    harness.cp.tasks.finishExecution(execution.value.executionId, { status: "SUCCEEDED", resultDigest: `sha256:${head}` });
    harness.scripted.script(
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
    expect(chunks.length).toBeGreaterThan(1);
    expect(finals).toHaveLength(1);
    for (const prompt of [...chunks, ...finals]) expectEvidenceStandard(prompt);
    for (const prompt of [...chunks, ...finals]) expect(prompt.length).toBeLessThanOrEqual(120_000);
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
