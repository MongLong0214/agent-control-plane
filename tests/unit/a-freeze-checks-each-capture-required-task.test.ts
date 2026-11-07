import { afterAll, describe, expect, it } from "vitest";

import { sha256 } from "../../src/core/digest.ts";
import { ReasonCode } from "../../src/core/reason-codes.ts";
import { ExecutionMode, TaskState } from "../../src/domain/types.ts";
import { supersessionBinding } from "../../src/run/candidate-integration.ts";
import type { TaskContract } from "../../src/run/run-engine.ts";
import { TASK_CORRECTION_REGISTERED } from "../../src/run/task-graph.ts";
import { WorkerTurnEvent, workerSuccessDigest, type WorkerSuccessDigestInputs } from "../../src/run/worker-turn.ts";
import { passingCommitLore } from "../helpers/commitlore-attempt.ts";
import { cleanupTempDirs, commitAll, gitSync, writeFiles } from "../helpers/fixtures.ts";
import { bindCeo, bindWorker, makeHarness, registerFixtureProject } from "../helpers/harness.ts";

/**
 * GAP 1 — at freeze, every task of the run whose registered spec requires a CommitLore capture
 * (`spec.commitlore = { capture: "required" }`) accounts for it with its own SUCCEEDED receipt: the receipt the
 * freeze reads the task's commit from carries CommitLore evidence of a known outcome, naming exactly the
 * `Record-Id` trailers that commit carries (none for `empty`). Whatever the run's own CommitLore mode, anything
 * else refuses the freeze before anything is built or written:
 *
 * - no CommitLore evidence on the receipt, or evidence of another commit;
 * - no receipt at all: a FAILED task, a CANCELLED one, one never run.
 *
 * Only a registered correction's supersession (#1372) exempts a task. Receipts are seeded the way #1268 slice 1's
 * freeze witness seeds them (`startExecution`, `finishExecution`, the SUCCEEDED row).
 */

afterAll(cleanupTempDirs);

const CONTRACT: TaskContract = {
  goal: "update the project",
  why: "changes in one run",
  scope: ["README.md", "src/app.js", "notes.md"],
  nonGoals: [],
  acceptance: ["the files change"],
  priority: "NORMAL",
  humanGate: [],
  references: [],
};

interface Lore {
  outcome: string;
  recordIds: string[];
  nonce: string | null;
}
const EMPTY: Lore = { outcome: "empty", recordIds: [], nonce: null };
const recorded = (...recordIds: string[]): Lore => ({ outcome: "recorded", recordIds, nonce: "capture-nonce" });
const CAPTURE = { commitlore: { capture: "required" } };

type World = Awaited<ReturnType<typeof worldOf>>;

/** A dispatched run of a project whose CommitLore mode is `mode`. */
const worldOf = async (mode: "required" | "preferred" | "off") => {
  const harness = makeHarness();
  const projectId = `gap1-freeze-${mode}`;
  const { repositoryId, identity } = await registerFixtureProject(harness, projectId, { commitlore: { mode } });
  bindCeo(harness);
  const created = harness.cp.runs.create({
    projectId,
    executionMode: ExecutionMode.STANDARD,
    contract: CONTRACT,
    repositories: [{ repositoryId, repositoryRole: "primary", baseBranch: "dev" }],
  });
  if (!created.allowed) throw new Error(created.message);
  const dispatched = await harness.cp.runs.dispatch(created.value.runId);
  if (!dispatched.allowed) throw new Error(`${dispatched.reasonCode}: ${dispatched.message}`);
  // A required run's integration merges get CommitLore's message check; this double passes every one.
  harness.cp.pipeline.attach({ commitlore: passingCommitLore() });
  return { harness, run: dispatched.value, repositoryId, identity, repo: harness.repoPath, base: gitSync(harness.repoPath, ["rev-parse", "dev"]) };
};

/** A task of the run, registered with `spec`. */
const registerTask = (world: World, key: string, spec: Record<string, unknown> = {}): string => {
  const submitted = world.harness.cp.tasks.submit(world.run.runId, [{ key, title: `update ${key}`, category: "implementation", spec }]);
  if (!submitted.allowed) throw new Error(`${submitted.reasonCode}: ${submitted.message}`);
  return submitted.value[0]!.taskId;
};

