import { afterAll, describe, expect, it } from "vitest";

import { ExecutionMode, RunState } from "../../src/domain/types.ts";
import type { TaskContract } from "../../src/run/run-engine.ts";
import type { CandidateSnapshot } from "../../src/snapshot/candidate-snapshot.ts";
import type { VerificationReport } from "../../src/verify/verification-engine.ts";
import { cleanupTempDirs, commitAll, gitSync, writeFiles } from "../helpers/fixtures.ts";
import {
  type Harness,
  bindCeo,
  bindWorker,
  fixtureManifest,
  makeHarness,
  registerFixtureProject,
  reviewerPass,
  startWorkBranch,
} from "../helpers/harness.ts";

afterAll(cleanupTempDirs);

/**
 * #1453 PR A — the lane follows what the frozen candidate does. Through the real pipeline: a run whose
 * goal says nothing destructive is classified from its diff at the freeze, its mode is raised for WIDE and
 * IRREVERSIBLE, and a destructive path change that also changes anything else goes back to its CTO before
 * verification. Reason codes this slice adds are written as literals.
 */

const MIXED = "IRREVERSIBLE_MIXED_CHANGE";

const CONTRACT: TaskContract = {
  goal: "refactor users",
  why: "the users module is hard to read",
  scope: ["src/app.js", "migrations"],
  nonGoals: [],
  acceptance: ["verify.js exits 0"],
  priority: "NORMAL",
  humanGate: [],
  references: [],
};

const base = fixtureManifest("fixture-project");
const verify = base.verificationCommands[0]!;

/** A STANDARD run of a project whose GUARDED profile runs one command more, with its one task's change committed. */
const drive = async (files: Record<string, string>) => {
  const harness = makeHarness();
  const { projectId, repositoryId, identity } = await registerFixtureProject(harness, "fixture-project", {
    verificationProfiles: { simple: ["verify"], standard: ["verify"], guarded: ["verify", "verify-guarded"] },
    verificationCommands: [verify, { ...verify, id: "verify-guarded" }],
    blastRadius: { wide: [], irreversible: [], migrations: [{ repositoryRole: "primary", path: "migrations" }], contractDelayHours: 24, recovery: [] },
  });
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
  if (!dispatched.allowed) throw new Error(`${dispatched.reasonCode}: ${dispatched.message}`);
  const run = dispatched.value;
  const tasks = harness.cp.tasks.submit(runId, [{ key: "impl", title: "change users", category: "implementation" }]);
  if (!tasks.allowed) throw new Error(tasks.message);
  const impl = harness.cp.tasks.ready(runId)[0]!;
  const execution = harness.cp.tasks.startExecution({
    runId,
    taskId: impl.taskId,
    ownerBindingGeneration: run.ownerBindingGeneration!,
    workerSessionId: bindWorker(harness, impl.taskId),
    provider: "scripted",
    model: "scripted-worker",
    repositoryId,
  });
  if (!execution.allowed) throw new Error(execution.message);
  startWorkBranch(harness.repoPath);
  writeFiles(harness.repoPath, files);
  const head = commitAll(harness.repoPath, "change users");
  harness.cp.tasks.finishExecution(execution.value.executionId, { status: "SUCCEEDED", resultDigest: `sha256:${head}` });
  const submit = (coveredFiles: string[]) => {
    harness.scripted.script({ match: /Candidate review/, text: reviewerPass(coveredFiles.map((path) => `${identity}:${path}`)) });
    return harness.cp.pipeline.submitResult({
      runId,
      ownerSessionId: run.ownerSessionId!,
      ownerBindingGeneration: run.ownerBindingGeneration!,
      resultSummary: "users refactored",
      recommendation: "merge",
    });
  };
  return { harness, runId, submit };
};

const frozenCandidate = (h: Harness, runId: string): CandidateSnapshot =>
  h.cp.artifacts.latestForSnapshot<CandidateSnapshot>(runId, "CANDIDATE_SNAPSHOT", h.cp.runs.currentCandidate(runId)!)!.content;
const reportOf = (h: Harness, runId: string): VerificationReport | undefined =>
  h.cp.artifacts.latestForSnapshot<VerificationReport>(runId, "VERIFICATION", h.cp.runs.currentCandidate(runId)!)?.content;
const raises = (h: Harness, runId: string) => h.cp.audit.forRun(runId).filter((row) => row.kind === "EXECUTION_MODE_RAISED");

const PASSING = { "src/app.js": "module.exports = () => 2;\n" };
const DROP_USERS = { "migrations/0002_drop_users.sql": "-- users moved to accounts\nDROP TABLE users;\n" };

