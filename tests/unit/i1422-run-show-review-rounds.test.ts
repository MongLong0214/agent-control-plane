import { afterAll, describe, expect, it, vi } from "vitest";

import { dispatch } from "../../src/cli/agentctl.ts";

import { Daemon, OPERATOR_METHOD } from "../../src/daemon/daemon.ts";
import { RunState } from "../../src/domain/types.ts";
import { readReviewRoundSources, summarizeReviewRounds, type ReviewRoundSummary } from "../../src/review/review-round-summary.ts";
import { cleanupTempDirs, commitAll, tempDir, writeFiles } from "../helpers/fixtures.ts";
import { makeHarness, reviewerPass, reviewerRevise, type Harness } from "../helpers/harness.ts";
import { startReviewedRun, stageOf } from "../helpers/review-round-run.ts";

afterAll(cleanupTempDirs);

/**
 * #1422 Task B — `agentctl run show <runId>` carries the review-round projection that #1189 built
 * and nothing called. Every run is driven through the production pipeline with the harness's
 * scripted reviewer (fixture results, not live reviewer evidence); the query goes through the
 * daemon's operator handler, the path `agentctl` uses.
 */

const show = async (harness: Harness, runId: string) => {
  const daemon = new Daemon(harness.cp, { stateDir: tempDir("i1422-show-") });
  try {
    expect(daemon.lock.acquire(harness.clock.nowIso()).allowed).toBe(true);
    return await daemon.handleOperatorRequest(
      { requestId: "show", method: OPERATOR_METHOD.RUN_SHOW, params: { runId } },
      { actor: "operator", channel: "cli", peerId: "test", incarnation: "test" },
    );
  } finally {
    daemon.lock.release();
  }
};

const commitFix = (harness: Harness, note: string): void => {
  writeFiles(harness.repoPath, { "src/app.js": `module.exports = () => 2; // ${note}\n` });
  commitAll(harness.repoPath, note);
};