const openExecution = (world: World, taskId: string) => {
  const workerSessionId = bindWorker(world.harness, taskId);
  const opened = world.harness.cp.tasks.startExecution({
    runId: world.run.runId,
    taskId,
    ownerBindingGeneration: world.run.ownerBindingGeneration!,
    workerSessionId,
    provider: "scripted",
    model: "scripted-worker",
    repositoryId: world.repositoryId,
  });
  if (!opened.allowed) throw new Error(`${opened.reasonCode}: ${opened.message}`);
  return { workerSessionId, executionId: opened.value.executionId };
};

/**
 * One SUCCEEDED turn of `taskId`: its branch at the pinned base and its write target recorded, the commit of `files`
 * with `message`, and the receipt that names it, carrying `commitlore` unless it is null.
 */
const workerCommit = (world: World, taskId: string, files: Record<string, string>, message: string, commitlore: unknown): string => {
  const { harness } = world;
  const branch = `task/${taskId}`;
  gitSync(world.repo, ["checkout", "-q", "-B", branch, world.base]);
  const writeTarget = { repositoryIdentity: world.identity, branch, paths: Object.keys(files), declaredParent: "dev", baseSha: world.base };
  harness.cp.audit.record({ kind: "TASK_WRITE_TARGET_RECORDED", runId: world.run.runId, evidence: { taskId, writeTarget } });
  const { workerSessionId, executionId } = openExecution(world, taskId);
  writeFiles(world.repo, files);
  const commit = commitAll(world.repo, message);
  const inputs: WorkerSuccessDigestInputs = {
    executionId,
    workerSessionId,
    sessionIncarnation: harness.cp.sessions.get(workerSessionId)!.incarnation,
    providerSessionId: "scripted-session",
    exitCode: 0,
    stdoutSha256: sha256(""),
    commitHead: commit,
    diffDigest: "sha256:stand-in-diff",
  };
  const resultDigest = workerSuccessDigest(inputs);
  const closed = harness.cp.tasks.finishExecution(executionId, { status: "SUCCEEDED", resultDigest }, world.run.runId);
  if (!closed.allowed) throw new Error(closed.message);
  harness.cp.audit.record({
    kind: WorkerTurnEvent.SUCCEEDED,
    runId: world.run.runId,
    sessionId: workerSessionId,
    evidence: { ...inputs, resultDigest, taskId, head: world.base, paths: Object.keys(files), ...(commitlore === null ? {} : { commitlore }) },
  });
  return commit;
};

const frozenRows = (world: World) => world.harness.cp.audit.byKind("CANDIDATE_FROZEN").filter((row) => row.runId === world.run.runId);
const currentCandidateOf = (world: World): string | null =>
  world.harness.cp.db.get<{ digest: string | null }>(`SELECT current_candidate_digest AS digest FROM runs WHERE run_id = ?`, [world.run.runId])?.digest ?? null;

/** The freeze is refused for exactly `tasks` (each with its refusal), and nothing is frozen. */
const expectCaptureRefused = async (world: World, tasks: Array<Record<string, unknown>>) => {
  const frozen = await world.harness.cp.pipeline.freeze(world.run.runId);
  expect(frozen, JSON.stringify(frozen)).toMatchObject({
    allowed: false,
    reasonCode: ReasonCode.VERIFICATION_GAP,
    evidence: { runId: world.run.runId, refusal: "TASK_CAPTURE_UNACCOUNTED", tasks: tasks.map((task) => expect.objectContaining(task)) },
  });
  expect((frozen.evidence as { tasks: unknown[] }).tasks).toHaveLength(tasks.length);
  expect(currentCandidateOf(world)).toBeNull();
  expect(frozenRows(world)).toEqual([]);
};

const freezeAllowed = async (world: World) => {
  const frozen = await world.harness.cp.pipeline.freeze(world.run.runId);
  if (!frozen.allowed) throw new Error(`${frozen.reasonCode}: ${frozen.message} ${JSON.stringify(frozen.evidence)}`);
  return frozen.value;
};