describe("#1453 the lane follows the frozen candidate", () => {
  it("a DROP TABLE in a migration beside other code is returned IRREVERSIBLE_MIXED_CHANGE, naming the item, before verification", async () => {
    const { harness, runId, submit } = await drive({ ...PASSING, ...DROP_USERS });
    const outcome = await submit(["src/app.js", "migrations/0002_drop_users.sql"]);

    expect(outcome).toMatchObject({ allowed: true, value: { stage: "REVISION_REQUIRED", reasonCode: MIXED } });
    expect(harness.cp.runs.require(runId).state).toBe(RunState.ACTIVE);
    expect(reportOf(harness, runId)).toBeUndefined();
    const item = { kind: "DROP_TABLE", repositoryRole: "primary", path: "migrations/0002_drop_users.sql", line: 2, name: "users" };
    expect(frozenCandidate(harness, runId).blastRadius).toEqual({ lane: "IRREVERSIBLE", items: [item] });

    const returned = harness.cp.audit.forRun(runId).filter((row) => row.kind === "REVISION_RETURNED_TO_CTO");
    expect(returned).toHaveLength(1);
    expect(returned[0]).toMatchObject({ reasonCode: MIXED, evidence: { stage: "blast-radius", items: 1, outsidePaths: 1 } });
    const delivered = harness.cp.outbox.listByRun(runId).filter((message) => message.kind === "REVISION_REQUEST");
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.payload).toMatchObject({ reasonCode: MIXED, stage: "blast-radius", items: [item], outsidePaths: [{ repositoryRole: "primary", path: "src/app.js" }] });
  });

  it("a WIDE run created STANDARD verifies with the GUARDED profile and records EXECUTION_MODE_RAISED", async () => {
    const { harness, runId, submit } = await drive({ ...PASSING, "migrations/0002_nickname.sql": "ALTER TABLE users ADD COLUMN nickname TEXT;\n" });
    const outcome = await submit(["src/app.js", "migrations/0002_nickname.sql"]);

    expect(outcome.allowed).toBe(true);
    expect(harness.cp.runs.require(runId).executionMode).toBe(ExecutionMode.GUARDED);
    expect(raises(harness, runId).map((row) => row.evidence)).toEqual([
      expect.objectContaining({ from: "STANDARD", to: "GUARDED", lane: "WIDE", candidateSnapshotDigest: harness.cp.runs.currentCandidate(runId) }),
    ]);
    expect(reportOf(harness, runId)).toMatchObject({ expectedInputs: 2, status: "PASS" });
    expect(frozenCandidate(harness, runId).blastRadius).toEqual({
      lane: "WIDE", items: [{ kind: "SCHEMA_CHANGE", repositoryRole: "primary", path: "migrations/0002_nickname.sql" }],
    });
  });

  it("no path lowers the mode: a CONTAINED revision of a raised run still verifies GUARDED", async () => {
    const { harness, runId, submit } = await drive({ ...PASSING, ...DROP_USERS });
    expect(await submit(["src/app.js", "migrations/0002_drop_users.sql"])).toMatchObject({ value: { reasonCode: MIXED } });
    expect(harness.cp.runs.require(runId).executionMode).toBe(ExecutionMode.GUARDED);

    // The CTO takes the destructive part out; what is left is CONTAINED.
    gitSync(harness.repoPath, ["rm", "-q", "migrations/0002_drop_users.sql"]);
    commitAll(harness.repoPath, "leave the drop to its own run");
    const outcome = await submit(["src/app.js"]);

    expect(outcome).toMatchObject({ allowed: true, value: { stage: "COMPLETED_REVIEW" } });
    expect(frozenCandidate(harness, runId).blastRadius).toBeUndefined();
    expect(harness.cp.runs.require(runId).executionMode).toBe(ExecutionMode.GUARDED);
    expect(raises(harness, runId)).toHaveLength(1);
    expect(reportOf(harness, runId)).toMatchObject({ expectedInputs: 2, status: "PASS" });
  });

  it("an isolated DROP is not mixed: it is verified, GUARDED", async () => {
    const { harness, runId, submit } = await drive(DROP_USERS);
    const outcome = await submit(["migrations/0002_drop_users.sql"]);

    // The base's app() still returns 1, so the candidate fails verify.js: it reached verification.
    expect(outcome).toMatchObject({ allowed: true, value: { stage: "VERIFICATION_FAILED" } });
    expect(frozenCandidate(harness, runId).blastRadius?.lane).toBe("IRREVERSIBLE");
    expect(reportOf(harness, runId)).toMatchObject({ expectedInputs: 2 });
  });

  it("a CONTAINED candidate carries no lane and keeps its mode", async () => {
    const { harness, runId, submit } = await drive(PASSING);
    const outcome = await submit(["src/app.js"]);

    expect(outcome).toMatchObject({ allowed: true, value: { stage: "COMPLETED_REVIEW" } });
    expect(Object.prototype.hasOwnProperty.call(frozenCandidate(harness, runId), "blastRadius")).toBe(false);
    expect(harness.cp.runs.require(runId).executionMode).toBe(ExecutionMode.STANDARD);
    expect(raises(harness, runId)).toHaveLength(0);
    expect(reportOf(harness, runId)).toMatchObject({ expectedInputs: 1, status: "PASS" });
  });
});
