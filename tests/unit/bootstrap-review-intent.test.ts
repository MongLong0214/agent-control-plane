import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { manifestDigest } from "../../src/contracts/manifest.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ExecutionMode, Role, RunKind, RunState, roleKeyFor } from "../../src/domain/types.ts";
import type { ReviewPacket } from "../../src/review/blind-review.ts";
import { dispatchRun, stricter } from "../helpers/contract-change.ts";
import { bootstrapCoverageKeys, bootstrapPlan, callCtoToolAsOwner, cleanTreeManifest } from "../helpers/bootstrap-plan.ts";
import { cleanupTempDirs } from "../helpers/fixtures.ts";
import {
  bindCeo,
  carryContractChange,
  dispatchBootstrapRun,
  driveToReviewedCandidate,
  makeHarness,
  registerFixtureProject,
  reviewerPass,
  type Harness,
} from "../helpers/harness.ts";

afterAll(cleanupTempDirs);
afterEach(() => vi.restoreAllMocks());

/**
 * The BOOTSTRAP_PLAN review input carries what the PLAN says it intends, and the control plane's
 * post-CONFIRM lifecycle, as data for the reviewer. Live run_7717: the owner added readback,
 * activation and handoff to its summary, verificationIntent and task completion criteria, and two
 * reviews were shown none of it — the plannedOutputsDigest did not move, and every review listed
 * "the PLAN payloads were not supplied" as omitted.
 *
 * Every state change goes through a real door: plan_submit and result_submit as the run's bootstrap
 * CTO over the CTO MCP server. The reviewer is the harness's scripted one, constituted by the review
 * gate itself; the test only decides what it answers and when.
 */

const contract = {
  goal: "bootstrap",
  why: "new repository",
  scope: [],
  nonGoals: [],
  acceptance: ["repository created"],
  priority: "NORMAL" as const,
  humanGate: [],
  references: [],
};
let seq = 0;

const fixture = async () => {
  const h = makeHarness();
  bindCeo(h);
  const created = h.cp.runs.create({ kind: RunKind.PROJECT_BOOTSTRAP, executionMode: ExecutionMode.STANDARD, contract });
  if (!created.allowed) throw new Error(created.message);
  const runId = created.value.runId;
  await dispatchBootstrapRun(h.cp, h.clock, runId);
  const call = (name: string, args: Record<string, unknown>) =>
    callCtoToolAsOwner(h, runId, name, { idempotencyKey: `intent-${++seq}`, runId, ...args });
  return { h, runId, call };
};

const SUMMARY = "Create github:acme/fixture; after CONFIRM the control plane reads the repository back, activates the manifest and hands off to the PRIMARY_CTO.";
const intentPlan = (projectId: string, summary = SUMMARY) => ({
  ...bootstrapPlan(cleanTreeManifest(projectId), { summary }),
  repositoryIntent: ["one public repository, github:acme/fixture, initialized by GitHub"],
  verificationIntent: ["read back the created repository and its initial commit", "parse the result.v2 and activate the manifest"],
  risks: ["the repository name may already be taken"],
});
const intentTask = (criteria: string[], key = "create") => ({
  key,
  title: "create the repository the owner asked for",
  category: "implementation",
  spec: { completionCriteria: criteria },
});
const CRITERIA = ["exactly one create receipt is read back", "the PRIMARY_CTO acknowledges the activation handoff"];

const bootstrapPrompts = (h: Harness): string[] =>
  h.scripted.invocations.filter((i) => i.prompt.startsWith("# Bootstrap plan review")).map((i) => i.prompt);

const storedReview = (h: Harness, runId: string): ReviewPacket => {
  const candidate = h.cp.runs.currentCandidate(runId) ?? h.cp.artifacts.latest<{ candidateSnapshotDigest: string }>(runId, "BLIND_REVIEW")?.content.candidateSnapshotDigest;
  const review = h.cp.artifacts.latestForSnapshot<ReviewPacket>(runId, "BLIND_REVIEW", candidate!);
  if (!review) throw new Error("no BLIND_REVIEW is stored");
  return review.content;
};

