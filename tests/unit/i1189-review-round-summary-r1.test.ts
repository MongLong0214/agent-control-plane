import { afterAll, describe, expect, it } from "vitest";

import { ExecutionMode, RunKind } from "../../src/domain/types.ts";
import { readReviewRoundSources, summarizeReviewRounds } from "../../src/review/review-round-summary.ts";
import { bootstrapCoverageKeys, bootstrapPlan, cleanTreeManifest, reviewBootstrapPlan, submitBootstrapPlan } from "../helpers/bootstrap-plan.ts";
import { cleanupTempDirs, gitSync } from "../helpers/fixtures.ts";
import { applyPassingChange, bindCeo, dispatchBootstrapRun, makeHarness, registerFixtureProject, reviewerPass, reviewerRevise } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * #1189 round-1 review witnesses (R1-01, R1-02, R1-03), copied from the reviewer's probes. The only
 * change is that the probes' diagnostic `console.log` lines are assertion messages here. The reviewer
 * is the harness's scripted one: scripted pipeline results, not live evidence.
 */

async function setup() {
  const h = makeHarness();
  bindCeo(h);
  const created = h.cp.runs.create({kind: RunKind.PROJECT_BOOTSTRAP, executionMode: ExecutionMode.STANDARD,
    contract: {goal:"bootstrap",why:"fixture",scope:[],nonGoals:[],acceptance:["repository created"],priority:"NORMAL",humanGate:[],references:[]}});
  if (!created.allowed) throw new Error(created.message);
  const runId = created.value.runId;
  await dispatchBootstrapRun(h.cp, h.clock, runId);
  const plan = bootstrapPlan(cleanTreeManifest("review-1192"));
  await submitBootstrapPlan(h, runId, plan);
  const run = h.cp.runs.require(runId);
  const submit = () => h.cp.pipeline.submitResult({runId,ownerSessionId:run.ownerSessionId!,ownerBindingGeneration:run.ownerBindingGeneration!,resultSummary:"outputs",recommendation:"create"});
  const summary = () => summarizeReviewRounds(readReviewRoundSources(h.cp,runId));
  return {h,runId,plan,submit,summary};
}