describe("#1422 B: run show exposes the review-round projection", () => {
  it("shows source change, same-candidate resubmission and infrastructure retry apart, beside the fields it already had", async () => {
    const harness = makeHarness();
    const { runId, submit, covered } = await startReviewedRun(harness);
    harness.scripted.script({ match: /Candidate review/, text: reviewerRevise(covered, "first finding") });
    expect(stageOf(await submit())).toBe("REVISION_REQUIRED");
    harness.scripted.script({ match: /Candidate review/, text: reviewerRevise(covered, "second finding") });
    expect(stageOf(await submit())).toBe("REVISION_REQUIRED");
    harness.scripted.setRuntimeHealth("UNAVAILABLE");
    expect(stageOf(await submit())).toBe("REVIEW_UNAVAILABLE");
    harness.scripted.setRuntimeHealth("HEALTHY");
    harness.scripted.script({ match: /Candidate review/, text: reviewerRevise(covered, "third finding") });
    expect(stageOf(await submit())).toBe("REVISION_REQUIRED");
    commitFix(harness, "address the review");
    harness.scripted.script({ match: /Candidate review/, text: reviewerPass(covered) });
    expect(stageOf(await submit())).toBe("COMPLETED_REVIEW");

    const result = await show(harness, runId);
    expect(result.allowed).toBe(true);
    if (!result.allowed) return;
    const value = result.value as Record<string, unknown> & { reviewRounds: ReviewRoundSummary };
    // What run show returned before is still there.
    expect(Object.keys(value)).toEqual(expect.arrayContaining(["run", "tasks", "executions", "evidence", "claims", "humanGate", "outbox"]));
    const rounds = value.reviewRounds;
    expect(rounds.rounds.map((round) => [round.entry, round.outcome])).toEqual([
      ["FIRST_SUBMISSION", "REVISION_RETURNED"],
      ["SAME_CANDIDATE_RESUBMISSION", "REVISION_RETURNED"],
      ["SAME_CANDIDATE_RESUBMISSION", "REVIEW_UNAVAILABLE"],
      ["INFRASTRUCTURE_RETRY", "REVISION_RETURNED"],
      ["SOURCE_CHANGE", "REVIEW_PASSED"],
    ]);
    expect(rounds.totals).toMatchObject({
      rounds: 5,
      sourceChanges: 1,
      candidateIdentityChanges: 0,
      sameCandidateResubmissions: 2,
      infrastructureRetries: 1,
      reviewUnavailable: 1,
      unattributedEvents: 0,
      unattributedDeliveries: 0,
    });
    // The operator's own command prints it: `agentctl run show <runId>` goes through the same handler.
    const daemon = new Daemon(harness.cp, { stateDir: tempDir("i1422-cli-") });
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      expect(daemon.lock.acquire(harness.clock.nowIso()).allowed).toBe(true);
      const client = {
        request: (method: string, params: Record<string, unknown> = {}) =>
          daemon.handleOperatorRequest({ requestId: "cli", method, params }, { actor: "operator", channel: "cli", peerId: "test", incarnation: "test" }),
      };
      expect(await dispatch(client, "run", ["show", runId], false)).toBe(0);
      const printed = JSON.parse(String(stdout.mock.calls[0]![0]));
      expect(printed.reviewRounds.totals).toMatchObject({ sourceChanges: 1, sameCandidateResubmissions: 2, infrastructureRetries: 1 });
    } finally {
      stdout.mockRestore();
      daemon.lock.release();
    }
    // It is the projection of this run's own records, not a copy of another reading.
    expect(rounds).toEqual(JSON.parse(JSON.stringify(summarizeReviewRounds(readReviewRoundSources(harness.cp, runId)))));
    harness.cp.close();
  });

  it("reads: the query changes no row of the run, its audit trail or its artifacts, and sends no reviewer", async () => {
    const harness = makeHarness();
    const { runId, submit, covered } = await startReviewedRun(harness);
    harness.scripted.script({ match: /Candidate review/, text: reviewerRevise(covered, "a finding") });
    expect(stageOf(await submit())).toBe("REVISION_REQUIRED");
    const tables = ["audit_events", "run_artifacts", "outbox", "candidate_pipeline_attempts", "assignments", "runs"];
    const counts = () => tables.map((table) => harness.cp.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)!.n);
    const changes = () => harness.cp.db.get<{ n: number }>("SELECT total_changes() AS n")!.n;
    const before = { counts: counts(), changes: changes(), reviewerCalls: harness.scripted.invocations.length };
    const result = await show(harness, runId);
    expect(result.allowed).toBe(true);
    expect((result as { value: { reviewRounds: { rounds: unknown[] } } }).value.reviewRounds.rounds).toHaveLength(1);
    expect({ counts: counts(), changes: changes(), reviewerCalls: harness.scripted.invocations.length }).toEqual(before);
    expect(harness.cp.runs.require(runId).state).toBe(RunState.ACTIVE);
    harness.cp.close();
  });

  it("a projection that cannot be read is reported unavailable and the run is still shown", async () => {
    const harness = makeHarness();
    const { runId } = await startReviewedRun(harness);
    const current = harness.cp.runs.currentCandidate.bind(harness.cp.runs);
    harness.cp.runs.currentCandidate = () => {
      throw new Error("candidate unreadable");
    };
    const result = await show(harness, runId);
    harness.cp.runs.currentCandidate = current;
    expect(result).toMatchObject({
      allowed: true,
      value: { run: { runId }, reviewRounds: { unavailable: true, error: "candidate unreadable" } },
    });
    harness.cp.close();
  });

  it("does not turn an unrecorded call count into zero: the total is labelled and what it lacks is listed beside it", async () => {
    const harness = makeHarness();
    const { runId, submit, covered } = await startReviewedRun(harness);
    writeFiles(harness.repoPath, { "src/app.js": `module.exports = () => 2;\n// ${"x".repeat(130_000)}\n` });
    commitAll(harness.repoPath, "large reviewed change");
    harness.scripted.script(
      { match: /Review chunk/, text: reviewerPass(covered), once: false },
      { match: /Final review/, text: reviewerPass([]) },
    );
    expect(stageOf(await submit())).toBe("COMPLETED_REVIEW");
    const sources = readReviewRoundSources(harness.cp, runId);
    const recorded = summarizeReviewRounds(sources).totals;
    expect(recorded.reviewerInvocations).toBeGreaterThan(2);
    expect(recorded).toMatchObject({ reviewsWithUnrecordedInvocations: 0, reviewerInvocationsBasis: "RECORDED_AND_ATTRIBUTED_ONLY" });

    // The same records without the list of chunk reviewers: the number of calls is not recorded.
    const withoutChunkList = {
      ...sources,
      audit: sources.audit.map((row) => {
        const { chunkReviewerSessions: _dropped, ...evidence } = row.evidence as Record<string, unknown>;
        return { ...row, evidence };
      }),
      artifacts: sources.artifacts.map((artifact) =>
        artifact.kind === "BLIND_REVIEW" ? { ...artifact, content: { ...(artifact.content as object), chunkReviewerSessions: undefined } } : artifact,
      ),
    } as typeof sources;
    const unknown = summarizeReviewRounds(withoutChunkList);
    expect(unknown.rounds[0]!.review!.reviewerInvocations).toBeNull();
    expect(unknown.totals.reviewerInvocations).toBe(0);
    expect(unknown.totals).toMatchObject({ reviews: 1, reviewsWithUnrecordedInvocations: 1 });
    harness.cp.close();
  });
});