describe("GAP 1: the freeze checks each capture-required task's receipt, commit and record binding", () => {
  it.each([
    ["no CommitLore evidence", null, "COMMITLORE_EVIDENCE_MISSING"],
    ["evidence that says capture was not required", { outcome: "not_required", recordIds: [], nonce: null }, "COMMITLORE_OUTCOME_UNKNOWN"],
  ])("an optional run: a capture-required task whose receipt carries %s refuses the freeze", async (_name, commitlore, refusal) => {
    const world = await worldOf("preferred");
    const taskId = registerTask(world, "readme", CAPTURE);
    const commit = workerCommit(world, taskId, { "README.md": "# one\n" }, "update readme", commitlore);
    await expectCaptureRefused(world, [{ taskId, state: TaskState.SUCCEEDED, refusal, commit }]);
  });

  it("an optional run: a receipt whose record binding is another commit's refuses the freeze", async () => {
    const world = await worldOf("preferred");
    const other = registerTask(world, "readme");
    workerCommit(world, other, { "README.md": "# one\n" }, "update readme\n\nRecord-Id: r-aaaaaaaaaaaa", recorded("r-aaaaaaaaaaaa"));
    const taskId = registerTask(world, "app", CAPTURE);
    const commit = workerCommit(world, taskId, { "src/app.js": "module.exports = () => 2;\n" }, "update app", recorded("r-aaaaaaaaaaaa"));
    await expectCaptureRefused(world, [{ taskId, refusal: "RECORD_IDS_MISMATCH", commit }]);
  });

  it.each([
    ["a recorded capture whose Record-Id the commit carries", "update readme\n\nWarn: readers see one\nRecord-Id: r-0123456789ab", recorded("r-0123456789ab")],
    ["an empty consideration on a commit with no Record-Id", "update readme", EMPTY],
  ])("an optional run: %s is frozen, beside a task with no setting and no evidence", async (_name, message, commitlore) => {
    const world = await worldOf("preferred");
    const taskId = registerTask(world, "readme", CAPTURE);
    const commit = workerCommit(world, taskId, { "README.md": "# one\n" }, message, commitlore);
    const plain = registerTask(world, "app");
    const plainCommit = workerCommit(world, plain, { "src/app.js": "module.exports = () => 2;\n" }, "update app", null);
    const value = await freezeAllowed(world);
    const candidate = value.repositories[0]!.candidateHead;
    // `merge-base --is-ancestor` exits non-zero, and gitSync throws, for a commit the candidate does not hold.
    for (const held of [commit, plainCommit]) expect(() => gitSync(world.repo, ["merge-base", "--is-ancestor", held, candidate])).not.toThrow();
  });

  it.each([["a run with CommitLore off", "off"], ["a run that requires CommitLore", "required"]] as const)(
    "%s: a capture-required task with no CommitLore evidence refuses the freeze",
    async (_name, mode) => {
      const world = await worldOf(mode);
      const taskId = registerTask(world, "readme", CAPTURE);
      const commit = workerCommit(world, taskId, { "README.md": "# one\n" }, "update readme", null);
      await expectCaptureRefused(world, [{ taskId, refusal: "COMMITLORE_EVIDENCE_MISSING", commit }]);
    },
  );

  it("a required run: a task whose stored setting is weaker still has its commit checked, and the freeze is refused", async () => {
    const world = await worldOf("required");
    const taskId = registerTask(world, "readme");
    world.harness.cp.db.run(`UPDATE tasks SET spec_json = ? WHERE task_id = ?`, [JSON.stringify({ commitlore: { capture: "off" } }), taskId]);
    workerCommit(world, taskId, { "README.md": "# one\n" }, "update readme", null);
    const frozen = await world.harness.cp.pipeline.freeze(world.run.runId);
    expect(frozen.allowed).toBe(false);
    expect(currentCandidateOf(world)).toBeNull();
    expect(frozenRows(world)).toEqual([]);
  });
});