describe("#1189 round-1 review witnesses", () => {
  it("R1-01: keeps a reclaimed attempt's late failure on that attempt", async () => {
    const {h,runId,submit,summary} = await setup();
    let entered!: () => void;
    const hasEntered = new Promise<void>(resolve => entered=resolve);
    let release!: () => void;
    const held = new Promise<void>(resolve => release=resolve);
    const invoke = h.scripted.invoke.bind(h.scripted);
    let calls=0;
    h.scripted.invoke = async request => {
      if (request.prompt.startsWith("# Bootstrap plan review") && ++calls===1) {
        entered();
        await held;
      }
      return invoke(request);
    };
    h.scripted.script({match:/Bootstrap plan review/,text:reviewerPass(bootstrapCoverageKeys(h,runId)),once:false});
    const first = submit();
    await hasEntered;
    h.clock.advance(31*60*1000);
    const second = await submit();
    release();
    const prior = await first;
    expect(second).toMatchObject({allowed:true,value:{stage:"COMPLETED_REVIEW"}});
    expect(prior).toMatchObject({allowed:true,value:{stage:"REVIEW_UNAVAILABLE"}});
    const overlap = JSON.stringify(summary().rounds.map(r=>({outcome:r.outcome,ready:r.readyForCeo,reason:r.reasonCode,attempt:r.attemptId})));
    expect(summary().rounds.map(r=>r.outcome), overlap).toEqual(["REVIEW_UNAVAILABLE","REVIEW_PASSED"]);
  });

  it("R1-02: preserves a human FINAL_REVISE before another freeze exists", async () => {
    const {h,runId,plan,summary} = await setup();
    const reviewed = await reviewBootstrapPlan(h,runId,plan);
    const revised = h.cp.ceo.submitCeoDecision({runId,decision:"FINAL_REVISE",candidateSnapshotDigest:reviewed.snapshotDigest,ceoSessionId:reviewed.ceoSessionId,rationale:"needs revision"});
    expect(revised.allowed).toBe(true);
    expect(h.cp.audit.forRun(runId).some(r=>r.kind==="CEO_DECISION")).toBe(true);
    const intervention = JSON.stringify({state:summary().runState,interventions:summary().rounds.map(r=>r.interventions),totals:summary().totals});
    expect(summary().rounds.flatMap(r=>r.interventions).some(r=>r.kind==="CEO_DECISION"), intervention).toBe(true);
  });

  it("R1-01: does not replace the second review with replayed first-attempt events", async () => {
    const {h,runId,submit,summary} = await setup();
    h.scripted.script({match:/Bootstrap plan review/,text:reviewerRevise(bootstrapCoverageKeys(h,runId),"first defect")});
    expect(await submit()).toMatchObject({allowed:true,value:{stage:"REVISION_REQUIRED"}});
    const old = h.cp.audit.forRun(runId).filter(r=>["BLIND_REVIEW_COMPLETED","REVISION_RETURNED_TO_CTO"].includes(r.kind));
    h.scripted.script({match:/Bootstrap plan review/,text:reviewerRevise(bootstrapCoverageKeys(h,runId),"second defect")});
    expect(await submit()).toMatchObject({allowed:true,value:{stage:"REVISION_REQUIRED"}});
    for(const r of old) expect(h.cp.audit.record({...r,reasonCode:r.reasonCode as never}).allowed).toBe(true);
    const replay = JSON.stringify(summary().rounds.map(r=>r.review?.findings.map(f=>f.summary)));
    expect(summary().rounds[1]!.review!.findings.map(f=>f.summary), replay).toEqual(["second defect"]);
  });

  it("R1-03: does not count an empty commit as an actual source change", async () => {
    const h=makeHarness();
    const {projectId,repositoryId}=await registerFixtureProject(h);
    bindCeo(h);
    const created=h.cp.runs.create({projectId,executionMode:ExecutionMode.STANDARD,
      contract:{goal:"app returns 2",why:"fixture",scope:["src/app.js"],nonGoals:[],acceptance:["app returns 2"],priority:"NORMAL",humanGate:[],references:[]},
      repositories:[{repositoryId,repositoryRole:"primary",baseBranch:"dev"}]});
    if(!created.allowed) throw new Error(created.message);
    const runId=created.value.runId;
    expect((await h.cp.runs.dispatch(runId)).allowed).toBe(true);
    applyPassingChange(h.repoPath);
    const first=await h.cp.pipeline.freeze(runId);
    gitSync(h.repoPath,["commit","--allow-empty","-m","no source changes"]);
    const second=await h.cp.pipeline.freeze(runId);
    if(!first.allowed || !second.allowed) throw new Error("freeze failed");
    expect(first.value.repositories[0]!.treeDigest).toBe(second.value.repositories[0]!.treeDigest);
    expect(first.value.repositories[0]!.diffDigest).toBe(second.value.repositories[0]!.diffDigest);
    const summary=summarizeReviewRounds(readReviewRoundSources(h.cp,runId));
    const emptyCommit = JSON.stringify(summary.rounds.map(r=>({digest:r.candidateSnapshotDigest,entry:r.entry})));
    expect(summary.totals.sourceChanges, emptyCommit).toBe(0);
  });
});

/** The R1-01 overlap: attempt 1's review is held past its lease, attempt 2 passes, then attempt 1 ends. */
const overlap = async () => {
  const {h,runId,submit,summary} = await setup();
  let entered!: () => void;
  const hasEntered = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const invoke = h.scripted.invoke.bind(h.scripted);
  let calls = 0;
  h.scripted.invoke = async (request) => {
    if (request.prompt.startsWith("# Bootstrap plan review") && ++calls === 1) {
      entered();
      await held;
    }
    return invoke(request);
  };
  h.scripted.script({ match: /Bootstrap plan review/, text: reviewerPass(bootstrapCoverageKeys(h, runId)), once: false });
  const first = submit();
  await hasEntered;
  h.clock.advance(31 * 60 * 1000);
  const second = await submit();
  release();
  const prior = await first;
  expect(second).toMatchObject({ allowed: true, value: { stage: "COMPLETED_REVIEW" } });
  expect(prior).toMatchObject({ allowed: true, value: { stage: "REVIEW_UNAVAILABLE" } });
  return { h, runId, summary };
};

