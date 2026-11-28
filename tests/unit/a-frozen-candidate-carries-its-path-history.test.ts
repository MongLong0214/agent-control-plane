import { afterAll, describe, expect, it } from "vitest";

import type { ProductionReadyPacket } from "../../src/ceo/production-gate.ts";
import { digestOf } from "../../src/core/digest.ts";
import { ExecutionMode, RunState } from "../../src/domain/types.ts";
import type { TaskContract } from "../../src/run/run-engine.ts";
import {
  CANDIDATE_SNAPSHOT_SCHEMA_ID,
  type CandidateSnapshot,
  candidateSnapshotDigest,
  candidateSnapshotSchema,
} from "../../src/snapshot/candidate-snapshot.ts";
import { PATH_HISTORY_MAX_ENTRIES, PATH_HISTORY_RUN_WINDOW, pathHistory } from "../../src/verify/path-history.ts";
import { cleanupTempDirs, commitAll, gitSync, writeFiles } from "../helpers/fixtures.ts";
import { type Harness, applyPassingChange, bindCeo, bindWorker, makeHarness, registerFixtureProject } from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * #1457 — what earlier runs of the project did on the paths a candidate touches is read at the freeze, bound into
 * the snapshot's digest and copied into the production-ready packet. The blind reviewer never sees it.
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

type Project = Awaited<ReturnType<typeof registerFixtureProject>>;

const review = (verdict: "PASS" | "REVISE", identity: string, severity?: "MAJOR" | "BLOCKER"): string => JSON.stringify({
  verdict,
  coveredFiles: [`${identity}:src/app.js`],
  omittedItems: [],
  findings: severity === undefined ? [] : [{
    category: "correctness", severity, repository: identity, path: "src/app.js", summary: "app() is wrong", detail: "app() is wrong",
  }],
});