describe("GAP 1: only a registered correction's supersession exempts a capture-required task", () => {
  it.each([
    ["FAILED", TaskState.FAILED],
    ["CANCELLED by a re-plan", TaskState.CANCELLED],
    ["never run", TaskState.READY],
  ])("a capture-required task %s, with no receipt, refuses the freeze", async (_name, state) => {
    const world = await worldOf("preferred");
    const plain = registerTask(world, "app");
    workerCommit(world, plain, { "src/app.js": "module.exports = () => 2;\n" }, "update app", null);
    const taskId = registerTask(world, "readme", CAPTURE);
    if (state === TaskState.FAILED) {
      const { executionId } = openExecution(world, taskId);
      const closed = world.harness.cp.tasks.finishExecution(executionId, { status: "FAILED", failureClass: "contract" }, world.run.runId);
      if (!closed.allowed) throw new Error(closed.message);
    } else if (state === TaskState.CANCELLED) {
      const replanned = world.harness.cp.tasks.submit(world.run.runId, [{ key: "readme-2", title: "update readme again", category: "implementation" }], {
        planDigest: "sha256:replan",
        taskIds: [taskId],
      });
      if (!replanned.allowed) throw new Error(`${replanned.reasonCode}: ${replanned.message}`);
    }
    expect(world.harness.cp.tasks.get(taskId)!.state).toBe(state);
    await expectCaptureRefused(world, [{ taskId, state, refusal: "CAPTURE_RECEIPT_MISSING" }]);
  });

  /**
   * The relation is recorded as `task_correction_register` records it (`TASK_CORRECTION_REGISTERED`, bound to both
   * receipts by `supersessionBinding`), which is what the freeze reads (`supersessionOf`); its registration checks
   * are #1372's own witness.
   */
  const supersede = (world: World, original: string, correction: string): void => {
    const binding = supersessionBinding(world.harness.cp.db, world.run.runId, original, correction);
    if (!binding.allowed) throw new Error(binding.message);
    world.harness.cp.audit.record({
      kind: TASK_CORRECTION_REGISTERED,
      runId: world.run.runId,
      evidence: { originalTaskId: original, correctionTaskId: correction, supersedes: binding.value },
    });
  };

  it("a superseded capture-required task with no CommitLore evidence is exempt; its correction is checked and frozen", async () => {
    const world = await worldOf("preferred");
    const original = registerTask(world, "readme", CAPTURE);
    workerCommit(world, original, { "README.md": "# one\n" }, "update readme", null);
    const correction = registerTask(world, "readme-fix", { ...CAPTURE, correctionOf: { taskId: original, failure: "it lost the record", fix: "commit it through CommitLore" } });
    const fixed = workerCommit(world, correction, { "README.md": "# two\n" }, "update readme again\n\nRecord-Id: r-bbbbbbbbbbbb", recorded("r-bbbbbbbbbbbb"));
    supersede(world, original, correction);
    const value = await freezeAllowed(world);
    expect(value.repositories[0]!.candidateHead).toBe(fixed);
  });

  it("the correction is not exempt: a superseding task without evidence still refuses the freeze", async () => {
    const world = await worldOf("preferred");
    const original = registerTask(world, "readme", CAPTURE);
    workerCommit(world, original, { "README.md": "# one\n" }, "update readme", EMPTY);
    const correction = registerTask(world, "readme-fix", { ...CAPTURE, correctionOf: { taskId: original, failure: "wrong text", fix: "fix the text" } });
    const fixed = workerCommit(world, correction, { "README.md": "# two\n" }, "update readme again", null);
    supersede(world, original, correction);
    await expectCaptureRefused(world, [{ taskId: correction, refusal: "COMMITLORE_EVIDENCE_MISSING", commit: fixed }]);
  });

  it("control: without the registered relation the original is a task result, and its missing evidence refuses the freeze", async () => {
    const world = await worldOf("preferred");
    const original = registerTask(world, "readme", CAPTURE);
    const commit = workerCommit(world, original, { "README.md": "# one\n" }, "update readme", null);
    const correction = registerTask(world, "app", CAPTURE);
    workerCommit(world, correction, { "src/app.js": "module.exports = () => 2;\n" }, "update app\n\nRecord-Id: r-bbbbbbbbbbbb", recorded("r-bbbbbbbbbbbb"));
    await expectCaptureRefused(world, [{ taskId: original, refusal: "COMMITLORE_EVIDENCE_MISSING", commit }]);
  });
});