describe("#1189 round-1 repairs, beyond the witnesses", () => {
  it("R1-01: the reclaimed attempt keeps its own id, is never CEO-ready, and the second is a retry of it", async () => {
    const { h, runId, summary } = await overlap();
    const reclaimed = h.cp.audit.forRun(runId).find((row) => row.kind === "CANDIDATE_PIPELINE_ATTEMPT_RECLAIMED")!;
    const result = summary();
    const [first, second] = result.rounds;
    expect(first).toMatchObject({
      outcome: "REVIEW_UNAVAILABLE",
      reasonCode: "BINDING_GENERATION_STALE",
      readyForCeo: false,
      attemptReclaimed: true,
      attemptId: reclaimed.evidence["attemptId"],
      review: null,
    });
    expect(second).toMatchObject({
      entry: "INFRASTRUCTURE_RETRY",
      outcome: "REVIEW_PASSED",
      readyForCeo: true,
      attemptReclaimed: false,
      attemptId: result.latestAttempt!.attemptId,
    });
    expect(first!.attemptId).not.toBe(second!.attemptId);
    expect(result.unattributedEvents).toEqual([]);
    expect(result.rounds.every((round) => !(round.readyForCeo && round.outcome === "REVIEW_UNAVAILABLE"))).toBe(true);
  });

  it("R1-01: a record two open attempts could have written is listed as ambiguous and placed on neither", async () => {
    const { h, runId } = await overlap();
    const sources = readReviewRoundSources(h.cp, runId);
    // Without attempt 2's completion and its move to CEO review, nothing tells which attempt was unavailable.
    const withheld = new Set(["BLIND_REVIEW_COMPLETED", "RUN_TRANSITION"]);
    const result = summarizeReviewRounds({ ...sources, audit: sources.audit.filter((row) => !withheld.has(row.kind)) });
    const unavailable = sources.audit.find((row) => row.kind === "BLIND_REVIEW_UNAVAILABLE")!;
    expect(result.unattributedEvents).toEqual([{ eventId: unavailable.eventId, kind: "BLIND_REVIEW_UNAVAILABLE", candidateRounds: [1, 2] }]);
    expect(result.rounds.map((round) => [round.outcome, round.readyForCeo])).toEqual([
      ["NO_OUTCOME_RECORDED", false],
      ["NO_OUTCOME_RECORDED", false],
    ]);
    expect(result.totals.unattributedEvents).toBe(1);
  });

  it("R1-01: replayed first-attempt rows are counted once on the first round, across the window boundary", async () => {
    const {h,runId,submit,summary} = await setup();
    h.scripted.script({ match: /Bootstrap plan review/, text: reviewerRevise(bootstrapCoverageKeys(h, runId), "first defect") });
    expect(await submit()).toMatchObject({ allowed: true, value: { stage: "REVISION_REQUIRED" } });
    const old = h.cp.audit.forRun(runId).filter((r) => ["BLIND_REVIEW_COMPLETED", "REVISION_RETURNED_TO_CTO"].includes(r.kind));
    h.scripted.script({ match: /Bootstrap plan review/, text: reviewerRevise(bootstrapCoverageKeys(h, runId), "second defect") });
    expect(await submit()).toMatchObject({ allowed: true, value: { stage: "REVISION_REQUIRED" } });
    const before = summary();
    for (const r of old) expect(h.cp.audit.record({ ...r, reasonCode: r.reasonCode as never }).allowed).toBe(true);
    const after = summary();
    expect(after.rounds.map((round) => round.duplicateEventsIgnored)).toEqual([2, 0]);
    expect(after.rounds.map((round) => round.review?.findings.map((finding) => finding.summary))).toEqual([["first defect"], ["second defect"]]);
    expect(after.totals).toMatchObject({ reviews: 2, revisionReturns: 2, duplicateEventsIgnored: 2, unattributedEvents: 0 });
    expect(after.rounds.map((round) => ({ ...round, duplicateEventsIgnored: 0 }))).toEqual(before.rounds);
  });

  it("R1-03: an empty commit is a new candidate with the same content, still linked as the next candidate", async () => {
    const h = makeHarness();
    const { projectId, repositoryId } = await registerFixtureProject(h);
    bindCeo(h);
    const created = h.cp.runs.create({
      projectId,
      executionMode: ExecutionMode.STANDARD,
      contract: { goal: "app returns 2", why: "fixture", scope: ["src/app.js"], nonGoals: [], acceptance: ["app returns 2"], priority: "NORMAL", humanGate: [], references: [] },
      repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
    });
    if (!created.allowed) throw new Error(created.message);
    const runId = created.value.runId;
    expect((await h.cp.runs.dispatch(runId)).allowed).toBe(true);
    applyPassingChange(h.repoPath);
    expect((await h.cp.pipeline.freeze(runId)).allowed).toBe(true);
    gitSync(h.repoPath, ["commit", "--allow-empty", "-m", "no source changes"]);
    expect((await h.cp.pipeline.freeze(runId)).allowed).toBe(true);
    const summary = summarizeReviewRounds(readReviewRoundSources(h.cp, runId));
    const [first, second] = summary.rounds;
    expect(second!.candidateSnapshotDigest).not.toBe(first!.candidateSnapshotDigest);
    expect(second!.contentDigest).toBe(first!.contentDigest);
    expect(second!.entry).toBe("CANDIDATE_IDENTITY_CHANGE");
    expect(first!.nextNewCandidate).toEqual({ round: 2, candidateSnapshotDigest: second!.candidateSnapshotDigest });
    expect(summary.totals).toMatchObject({ sourceChanges: 0, candidateIdentityChanges: 1 });
  });
});