const createRun = (h: Harness, project: Project): string => {
  const created = h.cp.runs.create({
    projectId: project.projectId,
    executionMode: ExecutionMode.STANDARD,
    contract: CONTRACT,
    repositories: [{ repositoryId: project.repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
  });
  if (!created.allowed) throw new Error(created.message);
  h.clock.advance(1000);
  return created.value.runId;
};

/** A dispatched run whose one task changed src/app.js on a branch cut from dev. */
const runWithChange = async (h: Harness, project: Project, branch: string) => {
  gitSync(h.repoPath, ["checkout", "-q", "dev"]);
  const dispatched = await h.cp.runs.dispatch(createRun(h, project));
  if (!dispatched.allowed) throw new Error(`${dispatched.reasonCode}: ${dispatched.message}`);
  const run = dispatched.value;
  const tasks = h.cp.tasks.submit(run.runId, [{ key: "impl", title: "change app()", category: "implementation" }]);
  if (!tasks.allowed) throw new Error(tasks.message);
  const impl = h.cp.tasks.ready(run.runId)[0]!;
  const execution = h.cp.tasks.startExecution({
    runId: run.runId, taskId: impl.taskId, ownerBindingGeneration: run.ownerBindingGeneration!,
    workerSessionId: bindWorker(h, impl.taskId), provider: "scripted", model: "scripted-worker", repositoryId: project.repositoryId,
  });
  if (!execution.allowed) throw new Error(execution.message);
  h.cp.tasks.finishExecution(execution.value.executionId, { status: "SUCCEEDED", resultDigest: `sha256:${applyPassingChange(h.repoPath, branch)}` });
  const submit = async (answer: string) => {
    h.scripted.script({ match: /Candidate review/, text: answer });
    const outcome = await h.cp.pipeline.submitResult({
      runId: run.runId, ownerSessionId: run.ownerSessionId!, ownerBindingGeneration: run.ownerBindingGeneration!,
      resultSummary: "app() now returns 2", recommendation: "merge",
    });
    if (!outcome.allowed) throw new Error(`${outcome.reasonCode}: ${outcome.message}`);
    return outcome.value;
  };
  return { runId: run.runId, submit };
};

const frozen = (h: Harness, runId: string, digest: string): CandidateSnapshot =>
  h.cp.artifacts.latestForSnapshot<CandidateSnapshot>(runId, "CANDIDATE_SNAPSHOT", digest)!.content;

const cancel = (h: Harness, runId: string): void => {
  const cancelled = h.cp.runs.cancel(runId, "superseded by a later run");
  if (!cancelled.allowed) throw new Error(cancelled.message);
};

/** The recorded facts of a run that failed after merge: its latest candidate and its RUN_TRANSITION to BLOCKED_POST_MERGE. */
const blockedPostMerge = (h: Harness, project: Project, runId: string, touchedPaths: string[]): void => {
  const snapshot = candidateSnapshotSchema.parse({
    schema: CANDIDATE_SNAPSHOT_SCHEMA_ID,
    runId,
    contractDigest: "sha256:contract",
    repositories: [{
      identity: project.identity, repositoryRole: "primary", baseBranch: "dev", baseHead: "a".repeat(40), sourceBranch: null, sourceHead: null,
      candidateHead: "b".repeat(40), treeDigest: "git-tree:fixture", diffDigest: "sha256:fixture", worktreeId: null, manifestDigest: null, touchedPaths,
    }],
    createdAt: h.clock.nowIso(),
  });
  h.cp.artifacts.put(runId, "CANDIDATE_SNAPSHOT", snapshot, candidateSnapshotDigest(snapshot));
  h.cp.audit.record({
    kind: "RUN_TRANSITION",
    runId,
    projectId: project.projectId,
    evidence: { from: RunState.POST_MERGE_VERIFYING, to: RunState.BLOCKED_POST_MERGE, reason: "post-merge check failed" },
  });
};

describe("#1457: a frozen candidate carries the history of the paths it touches", () => {
  it("two earlier blind-review returns with a BLOCKER on a path are bound into a later candidate's digest and copied into its packet, never shown to the reviewer", async () => {
    const h = makeHarness();
    const project = await registerFixtureProject(h);
    bindCeo(h);
    const onApp = { repository: project.identity, path: "src/app.js" };

    const first = await runWithChange(h, project, "feature/r1");
    const firstOutcome = await first.submit(review("REVISE", project.identity, "BLOCKER"));
    expect(firstOutcome.stage).toBe("REVISION_REQUIRED");
    // No earlier run: the key is left out, and the digest is the one the snapshot had before the key existed.
    const firstSnapshot = frozen(h, first.runId, firstOutcome.snapshotDigest);
    expect(firstSnapshot).not.toHaveProperty("pathHistory");
    expect(firstOutcome.snapshotDigest).toBe(digestOf({
      schema: firstSnapshot.schema, runId: firstSnapshot.runId, contractDigest: firstSnapshot.contractDigest, repositories: firstSnapshot.repositories,
    }));
    cancel(h, first.runId);

    const second = await runWithChange(h, project, "feature/r2");
    const secondOutcome = await second.submit(review("REVISE", project.identity, "BLOCKER"));
    expect(secondOutcome.stage).toBe("REVISION_REQUIRED");
    expect(frozen(h, second.runId, secondOutcome.snapshotDigest).pathHistory?.entries).toEqual([{ ...onApp, returnedRuns: 1, postMergeBlockedRuns: 0 }]);
    cancel(h, second.runId);

    // The run's own return is not its history: after it, the revised candidate still counts the two earlier runs.
    const third = await runWithChange(h, project, "feature/r3");
    expect((await third.submit(review("REVISE", project.identity, "MAJOR"))).stage).toBe("REVISION_REQUIRED");
    writeFiles(h.repoPath, { "src/app.js": "module.exports = () => 2; // addressed review\n" });
    commitAll(h.repoPath, "address the review finding");
    const passed = await third.submit(review("PASS", project.identity));
    if (passed.stage !== "COMPLETED_REVIEW") throw new Error(`unexpected stage ${passed.stage}`);

    const snapshot = frozen(h, third.runId, passed.snapshotDigest);
    expect(snapshot.pathHistory).toEqual({ entries: [{ ...onApp, returnedRuns: 2, postMergeBlockedRuns: 0 }], omitted: 0, postMergeAttribution: "RUN" });
    // Bound into the digest the verification, the review and the gate share (CP-HI-06).
    const { pathHistory: bound, ...withoutHistory } = snapshot;
    expect(bound).toBeDefined();
    expect(candidateSnapshotDigest(snapshot)).toBe(passed.snapshotDigest);
    expect(candidateSnapshotDigest(withoutHistory)).not.toBe(passed.snapshotDigest);
    // Copied from the frozen snapshot into the packet, as stored.
    expect(passed.packet.pathHistory).toEqual(snapshot.pathHistory);
    const packet = h.cp.artifacts.latestForSnapshot<ProductionReadyPacket>(third.runId, "PRODUCTION_READY_PACKET", passed.snapshotDigest)!;
    expect(packet.content.pathHistory).toEqual(snapshot.pathHistory);

    // ADR-0006 — nothing of it reaches the blind reviewer.
    const prompts = h.scripted.invocations.filter((call) => /Candidate review/.test(call.prompt)).map((call) => call.prompt);
    expect(prompts).toHaveLength(4);
    for (const prompt of prompts) {
      expect(prompt).not.toContain("pathHistory");
      expect(prompt).not.toContain("returnedRuns");
      expect(prompt).not.toContain("postMergeBlockedRuns");
    }
  }, 120_000);

  it("an earlier run that went BLOCKED_POST_MERGE counts once for each path its latest candidate touched", async () => {
    const h = makeHarness();
    const project = await registerFixtureProject(h);
    bindCeo(h);
    const blocked = createRun(h, project);
    blockedPostMerge(h, project, blocked, ["src/app.js", "src/other.js"]);

    const later = await runWithChange(h, project, "feature/after-blocked");
    const snapshot = await h.cp.pipeline.freeze(later.runId);
    if (!snapshot.allowed) throw new Error(`${snapshot.reasonCode}: ${snapshot.message}`);
    expect(snapshot.value.pathHistory).toEqual({
      entries: [{ repository: project.identity, path: "src/app.js", returnedRuns: 0, postMergeBlockedRuns: 1 }],
      omitted: 0,
      postMergeAttribution: "RUN",
    });
    // A path of another repository, or one the blocked run did not touch, has no history.
    expect(pathHistory(h.cp.db, {
      projectId: project.projectId,
      excludeRunId: later.runId,
      touched: [{ repository: "github:acme/elsewhere", path: "src/app.js" }, { repository: project.identity, path: "src/untouched.js" }],
    })).toBeNull();
  }, 60_000);

  it("only the last 50 runs other than the excluded one are read", async () => {
    const h = makeHarness();
    const project = await registerFixtureProject(h);
    const blocked = createRun(h, project);
    blockedPostMerge(h, project, blocked, ["src/app.js"]);
    for (let index = 0; index < PATH_HISTORY_RUN_WINDOW - 1; index += 1) createRun(h, project);
    const current = createRun(h, project);
    const read = () => pathHistory(h.cp.db, { projectId: project.projectId, excludeRunId: current, touched: [{ repository: project.identity, path: "src/app.js" }] });

    // The blocked run is the 50th run other than the current one: inside the window.
    expect(read()?.entries).toEqual([{ repository: project.identity, path: "src/app.js", returnedRuns: 0, postMergeBlockedRuns: 1 }]);
    // One more run pushes it out.
    createRun(h, project);
    expect(read()).toBeNull();
  }, 60_000);

  it("the most-counted paths come first, capped at 20 with the rest counted as omitted", async () => {
    const h = makeHarness();
    const project = await registerFixtureProject(h);
    const paths = Array.from({ length: PATH_HISTORY_MAX_ENTRIES + 5 }, (_, index) => `src/p${String(index).padStart(2, "0")}.js`);
    blockedPostMerge(h, project, createRun(h, project), paths);
    blockedPostMerge(h, project, createRun(h, project), [paths.at(-1)!]);
    const current = createRun(h, project);

    const history = pathHistory(h.cp.db, {
      projectId: project.projectId,
      excludeRunId: current,
      touched: paths.map((path) => ({ repository: project.identity, path })),
    });
    expect(history?.entries).toHaveLength(PATH_HISTORY_MAX_ENTRIES);
    expect(history?.omitted).toBe(5);
    expect(history?.entries[0]).toEqual({ repository: project.identity, path: paths.at(-1), returnedRuns: 0, postMergeBlockedRuns: 2 });
    expect(history?.entries.slice(1).map((entry) => entry.path)).toEqual(paths.slice(0, PATH_HISTORY_MAX_ENTRIES - 1));
  }, 60_000);
});
