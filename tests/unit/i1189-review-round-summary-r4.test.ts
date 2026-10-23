import { afterAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { sha256 } from "../../src/core/digest.ts";
import type { AuditRow } from "../../src/db/audit.ts";
import { ExecutionMode, RunKind } from "../../src/domain/types.ts";
import { type ReviewRoundSources, readReviewRoundSources, summarizeReviewRounds } from "../../src/review/review-round-summary.ts";
import { bootstrapPlan, cleanTreeManifest, submitBootstrapPlan } from "../helpers/bootstrap-plan.ts";
import { cleanupTempDirs, commitAll, writeFiles } from "../helpers/fixtures.ts";
import { applyFailingChange, applyPassingChange, bindCeo, bindWorker, dispatchBootstrapRun, fixtureManifest, makeHarness, registerFixtureProject } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * #1189 focused-review witness (R1-01: a later attempt must not revise an earlier round), ported
 * from the reviewer's probe with its `console.log` turned into the assertion message. Plus the
 * stamped path, and history without stamps under the monotonic rule. Scripted pipeline results.
 */

/** The reviewer's run: one candidate submitted twice, both failing verification with identical reports. */
const twoIdenticalReturns = async () => {
  const h = makeHarness();
  writeFiles(h.repoPath, { "gate.mjs": "process.exit(0);\n" });
  commitAll(h.repoPath, "initial pinned gate");
  const { projectId, repositoryId } = await registerFixtureProject(h, "fixture-project", {
    verificationCommands: [{ ...fixtureManifest("fixture-project").verificationCommands[0]!, argv: ["node", "gate.mjs"] }],
    gateEntries: [{ path: "gate.mjs", repositoryRole: "primary", digest: sha256(readFileSync(join(h.repoPath, "gate.mjs"))) }],
  });
  bindCeo(h);
  const created = h.cp.runs.create({
    projectId, executionMode: ExecutionMode.STANDARD,
    contract: { goal: "app returns 2", why: "fixture", scope: ["src/app.js"], nonGoals: [], acceptance: ["app returns 2"], priority: "NORMAL", humanGate: [], references: [] },
    repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
  });
  if (!created.allowed) throw new Error(created.message);
  const runId = created.value.runId;
  const dispatched = await h.cp.runs.dispatch(runId);
  if (!dispatched.allowed) throw new Error(dispatched.message);
  const run = dispatched.value;
  h.cp.tasks.submit(runId, [{ key: "impl", title: "change app()", category: "implementation" }]);
  const task = h.cp.tasks.ready(runId)[0]!;
  const execution = h.cp.tasks.startExecution({ runId, taskId: task.taskId, ownerBindingGeneration: run.ownerBindingGeneration!, workerSessionId: bindWorker(h, task.taskId), provider: "scripted", model: "scripted-worker", repositoryId });
  if (!execution.allowed) throw new Error(execution.message);
  const head = applyPassingChange(h.repoPath);
  writeFiles(h.repoPath, { "gate.mjs": "process.exit(1);\n" });
  commitAll(h.repoPath, "candidate changes the pinned verifier");
  h.cp.tasks.finishExecution(execution.value.executionId, { status: "SUCCEEDED", resultDigest: `sha256:${head}` });
  // The production verifier rejects the changed pinned gate before starting any sandbox child.
  // Its fallback report is identical across retries, even though the clock advances.
  const submit = () => h.cp.pipeline.submitResult({ runId, ownerSessionId: run.ownerSessionId!, ownerBindingGeneration: run.ownerBindingGeneration!, resultSummary: "outputs", recommendation: "merge" });
  expect(await submit()).toMatchObject({ allowed: true, value: { stage: "VERIFICATION_FAILED", reasonCode: "CANDIDATE_CANNOT_WEAKEN_CONTRACT" } });
  const first = summarizeReviewRounds(readReviewRoundSources(h.cp, runId));
  h.clock.advance(60_000);
  expect(await submit()).toMatchObject({ allowed: true, value: { stage: "VERIFICATION_FAILED", reasonCode: "CANDIDATE_CANNOT_WEAKEN_CONTRACT" } });
  const sources = readReviewRoundSources(h.cp, runId);
  const returns = sources.audit.filter(row => row.kind === "REVISION_RETURNED_TO_CTO");
  expect(returns).toHaveLength(2);
  expect(returns[1]!.evidence).toEqual(returns[0]!.evidence);
  return { h, runId, first, sources, returns, submit };
};

/** History written before the pipeline stamped its attempt: the same rows, without `attemptId`. */
const unstamped = (sources: ReviewRoundSources): ReviewRoundSources => ({
  ...sources,
  audit: sources.audit.map((row): AuditRow => {
    if (row.kind === "CANDIDATE_PIPELINE_ATTEMPT_RECLAIMED") return row;
    const { attemptId: _stamp, ...evidence } = row.evidence;
    return { ...row, evidence };
  }),
});

describe("#1189 focused-review witness", () => {
  it("F01: a third identical return must retain round 2's established attempt and delivery", async () => {
    const { h, runId, sources, submit } = await twoIdenticalReturns();
    const before = summarizeReviewRounds(sources);
    h.clock.advance(60_000);
    expect(await submit()).toMatchObject({ allowed: true, value: { stage: "VERIFICATION_FAILED" } });
    const after = summarizeReviewRounds(readReviewRoundSources(h.cp, runId));
    const diagnostic = JSON.stringify({before: before.rounds.map(r => ({attemptId:r.attemptId, outcome:r.outcome, deliveries:r.deliveries.map(d=>d.attemptId)})), after:after.rounds.map(r=>({attemptId:r.attemptId,outcome:r.outcome,deliveries:r.deliveries.map(d=>d.attemptId)})),unattributedEvents:after.unattributedEvents,unattributedDeliveries:after.unattributedDeliveries});
    expect(after.rounds[1]!.attemptId, diagnostic).toBe(before.rounds[1]!.attemptId);
    expect(after.rounds[1]!.deliveries, diagnostic).toEqual(before.rounds[1]!.deliveries);
    expect(after.rounds.map(r=>r.outcome), diagnostic).toEqual(["VERIFICATION_RETURNED", "VERIFICATION_RETURNED", "VERIFICATION_RETURNED"]);
  });
});

describe("#1189 attempt stamps: the pipeline names its attempt, and the summary places by it", () => {
  it("stamped: three identical submissions are three rounds, each with its own attempt, return and delivery", async () => {
    const { h, runId, submit } = await twoIdenticalReturns();
    h.clock.advance(60_000);
    expect(await submit()).toMatchObject({ allowed: true, value: { stage: "VERIFICATION_FAILED" } });
    const sources = readReviewRoundSources(h.cp, runId);
    const stamps = sources.audit.filter((row) => row.kind === "CANDIDATE_FROZEN").map((row) => row.evidence["attemptId"]);
    expect(stamps).toHaveLength(3);
    expect(new Set(stamps).size).toBe(3);
    const summary = summarizeReviewRounds(sources);
    expect(summary.rounds.map((round) => [round.attemptId, round.outcome, round.deliveries.map((delivery) => delivery.attemptId)])).toEqual(
      stamps.map((stamp) => [stamp, "VERIFICATION_RETURNED", [stamp]]),
    );
    expect(summary.rounds.map((round) => round.entry)).toEqual(["FIRST_SUBMISSION", "SAME_CANDIDATE_RESUBMISSION", "SAME_CANDIDATE_RESUBMISSION"]);
    expect(summary.unattributedEvents).toEqual([]);
    expect(summary.unattributedDeliveries).toEqual([]);
  });

  it("history without stamps: a repeated submission with identical records stays unattributed, however many rounds follow", async () => {
    const { h, runId, submit } = await twoIdenticalReturns();
    const afterTwo = summarizeReviewRounds(unstamped(readReviewRoundSources(h.cp, runId)));
    h.clock.advance(60_000);
    expect(await submit()).toMatchObject({ allowed: true, value: { stage: "VERIFICATION_FAILED" } });
    const sources = unstamped(readReviewRoundSources(h.cp, runId));
    expect(sources.audit.some((row) => row.evidence["attemptId"] !== undefined)).toBe(false);
    const afterThree = summarizeReviewRounds(sources);
    const returns = sources.audit.filter((row) => row.kind === "REVISION_RETURNED_TO_CTO");
    expect(returns).toHaveLength(3);

    // Three identical returns of one candidate frozen three times: no record says whose each is.
    for (const summary of [afterTwo, afterThree]) {
      expect(summary.rounds.every((round) => round.outcome === "NO_OUTCOME_RECORDED" && round.attemptId === null && round.deliveries.length === 0)).toBe(true);
    }
    expect(afterThree.unattributedEvents).toEqual(returns.map((row) => ({ eventId: row.eventId, kind: "REVISION_RETURNED_TO_CTO", candidateRounds: [1, 2, 3] })));
    expect(afterThree.unattributedDeliveries).toHaveLength(3);
  });

  it("history without stamps: a record whose correspondence is unique is attributed", async () => {
    const h = makeHarness();
    const { projectId, repositoryId } = await registerFixtureProject(h);
    bindCeo(h);
    const created = h.cp.runs.create({
      projectId, executionMode: ExecutionMode.STANDARD,
      contract: { goal: "make app() return 2", why: "fixture", scope: ["src/app.js"], nonGoals: [], acceptance: ["verify.js exits 0"], priority: "NORMAL", humanGate: [], references: [] },
      repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
    });
    if (!created.allowed) throw new Error(created.message);
    const runId = created.value.runId;
    const dispatched = await h.cp.runs.dispatch(runId);
    if (!dispatched.allowed) throw new Error(dispatched.message);
    const run = dispatched.value;
    h.cp.tasks.submit(runId, [{ key: "impl", title: "change app()", category: "implementation" }]);
    const task = h.cp.tasks.ready(runId)[0]!;
    const execution = h.cp.tasks.startExecution({ runId, taskId: task.taskId, ownerBindingGeneration: run.ownerBindingGeneration!, workerSessionId: bindWorker(h, task.taskId), provider: "scripted", model: "scripted-worker", repositoryId });
    if (!execution.allowed) throw new Error(execution.message);
    const head = applyFailingChange(h.repoPath);
    h.cp.tasks.finishExecution(execution.value.executionId, { status: "SUCCEEDED", resultDigest: `sha256:${head}` });
    const submit = () => h.cp.pipeline.submitResult({ runId, ownerSessionId: run.ownerSessionId!, ownerBindingGeneration: run.ownerBindingGeneration!, resultSummary: "outputs", recommendation: "merge" });
    expect(await submit()).toMatchObject({ allowed: true, value: { stage: "VERIFICATION_FAILED" } });
    h.clock.advance(60_000);
    expect(await submit()).toMatchObject({ allowed: true, value: { stage: "VERIFICATION_FAILED" } });
    const sources = unstamped(readReviewRoundSources(h.cp, runId));
    const returns = sources.audit.filter((row) => row.kind === "REVISION_RETURNED_TO_CTO");
    // The same candidate twice, but each report is its own: each return is the only one of its kind.
    expect(returns[0]!.evidence["reportDigest"]).not.toBe(returns[1]!.evidence["reportDigest"]);
    const summary = summarizeReviewRounds(sources);
    expect(summary.rounds.map((round) => round.outcome)).toEqual(["VERIFICATION_RETURNED", "VERIFICATION_RETURNED"]);
    // Each delivery carries the one return it alone matches, and so names that round's attempt.
    const deliveries = sources.outbox.filter((message) => message.kind === "REVISION_REQUEST");
    expect(summary.rounds.map((round) => round.deliveries.length)).toEqual([1, 1]);
    expect(new Set(summary.rounds.map((round) => round.attemptId))).toEqual(new Set(deliveries.map((message) => message.idempotencyKey.slice(message.idempotencyKey.lastIndexOf(":") + 1))));
    expect(summary.unattributedEvents).toEqual([]);
    expect(summary.unattributedDeliveries).toEqual([]);
  });

  it("history without stamps: a record and its replay for a candidate submitted again are both unattributed", async () => {
    const h = makeHarness();
    bindCeo(h);
    const created = h.cp.runs.create({ kind: RunKind.PROJECT_BOOTSTRAP, executionMode: ExecutionMode.STANDARD,
      contract: { goal: "bootstrap", why: "fixture", scope: [], nonGoals: [], acceptance: ["repository created"], priority: "NORMAL", humanGate: [], references: [] } });
    if (!created.allowed) throw new Error(created.message);
    const runId = created.value.runId;
    await dispatchBootstrapRun(h.cp, h.clock, runId);
    await submitBootstrapPlan(h, runId, bootstrapPlan(cleanTreeManifest("review-1192-r4")));
    const run = h.cp.runs.require(runId);
    const submit = () => h.cp.pipeline.submitResult({ runId, ownerSessionId: run.ownerSessionId!, ownerBindingGeneration: run.ownerBindingGeneration!, resultSummary: "outputs", recommendation: "create" });
    h.scripted.setRuntimeHealth("UNAVAILABLE");
    expect(await submit()).toMatchObject({ allowed: true, value: { stage: "REVIEW_UNAVAILABLE" } });
    const unavailable = h.cp.audit.forRun(runId).find((row) => row.kind === "BLIND_REVIEW_UNAVAILABLE")!;
    h.scripted.setRuntimeHealth("HEALTHY");
    let entered!: () => void;
    const hasEntered = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const invoke = h.scripted.invoke.bind(h.scripted);
    h.scripted.invoke = async (request) => {
      if (request.prompt.startsWith("# Bootstrap plan review")) { entered(); await held; }
      return invoke(request);
    };
    h.scripted.script({ match: /Bootstrap plan review/, text: "not a JSON verdict" });
    const second = submit();
    await hasEntered;
    const replayed = h.cp.audit.record({ ...unavailable, reasonCode: unavailable.reasonCode as never });
    const during = summarizeReviewRounds(unstamped(readReviewRoundSources(h.cp, runId)));
    release();
    await second;
    const after = summarizeReviewRounds(unstamped(readReviewRoundSources(h.cp, runId)));
    // Two identical records of a candidate frozen twice: which is the original, and whose, cannot be told.
    const listed = [unavailable.eventId, replayed.allowed ? replayed.value : -1].map((eventId) => ({ eventId, kind: "BLIND_REVIEW_UNAVAILABLE", candidateRounds: [1, 2] }));
    expect(during.unattributedEvents).toEqual(listed);
    expect(after.unattributedEvents).toEqual(listed);
    // The retry's own failure is the only one of its kind, written where only it could write.
    expect(after.rounds.map((round) => [round.outcome, round.reasonCode])).toEqual([
      ["NO_OUTCOME_RECORDED", null],
      ["REVIEW_UNAVAILABLE", "EVIDENCE_MISSING"],
    ]);
  });

  it("history without stamps: a retry's failure identical to the earlier attempt's leaves both unattributed", async () => {
    const h = makeHarness();
    bindCeo(h);
    const created = h.cp.runs.create({ kind: RunKind.PROJECT_BOOTSTRAP, executionMode: ExecutionMode.STANDARD,
      contract: { goal: "bootstrap", why: "fixture", scope: [], nonGoals: [], acceptance: ["repository created"], priority: "NORMAL", humanGate: [], references: [] } });
    if (!created.allowed) throw new Error(created.message);
    const runId = created.value.runId;
    await dispatchBootstrapRun(h.cp, h.clock, runId);
    await submitBootstrapPlan(h, runId, bootstrapPlan(cleanTreeManifest("review-1192-r4b")));
    const run = h.cp.runs.require(runId);
    const submit = () => h.cp.pipeline.submitResult({ runId, ownerSessionId: run.ownerSessionId!, ownerBindingGeneration: run.ownerBindingGeneration!, resultSummary: "outputs", recommendation: "create" });
    h.scripted.setRuntimeHealth("UNAVAILABLE");
    expect(await submit()).toMatchObject({ allowed: true, value: { stage: "REVIEW_UNAVAILABLE" } });
    expect(await submit()).toMatchObject({ allowed: true, value: { stage: "REVIEW_UNAVAILABLE" } });
    const sources = unstamped(readReviewRoundSources(h.cp, runId));
    const rows = sources.audit.filter((row) => row.kind === "BLIND_REVIEW_UNAVAILABLE");
    const result = summarizeReviewRounds(sources);
    expect(result.rounds.map((round) => [round.entry, round.outcome])).toEqual([
      ["FIRST_SUBMISSION", "NO_OUTCOME_RECORDED"],
      ["INFRASTRUCTURE_RETRY", "NO_OUTCOME_RECORDED"],
    ]);
    expect(result.unattributedEvents).toEqual(rows.map((row) => ({ eventId: row.eventId, kind: "BLIND_REVIEW_UNAVAILABLE", candidateRounds: [1, 2] })));
  });
});

describe("#1189 a stamp is trusted only when the run's own records agree with it", () => {
  /** A bootstrap run whose reviewer runtime is down twice: two stamped unavailable rounds of one candidate. */
  const twoUnavailable = async () => {
    const h = makeHarness();
    bindCeo(h);
    const created = h.cp.runs.create({ kind: RunKind.PROJECT_BOOTSTRAP, executionMode: ExecutionMode.STANDARD,
      contract: { goal: "bootstrap", why: "fixture", scope: [], nonGoals: [], acceptance: ["repository created"], priority: "NORMAL", humanGate: [], references: [] } });
    if (!created.allowed) throw new Error(created.message);
    const runId = created.value.runId;
    await dispatchBootstrapRun(h.cp, h.clock, runId);
    await submitBootstrapPlan(h, runId, bootstrapPlan(cleanTreeManifest("review-1192-stamps")));
    const run = h.cp.runs.require(runId);
    const submit = () => h.cp.pipeline.submitResult({ runId, ownerSessionId: run.ownerSessionId!, ownerBindingGeneration: run.ownerBindingGeneration!, resultSummary: "outputs", recommendation: "create" });
    h.scripted.setRuntimeHealth("UNAVAILABLE");
    expect(await submit()).toMatchObject({ allowed: true, value: { stage: "REVIEW_UNAVAILABLE" } });
    expect(await submit()).toMatchObject({ allowed: true, value: { stage: "REVIEW_UNAVAILABLE" } });
    const sources = readReviewRoundSources(h.cp, runId);
    const freezes = sources.audit.filter((row) => row.kind === "CANDIDATE_FROZEN");
    const unavailable = sources.audit.filter((row) => row.kind === "BLIND_REVIEW_UNAVAILABLE");
    const lastEventId = Math.max(...sources.audit.map((row) => row.eventId));
    const baseline = summarizeReviewRounds(sources);
    expect(baseline.rounds.map((round) => [round.outcome, round.attemptId])).toEqual([
      ["REVIEW_UNAVAILABLE", freezes[0]!.evidence["attemptId"]],
      ["REVIEW_UNAVAILABLE", freezes[1]!.evidence["attemptId"]],
    ]);
    return { sources, freezes, unavailable, lastEventId, baseline };
  };
  const withRow = (sources: ReviewRoundSources, row: AuditRow): ReviewRoundSources => ({
    ...sources,
    audit: [...sources.audit, row].sort((a, b) => a.eventId - b.eventId),
  });

  it("a record stamped with an attempt no freeze of this run names is refused", async () => {
    const { sources, unavailable, lastEventId, baseline } = await twoUnavailable();
    const forged = { ...unavailable[1]!, eventId: lastEventId + 1, evidence: { ...unavailable[1]!.evidence, attemptId: `attempt_${"f".repeat(24)}` } };
    const result = summarizeReviewRounds(withRow(sources, forged));
    expect(result.unattributedEvents).toEqual([{ eventId: forged.eventId, kind: "BLIND_REVIEW_UNAVAILABLE", candidateRounds: [] }]);
    expect(result.rounds).toEqual(baseline.rounds);
  });

  it("a record whose stamp names an attempt of another candidate is refused", async () => {
    const { sources, unavailable, lastEventId, baseline } = await twoUnavailable();
    const forged = { ...unavailable[1]!, eventId: lastEventId + 1, evidence: { ...unavailable[1]!.evidence, candidateSnapshotDigest: `sha256:${"0".repeat(64)}` } };
    const result = summarizeReviewRounds(withRow(sources, forged));
    expect(result.unattributedEvents).toEqual([{ eventId: forged.eventId, kind: "BLIND_REVIEW_UNAVAILABLE", candidateRounds: [] }]);
    expect(result.rounds).toEqual(baseline.rounds);
  });

  it("a record stamped with an attempt that had not frozen yet is refused", async () => {
    const { sources, freezes, unavailable, baseline } = await twoUnavailable();
    // Placed in the trail before attempt 2's freeze, yet naming attempt 2.
    const forged = { ...unavailable[0]!, eventId: freezes[1]!.eventId - 0.5, evidence: { ...unavailable[0]!.evidence, attemptId: freezes[1]!.evidence["attemptId"] } };
    const result = summarizeReviewRounds(withRow(sources, forged));
    expect(result.unattributedEvents).toEqual([{ eventId: forged.eventId, kind: "BLIND_REVIEW_UNAVAILABLE", candidateRounds: [] }]);
    expect(result.rounds).toEqual(baseline.rounds);
  });

  it("a freeze stamp the lease row contradicts is not trusted, and neither is a record stamped with it", async () => {
    const { sources, unavailable, baseline } = await twoUnavailable();
    // The lease row binds attempt 2 to another candidate than the one its freeze names.
    const result = summarizeReviewRounds({ ...sources, latestAttempt: { ...sources.latestAttempt!, candidateDigest: `sha256:${"1".repeat(64)}` } });
    expect(result.rounds[0]).toEqual(baseline.rounds[0]);
    expect(result.rounds[1]).toMatchObject({ attemptId: null, outcome: "NO_OUTCOME_RECORDED" });
    expect(result.unattributedEvents).toEqual([{ eventId: unavailable[1]!.eventId, kind: "BLIND_REVIEW_UNAVAILABLE", candidateRounds: [] }]);
  });

  it("a stamp two freezes carry is trusted for neither", async () => {
    const { sources, freezes, unavailable, lastEventId } = await twoUnavailable();
    const copied = { ...freezes[1]!, eventId: lastEventId + 1 };
    const result = summarizeReviewRounds(withRow(sources, copied));
    expect(result.rounds.map((round) => round.attemptId)).toEqual([freezes[0]!.evidence["attemptId"], null, null]);
    expect(result.rounds[1]!.outcome).toBe("NO_OUTCOME_RECORDED");
    expect(result.unattributedEvents).toEqual([{ eventId: unavailable[1]!.eventId, kind: "BLIND_REVIEW_UNAVAILABLE", candidateRounds: [] }]);
  });

  it("a freeze stamp a delivery contradicts (another candidate in its key) is not trusted", async () => {
    const { h, runId } = await twoIdenticalReturns();
    const sources = readReviewRoundSources(h.cp, runId);
    const second = summarizeReviewRounds(sources).rounds[1]!;
    const stamp = second.attemptId!;
    const outbox = sources.outbox.map((message) =>
      message.idempotencyKey.endsWith(`:${stamp}`)
        ? { ...message, idempotencyKey: message.idempotencyKey.replace(second.candidateSnapshotDigest!, `sha256:${"2".repeat(64)}`) }
        : message,
    );
    const result = summarizeReviewRounds({ ...sources, outbox });
    expect(result.rounds[1]).toMatchObject({ attemptId: null, outcome: "NO_OUTCOME_RECORDED", deliveries: [] });
    // With round 2's attempt untrusted, its identical return could be round 2's or a repeat of round 1's: listed.
    const retryReturn = sources.audit.filter((row) => row.kind === "REVISION_RETURNED_TO_CTO")[1]!;
    expect(result.unattributedEvents).toEqual([{ eventId: retryReturn.eventId, kind: "REVISION_RETURNED_TO_CTO", candidateRounds: [1, 2] }]);
  });
});
