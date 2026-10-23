import { afterAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { sha256 } from "../../src/core/digest.ts";
import type { AuditRow } from "../../src/db/audit.ts";
import { ExecutionMode } from "../../src/domain/types.ts";
import { type ReviewRoundSources, readReviewRoundSources, summarizeReviewRounds } from "../../src/review/review-round-summary.ts";
import type { TaskContract } from "../../src/run/run-engine.ts";
import { cleanupTempDirs, commitAll, writeFiles } from "../helpers/fixtures.ts";
import { applyPassingChange, bindCeo, bindWorker, fixtureManifest, makeHarness, registerFixtureProject, reviewerRevise } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * #1189 focused-review-2 witnesses (R4-01: a refused stamp re-trusted through a fallback), ported
 * from the reviewer's probes with their `console.log` turned into assertion messages, plus one test
 * per attribution path the repair changes. Scripted pipeline results.
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
  const firstSources = readReviewRoundSources(h.cp, runId);
  const first = summarizeReviewRounds(firstSources);
  h.clock.advance(60_000);
  expect(await submit()).toMatchObject({ allowed: true, value: { stage: "VERIFICATION_FAILED", reasonCode: "CANDIDATE_CANNOT_WEAKEN_CONTRACT" } });
  const sources = readReviewRoundSources(h.cp, runId);
  const returns = sources.audit.filter(row => row.kind === "REVISION_RETURNED_TO_CTO");
  expect(returns).toHaveLength(2);
  expect(returns[1]!.evidence).toEqual(returns[0]!.evidence);
  return { h, runId, first, firstSources, sources, returns, submit };
};

describe("#1189 focused-review-2 witnesses", () => {
  it("P01: delivery fallback must not restore a stamp contradicted by the actual lease candidate", async () => {
    const { firstSources } = await twoIdenticalReturns();
    const altered = { ...firstSources, latestAttempt: { ...firstSources.latestAttempt!, candidateDigest: `sha256:${"0".repeat(64)}` } };
    const result = summarizeReviewRounds(altered);
    const diagnostic = "P01 " + JSON.stringify({lease: altered.latestAttempt, round: result.rounds[0], unattributedDeliveries: result.unattributedDeliveries});
    expect(result.rounds[0]!.attemptId, diagnostic).toBeNull();
    expect(result.rounds[0]!.deliveries, diagnostic).toEqual([]);
  });

  it("P02: delivery fallback must not trust a stamp contradicted by its delivery key candidate", async () => {
    const { firstSources } = await twoIdenticalReturns();
    const digest = firstSources.currentCandidateDigest!;
    const outbox = firstSources.outbox.map(message => message.kind === "REVISION_REQUEST"
      ? { ...message, idempotencyKey: message.idempotencyKey.replace(digest, `sha256:${"2".repeat(64)}`) }
      : message);
    const result = summarizeReviewRounds({ ...firstSources, outbox });
    const diagnostic = "P02 " + JSON.stringify({key: outbox.find(message=>message.kind === "REVISION_REQUEST")!.idempotencyKey, round:result.rounds[0], unattributedDeliveries: result.unattributedDeliveries});
    expect(result.rounds[0]!.attemptId, diagnostic).toBeNull();
    expect(result.rounds[0]!.deliveries, diagnostic).toEqual([]);
  });
});

/** History written before the pipeline stamped its attempt: the same rows, without `attemptId`. */
const unstamped = (sources: ReviewRoundSources): ReviewRoundSources => ({
  ...sources,
  audit: sources.audit.map((row): AuditRow => {
    if (row.kind === "CANDIDATE_PIPELINE_ATTEMPT_RECLAIMED") return row;
    const { attemptId: _stamp, ...evidence } = row.evidence;
    return { ...row, evidence };
  }),
});

