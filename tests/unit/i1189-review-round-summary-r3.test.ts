import { afterAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { sha256 } from "../../src/core/digest.ts";
import { ExecutionMode } from "../../src/domain/types.ts";
import { readReviewRoundSources, summarizeReviewRounds } from "../../src/review/review-round-summary.ts";
import { cleanupTempDirs, commitAll, writeFiles } from "../helpers/fixtures.ts";
import { applyPassingChange, bindCeo, bindWorker, fixtureManifest, makeHarness, registerFixtureProject } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * #1189 round-3 review witness (R1-01, delivery attribution), ported from the reviewer's probe: the
 * probe's diagnostic `console.log` is the assertion message here, nothing else changed. Plus one test
 * per placement the repair changes. Scripted pipeline results, not live evidence.
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
  return { h, runId, first, sources, returns };
};

describe("#1189 round-3 review witness", () => {
  it("R3-W: identical verification failures must not move the retry delivery onto round 1", async () => {
    const { first, sources } = await twoIdenticalReturns();
    const after = summarizeReviewRounds(sources);
    const diagnostic = JSON.stringify({ first: first.rounds.map(r => ({ attemptId: r.attemptId, deliveries: r.deliveries })), after: after.rounds.map(r => ({ attemptId: r.attemptId, outcome: r.outcome, deliveries: r.deliveries })), unattributedEvents: after.unattributedEvents, unattributedDeliveries: after.unattributedDeliveries, latestAttempt: after.latestAttempt });
    expect(after.rounds[0]!.deliveries, diagnostic).toEqual(first.rounds[0]!.deliveries);
    expect(after.rounds[0]!.deliveries.some(delivery => delivery.attemptId === after.latestAttempt!.attemptId), diagnostic).toBe(false);
    expect(after.rounds[1]!.deliveries.length + after.unattributedDeliveries.length, diagnostic).toBe(1);
  });
});

describe("#1189 round-3 repair: a delivery's own attempt decides where it goes", () => {
  it("R3-A (return placement): two identical returns with distinct attempts each land on their own round, with their delivery", async () => {
    const { first, sources } = await twoIdenticalReturns();
    const after = summarizeReviewRounds(sources);
    const firstAttempt = first.rounds[0]!.attemptId;
    const secondAttempt = after.latestAttempt!.attemptId;
    expect(firstAttempt).not.toBeNull();
    expect(firstAttempt).not.toBe(secondAttempt);
    expect(after.rounds.map((round) => [round.entry, round.outcome, round.reasonCode, round.attemptId])).toEqual([
      ["FIRST_SUBMISSION", "VERIFICATION_RETURNED", "CANDIDATE_CANNOT_WEAKEN_CONTRACT", firstAttempt],
      ["SAME_CANDIDATE_RESUBMISSION", "VERIFICATION_RETURNED", "CANDIDATE_CANNOT_WEAKEN_CONTRACT", secondAttempt],
    ]);
    expect(after.rounds.map((round) => round.deliveries.map((delivery) => delivery.attemptId))).toEqual([[firstAttempt], [secondAttempt]]);
    expect(after.unattributedEvents).toEqual([]);
    expect(after.unattributedDeliveries).toEqual([]);
    expect(after.totals).toMatchObject({ verificationReturns: 2, duplicateEventsIgnored: 0 });
  });

  it("R3-B (attempt identity): a round's established attempt is never nulled by a later record", async () => {
    const { first, sources } = await twoIdenticalReturns();
    const after = summarizeReviewRounds(sources);
    expect(first.rounds[0]!.attemptId).not.toBeNull();
    expect(after.rounds[0]!.attemptId).toBe(first.rounds[0]!.attemptId);
  });

  it("R3-C (delivery placement): a delivery whose attempt is another round's is listed, never placed on the only round that matches it", async () => {
    const { sources, returns } = await twoIdenticalReturns();
    // Without the retry's own return row, round 1's return is the only one this delivery's content matches.
    const withoutRetryReturn = { ...sources, audit: sources.audit.filter((row) => row.eventId !== returns[1]!.eventId) };
    const result = summarizeReviewRounds(withoutRetryReturn);
    const secondAttempt = result.latestAttempt!.attemptId;
    const retryDelivery = sources.outbox.find((message) => message.idempotencyKey.endsWith(`:${secondAttempt}`))!;
    expect(retryDelivery).toBeDefined();
    expect(result.rounds[0]!.deliveries.map((delivery) => delivery.messageId)).not.toContain(retryDelivery.messageId);
    expect(result.rounds[0]!.deliveries).toHaveLength(1);
    expect(result.rounds[1]!.attemptId).toBe(secondAttempt);
    expect(result.rounds[1]!.deliveries).toEqual([]);
    expect(result.unattributedDeliveries).toEqual([{ messageId: retryDelivery.messageId, candidateRounds: [1, 2] }]);
  });
});