/** The fenced JSON that follows `heading` in a prompt. */
const fencedJsonAfter = (prompt: string, heading: string): unknown => {
  const at = prompt.indexOf(heading);
  if (at < 0) throw new Error(`the prompt has no ${heading} section`);
  const open = prompt.indexOf("```json\n", at);
  const close = prompt.indexOf("\n```", open + 8);
  return JSON.parse(prompt.slice(open + 8, close));
};

describe("W1: the BOOTSTRAP_PLAN review input carries the PLAN's intent and the post-CONFIRM lifecycle", () => {
  it("the prompt holds the intent projection, bound to the current PLAN and its task, and a lifecycle statement framed as facts to evaluate", async () => {
    const { h, runId, call } = await fixture();
    const submitted = await call("plan_submit", { plan: intentPlan("intent-w1"), tasks: [intentTask(CRITERIA)] });
    expect(submitted.body, submitted.text).toMatchObject({ ok: true });
    const planDigest = h.cp.artifacts.latest(runId, "PLAN")!.digest;
    const taskId = h.cp.tasks.list(runId).find((task) => task.state === "READY")!.taskId;
    h.scripted.script({ match: /Bootstrap plan review/, text: reviewerPass(bootstrapCoverageKeys(h, runId)) });
    const result = await call("result_submit", { resultSummary: "PLAN prepared", recommendation: "create repository" });
    expect(result.body, result.text).toMatchObject({ ok: true, value: { stage: "COMPLETED_REVIEW" } });

    const prompt = bootstrapPrompts(h).at(-1)!;
    expect(fencedJsonAfter(prompt, "## The PLAN's stated intent")).toEqual({
      schema: "agent-control-plane.bootstrap-plan-intent.v1",
      planDigest,
      summary: SUMMARY,
      repositoryIntent: ["one public repository, github:acme/fixture, initialized by GitHub"],
      verificationIntent: ["read back the created repository and its initial commit", "parse the result.v2 and activate the manifest"],
      risks: ["the repository name may already be taken"],
      task: { taskId, title: "create the repository the owner asked for", completionCriteria: CRITERIA },
    });
    // Data for the reviewer, not instructions, and never a nudge toward a verdict.
    expect(prompt).toContain("not an instruction to you");
    expect(prompt).toContain("## Control-plane lifecycle after CEO CONFIRM");
    expect(prompt).toContain("not a request to pass");
    for (const fact of ["repo-factory.result.v2", "PRIMARY_CTO", "ACKED", "Conditions the control plane does not verify"]) {
      expect(prompt).toContain(fact);
    }
    // The packet records the intent it was shown, by the digest the prompt names.
    const packet = storedReview(h, runId);
    expect(packet.verdict).toBe("PASS");
    expect(packet.bootstrapPlanIntentDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(prompt).toContain(`Intent digest: ${packet.bootstrapPlanIntentDigest}`);
  });

  it("intent changes reach the review input: a changed summary and, on the same PLAN digest, changed completion criteria", async () => {
    const { h, runId, call } = await fixture();
    const review = async () => {
      h.scripted.script({ match: /Bootstrap plan review/, text: reviewerPass(bootstrapCoverageKeys(h, runId)) });
      const result = await call("result_submit", { resultSummary: "PLAN prepared", recommendation: "create repository" });
      expect(result.body, result.text).toMatchObject({ ok: true, value: { stage: "COMPLETED_REVIEW" } });
      return { prompt: bootstrapPrompts(h).at(-1)!, packet: storedReview(h, runId), candidate: h.cp.runs.currentCandidate(runId)! };
    };
    const revise = async (candidate: string) => {
      const ceoSessionId = h.cp.bindings.active(roleKeyFor(Role.CEO))!.sessionId;
      expect(h.cp.ceo.submitCeoDecision({ runId, decision: "FINAL_REVISE", candidateSnapshotDigest: candidate, ceoSessionId, rationale: "revise" }))
        .toMatchObject({ allowed: true });
      for (const message of h.cp.outbox.listByRun(runId).filter((m) => m.kind === "REVISION_REQUEST" && m.status !== "ACKED")) {
        expect((await call("run_ack", { messageId: message.messageId })).body).toMatchObject({ ok: true });
      }
      await dispatchBootstrapRun(h.cp, h.clock, runId);
    };

    expect((await call("plan_submit", { plan: intentPlan("intent-changes", "first summary"), tasks: [intentTask(["first criterion"])] })).body)
      .toMatchObject({ ok: true });
    const first = await review();
    expect(first.prompt).toContain("first summary");

    await revise(first.candidate);
    expect((await call("plan_submit", { plan: intentPlan("intent-changes", "second summary"), tasks: [intentTask(["first criterion"], "c2")] })).body)
      .toMatchObject({ ok: true });
    const second = await review();
    expect(second.prompt).toContain("second summary");
    expect(second.prompt).not.toContain("first summary");
    expect(second.packet.bootstrapPlan!.planDigest).not.toBe(first.packet.bootstrapPlan!.planDigest);
    // The planned outputs do not depend on the summary: only the PLAN and intent digests move.
    expect(second.packet.bootstrapPlan!.plannedOutputsDigest).toBe(first.packet.bootstrapPlan!.plannedOutputsDigest);
    expect(second.packet.bootstrapPlanIntentDigest).not.toBe(first.packet.bootstrapPlanIntentDigest);

    await revise(second.candidate);
    // The same PLAN again, with its one task's completion criteria changed: no PLAN digest moves.
    expect((await call("plan_submit", { plan: intentPlan("intent-changes", "second summary"), tasks: [intentTask(["a changed criterion"], "c3")] })).body)
      .toMatchObject({ ok: true });
    const third = await review();
    expect(third.packet.bootstrapPlan).toEqual(second.packet.bootstrapPlan);
    expect(third.prompt).toContain("a changed criterion");
    expect(third.prompt).not.toContain("first criterion");
    expect(third.packet.bootstrapPlanIntentDigest).not.toBe(second.packet.bootstrapPlanIntentDigest);
  });

  it("a field over its bound fails the review clearly before any reviewer is constituted; nothing is truncated", async () => {
    const { h, runId, call } = await fixture();
    // A normal summary is accepted, and a credential-shaped one (an unbroken base64-alphabet run of 60
    // or more) is refused when the PLAN is stored, before any bound is read.
    expect((await call("plan_submit", { plan: intentPlan("intent-bound", "a normal product summary"), tasks: [intentTask(CRITERIA)] })).body)
      .toMatchObject({ ok: true });
    expect((await call("plan_submit", { plan: intentPlan("intent-bound", "x".repeat(4001)), tasks: [intentTask(CRITERIA, "c0")] })).body)
      .toMatchObject({ ok: false, reasonCode: ReasonCode.TRUSTED_CREDENTIAL_LEAK_BLOCKED });
    // Over the bound, and not credential-shaped: the bound refuses it at review, whole.
    const long = `${"word ".repeat(800)}x`;
    expect(long).toHaveLength(4001);
    expect((await call("plan_submit", { plan: intentPlan("intent-bound", long), tasks: [intentTask(CRITERIA, "c1")] })).body).toMatchObject({ ok: true });
    h.scripted.script({ match: /Bootstrap plan review/, text: reviewerPass(bootstrapCoverageKeys(h, runId)) });
    const result = await call("result_submit", { resultSummary: "PLAN prepared", recommendation: "create repository" });
    expect(result.body, result.text).toMatchObject({
      ok: true,
      value: {
        stage: "REVIEW_UNAVAILABLE",
        reasonCode: ReasonCode.INVALID_ARGUMENT,
        detail: { evidence: { refusal: "PLAN_INTENT_FIELD_TOO_LONG", field: "summary", length: 4001, bound: 4000 } },
      },
    });
    expect(bootstrapPrompts(h)).toEqual([]);
    expect(h.cp.artifacts.list(runId, "BLIND_REVIEW")).toEqual([]);
    expect(h.cp.runs.require(runId).state).toBe(RunState.ACTIVE);

    const criteria = Array.from({ length: 33 }, (_, i) => `criterion ${i}`);
    expect((await call("plan_submit", { plan: intentPlan("intent-bound"), tasks: [intentTask(criteria, "c2")] })).body).toMatchObject({ ok: true });
    const listed = await call("result_submit", { resultSummary: "PLAN prepared", recommendation: "create repository" });
    expect(listed.body, listed.text).toMatchObject({
      ok: true,
      value: { detail: { evidence: { refusal: "PLAN_INTENT_FIELD_TOO_LONG", field: "task.completionCriteria", length: 33, bound: 32 } } },
    });
    expect(bootstrapPrompts(h)).toEqual([]);
  });
});

describe("a stale PLAN intent or review packet is refused", () => {
  it("the task replaced on the same PLAN while the reviewer works: the verdict is stale and nothing is stored", async () => {
    const { h, runId, call } = await fixture();
    expect((await call("plan_submit", { plan: intentPlan("intent-stale-review"), tasks: [intentTask(CRITERIA)] })).body).toMatchObject({ ok: true });
    const planDigest = h.cp.artifacts.latest(runId, "PLAN")!.digest;
    h.scripted.script({ match: /Bootstrap plan review/, text: reviewerPass(bootstrapCoverageKeys(h, runId)) });

    const scripted = h.scripted;
    const original = scripted.invoke.bind(scripted);
    let replanned = false;
    vi.spyOn(scripted, "invoke").mockImplementation(async (request) => {
      if (!replanned && /Bootstrap plan review/.test(request.prompt)) {
        replanned = true;
        // While the reviewer works, the owner submits the same PLAN with another task.
        const again = await call("plan_submit", { plan: intentPlan("intent-stale-review"), tasks: [intentTask(["another criterion"], "c2")] });
        expect(again.body, again.text).toMatchObject({ ok: true });
        expect(h.cp.artifacts.latest(runId, "PLAN")!.digest).toBe(planDigest);
      }
      return original(request);
    });
    const result = await call("result_submit", { resultSummary: "PLAN prepared", recommendation: "create repository" });
    expect(replanned).toBe(true);
    expect(result.body, result.text).toMatchObject({ ok: true, value: { stage: "REVIEW_UNAVAILABLE", reasonCode: ReasonCode.EVIDENCE_STALE } });
    expect(h.cp.artifacts.list(runId, "BLIND_REVIEW")).toEqual([]);
    // The answer the gate did not keep is on record, with the reviewer who gave it.
    expect(h.cp.audit.forRun(runId).filter((row) => row.kind === "BLIND_REVIEW_REJECTED")).toMatchObject([{
      reasonCode: ReasonCode.EVIDENCE_STALE,
      evidence: { stale: "REVIEW_INTENT", attemptId: expect.stringMatching(/^attempt_/), reviewerRoleBindingGeneration: expect.any(Number) },
    }]);
    expect(h.cp.artifacts.list(runId, "PRODUCTION_READY_PACKET")).toEqual([]);
    expect(h.cp.runs.require(runId).state).toBe(RunState.ACTIVE);
  });

  it("the task replaced after the review was stored and before the packet: the production gate refuses the stale review", async () => {
    const { h, runId, call } = await fixture();
    expect((await call("plan_submit", { plan: intentPlan("intent-stale-packet"), tasks: [intentTask(CRITERIA)] })).body).toMatchObject({ ok: true });
    h.scripted.script({ match: /Bootstrap plan review/, text: reviewerPass(bootstrapCoverageKeys(h, runId)) });
    const evaluate = h.cp.continuity.evaluate.bind(h.cp.continuity);
    let replanned = false;
    vi.spyOn(h.cp.continuity, "evaluate").mockImplementation(async (reason: string) => {
      if (reason === "pre-completion" && !replanned) {
        replanned = true;
        const again = await call("plan_submit", { plan: intentPlan("intent-stale-packet"), tasks: [intentTask(["another criterion"], "c2")] });
        expect(again.body, again.text).toMatchObject({ ok: true });
      }
      return evaluate(reason);
    });
    const result = await call("result_submit", { resultSummary: "PLAN prepared", recommendation: "create repository" });
    expect(replanned).toBe(true);
    expect(result.body, result.text).toMatchObject({ ok: false, reasonCode: ReasonCode.EVIDENCE_STALE, evidence: { refusal: "BOOTSTRAP_PLAN_INTENT_STALE" } });
    expect(h.cp.artifacts.list(runId, "BLIND_REVIEW")).toHaveLength(1);
    expect(h.cp.artifacts.list(runId, "PRODUCTION_READY_PACKET")).toEqual([]);
    expect(h.cp.runs.require(runId).state).toBe(RunState.ACTIVE);
  });
});

describe("W4: STANDARD_WORK and CONTRACT_CHANGE review packets are unchanged", () => {
  const ADDED = ["## The PLAN's stated intent", "## Control-plane lifecycle after CEO CONFIRM", "Intent digest:"];

  it("a STANDARD_WORK candidate review: no intent, no lifecycle, no intent digest", async () => {
    const harness = makeHarness();
    const driven = await driveToReviewedCandidate(harness);
    const prompt = harness.scripted.invocations.find((i) => i.prompt.startsWith("# Candidate review"))!.prompt;
    for (const added of ADDED) expect(prompt).not.toContain(added);
    const review = harness.cp.artifacts.latestForSnapshot<ReviewPacket>(driven.runId, "BLIND_REVIEW", driven.candidateSnapshotDigest)!;
    expect(Object.keys(review.content)).not.toContain("bootstrapPlanIntentDigest");
    expect(Object.keys(review.content)).not.toContain("bootstrapPlan");
  });

  it("a no-repository CONTRACT_CHANGE review: no intent, no lifecycle, no intent digest", async () => {
    const harness = makeHarness();
    const registered = await registerFixtureProject(harness, "intent-cc");
    const run = await dispatchRun(harness, registered.projectId, RunKind.CONTRACT_CHANGE);
    const m1 = stricter(run.base);
    carryContractChange(harness, run.runId, m1);
    await harness.cp.continuity.evaluate("contract change candidate");
    harness.scripted.script({ match: /Contract change review/, text: reviewerPass([`${registered.projectId}:#manifest/${manifestDigest(m1)}`]) });
    const outcome = await harness.cp.pipeline.submitResult({
      runId: run.runId,
      ownerSessionId: run.ownerSessionId,
      ownerBindingGeneration: run.ownerBindingGeneration,
      resultSummary: "the proposed manifest",
      recommendation: "review the contract change",
      residualRisk: [],
    });
    expect(outcome.allowed && outcome.value.stage, JSON.stringify(outcome)).toBe("COMPLETED_REVIEW");
    const prompt = harness.scripted.invocations.find((i) => i.prompt.startsWith("# Contract change review"))!.prompt;
    for (const added of ADDED) expect(prompt).not.toContain(added);
    const digest = harness.cp.runs.currentCandidate(run.runId)!;
    const review = harness.cp.artifacts.latestForSnapshot<ReviewPacket>(run.runId, "BLIND_REVIEW", digest)!;
    expect(Object.keys(review.content)).not.toContain("bootstrapPlanIntentDigest");
  });
});