describe("#1189 a refused stamp stays refused on every path", () => {
  it("single-candidate path: a round whose freeze stamp is refused takes no return, and its delivery is listed", async () => {
    const { firstSources } = await twoIdenticalReturns();
    const result = summarizeReviewRounds({ ...firstSources, latestAttempt: { ...firstSources.latestAttempt!, candidateDigest: `sha256:${"0".repeat(64)}` } });
    const returned = firstSources.audit.find((row) => row.kind === "REVISION_RETURNED_TO_CTO")!;
    const delivery = firstSources.outbox.find((message) => message.kind === "REVISION_REQUEST")!;
    expect(result.rounds[0]).toMatchObject({ attemptId: null, outcome: "NO_OUTCOME_RECORDED", deliveries: [] });
    expect(result.unattributedEvents).toEqual([{ eventId: returned.eventId, kind: "REVISION_RETURNED_TO_CTO", candidateRounds: [1] }]);
    expect(result.unattributedDeliveries).toEqual([{ messageId: delivery.messageId, candidateRounds: [] }]);
  });

  it("delivery path: without stamps, a delivery whose key names another run is not attached and names no attempt", async () => {
    const { firstSources } = await twoIdenticalReturns();
    const history = unstamped(firstSources);
    const outbox = history.outbox.map((message) =>
      message.kind === "REVISION_REQUEST"
        ? { ...message, idempotencyKey: message.idempotencyKey.replace(`revision:${history.runId}:`, "revision:run_another:") }
        : message,
    );
    const result = summarizeReviewRounds({ ...history, outbox });
    // The return is still the one round's that froze the candidate; the delivery is not.
    expect(result.rounds[0]).toMatchObject({ outcome: "VERIFICATION_RETURNED", attemptId: null, deliveries: [] });
    expect(result.unattributedDeliveries).toHaveLength(1);
    // The same history with its key intact attaches the delivery and names its attempt.
    const intact = summarizeReviewRounds(history);
    expect(intact.rounds[0]!.deliveries).toHaveLength(1);
    expect(intact.rounds[0]!.attemptId).toBe(firstSources.latestAttempt!.attemptId);
  });

  it("delivery path: without stamps, a delivery whose key names another candidate is not attached and names no attempt", async () => {
    const { firstSources } = await twoIdenticalReturns();
    const history = unstamped(firstSources);
    const digest = history.currentCandidateDigest!;
    const outbox = history.outbox.map((message) =>
      message.kind === "REVISION_REQUEST" ? { ...message, idempotencyKey: message.idempotencyKey.replace(digest, `sha256:${"3".repeat(64)}`) } : message,
    );
    const result = summarizeReviewRounds({ ...history, outbox });
    expect(result.rounds[0]).toMatchObject({ outcome: "VERIFICATION_RETURNED", attemptId: null, deliveries: [] });
    expect(result.unattributedDeliveries).toHaveLength(1);
  });

  it("outcome path: a review and its return on a round whose freeze stamp is refused are listed, and no findings are its", async () => {
    const h = makeHarness();
    const { projectId, repositoryId, identity } = await registerFixtureProject(h);
    bindCeo(h);
    const contract: TaskContract = { goal: "make app() return 2", why: "fixture", scope: ["src/app.js"], nonGoals: [], acceptance: ["verify.js exits 0"], priority: "NORMAL", humanGate: [], references: [] };
    const created = h.cp.runs.create({ projectId, executionMode: ExecutionMode.STANDARD, contract, repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }] });
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
    h.cp.tasks.finishExecution(execution.value.executionId, { status: "SUCCEEDED", resultDigest: `sha256:${head}` });
    h.scripted.script({ match: /Candidate review/, text: reviewerRevise([`${identity}:src/app.js`], "a finding") });
    expect(await h.cp.pipeline.submitResult({ runId, ownerSessionId: run.ownerSessionId!, ownerBindingGeneration: run.ownerBindingGeneration!, resultSummary: "outputs", recommendation: "merge" }))
      .toMatchObject({ allowed: true, value: { stage: "REVISION_REQUIRED" } });
    const sources = readReviewRoundSources(h.cp, runId);
    expect(summarizeReviewRounds(sources).rounds[0]!.review?.findings.map((finding) => finding.summary)).toEqual(["a finding"]);

    const result = summarizeReviewRounds({ ...sources, latestAttempt: { ...sources.latestAttempt!, candidateDigest: `sha256:${"4".repeat(64)}` } });
    expect(result.rounds[0]).toMatchObject({ attemptId: null, outcome: "NO_OUTCOME_RECORDED", review: null, deliveries: [] });
    expect(result.firstFindings).toBeNull();
    expect(result.unattributedEvents.map((event) => [event.kind, event.candidateRounds])).toEqual([
      ["BLIND_REVIEW_COMPLETED", [1]],
      ["REVISION_RETURNED_TO_CTO", [1]],
    ]);
    expect(result.unattributedDeliveries).toHaveLength(1);
  });
});
